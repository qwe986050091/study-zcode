// 每日模型趋势图：把 App Usage 快照的日序列投影成 Recharts 多折线，统一 tooltip、空态与主题色。
// 本文件不持有业务状态，只做展示投影：输入快照变化时整体重建视图模型，组件层不再各自推导。
// 覆盖范围：日序列聚合、模型维度堆叠顺序、Y 轴上限、tooltip 取值、空数据占位、主题色映射、memo 依赖。
// 阅读方式：编号条目写的是不变量而非实现说明，「守住位置」指必须保持该语义的函数或分支，「改错故障」是用户可见后果。
// INV-01 日序列以 date 为唯一键聚合，同日多条目累加而非覆盖；守住位置：buildDailyModelChartData 的行 Map 写入；改错故障：分片数据只剩最后一条，日内用量被低估。
// INV-02 行顺序按日期字典序升序，不接受 Map 插入顺序；守住位置：buildDailyModelChartData 的扁平化与排序；改错故障：后端乱序返回时曲线回折成锯齿，趋势被误读。
// INV-03 每一行必须预填全部模型键为 0，缺失键不能留空；守住位置：createEmptyChartRow 的填充循环；改错故障：部分模型缺失的日期出现折线缺口，像是数据丢失。
// INV-04 未知模型（映射未命中）只累加行总量、不新增图例键；守住位置：buildDailyModelChartData 的键存在性分支；改错故障：tooltip 总量与卡片总额对不上，且图例无限膨胀。
// INV-05 模型维度顺序严格继承快照排序，前 6 个进入图例与折线，禁止重排；守住位置：buildAppUsageDailyModelChartViewModel 的截断；改错故障：颜色序号与图例错位，用户把甲模型的量看成乙模型。
// INV-06 颜色只由序号经调色板推导，图例与折线共用同一来源；守住位置：modelKeys 构造与图例色块渲染；改错故障：折线与图例同序不同色，hover 归属混淆。
// INV-07 折线颜色以 CSS 变量名引用，且变量名与 chartConfig 注入项一一对应；守住位置：Line 的 stroke 与 ChartContainer 的 config；改错故障：切换主题后折线透明或退回默认色。
// INV-08 Y 轴上限取可见序列的单点峰值，不取每日总量之和；守住位置：maxTokens 聚合循环；改错故障：多模型叠加把曲线压成贴底直线，趋势不可读。
// INV-09 空态唯一判据为上限小于等于零，同时覆盖无记录与全零两种输入；守住位置：趋势图组件的渲染分支；改错故障：空账号看到空白画布而不是引导文案。
// INV-10 tooltip 条目必须先剔除零值与非有限值；守住位置：filterDailyModelTooltipPayload；改错故障：hover 列出全天全部模型，用户以为零用量模型当天有消耗。
// INV-11 tooltip 数值非有限时原样回显并留空单位；守住位置：resolveDailyModelTooltipTokenParts 的提前返回；改错故障：脏数据让整块 tooltip 渲染中断或显示 NaN。
// INV-12 tooltip 总量取行内 total 字段，不重新累加可见序列；守住位置：formatTooltipLabel；改错故障：被截断的模型被漏算，标题总量小于各图例之和。
// INV-13 tooltip 条目名优先查图表配置标签，未命中才回退数据键；守住位置：formatTooltipItem 的标签解析；改错故障：未翻译的内部键名直接暴露给用户。
// INV-14 视图模型缓存依赖必须列全语言、区域与快照，不得用空数组冻结；守住位置：趋势图组件的 useMemo 依赖；改错故障：切换语言或刷新用量后图表停在旧数据。
// INV-15 派生数组与配置对象随快照稳定重建，仅输入变化时换引用；守住位置：useMemo 返回值；改错故障：图表库内部 store 反复 dispatch，长列表滚动掉帧。
// INV-16 坐标轴抽稀只影响标签文本，不影响数据点与折线连续性；守住位置：刻度可见性判断与 XAxis 配置；改错故障：抽稀后首尾日期消失，用户无法确认统计区间边界。
// INV-17 绘图区左右留白不小于日期文本半宽，首尾刻度以边界为中心向两侧延伸；守住位置：图表 margin 常量；改错故障：首尾日期被 SVG 裁掉半个字，窄屏更明显。
// INV-18 tooltip 内容元素必须缓存且依赖两个格式化回调；守住位置：tooltipContent 的 useMemo；改错故障：hover 时内容整块重挂载，闪烁并丢失过渡动画。
// INV-19 渲染分空态与图表两支，二者互斥且共用同一上限判据；守住位置：趋势图组件返回结构；改错故障：零数据仍挂载坐标系，切换数据时残留上一份图形。
import { type ComponentProps, useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactTokenUsage,
  formatDay,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";

// XAxis 首尾刻度以绘图区边界为中心向两侧延伸，原 8px margin 小于日期文本半宽，
// SVG 会裁掉首尾文字；左右保留 24px 安全区，让桌面端与手机 Web 端都能完整显示短日期。
// 首尾刻度以绘图区边界为中心，文本半宽超出留白时会被 SVG 直接裁切
// 左右 24px 为短日期文本预留安全区，顶部 8px 只留折线描边余量
// 桌面与手机 Web 共用同一组数值，避免两套断点各自漂移
// 缩小该值需同步验证最窄视口，否则首尾日期缺字
export const APP_USAGE_TREND_CHART_MARGIN = {
  top: 8,
  right: 24,
  left: 24,
} as const;

type DailyModelChartRow = {
  label: string;
  tooltipLabel: string;
  total: number;
} & Record<string, number | string>;

type ModelChartKey = {
  modelId: string | null;
  key: string;
  color: string;
  label: string;
};
type UsageIntl = ReturnType<typeof useZCodeIntl>["intl"];
type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

// payload 为空时返回空数组而非 undefined，调用方无需二次判空
// 字符串数值先转数值再判有限，兼容序列化后的快照与远端回放
// 零值与负值一并剔除：它们没有可见数据点，展示即误导
// 是否渲染 tooltip 以过滤结果长度为准，激活标记不能单独作为判据
export function filterDailyModelTooltipPayload<T extends { value?: unknown }>(
  payload: readonly T[] | undefined,
): T[] {
  // Recharts 的多序列 tooltip payload 会包含当天所有模型；
  // 0 用量模型没有可见趋势点，继续展示会误导用户以为 hover 到了有效用量。
  return (payload ?? []).filter((item) => {
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    return Number.isFinite(value) && value > 0;
  });
}

// 非有限数值走原样回显分支且单位留空，避免出现 NaN 与单位拼接
// 格式化只做紧凑化，不再二次裁剪精度，保持与统计卡片同一口径
// 返回结构固定为数值段与单位段，调用方按行内基线分别排版
// 单位文案由调用方注入，函数不读国际化上下文，便于单测直接覆盖
export function resolveDailyModelTooltipTokenParts(
  locale: string,
  value: unknown,
  tokenUnit: string,
): { number: string; unit: string } {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return { number: String(value), unit: "" };
  }
  return {
    number: formatCompactTokenUsage(locale, numericValue),
    unit: tokenUnit,
  };
}

