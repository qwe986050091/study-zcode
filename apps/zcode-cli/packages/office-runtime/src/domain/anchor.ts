// 定位符（anchor）领域：`<工作区相对路径>#<locator>` 是面板、服务端与模型共用的地址格式。
// 本文件只做字符串与结构之间的双向转换，不解析文档内容、不校验文档是否存在。
// 所有下标均为 1-based 闭区间；非法输入统一抛 OfficeError("invalid_anchor"/"unsupported_type")，不做宽松回退。
import { OfficeError, kindOf, type DocKind } from "#office/contract.ts";

/**
 * Anchors are the shared address format of the panel, the server and the model:
 * `<workspace-relative path>#<locator>`. Locators depend on the document kind. Indices are 1-based.
 *
 *   docx  p:14 · p:3-9 · t:2 · t:2/r3c1
 *   pptx  slide:3 · slide:2-4 · slide:3/shape:7
 *   pdf   page:5 · page:2-4
 *   xlsx  Revenue · Revenue!B2 · Revenue!B2:F9 · 'Q3 data'!A1
 */
// 单元格坐标：row/col 均为 1-based；上限 row ≤ 1_048_576、col ≤ 16_384，越界在 parseCell 处被拒绝。
// 该结构同时用于 locator 的起止点与面板回传的选区，字段不可为空或 0。
export interface CellRef {
  row: number;
  col: number;
}

// 各格式定位器的联合类型；所有区间均为 1-based 闭区间，from 与 to 可以相等。
// 不变量：xlsx 的 range 保证 start 是左上、end 是右下（parseXlsx 已归一反向框选）；pptx 的 shape 为形状 id 字符串。
export type Locator =
  // docx 段落区间：from/to 为段落序号。
  | { kind: "docx"; type: "paragraph"; from: number; to: number }
  // docx 表格：table 为表格序号，cell 缺省表示整表。
  | { kind: "docx"; type: "table"; table: number; cell?: CellRef }
  // pptx 幻灯片区间；shape 存在时只指向该页内某个形状。
  | { kind: "pptx"; from: number; to: number; shape?: string }
  // pdf 页区间。
  | { kind: "pdf"; from: number; to: number }
  // xlsx 工作表名 + 可选矩形区域；无 range 表示整张表。
  | { kind: "xlsx"; sheet: string; range?: { start: CellRef; end: CellRef } };

// 构造统一的 invalid_anchor 错误：文案固定以 "Cannot read location" 开头并附该格式用法提示，便于模型自我修正。
// 抛错而非返回 null，是因为调用方（owner/server）需要把稳定 code 传给工具结果。
const invalid = (text: string, hint: string) =>
  new OfficeError("invalid_anchor", `Cannot read location "${text}". ${hint}`);

// 每种格式的合法定位写法提示，直接进入错误消息；改动时需同步 parseLocator 的正则与工具描述文案。
const HINTS: Record<DocKind, string> = {
  docx: "Use p:N, p:N-M, t:N or t:N/rRcC.",
  pptx: "Use slide:N, slide:N-M or slide:N/shape:ID.",
  pdf: "Use page:N or page:N-M.",
  xlsx: "Use Sheet, Sheet!A1 or Sheet!A1:C9 (quote names with spaces: 'My sheet'!A1).",
};

// 解析 "N" 或 "N-M" 区间文本：缺省 to 等于 from；匹配失败、非正数、to < from 或超过上限一律抛 invalid_anchor。
// 返回 1-based 闭区间；不修改入参，也不做"错误猜测"式的部分解析。
function span(text: string, match: RegExpMatchArray | null, kind: DocKind) {
  if (!match) throw invalid(text, HINTS[kind]);
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  // 上限 1_000_000 是防御性夹紧：真实文档远小于此，超出应视为输入错误而不是超大文档。
  if (!(from >= 1) || !(to >= from) || to > 1_000_000) throw invalid(text, HINTS[kind]);
  return { from, to };
}

// 列号 → 列名（1 → A、26 → Z、27 → AA）；1-based，0 或负数返回空串，调用方需保证入参合法。
// 与 parseCell 的解析方向互逆，用于渲染表格表头与格式化 locator。
// 只处理正整数的十进制展开，不抛错；超出 Excel 上限仍能算出名字，上限校验留给 parseCell。
export function columnName(col: number): string {
  let name = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

// 解析 Excel 单元格引用（允许 $ 绝对引用），返回 1-based {row,col}；格式非法或超出 Excel 上限返回 null。
// 返回 null 而非抛错，因为调用方常把它当作"是不是单元格引用"的判定（如 formatSheet 的歧义检查）。
// 入参必须已 trim 且不含工作表前缀；大小写不敏感，列字母会统一转为大写后再计算。
export function parseCell(text: string): CellRef | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text);
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  const row = Number(match[2]);
  // 超出 Excel 实际上限视为非法引用，避免构造超大区间拖垮渲染与分页。
  if (row < 1 || row > 1_048_576 || col > 16_384) return null;
  return { row, col };
}

