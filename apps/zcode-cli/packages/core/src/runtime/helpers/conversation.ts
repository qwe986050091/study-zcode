// ============================================================
// conversation —— 会话消息 ↔ runtime 条目 ↔ 模型内容块的转换边界
// ============================================================
//
// 【职责】
//   1) 从 SessionStore 消息计算"最新活跃消息 id"(冷恢复 / 落库指针用);
//   2) 在 request-local 消息数组里定位"真实用户消息"(媒体预算等策略用);
//   3) 把本轮用户输入 + 附件(含粘贴图片 / video / prompt attachment)
//      组装成 provider 可发送的 content 与 runtime 条目。
//
// 【口径与不变量】
//   - latest 指针只能指向"活跃分支上的真实 user/assistant 消息",
//     且必须排除 compact preserved segment(不变量 7):
//     保留区间是压缩前被搬移的旧消息,不能作为冷恢复锚点。
//   - 判断"真实用户消息"优先使用 metadata / provider 传入的 index,
//     文本前缀判定只作兜底,避免用户字面写的 <system-reminder> 被误判成 meta。
//   - 附件顺序有稳定约定:prompt attachment / 普通附件 → video → 粘贴图片,
//     最后才是正文文本;改变顺序会影响 provider 对多模态输入的理解。
//
// 【副作用】
//   均为纯函数:不落盘、不发事件、不修改入参。
// ============================================================
import { activeSessionMessages, modelMessageContentToText } from "../deps.js";
import { buildPromptAttachmentBlocks } from "../../system-reminder/prompt-attachment.js";
import {
  buildUserMessageEntries,
  isPastedInlineImageAttachment,
  promptAttachmentInputForResolvedAttachment,
  isFailedTextAttachmentPlaceholder,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type {
  MessageId,
  MessageWithParts,
  ModelMessageContent,
  ModelMessageContentBlock,
} from "../deps.js";
import type { ResolvedTurnAttachment, RunModelTextRequestOptions } from "../types.js";

/**
 * 计算当前活跃分支上最后一条真实 user/assistant 消息 id。
 *
 * 输入:SessionStore 消息 + revert(branch cut / rewind)参数。
 * 输出:消息 id;没有符合条件的消息时返回 undefined。
 * 语义:activeSessionMessages 显式关闭 includeCompactPreservedSegment,
 *       因为 preserved segment 是压缩边界之前被搬移的旧消息,把它当锚点
 *       会让后续 latest 指针倒退回压缩前(不变量 7)。
 * 副作用:无。失败:不抛错,只返回 undefined。
 */
export function getLatestActiveSessionMessageId(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageId | undefined {
  const activeMessages = activeSessionMessages(messages, {
    ...options,
    includeCompactPreservedSegment: false,
  });

  for (let index = activeMessages.length - 1; index >= 0; index--) {
    const message = activeMessages[index]!;
    if (message.info.role === "user" || message.info.role === "assistant") {
      return message.info.id;
    }
  }

  return undefined;
}

/**
 * 在 request-local 消息数组里找最后一条"真实用户消息"的下标。
 * 输出:-1 表示没找到(调用方需自行降级)。
 * 语义:从后往前找 role=user 且不是 meta user context 的消息;
 *       这是 provider projection 传入 latest-user index 缺失时的兜底。
 * 副作用:无。
 */
export function findLatestRealUserMessageIndex(
  messages: RunModelTextRequestOptions["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    // provider projection 会在剥离 metadata 前传入 latest real user 的 request-local index。
    // 这里仅作为缺失该 index 时的兜底，避免把用户输入的 literal meta tag 当成 runtime meta。
    if (message.role === "user" && !isMetaUserContextMessage(message)) {
      return index;
    }
  }
  return -1;
}

/**
 * 是否是"meta 用户上下文"(runtime 注入的 system-reminder 投影成 user 消息)。
 * 判定只做 trimStart 后的文本前缀检查:该函数仅用于"没有 metadata 时"的兜底,
 * 有 metadata 的路径应该先看 metadata.source。
 * 副作用:无。
 */
export function isMetaUserContextMessage(
  message: RunModelTextRequestOptions["messages"][number],
): boolean {
  return (
    message.role === "user" &&
    modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>")
  );
}

/**
 * 把本轮用户输入 + 已解析附件组装成 ModelMessageContent。
 *
 * 输入:用户文本、ResolvedTurnAttachment 列表。
 * 输出:无附件时原样返回字符串;否则返回结构化 content blocks。
 * 语义(顺序约定):
 *   - 粘贴的内联图片单独收集,放到最后(避免打断正文/附件的既有顺序);
 *   - prompt attachment 走 buildPromptAttachmentBlocks(带提醒文案);
 *   - 失败文本附件占位直接跳过(它本身只是错误提示);
 *   - video 跟随正文之后、粘贴图片之前;
 *   - 正文文本最后 push,保证模型先看到材料再看到请求。
 * 副作用:无。
 * 失败:全部附件都被过滤且无正文时,退回原始 input(可能是空字符串)。
 */
export function buildUserContentFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
): ModelMessageContent {
  if (attachments.length === 0) return input;

  const blocks: ModelMessageContentBlock[] = [];
  // video 跟随正文，避免影响既有非粘贴 image/@file/url 的顺序。
  const videoBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }
    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      blocks.push(...buildPromptAttachmentBlocks(promptAttachmentInput));
      continue;
    }
    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }
    if (attachment.contentBlock.type === "video") {
      videoBlocks.push(attachment.contentBlock);
      continue;
    }
    blocks.push(attachment.contentBlock);
  }

  if (blocks.length === 0 && pastedImageBlocks.length === 0 && videoBlocks.length === 0) {
    return input;
  }

  if (input.length > 0) {
    blocks.push({ type: "text", text: input });
  }
  blocks.push(...videoBlocks, ...pastedImageBlocks);

  return blocks;
}

