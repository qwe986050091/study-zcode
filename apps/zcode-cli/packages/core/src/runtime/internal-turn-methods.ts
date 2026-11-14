// ============================================================================
// runtime/internal-turn-methods.ts —— 一轮对话的方法分发契约面（纯签名，无实现）
// 实现由 installAgentRuntimeMethods 注入；签名与实现脱节时结构类型不会在装配点报错，
// 只会在运行时表现为方法缺失或参数错配，因此本文件逐条固化事件顺序、并发竞态、
// 取消传播、错误降级与持久化边界，作为实现侧与调用侧的共同验收清单。
// 调用顺序错误不会编译报错，只能靠下面的 INV 在评审与测试中拦住。
// ============================================================================
// INV-01 准入必须在同一同步段内判定 busy、建立 reservation 并决定 start/steer/queue；守住位置：admitPrompt 与其返回的 PromptAdmissionReceipt；改错故障：两个并发 prompt 同时看到 idle，同一会话出现两条交错 turn。
// INV-02 一次准入只产生一个 activeTurn 槽位，执行侧不得二次判定；守住位置：executeTurnCommand 的 startReservation 参数；改错故障：排队 turn 被唤醒后重复 start，历史被写两遍。
// INV-03 executeTurn 只是 executeTurnCommand 的无 reservation 包装，终态收口必须共用；守住位置：executeTurn 与 executeTurnCommand 的返回路径；改错故障：取消缺少终态事件，会话永久停在 running。
// INV-04 一轮 turn 的事件顺序恒为 user prompt → tool_scheduled → 工具结果 → checkpoint → 终态；守住位置：emitToolScheduledEvents 与 emitFileMutationCheckpoint 的调用点；改错故障：UI 回放出现先结果后调用的非法顺序。
// INV-05 scheduleTools 只读且无副作用，真正写盘或联网只发生在 executeTools；守住位置：scheduleTools 与 executeTools 的分工；改错故障：预览即执行，同一工具被调用两次。
// INV-06 取消信号单向传播且终态只允许触发一次；守住位置：各方法的 abortSignal 参数与收口分支；改错故障：重复 turn_cancelled 事件，前端状态来回翻转。
// INV-07 rewind 必须先评估目标再变更，Unavailable 分支禁止触碰工作区；守住位置：rewindWorkspaceToCheckpoint 与 finishUnavailableRewind；改错故障：用户文件被半途覆盖且无事件可回溯。
// INV-08 级联回退固定会话先行、工作区在后，任一步失败即停止后续；守住位置：rewindCascadeToMessage 的分支顺序；改错故障：文件已回退而对话仍在后面，用户无法二次对齐。
// INV-09 fork 必须返回 messageIdMap，子会话消息 id 不得复用父会话 id；守住位置：copySessionMessagesForFork 的返回值；改错故障：投影把子会话消息挂回父会话。
// INV-10 compact 四个入口共用 compactActiveConversation 的摘要实现；守住位置：auto/micro/reactive/active 四个方法；改错故障：摘要口径不一致，token 预算估算持续失真。
// INV-11 microcompact 只做本地裁剪，绝不触发模型调用；守住位置：microcompactIfNeeded；改错故障：一次 turn 多出一次网络请求与计费。
// INV-12 reactive compact 仅在 provider 报超窗后进入且每轮最多一次；守住位置：reactiveCompactAfterContextExceeded；改错故障：压缩与重试死循环把配额烧光。
// INV-13 摘要消息必须先于 compact boundary 落库；守住位置：compactActiveConversation 与 persistCompactSummary；改错故障：回放看到 boundary 却找不到摘要，历史链路断裂。
// INV-14 所有 durable 写入必须经 createEvent 构造、appendEvent 落库；守住位置：createEvent 与 appendEvent；改错故障：内存里有事件而磁盘没有，重启即丢这一轮。
// INV-15 notifyEventSinks 只扇出、不落库，仅用于恢复与幂等重发；守住位置：notifyEventSinks 的调用点；改错故障：同一事件被持久化两遍，回放重复渲染。
// INV-16 任何 persist 失败必须向上抛，禁止在内存里假装成功；守住位置：全部 persist* 方法；改错故障：重启后会话历史缺段且无法自愈。
// INV-17 persist 的 copyFrom 只用于跨会话复制，不改变消息 id 语义；守住位置：persistMessage 与 persistPart 的 copyFrom 参数；改错故障：part 挂到错误的 message 下。
// INV-18 投影只能由 rebuildProjection 从事件重建，禁止外部手改；守住位置：rebuildProjection 与 getProjection；改错故障：投影与事件流永久漂移，UI 显示不存在的消息。
// INV-19 权限请求必须先登记再等待，resolve 未知 toolCallId 必须无操作；守住位置：emitPermissionRequest 与 resolvePermission；改错故障：工具永久挂起或误放行高风险操作。
// INV-20 后台任务只在 running 时计入 hasRunningBackgroundTasks；守住位置：cancelRunningRuntimeBackgroundTasks 与取消结果；改错故障：父 turn 提前结束，留下孤儿进程占用工作区。
import type { BackgroundBashOutputResult } from "@zcode/shared";
import type { ModelToolContract, RuntimeInputPresentation } from "@zcode/contracts";
import type {
  CompactPhase,
  CompactReason,
  CompactTimelineStatus,
  CompactTrigger,
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MessageId,
  MessageWithParts,
  MessagePart,
  MessageVisibility,
  Model,
  ModelSelection,
  ModelNetworkStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  PartId,
  PermissionBrokerRequest,
  SessionEvent,
  SessionEventType,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SyntheticUserMessageSource,
  TimelinePartDraft,
  ToolCallId,
  TraceContext,
  TurnId,
  TurnExecutionKind,
  TurnInputIntentMetadata,
  CheckpointCreatedPayload,
  RewindScope,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  ToolCall,
  TurnState,
  ToolSchedule,
  ToolExecutionResult,
} from "./deps.js";
import type {
  ActiveTurnStartReservation,
  CompactTimelineContext,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ParsedRewindCommand,
  PermissionDecisionResult,
  ResolvedTurnAttachment,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./types.js";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
  TurnRequestState,
} from "./methods/turn-loop-state.js";

