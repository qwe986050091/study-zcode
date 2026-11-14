// 职责边界（assistantFileReferences）
// 做：把助手回复正文里的文件引用抽成带行列区间的卡片候选。
// 做：识别 file URL、Markdown 链接、定界路径与裸路径四类写法。
// 不做：不读文件、不判断存在性，路径解析交给 markdownFileLink 与 path。
//
// INV 不变量表（20 条；每条都是「看起来能改、其实不该动」的约束）
// INV-01 断言：citation 区间必须先于其他通道登记为保护区间；守住位置：extractAssistantFileReferences 的 citation 循环；改错故障：citation 内层路径被裸路径通道重复抽出，绕过只允许 Office 与 PDF 卡片的边界
// INV-02 断言：保护区间只增不减，任何与之相交的候选直接丢弃；守住位置：overlapsRanges 的四个调用点；改错故障：同一段文本生成多张卡片，点击打开错文件
// INV-03 断言：返回前按 start 升序、end 次升序排序；守住位置：函数末尾的排序；改错故障：卡片顺序与正文出现顺序不一致，用户看到乱序
// INV-04 断言：同一 path 只保留最先入表的引用；守住位置：通用通道合并时的去重；改错故障：同一文件出现两张卡片，删掉其一另一张悬空
// INV-05 断言：区间一律左闭右开，相交判断用 start 小于 rangeEnd 且 end 大于 rangeStart；守住位置：overlapsRanges；改错故障：相邻区间被误判相交，紧贴的第二个路径丢失
// INV-06 断言：citation 无论 path 是否解析成功都先占住区间；守住位置：citation 循环里登记早于跳过；改错故障：无效 citation 的内层文本被普通通道再抽，产生不该有的卡片
// INV-07 断言：kind 只能来自定义表命中或 citation 预览解析，不能按后缀猜；守住位置：每次入表前的 path 与 definition 双判；改错故障：未知类型被当成 markdown 打开，预览白屏
// INV-08 断言：类型匹配先清洗再转小写，用 endsWith 比对；守住位置：getAssistantPreviewFileTypeDefinition；改错故障：大写后缀或带行列号的路径识别失败
// INV-09 断言：清洗时剥掉尾部标点与行列后缀，但 raw 字段保留原文；守住位置：cleanAssistantFilePathCandidate 与各通道的 raw；改错故障：卡片标题丢掉行列信息，或把句号算进路径
// INV-10 断言：只接受 file 协议，其他协议一律返回 null；守住位置：parseAssistantFileUrlPath 的协议判断；改错故障：http 链接被当本地文件打开，弹出无意义报错
// INV-11 断言：Windows 盘符形态去掉前导斜杠，避免 /D:/ 变成非法路径；守住位置：parseAssistantFileUrlPath 的盘符分支；改错故障：Windows 上 file URL 全部失效
// INV-12 断言：非 localhost 主机名按 UNC 双斜杠拼接；守住位置：parseAssistantFileUrlPath 的 hostname 分支；改错故障：共享盘路径退化成相对路径，指向错误文件
// INV-13 断言：空串与 http 前缀在清洗后立即失败关闭；守住位置：resolveAssistantRawFilePath 的前置判断；改错故障：空路径拼出 workspace 根，卡片指向目录
// INV-14 断言：波浪号开头的路径只交给链接解析器，不走本地兜底；守住位置：resolveAssistantRawFilePath 的波浪号分支；改错故障：Home 未注入时静默拼成 workspace 下的怪路径
// INV-15 断言：不含分隔符的裸文件名按 workspace 根拼接；守住位置：resolveAssistantRawFilePath 的末段判断；改错故障：正文提到 README.md 时卡片指向错误目录
// INV-16 断言：引号必须成对，错配时仍登记保护区间；守住位置：定界通道与裸路径通道的引号判定；改错故障：残缺引号内的路径被二次抽出，畸形输出也弹卡片
// INV-17 断言：定界通道里 ~user 形式与缺 homePath 的 ~/ 一律丢弃；守住位置：定界循环的波浪号判断；改错故障：无法解析的用户目录被拼成错误绝对路径
// INV-18 断言：正文裸路径中的波浪号写法不生成卡片；守住位置：裸路径循环的早期跳过；改错故障：shell 示例里的路径变成可点卡片，点击后提示不存在
// INV-19 断言：正则字符类保留 Unicode 字母数字标记，不能收窄成 ASCII；守住位置：定界与裸路径两条正则的字符类；改错故障：中文或带变音符的文件名被截断成半截
// INV-20 断言：全程固定五轮线性扫描，禁止对同一文本反复回溯；守住位置：extractAssistantFileReferences 的循环结构；改错故障：长回复解析耗时随匹配数平方增长，输入卡顿
//
// 总述：五条通道按优先级串行，靠保护区间与 path 去重收敛成一份结果。
// 总述：解析失败一律失败关闭，宁可少一张卡片也不给出错路径。
// 总述：改动前先确认守的是哪条 INV，去重与排序最容易改出重复卡片。
//
import {
  resolveMarkdownFileLink,
  type MarkdownFileLinkResolveOptions,
} from "@/lib/markdownFileLink.js";
import { extractConversationPreviewFileReferences } from "@zcode/shared";
import { decodeFilePathUriEscapes, joinFilePath } from "@/lib/path.js";
import { MEDIA_PREVIEW_FORMATS } from "@zcode/shared";
import {
  extractZCodeFileCitationDirectives,
  resolveZCodeFileCitationPreviewKind,
} from "@/lib/zcodeFileCitation.js";
import {
  isBalancedAssistantPathQuotePair,
  isAssistantPathQuoteCharacter,
  stripBalancedAssistantPathQuotes,
} from "@/lib/assistantPathQuotes.js";