/**
 * 由本轮输入构造 runtime 用户条目(带 metadata,可直接进 MessageHistory)。
 *
 * 与 buildUserContentFromTurn 的差别:这里额外把"浏览器环境态"包装进正文
 * (formatBrowserAmbientUserInput),并使用 buildUserMessageEntries 生成
 * 与 cold resume 一致的条目结构。
 * 副作用:无;输出为新条目数组。
 */
export function buildRuntimeUserEntriesFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
  options: {
    browserAmbientContext?: { tabCount: number; currentUrl?: string };
  } = {},
): RuntimeMessageEntry[] {
  return buildUserMessageEntries(
    input.length > 0 ? formatBrowserAmbientUserInput(input, options.browserAmbientContext) : input,
    attachments,
  );
}

/**
 * 把"应用内浏览器"的环境态包装进用户输入。
 *
 * 输入:原始文本 + 可选 {tabCount, currentUrl}。
 * 输出:带 <in-app-browser-context source="ambient-ui-state"> 块的文本;
 *       无有效上下文(tabCount 非正整数)时原样返回。
 * 语义:该块明确声明"这是环境态、不是用户请求",防止模型把打开的标签页
 *       当成用户显式指令;正文以 "## My request for ZCode:" 重新起头,
 *       保证请求边界清晰。
 * 副作用:无。
 */
export function formatBrowserAmbientUserInput(
  input: string,
  context?: { tabCount: number; currentUrl?: string },
): string {
  if (!context || !Number.isInteger(context.tabCount) || context.tabCount <= 0) return input;
  const tabLabel = context.tabCount === 1 ? "tab" : "tabs";
  const lines = [
    '<in-app-browser-context source="ambient-ui-state">',
    "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
    "# In app browser:",
    `- The user has the in-app browser open with ${context.tabCount} ${tabLabel}.`,
    ...(context.currentUrl ? [`- Current URL: ${context.currentUrl}`] : []),
    "</in-app-browser-context>",
    "",
    "## My request for ZCode:",
    input,
  ];
  return lines.join("\n");
}
