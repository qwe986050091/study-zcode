// ============================================================
// Read 工具文本分支
// ============================================================
// 职责：按 offset/limit 读取文本区间，做 token 预算校验与可选的部分视图降级，
// 最后给出带行号的模型可见文本（`cat -n` 风格）。
//
// 三个互不相同的概念，注释里必须区分：
//   - 字节截断（truncated）：io adapter 因 maxBytes 截断；
//   - token 截断（truncatedByTokenCap）：本次读取内容预估 token 超过
//     READ_MAX_OUTPUT_TOKENS，被本文件裁成部分视图；
//   - offset/limit 范围视图：模型主动请求的窗口，**不是**不完整内容。
// 只有 truncatedByTokenCap 会让 ReadFileState 标记 isPartialView，从而拒绝后续 Edit/Write。
//
// 预算策略：limit 未提供时才有 READ_MAX_FILE_SIZE_BYTES 的整文件字节上限——
// 给了 limit 说明模型只要一小段，不该先被整文件大小拒绝。
// 降级策略：只有"首次整文件读取"（offset/limit 都缺省）在超 token 时允许自动裁成
// 部分视图；显式范围读取超预算则直接报错，因为模型可以自己缩小范围，静默裁剪会
// 让它以为读到了完整区间。
//
// 错误：超 token 且不允许降级 → ToolExecutionFailed(recoverable=true，带
// read_output_too_many_tokens)；文件 I/O 错误原样由 port 抛出。
// 无副作用：纯读；行号与提示都是模型可见投影，不改变 ReadFileState 以外的状态。
// ============================================================

import {
  CoreErrorType,
  READ_DEFAULT_MAX_LINES,
  READ_MAX_FILE_SIZE_BYTES,
  READ_MAX_OUTPUT_TOKENS,
  createCoreError,
  type FileSystemPort,
  type FileSystemReadTextRangeResult,
  type ReadTextOutput,
  type TraceContext,
} from "@zcode/contracts";

import { estimateTokens } from "../../context/utils.js";

// 空文件提示也走 system-reminder 包裹：它是给模型的"这里确实没内容"结论，
// 不是文件正文；裸文本会让模型误以为文件包含这句话。
const EMPTY_FILE_REMINDER = formatReadToolResultWarning(
  "Warning: the file exists but the contents are empty.",
);
// 部分视图的目标是 85% 预算而不是 100%：截断后还要拼上提示文案，留出头部空间，
// 避免"裁剪后的正文 + 提示"再次超过同一 token 上限。
const READ_TOKEN_BUDGET_PARTIAL_TARGET = Math.floor(READ_MAX_OUTPUT_TOKENS * 0.85);

/**
 * 读取文本文件的参数。
 *
 * @field allowPartialFallback 超 token 时是否允许裁成部分视图；缺省按"首次整文件
 *   读取"判定（见 readTextFileForModel）。显式传 false 用于必须完整区间的调用方。
 * @field onRead 拿到**原始** range 读取结果（含 revision）的回调；Read 用它记录
 *   read-before-edit 的真实 revision，而不是 stat 时刻可能有偏差的 revision。
 * @field limit/offset 行窗口；offset 为 1-based，缺省从首行开始。
 */
export interface ReadTextFileForModelOptions {
  abortSignal?: AbortSignal;
  allowPartialFallback?: boolean;
  filePath: string;
  fileSystemPort: FileSystemPort;
  limit?: number;
  onRead?: (read: FileSystemReadTextRangeResult) => void;
  offset?: number;
  trace?: TraceContext;
}

/**
 * 读取文本区间并返回预算内的结构化输出。
 *
 * 输入：见 ReadTextFileForModelOptions；offset 为 1-based，缺省视为首行。
 * 输出：ReadTextOutput；若超 token 且允许降级，返回 `truncatedByTokenCap=true`
 * 的部分视图，`partialViewNotice` 会告诉模型如何用 offset 续读。
 * 副作用：一次文件读取；通过 onRead 向上回传原始读结果（含 revision）。
 * 失败：超 token 且不允许部分视图→ToolExecutionFailed(recoverable=true)；
 * 文件不存在/过大/取消由 FileSystemPort 原样抛出。
 * 关键边界：limit 一旦提供，就不向 port 传整文件 maxBytes——否则一个 500MB 文件
 * 的 10 行读取会被"文件太大"误杀。
 */
