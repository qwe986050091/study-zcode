// INV-01 摘要请求旁路与会话隔离：守住位置 独立入口函数；改错故障 摘要流进入可见会话。
// INV-02 提交判定按协议来源分流：守住位置 边界类型判断；改错故障 SDK 合成结束被当成提交。
// INV-03 已提交禁止降级重发：守住位置 失败处理早退条件；改错故障 产生两份不同摘要。
// INV-04 取消原样上抛：守住位置 中断识别；改错故障 用户取消后仍再发一次请求。
// INV-05 超窗与媒体错误不降级：守住位置 两类错误识别；改错故障 换传输掩盖真实原因。
// INV-06 建立失败不降级：守住位置 错误码集合与阶段判断；改错故障 配置错误被伪装成网络重试。
// INV-07 仅响应体阶段可重发：守住位置 阶段字段比较；改错故障 请求未成立就重发。
// INV-08 逻辑调用标识贯穿两次传输：守住位置 调用上下文字段；改错故障 用量与日志断链。
// INV-09 重发使用替换原因：守住位置 调用原因常量；改错故障 两次请求无法区分主次。
// INV-10 重发保留归组属性：守住位置 属性展开复制；改错故障 压缩归属信息丢失。
// INV-11 完成态必须存在：守住位置 结束检查；改错故障 空流被当成成功结果。
// INV-12 完整响应双条件判定：守住位置 响应开始与停止原因；改错故障 空事件流返回空摘要。
// INV-13 事件增量累计：守住位置 事件分派分支；改错故障 同一块正文被覆盖。
// INV-14 未识别事件保持兼容：守住位置 分派默认路径；改错故障 新增事件类型直接报错。
// INV-15 provider 边界接管提交：守住位置 协议观察标记；改错故障 归一化结束继续充当证明。
// INV-16 缺失索引的块立即失败：守住位置 空值检查；改错故障 不同块正文被拼接。
// INV-17 块与增量类型对账：守住位置 兼容函数；改错故障 摘要正文错位。
// INV-18 状态容器只由工厂创建：守住位置 状态创建函数；改错故障 多处初始化字段分歧。
//
// 模块职责：压缩摘要的流式请求与未提交时的非流式降级。
// 状态所有权：累计状态只在本次请求内存在，结果返回即丢弃。
// 阅读顺序：先看入口与完成判定，再看事件累计，最后看失败分类与降级重发。
/**
 * ============================================================================
 * runtime/methods/compact-summary-model-request.ts —— 摘要请求的"流式 + 安全降级"
 * ============================================================================
 *
 * 【为什么单独一层】
 * 压缩摘要是旁路请求,它的流内容从不进入会话/UI。因此这里的失败策略与主请求不同:
 *   主请求:已产生可见 delta 后不能静默重放,必须走流恢复/结算;
 *   本请求:只要 provider 还没"提交"任何 content block,就可以整段丢弃、改用非流式
 *           HTTP 重发一次,对用户/历史完全无副作用。
 *
 * 【"提交(commit)"的判定】
 *   - 有 raw message-block provenance 的 provider:只有 provider_content_block_stop
 *     才算提交;normalized end / finish 都不算(它们可能来自 SDK 合成或 clean EOF)。
 *   - 没有该 provenance 的 provider:退回 AI SDK normalized end 推断。
 *   一旦提交,就不再允许降级重发(否则可能拿到两份不同的摘要)。
 *
 * 【失败分类】
 *   取消/上下文超窗/媒体过大/请求建立失败 → 原样抛出,让 compact-active 走各自的
 *   收缩或报错路径;只有"响应体阶段的传输中断"才允许非流式 fallback。
 * ============================================================================
 */
