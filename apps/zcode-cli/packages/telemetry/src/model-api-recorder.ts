import type {
  ModelNetworkStatusEvent,
  ModelRequestCompletedStatusEvent,
  ModelRequestFailedStatusEvent,
  ModelStatusSink,
} from "@zcode/contracts/model";
import { ModelFailureReason, ModelTransportKind } from "@zcode/contracts/model";
import type {
  AgentTelemetryErrorCategory,
  ModelApiOperationKind,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  ModelExecutionTelemetryPort,
  ResolvedModelTelemetryDescriptor,
} from "@zcode/contracts/telemetry";
import { ProviderEndpointIdentityCache } from "./provider-endpoint.js";

/**
 * 构造 ModelApiTelemetryStatusSink 的可选参数与依赖。
 * 职责：注入 telemetry 端口、时钟与容量/告警策略，避免实例内部硬编码默认值。
 * 缺失值语义：容量与超时参数缺省时回退到构造器内置常量；`now` 缺省使用 `Date.now`。
 * 失败语义：参数非法（非正数）不会报错，静默回退到默认值，保证观测组件永不阻塞模型链路。
 */
interface ModelApiTelemetryStatusSinkOptions {
  /** 单个活动 Call 的最长存活时长（毫秒）；超过即视为丢失终态并放弃，缺省 30 分钟。 */
  maxActiveCallAgeMs?: number;
  /** 同时跟踪的活动 Call 数量上限；达到上限时按最久未活跃优先淘汰，缺省 1000。 */
  maxActiveCalls?: number;
  /** 唯一外部依赖：创建/终结 Call 与 Attempt Span 的遥测端口。 */
  modelExecution: ModelExecutionTelemetryPort;
  /** 可注入时钟（毫秒）；用于测试与超时判定，缺省 `Date.now`。 */
  now?: () => number;
  /** 旁路告警回调；自身抛错会被吞掉，不得影响状态分发。 */
  onWarning?: (message: string, context: Record<string, unknown>) => void;
}

/**
 * 单个 Attempt 的内存记录。
 * 职责：把 requestId 与对应 writer 绑定，供后续状态事件按请求路由。
 */
interface AttemptState {
  /** 请求级唯一标识；同一 Call 内重试会产生不同 requestId。 */
  requestId: string;
  /** 该次尝试的 Span writer；空值不可能出现，创建即登记。 */
  writer: ModelAttemptSpanWriter;
}

/**
 * 一个逻辑模型调用（跨多次重试）的内存记录。
 * 职责：聚合尝试集合与最近活跃时间，支撑超时清理、容量淘汰与终态终结。
 * 不变量：`attempts` 中的 key 必须等于其 `requestId`。
 */
interface CallState {
  /** 最近一次尝试的 requestId；用于判定下一次 started 是首试还是重试，缺失说明尚无尝试。 */
  lastRequestId?: string;
  /** 逻辑调用标识，跨重试保持不变；也是 calls Map 的键。 */
  logicalCallId: string;
  /** 最近一次活动时刻（毫秒，`now` 时钟）；仅用于老化与淘汰排序，不代表真实耗时。 */
  lastActivityAtMs: number;
  /** 已调度但尚未开始的重试等待时长（毫秒）；被下一次 startAttempt 消费后清空。 */
  pendingRetryDelayMs?: number;
  /** 归属会话标识；用于 `abandonSession` 批量放弃，缺失时只能等超时回收。 */
  sessionId?: string;
  /** 进行中的尝试集合，按 requestId 索引。 */
  attempts: Map<string, AttemptState>;
  /** 逻辑调用级 Span writer；所有尝试都挂在其下。 */
  writer: ModelCallSpanWriter;
}

/**
 * 把 Transport 的实时事实直接写入仍然活动的 Model Call/Attempt Span。
 * 不创建终态 Record、不保存开始/结束时间，也不在导出阶段重建 Span。
 * 职责：维护 logicalCallId → 活动 Call/Attempt 的内存索引，并把状态事件分发到对应 writer。
 * 输入：`ModelStatusSink` 状态事件；不带 `modelCall` 的事件直接忽略。
 * 副作用：写 Span 属性、结束 Span，并在终态或放弃后从索引删除对应条目。
 * 失败语义：所有异常由 `publishObserved` 捕获并转为告警，绝不阻断 Provider 主链路。
 * 不变量：同一 logicalCallId 至多存在一个 CallState，且终结路径必须同时删除索引项。
 */
