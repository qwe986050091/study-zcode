// office-runtime 的对外契约层：集中定义跨进程/跨包共享的常量、结构类型与错误码。
// 只依赖 profile 与 kinds，不引入 adapter/app/ui，保证服务端与面板都能安全引用。
// 口径固定：路径均为工作区相对 POSIX 路径，所有序号 1-based，错误码稳定可分支、message 仅供展示。
import { ALL_KINDS, type DocKind } from "#office/kinds.ts";
import { PROFILE } from "#office/profile.ts";

// 重新导出 kinds 的类型与常量，上层只需依赖 contract 即可拿到格式信息。
export { ALL_KINDS, type DocKind };

// 插件版本号，取自 profile.version；宿主与设置面板据此判断版本兼容性。
export const PLUGIN_VERSION = PROFILE.version;
// MCP server 名，同时作为 UI surface 的标识，二者必须保持一致。
export const SERVER_NAME = PROFILE.name;
// UI surface id；宿主用它把 panel 资源请求路由到本插件。
export const SURFACE_ID = PROFILE.name;
// panel 页面 URI：ui://<name>/panel.html，宿主按此加载 HTML 视图。
export const PANEL_URI = `ui://${PROFILE.name}/panel.html`;
// 静态资源前缀：panel 内的字体与 pdf.js 资源都经此读取，避免出现绝对文件路径。
export const ASSET_PREFIX = `ui://${PROFILE.name}/assets/`;
// 文件分块读取前缀；实际地址为 `${FILE_PREFIX}${token}/${index}`，index 从 0 开始。
export const FILE_PREFIX = `ui://${PROFILE.name}/file/`;
// panel 的 MIME 类型，宿主据此识别 MCP App 页面并注入对应运行时。
export const HTML_MIME = "text/html;profile=mcp-app";

// 本插件可打开的格式白名单，从 profile 复制为只读数组。
// 其他模块（kindOf、wording、server 描述）均以此为准，增删格式需同步 profile。
/** Formats this plugin opens. */
export const DOC_KINDS: readonly DocKind[] = PROFILE.kinds;

// 单文件字节上限；超限在读取字节前即拒绝，避免把大文件读入内存。
/** Files larger than this are refused before any parsing. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
// 解压后总字节上限，用于 docx / xlsx / pptx 包，防止 zip 炸弹耗尽内存。
/** Total uncompressed size allowed for a docx / xlsx / pptx package (zip-bomb guard). */
export const MAX_UNZIPPED_BYTES = 512 * 1024 * 1024;
// 单次文件分块的原始字节数；经 base64 后仍低于宿主 8 MiB 的资源读取上限。
/** Raw bytes per file chunk; base64 stays well inside the host's 8 MiB resource-read limit. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;
// 单个模型可见工具结果中文本部分的预算，低于宿主 32 KiB 的 content 上限，留出余量给其他字段。
/** Budget for the text part of one model-facing tool result (the host caps `content` at 32 KiB). */
export const TEXT_BUDGET = 24 * 1024;

// 大纲条目：at 为同文档内的定位符，level 从 1 开始用于渲染缩进。
/** One entry of a document outline; `at` is a locator inside the same document. */
export interface OutlineItem {
  // 文档内定位符，语法随文档格式而定（docx p:N / pdf page:N / xlsx Sheet!A1）。
  at: string;
  // 展示用标题文本，允许为空字符串。
  label: string;
  // 层级深度，1 表示顶层；渲染时按非负值处理。
  level: number;
}

// 文档打开后向 panel 与模型暴露的元信息，不含正文；正文由 read_document 按定位符读取。
/** What the panel and the model learn about a document when it is opened. */
export interface DocumentInfo {
  // 工作区相对路径（正斜杠），同时作为定位符前缀。
  path: string;
  // 文档格式，决定 units 与 outline 的语义。
  kind: DocKind;
  // 文档标题；解析不到时为 null，不能据此判定打开失败。
  title: string | null;
  // 文件字节数，用于展示与结果预算判断。
  bytes: number;
  // 内容指纹（sha256 前 16 位），用于判断文档是否已变化。
  revision: string;
  // 计量单位数量，单位随 kind 变化；0 表示空文档。
  /** pdf pages, pptx slides, xlsx sheets, docx paragraphs + tables. */
  units: number;
  // 大纲条目，按文档顺序排列；空数组表示没有可用大纲。
  outline: OutlineItem[];
}

// 文件分块句柄：panel 按 `${FILE_PREFIX}${token}/${index}` 逐块拉取，index 取值 0..chunks-1。
/** File transport for the panel: read `${FILE_PREFIX}${token}/${index}` for each chunk. */
export interface FileHandle {
  // 本次读取会话的随机令牌，关闭文档后失效，不可复用。
  token: string;
  // 分块总数，至少为 1（空文件也占一块）。
  chunks: number;
  // 原始文件字节数，用于分块校验与进度展示。
  bytes: number;
}

// docx 正文块键：panel 渲染出的元素借此映射回定位符。
/** docx body block as the panel needs it to map rendered elements back to locators. */
export interface DocxBlockKey {
  // 该块的定位符，如 p:12、t:3。
  at: string;
  // 块内纯文本，用于点击后回填引用；可能为空。
  text: string;
}

// 用户选区：at 为起点定位符，text 为选中或引用的文本。
/** A user selection reported by the panel. `at` is a locator, `text` the selected or quoted text. */
export interface Selection {
  // 选区起点定位符；整篇选择时仍是合法定位符。
  at: string;
  // 选中的文本，可能为空字符串（例如只有光标位置）。
  text: string;
}

