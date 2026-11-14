/* oxlint-disable eslint(max-lines) -- V4WorkspaceChatArea 是分屏 workbench 宿主，集中管理 pane layout/focus/session binding；拆散会让 store action 和 shell binding 链路跨文件跳转。 */
// V4WorkspaceChatArea：分屏 workbench 宿主，只负责把 paneLayoutStore / workbenchGroupStore 的
// 布局树投影成绝对定位矩形，并协调焦点与 shell 级 session 绑定的单向同步。
// 不负责：连接复用、会话恢复校验、消息渲染与侧栏路由——这些分别属于 registry、LeafPane 与 shell。
//
// INV-01 断言：workspace 身份键统一取 identity 去空格后回退 path —— 守住它的位置：shellWorkspaceKey 及其全部下游比较 —— 改错故障：远程 workspace 与本地同路径被错合并，pane 绑定串到别的仓库
// INV-02 断言：compactForRemoteControl 时布局必须退化为单叶 PRIMARY_LEAF —— 守住它的位置：root、panes、focusedPaneId 三处三元分支 —— 改错故障：远控端渲染出桌面分屏并复用他人 binding，触控区与 session 错配
// INV-03 断言：activeGroup 存在时 paneLayoutStore 完全不参与读取 —— 守住它的位置：root、panes、focusedPaneId 的 ?? 回退 —— 改错故障：group 激活后旧 split 的 pane 仍被渲染，同一 session 出现两份视图
// INV-04 断言：primary pane 的 binding 永远不从 paneLayout.panes 取 —— 守住它的位置：resolvePaneSessionBinding 的主 pane 分支与 JSX 的 binding 传参 —— 改错故障：primary 读到残留绑定，草稿态直接显示旧会话
// INV-05 断言：被 split pane 接管的 shell session 必须对 primary 置空 —— 守住它的位置：shellSessionOwnedBySplitPane 与 primaryPaneSessionId —— 改错故障：拖入会话后左右 pane 同时加载同一 session，双写与滚动互跳
// INV-06 断言：shell.activeSessionId 始终保留真实 active task，不随 primaryPaneSessionId 置空 —— 守住它的位置：shell useMemo 中两个 session 字段并存 —— 改错故障：划词辅助对话路由到空值，选中文本后建不出 side chat
// INV-07 断言：readOnly 的 subagent pane 不得反写 shell activeTaskId —— 守住它的位置：syncShellActiveSession 首个提前返回 —— 改错故障：左侧任务列表高亮跳到子代理会话，父任务从导航消失
// INV-08 断言：activeTaskChangeSummary 只在 primary 真正持有会话时下发 —— 守住它的位置：shell 中该字段的条件表达式 —— 改错故障：primary 已置空仍展示上一会话的增删行数，用户看到陈旧 diff 统计
// INV-09 断言：关闭 pane 必须先算出下一个可导航 binding 再调 store —— 守住它的位置：handleClosePane 的前置计算 —— 改错故障：store 先塌缩后焦点已失效，shell 停在已关闭 session，输入框静默失效
// INV-10 断言：关闭 group 内 primary 且 group 未塌缩时回退到 primaryBinding —— 守住它的位置：handleClosePane 的三元嵌套 —— 改错故障：group 还有其他 pane 但 shell 落到空值，左侧任务取消选中
// INV-11 断言：promotion 是布局 owner 转移而非复制双写 —— 守住它的位置：handleBindSession 中 promote 后紧跟 resetPaneLayoutAction —— 改错故障：刷新或 group 回收后旧 split 复活，与新 group 争抢同一 session
// INV-12 断言：draft primary 首发 accepted 时必须把新 session 固定为 primaryBinding —— 守住它的位置：handleBindSession 的 panes 非空分支 —— 改错故障：已绑定的 secondary 抢走 shell active，primary 退回草稿、消息流消失
// INV-13 断言：非 primary draft 首发时先用旧 shell session 作 primaryBinding 再提升 —— 守住它的位置：handleBindSession 末段的 promote 参数 —— 改错故障：primary 跟随新 pane 显示右侧会话，原会话被顶掉
// INV-14 断言：pane 的 key 只能用 paneId，禁止拼 session 或索引 —— 守住它的位置：JSX 中 layout.leaves.map 的 key —— 改错故障：拆分或关闭导致存活 pane 重挂，草稿、滚动位置与正在跑的流全丢
// INV-15 断言：floating 单视图下其余 pane 只隐藏不卸载 —— 守住它的位置：soloPaneId 与 hidden 属性 —— 改错故障：切回分屏时各 pane 重新建连并重放历史，流式回答中断
// INV-16 断言：focused 必须与 foregroundEnabled 相与 —— 守住它的位置：JSX 中 focused 的计算 —— 改错故障：Settings 打开时隐藏 pane 抢先消费一次性 Composer 预填，返回后输入框为空
// INV-17 断言：分隔条占比拖动中只写 CSS 变量，store 仅在提交时更新 —— 守住它的位置：containerStyle 与 onCommitRatio —— 改错故障：每次 pointermove 触发整树重渲染，拖动卡顿且布局闪烁
// INV-18 断言：恢复确认必须按 group 与普通布局分派到各自 store —— 守住它的位置：handleConfirmRestoredSession 分支 —— 改错故障：group 内恢复的 pane 校验写到 paneLayoutStore，会话一直处于待验证
// INV-19 断言：shell scope 的缺省字段不得写成空串 —— 守住它的位置：shellScope 的对象展开 —— 改错故障：空 remoteSessionId 被当成远程作用域，本地会话被错误隔离成不可恢复
import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentDirectorySideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  effectiveFocusedPaneId,
  paneWorkspaceKey,
  PRIMARY_LEAF,
  usePaneLayoutStore,
  V4_PRIMARY_PANE_ID,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import {
  collectWorkbenchLayout,
  dividerStyle,
  FULL_WORKBENCH_RECT,
  SPLIT_VAR_PREFIX,
} from "@/v4/workbenchLayout.js";
import { useConversationPanePresentation } from "@/side-pane-full-view/index.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { WorkbenchSplitDivider } from "@/v4/WorkbenchSplitDivider.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  closeWorkbenchGroupPane,
  selectWorkbenchGroupActiveBinding,
  selectWorkbenchGroupPaneBinding,
  useWorkbenchGroupStore,
  type WorkbenchSessionBinding,
} from "@/v4/workbenchGroupStore.js";

