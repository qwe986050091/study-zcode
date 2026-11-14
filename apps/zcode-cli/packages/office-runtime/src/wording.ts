// 面向模型的英文文案：把本插件开放的格式拼成文件名、扩展名、定位符示例等提示片段。
// 所有片段按 DOC_KINDS 过滤，未启用格式不会出现在工具描述里；模块加载时求值一次，随 profile 固定。
// 纯值模块，无副作用；修改时必须保持“一个格式一个顺序（Word、Excel、PowerPoint、PDF）”的口径。
import { DOC_KINDS, extensionList, joinList, type DocKind } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

/**
 * Model-facing wording that names formats, limited to the formats this plugin opens. Each list
 * keeps one order for every plugin: Word, Excel, PowerPoint, PDF.
 */
// 按 DOC_KINDS 过滤并取出文案片段，保证未启用的格式不会出现在模型提示里。
// 同一格式可以出现多次（如 pptx 的 slide 与 shape），过滤后顺序保持不变。
const pick = (items: [DocKind, string][]) =>
  items.filter(([kind]) => DOC_KINDS.includes(kind)).map(([, text]) => text);
// 格式到品牌名的映射，用于生成自然语言提示，顺序与 DOC_KINDS 无关。
const FORMAT_NAMES = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF" } as const;
// 排除 PDF 后的 Office 格式集合，用于判断能否统一称呼为 “Office”。
const officeKinds = DOC_KINDS.filter((kind) => kind !== "pdf");
// 可合并的格式族：三种 Office 格式齐全时称 “Office”，否则逐个列出；PDF 单独成项。
/** "Office" when the plugin opens all three Office formats, else their own names; then "PDF". */
const families = [
  ...(officeKinds.length === 3 ? ["Office"] : officeKinds.map((kind) => FORMAT_NAMES[kind])),
  ...(DOC_KINDS.includes("pdf") ? ["PDF"] : []),
];

// 插件标题，取自 profile 的英文标题，作为工具描述中的产品名。
export const TITLE = PROFILE.title.en;

// 生成带不定冠词的单个文件说法：按首词首字母是否为元音选择 a / an。
// 模块加载时求值一次，结果随 DOC_KINDS 变化，调用方不要缓存旧值。
/** "an Office or PDF file", "a PDF file", "an Excel file". */
export const FILE_NOUN = (() => {
  const words = joinList(families, "en", "or");
  return `${/^[AEIOU]/.test(words) ? "an" : "a"} ${words} file`;
})();

// 复数说法，始终以 “files” 结尾；families 为空时退化为 “ files”。
/** "Office and PDF files", "PDF files", "Excel files". */
export const FILES_NOUN = `${joinList(families)} files`;

// 扩展名列表的“或”版本，用于提示用户可接受的格式。
/** ".docx, .xlsx, .pptx or .pdf". */
export const EXTENSIONS_OR = extensionList("en", "or");

// 定位符示例，按支持的格式拼接；未启用格式自动剔除，可能得到空串。
/** "report.docx#p:12, model.xlsx#Revenue!B2:F9, deck.pptx#slide:3, paper.pdf#page:5". */
export const EXAMPLE_ANCHORS = pick([
  ["docx", "report.docx#p:12"],
  ["xlsx", "model.xlsx#Revenue!B2:F9"],
  ["pptx", "deck.pptx#slide:3"],
  ["pdf", "paper.pdf#page:5"],
]).join(", ");

// 仅位置部分的示例，展示各格式定位符语法；与 EXAMPLE_ANCHORS 顺序不同。
/** "p:12, slide:3, page:5, Revenue!B2:F9". */
export const EXAMPLE_LOCATIONS = pick([
  ["docx", "p:12"],
  ["pptx", "slide:3"],
  ["pdf", "page:5"],
  ["xlsx", "Revenue!B2:F9"],
]).join(", ");

// read_document 各格式返回内容的说明，用于工具描述；未启用格式自动剔除。
/** What read_document returns for each format. */
export const READ_FORMS = pick([
  ["docx", "Word paragraphs and tables (markdown)"],
  ["xlsx", "spreadsheet cells as a grid with formulas"],
  ["pptx", "slides with their shapes and speaker notes"],
  ["pdf", "PDF page text"],
]).join(", ");

// show / capture 的目标名词列表；pptx 同时贡献 slide 与 shape，因此可能出现两项同格式。
/** "paragraph, cell range, slide, shape or page". */
export const TARGET_NOUNS = joinList(
  pick([
    ["docx", "paragraph"],
    ["xlsx", "cell range"],
    ["pptx", "slide"],
    ["pptx", "shape"],
    ["pdf", "page"],
  ]),
  "en",
  "or",
);

// 适合整段引用的对象；所有相关格式都未启用时回退为通用说法 “long passages”。
/** "PDF pages and long paragraphs". */
export const QUOTE_BEST_FOR =
  joinList(
    pick([
      ["pdf", "PDF pages"],
      ["docx", "long paragraphs"],
    ]),
  ) || "long passages";

// capture_view 的定位符示例，用 “or” 连接；未启用格式自动剔除。
/** capture_view examples: "deck.pptx#slide:3, paper.pdf#page:2, report.docx#p:12 or model.xlsx#Revenue!A1:H30". */
export const CAPTURE_EXAMPLES = joinList(
  pick([
    ["pptx", "deck.pptx#slide:3"],
    ["pdf", "paper.pdf#page:2"],
    ["docx", "report.docx#p:12"],
    ["xlsx", "model.xlsx#Revenue!A1:H30"],
  ]),
  "en",
  "or",
);
