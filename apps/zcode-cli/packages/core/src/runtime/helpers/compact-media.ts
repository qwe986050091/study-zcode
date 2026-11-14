// ============================================================
// compact-media —— compact 摘要请求的媒体降级(把媒体块换成文本占位)
// ============================================================
//
// 【职责】
//   当 compact 的摘要请求被 provider 以"媒体过大"拒绝时,把请求里的
//   image / video / 无正文的 document 块替换成 "[image]" / "[video]" /
//   "[document]" 文本占位,让摘要请求能继续发出。
//   这是 compact 专用的"温和"降级,不复用通用 media budget 文案,
//   避免把预算提示文案污染进 summary 的 provider-visible 内容。
//
// 【输入/输出】
//   输入:已经投影到 provider 的 ModelInputMessage[];
//   输出:替换后的 messages + replacedMediaCount(仅统计被替换的块数,用于日志)。
//   未发生替换的消息原样返回(保持对象身份),发生替换的消息做浅拷贝。
//
// 【副作用】
//   只在调用方显式调用 logCompactMediaRetryProjection 时写 debug 日志;
//   本模块自身不做 I/O、不改历史、不落盘。
//
// 【不变量】
//   - CUA 的 image + image_ref 是原子对:上一块被替换成 raster-unavailable 时,
//     对应的 image_ref 块必须同步替换(见 projectCompactContent 中的配对处理),
//     否则 provider 会看到悬空引用。
// ============================================================
import { traceContextToLogContext } from "../deps.js";
import type {
  Logger,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";

/** 媒体占位投影结果:messages 为可发送副本,replacedMediaCount 用于诊断日志。 */
export interface CompactMediaPlaceholderProjection {
  messages: ModelInputMessage[];
  replacedMediaCount: number;
}

/**
 * 把 compact 摘要请求中的媒体块投影为文本占位。
 *
 * 输入:已经经过 provider 投影的 messages(只做读,不修改入参)。
 * 输出:新 messages 数组 + replacedMediaCount。
 * 语义:只替换"会撑大请求且 provider 已拒绝"的媒体块;纯文本/带正文的
 *       document 保持原样(见 isCompactDocumentMedia)。
 * 副作用:无(纯函数),发生替换的消息做浅拷贝(cacheControl / toolCalls 也复制),
 *       避免调用方后续改动污染原始请求对象。
 * 失败:不抛错;非法块按普通块处理并 clone。
 * 不变量:替换后 CUA image/image_ref 仍保持成对,不留下悬空 image_ref。
 */
export function projectCompactMediaForRetry(
  messages: readonly ModelInputMessage[],
): CompactMediaPlaceholderProjection {
  let replacedMediaCount = 0;
  const projectedMessages = messages.map((message) => {
    const projectedContent = projectCompactContent(message.content);
    replacedMediaCount += projectedContent.replacedMediaCount;
    if (projectedContent.replacedMediaCount === 0) return message;

    return {
      ...message,
      cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
      content: projectedContent.content,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  });

  return {
    messages: projectedMessages,
    replacedMediaCount,
  };
}

/**
 * 记录一次媒体占位投影(debug 级,便于排查"摘要为什么看不到图")。
 * 输入:可选 logger、trace、投影结果。输出:无。副作用:仅日志。
 * replacedMediaCount 为 0 时直接返回,避免每个正常请求都刷一条日志。
 */
export function logCompactMediaRetryProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: CompactMediaPlaceholderProjection,
): void {
  if (projection.replacedMediaCount === 0) return;
  logger?.debug("Compact request media replaced with placeholders", {
    ...traceContextToLogContext(traceContext),
    event: "compact.request.media_placeholder_projection",
    module: "core.runtime",
    replacedMediaCount: projection.replacedMediaCount,
    status: "completed",
  });
}

/**
 * 对单条消息的 content 做媒体替换。
 * 输出:替换后的 content + 本消息内被替换的块数。
 * 非数组 content(纯字符串)直接原样返回。
 * 副作用:无;返回的 blocks 数组是新数组,但未替换的块仍复用 clone 后的对象。
 */
function projectCompactContent(content: ModelMessageContent): {
  content: ModelMessageContent;
  replacedMediaCount: number;
} {
  if (!Array.isArray(content)) {
    return { content, replacedMediaCount: 0 };
  }

  const replacedIndexes = new Set<number>();
  const projectedBlocks = content.map((block, blockIndex) => {
    const projectedBlock = projectCompactBlock(block);
    if (projectedBlock.replaced) replacedIndexes.add(blockIndex);
    return projectedBlock.block;
  });

  const imageRefIndexes = officialCuaImageRefIndexesForUnavailableMedia(content, replacedIndexes);
  for (const imageRefIndex of imageRefIndexes) {
    // CUA 帧是 image + image_ref 的原子对:光栅不可用时,把 raster 换成
    // "不可用"块、image_ref 换成空文本,保证 provider 侧不出现悬空引用。
    projectedBlocks[imageRefIndex - 1] = officialCuaRasterUnavailableBlock();
    projectedBlocks[imageRefIndex] = { type: "text", text: "" };
  }

  return {
    content: replacedIndexes.size > 0 ? projectedBlocks : content,
    replacedMediaCount: replacedIndexes.size,
  };
}

/**
 * 单块级替换:image / video / 无正文 document 换成文本占位,其余 clone 保留。
 * replaced 标记用于统计替换数量并触发 CUA 配对修正。
 */
function projectCompactBlock(block: ModelMessageContentBlock): {
  block: ModelMessageContentBlock;
  replaced: boolean;
} {
  if (block.type === "image") {
    return { block: compactPlaceholderBlock("[image]"), replaced: true };
  }
  // video 与 image/document 同语义：retry 媒体瘦身漏掉 video 会让大体积 base64
  // 原样穿过 retry 请求，违背占位投影的目的。
  if (block.type === "video") {
    return { block: compactPlaceholderBlock("[video]"), replaced: true };
  }
  if (block.type === "file" && isCompactDocumentMedia(block)) {
    return { block: compactPlaceholderBlock("[document]"), replaced: true };
  }
  return { block: cloneCompactBlock(block), replaced: false };
}

/**
 * 判断 file 块是否属于"会占体积的媒体":有内联 text 正文的不算(正文可读),
 * 只有 dataUrl / uri 指向二进制内容时才算。
 */
function isCompactDocumentMedia(
  block: Extract<ModelMessageContentBlock, { type: "file" }>,
): boolean {
  if (block.text !== undefined && block.text.length > 0) return false;
  return Boolean(block.dataUrl || block.uri);
}

function compactPlaceholderBlock(
  text: "[document]" | "[image]" | "[video]",
): ModelMessageContentBlock {
  return { type: "text", text };
}

function cloneCompactBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}
