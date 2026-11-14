/**
 * ============================================================================
 * model-status.ts —— 模型网络状态的双通道发布（事件 + 日志）
 * ============================================================================
 *
 * 【定位】provider 在排队/准入/开始/完成/失败/重试/流式停滞时调用 sink.publish，
 * 本文件负责把同一份状态同时送到：
 *   1) 内存事件数组 + 可选持久化（供 UI/遥测/冷恢复）；
 *   2) 结构化日志（供线上排障）。
 *
 * 【persist=false 的用途】Sampling（采样请求）不投影到主会话：它的网络状态
 *   只进内存与日志，不写 session event，否则主会话 UI 会冒出无关的请求卡。
 *   注意即便如此 events.push 仍会执行——调用方拿它做本次请求的 usage 归因
 *   （见 usage-observability 的 modelNetworkEvents / retryCount）。
 *
 * 【字段口径】streamRecovery 是"流恢复"附加信息（锚点、第几次重试），
 *   只在 options 提供时挂到 payload，避免普通请求多出无意义的空对象。
 * ============================================================================
 */

import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface ModelStatusSinkOptions {
  /** Sampling 不投影到主会话；保留网络日志和内存用量事件。 */
  persist?: boolean;
  onStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
}

/**
 * 创建一次模型请求的状态 sink。
 *
 * 执行顺序有意固定：onStatus（同步回调，UI 可即时响应）→ 日志 → createEvent →
 * 持久化 → 入内存数组。持久化失败会向上抛（这里不吞），因为状态事件是
 * 恢复链路的事实来源；调用方（provider 层）需要知道写入失败。
 */
export function createModelStatusSink(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  events: SessionEvent[],
  options: ModelStatusSinkOptions = {},
): ModelStatusSink {
  return {
    publish: async (statusEvent: ModelNetworkStatusEvent): Promise<void> => {
      const eventPayload = options.streamRecovery
        ? { ...statusEvent, streamRecovery: options.streamRecovery }
        : statusEvent;
      options.onStatus?.(eventPayload);
      this.logModelNetworkStatus(eventPayload, traceContext);
      const event = this.createEvent(
        SessionEventType.ModelNetworkStatus,
        eventPayload,
        traceContext,
      );
      if (options.persist !== false) await this.appendEvent(event, traceContext);
      events.push(event);
    },
  };
}

/**
 * 把网络状态映射成结构化日志。
 *
 * 级别口径：排队/准入/开始 = debug（高频、生产不落盘）；
 * 完成 = info（一次请求的可用生命周期事实）；失败/重试/流停滞 = warn
 * （可恢复异常，需要线上可查）。cancelled 虽然走 failed 分支，但 status
 * 标成 cancelled，便于区分"用户取消"与"真实网络失败"。
 */
export function logModelNetworkStatus(
  this: AgentRuntimeInternal,
  statusEvent: ModelNetworkStatusEvent,
  traceContext: TraceContext,
): void {
  const baseContext = {
    ...traceContextToLogContext(traceContext),
    attempt: statusEvent.attempt,
    baseURL: statusEvent.baseURL,
    maxAttempts: statusEvent.maxAttempts,
    modelId: statusEvent.modelId,
    providerId: statusEvent.providerId,
    providerKind: statusEvent.providerKind,
    requestId: statusEvent.requestId,
    streamRecoveryAnchorId: statusEvent.streamRecovery?.anchorId,
    streamRecoveryFromRequestId: statusEvent.streamRecovery?.recoveredFromRequestId,
    streamRecoveryMaxRetries: statusEvent.streamRecovery?.maxRetries,
    streamRecoveryRetryNumber: statusEvent.streamRecovery?.retryNumber,
    transport: statusEvent.transport,
  };

  switch (statusEvent.type) {
    case "model_request_queued":
      this.logger?.debug("Model network request queued for admission", {
        ...baseContext,
        event: "model.network.queued",
        module: "core.runtime",
        status: "waiting",
      });
      return;

    case "model_request_admitted":
      this.logger?.debug("Model network request admitted", {
        ...baseContext,
        event: "model.network.admitted",
        module: "core.runtime",
        queuedMs: statusEvent.queuedMs,
        status: "started",
      });
      return;

    case "model_request_started":
      this.logger?.debug("Model network request started", {
        ...baseContext,
        event: "model.network.started",
        module: "core.runtime",
        status: "started",
      });
      return;

    case "model_request_completed":
      this.logger?.info("Model network request completed", {
        ...baseContext,
        durationMs: statusEvent.durationMs,
        event: "model.network.completed",
        finishReason: statusEvent.finishReason,
        module: "core.runtime",
        status: "completed",
      });
      return;

    case "model_request_failed":
      this.logger?.warn("Model network request failed", {
        ...baseContext,
        durationMs: statusEvent.durationMs,
        event: "model.network.failed",
        module: "core.runtime",
        reason: statusEvent.reason,
        retryable: statusEvent.retryable,
        status: statusEvent.reason === "cancelled" ? "cancelled" : "failed",
        statusCode: statusEvent.statusCode,
        statusMessage: statusEvent.message,
      });
      return;

    case "model_retry_scheduled":
      this.logger?.warn("Model network retry scheduled", {
        ...baseContext,
        delayMs: statusEvent.delayMs,
        event: "model.network.retry_scheduled",
        module: "core.runtime",
        nextAttempt: statusEvent.nextAttempt,
        reason: statusEvent.reason,
        status: "waiting",
        statusCode: statusEvent.statusCode,
        statusMessage: statusEvent.message,
      });
      return;

    case "model_stream_stalled":
      this.logger?.warn("Model network stream stalled", {
        ...baseContext,
        event: "model.network.stream_stalled",
        idleMs: statusEvent.idleMs,
        module: "core.runtime",
        status: "waiting",
        statusMessage: statusEvent.message,
        timeoutMs: statusEvent.timeoutMs,
      });
  }
}
