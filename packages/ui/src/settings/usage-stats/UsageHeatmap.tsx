/* oxlint-disable max-lines -- 热力图在同一文件内维护每日、每周、累计三种展示计算，拆分会割裂共享列模型。 */
// UsageHeatmap 是「设置 · 使用统计」热力图的展示层：把 agent 返回的周数据补齐成固定 52 周 × 7 天网格，
// 并为 daily / weekly / cumulative 三种模式生成色阶、提示文案与底部月份标签。
// 不负责数据采集、聚合口径、远端裁剪与单元格渲染（单元格见 UsageHeatmapCells.tsx）。
//
// INV-01 断言：展示网格恒为 52 列 × 7 天 —— 守住它的位置：buildDisplayHeatmapWeeks 的 Array.from —— 改错故障：列数变化会让月份标签与热力块错位，底部月份条对不上列。
// INV-02 断言：所有日期换算走 UTC 毫秒 —— 守住它的位置：dateKeyToUtcDayIndex 与 utcDayIndexToDateKey —— 改错故障：跨时区用户整张热力图偏移一天，周日列错位。
// INV-03 断言：无法解析的日期被丢弃而不是当成今天 —— 守住它的位置：dateKeyToUtcDayIndex 返回 null 及其后的过滤 —— 改错故障：脏数据把整个网格平移到错误周期。
// INV-04 断言：无任何有效日期时原样返回入参 weeks —— 守住它的位置：buildDisplayHeatmapWeeks 的 datedCells 空数组早退 —— 改错故障：空数据仍渲染 52 周假网格，看起来像加载失败。
// INV-05 断言：展示网格右端对齐真实数据最新一天所在自然周的周日 —— 守住它的位置：endWeekStartDayIndex —— 改错故障：最新数据被挤出可见列，用户以为统计延迟。
// INV-06 断言：补齐的空单元格 totalTokens 与 level 均为 0 —— 守住它的位置：createEmptyHeatmapCell —— 改错故障：空白周出现颜色块，虚报使用量。
// INV-07 断言：非零值至少映射为 level 1 —— 守住它的位置：levelForValue 的 Math.max(1, …) —— 改错故障：极小用量与 0 同色，热力图漏点。
// INV-08 断言：等级上限固定为 4 —— 守住它的位置：levelForValue 的 Math.min(4, …) —— 改错故障：超出四档色板索引，单元格取不到样式。
// INV-09 断言：周与累计视图的柱高在 1 到 7 行之间 —— 守住它的位置：filledRowsForValue —— 改错故障：非零周不显示，或柱子溢出进相邻周。
// INV-10 断言：单周柱形从底部向上填充 —— 守住它的位置：buildWeeklyLikeHeatmapColumns 的 isFilled 判断 —— 改错故障：柱子从顶部垂下，与越近越多的阅读方向相反。
// INV-11 断言：累计模式的数值是前缀和而非周增量 —— 守住它的位置：values 的 reduce 累加 —— 改错故障：累计图与周视图完全相同，切换失去意义。
// INV-12 断言：三种模式各有独立的提示文案键且与 countMetric 对应 —— 守住它的位置：三个 render 系列函数里的 id 三元 —— 改错故障：Coding Plan 的工具调用数被标成消息轮数。
// INV-13 断言：月份标签 span 之和恒等于列数 —— 守住它的位置：buildHeatmapMonthLabels 的合并与保留分支 —— 改错故障：底部月份条比网格短，标签整体左移。
// INV-14 断言：底部最多显示 12 个月文案 —— 守住它的位置：HEATMAP_VISIBLE_MONTH_LABEL_COUNT 与 hiddenLabelCount —— 改错故障：首尾同月文案重复，用户误读为两个统计周期。
// INV-15 断言：热力网格与月份条共用同一份 gridTemplateColumns —— 守住它的位置：HEATMAP_GRID_STYLE 及两处 style 引用 —— 改错故障：两层列宽不一致，月份文案漂移半列。
// INV-16 断言：视图模式只由组件内 useState 持有 —— 守住它的位置：UsageHeatmap 的 mode —— 改错故障：与父级受控值冲突，切换标签后热力图不刷新。
import { useState } from "react";
import type { AppUsageHeatmapCell, AppUsageHeatmapWeek } from "@zcode/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  HeatmapColumn,
  type HeatmapDisplayColumn,
  type TokenActivityMode,
} from "@/settings/usage-stats/UsageHeatmapCells.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatFullDay,
  formatMonth,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// [契约] 52 同时决定网格列数、回填窗口与月份标签格数，改动会一起推移这三处。
