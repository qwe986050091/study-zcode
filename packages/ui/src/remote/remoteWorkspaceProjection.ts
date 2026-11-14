// INV-01 服务器排除：守住位置 直连服务器判断；改错故障：直连 URL 被画成受管设备。
// INV-02 精确别名：守住位置 历史唯一匹配；改错故障：按主机或账号猜测，工作区归错设备。
// INV-03 多义待定：守住位置 唯一性判断；改错故障：歧义历史随机选中一个设备。
// INV-04 事实优先：守住位置 附件事实读取；改错故障：已有可信事实被状态推导覆盖。
// INV-05 在线非就绪：守住位置 缺事实时的返回；改错故障：来源在线直接投影成就绪。
// INV-06 本地不入远端：守住位置 远端标签过滤；改错故障：本地工作区被当成断连设备。
// INV-07 状态缺省：守住位置 聚合状态回退；改错故障：未知设备被当成在线。
// INV-08 退役过滤：守住位置 配置生命周期判断；改错故障：已退役配置继续出现在设备下。
// INV-09 已知项目剔除：守住位置 对话工作区比较；改错故障：已绑定的项目重复出现在历史。
// INV-10 会话优先：守住位置 附件索引顺序；改错故障：工作区键覆盖更新的会话事实。
// INV-11 可选字段省略：守住位置 展开条件；改错故障：空字段以未定义键进入视图。
// INV-12 目的缺省：守住位置 目的回退；改错故障：未标注目的的工作区丢失分类。
// INV-13 历史保留无主：守住位置 设备为空的分支；改错故障：全部历史被过滤掉。
// INV-14 打开项复用：守住位置 执行上下文的查询；改错故障：同一工作区两处信息不一致。
// INV-15 键归一：守住位置 会话键构造；改错故障：同一工作区产生两个键。
// INV-16 纯投影：守住位置 buildRemoteWorkspaceProjection；改错故障：投影过程写回设置或标签。
// INV-17 空输入可用：守住位置 快照为空的分支；改错故障：无管理快照时整页报错。
// INV-18 顺序稳定：守住位置 设备与标签遍历顺序；改错故障：列表顺序随输入抖动。
//
// 模块职责：把远端设备、会话事实与标签投影成设备、打开项、历史与执行上下文。
// 状态所有权：投影结果由调用方持有；本模块只读输入。
// 阅读顺序：设备归属 → 附件态 → 标签判定 → 投影主体 → 设备 → 打开项 → 历史 → 执行上下文。
import {
  parseRemoteWorkspaceIdentity,
  type SourceServerConnectionStateSnapshot,
  type SourceServerManagementSnapshot,
  type SourceServerRecord,
  type SourceServerWorkspaceHistoryEntry,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  buildAggregatedSourceStatusMap,
  type AggregatedSourceStatus,
} from "@/lib/remoteConnectionPresentation.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

// 旧侧栏 Source 分组（lib/workspaceSourceGroups.ts）随 Group 视图下线；这是其中唯一仍被
// 远端投影使用的推导，迁到这里以免为 3 行逻辑保留 250 行死文件。
// tab.remoteTarget.kind === "server" 时直接返回 null。
// parseRemoteWorkspaceIdentity() 判为 server 才取 sourceServerId。
// 旧身份只在 workspaceHistory 恰有一个精确别名时归属。
// 多义时返回 null，保持待识别。
//
function getWorkspaceSourceServerId(
  tab: Pick<WorkspaceTabState, "workspaceIdentity" | "workspacePath" | "remoteTarget">,
  options: { workspaceHistory?: readonly SourceServerWorkspaceHistoryEntry[] } = {},
): string | null {
  // Direct URL Server 不属于 Source 管理域；不能仅凭相同的 identity 格式冒充 Source 设备。
  if (tab.remoteTarget?.kind === "server") return null;
  const parsed = tab.workspaceIdentity ? parseRemoteWorkspaceIdentity(tab.workspaceIdentity) : null;
  if (parsed?.kind === "server") return parsed.sourceServerId ?? null;

  const legacyWorkspaceIdentity = tab.workspaceIdentity?.trim();
  if (!legacyWorkspaceIdentity) return null;
  const matchingSourceServerIds = new Set(
    options.workspaceHistory
      ?.filter(
        (entry) =>
          entry.workspacePath === tab.workspacePath &&
          entry.legacyWorkspaceIdentity?.trim() === legacyWorkspaceIdentity &&
          Boolean(entry.sourceServerId?.trim()),
      )
      .map((entry) => entry.sourceServerId!.trim()) ?? [],
  );
  // 修复原因：旧版本回退兼容会在 lastWorkspaceSession 中保留 route identity，
  // 即使 Source Directory 已经确认设备，侧栏也会把同一个 tab 再画成“待识别线路”。
  // 这里只消费 Directory 已持久化的精确 legacy alias，不改写旧数据，也不按 hostname/账号猜测；
  // 若换代历史产生歧义则继续保持待识别，避免把 workspace 归到错误设备。
  return matchingSourceServerIds.size === 1
    ? (matchingSourceServerIds.values().next().value ?? null)
    : null;
}

