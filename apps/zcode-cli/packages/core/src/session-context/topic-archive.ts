// INV-01 检索范围只来自可信输入：守住位置 conversationInputIntent 读取；改错故障 从消息正文里捞档案。
// INV-02 新协议优先：守住位置 Object.hasOwn 判断；改错故障 旧字段覆盖新记录。
// INV-03 schema 校验后才采信：守住位置 safeParse；改错故障 脏数据进入检索集合。
// INV-04 只收用户消息：守住位置 role / synthetic 过滤；改错故障 助手自述被当历史证据。
// INV-05 作用域取最后一条：守住位置 sources.at(-1)；改错故障 跨群/跨话题串档。
// INV-06 同作用域才参与：守住位置 botId/chatId/threadId 三段比较；改错故障 别的会话记录混入。
// INV-07 按 id 去重：守住位置 Map.set(record.id)；改错故障 重复档案重复计数。
// INV-08 缺口语义向上传递：守住位置 hasGap 累积；改错故障 结果谎称历史完整。
// INV-09 匹配支持 id 精确命中：守住位置 record.id === query.query；改错故障 按 id 查不到。
// INV-10 预算双重封顶：守住位置 Math.min(maxTokens, 12000)；改错故障 调用方传大值撑爆上下文。
// INV-11 预算下限显式失败：守住位置 256 判断；改错故障 预算过小静默返回空结果。
// INV-12 单条超长保留预览：守住位置 0.8 收缩循环；改错故障 首条就把预算吃光或返回空。
// INV-13 截断三种来源合并：守住位置 hasGap || clipped || next；改错故障 还有剩余却不给游标。
// INV-14 引用只给 messageId：守住位置 references 映射；改错故障 把正文再塞进引用放大载荷。
//
// 模块职责：从会话输入事实里检索已归档的话题原文，按 token 预算分页返回。
// 阅读顺序：先看来源收集与作用域收敛，再看匹配与预算裁剪，最后看返回结构。
import { z } from "zod";
import type {
  MessageWithParts,
  ReadSessionContextInput,
  ReadSessionContextOutput,
} from "@zcode/contracts";
import { estimateTokens } from "../context/utils.js";

const recordSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  threadId: z.string(),
  text: z.string(),
  senderId: z.string(),
  senderType: z.enum(["user", "app"]),
  createdAt: z.number(),
});
const sourceSchema = z.object({
  botId: z.string(),
  chatId: z.string(),
  threadId: z.string(),
  topicContext: z.object({ messages: z.array(recordSchema), hasGap: z.boolean() }),
});

/** 原文只读取 runtime 保存的可信输入事实；消息正文和摘要都不能扩大检索范围。 */
// readTopicArchive 纯读，只消费 runtime 已保存的输入事实。
export function readTopicArchive(
  messages: MessageWithParts[],
  query: ReadSessionContextInput,
): ReadSessionContextOutput {
  const sources = messages.flatMap(({ info }) => {
    // 合成用户消息不是真实输入。
    if (info.role !== "user" || info.synthetic) return [];
    // 新协议只保证 canonical 输入事实；存在时不能回退同条消息的旧字段，避免旧背景覆盖新记录。
    const metadata = info.metadata;
    // 新字段存在时不再回退旧字段。
    const intent =
      metadata && Object.hasOwn(metadata, "conversationInputIntent")
        ? metadata.conversationInputIntent
        : metadata?.inputIntent;
    // sourceSchema.safeParse 失败即丢弃该来源。
    const parsed = sourceSchema.safeParse(
      intent && typeof intent === "object" ? Reflect.get(intent, "botGroupSource") : undefined,
    );
    return parsed.success ? [parsed.data] : [];
  });
  // sources 的最后一项决定本次检索作用域。
  const scope = sources.at(-1);
  // 按 record.id 去重，Map 后写覆盖先写。
  const records = new Map<string, z.infer<typeof recordSchema>>();
  let hasGap = false;
  for (const source of sources) {
    if (
      source.botId !== scope?.botId ||
      source.chatId !== scope.chatId ||
      source.threadId !== scope.threadId
    )
      continue;
    hasGap ||= source.topicContext.hasGap;
    for (const record of source.topicContext.messages) {
      if (
        record.chatId === scope.chatId &&
        record.threadId === scope.threadId &&
        record.senderType === "user"
      )
        records.set(record.id, record);
    }
  }
  // toLocaleLowerCase 归一后匹配，降低地区差异。
  const needle = query.query.toLocaleLowerCase();
  const matches = [...records.values()].filter(
    (record) => record.id === query.query || record.text.toLocaleLowerCase().includes(needle),
  );
  const offset = query.cursor ?? 0;
  // budget 取 query.maxTokens 与硬上限 12000 的较小值。
  const budget = Math.min(query.maxTokens ?? 6000, 12000);
  // 预算过小是调用方错误，显式抛出。
  if (budget < 256) throw new Error("Topic retrieval budget must be at least 256 tokens");
  const selected: typeof matches = [];
  let consumed = 0;
  let clipped = false;
  // 单页最多二十条，控制扫描成本。
  for (const record of matches.slice(offset, offset + 20)) {
    const cost = estimateTokens(JSON.stringify(record));
    // 预留一百 token 余量再判超预算。
    if (consumed + cost > budget - 100) {
      if (selected.length) break;
      // 超长单条保留可辨认的预览并声明截断，不能伪装成完整原文。
      let text = record.text;
      // 逐次收缩正文直到可容纳。
      while (estimateTokens(JSON.stringify({ ...record, text })) > budget - 100 && text.length)
        text = text.slice(0, Math.floor(text.length * 0.8));
      selected.push({ ...record, text });
      clipped = true;
      break;
    }
    selected.push(record);
    consumed += cost;
  }
  // next 游标只推进 selected 的条数。
  const next = offset + selected.length;
  return {
    status: scope ? "success" : "not_found",
    sessionId: query.sessionId,
    strategy: "topic",
    query: query.query,
    source: "local",
    content: JSON.stringify({
      coverage: "Previously archived messages only; unread history is not available.",
      records: selected,
    }),
    messageCount: records.size,
    selectedMessageCount: selected.length,
    truncated: hasGap || clipped || next < matches.length,
    ...(next < matches.length ? { nextCursor: next } : {}),
    references: selected.map((record) => ({ messageId: record.id })),
  };
}
