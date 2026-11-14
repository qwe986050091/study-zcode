// ============================================================
// ApplyPatch Tool - Structured patch editing tool
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { EditDiffHunkSchema, type DiffHunk } from "./edit.js";
import { toToolJsonSchema } from "./json-schema.js";

/**
 * ApplyPatch 入参只有一个字段：模型提交完整的结构化补丁文本（多文件也可），
 * 不接受逐文件参数。core 的 patch-parser 解析、patch-apply 做全量预检后原子应用；
 * 任一文件/hunk 失败即整批不落盘，不存在“改了一半”的中间态。
 */
export const ApplyPatchInputSchema = z
  .object({
    patch_text: z.string().describe("The full structured patch text to apply"),
  })
  .strict();

/** 归一化后的补丁入参；补丁语法错误由 core 返回 INVALID_PATCH / EMPTY_PATCH。 */
export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>;

/** 面对模型的 JSON schema；单个字符串字段，provider 侧无需约束解码。 */
export const ApplyPatchInputJsonSchema = toToolJsonSchema(ApplyPatchInputSchema);

/**
 * 单个文件的变更记录：`type` 是 add/update/delete/move 四态，move 时 `movePath` 是目标；
 * `structuredPatch` 是实际应用的 hunk（add 也可为空），`additions`/`deletions` 是计数。
 * 由 patch-apply 产出，display 与模型结果共用；删除文件没有 hunk 内容。
 */
export const ApplyPatchFileChangeSchema = z
  .object({
    filePath: z.string(),
    type: z.enum(["add", "update", "delete", "move"]),
    movePath: z.string().optional(),
    structuredPatch: z.array(EditDiffHunkSchema),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })
  .strict();

/** 文件变更的 TS 视图；与上方 schema 逐字段对齐，仅多出类型收窄。 */
export interface ApplyPatchFileChange {
  filePath: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  structuredPatch: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * 一次补丁应用的结果：`files` 按补丁内文件顺序逐项给出，`structuredPatch` 是汇总 hunk，
 * `summary` 是给模型的一句话（多少个文件、增删行数）。三者都只在原子应用成功时产出；
 * 失败时走错误码，不返回部分结果。
 */
export interface ApplyPatchOutput {
  files: ApplyPatchFileChange[];
  structuredPatch: DiffHunk[];
  summary: string;
}

/** 补丁输出的运行时 schema；`.strict()` 禁止未知字段，汇总 hunk 与文件级 hunk 同源。 */
export const ApplyPatchOutputSchema = z
  .object({
    files: z.array(ApplyPatchFileChangeSchema),
    structuredPatch: z.array(EditDiffHunkSchema),
    summary: z.string(),
  })
  .strict();

/** 面对模型/客户端的输出 JSON schema；大补丁的截断仍由 resultBudget 统一处理。 */
export const ApplyPatchOutputJsonSchema = toToolJsonSchema(ApplyPatchOutputSchema);

/**
 * ApplyPatch 调用身份：`id` 是 toolCallId，`traceId` 贯穿解析、预检与原子写；
 * 所有文件写都归到同一次调用，便于回滚审计。
 */
export interface ApplyPatchToolCall {
  id: ToolCallId;
  name: "ApplyPatch";
  input: ApplyPatchInput;
  traceId: TraceId;
  startedAt: Date;
}

/** ApplyPatch 结算：`toolCallId` 回指调用行，`durationMs` 含全部文件的解析/预检/落盘。 */
export interface ApplyPatchToolResult {
  toolCallId: ToolCallId;
  output: ApplyPatchOutput;
  traceId: TraceId;
  durationMs: number;
}

/**
 * ApplyPatch 的结构化错误码：补丁不可解析/为空、目标文件不存在或已存在、
 * hunk 定位失败、IO 失败。全部属于“整批拒绝”，不会留下部分修改；
 * 模型应据码重发补丁，而不是把失败当成权限问题。
 */
export const ApplyPatchErrorCode = {
  INVALID_PATCH: "apply_patch_invalid_patch",
  EMPTY_PATCH: "apply_patch_empty_patch",
  FILE_NOT_EXIST: "apply_patch_file_not_exist",
  FILE_EXISTS: "apply_patch_file_exists",
  HUNK_NOT_FOUND: "apply_patch_hunk_not_found",
  IO_ERROR: "apply_patch_io_error",
} as const;

/** ApplyPatchErrorCode 的值联合；跨进程保存时保持字符串原样。 */
export type ApplyPatchErrorCode = (typeof ApplyPatchErrorCode)[keyof typeof ApplyPatchErrorCode];
