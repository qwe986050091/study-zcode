/**
 * ============================================================================
 * telemetry/runtime-telemetry.ts —— 运行时遥测门面（facade）
 * ============================================================================
 *
 * 【定位】core 不直接依赖具体遥测实现（OTel/日志/无），而是统一经由本门面
 * 获取各类 span writer。好处：
 *   - 测试/无遥测环境用 NOOP 实现，业务代码零分支；
 *   - actorKind / launchSurface / causation 等"身份字段"只在这里组装一次，
 *     避免每个调点各写一套、口径漂移。
 *
 * 【span 层级】turn → step →（tool / model call → attempt）/ compaction / detached。
 *   - detached：脱离当前 turn 生命周期的异步操作（后台任务、子代理等），
 *     需要显式捕获 causation，否则调用链会断在 trace 边界；
 *   - attempt：一次模型请求的重试单位，call 是逻辑请求，attempt 是物理尝试。
 *
 * 【空实现的意义】NOOP_* 不是"占位待补"，而是产品能力：无遥测配置时
 * 所有 writer 方法都是空操作，run() 直接执行回调，captureCausation 返回 undefined。
 * 新增 writer 方法时必须同步补 NOOP 实现，否则无遥测环境会运行时报错。
 * ============================================================================
 */

import type {
  AgentExecutionTelemetryPort,
  AgentStepSpanWriter,
  AgentTelemetryActorKind,
  AgentTelemetryCausation,
  AgentTelemetryLaunchSurface,
  AgentTurnSpanWriter,
  CommandExecutionSpanWriter,
  CompactionTraceStart,
  ContextCompactionSpanWriter,
  DetachedOperationSpanWriter,
  DetachedOperationTraceStart,
  MessageId,
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  SessionId,
  SessionTaskType,
  SyntheticUserMessageSource,
  ToolExecutionSpanWriter,
  TraceContext,
} from "@zcode/contracts";

interface RuntimeTelemetryFacadeOptions {
  agentName?: string;
  causation?: AgentTelemetryCausation;
  causationMode?: "child" | "linked_root";
  launchSurface?: AgentTelemetryLaunchSurface;
  parentSessionId?: SessionId;
  port?: AgentExecutionTelemetryPort;
  sessionId: SessionId;
  taskType?: SessionTaskType;
}

/**
 * 门面实例：一次 agent 运行（session）持有一个。
 *
 * 不可变字段（actorKind/launchSurface/parentSessionId/parentTurnId）在构造时
 * 定格：运行中切模型/切任务类型不应改变已发生 span 的归属，
 * 否则同一条 trace 里会出现互相矛盾的 actor 标签。
 */
export class RuntimeTelemetryFacade {
  readonly port: AgentExecutionTelemetryPort;
  readonly actorKind: AgentTelemetryActorKind;
  private readonly agentName?: string;
  private readonly causation?: AgentTelemetryCausation;
  private readonly causationMode?: "child" | "linked_root";
  private readonly launchSurface: AgentTelemetryLaunchSurface;
  private readonly parentSessionId?: string;
  private readonly parentTurnId?: string;
  private readonly sessionId: SessionId;

  constructor(options: RuntimeTelemetryFacadeOptions) {
    this.port = options.port ?? NOOP_AGENT_EXECUTION_TELEMETRY;
    this.actorKind = actorKindFromTaskType(options.taskType);
    this.agentName = options.agentName;
    this.causation = options.causation;
    this.causationMode = options.causationMode;
    this.launchSurface = options.launchSurface ?? "standalone_cli";
    this.parentSessionId = options.parentSessionId ?? options.causation?.sessionId;
    this.parentTurnId = options.causation?.turnId;
    this.sessionId = options.sessionId;
  }

  /**
   * 捕获"当前遥测上下文"。detached 操作用它把因果链从发起时刻带到异步完成时刻；
   * 无遥测实现时返回 undefined，调用方必须允许空 causation。
   */
  captureCausation(): AgentTelemetryCausation | undefined {
    return this.port.captureCausation();
  }

  /**
   * 开启一个 turn span。
   *
   * inputSource 缺省归一化为 "user"：合成输入（后台结果/目标续跑）必须显式
   * 传入来源，否则会被统计成真实用户消息，污染 engagement 指标。
   */
  turn(input: {
    inputSource?: SyntheticUserMessageSource;
    traceContext: TraceContext;
    turnNumber: number;
  }): AgentTurnSpanWriter {
    return this.port.startTurn({
      causation: this.causation,
      causationMode: this.causationMode,
      context: this.executionContext(input.traceContext),
      inputSource: normalizeInputSource(input.inputSource),
      turnNumber: input.turnNumber,
    });
  }

  // 模型步 span：stepId 是 assistant 消息 id，stepIndex 是 turn 内序号。
  // port 需要自己维护父子关系（step 属于最近开启的 turn）。
  step(input: { stepId: MessageId; stepIndex: number }): AgentStepSpanWriter {
    return this.port.startStep({
      stepId: input.stepId,
      stepIndex: input.stepIndex,
    });
  }

