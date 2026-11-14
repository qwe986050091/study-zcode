/* eslint-disable max-lines -- Side pane 当前集中承载 tabs、browser/git/code-viewer 内容；完整拆分需按 pane 功能边界继续推进。 */
//
// ============================================================
// 深度注释块 A：侧栏面板的动画状态机与不变量
// ============================================================
//
// 这个组件同时扮演四个角色：tab 容器、拖拽排序宿主、browser/terminal 的挂载点、
// 以及"收起时不卸载内容"的保活层。四者共享同一份 isVisible，因此任何一处
// 把它当成"该不该渲染"都会同时破坏另外三处。
//
// [状态机] 可见性只有两态，动画只是过渡，不构成第三态：
//   closed   --isVisible=true-->  opening --约 200ms--> open
//   open     --isVisible=false--> closing --仅 opacity 过渡--> closed
// dragging 是 open 内部的临时态，只影响 tab 排序，不改变面板可见性。
// 关键约束：opening/closing 期间内容必须保持挂载，否则过渡会中断成白屏。
// 读代码的顺序：先看 hasRenderedSidePane 与锁宽两个 effect（状态机），
// 再看 overflow 与 scroll 两个 effect（布局），最后看 JSX 的三层包裹（挂载与样式）。
//
// INV-1: hasRenderedSidePane 一旦置 true 不再回退 —— 破坏后果：收起瞬间卸载 Tabs 与 browser guest，动画中途白屏且内部草稿丢失。
// INV-2: 锁宽只在过渡窗口内生效，200ms 后必须解除 —— 破坏后果：窗口缩放后内容仍按旧像素排版，右侧留白或横向溢出。
// INV-3: lockedContentWidthPx 只在"首次展开"与"开始收起"两个时刻写入 —— 破坏后果：每帧重写会把用户拖出来的宽度覆盖成常量。
// INV-4: 收起前记录的是 panel 的实际像素宽度，不是内容宽度 —— 破坏后果：用内容宽度锁定会让 tab 栏在淡出前重新排版，出现跳动。
// INV-5: draggingTabId 非空期间不提交重排、不切换激活 —— 破坏后果：拖拽跨越多个 tab 时激活事件连发，内容区域闪烁。
// INV-6: 重排只在 over 存在且 over 与 active 不同 id 时提交 —— 破坏后果：原地松手也触发重排，tab 顺序被无意义改写。
// INV-7: 快速开关时，上一轮的解锁定时器必须被 clear —— 破坏后果：旧定时器在新一轮展开中清空锁宽，动画出现一帧宽度回退。
// INV-8: 收起态必须同时 collapsible=false、disabled=true —— 破坏后果：用户可从未显示的右侧边缘把面板拖出来，绕过显式开关。
// INV-9: 隐藏用 opacity 加 pointer-events，不用 display:none —— 破坏后果：display:none 让 Chromium 丢弃 guest 合成层，展开时整页重建。
// INV-10: 截图期间强制 opacity-100 —— 破坏后果：opacity 为 0 时合成层被丢弃，截图结果为空白。
// INV-11: aria-hidden 跟随 isVisible，但 DOM 必须保留 —— 破坏后果：只隐藏不移除焦点，读屏与键盘会进入不可见区域。
// INV-12: 一切 tab 激活都必须经过 activateSidePaneTab —— 破坏后果：绕过它时完整视图不会切回 side-pane surface，点击看起来没反应。
// INV-13: mobileOverlay 分支不渲染 ResizablePanel —— 破坏后果：外层 auto 宽度把 100% 宽度链路解析为 0px，内容挂载却不可见。
// INV-14: mobileOverlay 时不写内联锁宽 —— 破坏后果：固定像素宽度撑破手机抽屉，横向溢出无法滚动。
// INV-15: 只有"首次展开且无历史宽度"才用 PanelGroup 比例估算 —— 破坏后果：覆盖用户上次的拖拽结果，宽度每次都被重置。
// INV-16: scroll mask 只提示仍可继续滚动的一侧 —— 破坏后果：两端常亮渐变会让用户以为还能滚，实际已到边界。
// INV-17: overflow 判定用稳定宽度预算，不读 content.scrollWidth —— 破坏后果：新增按钮进出内容会改变 viewport 宽度，形成 ResizeObserver 反馈环。
// INV-18: 每个 effect 的监听、RAF、定时器都必须在 cleanup 成对释放 —— 破坏后果：反复开关后监听器累积，一次滚动触发多次 setState。
// INV-19: tab 内容用 forceMount 加 inactive 隐藏保活 —— 破坏后果：切换 tab 会卸载终端与 browser，进程和连接被销毁。
// INV-20: 挂起壳的 suspend ack 必须在旧视图卸载之后发出 —— 破坏后果：提前 ack 会让 main 在视图仍 attached 时销毁 guest，打开 UAF 窗口。
// INV-21: 单次渲染里 tabs 只从 sidePaneState 读取，不复制到本地 state —— 破坏后果：本地副本与上层 store 分叉，关闭最后一个 tab 后仍显示旧标签。
// INV-22: fullView.surface 为 conversation 时内容激活 id 必须置空 —— 破坏后果：webview 与终端仍自认可见，继续抢占焦点与截图。
// INV-23: 顺序只在 drag end 提交，drag over 期间仅更新视觉 —— 破坏后果：每经过一个 tab 就写一次顺序，撤销栈被填满且中间态可见。
// INV-24: 面板宽度变化不得触发内容重挂载 —— 破坏后果：每次拖拽都重建 terminal 与 webview，输入法与滚动位置丢失。
//
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import type { BrowserViewScreenshotSurfacePreparePayload, GitChangeSourceId } from "@zcode/shared";
import { FileManagerPane } from "@/WorkspaceFileTree.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewConversationTab,
  SidePaneFullViewToggleButton,
  type SidePaneFullViewSurface,
} from "@/side-pane-full-view/index.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import { BrowserSitePermissionsPage } from "@/browser-use/BrowserSitePermissionsPage.js";
import { findScreenshotSurfaceTabForRender } from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { GitPane } from "@/GitPane.js";
import { TreemappingPane } from "@/TreemappingPane.js";
import { WhiteboardPane } from "@/WhiteboardPane.js";
import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

import {
  ResizableHandle,
  ResizablePanel,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { SidePaneTabOverview } from "@/app-shell/SidePaneTabOverview.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { BackgroundBashOutputSidePane } from "@/app-shell/BackgroundBashOutputSidePane.js";
import { PlanDetailSidePane } from "@/app-shell/PlanDetailSidePane.js";
import {
  PluginUiLauncherItems,
  PluginUiSidePane,
  SidePaneLauncherRow,
  useOpenPluginUi,
} from "@/plugin-ui/index.js";
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
import { WorkflowWorkspaceSidePane } from "@/app-shell/WorkflowWorkspaceSidePane.js";
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
import {
  getSidePaneTabTitle,
  SidePaneTabDragOverlay,
  SortableSidePaneTabTrigger,
} from "@/app-shell/SidePaneTabTrigger.js";
import {
  resolveSidePaneTabsOverflow,
  SIDE_PANE_DEFAULT_EXPANDED_RATIO,
} from "@/app-shell/sidePaneLayout.js";
import {
  resolveAnimatedSidePanePanelLayout,
  resolveOpenTabLauncherItemIds,
  shouldOfferSelectionSideConversation,
  shouldRenderPreviewPaneHeavyContent,
  type OpenTabLauncherItemId,
} from "@/app-shell/animatedSidePanePanelModel.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import { useDeveloperToolsVisibility } from "@/hooks/useDeveloperToolsVisibility.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { logger } from "@/logger.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  shouldMountSidePaneContent,
  shouldMountBrowserTabGuest,
  type BrowserSidePaneTab,
  type BrowserUseSidePaneTab,
  type BrowserSidePaneMetadata,
  type OpenScopedSubagentSideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { inferMediaPreview, type CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BugIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderOpenIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

const SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS = 200;
const PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS = 220;
type TabsScrollMaskEdges = {
  left: boolean;
  right: boolean;
};
type OpenTabLauncherItem = {
  id: OpenTabLauncherItemId;
  label: string;
  description: string;
  icon: LucideIcon;
  onOpen: () => void;
};
const EMPTY_SIDE_PANE_TABS: WorkspaceSidePaneState["tabs"] = [];
const EMPTY_TABS_SCROLL_MASK_EDGES: TabsScrollMaskEdges = {
  left: false,
  right: false,
};

function SuspendedBrowserSidePaneContent({
  tab,
}: {
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab;
}) {
  // [资源] tabId 与 generation 是 suspend 协议的两个匹配键：只对 tabId 会在
  // 同一 tab 重复换壳时 ack 到旧 generation，main 会把新 guest 误关。
  const platform = usePlatform();
  const tabId = tab.type === "browser-use" ? tab.tabId : tab.id;
  const generation = tab.residencyGeneration ?? 0;

  useEffect(() => {
    // [失败路径] 只有 suspended 才需要 ack：其他 residency 的 ack 会被 main
    // 当成"已卸载"处理，从而在 guest 仍存活时提前释放。
    if (tab.residency !== "suspended") return;
    // React effect 在旧 UnifiedBrowserView 提交 unmount 后运行；此时回 ack，main 才能安全
    // 关闭对应 guest WebContents，避免 suspend 被 render-process-gone 当成 crash 立即重建。
    // info 级打点：挂起换壳会先卸载 <webview>，若卸载瞬间
    // CDP 仍 attached 即打开主进程 UAF 窗口；这条日志把换壳时刻与 UnifiedBrowserView 的
    // 卸载打点对齐，用于归因 guest destroyed 的销毁者。
    logger.info("[browser-use] tab 换挂起壳，suspend ready ack", { generation, tabId });
    void platform.browserViewSuspendReady?.({ tabId, generation }).catch((error) => {
      logger.debug("[browser-use] suspend ready ack 失败", {
        error: error instanceof Error ? error.message : String(error),
        generation,
        tabId,
      });
    });
  }, [generation, platform, tab.residency, tabId]);

  return (
    <TabsContent
      value={tab.id}
      forceMount
      data-browser-tab-residency="suspended"
      className="relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden"
    />
  );
}

function readViewportInlineIntersectionSize(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  if (viewportWidth <= 0) {
    return null;
  }

  // [资源] 用 getBoundingClientRect 而不是 offsetWidth：面板参与 transform 过渡时
  // offsetWidth 仍是布局宽度，与屏幕上真实可见的宽度不一致。
  const rect = element.getBoundingClientRect();
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(viewportWidth, rect.right);
  // [权衡] 取与视口的交集而非元素宽度：面板被拖到屏幕外或抽屉只露出部分时，
  // 元素宽度会让内容误判"空间充足"而渲染重内容。
  return Math.max(0, Math.round(visibleRight - visibleLeft));
}

function useViewportInlineIntersectionSize<TElement extends HTMLElement>(
  elementRef: RefObject<TElement | null>,
  enabled: boolean,
) {
  // [资源] null 是"未知"而不是 0：调用方据此决定是否渲染重内容，
  // 若用 0 表示未知，首帧会把 preview 误判成被完全遮住。
  const [visibleInlineSizePx, setVisibleInlineSizePx] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setVisibleInlineSizePx(null);
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setVisibleInlineSizePx(null);
      return;
    }

    // [并发] 每帧只允许挂一个 RAF：resize 与 scroll 会同时触发，
    // 不去重时一次滚动可能排队多次测量，读布局的次数翻倍。
    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const next = readViewportInlineIntersectionSize(element);
      setVisibleInlineSizePx((current) => (current === next ? current : next));
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }

      frameId = window.requestAnimationFrame(update);
    };

    // [并发] 先同步测一次再注册监听：等下一次滚动会留下"宽度未知"的空窗，
    // 首帧就可能渲染错误的 preview 密度。
    // scroll 用 capture 是因为滚动发生在内层容器，不冒泡到 window。
    update();
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);

    return () => {
      // [资源] 三个来源必须全部解绑：监听、Observer、未执行的 RAF。
      // 缺 RAF 取消时，卸载后仍会 setState，触发 React 的卸载警告。
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, { capture: true });
      resizeObserver?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [elementRef, enabled]);

  // [权衡] 返回像素值而不是布尔：调用方需要区分"完全不可见"与"窄到只剩 icon"，
  // 布尔会丢掉这个区别，preview 只能一刀切。
  return visibleInlineSizePx;
}

