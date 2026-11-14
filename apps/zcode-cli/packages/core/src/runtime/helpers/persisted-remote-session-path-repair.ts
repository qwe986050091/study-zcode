import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  type RepairRemoteSessionPathsInput,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

/**
 * 远端会话路径污染的统一错误 reason。
 *
 * 所有由此修复流程抛出的 SessionCorrupted 都会带上该 reason，便于跨进程/日志检索，
 * 也便于调用方区分"路径污染"与其它会话损坏。仅为错误上下文常量，不参与业务判断。
 */
export const REMOTE_SESSION_PATH_CORRUPTION_REASON = "remote_session_workspace_path_corrupted";

/**
 * 单个路径字段的裁决结果。
 *
 * - clean：等于真实 workspacePath，无需修复；
 * - repair：命中两种已知污染形态（等于 workspaceIdentity，或 workspacePath/identity），
 *   可以确定性修复；
 * - unrelated：不含 identity 且不是已知污染，原样保留（可能是用户自定义目录）；
 * - unsafe：含 identity 但前缀不匹配，无法证明是污染还是合法路径，拒绝猜测。
 */
type PathFieldResolution = "clean" | "repair" | "unrelated" | "unsafe";

/**
 * 修复流程所需的 store 能力子集。
 *
 * 只依赖 getSession 与可选的窄修复方法（CAS），刻意不依赖全量 update：
 * 避免一次路径修复顺带覆盖并发写入的其它 session 字段。
 */
type RemoteSessionPathRepairStore = Pick<SessionStorePort, "getSession"> & {
  repairRemoteSessionPaths?: (input: RepairRemoteSessionPathsInput) => Promise<boolean>;
};

/**
 * 计算"旧版污染"的具体形态：workspacePath + "/" + workspaceIdentity。
 *
 * 根路径 "/" 必须特判，否则会拼出 "//identity"；其余按正常路径拼接。
 * 这是修复时要匹配的第二种污染，不产生任何 IO。纯函数。
 */
function buildKnownPollutedPath(workspacePath: string, workspaceIdentity: string): string {
  return workspacePath === "/" ? `/${workspaceIdentity}` : `${workspacePath}/${workspaceIdentity}`;
}

/**
 * 裁决单个持久化路径字段，返回四种状态之一。
 *
 * 判定顺序（先精确、再包含、最后放弃）：
 * 1. 等于 workspacePath → clean；
 * 2. 等于 identity 或 buildKnownPollutedPath(...) → repair（两种可证明的污染）；
 * 3. 包含 identity 但不等 → unsafe（前缀不匹配，拒绝猜测）；
 * 4. 其余 → unrelated（原样保留）。
 * 输出不修改任何字段；unsafe 由调用方升级为 SessionCorrupted。纯函数。
 */
function resolvePathField(
  value: string,
  workspacePath: string,
  workspaceIdentity: string,
): PathFieldResolution {
  if (value === workspacePath) return "clean";
  if (
    value === workspaceIdentity ||
    value === buildKnownPollutedPath(workspacePath, workspaceIdentity)
  ) {
    return "repair";
  }
  return value.includes(workspaceIdentity) ? "unsafe" : "unrelated";
}

/**
 * 旧版把 workspaceIdentity 当成 cwd，或追加到真实 workspacePath 后落库。
 * 这里只修复两种已知且可证明的污染形态；包含 identity 但前缀不匹配的数据拒绝猜测。
 *
 * 输入：sessionStore 需支持 getSession 与可选窄修复；session 是刚读出的会话事实；
 * options.onPersistenceFailure 用于上报"持久化没成功但本次仍可继续"的情况。
 *
 * 处理流程：
 * 1. identity 为空 → 与远端无关，原样返回；
 * 2. identity 不是 remote: 前缀 → 本地会话，原样返回；是 remote: 但解析失败 →
 *    SessionCorrupted（不能静默当本地处理）；
 * 3. 计算 directory/path 两个字段的裁决；任一 unsafe → SessionCorrupted；都不需要
 *    修复 → 原样返回；
 * 4. 先构造内存修复结果，再以旧值为 expected 发起 CAS 持久化；store 不支持窄修复
 *    或写盘异常 → 上报 onPersistenceFailure 并返回内存修复（下次冷读会重试）；
 * 5. CAS 成功 → 返回刷新后的会话；CAS 未命中 → 重新 getSession 基于新事实裁决：
 *    会话消失/identity 被改/新值 unsafe → SessionCorrupted；新值仍需修复 →
 *    上报失败并返回基于最新元数据的确定性内存修复，不覆盖并发事实；新值已干净 →
 *    返回刷新结果。
 *
 * 输出：修复后（或原地）的 SessionInfo；不修改入参对象。
 * 不变量：只有两种可证明污染才会写盘；CAS expected 恒为读到的旧值；本地会话绝不改写。
 * 失败语义：可安全判定为损坏的抛 SessionCorrupted（recoverable=true）；临时持久化
 * 失败只回调不上抛，保证恢复流程不被存储抖动阻断。
 */
