import type { ModelToolReferenceContentBlock } from "../tools/tool-search.js";
// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type {
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolPermissionSpec,
  ToolResultBudget,
} from "../tools/contract.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelApiCallObservation,
  ModelApiErrorPhase,
  ResolvedModelApiCallObservation,
} from "../telemetry/index.js";

export * from "./image-media.js";
export * from "./model.js";
export * from "./invocation-context.js";

/**
 * 工具输入/输出的 JSON Schema 别名：只声明“可运行时校验的结构”，不绑定具体校验库。
 *
 * 生产者：工具定义与模型请求的 responseJsonSchema。
 * 消费者：adapter 转成 provider 的 function schema；tool runtime 在调用前校验入参。
 * 不变量：必须保持纯 JSON 可序列化（无函数/类实例/undefined 语义），
 * 因为它会跨模型请求、持久化与进程边界传递。
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Provider 身份的稳定标识（branded string），与展示名、配置键严格区分。
 *
 * 生产者：`createModelProviderId` 或模型注册表解析后的 providerId。
 * 消费者：配额键、用量主键、缓存与日志归因；跨进程时按字符串持久化。
 * 不变量：必须是 trim 后的非空稳定 ID，不得写入人类可读名称或临时展示文案；
 * brand 只防止类型层面混用，运行时不额外校验。
 */
export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };
/**
 * 模型身份的稳定标识（branded string），与 displayName 严格区分。
 *
 * 生产者：`createModelId` 或模型注册表解析结果。
 * 消费者：请求路由、用量主键、缓存键与遥测归因。
 * 不变量：trim 后非空；同一 provider 下用于唯一寻址，禁止用显示名或别名替代，
 * 也禁止在重试/回退中悄悄改写该值（回退必须走 Selection 变更事件）。
 */
export type ModelId = string & { readonly __brand: "ModelId" };

/**
 * 模型请求的宿主 session 粗分类，仅用于归因 header 与统计，不改变请求内容。
 *
 * 生产者：runtime 的 `resolveModelRequestSessionType` 按 taskType 决定。
 * 消费者：adapter 写入受控 header；遥测按 main/other/side_chat/subagent 聚合。
 * 不变量：workflow child 归 `other`（它不是 subagent）；该值 runtime-only，
 * 不进 JSON schema，也不允许调用方通过 provider 静态 headers 覆盖。
 */
export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  SideChat: "side_chat",
  Subagent: "subagent",
} as const;

/**
 * 模型请求的重试预算档位（runtime-only）。
 * - `default`：adapter 构造时解析出的 maxAttempts（默认 10 次重试）。
 * - `unbounded`：**瞬态**失败无上限重试（退避曲线不变、封顶 60s 后无限探测），永久失败照旧立即抛。
 *   给 workflow actor（taskType workflow_child / nested_workflow_child）使用：模型错误绝不是
 *   workflow 错误，唯一出口是用户 cancel。
 * - `single-attempt`：本次请求 maxAttempts 收敛为 1，瞬态失败也不重试、首次失败即上抛。
 *   给带 selectionFallback 声明的执行作用域 Selection（如 Highspeed 加速卡）使用：失败后由 core
 *   退回会话模型继续本轮，适配层再按默认 10 次退避重试只会把降级拖到数分钟之后。
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
  SingleAttempt: "single-attempt",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * 一次模型请求尝试的准入票据（runtime-only）。
 *
 * 它同时是**这一次尝试**的状态事件汇：runner 把该尝试的 ModelNetworkStatus 事件
 * （`model_request_started` / `model_request_completed` / `model_request_failed` /
 * `model_retry_scheduled`）原样也投递给它，治理器据此判定这次请求的结果（成功 / 限流 / 瞬态失败 /
 * 终结），不需要 runner 在每个失败分支上另写一遍结果。`release()` 是兜底：尝试无论如何结束（成功、
 * 抛出、消费者提前放弃流）runner 都在 finally 里调一次；未见终结事件即按终结处理。**幂等**。
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * 模型请求的准入端口（runtime-only）。runner 在**每一次尝试发出前**先试同步快路径
 * `tryAcquire`，未命中再 `acquire` 排队；拿到票据后才发请求；尝试结束即 `release`，退避 sleep 期间
 * 不持票——所以进程级并发 cap 约束的是 provider 真正看到的在飞请求数。`signal` 被 abort 时
 * `acquire` 以 `signal.reason` reject。
 *
 * `tryAcquire` 未命中是 runner 发 `model_request_queued` / `model_request_admitted` 的唯一依据
 * 没有快路径的实现 runner 无法分辨「排了队」与「立即放行」，一律不发这两条事件。
 *
 * 端口绑定在 runtime 的模型工厂上：runtime 交出的每一个模型句柄——turn step、工具内部
 * 的模型调用、压缩、标题 sidecar——都带它；缺席即不设闸门（runner 行为逐字不变）。主代理拿的是
 * 治理器的 observer 实现：`tryAcquire` 总命中、只喂信号。
 */
export interface ModelRequestAdmission {
  /** 同步快路径：闸门开着且无人排队即给票；否则 undefined，runner 转 `acquire` 并报排队。 */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
}

/**
 * 准入端口看到的模型身份：配额键的最小事实。既不是 Selection（那是执行意图），也不是
 * Active Model（那带完整配置）——treaty 只要 provider/model 两段。
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

/**
 * `ModelRequestSessionType` 的取值联合：四个稳定字符串，供运行时比较与 header 取值。
 *
 * 生产者：常量对象；消费方只能读取其中之一。
 * 消费者：adapter 归因 header、用量表按 session 类型的聚合。
 * 不变量：与常量对象严格同步；新增取值需同时评估 header 兼容性与统计口径。
 */
export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

/**
 * 模型协议错误码：跨层判断失败的稳定枚举，错误文案不参与流程裁决。
 *
 * 生产者：contracts 的构造/校验函数与 adapter 的请求、响应、流式错误归一化。
 * 消费者：core 的错误分类（是否重试/是否 compact/是否提示用户）、用量表 errorCode、
 * 遥测 error category 映射。
 * 不变量：新增码必须同时补 adapter 分类与 UI 文案；稳定的 code 可持久化，
 * 但 message 只是人读，不能凭文本判断错误类型。
 */
export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

/**
 * Provider 传输协议类别：用于状态事件标注与诊断，不决定请求内容。
 *
 * 生产者：adapter 按实际使用的 SDK 传输方式填写（http/sse/websocket）。
 * 消费者：网络状态事件、遥测与重试分析（不同传输的失败/停顿语义不同）。
 * 不变量：这是观测事实而非配置；同一模型在不同 provider 上可能不同，
 * 不能用来推断能力或选择协议。
 */
export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

/**
 * 可重试的失败原因：adapter 的 runner 据此选择退避并决定是否继续尝试。
 *
 * 生产者：adapter 的 failure classifier（按 status/错误码/流状态归一）。
 * 消费者：runner 的重试预算、`model_retry_scheduled` 事件与用量表 retry 统计。
 * 不变量：只有“原样重试可能成功”的原因才列入；`reasoning_signature_repair` 是
 * 清理请求副本后立即重试一次的特例，`offpeak_queued` 豁免重试预算但仅限闲时 provider。
 * 不在本集合内的失败必须走 `ModelFailureReason` 的终结分支。
 */
export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
  /** off-peak 闲时排队（429/3105+Retry-After）：豁免重试预算、无限探测（仅 idle plan provider）。 */
  OffpeakQueued: "offpeak_queued",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

/**
 * 模型失败的完整原因域：重试原因 + 终结原因，供状态事件与错误分类统一使用。
 *
 * 生产者：adapter 的失败归一化（一次失败只会得到一个 reason）。
 * 消费者：core 的 turn 错误处理、UI 提示、遥测 error category、用量表 errorCode。
 * 不变量：重试原因通过展开并入本集合，因此名称必须保持互斥；
 * 终结原因（auth/cancelled/context_exceeded/invalid_request 等）不得被 runner
 * 当作可重试；`unknown` 是显式兜底而不是省略字段。
 */
export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

/**
 * 所有模型网络状态事件的公共字段：一次物理请求在网络层的可观测事实。
 *
 * 生产者：adapter 的 runner/transport 在开始、排队、完成、失败、重试、流停顿时构造。
 * 消费者：runtime 的 statusSink（UI 进度、治理器判定、用量旁路）、遥测 span writer。
 * 不变量：requestId 标识一次物理请求（重试会换新值）；attempt 从 1 递增；
 * traceId/sessionId/turnId 只是归因引用，不能由事件决定业务归属；
 * 这些事件是可观测旁路，不得改变请求结果（投递失败最多丢弃）。
 */
