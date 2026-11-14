// UTF-16 安全文本工具：所有对外缩短文本的路径都必须经过 cut，避免切断代理对导致 UTF-8 编码失败。
// wellFormed 负责兜底清洗，wellFormedDeep 负责跨 JSON 边界递归清洗；两者都是有意的降级，不抛错。
/**
 * JavaScript strings are UTF-16: characters outside the basic plane, such as the math letters
 * 𝑥 and 𝜃 that PDFs use, take two code units. Cutting between them leaves half a character,
 * which cannot be encoded as UTF-8, and model APIs reject the whole request ("surrogates not
 * allowed"). Every place that shortens text goes through `cut`, and everything sent to the host
 * goes through `wellFormed`.
 */

// 代理对区间判定：高位 U+D800–DBFF 与低位 U+DC00–DFFF 必须成对出现，单独一半无法编码为 UTF-8。
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text.slice(start, end)`, moved off the middle of a two-unit character at either end. */
// 安全截断：先把 start/end 夹到 [0, length]，再在边界处避开代理对中缝。
// 入参越界会被夹紧而不是抛错；返回文本可能比请求少 1 个码元，这是有意为之，保证 UTF-8 可编码。
// 纯函数、无副作用；所有对外缩短文本的位置都必须经过这里，不要直接 slice。
export function cut(text: string, start: number, end = text.length): string {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  // 起点落在低位代理且前一位是高位：会切出半个字符，向外扩一位以包含完整字符。
  if (from > 0 && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from--;
  // 终点落在低位代理：同样会切出半个字符，向内收一位。
  if (to < text.length && isLow(text.charCodeAt(to)) && isHigh(text.charCodeAt(to - 1))) to--;
  return text.slice(from, to);
}

// 孤立代理匹配：高位后面不跟低位，或低位前面不是高位；只匹配"半个"字符，成对的不受影响。
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace any half character left in `text` with U+FFFD. */
// 兜底修复：把任何残留的孤立代理替换为 U+FFFD，保证后续 UTF-8 编码与模型 API 接受整段文本。
// 只处理孤立半字符，成对代理原样保留；幂等，可重复调用，不修改入参。
// 入参任意字符串、出参保证可直接 JSON 序列化；不抛错，非法半字符一律降级为替换符。
export const wellFormed = (text: string): string => text.replace(LONE_HALF, "�");

/** `wellFormed` applied to every string inside a JSON-like value. */
// 深拷贝式清洗：字符串做替换、数组逐项递归、普通对象逐键递归，返回新结构且不修改入参。
// Date/Map/DOM 等非纯 JSON 对象原样返回，避免误改宿主对象或触发 getter 副作用。
// 返回值是新引用（字符串与纯对象/数组重建），调用方可安全地传给宿主或写入缓存。
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item)) as T;
  // 通过原型判断只递归纯对象，排除类实例与宿主对象。
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wellFormedDeep(item)]),
    ) as T;
  return value;
}