export type WorkspaceAttachmentViewState =
  | "disconnected"
  | "attaching"
  | "ready"
  | "recovering"
  | "failed";

export interface RemoteWorkspaceAttachmentFact {
  remoteSessionId: string;
  workspaceKey: string;
  sourceServerId?: string;
  state?: WorkspaceAttachmentViewState;
}

export interface RemoteDeviceView {
  sourceServerId: string;
  displayName: string;
  osUser?: string;
  hostname?: string;
  aggregatedStatus: AggregatedSourceStatus;
  profiles: SourceServerManagementSnapshot["profiles"];
  knownProjects: SourceServerWorkspaceHistoryEntry[];
}

export interface RemoteOpenWorkspaceView {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  purpose: WorkspacePurpose;
  sourceServerId?: string;
  sourceDisplayName?: string;
  sourceStatus?: AggregatedSourceStatus;
  remoteSessionId?: string;
  attachmentState: WorkspaceAttachmentViewState;
  lastConnectionError?: string;
}

export interface RemoteExecutionContextView {
  kind: "local" | "remote";
  workspaceKey: string;
  workspacePath: string;
  workspacePurpose: WorkspacePurpose;
  sourceServerId?: string;
  sourceDisplayName?: string;
  attachmentState?: WorkspaceAttachmentViewState;
}

export interface RemoteWorkspaceProjection {
  devices: RemoteDeviceView[];
  openWorkspaces: RemoteOpenWorkspaceView[];
  projectHistory: SourceServerWorkspaceHistoryEntry[];
  executionContexts: RemoteExecutionContextView[];
}

export interface RemoteWorkspaceProjectionInput {
  managementSnapshot?: SourceServerManagementSnapshot | null;
  tabs: readonly WorkspaceTabState[];
  attachments?: readonly RemoteWorkspaceAttachmentFact[];
  remoteConversationWorkspaceBySourceServerId?: AppSettingsConversationWorkspaceMap;
}

export type AppSettingsConversationWorkspaceMap = Readonly<
  Record<string, { workspacePath: string; lastResolvedAt: number }>
>;

function stateForOpenWorkspace(
  tab: WorkspaceTabState,
  attachment: RemoteWorkspaceAttachmentFact | undefined,
  sourceStatus: AggregatedSourceStatus | undefined,
): WorkspaceAttachmentViewState {
  // attachment.state 存在时直接采信。
  // 无会话标识视为断开，来源离线或失败也视为断开。
  //
  if (attachment?.state) return attachment.state;
  if (!tab.remoteSessionId) return "disconnected";
  if (sourceStatus === "offline" || sourceStatus === "failed") return "disconnected";
  // remoteSessionId 只代表逻辑 session 存在；没有可信 attachment fact 时仍可能处于
  // bind/reattach 中，不能把“Source online”提前投影成 workspace ready。
  // 有会话标识但缺事实时保持挂接中。
  // 来源在线不等于工作区就绪，仍返回 attaching。
  //
  return "attaching";
}

// Boolean(remoteSessionId || remoteTarget || workspaceIdentity) 即远端标签。
// 本地标签只留在执行上下文集合。
//
export function isRemoteWorkspaceTab(tab: WorkspaceTabState): boolean {
  return Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
}

