import type { ModelRequestObservation, ModelId, ModelProviderId } from "../model/index.js";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryAbandonReason,
  AgentTelemetryCancellationReason,
  AgentTelemetryErrorCategory,
  AgentTelemetryOperation,
  AgentTelemetryScope,
} from "./agent-execution.js";

export * from "./agent-execution.js";

/**
 * 模型 API 调用用途的受控枚举（字符串值即遥测维度值）。
 *
 * 生产者：core 在构造 ModelApiCallObservation 时选择；resolve 缺省时按
 * querySource 映射。
 * 消费者：遥测 span 的 operation 维度、按用途聚合的指标与成本报表。
 * 不变量：值一旦发布即为遥测口径，不可随意改名；新增值需同步
 * AgentTelemetryOperation 的映射，避免 operation 维度出现两套词表。
 */
export const ModelApiOperation = {
  AgentStep: "agent_step",
  ContextCompaction: "context_compaction",
  GoalTitle: "goal_title_generation",
  GoalVerification: "goal_completion_verification",
  GitCommitMessage: "workspace_git_commit_message",
  ProjectMemoryExtract: "project_memory_extract",
  ProjectMemoryDream: "project_memory_dream",
  ProjectMemoryRecall: "project_memory_recall",
  ReadSessionContextExtract: "read_session_context_extract",
  ReadSessionContextSynthesize: "read_session_context_synthesize",
  SessionTitle: "session_title_generation",
  ToolInternalModelCall: "tool_internal_model_call",
  WebFetch: "web_fetch_processing",
  WebSearch: "web_search",
  WorkspaceGenerateText: "workspace_generate_text",
} as const;

/**
 * 上述常量对象的值联合类型：元素级用途标识，只用于遥测分类。
 *
 * 生产者：常量对象本身。
 * 消费者：ModelApiCallObservation.operation 与 trace start 类型。
 * 不变量：不得把它当作模型身份或路由键（路由使用 providerId/modelId）。
 */
export type ModelApiOperation = (typeof ModelApiOperation)[keyof typeof ModelApiOperation];

/**
 * 模型调用用途映射到 agent 遥测用途：当前名称一一对应，仅做类型收窄。
 *
 * 生产者：core/telemetry runtime 在生成 agent 侧 span 时调用。
 * 消费者：AgentTelemetryOperation 维度聚合。
 * 不变量：两套词表必须保持同值；若未来分叉，必须在此显式映射而不是靠
 * 字符串强转，否则遥测报表会出现无法合并的 operation。
 */
export function mapModelApiOperationToAgentOperation(
  operation: ModelApiOperation,
): AgentTelemetryOperation {
  return operation;
}

/**
 * 模型调用发起方的受控分类：主 agent、子代理、workflow child、系统旁路、工具内部。
 *
 * 生产者：querySource→operation 映射或调用点显式标注。
 * 消费者：遥测 actorKind 维度与成本/延迟分摊。
 * 不变量：workflow_child 是独立一类，不得并入 subagent；System/Tool 表示非用户
 * 直接发起的旁路调用，不能用来掩盖主链路调用。
 */
export const ModelApiActorKind = {
  MainAgent: "main",
  Subagent: "subagent",
  WorkflowChild: "workflow_child",
  System: "system",
  Tool: "tool",
} as const;

/**
 * 上述常量对象的值联合类型。
 *
 * 生产者：常量对象。
 * 消费者：ModelApiCallObservation.actorKind。
 * 不变量：与 AgentTelemetryActorKind 的前三类同值；implicit 缺省由 resolve 决定。
 */
export type ModelApiActorKind = (typeof ModelApiActorKind)[keyof typeof ModelApiActorKind];

/**
 * 一次模型调用在因果链中的位置：初次、续写、回退替换、故障恢复。
 *
 * 生产者：core 的重试/回退/恢复逻辑设置。
 * 消费者：遥测关联 previousLogicalCallId、区分“新增调用”与“替换调用”。
 * 不变量：非 initial 必须带 previousLogicalCallId；initial 不得带，避免自我引用。
 */
export type ModelApiCallCause = "initial" | "continuation" | "fallback_replacement" | "recovery";

/**
 * 运行宿主形态：独立 CLI、桌面本地 host、远程 workspace host。
 *
 * 生产者：进程启动时的 runtime 探测。
 * 消费者：资源属性与遥测维度，用于区分部署环境。
 * 不变量：这是运行环境事实，不是 provider 传输类型（后者见 ModelTransportKind）。
 */
