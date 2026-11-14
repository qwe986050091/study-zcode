import { traceContextToLogContext } from "../deps.js";
import type {
  Logger,
  ModelInputMessage,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import type { MediaBudgetProjection } from "./media-budget.js";
import type { ResolvedTurnAttachment } from "../types.js";

/**
 * 媒体链路的可观测性：只记录"有多少、多大、哪类降级"，不记录任何正文/base64。
 *
 * 两个事件：
 * - turn.attachments.resolved：附件解析完成后的形态统计（用于判断降级码分布）；
 * - model.request.media_summary：投影前后的媒体块对比（用于验证能力/预算投影真的生效）。
 *
 * 设计口径：
 * - 全部走 logger.debug —— 媒体诊断是高频细节，生产环境不落盘；
 * - 预览数组最多 12 条，超出时另给 truncated 标记，避免日志行膨胀；
 * - 不读盘、不改变消息，只在 logger 存在时产生一次日志副作用。
 */

const TURN_ATTACHMENTS_RESOLVED_EVENT = "turn.attachments.resolved";
const MODEL_REQUEST_MEDIA_SUMMARY_EVENT = "model.request.media_summary";
const MEDIA_BLOCK_PREVIEW_LIMIT = 12;

/** block 类型 → 计数（例如 { image: 2, file: 1 }）。 */
type ContentBlockType = ModelMessageContentBlock["type"];

type ContentBlockCounts = Partial<Record<ContentBlockType, number>>;

/**
 * 请求中单个媒体块的诊断摘要。
 *
 * - blockIndex / messageIndex：定位（与 mediaKey 口径一致）；
 * - blockType：image/file/video 之一；
 * - dataUrlBytes：该块 dataUrl 字符串的 UTF-8 字节（与预算口径一致）；
 * - mediaType：块声明的媒体类型，缺失时由上层填 "unknown"；
 * - placeholder：附件展示引用（路径或 attachment-N），用于把日志和用户附件对上；
 * - role：所在消息的 role；
 * - sourceKind：block.source.kind，用于区分 inline / local_file / 其它。
 */
type MediaBlockSummary = {
  blockIndex: number;
  blockType: "file" | "image" | "video";
  dataUrlBytes: number;
  mediaType: string;
  messageIndex: number;
  placeholder?: string;
  role: ModelInputMessage["role"];
  sourceKind?: string;
};

/**
 * 记录"附件解析完成"事件。
 *
 * 输入：resolved 列表中每项都被逐条摘要，统计每种 contentBlock 类型的数量；
 * 同时按类型给出 image/file/video/resource_link/text 五个常用计数，
 * 让排查时不必自己去聚合数组。
 *
 * 输出：无返回值；产生一次 logger.debug。
 * 副作用：仅日志；不修改附件对象、不做 IO。
 * 失败与降级：attachments 为空直接 no-op；logger 缺省时不记录。
 * 注意：摘要里包含 errorCode 与 urlKind，这是判断"附件为什么降级"的主要证据。
 */
export function logResolvedTurnAttachments(
  logger: Logger | undefined,
  traceContext: TraceContext,
  attachments: readonly ResolvedTurnAttachment[],
): void {
  if (attachments.length === 0) return;

  const summaries = attachments.map((attachment, index) =>
    summarizeResolvedTurnAttachment(attachment, index),
  );

  logger?.debug("Turn attachments resolved", {
    ...traceContextToLogContext(traceContext),
    attachmentCount: attachments.length,
    attachmentContentBlockCounts: countBy(summaries, "contentBlockType"),
    attachments: summaries,
    event: TURN_ATTACHMENTS_RESOLVED_EVENT,
    fileAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "file")
      .length,
    imageAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "image")
      .length,
    module: "core.runtime",
    resourceAttachmentCount: summaries.filter(
      (summary) => summary.contentBlockType === "resource_link",
    ).length,
    status: "completed",
    textFallbackAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "text")
      .length,
    videoAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "video")
      .length,
  });
}

