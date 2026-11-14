// INV-01 守住位置：recharts 的 import 只允许出现在本文件；改错故障：一旦把图表依赖上提到 presets/index，Electron Linux 容器会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，整个 renderer 起不来。
// INV-02 守住位置：本模块同时保留 default 与具名 ArtifactChartView 两个导出；改错故障：ArtifactChart.tsx 的 lazy() 只认 default，删掉它拿到的是 undefined 而不是组件。
// INV-03 守住位置：序列裁剪到 ARTIFACT_CHART_MAX_SERIES 必须发生在 useMemo 内、applyArtifactItems 之后；改错故障：把裁剪挪进 seriesMarks 会让图例仍列出超限序列，而图上没有对应颜色。
// INV-04 守住位置：buildChartConfig 与 seriesMarks 必须用同一个 series.key 拼出 var(--color-<key>)；改错故障：任一侧换键，线条与图例就会落到 ChartContainer 的兜底色上。
// INV-05 守住位置：颜色、线型、点形三者都从同一个 colorIndex 派生；改错故障：改用 series.key 派生会让色觉障碍下两条序列失去颜色之外的第二条身份线索。
// INV-06 守住位置：chartPlotPropsEqual 先比 compact 与 type/scale/x.numeric，再比序列构成，最后才是点数；改错故障：顺序颠倒会让类型或刻度切换被误判为相等，画面停在旧形态。
// INV-07 守住位置：memo 比较字段必须覆盖点数、首尾 sequence、domain 四界、baseline 值；改错故障：漏掉 baseline 会让参考线拖到新值时整张图不重绘。
// INV-08 守住位置：Line、Bar、Scatter 三个分支都显式关闭 isAnimationActive；改错故障：漏掉任一分支，实时追加数据时每次更新都会把整条序列重画一遍并闪屏。
// INV-09 守住位置：折线固定 connectNulls 为 false 且 type 为 monotone；改错故障：改成 true 会把缺失区间连成一条不存在的假趋势。
// INV-10 守住位置：揭示动画的 React key 取条目的 sequence，仅在缺失时才回落 index；改错故障：统一用 index 会让既有节点换身份，历史点每帧重播一次入场动画。
// INV-11 守住位置：点数超过 MAX_VISIBLE_DOTS 就不画点，compact 形态把阈值进一步压到 24；改错故障：放宽阈值会让千点图的每帧布局开销翻倍，缩略图也会糊成一团。
// INV-12 守住位置：categoricalX 必须把 type 为 bar 或 x 非数值的情况都归为分类轴；改错故障：bar 走数值轴会让柱宽与间距错位。
// INV-13 守住位置：logDomain 必须同时满足 scale 为 log 且 domain 存在才下发；改错故障：只看 scale 会把 undefined 传给轴，刻度直接算成 NaN。
// INV-14 守住位置：零点的空态分支必须在渲染 plot 之前返回，且 compact 下不渲染 PresetHeading；改错故障：让图表组件自己吃空数组只会得到一张高度塌陷的空白卡片。
// INV-15 守住位置：ChartLegendRow 在全尺寸分支无条件渲染，至少覆盖一条序列；改错故障：按条件隐藏图例就丢掉了颜色之外的线型与最新值读数。
// INV-16 守住位置：compact 读数取 series[0] 与 points 末项，且类型守卫必须早于返回节点；改错故障：跳过守卫会把字符串或 undefined 直接印成读数。
// INV-17 守住位置：tooltip 的 label 一律经 fieldHeading 拼 xLabel 与 x.unit；改错故障：改从别的字段取标签会让 hover 显示空白或未格式化原文。
// INV-18 守住位置：model 只在组件入口由 useMemo 依赖 [spec, items] 派生，子组件不得重算；改错故障：下层重算会破坏 memo 谓词赖以成立的引用稳定前提。
//
// 模块职责：把 chart 预置的 ChartModel 渲染成 compact 缩略图或带轴全尺寸图，并承载 recharts 的唯一依赖边界。
// 状态所有权：模型归父层 useMemo，点位与序列只读；本文件只持有常量阈值，不保存任何跨帧可变状态。
// 阅读顺序：先读常量与 chartPlotPropsEqual 的比较顺序，再看 ArtifactChartPlot 的两套布局，最后看 ArtifactChartView 的空态与 compact 分支。
/**
 * `chart` 预置渲染器的**实现**（recharts 在这个模块里，且只在这里）。
 *
 * 不要直接从 index 静态导入它：recharts 在模块初始化阶段会触发 decimal.js-light 的 LN10 校验，
 * 在 Electron Linux 容器里能阻断整个 renderer 启动（同 `AppUsagePanel.tsx` 里记下的那次修复）。
 * 对外的入口是 `ArtifactChart.tsx`，它用 `lazy()` 把这个模块推到首屏之外。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的**无轴 sparkline + 最新值**；
 * - 全尺寸：`workflow-artifact` tab 里的带轴图 + 图例 + 参考线 + tooltip。
 */

