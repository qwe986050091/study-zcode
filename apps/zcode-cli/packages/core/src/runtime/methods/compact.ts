/**
 * ============================================================================
 * compact.ts —— compact 的"主流程 / 编排层"(三个触发入口)
 * ============================================================================
 *
 * 【它在整条压缩链路里的位置】
 *
 *   turn.ts            → executeManualCompact                    ← 用户显式 /compact
 *   turn-loop.ts       → autoCompactIfNeeded                     ← 每次模型请求前按 token 阈值判断
 *   turn-model-step.ts → reactiveCompactAfterContextExceeded     ← provider 真报"上下文溢出"后的补救
 *                              │  三者最终都调用
 *                              ▼
 *   compact-active.ts  → compactActiveConversation               ← 真正"生成摘要 + 替换历史"
 *
 * 本文件不实现压缩算法,只做三件事:
 *   1. 决策:这次要不要压缩(阈值 / 熔断 / 历史是否足够);
 *   2. 组装上下文:把 trigger / phase / reason / 工具集 / token 口径传给 compactActiveConversation;
 *   3. 结果处理:把压缩后的历史装回本轮请求作用域(turnRequestState.entries)、
 *      维护熔断计数、按触发方式发 turn 事件或返回枚举。
 *
 * 【三种触发方式的语义区别】
 *   Manual    /compact 被当作"独立 turn":有自己的 TurnStarted / TurnComplete,
 *             turnNumber 自增并重建 projection;失败时直接终止整个 turn 并抛给上层。
 *   Auto      发生在普通 turn 的每个模型请求之前(PreRequest 或 MidTurn);
 *             无论成功失败都只返回枚举给 turn loop,不会让 turn 本身失败;
 *             失败仅累计 autoCompactConsecutiveFailures 熔断计数。
 *   Reactive  发生在普通 turn 的模型请求真的超窗之后;成功返回 "compacted",
 *             由调用方重建 TurnMachine 后重试本次请求;同样不抛错给 turn(取消除外)。
 *
 * 【token 口径】
 *   本地估算(estimateMessageTokens)只是兜底;只要历史里存在带 usage 的 assistant,
 *   就改用 provider 上报的真实 input / cache / output + 其后新增条目的本地估算,
 *   避免 auto compact 被"本地估算偏大/偏小"误导(见 buildProviderUsageTokenOverride)。
 *
 * 【与 microcompact 的关系】
 *   microcompact(纯本地裁剪旧工具结果,不调模型)由 turn-loop 在 autoCompact 之前执行;
 *   本文件的三个入口都属于"active compact",都会真实发起一次 summary 模型请求。
 * ============================================================================
 */
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CoreErrorType,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
  estimateMessageTokens,
  hasEnoughMessagesToCompact,
  shouldAutoCompact,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  AutoCompactTokenOverride,
  SessionEvent,
  TraceContext,
  TurnId,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildRuntimeProviderRequestMessages,
} from "../helpers/index.js";
import type { TurnResult, RunModelTextRequestOptions } from "../types.js";
import type { Model } from "../deps.js";
import type { ProviderContextUsageSnapshot } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { autoCompactDecisionLogContext } from "./compact-log-context.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
} from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { findLatestCommittedAssistantUsage } from "./turn-model-step-usage.js";

/**
 * 入口一:手动 /compact —— 把一次压缩当作"独立 turn"执行。
 *
 * 调用链:turn.ts 识别到输入是 /compact 并解析出 compactInstructions 后调用本方法
 * (见 turn.ts 的 `if (compactInstructions !== null)`)。
 * 因为 /compact 不是"普通请求前的旁路压缩",而是一条独立命令,所以这里必须完整地
 * "开 turn → 执行压缩 → 收尾",而不能只调用一次 compactActiveConversation。
 *
 * 与另外两个入口的关键差异:
 *   - 具有独立的 TurnStarted / TurnComplete 事件,并推进 turnNumber;
 *   - 失败时经 createTurnFailureError 归一化后终止整个 turn(抛给上层);
 *   - 用户按 Stop 取消时恢复队列暂停状态,与普通 turn 的 Stop 语义保持一致。
 *
 * @param input              原始输入文本(/compact ...);只用于事件与持久化,不参与压缩内容
 * @param customInstructions /compact 后附带的用户要求,透传给 summary prompt
 * @param turnId             本次独立 turn 的 id
 * @param turnTraceContext   本次 turn 的 trace 上下文(所有事件/子 span 都挂在它下面)
 * @param abortSignal        取消信号;压缩各阶段与结束时都会检查
 * @param inputId            输入 id;存在时写入 turn 事件,并作为 compact 的 sourceCommandId 回链
 * @param model              指定压缩使用的模型(例如模型执行状态降档后的目标模型);
 *                           缺省时由 runtime 按会话选择模型
 */
