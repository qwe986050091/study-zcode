// INV-01 工具组件透传属性：守住位置 参数展开；改错故障 调用方无法控制折叠态。
// INV-02 状态文案与图标键一致：守住位置 两张表同键；改错故障 某状态缺少图标。
// INV-03 未知状态必须被类型拦住：守住位置 键类型；改错故障 新增状态渲染空白。
// INV-04 标题优先用显式名称：守住位置 空值合并；改错故障 动态工具显示内部类型名。
// INV-05 静态类型名要剥离前缀：守住位置 切分逻辑；改错故障 标题出现提供方前缀。
// INV-06 徽标同时含图标与文字：守住位置 组合渲染；改错故障 只靠颜色区分状态。
// INV-07 参数区始终可折叠：守住位置 折叠内容组件；改错故障 长参数撑满消息。
// INV-08 参数与结果都用代码块：守住位置 序列化调用；改错故障 对象被渲染成字符。
// INV-09 空结果不渲染：守住位置 早退分支；改错故障 出现空结果标题。
// INV-10 失败态只显示错误文本：守住位置 错误优先分支；改错故障 错误与结构化数据同时出现。
// INV-11 成功态按类型分流：守住位置 对象与字符串判断；改错故障 复杂对象被当成文本。
// INV-12 已有元素不重复序列化：守住位置 元素判断；改错故障 渲染结果被转成字符串。
// INV-13 高度上限固定：守住位置 滚动容器类；改错故障 超长输出撑破面板。
// INV-14 标题与内容共用字号：守住位置 文本类；改错故障 两处层级不一致。
// INV-15 失败配色使用破坏色：守住位置 条件类；改错故障 错误看起来像普通结果。
// INV-16 展开图标随状态旋转：守住位置 组数据变体；改错故障 展开后箭头不动。
// INV-17 来源与许可保留在文件头：守住位置 顶部注释；改错故障 二次分发丢失归属。
// INV-18 客户端指令保持在首行区块之后：守住位置 指令位置；改错故障 组件被当服务端渲染。
//
// 模块职责：工具调用卡片，包含折叠外壳、状态徽标、参数区与结果区。
// 状态所有权：无内部状态；折叠是否展开由调用方通过属性控制。
// 阅读顺序：先看两张状态表，再看头部与内容，最后看结果区的分流。
/*
 * Derived from vercel/ai-elements (packages/elements/src/tool.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Badge } from "../ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block.js";

// ToolProps 直接取 Collapsible 的 ComponentProps，透传全部属性。
// 导出类型与 Collapsible 参数保持同构，不额外包一层。
// ToolPart 覆盖 ToolUIPart 与 DynamicToolUIPart 两种形态。
// 动态形态走 DynamicToolUIPart，toolName 必填。
// 静态形态从 type 串按 "-" 切分推导工具名。
export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

// statusLabels 覆盖 ToolPart 的七种 state。
// statusLabels 与 statusIcons 的键集合必须一致。
// getStatusBadge() 同时渲染图标与文案。
// 新增 state 时两张表要同步补齐，否则类型报错。
const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-ui-base" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

// 标题优先用调用方传入的 title。
// 缺省名由 type.split("-").slice(1) 拼出。
// getStatusBadge(state) 放在标题右侧。
// ChevronDownIcon 靠右，配色与内容一致。
export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn("flex w-full items-center justify-between gap-4 p-3", className)}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-ui-base">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-ui-base uppercase tracking-wide">
      Parameters
    </h4>
    <div className="max-h-60 overflow-auto rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output: ReactNode = null;

  if (!errorText) {
    Output = <div>{output as ReactNode}</div>;
    if (typeof output === "object" && !isValidElement(output)) {
      Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />;
    } else if (typeof output === "string") {
      Output = <CodeBlock code={output} language="json" />;
    }
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-ui-base uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "max-h-60 overflow-auto rounded-md text-ui-base [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText ? (
          // 工具失败时很多 provider 会把错误同时塞进 output.error 和原始 payload。
          // 之前这里会一边显示错误，一边继续把 JSON result 整块渲染出来，视觉上像“报错被参数淹没”。
          // 失败态只保留可读错误文本，避免用户继续读无效结构化数据。
          <div className="whitespace-pre-wrap p-3">{errorText}</div>
        ) : null}
        {Output}
      </div>
    </div>
  );
};
