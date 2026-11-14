// 助手消息反馈组：setAssistantFeedback（赞/踩）。
// 只接受指向 assistantText 行的 target；行→messageId 的翻译必须由 core 完成，
// 命令层不做文本/序号猜测。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

/**
 * setAssistantFeedback：对一条助手消息写入反馈。
 * 输入：target（entityId/rowId）+ feedback；rowId 经 host.resolveRowActionTarget
 * 翻译成 messageId，且必须是 assistantText 行——翻译失败或行类型不符直接拒绝，
 * 不用最近消息兜底。
 * 副作用：host.setAssistantFeedback 持久化反馈并推进投影；ACK 只表示「已接纳」。
 * 失败：宿主未注入 → assistantFeedbackUnsupported；持久化异常原样上抛（不伪造成功）。
 * 幂等：同一 target 重复提交是覆盖写，天然幂等；由 commandId 保证不重复执行。
 */
async function setAssistantFeedback(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAssistantFeedback"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "setAssistantFeedback",
  );
  if (!resolution?.ok || !resolution.messageId || resolution.row.kind !== "assistantText") {
    throw new V4RowTranslationError("setAssistantFeedback", payload.target.rowId);
  }
  if (!host.setAssistantFeedback) {
    throw new Error("fault.command.assistantFeedbackUnsupported");
  }
  await host.setAssistantFeedback(record.app.sessionId, {
    entityId: payload.target.entityId,
    messageId: resolution.messageId,
    feedback: payload.feedback,
  });
  return undefined;
}

/** 本组原生命令注册表（助手消息反馈），供 handlers/index.ts 合并。 */
export const assistantFeedbackHandlers = { setAssistantFeedback };