export async function executeManualCompact(
  this: AgentRuntimeInternal,
  input: string,
  customInstructions: string | undefined,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
  model?: Model,
): Promise<TurnResult> {
  // 本次压缩 turn 的事件缓冲区:compaction 时间线、ModelRequest/Complete、TurnComplete 等
  // 都会 push 进来,供上层流式消费与用量统计使用。
  const events: SessionEvent[] = [];
  // 起始时间:用于 TurnComplete.duration 与 turn 级用量事实。
  const startedAt = Date.now();
  // 注册"活跃 turn"(kind=compact, steerable=false 表示 /compact 执行期间不接受导流输入)。
  // 若已有活跃 turn,这里会抛 TurnInProgress 错误,保证同一 runtime 同时只有一条活跃 turn。
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "compact", false);
  // 用 AsyncLocalStorage 绑定 trace 上下文:其内部所有异步调用(事件、日志、模型请求)
  // 无需显式传参即可自动继承同一个 traceId,保证压缩链路可观测。
  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("Compact started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.started",
      inputLength: input.length,
      module: "core.runtime",
      status: "started",
    });

    // /compact 可能是本会话的第一个输入:先保证 session 行已落库(幂等,已持久化则直接返回),
    // 否则事件与摘要会挂在"尚不存在"的 session 上。并发首轮创建会被合并为同一个 Promise。
    await this.ensureSessionPersisted(input, turnTraceContext);

    // 发 TurnStarted:这是"独立 turn"的标志,普通 turn 同样会发。
    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input,
        inputId,
        // 手动 /compact 是维护命令，不是用户真实 query。
        // 事件仍保留 raw input 便于恢复/排查，但 v4 投影不能把它渲染成 user bubble。
        inputVisibility: "model-only",
      },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      // 进入压缩前先检查取消:用户可能在输入 /compact 后立刻按了 Stop。
      throwIfTurnAborted(abortSignal);
      // 调用核心压缩入口(compact-active.ts)。这里显式传:
      //   compactReason = UserRequested   —— 统计/UI 上标明"用户主动要求";
      //   phase         = StandaloneTurn  —— 压缩自成一条独立 turn,不是请求前/中途压缩;
      //   sourceCommandId = inputId       —— 时间线可回链到触发它的输入;
      //   model                           —— 手动压缩允许使用指定模型(如降档模型)。
      const compactResult = await this.compactActiveConversation(
        customInstructions,
        turnTraceContext,
        events,
        {
          abortSignal,
          compactReason: CompactReason.UserRequested,
          phase: CompactPhase.StandaloneTurn,
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...(model ? { model } : {}),
        },
      );
      // 压缩本身成功,但期间用户可能已取消:此时不应再发"成功"的 TurnComplete,
      // 而是让下面的 catch 走取消路径,保持 Stop 的语义一致。
      throwIfTurnAborted(abortSignal);

      // 汇总本 turn 内所有模型调用(ModelRequest/ModelComplete)的 usage,
      // 既写入 TurnComplete.usage,也供 turn 级用量事实使用。
      const turnUsage = createModelUsageSummaryFromEvents(events);
      // 发 TurnComplete(成功):response 是给用户看的文案("Compacted" 或"无需压缩")。
      // historyRoundCount 固定为 1:一次 compact 摘要算一个 provider 可见的历史轮次。
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response: compactResult.displayText,
          tokenCount: compactResult.tokenCount,
          usage: turnUsage,
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: Date.now() - startedAt,
          resultType: "success",
          cacheStats: this.messageHistory.getCacheStats(),
          inputId,
        },
        turnTraceContext,
      );
      await this.appendEvent(completeEvent, turnTraceContext);
      events.push(completeEvent);
      // 记录 turn 级用量事实(status=completed):与 compact 自身的 compaction telemetry
      // 互补——前者按 turn 归组,后者按压缩操作归组。
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt,
        status: "completed",
        traceContext: turnTraceContext,
        turnId,
      });

      // 独立 turn 成功结束:推进 turnNumber,并重建 session projection
      // (返回值交给上层渲染;压缩后的历史已由 compactActiveConversation 写入 messageHistory)。
      this.turnNumber++;
      const projection = await this.rebuildProjection();
      this.logger?.info("Compact completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "compact.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response: compactResult.displayText,
        turnId,
        traceId: turnTraceContext.traceId,
        usage: turnUsage,
        events,
        projection,
      };
    } catch (error) {
      // 统一错误归一化:
      //   - 外部 fault(如网络故障)保留根因并标记可恢复;
      //   - 取消 → TurnCancelled;
      //   - provider 上下文超窗 → ModelContextExceeded;
      //   - 其余 → UnknownError,文案固定为 "Compact failed"。
      const coreError = createTurnFailureError(error, abortSignal, "Compact failed");
      // 例外:Host 显式要求"取消后仍自动排空队列"时保持原状,避免打断批量输入体验。
      const preserveQueueAutoDrainOnCancel =
        coreError.type === CoreErrorType.TurnCancelled &&
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      if (coreError.type === CoreErrorType.TurnCancelled && !preserveQueueAutoDrainOnCancel) {
        // Stop compact 与普通 Stop 语义一致：队列重新暂停，外层 FIFO 恢复窗口同时关闭。
        this.queueAutoDrain = false;
        this.queueExternalDrainActive = false;
      }
      // 收口 turn 结局事件:取消时发 TurnComplete(resultType:"cancelled"),
      // 真实错误才发 TurnError——避免把"用户主动中断"渲染成失败(见 appendTurnOutcomeEvent)。
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "compact",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "Compact failed",
        logEvent: "compact.failed",
        logLabel: "Compact",
        preserveQueueAutoDrainOnCancel,
      });
      // 用量事实按结局区分 cancelled / error,统计侧才能区分"用户取消"与"真实失败"。
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        error: coreError,
        events,
        startedAt,
        status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
        traceContext: turnTraceContext,
        turnId,
      });

      // 事件与用量已按结局落完,这里只把归一化后的错误交给 turn 层终止命令;
      // 上层不会再发第二条失败事实(避免同一次失败出现两条 TurnError/TurnComplete)。
      throw coreError;
    }
  }).finally(() => {
    // 无论成功、失败还是取消,都释放活跃 turn 标记,
    // 让后续输入可以重新开始 turn(否则 beginActiveTurn 会一直报 TurnInProgress)。
    this.finishActiveTurn(activeTurn);
  });
}

