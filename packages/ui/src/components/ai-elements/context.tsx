/*
 * Derived from vercel/ai-elements (packages/elements/src/context.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// Context 用量悬浮卡组件族：Context 提供 usedTokens/maxTokens/usage/modelId 上下文，
// 由触发器、环形占用图标、头部百分比进度、正文分项与费用尾栏组合成上下文占用视图。
// 本文件只做展示投影，不负责拉取真实额度、不决定计费口径、不触发额度重置或压缩流程。
//
// INV-01 断言：usedTokens 与 maxTokens 原样透传不做截断与单位换算 —— 守住它的位置：Context 的 useMemo 入参与 ContextSchema —— 改错故障：悬浮卡显示的额度与调用方传入值不一致。
// INV-02 断言：maxTokens 小于等于 0 时占用率恒为 0 —— 守住它的位置：formatUsagePercent 的早退分支 —— 改错故障：除零产生 NaN，进度条宽度与环形 dashoffset 同时失效。
// INV-03 断言：占用率被钳制在 0 到 1 之间 —— 守住它的位置：formatUsagePercent 的 Math.min 与 Math.max —— 改错故障：超限用量让进度条溢出容器且百分比超过 100%。
// INV-04 断言：ContextContext 默认值是 null 而不是空对象 —— 守住它的位置：createContext 调用与 useContextValue —— 改错故障：脱离 Provider 使用时静默渲染 0 令牌而不是抛出明确错误。
// INV-05 断言：Provider 的 value 依赖必须覆盖四个字段 —— 守住它的位置：Context 的 useMemo 依赖数组 —— 改错故障：切换模型后费用行仍沿用上一次的 usage。
// INV-06 断言：环形进度的周长按 ICON_RADIUS 计算而非 viewBox 半径 —— 守住它的位置：ContextIcon 的 circumference —— 改错故障：进度弧与底层灰色轨道半径不一致，端点错位。
// INV-07 断言：触发器一旦收到 children 就完全接管渲染，loading 不再生效 —— 守住它的位置：ContextTrigger 的 children 空值合并 —— 改错故障：自定义触发器在重置中不转圈，用户误以为卡死。
// INV-08 断言：HoverCard 的 0 延迟写在 props 之前，允许调用方覆盖 —— 守住它的位置：Context 返回的 HoverCard 属性顺序 —— 改错故障：属性顺序颠倒后悬浮卡无法响应调用方配置。
// INV-09 断言：进度条 value 使用 0 到 100 的百分比而不是 0 到 1 的比例 —— 守住它的位置：ContextContentHeader 的 usedPercent 乘 PERCENT_MAX —— 改错故障：进度条几乎不显示，百分比文字却正常。
// INV-10 断言：头部百分比文本与进度条共用同一个 usedPercent —— 守住它的位置：ContextContentHeader 的 displayPct 与 Progress —— 改错故障：文字与进度条各自重算后出现比例偏差。
// INV-11 断言：分项用量为 0 或缺失时整行返回 null —— 守住它的位置：四个 Usage 组件的 falsy 早退 —— 改错故障：空态下多出四行 0 费用，卡片高度抖动。
// INV-12 断言：children 优先于空值早退与内置渲染 —— 守住它的位置：四个 Usage 组件首个 if —— 改错故障：调用方自定义内容被 0 值提前吞掉。
// INV-13 断言：仅在 modelId 存在时才调用 getUsage —— 守住它的位置：Footer 与三个 Usage 组件的三元短路 —— 改错故障：无模型信息时仍发起成本查询或渲染误导性的 0 美元。
// INV-14 断言：传给 getUsage 的计费维度必须补齐全部字段 —— 守住它的位置：Footer、Input、Output、Cache 的 usage 对象 —— 改错故障：undefined 进入计费库，总价变成 NaN。
// INV-15 断言：Output 与 Cache 查询要把 input 显式置 0 —— 守住它的位置：ContextOutputUsage 与 ContextCacheUsage 的 usage 字面量 —— 改错故障：分项成本被重复计入输入侧，总价虚高。
// INV-16 断言：Cache 行读取 cachedInputTokens 并映射为 cacheReads —— 守住它的位置：ContextCacheUsage 的字段映射 —— 改错故障：缓存命中的令牌不展示，用户误判成本来源。
// INV-17 断言：货币与数字格式跟随系统 locale，不硬编码语言 —— 守住它的位置：Intl.NumberFormat 的 undefined 区域参数 —— 改错故障：中文界面出现混排的美元格式。
// INV-18 断言：tokens 为 undefined 时显示破折号，0 才是真实零 —— 守住它的位置：TokensWithCost 的条件分支 —— 改错故障：未知用量被渲染成 0，掩盖数据缺失。
//
// 渲染层级：Context 只负责 Provider 与 HoverCard，触发器、内容、头、体、尾与分项均为独立导出，
// 由调用方自由拼装，任一子组件缺席时其余部分仍需保持可用。
// 费用统一取 tokenlens 的 costUSD.totalUSD，单位固定美元，与界面语言无关。
// 令牌总数在头部用 formatFullNumber 展示完整分组数字，分项行用紧凑缩写。
// 样式类一律追加在调用方 className 之后，不覆盖也不删除其传入值。
import { Button } from "../ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import { Progress } from "../ui/progress.js";
import { cn } from "../lib/utils.js";
import type { LanguageModelUsage } from "ai";
import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { getUsage } from "tokenlens";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

// 常量区划界：PERCENT_MAX 只作为 0 到 1 比例换算成进度条刻度的基数，不参与上限钳制。
// ICON_ 前缀常量属于 SVG 内部坐标系，与 CSS 尺寸 size-3.5 没有换算关系，改视觉尺寸应改类名而不是这些值。
// 环形图半径同时决定周长与描边圆心，任何一项单独修改都会让进度弧与轨道错位。
// 这些值被 ContextIcon 与 ContextContentHeader 共享，改名或抽走会同时影响图标与进度条。
const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 4;

type ModelId = string;

// usage 与 modelId 可选是刻意的：缺少用量时仍要渲染可用的空态卡片，而不是让整块组件崩溃。
// usedTokens 与 maxTokens 必须必填，缺失会让 formatUsagePercent 收到 undefined 并产出 NaN。
// 这里只承载展示所需的四个字段，不放入回调或请求状态，避免 Provider 值频繁变更导致整棵子树重渲染。
// ModelId 保持 string 别名，不在此收窄为联合类型，否则新增模型都要改 UI 层。
interface ContextSchema {
  usedTokens: number;
  maxTokens: number;
  usage?: LanguageModelUsage;
  modelId?: ModelId;
}

// 默认值刻意设为 null：任何脱离 Provider 的调用都会在 useContextValue 处立即抛错，
// 而不是拿到字段为 undefined 的假上下文后渲染出看似正常的 0 令牌。
// 若改成对象字面量作为默认值，缺失 Provider 的用例将静默通过，问题只会推迟到线上暴露。
const ContextContext = createContext<ContextSchema | null>(null);

// 完整数字用于头部「已用 / 总量」一行，必须保留千分位分组，不能改走紧凑缩写。
// locale 传 undefined 表示跟随运行环境，硬编码区域会让多语言界面出现格式割裂。
// 该函数不处理小数与单位，令牌数按整数展示，单位由文案层负责。
function formatFullNumber(value: number) {
  return new Intl.NumberFormat(undefined).format(value);
}

// 零额度保护：maxTokens 小于等于 0 时直接返回 0，必须先于除法执行，否则得到 Infinity 或 NaN。
// 结果钳制在 0 到 1：超出额度的用量仍按满圈展示，不允许把真实比例透传给进度条造成溢出。
// 返回的是比例而非百分比，百分比换算只在 Header 乘 PERCENT_MAX，两处口径不可混用。
// 负数用量同样被钳到 0，防止上游异常值画出反向进度。
// 该函数是纯函数且被环形图与进度条共用，任何行为变更都会同时影响两处视觉。
function formatUsagePercent(usedTokens: number, maxTokens: number) {
  if (maxTokens <= 0) {
    return 0;
  }

  return Math.min(Math.max(usedTokens / maxTokens, 0), 1);
}

// 缺失上下文时抛错而不是回退默认值：回退会让卡片显示 0 令牌，用户无法察觉集成错误。
// 错误文案固定，便于调用方在开发期直接定位缺少 Provider 的层级。
// 该 hook 不缓存结果，读取的始终是最近一次 Provider 提供的值。
const useContextValue = () => {
  const context = useContext(ContextContext);

  if (!context) {
    throw new Error("Context components must be used within Context");
  }

  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

// value 通过 useMemo 固定引用，依赖只列四个原始字段；usage 对象引用变化即视为新数据。
// 若把整个 props 或新建对象放进依赖，父级每次渲染都会重建上下文并触发所有子组件重算费用。
// 属性展开放在 closeDelay 与 openDelay 之后，保证调用方传入的同名属性优先生效。
// Provider 包在 HoverCard 外层，使触发器与内容都能读到同一份上下文。
export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
  const contextValue = useMemo(
    () => ({ maxTokens, modelId, usage, usedTokens }),
    [maxTokens, modelId, usage, usedTokens],
  );

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  );
};

// 周长按 ICON_RADIUS 计算，与 viewBox 的 24 单位坐标系无关，改动半径必须同步轨道圆。
// dashoffset 由钳制后的 usedPercent 推导，进度弧从 12 点方向顺时针增长。
// 底层轨道圆固定 opacity 0.25、进度圆固定 0.7，两者叠出双层环效果，不要合并成单圆。
// 图标整体 aria-hidden，语义信息由触发器按钮与头部百分比承担。
const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const usedPercent = formatUsagePercent(usedTokens, maxTokens);
  const dashOffset = circumference * (1 - usedPercent);

  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      focusable="false"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

// loading 表示额度正在重置，仅影响默认图标；自定义 children 时该字段被忽略。
// 该类型继承 Button 属性，尺寸与变体由调用方透传，组件本身不改写。
// 不要在此新增必填字段，已有调用点均按可选属性使用。
export type ContextTriggerProps = ComponentProps<typeof Button> & {
  /** 触发器转圈：额度自动重置进行中时替换 ContextIcon（对应「正在重置」状态）。 */
  loading?: boolean;
};