/**
 * ============================================================================
 * runtime/internal-turn-methods.ts —— turn / rewind / fork / 持久化方法契约
 * ============================================================================
 *
 * 【定位】与 internal-methods.ts 同样只是签名声明,实现散落在 methods/turn*.ts、
 * rewind*.ts、session-fork.ts、compact*.ts、tools.ts、message-persistence.ts 等,
 * 由 installAgentRuntimeMethods 挂载。拆分目的是控制单文件规模与职责边界。
 *
 * 【职责分组】
 *   1) turn 入口:admitPrompt(准入)→ executeTurn / executeTurnCommand(执行);
 *      手动 compact 与 rewind 命令也走同一 turn 外壳;
 *   2) rewind / fork:会话与工作区回退、稳定 fork、selection side chat;
 *   3) compact:auto / micro / reactive / active 四个入口;
 *   4) 工具编排:调度、执行、scheduled 事件、文件变更 checkpoint、权限审批;
 *   5) 后台任务与 checkpoint 列表;
 *   6) durable 写入与投影:createEvent/appendEvent/各 persist* 与 rebuildProjection。
 *
 * 【不变量】所有 persist* 是"写 store"的唯一路径;所有事件必须先 createEvent
 * 再 appendEvent(或 notifyEventSinks)。任何 durable 写入失败都向上抛,
 * 不允许在内存里假装成功。
 * ============================================================================
 */