export async function readTextFileForModel({
  abortSignal,
  allowPartialFallback,
  filePath,
  fileSystemPort,
  limit,
  onRead,
  offset,
  trace,
}: ReadTextFileForModelOptions): Promise<ReadTextOutput> {
  const limitProvided = limit !== undefined;
  const read = await fileSystemPort.readTextFileRange(
    {
      path: filePath,
      offsetLine: toRangeOffsetLine(offset),
      limitLines: limit,
      maxBytes: limitProvided ? undefined : READ_MAX_FILE_SIZE_BYTES,
      trace,
    },
    { signal: abortSignal },
  );
  onRead?.(read);

  return readTextRangeResultToOutput({
    // 未显式指定时只在"首次整文件读取"下降级：模型没有给窗口，裁一段并以提示引导
    // 续读是唯一不失败的选择；给了范围却静默裁剪会让模型误判区间完整性。
    allowPartialFallback: allowPartialFallback ?? isInitialWholeFileRead(offset, limit),
    filePath,
    offset,
    read,
  });
}

/**
 * 把结构化文本输出投影成模型可见字符串。
 *
 * 输出形态：
 *   - 有内容 → `[部分视图提示]\n\n<行号>\t<正文`（行号从 startLine 起，1-based）；
 *   - 空文件 → 空文件 system-reminder；
 *   - offset 越过文件尾 → 说明"文件比 offset 短"的 system-reminder。
 * 为什么提示要放最前：模型先看到"这是部分视图"再读正文，才不会把片段当全文去编辑；
 * 提示用 <system-reminder> 包裹是为了与正文区分，避免被当成文件内容引用。
 * 纯函数，无副作用；不负责预算（预算在读取阶段已收口）。
 */
export function formatReadTextOutput(output: ReadTextOutput): string {
  const partialViewPrefix = output.partialViewNotice
    ? `${formatReadToolResultWarning(output.partialViewNotice)}\n\n`
    : "";

  if (!output.content) {
    const warning =
      output.totalLines === 0
        ? EMPTY_FILE_REMINDER
        : formatReadToolResultWarning(
            `Warning: the file exists but is shorter than the provided offset (${output.startLine}). The file has ${output.totalLines} lines.`,
          );
    return `${partialViewPrefix}${warning}`;
  }

  // 成功文本结果的模型可见契约只包含条件提醒与带行号正文；
  // 历史安全提醒不属于当前 tool result 路径。
  return `${partialViewPrefix}${addReadLineNumbers({
    content: output.content,
    startLine: output.startLine,
  })}`;
}

/**
 * 给每行加 `行号\t` 前缀（Read 的 cat -n 风格契约）。
 *
 * 行号 1-based，从 `startLine` 起；分隔按 `\r?\n` 处理，兼容 Windows CRLF 而不把 `\r`
 * 带进正文。为什么用 tab：`Edit` 的匹配依赖模型看到的文本，tab 比空格更容易与
 * 文件内容中的缩进区分开。
 * 纯函数，无副作用；不改变空行数量（split 会保留尾部空串）。
 */
export function addReadLineNumbers({
  content,
  startLine,
}: {
  content: string;
  startLine: number;
}): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join("\n");
}

function formatReadToolResultWarning(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}

/**
 * 把 1-based offset 转成 port 的 0-based 行偏移。
 *
 * offset 缺省或 <=1 都归为 0（首行）：模型传 0 或 1 都是"从头读"，统一后
 * read-before-edit 的缓存 key 才不会因为 0/1 差异而分叉。负数同样落到 0，
 * 不在这里报错——schema 层已负责范围校验。
 */
function toRangeOffsetLine(offset: number | undefined): number {
  if (offset === undefined || offset <= 1) return 0;
  return offset - 1;
}

// "首次整文件读取"的判定口径：offset 缺省/<=1 且未给 limit。
// 只有这种读取在超 token 时值得自动降级；其他读取都是模型指定的窗口，失败更有信息量。
function isInitialWholeFileRead(offset: number | undefined, limit: number | undefined): boolean {
  return (offset === undefined || offset <= 1) && limit === undefined;
}

/**
 * 把 port 的 range 读取结果转成 ReadTextOutput，并在此收口 token 预算。
 *
 * 超预算两条路：
 *   - allowPartialFallback=false → 抛 read_output_too_many_tokens（recoverable，提示用
 *     offset/limit 或搜索工具）；
 *   - true → 尝试 createTokenCapPartialView；连一行/一个字符都裁不出来时仍报错，
 *     不退化成"空成功"。
 * `startLine` 用 `offset === 0 ? 0 : read.startLine`：offset=0 表示从头且工具结果
 * 不显示行号基准 1（历史契约），其他情况信任 port 返回的行号。
 * 副作用：无；纯转换。
 */