export class ModelApiTelemetryStatusSink implements ModelStatusSink {
  /** 活动 Call 索引，key 为 logicalCallId；仅在 started 与终结路径增删。 */
  private readonly calls = new Map<string, CallState>();
  /** Provider endpoint 解析缓存，避免每条状态事件重复解析 baseURL。 */
  private readonly endpointCache = new ProviderEndpointIdentityCache();
  /** 活动 Call 老化阈值（毫秒）；超过该时长无活动即放弃。 */
  private readonly maxActiveCallAgeMs: number;
  /** 活动 Call 容量上限；防止异常流量导致内存无界增长。 */
  private readonly maxActiveCalls: number;
  /** 遥测端口，所有 Span 创建与终结都经由此入口。 */
  private readonly modelExecution: ModelExecutionTelemetryPort;
  /** 时间源（毫秒）；注入化以支持确定性测试。 */
  private readonly now: () => number;
  /** 容量告警节流时间点（毫秒）；此前不再重复告警，避免事件风暴。 */
  private nextCapacityWarningAtMs = 0;
  /** 下一次老化扫描时间点（毫秒）；按事件驱动节流，避免每条事件全量扫描。 */
  private nextSweepAtMs = 0;
  /** 旁路告警回调，可选；未提供时错误静默丢弃。 */
  private readonly onWarning?: ModelApiTelemetryStatusSinkOptions["onWarning"];

  /**
   * 建立状态 Sink 实例，只做参数归一化与依赖注入，不访问任何外部状态。
   * 输入：见 `ModelApiTelemetryStatusSinkOptions`；非法容量值静默回退默认值。
   * 副作用：无。
   */
  constructor(options: ModelApiTelemetryStatusSinkOptions) {
    this.maxActiveCallAgeMs = positiveInteger(options.maxActiveCallAgeMs, 30 * 60_000);
    this.maxActiveCalls = positiveInteger(options.maxActiveCalls, 1_000);
    this.modelExecution = options.modelExecution;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning;
  }

  /**
   * 接收常规模型网络状态事件（started、首包、重试、完成等）。
   * 输入：`ModelNetworkStatusEvent`；不带 `modelCall` 的全局事件会被忽略。
   * 输出：无返回值，状态只体现在 Span 属性上。
   * 失败语义：内部异常被完全吞掉并转为告警，调用方不会观察到抛错。
   */
  publish(event: ModelNetworkStatusEvent): void {
    this.publishObserved(event);
  }

  /**
   * 接收失败状态事件，额外携带原始错误对象用于脱敏后落属性。
   * 输入：`error` 可为任意值；不可识别时退化为事件字段拼装的合成错误。
   * 失败语义：与 `publish` 一致，异常旁路，不影响 Provider 上层处理。
   */
  publishFailure(event: ModelRequestFailedStatusEvent, error: unknown): void {
    this.publishObserved(event, error);
  }

