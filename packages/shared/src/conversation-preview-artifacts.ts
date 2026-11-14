// 会话预览产物（preview artifact）候选的推导入口：从助手正文里找出可预览的文件引用，再转成卡片候选。
// 只做「文本 → 引用 → 候选」的纯函数映射，不读磁盘、不发请求、不探测文件是否存在。
// 不负责：权限校验、真实 mime 探测（仅按扩展名映射）、卡片渲染、可达性缓存。
//
// 不变量（改动前逐条对照；只收录本文件自己能守住的约束）：
// INV-01 断言：解析结果要么是 null，要么是已归一化的绝对路径 —— 守住它的位置：resolveConversationPreviewPath 的全部 return 分支 —— 改错故障：相对路径混入候选，同名文件被误当成本轮产物。
// INV-02 断言：以 ~/ 或 ~\ 开头的路径一律不产生引用 —— 守住它的位置：resolveConversationPreviewPath 的家目录拦截 —— 改错故障：正文里演示用的 ~/x.md 被拼成 workspace 子路径，弹出打不开的预览卡。
// INV-03 断言：file URL 解析失败时返回 null 而不是原样透传 —— 守住它的位置：parseFileUrlPath 的 catch —— 改错故障：非法串继续参与后续正则，拼出带 file: 字样的假路径。
// INV-04 断言：相对路径中越出 workspace 根的 .. 使解析结果为空 —— 守住它的位置：normalizeRelativePath 的 segments 为空分支 —— 改错故障：../ 越界路径被折叠回 workspace 内，产生错误归属的文件卡片。
// INV-05 断言：扩展名匹配不区分大小写，且不复用后缀做二次推断 —— 守住它的位置：getConversationPreviewFileType —— 改错故障：.PDF / .DOCX 被整体漏掉，或歧义后缀被判成 markdown。
// INV-06 断言：citation 指令覆盖的文本区间不参与后续任何路径扫描 —— 守住它的位置：protectedRanges 与 rangesOverlap —— 改错故障：同一条 citation 被再识别成裸路径，候选里出现重复条目。
// INV-07 断言：artifact_kind 与扩展名推断冲突时丢弃该 citation，而不是以扩展名取胜 —— 守住它的位置：citation 循环中的 expectedKind 比较 —— 改错故障：声明为 document 的 pdf 被当成 docx，用错渲染器打开。
// INV-08 断言：只有 docx/xlsx/pptx/pdf/video/audio 允许走 citation 通道 —— 守住它的位置：citationKind 的多路判定 —— 改错故障：citation 声明的 md/html 绕过 fileChanges 校验，出现空预览卡。
// INV-09 断言：结果按 start 升序输出，且同一绝对路径只保留最靠后的一次出现 —— 守住它的位置：extract 末尾的排序、去重与 reverse —— 改错故障：同一文件多张卡片，或卡片顺序与正文相反。
// INV-10 断言：候选裁剪发生在去重、边界过滤与 fileChanges 过滤之后 —— 守住它的位置：候选构建末尾的 slice —— 改错故障：被规则丢弃的条目仍占满 15 个名额，真正可预览的文件被挤没。
// INV-11 断言：markdown 与 html 必须命中 active 且未被 revert 才能成为候选 —— 守住它的位置：requiresFileChanges 分支 —— 改错故障：仅被提及但未落盘的 md 出现空预览，点开是空白页。
// INV-12 断言：reverted 优先于 active，同一路径同时出现在两边时视为已回退 —— 守住它的位置：activePaths 与 revertedPaths 的联合判断 —— 改错故障：回退后的文件仍显示可预览，点开是旧内容。
// INV-13 断言：workspace 边界比较的是归一化绝对路径的「等值或前缀加斜杠」 —— 守住它的位置：isInsideWorkspace —— 改错故障：/ws 会错误包含 /ws2 下的文件，跨工作区泄漏路径。
//
// 阅读顺序：类型定义 → 扩展名映射表 → 路径归一化 → 引用抽取 → 候选构建。
// 全部入口均为同步纯函数，可在渲染层高频路径调用，但仍受候选上限保护。
// 本文件被桌面卡片、Web 预览与 CLI 共同复用，改动须保持对既有调用方兼容。
//
// 改正则前先确认 protectedRanges 的优先级：citation > markdown 链接 > file URL > 引号包裹 > 裸路径。
// 改候选构建前先确认 requiresFileChanges 与 fileChanges 的联动，否则会放出没写过也能预览的幽灵卡片。
// 本文件不写日志；失败以 null 或空数组表达，调用方不得据此推断文件不存在。
import {
  conversationArtifactTypeSchema,
  type ConversationArtifactType,
} from "./zcode-protocol-v4/rows.js";
import { MEDIA_PREVIEW_FORMATS } from "./media-preview.js";

