/**
 * ============================================================================
 * image/webp-passthrough.ts —— WebP 无转码直通
 * ============================================================================
 *
 * 【定位】当前 Jimp 构建不能解码/编码 WebP，因此 prepare 阶段对 WebP 只做
 * 预算校验后原样返回。strategy="original" 明确告诉上层"没有做任何转换"。
 *
 * 【失败语义】超出预算抛 ImageProcessorError(code="unsupported")，而不是
 * 静默降级或丢弃图片——调用方据此决定是否报错给用户。
 * ============================================================================
 */
import {
  createImageProcessorError,
  type ImagePrepareForModelRequest,
  type ImagePrepareForModelResult,
} from "@zcode/contracts";
import { createImageBudget, fitsImageBudget } from "./image-budget.js";

/**
 * 原样返回 WebP 字节（仅做预算校验）。
 *
 * 返回 transformedSizeBytes 与 originalSizeBytes 相等、resized/compressed 均为
 * false；超预算时抛 unsupported，提示"当前适配器无法转码 WebP"。
 */
export function prepareWebpPassthrough(
  input: Buffer,
  request: ImagePrepareForModelRequest,
): ImagePrepareForModelResult {
  const budget = createImageBudget(request);
  if (!fitsImageBudget(input, budget)) {
    throw createImageProcessorError({
      code: "unsupported",
      message:
        "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP",
    });
  }
  return {
    data: input,
    mediaType: "image/webp",
    originalSizeBytes: input.byteLength,
    resized: false,
    compressed: false,
    strategy: "original",
    transformedSizeBytes: input.byteLength,
  };
}