// HEATMAP_DAYS_PER_WEEK 只参与铺行与柱高换算，不参与列宽计算。
// 不要按容器宽度动态推导周数：色阶、月份文案和近一年的语义都锚定在这个固定窗口上。
// 若改成按数据起止裁剪，buildDisplayHeatmapWeeks 的起始下标与空数据早退都要重算。
// 列数一旦变化，月份标签 span 之和不再等于列数，底部月份条会比热力块短。
const HEATMAP_DISPLAY_WEEK_COUNT = 52;
const HEATMAP_DAYS_PER_WEEK = 7;
const DAY_MS = 86_400_000;
const HEATMAP_VISIBLE_MONTH_LABEL_COUNT = 12;
const TOKEN_ACTIVITY_MODES = ["daily", "weekly", "cumulative"] as const;
// [权衡] 上方热力网格与下方月份条复用同一份 style，这是两行对齐的唯一保证。
// 列宽用 minmax(0, 1fr) 而不是固定像素：52 列在手机宽度下必须整体收缩，不能出横向滚动条。
// 不要给容器再加 overflow-x，否则会与页面主滚动区争抢手势，移动端横滑会卡住。
// 两处引用只要有一处另写列模板，月份文案立刻偏移半列，且只在窄屏才看得出来。
// 调整重复次数时保持两处共用同一常量，不要就地展开成字面量。
const HEATMAP_GRID_STYLE = {
  // 固定 14px 最小列宽加 4px 间隔会让 52 周网格超过容器，违背一次性完整展示的产品语义。
  // 列宽改回可收缩的 1fr，桌面、Web 和手机端都由同一容器宽度等分，不再产生第二个横向滚动区。
  gridTemplateColumns: `repeat(${HEATMAP_DISPLAY_WEEK_COUNT}, minmax(0, 1fr))`,
};

interface HeatmapMonthLabel {
  key: string;
  label: string;
  span: number;
}

type HeatmapCountMetric = "turns" | "tools";

// [契约] 日视图提示框的 id 由 countMetric 二选一，tokens 始终展示真实总 token。
// turns 与 tools 两个数值都要传进去：占位缺失时 intl 会退回原始 key 文本。
// Coding Plan 远端只提供 mcpCalls，传 turns 会把工具调用数标成消息轮数。
// 日期走 formatFullDay 而不是直接拼 ISO 串，避免英文环境出现 2026-01-01 这类格式。
// 提示文案只在构建列时算一次，单元格渲染不应二次调用 intl，否则悬浮会重复格式化。
function renderHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  cell: AppUsageHeatmapCell,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id: countMetric === "tools" ? "settings.usage.heatmapToolCell" : "settings.usage.heatmapCell",
    },
    {
      date: formatFullDay(locale, cell.date),
      tokens: formatCompactTokenUsage(locale, cell.totalTokens),
      turns: formatCompactNumber(locale, cell.turnCount),
      tools: formatCompactNumber(locale, cell.toolCallCount),
    },
  );
}

// [契约] 周视图的 totalTokens 与 count 都是整周汇总，不再是单日值。
// 传入的 date 是该周最后一天的日期键，提示框据此说明覆盖区间末端。
// turns 与 tools 填同一个 count，是为了复用同一套 i18n 模板占位。
// 不要为省一次计算就改读末列单元格：pad 过的末列可能是空单元格，会让 count 失真。
// 周视图与累计视图的文案键必须分开，把累计值说成本周会让用户误判用量峰值。
function renderWeeklyHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  date: string,
  totalTokens: number,
  count: number,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id:
        countMetric === "tools"
          ? "settings.usage.heatmapWeeklyToolCell"
          : "settings.usage.heatmapWeeklyCell",
    },
    {
      date: formatFullDay(locale, date),
      tokens: formatCompactTokenUsage(locale, totalTokens),
      turns: formatCompactNumber(locale, count),
      tools: formatCompactNumber(locale, count),
    },
  );
}

