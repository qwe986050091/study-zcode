// INV-01 只读契约：守住位置 全文件；改错故障 范围读取产生写入或删除副作用。
// INV-02 行号从 0 起：守住位置 normalizeOffsetLine；改错故障 返回的 startLine 整体偏移一行。
// INV-03 双路径同语义：守住位置 readRangeFast / readRangeStreaming；改错故障 大文件与小文件切片结果不一致。
// INV-04 大小门禁先于读取：守住位置 assertWithinMaxBytes；改错故障 超限文件仍被整读进内存。
// INV-05 快慢路径阈值：守住位置 FAST_PATH_MAX_BYTES；改错故障 10MB 边界两侧行为跳变不可预期。
// INV-06 取消可中断：守住位置 throwIfAborted 与 abort 监听；改错故障 用户取消后仍读完整个大文件。
// INV-07 流式内存与行数无关：守住位置 carry + selectedLines；改错故障 保留全部行导致内存暴涨。
// INV-08 跨块残行保留：守住位置 carry 的 pop/push；改错故障 块边界处丢字符。
// INV-09 末行不丢：守住位置 decoder.end 与 sawAnyBytes 分支；改错故障 无换行结尾的文件少一行。
// INV-10 行尾统一去 CR：守住位置 normalizeCompletedLine；改错故障 返回内容残留 \r。
// INV-11 编码探测只看头部：守住位置 ENCODING_SAMPLE_BYTES；改错故障 为探测编码读完整文件。
// INV-12 样本补齐不扩样：守住位置 getUtf8CompletionBytes；改错故障 扩样再次切断下一个字符。
// INV-13 句柄必然关闭：守住位置 detectEncodingFromHead 的 finally；改错故障 句柄泄漏。
// INV-14 revision 取整文件：守住位置 revisionId(mtime,size)；改错故障 偏移读取的 revision 与全文不一致。
//
// 模块职责：按行范围读取文本文件，小文件整读切片，大文件流式只保留目标行。
// 阅读顺序：先看入口的分流，再看两条读取路径，最后看编码探测与行选择工具。
/**
 * ============================================================================
 * fs/text-range-reader.ts —— 按行范围读取文本
 * ============================================================================
 *
 * 【定位】readTextFileRange 的实现：只返回 [offsetLine, offsetLine+limit) 的
 * 行，避免整文件进入上层上下文。小文件（<=10MB）整读后切片；大文件流式
 * 逐块解码、只保留目标行。
 *
 * 【口径】offsetLine 从 0 开始（返回 startLine=offsetLine+1）；limit 缺省读到
 * 末尾；行内容去掉行尾 \r，行间用 \n 拼接。totalLines 是全文行数（流式时
 * 依赖完整读一遍）。truncated 恒为 false（范围读不是"截断"）。
 *
 * 【失败语义】文件大小超过 maxBytes 抛 too_large（提示改用 offset/limit）；
 * 编码无法探测抛 unsupported；取消抛 AbortError。大文件流式读取时若取消，
 * 会 destroy 流并移除 abort 监听。
 *
 * 【副作用】只读；流式路径会打开文件句柄并在 finally 关闭。
 * ============================================================================
 */
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  createFileSystemError,
  type FileSystemTextEncoding,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
} from "@zcode/contracts";
import {
  createStreamingTextDecoder,
  decodeTextBuffer,
  detectLineEndings,
  detectTextEncoding,
  getUtf8CompletionBytes,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";

const FAST_PATH_MAX_BYTES = 10 * 1024 * 1024;
const ENCODING_SAMPLE_BYTES = 4096;

/**
 * 按行范围读取文本文件。
 *
 * info 必须是调用方已 stat 的结果（size/mtime 用于预算与 revision）；
 * 超过 maxBytes 直接失败。<=10MB 走整读快路径，更大走流式慢路径。
 * 返回值中的 revision 仍是整文件 mtime+size，不是所选行的摘要。
 */
export async function readTextFileRangeFromNode(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  assertWithinMaxBytes(request.path, info.size, request.maxBytes);

  // 阈值内整读，阈值外流式。
  if (info.size <= FAST_PATH_MAX_BYTES) {
    return readRangeFast(request, info, signal);
  }

  return readRangeStreaming(request, info, signal);
}

// 未配置上限时不拦截。
function assertWithinMaxBytes(path: string, sizeBytes: number, maxBytes: number | undefined): void {
  if (maxBytes === undefined || sizeBytes <= maxBytes) return;
  throw createFileSystemError({
    code: "too_large",
    path,
    message: `File content (${formatFileSize(sizeBytes)}) exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
  });
}

// 整读后统一换行再切片。
async function readRangeFast(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  throwIfAborted(signal);
  const buffer = await readFile(request.path);
  throwIfAborted(signal);
  const decoded = decodeTextBuffer({
    buffer,
    encoding: request.encoding,
    path: request.path,
  });
  const encoding = decoded.encoding;
  const rawContent = decoded.content;
  const isText = shouldNormalizeLineEndings(encoding);
  // 只有文本编码才做换行归一。
  const normalized = isText ? normalizeLineEndings(rawContent) : rawContent;
  // 空文件不能切出一行空串。
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const selectedLines = selectLines(lines, offsetLine, request.limitLines);

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: isText ? detectLineEndings(rawContent) : undefined,
    bytesRead: buffer.byteLength,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lines.length,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

/**
 * 流式读取大文件（>10MB）。
 *
 * 先只读头部 4KB 探测编码，再用流式解码器逐块处理：carry 保存跨块的不完整
 * 行，完整行按需入 selectedLines。只统计行号、不保留目标范围外的行，因此
 * 内存与"总行数"无关。finally 里务必移除 abort 监听，避免 signal 长期持有
 * 流引用。
 */
// 流式路径不保留范围外的行。
async function readRangeStreaming(
  request: FileSystemReadTextRangeRequest,
  info: Stats,
  signal?: AbortSignal,
): Promise<FileSystemReadTextRangeResult> {
  const encoding = request.encoding ?? (await detectEncodingFromHead(request.path, signal));
  const decoder = createStreamingTextDecoder(encoding);
  const selectedLines: string[] = [];
  const offsetLine = normalizeOffsetLine(request.offsetLine);
  const limitLines = normalizeLimitLines(request.limitLines);
  let carry = "";
  let lineIndex = 0;
  let bytesRead = 0;
  let crlfCount = 0;
  let lfCount = 0;
  let sawAnyBytes = false;

  // 读取用流，避免整文件驻留。
  const stream = createReadStream(request.path);
  const abort = (): void => {
    stream.destroy(createAbortError(request.path));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    // 逐块交给 TextDecoder 解码，再按 \n 切行并保留 carry。
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sawAnyBytes = sawAnyBytes || buffer.byteLength > 0;
      bytesRead += buffer.byteLength;
      const text = decoder.write(buffer);
      const parts = `${carry}${text}`.split("\n");
      carry = parts.pop() ?? "";
      for (const part of parts) {
        const normalized = normalizeCompletedLine(part);
        if (part.endsWith("\r")) crlfCount += 1;
        else lfCount += 1;
        if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
          selectedLines.push(normalized);
        }
        lineIndex += 1;
      }
    }

    const finalText = decoder.end();
    if (finalText.length > 0) {
      carry += finalText;
    }
    if (sawAnyBytes) {
      const normalized = normalizeCompletedLine(carry);
      if (shouldSelectLine(lineIndex, offsetLine, limitLines, selectedLines.length)) {
        selectedLines.push(normalized);
      }
      lineIndex += 1;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }

  return {
    path: request.path,
    content: selectedLines.join("\n"),
    encoding,
    lineEndings: crlfCount > lfCount ? "CRLF" : "LF",
    bytesRead,
    sizeBytes: info.size,
    truncated: false,
    startLine: offsetLine + 1,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    revision: {
      id: revisionId(info.mtimeMs, info.size),
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size,
    },
  };
}

/**
 * 只读文件头 4KB 用于编码探测。
 *
 * 样本可能切在 UTF-8 多字节字符中间；只补足"当前候选字符"缺的字节（不固定
 * 扩样），否则会再次切开下一个字符。句柄在 finally 关闭；每个读阶段检查取消。
 */
// 只读头部样本推断编码。
async function detectEncodingFromHead(
  path: string,
  signal?: AbortSignal,
): Promise<FileSystemTextEncoding> {
  throwIfAborted(signal);
  const handle = await open(path, "r");
  try {
    let sample = Buffer.alloc(ENCODING_SAMPLE_BYTES);
    let totalBytesRead = 0;
    while (totalBytesRead < sample.byteLength) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(
        sample,
        totalBytesRead,
        sample.byteLength - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
      if (totalBytesRead === ENCODING_SAMPLE_BYTES) {
        // 样本可能切在 UTF-8 字符中间；只补足当前候选，固定扩样会再次切开后一个字符。
        const missingBytes = getUtf8CompletionBytes(sample);
        // 只补足当前字符缺的字节。
        if (missingBytes > 0) sample = Buffer.concat([sample, Buffer.alloc(missingBytes)]);
      }
    }
    throwIfAborted(signal);
    return detectTextEncoding(sample.subarray(0, totalBytesRead), path);
  } finally {
    await handle.close();
  }
}

function normalizeOffsetLine(offsetLine: number | undefined): number {
  return Math.max(0, Math.trunc(offsetLine ?? 0));
}

function normalizeLimitLines(limitLines: number | undefined): number | undefined {
  if (limitLines === undefined) return undefined;
  return Math.max(0, Math.trunc(limitLines));
}

function selectLines(
  lines: string[],
  offsetLine: number,
  limitLines: number | undefined,
): string[] {
  const limit = normalizeLimitLines(limitLines);
  return limit === undefined
    ? lines.slice(offsetLine)
    : lines.slice(offsetLine, offsetLine + limit);
}

// 行选择同时受偏移与条数约束。
function shouldSelectLine(
  lineIndex: number,
  offsetLine: number,
  limitLines: number | undefined,
  selectedCount: number,
): boolean {
  if (lineIndex < offsetLine) return false;
  return limitLines === undefined || selectedCount < limitLines;
}

function normalizeCompletedLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// 版本号表达整文件而非所选区间。
function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)}KB`;
  return `${formatUnit(bytes / (1024 * 1024))}MB`;
}

function formatUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createAbortError("file range read");
}

function createAbortError(path: string): Error {
  const error = new Error(`File system operation was cancelled: ${path}`);
  error.name = "AbortError";
  return error;
}
