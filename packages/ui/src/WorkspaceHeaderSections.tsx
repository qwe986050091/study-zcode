// ─────────────────────────────────────────────────────────────────────────────
// 深注释：Workspace Header 标题区——职责边界 / 不变量
// ─────────────────────────────────────────────────────────────────────────────
// 做：渲染 header 的标题区——工作区上下文按钮与 tooltip、任务标题、更多菜单、
//     远端同步入口与同步弹窗，并把菜单动作（pin/unpin、改名、归档、已读、反馈、
//     打开路径、模型轨迹）接到 workspace 服务与全局缓存。
// 不做：不持有 task/session 业务事实（store 与服务是所有者），不实现远端连接、
//       不解析身份格式（走 shared 的 parseRemoteWorkspaceIdentity 等），也不渲染菜单内容
//       细节（TaskActionMenuContent 负责）。本组件只做布局编排与乐观更新协调。
// 依赖：useWorkspaceServices / useBaseWorkspaceServices 取本远端与本地服务；
//       useZCodeSessionStore 做运行态清理；taskQueryCacheStore 做列表缓存变更；
//       remoteWorkspaceSessionStore / RemoteProjectPresentationContext 提供远控展示事实。
//
// 不变量（INV）：
// INV-01 断言：标题区不得 flex-1 铺满 header —— 位置：外层 className —— 改错故障：no-drag 区域覆盖拖拽区，mac/Windows 标题栏整条无法拖动窗口。
// INV-02 断言：isDraftNewTask 优先于 activeTaskId —— 位置：variant 三元 —— 改错故障：草稿态仍显示上一任务的菜单，操作落到已归档任务上。
// INV-03 断言：没有稳定 taskId 时禁用任务级动作 —— 位置：disableTaskTargetActions —— 改错故障：新任务首次写库前点菜单无响应，用户以为功能坏了。
// INV-04 断言：pinned 列表只在菜单打开时查询 —— 位置：headerWorkspaceTabs 的条件 —— 改错故障：首屏多拉一次 listTaskList，启动变慢且与共享订阅重复。
// INV-05 断言：任务动作的 workspaceIdentity 必须随路径一起传 —— 位置：所有服务调用 —— 改错故障：远端会话动作落到同路径的本地工作区，改错对象。
// INV-06 断言：归档前必须二次确认 —— 位置：handleArchiveTask 的 confirmDialog —— 改错故障：在菜单里误触直接归档，任务从列表消失且难以恢复。
// INV-07 断言：归档成功后必须同时清运行态与查询缓存 —— 位置：removeTaskState + applyTaskQueryCacheMutation —— 改错故障：Header 归档后列表不刷新，点击仍能进入已归档任务。
// INV-08 断言：乐观更新失败必须回滚 pinned 状态 —— 位置：onTogglePinTask 的 catch —— 改错故障：网络失败后 UI 与 DB 相反，再点一次会重复取反。
// INV-09 断言：改名前后标题相同则直接取消 —— 位置：handleSubmitRenameTask 的相等判断 —— 改错故障：无意义的服务调用触发缓存变更与 toast 噪音。
// INV-10 断言：改名失败不得重置草稿 —— 位置：catch 只 toast —— 改错故障：用户的输入被清空，需要重新输入。
// INV-11 断言：远端连接状态只从统一 presentation 派生 —— 位置：resolveRemoteConnectionPresentation —— 改错故障：各分支各算一份，按钮、tooltip 与无障碍描述互相矛盾。
// INV-12 断言：attached 必须走 resolveWorkspaceRemoteSessionId —— 位置：remoteWorkspaceSessionStore 选择器 —— 改错故障：直接读 tab sessionId 会把已注册身份误报为断线。
// INV-13 断言：设备名优先用目录 target，再回落 identity 解析 —— 位置：formatRemoteDeviceName 调用 —— 改错故障：同路径多设备时名称串台，用户不知道在操作哪台机器。
// INV-14 断言：同步入口只在同时具备三种同步服务时出现 —— 位置：hasLocalSourceService —— 改错故障：点开同步弹窗后才发现无服务，出现空窗或报错。
// INV-15 断言：同步完成后必须失效草稿会话与刷新 store —— 位置：onSkillsSynced 等回调 —— 改错故障：继续用旧 skill 列表发起会话，能力与 UI 不一致。
// INV-16 断言：provider 解析必须兼顾任务级覆盖与 workspace 级选择 —— 位置：resolveWorkspaceHeaderProvider —— 改错故障：菜单里的日志/配置路径指向错误 provider。
// INV-17 断言：isRemoteWorkspace 的判断包含 identity 与 sessionId —— 位置：Boolean 三条件 —— 改错故障：仅凭 host label 判断会漏掉未连上的远端工作区，退回显示本地图标。
// INV-18 断言：标题与工作区名必须可截断且不换行 —— 位置：truncate/min-w-0 —— 改错故障：长路径撑破 header，把更多菜单挤出视口。
// INV-19 断言：无障碍锚点（testid / data-workspace-abs-path）不得删 —— 位置：标题与路径按钮 —— 改错故障：E2E 无法判定当前工作区，回归用例全部失效。
//
// 阅读提示：下方注释只解释“为什么这个顺序/这个条件/这个回滚不能动”，不复述 JSX。
// ─────────────────────────────────────────────────────────────────────────────
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import { useRemoteProjectPresentationFacts } from "@/hooks/RemoteProjectPresentationContext.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  formatRemoteDeviceName,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { WorkspaceContextPath } from "@/WorkspaceHeaderSections/WorkspaceContextPath.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
/* eslint-disable max-lines -- Header 标题区当前同时承载 task 菜单、路径上下文和 workspace 级状态提示，先保持单文件收口，避免菜单链路迁移时再引入回归。 */
import {
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type RemoteTarget,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
} from "@zcode/shared/test-ids";
import { useMemo, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Ellipsis, Folder, GitBranch, LoaderIcon } from "lucide-react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import type {
  WorkspaceHeaderState,
  WorkspaceHeaderTitleSectionProps,
} from "@/WorkspaceHeaderSections/shared.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import {
  RemoteSyncDialogs,
  RemoteSyncMenuItems,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { useSourceServerDisplayNames } from "@/hooks/useSourceServerDisplayNames.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";

