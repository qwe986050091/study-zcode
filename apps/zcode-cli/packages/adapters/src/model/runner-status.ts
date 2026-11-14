// INV-01 每次物理尝试必须有独立 requestId：守住位置 createAttemptStatusContext；改错故障 上游日志与 retry-after 诊断串请求。
// INV-02 traceId 缺失时生成而不是留空：守住位置 createStatusContext；改错故障 请求无法关联追踪。
// INV-03 请求侧与生效侧 reasoning 分离：守住位置 initialReasoningObservation；改错故障 把 provider 默认当成已生效。
// INV-04 观测事件必须先于终态投递：守住位置 publishModelStatus 的调用顺序；改错故障 recorder 释放 span 后观测丢失。
// INV-05 observations.take 是消费语义：守住位置 publishRequestObservations；改错故障 同一批观测被投递两次。
// INV-06 队列与准入事件不经过票据：守住位置 admissionWaitPublishers；改错故障 治理器收到没有票据的伪事件。
// INV-07 单 sink 失败不得影响其他 sink：守住位置 allSettled 与逐条 warn；改错故障 观测故障打断请求链路。
// INV-08 failed 且有原始错误时改走 publishFailure：守住位置 三元投递；改错故障 治理器只拿到事件、拿不到异常对象。
// INV-09 requestStatusSink 与 statusSink 同对象时只投一次：守住位置 身份比较；改错故障 重复消费导致状态翻倍。
// INV-10 里程碑只发进程级 sink：守住位置 publishModelTelemetryMilestone；改错故障 纯观测事件污染会话事件流。
// INV-11 observation 事件不重复写本地日志：守住位置 logStatusEvent 末尾分支；改错故障 一次请求两条同内容日志。
// INV-12 maxRetries 用 0 表达无上限：守住位置 三元；改错故障 无上限被显示成 0 次重试。
// INV-13 日志上下文与事件同源：守住位置 modelStatusLogContext；改错故障 日志里的 attempt 与实际不符。
//
// 模块职责：模型请求状态事件的构造、日志级别选择与多 sink 投递。
// 阅读顺序：先看上下文构造与 attempt 派生，再看投递顺序与失败降级，最后看日志字段。
// ============================================================
// ==== model/runner-status ====
// ============================================================
// 定位：模型请求状态事件（排队/准入/开始/重试/失败/完成/流停滞/里程碑）的构造、
//   日志记录与多 sink 投递；是 runner 观测面的统一出口。
// 输入：ModelStatusContext（归因与请求标识）、ModelNetworkStatusEvent、各 sink 与 logger。
// 输出：状态上下文对象；投递函数返回 Promise<void>，不返回投递结果。
// 副作用：写日志、向 admissionTicket / statusSink / requestStatusSink 发布事件，可能消费
//   requestObservations（take 后即删除，属有状态操作）。
// 失败语义：sink 投递失败只 warn 并继续其他 sink，绝不向上抛出导致请求失败；
//   并发投递用 Promise.allSettled，单个失败不影响其余。
// 不变量：每次物理 provider 尝试必须使用新的 requestId；观测事件必须先于终态事件投递。

import type {
  Logger,
  ModelRequestObservationStatusEvent,
  ModelNetworkStatusEvent,
  ModelReasoningCallHint,
  ModelStatusSink,
  ModelTransportKind,
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  QueryId,
  ResolvedModelApiCallObservation,
  TraceId,
} from "@zcode/contracts";
import {
  ModelFailureReason as ModelFailureReasonValue,
  createTraceId,
  resolveModelApiCallObservation,
} from "@zcode/contracts";
import { UNBOUNDED_RETRY_MAX_ATTEMPTS } from "./retry-budget.js";
// 请求归因 header 一族住在 runner-attribution.ts（max-lines 拆分）；公开面仍从本文件导出，
// 既有 importer 不必改路径。
import { resolveModelRequestSessionType } from "./runner-attribution.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import type { ModelRequestObservationSource } from "./request-security.js";
import { stringMetadata } from "./runner-record.js";

export {
  createModelRequestAttributionHeaders,
  normalizeModelSessionIdForAttribution,
  resolveModelRequestSessionType,
} from "./runner-attribution.js";

