// INV-01 视图模型整体记忆：守住位置 useMemo；改错故障 设置页刷新时重复派发图表数据。
// INV-02 依赖只有文案与快照：守住位置 依赖数组；改错故障 无关状态变化触发重建。
// INV-03 无令牌走空态：守住位置 总量判断；改错故障 零值饼图显示为空白。
// INV-04 提示项按载荷取切片：守住位置 格式化回调；改错故障 提示标题与颜色错位。
// INV-05 数值缺失回退切片总量：守住位置 类型判断；改错故障 提示显示零。
// INV-06 占比缺失回退零：守住位置 空值合并；改错故障 提示出现 NaN。
// INV-07 颜色优先用载荷色：守住位置 样式取值；改错故障 图例与扇形颜色不一致。
// INV-08 提示内容按格式化函数记忆：守住位置 useMemo；改错故障 每次渲染重建提示节点。
// INV-09 单切片不加间隔：守住位置 角度计算；改错故障 单扇区出现断裂缝。
// INV-10 扇形描边用表面色：守住位置 描边属性；改错故障 扇区间出现高对比白线。
// INV-11 中心总量与单位分层：守住位置 覆盖层；改错故障 长数字挤压单位。
// INV-12 图例与图表同源：守住位置 数据来源；改错故障 两侧顺序或占比不一致。
// INV-13 图例为语义列表：守住位置 role；改错故障 读屏软件无法逐项朗读。
// INV-14 每行占比与用量并列：守住位置 行结构；改错故障 只有比例没有绝对值。
// INV-15 末行不画分隔线：守住位置 样式；改错故障 列表底部出现多余横线。
// INV-16 边距常量固定：守住位置 图表参数；改错故障 小屏扇形被裁切。
// INV-17 文案全部走国际化：守住位置 消息 id；改错故障 标题与空态不随语言切换。
// INV-18 紧凑单位随语言格式化：守住位置 格式化调用；改错故障 数字单位与语言不匹配。
//
// 模块职责：渲染按模型拆分的令牌用量饼图与图例。
// 状态所有权：无状态；数据由快照经视图模型一次性算出。
// 阅读顺序：先看视图模型，再看提示格式化，最后看空态与图例。
import { useCallback, useMemo } from "react";
import { Cell, Pie, PieChart } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildAppUsageModelPieChartViewModel,
  type AppUsageModelPieSlice,
} from "@/settings/usage-stats/appUsageModelPieChartViewModel.js";
import {
  UsageEmptyState,
  formatCompactTokenUsage,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// APP_USAGE_MODEL_PIE_CHART_MARGIN 四边都是 4，留白对称。
// 对象带 as const，常量不会被调用方改写。
// 小屏裁切靠 margin 吸收，不改 Pie 半径。
// margin 只作用于图表，与图例列宽无关。
const APP_USAGE_MODEL_PIE_CHART_MARGIN = {
  top: 4,
  right: 4,
  bottom: 4,
  left: 4,
} as const;

// useZCodeIntl 一次取出 intl 与 locale。
// buildAppUsageModelPieChartViewModel 一次产出 chartConfig 与 chartData。
// totalModelTokens 决定空态与图表分支。
// 提示与图例读同一份 chartData，顺序不会分叉。
// 组件只持有 memo 结果，不引入业务状态。
export function AppUsageModelUsagePieChart({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { chartConfig, chartData, totalModelTokens } = useMemo(
    // Recharts 会镜像 data/config props 到内部 store；稳定饼图数据可避免设置页刷新时重复派发。
    () => buildAppUsageModelPieChartViewModel({ intl, snapshot }),
    [intl, snapshot],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  // item.payload 先按 AppUsageModelPieSlice 断言再取字段。
  // typeof value === "number" 不成立时回退 slice.totalTokens。
  // slice.share 缺失时按 0 处理，避免 NaN。
  // 色块 span 与文本 div 分开排版，圆点不吃 flex 宽度。
  // useCallback 依赖 [locale, tokenUnit]，语言或单位变化才重建。
  const formatTooltipItem = useCallback(
    (value: unknown, _name: unknown, item: { color?: string; payload?: unknown }) => {
      const slice = item.payload as AppUsageModelPieSlice | undefined;
      const totalTokens = typeof value === "number" ? value : (slice?.totalTokens ?? 0);
      const share = slice?.share ?? 0;
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: item.color ?? slice?.color }}
          />
          <div className="grid min-w-0 flex-1 gap-1">
            <div className="truncate text-foreground-subtle">{slice?.label ?? String(_name)}</div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-baseline gap-1 text-foreground">
                <span className="font-mono font-medium tabular-nums">
                  {formatCompactTokenUsage(locale, totalTokens)}
                </span>
                <span className="text-foreground-subtle">{tokenUnit}</span>
              </span>
              <span className="font-mono text-foreground-subtle tabular-nums">
                {formatPercent(locale, share)}
              </span>
            </div>
          </div>
        </>
      );
    },
    [locale, tokenUnit],
  );
  // tooltipContent 只依赖 formatTooltipItem，图表重排不重建节点。
  // hideLabel 关掉重复标签，提示只留一行正文。
  // indicator="line" 让指示线跟随切片颜色。
  // useMemo 复用提示节点，减少 Recharts 内部 store 重排。
  const tooltipContent = useMemo(
    () => <ChartTooltipContent hideLabel indicator="line" formatter={formatTooltipItem} />,
    [formatTooltipItem],
  );

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.modelChartTitle" })}
      </h3>
      {totalModelTokens <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : (
        <div className="grid gap-4 px-3 py-3 md:grid-cols-2">
          <div className="relative mx-auto h-56 w-full max-w-64 self-center md:h-64 md:max-w-72">
            <ChartContainer config={chartConfig} className="relative z-20 h-56 w-full md:h-64">
              <PieChart accessibilityLayer margin={APP_USAGE_MODEL_PIE_CHART_MARGIN}>
                <ChartTooltip cursor={false} content={tooltipContent} />
                <Pie
                  data={chartData}
                  dataKey="totalTokens"
                  nameKey="key"
                  innerRadius="56%"
                  outerRadius="86%"
                  paddingAngle={chartData.length > 1 ? 2 : 0}
                  stroke="var(--color-surface)"
                  strokeWidth={2}
                >
                  {chartData.map((slice) => (
                    <Cell key={slice.key} fill={`var(--color-${slice.key})`} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-8 text-center">
              <div className="max-w-full truncate text-ui-sm font-semibold text-foreground">
                {formatCompactTokenUsage(locale, totalModelTokens)}
              </div>
              <div className="max-w-full truncate text-ui-sm text-foreground-subtle">
                {tokenUnit}
              </div>
            </div>
          </div>
          <div className="min-w-0 self-center" role="list">
            {chartData.map((slice) => (
              <div
                key={slice.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-b border-border/70 py-2 last:border-b-0"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: slice.color }}
                />
                <span className="min-w-0 truncate font-mono text-ui-sm text-foreground">
                  {slice.label}
                </span>
                <span className="font-mono text-ui-sm text-foreground-subtle tabular-nums">
                  {formatPercent(locale, slice.share)}
                </span>
                <span className="col-start-2 min-w-0 truncate text-ui-sm text-foreground-subtle">
                  {formatCompactTokenUsage(locale, slice.totalTokens)} {tokenUnit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