interface ModelNetworkStatusBase {
  /** 事件发生时刻的 ISO 时间串，由产生事件的一侧写入。 */
  timestamp: string;
  /** 顶层 trace；跨重试/跨进程都必须保持一致。 */
  traceId: TraceId;
  /** 触发本次请求的查询 ID；同一次用户输入派生的请求共享。 */
  queryId?: QueryId;
  /** 当前 session；子 session 会带 parentSessionId 指回父级。 */
  sessionId?: SessionId;
  /** 当前轮次；缺失表示尚未绑定到具体 turn。 */
  turnId?: TurnId;
  /** 子 session/subagent 的父会话引用；没有层级时缺省。 */
  parentSessionId?: SessionId;
  /** 若请求由工具内部发起，指向触发它的工具调用。 */
  toolCallId?: string;
  /** 当前 span 与父 span；用于在 trace 内还原事件所属工作单元。 */
  spanId?: string;
  parentSpanId?: string;
  /** 调用点自报的查询来源（如 main_turn/compact）；遥测据此映射 operation。 */
  querySource?: string;
  /** 单次物理请求 ID；重试/回退各产生新值，不与 logicalCallId 混用。 */
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  /** 脱敏后的 endpoint 基址；禁止包含密钥或完整查询参数。 */
  baseURL?: string;
  /** provider 实现类别（如 anthropic/openai-compatible），用于诊断而非路由。 */
  providerKind?: string;
  transport: ModelTransportKind;
  /** 本次物理请求的序号（从 1 开始）。 */
  attempt: number;
  /**
   * 本次请求的重试预算总尝试数（含首次）。**`0` = 无上限**（`ModelRetryBudget.Unbounded`）：`Infinity` 不可序列化，而 0 不占用任何既有合法值。
   * 消费方渲染「第 n/N 次」或推导 maxRetries 时必须特判 0。
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

/**
 * 流恢复的归因事实：描述一次请求是第几次恢复、从哪个断点续接。
 *
 * 生产者：adapter 的 stream recovery 流程在检测断流并重建请求后写入。
 * 消费者：状态事件、用量表与遥测 span，用于区分“首次请求”和“恢复请求”。
 * 不变量：attemptId 标识恢复尝试、retryNumber/maxRetries 描述恢复预算；
 * recoveredFromRequestId/anchorId 只作关联，不保证对端日志仍存在。
 */
export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

/**
 * `model_request_started`：一次物理请求已真正发出（过闸后、发出前）。
 *
 * 生产者：runner 在准入通过并完成请求构造后发布。
 * 消费者：UI 进度、用量旁路（作为一次请求的起点）、遥测 attempt span 开始。
 * 不变量：同一 requestId 至多一条 started；排队/准入事件可能在其之前出现，
 * 不能把 started 当作“第一次事件”。
 */
export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * 准入等待的两端：runner 的 `tryAcquire` 未命中
 * 即发 `queued`，拿到票即发 `admitted`（带排队时长）。它们是 runtime 观测——driver 据此报「等待槽位」，
 * 工具执行器据此暂停工具超时——不进 provider 请求；协议侧凡枚举状态类型的消费方显式忽略。
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

/**
 * `model_request_admitted`：请求从等待队列拿到准入票据，即将开始。
 *
 * 生产者：runner 在 `acquire` 完成后、发出请求之前发布（快路径 tryAcquire 命中不发）。
 * 消费者：UI 等待态收尾、工具执行器恢复超时计时、遥测排队时长分解。
 * 不变量：queuedMs 是从排队到放行的实测毫秒（单调时钟），只用于观测；
 * 没有 `model_request_queued` 配合时仍可单独出现（快路径不报排队）。
 */
export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  /** 排队等待时长（毫秒）；不含请求本身的耗时。 */
  queuedMs: number;
}

/**
 * `model_request_completed`：请求成功结束，带终态与用量。
 *
 * 生产者：runner 在 provider 流正常结束、拿到 finishReason 与 usage 后发布。
 * 消费者：UI 收尾、用量旁路（权威结果优先于此事件）、遥测 attempt span 收尾。
 * 不变量：`usage` 缺失表示 provider 未返回用量，不能用本地估算伪造；
 * 各 timeToFirst* 是同一请求内的分段里程碑，不能跨请求比较；
 * streamOutputCommitted 表示是否已把部分输出交给消费者（决定能否安全重试）。
 */
export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  /** 本次物理请求从发出到结束的墙钟耗时（毫秒），含流式消费。 */
  durationMs: number;
  /** provider 返回的结束原因原值；不在领域层折叠成 other。 */
  finishReason?: string;
  /** provider 权威用量；缺失即表示 provider 没给，不能补估算值。 */
  usage?: ModelUsage;
  /** provider 侧请求 ID，用于和服务端日志对齐；不是本地 requestId。 */
  providerRequestId?: string;
  /** 从发出到收到首个 provider 事件的毫秒数。 */
  timeToFirstProviderEventMs?: number;
  /** 从发出到首个内容块（文本/推理/工具输入任一）的毫秒数。 */
  timeToFirstContentMs?: number;
  /** 从发出到首个文本增量的毫秒数；用于 TTFT 口径。 */
  timeToFirstTextMs?: number;
  /** 流式期间观测到的最大 idle 间隔（毫秒）。 */
  streamMaxIdleMs?: number;
  /** 流停顿次数；与 maxIdle 一起判断链路稳定性。 */
  streamStallCount?: number;
  /** 是否已把部分输出提交给消费者；提交后重试会造成重复输出。 */
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  /** Provider 已报告的失败请求用量；不为失败响应伪造成功完成事件。 */
  usage?: ModelUsage;
  /** 本次失败 attempt 的耗时；未知时缺省（如连接前即失败）。 */
  durationMs?: number;
  /** 归一化后的失败原因；决定是否可重试与用户提示类别。 */
  reason: ModelFailureReason;
  /** runner 的判定结果；与 reason 一致，供消费方直接使用而不必重算。 */
  retryable: boolean;
  /** 面向诊断的错误摘要；不得包含凭据、完整 body 或用户内容。 */
  message: string;
  /** provider HTTP 状态码（如有）。 */
  statusCode?: number;
  /** 契约错误码；与 reason 互补，用于稳定分类。 */
  errorCode?: ModelErrorCode;
  /** provider 业务错误码原值，便于对账。 */
  providerErrorCode?: string;
  /** provider 业务错误消息原值；仅诊断，可能含服务端文案。 */
  providerErrorMessage?: string;
  /** provider 侧请求 ID。 */
  providerRequestId?: string;
  /** 服务端建议的等待时长（毫秒）。 */
  retryAfterMs?: number;
  /** 失败发生在请求生命周期的哪个阶段；阶段决定能否安全重试。 */
  errorPhase?: ModelApiErrorPhase;
  /** 原始异常类型名（如 AbortError）；只用于聚合分析。 */
  exceptionType?: string;
  /** 是否已提交部分输出；已提交时降级/重试需由上层决定是否续写。 */
  streamOutputCommitted?: boolean;
}

/**
 * `model_retry_scheduled`：一次失败已判定可重试，runner 已排定下一次尝试。
 *
 * 生产者：runner 在选定退避时长后、sleep 之前发布。
 * 消费者：UI 倒计时、用量表 retry 次数、遥测 attempt span 收尾与下一个 attempt 开始。
 * 不变量：nextAttempt 必须等于当前 attempt + 1；delayMs 是实际等待时长；
 * 该事件不是终结事件——随后必须出现 started 或 failed（或被取消）。
 */
export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  /** 本次退避等待时长（毫秒）。 */
  delayMs: number;
  /** 下一次尝试的序号（从 1 起，且严格大于当前 attempt）。 */
  nextAttempt: number;
  /** 触发重试的原因，取值为可重试原因域。 */
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  /** 服务端建议等待时长；实际 delayMs 可能已据此调整。 */
  retryAfterMs?: number;
}

/**
 * `model_stream_stalled`：流式响应长时间无新事件，已触发 idle 保护。
 *
 * 生产者：transport 的 idle 计时器在超过 timeoutMs 仍未收到事件时发布。
 * 消费者：UI 状态提示、遥测停顿计数、重试分析。
 * 不变量：idleMs 必须在 timeoutMs 之上；该事件描述观察结果，是否中断
 * 流由 runner 的后续决策（失败/恢复）表达，不能只凭本事件判定请求结束。
 */
