// ============================================================
// Glob Tool - File Pattern Matching Tool
// ============================================================
// Reference: glob-style file matching tool
//
// 本文件只声明 Glob 的契约面（输入/输出 schema、错误码、调用与结果外壳），不执行搜索。
// 真实语义由 core 侧 handlers/glob.ts 承担：pattern 交给 FileSystemPort 解释，path 缺省取
// 会话工作目录，显式路径按 read 操作做 workspace 越界校验；结果按 mtime 排序、上限 100 条，
// 超出时以 truncated 标记而不是失败。Glob 只列路径、不读内容，因此只读、并发安全、无审批。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

// Glob 的运行时输入 schema。生产者是模型 tool_call（经 executor 校验），消费者是 core
// handler；同一份定义再经 toToolJsonSchema 投影成 provider 侧 JSON Schema，保证模型看到的
// 参数与运行时校验不漂移。字段只有 pattern 与可选 path，其余旋钮刻意不给。
export const GlobInputSchema = z.object({
  /**
   * The glob pattern to match files against.
   */
  pattern: z.string().describe("The glob pattern to match files against"),
  /**
   * Optional directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    ),
});

// 从运行时 schema 推导的输入类型，供 core handler 内部使用；它不跨越进程，因此不需要
// 额外的运行时校验。跨进程/模型边界一律以 JSON Schema 为准。
export type GlobInput = z.infer<typeof GlobInputSchema>;

// provider 可见的输入 schema。toToolJsonSchema 会剥掉 $ref/$defs 等跨文档引用并补齐
// type，保证在同一份 JSON 里自包含、可被 provider 与 CLI 侧最小校验器一致解释。
export const GlobInputJsonSchema = toToolJsonSchema(GlobInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

// Glob 的结构化输出。生产者是 core handler（数据来自 FileSystemPort.searchFiles），消费者
// 是 UI/回放与 formatModelContent；模型侧只看投影后的文本，不看这些字段。
export interface GlobOutput {
  // 本次搜索耗时（毫秒），由端口返回，供遥测与 UI 展示；不参与排序或截断判定。
  durationMs: number;
  // 实际返回的文件数，等于 filenames.length；即使 truncated 为真，它也是"这一页"的数量。
  numFiles: number;
  // 文件路径列表，已按 mtime 从新到旧排序，且相对会话工作目录时转为 `/` 分隔。
  filenames: string[];
  // 结果是否被端口截断（上限 100 条）。截断不是失败，但模型必须据提示缩小 pattern/path。
  truncated: boolean;
}

// 输出 schema 的运行时校验面：strict 拒绝额外字段，避免下游把 adapter 的临时字段当成
// 契约。它同时被 executor 在返回前校验、被 toToolJsonSchema 投影，二者不另写一份。
export const GlobOutputSchema = z
  .object({
    durationMs: z.number().int().nonnegative(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

// provider 可见的输出 schema。工具结果回放给模型时按它校验，旧版本产生的形状不会被
// 静默当成新契约；契约演进必须同时改这里与 GlobOutput。
export const GlobOutputJsonSchema = toToolJsonSchema(GlobOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

// 一次 Glob 调用的运行时外壳（会话/事件侧用）。name 固定为 "Glob"，input 已通过运行时
// schema 校验；traceId 必须由调用链透传，startedAt 与结果里的 durationMs 是两套口径：
// 前者是墙上时钟起点，后者是端口统计的执行耗时。
export interface GlobToolCall {
  id: ToolCallId;
  name: "Glob";
  input: GlobInput;
  traceId: TraceId;
  startedAt: Date;
}

// 一次 Glob 调用的结果外壳。toolCallId 必须与对应 GlobToolCall.id 配对，输出由
// GlobOutputSchema 校验；traceId 用于把 adapter 侧 span 挂回同一任务链。
export interface GlobToolResult {
  toolCallId: ToolCallId;
  output: GlobOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Glob Errors
// -----------------------------------------------

// Glob 的稳定错误码。跨进程/日志只认这些字符串，不解析错误文案。当前 core handler 对
// pattern/path 的非法值主要通过输入 schema 与 path-policy 报错，这组码是契约预留位：
// 一旦 port 或权限层开始按类别返回，模型与 UI 可据此区分"输入不合法"与 I/O 失败。
export const GlobErrorCode = {
  INVALID_PATTERN: "glob_invalid_pattern",
  INVALID_PATH: "glob_invalid_path",
  PERMISSION_DENIED: "glob_permission_denied",
  IO_ERROR: "glob_io_error",
} as const;

// 错误码的联合类型，派生自 GlobErrorCode 的取值集合；新增码只需改上面的字面量对象，
// 类型与校验自动跟随。
export type GlobErrorCode = (typeof GlobErrorCode)[keyof typeof GlobErrorCode];