/**
 * 入口二:auto compact —— 普通 turn 在"每次模型请求之前"做阈值判断并按需压缩。
 *
 * 调用链:turn-loop.ts 在每个 model roundtrip 起点调用,顺序是
 *   microcompact(纯本地裁剪)→ 本方法(必要时真正调模型生成摘要)→ MCP/工具准备 → 发请求。
 * phase 为 PreRequest(本轮第一个请求)或 MidTurn(工具轮之间),用于日志/时间线区分。
 *
 * 返回值是"给 loop 的信号",而不是抛错(turn 不应因自动压缩失败而失败):
 *   "skipped"              未达阈值 / 历史不足 / 被熔断 / compact 被禁用,继续正常请求
 *   "compacted"            已替换 turnRequestState.entries,继续正常请求(用压缩后的历史)
 *   "rapid_refill_blocked" 连续多次"压缩后很快又满",loop 应直接失败(防止死循环)
 *   "failed"               压缩执行失败,已计入 autoCompactConsecutiveFailures 熔断
 *
 * 只有取消除外——取消必须向上抛出,让 turn 立刻终止。
 *
 * @param context 由 turn loop 传入的上下文:当前模型、本次请求的 turn-local 历史
 *                (turnRequestState)、阶段(PreRequest/MidTurn)、模型步序号、熔断判定结果,
 *                以及"继续执行作用域"的工具集(getContinuationTools,用于重建 ToolSearch 公告)
 */