export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  /** 已观测到的连续空闲时长（毫秒）。 */
  idleMs: number;
  /** 本次生效的 idle 超时阈值（毫秒），随重试递增。 */
  timeoutMs: number;
  message: string;
}

/**
 * 仅供实时观测 Sink 消费的 Provider 里程碑。它们不进入 SessionEvent/回放协议，
 * 避免为了 Trace 事件扩大产品状态面。
 */
export interface ModelTelemetryMilestoneStatusEvent extends ModelNetworkStatusBase {
  type: "model_first_provider_event" | "model_first_content" | "model_first_text";
  elapsedMs: number;
}

/** 仅投递进程内 telemetry statusSink，不进入请求 UI 事件；字段不得携带凭据或用户内容。 */
export type ModelRequestObservation = Readonly<{
  kind: string;
  [field: string]: string | number | boolean | undefined;
}>;

/**
 * `model_request_observation`：adapter 捕获的受控键值观测，仅进程内投递。
 *
 * 生产者：transport/runner 的 `recordRequestObservation`（如 header 数量、协议分支）。
 * 消费者：进程级 telemetry statusSink；不进入 SessionEvent、UI 或回放。
 * 不变量：observation 字段只能放标量且不含凭据/用户内容；kind 是稳定分类名，
 * 观测事件与业务状态事件共用同一 base，便于按 requestId 归并。
 */
export interface ModelRequestObservationStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_observation";
  observation: ModelRequestObservation;
}

/**
 * 模型网络状态事件全集：adapter 在请求生命周期中可能投递的所有类型。
 *
 * 生产者：adapter 的 runner/transport，通过 `ModelStatusSink.publish` 投递。
 * 消费者：runtime 的状态投影、治理器、用量旁路与遥测；协议侧消费方必须
 * 显式忽略它不认识的新类型，而不是崩溃。
 * 不变量：discriminated union 由 `type` 收窄；同一 requestId 的事件顺序是
 * queued/admitted → started → (stalled/observation/retry_scheduled)* → completed|failed。
 */
export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestObservationStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent
  | ModelTelemetryMilestoneStatusEvent;

/**
 * 状态事件出口：runtime/adapter 通过它把模型请求的实时状态投给上层。
 *
 * 生产者：adapter 的 runner 在生命周期节点调用 publish；transport 捕获到
 * 无法归一化的异常时可走 publishFailure 交给进程级观测。
 * 消费者：runtime 的 statusSink 实现（UI 投影、治理器判定、用量旁路）。
 * 不变量：publish 允许返回 Promise，但调用方不得因其失败改变请求结果；
 * publishFailure 是旁路通道，原始异常不得进入持久化领域状态。
 */
export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
  /**
   * Transport 捕获失败时可把原始异常直接交给进程级观测 Sink。产品 SessionEvent/日志仍只消费
   * publish(event)，避免原始异常对象和消息正文进入持久化领域状态。
   */
  publishFailure?(event: ModelRequestFailedStatusEvent, error: unknown): void | Promise<void>;
}

/**
 * 模型协议错误：把 adapter/契约校验的失败统一成稳定 code + 人读 message + 上下文。
 *
 * 生产者：contracts 的 id 构造/校验与 adapter 的请求响应归一化。
 * 消费者：core 的 isModel* 错误判断、失败分类、UI 提示与遥测。
 * 不变量：流程只读 `code`，不解析 message；context 是可序列化的诊断补充，
 * 不得放凭据、完整请求体或用户正文；跨进程持久化时只保留 code/message。
 */
export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}

/**
 * 构造 Provider 稳定标识：trim 后必须非空，否则抛 InvalidModelSelection。
 *
 * 生产者：模型注册表、配置解析与测试夹具。
 * 消费者：Model 句柄、用量主键、配额键与遥测。
 * 不变量：只做 trim 与空值拒绝，不做大小写折叠或别名归一——这些属于配置层；
 * 传入显示名不会被拦截，调用方必须保证语义正确。
 */
export function createModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelSelection,
      "Model provider id is empty",
    );
  }
  return normalized as ModelProviderId;
}

/**
 * 构造模型稳定标识：trim 后必须非空，否则抛 InvalidModelSelection。
 *
 * 生产者：模型注册表/Active Model 工厂。
 * 消费者：请求路由、Selection、用量主键与遥测。
 * 不变量：与 providerId 一样只做 trim/空值校验；不得传入 displayName 或
 * 带推理档位的 Picker 字符串（例如 `model$high`），档位属于 Selection.options。
 */
export function createModelId(modelId: string): ModelId {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(ModelErrorCode.InvalidModelSelection, "Model id is empty");
  }
  return normalized as ModelId;
}

/**
 * 消息角色：system 指令、user 输入、assistant 输出、tool 结果回填。
 *
 * 生产者：core 构造 turn 消息、compact/标题等旁路消息。
 * 消费者：adapter 映射为 provider role；消息持久化与 UI 回放。
 * 不变量：tool 角色必须带 toolCallId 对应 assistant 的 toolCalls；角色本身
 * 不携带 provider 差异，档位/缓存等语义由其它字段表达。
 */
export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * assistant 发起的一次工具调用（归一化后），id 是模型给出的调用标识。
 *
 * 生产者：adapter 从 provider tool-call part 归一化；流式 tool_input_end/tool_call。
 * 消费者：tool runtime 执行、结果回填消息、工具轨迹与归属遥测。
 * 字段口径：input 是未经工具 Schema 校验的 JSON 值（由 inputSchema 校验）；
 * providerExecuted 表示 provider 侧已执行（server tool），本地不得重复执行，
 * 也不能把该标志当作授权依据。
 * 不变量：id 必须在同一 assistant 消息内唯一，并与回填的 toolCallId 对齐。
 */
export interface ModelToolCall {
  /** provider 给出的调用 ID；回填 tool 结果时必须原样使用。 */
  id: string;
  /** 注册工具名；runtime 按名称路由，不按显示名或别名。 */
  name: string;
  /** 原始 JSON 入参，校验前可能非法，不得直接信任。 */
  input: unknown;
  /** true 表示 provider 已执行，本地只消费结果，不再调度工具。 */
  providerExecuted?: boolean;
}

/**
 * 附件引用来源分类：决定 uri/path 字段的可信语义与可重放性。
 *
 * 生产者：附件收集层（本地文件、资源链接、内联数据）。
 * 消费者：内容块的 `source`、transcript 占位文本与 UI 展示。
 * 不变量：只有 local_file 应带 path，resource 应带 uri；inline 不能被当作
 * 可跨进程重放的本地文件。
 */
export type AttachmentKind = "local_file" | "resource" | "inline";

/**
 * 附件的轻量引用：只保存元数据与内容指纹，不承载正文。
 *
 * 生产者：附件收集/去重层；作为 image/file/video 内容块的 `source` 附带。
 * 消费者：占位文本、transcript 渲染、去重/缓存与审计。
 * 不变量：正文只存在于内容块的 dataUrl/text；sha256 相同视为同一内容；
 * placeholder 只是展示兜底，不能替代真实文件名参与路由。
 */
export interface AttachmentRef {
  /** 会话内附件 ID，用于去重与引用，不是路径。 */
  id: string;
  /** 来源分类，决定 uri/path 的语义。 */
  kind: AttachmentKind;
  /** resource 类附件的逻辑地址（如 mcp://、resource link），不是本地路径。 */
  uri?: string;
  /** local_file 的本地路径；跨机器或持久化后可能失效，不能作为长期主键。 */
  path?: string;
  /** 声明的 MIME；与内容块 mediaType 冲突时以内容块为准。 */
  mimeType?: string;
  /** 原始字节数，用于预算与展示；转码/压缩后不代表新大小。 */
  sizeBytes?: number;
  /** 内容指纹，用于去重与缓存判定，不用于安全校验。 */
  sha256?: string;
  /** UI/transcript 占位名（可能是截断后的文件名），不参与协议语义。 */
  placeholder?: string;
}

/**
 * 纯文本内容块：assistant 输出与 user/system 文本的统一载体。
 *
 * 生产者：adapter 归一化文本流；core 构造提示词。
 * 消费者：provider 请求、transcript 渲染与标题/compact 文本提取。
 * 不变量：text 已是最终文本，不再省略或二次转义。
 */
