// ============================================================
// memory/origin-session —— 写入记忆时标记来源 session
// ============================================================
//
// 【定位】Write/Edit 落盘前，为 memoryRoot 内的 .md 补 frontmatter
//   metadata.originSessionId，用于后续归因“这条记忆来自哪个会话”。
//
// 【最小改写】只在缺少 originSessionId 时动 YAML：补 node_type=memory 并插入
//   originSessionId；已有来源、非 mapping metadata、解析失败一律原样返回。
//
// 【读写边界】纯字符串转换，不读盘；调用方负责把返回值落盘。
// 【失效/过期口径】首次写入者即来源，后续编辑不覆盖已有 originSessionId。
// 【失败语义】不抛错：格式不符合预期时返回原 content，格式由 prompt 约束。
// ============================================================
import { isMap, parseDocument } from "yaml";

import { memoryFileRelativePath } from "./memory-file-path.js";

// 只匹配“文件开头”的 frontmatter：允许 BOM、兼容 CRLF/LF；
// 闭合 --- 必须后接换行或文件结尾，避免把正文里的 --- 误当成结束。
const MEMORY_FRONTMATTER_PATTERN =
  /^(\uFEFF?---(?:\r\n|\n))([\s\S]*?)((?:\r\n|\n)---)(?=(?:\r\n|\n)|$)/u;

/**
 * 为记忆文件内容打上来源 session（必要时重排 node_type）。
 * 输入：待写入内容、文件绝对路径、memoryRoot（未启用时 undefined）、当前 sessionId。
 * 输出：可能被改写的完整文件内容；任何不满足条件的情形都返回原 content。
 * 副作用：无（纯字符串/YAML 转换）。
 * 失败语义：不抛错——路径越界、无 frontmatter、YAML 错误、metadata 非 map 都原样放行。
 * 不变量：originSessionId 只写一次，已有非空值绝不覆盖；
 *   改写后保持原换行风格（CRLF 输入仍输出 CRLF）。
 */
export function stampMemoryOriginSessionId(input: {
  content: string;
  filePath: string;
  memoryRoot: string | undefined;
  sessionId: string;
}): string {
  if (
    !input.memoryRoot ||
    !input.filePath.endsWith(".md") ||
    memoryFileRelativePath(input.memoryRoot, input.filePath) === undefined
  ) {
    // 非记忆目录、非 .md 或路径越界：标记没有意义，原样返回避免污染普通文件。
    return input.content;
  }

  const match = MEMORY_FRONTMATTER_PATTERN.exec(input.content);
  // 没有 frontmatter：文件不符合记忆格式，交给 prompt 约束，而不是强行补一个头。
  if (!match) return input.content;

  const opening = match[1]!;
  const frontmatter = match[2]!;
  const closing = match[3]!;
  const document = parseDocument(frontmatter);
  // YAML 不合法说明 frontmatter 已损坏；重写只会扩大损坏范围，直接放行。
  if (document.errors.length > 0) return input.content;

  try {
    if (document.get("metadata", true) === undefined) document.set("metadata", {});
    const metadata = document.get("metadata", true);
    // metadata 不是 mapping（如字符串/数组）时无法安全插入字段，保持原样。
    if (!isMap(metadata)) return input.content;

    const existingOrigin = metadata.get("originSessionId");
    // 已有来源：后续编辑不覆盖，保证“首次写入者”作为稳定归因。
    if (typeof existingOrigin === "string" && existingOrigin.length > 0) return input.content;

    // 基线只在缺少 origin 时序列化 frontmatter，并在同一次写入补齐 node_type。
    // 先删再 unshift：保证 node_type 位于 metadata 首行，且不会因重复编辑累积。
    metadata.delete("node_type");
    metadata.items.unshift(document.createPair("node_type", "memory"));
    metadata.set("originSessionId", input.sessionId);
  } catch {
    // 非 mapping 的 metadata 不做修复；Memory 文件格式仍由 prompt 约束。
    return input.content;
  }

  const lineEnding = opening.endsWith("\r\n") ? "\r\n" : "\n";
  // YAML 序列化统一产出 LF；按原文件风格转换，避免整文件换行被意外改写。
  const stampedFrontmatter = document.toString().replace(/\n$/u, "").replace(/\n/gu, lineEnding);
  return `${opening}${stampedFrontmatter}${closing}${input.content.slice(match[0].length)}`;
}