  compaction(
    input: CompactionTraceStart & { traceContext?: TraceContext },
  ): ContextCompactionSpanWriter {
    return this.port.startCompaction(input);
  }

  /**
   * detached 操作 span（后台任务、异步子代理等）。
   *
   * causation 优先用调用方显式传入的（跨进程/延迟任务需要持久化后的 causation），
   * 否则现场捕获；context 一定由本门面生成，保证 actor/launchSurface 口径一致。
   */
  detached(
    input: Omit<DetachedOperationTraceStart, "causation" | "context"> & {
      causation?: AgentTelemetryCausation;
      traceContext: TraceContext;
    },
  ): DetachedOperationSpanWriter {
    return this.port.startDetachedOperation({
      ...input,
      causation: input.causation ?? this.captureCausation(),
      context: this.executionContext(input.traceContext),
    });
  }

  /**
   * 组装 span 的执行上下文。
   *
   * sessionId 以 traceContext 为准、门面持有的作为兜底：子会话/子代理会在
   * traceContext 里带自己的 sessionId，若反向覆盖会把它记到父会话名下。
   */
  private executionContext(traceContext: TraceContext) {
    return {
      actorKind: this.actorKind,
      agentName: this.agentName,
      launchSurface: this.launchSurface,
      parentSessionId: this.parentSessionId,
      parentTurnId: this.parentTurnId,
      queryId: traceContext.queryId,
      sessionId: traceContext.sessionId ?? this.sessionId,
      turnId: traceContext.turnId,
    };
  }
}

// NOOP span 的公共基座：run 直接执行（保证业务副作用照常发生），
// captureCausation 返回 undefined（表示"没有可传播的遥测上下文"）。
const NOOP_SCOPE = {
  captureCausation: () => undefined,
  run: <T>(execute: () => T): T => execute(),
};

const NOOP_COMMAND: CommandExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishBackgrounded() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstOutput() {},
  markTerminationRequested() {},
  setExitCode() {},
  setOutputBytes() {},
  setSignal() {},
  setTimedOut() {},
};

const NOOP_TOOL: ToolExecutionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDenied() {},
  finishFailed() {},
  markPermissionRequested() {},
  setOutputBytes() {},
  setOutputTruncated() {},
  setPermissionDecision() {},
  startCommand: () => NOOP_COMMAND,
};

const NOOP_STEP: AgentStepSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
};

const NOOP_TURN: AgentTurnSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
};

const NOOP_COMPACTION: ContextCompactionSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishDiscarded() {},
  finishFailed() {},
  markFallbackSelected() {},
  setInputTokens() {},
  setOutputTokens() {},
};

const NOOP_DETACHED: DetachedOperationSpanWriter = {
  ...NOOP_SCOPE,
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  setResultType() {},
};

const NOOP_ATTEMPT: ModelAttemptSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFirstContent() {},
  markFirstProviderEvent() {},
  markFirstText() {},
  markStreamStalled() {},
  recordRequestObservation() {},
  setCacheReadTokens() {},
  setCacheWriteTokens() {},
  setEffectiveReasoningBudgetTokens() {},
  setEffectiveReasoningControl() {},
  setEffectiveReasoningLevel() {},
  setEffectiveReasoningState() {},
  setFinishReason() {},
  setHttpStatusCode() {},
  setInputTokens() {},
  setOutputTokens() {},
  setProviderErrorCode() {},
  setProviderErrorMessage() {},
  setProviderRequestId() {},
  setReasoningTokens() {},
  setResponseModel() {},
  setRetryAfterMs() {},
  setStreamOutputCommitted() {},
};

const NOOP_CALL: ModelCallSpanWriter = {
  ...NOOP_SCOPE,
  finishAbandoned() {},
  finishCancelled() {},
  finishCompleted() {},
  finishFailed() {},
  markFallbackSelected() {},
  startAttempt: () => NOOP_ATTEMPT,
};

const NOOP_AGENT_EXECUTION_TELEMETRY: AgentExecutionTelemetryPort = {
  abandonSession() {},
  captureCausation() {
    return undefined;
  },
  startCompaction() {
    return NOOP_COMPACTION;
  },
  startDetachedOperation() {
    return NOOP_DETACHED;
  },
  startStep() {
    return NOOP_STEP;
  },
  startTool() {
    return NOOP_TOOL;
  },
  startTurn() {
    return NOOP_TURN;
  },
};

/**
 * taskType → 遥测 actor 类别。
 *
 * 与 turn-model-step-usage.querySourceForTask 是同一套映射的不同投影：
 * 前者决定"span 属于谁"，后者决定"用量记在哪个 querySource 下"。
 * 两处必须保持一致，否则同一子代理在 trace 与用量表里会对不上账。
 */
function actorKindFromTaskType(taskType: SessionTaskType | undefined): AgentTelemetryActorKind {
  if (taskType === "subagent_child") return "subagent";
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return "workflow_child";
  }
  return "main";
}

// 缺省输入来源 = 真实用户。合成来源（后台结果/目标续跑/子代理）必须显式传值。
function normalizeInputSource(
  inputSource: SyntheticUserMessageSource | undefined,
): "user" | SyntheticUserMessageSource {
  return inputSource ?? "user";
}
