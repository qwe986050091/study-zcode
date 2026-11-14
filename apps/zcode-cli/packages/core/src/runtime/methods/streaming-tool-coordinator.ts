/**
 * ============================================================================
 * streaming-tool-coordinator.ts —— 流式期间的"提前工具执行"协调器
 * ============================================================================
 *
 * 【它解决什么问题】
 * 模型流式输出 tool call 时,如果等到流完全结束再执行工具,会浪费"剩余流时间"。
 * 本协调器在 tool_call 事件到达时就对"安全工具"(只读、并发安全、无副作用、
 * 无需审批)提前执行,等流结束后直接复用结果;不安全/需要审批的工具仍留到
 * turn-tools.ts 的批次执行阶段。
 *
 * 【对外能力】
 *   admit/accept   接收并准入 tool call;必要时启动提前执行
 *   drain          流结束后等待并返回提前完成的结果
 *   abandon        模型失败/取消时中止提前执行并标记 ledger
 *   recoverFromModelFailure  流失败后决定:无工具→partial 重试;有工具→先结算工具再重试
 *   settleForModelFallback   执行模型退回前,把已接受的工具结果统一闭合
 *
 * 【状态约束】
 *   - 只有通过 runtime admission(resolveDeferredToolCall)的 tool call 才能执行;
 *   - 提前执行的结果必须带有 partID 与 ledgerRecorded 标记,避免 turn-tools 重复落盘;
 *   - 取消/失败时,已接受的工具必须得到明确终态(cancelled/abandoned/synthetic error),
 *     不能让 durable ToolPart 停在 pending/running。
 * ============================================================================
 */