// [契约] kind 是「选哪个预览器」的键，不是 artifactType 的从属枚举，video 与 audio 只在本文件出现。
// 新增 kind 必须同时在 PREVIEW_FILE_TYPES 里给出 mimeType，否则类型检查通过但运行时永远匹配不到。
// 只加扩展名映射而不加 kind，会让 previewKind 出现联合类型之外的值，下游 switch 静默落空。
// 下游按 kind 分发渲染器，删除任一成员都会让已持久化的旧卡片在重放时崩掉。
export type ConversationPreviewFileKind =
  | "markdown"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio";

export type ConversationPreviewArtifactType = ConversationArtifactType | "video" | "audio";

export interface ConversationPreviewFileReference {
  end: number;
  kind: ConversationPreviewFileKind;
  path: string;
  raw: string;
  start: number;
}

export interface ConversationPreviewFileChange {
  path: string;
  state?: "active" | "reverted";
}

// [契约] requiresFileChanges 既是筛选条件也是展示契约：留在候选里，渲染层据此区分本轮新写的文件与仅被引用的文件。
// sourceKind 在本文件恒为 assistant_preview_card；user_input_attachment 由附件链路产出，不要在此补分支。
// sourceRef 存原文引用路径而非归一化路径，用于回显与定位高亮，改成绝对路径会让前端找不到原文片段。
// displayName 取路径最后一段，折叠后可能重名，去重必须用绝对路径而不是它。
// artifactType 进协议行、previewKind 选预览器，混用会导致协议校验失败或渲染器错配。
export interface ConversationPreviewArtifactCandidate {
  artifactType: ConversationPreviewArtifactType;
  displayName: string;
  mimeType: string;
  previewKind: ConversationPreviewFileKind;
  productTurnId: string;
  sourceKind: "user_input_attachment" | "assistant_preview_card";
  sourceRef: string;
  requiresFileChanges: boolean;
}

interface PreviewFileTypeDefinition {
  extensions: readonly string[];
  kind: ConversationPreviewFileKind;
  mimeType: string;
  artifactType: ConversationPreviewArtifactType;
}

// [契约] 匹配方式是「按顺序 find 首个命中」，同扩展名的定义只能存在一份。
// MEDIA_PREVIEW_FORMATS 以扩展对象形式展开在末尾，视频音频的 mime 完全由 media-preview 决定，不在此重复声明。
// 把新格式插到列表前面会改变歧义后缀的归属，扩表前先检查是否与其他定义的扩展名重叠。
// htm 与 html 共用一条定义，拆成两条会让同一后缀返回不同 artifactType。
// 这张表是 mimeType 的唯一来源，禁止在调用方硬编码 mime。
const PREVIEW_FILE_TYPES: readonly PreviewFileTypeDefinition[] = [
  {
    extensions: [".md"],
    kind: "markdown",
    mimeType: "text/markdown",
    artifactType: "md",
  },
  {
    extensions: [".html", ".htm"],
    kind: "html",
    mimeType: "text/html",
    artifactType: "html",
  },
  {
    extensions: [".docx"],
    kind: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    artifactType: "docx",
  },
  {
    extensions: [".xlsx"],
    kind: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    artifactType: "xlsx",
  },
  {
    extensions: [".pptx"],
    kind: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    artifactType: "pptx",
  },
  {
    extensions: [".pdf"],
    kind: "pdf",
    mimeType: "application/pdf",
    artifactType: "pdf",
  },
  ...MEDIA_PREVIEW_FORMATS.map(
    ({ extension, kind, mediaType }): PreviewFileTypeDefinition => ({
      extensions: [extension],
      kind,
      mimeType: mediaType,
      artifactType: kind,
    }),
  ),
];