export async function autoCompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: AutoCompactLoopContext,
): Promise<AutoCompactOutcome> {
  // 自动压缩是请求前的高频检查点:先确认本轮没有被取消(例如用户刚按 Stop)。
  throwIfTurnAborted(abortSignal);

  // 组装纯策略配置(不产生副作用),交给 shouldAutoCompact 决策:
  //   contextWindow      当前模型的上下文窗口(input + output 共享);
  //   ...this.config.compact  用户/项目配置的阈值、buffer、开关、最大连续失败次数等;
  //   maxOutputTokens    与"正常请求"同口径的输出预留——阈值分母必须扣掉输出窗口,
  //                      否则会在实际还有输入空间时过早触发压缩(计算细节见 policy.ts);
  //   modelContextBudgetStrategy  当前模型的预算策略(影响有效窗口的计算)。
  const config: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  // 本轮 turn-local 历史(不是全局 messageHistory):自动压缩只影响"这次请求要发什么",
  // 不会在请求前直接改全局历史;压缩结果由 compactActiveConversation 统一落盘/替换。
  const activeEntries = context.turnRequestState.entries;
  // 用与真实请求相同的渲染管线构造消息,保证 token 估算口径一致;
  // applyCacheControl=false:这里只为估算,不参与真实请求,也不需要缓存标记。
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  // token 覆盖:若历史里有带 usage 的 assistant,用 provider 真实值 + 后续增量;
  // 否则 undefined,策略层退回本地估算。
  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  // 纯策略决策(无副作用):依次判断 disabled / not_enough_messages / circuit_breaker /
  // below_threshold / above_threshold,并返回本次决策的完整口径(供日志与 telemetry 复用)。
  const decision = shouldAutoCompact({
    messages: activeMessages,
    config,
    consecutiveFailures: this.autoCompactConsecutiveFailures,
    tokenOverride,
  });

  // 不需要压缩:debug 日志(含策略理由与各项 token 口径)后直接放行本次请求。
  if (!decision.shouldCompact) {
    this.logger?.debug("Auto compact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.skipped",
      module: "core.runtime",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      phase: context.phase,
      reason: decision.reason,
      ...autoCompactDecisionLogContext(decision),
    });
    return "skipped";
  }

  // 熔断器(evaluateRapidRefill 的判定结果):若最近连续多次压缩后"没做几轮工具就又满",
  // 说明压缩腾出的空间不足以支撑正常推进。此时不再继续压缩,直接让 loop 失败,
  // 避免"压缩 → 立刻又满 → 再压缩"的无限循环。
  // 注意顺序:先判"是否需要压缩",再判"是否允许压缩"——不需要压缩时不应触发熔断。
  if (context.rapidRefill.shouldBlock) {
    this.logger?.warn("Autocompact rapid-refill breaker tripped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.rapid_refill_breaker",
      compactReason: context.compactReason,
      consecutiveRapidRefills: context.rapidRefill.consecutiveRapidRefills,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      status: "failed",
      toolTurnsSinceCompact: context.rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Auto,
      ...autoCompactDecisionLogContext(decision),
    });
    // 这里只返回信号,真正让 turn 失败发生在 turn-loop.ts:174(抛 createCompactRapidRefillError);
    // 这样 auto compact 永远不直接抛错,保持"自动压缩失败不终止 turn"的分工。
    return "rapid_refill_blocked";
  }

  // 跳过压缩时无需构建 listing 工具合同；读取失败仍向上抛出，不计入压缩失败。
  const agentListingTools = context.getAgentListingTools?.();
  this.logger?.info("Auto compact started", {
    ...traceContextToLogContext(turnTraceContext),
    event: "compact.auto.started",
    compactReason: context.compactReason,
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    ...autoCompactDecisionLogContext(decision),
  });

  try {
    // 真正的压缩:与本轮请求共享同一份 turn-local 历史快照(activeEntries),
    // 压缩成功后由我们手动写回 turnRequestState.entries(见下方 outcome 分支)。
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        // 决策阶段已经算好的占用信息,只用于 compaction telemetry,不参与第二次决策。
        compactContextTelemetry: {
          inputTokens: decision.tokenCount,
          policyContextWindowTokens: decision.contextWindow,
          thresholdTokens: decision.threshold,
          tokenSource: decision.tokenSource,
        },
        // 阈值写入 boundary:实现内部用它计算 willRetriggerNextTurn
        // ("压缩后是否仍会立刻再次触发压缩"),供策略层/UI 提示。
        autoCompactThreshold: decision.threshold,
        // 原因与阶段来自 loop 上下文(如 ContextLimit / PreRequest / MidTurn)。
        compactReason: context.compactReason,
        phase: context.phase,
        trigger: CompactTrigger.Auto,
        // 重建 agent 列表提醒用的工具集;activeEntries 显式传入,保证压缩基于"这次请求"的历史。
        agentListingTools,
        activeEntries,
        getContinuationTools: context.getContinuationTools,
        ...(context.model ? { model: context.model } : {}),
      },
    );
    // 实现内部判断"历史不足/刚压缩过"会返回 skipped:这不是错误,正常继续请求即可。
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    // 把压缩后的历史装回本轮请求作用域:后续"本次请求"与工具轮都会使用新历史。
    context.turnRequestState.entries = compactResult.entries;
    // 压缩成功说明承载能力恢复,重置连续失败熔断计数。
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Auto compact completed", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.completed",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "compacted";
  } catch (error) {
    // 取消必须上抛:让 turn 立即终止,而不是被当成"压缩失败后继续请求"。
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    // 其他失败只做"降级"处理:累计连续失败次数(达到上限后策略层会走 circuit_breaker
    // 不再压缩),记 warn 日志,然后返回 "failed" —— turn 本身继续,用原历史发请求。
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Auto compact failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.auto.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "failed";
  }
}

