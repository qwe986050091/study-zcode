// INV-01 本文件只声明签名：守住位置 模块边界；改错故障 实现被误放进类型文件。
// INV-02 所有方法以运行时内部类型作为 this：守住位置 调用纪律；改错故障 独立函数拿不到私有成员。
// INV-03 同步段内不得跨 await 修改队列或 activeTurn 快照：守住位置 方法契约；改错故障 并发起轮状态错乱。
// INV-04 跨 await 的调度必须走预留或租约：守住位置 租约类方法；改错故障 tick 窗口内重复启动。
// INV-05 同一时刻只有一个 activeTurn：守住位置 begin 前置条件；改错故障 两轮并行写同一会话。
// INV-06 begin 与 finish 成对调用：守住位置 生命周期方法；改错故障 activeTurn 泄漏。
// INV-07 reserve 与 release 成对调用：守住位置 启动预留方法；改错故障 busy 位永久占用。
// INV-08 繁忙判定综合前台多维事实：守住位置 单一判定方法；改错故障 只看单一字段漏判。
// INV-09 前台提升租约必须显式释放：守住位置 租约接口；改错故障 后续 turn 无法提升。
// INV-10 异步结果只入队不直接起 turn：守住位置 通知与子代理入口；改错故障 绕过队列打乱顺序。
// INV-11 暂停项操作一律按 pendingInputId 定位：守住位置 五个操作方法；改错故障 误改其他输入。
// INV-12 变更暂停项需 reservationId 关闭竞态：守住位置 预留类方法；改错故障 提升与删除相互覆盖。
// INV-13 drain 只在 turn 内调用：守住位置 方法注释；改错故障 冷恢复重放导致重复注入。
// INV-14 工具面缓存必须由显式失效回收：守住位置 invalidateToolCache；改错故障 配置变更后仍发旧声明。
// INV-15 MCP 启动为两段式：守住位置 startMcpStartup 返回结构；改错故障 启动阻塞首个事件。
// INV-16 上下文初始化失败让本轮直接失败：守住位置 ensureContextInitialized；改错故障 静默用空上下文请求。
// INV-17 冷恢复按固定装配顺序重建内存态：守住位置 resumeFromStore；改错故障 历史与目标不一致。
// INV-18 Goal 读写都经会话存储：守住位置 目标类方法；改错故障 内存态与持久态分叉。
//
// 模块职责：声明运行时核心方法的类型契约，覆盖配置、steering、队列、通知、工具面与目标。
// 状态所有权：无运行时状态；所有成员由 AgentRuntime 实例持有并在实现文件中维护。
// 阅读顺序：先看配置与 steering，再读队列与繁忙判定，最后看工具面、模型请求与目标。
import type {
  CollaborationMode,
  Model,
  ModelInputMessage,
  ModelSelection,
  ModelSelectionOrigin,
  ModelUsageSummary,
  ModelStreamingPayload,
  ModelToolCall,
  ModelToolContract,
  MessageId,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SkillLoadOutcome,
  SubagentPort,
  TodoItem,
  SessionGoal,
  McpConnectionSnapshot,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnId,
  ContextSourceSnapshot,
  TurnState,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ExecutionShellSelection,
} from "./deps.js";
import type { BackgroundResultOriginMeta, ContextUsageBreakdownItem } from "@zcode/contracts";
import type { RuntimeCommand, RuntimeCommandId } from "./command-queue.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  ActiveTurnInfo,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnKind,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContextUsageCategory,
  ContextUsageConfidence,
  ContextUsageMetric,
  ContextUsageMessageRoleBreakdown,
  ContextUsageSkillDetail,
  ContextUsageToolDetail,
  ContinueActiveTargetLoopOptions,
  DrainedPendingInputDiagnostics,
  ForegroundPromotionLeaseMode,
  EnqueueSubagentMessageInput,
  ResumeSessionOptions,
  ResumeSessionResult,
  RunModelTextRequestOptions,
  RuntimeModelTextResult,
  SealBackgroundTaskNotificationsInput,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
} from "./types.js";

/**
 * ============================================================================
 * runtime/internal-methods.ts —— runtime 核心方法契约(非 turn / 非 hook)
 * ============================================================================
 *
 * 【定位】这里只声明签名,实现在 runtime/methods/*.ts,由
 * installAgentRuntimeMethods 挂到 AgentRuntime.prototype;internal.ts 用交叉类型
 * 把它并入 AgentRuntimeInternal,供独立实现函数以 `this` 访问。
 *
 * 【职责分组】
 *   1) 配置/会话级事实:mode、模型选择、工作目录、持久化状态;
 *   2) steering 与 pending input:activeTurn 建立/结束、行内注入、暂停项增删改;
 *   3) runtime command 队列:入队、drain、residency 与前台执行所有权;
 *   4) 通知与子代理回传:封装成命令,不直接起 turn;
 *   5) 工具面/上下文/MCP:缓存失效、懒初始化、回合边界刷新;
 *   6) 模型请求与上下文用量诊断;
 *   7) 冷恢复与 Goal 状态读写。
 *
 * 【调用纪律】所有方法都以 `this: AgentRuntimeInternal` 运行,同步段内不得
 * 跨 await 修改队列/activeTurn 快照;需要跨 await 的调度必须走 reservation 或 lease。
 * ============================================================================
 */