// [契约] 累计视图的 count 与 totalTokens 是截至该周的前缀和，不是该周增量。
// 文案键单独一套，避免用户把累计曲线读成每周用量波动。
// 日期仍取该周末日，提示框的「截至」语义依赖这个日期。
// 三个 render 系列函数签名保持一致，便于 buildWeeklyLikeHeatmapColumns 用三元切换。
// 不要合并回周视图再靠 mode 判空 id，缺键会直接回落到原始 key 文本。
function renderCumulativeHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  date: string,
  totalTokens: number,
  count: number,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id:
        countMetric === "tools"
          ? "settings.usage.heatmapCumulativeToolCell"
          : "settings.usage.heatmapCumulativeCell",
    },
    {
      date: formatFullDay(locale, date),
      tokens: formatCompactTokenUsage(locale, totalTokens),
      turns: formatCompactNumber(locale, count),
      tools: formatCompactNumber(locale, count),
    },
  );
}

// [契约] 日期键按 UTC 零点解析，任何改用本地时区构造 Date 的写法都会让日索引偏移。
// 东八区用本地解析再取整会得到前一天，整张热力图左移一格且难以自检。
// 解析失败返回 null 而不是 0：0 会把这天钉在 1970 年并参与最大值统计。
// 按 DAY_MS 整除保证同一日期键跨平台得到同一整数，去重与对齐都依赖这一点。
// 不要改成按字符串切片手算天数，闰年与月末会在跨年边界出错。
function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function getUtcWeekday(dayIndex: number): number {
  return new Date(dayIndex * DAY_MS).getUTCDay();
}

function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

// [契约] 补齐单元格必须是全零：level 为 0 才不会给空白周染色。
// 这类单元格只代表该日无数据，不能据此断言用户当天确实没有使用。
// 字段顺序与 AppUsageHeatmapCell 保持一致，避免结构化比较时出现意外差异。
// 不要在这里复用同一个对象实例，多列共享会在后续被就地修改时互相污染。
// 若给空单元格补上非零默认值，levelForValue 与柱高计算会被整体带偏。
function createEmptyHeatmapCell(date: string): AppUsageHeatmapCell {
  return {
    date,
    level: 0,
    totalTokens: 0,
    turnCount: 0,
    toolCallCount: 0,
  };
}

