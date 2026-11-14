/**
 * ============================================================================
 * streaming-recovery.ts —— 模型流中断后的"安全锚点恢复"
 * ============================================================================
 *
 * 【为什么需要 core recovery】
 *   adapter 层只会在"请求未产生任何输出"时重试;一旦 SSE 已经吐出文本/推理,
 *   再重试会重复内容。core 的做法是:
 *     1) 从最后一个"已提交锚点"重开流(已提交工具结果 或 上一条消息);
 *     2) 丢弃锚点之后未提交的 assistant tail(并记录丢弃字节数,供 UI 解释);
 *     3) 用新的请求继续,且把恢复次数透传给 adapter(idle timeout 逐次递增)。
 *
 * 【两种恢复对象】
 *   - 已接受工具(acceptedToolCalls>0):先结算工具(见 streaming-tool-coordinator),
 *     锚点取最后一个已提交工具结果;
 *   - 无工具:仅丢弃未提交文本/推理,锚点取上一条消息。
 *
 * 【Start Plan 繁忙】
 *   特定 provider(3008/3009/3010)在首 token前会因 admission 繁忙失败。
 *   这里提供独立的短重试(1s/2s)与"耗尽后的明确错误",避免被通用流恢复吞掉。
 * ============================================================================
 */
import {
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId, Model, ToolCallId, TraceContext } from "../deps.js";
import { createStreamRecoveryAnchorId, createStreamingToolAttemptId } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";

// 越过 adapter 重试边界后，SSE stall 只能靠 core recovery 从安全锚点重开流；
// 只恢复 1 次会让连续短暂抖动直接失败，和模型默认 10 次 retry 的用户预期差距过大。
const STREAM_RECOVERY_MAX_RETRIES = 10;
// 无工具可恢复时使用的"上一条消息"锚点后缀;与工具锚点(assistantId:toolCallId)区分。
const PREVIOUS_MESSAGE_ANCHOR_SUFFIX = "previous-message-anchor";
// Start Plan 的"admission 繁忙"业务码:命中时走独立的短重试,而不是普通流恢复。
const START_PLAN_BUSY_PROVIDER_CODES = new Set(["3008", "3009", "3010"]);
// 只有这两个 provider 才应用 Start Plan 短重试;其它 provider 的同类错误仍走通用恢复。
const START_PLAN_BUSY_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);
// 两次短重试的等待时间;索引即"当前已尝试次数"(0 → 1s,1 → 2s,越界则不再重试)。
const START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS = [1_000, 2_000] as const;
export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";
// 可重试的瞬时错误码/原因:只要错误链(含 cause)里出现任意一项,就视为"值得重开流",
// 而不是让整轮直接失败。注意这是错误码集合,不是错误消息匹配。
const TRANSIENT_ERROR_CODES = new Set([
  "model_request_timeout",
  "model_rate_limited",
  "model_server_error",
  "model_network_error",
  "MODEL_REQUEST_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVER_ERROR",
  "MODEL_NETWORK_ERROR",
]);
const TRANSIENT_ERROR_REASONS = new Set([
  "stream_idle_timeout",
  "rate_limited",
  "server_error",
  "network_error",
  "timeout",
]);

/**
 * 一次恢复尝试的进度描述:retryNumber 从 1 开始,maxRetries 是本次预算上限。
 * 该对象会进入事件 payload 与下一次请求的 streamRecovery 元数据。
 */
interface StreamRecoveryAttempt {
  maxRetries: number;
  retryNumber: number;
}

/** 是否还有流恢复预算(上限 10 次,覆盖连续短暂抖动)。 */
export function hasStreamRecoveryBudget(state: RegularTurnLoopState): boolean {
  return state.streamRecoveryRetryCount < STREAM_RECOVERY_MAX_RETRIES;
}

/**
 * 判断错误链中是否存在 Start Plan 繁忙码(3008/3009/3010)。
 * walkErrorRecords 会沿 cause 向下遍历(最多 6 层,防环),因为业务码可能被包装在多层里。
 */
export function isStartPlanBusyStreamRecoveryFailure(error: unknown): boolean {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const providerCode =
      stringValue(record.providerCode) ??
      stringValue(context?.providerCode) ??
      stringValue(record.code) ??
      stringValue(context?.code);
    if (providerCode && START_PLAN_BUSY_PROVIDER_CODES.has(providerCode)) {
      return true;
    }
  }
  return false;
}

/**
 * 把 Start Plan 繁忙导致的恢复耗尽转换成可操作的明确错误:
 * 保留原始 providerCode,标记 retryable=false,并带 startPlanBusyAutoRetryExhausted,
 * 让 UI 能展示"自动重试达到最大次数",而不是普通限流文案。
 */