import { memo, useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Scatter,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import {
  applyArtifactItems,
  type ArtifactItem,
  type ChartModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  artifactSeriesColorVar,
  artifactSeriesDash,
  artifactSeriesSymbol,
  ARTIFACT_CHART_MAX_SERIES,
} from "@/app-shell/workflow-artifacts/presets/palette.js";
import {
  fieldHeading,
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";

/** 点多到这个数以上就不画点了：一条挤满圆点的线比没有点更难读。 */
// 点数超过 60 就整条序列不画点，compact 形态在调用处把阈值再收到 24，两级判定都不看容器尺寸。
// 固定常量是为了让同一份数据在溢出前后得到同一张图的骨架，缩放窗口不会让圆点忽隐忽现。
// 缩略图高度只有 56px，24 个圆点已经糊成一片，因此 compact 的阈值比全尺寸更严。
// 判定必须留在渲染入口，一旦搬进 seriesMarks，bar 与 scatter 分支也会被误加圆点。
// 阈值只关掉点的绘制，隐藏的点仍参与折线走向与坐标轴取值范围，数据层不受影响。
const MAX_VISIBLE_DOTS = 60;
const FULL_MARGIN = { top: 8, right: 16, bottom: 0, left: 0 } as const;
const COMPACT_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 } as const;

/**
 * 新点的揭示：React key 用条目的 `sequence`（稳定），所以只有**这一帧新挂载**的点会播动画，
 * 既有的点保持同一个 DOM 节点、不重播。
 * `motion-reduce` 下类名里的 `animate-none` 直接关掉。
 */
// cx 或 cy 非数值时直接返回 null：空值位置上 recharts 仍会调用渲染器，不挡住就会画出 (0,0) 的假点。
// React key 取 payload.sequence，只有字段缺失才回落 index，保证既有 DOM 节点不换身份。
// sequence 来自条目的稳定序号而非数组下标，冷恢复后重排也不会触发整批重播。
// 动画类名由 REVEAL_ANIMATION_CLASS 提供，motion-reduce 下靠类里的 animate-none 直接关掉。
// 去掉类型守卫会留下假原点，去掉 sequence 键会让每个历史点在每帧重新入场一次。
function renderRevealDot(props: DotItemDotProps) {
  const { cx, cy, payload, stroke, index } = props;
  if (typeof cx !== "number" || typeof cy !== "number") {
    return null;
  }
  const sequence =
    payload && typeof payload === "object" && typeof payload.sequence === "number"
      ? payload.sequence
      : index;
  return (
    <circle
      className={REVEAL_ANIMATION_CLASS}
      cx={cx}
      cy={cy}
      fill={stroke}
      key={`reveal-${sequence}`}
      r={4}
    />
  );
}

// 键必须是 series.key，因为 seriesMarks 用同一个键拼出 var(--color-<key>)，两处必须同源。
// 颜色只写 CSS 变量名不写色值，主题切换与色觉障碍模式才能在样式层统一覆盖。
// reduce 的初始值是空对象，序列为空时得到空 config 而不是 undefined，图表组件才不会解构失败。
// label 直接取 series.label，图例与 tooltip 的显示名因此只有一处来源。
// 若把键换成 colorIndex，同槽位的两条序列会互相串色，图例与线也对不上。
function buildChartConfig(model: ChartModel): ChartConfig {
  return model.series.reduce<ChartConfig>((config, series) => {
    config[series.key] = {
      label: series.label,
      color: artifactSeriesColorVar(series.colorIndex),
    };
    return config;
  }, {});
}

// 分支顺序固定为 bar、scatter、line，未命中前两者才落进折线默认支，顺序颠倒会改变图形语义。
// Bar 与 Scatter 分支不接收 showDots，它们的点由柱体与点形本身承担，再叠揭示圆点就是重复编码。
// 三个分支都显式关闭 isAnimationActive，recharts 的入场动画会把整条序列当新节点重画。
// 折线保留 connectNulls 为 false 与 type 为 monotone，断口与平滑必须同时成立。
// 点形与线型都从 colorIndex 派生，颜色之外还有第二条身份线索，供色觉障碍场景区分。
function seriesMarks(model: ChartModel, showDots: boolean) {
  return model.series.map((series) => {
    const color = `var(--color-${series.key})`;
    if (model.type === "bar") {
      return <Bar dataKey={series.key} fill={color} key={series.key} isAnimationActive={false} />;
    }
    if (model.type === "scatter") {
      return (
        <Scatter
          dataKey={series.key}
          fill={color}
          isAnimationActive={false}
          key={series.key}
          // 点形是散点图上的次级编码（颜色之外的第二条身份线索），同折线的线型。
          shape={artifactSeriesSymbol(series.colorIndex)}
        />
      );
    }
    return (
      <Line
        connectNulls={false}
        dataKey={series.key}
        dot={showDots ? renderRevealDot : false}
        // recharts 自己的入场动画会在每次数据变化时把**整条线**重画一遍；实时增长的图里
        // 那就是每来一个点全线闪一次。这里关掉它，揭示动画只由新点的 CSS 负责。
        isAnimationActive={false}
        key={series.key}
        stroke={color}
        strokeDasharray={artifactSeriesDash(series.colorIndex)}
        strokeWidth={2}
        type="monotone"
      />
    );
  });
}

/**
 * 真正的绘图体，`memo` 且带自定义比较：**只在点数 / 定义域 / 序列构成变化时重渲染**。
 *
 * 理由是 portfolio 修过的第一帧冻结——recharts 会在 effect 里把 props 镜像进内部 store，
 * 父组件每次 render 都换一份 data 引用时，这条镜像链会被放大成成百上千次无意义更新。
 * 条目只追加，所以「点数 + 首尾 sequence + 定义域」足以判定数据是否真的变了。
 */
type PlotProps = { model: ChartModel; compact: boolean };

/**
 * `memo` 的比较谓词（`true` = 跳过重渲染）。单独导出是为了能直接测——「什么时候不重画」
 * 是这张图的性能契约本身，把它藏在 memo 的第二实参里就没法钉住了。
 */
// 返回 true 表示跳过重渲染；单独导出是为了让这条性能契约能被单测直接钉住，而不藏在 memo 的实参里。
// 比较顺序从廉价到昂贵：compact、类型与刻度、序列数与标签、点数、首尾序号、参考线与定义域。
// 点数不变但首尾 sequence 变了，说明整批条目被替换过（冷恢复重取），此时必须重画。
// 定义域的四个边界放在最后，任一变化都会改刻度，因此不能提前吞掉。
// 漏掉参考线会让基准值移动时画面不动，漏掉序号会让冷恢复沿用旧图。
export function chartPlotPropsEqual(previous: PlotProps, next: PlotProps): boolean {
  if (previous.compact !== next.compact) {
    return false;
  }
  const a = previous.model;
  const b = next.model;
  if (a.type !== b.type || a.scale !== b.scale || a.x.numeric !== b.x.numeric) {
    return false;
  }
  if (a.series.length !== b.series.length) {
    return false;
  }
  if (a.series.some((series, index) => series.label !== b.series[index]?.label)) {
    return false;
  }
  if (a.points.length !== b.points.length) {
    return false;
  }
  // 首尾 sequence：点数没变但整批条目被替换过（冷恢复重取）时也能认出来。
  if (a.points[0]?.sequence !== b.points[0]?.sequence) {
    return false;
  }
  if (a.points.at(-1)?.sequence !== b.points.at(-1)?.sequence) {
    return false;
  }
  if (a.baseline?.value !== b.baseline?.value) {
    return false;
  }
  return (
    a.domain?.xMin === b.domain?.xMin &&
    a.domain?.xMax === b.domain?.xMax &&
    a.domain?.yMin === b.domain?.yMin &&
    a.domain?.yMax === b.domain?.yMax
  );
}

// config 只在 model 引用变化时重建，model 由上层 useMemo 保引用，这一层不再解构 points。
// categoricalX 把 bar 与非数值 x 一并归为分类轴，band scale 才能得到正确柱宽。
// logDomain 要求 scale 为 log 且 domain 存在，缺一就退回线性轴，避免把 undefined 传给轴。
// compact 与全尺寸共用同一套序列标记，差别只在高度、轴显隐、参考线与 tooltip。
// 全尺寸的数值 x 用 dataMin 到 dataMax 自适应，分类轴则交给 recharts 自行排布。
const ArtifactChartPlot = memo(function ArtifactChartPlot({ model, compact }: PlotProps) {
  const config = useMemo(() => buildChartConfig(model), [model]);
  const showDots = model.points.length <= MAX_VISIBLE_DOTS;
  // 数值 x 才配数值轴；bar 天然是分类比较，一律走分类轴（band scale 才有正确的柱宽）。
  const categoricalX = model.type === "bar" || !model.x.numeric;
  const logDomain: [number, number] | undefined =
    model.scale === "log" && model.domain ? [model.domain.yMin, model.domain.yMax] : undefined;

  if (compact) {
    return (
      <ChartContainer className="h-14 w-full" config={config}>
        <ComposedChart data={model.points} margin={COMPACT_MARGIN}>
          <XAxis
            dataKey={categoricalX ? "xLabel" : "x"}
            hide
            type={categoricalX ? "category" : "number"}
          />
          <YAxis hide {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})} />
          {seriesMarks(model, showDots && model.points.length <= 24)}
        </ComposedChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer className="h-56 w-full" config={config}>
      <ComposedChart data={model.points} margin={FULL_MARGIN}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey={categoricalX ? "xLabel" : "x"}
          minTickGap={16}
          tickLine={false}
          tickMargin={8}
          type={categoricalX ? "category" : "number"}
          {...(categoricalX ? {} : { domain: ["dataMin", "dataMax"] as [string, string] })}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={4}
          width={44}
          {...(logDomain ? { domain: logDomain, scale: "log" as const } : {})}
        />
        {model.baseline ? (
          <ReferenceLine
            label={{
              fill: "var(--color-foreground-subtle)",
              fontSize: 10,
              position: "insideTopRight",
              value: model.baseline.label,
            }}
            stroke="var(--color-foreground-subtlest)"
            strokeDasharray="4 4"
            y={model.baseline.value}
          />
        ) : null}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) => {
                const point = payload?.[0]?.payload as { xLabel?: string } | undefined;
                return fieldHeading(point?.xLabel ?? "", model.x.unit);
              }}
            />
          }
          cursor={false}
        />
        {seriesMarks(model, showDots)}
      </ComposedChart>
    </ChartContainer>
  );
}, chartPlotPropsEqual);

