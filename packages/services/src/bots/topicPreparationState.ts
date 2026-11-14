// bots/topicPreparationState.ts — 话题续接的准备阶段材料暂存。
//
// INV-01 只保存“未提交”的入站材料；提交成功后由调用方 remove，投影里不出
//        已消费消息，避免重试时重复注入上下文。
// INV-02 waitingStop 是 per-key 的阶段位，先于材料授权到达；此期间新增消息
//        必须继承 waitingStop，而不是默认 preparing。
// INV-03 failed 是终态：setWaitingStop 的批量改写必须跳过 failed，否则失败
//        材料会被“复活”成可提交状态。
// [资源] 按 key 惰性建 Map；remove 清空后连带删除 key，防止群会话无限累积。
// [安全] 投影只含文本与 contentParts，不含附件二进制；重试仍走入站授权链。
import type { BotInboundMessage } from "@zcode/shared";

export type TopicPreparationStatus = "preparing" | "waitingStop" | "failed";

/** 仅保留未提交材料；对外投影不包含文件二进制，重试仍由入站授权链处理。 */
export function createTopicPreparationState() {
  // 阶段位与材料分开存放：阶段位是 per-key 的，材料是 per-message 的。
  const waitingStop = new Set<string>();
  const topics = new Map<
    string,
    Map<
      string,
      {
        message: BotInboundMessage;
        status: TopicPreparationStatus;
        error?: string;
      }
    >
  >();
  return {
      // 以 providerMessageId 为幂等键；同一消息重复投递只保留一份材料。
    add(key: string, message: BotInboundMessage) {
      const id = message.actor.providerMessageId;
      // 无平台消息 id 无法去重与重试，直接失败好过写入不可定位的条目。
      if (!id) throw new Error("Topic message identity is missing");
      let entries = topics.get(key);
      if (!entries) {
        entries = new Map();
        topics.set(key, entries);
      }
      // 新消息继承当前阶段位，保证停止确认前后加入的材料语义一致。
      entries.set(id, { message, status: waitingStop.has(key) ? "waitingStop" : "preparing" });
    },
    setWaitingStop(key: string, waiting: boolean) {
      // 停止确认可能先于材料授权完成；保存话题阶段，让稍后加入的消息继承等待状态。
      // 阶段位先落，再回写已有条目；顺序反了会让并发 add 读到旧阶段。
      if (waiting) waitingStop.add(key);
      else waitingStop.delete(key);
      for (const entry of topics.get(key)?.values() ?? []) {
        // failed 不可被阶段位覆盖；失败材料只能通过 retry 显式取回。
        if (entry.status !== "failed") entry.status = waiting ? "waitingStop" : "preparing";
      }
    },
      // 批量更新只影响本 key 下已存在的条目，未知 id 静默忽略。
    update(key: string, ids: string[], status: TopicPreparationStatus, error?: string) {
      for (const id of ids) {
        const entry = topics.get(key)?.get(id);
        if (entry) {
          entry.status = status;
          entry.error = error;
        }
      }
    },
      // 投影保留发送者显示名与文本，供 UI 展示；不泄漏二进制与内部授权信息。
    snapshot(key: string) {
      return [...(topics.get(key)?.entries() ?? [])].map(([messageId, entry]) => ({
        messageId,
        senderName: entry.message.actor.displayName ?? entry.message.actor.providerUserId,
        text: entry.message.text,
        contentParts: entry.message.contentParts,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      }));
    },
      // 只有 failed 才可重试；成功或进行中的条目重复 retry 会重复提交。
    retry(key: string, id: string) {
      const entry = topics.get(key)?.get(id);
      return entry?.status === "failed" ? entry.message : undefined;
    },
      // 提交成功后按 id 删除；条目清空后连带删除 key。
    remove(key: string, ids: string[]) {
      const entries = topics.get(key);
      for (const id of ids) entries?.delete(id);
      if (!entries?.size) topics.delete(key);
    },
      // 全量清理同时复位阶段位，供会话关闭或测试隔离使用。
    clear(key?: string) {
      if (key) {
        topics.delete(key);
        waitingStop.delete(key);
      } else {
        topics.clear();
        waitingStop.clear();
      }
    },
  };
}