export type ModelApiRuntimeSurface =
  | "standalone_cli"
  | "desktop_local_host"
  | "remote_workspace_host";

/**
 * 模型调用失败阶段：从准备到流解析的有界阶段枚举。
 *
 * 生产者：adapter/runner 在失败分类时标注。
 * 消费者：遥测 error phase、失败分布与重试策略。
 * 不变量：`unhandled` 只兜底未知异常；已知阶段不得折叠进 unhandled，
 * 否则无法定位失败注入点。
 */
export type ModelApiErrorPhase =
  | "prepare"
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";

/**
 * 失败异常种类：把异构异常归到有限的受控类别（非原始类名）。
 *
 * 生产者：telemetry runtime 的错误分类器。
 * 消费者：AgentTelemetryErrorCategory 映射与失败看板。
 * 不变量：只描述异常来源，不携带异常消息/堆栈；provider business 错误与
 * 传输错误必须区分，便于判断是否可重试。
 */
export const ModelFailureExceptionKind = {
  ApiCall: "api_call",
  Generic: "generic",
  Protocol: "protocol",
  ProviderBusiness: "provider_business",
  Transport: "transport",
  TypeError: "type_error",
  Validation: "validation",
} as const;
/**
 * 上述常量对象的值联合类型。
 *
 * 生产者：常量对象。
 * 消费者：失败分类结果与遥测属性。
 * 不变量：新增种类需同步映射到 AgentTelemetryErrorCategory，避免遥测维度膨胀。
 */
export type ModelFailureExceptionKind =
  (typeof ModelFailureExceptionKind)[keyof typeof ModelFailureExceptionKind];

/**
 * 模型对 reasoning 能力的支持状态：三值，未知不能被当作支持/不支持。
 *
 * 生产者：模型注册表/能力探测。
 * 消费者：reasoning 观测与降级决策。
 * 不变量：unknown 表示未探测，不得据此启用需要能力的档位。
 */
export type ModelReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";

/**
 * reasoning 的请求/生效状态：开启、关闭、provider 默认、未知。
 *
 * 生产者：调用点的请求意图与 adapter 的生效事实。
 * 消费者：ModelReasoningObservation 的前后对比与遥测。
 * 不变量：provider_default 与 unknown 不同——前者是确定的默认策略，
 * 后者是缺少事实，不能互换。
 */
export type ModelReasoningState = "enabled" | "disabled" | "provider_default" | "unknown";

/**
 * reasoning 的控制方式：固定档位、固定预算、自适应、开关、provider 默认、未知。
 *
 * 生产者：模型配置与 adapter 能力映射。
 * 消费者：决定 requested/effective control 的口径与展示。
 * 不变量：fixed_level 用 level，fixed_budget 用 budgetTokens；两者不得混填。
 */
export type ModelReasoningControlType =
  | "fixed_level"
  | "fixed_budget"
  | "adaptive"
  | "toggle"
  | "provider_default"
  | "unknown";

/**
 * 调用点声明的 reasoning 意图（hint），不代表 provider 最终如何执行。
 *
 * 生产者：core 按模型选项/用户选择填写。
 * 消费者：adapter 尽量按 hint 映射；telemetry 记录 requested 侧事实。
 * 字段口径：requestedLevel 是意图档位；explicit 只在调用点已确定具体控制
 * 方式时填写，state 不允许 unknown。
 * 不变量：hint 只表达意图，adapter 可因能力不支持而降级，最终生效事实
 * 必须由 ModelReasoningObservation 记录。
 */
/** 调用点只声明用户/业务请求的 reasoning 意图，Provider Adapter 决定最终事实。 */
export interface ModelReasoningCallHint {
  /** 请求的推理档位标识；必须来自该模型 optionSpecs 的枚举。 */
  requestedLevel?: string;
  /** 调用点已确定的显式控制；缺省表示交给 adapter 按模型能力决定。 */
  explicit?: {
    /** 显式请求状态；unknown 被排除，因为显式意图不能是“未知”。 */
    state: Exclude<ModelReasoningState, "unknown">;
    /** 显式控制方式；缺省由 adapter 推断。 */
    controlType?: Exclude<ModelReasoningControlType, "unknown">;
    /** 显式生效档位。 */
    effectiveLevel?: string;
    /** 显式生效预算 token。 */
    effectiveBudgetTokens?: number;
  };
}

