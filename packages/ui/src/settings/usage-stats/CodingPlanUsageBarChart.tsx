// 编码计划用量柱状图：将已聚合的模型用量序列渲染成 Recharts 柱图，支持按模型并排与按输入/输出分段堆叠两种形态。
// 负责：由 series 派生图例键、行数据、Y 轴上限与 tooltip 文案；不负责取数聚合、鉴权与空态文案的翻译条目维护。
// 本文件只做展示层映射，任何「看起来能顺手算一下」的聚合都应回到上游 usage-stats，避免两处口径漂移。
//
// INV-01 断言：最多只渲染前 6 条系列 —— 守住它的位置：CodingPlanUsageBarChart 中 visibleSeries 的 slice 参数 —— 改错故障：第 7 条起没有对应 CSS 颜色变量，柱子变透明而图例仍在。
// INV-02 断言：barKeys 与 chartData 必须由同一份 visibleSeries 生成 —— 守住它的位置：两个 useMemo 的输入 —— 改错故障：颜色与标签错配到别的模型，图例与柱高对不上。
// INV-03 断言：buildBarKeys 的 key 与 buildChartData 写入的 row 字段名逐字一致 —— 守住它的位置：两函数的字符串拼接 —— 改错故障：柱子高度为 0 且 tooltip 分段缺失，且无任何报错。
// INV-04 断言：hasBreakdownValues 在 buildBarKeys 与 buildChartData 中给出同一结果 —— 守住它的位置：两处调用点 —— 改错故障：图例按三段生成而行数据只写单柱字段，整图空白。
// INV-05 断言：stackId 由 series 下标生成，同一模型三段共享同一个 stackId —— 守住它的位置：buildBarKeys 与 buildChartData —— 改错故障：同一模型的三段被拆成三根并排柱，宽度骤减。
// INV-06 断言：圆角只给堆叠段的最上段与单柱模式 —— 守住它的位置：buildBarKeys 中的 radius 元组 —— 改错故障：堆叠接缝处出现缺口，视觉上像断柱。
// INV-07 断言：Y 轴 domain 取单个模型的最大值，不取当日合计 —— 守住它的位置：calculateCodingPlanBarChartMaxValue 的调用 —— 改错故障：并排柱被压扁到不足一半高度，图表上半部大面积留白。
// INV-08 断言：空态判定为三条件取或，且位于全部 hooks 之后 —— 守住它的位置：组件的提前 return —— 改错故障：提前返回改变 hook 调用顺序，切换数据时直接抛错。
// INV-09 断言：tooltip 只保留有限且大于 0 的项 —— 守住它的位置：CodingPlanBarTooltipContent 的过滤 —— 改错故障：tooltip 出现一排 0 值行与 NaN 行，悬停区域被撑高。
// INV-10 断言：tooltip 头部总量取行对象的 total —— 守住它的位置：formatTooltipLabel 的取值 —— 改错故障：分段被过滤后重算求和，总量偏小且与柱高不符。
// INV-11 断言：X 轴标签抽稀由本文件计算，Recharts 自动抽稀必须关闭 —— 守住它的位置：XAxis 的 interval 与 tickFormatter —— 改错故障：首尾刻度随机消失，不同时间范围表现不一致。
// INV-12 断言：tickFormatter 对不显示的刻度返回空串 —— 守住它的位置：shouldShowAxisLabel —— 改错故障：返回空值被当成刻度内容，坐标轴出现多余占位。
// INV-13 断言：小时粒度的时间标签直接截取原始串，不经过 Date —— 守住它的位置：formatChartTime 的首个分支 —— 改错故障：标签整体偏移时区差，跨日数据错位到前一天。
// INV-14 断言：非小时粒度解析失败时回退原始串 —— 守住它的位置：formatChartTime 的 NaN 分支 —— 改错故障：坐标轴出现 Invalid Date 文本，且原始时间信息丢失难以定位。
// INV-15 断言：系列颜色优先取调用方传入，其次按索引在 6 色调色板上取模 —— 守住它的位置：getModelColor —— 改错故障：两条系列同色，图例无法区分不同模型。
// INV-16 断言：分段颜色由模型色混合派生，不能写死 —— 守住它的位置：getModelBreakdownColor —— 改错故障：调用方传入的系列色失效，同一图里出现两套配色体系。
// INV-17 断言：柱子填充走 --color-<key> 变量，chartConfig 的键必须与 dataKey 相同 —— 守住它的位置：chartConfig 与 Bar 的 fill —— 改错故障：变量解析为空，柱子隐形但 tooltip 正常。
// INV-18 断言：Bar 的 name 用产品标签，不用 dataKey —— 守住它的位置：Bar 的 name 属性 —— 改错故障：tooltip 显示 series0_output 这类内部字段。
// INV-19 断言：valueKind 决定 tooltip 数值后缀，token 与 credit 走不同格式化 —— 守住它的位置：两个 formatter —— 改错故障：token 显示成普通计数，单位与量级同时出错。
// INV-20 断言：breakdown 全为 0 时按无 breakdown 处理 —— 守住它的位置：hasBreakdownValues 的 some —— 改错故障：图例多出三条高度恒为 0 的空系列。
//
// 耦合关系：visibleSeries 依次流入 barKeys、chartConfig、chartData、maxValue，换掉任一处的数据源都会造成颜色错配或列错位。
// 耦合关系：chartData 的动态字段名来自 buildBarKeys，两函数相距较远且没有类型兜底，改名时必须同时搜索两处。
// 关注点分离：maxValue 只约束 Y 轴刻度，不改变柱高；tooltip 头部总量来自行数据，与 Y 轴口径刻意不同。
// 阅读顺序：先看 hasBreakdownValues 的两条分支，再看 buildBarKeys 与 buildChartData 中成对出现的字段名。
// 维护提示：新增 series 字段时需要同步 buildBarKeys、buildChartData、calculateCodingPlanBarChartMaxValue 三处。
import { type ComponentProps, useCallback, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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

const CODING_PLAN_BAR_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;
// [契约] 单柱最大宽度：时间点很少时若不限制，Recharts 会把柱子拉到占满绘图区，看起来像分区色块。
// 该值只影响柱宽，不影响间距计算；增大它不会让稀疏数据更易读，只会让相邻柱贴边。
// 与上方 margin 联动：缩小边距同时放大柱宽，会让首尾柱被裁掉一角。
// 不要改成响应式数值，Recharts 的 maxBarSize 只接受固定像素，传百分比会被静默忽略。
const CODING_PLAN_BAR_CHART_MAX_BAR_SIZE = 24;
// [契约] 调色板长度直接决定可渲染的模型数量上限，组件里的截断参数与此处硬编码的 6 个变量必须同步。
// 少于 6 个时 getModelColor 的取模会绕回第一个颜色，两条系列同色后图例无法区分。
// 颜色值只允许是 CSS 变量，写死十六进制会让暗色主题切换后柱子仍停留在浅色板。
// 新增颜色需要同时在主题里定义对应的 --color-usage-chart-N，否则填充变量解析为空、柱子不可见。
const BAR_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;
type BreakdownKind = "cachedInput" | "uncachedInput" | "output";
type BarRadius = [number, number, number, number];

// [契约] values 与外部传入的 xTime 是两个平行数组，长度不一致时缺失位置按 0 补齐，不允许越界读取。
// breakdown 缺省表示该系列走单柱模式；传空对象会让 hasBreakdownValues 走堆叠分支后全部落空。
// 判定用的是有没有正数而不是字段是否存在，因此全 0 的 breakdown 等价于未提供。
// color 可选，缺省由序号在调色板里取模；调用方不要传半透明色，分段混合后会与背景糊在一起。
export type CodingPlanBarChartSeries = {
  color?: string;
  name: string;
  values: number[];
  breakdown?: {
    cachedInput: number[];
    uncachedInput: number[];
    output: number[];
  };
};

type CodingPlanBarChartRow = {
  label: string;
  time: string;
  total: number;
} & Record<string, number | string>;

// stackId 为 undefined 时 Recharts 把该柱当成独立系列并排绘制，这是单柱模式成立的关键。
// radius 是四元组而非单值，堆叠段必须用全 0，否则每段都带圆角会在接缝处出现缺口。
// key 同时承担三职：React 列表 key、chartConfig 的键、Bar 的 dataKey，三者必须字面一致。
// label 只进 tooltip 与图例，改动它不影响数据绑定，但会改变用户看到的分段名称。
type CodingPlanBarKey = {
  color: string;
  key: string;
  label: string;
  radius: BarRadius;
  stackId?: string;
};
type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

function formatChartTime(
  locale: string,
  value: string,
  granularity: CodingPlanUsageGranularity,
): string {
  // [契约] 小时粒度假定上游给的是 HH:mm:ss 这类定长串，直接截前 5 位得到小时与分钟。
  // 不要在这里改用 Date 解析：小时桶本身就是本地时间语义，再走时区换算会整体偏移。
  // 若上游把格式换成 ISO 时间戳，这个截取会产出 2026- 之类的乱码，需同步修改上游约定。
  // 该分支必须先于日期解析返回，否则无日期部分的串会被判定为 Invalid Date。
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

// [权衡] 标签抽稀在这里自行计算，因为 XAxis 已关闭自动抽稀（interval 为 0）。
// 关闭自动抽稀是为了保证首尾刻度一定出现，代价是每个刻度都会回调一次 tickFormatter。
// 阈值按时间点数量而不是标签宽度决定，属于经验值；改动后要目视检查 7 天与 30 天两档。
// 返回值必须是字符串，隐藏刻度用空串表达，不要改成返回 null 或 undefined。
function shouldShowXAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  // 超过 45 个时间点用 7 天步长，否则用 5；步长与总数共同决定标签疏密，只改一处会突然变挤或变稀。
  // 首尾两个索引被强制显示，因此实际可见标签数比 total 除以 step 多一个。
  // 这个判断对每个索引各执行一次，属于渲染热路径，不要再往里加格式化或国际化调用。
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

// [契约] 这是单柱与堆叠两条渲染路径的唯一开关，buildBarKeys 与 buildChartData 都靠它分流。
// 用展开后的 some 判断而非逐字段判断，避免新增分段时漏掉某个字段导致开关结果不一致。
// 空 breakdown 与全 0 breakdown 在此处同义，都会被当作不支持分段，从而回退到 values 单柱。
// 任意一段为正即视为可堆叠：即使其他两段全 0，也仍按三段结构出图，只是有两段高度为零。
function hasBreakdownValues(series: CodingPlanBarChartSeries): boolean {
  const breakdown = series.breakdown;
  if (!breakdown) {
    return false;
  }
  return [...breakdown.cachedInput, ...breakdown.uncachedInput, ...breakdown.output].some(
    (value) => value > 0,
  );
}

function getModelColor(index: number, seriesColor?: string): string {
  return seriesColor ?? BAR_COLORS[index % BAR_COLORS.length] ?? BAR_COLORS[0];
}

// [权衡] 三段颜色由模型主色混合派生，保证同一模型内颜色同族、不同模型之间靠色相区分。
// 缓存输入压暗、输出提亮的比例是视觉层约定；改成固定色会让调用方传入的系列色完全失效。
// 未命中任何分支时返回提亮色，即按输出段处理，新增分段类型时必须补分支，否则静默错色。
// 混合语法需要现代浏览器支持，回退方案不在本文件内，不要在这里改成 rgba 手工计算。
function getModelBreakdownColor(modelColor: string, kind: BreakdownKind): string {
  if (kind === "cachedInput") {
    return `color-mix(in srgb, ${modelColor} 88%, black 12%)`;
  }
  if (kind === "uncachedInput") {
    return modelColor;
  }
  return `color-mix(in srgb, ${modelColor} 58%, white 42%)`;
}

// 返回数组的顺序即绘制顺序：同一模型的多段必须连续，跨模型并排由 stackId 区分。
// flatMap 会把每个系列展开成 1 段或 3 段，条数不再等于系列数，调用方不能用它的下标反查模型。
// 单柱模式的 key 带 _total 后缀，与堆叠三段互斥，避免同一模型同时出现两种形态。
// intl 在这里被取用而不是传 locale，因为分段名称是界面文案，需要随语言包切换而重算。
function buildBarKeys({
  intl,
  series,
}: {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  series: CodingPlanBarChartSeries[];
}): CodingPlanBarKey[] {
  return series.flatMap((item, index) => {
    const stackId = `series${index}`;
    const modelColor = getModelColor(index, item.color);
    if (!hasBreakdownValues(item)) {
      return [
        {
          color: modelColor,
          key: `${stackId}_total`,
          label: item.name,
          radius: [4, 4, 0, 0],
        },
      ];
    }
    return [
      {
        color: getModelBreakdownColor(modelColor, "cachedInput"),
        key: `${stackId}_cachedInput`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.cachedInput",
        })}`,
        radius: [0, 0, 0, 0],
        stackId,
      },
      {
        color: getModelBreakdownColor(modelColor, "uncachedInput"),
        key: `${stackId}_uncachedInput`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.uncachedInput",
        })}`,
        radius: [0, 0, 0, 0],
        stackId,
      },
      {
        color: getModelBreakdownColor(modelColor, "output"),
        key: `${stackId}_output`,
        label: `${item.name}${intl.formatMessage({
          id: "settings.usage.modelChart.output",
        })}`,
        radius: [4, 4, 0, 0],
        stackId,
      },
    ];
  });
}

