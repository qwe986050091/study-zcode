/**
 * ============================================================================
 * image/jimp-media.ts —— Jimp 图片格式/取消工具
 * ============================================================================
 *
 * 【定位】图像适配层共用的纯函数：mediaType 归一化、Jimp 输出格式选择、
 * 取消检查。不读写文件，不依赖外部状态。
 *
 * 【口径】Jimp 只能输出 bmp/gif/jpeg/png/tiff；其他格式一律回退 png。
 * 取消通过抛普通 Error("Image resize was cancelled") 表达。
 * ============================================================================
 */
import { JimpMime } from "jimp";
import { detectImageMediaType } from "@zcode/contracts";

type JimpOutputMime =
  | typeof JimpMime.bmp
  | typeof JimpMime.gif
  | typeof JimpMime.jpeg
  | typeof JimpMime.png
  | typeof JimpMime.tiff;

export { detectImageMediaType };

/**
 * 归一化输入 mediaType。
 *
 * 修正 `image/jpg` 别名；只放行 jpeg/png/gif/webp，其余一律按 png 处理
 * （包括 image/svg+xml 等 Jimp 不支持的格式）。
 */
export function normalizeMediaType(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (
    lower === "image/jpeg" ||
    lower === "image/png" ||
    lower === "image/gif" ||
    lower === "image/webp"
  ) {
    return lower;
  }
  return JimpMime.png;
}

/**
 * 选择 Jimp 实际输出格式。
 *
 * 优先尊重调用方请求（仅当它是 Jimp 支持格式）；否则沿用图片自身探测格式；
 * 两者都不可用时回退 png，避免 getBuffer 抛"不支持编码"。
 */
export function jimpOutputMediaType(
  requested: string,
  detected: string | undefined,
): JimpOutputMime {
  if (isJimpOutputMime(requested)) return requested;
  if (detected && isJimpOutputMime(detected)) return detected;
  return JimpMime.png;
}

/**
 * 取消检查点。
 *
 * 只在已中止时抛错；未中止或无 signal 时静默返回。用于在 CPU 密集步骤
 * （read/scale/getBuffer）之间尽快把取消传播给调用方。
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("Image resize was cancelled");
}

function isJimpOutputMime(value: string): value is JimpOutputMime {
  return (
    value === JimpMime.bmp ||
    value === JimpMime.gif ||
    value === JimpMime.jpeg ||
    value === JimpMime.png ||
    value === JimpMime.tiff
  );
}
