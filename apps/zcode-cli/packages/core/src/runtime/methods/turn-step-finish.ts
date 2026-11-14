/**
 * turn-step-finish.ts —— 工具批次结束后为本次 assistant 消息收尾
 *
 * 工具执行不同于"纯文本收口":assistant 已经带着 tool_call 提交过,
 * 这里只需要补一条 step-finish part 和 assistant 的 completed/finish/tokens 元数据,
 * 让持久化记录知道"这一步正常结束",而不用再提交一次正文。
 */
import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * 写入 step-finish part 并更新 assistant 消息完成态。
 * tokens 使用本次模型调用的 usage;cost 固定 0(费用由 usage 统计侧计算,不在消息里重复记账)。
 * 前置条件：state 已完成模型调用且 assistant 消息已带 tool_call 提交，这里只补收尾元数据；
 * 若 state.model 缺失则抛错，说明调用方在无模型上下文中误走了工具批次收尾。
 * 两次 persist 都携带 modelTraceContext，保证 part 与 message 落在同一条 trace 链上。
 * 失败直接向上抛，不做部分回滚；重复调用会追加多个 step-finish，调用点需保证只调一次。
 */
export async function persistToolModelStepFinish(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<void> {
  const model = state.model;
  // 无 model 说明当前不是模型驱动的轮次，继续写入会产生缺 tokens/cost 口径错误的记录。
  if (!model) {
    throw new Error("Model-backed turn step finish requires the loop Model");
  }
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: toTokenUsageInfo(options.result.usage),
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      tokens: toTokenUsageInfo(options.result.usage),
    },
    options.modelTraceContext,
    model,
  );
}
