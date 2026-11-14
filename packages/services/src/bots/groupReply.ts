// bots/groupReply.ts — 回复锚点失效时的有限降级。
//
// 话题消息的锚点链是 replyToMessageId → rootMessageId：
// - 非话题场景只清空 replyToMessageId，消息仍会发到 chat，避免整条丢失。
// - 话题场景只在“当前锚点不是 root”时降级到 root；root 本身失效时返回 null，
//   由调用方显式报告失败，禁止重试同一失效锚点。
// 返回 null 表示“无可用降级”，不是“无需发送”。
import type { BotOutboundMessage } from "@zcode/shared";

type ReplyTarget = Pick<BotOutboundMessage, "replyToMessageId" | "threadId" | "rootMessageId">;

/** 明确拒绝后的有限降级；话题不能误发到群主聊天，也不能重试同一失效锚点。 */
export function getUnavailableReplyFallback(target: ReplyTarget): ReplyTarget | null {
  const current = target.replyToMessageId || (target.threadId ? target.rootMessageId : undefined);
  if (!current) return null;
  if (!target.threadId) return { ...target, replyToMessageId: undefined };
  if (!target.rootMessageId || current === target.rootMessageId) return null;
  return { ...target, replyToMessageId: target.rootMessageId };
}
