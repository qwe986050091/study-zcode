/**
 * ============================================================================
 * context/sections/current-date.ts —— 当前日期（meta user 附件）
 * ============================================================================
 *
 * 【定位】只注入"今天几号"，不注入时间戳：日期按会话配置（或恢复时快照）
 * 固定，避免同一会话跨零点后前缀缓存失效。
 *
 * 【注入位置】meta_user + dynamic：日期会随时间变化，不能进 stable 前缀；
 * 放在 user 侧附件里，模型能用它做相对日期换算（"上周"等）。
 *
 * 【缺席语义】currentDate 未解析（精简 runtime/测试）时返回 null，
 * 不生成空标题段。
 * ============================================================================
 */

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * 产出当前日期段（meta_user + dynamic）。
 * 输入 currentDate 字符串；缺席时返回 null，不生成空标题。
 * 输出只含日期，不含时间；日期来自会话配置/恢复快照，因此同一会话跨零点不失效。
 * 无副作用；相对日期换算由模型自行完成。
 */
export function buildCurrentDateSection(currentDate: string | undefined): ContextSection | null {
  if (!currentDate) {
    return null;
  }

  const content = `# currentDate\nToday's date is ${currentDate}.`;

  return {
    name: "Current Date",
    source: "current_date",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
