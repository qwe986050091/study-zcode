// INV-01 最近目录必须唯一定位：守住位置 entries.length 不等于一；改错故障 多份同名目录被静默选中第一份。
// INV-02 同时比对 roots 与 legacyWorkspace：守住位置 some 的两段；改错故障 迁移前的老项目找不到入口。
// INV-03 host 必须存在：守住位置 hosts.some 过滤；改错故障 失效主机的目录残留仍被当作候选。
// INV-04 有 profileId 就优先 profile：守住位置 三元展开；改错故障 目录绑定被降级成按来源服务器匹配。
// INV-05 连接前固定已有入口：守住位置 entries 首元素 id；改错故障 连接完成后误入创建器。
// INV-06 workspaceKey 反查路径：守住位置 pathForEntry；改错故障 用错路径连接到另一目录。
// INV-07 缺任一要素即抛错：守住位置 entry、host、path 三条件；改错故障 用空值继续连接。
// INV-08 Direct Server 走原出口：守住位置 host.kind 判定后提前返回；改错故障 服务器主机被误当成员走向导。
// INV-09 凭据返回前再验成员仍在：守住位置 stillRetained 首次调用；改错故障 已移除项目被重新拉起。
// INV-10 向导打开前再验一次：守住位置 末尾的 stillRetained；改错故障 迟到的结果把已删项目复活。
// INV-11 保留判断要同时校验主机与条目：守住位置 membershipId 与 pathForEntry；改错故障 同名主机换绑后仍判定保留。
// INV-12 展示聚合不替换默认线路：守住位置 profile 的取用；改错故障 失败线路被误设为默认操作线路。
// INV-13 已定线路时错误只取线路：守住位置 projectError 三元；改错故障 Host 聚合错误盖住真实线路错误。
//
// 模块职责：把最近远程项目与保留中的远程项目解析成连接请求，并守住成员移除的竞态。
// 阅读顺序：先看最近目录的唯一定位，再看保留连接的路径反查与 Direct Server 分支，最后看两次复验。
import type { IRemoteProjectService, RemoteProjectDirectory } from "@/project-sidebar/contract.js";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import {
  buildRemoteTargetFromProfile,
  findPreferredSourceConnectionProfile,
} from "@/lib/remoteConnectionWizard.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";

/** 最近目录不是新建请求；连接前固定已有入口，避免连接完成后误入创建器。 */
// 最近目录是只读匹配，不产生副作用。
export function resolveRecentRemoteProjectPreference(
  directory: RemoteProjectDirectory,
  input: { sourceServerId: string; path: string; profileId?: string },
): RemoteConnectionOpenPreference | null {
  const identity = buildServerRemoteWorkspaceIdentity({
    serverId: input.sourceServerId,
    workspacePath: input.path,
  });
  // 候选必须属于现存主机，否则视为陈旧记录。
  const entries = directory.entries.filter(
    (entry) =>
      directory.hosts.some((host) => host.id === entry.hostId) &&
      [...entry.roots.map((root) => root.rootPath), entry.legacyWorkspace?.workspacePath].some(
        (path) => path && buildRemoteHostWorkspaceIdentity(entry.hostId, path) === identity,
      ),
  );
  // 只有唯一匹配才敢固定入口，多份时交回调用方。
  if (entries.length !== 1) return null;
  return {
    ...(input.profileId
      ? { preferredProfileId: input.profileId }
      : { preferredSourceServerId: input.sourceServerId }),
    preferredDirectoryPath: input.path,
    // 记录命中的条目，连接后据此恢复选中。
    preferredProjectEntryId: entries[0]!.id,
  };
}

