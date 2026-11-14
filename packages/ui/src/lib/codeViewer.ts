/* eslint-disable max-lines -- codeViewer 集中维护文件、文本、图片和 diff 预览提取；本次只收敛 tool identity，不顺手拆文件以免扩大回归面。 */
// ============ 职责边界 ============
// 做：把 tool call、diff、文件、文本、图片、媒体、PDF、PPTX 的展示信息归一成 CodeViewerSource，
// 并推导语言、媒体类型、diff 目标文件与原文件预览入口。
// 不做：不读文件、不发起请求、不渲染、不持久化；不解析 git 仓库状态，也不做安全校验。
// 依赖：shiki 的 BundledLanguage 类型；@zcode/shared 的媒体格式判定；path、toolDiffPreview、
// toolIdentity 的纯函数。
// 边界：所有导出都是纯函数，相同输入必须得到相同输出；不得读写全局状态或环境变量。
//
// ============ INV 不变量表 ============
// INV-01 断言：预览优先级恒为结构化 diff、显式 patch、before/after、文本、图片、文件 —— 守住它的位置：getToolCallCodePreview 的分支顺序 —— 改错故障：变更视图退化成全文预览，用户看不到改动范围。
// INV-02 断言：路径必须先解码 URI 转义再判绝对路径 —— 守住它的位置：resolveViewerPath 的前两行 —— 改错故障：转义斜杠被当普通字符，路径拼接错位。
// INV-03 断言：相对路径必须有 workspacePath 才能解析 —— 守住它的位置：createDiffSourceFilePreviewSource 的守卫 —— 改错故障：按本地 CWD 拼路径，读到错误文件。
// INV-04 断言：原文件预览必须透传远程身份字段 —— 守住它的位置：createDiffSourceFilePreviewSource 的返回 —— 改错故障：远程 workspace 按本地路径读取，手机远控直接失败。
// INV-05 断言：读取工具取 output、写入工具取 input —— 守住它的位置：preferredContent 三元链 —— 改错故障：写入预览显示旧内容，用户误判修改未生效。
// INV-06 断言：结构化 diff 的 buildUnifiedDiff 失败必须回落文本 —— 守住它的位置：getToolCallCodePreview 的 patch 判空 —— 改错故障：返回 null，预览整块消失。
// INV-07 断言：扩展名优先于 shebang，shebang 优先于 diff 嗅探 —— 守住它的位置：inferCodeLanguage 的判定顺序 —— 改错故障：脚本内容被错误语言高亮。
// INV-08 断言：未知扩展名必须回落 log 而不是抛错 —— 守住它的位置：inferCodeLanguage 的末尾 —— 改错故障：预览因无法识别语言而整体不可用。
// INV-09 断言：媒体类型缺失必须返回 null 而不是空串 —— 守住它的位置：inferImageMediaType 的返回 —— 改错故障：调用方的 !== null 判断失效，图片分支被误触发。
// INV-10 断言：图片后缀表的值必须是完整 IANA 媒体类型 —— 守住它的位置：IMAGE_EXTENSION_TO_MEDIA_TYPE —— 改错故障：浏览器拒绝渲染，表现为空白而非报错。
// INV-11 断言：diff 目标优先新路径、其次旧路径 —— 守住它的位置：parseDiffGitLinePath 的取值顺序 —— 改错故障：删除文件的旧路径抢占，预览指向不存在的文件。
// INV-12 断言：diff 头解析顺序为 diff --git 与 +++ 先行、--- 兜底 —— 守住它的位置：getPatchHeaderFileTarget 的两轮扫描 —— 改错故障：旧路径覆盖新路径，打开错误版本。
// INV-13 断言：/dev/null 永远不能作为 diff 目标 —— 守住它的位置：isUsableDiffFileTarget —— 改错故障：新增或删除文件被当作普通文件打开。
// INV-14 断言：有引号的 diff 路径不得按制表符切分 —— 守住它的位置：parseDiffHeaderPath 的分支 —— 改错故障：含空格的路径被截断，预览定位错误。
// INV-15 断言：显式 path 优先于 patch 头解析 —— 守住它的位置：getDiffSourceFileTarget 的首个分支 —— 改错故障：历史路径覆盖当前路径。
// INV-16 断言：工具标题为空才回落到路径末段 —— 守住它的位置：normalizeToolLabel —— 改错故障：有标题的工具被显示成文件名，语义丢失。
// INV-17 断言：字段候选顺序即优先级，只能追加不能插队 —— 守住它的位置：extractContentText 与 extractDiffText 的数组 —— 改错故障：结构化结果抢占正文，预览显示 JSON 片段。
// INV-18 断言：纯空白字符串视为缺失 —— 守住它的位置：findStringField 与 normalizeToolLabel 的 trim 判断 —— 改错故障：空白标题或内容被当成有效值。
// INV-19 断言：looksLikeDiff 必须使用多行模式 —— 守住它的位置：正则的 m 标志 —— 改错故障：多行 patch 判不出，全部退化为纯文本。
// INV-20 断言：CodeViewerSource 的 type 是判别字段，重命名需同步持久化数据 —— 守住它的位置：联合类型与各接口的 type —— 改错故障：历史 viewer tab 反序列化后展示成错误类型。
//
// ============ 阅读提示 ============
// 本文件是展示投影层，改动只应影响「怎么展示」，不应改变工具执行语义。
// 优先级顺序与路径解析顺序都是契约，重构时不要为了减少分支而重排。
import type { BundledLanguage } from "shiki";
import { getMediaPreviewFormat, type MediaPreviewKind } from "@zcode/shared";
import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import {
  decodeFilePathUriEscapes,
  getPathLeaf,
  isAbsoluteFilePath,
  joinFilePath,
} from "@/lib/path.js";
import {
  buildUnifiedDiff,
  extractBeforeAfter,
  extractStructuredDiff,
} from "@/lib/toolDiffPreview.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
} from "@/lib/toolIdentity.js";