export interface ModelStatusContext {
  /** 全链路追踪 id；缺失时由 createTraceId 生成，保证每个请求都可关联。 */
  traceId: TraceId;
  /** 查询 id；来自 traceContext 优先，其次 metadata。 */
  queryId?: QueryId;
  /** 会话 id，用于把网络状态归到具体会话。 */
  sessionId?: ModelNetworkStatusEvent["sessionId"];
  /** 轮次 id，标识一次用户回合。 */
  turnId?: ModelNetworkStatusEvent["turnId"];
  /** 父会话 id（子代理场景）。 */
  parentSessionId?: ModelNetworkStatusEvent["parentSessionId"];
  /** 当前工具调用 id，便于把模型请求挂到工具执行链。 */
  toolCallId?: string;
  /** 当前 span id。 */
  spanId?: string;
  /** 父 span id，构建调用树。 */
  parentSpanId?: string;
  /** 查询来源（如 agent 名称/场景），用于解析 api call 观测。 */
  querySource?: string;
  /** 本次物理请求 id；每次 adapter retry 都会换成新 UUID。 */
  requestId: string;
  /** 解析后的 provider id。 */
  providerId: ResolvedAiSdkModel["providerId"];
  /** 解析后的模型 id。 */
  modelId: ResolvedAiSdkModel["modelId"];
  /** 请求会话类型（交互/后台等），用于归因 header 与观测。 */
  modelRequestSessionType: ModelRequestSessionTypeValue;
  /** provider base URL，诊断用。 */
  baseURL?: string;
  /** provider 类型（openai/anthropic/...），诊断用。 */
  providerKind?: string;
  /** 传输方式（stream/non-stream），决定里程碑事件是否适用。 */
  transport: ModelTransportKind;
  /** 最大尝试次数；0 表示无上限（见 UNBOUNDED_RETRY_MAX_ATTEMPTS）。 */
  maxAttempts: number;
  /** 流恢复配置；透传给状态事件，供下游判断是否允许续流。 */
  streamRecovery?: ModelNetworkStatusEvent["streamRecovery"];
  /** api call 观测对象（reasoning/agent/operation/step 等归因信息）。 */
  modelCall: ResolvedModelApiCallObservation;
}

/**
 * 从请求、解析模型与传输方式构造状态上下文，补齐所有归因字段。
 * 输入：maxAttempts、request（含 metadata/traceContext/modelCall）、resolved、transport。
 * 输出：完整 ModelStatusContext；缺失的 id 走 metadata 兜底，最终 traceId/requestId 随机生成。
 * 不变量：modelCall 的 reasoning 初始化为 unknown 观测，真实结果由 fetch 层回填。
 */
export function createStatusContext(input: {
  maxAttempts: number;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  transport: ModelTransportKind;
}): ModelStatusContext {
  // traceContext 优先于 metadata，metadata 优先于随机生成。
  // requestId 缺失时随机生成，保证每条事件都能定位。
  // 所有 stringMetadata 读取都是防御性的，不信任外部形状。
  const metadata = input.request.metadata ?? {};
  const querySource = stringMetadata(metadata.querySource);
  const resolvedModelCall = resolveModelApiCallObservation(querySource, input.request.modelCall);
  return {
    baseURL: input.resolved.baseURL,
    maxAttempts: input.maxAttempts,
    providerId: input.resolved.providerId,
    modelId: input.resolved.modelId,
    modelRequestSessionType: resolveModelRequestSessionType(
      input.request.modelRequestSessionType,
      resolvedModelCall,
    ),
    requestId: stringMetadata(metadata.requestId) ?? crypto.randomUUID(),
    sessionId: (input.request.traceContext?.sessionId ??
      stringMetadata(metadata.sessionId)) as ModelStatusContext["sessionId"],
    spanId: input.request.traceContext?.spanId ?? stringMetadata(metadata.spanId),
    parentSpanId:
      input.request.traceContext?.parentSpanId ??
      stringMetadata(metadata.parentSpanId) ??
      stringMetadata(metadata.parentId),
    querySource,
    queryId: (input.request.traceContext?.queryId ?? stringMetadata(metadata.queryId)) as
      | QueryId
      | undefined,
    traceId: (input.request.traceContext?.traceId ??
      stringMetadata(metadata.traceId) ??
      createTraceId()) as TraceId,
    providerKind: input.resolved.providerKind,
    streamRecovery: input.request.streamRecovery,
    transport: input.transport,
    turnId: (input.request.traceContext?.turnId ??
      stringMetadata(metadata.turnId)) as ModelStatusContext["turnId"],
    parentSessionId: stringMetadata(metadata.parentSessionId) as
      | ModelStatusContext["parentSessionId"]
      | undefined,
    toolCallId: stringMetadata(metadata.toolCallId),
    modelCall: {
      ...resolvedModelCall,
      agentName: resolvedModelCall.agentName ?? stringMetadata(metadata.agentName),
      operationId:
        resolvedModelCall.operationId ??
        input.request.traceContext?.spanId ??
        stringMetadata(metadata.spanId),
      stepIndex:
        resolvedModelCall.stepIndex ??
        (typeof metadata.stepIndex === "number"
          ? metadata.stepIndex
          : typeof metadata.iteration === "number"
            ? metadata.iteration
            : undefined),
      reasoning: initialReasoningObservation(resolvedModelCall.reasoning, undefined),
    },
  };
}

