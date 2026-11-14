// INV-01 组件不持有订阅：守住位置 无副作用调用；改错故障 每次渲染重建监听。
// INV-02 进程级失败优先：守住位置 失败判定顺序；改错故障 同屏出现两种错误说明。
// INV-03 失败时不再渲染加载错误：守住位置 空值归一；改错故障 错误文本重复。
// INV-04 视口为受控参数：守住位置 尺寸与缩放入参；改错故障 内部状态与宿主不一致。
// INV-05 页面节点稳定挂载：守住位置 键只随生成号变化；改错故障 每次缩放都丢网页历史。
// INV-06 自由尺寸不换父层级：守住位置 仅改样式；改错故障 页面被重建并回到首页。
// INV-07 空态可隐藏页面：守住位置 可见性内联样式；改错故障 新标签闪白一帧。
// INV-08 允许弹窗必须在创建时声明：守住位置 静态属性；改错故障 新窗口被静默拦截。
// INV-09 子框架需要显式声明：守住位置 创建参数；改错故障 嵌套页面缺少预加载。
// INV-10 布局补偿只在模拟模式：守住位置 缩放条件；改错故障 自然视口被二次缩放。
// INV-11 补偿尺寸用百分比：守住位置 尺寸表达式；改错故障 固定像素在高分屏失真。
// INV-12 缩放为一则不加变换：守住位置 不等于判断；改错故障 出现恒等变换层。
// INV-13 页面底色固定为白：守住位置 内联背景；改错故障 深色主题下出现灰底。
// INV-14 警告条不拦截点击：守住位置 指针事件类；改错故障 警告遮住操作区域。
// INV-15 警告条自带语义角色：守住位置 状态角色与礼貌播报；改错故障 读屏用户收不到提醒。
// INV-16 ref 回调保持引用透明：守住位置 只转发；改错故障 父层清理拿不到原节点。
// INV-17 三种空态互斥：守住位置 三元链；改错故障 同屏出现空态与失败态。
// INV-18 文案全部注入：守住位置 格式化回调；改错故障 组件内出现硬编码文案。
//
// 模块职责：BrowserViewportSurface 是内嵌浏览器视口外壳，只做响应式尺寸补偿与空态分流并决定 webview 是否挂载。
// 状态所有权：无内部状态；尺寸、缩放、失败态与回调全部由宿主注入。
// 阅读顺序：先看派生常量，再看 ref 转发，最后看警告条与视口主体。
import { useCallback, type RefObject } from "react";
import { BROWSER_VIEW_RESTORE_BOOTSTRAP_URL, type BrowserViewportSize } from "@zcode/shared";
import { TID_BROWSER_WEBVIEW } from "@zcode/shared/test-ids";
import { TriangleAlertIcon } from "lucide-react";
import { ResponsiveBrowserViewport } from "@/browser-use/ResponsiveBrowserViewport.js";
import {
  resolveResponsiveBrowserGuestLayout,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { cn } from "@/components/lib/utils.js";
import {
  BrowserEmptyState,
  BrowserGuestFailureState,
  BrowserLoadErrorState,
} from "@/EmbeddedBrowserPaneParts.js";
import {
  DEFAULT_BROWSER_URL,
  isCertificateBrowserLoadErrorCode,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

// BrowserViewportSurface 只做布局与状态选择，不持有订阅；三个重试回调与尺寸、缩放均由宿主注入。
// webviewGeneration 变化必须重建页面，shouldMountWebview 决定是否挂载，isViewportEmulated 缺省跟随 isResponsiveMode。
export function BrowserViewportSurface({
  browserRegionRef,
  browserState,
  desktopZoomFactor,
  isResidencyRestore,
  formatMessage,
  isEmptyBrowserState,
  isComposed,
  isResponsiveMode,
  isViewportEmulated = isResponsiveMode,
  onRetryGuest,
  onRetryLoad,
  onViewportResize,
  onViewportSizeChange,
  onWebviewRef,
  shouldMountWebview = true,
  showResizeWarning,
  webviewGeneration,
  viewportSize,
  viewportZoom,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  browserState: BrowserState;
  desktopZoomFactor: number;
  isResidencyRestore: boolean;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isEmptyBrowserState: boolean;
  isComposed: boolean;
  isResponsiveMode: boolean;
  isViewportEmulated?: boolean;
  onRetryGuest: () => void;
  onRetryLoad: () => void;
  onViewportResize: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onWebviewRef: (node: ElectronWebviewTag | null) => void;
  shouldMountWebview?: boolean;
  showResizeWarning: boolean;
  webviewGeneration: number;
  viewportSize: BrowserViewportSize;
  viewportZoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { guestFailure } = browserState;
  // guest 进程级失败优先于 load error：前者连画面都没有，后者只是这次导航被拒。
  const loadError = !guestFailure && browserState.errorMessage ? browserState.errorMessage : null;
  // 自然 viewport 没有 metrics 固定逻辑尺寸，临时 responsive frame 不代表 guest 可以扩张。
  // 布局缩放只在 isViewportEmulated 时生效：自然视口不做尺寸补偿，缩放系数为 1 时不加 transform。
  // 需要补偿时容器改成绝对定位，宽高取 calc(100% * layoutScale)。
  const responsiveGuestLayout = resolveResponsiveBrowserGuestLayout(desktopZoomFactor);
  const responsiveGuestLayoutScale = isViewportEmulated ? responsiveGuestLayout.layoutScale : 1;
  const responsiveGuestTransformScale = isViewportEmulated
    ? responsiveGuestLayout.transformScale
    : 1;
  const needsResponsiveGuestLayout = isResponsiveMode && responsiveGuestLayoutScale !== 1;
  const responsiveGuestLayoutSize = `calc(100% * ${responsiveGuestLayoutScale})`;
  // ref 回调只做转发，不加额外逻辑。
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      onWebviewRef(node);
    },
    [onWebviewRef],
  );

  // 渲染优先级：警告条悬浮在顶部，下面是 ResponsiveBrowserViewport；空态与失败态共用父层，页面节点仅在 shouldMountWebview 时出现。
  return (
    <div
      ref={browserRegionRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {showResizeWarning ? (
        <div
          role="status"
          aria-live="polite"
          data-browser-resize-warning="visible"
          className="pointer-events-none absolute top-2 right-2 left-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-popover-border bg-popover px-3 py-2 text-ui-base font-medium text-foreground shadow-md"
        >
          <span
            aria-hidden="true"
            data-browser-resize-warning-accent="visible"
            className="h-5 w-0.5 shrink-0 rounded-full bg-warning"
          />
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>{formatMessage({ id: "browser.resizeDuringOperationWarning" })}</span>
        </div>
      ) : null}
      <ResponsiveBrowserViewport
        active={isResponsiveMode}
        desktopZoomFactor={desktopZoomFactor}
        isComposed={isComposed}
        onResize={onViewportResize}
        onViewportSizeChange={onViewportSizeChange}
        viewportSize={viewportSize}
        zoom={viewportZoom}
      >
        {guestFailure ? (
          <BrowserGuestFailureState
            formatMessage={formatMessage}
            guestFailure={guestFailure}
            onRetry={onRetryGuest}
          />
        ) : loadError ? (
          <BrowserLoadErrorState
            errorMessage={loadError}
            formatMessage={formatMessage}
            isCertificateError={isCertificateBrowserLoadErrorCode(browserState.loadErrorCode)}
            onRetry={onRetryLoad}
          />
        ) : isEmptyBrowserState ? (
          <BrowserEmptyState
            key="empty-state"
            browserState={browserState}
            formatMessage={formatMessage}
            isGuestStarting={shouldMountWebview && !browserState.isReady}
          />
        ) : null}
        {/* 自由尺寸开关只改变稳定 frame 的 CSS 宽高，不能条件替换 webview 的父层级；
            否则 Electron guest 会被重建并丢失网页历史。空白页仍直接隐藏 webview，确保空置态可见。
            Electron 41 还要求 nodeintegrationinsubframes 随 guest 创建声明，供发生真实导航的子 frame 加载固定 preload。
            allowpopups 若等 ref 回调再 setAttribute，guest 已完成 attach，target=_blank 会在
            Chromium 权限边界被静默吞掉。必须让 React 在插入节点前输出字符串 attribute；类型断言只用于
            绕过 @types/react 把 Electron boolean attribute 建模为 boolean 所引发的 React DOM 告警。
            generation 只在 guest renderer 已异常退出时递增；普通切换/resize 必须继续复用原节点。
            新建 human tab 与 about:blank guest 同帧挂载时，Electron 的独立合成面
            可能先于宿主隐藏样式绘制白色首帧。因此只在确认导航后创建 human guest；
            已创建的 guest 仍保持稳定挂载。 */}
        {shouldMountWebview ? (
          <webview
            key={`webview:${webviewGeneration}`}
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            src={isResidencyRestore ? BROWSER_VIEW_RESTORE_BOOTSTRAP_URL : DEFAULT_BROWSER_URL}
            partition="persist:zcode-embedded-browser"
            nodeintegrationinsubframes="true"
            data-browser-compositor-scale={isResponsiveMode ? desktopZoomFactor : undefined}
            data-browser-layout-scale={isResponsiveMode ? responsiveGuestLayoutScale : undefined}
            data-browser-transform-scale={
              isResponsiveMode ? responsiveGuestTransformScale : undefined
            }
            data-testid={TID_BROWSER_WEBVIEW}
            data-browser-resize-dimmed={showResizeWarning ? "true" : undefined}
            className={cn(
              "browser-use-viewport h-full min-h-0 w-full",
              isEmptyBrowserState || guestFailure || loadError ? "hidden" : "inline-flex",
            )}
            // Electron 的 `<webview>` 独立 guest surface 按布局尺寸分配 raster：放大和缩小都先按
            // 1 / zoom 布局，再 transform 回 frame，guest 自然 viewport 即等于目标 viewport。
            // absolute 避免补偿布局污染 Fit 的 scroll extent。
            // 这里只改变宿主布局/合成；guest zoom、CSS viewport、DPR 与 Browser Use 回读保持不变。
            style={{
              // 网页画布默认按浏览器语义使用白色；这里只设置 webview 节点底色，
              // 不增加覆盖层，也不向 guest 页面注入或覆盖任何样式。
              backgroundColor: "#fff",
              // Electron guest surface 可能早于 Tailwind hidden 类完成首次合成，
              // 导致新 tab 闪一帧白色；创建期内联 visibility 可封住该时序窗口。
              ...(isEmptyBrowserState ? { visibility: "hidden" as const } : {}),
              ...(isResponsiveMode
                ? {
                    ...(needsResponsiveGuestLayout
                      ? {
                          height: responsiveGuestLayoutSize,
                          left: 0,
                          position: "absolute" as const,
                          top: 0,
                          width: responsiveGuestLayoutSize,
                        }
                      : {}),
                    ...(responsiveGuestTransformScale !== 1
                      ? {
                          transform: `scale(${responsiveGuestTransformScale})`,
                          transformOrigin: "top left",
                        }
                      : {}),
                  }
                : {}),
            }}
          />
        ) : null}
      </ResponsiveBrowserViewport>
    </div>
  );
}
