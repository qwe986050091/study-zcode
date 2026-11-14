// INV-01 [契约] 色板 6 个槽位与可见系列的截取上限必须一致；守住位置：LINE_CHART_COLORS 数组与 visibleSeries 的截取上限；改错故障：上限大于色板时后几条线拿到同一个颜色，图例再也分不清系列。
// INV-02 [失败路径] 取色按取模回落首位，越界不返回空值；守住位置：getLineChartColor 的取模与空值合并；改错故障：去掉回落后 stroke 变成无色折线，图例圆点同步消失。
// INV-03 [契约] 折线颜色不直接取色板值，而是用容器注入的系列变量；守住位置：Line 的 stroke 模板串与 chartConfig 的 color 字段；改错故障：把 stroke 换成色板直值后，主题切换与容器配色全部失效。
// INV-04 [契约] 行对象的键必须与 Line 的 dataKey 同源；守住位置：buildChartData 内的行字段写入与 series 遍历；改错故障：键名分叉后折线全空，图上只剩一排日期刻度。
// INV-05 [失败路径] 缺失的采样点补 0 而不是留空；守住位置：buildChartData 内层对 values 下标的空值合并；改错故障：空值进入图表后折线断裂，提示浮层显示 NaN。
// INV-06 [契约] 时间文案先分流 hour 粒度，再走日期格式化；守住位置：formatChartTime 的粒度分支与区域分支；改错故障：小时粒度被当成日期解析，横轴退回原始时间串。
// INV-07 [失败路径] 无法解析的时间原样返回；守住位置：formatChartTime 的 NaN 判定与提前返回；改错故障：非法样本渲染成无效日期文案，整条横轴不可读。
// INV-08 [权衡] 刻度稀疏按样本数分档，首尾永远保留；守住位置：shouldShowXAxisLabel 的 14 与 45 两个阈值、5 与 7 两个步长；改错故障：阈值下调后长周期只剩两三个日期，短周期反而被隐藏。
// INV-09 [契约] 隐藏刻度靠格式器返回空串，而不是让轴自行跳刻度；守住位置：XAxis 的 interval、minTickGap 与 shouldShowAxisLabel 的三元；改错故障：改成自行抽稀后首尾日期被裁，安全区白留。
// INV-10 [资源] 轴格式器只依赖样本数，不依赖样本内容；守住位置：shouldShowAxisLabel 的 useCallback 依赖数组；改错故障：依赖图表数据会让格式器每次刷新重建，整条横轴跟着重渲染。
// INV-11 [事务] 可见系列、图表配置、行数据、提示浮层全部由 memo 派生；守住位置：五个 useMemo 与 series 引用；改错故障：每次渲染交出新数组，图表内部 store 反复替换，设置页刷新可见闪烁。
// INV-12 [契约] 可见系列同时是图例、配色与折线的唯一事实源；守住位置：visibleSeries 之后的图例映射与 Line 映射；改错故障：任一处直接读原始 series，会出现图例三条、折线六条的错位。
// INV-13 [契约] 纵轴上限取全系列最大值，下界固定为 0；守住位置：maxValue 的展开求值与 YAxis 的 domain；改错故障：按单系列取上限会把其它线裁到图外，下界浮动则零点漂移。
// INV-14 [失败路径] 全零、无系列、无时间点统一降级为空态；守住位置：渲染前的三分支判定与 UsageEmptyState；改错故障：跳过该判定后全零数据画出一条贴底直线，肉眼像「有量」。
// INV-15 [契约] 空态判定必须排在所有 hook 之后；守住位置：条件返回的位置与上方 memo、callback 的排列；改错故障：提前返回让 hook 数量随数据变化，渲染期直接报错。
// INV-16 [契约] 数值走紧凑格式，token 与速度两种口径分开；守住位置：formatTooltipItem 的三元链与 formatCompactTokenUsage 分支；改错故障：token 用通用紧凑格式会丢量级，速度缺后缀看不出量纲。
// INV-17 [契约] 提示浮层的名称与颜色在配置缺失时回落到系列键；守住位置：formatTooltipItem 的两处空值合并；改错故障：取不到配置时标题留白，圆点透明不可见。
// INV-18 [权衡] 图例可关，网格与轴线风格固定；守住位置：showLegend 门控与 CartesianGrid、XAxis 的固定属性；改错故障：打开竖网格或轴线后折线区被切成方块，读数被干扰。
//
// 模块职责：用量统计页的折线图渲染器，把按时间分桶的序列转成 Recharts 可消费的行数据，并统一处理配色、刻度、提示浮层与空态。
// 状态所有权：组件完全无状态，入参 xTime、granularity、series 由调用方持有；派生的可见系列、配置与行数据只在本渲染周期内存在。
// 阅读顺序：先看色板与边距常量，再看三个纯函数（时间文案、刻度稀疏、行数据装配），然后是组件内的派生 memo、提示浮层，最后是空态与图例、坐标轴。
import { useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { CodingPlanUsageGranularity } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// [契约] 色板是唯一配色来源，六个槽位对应 usage-chart-1 到 usage-chart-6 的设计变量。
// [契约] 槽位数与下方截取上限同为 6，改任一处都要同步另一处。
// [权衡] 用变量而不是字面色值，深浅主题与设置页换肤才能自动跟随。
// [失败路径] 变量名写错时取到空值，圆点与折线在浅色主题下几乎不可见。
// [资源] 数组只读使用，无需 memo，取色走纯函数即可。
const LINE_CHART_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
];
// XAxis 首尾刻度以绘图区边界为中心向两侧延伸，左右安全区太小会裁掉
// System health 等折线图的首尾日期文本。
// [契约] 左右各留 24，保证首尾日期文本不被绘图区边界裁掉，上边 8 给最高点留呼吸。
// [权衡] 只留左右不留大的上下边距，是为了让固定高度容器里的折线尽量占满。
// [失败路径] 把 right 或 left 调小后首尾刻度回到轴心，文本被视口截断一半。
// [契约] 该常量以字面量断言固定，禁止运行期改写，避免不同调用点算出不同边距。
const CODING_PLAN_LINE_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;

