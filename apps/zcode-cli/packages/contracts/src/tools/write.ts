// ============================================================
// Write Tool - File Writing Tool
// ============================================================
// Reference: file write input / output shape
// 生产者：core 的 handlers/write.ts 解析入参后经 FileSystemPort 做一次读 + 一次**原子**写
//（端口负责临时文件 + 重命名，失败不留半截内容）；消费者：模型读一句话结果，UI 读
// structuredPatch/gitDiff 渲染 diff，read-state 用 originalFile/revision 判定后续 Write/Edit。
// 覆盖语义：`type: "update"` 是正常路径而不是破坏性特例——覆盖前必须已完整 Read 且未被改动，
// 否则报 write_file_not_read / write_file_stale（都是可恢复业务失败）。
// 不变量：`content` 是**实际落盘**的字节（可能被记忆来源标记改写），不是模型传入的原文；
// `structuredPatch` 在 create 分支为空数组而非缺省（结果 schema 要求字段存在）。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

// 入参：`file_path` 必须绝对路径（相对路径在 handler 解析前就应被拒绝），`content` 是完整
// 新正文——本工具没有追加/局部替换模式，局部修改应改用 Edit。未加 `.strict()` 是历史形状，
// 但 provider schema 会拒绝多余字段；新增字段需先评估旧客户端回放。
export const WriteInputSchema = z.object({
  /**
   * The absolute path to the file to write.
   */
  file_path: z
    .string()
    .describe("The absolute path to the file to write (must be absolute, not relative)"),
  /**
   * The content to write to the file
   */
  content: z.string().describe("The content to write to the file"),
});

// handler 入参类型；`file_path` 在 handler 内经 resolveWorkspacePath 解析，但结果里回报的是
// 模型传入的原串，便于它复用同一路径字符串。
export type WriteInput = z.infer<typeof WriteInputSchema>;

// provider 可见 schema，与运行时同源（无默认值，required 正常计算为两个字段）。
export const WriteInputJsonSchema = toToolJsonSchema(WriteInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

// 写入结果的 TS 形状。字段口径：
// - `type`：create（目标原本不存在，含"原本是空文件"这一反直觉边界）或 update。
// - `filePath`：模型传入的原路径字符串，不是解析后的绝对路径。
// - `content`：实际落盘的完整正文（含记忆来源标记改写），供 read-state 与 diff 使用。
// - `structuredPatch`：update 时为逐行 diff hunk；create 时为空数组（schema 要求字段存在）。
// - `originalFile`：写前内容，create 时为 null；它同时是"是否 update"的判据来源。
// - `gitDiff`：仅远端场景提供，用于在不持有工作区时展示改动。
// - `userModified`：用户在确认窗改过提议内容后接受，此时模型上下文已不等于磁盘事实。
export interface WriteOutput {
  /**
   * Whether a new file was created or an existing file was updated
   */
  type: "create" | "update";
  /**
   * The path to the file that was written
   */
  filePath: string;
  /**
   * The content that was written to the file
   */
  content: string;
  /**
   * Diff patch showing the changes
   */
  structuredPatch: DiffHunk[];
  /**
   * The original file content before the write (null for new files)
   */
  originalFile: string | null;
  /**
   * Git diff information (for remote scenarios)
   */
  gitDiff?: GitDiff;
  /**
   * True when the user edited the proposed content in the permission dialog before accepting
   */
  userModified?: boolean;
}

// 一个 diff hunk（与结构化 patch 的通用形状对齐）：old/new 的起始行号与行数，`lines` 保留
// 原始前缀（空格/+/-），由渲染端决定着色；行号是 1-based 的文件行号，不是数组下标。
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

// 远端场景的 git diff 摘要：`status` 只有 modified/added（Write 不产生删除），`changes` 是
// additions+deletions 的总变动行数；`repository` 是 owner/repo 文本，缺席表示未知。
export interface GitDiff {
  filename: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  /**
   * GitHub owner/repo when available
   */
  repository?: string | null;
}

// DiffHunk 的运行时镜像（`.strict()`），与上面的接口逐字段对应；行数允许 0（纯新增/纯删除
// 的 hunk 在某一侧可以是 0 行）。
export const WriteDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

// GitDiff 的运行时镜像；`repository` 显式 nullable + optional，兼容远端端口不提供仓库信息的
// 两种历史写法（null 与缺席），二者对展示层等价。
export const WriteGitDiffSchema = z
  .object({
    filename: z.string(),
    status: z.enum(["modified", "added"]),
    additions: z.number().int(),
    deletions: z.number().int(),
    changes: z.number().int(),
    patch: z.string(),
    repository: z.string().nullable().optional(),
  })
  .strict();

// 写入结果的运行时契约（`.strict()`）。比上面的 `WriteOutput` 接口多一个 `perf` 字段：
// 那是 handler 附加的执行遥测（读写耗时/字节数），只走结果校验与 UI，不进入模型面文案；
// 接口未声明它，因此直接读接口类型拿不到 perf——两处差异是既有事实，不要当成笔误。
export const WriteOutputSchema = z
  .object({
    type: z.enum(["create", "update"]),
    filePath: z.string(),
    content: z.string(),
    structuredPatch: z.array(WriteDiffHunkSchema),
    originalFile: z.string().nullable(),
    gitDiff: WriteGitDiffSchema.optional(),
    userModified: z.boolean().optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

// provider 可见（或用于契约对齐）的输出 schema；模型实际只读到 formatModelContent 的一句
// 成功文案，`content`/patch 是给 UI 与 read-state 的结构化事实。
export const WriteOutputJsonSchema = toToolJsonSchema(WriteOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

// 调用结构：`traceId` 把文件写挂到同一条任务链（远端 workspace 也靠它归并），`startedAt`
// 供耗时归因，`name` 字面量限定工具身份。
export interface WriteToolCall {
  id: ToolCallId;
  name: "Write";
  input: WriteInput;
  traceId: TraceId;
  startedAt: Date;
}

// 调用与结果按 `toolCallId` 配对；`durationMs` 覆盖读 + 写两段（新建文件时的 not_found 读
// 也计入，因为那是一次真实发生的 I/O）。
export interface WriteToolResult {
  toolCallId: ToolCallId;
  output: WriteOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Write Errors
// -----------------------------------------------

// 稳定的错误码集合（按 code 而不是按文案判定，便于上层分类与重试策略）：
// - FILE_NOT_READ / PARTIAL_READ：没有完整读记录或只读过分片，必须先 Read。
// - STALE_FILE：读后文件被改，重读后重试；与 revision CAS 失败同属一类。
// - PERMISSION_DENIED / DIRECTORY_NOT_FOUND / IO_ERROR：来自文件系统端口的外因失败。
// - SECRET_DETECTED：内容扫描命中密钥，写入被拒（不可通过参数绕过）。
export const WriteErrorCode = {
  FILE_NOT_READ: "write_file_not_read",
  PARTIAL_READ: "write_partial_read",
  STALE_FILE: "write_stale_file",
  PERMISSION_DENIED: "write_permission_denied",
  SECRET_DETECTED: "write_secret_detected",
  IO_ERROR: "write_io_error",
  DIRECTORY_NOT_FOUND: "write_directory_not_found",
} as const;

// 错误码联合类型；调用方据此做分支（例如 STALE_FILE 提示重新读取，而不是提示换路径）。
export type WriteErrorCode = (typeof WriteErrorCode)[keyof typeof WriteErrorCode];