import { resolveDeferredToolCall } from "../../tool/deferred-call.js";
import type { ToolSearchExecutionContext } from "@zcode/contracts";
import { TurnMachineImpl, createPartId } from "../deps.js";
import type {
  MessageId,
  Model,
  ModelToolCall,
  ToolCall,
  ToolCallId,
  TraceContext,
} from "../deps.js";
import {
  emitStreamingToolLedgerUpdate,
  requireRuntimeToolCallName,
  toRecordInput,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { createSyntheticStreamedToolResult } from "./streaming-tool-synthetic-result.js";
import {
  beginStreamRecoveryAttempt,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  hasStreamRecoveryBudget,
  recoverPartialAssistantOutputFailure,
} from "./streaming-recovery.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { persistPendingToolPart } from "./tool-part-persistence.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordModelHistoryRound,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

// 取消/结算路径等待"提前执行"清理的最长窗口。这里只求把 abort 传播到位,
// 不追求拿到真实结果:没完成的部分由结算逻辑补 synthetic 终态。
// 取 250ms 是因为只读工具收到 abort 通常立即返回;等更久只会让 Stop 变卡。
const STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS = 250;
// 目前唯一支持的"提前执行模式":只读。保留这个常量是为了让
// config.streamingToolExecution 的缺省值与显式 "readOnly" 走同一分支,
// 避免 ""/undefined 被误判成另一种模式。
const STREAMING_TOOL_EXECUTION_MODE = "readOnly";

/**
 * 创建一个“流式期间工具协调器”实例。返回对象由 turn-model-step 使用:
 * 流式回调进 accept,结束进 drain,失败进 abandon/recover,模型退走进 settle。
 *
 * 【生命周期】每个 model step 新建一个实例,只服务于该 step 的一次模型请求;
 * 因此下面的计数器、handles、acceptedToolCalls 都不需要跨 step 重置。
 * 一个 step 正常情况下只会命中下列终结点之一:
 *   drain(成功) / abandon(取消或失败丢弃) / recoverFromModelFailure(有工具的重试)
 *   / settleForModelFallback(执行模型退回前结算)。
 * 各终结点都会移除 turnAbortSignal 监听,避免监听器随 step 累积。
 *
 * @param options.assistantMessageId 本次 assistant 消息 id(工具 part 挂在它下面)
 * @param options.model               当前执行模型(用于 part 归属与空名诊断)
 * @param options.toolSearch          当前 ToolSearch 上下文(决定延迟工具如何解析)
 */
export function createStreamingToolCoordinator(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    model: Model;
    toolSearch?: ToolSearchExecutionContext;
    traceContext: TraceContext;
  },
) {
  // 独立 AbortController:只取消"提前执行"的只读工具,不影响主模型流;
  // turn 取消时通过监听 turnAbortSignal 一并中止。
  const abortController = new AbortController();
  // toolCallId -> 提前执行的 Promise;drain/settlement 都从这里取结果。
  // 值为 undefined 表示提前执行失败并已降级(交给流结束后正常批次执行)。
  const handles = new Map<string, Promise<StreamedToolExecutionResult | undefined>>();
  // 已准入的 tool call(含准入错误);abandon/settlement 遍历它生成终态。
  // 与 handles 的差别:admission 发生在 accept 之前(含 providerExecuted 与不安全工具),
  // 所以这里的条目数量 ≥ handles 条目数量,也是 declarationIndex 的计数来源。
  const acceptedToolCalls = new Map<string, { call: ToolCall; error?: Error }>();
  // 仅用于流恢复事件的"丢弃量"报告:恢复会整段丢弃本次请求已生成的 reasoning/text,
  // UI/统计需要这个字节数解释"内容为什么消失"。只在失败路径读取,成功路径不读。
  let discardedReasoningBytes = 0;
  let discardedTextBytes = 0;

  // turn 级取消(Stop/父任务 abort)同样要中止提前执行;once:true 保证只触发一次。
  // 各终结点会显式 removeEventListener,因为每个 step 都会新建实例、重复监听会累积。
  const abortOnTurnCancel = () => abortController.abort();
  state.turnAbortSignal.addEventListener("abort", abortOnTurnCancel, { once: true });

  // 准入:解析延迟工具(DeferredToolCall/ToolSearch),得到真实 ToolCall;
  // 同一 id 只准入一次,保证后续 accept/drain 看到同一对象。
  //
  // resolveDeferredToolCall 的返回口径:
  //   - 普通工具:原样返回 { call },无 error;
  //   - DeferredToolCall:校验通过则把 name/input 换成真实目标工具(写 modelCallWrapper);
  //     不可用/参数非法/目标不是可延迟工具 → 返回 { call: 原始 call, error },由调用方决定降级;
  //   - 空名工具:原样返回,真正的诊断留给 requireRuntimeToolCallName(正常 finish 报 registry miss,
  //     断流则保留 synthetic interrupted error,语义见 accept 里的注释)。
  // 缓存不只是性能考虑:accept 可能对同一 id 重复回调,且 declarationIndex 依赖"已准入数量",
  // 必须保证重复调用不重复插入。
  const admit = (toolCall: ModelToolCall) => {
    const accepted = acceptedToolCalls.get(toolCall.id);
    if (accepted) return accepted;
    const admission = resolveDeferredToolCall(toolCall, options.toolSearch, runtime.registry);
    acceptedToolCalls.set(toolCall.id, admission);
    return admission;
  };

  // 结算准备:先中止尚未完成的提前执行,再收集已完成结果;
  // 没有完成结果的工具用 synthetic(unknown_execution_state/not_executed)补齐,
  // 保证每个已接受 tool call 都有终态。
  // 维护不变量#1:每个 tool_call 必须有配对结果;synthetic 终态确保即使提前执行
  // 被取消/失败,也不会留下"无结果的 tool_call"让冷恢复卡住。
  //
  // 先 abort 再收集的顺序不能反:abort 后未完成的 handle 才会尽快进入
  // "结果为 undefined" 或抛错状态,collectCompletedResults 才有确定的观察点;
  // 同时 abort 也是对"已落盘 running part"的唯一停止信号。
  //
  // synthetic 两种原因的区分标准是 handles.has(id):
  //   - 有 handle → 提前执行启动过(可能已写 pending/running part,甚至已完成副作用)
  //     → unknown_execution_state,提示模型"状态未知,重试前先检查";
  //   - 无 handle → 从未提前执行(不安全工具/准入失败/流结束前未收到完整 call)
  //     → not_executed,提示模型"未执行,可按失败处理"。
  const prepareAcceptedToolSettlement = async () => {
    abortController.abort();
    const toolCalls = Array.from(acceptedToolCalls.values(), ({ call }) => call);
    const settledResults = await collectCompletedResults(handles, toolCalls);
    const settledResultById = new Map(settledResults.map((result) => [result.toolCallId, result]));
    return {
      toolCalls,
      streamedToolResults: toolCalls.map(
        (toolCall) =>
          settledResultById.get(toolCall.id as ToolCallId) ??
          createSyntheticStreamedToolResult(
            toolCall,
            handles.has(toolCall.id) ? "unknown_execution_state" : "not_executed",
          ),
      ),
    };
  };

  // 结算提交:把"已接受工具 + 提前结果"作为一条 assistant 消息写入本轮历史,
  // 再复用 turn-tools 的正规 settlement 生成模型可见 tool result。
  // 用于流失败恢复/执行模型退回:先闭合工具义务,再切换模型重试。
  //
  // 各步骤的必要性:
  //   - modelResponse = "":这次响应没有可提交的可见文本(文本要么没生成,要么随失败被丢弃),
  //     工具 call 是唯一需要保留的 anchor;写空串可避免把半截文本重复写进历史。
  //   - modelStepCount += 1 + recordModelHistoryRound:本次"模型回合"仍要占位,
  //     provider history 与本地轮次计数必须同步前进,否则后续 token 预算/轮次判断会错位。
  //   - toolCallCount += results.length:按"已闭合的工具结果"计数,而不是按 tool call 数,
  //     保证后续 iteration 分组(function of toolCallCount)与实际结果一致。
  //   - commitTurnRequestEntries:把 assistant(tool_call) 立刻写入 live history,
  //     冷恢复重放时才看得到"这些 call 已存在、有结果",不会重复执行。
  //   - TurnMachine.receiveModelResponse(""):状态机也要收到这次模型响应,
  //     否则后续 aggregateResults/终态判断会丢失一个 step。
  //   - executeToolCallsForModelStep:完全复用正常路径的 settlement(持久化 tool part、
  //     发事件、生成模型可见 result),避免恢复路径自造一套落盘逻辑。
  //   - 最后移除 abort 监听:本实例的使命到此结束,下一个 model step 会新建协调器。
  const commitAcceptedToolSettlement = async (
    assistantCreatedAt: number,
    providerMetadata: Record<string, unknown>,
    settlement: Awaited<ReturnType<typeof prepareAcceptedToolSettlement>>,
  ) => {
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.toolCallCount += settlement.streamedToolResults.length;
    // 完整 tool_call 已建立配对义务；切换模型前必须让 live、durable ToolPart 与冷恢复看到同一组 call/result。
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      createRuntimeAssistantEntry("", settlement.toolCalls, undefined, options.model),
    ]);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    await executeToolCallsForModelStep.call(runtime, state, {
      toolSearch: options.toolSearch,
      assistantCreatedAt,
      assistantMessageId: options.assistantMessageId,
      modelTraceContext: options.traceContext,
      result: {
        finishReason: "tool-calls",
        providerMetadata,
        text: "",
        toolCalls: settlement.toolCalls,
        usage: {},
      },
      streamedToolResults: settlement.streamedToolResults,
      toolCalls: settlement.toolCalls,
    });
    state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
  };

  return {
    // 仅供 turn-model-step 把 tool call 转成可执行对象;不启动执行。
    // 这里只返回 call,刻意丢弃 admission.error:真正的错误要到流结束后的
    // 执行阶段才该暴露给模型(提前报错会让一个可恢复的延迟工具错误变成轮次失败)。
    admit: (toolCall: ModelToolCall) => admit(toolCall).call,
    accept(toolCall: ModelToolCall) {
      // 复制一份再处理:admit 的 DeferredToolCall 分支会返回"改写后的新对象",
      // 而 handles/abort 等都以模型原始 id 为键;保持原始字段不被就地修改,
      // 避免流解析器持有的对象与协调器状态互相污染。
      // 空名问题不在 accept 修:admission 保留空名,正常 finish 走 registry miss,
      // 断流(recovery)则保留 synthetic interrupted error 语义。
      const normalizedToolCall = { ...toolCall };
      // provider 侧已执行完的工具没有本地 ToolPart,也没有可提前执行的动作,直接跳过。
      if (normalizedToolCall.providerExecuted) return;
      const admission = admit(normalizedToolCall);
      const acceptedCall = admission.call;
      // 准入失败或工具不满足"安全工具"条件 → 不提前执行,留给批次执行阶段。
      // 注意准入失败时仍保留在 acceptedToolCalls 里:恢复结算要为它生成终态。
      if (admission.error || !shouldExecuteToolDuringStream(runtime, acceptedCall)) return;
      // 同一 id 重复回调时直接返回,保证一个 tool call 只执行一次。
      if (handles.has(normalizedToolCall.id)) return;
      // 提前执行:任何异常都降级为"留给流结束后执行"(返回 undefined),
      // 不能用提前执行的失败污染整次模型响应。
      const promise = executeDuringStream(runtime, state, {
        abortSignal: abortController.signal,
        assistantMessageId: options.assistantMessageId,
        // model admission 已去重；只读工具可能先落盘，序号必须来自全部本地声明。
        // 取"已准入数量 - 1"而不是最终 toolCalls 数组下标:最终数组会过滤 providerExecuted
        // 且顺序以流结束时的汇总为准,而 part 的 declarationIndex 必须在写入时就与模型
        // 声明顺序一致,否则冷恢复时工具卡位置会错乱。
        declarationIndex: acceptedToolCalls.size - 1,
        model: options.model,
        toolSearch: options.toolSearch,
        toolCall: acceptedCall,
        traceContext: options.traceContext,
      }).catch(async (error) => {
        // 降级为 undefined 后,该工具会在流结束的批次执行阶段重新执行。
        // 必须 warn 留痕:这是"提前执行失败了但用户看不出区别"的路径,
        // 日志是唯一能解释为什么这次没有复用提前结果的地方。
        runtime.logger?.warn("Streaming tool execution fell back to end-of-stream execution", {
          error: error instanceof Error ? error.message : String(error),
          event: "tool.streaming.execution_failed",
          module: "core.runtime",
          status: "failed",
          toolCallId: normalizedToolCall.id,
          toolName: normalizedToolCall.name,
        });
        return undefined;
      });
      handles.set(normalizedToolCall.id, promise);
    },

    // 放弃:模型失败/用户取消时中止提前执行,并为每个已接受工具发终态 ledger 事件。
    // 只在超时窗口内等待清理(250ms),避免取消路径被慢工具拖住。
    //
    // 与 settle 的本质区别:abandon 不提交工具结果。因为这里对应的是
    // "这次模型响应整体作废"(取消/失败丢弃),没有可配对的 assistant tool_call
    // 需要写进历史,所以只做两件事:发终态 ledger(供 UI 收口工具卡),
    // 以及把 abort 传下去让已开始的只读工具尽快停下。
    // ledger 先发、再等待:即使语义上"已放弃",UI 也能立刻看到终态,
    // 不用等慢工具真的退出。
    async abandon(reason: "cancelled" | "model_failed") {
      abortController.abort();
      // 取消与失败用不同状态码,UI/统计可以区分"用户主动停"和"模型侧失败"。
      const status = reason === "cancelled" ? "tool_cancelled" : "tool_abandoned";
      // 遍历 acceptedToolCalls 而不是 handles:准入失败/不安全工具同样需要终态,
      // 否则它们会在 UI 上永远停在声明态。
      await Promise.all(
        Array.from(acceptedToolCalls.values()).map(({ call: toolCall }) =>
          emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status,
            executionTiming: "during_stream",
            blockedReason: reason,
          }),
        ),
      );
      // allSettled 吞掉提前执行的异常;raceWithTimeout 保证最坏情况也只等 250ms。
      await raceWithTimeout(
        Promise.allSettled(handles.values()),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
    },

    // 等待提前执行完成:只返回"已经完成"的结果;未完成的继续留在批次执行阶段执行。
    //
    // 成功路径不设超时,这点与 abandon/settlement 相反:流已经正常结束,
    // 已经启动的工具必须等到真实结果,否则只能重新执行——重复执行可能带来
    // 重复副作用(即便当前只允许只读工具,重复调用也会浪费调用配额与时间)。
    // 顺序上逐个 await 不会串行化执行:executeDuringStream 在 accept 阶段就已启动,
    // 这里只是按模型声明顺序收集已并行的 Promise。
    // 只遍历传入的 toolCalls(已过滤 providerExecuted):provider 执行的 call 没有本地结果;
    // 准入失败/不安全工具的 handle 本来就不存在,跳过即可,它们走批次执行。
    async drain(toolCalls: readonly ModelToolCall[]) {
      const results: StreamedToolExecutionResult[] = [];
      for (const toolCall of toolCalls) {
        const handle = handles.get(toolCall.id);
        if (!handle) continue;
        const result = await handle;
        // undefined = 提前执行抛错并已降级,这次不返回结果,由批次执行重新跑。
        if (result) results.push(result);
      }
      state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
      return results;
    },

    // 累计被丢弃的推理/文本字节数:流恢复后这些内容不会进入历史,
    // 恢复事件里需要报告丢弃量,便于 UI/统计解释"为什么内容消失了"。
    // 回调是逐 delta 触发,所以这里做累加;按 UTF-8 字节而不是字符数统计,
    // 与事件里其他 byte 口径(originalBytes/returnedBytes)保持一致。
    // 只统计不影响成功路径:成功时这些计数根本不会被读出。
    recordReasoningDelta(text: string) {
      discardedReasoningBytes += new TextEncoder().encode(text).byteLength;
    },

    recordTextDelta(text: string) {
      discardedTextBytes += new TextEncoder().encode(text).byteLength;
    },

    // 流失败恢复:
    //   - 尚未接受任何工具 → 走 partial 输出恢复(可能保留已生成文本后重试);
    //   - 已接受工具 → 必须先结算工具(否则历史里 tool_call 无结果),
    //     提交后返回 true,调用方进入下一轮循环重发请求。
    //
    // 返回 false 表示"这次失败不该由协调器处理":调用方会继续走后续分支
    // (off-peak 接管、Start Plan 繁忙重试、取消持久化、直接失败等)。
    async recoverFromModelFailure(
      error: unknown,
      assistantCreatedAt: number,
      recoveryOptions: { failedRequestId?: string } = {},
    ) {
      // 已取消就别再重试(用户意图优先);重试预算耗尽也必须交回调用方,
      // 否则会无限重连同一个坏掉的 provider。
      if (state.turnAbortSignal.aborted || !hasStreamRecoveryBudget(state)) return false;
      // failedRequestId 只在存在时透传:事件 schema 不允许显式 undefined 字段;
      // UI 靠它把"恢复"与具体那次失败的网络请求关联起来。
      const recoveryEventOptions = {
        ...options,
        ...(recoveryOptions.failedRequestId
          ? { failedRequestId: recoveryOptions.failedRequestId }
          : {}),
      };
      // 分支 A:没有任何已接受工具 → 交给 partial 恢复。
      // 该 helper 负责判断"已生成的文本能否保留"、发恢复事件、清理监听器,
      // 这里不重复做结算(没有工具就没有配对义务)。
      if (acceptedToolCalls.size === 0) {
        return recoverPartialAssistantOutputFailure({
          abortController,
          assistantCreatedAt,
          discardedReasoningBytes,
          discardedTextBytes,
          error,
          options: recoveryEventOptions,
          runtime,
          state,
          turnAbortListener: abortOnTurnCancel,
        });
      }
      // 分支 B:有已接受工具 → 先占一次重试预算,再结算工具。
      // beginStreamRecoveryAttempt 会自增 streamRecoveryRetryCount,
      // 保证"工具结算 + 重试"与普通 partial 重试共享同一份预算。
      const recoveryAttempt = beginStreamRecoveryAttempt(state);
      const settlement = await prepareAcceptedToolSettlement();
      // 事件顺序:先 started 再提交工具结果。UI 先看到"正在恢复",
      // 随后才收到 tool result 事件,不会出现"结果先到但不知道在恢复"的倒序。
      await emitStreamRecoveryStarted(runtime, state, recoveryEventOptions, error, recoveryAttempt);
      // providerMetadata 标记 recoveredFromStreamFailure:持久化的 tool result
      // 能自证来自恢复路径,便于事后排查"这个结果不是正常流产生的"。
      await commitAcceptedToolSettlement(
        assistantCreatedAt,
        { recoveredFromStreamFailure: true },
        settlement,
      );
      // reason=latest_committed_tool_result:下一次请求以"最近一条已提交工具结果"
      // 作为恢复锚点重发,而不是从零开始;toolCallIds 列出本次闭合了哪些 call。
      await emitStreamRecoveryRetryEvents(runtime, state, recoveryEventOptions, {
        ...recoveryAttempt,
        discardedReasoningBytes,
        discardedTextBytes,
        reason: "latest_committed_tool_result",
        toolCallIds: settlement.streamedToolResults.map((result) => result.toolCallId),
      });
      return true;
    },

    // 执行模型退出的前置结算:在切换到退回模型之前,把已接受工具闭合。
    // 返回 false 表示没有需要结算的工具(调用方可以安全切换模型)。
    //
    // 调用时机很关键(turn-execution-fallback 已注明):无论最终能否解析出退回目标,
    // 都必须先调用本方法。否则"解析失败 → 只 abandon → 真实工具结果丢失"
    // 会让 durable ToolPart 停在 pending/running,冷恢复只能给出假的未知状态。
    // providerMetadata 标记 recoveredFromExecutionModelFallback,与流恢复的结果区分开,
    // 事后可以判断工具结果到底来自哪条恢复路径。
    async settleForModelFallback(assistantCreatedAt: number) {
      if (acceptedToolCalls.size === 0) {
        // 没有工具义务也要 abort + 移除监听:本实例不会再用,残留的只读执行
        // 与监听器只会污染下一次 model step。
        abortController.abort();
        state.turnAbortSignal.removeEventListener("abort", abortOnTurnCancel);
        return false;
      }
      const settlement = await prepareAcceptedToolSettlement();
      await commitAcceptedToolSettlement(
        assistantCreatedAt,
        { recoveredFromExecutionModelFallback: true },
        settlement,
      );
      // 返回 true:调用方会切换 state.model 并继续循环,下一轮新建协调器;
      // 已提交的工具结果留在历史里,退回模型能直接看到这些 call/result 配对。
      return true;
    },
  };
}