type CodingPlanLineChartRow = {
  label: string;
  time: string;
} & Record<string, number | string>;

function getLineChartColor(index: number): string {
  return LINE_CHART_COLORS[index % LINE_CHART_COLORS.length] ?? LINE_CHART_COLORS[0]!;
}

// [契约] 入参固定为区域、原始时间串与粒度，返回值只用作横轴刻度文本，不参与求值。
// [契约] hour 粒度直接截前 5 位，因为上游已按小时分钟组织时间串，不再二次解析。
// [失败路径] hour 分支若放在日期解析之后，时间串会被补成当天零点，整条横轴变成同一个日期。
// [契约] 非 hour 分支交给区域格式化，短月加日序，避免中英文下文案过长互相挤压。
// [失败路径] 解析失败返回原串，是给非法样本留的显式降级，不能改成空串或占位符。
// [权衡] 每次调用新建格式化器，换取 locale 变化立即生效，样本量只有几十个可以接受。
function formatChartTime(
  locale: string,
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
  if (granularity === "hour") {
    return value.slice(0, 5);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}

// [契约] 样本不超过 14 个时全量显示，横轴密度仍在可读范围。
// [契约] 超过 14 个开始抽稀，超过 45 个改用 7 的步长，长周期才不会挤成一条黑带。
// [契约] 首尾两个下标无条件显示，保证区间起点与终点始终可读。
// [失败路径] 去掉首尾特判后，步长恰好错过末位，用户看不到统计截止的那一天。
// [权衡] 用步长取模而不是均分，刻度位置稳定，刷新时不会左右跳动。
// [契约] 返回布尔而不是文本，隐藏动作与文案拼装分离在调用侧完成。
function shouldShowXAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

// [契约] 行数严格等于时间点数量，一行对应一个横轴刻度。
// [契约] 每行先写格式化标签与原始时间，时间字段留给提示浮层与排序使用。
// [契约] 系列值按列写入，内层遍历顺序决定列的插入次序，也就是折线的绘制次序。
// [失败路径] 下标越界或缺失统一补 0，不能让空值进入图表的数据通道。
// [契约] 返回值是普通对象数组，不夹带额外引用，memo 只需比较输入。
// [权衡] 每行都复制一份标签文本，换取零查找成本，样本量级下内存可忽略。
function buildChartData(
  locale: string,
  xTime: string[],
  granularity: CodingPlanUsageGranularity,
  series: Array<{ key: string; values: number[] }>,
): CodingPlanLineChartRow[] {
  return xTime.map((time, index) => {
    const row: CodingPlanLineChartRow = {
      label: formatChartTime(locale, time, granularity),
      time,
    };
    for (const item of series) {
      row[item.key] = item.values[index] ?? 0;
    }
    return row;
  });
}

export function CodingPlanUsageLineChart({
  xTime,
  granularity,
  series,
  emptyDescription,
  valueKind = "count",
  showLegend = true,
}: {
  xTime: string[];
  granularity: CodingPlanUsageGranularity;
  series: Array<{ name: string; values: number[] }>;
  emptyDescription: string;
  valueKind?: "count" | "credit" | "speed" | "token";
  showLegend?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  // [契约] 只取前 6 个系列，超出部分静默丢弃，与色板容量对齐。
  // [契约] 系列键重写成固定前缀加序号，屏蔽上游同名或含特殊字符的名称。
  // [契约] 键一旦生成就贯穿配置、行数据、图例与折线的取值字段。
  // [契约] 颜色在 `visibleSeries` 里一次性分配，图例圆点与提示浮层复用同一份。
  // [并发] 依赖只有 series 引用，上游保持引用稳定时整条派生链不重算。
  // [权衡] 展开复制系列对象，换取不修改入参，避免宿主数组被写入派生字段。
  // [失败路径] 若改成原地赋值，宿主缓存的系列会带上键与颜色，第二次进入数据错位。
  const visibleSeries = useMemo(
    // Recharts 对 series、legend、tooltip props 的引用变化很敏感。
    // 稳定派生数据，避免设置页刷新时图表内部 store 出现重复 replace 更新。
    () =>
      series.slice(0, 6).map((item, index) => ({
        ...item,
        key: `series${index}`,
        color: getLineChartColor(index),
      })),
    [series],
  );
  const maxValue = useMemo(
    () => Math.max(0, ...visibleSeries.flatMap((item) => item.values)),
    [visibleSeries],
  );

  const chartConfig = useMemo(
    () =>
      visibleSeries.reduce<ChartConfig>((config, item) => {
        config[item.key] = {
          label: item.name,
          color: item.color,
        };
        return config;
      }, {}),
    [visibleSeries],
  );
  const chartData = useMemo(
    () => buildChartData(locale, xTime, granularity, visibleSeries),
    [granularity, locale, visibleSeries, xTime],
  );
  const shouldShowAxisLabel = useCallback(
    (value: string, index: number) => (shouldShowXAxisLabel(index, chartData.length) ? value : ""),
    [chartData.length],
  );
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">
                {typeof value === "number"
                  ? valueKind === "token"
                    ? formatCompactTokenUsage(locale, value)
                    : formatCompactNumber(locale, value)
                  : String(value)}
              </span>
              {typeof value === "number" && valueKind === "speed" ? (
                <span className="text-foreground-subtle">tokens/s</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, locale, valueKind],
  );
  const tooltipContent = useMemo(
    () => (
      <ChartTooltipContent
        indicator="line"
        labelFormatter={(label) => String(label)}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem],
  );

  // [契约] 空态要 3 个条件同时成立：`visibleSeries` 无项 且 无时间点 且 全零。
  // [权衡] 全零也降级为空态，而不是画一条贴底直线，避免把「没量」看成「有量」。
  // [契约] 空态复用统一的 UsageEmptyState，标题走国际化词条，描述由调用方传入。
  // [契约] 判定放在组件体尾部，所有 hook 已执行完毕，条件返回不改变 hook 数量。
  // [失败路径] 把判定提前到 memo 之前，会因 hook 数量随数据变化而触发渲染错误。
  // [契约] 纵轴上限此时必为正数，domain 上界有效，不会出现零高度绘图区。
  // [权衡] 空态不渲染图例与容器，省掉一次图表实例化，也避免留下占位空白框。
  // [失败路径] 若放宽为零值仍然渲染，提示浮层会在贴底线上给出 0 的假读数。
  if (visibleSeries.length === 0 || xTime.length === 0 || maxValue <= 0) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className="px-3 py-3">
      {showLegend ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
          {visibleSeries.map((item) => (
            <div
              key={item.key}
              className="flex min-w-0 items-center gap-2 text-ui-sm"
              role="listitem"
            >
              <span
                className="size-2 shrink-0 self-center rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="truncate text-foreground-subtle">{item.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      <ChartContainer config={chartConfig} className="h-64 w-full">
        <LineChart accessibilityLayer data={chartData} margin={CODING_PLAN_LINE_CHART_MARGIN}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={0}
            minTickGap={0}
            tickMargin={8}
            tickFormatter={shouldShowAxisLabel}
          />
          <YAxis hide domain={[0, maxValue]} />
          <ChartTooltip cursor={false} content={tooltipContent} />
          {visibleSeries.map((item) => (
            <Line
              key={item.key}
              dataKey={item.key}
              type="monotone"
              stroke={`var(--color-${item.key})`}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