function readTextRangeResultToOutput({
  allowPartialFallback,
  filePath,
  offset,
  read,
}: {
  allowPartialFallback: boolean;
  filePath: string;
  offset?: number;
  read: FileSystemReadTextRangeResult;
}): ReadTextOutput {
  const tokenCount = estimateTokens(read.content);
  if (tokenCount > READ_MAX_OUTPUT_TOKENS) {
    if (!allowPartialFallback) {
      throwReadOutputTokenBudgetError(tokenCount, filePath);
    }
    const fallback = createTokenCapPartialView(read, tokenCount);
    if (fallback) return { filePath, type: "text", ...fallback };
    throwReadOutputTokenBudgetError(tokenCount, filePath);
  }

  return normalizeReadTextOutput({
    type: "text",
    filePath,
    content: read.content,
    numLines: read.lineCount,
    startLine: offset === 0 ? 0 : read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: read.truncated,
  });
}

// 空文件统一成 numLines=1/totalLines=1 的空行形状：下游（ReadFileState、UI 行计数）
// 都假设至少一行；保留 0 行会让"文件存在但为空"在投影层变成格式异常。
function normalizeReadTextOutput(output: ReadTextOutput): ReadTextOutput {
  if (
    output.content.length === 0 &&
    output.numLines === 0 &&
    output.startLine === 1 &&
    output.totalLines === 0
  ) {
    return {
      ...output,
      numLines: 1,
      totalLines: 1,
    };
  }
  return output;
}

/**
 * 构造 token 超限时的部分视图（优先整行，退而截字符）。
 *
 * 两级策略的原因：先按行截能保证行号连续、模型可用 offset 续读；只有"第一行本身就
 * 超过预算"（例如压缩后的单行 JSON）时才退化成截首行字符，并在提示里说明为什么
 * 只给了第一行。
 * 输出总是 `truncated=true` + `truncatedByTokenCap=true`：Read 据此把该次读取标记
 * 为 partial view，禁止随后基于不完整内容编辑。
 * 返回 undefined 表示连一个可交付片段都构造不出来，由调用方转成错误；
 * 纯函数，无 I/O。
 */
function createTokenCapPartialView(
  read: FileSystemReadTextRangeResult,
  tokenCount: number,
): Omit<ReadTextOutput, "filePath" | "type"> | undefined {
  const lines = read.content.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  const lineCount = findLargestPrefixWithinTokenBudget(lines);
  if (lineCount > 0) {
    const content = lines.slice(0, lineCount).join("\n");
    const startLine = read.startLine;
    const endLine = startLine + lineCount - 1;
    const nextOffset = endLine + 1;
    return {
      content,
      numLines: lineCount,
      startLine,
      totalLines: read.totalLines,
      sizeBytes: read.sizeBytes,
      bytesRead: read.bytesRead,
      truncated: true,
      truncatedByTokenCap: true,
      partialViewNotice: [
        `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
        `Showing a partial view of lines ${startLine}-${endLine} of ${read.totalLines}.`,
        `Use Read with offset ${nextOffset} and limit ${READ_DEFAULT_MAX_LINES} to continue, or use a search tool to find a specific section.`,
      ].join(" "),
    };
  }

  const charCount = findLargestPrefixCharsWithinTokenBudget(read.content);
  if (charCount <= 0) return undefined;
  return {
    content: read.content.slice(0, charCount),
    numLines: 1,
    startLine: read.startLine,
    totalLines: read.totalLines,
    sizeBytes: read.sizeBytes,
    bytesRead: read.bytesRead,
    truncated: true,
    truncatedByTokenCap: true,
    partialViewNotice: [
      `The file is too large to display in full (${tokenCount} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}).`,
      "Showing a partial view of the first line because the first line alone exceeds the token budget.",
      "Use Read with a smaller range or use a search tool to find a specific section.",
    ].join(" "),
  };
}

// 二分找"能装进 85% 预算的最大行数前缀"。注意 mid 用 ceil 且失败时 high=mid-1，
// 保证 low 单调不减、循环收敛；返回 0 表示一行都装不下，交给字符级回退。
function findLargestPrefixWithinTokenBudget(lines: readonly string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(lines.slice(0, mid).join("\n")) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

// 字符级回退：仅用于"首行单行超预算"的场景。按 UTF-16 code unit 切分可能切开
// 代理对，但这里只是给模型一个可读前缀并明确告知被截断，不承诺字节/码点边界完整。
function findLargestPrefixCharsWithinTokenBudget(content: string): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, mid)) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * 抛出超 token 的稳定业务错误，并给出可操作的续读建议。
 * recoverable=true：模型可以改用 offset/limit 或搜索工具，不应把整轮判失败。
 * 不返回失败对象而是抛错，是为了让 executor 走"执行失败但可归因"的统一路径，
 * 与 FileSystemPort 的 I/O 错误保持同一形态。
 */
function throwReadOutputTokenBudgetError(tokenCount: number, filePath: string): never {
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    {
      context: {
        code: "read_output_too_many_tokens",
        filePath,
        maxTokens: READ_MAX_OUTPUT_TOKENS,
        tokenCount,
      },
      recoverable: true,
    },
  );
}
