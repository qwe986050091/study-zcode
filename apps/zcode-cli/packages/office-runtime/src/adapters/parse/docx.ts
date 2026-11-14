// INV-01 解析只处理字节：守住位置 依赖范围；改错故障 解析器耦合文件系统或 DOM。
// INV-02 解压走统一入口：守住位置 打开包调用；改错故障 解压总量限制被绕过。
// INV-03 缺正文即判损坏：守住位置 空值检查；改错故障 空文档被当成成功。
// INV-04 样式表缺失可容忍：守住位置 读样式早退；改错故障 无样式文档整体失败。
// INV-05 段落编号按出现顺序：守住位置 计数拼接；改错故障 锚点重复或跳号。
// INV-06 表格编号独立计数：守住位置 独立数组长度；改错故障 段落与表格锚点冲突。
// INV-07 标题推导分级优先：守住位置 直接级别判断；改错故障 正文被误判为标题。
// INV-08 样式继承链有上限：守住位置 深度循环；改错故障 环引用导致卡死。
// INV-09 可见文本排除删除与域码：守住位置 分支跳过；改错故障 修订内容混入正文。
// INV-10 符号不产出字符：守住位置 空分支；改错故障 出现乱码字形。
// INV-11 单元格文本按段落拼接：守住位置 逐行收集；改错故障 单元格内换行丢失。
// INV-12 嵌套表格递归取文本：守住位置 递归调用；改错故障 嵌套内容整块漏掉。
// INV-13 空段落渲染占位：守住位置 空文本分支；改错故障 锚点行完全消失。
// INV-14 标题渲染至少一个井号：守住位置 级别兜底；改错故障 零级标题没有前缀。
// INV-15 大纲只收前三且有文字：守住位置 过滤条件；改错故障 空标题进入目录。
// INV-16 标题优先文档属性：守住位置 取值顺序；改错故障 首段正文冒充标题。
// INV-17 定位越界统一报错：守住位置 表与单元格检查；改错故障 越界返回空块。
// INV-18 搜索按块顺序且达到上限即停：守住位置 循环中断；改错故障 命中数量失控。
//
// 模块职责：解析 Word 文档为块模型、大纲与可检索的模型文本。
// 状态所有权：无状态；块表与索引只在单次解析内存在。
// 阅读顺序：先看模型与样式读取，再看标题推导与文本提取，最后看解析入口与定位搜索。
// Word（.docx）解析器：读取 OOXML 正文与样式，产出段落/表格块、大纲与按预算分页的模型文本。
// 边界：只解析字节，不碰文件系统与 DOM；zip 解压走 ooxml.ts 的统一入口并受解压总量限制。
// 失败语义：缺 document.xml 或解压失败 → corrupt_file，超限 → file_too_large；不做宽松降级。
import { OfficeError, type OutlineItem } from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import {
  clampRange,
  markdownTable,
  matchAll,
  normalise,
  paginate,
  snippet,
  type Hit,
  type ParsedDocument,
} from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import {
  attr,
  child,
  childrenOf,
  coreTitle,
  find,
  findAll,
  kids,
  openPackage,
  parseXml,
  tagOf,
  textOf,
  type XNode,
} from "#office/adapters/parse/ooxml.ts";

// 解析后的最小段落模型：at 是稳定定位串 `p:<序号>`（从 1 起，按段落出现顺序编号），
// text 已去掉行尾空白；list 表示编号/项目符号段落，渲染时前缀 "- "。
// Paragraph 只保留渲染与 read/search 需要的字段，不带 XML 原始节点。
// at 锚点串与 read/search 返回值同源，都是 p:<序号>。
// heading 由 w:outlineLvl 直接格式或 basedOn 样式链推导。
// list 只影响渲染时的 "- " 前缀，不改变 text 内容。
interface Paragraph {
  // 固定为 "paragraph"，用于与表格块区分。
  type: "paragraph";
  // 锚点定位串，read/search 返回的 at 与此一致。
  at: string;
  // 段落纯文本（可见文字，不含修订删除与域代码）。
  text: string;
  /** 0 = title, 1–9 = heading level, undefined = body text. */
  heading?: number;
  // list 判定：直接编号 w:numPr 或样式名含 List，二者其一。
  list: boolean;
}

