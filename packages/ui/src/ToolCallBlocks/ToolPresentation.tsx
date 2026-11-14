// INV-01 无宿主依赖：守住位置 组件体与默认值；改错故障 公开页面构造服务或工作区。
// INV-02 renderer 为共享实现：守住位置 resolveToolCallRenderer；改错故障 独立维护一套卡片。
// INV-03 输出文本规整按能力开启：守住位置 capabilities.normalizeOutputText 判断；改错故障 无能力时也改写输出。
// INV-04 规整结果同步 raw：守住位置 rawOutput 赋值；改错故障 摘要与原始数据不一致。
// INV-05 规整用 memo 缓存：守住位置 useMemo 依赖；改错故障 每次渲染重建节点树。
// INV-06 展示模型纯推导：守住位置 buildToolDisplayModel；改错故障 渲染过程写入业务状态。
// INV-07 工作区固定为空：守住位置 workspacePath: ""；改错故障 公开页面按某路径读文件。
// INV-08 todo 默认隐藏：守住位置 showTodoToolCalls 判断；改错故障 公开页面出现内部待办卡。
// INV-09 子调用递归同参：守住位置 子节点展开 options；改错故障 嵌套层级丢失主题与设置。
// INV-10 子列表按 toolId 作 key：守住位置 key 取值；改错故障 流式追加时卡片错位。
// INV-11 fallback 只读时隐藏原文：守住位置 hideRawFallback；改错故障 只读场景暴露原始载荷。
// INV-12 CUA 组回调按需透传：守住位置 events / renderAssistantMessage / renderReasoning；改错故障 组内消息渲染缺失。
// INV-13 状态词映射统一：守住位置 mapToolStatus 与摘要 id；改错故障 状态标签与图标不一致。
// INV-14 关闭摘要动画：守住位置 disableSummaryContentAnimation；改错故障 公开页面逐帧抖动。
//
// 模块职责：脱离宿主环境的工具卡装配层，复用共享 renderer 并补齐默认上下文。
// 阅读顺序：先看输出规整，再看 render 上下文构造，最后看三类 renderer 分支。
import { useMemo, type ComponentProps } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";

/** 无宿主依赖的工具装配：共享原 renderer；公开页面不构造服务、插件 runtime 或工作区。 */
// 公开渲染入口，全部依赖显式传入。
export function ToolPresentation({
  toolCallNode,
  ...options
}: {
  toolCallNode: TaskChatToolCallTreeNode;
} & Partial<
  Pick<
    ToolCallBlockRenderContext,
    | "theme"
    | "codePreviewSettings"
    | "onOpenBrowserUrl"
    | "authoritativeAgentType"
    | "showTodoToolCalls"
  >
> & {
    cuaGroupEvents?: ComponentProps<typeof CuaGroupToolCallBlock>["events"];
    renderCuaAssistantMessage?: ComponentProps<
      typeof CuaGroupToolCallBlock
    >["renderAssistantMessage"];
    renderCuaReasoning?: ComponentProps<typeof CuaGroupToolCallBlock>["renderReasoning"];
  }) {
  // 文案统一走内联国际化。
  const { intl } = useZCodeIntl();
  // capabilities 由 useToolPresentationCapabilities 注入，缺省返回空能力集而非抛错。
  const capabilities = useToolPresentationCapabilities();
  const { childToolCalls } = toolCallNode;
  // 只有存在规整能力时才改写输出。
  const normalizedNode = useMemo(() => {
    if (!capabilities.normalizeOutputText || typeof toolCallNode.toolCall.output !== "string")
      return toolCallNode;
    const output = capabilities.normalizeOutputText(toolCallNode.toolCall.output);
    const raw = toolCallNode.toolCall.raw as Record<string, unknown> | undefined;
    return {
      ...toolCallNode,
      toolCall: { ...toolCallNode.toolCall, output, raw: { ...raw, rawOutput: output } },
    };
  }, [capabilities.normalizeOutputText, toolCallNode]);
  const { toolCall } = normalizedNode;
  // 协议状态先映射成展示状态。
  const state = mapToolStatus(toolCall.status);
  // 展示模型只依赖工具调用本身。
  const displayModel = useMemo(() => buildToolDisplayModel(toolCall, ""), [toolCall]);
  // 上下文一次构造，供各 renderer 共用。
  const context: ToolCallBlockRenderContext = {
    // CUA 组内的嵌套渲染指回 ToolPresentation 自身，保持与单卡一致的行为。
    nestedToolRenderer: ToolPresentation,
    ...options,
    toolCallNode: normalizedNode,
    // 公开页面没有工作区，固定为空。
    workspacePath: "",
    isOfficeMode: false,
    displayModel,
    viewerSource: displayModel.viewerSource,
    rawFileSummaries: readRawToolCallFileSummaries(toolCall.raw, toolCall),
    isRunning: isCompactToolCallRunningState(state),
    statusLabel: intl.formatMessage({
      id: getCompactToolCallStatusMessageId(state, toolCall.status),
    }),
    errorText: getToolCallErrorText(toolCall),
    disableSummaryContentAnimation: true,
    // 子调用按 toolId 作 key 递归展开。
    childToolList: childToolCalls.length ? (
      <div className="ml-2 space-y-2 border-l border-border pl-3.5">
        {childToolCalls.map((child) => (
          <ToolPresentation key={child.toolCall.toolId} toolCallNode={child} {...options} />
        ))}
      </div>
    ) : null,
  };
  const identity = resolveToolCallIdentity(toolCall);
  // identity.family 为 "todo" 时必须 options.showTodoToolCalls === true 才渲染。
  if (identity.family === "todo" && options.showTodoToolCalls !== true) return null;
  const Renderer = resolveToolCallRenderer(context);
  // 兜底卡按只读能力隐藏原文。
  if (Renderer === FallbackToolCallBlock)
    return <FallbackToolCallBlock {...context} hideRawFallback={capabilities.readonly} />;
  if (Renderer === CuaGroupToolCallBlock)
    return (
      <CuaGroupToolCallBlock
        {...context}
        events={options.cuaGroupEvents}
        renderAssistantMessage={options.renderCuaAssistantMessage}
        renderReasoning={options.renderCuaReasoning}
      />
    );
  // 常规分支统一展开 context，Renderer 由 resolveToolCallRenderer 决定。
  return <Renderer {...context} />;
}
