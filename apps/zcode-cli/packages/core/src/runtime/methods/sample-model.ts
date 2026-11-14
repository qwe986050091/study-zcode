/**
 * ============================================================================
 * runtime/methods/sample-model.ts —— MCP App sampling 的独立模型调用
 * ============================================================================
 * 【定位】链路 10：MCP App 借用 host runtime 的模型能力做一次独立采样；
 *   沿用任务的 factory/admission/认证，但不创建 turn、不写会话消息、不进事件流。
 * 【输入/输出】sampling params（schema 校验）+ 任务模型 selection → 单段文本结果。
 * 【关键不变量】#3/#5：模型由任务固定（页面 hints 不能换账号）；usage 必须落账。
 * ============================================================================
 */
import type { McpAppsSamplingParams, McpAppsSamplingResult } from "@zcode/shared/mcp-apps";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "@zcode/shared/mcp-apps";
import {
  createChildTraceContext,
  runWithModelInvocationContext,
  traceContextToLogContext,
  type ModelInputMessage,
  type SessionEvent,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeModel } from "./runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";

export interface SampleModelInput {
  request: McpAppsSamplingParams;
  source: { pluginId: string; serverName: string; appIdentity: string };
}
const QUERY_SOURCE = "mcp_app_sampling";
/** 独立模型调用，沿用任务的 factory/admission/认证；不创建 turn、不写会话消息或事件。 */
export async function sampleModel(
  this: AgentRuntimeInternal,
  input: SampleModelInput,
  options: { abortSignal: AbortSignal; traceContext?: TraceContext },
): Promise<McpAppsSamplingResult> {
  // MCP App 输入来自外部进程：先按 shared schema 运行时校验，不能只信 TS 类型。
  const params = mcpAppsSamplingParamsSchema.parse(input.request);
  const signal = options.abortSignal;
  // 第一个 await 之前先判取消：已取消的调用不应产生任何模型请求或 durable 副作用。
  signal.throwIfAborted();
  // 在第一个 await 前固定任务模型；页面 hints 不能选择另一账号或修改进行中调用。
  const model = createRuntimeModel(this, { selection: this.getSessionModelSelection() });
  const messages: ModelInputMessage[] = params.messages.map((message) => ({
    role: message.role,
    content: (Array.isArray(message.content) ? message.content : [message.content]).map((block) => {
      if (block.type === "text") {
        // 模型不支持文本输入就整体失败，不静默丢弃内容让 App 误以为采样成功。
        if (!model.properties.inputFormat.supportsText)
          throw new Error("Selected model does not support text input");
        return { type: "text", text: block.text };
      }
      // 图片一律转 dataUrl：MCP App 只给 base64 + mimeType，不落盘也不引用外部 URL。
      if (!model.properties.inputFormat.supportsImage)
        throw new Error("Selected model does not support image input");
      return {
        type: "image",
        mediaType: block.mimeType,
        dataUrl: `data:${block.mimeType};base64,${block.data}`,
      };
    }),
  }));
  // system prompt 由 App 显式提供，unshift 放最前；不能覆盖任务自身的 system 上下文。
  if (params.systemPrompt !== undefined)
    messages.unshift({ role: "system", content: params.systemPrompt });
  const traceContext = createChildTraceContext(options.traceContext ?? this.rootTraceContext, {
    attributes: {
      querySource: QUERY_SOURCE,
      ...input.source,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
    },
  });
  // model_usage 引用当前任务行；空任务也要记账，但不能把 App 提示词写成主聊天或标题。
  await this.ensureSessionPersisted("MCP App sampling", traceContext);
  // 上一个 await 期间可能已被取消；发请求前再确认，避免取消后仍扣 token。
  signal.throwIfAborted();
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof model.generateText>> | undefined;
  let error: unknown;
  // 无论成功/失败/取消，finally 都要落 usage；result/error 先声明到外层供 finally 读取。
  try {
    result = await runWithModelInvocationContext(
      {
        metadata: traceContextToLogContext(traceContext),
        // 标记为 other 会话类型 + statusSink 不持久化：采样状态不能混进主聊天/标题。
        modelRequestSessionType: "other",
        modelCall: { operation: "workspace_generate_text" },
        statusSink: this.createModelStatusSink(traceContext, events, { persist: false }),
        traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: signal,
          model,
          traceContext,
        }),
      },
      () =>
        model.generateText({
          abortSignal: signal,
          messages,
          // 取 App 请求与模型上限的较小值，外部参数不能突破 provider 的硬上限。
          options: {
            maxOutputTokens: Math.min(params.maxTokens, model.optionSpecs.maxOutputTokens.max),
          },
        }),
    );
    signal.throwIfAborted();
    // sampling 只支持纯文本完成：length 可映射成 maxTokens，tool-calls/error/unknown 都不算合法结果。
    if (
      !result.finishReason ||
      result.finishReason === "error" ||
      result.finishReason === "unknown" ||
      result.finishReason === "tool-calls" ||
      this.extractToolCallsFromResult(result).length
    )
      throw new Error("Sampling did not produce a supported completion");
    // 回包也走 schema：host 与 App 跨进程，返回前再校验一次。
    return mcpAppsSamplingResultSchema.parse({
      role: "assistant",
      model: String(model.modelId),
      content: { type: "text", text: result.text },
      stopReason:
        result.finishReason === "length"
          ? "maxTokens"
          : result.finishReason === "stop"
            ? "endTurn"
            : result.finishReason,
    });
  } catch (caught) {
    // 只记录供 finally 归因，然后原样重抛；这里不做降级。
    error = caught;
    throw caught;
  } finally {
    // cancelled/error/completed 三态都要记账，否则用量面板会漏掉采样调用。
    await recordModelUsageFact(this, {
      events,
      model,
      networkEventStartIndex: 0,
      querySource: QUERY_SOURCE,
      result,
      startedAt,
      status: signal.aborted ? "cancelled" : error ? "error" : "completed",
      error,
      traceContext,
    });
  }
}
