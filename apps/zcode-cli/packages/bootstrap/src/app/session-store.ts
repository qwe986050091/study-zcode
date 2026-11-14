import { isAbsolute, resolve } from "node:path";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  parseModelSelectionValue,
  type SessionId,
  type SessionStorePort,
  type CollaborationMode,
  type InputHistoryStorePort,
  type LocalSettingStorePort,
  type ProjectId,
} from "@zcode/contracts";
import type { ModelSelection } from "@zcode/provider";
import { isHighspeedProviderId } from "@zcode/shared";
import { StartupTimer } from "../startup-logging.js";

/**
 * 结构判定 store 是否带 `close()`（App 关闭时只释放自己拥有的 store）。
 * 用能力探测而非 instanceof，因为 SessionStore 是端口、测试与远端实现可替换。
 */
export function isClosableSessionStore(
  store: SessionStorePort,
): store is SessionStorePort & { close(): void } {
  return "close" in store && typeof store.close === "function";
}

/**
 * 从 SessionStore 窄化出输入历史端口（要求 record / recall 两个方法都在）。
 * 缺失即返回 undefined，调用方据此让历史功能整体缺席，而不是回退到内存表。
 */
export function asInputHistoryStore(store: SessionStorePort): InputHistoryStorePort | undefined {
  const candidate = store as Partial<InputHistoryStorePort>;
  return typeof candidate.recordInputHistory === "function" &&
    typeof candidate.recallPreviousInputHistory === "function"
    ? (store as SessionStorePort & InputHistoryStorePort)
    : undefined;
}

/**
 * 从 SessionStore 窄化出本地项目设置端口（读 / 写项目权限模式都在才算）。
 * 不完整实现不接一半——只挂一个方法会让读到的值与写回路径分成两份事实。
 */
export function asLocalSettingStore(store: SessionStorePort): LocalSettingStorePort | undefined {
  const candidate = store as Partial<LocalSettingStorePort>;
  return typeof candidate.getProjectPermissionMode === "function" &&
    typeof candidate.saveProjectPermissionMode === "function"
    ? (store as SessionStorePort & LocalSettingStorePort)
    : undefined;
}

/**
 * 读项目持久化的权限模式（新建会话时作为 mode 的兜底）。
 *
 * 输入 store 可为 undefined（无该能力）；`getProjectPermissionMode` 若返回 Promise 则**不等待**
 * 并回 undefined——调用点是同步装配链，不能在这里引入异步分支。返回 undefined 即“没有持久值”，
 * 由调用方继续回落到配置默认。
 */
export function readProjectPermissionMode(
  store: LocalSettingStorePort | undefined,
  projectID: ProjectId,
): CollaborationMode | undefined {
  if (!store) return undefined;
  const mode = store.getProjectPermissionMode(projectID);
  return isPromiseLike(mode) ? undefined : (mode ?? undefined);
}

/** 读取 Session 自己最近一次显式选择；恢复时它高于 Environment 默认值。 */
export async function readSessionModelSelection(
  store: Pick<SessionStorePort, "sessionEntries">,
  sessionID: SessionId,
): Promise<ModelSelection | undefined> {
  if (!store.sessionEntries) return undefined;
  const entries = await store.sessionEntries({
    sessionID,
    type: SESSION_ENTRY_MODEL_SELECTION,
  });
  const data = entries.at(-1)?.data;
  const complete = parseModelSelectionValue(data);
  if (complete) return residentModelSelection(complete);
  // reasoning 的错误类型不能抹掉可恢复的当前模型身份；这里只读取新字段，
  // 不借旧 thoughtLevel/消息/default 补值。执行前仍由 Registry 严格校验。
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const current = data as Record<string, unknown>;
    return residentModelSelection(
      parseModelSelectionValue({ providerId: current.providerId, modelId: current.modelId }),
    );
  }
  return undefined;
}