/**
 * 一次最终 provider 请求的 canonical reasoning 事实：请求侧与生效侧对照。
 *
 * 生产者：adapter 在请求发出/收到响应后归一化。
 * 消费者：遥测 span 属性、能力降级分析与 UI 诊断。
 * 字段口径：capability 是模型能力结论；requested* 是调用点意图，effective* 是
 * provider 实际采用的控制方式；两者分开记录，缺省字段表示未报告/不适用。
 * 不变量：不得把 requested 值直接当 effective 值；不支持的档位必须体现为
 * 降级，而不是悄悄等价。
 */
/** 一次最终 Provider 请求的 canonical reasoning 事实。 */
export interface ModelReasoningObservation {
  /** 模型对 reasoning 的支持结论；unknown 表示未探测。 */
  capability: ModelReasoningCapabilityStatus;
  /** 请求侧状态。 */
  requestedState: ModelReasoningState;
  /** 请求侧控制方式。 */
  requestedControl: ModelReasoningControlType;
  /** 请求侧档位（fixed_level 时使用）。 */
  requestedLevel?: string;
  /** 请求侧预算（fixed_budget 时使用）。 */
  requestedBudgetTokens?: number;
  /** provider 实际生效状态。 */
  effectiveState: ModelReasoningState;
  /** provider 实际生效控制方式。 */
  effectiveControl: ModelReasoningControlType;
  /** 实际生效档位；未使用档位控制时缺省。 */
  effectiveLevel?: string;
  /** 实际生效预算 token；未使用预算控制时缺省。 */
  effectiveBudgetTokens?: number;
}

/**
 * 受控调用的少量结构化扩展事实：只允许有界、低基数的计数/枚举。
 *
 * 生产者：compaction/stream recovery 等专用调用点填写。
 * 消费者：遥测 span 属性与重试/恢复分析。
 * 字段口径：compactionOuterAttempt 是外层尝试序号；compactionTrigger 是触发来源
 * 枚举；streamRecoveryNumber 是本次流恢复的递增序号。
 * 禁止：prompt、message、header、body、原始 URL、命令和工具 I/O——这些属于
 * 高基数/敏感内容，不能进入遥测。
 */
/**
 * 受控调用专属事实。禁止 prompt、message、header、body、原始 URL、命令和工具 I/O。
 */
export interface ModelApiCustomAttributes {
  /** compaction 外层尝试序号，用于区分同一压缩流程的多次外层循环。 */
  compactionOuterAttempt?: number;
  /** compaction 触发来源（受控枚举字符串），不是自由文本。 */
  compactionTrigger?: string;
  /** 流恢复的递增序号；0/缺省表示没有发生恢复。 */
  streamRecoveryNumber?: number;
}

/**
 * 调用点上报的模型 API 调用观测：所有字段可选，缺省由 resolve 补齐。
 *
 * 生产者：core/adapter 在发起请求前构造，作为 runtime-only 事实挂到请求。
 * 消费者：`resolveModelApiCallObservation`、模型调用 span 与用量事件。
 * 字段口径：operation/actorKind 缺省按 querySource 映射；logicalCallId 表示一次
 * 逻辑调用（跨 attempt 保持不变）；previousLogicalCallId 只用于续写/替换/恢复；
 * operationId 是同一次操作内的关联键（与 logicalCallId 不同层）；reasoning 是
 * 意图 hint，不是最终事实。
 * 不变量：不得包含敏感正文；同一逻辑调用的多个 attempt 必须复用同一个
 * logicalCallId，而每次 attempt 另有 requestId。
 */
export interface ModelApiCallObservation {
  /** 调用用途；缺省由 querySource 映射。 */
  operation?: ModelApiOperation;
  /** 发起方分类；缺省由 querySource 映射。 */
  actorKind?: ModelApiActorKind;
  /** 上层操作 ID，用于把同一业务操作下的多次模型调用串起来。 */
  operationId?: string;
  /** 逻辑调用 ID：跨重试/流恢复复用；缺省时 resolve 生成 UUID。 */
  logicalCallId?: string;
  /** 因果位置；非 initial 时应提供 previousLogicalCallId。 */
  callCause?: ModelApiCallCause;
  /** 被替换/续写的前一个逻辑调用 ID。 */
  previousLogicalCallId?: string;
  /** 运行宿主形态；缺省由进程级资源信息提供。 */
  runtimeSurface?: ModelApiRuntimeSurface;
  /** agent 名称（展示/分组用），不是身份主键。 */
  agentName?: string;
  /** 所属 step 序号，用于对齐 agent_step span。 */
  stepIndex?: number;
  /** reasoning 意图提示，最终事实由 adapter 归一化。 */
  reasoning?: ModelReasoningCallHint;
  /** 受控扩展事实（有界计数/枚举）。 */
  attributes?: ModelApiCustomAttributes;
}

