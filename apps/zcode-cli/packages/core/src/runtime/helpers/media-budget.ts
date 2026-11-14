import {
  CoreErrorType,
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  createCoreError,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";
import { findLatestRealUserMessageIndex } from "./conversation.js";
import {
  projectMessagesForInputFormat,
  type MediaCapabilityProjection,
} from "./media-capability.js";

// 独立的视频预算无法约束请求总量；所有媒体统一按编码后的体积计入 40MiB，
// 为正文等非媒体内容预留空间。单文件原始字节限制由附件输入/Read 层负责。
export const DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES = 40 * 1024 * 1024;

/**
 * 媒体预算投影：把"整个请求里的所有媒体"收敛到 maxMediaBytes 以内。
 *
 * 与 media-capability 的分工：capability 决定"模型收不收这种媒体"（按能力换成占位文本），
 * budget 决定"总量还能装下多少"（按字节从旧到新贪心保留）。两者必须在同一请求边界串联，
 * 否则会出现"能力投影通过、但请求体超限"或"预算通过、但模型不支持该媒体"。
 *
 * 【保护的最新用户消息】最新真实 user 的媒体默认不可裁剪（protected），因为这些是用户
 * 本轮明确要发的东西；它们自身超预算时直接报"当前附件过大"，而不是偷偷丢弃。
 *
 * 【不变量】
 * - 计算口径恒为"编码后的 UTF-8 字节"（dataUrl 字符串本身），而不是原始文件字节；
 * - 保留/省略只替换 contentBlock，消息数量、顺序、role 都不变；
 * - 未超预算时直接返回原数组（不克隆），便于上层用引用相等判断"没有改动"。
 */

/**
 * 一个媒体块在请求体里的账面信息。
 *
 * - blockIndex：在所属 message.content 数组中的下标（与 mediaKey 一起唯一定位）；
 * - requestBytes：真正进入请求体的字节数（dataUrl 字符串的 UTF-8 长度），不是原始文件大小；
 * - messageIndex：所属消息下标，同时决定"是否属于最新 user"与保留优先级；
 * - protected：是否属于最新真实 user 消息；protected 块永不参与淘汰，
 *   但若 protected 总量自己就超预算，会直接抛错而不是降级。
 */
interface MediaBlockRef {
  blockIndex: number;
  requestBytes: number;
  messageIndex: number;
  protected: boolean;
}

/**
 * 预算投影结果。字段口径：
 * - messages：应用预算后的消息数组；未超预算时与输入是同一个数组引用；
 * - omittedMediaCount：被替换成占位文本的媒体块数量（totalCount - retainedCount）；
 * - projectedMediaBytes：保留下来的媒体块 requestBytes 之和（小于等于 maxMediaBytes）；
 * - retainedMediaCount：保留下来的媒体块数量（含 protected）；
 * - totalMediaBytes：裁剪前所有媒体块的字节总和，用于日志判断"超了多少"。
 *
 * 注意：omittedMediaCount 只统计"媒体块"，不含被 official-cua 逻辑一并置空的 image_ref 文本块。
 */
export interface MediaBudgetProjection {
  messages: ModelInputMessage[];
  omittedMediaCount: number;
  projectedMediaBytes: number;
  retainedMediaCount: number;
  totalMediaBytes: number;
}

/**
 * 两阶段媒体策略的合并结果。
 *
 * - capabilityProjection：能力阶段（按 inputFormat 把不支持的媒体换成占位文本）；
 * - mediaBudgetProjection：预算阶段（在能力投影之后按字节淘汰历史媒体）；
 * - messages：最终应发给 provider 的消息（等于 budgetProjection.messages）。
 *
 * 保留中间结果是为了让调用方既能记录诊断（有多少媒体因能力/预算被省略），
 * 又不必自己再拼一次投影。
 */
export interface ModelMediaPolicyProjection {
  capabilityProjection: MediaCapabilityProjection;
  mediaBudgetProjection: MediaBudgetProjection;
  messages: ModelInputMessage[];
}

/**
 * 两阶段媒体策略的唯一入口：能力投影 → 预算投影。
 *
 * 为什么要强制串联：历史上直接调用 Model 的辅助链路只补了 capability、漏掉聚合预算，
 * 导致请求体仍可能超限；反过来只做预算又会把模型不支持的媒体留在请求里。把两步绑定在
 * 同一个函数里，新增调用方不会只做一半。
 *
 * 输入：messages 是已经完成 provider 渲染的消息（metadata 已剥离，因此 latest real user
 * 索引在需要时必须由调用方显式传入）；inputFormat 来自模型属性。
 * 输出：两阶段结果 + 最终 messages；不修改入参数组。
 * 副作用：无 IO；纯内存计算。
 * 失败语义：预算参数非法抛 ConfigurationError；最新用户附件本身超预算抛 InvalidInput
 * （错误码统一为当前附件过大，见 projectMessagesForMediaBudget 内部说明）。
 */
export function projectMessagesForModelMediaPolicy(
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
  options: { latestRealUserMessageIndex?: number } = {},
): ModelMediaPolicyProjection {
  // 直接调用 Model 的辅助链路曾只补 capability、漏掉聚合预算；两阶段必须
  // 在同一个请求策略边界串联，避免新增消费者继续手工拼装而遗漏其中一半。
  const capabilityProjection = projectMessagesForInputFormat(messages, inputFormat);
  const mediaBudgetProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  return {
    capabilityProjection,
    mediaBudgetProjection,
    messages: mediaBudgetProjection.messages,
  };
}

/**
 * 预算投影选项。
 *
 * - latestRealUserMessageIndex：provider 投影后重新映射的"最新真实 user"下标；-1 表示
 *   "明确没有真实用户"（此时所有媒体都可裁剪），undefined 才回退到文本启发式；
 * - maxMediaBytes：覆盖默认 40MiB 的预算；非法值（NaN/负数）抛 ConfigurationError；
 * - preserveLatestUserMedia：false 时强制取消 protected 语义（用于只做估算/辅助请求的场景），
 *   相当于把 latestUserIndex 固定为 -1。
 */
interface MediaBudgetProjectionOptions {
  latestRealUserMessageIndex?: number;
  maxMediaBytes?: number;
  preserveLatestUserMedia?: boolean;
}

/**
 * 只做预算投影（不含能力投影），输入必须是"provider 形态"的消息。
 *
 * 算法：
 * 1. 校验预算参数；定位最新真实 user 下标；
 * 2. 收集所有媒体块（image/video 的 dataUrl、无 text 的 file.dataUrl），求和；
 * 3. 未超预算 → 原样返回（同一数组引用）；
 * 4. 受保护（最新 user）媒体自己超预算 → 抛 InvalidInput，错误码改写为统一的
 *    MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE（跨进程不会退化成通用错误）；
 * 5. 其余媒体按"新→旧"贪心保留：装不下就跳过并继续尝试更小的，不中断遍历；
 * 6. 逐条消息重建 content，把未保留的媒体替换为占位文本（并为 official-cua 原子对补特殊处理）。
 *
 * 输出：MediaBudgetProjection，messages 中的每个块要么保留、要么被替换，数量与顺序不变。
 * 副作用：不修改入参；返回新数组/新 content 数组（超预算时）。
 * 不变量：projectedMediaBytes 恒等于"实际保留的块字节和"，不会因为跳过而虚高。
 */
export function projectMessagesForMediaBudget(
  messages: ModelInputMessage[],
  options: MediaBudgetProjectionOptions = {},
): MediaBudgetProjection {
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES;
  // 预算配置错误属于调用方 bug/配置错误,必须显式失败;静默按默认值兜底会掩盖超限问题。
  if (!Number.isFinite(maxMediaBytes) || maxMediaBytes < 0) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Invalid model request media budget", {
      context: { maxMediaBytes },
      recoverable: true,
    });
  }
  const latestUserIndex =
    options.preserveLatestUserMedia === false
      ? -1
      : resolveLatestRealUserMessageIndex(messages, options.latestRealUserMessageIndex);
  const mediaBlocks = collectMediaBlocks(messages, latestUserIndex);
  const totalMediaBytes = sumMediaBytes(mediaBlocks);

  // 未超预算不做任何克隆:保持引用相等,让上层能判断"本次投影没有改动消息"。
  if (totalMediaBytes <= maxMediaBytes) {
    return {
      messages,
      omittedMediaCount: 0,
      projectedMediaBytes: totalMediaBytes,
      retainedMediaCount: mediaBlocks.length,
      totalMediaBytes,
    };
  }

  const protectedMedia = mediaBlocks.filter((block) => block.protected);
  const protectedMediaBytes = sumMediaBytes(protectedMedia);
  // 最新用户附件自身超预算时不能"淘汰历史媒体来腾地方":它们已经是必须发送的部分,
  // 唯一正确做法是让用户删减附件,而不是悄悄改变本轮输入。
  if (protectedMediaBytes > maxMediaBytes) {
    const errorCode = MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE;
    const error = createCoreError(
      CoreErrorType.InvalidInput,
      "Current attachments are too large to send. Remove or compress attachments and try again.",
      {
        context: { code: errorCode, maxMediaBytes, protectedMediaBytes, totalMediaBytes },
        recoverable: true,
      },
    );
    // 跨进程只传通用 INVALID_INPUT 会丢失本地化语义；请求总量错误
    // 必须使用统一附件码，避免把 PDF 或混合附件误报成图片/视频错误。
    error.code = errorCode;
    throw error;
  }

  const retainedKeys = new Set(protectedMedia.map(mediaKey));
  let remainingBytes = maxMediaBytes - protectedMediaBytes;
  const historicalMedia = mediaBlocks
    .filter((block) => !block.protected)
    .sort(
      // 从新到旧:越新的历史媒体越可能仍被模型引用,优先保留;同消息内也优先靠后的块。
      (left, right) => right.messageIndex - left.messageIndex || right.blockIndex - left.blockIndex,
    );
  for (const media of historicalMedia) {
    // 装不下就跳过继续尝试更小的块,不因为一个大文件而放弃整段历史媒体。
    if (media.requestBytes > remainingBytes) continue;
    retainedKeys.add(mediaKey(media));
    remainingBytes -= media.requestBytes;
  }

  const messagesWithBudget = messages.map((message, messageIndex) => ({
    ...message,
    content: projectContent(message.content, messageIndex, retainedKeys),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
  }));
  const retainedMediaCount = retainedKeys.size;

  return {
    messages: messagesWithBudget,
    omittedMediaCount: mediaBlocks.length - retainedMediaCount,
    projectedMediaBytes: mediaBlocks
      .filter((block) => retainedKeys.has(mediaKey(block)))
      .reduce((total, block) => total + block.requestBytes, 0),
    retainedMediaCount,
    totalMediaBytes,
  };
}