// [契约] 这里只做转出，不重新实现 diff 构建，调用方的 import 路径依赖该出口稳定。
// [权衡] 保留转出是为了让 UI 侧无需直接依赖 toolDiffPreview 的内部路径。
// [失败路径] 若在此包一层并改变参数顺序，所有既有调用点会静默生成错误的 patch 文本。
// [边界] 本出口不暴露 buildUnifiedDiff 的任何选项，扩展能力应回到 toolDiffPreview。
// [契约] 删除该行会让外部模块解析失败，属于破坏性变更。
export { buildUnifiedDiff } from "@/lib/toolDiffPreview.js";

// [契约] 256KB 是文本预览的硬上限，读取侧与展示侧共用同一个常量。
// [失败路径] 两侧各写一个数字时，一侧放宽会让超大文件进入渲染并卡死页面。
// [权衡] 以字节而非字符计数，避免多字节字符让上限随语言漂移。
// [契约] 该值只描述预览阈值，不代表服务端读取上限，二者不可互相替代。
// [边界] 本文件不执行截断，只提供常量，裁剪由调用方实现。
export const FILE_VIEWER_MAX_TEXT_BYTES = 256 * 1024;
// [契约] type 固定为 file 字面量，是 CodeViewerSource 联合类型的判别字段。
// [契约] path 必填，title 仅用于展示，不得当作路径参与文件读取。
// [资源] 继承 CodeViewerWorkspaceScope，远程身份字段必须原样透传，不能在这里丢弃。
// [失败路径] 丢掉 workspaceIdentity 会让远程文件按本地路径读取，命中错误文件或直接失败。
// [边界] 该类型不携带内容，读取行为发生在调用方。
export interface FileCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "file";
  title: string;
  path: string;
}

// [契约] startLine 与 endLine 是 1-based 行号，缺省表示整文件锚点。
// [失败路径] 改成 0-based 会让所有评审锚点整体偏移一行，且 UI 不会报错。
// [契约] priority 限 0..3，越界值应由上游校验，本层不做兜底。
// [权衡] 用可选字段而非默认值，是为了区分「未指定」与「显式指定 0」。
// [边界] 本类型不承载评论内容的状态，只描述定位。
export interface CodeReviewAnchor {
  requestId: string;
  title: string;
  body: string;
  priority?: 0 | 1 | 2 | 3;
  startLine?: number;
  endLine?: number;
}

