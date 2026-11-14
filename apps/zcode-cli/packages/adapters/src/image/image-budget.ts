/**
 * ============================================================================
 * image/image-budget.ts —— 图片进模型前的预算计算与校验
 * ============================================================================
 *
 * 【定位】把调用方给出的 maxDimension / maxRawBytes / maxBase64Bytes /
 * maxTokens 归一成一份可复用的 ImageBudget，并提供"这张图是否还在预算内"
 * 的纯函数判定。
 *
 * 【口径】base64 字节数按 `ceil(raw/3)*4` 估算（不含 data URL 头）；
 * token 数按 base64 字符数 × tokenToBase64CharRatio（默认 0.125）估算。
 * maxTokens 缺省表示不做 token 维度限制。
 *
 * 【失败语义】validatePrepareRequest 对非有限值/非正数抛
 * ImageProcessorError(code="invalid_request")；fitsImageBudget 只返回布尔，
 * 不抛错。
 * ============================================================================
 */
import type { ImagePrepareForModelRequest } from "@zcode/contracts";
import { createImageProcessorError } from "@zcode/contracts";

export type ImageBudget = {
  /** 原始图片字节上限；超过即拒绝，不看编码后大小。 */
  maxBase64Bytes: number;
  /** base64 编码后字节上限；用于限制 data URL 传输体积。 */
  maxRawBytes: number;
  /** 可选的 token 预算；undefined 表示该维度不限制。 */
  maxTokens?: number;
  /** base64 字符数到 token 数的估算比例，默认 0.125。 */
  tokenToBase64CharRatio: number;
};

const DEFAULT_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;

/**
 * 把请求参数固化成预算对象。
 *
 * 字节上限向下取整（保守，宁可少放行一个字节）；token 比例缺省 0.125。
 * 纯函数，无副作用；不校验参数合法性，需先调用 validatePrepareRequest。
 */
export function createImageBudget(request: ImagePrepareForModelRequest): ImageBudget {
  return {
    maxBase64Bytes: Math.floor(request.maxBase64Bytes),
    maxRawBytes: Math.floor(request.maxRawBytes),
    maxTokens: request.maxTokens,
    tokenToBase64CharRatio: request.tokenToBase64CharRatio ?? DEFAULT_TOKEN_TO_BASE64_CHAR_RATIO,
  };
}

/**
 * 校验 prepare 请求的三个数值边界。
 *
 * maxDimension/maxBase64Bytes/maxRawBytes 必须是正有限数；非法时抛
 * ImageProcessorError("invalid_request")，由上层转成用户可读错误。
 */
export function validatePrepareRequest(request: ImagePrepareForModelRequest): void {
  if (!Number.isFinite(request.maxDimension) || request.maxDimension <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image resize maxDimension must be a positive finite number",
    });
  }
  if (!Number.isFinite(request.maxBase64Bytes) || request.maxBase64Bytes <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image maxBase64Bytes must be a positive finite number",
    });
  }
  if (!Number.isFinite(request.maxRawBytes) || request.maxRawBytes <= 0) {
    throw createImageProcessorError({
      code: "invalid_request",
      message: "Image maxRawBytes must be a positive finite number",
    });
  }
}

/**
 * 判断图片是否满足全部预算维度。
 *
 * 依次检查原始字节、base64 字节、可选 token 估算；任一超限即 false。
 * 纯函数，不会为了"刚好超一点"做额外压缩。
 */
export function fitsImageBudget(buffer: Buffer, budget: ImageBudget): boolean {
  const base64Bytes = base64EncodedLength(buffer.byteLength);
  if (buffer.byteLength > budget.maxRawBytes) return false;
  if (base64Bytes > budget.maxBase64Bytes) return false;
  if (budget.maxTokens === undefined) return true;
  return Math.ceil(base64Bytes * budget.tokenToBase64CharRatio) <= budget.maxTokens;
}

function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