/**
 * 解析"最新真实 user"消息下标（决定哪些媒体受保护）。
 *
 * 口径：显式传入且是合法整数、落在 [-1, messages.length) 区间时直接采用——
 * -1 是"没有真实用户"的正式表达（例如只有系统提醒的辅助请求），不能被当成缺失；
 * 只有 undefined / 非法值才回退到 findLatestRealUserMessageIndex 的文本启发式。
 * 为什么不能只看 cacheControl：它现在是 provider cache marker，不再代表 user 身份。
 * 纯函数；无副作用。
 */
function resolveLatestRealUserMessageIndex(
  messages: ModelInputMessage[],
  latestRealUserMessageIndex: number | undefined,
): number {
  // cacheControl 现在是 provider cache marker，latest real user 身份由
  // provider projection 传入的 request-local index 承接；-1 明确表示没有真实用户，缺失时才回退到文本启发式。
  if (
    latestRealUserMessageIndex !== undefined &&
    Number.isInteger(latestRealUserMessageIndex) &&
    latestRealUserMessageIndex >= -1 &&
    latestRealUserMessageIndex < messages.length
  ) {
    return latestRealUserMessageIndex;
  }
  return findLatestRealUserMessageIndex(messages);
}

/**
 * 记录一次媒体预算投影的诊断信息。
 *
 * 只在确实省略了媒体时才写 debug（正常请求不产生噪声）；只记录数量与字节，
 * 不含任何 dataUrl/正文，避免把用户媒体内容写进日志。
 * 副作用：一次 logger.debug；无持久化。
 * 失败语义：没有发生省略时是 no-op；logger 允许缺省（undefined 时不记录）。
 */