// [契约] 无论入参覆盖多少天，输出恒为 52 周，这是网格与月份标签共存的前提。
// 以真实数据里最大的日索引为锚点，右端对齐该日所在自然周的周日。
// 按日期键建 Map 去重：重叠周的同一天以最后一次出现为准。
// 后端只返回近 30 天时，其余列由空单元格补齐，不能直接渲染稀疏网格。
// 不要改成以今天为锚点：远端数据滞后时最新区间会被整体移出可见范围。
function buildDisplayHeatmapWeeks(weeks: AppUsageHeatmapWeek[]): AppUsageHeatmapWeek[] {
  const cells = weeks
    .flatMap((week) => week.days)
    .filter((cell): cell is AppUsageHeatmapCell => cell !== null);
  const datedCells = cells
    .map((cell) => ({ cell, dayIndex: dateKeyToUtcDayIndex(cell.date) }))
    .filter(
      (entry): entry is { cell: AppUsageHeatmapCell; dayIndex: number } => entry.dayIndex !== null,
    );

  // [失败路径] 全部日期都无法解析时原样返回入参，不再造 52 周假网格。
  // 返回稀疏数组是刻意的：调用方按周读取时能看出确实没有数据。
  // 不要改成返回空数组，UsageHeatmap 会渲染出 0 列且月份条为空，看起来像白屏故障。
  // 触发场景是远端返回空字符串或非法日期键，因此不能假设至少有一天有效数据。
  // 早退放在建立 Map 之前，避免对数万条无效记录做无意义索引。
  if (datedCells.length === 0) {
    return weeks;
  }

  const cellsByDate = new Map(datedCells.map(({ cell }) => [cell.date, cell] as const));
  const endDayIndex = Math.max(...datedCells.map(({ dayIndex }) => dayIndex));
  const endWeekStartDayIndex = endDayIndex - getUtcWeekday(endDayIndex);
  const startDayIndex =
    endWeekStartDayIndex - (HEATMAP_DISPLAY_WEEK_COUNT - 1) * HEATMAP_DAYS_PER_WEEK;

  // agent 只返回近 30 天真实数据会让热力图缩水；这里补齐展示用 0 格，
  // 同时按自然周对齐，保证所有范围的第一行都是周日。
  return Array.from({ length: HEATMAP_DISPLAY_WEEK_COUNT }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: HEATMAP_DAYS_PER_WEEK }, (_, dayOffset) => {
      const dayIndex = startDayIndex + weekIndex * HEATMAP_DAYS_PER_WEEK + dayOffset;
      const date = utcDayIndexToDateKey(dayIndex);
      return cellsByDate.get(date) ?? createEmptyHeatmapCell(date);
    }),
  }));
}

// [契约] 非零值至少落到 level 1，上限固定为 4，与主题的四档色板一一对应。
// 用 Math.ceil 而不是 floor：占比不足一档的值本该显示为一档，不该与空白天同色。
// max 取当前视图整批数据的最大值，色阶始终相对本次视图归一化，不能用固定阈值。
// value 或 max 非正时返回 0，防止 0 除以 0 得到 NaN 拼进类名。
// 改上限就必须同步改 UsageHeatmapCells 的色板，否则会渲染出没有样式的格子。
function levelForValue(value: number, max: number): AppUsageHeatmapCell["level"] {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as AppUsageHeatmapCell["level"];
}

// [契约] 周与累计视图的柱高在 1 到 7 行之间，非零周至少占一行。
// 上限取 HEATMAP_DAYS_PER_WEEK，超出会把柱子画进上一周，视觉上跨周重叠。
// 与 levelForValue 共用同一套 ceil 归一化，柱高与颜色深浅才不会互相矛盾。
// 返回行数而不是布尔值，是为了让 isFilled 用固定阈值从底部向上取行。
// value 非正时返回 0，避免柱高为负导致整周列被填满。
function filledRowsForValue(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(
    HEATMAP_DAYS_PER_WEEK,
    Math.max(1, Math.ceil((value / max) * HEATMAP_DAYS_PER_WEEK)),
  );
}

// [契约] 列内出现每月 1 日时该列归入新月份，月份文案锚定在这个 1 日。
// 只用周日起始日判断会把 1 日推迟到下一列，月初月末的边界文案整体错开一格。
// 找不到 1 日时退回周一列首日，再退回第一个非空日期，最后才给空串。
// 空串会让 buildHeatmapMonthLabels 的 slice 得到空月份键，相邻列被强行合并后 span 异常。
// 不要改成取周内出现次数最多的月份：边界周会随机归属，月份文案来回跳动。
function resolveHeatmapColumnMonthDate(week: AppUsageHeatmapWeek): string {
  // 用周日判断月份会把非周日的每月 1 日推迟到下一周，月份文案最多错开一列。
  // 周列包含 1 日时优先归入新月份，让文案锚定到 1 日所在列；其余列沿用周日起始月份。
  const firstDayOfMonth = week.days.find((cell) => cell?.date.endsWith("-01"));
  return firstDayOfMonth?.date ?? week.days[0]?.date ?? week.days.find(Boolean)?.date ?? "";
}

