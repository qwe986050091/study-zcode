// ============================================================
// Core Errors - Error types for the agent loop
// ============================================================
//
// 横向能力：agent loop、工具执行、模式/hook、恢复链共用的稳定错误判别。
// 生产者：core 的 runtime/tool/subagent/hooks 在能归类的失败点 createCoreError；
// 消费者：重试决策（isRetryable）、hook 结果映射（type → TimedOut/Cancelled）、
// 工具结果序列化、错误载荷投影（error-payload.ts）与 CLI 入口的退出处理。
// 不变量：调用方只能按 type / code / recoverable / retryable / context 做分支，
// 绝不能依赖 message 文本——文案会本地化、改写，且跨进程后可能被截断。
// 跨进程/持久化：Error 实例本身不可 JSON 化；序列化时只带 type、code、message、
// recoverable、retryable、context，timestamp 需转成字符串，cause 由投影层展开成帧。

// -----------------------------------------------
// Error Types
// -----------------------------------------------

// 稳定的错误类型码，按域分组（session/turn/model/tool/permission/state/system）。
// 这些字符串会进入事件、工具结果与遥测，新增/改名必须保证消费端与聚合口径同步；
// 持久化与协议里只认这个值，不认 JS 构造函数名（压缩后的类名不可靠）。
export const CoreErrorType = {
  // Session errors
  SessionNotFound: "session_not_found",
  SessionAlreadyExists: "session_already_exists",
  SessionCorrupted: "session_corrupted",

  // Turn errors
  TurnNotFound: "turn_not_found",
  TurnInProgress: "turn_in_progress",
  InvalidTurnPhase: "invalid_turn_phase",
  TurnCancelled: "turn_cancelled",

  // Model errors
  ModelError: "model_error",
  ModelTimeout: "model_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",

  // Tool errors
  ToolNotFound: "tool_not_found",
  ToolExecutionFailed: "tool_execution_failed",
  ToolTimeout: "tool_timeout",
  ToolCancelled: "tool_cancelled",
  ToolMaxCalls: "tool_max_calls",
  InvalidInput: "invalid_input",

  // Permission errors
  PermissionDenied: "permission_denied",
  PermissionEscalation: "permission_escalation",
  PermissionTimeout: "permission_timeout",

  // State errors
  InvalidStateTransition: "invalid_state_transition",
  EventOutOfOrder: "event_out_of_order",
  ProjectionCorrupted: "projection_corrupted",

  // System errors
  StorageError: "storage_error",
  ConfigurationError: "configuration_error",
  Cancelled: "cancelled",
  UnknownError: "unknown_error",
} as const;

// CoreErrorType 的取值联合。
export type CoreErrorType = (typeof CoreErrorType)[keyof typeof CoreErrorType];

// -----------------------------------------------
// Core Error
// -----------------------------------------------

// 结构化核心错误：在原生 Error 上附加稳定字段。
// type 是判分支的权威（见上）；code 目前由 type 大写派生，仅供展示/兼容，不要用它做等价判断；
// message 只面向人读；cause 保留原始下层的 Error/异常，供错误链投影展开；
// context 承载结构化归因（sessionId/toolName/provider/model/statusCode/retryable 等），
// 必须保持可 JSON 化，禁止放入 Error 实例、函数或大段原文；
// recoverable=调用方仍有可行恢复路径；retryable=同一操作可安全重试（重试前需确认幂等）；
// timestamp 是构造时刻，序列化时会被转成 ISO 字符串。
// 跨进程序列化后不应再假设它是 Error 实例，接收端需按普通对象读取这些字段。
export interface CoreError extends Error {
  type: CoreErrorType;
  code: string;
  message: string;
  cause?: Error;
  context?: Record<string, unknown>;
  recoverable: boolean;
  retryable: boolean;
  timestamp: Date;
}

// -----------------------------------------------
// Error Factory
// -----------------------------------------------

