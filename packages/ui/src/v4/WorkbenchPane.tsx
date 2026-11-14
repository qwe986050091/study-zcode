// WorkbenchPane：分屏工作台上「一个叶子 pane」的装配层。
// 职责：把布局层算出的绝对 rect、per-pane 会话绑定与 shell 级回调收敛成一个 SessionPane，
// 并在持久化绑定恢复时校验该 session 是否仍然存在。
// 不负责：布局求解（workbenchLayout）、会话运行时与消息流（SessionPane 内部）、
// pane 布局状态的写入（paneLayoutStore 是唯一所有者）、group 生命周期（workbenchGroupStore）。
//
// 不变量表（改任一分支前逐条核对；右侧症状即该断言被破坏后线上可见的结果）：
// INV-01 断言：pane 的 workspaceScope 一律按 primaryBinding → binding → shell 的顺序解析 —— 守住它的位置：WorkbenchLeafPane 的 scope memo —— 改错故障：远程 pane 会拿本机 host 的 sessions-index，会话列表与 Git 面板串台。
// INV-02 断言：恢复守卫只接受 workspaceId 非 null 的首个 snapshot 作为判定依据 —— 守住它的位置：PaneRestoredGuard.evaluate —— 改错故障：空 store 集被误判成「已加载且 session 不在」，刷新后 pane 被批量误关。
// INV-03 断言：恢复守卫每次判定只结算一次，settled 之后回调不再改变结论 —— 守住它的位置：evaluate 的 settled 闩 —— 改错故障：晚到的空 snapshot 覆盖已确认结果，正在使用的 pane 突然塌缩。
// INV-04 断言：每次 acquireSessionsIndex 都必须在卸载时对应一次 releaseSessionsIndex —— 守住它的位置：useEffect 清理函数 —— 改错故障：引用计数泄漏，sessions-index 的订阅与轮询永不停止。
// INV-05 断言：先 subscribe 再同步 evaluate，不能只依赖订阅回调 —— 守住它的位置：PaneRestoredGuard 的订阅段 —— 改错故障：store 已就绪时不再触发回调，恢复 pane 永远停在未校验态。
// INV-06 断言：远程 endpoint 不可达或订阅报错时不做存在性判定 —— 守住它的位置：evaluate 的 workspaceId 前置条件 —— 改错故障：断连被当成 session 被删，远程 pane 被错误回收。
// INV-07 断言：group primary 的 session 删除必须先关 pane 再通知 shell —— 守住它的位置：handleSessionDeleted 的 isGroupPrimary 分支 —— 改错故障：shell 仍指向已删 session，草稿区空白且无法新建。
// INV-08 断言：primary draft 首发会话来时必须先让宿主原地绑定 draft pane —— 守住它的位置：handleSessionCreated 的无 primaryBinding 分支 —— 改错故障：随后 focus secondary 改写 shell activeTaskId，primary 退回草稿并丢失刚建会话。
// INV-09 断言：onBindSession 返回 false 表示宿主拒绝绑定，此时不得同步 shell active session —— 守住它的位置：handleBindSession 的 shouldSyncShellActive —— 改错故障：shell 激活一个布局里并不存在的 session。
// INV-10 断言：shell 级状态（git、summary、搜索）只下发给与 shell 同 workspace 的 pane —— 守住它的位置：isShellWorkspace 与 shouldUseShellStatusPanel —— 改错故障：副 pane 显示别的 workspace 的 Git 变更与变更统计。
// INV-11 断言：搜索结果高亮只在 pane 的 sessionId 等于请求的 taskId 时生效 —— 守住它的位置：paneSearchResultHighlightRequest 派生处 —— 改错故障：一次搜索让所有 pane 同时滚到不相关位置。
// INV-12 断言：草稿拖拽控制器只在「primary 且无 binding 且 sessionId 为空」时上送 —— 守住它的位置：onDropTargetControllerChange 的三元条件 —— 改错故障：壳层持有普通会话的 Composer 闭包，形成跨会话 store 保留链。
// INV-13 断言：焦点采集走 capture 且只发 focus 请求，不拦截子树默认交互 —— 守住它的位置：ChatPaneShell 的 onPointerDownCapture 与 onFocusCapture —— 改错故障：pane 内按钮、输入与拖拽全部失效。
// INV-14 断言：隐藏 pane 只加 hidden 类，不卸载内容子树 —— 守住它的位置：ChatPaneShell 的 hidden 分支 —— 改错故障：切换视图触发会话重挂载，草稿与滚动位置丢失。
// INV-15 断言：非 primary 叶子在无 binding 时渲染 null，不回退到 shell 绑定 —— 守住它的位置：WorkbenchLeafPane 的防御 return —— 改错故障：转移瞬间两个 pane 显示同一会话并互相抢焦点。
// INV-16 断言：readOnly 取 pane 自身绑定与同 workspace shell 只读态的逻辑或 —— 守住它的位置：readOnly 派生处 —— 改错故障：只读工作区的副 pane 仍可发送输入并写入会话。
// INV-17 断言：openTrigger 按 pane 角色固定，primary 为 sidebar、其余为 split —— 守住它的位置：SessionPane 的 openTrigger 接线 —— 改错故障：副 pane 被当成主入口，导航历史与返回行为错乱。
//
// 阅读顺序：ChatPaneShell（焦点外壳）→ PaneRestoredGuard（恢复校验）→ WorkbenchLeafPane（绑定接线）。
import {
  RemoteConversationBanner,
  RemoteConversationDisconnected,
} from "@/project-sidebar/RemoteConversationDisconnected.js";
/* oxlint-disable eslint(max-lines) -- WorkbenchLeafPane 集中承载 pane focus、per-pane provider 与恢复守卫；拆散会让 focus/session 绑定链路跨文件跳转。 */
// 分屏叶子 pane：Focus 层外壳 + per-pane 数据面接线 + 恢复守卫。宿主 = V4WorkspaceChatArea。
import { memo, useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { TID_V4_PANE_SHELL, testId } from "@zcode/shared/test-ids";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ZCodeProvider,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
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
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowRunDirectorySideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import type { PaneWorkspaceBadge } from "@/v4/ConversationHeader.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  paneWorkspaceKey,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import { rectStyle, type RectExpr } from "@/v4/workbenchLayout.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

interface ChatPaneShellProps {
  paneId: string;
  focused: boolean;
  /** 单 pane 布局时不画焦点框（无歧义，避免视觉噪音）。 */
  showFocusIndicator: boolean;
  onFocusRequest: (paneId: string) => void;
  /** 绝对定位 rect（布局层计算的 calc 表达式）。 */
  style: CSSProperties;
  hidden?: boolean;
  children: ReactNode;
  restoredUnvalidated?: boolean;
}

// 非焦点 pane 的遮罩用 brightness/saturate 压暗，而不是叠一层半透明黑，避免深色主题下层次被洗白。
// 遮罩必须 pointer-events-none 且置顶 z-30：任何接收指针的改动都会让副 pane 无法被点击唤醒。
const INACTIVE_PANE_OVERLAY_STYLE: CSSProperties = {
  backgroundColor: "color-mix(in oklab, var(--color-background) 34%, transparent)",
  backdropFilter: "brightness(0.94) saturate(0.94)",
};

/**
 * Focus 层外壳：点击/聚焦 pane 内任意处 → focus 该 pane（capture，不干扰子树交互）。
 * memo + 稳定回调：焦点切换只翻转 data-focused/边框类名，不牵动 pane 内容子树。
 */
// [契约] ChatPaneShell 只承担焦点外壳与矩形定位，内容子树由 children 原样透传。
// memo 的收益依赖 props 为原始值或稳定引用：给 style 传内联对象会让每次宿主渲染都重算 pane 子树。
// [权衡] 焦点态走 data-focused 与类名，不做条件渲染，避免 focus 切换卸载子树而丢失输入法、滚动与草稿。
// restoredUnvalidated 只作为 data 属性暴露给样式与测试，存在性判断不在这里做（判定在 PaneRestoredGuard）。
// ring 只在 showFocusIndicator 时叠加：单 pane 布局没有歧义，画焦点框属于视觉噪音。
const ChatPaneShell = memo(function ChatPaneShell({
  paneId,
  focused,
  showFocusIndicator,
  onFocusRequest,
  style,
  hidden = false,
  children,
  restoredUnvalidated = false,
}: ChatPaneShellProps) {
  // [契约] 焦点回调必须引用稳定：onFocusRequest 每次渲染换新会连锁击穿 ChatPaneShell 的 memo。
  // 在 capture 阶段触发，但只调用 onFocusRequest、不调用 preventDefault，否则子树内的 pointerdown 与 focus 会被吞掉。
  // paneId 变化时必须重建回调，缓存旧值会把焦点写到上一个 pane。
  const handleFocusRequest = useCallback(() => {
    onFocusRequest(paneId);
  }, [onFocusRequest, paneId]);

  // 外壳上的 data-pane-id 与 data-focused 是对外定位和 E2E 的稳定契约，改属性名要同步测试。
  // hidden 用类名隐藏而不是条件卸载：布局切换期间仍要保留 SessionPane 的订阅与滚动位置。
  // style 来自 rectStyle 的 calc 表达式，外壳不做数值 clamp：尺寸异常应回布局层修，不在渲染层兜底。
  // 遮罩排在 children 之前，保证它压住内容且不接收指针事件。
  return (
    <div
      data-testid={testId(TID_V4_PANE_SHELL, paneId)}
      data-pane-id={paneId}
      data-focused={focused ? "true" : "false"}
      data-restored-unvalidated={restoredUnvalidated ? "true" : "false"}
      onPointerDownCapture={handleFocusRequest}
      onFocusCapture={handleFocusRequest}
      style={style}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        hidden && "hidden",
        showFocusIndicator && focused && "ring-1 ring-inset ring-[var(--color-brand)]",
      )}
    >
      {showFocusIndicator && !focused ? (
        <div
          aria-hidden="true"
          data-v4-pane-inactive-overlay="true"
          style={INACTIVE_PANE_OVERLAY_STYLE}
          className="pointer-events-none absolute inset-0 z-30 rounded-md transition-[background-color,backdrop-filter]"
        />
      ) : null}
      {children}
    </div>
  );
});