export function logMediaBudgetProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: MediaBudgetProjection,
  options: { event: string; message: string },
): void {
  if (projection.omittedMediaCount === 0) return;
  logger?.debug(options.message, {
    ...traceContextToLogContext(traceContext),
    event: options.event,
    module: "core.runtime",
    status: "completed",
    omittedMediaCount: projection.omittedMediaCount,
    projectedMediaBytes: projection.projectedMediaBytes,
    retainedMediaCount: projection.retainedMediaCount,
    totalMediaBytes: projection.totalMediaBytes,
  });
}

/**
 * 收集所有"计入预算"的媒体块。
 *
 * 只扫 content 为数组的消息；纯字符串 content 视为无媒体。
 * protected 由 messageIndex === latestUserIndex 决定（同一消息内所有媒体块共享该标记）。
 * 无副作用；顺序为"消息顺序 → 块顺序"，供后续稳定排序/贪心保留使用。
 */
function collectMediaBlocks(
  messages: ModelInputMessage[],
  latestUserIndex: number,
): MediaBlockRef[] {
  const mediaBlocks: MediaBlockRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      const requestBytes = mediaRequestBytes(block);
      if (requestBytes === 0) return;
      mediaBlocks.push({
        blockIndex,
        requestBytes,
        messageIndex,
        protected: messageIndex === latestUserIndex,
      });
    });
  });
  return mediaBlocks;
}

