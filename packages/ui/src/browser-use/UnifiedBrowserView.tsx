/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView 集中维护稳定 webview 的导航、事件和 guest 生命周期；横向滚动链已下沉独立 hook。 */
// ==========================================================================
// UnifiedBrowserView —— webview guest 的统一宿主：导航、事件接线与 guest 生命周期
//
// 做：渲染嵌入式 webview、驱动 human 直连导航，并把 chrome 状态从 guest 事件同步回来。
// 做：did-attach 时把 guest webContentsId 上报给 main，供 agent 挂 CDP 控制该 tab。
// 做：在崩溃、显式导航与截图请求下管理 guest 重建与回执时机。
// 不做：不持有 agent 的 tab 归属权威；owner/lease 与 eviction 由 main 判定。
// 不做：不实现滚动链、viewport 控制与截图准备层，它们各自下沉到独立 hook。
// 依赖：usePlatform 的 browserViewAttachGuest/DetachGuest/ReportResidency 桌面能力。
// 依赖：embeddedBrowserHelpers 的 URL 归一化与 safeWebviewCall 失败兜底。
// 边界：human 分支与 agent/browser-use 分支共用组件，靠 props 缺省值区分，不改执行路径。
// 边界：webview 节点一旦卸载，guest 与页面历史一并销毁，只能靠 residency 恢复。
// 并发：同一 view 只允许一个外部导航意图与一次 guest 重建在飞。
// 权衡：宁可多一次幂等上报，也不做跨进程状态合并，避免 owner 绑定的时序歧义。
// 边界：所有 webview 交互都必须经 safeWebviewCall，未 attach 时方法会抛。
//
// INV 不变量（格式：断言 / 守住它的位置 / 改错故障）
// INV-01 断言：隐藏 pane 只从布局移除、不卸载 webview —— 守住它的位置：BrowserViewportSurface 的 isComposed —— 改错故障：guest 被销毁，页面与历史全部丢失。
// INV-02 断言：guest 必须在 did-attach 立即上报 —— 守住它的位置：handleDidAttach —— 改错故障：about:blank 已提交，history.restore 退化成 URL 重载。
// INV-03 断言：isResidencyRestore 时 attach 后必须撤销 src —— 守住它的位置：handleDidAttach 的 removeAttribute —— 改错故障：再次提交 about:blank，中断 main 的历史恢复。
// INV-04 断言：上报去重指纹必须含 workspace/session/residency 维度 —— 守住它的位置：scopeFingerprint —— 改错故障：换 owner 或换代后不重报，CDP 绑到旧会话。
// INV-05 断言：webContentsId 只经 safeWebviewCall 读取 —— 守住它的位置：reportBrowserGuest —— 改错故障：未 attach 时抛错冒泡到 window.onerror。
// INV-06 断言：只有 guest 或 active 状态变化才重报 —— 守住它的位置：lastReportedGuestRef 比较 —— 改错故障：每次 render 重报，main 反复重绑 CDP。
// INV-07 断言：必须等 detach ACK 才能递增 generation —— 守住它的位置：handleRenderProcessGone —— 改错故障：UAF，DevToolsSession 访问已析构 client。
// INV-08 断言：重建前必须清空 request/initial/guest 三个去重 ref —— 守住它的位置：rebuildBrowserGuest —— 改错故障：新 guest 被旧去重键拦截，导航静默丢失。
// INV-09 断言：外部导航回执必须等替代 guest 完成一次 loadURL —— 守住它的位置：completePendingGuestNavigation 的调用点 —— 改错故障：上层 navigationRequest 永久挂起。
// INV-10 断言：同一 view 只保留一个 pending 导航句柄 —— 守住它的位置：waitForGuestNavigationTakeover —— 改错故障：被覆盖的 Promise 永久悬空。
// INV-11 断言：组件卸载必须完成 pending 句柄 —— 守住它的位置：卸载 effect —— 改错故障：关闭 tab 后上层 await 永不返回。
// INV-12 断言：dom-ready 消费 pendingUrl 后必须 return —— 守住它的位置：handleDomReady —— 改错故障：继续同步会用旧 URL 覆盖地址栏与 tab 状态。
// INV-13 断言：src 只在首挂生效，后续导航一律 loadURL —— 守住它的位置：openUrl 与 handleDomReady —— 改错故障：改 src 不触发导航，地址栏与页面不一致。
// INV-14 断言：自由尺寸模式必须把 guest zoom 固定为 1 —— 守住它的位置：handleDomReady 与 zoom effect —— 改错故障：innerWidth 与 DPR 变化，CDP 坐标整体偏移。
// INV-15 断言：只有退出自由尺寸才恢复 desktopZoomFactor —— 守住它的位置：zoom effect 的 else-if —— 改错故障：普通浏览期间改写网页 zoom。
// INV-16 断言：截图用的临时 responsive 不得写回用户偏好 —— 守住它的位置：effectiveViewportZoom 与 effectiveIsResponsiveMode —— 改错故障：release 后错误恢复 zoom，破坏后续 CDP 坐标。
// INV-17 断言：isEmptyBrowserState 不得纳入 addressValue —— 守住它的位置：const isEmptyBrowserState —— 改错故障：用户一开始输入就露出空白 webview。
// INV-18 断言：加载失败与 guest 崩溃必须区分 —— 守住它的位置：handleDidFailLoad 与 handleRenderProcessGone —— 改错故障：普通重试无法恢复已崩溃的 guest。
// INV-19 断言：ERR_ABORTED（-3）必须忽略 —— 守住它的位置：handleDidFailLoad 与 loadURL catch —— 改错故障：正常导航被打断时误报加载失败。
// INV-20 断言：权限请求必须按 guestWebContentsId 归属过滤 —— 守住它的位置：permissionGuestWebContentsId —— 改错故障：后台 tab 的权限弹窗显示到前台。
// ==========================================================================
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { EmbeddedBrowserPermissionPrompts } from "@/browser-use/EmbeddedBrowserPermissionPrompts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  displayBrowserUrl,
  isDefaultBrowserOpenableUrl,
  isRecoverableBrowserGuestExitReason,
  normalizeBrowserUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