export interface ModelTextContentBlock {
  type: "text";
  text: string;
}

/**
 * 推理（thinking）内容块：仅供历史回放/调试，不参与常规文本提取。
 *
 * 生产者：adapter 从 reasoning 流归一化。
 * 消费者：请求消息重建（若 provider 支持）、transcript 展示。
 * 不变量：providerOptions 是 provider 私有元数据，不保证跨 provider 可读；
 * 普通文本提取会丢弃推理块。
 */
export interface ModelReasoningContentBlock {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, unknown>;
}

/**
 * 图片输入内容块：以 data URL 承载 base64，附 mediaType 与可选 detail 档位。
 *
 * 生产者：附件处理层把图片转 data URL 后注入消息。
 * 消费者：adapter 映射为 provider image part；媒体策略据此判断可见性。
 * 不变量：dataUrl 必须自包含（不得引用远程临时 URL）；detail 只表达质量偏好，
 * 不改变是否发送；source 是元数据引用，不参与解码。
 */
export interface ModelImageContentBlock {
  type: "image";
  mediaType: string;
  dataUrl: string;
  /** 图片质量偏好；provider 可能忽略，不代表预算承诺。 */
  detail?: "auto" | "low" | "high" | "original";
  source?: AttachmentRef;
}

/**
 * 文件输入内容块：可带文本正文，也可带 uri/dataUrl 让 provider 自行读取。
 *
 * 生产者：附件处理层；PDF/文档提取后填 text 或保留 dataUrl。
 * 消费者：media-policy 判定是否 provider-visible；adapter 映射 file part。
 * 不变量：text 非空表示已提取成文本，不再重复发送二进制；uri 不等于本地路径。
 */
export interface ModelFileContentBlock {
  type: "file";
  mediaType: string;
  name?: string;
  uri?: string;
  dataUrl?: string;
  text?: string;
  source?: AttachmentRef;
}

/**
 * 视频输入内容块（provider-neutral，与 image 同构，只承载 base64 dataUrl）。
 *
 * 生产者：附件处理层对视频做内联编码后注入。
 * 消费者：media-policy 判定 provider 是否支持视频；adapter 映射 video part。
 * 不变量：必须是自包含 dataUrl；不支持视频的模型由调用方先降级，不能硬塞给 provider。
 */
/** 视频输入内容块（provider-neutral，与 image 同构；只承载 base64 dataUrl）。 */
export interface ModelVideoContentBlock {
  type: "video";
  mediaType: string;
  dataUrl: string;
  source?: AttachmentRef;
}

/**
 * 资源链接内容块：只传 URI 与标题，不内联正文；由 provider/工具侧解析。
 *
 * 生产者：MCP resource link、工具产出的引用。
 * 消费者：转成纯文本占位或 provider 的 resource_link part。
 * 不变量：uri 是逻辑地址，可能对当前进程不可直接读取。
 */
export interface ModelResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  title?: string;
}

/**
 * 消息内容块判别联合：所有 provider 无关的内容形态都在这里收口。
 *
 * 生产者：adapter 归一化、附件处理层与工具引用注入。
 * 消费者：`modelMessageContentToText`、JSON Schema 校验、provider 映射。
 * 不变量：新增块类型必须同时更新联合、文本提取与 JSON Schema，否则持久化
 * 或回放会静默丢字段。
 */
export type ModelMessageContentBlock =
  | ModelToolReferenceContentBlock
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelImageContentBlock
  | ModelVideoContentBlock
  | ModelFileContentBlock
  | ModelResourceLinkContentBlock;

/**
 * 消息内容：字符串便捷形态或块数组的完整形态。
 *
 * 生产者：core 构造消息时二选一；持久化统一展开为块数组。
 * 消费者：adapter 请求映射与文本提取。
 * 不变量：字符串等价于单个 text 块；两种形态不得同时表达同一段内容。
 */
export type ModelMessageContent = string | ModelMessageContentBlock[];

/**
 * 提示词缓存控制（Anthropic 风格 ephemeral cache）：只是提示，不是预算承诺。
 *
 * 生产者：core 在长 system/上下文边界上标注，期望复用前缀。
 * 消费者：支持缓存的 adapter 映射为 provider 缓存标记，其余 provider 忽略。
 * 不变量：ttl/scope 是 provider 能力面，缺失表示由 adapter 决定；缓存标记
 * 不改变消息内容本身，缓存命中与否也不得影响业务正确性。
 */
export interface ModelCacheControl {
  type: "ephemeral";
  /** 缓存存活期；缺省由 provider 默认策略决定。 */
  ttl?: "5m" | "1h";
  /** 缓存作用域；缺省为 provider 默认（通常按组织/会话）。 */
  scope?: "global" | "org";
}

/**
 * 一条归一化输入消息：角色 + 内容，可携带工具调用/结果与缓存提示。
 *
 * 生产者：core 的 turn/compact/title 构造；adapter 回填 tool 结果。
 * 消费者：provider 请求映射、transcript 持久化与 UI 回放。
 * 字段口径：assistant 消息可带 toolCalls；tool 消息必须带 toolCallId/toolName
 * 并用 isError 标记失败结果。providerId/modelId 仅表示产生该消息的模型来源，
 * 不用于当前请求路由。
 * 不变量：消息顺序即 provider 看到的顺序；不得在重试中静默改写历史消息。
 */
export interface ModelInputMessage {
  role: ModelMessageRole;
  content: ModelMessageContent;
  /** 前缀缓存提示；只在支持缓存的 provider 生效。 */
  cacheControl?: ModelCacheControl;
  /** assistant 发起的工具调用列表；与后续 tool 消息通过 id 关联。 */
  toolCalls?: ModelToolCall[];
  /** tool 角色消息回填的调用 ID，必须与某个 toolCalls.id 对应。 */
  toolCallId?: string;
  /** tool 角色消息的工具名，用于 UI 与遥测归因，不用于重新路由。 */
  toolName?: string;
  /** 该工具结果是否为失败；只影响展示/重试判断，不改变结果正文。 */
  isError?: boolean;
  /** 产生该消息的 provider 标识（来源归因），不是当前请求目标。 */
  providerId?: ModelProviderId;
  /** 产生该消息的模型标识（来源归因），不是当前请求目标。 */
  modelId?: ModelId;
}

/**
 * 把任意消息内容压平成纯文本：用于日志、标题、compact 兜底与占位展示。
 *
 * 生产者：不需要结构化内容的消费方调用。
 * 消费者：标题/摘要生成、错误信息与调试输出；不得据此重建 provider 请求。
 * 不变量：推理块被丢弃，图片/视频/文件退化为占位符，多块以空行连接；
 * 该函数不读取 dataUrl 正文，也不做截断。
 */
export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

/**
 * 单个内容块的文本投影：只输出对“纯文本消费方”有意义的部分。
 *
 * 生产者：`modelMessageContentToText` 逐块调用。
 * 消费者：标题/摘要、错误提示与 transcript 兜底文本。
 * 分支口径：reasoning 返回空串（不把思考内容泄漏到普通文本）；text/tool_reference
 * 原样；image/video 一律占位；file 优先用已提取 text，否则占位；resource_link
 * 输出标题或 URI。
 * 不变量：不得返回 dataUrl/base64；不得因块类型未知而抛错。
 */
export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "tool_reference":
      return block.toolName;
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
  }
}

/**
 * 生成附件占位文本：`[Attached <mime>: <name>]`，name 为空时省略后半段。
 *
 * 生产者：内容块文本投影（图片/视频/二进制文件）。
 * 消费者：UI/transcript 与纯文本上下文；不进入 provider 请求正文。
 * 不变量：只使用展示名，不得把 dataUrl 或本地绝对路径拼进来。
 */
function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}

/**
 * 工具执行时回传给工具实现的单次调用上下文（runtime-only，不序列化）。
 *
 * 生产者：tool runtime 在调度本地工具时构造。
 * 消费者：工具实现的 execute；用于取消、追踪与按调用归因。
 * 不变量：abortSignal 必须向下透传（turn 取消应能中断工具）；traceId 仅用于
 * 归因，不能当作鉴权凭据；metadata 是进程内扩展位，不能承诺跨进程/持久化。
 */