// panel 上报的视图状态：当前文档、可见位置与选区，供模型了解用户在看哪里。
/** Where the user is in the viewer, reported by the panel. */
export interface ViewState {
  // 当前打开的文档路径；未打开任何文档时为 null。
  path: string | null;
  // 当前文档格式，与 path 同步为 null。
  kind: DocKind | null;
  // 可见位置定位符；尚未滚动或空文档时为 null。
  /** Visible position, e.g. `page:3`, `slide:2`, `Revenue!A1`. */
  at: string | null;
  // 当前选区；无选区时为 null。
  selection: Selection | null;
  // 上报时间戳（毫秒），用于判断状态是否过期。
  updatedAt: number;
}

// panel 需要揭示并高亮的单个位置；quote 存在时优先高亮该引用文本。
/** One place for the panel to reveal and highlight. */
export interface ShowTarget {
  // 定位符，语法由文档格式决定。
  at: string;
  // 可选引用文本，用于在目标内部精确高亮；不传则高亮整个目标。
  quote?: string;
}

// 所有涉及 viewer 的模型/panel 工具结果的 structuredContent。
/** structuredContent of every model / panel tool result that concerns the viewer. */
export interface ViewerSnapshot {
  // 当前文档信息；无文档时为 null，此时不应消费 reveal。
  document: DocumentInfo | null;
  // open_document / show 写入的揭示指令；seq 递增，panel 据此忽略重复消费的旧指令。
  /** Set by open_document / show: where the panel should go and what to highlight. */
  reveal?: { targets: ShowTarget[]; note?: string; seq: number };
}

// 错误码对外稳定，调用方按 code 分支处理；message 仅供展示，不得用于程序判断。
// invalid_path / path_outside_workspace 为路径校验；not_found / unsupported_type / file_too_large 为文件可用性；
// corrupt_file 表示解析失败，invalid_anchor 表示定位符无效，invalid_token / invalid_resource 用于导入与资源读取。
export type OfficeErrorCode =
  | "invalid_path"
  | "path_outside_workspace"
  | "not_found"
  | "unsupported_type"
  | "file_too_large"
  | "corrupt_file"
  | "invalid_anchor"
  | "no_document"
  | "invalid_token"
  | "invalid_resource";

// 带错误码的插件错误：继承 Error 以便统一抛出，code 属于对外契约。
// 构造时同时设置 name 为 "OfficeError"，便于宿主日志与面板错误分类识别；message 只用于展示。
// 捕获方应优先读取 code 做分支，不要把 message 当作稳定协议；跨进程传输时 code 会被原样保留。
export class OfficeError extends Error {
  // code 稳定可分支；message 面向模型与用户可读，不参与匹配。
  constructor(
    readonly code: OfficeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OfficeError";
  }
}

// 依据扩展名判断格式，大小写不敏感；返回 null 表示本插件不处理该文件。
// 只看扩展名、不校验内容，也不检查文件是否存在，后续读取失败由调用方报错。
// 入参可以是任意路径（含 URL 片段），只取最后一个小写扩展名；不抛错，未收录格式返回 null。
/** The format of `path` if this plugin opens it, else null. */
export function kindOf(path: string): DocKind | null {
  const ext = path.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return (DOC_KINDS as readonly string[]).includes(ext ?? "") ? (ext as DocKind) : null;
}

// 列表连接词按语言区分：英文用逗号加 and/or，中文用顿号加“和/或”。
const LIST_WORDS = {
  en: { sep: ", ", and: " and ", or: " or " },
  "zh-CN": { sep: "、", and: "和", or: "或" },
} as const;

// 把字符串列表拼成自然语言枚举：少于 2 项时直接拼接，空数组返回空串。
// 中文下仅当末尾词以 ASCII 可打印字符开头时才在连接词两侧加空格，以兼顾中英文混排。
// 纯格式化函数：不排序、不去重、不截断，语言与连接词只影响分隔符；调用方需保证 items 可展示。
/** `a, b and c` (or `a, b or c`) in English or Chinese. */
export function joinList(
  items: readonly string[],
  lang: "en" | "zh-CN" = "en",
  joiner: "and" | "or" = "and",
): string {
  const words = LIST_WORDS[lang];
  if (items.length < 2) return items.join("");
  const last = items[items.length - 1];
  // Chinese puts spaces around 和 / 或 only next to Latin words: "PowerPoint 和 PDF", "单元格或幻灯片".
  const word = lang === "zh-CN" && /^[\x20-\x7e]/.test(last) ? ` ${words[joiner]} ` : words[joiner];
  return `${items.slice(0, -1).join(words.sep)}${word}${last}`;
}

// 生成本插件支持格式的扩展名列表，形如 “.docx, .xlsx, .pptx and .pdf”。
// 顺序跟随 DOC_KINDS，保证各插件对外文案一致。
// 只映射格式名，不查文件；lang/joiner 透传 joinList，空格式集返回空串而非报错。
/** `.docx, .xlsx, .pptx and .pdf` (or `… or .pdf`) for the formats this plugin opens. */
export function extensionList(lang: "en" | "zh-CN" = "en", joiner: "and" | "or" = "and"): string {
  return joinList(
    DOC_KINDS.map((kind) => `.${kind}`),
    lang,
    joiner,
  );
}
