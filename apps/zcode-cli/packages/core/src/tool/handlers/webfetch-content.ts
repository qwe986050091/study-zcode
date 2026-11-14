// 响应正文 → 模型可用文本：MIME 过滤、HTML 转 markdown、超长截断与原文留存。
//
// 这一层是「原始字节」与「模型上下文」之间的闸门，两条预算必须同时满足：
// 1. 送进处理小模型的正文不超过 MAX_MODEL_INPUT_CHARS（按字符计）；
// 2. 一旦正文超过该上限，若注入了 artifactStore，必须先把全文落盘，再把截断版交给模型，
//    保证模型仍能通过路径取回完整内容（大结果走 artifact 的不变量）。
// HTML 转换是正则近似而非浏览器级解析：目标是给模型可读文本，不追求完美 DOM 还原；
// 因此对畸形 HTML 只保证「不崩、不把 script/style 正文带出去」，不保证结构精确。
import type { ToolExecutionContext } from "../types.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";

/**
 * 把响应体解码成可读正文：文本类 MIME → 纯文本，HTML 类 → markdown。
 *
 * 输入：原始字节与 content-type（可能带 `; charset=...` 参数）；输出：已 trim 的文本
 * （HTML 分支输出 markdown）。非文本 MIME（图片/PDF/压缩包等）直接抛 FetchFailed，
 * 不返回空串也不把二进制塞给模型——静默降级会让模型把「不是网页」误当成「页面为空」。
 *
 * 注意：解码固定使用 UTF-8，不解析 charset 参数；非 UTF-8 页面可能出现乱码，这是已知取舍
 * （agent 场景绝大多数目标是 UTF-8），不要在调用方另行解码后重复 trim。
 */
export function extractReadableContent(body: Uint8Array, contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isTextLikeMime(mime)) {
    throw webFetchError("FetchFailed", `Unsupported WebFetch content type: ${mime || "unknown"}`, {
      contentType,
    });
  }

  const text = new TextDecoder().decode(body);
  if (mime === "text/html" || mime === "application/xhtml+xml" || contentType.includes("html")) {
    return htmlToMarkdown(text);
  }
  return text.trim();
}

/**
 * 正文超过模型输入上限时，把全文写入 artifact 存储并返回可追踪引用。
 *
 * 输入：抽取后的正文、原始 content-type、执行上下文（需要 artifactStore 与 abortSignal）。
 * 输出：`{ path, uri }`；不需要/无法落盘时返回 undefined（未注入 store，或正文未超上限）。
 *
 * 口径细节：判断用的是 UTF-8 字节数与 MAX_MODEL_INPUT_CHARS 比较，存在字符/字节口径混用
 * ——非 ASCII 页面会比「字符数超限」更早落盘。这不会漏落盘：只要 truncateContentForModel
 * 会截断（字符数超限），字节数必然也超限，所以「被截断 ⇒ 一定有路径可用」始终成立。
 *
 * 失败语义：artifact 写入异常不吞掉，直接上抛——此时正文即将被截断，静默失败会让模型
 * 永久失去全文；取消信号会传入存储层，由存储层按自身语义处理中止。
 */
export async function maybePersistRawContent(
  content: string,
  contentType: string,
  context: ToolExecutionContext,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!context.artifactStore) return undefined;
  if (Buffer.byteLength(content, "utf8") <= MAX_MODEL_INPUT_CHARS) return undefined;

  const artifact = await context.artifactStore.writeToolResultArtifact(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
      content,
      contentType: contentType.includes("html") ? "text/markdown" : "text/plain",
      retention: "session",
      trace: traceFromContext(context),
    },
    { signal: context.abortSignal },
  );

  return { path: artifact.path, uri: artifact.uri };
}

/**
 * 按模型输入上限截断正文，保证结果总长不超过 MAX_MODEL_INPUT_CHARS（含后缀）。
 *
 * 输出 `{ content, truncated }`：truncated 由调用方透传到工具输出，用于告诉展示层/模型
 * 「这里不是全文」。后缀本身也占用预算，所以截断点要回退 suffix.length，避免超限。
 * 边界：content 长度恰好等于上限时不截断；上限小于后缀长度（配置被改坏）时 maxBodyChars
 * 归零，只返回后缀，而不是产生负数 slice。
 */
export function truncateContentForModel(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_MODEL_INPUT_CHARS) {
    return { content, truncated: false };
  }

  const suffix = "\n\n[WebFetch content truncated before prompt processing]";
  const maxBodyChars = Math.max(0, MAX_MODEL_INPUT_CHARS - suffix.length);
  return {
    content: `${content.slice(0, maxBodyChars)}${suffix}`,
    truncated: true,
  };
}

/**
 * 正则近似地把 HTML 转成 markdown 纯文本。
 *
 * 处理顺序不能随意调换：先整块删掉注释/script/style/noscript（否则脚本源码会被当成正文），
 * 再做标题/链接/列表等结构化替换，最后统一剥标签并解码实体。行级折叠只保留单个空行，
 * 避免大段空白浪费模型上下文预算。对嵌套/畸形标签可能留下多余文本，这是可接受的近似。
 */
function htmlToMarkdown(html: string): string {
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  content = content
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    // 链接必须在最后剥标签之前完成，否则 `href` 与锚文本会一起被丢掉；只取第一个 href。
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    // 块级闭合统一换行，避免相邻段落/表格行粘连成一行。
    .replace(/<\/(?:p|div|section|article|header|footer|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(content)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    // 只保留「前一行非空」的空行，即最多一个连续空行；行首空行也会被后面的 trim 去掉。
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
}

/**
 * 解码常见 HTML 实体：命名实体用固定小表，数字实体支持十进制与十六进制。
 *
 * 注意：数字实体没有校验码点上界，超出 Unicode 范围的值会让 String.fromCodePoint 抛
 * RangeError；对普通页面无影响，但抓到构造过的页面时该异常会中断整个抓取（上层不会吞）。
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

/**
 * 文本类 MIME 白名单；空 MIME 视为文本（部分服务器不返回 content-type，按纯文本尝试）。
 * 只覆盖 `text/*`、JSON、XML、JS 及其 `+json`/`+xml` 后缀——其余（图片、PDF、字体、
 * 压缩包）一律拒绝，避免把二进制内容灌进模型上下文。
 */
function isTextLikeMime(mime: string): boolean {
  if (mime.length === 0) return true;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
