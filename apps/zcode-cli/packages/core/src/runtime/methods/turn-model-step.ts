// INV-01 本步只允许三种返回值，且互斥：continue、output_continuation、break；守住位置：ModelStepResult 类型与函数内全部 return 语句；改错故障：主循环无法判断该重建请求、续写还是结束，出现空转或提前终止 turn。
// INV-02 一切恢复动作都必须映射为 continue，不得新增返回值；守住位置：catch 分支里每处 return "continue"；改错故障：恢复成功后主循环仍按 break 收口，turn 被误判完成，用户丢失后续工具轮。
// INV-03 [事务] assistant 占位消息必须先于模型请求落库；守住位置：persistAssistantMessage 与 step-start 的 persistPart 都排在 runModelTextRequest 之前；改错故障：流式 part 无消息可挂，中途 Stop 后无法从 transcript 恢复半成品。
// INV-04 ModelRequest 事件只记录 recordedMessages；守住位置：createEvent 的 messages 字段取 options.recordedMessages；改错故障：query-local 续写提示被写入持久轨迹，回放出的请求与真实请求不一致。
// INV-05 [事务] assistantPersistenceAnchor 必须在请求前采样；守住位置：captureAssistantPersistenceAnchor 的调用点；改错故障：用请求后的历史做 anchor，提交时定位错位，导致消息重复或整条丢失。
// INV-06 输出预算必须叠加剩余上下文窗口；守住位置：resolveModelStepMaxOutputTokens 的 estimatedCurrentUsage 入参；改错故障：input 加 output 超过模型窗口，provider 直接报超窗，正常请求白白失败一次。
// INV-07 取消信号必须贯穿请求与请求后的检查；守住位置：runModelTextRequest 的 abortSignal 与紧随其后的 throwIfTurnAborted；改错故障：用户 Stop 后仍继续执行工具，已取消的 turn 继续产生副作用。
// INV-08 [并发] pendingStreamRecoveryRequest 读取后必须立即清空；守住位置：streamRecoveryRequest 赋值后那行置 undefined；改错故障：同一份恢复状态被后续请求重复消费，重试次数虚增、预算提前耗尽。
// INV-09 [失败路径] 失败链顺序固定为用量事实、执行模型退回、流恢复、off-peak 接管、admission 重试、取消快照、reactive compact；守住位置：catch 内各分支的排列；改错故障：退回被流恢复抢先，加速 provider 重试到预算耗尽才降级。
// INV-10 [失败路径] 声明式退回命中即消费本轮恢复决策；守住位置：以 !selectionFallbackMatch 作为流恢复、off-peak、admission 三类分支的前置条件；改错故障：退回目标解析失败后仍重试同一个失败 provider，用户看到重复失败。
// INV-11 [事务] 退回或流恢复成功后按工具计数增量重置续写预算；守住位置：toolCallCountBeforeSelectionFallback 与 toolCallCountBeforeStreamRecovery 的比较；改错故障：继承 length 链计数，退回模型第一次截断就提前耗尽预算。
// INV-12 [并发] off-peak 接管必须先 abandon 再重开；守住位置：isOffPeakUserTakeover 分支内的 abandon 与 off_peak_request_replaced 落库；改错故障：旧请求工具仍处 pending，新一轮与旧 ledger 事件互相矛盾。
// INV-13 [事务] admission 繁忙短重试只允许在首 token 前无内容时丢弃；守住位置：start_plan_admission_retry_discarded 分支；改错故障：已有文本或工具 anchor 仍被丢弃，用户已看到的内容凭空消失。
// INV-14 [权衡] 取消快照只用于展示，不进入模型历史；守住位置：persistCancelledStreamSnapshot 与紧随的 commitTurnRequestEntries 条件；改错故障：半成品被重放给 provider，模型上下文与用户所见不一致。
// INV-15 [事务] 取消必须在 assistant 终态里写入 turnResult=cancelled；守住位置：persistAssistantMessage 的 error.data.turnResult；改错故障：冷恢复把用户 Stop 当成 provider 失败，多生成一条 TurnError。
// INV-16 [失败路径] 超窗判定必须先于可疑空响应判定；守住位置：isContextExceededFinishReason 检查排在 isSuspiciousEmptyModelResult 之前；改错故障：空内容空 usage 的超窗被包成普通 ModelError，reactive compact 无法触发。
// INV-17 [失败路径] 同一个 model step 只允许一次 reactive compact；守住位置：reactiveCompactAttemptedInCurrentModelStep 的判定与提前 return false；改错故障：压缩救不回来仍反复请求 provider，形成持续消耗的循环。
// INV-18 [失败路径] 续写预算耗尽必须收口为 ModelError 并关闭 steerable；守住位置：output_continuation 分支里 createCoreError 到抛出 exhaustedError 的链路；改错故障：截断响应当作正常完成，用户只拿到半句话且无恢复入口。
//
// 模块职责：实现一轮 Agent 主循环里的单次模型步，负责一次 provider 往返的持久化、流式协调、失败恢复分派、成功收尾与工具批次执行。
// 状态所有权：模型、turn-local 历史、计数器、turn machine 与取消信号归 RegularTurnLoopState；本文件只读这些字段并按契约回写，流内工具归 streaming 协调器。
// 阅读顺序：先看 ModelStepResult 契约与外层 telemetry 包装，再看锚点与占位持久化，然后看失败恢复链，最后看成功分类与工具执行。
/**
 * ============================================================================
 * turn-model-step.ts —— Agent 主循环中的"单次模型步"(一次 provider 往返)
 * ============================================================================
 *
 * 【调用链】
 *   turn-loop.ts runRegularTurnLoop(每轮迭代构造好 provider 请求)
 *     └─ runModelBackedTurnStep(本文件)   ← step telemetry 包装,只负责生命周期上报
 *          └─ runModelBackedTurnStepImpl   ← 真正的单步逻辑
 *
 * 【返回值如何驱动主循环(ModelStepResult)】
 *   "continue"            本轮执行了工具 / 触发了一次恢复(stream recovery、执行模型退回、
 *                         StartPlan 繁忙重试、off-peak 接管、reactive compact、Stop hook 续跑等),
 *                         主循环应进入下一轮迭代(通常要重新构造请求)。
 *   "output_continuation" 模型因 max output 被截断且仍有续写预算,主循环应紧接着再发一次
 *                         "继续"请求(不产生新的工具轮次)。
 *   "break"               模型没有可执行工具,且 guide / Stop hook 都不再续跑 → 结束本 turn。
 *
 * 【单步内部顺序】
 *   1. 持久化 assistant 占位消息 + step-start part,使流式 part 能边到边落库;
 *   2. 发 ModelRequest 事件(记录的是剔除 query-local Continue 提示后的消息);
 *   3. 建立 streaming tool 协调器(流式期间提前接收 tool call,降低等待);
 *   4. 计算本次 maxOutputTokens(受剩余上下文与预算策略约束),调用模型;
 *   5. 失败分支:用量事实 → 执行模型退回 → 流恢复 → off-peak 接管 → admission 繁忙重试 →
 *      取消快照 → 持久化错误 → reactive compact(超窗)→ 仍无法恢复则抛错;
 *   6. 成功分支:更新 state、分类输出续写、识别"finishReason 超窗/可疑空响应"、
 *      持久化 reasoning/text、发 ModelComplete 事件、记录用量;
 *   7. 有可执行工具:提交 assistant 到本轮历史并执行工具,返回 "continue";
 *      没有工具:交给 finishModelStepWithoutToolCalls(可能返回 "break" 或由 hook/guide 续跑)。
 * ============================================================================
 */
