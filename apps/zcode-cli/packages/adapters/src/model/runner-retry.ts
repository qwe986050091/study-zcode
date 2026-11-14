// ==== model/runner-retry.ts ====
// 定位：runner 的重试计算与错误归一化边界：退避时长、可取消 sleep、最终 adapter 错误构造。
// 输入：重试策略（baseDelay/maxDelay/backoff/jitter）、attempt、retry-after、分类失败与状态上下文。
// 输出：delayMs、void、以及携带完整归因上下文的 AiSdkModelAdapterError。
// 副作用：sleep 注册/清理定时器与 abort 监听；日志函数写一条 warn 事件。
// 失败语义：abort 时抛出 abort reason/AbortError；其余函数不抛错，错误以返回值表达。
// 不变量：delay 有上限并可选抖动；已存在的可靠归因不被粗粒度分类覆盖；source 归因区分 runtime/network/provider。
import { ModelErrorCode, ModelFailureReason, type Logger } from "@zcode/contracts";
import { isProviderBusinessError } from "./model-execution.js";
import { findProviderBusinessError, type ClassifiedModelFailure } from "./failure-classifier.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { unwrapRetryError } from "./failure-inspection.js";
import {
  AiSdkModelAdapterError,
  ModelErrorSource,
  type ModelErrorSource as ModelErrorSourceType,
} from "./errors.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";
import { modelFailureAttributionFields } from "./runner-telemetry.js";

const MAX_REASONABLE_RETRY_AFTER_MS = 5 * 60_000;
const RELIABLE_ATTRIBUTION_CONTEXT_KEYS = [
  "errorPhase",
  "exceptionKind",
  "providerCode",
  "providerRequestId",
  "reason",
  "responseBodySummary",
  "responseStatus",
  "retryable",
  "source",
  "statusCode",
] as const;

/**
 * 流终止 chunk 的包装错误。
 * 继承底层 adapter error 的 message，并公开 cause 以保留网络根因；
 * 不改变文案与重试策略，仅用于让终止包装器在抛出时仍有完整因果链。
 */
export class TerminalStreamChunkError extends Error {
  constructor(readonly adapterError: AiSdkModelAdapterError) {
    super(adapterError.message);
    this.name = "TerminalStreamChunkError";
    // 流终止包装器只复制 message，丢失底层网络原因；公开 cause 但不改文案与重试策略。
    this.cause = adapterError.cause ?? adapterError;
  }
}

/**
 * 计算第 attempt 次重试前的等待时长（毫秒）。
 * 基础指数退避为 baseDelay * backoffFactor^(attempt-1)，先被 maxDelay 截断；
 * provider 给出合理的 retry-after 时直接采用（允许超过本地上限，但必须在 5 分钟或低于指数值内），
 * 否则可选 50%~100% 抖动后返回。attempt 从 1 起算。
 */
