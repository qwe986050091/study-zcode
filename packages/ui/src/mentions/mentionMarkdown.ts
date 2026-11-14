// INV-01 链接中的标签与目标都必须转义：守住位置 两个转义函数；改错故障 文件名含方括号时链接断开。
// INV-02 目标为裸路径时补相对前缀：守住位置 目标归一；改错故障 安全校验把裸路径当自定义协议并屏蔽。
// INV-03 绝对路径、点路径、锚点与带协议地址保持原样：守住位置 同函数的前置判断；改错故障 合法地址被改写。
// INV-04 目录引用的目标必须以斜杠结尾：守住位置 路径归一；改错故障 目录在气泡里显示成文件。
// INV-05 文件提及统一输出「标签加链接」：守住位置 文件构造；改错故障 消息里丢失路径信息。
// INV-06 技能无路径时退回纯符号写法：守住位置 技能构造；改错故障 历史消息无法解析。
// INV-07 插件引用身份只放在目标里，标签只作展示：守住位置 插件构造；改错故障 改名后身份丢失。
// INV-08 各类别分派必须穷尽，未知类别退回符号写法：守住位置 统一构造；改错故障 新类别渲染成空串。
// INV-09 纯文本渲染要去掉链接外壳并保留可读标签：守住位置 纯文本降级；改错故障 标题里出现原始标记。
// INV-10 标签反转义必须能还原所有转义字符：守住位置 反转义函数；改错故障 展示残留反斜杠。
// INV-11 插件目标只接受固定前缀加合法稳定标识，且长度受限：守住位置 稳定标识解析；改错故障 非法目标被当成插件。
// INV-12 非法插件目标保留为纯展示，不做猜测：守住位置 解析器的插件分支；改错故障 伪造目标关联到错误插件。
// INV-13 内联标记识别要求前后为空白或边界：守住位置 内联正则；改错故障 邮件地址被误识别为子代理。
// INV-14 会话标记只认固定前缀加合法字符：守住位置 目标正则；改错故障 普通锚点被识别成会话。
// INV-15 解析必须保持原文顺序与完整覆盖：守住位置 游标推进；改错故障 片段丢失或重复。
// INV-16 全局正则复用前必须重置状态：守住位置 两处游标归零；改错故障 第二次解析从中间开始。
// INV-17 技能展示名把短横与下划线转空格并首字母大写：守住位置 展示名格式化；改错故障 气泡标题显示成原始符号。
// INV-18 已是含空格短语的展示名原样返回：守住位置 该函数的早退分支；改错故障 用户自定义名被改写。
//
// 模块职责：负责提及引用的标记构造、纯文本降级与反向解析，供输入框与消息气泡共用。
// 状态所有权：全部是纯函数；两个全局正则只在本模块内使用，调用前重置游标。
// 阅读顺序：先看转义与目标归一，再读五类构造，最后看解析器的链接分支与内联标记分支。
import type { MentionItem } from "./mentionTypes.js";

const LINK_MENTION_MARKDOWN_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const INLINE_MENTION_TOKEN_PATTERN =
  /(^|\s)(\$[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._-]+|@[a-zA-Z0-9._-]+|#sess_[a-zA-Z0-9._-]+)(?=$|\s)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll("\\", "\\\\").replaceAll(">", "\\>");
}

function unescapeMarkdownText(text: string): string {
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }

    result += text[index];
  }

  return result;
}

// normalizeMarkdownDestination 依次判 destination.startsWith("/")、"./"、"../"、"#" 或 /^[a-zA-Z][a-zA-Z\d+.-]*:/：命中任一直接返回；其余裸路径补 "./" 前缀，否则 Streamdown/rehype-harden 会把 foo/bar.ts 当成自定义协议 foo: 并渲染成 [blocked]；只改目标，不动 label。
function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }

  // Streamdown/rehype-harden 会把 `foo/bar.ts` 这种裸路径当成自定义协议 `foo:`，
  // 结果用户消息里的文件引用会被渲染成 `[blocked]`。这里统一补成 `./foo/bar.ts`，
  // 让它明确成为相对路径链接，既保留 Markdown 语义，也能通过安全校验正常展示。
  return `./${destination}`;
}

// normalizeFileMentionRelativePath 先 relativePath.trim()；kind === "directory" 时 replace(/[\\/]+$/, "") 再补单个 "/"，多个尾部分隔符合并成一个；kind === "file" 原样返回；不校验路径是否存在。
function normalizeFileMentionRelativePath(
  relativePath: string,
  kind: "file" | "directory",
): string {
  const trimmedRelativePath = relativePath.trim();
  if (kind === "directory") {
    return `${trimmedRelativePath.replace(/[\\/]+$/, "")}/`;
  }

  return trimmedRelativePath;
}

// buildFileMentionMarkdown 先用 normalizeFileMentionRelativePath(relativePath, kind) 规整路径，再 normalizeMarkdownDestination 补协议前缀，最后 escapeMarkdownDestination 转义；label 走 escapeMarkdownLabel；输出固定为 [label](destination)，解析侧 LINK_MENTION_MARKDOWN_PATTERN 复用同一套转义。
export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
): string {
  const normalizedRelativePath = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalizedRelativePath))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }

  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

export function buildSubagentMentionMarkdown(label: string): string {
  return `@${label}`;
}

