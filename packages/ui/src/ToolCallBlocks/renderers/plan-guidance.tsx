// INV-01 输出优先于输入：守住位置 候选顺序；改错故障 回显请求而非指导正文。
// INV-02 字符串先 trim 再判空：守住位置 取值；改错故障 纯空白被当成有效内容。
// INV-03 对象只认三个键：守住位置 字段白名单；改错故障 任意键被渲染成正文。
// INV-04 原始输出支持两种形态：守住位置 rawOutput 分支；改错故障 结构化输出丢失。
// INV-05 内容数组逐项下钻：守住位置 循环；改错故障 嵌套内容被整体丢弃。
// INV-06 数组元素必须为对象：守住位置 类型守卫；改错故障 字符串元素引发属性访问错误。
// INV-07 内层 content 优先：守住位置 嵌套判断；改错故障 外层元数据被当成正文。
// INV-08 找不到正文返回未定义：守住位置 末尾；改错故障 空串被当成有效内容。
// INV-09 有正文时不显示原始输出：守住位置 三元分支；改错故障 正文与 JSON 同时出现。
// INV-10 失败时正文退让给错误：守住位置 输出参数；改错故障 错误与半截正文混杂。
// INV-11 渲染回调依赖显式列出：守住位置 useCallback；改错故障 上下文变化后仍用旧回调。
// INV-12 空正文走通用输出组件：守住位置 分支；改错故障 空白区域无任何提示。
// INV-13 图标常量模块级复用：守住位置 顶部；改错故障 每次渲染重建元素。
// INV-14 失败状态才显示状态标：守住位置 条件；改错故障 成功状态也带失败样式。
// INV-15 失败提示复用错误文本：守住位置 悬浮说明；改错故障 提示与实际错误不一致。
// INV-16 展示开关支持外部覆盖：守住位置 合并；改错故障 调用方无法折叠。
// INV-17 快照提示独立渲染：守住位置 末尾节点；改错故障 快照引用无法按需加载。
// INV-18 工具名与标题原样透传：守住位置 布局入参；改错故障 标题被改写丢失来源。
//
// 模块职责：把计划指导工具的调用结果渲染成 Markdown 正文。
// 状态所有权：无状态；正文与错误都从上下文实时推导。
// 阅读顺序：先看正文提取，再看渲染回调，最后看布局装配。
import { NotepadText } from "lucide-react";
import { useCallback } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// PLAN_GUIDANCE_TOOL_ICON 在模块级只创建一次。
// 尺寸与颜色由 className 的设计变量决定。
// ToolLayout 只接收 icon 元素，不关心图标来源。
// 换图标只改 PLAN_GUIDANCE_TOOL_ICON，渲染逻辑不动。
const PLAN_GUIDANCE_TOOL_ICON = <NotepadText className="size-4 shrink-0 text-foreground-subtle" />;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

// extractGuidanceMarkdown 先试 output 再试 input。
// 字符串候选 trim 后非空即返回。
// 对象候选走 readStringField 的 text/content/output 白名单。
// toolCall.raw 是最后一层兜底来源。
// 所有候选落空才返回 undefined。
function extractGuidanceMarkdown(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  for (const candidate of [toolCall.output, toolCall.input]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    if (isRecord(candidate)) {
      const directText = readStringField(candidate, ["text", "content", "output"]);
      if (directText) {
        return directText;
      }
    }
  }

  if (!isRecord(toolCall.raw)) {
    return undefined;
  }

  const rawOutputText =
    typeof toolCall.raw.rawOutput === "string"
      ? toolCall.raw.rawOutput.trim()
      : isRecord(toolCall.raw.rawOutput)
        ? readStringField(toolCall.raw.rawOutput, ["text", "content", "output"])
        : undefined;
  if (rawOutputText) {
    return rawOutputText;
  }

  const content = Array.isArray(toolCall.raw.content) ? toolCall.raw.content : [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    const nested = isRecord(item.content) ? item.content : item;
    const nestedText = readStringField(nested, ["text", "content", "output"]);
    if (nestedText) {
      return nestedText;
    }
  }

  return undefined;
}

// errorText 与 guidanceMarkdown 在组件体内各取一次。
// renderContent 用 useCallback 按上下文依赖重建。
// ToolLayout 的入参全部来自 ToolCallBlockRenderContext。
// statusLabel 只在 toolCall.status === "failed" 时挂上。
// ToolSnapshotFieldNotice 渲染在 ToolLayout 之后。
export function PlanGuidanceToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const guidanceMarkdown = extractGuidanceMarkdown(toolCall);
  // 正文存在时渲染 Markdown。
  // MessageResponse 的预览与链接回调都取自 context。
  // guidanceMarkdown 为空时退回 ToolOutput。
  // errorText 存在时 output 传 undefined，避免半截正文混入。
  // useCallback 依赖数组与入参一一对应。
  const renderContent = useCallback(
    () =>
      guidanceMarkdown ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          <MessageResponse
            className="min-w-0 break-words [&_h1]:text-foreground-subtlest [&_h2]:text-foreground-subtlest [&_h3]:text-foreground-subtlest [&_li]:text-foreground-subtlest [&_p]:text-foreground-subtlest"
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenExternalUrl={context.onOpenBrowserUrl}
          >
            {guidanceMarkdown}
          </MessageResponse>
        </div>
      ) : (
        <ToolOutput errorText={errorText} output={errorText ? undefined : toolCall.output} />
      ),
    [
      context.codePreviewSettings,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      errorText,
      guidanceMarkdown,
      toolCall.output,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={PLAN_GUIDANCE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={intl.formatMessage({ id: "planTool.guidance.enterMode" })}
        sourceLabel={context.sourceLabel}
        primaryText={null}
        secondaryText={undefined}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