export type { WorkspaceHeaderState, WorkspaceHeaderTitleSectionProps };
export {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderActionSectionProps,
} from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";

// [契约] 同步入口的可见性判断单独导出，是为了让宿主（工具栏/设置页）复用同一规则；
// 不要在各处重新拼条件，否则同一个能力在不同入口一会儿能点、一会儿不能点。
// 参数全部显式传入而不是内部读 store：这个函数要能在单测与 SSR 下直接调用。
export function shouldShowRemoteSkillSyncAction(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  hasLocalSourceService?: boolean;
}): boolean {
  // 此处不再加第二层判断：可见性规则只有 shouldShowRemoteSyncActions 一份，
  // 在这里补条件会让宿主与 header 的结论不同。
  return shouldShowRemoteSyncActions(params);
}

// [契约] props 分为三组：展示事实（路径/远端/标题）、宿主注入的 provider 与回调、
// 以及一组以下划线开头的“当前未使用但契约保留”字段。
// 下划线字段不能删：调用方仍在传，删除会让上层同步改签名，扩大改动面；
// 也不能悄悄启用，它们对应的 UI 已下线，启用会复活旧交互。
// simplifyForNarrowRemote 与 compact 是两套独立压缩策略：前者用于手机远控，
// 后者用于桌面紧凑模式，合并会让两类屏幕互相牵连。
export function WorkspaceHeaderTitleSection({
  variant,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary: _activeTaskChangeSummary,
  activeTaskId,
  activeTraceId: _activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  gitSummary,
  gitDirtyFileCount: _gitDirtyFileCount,
  sessionLogPath: _sessionLogPath,
  nativeSessionLogProvider: _nativeSessionLogProvider,
  nativeSessionLogPath: _nativeSessionLogPath,
  nativeSessionLogExists: _nativeSessionLogExists,
  nativeSessionLogLoading: _nativeSessionLogLoading,
  providerWorkspaceConfigPath: _providerWorkspaceConfigPath,
  providerWorkspaceConfigExists: _providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading: _providerWorkspaceConfigLoading,
  reloadSessionPending,
  workspaceHeaderState,
  onRefreshGit: _onRefreshGit,
  isMacDesktop: _isMacDesktop,
  isMacFullscreen: _isMacFullscreen,
  isWindowsDesktop: _isWindowsDesktop,
  isWebRemoteControl = false,
  selectedEditor: _selectedEditor,
  simplifyForNarrowRemote = false,
  compact = false,
}: WorkspaceHeaderTitleSectionProps) {
  // [契约] 文案一律走 intl：header 是跨语言长度差异最大的区域，
  // 任何硬编码字符串都会在窄屏把更多菜单挤出去。
  const { intl } = useZCodeIntl();
  // 只订阅动作而不是整个 store：header 常驻渲染，整 store 订阅会让任何反馈状态变化都重渲标题区。
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const confirmDialog = useConfirmDialog();
  // [契约] 远端服务与基础服务必须分开取：services 按工作区路由（可能是远端），
  // baseServices 永远是本地宿主能力，混用会让远端工作区去调用本地同步实现。
  // 三个入参缺一不可：路径决定 cwd，sessionId 决定连接，identity 决定身份隔离。
  const services = useWorkspaceServices(workspaceAbsPath, remoteSessionId, workspaceIdentity);
  // [契约] 基础服务永远指向本地宿主，用于给远端同步提供“本端”能力；
  // 远端工作区的 services 不能替代它，混用会让同步方向反过来。
  const baseServices = useBaseWorkspaceServices();
  // [契约] 运行态清理只能通过 store 动作，不能在组件里直接改 map：
  // 归档/删除后必须让所有订阅同一任务的视图一起失效。
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  // [契约] 乐观列表项与查询缓存是两份投影，改名/已读都要同时更新；
  // 只写其中一份会让 header 与侧边栏在同一时刻显示不同标题。
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  // pin 成功后才移除乐观项：提前移除会让列表在请求期间短暂回退到旧状态。
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  // 未读标记是运行态投影，必须与服务写入结果一起更新，不能只改服务。
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  // 菜单开合是纯 UI 状态，允许留在本组件：它不跨窗口、不需要持久化；
  // 但它同时控制 pinned 查询是否启用（见 headerPinnedTaskList），所以不能下沉到菜单内部。
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  // 上下文 tooltip 的开合是局部 UI 状态；关闭时内部不渲染路径细节，减少重渲。
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  // [契约] 用 taskId 而不是布尔表示改名态：弹窗关闭时必须能确认关的是哪个任务，
  // 布尔会在请求切换任务时把新任务的弹窗意外打开。
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  // 草稿与 renamingTaskId 成对存在；只清草稿不清 id 会让空标题的弹窗重新出现。
  const [renameDraft, setRenameDraft] = useState("");
  // 三个同步弹窗各自独立开合，不合并成一个枚举：
  // 用户可能先看 skill 再切 mcp，合并状态会强制关闭前一个。
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  // MCP 同步弹窗的状态与 skill 完全对称，便于 RemoteSyncDialogs 统一接管。
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  // 插件同步最重（会重建能力清单），因此完成后必须刷新 capabilities 而不是只关窗。
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  // [资源] 改名输入框的焦点句柄由父级持有：TaskRenameDialog 负责渲染，
  // 父级负责在打开后聚焦，二者分离避免弹窗内部再存一份焦点状态。
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // [契约] 只构造当前工作区一个 tab，而不是把侧边栏全部 tab 传进来：
  // header 的菜单查询应严格限定在当前工作区，传全集会把别的项目的 pin 状态混进来。
  // id 用 identity 优先、路径兜底，与全局 workspace key 规则一致。
  const headerWorkspaceTabs = useMemo(
    () => [
      {
        id: `header-${workspaceIdentity?.trim() || workspaceAbsPath}`,
        kind: "workspace" as const,
        workspacePath: workspaceAbsPath,
        label: projectName,
        remoteSessionId,
        workspaceIdentity,
      },
    ],
    [projectName, remoteSessionId, workspaceAbsPath, workspaceIdentity],
  );
  // [契约] workspaceTabs 为空数组时 hook 不发起查询，这是“菜单关闭即不查”的开关；
  // 不要改成传恒定的 tabs 再在渲染处过滤——查询本身才是首屏开销。
  // collapsedLimit/expanded 只影响菜单展示条数，不影响 membership 判断。
  // sortBy updated 与侧边栏一致，避免同一任务在两个入口顺序不同。
  const headerPinnedTaskList = useGlobalTaskList({
    kind: "pinned",
    // Header 常驻渲染，以前为了菜单里的 pin/unpin 文案会在启动时额外拉一份
    // pinned task 列表。只有打开更多菜单时才需要这个成员状态，延迟查询可以减少首屏
    // listTaskList 数量，并通过 useGlobalTaskList 的共享订阅复用 workspace 事件源。
    workspaceTabs: taskMenuOpen && activeTaskId ? headerWorkspaceTabs : [],
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  // 只取 items：loading 与 error 各自单独消费，不整体解构，避免无关字段变化触发重渲。
  const pinnedTasks = headerPinnedTaskList.items;
  // [契约] 优先使用宿主解析后的 meta，缺失才回落 null：
  // 这里不能自己从列表里找任务——列表可能还没加载，找出来的会是旧快照。
  const activeTaskMeta = resolvedActiveTaskMeta ?? null;
  // pin 状态以查询结果为准而不是本地开关：多端/多窗口操作后本地开关会过期。
  // 没有 activeTaskId 时恒为 false，避免把“无任务”渲染成已 pin。
  const isPinned = Boolean(
    activeTaskId && pinnedTasks.some((task) => task.taskId === activeTaskId),
  );
  // [契约] meta 的 taskId 优先于入参 activeTaskId：fork/重命名后两者可能短暂不一致，
  // meta 是服务端事实，入参可能还是上一次渲染的旧值。
  // 所有菜单动作都必须用这个解析结果，不能用 activeTaskId 直接调服务。
  const resolvedTaskActionTaskId = activeTaskMeta?.taskId ?? activeTaskId;
  // 新建任务在第一次写入数据库前没有稳定 taskId。
  // 之前 Header 更多菜单虽然点击后会被回调里的空 id guard 拦住，但 UI 仍显示为可点，
  // 用户会感知成“菜单无响应”；这里只禁用依赖已落库 task 的动作，保留 workspace 级入口。
  // [契约] 新任务在首次写库前没有稳定 taskId，依赖任务的动作必须禁用；
  // 但 workspace 级入口（复制路径、打开目录）仍要可用，所以不能把整个菜单禁掉。
  const disableTaskTargetActions = !resolvedTaskActionTaskId;
  // [并发] 只有菜单打开且确实有 taskId 时才看 loading：
  // 把 loading 直接透给菜单会让草稿态永远显示加载中。
  const taskMenuMembershipLoading =
    taskMenuOpen && Boolean(resolvedTaskActionTaskId) && headerPinnedTaskList.loading;
  // [契约] 任务级 provider 覆盖 workspace 级选择；解析只做一次并向下传，
  // 菜单里的日志/配置路径与 header 展示必须同源，否则会出现“显示 A、打开 B”。
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    workspaceHeaderState.selectedProvider,
  );
  // 菜单动作使用与 header 相同的 provider 解析结果，不再单独读 store。
  const menuTaskProvider = activeTaskProvider ?? workspaceHeaderProvider;
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: workspaceAbsPath,
    remoteSessionId,
    workspaceIdentity,
    taskId: activeTaskId ?? "",
    // 任务日志查询与 Header 当前展示态使用同一个 provider。
    provider: menuTaskProvider,
    intl,
  });
  // [契约] host label 只用于展示与 isRemoteWorkspace 判定，不参与路由；
  // 路由必须用 identity/sessionId，label 可能因 provider 文案变化。
  const remoteWorkspaceHostLabel = remoteTarget
    ? formatRemoteWorkspaceHeaderHostLabel(remoteTarget)
    : null;
  // Source 显示名来自共享订阅，缺失时返回空 map 而不是抛错；设备名有专门的回落链路。
  const sourceServerDisplayNames = useSourceServerDisplayNames();
  // [契约] identity 可能为空（本地工作区），parse 必须容忍并返回 null；
  // 这里不手写字符串切分——身份格式属于 shared，业务代码只读解析结果。
  const sourceServerId = parseRemoteWorkspaceIdentity(workspaceIdentity ?? "")?.sourceServerId;
  const sourceServerDisplayName = sourceServerId
    ? sourceServerDisplayNames.get(sourceServerId)?.trim()
    : undefined;
  // [契约] 设备展示输入按 sourceServerId 订阅：没有 sourceServer 的本地工作区返回空输入，
  // 后续 presentation 会自然降级为本地形态。
  const deviceInput = useRemoteDevicePresentationInput(sourceServerId);
  // 远控 tab 只携带身份，bridge 已在身份索引登记；直接读 tab sessionId 会误报断线。
  // [契约] 选择器内部只做派生，不触发订阅副作用：
  // 返回布尔让 zustand 用值比较，避免每次 store 更新都让 header 重渲。
  const attached = useRemoteWorkspaceSessionStore((state) => {
    // [契约] 必须用统一解析器从 store 里找当前工作区对应的 sessionId，
    // 直接读 remoteSessionId prop 会漏掉“identity 已登记但 sessionId 尚未回填”的中间态。
    const sessionId = resolveWorkspaceRemoteSessionId(
      { workspacePath: workspaceAbsPath, workspaceIdentity, remoteSessionId, remoteTarget },
      state,
    );
    // [契约] attached 要求 services 已就绪，而不只是 session 存在；
    // 只看 id 会在连接建立但服务未注入时误报已连接，点击后全部失败。
    return Boolean(sessionId && state.sessionsById[sessionId]?.services);
  });
  // 远控没有 Source 管理服务，设备名称复用窗口目录；精确 Host 身份避免同路径串设备。
  // [契约] 远处没有 Source 管理服务时目录为空，必须用 Optional 版本；
  // 改成必需 hook 会让本地/远端两种宿主在启动时崩溃。
  const projectDirectory = useOptionalProjectDirectory();
  // [契约] 精确 Host 身份用于区分同路径的不同设备；
  // 用路径反查目录会把两台机器认成同一台。
  const hostId = remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "");
  // 目录里找 host 只用于补设备名，找不到就返回 undefined，交给后续回落，不能抛错。
  const directoryTarget = projectDirectory?.directory.hosts.find(
    (host) => host.id === hostId,
  )?.target;
  // [契约] project 级事实按 identity 优先、路径兜底订阅，与 workspace key 规则一致；
  // 传路径会让同路径的远端项目共享连接状态。
  const projectFacts = useRemoteProjectPresentationFacts(
    workspaceIdentity?.trim() || workspaceAbsPath,
  );
  // [契约] 连接展示必须合并设备输入、attached、project 事实三路来源后统一解析；
  // 任何分支自行判断 online/offline 都会与按钮状态不一致。
  const presentation = resolveRemoteConnectionPresentation({
    ...deviceInput,
    attached,
    ...projectFacts,
  });
  // recovery 优先于 shortMessage：恢复中的文案包含下一步动作，
  // 被 short 覆盖后用户只看到“未连接”，不知道要不要等待。
  const remoteStatusLabel = presentation.recovery
    ? intl.formatMessage({ id: presentation.recovery.messageId }, presentation.recovery.values)
    : intl.formatMessage({ id: presentation.shortMessageId });
  // [契约] 远端显示名与本地显示名走不同格式化函数，不能统一成 projectName；
  // 远端要附带 `deviceSuffix` 后缀，避免同名项目混在一起。
  const workspaceDisplayLabel = formatRemoteWorkspaceDisplayLabel(projectName, remoteTarget);
  // 设备名回落顺序：目录 target → sourceServer 显示名 → i18n 的“远端项目”；
  // 顺序反了会在有精确信息时仍显示通用文案。
  const remoteDeviceName =
    formatRemoteDeviceName(remoteTarget ?? directoryTarget ?? undefined, sourceServerDisplayName) ??
    intl.formatMessage({ id: "workspaceSidebar.remoteProject" });
  // 上下文按钮的显示名单独取名，是为了让“展示名”与“路径”解耦；
  // 后续若加后缀，只改这一处，不影响菜单与 aria 的组合。
  const workspaceContextLabel = workspaceDisplayLabel;
  // [契约] 非 git 仓库必须返回 null 而不是空串：调用方用真值判断是否渲染分支行，
  // 空串会渲染一个只有图标的空行。
  // detached 与 fallback 文案都走 intl，分支名本身原样透出。
  const workspaceBranchLabel = gitSummary.isRepository
    ? resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      })
    : null;
  // [契约] 三个条件任一成立即为远端工作区：host label、identity、sessionId；
  // 只判 label 会漏掉“已配置但未连上”的远端，UI 退回本地图标并隐藏设备名。
  const isRemoteWorkspace = Boolean(
    remoteWorkspaceHostLabel || workspaceIdentity?.trim() || remoteSessionId,
  );
  // [契约] clientMode 由宿主来源决定：web 远控是可重放链路，桌面是连续链路；
  // 这会影响同步后是否需要重放，不能统一写死。
  // `SYNC_SERVICES` 三种全部存在才显示入口：缺任一视为本地没有同步能力。
  const showRemoteSkillSyncAction = shouldShowRemoteSkillSyncAction({
    remoteSessionId,
    remoteTarget,
    clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
    hasLocalSourceService: Boolean(
      baseServices.skillSyncService &&
      baseServices.mcpSyncService &&
      baseServices.pluginSyncService,
    ),
  });
  // 加载态只来自宿主的 reloadSessionPending，组件不自己起第二个 loading：
  // 两套 loading 会让转圈在动作结束后仍然存在。
  const workspaceActionLoading = reloadSessionPending;
  // [契约] 加载提示同时用于 tooltip 文本与 aria-label，必须只解析一次；
  // 两处各调一次 formatMessage 会在语言切换的那一帧出现不同文案。
  const workspaceActionLoadingTitle = intl.formatMessage({
    id: "appHeader.workspaceSessionActionLoading",
  });
  // 新任务草稿还没有稳定 task 作用域，header 再展示 workspace/分支会和空态主文案重复抢焦点。
  // 草稿态继续隐藏上下文入口；已有 task 将工作区与分支收进名称前的图标提示。
  // [契约] 有 variant 时以 variant 为准，没有才回落到 activeTaskId 判空；
  // 这个优先级保证宿主可以显式声明草稿态，而不依赖 taskId 何时落库。
  // 草稿态会同时关闭标题、更多菜单与上下文入口，三者必须共用这一个布尔。
  const isDraftNewTask = variant ? variant === "draft" : activeTaskId === null;

  // [契约] 反馈预填任务标题、路径与日志线索，但截图与诊断日志留给用户主动选择；
  // 标题截断到 80 字符是 feedback 表单的展示约束，超出会被前端二次截断。
  // module/severity/type 是产品约定的默认值，不在运行时按错误类型推断。
  // 打开表单后必须给 toast 反馈，否则用户以为点击没生效。
  const handleOpenTaskFeedback = async () => {
    // 标题回落顺序：activeTaskTitle → meta 标题 → 已 fork 未命名/未命名文案；
    // 直接用一个兜底会让 fork 出来的任务在反馈里无法与新建任务区分。
    const taskTitle =
      activeTaskTitle ||
      intl.formatMessage({
        id: activeTaskMeta?.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
      });
    // Header 更多菜单缺少当前任务的反馈入口，用户只能复制日志再手动新建反馈。
    // 这里打开反馈表单时预填任务标题、路径和日志线索，截图和诊断日志由用户主动选择。
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: resolvedTaskActionTaskId ?? undefined,
        workspacePath: workspaceAbsPath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };

  // [契约] 没有稳定 taskId 时直接返回，不打开弹窗：
  // 否则用户输入完才在提交阶段失败，体验更差。
  // 草稿初值优先 meta.title，其次入参标题，保证改名从当前可见文案开始。
  const handleStartRenameTask = () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }
    // 打开改名时写入的是解析后的 taskId，而不是菜单闭包里的 activeTaskId，
    // 两者在 fork 后可能不同，写错会让提交改到父任务。
    setRenamingTaskId(resolvedTaskActionTaskId);
    setRenameDraft(activeTaskMeta?.title ?? activeTaskTitle ?? "");
  };

  // 取消必须同时清 id 与草稿：只清 id 会让下次打开沿用上次输入。
  const handleCancelRenameTask = () => {
    setRenamingTaskId(null);
    setRenameDraft("");
  };

  // [契约] 快照用于缓存变更的 previousTask：优先用最新的 meta 构造，
  // 缺失时用服务返回的任务 + 当前标题刚改前的值，保证 before/after 可对比。
  // overrides 只在需要还原旧标题时使用，不能拿它伪造其它字段。
  const buildHeaderTaskSnapshot = (
    fallbackTask: ZCodeTaskMeta,
    overrides?: Partial<ZCodeTaskMeta>,
  ): ZCodeTaskMeta => {
    if (activeTaskMeta) {
      return {
        ...activeTaskMeta,
        ...overrides,
      };
    }

    return {
      ...fallbackTask,
      title: activeTaskTitle ?? fallbackTask.title,
      ...overrides,
    };
  };

  // [契约] 提交前先判空、再判“是否真的改了”，两条短路都不能省：
  // 没有 id 时服务必然失败；标题未变时的写入会污染 updated 排序。
  // 成功后先更新乐观列表再改查询缓存，顺序反了会让列表短暂回到旧标题。
  // 失败只 toast 不清草稿，用户可以修改后重试。
  const handleSubmitRenameTask = async () => {
    if (!renamingTaskId) {
      return;
    }

    // 比较用 trim 后的值，但提交时也提交 trim 后的值；
    // 只 trim 比较会让“标题带空格”被判为无变化而永远改不掉。
    const normalizedTitle = renameDraft.trim();
    // [契约] 提交时的“当前标题”必须与打开弹窗时的初值同源，
    // 否则用户不改也会被判定为已修改，产生无意义写入。
    const currentTitle = activeTaskMeta?.title ?? activeTaskTitle ?? "";
    if (normalizedTitle === currentTitle.trim()) {
      // [契约] 标题未变视为无操作：直接走取消路径，不调用服务也不发 toast。
      handleCancelRenameTask();
      return;
    }

    try {
      // [契约] workspaceIdentity 只在存在时展开：显式传 undefined 会被下游当成“来自本地”，
      // 条件展开是保持远程身份语义的必要写法。
      const renamedTask = await services.zcodeTaskService.renameTask({
        taskId: renamingTaskId,
        workspacePath: workspaceAbsPath,
        title: normalizedTitle,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      // [契约] 先用服务返回的任务覆盖乐观项，再改查询缓存；
      // 顺序反了会用旧标题做 previousTask，缓存 diff 计算出错误的下一状态。
      upsertOptimisticTaskListItem(workspaceAbsPath, renamedTask, workspaceIdentity);
      applyTaskQueryCacheMutation({
        previousTask: buildHeaderTaskSnapshot(renamedTask, {
          title: currentTitle,
        }),
        nextTask: renamedTask,
        previousState: { pinned: isPinned, archived: false },
        nextState: { pinned: isPinned, archived: false },
      });
      // [契约] 成功后关闭弹窗必须在缓存写入之后：先关闭会让弹窗卸载与列表更新竞争，
      // 用户会看到标题闪回旧值再变新值。
      // 失败路径刻意不调用它，保留草稿供重试。
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  };

  // [契约] 归档是破坏性动作，必须走与侧边栏一致的二次确认；
  // 描述里要带上任务标题，让用户在确认框里能核对自己点的是哪一个。
  // `onCancelConfirm` 不得顺手做清理：取消改名属另一动作。
  // 归档链路复用 zcodeTaskService，不在这里直接改 store 或缓存。
  const handleArchiveTask = async () => {
    // [契约] 事件回调里再做一次 id 判空：UI 禁用只是提示，不能代替入口守卫。
    if (!resolvedTaskActionTaskId) {
      return;
    }

    // Header 更多菜单之前点击“归档任务”会直接执行，
    // 和 Sidebar 的二次确认心智不一致，用户容易在查看菜单时误触归档。
    // 这里统一先走现成 ConfirmDialog，再复用原有归档链路。
    // 标题文案回落用 meta.title → 入参标题 → 未命名，保证确认框永远有可读名称。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "confirmDialog.taskArchiveTitle" }),
      description: intl.formatMessage(
        { id: "confirmDialog.taskArchiveDescription" },
        {
          taskTitle:
            activeTaskMeta?.title?.trim() ||
            activeTaskTitle?.trim() ||
            intl.formatMessage({ id: "taskList.untitled" }),
        },
      ),
      confirmLabel: intl.formatMessage({ id: "taskList.archive" }),
    });
    // [失败路径] 未确认直接返回，且不关闭任何正在进行的编辑态。
    if (!confirmed) {
      return;
    }

    handleCancelRenameTask();
    // [契约] 归档用 void + then 而不是 await：函数返回时不应阻塞渲染，
    // 但成功回调里必须同步清理运行态与列表缓存，二者缺一都会出现幽灵任务。
    void services.zcodeTaskService
      .archiveTask({
        taskId: resolvedTaskActionTaskId,
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((meta) => {
        // Header 更多菜单不能只依赖 zcodeTaskMetaMerge：归档后只有旧列表状态被更新。
        // 这里改成和 Sidebar 一样同步清理运行态与 sqlite cache，避免 Header 操作后列表不刷新。
        removeTaskState(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
        applyTaskQueryCacheMutation({
          previousTask: buildHeaderTaskSnapshot(meta),
          nextTask: meta,
          previousState: { pinned: isPinned, archived: false },
          nextState: { pinned: false, archived: true },
        });
      });
  };

  return (
    <div
      className={cn(
        // 标题区必须按内容占宽，不能 flex-1 铺满整条 header。
        // 父级 header 是 drag 区域；如果 no-drag 的标题区铺满剩余空间，mac/Windows 标题栏空白处会无法拖动窗口。
        "flex min-w-0 items-center gap-2 overflow-hidden [app-region:no-drag]",
        simplifyForNarrowRemote && "max-md:gap-1",
      )}
    >
      <TaskRenameDialog
        open={!isDraftNewTask && renamingTaskId !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelRenameTask();
          }
        }}
        onChange={setRenameDraft}
        onCancel={handleCancelRenameTask}
        onConfirm={() => {
          void handleSubmitRenameTask();
        }}
      />
      {!isDraftNewTask || isRemoteWorkspace ? (
        <ControlHintTooltip
          open={workspaceContextOpen}
          onOpenChange={setWorkspaceContextOpen}
          side="bottom"
          align="start"
          className="w-72 items-start border-popover-border bg-popover p-3 text-popover-foreground shadow-md [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:text-ui-base [&>span:first-child]:text-popover-foreground"
          title={
            <span
              data-workspace-header-context-info=""
              className="flex w-full min-w-0 flex-col gap-3 text-left"
            >
              <span className="flex min-w-0 items-start gap-2">
                {isRemoteWorkspace ? (
                  <RemoteConnectionStateIcon presentation={presentation} project />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceContextLabel}
                  </span>
                  {isRemoteWorkspace ? (
                    <span className="inline-flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full bg-surface py-px pl-1.5 pr-2 text-ui-sm font-normal text-foreground-subtle">
                      <span className={cn("size-1.5 shrink-0 rounded-full", presentation.dot)} />
                      <span className="truncate">{remoteDeviceName}</span>
                      {presentation.status !== "online" ? (
                        <span>
                          {presentation.recovery
                            ? intl.formatMessage(
                                { id: presentation.recovery.messageId },
                                presentation.recovery.values,
                              )
                            : intl.formatMessage({ id: presentation.shortMessageId })}
                    </span>
                  ) : null}
                    </span>
                  ) : null}
                  {workspaceContextOpen && isRemoteWorkspace ? (
                    <span
                      data-workspace-context-path=""
                      className="break-all font-mono text-ui-sm text-foreground-subtle"
                    >
                      {workspaceAbsPath}
                    </span>
                  ) : workspaceContextOpen ? (
                    <WorkspaceContextPath
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={remoteSessionId}
                    />
                  ) : null}
                </span>
              </span>
              {workspaceContextOpen ? (
                <WorkspaceLastActivity
                  task={activeTaskMeta?.taskId === activeTaskId ? activeTaskMeta : null}
                />
              ) : null}
              {workspaceBranchLabel ? (
                <span className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-3 font-normal">
                  <GitBranch className="size-4 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceBranchLabel}
                  </span>
                </span>
              ) : null}
            </span>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size={isRemoteWorkspace ? "sm" : compact ? "icon-sm" : "icon-md"}
            className={
              isRemoteWorkspace
                ? "min-w-0 max-w-40 gap-1.5 px-1.5 text-foreground-subtle"
                : undefined
            }
            data-testid={TID_WORKSPACE_PATH}
            // 上下文信息改为 tooltip 承载后，这个按钮不再有 DOM title；工作区绝对路径
            // 是 e2e 判定“header 属于哪个工作区”的唯一锚点（aria-label 只有显示名），
            // 因此单独用数据属性暴露，避免和 tooltip 争抢原生提示。
            data-workspace-abs-path={workspaceAbsPath}
            aria-description={isRemoteWorkspace ? remoteStatusLabel : undefined}
            aria-label={[workspaceContextLabel, workspaceBranchLabel].filter(Boolean).join(" · ")}
            onClick={() => setWorkspaceContextOpen(true)}
          >
            {isRemoteWorkspace ? (
              <>
                <RemoteConnectionStateIcon presentation={presentation} project />
                <span data-workspace-device-name="" className="min-w-0 truncate text-ui-sm">
                  {remoteDeviceName}
                </span>
              </>
            ) : (
              <Folder className="size-4 text-foreground-subtle" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {!isDraftNewTask ? (
      <h1
        data-testid={TID_WORKSPACE_TITLE}
        className={cn(
          "flex min-w-12 max-w-100 shrink items-center gap-2 truncate font-semibold text-foreground @max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]",
          simplifyForNarrowRemote && "max-md:max-w-[42vw]",
          compact ? "text-[0.92rem]" : "text-ui-base",
        )}
        title={activeTaskTitle}
      >
        <span className="min-w-0 truncate">{activeTaskTitle}</span>
        {/* {activeTaskChangeSummary ? (
          <>
            {activeTaskChangeSummary.added > 0 ? (
              <span className="text-diff-added">
                +{activeTaskChangeSummary.added}
              </span>
            ) : null}
            {activeTaskChangeSummary.removed > 0 ? (
              <span className="text-diff-removed">
                -{activeTaskChangeSummary.removed}
              </span>
            ) : null}
          </>
        ) : null} */}
      </h1>
      ) : null}
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {!isDraftNewTask ? (
          <DropdownMenu open={taskMenuOpen} onOpenChange={setTaskMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size={compact ? "icon-sm" : "icon-md"}
                data-testid={TID_WORKSPACE_MORE_BUTTON}
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {showRemoteSkillSyncAction && remoteTarget ? (
                <>
                  <RemoteSyncMenuItems
                    canSyncSkills
                    canSyncMcp
                    canSyncPlugins
                    onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
                    onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
                    onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
                  />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <TaskActionMenuContent
                intl={intl}
                isPinned={isPinned}
                fileManagerLabel={fileManagerLabel}
                taskSessionFile={taskSessionFile}
                activeSessionId={activeSessionId}
                taskNativeSessionLogFile={taskNativeSessionLogFile}
                providerConfigFile={providerConfigFile}
                disableTaskTargetActions={disableTaskTargetActions || taskMenuMembershipLoading}
                disableTaskActions={Boolean(readOnlyReason)}
                disabledReason={readOnlyReason}
                disablePinTaskAction={taskMenuMembershipLoading}
                hideMobileUnsupportedActions={simplifyForNarrowRemote}
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                onTogglePinTask={() => {
                  // [契约] 未读回调用的是解析后的 taskId：fork 场景下菜单闭包里的 activeTaskId 可能是父任务，
                  // 写错会把红点标到另一个任务上。
                  // 无 id 时直接返回而不 toast：草稿态按钮本就不可用，提示只会制造噪音。
                  // 随后的 setTaskUnreadIndicator 必须在服务成功分支里调用，不能提前。
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  // [并发] 乐观更新只改缓存，不改服务；失败时用同一个快照反向写回。
                  // 没有 meta 时不做乐观更新——缺少完整任务对象，构造出来的行会被列表拒绝。
                  const optimisticTask = activeTaskMeta ?? null;
                  if (optimisticTask) {
                    applyTaskQueryCacheMutation({
                      previousTask: optimisticTask,
                      nextTask: optimisticTask,
                      previousState: { pinned: isPinned, archived: false },
                      nextState: { pinned: !isPinned, archived: false },
                    });
                  }
                  // [并发] pin 走乐观更新：先改缓存再发请求，成功用服务返回的 meta 校正，
                  // 失败回滚到点击前状态；三条路径都不能省。
                  void services.zcodeTaskService
                    .setTaskPinned({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      pinned: !isPinned,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      removeOptimisticTaskListItem(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        workspaceIdentity,
                      );
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: !isPinned, archived: false },
                        nextState: { pinned: !isPinned, archived: false },
                      });
                    })
                    // [失败路径] 失败必须回滚 pinned 并 toast，且回滚用上一次的状态而不是取反：
                    // 取反在重复点击时会把错误状态带回来。
                    .catch(() => {
                      if (optimisticTask) {
                        applyTaskQueryCacheMutation({
                          previousTask: optimisticTask,
                          nextTask: optimisticTask,
                          previousState: { pinned: !isPinned, archived: false },
                          nextState: { pinned: isPinned, archived: false },
                        });
                      }
                      toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                    });
                }}
                onStartRenameTask={handleStartRenameTask}
                onArchiveTask={() => {
                  void handleArchiveTask();
                }}
                onMarkTaskAsUnread={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  // [契约] 标记未读要同时写服务、运行态标记、乐观列表与查询缓存四处；
                  // 少写运行态会让红点在切换任务后消失。
                  void services.zcodeTaskService
                    .setTaskUnread({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      unread: true,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    // [契约] 服务返回的 meta 才是最终事实，必须用它构造 nextTask 与 nextState；
                    // 用本地推测值会在服务端规范化（如 unread 合并）后产生缓存漂移。
                    .then((meta) => {
                      setTaskUnreadIndicator(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        true,
                        workspaceIdentity,
                      );
                      upsertOptimisticTaskListItem(workspaceAbsPath, meta, workspaceIdentity);
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: isPinned, archived: false },
                        nextState: { pinned: isPinned, archived: false },
                      });
                    });
                }}
                onOpenTaskFeedback={() => {
                  void handleOpenTaskFeedback();
                }}
                onOpenTaskPathInFileManager={() => {
                  void handleOpenTaskPathInFileManager();
                }}
                onCopyWorkspacePath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyPath" }),
                    workspaceAbsPath,
                  );
                }}
                onCopyTaskPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyTaskPath" }),
                    taskSessionFile.path,
                  );
                }}
                onCopyTaskLogPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyLogPath" }),
                    taskNativeSessionLogFile.path,
                  );
                }}
                onCopySessionId={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copySessionId" }),
                    activeSessionId,
                  );
                }}
                onViewModelTrajectory={
                  resolvedTaskActionTaskId
                    ? () => {
                        useModelTrajectoryStore.getState().requestOpen({
                          taskId: resolvedTaskActionTaskId,
                          workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
                          title: activeTaskMeta?.title ?? null,
                        });
                      }
                    : undefined
                }
                onOpenProviderConfig={() => {
                  void handleOpenProviderConfig();
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <RemoteSyncDialogs
          canSyncSkills={showRemoteSkillSyncAction}
          canSyncMcp={showRemoteSkillSyncAction}
          canSyncPlugins={showRemoteSkillSyncAction}
          skillOpen={remoteSkillSyncOpen}
          mcpOpen={remoteMcpSyncOpen}
          pluginOpen={remotePluginSyncOpen}
          onSkillOpenChange={setRemoteSkillSyncOpen}
          onMcpOpenChange={setRemoteMcpSyncOpen}
          onPluginOpenChange={setRemotePluginSyncOpen}
          localSkillSyncService={baseServices.skillSyncService}
          remoteSkillSyncService={services.skillSyncService}
          localMcpSyncService={baseServices.mcpSyncService}
          remoteMcpSyncService={services.mcpSyncService}
          localPluginSyncService={baseServices.pluginSyncService}
          remotePluginSyncService={services.pluginSyncService}
          localZCodeAgentService={baseServices.zcodeAgentService}
          remoteZCodeAgentService={services.zcodeAgentService}
          remoteTarget={remoteTarget}
          skillWorkspacePath={workspaceAbsPath}
          mcpWorkspacePath={workspaceAbsPath}
          pluginWorkspacePath={workspaceAbsPath}
          pluginLocalWorkspacePath={localWorkspacePath}
          mcpLocalWorkspacePath={localWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSkillsSynced={async () => {
            // [契约] 同步 skill 后必须先失效延迟草稿会话，再刷新 store；
            // 顺序反了会出现“列表已更新、旧草稿仍绑定旧 skill”的窗口。
            // reason 字段用于日志归因，取值固定为 header-remote-skill-sync。
            await invalidateDeferredDraftSessionForSkillChange({
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              reason: "header-remote-skill-sync",
            });
            await refreshSharedSkillStoreForWorkspace({
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              skillsService: services.skillsService,
            });
          }}
          onMcpSynced={async () => {
            // [契约] MCP 同步后强制 ensureLoadedForWorkspace 并传入远端同步服务：
            // 不传服务会让 store 回落到本地实现，读到未同步的旧清单。
            await useMcpStore
              .getState()
              .ensureLoadedForWorkspace(
                workspaceAbsPath,
                services.mcpSyncService,
                workspaceIdentity,
              );
          }}
          onPluginsSynced={async () => {
            // [契约] 插件同步后要重建能力清单（commands/mcp/skills 一起）：
            // 只刷新插件列表会让新插件声明的命令不可用，直到下次重启。
            // reason 同样用于日志归因，不能省略。
            await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
              commandsService: services.commandsService,
              mcpSyncService: services.mcpSyncService,
              reason: "header-remote-plugin-sync",
              skillsService: services.skillsService,
              workspaceIdentity,
              workspacePath: workspaceAbsPath,
              zcodeAgentService: services.zcodeAgentService,
            });
          }}
        />
        {!isDraftNewTask && workspaceActionLoading ? (
          <ControlHintTooltip
            title={workspaceActionLoadingTitle}
            side="bottom"
            align="start"
            className="max-w-84 items-start px-2 py-1.5"
          >
            <span
              role="img"
              aria-label={workspaceActionLoadingTitle}
              className={cn(
                "inline-flex items-center justify-center rounded-full text-foreground-subtle",
                compact ? "size-6" : "size-7",
              )}
            >
              <LoaderIcon className={cn("animate-spin", compact ? "size-3.5" : "size-4")} />
            </span>
          </ControlHintTooltip>
        ) : null}
      </div>
    </div>
  );
}
