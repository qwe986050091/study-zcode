// ============================================================
// TaskStop Tool 契约 - 终止后台任务
// ============================================================
// 生产者：core 的 handlers/task-stop.ts 解析入参后调用 backgroundTaskControlPort；
// 消费者：模型读成功文案与 task_id，UI/通知链用 task_type/command 展示"停了什么"。
// 关联键：`task_id` 与 TaskOutput 的注册表键同一命名空间；`shell_id` 是历史字段，仅作别名，
// 两者同时给出时以 `task_id` 为准（handler 的 `??` 顺序）。
// 幂等边界：重复 stop 一个已结束的任务不是成功——端口返回 not_running，handler 报 code 3，
// 让模型区分"已经结束"与"ID 打错"，绝不会把无效停止表述成已停止。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具名（权限规则 key 与遥测共用）。别名 KillShell/KillBash 在 ToolEntry 上声明，不在此处。
export const TASK_STOP_TOOL_NAME = "TaskStop";

// 入参：task_id 可选、shell_id 可选（均不做格式校验，注册表查不到由 handler 报业务失败）。
// 两个字段都 optional 是兼容事实；真正的"必须有 ID"判定在 handler（缺参给 code 1）。
// `.strict()` 拦截拼错的字段名，避免模型以为传了 ID 实际没传。
export const TaskStopInputSchema = z
  .object({
    task_id: z.string().optional().describe("The ID of the background task to stop"),
    shell_id: z
      .string()
      .optional()
      .describe("Deprecated: use task_id instead"),
  })
  .strict();

// handler 入参类型：两个字段都可能缺席，取用方负责兜底顺序。
export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

// provider 可见 schema，与运行时同形（无默认值，因此 required 计算正常）。
export const TaskStopInputJsonSchema = toToolJsonSchema(TaskStopInputSchema);

// 成功输出（`.strict()`）：`message` 是给模型的一行结果，`task_id` 用端口返回的真实 ID
// （可能与入参写法不同），`task_type` 在端口不给时由 handler 回落 "background_task"；
// `command` 只在 bash/进程类任务存在，用于展示停掉的具体命令。
export const TaskStopOutputSchema = z
  .object({
    message: z.string(),
    task_id: z.string(),
    task_type: z.string(),
    command: z.string().optional(),
  })
  .strict();

// handler 返回值类型；模型面文本是这份结果的紧凑 JSON。
export type TaskStopOutput = z.infer<typeof TaskStopOutputSchema>;

// executor/序列化边界上的结果校验，防止缺字段的成功结果进入会话历史。
export const TaskStopOutputJsonSchema = toToolJsonSchema(TaskStopOutputSchema);