// 十四天及以内逐日展示，不抽稀，保证短周期可逐日对照
// 超过十四天按步长五或七切换，步长随总天数放大以控制标签密度
// 首尾索引强制保留，统计区间边界必须可见
// 该函数只决定标签文本，返回空串时数据点仍然存在
function shouldShowDailyChartAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

// 新建行时把所有模型键显式写零，避免图表库把缺失键当作断点
// 坐标轴标签与 tooltip 标签分离：前者是短日期，后者保留完整日期语义
// 行对象必须自带总量字段，tooltip 标题的总量依赖它而非另算
// 此函数只负责占位，累加职责归日序列聚合函数，两边不能重复求和
function createEmptyChartRow(label: string, tooltipLabel: string, modelKeys: ModelChartKey[]) {
  const row: DailyModelChartRow = {
    label,
    tooltipLabel,
    total: 0,
  };

  for (const model of modelKeys) {
    row[model.key] = 0;
  }

  return row;
}

// 以日期字符串作为 Map 键去重，同日多条目复用同一行对象
// 模型键映射由外部传入，函数不自建映射，保证与图例同源同序
// 未知模型不建新键，只进总量，防止图例随脏数据无限增长
// 返回纯数组而非 Map，调用方拿不到可变的中间容器
function buildDailyModelChartData({
  snapshot,
  locale,
  modelKeys,
  modelKeyById,
}: {
  snapshot: AppUsageSnapshot;
  locale: string;
  modelKeys: ModelChartKey[];
  modelKeyById: Map<string, string>;
}): DailyModelChartRow[] {
  const rows = new Map<string, DailyModelChartRow>();

  // App Usage 的 30d 协议结果已经是每日序列，旧 all 分桶残留把
  // 30 天按周聚合成约 5 个点，导致“最近 30 天”没有连续每日趋势。
  // 三十天协议结果已是每日序列，禁止再按周分桶，否则只剩约五个点
  // 日期键直接取快照字段，不自造或重排日期，逐日语义完全依赖上游
  // 每轮结束写回 Map，保证同一天的多条记录落在同一行上累加
  // 累加而非赋值，是同日多模型共存的前提，改成赋值会丢掉前面的模型
  for (const day of snapshot.dailyModelUsage) {
    const label = formatDay(locale, day.date);
    const row = rows.get(day.date) ?? createEmptyChartRow(label, label, modelKeys);

    for (const model of day.models) {
      const key = modelKeyById.get(model.modelId ?? "__unknown__");
      if (key) {
        row[key] = Number(row[key] ?? 0) + model.totalTokens;
      }
      row.total += model.totalTokens;
    }

    rows.set(day.date, row);
  }

  // 排序键为日期字符串，字典序在标准日期格式下等价于时间序
  // 显式排序而不依赖插入顺序，上游乱序时曲线仍保持单调递增
  // 先扁平化再排序，避免对 Map 原地重排产生额外中间状态
  // 同一天只可能有一个键，排序结果稳定，无需二次去重
  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

// 视图模型一次性产出图例、配置、数据与上限，组件层不再二次推导
// 语言与区域参与标签构建，切换语言必须整体重建，不能局部打补丁
// 纯函数无副作用，同一快照多次调用内容等价但引用独立
// 返回字段名与消费端解构一一对应，改名需同步改调用处
export function buildAppUsageDailyModelChartViewModel({
  intl,
  locale,
  snapshot,
}: {
  intl: UsageIntl;
  locale: string;
  snapshot: AppUsageSnapshot;
}) {
  // 只取前六个模型，顺序完全继承快照排序，即用量降序
  // 截断发生在建模之前，颜色序号与图例位置因此一一对应
  // 被截断模型仍计入行总量，tooltip 标题与顶部卡片总额保持一致
  // 上限写死是为避免窄屏图例换行，调整需同步评估手机布局
  const topModels = snapshot.models.slice(0, 6);
  const modelKeys = topModels.map((model, index) => ({
    modelId: model.modelId,
    key: `model${index}`,
    color: getAppUsageModelChartColor(index),
    label: resolveModelLabel(intl, model.modelId),
  }));
  const modelKeyById = new Map(
    modelKeys.map((model) => [model.modelId ?? "__unknown__", model.key]),
  );
  const chartConfig = modelKeys.reduce<ChartConfig>((config, model) => {
    config[model.key] = {
      label: model.label,
      color: model.color,
    };
    return config;
  }, {});
  const chartData = buildDailyModelChartData({
    snapshot,
    locale,
    modelKeys,
    modelKeyById,
  });
  // 坐标上限只跟随可见序列的单点峰值，不累加同一行的多模型用量
  // 折线是并列而非堆叠，用日总量做上限会把真实曲线压扁
  // 全零输入保持零值，交由空态分支处理，不硬编码保底上限
  // 上限一旦包含隐藏模型，可见曲线的相对高度就失去可比性
  let maxTokens = 0;
  // 图中是独立折线而非堆叠图，使用每日总量会把多模型之和（以及未展示模型）
  // 当作 Y 轴上限，导致实际可见曲线被压在底部；坐标范围只应跟随可见序列的单点峰值。
  for (const row of chartData) {
    for (const model of modelKeys) {
      maxTokens = Math.max(maxTokens, Number(row[model.key] ?? 0));
    }
  }

  return {
    topModels,
    modelKeys,
    chartConfig,
    chartData,
    maxTokens,
  };
}

// 过滤结果按 payload 引用缓存，引用由图表库在切换数据点时更新
// 缓存不能跨数据点复用，否则 hover 到新一天仍显示上一天条目
// 非激活或无可见项时返回空，不渲染空壳容器占位
// 其余属性原样透传，指示器与格式化器由调用方决定
function DailyModelChartTooltipContent(props: ChartTooltipContentProps) {
  const filteredPayload = useMemo(
    () => filterDailyModelTooltipPayload(props.payload),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

// 快照是唯一输入，组件内不发起请求，也不持有派生状态副本
// 坐标轴标签回调依赖数据长度，长度变化必须重建闭包
// tooltip 格式化回调依赖语言与区域，切换语言需要新闭包
// 渲染两支互斥：空态与图表，二者都读同一上限判据
export function AppUsageDailyModelTrendChart({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { topModels, modelKeys, chartConfig, chartData, maxTokens } = useMemo(
    // Recharts 3.8 会把 data / legend / graphical item props 写入内部 store。
    // 这里稳定派生数组和配置对象，避免父组件重渲染时因引用变化反复触发内部 dispatch。
    () => buildAppUsageDailyModelChartViewModel({ intl, locale, snapshot }),
    [intl, locale, snapshot],
  );
  const shouldShowAxisLabel = useCallback(
    (_value: string, index: number) =>
      shouldShowDailyChartAxisLabel(index, chartData.length) ? _value : "",
    [chartData.length],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as DailyModelChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      return `${row?.tooltipLabel ?? ""} - ${formatCompactTokenUsage(locale, total)} ${intl.formatMessage(
        {
          id: "settings.usage.tokenUnit",
        },
      )}`;
    },
    [intl, locale],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      const tokenValue = resolveDailyModelTooltipTokenParts(locale, value, tokenUnit);
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">{tokenValue.number}</span>
              {tokenValue.unit ? (
                <span className="text-foreground-subtle">{tokenValue.unit}</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, locale, tokenUnit],
  );
  const tooltipContent = useMemo(
    () => (
      <DailyModelChartTooltipContent
        indicator="line"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem, formatTooltipLabel],
  );

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.dailyChartTitle" })}
      </h3>
      {maxTokens <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : (
        <div className="px-3 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
            {topModels.map((model, index) => (
              <div
                key={model.modelId ?? "__unknown__"}
                className="flex min-w-0 items-center gap-2 text-ui-sm"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: getAppUsageModelChartColor(index),
                  }}
                />
                <span className="truncate text-foreground-subtle">
                  {resolveModelLabel(intl, model.modelId)}
                </span>
              </div>
            ))}
          </div>
          <ChartContainer config={chartConfig} className="h-60 w-full">
            <LineChart accessibilityLayer data={chartData} margin={APP_USAGE_TREND_CHART_MARGIN}>
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
              <YAxis hide domain={[0, maxTokens]} />
              <ChartTooltip cursor={false} content={tooltipContent} />
              {modelKeys.map((model) => (
                <Line
                  key={model.key}
                  dataKey={model.key}
                  type="monotone"
                  stroke={`var(--color-${model.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      )}
    </section>
  );
}