// [契约] 外部导航回执的唯一句柄：resolve 只能在替代 guest 真正接管 loadURL 后调用；
// url 与 resolve 必须成对保存，用于并发覆盖时判断哪个意图已被取消；
// 结构不变量：完成即从 pendingGuestNavigationCompletionRef 摘除，避免二次 resolve；
// 不要把重试计数塞进来：重试属于 guest 生命周期，不属于单次导航意图；
// 该类型只存在于渲染进程，不跨 IPC。
type PendingGuestNavigationCompletion = {
  resolve: () => void;
  url: string;
};

/**
 * UnifiedBrowserView —— 统一浏览器视图（`<webview>` + CDP-on-guest 架构）。
 *
 * 网页像素由 renderer 内的 `<webview>` guest 直接渲染（DOM 内合成，可被 DOM 浮层覆盖，
 * 彻底解决 WebContentsView 原生层遮挡菜单的问题）。human 的导航/前进后退/刷新/元素拾取
 * 直接调用 webview 方法（低延迟、无握手依赖）；chrome 状态由 webview 事件驱动。
 *
 * 同时在 did-attach 时把 guest 的 webContentsId 上报给 main（browserViewAttachGuest），
 * 让 main 能给该 guest 挂 CDP（webContents.debugger），供 agent 通过协议控制这个 tab。
 *
 * chrome 复用 EmbeddedBrowserPaneParts 的 BrowserToolbar；
 * URL 归一化 / 未挂载兜底复用 embeddedBrowserHelpers。
 */