// children 存在时完全接管渲染，默认按钮与 loading 转圈都不再出现，这是刻意留给调用方的逃生口。
// HoverCardTrigger 使用 asChild，把交互能力挂到唯一子节点上，因此默认分支只能返回单个元素。
// 加载图标带 motion-reduce 降级，系统开启减少动效时退化为静态图标。
// 按钮属性展开在 className 之前，再由 cn 合并，保证调用方类名不会覆盖布局类。
export const ContextTrigger = ({ children, loading = false, ...props }: ContextTriggerProps) => {
  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          {...props}
          className={cn(props.className)}
        >
          {loading ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <ContextIcon />
          )}
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

// 内容面板宽度用 important 修饰的 w-64 锁定，因为 HoverCardContent 自带宽度会被普通类名覆盖。
// p-0 交给内部头部与正文各自控制内边距，避免嵌套出现双份留白。
// className 追加在固定样式之后，调用方只能增量覆盖，不能删除基础边框与圆角。
export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent
    className={cn(
      "!w-64 overflow-hidden rounded-lg border border-border bg-tooltip p-0 text-tooltip-foreground shadow-none ring-0 outline-0",
      className,
    )}
    {...props}
  />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

// displayPct 与进度条 value 都来自同一个 usedPercent，禁止任何一侧另算。
// Progress 的 value 需要乘 PERCENT_MAX 转成 0 到 100，直接传比例会让进度条几乎不显示。
// segments 原样透传给进度条，用于展示多段配额构成，本组件不参与分段计算。
// children 存在时整体替换内置头部，此时百分比与进度条都不渲染，但仍会先读取上下文。
export const ContextContentHeader = ({
  action,
  children,
  className,
  progressSegments,
  ...props
}: ContextContentHeaderProps & {
  action?: ReactNode;
  progressSegments?: readonly {
    className?: string;
    id: string;
    percent: number;
  }[];
}) => {
  // 这里是 Header 内第二次解构，Icon 也有一处相同语句，改动时不要合并成模块级常量。
  // 解构发生在 children 判断之前，因此即使自定义头部也要求处于 Provider 内。
  // `maxTokens` 只做展示，不参与 `usedPercent` 的上限推导。
  const { usedTokens, maxTokens } = useContextValue();
  const usedPercent = formatUsagePercent(usedTokens, maxTokens);
  const displayPct = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent);
  const used = formatFullNumber(usedTokens);
  const total = formatFullNumber(maxTokens);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui-base font-medium text-foreground-subtle">Context</p>
            {action}
          </div>
          <div className="border-t border-border" />
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <p className="text-ui-lg font-medium text-foreground">{displayPct}</p>
            <p>
              {used} / {total}
            </p>
          </div>
          <Progress
            className="h-2 bg-surface"
            indicatorClassName="min-w-2"
            segments={progressSegments}
            value={usedPercent * PERCENT_MAX}
          />
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

