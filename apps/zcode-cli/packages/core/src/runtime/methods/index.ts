/**
 * ============================================================================
 * runtime/methods/index.ts —— runtime 方法装配表（函数实现 → prototype 绑定）
 * ============================================================================
 * 【定位】把各 methods 模块导出的函数挂到 AgentRuntime 原型上，供 this.xxx() 调用。
 * 【约束】左侧 proto 名必须与 AgentRuntimeInternal 的方法名逐一对应；漏绑不报编译错，
 *   只会在运行期变成 “this.xxx is not a function”，新增方法时两处必须同步。
 * 【顺序】赋值无依赖顺序，但 import 分组按 配置/steering → 队列/后台 → 模型/上下文 →
 *   持久化 → fork/rewind → 工具 排列；跨组同名导出靠 import 来源区分，不靠顺序。
 * ============================================================================
 */
// ============================================================================
// runtime/methods/index.ts —— 运行时方法装配表（实现函数到 AgentRuntime.prototype 的绑定）
// ============================================================================
// 【职责】把 methods/*.ts 导出的独立函数按 proto 名字逐个挂上 ctor.prototype，
//   实现函数签名统一为 xxx(this: AgentRuntimeInternal, ...)，靠 this 访问 runtime 状态。
// 【不负责】不实现业务逻辑、不校验入参、不编排初始化顺序、不持有任何状态；
//   方法契约在 internal*.ts，对外可见接口在 agent-runtime.ts 的 AgentRuntime 接口。
//
// 【装配口径】赋值之间无依赖顺序、无副作用；重复执行等价于同引用再赋一次，因此幂等。
//   分组只服务阅读与 diff；调整分组不改变运行时行为，但会打散与调用点的对照关系。
//
// INV-01 断言：左侧 proto 名必须与 AgentRuntimeInternal 的同名方法一一对应 —— 守住它的位置：installAgentRuntimeMethods 的每条赋值 —— 改错故障：编译期不报错，首次调用抛 this.xxx is not a function
// INV-02 断言：右侧只能直接引用 import 进来的实现函数，不能包箭头函数或 bind —— 守住它的位置：全部赋值行 —— 改错故障：this 不再指向 runtime 实例，方法内 this.config 等字段读到 undefined
// INV-03 断言：config/steering/context/tools 同名导出靠 import 来源区分，不靠绑定顺序 —— 守住它的位置：顶部 import 分组 —— 改错故障：挂上语义相邻但职责不同的实现，行为漂移只能靠日志猜
// INV-04 断言：新增方法必须同时补实现、internal 类型与本表三处 —— 守住它的位置：各分组末尾 —— 改错故障：类型有声明而原型无实现，冷启动后该方法第一次被调用就崩
// INV-05 断言：本表在 agent-runtime.ts 模块求值末尾执行一次，早于任何实例构造 —— 守住它的位置：installAgentRuntimeMethods 唯一调用点 —— 改错故障：实例先建后绑，实例自有属性遮蔽原型，绑定永久失效
// INV-06 断言：装配过程不允许条件分支、环境裁剪或惰性绑定 —— 守住它的位置：installAgentRuntimeMethods 函数体 —— 改错故障：不同环境的可用方法集不一致，单测全绿而线上缺方法
// INV-07 断言：proto 名是对 TUI 与协议层可见的稳定契约，重命名等同破坏 API —— 守住它的位置：每条赋值左侧 —— 改错故障：外部按旧名调用失败，且错误发生在进程边界之外
// INV-08 断言：同一 ctor 上同名只允许绑一次，不得重复赋值 —— 守住它的位置：人工去重与分组划分 —— 改错故障：后一行静默覆盖前一行，读到的方法名与真实实现不符
// INV-09 断言：队列与前台执行权只能经这些绑定交互，禁止直写内部字段 —— 守住它的位置：runtime command 分组的 lease 与 drain 方法 —— 改错故障：lease 未配对释放，常驻池判定该 session 永远 busy
// INV-10 断言：createEvent / appendEvent / notifyEventSinks 三者绑定不可拆散 —— 守住它的位置：事件分组 —— 改错故障：事件落库却不通知 sink，投影与 UI 状态永久分叉
// INV-11 断言：executeTurn 与 executeTurnCommand 必须同时可调用 —— 守住它的位置：turn 主链路分组 —— 改错故障：命令入口在无 active turn 时抛 not a function
// INV-12 断言：Record<string, unknown> 宽化只限本文件内部写入，不得外泄 —— 守住它的位置：const proto 断言 —— 改错故障：调用方拿到弱类型后改写原型，全局实例互相污染
// INV-13 断言：persist 系列与 recover 系列必须成套存在，缺一不可 —— 守住它的位置：durable 写入分组 —— 改错故障：重启后 running 中的 compact 时间线无人收敛，会话反复卡在恢复
// INV-14 断言：辅助模型调用与记忆抽取不参与 turn 生命周期，仍需独立绑定 —— 守住它的位置：文件末尾分组 —— 改错故障：无 turn 的标题生成与记忆抽取找不到入口，静默失败
//
// 【改动指引】新增方法：先写实现与 internal 类型，再在对应分组追加一行同名绑定；
//   只加实现不加绑定，编译期不会报错，故障一定推迟到该方法的首次调用。
// 【排查】报 this.x is not a function 时先核对本表是否缺行，再查 import 来源是否串组。
// ============================================================================
import { sampleModel } from "./sample-model.js";
// [契约] 两处 ../ 引用是仅有的越出 methods 目录的实现依赖，权限与记忆抽取由 runtime 之外的模块提供
// 其余 import 全部落在 methods/ 内，出现新的跨目录引用时应先判断是否该收敛成 port 注入
// 书写顺序只服务阅读：配置/steering 在前，模型与持久化在后，import 先后不影响绑定结果
import { grantPermissionFullAccess } from "../permission-full-access.js";
import {
  getSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded,
  updateConfig,
  setExecutionState,
} from "./config.js";
import { getMode, getPlanEnabled } from "./config.js";
import { getSessionModelSelection, setSessionModelSelection } from "./config.js";
import { getProjectId } from "./config.js";
import { setWorkingDirectory } from "./config.js";
import { ensureSessionPersistedForExternalActivity } from "./config.js";
import { getActiveTurnInfo } from "./config.js";
import { getTools } from "./config.js";
import { invalidateToolCache } from "./config.js";
import { getToolRegistry } from "./config.js";
import { getToolExecutor } from "./config.js";
import { subscribeEvents } from "./config.js";
import { getSessionEventStore } from "./config.js";
import { notifyExternalChildSessionEvent } from "./config.js";
import { createChildClientPorts } from "./config.js";
import { getContextBuilder } from "./config.js";
import { getPendingPermissionRequests } from "./config.js";
// [契约] 交互自动决议与 dynamic workflow 属旁路能力：方法存在，但 turn 主链路不依赖它们，缺绑只丢功能不断链
// 这一组共 6 个入口，各自独立成文件，避免与 steering 的输入账本概念混淆
// 旁路方法同样必须绑到原型上，否则 workflow 恢复与进度回写会静默跳过，日志里只剩一句 skipped
import { recordUserInputAutoResolutionUpdate } from "./interaction-auto-resolution.js";
import { recordDynamicWorkflowRunProgress } from "./dynamic-workflow-run-progress.js";
import { trackResumedDynamicWorkflowRun } from "./dynamic-workflow-run-track.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";
import { startSavedWorkflowRun } from "./dynamic-workflow-run-start.js";
import { amendWorkflowRunSettings } from "./dynamic-workflow-run-settings.js";
import { getProjection } from "./config.js";
import { getSessionId } from "./config.js";
import { enqueueDeferredInput } from "./steering.js";
import { steerTurn } from "./steering.js";
import { beginActiveTurn } from "./steering.js";
import { reserveTurnStart } from "./steering.js";
import { releaseTurnStart } from "./steering.js";
import { finishActiveTurn } from "./steering.js";
import { createPendingInputId } from "./steering.js";
import { rejectTurnSteer } from "./steering.js";
import { hasPendingInput } from "./steering.js";
import { hasInlineGuidePendingInput } from "./steering.js";
import { fallbackPendingGuidesToQueue } from "./steering.js";
import { drainPendingInput } from "./steering.js";
import {
  enqueueBackgroundTaskNotification,
  sealBackgroundTaskNotifications,
} from "./background-notifications.js";
import { drainPendingRuntimeCommandsForActiveLoop } from "./runtime-command-active-loop.js";
import { enqueueSubagentMessage } from "./subagent-messages.js";
import {
  acquireForegroundPromotionLease,
  drainRuntimeCommandQueue,
  enqueueRuntimeCommand,
  getActiveForegroundExecutionId,
  hasActiveOrQueuedTurnWork,
  releaseForegroundPromotionLease,
  stopActiveForegroundExecution,
} from "./runtime-command-queue.js";
import { hasResidencyBlockingWork, trackResidencyBlockingWork } from "./residency.js";
import {
  clearAllPendingInputs,
  completeExternalQueueDrain,
  discardHeldPendingInputById,
  discardPendingInput,
  editPendingInputById,
  emitModeChanged,
  emitModelSelected,
  markPendingInputPromoting,
  releasePendingInputReservation,
  removePendingInputById,
  reorderPendingInput,
  reservePendingInputById,
  setFollowupMode,
  setQueueAutoDrain,
} from "./steering.js";
import { discardPersistedPendingSteerInputs } from "./steering.js";
// 从这一行起是后半段装配原料：子代理 → 上下文/MCP → 模型 → 冷恢复 → target → hook → turn → 工具 → 事件 → 持久化
// 同名导出密集区（context.js 的 create 系列、resume.js 的 toScheduleState），读时必须看清来源模块，别按名字猜
// 上方导入只是登记引用，真正的契约校验发生在 installAgentRuntimeMethods 的赋值行上
import { createDefaultSubagentPort } from "./subagent.js";
import { ensureContextInitialized, getSkillCatalog } from "./context.js";
import { createContextBuilderFromSnapshot } from "./context.js";
import { loadProjectMemoryRoot } from "./context.js";
import { logMemorySkipped } from "./context.js";
import { injectPluginReferenceReminderFromTurn } from "./plugin-reference.js";
import { initializeMcp, refreshMcpToolsIfChanged } from "./mcp.js";
import { startMcpStartup } from "./mcp.js";
import { discoverSkillsForContext } from "./context.js";
import { createConfigOnlyContextSnapshot } from "./context.js";
import { initializeMessageHistoryFromContext } from "./context.js";
import { extractToolCallsFromResult } from "./context.js";
import { shouldStreamModelText } from "./context.js";
import { runModelTextRequest } from "./model.js";
import { emitModelStreamingEvent } from "./model-streaming-event.js";
import { createModelStatusSink } from "./model-status.js";
import { logModelNetworkStatus } from "./model-status.js";
import { logContextUsageSnapshot } from "./context-usage.js";
import { logModelRequestSteeringContext } from "./context-usage.js";
import { buildModelMessageTailDiagnostics } from "./context-usage.js";
import { buildContextUsageSnapshot } from "./context-usage.js";
import { buildContextUsageBreakdownFromSnapshot } from "./context-usage.js";
import { buildContextUsageCategory } from "./context-usage.js";
import { buildToolUsageDetail } from "./context-usage.js";
import { buildSkillUsageDetails } from "./context-usage.js";
import { buildMessageRoleBreakdown } from "./context-usage.js";
import { estimatedMetric } from "./context-usage.js";
import { estimatedMetricFromKnown } from "./context-usage.js";
import { sumMetrics } from "./context-usage.js";
import { toScheduleState } from "./resume.js";
import { resumeFromStore } from "./resume.js";
import { readSessionTodosForContext } from "./resume.js";
import { readSessionTargetForContext } from "./resume.js";
import { injectTargetStateIntoMessageHistory } from "./resume.js";
import { recordTargetChanged } from "./target.js";
import { recordGoalStateChangeReminder } from "./goal-state-reminder.js";
import { continueActiveTargetIfIdle } from "./target.js";
import { continueActiveTargetLoop } from "./target-continuation-loop.js";
import { targetContinuationCandidate } from "./target.js";
import { accountTargetTurnCompletion } from "./target.js";
import { startTargetTurnAccounting } from "./target.js";
import { heartbeatTargetTurnAccounting } from "./target.js";
import { finishTargetTurnAccounting } from "./target.js";
import { pauseActiveTargetForCancellation } from "./target.js";
import { activatePausedTargetAfterResume } from "./target.js";
import {
  injectHookAdditionalContextIntoMessageHistory,
  runSessionStartHooks,
  runStopHooks,
  runUserPromptSubmitHooks,
  shouldContinueAfterStopHooks,
} from "./hooks.js";
import { executeTurn, executeTurnCommand } from "./turn.js";
import { admitPrompt } from "./prompt-admission.js";
import { executeManualCompact } from "./compact.js";
import { autoCompactIfNeeded } from "./compact.js";
import { microcompactIfNeeded } from "./microcompact.js";
import { reactiveCompactAfterContextExceeded } from "./compact.js";
import { compactActiveConversation } from "./compact-active.js";
import { executeRewindCommand } from "./rewind.js";
import { formatRewindStatus } from "./rewind.js";
import { rewindWorkspaceToCheckpoint } from "./rewind.js";
import { finishUnavailableRewind } from "./rewind.js";
import { rewindConversationToMessage } from "./rewind-message.js";
import { rewindCascadeToMessage } from "./rewind-message.js";
import { rewindToMessage } from "./rewind-message.js";
import { rewindWorkspaceToMessage } from "./rewind-message.js";
import { restoreWorkspaceCheckpointArtifact } from "./workspace-checkpoints.js";
import { copySessionMessagesForFork } from "./workspace-checkpoints.js";
import { listWorkspaceCheckpoints } from "./workspace-checkpoints.js";
import { forkWorkspaceFromCheckpoint } from "./workspace-checkpoints.js";
import {
  createSelectionSideConversation,
  forkConversationBeforeMessage,
  forkStableConversationAtMessage,
} from "./session-fork.js";
import { loadCheckpointMessagePreviews } from "./workspace-checkpoints.js";
import { applyWorkspaceFileRewind, previewWorkspaceFileRewind } from "./file-rewind.js";
import { scheduleTools } from "./tools.js";
import { executeTools } from "./tools.js";
import { emitToolScheduledEvents } from "./tools.js";
import { emitFileMutationCheckpoint } from "./tools.js";
import { emitPermissionRequest } from "./tools.js";
import { resolvePermission } from "./tools.js";
import {
  cancelBackgroundTask,
  cancelRunningRuntimeBackgroundTasks,
  hasRunningBackgroundTasks,
  stopBackgroundTask,
} from "./background.js";
import { buildBackgroundTaskPayload } from "./background.js";
import { readBackgroundBashOutput } from "./background-bash-output.js";
import { createEvent } from "./events.js";
import { appendEvent } from "./events.js";
import { notifyEventSinks } from "./events.js";
import { ensureSessionPersisted, isSessionPersisted } from "./events.js";
import { buildCompactTimelinePayload } from "./compact-persistence.js";
import { persistCompactTimeline } from "./compact-persistence.js";
import { finishCompactTimelineFailure } from "./compact-persistence.js";
import { recoverInterruptedCompactTimelines } from "./compact-persistence.js";
import { persistCompactSummary } from "./compact-persistence.js";
import { recordExternalUserPrompt } from "./control-only-turn.js";
import { persistUserPrompt } from "./message-persistence.js";
import { persistSyntheticUserNotice } from "./message-persistence.js";
import { persistSyntheticUserNoticeForSession } from "./message-persistence.js";
import { persistAssistantMessage } from "./message-persistence.js";
import { persistMessage } from "./message-persistence.js";
import { persistPart } from "./message-persistence.js";
import { rebuildProjection } from "./message-persistence.js";
import { recordPendingModelChange } from "./timeline-persistence.js";
import { persistPendingModelChangeTimeline } from "./timeline-persistence.js";
import { persistAssistantTimelinePartForSession } from "./timeline-persistence.js";
import { generateWorkspaceText, testModelConnectivity } from "./workspace-generate-text.js";
import { maybeStartGoalSummaryTitleGeneration } from "./goal-summary-title.js";
import { maybeStartSessionTitleGenerationFromExternalInput } from "./session-title.js";
import { setCustomSessionTitle } from "./session-title.js";
import {
  drainMemoryExtractions,
  isProjectMemoryEnabled,
} from "../helpers/project-memory-extraction.js";

