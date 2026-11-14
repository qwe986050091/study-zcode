// Bot 侧远程工作区解析（R3 路由）。
//
// 职责：把 Bot 请求里的 workspaceIdentity（可能是 legacy identity）解析成可直接使用的
// RemoteTarget + 稳定 identity；Bot 与 Renderer 共用 SourceServerDirectory / Registry 的
// 事实，不允许旧回退快照决定路由。
// 输入输出：输入 workspace 参数、purpose（普通调用 / reconnect）与 directory/sessions 依赖；
// 解析失败一律返回 null（不抛错），由调用方决定是否回 ack 错误。
// 副作用：只读——调用 directory.snapshot()、listSessions()，reconnect 时额外
// resolveProfileTarget 以取最新凭据。
// 失败语义（消歧规则，任一不满足即 null）：
// - legacy identity 必须只对应唯一 sourceServerId 与唯一 workspacePath；
// - 目录中找不到 server 时仅接受显式 server target，且在线 session 必须唯一；
// - 存在多个在线 session 时拒绝解析，避免把任务发给错误的那条物理连接。

import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";
import type { BotRemoteWorkspaceResolver } from "@zcode/services";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import type { WindowRemoteLogicalSessionSnapshot } from "./windowRemoteConnectionRegistry.js";

// 解析 Bot 目标工作区，返回可直接派发的 RemoteTarget 或 null。
// kind=server 走快速路径；legacy identity 需要先在 workspaceHistory 与 profiles 中消歧
// （retired profile 也参与，防止 host/port 被新设备复用后把旧授权错配给新 Source）。
// 命中在线 session 时 runtimeKey 固定为 [remoteSessionId, generation] —— 这正是 #18 中
// generation 用于区分「同会话不同连接代际」的用途：重连换代后 runtimeKey 变化，旧 run
// 不会误投到新连接。
// 无 session 时按 preferredProfileId / lastConnectedAt 选 profile；purpose=reconnect 时
// 通过 directory 重新解析凭据（profile.target 可能是过期快照）。
// 失败语义：歧义（多个 source、多条 path、多条在线 session）与无可用 profile 均返回 null。
/** Bot 与 Renderer 共用 Directory/Registry 的事实，旧回退快照不再决定 R3 路由。 */
export async function resolveBotRemoteWorkspace(
  workspace: Parameters<BotRemoteWorkspaceResolver>[0],
  purpose: Parameters<BotRemoteWorkspaceResolver>[1],
  deps: {
    directory: Pick<SourceServerDirectory, "snapshot" | "resolveProfileTarget">;
    listSessions(): WindowRemoteLogicalSessionSnapshot[];
    getLegacyServerTarget?(identity: string): Promise<RemoteTarget | null>;
  },
): ReturnType<BotRemoteWorkspaceResolver> {
  const identity = workspace.workspaceIdentity.trim();
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (!parsed) return null;
  const snapshot = await deps.directory.snapshot();
  let sourceServerId = parsed.sourceServerId;
  let workspacePath = parsed.workspacePath;
  if (parsed.kind !== "server") {
    const historical = snapshot.workspaceHistory.filter(
      (entry) => entry.legacyWorkspaceIdentity === identity && entry.sourceServerId,
    );
    const sources = new Set(historical.map((entry) => entry.sourceServerId!));
    // retired Profile 也参与消歧，避免相同 host/port 被新设备占用后把旧授权移给新 Source。
    for (const profile of snapshot.profiles) {
      if (
        profile.sourceServerId &&
        buildRemoteWorkspaceIdentity(parsed.workspacePath, profile.target) === identity
      )
        sources.add(profile.sourceServerId);
    }
    if (sources.size !== 1) return null;
    sourceServerId = [...sources][0];
    const paths = new Set(historical.map((entry) => entry.workspacePath));
    if (paths.size > 1) return null;
    workspacePath = [...paths][0] ?? parsed.workspacePath;
  }
  const server = snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  // dev server 没有 Source Directory；保留显式 server target 的既有路由，不猜 SSH 线路。
  if (!server) {
    if (parsed.kind !== "server") return null;
    const sessions = deps
      .listSessions()
      .filter(
        (session) =>
          session.target.kind === "server" &&
          session.workspaceIdentity === identity &&
          session.workspacePath === workspace.workspacePath &&
          session.state === "online" &&
          session.sourceAvailability === "online",
      );
    if (sessions.length > 1) return null;
    const session = sessions[0];
    const target = session?.target ?? (await deps.getLegacyServerTarget?.(identity));
    return target?.kind === "server"
      ? {
          ...workspace,
          workspaceIdentity: identity,
          target,
          ...(session
            ? { runtimeKey: JSON.stringify([session.remoteSessionId, session.generation]) }
            : {}),
        }
      : null;
  }
  if (
    workspace.workspacePath !== workspacePath &&
    !snapshot.workspaceHistory.some(
      (entry) =>
        (entry.workspaceIdentity === identity || entry.legacyWorkspaceIdentity === identity) &&
        entry.sourceServerId === sourceServerId &&
        entry.workspacePath === workspacePath,
    )
  )
    return null;
  const stableIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: server.sourceServerId,
    workspacePath,
  });
  const sessions = deps
    .listSessions()
    .filter(
      (session) =>
        session.workspaceIdentity === stableIdentity &&
        session.workspacePath === workspacePath &&
        session.state === "online" &&
        session.sourceAvailability === "online",
    );
  if (sessions.length > 1) return null;
  const session = sessions[0];
  if (session)
    return {
      workspacePath,
      workspaceIdentity: stableIdentity,
      target: session.target,
      runtimeKey: JSON.stringify([session.remoteSessionId, session.generation]),
    };
  const profiles = snapshot.profiles
    .filter(
      (profile) =>
        profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
    )
    .sort((a, b) => {
      if (a.profileId === server.preferredProfileId) return -1;
      if (b.profileId === server.preferredProfileId) return 1;
      return (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0);
    });
  const profile = profiles[0];
  if (!profile) return null;
  return {
    workspacePath,
    workspaceIdentity: stableIdentity,
    target:
      purpose === "reconnect"
        ? await deps.directory.resolveProfileTarget(profile.profileId)
        : profile.target,
  };
}