export function createStartPlanBusyAutoRetryExhaustedError(error: unknown): Error {
  const providerCode = findStartPlanBusyProviderCode(error) ?? "3010";
  const exhaustedError = new Error(START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE, {
    cause: error instanceof Error ? error : undefined,
  }) as Error & {
    code?: string;
    context?: Record<string, unknown>;
  };
  exhaustedError.name = "StartPlanBusyAutoRetryExhaustedError";
  exhaustedError.code = "model_rate_limited";
  exhaustedError.context = {
    providerCode,
    reason: "rate_limited",
    retryable: false,
    startPlanBusyAutoRetryExhausted: true,
  };
  return exhaustedError;
}

/** 开始一次通用流恢复:累加计数并返回本次 attempt 的 retryNumber/maxRetries。 */
export function beginStreamRecoveryAttempt(state: RegularTurnLoopState): StreamRecoveryAttempt {
  state.streamRecoveryRetryCount += 1;
  return {
    retryNumber: state.streamRecoveryRetryCount,
    maxRetries: STREAM_RECOVERY_MAX_RETRIES,
  };
}

/** 开始一次 Start Plan admission 繁忙短重试(与通用流恢复共享计数,但预算更小)。 */
export function beginStartPlanBusyAdmissionRetryAttempt(
  state: RegularTurnLoopState,
): StreamRecoveryAttempt {
  state.streamRecoveryRetryCount += 1;
  return {
    retryNumber: state.streamRecoveryRetryCount,
    maxRetries: START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS.length,
  };
}

/**
 * 计算本次 Start Plan 繁忙重试的等待时间。
 * 返回 undefined 的三种情况:非首轮 turnNumber<=0、非指定 provider、非繁忙错误;
 * 另外当 streamRecoveryRetryCount 越过 delays 数组长度时也返回 undefined(交给通用恢复/最终失败)。
 */
export function getStartPlanBusyAdmissionRetryDelayMs(input: {
  error: unknown;
  providerId: string;
  state: RegularTurnLoopState;
  turnNumber: number;
}): number | undefined {
  if (input.turnNumber <= 0) return undefined;
  if (!START_PLAN_BUSY_RETRY_PROVIDER_IDS.has(input.providerId)) return undefined;
  if (!isStartPlanBusyStreamRecoveryFailure(input.error)) return undefined;
  return START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS[input.state.streamRecoveryRetryCount];
}

/** 发 StreamRecoveryStarted 事件(UI 显示"正在恢复流"),携带失败类型与重试进度。 */
export async function emitStreamRecoveryStarted(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { assistantMessageId: MessageId; failedRequestId?: string; traceContext: TraceContext },
  error: unknown,
  recoveryAttempt: StreamRecoveryAttempt,
): Promise<void> {
  const payload = {
    // attemptId 与 anchorId 标识同一次恢复尝试;assistantMessageId 用于挂回消息;
    // failureKind 是粗分类(timeout/network/stream),message 保留原始文案供排查;
    // failedRequestId 指向真正失败的 provider 请求,便于 UI 对上"从 A 恢复到 B"。
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    assistantMessageId: options.assistantMessageId,
    failureKind: classifyStreamRecoveryFailure(error),
    message: error instanceof Error ? error.message : String(error),
    retryNumber: recoveryAttempt.retryNumber,
    maxRetries: recoveryAttempt.maxRetries,
    ...(options.failedRequestId ? { failedRequestId: options.failedRequestId } : {}),
  };
  const event = runtime.createEvent(
    SessionEventType.StreamRecoveryStarted,
    payload,
    options.traceContext,
  );
  await runtime.appendEvent(event, options.traceContext);
  state.events.push(event);
}

/**
 * 发恢复三连事件(锚点选择 → 丢弃尾部 → 重试开始),并把恢复请求写进
 * state.pendingStreamRecoveryRequest,让下一次 model_request_started 能标明
 * "这是由哪个失败请求恢复出来的"。三个事件共用 attemptId/anchorId,UI 可对齐。
 */