import type { ToolSearchExecutionContext } from "@zcode/contracts";
import { getTurnTools } from "./turn-tool-visibility.js";
import { isOffPeakUserTakeover, refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";

import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactTrigger,
  CoreErrorType,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createMessageId,
  createPartId,
  getModelUsageTotalTokens,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId, ModelNetworkStatusEvent, ModelToolContract } from "../deps.js";
import {
  createRuntimeAssistantEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  createModelContextExceededFinishError,
  createCompactRapidRefillError,
  objectKeys,
  projectExecutionErrorPayload,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  readRawFinishReason,
  throwIfTurnAborted,
  isModelContextExceededError,
  isTurnCancellationError,
  buildTurnFileChangeSummary,
} from "../helpers/index.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
  RuntimeModelTextResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import {
  captureAssistantPersistenceAnchor,
  finishModelStepWithoutToolCalls,
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
  recordModelHistoryRound,
} from "./turn-loop-state.js";
import {
  querySourceForTask,
  recordMainTurnCacheHitUsage,
  recordMainTurnModelUsage,
} from "./turn-model-step-usage.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "./model-token-limits.js";
import {
  applyExecutionSelectionFallback,
  matchExecutionSelectionFallback,
} from "./turn-execution-fallback.js";
import {
  appendOutputTokenContinuation,
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
} from "./turn-output-token-continuation.js";

type ModelStepResult = "continue" | "output_continuation" | "break";

/**
 * 单次模型步的外层包装:只负责 step telemetry 的生命周期上报。
 *
 * 与 turn.ts 中 turn telemetry、compact.ts 中 compaction telemetry 的分层一致:
 * 真正逻辑在 Impl,包装层保证无论成功/失败/取消都能正确结束 span,并把错误原样抛回主循环。
 */
