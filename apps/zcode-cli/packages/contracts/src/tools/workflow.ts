// ============================================================
// Workflow Tool - deterministic multi-agent workflow launcher
// ============================================================
// 生产者：core 的 handlers/workflow.ts 校验入参后交给 WorkflowPort.start；真正的脚本执行与
// 子会话派生在 bootstrap 的 script-workflow-tool-port.ts，消费者是模型面文本（formatModelContent）。
// 这里是 legacy `Workflow`，与动态工作流（CreateWorkflow/AmendWorkflow）是两套契约：runId 必须是
// `wf_` 前缀，后台任务 id 与 runId 同值，TaskOutput/TaskStop 用同一个 id 关联这个 run。
// 四个入口（scriptPath / script / name / resumeFromRunId）必须至少给一个，runId 的正则同时在入参与
// 输出两侧生效——写错前缀的 id 在 schema 层就被挡住，不会带着一个假 id 去查后台任务。
// 输出 schema 严格：`backgroundTaskId` 与 `runId` 都在场（同一字符串），模型据此才知道这个 run 是否
// 还能继续 observe；`status === "backgrounded"` 表示启动回执而非最终结果。

import { z } from "zod";
import type { TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// 内联脚本的长度上限（512 KiB，按字符计），只约束 `script` 字段，不约束磁盘上的 scriptPath。
// 超限由 zod 在入参校验阶段拒绝，避免整段脚本被写进 transcript 与日志。
export const WORKFLOW_SCRIPT_MAX_LENGTH = 524_288;
// run id 的唯一合法形态：`wf_` 前缀 + 至少 6 个 [a-z0-9-] 字符。
// 入参 `resumeFromRunId` 与输出 `runId` / `backgroundTaskId` 共用这一条正则，保证模型拿到的 id
// 一定来自本工具而不是别类后台任务（`exec_`、`dwfrun-` 等前缀会在 schema 层被拒）。
export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

// 工作流入参。字段口径：
// - `args` 原样作为脚本全局 `args`，必须传真实 JSON 值（字符串化的数组会让脚本里 filter/map 失效）；
// - `description` / `title` 被明确忽略，元信息只能写在脚本的 `meta` 块；
// - `name` 指向内置或 `.zcode/workflows/` 下的预定义工作流，解析为自包含脚本；
// - `resumeFromRunId` 只允许同会话内的旧 run，未改动的 agent() 调用直接复用缓存结果；
// - `script` 必须自带 `meta` 字面量，长度受 WORKFLOW_SCRIPT_MAX_LENGTH 限制；
// - `scriptPath` 优先于 `script` 与 `name`，用于"改文件 + 重调"的迭代姿势。
// 对象本身 strict，`superRefine` 负责"至少一个入口"这一条跨字段约束。
export const WorkflowInputSchema = z
  .object({
    args: z
      .unknown()
      .optional()
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "Ignored — set the workflow description in the script's `meta` block.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of a predefined workflow (built-in or from .zcode/workflows/). Resolves to a self-contained script.",
      ),
    resumeFromRunId: z
      .string()
      .regex(WORKFLOW_RUN_ID_PATTERN)
      .optional()
      .describe(
        "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.",
      ),
    script: z
      .string()
      .max(WORKFLOW_SCRIPT_MAX_LENGTH)
      .optional()
      .describe(
        "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
      ),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
      ),
    title: z
      .string()
      .optional()
      .describe("Ignored — set the workflow title in the script's `meta` block."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scriptPath || input.script || input.name || input.resumeFromRunId) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workflow requires scriptPath, script, name, or resumeFromRunId.",
    });
  });

// 入参的 TS 投影；与 schema 同源，handler 用 `as WorkflowInput` 后直接透传给 WorkflowPort。
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// 模型可见的入参 JSON schema（由 zod 转换，保留 describe 与 strict/additionalProperties 语义）；
// 它只描述形状，不承载"至少一个入口"的跨字段报错原文。
export const WorkflowInputJsonSchema = toToolJsonSchema(WorkflowInputSchema);

// 启动回执的三态：`backgrounded`（已启动并返回 runId）、`completed`（前台同步跑完）、
// `failed`（执行失败，但工具调用本身仍有配对结果）。没有 "cancelled"——取消体现为工具失败，
// 见 handler 的 cancellation.userVisibleMessage。
export const WorkflowOutputStatusSchema = z.enum(["backgrounded", "completed", "failed"]);
export type WorkflowOutputStatus = z.infer<typeof WorkflowOutputStatusSchema>;

// 启动回执。字段口径：
// - `backgroundTaskId` 与 `runId` 恒为同一个 `wf_` id，前者供 TaskOutput/TaskStop 的后台任务面使用；
// - `name` 是脚本 meta 的名字（可能缺席），`scriptPath` 是本次落盘的脚本路径（可能缺席）；
// - `response` 是端口给模型的人类可读文案，不是结构化状态；
// - `status` 三态见上，`traceId` 是本次工具调用的 trace，用于把回执与后续 run 日志对齐。
// `.strict()` 保证不把端口内部字段原样回给模型。
export const WorkflowOutputSchema = z
  .object({
    backgroundTaskId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    name: z.string().min(1).optional(),
    response: z.string(),
    runId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    scriptPath: z.string().min(1).optional(),
    status: WorkflowOutputStatusSchema,
    traceId: z.string().min(1),
  })
  .strict();

// 启动回执的 TS 投影；`backgroundTaskId` 与 `runId` 在类型上都是 string，但运行期必须同值。
export type WorkflowOutput = z.infer<typeof WorkflowOutputSchema>;

// 回执的模型面 JSON schema，供 tool 注册项的 outputSchema 与 executor 结构校验使用；
// 不参与模型可见文本渲染——后者由 handler 的 formatModelContent 单独生成。
export const WorkflowOutputJsonSchema = toToolJsonSchema(WorkflowOutputSchema);

// 工具结果的组合形状：`output` 是上面那份启动回执，`traceId` 是 TraceId 的强类型别名。
// 两者来自同一次调用，`traceId` 用于把结果行与 trace 记录对齐；它不是额外的持久化字段。
export interface WorkflowToolResult {
  output: WorkflowOutput;
  traceId: TraceId;
}
