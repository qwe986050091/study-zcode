// INV-01 窗口帧数有下限：守住位置 取大值；改错故障 低帧率下窗口退化成一帧。
// INV-02 峰值上限用分位数：守住位置 分位计算；改错故障 单个尖峰压扁整条曲线。
// INV-03 平滑前先裁剪：守住位置 逐值取小；改错故障 尖峰通过平滑扩散。
// INV-04 平滑首值直接取裁剪值：守住位置 空数组分支；改错故障 曲线从零缓慢爬升。
// INV-05 观测与预测共用取整：守住位置 取整函数；改错故障 两段数值精度不一致。
// INV-06 预测窗口按比例并夹取：守住位置 夹取调用；改错故障 短录制预测过长。
// INV-07 滚动和只增删两端：守住位置 增量更新；改错故障 每帧重算导致卡顿。
// INV-08 早期窗口按已有帧数平均：守住位置 分母计算；改错故障 开头曲线被人为压低。
// INV-09 缺帧按零计入：守住位置 空值合并；改错故障 稀疏数据被高估。
// INV-10 输出与输入逐帧对齐：守住位置 循环边界；改错故障 曲线整体错位一帧。
// INV-11 不修改输入桶：守住位置 只读遍历；改错故障 调用方数据被污染。
// INV-12 空输入返回空预测：守住位置 早退分支；改错故障 后续取末值时报错。
// INV-13 近期片段长度有上下界：守住位置 双端夹取；改错故障 极短录制预测抖动。
// INV-14 趋势按当前水平限幅：守住位置 夹取表达式；改错故障 预测出现负值或爆炸。
// INV-15 趋势随时间衰减：守住位置 乘性阻尼；改错故障 远期预测持续发散。
// INV-16 与近期均值混合：守住位置 权重相加；改错故障 突增后预测冲高不回落。
// INV-17 预测值不为负：守住位置 取大值；改错故障 图表出现负字符数。
// INV-18 帧下标延续观测末尾：守住位置 偏移计算；改错故障 预测与观测下标重叠。
//
// 模块职责：把逐帧字符桶压成观测曲线，并外推一小段预测曲线。
// 状态所有权：纯函数，无模块状态；窗口与时长参数由常量固定。
// 阅读顺序：先看主入口的参数换算，再看滚动与平滑，最后看预测构造。
import type { FrameBucket, FrameForecast, FrameTrendPoint } from "../shared/types.js";

const WINDOW_MS = 200;
const FORECAST_MIN_SECONDS = 1;
const FORECAST_MAX_SECONDS = 3;
const FORECAST_RATIO = 0.2;
const EMA_ALPHA = 0.32;
const TREND_DAMPING = 0.78;

// windowFrames = max(3, round(fps * WINDOW_MS / 1000))。
// peakLimit 由 resolvePeakLimit 从分位数取，不取 max。
// 先裁剪到 peakLimit，再过 EMA 平滑。
// 观测点与预测点都走同一套 Math.round 取整。
// horizonFrames 按 totalFrames 比例算，并夹在秒级区间。
export function buildFrameForecast(
  fps: 60 | 120,
  buckets: FrameBucket[],
  totalFrames: number,
): FrameForecast {
  const windowFrames = Math.max(3, Math.round((fps * WINDOW_MS) / 1000));
  const rollingSpeeds = buildRollingSpeeds(buckets, windowFrames);
  const peakLimit = resolvePeakLimit(rollingSpeeds);
  const smoothedValues = smoothValues(rollingSpeeds, peakLimit);
  const observed = smoothedValues.map((chars, index) => ({
    chars: roundChars(chars),
    frameIndex: index,
  }));
  const horizonFrames = resolveHorizonFrames(fps, totalFrames);
  const predicted = buildPredictedPoints(observed, horizonFrames);

  return {
    horizonFrames,
    observed,
    peakLimit: roundChars(peakLimit),
    predicted,
    windowFrames,
  };
}

// 滑动和只加减两端：进队加 chars，出窗减 chars。
// 早期窗口用已有 buckets 数做分母，不补零。
// 缺帧按 0 计入 rollingChars。
// speeds 与 buckets 逐帧等长，索引一一对应。
// 只读 buckets，不写回。
function buildRollingSpeeds(buckets: FrameBucket[], windowFrames: number) {
  const speeds: number[] = [];
  let rollingChars = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    rollingChars += buckets[index]?.chars ?? 0;
    const staleIndex = index - windowFrames;
    if (staleIndex >= 0) {
      rollingChars -= buckets[staleIndex]?.chars ?? 0;
    }
    const currentWindow = Math.min(index + 1, windowFrames);
    speeds.push(rollingChars / currentWindow);
  }
  return speeds;
}

function smoothValues(values: number[], peakLimit: number) {
  const smoothed: number[] = [];
  let level = 0;
  for (const value of values) {
    const clippedValue = Math.min(value, peakLimit);
    level = smoothed.length === 0 ? clippedValue : level + EMA_ALPHA * (clippedValue - level);
    smoothed.push(level);
  }
  return smoothed;
}

// observed 为空直接返回 []，不做兜底点。
// recent 的长度夹在 8 与 90 之间，再按 0.35 比例取。
// 趋势增量按当前水平限幅（TREND_DAMPING），不无限外推。
// 混入近期均值与 EMA，压住预测过冲。
function buildPredictedPoints(observed: FrameTrendPoint[], horizonFrames: number) {
  if (observed.length === 0) {
    return [];
  }

  const recent = observed.slice(-Math.max(8, Math.min(90, Math.floor(observed.length * 0.35))));
  const recentValues = recent.map((point) => point.chars);
  const level = recentValues.at(-1) ?? 0;
  const recentAverage = average(recentValues);
  const trend = clamp(estimateSlope(recentValues), -level * 0.04, Math.max(0.04, level * 0.04));
  const predicted: FrameTrendPoint[] = [];
  let trendMultiplier = 1;

  for (let offset = 1; offset <= horizonFrames; offset += 1) {
    trendMultiplier *= TREND_DAMPING;
    const trendValue = level + trend * offset * trendMultiplier;
    const blendedValue = trendValue * 0.68 + recentAverage * 0.32;
    predicted.push({
      chars: roundChars(Math.max(0, blendedValue)),
      frameIndex: observed.length - 1 + offset,
    });
  }

  return predicted;
}

function resolvePeakLimit(values: number[]) {
  const positiveValues = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (positiveValues.length === 0) {
    return 1;
  }
  const p85 = positiveValues[Math.floor((positiveValues.length - 1) * 0.85)] ?? 1;
  const median = positiveValues[Math.floor((positiveValues.length - 1) * 0.5)] ?? p85;
  return Math.max(1, p85 * 1.35, median * 1.8);
}

function resolveHorizonFrames(fps: 60 | 120, totalFrames: number) {
  const minFrames = fps * FORECAST_MIN_SECONDS;
  const maxFrames = fps * FORECAST_MAX_SECONDS;
  return Math.round(clamp(totalFrames * FORECAST_RATIO, minFrames, maxFrames));
}

function estimateSlope(values: number[]) {
  if (values.length < 2) {
    return 0;
  }

  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const x = index - xMean;
    numerator += x * ((values[index] ?? yMean) - yMean);
    denominator += x * x;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundChars(value: number) {
  return Math.round(value * 100) / 100;
}
