// INV-01 三个上限同时生效：守住位置 三个常量与两处判定；改错故障 提交信息被上下文撑爆。
// INV-02 从最新消息往前收集：守住位置 逆序循环；改错故障 只有早期闲聊进入上下文。
// INV-03 选中后恢复正序：守住位置 reverse；改错故障 模型看到的对话顺序倒置。
// INV-04 首条不参与总长判定：守住位置 selectedMessages.length > 0；改错故障 长消息永远选不中，结果为 null。
// INV-05 总长按字符加角色开销估算：守住位置 nextCost 的加八；改错故障 预算低估导致超限。
// INV-06 单条超长截断并留标记：守住位置 clipConversationText；改错故障 一条长消息占满全部预算。
// INV-07 截断保留头部而非尾部：守住位置 减去三十后的 slice；改错故障 用户看不到请求的开头。
// INV-08 时间线消息不参与：守住位置 syntheticTimeline 与 uiTimeline 判空；改错故障 合成内容被当成用户原话。
// INV-09 三级内容回退：守住位置 content、parts、mailboxMessage 顺序；改错故障 兼容旧结构时丢正文。
// INV-10 parts 只取 content 类型：守住位置 type 过滤；改错故障 工具片段混入提交上下文。
// INV-11 空白归一后再判空：守住位置 normalizeConversationText；改错故障 纯空白消息被当成有效内容。
// INV-12 归一保留段落：守住位置 三个空行折成两个；改错故障 代码块间距被压平。
// INV-13 sessionId 为空则整体省略：守住位置 trim 与条件展开；改错故障 下游收到空字符串身份。
// INV-14 无有效消息返回 null：守住位置 末尾判空；改错故障 生成器拿到空上下文仍继续请求。
//
// 模块职责：把会话消息裁剪成提交信息生成可用的有限上下文。
// 阅读顺序：先看上限常量与逆序收集，再看单条截断与总长预算，最后看内容来源回退与文本归一。
import type { GitCommitMessageConversationContext } from "@zcode/shared";

const MAX_COMMIT_CONVERSATION_MESSAGES = 12;
const MAX_COMMIT_CONVERSATION_MESSAGE_CHARS = 600;
// 总预算是硬上限，单条上限不能突破它。
const MAX_COMMIT_CONVERSATION_TOTAL_CHARS = 4_000;

interface GitCommitConversationMessageSource {
  role: "user" | "assistant";
  content?: string | null;
  mailboxMessage?: { content?: string | null } | null;
  parts?: readonly { type: string; content?: string | null }[] | null;
  syntheticTimeline?: unknown;
  uiTimeline?: unknown;
}

export function buildGitCommitMessageConversationContext(params: {
  sessionId?: string | null;
  messages: readonly GitCommitConversationMessageSource[];
}): GitCommitMessageConversationContext | null {
  // 先统一成 role 与 content 二元组，后续只处理纯文本。
  const normalizedMessages = params.messages
    .map((message) => {
      const content = readVisibleConversationMessageContent(message);
      return content ? { role: message.role, content } : null;
    })
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      Boolean(message),
    );

  const selectedMessages: GitCommitMessageConversationContext["messages"] = [];
  // 预算随选中条数累加，用于提前终止。
  let totalChars = 0;

  for (
    // 从最后一条开始，保证最近对话优先入选。
    let index = normalizedMessages.length - 1;
    index >= 0 && selectedMessages.length < MAX_COMMIT_CONVERSATION_MESSAGES;
    index -= 1
  ) {
    const message = normalizedMessages[index];
    if (!message) {
      continue;
    }

    // 单条先截断，再计入总预算。
    const content = clipConversationText(
      message.content,
      MAX_COMMIT_CONVERSATION_MESSAGE_CHARS,
    );
    // 角色名与包裹开销按八字符估算。
    const nextCost = content.length + message.role.length + 8;
    if (
      // 至少保留一条，否则上下文永远为空。
      selectedMessages.length > 0 &&
      totalChars + nextCost > MAX_COMMIT_CONVERSATION_TOTAL_CHARS
    ) {
      break;
    }

    // 只有通过预算判定才入列。
    selectedMessages.push({ role: message.role, content });
    totalChars += nextCost;
  }

  if (selectedMessages.length === 0) {
    return null;
  }

  // 逆序收集后必须还原成时间正序。
  selectedMessages.reverse();
  // 空白 sessionId 视同未提供。
  const sessionId = params.sessionId?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    omittedMessageCount: Math.max(0, normalizedMessages.length - selectedMessages.length),
    messages: selectedMessages,
  };
}

function readVisibleConversationMessageContent(
  message: GitCommitConversationMessageSource,
): string {
  // 带时间线的消息是渲染产物，不作为原文。
  if (message.syntheticTimeline || message.uiTimeline) {
    return "";
  }

  const directContent = normalizeConversationText(message.content ?? "");
  if (directContent) {
    return directContent;
  }

  const partContent = normalizeConversationText(
    (message.parts ?? [])
      // 只接受字符串正文，排除工具与附件片段。
      .filter((part) => part.type === "content" && typeof part.content === "string")
      .map((part) => part.content)
      .join("\n"),
  );
  if (partContent) {
    return partContent;
  }

  return normalizeConversationText(message.mailboxMessage?.content ?? "");
}

function normalizeConversationText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    // 连续空行折成一个空行：`normalizeConversationText` 要保留段落语义，同时不让模型上下文被空白撑大。
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipConversationText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 30)).trimEnd()}\n...message truncated...`;
}