/**
 * 已补齐必填字段的调用观测：operation/actorKind/logicalCallId 保证存在。
 *
 * 生产者：`resolveModelApiCallObservation` 的输出。
 * 消费者：span 创建与遥测 writer 的输入。
 * 字段口径：reasoning 被替换为最终生效事实 ModelReasoningObservation；
 * 其余字段保持调用方原值。
 * 不变量：调用方不得再对这三个必填字段做二次兜底，否则会与日志/关联键分叉。
 */
export type ResolvedModelApiCallObservation = Omit<ModelApiCallObservation, "reasoning"> & {
  logicalCallId: string;
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
  reasoning: ModelReasoningObservation;
};

/**
 * 补齐调用观测：显式字段优先，其次 querySource 映射，最后生成 logicalCallId。
 *
 * 生产者：请求构造/遥测入口调用；querySource 来自调用点语义。
 * 消费者：模型调用 span、用量 fact 与状态旁路。
 * 口径：显式 observation 覆盖映射结果（operation/actorKind）；logicalCallId
 * 会 trim，空串视为缺失并生成 UUID，因此同一逻辑调用必须由调用方显式复用。
 * 不变量：querySource 为空时落到 ToolInternalModelCall/System 兜底，不能
 * 把未知调用误记成主 agent；不能在此生成新的 logicalCallId 覆盖已有值。
 */
export function resolveModelApiCallObservation(
  querySource: string | undefined,
  observation: ModelApiCallObservation | undefined,
): Required<Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">> &
  ModelApiCallObservation {
  const mapped = mapQuerySourceToModelApiOperation(querySource);
  return {
    ...mapped,
    ...observation,
    operation: observation?.operation ?? mapped.operation,
    actorKind: observation?.actorKind ?? mapped.actorKind,
    logicalCallId: observation?.logicalCallId?.trim() || crypto.randomUUID(),
  };
}

/**
 * 把调用点的 querySource 映射成遥测 operation/actorKind 的默认值。
 *
 * 生产者：`resolveModelApiCallObservation` 在调用方未显式标注时使用。
 * 消费者：模型调用 span 的 operation/actorKind 维度。
 * 口径：main/subagent/workflow_child 都是 AgentStep，但 actorKind 不同；
 * compact/标题/目标/记忆类归 System；web/read_session_context 归 Tool；
 * 未识别 querySource 兜底为 ToolInternalModelCall/System。
 * 不变量：映射只做分类，不改变请求行为；新增 querySource 需同步此表，
 * 否则会被误归为 tool internal。
 */
function mapQuerySourceToModelApiOperation(querySource: string | undefined): {
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
} {
  switch (querySource?.trim()) {
    case "main_turn":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.MainAgent };
    case "subagent":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.Subagent };
    case "workflow_child":
      return {
        operation: ModelApiOperation.AgentStep,
        actorKind: ModelApiActorKind.WorkflowChild,
      };
    case "compact":
      return {
        operation: ModelApiOperation.ContextCompaction,
        actorKind: ModelApiActorKind.System,
      };
    case "session_title":
      return {
        operation: ModelApiOperation.SessionTitle,
        actorKind: ModelApiActorKind.System,
      };
    case "goal_summary_title":
      return { operation: ModelApiOperation.GoalTitle, actorKind: ModelApiActorKind.System };
    case "target_completion_verification":
      return {
        operation: ModelApiOperation.GoalVerification,
        actorKind: ModelApiActorKind.System,
      };
    case "git_commit_message":
      return {
        operation: ModelApiOperation.GitCommitMessage,
        actorKind: ModelApiActorKind.System,
      };
    case "web_search_tool":
      return { operation: ModelApiOperation.WebSearch, actorKind: ModelApiActorKind.Tool };
    case "web_fetch_processing":
      return { operation: ModelApiOperation.WebFetch, actorKind: ModelApiActorKind.Tool };
    case "read_session_context":
      return {
        operation: ModelApiOperation.ReadSessionContextExtract,
        actorKind: ModelApiActorKind.Tool,
      };
    case "project_memory_extract":
      return {
        operation: ModelApiOperation.ProjectMemoryExtract,
        actorKind: ModelApiActorKind.System,
      };
    case "project_memory_dream":
      return {
        operation: ModelApiOperation.ProjectMemoryDream,
        actorKind: ModelApiActorKind.System,
      };
    case "project_memory_recall":
      return {
        operation: ModelApiOperation.ProjectMemoryRecall,
        actorKind: ModelApiActorKind.System,
      };
    default:
      return {
        operation: ModelApiOperation.ToolInternalModelCall,
        actorKind: ModelApiActorKind.System,
      };
  }
}

