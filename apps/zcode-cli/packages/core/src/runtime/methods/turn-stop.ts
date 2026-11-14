/**
 * ============================================================================
 * turn-stop.ts —— "没有工具调用"时的收口与 assistant 持久化
 * ============================================================================
 *
 * 【调用链】
 *   turn-model-step.ts
 *     ├─ persistCompletedAssistantStep      ← 输出续写/收尾时把 assistant 写入历史
 *     └─ finishModelStepWithoutToolCalls    ← 没有可执行工具时决定"继续"还是"结束"
 *
 * 【为什么需要 anchor】
 *   在 assistant 消息真正提交前,流式 part/审批等已经可能写入 session store。
 *   captureAssistantPersistenceAnchor 在 model step 开始时记录三个"最新指针",
 *   如果最终没有可提交内容,必须把指针回滚,避免把半成品当成最新对话。
 *
 * 【finishModelStepWithoutToolCalls 的三个出口】
 *   automation 上限        → 纯文本收口,直接 break;
 *   guide 可续跑           → 注入 user-role continuation,继续同一 turn;
 *   Stop hook 要求继续     → 注入 hook 上下文,继续同一 turn;
 *   否则                   → 标记稳定边界并 break,由 turn.ts 发 TurnComplete。
 * ============================================================================
 */
import { HookEventName, TurnMachineImpl, createMessageId, createPartId } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
} from "./turn-output-token-continuation.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";

export interface AssistantPersistenceAnchor {
  latestAssistantMessageId: AgentRuntimeInternal["latestAssistantMessageId"];
  latestAssistantTurnId: AgentRuntimeInternal["latestAssistantTurnId"];
  latestConversationMessageId: AgentRuntimeInternal["latestConversationMessageId"];
}

/**
 * 记录 assistant 提交前的三个最新指针快照。
 * 若最终没有任何 assistant 内容可提交,persistCompletedAssistantStep 会用它们回滚。
 */
export function captureAssistantPersistenceAnchor(
  runtime: AgentRuntimeInternal,
): AssistantPersistenceAnchor {
  return {
    latestAssistantMessageId: runtime.latestAssistantMessageId,
    latestAssistantTurnId: runtime.latestAssistantTurnId,
    latestConversationMessageId: runtime.latestConversationMessageId,
  };
}

/**
 * 把一个已完成的 assistant step 提交到 canonical history 与 session store。
 *
 * 返回 false 表示没有任何可提交内容:
 *   - 删除之前落盘的 assistant 占位消息;
 *   - 把 latestConversationMessageId / latestAssistantMessageId 回滚到 anchor;
 *   - 不写 step-finish,避免在历史里留下空壳。
 *
 * includeEmptyAssistant=true 用于"正常收尾"场景:即使模型只返回空文本,
 * 也要留下一条 assistant 结束标记(例如纯推理响应)。
 */
export async function persistCompletedAssistantStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    includeEmptyAssistant: boolean;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<boolean> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed assistant persistence requires the loop Model");
  }
  // 提交 assistant:
  //   commitAssistantToTurnRequest 只在有文本/推理/工具调用时返回 true;
  //   正常收尾(includeEmptyAssistant=true)即使内容为空也要留下结束标记,
  //   否则"模型只返回空文本"会被当成未完成 step。
  let committed = commitAssistantToTurnRequest(runtime, state, options.result, undefined);
  if (!committed && options.includeEmptyAssistant) {
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      createRuntimeAssistantEntry(
        "",
        undefined,
        undefined,
        model,
        toTokenUsageInfo(options.result.usage),
      ),
    ]);
    committed = true;
  }
  if (!committed) {
    // 回滚:删除已落盘的 assistant 占位消息,并把三个"最新指针"恢复到 anchor,
    // 防止空壳消息成为后续 compact/fork 的边界。
    // 维护不变量#7:latest 指针与 durable 消息必须一致;空消息删除后指针必须回退,
    // 否则冷恢复会从一个已不存在的消息开始投影。
    if (runtime.sessionStore) {
      await runtime.sessionStore.removeMessage({
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
      });
    }
    if (runtime.latestConversationMessageId === options.assistantMessageId) {
      runtime.latestConversationMessageId =
        options.assistantPersistenceAnchor.latestConversationMessageId;
    }
    if (runtime.latestAssistantMessageId === options.assistantMessageId) {
      runtime.latestAssistantMessageId =
        options.assistantPersistenceAnchor.latestAssistantMessageId;
      runtime.latestAssistantTurnId = options.assistantPersistenceAnchor.latestAssistantTurnId;
    }
    return false;
  }
  const persistedTokens = toTokenUsageInfo(options.result.usage);
  // 提交成功后补 step-finish part(记录 finishReason 与 usage),
  // 再更新 assistant 消息的 completed/finish/tokens 元数据。
  // 失败处理:persistPart 失败会抛出;assistant 已提交(committed=true),
  // 抛出后调用方 catch 收口,不会留下无 step-finish 的 assistant(冷恢复按 partial 处理)。
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
  );
  // 终态元数据写入:completed/finish/tokens 是 assistant 消息的收口事实;
  // 必须在 step-finish part 之后写,保证"先有 part 再有消息终态"的持久化顺序。
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
    model,
  );
  return committed;
}