// [契约] 15 是抽取上限、10 是展示上限，两者用途不同，不要合并成一个常量。
// 裁剪固定发生在过滤之后，先截断再过滤会让被规则丢弃的条目白占名额。
// 调大上限直接影响渲染成本与首屏高度，改动前确认调用方没有自行再截断。
// VISIBLE_LIMIT 供 UI 折叠使用，本文件不消费它，删除会破坏共享常量引用。
// 这两个值参与持久化卡片的数量语义，修改属于协议级变更而非 UI 微调。
export const CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT = 15;
export const CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT = 10;

const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*，。！？；：、]+/giu;
const FILE_CITATION_RE = /:{1,2}zcode-file-citation\{([^}]*)\}/giu;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const DELIMITED_FILE_PATH_RE =
  /([`"'])([^`"'\r\n]+?\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)\1/giu;
const FILE_PATH_RE =
  /(?:^|[\s("'`,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)(?=$|[\s)"'`,.;:!?，。！？；：、])/giu;

function normalizeSlashes(path: string): string {
  return path.replace(/\\/gu, "/");
}

// [契约] 先剥尾部标点再剥行列号，顺序颠倒会把 :12 留在路径末尾。
// 只剥离行尾分隔符、不剥离内部标点，带空格与括号的文件名因此可以完整保留。
// 尾部点号被当作标点删除，所以以点结尾的合法文件名无法从正文被识别，这是有意取舍。
// 行列号只认数字形态，形如 x.md:abc 的伪行列号会原样保留并最终匹配失败。
function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/gu, "")
    .replace(/:\d+(?::\d+)?$/u, "");
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

// [失败路径] URL 构造器对畸形串会抛错，这里吞掉异常返回 null，绝不回退成原文透传。
// Windows 的 file:///C:/x 经 URL 解析后变成 /C:/x，因此要显式剥掉前导斜杠。
// 带主机名的 file://server/share 转成 UNC 形式 //server/share，否则会被当成相对路径拼到 workspace 下。
// decodeURI 只解一次，对非法转义会抛错，失败时保留原始 pathname 而不是丢弃整条引用。
// 协议判断看似冗余，但能防止上游放宽条件后把 http 链接当成本地文件。
function parseFileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodePath(url.pathname);
    if (/^\/[a-zA-Z]:\//u.test(pathname)) return pathname.slice(1);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${pathname}`;
    return pathname;
  } catch {
    return null;
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith("\\\\");
}

// [失败路径] 出现无法抵消的 .. 时返回 null 而非截断到根，截断会让越界路径伪装成 workspace 内文件。
// 空段与单点段被跳过，a//b 与 a/./b 得到同一结果，去重键才能对齐。
// 返回值不带前导斜杠；拼接 workspace 由调用方负责，这里加斜杠会拼出双斜杠。
// 分隔符在入口统一为 /，Windows 反斜杠输入在此之后不再单独处理。
function normalizeRelativePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of normalizeSlashes(path).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/{2,}/gu, "/");
  const prefix = normalized.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join("/")}`;
}

// [契约] 这是全文件唯一的路径归一化出口：绝对路径原样归一化，相对路径拼 workspace，两条路都不做存在性检查。
// workspace 根同样走归一化并清掉尾部斜杠，否则拼接结果会出现双斜杠并破坏去重键。
// 绝对路径不在此判断是否位于 workspace 内，边界校验推迟到候选构建阶段，在这里加会与 enforceWorkspaceBoundary 语义重复。
// 软链接、盘符大小写、真实大小写文件系统都不在此纠正，比较语义与文件系统存在已知偏差。
// 返回 null 表示「不是可预览引用」，调用方不得把 null 当空串继续处理。
export function resolveConversationPreviewPath(
  workspacePath: string,
  rawPath: string,
): string | null {
  const cleaned = cleanPath(rawPath);
  if (!cleaned) return null;
  // Shell 展示用的 Home-relative 路径不是稳定的预览卡片引用；只有明确 citation 或
  // Markdown/file URL 才能成为候选，避免把正文里的 `~/...` 当成 workspace 文件分享。
  // [权衡] Shell 输出里的 ~/x.md 不是稳定引用：展开成哪个 home 由执行环境决定，截图与回放会指向不同文件。
  // 只拦 ~/ 与 ~\ 两种写法，单独的 ~ 或 user 前缀不拦，避免误伤正文里的普通词。
  // 这条判断必须早于 file URL 解析，否则 file://~/x 会被当成绝对路径放行。
  // 删掉这段会让候选数量上升但正确率下降，属于看起来该删、实际不能删的分支。
  if (/^~[\\/]/u.test(cleaned)) return null;
  const filePath = /^file:\/\//iu.test(cleaned) ? parseFileUrlPath(cleaned) : cleaned;
  if (!filePath) return null;
  if (isAbsolutePath(filePath)) return normalizeAbsolutePath(filePath);
  const relative = normalizeRelativePath(filePath);
  if (relative === null) return null;
  const workspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, "");
  return `${workspace}/${relative}`;
}

// [契约] 入参先 cleanPath 再转小写，因此带行列号或尾部标点的路径也能命中。
// 匹配用 endsWith 取后缀，a.md.bak 不会命中，a.b.md 会命中，这一取舍被下游接受。
// 此处不解码百分号转义：上游已调用 decodePath，重复解码会把已还原的百分号二次破坏。
// 返回的是映射表里的定义对象本身，调用方只读，不要在此挂载可变字段。
export function getConversationPreviewFileType(path: string): PreviewFileTypeDefinition | null {
  const normalized = cleanPath(path).toLowerCase();
  return (
    PREVIEW_FILE_TYPES.find((definition) =>
      definition.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}

function getPathLeaf(path: string): string {
  const segments = normalizeSlashes(path).replace(/\/+$/u, "").split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

// [契约] 边界用「等值或 workspace 前缀加斜杠」判断，直接 startsWith 会让 /ws 误吞 /ws2 下的文件。
// 两侧都先归一化并去尾部斜杠，否则 workspace 传 /ws/ 时前缀判断恒为假。
// 比较区分大小写，Windows 上 C:/Ws 与 c:/ws 会被判为不同工作区，属已知偏差，不要在单点改大小写。
// 返回值只回答路径归属，不代表文件存在或可读。
function isInsideWorkspace(path: string, workspacePath: string): boolean {
  const normalizedPath = normalizeAbsolutePath(path).replace(/\/$/u, "");
  const normalizedWorkspace = normalizeAbsolutePath(workspacePath).replace(/\/$/u, "");
  return (
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

function rangesOverlap(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function readDirectiveParameter(parameters: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(parameters);
  return match?.[1]?.trim() || undefined;
}

export function extractConversationPreviewFileReferences(
  content: string,
  workspacePath: string,
): ConversationPreviewFileReference[] {
  if (!content.trim()) return [];
  const references: ConversationPreviewFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];
  const addReference = (raw: string, start: number, end: number) => {
    const path = resolveConversationPreviewPath(workspacePath, raw);
    const definition = path ? getConversationPreviewFileType(path) : null;
    if (!path || !definition) return;
    references.push({ start, end, kind: definition.kind, path, raw });
  };

  // [契约] citation 区间先写入 protectedRanges，后续 markdown 与裸路径扫描必须跳过它，否则同一处会产生两条引用。
  // raw 存指令里的 path 参数而非整条指令，回显与去重都依赖这一点。
  // artifact_kind 只映射 document、presentation、workbook 三种，其他值视为未声明并放行。
  // 声明种类与扩展名推断不一致时整条 citation 被丢弃，宁缺勿错是既定口径。
  // citationKind 排除 markdown 与 html，防止 citation 绕过 fileChanges 校验直达候选。
  for (const match of content.matchAll(FILE_CITATION_RE)) {
    const rawDirective = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + rawDirective.length;
    protectedRanges.push([start, end]);
    const rawPath = readDirectiveParameter(match[1] ?? "", "path");
    if (!rawPath) continue;
    const artifactKind = readDirectiveParameter(match[1] ?? "", "artifact_kind")?.toLowerCase();
    const path = resolveConversationPreviewPath(workspacePath, rawPath);
    const definition = path ? getConversationPreviewFileType(path) : null;
    const citationKind =
      definition?.kind === "docx" ||
      definition?.kind === "xlsx" ||
      definition?.kind === "pptx" ||
      definition?.kind === "pdf" ||
      definition?.kind === "video" ||
      definition?.kind === "audio"
        ? definition.kind
        : null;
    const expectedKind =
      artifactKind === "document"
        ? "docx"
        : artifactKind === "presentation"
          ? "pptx"
          : artifactKind === "workbook"
            ? "xlsx"
            : undefined;
    if (path && citationKind && (expectedKind === undefined || expectedKind === citationKind)) {
      references.push({ start, end, kind: citationKind, path, raw: rawPath });
    }
  }

  // [契约] 只取 href 也就是第二个捕获组，链接文字不参与路径识别，尖括号写法在此剥掉。
  // 整个方括号区间进入保护范围，href 因此不会在裸路径扫描里被二次命中。
  // 循环顺序即优先级，把 file URL 或裸路径挪到 markdown 之前会让这类链接被拆成更短的片段。
  // 相对 href 依赖 workspace 拼接，此处不校验文件是否存在。
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = (match[2] ?? "").trim().replace(/^<|>$/gu, "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(href, start, end);
  }
  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = cleanPath(match[0] ?? "");
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (rangesOverlap(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    addReference(raw, start, end);
  }
  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const raw = (match[2] ?? "").trim();
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + (match[0]?.length ?? raw.length);
    if (!raw || rangesOverlap(fullStart, fullEnd, protectedRanges)) continue;
    protectedRanges.push([fullStart, fullEnd]);
    addReference(
      raw,
      fullStart + (match[0]?.indexOf(raw) ?? 0),
      fullStart + (match[0]?.indexOf(raw) ?? 0) + raw.length,
    );
  }
  // [契约] 正则的整段匹配含前导边界字符（空白或标点），起点必须用 lastIndexOf 定位到 raw 本身，否则 start 与 end 整体偏移一位。
  // 同一路径在正文出现多次时各自成引用，去重交给末尾按 start 倒序的处理。
  // 裸路径最弱：任何更明确的写法都应先被匹配并保护，否则会被这里截成子串。
  // 该正则不做 workspace 边界判断，越界路径在此仍生成引用，由候选构建阶段过滤。
  // 路径允许空格正是它与引号包裹路径重叠的原因，重叠时靠 protectedRanges 保证不重复。
  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? "";
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (!raw || rangesOverlap(start, end, protectedRanges)) continue;
    addReference(raw, start, end);
  }

  // [契约] 先按 start 倒序再过滤，保留的是最靠后出现的那一条，最后 reverse 还原成正文顺序。
  // 去重键是归一化后的绝对路径，/a/./b 与 /a/b 会合并成一条。
  // 比较器同时比较 end，用于同起点嵌套区间的稳定取舍，去掉后半段会让结果依赖引擎排序稳定性。
  // 此处 sort 原地修改的是本函数新建的 references 数组，不会影响调用方持有的数据。
  // 返回值是新数组，调用方可自由再次排序而不会污染任何缓存。
  const seen = new Set<string>();
  const deduplicatedFromLatest = references
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .filter((reference) => {
      const key = normalizeAbsolutePath(reference.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return deduplicatedFromLatest.reverse();
}

export function buildConversationPreviewArtifactCandidatesFromReferences(input: {
  references: readonly ConversationPreviewFileReference[];
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
  enforceWorkspaceBoundary?: boolean;
}): ConversationPreviewArtifactCandidate[] {
  // [契约] fileChanges 缺省为空数组，语义是「本轮没有任何文件改动」，因此 markdown 与 html 一律被过滤。
  // 回退路径也先尝试解析成绝对路径，解析失败才保留原值兜底，避免写法差异导致匹配失效。
  // active 与 reverted 用两个集合分开维护，同一路径可同时出现在两边，判定时以 reverted 为准。
  // state 缺省视为 active，这是历史数据兼容口径，不要改成缺省即丢弃。
  // 集合在循环外构建一次，候选映射内只做常数时间查询，不要在 map 内部重复构建。
  const changes = input.fileChanges ?? [];
  const activePaths = new Set(
    changes
      .filter((change) => change.state !== "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ?? change.path,
        ),
      ),
  );
  const revertedPaths = new Set(
    changes
      .filter((change) => change.state === "reverted")
      .map((change) =>
        normalizeAbsolutePath(
          resolveConversationPreviewPath(input.workspacePath, change.path) ?? change.path,
        ),
      ),
  );

  const seen = new Set<string>();
  return [...input.references]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .map((reference): ConversationPreviewArtifactCandidate | null => {
      const definition = getConversationPreviewFileType(reference.path);
      if (!definition) return null;
      const normalizedPath = normalizeAbsolutePath(reference.path);
      if (
        input.enforceWorkspaceBoundary !== false &&
        !isInsideWorkspace(normalizedPath, input.workspacePath)
      ) {
        return null;
      }
      // [契约] markdown 与 html 是生成物而非可打开的外部文件，必须由本轮 fileChanges 证明真的写过。
      // docx、xlsx、pptx、pdf、video、audio 允许直接预览，不要求出现在 fileChanges 里。
      // 判定同时要求命中 active 且未命中 reverted，缺一环就会把已回退的文件放进来。
      // 这个布尔值会写进候选并传给下游，修改计算方式等于修改对外协议语义。
      // 不要在此补「文件已存在就放行」的兜底，那会让规则退化成不可预测。
      const requiresFileChanges = reference.kind === "markdown" || reference.kind === "html";
      if (
        requiresFileChanges &&
        (!activePaths.has(normalizedPath) || revertedPaths.has(normalizedPath))
      ) {
        return null;
      }
      // [契约] 去重发生在边界与 fileChanges 过滤之后，因此保留的永远是首个通过全部规则的条目。
      // seen 记录归一化绝对路径，大小写差异视为同一文件，与 isInsideWorkspace 的语义保持一致。
      // 被前面规则过滤掉的条目不会写入 seen，避免空占去重名额。
      // 此处返回 null 而非跳过，是为了让后续 filter 与 slice 的名额语义保持清晰。
      if (seen.has(normalizedPath)) return null;
      seen.add(normalizedPath);
      return {
        artifactType: definition.artifactType,
        displayName: getPathLeaf(reference.path),
        mimeType: definition.mimeType,
        previewKind: definition.kind,
        productTurnId: input.productTurnId,
        sourceKind: "assistant_preview_card" as const,
        sourceRef: reference.path,
        requiresFileChanges,
      };
    })
    .filter((candidate): candidate is ConversationPreviewArtifactCandidate => candidate !== null)
    .slice(0, CONVERSATION_PREVIEW_CARD_CANDIDATE_LIMIT);
}

export function buildConversationPreviewArtifactCandidates(input: {
  assistantText: string;
  productTurnId: string;
  workspacePath: string;
  fileChanges?: readonly ConversationPreviewFileChange[];
}): ConversationPreviewArtifactCandidate[] {
  return buildConversationPreviewArtifactCandidatesFromReferences({
    ...input,
    references: extractConversationPreviewFileReferences(input.assistantText, input.workspacePath),
  });
}

// [契约] 协议 schema 在此透传导出，下游只需依赖本模块即可完成校验，避免跨层直引协议内部路径。
// 这里是重新导出而非重新定义，两处各留一份会让协议演进时出现校验口径分叉。
// 删除这行会让本包之外的消费者编译失败，属于对外可见的破坏性改动。
export { conversationArtifactTypeSchema };
