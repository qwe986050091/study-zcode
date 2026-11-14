// INV-01 数值归一化只在 normalizeSmoothMetricTarget 收口：字符串走十进制解析、非有限值返回 null、负数夹到 0 再取整；守住该函数。改坏后组件会把不可解析的占位符当成 0 或把 NaN 直接渲染出去。
// INV-02 [失败路径] normalize 返回 null 表示「尚不可解析」，effect 首个分支直接把原值写进展示态；守住 null 判断与 setDisplayValue(value) 这一对。若把 null 折成 0，流式占位阶段会先闪一个 0 再跳回真实值。
// INV-03 [资源] 每一帧都必须有确定收尾：tick 里仅当 nextDisplayValue 不等于状态里的 targetValue 才续帧，否则把 frameId 置空；守住 tick 尾部两个分支。漏掉置空会让已完成的动画仍被当成在跑，后续再也启不了帧。
// INV-04 [资源] cancelMetricFrame 同时负责取消动画帧与把 frameId 归零，且在无 window 的环境里只归零；守住该函数。只取消不清空会让下一次调度被非空 frameId 挡住，数字永久停住。
// INV-05 [并发] metricKey 变化时先取消旧帧，再整体重置 bufferedOnce/displayValue/linesPerSecond/targetValue；守住 effect 内的 metricKey 分支。少重置 bufferedOnce 会让新指标跳过 120ms 起始缓冲，首帧出现大跳变。
// INV-06 [并发] 帧回调开头比较 timestamp 与 lastFrameAt，间隔为负时直接续帧且不推进；守住 tick 的 elapsedMs 小于 0 分支。删掉它，起始缓冲造成的未来时间戳会被当成负步长，数字倒着走。
// INV-07 [事务] 目标值只在确实变化时更新 targetUpdatedAt 并重算速度；守住 effect 里 state.targetValue 与 targetValue 不等的分支。无条件刷新时间戳会让 2 秒采样窗口被空转重置，速度永远回落到默认 48。
// INV-08 速度估计用 SPEED_EMA_ALPHA 做指数平滑，增量为零、间隔非正或超过 SAMPLE_MAX_GAP_MS 时原样返回上次速度；守住 estimateSmoothMetricLinesPerSecond 三个早退条件。去掉上限判断，切后台回来的大间隔会把速度顶到 180。
// INV-09 单帧步长取 speedStep 与 settleStep 的较大者，再与剩余距离取小；守住 resolveNextSmoothMetricDisplay 的 step 表达式。只用 speedStep 时短距离收尾很慢，只用 settleStep 时大跳变被摊平得没有滚动感。
// INV-10 MAX_SMOOTH_ANIMATION_MS 经 maxFrames 保证再远的距离也在约 900ms 内收敛；守住 maxFrames 与 settleStep 的联合计算。间隔已按 16ms 设下限，去掉下限会让极小间隔把 maxFrames 顶得极大、步长退化为 1。
// INV-11 [权衡] clampMetricSpeed 把速度夹在 MIN 与 MAX 之间，非有限值退回 DEFAULT；守住该函数。放宽下限会让长停顿后的追赶变成逐帧一行，用户看到的是几乎静止。
// INV-12 [失败路径] shouldAnimate 同时要求 active、非 reduced-motion、有 window 且有 requestAnimationFrame；守住这个布尔表达式。删掉任一条件，SSR、测试环境或无障碍偏好下都会尝试启帧。
// INV-13 [失败路径] 不满足 shouldAnimate 时一次性把展示态与运行态对齐到目标值并清帧；守住该分支。只写 setDisplayValue 不写 state，下一帧会从旧值继续追，出现回跳。
// INV-14 prefers-reduced-motion 的订阅必须成对：事件接口对应移除，旧接口对应移除旧监听；守住 usePrefersReducedMotion 的两个 return。漏掉清理会在热更新后叠加监听，状态抖动。
// INV-15 [资源] effect 清理函数以 stateRef.current.frameId 为准取消帧；守住依赖数组与清理体。把运行态换成局部变量会让卸载时的取消落空，动画在组件消失后继续写 setState。
// INV-16 stateRef 初值必须与 displayValue 的惰性初值同源（可解析时取目标值，否则分别退回 0 与原值）；守住 useRef 的初始化对象。两处各自兜底成不同默认值，首帧会出现一次从 0 爬到真实值的假动画。
// INV-17 [事务] 帧内先写 state.displayValue 再 setDisplayValue，两者必须同步；守住 tick 的赋值顺序。只写 React 状态会让下一次推进从陈旧值重算，进度在同一数值上反复。
// INV-18 渲染出口只有 FlipMetricValue，且值统一转成字符串；守住组件 return。改传原始 value 会绕过平滑，改传数字会破坏子组件的字符串契约。
//
// 模块职责：把流式到达的指标值渲染成连续滚动的数字——按行/秒估计速度逐帧追赶目标，并在减弱动效或非浏览器环境下退化为直接展示。
// 状态所有权：目标值由 props 决定，运行态（当前展示值、速度、帧句柄、采样时刻）由组件内 ref 独占，React state 只保存展示字符串的来源值。
// 阅读顺序：常量边界 → 运行态结构 → normalize 降级 → 速度估计 → 帧推进纯函数 → 环境适配 → effect 生命周期与 tick。
import { useEffect, useId, useRef, useState } from "react";
import { FlipMetricValue } from "@/components/ui/flip-metric-value.js";

