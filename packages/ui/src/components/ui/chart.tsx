// Chart 组件族：容器 + 主题 CSS 变量注入 + Tooltip/Legend 内容渲染 + 载荷配置解析。
// 不变量清单 INV-01..INV-20：每条给出约束、守卫位置与破坏后果。
// INV-01 THEMES 的键集是 CSS 变量生成的唯一来源，守卫在 ChartStyle 的 Object.entries(THEMES) 循环；改键名会让暗色变量整批缺失，图表回退默认色。
// INV-02 ChartConfig 的 color 与 theme 互斥，守卫在交叉联合类型；两者同时提供会让类型层报错，运行时 theme 优先，颠倒优先级会破坏暗色覆盖。
// INV-03 ChartContext 必须由 ChartContainer 提供，守卫在 useChart 的空值判断；把默认值改为空对象会让越界使用静默渲染空标签。
// INV-04 chartId 必须是合法 CSS 属性选择器值，守卫在 useId 结果上的冒号剔除；保留冒号会让选择器非法，整套主题变量失效。
// INV-05 Provider value 必须引用稳定，守卫在 React.useMemo 且依赖仅为 config；去掉 memo 会让每个消费者在父级 render 时全部重渲染。
// INV-06 data-chart 与 ChartStyle 的 id 必须同源，守卫是同一个 chartId 变量；两者分叉时作用域选择器匹配不到容器，颜色变量全部落空。
// INV-07 内联样式内容只由 id 与 config 拼接，守卫在 dangerouslySetInnerHTML 单点注入；把用户输入当 config 键会形成 CSS 注入面。
// INV-08 无可着色条目时 ChartStyle 返回 null，守卫在 colorConfig 长度判断；改为总是渲染会让严格 CSP 记录无意义的内联样式违规。
// INV-09 Tooltip 的提前返回必须发生在所有 hook 之后，守卫是 useChart 与 useMemo 的调用位置；前移会破坏 hook 调用顺序并触发运行时错误。
// INV-10 tooltipLabel 的 memo 依赖必须覆盖 label、labelFormatter、payload、hideLabel、labelClassName、config、labelKey；漏项会读到上一帧载荷。
// INV-11 标签解析优先级为 labelKey 走载荷配置、字符串 label 先查 config 再回落原值，守卫在 value 的三元表达式；颠倒会让静态字符串覆盖配置标签。
// INV-12 行键回落顺序为 nameKey、item.name、item.dataKey、value，必须与 ChartConfig 键一致；不一致时取不到 label/icon，只显示原始 dataKey。
// INV-13 Tooltip 与 Legend 都必须过滤 type 为 none 的占位系列，守卫在两处 filter；去掉过滤会渲染出无名称无数值的空行。
// INV-14 nestLabel 仅在单系列且指示器非 dot 时为真，守卫在该布尔表达式；条件改动会让标签在顶部与行内之间重复或丢失。
// INV-15 指示块颜色回落链为 color、payload.fill、item.color，守卫在 indicatorColor；任一段缺失只影响视觉，不阻断文本渲染。
// INV-16 自定义 formatter 分支要求值与名称都存在，守卫在 formatter 三元条件；放宽条件会让 formatter 收到 undefined 并在用户代码里抛错。
// INV-17 列表以数组下标作 key，合理性依赖 payload 顺序在单次 hover 内稳定；若系列动态增删，下标 key 会复用错误节点导致状态错位。
// INV-18 载荷解析只解一层 payload.payload 且只接受字符串值作配置键，守卫在 getPayloadConfigFromPayload；放宽会让非字符串被当作键查表。
// INV-19 数值用 toLocaleString 做千分位、字符串用 String、空值不渲染，守卫在 typeof 分支；混用会在界面上出现 undefined 文本。
// INV-20 对外导出面固定为容器、Tooltip、Legend、样式及其内容组件，守卫在文件末尾的导出块；ChartContext 与 useChart 不外泄，删导出属破坏性变更。
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { TooltipValueType } from "recharts";

import { cn } from "@/components/lib/utils.js";

// Format: { THEME_NAME: CSS_SELECTOR }
// THEMES 的键集就是 CSS 变量生成的作用域清单，light 前缀为空串表示根级选择器。
// 新增主题必须同步 ChartConfig 中 theme 的映射类型，否则类型检查会报缺键。
// [权衡] 用常量对象而非枚举，便于直接拼进选择器，代价是键名只在编译期受约束。
const THEMES = { light: "", dark: ".dark" } as const;