export interface CodeReviewCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "code-review";
  title: string;
  path: string;
  review: CodeReviewAnchor;
}

export interface TextCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "text";
  title: string;
  path?: string;
  content: string;
  language: BundledLanguage;
}

export interface PatchCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "patch";
  title: string;
  path?: string;
  patch: string;
}

export interface MultiFileDiffCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "multi-file-diff";
  title: string;
  path?: string;
  beforeContent: string;
  afterContent: string;
}
export interface ImageCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "image";
  title: string;
  path: string;
  mediaType: string;
}

export interface MediaCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "media";
  title: string;
  path: string;
  kind: MediaPreviewKind;
  mediaType: string;
  url?: string;
}

export interface PdfCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "pdf";
  title: string;
  path: string;
}

export interface PptxCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "pptx";
  title: string;
  path: string;
  referenceNavigation?: PptxReferencePreviewNavigation;
}

export interface PptxReferencePreviewNavigation {
  requestId: string;
  pageIndex: number;
  expectedSourceFingerprint: string;
}

// [契约] 这是判别联合，新增成员必须补齐所有分支，否则会落入默认分支。
// [契约] type 取值是跨模块契约，重命名需要同步持久化的 viewer tab 数据。
// [失败路径] 合并两个相近成员会让历史 tab 反序列化后展示成错误类型。
// [权衡] 用联合而非 string，是为了让遗漏分支在编译期暴露。
// [边界] 本类型不含渲染组件，映射关系在 UI 层维护。
export type CodeViewerSource =
  | FileCodeViewerSource
  | CodeReviewCodeViewerSource
  | TextCodeViewerSource
  | PatchCodeViewerSource
  | MultiFileDiffCodeViewerSource
  | ImageCodeViewerSource
  | MediaCodeViewerSource
  | PdfCodeViewerSource
  | PptxCodeViewerSource;

// [契约] 键必须是小写扩展名且不含点，查表前统一转小写。
// [契约] 缺省回落到 log，不要抛错，未知扩展名应仍可查看。
// [失败路径] 把 h 映射成 cpp 而非 c 会改变高亮与注释符，影响复制出的代码语义。
// [权衡] 手写映射而非引入语言检测库，是为了可预测且零运行时依赖。
// [边界] 只影响高亮，不影响任何读取或写入。
const EXTENSION_TO_LANGUAGE: Record<string, BundledLanguage> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  diff: "diff",
  go: "go",
  h: "c",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mermaid: "mermaid",
  mmd: "mermaid",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  text: "log",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

// [契约] 值与 IANA 媒体类型一致，svg 必须是 image/svg+xml 而不是 image/svg。
// [失败路径] 媒体类型写错会让浏览器拒绝渲染，且错误表现为空白而非报错。
// [契约] 该表只覆盖图片，媒体与 PDF 走 getMediaPreviewFormat 与后缀判断。
// [权衡] 与 inferImageMediaType 的返回值强绑定，新增扩展名需同时确认调用方分支。
// [边界] 不做内容嗅探，仅凭后缀判定。
const IMAGE_EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// [契约] 优先用工具标题，标题为空才回落到路径末段，最后才是固定占位。
// [失败路径] 调换前两步会让带标题的工具在 UI 上显示成文件名，语义丢失。
// [契约] 空标题包含纯空白，必须 trim 后判断，不能用 truthy 直接判。
// [权衡] 占位文案跟随工具调用的国际化策略，不要在这里翻译。
// [边界] 本函数不校验路径是否存在。
function normalizeToolLabel(label: string, fallbackPath?: string) {
  const trimmedLabel = label.trim();
  if (trimmedLabel) {
    return trimmedLabel;
  }

  if (fallbackPath) {
    return getPathLeaf(fallbackPath);
  }

  return "Tool Preview";
}