/**
 * 为 retry 后的尝试派生状态上下文：只有 attempt > 1 才生成新的 requestId。
 * 输出：首轮原样返回同一对象；后续轮次返回浅拷贝 + 新 requestId。
 * 不变量：requestId 与物理请求一一对应，避免上游日志与 retry-after 诊断串请求。
 */
export function createAttemptStatusContext(
  statusContext: ModelStatusContext,
  attempt: number,
): ModelStatusContext {
  // 首轮直接复用上下文，只有 retry 才需要新 requestId。
  // 浅拷贝其余字段，避免调用方误改首轮上下文。
  // [契约] attempt > 1 才换 requestId：adapter retry 是新的物理请求，复用首轮 id 会把重试日志与首轮串在一起。
  if (attempt <= 1) {
    return statusContext;
  }

  return {
    ...statusContext,
    // adapter retry 会发起新的物理 provider 请求；
    // 复用首轮 requestId 会让上游日志和 retry-after 诊断串错请求。
    requestId: crypto.randomUUID(),
  };
}

/**
 * 构造 reasoning 观测初值：能力未知，请求侧取显式 hint，生效侧在 disabled 时可直接确认，
 * 其余留 unknown 等待 provider 回填。
 * 输入：reasoning hint 与模型变体标识（作为兜底的 requestedLevel）。
 */
function initialReasoningObservation(
  hint: ModelReasoningCallHint | undefined,
  modelVariant: string | undefined,
): ResolvedModelApiCallObservation["reasoning"] {
  // 能力默认 unknown，由 provider 回流后再确认。
  // 显式 disabled 可以直接确认生效值，其余保持 unknown。
  // 请求侧与生效侧分别赋值，不能互相兜底。
  // 预算 token 只在显式给出时写入，避免伪精确。
  const explicit = hint?.explicit;
  return {
    capability: "unknown",
    requestedControl: explicit?.controlType ?? "provider_default",
    requestedState: explicit?.state ?? "provider_default",
    requestedLevel: hint?.requestedLevel ?? modelVariant,
    effectiveControl: explicit?.controlType ?? "unknown",
    effectiveState: explicit?.state ?? "unknown",
    effectiveLevel:
      explicit?.effectiveLevel ?? (explicit?.state === "disabled" ? "disabled" : "unknown"),
    ...(explicit?.effectiveBudgetTokens !== undefined
      ? { effectiveBudgetTokens: explicit.effectiveBudgetTokens }
      : {}),
  };
}

/**
 * 准入等待两端的状态事件：`admitAttempt` 的 `tryAcquire` 未命中即 `queued`，拿到票即
 * `admitted`（带排队时长）。此时还没有票据，所以不经 ticket 投递——治理器不需要这两条。
 */
export function admissionWaitPublishers(
  statusContext: ModelStatusContext,
  attempt: number,
  publishOptions: Parameters<typeof publishModelStatus>[1],
): {
  onQueued: () => Promise<void>;
  onAdmitted: (queuedMs: number) => Promise<void>;
} {
  return {
    onQueued: () =>
      publishModelStatus(
        {
          ...statusContext,
          attempt,
          timestamp: new Date().toISOString(),
          type: "model_request_queued",
        },
        publishOptions,
      ),
    onAdmitted: (queuedMs) =>
      publishModelStatus(
        {
          ...statusContext,
          attempt,
          queuedMs,
          timestamp: new Date().toISOString(),
          type: "model_request_admitted",
        },
        publishOptions,
      ),
  };
}