/**
 * 构造 auto / reactive compact 的 token 覆盖值——"provider usage 优先,本地估算兜底"。
 *
 * 【为什么要从后往前扫描,而不是记住某个绝对下标】
 *   历史会被 compact 整体替换,任何绝对 message cursor 都会失效;
 *   而 usage 总是属于"最后一条已提交的 assistant 消息",从后往前扫 sourceEntries
 *   可以随历史替换自然移动,不需要额外维护游标。
 *
 * 【计算口径】
 *   base  = 该 assistant 保存的 contextUsageTokens(缺失时退回 inputTokens),
 *           即 provider 已经真实处理过的输入规模(含缓存读写);
 *   incr  = 该 assistant 之后新增消息的本地估算(provider 尚未看到的部分);
 *   total = base + incr,作为策略层的 tokenCount。
 *
 *   若 contextUsageTokens 存在,说明该 assistant 的 output 也已在 usage 里体现,
 *   增量从 messageIndex+1 开始;若不存在,则 provider 的 input 只覆盖 assistant
 *   之前的请求,assistant 本身仍要计入增量(从 messageIndex 开始)。
 *
 * @returns undefined 表示没有可用的 usage 基线(例如历史里还没有 assistant),
 *          调用方应退回纯本地估算。
 */
function buildProviderUsageTokenOverride(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[],
): AutoCompactTokenOverride | undefined {
  // 找"最后一条带 usage 基线的 assistant"。
  // messageIndex >= messages.length 说明投影后消息比源条目少(如附件被合并),
  // 该下标在 messages 中已不可靠,放弃覆盖、退回本地估算。
  const latestUsage = findLatestCommittedAssistantUsage(sourceEntries);
  if (!latestUsage || latestUsage.messageIndex >= messages.length) {
    return undefined;
  }

  const { baseline, messageIndex } = latestUsage;
  // 增量起点:contextUsageTokens 存在 → provider 已把该 assistant 的 output 计入 usage,
  // 只需从下一条开始累加;不存在 → assistant 本身也要算进增量。
  const incrementalStartIndex =
    baseline.contextUsageTokens === undefined ? messageIndex : messageIndex + 1;
  // 增量部分的本地估算(只估算 provider 尚未处理的尾部消息,避免重复计算)。
  const incrementalTokenCount = estimateMessageTokens(messages.slice(incrementalStartIndex));
  // usage 归属于已提交 assistant，反向扫描可随 history replacement 自然移动，
  // 不再依赖可能失效的绝对 message cursor。若 output 是否存在已被历史归一化抹平，
  // 则 provider input 只覆盖 assistant 之前的请求，assistant 本身仍进入本地增量。
  // provider 侧的输入基线:优先 contextUsageTokens(含 output 归属的上下文占用),
  // 缺失时退回 inputTokens(仅本次请求的输入 token)。
  const providerBaseTokenCount = baseline.contextUsageTokens ?? baseline.inputTokens;
  // 同时保留 cache 读写与 output 分量:策略层/日志需要区分"缓存命中"与"真实新增"。
  // 注意它们是**分解字段**,tokenCount 已经是 base + incr:
  //   - base(contextUsageTokens)按定义包含缓存读写;
  //   - output 已计入 provider 基线或由增量估算覆盖。
  // 所以这里不能再把 cacheRead/cacheWrite/output 加进 tokenCount,否则会重复计数。
  // source="provider_usage" 让 shouldAutoCompact 的 tokenSource 与日志口径可区分。
  return {
    baseTokenCount: providerBaseTokenCount,
    cacheReadTokens: baseline.cacheReadTokens,
    cacheWriteTokens: baseline.cacheWriteTokens,
    contextUsageTokenCount: baseline.contextUsageTokens,
    incrementalTokenCount,
    outputTokens: baseline.outputTokens,
    source: "provider_usage",
    tokenCount: providerBaseTokenCount + incrementalTokenCount,
  };
}

