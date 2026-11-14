// ============================================================
// Grep Tool - Content Search Tool
// ============================================================
// Reference: grep-style search tool
//
// 本文件声明 Grep 的输入/输出与错误码契约，不 spawn 进程；真实搜索由 core handler 调
// FileSystemPort 的 ripgrep 兼容实现完成。pattern 是 ripgrep 正则（不是 grep BRE），
// output_mode 三选一：content（匹配行）/files_with_matches（默认，仅路径）/count；
// head_limit/offset 对所有 mode 生效，默认 head_limit=250、0 表示不限。只读、并发安全、
// 无审批；显式 path 经 path-policy 做 workspace 越界校验。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// 三种输出模式的规范取值。它既是 runtime schema 的枚举来源，也是 handler 分派文案投影的
// 判别键；新增模式必须同时改 GrepOutputSchema 的 enum 与 formatModelContent 的分支，
// 否则跨进程回放会在投影层落到未知分支。
export const GrepOutputMode = {
  Content: "content",
  FilesWithMatches: "files_with_matches",
  Count: "count",
} as const;

// 输出模式联合类型，由上面的字面量对象派生；模型传值先经 GrepInputSchema 的 enum 校验，
// 因此这里不需要额外的运行时收窄。
export type GrepOutputMode = (typeof GrepOutputMode)[keyof typeof GrepOutputMode];

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

// Grep 的运行时输入 schema。字段刻意对齐 ripgrep 短选项（-A/-B/-C/-n/-i/-o），让模型可以
// 按熟悉的语义传参；handler 再把 context 与 -C 归一成具体的前后文行数。output_mode 缺省
// 由 handler 按 files_with_matches 处理，head_limit 缺省 250、0 表示不限。
export const GrepInputSchema = z.object({
  /**
   * Ripgrep-compatible regular expression pattern to search for in file contents.
   */
  pattern: z
    .string()
    .describe("The regular expression pattern to search for in file contents"),
  /**
   * Optional file or directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search in (rg PATH). Defaults to current working directory.",
    ),
  /**
   * Glob pattern to filter files.
   */
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  "-B": z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  "-A": z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  "-C": z
    .number()
    .optional()
    .describe("Alias for context."),
  context: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  "-n": z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  "-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
  "-o": z
    .boolean()
    .optional()
    .describe(
      'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
    ),
  type: z
    .string()
    .optional()
    .describe(
      "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
    ),
});

// 运行时推导的输入类型，供 core handler 内部使用；跨进程边界只认 JSON Schema。
export type GrepInput = z.infer<typeof GrepInputSchema>;

// provider 可见的输入 schema，由运行时 schema 投影而来；两份同源，避免模型侧参数与执行侧
// 校验出现漂移（例如 -A/-B 只在 content 模式下有意义，这一点写在字段描述里）。
export const GrepInputJsonSchema = toToolJsonSchema(GrepInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

// Grep 的结构化输出。生产者是 core handler（数据来自 FileSystemPort.searchText），消费者是
// UI/回放与 formatModelContent。三种 mode 共用这个外壳，但字段在不同 mode 下互斥：
// filenames 只在 files_with_matches 有值，content 只在 content/count 有值。
export interface GrepOutput {
  // 实际生效的输出模式，与输入 output_mode 对应；缺省时 handler 会填 files_with_matches。
  mode: GrepOutputMode;
  // 端口统计的搜索耗时（毫秒），不含格式化与落盘；用于遥测，不参与分页。
  durationMs: number;
  // 命中文件数，恒为去重后的文件数量；content/count 模式下 filenames 为空但此值仍在。
  numFiles: number;
  // 命中文件路径列表，仅 files_with_matches 模式回填；已转成相对工作目录的 `/` 路径。
  filenames: string[];
  // content 模式为带行号/上下文的匹配行文本；count 模式为 `path:count` 逐行文本。
  content?: string;
  // content 模式实际返回的行数（含上下文行），用于预算与文案统计；其他模式缺席。
  numLines?: number;
  // 命中总数（三种模式都回填）：content 是匹配行计数，count 是各文件计数之和。
  numMatches?: number;
  // 是否因 head_limit/offset 或端口上限被截断；截断不失败，但模型据 appliedLimit 续读。
  truncated: boolean;
  // 实际生效的条数上限（缺省 250；0 表示不限时通常缺席），供文案提示分页口径。
  appliedLimit?: number;
  // 实际跳过的条数（对应输入 offset，缺省 0），与 appliedLimit 一起构成续读提示。
  appliedOffset?: number;
}

// 输出 schema 的运行时校验面。strict 拒绝额外字段；appliedLimit/appliedOffset 允许缺席，
// 因为已被截断的旧结果在回放时不保证带分页信息。它与 GrepOutput 必须逐字段同步。
export const GrepOutputSchema = z
  .object({
    mode: z.enum(["content", "files_with_matches", "count"]),
    durationMs: z.number().int().nonnegative(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().int().nonnegative().optional(),
    numMatches: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    appliedLimit: z.number().int().nonnegative().optional(),
    appliedOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

// provider 可见的输出 schema，由运行时 schema 投影；工具结果回放时按它校验，保证旧数据
// 不会以未声明的形状进入模型上下文。
export const GrepOutputJsonSchema = toToolJsonSchema(GrepOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

// 一次 Grep 调用的运行时外壳。name 固定为 "Grep"；traceId 用于把 ripgrep 端口侧的
// 读写与 span 挂回同一任务链，startedAt 是墙上时钟，不等于 durationMs。
export interface GrepToolCall {
  id: ToolCallId;
  name: "Grep";
  input: GrepInput;
  traceId: TraceId;
  startedAt: Date;
}

// 一次 Grep 调用的结果外壳。toolCallId 与 GrepToolCall.id 配对，output 已按
// GrepOutputSchema 校验；traceId 必须与调用侧一致，便于跨进程还原搜索链路。
export interface GrepToolResult {
  toolCallId: ToolCallId;
  output: GrepOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Grep Errors
// -----------------------------------------------

// Grep 的稳定错误码。core handler 实际会产出的类别：pattern/path 非法、权限拒绝、
// 结果过大、取消与 I/O 失败；其中取消在 handler 里被翻译成 CoreErrorType.ToolCancelled，
// 不直接以字符串码返回，TOO_LARGE/CANCELLED 是留给端口与权限层的契约位。
export const GrepErrorCode = {
  INVALID_PATTERN: "grep_invalid_pattern",
  INVALID_PATH: "grep_invalid_path",
  PERMISSION_DENIED: "grep_permission_denied",
  TOO_LARGE: "grep_too_large",
  CANCELLED: "grep_cancelled",
  IO_ERROR: "grep_io_error",
} as const;

// 错误码联合类型，由字面量对象派生；新增码只改对象，类型自动跟随。
export type GrepErrorCode = (typeof GrepErrorCode)[keyof typeof GrepErrorCode];