export interface V4WorkspaceChatAreaProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop；Web / 手机远控保留 UI 行为但不触发该事件。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  allowEscapeStopOutsidePane?: boolean;
  /** Settings 等覆盖层打开时为 false，隐藏 Pane 不得消费一次性 Composer 请求。 */
  foregroundEnabled?: boolean;
  remoteSessionId?: string;
  compactForRemoteControl?: boolean;
  /** primary pane 绑定的 CLI session（既有选择态 activeTaskId）；null = draft。 */
  sessionId: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  /** primary pane createSession/fork 后接入既有选择路径（handleSelectTask）。 */
  onSessionCreated?: (sessionId: string) => void;
  /** primary pane 会话删除后回 draft（shell 起新草稿）。 */
  onSessionDeleted?: () => void;
  /**
   * 草稿态 composer contextHeader（m5：workspace 菜单 + Git 分支），
   * 仅下发给 primary pane——其余 pane 的 draft 不承载壳级 workspace 切换。
   */
  draftComposerHeader?: ReactNode;
  /** 桌面轻量草稿标题栏复用主草稿 composer 的 drop controller。 */
  onPrimaryDraftDropTargetControllerChange?: (
    controller: ConversationDropTargetController | null,
  ) => void;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs?: (request: SyncSubagentSessionTabsRequest) => void;
  onOpenSelectionSideChat?: (request: OpenSelectionSideChatRequest) => void;
  onOpenPlanDetail?: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  onOpenWorkflowRunDirectory?: (request: OpenScopedWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
}

