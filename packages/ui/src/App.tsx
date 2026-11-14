// 工作区应用外壳（App）：把 Root 传入的 workspace 描述、全局 store 与平台能力组装成
// WorkspaceShellLayout 所需的全部 props；本文件不承载业务状态，只做「状态选择、派生与写入口闩锁」。
// 改这里任何一行都可能同时影响桌面、Web、手机远控三个宿主。
//
// 不变量（INV）：
// INV-01 workspace RPC 目标优先级固定为 activeTab → 显式 workspaceIdentity → 显式
//   remoteSessionId（守住它的位置：workspaceRpcTarget 赋值处）。顺序反转时，Settings tab
//   覆盖 workspace 会把远程路径当成本地 base workspace 预热。
// INV-02 只读 workspace 的所有写入口必须经过 *IfWritable 包装（守住它的位置：
//   handleCreateTaskIfWritable / handleToggleTerminalIfWritable / handleOpenGitIfWritable 等）。
//   漏一个就会出现「按钮已灰但快捷键还能改仓库」。
// INV-03 draftFocusVersion 从 0 递增表示「又新建了一次草稿」，必须收起右侧面板（守住它的
//   位置：draftFocusVersion effect）。新建任务不会重建 side pane，不收起会让旧面板盖住新草稿。
// INV-04 草稿收起记账必须是 (workspaceKey, draftFocusVersion) 二元组（守住它的位置：
//   lastHandledDraftSidePaneCloseRef）。只记版本号会让切换 workspace 后的首个草稿被误判为已处理。
// INV-05 Git 真实命令只由 workspace 切换、Git pane 打开、显式刷新触发；task 切换不得重拉
//   （守住它的位置：useGitRepository 的 refreshToken）。否则每次流式 turn 都扫一遍仓库。
// INV-06 各 Git 来源的 +/- 只算一次（守住它的位置：gitChangeSummaryBySourceId），
//   header 与 Git pane 必须共用；各自计算会在来源切换时出现两个不同数字。
// INV-07 review 打开来源优先级 unstaged > staged > null（守住它的位置：
//   gitWorktreeReviewSourceId）。反过来会把已暂存改动当成未暂存去 review。
// INV-08 Cmd/Ctrl+W 只允许在「可见 workspace + 右侧面板有 active tab」时被本层消费（守住它的
//   位置：CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT 监听）。无条件 preventDefault 会让窗口关不掉。
// INV-09 toggle side pane 只改显隐，禁止隐式创建 tab（守住它的位置：handleToggleSidePane）。
//   回到「按内容兜底」会让用户只想打开面板却凭空得到 Browser/Review。
// INV-10 完整视图快捷键在面板关闭时必须「先展开再进入」（守住它的位置：
//   handleToggleSidePaneFullView）。顺序反转时 enter 会被关闭态吞掉。
// INV-11 所有快捷键命令先过 runVisibleWorkspaceCommand（守住它的位置：useAppKeyboard 的每个
//   回调）。不可见 workspace 收到按键会操作到后台窗口。
// INV-12 查找相关的三套导航状态（对话/文件变更/搜索结果高亮）彼此独立（守住它的位置：
//   三个 useState 与 handleTaskFindOpenChange）。合并状态会在关闭对话框时串行清空。
// INV-13 搜索结果高亮请求必须带单调 requestId，并按 id 对账清空（守住它的位置：
//   searchResultHighlightRequestIdRef）。用布尔或对象相等判断会丢掉「同一位置连续两次」。
// INV-14 桌面新建草稿前必须退出 workbench group 并 resetToPrimaryPane（守住它的位置：
//   handleStartDraftInWorkspace 内 store.startDraft 之前）。group primary binding 会覆盖草稿。
// INV-15 provider 继承规则：目标 workspace 已有 UI 状态则沿用其选择，仅首次进入继承当前值
//   （守住它的位置：resolveWorkspaceSwitchDraftProvider 调用处）。否则来回切项目总被重置。
// INV-16 quickPickCommands 与 taskFindDialogProps 必须 memo 且依赖最小化（守住它的位置：
//   两处 useMemo）。流式刷新期间的新引用会让整个 shell 每轮重建。
// INV-17 渲染顺序固定为 CommandCenterDialog → FeedbackHost → PluginUiWorkspaceProvider →
//   WorkspaceShellLayout（守住它的位置：return 内 JSX）。FeedbackHost 必须在 provider 之外，
//   远程断连时仍走本机 base host 提交反馈。
// INV-18 内存采样器每窗口最多一个，卸载必须 stop（守住它的位置：startMemoryDiagnosticsLogger
//   的 effect cleanup）。重复挂载会成倍写主日志。
//
// 阅读顺序：props → workspace RPC/只读判定 → side pane（useAppPanels）→ Git 派生 →
// 查找/主题/反馈 → 草稿与导航 → 键盘 → 渲染。
import { PluginUiWorkspaceProvider } from "@/plugin-ui/index.js";
/* eslint-disable max-lines -- App 当前集中编排 workspace 级状态、导航、Git 派生数据和 shell wiring；已将新增 side pane memory 桥接抽出，剩余拆分需要按 shell 边界单独重构。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { resolveWorkspaceKey, type GitChangeSourceId, type WorkspacePurpose } from "@zcode/shared";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import { useSidePaneFullView } from "@/side-pane-full-view/index.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPluginStoreOpenListener,
  type PluginStoreOpenTarget,
} from "@/lib/pluginStoreNavigation.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";
import { useTestActions } from "@/test-actions.js";
import type { TestActions } from "@/test-actions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { resolveTheme } from "@/useTheme.js";
import { WorkspaceShellLayout } from "@/app-shell/WorkspaceShellLayout.js";
import { useAppChromeState } from "@/app-shell/useAppChromeState.js";
import { useWorkspaceSessionReload } from "@/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellLifecycle } from "@/app-shell/useWorkspaceShellLifecycle.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import {
  useWorkspaceTaskNavigation,
  type AutomationsNavigationTarget,
} from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { useMarketingTaskCompletionRefresh } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";
import { useOffPeakTaskNotifications } from "@/hooks/useOffPeakTaskNotifications.js";
import type { AppProps, WorkspaceMainView } from "@/app-shell/types.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { taskListE2EActions } from "@/lib/taskListE2EActions.js";
import {
  CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
  getCloseActiveContextSidePaneTab,
} from "@/lib/closeActiveContext.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { startMemoryDiagnosticsLogger } from "@/lib/memoryDiagnostics.js";

const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  AppProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_CONNECTION_LOGS: NonNullable<AppProps["remoteConnectionLogs"]> = [];

// 组件只导出 App；props 是 Root 与桌面/Web/远控三个宿主共享的契约，
// 新增字段必须有可缺省默认值，否则会有一个宿主编译不过。
// 本组件不把 props 缓存进 state：所有派生都在渲染期完成，避免远程重连后拿到过期快照。
// 副作用统一交给 hooks（useAppChromeState / useAppPanels / useWorkspaceShellLifecycle）。
// 文件顶部已声明 max-lines 豁免；后续拆分必须按 shell 边界进行，而不是继续切 hook。
// 排查渲染问题时优先看 hook 内部日志，不要在 render 里临时加 console。
export function App({
  services,
  baseFeedbackService,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey = EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY,
  remoteWorkspaceErrorByWorkspaceKey,

  remoteConnectionLogs = EMPTY_REMOTE_CONNECTION_LOGS,
  onCreateTask,
  onCreateConversationTask,
  onCreateConversationTaskOnSource,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  remoteConnectionInProgress = false,
  onReturnToWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity: explicitWorkspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
}: AppProps) {
  // 展示 label 统一从快捷键生效表取（用户改键后 tooltip 同步更新），不再硬编码键位。
  // 快捷键 label 统一从生效表取，用户改键后 tooltip 立即同步；
  // 硬编码键位会在改键后教用户按错键（尤其 macOS 的 ⌘ 与 Ctrl 差异）。
  // 这里只取展示文本，不参与按键判定。
  const toggleSidebarShortcutLabel = useShortcutCommandLabel("toggleSidebar");
  // 新建任务 label 同时出现在 header 按钮、菜单与命令中心；
  // 统一从生效表取，避免改键后三处文案不一致。
  // useShortcutCommandLabel 取不到绑定就返回空串，命令中心据此只显示标题而不回退硬编码键位。
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  // 返回/前进 label 反映用户实际绑定（部分宿主把鼠标侧键也映射进来）；
  // 键位为空时按钮只显示图标，布局不能因此塌陷。
  const goBackShortcutLabel = useShortcutCommandLabel("navigateBack");
  // 前进 label 与返回成对取用；两者必须来自同一张生效表，否则会出现「返回已改、前进未改」。
  // 它只用于展示，导航可用性由 canGoForward 决定。
  const goForwardShortcutLabel = useShortcutCommandLabel("navigateForward");
  // 终端开关 label 供 header 与命令中心共用；
  // Office 模式下命令被隐藏，但 label 仍解析，避免条件 hook 调用。
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");
  // 右侧面板开关 label 下传 shell 与命令中心；
  // 动作本身始终走 handleToggleSidePane，label 不参与显隐判定。
  const toggleSidePaneShortcutLabel = useShortcutCommandLabel("toggleSidePane");
  // 完整视图只在桌面渲染，但 label 在 Web 也照常解析；
  // 不要用 supportsSidePaneFullView 包住这个 hook，否则两端 hook 顺序不一致。
  const toggleSidePaneFullViewShortcutLabel = useShortcutCommandLabel("toggleSidePaneFullView");
  // 打开 workspace 的 label 只服务命令中心条目；
  // allowOpenWorkspace 为 false 时命令被过滤，label 解析本身无副作用。
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  // 平台三态由 props 显式传入推导，不读 navigator：远控窗口与桌面窗口 UA 可能相同，
  // 但可用能力不同。supportsEmbeddedBrowser 只在宿主没给显式值时回落到 isDesktop。
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  // 内嵌浏览器能力优先取宿主显式声明，缺省时按「桌面端才有」推断；
  // Web 端显式传 false 时必须尊重，否则会渲染一个无法创建 guest 的面板。
  // 该值同时决定命令中心的浏览器条目与 side pane 的 browser tab 能力。
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  // intl/locale 来自 IntlProvider，locale 是广播同步字段；
  // 写回必须走 setLocale（经 broadcastService），直接改本地状态会让其他窗口语言不一致。
  // intl.formatMessage 只在需要文案的入口使用，不要把它塞进 memo 依赖以外的地方。
  const { intl, locale, setLocale } = useZCodeIntl();
  // Office 模式只影响命令可用性（隐藏终端/Review），不影响 workspace 只读判定；
  // 两者混用会让 Office 用户以为仓库被锁。
  // 该值只传给 quickPickCommands 的 supports 开关。
  const isOfficeMode = useIsOfficeMode();
  // 平台能力面由宿主注入（桌面 preload / Web 实现），组件只依赖 IPlatformService；
  // 任何 window.zcode 直连都会在 Web 端静默失败。
  // 新增平台能力先扩 IPlatformService，两端实现齐全后再在 UI 使用。
  const platform = usePlatform();
  // 进程内存本地诊断日志：每窗口一个 60s 采样器，
  // 经门控后写桌面主日志；Web 端无日志桥时为 no-op。同一次读数还经 preload 桥把 heap 送 main 的
  // renderer_main 资源事件，无桥时同样 no-op。
  // [资源] 采样器每窗口一个 60s 定时器，effect cleanup 必须 stop；
  // 重复挂载（StrictMode 双执行）不 stop 会成倍写主日志。
  // [失败路径] Web 端无日志桥时 reportHeapSample 为 undefined，采样器内部按 no-op 处理，
  // 这里不做分支，避免两端行为分叉。
  const reportRendererHeapSample = platform.reportRendererHeapSample;
  useEffect(() => {
    const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger({
      reportHeapSample: reportRendererHeapSample,
    });
    return () => memoryDiagnosticsLogger.stop();
  }, [reportRendererHeapSample]);
  // selector 返回对象字面量，必须用 useShallow 包一层做浅比较；
  // [权衡] 不包会因每次 store 通知产生新引用，把整个 App 拉进重渲染。
  // 只在 active tab 属于当前 workspace 时暴露 RPC 目标，否则显式置空交给兜底逻辑。
  const activeWorkspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!state.activeTabId) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        !activeTab ||
        !isWorkspaceTab(activeTab) ||
        activeTab.workspacePath !== workspaceAbsPath
      ) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      return {
        workspaceIdentity: activeTab.workspaceIdentity,
        remoteSessionId: activeTab.remoteSessionId,
        remoteTarget: activeTab.remoteTarget,
      };
    }),
  );
  // INV-01：优先级 activeTab → 显式 identity → 显式 remoteSessionId。
  // [失败路径] Settings tab 覆盖期间 active tab 不是 workspace tab，selector 返回全空，
  // 此时必须由 Root 传入的 workspaceIdentity 兜底；否则远程断连态会把 /home/... 当本地 base 预热。
  const workspaceRpcTarget = resolveAppWorkspaceRpcTarget({
    activeTarget: activeWorkspaceRpcTarget,
    explicitWorkspaceIdentity,
    explicitRemoteSessionId: workspaceRemoteSessionId,
  });
  // Settings tab 覆盖 workspace 时 active tab 不是 workspace tab。
  // 这里必须使用 Root 传入的 workspaceIdentity 兜底，否则远程断连态会把 /home/... 当成本地 base workspace 预热。
  // 后续所有 workspace 级查询都用解析后的 identity，不能再用 props 里的原始值；
  // 两者在「Settings 覆盖 workspace」时必然不同。
  const workspaceIdentity = workspaceRpcTarget.workspaceIdentity;
  // [失败路径] rpcReady 是「workspace 服务已连上」的唯一判据；
  // MCP 加载、通知拉取都必须等它，提前调用会把空结果写进缓存。
  // 远程重连时它会短暂回落为 false，下游必须能承受「已挂载但未就绪」。
  const { rpcReady: workspaceRpcReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRpcTarget.remoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  // INV-02：只读判定必须与 tabStore 的同一份规则同源（isWorkspaceReadOnly），
  // 本地路径不可用时返回不可写，所有写入口再经 *IfWritable 收敛。
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspaceAbsPath, workspaceIdentity),
  );
  // 不可写时才生成原因文案，可写时保持 undefined；
  // [权衡] 可写也生成字符串会让 intl 格式化的结果进入 props，引发无意义的下传比较。
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  // workspace 级 ZCode 状态的唯一入口：activeTaskId、selectedProvider、draftFocusVersion 都从这里取；
  // [权衡] 不在这里另起 store 订阅，避免同一字段出现两条更新来源。
  const { workspaceShellZCodeState, reloadSessionDisabled } = useWorkspaceShellZCodeState(
    workspaceAbsPath,
    workspaceIdentity,
  );
  // activeTaskId 为 null 表示当前是草稿态；下游所有「按任务记忆」的能力都要能处理 null，
  // 不能用空字符串冒充任务 id。
  const activeTaskId = workspaceShellZCodeState.activeTaskId;
  // side pane 的 owner 固定等于 activeTaskId：面板内容按任务隔离，
  // 任务切换时面板应整体换内容而不是复用旧 tab。
  const sidePaneOwnerId = activeTaskId;
  // 摘要面板的显式覆盖只活在本次组件生命周期内，不持久化；
  // 切换任务时由上游重新给出默认值，避免把上一个任务的选择带过去。
  const [summaryPanelVariantOverride, setSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  // 该版本号只在用户真正开始新草稿时递增，任务切换与恢复不会改它；
  // 把它当「任务变化计数器」会让每次切换任务都收起面板。
  // 0 是初始值，永远不触发收起。
  const draftFocusVersion = workspaceShellZCodeState.draftFocusVersion;
  const {
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleToggleGit,
    handleOpenGit,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenFileManager,
    handleNavigateFileManager,
    handleOpenPluginMarket,
    handleOpenTerminalTab,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenPluginUi,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleOpenNewSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  // side pane 的全部状态与操作由 useAppPanels 收口，App 只做转发；
  // [资源] 这里一次解构出 40+ 个 handler，任何新增面板类型都必须走同一套 activate/reorder/close，
  // 否则会出现「新面板不能拖拽/不能恢复」的孤岛。
  } = useAppPanels({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  // INV-04 的记账键：identity 优先、路径兜底，保证同一 workspace 的 key 稳定；
  // 两者混用会让同一目录在两套 key 下各存一份前端状态。
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  // 通知偏好按布尔订阅；依赖完整 settings 对象会在任何偏好变化时重渲染外壳。
  // 通知类 hook 的 enabled 只认这个布尔值与会话可见性。
  const notificationEnabled = useZCodeStore((s) => s.notificationEnabled);
  // [失败路径] 该刷新依赖 rpcReady；未就绪时内部跳过，不能改成无条件请求，
  // 否则远程重连期会打出成片的 workspace not found。
  useMarketingTaskCompletionRefresh({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    rpcReady: workspaceRpcReady,
  });
  // 通知按 workspace 维度去重，endpointKey 只在有远程会话时传入；
  // 本地与远程同一路径是两份任务空间，不能共用 key。
  useWorkspaceTerminalTaskNotifications({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    enabled: notificationEnabled,
    rpcReady: workspaceRpcReady,
    platform,
    formatMessage: intl.formatMessage,
  });
  // 闲时任务终态/等确认通知：仅桌面本地链路，main 进程按 status:taskId 去重多窗口重复。
  // 闲时任务通知只在桌面本地链路启用；
  // [并发] main 进程按 status:taskId 去重，多窗口同时打开也只弹一次。
  // Web 端传 enabled=false，避免依赖不存在的通知桥。
  useOffPeakTaskNotifications({
    offPeakTaskService: services.offPeakTaskService,
    platform,
    enabled: Boolean(notificationEnabled && isDesktop),
    formatMessage: intl.formatMessage,
  });
  // INV-03/04：用 (workspaceKey, draftFocusVersion) 二元组记账，而不是单个版本号。
  // [失败路径] 只记版本号时，切到另一个 workspace 后首个草稿会命中旧记录，面板不收。
  const lastHandledDraftSidePaneCloseRef = useRef({
    workspaceKey,
    draftFocusVersion,
  });

  useEffect(() => {
    const previous = lastHandledDraftSidePaneCloseRef.current;
    // 切换 workspace 只把记账基线换成新 key，不触发收起；
    // 把切换当成「新建草稿」会把用户刚恢复的面板关掉。
    // 这里连 draftFocusVersion 一起重置，保证新 workspace 的首个草稿能被识别。
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftSidePaneCloseRef.current = {
        workspaceKey,
        draftFocusVersion,
      };
      return;
    }

    // 版本未变说明不是新建草稿，直接返回；这是 effect 的常规快速路径。
    // 缺少这一层会让每次面板显隐都走一遍日志与收起副作用。
    if (previous.draftFocusVersion === draftFocusVersion) {
      return;
    }

    lastHandledDraftSidePaneCloseRef.current = {
      workspaceKey,
      draftFocusVersion,
    };
    // 0 表示初始/恢复态，不是用户新建；这里只更新记账后返回，不能触发收起。
    if (draftFocusVersion === 0) {
      return;
    }

    // 新建任务只会把 activeTaskId 切到 draft，不会触发 side pane 的 workspace 级内存切换。
    // 因此用 startDraft 递增的版本号统一收起右侧面板，覆盖按钮、菜单、快捷键和远控入口。
    // 只在需要打日志时读取 tab 数量；不要把它接进 effect 依赖，否则面板每次增删都会重跑收起逻辑。
    // 日志字段缺省为 0，仅用于排查，不参与任何判定。
    const sidePaneTabCount = sidePaneState?.tabs.length ?? 0;
    if (!isSidePaneCollapsed) {
      logger.info(
        `[App] 新建任务时收起右侧面板 workspace=${workspaceAbsPath} tabs=${sidePaneTabCount}`,
      );
    }
    // scope effect 可能在同一轮更新展开态，不能用本次渲染的旧值跳过新草稿收起。
    // 不能用本轮渲染的 isSidePaneCollapsed 做跳过条件：同轮 effect 可能已改过展开态；
    // 无条件置 true 才能覆盖按钮、菜单、快捷键、远控四条入口。
    setIsSidePaneCollapsed(true);
  }, [
    draftFocusVersion,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    sidePaneState,
    workspaceAbsPath,
    workspaceKey,
  ]);
  // [权衡] 仅 E2E 注入用，生产路径永远为 null；
  // 它被 useTestActions 暴露给测试桥，不要把它接到真实消息流。
  const [testMessages, setTestMessages] = useState<TestChatMessage[] | null>(null);
  // 命令中心的开合是纯 UI 状态，不进 store：多窗口之间不应同步弹窗。
  const [isQuickPickOpen, setIsQuickPickOpen] = useState(false);
  // 对话框显隐与导航状态分开：关闭动画期间导航状态仍需可读。
  // 把它并进 conversationFindState 会让关闭重置与动画时序耦合。
  const [isTaskFindOpen, setIsTaskFindOpen] = useState(false);
  // 每次显式打开都递增，用于「已打开时再按 Cmd/Ctrl+F」重新聚焦输入框。
  // 只依赖 open 布尔无法表达「已开且再次请求聚焦」。
  const [taskFindFocusRequestId, setTaskFindFocusRequestId] = useState(0);
  // 导航状态包含 query/activeIndex/navigationRequestId，重置必须走工厂函数；
  // 手写字面量会漏掉 requestId，导致关闭后首次导航不滚动。
  const [conversationFindState, setConversationFindState] = useState(createTaskFindNavigationState);
  // conversationFindMatchCount 只接子组件上报的 matchCount，导航索引仍在 conversationFindState 内。
  // 两个 state 若合并，输入时匹配数回写会覆盖同一次导航的 activeIndex。
  // matchCount 只喂对话框的「第 N 项」文案，高亮仍按 conversationFindState 的 activeIndex 走。
  const [conversationFindMatchCount, setConversationFindMatchCount] = useState(0);
  // INV-13：单调递增 id 是「同一位置连续两次高亮」的唯一区分手段。
  const searchResultHighlightRequestIdRef = useRef(0);
  // 请求对象携带位置与 requestId，null 表示空闲；
  // 清空只能经 handleSearchResultHighlightDone 的 id 对账，禁止按内容相等清除。
  // searchResultHighlightRequest 只活在内存，切页卸载后即清空，不做持久化恢复。
  const [searchResultHighlightRequest, setSearchResultHighlightRequest] =
    useState<ChatSearchResultHighlightRequest | null>(null);
  // 文件变更查找是独立导航域，与对话查找共享工厂函数但各自持有 requestId。
  // 复用同一 state 会让两个 Tab 的导航互相清空。
  const [fileChangeFindState, setFileChangeFindState] = useState(createTaskFindNavigationState);
  // 文件变更命中数单独上报，避免与对话命中数在对话框里串位。
  // 两处都通过 WorkspaceShellLayout 下传，不要在中间合并。
  const [fileChangeFindMatchCount, setFileChangeFindMatchCount] = useState(0);
  // 能力探测结果默认不可用（fail-closed），探测成功后才显示入口。
  const [canOpenCommunityFromQuickPick, setCanOpenCommunityFromQuickPick] = useState(false);
  // 默认未暂存；随后由 useTaskSidePaneMemoryBridge 按任务恢复上次来源。
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  // 刷新版本号只增不减；它作为 refreshToken 让 repository 区分「用户显式刷新」与普通重渲染。
  // 归零或回绕会让刷新失去语义。
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  // 浏览器恢复 URL 与 Git 来源选择按任务记忆；
  // 记忆写入在 bridge 内部防抖，这里只消费结果，不要额外持久化。
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath,
    workspaceIdentity,
  });
  // theme 是广播同步字段，写入必须经 setTheme 走 broadcastService，
  // 直接改 store 会让其他窗口停在旧主题。
  const theme = useZCodeStore((s) => s.theme);
  // store 上的 action 引用稳定，可安全进入依赖数组；
  // 它内部负责广播同步，不要在调用处再补一次 broadcast。
  // 主题持久化由 store 负责，App 不直接写 localStorage。
  const setTheme = useZCodeStore((s) => s.setTheme);
  const {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  } = useAppChromeState({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
    workspaceAbsPath,
  });
  // 桌面窗口 chrome 状态（全屏、控件内边距、更新提示）由 useAppChromeState 统一订阅；
  // [失败路径] 非桌面宿主返回默认值，渲染层据此决定是否画窗口控件，不能在各组件里再判一次。
  const tabs = useTabStore((s) => s.tabs);
  // tab 操作直接用 store action，不经过本地镜像状态，避免两份 tabs 不一致。
  // 新增入口必须复用这里的 action，不能自己 setState。
  const addTab = useTabStore((s) => s.addTab);
  // activate 返回是否命中已有 tab；调用方必须处理 false（随后 addTab），
  // 否则 Home 这类尚未打开的入口会出现「点了没反应」。
  // 不要为了省一次调用先 find 再 activate，find 与 activate 之间存在竞态。
  const activateTabByPath = useTabStore((s) => s.activateTabByPath);

  const {
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  } = useWorkspaceActiveTaskState({
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    intl,
  });
  // provider 配置文件路径随 active task 的 provider 变化；
  // 远程会话必须带 remoteSessionId/workspaceIdentity，否则会读到本地同名用户目录。
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspaceAbsPath,
    workspaceHeaderProvider,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  // 给 shell 的 workspace tab 投影必须只含 workspace tab；
  // Settings tab 混入会让切换器出现一个无法激活的条目。
  const workspaceTabs = useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        workspacePath: tab.workspacePath,
        label: tab.label,
        remoteSessionId: tab.remoteSessionId,
        remoteTarget: tab.remoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
        workspacePurpose: tab.workspacePurpose,
        localWorkspacePath: tab.localWorkspacePath,
        availability: tab.availability,
      })),
    [tabs],
  );
  // 命令中心需要完整 tab 字段，与上面裁剪过的 workspaceTabs 分开 memo，避免互相牵制。
  const commandCenterWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // active tab 由 sidePaneState 派生一次，浏览器/Git 开关都从这里读，避免两处判定不一致。
  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  // 浏览器按钮高亮只看当前激活 tab；存在后台浏览器 tab 不代表面板可见。
  // 用 some 判断会让按钮常亮。
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  // 「Git 面板当前可见」与「存在 Git tab」是两件事：前者决定 header 高亮，后者决定是否拉扩展数据。
  const isGitOpen = activeSidePaneTab?.type === "git";
  // 只有存在 Git tab 才请求 extended Git 数据；无条件请求会在未开面板时白跑 git 命令。
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  // 刷新通过递增版本号触发，而不是直接调用 repository；
  // 版本号变化会被 useGitRepository 识别为用户显式刷新，这是 INV-05 的唯一放行口。
  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
  }, []);
  // 设置是单例 tab：重复打开只激活，不新建；窗口级状态因此不随入口数量增长。
  // 所有设置入口（快捷键、命令中心、空态）都必须复用它。
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  // INV-05：refreshToken 只由 workspace 切换、打开 Git pane、显式刷新驱动。
  // [权衡] task 切换 / last-turn 摘要只更新本地派生数据；顺手重拉会让每次流式 turn 扫仓库。
  // [失败路径] 远程会话必须透传 remoteTarget，否则 Git 命令跑在本机错路径。
  const gitState = useGitRepository({
    workspacePath: workspaceAbsPath,
    activeTaskId,
    includeExtendedData: hasGitTab,
    // 关键逻辑：真实 Git 只在 workspace 变化、Git pane 打开、或用户显式点刷新时重拉。
    // task 切换 / last-turn 摘要变化只更新本地衍生数据，不再顺带重跑 Git 命令。
    refreshToken: gitRefreshVersion,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    remoteTarget: workspaceRpcTarget.remoteTarget,
    workspaceIdentity,
  });
  // 自动刷新只在 workspace 可见时启用；后台窗口刷新既浪费 IO，也会与用户正在看的 diff 抢状态。
  useGitAutoRefresh({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: isWorkspaceVisible,
    onRefreshGit: handleRefreshGit,
  });
  // 选中的来源必须回落到 sourceOptions 里真实存在的 id；
  // 直接信任 state 会在来源消失（如 rebase 后无 staged）时把面板卡在空数据集。
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";
  // INV-06：一次遍历把各来源的 +/- 汇总成映射，header 与 Git pane 共用；
  // [失败路径] 各算各的会在来源切换瞬间出现两个不同的总数。
  const gitChangeSummaryBySourceId = useMemo(() => {
    // 关键业务逻辑：workspace header 和 Git pane 都依赖同一套来源统计，
    // 这里先把各来源的 +/- 汇总成稳定映射，避免不同位置各自重复计算后出现展示不一致。
    return Object.fromEntries(
      gitState.sourceOptions.map((option) => {
        const dataset = gitState.datasets[option.id] ?? gitState.datasets.unstaged;
        const summary = dataset.sections
          .flatMap((section) => section.changes)
          .reduce(
            (result, change) => {
              result.added += change.added;
              result.removed += change.removed;
              return result;
            },
            { added: 0, removed: 0 },
          );
        return [option.id, summary];
      }),
    ) as Record<GitChangeSourceId, { added: number; removed: number }>;
  }, [gitState.datasets, gitState.sourceOptions]);
  // worktree 汇总只含 unstaged + staged，未跟踪/冲突不计入，保持与 Git pane 的分组口径一致。
  const gitWorktreeChangeSummary = useMemo(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    return {
      added: unstaged.added + staged.added,
      removed: unstaged.removed + staged.removed,
    };
  }, [gitChangeSummaryBySourceId]);
  // INV-07：unstaged 有变更优先 review unstaged，其次 staged，否则 null。
  // 反过来会把已暂存内容当成未暂存打开，用户会以为暂存失败。
  const gitWorktreeReviewSourceId = useMemo<GitChangeSourceId | null>(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    if (unstaged.added + unstaged.removed > 0) {
      return "unstaged";
    }
    if (staged.added + staged.removed > 0) {
      return "staged";
    }
    return null;
  }, [gitChangeSummaryBySourceId]);
  // review 入口同样是写入口闩锁的一部分：只读 workspace 直接返回，连 Git pane 都不打开。
  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleOpenGit();
    },
    [handleOpenGit, workspaceReadOnlyReason],
  );
  // 显隐只由 collapsed 派生，禁止再从 tabs 数量推断「是否打开」。
  const isSidePaneOpen = !isSidePaneCollapsed;
  useEffect(() => {
    const handleCloseActiveContextRequest = (event: Event) => {
      const activeTab = getCloseActiveContextSidePaneTab({
        isWorkspaceVisible,
        isSidePaneCollapsed,
        sidePaneState,
      });
      if (!activeTab) {
        return;
      }

      // 桌面菜单的 Cmd/Ctrl+W 会先到 main 进程。
      // 这里在可见 workspace 层拦下请求，确保右侧 side pane 打开时关闭的是 active tab，
      // 而不是让 Root fallback 继续关闭整个窗口。
      event.preventDefault();
      handleCloseSidePaneTab(activeTab.id);
    };

    // INV-08：[并发] 桌面菜单的 Cmd/Ctrl+W 先到 main 进程，再由 main 广播此事件。
    // 只有在「可见 workspace + 面板有 active tab」时才 preventDefault 并只关该 tab；
    // [失败路径] 无条件消费会让整个窗口关不掉。
    window.addEventListener(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, handleCloseActiveContextRequest);
    return () => {
      window.removeEventListener(
        CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
        handleCloseActiveContextRequest,
      );
    };
  }, [handleCloseSidePaneTab, isSidePaneCollapsed, isWorkspaceVisible, sidePaneState]);
  // INV-09：toggle 只改显隐，空内容交给 Open tab 空态；
  // 回到「按 diff/browser 兜底自动开内容」会让用户凭空得到一个 Browser。
  const handleToggleSidePane = useCallback(() => {
    // 交互说明：toggle panel 只改变右侧容器显隐，不隐式创建或切换任何 tab。
    // 之前无 tab 时会按 diff/browser 兜底自动开内容，导致用户只是想打开 side pane
    // 却得到一个新 Browser 或 Review。现在空内容统一交给 Open tab 空态承接。
    handleToggleSidePaneCollapse();
  }, [handleToggleSidePaneCollapse]);
  // Side Pane 完整视图只在桌面端提供（docs/ui/side-pane-full-view.md）。
  // 完整视图仅桌面且非远控 workspace 切换器时可用；Web 手机端没有窗口级布局，开了也无处可退。
  const supportsSidePaneFullView = Boolean(isDesktop) && !webRemoteControlWorkspaceSwitcher;
  const sidePaneFullView = useSidePaneFullView({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    ownerId: sidePaneOwnerId,
    isSidePaneOpen,
    enabled: supportsSidePaneFullView,
  });
  // INV-10：面板关闭时先 toggle 展开，再 enter 完整视图，顺序不可交换；
  // 反过来的写入会被「面板关闭」状态吞掉，表现为快捷键第一次无效。
  const handleToggleSidePaneFullView = useCallback(() => {
    // 面板关闭时快捷键先打开面板再进入完整视图；记录先写入，面板展开后即生效。
    if (!sidePaneFullView.fullView && !isSidePaneOpen) {
      handleToggleSidePaneCollapse();
      sidePaneFullView.enter();
      return;
    }
    sidePaneFullView.toggle();
  }, [handleToggleSidePaneCollapse, isSidePaneOpen, sidePaneFullView]);
  // INV-11：不可见 workspace 的快捷键不执行，而是先 onReturnToWorkspace；
  // 直接执行会操作到后台窗口，用户看到的是「按键跑到了别的项目」。
  const runVisibleWorkspaceCommand = useCallback(
    (run: () => void) => {
      runWorkspaceVisibleCommand({
        isWorkspaceVisible,
        onReturnToWorkspace,
        run,
      });
    },
    [isWorkspaceVisible, onReturnToWorkspace],
  );
  // INV-02 的写入口闸：新建、终端、Git、代码查看器都必须经过各自的 IfWritable；
  // [失败路径] 漏一个就会出现「按钮已灰但快捷键还能写仓库」。
  // 只读原因由 workspaceReadOnlyReason 统一提供，不在各入口重复判断。
  const handleCreateTaskIfWritable = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      if (!workspaceReadOnlyReason) {
        onCreateTask(request);
      }
    },
    [onCreateTask, workspaceReadOnlyReason],
  );
  // 以下五个 IfWritable 包装是 INV-02 的落地：终端、终端 tab、打开 Git、切换 Git、代码查看器；
  // [失败路径] 任意一个绕过包装，只读 workspace 就会出现「界面禁用但快捷键可写」。
  // 新增写入口时先加包装，再接到任何 UI 或键盘。
  const handleToggleTerminalIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleTerminal();
    }
  }, [handleToggleTerminal, workspaceReadOnlyReason]);
  // 打开终端 tab 与切换终端面板走同一只读闸，但保留各自语义（新建 vs 显隐）。
  // 合并两者会让「新开 tab」变成「打开面板」。
  const handleOpenTerminalTabIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenTerminalTab();
    }
  }, [handleOpenTerminalTab, workspaceReadOnlyReason]);
  // 打开 Git 面板会触发 git 命令，因此同样受只读闸限制。
  // 只读 workspace 下直接返回，不产生任何面板或进程。
  const handleOpenGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenGit();
    }
  }, [handleOpenGit, workspaceReadOnlyReason]);
  // 切换 Git 与打开 Git 是不同入口（命令中心 vs header），两者都要过闸。
  // 只包一个会让另一个入口成为侧门。
  const handleToggleGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleGit();
    }
  }, [handleToggleGit, workspaceReadOnlyReason]);
  // 用剩余参数整体转发，保证调用方新增参数时不会被这里截断；
  // 不要在这里解构参数再重建对象，引用变化会导致查看器重复打开。
  // 只读判定必须在转发之前，避免下游已经创建 tab。
  const handleOpenCodeViewerIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenCodeViewer>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenCodeViewer(...args);
      }
    },
    [handleOpenCodeViewer, workspaceReadOnlyReason],
  );
  // [失败路径] 自动打开预览只在桌面本地链路生效；远控切换器与只读 workspace 直接返回，
  // 否则会在别人的机器上弹出预览。
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!isDesktop || webRemoteControlWorkspaceSwitcher || workspaceReadOnlyReason) {
        return;
      }
      handleOpenCodeViewers(request.sources);
    },
    [handleOpenCodeViewers, isDesktop, webRemoteControlWorkspaceSwitcher, workspaceReadOnlyReason],
  );
  // 项目名只用于展示，取路径叶子；不要用它反查 workspace，重名目录会串。
  const projectName = getPathLeaf(workspaceAbsPath);
  // Cmd/Ctrl+F 的语义是「查找对话」，与 Cmd/Ctrl+P 的文件搜索是两条链路；
  // [权衡] 复用 quick pick 会让用户以为在搜文件。
  const handleOpenTaskFind = useCallback(() => {
    // Cmd/Ctrl+F 语义是“查找对话”，之前误复用了 Cmd/Ctrl+P 的文件搜索入口，
    // 导致用户在 quick pick 里点 Find 或按快捷键时会跳到打开文件。这里拆成独立状态，避免影响文件搜索链路。
    runVisibleWorkspaceCommand(() => {
      setTaskFindFocusRequestId((requestId) => requestId + 1);
      setIsTaskFindOpen(true);
    });
  }, [runVisibleWorkspaceCommand]);
  // INV-12：关闭时必须把三套导航状态与计数全部重置；
  // [失败路径] 只重置当前 tab 会让下次打开沿用上次的 activeIndex 并自动滚到旧位置。
  const handleTaskFindOpenChange = useCallback((open: boolean) => {
    setIsTaskFindOpen(open);
    if (!open) {
      setConversationFindState((state) => changeTaskFindSelection(state, "", -1));
      setConversationFindMatchCount(0);
      setFileChangeFindState((state) => changeTaskFindSelection(state, "", -1));
      setFileChangeFindMatchCount(0);
    }
  }, []);
  // change 只记录输入与索引，不递增 navigationRequestId；只有 navigate 才触发滚动。
  const handleConversationFindChange = useCallback((query: string, activeIndex: number) => {
    setConversationFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  // 单命中时上下/Enter 都会回到同一 index，必须用 navigate 版本（带 navigationRequestId）才能重复触发滚动。
  const handleConversationFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 单命中时上/下/Enter 都会回到同一 index；独立版本确保重复导航仍触发滚动。
    setConversationFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  // 子组件只上报命中数，activeIndex 可选；
  // 只有明确给出索引时才同步本层状态，否则会覆盖用户当前导航位置。
  // 同步时复用 current.query，避免用过期查询串重算。
  const handleConversationFindMatchStateChange = useCallback(
    (state: ConversationFindMatchState) => {
      setConversationFindMatchCount(state.matchCount);
      if (state.activeIndex !== undefined) {
        setConversationFindState((current) =>
          changeTaskFindSelection(current, current.query, state.activeIndex ?? -1),
        );
      }
    },
    [],
  );
  // INV-13：requestId 由 ref 递增生成，不放进 state 依赖；
  // handleSearchResultHighlightDone 只比 requestId，不复用位置或文本做相等判断。
  const handleSearchResultHighlightRequest = useCallback(
    (request: Omit<ChatSearchResultHighlightRequest, "requestId">) => {
      searchResultHighlightRequestIdRef.current += 1;
      setSearchResultHighlightRequest({
        ...request,
        requestId: searchResultHighlightRequestIdRef.current,
      });
    },
    [],
  );
  // [并发] 完成回调可能晚于下一次请求到达，requestId 不等时保留当前请求不清空。
  // 只有 id 相等才清空，否则会把新一次高亮提前取消。
  const handleSearchResultHighlightDone = useCallback((requestId: number) => {
    setSearchResultHighlightRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  // 文件变更范围与对话范围各持一套状态；计数也分开上报，不能互相覆盖。
  const handleFileChangeFindChange = useCallback((query: string, activeIndex: number) => {
    setFileChangeFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  // 与对话查找同因：单命中时重复导航必须靠 requestId 才能重新展开并聚焦。
  // 去掉 requestId 会让「同一处再点一次」无反应。
  const handleFileChangeFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 文件变更范围也可能只有一个命中；重复导航必须重新展开并聚焦同一处。
    setFileChangeFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  // 命令中心是 toggle 语义（同一快捷键开关），与「打开后设置某状态」的入口区分。
  const handleOpenQuickPick = useCallback(() => {
    setIsQuickPickOpen((open) => !open);
  }, []);
  // 反馈中心的打开动作从 feedbackStore 取，避免 App 自己维护第二份弹窗状态。
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  // 「我的反馈」入口仍保留，供旧 IPC 兼容；两个打开动作都走 feedbackStore。
  // openFeedbackTickets 从 feedbackStore 取，App 不再持有第二份票单弹窗布尔。
  const openFeedbackTickets = useFeedbackStore((state) => state.openTickets);
  // 命令只关心登录布尔值：依赖完整 user 对象会在 auth store 返回等价新引用时重建命令组。
  const isLoggedIn = Boolean(user);
  // [失败路径] 反馈必须走 baseFeedbackService（本机 base host），不能走 workspace services；
  // 远程断连时后者是断连代理，提交会直接失败。
  const handleOpenFeedback = useCallback(() => {
    void platform.openFeedback();
  }, [platform]);

  useEffect(() => {
    // 内置反馈中心合并了"提交反馈 / 我的反馈"两个 Tab，
    // 老的 OpenTicketsPanel IPC 仍然兼容（直接打开列表），未来如果还需要单独入口可以复用。
    const disposeFeedbackDialog = platform.onOpenFeedbackDialog?.(() => {
      openFeedbackSubmit();
    });
    const disposeTicketsPanel = platform.onOpenTicketsPanel?.(() => {
      openFeedbackTickets();
    });
    return () => {
      disposeFeedbackDialog?.();
      disposeTicketsPanel?.();
    };
  }, [openFeedbackSubmit, openFeedbackTickets, platform]);
  // 外部跳转统一经 platform，禁止组件里直接 window.open 或 window.zcode。
  // platform.openCommunity 内部对不可用能力 no-op，调用处不再判断 window.zcode 是否存在。
  // 能力不可用时由 platform 内部 no-op，调用处不重复判断。
  const handleOpenCommunity = useCallback(() => platform.openCommunity(), [platform]);
  // 文档地址是常量而非用户输入，不要在运行时拼接 workspace 数据进 URL。
  const handleOpenProductDocs = useCallback(() => {
    platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
  }, [platform]);
  // 目标主题只推导一次，供菜单文案与切换动作共用，避免两处各算一次后漂移。
  const themeTarget = resolveTheme(theme) === "dark" ? "light" : "dark";
  // 主题写回必须经 setTheme（广播）；「跟随系统」时按当前实际显示取反，而不是固定切到 dark。
  const handleSwitchTheme = useCallback(() => {
    setTheme(themeTarget);
  }, [setTheme, themeTarget]);
  // 先写 pending section 再开设置 tab：tab 一旦挂载就会读取 pending 值，顺序反转会落到默认页。
  const handleOpenSettingsSection = useCallback(
    (section: SettingsSectionId) => {
      setPendingSettingsSection(section);
      openSettingsTab();
    },
    [openSettingsTab],
  );
  // 会话重载按钮的可用性由 reloadSessionDisabled 决定，pending 只控制 loading；
  // [失败路径] 重载中再次触发必须被 pending 拦住，否则会并发重建 runtime。
  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    services,
    workspaceAbsPath,
    reloadSessionDisabled,
  });
  // INV-14/15：workspace 空态里的「新建对话」统一走这里。
  // provider 继承：目标 workspace 已有 UI 状态则沿用其选择，仅首次进入继承当前空态的选择；
  // 否则来回切项目会把目标项目刚用过的 Agent 覆盖回默认值。
  // INV-14：desktop 本地布局必须在 startDraft 前退出 group 并 reset，否则 group primary binding 覆盖草稿。
  const handleStartDraftInWorkspace = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      // [权衡] 一次性快照用 getState()，不订阅 workspaces；
      // 订阅会让每个 workspace 状态变化都重渲染整个 App shell。
      const store = useZCodeSessionStore.getState();
      const resolvedTargetWorkspaceIdentity =
        targetWorkspaceIdentity ??
        tabs.filter(isWorkspaceTab).find((tab) => tab.workspacePath === targetWorkspacePath)
          ?.workspaceIdentity;
      // 目标 workspace 可能与当前不同，必须用目标路径 + 目标 identity 重新判定只读；
      // 复用当前 workspaceReadOnlyReason 会漏判。
      if (isWorkspaceReadOnly({ tabs }, targetWorkspacePath, resolvedTargetWorkspaceIdentity)) {
        return;
      }
      const targetSelectedProvider = resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: workspaceShellZCodeState.selectedProvider,
        targetWorkspacePath,
        targetWorkspaceIdentity: resolvedTargetWorkspaceIdentity,
        workspaces: store.workspaces,
      });

      // 空态里的 workspace 选择器要表达"在这个项目里开始工作"，
      // 目标 workspace 如果已经记住了自己的 Agent，切过去后应当继续沿用那份选择；
      // 只有首次进入、还没建立 workspace UI 状态时，才继承当前空态里正在看的 Agent。
      // 否则来回切项目时会把目标项目刚用过的 Agent 覆盖掉，看起来就像“总是重置成默认值”。
      // 另外 Home 这类固定入口并不保证已经存在于 tab 列表里，之前直接 activateTabByPath 会静默失败，
      // 看起来就像"点了没反应"。这里先确保目标 workspace 已打开，再把当前空态的 provider 一并传给 startDraft，
      // 保证首次进入的新 workspace 也能继续沿用当前上下文。
      const targetTabOptions =
        resolvedTargetWorkspaceIdentity || targetWorkspacePurpose
          ? {
              ...(resolvedTargetWorkspaceIdentity
                ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
                : {}),
              ...(targetWorkspacePurpose ? { workspacePurpose: targetWorkspacePurpose } : {}),
            }
          : undefined;
      if (targetWorkspacePurpose) {
        // purpose 是分类元数据；即使 tab 已存在也要合并，避免首次从项目解绑时被默认成 project。
        addTab(targetWorkspacePath, targetTabOptions);
      } else if (
        !activateTabByPath(
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity
            ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
            : undefined,
        )
      ) {
        addTab(targetWorkspacePath, targetTabOptions);
      }
      if (!webRemoteControlWorkspaceSwitcher) {
        // 修复原因：workspace 行“新建对话”以前由叶子组件直接 activateTab + startDraft，
        // 没有退出重启恢复的 workbench group/pane。group primary binding 因而仍可覆盖草稿。
        // desktop 所有显式新建入口统一先回到单 primary pane；手机 /remote 不消费这份本地布局。
        // INV-14：远控 workspace 切换器不消费本地布局，因此只在非远控时重置。
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      // 所有准备动作（开 tab、重置布局、算 provider）必须在 startDraft 之前完成，草稿一旦生成就会被 UI 立即消费。
      store.startDraft(
        targetWorkspacePath,
        targetSelectedProvider,
        resolvedTargetWorkspaceIdentity,
        { createSource: createSource ?? "project" },
      );
    },
    [
      activateTabByPath,
      addTab,
      tabs,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceShellZCodeState.selectedProvider,
      webRemoteControlWorkspaceSwitcher,
    ],
  );

  // 生命周期 hook 负责跨 workspace 的订阅建立与销毁；
  // [资源] 卸载清理由 hook 内部完成，不在这里手动兜底。
  useWorkspaceShellLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    services,
    setBrowserNavigationRequest,
    setTestMessages,
  });

  // [失败路径] 必须等 rpcReady 再加载 MCP；提前调用会在远程未就绪时把空配置写进缓存。
  useEnsureWorkspaceMcpLoaded(workspaceAbsPath, workspaceIdentity, workspaceRpcReady);

  // 测试桥把 services 与 store 的操作暴露给 E2E；
  // [权衡] 依赖列表只列真实使用的 service，避免每次 theme/locale 变化重建整包。
  const testActions = useMemo<TestActions>(
    () => ({
      ...taskListE2EActions,
      sendBotMessage: (message) => services.botsService.handleInboundMessage(message),
      submitBotGroupInput: (params) => {
        const submit = services.zcodeTaskService.submitBotGroupInput;
        if (!submit) throw new Error("Task material admission unavailable");
        return submit.call(services.zcodeTaskService, params);
      },
      getTheme: () => theme,
      setTheme,
      getLocale: () => locale,
      setLocale,
      setChatMessages: (messages) => {
        setTestMessages([...messages]);
      },
      getChatMessageCount: () => testMessages?.length ?? 0,
      getPluginsOverview: (params) => services.zcodeAgentService.getPluginsOverview(params),
      addPluginMarketplace: (params) => services.zcodeAgentService.addPluginMarketplace(params),
      updatePluginMarketplace: (params) =>
        services.zcodeAgentService.updatePluginMarketplace(params),
      installPlugin: (params) => services.zcodeAgentService.installPlugin(params),
      listPlugins: (params) => services.zcodeAgentService.listPlugins(params),
      getPluginReferenceCatalog: (params) =>
        services.zcodeAgentService.getPluginReferenceCatalog(params),
    }),
    [
      locale,
      services.botsService,
      services.zcodeTaskService,
      services.zcodeAgentService,
      setLocale,
      theme,
      setTheme,
      testMessages,
    ],
  );
  // 注册测试桥发生在 actions memo 之后；顺序颠倒会把空引用注册给 E2E。
  // 生产构建里该 hook 仍会执行，但动作只在测试注入时被调用。
  useTestActions(testActions);
  // 主视图是显式枚举（chat/automations/plugin-store），不是路由；
  // [失败路径] settings 是覆盖层而非枚举值，退出时由 preserveNextSettingsExit 决定回到哪一页。
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  // 自动化深链由 id 与 tab 两个字段组成，必须同时设置、同时清空；
  // 只清 id 会在下次进入时带着旧 tab 落到默认页。
  // handleOpenAutomationConsumed 由自动化页定位完成后回调，负责成对清空自动化深链字段。
  const [openAutomationId, setOpenAutomationId] = useState<string | null>(null);
  const [openAutomationTab, setOpenAutomationTab] = useState<NonNullable<
    AutomationsNavigationTarget["automationTab"]
  > | null>(null);
  // 版本号递增用于在「已经在商店」时重置内层导航，而不是重新挂载整个主视图。
  // 把它并入主视图 state 会丢失导航历史。
  const [pluginStoreOpenVersion, setPluginStoreOpenVersion] = useState(0);
  // 从设置退出时默认回到任务主视图；插件商店会用它作为回退目标。
  const handleNavigateToTaskMain = useCallback(() => {
    setWorkspaceMainView("chat");
  }, []);
  // 设置退出时必须保留「从哪个主视图进来」的信息；
  // 直接回 chat 会让从插件商店进入设置的用户丢失上下文。
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  // 深链目标（automationId/tab）与主视图一起设置，消费方读完必须回调清空，避免下次进入重复定位。
  const handleNavigateToAutomationsMain = useCallback((target: AutomationsNavigationTarget) => {
    setOpenAutomationId(target.automationId ?? null);
    setOpenAutomationTab(target.automationTab ?? null);
    setWorkspaceMainView("automations");
  }, []);
  // 进入插件商店同时递增导航版本，保证已在商店时也能重置内层页面；
  // 先 preserve 设置退出意图，否则从设置跳商店后返回会弹回设置。
  const handleNavigateToPluginStoreMain = useCallback(() => {
    setPluginStoreOpenVersion((version) => version + 1);
    preserveNextSettingsExit();
    setWorkspaceMainView("plugin-store");
  }, [preserveNextSettingsExit]);
  // 深链被消费后必须清空，否则重新进入自动化页会再次跳到旧目标。
  // 清空必须同时写 openAutomationId 与 openAutomationTab，只清 id 会让下次进入沿用旧 tab。
  // 清空 id 与 tab 必须成对，不能只清一个。
  const handleOpenAutomationConsumed = useCallback(() => {
    setOpenAutomationId(null);
    setOpenAutomationTab(null);
  }, []);
  // 中枢深链（「已保存」芯片 → 那个工作流的详情页）：中枢定位后由它回调清空。
  // 工作流中枢的深链状态挂在 App，使「完成卡 → 已保存」能跨主视图传递。
  const [openWorkflow, setOpenWorkflow] = useState<SavedWorkflowsOpenTarget | null>(null);
  // 中枢消费深链后立即清空；否则再次进入自动化页会重复定位到同一个工作流。
  // 清空动作必须保持引用稳定（useCallback 空依赖）。
  const handleOpenWorkflowConsumed = useCallback(() => setOpenWorkflow(null), []);
  const {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    // 任务前进/后退的 canGoBack 与 canTaskNavBack 是两套语义：
    // 前者含主视图回退（插件商店），后者只算任务历史；快捷键必须分别使用。
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath,
    workspaceIdentity,
    activateTabByPath,
    onNavigateToTask: handleNavigateToTaskMain,
    onNavigateToAutomations: handleNavigateToAutomationsMain,
    onNavigateToPluginStore: handleNavigateToPluginStoreMain,
  });
  // 完成卡「已保存」芯片的落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
  // run, and running it again」）：走「自动化」入口的同一条导航（进历史、切主视图），落在「工作流」
  // 标签，再由深链把中枢定位到那一页。项目档按 workspaceKey 找组，全局档只要名字。
  // 项目档按 workspaceKey 找组，全局档按名字；
  // [失败路径] 项目档少了 workspaceIdentity 会落到错误分组，表现为「点了已保存但打不开」。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      setOpenWorkflow(
        target.scope === "global"
          ? { scope: "global", name: target.name }
          : {
              scope: "project",
              name: target.name,
              workspaceKey: resolveWorkspaceKey({
                workspacePath: target.workspacePath,
                ...(target.workspaceIdentity
                  ? { workspaceIdentity: target.workspaceIdentity }
                  : {}),
              }),
            },
      );
      handleOpenAutomations(undefined, "workflow");
    },
    [handleOpenAutomations],
  );
  // 已在该主视图时重复打开只重置市场内导航版本，不重复进入，避免闪回首页。
  const handleOpenPluginStoreForScope = useCallback(
    (_target: PluginStoreOpenTarget = {}) => {
      // 管理范围由市场内视图持有，重复打开只重置市场导航。
      if (workspaceMainView === "plugin-store") {
        setPluginStoreOpenVersion((version) => version + 1);
        return;
      }
      handleOpenPluginStore();
    },
    [handleOpenPluginStore, workspaceMainView],
  );
  useEffect(
    // [资源] 监听器由 effect 返回的 disposer 注销；每次 handler 引用变化都会重订阅，所以 handler 必须 memo。
    () => addPluginStoreOpenListener(handleOpenPluginStoreForScope),
    [handleOpenPluginStoreForScope],
  );
  // [权衡] 上/下一个会话在触发瞬间用 getState 取最新 task meta，
  // 不订阅 taskQueryCache：流式事件高频写入会让整个 shell 每轮重渲染。
  // fallbackTaskIds 保证 query cache 尚未填充时也能导航。
  const handleSelectAdjacentConversation = useCallback(
    (direction: "previous" | "next") => {
      runVisibleWorkspaceCommand(() => {
        const sessionState = useZCodeSessionStore.getState();
        const workspaceState = sessionState.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        const fallbackTaskIds = getVisibleTaskMetas(workspaceState).map((task) => task.taskId);
        const taskQueryCacheState = useTaskQueryCacheStore.getState();
        // 性能修复：task meta 在恢复和流式事件期间会高频写入 query cache。
        // 上/下一个会话只在快捷键触发时需要最新快照，不能让 App 订阅整个 cache 后带动 shell 重渲染。
        const quickPickConversationNavigation = resolveQuickPickConversationNavigation({
          taskIds: selectQuickPickConversationTaskIds({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            resultsByQueryKey: taskQueryCacheState.resultsByQueryKey,
            taskMetaByEntityKey: taskQueryCacheState.taskMetaByEntityKey,
            fallbackTaskIds,
          }),
          activeTaskId,
        });
        const targetTaskId =
          direction === "previous"
            ? quickPickConversationNavigation.previousTaskId
            : quickPickConversationNavigation.nextTaskId;
        if (!targetTaskId) {
          return;
        }

        handleSelectTask(workspaceAbsPath, targetTaskId, workspaceIdentity);
      });
    },
    [
      activeTaskId,
      handleSelectTask,
      runVisibleWorkspaceCommand,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  // 方向包装器只做参数绑定，不重复实现导航；两个方向必须共用同一份 task 快照逻辑。
  // 复制一份实现会让上/下个会话的边界判定分叉。
  const handleSelectPreviousConversation = useCallback(() => {
    handleSelectAdjacentConversation("previous");
  }, [handleSelectAdjacentConversation]);
  // 两个方向共用同一实现，只是参数不同；新增方向时不要复制逻辑。
  const handleSelectNextConversation = useCallback(() => {
    handleSelectAdjacentConversation("next");
  }, [handleSelectAdjacentConversation]);
  // 主视图返回按视图分派：插件商店回任务页，其余回任务历史；
  // 把两者统一成 taskNavBack 会让商店里的返回直接跳回上一个任务。
  // 与 canPrimaryNavigationBack 必须成对维护。
  const handlePrimaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleNavigateToTaskMain : handleTaskNavBack;
  // 插件商店把「返回」解释为回任务主视图，因此即使没有任务历史也要可用。
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  // 面板 id 列表必须是稳定引用，布局组件会以它做 memo 边界。
  const shellPanelIds = useMemo(() => ["sidebar", "content"], []);

  // INV-11：所有快捷键回调都套 runVisibleWorkspaceCommand；
  // [失败路径] navigateBack 只在 canPrimaryNavigationBack 时注册，否则传 null 让按键穿透给系统；
  // toggleSidePaneFullView 在非桌面时同样传 null，避免占键。
  useAppKeyboard({
    openCommandCenter: handleOpenQuickPick,
    // 打开设置页：与设置入口按钮共用 tabStore.openSettingsTab；默认 ⌘,/Ctrl+,（系统惯例）
    openSettings: openSettingsTab,
    findInTask: handleOpenTaskFind,
    toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
    switchTheme: handleSwitchTheme,
    toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
    // ⌥⌘B 与 header 最右侧按钮共用同一条 toggle 入口，
    // 避免快捷键和按钮行为漂移；空面板的展示统一由 Open tab 空态承接。
    toggleSidePane: () => runVisibleWorkspaceCommand(handleToggleSidePane),
    toggleSidePaneFullView: supportsSidePaneFullView
      ? () => runVisibleWorkspaceCommand(handleToggleSidePaneFullView)
      : null,
    previousConversation: handleSelectPreviousConversation,
    nextConversation: handleSelectNextConversation,
    navigateBack: canPrimaryNavigationBack
      ? () => runVisibleWorkspaceCommand(handlePrimaryNavigationBack)
      : null,
    navigateForward: canTaskNavForward
      ? () => runVisibleWorkspaceCommand(handleTaskNavForward)
      : null,
  });

  useEffect(() => {
    let disposed = false;

    // [失败路径] 能力探测失败按「不可用」处理（catch 里置 false）；
    // 不能在失败时保持初始值，否则会给用户一个点了没反应的入口。
    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(visible);
        }
      },
      () => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(false);
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [locale, platform]);

  // INV-16：命令组必须 memo，且依赖里只放布尔/稳定回调和 label；
  // [权衡] 依赖完整 user 对象会在 auth store 返回等价新引用时重建整组命令闭包。
  const quickPickCommands = useMemo(
    () =>
      createQuickPickCommands({
        supportsTerminal: !isOfficeMode,
        supportsReview: !isOfficeMode,
        allowOpenWorkspace,
        canOpenCommunity: canOpenCommunityFromQuickPick,
        isSidebarVisible,
        supportsEmbeddedBrowser,
        // quick pick 命令只关心登录态布尔值。
        // 如果依赖完整 user 对象，auth store 返回等价新引用时会重建整组 command/run 闭包。
        isLoggedIn,
        themeTarget,
        shortcuts: {
          newTask: newTaskShortcutLabel,
          openWorkspace: openWorkspaceShortcutLabel,
          toggleSidebar: toggleSidebarShortcutLabel,
          toggleTerminal: toggleTerminalShortcutLabel,
        },
        handlers: {
          createTask: () => runVisibleWorkspaceCommand(() => handleCreateTaskIfWritable()),
          openWorkspace: () => runVisibleWorkspaceCommand(onOpenWorkspace),
          openSettings: openSettingsTab,
          openSkillsSettings: () => {
            setPendingSettingsPluginIntent("skills");
            openSettingsTab();
          },
          openMcpSettings: () => {
            setPendingSettingsPluginIntent("mcps");
            openSettingsTab();
          },
          switchTheme: handleSwitchTheme,
          openFeedback: handleOpenFeedback,
          openCommunity: handleOpenCommunity,
          openProductDocs: handleOpenProductDocs,
          login: onLogin,
          logout: onLogout,
          toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
          toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
          togglePreview: () => runVisibleWorkspaceCommand(handleToggleBrowser),
          openTerminalTab: () => runVisibleWorkspaceCommand(handleOpenTerminalTabIfWritable),
          openBrowserTab: () => runVisibleWorkspaceCommand(handleOpenBrowserTab),
          openReviewTab: () => runVisibleWorkspaceCommand(handleOpenGitIfWritable),
        },
      }),
    [
      allowOpenWorkspace,
      isOfficeMode,
      canOpenCommunityFromQuickPick,
      handleOpenCommunity,
      handleOpenFeedback,
      handleOpenProductDocs,
      handleOpenSettingsSection,
      handleSwitchTheme,
      handleOpenBrowserTab,
      handleOpenGitIfWritable,
      handleOpenTerminalTabIfWritable,
      handleToggleBrowser,
      handleToggleSidebar,
      handleToggleTerminalIfWritable,
      isLoggedIn,
      isSidebarVisible,
      newTaskShortcutLabel,
      handleCreateTaskIfWritable,
      onLogin,
      onLogout,
      onOpenWorkspace,
      runVisibleWorkspaceCommand,
      openSettingsTab,
      openWorkspaceShortcutLabel,
      supportsEmbeddedBrowser,
      toggleSidebarShortcutLabel,
      toggleTerminalShortcutLabel,
      themeTarget,
    ],
  );
  // INV-16：对象 prop 内联创建会让 shell 在每次流式刷新时看到新引用；
  // 这里 memo 后整体下传，内部字段变化仍需在依赖里逐项列出。
  const taskFindDialogProps = useMemo<TaskFindDialogProps>(
    () => ({
      open: isTaskFindOpen,
      focusRequestId: taskFindFocusRequestId,
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      conversationMatchCount: conversationFindMatchCount,
      conversationMatchIndex: conversationFindState.activeIndex,
      fileChangeMatchCount: fileChangeFindMatchCount,
      fileChangeMatchIndex: fileChangeFindState.activeIndex,
      onOpenChange: handleTaskFindOpenChange,
      onConversationFindChange: handleConversationFindChange,
      onConversationFindNavigate: handleConversationFindNavigate,
      onFileChangeFindChange: handleFileChangeFindChange,
      onFileChangeFindNavigate: handleFileChangeFindNavigate,
      onOpenFileChanges: handleOpenGitIfWritable,
    }),
    [
      conversationFindMatchCount,
      conversationFindState.activeIndex,
      fileChangeFindMatchCount,
      fileChangeFindState.activeIndex,
      handleConversationFindChange,
      handleConversationFindNavigate,
      handleFileChangeFindChange,
      handleFileChangeFindNavigate,
      handleOpenGitIfWritable,
      handleTaskFindOpenChange,
      isLinuxDesktop,
      isMacDesktop,
      isTaskFindOpen,
      isWindowsDesktop,
      taskFindFocusRequestId,
    ],
  );

  return (
    <>
      <CommandCenterDialog
        open={isQuickPickOpen}
        commands={quickPickCommands}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        activeTaskChangeSummary={activeTaskChangeSummary}
        workspaceTabs={commandCenterWorkspaceTabs}
        onOpenChange={setIsQuickPickOpen}
        onSelectTask={handleSelectTask}
        onSearchResultHighlightRequest={handleSearchResultHighlightRequest}
        onOpenCodeViewer={handleOpenCodeViewerIfWritable}
      />
      {/* Bugfix: 反馈是应用级能力，必须固定走本机 base host；SSH session 连接中或断开时，
          workspace-scoped services 会切成断连代理，不能让反馈提交跟随远程 session 失效。 */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
      <PluginUiWorkspaceProvider onOpenSidePane={handleOpenPluginUi}>
        <WorkspaceShellLayout
          services={services}
          workspaceReadOnlyReason={workspaceReadOnlyReason}
          workspaceMainView={workspaceMainView}
          pluginStoreOpenVersion={pluginStoreOpenVersion}
          openAutomationId={openAutomationId}
          openAutomationTab={openAutomationTab}
          openWorkflow={openWorkflow}
          onOpenWorkflowConsumed={handleOpenWorkflowConsumed}
          onOpenSavedWorkflowInHub={handleOpenSavedWorkflowInHub}
          onWorkspaceMainViewChange={setWorkspaceMainView}
          onOpenAutomationConsumed={handleOpenAutomationConsumed}
          handleOpenAutomations={handleOpenAutomations}
          handleOpenPluginStore={handleOpenPluginStoreForScope}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
          onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
          onLogout={onLogout}
          onLogin={onLogin}
          user={user}
          reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
          remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
          remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
          remoteConnectionLogs={remoteConnectionLogs}
          onCreateTask={handleCreateTaskIfWritable}
          onCreateConversationTask={onCreateConversationTask}
          onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
          onResolveConversationWorkspace={onResolveConversationWorkspace}
          onOpenWorkspace={onOpenWorkspace}
          onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          remoteConnectionInProgress={remoteConnectionInProgress}
          allowOpenWorkspace={allowOpenWorkspace}
          webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
          initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
          initialWebRemoteControlMobileNavigationIntent={
            initialWebRemoteControlMobileNavigationIntent
          }
          webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
          allowRemoteWorkspace={allowRemoteWorkspace}
          workspaceAbsPath={workspaceAbsPath}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          workspaceIdentity={workspaceIdentity}
          isWorkspaceVisible={isWorkspaceVisible}
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          workspaceShellZCodeState={workspaceShellZCodeState}
          theme={theme}
          isMacFullscreen={isMacFullscreen}
          desktopWindowChromeState={desktopWindowChromeState}
          macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
          updateReadyVersion={updateReadyVersion}
          updateState={updateState}
          sidebarContainerRef={sidebarContainerRef}
          toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
          newTaskShortcutLabel={newTaskShortcutLabel}
          goBackShortcutLabel={goBackShortcutLabel}
          goForwardShortcutLabel={goForwardShortcutLabel}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          toggleSidePaneFullViewShortcutLabel={toggleSidePaneFullViewShortcutLabel}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          canTaskNavBack={canTaskNavBack}
          canTaskNavForward={canTaskNavForward}
          isTerminalOpen={isTerminalOpen}
          isSidebarVisible={isSidebarVisible}
          isBrowserOpen={isBrowserOpen}
          supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          isGitOpen={isGitOpen}
          isSidePaneOpen={isSidePaneOpen}
          sidePaneFullView={supportsSidePaneFullView ? sidePaneFullView : undefined}
          summaryPanelVariantOverride={summaryPanelVariantOverride}
          onSummaryPanelVariantOverrideChange={setSummaryPanelVariantOverride}
          sidePaneState={sidePaneState}
          recentClosedSidePaneTabs={recentClosedSidePaneTabs}
          shellPanelIds={shellPanelIds}
          projectName={projectName}
          workspaceTabs={workspaceTabs}
          activeTaskId={activeTaskId}
          sidePaneOwnerId={sidePaneOwnerId}
          activeTraceId={activeTraceId}
          activeSessionId={activeSessionId}
          activeTaskProvider={activeTaskProvider}
          resolvedActiveTaskMeta={resolvedActiveTaskMeta}
          activeTaskTitle={activeTaskTitle}
          activeTaskChangeSummary={activeTaskChangeSummary}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          gitWorktreeChangeSummary={gitWorktreeChangeSummary}
          activeGitSourceId={activeGitSourceId}
          gitState={gitState}
          browserNavigationRequest={browserNavigationRequest}
          browserRestoreUrls={browserRestoreUrls}
          providerConfigFile={providerConfigFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          taskSessionFile={taskSessionFile}
          conversationFindActiveIndex={conversationFindState.activeIndex}
          conversationFindNavigationRequestId={conversationFindState.navigationRequestId}
          conversationFindQuery={conversationFindState.query}
          onConversationFindMatchStateChange={handleConversationFindMatchStateChange}
          searchResultHighlightRequest={searchResultHighlightRequest}
          onSearchResultHighlightDone={handleSearchResultHighlightDone}
          fileChangeFindActiveIndex={fileChangeFindState.activeIndex}
          fileChangeFindNavigationRequestId={fileChangeFindState.navigationRequestId}
          fileChangeFindQuery={fileChangeFindState.query}
          onFileChangeFindMatchCountChange={setFileChangeFindMatchCount}
          appLogoUrl={appLogoUrl}
          platform={platform}
          reloadSessionDisabled={reloadSessionDisabled}
          reloadSessionPending={reloadSessionPending}
          handleReloadSession={handleReloadSession}
          handleSelectTask={handleSelectTask}
          handleTaskNavBack={handleTaskNavBack}
          handleTaskNavForward={handleTaskNavForward}
          handleStartDraftInWorkspace={handleStartDraftInWorkspace}
          handleOpenCommandCenter={handleOpenQuickPick}
          handleRefreshGit={handleRefreshGit}
          handleOpenGitReview={handleOpenGitReview}
          handleBrowserUrlChange={handleBrowserUrlChange}
          handleBrowserPageMetadataChange={handleBrowserPageMetadataChange}
          handleToggleSidebar={handleToggleSidebar}
          handleToggleTerminal={handleToggleTerminalIfWritable}
          handleToggleBrowser={handleToggleBrowser}
          handleOpenBrowserTab={handleOpenBrowserTab}
          handleOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
          handleOpenWhiteboard={handleOpenWhiteboard}
          handleOpenDeveloperTools={handleOpenDeveloperTools}
          handleOpenFileManager={handleOpenFileManager}
          handleNavigateFileManager={handleNavigateFileManager}
          handleOpenPluginMarket={handleOpenPluginMarket}
          handleOpenTerminalTab={handleOpenTerminalTabIfWritable}
          handleToggleGit={handleToggleGitIfWritable}
          handleToggleSidePane={handleToggleSidePane}
          handleOpenBrowserUrl={handleOpenBrowserUrl}
          handleOpenCodeViewer={handleOpenCodeViewerIfWritable}
          handleAutoOpenAssistantPptx={handleAutoOpenAssistantPptx}
          handleOpenSubagentSession={handleOpenSubagentSession}
          handleOpenBackgroundBash={handleOpenBackgroundBash}
          handleOpenSubagentDirectory={handleOpenSubagentDirectory}
          handleSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
          handleOpenSelectionSideChat={handleOpenSelectionSideChat}
          handleOpenPlanDetail={handleOpenPlanDetail}
          handleOpenWorkflowRun={handleOpenWorkflowRun}
          handleOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
          handleOpenWorkflowActorSession={handleOpenWorkflowActorSession}
          handleOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
          handleOpenWorkflowArtifact={handleOpenWorkflowArtifact}
          handleCloseCodeViewer={handleCloseCodeViewer}
          handleCloseGit={handleCloseGit}
          handleActivateSidePaneTab={handleActivateSidePaneTab}
          handleOpenNewSidePaneTab={handleOpenNewSidePaneTab}
          handleReorderSidePaneTab={handleReorderSidePaneTab}
          handleCloseSidePaneTab={handleCloseSidePaneTab}
          handleCloseOtherSidePaneTabs={handleCloseOtherSidePaneTabs}
          handleCloseAllSidePaneTabs={handleCloseAllSidePaneTabs}
          handleReopenClosedSidePaneTab={handleReopenClosedSidePaneTab}
          handleBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
          setIsTerminalOpen={setIsTerminalOpen}
          setGitSelectedSourceId={setGitSelectedSourceId}
          // taskFindDialogProps 是对象 prop，内联创建会让 shell 在流式刷新中每轮都看到新引用。
          taskFindDialogProps={taskFindDialogProps}
        />
      </PluginUiWorkspaceProvider>
    </>
  );
}