// [契约] 包装层只做 step telemetry：assistantMessageId 同时作为 stepId，让 span 与消息级追踪对齐。
// [顺序] stepTelemetry.run 必须包住整个 Impl 调用，成功、失败与取消都在同一个 span 内收口。
// [失败路径] 完成状态按返回值映射：output_continuation 记 model_completed、continue 记 tool_requested、break 记 turn_completed。
// [失败路径] 异常时先用 isTurnCancellationError 区分 abort_signal 与 unhandled，再把原错误抛回主循环。
// [契约] 包装层不得吞掉异常或改写返回值，否则主循环的取消识别与失败收口会失真。
// [失败路径] 取消异常必须在 span 关闭前结束为 abort_signal，否则统计里用户取消会被算成失败。
export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
    toolSearch?: ToolSearchExecutionContext;
  },
): Promise<ModelStepResult> {
  // assistant 消息 id 同时作为本次 step 的 stepId,便于 telemetry 与消息级追踪对齐。
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      // 结束状态按返回值映射:续写=模型完成、继续=请求了工具、结束=turn 完成。
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

/**
 * 单次模型步的真正实现。
 *
 * @param state  主循环状态(模型、turn-local 历史、计数器、turn machine、取消信号)
 * @param options 本轮请求相关输入:
 *   messages                  实际发给 provider 的消息
 *   recordedMessages          事件/轨迹记录用的消息(已剔除 query-local Continue 提示)
 *   sourceEntries             投影消息对应的原始条目(usage 归属、token 估算)
 *   requestEntries            本次请求的 turn-local 条目快照(超窗补救时需要)
 *   tools / toolSearch        本次暴露给模型的工具与 ToolSearch 执行上下文
 *   drainedSteerForNextRequest 上轮工具批次后消费到的 guide 诊断(仅用于日志)
 * @param assistantMessageId 预先分配的 assistant 消息 id(同时用作 stepId)
 */
async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
    toolSearch?: ToolSearchExecutionContext;
  },
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const model = state.model;
  // 本次是第几个模型步(从 0 开始),用于日志、telemetry 与 compact 阶段判断。
  const modelStepIndex = state.modelStepCount;
  // 模型请求开始时间:同时作为 assistant 消息的 createdAt 与各 part 的 time.start。
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  // 记录"提交 anchor":成功/失败持久化 assistant 时,用它把该 assistant 及其 parts
  // 原子地写入 canonical history,避免半条消息进入历史。
  // [事务] assistantPersistenceAnchor 在请求前采样，成功与失败持久化都用它把 assistant 及其 parts 原子写入 canonical history。
  // [状态所有权] 模型、turn-local 历史、计数器、turn machine 与取消信号都归 state；本函数不再新建第二份可变真相。
  // [契约] querySource 由 taskType 投影为 main_turn、subagent、workflow_child，决定 usage 归组与 ModelComplete 展示字段。
  // [权衡] executionMaxOutputTokens 直接取模型声明上限，不再把它伪装成长期 Active Model 状态。
  // [契约] executionContextWindow 同时服务两处：本次 max output 预算与 ModelComplete 的 context meter。
  // [资源] modelTraceContext 挂在 turnTraceContext 下，携带 provider、model、iteration、querySource 供按请求排障。
  // [契约] iteration 是粗粒度分档：toolCallCount 为 0 记 0，否则每 10 次工具调用进一档。
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  // querySource 区分 main_turn / subagent / workflow_child,影响 usage 归组与展示字段。
  const querySource = querySourceForTask(this.config.taskType);
  const executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 请求预算由 Agent 执行链显式决定。普通 Turn 选择打满模型声明的上限，
  // ModelFactory 不再把该请求参数伪装成长期 ModelSelection/Active Model 状态。
  const executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  // 上下文窗口用于:(a) 计算本次 max output 预算;(b) ModelComplete 里给 UI 的 context meter。
  const executionContextWindow = model.properties.contextWindow;
  // 每个模型步一个子 trace,标注 provider/model/iteration/querySource,便于按请求排障。
  const modelTraceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });

  // 诊断日志:记录本次请求携带了哪条 guide/steer 输入、当前第几个模型步,
  // 用于排查"guide 是否真的进入了请求"以及"请求内容与预期是否一致"。
  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  // 先持久化 assistant 占位消息 + step-start part:后续流式 reasoning/text/tool part
  // 可以边产生边挂到这条消息上;即使用户中途 Stop,durable transcript 也能恢复出半成品。
  // [顺序] 先 persistAssistantMessage 落占位消息，再 persistPart 落 step-start，流式 part 才有可挂靠的消息。
  // [事务] 两步都必须在发起模型请求前完成，用户中途 Stop 时 durable transcript 才能恢复出半成品。
  // [契约] finishPersistence 在 ModelRequest 事件追加后才结束，这段写入计入 preparation 耗时。
  // [契约] ModelRequest 记录 recordedMessages 而非实际请求 messages，query-local 续写提示不进入持久轨迹。
  // [契约] 事件里的 toolCount 是本轮暴露给 provider 的工具数，iteration 与 trace 属性保持同口径。
  // [事务] 占位消息的 createdAt 取请求开始时间，后续 part 的 time.start 与之对齐，避免出现负时长。
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  // 发 ModelRequest 事件:记录"可记录投影"(recordedMessages),而非实际请求。
  // 自动续写提示只属于本次请求，不应写入持久化的 ModelRequest 轨迹。
  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // messages 用的是"可记录投影"(已剔除 query-local 的续写提示);
      // toolCount 是本轮实际暴露给 provider 的工具数量(schema 体积直接相关);
      // iteration 是粗粒度的工具轮序号(每 10 次 tool call 记一档,用于日志分组)。
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
  // streaming 工具协调器:在模型流式输出期间就提前接收/校验 tool call,
  // 这样等流结束时可以尽快执行工具;同时负责流失败时的恢复与已接收工具的 settle。
  // [并发] 协调器在流式期间提前接收与校验 tool call，只读工具不必等流结束才开始执行。
  // [状态所有权] 已接收工具与提前返回的结果都归协调器所有，drain 阶段才与最终 toolCalls 对齐。
  // [状态所有权] pendingStreamRecoveryRequest 读后立即置空，恢复状态只能被本次请求消费一次。
  // [事务] networkEventStartIndex 在请求前采样，失败用量事实据此切出本次调用产生的网络事件。
  // [失败路径] recordModelNetworkStatus 区分当前与失败 requestId，恢复事件才能把来源 requestId 带给 UI。
  // [契约] 协调器同时接收 assistantMessageId 与本次 traceContext，提前执行的工具结果才落在同一条消息与同一 span 上。
  const streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    toolSearch: options.toolSearch,
    traceContext: modelTraceContext,
  });
  // 记录请求开始前的事件下标:用量事实需要知道本次模型调用产生了哪些网络事件。
  const networkEventStartIndex = state.events.length;
  let latestStreamSnapshot: RuntimeModelStreamSnapshot = { reasoning: [], text: "" };
  // 上一轮失败时保存的"流恢复请求"状态(如重试次数、已丢弃内容),本轮继续沿用。
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;
  let latestModelRequestId: string | undefined;
  let latestFailedModelRequestId: string | undefined;
  // 跟踪本次请求的 requestId:model_request_started 更新"当前请求",
  // model_stream_stalled / model_request_failed 更新"失败请求"。
  // 后续恢复事件需要把"从哪个 requestId 恢复"带给 UI/adapter,所以必须单独记录。
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      latestModelRequestId = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      latestFailedModelRequestId = event.requestId;
    }
  };

  let result: RuntimeModelTextResult;
  try {
    // 输出预算分两步:
    //   1) baseline 与普通请求同口径(模型声明上限 + 全局策略);
    //   2) resolveModelStepMaxOutputTokens 再叠加"剩余上下文窗口"约束,
    //      避免 input + output 超过模型窗口(estimateCurrentModelInputTokens 用 provider usage 优先)。
    const baselineMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: executionMaxOutputTokens,
    });
    // 真正发起模型请求:流式回调把 reasoning/text/tool call 实时交给协调器,
    // 这样工具可以在流结束前后尽早开始执行;streamRecovery 沿用上一次失败的重试状态。
    result = await this.runModelTextRequest({
      abortSignal: state.turnAbortSignal,
      assistantMessageId,
      events: state.events,
      maxOutputTokens: resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens,
        contextWindow: executionContextWindow,
        estimatedCurrentUsage: estimateCurrentModelInputTokens(
          options.messages,
          options.sourceEntries,
        ),
        modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      }),
      latestRealUserMessageIndex: options.latestRealUserMessageIndex,
      messages: options.messages,
      sourceEntries: options.sourceEntries,
      model,
      onStreamSnapshot: (snapshot) => {
        // 流式快照:取消/失败时用于持久化"已经生成到哪一步"的 partial assistant。
        latestStreamSnapshot = snapshot;
      },
      onModelNetworkStatus: recordModelNetworkStatus,
      onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
      onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
      // 流式 tool call:协调器在这里判断能否"提前执行只读工具",并记录声明顺序。
      onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
      streamRecovery: streamRecoveryRequest,
      tools: options.tools,
      toolSearchEnabled: options.toolSearch?.mode === "native",
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(state.turnAbortSignal);
  } catch (error) {
    // 失败恢复链(按优先级,命中即 return "continue" 重试下一轮):
    //   a. 先记一项失败用量事实,统计侧才能区分成功/失败/取消;
    //   b. 执行模型退回(加速 provider 失败 → 退回会话模型);
    //   c. 同模型流恢复(网络中断/首 token 前失败等);
    //   d. 闲时任务被用户接管 → 丢弃本次响应,按新模型继续;
    //   e. Start Plan admission 繁忙 → 短延迟重试;
    //   f. 取消 → 持久化已产生的半成品快照;
    //   g. 超窗 → reactive compact(只允许一次/上下文超窗);
    //   h. 仍无法恢复 → 持久化错误并抛出,由主循环/turn 收口。
    let finalError = error;
    await recordMainTurnModelUsage(this, state, {
      assistantMessageId,
      error: finalError,
      model,
      modelTraceContext,
      networkEventStartIndex,
      startedAt: modelStartedAt,
      status: state.turnAbortSignal.aborted ? "cancelled" : "error",
    });
    const failedRequestId = latestFailedModelRequestId ?? latestModelRequestId;
    // 执行 Selection 的声明式退回必须先于同模型 stream recovery：明确归因到加速 provider/network
    // 边界的请求失败都要退回会话模型（spec §2.2）。若 recovery 在前，流中断后会先在加速模型上
    // 重试到预算耗尽，降级形同虚设。
    // [失败路径] 失败链首步先记录用量事实，状态取 turnAbortSignal 决定 cancelled 还是 error。
    // [顺序] 声明式执行模型退回必须先于同模型 stream recovery，否则流中断会在加速 provider 上重试到预算耗尽。
    // [并发] toolCallCountBeforeSelectionFallback 在退回前采样，用于判断 settlement 是否真的新增了工具轮。
    // [事务] 退回落地后若工具计数增长，需要 completeOutputTokenRecovery 重置 length 链计数。
    // [失败路径] 无 fallback 目标时不得进入通用恢复，否则会重新请求同一个已失败的 execution provider。
    // [失败路径] 流恢复成功同样按工具计数增量决定是否重置续写预算，纯文本丢弃不绕过上限。
    // [失败路径] Start Plan 恢复次数耗尽后要换成自动重试耗尽错误，否则与首轮繁忙失败无法区分。
    // [并发] off-peak 接管与 admission 短重试都以未 aborted 且无 fallback 匹配为前提，避免与退回决策叠加。
    const selectionFallbackMatch = matchExecutionSelectionFallback({
      error: finalError,
      executionProviderId: String(executionModelSelection.providerId),
      selectionFallback: state.selectionFallback,
      turnAborted: state.turnAbortSignal.aborted,
    });
    const toolCallCountBeforeSelectionFallback = state.toolCallCount;
    const selectionFallbackResult = selectionFallbackMatch
      ? await applyExecutionSelectionFallback(this, state, {
          assistantCreatedAt,
          assistantMessageId,
          error: finalError,
          executionModel: model,
          match: selectionFallbackMatch,
          modelTraceContext,
          streamingToolCoordinator,
        })
      : undefined;
    if (selectionFallbackResult?.applied) {
      // Bug 根因：fallback settlement 已提交工具结果并建立新 anchor，却继承了此前 length 链的计数，
      // 使退回模型第一次截断就可能提前耗尽。只按工具计数增量重置，纯文本 tail discard 不绕过上限。
      if (state.toolCallCount > toolCallCountBeforeSelectionFallback) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    const toolCallCountBeforeStreamRecovery = state.toolCallCount;
    // Bug 根因：退回目标解析失败后若继续进入通用恢复，会重新请求同一个已失败的 execution provider。
    // 命中声明就已消费本轮恢复决策；无处可退必须保留原错误并直接失败。
    if (
      !selectionFallbackMatch &&
      (await streamingToolCoordinator.recoverFromModelFailure(
        error,
        assistantCreatedAt,
        failedRequestId ? { failedRequestId } : undefined,
      ))
    ) {
      if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    if (
      !state.turnAbortSignal.aborted &&
      isOffPeakUserTakeover(error) &&
      refreshOffPeakTurnAfterTakeover(this, state)
    ) {
      // off-peak 接管:用户在低峰期手动接管,放弃当前 execution provider 的请求,
      // 改用用户指定模型重发。abandon 工具 + 持久化 off_peak finish 标记后重开。
      // 失败处理:persistAssistantMessage 失败会抛出,但工具已 abandon,不会留下 pending part。
      await streamingToolCoordinator.abandon("model_failed");
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "off_peak_request_replaced",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "continue";
    }
    const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
      error: finalError,
      providerId: executionModelSelection.providerId,
      state,
      turnNumber: this.turnNumber,
    });
    if (
      !selectionFallbackMatch &&
      !state.turnAbortSignal.aborted &&
      admissionRetryDelayMs !== undefined
    ) {
      // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
      // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
      const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
      this.logger?.warn("Main turn retrying after Start Plan admission busy", {
        ...traceContextToLogContext(modelTraceContext),
        event: "model.main_turn.retry_start_plan_admission_busy",
        module: "core.runtime",
        retryDelayMs: admissionRetryDelayMs,
        retryNumber: recoveryAttempt.retryNumber,
        maxRetries: recoveryAttempt.maxRetries,
        status: "waiting",
      });
      await emitStreamRecoveryStarted(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        finalError,
        recoveryAttempt,
      );
      // Start Plan busy 短重试:把空 assistant 标为 discarded 后重发,
      // 因为 admission 繁忙发生在首 token 前,没有可保留的文本/工具锚点。
      // 维护不变量#2:未提交的 assistant 内容才允许丢弃重试;这里没有内容所以直接丢弃。
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "start_plan_admission_retry_discarded",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      await emitStreamRecoveryRetryEvents(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        {
          ...recoveryAttempt,
          discardedReasoningBytes: 0,
          discardedTextBytes: 0,
          reason: "no_tool_committed",
          toolCallIds: [],
        },
      );
      await streamingToolCoordinator.abandon("model_failed");
      await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
      throwIfTurnAborted(state.turnAbortSignal);
      return "continue";
    }
    if (
      !selectionFallbackMatch &&
      state.streamRecoveryRetryCount > 0 &&
      !state.turnAbortSignal.aborted &&
      isStartPlanBusyStreamRecoveryFailure(finalError)
    ) {
      // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
      // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示“自动重试达到最大次数”。
      finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
    }
    // 无 fallback target 时工具已在上方 settlement；再次 abandon 会发布与终态矛盾的 ledger 事件。
    if (!selectionFallbackResult?.settledAcceptedTools) {
      await streamingToolCoordinator.abandon(
        state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
      );
    }
    if (
      state.turnAbortSignal.aborted &&
      isTurnCancellationError(finalError, state.turnAbortSignal)
    ) {
      // 取消路径:把已收到的流式快照落盘,让用户重启后能看到"取消前生成了什么"。
      // 维护不变量#2:取消时的半成品内容只用于展示,不进入模型历史;恢复时不会被重放。
      // 失败处理:persistCancelledStreamSnapshot 失败会抛出,但 turn 已取消,错误由 catch 收口。
      await persistCancelledStreamSnapshot(this, {
        assistantCreatedAt,
        assistantMessageId,
        snapshot: latestStreamSnapshot,
        traceContext: modelTraceContext,
      });
      const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
      if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
        // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
        // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
        commitTurnRequestEntries(this, state.turnRequestState, [
          createRuntimeAssistantEntry(
            latestStreamSnapshot.text,
            undefined,
            reasoning,
            state.model
              ? { providerId: state.model.providerId, modelId: state.model.modelId }
              : undefined,
          ),
        ]);
        recordModelHistoryRound(state);
      }
    }
    const finalErrorRecord =
      finalError && typeof finalError === "object"
        ? (finalError as Record<string, unknown>)
        : undefined;
    const persistedErrorCode =
      typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
    // [失败路径] 取消路径先把 latestStreamSnapshot 交给 persistCancelledStreamSnapshot 落盘，用户重启后能看到取消前生成的内容。
    // [权衡] 取消的半成品只用于展示，不进入模型历史；同时补提交 request entries 与 history 轮次，保持与冷恢复一致。
    // [事务] 失败与取消统一写一条带 error 的 assistant 终态，包含 code、attribution 与 turnResult。
    // [契约] turnResult 只在取消时写 cancelled，冷恢复才能区分用户 Stop 与真实 provider 失败。
    // [失败路径] 超窗错误在此尝试 reactive compact，成功返回 continue，失败才把原始错误抛给 turn 层。
    // [契约] 持久化的 code 与 attribution 来自结构化投影，不从错误文本反推。
    // [失败路径] 取消分支不重置 steerable 也不回收 pending，这些由 turn 层的终态收口统一处理。
    const persistedErrorProjection = projectExecutionErrorPayload(finalError);
    const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
      ? "cancelled"
      : undefined;
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        error: {
          name: finalError instanceof Error ? finalError.name : "UnknownError",
          data: {
            message: finalError instanceof Error ? finalError.message : String(finalError),
            ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
            // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
            ...(persistedErrorProjection.attribution
              ? { attribution: persistedErrorProjection.attribution }
              : {}),
            // 用户 Stop 的模型中止过去只持久化通用 error name/message，
            // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
            ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
          },
        },
      },
      modelTraceContext,
      model,
    );
    if (
      isModelContextExceededError(finalError) &&
      (await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        finalError,
        modelStepIndex,
        options.requestEntries,
      ))
    ) {
      return "continue";
    }
    throw finalError;
  }

  // 请求成功:先把响应与计数写回 loop state(供后续 turn 收尾与统计使用)。
  state.modelResponse = result.text;
  state.modelStepCount += 1;
  state.tokenCount += getModelUsageTotalTokens(result.usage);

  // 缓存命中统计:provider 报告读取到缓存时更新 messageHistory,用于 UI/统计展示。
  if (result.usage.cacheReadTokens && result.usage.cacheReadTokens > 0) {
    this.messageHistory.setCacheHit(result.usage.cacheReadTokens);
  }

  // 解析模型返回的工具调用。automation create limit 命中后,即使 provider 仍幻觉出
  // tool call 也必须忽略:当前用户 turn 已降级为纯文本终止边界,不能重新进入执行器。
  let toolCalls = this.extractToolCallsFromResult(result);
  const providerToolCallCount = toolCalls.length;
  const localTerminalResponse = state.automationCreateLimitReached === true;
  if (state.automationCreateLimitReached && toolCalls.length > 0) {
    // 即使 provider 在 tools=[] 后仍幻觉出工具调用，也不能重新进入执行器；
    // 上限命中后的当前用户 turn 已经是纯文本终止边界。
    this.logger?.warn("Ignored tool calls after automation create limit was reached", {
      event: "automation.create_limit.tool_calls_ignored",
      module: "core.runtime",
      status: "completed",
      toolCallCount: toolCalls.length,
    });
    toolCalls = [];
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  } else if (state.automationCreateLimitReached && state.modelResponse.trim().length === 0) {
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  }
  // 分类"输出是否被 max output 截断":决定是继续追加续写请求、还是按终态处理。
  // localTerminalResponse(automation 上限)已接管终止语义,不再重解释 length/context。
  const usage = result.usage ?? {};
  const responseLength = state.modelResponse.length;
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // Automation create-limit 已经接管当前响应的终止语义；若在清空
  // provider tool calls 后仍重新解释 length/context reason，纯文本终态会再续跑 3 次。
  // [契约] automationCreateLimitReached 命中后必须忽略 provider 幻觉出的 tool call，纯文本终态不允许重新进入执行器。
  // [契约] localTerminalResponse 为真时续写分类固定 none，不再重新解释 length 或 context。
  // [失败路径] finishReason 超窗且无工具时先尝试 reactive compact，避免被可疑空响应包成普通错误。
  // [失败路径] 可疑空响应统一落成明确错误，主循环不会对零内容结果空转重试。
  // [契约] 恢复语义确认后统一把 finishReason 改写为 length，provider 原始事实只保留在 diagnostics 日志。
  // [事务] 推理与文本 part 落库后，ModelComplete 作为权威完成事件携带 stopReason、usage、cacheHit 与 fileChanges。
  // [并发] 只有非 providerExecuted 的工具进入执行器，先 admit 再 drain，再由 executeToolCallsForModelStep 调度。
  const outputTokenContinuation = localTerminalResponse
    ? "none"
    : classifyOutputTokenContinuation({
        continuationCount: state.turnRequestState.outputTokenContinuationCount,
        finishReason: result.finishReason,
        rawFinishReason,
        toolCallCount: providerToolCallCount,
      });
  this.logger?.info("Model response diagnostics", {
    ...traceContextToLogContext(modelTraceContext),
    event: "model.response.diagnostics",
    finishReason: result.finishReason,
    module: "core.runtime",
    providerMetadataKeys: objectKeys(result.providerMetadata),
    rawFinishReason,
    responseEmpty: responseLength === 0,
    responseLength,
    status: "completed",
    toolCallCount: toolCalls.length,
    usageCacheReadTokens: usage.cacheReadTokens,
    usageCacheWriteTokens: usage.cacheWriteTokens,
    usageInputTokens: usage.inputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  });
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    toolCalls.length === 0 &&
    isContextExceededFinishReason(result.finishReason, rawFinishReason)
  ) {
    // 超窗 provider 可能返回空内容和 zero usage；必须先识别 overflow，
    // 否则会被 suspicious empty 包成普通 ModelError，后续 reactive compact 无法触发。
    // 处理方式与"请求抛超窗错误"一致:先尝试 reactive compact,成功则重试本轮请求。
    const contextError = createModelContextExceededFinishError({
      finishReason: result.finishReason,
      rawFinishReason,
    });
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        contextError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    throw contextError;
  }
  // 可疑空响应(无文本、无工具、非正常 stop)统一落成明确错误,避免主循环空转。
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    isSuspiciousEmptyModelResult(result.finishReason, responseLength, toolCalls.length, usage)
  ) {
    this.logger?.warn("Model returned an empty non-stop result", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.response.suspicious_empty",
      finishReason: result.finishReason,
      module: "core.runtime",
      rawFinishReason,
      responseLength,
      status: "completed",
      toolCallCount: toolCalls.length,
      usageTotalTokens: usage.totalTokens,
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: result.finishReason,
      model: executionModelSelection,
      providerMetadata: result.providerMetadata,
      rawFinishReason,
    });
  }
  // AI SDK 可能把非标准 output-limit 归一化为 other；Runtime 已确认恢复语义后，
  // live 事件与持久化必须统一使用 length，同时由上方 diagnostics 保留 provider 原始事实。
  if (outputTokenContinuation !== "none") result.finishReason = "length";
  // 把推理内容与最终文本作为 part 持久化到这条 assistant 消息上。
  // 流式期间可能已产生增量 part,这里补齐最终完整内容,保证冷恢复能得到完整响应。
  for (const reasoning of result.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }
  if (state.modelResponse.length > 0) {
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: state.modelResponse,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }

  // 汇总本次请求的展示/统计字段:缓存命中、文件改动摘要(仅无工具调用的收尾轮次才汇总)。
  // 注意 subagent 的文件 checkpoint 也要进 ModelComplete,否则 child 详情无法恢复摘要。
  const cacheHit =
    querySource === "main_turn" ? recordMainTurnCacheHitUsage(this, result.usage) : undefined;
  // subagent 的文件 checkpoint 已经持久化，但旧 gate 只允许 main_turn 把
  // 汇总写入 ModelComplete，导致 child 详情无法从权威事件恢复摘要和撤销入口。
  const supportsTurnFileChanges = querySource === "main_turn" || querySource === "subagent";
  const fileChanges =
    supportsTurnFileChanges && toolCalls.length === 0
      ? buildTurnFileChangeSummary(this.currentTurnFileChanges)
      : undefined;
  // ModelComplete 是 UI/统计消费的权威完成事件:
  // 包含最终文本、stopReason、usage、缓存命中、文件改动、上下文占用明细等。
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: state.modelResponse,
      // 桌面 continuous 实时事件只携带当前 model_complete payload。
      // 如果主轮次只发 usage 不发 contextWindow，旧 task stream 无法生成 usage_update，
      // 长程任务中输入栏会拿不到 context meter 的 size 而隐藏。
      ...(querySource === "main_turn" && executionContextWindow !== undefined
        ? { contextWindow: executionContextWindow }
        : {}),
      querySource,
      stopReason: result.finishReason,
      usage: result.usage,
      ...(cacheHit ? { cacheHit } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(querySource === "main_turn" && result.contextUsageBreakdown
        ? { contextUsageBreakdown: result.contextUsageBreakdown }
        : {}),
      toolCallCount: toolCalls.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  state.events.push(modelCompleteEvent);
  this.lastAssistantCompletedAtMs = Date.now();
  // 记录成功用量事实(与 ModelComplete 事件互补,按 turn/任务维度归组)。
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    model,
    modelTraceContext,
    networkEventStartIndex,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
  });
  // 状态机:记录模型响应;随后再检查一次取消,避免"响应已到但用户已 Stop"时继续执行工具。
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.receiveModelResponse(state.modelResponse),
  );
  throwIfTurnAborted(state.turnAbortSignal);

  this.logger?.info("Model request completed", {
    ...traceContextToLogContext(modelTraceContext),
    durationMs: Date.now() - modelStartedAt,
    event: "model.request.completed",
    module: "core.runtime",
    status: "completed",
    totalTokens: state.tokenCount,
    toolCallCount: toolCalls.length,
  });

  // 只把"本地执行"的工具交给执行器:providerExecuted 的工具由 provider 侧已执行,
  // 这里只做 admit(校验/去重)与 drain(等待流式期间已提前返回的结果)。
  const executableToolCalls = toolCalls
    .filter((toolCall) => !toolCall.providerExecuted)
    .map((toolCall) => streamingToolCoordinator.admit(toolCall));
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation !== "none") {
    // 首次命中 output-limit 时，当前 request 可能带有一次性的 project-memory attachment；
    // query-local 状态必须从实际请求数组推进，不能退回请求前的数组。
    state.turnRequestState.entries = options.requestEntries;
    const assistantCommitted = await persistCompletedAssistantStep(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      includeEmptyAssistant: false,
      modelTraceContext,
      result,
    });
    if (assistantCommitted) recordModelHistoryRound(state);
    if (outputTokenContinuation === "continue") {
      // 还有续写预算:累加续写计数,并重置本 model step 的 reactive compact 尝试标记,
      // 让紧接着的续写请求在超窗时仍可触发补救;返回 "output_continuation" 立即重发。
      appendOutputTokenContinuation(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "output_continuation";
    }

    // 续写预算耗尽:把"输出被截断到上限"统一收口为 ModelError,
    // 持久化错误载体后抛出,由 turn 层转换成用户可见的 TurnError。
    const exhaustedError = createCoreError(
      CoreErrorType.ModelError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
      {
        context: {
          providerCode: "model_output_limit_exceeded",
          reason: "model_output_limit_exceeded",
          source: "provider",
        },
        recoverable: true,
      },
    );
    const exhaustedErrorProjection = projectExecutionErrorPayload(
      exhaustedError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    );
    completeOutputTokenRecovery(state.turnRequestState);
    await persistOutputTokenLimitErrorCarrier(this, state, {
      error: {
        name: exhaustedErrorProjection.code ?? exhaustedError.type,
        data: {
          ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
          message: exhaustedErrorProjection.message,
          // 既有 cold hydration 用 retryable 恢复 UI recoverable；这里复用该字段，
          // 不为单一错误扩展 transcript/hydration schema。
          retryable: exhaustedError.recoverable,
          ...(exhaustedErrorProjection.attribution
            ? { attribution: exhaustedErrorProjection.attribution }
            : {}),
        },
      },
      finishReason: result.finishReason,
      model,
      modelTraceContext,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    // 上游 query loop 会把 max_output_tokens API-error assistant 交给外层；这里复用
    // 既有 ModelError -> TurnError 收口表达同一实时错误，同时只结束当前 Turn command。
    throw exhaustedError;
  }
  completeOutputTokenRecovery(state.turnRequestState);
  // 没有可执行工具:交给 turn-stop 收口——它可能因 guide / Stop hook 继续同一 turn,
  // 也可能返回 "break" 结束本轮(并把稳定 assistant 边界标记给 turn.ts)。
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      result,
    });
  }

  // 有可执行工具:先累计工具调用数,再把"带 tool call 的 assistant"提交到本轮历史,
  // 保证随后的工具结果有对应的 assistant tool-call 可挂靠。
  state.toolCallCount += executableToolCalls.length;
  // 合并修复：工具调用 assistant 必须同时进入 canonical history 与本轮 request history。
  // 只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  // 执行工具批次:内部按权限/并发策略调度、执行并持久化工具结果,
  // 返回 "continue" 让主循环带着工具结果发起下一次模型请求。
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    toolSearch: options.toolSearch,
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}

