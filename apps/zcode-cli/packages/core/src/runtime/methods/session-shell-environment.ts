// ============================================================
// runtime/methods/session-shell-environment.ts —— session 级 Bash shell 的选择与生效
// ============================================================
// 定位：链路 5 的入口层：把"本次会话用哪个 shell"收敛成 runtime.config.bashShellSelection，
//   并负责冷恢复的"快照优先"、shell 变化提醒与上下文前缀刷新。
// 输入：SessionShellEnvironmentCandidate（值或 lazy resolver）+ BashShellSnapshotRestore；
// 输出：runtime 内存态（config / envInfo / contextSourceSnapshot / 内置工具面）+ 可选 resume notice。
// 关键不变量：session-start 快照只初始化一次；resume 必须用快照覆盖当前配置而不是反过来；
//   shell 变化只对新 session 生效，已落库会话不得回改（链路 5）。
// ============================================================
import { countContextPrefixMessages } from "../deps.js";
import type { EnvInfo, ExecutionShellSelection, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  persistBashShellSelectionSnapshot,
  readPersistedBashShellSelectionSnapshot,
  resolveBashShellSnapshotForResume,
  type BashShellSnapshotRestore,
} from "./bash-shell-snapshot.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "./shell-environment.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

type SessionShellConfig = Pick<AgentRuntimeConfig, "bashShellSelection">;

export type SessionShellEnvironmentCandidate =
  | ExecutionShellSelection
  | (() => ExecutionShellSelection);

export interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellSelectionFromConfig(
  config: SessionShellConfig,
): ExecutionShellSelection | undefined {
  return config.bashShellSelection;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = getSessionShellSelectionFromConfig(runtime.config);
  // 无选择 = 尚未确定 shell（延迟初始化/未探测），调用方必须按"无 shell 环境"降级。
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: SessionShellEnvironmentCandidate,
): boolean {
  // 已初始化过就返回 false：快照代表 session-start 的第一次决定，后续入口不得覆盖。
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }

  // Bash shell 是 session-start 快照。所有入口都只表达“当前候选值”，
  // runtime 统一负责首次真实用户执行前初始化一次。candidate 可以是 lazy resolver，
  // 这样已有 snapshot 的 session 不会在外层重复探测 shell。
  applySessionShellEnvironment(runtime, resolveSessionShellCandidate(candidate), {
    refreshPreConversationContext: true,
  });
  return true;
}

export function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options: { refreshPreConversationContext?: boolean } = {},
): void {
  // 写入 config 是唯一事实源；随后刷新工具面与上下文前缀，保证"执行用哪个 shell"与"模型看到哪个 shell"一致。
  runtime.config.bashShellSelection = selection;
  refreshBranchAwareBuiltInTools(runtime);

  // resume 路径显式传 false：那时上下文前缀由 resume 装配流程统一重建，避免重复刷新。
  if (options.refreshPreConversationContext !== false) {
    refreshPreConversationShellContext(runtime, selection);
  }
}

function resolveSessionShellCandidate(
  candidate: SessionShellEnvironmentCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}

export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T,
  selection: ExecutionShellSelection | undefined,
): T;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  // 任一缺失就原样返回：envInfo 是可选投影，不能用空值抹掉已有的 shell 描述。
  if (!envInfo || !selection?.display.name) {
    return envInfo;
  }
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

export async function persistSessionShellEnvironmentSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  // 转发给快照 writer；失败只告警（writer 内部处理），不能让会话因写快照失败而中断。
  await persistBashShellSelectionSnapshot({
    logger: runtime.logger,
    selection: getSessionShellSelection(runtime),
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    traceContext,
  });
}

export async function restoreSessionShellEnvironmentSelectionForResume(
  runtime: AgentRuntimeInternal,
  options: {
    currentSelection: ExecutionShellSelection | undefined;
    traceContext: TraceContext;
  },
): Promise<BashShellSnapshotRestore> {
  const restore = resolveBashShellSnapshotForResume({
    currentSelection: options.currentSelection,
    logger: runtime.logger,
    restore: await readPersistedBashShellSelectionSnapshot({
      logger: runtime.logger,
      sessionId: runtime.sessionId,
      sessionStore: runtime.sessionStore,
      traceContext: options.traceContext,
    }),
    traceContext: options.traceContext,
  });

  // 只有能拿到可用选择（restored/fallback）时才覆盖内存态；stale/invalid/missing 保持当前配置。
  if (restore.status === "restored" || restore.status === "fallback") {
    applySessionShellEnvironment(runtime, restore.selection, {
      refreshPreConversationContext: false,
    });
  }

  return restore;
}

export function announceSessionShellEnvironmentNoticeAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
    restore: BashShellSnapshotRestore;
  },
): void {
  const selection = getSessionShellSelection(runtime);
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: options.persistedEnvInfo?.shell,
    restoreStatus: options.restore.status,
    selection,
  });
  // 没有选择、或判断不出"是否变更"时不提醒：避免 resume 每轮都插一条无意义附件。
  if (!selection || !noticeKind) {
    return;
  }

  const notice = buildShellEnvironmentResumeNotice(noticeKind, selection);
  // 已存在同内容提醒就跳过，防止多次 resume/重连在同一上下文里重复注入。
  if (hasShellEnvironmentChangeAttachment(runtime, notice)) {
    return;
  }

  // 旧 Windows 会话没有可用 shell snapshot 时，升级后可能由 auto Git Bash
  // 接管 Bash 执行。历史上下文仍可能让模型继续沿用旧 shell 习惯，因此必须在
  // resume 后补一个 provider-visible shell 提醒；可用 snapshot 恢复时不插，避免
  // 破坏“shell 设置变更只对新 session 生效”的契约。
  // attachment 是 provider 可见但不进入聊天 transcript 的注入点，适合这种一次性环境说明。
  runtime.messageHistory.addAttachment("shell_environment_change", notice);
}

function hasShellEnvironmentChangeAttachment(
  runtime: AgentRuntimeInternal,
  content: string,
): boolean {
  // 按 source + content 精确去重：同内容只插一次；文案变化会被视为新提醒，所以文案要保持稳定。
  return runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .some(
      (entry) =>
        entry.kind === "attachment" &&
        entry.metadata?.source === "shell_environment_change" &&
        entry.content === content,
    );
}

function refreshPreConversationShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  // 只允许"尚未落库、上下文仍全是前缀"的会话刷新：已持久化会话的 shell 不能回改。
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot ||
    runtime.sessionPersisted
  ) {
    return;
  }
  const activeEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  // 一旦出现真实对话消息就放弃：重写前缀会改变已经发给模型的历史语义。
  if (activeEntries.length !== countContextPrefixMessages(activeEntries)) {
    return;
  }

  // deferred draft 是隐藏预热态，首发前刷新 shell 时还没有真实
  // conversation message。此时应把 session-start # Environment 一并刷新，
  // 避免模型看到的 Shell 和 Bash 实际执行 shell 不一致。
  // 两份 envInfo 都要改：config 服务运行时，contextSourceSnapshot 服务上下文重建。
  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection),
  };
  // 最后重建前缀：让 # Environment 里的 Shell 与 Bash 真正执行的 shell 一致。
  rebuildContextPrefix(runtime);
}
