import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { applySubmissionExecutionState, sameModelSelection } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * 在合法的 model-step 边界最多消费一条 guide，并准备下一次 provider request。
 * SendMessage 可能在 child 的 model request 进行中到达；若该 step 正常
 * text-only 收口，等待未来 tool batch 会把 coordinator input 永久留在无人唤醒的 queue。
 *
 * 返回 true 表示已消费 guide,主循环应继续(request 会带上这条 user-role 输入);
 * false 表示没有可消费的 guide,调用方可以结束 turn。
 *
 * 注意:
 *   - 执行模型被固定(selectionScope="execution")时,guide 只能应用权限/Plan 意图,
 *     不能借 guide 切模(但仍会更新 queryId 与 denylist);
 *   - 若 guide 导致模型选择变化,必须重建 context prefix,保证 provider 看到
 *     与新模型能力匹配的系统前缀。
 */
export async function drainInlineGuideForNextRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  const activeTurn = state.activeTurn;
  if (!activeTurn || !runtime.hasInlineGuidePendingInput(activeTurn)) return false;

  const drained = await runtime.drainPendingInput({
    activeTurn,
    events: state.events,
    traceContext: state.turnTraceContext,
  });
  if (!drained || drained.pendingInputIds.length === 0) return false;

  state.drainedSteerForNextRequest = drained;
  appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries ?? []);
  // 固定执行模型只禁止切模，不应连带丢弃 Guide 的权限／Plan 意图。
  if (state.modelSelectionScope === "execution" && drained.intent) {
    await applyRuntimeExecutionState(runtime, drained.intent, {
      source: "command",
      traceContext: state.turnTraceContext,
    });
  }
  const guideModel =
    state.modelSelectionScope === "execution"
      ? undefined
      : await applySubmissionExecutionState(runtime, drained?.intent, state.turnTraceContext);
  if (guideModel) {
    // 配置重新解析不等于切模；比较 Loop 的执行选择，而不是可能已被外部更新的 Session。
    const selectionChanged = !sameModelSelection(state.model, guideModel);
    state.model = guideModel;
    if (selectionChanged) {
      state.turnRequestState.entries = rebuildContextPrefix(runtime, {
        model: guideModel,
        turnRequestEntries: state.turnRequestState.entries,
      });
    }
  }
  state.currentUserMessageId = drained?.latestMessageId ?? state.currentUserMessageId;
  const nextQueryId = drained?.queryIds?.[0];
  if (nextQueryId) {
    // guide 以 user role 续上当前 active turn；后续请求归因到该输入的 query。
    state.turnTraceContext = { ...state.turnTraceContext, queryId: nextQueryId };
  }
  if ((drained.toolDisallowlist?.length ?? 0) > 0) {
    // automation guide 不会重新 start turn，必须把限制合并到当前 loop state。
    state.toolDisallowlist = [
      ...new Set([...(state.toolDisallowlist ?? []), ...(drained.toolDisallowlist ?? [])]),
    ];
  }
  state.repeatedToolCallSignature = undefined;
  state.repeatedToolCallStreakCount = 0;
  return true;
}
