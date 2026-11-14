// ============================================================
// compact-post-reminders —— compact 之后补回"已读文件"的上下文
// ============================================================
//
// 【职责】
//   compact 会丢弃较早的工具调用/结果,模型因此失去"我已经读过哪些文件"的记忆。
//   本文件把 runtime 的 readFileState(工具层维护的读取缓存)投影成
//   resume_referenced_session_context 提醒,追加在压缩后历史末尾,
//   让模型知道自己已读过什么、内容是什么,避免重复 Read 或误判文件未读。
//
// 【输入/输出】
//   输入:readFileState、可选的条数/单文件/total 预算,以及 preservedEntries
//   (用于剔除"保留区间里已经原样保留的 Read")。
//   输出:RuntimeMessageEntry[](attachment,source=resume_referenced_session_context);
//   可能为空数组(没有候选/全被过滤)。
//
// 【副作用】
//   无 I/O、无落盘;只读 readFileState 与传入条目。
//
// 【不变量】
//   - 保留区间已经把某些 Read 原文留下了,这里必须按规范化路径去重,
//     否则同一次读取会在压缩后出现两份,白白占用上下文。
// ============================================================
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type { ReadFileStateEntry, ReadFileStateMap } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

/**
 * 构造 compact 后的"已读文件"提醒条目。
 *
 * 输入:readFileState(必需)、maxFiles(默认 5)、maxFileApproxTokens(默认 5000)、
 *       maxTotalApproxTokens(默认 50000)、preservedEntries(去重用)。
 * 输出:0..maxFiles 条 resume_referenced_session_context attachment。
 * 语义:候选只取 sourceTool 为 Read(或未标注)的条目,按 readAt 倒序(最近优先);
 *       排除记忆目录 / superpowers plans / .git 等内部路径。
 *       - 单文件超预算:只给"路径 + 用 Read 重新读取"的提示;
 *       - 累计超预算:同样降级为路径提示,而不是直接丢弃(否则模型会以为没读过);
 *       - 其余:渲染成一段伪造的 Read 调用/结果对,保留行号与 offset。
 * 副作用:无。
 * 失败:readFileState 为空时返回空数组,不抛错。
 */
export function buildPostCompactReadStateReminderEntries(input: {
  maxFileApproxTokens?: number;
  maxFiles?: number;
  maxTotalApproxTokens?: number;
  preservedEntries?: readonly RuntimeMessageEntry[];
  readFileState?: ReadFileStateMap;
}): RuntimeMessageEntry[] {
  const readFileState = input.readFileState;
  if (!readFileState || readFileState.size === 0) {
    return [];
  }

  const maxFiles = input.maxFiles ?? 5;
  const maxFileApproxTokens = input.maxFileApproxTokens ?? 5_000;
  const maxTotalApproxTokens = input.maxTotalApproxTokens ?? 50_000;
  const selected: RuntimeMessageEntry[] = [];
  let totalApproxTokens = 0;
  const preservedReadFilePaths = collectPreservedReadFilePaths(input.preservedEntries ?? []);

  const candidates = Array.from(readFileState.values())
    .filter(isPostCompactReadReminderCandidate)
    .filter((entry) => !shouldSkipPostCompactReadStatePath(entry.path))
    .filter((entry) => !preservedReadFilePaths.has(normalizePostCompactReadStatePath(entry.path)))
    .sort((left, right) => right.readAt.getTime() - left.readAt.getTime());

  for (const entry of candidates) {
    if (selected.length >= maxFiles) break;

    const approxTokens = Math.ceil(entry.content.length / ESTIMATED_TOKEN_CHAR_DIVISOR);
    if (approxTokens > maxFileApproxTokens) {
      // 单文件过大:只给引用提示,避免一条提醒就把压缩腾出的空间吃回去。
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }
    if (totalApproxTokens + approxTokens > maxTotalApproxTokens) {
      // 总量超预算:后续文件一律降级为引用提示,而不是静默丢弃,
      // 否则模型会误以为这些文件从未读过。
      selected.push(buildPostCompactReadStateEntry(formatCompactFileReference(entry)));
      continue;
    }

    totalApproxTokens += approxTokens;
    selected.push(buildPostCompactReadStateEntry(formatReadStateProjection(entry)));
  }

  return selected;
}

/** 统一用 attachment 形态表达,source 决定它属于"可落库的历史连续性提醒"。 */
function buildPostCompactReadStateEntry(content: string): RuntimeMessageEntry {
  return systemReminderAttachmentEntry("resume_referenced_session_context", content);
}

/** 超预算时的降级文案:只保留路径,并明确告诉模型需要用 Read 自行重读。 */
function formatCompactFileReference(entry: ReadFileStateEntry): string {
  return `Note: ${entry.path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.`;
}

/**
 * 把缓存内容渲染成"Read 工具调用 + 结果"的形态:
 * 模型对 Read 结果的格式最熟悉,按此形态回放比原始文本更容易被正确理解。
 * 行号从 offset 推导(readStateStartLine),保证与真实 Read 的编号一致。
 */
function formatReadStateProjection(entry: ReadFileStateEntry): string {
  const content = addReadLineNumbers(entry.content, readStateStartLine(entry.offset));
  return [
    `Called the Read tool with the following input: ${formatFileStateInput(entry)}`,
    "Result of calling the Read tool:",
    content,
  ].join("\n");
}

/**
 * 候选口径:只回放 Read 产生的读取态。sourceTool 为 undefined 的是旧数据,
 * 按 Read 兼容处理;其它工具(如内部正则扫描)不在这里回放。
 */
function isPostCompactReadReminderCandidate(entry: ReadFileStateEntry): boolean {
  return entry.sourceTool === undefined || entry.sourceTool === "Read";
}

/**
 * 收集"已被保留区间原样保留"的 Read 路径(仅 assistant 的 toolCalls)。
 * 用规范化后的路径做集合,避免路径分隔符差异导致去重失效。
 */
function collectPreservedReadFilePaths(entries: readonly RuntimeMessageEntry[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role !== "assistant" || !entry.message.toolCalls) continue;
    for (const toolCall of entry.message.toolCalls) {
      if (toolCall.name !== "Read") continue;
      const filePath = readToolCallFilePath(toolCall.input);
      if (filePath) paths.add(normalizePostCompactReadStatePath(filePath));
    }
  }
  return paths;
}

function readToolCallFilePath(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const filePath = (input as { file_path?: unknown }).file_path;
  return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined;
}

function formatFileStateInput(entry: ReadFileStateEntry): string {
  return JSON.stringify({
    file_path: entry.path,
    ...(entry.offset === undefined ? {} : { offset: entry.offset }),
    ...(entry.limit === undefined ? {} : { limit: entry.limit }),
  });
}

function readStateStartLine(offset: number | undefined): number {
  if (offset === 0) return 0;
  if (offset !== undefined && offset > 1) return Math.trunc(offset);
  return 1;
}

function addReadLineNumbers(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

/**
 * 内部路径不参与回放:记忆目录、计划目录、.git 都属于"不该进模型上下文"的内容。
 * 用统一 '/' 分隔后再匹配,兼容 Windows 反斜杠。
 */
function shouldSkipPostCompactReadStatePath(filePath: string): boolean {
  const normalized = normalizePostCompactReadStatePath(filePath);
  return (
    normalized.includes("/.codex/memories/") ||
    normalized.includes("/docs/superpowers/plans/") ||
    normalized.includes("/.git/")
  );
}

/** 路径规范化:只统一分隔符,不做大小写折叠(大小写敏感文件系统必须保持原样)。 */
function normalizePostCompactReadStatePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