/**
 * provider 端点的脱敏身份：只保留 origin/route 与清洗器版本，不含完整 URL。
 *
 * 生产者：provider 配置解析后的安全投影。
 * 消费者：遥测资源属性与 provider 归因。
 * 不变量：origin/route 必须已按白名单/规则清洗，不得包含 query、密钥或
 * 用户标识；sanitizerVersion 变化会影响可比性，需随清洗规则升级。
 */
export interface ProviderEndpointIdentity {
  /** scheme+host(+port)，不含 path/query。 */
  origin: string;
  /** 受控路由模板（如 /v1/messages），不是原始请求 URL。 */
  route: string;
  /** 端点清洗规则版本，用于解释历史数据的口径差异。 */
  sanitizerVersion: string;
}

/**
 * 遥测身份快照：进程级可更新的登录态，避免每次请求重复探测。
 *
 * 生产者：`AgentTelemetryRuntimeOwner.updateIdentity` 在登录/登出时更新。
 * 消费者：span 的 identityState/userSubjectId 属性。
 * 不变量：userSubjectId 必须已脱敏为稳定 subject，不得放邮箱/昵称；unknown
 * 表示尚未确定，不能当成匿名（anonymous）上报。
 */
export interface TelemetryIdentitySnapshot {
  /** 当前身份状态；三值互斥，未知不等于匿名。 */
  identityState: "authenticated" | "anonymous" | "unknown";
  /** 已脱敏的用户主体 ID；仅在已认证时提供。 */
  userSubjectId?: string;
}

/**
 * 遥测资源上下文：描述“哪个进程/构建/部署实例”在产生事件。
 *
 * 生产者：进程启动时由 bootstrap 组装（版本、构建、安装 ID、runtime surface）。
 * 消费者：OTel Resource 属性；用于跨版本/跨部署对比。
 * 不变量：installationId/serviceInstanceId 是随机稳定 ID，不含用户信息；
 * runtimeSurface 与 ModelApiRuntimeSurface 同义但用于 agent 遥测。
 */
export interface TelemetryResourceContext {
  buildCommitId?: string;
  cliVersion?: string;
  deploymentEnvironment?: string;
  installationId?: string;
  productVersion?: string;
  runtimeDistribution?: "source" | "development_bundle" | "packaged" | "unknown";
  runtimeSurface: ModelApiRuntimeSurface;
  serviceInstanceId: string;
  serviceName: string;
}

/**
 * provider API 形态（wire protocol）：messages/chat_completions/responses/generate_content。
 *
 * 生产者：adapter 根据 provider 配置/模型类型选择。
 * 消费者：遥测 span 属性，用于区分配置/协议差异导致的失败与延迟。
 * 不变量：这是传输协议分类，不是 provider 身份或模型能力；unknown 表示未识别，
 * 不得默认成某一种协议。
 */
export type ModelApiOperationKind =
  | "messages"
  | "chat_completions"
  | "responses"
  | "generate_content"
  | "unknown";

/**
 * 逻辑调用（跨 attempt）级别的失败阶段：定位失败发生在解析/尝试/回退/聚合哪层。
 *
 * 生产者：模型调用 runner 在最终失败时标注。
 * 消费者：ModelCallSpanWriter.finishFailed 与失败看板。
 * 不变量：`attempts` 表示所有尝试失败；`fallback` 表示回退链本身失败；
 * unhandled 只兜底未知流程错误。
 */
export type ModelCallFailureStage =
  | "resolve_target"
  | "attempts"
  | "fallback"
  | "aggregate"
  | "unhandled";