export interface ModelToolExecutionContext {
  /** 本次调用 ID，与 ModelToolCall.id 一致，用于结果回填与遥测关联。 */
  toolCallId: string;
  /** 取消信号；turn 中止时必须触发，长任务需自行检查。 */
  abortSignal?: AbortSignal;
  /** 追踪 ID，仅用于日志/遥测归属，不是访问令牌。 */
  traceId?: string;
  /** 进程内扩展元数据；不得放置需要持久化的业务状态。 */
  metadata?: Record<string, unknown>;
}

/**
 * 工具副作用范围声明：用于审批、并发与只读策略的粗分类。
 *
 * 生产者：工具定义（ToolContractDeclaration 投影）。
 * 消费者：权限/审批判定、并发调度、UI 风险提示与遥测。
 * 不变量：这是“声明”而非运行时证明；scope 越宽不代表自动授予权限，
 * 具体权限仍由 permission/needsApproval 与运行时策略决定。
 */
export type ModelToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

/**
 * 暴露给模型与 adapter 的工具契约：Schema、能力声明与执行入口的边界。
 *
 * 生产者：工具注册表按当前会话/策略过滤后投影；core 把契约放进请求的 tools。
 * 消费者：adapter 转成 provider function/native tool；tool runtime 校验入参并执行。
 * 能力边界：inputSchema/outputSchema 是可跨进程的 JSON Schema，决定模型可见的
 * 参数面；readOnly/destructive/concurrentSafe/requiresUserInteraction 只是声明，
 * 供 adapter 与审批策略使用，不构成强制约束；strict 仅是“有资格”声明，是否
 * 真正启用由 adapter 按 provider/model 能力落地。
 * 不变量：`execute` 是 runtime-only 函数，序列化/持久化时必须剥离；工具名是
 * 稳定路由键，不能用描述或显示文案替代。
 */
export interface ModelToolContract {
  /** 延迟加载候选：可先只暴露名称/描述，待 tool search 命中后再给完整 Schema。 */
  deferLoading?: boolean;
  /** 工具注册名（稳定路由键）；provider function name 由 adapter 派生。 */
  name: string;
  /** 给模型看的用途描述；不是路由键，也不保证与实现完全一致。 */
  description?: string;
  /** 能力标签，用于 tool search/分组，不参与执行分发。 */
  capability?: string;
  /** 执行模式（本地/服务端等），决定 runtime 是否调度本地 execute。 */
  executionMode?: ToolExecutionMode;
  /** provider 原生工具声明；存在时 adapter 可能不生成普通 function schema。 */
  providerNative?: ProviderNativeToolSpec;
  /** 入参 JSON Schema：模型可见参数面的唯一来源，调用前必须校验。 */
  inputSchema: JsonSchema;
  /** 出参 Schema：用于结果校验/展示，缺省表示不约束。 */
  outputSchema?: JsonSchema;
  /** 见 ToolContractDeclaration.strict：严格模式的资格声明，adapter 按 provider/model 落地。 */
  strict?: boolean;
  /** 声明不修改任何状态；并发/审批策略可据此放宽，但执行仍须自行保证。 */
  readOnly?: boolean;
  /** 声明可能造成不可逆修改；用于强制审批或风险提示。 */
  destructive?: boolean;
  /** 声明同一时刻可并发执行；不确定时应保守为 false。 */
  concurrentSafe?: boolean;
  /** 声明需要用户交互（如确认框）；决定 UI 通道与超时策略。 */
  requiresUserInteraction?: boolean;
  /** 结果落盘/截断预算（字节）；超出时由 runtime 截断而非丢弃。 */
  maxOutputBytes?: number;
  /** 单次执行超时；runtime 超时后应中止并返回失败结果。 */
  timeoutMs?: number;
  /** 是否需要用户批准；与 permission 共同决定审批流，必须失败关闭。 */
  needsApproval?: boolean;
  /** 副作用粗分类，用于审批/并发策略。 */
  sideEffectScope?: ModelToolSideEffectScope;
  /** 细粒度权限声明（文件/网络等），由权限引擎求值。 */
  permission?: ToolPermissionSpec;
  /** 结果预算策略（截断/摘要等），与 maxOutputBytes 配合。 */
  resultBudget?: ToolResultBudget;
  /** 本地执行入口；runtime-only，不可序列化，provider 侧工具通常不提供。 */
  execute?: (input: unknown, context: ModelToolExecutionContext) => Promise<unknown> | unknown;
}

/**
 * 工具选择策略：自动、禁用、必须调用，或强制指定某个工具。
 *
 * 生产者：core 按 turn 意图（如强制 compaction 工具）设置。
 * 消费者：adapter 映射为 provider toolChoice；不支持细粒度控制的 provider 会降级。
 * 不变量：指定工具名必须是本次 tools 中存在的名称；`none` 不应仍携带工具结果重放。
 */
export type ModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

/**
 * provider 服务端工具的使用计数（如 web search/fetch）。
 *
 * 生产者：adapter 从 provider usage 归一化。
 * 消费者：用量汇总与计费/配额统计。
 * 不变量：只统计 provider 侧执行的服务端工具，本地工具调用不在此计数。
 */
export interface ModelServerToolUsage {
  /** 服务端 web search 请求次数。 */
  webSearchRequests?: number;
  /** 服务端 web fetch 请求次数。 */
  webFetchRequests?: number;
}

/**
 * 单次 provider 请求的用量（AI SDK v6 usage 口径），所有字段可缺省。
 *
 * 生产者：adapter 从 provider 响应/流 finish 归一化。
 * 消费者：`createModelUsageSummary` 累加、context meter、遥测与计费。
 * 关键口径：AI SDK v6 的 `inputTokens` 已经包含 cache read/write，不要再把
 * cacheReadTokens/cacheWriteTokens 叠加到输入窗口，否则 context 与 compact
 * 阈值会被放大；只有 inputTokens 缺失时才用 cache 字段作为回退。
 * 不变量：字段缺失表示 provider 未报告，不能当作 0 参与“是否有用量”的判断。
 */
export interface ModelUsage {
  /** 总输入 token（v6 已含 cache read/write），context 窗口的首选来源。 */
  inputTokens?: number;
  /** 输出 token（含推理输出，provider 口径可能不同）。 */
  outputTokens?: number;
  /** provider 报告的总 token；缺失时由 helpers 按输入+输出推导。 */
  totalTokens?: number;
  /** 从缓存读取的输入 token；已包含在 inputTokens 中，仅用于展示/计费细分。 */
  cacheReadTokens?: number;
  /** 写入缓存的输入 token；已包含在 inputTokens 中，不可再叠加。 */
  cacheWriteTokens?: number;
  /** 推理 token；是否已计入 outputTokens 取决于 provider，禁止假设可加总。 */
  reasoningTokens?: number;
  /** 服务端工具调用计数；与本地工具调用无关。 */
  serverToolUse?: ModelServerToolUsage;
}

/**
 * 多次请求的用量汇总：字段均为累加后的绝对值，source 固定为 provider。
 *
 * 生产者：`createModelUsageSummary` 对一次 turn/子流程内的 usage 求和。
 * 消费者：session/turn 级统计、UI 计费展示与遥测上报。
 * 字段口径：modelRequestCount 只统计真正有 usage 的请求（空 usage 被过滤）；
 * totalTokens 使用 getModelUsageTotalTokens 计算，保证 cache 不被重复叠加；
 * webSearchRequests/webFetchRequests 来自各 usage 的 serverToolUse。
 * 不变量：这是展示/统计口径，不是重试去重后的账单；同一请求多次 attempt
 * 若都产生 usage，需要上层按 attempt 语义决定是否累加。
 */