/**
 * 记录"模型请求媒体摘要"事件：对比投影前后。
 *
 * 输入：
 * - incomingMessages：能力/预算投影之前的消息；
 * - mediaProjection：预算投影结果（提供 omitted/projected/retained/total 四个数字）；
 * - providerMessages：最终要发给 provider 的消息。
 *
 * 输出：无返回值；产生一次 logger.debug。
 * 为什么两侧都记：只记 provider 侧无法区分"本来就没有媒体"与"被投影删掉了"；
 * 同时给出两侧块数可以直接证明投影确实生效。
 * 副作用：仅日志；不读盘。
 * 失败与降级：两侧都没有媒体块时 no-op；预览超过 12 条只截断展示，不影响计数。
 */
export function logModelRequestMediaSummary(
  logger: Logger | undefined,
  traceContext: TraceContext,
  input: {
    incomingMessages: readonly ModelInputMessage[];
    mediaProjection: MediaBudgetProjection;
    providerMessages: readonly ModelInputMessage[];
  },
): void {
  const incomingBlocks = collectMediaBlockSummaries(input.incomingMessages);
  const providerBlocks = collectMediaBlockSummaries(input.providerMessages);
  if (incomingBlocks.length === 0 && providerBlocks.length === 0) return;

  logger?.debug("Model request media summary", {
    ...traceContextToLogContext(traceContext),
    event: MODEL_REQUEST_MEDIA_SUMMARY_EVENT,
    incomingMediaBlockCount: incomingBlocks.length,
    incomingMediaBlocks: incomingBlocks.slice(0, MEDIA_BLOCK_PREVIEW_LIMIT),
    incomingMediaBlocksTruncated: incomingBlocks.length > MEDIA_BLOCK_PREVIEW_LIMIT,
    module: "core.runtime",
    omittedMediaCount: input.mediaProjection.omittedMediaCount,
    projectedMediaBytes: input.mediaProjection.projectedMediaBytes,
    providerMediaBlockCount: providerBlocks.length,
    providerMediaBlocks: providerBlocks.slice(0, MEDIA_BLOCK_PREVIEW_LIMIT),
    providerMediaBlocksTruncated: providerBlocks.length > MEDIA_BLOCK_PREVIEW_LIMIT,
    retainedMediaCount: input.mediaProjection.retainedMediaCount,
    status: "completed",
    totalMediaBytes: input.mediaProjection.totalMediaBytes,
  });
}

/**
 * 单个已解析附件的摘要（日志字段口径）。
 *
 * - contentBlockType / mediaType / payloadBytes：最终发送形态与体积；
 * - dataUrlBytes：dataUrl 字符串字节（与媒体预算口径一致），payloadBytes 则是解码后的
 *   base64 正文长度，两者差值即 header + base64 膨胀；
 * - hasArtifact / storageKind / recoverability：冷恢复能力的三联证据；
 * - sourceKind：block.source.kind 优先，其次 attachment.source.type；
 * - urlKind：artifact / data-url / reference / empty，避免把 base64 打进日志。
 * 纯函数，无副作用。
 */
function summarizeResolvedTurnAttachment(attachment: ResolvedTurnAttachment, index: number) {
  const block = attachment.contentBlock;
  const blockSource = "source" in block ? block.source : undefined;
  const metadata = attachment.metadata;

  return {
    contentBlockType: block.type,
    dataUrlBytes: contentBlockDataUrlBytes(block),
    errorCode: metadata.errorCode,
    filename: attachment.filename,
    hasArtifact: typeof metadata.artifactUri === "string",
    index,
    mediaType: contentBlockMediaType(block),
    mime: attachment.mime,
    payloadBytes: contentBlockPayloadBytes(block),
    placeholder: blockSource?.placeholder ?? attachment.source?.text.value,
    recoverability: metadata.recoverability,
    sizeBytes: metadata.sizeBytes,
    sourceKind: blockSource?.kind ?? attachment.source?.type,
    storageKind: metadata.storageKind,
    urlKind: classifyAttachmentUrl(attachment.url),
  };
}

/**
 * 扫描消息里的媒体块并生成摘要。
 *
 * 只收录 image/file/video 且 dataUrl 非空的块；纯文本块与 resource_link 不计入，
 * 这与媒体预算的"计入字节"口径保持一致，便于两边数字对齐。
 * 纯函数，无副作用。
 */
