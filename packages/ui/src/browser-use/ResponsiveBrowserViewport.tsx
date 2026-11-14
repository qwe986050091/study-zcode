// INV-01 frame 的 CSS 宽高恒等于 viewportSize 与 rendererScale 之积，内层 viewport 用同尺寸加 scale 变换表达视觉缩放；守住位置：返回 JSX 两层 div 的 style 表达式；改错故障：外框与内容尺寸不一致，手柄命中区偏移且 guest 被裁切。
// INV-02 visualScale 只在 active 分支参与计算，inactive 时恒为 1；守住位置：const visualScale = active 的三元分支；改错故障：隐藏 tab 保留缩放变换，切回首帧先按旧比例排版再跳正，guest 跟随重排。
// INV-03 rendererScaleRef 在每次渲染时直接镜像 rendererScale，事件处理器只读 ref 不读闭包；守住位置：rendererScale 计算后的赋值；改错故障：手势回调停留在上一次渲染的比例，应用 zoom 变化后拖拽立刻非线性。
// INV-04 canvasSize 只接受正宽高，非正测量结果被丢弃；守住位置：updateCanvasSize 的早退判断；改错故障：inactive tab 的 display none 期间以 0×0 覆盖最后有效画布，切回 Fit 首帧回退为兜底比例再缩。
// INV-05 viewportSizeRef 是拖拽与键盘读取尺寸的唯一来源，props 变化后由 effect 同步；守住位置：viewportSize 同步 effect 与 beginResize 的 startSize 快照；改错故障：手势期间读到旧尺寸，pointermove 反复覆盖新值或尺寸回弹。
// INV-06 每一帧最多提交一次尺寸变更，帧内多次请求合并为最后一个值；守住位置：scheduleViewportSize 的句柄门闩；改错故障：每次 move 都触发 React render 与 guest resize，拖拽掉帧且粘手。
// INV-07 resizeAnimationFrameRef 非 0 即代表存在已排期未执行的回调，结束手势必须先取消；守住位置：finishResize 的 cancelAnimationFrame 分支；改错故障：拖拽结束后仍补交一帧尺寸，松手后画面继续跳一下。
// INV-08 dragRef 与 pointer capture 成对建立、成对释放，释放失败也必须先清空状态；守住位置：beginResize 与 finishResize；改错故障：capture 泄漏让页面其他区域无法点击，或旧手势在 pointerId 复用时被继续驱动。
// INV-09 finishResize 必须校验 pointerId，非当前指针的结束事件直接忽略；守住位置：finishResize 的指针比对早退；改错故障：多指触控时第二根手指抬手即终止第一根手指的拖拽，尺寸停在半途。
// INV-10 鼠标手势以 event.buttons 的物理键位作为终止依据，而非 pointerdown 时的快照；守住位置：handlePointerMove 的 buttons 判断；改错故障：窗口失焦吞掉 pointerup 后继续拖拽，尺寸随光标持续漂移。
// INV-11 指针位移必须先除以 rendererScale 再累加到快照起点；守住位置：handlePointerMove 的 widthDelta 与 heightDelta；改错故障：50% 缩放下拖 1 像素等效拖 2 CSS 像素，可视比例与手柄行程脱节。
// INV-12 所有尺寸写入前统一经过 clampViewportSize，上下限取自 RESPONSIVE_BROWSER_VIEWPORT_LIMITS；守住位置：applyViewportSize 与 scheduleViewportSize 的入口；改错故障：尺寸越界后 guest 无法渲染，或手柄拖出容器外无法回拉。
// INV-13 尺寸去重以 viewportSizeRef 为基准，宽高都相同则不再通知父层；守住位置：applyViewportSize 的相等早退；改错故障：rAF 帧与键盘步进重复提交同值，父层每次重建 guest 并丢失滚动位置。
// INV-14 ResizeObserver 只在 active、isComposed 且 zoom 为 fit 时创建，并在依赖变化或卸载时断开；守住位置：useLayoutEffect 的清理函数；改错故障：observer 挂在已卸载节点上继续回调，泄漏整棵子树并报状态更新警告。
// INV-15 Fit 画布的初始测量在 layout effect 内同步完成，早于首帧绘制；守住位置：getBoundingClientRect 调用；改错故障：首帧按旧画布算出错误缩放，用户先看到一次可见闪动再被修正。
// INV-16 非 active 时必须丢弃未提交尺寸，不允许在隐藏态写父层状态；守住位置：mode-inactive 收尾调用的第三个参数；改错故障：隐藏 tab 仍在渲染期改状态，触发 React 警告并打断其他 tab 的测量。
// INV-17 窗口 blur 等效于手势失败，必须立即收尾；守住位置：window blur 监听；改错故障：系统截图或切换应用后残留手势，回到窗口轻移鼠标就改尺寸。
// INV-18 data-responsive-width、data-responsive-height 与 data-responsive-scale 是外部可见的尺寸契约，取值必须与 style 同源；守住位置：viewport 元素的属性与 style；改错故障：测试与调试工具读到与渲染不一致的值，点击坐标与截图裁剪全部偏移。
// INV-19 键盘步进按方向符号相乘，Shift 把步长放大到 10，且一次按键只沿一个轴提交；守住位置：handleResizeKeyDown 的两段方向分支；改错故障：反向手柄按右方向键反而缩小，或单次按键同时改宽高导致斜向跳动。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { type BrowserViewportSize } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
} from "@zcode/shared/test-ids";
import {
  resolveBrowserViewportRendererScale,
  resolveBrowserViewportScale,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import {
  RESPONSIVE_BROWSER_VIEWPORT_LIMITS,
  ResponsiveBrowserResizeHandles,
  type ResizeDirection,
  type ResizeHandleDirections,
} from "@/browser-use/ResponsiveBrowserResizeHandles.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export const DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE = {
  width: 393,
  height: 852,
} as const;