// [契约] 按 keys 顺序返回第一个非空字符串，顺序即优先级，不能改成任意命中。
// [失败路径] 改成遍历对象自身键会让不同工具的参数名互相抢占，结果不稳定。
// [契约] 纯空白字符串视为缺失，判断时 trim，但返回的是原值而非 trim 后的值。
// [权衡] 返回原值是为了保留内容中的缩进与换行。
// [边界] 只处理一层记录，不递归嵌套结构。
function findStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return undefined;
}

// [契约] 多行模式下匹配 diff 头、文件头或 hunk 头，三者任一即可。
// [失败路径] 去掉 m 标志会让多行 patch 永远判不出来，全部退化成纯文本。
// [契约] 该判断只用于决定是否按 patch 解析，不代表内容一定是合法 diff。
// [权衡] 用宽松正则而非完整解析，是为了在流式与截断内容上也能识别。
// [边界] 误判的代价是展示成 patch，解析失败时仍需回落文本。
function looksLikeDiff(text: string): boolean {
  return /^(diff --git|--- |\+\+\+ |@@ )/m.test(text);
}

// [契约] 字符串输入必须先通过 looksLikeDiff 才接受，避免把普通文本当 patch。
// [契约] 对象输入按 diff、patch、unifiedDiff、unified_diff 的顺序取第一个非空值。
// [失败路径] 去掉 looksLikeDiff 门槛会把日志里的 diff 字样误当补丁，预览全错。
// [权衡] 字段顺序固定，新增别名只能追加到末尾，不能插队。
// [边界] 不解析 patch 内容，也不校验 hunk 行数。
function extractDiffText(value: unknown): string | undefined {
  if (typeof value === "string" && looksLikeDiff(value)) {
    return value;
  }

  return findStringField(value, ["diff", "patch", "unifiedDiff", "unified_diff"]);
}

// [契约] 字符串直接返回；对象按固定字段序列取第一个非空字符串。
// [失败路径] 把 result 或 value 提前会让结构化结果抢占正文，预览显示成 JSON 片段。
// [契约] 字段顺序是跨工具兼容契约，调整需同时核对所有工具输出。
// [权衡] 不做 JSON 序列化兜底，无法识别时返回 undefined 让上层回落。
// [边界] 不区分读取与写入语义，方向由调用方决定。
function extractContentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  return findStringField(value, [
    "content",
    "text",
    "fileContent",
    "contents",
    "code",
    "result",
    "value",
  ]);
}

function extractRawPath(value: unknown): string | undefined {
  return findStringField(value, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "targetPath",
    "target_path",
    "targetFile",
    "target_file",
    "file",
  ]);
}

function buildTextPreview(
  title: string,
  path: string | undefined,
  content: string,
): TextCodeViewerSource {
  return {
    type: "text",
    title,
    path,
    content,
    language: inferCodeLanguage(path, content),
  };
}

// [契约] 先解码 URI 转义再判断绝对路径，顺序反了会把转义斜杠当成普通字符。
// [失败路径] 解码失败会抛错，本函数不做 try/catch，调用方需保证输入来自工具结果。
// [契约] 绝对路径原样返回，相对路径必须与 workspacePath 拼接。
// [失败路径] 相对路径在 workspacePath 为空时会拼成相对 CWD 的路径，读到错误文件。
// [边界] 本函数不做路径越界校验，安全性由读取侧负责。
function resolveViewerPath(rawPath: string | undefined, workspacePath: string) {
  if (!rawPath) {
    return undefined;
  }

  const decodedPath = decodeFilePathUriEscapes(rawPath);
  if (isAbsoluteFilePath(decodedPath)) {
    return decodedPath;
  }

  return joinFilePath(workspacePath, decodedPath);
}

