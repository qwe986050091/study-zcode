// INV-01 输入先入可取消队列：守住位置 入队调用；改错故障 并发 turn 污染历史。
// INV-02 本轮模型选择在接纳时冻结：守住位置 选择三选一；改错故障 执行中切模影响已开始的轮次。
// INV-03 加速卡回退快照随接纳冻结：守住位置 结构化克隆；改错故障 回退时读到新会话选择。
// INV-04 输出风格本轮冻结：守住位置 配置赋值；改错故障 中途改配置影响当前轮。
// INV-05 特殊命令先解析后分派：守住位置 两个解析函数；改错故障 压缩输入进入普通循环。
// INV-06 turnId 与 queryId 分层：守住位置 预留与新建；改错故障 同一任务链被拆成多次 query。
// INV-07 每轮独立子 trace：守住位置 子 trace 构造；改错故障 事件无法归到具体 turn。
// INV-08 事件缓冲区本轮独占：守住位置 events；改错故障 事件串轮。
// INV-09 预留 turn 开始位置：守住位置 预留调用；改错故障 两个并发输入同时开跑。
// INV-10 取消源合并为单一 signal：守住位置 取消作用域；改错故障 取消条件分散检查。
// INV-11 阶段观测成对：守住位置 开始与结束函数；改错故障 TTFT 缺段。
// INV-12 模型创建失败保留已接纳输入：守住位置 creationFailure；改错故障 重启后文本丢失。
// INV-13 创建期退回按候选逐个尝试：守住位置 候选循环；改错故障 直接暴露隐藏 provider 错误。
// INV-14 创建失败轮不跑 context 与 hooks：守住位置 条件分支；改错故障 一次性 SessionStart 被消费。
// INV-15 活跃 turn 同时只有一个：守住位置 beginActiveTurn；改错故障 两个 turn 同时写历史。
// INV-16 终态事件唯一出口：守住位置 appendTurnOutcomeEvent；改错故障 turn 无终态或双终态。
// INV-17 finally 必须释放全部资源：守住位置 清理块；改错故障 心跳与预留泄漏到下一轮。
// INV-18 摘要与清理失败不覆盖主结果：守住位置 各自捕获；改错故障 成功结果被清理异常覆盖。
//
// 模块职责：Agent 单轮输入的接纳、执行与成功或失败收尾。
// 状态所有权：会话级状态归 runtime；本轮事实在入口处冻结。
// 阅读顺序：先看公共入口，再看执行闭包的创建与分支，最后看收尾与资源释放。
/**
 * ============================================================================
 * turn.ts —— Agent 一次用户输入(一个 turn)的总入口与生命周期
 * ============================================================================
 *
 * 【和主循环的关系】
 *   executeTurn             ← 公共入口:把输入放入可取消的命令队列(提供排队/admission 语义)
 *     └─ executeTurnCommand ← 真正执行一个 turn
 *           ├─ 冻结本轮事实 / 建立 trace、abort scope、turn machine、telemetry
 *           ├─ 创建模型(含加速卡创建期退回;失败也保留已接纳输入)
 *           ├─ 初始化 context prefix、SessionStart hooks
 *           ├─ /compact、/rewind 分支(各自独立命令,不进入普通 loop)
 *           ├─ 普通 turn:beginActiveTurn → TurnStarted → 持久化用户输入/附件
 *           │            → Agent 定义、标题生成、插件引用 reminder
 *           │            → 构造 RegularTurnLoopState → runRegularTurnLoop(主循环)
 *           ├─ 成功收尾:TurnComplete、用量事实、turnNumber++、rebuildProjection、记忆提取
 *           ├─ 失败/取消收尾:appendTurnOutcomeEvent + 用量事实 + 队列状态恢复
 *           └─ finally:释放 prefetch / heartbeat / reservation / active turn / abort scope
 *
 * 【状态原则】
 *   - 会话级状态(Session Selection、messageHistory、turnNumber)归 runtime 所有;
 *   - 本轮事实(选中的模型、输出风格、turnId/trace、取消信号)在入口处冻结,
 *     期间发生的配置切换只影响下一轮,避免异步初始化期间切模污染已开始的 turn。
 *
 * 【错误原则】
 *   错误在 catch 中统一归一化(取消 vs 真实错误),既发 TurnError/TurnComplete 事件,
 *   也记录用量事实,再原样抛出 coreError 给调用方;不在低层吞掉错误。
 * ============================================================================
 */
import { beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import { ensureGroupTaskPermissionScope } from "./input-intent-persistence.js";
import { prepareOffPeakTurn } from "../off-peak/runtime.js";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createChildTraceContext,
  createQueryId,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
  formatLocalIsoDate,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  MessagePart,
  Model,
  ModelSelection,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildDateChangeReminderBody,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  summarizeTurnAttachmentsForEvent,
  runtimeMetadataForSyntheticUserMessageSource,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import {
  maybeStartDeferredSessionTitleGeneration,
  maybeStartSessionTitleGeneration,
} from "./session-title.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import {
  disposeProjectMemoryRecallPrefetch,
  startProjectMemoryRecallPrefetch,
} from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import {
  acceptSubmissionModelSelection,
  captureHighspeedFallbackSelection,
  applySubmissionExecutionState,
  createTurnModel,
  resolveExecutionModelRetryBudget,
} from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  matchExecutionSelectionCreationFallback,
  resolveExecutionFallbackCandidates,
} from "./turn-execution-fallback.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;
const MODEL_CREATION_FAILED_MESSAGE = "Model creation failed";
const MODEL_CREATION_TURN_PHASE = "model_creation";
const TURN_EXECUTION_FAILED_MESSAGE = "Turn execution failed";

/**
 * 公共入口:接纳一条用户输入并异步执行,返回本轮 TurnResult。
 *
 * 这里不直接跑逻辑,而是把输入封装成 PromptRuntimeCommand 交给
 * enqueueCancellableRuntimeCommand:
 *   - 同一 session 的输入按队列串行(避免并发 turn 互相污染历史);
 *   - 支持取消:abortSignal 可以取消"尚未开始"的命令;
 *   - onCommandAccepted 在接纳时立即投影模型选择(与协议 admission 共享语义),
 *     但 Loop 开始后不再回写旧选择。
 *
 * @param input       用户输入(可能是斜杠命令、goal 续跑文本等)
 * @param attachments 本轮附件(图片/文件等),由 executeTurnCommand 解析
 * @param options     执行选项:模型执行状态、trace、visibility、inputId 等
 */