/**
 * 图例。**永远在场（≥1 条序列）**，且每条除了颜色还带自己的线型与最新值——
 * 身份从不只由颜色承担（见 palette.ts 里关于色槽在色觉障碍下不两两可分的那段）。
 */
// ChartLegendRow 在全尺寸分支无条件渲染：零序列输入已被上层空态拦掉，此处不再判空。
// 每条目带一段 16x8 的 svg 线段，线型与图内序列一致，颜色之外再给一条身份线索。
// 最新值取 points 末项，仅当该键为 number 才显示，缺数据的序列自动省略读数而不是留空。
// 单位单独渲染成弱化色文本，读数走等宽数字，位数变化时不会左右抖动。
// 容器标记为 list 与 listitem，读屏能逐条念出序列名与当前读数。
function ChartLegendRow({ model }: { model: ChartModel }) {
  const latest = model.points.at(-1);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="list">
      {model.series.map((series) => {
        const value = latest?.[series.key];
        return (
          <span
            className="flex min-w-0 items-center gap-1.5 text-ui-sm"
            data-testid="artifact-chart-legend-item"
            key={series.key}
            role="listitem"
          >
            <svg aria-hidden="true" className="shrink-0" height={8} width={16}>
              <line
                stroke={artifactSeriesColorVar(series.colorIndex)}
                strokeDasharray={artifactSeriesDash(series.colorIndex)}
                strokeWidth={2}
                x1={0}
                x2={16}
                y1={4}
                y2={4}
              />
            </svg>
            <span className="truncate text-foreground-subtle">{series.label}</span>
            {typeof value === "number" ? (
              // 直接标注最新值：图例不只是一块色块 + 名字，它同时是这条序列此刻的读数。
              <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
                {series.unit ? `${value} ${series.unit}` : String(value)}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/** compact 形态右侧的「最新值」——sparkline 自己不带轴，数值得由它来交代。 */
function CompactLatestValue({ model }: { model: ChartModel }) {
  const series = model.series[0];
  const latest = model.points.at(-1);
  const value = series && latest ? latest[series.key] : undefined;
  if (typeof value !== "number") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-baseline gap-1" data-testid="artifact-chart-latest">
      <span
        className={cn(
          "font-mono text-ui-base font-medium text-foreground tabular-nums",
          REVEAL_ANIMATION_CLASS,
        )}
        key={`latest-${latest?.sequence ?? "none"}`}
      >
        {value}
      </span>
      {series?.unit ? (
        <span className="text-ui-xs text-foreground-subtle">{series.unit}</span>
      ) : null}
    </span>
  );
}

export function ArtifactChartView({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  // 派生点唯一：applyArtifactItems 的结果在这里被裁到 ARTIFACT_CHART_MAX_SERIES。
  // 裁剪必须早于所有下游消费，否则图例会列出超限序列而图里没有对应颜色。
  // 依赖固定为 [spec, items]，只有两者引用稳定时，下层 memo 的比较谓词才可能命中。
  // 空数据不在 useMemo 里兜底，由后续空态分支统一决定标题与占位，避免两处判断分叉。
  const model = useMemo(() => {
    const built = applyArtifactItems("chart", spec, items);
    // 色槽只有 6 个，多出来的序列不画——循环复用颜色会让两条序列长得一模一样。
    return built.series.length > ARTIFACT_CHART_MAX_SERIES
      ? { ...built, series: built.series.slice(0, ARTIFACT_CHART_MAX_SERIES) }
      : built;
  }, [spec, items]);

  if (model.points.length === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={cn("flex min-w-0 items-center gap-2", className)}
        data-testid="artifact-chart-compact"
      >
        <div className="min-w-0 flex-1">
          <ArtifactChartPlot compact model={model} />
        </div>
        <CompactLatestValue model={model} />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-chart">
      <PresetHeading className="mb-2" description={spec.description} title={spec.title} />
      <div className="mb-2">
        <ChartLegendRow model={model} />
      </div>
      <ArtifactChartPlot compact={false} model={model} />
      <div className="mt-1 text-center text-ui-xs text-foreground-subtlest">
        {fieldHeading(model.x.label, model.x.unit)}
      </div>
    </div>
  );
}

export default ArtifactChartView;