function collectMediaBlockSummaries(
  messages: readonly ModelInputMessage[],
): MediaBlockSummary[] {
  const summaries: MediaBlockSummary[] = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;

    message.content.forEach((block, blockIndex) => {
      if (block.type !== "image" && block.type !== "file" && block.type !== "video") return;
      const dataUrlBytes = contentBlockDataUrlBytes(block);
      if (dataUrlBytes === 0) return;
      summaries.push({
        blockIndex,
        blockType: block.type,
        dataUrlBytes,
        mediaType: contentBlockMediaType(block) ?? "unknown",
        messageIndex,
        placeholder: block.source?.placeholder,
        role: message.role,
        sourceKind: block.source?.kind,
      });
    });
  });

  return summaries;
}

/** 提取块的声明媒体类型；非媒体块返回 undefined。 */
function contentBlockMediaType(block: ModelMessageContentBlock): string | undefined {
  if (block.type === "image" || block.type === "file" || block.type === "video") {
    return block.mediaType;
  }
  return undefined;
}

/**
 * 统计块内 base64 正文的字节数（不含 `data:` header）。
 *
 * 与 contentBlockDataUrlBytes 互补：这里只看逗号之后的 payload，用于在日志里
 * 对比"header + base64 膨胀"带来的额外开销；file 块带 text 时视为文本材料化，
 * 不占媒体 payload，返回 0。只做长度统计、不做合法性校验，避免诊断代码自身抛错。
 * 纯函数，无副作用。
 */
function contentBlockPayloadBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return base64PayloadBytes(block.dataUrl);
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return base64PayloadBytes(block.dataUrl);
  }
  return 0;
}

/**
 * 统计块进入请求体时的 dataUrl 字节数（UTF-8），与媒体预算的计算口径一致。
 *
 * image/video 恒按 dataUrl 计；file 只有在"有 dataUrl 且没有 text"时才计——
 * 带 text 的 file 是本地文本或路径引用，不占媒体预算。返回 0 表示该块不计入
 * 媒体统计（collectMediaBlockSummaries 会据此跳过），因此这里必须与预算口径保持一致。
 * 纯函数，无副作用。
 */
function contentBlockDataUrlBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  return 0;
}

/**
 * 取 data URL 中逗号之后 base64 载荷的字节数。
 *
 * 没有逗号说明不是合法 data URL（例如 artifact URI 或裸路径），返回 0 而不是抛错：
 * 日志路径不应因为一个畸形块中断整次请求。纯函数，无副作用。
 */
function base64PayloadBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return 0;
  return Buffer.byteLength(dataUrl.slice(commaIndex + 1), "utf8");
}

/**
 * 把附件 url 归类为日志里的 urlKind，避免把可能含 base64 的 url 原样写进日志。
 *
 * 判定顺序：空串 → empty；`zcode-artifact://` → artifact；`data:` → data-url；
 * 其余（本地路径等引用）→ reference。只做前缀判断，不解析也不读取 URL。
 * 纯函数，无副作用。
 */
function classifyAttachmentUrl(url: string): "artifact" | "data-url" | "empty" | "reference" {
  if (url.length === 0) return "empty";
  if (url.startsWith("zcode-artifact://")) return "artifact";
  if (url.startsWith("data:")) return "data-url";
  return "reference";
}

/**
 * 按指定字段做计数聚合（例如按 contentBlockType 统计图片/文件/视频数量）。
 *
 * 返回 Partial，未出现的类型不会留下 0 值键，日志里不会出现一堆恒为零的字段；
 * 计数键直接复用字段值，因此字段取值必须是 PropertyKey。纯函数，无副作用。
 */
function countBy<T extends Record<K, PropertyKey>, K extends keyof T>(
  values: readonly T[],
  key: K,
): ContentBlockCounts {
  const counts: ContentBlockCounts = {};
  for (const value of values) {
    const countKey = value[key] as ContentBlockType;
    counts[countKey] = (counts[countKey] ?? 0) + 1;
  }
  return counts;
}