export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  if (options?.modelExecution) {
    // 冻结加速卡的回退快照:后续 session 选择变化不能影响"本轮已接纳"的执行模型。
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  // 进入可取消命令队列:命令真正被执行时由 executeTurnCommand 承接。
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandAccepted: () => {
      // 原始 executeTurn 与协议 admission 共用接纳语义；Loop 开始后不再倒写旧选择。
      void acceptSubmissionModelSelection(
        this,
        options?.intent,
        options?.traceContext ?? this.rootTraceContext,
        options?.modelExecution,
      ).catch((error) => {
        this.logger?.warn("Accepted model selection projection failed", { error: String(error) });
      });
    },
    // createCommand 只负责描述命令;resolve/reject 由队列在真正执行后回调,
    // 这样排队期间的取消/失败也能得到一致的结果语义。
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

/**
 * 真正执行一个 turn:从"输入已接纳"走到"TurnResult 返回"的完整生命周期。
 *
 * 阶段顺序:
 *   1. 冻结本轮事实(模型选择、输出风格、命令解析、turnId/trace);
 *   2. 建立 abort scope / turn machine / telemetry,预留 turn start;
 *   3. 创建模型(失败时也保留已接纳输入,由主链统一落库并收尾);
 *   4. 初始化 context prefix、SessionStart hooks;
 *   5. /compact、/rewind 分支;
 *   6. 普通 turn:活跃 turn → TurnStarted → 持久化输入 → 构造 loop state;
 *   7. runRegularTurnLoop(主循环);
 *   8. 成功/失败收尾 + finally 资源释放。
 *
 * 该方法是 turn.ts 的核心,注释主要集中在"为什么这样做"而非逐行解释字段。
 */
export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 闲时(off-peak)输入可能在接入层带有额外执行参数(临时 provider/票据等):
  // prepareOffPeakTurn 会返回"改写后的 options"与一个 release 句柄,
  // 后续所有逻辑只使用 offPeakTurn.options;turn 结束时 finally 调用 release。
  // 闲时输入可能带临时执行参数。
  // 改写后的选项供后续统一使用。
  // 释放句柄在 finally 归还。
  // 票据结局按取消与失败区分。
  const offPeakTurn = prepareOffPeakTurn(this, options);
  options = offPeakTurn.options;
  // 冻结"本轮到底该用哪个模型选择",优先级:
  //   1) intent.modelSelection      —— 用户在本次提交里显式选择的模型;
  //   2) options.executionSelection —— 协议/宿主(如加速卡)传入的 execution-scoped 选择;
  //   3) this.getSessionModelSelection() —— 会话默认选择(兜底)。
  // 注意这里只冻结"选择"而不是 Model 实例,真正的 Model 在 execute() 里创建。
  // 优先级 1：options.intent.modelSelection（提交自带）优先，压过另外两档。
  // 优先级 2：options.executionSelection，协议或宿主按 execution 粒度指定。
  // 优先级 3：getSessionModelSelection()，前两档都缺失时用会话默认。
  // 这里只把选择冻进 admittedModelSelection，Model 实例留到 execute() 里建。
  const admittedModelSelection =
    options?.intent?.modelSelection ??
    (options && "executionSelection" in options
      ? options.executionSelection
      : this.getSessionModelSelection());
  // 加速卡等 execution-scoped 模型可能"过期":回退时需要使用本轮启动时冻结的
  // 普通会话选择,而不是回退时再读 Session(期间用户可能已经切过模型)。
  // 因此这里在 admission 边界 structuredClone 一份快照,后续 fallback 只认它。
  const highspeedFallbackSelection = options?.modelExecution?.selectionFallback
    ? structuredClone(
        "highspeedFallbackSelection" in options.modelExecution
          ? options.modelExecution.highspeedFallbackSelection
          : this.getSessionModelSelection(),
      )
    : undefined;
  // 输出风格同样在本轮开始时冻结:turn 执行中修改配置只影响下一轮。
  const admittedOutputStyle = this.config.outputStyle;
  // 解析输入里的两个"特殊命令"。
  // /compact:返回值语义三态 ——
  //   undefined  是 /compact 本身(无附加指令);
  //   string     是 "/compact 重点保留 XX" 里的附加指令;
  //   null       不是 /compact。
  // /rewind(/fork):返回 null 表示不是该命令;否则返回 ParsedRewindCommand,
  // action 可能是 fork / status / message / cascade-message / apply,后续按 action 分派。
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  // turnId:调用方若已预留(startReservation,用于并发准入)就复用它,否则新建。
  // queryId:标识"一次用户 query 链"(goal 续跑/后台结果等可复用 inputId),
  //          用于把同一任务链的多次模型请求归到同一 query。
  // displayInput:UI/标题/恢复快照展示用的原始输入;模型可见输入可能是展开后的 input。
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  // 每个 turn 一个子 trace:sessionId/turnId/queryId 都在这个 trace 下,
  // 后续模型请求、工具调用、压缩、持久化都继续传递它。
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  // traceId 直接复用子 trace;turnStartedAtMs 用于耗时统计;
  // targetRunInputID 用于 target(goal)账目:优先 inputId,否则用 turnId 字符串,
  // 保证同一输入在 target 记录里可回溯。
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  // 本 turn 的事件缓冲区:TurnStarted/ModelRequest/ModelComplete/工具事件/TurnComplete
  // 等都 push 进来,供 UI 流式消费、usage 统计与恢复使用。
  // events 是本 turn 唯一的事件容器，所有 push 都走它。
  // TurnComplete 先写库再 push 进 events，保证恢复时能读到终态。
  // usage 统计只从 events 汇总，不另立计数器。
  // UI 流式消费的是同一个 events 序列，所以顺序即渲染顺序。
  const events: SessionEvent[] = [];
  // turn 状态机初始状态:纯状态对象,负责 phase 迁移校验,不做 I/O。
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  // 本轮文件改动汇总(供 Tool/ModelComplete 事件与 UI 展示),每个 turn 独占。
  this.currentTurnFileChanges = new Map();
  // 预先"预留 turn 开始"位置,防止两个并发输入都认为自己能开始;
  // 调用方已持有时(startReservation)跳过,避免重复预留。
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  // 统一取消源:把外部 abortSignal 与本轮内部的取消(Stop)合并成一个 signal,
  // 后续所有阶段只检查 turnAbortSignal;dispose 时释放监听,避免内存泄漏。
  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  // 下面这些是"跨阶段共享的可变状态",必须在 stage 开始前声明:
  //   activeTurn          活跃 turn 标记(steering/取消/队列语义都挂在它上面);
  //   startedTarget       本轮关联的 goal(target accounting 用),失败/取消时用于结算;
  //   targetRunHeartbeat  目标运行的定时心跳(长任务防止被判失联);
  //   userMessageId       本轮 user 消息 id(TurnStarted/checkpoint/恢复都要用);
  //   loopState           主循环状态,成功收尾和失败诊断都要读它;
  //   shouldRetryTitle    首轮标题生成是否因 provider 刷新而推迟到 turn 之后。
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  // turnPhase 记录"当前执行到哪个阶段",用于线上排查"已工作 N 秒但无终态"的卡点;
  // turnFailureHandled 标记错误是否已经被内层 catch 处理(未处理=生命周期逃逸,需要告警);
  // finishPreparation 是当前阶段的 TTFT 观测句柄,completeTurnPhase 时关闭;
  // preparationStages 把阶段名映射到 TTFT 归类(context/hooks/persistence),
  // 不在表里的阶段(attempt/retry_wait/user_confirmation)不参与 TTFT 统计。
  let turnPhase = "queued";
  let turnFailureHandled = false;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  // 进入一个阶段:关闭上一个阶段的 TTFT 观测(如果有)、记录阶段名与开始时间,
  // 返回的 startedAt 供 completeTurnPhase 计算耗时。
  // startTurnPhase 先调用 finishPreparation，把上一段观测收尾。
  // 只有准备类阶段计入 TTFT。
  // phase 原样写进结构化日志的 stage 字段，便于按阶段过滤。
  // 返回起始时间供耗时计算。
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  // 结束一个阶段:关闭 TTFT 句柄并记录耗时。
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };
  // turn 级 telemetry span:无论成功/失败/取消都会在下方 then/finally 中正确收口。
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  // execute 是"真正执行"的闭包:用 AsyncLocalStorage 绑定 trace,
  // 让内部所有异步调用(事件、日志、模型请求、工具执行)自动继承同一 traceId。
  // 绑定 trace 后整体执行。
  // 内部异步调用继承同一 trace。
  // 成功与失败都在此收口。
  // runWithContextAsync(turnTraceContext) 包住整个 execute，让 trace 上下文覆盖全部 await。
  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      // 绝对开始时间(performance.timeOrigin+now),写入 TurnStarted.executionStartedAt,
      // 供客户端计算"从真正开跑算起"的耗时。
      const executionStartedAt = performance.timeOrigin + performance.now();
      // 立即关闭"execution"这一层 TTFT 标记(它只覆盖进入 execute 之前的排队/切换开销)。
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      // admittedModel:真正创建出来、本轮可调用的 Model。
      // effectiveExecutionSelection/effectiveRequestDependencies 跟随创建期退回更新,
      // creationFallback 记录"从哪个选择退到哪个选择",用于发 TurnExecutionModelFallback 事件。
      // admittedModel 可能被 creationFallback 替换，下面两个 effective* 变量要跟着改。
      // effectiveExecutionSelection 记最终生效的执行选择，不一定等于 admittedModelSelection。
      // creationFallback 记「从哪个选择退到哪个」，只用于发 TurnExecutionModelFallback 事件。
      // 创建仍然失败时不在这里吞掉，原样抛给主链的 catch。
      let admittedModel: Model | undefined;
      let effectiveExecutionSelection = admittedModelSelection;
      let effectiveRequestDependencies = options?.modelExecution?.requestDependencies;
      let creationFallback:
        | {
            reason: "highspeed_selection_unavailable";
            fromModelSelection: ModelSelection;
            toModelSelection: ModelSelection;
          }
        | undefined;
      // 普通轮创建模型失败后仍要保留已接纳输入；这里只记下原始错误，由主生命周期落库并收尾。
      let creationFailure: { error: unknown } | undefined;
      // 创建期退回声明命中但所有候选都无法创建：TurnError 归因要带上该事实，Renderer 才能作废匹配卡。
      let creationFallbackUnavailable = false;
      try {
        // 创建本轮使用的模型。/rewind 不请求模型,因此跳过创建;
        // 普通 turn 用"冻结后的 modelSelection"创建,带退回声明时把重试预算设为 0,
        // 让失败立刻进入"退回会话模型"分支,而不是先在坏的执行模型上重试。
        admittedModel =
          rewindCommand === null
            ? createTurnModel(this, {
                requestDependencies: options?.modelExecution?.requestDependencies,
                selection: admittedModelSelection,
                // 带退回声明的执行句柄 0 次重试：失败立刻交给 turn step 退回会话模型。
                retryBudget: resolveExecutionModelRetryBudget({
                  selection: admittedModelSelection,
                  selectionFallback: options?.modelExecution?.selectionFallback,
                }),
              })
            : undefined;
      } catch (error) {
        let reportedCreationError = error;
        // 只有 matchExecutionSelectionCreationFallback 命中，才尝试 selectionFallback 候选。
        // 候选顺序：先声明的 selectionFallback，再会话级兜底。
        // 候选全失败时 creationFallback 保持 undefined，表示无处可退。
        const creationFallbackMatch = matchExecutionSelectionCreationFallback({
          error,
          selection: admittedModelSelection,
          selectionFallback: options?.modelExecution?.selectionFallback,
          selectionScope: options?.modelExecution?.selectionScope,
        });
        // 创建期退回的候选顺序由 resolveExecutionFallbackCandidates 决定:
        //   声明的 target(抽卡时记住的原模型)优先 → 会话常驻选择兜底;
        // 每个候选都尝试 createTurnModel,失败就记录并继续下一个;
        // 全部失败则 creationFallbackUnavailable=true,最终 TurnError 才能把"已降级但无处可退"归因出去。
        const selectionFallback = options?.modelExecution?.selectionFallback;
        if (creationFallbackMatch && admittedModelSelection && selectionFallback) {
          const skippedCandidates: Array<{
            source: string;
            providerId: string;
            modelId: string;
            error: string;
          }> = [];
          const candidates = resolveExecutionFallbackCandidates({
            declaredTarget: selectionFallback.target,
            executionProviderId: admittedModelSelection.providerId,
            sessionSelection: highspeedFallbackSelection,
          });
          for (const candidate of candidates) {
            try {
              admittedModel = createTurnModel(this, { selection: candidate.selection });
              effectiveExecutionSelection = candidate.selection;
              effectiveRequestDependencies = undefined;
              creationFallback = {
                reason: creationFallbackMatch.reason,
                fromModelSelection: admittedModelSelection,
                toModelSelection: candidate.selection,
              };
              this.logger?.warn(
                "Execution model selection was unavailable; falling back before the request",
                {
                  ...traceContextToLogContext(turnTraceContext),
                  event: "model.execution_selection.creation_fallback",
                  module: "core.runtime",
                  status: "completed",
                  reason: creationFallbackMatch.reason,
                  fromProviderId: admittedModelSelection.providerId,
                  fromModelId: admittedModelSelection.modelId,
                  toProviderId: candidate.selection.providerId,
                  toModelId: candidate.selection.modelId,
                  toSource: candidate.source,
                  ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
                  errorMessage: error instanceof Error ? error.message : String(error),
                },
              );
              break;
            } catch (fallbackError) {
              // Highspeed 已确认不可用后，若普通模型也无法创建，用户应看到可操作的普通模型错误，
              // 不能继续暴露隐藏执行 Provider 的 Registry 错误。
              reportedCreationError = fallbackError;
              skippedCandidates.push({
                source: candidate.source,
                providerId: candidate.selection.providerId,
                modelId: candidate.selection.modelId,
                error:
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
              });
            }
          }
          if (!creationFallback) {
            creationFallbackUnavailable = true;
            this.logger?.warn(
              "Execution model selection was unavailable and no fallback model could be created",
              {
                ...traceContextToLogContext(turnTraceContext),
                event: "model.execution_selection.creation_fallback_unavailable",
                module: "core.runtime",
                status: "failed",
                reason: creationFallbackMatch.reason,
                fromProviderId: admittedModelSelection.providerId,
                fromModelId: admittedModelSelection.modelId,
                skippedCandidates,
                errorMessage: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
        // Bug 根因：Provider/Model 在 Registry 中短暂缺失时，旧逻辑在请求前直接结束 Turn，
        // 请求期 selectionFallback 永远没有机会运行。成功创建声明目标后继续既有 Turn 主链。
        // 模型创建失败后的分流:
        //   普通 turn(compactInstructions===null)→ 记下 creationFailure,由主链落库已接纳输入后再抛错
        //     (否则只剩历史截断,重启无法恢复文本);
        //   /compact → 直接写终态并抛出,因为 /compact 不产生用户消息。
        // 维护不变量#5:创建失败轮没有 model step,必须明确终态,不能留下半开的 active turn。
        if (!admittedModel) {
          if (compactInstructions === null) {
            // Bug 根因：edit/retry 的 branch cut 已提交后，Registry 仍可能在 Core 创建模型前变化；
            // 已接纳输入必须提升为 TurnStarted + 持久消息，否则只剩历史截断，重启也无法恢复文本。
            // CR-01：上一版复制了一份落库流程并在主 try 外执行，附件、取消或存储失败会直接穿出，
            // TurnStarted 之后没有终态，原始创建错误也被覆盖。这里只记下错误，落库与终态交给主链。
            creationFailure = { error: reportedCreationError };
          } else {
            // /compact 不产生用户消息，创建失败直接写终态。
            turnFailureHandled = true;
            const coreError = createTurnFailureError(
              reportedCreationError,
              turnAbortSignal,
              MODEL_CREATION_FAILED_MESSAGE,
            );
            // appendTurnOutcomeEvent 统一发 TurnError 并记录用量;durable 事件先落库再入数组。
            // 失败处理:事件落库失败会抛出,但 coreError 已构造,调用方能拿到原始错误。
            await appendTurnOutcomeEvent(this, {
              coreError,
              events,
              durationMs: Date.now() - turnStartedAtMs,
              turnPhase: MODEL_CREATION_TURN_PHASE,
              inputId: options?.inputId,
              // 卡身份仍以接纳时冻结的 intent 为准，不能依赖分页窗口中的 userInput 反查。
              highspeedCardId: options?.intent?.highspeed?.cardId,
              highspeedFallbackUnavailable: creationFallbackUnavailable,
              traceContext: turnTraceContext,
              fallbackMessage: MODEL_CREATION_FAILED_MESSAGE,
              logEvent: "turn.failed",
              logLabel: "Turn",
            });
            throw coreError;
          }
        }
      }
      let phaseStartedAt: number;
      // Bug 根因：创建错误确定后仍执行 Context/SessionStart，会在 TurnStarted 前被二次 I/O 错误覆盖，
      // 并提前消费一次性 SessionStart。失败轮跳过它们，只复用后续输入持久化与终态主链。
      if (!creationFailure) {
        phaseStartedAt = startTurnPhase("context_initialization");
        if (this.contextInitialized) {
          // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
          // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
          rebuildContextPrefix(this, { model: admittedModel });
        } else {
          // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
          // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
          await this.ensureContextInitialized(turnTraceContext, admittedModel);
        }
        completeTurnPhase("context_initialization", phaseStartedAt);
        throwIfTurnAborted(turnAbortSignal);
        phaseStartedAt = startTurnPhase("session_start_hooks");
        // SessionStart hook:只在真正开跑前执行一次,它的 additionalContexts
        // 会被注入到历史(对模型可见),常用于注入项目约定/环境说明。
        const sessionStartHookResult = await this.runSessionStartHooks(
          "startup",
          turnTraceContext,
          turnAbortSignal,
          admittedModel,
        );
        completeTurnPhase("session_start_hooks", phaseStartedAt);
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.SessionStart,
          sessionStartHookResult.additionalContexts,
        );
      }

      // /compact 分支:
      //   applySubmissionExecutionState 会把本轮的模型选择/mode/plan 正式应用到 runtime,
      //   并返回"最终用于压缩的 Model"(可能是 prepared 的 admittedModel,也可能是按 intent 新建的);
      //   executeManualCompact 随后把压缩当作一条独立 turn 执行(有自己的 TurnStarted/TurnComplete)。
      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      // /rewind 分支:executeRewindCommand 内部按 rewindCommand.action 分派
      // (fork / status / message / cascade-message / apply),不请求模型,也不进入主循环。
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      // 注册活跃 turn(kind=regular)。
      // steerable = creationFailure === undefined:只有"本轮真的会进入模型执行"时才接受 guide;
      // 创建失败轮没有 model step,guide 无法被消费,因此标为不可 steer,调用方改走队列。
      // 维护不变量#5:一个 runtime 同时只有一个 active turn;beginActiveTurn 内部做并发准入。
      // 注册后同一 runtime 只此一个。
      // 创建失败轮标记不可引导。
      // 结束后释放标记。
      activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        creationFailure === undefined,
        {
          ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
        },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      // 先把 session 行落库(幂等)再写任何消息/事件;首个输入必须保证 session 已存在。
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      // 群任务(group task)可能在另一个 session 里已获批;这里确保当前 session
      // 继承同一权限范围,否则后续工具审批会重复询问用户。
      await ensureGroupTaskPermissionScope(this.sessionStore, this.sessionId, options?.intent);
      // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      // 创建失败轮不再应用：重复建模会在主 try 之外再次抛错；也不改写选择、mode、plan，
      // 不占用目标轮次。
      const submissionModel = creationFailure
        ? undefined
        : await applySubmissionExecutionState(
            this,
            options?.intent,
            turnTraceContext,
            options?.modelExecution,
            admittedModel,
          );
      // readSessionTargetForContext:读取当前 goal(target)并为它开启一次 "run" 账目;
      // 非 active 的 target 不参与本轮(置 null),避免把已暂停/已完成的目标算进来。
      startedTarget = creationFailure
        ? null
        : await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      // userMessageId:
      //   skipInputRecord=true(如 goal 续跑/后台唤醒)表示输入已经由别处记录,
      //   优先复用 recordedInputMessageId,没有才新建;
      //   普通输入则总为新消息生成 id,后续 checkpoint/附件/恢复都挂在这个 id 上。
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
      // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
      // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId
            ? { automationId: options.automationId }
            : options?.offPeakTaskId
              ? {
                  offPeakTaskId: options.offPeakTaskId,
                  ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
                }
              : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      // TurnStarted 是 durable 事件:必须先落库再 push 到 events 数组,
      // 保证 UI 流式消费与持久化顺序一致。失败处理:appendEvent 失败会抛出,
      // 但 turnMachine 已 start,需要由 catch 统一收口(不会留下无终态 turn)。
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          const response =
            userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
          if (activeTurn) activeTurn.steerable = false;
          turnMachine = new TurnMachineImpl(turnMachine.complete(response, "success"));
          const turnUsage = createModelUsageSummaryFromEvents(events);
          const completeEvent = this.createEvent(
            SessionEventType.TurnComplete,
            {
              response,
              tokenCount: 0,
              usage: turnUsage,
              toolCallCount: 0,
              duration: Date.now() - turnMachine.state.startedAt.getTime(),
              resultType: "success",
              cacheStats: this.messageHistory.getCacheStats(),
              inputId: options?.inputId,
            },
            turnTraceContext,
          );
          await this.appendEvent(completeEvent, turnTraceContext);
          events.push(completeEvent);
          await recordTurnUsageFact(this, {
            completedAt: Date.now(),
            events,
            startedAt: turnStartedAtMs,
            status: "completed",
            traceContext: turnTraceContext,
            turnId,
          });
          this.turnNumber++;
          const projection = await this.rebuildProjection();
          await this.accountTargetTurnCompletion({
            inputID: targetRunInputID,
            startedAtMs: turnStartedAtMs,
            startedTarget,
            traceContext: turnTraceContext,
            usage: turnUsage,
          });
          return {
            response,
            turnId,
            traceId,
            usage: turnUsage,
            events,
            projection,
          };
        }
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        injectReferencedSessionContextReminderIntoMessageHistory.call(this, input, options);
        // 话题原文由标准文本附件按需读取，可信来源归档不能再次生成隐藏上下文。
        injectDateChangeReminderIntoMessageHistory.call(this);
        const resolvedAttachments = await resolveTurnAttachments(attachments, {
          abortSignal: turnAbortSignal,
          artifactStore: this.artifactStore,
          fileSystemPort: this.fileSystemPort,
          imageProcessorPort: this.imageProcessorPort,
          sessionId: this.sessionId,
          traceContext: turnTraceContext,
          turnId,
          workingDirectory: this.workingDirectory,
        });
        logResolvedTurnAttachments(this.logger, turnTraceContext, resolvedAttachments);
        const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
        if (sharedContextRefs && sharedContextRefs.length > 0) {
          const [reference] = sharedContextRefs;
          if (!reference || reference.kind !== "shared_context_import") {
            throw new Error("invalid shared context reference");
          }
          if (!this.sessionStore) throw new Error("shared context import storage is unavailable");
          const alreadyHydrated = this.messageHistory
            .borrowReadOnlyRuntimeEntries()
            .some(
              (entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context",
            );
          if (!alreadyHydrated) {
            const importedMessages = await this.sessionStore.messages({
              sessionID: this.sessionId,
            });
            const contextMessage = importedMessages.find(
              (message) =>
                message.info.role === "user" &&
                message.info.source === "shared_context" &&
                message.info.metadata &&
                typeof message.info.metadata === "object" &&
                (message.info.metadata as Record<string, unknown>).contextId ===
                  reference.context_id,
            );
            const contextText = contextMessage?.parts
              .filter(
                (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text",
              )
              .map((part) => part.text)
              .join("\n")
              .trim();
            if (!contextText) throw new Error("shared context content is unavailable");
            this.messageHistory.addUser(
              contextText,
              runtimeMetadataForSyntheticUserMessageSource("shared_context"),
            );
          }
        }
        await this.persistPendingModelChangeTimeline(turnTraceContext);
        if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
          const inputSource = options.inputSource ?? "goal-continuation";
          const userContent = buildUserContentFromTurn(input, resolvedAttachments);
          this.messageHistory.addUser(
            userContent,
            runtimeInputMetadata(options.inputPresentation) ??
              runtimeMetadataForSyntheticUserMessageSource(inputSource),
          );
          // /goal 自动续跑是 runtime 注入给模型的内部 user-role 输入，
          // 不是用户在聊天里新发的一条消息。持久化时保留 raw 输入供恢复/排查使用，
          // 但用 model-only 语义阻止 UI-facing snapshot 把它渲染成用户气泡。
          await this.persistSyntheticUserNoticeForSession({
            messageID: userMessageId,
            metadata: {
              ...(options.targetId ? { targetId: options.targetId } : {}),
              ...(options.inputPresentation
                ? { inputPresentation: options.inputPresentation }
                : {}),
              visibility: "model-only",
            },
            sessionId: this.sessionId,
            source: inputSource,
            text: input,
            traceContext: turnTraceContext,
            visibility: "model-only",
          });
        } else if (options?.skipInputRecord !== true) {
          this.messageHistory.addEntries(
            buildRuntimeUserEntriesFromTurn(
              withConversationQuotes(
                input,
                options?.intent?.conversationQuotes,
                options?.intent?.botGroupSource,
              ),
              resolvedAttachments,
              {
                browserAmbientContext: options?.browserAmbientContext,
              },
            ).map((entry) => {
              const metadata = runtimeInputMetadata(options?.inputPresentation);
              return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
            }),
          );
          // /init 和自定义 slash command 会把模型输入展开成较长的内部
          // prompt。模型可见的历史必须使用展开后的 input，但 UI 展示、会话标题和
          // 恢复快照只能展示用户真实提交的原始 query。
          await this.persistUserPrompt(
            userMessageId,
            displayInput,
            resolvedAttachments,
            turnTraceContext,
            {
              intent: options?.intent,
              inputPresentation: options?.inputPresentation,
              sessionInputId: options?.intent?.queueItemId,
              sourceCommandId: options?.inputId,
              ...(options?.epilogueStart === undefined
                ? {}
                : { epilogueStart: options.epilogueStart }),
            },
          );
        }
        if (creationFailure) {
          // 已接纳输入已随 TurnStarted 和用户消息落库；不准备 Agent、不生成标题、不请求模型，
          // 终态由下方 catch 统一写入。
          throw creationFailure.error;
        }
        if (creationFallback) {
          // TurnStarted 与用户消息已先落库，continuous/replayable 投影都能把退回事实关联到同一输入行。
          const fallbackEvent = this.createEvent(
            SessionEventType.TurnExecutionModelFallback,
            {
              ...(options?.inputId ? { inputId: options.inputId } : {}),
              reason: creationFallback.reason,
              fromModelSelection: creationFallback.fromModelSelection,
              toModelSelection: creationFallback.toModelSelection,
            },
            turnTraceContext,
          );
          await this.appendEvent(fallbackEvent, turnTraceContext);
          events.push(fallbackEvent);
        }
        // 配置读取曾早于输入展示/持久化，失败会让已发送消息从界面消失。
        // 在原有输入记录后固定本轮定义，错误/取消复用本层收尾，且不启动标题或模型请求。
        await this.prepareAgentDefinitions({
          signal: turnAbortSignal,
          traceContext: turnTraceContext,
        });
        throwIfTurnAborted(turnAbortSignal);
        if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
          // 修复原因：标题生成以前等主 turn 成功后才启动，用户 stop/cancel 首轮请求时
          // generated title 永远没有机会发起。首条 query 持久化后即可异步生成，避免被主链路取消拖死。
          const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            {
              deferIfProviderRuntimeHeadersRefresh: true,
              offPeakExecutionId: options?.offPeakExecutionId,
            },
          );
          shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
        }
        // Plugin reminder 必须在对应 user 消息写入历史和 session store 后再追加：
        // provider 形态因此稳定为 user → system，cold hydration 也按同一因果顺序恢复。
        // 根因：input 可能已经被自定义命令展开，解析它会让命令模板里的 plugin://
        // 凭空获得“用户引用”语义；这里只解析真实持久化的 canonical displayInput。
        // runtime 内部的 model-only continuation 不代表新的用户意图，不重复解析。
        if (options?.inputVisibility !== "model-only") {
          await this.injectPluginReferenceReminderFromTurn(
            displayInput,
            turnTraceContext,
            options?.toolDisallowlist,
          );
        }

        this.messageHistory.setCacheMiss();
        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        startProjectMemoryRecallPrefetch(
          this,
          {
            model: loopModel,
            traceContext: turnTraceContext,
            turnAbortSignal,
          },
          ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
        );
        // 构造本轮 turn-local 执行状态:主循环只读写这个对象。
        // 注意里面对历史取的是"只读快照",entry 本身不可变;后续由显式 commit 推进,
        // 避免主循环与 canonical messageHistory 出现两条写入路径。
        // 主循环只读写 loopState，不碰外层的 canonical messageHistory。
        // loopState 里的历史是只读快照，entry 本身不可变。
        // 推进靠显式 commit，避免两条写入路径互相覆盖。
        loopState = {
          activeTurn,
          ...(options?.automationId ? { automationId: options.automationId } : {}),
          // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
          ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
          ...(options?.offPeakExecutionId
            ? { offPeakExecutionId: options.offPeakExecutionId }
            : {}),
          anomalyWarningsInjected: 0,
          backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
          workflowResultConsumed: options?.workflowResultConsumed === true,
          completedRealToolResultBatch: false,
          currentUserMessageId: userMessageId,
          events,
          input,
          ...(options?.inputId ? { inputId: options.inputId } : {}),
          modelResponse: "",
          model: loopModel,
          ...(options?.modelExecution?.selectionScope === "execution"
            ? { modelSelectionScope: "execution" as const }
            : {}),
          // 加速卡回退仅使用启动时快照，不随随后接纳的用户选择变化。
          ...(!creationFallback && options?.modelExecution?.selectionFallback
            ? {
                selectionFallback: options.modelExecution.selectionFallback,
                highspeedFallbackSelection,
              }
            : {}),
          ...(options?.modelExecution?.subagents && effectiveExecutionSelection
            ? {
                subagentModelOverride: {
                  selection: effectiveExecutionSelection,
                  requestDependencies: effectiveRequestDependencies,
                  background: options.modelExecution.subagents.background,
                },
              }
            : {}),
          modelStepCount: 0,
          historyRoundCount: 0,
          reactiveCompactAttemptedInCurrentModelStep: false,
          repeatedToolCallSignature: undefined,
          repeatedToolCallStreakCount: 0,
          stopHookContinuationCount: 0,
          streamRecoveryRetryCount: 0,
          tokenCount: 0,
          toolCallCount: 0,
          turnRequestState: {
            // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
            // 遵循 MessageHistory 的不可变约定。
            // 维护不变量:turnRequestState.entries 是 turn-local 历史的唯一写入入口,
            // 主循环不直接改 messageHistory,避免两条写入路径导致状态分叉。
            entries: [...this.messageHistory.borrowReadOnlyRuntimeEntries()],
            outputTokenContinuationCount: 0,
          },
          toolDisallowlist: options?.toolDisallowlist,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnOutputStyle: admittedOutputStyle,
          turnTraceContext,
          userMessageId,
        };

        // 主循环:持续"准备请求 → 调模型 → 执行工具"直到模型自然结束(stop hooks 之后)。
        // 循环内部的 compact、工具执行、恢复细节分别见 turn-loop.ts / turn-model-step.ts。
        // goal 状态变更提醒的"延迟窗口":本轮进行中先不打断模型,
        // 等循环/收尾结束后再由 closeGoalStateChangeReminderDeferral 统一flush。
        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          // 无论循环如何结束,都清理输出续写态并关闭 goal 变更提醒的延迟窗口,
          // 防止这些一次性状态泄漏到下一次用户输入。
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        // 主循环正常返回 = 模型侧已经收口(stop hooks 之后)。
        // 先结算 goal/target 并固定 stable fork boundary,再发 TurnComplete,
        // 保证 projection/UI 看到成功终态时,后续 fork 所需的数据已经持久化。
        const turnUsage = createModelUsageSummaryFromEvents(events);
        // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
        // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
        await this.accountTargetTurnCompletion({
          inputID: targetRunInputID,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          traceContext: turnTraceContext,
          usage: turnUsage,
        });
        // 若本轮形成了"稳定的 product 起点 + 最终 assistant 边界",写入 fork 边界:
        // 后续编辑重试/分叉会从这里切分历史,而不是从任意 assistant 消息切。
        if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
          await persistStableForkCompletionBoundary(this, {
            boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
            startMessageId: loopState.stableProductStartMessageId,
            historyRoundCount: loopState.historyRoundCount,
            traceContext: turnTraceContext,
          });
        }
        // 浏览器 turn 若产生最终 assistant,补一张截图 attachment(失败不影响主流程)。
        if (loopState.stableBoundaryAssistantMessageId) {
          await appendBrowserTurnScreenshot(
            this,
            loopState,
            loopState.stableBoundaryAssistantMessageId,
          );
        }
        const completeEvent = this.createEvent(
          SessionEventType.TurnComplete,
          {
            // response/tokenCount/usage/toolCallCount 来自 loopState 的累计值;
            // duration 从 turn machine 的 startedAt 算起(包含排队前的准备时间);
            // historyRoundCount 是"真正写入 provider 可见持久历史的轮次数";
            // cacheStats 是本轮结束时的 messageHistory 缓存状态(UI 展示用)。
            response: loopState.modelResponse,
            tokenCount: loopState.tokenCount,
            usage: turnUsage,
            toolCallCount: loopState.toolCallCount,
            historyRoundCount: loopState.historyRoundCount,
            duration: Date.now() - turnMachine.state.startedAt.getTime(),
            resultType: "success",
            ...(loopState.backgroundSubagentResultConsumed
              ? { backgroundSubagentResultConsumed: true }
              : {}),
            ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
            cacheStats: this.messageHistory.getCacheStats(),
            inputId: options?.inputId,
          },
          turnTraceContext,
        );
        await this.appendEvent(completeEvent, turnTraceContext);
        events.push(completeEvent);
        // turn 级用量事实:与 ModelComplete 的请求级事实互补,按 turn 汇总。
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          events,
          startedAt: turnStartedAtMs,
          status: "completed",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        if (shouldRetryTitleGenerationAfterTurn && userMessageId) {
          // 需要请求前刷新 provider runtime headers 的模型
          // 若在主 turn 前生成标题，会先占用鉴权刷新窗口，导致真正的用户消息失败。
          maybeStartDeferredSessionTitleGeneration.call(
            this,
            displayInput,
            userMessageId,
            turnTraceContext,
            options?.offPeakExecutionId,
          );
        }
        this.turnNumber++;

        const projection = await this.rebuildProjection();
        this.logger?.info("Turn completed", {
          ...traceContextToLogContext(turnTraceContext),
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          event: "turn.completed",
          module: "core.runtime",
          status: "completed",
          toolCallCount: loopState.toolCallCount,
        });
        // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
        if (options?.modelExecution?.memoryExtraction !== "skip") {
          scheduleProjectMemoryExtraction(this, {
            model: loopState.model,
            traceContext: turnTraceContext,
          });
        }

        const result: TurnResult = {
          response: loopState.modelResponse,
          turnId,
          traceId,
          usage: turnUsage,
          events,
          projection,
        };
        return result;
      } catch (error) {
        turnFailureHandled = true;
        // 统一失败收尾(成功分支之外的唯一出口):
        //   1) 归一化错误(取消 / 宿主 fault / provider 超窗 / 其他);
        //   2) 结算目标与轮次账目,恢复队列/guide 的暂停语义;
        //   3) 发 TurnError 或 TurnComplete(cancelled),并记录 usage 事实;
        //   4) 抛出 coreError,交给调用方决定后续(不在这里吞掉)。
        // 创建失败轮也走这里:已接纳输入仍要落库,原始创建错误不能被落库失败覆盖。
        // CR-01：创建失败轮进入主链只为保留已接纳输入。落库中的普通失败不能覆盖模型创建错误，
        // 只记 warn。用户取消仍收口为 cancelled；宿主 fault 只经 abort signal 传入，
        // createTurnFailureError 会先于创建错误识别它。
        const reportedCreationFailure =
          creationFailure && !isTurnCancellationError(error, turnAbortSignal)
            ? creationFailure
            : undefined;
        if (reportedCreationFailure && error !== reportedCreationFailure.error) {
          this.logger?.warn("Accepted input persistence failed after model creation failed", {
            ...traceContextToLogContext(turnTraceContext),
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.model_creation.input_persistence_failed",
            module: "core.runtime",
            status: "failed",
          });
        }
        const fallbackMessage = reportedCreationFailure
          ? MODEL_CREATION_FAILED_MESSAGE
          : TURN_EXECUTION_FAILED_MESSAGE;
        const coreError = createTurnFailureError(
          reportedCreationFailure ? reportedCreationFailure.error : error,
          turnAbortSignal,
          fallbackMessage,
        );
        // preserveQueueAutoDrainOnCancel:前台执行被取消时,若宿主要求保留自动消费,
        // 则不翻转 queueAutoDrain(避免 held 期间新起 turn 错误地 drain 队列项)。
        const preserveQueueAutoDrainOnCancel =
          coreError.type === CoreErrorType.TurnCancelled &&
          this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
        // 目标账目结算:取消 → paused,真实错误 → undefined(不暂停);
        // 失败处理:结算失败不覆盖 coreError,由后续 appendTurnOutcomeEvent 兜底。
        const finishedTarget = await this.finishTargetTurnAccounting({
          endedAtMs: Date.now(),
          inputID: targetRunInputID,
          startedTarget,
          status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
          traceContext: turnTraceContext,
        });
        if (finishedTarget?.targetID === startedTarget?.targetID) {
          startedTarget = finishedTarget;
        }
        if (coreError.type === CoreErrorType.TurnCancelled) {
          // 取消路径:暂停 active target + 把未消费 guide 退回队列(它们不能留在已取消的 turn)。
          await this.pauseActiveTargetForCancellation(turnTraceContext);
          if (activeTurn) {
            await this.fallbackPendingGuidesToQueue({
              activeTurn,
              events,
              reasonCode: "guide.turnInterrupted",
              traceContext: turnTraceContext,
            });
          }
        }
        // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
        // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
        // 保留排队输入，等待用户显式继续。
        if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
          const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
          if (pendingInputs.length > 0) {
            this.queueAutoDrain = false;
            this.queueExternalDrainActive = false;
          }
        } else if (
          activeTurn &&
          coreError.type === CoreErrorType.TurnCancelled &&
          !preserveQueueAutoDrainOnCancel &&
          activeTurn.pendingInputs.length > 0
        ) {
          // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
          // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
          // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
          this.queueAutoDrain = false;
          this.queueExternalDrainActive = false;
        }

        // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
        const backgroundSubagentResultConsumed =
          options?.backgroundSubagentResultConsumed === true ||
          loopState?.backgroundSubagentResultConsumed === true;
        const workflowResultConsumed =
          options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
        // 结局事件:
        //   turnPhase 用于错误归因(创建失败轮标 model_creation,否则取状态机当前 phase);
        //   highspeedFallbackUnavailable 把"已降级且无处可退"的事实带给 Renderer;
        //   background/workflow 结果消费标记保证恢复链路知道哪些通知已被本 turn 消费。
        // 维护不变量#5:appendTurnOutcomeEvent 是错误归一化的统一出口——无论创建失败、
        // 执行失败还是取消,都走同一条 durable 终态写入,保证 turn 有且仅有一个终态事件。
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
          turnPhase: reportedCreationFailure ? MODEL_CREATION_TURN_PHASE : turnMachine.state.phase,
          inputId: options?.inputId,
          highspeedCardId: options?.intent?.highspeed?.cardId,
          highspeedFallbackUnavailable:
            creationFallbackUnavailable || loopState?.highspeedFallbackUnavailable === true,
          traceContext: turnTraceContext,
          fallbackMessage,
          logEvent: "turn.failed",
          logLabel: "Turn",
          preserveQueueAutoDrainOnCancel,
          backgroundSubagentResultConsumed,
          workflowResultConsumed,
          historyRoundCount: loopState?.historyRoundCount,
        });
        // 失败/取消也要记 turn 级用量事实(status 区分 cancelled/error),
        // 成功侧的同名字段用于统计每个 turn 的 token 消耗。
        await recordTurnUsageFact(this, {
          completedAt: Date.now(),
          error: coreError,
          events,
          startedAt: turnStartedAtMs,
          status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
          traceContext: turnTraceContext,
          turnId,
          userMessageId,
        });
        throw coreError;
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  // turn telemetry 包裹整个 execute,并注册"无论如何都要执行"的资源清理:
  // prefetch、心跳、turn start 预留、浏览器 turn 状态、active turn、abort scope、
  // 闲时任务票据。清理失败只记日志,不能覆盖已经完成的成功/失败结果。
  return turnTelemetry.run(execute).finally(async () => {
    // 取消/丢弃尚未settle的项目记忆预取,避免它在下一轮才落库。
    disposeProjectMemoryRecallPrefetch(this);
    if (targetRunHeartbeat) {
      // 目标心跳只服务于本轮 target run,必须停掉.
      clearInterval(targetRunHeartbeat);
    }
    // 释放 turn start 预留(并发准入用),否则后续输入会一直排队。
    this.releaseTurnStart(turnId);
    // 清理浏览器 turn 的进程内状态(页面句柄/截图缓存等)。
    clearBrowserTurnState(this.sessionId, turnId);
    // 释放活跃 turn 标记,允许下一条输入开始新的 turn。
    this.finishActiveTurn(activeTurn);
    // 归还闲时任务票据,并给出结局:stopped / failed / succeeded。
    offPeakTurn.release(
      turnAbortSignal.aborted
        ? "stopped"
        : events.some((event) => event.type === SessionEventType.TurnError)
          ? "failed"
          : "succeeded",
    );
    // 释放外部 abortSignal 的监听器(createTurnAbortScope 注册的)。
    turnAbortScope.dispose();
    try {
      // 通知浏览器后端"本轮已结束"(关闭页面控制权/回收资源);
      // 失败只记 warn,backend 会在 session close 时兜底。
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
  });
}

function injectDateChangeReminderIntoMessageHistory(this: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(this.now());
  const previousDate = this.lastEmittedLocalDate;
  this.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) {
    return;
  }

  this.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}

function injectReferencedSessionContextReminderIntoMessageHistory(
  this: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  this.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