// {row,col} → "B2" 文本；与 parseCell 互逆，要求入参已通过范围校验。
// 输出不带 $ 与工作表名；不校验范围，入参越界会产出色域外的列名。
// 调用方若要用于 anchor 文本，应先经 parseCell 往返验证，避免把非法坐标写入缓存键。
export const formatCell = (cell: CellRef) => `${columnName(cell.col)}${cell.row}`;

/** Quote a sheet name the way Excel does when it is not a plain identifier. */
// 工作表名格式化：纯标识符且不与单元格引用混淆时原样返回，否则加单引号并把内部单引号翻倍（Excel 规则）。
// 该输出可直接回填到 anchor 文本中并被 parseXlsx 反向解析。
// 空名或含换行等不可引用字符也走加引号分支；不抛错，保证任何表名都能产出可读 locator。
export function formatSheet(name: string): string {
  return /^[A-Za-z_À-￿][\w.À-￿]*$/.test(name) && !parseCell(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}

// 解析 xlsx 定位：'带引号的工作表'!A1:B2 与裸名 Sheet!A1 两种形态。
// 引号内 '' 表示字面单引号；工作表名上限 64 字符（Excel 限制）；矩形区域自动归一为左上/右下。
// 任何形态不完整（缺 '!'、缺单元格、名过长）都抛 invalid_anchor，不做宽松回退。
function parseXlsx(text: string): Locator {
  let sheet: string;
  let rest: string;
  if (text.startsWith("'")) {
    let i = 1;
    sheet = "";
    for (; i < text.length; i++) {
      if (text[i] === "'") {
        // 单引号内的成对 '' 是转义后的字面量，需还原为一个 '。
        if (text[i + 1] === "'") {
          sheet += "'";
          i++;
        } else break;
      } else sheet += text[i];
    }
    if (i >= text.length) throw invalid(text, HINTS.xlsx);
    rest = text.slice(i + 1);
    if (rest && !rest.startsWith("!")) throw invalid(text, HINTS.xlsx);
    rest = rest.slice(1);
  } else {
    // 未加引号时以最后一个 '!' 分隔，允许未加引号的工作表名本身包含 '!'。
    const bang = text.lastIndexOf("!");
    sheet = bang < 0 ? text : text.slice(0, bang);
    rest = bang < 0 ? "" : text.slice(bang + 1);
  }
  // 空名或超过 Excel 的 64 字符上限，直接视为非法定位。
  if (!sheet || sheet.length > 64) throw invalid(text, HINTS.xlsx);
  if (!rest) return { kind: "xlsx", sheet };
  const [a, b = a] = rest.split(":");
  const start = parseCell(a);
  const end = parseCell(b);
  if (!start || !end) throw invalid(text, HINTS.xlsx);
  // 反向框选（B9:A1）也归一成左上/右下，保证下游渲染、搜索与缓存键口径一致。
  return {
    kind: "xlsx",
    sheet,
    range: {
      start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
      end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
    },
  };
}

// 按格式把文本 locator 解析成结构：先 trim 并限制 300 字符，再按该格式的正则匹配。
// 任何不匹配都抛 invalid_anchor 并附该格式用法提示，不做启发式猜测；不同格式的正则不互相兜底。
// 解析成功时保证端点顺序、行号/列号均在上限内，后续渲染与查找可直接信任结构。
export function parseLocator(kind: DocKind, raw: string): Locator {
  const text = raw.trim();
  // 空串或超长串在正则之前拦截，避免无意义匹配与回溯开销。
  if (!text || text.length > 300) throw invalid(raw, HINTS[kind]);
  switch (kind) {
    case "docx": {
      const table = /^t:(\d+)(?:\/r(\d+)c(\d+))?$/i.exec(text);
      if (table) {
        const index = Number(table[1]);
        if (index < 1) throw invalid(text, HINTS.docx);
        if (table[2] === undefined) return { kind, type: "table", table: index };
        const cell = { row: Number(table[2]), col: Number(table[3]) };
        if (cell.row < 1 || cell.col < 1) throw invalid(text, HINTS.docx);
        return { kind, type: "table", table: index, cell };
      }
      return {
        kind,
        type: "paragraph",
        ...span(text, /^p:(\d+)(?:-(?:p:)?(\d+))?$/i.exec(text), kind),
      };
    }
    case "pptx": {
      const shape = /^slide:(\d+)\/shape:([\w-]{1,32})$/i.exec(text);
      if (shape) {
        const slide = Number(shape[1]);
        if (slide < 1) throw invalid(text, HINTS.pptx);
        return { kind, from: slide, to: slide, shape: shape[2] };
      }
      return { kind, ...span(text, /^slide:(\d+)(?:-(?:slide:)?(\d+))?$/i.exec(text), kind) };
    }
    case "pdf":
      return { kind, ...span(text, /^page:(\d+)(?:-(?:page:)?(\d+))?$/i.exec(text), kind) };
    case "xlsx":
      return parseXlsx(text);
  }
}

// Locator → 文本，与 parseLocator 互逆；单点区间输出 "p:3" 而不是 "p:3-3"，保证 anchor 文本稳定、可直接作缓存键。
// 不校验范围合法性（由 check/parse 阶段负责），因此对任意结构都能产出可读文本。
// 输出不包含路径，也不包含 '#'；调用方需自行拼接 formatAnchor 才得到完整地址。
export function formatLocator(locator: Locator): string {
  const range = (prefix: string, from: number, to: number) =>
    from === to ? `${prefix}:${from}` : `${prefix}:${from}-${to}`;
  switch (locator.kind) {
    case "docx":
      if (locator.type === "paragraph") return range("p", locator.from, locator.to);
      return locator.cell
        ? `t:${locator.table}/r${locator.cell.row}c${locator.cell.col}`
        : `t:${locator.table}`;
    case "pptx":
      return locator.shape
        ? `slide:${locator.from}/shape:${locator.shape}`
        : range("slide", locator.from, locator.to);
    case "pdf":
      return range("page", locator.from, locator.to);
    case "xlsx": {
      const sheet = formatSheet(locator.sheet);
      if (!locator.range) return sheet;
      const { start, end } = locator.range;
      const a = formatCell(start);
      const b = formatCell(end);
      return a === b ? `${sheet}!${a}` : `${sheet}!${a}:${b}`;
    }
  }
}

/** Split `<path>#<locator>`; the path ends at the first supported extension followed by `#` or the end. */
// 拆分 anchor：路径在第一个受支持的扩展名处结束，因此路径内含 '#' 也能正确切分。
// 无 '#' 或 location 为空（含纯空白）时 at 返回 null，表示整篇文档；扩展名不受支持则抛 invalid_anchor。
// 路径部分不做工作区越界校验，只做锚点语法拆分；at 为原文（未 trim）还是 null 由 formatAnchor 消费。
export function splitAnchor(anchor: string): { path: string; at: string | null } {
  const match = /^(.*?\.(?:docx|xlsx|pptx|pdf))(?:#(.*))?$/i.exec(anchor.trim());
  if (!match) {
    throw new OfficeError(
      "invalid_anchor",
      `"${anchor}" is not a document anchor. Use <path>.docx|.xlsx|.pptx|.pdf optionally followed by #<location>.`,
    );
  }
  return { path: match[1], at: match[2]?.trim() ? match[2].trim() : null };
}

// 组装 anchor：at 为空（null/undefined/空串）时只返回路径，避免产出 "path#" 这种半成品锚点。
// 该函数是输出侧唯一入口，保证工具结果里的 anchor 都能被 splitAnchor 原样还原。
// 不校验 at 语法，也不校验 path 是否在工作区；无效 at 会被下游 parseLocator 统一拒绝。
export function formatAnchor(path: string, at: string | null | undefined): string {
  return at ? `${path}#${at}` : path;
}

/** Parse a full anchor and its locator in one step. */
// 一步得到 path/kind/locator：扩展名不受支持抛 unsupported_type，locator 非法由 parseLocator 抛 invalid_anchor。
// locator 为 null 表示整篇文档，调用方不得把 null 当成"第一处"的等价物。
// kind 由扩展名唯一决定，不读取文件内容；路径校验（存在性/越界）由文件适配器另行负责。
export function parseAnchor(anchor: string): {
  path: string;
  kind: DocKind;
  locator: Locator | null;
} {
  const { path, at } = splitAnchor(anchor);
  const kind = kindOf(path);
  if (!kind) throw new OfficeError("unsupported_type", `Unsupported document type: ${path}`);
  return { path, kind, locator: at ? parseLocator(kind, at) : null };
}