// [权衡] 把一轮对话拆成 admit、execute、tools、persist 四层而非单一入口：合并会让
// 准入同步段与执行异步段交织，取消判定与并发槽位无法复用，顺序只能靠契约约束。
export interface AgentRuntimeTurnMethods {
  // ---- turn 入口:admission 原子决定 start/queue/steer,执行侧只消费其结果。
  /**
   * 一次 prompt 的准入:在同一个同步段内判断 busy、建立 reservation、决定
   * start_turn / steer / queue。返回 started(带 completion Promise)或 steer 结果;
   * 拒绝时返回 rejected + reason,不抛异常。Bootstrap 不得把这几个步骤拆开调用。
   */
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  // [并发] started 携带 completion Promise，调用方据此等待本轮真正结束而非仅入队；
  // [失败路径] 拒绝走 rejected + reason 而不抛异常，避免 UI 把业务拒绝渲染成崩溃。
  ): Promise<PromptAdmissionReceipt>;
  /**
   * 执行一轮普通 turn:建立 activeTurn → 循环(压缩/刷新工具面/模型步/工具批次)→
   * 终态持久化。输入含用户文本、附件与执行选项;输出 TurnResult(响应、turnId、
   * usage、本次新增事件与投影)。副作用:写 message/part/事件;失败/取消由内部
   * 收口为 TurnError / TurnCancelled 事件后返回或抛出。
   */
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  /** executeTurn 的实现体:可接收 admission 已建立的 startReservation,避免二次竞争。 */
  // [事务] startReservation 非空即代表槽位已占用，实现不得再次判定 busy。
  executeTurnCommand(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
    startReservation?: ActiveTurnStartReservation,
  ): Promise<TurnResult>;
  /**
   * 手动 /compact 的 turn 外壳:与普通 turn 共用 activeTurn 与终态收口,
   * 但内部只跑摘要流程;失败语义按 compact 的 manual 入口(会让 turn 失败)。
   */
  // [权衡] 手动 compact 复用 turn 外壳以共享取消与终态收口，失败按 manual 触发语义处理。
  executeManualCompact(
    input: string,
    customInstructions: string | undefined,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
    model?: Model,
  ): Promise<TurnResult>;
  // [失败路径] rewind 在 turn 内执行，失败要收敛成 TurnError 事件而不是直接抛给 UI。
  executeRewindCommand(
    input: string,
    command: ParsedRewindCommand,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
  ): Promise<TurnResult>;
  formatRewindStatus(): Promise<string>;
  // ---- rewind:先评估目标(ActiveChain/FileOnly/Unavailable),再分别回退会话/工作区。
  // [事务] 先评估全部目标再动第一个文件，边评估边写会留下无法再推导的半回退状态。
  rewindWorkspaceToCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetCheckpointId?: string;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  rewindToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  // [事务] 级联固定会话先行、工作区在后：工作区先改而会话失败时，文件已变但对话
  // 仍在后面，且没有事件可用于二次修复，用户只能手工对齐。
  rewindCascadeToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  // 只裁剪会话，不碰工作区；scope 校验由调用方完成，这里不再猜测用户意图。
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  // 范围参数决定是否连带文件回退，不匹配时不应被调用，避免两处各自解释回退范围。
  rewindWorkspaceToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  // [失败路径] 目标不可回退也写一条终态事件，否则 UI 会永久停在“回退中”。
  finishUnavailableRewind(options: {
    checkpoint?: CheckpointCreatedPayload;
    evaluation?: RewindTargetEvaluation;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    scope?: RewindScope;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  // [资源] 逐文件恢复，单文件失败不中断其余文件，结果逐条回传由上层汇总。
  restoreWorkspaceCheckpointArtifact(
    artifact: WorkspaceCheckpointArtifact,
    traceContext: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<WorkspaceRewindRestoredFile[]>;
  // ---- fork:复制消息到子会话并维护 identity map;失败时父会话事件仍 best-effort。
  // [事务] 必须返回 messageIdMap：子会话消息 id 与父会话不同，映射是唯一关联凭据。
  // [失败路径] 中途失败不回滚已复制消息，因为事件流只追加，删除会破坏回放一致性。
  copySessionMessagesForFork(options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  }): Promise<{
    copiedMessageCount: number;
    messageIdMap: Map<MessageId, MessageId>;
  }>;
  // ---- compact 四入口:auto(阈值触发,失败可让 turn 失败)/ micro(纯本地裁剪)/
  // reactive(provider 报超窗后的补救)/ active(真正生成摘要并替换历史)。
  // [失败路径] auto 入口失败可让整轮 turn 失败：阈值已超却压不动，继续请求只会
  // 换来 provider 超窗错误，白白多一次往返。
  autoCompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: AutoCompactLoopContext,
  ): Promise<AutoCompactOutcome>;
  // [权衡] micro 只做本地裁剪换取不惊动 provider 的余量，不能作为唯一压缩手段。
  microcompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: {
      model: Model;
      modelStepIndex: number;
      phase: CompactPhase;
      turnRequestState: TurnRequestState;
    },
  ): Promise<void>;
  // [失败路径] 仅在 provider 明确报超窗后进入，每轮最多一次，防止压缩与重试死循环。
  reactiveCompactAfterContextExceeded(
    originalError: unknown,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: ReactiveCompactLoopContext,
  ): Promise<CompactAttemptOutcome>;
  // 四个 compact 入口唯一的摘要实现体，其余入口只负责决定何时调用它。
  // [事务] 摘要消息必须先于 boundary 落库，否则回放会看到边界却找不到摘要。
  compactActiveConversation(
    customInstructions: string | undefined,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      abortSignal?: AbortSignal;
      compactContextTelemetry?: {
        inputTokens: number;
        policyContextWindowTokens: number;
        thresholdTokens?: number;
        tokenSource: "estimate" | "provider_usage";
      };
      autoCompactThreshold?: number;
      compactReason?: CompactReason;
      initialPromptTooLongCause?: unknown;
      phase?: CompactPhase;
      sourceCommandId?: string;
      trigger?: CompactTrigger;
      model?: Model;
      agentListingTools?: readonly { name: string }[];
      activeEntries?: readonly RuntimeMessageEntry[];
      getContinuationTools?: () => readonly ModelToolContract[];
    },
  ): Promise<{
    displayText: string;
    entries: readonly RuntimeMessageEntry[];
    outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
    tokenCount: number;
  }>;
  // ---- 工具编排:schedule 只算依赖与并发组,execute 才真正产生副作用与结果。
  // [权衡] 调度与执行分离，让 UI 能在执行前展示计划，也让计划可被断言与重放。
  // 代价是 scheduleTools 与 executeTools 各遍历一遍 toolCalls，两遍之间工具面可能已被刷新。
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  // [失败路径] 单个工具失败不终止整批，但每条结果都要带 toolCallId 以便对账。
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  // [事务] scheduled 事件必须先于任何工具结果落库，否则回放出现先结果后调用的顺序。
  // 该方法是工具面的唯一入口，遗漏它会让 UI 完全看不到工具卡片。
  emitToolScheduledEvents(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    assistantMessageId: MessageId,
    traceContext: TraceContext,
  ): Promise<SessionEvent[]>;
  // [事务] checkpoint 在结果落库后、终态之前生成：太晚会漏掉本批变更，太早则内容
  // 与磁盘不一致；[失败路径] 生成失败不阻断 turn，但必须留痕。
  emitFileMutationCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<void>;
  // ---- 权限审批:请求经 broker 挂起,resolve 后把决定回填给等待中的工具调用。
  // [并发] 先登记进 broker 再等待：先等待后登记会与 resolve 形成竞态，决定到达时
  // 找不到等待者，工具永久挂起。
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  // [并发] 未知 toolCallId 必须无操作而非报错，UI 重复点击时第二次已无等待者。
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  // 只读快照，供 UI 渲染待审批列表；返回数组而非 Map 是为了保持到达顺序。
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  // [资源] 只读后台输出，不获取任务所有权；读失败不改变任务状态。
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  // [资源] 取消是请求语义，返回结果里的状态才代表是否真正退出。
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  // [资源] 停止会等待进程回收并聚合输出，比取消更重，用于需要确定性退出的场景。
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  // [资源] 只在父 turn 取消时调用，必须等子任务全部退出再返回，避免孤儿进程。
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  hasRunningBackgroundTasks(): boolean;
  getSessionId(): SessionId;
  // ---- checkpoint:列表只读投影;fork/rewind 才涉及文件与消息的复制/回退。
  // 只读投影，不创建 checkpoint；排序与截断稳定，UI 依赖这一点做增量刷新。
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  // [事务] 从 checkpoint 派生新会话，原会话保持不变；失败时新会话不留下半成品。
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  // 稳定 fork 以消息 id 为锚，要求父会话在该消息之后不再追加，否则锚点失效。
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  // 侧会话继承选中内容作为上下文，但消息 id 全部重建，防止两条会话共享 part。
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  // 在消息之前切分，保证用户输入不会被复制进子会话；边界判定交给实现。
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  // 只读预览，给出将要改写的文件清单与差异，不触碰磁盘。
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  // [事务] commitAfterApply 让调用方在全部文件写完后统一提交，避免每文件一次提交。
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  loadCheckpointMessagePreviews(): Promise<Map<MessageId, string>>;
  // [并发] 状态回调可能高频触发，persist 为 true 时才落库，避免网络抖动写爆事件流。
  createModelStatusSink(
    traceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      persist?: boolean;
      onStatus?: (event: ModelNetworkStatusEvent) => void;
      streamRecovery?: ModelStreamRecoveryStatus;
    },
  ): ModelStatusSink;
  logModelNetworkStatus(statusEvent: ModelNetworkStatusEvent, traceContext: TraceContext): void;
  // 纯组装函数，不做 IO；status 覆盖优先于 snapshot，便于取消或完成时强制改状态。
  buildBackgroundTaskPayload(
    taskId: string,
    existing: BackgroundTaskInfo | undefined,
    snapshot: BackgroundExecutionSnapshot | undefined,
    overrides?: {
      cancelRequestedAt?: Date;
      cancellable?: boolean;
      completedAt?: Date;
      status?: BackgroundTaskInfoStatus;
    },
  ): BackgroundTaskInfo;
  // ---- durable 写入与投影:createEvent 只构造,appendEvent 落库并扇出,
  // notifyEventSinks 只扇出(用于恢复/幂等重发),ensureSessionPersisted 建会话本体。
  // [事务] createEvent 只构造不落库，保证调用方可以先决定顺序再统一 append。
  // 事件 id 在这里生成，先落库再分配 id 会让扇出与持久化拿到不同标识。
  createEvent(type: SessionEventType, payload: unknown, traceContext: TraceContext): SessionEvent;
  // [事务] 落库与扇出在同一调用内完成，失败即抛；不允许内存成功、磁盘失败的中间态。
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  // [事务] 只扇出不落库，用于恢复与幂等重发；重复调用同一事件是安全的。
  // [权衡] 与 appendEvent 拆开是为了让恢复路径不必二次写库。
  notifyEventSinks(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  // [事务] 会话本体必须先于任何事件存在，否则 appendEvent 会因外键缺失失败。
  ensureSessionPersisted(input: string, traceContext: TraceContext): Promise<void>;
  // 纯组装，把 timeline 上下文与本次更新合并成 payload；replace 决定覆盖还是合并。
  buildCompactTimelinePayload(
    timeline: CompactTimelineContext,
    update: {
      attempt?: number;
      boundaryId?: string;
      endedAt?: number;
      maxAttempts?: number;
      postCompactTokenCount?: number;
      reason?: string;
      replace?: boolean;
      status: CompactTimelineStatus;
      summaryMessageId?: MessageId;
      tailStartMessageId?: MessageId;
      truePostCompactTokenCount?: number;
    },
  ): CompactTimelinePayload;
  persistCompactTimeline(
    payload: CompactTimelinePayload,
    traceContext: TraceContext,
  ): Promise<void>;
  // [失败路径] 失败也要把 timeline 推进到终态，否则 UI 停在“压缩中”且无法重试。
  finishCompactTimelineFailure(options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  }): Promise<void>;
  // [事务] 启动时修复上次进程崩溃留下的半开 timeline，返回值是修复条数用于日志。
  recoverInterruptedCompactTimelines(
    messages: MessageWithParts[],
    traceContext: TraceContext,
  ): Promise<number>;
  // [事务] 摘要消息与 boundary 由同一调用写入，拆两次写会留下无法回放的中间态。
  persistCompactSummary(
    messageID: MessageId,
    content: string,
    summary: string,
    compactBoundary: CompactBoundaryPayload,
    traceContext: TraceContext,
    options?: {
      model?: Model;
      operationId?: string;
      postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    },
  ): Promise<void>;
  // [事务] 用户消息必须在模型请求前落库，否则取消后这一轮输入会彻底消失。
  persistUserPrompt(
    messageID: MessageId,
    input: string,
    attachments: ResolvedTurnAttachment[] | undefined,
    traceContext: TraceContext,
    options?: {
      steerDelivery?: "guide" | "queue";
      inputPresentation?: RuntimeInputPresentation;
      sessionInputId?: string;
      sourceCommandId?: string;
      clientId?: string;
      intent?: TurnInputIntentMetadata;
      executionKind?: TurnExecutionKind;
      epilogueStart?: number;
    },
  ): Promise<void>;
  // recordPendingModelChange 只登记待生效的切换，真正改运行态在下一轮请求的 buildRequest。
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  persistPendingModelChangeTimeline(traceContext: TraceContext): Promise<void>;
  persistSyntheticUserNotice(
    messageID: MessageId,
    text: string,
    traceContext: TraceContext,
  ): Promise<void>;
  persistSyntheticUserNoticeForSession(options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  }): Promise<void>;
  // 时间线片段与消息分开写，便于流式追加；返回 messageID 与 partID 供后续更新。
  persistAssistantTimelinePartForSession(options: {
    sessionId: SessionId;
    messageID?: MessageId;
    partID?: PartId;
    parentID?: MessageId;
    created?: number;
    completed?: number;
    finish?: string;
    timeline: TimelinePartDraft;
    traceContext: TraceContext;
  }): Promise<{ messageID: MessageId; partID: PartId }>;
  // [事务] assistant 消息的终态字段一次性写入，先写部分字段再补会让投影短暂不一致。
  persistAssistantMessage(
    messageID: MessageId,
    parentID: MessageId,
    created: number,
    update:
      | {
          completed?: number;
          error?: { name: string; data?: Record<string, unknown> };
          finish?: string;
          tokens?: unknown;
        }
      | undefined,
    traceContext: TraceContext,
    model?: Model,
  ): Promise<void>;
  // 统一写消息入口，copyFrom 只用于跨会话复制，不改变当前会话的 id 语义。
  persistMessage(
    input: Parameters<SessionStorePort["saveMessage"]>[0],
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void>;
  // 统一写 part 入口，copyFrom 指向源 part；实现必须校验 part 与 message 的归属。
  persistPart(
    input: MessagePart,
    traceContext: TraceContext,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void>;
  // 投影只允许从事件重建；手改投影会让它在下一次重建时被覆盖且难以排障。
  rebuildProjection(): Promise<SessionProjection>;
}