// 表格块：rows 为逐行逐格的纯文本，单元格内多个段落以换行拼接；at 形如 `t:<序号>`。
interface Table {
  type: "table";
  at: string;
  rows: string[][];
}

// 文档体按顺序切成的块：段落或表格，供 read 渲染与 search 定位。
type Block = Paragraph | Table;

// 样式表条目：name 是显示名（如 "Heading 1"），outline 为大纲级别（0 起），
// basedOn 指向父样式 id，用于在样式名不直观时沿继承链推断标题级别。
interface Style {
  name: string;
  outline?: number;
  basedOn?: string;
}

// 解析 word/styles.xml 为 styleId → Style；xml 缺失（或文件不存在）时返回空 Map，不视为错误。
// 名称缺省回退到 styleId；outlineLvl 缺省为 undefined，表示该样式未声明大纲级别。
// word/styles.xml 缺失时 readStyles 返回空 Map，不抛 corrupt_file。
// w:name 缺失时 name 回退到 w:styleId。
// w:outlineLvl 缺失时 outline 保持 undefined，表示未声明级别。
// basedOn 只记录父样式标识，继承链由 headingLevel 逐级解析。
async function readStyles(xml: string | null): Promise<Map<string, Style>> {
  const styles = new Map<string, Style>();
  if (!xml) return styles;
  for (const style of findAll(parseXml(xml), "w:style")) {
    const id = attr(style, "w:styleId");
    if (!id) continue;
    const name = attr(child(style, "w:name") ?? {}, "w:val") ?? id;
    const pPr = child(style, "w:pPr");
    const outline = pPr && attr(child(pPr, "w:outlineLvl") ?? {}, "w:val");
    const basedOn = attr(child(style, "w:basedOn") ?? {}, "w:val");
    styles.set(id, { name, outline: outline === undefined ? undefined : Number(outline), basedOn });
  }
  return styles;
}

// 推断段落标题级别：优先直接格式 w:outlineLvl（0 起且 <9，返回级别 +1）；
// 否则沿样式继承链 basedOn 逐级查找，最多 10 层防环：
// 样式名 Title → 0（文档标题），Heading N → N，样式声明的 outline → outline+1；
// 全部未命中返回 undefined，视为正文。
// headingLevel 先看 direct（w:outlineLvl），命中即返回 direct + 1。
// direct 未命中时沿 basedOn 链最多追 10 层，depth 上限防环。
// 样式名 Title 映射到 0，Heading N 映射到 N。
// basedOn 链全部未命中返回 undefined，按正文渲染。
function headingLevel(styles: Map<string, Style>, styleId: string | undefined, direct?: number) {
  if (direct !== undefined && direct < 9) return direct + 1;
  for (let id = styleId, depth = 0; id && depth < 10; depth++) {
    const style = styles.get(id);
    if (!style) break;
    if (/^title$/i.test(style.name)) return 0;
    const named = /^heading\s*(\d)$/i.exec(style.name);
    if (named) return Number(named[1]);
    if (style.outline !== undefined && style.outline < 9) return style.outline + 1;
    id = style.basedOn;
  }
  return undefined;
}

// 提取 run 容器的可见文本：w:t 取文本，w:tab/ptab → \t，w:br/cr → 换行，不间断连字符 → "-"；
// w:sym 符号不产出字符（字形不可控，避免乱码）；修订删除（w:del）、域代码与段落/字符属性整棵跳过；
// 其余容器节点递归下钻，未知标签按透明容器处理。
/** Visible text of a run container: w:t, tabs and breaks; deleted text and field codes are skipped. */
function runText(nodes: XNode[]): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:t")
      out += kids(node)
        .map((item) => textOf(item) ?? "")
        .join("");
    else if (tag === "w:tab" || tag === "w:ptab") out += "\t";
    else if (tag === "w:br" || tag === "w:cr") out += "\n";
    else if (tag === "w:noBreakHyphen") out += "-";
    else if (tag === "w:sym") out += "";
    else if (
      tag === "w:del" ||
      tag === "w:instrText" ||
      tag === "w:delText" ||
      tag === "w:pPr" ||
      tag === "w:rPr"
    )
      continue;
    else if (tag !== "#text") out += runText(kids(node));
  }
  return out;
}

