/**
 * ============================================================================
 * runtime/methods/cancelled-stream-persistence.ts —— 取消时"半成品"落盘
 * ============================================================================
 *
 * 成功路径在流结束后统一提交 text/reasoning;用户 Stop 时模型请求以异常退出,
 * 那条路径不会执行。这里负责把"已经到达本进程"的内容补写进消息,
 * 让 transcript/冷恢复看到"用户看到过的那半截",而不是一条空 assistant。
 *
 * 【边界】只 flush text/reasoning:
 *   - 工具 part 由 sink/settlement 各自负责终态,不能在这里重复写;
 *   - 每个 reasoning block 单独成 part,text 合并成一个 part(与正常路径的粒度一致)。
 * 时间统一用 completedAt 作为 end:半成品的精确结束时刻不可知,
 * 取"落盘时刻"是唯一稳定且单调的选择。
 * ============================================================================
 */
import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  const completedAt = Date.now();
  for (const reasoning of options.snapshot.reasoning) {
    // 空 reasoning(只有 providerOptions 无文本)不落 part:
    // 与正常提交的判定保持一致,否则 transcript 里会出现一堆空的思考块。
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        // providerOptions 原样保存:恢复/重放时某些 provider 需要
        // signature/redacted 等信息,丢掉会让历史无法再次发送。
        metadata: reasoning.providerOptions,
        time: {
          start: options.assistantCreatedAt,
          end: completedAt,
        },
      },
      options.traceContext,
    );
  }
  if (!options.snapshot.text) {
    // 没有文本就不要写空 text part:空 part 会让 UI 渲染一个空回复框,
    // 也会让"这条 assistant 到底有没有内容"的判断失真。
    return;
  }
  // 文本合并成一个 part（与成功路径的粒度一致）：按块拆分会让 part 数量/顺序
  // 与 live 结构不同，冷恢复后的投影对不上"用户当时看到的半截回复"。
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "text",
      text: options.snapshot.text,
      time: {
        start: options.assistantCreatedAt,
        end: completedAt,
      },
    },
    options.traceContext,
  );
}
