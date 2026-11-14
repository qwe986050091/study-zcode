/* eslint-disable max-lines -- workspace shell 当前集中编排 sidebar、chat、terminal 和 browser pane 的布局联动，先保持单文件收口，避免为满足行数限制打散关键布局状态。*/
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ReactNode,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { GripHorizontal, LoaderIcon } from "lucide-react";
import { TID_APP_HEADER } from "@zcode/shared/test-ids";
// 保活：workspace tab 真正关闭时，按 workspaceKey 回收 side pane terminal 的常驻 PTY/xterm。
// 对称下侧 Terminal.tsx 的 openWorkspaceKeys 回收。
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";
import {
  readFloatingAnchorPreference,
  SidePaneFullViewConversationHost,
  writeFloatingAnchorPreference,
  type FloatingAnchor,
  type SidePaneFullViewFloating,
  type SidePaneFullViewHostMode,
} from "@/side-pane-full-view/index.js";
import {
  SavedWorkflowHubProvider,
  type SavedWorkflowHubTarget,
} from "@/v4/savedWorkflowHubContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  selectWorkbenchSession,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";
import {
  usePaneSessionPersistence,
  useRemotePaneSessionLookup,
} from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { ProjectComposerMenu, ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/workspace-plugin-preview/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { resolveTopOverlayLeadingPaddingClass, WorkspaceHeader } from "@/WorkspaceHeader.js";
import { WorkspaceSidebar, type SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  getDefaultWebRemoteNavigationHeightPx,
  resolveWebRemoteNavigationDragState,
  resolveWebRemoteNavigationToggleState,
  shouldRenderWebRemoteNavigationPanel,
} from "@/app-shell/webRemoteNavigationLayout.js";
import type { WebRemoteNavigationState } from "@/app-shell/webRemoteNavigationLayout.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

// ============================================================
// INV 不变量表（WorkspaceShellLayout）
// ============================================================
//
// INV-01：侧栏宽度只有一个权威来源——workspaceSidebarPanelWidthPxRef（拖拽期间）
//         与 workspaceSidebarPanelWidthPx（React 状态）必须同步；CSS 变量只是投影。
//         只改 state 不改 ref 会让 pointermove 基于旧基准跳动，只改 ref 不改 state
//         会让松手后界面回弹。（守住：applyWorkspaceSidebarWidth / resize move）
// INV-02：拖拽中禁止 setState。pointermove 只写 CSS 变量与 ref，pointerup 才提交
//         React 状态；反过来会让整棵 WorkspaceSidebar/ChatView 树每个像素重渲染。
//         （守住：applyWorkspaceSidebarWidthDuringDrag / finishWorkspaceSidebarResize）
// INV-03：一次拖拽会话由 pointerId 唯一标识；move/up/cancel 只要 id 不匹配就必须
//         直接返回。缺这个判断时，另一个指针（或多点触控）的移动会改写本次宽度。
//         （守住：handleWorkspaceSidebarResizeMove / finishWorkspaceSidebarResize）
// INV-04：指针捕获必须成对且带 hasPointerCapture 检查；在未捕获时 releasePointerCapture
//         会抛 DOMException，把一次正常松手变成控制台报错并中断后续持久化。
//         （守住：finishWorkspaceSidebarResize / finishWebRemoteNavigationResize）
// INV-05：侧栏面板可见性 = isSidebarVisible（用户意图）而非“是否有 active task”；
//         pane 内容可见性 = isWorkspaceVisible && chat 视图 && isSidePaneOpen &&
//         isSidePaneVisible。二者混用会让“打开面板但切到 automations”时仍显示浏览器。
//         （守住：isSidebarPanelVisible / renderSidePanePanel 的 isVisible）
// INV-06：侧栏显隐与 side pane 开合是两个正交状态；自动收起策略不得写死其中一个
//         来“顺手”实现另一个，否则用户手动打开的面板会被窗口 resize 关掉。
//         （守住：conversationAutoCollapseStateRef / collapseSidebarIfStillNarrow）
// INV-07：自动收起只响应用户改变窗口尺寸（resize 事件 + idle 去抖），不监听
//         conversation 自身 ResizeObserver。反序会把“用户主动开面板”误判为变窄并收起。
//         （守住：runAutoCollapseForWindowResize 的注释与 300ms timer）
// INV-08：完整视图（full view）中对话由宿主 fixed 定位，conversation 列宽不代表可见
//         对话区；isFullViewRef 为 true 时必须跳过自动收起。
//         （守住：runAutoCollapseForWindowResize 的 isFullViewRef 早退）
// INV-09：全屏浮窗（floating）不渲染终端面板，但 isTerminalOpen 状态保持不变；
//         退出浮窗后终端要按原状态恢复，不能顺手 setTerminalOpen(false)。
//         （守住：useAnimatedResizablePanel 的 open: isTerminalOpen && !isFloatingFullView）
// INV-10：远端 workspace 的身份只能来自 workspaceIdentity / remoteSessionId，
//         绝不能用路径反查 tab 来推断 identity——不同设备 home 相同会互相命中。
//         （守住：handleSelectConversationWorkspace / findFileLinkOwnerWorkspace）
// INV-11：跨 workspace 选中任务前必须先确保本地 tab 已激活/补开；失败则保留当前页
//         并 toast，绝不能先 showChatMainView 造成“看起来跳转成功”。
//         （守住：handleSelectTaskInChat 的 workspaceResult.accepted 分支）
// INV-12：指向 target workspace 的创建/运行请求绕过活动 workspace 的只读限制；
//         真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly，Shell 不能双重拦截。
//         （守住：handleCreateTaskInChat 的 hasTargetWorkspace / handleCreateAutomationInChat）
// INV-13：remote shell 不承载 automations / plugin-store；检测到这两个主视图时必须
//         立即回落 chat，否则会渲染一个远控壳无法表达的页面。
//         （守住：workspaceMainView 同步 useEffect）
// INV-14：workspace tab 真正关闭时按 workspaceKey 回收 terminal 常驻 session；
//         切 workspace 不能让 key 离开 openWorkspaceKeys，否则会误杀保活 PTY。
//         （守住：openWorkspaceKeys 的 releaseByPredicate effect）
// INV-15：shellWorkbenchBindingRef 只在 layout effect 中更新，事件处理器读取 ref；
//         直接依赖 binding 会让草稿切换时所有分屏回调换引用、整树重渲染。
//         （守住：handleSelectTaskInChat / shellWorkbenchBindingRef）
// INV-16：文件链接先 stat 再分流：文件→CodeViewer 或 html 浏览器，目录→文件树；
//         stat 失败时才回退 CodeViewer，保证“点击无反馈”不会发生。
//         （守住：handleOpenMarkdownFileLink 的 try/catch）
// INV-17：ScopedErrorBoundary 的 resetKeys 必须是稳定引用（useMemo 常量或模块常量），
//         每次 render 新数组会让 ErrorBoundary 误判为“上下文变化”并整树重挂。
//         （守住：workspaceOnlyResetKeys / workspaceDraftResetKeys / resetKeys 用法）
// INV-18：memo 组件的默认对象/数组 props 必须复用模块常量，缺省调用时不能新建；
//         否则浅比较永远失败，性能优化形同虚设。
//         （守住：EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY）
// INV-19：resize / media query 监听必须在 cleanup 中移除，并兼容旧版 addListener；
//         漏移除会在 HMR 或视图切换后累积回调，关闭页面仍执行 setState。
//         （守住：两个 useEffect 的 return 与 webRemote resize effect）
// INV-20：所有导航入口最终都汇到 handleSelectTaskInChat；新增入口若直接调
//         handleSelectTask，会跳过 workspace tab 激活与远端 identity 解析，产生“选中了
//         但打不开”的会话。（守住：renderWorkspaceSidebar / AutomationsSection 回调）
//
// 阅读提示：本文件按“布局状态 → 拖拽/导航回调 → 两套 JSX（远控/桌面）”组织，
// 同一语义在两套 JSX 中必须保持一致，修改时优先改回调而不是复制分支。
const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";
const WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY =
  "zcode:web-remote-control:collapse-navigation-once";
const WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX = 4;
// 默认宽度与最小宽度刻意相等：新用户第一次看到的是“最小可用宽度”，
// 只能往大拖。若默认大于最小，需要一个额外的“恢复默认”语义，徒增状态。
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
// 下限同时是键盘 Home 键的目标值；调大它会让远期窗口出现“拖不动”的错觉。
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
// 键盘步长取 16px（≈1rem）：既能让焦点用户可感知地移动，又不会一次跨过
// 常用宽度区间；配合 ArrowLeft/Right 与 Home/End 形成完整可访问路径。
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
// 480/360 是两个独立阈值：会话区窄于 480 先收右侧面板，仍窄于 360 才收左侧栏。
// 先收面板后收侧栏的顺序不能反——侧栏承载全局导航，优先级高于辅助面板。
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// 修复原因：WorkspaceShellLayout 是 memo 组件，默认 []/{} 会在缺省调用时每次创建新引用；
// 远控/本地入口缺省这些集合时复用常量，避免浅比较误判 props 变化。
const EMPTY_REMOTE_WORKSPACE_RECOVERY_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceRecoveryByWorkspaceKey"]
> = {};
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
// resize idle 去抖：窗口拖拽会以 60~120Hz 触发 resize，立即执行收起会把
// 中间态当最终态。300ms 是“手停但仍按住标题栏”的常见停顿上限。
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// 性能修复：ResizablePanelGroup 收到深相等的新 panelIds 数组，
// 会跟随 chat streaming render 重算布局上下文；固定数组语义上不会随消息变化。
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

// 远控顶部导航的拖拽会话。didDrag 用来区分“点击展开/折叠”与“拖拽调高”，
// 二者共用同一个手柄；没有它时轻微抖动会被当成拖拽，点击失效。
type WebRemoteNavigationDragSession = {
  pointerId: number;
  startHeightPx: number;
  startY: number;
  didDrag: boolean;
};

// 侧栏拖拽会话把“起始 x / 起始宽度 / 容器宽度”冻结在 pointerdown 时刻。
// 用 event.clientX 的累计位移而不是上一帧宽度，避免掉帧时误差累积。
type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

// 宽度钳制的唯一实现：min 264、max = min(容器 50%, ∞)。容器宽度未知（首帧、
// 无 ref）时不做上限，而不是返回 0——那会让侧栏在挂载瞬间消失。
// 结果取整，避免持久化/回填 0.5px 造成 CSS 与 state 永久不一致。
function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

// SSR 安全：没有 window 时返回 null 让调用方用默认值，而不是抛错。
// 读取失败一律视为“没有存储”，绝不把异常冒到渲染阶段（localStorage 在
// 隐私模式/配额满时可能直接抛）。非法值（非有限/<=0）同样当作缺失。
function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

// 迁移旧版 react-resizable-panels 的百分比布局：旧值单位是 0-100 的 percentage，
// 这里折算成 0-1 的比例，由调用方乘以容器宽度。只读不删旧 key，回滚旧版本时
// 仍能恢复原布局。
function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

// 写入同样吞掉异常：持久化失败只影响“下次启动宽度”，不应打断本次拖拽的收尾，
// 更不该让一个 UI 布局操作冒泡成错误边界。
function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

// 视口高度兜底 800：移动端浏览器地址栏收起/展开会导致 innerHeight 为 0 的瞬时值，
// 直接拿 0 去算拖拽比例会得到 0 高度导航，展开后“消失”且无法再拖回。
function getWebRemoteControlViewportHeight() {
  if (typeof window === "undefined") {
    return WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
  }

  return window.innerHeight || WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
}

// 首帧同步读取 matchMedia，避免 useState 初始值先渲染桌面布局再闪现手机布局。
// matchMedia 不存在（旧 WebView/测试环境）时按非移动端处理。
function getIsWebRemoteControlMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

// “一次性”折叠意图：跨 workspace 跳转后新页面首帧需要保持折叠，但刷新后
// 不应继续折叠，因此用 sessionStorage + 读后即删（consume 语义），而不是 localStorage。
function consumeWebRemoteControlCollapseIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.sessionStorage.getItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY) === "1") {
      window.sessionStorage.removeItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

// 与 consume 成对：写入失败（隐私模式）时静默降级为“只折叠当前页”，
// 不阻断跳转本身。两者必须使用同一个 key，否则 intent 永远读不到。
function markWebRemoteControlCollapseIntent() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY, "1");
  } catch {
    // ignore
  }
}

// 外层 memo 只做一件事：注入 ProjectDirectoryProvider。把 Provider 放在 memo
// 内部而不是调用方，保证桌面/远控/测试三个入口拿到同一份项目目录上下文。
// props 原样透传，不在这里做默认值，避免出现两份默认值真相。
export const WorkspaceShellLayout = memo(function WorkspaceShellLayout(
  props: WorkspaceShellLayoutProps,
) {
  return (
    <ProjectDirectoryProvider isDesktop={props.isDesktop}>
      <WorkspaceShellLayoutContent {...props} />
    </ProjectDirectoryProvider>
  );
});