function buildChartData({
  granularity,
  locale,
  series,
  xTime,
}: {
  granularity: CodingPlanUsageGranularity;
  locale: string;
  series: CodingPlanBarChartSeries[];
  xTime: string[];
}): CodingPlanBarChartRow[] {
  return xTime.map((time, dateIndex) => {
    const row: CodingPlanBarChartRow = {
      label: formatChartTime(locale, time, granularity),
      time,
      total: 0,
    };

    series.forEach((item, seriesIndex) => {
      const stackId = `series${seriesIndex}`;
      if (hasBreakdownValues(item)) {
        // [契约] 行对象的动态字段名必须与 buildBarKeys 生成的 key 逐字一致，这里没有类型约束兜底。
        // stackId 由 series 下标拼出，与 buildBarKeys 中的命名规则必须相同，否则堆叠分组对不上。
        // 缺索引时补 0 而不是跳过赋值：字段缺失会让 Recharts 认为该段不存在，柱子出现断层。
        // 每行都先写 total 再累加，total 只服务 tooltip 头部，不参与柱高计算。
        const cachedInput = item.breakdown?.cachedInput[dateIndex] ?? 0;
        const uncachedInput = item.breakdown?.uncachedInput[dateIndex] ?? 0;
        const output = item.breakdown?.output[dateIndex] ?? 0;
        row[`${stackId}_cachedInput`] = cachedInput;
        row[`${stackId}_uncachedInput`] = uncachedInput;
        row[`${stackId}_output`] = output;
        row.total += cachedInput + uncachedInput + output;
      } else {
        const total = item.values[dateIndex] ?? 0;
        row[`${stackId}_total`] = total;
        row.total += total;
      }
    });

    return row;
  });
}

