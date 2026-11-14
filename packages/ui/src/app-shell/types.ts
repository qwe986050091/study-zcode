// App Shell 类型契约：只声明 Shell 与 Root、桌面/Web 入口之间的数据形状。
// 本文件无运行时代码，任何改动都会同时波及 Desktop、Web 与远程控制三个入口。
// 字段可空性即协议：可选代表调用方可省略，必选代表入口必须给出真值。
// 跨包类型只从 @zcode/shared、@zcode/services 公开入口引入，禁止深链实现。
// INV-01 服务访问统一走 IServiceAccessor；守住位置：AppProps.services；改错故障：组件直取服务导致 Web 端注入缺失。
// INV-02 反馈服务由外层注入而非自建；守住位置：AppProps.baseFeedbackService；改错故障：双份反馈状态与提示重复弹出。
// INV-03 未知失败用 unknown 而非 any；守住位置：CreateTaskOptions.onError；改错故障：吞掉非 Error 抛出后错误静默。
// INV-04 创建请求允许裸 provider 简写；守住位置：CreateTaskRequest；改错故障：旧调用点全部编译失败。
// INV-05 发起方租约是可选中断点；守住位置：CreateTaskOptions.isCurrent；改错故障：取消后仍导航到废弃任务。
// INV-06 异步预填必须绑定目标 key；守住位置：CreateTaskOptions.expectedWorkspaceKey；改错故障：mention 落到另一个项目。
// INV-07 预填文本只写草稿；守住位置：CreateTaskOptions.initialPrompt；改错故障：新建任务被自动发送。
// INV-08 草稿交接不落盘；守住位置：CreateTaskOptions.initialComposerDraft；改错故障：跨进程序列化草稿泄漏。
// INV-09 任务组仅表分组；守住位置：CreateTaskOptions.taskGroupId；改错故障：把分组当成执行目录。
// INV-10 恢复状态区分自动与手动；守住位置：RemoteWorkspaceRecoveryStatus.mode；改错故障：手动重试被自动流程覆盖。
// INV-11 尝试次数与上限成对出现；守住位置：attempt 与 limit；改错故障：无上限重连形成死循环。
// INV-12 设备添加结果封闭为两类；守住位置：DeviceAdditionResult.kind；改错故障：新增分支时穷尽检查失效。
// INV-13 返回值导航需原 owner 复核；守住位置：DeviceAdditionReturnTarget.canFinish；改错故障：成员资格失效仍回跳。
// INV-14 可见性回调只传布尔；守住位置：onVisibilityChange 入参；改错故障：把连接层内部状态透给业务。
// INV-15 完成意图不可被安装重试改写；守住位置：RemoteConnectionOpenPreference.completion；改错故障：弹窗流程漂移到别的入口。
// INV-16 失败事实在交接时冻结；守住位置：initialFailure.failedTarget；改错故障：按最新 Profile 重建出误导目标。
// INV-17 已保存项目优先恢复入口；守住位置：preferredProjectEntryId；改错故障：用户被拽进新建项目向导。
// INV-18 布局属性继承 AppProps 但剔除反馈服务；守住位置：WorkspaceShellLayoutProps；改错故障：反馈服务被两处重复传递。
// INV-19 主视图为有限字面量集合；守住位置：WorkspaceMainView；改错故障：新增视图漏改路由分支。
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import type { ComposerDraftHandoff } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import type { RefObject } from "react";
import type {
  ZCodeProvider,
  SessionCreateSource,
  ZCodeTaskRuntimeStatus,
  ZCodeTaskMeta,
  GitChangeSourceId,
  DesktopWindowChromeState,
  IPlatformService,
  RemoteTarget,
  SourceServerUpdateTarget,
  RemoteWorkspaceSessionEntry,
  UpdateStatePayload,
  UserInfo,
} from "@zcode/shared";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type {
  BrowserSidePaneMetadata,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { Theme } from "@/useTheme.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import type { AutomationsNavigationTab, OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { SidePaneFullViewController } from "@/side-pane-full-view/contract.js";

// 壳层投影：只从 store 切片取展示所需字段，不持有第二份会话真相。
// 字段全部复用 WorkspaceZCodeUIState 的下标类型，保持 store 改动可传导。
// taskError 用 null 表示无错误，避免空串与未设置两种含义混淆。
// 该投影缺失字段时失败在渲染期，不会静默降级成旧值。
// 新增字段须同步 store 选择器，否则壳层读到的永远是 undefined。
export interface WorkspaceShellZCodeState {
  activeTaskId: WorkspaceZCodeUIState["activeTaskId"];
  draftFocusVersion: WorkspaceZCodeUIState["draftFocusVersion"];
  modelSwitchPending: WorkspaceZCodeUIState["modelSwitchPending"];
  modelSwitchStage: WorkspaceZCodeUIState["modelSwitchStage"];
  selectedProvider: WorkspaceZCodeUIState["selectedProvider"];
  optimisticTaskListByTaskId: WorkspaceZCodeUIState["optimisticTaskListByTaskId"];
  workspaceInit: WorkspaceZCodeUIState["workspaceInit"];
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

// 全部字段可省略：调用点只传自己关心的意图，其余由 Root 补默认值。
// 回调三兄弟语义互斥：完成只报成功，错误只报失败，二者不得同时触发。
// 目标 workspace 缺省取活动项，显式传入时以显式值为准。
// 结构化的 targetWorkspace 让远程与本地走同一条准备路径。
// draftId 用于幂等准备，不参与 session 身份，避免草稿与任务混淆。
// 省略 provider 时沿用当前选择，不能推断成客户端内置默认。
export interface CreateTaskOptions {
  /** Renderer 发起方租约；异步准备期间取消或换草稿后不得导航。 */
  isCurrent?: () => boolean;
  remoteProjectMembershipId?: string;
  /** 只在目标准备和新草稿导航完成后通知发起界面；不自动发送。 */
  onComplete?: () => void;
  onError?: (error: unknown) => void;
  /** 异步预填只能提交到解析 Skill 时的同一新任务目标。 */
  expectedWorkspaceKey?: string;
  provider?: ZCodeProvider;
  projectId?: string | null;
  /** 未归类任务目录准备的幂等身份，不作为 session 身份。 */
  draftId?: string;
  /** 仅分组组织意图，不决定执行项目或 cwd。 */
  taskGroupId?: string | null;
  hostId?: string;
  createSource?: SessionCreateSource;
  /** 新草稿输入框预填文本；只写草稿，不自动发送。 */
  initialPrompt?: string;
  /** 创建项目后的当前草稿交接，仅在 renderer 内存中传递。 */
  initialComposerDraft?: ComposerDraftHandoff;
  /** 与 initialPrompt canonical 前缀对应的结构化 mention；仅用于编辑器展示。 */
  initialPromptMention?: ComposerMentionPrefill;
  /** 新任务落在哪个 workspace；缺省取活动 workspace。 */
  targetWorkspace?: {
    projectId?: string | null;
    hostId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

// 纵向简写：老代码传 provider 字符串，新代码传完整选项对象。
// 判别交给运行时形状，不做字符串与对象的混合假设。
// 收紧成只允许对象会破坏调用点，保持联合是为了渐进迁移。
export type CreateTaskRequest = ZCodeProvider | CreateTaskOptions;

// 模式是必选的，渲染文案与按钮可用性都依赖它。
// attempt 与 limit 同生同灭，只给一个会让进度展示矛盾。
// 该结构只用于展示，不回流到 Host 的恢复协议。
export interface RemoteWorkspaceRecoveryStatus {
  mode: "automatic" | "manual";
  attempt?: number;
  limit?: number;
}

/** 仅用于 Renderer 连接反馈，不传入 Host 的恢复/遥测协议。 */
// 仅影响 Renderer 的连接提示文案，不改变连接本身的行为。
// 省略 announceReusedConnection 时按不复用提示处理。
export interface RemoteConnectionFeedbackOptions {
  announceReusedConnection?: boolean;
}

// 判别联合：kind 决定后续是回到项目页还是回设置页。
// connected 分支保留 sourceServerId 的可空语义，未连接时为空。
// cancelled 分支的 background 表示取消发生在后台步骤。
// 两个分支不含凭据，可安全穿过 renderer 内存。
// 新增分支必须同步所有 switch 消费点，否则编译期即可发现遗漏。
export type DeviceAdditionResult =
  | { kind: "connected"; sourceServerId: string | undefined }
  | { kind: "cancelled"; background?: boolean };

/** 仅当前 renderer 内存中的原 owner 引用；不序列化草稿或凭据。 */
// 该对象只在当前 renderer 内存存活，刷新即失效。
// kind 区分连接已有设备与新增设备两种入口意图。
// finish 允许同步或异步实现，调用方不得假设时序。
// canFinish 返回 Promise，因为成员资格校验要走远程。
export interface DeviceAdditionReturnTarget {
  /** 已有设备连接留在原项目页；只有新增设备往返设置。 */
  kind: "connect-device" | "add-device";
  isCurrent(): boolean;
  /** 只投递连接层可见性；原 owner 决定自己的提交门禁。 */
  onVisibilityChange?(visible: boolean): void;
  /** 返回导航前由原 owner 校验异步成员资格；Root 随后重验原意图。 */
  canFinish?(result: DeviceAdditionResult): Promise<boolean>;
  finish(result: DeviceAdditionResult): void | Promise<void>;
}

// 所有字段可选：入口只提供自己确知的上下文，其余留给弹窗默认。
// preferredKind 与 preferredTarget 可同时出现，前者用于早期分流。
// preferredProfileId 精确到某条连接记录，消费后直达对应步骤。
// initialFailure 内的字段在交接时固定，不从最新状态重建。
// resolvedWslTarget 用 Required 收窄，避免下游反复判空。
// 该结构不承载凭据，凭据由连接层自己持有。
export interface RemoteConnectionOpenPreference {
  returnTarget?: DeviceAdditionReturnTarget;
  /** 完成意图由发起入口确定；凭据、安装和重试不得替换它。 */
  completion?: "device-management";
  /** 原地重连交接的失败/等待事实；打开时只展示，不自动重发。 */
  initialFailure?: {
    code?: string;
    message: string;
    logs?: RemoteConnectionLogEntry[];
    profileId?: string;
    /** 交接前固定的非敏感失败身份，不从最新 Profile 重建。 */
    failedTarget?: SourceServerUpdateTarget;
    resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
  };
  /** 已有项目的连接意图；安装、升级和凭据交互结束后仍打开该目录。 */
  preferredDirectoryPath?: string;
  preferredWorkspaceTabId?: string;
  /** 未加载 tab 的已保存项目；完成后恢复该入口，不进入新建项目选择。 */
  preferredProjectEntryId?: string;
  preferredTarget?: RemoteTarget;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  /** 用户从设备/连接记录点击“连接”时精确选择的 Profile；弹窗消费后直达第 4 步。 */
  preferredProfileId?: string;
}

// 壳层与 Root 的契约：回调由 Root 提供，壳层只调用不实现。
// 远程相关回调多为可选，未接入远程的入口可整体省略。
// AppProps 的必选回调缺失属装配错误，应在启动期暴露而非点击时崩溃。
// user 可为 null，表示已登出或尚未取到用户信息。
// 三个 is 开头的桌面标志互不排斥，Web 环境下同时为假。
// supportsEmbeddedBrowser 由入口能力决定，不由平台名字推断。
// 按 workspaceKey 索引的错误与恢复状态必须同构，键的生成规则由调用方统一。
// AppProps 只暴露 IServiceAccessor，不泄漏实现类型以保持跨入口可编译。
export interface AppProps {
  services: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceRecoveryByWorkspaceKey?: Record<string, RemoteWorkspaceRecoveryStatus>;
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;

  remoteConnectionLogs?: RemoteConnectionLogEntry[];
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask?: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  /** 解析“在项目外工作”的目标；identity 由 Root 按 Source 归属给出，Shell 不得按路径反查。 */
  onResolveConversationWorkspace?: () => Promise<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  onOpenWorkspace: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void | boolean;
  remoteConnectionInProgress?: boolean;
  onReturnToWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: import("@zcode/shared").WebRemoteControlMobileNavigationIntent;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  workspaceAbsPath: string;
  workspaceRemoteSessionId?: string;
  workspaceIdentity?: string;
  isWorkspaceVisible?: boolean;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  supportsEmbeddedBrowser?: boolean;
}

// 行数统计只用于展示，负数在消费端视为无意义数据。
// added 与 removed 分别累计，不能预先把净变化算好。
export interface GitChangeSummary {
  added: number;
  removed: number;
}

// WorkspaceMainView 是有限字面量集合，新增值必须同时补齐导航与持久化。
// 切换 WorkspaceMainView 不销毁会话，只改壳层渲染分支。
// 缺省 WorkspaceMainView 由调用方决定，此处不预设顺序。
export type WorkspaceMainView = "chat" | "automations" | "plugin-store";

// 布局层在 AppProps 基础上剔除反馈服务，避免同一服务两条注入路径。
// 只读原因非空时，所有写操作入口都应按禁用渲染。
// 深链字段成对出现：打开目标与消费回调必须同时提供。
// shellPanelIds 的顺序即面板渲染顺序，不做二次排序。
// toggleSidebarShortcutLabel 等标签由平台层格式化，壳层不拼接按键。
// ReturnType 引用 hooks 的返回类型，保证与 hook 实现同步。
// isSidebarVisible 与 isTerminalOpen 是受控布尔，壳层不维护本地副本。
export interface WorkspaceShellLayoutProps extends Omit<AppProps, "baseFeedbackService"> {
  workspaceReadOnlyReason?: string;
  workspaceMainView: WorkspaceMainView;
  pluginStoreOpenVersion: number;
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  /** 中枢深链：落到某个已保存工作流的详情页；定位后由 `onOpenWorkflowConsumed` 清空。 */
  openWorkflow: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed: () => void;
  /**
   * 完成卡「已保存」芯片 → 中枢那一页（docs/dynamic-workflow/transcript-and-notifications.md
   * 「Saving the run, and running it again」）：切到自动化主视图的「工作流」标签并设深链。
   */
  onOpenSavedWorkflowInHub: (target: SavedWorkflowHubTarget) => void;
  onWorkspaceMainViewChange: (view: WorkspaceMainView) => void;
  onOpenAutomationConsumed: () => void;
  handleOpenAutomations: OpenAutomationsMain;
  handleOpenPluginStore: () => void;
  workspaceShellZCodeState: WorkspaceShellZCodeState;
  theme: Theme;
  isMacFullscreen: boolean;
  desktopWindowChromeState: DesktopWindowChromeState | null;
  macWindowControlsLeftPaddingPx: number;
  windowsWindowControlsRightPaddingPx: number;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  sidebarContainerRef: RefObject<HTMLElement | null>;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  toggleSidePaneShortcutLabel: string;
  /** 「进入 / 退出完整视图」快捷键标签（仅桌面）。 */
  toggleSidePaneFullViewShortcutLabel?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  isTerminalOpen: boolean;
  isSidebarVisible: boolean;
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser: boolean;
  isGitOpen: boolean;
  isSidePaneOpen: boolean;
  /** Side Pane 完整视图控制器（仅桌面；spec：docs/ui/side-pane-full-view.md）。 */
  sidePaneFullView?: SidePaneFullViewController;
  summaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  shellPanelIds: string[];
  projectName: string;
  workspaceTabs: Array<{
    workspacePath: string;
    label: string;
    remoteSessionId?: string;
    remoteTarget?: import("@zcode/shared").RemoteTarget;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    localWorkspacePath?: string;
    availability?: import("@/store/tabStore.js").WorkspaceAvailability;
  }>;
  activeTaskId: string | null;
  /** 右侧栏的正式会话归属 ID；草稿为空，不复制 pane 内部预热 session。 */
  sidePaneOwnerId: string | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  activeTaskTitle: string;
  activeTaskChangeSummary: ReturnType<
    typeof import("@/lib/taskChangeSummary.js").getTaskChangeSummary
  >;
  gitWorktreeReviewSourceId: GitChangeSourceId | null;
  gitWorktreeChangeSummary: GitChangeSummary;
  activeGitSourceId: GitChangeSourceId;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  providerConfigFile: ReturnType<
    typeof import("@/hooks/useWorkspaceProviderConfigFile.js").useWorkspaceProviderConfigFile
  >;
  taskNativeSessionLogFile: ReturnType<
    typeof import("@/hooks/useTaskNativeSessionLogFile.js").useTaskNativeSessionLogFile
  >;
  taskSessionFile: ReturnType<
    typeof import("@/hooks/useTaskSessionFilePath.js").useTaskSessionFilePath
  >;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  conversationFindQuery: string;
  onConversationFindMatchStateChange: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  appLogoUrl: string;
  platform: IPlatformService;
  reloadSessionDisabled: boolean;
  reloadSessionPending: boolean;
  handleReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => Promise<void>;
  handleSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  handleTaskNavBack: () => void;
  handleTaskNavForward: () => void;
  handleStartDraftInWorkspace: (
    targetWorkspacePath: string,
    targetWorkspaceIdentity?: string,
    targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
    createSource?: SessionCreateSource,
  ) => void;
  handleOpenCommandCenter: () => void;
  handleRefreshGit: () => void;
  handleBrowserUrlChange: (tabId: string, url: string) => void;
  handleBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  handleToggleSidebar: () => void;
  handleToggleTerminal: () => void;
  handleToggleBrowser: () => void;
  handleOpenBrowserTab: () => void;
  handleOpenBrowserPermissionSettings: (origin: string) => void;
  handleOpenWhiteboard: () => void;
  handleOpenDeveloperTools: () => void;
  handleOpenFileManager: (target?: FileManagerTarget) => void;
  handleNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  handleOpenPluginMarket: () => void;
  handleOpenTerminalTab: () => void;
  handleToggleGit: () => void;
  handleOpenGitReview: (sourceId?: GitChangeSourceId) => void;
  handleToggleSidePane: () => void;
  handleOpenBrowserUrl: (url: string) => void;
  handleOpenCodeViewer: (source: CodeViewerSource) => void;
  handleAutoOpenAssistantPptx: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  handleOpenBackgroundBash: (request: OpenBackgroundBashSideTabRequest) => void;
  handleOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  handleOpenSubagentDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedSubagentDirectorySideTabRequest,
  ) => void;
  handleSyncSubagentSessionTabs: (
    request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest,
  ) => void;
  handleOpenSelectionSideChat: (request: OpenSelectionSideChatRequest) => void;
  handleOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  handleOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  handleOpenWorkflowRunDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedWorkflowRunDirectorySideTabRequest,
  ) => void;
  handleOpenWorkflowActorSession: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  handleOpenWorkflowWorkspace: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  handleOpenWorkflowArtifact: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  handleCloseCodeViewer: () => void;
  handleCloseGit: () => void;
  handleOpenNewSidePaneTab: () => void;
  handleActivateSidePaneTab: (tabId: string) => void;
  handleReorderSidePaneTab: (activeTabId: string, overTabId: string) => void;
  handleCloseSidePaneTab: (tabId: string) => void;
  handleCloseOtherSidePaneTabs: (tabId: string) => void;
  handleCloseAllSidePaneTabs: () => void;
  handleReopenClosedSidePaneTab: (tabId: string) => void;
  handleBrowserNavigationRequestHandled: (requestId: string) => void;
  setIsTerminalOpen: (open: boolean) => void;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  taskFindDialogProps: TaskFindDialogProps;
}
