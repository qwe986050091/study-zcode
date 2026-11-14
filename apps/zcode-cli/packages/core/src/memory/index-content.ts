// ============================================================
// memory/index-content —— MEMORY.md 索引的安全注入格式
// ============================================================
//
// 【定位】把 MEMORY.md 原文转成“可放进系统提示词”的文本：去掉 frontmatter
//   与顶层 HTML 注释；超过行数或字符上限时截断并追加 WARNING。
//
// 【消费方】context/sections/request-user-context.ts（project Memory 索引段）
//   与 subagent/persistent-memory-prompt.ts（子代理持久记忆说明段）。
//
// 【读写边界】纯字符串处理：不读盘、不写盘；读取文件由调用方负责。
// 【失效/过期口径】结果只代表调用时刻的文件内容，本文件不做缓存。
// 【失败语义】不抛错：空内容返回空串，由调用方按“没有索引来源”处理。
// ============================================================
import { Lexer } from "marked";

// 索引行数上限：MEMORY.md 是目录而不是正文，超过 200 行说明细节没有下沉到主题文件。
const MEMORY_INDEX_LINE_LIMIT = 200;
// 字符上限约 25KB：与 200 行共同约束注入体积，防止超大单行绕过行数限制。
const MEMORY_INDEX_CHARACTER_LIMIT = 25_000;
// 只匹配文件开头的 YAML frontmatter；中间的 --- 属于正文，不能误删。
const LEADING_FRONTMATTER_PATTERN = /^---\s*\n[\s\S]*?---\s*\n?/u;
// HTML 注释（含跨行）；仅对 Markdown lexer 识别出的顶层 comment token 生效。
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;

/**
 * 把 MEMORY.md 原文格式化为可注入的 project Memory 索引。
 * 输入：文件原始内容（可能为空、可能带 frontmatter/HTML 注释）。
 * 输出：去除 frontmatter 与顶层注释、并应用限额后的文本；无有效内容时为 ""。
 * 副作用：无。
 * 失败语义：不抛错；非法 Markdown 由 lexer 容错处理。
 * 不变量：先剥 frontmatter 再走 Markdown lexer，避免把 frontmatter 当成
 *   普通段落参与 token 化；限额规则与 formatMemoryIndexContent 完全一致。
 */
export function formatProjectMemoryIndexContent(content: string): string {
  const withoutFrontmatter = content.replace(LEADING_FRONTMATTER_PATTERN, "");
  return formatMemoryIndexContent(stripTopLevelMarkdownHtmlComments(withoutFrontmatter));
}

/**
 * 对索引内容应用行数与字符两项限额。
 * 输入：任意索引文本；输出：原样（未超限）或截断 + 可读 WARNING。
 * 副作用：无。
 * 失败语义：空/纯空白返回 ""，调用方视为没有索引。
 * 不变量：只截断、不改写正文；字符截断退到最近换行，避免出现半行条目；
 *   超限说明必须明确指出是“行数超限”还是“条目过长”，便于模型修正索引。
 */
export function formatMemoryIndexContent(content: string): string {
  const trimmed = content.trim();
  // 空索引等价于“没有 memory index”，返回空串让上层跳过整段注入。
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const lineCount = lines.length;
  const characterCount = trimmed.length;
  const lineTruncated = lineCount > MEMORY_INDEX_LINE_LIMIT;
  const characterTruncated = characterCount > MEMORY_INDEX_CHARACTER_LIMIT;
  // 两项都未超限：原样返回，避免对正常索引做任何改写。
  if (!lineTruncated && !characterTruncated) return trimmed;

  // 先按行截断，再按字符兜底；两者可能同时成立（少量超长行）。
  let truncated = lineTruncated ? lines.slice(0, MEMORY_INDEX_LINE_LIMIT).join("\n") : trimmed;
  if (truncated.length > MEMORY_INDEX_CHARACTER_LIMIT) {
    // 退到限额内最后一个换行，避免把一行索引切成两半。
    const finalNewline = truncated.lastIndexOf("\n", MEMORY_INDEX_CHARACTER_LIMIT);
    truncated = truncated.slice(0, finalNewline > 0 ? finalNewline : MEMORY_INDEX_CHARACTER_LIMIT);
  }

  const sizeDescription =
    characterTruncated && !lineTruncated
      ? `${formatBytes(characterCount)} (limit: ${formatBytes(MEMORY_INDEX_CHARACTER_LIMIT)}) — index entries are too long`
      : lineTruncated && !characterTruncated
        ? `${lineCount} lines (limit: ${MEMORY_INDEX_LINE_LIMIT})`
        : `${lineCount} lines and ${formatBytes(characterCount)}`;

  return `${truncated}\n\n> WARNING: MEMORY.md is ${sizeDescription}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

/**
 * 按 1024 进制把字节数格式化成人类可读文本（B/KB/MB/GB）。
 * 仅用于 WARNING 文案；不参与任何限额判断。
 */
function formatBytes(value: number): string {
  const kilobytes = value / 1024;
  if (kilobytes < 1) return `${value} bytes`;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1).replace(/\.0$/u, "")}KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1).replace(/\.0$/u, "")}MB`;
  return `${(megabytes / 1024).toFixed(1).replace(/\.0$/u, "")}GB`;
}

/**
 * 删除“顶层” Markdown HTML 注释，保留嵌套结构里的注释文本。
 * 输入：索引正文；输出：去掉顶层 comment 后的正文。
 * 副作用：无。
 * 失败语义：无 `<!--` 时快速返回原串；lexer 不抛错。
 * 不变量：只处理 type=html 且以 `<!--` 开头的 token——list、blockquote、
 *   paragraph 与 code 内的注释必须保持 provider-visible，不能被误删。
 */
function stripTopLevelMarkdownHtmlComments(content: string): string {
  // 没有注释标记时直接返回，避免为一个常见情形付出 lexer 成本。
  if (!content.includes("<!--")) return content;

  let result = "";
  for (const token of new Lexer({ gfm: false }).lex(content)) {
    if (token.type === "html") {
      // 只有“整块就是注释”的顶层 token 才会被清空；混合内容原样保留。
      const trimmedToken = token.raw.trimStart();
      if (trimmedToken.startsWith("<!--") && trimmedToken.includes("-->")) {
        const withoutComments = token.raw.replace(HTML_COMMENT_PATTERN, "");
        // 只删除 Markdown lexer 识别到的顶层 HTML comment token；
        // list、blockquote、paragraph 和 code token 内的 comment 必须保持 provider-visible。
        if (withoutComments.trim().length > 0) result += withoutComments;
        continue;
      }
    }
    result += token.raw;
  }
  return result;
}
