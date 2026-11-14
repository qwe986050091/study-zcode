// INV-01 溢出判定以单份标题的排版宽度为准：守住位置 内容宽度读取；改错故障 走马灯副本撑大滚动宽度，永远无法退出溢出态。
// INV-02 溢出状态更新必须做三字段比较后才替换对象：守住位置 状态更新函数；改错故障 每次观察都触发重渲染，产生动画抖动。
// INV-03 距离等于内容宽度加间距，字号与间距必须是常量：守住位置 距离计算与间隔常量；改错故障 循环首尾出现粘连。
// INV-04 时长有最小下限，按像素速度换算：守住位置 时长计算；改错故障 短标题滚太快、长标题滚不完。
// INV-05 优先用尺寸观察器，缺失时退回窗口缩放事件：守住位置 观察器分支；改错故障 旧内核上标题溢出后不更新。
// INV-06 观察器必须同时观察容器与原文本：守住位置 两个观察调用；改错故障 容器变宽后仍停留在溢出态。
// INV-07 尊重减弱动效偏好，禁用时完全不启动：守住位置 动效判断；改错故障 系统偏好被忽略。
// INV-08 悬浮满 1 秒才启动，短暂划过不触发：守住位置 延迟排程；改错故障 鼠标扫过整个列表时到处滚动。
// INV-09 离开或偏好切换时必须取消动画与定时器：守住位置 停止函数；改错故障 动画残留，标题停在半途。
// INV-10 事件绑在最近的任务行边界而非文字节点：守住位置 边界查找；改错故障 鼠标在状态区时标题不滚动。
// INV-11 位移与遮罩共用同一组时长参数：守住位置 两段动画的选项；改错故障 遮罩与文字错位。
// INV-12 尾部到达左缘后切换为仅右侧遮罩：守住位置 关键帧偏移计算；改错故障 已离场标题仍保留左侧渐隐。
// INV-13 偏移量必须落在 0 到 1 之间且随宽度变化：守住位置 各关键帧偏移；改错故障 宽度极小时关键帧越界被忽略。
// INV-14 副本只在溢出时挂载且对读屏隐藏：守住位置 条件渲染与无障碍属性；改错故障 读屏重复朗读标题。
// INV-15 原生提示属性在组件边界统一丢弃：守住位置 属性解构；改错故障 悬浮走马灯时出现遮挡提示框。
// INV-16 标签名由调用方指定，默认段落：守住位置 标签参数；改错故障 列表项语义被破坏。
// INV-17 外部类名必须最后合并：守住位置 类名拼接顺序；改错故障 调用方无法覆盖默认宽度。
// INV-18 副作用依赖只列文本与动画参数：守住位置 两个依赖数组；改错故障 无关重渲染导致观察器反复重建。
//
// 模块职责：渲染可能超长的任务标题，溢出时以走马灯方式循环展示，并同步遮罩渐变。
// 状态所有权：溢出度量与动画实例都由组件本地持有；文本内容完全来自入参。
// 阅读顺序：先看常量与关键帧构造函数，再读度量副作用，最后看动画副作用与渲染结构。
import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from "react";
import { cn } from "@/components/lib/utils.js";

// 遮罩类名同时声明标准与兼容前缀，避免前缀差异。
// `marqueeGapPx` 等常量集中在文件顶部统一单位，动画与静态态复用同一套视觉规则。
// 两套遮罩字符串分别用于普通溢出与双侧展示。
// 常量集中在一处，便于同一视觉规则在动画与静态态复用。
const overflowFadeClassName =
  "[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]";
const marqueeGapPx = 24;
const marqueePixelsPerSecond = 40;
const minimumMarqueeDurationSeconds = 6;
const marqueePauseSeconds = 2;
const marqueeHoverDelayMs = 1_000;
const marqueeMaskFadeInSeconds = 0.15;
const rightFadeMask =
  "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)";
const bothEdgesFadeMask =
  "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)";

// createMaskKeyframe 返回 { maskImage, offset, webkitMaskImage } 纯对象供 trackAnimation/maskAnimation 的关键帧数组共用：标准与 -webkit- 属性必须同时写，旧内核只认其中一种；offset 由调用方按总时长换算，本函数不做时间计算。
function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage };
}

type TaskTitleOverflowTextProps = ComponentPropsWithoutRef<"p"> & {
  as?: "p" | "span";
};