function buildAutomationCreateLimitFallback(input: string): string {
  if (/\p{Script=Han}/u.test(input)) {
    return "定时任务已达到 20 个上限，本次未创建。请前往“自动化”手动删除一个已有任务后重试。";
  }
  return "The limit of 20 scheduled tasks has been reached, so no task was created. Manually delete an existing task on the Automations page, then try again.";
}

/**
 * 模型请求因上下文超窗失败后的补救入口(只在本 model step 内允许一次)。
 *
 * 返回 true 表示已通过 reactive compact 腾出空间,调用方应 return "continue" 重试本轮请求;
 * 返回 false 表示放弃补救,调用方应把原始超窗错误抛给 turn。
 *
 * 注意这里同时维护 rapid-refill 熔断:如果刚刚压缩过、没经过真实工具轮又立刻超窗,
 * 说明压缩无法解决问题,直接抛 createCompactRapidRefillError,避免"压缩↔超窗"死循环。
 */
// [失败路径] 同一个 model step 只允许一次 reactive compact，第二次超窗直接放弃补救。
// [失败路径] rapid-refill 熔断命中时抛专用错误，避免压缩与超窗互相触发形成死循环。
// [事务] 压缩成功要重置熔断计数并重建 TurnMachine，旧状态机里的消息引用已经失效。
// [并发] 先打标记再执行压缩，即使压缩过程抛错，同一 model step 也不允许再试一次。
// [失败路径] compactOutcome 不是 compacted 时返回 false，调用方保留原始超窗错误作为根因。
async function recoverModelStepAfterContextExceeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  contextError: unknown,
  modelStepIndex: number,
  activeEntries: readonly RuntimeMessageEntry[],
): Promise<boolean> {
  // 同一个 model step 只允许一次 reactive compact:第二次超窗说明压缩也救不回来,
  // 继续重试只会重复消耗 provider 调用。
  if (state.reactiveCompactAttemptedInCurrentModelStep) {
    return false;
  }

  const rapidRefill = evaluateRapidRefill(state.compactTracking);
  if (rapidRefill.shouldBlock) {
    this.logger?.warn("Reactive compact rapid-refill breaker tripped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "compact.rapid_refill_breaker",
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      modelStepIndex,
      module: "core.runtime",
      status: "failed",
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Reactive,
    });
    throw createCompactRapidRefillError({
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
      toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
    });
  }

  // 先打标记再执行:即使这次 reactive compact 抛错,也不允许同一 model step 再试一次。
  state.reactiveCompactAttemptedInCurrentModelStep = true;
  const compactOutcome = await this.reactiveCompactAfterContextExceeded(
    contextError,
    state.turnTraceContext,
    state.events,
    state.turnAbortSignal,
    {
      activeEntries,
      modelStepIndex,
      agentListingTools: getTurnTools(this, state),
      rapidRefillCount: rapidRefill.consecutiveRapidRefills,
      model: state.model,
      turnRequestState: state.turnRequestState,
      getContinuationTools: () => getTurnTools(this, state),
    },
  );
  if (compactOutcome !== "compacted") {
    // skipped / failed:放弃补救,由调用方抛原始超窗错误(不要用压缩错误误导根因)。
    return false;
  }

  // 压缩成功:重置熔断计数与"快速回填"统计;重建 TurnMachine(压缩相当于一次历史替换,
  // 旧状态机里的消息引用已失效),然后让调用方重试本轮请求。
  recordCompactSuccess(state, rapidRefill);
  recordCompactHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(
    TurnMachineImpl.create(
      this.sessionId,
      this.turnNumber,
      state.input,
      state.traceId,
      state.turnId,
    ).start(),
  );
  return true;
}