export function calculateRetryDelay(
  retry: ResolvedAiSdkModelRetryOptions,
  attempt: number,
  retryAfterMs?: number,
): number {
  const uncapped = retry.baseDelayMs * retry.backoffFactor ** Math.max(0, attempt - 1);
  const capped = Math.min(uncapped, retry.maxDelayMs);
  // provider 会返回几十秒到数分钟的 retry-after；
  // 旧 60s 上限会把合法限流等待退化为本地短退避。
  if (isReasonableRetryAfterMs(retryAfterMs, uncapped)) {
    return retryAfterMs;
  }

  if (!retry.jitter || capped === 0) {
    return capped;
  }

  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/**
 * 可取消的等待。
 * delayMs<=0 时立即返回，但若信号已 abort 仍抛错，保证取消语义一致；
 * 正延迟用定时器 + once abort 监听，abort 时清理定时器并拒绝。
 */
export async function sleep(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (abortSignal?.aborted) {
      throw createAbortError(abortSignal);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(createAbortError(abortSignal));
      return;
    }

    const timeout = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError(abortSignal));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 记录一次重试延迟决策（诊断日志，event=model.retry.delay.resolved）。
 * 输出安全 header 摘要（retry-after/retry-after-ms/x-should-retry）与最终 delayMs，
 * 便于复现 retry-after 在 header→归一化→delay 计算链路上的断点。
 * canRetry 为 false 时 nextAttempt 记 undefined，status 标 failed。
 * 输入字段：
 * - attempt：当前尝试序号（从 1 开始）。
 * - canRetry：是否还会继续重试。
 * - delayMs：计算出的等待时间，可空。
 * - failure：分类结果（reason/status/retryAfterMs 等）。
 * - logger：可空，缺失时不输出日志。
 * - responseHeaders：已脱敏的响应头。
 * - statusContext：请求归因上下文。
 */
export function logRetryDelayDecision(input: {
  attempt: number;
  canRetry: boolean;
  delayMs?: number;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  responseHeaders: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  // retry-after 可能在 header 保留、错误归一化或 delay 计算任一层断链；
  // 这里集中记录安全 header 摘要和最终等待时间，方便复现后直接定位。
  input.logger?.warn("Model retry delay decision inspected", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    canRetry: input.canRetry,
    delayMs: input.delayMs,
    event: "model.retry.delay.resolved",
    nextAttempt: input.canRetry ? input.attempt + 1 : undefined,
    reason: input.failure.reason,
    retryAfterHeader: readHeader(input.responseHeaders, "retry-after"),
    retryAfterMs: input.failure.retryAfterMs,
    retryAfterMsHeader: readHeader(input.responseHeaders, "retry-after-ms"),
    retryAfterSource: retryAfterSource(input.failure.retryAfterMs, input.responseHeaders),
    retryReason: input.failure.retryReason,
    status: input.canRetry ? "waiting" : "failed",
    statusCode: input.failure.statusCode,
    xShouldRetryHeader: readHeader(input.responseHeaders, "x-should-retry"),
  });
}

/**
 * 把任意失败归一化为 AiSdkModelAdapterError。
 * 组合 attempt/maxAttempts、模型与 provider 事实、业务错误上下文、reason/retryable、retryAfterMs
 * 以及 source 归因，附加调用方 additionalContext，作为离开 adapter 的唯一错误形态。
 * 若输入已是 adapter error，则只补齐缺失字段并保留更可靠的原归因，避免覆盖现场证据。
 */
export function toAdapterError(
  error: unknown,
  failure: ClassifiedModelFailure,
  statusContext: ModelStatusContext,
  attempt: number,
  additionalContext?: Record<string, unknown>,
): AiSdkModelAdapterError {
  const unwrapped = unwrapRetryError(error);
  const providerBusinessError =
    findProviderBusinessError(unwrapped) ?? readMappedAiSdkProviderBusinessError(unwrapped);
  const normalizedContext = {
    attempt,
    maxAttempts: statusContext.maxAttempts,
    modelId: statusContext.modelId,
    ...modelFailureAttributionFields(unwrapped, failure, additionalContext?.errorPhase),
    ...providerBusinessErrorContext(providerBusinessError),
    providerId: statusContext.providerId,
    // 错误离开 adapter 后无法再反推出实际协议与传输方式；在归一化边界保留安全事实。
    providerKind: statusContext.providerKind,
    reason: failure.reason,
    requestId: statusContext.requestId,
    retryable: failure.retryable,
    // Retry-After 只活在分类结果里，离开 adapter 就丢了；workflow 的配额停止通知
    // 要靠它算 resetAt，所以随归一化上下文带出去。
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    source: modelFailureSource(providerBusinessError ?? error, failure, additionalContext),
    statusCode: failure.statusCode,
    traceId: statusContext.traceId,
    transport: statusContext.transport,
  };

  if (error instanceof AiSdkModelAdapterError) {
    // 已有 adapter error 的因果归因可能来自更接近失败现场的可靠证据；
    // 重新包装并用 runner 的粗粒度分类覆盖它，会改变归因和错误 identity。这里只补齐缺失归因和当前请求事实。
    return error.enrichContext({
      ...error.context,
      ...normalizedContext,
      ...additionalContext,
      ...existingReliableAttributionContext(error.context),
    });
  }

  return new AiSdkModelAdapterError(failure.code, failure.message, {
    cause: error,
    context: {
      ...normalizedContext,
      ...additionalContext,
    },
  });
}

/** 提取原 adapter error 中“更接近失败现场”的可靠归因字段，供重新包装时回填。 */
function existingReliableAttributionContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!context) return {};

  return Object.fromEntries(
    RELIABLE_ATTRIBUTION_CONTEXT_KEYS.flatMap((key) =>
      context[key] === undefined ? [] : [[key, context[key]]],
    ),
  );
}

