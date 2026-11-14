/**
 * ============================================================================
 * context/utils.ts —— token 估算工具
 * ============================================================================
 * 仅提供启发式估算，不依赖真实 tokenizer；用于诊断与预算，不作为计费依据。
 * ============================================================================
 */
// ============================================================
// Token Estimation
// ============================================================

import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";

/**
 * 估算文本的 token 数量
 * 使用共享字符估算除数，中文字符保留额外权重
 * 这是一个粗略估算，对于调试和监控足够用
 * 输入任意字符串（含空串，返回 0）；输出向上取整的估算 token 数。
 * 口径：中文按 2 个"估算字符"计，其余按 1；除数来自共享常量。
 * 无副作用、无失败分支；不要用该值做硬性截断判断。
 */
export function estimateTokens(text: string): number {
  // 中文字符通常比英文字符占用更多 token，因此按两个估算字符计入。
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
