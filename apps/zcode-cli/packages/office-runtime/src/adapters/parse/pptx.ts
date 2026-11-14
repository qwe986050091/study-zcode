// PowerPoint（.pptx）解析器：按幻灯片顺序抽取形状文本、表格与演讲者备注，并生成大纲。
// 边界：只读 zip 内的 presentation/slide/notes 部件，不解码图片、不解析动画与版式坐标。
// 失败语义：缺少 presentation.xml 或解压超限 → corrupt_file / file_too_large；单个形状异常只跳过该形状。
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
  readRels,
  tagOf,
  textOf,
  type Package,
  type XNode,
} from "#office/adapters/parse/ooxml.ts";

// 幻灯片上的一个可读元素：id/name 来自 cNvPr（shape 定位串用 id），kind 决定渲染与搜索方式；
// picture 的 text 是图片替代描述，table 用 rows 承载二维文本，group 的 text 汇总成员内容。
// placeholder 为占位符类型（如 title/body），用于识别标题与备注正文。
interface Shape {
  // cNvPr 的 id，定位串 slide:N/shape:<id> 用它匹配 Locator.shape。
  id: string;
  // 作者命名的可读名称，仅用于渲染标签。
  name: string;
  // 元素类型；"other" 表示未识别的 graphicFrame 内容。
  kind: "text" | "picture" | "table" | "chart" | "group" | "connector" | "other";
  // 占位符类型（title/ctrTitle/body 等）；普通形状无此字段。
  placeholder?: string;
  // 文本内容；表格形状为空串，图片为 "(image)" 或 "(image: 描述)"。
  text: string;
  // 仅表格形状存在：逐行逐格的文本。
  rows?: string[][];
}

// 一张幻灯片：index 为 1 起的解析顺序号（真实放映顺序由 presentation.xml 的 sldId 决定），
// hidden 由 p:sld 的 show="0" 判定；title 取标题占位符文本（可能为 null）；notes 为备注页正文。
interface Slide {
  // 解析顺序号，与 slides 数组下标 +1 一致。
  index: number;
  // 是否在放映中隐藏。
  hidden: boolean;
  // 标题占位符文本（已归一化）；没有标题时为 null。
  title: string | null;
  // 该页全部形状（组合成员已展开）。
  shapes: Shape[];
  // 备注页正文（仅 body 占位符），没有备注时为空串。
  notes: string;
}

// 提取文本框内段落文本：每个 a:p 一行，run（a:r）与域（a:fld）取 a:t 文本，a:br 转换行；
// 段落间以 \n 连接并 trim；空文本框返回 ""。
function paragraphsText(txBody: XNode | undefined): string {
  if (!txBody) return "";
  return childrenOf(txBody, "a:p")
    .map((paragraph) => {
      let line = "";
      for (const node of kids(paragraph)) {
        const tag = tagOf(node);
        if (tag === "a:r" || tag === "a:fld") {
          const t = child(node, "a:t");
          line += t
            ? kids(t)
                .map((item) => textOf(item) ?? "")
                .join("")
            : "";
        } else if (tag === "a:br") line += "\n";
      }
      return line;
    })
    .join("\n")
    .trim();
}

