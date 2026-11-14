import {
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_TARGET_BYTES,
  type ImageProcessorPort,
  type TraceContext,
} from "../deps.js";
import { MAX_IMAGE_ATTACHMENT_DIMENSION } from "../types.js";
import type { PreparedImageData } from "../types.js";

/**
 * 把图片 data URL 归一成可发送的图片数据（必要时缩放重编码）。
 *
 * 职责：解析 inline base64 → 交给 ImageProcessorPort 按"目标字节/最大 base64/最大边长"处理。
 * 输入：dataUrl 必须是 `data:<mime>;base64,<payload>`；mediaType 由调用方从 data URL 头解析得到。
 * 输出：PreparedImageData（新的 dataURL + mediaType + 尺寸/缩放元数据）；无法解析时 undefined。
 * 副作用：一次图片处理（可能 CPU 密集、可被 abortSignal 取消）；不落盘。
 * 失败与降级：
 * - 非 base64 data URL → 直接 undefined，调用方转 attachment_image_invalid；
 * - 没有 imageProcessorPort → 原样返回（不做缩放），保证无图片能力的宿主也能发图；
 * - 处理器抛错（含取消）→ 向上抛，由调用方转 attachment_image_resize_failed。
 * 不变量：返回的 dataUrl 始终是重新编码后的 `data:<mediaType>;base64,...`，metadata 里的
 * width/height 指的是处理后的尺寸，originalWidth/originalHeight 是输入尺寸。
 */
export async function prepareImageDataUrl(
  dataUrl: string,
  mediaType: string,
  options: {
    abortSignal?: AbortSignal;
    imageProcessorPort?: ImageProcessorPort;
    traceContext: TraceContext;
  },
): Promise<PreparedImageData | undefined> {
  const base64Data = parseBase64DataUrlPayload(dataUrl);
  if (!base64Data) return undefined;
  // 没有处理器时不假装处理过：原样返回，metadata 缺省，后续体积判断仍按原内容。
  if (!options.imageProcessorPort) {
    return { dataUrl, mediaType };
  }

  const prepared = await options.imageProcessorPort.prepareForModel(
    {
      data: Buffer.from(base64Data, "base64"),
      maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      maxRawBytes: READ_IMAGE_TARGET_BYTES,
      mediaType,
      trace: options.traceContext,
    },
    { signal: options.abortSignal },
  );
  const resizedData = Buffer.from(prepared.data);
  const resizedMediaType = prepared.mediaType || mediaType;
  return {
    dataUrl: `data:${resizedMediaType};base64,${resizedData.toString("base64")}`,
    mediaType: resizedMediaType,
    metadata: {
      height: prepared.height,
      maxDimension: MAX_IMAGE_ATTACHMENT_DIMENSION,
      originalHeight: prepared.originalHeight,
      originalWidth: prepared.originalWidth,
      resized: prepared.resized,
      transformedSizeBytes: prepared.transformedSizeBytes,
      width: prepared.width,
    },
  };
}

/**
 * 从 data URL 里取出 base64 正文（不含头）。
 *
 * 只接受 `data:<mime>;base64,` 形态；正则要求分号后紧跟 base64 标记，因此 `data:text/plain,xxx`
 * 这类未编码载荷会返回 undefined —— 图片路径必须先编码，否则 Buffer.from 的解码结果不可信。
 * 无副作用。
 */
function parseBase64DataUrlPayload(dataUrl: string): string | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const data = match?.[2];
  if (!match || !data) return undefined;
  return data;
}

/**
 * 按扩展名推断图片 mime（仅展示/兜底用途）。
 *
 * 支持 jpg/jpeg/gif/webp，其余（含无扩展名、png、未知格式）一律按 image/png 处理。
 * 这是"宁可猜 png 也不报错"的降级口径：真正的字节校验由 provider 与图片处理器负责。
 * 无副作用；大小写不敏感。
 */
export function inferImageMimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}