// TaskTitleOverflowText 默认 as = "p"，也可传 "span"；title 在解构时改名为 _nativeTitle 并丢弃——原生 title 提示会在 hover 走马灯时遮挡滚动中的任务名；textRef 指向容器、originalTextRef 只指向原文本，度量只用后者，overflowState 含 distance/duration/isOverflowing 三字段。
export function TaskTitleOverflowText({
  as = "p",
  children,
  className,
  // 原生 title 提示框会在 hover 走马灯时遮挡正在滚动的任务名称。
  // 在组件边界统一消费该属性，避免各个 task row 漏掉后再次引入 tooltip。
  title: _nativeTitle,
  ...props
}: TaskTitleOverflowTextProps) {
  const Component = as as ElementType;
  const textRef = useRef<HTMLElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  });
  const { distance, duration, isOverflowing } = overflowState;

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;

    // updateOverflow 以 originalTextElement.scrollWidth 为内容宽度、textElement.clientWidth 为比较基准：用副本会撑大 scrollWidth 导致无法退出溢出态；nextDistance = contentWidth + marqueeGapPx 保证循环首尾不粘连，nextDuration 取 Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)；三字段全等时 setOverflowState 返回 current 避免无谓重渲染。
    const updateOverflow = () => {
      // 标题过去无条件挂载 mask，完整可见的短标题也带有渐隐样式。
      // 以单份标题的真实排版宽度为准，避免走马灯副本撑大 scrollWidth 后无法退出溢出状态。
      const contentWidth = originalTextElement.scrollWidth;
      const nextIsOverflowing = contentWidth > textElement.clientWidth;
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0;
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds;
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      );
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    resizeObserver.observe(originalTextElement);
    return () => resizeObserver.disconnect();
  }, [children]);

  useEffect(() => {
    const textElement = textRef.current;
    const marqueeTrack = marqueeTrackRef.current;
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== "function"
    ) {
      return;
    }

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    // 走马灯事件原本绑在文字节点上，鼠标位于 task item 的时间、
    // 状态或操作区域时不会滚动。统一绑到最近的普通或 grouped task 行边界。
    const hoverTarget =
      textElement.closest<HTMLElement>("[data-task-item-key], [data-grouped-task-key]") ??
      textElement;
    let animations: Animation[] = [];
    let startTimer: number | null = null;

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      animations.forEach((animation) => animation.cancel());
      animations = [];
    };
    // startMarquee 首先在 reducedMotionQuery?.matches 时 return；随后 stopMarquee() 清掉上一轮 startTimer 与 animations；totalDuration = duration + marqueePauseSeconds，movementEndOffset = duration / totalDuration 把移动与停留切开，trackAnimation 与 maskAnimation 都存进 animations 供停止时统一 cancel。
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      const totalDuration = duration + marqueePauseSeconds;
      // 纯 CSS infinite 动画只能按百分比停顿，标题宽度变化时无法保证
      // 副本头部对齐后固定等待 2 秒。Web Animation 用动态 offset 分离移动与停留时长。
      const movementEndOffset = duration / totalDuration;
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration;
      // 左侧 mask 在 24px 间距内继续淡出，会让已经离场的主体标题
      // 仍留下一段无内容的渐变。主体尾部到达左边缘时直接切换为仅右侧 mask。
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance);
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration;
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: "linear",
        iterations: Infinity,
      };
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: "translate3d(0, 0, 0)" },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      );
      // 滚动期间始终使用双侧 mask，会让副本对齐后的 2 秒停留画面
      // 仍然看不清标题开头。mask 与位移动画共用时长，在到达前淡出左侧并保持到下一轮。
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      );
      animations = [trackAnimation, maskAnimation];
    };
    // scheduleMarquee 同样先判 reducedMotionQuery?.matches；stopMarquee() 后把 startTimer 设为 window.setTimeout(startMarquee, marqueeHoverDelayMs)，短暂划过不会启动，重复 mouseenter 会重置计时；离开或动效偏好切换时 stopMarquee 清掉未触发的定时器。
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return;
      stopMarquee();
      // 交互规则：短暂划过 task row 不应立即触发运动；停留满 1 秒才开始。
      startTimer = window.setTimeout(() => {
        startTimer = null;
        startMarquee();
      }, marqueeHoverDelayMs);
    };
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee();
    };

    hoverTarget.addEventListener("mouseenter", scheduleMarquee);
    hoverTarget.addEventListener("mouseleave", stopMarquee);
    reducedMotionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      hoverTarget.removeEventListener("mouseenter", scheduleMarquee);
      hoverTarget.removeEventListener("mouseleave", stopMarquee);
      reducedMotionQuery?.removeEventListener("change", handleMotionPreferenceChange);
      stopMarquee();
    };
  }, [distance, duration, isOverflowing]);

  return (
    <Component
      ref={textRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        isOverflowing && overflowFadeClassName,
        isOverflowing && "task-title-marquee",
        className,
      )}
      {...props}
    >
      <span
        ref={marqueeTrackRef}
        data-task-title-marquee-track="true"
        className="task-title-marquee-track inline-flex w-max min-w-max items-center gap-6"
      >
        <span ref={originalTextRef} data-task-title-copy="original" className="shrink-0">
          {children}
        </span>
        {isOverflowing ? (
          <span aria-hidden="true" data-task-title-copy="duplicate" className="shrink-0">
            {children}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