// 正文容器只做内边距与背景，不含任何业务读取，可安全复用于自定义内容。
// 背景使用 bg-menu 与头部 bg-tooltip 形成层次差，替换任一侧都会让分区消失。
export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full bg-menu p-3", className)} {...props}>
    {children}
  </div>
);

export type ContextContentFooterProps = ComponentProps<"div">;

// 总价按输入与输出两段分别取值后求和，推理与缓存不计入该行，避免重复计费。
// 缺 modelId 时不调用计费库，costUSD 保持 undefined，最终格式化为 0 美元占位。
// 因此 0 美元同时代表「无模型」与「成本为零」，需要区分时应看 modelId 是否传入。
// 尾栏使用固定底部分隔线，children 存在时整行替换但仍保留容器样式。
export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { modelId, usage } = useContextValue();
  // 三元短路保证无 modelId 时不触发 getUsage，避免未知模型进入计费库查询。
  // 输入与输出缺失时补 0，计费库不接受 undefined 维度。
  // 只取 totalUSD，其他币种或明细字段不在本组件展示范围内。
  const costUSD = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;
  const totalCost = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(costUSD ?? 0);

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 border-t border-popover-border bg-surface p-3 text-ui-base",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span>{totalCost}</span>
        </>
      )}
    </div>
  );
};