// [契约] 扩展名优先于 shebang，shebang 又优先于 diff 嗅探，顺序不可调换。
// [失败路径] 让 shebang 覆盖扩展名会让 .sh 文件里的 python 示例被错误高亮。
// [契约] 无扩展名且无 shebang 时回落 log，不返回 undefined。
// [权衡] 只看首行 shebang，避免扫描大文件头部带来的成本。
// [边界] 语言标识必须属于 shiki 的 BundledLanguage，拼错会在运行时才暴露。
export function inferCodeLanguage(path?: string, contentHint?: string): BundledLanguage {
  if (path) {
    const leaf = getPathLeaf(path);
    const extension = leaf.includes(".") ? leaf.split(".").pop()?.toLowerCase() : undefined;
    if (extension && EXTENSION_TO_LANGUAGE[extension]) {
      return EXTENSION_TO_LANGUAGE[extension];
    }
  }

  if (contentHint?.startsWith("#!/")) {
    if (contentHint.includes("python")) {
      return "python";
    }

    if (contentHint.includes("bash") || contentHint.includes("sh")) {
      return "bash";
    }
  }

  if (contentHint && looksLikeDiff(contentHint)) {
    return "diff";
  }

  return "log";
}

// [契约] 无路径或后缀为空返回 null，调用方据此判断「不是图片」。
// [失败路径] 返回空串而非 null 会让调用方的 !== null 判断失效。
// [契约] 后缀统一小写后查表，查不到返回 null，不做前缀猜测。
// [权衡] 只认后缀不读文件头，避免预览路径触发额外 IO。
// [边界] 与 isImagePreviewPath 共用同一判定，不要另写一套。
export function inferImageMediaType(path?: string): string | null {
  if (!path) {
    return null;
  }

  const leaf = getPathLeaf(path);
  const extension = leaf.includes(".") ? leaf.split(".").pop()?.toLowerCase() : undefined;
  if (!extension) {
    return null;
  }

  return IMAGE_EXTENSION_TO_MEDIA_TYPE[extension] ?? null;
}

// [契约] 返回的是去掉 type/title/path 的片段，供调用方展开成完整 source。
// [失败路径] 直接返回完整 source 会伪造 title 与 path，调用方覆盖时字段丢失。
// [契约] 判定完全委托 getMediaPreviewFormat，本函数不维护第二份媒体类型表。
// [权衡] 返回 null 而非 undefined，与 isImagePreviewPath 的判空口径一致。
// [边界] 不校验 url 是否可访问。
export function inferMediaPreview(
  path?: string,
): Omit<MediaCodeViewerSource, "type" | "title" | "path"> | null {
  if (!path) return null;
  const format = getMediaPreviewFormat(path);
  return format ? { kind: format.kind, mediaType: format.mediaType } : null;
}

export function isImagePreviewPath(path?: string): boolean {
  return inferImageMediaType(path) !== null;
}

export function isPdfPreviewPath(path?: string): boolean {
  if (!path) {
    return false;
  }
  return getPathLeaf(path).toLowerCase().endsWith(".pdf");
}

export function isPptxPreviewPath(path?: string): boolean {
  if (!path) {
    return false;
  }
  return getPathLeaf(path).toLowerCase().endsWith(".pptx");
}

function isUsableDiffFileTarget(target: string | null | undefined): target is string {
  const trimmedTarget = target?.trim();
  return Boolean(trimmedTarget && trimmedTarget !== "/dev/null");
}

function unquoteDiffPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length >= 2 && trimmedPath.startsWith('"') && trimmedPath.endsWith('"')) {
    return trimmedPath.slice(1, -1);
  }

  return trimmedPath;
}

function stripDiffPathPrefix(path: string): string {
  const unquotedPath = unquoteDiffPath(path);
  if (unquotedPath.startsWith("a/") || unquotedPath.startsWith("b/")) {
    return unquotedPath.slice(2);
  }

  return unquotedPath;
}