export interface ModelUsageSummary {
  source: "provider";
  modelRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

/**
 * 计算一次用量的“总 token”：优先 provider 报告值，否则按输入+输出推导。
 *
 * 生产者：usage 汇总与展示层调用；provider 未给 totalTokens 时的兜底。
 * 消费者：`createModelUsageSummary` 累加 totalTokens、计费与遥测。
 * 口径：inputTokens 缺失时才用 cacheRead+cacheWrite 充当输入（它们是 v6
 * 输入的一部分，不能与 inputTokens 相加）；无 usage 返回 0。
 * 不变量：返回非负整数，绝不返回 undefined；不得把 cache 再叠加一次。
 */
export function getModelUsageTotalTokens(usage?: ModelUsage): number {
  if (!usage) return 0;
  const inputTokens =
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return usage.totalTokens ?? inputTokens + (usage.outputTokens ?? 0);
}

/**
 * 计算“本次请求占用了多少上下文窗口”：输入窗口 + 输出。
 *
 * 生产者：core 在请求结束后取用；**仅主请求**（querySource==="main_turn"）
 * 才允许写入 UI 的 contextUsed，见 event-reducer 的
 * shouldModelCompleteUpdateContextUsed。
 * 消费者：context meter、compact 阈值与 `/context` 展示。
 * 为什么过滤非主请求：标题/压缩/子代理/工具内部调用也会产生 usage，但它们的
 * 上下文与主对话不同；若混用，几十 token 的旁路请求会覆盖主上下文计数。
 * 口径：输入优先用 getModelUsageInputWindowTokens（不重复叠 cache），再退回
 * totalTokens；两者都没有时返回 undefined，调用方不得当作 0 覆盖已有状态。
 */
export function getModelUsageContextTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = getModelUsageInputWindowTokens(usage);
  const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
  const contextTokens = (inputTokens ?? 0) + outputTokens;
  if (contextTokens > 0) {
    return contextTokens;
  }

  // input/output 都缺失时，才用 provider 的 totalTokens 兜底判断是否非零。
  const totalTokens = positiveInteger(usage.totalTokens);
  return totalTokens;
}

/**
 * 计算输入侧窗口占用：inputTokens 优先，其次 totalTokens 减 output，最后 cache。
 *
 * 生产者：`getModelUsageContextTokens` 与 context/compact 计算。
 * 消费者：context meter、compact 阈值；不用于计费细分（那是 cache 字段的职责）。
 * 关键口径：AI SDK v6 的 inputTokens 已包含 cache read/write，命中时直接返回，
 * 不能再加 cacheRead/cacheWrite，否则阈值会被系统性放大。
 * 不变量：所有分支返回正整数或 undefined；0 视为“未报告”，不得覆盖已有值。
 */