/**
 * 加速卡 Provider 是 `selectionScope=execution` 的单轮执行身份，永远不能当作会话常驻选型
 * （highspeed-card-spec §5.1）。旧版本分叉会把分叉点消息上的加速选型写进 child 的
 * model_selection entry，这类会话恢复后常驻在一个无凭据、且不在模型列表里的隐藏 Provider 上，
 * 还会经 restoredModelSelection 投影成界面选中态与 contextWindow。读取时直接丢弃，
 * 会话回到「未绑定」而不是借默认模型补齐（恢复语义见 runtime-config 的 initialModelSelection），
 * 由用户重新选一次模型，避免隐藏身份继续在存储与投影里传播。
 */
function residentModelSelection(selection: ModelSelection | undefined): ModelSelection | undefined {
  if (!selection) return undefined;
  return isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

/** 关闭 SQLite store。所有权在 App：只有 ownsSessionStore 时才调用，注入的 store 由注入方关闭。 */
export function closeSessionStore(store: SqliteSessionStore): void {
  store.close();
}

/**
 * 打开会话数据库（启动态）：先解析 dbPath，再委托 SqliteSessionStore.openStartup 做迁移。
 *
 * 迁移进度经 onProgress 逐条打到 startupTimer（stage=migrate_session_db），完成后再记一条
 * completed；计时器是旁路观测，不影响打开结果。
 * 失败语义：迁移失败（含 checksum mismatch / SQLITE_BUSY 超时）原样抛出，由 App 构造失败。
 */
export async function openStartupSessionStore(
  configResult: ConfigResult,
  startupTimer: StartupTimer,
): Promise<SqliteSessionStore> {
  const dbPath = getSessionDbPath(configResult);
  startupTimer.start("ZCode SQLite migration started", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.started",
    stage: "migrate_session_db",
  });
  const store = await SqliteSessionStore.openStartup(
    { dbPath },
    {
      onProgress: async (progress) => {
        startupTimer.mark("SQLite startup state", {
          event: "bootstrap.app.startup.storage_state",
          stage: "migrate_session_db",
          context: { ...progress },
        });
      },
    },
  );
  startupTimer.mark("ZCode SQLite migration completed", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.completed",
    stage: "migrate_session_db",
  });
  return store;
}

/**
 * 协议进程用的同库打开：与 App 路径共享 dbPath 与迁移，但不挂进度回调（协议入口不消费迁移进度）。
 * 用独立 stage / event 前缀，便于区分是哪个进程在升级同一个库。
 */
export async function openStartupZCodeProtocolSessionStore(
  configResult: ConfigResult,
  startupTimer: StartupTimer,
): Promise<SqliteSessionStore> {
  const dbPath = getSessionDbPath(configResult);
  startupTimer.start("ZCode Protocol SQLite migration started", {
    context: { dbPath },
    event: "zcode_protocol.startup.sqlite_migration.started",
    stage: "migrate_session_db",
  });
  const store = await SqliteSessionStore.openStartup({ dbPath });
  startupTimer.mark("ZCode Protocol SQLite migration completed", {
    context: { dbPath },
    event: "zcode_protocol.startup.sqlite_migration.completed",
    stage: "migrate_session_db",
  });
  return store;
}

/**
 * 解析会话 DB 的绝对路径：配置里的相对路径按业务 cwd 解析（存储 Worker 不能 chdir），
 * `~/` 与绝对路径交给 resolvePath 统一展开。`workingDirectory` 缺席时全部按 resolvePath。
 */
export function getSessionDbPath(configResult: ConfigResult, workingDirectory?: string): string {
  const configured = configResult.config.storage.sessionDbPath;
  // 存储 Worker 不能 chdir；显式传入业务实际 cwd，保持相对路径与普通 Agent 一致。
  if (workingDirectory && !isAbsolute(configured) && !configured.startsWith("~/"))
    return resolve(workingDirectory, configured);
  return resolvePath(configured);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
