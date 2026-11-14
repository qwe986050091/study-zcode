// INV-01 兜底渲染必须可用：守住位置 默认导出路径；改错故障 未知工具整块消失。
// INV-02 图标可覆盖：守住位置 合并表达式；改错故障 已知工具显示扳手。
// INV-03 图标可关闭：守住位置 不等于判断；改错故障 嵌套场景出现双图标。
// INV-04 种类标签空值安全：守住位置 长度判断；改错故障 空种类导致取值异常。
// INV-05 种类首字母大写：守住位置 字符串拼接；改错故障 标签大小写不一。
// INV-06 内联预览抑制原始结构：守住位置 布尔判断；改错故障 内容重复展示。
// INV-07 原始结构可整体隐藏：守住位置 双重条件；改错故障 专门渲染下仍泄露原始数据。
// INV-08 加载能力按工具标识绑定：守住位置 闭包参数；改错故障 提示加载错误的工具。
// INV-09 摘要模式不带副文案：守住位置 条件属性；改错故障 摘要行右侧出现状态。
// INV-10 失败时副文案让位状态：守住位置 状态比较；改错故障 失败原因与状态重复。
// INV-11 失败提示用错误文本：守住位置 工具提示属性；改错故障 悬停看不到原因。
// INV-12 失败标记仅在失败时出现：守住位置 状态布尔；改错故障 成功块显示警示。
// INV-13 标题优先摘要覆盖值：守住位置 字符串判断；改错故障 摘要与标题不一致。
// INV-14 摘要覆盖非字符串时不提升标题：守住位置 类型判断；改错故障 对象被当成标题。
// INV-15 折叠能力默认开启：守住位置 兜底表达式；改错故障 未知工具无法展开。
// INV-16 折叠初始态由调用方决定：守住位置 默认值；改错故障 兜底块强制展开。
// INV-17 内容回调依赖完整：守住位置 依赖数组；改错故障 主题切换后预览不刷新。
// INV-18 摘要模式不显示种类：守住位置 空值分支；改错故障 摘要行出现种类标签。
//
// 模块职责：为没有专门渲染器的工具提供通用兜底展示。
// 状态所有权：无状态；工具调用与预览设置全部来自渲染上下文。
// 阅读顺序：先看图标与属性接口，再看种类与预览判断，最后看布局属性与失败态。
import { WrenchIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// FALLBACK_TOOL_ICON 用 WrenchIcon 表示没有专门渲染器的工具。
// iconOverride 允许调用方换成更具体的图标，优先于兜底图标。
// 图标 class 取 size-4 shrink-0 text-foreground-subtle，与父布局一致。
const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

// summaryOnly 为真时只渲染一行摘要文案。
// hideRawFallback 供已有专门渲染器时隐藏原始结构。
// 其余字段沿用 ToolCallBlockRenderContext 的通用上下文。
interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

// kindLabel 取 toolCall.kind 首个单词并首字母大写。
// hasInlinePreview 为真时不再展示原始结构。
// onLoadFullToolCallFields 按工具标识回调加载完整字段。
export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreview = displayModel.inlinePreview.type !== "none";
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  // renderContent 依次渲染 ToolCallBody、ToolSnapshotFieldNotice 与原始结构。
  // ToolSnapshotFieldNotice 仅在有加载能力时出现。
  // 原始结构同时受 hasInlinePreview 与 hideRawFallback 控制。
  const renderContent = useCallback(
    () => (
      <>
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
        {!hasInlinePreview && !context.hideRawFallback ? (
          <pre className="px-4 py-3 rounded-xl bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto">
            {JSON.stringify(toolCall, null, 2)}
          </pre>
        ) : null}
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      hasInlinePreview,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : toolCall.title
      }
      renderContent={renderContent}
    />
  );
}
