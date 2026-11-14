// ============================================================
// 空补全（empty completion）重试
// 定位：模型正常结束但既无文本、无工具调用、也无 usage 时，视为"无效空 turn"，允许补一次。
// 输入：attempt 计数、retryCount、abortSignal、retry 参数与状态汇。
// 输出：createEmptyCompletionFailure 返回可分类失败；canRetry 返回布尔；schedule 完成后 sleep。
// 副作用：发布 model_request_failed / model_retry_scheduled 状态事件、写日志、按退避 sleep。
// 失败语义：sleep 期间 abort 会抛（交由 runner 归类 cancelled）；本文件不吞异常。
// 不变量：空补全重试总次数上限 1 次，且必须仍在 maxAttempts 预算内；abort 后不得再重试。
// ============================================================

import { ModelErrorCode, ModelFailureReason, ModelRetryReason } from "@zcode/contracts";
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { calculateRetryDelay, logRetryDelayDecision, sleep } from "./runner-retry.js";
import { publishModelStatus, type ModelStatusContext } from "./runner-status.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

export const EMPTY_COMPLETION_MAX_RETRIES = 1;
export const EMPTY_COMPLETION_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 构造"空补全"的可分类失败。retryable=true 且 retryReason=ServerError，
 * reason 用 Unknown（不是 provider 明确报错，只是响应内容为空）。
 */
export function createEmptyCompletionFailure(): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.InvalidModelResponse,
    message: EMPTY_COMPLETION_MESSAGE,
    reason: ModelFailureReason.Unknown,
    retryReason: ModelRetryReason.ServerError,
    retryable: true,
  };
}

/**
 * 是否还能补一次空补全重试：必须未 abort、空补全重试次数未达上限（1）、
 * 且当前 attempt 仍小于 maxAttempts（与普通重试共用同一预算）。
 */
export function canRetryEmptyCompletion(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  maxAttempts: number;
  retryCount: number;
}): boolean {
  return (
    !input.abortSignal?.aborted &&
    input.retryCount < EMPTY_COMPLETION_MAX_RETRIES &&
    input.attempt < input.maxAttempts
  );
}

/**
 * 发布失败事件 → 记录退避决策 → 发布重试事件 → sleep 的完整序列。
 * 失败事件里 durationMs 用的是 completedAt-startedAt（该次尝试真实耗时），
 * 重试事件里额外带 delayMs / nextAttempt / retryAfterMs，供 UI 与观测对齐。
 */
export async function scheduleEmptyCompletionRetry(input: {
  abortSignal?: AbortSignal;
  attempt: number;
  completedAt: number;
  errorPhase: "response" | "stream";
  logger?: Logger;
  requestHeaders: Record<string, string>;
  requestStatusSink?: ModelStatusSink;
  responseHeaders: Record<string, string>;
  retry: ResolvedAiSdkModelRetryOptions;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ModelStatusContext;
  statusSink?: ModelStatusSink;
  streamOutputCommitted?: boolean;
}): Promise<void> {
  const failure = createEmptyCompletionFailure();
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      errorCode: failure.code,
      errorPhase: input.errorPhase,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryable: true,
      ...(input.streamOutputCommitted !== undefined
        ? { streamOutputCommitted: input.streamOutputCommitted }
        : {}),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );

  // 退避按已消耗的重试次数计算；空补全重试同样占用 retry 预算，不额外豁免。
  const delayMs = calculateRetryDelay(input.retry, input.retryBudgetAttempt);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: true,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders: input.responseHeaders,
    statusContext: input.statusContext,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      delayMs,
      errorCode: failure.code,
      message: failure.message,
      nextAttempt: input.attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(input.requestHeaders).length,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    {
      logger: input.logger,
      requestStatusSink: input.requestStatusSink,
      statusSink: input.statusSink,
    },
  );
  await sleep(delayMs, input.abortSignal);
}
