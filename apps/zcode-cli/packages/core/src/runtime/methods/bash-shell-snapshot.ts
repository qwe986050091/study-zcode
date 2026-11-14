// ============================================================
// runtime/methods/bash-shell-snapshot.ts —— Bash shell 选择的 session-start 快照读写
// ============================================================
// 定位：链路 5（持久化与冷恢复）里 "shell 设置变更只对新 session 生效" 的实现点。
// 输入：ExecutionShellSelection + SessionStorePort；
// 输出：BashShellSnapshotRestore（restored / fallback / stale / missing / invalid / read_failed）。
// 关键不变量：快照落库后冷恢复必须优先读快照，不能重读最新 settings（否则用户改配置会
//   回改进行中的会话）；快照路径已不可执行时必须降级并结构化上报，不能静默沿用坏值。
//   快照持久化/读取失败只告警，不阻塞会话启动（链路 5）。
// ============================================================
import { accessSync, constants as fsConstants } from "node:fs";
import {
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  traceContextToLogContext,
} from "../deps.js";
import type {
  ExecutionShellSelection,
  Logger,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "../deps.js";

const BASH_SHELL_SELECTION_ENTRY_ID_SUFFIX = "runtime:bash_shell_selection";

export type BashShellSnapshotRestore =
  | { status: "restored"; selection: ExecutionShellSelection }
  | {
      status: "fallback";
      reason: "stale_snapshot";
      selection: ExecutionShellSelection;
      staleSelection: ExecutionShellSelection;
    }
  | { status: "stale"; staleSelection: ExecutionShellSelection }
  | { status: "missing" | "invalid" | "read_failed" };

export async function persistBashShellSelectionSnapshot(options: {
  logger?: Logger;
  selection: ExecutionShellSelection | undefined;
  sessionId: SessionId;
  sessionStore: SessionStorePort | undefined;
  traceContext: TraceContext;
}): Promise<void> {
  // 没有选择或没有 session entry 写入能力时直接跳过：快照是恢复增强，不是启动前置条件。
  if (!options.selection || !options.sessionStore?.saveSessionEntry) {
    return;
  }

  try {
    const timestamp = Date.now();
    // 固定 session entry id：同一会话重复写入即覆盖，冷恢复只需取最后一条。
    await options.sessionStore.saveSessionEntry({
      id: `${options.sessionId}:${BASH_SHELL_SELECTION_ENTRY_ID_SUFFIX}`,
      sessionID: options.sessionId,
      type: SESSION_ENTRY_BASH_SHELL_SELECTION,
      time: {
        created: timestamp,
        updated: timestamp,
      },
      // Bash shell 设置变更只影响新 session；必须把创建时快照落库，
      // 冷恢复时才能继续使用同一个 shell 执行，而不是重新读取最新 settings。
      data: serializeBashShellSelection(options.selection),
    });
  } catch (error) {
    // 落库失败只告警：下次启动会退回到配置/自动探测，不能让快照写失败挡住会话创建。
    options.logger?.warn("Failed to persist Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.bash_shell_selection.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function readPersistedBashShellSelectionSnapshot(options: {
  logger?: Logger;
  sessionId: SessionId;
  sessionStore: SessionStorePort | undefined;
  traceContext: TraceContext;
}): Promise<BashShellSnapshotRestore> {
  // 读能力缺席按 missing 处理：上层据此走"无快照"的 fallback，而不是把异常当损坏。
  if (!options.sessionStore?.sessionEntries) {
    return { status: "missing" };
  }

  try {
    const entries = await options.sessionStore.sessionEntries({
      sessionID: options.sessionId,
      type: SESSION_ENTRY_BASH_SHELL_SELECTION,
    });
    const latestEntry = entries.at(-1);
    // 没有快照 = 新会话或旧会话未落库；这与"数据损坏"必须区分，不能混成 invalid。
    if (!latestEntry) {
      return { status: "missing" };
    }
    const selection = parsePersistedBashShellSelection(latestEntry?.data);
    // 只有形状校验通过才恢复；否则宁可报 invalid 让上层保留当前选择。
    if (selection) {
      return { selection, status: "restored" };
    }
    options.logger?.warn("Ignored invalid persisted Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      event: "session_entry.bash_shell_selection.invalid",
      module: "core.runtime",
    });
    return { status: "invalid" };
  } catch (error) {
    // 存储异常（IO/DB）与数据损坏分开返回：前者可重试，后者只能丢弃快照。
    options.logger?.warn("Failed to read persisted Bash shell selection snapshot", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.bash_shell_selection.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return { status: "read_failed" };
  }
}

export function resolveBashShellSnapshotForResume(options: {
  currentSelection: ExecutionShellSelection | undefined;
  logger?: Logger;
  restore: BashShellSnapshotRestore;
  traceContext: TraceContext;
}): BashShellSnapshotRestore {
  const { currentSelection, logger, restore, traceContext } = options;
  // 只有 restored 才需要再验可用性；其它状态原样透传（missing/invalid 不能当成"可用"）。
  if (restore.status !== "restored" || isPersistedBashShellSelectionUsable(restore.selection)) {
    return restore;
  }

  logger?.warn("Ignored stale persisted Bash shell selection snapshot", {
    ...traceContextToLogContext(traceContext),
    event: "session_entry.bash_shell_selection.stale",
    module: "core.runtime",
    persistedShellName: restore.selection.display.name,
    persistedShellPath: restore.selection.path,
  });

  // 有当前探测结果就 fallback：保留坏快照作为 staleSelection，供上层提示"shell 已变更"。
  if (currentSelection) {
    return {
      reason: "stale_snapshot",
      selection: currentSelection,
      staleSelection: restore.selection,
      status: "fallback",
    };
  }
  // 连当前选择都没有：只能报 stale，由调用方决定是否放弃 shell 选择而不是猜测。
  return { staleSelection: restore.selection, status: "stale" };
}

function serializeBashShellSelection(selection: ExecutionShellSelection): ExecutionShellSelection {
  // 落库前浅拷贝（含 display 嵌套），避免调用方之后再改同一对象导致快照内容漂移。
  return { ...selection, display: { ...selection.display } };
}

function parsePersistedBashShellSelection(value: unknown): ExecutionShellSelection | undefined {
  // 数据来自旧版本/手工改动，必须逐层形状校验；Array 也是 object，要显式排除。
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const display = record.display;
  // display.name 是 prompt 中展示 shell 的唯一来源，缺失则整条快照不可用。
  if (!display || typeof display !== "object" || Array.isArray(display)) {
    return undefined;
  }
  const displayName = (display as Record<string, unknown>).name;
  const dialect = record.dialect;
  const source = record.source;
  // dialect/source 是封闭枚举；未知值说明不是本版本写入的，拒绝而不是猜测执行方言。
  if (
    typeof displayName !== "string" ||
    !isExecutionShellDialect(dialect) ||
    !isExecutionShellSource(source)
  ) {
    return undefined;
  }

  const selection: ExecutionShellSelection = {
    dialect,
    display: { name: displayName },
    source,
  };
  // 可选字段只接受 string：类型不符就丢弃，不让脏值进入执行路径。
  if (typeof record.id === "string") {
    selection.id = record.id;
  }
  if (typeof record.label === "string") {
    selection.label = record.label;
  }
  if (typeof record.path === "string") {
    selection.path = record.path;
  }
  return selection;
}

function isPersistedBashShellSelectionUsable(selection: ExecutionShellSelection): boolean {
  // legacy-shell 代表旧版默认 shell，本来就可能没有真实路径；有路径才需要验。
  if (selection.dialect === "legacy-shell") {
    return selection.path === undefined || selection.path.trim().length === 0;
  }

  // 非 legacy 却缺少 path：无法证明还能执行，按 stale 处理。
  if (!selection.path) {
    return false;
  }

  // Windows 的裸 cmd.exe 依赖 PATH 解析，没有可 accessSync 的绝对路径（跨平台差异）。
  if (isWindowsCmdFallbackSelection(selection)) {
    return true;
  }

  try {
    // 其余方言要求快照路径仍存在且可执行；ENOENT/EACCES 都降级到 fallback。
    accessSync(selection.path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWindowsCmdFallbackSelection(selection: ExecutionShellSelection): boolean {
  const shellPath = selection.path;
  // 只认"不带任何分隔符的 cmd.exe"（即交给系统 PATH 的写法）；带路径的 cmd 仍走可执行性校验。
  return (
    selection.dialect === "cmd" &&
    shellPath !== undefined &&
    !shellPath.includes("\\") &&
    !shellPath.includes("/") &&
    shellPath.toLowerCase() === "cmd.exe"
  );
}

function isExecutionShellDialect(value: unknown): value is ExecutionShellSelection["dialect"] {
  // 封闭枚举：冷恢复只接受本版本认识的方言，避免把未知字符串带进执行分支。
  return value === "cmd" || value === "posix" || value === "git-bash" || value === "legacy-shell";
}

function isExecutionShellSource(value: unknown): value is ExecutionShellSelection["source"] {
  // source 决定后续提示语义（user-config vs auto-detected），未知值不能猜测。
  return value === "auto-detected" || value === "user-config" || value === "legacy-fallback";
}