// 先按输入快照建状态与索引。
// devices / openWorkspaces / projectHistory / executionContexts 四段各自推导。
//
export function buildRemoteWorkspaceProjection(
  input: RemoteWorkspaceProjectionInput,
): RemoteWorkspaceProjection {
  const snapshot = input.managementSnapshot ?? null;
  const statuses = buildAggregatedSourceStatusMap(snapshot);
  const serverById = new Map(
    snapshot?.servers.map((server) => [server.sourceServerId, server]) ?? [],
  );
  const attachments = input.attachments ?? [];
  const attachmentBySessionId = new Map(
    attachments.map((attachment) => [attachment.remoteSessionId, attachment]),
  );
  const attachmentByWorkspaceKey = new Map(
    attachments.map((attachment) => [attachment.workspaceKey, attachment]),
  );

  // 设备状态回退为离线，配置过滤掉已退役。
  // knownProjects 过滤掉 remoteConversationWorkspaceBySourceServerId 命中的条目。
  //
  const devices = (snapshot?.servers ?? []).map((server: SourceServerRecord) => ({
    sourceServerId: server.sourceServerId,
    displayName: server.displayName,
    ...(server.osUser ? { osUser: server.osUser } : {}),
    ...(server.hostname ? { hostname: server.hostname } : {}),
    aggregatedStatus: statuses.get(server.sourceServerId) ?? "offline",
    profiles: (snapshot?.profiles ?? []).filter(
      (profile) =>
        profile.sourceServerId === server.sourceServerId && profile.lifecycleState !== "retired",
    ),
    knownProjects: (snapshot?.workspaceHistory ?? []).filter(
      (entry) =>
        entry.sourceServerId === server.sourceServerId &&
        input.remoteConversationWorkspaceBySourceServerId?.[server.sourceServerId]
          ?.workspacePath !== entry.workspacePath,
    ),
  }));

  // Bug 根因：Projection 之前把 local tab 也当成 open remote workspace，
  // 随后因没有 remoteSessionId 被投影成 disconnected。openWorkspaces 是远端集合，
  // local tab 必须只留在 executionContexts，避免未来消费者把本地 workspace 当断连设备。
  // openWorkspaces 只由 input.tabs.filter(isRemoteWorkspaceTab) 生成。
  // 来源名与状态按设备索引补齐，缺失时省略字段。
  //
  const remoteTabs = input.tabs.filter(isRemoteWorkspaceTab);
  const openWorkspaces = remoteTabs.map((tab): RemoteOpenWorkspaceView => {
    const workspaceKey = buildWorkspaceSessionKey(tab);
    const sourceServerId = getWorkspaceSourceServerId(tab, {
      workspaceHistory: snapshot?.workspaceHistory,
    });
    const source = sourceServerId ? serverById.get(sourceServerId) : undefined;
    const sourceStatus = sourceServerId ? statuses.get(sourceServerId) : undefined;
    const attachment =
      (tab.remoteSessionId ? attachmentBySessionId.get(tab.remoteSessionId) : undefined) ??
      attachmentByWorkspaceKey.get(workspaceKey);
    return {
      workspaceKey,
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      purpose: tab.workspacePurpose ?? "project",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...(source?.displayName ? { sourceDisplayName: source.displayName } : {}),
      ...(sourceStatus ? { sourceStatus } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      attachmentState: stateForOpenWorkspace(tab, attachment, sourceStatus),
    };
  });

  // projectHistory 保留 sourceServerId 为 undefined 的条目。
  // 已用作对话工作区的条目被 filter 排除。
  //
  const projectHistory = (snapshot?.workspaceHistory ?? []).filter(
    (entry) =>
      entry.sourceServerId === undefined ||
      input.remoteConversationWorkspaceBySourceServerId?.[entry.sourceServerId]?.workspacePath !==
        entry.workspacePath,
  );

  const openWorkspaceByKey = new Map(
    openWorkspaces.map((workspace) => [workspace.workspaceKey, workspace]),
  );
  // 本地标签也生成执行上下文，但不带远端字段。
  // executionContexts 复用 openWorkspaceByKey 的附件态与来源信息。
  //
  const executionContexts: RemoteExecutionContextView[] = input.tabs.map((tab) => {
    const open = isRemoteWorkspaceTab(tab)
      ? openWorkspaceByKey.get(buildWorkspaceSessionKey(tab))
      : undefined;
    return {
      kind: isRemoteWorkspaceTab(tab) ? "remote" : "local",
      workspaceKey: buildWorkspaceSessionKey(tab),
      workspacePath: tab.workspacePath,
      workspacePurpose: tab.workspacePurpose ?? "project",
      ...(open?.sourceServerId ? { sourceServerId: open.sourceServerId } : {}),
      ...(open?.sourceDisplayName ? { sourceDisplayName: open.sourceDisplayName } : {}),
      ...(open ? { attachmentState: open.attachmentState } : {}),
    };
  });

  return { devices, openWorkspaces, projectHistory, executionContexts };
}

export function resolveSourceStatus(
  snapshot: SourceServerManagementSnapshot | null | undefined,
  sourceServerId: string,
): AggregatedSourceStatus {
  return buildAggregatedSourceStatusMap(snapshot).get(sourceServerId) ?? "offline";
}

export function isSourceConnectionStateOnline(
  states: readonly SourceServerConnectionStateSnapshot[],
  sourceServerId: string,
): boolean {
  return states.some(
    (state) => state.sourceServerId === sourceServerId && state.state === "online",
  );
}