export async function repairPersistedRemoteSessionPaths(
  sessionStore: RemoteSessionPathRepairStore,
  session: SessionInfo,
  options?: { onPersistenceFailure?: (error: unknown) => void },
): Promise<SessionInfo> {
  const workspaceIdentity = session.workspaceID?.trim();
  if (!workspaceIdentity) return session;
  const remoteWorkspace = parseRemoteWorkspaceIdentity(workspaceIdentity);
  if (!remoteWorkspace) {
    if (!workspaceIdentity.startsWith("remote:")) return session;
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Persisted remote session workspace identity is invalid",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }

  const directoryResolution = resolvePathField(
    session.directory,
    remoteWorkspace.workspacePath,
    workspaceIdentity,
  );
  const pathResolution =
    session.path === undefined
      ? "clean"
      : resolvePathField(session.path, remoteWorkspace.workspacePath, workspaceIdentity);

  if (directoryResolution === "unsafe" || pathResolution === "unsafe") {
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Remote session workspace path is corrupted and cannot be repaired safely",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (directoryResolution !== "repair" && pathResolution !== "repair") return session;

  const repairedSession: SessionInfo = {
    ...session,
    ...(directoryResolution === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
    ...(pathResolution === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
  };
  const repairInput: RepairRemoteSessionPathsInput = {
    sessionID: session.id,
    workspaceID: workspaceIdentity as RepairRemoteSessionPathsInput["workspaceID"],
    expectedDirectory: session.directory,
    expectedPath: session.path ?? null,
    directory: repairedSession.directory,
    path: repairedSession.path ?? null,
    timeUpdated: session.time.updated,
  };
  if (!sessionStore.repairRemoteSessionPaths) {
    const error = new Error("Session store does not support narrow remote path repair");
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
  try {
    const persisted = await sessionStore.repairRemoteSessionPaths(repairInput);
    const refreshed = await sessionStore.getSession(session.id);
    if (persisted) return refreshed ?? repairedSession;
    if (!refreshed) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session disappeared during path repair",
        {
          context: {
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: session.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }

    // CAS 未命中说明路径或 identity 已被并发写入；必须基于新事实重新裁决，不能返回旧快照。
    const refreshedIdentity = refreshed.workspaceID?.trim();
    if (refreshedIdentity !== workspaceIdentity) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace identity changed during path repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity: refreshedIdentity,
          },
          recoverable: true,
        },
      );
    }
    const refreshedDirectory = resolvePathField(
      refreshed.directory,
      remoteWorkspace.workspacePath,
      workspaceIdentity,
    );
    const refreshedPath =
      refreshed.path === undefined
        ? "clean"
        : resolvePathField(refreshed.path, remoteWorkspace.workspacePath, workspaceIdentity);
    if (refreshedDirectory === "unsafe" || refreshedPath === "unsafe") {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace path changed to an unsafe value during repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }
    if (refreshedDirectory !== "repair" && refreshedPath !== "repair") return refreshed;

    // adapter 拒绝 CAS 且持久值仍是同一已知污染形态时，只使用基于最新元数据构造的
    // 确定性内存修复；下次冷读会重试，不覆盖任何并发 session 事实。
    options?.onPersistenceFailure?.(new Error("Remote session path repair CAS did not match"));
    return {
      ...refreshed,
      ...(refreshedDirectory === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
      ...(refreshedPath === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
    };
  } catch (error) {
    if (isCoreError(error) && error.type === CoreErrorType.SessionCorrupted) {
      throw error;
    }
    // 路径已可确定时，暂时性写盘失败不应继续阻断本次恢复；下次读取仍会重试。
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
}