/**
 * 分屏 workspace 主聊天区：多 pane 跨 workspace 工作台
 *
 * - 布局：paneLayoutStore 的二叉分割树 → 绝对定位 rect（CSS 变量驱动占比）；
 *   叶子扁平渲染（key = paneId），拆分/关闭不重挂任何存活 pane。
 * - 数据面：每个 pane 一个 V4PaneConversationProvider——连接经
 *   workspaceConnectionRegistry 按 endpoint+workspaceKey 引用计数复用
 *   （同 workspace 的 pane 共享一条 transport + SessionDataLayer）。
 * - primary pane 绑定沿用 activeTaskId（shell props，随 workspace tab 切换）；
 *   其余 pane 绑定归 paneLayoutStore，自带 workspaceScope、跨 tab 常驻。
 * - Focus 层：快捷键（Esc stop）/add-to-chat 只路由到 focused pane。
 * - 恢复守卫：restoredUnvalidated pane 各自经其 scope 的 sessions-index 验证。
 */
export function V4WorkspaceChatArea({
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  readOnly = false,
  allowEscapeStopOutsidePane = false,
  foregroundEnabled = true,
  remoteSessionId,
  compactForRemoteControl = false,
  sessionId,
  activeSelectionSideChatSessionId = null,
  provider,
  onSessionCreated,
  onSessionDeleted,
  draftComposerHeader,
  onPrimaryDraftDropTargetControllerChange,
  gitSummary,
  gitDirtyFileCount,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  onRefreshGit,
  onOpenGitReview,
  onPaneActiveSessionChange,
  onOpenBrowserUrl,
  onOpenAutomationsMain,
  onOpenCodeViewer,
  onAutoOpenAssistantPptx,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenSelectionSideChat,
  onOpenPlanDetail,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  onOpenWorkflowRunDirectory,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
}: V4WorkspaceChatAreaProps) {
  const shellWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  // selector 返回 store 内既有引用/派生原语，未变化不触发重渲染。
  // [契约] 这三个 selector 只取 store 内既有引用与派生原语：root 是冻结的拆分二叉树，
  // panes 是 paneId 到 binding 的字典，聚焦值由 effectiveFocusedPaneId 派生。
  // 拆成多个窄 selector 而不是订阅整个 state，是为了让抽屉之外的变更不触发本层重渲染。
  // 不要把它们合并成返回新对象的 selector，新对象每次都不相等，本组件会逐帧重渲染。
  // 也不要在渲染期读 getState 参与派生，否则 store 提交后拿不到新的聚焦结果。
  const paneRoot = usePaneLayoutStore((state) => state.root);
  const paneBindings = usePaneLayoutStore((state) => state.panes);
  const paneFocusedPaneId = usePaneLayoutStore((state) => effectiveFocusedPaneId(state));
  // zustand action 引用稳定。
  const closePaneAction = usePaneLayoutStore((state) => state.closePane);
  const confirmRestoredPaneSessionAction = usePaneLayoutStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const focusPaneAction = usePaneLayoutStore((state) => state.focusPane);
  const bindPaneSessionAction = usePaneLayoutStore((state) => state.bindPaneSession);
  const setSplitRatioAction = usePaneLayoutStore((state) => state.setSplitRatio);
  const resetPaneLayoutAction = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  // [权衡] 远控模式下直接返回 null，不是省一次判断，而是禁止远控端触碰本窗口的 group 状态：
  // 远控链路只承载一份 primary 视图，group 属于桌面本地布局，混进来会破坏单视图假设。
  // activeGroupId 为空同样返回 null，避免 shell 在 group 与 paneLayout 之间双写两套绑定。
  // 取值用 groups[id] 加空值兜底，兜住已被回收的 group id，否则切换 tab 会读到 undefined。
  // 不要在这里补找不到就重建 group 的保底分支，重建会产生第二个布局 owner。
  const activeGroup = useWorkbenchGroupStore((state) =>
    compactForRemoteControl || !state.activeGroupId
      ? null
      : (state.groups[state.activeGroupId] ?? null),
  );
  const focusGroupPaneAction = useWorkbenchGroupStore((state) => state.focusPane);
  const closeGroupPaneAction = useWorkbenchGroupStore((state) => state.closePane);
  const confirmRestoredGroupPaneSessionAction = useWorkbenchGroupStore(
    (state) => state.confirmRestoredPaneSession,
  );
  const bindGroupPaneSessionAction = useWorkbenchGroupStore((state) => state.bindPaneSession);
  const setGroupSplitRatioAction = useWorkbenchGroupStore((state) => state.setSplitRatio);
  const promotePaneLayoutToGroupAction = useWorkbenchGroupStore(
    (state) => state.promotePaneLayoutToGroup,
  );

  const containerRef = useRef<HTMLDivElement | null>(null);

  // [契约] 下面三行同构的三元共同决定这一帧渲染哪套布局：远控单叶、激活 group、或本窗口布局。
  // 三者必须一起切换，只改其中一行会让 root 与 panes 的来源错位，
  // 典型症状是 group 的 root 配上 paneLayout 的 binding，某个 pane 显示别人的会话。
  // 这里不再套 memo：root 本身就是 store 引用，多包一层只会引入过期快照。
  // 聚焦值同理来自同一层级，一旦与 root 来源不同，键盘与快捷键路由会指向不存在的 pane。
  const root = compactForRemoteControl ? PRIMARY_LEAF : (activeGroup?.root ?? paneRoot);
  const panes = compactForRemoteControl ? {} : (activeGroup?.panes ?? paneBindings);
  const focusedPaneId = compactForRemoteControl
    ? V4_PRIMARY_PANE_ID
    : (activeGroup?.focusedPaneId ?? paneFocusedPaneId);
  const layout = useMemo(() => collectWorkbenchLayout(root), [root]);
  // [契约] 这里判断 shell 的 active task 是否已被同 workspace 的 split pane 接管。
  // 三个前置条件缺一不可：远控单叶没有 pane、group 模式由 group 自己管绑定、草稿态没有 session。
  // 比较时同时匹配 sessionId 与 paneWorkspaceKey，不能只比 sessionId：同名会话可能存在于
  // 另一个 workspace，误判会让 primary 无谓置空、草稿被清。依赖数组必须含 paneBindings，
  // binding 变化后这个布尔值才可能翻转。
  const shellSessionOwnedBySplitPane = useMemo(() => {
    if (compactForRemoteControl || activeGroup || !sessionId) {
      return false;
    }
    return Object.values(paneBindings).some(
      (binding) =>
        binding.sessionId === sessionId &&
        paneWorkspaceKey(binding.workspaceScope) === shellWorkspaceKey,
    );
  }, [activeGroup, compactForRemoteControl, paneBindings, sessionId, shellWorkspaceKey]);
  // 修复原因：primary draft 没有自己的 sessionId；拖入 session 时 shell active
  // 可能已经切到右侧 pane 的 session，不能再把这个 sessionId 下发给 primary。
  // [失败路径] 这里的 null 是刻意置空，不是漏传：primary draft 没有自己的 sessionId，
  // 拖入会话时 shell active 可能已经切到右侧 pane，不能再把这个 session 下发给 primary。
  // 若把空值换回 sessionId，左右两个 pane 会同时挂载同一 session，输入队列双写、
  // 流式 token 重复渲染、滚动位置互相拉扯。
  // 下游所有 primary 是否有会话的判断都以这个变量为准，不要改回用 sessionId。
  const primaryPaneSessionId = shellSessionOwnedBySplitPane ? null : sessionId;

  // 占比接线：store 值只在提交（pointerup/恢复）时变化；拖动中由分隔条直写 CSS 变量。
  // [权衡] 分隔条占比的唯一写入口是 CSS 变量：拖动中由分隔条组件直写容器上的变量，
  // 只有 pointerup 与恢复布局时才回到 store 提交。这样 pointermove 不触发 React 重渲染，
  // pane 也不必重算矩形。变量名必须与 SPLIT_VAR_PREFIX 和 splitId 严格拼接，
  // 手写字符串会让拖动失效且不报错，表现为拖了分隔条没反应。
  // 恢复布局时同样依赖这些变量，提交路径断了首屏比例会全部回落到默认值。
  const containerStyle = useMemo<CSSProperties>(() => {
    const style: Record<string, string> = {};
    for (const divider of layout.dividers) {
      style[`${SPLIT_VAR_PREFIX}${divider.splitId}`] = String(divider.ratio);
    }
    return style as CSSProperties;
  }, [layout]);

  const paneCount = layout.leaves.length;
  const { presentation } = useConversationPanePresentation();
  // 完整视图浮窗只容纳一个对话：旧的拆分布局只显示焦点 pane，其余隐藏但保持挂载。
  // [资源] floating 完整视图只容纳一个对话：其余 pane 用 hidden 隐藏但保持挂载。
  // 不要改成条件渲染或返回空节点，卸载会让 pane 断连、丢草稿、丢正在流式输出的回答，
  // 切回分屏时还要重放历史，用户会看到明显闪烁与重复消息。
  // soloPaneId 只在 presentation 为 floating 且确实多于一个 pane 时生效，
  // 单 pane 时保持原布局，避免无谓地隐藏自己并多画一层遮罩。
  const soloPaneId = presentation === "floating" && paneCount > 1 ? focusedPaneId : null;
  const showFocusIndicator = paneCount > 1 && !soloPaneId;

  // [契约] shell scope 只由 workspace 三个代表字段构成，且空值字段不写入对象。
  // 展开写而不是直接赋 undefined，是为了让 paneWorkspaceKey 的序列化结果稳定：
  // 字段是否存在会影响键串，同一 workspace 因此可能被当成两个不同作用域。
  // 依赖数组必须带 workspaceIdentity 与 remoteSessionId，漏掉会让切换远程会话后
  // scope 仍是旧值，pane 绑定到错误终点、恢复校验打到别人的 sessions-index。
  const shellScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, workspacePath, workspaceIdentity],
  );

  // [契约] shell 是下发给每个叶子 pane 的只读绑定快照，字段语义不能互换。
  // sessionId 用 primaryPaneSessionId（可能为空），activeSessionId 用原始 sessionId：
  // 两者分离是为了 primary 被接管时划词路由仍能拿到真正的 active task。
  // activeTaskChangeSummary 只在 primary 真正持有会话时下发，否则会展示上一会话的增删统计。
  // 依赖数组漏任何一项都会让 pane 拿到旧闭包，表现是点了没反应或打开错的侧栏。
  const shell = useMemo<WorkbenchShellBinding>(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      isDesktop,
      compactForRemoteControl,
      readOnly,
      allowEscapeStopOutsidePane,
      sessionId: primaryPaneSessionId,
      // primaryPaneSessionId 在 active task 被 split pane 接管时会刻意置空，
      // 辅助对话划词路由仍需保留 shell 真正的 active task id。
      activeSessionId: sessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary: primaryPaneSessionId ? activeTaskChangeSummary : null,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    }),
    [
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
      readOnly,
      allowEscapeStopOutsidePane,
      primaryPaneSessionId,
      activeSelectionSideChatSessionId,
      provider,
      onSessionCreated,
      onSessionDeleted,
      draftComposerHeader,
      onPrimaryDraftDropTargetControllerChange,
      gitSummary,
      gitDirtyFileCount,
      gitWorktreeReviewSourceId,
      gitWorktreeChangeSummary,
      activeTaskChangeSummary,
      summaryPanelVariantOverride,
      onSummaryPanelVariantOverrideChange,
      onRefreshGit,
      onOpenGitReview,
      onOpenBrowserUrl,
      onOpenAutomationsMain,
      onOpenCodeViewer,
      onAutoOpenAssistantPptx,
      onOpenFileLink,
      onOpenSubagentSession,
      onOpenBackgroundBash,
      onOpenSubagentDirectory,
      onSyncSubagentSessionTabs,
      onOpenSelectionSideChat,
      onOpenPlanDetail,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
      onOpenWorkflowRunDirectory,
      onOpenWorkflowActorSession,
      onOpenWorkflowWorkspace,
      conversationFindQuery,
      conversationFindActiveIndex,
      conversationFindNavigationRequestId,
      onConversationFindMatchStateChange,
      searchResultHighlightRequest,
      onSearchResultHighlightDone,
    ],
  );

  // [契约] 绑定解析的优先级固定为：激活 group、primary、普通 pane，三段不可互换。
  // group 模式必须完全走 selectWorkbenchGroupPaneBinding，不得回落 paneBindings，
  // 否则 group 与旧 split 各持一份绑定，关闭 group 后旧 pane 会带着残留绑定复活。
  // primary 分支直接构造 scope 加 sessionId 的组合，不从 paneLayout.panes 取，
  // 因为 draft primary 本来不在 panes 里，残留 binding 会让草稿显示旧会话。
  const resolvePaneSessionBinding = useMemo(
    () =>
      (paneId: string): WorkbenchSessionBinding | null => {
        if (activeGroup) {
          return selectWorkbenchGroupPaneBinding(activeGroup, paneId);
        }
        if (paneId === V4_PRIMARY_PANE_ID) {
          return primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        }
        const binding = paneBindings[paneId];
        return binding?.sessionId
          ? {
              workspaceScope: binding.workspaceScope,
              sessionId: binding.sessionId,
              ...(binding.readOnly ? { readOnly: true } : {}),
            }
          : null;
      },
    [activeGroup, paneBindings, primaryPaneSessionId, shellScope],
  );

  // [失败路径] readOnly 的 subagent pane 只是 workbench 内的观察视图，不是左侧任务导航目标。
  // 提前返回是为了阻止反写：一旦把子代理 session 写成 shell activeTaskId，
  // 左侧高亮与乐观 task 会切到子会话，父任务从导航消失且很难返回。
  // binding 为空时同样返回，表示没有可导航目标，由调用方决定保持原状。
  // 不要在这里补回退到上一个 session 的逻辑，group 塌缩后回退目标已不可靠。
  const syncShellActiveSession = useCallback(
    (binding: WorkbenchSessionBinding | null) => {
      if (!binding || binding.readOnly) {
        return;
      }
      // readOnly subagent pane 只是 workbench 内观察视图，不是左侧
      // task 导航目标；反写 shell activeTaskId 会让左侧高亮/乐观 task 误切到 child。
      onPaneActiveSessionChange?.(binding.workspaceScope, binding.sessionId);
    },
    [onPaneActiveSessionChange],
  );

  // [契约] 聚焦是两段式：先改布局 store 的 focusedPaneId，再把该 pane 的绑定同步给 shell。
  // 顺序不能反：同步依赖 resolvePaneSessionBinding 读取当前 store 状态，
  // 先同步后聚焦会拿到切换前的绑定，左侧高亮与视觉焦点错位。
  // 点击 readOnly pane 时同步内部会自行跳过，这里不需要额外判断。
  // 该回调作为 prop 传给每个 pane，引用必须稳定，否则任意一次聚焦都会重挂整层叶子。
  const handleFocusRequest = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        focusGroupPaneAction(activeGroup.id, paneId);
      } else {
        focusPaneAction(paneId);
      }
      syncShellActiveSession(resolvePaneSessionBinding(paneId));
    },
    [
      activeGroup,
      focusGroupPaneAction,
      focusPaneAction,
      resolvePaneSessionBinding,
      syncShellActiveSession,
    ],
  );

  // [事务] 关闭分两步且不可交换：先在关闭前算出关闭后可导航的 binding，再调 store 塌缩。
  // store 关闭后 focusedPaneId 与绑定都已失效，事后再算只能得到空值，
  // 结果是 shell activeTaskId 停在已关闭的 session，输入框静默失效。
  // group 分支若关的是 focused pane，优先取新 group 的 active binding；
  // group 塌缩且关的是 primary 时回退 primaryBinding，其余情况显式置空。
  const handleClosePane = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        const nextGroup = closeWorkbenchGroupPane(activeGroup, paneId);
        const nextActiveBinding =
          activeGroup.focusedPaneId === paneId
            ? nextGroup
              ? selectWorkbenchGroupActiveBinding(nextGroup)
              : paneId === V4_PRIMARY_PANE_ID
                ? null
                : activeGroup.primaryBinding
            : null;
        closeGroupPaneAction(activeGroup.id, paneId);
        // close store 只负责布局塌缩；若被关 pane 正是 focused pane，
        // shell activeTaskId 必须回到关闭后的可导航 session，不能继续停在已关闭 session。
        syncShellActiveSession(nextActiveBinding);
      } else {
        const nextActiveBinding =
          focusedPaneId === paneId && primaryPaneSessionId
            ? { workspaceScope: shellScope, sessionId: primaryPaneSessionId }
            : null;
        closePaneAction(paneId);
        syncShellActiveSession(nextActiveBinding);
      }
    },
    [
      activeGroup,
      closeGroupPaneAction,
      closePaneAction,
      focusedPaneId,
      primaryPaneSessionId,
      shellScope,
      syncShellActiveSession,
    ],
  );

  const handleConfirmRestoredSession = useMemo(
    () => (paneId: string) => {
      if (activeGroup) {
        confirmRestoredGroupPaneSessionAction(activeGroup.id, paneId);
      } else {
        confirmRestoredPaneSessionAction(paneId);
      }
    },
    [activeGroup, confirmRestoredGroupPaneSessionAction, confirmRestoredPaneSessionAction],
  );

  const handleCommitSplitRatio = useMemo(
    () => (splitId: string, ratio: number) => {
      if (activeGroup) {
        setGroupSplitRatioAction(activeGroup.id, splitId, ratio);
      } else {
        setSplitRatioAction(splitId, ratio);
      }
    },
    [activeGroup, setGroupSplitRatioAction, setSplitRatioAction],
  );

  // [事务] 三种 owner 场景在此分派：group 内直接绑定；primary 首发需要 promotion；
  // 普通 pane 首发需要先把当前 paneLayout 提升为 group 再绑。
  // 不要在 group 分支里再做 promotion，group 已经是布局 owner，二次提升会造出两个 group，
  // shell 与两侧 pane 各自跟随不同的 root。返回值表示调用方是否还需自行同步 shell，
  // 只有普通 pane 的 promotion 结果影响它。依赖数组必须含 sessionId 与 shellScope。
  const handleBindSession = useMemo(
    () => (paneId: string, createdSessionId: string) => {
      if (activeGroup) {
        bindGroupPaneSessionAction(activeGroup.id, paneId, createdSessionId);
        return true;
      }
      if (paneId === V4_PRIMARY_PANE_ID) {
        // [事务] 先取一次 source 快照，后续 promotion 与 reset 都基于同一份布局，
        // 避免 promote 过程中 store 被其他事件改写，导致提升出的 group 与 reset 的对象不一致。
        // 判空用 panes 键数大于零：草稿 primary 不在 panes 里，只有存在真正拆出的 pane 时
        // 才需要把布局转成 group 以保住 primary 身份。
        // 不要在这里顺手聚焦新 session，焦点切换由上层同步 shell 完成。
        const sourceLayout = usePaneLayoutStore.getState();
        if (Object.keys(sourceLayout.panes).length > 0) {
          // draft primary 本身不在 paneLayout.panes 中。首发 accepted 后若只让
          // shell 记住新 session，focus 已绑定的 secondary 会覆盖 shell activeTaskId，
          // primary 随即丢失身份并回到 draft。这里先以新 session 作为 primaryBinding
          // 原子提升可见布局，再由上层同步 shell active，两个 pane 都有稳定 owner。
          const promoted = promotePaneLayoutToGroupAction(
            { workspaceScope: shellScope, sessionId: createdSessionId },
            sourceLayout,
          );
          if (promoted) {
            resetPaneLayoutAction();
            logger.info("[v4-workbench] primary draft promoted to session group", {
              createdSessionId,
              workspaceKey: paneWorkspaceKey(shellScope),
            });
          }
        }
        return true;
      }
      // [事务] 顺序敏感：先绑 pane，再判断是否需要 promotion，最后才允许 shell active 跟随。
      // 若先反写 shell activeTaskId，primary 仍由 shell.sessionId 驱动，会跟着显示右侧新 session；
      // promotion 用旧 sessionId 作 primaryBinding 把它钉住，正是为了防这一跳。
      // 返回值透传 promotion 结果：为假表示布局未升级，调用方不得再同步 shell，
      // 否则 group 与 paneLayout 会同时认为自己拥有 primary。
      bindPaneSessionAction(paneId, createdSessionId);
      if (!sessionId) {
        return false;
      }
      // 非 primary draft 首发会先产生新 session；若此时直接
      // 反写 shell activeTaskId，primary pane 仍由 shell.sessionId 驱动，
      // 会跟着显示右侧新 session。先把当前 paneLayout 提升为 group，
      // 用 primaryBinding 固定原 session，再允许 shell active 跟随新 pane。
      const promoted = promotePaneLayoutToGroupAction(
        { workspaceScope: shellScope, sessionId },
        usePaneLayoutStore.getState(),
      );
      if (promoted) {
        // promotion 是布局 owner 转移，不是复制后双写。group 已持有完整
        // workspace scope/binding 后立即消费 source，避免刷新或 group GC 时旧 split 复活。
        resetPaneLayoutAction();
      }
      return promoted;
    },
    [
      activeGroup,
      bindGroupPaneSessionAction,
      bindPaneSessionAction,
      promotePaneLayoutToGroupAction,
      resetPaneLayoutAction,
      sessionId,
      shellScope,
    ],
  );

  // [契约] 叶子按 layout.leaves 扁平渲染，key 只用 paneId：拆分与关闭只改变 rect，
  // 不重挂任何存活 pane，草稿、滚动位置与流式连接才能跨布局变化保留。
  // primary 的 binding 恒为空、primaryBinding 只在 group 下传，两者不可互换，
  // 互换会让 primary 读到 paneLayout 的残留绑定。focused 与 foregroundEnabled 相与：
  // 覆盖层打开时隐藏 pane 不得消费一次性 Composer 请求，solo 状态下不渲染分隔条。
  return (
    <div ref={containerRef} style={containerStyle} className="relative h-full min-h-0 w-full">
      {layout.leaves.map((leaf) => (
        <WorkbenchLeafPane
          key={leaf.paneId}
          paneId={leaf.paneId}
          rect={soloPaneId ? FULL_WORKBENCH_RECT : leaf.rect}
          hidden={soloPaneId !== null && leaf.paneId !== soloPaneId}
          // Settings 只把 workspace 设为 inert，Pane 之前仍保留 focused=true，
          // 会在隐藏状态提前消费 Plugin 试用的一次性预填。可见性并入 focus 后，
          // 请求只会由返回 workspace 后真正可交互的 Composer 消费。
          focused={foregroundEnabled && focusedPaneId === leaf.paneId}
          showFocusIndicator={showFocusIndicator}
          shellWorkspaceKey={shellWorkspaceKey}
          binding={leaf.paneId === V4_PRIMARY_PANE_ID ? null : (panes[leaf.paneId] ?? null)}
          primaryBinding={
            leaf.paneId === V4_PRIMARY_PANE_ID ? (activeGroup?.primaryBinding ?? null) : null
          }
          shell={shell}
          onFocusRequest={handleFocusRequest}
          onClosePane={handleClosePane}
          onConfirmRestoredSession={handleConfirmRestoredSession}
          onBindSession={handleBindSession}
          onPaneActiveSessionChange={onPaneActiveSessionChange}
        />
      ))}
      {(soloPaneId ? [] : layout.dividers).map((divider) => (
        <WorkbenchSplitDivider
          key={divider.splitId}
          containerRef={containerRef}
          splitId={divider.splitId}
          direction={divider.direction}
          ratio={divider.ratio}
          regionFraction={divider.regionFraction}
          style={dividerStyle(divider)}
          onCommitRatio={handleCommitSplitRatio}
        />
      ))}
    </div>
  );
}