export async function emitStreamRecoveryRetryEvents(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { assistantMessageId: MessageId; failedRequestId?: string; traceContext: TraceContext },
  recovery: StreamRecoveryAttempt & {
    discardedReasoningBytes: number;
    discardedTextBytes: number;
    reason: "latest_committed_tool_result" | "no_tool_committed";
    toolCallIds: ToolCallId[];
  },
): Promise<void> {
  const latestToolCallId = recovery.toolCallIds.at(-1);
  // 锚点选择:有已提交工具结果 → 用最后一个工具结果 anchor;
  // 没有 → 用"上一条消息" anchor(意味着整段未提交 assistant tail 都要丢弃)。
  const anchorId = latestToolCallId
    ? createStreamRecoveryAnchorId(options.assistantMessageId, latestToolCallId)
    : createPreviousMessageRecoveryAnchorId(options.assistantMessageId);
  // 三个事件共同描述"从哪恢复、丢了什么、第几次重试":
  //   AnchorSelected   选了哪个锚点、原因(有工具/无工具);
  //   TailDiscarded    丢弃了多少推理/文本字节(UI 可解释内容去哪了);
  //   RetryStarted     真正发起恢复请求,携带 streamMode=sse 与重试进度。
  const recoveryEvents = [
    runtime.createEvent(
      SessionEventType.StreamRecoveryAnchorSelected,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        reason: recovery.reason,
        committedToolCallIds: recovery.toolCallIds,
      },
      options.traceContext,
    ),
    runtime.createEvent(
      SessionEventType.StreamRecoveryTailDiscarded,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        assistantMessageId: options.assistantMessageId,
        discardedReasoningBytes: recovery.discardedReasoningBytes,
        discardedTextBytes: recovery.discardedTextBytes,
        discardedToolCallIds: [],
      },
      options.traceContext,
    ),
    runtime.createEvent(
      SessionEventType.StreamRecoveryRetryStarted,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        retryNumber: recovery.retryNumber,
        maxRetries: recovery.maxRetries,
        streamMode: "sse",
        ...(options.failedRequestId ? { failedRequestId: options.failedRequestId } : {}),
      },
      options.traceContext,
    ),
  ];
  for (const event of recoveryEvents) {
    await runtime.appendEvent(event, options.traceContext);
    state.events.push(event);
  }
  // SSE 已经吐出部分事件后，下一次请求是 core recovery 重新发起的
  // 新模型请求，不会表现为 adapter attempt=2；必须把来源 requestId 显式挂到
  // 下一次 model_request_started 上，用户才能确认旧请求 A 超时后确实发出了恢复请求 B。
  state.pendingStreamRecoveryRequest = {
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    anchorId,
    maxRetries: recovery.maxRetries,
    retryNumber: recovery.retryNumber,
    ...(options.failedRequestId ? { recoveredFromRequestId: options.failedRequestId } : {}),
  };
}

/**
 * "无已接受工具"时的 partial 输出恢复:
 *   只有产生了可丢弃的文本/推理、且错误可重试时才恢复;
 *   流程:中止旧流 → 记 recovery 事件 → 把旧 assistant 标为 discarded →
 *        重置响应/推进 model step → 发重试事件,返回 true 让调用方继续循环。
 * 返回 false 表示不满足恢复条件,调用方应走最终失败路径。
 */
export async function recoverPartialAssistantOutputFailure(input: {
  abortController: AbortController;
  assistantCreatedAt: number;
  discardedReasoningBytes: number;
  discardedTextBytes: number;
  error: unknown;
  options: {
    assistantMessageId: MessageId;
    failedRequestId?: string;
    model: Model;
    traceContext: TraceContext;
  };
  runtime: AgentRuntimeInternal;
  state: RegularTurnLoopState;
  turnAbortListener: () => void;
}): Promise<boolean> {
  if (
    input.discardedReasoningBytes + input.discardedTextBytes <= 0 ||
    !isRetryableStreamRecoveryFailure(input.error)
  ) {
    // 没有产生任何可丢弃内容 = 请求还没真正开始输出,交给 adapter/turn 的既有失败路径;
    // 错误不可重试(配置/权限/业务拒绝)= 重开流只会重复失败,直接返回 false。
    return false;
  }

  // reasoning_delta 为了实时展示会越过 adapter 重试边界，但旧 Core 只统计正文，
  // 导致正文前的 thinking 断流直接失败。无工具时正文和思考都属于未提交 assistant tail，
  // 必须统一从前一个 provider-safe anchor 重开，不能把新输出接到失败消息上。
  input.abortController.abort();
  const recoveryAttempt = beginStreamRecoveryAttempt(input.state);
  // 先发"开始恢复"事件,再持久化 discarded 标记:顺序保证 UI 先看到恢复,而不是先看到错误消息。
  await emitStreamRecoveryStarted(
    input.runtime,
    input.state,
    input.options,
    input.error,
    recoveryAttempt,
  );
  // 把旧 assistant 标为 discarded(带 STREAM_RECOVERY_DISCARDED_ERROR_NAME):
  // 这条消息不会被重放,新请求从上一条安全锚点重开。
  // 维护不变量#2:只有未提交的 assistant tail 才允许丢弃重试;已提交的工具结果/消息
  // 不会被 touched,恢复锚点取"上一条已提交消息"而非当前失败消息。
  await input.runtime.persistAssistantMessage(
    input.options.assistantMessageId,
    input.state.currentUserMessageId,
    input.assistantCreatedAt,
    {
      completed: Date.now(),
      error: {
        name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
        data: {
          message: "Partial assistant output was discarded before a streaming retry.",
          retryNumber: recoveryAttempt.retryNumber,
        },
      },
      finish: STREAM_RECOVERY_DISCARDED_FINISH,
    },
    input.options.traceContext,
    input.options.model,
  );
  input.state.modelResponse = "";
  input.state.modelStepCount += 1;
  recordModelHistoryRound(input.state);
  // 状态机:这次 assistant 已经被作废,必须回填"空响应"并聚合,避免旧 partial 继续参与后续状态。
  input.state.turnMachine = new TurnMachineImpl(input.state.turnMachine.receiveModelResponse(""));
  input.state.turnMachine = new TurnMachineImpl(input.state.turnMachine.aggregateResults());
  // 发"从哪恢复/丢了什么/第几次"三连事件,并写入 pendingStreamRecoveryRequest,
  // 让下一次请求能标记 recoveredFromRequestId。
  await emitStreamRecoveryRetryEvents(input.runtime, input.state, input.options, {
    ...recoveryAttempt,
    discardedReasoningBytes: input.discardedReasoningBytes,
    discardedTextBytes: input.discardedTextBytes,
    reason: "no_tool_committed",
    toolCallIds: [],
  });
  input.state.turnAbortSignal.removeEventListener("abort", input.turnAbortListener);
  return true;
}