/**
 * 判定失败来源（Runtime / Network / Provider）。
 * 取消归 runtime；网络/代理/陈旧连接/流空闲/超时/TLS 归 network；
 * 有 status、业务错误或 InvalidModelResponse 归 provider；
 * 已进入 response body 的流式失败即使无 status 也归 provider；
 * 请求前的本地校验/未配置/unknown 且缺少上游证据时归 runtime。
 */
function modelFailureSource(
  error: unknown,
  failure: ClassifiedModelFailure,
  additionalContext?: Record<string, unknown>,
): ModelErrorSourceType {
  const reason = failure.reason;
  if (reason === ModelFailureReason.Cancelled) return ModelErrorSource.Runtime;
  if (
    reason === ModelFailureReason.NetworkError ||
    reason === ModelFailureReason.ProxyError ||
    reason === ModelFailureReason.StaleConnection ||
    reason === ModelFailureReason.StreamIdleTimeout ||
    reason === ModelFailureReason.Timeout ||
    reason === ModelFailureReason.TlsError
  ) {
    return ModelErrorSource.Network;
  }

  if (failure.statusCode !== undefined || isProviderBusinessError(error)) {
    return ModelErrorSource.Provider;
  }

  if (failure.code === ModelErrorCode.InvalidModelResponse) {
    return ModelErrorSource.Provider;
  }

  // SSE 已创建并进入 response body 后，即使 provider 没有返回 status/code，
  // 也已经有明确的上游边界事实；仅按 status/provider error 判断会误把这类未知失败归为 runtime。
  if (
    additionalContext?.streamFailurePhase === "response_body" ||
    additionalContext?.errorPhase === "response" ||
    additionalContext?.errorPhase === "stream" ||
    additionalContext?.errorPhase === "parse"
  ) {
    return ModelErrorSource.Provider;
  }

  // invalid_request/unknown 同时覆盖请求前的本地配置校验和 provider 响应失败；
  // 只按 reason 归因会把尚未发出网络请求的错误也记到 provider。缺少上游证据时归 runtime。
  if (
    reason === ModelFailureReason.InvalidRequest ||
    reason === ModelFailureReason.ProviderNotConfigured ||
    reason === ModelFailureReason.Unknown
  ) {
    return ModelErrorSource.Runtime;
  }

  return ModelErrorSource.Provider;
}

/**
 * 判断 retry-after 是否可信。
 * 必须非负有限值，且不超过 5 分钟上限，或小于本地指数退避值（即不会造成过度等待）。
 */
function isReasonableRetryAfterMs(
  value: number | undefined,
  exponentialDelayMs: number,
): value is number {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    (value <= MAX_REASONABLE_RETRY_AFTER_MS || value < exponentialDelayMs)
  );
}

/**
 * 解释 retry-after 的来源，用于诊断日志：
 * - blocked_by_x_should_retry：provider 明确要求不重试。
 * - provider_header：已解析出等待时间。
 * - header_unparsed_or_ignored：header 存在但未被采纳。
 * - missing：两类 header 都没有。
 */
function retryAfterSource(
  retryAfterMs: number | undefined,
  headers: Record<string, string>,
): string {
  const xShouldRetry = readHeader(headers, "x-should-retry")?.trim().toLowerCase();
  if (xShouldRetry === "false" || xShouldRetry === "0") {
    // provider 用 x-should-retry 显式否决重试时优先采信，即使存在 retry-after。
    return "blocked_by_x_should_retry";
  }
  if (retryAfterMs !== undefined) {
    return "provider_header";
  }
  if (readHeader(headers, "retry-after-ms") !== undefined || readHeader(headers, "retry-after")) {
    return "header_unparsed_or_ignored";
  }
  return "missing";
}

/** 大小写不敏感地读取响应头；缺失返回 undefined。 */
function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

/**
 * 构造可被调用方识别的取消错误。
 * 若 abort reason 已是 Error 则直接复用；否则新建 name=AbortError 的通用错误。
 */
function createAbortError(abortSignal?: AbortSignal): Error {
  const reason = abortSignal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("The model request was cancelled.");
  error.name = "AbortError";
  return error;
}

/** 仅在输入确为 ProviderBusinessError 时提取业务字段，其余返回 undefined。 */
function providerBusinessErrorContext(error: unknown): Record<string, unknown> | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  return {
    providerCode: error.providerCode,
    providerRequestId: error.providerRequestId,
    responseBodySummary: error.responseBodySummary,
    responseStatus: error.responseStatus,
  };
}