/**
 * 状态事件统一投递：先写日志、再发观测，随后并发投递到票据/请求/进程级 sink。
 * 输入：event + 可选 admissionTicket/statusSink/requestStatusSink/failureError/logger。
 * 副作用：调用 observations.take(requestId)（消费语义）；成功事件不会带 failureError。
 * 失败语义：所有投递用 Promise.allSettled，失败仅 warn，保证请求链路不受观测故障影响。
 * 投递纪律：ticket 与 requestStatusSink 只收事件；statusSink 在 failed 且有 failureError
 *   时改走 publishFailure，携带原始错误对象。
 */
export async function publishModelStatus(
  event: ModelNetworkStatusEvent,
  options: {
    /**
     * 本次尝试的准入票据：它是该尝试专属的
     * 状态事件汇，治理器从这里读结果。与 request/telemetry sink 同一条投递纪律（失败只告警）。
     */
    admissionTicket?: ModelStatusSink;
    requestObservations?: ModelRequestObservationSource;
    failureError?: unknown;
    logger?: Logger;
    requestStatusSink?: ModelStatusSink;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  // 先写日志再消费观测，保证本地日志早于 sink 结果。
  // 观测投递必须在这一步之后、sink 扇出之前完成。
  // deliveries 是惰性函数数组，凑齐后统一并发执行。
  logStatusEvent(event, options.logger);
  await publishRequestObservations(event, options);

  // 票据与请求级 sink 只收事件，不接收错误对象。
  // 两个 sink 相同时跳过重复投递。
  const deliveries: Array<() => void | Promise<void>> = [];
  if (options.admissionTicket) {
    const ticket = options.admissionTicket;
    deliveries.push(() => ticket.publish(event));
  }
  if (options.statusSink) {
    const statusSink = options.statusSink;
    if (options.requestStatusSink && options.requestStatusSink !== options.statusSink) {
      deliveries.push(() => options.requestStatusSink!.publish(event));
    }
    deliveries.push(() =>
      event.type === "model_request_failed" &&
      options.failureError !== undefined &&
      statusSink.publishFailure
        ? statusSink.publishFailure(event, options.failureError)
        : statusSink.publish(event),
    );
  } else if (options.requestStatusSink) {
    deliveries.push(() => options.requestStatusSink!.publish(event));
  }
  if (deliveries.length === 0) return;

  const results = await Promise.allSettled(
    deliveries.map((deliver) => Promise.resolve().then(deliver)),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      options.logger?.warn("Model status sink failed", {
        ...modelStatusLogContext(event),
        errorMessage:
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        event: "model.status_sink.failed",
        status: "failed",
      });
    }
  }
}

/**
 * attempt 终态前，把 signer 暂存的签名观测按 requestId 取出并只发给进程级 Telemetry Sink。
 * 必须先于终态事件投递：recorder 收到终态后会释放该 attempt 的 span writer。
 * 本地日志已在 fetch 层即时写入，这里不重复记录。
 */
