// ============================================================
// RespondToCoordinator 工具契约 - 子代理回复父 runtime
// ============================================================
// 本文件只声明"子代理 → coordinator"的入参/输出形状，不投递消息。真实实现在 core 的
// handlers/respond-to-coordinator.ts，准入条件是 runtimeScope==="subagent" 且存在
// coordinatorResponsePort，二者缺一即 fail closed（ConfigurationError）。
// 语义边界：这是过程中的沟通通道，不是任务结果；模型不得用 assistant 正文替代它，也不得拿它
// 代替最终回复。消息写入父 runtime 队列，属于 session 级副作用。
// 输出形状的两层：provider schema 只暴露 {success,message}（见 handler），真正的
// responseId/status/error 由本文件的 runtimeOutputSchema 承载，供执行面与 UI 使用。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具注册名，同时是权限规则（agent.message.respond）、事件与 UI 投影的判别键。
export const RESPOND_TO_COORDINATOR_TOOL_NAME = "RespondToCoordinator";
// 回复正文的字符上限（20000）；与 summary 的 200 字符上限分开——summary 用于追踪/日志，
// message 用于实际沟通，长度预算不同。
export const RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS = 20_000;

// 回复入参：summary 是给追踪/日志的一句话摘要（≤200 字符），message 是真正投递给 coordinator
// 的正文（≤20000 字符）。两者都非空，strict 让多余字段成为可见错误。
export const RespondToCoordinatorInputSchema = z
  .object({
    // 短摘要，用于追踪与 UI 列表；不承载完整沟通内容。
    summary: z.string().min(1).max(200).describe("Short summary of the response."),
    // 实际投递给 coordinator 的回复/进度更新正文。
    message: z
      .string()
      .min(1)
      .max(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS)
      .describe("Response or progress update for the coordinator."),
  })
  .strict();

// 入参类型；handler 解析后直接交给 coordinatorResponsePort.respond。
export type RespondToCoordinatorInput = z.infer<typeof RespondToCoordinatorInputSchema>;

// provider 可见的入参 schema；投影保留 summary/message 的长度约束。
export const RespondToCoordinatorInputJsonSchema = toToolJsonSchema(
  RespondToCoordinatorInputSchema,
);

// 运行时输出：直接取自端口的投递结果，本层不做二次加工。status 表达"是否已入队"，
// responseId 是父 runtime 侧的回复标识，error 只在失败时出现；即便投递失败也返回 output
// 而不是抛错，保证每条 tool_call 都有配对结果。
export const RespondToCoordinatorOutputSchema = z
  .object({
    // 投递状态：success 已入队，failed 未入队。
    status: z.enum(["success", "failed"]),
    // 父 runtime 分配的回复 id；用于追踪与去重。
    responseId: z.string(),
    // 端口的回执文案；成功/失败都可能有。
    message: z.string(),
    // 失败原因；只在 status=failed 时出现。
    error: z.string().optional(),
  })
  .strict();

// 输出类型；formatModelContent 会把它压成一句给模型的话。
export type RespondToCoordinatorOutput = z.infer<typeof RespondToCoordinatorOutputSchema>;
