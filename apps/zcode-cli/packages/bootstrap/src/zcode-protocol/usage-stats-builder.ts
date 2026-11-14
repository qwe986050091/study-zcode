// INV-01 单日切分只认偏移：守住位置 时区偏移换算；改错故障 跨时区用户日期错一天。
// INV-02 偏移解析失败回退零：守住位置 捕获分支；改错故障 非法时区让整个快照抛错。
// INV-03 日索引按本地午夜：守住位置 毫秒常量相乘；改错故障 热力图日期整体偏移。
// INV-04 四档阈值固定：守住位置 比例分界；改错故障 等级随数据量漂移。
// INV-05 无 token 归零级：守住位置 非正数判断；改错故障 空白天显示成有数据的颜色。
// INV-06 全量区间从最早日开始：守住位置 取最小值；改错故障 热力图左侧出现大片空白。
// INV-07 无数据退化为单日：守住位置 空数组判断；改错故障 起始日缺失导致循环失控。
// INV-08 非全量用起点日：守住位置 区间判断；改错故障 窗口开始前的数据仍被统计。
// INV-09 缓存命中率分母唯一：守住位置 三目表达式；改错故障 命中率被重复扣减。
// INV-10 比率除零保护：守住位置 大于零判断；改错故障 空库出现无效数值。
// INV-11 连续天数双向统计：守住位置 运行段与最长段；改错故障 中断后当前连续数继续累加。
// INV-12 当前段遇零即止：守住位置 中断标志；改错故障 断签后仍显示连续三十天。
// INV-13 峰值取最大日：守住位置 归约函数；改错故障 热力图色阶封顶错误。
// INV-14 周切片固定七天：守住位置 长度判断；改错故障 网格列数随数据变化。
// INV-15 末周补空位：守住位置 补空循环；改错故障 最后一周被挤到下一列。
// INV-16 趋势按日聚模型：守住位置 当日映射；改错故障 同日多模型互相覆盖。
// INV-17 排行份额按总量：守住位置 总和归约；改错故障 各模型份额之和不为一。
// INV-18 纯函数只读入参：守住位置 不写查询结果；改错故障 上游缓存被污染。
//
// 模块职责：把用量库的聚合结果投影成 App 端快照。
// 状态所有权：无状态，输入为查询结果与已解析的时间窗口。
// 阅读顺序：先看时区与等级，再看连续天数与热力图，最后看趋势与排行。
import type { AppUsageQueryResult } from "@zcode/contracts";
import type {
  AppUsageHeatmap,
  AppUsageHeatmapCell,
  AppUsageHeatmapWeek,
  AppUsageRange,
  AppUsageSnapshot,
} from "@zcode/shared";

const DAY_MS = 86_400_000;

/**
 * 构建 App 用量快照所需的上下文：range 决定统计窗口，timeZone/tzOffsetMs 决定“自然日”切分，
 * generatedAt 是快照冻结时间，since/until 为调用方已解析的毫秒区间。
 */
export interface BuildAppUsageOptions {
  range: AppUsageRange;
  timeZone: string;
  tzOffsetMs: number;
  generatedAt: number;
  since: number;
  until: number;
}

/** 用 Intl 计算 timeZone 在 atMs 时刻相对 UTC 的偏移（ms）。无法解析时回退 0。 */
// 走 Intl 而非 getTimezoneOffset：结果不随运行环境时区变化；先截到秒再相减，抵消 formatToParts 丢毫秒的误差。
export function resolveTzOffsetMs(timeZone: string, atMs: number): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(atMs));
    const lookup = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      lookup("year"),
      lookup("month") - 1,
      lookup("day"),
      lookup("hour"),
      lookup("minute"),
      lookup("second"),
    );
    return asUtc - Math.trunc(atMs / 1000) * 1000;
  } catch {
    return 0;
  }
}