/**
 * 单次 attempt 的失败阶段：与 ModelApiErrorPhase 同构但用于 attempt span。
 *
 * 生产者：adapter 在 attempt 失败时分类。
 * 消费者：ModelAttemptSpanWriter.finishFailed 与重试决策。
 * 不变量：阶段必须有界且可归因；不得把取消/中止混入 unhandled。
 */
export type ModelAttemptFailureStage =
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";

/**
 * provider 实际返回的结束原因：保持 SDK 原字符串，不折叠成 other。
 *
 * 生产者：adapter 从 finish reason 归一化（通常是枚举字符串）。
 * 消费者：遥测 span 属性与 UI 结束状态展示。
 * 不变量：不得在此做领域层合并（如把 length 与 max_tokens 合并），否则会
 * 丢失 provider 差异；自由字符串也意味着不能做穷举 switch 假设。
 */
/** Provider/SDK 实际返回的有界结束原因，不在领域层折叠成 other。 */
export type ModelFinishReason = string;

/**
 * 解析后的模型遥测描述：请求发出前就能确定的 provider/模型/端点/reasoning 事实。
 *
 * 生产者：模型调用 runner 解析 Selection 与 provider 配置后构造。
 * 消费者：call span 与 attempt span 的 requested 属性。
 * 字段口径：providerId 是稳定标识；providerKind 是 provider 实现类别；
 * providerOrigin/providerRoute 已脱敏；reasoning 是请求侧观测；requestedModel
 * 是实际要请求的模型标识（不是展示名）。
 * 不变量：不得包含密钥/完整 URL；providerId 与 modelId 不做展示名替换。
 */
export interface ResolvedModelTelemetryDescriptor {
  /** provider 稳定标识（与模型请求路由一致）。 */
  providerId: string;
  /** provider 实现类别（如 anthropic/openai），用于协议归因。 */
  providerKind: string;
  /** 脱敏后的端点 origin；缺省表示未解析。 */
  providerOrigin?: string;
  /** 脱敏后的端点 route；缺省表示未解析。 */
  providerRoute?: string;
  /** 请求侧 reasoning 事实（意图 + 能力结论）。 */
  reasoning: ModelReasoningObservation;
  /** 实际请求的模型标识，不是 displayName。 */
  requestedModel: string;
}

/**
 * provider 响应中回报的模型标识（可能与请求模型不同，如路由/别名解析）。
 *
 * 生产者：adapter 从响应体归一化。
 * 消费者：attempt span 的 response model 属性，用于发现静默换模。
 * 不变性：只记录 provider 实际回报值，不得用请求值回填伪装成响应值。
 */
export interface ResponseModelTelemetryDescriptor {
  /** provider 响应中的模型名称/标识。 */
  model: string;
}

/**
 * 逻辑模型调用 trace 的启动输入：跨 attempt 恒定的事实与因果位置。
 *
 * 生产者：模型调用 runner 在开始一次逻辑调用时构造。
 * 消费者：ModelExecutionTelemetryPort.startCall。
 * 字段口径：logicalCallId 是跨 attempt 的主键；operation 是用途；requested 是
 * 请求侧描述；streaming 表示是否为流式；callCause 用判别联合约束——
 * initial 不允许带 previousLogicalCallId，其余原因必须带。
 * 不变量：同一逻辑调用的所有 attempt 共享此处的 logicalCallId；不得在重试时
 * 生成新的逻辑调用 ID（那会切断因果链）。
 */
export type ModelCallTraceStart = {
  /** 跨 attempt 恒定的逻辑调用 ID。 */
  logicalCallId: string;
  /** 模型角色（如主/辅），仅用于分组展示。 */
  modelRole?: string;
  /** 调用用途（受控枚举）。 */
  operation: ModelApiOperation;
  /** 请求侧 provider/模型/reasoning 描述。 */
  requested: ResolvedModelTelemetryDescriptor;
  /** 是否流式请求。 */
  streaming: boolean;
} & (
  | {
      /** 初次调用：不得携带 previousLogicalCallId。 */
      callCause: "initial";
      previousLogicalCallId?: never;
    }
  | {
      /** 续写/回退/恢复：必须指向前一个逻辑调用。 */
      callCause: Exclude<ModelApiCallCause, "initial">;
      previousLogicalCallId: string;
    }
);