/**
 * 重建单条消息的 content：保留媒体原样克隆，被省略的媒体替换为占位文本。
 *
 * 关键分支：official-cua 的 "image + image_ref 文本"是原子对。
 * - image 被省略时，紧随其后的 image_ref 文本必须一起置空（否则会留下指向不存在帧的凭证）；
 * - image_ref 文本被省略（或已被置空）时，前面的 image 换成专门的 "raster unavailable" 提示，
 *   让模型知道"这帧看不到，要重新截图"，而不是笼统的 "media omitted"。
 * 输出：新的 content 数组（长度与下标严格不变）；非数组 content 原样返回。
 * 副作用：无（克隆块对象，不改入参）。
 */
function projectContent(
  content: ModelMessageContent,
  messageIndex: number,
  retainedKeys: Set<string>,
): ModelMessageContent {
  if (!Array.isArray(content)) return content;

  const omittedBlockIndexes = new Set<number>();
  content.forEach((block, blockIndex) => {
    if (mediaRequestBytes(block) === 0) return;
    if (!retainedKeys.has(mediaKey({ blockIndex, messageIndex }))) {
      omittedBlockIndexes.add(blockIndex);
    }
  });

  const pairedTextIndexes = officialCuaImageRefIndexesForUnavailableMedia(
    content,
    omittedBlockIndexes,
  );

  return content.map((block, blockIndex) => {
    if (pairedTextIndexes.has(blockIndex)) {
      return { type: "text", text: "" };
    }
    if (mediaRequestBytes(block) === 0) return cloneContentBlock(block);
    const key = mediaKey({ blockIndex, messageIndex });
    if (retainedKeys.has(key)) return cloneContentBlock(block);
    return pairedTextIndexes.has(blockIndex + 1)
      ? officialCuaRasterUnavailableBlock()
      : mediaOmittedTextBlock(block);
  });
}

/**
 * 单个 block 计入请求体的媒体字节数。
 *
 * - image/video：dataUrl 字符串的 UTF-8 字节（base64 已膨胀，这是真实请求体占用）；
 * - file：只有"纯 dataUrl 且没有 text"时才算——带 text 的 file 块已经是文本，不再占媒体额度；
 * - 其它类型（text/reasoning/tool_reference/resource_link）为 0。
 * 与 media-capability 的 isProviderVisible* 判定保持同一口径，避免两阶段统计不一致。
 * 纯函数。
 */
function mediaRequestBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  return 0;
}

/**
 * 把被省略的媒体块换成"可读占位文本"。
 *
 * 先用 modelMessageContentToText 尽量保留原块的可读描述（例如附件名/路径），再追加一句
 * 明确说明"为控制请求体已省略"。两段拼接的意义：模型既知道原本有什么，也知道现在看不到，
 * 不会误以为内容仍然可用。空描述时退化为 [Attached media]。
 * 纯函数。
 */
function mediaOmittedTextBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  const placeholder = modelMessageContentToText([block]) || "[Attached media]";
  return {
    type: "text",
    text: `${placeholder}\n[Media omitted from provider request to keep the request body under the configured media budget.]`,
  };
}

/**
 * 克隆一个内容块（含 source 的浅拷贝）。
 *
 * 为什么必须克隆：预算/能力投影会在新建的消息数组里替换部分块，若直接共享原对象，
 * 后续对 source 的补写（例如 media-attachment-path 注入 path）会反向污染调用方消息，
 * 也会让"未改动"的引用相等判断失效。
 * 无副作用。
 */
function cloneContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  switch (block.type) {
    case "image":
    case "video":
    case "file":
      return { ...block, source: block.source ? { ...block.source } : undefined };
    case "text":
    case "reasoning":
    case "tool_reference":
    case "resource_link":
      return { ...block };
  }
}

/** 媒体块字节求和（只做加法，不关心上限）。 */
function sumMediaBytes(mediaBlocks: MediaBlockRef[]): number {
  return mediaBlocks.reduce((total, block) => total + block.requestBytes, 0);
}

/** 稳定的媒体块键：messageIndex:blockIndex，用于 Set 里判断"是否被保留"。 */
function mediaKey(input: Pick<MediaBlockRef, "blockIndex" | "messageIndex">): string {
  return `${input.messageIndex}:${input.blockIndex}`;
}
