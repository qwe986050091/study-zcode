// docx 渲染元素与服务端块锚点的文本对齐：把每个段落/表格元素映射到 p:N / t:N。
// 边界：只做纯字符串归一比较，不读 DOM、不调服务端；blocks 文本可能被截断，故允许前缀匹配。
// 失败语义：对不上的元素返回 null，宁可少标记也不挂错锚点；跨页续接靠 consumed 游标保证。
import type { DocxBlockKey } from "#office/contract.ts";

// 归一化文本：去掉所有空白并转小写，抵消换行/缩进与大小写差异；只用空白匹配，不用标点。
const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

// 对齐结果口径：返回与 elements 等长的数组，元素是服务端块锚点（t:N 或 p:N）或 null（未匹配）。
// 输入 elements 必须按文档顺序，且 table 标记区分段落与顶层表格；blocks 来自服务端（文本可能被截断到 400 字）。
// 匹配策略：同一位置向后最多看 6 个块（LOOKAHEAD），容忍服务端漏块；跨页拆分的段落用 consumed 续接。
// 纯函数，无副作用；匹配失败不猜，直接给 null，宁可少标记也不标错位置。
/**
 * Map rendered docx elements (paragraphs and top-level tables, in document order) to the server's
 * block list by text. A paragraph split across pages renders as several elements; they all map to
 * the same block. Elements that cannot be matched within a small look-ahead stay unmapped.
 */
export function alignBlocks(
  elements: { text: string; table: boolean }[],
  blocks: DocxBlockKey[],
): (string | null)[] {
  const keys = blocks.map((block) => ({
    at: block.at,
    // 锚点以 "t:" 开头即顶层表格；段落以 "p:" 开头，二者只与同类型元素匹配。
    table: block.at.startsWith("t:"),
    text: squash(block.text),
  }));
  const result: (string | null)[] = [];
  let j = 0;
  let consumed = 0; // characters of keys[j].text already matched by earlier fragments
  // 向后搜索窗口：服务端可能缺少某些块（如空段落被丢弃），6 个块足以覆盖常见跳变且不会误匹配远处同文。
  const LOOKAHEAD = 6;
  for (const element of elements) {
    const text = squash(element.text);
    let matched: number | null = null;
    if (j < keys.length && consumed > 0) {
      // Continuation of a paragraph split across pages.
      // 只续接同类型且从 consumed 处开始的剩余文本；对不上说明服务端块变了，跳到下一块重新匹配。
      const rest = keys[j].text.slice(consumed);
      if (text && !element.table && rest.startsWith(text)) {
        consumed += text.length;
        result.push(keys[j].at);
        if (consumed >= keys[j].text.length) {
          j++;
          consumed = 0;
        }
        continue;
      }
      j++;
      consumed = 0;
    }
    for (let k = j; k < Math.min(keys.length, j + LOOKAHEAD); k++) {
      const key = keys[k];
      // 表格与段落互不匹配，避免同文本的表格和段落锚点错位。
      if (key.table !== element.table) continue;
      // Server text is clipped to 400 characters; compare on the shared prefix.
      const probe = text.slice(0, key.text.length);
      if (
        key.text === text ||
        (text && key.text.startsWith(text)) ||
        (key.text.length >= 300 && probe === key.text)
      ) {
        matched = k;
        break;
      }
      if (!text && !key.text) {
        matched = k;
        break;
      }
    }
    if (matched === null) {
      // 找不到对应块就留空：调用方据此不给该元素加 data-at，而不是挂到错误的块上。
      result.push(null);
      continue;
    }
    result.push(keys[matched].at);
    const key = keys[matched];
    // 元素文本是块文本的前缀且块未被服务端截断（<400）时，认为该块还会在下一页继续：
    // 停在同一块上并记录已消费长度，后续分页片段会续接到同一锚点。
    if (
      text &&
      !element.table &&
      text.length < key.text.length &&
      key.text.startsWith(text) &&
      key.text.length < 400
    ) {
      j = matched;
      consumed = text.length;
    } else {
      j = matched + 1;
      consumed = 0;
    }
  }
  return result;
}
