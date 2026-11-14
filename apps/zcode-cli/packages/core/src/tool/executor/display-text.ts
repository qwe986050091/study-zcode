/**
 * display 文本的字节限长助手。从 result-display.ts 拆出：观察类工作流 display 的构造
 * （workflow-observation-display.ts）与既有 payload 构造共用同一道截断语义，而两个文件
 * 互相 import 会成环，助手必须住在双方都能依赖的第三处。
 */

const DISPLAY_TRUNCATION_SUFFIX = "\n...[truncated]";

/**
 * 把展示文本按 UTF-8 字节上限裁剪，并在末尾追加固定截断后缀。
 *
 * 口径：`maxBytes` 是**字节**而不是字符；后缀本身也占预算，所以正文可用额度是
 * `maxBytes - suffixBytes`。返回值 `truncated` 用于让调用方汇总到 payload 级截断标记。
 *
 * 实现：先按码点拆分再二分，保证不会把 emoji 等代理对切成半个字符；只截头（展示文本不取尾）。
 * 当 `maxBytes` 小于后缀长度时正文为空，结果只剩后缀。无副作用。
 */
export function boundDisplayText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  const suffixBytes = Buffer.byteLength(DISPLAY_TRUNCATION_SUFFIX, "utf8");
  const prefix = fitUtf8Prefix(value, maxBytes - suffixBytes);
  return {
    value: `${prefix}${DISPLAY_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

/** 在 `maxBytes`（UTF-8 字节）内找最长的码点前缀；用码点而非 UTF-16 长度避免切裂代理对。 */
function fitUtf8Prefix(value: string, maxBytes: number): string {
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;

  while (low < high) {
    // 注意：mid 取上界，保证候选长度单调推进；用 Math.floor 会在 low+1===high 时死循环。
    const mid = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return codePoints.slice(0, low).join("");
}