// 单元格文本：按内部段落逐行拼接（换行分隔），嵌套表格递归取其各单元格文本；
// 属性节点 w:tcPr 跳过，最终结果 trim。
function cellText(cell: XNode): string {
  const lines: string[] = [];
  const walk = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === "w:p") lines.push(runText(kids(node)));
      else if (tag === "w:tbl")
        for (const row of findAll(kids(node), "w:tc")) lines.push(cellText(row));
      else if (tag !== "w:tcPr") walk(kids(node));
    }
  };
  walk(kids(cell));
  return lines.join("\n").trim();
}

// 块的纯文本视图：表格把每行以空格拼成一行，用于概览与定位校验。
function blockText(block: Block): string {
  return block.type === "paragraph" ? block.text : block.rows.map((row) => row.join(" ")).join(" ");
}

// 渲染单个块：统一加 `[锚点]` 前缀——表格后接 Markdown 表格；空段落输出 "(empty)"；
// 标题按级别输出 # 号（至少 1 个），列表段落前缀 "- "，其余原样输出。
function renderBlock(block: Block): string {
  if (block.type === "table") return `[${block.at}]\n${markdownTable(block.rows)}`;
  const text = block.text.trim();
  if (!text) return `[${block.at}] (empty)`;
  if (block.heading !== undefined)
    return `[${block.at}] ${"#".repeat(Math.max(1, block.heading))} ${text}`;
  return `[${block.at}] ${block.list ? "- " : ""}${text}`;
}