export function getModelUsageInputWindowTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = positiveInteger(usage.inputTokens);
  if (inputTokens !== undefined) {
    // AI SDK v6 的 Anthropic inputTokens 已经是普通输入 + cache read/write 的 total input。
    // 这里再叠 cacheReadTokens 会把 context meter 和 compact 阈值放大一截。
    return inputTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  if (totalTokens !== undefined) {
    const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
    return Math.max(0, totalTokens - outputTokens);
  }

  // 前两项都缺失时，cache 字段是唯一可用的输入侧证据（老旧/受限 provider）。
  const cacheTokens =
    (nonNegativeInteger(usage.cacheReadTokens) ?? 0) +
    (nonNegativeInteger(usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

/**
 * 判断 usage 是否含有任何 provider 报告字段（用于过滤空 usage）。
 *
 * 生产者：`createModelUsageSummary` 与用量落库前的过滤。
 * 消费者：决定是否计入 modelRequestCount、是否展示用量。
 * 口径：只有显式出现（非 undefined）才算有值；0 也算已报告，因为 0 可能是
 * provider 的真实结果；serverToolUse 只认其两个计数字段。
 * 不变量：不得因字段为 0 而判为“无用量”。
 */
export function hasModelUsage(usage?: ModelUsage): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

/**
 * 把数值夹成“正整数”：非有限值/0/负数一律返回 undefined。
 *
 * 生产者：usage helper 内部使用。
 * 消费者：输入窗口与 total 兜底判定。
 * 不变量：0 表示“未报告”而非有效值；向下取整避免小数 token 污染阈值比较。
 */
function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

/**
 * 把数值夹成“非负整数”：非有限值或负数返回 undefined，0 保留。
 *
 * 生产者：usage helper 内部使用。
 * 消费者：output/cache 累加与 total 减 output 的计算。
 * 不变量：0 是合法值（与 positiveInteger 的语义不同），不得误判为缺失。
 */
function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

/**
 * 把一组 usage 累加成 ModelUsageSummary；没有任何真实 usage 时返回 undefined。
 *
 * 生产者：turn/子流程结束后由 core 汇总各次请求 usage。
 * 消费者：session/turn 统计、UI 计费展示与遥测 fact。
 * 字段口径：先用 hasModelUsage 过滤空 usage，所以 modelRequestCount 只计有效
 * 请求；totalTokens 逐次调用 getModelUsageTotalTokens 后再相加，避免 cache
 * 被重复计入；webSearch/webFetch 从 serverToolUse 累加。
 * 不变量：空数组/全空 usage 返回 undefined 而不是零值摘要，调用方据此判断
 * “没有可展示的用量”，不能把 undefined 当 0 写回。
 */
export function createModelUsageSummary(
  usages: readonly ModelUsage[],
): ModelUsageSummary | undefined {
  const realUsages = usages.filter(hasModelUsage);
  if (realUsages.length === 0) return undefined;

  return realUsages.reduce<ModelUsageSummary>(
    (summary, usage) => ({
      source: "provider",
      modelRequestCount: summary.modelRequestCount + 1,
      inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: summary.totalTokens + getModelUsageTotalTokens(usage),
      cacheReadTokens: summary.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: summary.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: summary.reasoningTokens + (usage.reasoningTokens ?? 0),
      webFetchRequests: summary.webFetchRequests + (usage.serverToolUse?.webFetchRequests ?? 0),
      webSearchRequests: summary.webSearchRequests + (usage.serverToolUse?.webSearchRequests ?? 0),
    }),
    {
      source: "provider",
      modelRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 0,
      webSearchRequests: 0,
    },
  );
}

/**
 * 采样参数集合：全部可选，缺省表示“交给模型/适配层默认值”。
 *
 * 生产者：core 按场景（turn/compact/title）显式设置。
 * 消费者：adapter 映射为 provider 采样字段；不支持的参数应忽略而非报错。
 * 不变量：这些参数只影响生成质量/随机性，不改变消息、工具或身份；缺失与
 * 显式 0 必须区分（例如 temperature=0 是确定性采样请求）。
 */
export interface ModelRequestSettings {
  /** 采样温度；0 是有效值，表示尽量确定性，不等于“未设置”。 */
  temperature?: number;
  /** 输出 token 上限（请求预算，不是模型容量）。 */
  maxOutputTokens?: number;
  /** nucleus 采样阈值。 */
  topP?: number;
  /** top-k 采样；provider 不支持时忽略。 */
  topK?: number;
  /** 存在惩罚；provider 口径可能不同。 */
  presencePenalty?: number;
  /** 频率惩罚；provider 口径可能不同。 */
  frequencyPenalty?: number;
  /** 停止序列；命中后 provider 结束生成，不代表错误。 */
  stopSequences?: string[];
  /** 随机种子；仅部分 provider 支持，不能承诺跨 provider 可复现。 */
  seed?: number;
}

/**
 * 一次文本/工具调用的完整请求：消息、工具面、响应 Schema 与运行时钩子。
 *
 * 生产者：core 的 turn/tool/compact/title 调用点；ModelRequest 由其投影而来。
 * 消费者：Model.generateText/streamText，再经 adapter 翻译为 provider 请求。
 * 边界：messages/tools/responseJsonSchema 会真正发给 provider；providerOptions
 * 与 metadata 是 provider/观测扩展位。`statusSink`、`traceContext`、`modelCall`、
 * `modelRequestSessionType`、`modelRetryBudget`、`modelRequestAdmission`、
 * `streamIdleTimeoutRetryNumber`、`streamRecovery`、`preserveProviderStreamBoundaries`
 * 均为 runtime-only，不进 JSON Schema、不发给 Provider。
 * 不变量：JSON 可序列化的请求字段必须能通过 modelTextRequestJsonSchema 校验；
 * 运行时钩子不得被持久化或跨进程传输（trace id 需要跨进程时走 metadata）。
 */
export interface ModelTextRequest extends ModelRequestSettings {
  /** 是否允许模型使用 tool search 发现延迟加载工具；能力由 Model.requestCapabilities 决定。 */
  toolSearchEnabled?: boolean;
  /** 本次请求的完整消息序列；顺序即 provider 看到的顺序。 */
  messages: ModelInputMessage[];
  /** 本次暴露给模型的工具面；顺序与声明即边界，未列入的工具不可调用。 */
  tools?: ModelToolContract[];
  /** 工具选择策略；缺省通常等价 auto，由 adapter 决定。 */
  toolChoice?: ModelToolChoice;
  /** 结构化输出约束（JSON Schema）；adapter 尽力映射为 provider 的 response format。 */
  responseJsonSchema?: JsonSchema;
  /** provider 私有请求选项；由 adapter 透传，core 不应依赖其语义。 */
  providerOptions?: Record<string, unknown>;
  /** 通用观测/关联元数据；必须 JSON 可序列化，可承载跨进程 trace id。 */
  metadata?: Record<string, unknown>;
  /** 取消信号；必须贯穿 adapter/流式迭代，中止后不得再产生新事件。 */
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only、强类型的模型 API 调用分类；不会进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only 的宿主 session 粗分类。Adapter 将它写入受控归因 header；
   * 不允许调用方通过 provider 静态 headers 覆盖。
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only 重试预算档位（见 {@link ModelRetryBudget}）。与 modelRequestSessionType 同族：
   * 不进 JSON schema、不进 provider 请求。缺省即 `default`。
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only 准入端口（见 {@link ModelRequestAdmission}）：在场时 runner 每次尝试先 acquire、
   * 结束即 release。与 statusSink 同族：不进 JSON schema、不进 provider 请求。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only SSE idle timeout 递增序号。0/undefined 表示首请求；
   * 每重试一次在 adapter base timeout 上加 30000ms。
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution；只进入 status/telemetry，不发送给 Provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream 边界开关。compact 隐藏流用它保留首个真实 provider event
   * 与 content block provenance；tool input 提交不受此开关控制，所有请求都等待 AI SDK end。
   */
  preserveProviderStreamBoundaries?: boolean;
}

/**
 * provider 返回的来源引用（RAG/搜索/文档引用），只用于展示与审计。
 *
 * 生产者：adapter 从 provider 的 source part 归一化。
 * 消费者：结果展示、引用列表与遥测；不参与下一轮消息构造。
 * 不变量：url 可能指向外部内容，不能当作已校验的本地文件；providerMetadata
 * 是 provider 私有字段，不保证跨 provider 可读。
 */
export interface ModelSource {
  type: "source";
  /** 来源类别：网页 URL 或文档。 */
  sourceType: "url" | "document";
  /** provider 侧来源 ID（若提供），用于去重/引用。 */
  id?: string;
  /** 外部地址；不代表内容已被抓取或信任。 */
  url?: string;
  /** 来源标题，用于展示。 */
  title?: string;
  /** 文档 MIME，用于展示/图标。 */
  mediaType?: string;
  /** 文档文件名，用于展示。 */
  filename?: string;
  /** provider 私有来源元数据，不保证稳定。 */
  providerMetadata?: Record<string, unknown>;
}

/**
 * 一次工具执行的结果（含 provider 侧执行的工具），用于回填 tool 消息。
 *
 * 生产者：tool runtime 或 adapter（providerExecuted）。
 * 消费者：core 构造 tool 角色消息、UI 展示与遥测。
 * 字段口径：input 是原始调用入参，output 是工具产出（可能被预算截断）；
 * providerExecuted 表示 provider 已执行，本地不得重复执行。
 * 不变量：id 必须与对应 ModelToolCall.id 一致，否则无法配对回填。
 */
export interface ModelToolResult {
  /** 对应调用的 ID，必须与 ModelToolCall.id 一致。 */
  id: string;
  /** 工具名，用于展示/遥测。 */
  name: string;
  /** 原始入参（未校验或已校验的 JSON 值）。 */
  input: unknown;
  /** 工具输出；可能已按 resultBudget 截断，不能假设是完整原文。 */
  output: unknown;
  /** true 表示 provider 侧已执行。 */
  providerExecuted?: boolean;
  /** provider 私有结果元数据。 */
  providerMetadata?: Record<string, unknown>;
}

/**
 * 非流式请求的最终结果：文本、结束原因、用量与工具/推理/来源聚合。
 *
 * 生产者：adapter 的 generateText；ModelResult 即其别名。
 * 消费者：core 的结果处理、持久化、compact/标题逻辑与 UI。
 * 字段口径：finishReason 是 provider 归一化后的字符串（不保证枚举完备）；
 * usage 必填但可能字段稀疏；reasoning/toolCalls/toolResults/sources 是已聚合
 * 的结构，不是原始流事件。
 * 不变量：text 不含推理内容；toolCalls 与 toolResults 按 id 配对。
 */
export interface ModelTextResult {
  /** 最终可见文本；不包含 reasoning 内容。 */
  text: string;
  /** 结束原因（如 stop/length/tool-calls），provider 归一化后的字符串。 */
  finishReason: string;
  /** 用量；字段可能稀疏，见 ModelUsage 的 cache 口径。 */
  usage: ModelUsage;
  /** 推理块聚合，仅供回放/调试。 */
  reasoning?: ModelReasoningContentBlock[];
  /** assistant 发起的工具调用。 */
  toolCalls?: ModelToolCall[];
  /** 已执行（含 provider 侧）的工具结果。 */
  toolResults?: ModelToolResult[];
  /** 来源引用（RAG/搜索）。 */
  sources?: ModelSource[];
  /** provider 私有结果元数据。 */
  providerMetadata?: Record<string, unknown>;
}

/**
 * 流式请求的事件判别联合（ModelEvent 即其别名），按 provider 无关顺序归一化。
 *
 * 生产者：adapter 的 streamText，把 provider 流翻译成这些事件。
 * 消费者：core 的流式迭代、UI 增量渲染、遥测与 compact 隐藏流。
 * 生命周期：start → (text/reasoning/tool_input_*)* → tool_call? → finish，
 * 或任意阶段以 error 终止；每个 *_start 必须被对应 *_end 收尾（或被 error 截断）。
 * 不变量：delta 只在对应 start 之后、end 之前有效；id 区分同一消息内多个块；
 * compact_stream_boundary 只服务 compact 回放，不得进入 session/UI 流。
 */
export type ModelStreamEvent =
  | {
      /** 流开始：不携带正文；消费方可据此建立一次请求的展示状态。 */
      type: "start";
    }
  | {
      /**
       * Compact-only replay boundary。Adapter 从 raw provider stream 提炼真实边界；
       * 无 raw provenance 的 direct tool-call 校验失败可补一个 inferred commit。
       * 事件不携带 provider 正文，也不进入 session/UI streaming。
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      /**
       * provider content block 开始：blockType/index 可为 null（即 provider 未报告）；
       * 只用于 compact 还原块顺序，不驱动 UI。
       */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      /** provider 原始块类型；null 表示无法识别，不得据此猜测内容。 */
      blockType: string | null;
      /** provider 块序号；null 表示未知，排序时需保留原事件顺序。 */
      index: number | null;
    }
  | {
      /** Raw delta 只携带 provenance type，不携带正文。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      /** provider 原始 delta 类型；null 表示未报告。 */
      deltaType: string | null;
      /** 所属 provider 块序号；null 表示未知。 */
      index: number | null;
    }
  | {
      /** provider 内容块结束；index 为 null 时按事件顺序配对该块。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      /** 结束的 provider 块序号；null 表示未知。 */
      index: number | null;
    }
  | {
      /** 每个 provider message_delta 覆盖当前 stop reason 状态，后续 null 会清掉先前值。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      /** 当前是否仍持有 stop reason；false 表示已被后续 delta 清空。 */
      present: boolean;
    }
  | {
      /** 文本块开始；id 用于配对 delta/end，必须在同流内唯一。 */
      type: "text_start";
      id: string;
    }
  | {
      /** 文本增量；id 可缺省（provider 未给块标识），缺省时依附最近的 text_start。 */
      type: "text_delta";
      id?: string;
      text: string;
    }
  | {
      /** 文本块结束；id 必须与对应 text_start 一致。 */
      type: "text_end";
      id: string;
    }
  | {
      /** 推理块开始；providerMetadata 是 provider 私有数据，可能含加密/签名信息。 */
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      /** 推理增量；正文只用于展示/回放，不进入普通文本提取。 */
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      /** 推理块结束；id 与 reasoning_start 配对。 */
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      /** 工具入参开始；toolName 必须是本次请求 tools 中存在的名称。 */
      type: "tool_input_start";
      id: string;
      toolName: string;
      /** true 表示 provider 侧执行，本地不应调度该调用。 */
      providerExecuted?: boolean;
    }
  | {
      /** 工具入参增量：delta 是未拼装的 JSON 片段，不能逐段解析。 */
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | {
      /** 工具入参结束：此后才可整体校验 inputSchema。 */
      type: "tool_input_end";
      id: string;
    }
  | {
      /** 工具调用已完整（AI SDK 等待 end 后提交）；本地根据 providerExecuted 决定是否执行。 */
      type: "tool_call";
      toolCall: ModelToolCall;
    }
  | {
      /** 流结束：携带归一化 finishReason 与 usage；每个成功流应有且仅有一个 finish。 */
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
    }
  | {
      /** 流错误：error 是 provider/adapter 原始错误对象，需经分类后才可对外展示。 */
      type: "error";
      error: unknown;
    };

/**
 * ModelSelection 的 JSON Schema：只要求 providerId/modelId，options 完全可选。
 *
 * 生产者：契约包对外发布的协议 Schema；随会话/网络/跨进程传输。
 * 消费者：外部调用方、session codec 与事件载荷校验。
 * 稀疏口径：options 缺省 = 未指定选项（沿用默认）；不会用 null 表示选项。
 * 显式清除是事件层语义（如 ModelSelected.contextWindow=null），不属于
 * Selection 本身；additionalProperties:false 保证不会悄悄带入未知选项。
 * 不变量：字段名/约束必须与共享 modelSelectionSchema 保持一致，不得分叉。
 */
export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

/**
 * AttachmentRef 的 JSON Schema（内部使用，被内容块 Schema 引用）。
 *
 * 生产者：契约包内的内容块 Schema 组合。
 * 消费者：消息持久化/跨进程校验。
 * 口径：id/kind 必填；其余元数据可选且 additionalProperties:false，防止
 * 把正文或任意私有字段混进附件引用。
 */
const attachmentRefJsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { enum: ["local_file", "resource", "inline"] },
    uri: { type: "string" },
    path: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    placeholder: { type: "string" },
  },
} satisfies JsonSchema;

/**
 * 内容块 JSON Schema：用 oneOf 枚举所有块形态，逐型声明必填字段。
 *
 * 生产者：本文件的模型协议 Schema。
 * 消费者：modelInputMessageJsonSchema 校验；持久化/跨进程恢复。
 * 口径：image/video 必须带自包含 dataUrl；file 只要求 mediaType（text/uri/
 * dataUrl 任选）；tool_reference/resource_link 必须带名称或 URI。
 * 不变量：必须与 ModelMessageContentBlock 联合逐项对应，新增块类型要同步。
 */
const modelMessageContentBlockJsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool_reference"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["text"] },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["reasoning"] },
        text: { type: "string" },
        providerOptions: { type: "object" },
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["image"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        detail: { enum: ["auto", "low", "high", "original"] },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["video"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType"],
      additionalProperties: false,
      properties: {
        type: { enum: ["file"] },
        mediaType: { type: "string", minLength: 1 },
        name: { type: "string" },
        uri: { type: "string" },
        dataUrl: { type: "string" },
        text: { type: "string" },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "uri"],
      additionalProperties: false,
      properties: {
        type: { enum: ["resource_link"] },
        uri: { type: "string", minLength: 1 },
        name: { type: "string" },
        title: { type: "string" },
      },
    },
  ],
} satisfies JsonSchema;

/**
 * 消息内容 JSON Schema：字符串或内容块数组二选一，与 ModelMessageContent 对齐。
 *
 * 生产者：模型协议 Schema。
 * 消费者：消息校验与持久化。
 * 不变量：字符串形态只表示纯文本，不得用它夹带结构化块。
 */
const modelMessageContentJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "array",
      items: modelMessageContentBlockJsonSchema,
    },
  ],
} satisfies JsonSchema;