async function publishRequestObservations(
  event: ModelNetworkStatusEvent,
  options: {
    requestObservations?: ModelRequestObservationSource;
    logger?: Logger;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  if (event.type !== "model_request_completed" && event.type !== "model_request_failed") return;
  const store = options.requestObservations;
  if (!store) return;
  // take 即删除：同一批观测只能投递一次。
  // 没有 statusSink 时也要 take 掉，避免内存里长期滞留。
  // 单条观测失败只 warn，后续观测继续投递。
  const observations = store.take(event.requestId);
  if (observations.length === 0 || !options.statusSink) return;
  for (const observation of observations) {
    const observationEvent: ModelRequestObservationStatusEvent = {
      ...event,
      observation,
      type: "model_request_observation",
    };
    try {
      await options.statusSink.publish(observationEvent);
    } catch (error) {
      options.logger?.warn("Model request observation sink failed", {
        ...modelStatusLogContext(event),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "model.request_observation.sink_failed",
        status: "failed",
      });
    }
  }
}

/**
 * Provider 流式里程碑只发给进程级 Telemetry Sink，不写 SessionEvent。
 * requestStatusSink 属于对话产品状态，不能被纯观测事件污染。
 */
export async function publishModelTelemetryMilestone(
  event: Extract<
    ModelNetworkStatusEvent,
    {
      type: "model_first_provider_event" | "model_first_content" | "model_first_text";
    }
  >,
  options: {
    logger?: Logger;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  logStatusEvent(event, options.logger);
  if (!options.statusSink) return;
  try {
    await options.statusSink.publish(event);
  } catch (error) {
    options.logger?.warn("Model telemetry milestone sink failed", {
      ...modelStatusLogContext(event),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "model.telemetry_milestone.failed",
      status: "failed",
    });
  }
}

/**
 * 把状态上下文压成日志字段；maxRetries 由 maxAttempts 推导，无上限时保持 0 语义。
 * 输出：扁平 Record，供 logger 直接展开。
 */
export function modelStatusContextToLogContext(
  statusContext: ModelStatusContext | ModelNetworkStatusEvent,
  attempt: number,
): Record<string, unknown> {
  return {
    attempt,
    baseURL: statusContext.baseURL,
    maxAttempts: statusContext.maxAttempts,
    // maxAttempts 为 0 表示无上限：maxRetries 同样以 0 表达，而不是 max(0, -1) 巧合得到的 0。
    maxRetries:
      statusContext.maxAttempts === UNBOUNDED_RETRY_MAX_ATTEMPTS
        ? UNBOUNDED_RETRY_MAX_ATTEMPTS
        : Math.max(0, statusContext.maxAttempts - 1),
    modelId: statusContext.modelId,
    parentSpanId: statusContext.parentSpanId,
    providerId: statusContext.providerId,
    providerKind: statusContext.providerKind,
    queryId: statusContext.queryId,
    querySource: statusContext.querySource,
    requestId: statusContext.requestId,
    sessionId: statusContext.sessionId,
    spanId: statusContext.spanId,
    traceId: statusContext.traceId,
    transport: statusContext.transport,
    turnId: statusContext.turnId,
  };
}

/** 用事件自身携带的 attempt 生成日志上下文（日志与事件口径保持一致）。 */
function modelStatusLogContext(event: ModelNetworkStatusEvent): Record<string, unknown> {
  return modelStatusContextToLogContext(event, event.attempt);
}

/**
 * 按事件类型选择日志级别与字段：排队/准入/开始/里程碑为 debug，
 * 完成为 info，重试/失败/流停滞为 warn；observation 事件不重复记录（fetch 层已写）。
 */
function logStatusEvent(event: ModelNetworkStatusEvent, logger?: Logger): void {
  switch (event.type) {
    case "model_request_queued":
      logger?.debug("Model request queued for admission", {
        ...modelStatusLogContext(event),
        event: "model.request.queued",
        status: "waiting",
      });
      return;

    case "model_request_admitted":
      logger?.debug("Model request admitted", {
        ...modelStatusLogContext(event),
        event: "model.request.admitted",
        queuedMs: event.queuedMs,
        status: "started",
      });
      return;

    case "model_request_started":
      logger?.debug("Model request attempt started", {
        ...modelStatusLogContext(event),
        event: "model.request.started",
        status: "started",
      });
      return;

    case "model_request_completed":
      logger?.info("Model request completed", {
        ...modelStatusLogContext(event),
        durationMs: event.durationMs,
        event: "model.request.completed",
        finishReason: event.finishReason,
        status: "completed",
      });
      return;

    case "model_retry_scheduled":
      logger?.warn("Model request retry scheduled", {
        ...modelStatusLogContext(event),
        delayMs: event.delayMs,
        event: "model.retry.scheduled",
        nextAttempt: event.nextAttempt,
        reason: event.reason,
        status: "waiting",
        statusCode: event.statusCode,
        statusMessage: event.message,
      });
      return;

    case "model_request_failed":
      logger?.warn("Model request attempt failed", {
        ...modelStatusLogContext(event),
        durationMs: event.durationMs,
        event: "model.request.failed",
        reason: event.reason,
        retryable: event.retryable,
        status: event.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
        statusCode: event.statusCode,
        statusMessage: event.message,
      });
      return;

    case "model_stream_stalled":
      logger?.warn("Model stream stalled", {
        ...modelStatusLogContext(event),
        event: "model.stream.stalled",
        idleMs: event.idleMs,
        status: "waiting",
        statusMessage: event.message,
        timeoutMs: event.timeoutMs,
      });
      return;

    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
      logger?.debug("Model telemetry milestone observed", {
        ...modelStatusLogContext(event),
        elapsedMs: event.elapsedMs,
        event: event.type,
        status: "completed",
      });
      return;

    case "model_request_observation":
      // fetch 层已即时写入本地日志，这里只负责 telemetry 投递。
      return;
  }
}