/**
 * 估算"当前模型输入"的 token 数:provider usage 优先,本地估算兜底。
 * 用于展示、日志与部分遥测场景;auto compact 的决策口径请用 shouldAutoCompact(内部同源)。
 */
export function estimateCurrentModelInputTokens(
  messages: RunModelTextRequestOptions["messages"],
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[] = [],
): number {
  return (
    buildProviderUsageTokenOverride(messages, sourceEntries)?.tokenCount ??
    estimateMessageTokens(messages)
  );
}

/**
 * 入口三:reactive compact —— provider 真的报"上下文超窗"(overflow)之后的补救。
 *
 * 调用链:turn-model-step.ts 的 recoverModelStepAfterContextExceeded:
 *   模型请求抛 ModelContextExceeded / 或 finishReason 表明超窗
 *     → 检查"本 model step 是否已尝试过 reactive"(只允许一次)
 *     → 检查 rapid-refill 熔断
 *     → 调用本方法;返回 "compacted" 后重建 TurnMachine 并重发本次请求。
 *
 * 与 auto 的关键差异:
 *   - 传入 initialPromptTooLongCause(原始溢出错误):核心实现会按错误里的 token gap
 *     多保留最近轮次,让 summary 请求本身就落回窗口内,而不是照常从完整历史摘要;
 *   - compactReason = ProviderOverflow,phase = Reactive,trigger = Reactive;
 *   - 除取消外不抛错:失败只返回 "failed"/"skipped",由调用方决定后续(通常是把原错误抛给 turn);
 *   - compact 被配置显式禁用时直接 "skipped",不做任何尝试。
 *
 * @param originalError 触发本次补救的原始错误(上下文超窗);会给核心实现用于 token-gap 切分
 * @param context       loop 上下文:触发溢出时的条目快照(activeEntries)、模型、步序号、
 *                      工具集(用于重建 agent 列表与 ToolSearch 公告)
 */