// [契约] props 里 isVisible / isSelected / isCurrentTask 三者正交，不可互相推导；
// isSelected 默认取 isVisible，但折叠时仍要保留 selected，故不能合并成一个布尔；
// workspaceKey/sessionId 是 tab 创建时冻结的归属，禁止用当前 active task 回填；
// human 专属 props（initialHumanViewportPreference 等）在 agent 分支必须保持 undefined；
// 新增 props 若参与 main 侧路由，必须同时进入 residency 上报与 guest attach 指纹。
export function UnifiedBrowserView({
  browserKey,
  onOpenPermissionSettings,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: {
  /** 受控视图 key（= tab.id / sessionId，agent 定位该 tab 用）。 */
  browserKey: string;
  /** 地址栏站点设置入口：打开该站点的权限设置标签页。 */
  onOpenPermissionSettings?: (origin: string) => void;
  /** 预算恢复时 guest 创建后立即撤销 bootstrap src，首次有效导航由 main 独占。 */
  isResidencyRestore?: boolean;
  /** pane 是否可见（激活 + 展开）。隐藏时仅从布局里移除，不卸载 webview，保住网页与历史。 */
  isVisible: boolean;
  /** tab strip 选中态与 panel 展示态正交；折叠时仍保留 selected。 */
  isSelected?: boolean;
  /** 当前 task 的 tab 用于 main 的 eviction tier。 */
  isCurrentTask?: boolean;
  /** 挂载时导航到的初始/恢复 URL（human tab 恢复态）。 */
  initialUrl?: string | null;
  /** tab shell 当前 favicon；随 residency report 持久化。 */
  faviconUrl?: string | null;
  /** 外部请求把该 tab 导航到某 URL（{id,url}）；消费后回执 onNavigationRequestHandled。 */
  navigationRequest?: { id: string; url: string } | null;
  /** 当前 URL 变化回传（human tab URL 持久化）。 */
  onUrlChange?: (url: string) => void;
  /** 页面标题/favicon 变化回传（驱动 tab 标签）。 */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** navigationRequest 消费完回执。 */
  onNavigationRequestHandled?: (requestId: string) => void;
  /** 元素选择加入聊天所需的工作区路径（human 分支传入；agent 分支可不传）。 */
  workspacePath?: string;
  /** 元素选择上下文归属的工作区标识（human 分支传入）。 */
  workspaceIdentity?: string;
  /** browser-use tab 创建时冻结的身份 scope；存在时优先于当前 workspace ambient props。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  /** tab 创建时冻结的对话归属；不得用 dom-ready 到达时的 active task 回填。 */
  sessionId?: string;
  residencyGeneration?: number;
  /** 与 tab 鼠标图标共用的 operation deadline；仅 browser-use tab 传入。 */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /** 截图前临时保持后台 guest 的真实布局；不改变任何 active/focus 语义。 */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /** human 空白 tab 延迟创建 guest；agent/browser-use 必须保持创建期 attach。 */
  deferEmptyGuest?: boolean;
  /** 仅 human Browser surface 传入；Agent Browser Use 必须保持 undefined。 */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** 只接收 human UI 主动变更；Agent viewport event 不得调用。 */
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
}): React.JSX.Element {
  // [依赖] 平台能力全部经 usePlatform 注入，Web 端没有 browserView 系列时返回 undefined；
  // 所有 browserView 调用都必须判空，而不是假设桌面端一定具备；
  // 不要直接读 window.zcode：Web 与测试环境没有该对象，会直接抛错；
  // platform 身份变化会让 reportBrowserGuest 重建，进而触发一次重报；
  // 不要缓存 platform 的成员方法，跨平台实现可能整体替换。
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();

  // [契约] addressValue 是用户草稿，不是事实来源；事实是 browserState.currentUrl；
  // 输入过程中不得回写 currentUrl，否则空置态与持久化会跟着草稿抖动；
  // 只有 syncBrowserState 与 openUrl 会覆盖 addressValue，这是仅有的两处写入；
  // 受控 input 必须允许非法 URL 中间态，校验只发生在提交时；
  // 不要把 addressValue 纳入 isEmptyBrowserState，否则一输入就露出空 webview。
  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE);
  const hasInitialNavigation = Boolean(initialUrl && initialUrl !== DEFAULT_BROWSER_URL);
  // [契约] hasNavigated 为 true 代表用户已确认过一次导航，不允许回退为 false；
  // 它驱动 shouldMountWebview，回退会导致 webview 卸载，guest 与历史一起丢；
  // 初值取自 initialUrl 是否为真实地址，避免恢复态先闪一帧空置态；
  // 重建 guest 时用 Boolean(recoveryUrl) 重置，恢复 URL 缺失才允许回到空置；
  // 不要用 browserState.currentUrl 推导它：about:blank 与失败 URL 会误判。
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  // 权限气泡的 tab 归属过滤：attach/dom-ready 后读取 guest webContents id；
  // 读不到时保持 undefined（组件按「请求缺归属 id 则兜底渲染」处理）。
  // [并发] 该 id 只在 attach/dom-ready 后可读，读取本身必须走 safeWebviewCall；
  // 读不到时保持 undefined 是契约：组件按请求缺归属兜底渲染，而不是全部隐藏；
  // 它必须与 reportBrowserGuest 里的 webContentsId 同源，不可各读一次；
  // 该 state 变化只影响权限弹窗过滤，不得触发 guest 重建；
  // 依赖 isReady 是为了在 ready 翻转后重新取 id。
  const [permissionGuestWebContentsId, setPermissionGuestWebContentsId] = useState<
    number | undefined
  >(undefined);
  useEffect(() => {
    if (!webview || typeof webview.getWebContentsId !== "function") return;
    const id = safeWebviewCall(() => webview.getWebContentsId(), 0);
    setPermissionGuestWebContentsId(id > 0 ? id : undefined);
  }, [webview, browserState.isReady]);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  // [资源] guest zoom 是 Electron 侧共享状态，写入失败只记 debug，不能冒泡；
  // 必须先判 setZoomFactor 存在：老版本 webview 没有该方法；
  // 回调里的错误只能降级为日志，此时页面已在渲染，抛错无处可去；
  // 该函数依赖为空数组，身份稳定，才能安全进入其他 useCallback 依赖；
  // 不要在内部加防抖：缩放与布局必须同帧对齐。
  const setGuestZoomFactor = useCallback((target: ElectronWebviewTag, targetZoomFactor: number) => {
    if (typeof target.setZoomFactor !== "function") return;
    safeWebviewCall(
      () => target.setZoomFactor(targetZoomFactor),
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的 zoom 同步", {
          error: error instanceof Error ? error.message : String(error),
          targetZoomFactor,
        });
      },
    );
  }, []);
  // [契约] 只在 viewport 同步完成后把 guest zoom 归一到 1；
  // 它作为 onViewportSynchronized 传给 useResponsiveBrowserViewportControl；
  // 若改成每次 render 都调用，会与用户的自由缩放互相覆盖；
  // 归一化不等于恢复用户比例，恢复由 shouldNormalizeGuestZoom 的 false 分支负责；
  // webview 为空时静默返回，不要顺手创建。
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    // [资源] browserRegionRef 同时服务滚轮链与尺寸观测，必须挂在滚动容器上；
    // 它由 useBrowserResizeOperationWarning 创建，不要在本组件另建 ref；
    // 挂错节点会让 resize 观测失效，进而静默停掉 viewport 同步；
    // 滚轮链只在 responsive 模式下接管，自由尺寸要保持原生滚动；
    // ref 身份在组件生命周期内稳定，可以安全进依赖。
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // MediaRecorder 录到的是 renderer 中实际合成的 WebView surface。若沿用用户的 Fit/50%
  // 预览，后续 canvas 只能把低分辨率源放大到目标尺寸。录制 lease 因此派生一份 100% surface，
  // 不修改用户的自由尺寸、缩放选择或持久状态；request 释放后 React 会自然恢复原预览。
  // [权衡] 录制需要 100% surface：MediaRecorder 录的是合成后像素，Fit 预览放大会糊；
  // 因此录制 lease 期间派生一份 unscaled 布局，且不写回用户偏好；
  // 只有 surfaceScaleMode 为 unscaled 时才打开，普通截图走临时 fit；
  // 不能改为读 isResponsiveMode：普通后台 tab 截图同样需要临时布局；
  // request 释放后依赖变化自然恢复原预览。
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // 普通后台 tab 的 fallback viewport 可能大于窗口；仅传 Fit 不会启用布局，
  // webview 随准备层缩小后永远无法 ready。截图期间统一派生请求尺寸的 responsive 布局，
  // release 后恢复用户模式与尺寸，不写偏好，也不重建 guest。
  // [权衡] 截图期间强制进入 responsive 布局：普通 fallback viewport 可能大于窗口；
  // 只传 Fit 而不启用布局时，webview 被准备层缩小后永远等不到 ready；
  // 它是派生值，不能写回 isResponsiveMode，否则 release 后残留自由尺寸；
  // 传给滚轮链的必须是这个派生值，否则截图期间滚轮链不接管；
  // 不要把它传给偏好持久化路径。
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // 普通截图只临时改变布局；fallback metrics 的 guest zoom 由 main 管理。
  // 若把临时 Fit 当作用户模式切换，release 会错误恢复 desktop zoom，破坏后续 CDP 坐标。
  // [契约] 自由尺寸或录制 unscaled 时必须把 guest zoom 固定为 1；
  // 普通截图（临时 fit）不在此列：fallback metrics 的 guest zoom 由 main 管理；
  // 若把临时 fit 当作用户模式切换，release 会错误恢复 desktop zoom，破坏 CDP 坐标；
  // 该布尔同时驱动 zoom effect 的进入与退出分支，两侧必须成对维护；
  // 不要用 isResponsiveMode 直接替换它。
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // 固定 100%/200% 预览不会随截图画布缩小，Windows 高 DPI 的 guest raster
  // 仍可能被宿主可见范围裁剪。普通截图临时 Fit，释放后恢复用户比例；录制保持 unscaled。
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  // dom-ready 前排队的导航 URL；webview 就绪后统一 loadURL（<webview> 的 src 只在首挂生效）。
  // [并发] dom-ready 前的导航意图只在这里排队，且 webview 就绪后只消费一次；
  // 消费后必须立即置 null，否则下一次 dom-ready 会重复 loadURL；
  // src 属性只在首挂生效，所以这里必须走命令式 loadURL；
  // 重建 guest 时用它写入恢复 URL，是跨 generation 传递意图的唯一通道；
  // 不要改成 state：写入不应触发渲染刷新。
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // 已消费的 initialUrl / navigationRequest，避免重复导航。
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  // [契约] 外部导航请求按 id 去重，同一请求不得重复导航；
  // 先记录 id 再发起 openUrl，保证 openUrl 抛错也不会无限重试同一请求；
  // 该 ref 只增不减：请求 id 由上层单调分配，不需要清理；
  // 不要把 url 也放进来比较：同一 id 的 url 变化属于上层错误；
  // 回执由 openUrl 的 finally 负责，本 ref 不参与回执。
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  // [并发] 崩溃恢复必须单飞：置 true 后到替代 guest 完成导航前不再进入；
  // dom-ready 与 did-stop-loading 都会清 false，缺一处都会卡住后续恢复；
  // 不要在恢复失败时直接 return 而不复位，否则该 tab 永久不再自动恢复；
  // 用 ref 而非 state：它只做互斥，不驱动渲染；
  // 重建路径与崩溃路径共用它，保证同一时刻只有一次重建。
  const guestRecoveryInProgressRef = useRef(false);
  // 失败 guest 接到外部导航时，回执必须等替代 guest 实际接管 loadURL 后再完成。
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // guestId 上报去重：did-attach 与 dom-ready 会连续触发；只有 guest 或 active 状态变化才重报。
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // guest 销毁归因打点：线上主进程 UAF（EXC_BAD_ACCESS at
  // 0x10，DevToolsSession 在途通知访问已析构 client）发生前，main 日志只能看到
  // 「cdp still attached on destroyed guest」，无法区分 webview 节点是被谁卸载的：
  // residency 挂起换壳 / 父级整树卸载 / shouldMountWebview 条件翻转 / generation 换代。
  // ref(null) 是 React 卸载 <webview> 节点的第一现场；配合组件卸载打点与挂起壳 ack 日志，
  // 可把销毁者与时序钉死。仅在 webview 实际存在过后才打，量级与 tab 生命周期一致。
  // [资源] `webviewTeardownProbeRef` 只做销毁归因，不参与任何业务分支判断。
  // browserKey/generation/hasNavigated 必须在 render 期实时刷新；
  // hadWebview 只在 ref 回调里翻转，用于区分换代重建与整树卸载；
  // 打点必须落在真实卸载的第一现场，晚了就拿不到原始归因；
  // 不要把它接入 state，否则每次导航都会多一轮渲染。
  const webviewTeardownProbeRef = useRef({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  // [资源] 只有 webview 实际存在过之后才打点，量级与 tab 生命周期一致；
  // 日志必须带 guestReported 快照，才能与 main 侧 CDP 记录对上；
  // 不要在这里做 await 或网络上报：它位于卸载同步路径上；
  // trigger 取值有限且稳定，新增触发点要同步排查面板；
  // 日志级别用 info，这是线上 UAF 归因的唯一线索。
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview 节点离开 DOM（guest 将被销毁）", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  // [契约] 回调走 ref，避免父组件内联箭头导致 effect 每次重建；
  // 必须每帧覆盖，不能只在 effect 里更新，否则早于 effect 的事件会读到旧值；
  // title 与 favicon 走两条路径：favicon 由 ref 阶段的专用监听处理；
  // 不要在本组件缓存 metadata：持久化由上层 residency 上报负责；
  // 调用一律用可选链，human 与 agent 分支都可能不传。
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  // [并发] 只有当前 pending 与传入句柄严格相等时才 resolve，防止误结束新意图；
  // 不传参时取 ref 当前值，用于卸载与二次失败等取消路径；
  // resolve 前必须先置空 ref，避免重入导致二次 resolve；
  // 不要在 resolve 之后写状态：上层会立刻继续自己的流程；
  // 依赖为空数组，保证在 effect 与事件回调里身份稳定。
  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined ? pendingGuestNavigationCompletionRef.current : completion;
      if (!pendingCompletion || pendingGuestNavigationCompletionRef.current !== pendingCompletion) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  // [并发] 同一 view 同时只保留一个外部导航意图；
  // 新请求要显式取代旧请求并先 resolve 旧的，避免被覆盖的 Promise 永远悬空；
  // resolve 只存进 ref，不在这里 await，由替代 guest 的 dom-ready 触发；
  // 不要用定时器兜底取消：那会把慢误判成失败；
  // 本函数只服务 source 为 request 的导航。
  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // 同一个 view 同时只保留一个外部导航意图；若未来入口允许并发，新请求明确取代旧请求，
    // 先结束旧回执，避免被覆盖的 Promise 永久悬空。
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // view 被关闭时属于明确取消，不能让上层 navigationRequest 永久等待。
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // 组件卸载意味着 <webview> 必然离开 DOM：residency 挂起换壳 / 父级面板关闭 /
      // 会话切换整树重挂。与 ref-null 打点的时间差可用于区分「换代重建」与「真卸载」。
      if (webviewTeardownProbeRef.current.hadWebview || lastReportedGuestRef.current) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  // [并发] 去重指纹必须含 active、webContentsId、workspaceKey、remoteSessionId、sessionId 与 residencyGeneration；
  // 少一个维度就会在换 owner 或换代后不重报，main 绑到旧会话；
  // 指纹相同直接返回，避免每次 render 反复重绑 CDP；
  // 上报失败且 recoveryRequested 时必须清去重标记并自增 nonce，等待 main 重放；
  // workspaceKey 优先于 workspaceIdentity 优先于 workspacePath，顺序不可换。
  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(() => webview.getWebContentsId(), 0);
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = { active, webContentsId, scopeFingerprint };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey ? { workspaceKey: effectiveWorkspaceKey } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // 旧 preload 仍可能只返回 undefined；成功 attach 的兼容语义保持不变。
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn("[browser-use] main 拒绝 guest attach，等待按 owner scope 重绑", {
            browserKey,
            reason: result.reason,
            recoveryRequested: result.recoveryRequested,
          });
          // main 会重放 BrowserViewReady；清掉去重标记，确保同一个 webContentsId 也能重新上报。
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] 上报 guest webContentsId 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // [资源] 重建 guest 前必须先让 main 断开旧 guest 的 CDP 并拿到 ACK；
  // 未确认断开就换 generation，会让 DevToolsSession 在途通知访问已析构 client（UAF）；
  // guest 从未上报时直接返回 true：没有 native session 可断；
  // 返回 false 表示放弃本次重建，调用方必须复位恢复标记；
  // 失败只 warn 不抛：调用方用布尔决定是否继续。
  const detachBrowserGuestBeforeReplacement = useCallback(async (): Promise<boolean> => {
    const lastReported = lastReportedGuestRef.current;
    // guest 尚未上报给 main 时就没有 native CDP session，Web 端也不会暴露该桌面能力。
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn("[browser-use] main 未确认旧 guest CDP 已断开，取消 webview 重建", {
          browserKey,
          webContentsId: lastReported.webContentsId,
        });
      }
      return detached;
    } catch (error) {
      logger.warn("[browser-use] 请求 main 断开旧 guest CDP 失败，取消 webview 重建", {
        browserKey,
        error: error instanceof Error ? error.message : String(error),
        webContentsId: lastReported.webContentsId,
      });
      return false;
    }
  }, [browserKey, platform]);

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // 传输无关出口：webview 就绪时走 <webview>.executeJavaScript(script, true)；
    // 尚为 null 时返回 cancelled（合法选择结果），保持 no-op。
    // [契约] 元素拾取的执行出口：webview 就绪时走 executeJavaScript(script, true)；
    // webview 为 null 时返回 cancelled，这是合法选择结果而非错误；
    // 不要在这里抛错：拾取流程把 cancelled 当作用户放弃；
    // workspaceIdentity 优先用冻结的 workspaceKey，避免会话切换后归属漂移；
    // executeJavaScript 的第二个参数必须为 true，否则拿不到结构化结果。
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- 从 webview 同步 chrome 状态（url/前进后退/标题）----
  // [失败路径] 所有 webview 同步读取都必须走 safeWebviewCall，未 attach 时会抛；
  // onDetached 只记 debug：dom-ready 前的正常时序不该产生 warn 噪音；
  // currentUrl 取不到时回退 DEFAULT_BROWSER_URL，保证地址栏不空；
  // 只有非默认 URL 才更新 lastRestorableUrlRef 与回传 onUrlChange；
  // 页面 URL 不可信，只用于展示与持久化，不参与任何执行路径。
  const syncBrowserState = useCallback((target: ElectronWebviewTag) => {
    // guest 在 dom-ready 前 / 导航 churn / 重附过程中未 attach，同步方法会抛
    // "must be attached to the DOM"，统一走 safeWebviewCall 兜底，避免冒泡到 window.onerror。
    const onDetached = (error: unknown) => {
      logger.debug("[browser-use] 跳过未就绪 webview 的状态同步", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const currentUrl =
      safeWebviewCall(() => target.getURL(), "", onDetached) || DEFAULT_BROWSER_URL;
    const canGoBack = safeWebviewCall(() => target.canGoBack(), false, onDetached);
    const canGoForward = safeWebviewCall(() => target.canGoForward(), false, onDetached);
    const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      lastRestorableUrlRef.current = currentUrl;
    }
    setAddressValue(displayBrowserUrl(currentUrl));
    setBrowserState((prev) => ({
      ...prev,
      canGoBack,
      canGoForward,
      currentUrl,
      isReady: true,
      title,
    }));
    onPageMetadataChangeRef.current?.({ title: title || undefined });
    // 页面 url 不可信：仅用于展示与 tab 持久化，不参与任何执行路径。
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      onUrlChangeRef.current?.(currentUrl);
    }
  }, []);

  // ---- webview 事件接线 + did-attach 上报 guestId ----
  useEffect(() => {
    if (!webview) return;

    // [契约] did-attach 是完整历史恢复的最早时机，必须在这里上报 guestId；
    // 等到 dom-ready 时 about:blank 已提交，只能退化为 URL 重载；
    // isResidencyRestore 时要在 attach 后立即 removeAttribute(src)；
    // 两个动作顺序不可换：先撤销 src 再上报；
    // 上报使用 isSelected 而非 isVisible，eviction tier 看的是选中态。
    const handleDidAttach = () => {
      // navigationHistory.restore 只能用于从未加载过页面的新 guest。若等到
      // dom-ready 才上报，默认 about:blank 已提交，只能退化为 URL 重载；attach 后立即上报，
      // 让 main 有机会在首次导航提交前恢复完整 Chromium pageState。
      if (isResidencyRestore) {
        // `<webview>` 必须先有 src 才会创建 guest，但保留属性会在 attach 后再次提交
        // about:blank 并中断 main 的 history restore。guest 已存在后立刻撤销 bootstrap src。
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    // [并发] 有 pendingUrl 时执行完必须 return，不能继续走 syncBrowserState；
    // 否则会用旧 URL 覆盖刚发起的地址栏与 tab 状态；
    // 回执必须在 finally 里完成，只有替代 guest 真的尝试过 loadURL 才算接管；
    // ERR_ABORTED 属于被后续导航打断，不得展示为加载失败；
    // 无 pending 时才复位恢复标记并同步 chrome 状态。
    const handleDomReady = () => {
      // Electron/Chromium 会把主窗口页面 zoom 继续传播到 guest；仅补偿外层
      // transform 时，guest innerWidth/DPR 仍会变化。自由尺寸必须把 guest zoom 固定为 1，
      // 普通模式仍交给 Electron 自然传播，避免主动改写网页 zoom。
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach 是完整历史恢复的最早时机；dom-ready 保留为 Electron 版本兼容兜底。
      reportBrowserGuest(isSelected);

      // <webview> 的 src 属性只在首挂生效，后续导航统一走命令式 loadURL：消费排队 URL。
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await webview.loadURL(pending);
          } catch (loadError: unknown) {
            const message = loadError instanceof Error ? loadError.message : String(loadError);
            if (!message.includes("ERR_ABORTED")) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
                isLoading: false,
              }));
            }
          } finally {
            // 只把外部请求写入 pendingUrl 后就回执是不够的：失败 guest 永远不会消费它。
            // 替代 guest 到达 dom-ready 并完成一次 loadURL 尝试，才算真正接管该导航意图。
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = () => {
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
    };

    // [失败路径] 必须过滤子帧失败与 -3（ERR_ABORTED，被后续导航打断）；
    // event.validatedURL 可能为空，回退到 webview.getURL 再回退默认页；
    // 错误态要写 loadErrorCode，供界面区分证书类错误与普通网络错误；
    // 同步写 addressValue 是为了让用户看到实际失败地址；
    // 这里必须复位 guestRecoveryInProgressRef，否则崩溃恢复会永久卡住。
    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // 忽略子帧失败与 -3(ERR_ABORTED，被后续导航打断)。
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] 页面加载失败", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      setBrowserState((prev) => ({
        ...prev,
        currentUrl: event.validatedURL || prev.currentUrl,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          { message: event.errorDescription },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL || safeWebviewCall(() => webview.getURL(), "") || DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    // [资源] 不可恢复的退出必须给 guestFailure，界面才会展示重建入口而不是普通重试；
    // 可恢复路径必须先 detach 并拿到 ACK，再递增 generation；
    // 递增前要清空 request/initial/guest 三个去重 ref，避免新 guest 被旧键拦截；
    // 恢复中要清地址栏、导航标记与错误态，并用 recoveryUrl 决定 isLoading；
    // 提前 completePendingGuestNavigation 会让上层在 guest 未就绪时就继续。
    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn("[browser-use] guest renderer 异常退出且不可自动恢复", {
          browserKey,
          exitCode,
          reason,
        });
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // renderer 退出后需要重建整个 guest，单纯重新导航无法恢复。
          // guestFailure 让界面优先展示重建入口，而不是普通页面加载错误的重试入口。
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // 替代 guest 若再次启动失败，已经形成明确失败结果；结束等待，让上层不再永久挂起请求。
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn("[browser-use] guest renderer 异常退出，原位重建并恢复最近 URL", {
        browserKey,
        exitCode,
        reason,
        recoveryUrl,
      });
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // renderer 观察到了 guest 退出，但 main 的 render-process-gone 监听并非
        // 每次都先到达。必须等待上面的 CDP detach ACK 后再递增 key；否则 React 卸载旧
        // `<webview>` 会让 Electron DevToolsSession 在在途通知中访问已析构 client。
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isSelected,
    platform,
    reportBrowserGuest,
    setGuestZoomFactor,
    syncBrowserState,
    webview,
  ]);

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = wasResponsiveModeRef.current;
    wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // 只在退出自由尺寸时恢复当前应用 zoom；普通浏览期间继续沿用 Electron 原生传播。
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [desktopZoomFactor, shouldNormalizeGuestZoom, setGuestZoomFactor, webview]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    const restoreUrl =
      browserState.currentUrl && browserState.currentUrl !== DEFAULT_BROWSER_URL
        ? browserState.currentUrl
        : (lastRestorableUrlRef.current ?? null);
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // favicon 不能只停留在 renderer tab state：residency 上报遗漏后，
        // 挂起与冷启动恢复得到的 shell 必然退回地球图标。
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] 上报 tab residency 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] 显式导航触发重建失败的 guest renderer", {
        browserKey,
        recoveryUrl,
        trigger,
      });
      setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
      setHasNavigated(Boolean(recoveryUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack: false,
        canGoForward: false,
        currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
        errorMessage: null,
        loadErrorCode: null,
        guestFailure: null,
        isLoading: Boolean(recoveryUrl),
        isReady: false,
      }));
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [browserKey, cancelWebElementPicking, detachBrowserGuestBeforeReplacement],
  );

  // ---- 导航（human 直驱 webview.loadURL；未就绪则排队到 dom-ready 消费）----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // 地址非法与上一次的网络失败无关；不清空会让错误态继续挂着旧的证书指引。
          loadErrorCode: null,
        }));
        return;
      }

      // 外部请求若只能排队给尚未就绪的 guest，必须等 dom-ready 真正接管 loadURL 后再回执；
      // 地址栏/恢复导航没有上游消费确认，不需要等待该生命周期信号。
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // launch-failed 后 isReady=false，只把地址栏 URL 写进 pendingUrl 不够：
      // 失效 guest 永远不会再触发 dom-ready，失败态与排队导航都会永久卡住。
      if (browserState.guestFailure && (source === "toolbar" || source === "request")) {
        lastRestorableUrlRef.current = nextUrl;
        onUrlChange?.(nextUrl);
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // 去重：外部 request 与 restore 可能同拍给出同一 URL，连续 loadURL 会触发 ERR_ABORTED(-3)。
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      lastRestorableUrlRef.current = nextUrl;
      onUrlChange?.(nextUrl);
      setBrowserState((prev) => ({ ...prev, errorMessage: null, loadErrorCode: null }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await webview.loadURL(nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED")) return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
          isLoading: false,
        }));
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      onUrlChange,
      rebuildBrowserGuest,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- 挂载时导航到初始/恢复 URL（human tab 恢复态）----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    lastRestorableUrlRef.current = initialUrl;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [browserState.currentUrl, initialUrl, openUrl]);

  // ---- 外部导航请求（{id,url}）：导航并回执 ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id) return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [navigationRequest, onNavigationRequestHandled, openUrl]);

  // ---- 工具/导航按钮（isReady 门控 + safeWebviewCall 兜底点击瞬间 detach 竞态）----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] 跳过未就绪 webview 的操作", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = webview.getURL();
      // 安全边界：系统默认浏览器入口只允许 Web URL 和 file URL，仍禁止 about/data 等内联协议。
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [browserState.isReady, intl, toggleWebElementPicking, webview]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener("page-favicon-updated", current.listener);
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
        };
        // favicon 是可能只触发一次的 guest 事件；等 useEffect 才接线时，
        // 它可能已在 webview ref 提交与 effect 执行之间发出。ref 阶段同步监听可封住该窗口。
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // generation 换代（受控重建）与父级卸载都会先走到这里；紧随其后若有新节点 ref
        // 回调则是换代，否则是整树/条件卸载。销毁归因打点见 webviewTeardownProbeRef 注释。
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [logWebviewTeardown],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(lastRestorableUrlRef.current, "manual-retry");
  }, [rebuildBrowserGuest]);

  // 加载失败只是这次导航被拒，guest 本身还活着：重走 openUrl 即可，不必重建 guest。
  const handleRetryLoad = useCallback(() => {
    const retryUrl = lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // 把 addressValue 草稿纳入空置态判断后，用户只要开始输入、尚未回车，
  // 就会提前隐藏空置态并裸露 webview。空置态只由已确认导航与加载/错误状态决定。
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest || isResidencyRestore || hasNavigated || hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (previous && !shouldMountWebview && webviewTeardownProbeRef.current.hadWebview) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview]);

  let permissionOrigin: string | null = null;
  try {
    const url = new URL(browserState.currentUrl);
    if (["http:", "https:"].includes(url.protocol)) permissionOrigin = url.origin;
  } catch {
    /* 空白页没有站点权限。 */
  }

  // inactive 的 display:none 会让 Electron 保留旧 compositor surface，后台截图会按旧表面平铺。
  // prepare 期间的 flex 只用于合成；外层 inert、pointer-events-none 和 aria-hidden 隔离交互与 a11y。
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "relative h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        permissionControl={
          permissionOrigin ? (
            <BrowserSiteSettingsEntry
              origin={permissionOrigin}
              onOpenSettings={onOpenPermissionSettings}
            />
          ) : null
        }
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {/* 权限弹窗层：只在可见 tab 挂载（多 tab 共享 store，避免重复渲染与
          后台请求误显示）；permission 请求再按 guest 归属过滤到发起 tab。 */}
      {isVisible ? (
        <EmbeddedBrowserPermissionPrompts guestWebContentsId={permissionGuestWebContentsId} />
      ) : null}
      {isResponsiveMode ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      <BrowserViewportSurface
        browserRegionRef={browserRegionRef}
        browserState={browserState}
        desktopZoomFactor={desktopZoomFactor}
        isResidencyRestore={isResidencyRestore}
        formatMessage={intl.formatMessage}
        isEmptyBrowserState={isEmptyBrowserState}
        isComposed={isVisible || shouldComposeSurface}
        isResponsiveMode={effectiveIsResponsiveMode}
        isViewportEmulated={
          effectiveIsResponsiveMode && screenshotSurfaceRequest?.viewportMode !== "natural"
        }
        onRetryGuest={handleRetryGuest}
        onRetryLoad={handleRetryLoad}
        onViewportResize={notifyBrowserViewportResize}
        onViewportSizeChange={handleResponsiveViewportSizeChange}
        onWebviewRef={handleWebviewRef}
        shouldMountWebview={shouldMountWebview}
        showResizeWarning={showResizeWarning}
        webviewGeneration={webviewGeneration}
        viewportSize={effectiveViewportSize}
        viewportZoom={effectiveViewportZoom}
      />
    </div>
  );
}