// 七个常量定义平滑的全部可调边界：默认与最小最大速度、EMA 系数、采样间隔上限、起始缓冲与最长收敛时长。
// [权衡] 48 行/秒是观感基线，24 到 180 的夹取范围让极端增量仍像数字在滚动，而不是瞬移或爬行。
// SAMPLE_MAX_GAP_MS 取 2 秒：超过这个间隔的增量视为一次断点，不参与速度采样，避免切后台回来的噪声。
// INITIAL_SAMPLE_BUFFER_MS 让首个目标延迟 120ms 才起算，用来吸收流式批次的抖动；MAX_SMOOTH_ANIMATION_MS 是收敛上界。
const DEFAULT_LINES_PER_SECOND = 48;
const MIN_LINES_PER_SECOND = 24;
const MAX_LINES_PER_SECOND = 180;
const SPEED_EMA_ALPHA = 0.35;
const SAMPLE_MAX_GAP_MS = 2_000;
const INITIAL_SAMPLE_BUFFER_MS = 120;
const MAX_SMOOTH_ANIMATION_MS = 900;

// 运行态放在 ref 里而不是 React state：每帧都要读写，走 state 会让高频 tick 触发整棵树重渲染。
// bufferedOnce 只用于首个目标的一次性起始缓冲，重置时机仅限 metricKey 切换，不能随目标值变化重置。
// displayValue 是当前展示值，targetValue 是追赶目标；两者相等即动画终态，也是停帧的判据。
// lastFrameAt 记上一帧时间戳（含那 120ms 偏移），targetUpdatedAt 记目标变更时刻，两个时间基准不可互换。
// linesPerSecond 是平滑后的速度估计，metricKey 用于识别换了指标，frameId 是唯一可取消的帧句柄。
interface SmoothMetricRuntimeState {
  bufferedOnce: boolean;
  displayValue: number;
  frameId: number | null;
  lastFrameAt: number;
  linesPerSecond: number;
  metricKey: string;
  targetUpdatedAt: number;
  targetValue: number;
}

export interface SmoothMetricDisplayInput {
  currentValue: number;
  elapsedMs: number;
  linesPerSecond: number;
  targetValue: number;
}

// 这是组件对外的第一道降级边界：数字与字符串统一成非负整数，其余一律 null。
// [失败路径] 字符串按十进制解析，失败得到 NaN，由有限性判断转成 null，不在这里抛错也不填空值。
// 先四舍五入再与 0 取大，等价于把负数压到 0 而不是保留符号；顺序颠倒时负数会被舍成 -0。
// 返回 null 而不是 0，是为了让上层区分值尚不可用与值确实是零，两者在流式占位阶段表现不同。
// 若要支持小数指标，需要连同展示端一起改；只放宽这里会让按整数比较的状态机失去收敛判据。
export function normalizeSmoothMetricTarget(value: number | string): number | null {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  return Math.max(0, Math.round(numericValue));
}

// 把目标值变化量除以经过时间换算成行/秒，再与上次速度做 EMA 混合，输出仍是夹取后的合法速度。
// [失败路径] 增量为零、经过时间非正、或超过 SAMPLE_MAX_GAP_MS 时原样返回上次速度；这三个早退是抗噪的全部防线。
// 乘 1000 把毫秒基准换成秒基准；写成 100 或漏掉换算会让速度差一个数量级，动画变慢或瞬移。
// [权衡] EMA 系数 0.35 偏向新样本，能在两三次更新内跟上突发增速，代价是偶发尖峰被部分放大。
// 返回前统一走 clampMetricSpeed，保证调用方拿到的值一定落在可动画区间。
export function estimateSmoothMetricLinesPerSecond(input: {
  elapsedMs: number;
  nextTargetValue: number;
  previousLinesPerSecond: number;
  previousTargetValue: number;
}): number {
  const delta = Math.abs(input.nextTargetValue - input.previousTargetValue);
  if (delta <= 0 || input.elapsedMs <= 0 || input.elapsedMs > SAMPLE_MAX_GAP_MS) {
    return input.previousLinesPerSecond;
  }

  const sampledLinesPerSecond = (delta / input.elapsedMs) * 1_000;
  const smoothed =
    input.previousLinesPerSecond * (1 - SPEED_EMA_ALPHA) +
    sampledLinesPerSecond * SPEED_EMA_ALPHA;
  return clampMetricSpeed(smoothed);
}