// AgentRuntimeCoreMethods 只声明签名，实现散落在 runtime/methods/*.ts，由 installAgentRuntimeMethods 挂到
// AgentRuntime.prototype；internal.ts 用交叉类型并入 AgentRuntimeInternal，独立实现函数才能以 this: AgentRuntimeInternal 访问私有成员；
// 本文件不 import 任何实现模块，只依赖 deps.js/types.js 的类型，避免声明文件把实现拉进类型依赖图。
export interface AgentRuntimeCoreMethods {
  // ---- 配置与会话级事实:内存 config 是唯一运行期来源,持久化经 execution-state。
  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  setWorkingDirectory(cwd: string): void;
  // ---- 外部活动与标题:让"没跑 turn 的外部输入"也能把会话从 draft 推进。
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  // ---- steering 与 activeTurn:同一时刻只有一个 activeTurn;begin/finish 成对调用。
  // enqueueDeferredInput 是异步结果进入运行时的唯一入口：它把 TurnSteerInput 放进队列后立即尝试消费，
  // 消费单飞，重复调用是安全 no-op；拒绝时返回带稳定 reason 的 TurnSteerResult，
  // 成功则回传可追踪的 inputId；调用方不得绕过它直接起 turn（INV-10）。
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /**
   * 建立本轮的 activeTurn(steering 状态容器)。
   * 输入:turnId / traceContext / kind(regular|compact|rewind)/ 是否可 steer / inputId。
   * 输出:activeTurn 状态对象(同时也是 runtime.activeTurn 的引用)。
   * 失败语义:已有 activeTurn 时调用方必须先 finish,否则属于并发起轮,不得静默覆盖。
   * 不变量:goal 提醒的 deferral 只在 regular loop 内打开,退出 loop 前关闭。
   */
  beginActiveTurn(
    turnId: TurnId,
    traceContext: TraceContext,
    kind: ActiveTurnKind,
    steerable: boolean,
    options?: { inputId?: string },
  ): ActiveTurnSteeringState;
  /**
   * admission 阶段预留"即将开始的 turn":在 beginActiveTurn 之前就占住 busy 位,
   * 关闭"命令已入队但 activeTurn 尚未建立"的竞态窗口。release 必须与 reserve 成对。
   */
  reserveTurnStart(turnId: TurnId, traceContext: TraceContext, kind: ActiveTurnKind): void;
  releaseTurnStart(turnId: TurnId): void;
  /** 结束本轮:清空 activeTurn 并处理残留 pendingInput(丢弃/回落队列由调用方语义决定)。 */
  finishActiveTurn(activeTurn: ActiveTurnSteeringState | undefined): void;
  createPendingInputId(turnId: TurnId): string;
  rejectTurnSteer(
    reason: TurnSteerRejectReason,
    options: {
      activeTurn?: ActiveTurnSteeringState;
      expectedTurnId?: TurnId;
      inputPreview?: string;
      inputSize?: number;
      traceContext?: TraceContext;
    },
  ): Promise<TurnSteerResult>;
  hasPendingInput(activeTurn: ActiveTurnSteeringState): boolean;
  hasInlineGuidePendingInput(activeTurn: ActiveTurnSteeringState): boolean;
  fallbackPendingGuidesToQueue(options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  }): Promise<number>;
  /**
   * 把 activeTurn 里的待注入输入(guide)在模型步边界写入 canonical 历史。
   * 输出含 messageIds / runtimeEntries / intent / toolDisallowlist,供本轮继续使用;
   * 必须在 turn 内调用(冷恢复不会重放 drain 结果),失败时 pending 项保持原样。
   */
  drainPendingInput(options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  }): Promise<DrainedPendingInputDiagnostics | undefined>;
  /** 入队后立即尝试 drain(不等待);drain 单飞,重复调用是安全的 no-op。 */
  enqueueRuntimeCommand(command: RuntimeCommand): void;
  drainRuntimeCommandQueue(): Promise<void>;
  // ---- busy 真相与常驻池:三类事实分别回答"是否还有前台/后台/登记中的 work"。
  /**
   * 前台维度:lease / 前台执行 / drain 中 / 队列非空 / activeTurn / 启动预留,
   * 任一为真即 busy。常驻池与 admission 都以它为准,不看单一字段。
   */
  // 前台繁忙综合租约与队列判断。
  // activeTurn 存在即视为繁忙。
  // hasResidencyBlockingWork 走独立判定，不看 hasActiveOrQueuedTurnWork 的启动预留。
  // 该结果决定是否允许启动新 turn。
  hasActiveOrQueuedTurnWork(): boolean;
  hasResidencyBlockingWork(): boolean;
  /** 登记跨同步栈的 runtime-owned work;计数在本同步片 +1,promise finally -1。 */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  // ---- 异步结果入口:通知与子代理回传只入队,由队列决定何时起 turn。
  enqueueBackgroundTaskNotification(notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  }): void;
  enqueueSubagentMessage(input: EnqueueSubagentMessageInput): undefined;
  drainPendingRuntimeCommandsForActiveLoop(): Promise<{
    backgroundSubagentResultConsumed: boolean;
    workflowResultConsumed: boolean;
    consumedCommandIds: RuntimeCommandId[];
    drained: number;
    messageIds: MessageId[];
    runtimeEntries: readonly RuntimeMessageEntry[];
  }>;
  sealBackgroundTaskNotifications(input: SealBackgroundTaskNotificationsInput): void;
  discardPendingInput(options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  }): Promise<void>;
  // ---- 暂停项操作:全部按 pendingInputId 定位,reservationId 用于关闭竞态。
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  }): Promise<boolean>;
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  }): Promise<boolean>;
  // ---- 会话级队列模式:autoDrain(是否自动消费)与 followup 路由(queue/guide)。
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext: TraceContext }): Promise<void>;
  completeExternalQueueDrain(): void;
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext: TraceContext }): Promise<void>;
  // ---- 配置投影补发:模型/模式变化后让 UI 的 config 投影跟上,不改变执行事实。
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  }): Promise<void>;
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  discardPersistedPendingSteerInputs(traceContext: TraceContext): Promise<number>;
  /** held 项按 id 丢弃（held 回落）：active turn 结束后经投影定位补 TurnSteerDiscarded。 */
  // 口径:reservationId 在场时只允许"持有该 reservation"的调用方丢弃;id 已被新 reservation
  // 接管则返回 false。找不到 held 项也返回 false,不制造空事件。成功 = 写 TurnSteerDiscarded
  // 事件 + 清 reservation,让投影与内存队列收敛。
  discardHeldPendingInputById(
    pendingInputId: string,
    traceContext: TraceContext,
    reservationId?: string,
    reason?: "user_removed" | "promoted",
  ): Promise<boolean>;
  /** 清空全部排队输入（clearQueueAndSend 执行件），返回丢弃条数。 */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  // ---- 工具面:getTools 返回"本次发给 provider 的声明",其结果可被 cachedTools 缓存。
  createDefaultSubagentPort(deps: AgentRuntimeDeps): SubagentPort | undefined;
  getTools(model?: Model): ModelToolContract[];
  invalidateToolCache(): void;
  getToolRegistry(): ToolRegistry;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  getContextBuilder(): ContextBuilder;
  // ---- 上下文装配:懒初始化 + 快照构建;初始化失败会让本轮请求直接失败(不静默降级)。
  ensureContextInitialized(traceContext: TraceContext, model?: Model): Promise<void>;
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  createContextBuilderFromSnapshot(
    snapshot: ContextSourceSnapshot,
    memoryRoot?: string,
    options?: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean },
  ): ContextBuilder;
  loadProjectMemoryRoot(traceContext: TraceContext): Promise<string | undefined>;
  logMemorySkipped(
    traceContext: TraceContext,
    reason: string,
    context?: Record<string, unknown>,
  ): void;
  injectPluginReferenceReminderFromTurn(
    userInput: string,
    traceContext: TraceContext,
    toolDisallowlist?: readonly string[],
  ): Promise<void>;
  // ---- MCP:startup 两段式(先返回等待中的 promise,再由 turn 边界 await);
  // refresh 只在签名变化时重注册工具,刷新失败不推进 revision。
  // MCP 启动为两段式：startMcpStartup 先返回仍在等待的 Promise<McpConnectionSnapshot>，未启动时返回 undefined，
  // 由 turn 边界 await，避免阻塞首个事件；refreshMcpToolsIfChanged 只在工具签名变化时重注册，
  // 刷新失败不推进 revision，下一轮还会重试；McpConnectionSnapshot 供界面展示连接状态。
  startMcpStartup(traceContext: TraceContext): Promise<McpConnectionSnapshot> | undefined;
  initializeMcp(traceContext: TraceContext): Promise<void>;
  refreshMcpToolsIfChanged(traceContext: TraceContext): Promise<void>;
  discoverSkillsForContext(traceContext: TraceContext): Promise<SkillLoadOutcome | undefined>;
  createConfigOnlyContextSnapshot(workingDirectory: string): ContextSourceSnapshot;
  initializeMessageHistoryFromContext(
    contextBuilder: ContextBuilder,
    traceContext: TraceContext,
  ): void;
  extractToolCallsFromResult(result: any): ModelToolCall[];
  // ---- 模型请求:stream 开关 + 一次请求的完整生命周期(流式事件、恢复、usage)。
  shouldStreamModelText(): boolean;
  /**
   * 发起一次模型文本请求(可能流式)。输入含消息、工具声明、取消信号与流式回调;
   * 输出文本/推理/工具调用/用量/结束原因。副作用:写 events(用于事件流与投影),
   * 通过回调把增量交给上层落 part;失败时抛 provider 错误,由 turn-model-step 的
   * 恢复链(selection fallback → stream recovery → off-peak → 取消 → reactive compact)处理。
   */
  runModelTextRequest(options: RunModelTextRequestOptions): Promise<RuntimeModelTextResult>;
  logContextUsageSnapshot(
    options: RunModelTextRequestOptions,
    snapshot?: Record<string, unknown>,
  ): void;
  logModelRequestSteeringContext(options: {
    activeTurn?: ActiveTurnSteeringState;
    drained?: DrainedPendingInputDiagnostics;
    messages: ModelInputMessage[];
    modelStepCount: number;
    traceContext: TraceContext;
  }): void;
  buildModelMessageTailDiagnostics(
    messages: ModelInputMessage[],
    limit?: unknown,
  ): Array<Record<string, unknown>>;
  buildContextUsageSnapshot(options: RunModelTextRequestOptions): Record<string, unknown>;
  buildContextUsageBreakdownFromSnapshot(
    snapshot: Record<string, unknown>,
  ): ContextUsageBreakdownItem[];
  buildContextUsageCategory(
    name: ContextUsageCategory["name"],
    source: ContextUsageCategory["source"],
    metric: ContextUsageMetric,
  ): ContextUsageCategory;
  buildToolUsageDetail(tool: ModelToolContract): ContextUsageToolDetail;
  buildSkillUsageDetails(): ContextUsageSkillDetail[];
  buildMessageRoleBreakdown(
    messages: RunModelTextRequestOptions["messages"],
  ): ContextUsageMessageRoleBreakdown[];
  estimatedMetric(content: string, confidence: ContextUsageConfidence): ContextUsageMetric;
  estimatedMetricFromKnown(
    chars: number,
    tokens: number,
    confidence: ContextUsageConfidence,
  ): ContextUsageMetric;
  sumMetrics(
    values: Array<Pick<ContextUsageMetric, "chars" | "tokens">>,
    confidence: ContextUsageConfidence,
  ): ContextUsageMetric;
  emitModelStreamingEvent(
    payload: ModelStreamingPayload,
    traceContext: TraceContext,
    events: SessionEvent[],
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
  toScheduleState(schedule: ToolSchedule): TurnState["scheduledTools"];
  // ---- 冷恢复与 Goal:resume 按固定装配顺序重建内存态;Goal 读写都经 session store。
  // resumeFromStore 按固定装配顺序重建内存态：先恢复消息历史（initializeMessageHistoryFromContext），
  // 再注入目标与待办（readSessionTodosForContext/readSessionTargetForContext → injectTargetStateIntoMessageHistory），
  // 顺序反转会让目标提醒落在旧历史上；恢复完成后 activeTurn 保持为空，返回值带恢复结论与诊断。
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  readSessionTodosForContext(traceContext: TraceContext): Promise<TodoItem[]>;
  readSessionTargetForContext(traceContext: TraceContext): Promise<SessionGoal | null>;
  injectTargetStateIntoMessageHistory(target: SessionGoal | null): void;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    traceContext?: TraceContext;
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  targetContinuationCandidate(traceContext: TraceContext): Promise<SessionGoal | null>;
  accountTargetTurnCompletion(input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
    usage?: ModelUsageSummary;
  }): Promise<void>;
  startTargetTurnAccounting(input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  }): Promise<SessionGoal | null>;
  heartbeatTargetTurnAccounting(input: {
    inputID: string;
    seenAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  }): Promise<void>;
  finishTargetTurnAccounting(input: {
    inputID: string;
    endedAtMs: number;
    startedTarget: SessionGoal | null;
    status?: "paused";
    traceContext: TraceContext;
  }): Promise<SessionGoal | null>;
  pauseActiveTargetForCancellation(traceContext: TraceContext): Promise<void>;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
}