interface PaneRestoredGuardProps {
  paneId: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  onConfirmed: (paneId: string) => void;
  onMissing: (paneId: string) => void;
}

/**
 * 持久化恢复守卫（per-pane 泛化）：localStorage 恢复的绑定可能指向已删 session
 * （删除发生在上次运行/其他窗口）。用 pane 自己 scope 的 sessions-index（按
 * endpoint + workspaceKey 隔离）等首个真 snapshot（workspaceId 就绪）后做一次
 * 存在性验证：在场 → 清 restoredUnvalidated；已删 → closePane 优雅塌缩。
 * 不用 useWorkspaceSessionsIndexItems——其聚合 memo 在
 * 订阅 effect 之前按空 store 集计算会误判「已加载且不在」；直连 registry store，
 * 订阅错误/远程 endpoint 不在场（断连代理 reject）时不判定，pane 保留为
 * error/等待连接态，交由 pane 自身 retry 兜底，不误关。
 * 必须挂在 V4PaneConversationProvider 内：useServices 取的是 pane 自己的 accessor
 * （远程 pane 走对应远程连接的 sessions-index，不误查本机 host）。
 */
// [事务] 恢复守卫只做一次存在性结算：首个带 workspaceId 的 snapshot 到达后，要么确认，要么请宿主关 pane，没有中间态。
// 不能用聚合 hook（useWorkspaceSessionsIndexItems）替代直连 registry：其 memo 会在订阅 effect 之前按空 store 集算一次，得出「已加载且不在」的假结论。
// 必须挂在 V4PaneConversationProvider 之内：useServices 拿到的才是本 pane 的 accessor，远程 pane 才会走对应连接的 sessions-index。
// [失败路径] 订阅错误、断连、远程代理 reject 都不构成 session 已删的证据：pane 保持 error 或等待连接，交由自身 retry 兜底。
// workspaceId 为 null 表示索引尚未就绪，此时既不确认也不关闭，避免启动竞态误杀。
// [并发] disposed 与 settled 是两个独立闩：前者挡卸载后的回调，后者挡重复结算，删掉任一个都会出现迟到写入。
// 改这个组件前先确认 scope 来源：替换 scope 会让 indexScope 命名空间漂移，从而查错 store。
function PaneRestoredGuard({
  paneId,
  scope,
  sessionId,
  onConfirmed,
  onMissing,
}: PaneRestoredGuardProps) {
  const services = useServices();
  const agentService = services.zcodeAgentService;
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;

  useEffect(() => {
    if (!agentService) {
      return;
    }
    // [契约] indexScope 的三要素（workspaceKey、workspacePath、endpointKey）必须与 acquire 端构造完全一致，否则会拿到不同实例。
    // remoteSessionId 存在时按 endpoint 隔离：远程 pane 绝不允许落到本机 host 的索引。
    // workspaceIdentity 用条件展开而非显式 undefined，保持对象形状稳定。
    // 不要在这里补 workspaceIdentity 等于路径的兜底，身份 key 的统一规则在 paneWorkspaceKey 内。
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    // [资源] acquireSessionsIndex 是引用计数获取，必须与清理段的 release 成对出现：中途新增 return 会漏掉释放。
    // store 由 registry 共享，pane 不能私自 dispose 或替换，否则其他 pane 的订阅会静默失效。
    // agentService 缺失时整段不执行（见上方 guard）：没有可用索引时，判定留白比误判安全。
    // 不要在渲染期 acquire：重复渲染会抬高计数，最终表现为索引永不回收。
    const store = acquireSessionsIndex(indexScope, agentService);
    let disposed = false;
    let settled = false;
    // [事务] settled 一旦置真就不可逆：它代表本 pane 的恢复判定已经完成，后续 snapshot 只是噪声。
    // workspaceId 为 null 时必须直接返回，不能退化成读取 getSessions() 的当前快照，那是未加载完成的空集。
    // exists 用 sessionId 精确匹配，不要改成标题或路径匹配：重名会话会造成错误确认。
    // onConfirmed 与 onMissing 都是宿主回调，调用后不要再访问 store，避免在已 release 的实例上取值。
    // evaluate 同时被订阅与首次同步调用，因此必须幂等：新增副作用前先确认它有两条进入路径。
    const evaluate = () => {
      if (disposed || settled || store.getState().workspaceId === null) {
        return;
      }
      settled = true;
      const exists = store.getSessions().some((summary) => summary.sessionId === sessionId);
      if (exists) {
        onConfirmed(paneId);
      } else {
        onMissing(paneId);
      }
    };
    // [并发] 先订阅、再立即求值：store 若已就绪，订阅不会补发通知，只有主动 evaluate 才能结算。
    // [资源] unsubscribe 必须留存并在清理中调用，Zustand 的订阅不会随组件卸载自动解除。
    // 不要在订阅回调里做异步工作：它是同步通知，异步化会打乱与 release 的先后顺序。
    const unsubscribe = store.subscribe(evaluate);
    evaluate();
    // [资源] 清理顺序固定为 disposed、unsubscribe、release：先置位挡住队列中的迟到回调，最后归还索引引用。
    // release 必须传同一个 store 实例，不能用重新 acquire 的结果代替，否则计数错配。
    // 卸载后不得再触发 onConfirmed 或 onMissing：disposed 闩就是为这条路径存在。
    // 依赖数组含两个宿主回调，宿主需用 useCallback 稳定它们，否则每次渲染都会重建索引订阅。
    return () => {
      disposed = true;
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    agentService,
    paneId,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onConfirmed,
    onMissing,
  ]);

  return null;
}

/** primary pane 的 shell 侧绑定（activeTaskId 选择态 + 回调，不进 paneLayoutStore）。 */
// [契约] WorkbenchShellBinding 是 shell 向所有 pane 下发的只读投影，不是状态所有者：写入仍归 store 与服务层。
// sessionId 是 shell 侧会话，activeSessionId 是 shell 当前真正激活的 task，split pane 接管后两者会不同。
// 新增字段都要在 WorkbenchLeafPane 接线处决定下发范围（仅 primary、仅同 workspace、全量），不能无脑透传。
// git 与 summary 字段允许为 null：null 表示宿主尚未取到数据，不代表无变更。
// 回调型字段全部可选：缺省即不接线，不要在 pane 内补默认空函数掩盖宿主漏传。
// [契约] 插件与 workflow 侧栏回调统一经 shell binding 下发到 SessionPane，不要绕开本层直连全局 store。
export interface WorkbenchShellBinding {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** Prompt 模板埋点当前仅覆盖 Desktop。 */
  isDesktop?: boolean;
  readOnly?: boolean;
  allowEscapeStopOutsidePane?: boolean;
  compactForRemoteControl?: boolean;
  sessionId: string | null;
  /** Shell 当前真正激活的 task；split pane 接管 active task 时不等于 primary sessionId。 */
  activeSessionId?: string | null;
  activeSelectionSideChatSessionId?: string | null;
  provider?: ZCodeProvider;
  onSessionCreated?: (sessionId: string) => void;
  onSessionDeleted?: () => void;
  draftComposerHeader?: ReactNode;
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
  /** 插件 UI 侧栏：与 onOpenPlanDetail 同路径经 shell binding 下发到 SessionPane。 */
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

// binding 为 null 只对 primary 合法：非 primary 拿到 null 必须走防御渲染。
// paneId 同时是布局标识与回调 key，不要在内部派生别名。
// restoredUnvalidated 来自持久化恢复，只在 guard 确认前为真，pane 自身不得改写。
export interface WorkbenchLeafPaneProps {
  paneId: string;
  rect: RectExpr;
  /** 完整视图浮窗只显示焦点 pane；其余 pane 隐藏但不卸载。 */
  hidden?: boolean;
  focused: boolean;
  showFocusIndicator: boolean;
  shellWorkspaceKey: string;
  /** 非 primary pane 的绑定；primary 传 null（用 shell 绑定）。 */
  binding: PaneBinding | null;
  /** session workbench group 中 primary pane 的显式绑定；无 group 时为 null。 */
  primaryBinding?: WorkbenchSessionBinding | null;
  shell: WorkbenchShellBinding;
  onFocusRequest: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onConfirmRestoredSession: (paneId: string) => void;
  onBindSession: (paneId: string, sessionId: string) => boolean | void;
  onPaneActiveSessionChange?: (scope: PaneWorkspaceScope, sessionId: string) => void;
}

// 徽标标题取路径最后一段，仅用于展示：远程判定取 identity 与 remoteSessionId 的并集。
// 不要在这里做路径规范化或去尾斜杠，scope 的来源应原样呈现。
function workspaceBadgeFor(scope: PaneWorkspaceScope): PaneWorkspaceBadge {
  const label = scope.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? scope.workspacePath;
  return {
    label,
    workspacePath: scope.workspacePath,
    remote: Boolean(scope.workspaceIdentity || scope.remoteSessionId),
  };
}

// [契约] WorkbenchLeafPane 是纯装配层：可见状态全部由 binding、primaryBinding 与 shell 推导，自身不持有会话状态。
// scope 的解析顺序 primaryBinding → binding → shell 是身份正确性的根：primary 有 group 绑定时必须以 group 为准。
// [权衡] 所有能力由 props 传入而非就地使用 hooks 取，是为了让同一组件同时服务本地与远程 pane。
// 本组件渲染在 Provider 之间，把 context 读取提升到外部会破坏 per-pane accessor 隔离。
// 改这里前先确认 paneLayoutStore 的 sanitize 规则：非 primary 无绑定的中间态确实可能短暂出现。
// 不要在此合并或改写 shell 回调：接线层的语义是决定是否下发，而不是改变行为。
export function WorkbenchLeafPane({
  paneId,
  rect,
  hidden = false,
  focused,
  showFocusIndicator,
  shellWorkspaceKey,
  binding,
  primaryBinding,
  shell,
  onFocusRequest,
  onClosePane,
  onConfirmRestoredSession,
  onBindSession,
  onPaneActiveSessionChange,
}: WorkbenchLeafPaneProps) {
  const isPrimary = paneId === V4_PRIMARY_PANE_ID;
  const isGroupPrimary = isPrimary && Boolean(primaryBinding);
  // [契约] 依赖数组必须覆盖所有参与分支的字段：漏掉 workspaceIdentity 会让远程身份变化后仍复用旧 scope。
  // 返回对象只随依赖变化重建，下游 indexScope 与 workspaceBadgeFor 都依赖它的稳定性。
  // primary 且 primaryBinding 存在时忽略 shell 的 workspace 字段，这是 group 语义，不要为统一删掉。
  // 新增分支要保持三种返回对象形状一致，缺失字段用条件展开而不是赋 undefined。
  const scope = useMemo<PaneWorkspaceScope>(() => {
    if (!isPrimary && binding) {
      return binding.workspaceScope;
    }
    if (isPrimary && primaryBinding) {
      return primaryBinding.workspaceScope;
    }
    return {
      workspacePath: shell.workspacePath,
      ...(shell.workspaceIdentity ? { workspaceIdentity: shell.workspaceIdentity } : {}),
      ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    };
  }, [
    isPrimary,
    binding,
    primaryBinding,
    shell.workspacePath,
    shell.workspaceIdentity,
    shell.remoteSessionId,
  ]);

  const style = useMemo(() => rectStyle(rect), [rect]);

  const handleClosePane = useCallback(() => {
    onClosePane(paneId);
  }, [onClosePane, paneId]);
  // [事务] 三条分支的顺序不可调换：group primary 先关 pane 再解散 group，否则 shell 会指向已删 session。
  // group primary 删除后 secondary 只恢复普通 session 身份，不能被隐式提升为新的 primary。
  // 普通 primary 只通知 shell、不动布局，由布局层决定是否保留 draft。
  // secondary 走 handleClosePane 塌缩回主区，不触碰 shell 的 activeTaskId。
  // 依赖含 isGroupPrimary，它随 primaryBinding 变化：漏依赖会闭包住旧布局分支。
  const handleSessionDeleted = useCallback(() => {
    if (isGroupPrimary) {
      // group primary 删除过去只关闭布局，shell 仍指向已删除 session。
      // accepted 后必须先解散 group，再让 shell 回当前 workspace draft；secondary
      // 仅恢复普通 session 身份，不能在这里被隐式提升。
      handleClosePane();
      shell.onSessionDeleted?.();
      return;
    }
    if (isPrimary) {
      shell.onSessionDeleted?.();
      return;
    }
    handleClosePane();
  }, [handleClosePane, isGroupPrimary, isPrimary, shell.onSessionDeleted]);
  const handleBindSession = useCallback(
    (createdSessionId: string) => {
      const shouldSyncShellActive = onBindSession(paneId, createdSessionId) !== false;
      if (shouldSyncShellActive) {
        onPaneActiveSessionChange?.(scope, createdSessionId);
      }
    },
    [onBindSession, onPaneActiveSessionChange, paneId, scope],
  );
  // [事务] primary draft 旁已有拖入会话时，首发必须让宿主原地绑定 draft pane 并接管布局：先 onBindSession，再通知 shell。
  // 顺序反了会让 primary 因没有独立 binding 退回 draft，刚创建的会话从主区消失。
  // 非 primary 与已有 binding 的 primary 走 handleBindSession，由宿主返回值决定是否同步 shell active。
  // onBindSession 返回 false 表示宿主拒绝（布局已变或 pane 已关），此时不得再更新 active session。
  // [并发] 创建回调可能在同一 tick 连续触发，绑定必须幂等：依赖里带 primaryBinding 才能取到最新分支。
  // 不要在这里补 focus 或 closePane，布局调整由宿主在绑定成功后完成。
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      if (isPrimary && !primaryBinding) {
        // primary draft 旁边已经有拖入的 session 时，首发不能只更新 shell。
        // 必须先让 workbench 宿主把 draft pane 原地绑定并接管整个布局；否则随后
        // focus secondary 会改写 shell activeTaskId，primary 就因没有独立 binding 退回 draft。
        onBindSession(paneId, createdSessionId);
        shell.onSessionCreated?.(createdSessionId);
        return;
      }
      handleBindSession(createdSessionId);
    },
    [handleBindSession, isPrimary, onBindSession, paneId, primaryBinding, shell.onSessionCreated],
  );
  if (!isPrimary && !binding) {
    // sanitize/迁移保证非 primary 叶子必有绑定；此处是转移瞬间的防御渲染。
    return null;
  }

  const isShellWorkspace = paneWorkspaceKey(scope) === shellWorkspaceKey;
  const sessionId = isPrimary
    ? (primaryBinding?.sessionId ?? shell.sessionId)
    : (binding?.sessionId ?? null);
  const readOnly = Boolean(
    (isPrimary ? primaryBinding?.readOnly : binding?.readOnly) ||
    (isShellWorkspace && shell.readOnly),
  );
  const shouldUseShellStatusPanel = isShellWorkspace;
  // [契约] 搜索高亮请求按 taskId 精确匹配本 pane 的 sessionId 才下发，避免多 pane 同时滚动。
  // 匹配不上时传 null 而不是 undefined：SessionPane 用 null 表示本 pane 无待处理高亮。
  // 不要在这里清除宿主请求，完成回调仍由 shell 的 onSearchResultHighlightDone 统一回收。
  // 只看 sessionId、不看 focused：非焦点 pane 也可能需要定位，跳过它会导致结果高亮丢失。
  const paneSearchResultHighlightRequest =
    sessionId === shell.searchResultHighlightRequest?.taskId
      ? shell.searchResultHighlightRequest
      : null;

  return (
    <ChatPaneShell
      paneId={paneId}
      focused={focused}
      showFocusIndicator={showFocusIndicator}
      onFocusRequest={onFocusRequest}
      style={style}
      hidden={hidden}
      restoredUnvalidated={Boolean((isPrimary ? primaryBinding : binding)?.restoredUnvalidated)}
    >
      <V4PaneConversationProvider
        scope={scope}
        sessionId={sessionId}
        unavailableFallback={<RemoteConversationDisconnected {...scope} sessionId={sessionId} />}
        disconnectedBanner={<RemoteConversationBanner {...scope} sessionId={sessionId} />}
      >
        {(isPrimary ? primaryBinding : binding)?.restoredUnvalidated && sessionId ? (
          <PaneRestoredGuard
            paneId={paneId}
            scope={scope}
            sessionId={sessionId}
            onConfirmed={onConfirmRestoredSession}
            onMissing={onClosePane}
          />
        ) : null}
        <SessionPane
          paneId={paneId}
          readOnly={readOnly}
          sessionId={sessionId}
          openTrigger={isPrimary ? "sidebar" : "split"}
          activeSelectionSideChatSessionId={resolvePaneActiveSelectionSideChatSessionId(
            sessionId,
            shell.activeSessionId ?? shell.sessionId,
            shell.activeSelectionSideChatSessionId,
          )}
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
          remoteSessionId={scope.remoteSessionId}
          isDesktop={shell.isDesktop}
          compactForRemoteControl={shell.compactForRemoteControl ?? false}
          provider={isPrimary && isShellWorkspace ? shell.provider : undefined}
          onSessionCreated={handleSessionCreated}
          onSessionDeleted={handleSessionDeleted}
          focused={focused}
          allowEscapeStopOutsidePane={shell.allowEscapeStopOutsidePane}
          onClosePane={isPrimary ? undefined : handleClosePane}
          workspaceBadge={!isPrimary && !isShellWorkspace ? workspaceBadgeFor(scope) : undefined}
          draftComposerHeader={isPrimary && !primaryBinding ? shell.draftComposerHeader : undefined}
          // 草稿页头才需要上行拖拽控制器。普通会话上传它会把 Composer 的闭包送回壳层，
          // 再经壳层回调连回旧 SessionPane，形成跨会话的 snapshot / store 保留链。
          onDropTargetControllerChange={
            isPrimary && !primaryBinding && sessionId === null
              ? shell.onPrimaryDraftDropTargetControllerChange
              : undefined
          }
          gitSummary={shouldUseShellStatusPanel ? shell.gitSummary : undefined}
          gitDirtyFileCount={shouldUseShellStatusPanel ? shell.gitDirtyFileCount : undefined}
          gitWorktreeReviewSourceId={
            shouldUseShellStatusPanel ? shell.gitWorktreeReviewSourceId : undefined
          }
          gitWorktreeChangeSummary={
            shouldUseShellStatusPanel ? shell.gitWorktreeChangeSummary : undefined
          }
          activeTaskChangeSummary={isPrimary ? shell.activeTaskChangeSummary : undefined}
          summaryPanelVariantOverride={
            shouldUseShellStatusPanel ? shell.summaryPanelVariantOverride : undefined
          }
          onSummaryPanelVariantOverrideChange={
            shouldUseShellStatusPanel ? shell.onSummaryPanelVariantOverrideChange : undefined
          }
          onRefreshGit={shouldUseShellStatusPanel ? shell.onRefreshGit : undefined}
          onOpenGitReview={shouldUseShellStatusPanel ? shell.onOpenGitReview : undefined}
          onOpenBrowserUrl={shell.onOpenBrowserUrl}
          onOpenAutomationsMain={shell.onOpenAutomationsMain}
          onOpenCodeViewer={shell.onOpenCodeViewer}
          onAutoOpenAssistantPptx={shell.onAutoOpenAssistantPptx}
          onOpenFileLink={shell.onOpenFileLink}
          onOpenSubagentSession={shell.onOpenSubagentSession}
          onOpenBackgroundBash={shell.onOpenBackgroundBash}
          onOpenSubagentDirectory={shell.onOpenSubagentDirectory}
          onSyncSubagentSessionTabs={shell.onSyncSubagentSessionTabs}
          onOpenSelectionSideChat={shell.onOpenSelectionSideChat}
          onOpenPlanDetail={shell.onOpenPlanDetail}
          onOpenWorkflowRun={shell.onOpenWorkflowRun}
          onOpenWorkflowArtifact={shell.onOpenWorkflowArtifact}
          onOpenWorkflowRunDirectory={shell.onOpenWorkflowRunDirectory}
          onOpenWorkflowActorSession={shell.onOpenWorkflowActorSession}
          onOpenWorkflowWorkspace={shell.onOpenWorkflowWorkspace}
          conversationFindQuery={focused ? shell.conversationFindQuery : ""}
          conversationFindActiveIndex={focused ? (shell.conversationFindActiveIndex ?? -1) : -1}
          conversationFindNavigationRequestId={
            focused ? (shell.conversationFindNavigationRequestId ?? 0) : 0
          }
          onConversationFindMatchStateChange={
            focused ? shell.onConversationFindMatchStateChange : undefined
          }
          searchResultHighlightRequest={paneSearchResultHighlightRequest}
          onSearchResultHighlightDone={shell.onSearchResultHighlightDone}
        />
      </V4PaneConversationProvider>
    </ChatPaneShell>
  );
}

export function resolvePaneActiveSelectionSideChatSessionId(
  paneSessionId: string | null,
  shellActiveSessionId: string | null,
  activeSelectionSideChatSessionId: string | null | undefined,
): string | null {
  return paneSessionId && paneSessionId === shellActiveSessionId
    ? (activeSelectionSideChatSessionId ?? null)
    : null;
}