import {
  ModelErrorCode,
  runWithModelInvocationContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  Model,
  ModelInvocationContext,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
  TraceContext,
} from "../deps.js";
import {
  isModelContextExceededError,
  isModelMediaTooLargeError,
  isTurnCancellationError,
  normalizeModelToolCallsForRuntime,
  normalizeStreamError,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";

type CompactSummaryModelRequest = {
  toolSearchEnabled?: boolean;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  messages: Parameters<Model["generateText"]>[0]["messages"];
  modelCall?: ModelInvocationContext["modelCall"];
  metadata?: ModelInvocationContext["metadata"];
  preserveProviderStreamBoundaries?: boolean;
  statusSink?: ModelInvocationContext["statusSink"];
  tools?: Parameters<Model["generateText"]>[0]["tools"];
  traceContext: TraceContext;
  refreshRuntimeHeadersBeforeAttempt?: ModelInvocationContext["refreshRuntimeHeadersBeforeAttempt"];
};

interface CompactSummaryFinish {
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  usage: ModelUsage;
}

interface CompactSummaryStreamState {
  committedText: string;
  committedContentBlock: boolean;
  currentTextBlockId?: string;
  finish?: CompactSummaryFinish;
  pendingTextById: Map<string | undefined, string>;
  providerContentBlockTypes: Map<number, string>;
  providerMessageProtocolObserved: boolean;
  providerResponseStarted: boolean;
  providerStopReasonPresent: boolean;
  sawDelta: boolean;
  toolCallIds: Set<string>;
  toolCalls: ModelToolCall[];
}

interface RunCompactSummaryModelRequestInput {
  logger?: Logger;
  model: Model;
  request: CompactSummaryModelRequest;
}

// 这些错误说明"请求根本没建立起来"(模型选择非法、provider 未配置等)。
// 换第二种 transport 重发也不会变好,只会把真实配置问题掩盖成一次网络重试,
// 所以它们必须原样上抛,由 compact-active 走失败收口。
const COMPACT_SUMMARY_SETUP_ERROR_CODES = new Set<string>([
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelNotFound,
  ModelErrorCode.InvalidModelRequest,
]);

export async function runCompactSummaryModelRequest(
  input: RunCompactSummaryModelRequestInput,
): Promise<RuntimeModelTextResult> {
  // state 先由 createCompactSummaryStreamState 建空，再逐事件累加。
  // streamingLogicalCallId 在发起流式请求前生成，供 fallback 指回同一次尝试。
  // fallback 请求带 previousLogicalCallId 指回它，用量才归属同一次压缩。
  // streamingRequest 只覆盖 modelCall.logicalCallId，其余字段展开透传。
  const state = createCompactSummaryStreamState();
  // logicalCallId 标识"这次逻辑请求":流式失败改走非流式时,fallback 会带
  // previousLogicalCallId 指回它,用量/日志才能把两次 transport 算成同一次压缩尝试。
  const streamingLogicalCallId = crypto.randomUUID();
  const streamingRequest: CompactSummaryModelRequest = {
    ...input.request,
    modelCall: {
      ...input.request.modelCall,
      callCause: input.request.modelCall?.callCause ?? "initial",
      logicalCallId: streamingLogicalCallId,
    },
  };

  try {
    for await (const event of compactModelStream(input, streamingRequest)) {
      applyCompactSummaryStreamEvent(state, event, input);
    }

    if (!state.finish) {
      throw new Error("Compact summary stream ended before finish");
    }
    // 流"结束"不等于"拿到完整响应":SDK 可能为空 SSE 合成 finish(other),
    // 也可能吞掉 message_delta 的真实 stop reason。两个条件同时不满足时才拒绝:
    //   - 观察到了 provider 协议,但从未见到 response start;
    //   - 没有提交任何 content block,且 stop reason 不可信。
    // 拒绝后走 handleCompactSummaryStreamFailure,在未提交时允许非流式重发。
    if (
      (state.providerMessageProtocolObserved && !state.providerResponseStarted) ||
      (!state.committedContentBlock && !hasCompactSummaryStopReason(state))
    ) {
      // AI SDK 会为空 SSE 合成 finish(other)，也会吞掉 message_delta 的真实 stop reason；
      // 只有观察到 response start，且 block stop / truthy stop reason 至少一个成立时才接受该流。
      throw new Error("Compact summary stream ended without a complete provider response");
    }
  } catch (error) {
    return handleCompactSummaryStreamFailure({ ...input, request: streamingRequest }, state, error);
  }

  return compactSummaryStreamResult(state, state.finish);
}

// applyCompactSummaryStreamEvent 只累计最小事实，不做业务决策。
// switch 的 default 分支保持 no-op，兼容 SDK 新增事件。
// 正文块按 event.id 分桶写入 pendingTextById，避免乱序结束互相覆盖。
// 工具调用条目去重后才写入 state，供后续拒绝判定使用。
function applyCompactSummaryStreamEvent(
  state: CompactSummaryStreamState,
  event: ModelStreamEvent,
  input: RunCompactSummaryModelRequestInput,
): void {
  // 流事件只是增量:本层只累计"正文/工具调用/是否已提交",其余事件有意 no-op;
  // 未识别的新事件类型不会报错,保持对 SDK 事件演进的兼容。
  switch (event.type) {
    // 这些事件只宣告"某个块开始",没有可累计内容;提交判定由 end/stop 事件负责。
    case "start":
    case "reasoning_start":
    case "tool_input_start":
      return;

    case "compact_stream_boundary":
      applyCompactProviderBoundary(state, event);
      return;

    case "text_start":
      state.currentTextBlockId = event.id;
      state.pendingTextById.set(event.id, "");
      return;

    case "tool_input_end":
      commitNormalizedContentBlock(state);
      return;

    case "text_delta": {
      state.sawDelta = true;
      const textBlockId = event.id ?? state.currentTextBlockId;
      state.pendingTextById.set(
        textBlockId,
        (state.pendingTextById.get(textBlockId) ?? "") + event.text,
      );
      return;
    }

    case "text_end":
      state.committedText +=
        state.pendingTextById.get(event.id) ?? state.pendingTextById.get(undefined) ?? "";
      state.pendingTextById.delete(event.id);
      state.pendingTextById.delete(undefined);
      // 只有仍是当前块时才清指针:text_end 可能晚于下一个 text_start 到达,
      // 无条件清空会让后续 delta 挂到错误块上。
      if (state.currentTextBlockId === event.id) {
        state.currentTextBlockId = undefined;
      }
      commitNormalizedContentBlock(state);
      return;

    case "reasoning_delta":
      state.sawDelta = true;
      return;

    case "reasoning_end":
      commitNormalizedContentBlock(state);
      return;

    case "tool_input_delta":
      state.sawDelta = true;
      return;

    case "tool_call": {
      // tool call 只负责 deny 所需的 payload 聚合；raw message-block provider
      // 是否已提交由 compact_stream_boundary 决定，不能把 SDK 合成的 tool call 当成 commit。
      commitNormalizedContentBlock(state);
      const [toolCall] =
        normalizeModelToolCallsForRuntime([event.toolCall], {
          logger: input.logger,
          model: modelSelection(input.model),
          source: "compactStreamText",
          traceContext: input.request.traceContext,
        }) ?? [];
      // 空调用(归一化失败)或重复 id 直接忽略:摘要只允许纯文本,
      // 这份聚合仅用于后续拒绝判定,重复会让错误信息出现重复项。
      if (!toolCall || state.toolCallIds.has(toolCall.id)) return;
      state.toolCallIds.add(toolCall.id);
      state.toolCalls.push(toolCall);
      return;
    }

    case "finish":
      // finish 只描述请求结果，不等价于 content_block_stop；clean EOF
      // 会正常返回，但 finish 后若 iterator tail error 且没有 block end，仍允许 HTTP fallback。
      state.finish = {
        finishReason: event.finishReason,
        providerMetadata: event.providerMetadata,
        usage: event.usage,
      };
      return;

    case "error":
      throw event.error;
  }
}

function applyCompactProviderBoundary(
  state: CompactSummaryStreamState,
  event: Extract<ModelStreamEvent, { type: "compact_stream_boundary" }>,
): void {
  if (event.boundary === "inferred_content_block_stop") {
    commitNormalizedContentBlock(state);
    return;
  }

  if (!state.providerMessageProtocolObserved) {
    // raw provenance 一旦出现便接管 commit 判定；normalized end 不能继续充当提交证明。
    state.committedContentBlock = false;
  }
  state.providerMessageProtocolObserved = true;

  switch (event.boundary) {
    case "provider_stop_reason":
      state.providerStopReasonPresent = event.present;
      return;

    case "provider_response_start":
      state.providerResponseStarted = true;
      return;

    case "provider_content_block_start":
      // 缺 index/blockType 的 block_start 无法与后续 delta/stop 对账,
      // 继续聚合会把不同块的内容拼在一起,必须立即失败。
      if (event.index === null || event.blockType === null) {
        throw new Error("Invalid compact provider content block start");
      }
      state.providerContentBlockTypes.set(event.index, event.blockType);
      return;

    case "provider_content_block_delta": {
      const blockType =
        event.index === null ? undefined : state.providerContentBlockTypes.get(event.index);
      if (
        blockType === undefined ||
        !isProviderContentBlockDeltaCompatible(blockType, event.deltaType)
      ) {
        throw new Error("Invalid compact provider content block delta");
      }
      return;
    }

    case "provider_content_block_stop":
      if (
        !state.providerResponseStarted ||
        event.index === null ||
        !state.providerContentBlockTypes.has(event.index)
      ) {
        // content_block_stop 必须先有 message_start 和同 index block start；orphan stop
        // 立即失败；统一 IteratorClose 会释放 provider reader，fallback gate 再按既有 commit 决定能否重放。
        throw new Error("Invalid compact provider content block stop");
      }
      state.committedContentBlock = true;
      return;
  }
}

// handleCompactSummaryStreamFailure 先分类错误，再决定是否允许非流式重发。
// 取消与输入类错误一律原样抛出，不进入降级路径。
// state.committedContentBlock 为真时不再重发，避免二次摘要。
// 降级前调用一次 warn 日志，保留原始错误信息。
async function handleCompactSummaryStreamFailure(
  input: RunCompactSummaryModelRequestInput,
  state: CompactSummaryStreamState,
  error: unknown,
): Promise<RuntimeModelTextResult> {
  if (
    // 这五类都不允许 fallback:
    //   - 取消:用户意图,不能偷偷再发一次请求;
    //   - 上下文超窗/媒体过大:换 non-stream 不会变小,必须交给 compact-active 收缩输入;
    //   - setup 失败:请求本身不成立,换 transport 只会掩盖配置错误;
    //   - 已提交 block:已拿到部分真实摘要,重发可能产生第二份不同内容,
    //     破坏"压缩只发生一次"的语义。
    isTurnCancellationError(error, input.request.abortSignal) ||
    isModelContextExceededError(error) ||
    isModelMediaTooLargeError(error) ||
    isCompactSummarySetupFailure(error) ||
    state.committedContentBlock
  ) {
    throw error;
  }
  const normalizedError = error instanceof Error ? error : normalizeStreamError(error);

  // compact summary 的 stream delta 从未进入 session/UI，在 content block
  // 提交前可以安全丢弃并改走 non-stream；这与普通主请求的可见 streaming 恢复边界不同。
  input.logger?.warn("Compact summary stream failed; falling back to non-streaming", {
    ...traceContextToLogContext(input.request.traceContext),
    errorMessage: normalizedError.message,
    event: "compact.summary.stream_to_non_stream_fallback",
    model: `${input.model.providerId}/${input.model.modelId}`,
    module: "core.runtime",
    observedPartialOutput: state.sawDelta,
  });

  const fallbackRequest = {
    ...input.request,
    modelCall: {
      ...input.request.modelCall,
      // 保留 attributes(compactionOuterAttempt/Trigger 等归组信息),
      // 但换成新的 logicalCallId,并通过 previousLogicalCallId 建立"同一次压缩尝试、
      // 两种 transport"的链路关系。
      attributes: {
        ...input.request.modelCall?.attributes,
      },
      callCause: "fallback_replacement" as const,
      logicalCallId: crypto.randomUUID(),
      previousLogicalCallId: input.request.modelCall?.logicalCallId,
    },
  };
  // 非流式重发没有第二个 transport 兜底:它失败会原样上抛,由 compact-active
  // 决定收缩输入或让 turn 失败;这里不吞错、也不改写错误类型。
  return runWithModelInvocationContext(invocationContext(fallbackRequest), () =>
    input.model.generateText(cleanRequest(fallbackRequest)),
  );
}

function compactModelStream(
  input: RunCompactSummaryModelRequestInput,
  request: CompactSummaryModelRequest,
): AsyncIterable<ModelStreamEvent> {
  return runWithModelInvocationContext(invocationContext(request), () =>
    input.model.streamText(cleanRequest(request)),
  );
}

function cleanRequest(request: CompactSummaryModelRequest) {
  return {
    messages: request.messages,
    tools: request.tools,
    toolSearchEnabled: request.toolSearchEnabled,
    abortSignal: request.abortSignal,
    ...(request.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: request.maxOutputTokens } }
      : {}),
  };
}