interface ResizeDragState {
  captureTarget: HTMLDivElement;
  heightDirection: ResizeDirection;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSize: BrowserViewportSize;
  widthDirection: ResizeDirection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampViewportSize(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clamp(
      size.width,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minWidth,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      size.height,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minHeight,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxHeight,
    ),
  };
}

/**
 * 保持同一层 DOM 包装，仅切换 frame 的 CSS 尺寸，避免开关自由尺寸时重建 Electron guest。
 * 尺寸只属于当前 Browser tab 的 React 实例，不写入跨端 store 或持久化状态。
 */
export function ResponsiveBrowserViewport({
  active,
  children,
  desktopZoomFactor,
  isComposed,
  onResize,
  onViewportSizeChange,
  viewportSize,
  zoom,
}: {
  active: boolean;
  children: ReactNode;
  desktopZoomFactor: number;
  isComposed: boolean;
  onResize?: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportSizeRef = useRef<BrowserViewportSize>(viewportSize);
  const rendererScaleRef = useRef(1);
  const dragRef = useRef<ResizeDragState | null>(null);
  const pendingViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const resizeAnimationFrameRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState<BrowserViewportSize | null>(null);
  // [权衡] visualScale 只在 active 分支参与计算，是因为 Fit 同时依赖 canvasSize、
  // desktopZoomFactor 与 zoom 三者，而 inactive 时它恒为 1：隐藏 tab 若继续
  // 保留缩放变换，切回时首帧会先按旧比例排版再跳正，guest 跟随重排一次。
  // canvasSize 为 null 说明首次测量尚未完成，解析函数此时走兜底比例。
  // 首帧偏小但随后被 layout effect 的实测值覆盖，属于可接受的中间态。
  // [失败路径] 非正画布尺寸已在测量入口丢弃，这里不再重复判断零分母。
  // [资源] visualScale 是纯派生值而不缓存到 ref，避免与 rendererScaleRef 双写不一致。
  // 它同时是 data-responsive-scale 的取值来源，外部换算依赖它与实际变换一致。
  const visualScale = active
    ? resolveBrowserViewportScale({ canvasSize, desktopZoomFactor, viewportSize, zoom })
    : 1;
  // Electron 的应用全局 zoom 会继续乘到自由尺寸 frame 的 CSS transform 上，
  // 导致 100%/固定比例与拖拽换算随应用一起变化。frame 使用倒数抵消父 zoom，
  // guest CSS viewport 仍由 width/height 单独控制，不把视觉补偿写回 Browser Use。
  const rendererScale = active
    ? resolveBrowserViewportRendererScale({ desktopZoomFactor, visualScale })
    : 1;
  rendererScaleRef.current = rendererScale;

  // [事务] 这里是尺寸提交的唯一出口，顺序固定为先钳制、再比对旧值、最后写 ref 并通知父层；
  // ref 必须先于 onViewportSizeChange 更新，否则父层同步回传新 props 时
  // 拖拽仍读到旧尺寸，下一次 pointermove 会把刚提交的值覆盖回去。
  // [并发] ref 是跨 pointer 键盘与 effect 共享的游标，而 React 批处理下 state 滞后，
  // 去重只能以 ref 为基准，否则同一帧内两次提交都能通过相等判断。
  // [权衡] 宽高同时相等才早退：只更新单轴会让另一轴的手柄命中区与 guest 视口错位。
  // 钳制在提交前完成，保证写进 ref 的值可以直接被下一次拖拽当作合法起点。
  const applyViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      const nextSize = clampViewportSize(requestedSize);
      const previousSize = viewportSizeRef.current;
      if (previousSize.width === nextSize.width && previousSize.height === nextSize.height) {
        return;
      }
      viewportSizeRef.current = nextSize;
      onViewportSizeChange(nextSize);
      onResize?.();
    },
    [onResize, onViewportSizeChange],
  );

  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  // [资源] 每帧只保留一个 rAF 句柄，待提交值覆盖写在该帧内最后一次请求上；
  // 句柄非 0 时只覆盖 pendingViewportSizeRef 而不重复排期，这是所有拖拽输入的合流点。
  // 若改成每次 pointermove 直接提交，一次拖拽可产生上百次 render，
  // guest 的 resize 与重绘成本远高于 React，表现为拖拽粘手与掉帧。
  // [事务] 回调内先清句柄再读取待提交值，保证即使后续提交抛错也不会留下非 0 句柄，
  // 否则门闩永久关闭，之后所有排期都被静默丢弃。
  // [失败路径] 待提交值为空时直接跳过，不把空值当作零尺寸提交。
  const scheduleViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      pendingViewportSizeRef.current = clampViewportSize(requestedSize);
      if (resizeAnimationFrameRef.current !== 0) return;
      // pointermove 频率可能高于刷新率；每帧只提交最后一组尺寸，避免无效 React render。
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = 0;
        const pendingSize = pendingViewportSizeRef.current;
        pendingViewportSizeRef.current = null;
        if (pendingSize) applyViewportSize(pendingSize);
      });
    },
    [applyViewportSize],
  );

  // [资源] 结束路径的释放顺序不可交换：先置空 dragRef 让 lostpointercapture 重入时可判定，
  // 再取消 rAF，最后尝试释放 capture；反序时释放动作触发的 lostpointercapture
  // 会读到仍非空的 dragRef 并第二次进入本函数。
  // [权衡] commitPendingSize 为 false 用于隐藏态与卸载：此时写入不可见，
  // 且会与下一个 tab 的测量竞争，宁可直接丢弃最后一帧尺寸。
  // [失败路径] capture 释放包在 try 内，系统已撤销时的异常只吞掉不重抛，
  // 因为状态已清理完毕，异常不携带可恢复信息，重抛只会打断调用方的卸载流程。
  const finishResize = useCallback(
    (reason: string, pointerId?: number, commitPendingSize = true) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
      dragRef.current = null;
      if (resizeAnimationFrameRef.current !== 0) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = 0;
      }
      const pendingSize = pendingViewportSizeRef.current;
      pendingViewportSizeRef.current = null;
      if (pendingSize && commitPendingSize) applyViewportSize(pendingSize);
      try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // capture 可能已被系统或浏览器撤销；状态已先清理，lostpointercapture 重入不会续拖。
      }
      logger.debug("[browser-use] 结束自由尺寸拖拽", {
        pointerId: drag.pointerId,
        reason,
      });
    },
    [applyViewportSize],
  );

  const beginResize = useCallback(
    (directions: ResizeHandleDirections, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      finishResize("pointer-replaced");
      try {
        // [资源] capture 挂在手柄节点而非 window，保证后续 move 事件落在同一节点；
        // 抢新 capture 前先用 pointer-replaced 收尾旧手势，否则两个 pointerId 会
        // 同时持有 dragRef，后写者覆盖前者，旧指针的 move 仍能改尺寸。
        // [失败路径] 自动化合成事件可能没有活跃 pointer，setPointerCapture 会抛出，
        // 此处吞掉异常后仍写入 dragRef：同一节点上的 move 依然能验证尺寸逻辑，
        // 代价是指针离开手柄节点后收不到 pointermove，手势提前结束。
        // [权衡] 只有鼠标主键按下才起步，触摸与笔不校验 button，否则触屏无法拖拽。
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 自动化合成事件可能没有活跃 pointer；同一节点上的 move 仍可验证尺寸逻辑。
      }
      dragRef.current = {
        ...directions,
        captureTarget: event.currentTarget,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSize: viewportSizeRef.current,
      };
    },
    [finishResize],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // mousemove 的 buttons 是浏览器对当前物理按键的事实来源；即使窗口 blur 被系统截图层吞掉，
      // 松开主键后的第一帧也必须终止旧手势，不能继续相信 pointerdown 时留下的 dragRef。
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finishResize("mouse-button-released", event.pointerId);
        return;
      }
      event.preventDefault();
      // frame 使用 CSS transform 缩放后，pointer delta 是视觉像素；若直接累加，
      // 50%/200% 下同样的拖动距离会错误地产生相同 CSS viewport 变化。
      // [权衡] 缩放补偿在读 ref 时再做一次非正保护，而不只是信任比例公式：
      // rendererScale 由 desktopZoomFactor 反比得到，极端 zoom 下可能取到 0，
      // 一旦作除数会把增量放大成无穷，直接击穿尺寸上限并让 guest 布局失效。
      // 读 ref 而非闭包捕获的 rendererScale，使 pointermove 始终拿到最新比例。
      // [事务] 起点尺寸取 pointerdown 时的快照，增量只由总位移决定而不做累加，
      // 因此即使中间某个 pointermove 被合并或丢弃，也不会产生累积误差。
      // 增量先除以 rendererScale 再乘方向符号，保证 50% 与 200% 下拖拽手感一致。
      const scale = rendererScaleRef.current > 0 ? rendererScaleRef.current : 1;
      const widthDelta = (event.clientX - drag.startClientX) / scale;
      const heightDelta = (event.clientY - drag.startClientY) / scale;
      scheduleViewportSize({
        width: drag.startSize.width + widthDelta * drag.widthDirection,
        height: drag.startSize.height + heightDelta * drag.heightDirection,
      });
    },
    [finishResize, scheduleViewportSize],
  );

  const endResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishResize(event.type, event.pointerId);
    },
    [finishResize],
  );

  const handleResizeKeyDown = useCallback(
    (directions: ResizeHandleDirections, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      const currentSize = viewportSizeRef.current;
      if (
        directions.widthDirection !== 0 &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          width:
            currentSize.width +
            (event.key === "ArrowRight" ? step : -step) * directions.widthDirection,
        });
      }
      if (
        directions.heightDirection !== 0 &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          height:
            currentSize.height +
            (event.key === "ArrowDown" ? step : -step) * directions.heightDirection,
        });
      }
    },
    [applyViewportSize],
  );

  useLayoutEffect(() => {
    if (!active || !isComposed || zoom !== "fit") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // [事务] 同步测量先于 observer 建立，effect 结束时 canvasSize 已是真实值，
    // 首帧绘制就能拿到正确画布，不必等 observer 的异步回调再补一帧。
    // [权衡] setState 用函数式更新并在宽高同值时返回 previous，引用不变让 React
    // 跳过渲染：滚动条出现或消失会让 contentRect 抖动一像素，若每次都提交新对象，
    // Fit 会跟着重算，画面持续出现轻微缩放抖动。
    // [失败路径] 首次测量与随后 observer 回报不一致时以后者为准，
    // 两者都来自真实布局，不存在需要合并的中间态，也不必保留旧 canvasSize。
    const updateCanvasSize = (size: BrowserViewportSize) => {
      // inactive tab 的 display:none 会让 ResizeObserver 回报 0×0；若清掉最后有效画布，
      // 切回首帧 Fit 会先回退为 1，下一帧才缩小。
      // 非正尺寸不具备布局权威；重新 composed 时由 layout effect 在首绘前重测。
      if (size.width <= 0 || size.height <= 0) return;
      setCanvasSize((previous) =>
        previous?.width === size.width && previous.height === size.height ? previous : size,
      );
    };
    const rect = canvas.getBoundingClientRect();
    updateCanvasSize({ width: rect.width, height: rect.height });
    logger.debug("[browser-use] 重测自由尺寸 Fit 画布", {
      desktopZoomFactor,
      height: rect.height,
      width: rect.width,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    // [资源] observer 的生命周期严格绑定本次 effect 运行：active 与 isComposed、
    // zoom 或 desktopZoomFactor 任一变化都会先断开再重建，
    // 不存在跨依赖版本复用同一个 observer 的情况。
    // 清理函数必须无条件返回，否则卸载后 observer 仍持有 canvas 引用，
    // 并继续把尺寸回调写给已卸载组件的 setState。
    // [权衡] 不用 observer 的首次回调代替同步测量，因为首帧之前拿不到数值。
    return () => observer.disconnect();
  }, [active, desktopZoomFactor, isComposed, zoom]);

  useEffect(() => {
    if (!active) {
      finishResize("mode-inactive", undefined, false);
      return;
    }
    // 系统截图、应用切换等会让窗口在 pointerup 前失焦，原 handle
    // 收不到结束事件，pointer capture 与 dragRef 因而残留；重新聚焦后的普通移动会继续 resize。
    const handleWindowBlur = () => finishResize("window-blur");
    // [失败路径] 监听挂在 window 而非手柄：焦点变化时事件目标是 document.body，
    // 手柄节点上的冒泡监听收不到，只有 window 层级能保证收到。
    // [权衡] blur 时提交待处理尺寸而非丢弃，用户位移已完成，
    // 丢弃会让松手前最后一次拖动看起来无效；切走 tab 的 inactive 路径
    // 则显式丢弃，因为隐藏态写入不可见，且会与下一个 tab 的测量竞争。
    // 注册与注销同处一个 effect，清理时先移除监听再收尾手势，顺序不可交换。
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      finishResize("mode-exit", undefined, false);
    };
  }, [active, finishResize]);

  return (
    <div
      ref={canvasRef}
      className={cn(
        "h-full min-h-0 w-full min-w-0",
        active ? "overflow-auto bg-background-alt" : "overflow-hidden bg-background",
      )}
      data-responsive-browser-mode={active ? "active" : "inactive"}
    >
      <div
        className={cn(
          active
            ? "flex min-h-full w-max min-w-full items-center justify-center p-4"
            : "h-full w-full",
        )}
      >
        <div
          className={cn(
            "relative shrink-0",
            active ? "bg-card shadow-sm ring-1 ring-border" : "h-full w-full",
          )}
          data-testid={TID_BROWSER_RESPONSIVE_SCALED_FRAME}
          style={
            active
              ? {
                  height: `${viewportSize.height * rendererScale}px`,
                  width: `${viewportSize.width * rendererScale}px`,
                }
              : undefined
          }
        >
          <div
            aria-label={intl.formatMessage({ id: "browser.responsive.viewport" })}
            className={cn("relative", active ? "shrink-0" : "h-full w-full")}
            data-responsive-height={active ? viewportSize.height : undefined}
            // [权衡] 这三个 data 属性暴露视觉尺寸与视觉缩放，而不是 CSS 盒尺寸：
            // 外部据此换算点击坐标与截图裁剪，必须与 style 中的 scale 同源，
            // 不能改写成 viewportSize 与 rendererScale 的乘积。
            // [失败路径] inactive 时统一写入 undefined，避免隐藏 tab 残留上一轮数值，
            // 被测试或调试工具误读为仍然 active 并据此定位元素。
            // 属性只读，唯一写入方是 viewportSize 与 zoom 两条输入。
            data-responsive-scale={active ? visualScale : undefined}
            data-responsive-width={active ? viewportSize.width : undefined}
            data-testid={TID_BROWSER_RESPONSIVE_VIEWPORT}
            style={
              active
                ? {
                    height: `${viewportSize.height}px`,
                    transform: `scale(${rendererScale})`,
                    transformOrigin: "top left",
                    width: `${viewportSize.width}px`,
                  }
                : undefined
            }
          >
            {children}
            {active ? (
              <ResponsiveBrowserResizeHandles
                height={viewportSize.height}
                heightLabel={intl.formatMessage({
                  id: "browser.responsive.resizeHeight",
                })}
                onBeginResize={beginResize}
                onEndResize={endResize}
                onPointerMove={handlePointerMove}
                onResizeKeyDown={handleResizeKeyDown}
                width={viewportSize.width}
                widthLabel={intl.formatMessage({
                  id: "browser.responsive.resizeWidth",
                })}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