/**
 * 在流式期间执行一个已知安全的工具,并把结果包装成 StreamedToolExecutionResult。
 *
 * 关键顺序:
 *   1) 先落 pending part(durable writer),保证 Stop 发生在 drain 前也能恢复工具卡;
 *   2) 发 tool_call_closed / tool_queued ledger 事件;
 *   3) 调度并执行(单工具调度),onBatchStart 时把 part 标为 running;
 *   4) 返回 { input, partID, result, ledgerRecorded:true },供 turn-tools 复用。
 */
async function executeDuringStream(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    abortSignal: AbortSignal;
    assistantMessageId: MessageId;
    declarationIndex: number;
    model: Model;
    toolSearch?: ToolSearchExecutionContext;
    toolCall: ToolCall;
    traceContext: TraceContext;
  },
): Promise<StreamedToolExecutionResult | undefined> {
  throwIfTurnAborted(state.turnAbortSignal);
  const toolCall = options.toolCall;
  // 空名在这里必须抛/上报:提前执行比批次执行更早接触 tool call,
  // 若不拦住,后续 registry.get("") 只会得到难懂的 miss,丢失 provider 归因。
  requireRuntimeToolCallName(toolCall, {
    logger: runtime.logger,
    model: options.model,
    source: "streamingToolCoordinator.executeDuringStream",
    traceContext: options.traceContext,
  });
  // partID 必须在"落盘之前"生成:onBatchStart 的 running 状态更新要复用同一个 id,
  // 否则会写出两个互不相干的 ToolPart(pending 一个、running 一个)。
  const partID = createPartId();
  const input = toRecordInput(toolCall.input);
  // MCP 展示元数据随 part 一起写入,前端才能渲染 MCP 工具卡;
  // 提前执行是最早的写入者,漏掉这里就意味着冷恢复时卡片退化成通用样式。
  const metadata = mcpToolPartMetadata(
    runtime.registry.getMetadata(toolCall.name)?.mcpPresentation,
  );
  // during_stream 是 pending/running part 的首个 durable writer；若绕过
  // turn-tools 的 metadata 写入，Stop 发生在 drain 前时冷恢复只能退化成通用工具卡。
  await persistPendingToolPart(runtime, {
    assistantMessageId: options.assistantMessageId,
    declarationIndex: options.declarationIndex,
    input,
    metadata,
    model: options.model,
    partID,
    toolCall,
    traceContext: options.traceContext,
  });
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_call_closed",
    executionTiming: "during_stream",
    input,
  });

  // 即使只执行一个工具也走 runtime 的正规 schedule/execute:
  //   - scheduleTools 决定并发槽位与排序,绕过它会让提前执行与批次执行抢资源;
  //   - emitToolScheduledEvents 产生的 scheduled 事件是 UI 展示"排队中"的依据,
  //     提前执行同样应该有可见的排队态,而不是从声明直接跳到 running。
  const schedule = await runtime.scheduleTools([toolCall]);
  const scheduledEvents = await runtime.emitToolScheduledEvents(
    [toolCall],
    schedule,
    options.assistantMessageId,
    options.traceContext,
  );
  state.events.push(...scheduledEvents);
  // tool_queued 与 tool_started 分开:前者是"已进入调度",后者要等真正拿到执行槽。
  // 这样 UI 能区分"排队等并发"和"已经开始跑"。
  await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
    assistantMessageId: options.assistantMessageId,
    toolCall,
    status: "tool_queued",
    executionTiming: "during_stream",
    input,
  });

  const execution = await runtime.executeTools([toolCall], schedule, {
    subagentModelOverride: state.subagentModelOverride,
    // model 与 subagentModelOverride 同时传入:普通工具用 model,子代理派发用 override,
    // 提前执行不能因为"流式路径"而丢失这个分层。
    model: state.model,
    toolSearch: options.toolSearch,
    // automation/offPeak 两个标记必须沿用到提前执行:只读工具也可能触发
    // 受限轮次的策略检查,漏传会让安全检查在提前路径上失效。
    automationTurn: isAutomationMutationRestrictedTurn(state),
    offPeakTurn: isOffPeakCreateRestrictedTurn(state),
    signal: options.abortSignal,
    traceContext: options.traceContext,
    // onBatchStart 在真正开始执行前触发:这里才把 pending part 更新为 running,
    // 并发 tool_started 事件。放在 onBatchStart 而不是 executeTools 之前,
    // 是为了避免"发了 started 但实际还在排队"的假状态。
    onBatchStart: async () => {
      const startedAt = Date.now();
      // metadata 只带 modelCallWrapper 这一项:它记录"这个 call 是通过 DeferredToolCall
      // 包装进来的"以及真实目标工具,冷恢复/UI 靠它还原调用链;
      // MCP 展示元数据在第一层(state.metadata)里,两者不能混写。
      await runtime.persistPart(
        {
          id: partID,
          sessionID: runtime.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: toolCall.id,
          declarationIndex: options.declarationIndex,
          tool: toolCall.name,
          metadata: toolCall.modelCallWrapper
            ? { modelCallWrapper: toolCall.modelCallWrapper }
            : undefined,
          state: {
            status: "running",
            input,
            title: toolCall.name,
            metadata: metadata ?? {},
            time: {
              start: startedAt,
            },
          },
        },
        options.traceContext,
      );
      // 用同一个 startedAt 写 part 与事件:UI 的耗时展示以事件时间为准,
      // 两处取不同时间会让"卡片开始时间"和"运行时长"对不上。
      await emitStreamingToolLedgerUpdate(runtime, state.events, options.traceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_started",
        executionTiming: "during_stream",
        input,
        startedAt: new Date(startedAt),
      });
    },
  });
  state.events.push(...execution.events);
  // 单工具执行固定取 results[0];为空说明执行器内部已经吞掉/跳过该 call
  // (例如取消),返回 undefined 让流结束后的批次路径重新决策。
  const result = execution.results[0];
  if (!result) return undefined;
  // ledgerRecorded=true 是给 turn-tools 的契约:closed/queued/started 三个 ledger 事件
  // 已经在提前执行时发过,批次阶段不要再发一遍,否则 UI 会看到重复的工具卡状态。
  return {
    input,
    ledgerRecorded: true,
    partID,
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

/**
 * 判断某个 tool call 是否允许"流式期间提前执行"。
 * 条件非常保守:本地工具、非空名、开启流式、只读、并发安全、非破坏性、
 * 不需审批、无用户交互、副作用范围为 none —— 任何一条不满足都留给批次执行。
 *
 * 白名单而不是黑名单的理由:提前执行发生在"模型还没输出完"的时刻,
 * 此时即便工具失败也无法可靠回滚,还可能和流式取消竞争;宁可少省时间,
 * 也不能让有副作用的工具在不确定的时机跑掉。
 * 逐条对应:
 *   - providerExecuted:provider 侧已执行,本地无工具可跑;
 *   - 空名:无法查 registry,提前跑只会制造无归属的 ToolPart;
 *   - modelStreaming !== "on":非流式请求不存在"剩余流时间",提前执行没有收益;
 *   - streamingToolExecution === "off":用户显式关闭;缺省(readOnly)视为开启;
 *   - registry miss:工具不存在,提前执行只会更早暴露同一个错误;
 *   - readOnly / concurrentSafe / !destructive:执行语义必须无副作用且可并发;
 *   - !needsApproval / !requiresUserInteraction:提前执行无法弹出审批或交互,
 *     必须等到批次阶段由完整流程处理;
 *   - sideEffectScope === "none":即使标了 readOnly,只要声明存在外部影响也拒绝。
 */
function shouldExecuteToolDuringStream(
  runtime: AgentRuntimeInternal,
  toolCall: ModelToolCall,
): boolean {
  if (toolCall.providerExecuted) return false;
  if (toolCall.name.trim().length === 0) return false;
  if (runtime.config.modelStreaming !== "on") return false;
  if ((runtime.config.streamingToolExecution ?? STREAMING_TOOL_EXECUTION_MODE) === "off") {
    return false;
  }
  const entry = runtime.registry.get(toolCall.name);
  if (!entry) return false;
  const metadata = entry.metadata;
  // permission 级声明优先于 metadata:同一工具在不同会话策略下可能收紧副作用范围,
  // 取更具体的 permission 值才能继承这些收紧。
  const sideEffectScope = entry.permission?.sideEffectScope ?? metadata.sideEffectScope;
  const requiresUserInteraction = entry.requiresUserInteraction ?? metadata.requiresUserInteraction;
  return (
    metadata.readOnly &&
    metadata.concurrentSafe &&
    !metadata.destructive &&
    !metadata.needsApproval &&
    !requiresUserInteraction &&
    sideEffectScope === "none"
  );
}

/**
 * 带超时的等待:超时返回 undefined。用于取消/结算路径,确保慢工具不能无限拖住主流程。
 * 注意它不会取消底层 promise(abort 由调用方传 signal);
 * 超时只是"不再等",底层仍可能在后台跑完,因此调用方不能把 undefined 当成"未执行",
 * 需要按 unknown_execution_state 处理(见 prepareAcceptedToolSettlement)。
 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    // 无论谁先完成都要 clearTimeout:否则每个超时分支都会留下一个悬挂的定时器,
    // 在长会话里累积成"幽灵"句柄(也会让进程无法正常退出)。
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * 收集已完成结果:每个 handle 都带超时,失败视为未完成;
 * 只返回真实结果,未完成的由调用方补 synthetic 终态。
 *
 * 这些 handle 是并行的,所以外层 Promise.all 的总等待上限仍是单次 250ms,
 * 不是 N×250ms。catch(() => undefined) 把提前执行的异常降级为"未完成":
 * 异常信息已经由 accept 的 warn 记录过,这里不需要重复上报。
 */
async function collectCompletedResults(
  handles: Map<string, Promise<StreamedToolExecutionResult | undefined>>,
  toolCalls: readonly ModelToolCall[],
): Promise<StreamedToolExecutionResult[]> {
  const settled = await Promise.all(
    toolCalls.map((toolCall) => {
      const handle = handles.get(toolCall.id);
      if (!handle) return undefined;
      return raceWithTimeout(
        handle.catch(() => undefined),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
    }),
  );
  return settled.filter((result): result is StreamedToolExecutionResult => result !== undefined);
}
