// bots/groupSessions.ts — Bot 会话键与群内权限判定。
//
// INV-01 群身份键 = [botId, chatId] 或 [botId, chatId, conversationThreadId]；
//        不能用发送者 actorId 代替，否则同一群内不同用户会各自创建任务。
// INV-02 私聊键就是 botId；群聊缺 chatId 时直接抛错，不能静默落到私聊键。
// INV-03 旧数据没有 conversationThreadId 时回落到 threadId，保持历史键不变。
import type { BotActor, BotContextState } from "@zcode/shared";

/** 群身份不能用发送者代替，否则多人会串到私聊或各自创建任务。 */
export function getBotConversationKey(
  actor: Pick<BotActor, "botId" | "chatType" | "chatId" | "threadId" | "conversationThreadId">,
): string {
  // 私聊不区分 thread；一个 bot 对一个人只有一个会话键。
  if (actor.chatType === "private") return actor.botId;
  const chatId = actor.chatId?.trim();
  // 缺 chatId 属于调用方装配错误，抛错比落到私聊键更安全。
  if (!chatId) throw new Error("Group chat ID is required");
  // 旧默认群键保持不变；话题必须进入独立键，不能覆盖群默认任务。
  const threadId = (
    actor.conversationThreadId !== undefined ? actor.conversationThreadId : actor.threadId
  )?.trim();
  return JSON.stringify(threadId ? [actor.botId, chatId, threadId] : [actor.botId, chatId]);
}

export function getBotStateKey(context: BotContextState): string {
  return getBotConversationKey({
    botId: context.botId,
    chatType: context.group ? "group" : "private",
    chatId: context.group?.chatId,
    threadId: context.group?.threadId,
  });
}

// 白名单式判定：只有明确列出的只读/应答命令不要求群主权限。
export function isGroupOwnerCommand(command: string): boolean {
  return !["help", "status", "message", "answer"].includes(command);
}

export function canAnswerGroupQuestion(
  actorId: string,
  ownerId: string,
  initiatorId: string | undefined,
  isPlan: boolean,
): boolean {
  // plan 模式只允许 owner 回答；非 plan 允许发起人继续补充答案。
  return actorId === ownerId || (!isPlan && actorId === initiatorId);
}