/**
 * 单次 provider attempt 的 trace 启动输入：每次 HTTP 请求独立的事实。
 *
 * 生产者：runner 在每次 attempt（含重试/回退）开始时构造。
 * 消费者：ModelCallSpanWriter.startAttempt。
 * 字段口径：attemptNumber 从 1 开始；maxAttempts 为 0 表示无上限；requestId 是
 * 本次传输请求 ID（与 logicalCallId 不同层）；apiOperation 是 wire protocol；
 * attemptCause 用判别联合约束重试必须带 previousRequestId，retryDelayMs 仅
 * 重试/回退可有。
 * 不变量：每次 attempt 必须唯一 requestId；不得复用上一次的 requestId。
 */
export type ModelAttemptTraceStart = {
  /** provider 协议形态。 */
  apiOperation: ModelApiOperationKind;
  /** 本次 attempt 序号，1 起。 */
  attemptNumber: number;
  /** 允许的最大尝试数；0 表示无上限预算。 */
  maxAttempts: number;
  /** 本次传输的请求 ID，跨 attempt 必须唯一。 */
  requestId: string;
  /** 请求侧描述（与逻辑调用共享同一描述）。 */
  target: ResolvedModelTelemetryDescriptor;
  /** 传输类型（HTTP/SSE 等）。 */
  transport: import("../model/index.js").ModelTransportKind;
} & (
  | {
      /** 首次尝试：不得带 previousRequestId/retryDelayMs。 */
      attemptCause: "initial";
      previousRequestId?: never;
      retryDelayMs?: never;
    }
  | {
      /** 重试或回退：必须指向失败的前一个请求，可带退避延迟。 */
      attemptCause: "retry" | "fallback";
      previousRequestId: string;
      retryDelayMs?: number;
    }
);

/**
 * 逻辑调用 span 的写入口：一个 writer 对应一次逻辑调用，可创建多个 attempt。
 *
 * 生产者：ModelExecutionTelemetryPort.startCall 返回。
 * 消费者：模型调用 runner 在生命周期节点调用 finish*。
 * 生命周期：startAttempt* → 恰好一次 finishCompleted/finishFailed/
 * finishAbandoned/finishCancelled；重复 finish 应被实现忽略而非抛错。
 * 不变量：attempt writer 的父子关系由此 writer 建立；writer 方法失败不得
 * 反向中断模型请求（遥测是旁路）。
 */