// 遍历 spTree 的一层子节点并按标签分派为 Shape：
// p:sp 文本框、p:pic 图片（文字用替代描述）、p:cxnSp 连接线、p:graphicFrame 表格或图表；
// p:grpSp 先递归读取成员，再在最前面插入一个汇总成员文本的组合 Shape，
// 让点击组合（阅读器命中目标）时也能看到内容；其余标签一律跳过。
function readShapes(nodes: XNode[], out: Shape[]) {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!["p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp"].includes(tag)) continue;
    const nv = kids(node).find((item) => tagOf(item).startsWith("p:nv"));
    const cNvPr = nv && child(nv, "p:cNvPr");
    const id = (cNvPr && attr(cNvPr, "id")) ?? "";
    const name = (cNvPr && attr(cNvPr, "name")) ?? "";
    const ph = nv && find(kids(nv), "p:ph");
    const placeholder = ph ? (attr(ph, "type") ?? "body") : undefined;
    if (tag === "p:sp") {
      out.push({
        id,
        name,
        kind: "text",
        placeholder,
        text: paragraphsText(child(node, "p:txBody")),
      });
    } else if (tag === "p:pic") {
      const descr = cNvPr && attr(cNvPr, "descr");
      out.push({
        id,
        name,
        kind: "picture",
        placeholder,
        text: descr ? `(image: ${descr})` : "(image)",
      });
    } else if (tag === "p:cxnSp") {
      out.push({ id, name, kind: "connector", text: "" });
    } else if (tag === "p:graphicFrame") {
      // graphicFrame 内含 a:tbl 视为表格；否则按 graphicData 的 uri 判定是否为图表。
      const table = find(kids(node), "a:tbl");
      if (table) {
        const rows = childrenOf(table, "a:tr").map((row) =>
          childrenOf(row, "a:tc").map((cell) => paragraphsText(child(cell, "a:txBody"))),
        );
        out.push({ id, name, kind: "table", text: "", rows });
      } else {
        const data = find(kids(node), "a:graphicData");
        const uri = (data && attr(data, "uri")) ?? "";
        out.push({
          id,
          name,
          kind: /chart/i.test(uri) ? "chart" : "other",
          text: /chart/i.test(uri) ? "(chart)" : "",
        });
      }
    } else if (tag === "p:grpSp") {
      // The group carries its members' text so a click on the group (the viewer's hit target) reads well.
      const members: Shape[] = [];
      readShapes(kids(node), members);
      const text = members
        .map((member) =>
          member.rows ? member.rows.map((row) => row.join(" | ")).join("\n") : member.text,
        )
        .filter(Boolean)
        .join("\n");
      out.push({ id, name, kind: "group", text }, ...members);
    }
  }
}

// 读取备注页正文：从幻灯片的 rels 中找 type 以 /notesSlide 结尾的关系；
// 关系缺失或 XML 读不到时返回 ""（备注非必需内容）。
// 只收集 placeholder 为 body 的形状文本，标题/页码等占位符不计入。
async function readNotes(pkg: Package, slidePath: string): Promise<string> {
  const rels = await readRels(pkg, slidePath);
  const notes = [...rels.values()].find((rel) => rel.type.endsWith("/notesSlide"));
  if (!notes) return "";
  const xml = await pkg.text(notes.target);
  if (!xml) return "";
  const shapes: Shape[] = [];
  readShapes(kids(find(parseXml(xml), "p:spTree") ?? {}), shapes);
  return shapes
    .filter((shape) => shape.placeholder === "body")
    .map((shape) => shape.text)
    .join("\n")
    .trim();
}

// 渲染单个形状：统一 `[shape:<id> <kind> "名称"]` 前缀；
// 表格在前缀后接 Markdown 表格；多行文本逐行缩进两格，保持可读性。
function renderShape(shape: Shape): string {
  const label = `[shape:${shape.id} ${shape.kind}${shape.name ? ` "${shape.name}"` : ""}]`;
  if (shape.kind === "table" && shape.rows) return `${label}\n${markdownTable(shape.rows)}`;
  if (!shape.text) return label;
  return shape.text.includes("\n")
    ? `${label}\n${shape.text.replace(/^/gm, "  ")}`
    : `${label} ${shape.text}`;
}

// 渲染整页：`## Slide N[: 标题][ (hidden)]`，随后按层序输出形状；
// 默认过滤组合 Shape（内容已由其成员展开呈现），仅当只渲染该组合时才保留；
// 完整页末尾附 Speaker notes。
function renderSlide(slide: Slide, only?: Shape): string {
  const head = `## Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""}${slide.hidden ? " (hidden)" : ""}`;
  const shapes = (only ? [only] : slide.shapes).filter((shape) => shape.kind !== "group" || only);
  const parts = [head, ...shapes.map(renderShape)];
  if (!only && slide.notes) parts.push(`Speaker notes: ${slide.notes}`);
  return parts.join("\n");
}