// [契约] 导出是为了单测能直接断言上限；遍历顺序是时间点在外、系列在内，取的是单模型单点最大值。
// 堆叠图的每根柱高等于三段之和，因此这里也必须按三段求和后比较，漏加任一段会让柱顶溢出绘图区。
// 返回 0 是合法结果，上层据此进入空态；不要为了规避除零返回 1，那会让全 0 数据画出空白坐标系。
// 该函数不读 xTime 的内容只用其长度，xTime 与实际行数不一致时这里不会报错。
export function calculateCodingPlanBarChartMaxValue(
  series: CodingPlanBarChartSeries[],
  xTimeLength: number,
): number {
  let maxValue = 0;
  for (let dateIndex = 0; dateIndex < xTimeLength; dateIndex++) {
    for (const item of series) {
      const value = hasBreakdownValues(item)
        ? (item.breakdown?.cachedInput[dateIndex] ?? 0) +
          (item.breakdown?.uncachedInput[dateIndex] ?? 0) +
          (item.breakdown?.output[dateIndex] ?? 0)
        : (item.values[dateIndex] ?? 0);
      maxValue = Math.max(maxValue, value);
    }
  }
  return maxValue;
}

function CodingPlanBarTooltipContent(props: ChartTooltipContentProps) {
  // [失败路径] Recharts 会把 0 值段也塞进 payload，不过滤则 tooltip 出现一排无意义的零值行。
  // 非数字字符串先转 Number 再判有限性，NaN 与 Infinity 都必须挡掉，否则格式化函数会输出 NaN。
  // 过滤放在 useMemo 里而非 formatter 内，因为 formatter 每次悬停都会重跑，且需要稳定的数组引用。
  // 依赖是 payload 的引用，Recharts 每次重算会换新数组，因此这里不会命中陈旧缓存。
  const filteredPayload = useMemo(
    () =>
      (props.payload ?? []).filter((item) => {
        const value = typeof item.value === "number" ? item.value : Number(item.value);
        return Number.isFinite(value) && value > 0;
      }),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

export function CodingPlanUsageBarChart({
  emptyDescription,
  granularity,
  series,
  valueKind = "count",
  xTime,
}: {
  emptyDescription: string;
  granularity: CodingPlanUsageGranularity;
  series: CodingPlanBarChartSeries[];
  valueKind?: "count" | "credit" | "speed" | "token";
  xTime: string[];
}) {
  const { intl, locale } = useZCodeIntl();
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const creditUnit = intl.formatMessage({ id: "settings.usage.creditUnit" });
  // [契约] 组件是纯展示：所有数据由上层算好，这里只做截断、配色与文案拼装。
  // 截断到 6 条与调色板长度绑定，超出部分既不渲染也不进 tooltip，属于静默丢弃。
  // valueKind 缺省为 count，决定 tooltip 数值走普通紧凑格式还是 token 专用格式。
  // 默认值写在解构里而不是依赖调用方，注意不要在下方 hooks 之间再插入条件分支。
  const visibleSeries = useMemo(() => series.slice(0, 6), [series]);
  // 依赖 intl 而不是 locale：切换语言时 intl 引用会变，locale 字符串可能不变，用错会保留旧语言标签。
  // barKeys 同时被 chartConfig 与渲染循环消费，必须保持引用稳定，否则每帧都会重建配置对象。
  // 它消费的是截断后的系列，若换成原始 series，颜色会分配给永远不会渲染的系列。
  // 该 memo 不做任何数值计算，只有标签拼装，成本低但调用频繁。
  const barKeys = useMemo(
    () => buildBarKeys({ intl, series: visibleSeries }),
    [intl, visibleSeries],
  );
  // [契约] 这里的键必须与 Bar 的 dataKey 完全相同，图表容器靠它生成对应的 CSS 颜色变量。
  // 键缺失时 fill 引用的变量解析为空，柱子变透明却不报错，是最难排查的一类样式问题。
  // 用 reduce 累积而不是一次性建对象，保持与宽松索引签名兼容，避免类型收窄失败。
  // 配置只含 label 与 color 两项，补充其他字段不会生效，主题色由 CSS 变量层决定。
  const chartConfig = useMemo(
    () =>
      barKeys.reduce<ChartConfig>((config, item) => {
        config[item.key] = {
          label: item.label,
          color: item.color,
        };
        return config;
      }, {}),
    [barKeys],
  );
  const chartData = useMemo(
    () => buildChartData({ granularity, locale, series: visibleSeries, xTime }),
    [granularity, locale, visibleSeries, xTime],
  );
  // [契约] 已有注释说明了为何不用合计值；这里补充：堆叠柱的柱高是分段之和，与单模型最大值不是同一口径。
  // YAxis 的 domain 固定为 0 到该值且组件隐藏，用户看不到刻度，因此数值偏小只会体现为柱子变高。
  // 依赖里用 xTime 的长度而不是数组引用，避免上层重新构造同内容数组时触发无谓重算。
  // 若改成在渲染时现场遍历，会与 chartData 的构建重复一次全量扫描。
  const maxValue = useMemo(
    // tooltip 的总量是当天所有模型合计，但柱子是按模型并排展示。
    // Y 轴如果用合计值做 domain，会把每根并排柱压矮，导致图表上方空白过多。
    () => calculateCodingPlanBarChartMaxValue(visibleSeries, xTime.length),
    [visibleSeries, xTime.length],
  );
  const shouldShowAxisLabel = useCallback(
    (value: string, index: number) => (shouldShowXAxisLabel(index, chartData.length) ? value : ""),
    [chartData.length],
  );
  const formatTooltipValue = useCallback(
    (value: unknown, name: unknown, item: unknown) => {
      // [契约] 第三参数来自 Recharts 内部结构，字段不稳定，先窄化再取值，取不到时回退边框色。
      // 指示点颜色跟随系列色，不能用主题前景色代替，否则多系列 tooltip 无法对应到具体柱子。
      // 数值与后缀分两个 span：后缀只对数字出现，字符串值直接原样展示，避免拼出错误单位。
      // token 走专用紧凑格式化，与普通计数分开，是因为 token 量级跨多个数量级，共用会丢精度。
      const tooltipItem = item as { color?: unknown };
      const indicatorColor =
        typeof tooltipItem.color === "string" ? tooltipItem.color : "var(--color-border)";
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: indicatorColor }}
          />
          <span className="min-w-0 flex-1 truncate text-foreground-subtle">{String(name)}</span>
          <span className="flex shrink-0 items-baseline gap-1 text-foreground">
            <span className="font-mono font-medium tabular-nums">
              {typeof value === "number"
                ? valueKind === "token"
                  ? formatCompactTokenUsage(locale, value)
                  : formatCompactNumber(locale, value)
                : String(value)}
            </span>
            {typeof value === "number" && valueKind === "token" ? (
              <span className="text-foreground-subtle">{tokenUnit}</span>
            ) : typeof value === "number" && valueKind === "credit" ? (
              <span className="text-foreground-subtle">{creditUnit}</span>
            ) : typeof value === "number" && valueKind === "speed" ? (
              <span className="text-foreground-subtle">tokens/s</span>
            ) : null}
          </span>
        </>
      );
    },
    [creditUnit, locale, tokenUnit, valueKind],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      // [失败路径] payload 可能是空数组，取下标前必须判空，否则悬停到空白区域会抛异常。
      // 总量只认行对象上的 total，不从各段重新求和：tooltip 可能被过滤掉部分段，重算会得到偏小值。
      // 标签取行的 label 而非原始时间，保证与 X 轴显示一致；小时粒度下原始串还带秒。
      // 底部分隔线是固定结构，去掉后工具提示与后续条目会黏在一起。
      const row = payload[0]?.payload as CodingPlanBarChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      const formattedTotal =
        valueKind === "token"
          ? formatCompactTokenUsage(locale, total)
          : formatCompactNumber(locale, total);
      return (
        <>
          <div className="text-foreground-subtle">{row?.label ?? ""}</div>
          <div className="mt-3 flex items-center justify-between gap-8 text-foreground">
            <span>
              {intl.formatMessage({
                id: "settings.usage.codingPlanLegendTotal",
              })}
              :
            </span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono font-medium tabular-nums">{formattedTotal}</span>
              {valueKind === "token" ? (
                <span className="text-foreground-subtle">{tokenUnit}</span>
              ) : valueKind === "credit" ? (
                <span className="text-foreground-subtle">{creditUnit}</span>
              ) : null}
            </span>
          </div>
          <div className="mt-3 border-t border-border" />
        </>
      );
    },
    [creditUnit, intl, locale, tokenUnit, valueKind],
  );
  // 这里包一层是为了注入固定宽度与圆点指示器，同时挂上两个已 memo 化的格式化函数。
  // 依赖两个 formatter 的引用即可，它们由 useCallback 稳定；把 locale 之类再加进来只会多余重算。
  // 宽度上限与列表截断配合，超长模型名在值列被截断而不是换行，避免 tooltip 高度抖动。
  // 不要在此处按 valueKind 分支渲染两套内容，格式化差异已下沉到 formatter。
  const tooltipContent = useMemo(
    () => (
      <CodingPlanBarTooltipContent
        className="max-w-96 min-w-72"
        indicator="dot"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipValue}
      />
    ),
    [formatTooltipLabel, formatTooltipValue],
  );

  // [契约] 三个条件任一成立即空态：没有可渲染系列、没有时间点、或所有值都不大于 0。
  // maxValue 不大于 0 这一条覆盖了有数据但全为 0 的情况，去掉它会出现空白坐标系。
  // 这个提前返回必须位于所有 hooks 之后，上移到 memo 之前会改变 hook 调用顺序并触发运行时错误。
  // 空态使用统一组件，标题走公共文案，描述由调用方按场景传入，这里不自行拼接。
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
      <ChartContainer config={chartConfig} className="h-64 w-full">
        <BarChart accessibilityLayer data={chartData} margin={CODING_PLAN_BAR_CHART_MARGIN}>
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
          {barKeys.map((item) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              fill={`var(--color-${item.key})`}
              // Recharts 默认把 dataKey 当 tooltip name，导致堆叠段展示
              // series0_cachedInput 这类内部字段。这里显式传产品文案给 tooltip formatter。
              name={item.label}
              maxBarSize={CODING_PLAN_BAR_CHART_MAX_BAR_SIZE}
              radius={item.radius}
              stackId={item.stackId}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}