// [契约] 日视图每格独立着色，columnHover 为 false，悬浮只高亮单个单元格。
// cell 为 null 时用该周首日兜底，只为保证 key 可渲染，不代表真实日期。
// 首日也缺失时兜底成 empty-周序-日序，防止整周为空时所有格子 key 相同。
// level 直接透传单元格等级，日视图不再按周归一化，跨列深浅可以直接比较。
// hasUsage 用 totalTokens 判断而不是 level，避免 0 级但仍有轮数的格子被当成无使用。
function buildDailyHeatmapColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  return weeks.map((week) => ({
    key: `daily-${week.weekIndex}`,
    monthDate: resolveHeatmapColumnMonthDate(week),
    tooltipTitle: null,
    cells: week.days.map((cell, dayOffset) => {
      const fallbackDate = week.days[0]?.date ?? `empty-${week.weekIndex}-${dayOffset}`;
      const displayCell = cell ?? createEmptyHeatmapCell(fallbackDate);
      return {
        key: `daily-${displayCell.date}`,
        level: displayCell.level,
        hasUsage: displayCell.totalTokens > 0,
        columnHover: false,
        tooltipTitle: renderHeatmapTooltipTitle(locale, intl, displayCell, countMetric),
      };
    }),
  }));
}

// [契约] weekly 用每周增量，cumulative 用前缀和，两者共用同一套柱高与色阶换算。
// maxValue 取累计数组最后一项，因为前缀和单调不减，末项即最大值。
// 计数在 reduce 内按 countMetric 一次选定，避免先算两套再挑一套。
// weekEndDate 依次取第 7 天、最后一个非空日期、空串，保证提示框总有可读日期。
// cells 只在底部 filledRows 行给 level，其余行强制 0，柱形不会出现中间断层。
function buildWeeklyLikeHeatmapColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  mode: Extract<TokenActivityMode, "weekly" | "cumulative">,
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  const weeklyTotals = weeks.map((week) =>
    week.days.reduce((sum, cell) => sum + (cell?.totalTokens ?? 0), 0),
  );
  const weeklyCounts = weeks.map((week) =>
    week.days.reduce(
      (sum, cell) =>
        sum + (countMetric === "tools" ? (cell?.toolCallCount ?? 0) : (cell?.turnCount ?? 0)),
      0,
    ),
  );
  const values =
    mode === "weekly"
      ? weeklyTotals
      : weeklyTotals.reduce<number[]>((acc, total) => {
          acc.push((acc.at(-1) ?? 0) + total);
          return acc;
        }, []);
  const countValues =
    mode === "weekly"
      ? weeklyCounts
      : weeklyCounts.reduce<number[]>((acc, total) => {
          acc.push((acc.at(-1) ?? 0) + total);
          return acc;
        }, []);
  const maxValue = Math.max(0, ...values);

  return weeks.map((week, weekIndex) => {
    const value = values[weekIndex] ?? 0;
    const count = countValues[weekIndex] ?? 0;
    const level = levelForValue(value, maxValue);
    const filledRows = filledRowsForValue(value, maxValue);
    const weekEndDate =
      week.days[HEATMAP_DAYS_PER_WEEK - 1]?.date ??
      week.days.findLast((cell) => cell !== null)?.date ??
      "";
    const tooltipTitle =
      mode === "weekly"
        ? renderWeeklyHeatmapTooltipTitle(locale, intl, weekEndDate, value, count, countMetric)
        : renderCumulativeHeatmapTooltipTitle(locale, intl, weekEndDate, value, count, countMetric);

    return {
      key: `${mode}-${week.weekIndex}`,
      monthDate: resolveHeatmapColumnMonthDate(week) || weekEndDate,
      tooltipTitle,
      cells: week.days.map((cell, dayOffset) => {
        const isFilled = dayOffset >= HEATMAP_DAYS_PER_WEEK - filledRows;
        return {
          key: `${mode}-${cell?.date ?? `${week.weekIndex}-${dayOffset}`}`,
          level: isFilled ? level : 0,
          hasUsage: isFilled && value > 0,
          columnHover: true,
        };
      }),
    };
  });
}

function buildHeatmapDisplayColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  mode: TokenActivityMode,
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  if (mode === "daily") {
    return buildDailyHeatmapColumns(locale, intl, weeks, countMetric);
  }
  return buildWeeklyLikeHeatmapColumns(locale, intl, weeks, mode, countMetric);
}

// [契约] 相邻同月列合并为一个标签并累加 span，标签 span 之和必须等于列数。
// 跨 13 个月时清空最早标签的文字但保留 span，只隐藏文字不删列，网格才不会错位。
// 清空用的是把 label 置为空串而不是删除数组项，删除会让后续标签横移一列。
// lastLabel 通过 at(-1) 取得，标签数组下标与列号已不一一对应，不能当列索引用。
// formatMonth 只在新建标签时调用一次，其他位置不要重复计算月份文案。
function buildHeatmapMonthLabels(
  locale: string,
  columns: HeatmapDisplayColumn[],
): HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = [];

  for (const column of columns) {
    const monthKey = column.monthDate.slice(0, 7);
    const lastLabel = labels.at(-1);
    if (lastLabel?.key === monthKey) {
      lastLabel.span += 1;
    } else {
      labels.push({
        key: monthKey,
        label: formatMonth(locale, column.monthDate),
        span: 1,
      });
    }
  }

  // 52 个自然周可能横跨 13 个月，直接渲染会在底部同时出现去年和今年的同月文案。
  // 保留多余起始月份的 span 以维持月份与周列对齐，只隐藏其文字，底部始终最多显示最近 12 个月。
  const hiddenLabelCount = Math.max(0, labels.length - HEATMAP_VISIBLE_MONTH_LABEL_COUNT);
  for (let index = 0; index < hiddenLabelCount; index += 1) {
    const label = labels[index];
    if (label) {
      label.label = "";
    }
  }

  return labels;
}

// [契约] 视图模式是组件内 useState，父级切换数据源时不会重置当前模式。
// countMetric 默认 turns，Coding Plan 场景必须显式传 tools，否则提示文案口径错误。
// 每次渲染都重算展示网格且不加 memo：入参 weeks 是新建数组，缓存只会命中失效引用。
// 响应式只依赖外层容器宽度，52 列与其等分，组件内部不读取窗口尺寸。
// 组件只做展示投影，不做统计聚合，把聚合搬进来会产生第二份事实源。
export function UsageHeatmap({
  locale,
  intl,
  weeks,
  countMetric = "turns",
}: {
  locale: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  weeks: AppUsageHeatmapWeek[];
  /** Coding Plan 远端只提供 mcpCalls；App Usage 才提供真实消息轮数。 */
  countMetric?: HeatmapCountMetric;
}) {
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const displayWeeks = buildDisplayHeatmapWeeks(weeks);
  const displayColumns = buildHeatmapDisplayColumns(locale, intl, displayWeeks, mode, countMetric);
  const monthLabels = buildHeatmapMonthLabels(locale, displayColumns);

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-surface px-3 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.heatmapTitle" })}
          </h3>
          <Tabs
            value={mode}
            onValueChange={(value) => setMode(value as TokenActivityMode)}
            className="shrink-0"
          >
            <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
              {TOKEN_ACTIVITY_MODES.map((option) => (
                <TabsTrigger
                  key={option}
                  value={option}
                  onClick={() => setMode(option)}
                  className={USAGE_STATS_TABS_TRIGGER_CLASS}
                >
                  {intl.formatMessage({
                    id: `settings.usage.heatmap.range.${option}`,
                  })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div>
          <div className="grid w-full gap-x-0.5" style={HEATMAP_GRID_STYLE}>
            {displayColumns.map((column) => (
              <HeatmapColumn key={column.key} column={column} mode={mode} />
            ))}
          </div>
          <div className="mt-3 grid w-full gap-x-0.5" style={HEATMAP_GRID_STYLE}>
            {monthLabels.map((label) => (
              <div
                key={label.key}
                data-usage-heatmap-month-label
                className="min-w-0 truncate text-ui-sm text-foreground-subtle"
                style={{ gridColumn: `span ${label.span}` }}
              >
                {label.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
