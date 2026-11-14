// ============================================================
// TaskOutput Tool 契约 - 后台任务输出的读取口
// ============================================================
// 生产者：core 的 handlers/task-output.ts 从 runtime 任务注册表取快照并投影；消费者：模型读
// `<retrieval_status>` 与投影后的任务字段，UI 从 display 通道单独取有界预览。
// 跨边界不变量：`task_id` 是注册表键（bash/agent/workflow 共用同一命名空间），不在这里解析
// 前缀；`retrieval_status` 恒有值，模型靠它决定继续等待还是读取结果，不能用"有没有 task"代替。
// 已弃用提示是契约的一部分：local_agent 的 outputFile 是完整会话 transcript 的符号链接，
// 模型若照 bash 的方式 Read 会撑爆上下文，因此 description 必须保留这条禁令。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 注册表、权限规则与遥测共用的工具名；改名会让历史 task 输出记录与 UI 关联失效。
export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
// 历史工具名的别名集合：旧模型/旧客户端仍用 AgentOutputTool、BashOutputTool 等名字命中同一实现。
// 只做名字兼容，不改变入参与输出语义；别名不进入延迟工具发现目录。
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

// provider 可见描述（整段进入模型上下文）。三段按任务类型分别给出读取路径，其中 local_agent
// 明确禁止 Read `.output`——那是完整会话 transcript 的符号链接。后半段是与历史文档保持一致的
// 参数说明：task_id、block（等待）、timeout、/tasks 查 ID、支持全部任务类型。
export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`;

// 运行时入参：task_id（注册表键）、block（是否等待终态，schema 默认 true）、timeout（毫秒，
// 0~600000，默认 30000）。`block` 经 semanticBoolean 兼容字符串 "true"/"false"——部分
// provider 会把布尔序列化成字符串，直接拒绝会让调用无故失败。
export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600_000).default(30_000).describe("Max wait time in ms"),
  })
  .strict();

// handler 入参类型；默认值已由 schema 补齐，因此这里三个字段都是必填（非 optional）。
export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

// provider 可见 schema 覆盖 required：转换器会把带默认值的字段标成可选，但模型侧要求显式
// 传入 task_id/block/timeout（执行侧仍会补默认值，两处口径不同是刻意的）。
export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

// 单个任务的投影（`.strict()`）。字段口径：`task_id`/`task_type`/`status`/`description`/
// `output` 恒有；`exitCode` 可为 null（非进程类任务没有退出码，0 是有效值不能用 falsy 判断）；
// `error` 只在失败时出现；`prompt` 是 agent 任务的原始派发文本；`result` 是 agent 的最终答复；
// `outputFile` 是完整输出的可回读路径（local_agent 时是 transcript 符号链接，不应直接 Read）。
export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
  })
  .strict();

// handler 投影结果的 TS 类型，UI display 与模型面文本共用同一字段口径。
export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

// 结果外壳：`retrieval_status` 三值——success（拿到终态）、not_ready（任务仍活跃，附带当前
// 快照）、timeout（等到期仍未终态）。`task` 可为 null：等待期间任务从注册表消失时没有快照，
// 这种"消失"仍要作为 timeout 回报，不能伪造成失败或成功。
export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

// handler 返回值类型；模型面渲染只读 `retrieval_status` 与 task 的字段存在性。
export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

// executor/序列化边界上的结果校验；`task:null` 合法，不能被当成缺失字段。
export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

// 布尔语义兼容层：把字符串 "true"/"false" 预处理成布尔，其余原样交给内层 schema（含默认值）。
// 只认这两条字面量，不做 "1"/"yes" 等宽松解析——避免把含糊输入当成明确意图；
// 它不是 strict 校验，内层 `.default(true)` 仍在缺失时生效。
function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}