function useWindowResizeSettling(enabled: boolean) {
  // [权衡] 用"settling"而不是"resizing"表达：resize 结束后还有一小段布局收敛期，
  // 立刻恢复重内容会在最后一帧再触发一次重排。
  const [isResizeSettling, setIsResizeSettling] = useState(false);
  const resizeSettleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setIsResizeSettling(false);
      return;
    }

    const finishSettling = () => {
      resizeSettleTimerRef.current = null;
      setIsResizeSettling(false);
    };

    // [并发] 连续 resize 事件必须重置同一个定时器，做成 trailing debounce；
    // 若每次都新起一个 setTimeout，最后一个才会生效，中间的定时器无人清理。
    const markSettling = () => {
      // 窗口 resize 期间，大文件 PreviewPane 的千行 Shadow DOM 会在每帧参与
      // React commit + Layout。这里只把 resize 视为短暂的不稳定阶段，等尺寸停止抖动后再恢复重内容。
      setIsResizeSettling((current) => (current ? current : true));
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
      }
      resizeSettleTimerRef.current = window.setTimeout(
        finishSettling,
        PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS,
      );
    };

    // [资源] visualViewport 与 window 的 resize 是两条独立事件源（软键盘、
    // 浏览器 UI 收起只触发前者），只监听 window 会漏掉手机上的视口变化。
    window.addEventListener("resize", markSettling, { passive: true });
    window.visualViewport?.addEventListener("resize", markSettling, {
      passive: true,
    });

    return () => {
      // [资源] 卸载时必须清掉 pending 定时器，否则 finishSettling 会在已卸载的
      // 组件上 setState；同时把 ref 归零，避免下次挂载复用失效的 id。
      window.removeEventListener("resize", markSettling);
      window.visualViewport?.removeEventListener("resize", markSettling);
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = null;
      }
    };
  }, [enabled]);

  return isResizeSettling;
}