// 唯一的核心错误构造入口：保证四个判别字段齐全，避免各处手搓形状不一致。
// code 由 type.toUpperCase() 派生（其中的 replace 是恒等映射），因此 code 目前与 type 同源，
// 判别时以 type 为准；recoverable/retryable 默认 false，属于“失败即终止”的安全默认值，
// 需要重试的调用点（如 toolExecutionFailed）必须显式打开 retryable。
export function createCoreError(
  type: CoreErrorType,
  message: string,
  options?: {
    cause?: Error;
    context?: Record<string, unknown>;
    recoverable?: boolean;
    retryable?: boolean;
  },
): CoreError {
  const error = new Error(message) as CoreError;
  error.type = type;
  error.code = type.toUpperCase().replace(/_/g, "_");
  error.cause = options?.cause;
  error.context = options?.context;
  error.recoverable = options?.recoverable ?? false;
  error.retryable = options?.retryable ?? false;
  error.timestamp = new Date();
  return error;
}

// -----------------------------------------------
// Error Predicates
// -----------------------------------------------

// 结构判别：只检查是否存在 type 与 code，不做 instanceof（跨 realm、跨进程反序列化会失败）。
// 因此普通对象只要伪造了这两个字段也会命中；调用方读取 recoverable/retryable 时应按 undefined
// 视为 false，不能把缺失字段当成 true。
export function isCoreError(error: unknown): error is CoreError {
  return error instanceof Error && "type" in error && "code" in error;
}

// 重试判定：只看 retryable 标记，不推断错误类型。
// 工具/hook 等破坏性操作在打开此标记前必须确认幂等，否则会把副作用重复执行。
export function isRetryable(error: CoreError): boolean {
  return error.retryable;
}

// 可恢复判定：表示上层还有补救路径（补上下文、降级、换模型等），与“可重试”不是同义词。
export function isRecoverable(error: CoreError): boolean {
  return error.recoverable;
}

// -----------------------------------------------
// Specific Error Creators
// -----------------------------------------------

// 具体错误构造函数负责冻结 context 字段名，消费端据此读取，不要临时加键。
// sessionNotFound：context.sessionId 是被查找的会话 id；recoverable=true（可换会话/新建）。
export function sessionNotFound(sessionId: string): CoreError {
  return createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${sessionId}`, {
    context: { sessionId },
    recoverable: true,
  });
}

// invalidTurnPhase：context.current/expected 记录实际阶段与允许阶段；状态机判断失败，可恢复。
export function invalidTurnPhase(current: string, expected: string[]): CoreError {
  return createCoreError(CoreErrorType.InvalidTurnPhase, `Invalid turn phase: ${current}`, {
    context: { current, expected },
    recoverable: true,
  });
}

// toolNotFound：context.toolName 保留模型请求的名字；不可恢复（重试同一名字无意义），
// 上层应把它转成模型可见的“工具不存在”结果，而不是崩溃。
export function toolNotFound(toolName: string): CoreError {
  return createCoreError(CoreErrorType.ToolNotFound, `Tool not found: ${toolName}`, {
    context: { toolName },
    recoverable: false,
  });
}

// toolExecutionFailed：context.toolName + 原始 cause（保留根因供错误链投影）。
// recoverable/retryable 都为 true，意味着 auto compact 等重试策略会把这类失败视作可重试；
// 非幂等工具应在自己的执行层把 retryable 关掉，不能依赖本函数。
export function toolExecutionFailed(toolName: string, cause?: Error): CoreError {
  return createCoreError(CoreErrorType.ToolExecutionFailed, `Tool execution failed: ${toolName}`, {
    cause,
    context: { toolName },
    recoverable: true,
    retryable: true,
  });
}

// permissionDenied：context.toolName/reason 记录被拒对象与原因；可恢复（换工具/申请授权），
// 但不可重试（同一请求重试只会再次被拒，必须经过用户审批）。
export function permissionDenied(toolName: string, reason?: string): CoreError {
  return createCoreError(CoreErrorType.PermissionDenied, `Permission denied: ${toolName}`, {
    context: { toolName, reason },
    recoverable: true,
    retryable: false,
  });
}