// [契约] 引号包裹的路径必须按转义规则整体取出，不能按制表符切分。
// [失败路径] 对带引号路径先 split 制表符会截断含空格的路径，预览指向错误文件。
// [契约] 非引号路径以第一个制表符为界，后半段是时间戳必须丢弃。
// [契约] 返回值已去掉 a/ 或 b/ 前缀，调用方不要再剥一次。
// [边界] 解析失败返回 null，由上层继续尝试下一个候选。
function parseDiffHeaderPath(headerValue: string): string | null {
  const trimmedValue = headerValue.trim();
  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith('"')) {
    const quotedPathMatch = trimmedValue.match(/^"((?:\\.|[^"\\])+)"/);
    return quotedPathMatch?.[1] ? stripDiffPathPrefix(quotedPathMatch[1]) : null;
  }

  const pathWithoutTimestamp = trimmedValue.split("\t", 1)[0]?.trim();
  return pathWithoutTimestamp ? stripDiffPathPrefix(pathWithoutTimestamp) : null;
}

// [契约] 必须同时兼容引号与非引号两种形态，正则里四组捕获缺一不可。
// [失败路径] 只取最后一组会让新增文件解析成 null，因为旧路径是 /dev/null。
// [契约] 优先取新路径，新路径不可用时才回退旧路径，顺序不能反。
// [权衡] 用 isUsableDiffFileTarget 统一过滤 /dev/null，避免四处重复判断。
// [边界] 本函数只处理单行，多文件 patch 的取舍在 getPatchHeaderFileTarget。
function parseDiffGitLinePath(line: string): string | null {
  const gitPathMatch = line.match(
    /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/,
  );
  const nextPath = gitPathMatch?.[3] ?? gitPathMatch?.[4];
  const previousPath = gitPathMatch?.[1] ?? gitPathMatch?.[2];
  const normalizedNextPath = nextPath ? stripDiffPathPrefix(nextPath) : null;
  if (isUsableDiffFileTarget(normalizedNextPath)) {
    return normalizedNextPath;
  }

  const normalizedPreviousPath = previousPath ? stripDiffPathPrefix(previousPath) : null;
  return isUsableDiffFileTarget(normalizedPreviousPath) ? normalizedPreviousPath : null;
}

// [契约] 第一轮优先 diff --git 与 +++ 行，第二轮才回退 --- 行，两轮顺序是契约。
// [失败路径] 合并成一轮会让删除文件的旧路径抢占新路径，打开预览指向已删文件。
// [契约] 每个候选都必须过 isUsableDiffFileTarget，/dev/null 永远不能作为目标。
// [权衡] 两轮都完整扫描，牺牲一点性能换取优先级的确定性。
// [边界] 找不到返回 null，由调用方决定是否放弃原文件预览。
function getPatchHeaderFileTarget(patch: string): string | null {
  for (const line of patch.split(/\r?\n/)) {
    const diffGitTarget = parseDiffGitLinePath(line);
    if (diffGitTarget) {
      return diffGitTarget;
    }

    if (line.startsWith("+++ ")) {
      const nextFileTarget = parseDiffHeaderPath(line.slice(4));
      if (isUsableDiffFileTarget(nextFileTarget)) {
        return nextFileTarget;
      }
    }
  }

  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ")) {
      continue;
    }

    const previousFileTarget = parseDiffHeaderPath(line.slice(4));
    if (isUsableDiffFileTarget(previousFileTarget)) {
      return previousFileTarget;
    }
  }

  return null;
}

// [契约] 显式 path 优先于 patch 头解析，因为 path 是调用方已确认的事实。
// [失败路径] 反过来会让 patch 里的历史路径覆盖当前路径，预览打开错误版本。
// [契约] 只有 patch 类型才解析头部，multi-file-diff 没有可解析的头部。
// [权衡] 多文件 diff 不猜第一个文件，避免用户看到非预期的文件。
// [边界] 返回值未做绝对路径校验。
export function getDiffSourceFileTarget(
  source: PatchCodeViewerSource | MultiFileDiffCodeViewerSource,
): string | null {
  if (isUsableDiffFileTarget(source.path)) {
    return source.path;
  }

  if (source.type === "patch") {
    return getPatchHeaderFileTarget(source.patch);
  }

  return null;
}