/**
 * 输出预算耗尽时,单独落一条"错误载体"assistant 消息(不含正文)。
 * 与 partial 内容拆成独立消息,保证 Compact 能重放 partial 同时排除这条错误轨迹。
 */
export async function persistOutputTokenLimitErrorCarrier(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    error: { data: Record<string, unknown>; name: string };
    finishReason: string;
    model: Model;
    modelTraceContext: TraceContext;
  },
): Promise<void> {
  const messageId = createMessageId();
  const createdAt = Date.now();
  const tokens = emptyTokenUsageInfo();

  // partial 与终态 error 共用 durable assistant 时，Compact 无法同时重放
  // provider partial 并排除 transcript-only error。两者拆成独立消息后沿用既有过滤边界即可。
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    undefined,
    options.modelTraceContext,
    options.model,
  );
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: options.finishReason,
      cost: 0,
      tokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    {
      completed: Date.now(),
      error: options.error,
      finish: options.finishReason,
      tokens,
    },
    options.modelTraceContext,
    options.model,
  );
}

/**
 * 模型步没有可执行工具时的收口:
 *   1) 提交 assistant(允许空文本);
 *   2) automation 上限 → 不再续跑,直接 break;
 *   3) 有可消费的 guide → 以 user-role continuation 继续同一 turn;
 *   4) Stop hook 要求继续 → 注入 hook 上下文,继续同一 turn;
 *   5) 否则 → 标记稳定边界并 break,交给 turn.ts 发 TurnComplete。
 */
export async function finishModelStepWithoutToolCalls(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<"continue" | "break"> {
  if (!state.model) {
    throw new Error("Model-backed turn stop requires the loop Model");
  }
  const assistantCommitted = await persistCompletedAssistantStep(this, state, {
    ...options,
    includeEmptyAssistant: true,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (state.automationCreateLimitReached) {
    // 上限命中后只允许这一轮纯文本说明。跳过 guide 和 Stop hook，避免它们再次
    // 触发模型请求，把已经关闭工具的 turn 延长成新的恢复循环。
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
      state.activeTurn.steerable = false;
    }
    state.stableProductStartMessageId = state.currentUserMessageId;
    state.stableBoundaryAssistantMessageId = options.assistantMessageId;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }
  if (await drainInlineGuideForNextRequest(this, state)) {
    // 正常 text-only 是可续跑边界：assistant 已持久化，guide 以 user role 进入历史，
    // 保持同一 active turn 继续下一次 provider request，不改投 future queue。
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  const stopHookResult = await this.runStopHooks(
    state.modelResponse,
    state.toolCallCount,
    state.turnTraceContext,
    state.turnAbortSignal,
    state.stopHookContinuationCount > 0,
  );
  if (this.shouldContinueAfterStopHooks(stopHookResult, state.stopHookContinuationCount)) {
    state.stopHookContinuationCount += 1;
    const hookEntry = this.injectHookAdditionalContextIntoMessageHistory(
      HookEventName.Stop,
      stopHookResult.additionalContexts,
    );
    appendTurnRequestEntries(state.turnRequestState, hookEntry ? [hookEntry] : []);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  if (state.activeTurn) {
    // FIFO barrier / reservation 阻止本轮安全 inline 时，仍保留既有权威 queue 兜底；
    // 正常可消费的 text-only guide 已在上方作为 user-role continuation drain。
    await this.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
  }
  if (state.activeTurn) state.activeTurn.steerable = false;
  // assistant completed 只代表 model step 收口；Stop hook 仍可能继续同一 product turn。
  // 只有最终 break 才把它交给 turn.ts 在 goal accounting 后持久化最终 boundary。
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = options.assistantMessageId;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
  return "break";
}