function dayIndexToDate(dayIndex: number): string {
  // dayIndex*DAY 是「本地午夜当作 UTC」的时刻，取其 UTC 日历分量即本地日期。
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

// 四档阈值由 max 的 25% 起逐档递进、连续不留空洞：>75% 记 4，>50% 记 3，>25% 记 2，其余记 1；
// 无 token 或 max 为 0 时一律记 0 级。0 级不参与比例计算，避免空白天被显示成有数据的颜色。
function levelFor(tokens: number, max: number): AppUsageHeatmapCell["level"] {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

// range=all 时以数据中最早的一天为起点；没有任何数据时退化为只统计 endDayIndex 当天。
function resolveUsageStartDayIndex(
  result: AppUsageQueryResult,
  opts: BuildAppUsageOptions,
  endDayIndex: number,
): number {
  // 非 all 区间直接用 since 的本地日索引作为起点，与 days 聚合的切日口径保持一致。
  if (opts.range !== "all") {
    return Math.floor((opts.since + opts.tzOffsetMs) / DAY_MS);
  }

  const dayIndexes = [
    ...result.days.map((day) => day.dayIndex),
    ...result.dayModels.map((dayModel) => dayModel.dayIndex),
  ];
  if (dayIndexes.length === 0) {
    return endDayIndex;
  }
  return Math.min(...dayIndexes);
}

/**
 * 把 agent DB 的聚合查询结果投影成 App 展示用的用量快照（summary + heatmap + 按日模型 + 排行）。
 * 纯函数：只读 result，不查 DB；所有时间桶都按 opts 的时区偏移切日，避免跨时区错位。
 * models 顺序沿用上游（已按 token 降序），favoriteModel 取首个；无数据时为 null。
 * 三项比率（cacheHitRate/modelErrorRate/toolErrorRate）在分母为 0 时返回 0，不抛错也不留 NaN。
 */
export function buildAppUsageSnapshot(
  result: AppUsageQueryResult,
  opts: BuildAppUsageOptions,
): AppUsageSnapshot {
  const { totals, turnTotals, toolTotals } = result;

  // 用量库的 inputTokens 已是 total input，cache 字段只是 breakdown。
  // 命中率分母不能再加 cacheRead/cacheCreation，否则会把命中率压低。
  const cacheDenom =
    totals.inputTokens > 0
      ? totals.inputTokens
      : totals.cacheCreationTokens + totals.cacheReadTokens;
  const cacheHitRate = cacheDenom > 0 ? totals.cacheReadTokens / cacheDenom : 0;
  const modelErrorRate =
    totals.modelRequestCount > 0 ? totals.modelErrorCount / totals.modelRequestCount : 0;
  const toolErrorRate =
    toolTotals.toolCallCount > 0 ? toolTotals.toolErrorCount / toolTotals.toolCallCount : 0;

  // 按日 token 映射，用于 activeDays / streak / heatmap
  const dayTokenMap = new Map<
    number,
    { totalTokens: number; turnCount: number; toolCallCount: number }
  >();
  for (const d of result.days) {
    dayTokenMap.set(d.dayIndex, {
      totalTokens: d.totalTokens,
      turnCount: d.turnCount,
      toolCallCount: d.toolCallCount,
    });
  }

  const endDayIndex = Math.floor((opts.until + opts.tzOffsetMs) / DAY_MS);
  const startDayIndex = resolveUsageStartDayIndex(result, opts, endDayIndex);

  // streak 从 endDayIndex 向过去回扫：有 token 的连续天累计，遇到 0 终止 current；
  // longest 记录历史最长连续段，running 即从今天往前的当前段长度。
  let activeDays = 0;
  let currentStreakDays = 0;
  let longestStreakDays = 0;
  let runningStreakDays = 0;
  let streakBroken = false;
  for (let di = endDayIndex; di >= startDayIndex; di--) {
    const tokens = dayTokenMap.get(di)?.totalTokens ?? 0;
    if (tokens > 0) {
      activeDays++;
      runningStreakDays++;
      longestStreakDays = Math.max(longestStreakDays, runningStreakDays);
      if (!streakBroken) currentStreakDays++;
    } else if (!streakBroken) {
      streakBroken = true;
      runningStreakDays = 0;
    } else {
      runningStreakDays = 0;
    }
  }

  const maxTokens = result.days.reduce((m, d) => Math.max(m, d.totalTokens), 0);

  // heatmap：从 startDayIndex 到 endDayIndex，按 7 天一周切片（与现有 GitHub 式一致）
  const weeks: AppUsageHeatmapWeek[] = [];
  let week: Array<AppUsageHeatmapCell | null> = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const day = dayTokenMap.get(di);
    week.push({
      date: dayIndexToDate(di),
      level: levelFor(day?.totalTokens ?? 0, maxTokens),
      totalTokens: day?.totalTokens ?? 0,
      turnCount: day?.turnCount ?? 0,
      toolCallCount: day?.toolCallCount ?? 0,
    });
    if (week.length === 7) {
      weeks.push({ weekIndex: weeks.length, days: week });
      week = [];
    }
  }
  // 末尾不足一周用 null 补齐，保证 App 端网格列宽固定。
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push({ weekIndex: weeks.length, days: week });
  }

  const heatmap: AppUsageHeatmap = {
    startDate: dayIndexToDate(startDayIndex),
    endDate: dayIndexToDate(endDayIndex),
    maxTokens,
    weeks,
  };

  // trend：按日聚合 dayModels
  const dailyMap = new Map<number, Map<string | null, number>>();
  for (const dm of result.dayModels) {
    const inner = dailyMap.get(dm.dayIndex) ?? new Map<string | null, number>();
    inner.set(dm.modelId, (inner.get(dm.modelId) ?? 0) + dm.totalTokens);
    dailyMap.set(dm.dayIndex, inner);
  }
  const dailyModelUsage: AppUsageSnapshot["dailyModelUsage"] = [];
  for (let di = startDayIndex; di <= endDayIndex; di++) {
    const inner = dailyMap.get(di);
    dailyModelUsage.push({
      date: dayIndexToDate(di),
      models: inner
        ? [...inner.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
        : [],
    });
  }

  // 模型排行 + favorite
  const totalModelTokens = result.models.reduce((s, m) => s + m.totalTokens, 0);
  const models = result.models.map((m) => ({
    modelId: m.modelId,
    totalTokens: m.totalTokens,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    requestCount: m.requestCount,
    share: totalModelTokens > 0 ? m.totalTokens / totalModelTokens : 0,
  }));
  const favoriteModel =
    models.length > 0
      ? { modelId: models[0].modelId, totalTokens: models[0].totalTokens, share: models[0].share }
      : null;

  const tools = result.tools.map((t) => ({
    toolName: t.toolName,
    callCount: t.callCount,
    errorCount: t.errorCount,
    errorRate: t.callCount > 0 ? t.errorCount / t.callCount : 0,
    avgDurationMs: t.avgDurationMs,
  }));

  return {
    range: opts.range,
    generatedAt: opts.generatedAt,
    timeZone: opts.timeZone,
    source: "agent-db",
    summary: {
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheHitRate,
      totalSessions: turnTotals.totalSessions,
      totalTurns: turnTotals.totalTurns,
      toolCallCount: toolTotals.toolCallCount,
      toolErrorRate,
      modelErrorRate,
      avgTimeToFirstTokenMs: totals.avgTimeToFirstTokenMs,
      avgTurnDurationMs: turnTotals.avgTurnDurationMs,
      activeDays,
      currentStreakDays,
      longestSessionMs: turnTotals.longestSessionMs,
      longestStreakDays,
      peakDayTokens: maxTokens,
      favoriteModel,
    },
    heatmap,
    dailyModelUsage,
    models,
    tools,
  };
}