export type AssistantPreviewFileKind =
  | "markdown"
  | "html"
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "video"
  | "audio";

export type AssistantPreviewFileSubtitleId =
  | "chat.previewCards.markdown"
  | "chat.previewCards.htmlWebsite"
  | "chat.previewCards.docx"
  | "chat.previewCards.xlsx"
  | "chat.previewCards.pptx"
  | "chat.previewCards.pdf"
  | "chat.previewCards.video"
  | "chat.previewCards.audio";

export interface AssistantPreviewFileTypeDefinition {
  extensions: readonly string[];
  kind: AssistantPreviewFileKind;
  subtitleId: AssistantPreviewFileSubtitleId;
}

export interface AssistantFileReference {
  end: number;
  kind: AssistantPreviewFileKind;
  path: string;
  raw: string;
  start: number;
}

export type AssistantFilePathResolveOptions = MarkdownFileLinkResolveOptions;

// 新增文件类型只需登记扩展名和展示文案；正文抽取、卡片排序和批量校验复用同一路径。
const ASSISTANT_PREVIEW_FILE_TYPES: readonly AssistantPreviewFileTypeDefinition[] = [
  { extensions: [".md"], kind: "markdown", subtitleId: "chat.previewCards.markdown" },
  {
    extensions: [".html", ".htm"],
    kind: "html",
    subtitleId: "chat.previewCards.htmlWebsite",
  },
  { extensions: [".docx"], kind: "docx", subtitleId: "chat.previewCards.docx" },
  { extensions: [".xlsx"], kind: "xlsx", subtitleId: "chat.previewCards.xlsx" },
  { extensions: [".pptx"], kind: "pptx", subtitleId: "chat.previewCards.pptx" },
  { extensions: [".pdf"], kind: "pdf", subtitleId: "chat.previewCards.pdf" },
  ...MEDIA_PREVIEW_FORMATS.map(
    ({ extension, kind }): AssistantPreviewFileTypeDefinition => ({
      extensions: [extension],
      kind,
      subtitleId: kind === "video" ? "chat.previewCards.video" : "chat.previewCards.audio",
    }),
  ),
];

