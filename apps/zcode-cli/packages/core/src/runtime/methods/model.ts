/**
 * ============================================================================
 * model.ts —— Agent 主流程的"模型请求"层(一次 provider 往返的真实实现)
 * ============================================================================
 *
 * 【调用链】
 *   turn-model-step.ts runModelBackedTurnStepImpl
 *     └─ runModelTextRequest(本文件)
 *          ├─ 消息投影:附件路径化 → 能力投影(按 inputFormat)→ 媒体预算裁剪
 *          ├─ 组装调用上下文:modelCall 语义、statusSink、请求前刷新鉴权头
 *          ├─ 非流式:model.generateText 一次返回
 *          └─ 流式:model.streamText 逐事件消费并聚合结果
 *
 * 【职责边界】
 *   本文件只负责"把请求发出去并把响应收回来",不做业务决策:
 *   - 输出被截断(output-limit)→ 只标记 finishReason,是否续写由上层决定;
 *   - 上下文超窗(context overflow)→ 只记日志、保留原始结果,让上层触发 reactive compact;
 *   - 可疑空响应 → 记录诊断并在必要时抛错,避免被上层误判为普通空结果;
 *   - 工具调用只做归一化/去重与流式转发,不在这里执行工具。
 * ============================================================================
 */
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { ModelReasoningContentBlock, ModelToolCall, ModelUsage, ToolCallId } from "../deps.js";
import {
  buildSuspiciousEmptyDiagnostics,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  logModelRequestMediaSummary,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  normalizeStreamError,
  normalizeModelToolCallsForRuntime,
  projectMessagesWithMediaAttachmentPaths,
  projectMessagesForInputFormat,
  projectMessagesForMediaBudget,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";
import { getOrCreateReasoningBlock } from "./reasoning-stream.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

/**
 * 发送一次模型请求并返回聚合结果(流式时同时把增量事件推给 UI)。
 *
 * 调用方是 turn-model-step.ts;它已经决定了 maxOutputTokens、工具集与恢复状态,
 * 这里不再做预算计算,只负责:
 *   1) 投影消息(媒体路径/能力/预算);
 *   2) 组装 modelCall 元数据与 statusSink;
 *   3) 调用 provider(流式或非流式);
 *   4) 归一化 tool call,做结束语义诊断,返回 RuntimeModelTextResult。
 *
 * @param options.messages         provider 实际请求消息(已由上层剔除 query-local 提示)
 * @param options.tools            本次暴露的工具合同
 * @param options.maxOutputTokens  上层计算好的输出预算(不做二次裁剪)
 * @param options.onStreamTextDelta/onStreamReasoningDelta/onStreamToolCall
 *                                 流式增量回调(供 streaming tool 协调器提前执行只读工具)
 * @param options.streamRecovery   上一次失败保留下来的重试状态(次数/丢弃内容)
 */
export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  // 闲时 turn 只覆盖了父 runtime 的默认模型，foreground child 重新建
  // request 时仍读取 session 配置，导致 provider options/capability 与本轮模型分叉。
  // turn 快照存在时必须整体采用快照，不能用 `??` 回退到用户模型的字段。
  // 媒体投影三连:路径化 → 能力 → 预算。
  // 1) 路径化:把消息里的媒体附件替换为 provider 可读取的路径/引用;
  // 2) 能力投影:按模型 inputFormat 把不支持的媒体换成占位文本;
  // 3) 预算投影:对整段请求的媒体按 token 预算裁剪,避免单条/总量超限。
  // 失败处理:projectMessagesWithMediaAttachmentPaths 失败会抛出(artifactStore 不可用),
  // 此时整条请求无法构造,直接抛错由 turn catch 收口;不做降级(降级会丢失媒体语义)。
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  // 模型调用上下文:不是请求内容,而是"如何记录/如何恢复"的元数据。
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    // 会话类型、重试预算与准入端口由 createRuntimeModel 绑在句柄上
    // turn step 与工具内部的模型调用同一来源。
    modelCall: {
      // 普通 Agent Step 以前只靠 metadata.querySource 在 Adapter 中反推
      // operation/actor；元数据一旦改名或缺失，就会误记为 tool_internal_model_call。
      // Runtime 已经拥有原始执行语义，应在请求边界直接声明，旧映射只作兼容兜底。
      actorKind: this.agentTelemetry.actorKind,
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      // 恢复请求要显式标记 cause,用量/费用统计才能把它与首次请求区分开。
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    // statusSink 把模型网络/重试状态转成 SessionEvent(UI 可展示"重试中/等待首 token"),
    // streamRecovery 同时透传,便于 UI 显示第几次恢复。
    statusSink: this.createModelStatusSink(projectedOptions.traceContext, projectedOptions.events, {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    }),
    traceContext: projectedOptions.traceContext,
    // 长时间运行/重试可能让鉴权凭据过期:每次底层 attempt 前都刷新运行时请求头。
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: projectedOptions.abortSignal,
      model,
      traceContext: projectedOptions.traceContext,
    }),
    // SSE 已经输出后由 core recovery 重发新请求；这些请求在 adapter 看起来都是 attempt=1，
    // 必须把 recovery 次数带过去，才能把 idle timeout 从首请求窗口逐次递增。
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  // 真正发给 provider 的请求体:消息、工具、ToolSearch 原生开关、取消信号、输出预算。
  // 注意这里不带任何 UI/记录专用字段,保证 provider 边界干净。
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    toolSearchEnabled: projectedOptions.toolSearchEnabled,
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  // 上下文占用快照/明细:用于 UI 的 context meter 与超窗诊断,
  // 不影响请求本身(计算发生在投影之后,基于同一份 provider 可见消息)。
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);

  // 非流式分支:模型配置关闭流式时一次性生成,再归一化 tool call。
  // 该分支同样返回 contextUsageBreakdown,保持与流式分支的返回值一致。
  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      model.generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  // 流式聚合器:最终结果由下面这些可变状态拼装而成。
  // text/finishReason/usage/providerMetadata 来自 finish 事件,reasoning/toolCalls 按事件增量累积。
  let text = "";
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  const reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  // onStreamSnapshot 供上层在流式期间拿到"目前为止"的文本/推理快照(用于 UI 或取消时持久化)。
  const publishStreamSnapshot = () => options.onStreamSnapshot?.({ reasoning, text });
  // SessionEvent 写入可能很慢(落库/网络):用队列统一排队,避免阻塞 provider 流的消费。
  // enqueue 后视情况 backpressure;finish/error 等关键事件会 drain 到落盘完成。
  const streamingEventQueue = createModelStreamingEventQueue({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const enqueueStreamingEvent = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.maybeApplyBackpressure();
  };
  const enqueueStreamingEventAndDrain = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.drain();
  };
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    this.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(options.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await enqueueStreamingEvent({
      assistantMessageId: options.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      // 实验原因：Write/Edit 的行数体验依赖 content 换行尽快到 UI。
      // 这里遇到真实/JSON 转义换行就 flush，同时保留超长单行兜底，
      // 避免没有换行的参数一直缓冲到 tool_input_end。
      await flushToolInputDelta(toolCallId);
    }
  };

  // 发起流式请求:model.streamText 返回异步事件流。
  // runWithModelInvocationContext 负责把 modelCall/statusSink 等上下文绑定到本次调用。
  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    model.streamText(modelRequest),
  );
  finishAssembly();
  // 逐事件消费 provider 流。每种事件做两件事:
  //   a) 更新本地聚合器(text/reasoning/toolCalls/finish/usage);
  //   b) 把该增量排进 streamingEventQueue,供 UI 实时展示(工具事件会 drain 以保顺序)。
  // 注意:tool_call 只做归一化/去重,并回调 onStreamToolCall,不在这里执行工具。
  try {
    for await (const event of modelStream) {
      switch (event.type) {
        case "start": {
          // 流的生命周期起点:只发一个空的 start 事件给 UI(不做内容累积)。
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "start",
          });
          break;
        }

        case "text_start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_start",
          });
          break;
        }

        case "text_delta": {
          // 正文增量:同时做四件事 —— 累积到 text、回调上层(工具协调器统计丢弃量)、
          // 发布快照(取消时持久化 partial)、排队成 SessionEvent 给 UI。
          text += event.text;
          options.onStreamTextDelta?.(event.text);
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "text_delta",
          });
          break;
        }

        case "text_end": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_end",
          });
          break;
        }

        case "reasoning_start": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          if (event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_start",
          });
          break;
        }

        case "reasoning_delta": {
          // 推理增量:按 event.id 归入对应 reasoning block(同一 block 可能分多次到达),
          // 同时保留 providerMetadata(部分 provider 把摘要/签名放在这里)。
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
          });
          block.text += event.text;
          options.onStreamReasoningDelta?.(event.text);
          if (event.providerMetadata) block.providerOptions = event.providerMetadata;
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "reasoning_delta",
          });
          break;
        }

        case "reasoning_end": {
          const block = reasoningById.get(event.id);
          if (block && event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          reasoningById.delete(event.id);
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_end",
          });
          break;
        }

        // 原始参数流保留包装结构；目标身份由公共准入产生，再通过工具事件交给展示投影。
        // 不从参数 delta 推测执行目标，也不为展示身份调整模型流或工具调度时序。
        case "tool_input_start": {
          const toolCallId = event.id as ToolCallId;
          toolInputDeltaBuffers.delete(toolCallId);
          this.logger?.debug("Model streaming tool input started", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_start",
            module: "core.runtime",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_start",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          break;
        }

        case "tool_input_delta": {
          // 工具参数是流式 JSON 片段:这里只做缓冲,遇到换行或超长单行再 flush,
          // 避免把参数内容一次性全压到 tool_input_end 才展示。
          await appendToolInputDelta(event.id as ToolCallId, event.delta);
          break;
        }

        case "tool_input_end": {
          await flushToolInputDelta(event.id as ToolCallId);
          this.logger?.debug("Model streaming tool input ended", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_end",
            module: "core.runtime",
            toolCallId: event.id,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_end",
            toolCallId: event.id as ToolCallId,
          });
          break;
        }

        case "tool_call": {
          // 完整的 tool call 到达:归一化(兼容不同 provider 的参数格式)、按 id 去重,
          // 然后回调 onStreamToolCall,让协调器决定是否提前执行。
          const [toolCall] =
            normalizeModelToolCallsForRuntime([event.toolCall], {
              logger: this.logger,
              model: executionModelSelection,
              source: "streamText",
              traceContext: options.traceContext,
            }) ?? [];
          if (!toolCall) {
            break;
          }
          await flushToolInputDelta(toolCall.id as ToolCallId);
          if (toolCallIds.has(toolCall.id)) {
            // 防御原因：协议兼容或自定义 adapter 路径可能重复投递同 id 的 final tool_call；
            // runtime 按 id 去重，避免同一次响应内重复执行。
            // 维护不变量#1:每个 tool_call 只执行一次;重复 id 必须丢弃,否则会产生重复的 ToolPart。
            break;
          }
          toolCallIds.add(toolCall.id);
          toolCalls.push(toolCall);
          this.logger?.debug("Model streaming tool call completed", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_call",
            inputKeys:
              typeof toolCall.input === "object" &&
              toolCall.input !== null &&
              !Array.isArray(toolCall.input)
                ? Object.keys(toolCall.input as Record<string, unknown>)
                : [],
            module: "core.runtime",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            input: toolCall.input,
            kind: "tool_call",
            toolCallId: toolCall.id as ToolCallId,
            toolName: toolCall.name,
          });
          options.onStreamToolCall?.(toolCall);
          break;
        }

        case "finish": {
          // 流结束:捕获 finishReason/usage/providerMetadata(后续结束语义判断全靠它们),
          // 先 flush 所有工具参数缓冲,再发一个 done=true 的 finish 事件并 drain 落库。
          finishReason = event.finishReason;
          usage = event.usage;
          providerMetadata = event.providerMetadata;
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "finish",
          });
          break;
        }

        case "error": {
          // provider 在流中报错:先 flush 已缓冲的工具参数,发一个 done=true 的 error 事件,
          // 再把错误归一化后抛出(normalizeStreamError 会保留 providerCode 等业务字段)。
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "error",
          });
          // AI SDK 的 error chunk 常是 ProviderBusinessError 的 plain object（如 3007），
          // 若只做 JSON.stringify 会丢失 providerCode，UI 只能看到泛化的 stream 失败文案。
          // 失败处理:normalizeStreamError 把 plain object 还原为带 providerCode/code 的 Error,
          // 抛出后由 turn-model-step 的恢复链判断是否可重试(不吞错)。
          throw normalizeStreamError(event.error);
        }
      }
    }
  } catch (error) {
    await streamingEventQueue.drain();
    throw error;
  }
  await streamingEventQueue.drain();

  // 流结束后的"结束语义"判定。这里只识别与记录,不决定后续动作:
  //   outputTokenLimit → 上层可能追加续写;
  //   contextExceeded  → 上层可能触发 reactive compact;
  //   suspiciousEmpty  → 明显的异常空响应,这里直接抛错。
  const rawFinishReason = readRawFinishReason(providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(finishReason, rawFinishReason);
  const contextExceeded =
    toolCalls.length === 0 &&
    !outputTokenLimit &&
    isContextExceededFinishReason(finishReason, rawFinishReason);
  if (contextExceeded) {
    // 这里若把 HTTP 200 + finish metadata 提前抛成流异常，会先被通用断流恢复接管，
    // 从而绕过 turn 层的 Reactive Compact。保留原始结果，由 turn 层统一处理超窗语义。
    // 维护不变量#2:上下文超窗不是"流中断",不能走 stream recovery 重放;
    // 必须由 turn 层 reactive compact 裁剪历史后再请求,否则会无限重放同一超窗请求。
    this.logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
      textLength: text.length,
      toolCallCount: toolCalls.length,
    });
  }

  // 流在只发出 start/prelude 后以 finishReason=unknown 结束时，会被记到 turn-model-step
  // 的 suspicious empty。这里在返回 result 前再扫一遍 providerMetadata/空 completion。
  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(finishReason, text.length, toolCalls.length, usage)
  ) {
    // zcode-plan 常返回 HTTP 200 空 SSE，需在抛错前打出 finish/providerMetadata 摘要，避免只能看到 UI 泛化文案。
    this.logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      textLength: text.length,
      toolCallCount: toolCalls.length,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason,
        providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason,
      model: executionModelSelection,
      providerMetadata,
      rawFinishReason,
    });
  }

  // 返回聚合结果:toolCalls/reasoning 为空时用 undefined,避免调用方误以为存在空数组;
  // contextUsageBreakdown 仅在非空时携带,保持事件 payload 精简。
  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason,
    providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}
