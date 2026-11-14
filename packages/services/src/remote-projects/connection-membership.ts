// 远程项目的连接成员关系：负责把用户选择的连接目标变成目录里的 Host 记录，
// 并在服务端确认身份后完成绑定。
// 该模块不负责网络连接、重试和凭据解析，这些能力由连接管理器与凭据服务提供。
// 约束：目录写入与绑定必须幂等，重复调用不能产生重复 Host 或覆盖他人凭据。
import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type ConnectionProfile,
  type RemoteTarget,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

// Host 标识由 workspaceIdentity 派生，而不是直接用 URL：
// 显式 sourceServerId 优先，保证服务端已知身份后能与本地记录对齐；
// 二者都缺失时无法得到稳定标识，直接报错而不是退回随机值。
// 该函数是纯函数，不读写目录，便于在绑定前后重复计算。
export function remoteProjectHostIdForTarget(
  target: RemoteTarget,
  sourceServerId?: string,
): string {
  const identity = sourceServerId
    ? buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" })
    : buildRemoteWorkspaceIdentity("/", target);
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!hostId) throw new Error("remote-project.invalid-host-identity");
  return hostId;
}

// 连接配置只是目标的包装，Host 标识的推导规则必须与直接传目标时完全一致。
export function remoteProjectHostIdForProfile(profile: ConnectionProfile): string {
  return remoteProjectHostIdForTarget(profile.target, profile.sourceServerId);
}

/** URL transport 沿用 CredentialService；成员服务只收到不含 secret 的连接快照。 */
// 把一次「添加或保留服务端连接」的完整准备流程收敛在这里：
// 解析 Host 标识、复用旧凭据键、剥离敏感字段、写入目录，最后回读 token 供连接使用。
// 所有 secret 只经由 CredentialService 存取，目录快照始终保持脱敏状态。
// 失败一律抛出业务错误码的 Error，调用方据此区分「Host 已移除」与「凭据不可用」。
export async function prepareRemoteServerConnection(input: {
  service: IRemoteProjectService;
  credentials: {
    load(key: string): Promise<string | null>;
    save(key: string, value: string): Promise<void>;
  };
  target: Extract<RemoteTarget, { kind: "server" }>;
  intent: "add" | "retain";
}) {
// 先按目标标识精确查找；服务端尚未分配 serverId 时退化为按 URL 匹配，
// 用于兼容早期版本只保存地址、没有稳定标识的连接记录。
  const directory = await input.service.readDirectory();
  const requestedId = remoteProjectHostIdForTarget(input.target);
  const existing =
    directory.hosts.find((host) => host.id === requestedId) ??
    (!input.target.serverId
      ? directory.hosts.find(
          (host) => host.target?.kind === "server" && host.target.url === input.target.url,
        )
      : undefined);
// retain 表示继续使用已有连接，主机已被删除时无法恢复，必须显式失败。
// add 允许在旧记录基础上补全，因此不在此处抛错。
  if (input.intent === "retain" && !existing) throw new Error("remote-project.host-removed");
// 只有服务端类型的历史目标才能复用，其它类型视为不存在，避免串用字段。
// saved 存在时保留其 serverId 等已解析结果，减少一次不必要的服务端握手。
  const saved = existing?.target?.kind === "server" ? existing.target : undefined;
  const id = existing?.id ?? requestedId;
// 优先沿用旧记录里的凭据键，保证 retain 或重复添加时不会产生多余密钥条目；
// 只有本次带了 token 才生成新键，未带 token 的更新不触碰已有凭据。
  const tokenCredentialKey =
    saved?.tokenCredentialKey ?? (input.target.token ? `remote-server:${id}:token` : undefined);
  if (input.intent === "add" && input.target.token && tokenCredentialKey)
    await input.credentials.save(tokenCredentialKey, input.target.token);
  const target =
    input.intent === "retain" && saved
      ? saved
      : {
          ...stripRemoteTargetSecrets(input.target),
          ...(saved?.serverId ? { serverId: saved.serverId } : {}),
          ...(tokenCredentialKey ? { tokenCredentialKey } : {}),
        };
// add 才写目录；retain 复用已有主机，不改动任何已保存字段。
// 此处断言 existing 非空，因为前面已对 retain 缺失的情况抛错。
  const host = input.intent === "add" ? await input.service.saveHost({ id, target }) : existing!;
  if (host.target?.kind !== "server") throw new Error("remote-project.invalid-server");
  const { tokenCredentialKey: key, ...connectionTarget } = host.target;
// 连接材料才需要明文 token，落盘快照只保留凭据键，避免 secret 写进目录文件。
// 键存在但取不到值说明凭据已被清理，此时直接失败而不是退化成无鉴权连接。
  const token = key ? await input.credentials.load(key) : undefined;
  if (key && !token) throw new Error("remote-project.credential-unavailable");
  return {
    target: { ...connectionTarget, ...(token ? { token } : {}) },
// sourceServerId 要等服务端分配后才知道，所以绑定被推迟到 commit 阶段执行。
// 绑定时用新的 sourceServerId 重算 Host 标识；返回 false 说明 Host 已被移除。
    async commit(sourceServerId: string) {
      const bound = await input.service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId: remoteProjectHostIdForTarget(connectionTarget, sourceServerId),
      });
      if (!bound) throw new Error("remote-project.host-removed");
    },
  };
}

/** 注入既有连接管理器；成员关系不承担网络状态、重试或凭据解析。 */
// 准入器只负责落库与绑定，不缓存连接状态：真正的连接结果仍由连接管理器回填。
// confirmIdentityChange 仅在用户明确同意时才允许分叉出新的 Host，避免静默重复建连。
export function createRemoteProjectConnectionAdmission(service: IRemoteProjectService) {
  return async (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }): Promise<(sourceServerId: string) => Promise<void>> => {
    const id = remoteProjectHostIdForProfile(input.profile);
    const host =
      input.intent === "add"
        ? await service.saveHost({ id, target: input.profile.target })
        : (await service.readDirectory()).hosts.find((item) => item.id === id);
    if (!host) throw new Error("remote-project.host-removed");
    return async (sourceServerId) => {
      const resolvedId = remoteProjectHostIdForProfile({ ...input.profile, sourceServerId });
      const bound = await service.bindHost({
        id: host.id,
        membershipId: host.membershipId,
        resolvedId,
        createDistinctHost: input.confirmIdentityChange,
      });
      if (!bound) throw new Error("remote-project.host-removed");
    };
  };
}
