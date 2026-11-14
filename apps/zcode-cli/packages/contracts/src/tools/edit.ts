// ============================================================
// Edit Tool - File Editing Tool
// ============================================================
// Reference: file edit input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

/**
 * Edit 入参：file_path 必须是绝对路径，old_string/new_string 必须不同，
 * `replace_all` 默认 false 且经语义布尔归一（"true"/1/"yes" 都算真）。
 * 唯一性不变量：非 replace_all 时 old_string 在文件里必须恰好命中一次，
 * 命中零次或多处分别由 core 的 handler 返回 OLD_STRING_NOT_FOUND / AMBIGUOUS_REPLACE。
 */
export const EditInputSchema = z.object({
  /**
   * The absolute path to the file to modify.
   */
  file_path: z
    .string()
    .describe("The absolute path to the file to modify"),
  /**
   * The text to replace
   */
  old_string: z.string().describe("The text to replace"),
  /**
   * The text to replace it with (must be different from old_string)
   */
  new_string: z
    .string()
    .describe("The text to replace it with (must be different from old_string)"),
  /**
   * Replace all occurrences of old_string (default false)
   */
  replace_all: semanticBoolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences of old_string (default false)"),
});

/** 归一化后的编辑入参；拒绝在 schema 层发生，handler 不再猜测字符串布尔。 */
export type EditInput = z.infer<typeof EditInputSchema>;

/** 面对模型的 JSON schema；与运行时 EditInputSchema 同源，避免“告诉一套、执行另一套”。 */
export const EditInputJsonSchema = toToolJsonSchema(EditInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

/**
 * Edit 输出（handler 产出、executor 投影）：`originalFile` 是编辑前全文，供回滚/对比；
 * `structuredPatch` 是实际改动的 hunk 列表（原子写成功后才有意义），`gitDiff` 只在
 * 可读到 git 状态时出现。`matchStrategy`/`matchCandidateCount` 记录匹配口径与候选数：
 * 精确匹配是常态，其他策略（如行尾空白归一）必须在结果里可见，便于模型判断是否误改。
 * `userModified` 表示用户改过提议内容，`replaceAll` 回显入参事实。
 */
export interface EditOutput {
  /**
   * The file path that was edited
   */
  filePath: string;
  /**
   * The original string that was replaced
   */
  oldString: string;
  /**
   * The new string that replaced it
   */
  newString: string;
  /**
   * The original file contents before editing
   */
  originalFile: string;
  /**
   * Diff patch showing the changes
   */
  structuredPatch: DiffHunk[];
  /**
   * Whether the user modified the proposed changes
   */
  userModified: boolean;
  /**
   * Whether all occurrences were replaced
   */
  replaceAll: boolean;
  /**
   * Matching strategy used to find oldString. Exact is expected for normal edits.
   */
  matchStrategy?: string;
  /**
   * Number of candidate positions observed by the selected match strategy.
   */
  matchCandidateCount?: number;
  /**
   * Git diff information (for remote scenarios)
   */
  gitDiff?: GitDiff;
}

/**
 * 一个 diff hunk：行号 1 起，`lines` 保留前缀语义（空格/加/减），
 * 由 core 的 diff 生成器产出，display 与持久化 patch 共用，不改写文本。
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * 单文件 git diff 摘要：`status` 只区分 modified/added（删除不走 Edit），
 * additions/deletions/changes 是计数，`patch` 是统一 diff 文本；`repository`
 * 仅为展示（owner/repo），模型读不到远端，不参与任何权限判定。
 */
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

/** hunk 的运行时 schema；`lines` 逐行保留，不做 trim，否则 patch 无法重放。 */
export const EditDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

/** git diff 摘要的运行时 schema；`repository` 可空，absence 与 null 都表示无远端信息。 */
export const EditGitDiffSchema = z
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

/**
 * Edit 输出的运行时校验 schema；`perf` 由 executor 追加，不属于 handler 业务结果。
 * `.strict()` 让“输出多一个字段”成为显式契约变更，而不是静默通过。
 */
export const EditOutputSchema = z
  .object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    originalFile: z.string(),
    structuredPatch: z.array(EditDiffHunkSchema),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    matchStrategy: z.string().optional(),
    matchCandidateCount: z.number().int().nonnegative().optional(),
    gitDiff: EditGitDiffSchema.optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

/** 面对模型/客户端的输出 JSON schema；截断由 resultBudget 处理，不在这里删字段。 */
export const EditOutputJsonSchema = toToolJsonSchema(EditOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

/**
 * Edit 调用身份：`id` 是 toolCallId，`traceId` 贯穿审批、读写与结果归因；
 * `startedAt` 只服务时长/展示，不参与配对。
 */
export interface EditToolCall {
  id: ToolCallId;
  name: "Edit";
  input: EditInput;
  traceId: TraceId;
  startedAt: Date;
}

/** Edit 结算：`toolCallId` 回指调用行，`output` 已过输出 schema，`durationMs` 含读文件与原子写。 */
export interface EditToolResult {
  toolCallId: ToolCallId;
  output: EditOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Edit Errors
// -----------------------------------------------

/**
 * Edit 的结构化失败码（数字常量，跨进程与模型文案都按它判别）。
 * 关键形态：OLD_STRING_NOT_FOUND(8) 表示旧文本零命中，AMBIGUOUS_REPLACE(9) 表示
 * 非 replace_all 却命中多处，STALE_FILE(7)/FILE_NOT_READ(6) 表示前置读状态失效，
 * FILE_TOO_LARGE(10) 与 INVALID_PATH(13) 在执行前拒绝。数值是既有协议，不可重排。
 */
export const EditErrorCode = {
  NO_CHANGE: 1,
  FILE_EXISTS_NO_OLD_STRING: 3,
  FILE_NOT_EXIST: 4,
  NOTEBOOK_FILE: 5,
  FILE_NOT_READ: 6,
  STALE_FILE: 7,
  OLD_STRING_NOT_FOUND: 8,
  AMBIGUOUS_REPLACE: 9,
  FILE_TOO_LARGE: 10,
  INVALID_PATH: 13,
} as const;

/** EditErrorCode 的值联合；失败一律走结构化结果，不抛裸异常。 */
export type EditErrorCode = (typeof EditErrorCode)[keyof typeof EditErrorCode];

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  // 与 Bash 契约同一套归一：模型常把布尔写成 "true"/"1"，
  // preprocess 要在 z.boolean() 判类型前把它们转成真布尔，否则合法调用被拒。
  return z.preprocess((value) => {
    // 真布尔直接返回，保持原值，避免二次转换引入歧义。
    if (typeof value === "boolean") return value;
    // 数字只认 1/0：其它数字原样返回交给 schema 报类型错误，
    // 不能把 2 猜成 true——对 replace_all 这类破坏性开关会放大误改范围。
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    // 非字符串（对象/数组/null）原样透传，由 schema 产出带字段路径的类型错误。
    if (typeof value !== "string") return value;

    // 空白与大小写归一：" TRUE "、"Yes" 都表示同一个意图。
    const normalized = value.trim().toLowerCase();
    // 只认显式白名单：避免 "no"/"off" 被 JS 真值判断误判成开启。
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    // 白名单外原样返回，让 schema 报错并回显原始值，而不是静默变成 false。
    return value;
  }, z.boolean());
}