export async function reactiveCompactAfterContextExceeded(
  this: AgentRuntimeInternal,
  originalError: unknown,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: ReactiveCompactLoopContext,
): Promise<CompactAttemptOutcome> {
  // 补救路径仍在 turn 内:先确认没有取消。
  throwIfTurnAborted(abortSignal);

  // compact 被配置禁用(如用户关闭自动压缩)时,reactive 也不应绕过配置去调模型。
  if (this.config.compact?.enabled === false) {
    this.logger?.warn("Reactive compact skipped because compact is disabled", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context.rapidRefillCount,
      reason: "disabled",
    });
    return "skipped";
  }

  // 优先使用调用方传入的"触发溢出时"的条目快照:压缩期间历史可能继续变化,
  // 用快照能保证"压缩的是导致溢出的那份历史"。缺省退回本轮 turn-local 历史。
  const activeEntries = context.activeEntries ?? context.turnRequestState.entries;
  // 与真实请求同一渲染口径,用于判断"历史是否值得压缩"以及 token 统计。
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  // 历史不足(少于 2 个轮次或没有 assistant)时压缩没有意义,直接 skipped;
  // 调用方会把原始溢出错误抛给 turn,而不是无限重试。
  if (!hasEnoughMessagesToCompact(activeMessages)) {
    this.logger?.warn("Reactive compact skipped because there is not enough history", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      messageCount: activeMessages.length,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
      reason: "not_enough_messages",
    });
    return "skipped";
  }

  // token 口径与 auto 相同:provider usage 优先,本地估算兜底。
  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  // reactive 的"策略上下文窗口"只用于 telemetry;实现内部会先用错误里的 gap 做切分。
  const contextWindow = context.model.properties.contextWindow;

  this.logger?.warn("Reactive compact started after model context overflow", {
    ...traceContextToLogContext(turnTraceContext),
    errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
    event: "compact.reactive.started",
    messageCount: activeMessages.length,
    modelStepIndex: context?.modelStepIndex,
    module: "core.runtime",
    rapidRefillCount: context?.rapidRefillCount,
    tokenCount: estimateMessageTokens(activeMessages),
  });

  try {
    // 真正的压缩:注意 model 必传(reactive 只能用"刚刚溢出时正在用的模型"补救),
    // 不能像 auto 那样用可选的 context.model。
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        // 仅用于 telemetry:输入侧用 provider usage(或本地估算);窗口做合法性兜底,
        // 非法值退回 DEFAULT_COMPACT_CONTEXT_WINDOW,避免 telemetry 出现 NaN/0。
        compactContextTelemetry: {
          inputTokens: tokenOverride?.tokenCount ?? estimateMessageTokens(activeMessages),
          policyContextWindowTokens:
            contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
              ? Math.floor(contextWindow)
              : DEFAULT_COMPACT_CONTEXT_WINDOW,
          tokenSource: tokenOverride?.source ?? "estimate",
        },
        compactReason: CompactReason.ProviderOverflow,
        // 关键:把原始溢出错误交给实现,按 "actual > limit" 的差额多保留最近轮次,
        // 让 summary 请求本身就能装进窗口。
        initialPromptTooLongCause: originalError,
        phase: CompactPhase.Reactive,
        trigger: CompactTrigger.Reactive,
        agentListingTools: context.agentListingTools,
        activeEntries,
        getContinuationTools: context.getContinuationTools,
        model: context.model,
      },
    );
    // 历史不足/刚压缩过:skipped 不是失败,调用方会继续走原始错误的失败路径。
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    // 压缩成功:把新历史写回本轮请求作用域,调用方据此重建 TurnMachine 后重试请求。
    context.turnRequestState.entries = compactResult.entries;
    // 补救成功说明承载能力恢复,重置连续失败熔断计数。
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Reactive compact completed; retrying model request", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.reactive.completed",
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "compacted";
  } catch (error) {
    // 取消必须上抛:让 turn 立即终止。
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    // 补救失败:累计熔断计数并记 warn,返回 "failed";
    // 调用方会放弃补救,把"原始上下文超窗错误"抛给 turn(而不是抛压缩错误,避免误导根因)。
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Reactive compact failed after model context overflow", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.reactive.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "failed";
  }
}
