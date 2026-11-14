// 与文档格式无关的领域层：解析结果契约（ParsedDocument）与所有解析器共用的文本工具。
// 只做纯计算与结构定义，不读写文件、不访问 DOM、不依赖具体格式；解析器按此口径产出统一模型。
// 失败语义：非法定位符统一抛 OfficeError("invalid_anchor")，由上层转成模型可见的错误文本。
import {
  OfficeError,
  TEXT_BUDGET,
  type DocKind,
  type DocxBlockKey,
  type OutlineItem,
} from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";

/** One search hit: a locator in the document and a short snippet around the match. */
// 搜索命中：at 是规范 locator 文本（可直接拼回 anchor），snippet 是截断后的一行上下文，不是全文。
export interface Hit {
  at: string;
  snippet: string;
}

/** A page of model-facing text. `next` is the cursor for the following page, or null at the end. */
// 一页模型可见文本：text 已按字节预算分页；next 为下一页游标，null 表示已到末尾（调用方据此停止翻页）。
export interface ReadPage {
  text: string;
  next: number | null;
}

/** A parsed document, independent of its format. */
// 与格式无关的解析结果契约：四个方法都作用于同一份内存模型；read/check 对非法 locator 统一抛 invalid_anchor。
// 实现方不变量：outline 中每个 at 都必须能被自身 check 接受，units 的口径与 outline 一致。
export interface ParsedDocument {
  kind: DocKind;
  title: string | null;
  units: number;
  outline: OutlineItem[];
  /** Model-facing text for a location (null = the whole document), paged by `cursor`. */
  read(locator: Locator | null, cursor: number): ReadPage;
  /** 忽略大小写的子串搜索，limit 为硬上限；无匹配返回空数组而不是 null。 */
  search(query: string, limit: number): Hit[];
  /** Check that a locator points inside this document and return its canonical form; throws invalid_anchor otherwise. */
  check(locator: Locator): Locator;
  /** docx only: body block keys the panel uses to map rendered elements back to locators. */
  blocks?: DocxBlockKey[];
}

// 统一空白口径：连续空白压成单空格并去首尾，用于标题、摘要与搜索展示；不改变大小写。
// 输入任意字符串、输出单行文本；不抛错，空串归一后仍是空串，可安全用作比较键。
// 纯函数且幂等，重复调用结果不变；不做 Unicode 归一，避免改变原文语义。
export const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** Case-insensitive search that returns match positions in `text`. */
// 大小写不敏感的子串匹配：返回所有命中起点（最多 50 个），供 snippet 与搜索排序使用。
// 空查询返回空数组；每次前进 needle.length，保证不重叠匹配且不会死循环。
// 纯函数、无副作用；50 的上限是防御性截断，避免病态文本产生海量命中。
export function matchAll(text: string, query: string): number[] {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  // 空查询会退化成无限匹配，直接短路返回。
  if (!needle) return positions;
  for (
    let i = haystack.indexOf(needle);
    i >= 0 && positions.length < 50;
    i = haystack.indexOf(needle, i + needle.length)
  )
    positions.push(i);
  return positions;
}

// 围绕命中位置取上下文窗口（默认前后各 60 字符），两端被裁剪时加省略号。
// index/length 由 matchAll 提供；结果经 cut 保证不切断代理对，并压缩空白成单行。
// index 越界时按 0 处理，返回文本开头的一段；不抛错，调用方无需先校验命中范围。
export function snippet(text: string, index: number, length: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? "…" : ""}${normalise(cut(text, start, end))}${end < text.length ? "…" : ""}`;
}

/**
 * Join units into a budgeted page. A unit larger than the budget is cut with a note, so a single
 * page always makes progress.
 */
// 按字节预算把单元拼成一页：单元之间空行分隔，预算内尽量多装；next 指向未消费的第一个单元。
// 单单元超预算时截断并附提示，保证每次调用至少前进一页，不会出现空页或原地打转。
// cursor 越界按 0 处理；空单元数组返回空文本且 next 为 null。
export function paginate(units: string[], cursor: number, budget = TEXT_BUDGET): ReadPage {
  const parts: string[] = [];
  let used = 0;
  let index = Math.max(0, cursor);
  for (; index < units.length; index++) {
    const unit = units[index];
    const size = Buffer.byteLength(unit);
    // 只在已装入内容后才因预算中断；否则超长单元永远无法开始。
    if (parts.length && used + size > budget) break;
    if (size > budget) {
      parts.push(
        `${truncateBytes(unit, budget)}\n[… truncated; read a narrower location to see the rest]`,
      );
      index++;
      break;
    }
    parts.push(unit);
    used += size + 2;
  }
  return { text: parts.join("\n\n"), next: index < units.length ? index : null };
}

// 按 UTF-8 字节预算截断：返回值保证 byteLength ≤ budget，且不切断代理对。
// budget ≤ 0 时返回空串；已满足预算则原样返回，不做拷贝。
// 按 UTF-8 字节而非字符计数，因此结果字符数可能明显少于 budget；不抛错。
export function truncateBytes(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  let end = Math.min(text.length, budget);
  // 字节数与字符数不同（中文与 emoji 更宽），按比例回退直到满足字节预算。
  while (end > 0 && Buffer.byteLength(cut(text, 0, end)) > budget) end = Math.floor(end * 0.9);
  return cut(text, 0, end);
}

// 单格清洗：压缩空白并把 "|" 转义为 "\|"，空值补一个空格，否则 markdown 表格的列会塌陷。
const cellText = (value: string) => normalise(value).replace(/\|/g, "\\|") || " ";

/** Render rows as a GitHub-flavoured markdown table (first row as header). */
// 渲染 GitHub 风格表格：首行作表头，列宽按最长行补齐，缺失单元格用空格填充以保证表格合法。
// 行数为 0 时返回空串；不抛错，非法输入由调用方在更早的解析阶段拦截。
// 单元格内的管道符与换行不转义，调用方需在解析阶段清洗，否则表格结构会被破坏。
export function markdownTable(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => cellText(row[i] ?? ""));
  const [head, ...body] = rows.map(pad);
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Clamp a 1-based range to `count` units, throwing a helpful error when it starts past the end. */
// 1-based 闭区间收口：起点越界抛 invalid_anchor 并附总数，便于模型修正锚点；终点夹到 count。
// 不校验 to ≥ from：若 to 小于 from 会得到空区间，语义由上层决定（通常表示无内容）。
// count ≤ 0 时任何 from 都越界并抛错；成功返回的区间端点均落在 [1, count] 内。
export function clampRange(from: number, to: number, count: number, noun: string) {
  if (from > count)
    throw new OfficeError(
      "invalid_anchor",
      `${noun} ${from} does not exist; the document has ${count} ${noun}s.`,
    );
  return { from, to: Math.min(to, count) };
}