const WorkspaceShellLayoutContent = memo(function WorkspaceShellLayoutComponent({
  // services 已按当前 workspace 解析（本地/远端/只读），Shell 内不再做二次选择；
  // 任何“看起来读不到文件”的问题都应先检查上层传入的 services 与 workspace 坐标是否匹配。
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  pluginStoreOpenVersion,
  openAutomationId,
  openAutomationTab,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSavedWorkflowInHub,
  onWorkspaceMainViewChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  handleOpenPluginStore,
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

  onCreateTask,
  // 三个“新建”入口语义不同，不能合并：
  // onCreateTask 是纯创建；onCreateConversationTask 允许带初始对话内容；
  // onCreateConversationTaskOnSource 额外带来源 workspace（跨项目复制会话）。
  onCreateConversationTask,
  onCreateConversationTaskOnSource,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  // 默认允许打开工作区；只读场景由 root 动作逐次校验，不能在这里统一关掉，
  // 否则“另存为/导出”这类合法入口也会一起消失。
  allowOpenWorkspace = true,
  // webRemoteControlWorkspaceSwitcher 一旦存在即代表“当前是远控壳”，
  // 它是能力开关而不是 UI 开关：传空对象也会进入远控分支。
  webRemoteControlWorkspaceSwitcher,
  // 初始化入参只消费一次（首次挂载），后续变化不应重新打开文件树或跳转任务；
  // 若做成受控值，浏览器回退/前进会反复触发同一段深链导航。
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  // 默认允许远端项目，与 allowRemoteWorkspace 的默认值必须一致，
  // 否则“能连接但不能打开”会成为默认体验。
  allowRemoteWorkspace = true,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  workspaceShellZCodeState,
  theme,
  isMacFullscreen,
  desktopWindowChromeState,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx = 136,
  updateReadyVersion,
  updateState,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  toggleSidePaneFullViewShortcutLabel,
  canGoBack,
  canGoForward,
  canTaskNavBack,
  canTaskNavForward,
  isTerminalOpen,
  isSidebarVisible,
  isSidePaneOpen,
  sidePaneFullView,
  isBrowserOpen,
  supportsEmbeddedBrowser,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeGitSourceId,
  gitState,
  browserNavigationRequest,
  browserRestoreUrls,
  providerConfigFile,
  taskNativeSessionLogFile,
  taskSessionFile,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  appLogoUrl,
  platform,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  // 纯导航回调（不带 workspace 语义）：Shell 只把它们接到旧入口上，
  // 所有“跨项目打开”的路径都必须先经过本文件里的 InChat 包装（INV-20）。
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleRefreshGit,
  handleBrowserUrlChange,
  handleBrowserPageMetadataChange,
  handleToggleSidebar,
  handleToggleTerminal,
  handleToggleBrowser,
  // 浏览器能力按“是否支持内嵌”分派，Shell 不做判断：不支持时上层会传入
  // 外部打开实现，这里一律当同签名回调调用即可。
  handleOpenBrowserTab,
  handleOpenBrowserPermissionSettings,
  handleOpenWhiteboard,
  handleOpenDeveloperTools,
  handleOpenFileManager,
  handleNavigateFileManager,
  handleOpenPluginMarket,
  handleOpenTerminalTab,
  handleToggleGit,
  handleOpenGitReview,
  handleToggleSidePane,
  handleOpenBrowserUrl,
  handleOpenCodeViewer,
  handleAutoOpenAssistantPptx,
  // 子代理/后台任务/工作流的打开回调都带着“可能跨 workspace”的语义，
  // 由上层负责解析身份；Shell 只负责在正确的主视图下渲染目标 tab。
  handleOpenSubagentSession,
  handleOpenBackgroundBash,
  handleOpenSubagentDirectory,
  handleSyncSubagentSessionTabs,
  handleOpenSelectionSideChat,
  handleOpenPlanDetail,
  handleOpenWorkflowRun,
  handleOpenWorkflowRunDirectory,
  handleOpenWorkflowActorSession,
  handleOpenWorkflowWorkspace,
  handleOpenWorkflowArtifact,
  // 关闭类回调只影响 side pane 的 tab 集合，不触发主视图切换；
  // 若在这里顺手 showChatMainView，用户关一个标签页会被强制拽回聊天。
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
  // 终端开合由 Shell 持有状态（见 INV-09），setter 直传以便面板内部也能关闭终端。
  setIsTerminalOpen,
  setGitSelectedSourceId,
  // 查找对话框的 props 整体透传：Shell 不解释字段，避免与 TaskFindDialog 的
  // 内部状态耦合；placement 由 Shell 在渲染时注入。
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  // 用“是否传入 workspaceSwitcher”而不是 isDesktop 的取反来判断远控壳：
  // 移动端浏览器与嵌入式远控都可能 isDesktop=false，后者仍需要完整桌面壳。
  // 这是本文件所有“远控降级”行为的总开关。
  const isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher);
  // Windows/Linux 原先遗漏外层留白，导致独立面板贴住窗口边缘；桌面统一使用 4px 间距。
  // 三种桌面平台共享外层 4px 内缩（窗口圆角/阴影需要留白）；Web 端不留白，
  // 否则浏览器里会出现一圈无意义的空白边框。
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  // 侧栏收起后仍保留一条窄边（Windows 6px、mac/Linux 4px），它是“重新拉出侧栏”
  // 的命中区域；Web 端为 0。这个值与 MIN_WIDTH 不同：它不参与 clamp，
  // 因为收起态本就不该触发拖拽逻辑（pointerdown 在不可见时已早退）。
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? (isWindowsDesktop ? 6 : 4) : 0;
  // 惰性初始化会在挂载时消费一次 session intent：跨 workspace 跳转后的新页面
  // 首帧即折叠，避免“先展开再收起”的闪烁。非远控壳不读 intent，防止误消费。
  // 注意 consume 有副作用（删除 key），因此必须放在 useState 初始化函数里，
  // 不能写在 render 主体（StrictMode 双调用会吃掉 intent）。
  const [isWebRemoteControlNavigationCollapsed, setIsWebRemoteControlNavigationCollapsed] =
    useState(() => (isWebRemoteControlShell ? consumeWebRemoteControlCollapseIntent() : false));
  // 初始高度也要过一遍 resolve：默认值是按视口比例算的，窗口很矮时可能超出
  // 允许区间。先 resolve 再入 state，可避免首帧渲染出一个越界高度再被 effect 修正。
  const [webRemoteControlNavigationHeightPx, setWebRemoteControlNavigationHeightPx] = useState(
    () => {
      const viewportHeight = getWebRemoteControlViewportHeight();
      return resolveWebRemoteNavigationDragState({
        heightPx: getDefaultWebRemoteNavigationHeightPx(viewportHeight),
        viewportHeight,
      }).heightPx;
    },
  );
  const [isWebRemoteControlTaskSwitching, setIsWebRemoteControlTaskSwitching] = useState(false);
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  // INV-10：workspaceKey 优先用 identity（远端设备+路径的唯一标识），只在缺失时
  // 退回绝对路径。两者混用会让“本机 /home/x”和“远端 /home/x”被当成同一项目，
  // 进而共享 pane session、保活 PTY 与文件树缓存。
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  // 单调递增的请求 id：同一个文件树重复点击同一路径时，props 完全相同，
  // 靠 id 变化触发下游 effect。用时间戳会在同一毫秒内碰撞。
  const fileTreeOpenRequestIdRef = useRef(0);
  // initialSidebarFileTreeOpen 只在首帧消费：之后由 openFileTreeRequest 产生的
  // id 驱动。若把它当作受控 prop 持续同步，用户手动关闭文件树后会被再次弹开。
  const [fileTreeOpenRequest, setFileTreeOpenRequest] = useState<SidebarFileTreeOpenRequest | null>(
    () =>
      initialSidebarFileTreeOpen
        ? {
            id: 0,
            target: {
              workspacePath: workspaceAbsPath,
              workspaceName: getPathLeaf(workspaceAbsPath),
              workspaceIdentity,
              workspaceRemoteSessionId,
            },
          }
        : null,
  );
  const handleOpenSidebarFiles = useCallback(
    (target: SidebarFileTreeOpenRequest["target"]) => {
      // 文件入口由右侧标签页承接，消费后清除请求，避免侧栏重新挂载时重复打开。
      setFileTreeOpenRequest(null);
      handleOpenFileManager(target);
    },
    [handleOpenFileManager],
  );
  // 传函数而不是函数调用结果：只有当组件真正挂载时才读 matchMedia，
  // 也让 SSR/测试环境可以完全跳过 window 访问。
  const [isWebRemoteControlMobileViewport, setIsWebRemoteControlMobileViewport] = useState(
    getIsWebRemoteControlMobileViewport,
  );
  const [isWebRemoteControlNavigationDragging, setIsWebRemoteControlNavigationDragging] =
    useState(false);
  // 这两个 ref 是 state 的“事件处理专用镜像”。pointerdown/move/up 是高频事件，
  // 若放在 useCallback 依赖里会随高度每次变化重建回调、导致 pointer capture 丢失；
  // 用 ref 读取最新值即可让回调保持稳定（此处刻意不做 INV-01 的手动同步，
  // 而是在下面的 useEffect 中统一同步）。
  const webRemoteControlNavigationHeightRef = useRef(webRemoteControlNavigationHeightPx);
  const webRemoteControlNavigationCollapsedRef = useRef(isWebRemoteControlNavigationCollapsed);
  const webRemoteControlNavigationDragRef = useRef<WebRemoteNavigationDragSession | null>(null);
  // 拖拽结束后浏览器仍会补发一次 click；置 true 让紧随其后的 click 只做“消费”
  // 不做切换，否则一次拖拽会先调高再被 click 折叠，表现为“拖不动”。
  // 它是 ref 而不是 state：click 消费必须同步，state 更新来不及。
  const suppressWebRemoteControlNavigationClickRef = useRef(false);
  // surface 请求来自 browser-use 自动化：它要求某个 tab 以 fixed 层承载截图。
  // 这里只做“请求 → 目标 tab”的解析，不改变面板尺寸；面板尺寸由承载层自己负责，
  // 否则自动化运行时会撑开侧栏（见下面 sidePane 的 open 注释）。
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  // 只看“当前 workspace 的 tab 是否标记了 restorePaneSession”，且必须按 identity
  // 判等（INV-10）。用 some 而不是 find 是为了避免在 selector 里新建对象，
  // 保持 zustand 的引用稳定、减少无谓重渲染。
  const restorePaneSession = useTabStore((state) =>
    state.tabs.some(
      (tab) =>
        isWorkspaceTab(tab) &&
        tab.restorePaneSession &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
    ),
  );
  const lookupPaneSession = useRemotePaneSessionLookup(
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  );
  // 页签决定启动位置，pane 复用既有选择持久化；services ready 前不查询远端。
  // pane 会话持久化：远控壳下 enabled=false（远控没有本地 pane store），
  // 桌面且 tab 要求恢复时才 restoreOnStartup。selectSession 必须走
  // handleSelectTask 的 workspace 版本，保证 identity/remoteSessionId 一起带上。
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    enabled: !isWebRemoteControlShell,
    restoreOnStartup: Boolean(isDesktop && restorePaneSession),
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
    lookupSession: isDesktop ? lookupPaneSession : undefined,
    onSessionMissing: () => handleStartDraftInWorkspace(workspaceAbsPath, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  // 自动收起 effect 只依赖 workspaceMainView（见下），但收起动作需要“最新”的
  // 侧栏/面板开关回调。把这些值放进 ref 同步，避免把它们加进 effect 依赖
  // 造成每次开合面板都重新绑定 window resize 监听。
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  // INV-01：宽度 state 与 ref 必须成对维护。ref 供 pointermove/键盘读取，
  // state 供渲染；两者短暂不一致（拖拽中）是设计允许的，但松手时必须收敛。
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  // INV-14：openWorkspaceKeys 是“当前仍打开的 workspace 集合”，不是“访问过的”。
  // 注意切 tab 时集合内容不变（只是顺序变化），因此不会误触下面的回收逻辑。
  // 推导与 workspaceKey 使用同一套 identity 优先规则，避免保活 key 对不上。
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // 保活回收：workspace tab 真正关闭（从 openWorkspaceKeys 移除）时，回收属于该 workspace 的
  // side pane terminal 常驻 session（杀 PTY + 销 xterm），避免孤儿进程泄漏。
  // 切 workspace 不会让 workspaceKey 离开这个集合，所以保活的 session 不受影响。
  // 对称下侧 Terminal.tsx:145-177 的 openWorkspaceKeys 回收逻辑。
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  // 完整视图（docs/ui/side-pane-full-view.md）只读派生：不改侧栏、面板宽度等原有状态，退出后自然恢复。
  // 远控壳不提供完整视图控制器（没有宿主 fixed 层），因此 fullView 恒为 null。
  // 用 undefined 而不是空实现，让下游的 ?. 自然短路，不会误调用 setSurface。
  const fullViewController = isWebRemoteControlShell ? undefined : sidePaneFullView;
  const activeFullView =
    workspaceMainView === "chat" ? (fullViewController?.fullView ?? null) : null;
  const isFullView = activeFullView !== null;
  const fullViewMode: SidePaneFullViewHostMode = !activeFullView
    ? "normal"
    : activeFullView.surface === "conversation"
      ? "conversation"
      : "floating";
  const isFloatingFullView = fullViewMode === "floating";
  // INV-08：这里在 render 期间赋值（而不是 effect），因为 resize 回调可能在
  // commit 与 effect 之间触发；用 effect 同步会让那一刻读到上一帧的 false，
  // 于是在完整视图里错误地收起面板。
  const isFullViewRef = useRef(isFullView);
  isFullViewRef.current = isFullView;
  const [fullViewSlotElement, setFullViewSlotElement] = useState<HTMLDivElement | null>(null);
  const [floatingAnchor, setFloatingAnchor] = useState<FloatingAnchor>(
    readFloatingAnchorPreference,
  );
  const handleFloatingAnchorChange = useCallback((anchor: FloatingAnchor) => {
    setFloatingAnchor(anchor);
    writeFloatingAnchorPreference(anchor);
  }, []);
  const handleFullViewFloatingChange = useCallback(
    (floating: SidePaneFullViewFloating) => fullViewController?.setFloating(floating),
    [fullViewController],
  );
  const handleOpenFullViewConversation = useCallback(
    () => fullViewController?.setSurface("conversation"),
    [fullViewController],
  );
  const fullViewConversationTitle =
    activeTaskTitle?.trim() || intl.formatMessage({ id: "taskList.untitled" });
  // 完整视图保留左侧任务列表与左上角按钮组，侧栏显隐只由用户开关决定。
  // 完整视图保留左侧任务列表（见上方注释），所以这里不再叠加 !isFullView。
  // 若某天要隐藏，应改这个派生值而不是改 isSidebarVisible 本身，否则退出完整
  // 视图后用户的侧栏开关状态会丢失。
  const isSidebarPanelVisible = isSidebarVisible;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    // 浮窗只承载对话本身；终端只在普通视图和完整视图的对话 tab 中显示，开合状态不变。
    open: isTerminalOpen && !isFloatingFullView,
    // 百分比而非固定像素：窗口大小变化时终端高度按比例跟随，不会出现“小窗里终端占满”。
    expandedSize: "30%",
    // 记住用户手动拖拽后的尺寸；关闭再打开应回到上次高度，而不是重置成 30%。
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // 截图 surface 由 browser-use tab 自己的 fixed 承载层提供尺寸，不能再把整个右侧
    // ResizablePanel 撑开；否则自动化页会闪出空白的 tab 栏，且面板过渡期间 guest surface
    // 仍可能被 Chromium 判定为不可合成。
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    // rememberExpandedSize 为 true：浏览器面板拉宽后关闭再打开不回弹到默认值。
    rememberExpandedSize: true,
    // 首次可见时不要强制 resize：面板可能在隐藏期间由持久化恢复，立即 resize 会让
    // 侧栏与对话列在首帧发生一次宽度跳动（截图/自动化里表现为闪烁）。
    resizeOnInitialVisibleMount: false,
  });
  const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
  // 三个禁用原因合并成一个布尔：只读（权限）、外部要求禁用（如正在导入）、
  // 请求进行中。合并后按钮只判一次，避免三处各写一遍导致文案/禁用态不一致。
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  const simplifyHeaderForNarrowRemote = isWebRemoteControlShell && isWebRemoteControlMobileViewport;
  // 侧栏收起时，新建任务入口移到顶部浮层，保证该动作永远可达；
  // 侧栏展开时由侧栏自己的按钮承载，避免同屏出现两个“新建任务”。
  const showTopOverlayNewTaskButton = !isSidebarVisible;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    // getBoundingClientRect 而非 offsetWidth：包含 transform 后的实际视觉宽度。
    // 元素未挂载时返回 null 而不是 0——0 会被判为“过窄”并误收起面板。
    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    // collapseSidebarIfStillNarrow 先收右侧面板，下一帧再量宽度决定是否收侧栏。
    // 若同步连续判断，面板收起动画尚未生效，量到的仍是旧宽度，会把侧栏也一起关掉。
    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      // 从 ref 取“最新”的开关与 workspaceKey：effect 闭包里的值可能已过期
      // （例如用户刚手动隐藏侧栏），过期值会让 collapseSidebar 反向打开它。
      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    // INV-07：只在 window resize 去抖后调用，不订阅 conversation 的尺寸变化。
    // 用户手动开面板也会改变 conversation 宽度，若监听自身 ResizeObserver，
    // 会把“用户主动开”误判成“窗口变窄”并立刻关掉，形成无法打开面板的死循环。
    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;
      // 完整视图中对话由宿主 fixed 定位，对话列宽度不代表可见对话区，不能据此收起面板或侧栏。
      if (isFullViewRef.current) {
        return;
      }

      // 功能说明：自动收起只响应用户改变窗口尺寸后的 conversation 实际宽度。
      // 不监听 conversation 自身 ResizeObserver，避免用户手动打开面板时又被策略关回去。
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        // 双 rAF：第一帧提交面板收起后的布局，第二帧再量 conversation 宽度。
        // 单 rAF 在部分浏览器上仍可能读到未 reflow 的旧值（引用上面的阈值顺序）。
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    // 去抖：每次 resize 重置同一个 timer，只有停手 300ms 才真正执行判断。
    // 不在 resize 中直接读宽度——高频 reflow 会让窗口拖拽明显掉帧。
    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Bugfix: 大会话 resize trace 显示自动收起侧栏会触发 WorkspaceSidebar
      // 和大量 tooltip/menu 子树重渲染；拖拽窗口过程中先等 resize idle，再保留原收起语义。
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    // INV-19：先设 timer 再挂监听，cleanup 里先清 timer 再摘监听。
    // 若 cleanup 漏清 timer，卸载后仍会执行一次读取 ref 的回调（元素已为 null，
    // 虽不崩但会留下无意义的日志与调度）。
    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  // INV-02：拖拽期间唯一允许的写入口。它只写 ref 与 CSS 变量，绝不 setState。
  // 这样 pointermove 的代价是两次 style.setProperty，而不是整棵侧栏/聊天树的 diff。
  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // Bugfix: 大会话 trace 显示拖拽侧栏时每个 pointermove 都 setState，
      // 会让 WorkspaceShellLayout、WorkspaceSidebar 和 ChatView 大树反复 render。
      // 拖拽中的宽度只是瞬时布局值，直接写 CSS 变量；释放时再提交 React state。
      // 两个变量语义不同：panel-width 是“当前占位宽度”（收起时取窄边），
      // sidebar-width 永远是“用户期望的展开宽度”。只写一个会让收起/展开时
      // 丢失用户此前拖出的宽度，下次展开回弹到默认值。
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  // 一次性迁移 effect：只处理“没有任何新版像素值、但有旧版百分比”的用户。
  // 若新版值已存在则直接返回，保证后续版本不会用旧比例覆盖用户当前宽度。
  // 依赖数组为空是有意的——迁移只应在挂载时发生一次。
  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // 修复原因：外层 workspace shell 不再使用 react-resizable-panels，
    // 但旧版本已持久化过 sidebar/content 百分比。迁移成像素宽度后，
    // 普通窗口 resize 不会再触发 RRP layout store，同时仍保留用户拖出的侧栏宽度。
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  // 非拖拽路径（键盘、程序化恢复）的提交入口：clamp → ref → state → 可选持久化。
  // state 更新使用函数式并在相等时返回原值，避免合法但无变化的 setState
  // 触发一次无意义的整树 render。
  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  // pointerdown：冻结会话快照 + 捕获指针。只在侧栏可见时允许拖拽；
  // 鼠标限定主键（button===0），触控/笔不做按键判断（它们的 button 语义不同）。
  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      // 捕获指针，保证拖动到 iframe/浏览器视图上方仍能收到 move/up。
      // preventDefault 抑制文本选择与原生拖拽（否则会拖出一个幽灵图片）。
      // 两者顺序无关，但都必须在设置 session 之后，避免中途抛错留下半截会话。
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  // pointermove：只做“起始宽度 + 累计位移”的纯计算。INV-03 的 pointerId 校验
  // 必须放在最前，否则第二个指针的移动会拿错误的 clientX 覆盖当前宽度。
  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      // aria-valuenow 每帧同步，读屏用户拖拽时能听到当前像素值；
      // 取整避免某些读屏软件把小数逐位念出来。
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  // pointerup / pointercancel 共用。cancelled=true（如窗口失焦、系统手势打断）
  // 时只回填 state、不持久化：用户并未确认这个宽度，写盘会让下次启动“记住”
  // 一个中途值。INV-03：同样先校验 pointerId。
  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      // 提交 ref 里的最终值（拖拽期间只在 CSS 变量上生效），使 React 状态
      // 与视觉收敛。相等时返回原值，避免无变化也触发一次重渲染。
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      // INV-04：必须先 hasPointerCapture 再 release。浏览器在 pointercancel
      // 时可能已自动释放，未检查的 release 会抛 DOMException 并中断持久化。
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      // 取消路径不写盘（见上方说明）；正常松手才把用户确认的宽度持久化。
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  // 键盘等价操作：Left/Right 步进，Home 回最小值，End 到容器一半。
  // 与拖拽共享 applyWorkspaceSidebarWidth，保证 clamp 与持久化行为完全一致；
  // 未处理的键不 preventDefault，避免吞掉 Tab/Shift+Tab 破坏焦点导航。
  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      // 容器宽度不可得（首帧/隐藏）时把“当前宽度”当作上限，等价于 End 不变；
      // 直接除以 0 会得到 Infinity，setProperty 会写出非法 CSS 并被浏览器忽略。
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  // 卸载兜底：拖拽中路由切换/窗口关闭时，清理 active 态（移除全局光标与
  // 遮罩）。只在卸载执行一次，依赖空数组是安全的——这里读的是 ref 当前值。
  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  // state → ref 的同步点。放在 effect 而不是 render，是为了避免在渲染阶段
  // 写 ref（并发渲染下可能被丢弃）；pointer 处理器只会在用户交互时读取，
  // 届时 effect 必已提交。
  useEffect(() => {
    webRemoteControlNavigationHeightRef.current = webRemoteControlNavigationHeightPx;
    webRemoteControlNavigationCollapsedRef.current = isWebRemoteControlNavigationCollapsed;
  }, [isWebRemoteControlNavigationCollapsed, webRemoteControlNavigationHeightPx]);
  useEffect(() => {
    if (
      !isWebRemoteControlShell ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    // 立即同步一次：从桌面宽度缩放到手机宽度时，change 事件依赖浏览器实现，
    // 首帧可能还没派发；主动读 matches 保证布局不滞后一帧。
    const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
    const syncMobileViewport = () => {
      setIsWebRemoteControlMobileViewport(mediaQueryList.matches);
    };

    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => {
        mediaQueryList.removeEventListener("change", syncMobileViewport);
      };
    }

    // 兼容旧 Safari/WebView：它们只有 addListener/removeListener。
    // 上面的现代分支已 return，只有缺少 addEventListener 时才会走到这里，
    // 因此同一个回调不会被注册两次（重复注册会在一次缩放下 setState 两次）。
    mediaQueryList.addListener(syncMobileViewport);
    return () => {
      mediaQueryList.removeListener(syncMobileViewport);
    };
  }, [isWebRemoteControlShell]);

  useEffect(() => {
    if (!isWebRemoteControlShell || typeof window === "undefined") {
      return;
    }

    // 视口变化后把导航高度重新压回合法区间。折叠态直接跳过：折叠高度是 0，
    // 参与 resolve 会把“展开时的记忆高度”覆盖成 0，用户再展开就只剩一条线。
    const clampNavigationHeightToViewport = () => {
      if (webRemoteControlNavigationCollapsedRef.current) {
        return;
      }

      const viewportHeight = getWebRemoteControlViewportHeight();
      setWebRemoteControlNavigationHeightPx(
        (currentHeightPx) =>
          resolveWebRemoteNavigationDragState({
            heightPx: currentHeightPx,
            viewportHeight,
          }).heightPx,
      );
    };

    // INV-19：监听与移除必须成对，且使用同一个函数引用。这里依赖
    // isWebRemoteControlShell，切换壳类型时重建监听是必要的（远控才有导航）。
    window.addEventListener("resize", clampNavigationHeightToViewport);
    return () => {
      window.removeEventListener("resize", clampNavigationHeightToViewport);
    };
  }, [isWebRemoteControlShell]);
  // 高度与折叠态必须一起提交：只改高度不改折叠会出现“高度 200 但仍标记折叠”
  // 的矛盾状态，CSS 变量与 aria-expanded 会说两套话。nextState 由纯函数统一
  // 产出，调用方（拖拽/点击/resize）不各自拼装，避免三处钳制规则漂移。
  const applyWebRemoteNavigationState = useCallback((nextState: WebRemoteNavigationState) => {
    setWebRemoteControlNavigationHeightPx(nextState.heightPx);
    setIsWebRemoteControlNavigationCollapsed(nextState.isCollapsed);
  }, []);
  // 点击/回车触发的切换。高度由纯函数 resolve，保证“折叠→展开”恢复到用户
  // 上次拖出的高度（而不是默认高度）；viewportHeight 每次现取，适配地址栏收放。
  // debug 日志只在切换时打一条，不进入 pointermove 高频路径。
  const toggleWebRemoteNavigation = useCallback(() => {
    const nextState = resolveWebRemoteNavigationToggleState({
      currentHeightPx: webRemoteControlNavigationHeightRef.current,
      isCollapsed: webRemoteControlNavigationCollapsedRef.current,
      viewportHeight: getWebRemoteControlViewportHeight(),
    });

    logger.debug("[WorkspaceShellLayout] Web 远控导航快速切换", nextState);
    applyWebRemoteNavigationState(nextState);
  }, [applyWebRemoteNavigationState]);
  const handleWebRemoteNavigationResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      // 仅移动端远控允许拖拽：桌面宽度下导航是固定工具栏，拖高会挤压内容
      // 且没有恢复入口。主键检查只对 mouse 生效，触控/笔没有 button=0 的概念。
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      // 折叠态起始高度取 0：用户从“一条线”往上拖时，位移应直接变成展开高度，
      // 若取记忆高度，第一次拖动会瞬间跳变到旧高度。
      const startHeightPx = webRemoteControlNavigationCollapsedRef.current
        ? 0
        : webRemoteControlNavigationHeightRef.current;
      webRemoteControlNavigationDragRef.current = {
        pointerId: event.pointerId,
        startHeightPx,
        startY: event.clientY,
        didDrag: false,
      };
      // 先置 suppress，再进入 dragging：pointerdown 之后浏览器可能立刻派发
      // 一次 click（某些 WebView），顺序反了会漏抑制、导致“按下即折叠”。
      suppressWebRemoteControlNavigationClickRef.current = true;
      // dragging 只控制视觉（手柄高亮/禁用过渡），不参与几何计算。
      setIsWebRemoteControlNavigationDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽开始", {
        startHeightPx,
      });
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteNavigationResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      // 4px 死区：手指/触控笔的轻微抖动不应把一次“点击”变成 1px 的高度变化。
      // 一旦越过阈值就永久置 didDrag，之后即使回到原点也不再视作点击。
      const deltaY = event.clientY - dragSession.startY;
      if (!dragSession.didDrag && Math.abs(deltaY) < WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX) {
        return;
      }

      // preventDefault 抑制移动端浏览器把纵向拖动当成页面滚动/下拉刷新，
      // 这是远控导航能稳定拖高的前提；只在确认进入拖拽后才调用，避免影响点击。
      event.preventDefault();
      dragSession.didDrag = true;
      applyWebRemoteNavigationState(
        resolveWebRemoteNavigationDragState({
          heightPx: dragSession.startHeightPx + deltaY,
          viewportHeight: getWebRemoteControlViewportHeight(),
        }),
      );
    },
    [applyWebRemoteNavigationState],
  );
  const finishWebRemoteNavigationResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      // 先清 session：后续的 toggle/commit 都会触发重渲染，若 session 还在，
      // 迟到的 pointermove 仍可能改写高度（尤其 cancelled 分支）。
      webRemoteControlNavigationDragRef.current = null;
      setIsWebRemoteControlNavigationDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (cancelled) {
        suppressWebRemoteControlNavigationClickRef.current = false;
        return;
      }

      // 未进入拖拽 = 一次点击：交给 toggle 处理（展开/折叠）。
      // 这里不直接 setState，保证鼠标与键盘（Enter/Space）走同一条语义路径。
      if (!dragSession.didDrag) {
        toggleWebRemoteNavigation();
        return;
      }

      const nextState = resolveWebRemoteNavigationDragState({
        heightPx: dragSession.startHeightPx + event.clientY - dragSession.startY,
        viewportHeight: getWebRemoteControlViewportHeight(),
      });
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽结束", nextState);
      applyWebRemoteNavigationState(nextState);
    },
    [applyWebRemoteNavigationState, toggleWebRemoteNavigation],
  );
  // 拖拽结束后浏览器补发的 click 在这里被消费。用 ref 而不是 state，
  // 是因为 click 可能紧接着 pointerup 同步派发，state 更新尚未生效。
  // 注意消费后必须复位，否则下一次真实点击也会被吞掉。
  const handleWebRemoteNavigationHandleClick = useCallback(() => {
    if (suppressWebRemoteControlNavigationClickRef.current) {
      suppressWebRemoteControlNavigationClickRef.current = false;
      return;
    }

    toggleWebRemoteNavigation();
  }, [toggleWebRemoteNavigation]);
  // 选中任务后自动折叠顶部导航（移动端），把垂直空间让给消息。
  // crossWorkspace 时额外写 session intent：新页面是全新挂载，内存状态带不过去，
  // 只能靠 sessionStorage 在首帧消费（见 consumeWebRemoteControlCollapseIntent）。
  const handleWebRemoteTaskOpen = useCallback(
    ({ crossWorkspace }: { crossWorkspace: boolean }) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }

      // Bugfix: 远控移动端在“选中任务”后仍保持顶部导航展开，会挤压会话区域，读写消息时需要再手动折叠一次。
      // 这里在任务点击后自动折叠；跨 workspace 跳转时再写一次 session intent，确保新页面首帧也保持折叠态。
      setIsWebRemoteControlNavigationCollapsed(true);
      if (crossWorkspace) {
        markWebRemoteControlCollapseIntent();
      }
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  // 任务切换中标志用于显示骨架/禁用输入。它只是视觉状态，不参与路由判断，
  // 因此不需要从 ref 读取，也不会引起导航逻辑的重入。
  const handleWebRemoteTaskSwitchingChange = useCallback((switching: boolean) => {
    setIsWebRemoteControlTaskSwitching(switching);
  }, []);
  // 三条件同时满足才渲染顶部导航：远控壳、移动端视口、且不是桌面嵌入。
  // 判据集中在这个纯函数里，JSX 不再重复布尔组合（否则两处容易写反）。
  const renderWebRemoteNavigationPanel = shouldRenderWebRemoteNavigationPanel({
    isCollapsed: isWebRemoteControlNavigationCollapsed,
    isMobileViewport: isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
  });
  // 高亮请求带 workspace 身份与 taskId：只有“当前 workspace + 当前任务”才生效。
  // 用 buildTaskWorkspaceKey 而不是直接比路径，避免远端/本机同路径互相命中（INV-10）。
  // 返回原对象引用（而不是 {...request}），让下游 memo 比较保持有效。
  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  // 查找对话框使用“当前主视图”的 placement：automations/plugin-store 下不挂载，
  // 因此这里只负责构造元素，是否渲染由 chatOverlay / 主视图分支决定。
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const gitDirtyFileCount = useMemo(() => {
    // 关键业务逻辑：同一个文件可能同时出现在 staged / unstaged。
    // 这里按 path 去重后再统计，避免入口里“未提交更改文件数”被重复计算。
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  // remoteTarget 只从“当前 workspace 对应的 tab”取：路径相同但 identity 不同的
  // 远端设备是另一个 workspace，不能共用 target（INV-10）。
  // 找不到 tab 时返回 undefined，让远控调用方走“本地直连”分支。
  const workspaceRemoteTarget = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.remoteTarget,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  // 远端 MCP 同步需要“本地路径”而不是远端路径：这里只在 identity 也匹配时
  // 才取 tab 上的 localWorkspacePath，避免两个同名项目互相拿到对方的本地目录。
  const workspaceLocalPathForRemoteMcpSync = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.localWorkspacePath,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  // 只有远控壳才写 --web-remote-navigation-height；桌面壳返回 undefined，
  // 避免在非远控 DOM 上留下一个无消费者的 CSS 变量（也方便快照测试比对）。
  const webRemoteNavigationPanelStyle = useMemo<CSSProperties | undefined>(
    () =>
      isWebRemoteControlShell
        ? ({
            "--web-remote-navigation-height": `${webRemoteControlNavigationHeightPx}px`,
          } as CSSProperties)
        : undefined,
    [isWebRemoteControlShell, webRemoteControlNavigationHeightPx],
  );
  // 布局变量集中注入根节点：panel-width 是“当前占位”（收起时窄边），
  // sidebar-width 是“记忆宽度”。CSS 里子面板只读变量、不各自算宽高，
  // 保证拖拽期间只改一处即可让整列同步（INV-01/02）。
  // 变量值都带 px 后缀，CSS 侧直接 calc() 使用，不需要再做单位换算。
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        ...webRemoteNavigationPanelStyle,
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
      webRemoteNavigationPanelStyle,
    ],
  );
  // 文件链接的归属解析：用“路径前缀 + identity + remoteSessionId”三项过滤。
  // 只按路径会命中多个 workspace（嵌套项目、远端同路径），必须靠后两项收敛。
  // identity 为空时才退化为纯路径匹配，这是兼容旧数据的有意降级。
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      // isWorkspaceFilePathInside 负责“路径边界”判断（避免 /a/b 命中 /a/bc），
      // 这里不再做字符串 startsWith，否则会把同前缀的兄弟目录误判为归属。
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        // 多个 workspace 都包含该路径时，优先当前 workspace：用户点自己项目里的
        // 相对链接，期望在当前窗口打开，而不是跳到另一个同名目录。
        // 排序复制了数组（filter 已返回新数组），不会改到 workspaceTabs 本身。
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          // 同优先级时取路径更长（更具体）的那个：嵌套 workspace 中，
          // 内层路径比外层更贴近目标文件，打开它才符合用户直觉。
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  // 文件树“定位到某路径”的入口。id 每次自增，即使连续两次打开同一文件，
  // 下游也能通过 id 变化重新滚动/展开；用对象内容做依赖则第二次会被 memo 短路。
  const openFileTreeRequest = useCallback((request: Omit<SidebarFileTreeOpenRequest, "id">) => {
    fileTreeOpenRequestIdRef.current += 1;
    setFileTreeOpenRequest({
      id: fileTreeOpenRequestIdRef.current,
      ...request,
    });
  }, []);
  // 所有“回到会话”的路径都调用它，而不是各自写 setState：主视图切换可能
  // 涉及动画/路由持久化，集中一处才能保证“跳转成功”的判据一致（INV-11）。
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  // 返回按钮的行为由当前主视图决定：插件市场是“壳内页面”，返回=回聊天；
  // 其它视图沿用任务导航历史。两者不可合并，否则从插件市场返回会跳到上一个任务。
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? showChatMainView : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  // INV-13：远控壳不实现 automations / plugin-store，检测到残留主视图时强制回落。
  // 用 effect 而不是派生值，是为了让 onWorkspaceMainViewChange 的持久化也一起
  // 修正；只渲染 chat 而不改状态，下次刷新仍会回到错误视图。
  useEffect(() => {
    if (
      isWebRemoteControlShell &&
      (workspaceMainView === "automations" || workspaceMainView === "plugin-store")
    ) {
      // 修复原因：手机远控复用桌面 shell 时可能保留上一次主视图状态；
      // 远控不承载 Automations，必须立即回落到 continuous/replayable 边界之外的聊天页。
      onWorkspaceMainViewChange("chat");
    }
  }, [isWebRemoteControlShell, onWorkspaceMainViewChange, workspaceMainView]);
  // 新建任务：先切回聊天主视图再交给上层 onCreateTask。顺序不能反——
  // 上层可能同步渲染新会话，若此时还在 automations/plugin-store，会挂载到错误容器。
  // 只读拦截只针对“活动 workspace”的请求，带 targetWorkspace 的跨项目请求放行（INV-12）。
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
      // 目标另属他项目（跨项目发起已保存工作流，docs/dynamic-workflow/launch.md「The detail page」），
      // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
      // 运行时判空而不是信任类型：调用方可能从 JS/旧版本传入 null。
      // targetWorkspace 为空对象也算“没有 target”，交给 root 动作按活动 workspace 处理。
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      // 静默返回而不是 toast：入口按钮在只读时已禁用，能走到这里通常是程序化调用，
      // 弹提示反而会打扰用户（真正的错误由 root 动作统一提示）。
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  // workbench 绑定 = 当前任务 + 其 workspace 坐标（identity/remoteSessionId 可选）。
  // 三个坐标一起传，selectWorkbenchSession 才能在分屏里定位到唯一会话；
  // 只传 sessionId 会在同名项目/远端同路径时选错 pane。
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  // 切入草稿曾改变侧栏选任务回调，让全部项目重渲染；点击时使用最近已提交的绑定，保留分屏导航语义。
  // INV-15：事件处理器只读 ref，不直接依赖 shellWorkbenchBinding。草稿切换会让
  // activeTaskId 变为临时 id，若回调依赖它，所有分屏相关 props 都会换引用，
  // 导致整棵侧栏/聊天树重渲染；ref 在 layout effect 提交最新值，点击时取到的
  // 仍是“最近一次已提交”的绑定，语义不受影响。
  const shellWorkbenchBindingRef = useRef(shellWorkbenchBinding);
  useLayoutEffect(() => {
    shellWorkbenchBindingRef.current = shellWorkbenchBinding;
  }, [shellWorkbenchBinding]);
  // 从自动化页/工作流页“以提示词新建会话”。带 target 时不做活动 workspace 的
  // 只读拦截，由 handleCreateTaskInChat 透传到 root 动作按 target 校验（INV-12）。
  // 这里不直接调用 onCreateTask：必须复用聊天入口的“先切主视图”顺序。
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
      // target 上校验（docs/dynamic-workflow/launch.md「The detail page」）；无 target 时形状不变。
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // 工作流「运行」现由中枢直接启动（docs/dynamic-workflow/launch.md）：GUI 建空会话 +
  // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
  // INV-20：所有“打开某任务”的入口最终都汇到这里。它承担四件事：
  // 1) 非远控时确保目标 workspace 的 tab 已激活（必要时补开）；
  // 2) 解析 remoteSessionId 并写 workbench 绑定（分屏定位）；
  // 3) 只有成功后才切 chat 主视图；4) 交给 handleSelectTask 统一选中语义。
  // 任何一步失败都保留当前页面 + toast，绝不制造“跳转成功”的假象。
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      // 远控壳只有一个 workspace，不需要也不应该操作本地 tab store；
      // 跳过整段本地绑定逻辑，直接进入选中 + 切视图。
      if (!isWebRemoteControlShell) {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        // INV-11：accepted=false 表示目标 workspace 不可用（远端未连接/本地补开失败）。
        // 此时必须 return，不能继续 showChatMainView，否则用户看到的是“停留在
        // 原任务但主视图被切走”，比失败更令人困惑。
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        // 调用方显式给的 remoteSessionId 优先；缺失时才按 workspaceKey 从已打开
        // tab 反查。反查同样用 identity 优先的 key，不能只比路径（INV-10）。
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: WorkbenchSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        // 用 ref 里的“最近已提交绑定”而不是当前 render 的绑定（INV-15）：
        // 草稿态下 activeTaskId 是临时 id，直接用它做分屏定位会找不到 pane。
        selectWorkbenchSession(shellWorkbenchBindingRef.current, target);
      }
      // 只有目标 workspace 已经激活或补开成功后才关闭 Automations，避免失败时看起来像跳转成功。
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
    },
    [handleSelectTask, intl, isWebRemoteControlShell, showChatMainView, tabStoreApi, workspaceTabs],
  );
  // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
  // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
  // 「已保存」芯片的落点：交给 App 切主视图并设深链（与「自动化」入口同一条导航历史）。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      onOpenSavedWorkflowInHub(target);
    },
    [onOpenSavedWorkflowInHub],
  );
  // 工作流启动后的跳转：target 里带完整 workspace 坐标（路径+identity+远端会话），
  // 因此不能简化为“选中当前会话”——启动可能发生在另一个项目。
  // 统一转交 handleSelectTaskInChat，复用其 tab 激活与失败保留逻辑（INV-20）。
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目（不变式 8）。
      // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      // 先选中会话、再开 run 详情：反过来会在会话尚未激活时打开一个
      // 不属于当前上下文的 pane，随后被会话切换卸载，用户看到闪一下。
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：与 composer 徽标
  // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      // 没有 toolCallId 的 run 无法定位到工具卡片，只做“打开会话”这一最小动作，
      // 而不是退化为打开一个空 run 详情（那会显示一个永远 loading 的 pane）。
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      // 有 toolCallId 时复用“查看实例”的整条路径：它会先选中会话再开 run pane，
      // 保证侧栏行、composer 徽标、中枢三个入口行为完全一致。
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
  // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
        // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 分屏 pane 内部切换会话时回调。scope 由 pane 宿主提供（含远端坐标），
  // 因此这里不读“活动 workspace”，避免用户在分屏里操作 B 项目却把 A 打开。
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      // 先切主视图再创建草稿：草稿的 composer 只能在 chat 视图里挂载，
      // 反序会让“新建草稿”先渲染到一个隐藏容器，输入框拿不到焦点。
      // targetWorkspacePurpose/createSource 原样透传，Shell 不解释其语义。
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
        createSource,
      );
    },
    [handleStartDraftInWorkspace, showChatMainView],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
    [handleStartDraftInWorkspaceInChat],
  );
  // 活动 workspace 的用途（project / conversation / automation）。必须带 identity
  // 一起匹配，否则远端同名路径会被当成另一个用途；默认 project 是安全兜底
  // （conversation 会隐藏 Git 分支等仅项目适用的 UI）。
  const activeWorkspacePurpose =
    workspaceTabs.find(
      (tab) =>
        tab.workspacePath === workspaceAbsPath &&
        (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
    )?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    // 解析 conversation workspace 需要跨进程/远端查询，可能失败。失败只记日志
    // 并返回：这是用户主动切换，失败后停留在当前源文档比弹错更有用。
    let target: Awaited<ReturnType<typeof onResolveConversationWorkspace>>;
    try {
      target = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    // Bug 原因：这里曾用 targetWorkspacePath 在 workspaceTabs 里反查 conversation tab 的 identity。
    // 多设备的 conversation backing path 同为各自 home 下的固定目录，home 相同时会命中别的设备。
    // 现在 identity 由 Root 按 Source 归属解析后一并回传，Shell 直接消费，不再按路径判等。
    const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspaceKey) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath: target.workspacePath,
        targetWorkspaceIdentity: target.workspaceIdentity,
      });
    }
    // purpose 固定 conversation：这条路径专门服务“把对话移到另一个项目”，
    // 若沿用当前 purpose 会把目标项目误标成 project 并触发 Git 相关逻辑。
    handleStartDraftInWorkspaceInChat(
      target.workspacePath,
      target.workspaceIdentity,
      "conversation",
    );
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  // 插件提及：以 prepend-if-missing 语义插入，避免用户连续点同一插件时
  // 在输入框里堆叠多份相同提及。写的是当前 workspace 的 composer 草稿，
  // 因此 identity 必须一起传，防止远端同名项目串草稿。
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
  // createSession/fork 后接入既有选择路径；删除会话后回 draft。
  // pane 内 createSession/fork 成功后，统一走旧的选择路径（不是 InChat 版本）：
  // 新会话已经诞生在当前 workspace 内，不需要再激活 tab 或切换主视图。
  // 这样也避免一次不必要的 workspace ensure 往返。
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  // 草稿头部保留项目菜单与 Git 分支；项目目录由共享 Provider 提供。
  // Shell 只连接既有导航回调，pane 不持有另一份项目列表或 cwd 归属推断。
  // 草稿头部用 useMemo 冻结，依赖只列真正影响其渲染的值；否则每次输入都会
  // 重建整棵 ProjectComposerMenu（含项目列表/Git 状态），造成输入卡顿。
  const draftComposerHeader = useMemo(
    () => (
      // 这里的注释位于箭头函数表达式位置（不是 JSX children），不会被渲染成文本。
      <ProjectComposerMenu
        showEditProject
        workspacePath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        compactForRemoteControl={isWebRemoteControlShell}
        onCreateTask={handleCreateTaskInChat}
        onSelectConversationWorkspace={handleSelectConversationWorkspace}
        allowRemoteWorkspace={allowRemoteWorkspace}
        onOpenRemoteWorkspace={onOpenRemoteWorkspace}
        onConnectRemote={onConnectRemote}
        onCancelRemote={onCancelRemoteProject}
      >
        {isOfficeMode && !isWebRemoteControlShell ? (
          <WorkspacePluginPreview
            onOpen={handleOpenPluginStore}
            onSelectPlugin={handleSelectComposerPlugin}
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId ?? undefined}
          />
        ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
          <GitBranchSwitcher
            workspacePath={workspaceAbsPath}
            gitSummary={gitState.summary}
            dirtyFileCount={gitDirtyFileCount}
            onRefreshGit={handleRefreshGit}
            compactForRemoteControl={isWebRemoteControlShell}
            className="px-0 pt-0"
            popoverClassName="w-72"
            branchListClassName="max-h-48"
            // Bugfix（旧注释保真）：输入框区域在底部，Radix 碰撞避让会把分支菜单翻到下方。
            // 这里锁定上方弹出，避免菜单遮挡输入区并保持操作方向稳定。
            avoidPopoverCollisions={false}
          />
        ) : null}
      </ProjectComposerMenu>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleCreateTaskInChat,
      isWebRemoteControlShell,
      onOpenRemoteWorkspace,
      onConnectRemote,
      onCancelRemoteProject,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      // 只读 workspace 禁止“打开工作区外文件”，但 base-local（编辑器自身的内置
      // 帮助文档）仍可打开：它是只读资源，不需要写权限。静默忽略而非弹错，
      // 因为 markdown 里的链接可能批量指向外部路径。
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        // 双 fileService：target 属于远端 workspace 时用它的连接，否则用当前
        // workspace 的；baseServices 兜底到编辑器只读文件系统。选择器集中判断，
        // 避免这里再写一遍“有没有 remoteSessionId”的分支。
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        // INV-16：先 stat 再分流。用 stat 而不是扩展名猜测，是因为目录也可能
        // 叫 “foo.md”；只按后缀判断会把目录交给 CodeViewer，读出来是 EISDIR。
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
              compactForRemoteControl: isWebRemoteControlShell,
            })
          ) {
            // 助手生成的 html 在浏览器里打开（可执行脚本/样式），而不是源码视图。
            // 判定含 compactForRemoteControl：远控下没有本地文件协议，需走代理 URL。
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          // CodeViewer 需要完整 workspace 坐标：仅传绝对路径时，远端文件会被
          // 当成不存在的本地路径，表现为“打开空白页”。
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        // base-local 的目录（如内置文档根）不属于任何打开的 workspace，
        // 用 temporaryExternalDirectory 临时挂一棵树，而不是强行塞进当前项目。
        if (target.serviceScope === "base-local") {
          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
          return;
        }

        // 目录型链接优先落到“包含该路径的已打开 workspace”，这样文件树有
        // 完整的项目上下文（Git、忽略规则）。找不到才降级为临时外部目录。
        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFileTreeRequest({
            target: {
              workspacePath: ownerWorkspace.workspacePath,
              workspaceName: ownerWorkspace.label,
              workspaceIdentity: ownerWorkspace.workspaceIdentity,
              workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
              revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
                ? undefined
                : target.path,
            },
          });
          return;
        }

        openFileTreeRequest({
          target: {
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
            temporaryExternalDirectory: true,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
          path: target.path,
          error: message,
        });
        // 顺序：先开 viewer 再 toast。toast 是瞬时提示，先弹会被随后挂载的
        // viewer 遮挡并打断入场动画；放在后面则两种结果都能被用户看到。
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // Bugfix: markdown file link 可能指向已不存在的路径。
          // stat 失败时保持旧行为交给 CodeViewer 展示具体读文件错误，避免点击完全无反馈。
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      isWebRemoteControlShell,
      openFileTreeRequest,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  // 全局“打开工作区路径”总线的订阅。返回的 unsubscribe 直接作为 effect cleanup，
  // 因此回调必须保持稳定（依赖 handleOpenMarkdownFileLink 的 useCallback）；
  // 若每次 render 换引用，会反复解绑/重绑，丢失订阅窗口期内的事件。
  // void 表示不等待：总线是同步派发的，等待会让打开动作阻塞其它监听者。
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  // Git 变更列表点击文件：在“当前”项目树里定位，不接受外部 target。
  // 只读时直接返回——定位本身虽只读，但文件树在此模式下不渲染写操作，
  // 打开它只会让用户发现按钮全部禁用。
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFileTreeRequest({
        target: {
          workspacePath: workspaceAbsPath,
          workspaceName: projectName,
          workspaceIdentity,
          workspaceRemoteSessionId,
          revealPath: path,
        },
      });
    },
    [
      openFileTreeRequest,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  // 侧边对话 tab 必须同时匹配 workspaceKey 与 parentSessionId：只匹配父会话
  // 会在两个 workspace 恰好有同名 sessionId 时串台（远端 id 可能重复）。
  // 找不到时返回 null，UI 据此显示“创建”而不是“打开”。
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  // 选区辅助对话的“启动器”只发一条命令给主 SessionPane，不自己拼远程身份/
  // 协议（见下方注释）。requestSelectionSideChatOpen 返回 false 说明主 pane
  // 尚未挂载，此时只记 warn，不重试——重试会在挂载瞬间重复创建 tab。
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  // 任一更新阶段都要显示状态按钮：可更新/下载中/已下载。release notes 等
  // 中间态不显示，避免顶栏在没有可操作项时多出一个死按钮。
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  // 侧栏面板的唯一渲染函数。options.mobileOverlay 表示“手机远控的浮层版本”：
  // 它不渲染窗口控制按钮、不参与完整视图、不绑定桌面 ref，但共享同一份 tab 状态。
  // 不要在别处再造一个简化版面板，否则 tab/浏览器行为会两套实现分叉。
  const renderSidePanePanel = (options: { mobileOverlay?: boolean } = {}) => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass({
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
        isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
        supportsNativeRoundedCorners:
          desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
      })}
      // 手机浮层已由系统手势区承载关闭，重复渲染窗口按钮会与手势冲突；
      // usesInlineWindowControls 由桌面平台能力决定（mac 原生红绿灯时不渲染）。
      showWindowControls={!options.mobileOverlay && usesInlineWindowControls}
      // 工作区保活与侧栏动画会保留 DOM；独立 guest 浮层必须同步服从当前页面的展示状态。
      // INV-05：四个条件必须同时成立。isWorkspaceVisible 负责“tab 是否在前台”
      // （保活 workspace 会保留 DOM，必须隐藏），workspaceMainView==="chat" 负责
      // 切到 automations/plugin-store 时不露出浏览器；isSidePaneOpen 是用户意图，
      // isSidePaneVisible 是宽度动画状态。缺少任何一项都会出现“隐藏但仍然可交互”
      // 或“用户已关闭却仍占位”的故障。
      isVisible={
        isWorkspaceVisible &&
        workspaceMainView === "chat" &&
        isSidePaneOpen &&
        (options.mobileOverlay || isSidePaneVisible)
      }
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      // 完整视图按钮只在“有控制器且不是手机浮层”时出现：浮层没有 fixed 宿主，
      // 进入完整视图会变成全屏遮挡、无法退出。
      fullViewToggle={
        !options.mobileOverlay && fullViewController
          ? {
              active: isFullView,
              onToggle: fullViewController.toggle,
              shortcutLabel: toggleSidePaneFullViewShortcutLabel,
            }
          : undefined
      }
      // activeFullView 与 fullViewController 必须同时存在才进入完整视图；
      // 只有 surface 没有控制器（远控）时传 null，面板按普通侧栏渲染。
      // leadingInset 依赖 hasUpdateStatusButton：有更新按钮时需要多留一段左侧间距。
      fullView={
        !options.mobileOverlay && activeFullView && fullViewController
          ? {
              surface: activeFullView.surface,
              conversationTitle: fullViewConversationTitle,
              leadingInsetClassName: resolveTopOverlayLeadingPaddingClass({
                isSidebarVisible,
                isMacDesktop,
                isMacFullscreen,
                hasUpdateReady: hasUpdateStatusButton,
              }),
              onSelectSurface: fullViewController.setSurface,
            }
          : null
      }
      // 桌面把“完整视图挂载槽”注册给宿主（用于把对话列 portal 进来）；
      // 手机浮层不注册，避免覆盖主会话的槽位导致远控里出现两个 fixed 层。
      fullViewSlotRef={options.mobileOverlay ? undefined : setFullViewSlotElement}
      // tab 状态与“最近关闭”必须由同一个宿主提供：面板只消费，不自己存副本；
      // 两份状态会让“恢复关闭的 tab”在桌面/手机两个宿主下恢复出不同的 tab 集合。
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      // 三件套决定面板内所有文件/终端操作落到哪个 workspace：
      // 只传 path 会让远端项目复用本地 fileService，表现为“目录存在但读不出文件”。
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      // 两个宿主各自的 ref：手机浮层与桌面面板同时存在时，若共用 ref，
      // 命令式展开/收起会作用到另一个不可见的 panel 上。
      panelRef={options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef}
      panelElementRef={
        options.mobileOverlay ? mobileSidePanePanelElementRef : sidePanePanelElementRef
      }
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      // 截图 surface 只允许桌面承载：手机浮层是覆盖层，自动化截图若挂到浮层上，
      // 会截到浮层自身而不是目标网页。tabId 同步置 null，避免面板误判。
      screenshotSurfaceRequest={options.mobileOverlay ? null : screenshotSurfaceRequest}
      screenshotSurfaceTabId={options.mobileOverlay ? null : (screenshotSurfaceTab?.id ?? null)}
      // 文件变更查找与对话查找是两套独立状态：共用会让 Ctrl+F 在当前面板是
      // CodeViewer 时把查询串泄漏到对话，反之亦然。
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onOpenNewTab={handleOpenNewSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenFileManager={handleOpenFileManager}
      onNavigateFileManager={handleNavigateFileManager}
      onOpenPluginMarket={handleOpenPluginMarket}
      onCreateTask={handleCreateTaskInChat}
      isMacDesktop={isMacDesktop}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
      // mobileStacked 与 mobileOverlay 是两个维度：前者是“远控能力”（决定 tab
      // 是否纵向堆叠/隐藏关闭按钮），后者是“当前是否浮层渲染”。桌面远控仍是
      // mobileStacked=true，因此不能用一个布尔同时表达二者。
      mobileOverlay={options.mobileOverlay}
      mobileStacked={isWebRemoteControlShell}
    />
  );
  // 桌面常驻副本。手机浮层会在 renderRemoteShell 里另调一次 renderSidePanePanel
  // 并传 mobileOverlay；两者共享 sidePaneState，因此不会出现两份 tab 数据。
  const sidePanePanel = renderSidePanePanel();
  // 修复原因：Draft 之前维护一套独立轻量 header，导致 side pane、caption 安全区和拖拽入口
  // 与 Task Header 分叉。桌面端统一复用 WorkspaceHeader，只由 variant 裁剪 task 专属内容；
  // 手机远控无 active task 时仍不渲染桌面 chrome，继续遵守 replayable overlay 边界。
  // automations / plugin-store 是“壳内独立页”，自带标题栏；再渲染主视图 header
  // 会出现两条标题与两个返回按钮。这里只控制 header，不影响侧栏。
  const shouldRenderMainViewHeader =
    workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
  // 手机远控在“无 active task”的 Home 态不渲染桌面 header：Home 用可回放的
  // overlay 结构，多一条 header 会破坏 transition 的首帧快照（见上方修复说明）。
  // 桌面无任务时仍渲染，因为需要展示新建/项目入口。
  const shouldRenderWorkspaceHeader =
    shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop);
  // 修复原因：ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
  // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  // INV-17：数组必须 useMemo。draft 态用字面量 "draft" 而不是 null，是为了让
  // “无任务”也拥有稳定的 key 值；null 与 string 混用会让 devtools/比较逻辑抖动。
  // 依赖只列 workspaceKey 与 activeTaskId，其它状态变化不应重置错误边界。
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );
  // 侧栏显隐变化需要重置该子树的错误边界：收起时若留下错误态，展开后用户
  // 只能看到一片空白且无法恢复。与 workspaceKey 一起作为 reset 条件。
  const workspaceSidebarVisibilityResetKeys = useMemo(
    () => [workspaceKey, isSidebarVisible],
    [workspaceKey, isSidebarVisible],
  );

  // 手机 home 与桌面 sidebar 共用同一个项目入口；Shell 只接收导航完成事件。
  // 侧栏在“桌面常驻”与“手机 Home”两种宿主下复用。传 mobile 即手机宿主：
  // 额外的 navigateToChat/setSwitching 让侧栏能主动完成页面切换；
  // 桌面不传，回调保持原始引用（INV-15 的 memo 前提）。
  const renderWorkspaceSidebar = (mobile?: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  }) => (
    <WorkspaceSidebar
      workspacePath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      onOpenFileManager={
        mobile
          ? (target) => {
              handleOpenSidebarFiles(target);
              // 手机 Home 不挂载 side pane，文件入口必须同时进入 Chat。
              mobile.navigateToChat();
            }
          : handleOpenSidebarFiles
      }
      // INV-20：任务选中必须走 InChat 版本（含 tab 激活/远端 identity 解析）。
      // 直接传 handleSelectTask 会让“点开源自其它项目的任务”停在当前页。
      onSelectTask={handleSelectTaskInChat}
      onStartDraftInWorkspace={handleStartDraftInWorkspaceInChat}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      fileTreeOpenRequest={fileTreeOpenRequest}
      onCreateTask={handleCreateTaskInChat}
      // 缺失时回退到普通创建：老调用方没有“带对话内容”的入口，
      // 直接传 undefined 会让侧栏里的“带提示词新建”按钮变成死按钮。
      onCreateConversationTask={onCreateConversationTask ?? handleCreateTaskInChat}
      onCreateConversationTaskOnSource={onCreateConversationTaskOnSource}
      onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
      onOpenRemoteWorkspace={onOpenRemoteWorkspace}
      webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
      theme={theme}
      onConnectRemote={onConnectRemote}
      onSelectRemoteProject={onSelectRemoteProject}
      onCancelRemoteProject={onCancelRemoteProject}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      // 恢复态/错误态按 workspaceKey 分桶：侧栏要能对单个项目显示“重连中/失败”，
      // 合并成一个全局布尔会让所有远端项目一起转圈。
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      onLogout={onLogout}
      onLogin={onLogin}
      user={user}
      isDesktop={isDesktop}
      isWebRemoteControl={isWebRemoteControlShell}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      isSidebarVisible={isSidebarVisible}
      onToggleSidebar={handleToggleSidebar}
      toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
      canGoBack={canPrimaryNavigationBack}
      canGoForward={canTaskNavForward}
      onGoBack={primaryNavigationBack}
      onGoForward={handleTaskNavForward}
      goBackShortcutLabel={goBackShortcutLabel}
      goForwardShortcutLabel={goForwardShortcutLabel}
      onOpenCommandCenter={handleOpenCommandCenter}
      onOpenAutomations={handleOpenAutomations}
      // 两个“当前页”标记必须与主视图枚举同源：用本地布尔缓存会在深链/返回时
      // 与实际渲染的页面错开，侧栏高亮停留在旧条目上。
      automationsActive={workspaceMainView === "automations"}
      onOpenPluginStore={handleOpenPluginStore}
      pluginStoreActive={workspaceMainView === "plugin-store"}
      // 桌面没有 mobile 导航动作；内联包装曾让右侧开关穿透侧栏 memo，重复渲染全部项目。
      // 手机宿主才有 crossWorkspace：它由侧栏根据目标 tab 是否已激活算出，
      // 决定是否需要写 session 折叠 intent（新页面内存状态带不过去）。
      onWebRemoteTaskOpen={
        mobile
          ? (event) => {
              handleWebRemoteTaskOpen(event);
              // 跨工作区由目标 Root 消费 chat 意图后再导航，不能提前展示旧会话。
              if (!event.crossWorkspace) mobile.navigateToChat();
            }
          : handleWebRemoteTaskOpen
      }
      onWebRemoteTaskSwitchingChange={
        mobile
          ? (switching) => {
              handleWebRemoteTaskSwitchingChange(switching);
              mobile.setSwitching(switching);
            }
          : handleWebRemoteTaskSwitchingChange
      }
    />
  );

  // 断点切换曾卸载查看 Reporter，伪造离开后返回并清掉手动未读。
  // 同一 Shell 持有查看与手机导航，只替换布局内容；真实 Home/后台仍立即撤销查看。
  const renderRemoteShell = (wideContent: ReactNode) =>
    webRemoteControlWorkspaceSwitcher ? (
      <WebRemoteControlMobileShell
        // 视口断点只影响“壳的排布”，不影响能力：桌面宽度远控仍是 mobile shell，
        // 只是导航常驻。isWebRemoteControlMobileViewport 由 matchMedia 同步维护。
        isMobileViewport={isWebRemoteControlMobileViewport}
        // 手机壳在“切任务中”禁用任务视图：此时旧会话的 DOM 仍在，允许交互会
        // 让用户对即将卸载的会话发消息（消息会丢在旧 pane 的本地草稿里）。
        taskViewEnabled={
          isWorkspaceVisible && workspaceMainView === "chat" && !isWebRemoteControlTaskSwitching
        }
        // 壳级坐标决定“当前展示的是 Home 还是某个会话”。这里传 Shell 自己的
        // activeTaskId/identity/path，而不是从 pane 里反查，否则分屏时会话切换
        // 不会同步到手机导航的选中项。
        activeTaskId={activeTaskId}
        activeWorkspaceIdentity={workspaceIdentity}
        activeWorkspacePath={workspaceAbsPath}
        // 初始导航意图（打开侧栏/任务）只在远控壳首次挂载时消费；它来自宿主
        // 深链，不能持久化，否则用户手动返回 Home 后会被再次弹到任务页。
        initialNavigationIntent={initialWebRemoteControlMobileNavigationIntent}
        // 终端传输态（连接中/断开）必须透传给手机壳：手机上终端是全屏页，
        // 不显示重连提示会让用户以为命令没执行，实际是 WebSocket 掉了。
        webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
        // 手机壳的侧栏是“全屏浮层”，开合由同一个 isSidePaneOpen 驱动；
        // 但它与桌面分栏互不影响，关闭浮层不会改写用户的桌面宽度偏好。
        isSidePaneOpen={isSidePaneOpen}
        // 关闭浮层只在“确实打开”时给回调：传 undefined 让壳隐藏关闭手势，
        // 避免用户在未打开状态下滑动触发一次空 toggle（会记录一次无意义操作）。
        onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
        // 传函数本身而不是调用结果：壳在需要时才渲染 Home，且把 mobile 动作
        // 注入进去。提前调用会丢失 navigateToChat/setSwitching 参数。
        renderTaskHome={renderWorkspaceSidebar}
        switcher={webRemoteControlWorkspaceSwitcher}
        renderChatHeader={() =>
          shouldRenderWorkspaceHeader ? (
            <ScopedErrorBoundary
              scope="workspace-header"
              resetKeys={workspaceOnlyResetKeys}
              variant="compact"
              className="border-b"
            >
              <WorkspaceHeader
                // draft/task 两套布局共用 header：无任务时展示项目与新建入口，
                // 有任务时展示标题/Git/日志。用 activeTaskId 而非派生 sessionId，
                // 避免“刚建会话但 meta 未刷新”时仍停在 draft。
                variant={activeTaskId === null ? "draft" : "task"}
                draftDropTargetController={
                  activeTaskId === null ? draftHeaderDropTargetController : undefined
                }
                readOnlyReason={workspaceReadOnlyReason}
                workspaceAbsPath={workspaceAbsPath}
                remoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                // 远控目标只从当前 workspace 的 tab 解析（INV-10）；
                // 传错会让本机项目显示“远端已连接”，点击后连到别的设备。
                remoteTarget={workspaceRemoteTarget}
                localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                projectName={projectName}
                activeTaskTitle={activeTaskTitle}
                activeTaskChangeSummary={activeTaskChangeSummary}
                hasUpdateReady={hasUpdateStatusButton}
                activeTaskId={activeTaskId}
                user={user}
                activeTraceId={activeTraceId}
                activeSessionId={activeSessionId}
                activeTaskProvider={activeTaskProvider}
                resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                sessionLogPath={taskSessionFile.path}
                nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                // provider/path/exists/loading 必须成组传：只传 path 不传 provider，
                // header 会用错误的解析器打开日志，表现为“文件存在但内容空白”。
                nativeSessionLogPath={taskNativeSessionLogFile.path}
                nativeSessionLogExists={taskNativeSessionLogFile.exists}
                nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                providerWorkspaceConfigPath={providerConfigFile.path}
                providerWorkspaceConfigExists={providerConfigFile.exists}
                providerWorkspaceConfigLoading={providerConfigFile.loading}
                workspaceHeaderState={workspaceShellZCodeState}
                gitSummary={gitState.summary}
                gitDirtyFileCount={gitDirtyFileCount}
                isMacDesktop={isMacDesktop}
                isMacFullscreen={isMacFullscreen}
                isWindowsDesktop={isWindowsDesktop}
                isWebRemoteControl={isWebRemoteControlShell}
                windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
                isDesktop={isDesktop}
                simplifyForNarrowRemote
                isSidebarVisible={isSidebarVisible}
                isTerminalOpen={isTerminalOpen}
                isSidePaneOpen={isSidePaneOpen}
                onRefreshGit={handleRefreshGit}
                // 终端与浏览器是两个独立开关；它们的开合互不影响
                // （只有浮层全屏时才隐藏终端，见 INV-09）。
                onToggleTerminal={handleToggleTerminal}
                onToggleBrowser={handleToggleBrowser}
                onToggleSidePane={handleToggleSidePane}
                toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                onReloadSession={handleReloadSession}
                // 禁用原因已在 workspaceSessionActionDisabled 合并
                // （只读/外部禁用/请求中），header 只消费布尔，不重复判断只读。
                reloadSessionDisabled={workspaceSessionActionDisabled}
                reloadSessionPending={reloadSessionPending}
                onCreateTask={handleCreateTaskInChat}
                onOpenWorkspace={onOpenWorkspace}
                allowOpenWorkspace={allowOpenWorkspace}
              />
            </ScopedErrorBoundary>
          ) : null
        }
        // 查找对话框只在 chat 主视图挂载：automations/plugin-store 没有会话文本，
        // 此时若仍渲染，Ctrl+F 会打开一个永远 0/0 的空查找框。
        chatOverlay={workspaceMainView === "chat" ? renderChatFindDialog() : undefined}
        // chatContent 是唯一的“页面内容”插槽：三种主视图共用同一个位置，
        // 这样切换视图时 ResizablePanel 与侧栏不会被卸载重建。
        chatContent={
          workspaceMainView === "automations" && !isWebRemoteControlShell ? (
            <main
              // 与桌面共用同一个 toast 锚点 id，Automations 内部据此定位浮层；
              // 若远控另起 id，toast 会永远挂不上去（表现为“操作成功但没有提示”）。
              id={AUTOMATIONS_TOAST_ANCHOR_ID}
              // 壳内独立页各自拥有滚动容器（overflow 在内部 breadcrumb frame 上），
              // 这里只负责撑满剩余高度；若在外层加 overflow-y-auto，sticky 面包屑会失效。
              className="flex h-full min-h-0 flex-1 flex-col bg-background"
            >
              <AutomationsMainBreadcrumbFrame
                // 面包屑的“返回/层级”在桌面显示路径段，在手机只显示返回箭头；
                // 因此必须显式传 isDesktop 而不是由 CSS 断点决定（SSR/首帧会闪）。
                isDesktop={Boolean(isDesktop)}
                sectionLabel={intl.formatMessage({
                  id: "settings.automations.title",
                })}
                ariaLabel={intl.formatMessage({
                  id: "automations.breadcrumbLabel",
                })}
              >
                <div
                  // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                  // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                  className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                >
                  <ScopedErrorBoundary
                    scope="automations-main"
                    resetKeys={workspaceOnlyResetKeys}
                    variant="panel"
                    className="min-h-full"
                  >
                    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                      <AutomationsSection
                        workspacePath={workspaceAbsPath}
                        workspaceIdentity={workspaceIdentity}
                        onCreateViaChat={handleCreateAutomationInChat}
                        onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                        onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                        onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                        openAutomationId={openAutomationId}
                        openAutomationTab={openAutomationTab}
                        onOpenAutomationConsumed={onOpenAutomationConsumed}
                        openWorkflow={openWorkflow}
                        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                        onOpenSession={({ sessionId, workspacePath, workspaceIdentity }) =>
                          handleSelectTaskInChat(workspacePath, sessionId, workspaceIdentity)
                        }
                      />
                    </div>
                  </ScopedErrorBoundary>
                </div>
              </AutomationsMainBreadcrumbFrame>
            </main>
          ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
            <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
              <AutomationsMainBreadcrumbFrame
                // 插件市场复用 automations 的面包屑外壳，保证两个壳内页的高度/滚动一致；
                // 换用普通 div 会导致来回切换时页面整体跳动几个像素。
                isDesktop={Boolean(isDesktop)}
                sectionLabel={intl.formatMessage({
                  id: "workspace.openPluginsSettings",
                })}
                ariaLabel={intl.formatMessage({
                  id: "settings.breadcrumbLabel",
                })}
              >
                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                  <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                    <PluginStorePage
                      isDesktop={isDesktop}
                      isMacDesktop={isMacDesktop}
                      isWindowsDesktop={isWindowsDesktop}
                      isWebRemoteControl={isWebRemoteControlShell}
                      // version 变化时强制重挂插件页：安装/卸载后返回列表需要
                      // 重置内部 tab 状态；key 比 refreshToken 更彻底。
                      key={`plugin-store:${pluginStoreOpenVersion}`}
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      // Bug 根因：独立插件页曾绕过切回聊天页的包装回调，任务虽被创建，
                      // 视图仍停在插件详情，用户看到“立即试用”与示例 Prompt 点击无反应。
                      onCreateTask={handleCreateTaskInChat}
                      // 绑定 activeTaskId 而非 meta 派生的 activeSessionId：
                      // 新建 v4 session 时 meta 可能未刷新，用派生值会停在 draft。
                      sessionId={activeTaskId}
                      remoteSessionId={workspaceRemoteSessionId}
                    />
                  </div>
                </div>
              </AutomationsMainBreadcrumbFrame>
            </main>
          ) : (
            <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
              {/* Bugfix: 手机远控聊天页中间层必须继续提供 flex 高度链。
                只有 h-full 的普通 block 会让 ChatView 的 flex-1 失效，草稿空态贴顶且内部滚动被外层裁掉。 */}
              <ScopedErrorBoundary
                // 草稿态的 resetKeys 单独一组：绑定 activeTaskId 后，从草稿切到会话
                // 会让 ErrorBoundary 重挂 chat 子树，从而清掉上一任务残留的错误态。
                scope="workspace-chat"
                resetKeys={workspaceDraftResetKeys}
                variant="panel"
                className="h-full"
              >
                {/* Bugfix(2026-07-05, M3 验收)：同桌面布局——绑定 activeTaskId 而非 meta 派生的
                  activeSessionId，避免新建 v4 session 因 meta 缓存未刷新而停在 draft。 */}
                {/* Bug 根因：计划详情功能只给桌面 V4WorkspaceChatArea 接了回调，手机卡片因此
                  显示按钮却无法打开抽屉；两端必须复用同一个 renderer Side Pane 入口。 */}
                <V4ChatPane
                  // Esc 停止只在“确实没有面板打开”时生效：侧栏/浏览器有焦点时，
                  // Esc 应先关闭它们，而不是中断正在输出的模型。
                  // isWorkspaceVisible 保证后台保活的 workspace 不会被误停止。
                  allowEscapeStopOutsidePane={
                    isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                  }
                  readOnly={Boolean(workspaceReadOnlyReason)}
                  workspacePath={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  isDesktop={isDesktop === true}
                  // 远控下隐藏本地专属能力并压缩间距；它只影响展示，
                  // 不改变工具权限（权限由 profile/只读态决定）。
                  compactForRemoteControl={isWebRemoteControlShell}
                  // 绑定 activeTaskId 而非 meta 派生的 activeSessionId：
                  // 新建 v4 session 时 meta 可能未刷新，用派生值会停在 draft。
                  sessionId={activeTaskId}
                  // provider 只来自 active task 的 meta；草稿态没有任务，必须显式传 undefined
                  // 让 pane 走默认解析，传空字符串会被当成合法 provider 名进而选错模型适配器。
                  provider={activeTaskProvider ?? undefined}
                  // 会话创建/删除后由 Shell 统一接管导航：pane 只上报事件，不自己改 tab store，
                  // 否则“新建后落在哪个 workspace”会出现两份判断（见 handleV4SessionCreated）。
                  onSessionCreated={handleV4SessionCreated}
                  onSessionDeleted={handleV4SessionDeleted}
                  // 草稿头是 useMemo 冻结的节点：这里只传引用，不在 render 里新建元素，
                  // 否则输入每个字符都会重建项目菜单与分支切换器。
                  draftComposerHeader={draftComposerHeader}
                  // git 相关 props 必须来自同一份 gitState 快照：混用两次查询结果会让
                  // “脏文件数”与“摘要”短暂不一致，用户看到数字跳动。
                  gitSummary={gitState.summary}
                  gitDirtyFileCount={gitDirtyFileCount}
                  gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                  gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                  activeTaskChangeSummary={activeTaskChangeSummary}
                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                  onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
                  onRefreshGit={handleRefreshGit}
                  onOpenGitReview={handleOpenGitReview}
                  onOpenBrowserUrl={handleOpenBrowserUrl}
                  onOpenAutomationsMain={handleOpenAutomations}
                  onOpenCodeViewer={handleOpenCodeViewer}
                  // 助手生成的 pptx 只在本机桌面自动打开：远控下没有本地 Office 进程，
                  // 传 undefined 让卡片保持“仅下载”语义，而不是弹一个打不开的窗口。
                  onAutoOpenAssistantPptx={
                    isDesktop && !isWebRemoteControlShell ? handleAutoOpenAssistantPptx : undefined
                  }
                  // INV-16：文件链接统一走 stat 分流（文件/目录/html），pane 不自行判断扩展名，
                  // 否则 markdown 里的目录链接会被当成文件打开并报 EISDIR。
                  onOpenFileLink={handleOpenMarkdownFileLink}
                  onOpenBackgroundBash={handleOpenBackgroundBash}
                  // 子代理会话与工作流产物都可能在“别的 workspace”里，回调由 Shell 注入
                  // InChat 语义；pane 只负责渲染列表，不持有跨项目导航能力。
                  onOpenSubagentSession={handleOpenSubagentSession}
                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                  onOpenPlanDetail={handleOpenPlanDetail}
                  onOpenWorkflowRun={handleOpenWorkflowRun}
                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                  // 查找状态提升到 Shell：Ctrl+F 由顶栏与快捷键共用同一份 query，
                  // 若 pane 内部自持状态，顶栏搜索框与页面高亮会出现两套计数。
                  conversationFindQuery={conversationFindQuery}
                  conversationFindActiveIndex={conversationFindActiveIndex}
                  // requestId 让“下一个/上一个”成为可去重的一次性命令：
                  // 重复点击同一个方向时 index 可能不变，靠 id 递增才能再次触发滚动。
                  conversationFindNavigationRequestId={conversationFindNavigationRequestId}
                  onConversationFindMatchStateChange={onConversationFindMatchStateChange}
                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                />
              </ScopedErrorBoundary>
            </div>
          )
        }
        sidePaneContent={renderSidePanePanel({ mobileOverlay: true })}
      >
        {wideContent}
      </WebRemoteControlMobileShell>
    ) : (
      wideContent
    );

  const wideContent = (
    // 完成卡上那两个壳级落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
    // run, and running it again」）：芯片开到中枢那一页、「再次运行」启动后切到新会话。只包桌面
    // 这一支——手机远控壳本来就不提供中枢，那边芯片是纯文字。
    <SavedWorkflowHubProvider
      openWorkflow={handleOpenSavedWorkflowInHub}
      navigateToRun={handleNavigateToLaunchedRun}
    >
      <div
        ref={workspaceShellRef}
        data-workspace-shell="true"
        style={workspaceShellSplitStyle}
        className={cn(
          "relative flex h-full min-h-0 w-full overflow-hidden [anchor-scope:--sidebar-task-list-divider]",
          // 修复原因：窗口原生 resize 时，外层 react-resizable-panels 会把每一帧
          // 都写进 layout store，连带侧栏 tooltip/menu 子树反复 commit。这里改成
          // CSS 变量驱动的专用 split，普通窗口 resize 只走浏览器布局，不触发 React 状态。
          isWebRemoteControlShell && "max-md:flex-col",
        )}
      >
        <div
          ref={workspaceSidebarPanelElementRef}
          data-panel=""
          data-workspace-sidebar-panel="true"
          id="sidebar"
          className={cn(
            "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
            // 修复原因：拖动侧栏宽度时如果继续过渡 width，会让指针移动和实际宽度之间产生滞后。
            // 拖拽 active 通过 DOM 标记切 transition，避免 pointerdown/up 为了切 class 重渲染整棵 workspace。
            isWebRemoteControlShell &&
              cn(
                // Bugfix: Web 远程控制在手机浏览器里仍复用桌面横向 shell，
                // 264px 侧栏 + 320px 内容区会直接超过视口宽度，导致页面只能横向滚动。
                // 这里只在远控模式的小屏断点把主布局改为上下堆叠，桌面端仍保持原来的分栏。
                // 交互修复：远控移动端改为拖动 WorkspaceHeader 下边框的按钮控制顶部高度，
                // 这里用 CSS 变量同步高度，避免拖动时卸载导航内容或打断任务列表状态。
                renderWebRemoteNavigationPanel
                  ? "max-md:!h-[var(--web-remote-navigation-height)] max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-b max-md:border-border max-md:bg-sidebar"
                  : "max-md:!h-0 max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-0 max-md:!border-b-0",
              ),
            isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {/* Bugfix: 折叠远控顶部导航时保持组件挂载，避免展开后整块 sidebar 重新加载。 */}
          <aside
            id={isWebRemoteControlShell ? "web-remote-control-navigation-panel" : undefined}
            ref={sidebarContainerRef}
            className={cn(
              "h-full overflow-hidden select-none",
              isWebRemoteControlShell && "max-md:min-h-0 max-md:flex-1",
              !renderWebRemoteNavigationPanel && "max-md:hidden",
            )}
            aria-hidden={!isSidebarPanelVisible || !renderWebRemoteNavigationPanel}
          >
            <ScopedErrorBoundary
              // 侧栏单独分区：它的崩溃不能连带卸载 chat，否则用户既看不到内容
              // 也失去了切换任务的自救入口（错误边界只隔离自己这一列）。
              scope="workspace-sidebar"
              resetKeys={workspaceOnlyResetKeys}
              variant="panel"
              className="h-full"
            >
              <V4SplitPaneEntryProvider
                // V4SplitPaneEntryProvider 只在本地桌面布局存在目标容器时启用。
                // 远控/手机是单列堆叠，启用后会给出可拖拽提示却永远 drop 不进去。
                enabled={!isWebRemoteControlShell && !isWebRemoteControlMobileViewport}
              >
                <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                  {renderWorkspaceSidebar()}
                </WorkflowRunOpenProvider>
              </V4SplitPaneEntryProvider>
            </ScopedErrorBoundary>
          </aside>
        </div>

        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          <div
            role="separator"
            tabIndex={0}
            aria-controls="sidebar"
            aria-label={workspaceSidebarResizeLabel}
            aria-orientation="vertical"
            aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
            aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
            data-testid="resizable-handle"
            onKeyDown={handleWorkspaceSidebarResizeKeyDown}
            onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
            onPointerDown={handleWorkspaceSidebarResizeStart}
            onPointerMove={handleWorkspaceSidebarResizeMove}
            onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
            className={cn(
              "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
              "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
              "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
              hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {isSidebarPanelVisible && renderWebRemoteNavigationPanel ? (
          // 原因：侧栏 overflow 裁掉横线末端；延伸装饰放在共同布局容器，不改变拖拽命中区。
          <span
            aria-hidden="true"
            data-sidebar-divider-extension="true"
            className={cn(
              "pointer-events-none absolute h-px w-1 bg-border/50 [left:anchor(--sidebar-task-list-divider_right,-4px)] [top:anchor(--sidebar-task-list-divider_top,-1px)]",
              isWebRemoteControlShell && "max-md:hidden",
            )}
          />
        ) : null}
        {/* 右侧主工作区：上方 header，下面左侧会话+终端，右侧共享 browser/code-viewer 槽位 */}
        <div
          data-panel=""
          id="content"
          className={cn(
            "flex min-w-[320px] flex-1 flex-col",
            hasDesktopPanelInset ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            isWebRemoteControlShell &&
              "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0",
          )}
        >
          {
            hasDesktopPanelInset && (
              <div className={cn("w-full [app-region:drag]", isWindowsDesktop ? "h-1.5" : "h-1")} />
            ) /* 修复 macOS 顶部窗口控制按钮被 header 遮挡无法点击的问题 */
          }
          <ResizablePanelGroup
            // layoutId 是持久化的键：改名会让用户已保存的分栏比例全部失效并回到默认值，
            // 且与旧版本写下的 localStorage 记录不再匹配（不会报错，只是静默丢失）。
            layoutId="workspace-body-layout"
            // panelIds 必须复用模块常量：数组字面量会让库把“面板集合变化”误判为结构重建，
            // 每次 render 都重新注册 panel（INV-18 的同源约束）。
            panelIds={WORKSPACE_BODY_PANEL_IDS}
            className={cn(
              "min-h-0 flex-1",
              isWebRemoteControlShell && "max-md:!flex-col",
              // 完整视图：面板外框以 Group 为定位容器铺满整行，对话内容由宿主 fixed 定位。
              // 修复原因：曾用 CSS 把对话列 flex 压成 0，react-resizable-panels 以各 panel offsetWidth
              // 之和作为 group 尺寸，面板从收起展开时两者皆为 0，resize 得到 NaN，面板一直停在收起态。
              // 这里不改库管理的 flex，已保存的面板占比也不写入。
              isFullView && "relative",
            )}
          >
            <ResizablePanel
              id="conversation-column"
              // 远控手机布局是上下堆叠，百分比 minSize 会把对话压成 0；用 0px 让 flex 接管。
              minSize={isWebRemoteControlShell ? "0px" : "35%"}
              // 只有侧栏面板可见时才给 52% 的初始值：面板关闭时应传 undefined，
              // 让库恢复用户上次拖拽保存的占比，而不是每次打开都重置。
              defaultSize={isSidePaneVisible ? "52%" : undefined}
              className={
                isWebRemoteControlShell
                  ? "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0"
                  : undefined
              }
            >
              <SidePaneFullViewConversationHost
                // mode 决定对话列是“内联 / full / floating”三态；floating 下宿主用 fixed
                // 定位，外层分栏比例不再参与布局（这也是自动收起要跳过 full view 的原因）。
                mode={fullViewMode}
                floating={activeFullView?.floating ?? "collapsed"}
                // floatingAnchor 持久化到偏好：刷新后浮窗回到上次拖到的角落，
                // floatingAnchor 不再每次重新居中遮挡内容。
                anchor={floatingAnchor}
                slotElement={fullViewSlotElement}
                onFloatingChange={handleFullViewFloatingChange}
                onAnchorChange={handleFloatingAnchorChange}
                // 点击浮窗标题展开为完整视图；只切 surface，不销毁对话 DOM，
                // 因此输入框内容与滚动位置在展开/收起之间保持不变。
                onOpenConversation={handleOpenFullViewConversation}
              >
                <ResizablePanelGroup
                  orientation="vertical"
                  layoutId="workspace-conversation-column-layout"
                  panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                  className="h-full min-h-0"
                >
                  <ResizablePanel
                    id="conversation"
                    // 这个 ref 是自动收起策略的测量对象：它指向真实 DOM 而不是 panel 句柄，
                    // 因为收起动画期间句柄尺寸可能滞后，量到的宽度不可信（INV-07）。
                    elementRef={conversationPanelElementRef}
                    minSize="35%"
                  >
                    <section
                      data-workspace-conversation-frame="true"
                      className={cn(
                        // overflow-hidden 与 bg-background 一起使用：圆角面板内部一旦出现
                        // 横向滚动容器，滚动条会画到圆角之外，视觉上像“缺了一角”。
                        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                        // 仅当侧栏面板可见时才画独立的圆角边框；否则沿用窗口原生外观，
                        // 两者同时生效会出现双边框（原生 chrome 已经画了一圈）。
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : resolveWorkspaceShellWindowChromeClass({
                              isMacDesktop,
                              isWindowsDesktop,
                              isLinuxDesktop,
                              macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                              isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                              supportsNativeRoundedCorners:
                                desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                            }),
                        // isTerminalVisible 时对话列退化为“上半部分”，需要下圆角与下边框衔接终端；
                        // 终端关闭时保留直角，避免底部出现一条悬空的分隔线。
                        isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                        // 手机堆叠布局铺满整宽，圆角与左右边框会露出背景缝，必须去掉。
                        isWebRemoteControlShell &&
                          "max-md:rounded-none max-md:border-x-0 max-md:border-b-0",
                        // 完整视图由面板外框或浮窗外框承担边框与圆角，对话 frame 不再叠一层。
                        isFullView && "rounded-none border-0",
                      )}
                    >
                      {shouldRenderWorkspaceHeader && !isFullView ? (
                        <ScopedErrorBoundary
                          scope="workspace-header"
                          resetKeys={workspaceOnlyResetKeys}
                          variant="compact"
                          className="border-b"
                        >
                          <WorkspaceHeader
                            // 只有侧栏面板收起时 header 才贴到窗口左上角，需要为 mac 红绿灯
                            // 预留内边距；面板可见时左侧是分栏，预留反而会让标题偏移。
                            reserveWindowControls={!isSidePaneVisible}
                            // draft/task 两套布局共用 header：无任务时展示项目与新建入口，
                            // 有任务时展示标题/Git/日志。用 activeTaskId 而非派生 sessionId，
                            // 避免“刚建会话但 meta 未刷新”时仍停在 draft。
                            variant={activeTaskId === null ? "draft" : "task"}
                            draftDropTargetController={
                              activeTaskId === null ? draftHeaderDropTargetController : undefined
                            }
                            readOnlyReason={workspaceReadOnlyReason}
                            workspaceAbsPath={workspaceAbsPath}
                            remoteSessionId={workspaceRemoteSessionId}
                            workspaceIdentity={workspaceIdentity}
                            // 远控目标只从当前 workspace 的 tab 解析（INV-10）；
                            // 传错会让本机项目显示“远端已连接”，点击后连到别的设备。
                            remoteTarget={workspaceRemoteTarget}
                            localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                            projectName={projectName}
                            activeTaskTitle={activeTaskTitle}
                            activeTaskChangeSummary={activeTaskChangeSummary}
                            hasUpdateReady={hasUpdateStatusButton}
                            activeTaskId={activeTaskId}
                            user={user}
                            activeTraceId={activeTraceId}
                            activeSessionId={activeSessionId}
                            activeTaskProvider={activeTaskProvider}
                            resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                            sessionLogPath={taskSessionFile.path}
                            nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                            // provider/path/exists/loading 必须成组传：只传 path 不传 provider，
                            // header 会用错误的解析器打开日志，表现为“文件存在但内容空白”。
                            nativeSessionLogPath={taskNativeSessionLogFile.path}
                            nativeSessionLogExists={taskNativeSessionLogFile.exists}
                            nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                            providerWorkspaceConfigPath={providerConfigFile.path}
                            providerWorkspaceConfigExists={providerConfigFile.exists}
                            providerWorkspaceConfigLoading={providerConfigFile.loading}
                            workspaceHeaderState={workspaceShellZCodeState}
                            gitSummary={gitState.summary}
                            gitDirtyFileCount={gitDirtyFileCount}
                            isMacDesktop={isMacDesktop}
                            isMacFullscreen={isMacFullscreen}
                            isWindowsDesktop={isWindowsDesktop}
                            isWebRemoteControl={isWebRemoteControlShell}
                            windowsWindowControlsRightPaddingPx={
                              windowsWindowControlsRightPaddingPx
                            }
                            isDesktop={isDesktop}
                            simplifyForNarrowRemote={simplifyHeaderForNarrowRemote}
                            isSidebarVisible={isSidebarVisible}
                            isTerminalOpen={isTerminalOpen}
                            isSidePaneOpen={isSidePaneOpen}
                            onRefreshGit={handleRefreshGit}
                            // 终端与浏览器是两个独立开关；它们的开合互不影响
                            // （只有浮层全屏时才隐藏终端，见 INV-09）。
                            onToggleTerminal={handleToggleTerminal}
                            onToggleBrowser={handleToggleBrowser}
                            onToggleSidePane={handleToggleSidePane}
                            toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                            onReloadSession={handleReloadSession}
                            // 禁用原因已在 workspaceSessionActionDisabled 合并
                            // （只读/外部禁用/请求中），header 只消费布尔，不重复判断只读。
                            reloadSessionDisabled={workspaceSessionActionDisabled}
                            reloadSessionPending={reloadSessionPending}
                            onCreateTask={handleCreateTaskInChat}
                            onOpenWorkspace={onOpenWorkspace}
                            allowOpenWorkspace={allowOpenWorkspace}
                          />
                        </ScopedErrorBoundary>
                      ) : null}
                      {isWebRemoteControlShell ? (
                        <Button
                          // 一个手柄同时承担“点击展开/折叠”和“上下拖拽调高”两种意图：
                          // 拆成两个按钮会让 aria-controls 与真实拖拽目标分叉，键盘用户也会多一次 Tab。
                          type="button"
                          variant="outline"
                          size="icon-md"
                          data-web-remote-navigation-resize-handle="true"
                          // 该标记供远控壳识别“可拖拽手柄”并豁免点击穿透；
                          // 改名会让外层手势层把手柄上的 pointerdown 当成页面滚动吞掉。
                          className={cn(
                            // max-md:inline-flex 只在手机断点出现：桌面远控已有常驻导航，
                            // 再画一个手柄会与 header 拖拽区重叠，命中测试互相抢 event。
                            "absolute left-1/2 z-30 hidden -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize border-border bg-surface text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground max-md:inline-flex [app-region:no-drag]",
                            // top-12 是为 header 让出的高度；没有 header 时必须回到 0，
                            // 否则手柄悬空在内容上方，视觉位置与可点区域错位。
                            shouldRenderWorkspaceHeader ? "top-12" : "top-0",
                            // 拖拽高亮只由这个布尔驱动：拖拽期间禁止 setState，
                            // 否则每帧都会重渲染整棵远控导航树（见 INV-02 的同源约束）。
                            isWebRemoteControlNavigationDragging &&
                              "border-border-hover bg-surface-hover text-foreground",
                          )}
                          // aria-expanded 反映“导航是否展开”而不是“面板是否存在”：
                          // 折叠时面板仍挂载（保留任务列表状态），只是高度归零。
                          aria-expanded={!isWebRemoteControlNavigationCollapsed}
                          aria-controls="web-remote-control-navigation-panel"
                          aria-label={intl.formatMessage({
                            id: isWebRemoteControlNavigationCollapsed
                              ? "webRemoteControl.expandNavigation"
                              : "webRemoteControl.collapseNavigation",
                          })}
                          // 三个 pointer 回调共享同一个 dragRef 会话，靠 pointerId 区分归属（INV-03）；
                          // 多指同时按下时，第二个指针的 move 必须被忽略，不能累加到本次高度。
                          onPointerDown={handleWebRemoteNavigationResizeStart}
                          onPointerMove={handleWebRemoteNavigationResizeMove}
                          onPointerUp={(event) => {
                            finishWebRemoteNavigationResize(event);
                          }}
                          onPointerCancel={(event) => {
                            // cancel 传 aborted=true：必须回滚到会话起始高度，
                            // 把“被系统手势打断”误当作正常提交会留下半截高度且已持久化。
                            finishWebRemoteNavigationResize(event, true);
                          }}
                          onClick={handleWebRemoteNavigationHandleClick}
                        >
                          <GripHorizontal className="size-4" />
                        </Button>
                      ) : null}
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {workspaceMainView === "automations" && !isWebRemoteControlShell ? (
                          <main
                            // AUTOMATIONS_TOAST_ANCHOR_ID 是 toast 的挂载锚点：Automations 是壳内页，
                            // toast 若挂到全局 body 会被 ResizablePanel 的 overflow 裁掉。
                            id={AUTOMATIONS_TOAST_ANCHOR_ID}
                            className="flex h-full min-h-0 flex-1 flex-col bg-background"
                          >
                            <AutomationsMainBreadcrumbFrame
                              isDesktop={Boolean(isDesktop)}
                              sectionLabel={intl.formatMessage({
                                id: "settings.automations.title",
                              })}
                              ariaLabel={intl.formatMessage({
                                id: "automations.breadcrumbLabel",
                              })}
                            >
                              <div
                                // 修复原因：不同 Automations tab 的内容高度不同，滚动条出现/消失会改变
                                // mx-auto 内容列的可用宽度，造成整页左右弹动；预留稳定槽位保持居中基准不变。
                                className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                              >
                                <ScopedErrorBoundary
                                  scope="automations-main"
                                  resetKeys={workspaceOnlyResetKeys}
                                  variant="panel"
                                  className="min-h-full"
                                >
                                  <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                                    <AutomationsSection
                                      workspacePath={workspaceAbsPath}
                                      workspaceIdentity={workspaceIdentity}
                                      // 必须走 handleCreateAutomationInChat 而不是 onCreateTask：
                                      // 前者包含“先切回 chat 主视图”的顺序（INV-12），直接调会在
                                      // automations 页里挂载新会话，表现为点击无反应。
                                      onCreateViaChat={handleCreateAutomationInChat}
                                      onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                      onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                      onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                      openAutomationId={openAutomationId}
                                      openAutomationTab={openAutomationTab}
                                      onOpenAutomationConsumed={onOpenAutomationConsumed}
                                      openWorkflow={openWorkflow}
                                      onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                                      // INV-20：运行历史里的“打开会话”可能指向别的 workspace，
                                      // 必须走 InChat 版本完成 tab 激活与远端身份解析；用本地
                                      // handleSelectTask 会在远端项目上打开一个空会话。
                                      onOpenSession={({
                                        sessionId,
                                        workspacePath,
                                        workspaceIdentity,
                                      }) =>
                                        handleSelectTaskInChat(
                                          workspacePath,
                                          sessionId,
                                          workspaceIdentity,
                                        )
                                      }
                                    />
                                  </div>
                                </ScopedErrorBoundary>
                              </div>
                            </AutomationsMainBreadcrumbFrame>
                          </main>
                        ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
                          // 独立页需要自己的 flex 高度链：主区域是 ResizablePanel 的子项，
                          // 不撑满会让插件市场的空态提示贴在半高处。
                          <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                            <AutomationsMainBreadcrumbFrame
                              isDesktop={Boolean(isDesktop)}
                              sectionLabel={intl.formatMessage({
                                id: "workspace.openPluginsSettings",
                              })}
                              ariaLabel={intl.formatMessage({
                                id: "settings.breadcrumbLabel",
                              })}
                            >
                              <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                                <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                  <PluginStorePage
                                    isDesktop={isDesktop}
                                    isMacDesktop={isMacDesktop}
                                    isWindowsDesktop={isWindowsDesktop}
                                    isWebRemoteControl={isWebRemoteControlShell}
                                    // version 变化时强制重挂插件页：安装/卸载后返回列表需要
                                    // 重置内部 tab 状态；key 比 refreshToken 更彻底。
                                    key={`plugin-store:${pluginStoreOpenVersion}`}
                                    workspacePath={workspaceAbsPath}
                                    workspaceIdentity={workspaceIdentity}
                                    onCreateTask={handleCreateTaskInChat}
                                    // 绑定 activeTaskId 而非 meta 派生的 activeSessionId：
                                    // 新建 v4 session 时 meta 可能未刷新，用派生值会停在 draft。
                                    sessionId={activeTaskId}
                                    remoteSessionId={workspaceRemoteSessionId}
                                  />
                                </div>
                              </div>
                            </AutomationsMainBreadcrumbFrame>
                          </main>
                        ) : (
                          <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                            {renderChatFindDialog()}
                            <ScopedErrorBoundary
                              scope="workspace-chat"
                              resetKeys={workspaceDraftResetKeys}
                              variant="panel"
                              className="h-full"
                            >
                              {/* Bugfix(2026-07-05, M3 验收)：pane 绑定必须用原始选择态 activeTaskId，
                                  不能用 meta 派生的 activeSessionId——v4 createSession 刚建的会话
                                  不在 taskListCache/optimistic 缓存里，meta 解析为 null 会让 pane
                                  永远停在 draft。v4 语义下 sessionId ≡ taskId，meta 只服务 Header 显示。
                                  M5⑤：桌面主区升级为分屏宿主（Layout/Focus 两层）；primary pane
                                  绑定语义与 testid 契约（paneId=workspace-main）不变。 */}
                              <V4WorkspaceChatArea
                                allowEscapeStopOutsidePane={
                                  isWorkspaceVisible && !isSidePaneOpen && !isSidePaneVisible
                                }
                                readOnly={Boolean(workspaceReadOnlyReason)}
                                // foregroundEnabled 与 isWorkspaceVisible 分离：后台保活的 tab
                                // 仍要保留 DOM 与滚动位置，只是不接收前台快捷键与自动滚动。
                                foregroundEnabled={isWorkspaceVisible}
                                workspacePath={workspaceAbsPath}
                                workspaceIdentity={workspaceIdentity}
                                isDesktop={isDesktop === true}
                                // 远端会话坐标必须显式传：分屏里同一路径可能同时存在本地与远端
                                // 两个会话，只靠 path 无法定位到正确的文件系统（INV-10）。
                                remoteSessionId={workspaceRemoteSessionId}
                                // 远控下隐藏本地专属能力并压缩间距；它只影响展示，
                                // 不改变工具权限（权限由 profile/只读态决定）。
                                compactForRemoteControl={isWebRemoteControlShell}
                                // 绑定 activeTaskId 而非 meta 派生的 activeSessionId：
                                // 新建 v4 session 时 meta 可能未刷新，用派生值会停在 draft。
                                sessionId={activeTaskId}
                                // 辅助对话 id 在 Shell 侧按 workspaceKey + parentSessionId 解析，
                                // pane 不自行查表：同名 sessionId 在两个 workspace 下会串台。
                                activeSelectionSideChatSessionId={activeSelectionSideChatSessionId}
                                provider={activeTaskProvider ?? undefined}
                                onSessionCreated={handleV4SessionCreated}
                                onSessionDeleted={handleV4SessionDeleted}
                                draftComposerHeader={draftComposerHeader}
                                // 拖拽控制器注册只发生在草稿态；提交草稿后由 pane 置空，
                                // 否则已提交会话仍会接受一次“把文件拖到 header”的投递。
                                onPrimaryDraftDropTargetControllerChange={
                                  setDraftHeaderDropTargetController
                                }
                                // git 四件套同源：摘要/脏文件数/变更来源必须同一次查询，
                                // 分开取会让“工作区/暂存区”计数与徽标短暂不一致。
                                gitSummary={gitState.summary}
                                gitDirtyFileCount={gitDirtyFileCount}
                                activeTaskChangeSummary={activeTaskChangeSummary}
                                gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                                gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                                summaryPanelVariantOverride={summaryPanelVariantOverride}
                                onSummaryPanelVariantOverrideChange={
                                  onSummaryPanelVariantOverrideChange
                                }
                                onRefreshGit={handleRefreshGit}
                                onOpenGitReview={handleOpenGitReview}
                                // 只有 primary pane 会回报“当前活动会话”；分屏里的次级 pane
                                // 切换不能改写全局 activeTaskId，否则侧栏选中态会跟着乱跳。
                                onPaneActiveSessionChange={handlePaneActiveSessionChange}
                                onOpenBrowserUrl={handleOpenBrowserUrl}
                                onOpenAutomationsMain={handleOpenAutomations}
                                onOpenCodeViewer={handleOpenCodeViewer}
                                onAutoOpenAssistantPptx={
                                  isDesktop && !isWebRemoteControlShell
                                    ? handleAutoOpenAssistantPptx
                                    : undefined
                                }
                                onOpenBackgroundBash={handleOpenBackgroundBash}
                                onOpenSubagentSession={handleOpenSubagentSession}
                                onOpenSubagentDirectory={handleOpenSubagentDirectory}
                                onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                                // 选区辅助对话的开启命令只发给主 pane（见 requestSelectionSideChatOpen），
                                // 分屏次级 pane 不监听，避免一次点击创建多个 tab。
                                onOpenSelectionSideChat={handleOpenSelectionSideChat}
                                onOpenPlanDetail={handleOpenPlanDetail}
                                onOpenWorkflowRun={handleOpenWorkflowRun}
                                onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                                onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                                onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                onOpenFileLink={handleOpenMarkdownFileLink}
                                conversationFindQuery={conversationFindQuery}
                                conversationFindActiveIndex={conversationFindActiveIndex}
                                conversationFindNavigationRequestId={
                                  conversationFindNavigationRequestId
                                }
                                onConversationFindMatchStateChange={
                                  onConversationFindMatchStateChange
                                }
                                searchResultHighlightRequest={activeSearchResultHighlightRequest}
                                onSearchResultHighlightDone={onSearchResultHighlightDone}
                              />
                            </ScopedErrorBoundary>
                          </main>
                        )}
                      </div>
                    </section>
                  </ResizablePanel>
                  {isWebRemoteControlShell ||
                  (workspaceMainView !== "automations" && workspaceMainView !== "plugin-store") ? (
                    <AnimatedTerminalPanel
                      // isSidePaneVisible 时终端与浏览器并排，需要独立的圆角边框；
                      // 否则沿用窗口原生外观，避免分栏处出现双层描边。
                      frameClassName={cn(
                        isSidePaneVisible
                          ? "rounded-[var(--workspace-panel-radius)] border border-border"
                          : resolveWorkspaceShellWindowChromeClass({
                              isMacDesktop,
                              isWindowsDesktop,
                              isLinuxDesktop,
                              macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                              isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                              supportsNativeRoundedCorners:
                                desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                            }),
                        // 上圆角 + 上边框始终保留：终端是从底部拉起的“抽屉”，
                        // 去掉后与上方内容之间会出现一条没有分隔的缝隙。
                        "rounded-t-[var(--workspace-panel-radius)] border-t",
                      )}
                      services={services}
                      workspaceAbsPath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      // 只保留“当前仍打开的 workspace”的 PTY：切 tab 不清、真关 tab 才回收（INV-14）。
                      // 若传全量 tabs，关闭的 workspace 会永远保活并泄漏子进程。
                      openWorkspaceKeys={openWorkspaceKeys}
                      // isVisible 由 open 与“是否浮窗全屏”共同决定：浮窗下终端 DOM 保留，
                      // 只是不可见，退出浮窗后按原状态恢复（INV-09）。
                      isVisible={isTerminalVisible}
                      isWindowsDesktop={isWindowsDesktop}
                      // 两个 ref 分工不同：panelRef 用于命令式调整分栏尺寸，
                      // panelElementRef 指向真实 DOM，供 xterm fit 与滚动复位使用。
                      panelRef={terminalPanelRef}
                      panelElementRef={terminalPanelElementRef}
                      // 只关闭可见状态，不销毁 PTY：进程生命周期归 sidePaneTerminalSessionRegistry，
                      // 这里顺手 kill 会让“关掉再打开”丢失正在跑的命令输出。
                      onClose={() => setIsTerminalOpen(false)}
                      onOpenBrowserUrl={handleOpenBrowserUrl}
                    />
                  ) : null}
                </ResizablePanelGroup>
              </SidePaneFullViewConversationHost>
            </ResizablePanel>
            {/* Bugfix：Browser Guest Host 必须与主视图路由解耦，避免 automations/plugin
                    切换时卸载 Guest；截图请求期间由上层临时展开真实面板承载可合成的 WebContents。 */}
            {sidePanePanel}
          </ResizablePanelGroup>
        </div>
        <ScopedErrorBoundary
          scope="desktop-top-overlay"
          resetKeys={workspaceSidebarVisibilityResetKeys}
          variant="silent"
        >
          <DesktopTopOverlay
            // 只传“禁用原因”，是否展示按钮由 overlay 内部分平台决定；
            // 若在这里先判断一次平台，Windows/Linux 的差异会散落两处。
            newTaskDisabledReason={workspaceReadOnlyReason}
            workspaceAbsPath={workspaceAbsPath}
            isMacDesktop={isMacDesktop}
            isMacFullscreen={isMacFullscreen}
            macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            isWindowsDesktop={isWindowsDesktop}
            isDesktop={isDesktop}
            isSidebarVisible={isSidebarVisible}
            updateReadyVersion={updateReadyVersion}
            updateState={updateState}
            toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
            newTaskShortcutLabel={newTaskShortcutLabel}
            goBackShortcutLabel={goBackShortcutLabel}
            goForwardShortcutLabel={goForwardShortcutLabel}
            // 任务历史的前进/后退与“浏览器历史”不同源，不能合并判断：
            // 前者跨会话，后者在同一 webview 内；混用会让返回按钮时有时无。
            canTaskNavBack={canPrimaryNavigationBack}
            canTaskNavForward={canTaskNavForward}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            // 侧栏收起时顶栏补一个新建入口，避免用户必须先展开侧栏才能建任务；
            // 侧栏可见时必须隐藏，否则会出现两个语义相同但位置不同的按钮。
            showNewTaskButton={showTopOverlayNewTaskButton}
            appLogoUrl={appLogoUrl}
            platform={platform}
            onToggleSidebar={handleToggleSidebar}
            onCreateTask={handleCreateTaskInChat}
            // 走 primaryNavigationBack：插件市场里“返回”应回聊天，而不是退回上一个任务。
            onGoBack={primaryNavigationBack}
            onGoForward={handleTaskNavForward}
            // 窄屏远控里顶栏空间只够品牌与一个开关，任务导航让位给 header。
            hideTaskNavigationButtons={simplifyHeaderForNarrowRemote}
          />
        </ScopedErrorBoundary>

        {isWebRemoteControlShell && isWebRemoteControlTaskSwitching ? (
          <div
            // 覆盖层固定 absolute inset-0 + z-40：必须盖住 ResizablePanel 的手柄（z-10）
            // 与侧栏，否则切换瞬间用户仍能点到即将卸载的旧会话。
            className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
            // aria-live=polite 让读屏在切换完成前不打断当前朗读；
            // aria-busy 告诉辅助技术这块区域正在更新，避免重复报“空白页面”。
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
              <LoaderIcon className="size-4 animate-spin" />
              {/* Bugfix: 跨 workspace 点击任务时旧页会很快卸载，之前在卸载前缺少统一占位，视觉上像“先白屏再渲染”。
                  这里补一个全局 loading overlay，给切换过程稳定反馈。 */}
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          </div>
        ) : null}
      </div>
    </SavedWorkflowHubProvider>
  );
  // 远控壳复用同一份 wideContent 节点，而不是各自渲染一遍：
  // 两套 JSX 各自持有 ChatView 会在断点切换时丢草稿与滚动位置。
  return (
    <DesktopWindowFrame
      // 标题只取路径叶子：远端与本地可能有同名目录，带上完整路径会让窗口标题过长；
      // 真正的 workspace 身份区分由内容区的 identity props 负责。
      title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
      showHeader
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      headerTestId={TID_APP_HEADER}
    >
      {isWebRemoteControlShell ? renderRemoteShell(wideContent) : wideContent}
    </DesktopWindowFrame>
  );
});
