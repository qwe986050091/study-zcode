// bots/groupAdminAttention.ts — 群内“需要管理员处理”的提醒去重与错误类型。
//
// INV-01 只对服务明确识别的配置/连接错误升级，不扫描模型输出猜测待办；
//        误报会把普通回复变成管理员打扰。
// INV-02 去重键 = [botId, chatId, threadId, owner] + reason；重启后允许重新
//        提醒（内存态，不持久化）。
// INV-03 clear 不带 reason 时跳过 permission:/plan: 前缀，避免清理操作顺带
//        解除安全相关提醒的去重。
// [资源] sent 上限 1000，超限按插入顺序淘汰最旧项，防止长驻进程无限增长。
import type { BotActor, BotOutboundMessage } from "@zcode/shared";

/** 仅由服务明确识别的配置/连接错误升级，不能扫描模型输出猜测管理员待办。 */
export class BotAdminRequiredError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    // 保留 reason 供上层区分是配置错误还是连接错误。
    super(message);
  }
}

/** 保留准备阶段的结构化提示，避免话题续接把收件人丢成纯文本。 */
export class BotReplyError extends Error {
  constructor(public readonly replies: BotOutboundMessage[]) {
    // 文本仅作 Error.message 摘要；结构化 replies 才是恢复收件人的依据。
    super(replies.map((reply) => reply.text).join("\n"));
  }
}

/** 通知去重不参与任务接收、授权或执行；重启后允许重新提醒。 */
export function createGroupAdminAttention() {
  // 只记“已提醒”事实，不存消息内容。
  const sent = new Map<string, true>();
  // [契约] scope 键 = botId + chatId + threadId + owner 的 JSON：同群不同话题各算一条提醒，互不吞并。
  const scope = (actor: BotActor, owner: string) =>
    JSON.stringify([actor.botId, actor.chatId, actor.threadId, owner]);
  return {
      // 返回收件人列表；返回 [] 表示“已提醒过，本次静默”。
    mention(actor: BotActor, owner: string | undefined, reason: string): string[] | undefined {
      if (actor.chatType !== "group" || !actor.chatId || !owner) return undefined;
      const key = `${scope(actor, owner)}:${reason}`;
      // 重复提醒直接吞掉，不返回 undefined（后者语义是“不适用提醒”）。
      if (sent.has(key)) return [];
      sent.set(key, true);
      // Map 保持插入序，淘汰最旧键即可近似 LRU。
      if (sent.size > 1000) sent.delete(sent.keys().next().value!);
      return [owner];
    },
      // 不传 actor 视为全量清理；传 actor 必须同时给 owner 才会执行。
    clear(actor?: BotActor, owner?: string, reason?: string) {
      if (!actor) {
        sent.clear();
        return;
      }
      if (!owner) return;
      const prefix = `${scope(actor, owner)}:`;
      for (const key of sent.keys()) {
        if (
          reason
            ? key === `${prefix}${reason}`
            : key.startsWith(prefix) &&
              !key.slice(prefix.length).startsWith("permission:") &&
              !key.slice(prefix.length).startsWith("plan:")
        )
          sent.delete(key);
      }
    },
  };
}