// ResponsiveContainer 首帧测量前使用该固定尺寸，避免宽高为 0 时等比容器塌陷。
// [失败路径] 删掉这个回落后，SSR 或隐藏面板内的首帧会以 0x0 渲染并触发 Recharts 警告。
const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
// Recharts 的系列名允许数值或字符串，这里收窄后作为 DefaultTooltipContentProps 的泛型参数。
type TooltipNameType = number | string;

// 条目形状用交叉类型强制 color 与 theme 二选一，以此表达明暗两套配色策略。
// label 允许 ReactNode，因此 Tooltip 与 Legend 里可以直接渲染图标或富文本节点。
// [权衡] theme 用 Record<keyof typeof THEMES, string> 而非可选映射，保证每个主题都必须给色。
// icon 是可实例化的组件类型，渲染处写作 <itemConfig.icon />，因此不能传普通函数。
export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>;

type ChartContextProps = {
  config: ChartConfig;
};

// 默认值刻意设为 null，让 useChart 能区分未包裹与配置为空两种情况，而不是静默降级。
// [失败路径] 改成空对象作默认值会让所有越界使用变成运行时的 undefined 标签。
const ChartContext = React.createContext<ChartContextProps | null>(null);

// 唯一的 context 读取入口，Tooltip 与 Legend 都经由它取 config，保证数据路径一致。
// [并发] 该 hook 无状态、无副作用，可在任意渲染阶段安全调用。
function useChart() {
  const context = React.useContext(ChartContext);

  if (!context) {
    // [失败路径] 缺少 Provider 时立即抛错并带上组件名，便于定位越界调用点。
    // 错误文案是对外契约，改动会让依赖字符串匹配的既有测试失败。
    throw new Error("useChart must be used within a <ChartContainer />");
  }

  return context;
}