// [权衡] 入参只声明 prototype，避免本文件反向依赖 agent-runtime.ts 的 class 形状，从而不构成类型环
// 代价是编译器不知道原型上有哪些成员，绑定行写错名字（拼写、大小写）无法在编译期暴露
// 这里也不做实例级校验：装配可能发生在任何实例存在之前，函数内拿不到 this
// 若把入参收紧成具体 class 类型，methods 与 AgentRuntime 会在类型层互相引用，模块加载顺序也会被绑死
type AgentRuntimeConstructor = { prototype: object };

// [契约] 唯一装配入口：调用一次即可，重复调用等价于同引用再赋一次，不产生额外状态
// [契约] 只写 ctor.prototype，不碰实例、不返回任何值，调用方无从得知具体绑定了哪些方法
// 调用点在 agent-runtime.ts 模块末尾，必须早于 bootstrap 创建第一个实例
// 新增或删除方法都在本函数体内完成，不要在外面临时补 proto.xxx，否则 diff 与分组对照被打散
export function installAgentRuntimeMethods(ctor: AgentRuntimeConstructor): void {
  // [权衡] Record<string, unknown> 只是为了在本函数内可写，不得扩散到任何导出面
  // 用它替代 any 能让误用（例如把 proto 传给外部）在调用处显形，但不会校验右侧函数签名
  // 真正的签名约束来自 internal*.ts 的 this 参数：实现函数的首参决定它能访问哪些字段
  // 此处刻意不做 Object.assign(proto, {...}) 的批量写法，逐行赋值才能在 review 中看出新增了哪个方法
  const proto = ctor.prototype as Record<string, unknown>;
  // 配置与执行态：其他方法都经由这些入口读写 runtime 配置，不直接碰内部字段。
  // [契约] 配置与执行态分组：运行期改 config.mode/planEnabled 一律经 updateConfig 与 setExecutionState，其余方法只读
  // grantPermissionFullAccess 依赖 interactionId 与 AbortSignal，不属于普通 setter，别和 mode 变更归为一类
  // getSessionShellSelection 与 initializeSessionShellEnvironmentIfNeeded 成对：先初始化后读取，读到 undefined 表示用户尚未选择 shell
  // 这组都在 turn 之外被 TUI 直接调用，因此实现里不能假定 activeTurn 或 turnNumber 已就绪
  proto.updateConfig = updateConfig;
  proto.setExecutionState = setExecutionState;
  proto.grantPermissionFullAccess = grantPermissionFullAccess;
  proto.initializeSessionShellEnvironmentIfNeeded = initializeSessionShellEnvironmentIfNeeded;
  proto.getSessionShellSelection = getSessionShellSelection;
  proto.getMode = getMode;
  proto.getPlanEnabled = getPlanEnabled;
  proto.getSessionModelSelection = getSessionModelSelection;
  proto.setSessionModelSelection = setSessionModelSelection;
  proto.getProjectId = getProjectId;
  proto.setWorkingDirectory = setWorkingDirectory;
  proto.ensureSessionPersistedForExternalActivity = ensureSessionPersistedForExternalActivity;
  proto.maybeStartSessionTitleGenerationFromExternalInput =
    maybeStartSessionTitleGenerationFromExternalInput;
  proto.setCustomSessionTitle = setCustomSessionTitle;
  proto.maybeStartGoalSummaryTitleGeneration = maybeStartGoalSummaryTitleGeneration;
  proto.testModelConnectivity = testModelConnectivity;
  proto.recordExternalUserPrompt = recordExternalUserPrompt;
  proto.getActiveTurnInfo = getActiveTurnInfo;
  // [资源] 工具面：getTools 返回缓存视图，invalidateToolCache 是唯一失效入口，两者必须同时可用
  // getToolRegistry 与 getToolExecutor 分开暴露，调度侧与执行侧的文件边界靠这两个名字维持
  // [失败路径] 只绑 getTools 不绑 invalidate，MCP 刷新或权限变更后模型仍看到旧 schema，调用被拒却查不到原因
  // subscribeEvents 与 getSessionEventStore 相邻但语义不同：前者订阅实时事件，后者读 durable 事件，不可互换
  proto.getTools = getTools;
  proto.invalidateToolCache = invalidateToolCache;
  proto.getToolRegistry = getToolRegistry;
  proto.getToolExecutor = getToolExecutor;
  proto.subscribeEvents = subscribeEvents;
  proto.getSessionEventStore = getSessionEventStore;
  proto.notifyExternalChildSessionEvent = notifyExternalChildSessionEvent;
  proto.createChildClientPorts = createChildClientPorts;
  proto.getContextBuilder = getContextBuilder;
  proto.getPendingPermissionRequests = getPendingPermissionRequests;
  proto.recordUserInputAutoResolutionUpdate = recordUserInputAutoResolutionUpdate;
  proto.recordDynamicWorkflowRunProgress = recordDynamicWorkflowRunProgress;
  proto.trackResumedDynamicWorkflowRun = trackResumedDynamicWorkflowRun;
  proto.activateDynamicWorkflowTools = activateDynamicWorkflowTools;
  proto.startSavedWorkflowRun = startSavedWorkflowRun;
  proto.amendWorkflowRunSettings = amendWorkflowRunSettings;
  proto.getProjection = getProjection;
  proto.getSessionId = getSessionId;
  // steering / 输入账本：guide 与 queue 两类入口，以及 reservation 生命周期都在这里暴露。
  // [并发] steering 账本：guide 与 queue 两条入口最终落到同一 pending 输入列表，绑定名必须与实现严格同名
  // beginActiveTurn 与 finishActiveTurn 成对出现，中间夹着 reserveTurnStart / releaseTurnStart 的启动配额
  // [失败路径] releaseTurnStart 必须在每条提前返回路径上被调用，漏一次后续 turn 就永远排不进
  // drainPendingInput 是唯一消费口，旁路直接读写列表会让 reservation 计数与实际输入失配
  proto.enqueueDeferredInput = enqueueDeferredInput;
  proto.steerTurn = steerTurn;
  proto.beginActiveTurn = beginActiveTurn;
  // [契约] turn 启动配额：reserveTurnStart 抢占、releaseTurnStart 归还，成对且不可交换顺序
  // createPendingInputId 与 reservation 是两个维度（输入身份 vs 启动权），不能用其中一个替代另一个
  // rejectTurnSteer 与 fallbackPendingGuidesToQueue 是拒绝路径：被拒的 guide 要么丢弃要么退回队列，不能悬空
  // [失败路径] 抛异常前忘记 release，表现为新 turn 一直等待，日志里却看不到任何排队原因
  proto.reserveTurnStart = reserveTurnStart;
  proto.releaseTurnStart = releaseTurnStart;
  proto.finishActiveTurn = finishActiveTurn;
  proto.createPendingInputId = createPendingInputId;
  proto.rejectTurnSteer = rejectTurnSteer;
  proto.hasPendingInput = hasPendingInput;
  proto.hasInlineGuidePendingInput = hasInlineGuidePendingInput;
  proto.fallbackPendingGuidesToQueue = fallbackPendingGuidesToQueue;
  proto.drainPendingInput = drainPendingInput;
  // runtime command 队列与前台执行权：active turn 与队列只通过这些方法交互（不变量 #5/#6）。
  // [并发] runtime command 队列与前台执行权：active turn 与外部命令只经这些方法交互，禁止直写队列或 lease 字段
  // acquireForegroundPromotionLease 与 releaseForegroundPromotionLease 必须成对，取消路径同样要归还
  // [失败路径] lease 泄漏的直接症状是 hasActiveOrQueuedTurnWork 恒为真，常驻池永不关闭该 session
  // stopActiveForegroundExecution 只终止前台执行，不等价于取消全部后台任务，两者不要混用
  proto.enqueueRuntimeCommand = enqueueRuntimeCommand;
  proto.drainRuntimeCommandQueue = drainRuntimeCommandQueue;
  proto.hasActiveOrQueuedTurnWork = hasActiveOrQueuedTurnWork;
  proto.hasResidencyBlockingWork = hasResidencyBlockingWork;
  proto.trackResidencyBlockingWork = trackResidencyBlockingWork;
  proto.acquireForegroundPromotionLease = acquireForegroundPromotionLease;
  proto.getActiveForegroundExecutionId = getActiveForegroundExecutionId;
  proto.releaseForegroundPromotionLease = releaseForegroundPromotionLease;
  proto.stopActiveForegroundExecution = stopActiveForegroundExecution;
  proto.enqueueBackgroundTaskNotification = enqueueBackgroundTaskNotification;
  proto.enqueueSubagentMessage = enqueueSubagentMessage;
  proto.drainPendingRuntimeCommandsForActiveLoop = drainPendingRuntimeCommandsForActiveLoop;
  proto.sealBackgroundTaskNotifications = sealBackgroundTaskNotifications;
  proto.discardPendingInput = discardPendingInput;
  proto.removePendingInputById = removePendingInputById;
  proto.reservePendingInputById = reservePendingInputById;
  proto.markPendingInputPromoting = markPendingInputPromoting;
  proto.releasePendingInputReservation = releasePendingInputReservation;
  proto.editPendingInputById = editPendingInputById;
  proto.reorderPendingInput = reorderPendingInput;
  proto.setQueueAutoDrain = setQueueAutoDrain;
  proto.completeExternalQueueDrain = completeExternalQueueDrain;
  proto.setFollowupMode = setFollowupMode;
  proto.emitModelSelected = emitModelSelected;
  proto.emitModeChanged = emitModeChanged;
  proto.discardPersistedPendingSteerInputs = discardPersistedPendingSteerInputs;
  proto.discardHeldPendingInputById = discardHeldPendingInputById;
  proto.clearAllPendingInputs = clearAllPendingInputs;
  // 上下文 / MCP / skill：tool 面与上下文段落必须在请求前刷新，绑定名与 turn loop 调用点一致。
  // [契约] ensureContextInitialized 与 refreshMcpToolsIfChanged 都绑在 AgentRuntime 原型上：绑定名必须与 turn loop 调用点逐字一致，改名只能两侧同批改。
  // initializeMcp 与 startMcpStartup 不是同义词：前者确保已初始化，后者只负责拉起后台启动流程
  // ensureContextInitialized 之后才能读 getSkillCatalog，顺序由 turn 侧保证，本表不承担编排职责
  // [权衡] 这些能力保留独立名字而不合并成单个 refresh，是为了让调用点显式表达自身依赖
  proto.createDefaultSubagentPort = createDefaultSubagentPort;
  proto.ensureContextInitialized = ensureContextInitialized;
  proto.getSkillCatalog = getSkillCatalog;
  proto.createContextBuilderFromSnapshot = createContextBuilderFromSnapshot;
  proto.loadProjectMemoryRoot = loadProjectMemoryRoot;
  proto.logMemorySkipped = logMemorySkipped;
  proto.injectPluginReferenceReminderFromTurn = injectPluginReferenceReminderFromTurn;
  proto.initializeMcp = initializeMcp;
  proto.refreshMcpToolsIfChanged = refreshMcpToolsIfChanged;
  proto.startMcpStartup = startMcpStartup;
  proto.discoverSkillsForContext = discoverSkillsForContext;
  proto.createConfigOnlyContextSnapshot = createConfigOnlyContextSnapshot;
  proto.initializeMessageHistoryFromContext = initializeMessageHistoryFromContext;
  proto.extractToolCallsFromResult = extractToolCallsFromResult;
  proto.shouldStreamModelText = shouldStreamModelText;
  // [契约] 模型请求只允许从这里进入：请求本身由 runModelTextRequest 负责，流式事件另由 emitModelStreamingEvent 发出
  // shouldStreamModelText 是纯判定，必须在发起请求前调用，请求开始后再判断已无意义
  // [失败路径] 模型错误在本层不吞：交给 turn loop 决定重试、降级还是上报，绑定缺失会让等待状态无人推进
  // createModelStatusSink 与 logModelNetworkStatus 只做观测，不改变请求结果，不要在此处加控制流
  proto.runModelTextRequest = runModelTextRequest;
  proto.emitModelStreamingEvent = emitModelStreamingEvent;
  proto.createModelStatusSink = createModelStatusSink;
  proto.logModelNetworkStatus = logModelNetworkStatus;
  proto.logContextUsageSnapshot = logContextUsageSnapshot;
  proto.logModelRequestSteeringContext = logModelRequestSteeringContext;
  proto.buildModelMessageTailDiagnostics = buildModelMessageTailDiagnostics;
  proto.buildContextUsageSnapshot = buildContextUsageSnapshot;
  proto.buildContextUsageBreakdownFromSnapshot = buildContextUsageBreakdownFromSnapshot;
  proto.buildContextUsageCategory = buildContextUsageCategory;
  proto.buildToolUsageDetail = buildToolUsageDetail;
  proto.buildSkillUsageDetails = buildSkillUsageDetails;
  proto.buildMessageRoleBreakdown = buildMessageRoleBreakdown;
  proto.estimatedMetric = estimatedMetric;
  proto.estimatedMetricFromKnown = estimatedMetricFromKnown;
  proto.sumMetrics = sumMetrics;
  // 冷恢复与上下文重建：resume 相关方法同名导出靠源模块区分（toScheduleState 等）。
  proto.toScheduleState = toScheduleState;
  proto.resumeFromStore = resumeFromStore;
  proto.readSessionTodosForContext = readSessionTodosForContext;
  proto.readSessionTargetForContext = readSessionTargetForContext;
  proto.injectTargetStateIntoMessageHistory = injectTargetStateIntoMessageHistory;
  proto.recordTargetChanged = recordTargetChanged;
  proto.recordGoalStateChangeReminder = recordGoalStateChangeReminder;
  proto.continueActiveTargetIfIdle = continueActiveTargetIfIdle;
  proto.continueActiveTargetLoop = continueActiveTargetLoop;
  proto.targetContinuationCandidate = targetContinuationCandidate;
  proto.accountTargetTurnCompletion = accountTargetTurnCompletion;
  proto.startTargetTurnAccounting = startTargetTurnAccounting;
  proto.heartbeatTargetTurnAccounting = heartbeatTargetTurnAccounting;
  proto.finishTargetTurnAccounting = finishTargetTurnAccounting;
  proto.pauseActiveTargetForCancellation = pauseActiveTargetForCancellation;
  proto.activatePausedTargetAfterResume = activatePausedTargetAfterResume;
  proto.runSessionStartHooks = runSessionStartHooks;
  proto.runUserPromptSubmitHooks = runUserPromptSubmitHooks;
  proto.runStopHooks = runStopHooks;
  proto.injectHookAdditionalContextIntoMessageHistory =
    injectHookAdditionalContextIntoMessageHistory;
  proto.shouldContinueAfterStopHooks = shouldContinueAfterStopHooks;
  // turn / compact 主链路入口：executeTurn 与 executeTurnCommand 必须保持同一可调用入口名。
  // [契约] turn 主链路：admitPrompt 做 busy 准入，executeTurn 跑一轮，executeTurnCommand 处理命令式输入
  // 三者调用顺序由上层决定，本表只保证三个名字都可用；缺 admitPrompt 会让命令绕过排队直接开跑
  // [失败路径] executeTurn 抛错时必须已把执行态落回 idle，否则后续输入被判 busy 而静默丢失
  // admitPrompt 与 enqueueRuntimeCommand 是两条准入路径，改名时需同时检查 TUI 与协议层调用点
  proto.executeTurn = executeTurn;
  proto.admitPrompt = admitPrompt;
  proto.executeTurnCommand = executeTurnCommand;
  // [契约] compact 分层：手动、自动、micro、reactive 四个入口并列，触发条件不同但最终写同一条时间线
  // executeManualCompact 不受 autoCompactIfNeeded 的阈值约束，用户触发时即使未超限也要执行
  // [权衡] 保留四个独立名字是为了让日志能区分触发原因，合并成单入口会丢失 compact 归因
  proto.executeManualCompact = executeManualCompact;
  proto.autoCompactIfNeeded = autoCompactIfNeeded;
  proto.microcompactIfNeeded = microcompactIfNeeded;
  proto.reactiveCompactAfterContextExceeded = reactiveCompactAfterContextExceeded;
  proto.compactActiveConversation = compactActiveConversation;
  proto.executeRewindCommand = executeRewindCommand;
  proto.formatRewindStatus = formatRewindStatus;
  proto.rewindWorkspaceToCheckpoint = rewindWorkspaceToCheckpoint;
  proto.rewindToMessage = rewindToMessage;
  proto.rewindCascadeToMessage = rewindCascadeToMessage;
  proto.rewindConversationToMessage = rewindConversationToMessage;
  proto.rewindWorkspaceToMessage = rewindWorkspaceToMessage;
  proto.finishUnavailableRewind = finishUnavailableRewind;
  // fork / rewind 三路径：checkpoint、会话 fork、消息 rewind 都要能被独立调用（链路 6）。
  // [事务] fork/rewind 三路径：checkpoint 文件恢复、会话 fork、消息级 rewind，各自可独立调用且不共享事务边界
  // preview 与 apply 成对：previewWorkspaceFileRewind 只算不改，applyWorkspaceFileRewind 才真正写盘
  // [失败路径] apply 中途失败不会自动回滚已写文件，靠 checkpoint 再恢复一次，因此恢复入口必须始终可调用
  // fork 系列会复制消息与工作区，绑定缺失时表现为新会话缺历史，而不是抛出可定位的错误
  proto.restoreWorkspaceCheckpointArtifact = restoreWorkspaceCheckpointArtifact;
  proto.copySessionMessagesForFork = copySessionMessagesForFork;
  proto.listWorkspaceCheckpoints = listWorkspaceCheckpoints;
  proto.forkWorkspaceFromCheckpoint = forkWorkspaceFromCheckpoint;
  proto.forkStableConversationAtMessage = forkStableConversationAtMessage;
  proto.createSelectionSideConversation = createSelectionSideConversation;
  proto.forkConversationBeforeMessage = forkConversationBeforeMessage;
  proto.loadCheckpointMessagePreviews = loadCheckpointMessagePreviews;
  proto.previewWorkspaceFileRewind = previewWorkspaceFileRewind;
  proto.applyWorkspaceFileRewind = applyWorkspaceFileRewind;
  // [契约] 工具面：scheduleTools 决定调用顺序与并发，executeTools 只负责执行，二者不可互相替代
  // emitPermissionRequest 与 resolvePermission 必须成对：只发不收会让权限请求永久 pending，turn 卡住
  // [资源] emitFileMutationCheckpoint 在写操作前埋点，漏绑会导致 rewind 找不到可回退的文件快照
  // cancelBackgroundTask 与 stopBackgroundTask 语义不同（取消 vs 停止），不要为省一行只绑其中一个
  proto.scheduleTools = scheduleTools;
  proto.executeTools = executeTools;
  proto.emitToolScheduledEvents = emitToolScheduledEvents;
  proto.emitFileMutationCheckpoint = emitFileMutationCheckpoint;
  proto.emitPermissionRequest = emitPermissionRequest;
  proto.resolvePermission = resolvePermission;
  proto.readBackgroundBashOutput = readBackgroundBashOutput;
  proto.cancelBackgroundTask = cancelBackgroundTask;
  proto.stopBackgroundTask = stopBackgroundTask;
  proto.cancelRunningRuntimeBackgroundTasks = cancelRunningRuntimeBackgroundTasks;
  proto.hasRunningBackgroundTasks = hasRunningBackgroundTasks;
  proto.buildBackgroundTaskPayload = buildBackgroundTaskPayload;
  // 事件与 durable 写入：createEvent/appendEvent/notifyEventSinks 是投影事实的唯一入口。
  // [事务] 事件三件套是投影事实的唯一写入路径：createEvent 造事实，appendEvent 持久化，notifyEventSinks 广播
  // ensureSessionPersisted 先于 appendEvent 的必要性由实现保证，本表不插入任何顺序逻辑
  // [失败路径] 三者只绑一半时事件写进 store 却无人通知，TUI 与重放视图分叉且无法自愈
  // isSessionPersisted 是只读探测，不产生副作用，可与写入方法自由并行调用
  proto.createEvent = createEvent;
  proto.appendEvent = appendEvent;
  proto.notifyEventSinks = notifyEventSinks;
  proto.ensureSessionPersisted = ensureSessionPersisted;
  proto.isSessionPersisted = isSessionPersisted;
  proto.buildCompactTimelinePayload = buildCompactTimelinePayload;
  // [事务] durable 写入：buildCompactTimelinePayload 只组装，persistCompactTimeline 才落库，失败走 finishCompactTimelineFailure 收尾
  // [失败路径] 失败收尾必须把 timeline 收敛成终态，否则下次 resume 的 recoverInterruptedCompactTimelines 会反复捡起同一条
  // persistCompactSummary 与 timeline 分开写、不共享事务，读取方需容忍短暂的半成品状态
  proto.persistCompactTimeline = persistCompactTimeline;
  proto.finishCompactTimelineFailure = finishCompactTimelineFailure;
  proto.recoverInterruptedCompactTimelines = recoverInterruptedCompactTimelines;
  proto.persistCompactSummary = persistCompactSummary;
  proto.persistUserPrompt = persistUserPrompt;
  proto.recordPendingModelChange = recordPendingModelChange;
  proto.persistPendingModelChangeTimeline = persistPendingModelChangeTimeline;
  proto.persistSyntheticUserNotice = persistSyntheticUserNotice;
  proto.persistSyntheticUserNoticeForSession = persistSyntheticUserNoticeForSession;
  proto.persistAssistantTimelinePartForSession = persistAssistantTimelinePartForSession;
  proto.persistAssistantMessage = persistAssistantMessage;
  proto.persistMessage = persistMessage;
  proto.persistPart = persistPart;
  proto.rebuildProjection = rebuildProjection;
  // 无 turn 的辅助模型调用与记忆抽取：不参与 turn 生命周期，单独绑定。
  // [契约] 这三个入口在 turn 之外触发：标题生成与连通性探测可能在首条 prompt 之前执行，不能假定消息历史已就绪
  // [资源] 记忆抽取走独立调度器，进程退出前必须 drain 或 shutdown，否则残留任务会在关闭窗口期继续访问已关闭的 store
  proto.generateWorkspaceText = generateWorkspaceText;
  proto.sampleModel = sampleModel;
  proto.drainMemoryExtractions = drainMemoryExtractions;
  proto.isProjectMemoryEnabled = isProjectMemoryEnabled;
}
