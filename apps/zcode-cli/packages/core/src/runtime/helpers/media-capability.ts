import {
  createUnsupportedModelInputMediaText,
  getUnsupportedModelInputMediaKind,
  isProviderVisibleModelInputMediaBlock,
  isProviderVisiblePdfModelInputBlock,
  isProviderVisibleVideoModelInputBlock,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";

/**
 * 媒体能力投影：按模型的 inputFormat 把"模型不支持发送"的媒体换成占位文本。
 *
 * 与 media-budget 的分工见 media-budget.ts 文件头：能力先行、预算在后；
 * 能力投影只关心"这个模型收不收 image/pdf/video"，不关心请求体体积。
 *
 * 输出字段口径：
 * - messages：投影后的消息；没有任何替换时与原数组引用相同；
 * - omittedImageCount / omittedPdfCount / omittedVideoCount：按类型统计被替换掉的块数；
 * - omittedMediaCount：上述三类 + 其它不可见媒体（例如不带视频能力的 file）的总和；
 * - retainedMediaCount：模型实际可见、且保留在请求里的媒体块数（含本来就被支持的媒体）。
 *
 * 副作用：无 IO，纯内存投影。
 * 不变量：替换只改变 contentBlock 形态（→text），消息条数、顺序、role 不变；
 * official-cua 的 image/image_ref 原子对必须成对处理（见内部注释）。
 */
export interface MediaCapabilityProjection {
  messages: ModelInputMessage[];
  omittedImageCount: number;
  omittedMediaCount: number;
  omittedPdfCount: number;
  omittedVideoCount: number;
  retainedMediaCount: number;
}

/**
 * 按 inputFormat 投影消息。
 *
 * 快速路径：模型同时支持 image/pdf/video 时直接返回原数组，只统计可见媒体数，
 * 不做任何克隆——这是绝大多数请求的路径，必须保持零开销。
 *
 * 慢路径：逐条消息找出"不受支持"的媒体块并替换为文本占位；同时用 changed 标记
 * 判断是否真的改动过，未改动仍返回原数组（保持引用稳定，便于上层判断）。
 *
 * 输出：MediaCapabilityProjection（见接口字段口径）。
 * 副作用：无；不修改入参对象。
 * 失败与降级：不抛错；不支持的媒体一律降级为文本说明，绝不因为媒体类型问题阻断请求。
 * 不变量：retainedMediaCount 只统计"投影后仍以媒体形态存在"的块，因此在有省略时
 * 不会等于输入中的媒体总数。
 */
export function projectMessagesForInputFormat(
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
): MediaCapabilityProjection {
  if (inputFormat.supportsImage && inputFormat.supportsPdf && inputFormat.supportsVideo) {
    return {
      messages,
      omittedImageCount: 0,
      omittedMediaCount: 0,
      omittedPdfCount: 0,
      omittedVideoCount: 0,
      retainedMediaCount: countProviderVisibleMedia(messages),
    };
  }

  let omittedOtherMediaCount = 0;
  let omittedImageCount = 0;
  let omittedPdfCount = 0;
  let omittedVideoCount = 0;
  let retainedMediaCount = 0;
  let changed = false;

  // 逐消息投影而不是整体 map content:只有含不受支持媒体的消息才需要重建对象,
  // 其余消息原样保留,减少克隆与下游误判"消息被改过"。
  const projectedMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let messageChanged = false;
    const unavailableMediaIndexes = new Set<number>();
    message.content.forEach((block, index) => {
      if (unsupportedMediaReplacement(block, inputFormat)) unavailableMediaIndexes.add(index);
    });
    const imageRefIndexes = officialCuaImageRefIndexesForUnavailableMedia(
      message.content,
      unavailableMediaIndexes,
    );
    // official-cua 的 image 与 image_ref 是原子对:image 不可见时,配对文本必须一起清空,
    // 否则会留下一条指向"本次请求里不存在"的帧凭证;反向地,文本被省略时 image 换成
    // raster-unavailable 提示(见下方 return 里的三元分支)。
    const content = message.content.map((block, index) => {
      if (imageRefIndexes.has(index)) {
        messageChanged = true;
        changed = true;
        return { type: "text" as const, text: "" };
      }
      const replacement = unsupportedMediaReplacement(block, inputFormat);
      if (!replacement) {
        if (isProviderVisibleModelInputMediaBlock(block)) retainedMediaCount++;
        return cloneContentBlock(block);
      }

      messageChanged = true;
      changed = true;
      if (block.type === "image") omittedImageCount++;
      else if (isProviderVisiblePdfModelInputBlock(block)) omittedPdfCount++;
      else if (isProviderVisibleVideoModelInputBlock(block)) omittedVideoCount++;
      else omittedOtherMediaCount++;
      return imageRefIndexes.has(index + 1) ? officialCuaRasterUnavailableBlock() : replacement;
    });

    if (!messageChanged) {
      return message;
    }

    return {
      ...message,
      cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
      content,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  });

  const omittedMediaCount =
    omittedImageCount + omittedPdfCount + omittedVideoCount + omittedOtherMediaCount;
  return {
    messages: changed ? projectedMessages : messages,
    omittedImageCount,
    omittedMediaCount,
    omittedPdfCount,
    omittedVideoCount,
    retainedMediaCount,
  };
}

/**
 * 记录一次能力投影的诊断信息。
 *
 * 仅在发生省略时写 debug；按类型拆分计数，便于区分"是模型不支持 pdf 还是 video"。
 * 只记录数量，不含 dataUrl 内容。logger 缺省时为 no-op。
 * 无持久化副作用。
 */
export function logMediaCapabilityProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: MediaCapabilityProjection,
  options: { event: string; message: string; model: string },
): void {
  if (projection.omittedMediaCount === 0) return;
  logger?.debug(options.message, {
    ...traceContextToLogContext(traceContext),
    event: options.event,
    model: options.model,
    module: "core.runtime",
    omittedImageCount: projection.omittedImageCount,
    omittedMediaCount: projection.omittedMediaCount,
    omittedPdfCount: projection.omittedPdfCount,
    omittedVideoCount: projection.omittedVideoCount,
    retainedMediaCount: projection.retainedMediaCount,
    status: "completed",
  });
}

/**
 * 判断某个块是否需要替换；需要则返回对应的占位文本块。
 *
 * 判定委托给 contracts 的 getUnsupportedModelInputMediaKind（唯一能力事实源），
 * 文案由 createUnsupportedModelInputMediaText 统一生成，保证同一媒体类型在所有
 * provider/模型组合下给出同样的解释。返回 undefined 表示"模型支持，保持原样"。
 * 纯函数。
 */
function unsupportedMediaReplacement(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): ModelMessageContentBlock | undefined {
  const unsupportedKind = getUnsupportedModelInputMediaKind(block, inputFormat);
  return unsupportedKind
    ? { type: "text", text: createUnsupportedModelInputMediaText(block, unsupportedKind) }
    : undefined;
}

function countProviderVisibleMedia(messages: ModelInputMessage[]): number {
  return messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) return count;
    return count + message.content.filter(isProviderVisibleModelInputMediaBlock).length;
  }, 0);
}

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