// [契约] 必须保留 workspacePath 与远程身份字段，这是远程 workspace 能读对文件的前提。
// [失败路径] 只传 path 会在手机远控或远程 workspace 上按本地路径读取，直接失败。
// [契约] 无 workspacePath 且目标为相对路径时返回 null，不允许拼出相对 CWD 的路径。
// [权衡] 用条件展开而非赋 undefined，避免序列化时出现显式 null 字段。
// [边界] 本函数不读取文件内容，只构造 source。
export function createDiffSourceFilePreviewSource(
  source: PatchCodeViewerSource | MultiFileDiffCodeViewerSource,
  fallbackWorkspacePath?: string,
): FileCodeViewerSource | null {
  const fileTarget = getDiffSourceFileTarget(source);
  if (!fileTarget) {
    return null;
  }

  const workspacePath = source.workspacePath ?? fallbackWorkspacePath;
  if (!isAbsoluteFilePath(fileTarget) && !workspacePath) {
    return null;
  }

  const path = resolveViewerPath(fileTarget, workspacePath ?? "");
  if (!path) {
    return null;
  }

  // diff tab 只保存 diff source；打开“原文件预览”时必须保留 workspace scope，
  // 否则远程 workspace 或手机远控会按本地路径边界去读文件。
  return {
    type: "file",
    title: getPathLeaf(path),
    path,
    ...(workspacePath ? { workspacePath } : {}),
    ...(source.workspaceIdentity ? { workspaceIdentity: source.workspaceIdentity } : {}),
    ...(source.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: source.workspaceRemoteSessionId }
      : {}),
  };
}

// [契约] 优先级固定为结构化 diff、显式 patch、before/after、文本、图片、文件，不可重排。
// [失败路径] 把文本提到 patch 之前会让带 diff 的工具只显示新内容，丢失变更视图。
// [契约] 结构化 diff 即使 buildUnifiedDiff 失败也要回落文本，不能返回 null。
// [契约] isReadTool 取 output 优先，isWriteTool 取 input 优先，方向不能对调。
// [边界] 本函数不做任何 IO，也不校验路径是否存在。
export function getToolCallCodePreview(
  toolCall: ChatToolCall,
  workspacePath: string,
): CodeViewerSource | null {
  // 结构化 diff 是工具结果的显式变更事实，优先于 input/output 中的全文预览。
  const structuredDiff = extractStructuredDiff(toolCall.raw);
  const resolvedPath = resolveViewerPath(
    structuredDiff?.path ?? extractRawPath(toolCall.input) ?? extractRawPath(toolCall.output),
    workspacePath,
  );
  const viewerTitle = normalizeToolLabel(toolCall.title ?? toolCall.kind, resolvedPath);
  const identity = resolveToolCallIdentity(toolCall);
  const isDiffTool = isFileDiffToolCall(toolCall, identity);
  const isReadTool = identity.family === "file-read";
  const isWriteTool = isFileContentWriteToolCall(toolCall, identity);

  // [契约] 结构化 diff 是工具结果的显式变更事实，必须优先于 input/output 的全文。
  // [失败路径] 让全文预览抢先会让编辑器显示整文件，用户看不到实际改动范围。
  // [契约] buildUnifiedDiff 返回空串时回落 newText 文本预览，而不是返回 null。
  // [权衡] 回落文本而非文件，避免为了展示再触发一次读取。
  // [边界] 该分支不处理二进制内容。
  if (structuredDiff) {
    const patch = buildUnifiedDiff(
      structuredDiff.oldText,
      structuredDiff.newText,
      resolvedPath ? getPathLeaf(resolvedPath) : "preview",
    );

    if (patch) {
      return {
        type: "patch",
        title: viewerTitle,
        path: resolvedPath,
        patch,
      };
    }

    return {
      ...buildTextPreview(viewerTitle, resolvedPath, structuredDiff.newText),
    };
  }

  const explicitPatch = extractDiffText(toolCall.output) ?? extractDiffText(toolCall.input);
  if (explicitPatch) {
    return {
      type: "patch",
      title: viewerTitle,
      path: resolvedPath,
      patch: explicitPatch,
    };
  }

  if (isDiffTool) {
    const beforeAfter = extractBeforeAfter(toolCall.input) ?? extractBeforeAfter(toolCall.output);
    if (beforeAfter) {
      const patch = buildUnifiedDiff(
        beforeAfter.before,
        beforeAfter.after,
        resolvedPath ? getPathLeaf(resolvedPath) : "preview",
      );

      if (patch) {
        return {
          type: "patch",
          title: viewerTitle,
          path: resolvedPath,
          patch,
        };
      }

      return {
        ...buildTextPreview(viewerTitle, resolvedPath, beforeAfter.after),
      };
    }
  }

  // [契约] 读取工具优先 output，写入工具优先 input，其余按 output 再到 input。
  // [失败路径] 两个方向写反会让写入工具预览成旧内容，用户以为修改未生效。
  // [契约] 三元链的顺序即语义，重构时必须保留读取与写入的优先差异。
  // [权衡] 不做内容合并，取第一个可用来源即可，避免拼出不属于任何一侧的文本。
  // [边界] 只处理字符串与已知字段，不解析结构化内容。
  const preferredContent = isReadTool
    ? (extractContentText(toolCall.output) ?? extractContentText(toolCall.input))
    : isWriteTool
      ? (extractContentText(toolCall.input) ?? extractContentText(toolCall.output))
      : (extractContentText(toolCall.output) ?? extractContentText(toolCall.input));

  if (preferredContent) {
    return buildTextPreview(viewerTitle, resolvedPath, preferredContent);
  }

  if (
    resolvedPath &&
    (isDiffTool || isReadTool || isWriteTool) &&
    isImagePreviewPath(resolvedPath)
  ) {
    return {
      type: "image",
      title: viewerTitle,
      path: resolvedPath,
      mediaType: inferImageMediaType(resolvedPath) ?? "application/octet-stream",
    };
  }

  if (resolvedPath) {
    return {
      type: "file",
      title: viewerTitle,
      path: resolvedPath,
    };
  }

  return null;
}