export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(sessionId)})`;
}

// Plugin 引用的 canonical 持久化载体：
// `[@Label](plugin://stable-id)`。身份只在 destination；label 仅用于展示。
export function buildPluginMentionMarkdown(label: string, pluginId: string): string {
  return `[${escapeMarkdownLabel(`@${label}`)}](plugin://${escapeMarkdownDestination(pluginId)})`;
}

// buildMentionMarkdown 按 item.category 分派：files 用 item.data?.relativePath ?? item.value 与 data.kind，skills 有 data.path 才走链接、否则 buildSkillMentionMarkdown 回退 $label，plugins 用稳定 pluginId，subagents 用 @label，未知类别回退符号写法保证不丢内容。
export function buildMentionMarkdown(
  item: Pick<MentionItem, "category" | "data" | "label" | "value">,
): string {
  if (item.category === "files") {
    return buildFileMentionMarkdown(
      item.data?.relativePath ?? item.value,
      item.label,
      item.data?.kind === "directory" ? "directory" : "file",
    );
  }
  if (item.category === "skills") {
    // Bugfix: skill mention 之前序列化成 `$slug`，消息里拿不到具体技能路径，
    // 后续展示和解析都只能退化成纯文本 token。这里统一改成 `[$Label](path)`，
    // 让 skill 和 file 一样具备稳定的链接载体；若历史数据里还没带 path，则继续回退旧格式避免丢内容。
    return buildSkillMentionMarkdown(item.value, item.data?.path);
  }
  if (item.category === "subagents") {
    return buildSubagentMentionMarkdown(item.value);
  }
  if (item.category === "sessions") {
    return buildSessionMentionMarkdown(item.value, item.label);
  }
  if (item.category === "plugins") {
    return buildPluginMentionMarkdown(item.label, item.data?.pluginId ?? item.value);
  }

  return `@${item.value}`;
}

export function renderMentionMarkdownAsPlainText(content: string): string {
  return content.replaceAll(LINK_MENTION_MARKDOWN_PATTERN, (_, label: string) => {
    const normalizedLabel = unescapeMarkdownText(label);
    return normalizedLabel.startsWith("@") ? normalizedLabel.slice(1) : normalizedLabel;
  });
}

type MentionTextPart =
  | { type: "text"; text: string }
  | { type: "file"; label: string }
  | { type: "directory"; label: string }
  | { type: "skill"; label: string }
  | { type: "command"; label: string }
  | { type: "subagent"; label: string }
  | { type: "session"; label: string }
  | { type: "plugin"; label: string; pluginId?: string };

const PLUGIN_STABLE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * 将技能 slug（如 code-review）格式化为聊天气泡中的可读标题（Code Review）。
 * 已是包含空格的短语时原样返回，避免破坏用户自定义展示名。
 */
export function formatSkillMentionDisplayLabel(label: string): string {
  const t = label.trim();
  if (!t) {
    return label;
  }
  if (t.includes(" ") && !t.includes("-") && !t.includes("_")) {
    return t;
  }
  const words = t.split(/[-_]/).filter(Boolean);
  if (words.length === 0) {
    return label;
  }
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function isDirectoryMentionDestination(destination: string): boolean {
  return /[\\/]$/.test(destination);
}

// parseInlineMentionTokens 先把 INLINE_MENTION_TOKEN_PATTERN.lastIndex 重置为 0，再 matchAll；prefix 只用于定位、tokenStart = match.index + prefix.length，之前的普通文本切片保留；按 token 首字符 $ / @ # 分派 skill/command/subagent/session，其余回落 text，cursor 推到 tokenStart + token.length。
function parseInlineMentionTokens(segment: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({
        type: "text",
        text: segment.slice(cursor, tokenStart),
      });
    }
    if (token.startsWith("$")) {
      parts.push({ type: "skill", label: token.slice(1) });
    } else if (token.startsWith("/")) {
      parts.push({ type: "command", label: token.slice(1) });
    } else if (token.startsWith("@")) {
      parts.push({ type: "subagent", label: token.slice(1) });
    } else if (token.startsWith("#")) {
      parts.push({ type: "session", label: token.slice(1) });
    } else {
      parts.push({ type: "text", text: token });
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ type: "text", text: segment.slice(cursor) });
  }

  return parts;
}

// parseMentionMarkdown 先把 LINK_MENTION_MARKDOWN_PATTERN.lastIndex 置 0 再 matchAll：链接之间的文本交给 parseInlineMentionTokens；destination 以 #sess_ 开头还原 session、plugin:// 保留稳定标识、技能 label 以 $ 开头、目标以 / 结尾还原 directory；cursor 按 matchStart + fullMatch.length 推进。
export function parseMentionMarkdown(content: string): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokens(content.slice(cursor, matchStart)));
    }
    if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
      parts.push({ type: "session", label: label.startsWith("#") ? label.slice(1) : label });
    } else if (destination.startsWith("plugin://")) {
      // Plugin 引用链接绝不能落入 file 分支或被当外链处理；
      // 发送后曾只保留 label，消息层失去 stable ID，只能固定显示兜底图标。
      // 这里原样保留合法 destination 身份供 UI 与 Session catalog 关联；非法目标仍保持
      // display-only，不做 label 猜测、percent decode 或 canonical 改写。
      const pluginId = parsePluginStableId(destination);
      parts.push({
        type: "plugin",
        label: label.startsWith("@") ? label.slice(1) : label,
        ...(pluginId ? { pluginId } : {}),
      });
    } else if (label.startsWith("$")) {
      parts.push({ type: "skill", label: label.slice(1) });
    } else if (isDirectoryMentionDestination(destination)) {
      // 目录 mention 之前只按普通 file 还原，消息回显层拿不到 folder 语义，
      // 于是文件夹候选在气泡里会继续显示成普通文件图标。这里根据链接目标是否以斜杠结尾恢复目录类型。
      parts.push({ type: "directory", label: label.startsWith("@") ? label.slice(1) : label });
    } else {
      parts.push({ type: "file", label: label.startsWith("@") ? label.slice(1) : label });
    }
    cursor = matchStart + fullMatch.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokens(content.slice(cursor)));
  }

  return parts;
}