export function AnimatedSidePanePanel({
  services,
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isVisible,
  sidePaneState,
  recentClosedSidePaneTabs,
  isBrowserOpen,
  supportsEmbeddedBrowser = true,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
  gitState,
  activeGitSourceId,
  panelRef,
  panelElementRef,
  browserNavigationRequest,
  browserRestoreUrls,
  screenshotSurfaceRequest: screenshotSurfaceRequestProp = null,
  screenshotSurfaceTabId = null,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onCloseGit,
  onActivateTab,
  onOpenNewTab,
  onReorderTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  onOpenBrowserTab,
  onOpenBrowserPermissionSettings,
  onOpenWhiteboard: _onOpenWhiteboard,
  onOpenDeveloperTools,
  onOpenFileManager,
  onNavigateFileManager,
  onOpenPluginMarket,
  onCreateTask,
  onOpenTerminalTab,
  onOpenReviewTab,
  onOpenSelectionSideConversation,
  onRevealGitFileInTree,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenBackgroundBash,
  onRefreshGit,
  onBrowserNavigationRequestHandled,
  onBrowserUrlChange,
  onBrowserPageMetadataChange,
  onSelectGitSource,
  frameClassName = "rounded-xl border border-border",
  captionControlsStyle,
  showWindowControls,
  onCloseSidePane,
  toggleSidePaneShortcutLabel,
  fullViewToggle,
  fullView = null,
  fullViewSlotRef,
  mobileOverlay = false,
  mobileStacked = false,
}: {
  // [资源] services 必须由宿主注入而不是组件内部 new：
  // 内部自建会得到第二个 accessor，与宿主的事件通道不是同一条。
  services: IServiceAccessor;
  frameClassName?: string;
  captionControlsStyle?: CSSProperties;
  showWindowControls?: boolean;
  onCloseSidePane?: () => void;
  toggleSidePaneShortcutLabel?: string;
  /** 桌面端「进入 / 退出完整视图」按钮；缺省不渲染（Web、手机远控）。 */
  fullViewToggle?: { active: boolean; onToggle: () => void; shortcutLabel?: string };
  /** 完整视图生效时的 tab 栏状态（spec：docs/ui/side-pane-full-view.md）。 */
  // [权衡] fullView 以对象整体传入而不是拆成若干布尔：它要么整体存在
  // （完整视图宿主），要么整体缺失；拆开后会出现"有 slotRef 却没有 surface"的中间态。
  // [并发] 它存在时会覆盖 mobileOverlay 的布局选择，因此样式分支先判它。
  fullView?: {
    surface: SidePaneFullViewSurface;
    conversationTitle: string;
    /** 侧栏收起时为左上角浮层按钮组留出的左侧留白（与 WorkspaceHeader 同一规则）。 */
    leadingInsetClassName?: string | false;
    onSelectSurface: (surface: SidePaneFullViewSurface) => void;
  } | null;
  /** 面板内容区（tab 栏下方），完整视图的对话宿主按它定位。 */
  fullViewSlotRef?: (element: HTMLDivElement | null) => void;
  // [权衡] 三个平台布尔分开传而不是传一个 platform 枚举：
  // 调用点已经在各自的 if 分支里，枚举会让每处都要再判一次。
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  // isVisible 是唯一可见性来源：不要在组件内部再维护一份
  // 本地 open state，两份状态在快速切换时会永久分叉。
  isVisible: boolean;
  // [失败路径] sidePaneState 允许为 null：首帧快照未到时不能直接解构，
  // 否则 `sidePaneState.tabs` 会在启动瞬间抛错，整个工作区白屏。
  sidePaneState: WorkspaceSidePaneState | null;
  // [资源] 最近关闭列表由宿主维护：放在组件内会随面板卸载一起丢失，
  // "重新打开关闭的标签"就跨不过一次面板收起。
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  // [资源] browser 是否打开与 tab 是否存在分开：browser tab 可以关闭但
  // 浏览器会话仍活着，isBrowserOpen 决定 webview 是否继续参与合成。
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser?: boolean;
  // 这里与 workspaceIdentity 配合生成 workspaceKey；
  // 组件不自己拼 identity，保证与持久化层使用同一套规则。
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  // [事务] gitState 由宿主持有并下沉：面板只负责渲染与转发操作。
  // 组件内再订阅一次会得到第二个刷新源，用户会看到"刚提交完又跳回旧状态"。
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  activeGitSourceId: GitChangeSourceId;
  // [资源] panelRef 由宿主持有：窗口缩放后需要由宿主按当前 workspaceKey
  // 恢复宽度，组件自己拿不到持久化层，只能把句柄交出去。
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  // [并发] 截图请求优先于 tab 选中态：它可以把某个未选中的 browser tab
  // 临时提到可见层参与合成，拍完再恢复（见下方 screenshotSurfaceTab 的匹配）。
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  screenshotSurfaceTabId?: string | null;
  // [事务] 查找导航请求用"序号"而不是只传索引：同一个索引连续跳转时，
  // 序号变化才能让 Git 面板知道这是一次新的定位而不是重复渲染。
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onCloseCodeViewer: () => void;
  onCloseGit: () => void;
  // [事务] 组件内部只通过 activateSidePaneTab 调它（INV-12）：
  // 直接调用会跳过 surface 切换，点击 tab 看起来没有反应。
  onActivateTab: (tabId: string) => void;
  onOpenNewTab: () => void;
  /** "插件"分组打开面板 tab；缺省不渲染分组（web / 无宿主）。 */
  // [并发] 重排只提交相邻 id，不提交完整数组：提交整个数组会把拖拽期间
  // 其他端新增的 tab 一起覆盖掉。
  onReorderTab: (activeTabId: string, overTabId: string) => void;
  // [失败路径] 关闭当前 tab 后由宿主决定下一个激活谁：组件若自己选，
  // 会与宿主的"按最近使用排序"规则不一致，关闭后焦点跳到意外位置。
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onReopenClosedTab: (tabId: string) => void;
  // [权衡] 打开浏览器 tab 不在组件内直接建 tab：tab 的唯一写入口在宿主，
  // 组件只表达"用户想打开"，否则两份 tabs 状态会各自增删。
  onOpenBrowserTab: () => void;
  onOpenBrowserPermissionSettings?: (origin: string) => void;
  onOpenWhiteboard: () => void;
  onOpenDeveloperTools: () => void;
  onOpenFileManager: (target?: FileManagerTarget) => void;
  onNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  // [失败路径] 可选回调缺席时入口必须隐藏：渲染出来却点不动，
  // 比完全不出现更让人困惑（Web 端没有插件市场宿主）。
  onOpenPluginMarket?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenTerminalTab: () => void;
  onOpenReviewTab: () => void;
  onOpenSelectionSideConversation: () => void;
  onRevealGitFileInTree?: (path: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  // [资源] 后台命令 tab 的打开请求带有命令元数据：组件只透传，
  // 不在这里解析命令，避免把 shell 语法知识带进 UI 层。
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** run 详情页里点 ask 节点 → 打开那个 actor 实例的 transcript tab。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** run 详情页里点脚本行 → 打开该 run 的脚本 transcript tab，落到那一站。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  /** run 详情页里点一张产物卡 → 打开那个产物的全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** run 目录页里点一行 → 打开那个 run 的详情页 tab（目录 → 详情是这一页存在的理由）。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  // [事务] 刷新由宿主触发而不是面板自己定时拉取：面板可能在多个工作区
  // 同时挂载，各自起 poller 会把 Git 状态打爆。
  onRefreshGit: () => void;
  onBrowserNavigationRequestHandled: (requestId: string) => void;
  onBrowserUrlChange: (tabId: string, url: string) => void;
  onBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  onSelectGitSource: (value: GitChangeSourceId) => void;
  // mobileOverlay 决定"用不用 ResizablePanel"，是布局与锁宽共同的分支依据；
  // 只让样式分支读它、锁宽分支不读，就会出现抽屉里写死像素宽度（INV-14）。
  mobileOverlay?: boolean;
  mobileStacked?: boolean;
}) {
  // [权衡] 这些 hook 必须在组件顶层无条件调用：早期返回会让 hooks 顺序
  // 在 mobileOverlay 切换时变化，React 直接抛错。
  const onOpenPluginUi = useOpenPluginUi();
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const developerToolsEnabled = useDeveloperToolsVisibility();
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  // [并发] 收起态同时禁用"拖拽折叠"与"resize target"：只关其中一个时，
  // 库仍会保留面板边缘的拖拽热区，用户能从不可见边缘把面板拉出来。
  // 破坏后果：面板被拖出但 isVisible 仍为 false，内容 pointer-events-none，
  // 表现为"拖出来一片空白且无法关闭"。
  const isDragCollapsible = !isVisible;
  // [事务] 禁用 resize 与收起同步：否则用户在收起动画期间拖右边缘，
  // 库会按新的指针位置重算比例，和正在进行的锁宽互相打架。
  const isResizeDisabled = !isVisible;
  // identity 优先、路径兜底，与持久化层使用同一构造规则；
  // 二者顺序若反过来，远程 workspace 重连后会读到本地路径下的旧草稿。
  // 破坏后果：这里与 store 的 key 计算不一致时，draftProjectId 永远取不到值。
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const composerClientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const draftScopeKey = composerScopeKey(
    resolveComposerScope(draftProjectId, workspaceIdentity, composerClientNamespace),
  );
  // [资源] 共享空数组常量而不是每次 `?? []`：新数组会让下游 useMemo 与
  // effect 的依赖每次变化，空 tabs 阶段会无限重渲染。
  const tabs = sidePaneState?.tabs ?? EMPTY_SIDE_PANE_TABS;
  // [并发] 截图请求是"一次性抬升"：命中 tab 后仍要求 isVisible 才真正参与合成，
  // 否则收起状态下截图会拍到一块已经不应存在的预览。
  const screenshotSurfaceRequest = screenshotSurfaceRequestProp;
  const isScreenshotSurfaceActive = Boolean(screenshotSurfaceRequest);
  // [失败路径] 按 tabId 回查而不是直接用请求里的对象：请求可能指向
  // 已被关闭的 tab，此时应让截图走空态，而不是渲染一个幽灵 webview。
  const screenshotSurfaceTab = screenshotSurfaceTabId
    ? tabs.find((tab) => tab.id === screenshotSurfaceTabId)
    : screenshotSurfaceRequest
      ? findScreenshotSurfaceTabForRender(tabs, screenshotSurfaceRequest)
      : undefined;
  // [并发] 渲染用的是"可见子集"而不是全量 tabs：ownerTaskId 过滤保证
  // 不属于当前会话的 tab 不会出现在这个工作区，但内容仍挂载（保活）。
  // 破坏后果：用全量 tabs 渲染 tab 栏，切换会话时会看到上一会话的标签。
  const visibleTabs = useMemo(
    () =>
      getVisibleSidePaneTabs(tabs, {
        workspaceKey,
        ownerTaskId: sidePaneOwnerId,
      }),
    [sidePaneOwnerId, tabs, workspaceKey],
  );
  // [失败路径] activeTabId 可能指向已被隐藏的 tab（例如切走会话），
  // 必须回退到最后一个可见 tab，否则 Tabs 的 value 匹配不到任何 TabsContent，
  // 内容区会整块空白。
  const activeTabId = sidePaneState?.activeTabId ?? "";
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs.at(-1)?.id ?? "");
  // 完整视图切到对话 tab 时，面板内容全部视为未选中：对话宿主覆盖内容区，webview / 终端不再自认可见。
  // [权衡] 只在"内容归属"上置空，不改 visibleActiveTabId：
  // tab 栏仍需高亮原 tab，否则退出完整视图后用户找不回刚才那一页。
  const contentActiveTabId = fullView?.surface === "conversation" ? "" : visibleActiveTabId;
  // 面板 tab trigger 在 pointerdown 上阻止了默认行为，Radix 收不到 mousedown，不会走 onValueChange；
  // 所有激活面板 tab 的入口都必须经过这里，才能把完整视图切回面板 surface。
  // [事务] 先切 surface 再激活 tab：顺序反了时，onActivateTab 触发的首次渲染
  // 仍处于 conversation surface，webview 会短暂以"可见"状态参与布局。
  // 这也是唯一允许的激活入口（INV-12），直接调 onActivateTab 会丢失这步切换。
  const activateSidePaneTab = (tabId: string) => {
    fullView?.onSelectSurface("side-pane");
    onActivateTab(tabId);
  };
  // [失败路径] 记住"从哪个 tab 进入插件市场"，返回时才能回到原位；
  // 只记 tabId 不够，还需要 workspaceKey 与 ownerId 做归属校验，
  // 否则切到另一个工作区后点返回会激活别人的 tab。
  const [marketReturnTarget, setMarketReturnTarget] = useState<{
    workspaceKey: string;
    ownerId: string | null;
    tabId: string;
  } | null>(null);
  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.type === "plugin-market")) {
      setMarketReturnTarget(null);
    }
  }, [visibleTabs]);
  // [资源] 市场 tab 被关闭后必须清空返回目标，否则它会一直持有旧 tabId，
  // 返回时命中"已不存在"的分支而错误地新开一个空 tab。
  const hasVisibleTabs = visibleTabs.length > 0;
  const tabsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tabsScrollContentRef = useRef<HTMLDivElement | null>(null);
  // [并发] 锁宽只影响内容层的内联 style，不影响 ResizablePanel 自身的宽度；
  // 二者如果同时写，拖拽手柄的百分比会与像素值互相覆盖。
  const [lockedContentWidthPx, setLockedContentWidthPx] = useState<number | null>(null);
  // 是否挂载只由"可见 或 存在 tab"决定，而不是由 isVisible 单独决定：
  // 收起时必须保持挂载，否则动画期间内容消失，内部终端也会被销毁。
  const shouldMountContent = shouldMountSidePaneContent(isVisible, tabs);
  // [并发] 这是单向闩锁（INV-1）：一旦渲染过就不再回退，后续收起只改 opacity。
  // 用初始值而不是 false，避免首帧可见时还要多一次 effect 才能挂载内容。
  const [hasRenderedSidePane, setHasRenderedSidePane] = useState(shouldMountContent);
  // [权衡] 溢出与遮罩分两个 state：overflow 决定"新增按钮放哪"，mask 决定
  // "渐变画在哪侧"。合并会导致滚动时按钮位置随 mask 抖动。
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);
  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>({
    left: false,
    right: false,
  });
  // [并发] draggingTabId 非空即"拖拽事务进行中"：重排、激活、溢出计算
  // 都应把它当成临界区，避免拖拽中途列表项重新排序造成 over 目标跳变。
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  // [资源] enabled 传 hasRenderedSidePane 而不是 isVisible：收起后仍需继续
  // 测量，否则下次展开的第一帧会沿用旧的可见宽度。
  const sidePaneVisibleInlineSizePx = useViewportInlineIntersectionSize(
    panelElementRef,
    hasRenderedSidePane,
  );
  // [权衡] 只有面板曾渲染过才监听 resize：面板从未打开时注册监听等于
  // 给整页窗口 resize 增加无意义的状态写入。
  const isWindowResizeSettling = useWindowResizeSettling(hasRenderedSidePane);
  // [资源] 用 ref 保存定时器 id：它不参与渲染，放进 state 会额外触发
  // 一次渲染，且快速开关时的清理必须读到"最新 id"而不是闭包捕获值。
  const widthUnlockTimerRef = useRef<number | null>(null);
  const previousIsVisibleRef = useRef(isVisible);
  // [权衡] 布局参数由纯函数计算而不是就地写死：mobileOverlay / mobileStacked
  // 组合有多种，散落在 JSX 里会互相覆盖，出现"手机抽屉带桌面尺寸"。
  const panelLayout = resolveAnimatedSidePanePanelLayout({ mobileOverlay });
  // [失败路径] "已有 review tab"是启动器里隐藏 review 入口的依据：
  // 不判它时用户会看到重复入口，点开却只是切到已有 tab，像是没反应。
  const hasReviewTab = visibleTabs.some((tab) => tab.type === "git");
  const canOpenSelectionSideConversation = shouldOfferSelectionSideConversation({
    activeTaskId,
    isMobileTextInputViewport,
    mobileOverlay,
  });
  // [权衡] 拖拽阈值 4px 而不是 0：0 会让"点击切 tab"被识别成拖拽开始，
  // 每次点击都触发一次 dragging 状态往返，tab 栏闪一下。
  const tabDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );

  // [并发] 只记录 id 而不记录整个 tab 对象：拖拽期间 tab 可能被更新，
  // 持有旧对象会让 DragOverlay 显示过期标题。
  const handleTabDragStart = (event: DragStartEvent) => {
    setDraggingTabId(String(event.active.id));
  };

  // [事务] 先清 dragging 再提交重排：重排会改变 visibleTabs，若仍处于
  // dragging 状态，SortableContext 会在 items 更新后尝试重新计算碰撞。
  // over 为空表示拖到列表外，原地松手（active 等于 over）同样不提交（INV-6）。
  const handleTabDragEnd = (event: DragEndEvent) => {
    setDraggingTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorderTab(String(active.id), String(over.id));
  };

  // [失败路径] 取消（Esc、指针丢失）必须走独立分支：此时 over 可能是旧值，
  // 复用 onDragEnd 的逻辑会误提交一次重排。
  const handleTabDragCancel = () => {
    setDraggingTabId(null);
  };

  // [权衡] 首次展开只能估算：此时内容还没渲染过，拿不到真实内容宽度，
  // 于是用 PanelGroup 的像素宽度乘默认展开比例，得到"接近最终态"的值。
  // 破坏后果：把估算值写进持久化宽度，用户下次打开会看到被重置的比例。
  const readInitialExpandedContentWidthPx = () => {
    const panelElement = panelElementRef.current;
    const panelGroupElement = panelElement?.parentElement;
    const panelGroupWidthPx = Math.round(panelGroupElement?.getBoundingClientRect().width ?? 0);

    // [失败路径] 宽度为 0 或非有限值时返回 null 而不是 0：调用方据此
    // 保留上一次的锁宽，避免在面板尚未布局时把内容压成 0px。
    if (!Number.isFinite(panelGroupWidthPx) || panelGroupWidthPx <= 0) {
      return null;
    }

    return Math.round(panelGroupWidthPx * SIDE_PANE_DEFAULT_EXPANDED_RATIO);
  };

  // [资源] 这里只是置位闩锁，不做任何清理：真正的清理在收起时只改样式，
  // 因此这个 effect 依赖 shouldMountContent 即可，不需要额外条件。
  useEffect(() => {
    if (shouldMountContent) {
      // side pane 收起动画原本依赖外层 panel 的 opacity/flex-grow 过渡，
      // 但这里之前把内容写成 `isVisible && sidePaneState ? ... : null`，
      // 一收起就会先把 Tabs/Git/Browser 整块卸载，动画还没走完内容就没了。
      // 改成首次打开后保持挂载，后续收起只隐藏不卸载，这样动画和内部状态都能一起保留。
      setHasRenderedSidePane(true);
    }
  }, [shouldMountContent]);

  // [并发] 这是整个动画状态机的核心：用"上一次 isVisible"与"这一次 isVisible"
  // 的差集判定展开/收起，而不是读 CSS 过渡事件。原因是过渡在快速开关时可能
  // 根本不会触发 transitionend，状态就会卡在中间。
  useEffect(() => {
    const previousIsVisible = previousIsVisibleRef.current;
    previousIsVisibleRef.current = isVisible;

    // [并发] 先清掉上一轮的解锁定时器（INV-7）：快速"关→开"时，上一轮的
    // 200ms 解锁回调会落在新一轮展开过程中，把刚设好的锁宽清成 null，
    // 表现为展开动画末尾宽度突然跳一下。
    if (widthUnlockTimerRef.current !== null) {
      window.clearTimeout(widthUnlockTimerRef.current);
      widthUnlockTimerRef.current = null;
    }

    // [事务] 收起分支：只写锁宽然后立即 return，不启动解锁定时器。
    // 收起期间锁宽要一直保留到下次展开，否则内容会在淡出过程中重新排版（INV-4）。
    if (previousIsVisible && !isVisible) {
      // [资源] 读的是 panel 元素（外层）宽度而不是内容层：内容层此刻可能
      // 已被 flex 压缩，读它会得到偏小的值，锁宽后反而更窄。
      const currentPanelWidthPx = Math.round(
        panelElementRef.current?.getBoundingClientRect().width ?? 0,
      );
      // side pane 收起时内容层会跟着外层 panel 一起参与过渡，
      // 这里在收起前锁住当前像素宽度，避免内部 Tabs/Git/Browser 先重新排版后再淡出。
      // [失败路径] 宽度为 0（面板尚未布局、或在 display:none 祖先下）时写 null
      // 而不是 0：0px 会让内容在淡出期间被压成一条线，视觉上像闪断。
      setLockedContentWidthPx(currentPanelWidthPx > 0 ? currentPanelWidthPx : null);
      return;
    }

    // [权衡] 展开分支优先复用已有锁宽（函数式更新里的 currentWidthPx）：
    // 用户拖拽后收起再展开，必须回到他拖出来的宽度，而不是默认比例（INV-15）。
    if (!previousIsVisible && isVisible) {
      // 首次展开没有“上一次收起前宽度”可复用，内容会先以 0 宽度参与布局再被撑开。
      // 这里用 PanelGroup 的真实像素宽度换算默认展开宽度，先给内容层一个接近最终态的锁宽；
      // 等 200ms 过渡结束后再移除固定宽度，恢复成普通自适应布局。
      // [事务] 只有 current 为 null（首次展开或刚被解锁）才走估算，
      // 这一步是"读不到历史宽度"时的唯一降级路径。
      setLockedContentWidthPx(
        (currentWidthPx) => currentWidthPx ?? readInitialExpandedContentWidthPx(),
      );
      // [资源] 过渡结束后必须解锁（INV-2）：锁宽是"过渡期间的临时栅格"，
      // 永久保留会让窗口缩放后内容不跟随，右侧出现空白或溢出。
      // 定时器 id 存 ref，卸载时由下一个 effect 统一清理。
      widthUnlockTimerRef.current = window.setTimeout(() => {
        setLockedContentWidthPx(null);
        widthUnlockTimerRef.current = null;
      }, SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS);
    }
  }, [isVisible, panelElementRef]);

  // [资源] 卸载清理（INV-18）：组件在动画中途被移除时，解锁定时器仍会触发，
  // 对已卸载组件 setState 虽不报错但会泄漏闭包引用。
  useEffect(() => {
    return () => {
      if (widthUnlockTimerRef.current !== null) {
        window.clearTimeout(widthUnlockTimerRef.current);
      }
    };
  }, []);

  // [权衡] 样式对象在这里构造而不是在 JSX 内联：null 与 undefined 的语义
  // 不同（null 表示"不锁宽"），内联写法容易写成三元里再套三元。
  const lockedContentStyle: CSSProperties | undefined =
    lockedContentWidthPx !== null
      ? {
          width: `${lockedContentWidthPx}px`,
        }
      : undefined;

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    // [失败路径] refs 为空时不能留旧状态：侧栏尚未挂载或 tabs 清空时，
    // 溢出与遮罩必须一起归零，否则会保留上一次的渐变，看起来像内容被裁掉。
    if (!viewport || !content) {
      setIsTabsOverflowing(false);
      // sidePaneState 为空或内容尚未挂载时 refs 会持续为空。
      // 这里不能每次写入新的 mask 对象，否则 effect 会在空 tabs 阶段反复触发更新。
      setTabsScrollMaskEdges((current) =>
        current.left || current.right ? EMPTY_TABS_SCROLL_MASK_EDGES : current,
      );
      return;
    }

    // [资源] 这是唯一读取布局的地方：滚动的两个边界都在这里算，
    // 其余逻辑只消费结果，避免滚动回调里多次强制 reflow。
    const updateOverflowState = () => {
      // [资源] scrollWidth 是内容宽度，clientWidth 是可视宽度；差值即最大
      // 可滚动距离。子像素取整误差靠下面减 1 的容差吸收。
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-tab-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      // 旧判定直接读取 content.scrollWidth，但 overflow 状态本身会把新增按钮
      // 移进/移出 content 并改变 viewport 宽度，临界区会形成 ResizeObserver 反馈环。
      // 这里统一还原“新增按钮位于 tabs 末尾”的假想布局，只用稳定的最小宽度预算判定。
      // [并发] 判定走稳定预算而不是实时 scrollWidth（INV-17）：溢出状态本身
      // 会把新增按钮在 content 内外移动，进而改变 viewport 宽度，
      // 实时读取会形成 ResizeObserver 反馈环，表现为 tab 栏持续抖动。
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // 新增按钮在 tabs 尚可等宽收缩时跟随末尾，只有达到 60px 下限仍溢出后才固定到右侧。
      // [权衡] 溢出时新增按钮移到右侧固定区，未溢出时跟在最后一个 tab 后面；
      // 两种布局的 DOM 位置不同，但判定用的是"假想布局"，所以位置切换不会反过来影响判定。
      setIsTabsOverflowing(isOverflowing);
      // tabs 溢出时不能两侧一直显示渐变 mask：滚动到起点/终点也像还能继续滚。
      // 这里把 mask 和实际 scrollLeft 绑定，只提示仍可继续滚动的一侧。
      // [资源] 返回原对象表示"无变化"，避免每次滚动都触发一次重渲染（INV-16）。
      // 容差 1px 用于吸收 scrollLeft 的小数取整，否则贴边时遮罩会闪烁。
      setTabsScrollMaskEdges((current) => {
        const next = {
          left: isOverflowing && viewport.scrollLeft > 1,
          right: isOverflowing && viewport.scrollLeft < maxScrollLeft - 1,
        };

        if (current.left === next.left && current.right === next.right) {
          return current;
        }

        return next;
      });
    };

    // RAF-based debounce to coalesce resize events
    // [并发] ResizeObserver 的回调可能一帧内触发多次，用 RAF 合并成一次提交；
    // latestCallback 指向最新闭包，避免旧闭包里的 visibleTabs 覆盖新值。
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    // [事务] 先同步跑一次，再注册监听：首帧就要决定新增按钮位置，
    // 等 observe 回调会晚一帧，用户会看到按钮从中间跳到右侧。
    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });

    // [失败路径] 无 ResizeObserver 的环境退化为"只在窗口 resize 时重算"：
    // tab 数量变化仍会因依赖 visibleTabs 重新执行 effect，功能不降级只是少一档灵敏度。
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    // [资源] 同时观察 viewport 与 content：只观察 viewport 会漏掉"内容变窄
    // 但容器宽度未变"的场景（例如 tab 标题变短）。
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      // [资源] 三条清理缺一不可：Observer、scroll 监听、未执行的 RAF。
      // 漏掉 RAF 时，卸载后仍会执行一次 updateOverflowState 并 setState。
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visibleTabs]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!visibleActiveTabId || !viewport || !content) {
      return;
    }

    // [并发] 用 RAF 延后到布局完成后再量：tab 刚被激活时宽度可能还没稳定，
    // 同步测量会把 scrollBy 算偏，导致激活的 tab 只露出一半。
    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === visibleActiveTabId);

      if (!activeTab) {
        return;
      }

      // [资源] 两侧都用真实 DOM rect：tab 宽度由标题与 favicon 决定，
      // 固定宽度估算会让长标题 tab 滚不到位。
      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;

      // [事务] 左侧越界优先处理并提前返回：同时越界只可能发生在极窄容器，
      // 先保证标题开头可见，比同时做两次 scrollBy 更可预期。
      if (leftOverflow < 0) {
        // 从外部激活 tab（例如打开文件或切回旧 Browser）时，
        // active tab 可能已经被横向滚动区域遮住。这里按真实 DOM 宽度滚回可视区，
        // 避免使用固定宽度估算导致长标题 / favicon tab 对不齐。
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }

      // [权衡] 只有右侧越界才滚到"刚好露出右边缘"，不额外留白：
      // 多加一个 tab 宽度会让相邻 tab 的关闭按钮进入视野，误触率上升。
      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleActiveTabId, visibleTabs]);

  const addTabButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="shrink-0"
      data-side-pane-add-trigger
      data-side-pane-add-tab-trigger=""
      aria-label={intl.formatMessage({ id: "sidePane.addTab" })}
      // [事务] 新开 tab 也必须先切回 side-pane surface（与 activateSidePaneTab
      // 同一规则），否则在完整视图的对话态点"+"，新 tab 打开了却看不见。
      onClick={() => {
        fullView?.onSelectSurface("side-pane");
        onOpenNewTab();
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
  // [资源] 这张映射表把"入口 id"与"打开动作"解耦：新增入口只需在
  // resolve 函数里登记 id，不必同时改渲染分支，减少漏改导致的哑按钮。
  const openTabLauncherItemById: Record<OpenTabLauncherItemId, OpenTabLauncherItem> = {
    // [并发] 启动器用 id 做索引而不是数组：可见性由 resolveOpenTabLauncherItemIds
    // 统一决定，两处各写一遍条件时会出现"入口可见但点开无回调"。
    "selection-side-conversation": {
      id: "selection-side-conversation",
      label: intl.formatMessage({ id: "sidePane.selectionChat" }),
      description: intl.formatMessage({ id: "sidePane.launcher.selection-side-conversation" }),
      icon: MessageSquareTextIcon,
      onOpen: onOpenSelectionSideConversation,
    },
    // [权衡] 文件管理器的 description 复用空态文案：与其新写一句，
    // 不如让用户在意的是"这里能打开文件"，文案与面板空态保持一致。
    files: {
      id: "files",
      label: intl.formatMessage({ id: "fileManager.title" }),
      description: intl.formatMessage({ id: "fileManager.empty" }),
      icon: FolderOpenIcon,
      onOpen: () => onOpenFileManager(),
    },
    review: {
      id: "review",
      label: intl.formatMessage({ id: "sidePane.review" }),
      description: intl.formatMessage({ id: "sidePane.launcher.review" }),
      icon: FileDiffIcon,
      onOpen: onOpenReviewTab,
    },
    // [失败路径] terminal 在 Office 模式下被过滤掉（见下方 filter），
    // 但映射仍要存在：过滤发生在渲染列表层，回调缺失会让类型收窄失败。
    terminal: {
      id: "terminal",
      label: intl.formatMessage({ id: "terminal.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.terminal" }),
      icon: SquareTerminalIcon,
      onOpen: onOpenTerminalTab,
    },
    // [失败路径] supportsEmbeddedBrowser 为 false 时 browser 入口不可见，
    // 但 onOpen 仍然指向真实回调：可见性判断只允许出现在 resolve 函数里。
    browser: {
      id: "browser",
      label: intl.formatMessage({ id: "browser.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.browser" }),
      icon: GlobeIcon,
      onOpen: onOpenBrowserTab,
    },
    // [权衡] 开发者工具走独立开关而不是 NODE_ENV：生产包里也可能需要
    // 打开它排查远控问题，用编译期条件会让这条路径永远不可测。
    "developer-tools": {
      id: "developer-tools",
      label: intl.formatMessage({ id: "developerTools.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.developer-tools" }),
      icon: BugIcon,
      onOpen: onOpenDeveloperTools,
    },
  };
  // [事务] 顺序链是 resolve（决定有哪些）→ filter（模式裁剪）→ map（取实现），
  // 三步都不能合并：合并后 Office 模式需要再写一份可见性判断。
  const openTabLauncherItems: OpenTabLauncherItem[] = resolveOpenTabLauncherItemIds({
    canOpenSelectionSideConversation,
    developerToolsEnabled,
    hasReviewTab,
    supportsEmbeddedBrowser,
  })
    .filter((itemId) => !isOfficeMode || (itemId !== "terminal" && itemId !== "review"))
    .map((itemId) => openTabLauncherItemById[itemId]);
  // [权衡] 关闭按钮只在"可见 + 非移动抽屉 + 有回调"时渲染：
  // 抽屉有自己的一体化头部，再挂一组窗口控件会重复。
  // 破坏后果：isVisible 判断漏掉时，收起状态仍能点到关闭，触发无意义的状态写入。
  const closeSidePaneButton =
    isVisible && !mobileOverlay && onCloseSidePane ? (
      <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        {fullViewToggle ? (
          <SidePaneFullViewToggleButton
            active={fullViewToggle.active}
            onToggle={fullViewToggle.onToggle}
            shortcutLabel={fullViewToggle.shortcutLabel}
          />
        ) : null}
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen
          onToggleSidePane={onCloseSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
        {showWindowControls ? <DesktopWindowControls /> : null}
      </div>
    ) : null;
  // [资源] 启动器整块在渲染阶段构造而不是缓存：它包含大量 intl 文案，
  // 但只在 new-tab 或空状态时出现，缓存反而会让语言切换后不刷新。
  const openTabLauncher = (
    <div className="side-pane-open-tab-shell @container/launcher flex h-full min-h-0 flex-col bg-background">
      {/* 对齐原型：顶部对齐滚动、左对齐标题；内置应用与 UI 插件同为横向行，短分割线分区。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "sidePane.openTab" })}
          </h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
            {openTabLauncherItems.map((item) => (
              <SidePaneLauncherRow
                key={item.id}
                itemId={item.id}
                icon={item.icon}
                label={item.label}
                description={item.description}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {/* 空会话暂不支持应用插件，连同分区入口一起隐藏。 */}
          {activeTaskId ? (
            <>
              <div aria-hidden="true" className="my-4 h-px w-24 self-center bg-border" />
              <section className="min-w-0" data-testid="side-pane-ui-recommendations">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <h2 className="pl-2 text-ui-lg font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.store.ui.title" })}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-foreground-subtle"
                    data-testid="side-pane-plugin-market"
                    onClick={() => {
                      if (!onOpenPluginMarket) return;
                      setMarketReturnTarget({
                        workspaceKey,
                        ownerId: sidePaneOwnerId ?? null,
                        tabId: visibleActiveTabId,
                      });
                      onOpenPluginMarket();
                    }}
                  >
                    {intl.formatMessage({ id: "sidePane.launcher.viewAllPlugins" })}
                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
                  {onOpenPluginUi ? (
                    <PluginUiLauncherItems
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={workspaceRemoteSessionId}
                      sessionId={activeTaskId}
                      onOpenPluginUi={onOpenPluginUi}
                    />
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
  // [失败路径] 概览面板接收的是 visibleTabs 与 activeTabId 的"可见视图"，
  // 不是全量 tabs：否则会列出别的会话的 tab 并允许跳转过去。
  const sidePaneTabOverview = (
    <SidePaneTabOverview
      tabs={visibleTabs}
      activeTabId={visibleActiveTabId}
      recentClosedTabs={recentClosedSidePaneTabs}
      labels={{
        title: intl.formatMessage({ id: "sidePane.tabOverview" }),
        searchPlaceholder: intl.formatMessage({
          id: "sidePane.searchTabs",
        }),
        openTabs: intl.formatMessage({ id: "sidePane.openTabs" }),
        recentlyClosedTabs: intl.formatMessage({
          id: "sidePane.recentlyClosedTabs",
        }),
        noResults: intl.formatMessage({ id: "sidePane.noTabsFound" }),
        closeTab: (title) => intl.formatMessage({ id: "sidePane.closeTab" }, { title }),
        relativeTime: (timestamp) => formatTaskRelativeTime(timestamp, intl),
        browserTitle: intl.formatMessage({ id: "browser.title" }),
        reviewTitle: intl.formatMessage({ id: "sidePane.review" }),
        fileManagerTitle: intl.formatMessage({ id: "fileManager.title" }),
        codeViewerTitle: intl.formatMessage({ id: "codeViewer.title" }),
        treemappingTitle: intl.formatMessage({ id: "treemapping.title" }),
        whiteboardTitle: intl.formatMessage({ id: "whiteboard.title" }),
        modelTrajectoryTitle: intl.formatMessage({
          id: "modelTrajectory.title",
        }),
        newTabTitle: intl.formatMessage({ id: "sidePane.newTab" }),
        pluginMarketTitle: intl.formatMessage({ id: "workspace.openPluginsSettings" }),
        developerToolsTitle: intl.formatMessage({
          id: "developerTools.title",
        }),
        browserPermissionsTitle: intl.formatMessage({
          id: "browser.permission.settings",
        }),
        terminalTitle: intl.formatMessage({ id: "terminal.title" }),
        subagentTypeLabel: intl.formatMessage({ id: "sidePane.subagent" }),
        subagentDirectoryTitle: intl.formatMessage({
          id: "sidePane.subagentDirectory",
        }),
        selectionChatTitle: intl.formatMessage({
          id: "sidePane.selectionChat",
        }),
        planTitle: intl.formatMessage({ id: "planTool.panel.planTab" }),
        workflowRunTitle: intl.formatMessage({ id: "sidePane.workflowRun" }),
        workflowDirectoryTitle: intl.formatMessage({ id: "sidePane.workflowDirectory" }),
        workflowActorTitle: intl.formatMessage({ id: "sidePane.workflowActor" }),
        workflowScriptTitle: intl.formatMessage({ id: "sidePane.workflowScript" }),
        workflowArtifactTitle: intl.formatMessage({ id: "sidePane.workflowArtifact" }),
      }}
      onActivateTab={activateSidePaneTab}
      onCloseTab={onCloseTab}
      onReopenClosedTab={onReopenClosedTab}
    />
  );
  // [并发] 拖拽中的 tab 需要从"可见集合"里回查：拖拽期间 tab 可能被关闭，
  // 此时 draggingTabId 还在但对象已不存在，返回 null 让 overlay 直接不渲染。
  const draggingTab = draggingTabId
    ? (visibleTabs.find((tab) => tab.id === draggingTabId) ?? null)
    : null;

  // [并发] panelContent 是"Dom 树 + 内容"的整体，被两种外层二选一包住：
  // mobileOverlay 的普通 div 与桌面端的 ResizablePanel。抽出来是为了保证
  // 两条路径渲染的是同一棵树，任何一层单独加样式都不会让内容结构分叉。
  const panelContent = (
    <div
      // [失败路径] aria-hidden 跟随 isVisible 但 DOM 保留（INV-11）：
      // 收起时读屏应跳过整块内容，但卸载会丢掉终端与 browser 的内部状态。
      aria-hidden={!isVisible}
      data-workspace-side-frame={mobileOverlay ? undefined : "true"}
      className={cn(
        // 独立外框放在内容层：关闭仍保留 Browser Guest 和 tab 实例，不改变面板持久化边界。
        "h-full overflow-hidden bg-background",
        !mobileOverlay && frameClassName,
        mobileStacked && "max-md:rounded-none max-md:border-0",
        mobileOverlay && "min-w-0",
        mobileStacked && "max-md:!w-full",
        // 完整视图：相对外层 PanelGroup 铺满整行，库管理的 panel 宽度保持不变。
        // 修复原因：插件 UI 页面挂在 body 末尾的 fixed 停靠层（无 z-index）里，外框曾用 z-10
        // 把不透明背景画在它上面，插件 tab 显示为空白。对话列内容都在 z-30 的宿主里，
        // 外框只需 z-0 建立自己的层叠上下文，按 DOM 顺序排在停靠层之下。
        fullView && "absolute inset-0 z-0",
      )}
      // [权衡] 锁宽只在"非移动抽屉、非完整视图"时生效（INV-14）：
      // 抽屉宽度由外层决定，完整视图是绝对定位铺满，写死像素都会冲突。
      style={mobileOverlay || fullView ? undefined : lockedContentStyle}
    >
      <ScopedErrorBoundary
        scope="workspace-side-pane"
        resetKeys={[workspaceKey, visibleActiveTabId]}
        variant="panel"
        className="h-full"
      >
        {hasRenderedSidePane && (sidePaneState || fullView) ? (
          // [并发] 条件里必须同时允许 fullView：完整视图可能在 sidePaneState
          // 尚未到达时先渲染，只判 sidePaneState 会让对话宿主整块不显示。
          <>
            {/* 收起或切换对话时保留其他对话的内容挂载，避免丢失辅助对话草稿和引用。
                展开后的空标签集合由 useAppPanels 统一补建「新标签页」。 */}
            <div
              className={cn(
                "h-full min-h-0",
                !hasVisibleTabs && !screenshotSurfaceRequest && !fullView && "hidden",
              )}
            >
              <Tabs
                value={
                  fullView?.surface === "conversation"
                    ? SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE
                    : visibleActiveTabId
                }
                onValueChange={(value) => {
                  // [事务] 对话 tab 是伪 tab：它不在 sidePaneState.tabs 里，
                  // 必须单独拦截并切 surface，否则会被当成未知 tab 而忽略。
                  if (fullView && value === SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE) {
                    fullView.onSelectSurface("conversation");
                    return;
                  }
                  activateSidePaneTab(value);
                }}
                className="relative h-full gap-0"
              >
                <TabsList
                  // [权衡] 抽屉没有窗口 caption，style 传 undefined 让 tab 栏
                  // 跟随抽屉自身的内边距；桌面端则对齐标题栏按钮的高度。
                  style={mobileOverlay ? undefined : captionControlsStyle}
                  className={cn(
                    "flex justify-start w-full rounded-none p-0 border-0 border-b border-border/50 bg-transparent shadow-none !h-12 overflow-hidden",
                    fullView?.leadingInsetClassName,
                    // 独立面板将标签栏移至窗口顶部，需补充窗口拖拽区域；标签和按钮仍处理自身交互。
                    isDesktop &&
                      !mobileOverlay &&
                      "[app-region:drag] [&_button]:[app-region:no-drag] [&_[data-side-pane-tab-id]]:[app-region:no-drag]",
                  )}
                >
                  <div className="flex items-center justify-start flex-1 min-w-0">
                    {/* 与 WorkspaceHeader 的 p-2 对齐，避免切换面板后左右操作区跳动。 */}
                    <div className="flex h-full shrink-0 items-center p-2">
                      {sidePaneTabOverview}
                    </div>
                    {fullView ? (
                      <div className="flex h-full shrink-0 items-center pr-1">
                        <SidePaneFullViewConversationTab
                          title={fullView.conversationTitle}
                          isActive={fullView.surface === "conversation"}
                        />
                      </div>
                    ) : null}
                    <DndContext
                      // [权衡] closestCenter 而不是 pointerWithin：tab 高度一致，
                      // 用中心距离判定在快速拖动时更稳定，不会在两个 tab 间来回跳。
                      sensors={tabDragSensors}
                      collisionDetection={closestCenter}
                      onDragStart={handleTabDragStart}
                      onDragEnd={handleTabDragEnd}
                      onDragCancel={handleTabDragCancel}
                    >
                      <div
                        ref={tabsScrollViewportRef}
                        data-side-pane-tabs-viewport=""
                        // [资源] 遮罩只用 CSS mask，不额外插 DOM 节点：
                        // 插入渐变层会参与命中测试，挡住 tab 的点击区域。
                        className={cn(
                          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide h-12 items-center",
                          tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)]",
                          tabsScrollMaskEdges.left &&
                            !tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)]",
                          !tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)]",
                        )}
                      >
                        {/* tab strip 固定占满滚动 viewport：每个 tab 先从 156px 等宽收缩到
                            60px，只有最小宽度之和仍超出 viewport 时才产生横向滚动。 */}
                        <div
                          ref={tabsScrollContentRef}
                          data-side-pane-tabs-content=""
                          className="flex w-full gap-1 py-2.5"
                        >
                          <SortableContext
                            items={visibleTabs.map((tab) => tab.id)}
                            strategy={horizontalListSortingStrategy}
                          >
                            {visibleTabs.map((tab) => {
                              // 标题统一由 getSidePaneTabTitle 派生：
                              // 各 pane 自己拼标题会导致 tab 栏、概览、拖拽浮层三处不一致。
                              const title = getSidePaneTabTitle(tab, intl.formatMessage);
                              return (
                                // [并发] isActive 用 contentActiveTabId 而不是
                                // visibleActiveTabId：完整视图对话态下所有 tab
                                // 都必须显示为未选中，否则会同时高亮两个。
                                <SortableSidePaneTabTrigger
                                  key={tab.id}
                                  tab={tab}
                                  title={title}
                                  closeTabLabel={intl.formatMessage(
                                    { id: "sidePane.closeTab" },
                                    { title },
                                  )}
                                  closeTabMenuLabel={intl.formatMessage({
                                    id: "sidePane.closeCurrentTab",
                                  })}
                                  closeOtherTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeOtherTabs",
                                  })}
                                  closeAllTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeAllTabs",
                                  })}
                                  diffBadgeLabel={intl.formatMessage({
                                    id: "diff.title",
                                  })}
                                  isActive={tab.id === contentActiveTabId}
                                  onActivateTab={activateSidePaneTab}
                                  onCloseTab={onCloseTab}
                                  onCloseOtherTabs={onCloseOtherTabs}
                                  onCloseAllTabs={onCloseAllTabs}
                                  canCloseOtherTabs={visibleTabs.length > 1}
                                />
                              );
                            })}
                          </SortableContext>
                          {!isTabsOverflowing ? addTabButton : null}
                        </div>
                      </div>
                      <DragOverlay dropAnimation={null}>
                        {draggingTab ? (
                          <SidePaneTabDragOverlay
                            tab={draggingTab}
                            title={getSidePaneTabTitle(draggingTab, intl.formatMessage)}
                            diffBadgeLabel={intl.formatMessage({
                              id: "diff.title",
                            })}
                          />
                        ) : null}
                      </DragOverlay>
                    </DndContext>

                    <div className="ml-auto flex h-full shrink-0 items-center gap-1 px-2">
                      {isTabsOverflowing ? addTabButton : null}
                      {closeSidePaneButton}
                    </div>
                  </div>
                  {/* Expand Panel 按钮按要求先注释保留，相关逻辑已删除。
                <div className="flex h-full shrink-0 items-center pl-1.5 pr-2">
                  <ControlHintTooltip title="" side="bottom" align="end">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="">
                      Expand Panel
                    </Button>
                  </ControlHintTooltip>
                </div>
                */}
                </TabsList>

                <div
                  ref={mobileOverlay ? undefined : fullViewSlotRef}
                  data-side-pane-content-slot=""
                  className={cn("relative min-h-0 flex-1 isolate", mobileOverlay && "min-w-0")}
                >
                  {fullView && !hasVisibleTabs ? (
                    <div className="absolute inset-0 z-10">{openTabLauncher}</div>
                  ) : null}
                  {tabs.map((tab) => {
                    // [资源] 这里遍历的是全量 tabs 而不是 visibleTabs：
                    // 被隐藏会话的 tab 也必须保活，否则切回会话时终端与会话状态重建。
                    if (
                      (tab.type === "browser" || tab.type === "browser-use") &&
                      !shouldMountBrowserTabGuest(tab)
                    ) {
                      return <SuspendedBrowserSidePaneContent key={tab.id} tab={tab} />;
                    }
                    // [失败路径] 挂起态渲染空壳而不是真实视图：真实视图会重新
                    // attach guest，把刚被 main 挂起的 browser 立刻唤醒。
                    if (tab.type === "browser-use") {
                      return (
                        <BrowserUseSidePaneContent
                          key={tab.id}
                          tab={tab}
                          onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                          isPanelVisible={isVisible}
                          isSelected={tab.id === contentActiveTabId}
                          isCurrentTask={tab.sessionId === sidePaneOwnerId}
                          screenshotSurfaceRequest={
                            screenshotSurfaceTab?.id === tab.id ? screenshotSurfaceRequest : null
                          }
                          // restoring guest 的完整 history 由 main 在 did-attach 后写入；
                          // renderer 同时消费 initialUrl 会抢先提交导航，使 Chromium 拒绝 restore。
                          // [并发] 因此这里的判空是"让位"而不是缺省值：只有非 restoring
                          // 才允许 renderer 决定首个 URL，否则两边同时导航会互相打断。
                          initialUrl={
                            tab.residency === "restoring" ? undefined : browserRestoreUrls[tab.id]
                          }
                          workspacePath={workspaceAbsPath}
                          workspaceIdentity={workspaceIdentity}
                          residencyGeneration={tab.residencyGeneration}
                          onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                          onPageMetadataChange={(metadata) =>
                            onBrowserPageMetadataChange(tab.id, metadata)
                          }
                        />
                      );
                    }
                    return (
                      <TabsContent
                        // [并发] forceMount 是保活的关键（INV-19）：切走的 tab
                        // 只加 hidden 属性，DOM 与子组件状态都保留。
                        key={tab.id}
                        value={tab.id}
                        forceMount
                        className={cn(
                          "relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden",
                          mobileOverlay && "min-w-0",
                        )}
                      >
                        {tab.type === "bash-output" ? (
                          // [权衡] visible 用 isVisible 且 id 相等：后台命令输出
                          // 即使 tab 未选中也要继续接收，只是不在前台展示。
                          <BackgroundBashOutputSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "subagent-session" ? (
                          // [并发] focused 与 visible 分开传：子代理会话需要知道
                          // "面板可见但自己不是当前 tab"，以便暂停流式渲染。
                          <SubagentSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            compactForRemoteControl={mobileOverlay}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onOpenSubagentSession={onOpenSubagentSession}
                            onOpenBackgroundBash={onOpenBackgroundBash}
                          />
                        ) : tab.type === "subagent-directory" ? (
                          // [权衡] 目录页不需要 focused 参数：它只是静态索引，
                          // 不会发起流式请求，也就不存在"被遮挡时要降级"的问题。
                          <SubagentDirectorySidePane
                            tab={tab}
                            onOpenSubagentSession={onOpenSubagentSession}
                          />
                        ) : tab.type === "selection-side-chat" ? (
                          // [失败路径] onUnavailable 必须传：划词对话依赖被选中的
                          // 文本，原文消失时只能关闭 tab，否则会显示空对话。
                          <SelectionSideChatPane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onUnavailable={onCloseTab}
                          />
                        ) : tab.type === "plugin-ui" ? (
                          // [资源] 插件 UI 是外部 iframe/surface，必须显式传 visible：
                          // 它无法从 DOM 的 hidden 属性推断自己该不该继续绘制。
                          <PluginUiSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onCloseTab={onCloseTab}
                          />
                        ) : tab.type === "plan-detail" ? (
                          // [权衡] 计划详情是只读视图，不需要 visible：
                          // 它没有后台任务，也不持有需要暂停的动画。
                          <PlanDetailSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-run" ? (
                          // [权衡] 可选回调用条件展开而不是传 undefined：
                          // exactOptionalPropertyTypes 下显式 undefined 与缺省不同。
                          <WorkflowRunSidePane
                            tab={tab}
                            {...(onOpenWorkflowActorSession === undefined
                              ? {}
                              : { onOpenWorkflowActorSession })}
                            {...(onOpenWorkflowArtifact === undefined
                              ? {}
                              : { onOpenWorkflowArtifact })}
                            {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
                            {...(onOpenWorkflowWorkspace === undefined
                              ? {}
                              : { onOpenWorkflowWorkspace })}
                          />
                        ) : tab.type === "workflow-directory" ? (
                          // 类型分支必须先收窄，回调缺席在**分支内部**处理：把
                          // `&& onOpenWorkflowRun` 写进条件会让这个 tab 类型继续留在后面
                          // 那些分支的联合里（browser 分支于是拿它去读 residency）。
                          // [失败路径] 类型必须先收窄再判回调，不能让回调判断进入条件：
                          // 否则该 tab 类型会残留在后续分支的联合里，browser 分支读到不存在的字段。
                          // [权衡] 回调缺席返回 null 而不是空壳，避免"看起来加载失败"。
                          onOpenWorkflowRun ? (
                            <WorkflowRunDirectorySidePane
                              tab={tab}
                              onOpenWorkflowRun={onOpenWorkflowRun}
                            />
                          ) : null
                        ) : tab.type === "workflow-actor-session" ? (
                          // [权衡] actor 会话走独立组件而不是复用 subagent 会话：
                          // 两者的数据源与权限模型不同，复用会在 props 上分叉出大量可选字段。
                          <WorkflowActorSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-workspace" ? (
                          // [权衡] 脚本会话只开放"打开代码查看器"：它不产出可点
                          // 的会话链接，多传回调会让宿主以为这里能继续下钻。
                          <WorkflowWorkspaceSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "workflow-artifact" ? (
                          // 「在工作区显示」复用 Git 面板那条文件树 reveal（同一个宿主回调），
                          // 不新造第二条定位路径。
                          // [事务] 产物卡的"在工作区显示"复用同一个 reveal 回调：
                          // 新开一条定位链路会让同一份产物在不同 tab 落到不同目录。
                          // [权衡] 用条件展开而非传 undefined，兼容 exactOptionalPropertyTypes。
                          <WorkflowArtifactSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            {...(onRevealGitFileInTree === undefined
                              ? {}
                              : { onRevealFileInTree: onRevealGitFileInTree })}
                          />
                        ) : tab.type === "code-viewer" || tab.type === "file-manager" ? (
                          // [并发] 两个类型共用一个组件：file-manager 自带 target，
                          // code-viewer 则从 source 派生；否则会出现两份文件树实现。
                          <FileManagerPane
                            markdownSelectionTarget={{
                              sessionId: activeTaskId,
                              workspaceKey,
                              draftScopeKey,
                            }}
                            source={tab.source}
                            target={
                              tab.type === "file-manager"
                                ? tab.target
                                : {
                                    workspacePath: tab.source.workspacePath ?? workspaceAbsPath,
                                    workspaceIdentity: tab.source.workspacePath
                                      ? tab.source.workspaceIdentity
                                      : workspaceIdentity,
                                    workspaceRemoteSessionId: tab.source.workspacePath
                                      ? tab.source.workspaceRemoteSessionId
                                      : workspaceRemoteSessionId,
                                  }
                            }
                            mobileOverlay={mobileOverlay}
                            canOpenLocalFileManager={Boolean(isDesktop)}
                            onNavigate={(source) => onNavigateFileManager(tab.id, source)}
                            onClose={() => onCloseTab(tab.id)}
                            workspacePath={workspaceAbsPath}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            // inactive/窄条/resize 中的 code preview 不应继续让
                            // @pierre/diffs 的千行 Shadow DOM 参与布局；这里只裁剪 body，保留 tab/source/file state。
                            renderHeavyContent={shouldRenderPreviewPaneHeavyContent({
                              isActiveTab: tab.id === contentActiveTabId,
                              // video/audio 原生全屏会触发 resize，resize settling
                              // 期间必须保持当前媒体节点挂载，否则浏览器会立即退出全屏。
                              isMediaPreview:
                                tab.source?.type === "media" ||
                                (tab.source?.type === "file" &&
                                  inferMediaPreview(tab.source.path) !== null),
                              isMobileOverlay: mobileOverlay,
                              isResizeSettling: isWindowResizeSettling,
                              isSidePaneVisible: isVisible,
                              visibleInlineSizePx: sidePaneVisibleInlineSizePx,
                            })}
                          />
                        ) : tab.type === "git" ? (
                          // [失败路径] gitState 由外部 hook 持有并通过 props 下沉：
                          // 在这里再调一次 hook 会形成第二个 poller，刷新节奏互相打架。
                          <GitPane
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            workspaceRemoteSessionId={workspaceRemoteSessionId}
                            gitState={gitState}
                            isDesktop={isDesktop}
                            selectedSourceId={activeGitSourceId}
                            fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                            fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                            fileChangeFindQuery={fileChangeFindQuery}
                            onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
                            onSelectSource={onSelectGitSource}
                            onClose={onCloseGit}
                            onRefresh={onRefreshGit}
                            onRevealFileInTree={onRevealGitFileInTree}
                          />
                        ) : tab.type === "treemapping" ? (
                          // [权衡] source 缺省为 current：旧 tab 在升级后没有 source
                          // 字段，用 current 兜底而不是整块报错。
                          <TreemappingPane
                            activeTaskId={activeTaskId}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            source={tab.source ?? { kind: "current" }}
                          />
                        ) : tab.type === "whiteboard" ? (
                          // [资源] 画板只依赖 boardId 与 workspace：它自带持久化，
                          // 不需要主组件传入任何可见性或生命周期开关。
                          <WhiteboardPane
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            boardId={tab.boardId}
                          />
                        ) : tab.type === "model-trajectory" ? (
                          // [失败路径] 轨迹页用 tab.taskId 而不是 activeTaskId：
                          // 它可能在看历史任务的轨迹，用当前任务会展示错数据。
                          <ModelTrajectoryPane
                            taskId={tab.taskId}
                            title={tab.title}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            onClose={() => onCloseTab(tab.id)}
                          />
                        ) : tab.type === "new-tab" ? (
                          // [权衡] 新标签页直接复用启动器元素：它同时出现在空状态
                          // 与 fullView 的浮层里，保证三处入口的排序完全一致。
                          openTabLauncher
                        ) : tab.type === "plugin-market" ? (
                          // [资源] 需要自带 ServiceProvider：插件市场用到的服务
                          // 不一定在 side pane 的祖先层提供，缺失时会直接抛错。
                          <ServiceProvider services={services}>
                            <div className="h-full min-w-0 overflow-y-auto p-4">
                              <PluginStorePage
                                onBack={
                                  marketReturnTarget?.workspaceKey === workspaceKey &&
                                  marketReturnTarget.ownerId === (sidePaneOwnerId ?? null)
                                    ? () => {
                                        const targetId = marketReturnTarget.tabId;
                                        setMarketReturnTarget(null);
                                        onCloseTab(tab.id);
                                        if (visibleTabs.some((item) => item.id === targetId)) {
                                          onActivateTab(targetId);
                                        } else {
                                          onOpenNewTab();
                                        }
                                      }
                                    : undefined
                                }
                                embedded
                                onCreateTask={onCreateTask}
                                workspacePath={workspaceAbsPath}
                                workspaceIdentity={workspaceIdentity}
                                remoteSessionId={workspaceRemoteSessionId}
                                sessionId={activeTaskId}
                                isDesktop={isDesktop}
                                isWindowsDesktop={isWindowsDesktop}
                                isMacDesktop={isMacDesktop}
                                isWebRemoteControl={mobileOverlay}
                              />
                            </div>
                          </ServiceProvider>
                        ) : tab.type === "developer-tools" ? (
                          // [失败路径] enabled 绑定 isVisible 与选中态：开发者工具
                          // 会持续拉取日志，后台状态下必须停，否则长时间挂机会积压。
                          <ServiceProvider services={services}>
                            <DeveloperToolsPane
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              taskId={activeTaskId}
                              enabled={isVisible && tab.id === contentActiveTabId}
                            />
                          </ServiceProvider>
                        ) : tab.type === "terminal" ? (
                          // [资源] sessionId 用 tab.id：每个终端 tab 独占一个 PTY，
                          // 用 workspaceKey 会让多个 tab 共享同一条 shell。
                          <SidePaneTerminalPane
                            services={services}
                            sessionId={tab.id}
                            workspaceKey={workspaceKey}
                            cwd={tab.cwd ?? workspaceAbsPath}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                            isWindowsDesktop={isWindowsDesktop}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                          />
                        ) : tab.type === "browser-permissions" ? (
                          // [权衡] 权限页按 origin 渲染而不是按 tab：同一站点的
                          // 多个 tab 应看到同一份权限，切 tab 不该改变内容。
                          <BrowserSitePermissionsPage
                            origin={tab.origin}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                          />
                        ) : (
                          // [并发] 兜底分支是 browser：类型联合里剩下的只有它，
                          // 因此 isVisible 还要与 isBrowserOpen 相与，避免浏览器被
                          // 关闭后 webview 仍自认可见并继续执行页面脚本。
                          <HumanBrowserView
                            browserKey={tab.id}
                            onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                            agentOpened={tab.agentOpened}
                            deferEmptyGuest
                            isResidencyRestore={tab.residency === "restoring"}
                            isVisible={isVisible && isBrowserOpen && tab.id === contentActiveTabId}
                            isSelected={tab.id === contentActiveTabId}
                            isCurrentTask={tab.ownerTaskId === sidePaneOwnerId}
                            // restoring 只挂载不会提交 document 的 bootstrap URL，
                            // 由 main 独占 pageState/URL 恢复事务。
                            initialUrl={
                              tab.residency === "restoring"
                                ? undefined
                                : (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                            }
                            faviconUrl={tab.faviconUrl}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            remoteSessionId={tab.remoteSessionId ?? workspaceRemoteSessionId}
                            residencyGeneration={tab.residencyGeneration}
                            sessionId={tab.ownerTaskId ?? "unscoped"}
                            onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                            onPageMetadataChange={(metadata) =>
                              onBrowserPageMetadataChange(tab.id, metadata)
                            }
                            navigationRequest={
                              browserNavigationRequest?.targetTabId === tab.id
                                ? {
                                    id: browserNavigationRequest.id,
                                    url: browserNavigationRequest.url,
                                  }
                                : null
                            }
                            onNavigationRequestHandled={onBrowserNavigationRequestHandled}
                          />
                        )}
                      </TabsContent>
                    );
                  })}
                </div>
              </Tabs>
            </div>
          </>
        ) : null}
      </ScopedErrorBoundary>
    </div>
  );

  // [权衡] 移动端走普通满宽 div 而不是 ResizablePanel（INV-13）：
  // 抽屉不在 PanelGroup 的布局上下文里，Panel 的 auto 宽度会把子级
  // 100% 宽度链路解析成 0px，diff 与 preview 会挂载但完全不可见。
  if (!panelLayout.useResizablePanel) {
    return (
      <>
        {/* Bugfix: 手机远控侧栏是覆盖聊天区的抽屉，不在 ResizablePanelGroup 的布局上下文里。
            如果继续渲染 ResizablePanel，外层 auto 宽度会把子级 100% 宽度链路解析成 0px，
            diff / preview 内容就会挂载但不可见；这里改用普通满宽容器承接内容。 */}
        <div
          ref={panelElementRef}
          // [失败路径] 这一层同样要保留 DOM 只切 opacity：抽屉关闭动画
          // 依赖 opacity 过渡，display:none 会让过渡直接跳过。
          aria-hidden={!isVisible}
          className={cn(
            "h-full w-full min-w-0 border-l border-border bg-background transition-opacity duration-200 ease-out",
            // [并发] 截图请求优先级高于 isVisible：截图时面板可能已收起，
            // 但仍需以 opacity-100 参与合成（INV-10）。
            isVisible || isScreenshotSurfaceActive
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          {panelContent}
        </div>
      </>
    );
  }

  return (
    <>
      {isVisible && !fullView ? (
        <ResizableHandle
          data-workspace-side-pane-resize-handle="true"
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            mobileStacked && "max-md:hidden",
          )}
        />
      ) : null}
      <ResizablePanel
        id="browser"
        panelRef={panelRef}
        elementRef={panelElementRef}
        // [权衡] defaultSize 用百分比而不是像素：PanelGroup 的布局单位是比例，
        // 传像素需要额外换算；用户的真实拖拽宽度由外层持久化负责。
        defaultSize={panelLayout.defaultSize}
        minSize={panelLayout.minSize}
        maxSize={panelLayout.maxSize}
        collapsedSize={panelLayout.collapsedSize}
        // 右侧面板常驻声明成 collapsible 时，拖到最小宽度会被库判定为 collapse。
        // 这里改成只在显式关闭时允许折叠，避免用户只是想拖到最小宽度时面板自动收起。
        // [事务] collapsible 与 disabled 必须同时跟随 isVisible（INV-8）：
        // 只设 collapsible 时，拖到 minSize 会被库判成 collapse，
        // 用户"只是想拖窄一点"却把面板关掉了。
        // 而收起后若不禁用 resize target，库仍保留边缘拖拽热区，可绕过开关拖出来。
        collapsible={isDragCollapsible}
        // preview/side pane 收起时没有 ResizableHandle，但库仍会暴露 collapsed panel 边缘拖拽区。
        // 收起后禁用面板 resize target，避免用户绕过显式开关从右侧边缘拖出面板。
        // [资源] disabled 只影响交互，不影响持久化宽度：重新展开时
        // 面板会回到收起前的宽度，而不是从 collapsedSize 重新长出来。
        disabled={isResizeDisabled}
        className={cn(
          "!overflow-hidden transition-opacity duration-200 ease-out",
          mobileOverlay &&
            "max-md:!h-full max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-1 max-md:!basis-auto max-md:border-l",
          mobileStacked &&
            !mobileOverlay &&
            "max-md:!h-[min(45dvh,24rem)] max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-l-0 max-md:border-t",
          // 截图期间 panel 仍保持 opacity=1，避免 opacity=0 让 Chromium 丢弃 guest
          // compositor surface；实际 browser surface 已 fixed 到窗口内的低透明合成层，不会露出 tab 栏。
          // [资源] 截图期间保持 opacity=1，避免 Chromium 丢弃 guest 合成层；
          // 实际 browser surface 已 fixed 到窗口内的低透明合成层，不会露出 tab 栏。
          isVisible || isScreenshotSurfaceActive ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {panelContent}
      </ResizablePanel>
    </>
  );
}