// [契约] 与 getToolCallCodePreview 共用同一套身份与优先级判定，两处改动必须同步。
// [失败路径] 只改一处会让内容预览与完整预览对同一工具给出不同结论。
// [契约] 无可用内容时返回 null，不构造空文本 source。
// [权衡] 故意不返回 patch，本函数的契约就是纯文本内容。
// [边界] 不处理图片与二进制，那些由完整预览负责。
export function getToolCallCodeContentPreview(
  toolCall: ChatToolCall,
  workspacePath: string,
): TextCodeViewerSource | null {
  const structuredDiff = extractStructuredDiff(toolCall.raw);
  const resolvedPath = resolveViewerPath(
    structuredDiff?.path ?? extractRawPath(toolCall.input) ?? extractRawPath(toolCall.output),
    workspacePath,
  );
  const viewerTitle = normalizeToolLabel(toolCall.title ?? toolCall.kind, resolvedPath);
  const identity = resolveToolCallIdentity(toolCall);
  const isDiffTool = isFileDiffToolCall(toolCall, identity);
  const isReadTool = identity.family === "file-read";
  const isWriteTool = isFileContentWriteToolCall(toolCall, identity);

  if (structuredDiff) {
    return buildTextPreview(viewerTitle, resolvedPath, structuredDiff.newText);
  }

  if (isDiffTool) {
    const beforeAfter = extractBeforeAfter(toolCall.input) ?? extractBeforeAfter(toolCall.output);
    if (beforeAfter) {
      return buildTextPreview(viewerTitle, resolvedPath, beforeAfter.after);
    }
  }

  const preferredContent = isReadTool
    ? (extractContentText(toolCall.output) ?? extractContentText(toolCall.input))
    : isWriteTool
      ? (extractContentText(toolCall.input) ?? extractContentText(toolCall.output))
      : (extractContentText(toolCall.output) ?? extractContentText(toolCall.input));

  if (!preferredContent) {
    return null;
  }

  return buildTextPreview(viewerTitle, resolvedPath, preferredContent);
}