// 纯函数帧推进器：给定当前值、目标值、间隔与速度，返回下一帧应显示的值，不读写任何外部状态。
// 当前值与目标值先各自取整，相等就直接返回目标值；这是动画的收敛点，也是 tick 停帧的唯一依据。
// [并发] 方向由两值比较得出，步长始终为正再乘方向；改成带符号运算会让增减两个方向的取整行为不一致。
// 间隔以 16ms 为下限，防止首帧或时钟回拨产生零间隔；速度先夹取，再折算成一帧可推进的行数。
// settleStep 用剩余距离除以最大帧数向上取整，保证再长的距离也能在 MAX_SMOOTH_ANIMATION_MS 内走完。
// [权衡] 取 speedStep 与 settleStep 的较大者，意味着按速度走与按期收敛同时满足；与剩余距离取小则保证不越过目标。
export function resolveNextSmoothMetricDisplay(input: SmoothMetricDisplayInput): number {
  const currentValue = Math.round(input.currentValue);
  const targetValue = Math.round(input.targetValue);
  if (currentValue === targetValue) {
    return targetValue;
  }

  const distance = Math.abs(targetValue - currentValue);
  const direction = targetValue > currentValue ? 1 : -1;
  const elapsedMs = Math.max(input.elapsedMs, 16);
  const linesPerSecond = clampMetricSpeed(input.linesPerSecond);
  const speedStep = Math.max(1, Math.floor((linesPerSecond * elapsedMs) / 1_000));
  const maxFrames = Math.max(1, Math.ceil(MAX_SMOOTH_ANIMATION_MS / elapsedMs));
  const settleStep = Math.max(1, Math.ceil(distance / maxFrames));
  const step = Math.min(distance, Math.max(speedStep, settleStep));
  return currentValue + direction * step;
}

// `clampMetricSpeed` 与时间源和减弱动效订阅共用默认值，任一处缺失都会让首帧速度失真。
// clampMetricSpeed 对非有限值退回默认值，再夹到最小与最大之间；顺序不能反，否则 NaN 参与比较会得到意外结果。
// [失败路径] 若把夹取只放在调用方，任何绕过路径（速度估计、帧推进、状态初值）都会漏掉，所以必须留在本函数。
// nowMs 优先用 performance.now，缺失时退回 Date.now：前者单调递增，后者在系统校时后可能回拨。
// [权衡] 时间源不统一会让帧时间与目标时间的差值出现负值；tick 的负间隔分支正是为回拨兜底。
// usePrefersReducedMotion 默认 false，表示未读取到偏好时按允许动画处理，避免首帧被误判成减弱模式。
// [失败路径] 环境不支持 matchMedia 时直接返回不订阅；此时保持默认值，SSR 与测试环境下不会抛错。
// 新旧订阅接口双分支兼容：有事件接口走事件，否则退回旧监听，两条路径的清理函数必须与订阅一一对应。
function clampMetricSpeed(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LINES_PER_SECOND;
  }
  return Math.min(MAX_LINES_PER_SECOND, Math.max(MIN_LINES_PER_SECOND, value));
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

// cancelMetricFrame 是帧句柄的唯一回收点：先判断 null 与环境，再取消并归零，重复调用安全。
// 组件用 useId 兜底 metricKey，保证同一实例未显式传 key 时也能识别换指标并重置动画状态。
// stateRef 初值与展示态惰性初值同源：可解析时取目标值，不可解析时分别退回 0 与原值。
// [事务] effect 的执行顺序固定为：空目标降级、metricKey 重置、可动画性判定、目标变更采样、启帧；顺序变化会改变速度采样的时间基准。
// bufferedOnce 只在首次有效目标时把 lastFrameAt 推到当前时间之后 120ms，让随后几帧因负间隔被丢弃。
// [资源] 启帧条件是展示值不等于目标值且 frameId 为空；缺任一条件会重复调度，同一时刻跑出两条帧链。
// tick 内先更新运行态再同步展示态，最后按是否到达目标决定续帧或停帧，保证帧链只有一条出口。
// [并发] 清理函数以 stateRef.current 为准并保留 metricKey 的真值判断；卸载与依赖变更都走同一条取消路径。
// 渲染只把展示值交给 FlipMetricValue，类名透传；动画细节全部留在这里，子组件保持纯展示。
function cancelMetricFrame(state: SmoothMetricRuntimeState): void {
  if (state.frameId === null || typeof window === "undefined") {
    state.frameId = null;
    return;
  }
  window.cancelAnimationFrame(state.frameId);
  state.frameId = null;
}

