// bots/topicHistory.ts — 读取话题历史窗口，产出不可变背景批次。
//
// INV-01 只准备背景，不推进检查点；checkpoint 推进必须等 CLI admission 确认。
// INV-02 首次 @ 根消息也要调用 list() 触发平台权限校验，不能因无历史而跳过。
// INV-03 边界消息（本次 @）之前的内容一律不读；边界找不到即失败。
// INV-04 扫描上限：8 页 / 200 条，超出标记 hasGap，绝不静默截断。
// INV-05 卡片与 Bot 确认回复不算讨论材料，但扫描仍保留边界，避免破坏检查点。
import type { BotTopicHistoryBatch, BotTopicHistoryRequest, BotTopicMessage } from "@zcode/shared";

/** 区分权限拒绝和临时网络错误，避免错误引导用户授权。 */
// 权限拒绝是独立错误类型，上层据此提示授权而不是重试。
export class TopicHistoryPermissionError extends Error {}

interface TopicHistoryReader {
  /** 原生 thread 容器按创建时间倒序分页；接口不支持时间过滤。 */
  list(page?: string): Promise<{ messages: BotTopicMessage[]; next?: string }>;
  get(messageId: string): Promise<BotTopicMessage>;
  hydrate?(message: BotTopicMessage): Promise<BotTopicMessage>;
}

/** 只准备不可变背景，不推进检查点；推进必须等到 CLI admission 确认。 */
export async function readTopicHistory(
  request: BotTopicHistoryRequest,
  reader: TopicHistoryReader,
): Promise<BotTopicHistoryBatch> {
  // 根消息首次 @ 也必须访问原生历史接口，不能因没有旧消息而跳过权限校验。
  // 首次 @ 根消息：只做权限探测，返回空批次（见 INV-02）。
  if (request.messageId === request.rootMessageId && !request.checkpoint) {
    await reader.list();
    return { messages: [], checkpoint: request.messageId, hasGap: false };
  }
  // 分页窗口可能重叠，必须用 seen 按 id 去重后再拼接。
  const seen = new Set<string>();
  const messages: BotTopicMessage[] = [];
  let boundaryFound = false;
  // request.checkpoint 缺失时 checkpointFound 直接为 true，表示不限下界。
  let checkpointFound = !request.checkpoint;
  let hasGap = false;
  let page: string | undefined;
  let examined = 0;
  let finished = false;
  // 每条消息必须属于请求的 chat/thread，防止跨话题串读。
  const validate = (message: BotTopicMessage) => {
    if (message.chatId !== request.chatId || message.threadId !== request.threadId)
      throw new Error("Topic history scope mismatch");
  };
  // 有限页数也限制本次 @ 之后大量新消息的扫描，避免热话题一直追不上边界。
  // 页数上限见 INV-04。
  for (let pages = 0; pages < 8 && !finished; pages += 1) {
    const batch = await reader.list(page);
    for (const message of batch.messages) {
      validate(message);
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      // 边界之前的内容不回填，只用于定位起点。
      if (!boundaryFound) {
        if (message.id === request.messageId) boundaryFound = true;
        continue;
      }
      // 到达检查点即完成窗口，停止扫描。
      if (message.id === request.checkpoint) {
        checkpointFound = true;
        finished = true;
        break;
      }
      // 条数上限；命中即标记缺口并结束。
      if (examined >= 200) {
        hasGap = true;
        finished = true;
        break;
      }
      examined += 1;
      // 删除消息造成空洞，必须如实标记。
      if (message.deleted) hasGap = true;
      if (!message.deleted && message.id !== request.rootMessageId) messages.push(message);
    }
    // 没有下一页说明历史读到尽头。
    if (!batch.next) finished = true;
    else if (!finished) page = batch.next;
  }
  // 找不到边界说明分页异常或消息已删除，不能猜测。
  if (!boundaryFound) throw new Error("Topic history invocation boundary unavailable");
  if (!finished || !checkpointFound) hasGap = true;
  // 平台倒序返回，这里翻转为正序。
  messages.reverse();
  // 无检查点时补读根消息，作为话题起点。
  if (!request.checkpoint) {
    const root = await reader.get(request.rootMessageId);
    validate(root);
    if (root.deleted) hasGap = true;
    else if (root.id !== request.messageId) messages.unshift(root);
  }
  // 历史窗口外和删除卡片不能因正文读取失败阻断本轮输入；先筛选再读取必要材料。
  // hydrate 只处理已选中的消息，避免为窗口外内容付出读取成本。
  if (reader.hydrate) {
    // 并行补全正文；顺序由 Promise.all 保证与入参一致。
    const hydrated = await Promise.all(messages.map((message) => reader.hydrate!(message)));
    messages.splice(0, messages.length, ...hydrated);
  }
  // 卡片正文和机器人确认回复不是讨论材料；扫描仍保留原生边界，避免破坏检查点。
  // app 发送者视为 Bot 自身。
  const isBot = (message: BotTopicMessage) => message.senderType === "app";
  // 先收集控制卡片 id 到 cards，再把它们的父引用一并加入过滤集合。
  const cards = new Set(
    messages
      .filter((message) => isBot(message) && message.controlCard === true)
      .map((message) => message.id),
  );
  return {
    // 过滤卡片本身与其直接回复，见 INV-05。
    messages: messages.filter(
      (message) =>
        !cards.has(message.id) &&
        !(isBot(message) && message.parentId && cards.has(message.parentId)),
    ),
    checkpoint: request.messageId,
    hasGap,
  };
}