// undefined 与 0 语义不同：前者表示数据缺失显示破折号，后者是真实的零令牌。
// 紧凑缩写由 formatCompactTokenNumber 负责，前缀传空串避免出现多余单位前导。
// 费用片段可选，存在时以圆点分隔追加在令牌数之后。
const TokensWithCost = ({ tokens, costText }: { tokens?: number; costText?: string }) => (
  <span>
    {tokens === undefined ? "—" : formatCompactTokenNumber("", tokens)}
    {costText ? <span className="ml-2 text-muted-foreground">• {costText}</span> : null}
  </span>
);

export type ContextInputUsageProps = ComponentProps<"div">;

// children 优先于零值早退，否则调用方自定义内容会在输入为 0 时被吞掉。
// 输入侧查询只填 input，output 显式置 0，避免把输出成本算进输入行。
// inputTokens 缺失时按 0 处理，从而触发早退返回 null。
export const ContextInputUsage = ({ className, children, ...props }: ContextInputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const inputTokens = usage?.inputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!inputTokens) {
    return null;
  }

  const inputCost = modelId
    ? getUsage({
        modelId,
        usage: { input: inputTokens, output: 0 },
      }).costUSD?.totalUSD
    : undefined;
  const inputCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(inputCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Input</span>
      <TokensWithCost costText={inputCostText} tokens={inputTokens} />
    </div>
  );
};

export type ContextOutputUsageProps = ComponentProps<"div">;

// 与输入行结构对称，差别只在取 outputTokens 并把 input 置 0。
// 输出为 0 时整行不渲染，因此纯输入请求不会出现多余的输出行。
// children 判断仍在最前，保证自定义覆盖不受数据状态影响。
export const ContextOutputUsage = ({ className, children, ...props }: ContextOutputUsageProps) => {
  const { usage, modelId } = useContextValue();
  const outputTokens = usage?.outputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!outputTokens) {
    return null;
  }

  const outputCost = modelId
    ? getUsage({
        modelId,
        usage: { input: 0, output: outputTokens },
      }).costUSD?.totalUSD
    : undefined;
  const outputCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(outputCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Output</span>
      <TokensWithCost costText={outputCostText} tokens={outputTokens} />
    </div>
  );
};

export type ContextReasoningUsageProps = ComponentProps<"div">;

// 推理令牌走独立字段 reasoningTokens，计费库只接受该键名。
// 该行不计入输入与输出，避免与总量重复统计。
// 推理用量缺失时整行消失，而不是显示 0。
export const ContextReasoningUsage = ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage, modelId } = useContextValue();
  const reasoningTokens = usage?.reasoningTokens ?? 0;

  if (children) {
    return children;
  }

  if (!reasoningTokens) {
    return null;
  }

  const reasoningCost = modelId
    ? getUsage({
        modelId,
        usage: { reasoningTokens },
      }).costUSD?.totalUSD
    : undefined;
  const reasoningCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(reasoningCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Reasoning</span>
      <TokensWithCost costText={reasoningCostText} tokens={reasoningTokens} />
    </div>
  );
};

export type ContextCacheUsageProps = ComponentProps<"div">;

// 缓存命中读取 cachedInputTokens，传给计费库时映射为 cacheReads。
// input 与 output 显式置 0，否则缓存行会把整次请求成本重复计入。
// 缓存为 0 时整行不渲染，空态卡片只保留实际发生的分项。
export const ContextCacheUsage = ({ className, children, ...props }: ContextCacheUsageProps) => {
  const { usage, modelId } = useContextValue();
  const cacheTokens = usage?.cachedInputTokens ?? 0;

  if (children) {
    return children;
  }

  if (!cacheTokens) {
    return null;
  }

  const cacheCost = modelId
    ? getUsage({
        modelId,
        usage: { cacheReads: cacheTokens, input: 0, output: 0 },
      }).costUSD?.totalUSD
    : undefined;
  const cacheCostText = new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(cacheCost ?? 0);

  return (
    <div className={cn("flex items-center justify-between text-ui-base", className)} {...props}>
      <span className="text-foreground-subtle">Cache</span>
      <TokensWithCost costText={cacheCostText} tokens={cacheTokens} />
    </div>
  );
};