// 解析 .pptx：读 ppt/presentation.xml 的 sldId 顺序，经 rels 定位各 slide XML 逐页构建。
// sldId 缺关系或 XML 缺失时跳过该页（不中断整体）；hidden 由 p:sld 的 show="0" 判定。
// index 为解析成功的顺序号（1 起），与数组下标一致；title 取 title/ctrTitle 占位符文本。
// outline 每页一条（level 1），缺标题时 label 回退为 "Slide N"。
// 失败：非 zip / 缺 presentation.xml → corrupt_file；解压超限 → file_too_large。
export async function parsePptx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {
  const pkg = await openPackage(bytes, label);
  const presentationXml = await pkg.text("ppt/presentation.xml");
  if (!presentationXml)
    throw new OfficeError("corrupt_file", `${label} has no ppt/presentation.xml.`);
  const rels = await readRels(pkg, "ppt/presentation.xml");
  // sldId 的 r:id 必须经 rels 才能拿到真实部件路径；关系丢失的页直接跳过。
  const slideIds = findAll(parseXml(presentationXml), "p:sldId");
  const slides: Slide[] = [];
  for (const slideId of slideIds) {
    const rel = rels.get(attr(slideId, "r:id") ?? "");
    if (!rel) continue;
    const xml = await pkg.text(rel.target);
    if (!xml) continue;
    const doc = parseXml(xml);
    const root = find(doc, "p:sld");
    const shapes: Shape[] = [];
    readShapes(kids(find(doc, "p:spTree") ?? {}), shapes);
    const titleShape = shapes.find(
      (shape) => shape.placeholder === "title" || shape.placeholder === "ctrTitle",
    );
    slides.push({
      index: slides.length + 1,
      hidden: root ? attr(root, "show") === "0" : false,
      title: titleShape?.text ? normalise(titleShape.text) : null,
      shapes,
      notes: await readNotes(pkg, rel.target),
    });
  }

  const outline: OutlineItem[] = slides.map((slide) => ({
    at: `slide:${slide.index}`,
    label: slide.title ?? `Slide ${slide.index}`,
    level: 1,
  }));

  // 按定位器选页：null → 全部页；slide 区间 clamp 后逐页渲染；
  // 指定 shape 时只渲染该页的该形状，id 不存在则报 invalid_anchor 并列出可用 id。
  function select(locator: Locator | null): string[] {
    if (!locator) return slides.map((slide) => renderSlide(slide));
    if (locator.kind !== "pptx")
      throw new OfficeError("invalid_anchor", "Not a presentation location.");
    const { from, to } = clampRange(locator.from, locator.to, slides.length, "slide");
    if (locator.shape) {
      const slide = slides[from - 1];
      const shape = slide.shapes.find((item) => item.id === locator.shape);
      if (!shape)
        throw new OfficeError(
          "invalid_anchor",
          `Slide ${from} has no shape ${locator.shape}. Shapes: ${slide.shapes.map((item) => item.id).join(", ") || "none"}.`,
        );
      return [renderSlide(slide, shape)];
    }
    return slides.slice(from - 1, to).map((slide) => renderSlide(slide));
  }

  // 返回格式无关的文档模型；标题优先 core.xml，其次首页标题，都没有则 null。
  return {
    kind: "pptx",
    title: (await coreTitle(pkg)) ?? slides[0]?.title ?? null,
    units: slides.length,
    outline,
    read: (locator, cursor) => paginate(select(locator), cursor),
    check: (locator) => (select(locator), locator),
    // 搜索跳过组合 Shape（避免与成员重复命中），并额外匹配备注文本（snippet 标注 "(notes)"）。
    search(query, limit) {
      const hits: Hit[] = [];
      for (const slide of slides) {
        for (const shape of slide.shapes) {
          if (shape.kind === "group") continue;
          const text = shape.rows
            ? shape.rows.map((row) => row.join(" | ")).join("\n")
            : shape.text;
          const index = matchAll(text, query)[0];
          if (index !== undefined)
            hits.push({
              at: `slide:${slide.index}/shape:${shape.id}`,
              snippet: snippet(text, index, query.length),
            });
        }
        // 备注也算命中，但定位到整页，snippet 前缀 "(notes)" 与形状命中区分开。
        const index = matchAll(slide.notes, query)[0];
        if (index !== undefined)
          hits.push({
            at: `slide:${slide.index}`,
            snippet: `(notes) ${snippet(slide.notes, index, query.length)}`,
          });
        if (hits.length >= limit) break;
      }
      return hits.slice(0, limit);
    },
  };
}