/** F5 下项目成员不等于已打开 tab；连接成员仍交给 Host，需要交互才移交唯一向导。 */
// 保留连接是异步流程，全程可能被并发移除打断。
export async function requestRetainedRemoteProjectConnection(input: {
  workspaceKey: string;
  service: IRemoteProjectService;
  getSnapshot?: () => Promise<SourceServerManagementSnapshot>;
  openWizard: (preference: RemoteConnectionOpenPreference) => void;
}) {
  const directory = await input.service.readDirectory();
  // 把 workspaceKey 翻译成条目下的真实路径。
  const pathForEntry = (entry: (typeof directory.entries)[number]) =>
    entry.roots.find(
      (root) =>
        buildRemoteHostWorkspaceIdentity(entry.hostId, root.rootPath) === input.workspaceKey,
    )?.rootPath ??
    (entry.legacyWorkspace &&
    buildRemoteHostWorkspaceIdentity(entry.hostId, entry.legacyWorkspace.workspacePath) ===
      input.workspaceKey
      ? entry.legacyWorkspace.workspacePath
      : undefined);
  // 先找到持有该路径的条目，再由条目取主机。
  const entry = directory.entries.find((candidate) => pathForEntry(candidate));
  const host = directory.hosts.find((candidate) => candidate.id === entry?.hostId);
  const path = entry && pathForEntry(entry);
  // 三要素缺一不可，直接失败而不是猜测。
  if (!entry || !host || !path) throw new Error("remote-project.entry-not-found");
  // Direct Server 不属于 Source Profile 管理域，保留其原有连接与错误出口。
  // Direct Server 不经 Source Profile，保持原行为。
  if (host.kind === "server") {
    await input.service.connectHost(host.id);
    return;
  }
  // 复验闭包重新读取目录，不接受旧快照。
  const stillRetained = async () => {
    const current = await input.service.readDirectory();
    return (
      current.hosts.some(
        (candidate) => candidate.id === host.id && candidate.membershipId === host.membershipId,
      ) &&
      current.entries.some(
        (candidate) => candidate.id === entry.id && pathForEntry(candidate) === path,
      )
    );
  };
  const snapshot = await input.getSnapshot?.();
  // `stillRetained` 通过之前不动任何副作用。
  if (!(await stillRetained())) return;
  const sourceId = getWorkspaceSourceServerId(
    {
      workspacePath: path,
      workspaceIdentity: input.workspaceKey,
      remoteTarget: host.target ?? undefined,
    },
    { workspaceHistory: snapshot?.workspaceHistory },
  );
  // 展示聚合会优先选失败/待处理线路，不能据此替换 Host 的默认操作线路。
  const profile =
    snapshot && sourceId ? findPreferredSourceConnectionProfile(snapshot, sourceId) : undefined;
  // 按线路取状态，用于展示与错误归类。
  const state = snapshot?.states.find((candidate) => candidate.profileId === profile?.profileId);
  const server = snapshot?.servers.find((candidate) => candidate.sourceServerId === sourceId);
  let pendingWizard: RemoteConnectionOpenPreference | undefined;
  await requestRemoteProjectConnection({
    preference: {
      preferredDirectoryPath: path,
      preferredProjectEntryId: entry.id,
      preferredProfileId: profile?.profileId,
      preferredTarget: profile ? buildRemoteTargetFromProfile(profile) : (host.target ?? undefined),
    },
    presentation: resolveRemoteConnectionPresentation({
      ...state,
      installState: server?.installState,
      // Host 错误也是设备聚合；已确定操作线路时只能使用该线路的错误。
      projectError: profile ? undefined : host.lastConnectionError,
    }),
    failure: {
      code: state?.errorCode,
      message: state?.error ?? (profile ? "" : (host.lastConnectionError ?? "")),
    },
    // 重连只作用于当前主机，不改线路偏好。
    reconnect: async () => {
      await input.service.connectHost(host.id);
    },
    openWizard: (preference) => {
      pendingWizard = preference;
    },
  });
  // 凭据/更新结果可能晚于成员移除；引用和旧快照都不能授权复活已移除的项目。
  // 向导打开前再调一次 `stillRetained` 复验。
  if (pendingWizard && (await stillRetained())) input.openWizard(pendingWizard);
}