function invocationContext(request: CompactSummaryModelRequest) {
  return {
    metadata: request.metadata,
    modelCall: request.modelCall,
    statusSink: request.statusSink,
    traceContext: request.traceContext,
    preserveProviderStreamBoundaries: request.preserveProviderStreamBoundaries,
    refreshRuntimeHeadersBeforeAttempt: request.refreshRuntimeHeadersBeforeAttempt,
  };
}

function isCompactSummarySetupFailure(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const context = asRecord(errorRecord?.context);
  const streamFailurePhase = context?.streamFailurePhase;
  // response_body:响应已经开始返回,属于传输层中断 → 允许 fallback(返回 false)。
  if (streamFailurePhase === "response_body") {
    return false;
  }

  if (streamFailurePhase === "request_setup") {

    // 其他同步 setup 或明确 HTTP 拒绝属于原请求错误，不能用第二种 transport 掩盖。
    // 404 是特例:流式端点不存在时,非流式端点可能仍可用 → 允许 fallback。
    // 其他 setup 失败或明确 HTTP 拒绝(4xx/5xx)都是原请求错误,
    // 用第二种 transport 重发只会掩盖真实原因。
    return context?.httpResponseStatus !== 404;
  }

  // 没有 phase 信息时按错误码兜底:配置/模型选择类错误视为 setup 失败。
  return (
    typeof errorRecord?.code === "string" && COMPACT_SUMMARY_SETUP_ERROR_CODES.has(errorRecord.code)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSummaryStreamResult(
  state: CompactSummaryStreamState,
  finish: CompactSummaryFinish,
): RuntimeModelTextResult {
  return {
    finishReason: finish.finishReason,
    providerMetadata: finish.providerMetadata,
    text: state.committedText,
    toolCalls: state.toolCalls.length > 0 ? state.toolCalls : undefined,
    usage: finish.usage,
  };
}

function modelSelection(model: Model) {
  return { providerId: model.providerId, modelId: model.modelId };
}

// 归一化结束只在未观察 provider 协议时才算提交。
// providerMessageProtocolObserved 一旦为真就永久接管提交判定。
// 本函数只写 state.committedContentBlock，不读取其他状态。
// state.committedContentBlock 是降级闸门判断的唯一依据。
function commitNormalizedContentBlock(state: CompactSummaryStreamState): void {
  // 无 raw message-block provenance 的 provider 继续使用 AI SDK normalized end 推断；
  // 一旦观察到该 provenance，只有 provider content_block_stop 可以固化 commit。
  if (!state.providerMessageProtocolObserved) {
    state.committedContentBlock = true;
  }
}

function hasCompactSummaryStopReason(state: CompactSummaryStreamState): boolean {
  // 有 provider 协议时只认 message_delta 里的真实 stop reason;
  // SDK normalized 的 finishReason 可能是合成的,不能据此判定"完整响应"。
  if (state.providerMessageProtocolObserved) {
    return state.providerStopReasonPresent;
  }
  // 回退路径:先看 providerMetadata.rawFinishReason(更原始),
  // 再看 normalized finishReason,但排除 "other" —— 那是 SDK 对未知/缺失原因的占位。
  const rawFinishReason = state.finish?.providerMetadata?.rawFinishReason;
  if (typeof rawFinishReason === "string" && rawFinishReason.trim().length > 0) {
    return true;
  }
  const finishReason = state.finish?.finishReason.trim().toLowerCase();
  return finishReason !== undefined && finishReason.length > 0 && finishReason !== "other";
}

function isProviderContentBlockDeltaCompatible(
  blockType: string,
  deltaType: string | null,
): boolean {
  // 对账 provider 的 block 类型与 delta 类型:不匹配说明流事件错位
  // (例如 text delta 落在 tool_use block),继续聚合会把摘要拼错,必须立即失败。
  switch (deltaType) {
    case "text_delta":
      return blockType === "text";
    case "input_json_delta":
      return blockType === "tool_use" || blockType === "server_tool_use";
    case "signature_delta":
      return blockType === "thinking";
    case "thinking_delta":
      return blockType === "thinking" || blockType === "redacted_thinking";
    case "citations_delta":
    default:
      // citations 及未知/未来 delta 只要求 block 已存在，不参与正文聚合。
      return true;
  }
}

function createCompactSummaryStreamState(): CompactSummaryStreamState {
  return {
    committedText: "",
    committedContentBlock: false,
    pendingTextById: new Map(),
    providerContentBlockTypes: new Map(),
    providerMessageProtocolObserved: false,
    providerResponseStarted: false,
    providerStopReasonPresent: false,
    sawDelta: false,
    toolCallIds: new Set(),
    toolCalls: [],
  };
}