// 解析 .docx：读 word/document.xml 正文与 word/styles.xml 样式，构建块列表及段落/表格索引。
// 遍历忽略节属性等非内容节点，但会下钻 sdt（内容控件）、customXml 与 smartTag，保证控件内文字不丢；
// 段落 at 前缀 p:、表格 t:，均按出现顺序从 1 编号。
// outline 仅收 heading 1–3 且有文字的段落（最多 200 条）；标题优先 core.xml，其次首个有文字的标题段落。
// 失败：非 zip / 缺 document.xml → corrupt_file；解压后超限 → file_too_large。
// parseDocx 分别解析 word/document.xml 与 word/styles.xml。
// 缺 word/document.xml 直接抛 corrupt_file。
// sdt、customXml、smartTag 等包装层必须下钻，否则控件内文字丢失。
export async function parseDocx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {
  const pkg = await openPackage(bytes, label);
  const xml = await pkg.text("word/document.xml");
  if (!xml) throw new OfficeError("corrupt_file", `${label} has no word/document.xml.`);
  const styles = await readStyles(await pkg.text("word/styles.xml"));
  const body = find(parseXml(xml), "w:body");
  const blocks: Block[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];

  const walk = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === "w:p") {
        const pPr = child(node, "w:pPr");
        const styleId = pPr && attr(child(pPr, "w:pStyle") ?? {}, "w:val");
        const outline = pPr && attr(child(pPr, "w:outlineLvl") ?? {}, "w:val");
        const style = styleId ? styles.get(styleId)?.name : undefined;
        const paragraph: Paragraph = {
          type: "paragraph",
          at: `p:${paragraphs.length + 1}`,
          text: runText(kids(node)).replace(/\s+$/, ""),
          heading: headingLevel(
            styles,
            styleId,
            outline === undefined ? undefined : Number(outline),
          ),
          list: Boolean(pPr && child(pPr, "w:numPr")) || /^list/i.test(style ?? ""),
        };
        paragraphs.push(paragraph);
        blocks.push(paragraph);
      } else if (tag === "w:tbl") {
        const rows = childrenOf(node, "w:tr").map((row) =>
          findAll(kids(row), "w:tc").map(cellText),
        );
        const table: Table = { type: "table", at: `t:${tables.length + 1}`, rows };
        tables.push(table);
        blocks.push(table);
      } else if (tag === "w:sdt") {
        // 内容控件只是包装层，必须下钻 sdtContent，否则控件内的正文会整体漏掉。
        walk(kids(child(node, "w:sdtContent") ?? {}));
      } else if (tag === "w:customXml" || tag === "w:smartTag") {
        walk(kids(node));
      }
    }
  };
  walk(body ? kids(body) : []);

  // 大纲只保留 1–3 级标题，且必须有非空文字；label 归一化后截断 120 字，最多 200 条。
  const outline: OutlineItem[] = paragraphs
    .filter((p) => p.heading !== undefined && p.heading <= 3 && p.text.trim())
    .slice(0, 200)
    .map((p) => ({
      at: p.at,
      label: cut(normalise(p.text), 0, 120),
      level: Math.max(1, p.heading!),
    }));
  // 标题优先文档属性；否则取首个有文字的标题段落（含 Title 样式，可能 heading=0），都没有则 null。
  const title =
    (await coreTitle(pkg)) ??
    paragraphs.find((p) => p.heading !== undefined && p.text.trim())?.text.trim() ??
    null;

  // 按定位器选块：null → 全部块；paragraph 按段落区间（clamp 到合法范围）；
  // table 返回整表或单个单元格（锚点形如 t:N/rRcC）。
  // 非 docx 定位、表索引越界或单元格越界 → OfficeError("invalid_anchor")。
  function select(locator: Locator | null): Block[] {
    if (!locator) return blocks;
    if (locator.kind !== "docx")
      throw new OfficeError("invalid_anchor", "Not a Word document location.");
    if (locator.type === "paragraph") {
      const { from, to } = clampRange(locator.from, locator.to, paragraphs.length, "paragraph");
      return paragraphs.slice(from - 1, to);
    }
    const table = tables[locator.table - 1];
    if (!table)
      throw new OfficeError(
        "invalid_anchor",
        `Table ${locator.table} does not exist; the document has ${tables.length}.`,
      );
    if (!locator.cell) return [table];
    const value = table.rows[locator.cell.row - 1]?.[locator.cell.col - 1];
    if (value === undefined)
      throw new OfficeError(
        "invalid_anchor",
        `Cell r${locator.cell.row}c${locator.cell.col} is outside ${table.at}.`,
      );
    return [
      {
        type: "paragraph",
        at: `${table.at}/r${locator.cell.row}c${locator.cell.col}`,
        text: value,
        list: false,
      },
    ];
  }

  // 返回格式无关的文档模型；check 只做定位校验并原样返回 locator，不产生内容。
  return {
    kind: "docx",
    title,
    units: blocks.length,
    outline,
    blocks: blocks.map((block) => ({
      at: block.at,
      text: cut(normalise(blockText(block)), 0, 400),
    })),
    read(locator, cursor) {
      return paginate(select(locator).map(renderBlock), cursor);
    },
    check(locator) {
      select(locator);
      return locator;
    },
    // 按块顺序扫描：段落取首个命中；表格逐格定位到 t:N/rRcC；达到 limit 立刻停止。
    search(query, limit) {
      const hits: Hit[] = [];
      for (const block of blocks) {
        if (block.type === "paragraph") {
          for (const index of matchAll(block.text, query)) {
            hits.push({ at: block.at, snippet: snippet(block.text, index, query.length) });
            break;
          }
        } else {
          block.rows.forEach((row, r) =>
            row.forEach((value, c) => {
              const index = matchAll(value, query)[0];
              if (index !== undefined)
                hits.push({
                  at: `${block.at}/r${r + 1}c${c + 1}`,
                  snippet: snippet(value, index, query.length),
                });
            }),
          );
        }
        if (hits.length >= limit) break;
      }
      return hits.slice(0, limit);
    },
  };
}