export interface ModelCallSpanWriter extends AgentTelemetryScope {
  /** 为本次逻辑调用开启一个 attempt 子 span。 */
  startAttempt(input: ModelAttemptTraceStart): ModelAttemptSpanWriter;
  /** 记录发生了回退选择（原调用作废，新调用另行开始）。 */
  markFallbackSelected(reason: string): void;
  /** 逻辑调用成功完成。 */
  finishCompleted(): void;
  /** 逻辑调用最终失败；stage 限逻辑层，category 为受控错误类别。 */
  finishFailed(
    stage: ModelCallFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  /** 缺少终态/进程退出等被动放弃；不是错误。 */
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  /** 用户/超时/关机导致的主动取消。 */
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * 单次 attempt span 的写入口：记录请求/响应/流/用量的细粒度事实。
 *
 * 生产者：ModelCallSpanWriter.startAttempt 返回。
 * 消费者：adapter/runner 在 attempt 生命周期的各节点调用设置方法。
 * 生命周期：同一套 finish* 恰好一次；取消/失败/放弃互斥。
 * 不变量：set* 方法只追加属性，不改变请求；token 字段来自 provider usage
 * （v6 的 input 已含 cache，写入时不得重复相加）；recordRequestObservation
 * 交由发行实现映射，避免契约层依赖 OTel 细节。
 */
export interface ModelAttemptSpanWriter extends AgentTelemetryScope {
  setProviderRequestId(requestId: string): void;
  setResponseModel(model: ResponseModelTelemetryDescriptor): void;
  setEffectiveReasoningState(state: ModelReasoningState): void;
  setEffectiveReasoningControl(control: ModelReasoningControlType): void;
  setEffectiveReasoningLevel(level: string): void;
  setEffectiveReasoningBudgetTokens(tokens: number): void;
  setFinishReason(reason: ModelFinishReason): void;
  setInputTokens(tokens: number): void;
  setOutputTokens(tokens: number): void;
  setReasoningTokens(tokens: number): void;
  setCacheReadTokens(tokens: number): void;
  setCacheWriteTokens(tokens: number): void;
  setStreamOutputCommitted(committed: boolean): void;
  setHttpStatusCode(statusCode: number): void;
  setProviderErrorCode(code: string): void;
  setProviderErrorMessage(message: string): void;
  setRetryAfterMs(delayMs: number): void;
  markFirstProviderEvent(): void;
  markFirstContent(): void;
  markFirstText(): void;
  markStreamStalled(idleMs: number): void;
  /** 请求观测交由发行实现映射到 Attribute 与 Event。 */
  recordRequestObservation(observation: ModelRequestObservation): void;
  finishCompleted(): void;
  finishFailed(
    stage: ModelAttemptFailureStage,
    category: AgentTelemetryErrorCategory,
    error?: unknown,
  ): void;
  finishAbandoned(reason: AgentTelemetryAbandonReason): void;
  finishCancelled(reason: AgentTelemetryCancellationReason): void;
}

/**
 * 模型执行遥测端口：core 每次逻辑调用（含重试）在此开启 span。
 *
 * 生产者：telemetry runtime 实现，注入到 core。
 * 消费者：模型调用 runner 在每次逻辑调用开始时调用 startCall。
 * 不变量：端口是旁路能力，实现不可用时应返回 NOOP writer 而不是抛错；
 * 不得让遥测阻塞或改变模型请求结果。
 */
export interface ModelExecutionTelemetryPort {
  /** 开启一次逻辑调用的 span；其下通过 startAttempt 创建 attempt 子 span。 */
  startCall(input: ModelCallTraceStart): ModelCallSpanWriter;
}

/**
 * 进程级遥测 Owner：同时持有 agent 执行与模型执行两个端口及生命周期控制。
 *
 * 生产者：App 注入或 Standalone 初始化创建；一个 CLI 进程只允许一个实例。
 * 消费者：core/bootstrap 获取端口、关闭时调用 flush/shutdown。
 * 字段口径：enabled 表示遥测是否启用（关闭时端口仍应存在但为 NOOP）；
 * statusSink 是模型网络状态旁路；abandonSession 清理未收尾的 session span。
 * 不变量：flush/shutdown 必须有超时上限且可重复调用；updateIdentity 只更新
 * 后续 span 的身份快照，不回溯已发出的数据。
 */
/**
 * App 注入和 Standalone 初始化共用的进程级 Owner。一个 CLI 进程只能创建一个 Owner。
 */
export interface AgentTelemetryRuntimeOwner {
  /** agent 执行遥测端口（turn/step/tool/command/compaction 等）。 */
  readonly agentExecution: AgentExecutionTelemetryPort;
  /** 遥测总开关；false 时端口仍存在但不应产生数据。 */
  readonly enabled: boolean;
  /** 模型执行遥测端口（call/attempt）。 */
  readonly modelExecution: ModelExecutionTelemetryPort;
  /** 模型网络状态旁路；失败不得影响主链路。 */
  readonly statusSink?: import("../model/index.js").ModelStatusSink;
  /** 放弃某 session 下所有未收尾的 span（进程退出/会话关闭时）。 */
  abandonSession(sessionId: string): void;
  /** 刷出缓冲数据，带超时上限；可重复调用。 */
  flush(options?: { timeoutMs?: number }): Promise<void>;
  /** 关闭遥测并释放资源；应幂等且不阻塞主流程过久。 */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
  /** 更新进程级身份快照，仅作用于之后的 span。 */
  updateIdentity(snapshot: TelemetryIdentitySnapshot): void;
}

/**
 * 面向用量/调用记录的描述符：已解析的观测 + 稳定 provider/model 标识。
 *
 * 生产者：core 在记录 usage fact 或调用记录时组合。
 * 消费者：用量落库/遥测事件，按 providerId/modelId 归因。
 * 字段口径：observation 的 operation/actorKind/logicalCallId 必填（与
 * resolveModelApiCallObservation 输出一致）；providerId/modelId 是稳定标识，
 * 不得替换成显示名。
 * 不变量：同一逻辑调用的 descriptor 应复用同一 observation.logicalCallId。
 */
export interface ModelApiCallDescriptor {
  /** 已解析的调用观测，三个分类字段保证存在。 */
  observation: Required<
    Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">
  > &
    ModelApiCallObservation;
  /** 稳定的 provider 标识，用于归因/计费主键。 */
  providerId: ModelProviderId;
  /** 稳定的模型标识，用于归因/计费主键。 */
  modelId: ModelId;
}