// 容器负责三件事：生成唯一 chartId、注入主题 CSS、包一层 ResponsiveContainer。
// id 由调用方透传，便于服务端预渲染时对齐选择器，未传则回落到 useId。
// 其余 div 属性通过剩余参数透传，但内置的 data-slot 与 data-chart 会覆盖同名属性。
function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  initialDimension?: {
    width: number;
    height: number;
  };
}) {
  const uniqueId = React.useId();
  // useId 生成的标识含冒号，不能直接进 CSS 属性选择器，这里统一剔除。
  // [失败路径] 去掉剔除逻辑后选择器解析失败，整块 style 规则会被浏览器丢弃。
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;
  // Recharts 会在 effect 里把图表 props 镜像到内部 store。
  // Provider value 每次 render 都换引用会放大这些更新，稳定 context 可避免无意义的二次渲染链。
  // Provider 值只依赖 config，用 memo 固定引用，避免父级每次 render 触发消费者更新。
  // [权衡] 依赖数组只写 config 本身，因此配置对象需由调用方保持引用稳定。
  // [并发] 若调用方每次传入内联字面量，memo 失效但语义仍正确，只是多一轮渲染。
  const contextValue = React.useMemo(() => ({ config }), [config]);

  return (
    <ChartContext.Provider value={contextValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-ui-sm [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

// 按主题前缀生成 --color-<key> 形式的变量，供图表内部以 var() 引用。
// 先过滤掉既无 theme 又无 color 的条目，避免生成空变量声明。
// [权衡] 用内联 style 而非外部样式表，换来随 config 动态更新，代价是 CSP 必须放行内联样式。
const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, config]) => config.theme ?? config.color);

  // 没有任何可着色条目时返回 null，不向 DOM 插入空 style 节点。
  // [失败路径] 改成渲染空标签后，严格 CSP 下仍会记录一次内联样式违规。
  if (!colorConfig.length) {
    return null;
  }

  return (
    // dangerouslySetInnerHTML 是唯一注入点，内容完全由 id 与 config 拼接而成。
    // [安全] 拼接前不做转义，因此配置键与颜色值必须来自可信代码，不能取自用户输入。
    // 颜色值里的分号或花括号可提前闭合声明，属于潜在 CSS 注入面。
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    // 主题色优先于静态 color，保证暗色模式下能覆盖浅色默认值。
    // theme 缺少该主题键时回落到 color，两者都缺则返回空值并跳过该变量。
    // [失败路径] 优先级颠倒会让暗色主题被 color 永久遮蔽。
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ?? itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join("\n")}
}
`,
          )
          .join("\n"),
      }}
    />
  );
};

const ChartTooltip = RechartsPrimitive.Tooltip;

// Tooltip 内容渲染器，把 Recharts 载荷映射为带色块、标签与数值的行。
// indicator 的三态 dot、line、dashed 只影响指示块形状，不影响取值。
// hideLabel 与 hideIndicator 是纯展示开关，不参与数据解析。
function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<"div"> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "line" | "dot" | "dashed";
    nameKey?: string;
    labelKey?: string;
  } & Omit<
    RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>,
    "accessibilityLayer"
  >) {
  const { config } = useChart();

  // 标签计算放进 memo，依赖载荷、标签与 config，避免每次悬浮重复拼字符串。
  // 隐藏标签或载荷为空时直接返回 null，调用方据此决定是否渲染顶栏。
  // [并发] memo 内只做纯派生、不写副作用，严格模式双调用也安全。
  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null;
    }

    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>
      );
    }

    if (!value) {
      return null;
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  // [失败路径] 未激活或空载荷时整块返回 null，防止渲染出空壳浮层。
  // 该判断必须位于所有 hook 之后，保证不同分支的 hook 调用顺序一致。
  if (!active || !payload?.length) {
    return null;
  }

  // 单系列且指示器非 dot 时，把标签嵌进行内而不是放在浮层顶部。
  // [权衡] 该条件同时被顶部渲染与虚线指示器偏移复用，改动必须同步两处。
  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-ui-sm/relaxed shadow-xl",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          // Recharts 用 type 为 none 表示占位系列，过滤后 Tooltip 不显示空行。
          // [失败路径] 去掉过滤会出现既无名称也无数值的空白项。
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            // 指示块颜色回落链依次为显式 color、载荷 fill、系列 color。
            // 三段全空时色块透明，仅影响视觉，不阻断文本渲染。
            const indicatorColor = color ?? item.payload?.fill ?? item.color;

            return (
              <div
                // [权衡] 用下标作 key 依赖载荷顺序在单次悬浮内稳定，动态系列会复用错节点。
                key={index}
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
                  indicator === "dot" && "items-center",
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn(
                            "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                            {
                              "h-2.5 w-2.5": indicator === "dot",
                              "w-1": indicator === "line",
                              "w-0 border-[1.5px] border-dashed bg-transparent":
                                indicator === "dashed",
                              "my-0.5": nestLabel && indicator === "dashed",
                            },
                          )}
                          style={
                            {
                              "--color-bg": indicatorColor,
                              "--color-border": indicatorColor,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center",
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">
                          {itemConfig?.label ?? item.name}
                        </span>
                      </div>
                      {item.value != null && (
                        <span className="font-mono font-medium text-foreground tabular-nums">
                          {typeof item.value === "number"
                            ? item.value.toLocaleString()
                            : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

// 图例渲染器，按载荷顺序输出图标或色块再加标签。
// hideIcon 为真时强制使用色块，即使 config 里配置了图标组件。
// verticalAlign 只决定上下内边距，实际排布由父级弹性布局控制。
function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean;
  nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart();

  // [失败路径] 无图例项时返回 null，避免渲染仅含内边距的空容器。
  if (!payload?.length) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);

          return (
            <div
              key={index}
              className={cn(
                "flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
              )}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor: item.color,
                  }}
                />
              )}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

// 配置解析的共用函数，Tooltip 的标签与行、Legend 的行都走这里。
// 返回值可能是 undefined，调用方一律用可选链读取 label 与 icon。
// [失败路径] 载荷非对象时提前返回，防止对原始值做 in 运算抛错。
function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  // Recharts 的载荷可能再嵌套一层 payload，此处先探测属性再做二次取键。
  // `ChartConfig` 解析只解一层 `payload.payload`：深层嵌套罕见，换来路径可控且可预期。
  const payloadPayload =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey: string = key;

  if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
    configLabelKey = payload[key as keyof typeof payload] as string;
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
  }

  // [失败路径] 解析出的键不在 config 时回落原始 key，两者都缺则返回 undefined。
  return configLabelKey in config ? config[configLabelKey] : config[key];
}

// 对外只暴露容器、Tooltip、Legend、样式四个能力及其内容组件。
// ChartContext 与 useChart 不导出，避免外部绕过容器直接读取配置。
// [权衡] 导出 ChartStyle 便于单独复用，但也扩大了内联样式的可控面。
export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
};