/**
 * 输入消息 JSON Schema：role/content 必填，工具与缓存字段可选。
 *
 * 生产者：模型协议 Schema；外部/持久化消息校验入口。
 * 消费者：modelTextRequestJsonSchema 的 messages 数组。
 * 口径：toolCalls 仅约束为数组（元素结构不在本 Schema 展开）；cacheControl
 * 只允许 ephemeral 及受支持的 ttl/scope。
 * 不变量：additionalProperties:false，防止未知字段跨进程后静默丢失。
 */
export const modelInputMessageJsonSchema = {
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant", "tool"] },
    content: modelMessageContentJsonSchema,
    cacheControl: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["ephemeral"] },
        ttl: { enum: ["5m", "1h"] },
        scope: { enum: ["global", "org"] },
      },
    },
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
    toolName: { type: "string" },
    isError: { type: "boolean" },
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
  },
} satisfies JsonSchema;

/**
 * 工具选择 JSON Schema：字符串枚举或 `{type:"tool", toolName}` 强指定。
 *
 * 生产者：模型协议 Schema。
 * 消费者：modelTextRequestJsonSchema 的 toolChoice。
 * 不变量：toolName 最小长度为 1；schema 不校验该工具是否真实存在于 tools，
 * 存在性由调用方/runtime 负责。
 */
const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
  ],
} satisfies JsonSchema;

/**
 * 可序列化文本请求的 JSON Schema：只覆盖会跨进程/持久化的字段。
 *
 * 生产者：模型协议 Schema；用于外部请求校验。
 * 消费者：请求 ingress/恢复路径；adapter 不依赖此 Schema 做运行时映射。
 * 口径：messages 必填；tools 只约束为数组（工具契约含函数，不能在此展开）；
 * runtime-only 钩子（statusSink/traceContext/modelCall/重试/准入等）刻意不在
 * 此列，序列化请求必须丢弃它们。
 * 不变量：additionalProperties:false 是安全边界，新增可序列化字段需同步更新；
 * 不得把 execute 等函数混入该 Schema 覆盖的请求。
 */
export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;

/**
 * ModelNetworkStatusEvent 的 JSON Schema：网络状态事件跨层传递的校验口径。
 *
 * 生产者：adapter/runtime 发出的模型网络状态事件。
 * 消费者：UI/session/遥测的接收方；JSON 协议边界。
 * 口径：type/timestamp/traceId/requestId/model/transport/attempt/maxAttempts 必填；
 * maxAttempts 最小为 0，因为 0 表示“无上限重试预算”，不是非法值。
 * 不变量：additionalProperties:true 允许扩展字段（如新增观测指标），但必填
 * 字段的语义一旦发布不可静默更改；attempt 从 1 开始，nextAttempt 也是 1 起。
 */
export const modelNetworkStatusEventJsonSchema = {
  type: "object",
  required: [
    "type",
    "timestamp",
    "traceId",
    "requestId",
    "model",
    "transport",
    "attempt",
    "maxAttempts",
  ],
  additionalProperties: true,
  properties: {
    type: {
      enum: [
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
        "model_retry_scheduled",
        "model_stream_stalled",
      ],
    },
    timestamp: { type: "string", minLength: 1 },
    traceId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    turnId: { type: "string", minLength: 1 },
    querySource: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    model: modelSelectionJsonSchema,
    transport: { enum: Object.values(ModelTransportKind) },
    attempt: { type: "number", minimum: 1 },
    // 0 = 无上限重试预算，故下界是 0 而不是 1。
    maxAttempts: { type: "number", minimum: 0 },
    delayMs: { type: "number", minimum: 0 },
    durationMs: { type: "number", minimum: 0 },
    idleMs: { type: "number", minimum: 0 },
    nextAttempt: { type: "number", minimum: 1 },
    reason: { enum: Object.values(ModelFailureReason) },
    retryable: { type: "boolean" },
    message: { type: "string" },
    statusCode: { type: "number" },
    requestHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    responseHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    requestHeaderCount: { type: "number", minimum: 0 },
    responseHeaderCount: { type: "number", minimum: 0 },
    streamRecovery: {
      type: "object",
      required: ["attemptId", "retryNumber", "maxRetries"],
      additionalProperties: false,
      properties: {
        attemptId: { type: "string", minLength: 1 },
        retryNumber: { type: "number", minimum: 1 },
        maxRetries: { type: "number", minimum: 0 },
        recoveredFromRequestId: { type: "string", minLength: 1 },
        anchorId: { type: "string", minLength: 1 },
      },
    },
    timeoutMs: { type: "number", minimum: 0 },
  },
} satisfies JsonSchema;

/**
 * 兼容别名：把 ModelToolCall 以旧名 ToolCall 导出，供既有调用方迁移。
 *
 * 生产者：本契约包的向后兼容层。
 * 消费者：仍引用 ToolCall 旧名的 CLI/core 代码。
 * 不变量：与 ModelToolCall 完全同构；新代码应使用 ModelToolCall，且不得
 * 在此别名上附加字段或拆分类型。
 */
// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall };

export * from "./content-protection.js";