function createPreviousMessageRecoveryAnchorId(assistantMessageId: MessageId): string {
  return `${assistantMessageId}:${PREVIOUS_MESSAGE_ANCHOR_SUFFIX}`;
}

function findStartPlanBusyProviderCode(error: unknown): string | undefined {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const candidates = [
      stringValue(record.providerCode),
      stringValue(context?.providerCode),
      stringValue(record.code),
      stringValue(context?.code),
    ].filter((code): code is string => code !== undefined);
    const providerCode = candidates.find((code) => START_PLAN_BUSY_PROVIDER_CODES.has(code));
    if (providerCode) {
      return providerCode;
    }
  }
  return undefined;
}

function isRetryableStreamRecoveryFailure(error: unknown): boolean {
  for (const record of walkErrorRecords(error)) {
    if (record.retryable === true) return true;
    const context = asRecord(record.context);
    if (context?.retryable === true) return true;
    const code = stringValue(record.code) ?? stringValue(context?.code);
    if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
    const reason = stringValue(record.reason) ?? stringValue(context?.reason);
    if (reason && TRANSIENT_ERROR_REASONS.has(reason)) return true;
    const name = stringValue(record.name);
    if (name === "ModelStreamIdleTimeoutError") return true;
    const message = stringValue(record.message);
    if (message && isTransientMessage(message)) return true;
  }
  return false;
}

function classifyStreamRecoveryFailure(
  error: unknown,
): "provider_timeout" | "provider_network_error" | "provider_stream_error" | "unknown" {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const reason = stringValue(record.reason) ?? stringValue(context?.reason);
    const code = stringValue(record.code) ?? stringValue(context?.code);
    const name = stringValue(record.name);
    const message = stringValue(record.message);
    if (
      reason === "stream_idle_timeout" ||
      code === "model_request_timeout" ||
      code === "MODEL_REQUEST_TIMEOUT" ||
      name === "ModelStreamIdleTimeoutError" ||
      (message !== undefined && /\btimeout|timed out|stalled\b/i.test(message))
    ) {
      return "provider_timeout";
    }
    if (
      reason === "network_error" ||
      code === "model_network_error" ||
      code === "MODEL_NETWORK_ERROR" ||
      (message !== undefined && /\bECONNRESET|EPIPE|ETIMEDOUT\b/i.test(message))
    ) {
      return "provider_network_error";
    }
  }
  return error instanceof Error ? "provider_stream_error" : "unknown";
}

function isTransientMessage(message: string): boolean {
  return /\b(stream idle|stream stalled|timeout|timed out|ECONNRESET|EPIPE|ETIMEDOUT)\b/i.test(
    message,
  );
}

function* walkErrorRecords(error: unknown): Generator<Record<string, unknown>> {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    const record = asRecord(current);
    if (!record) return;
    if (seen.has(record)) return;
    seen.add(record);
    yield record;
    current = record.cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