// [资源] 一条正则捞全所有 file URL，命中即整段占位，不再逐字回扫。
// [失败路径] 空格与尖括号直接截断 URL，残缺部分交给解析层返回 null。
const FILE_URL_RE = /\bfile:\/\/[^\s<>()\]`"'*“”‘’，。！？；：、]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
const DELIMITED_FILE_PATH_RE =
  /([`"'“”‘’])([^`"'“”‘’\r\n]+?\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)([`"'“”‘’])/giu;
// [权衡] 前后各要求一个边界字符，宁可漏掉紧贴行首行尾的路径，也不误吞整句。
// [资源] 字符类同时允许空格与 Unicode 字母，中文与带空格路径才不会被截断。
const FILE_PATH_RE =
  /(?:^|[\s("'`“”‘’,.;:!?，。！？；：、])((?:(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|[\p{L}\p{N}\p{M}\p{S}_.@()-]+[\\/])[\p{L}\p{N}\p{M}\p{S}_.@() -]+?(?:[\\/][\p{L}\p{N}\p{M}\p{S}_.@() -]+?)*|[\p{L}\p{N}\p{M}\p{S}_.@()-]+)\.(?:md|html?|docx|xlsx|pptx|pdf|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|opus|flac|weba)(?::\d+(?::\d+)?)?)(?=$|[\s)"'`“”‘’,.;:!?，。！？；：、])/giu;

// [不变量] 只洗尾部，不动中间空格，Windows 带空格路径必须原样保留。
// [顺序] 先剥标点再剥行列号，顺序反了会把 `:12` 留在路径正文里。
// [权衡] 这里不做百分号解码，转义还原只属于 URL 通道，避免普通文本被误解码。
export function cleanAssistantFilePathCandidate(candidate: string): string {
  return candidate
    .trim()
    .replace(/[.,;!?，。！？；：、]+$/, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

// [不变量] 数组顺序即优先级，第一个 endsWith 命中者胜出，登记时长后缀放前面。
// [边界] 返回 null 表示不是可预览文件，调用方不得用默认 kind 兜底。
export function getAssistantPreviewFileTypeDefinition(
  path: string,
): AssistantPreviewFileTypeDefinition | null {
  const normalizedPath = cleanAssistantFilePathCandidate(path).toLowerCase();
  return (
    ASSISTANT_PREVIEW_FILE_TYPES.find((definition) =>
      definition.extensions.some((extension) => normalizedPath.endsWith(extension)),
    ) ?? null
  );
}

export function isAssistantPreviewHtmlPath(path: string): boolean {
  return getAssistantPreviewFileTypeDefinition(path)?.kind === "html";
}

export function parseAssistantFileUrlPath(url: string): string | null {
  // [失败路径] URL 构造与解码都可能抛错，统一吞掉返回 null，不向上冒泡。
  // [权衡] 不自己用正则拆 URL，浏览器实现的协议与主机名语义更可靠。
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "file:") return null;

    const decodedPathname = decodeFilePathUriEscapes(parsedUrl.pathname);
    // [不变量] 盘符分支必须在 hostname 分支之前，否则 D 会被当成主机名。
    // [不变量] 只剥一个前导斜杠，D:/ 之后的层级必须原样保留。
    if (/^\/[a-zA-Z]:\//.test(decodedPathname)) return decodedPathname.slice(1);
    if (parsedUrl.hostname && parsedUrl.hostname !== "localhost") {
      return `//${parsedUrl.hostname}${decodedPathname}`;
    }
    return decodedPathname;
  } catch {
    return null;
  }
}

export function resolveAssistantRawFilePath(
  workspacePath: string,
  rawPath: string,
  options: AssistantFilePathResolveOptions = {},
): string | null {
  // [不变量] 带 file 前缀的输入直接短路，不再走清洗与 workspace 拼接。
  // [失败路径] 解析失败返回 null，不回落成相对路径，避免把坏链接当文件。
  if (/^file:\/\//i.test(rawPath)) return parseAssistantFileUrlPath(rawPath);

  const cleanedPath = cleanAssistantFilePathCandidate(rawPath);
  if (!cleanedPath || cleanedPath.startsWith("http://") || cleanedPath.startsWith("https://")) {
    return null;
  }
  // `~` 是 Home-relative 语义；Host Home 尚未注入或使用了 `~other` 时必须失败关闭，
  // 不能继续走 `./${cleanedPath}` 的 workspace-relative 兜底分支。
  // [不变量] 波浪号与 ~user 两种形式都交给链接解析器，本地不拼 Home。
  // [失败路径] Home 未注入时解析器返回空，这里直接 null，不降级成 workspace 相对路径。
  if (/^~(?:[\\/]|[^\\/]+[\\/])/.test(cleanedPath)) {
    return resolveMarkdownFileLink(workspacePath, cleanedPath, options)?.path ?? null;
  }

  const parsedLink = resolveMarkdownFileLink(workspacePath, rawPath, options);
  if (parsedLink) return parsedLink.path;

  // [不变量] 无任何分隔符才认定裸文件名，拼到 workspace 根。
  // [权衡] 有分隔符时补 ./ 再交解析器，防止绝对路径被当成根相对。
  if (!cleanedPath.includes("/") && !cleanedPath.includes("\\")) {
    return joinFilePath(workspacePath, cleanedPath);
  }
  return resolveMarkdownFileLink(workspacePath, `./${cleanedPath}`, options)?.path ?? null;
}

function normalizeMarkdownHref(href: string): string {
  return stripBalancedAssistantPathQuotes(href.trim().replace(/^<|>$/g, ""));
}

// [不变量] 左闭右开，start 等于 rangeEnd 不算相交，紧贴区间都能保留。
// [资源] 线性遍历保护区间，区间数等于已接受候选数，不随正文长度增长。
function overlapsRanges(start: number, end: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

export function extractAssistantFileReferences(
  content: string,
  workspacePath: string,
  options: AssistantFilePathResolveOptions = {},
): AssistantFileReference[] {
  if (!content.trim()) return [];

  const references: AssistantFileReference[] = [];
  const protectedRanges: Array<[number, number]> = [];

  // [顺序] citation 先跑，把整条指令占住，后面四轮只能看到剩余文本。
  // [不变量] 登记保护区间在跳过空 path 之前，解析失败也要占位。
  // [边界] kind 由 artifactKind 与解析后 path 共同决定，本文件不按后缀猜。
  for (const citation of extractZCodeFileCitationDirectives(content)) {
    // Citation 必须占用完整保护区间，否则内部 path 会再次被普通文件正则抽取，
    // 从而绕过 citation 只允许 Office/PDF 卡片的产品边界。
    protectedRanges.push([citation.start, citation.end]);
    if (!citation.path) continue;
    const path = resolveAssistantRawFilePath(workspacePath, citation.path, options);
    const kind = path
      ? resolveZCodeFileCitationPreviewKind({
          artifactKind: citation.artifactKind,
          path,
        })
      : null;
    if (path && kind) {
      references.push({
        start: citation.start,
        end: citation.end,
        kind,
        path,
        raw: citation.path,
      });
    }
  }

  // [不变量] href 先归一化再解析，显示文案与链接目标彻底解耦。
  // [失败路径] 目标不是可预览文件时仍占住区间，内部路径不能再被后续通道抽出。
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const href = match[2] ? normalizeMarkdownHref(match[2]) : "";
    const path = resolveAssistantRawFilePath(workspacePath, href, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (overlapsRanges(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw: href });
    }
  }

  // [顺序] 排在 Markdown 之后，链接里的 file URL 已被整段吞掉，不会重复。
  // [不变量] 尾部星号反引号与标点一次剥净，raw 与解析用的是同一个串。
  for (const match of content.matchAll(FILE_URL_RE)) {
    const raw = (match[0] ?? "").replace(/(?:[*_`]+|[.,;:!?，。！？；：、]+)+$/g, "");
    const path = parseAssistantFileUrlPath(raw);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    const start = match.index ?? 0;
    const end = start + (match[0]?.length ?? 0);
    if (overlapsRanges(start, end, protectedRanges)) continue;
    protectedRanges.push([start, end]);
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  // [不变量] 只取中间捕获组，引号不进 raw，卡片热区也不含引号。
  // [失败路径] 引号错配时占住整段并丢弃，内部路径无法被后续通道再抽。
  for (const match of content.matchAll(DELIMITED_FILE_PATH_RE)) {
    const candidate = match[2] ?? "";
    const raw = candidate.trim();
    const fullMatch = match[0] ?? raw;
    const fullStart = match.index ?? 0;
    const fullEnd = fullStart + fullMatch.length;
    if (!raw || overlapsRanges(fullStart, fullEnd, protectedRanges)) continue;
    if (!isBalancedAssistantPathQuotePair(match[1] ?? "", match[3] ?? "")) {
      // 错配引号不能让内部路径再被通用正则捞出，否则 malformed 输出仍会生成卡片。
      protectedRanges.push([fullStart, fullEnd]);
      continue;
    }

    if (/^~[^\\/]+[\\/]/.test(raw) || (/^~[\\/]/.test(raw) && !options.homePath)) {
      protectedRanges.push([fullStart, fullEnd]);
      continue;
    }

    const path = resolveAssistantRawFilePath(workspacePath, raw, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    if (path && definition) {
      const start = fullStart + fullMatch.indexOf(raw);
      const end = start + raw.length;
      protectedRanges.push([fullStart, fullEnd]);
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  for (const match of content.matchAll(FILE_PATH_RE)) {
    const raw = match[1] ?? "";
    const fullMatch = match[0] ?? raw;
    const start = (match.index ?? 0) + fullMatch.lastIndexOf(raw);
    const end = start + raw.length;
    if (overlapsRanges(start, end, protectedRanges)) continue;

    // 普通正文里的 `~/...` 是给用户看的 shell 路径，不是稳定的预览卡片引用。
    // 明确的 zcode-file-citation 仍在上面的专用分支处理。
    if (/^~[\\/]/.test(raw)) {
      protectedRanges.push([start, end]);
      continue;
    }

    // [不变量] 边界取自原文相邻字符，不做 trim，缩进与标点都是真实边界。
    // [边界] 首尾越界时取到 undefined，交给引号判定按非引号处理。
    const precedingCharacter = content[start - 1];
    const followingCharacter = content[end];
    const hasQuoteBoundary =
      isAssistantPathQuoteCharacter(precedingCharacter) ||
      isAssistantPathQuoteCharacter(followingCharacter);
    if (
      hasQuoteBoundary &&
      !isBalancedAssistantPathQuotePair(precedingCharacter ?? "", followingCharacter ?? "")
    ) {
      // 单侧或错配引号不能让内部路径绕过定界符保护而生成卡片。
      protectedRanges.push([start, end]);
      continue;
    }

    const path = resolveAssistantRawFilePath(workspacePath, raw, options);
    const definition = path ? getAssistantPreviewFileTypeDefinition(path) : null;
    if (path && definition) {
      references.push({ start, end, kind: definition.kind, path, raw });
    }
  }

  // [顺序] 通用通道最后跑，只补前面四轮没覆盖的区间。
  // [权衡] 通用抽取不认识 citation 与引号边界，必须排在保护区间之后。
  // [不变量] 合并时区间相交与 path 相等任一命中即丢弃，保留先入者。
  const genericReferences = extractConversationPreviewFileReferences(content, workspacePath);
  for (const reference of genericReferences) {
    if (overlapsRanges(reference.start, reference.end, protectedRanges)) continue;
    if (references.some((candidate) => candidate.path === reference.path)) continue;
    references.push(reference);
  }

  // [不变量] 原地排序并返回同一数组，调用方拿到的就是最终顺序。
  // [不变量] 同 start 用 end 兜底，短区间在前，顺序稳定可预期。
  return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function hasAssistantPreviewFileChangeCandidates(
  content: string,
  workspacePath: string,
  options: AssistantFilePathResolveOptions = {},
): boolean {
  // [边界] 只看 markdown 与 html，因为只有这两类有可编辑预览。
  // [资源] 复用同一次抽取结果，不另跑一套正则。
  return extractAssistantFileReferences(content, workspacePath, options).some(
    (reference) => reference.kind === "markdown" || reference.kind === "html",
  );
}