export function SmoothMetricValue({
  active = false,
  className,
  metricKey,
  value,
}: {
  active?: boolean;
  className?: string;
  metricKey?: string;
  value: number | string;
}) {
  const generatedMetricKey = useId();
  const resolvedMetricKey = metricKey ?? generatedMetricKey;
  const targetValue = normalizeSmoothMetricTarget(value);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayValue, setDisplayValue] = useState(() => targetValue ?? value);
  const stateRef = useRef<SmoothMetricRuntimeState>({
    bufferedOnce: false,
    displayValue: targetValue ?? 0,
    frameId: null,
    lastFrameAt: nowMs(),
    linesPerSecond: DEFAULT_LINES_PER_SECOND,
    metricKey: resolvedMetricKey,
    targetUpdatedAt: nowMs(),
    targetValue: targetValue ?? 0,
  });

  useEffect(() => {
    if (targetValue === null) {
      setDisplayValue(value);
      return;
    }

    const state = stateRef.current;
    const currentTime = nowMs();
    if (state.metricKey !== resolvedMetricKey) {
      cancelMetricFrame(state);
      state.bufferedOnce = false;
      state.displayValue = targetValue;
      state.lastFrameAt = currentTime;
      state.linesPerSecond = DEFAULT_LINES_PER_SECOND;
      state.metricKey = resolvedMetricKey;
      state.targetUpdatedAt = currentTime;
      state.targetValue = targetValue;
      setDisplayValue(targetValue);
    }

    const shouldAnimate =
      active &&
      !prefersReducedMotion &&
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function";

    if (!shouldAnimate) {
      cancelMetricFrame(state);
      state.displayValue = targetValue;
      state.targetValue = targetValue;
      state.targetUpdatedAt = currentTime;
      state.lastFrameAt = currentTime;
      setDisplayValue(targetValue);
      return;
    }

    if (state.targetValue !== targetValue) {
      state.linesPerSecond = estimateSmoothMetricLinesPerSecond({
        elapsedMs: currentTime - state.targetUpdatedAt,
        nextTargetValue: targetValue,
        previousLinesPerSecond: state.linesPerSecond,
        previousTargetValue: state.targetValue,
      });
      state.targetValue = targetValue;
      state.targetUpdatedAt = currentTime;
      if (!state.bufferedOnce) {
        state.bufferedOnce = true;
        state.lastFrameAt = currentTime + INITIAL_SAMPLE_BUFFER_MS;
      }
    }

    const tick = (timestamp: number) => {
      const elapsedMs = timestamp - state.lastFrameAt;
      if (elapsedMs < 0) {
        state.frameId = window.requestAnimationFrame(tick);
        return;
      }

      const nextDisplayValue = resolveNextSmoothMetricDisplay({
        currentValue: state.displayValue,
        elapsedMs,
        linesPerSecond: state.linesPerSecond,
        targetValue: state.targetValue,
      });
      state.displayValue = nextDisplayValue;
      state.lastFrameAt = timestamp;
      setDisplayValue(nextDisplayValue);

      if (nextDisplayValue !== state.targetValue) {
        state.frameId = window.requestAnimationFrame(tick);
      } else {
        state.frameId = null;
      }
    };

    if (state.displayValue !== state.targetValue && state.frameId === null) {
      // 修复原因：模型流式参数会把行数按不规则批次推到 UI。
      // 这里在展示层逐帧追赶真实目标，让 FlipMetricValue 看到连续数字而不是大跳变。
      state.frameId = window.requestAnimationFrame(tick);
    }

    return () => {
      if (stateRef.current.frameId !== null && resolvedMetricKey) {
        cancelMetricFrame(stateRef.current);
      }
    };
  }, [active, prefersReducedMotion, resolvedMetricKey, targetValue, value]);

  return <FlipMetricValue className={className} value={String(displayValue)} />;
}