  /**
   * 状态事件的实际分发实现：先做老化扫描，再按事件类型路由到 Call/Attempt writer。
   * 为什么把扫描放在入口：所有事件都会推进时钟，借机回收丢失终态的 Call，无需独立定时器。
   */
  private publishObserved(event: ModelNetworkStatusEvent, failureError?: unknown): void {
    try {
      this.publishSafely(event, failureError);
    } catch (error) {
      // Bug 根因：Telemetry Sink 位于模型状态 fan-out 内，任何同步异常都会阻断 Provider
      // 状态持久化和模型主链路；这里必须完全旁路。
      try {
        this.onWarning?.("Model telemetry status processing failed", {
          eventType: event.type,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      } catch {
        // 观测健康回调也不能反向污染模型链路。
      }
    }
  }

  /**
   * 进程关闭时放弃所有仍在跟踪的 Call，避免残留永不结束的 Span。
   * 副作用：批量 `finishAbandoned` 并清空索引；重复调用是安全的。
   */
  shutdown(): void {
    for (const call of this.calls.values()) {
      this.abandonCall(call, "process_shutdown");
    }
  }

  /**
   * 按会话放弃仍活动的 Call，用于会话结束时回收未收到终态事件的调用。
   * 口径：只匹配显式记录了 `sessionId` 的 Call；其余继续留在索引中等待超时回收。
   */
  abandonSession(sessionId: string): void {
    for (const call of this.calls.values()) {
      if (call.sessionId === sessionId) {
        this.abandonCall(call, "session_shutdown");
      }
    }
  }

  /**
   * 当前活动 Call 数量，用于测试断言与外部监控。
   * 口径：只反映内存索引规模，不代表已导出到后端的 span 数量。
   */
  get activeCallCount(): number {
    return this.calls.size;
  }

  private publishSafely(event: ModelNetworkStatusEvent, failureError?: unknown): void {
    const now = this.now();
    this.sweepExpiredCalls(now);
    const modelCall = event.modelCall;
    // 全局事件没有调用归属，无法落到具体 Span，直接丢弃而不是伪造一个调用。
    if (!modelCall) return;
    let call = this.calls.get(modelCall.logicalCallId);

    if (event.type === "model_request_started") {
      // 仅在无 writer 时补建 Call；重复 started 复用既有 Span，避免同一逻辑调用出现两条主线。
      if (!call) {
        this.ensureCapacity(now);
        const target = this.resolveTarget(event);
        const callCause = modelCall.callCause ?? "initial";
        const writer = this.modelExecution.startCall(
          callCause === "initial" || !modelCall.previousLogicalCallId
            ? {
                callCause: "initial",
                logicalCallId: modelCall.logicalCallId,
                operation: modelCall.operation,
                requested: target,
                streaming: event.transport !== ModelTransportKind.Http,
              }
            : {
                callCause,
                logicalCallId: modelCall.logicalCallId,
                operation: modelCall.operation,
                previousLogicalCallId: modelCall.previousLogicalCallId,
                requested: target,
                streaming: event.transport !== ModelTransportKind.Http,
              },
        );
        call = {
          attempts: new Map(),
          lastActivityAtMs: now,
          logicalCallId: modelCall.logicalCallId,
          sessionId: event.sessionId,
          writer,
        };
        this.calls.set(modelCall.logicalCallId, call);
      }
      call.lastActivityAtMs = now;
      this.startAttempt(call, event);
      return;
    }

    // 未见 started 的后续事件没有 writer；补建会伪造缺失的时间线，因此直接忽略。
    if (!call) return;
    call.lastActivityAtMs = now;
    const attempt = call.attempts.get(event.requestId);

    switch (event.type) {
      case "model_first_provider_event":
        attempt?.writer.markFirstProviderEvent();
        return;
      case "model_first_content":
        attempt?.writer.markFirstContent();
        return;
      case "model_first_text":
        attempt?.writer.markFirstText();
        return;
      case "model_stream_stalled":
        attempt?.writer.markStreamStalled(event.idleMs);
        return;
      case "model_request_observation":
        attempt?.writer.recordRequestObservation(event.observation);
        return;
      case "model_retry_scheduled":
        call.pendingRetryDelayMs = event.delayMs;
        return;
      case "model_request_failed":
        if (!attempt) return;
        this.finishFailedAttempt(call, attempt, event, failureError);
        call.attempts.delete(event.requestId);
        // 不可重试才终结 Call；可重试则保留 Call，等待下一次 started 续接。
        if (!event.retryable) this.finishFailedCall(call, event, failureError);
        return;
      case "model_request_completed":
        if (!attempt) return;
        this.finishCompletedAttempt(attempt.writer, event);
        call.attempts.delete(event.requestId);
        call.writer.finishCompleted();
        // 完成后立即移除索引：同一逻辑调用的后续事件不应再命中旧 writer。
        this.calls.delete(call.logicalCallId);
    }
  }

  /**
   * 为一次新请求创建 Attempt Span，并登记到 Call 的尝试表。
   * 输入：`event` 必须是 started；`attempt > 1` 且存在上次 requestId 时标记为 retry。
   * 口径：attemptCause 由是否首试推断；retryDelayMs 取自最近一次 scheduled 事件。
   * 副作用：写入 effective reasoning 属性，并清空已消费的 pendingRetryDelayMs。
   * 不变量：同一 requestId 不会重复创建 writer，先查表命中即直接返回。
   */
  private startAttempt(
    call: CallState,
    event: Extract<ModelNetworkStatusEvent, { type: "model_request_started" }>,
  ): void {
    if (call.attempts.has(event.requestId)) return;
    const target = this.resolveTarget(event);
    const previousRequestId = call.lastRequestId;
    const isInitial = event.attempt <= 1 || !previousRequestId;
    const writer = call.writer.startAttempt(
      isInitial
        ? {
            apiOperation: apiOperationFromRoute(target.providerRoute),
            attemptCause: "initial",
            attemptNumber: event.attempt,
            maxAttempts: event.maxAttempts,
            requestId: event.requestId,
            target,
            transport: event.transport,
          }
        : {
            apiOperation: apiOperationFromRoute(target.providerRoute),
            attemptCause: "retry",
            attemptNumber: event.attempt,
            maxAttempts: event.maxAttempts,
            previousRequestId,
            requestId: event.requestId,
            retryDelayMs: call.pendingRetryDelayMs,
            target,
            transport: event.transport,
          },
    );
    setEffectiveReasoning(writer, target);
    call.attempts.set(event.requestId, { requestId: event.requestId, writer });
    call.lastRequestId = event.requestId;
    call.pendingRetryDelayMs = undefined;
  }

  /**
   * 把完成事件中的可选字段写入 Attempt Span 后终结。
   * 输入：`event` 字段均可选，只有显式提供的值才落属性，缺失不补默认值。
   * 口径：token 计数按原值透传（单位由 writer 层定义）；`streamOutputCommitted` 缺省 false。
   * 副作用：结束 Attempt Span；所有属性必须在 `finishCompleted` 之前写完。
   */
  private finishCompletedAttempt(
    writer: ModelAttemptSpanWriter,
    event: ModelRequestCompletedStatusEvent,
  ): void {
    if (event.providerRequestId) writer.setProviderRequestId(event.providerRequestId);
    if (event.finishReason) writer.setFinishReason(event.finishReason);
    if (event.usage) {
      if (event.usage.inputTokens !== undefined) {
        writer.setInputTokens(event.usage.inputTokens);
      }
      if (event.usage.outputTokens !== undefined) {
        writer.setOutputTokens(event.usage.outputTokens);
      }
      if (event.usage.reasoningTokens !== undefined) {
        writer.setReasoningTokens(event.usage.reasoningTokens);
      }
      if (event.usage.cacheReadTokens !== undefined) {
        writer.setCacheReadTokens(event.usage.cacheReadTokens);
      }
      if (event.usage.cacheWriteTokens !== undefined) {
        writer.setCacheWriteTokens(event.usage.cacheWriteTokens);
      }
    }
    writer.setStreamOutputCommitted(event.streamOutputCommitted ?? false);
    writer.finishCompleted();
  }

  /**
   * 把失败事件的诊断字段写入 Attempt Span，并按取消/失败分流终结。
   * 输入：`failureError` 为原始异常；缺失时用事件字段拼装合成错误再交给脱敏流程。
   * 失败语义：`ModelFailureReason.Cancelled` 终结为 cancelled，不标记错误状态。
   * 不变量：取消与失败互斥，且都在所有可选诊断属性写完之后执行。
   */
  private finishFailedAttempt(
    call: CallState,
    attempt: AttemptState,
    event: ModelRequestFailedStatusEvent,
    failureError: unknown,
  ): void {
    if (event.statusCode !== undefined) attempt.writer.setHttpStatusCode(event.statusCode);
    if (event.providerRequestId) {
      attempt.writer.setProviderRequestId(event.providerRequestId);
    }
    if (event.providerErrorCode) {
      attempt.writer.setProviderErrorCode(event.providerErrorCode);
    }
    if (event.providerErrorMessage) {
      attempt.writer.setProviderErrorMessage(event.providerErrorMessage);
    }
    if (event.retryAfterMs !== undefined) {
      attempt.writer.setRetryAfterMs(event.retryAfterMs);
    }
    attempt.writer.setStreamOutputCommitted(event.streamOutputCommitted ?? false);

    if (event.reason === ModelFailureReason.Cancelled) {
      attempt.writer.finishCancelled("abort_signal");
      return;
    }
    attempt.writer.finishFailed(
      failureStage(event),
      errorCategory(event),
      failureError ?? {
        code: event.providerErrorCode ?? event.errorCode,
        message: event.providerErrorMessage ?? event.message,
        name: event.exceptionType ?? "ModelProviderError",
        statusCode: event.statusCode,
      },
    );
  }

  /**
   * 终结逻辑调用级 Span：不可重试失败或取消后调用，并移除索引。
   * 口径：非取消场景固定以 `attempts` 作为失败阶段；错误对象优先使用原始异常。
   * 副作用：删除 calls 索引，保证同一 logicalCallId 的后续事件不会复用旧 writer。
   */
  private finishFailedCall(
    call: CallState,
    event: ModelRequestFailedStatusEvent,
    failureError: unknown,
  ): void {
    if (event.reason === ModelFailureReason.Cancelled) {
      call.writer.finishCancelled("abort_signal");
    } else {
      call.writer.finishFailed(
        "attempts",
        errorCategory(event),
        failureError ?? {
          code: event.providerErrorCode ?? event.errorCode,
          message: event.providerErrorMessage ?? event.message,
          name: event.exceptionType ?? "ModelProviderError",
        },
      );
    }
    this.calls.delete(call.logicalCallId);
  }

  /**
   * 解析事件的 Provider 目标描述，供 Call/Attempt Span 属性使用。
   * 输出：endpoint 无法解析时 `providerOrigin`/`providerRoute` 为 undefined；providerKind 缺失记为 `unknown`。
   * 口径：reasoning 描述缺失时整体填充 unknown 五元组，便于下游区分"未知"与"未采集"。
   * 副作用：可能写入 endpoint 缓存（纯内存）。
   */
  private resolveTarget(event: ModelNetworkStatusEvent): ResolvedModelTelemetryDescriptor {
    const endpoint = this.endpointCache.resolve(event.providerKind, event.baseURL);
    const reasoning = event.modelCall?.reasoning ?? {
      capability: "unknown",
      effectiveControl: "unknown",
      effectiveState: "unknown",
      requestedControl: "unknown",
      requestedState: "unknown",
    };
    return {
      providerId: String(event.providerId),
      providerKind: event.providerKind?.trim() || "unknown",
      providerOrigin: endpoint?.origin,
      providerRoute: endpoint?.route,
      reasoning,
      requestedModel: String(event.modelId),
    };
  }

  /**
   * 按事件驱动节流扫描，清理长时间无活动的 Call，避免丢失终态事件导致 Span 永不结束。
   * 输入：`now` 为毫秒时间；`lastActivityAtMs` 早于老化阈值即放弃。
   * 副作用：终结对应 Call/Attempt Span，并写出一条聚合告警。
   * 不变量：扫描间隔取 `maxActiveCallAgeMs` 与 60s 的较小值，避免高频全量遍历。
   */
  private sweepExpiredCalls(now: number): void {
    if (now < this.nextSweepAtMs) return;
    this.nextSweepAtMs = now + Math.min(this.maxActiveCallAgeMs, 60_000);
    let abandonedCount = 0;
    for (const call of this.calls.values()) {
      if (now - call.lastActivityAtMs < this.maxActiveCallAgeMs) continue;
      this.abandonCall(call, "missing_terminal");
      abandonedCount += 1;
    }
    if (abandonedCount > 0) {
      this.warn("Expired model telemetry calls were abandoned", {
        abandonedCount,
        maxActiveCallAgeMs: this.maxActiveCallAgeMs,
      });
    }
  }

  /**
   * 容量保护：新建 Call 前淘汰最久未活跃的条目，保证内存上界。
   * 口径：依据 `lastActivityAtMs` 最小值淘汰，并走正常放弃路径终结 Span。
   * 副作用：可能触发容量告警，告警按 60s 节流，避免事件风暴刷屏。
   * 不变量：循环直到 `calls.size < maxActiveCalls`，否则新事件到达时仍会反复超限。
   */
  private ensureCapacity(now: number): void {
    let abandonedCount = 0;
    while (this.calls.size >= this.maxActiveCalls) {
      const oldest = [...this.calls.values()].reduce<CallState | undefined>(
        (candidate, call) =>
          !candidate || call.lastActivityAtMs < candidate.lastActivityAtMs ? call : candidate,
        undefined,
      );
      if (!oldest) return;
      this.abandonCall(oldest, "missing_terminal");
      abandonedCount += 1;
    }
    if (abandonedCount > 0 && now >= this.nextCapacityWarningAtMs) {
      this.nextCapacityWarningAtMs = now + 60_000;
      this.warn("Model telemetry active call capacity was reached", {
        abandonedCount,
        maxActiveCalls: this.maxActiveCalls,
      });
    }
  }

  /**
   * 统一的放弃路径：先终结全部 Attempt，再终结 Call，最后移除索引。
   * 为什么按子到父的顺序：先结束父 Span 会让仍打开的子 Span 断链，必须自下而上收尾。
   * 输入：`reason` 为受控枚举，直接映射到 abandon 属性。
   */
  private abandonCall(
    call: CallState,
    reason: "missing_terminal" | "session_shutdown" | "process_shutdown",
  ): void {
    for (const attempt of call.attempts.values()) {
      attempt.writer.finishAbandoned(reason);
    }
    call.attempts.clear();
    call.writer.finishAbandoned(reason);
    this.calls.delete(call.logicalCallId);
  }

  /**
   * 安全上报旁路告警；回调自身抛错被吞掉，保持 telemetry 完全旁路。
   * 为什么单独封装：多个私有路径共享同一降级语义，避免到处重复 try/catch。
   */
  private warn(message: string, context: Record<string, unknown>): void {
    try {
      this.onWarning?.(message, context);
    } catch {
      // Telemetry 健康回调也必须旁路。
    }
  }
}

/**
 * 把可选数值归一化为正整数，非法值回退到调用方提供的 fallback。
 * 口径：小于等于 0、NaN、Infinity 视为非法；小数向下取整。
 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * 把最终生效的 reasoning 状态/控制/等级/预算写入 Attempt Span。
 * 输入：`target.reasoning.effective*` 已由上层解析完成，本函数不做任何推断。
 * 口径：level 仅在非空时写入；budgetTokens 仅在不为 undefined 时写入（0 同样保留）。
 */
function setEffectiveReasoning(
  writer: ModelAttemptSpanWriter,
  target: ResolvedModelTelemetryDescriptor,
): void {
  writer.setEffectiveReasoningState(target.reasoning.effectiveState);
  writer.setEffectiveReasoningControl(target.reasoning.effectiveControl);
  if (target.reasoning.effectiveLevel) {
    writer.setEffectiveReasoningLevel(target.reasoning.effectiveLevel);
  }
  if (target.reasoning.effectiveBudgetTokens !== undefined) {
    writer.setEffectiveReasoningBudgetTokens(target.reasoning.effectiveBudgetTokens);
  }
}

/**
 * 从 provider 路由推断模型 API 操作类型，用于 Span 维度归类。
 * 口径：基于路由子串的稳定映射；无法识别时返回 `unknown` 而非抛错。
 */
function apiOperationFromRoute(route: string | undefined): ModelApiOperationKind {
  const normalized = route?.toLowerCase() ?? "";
  if (normalized.includes("/chat/completions")) return "chat_completions";
  if (normalized.includes("/responses")) return "responses";
  if (normalized.includes("/messages")) return "messages";
  if (normalized.includes(":generatecontent") || normalized.includes(":streamgeneratecontent")) {
    return "generate_content";
  }
  return "unknown";
}

/**
 * 由失败事件推导 Attempt 的失败阶段。
 * 口径：`prepare` 阶段归类为 configuration；未提供阶段时记为 unhandled。
 */
function failureStage(event: ModelRequestFailedStatusEvent): ModelAttemptFailureStage {
  return event.errorPhase === "prepare" ? "configuration" : (event.errorPhase ?? "unhandled");
}

/**
 * 把模型失败原因映射为稳定的错误分类枚举。
 * 口径：一个原因只映射一个分类；未列出的原因统一归入 unknown，避免新增枚举时属性缺失。
 */
function errorCategory(event: ModelRequestFailedStatusEvent): AgentTelemetryErrorCategory {
  switch (event.reason) {
    case ModelFailureReason.AuthFailed:
      return "authentication";
    case ModelFailureReason.ProviderNotConfigured:
    case ModelFailureReason.InvalidRequest:
      return "configuration";
    case ModelFailureReason.RateLimited:
      return "rate_limit";
    case ModelFailureReason.Timeout:
    case ModelFailureReason.StreamIdleTimeout:
      return "timeout";
    case ModelFailureReason.NetworkError:
    case ModelFailureReason.StaleConnection:
    case ModelFailureReason.TlsError:
      return "network";
    case ModelFailureReason.Cancelled:
      return "cancelled";
    case ModelFailureReason.ContextExceeded:
    case ModelFailureReason.ProviderOverloaded:
    case ModelFailureReason.ServerError:
    case ModelFailureReason.ProxyError:
    case ModelFailureReason.AuthRefresh:
    case ModelFailureReason.OffpeakQueued:
      return "provider";
    default:
      return "unknown";
  }
}
