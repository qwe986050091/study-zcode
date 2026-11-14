// ============================================================
// ListWorkflowRuns Tool - 按项目（cwd）枚举 workflow run，含跨会话历史
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具注册名，同时是权限规则、事件与 UI 投影的判别键；必须与 core handler 注册项的
// metadata.name 一致。
export const LIST_WORKFLOW_RUNS_TOOL_NAME = "ListWorkflowRuns";

/**
 * run 的生命周期词汇表。字面与 `DynamicWorkflowRunLifecycleStatus`（端口侧）同集，但在这里
 * 重新声明成 zod 枚举：schema 是**运行时**校验面，type-only 的联合类型在这里派不上用场。
 * 两处一旦分叉，症状是模型传下来的合法状态被工具拒掉——所以端口那一侧的注释也指回这里。
 */
export const WORKFLOW_RUN_LIFECYCLE_STATUSES = [
  "completed",
  "errored",
  "pending",
  "running",
  "stopped",
] as const;

/** `stopped` 的原因（端口 `DynamicWorkflowRunStopReason` 的 zod 面）。 */
// stop reason 的 zod 取值面：只有 status === "stopped" 时才可能在场，其余状态带它属于
// 非法数据。`superseded` 表示被 AmendWorkflow 替换，此时 supersededBy 指向新的活 run。
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

/** limit 的界与默认值。50 是「run 是低基数实体」下不需要游标分页的那个上限。 */
// limit 的三个常量必须一起读：MIN/MAX 既写进 schema 的区间，也被 preprocess 钳制使用；
// DEFAULT 20 是模型省略 limit 时的取值。50 的上限来自"run 是低基数实体"的判断——超过
// 这个规模就该用状态过滤，而不是给列表加游标分页。
export const LIST_WORKFLOW_RUNS_MIN_LIMIT = 1;
export const LIST_WORKFLOW_RUNS_MAX_LIMIT = 50;
export const LIST_WORKFLOW_RUNS_DEFAULT_LIMIT = 20;

// 运行时输入 schema：limit 经 clampedLimit 钳制（默认 20，界 [1,50]），statuses 可选过滤。
// 刻意没有 cwd——工具恒查当前会话工作目录。strict 让"多传 cwd"成为可见的校验错误，
// 而不是被静默忽略。schema 的 JSON 投影仍带 minimum/maximum/default，模型看得到边界。
export const ListWorkflowRunsInputSchema = z
  .object({
    limit: clampedLimit().describe(
      `Maximum number of runs to return (${LIST_WORKFLOW_RUNS_MIN_LIMIT}-${LIST_WORKFLOW_RUNS_MAX_LIMIT}, default ${LIST_WORKFLOW_RUNS_DEFAULT_LIMIT}). Most recently updated runs come first.`,
    ),
    statuses: z
      .array(z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES))
      .optional()
      .describe(
        "Optional status filter. Omit to see every run in this project. Pass [\"running\", \"pending\"] to see only what is still in flight.",
      ),
  })
  // 刻意没有 cwd 输入：工具恒查当前会话的工作目录（模型无权跨项目扫库，这同时是
  // `sideEffectScope: "none"` 成立的前提）。.strict() 让"多传一个 cwd"成为可见错误。
  .strict();

// 运行时推导的输入类型；limit 已在 preprocess 阶段变成界内整数，handler 可直接用。
export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInputSchema>;

// provider 可见的输入 schema，由运行时 schema 投影；钳制逻辑不会被投影，因此模型看到的
// 是"越界会被拒绝"的区间，而运行时实际是"越界被折进界内"——这是刻意的不对称（只读枚举
// 不该因一个数字变成模型要恢复的错误）。
export const ListWorkflowRunsInputJsonSchema = toToolJsonSchema(ListWorkflowRunsInputSchema);

/**
 * 列表与详情**共同的截面**（端口侧 `DynamicWorkflowRunSummary` 的 schema 面）。
 *
 * 之所以是一个共享的字段袋而不是两份各自演化的字段表：同一个 run 在列表里和详情里显示不同的
 * 名字或归属，是最难被测试抓住、又最直接损害信任的那类不一致。字段袋放在**列表**这一侧，
 * 因为列表就是这个截面最浅的投影；详情按它 extend。
 */
export const WorkflowRunSummarySchema = z.object({
  // 全局唯一且稳定的 run 标识（`dwf-...`），是 GetWorkflowRun/ResumeWorkflowRun/
  // AmendWorkflow/TaskOutput 共用的关联键；列表与详情必须原样透传，不能重新格式化。
  runId: z.string().min(1),
  /** 已烹熟的展示标签（name → 脚本首行 → runId 由服务侧派生）。 */
  label: z.string(),
  /** `"name"` = 用户起的名字；`"script"` = 读时从脚本派生（含 runId 兜底）。 */
  labelSource: z.enum(["name", "script"]),
  status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
  /** `status === "stopped"` 才在场。 */
  stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
  /** 本 run 修订自哪个 run（`dwf_run.resumed_from`）；不是修订则缺席。 */
  resumedFrom: z.string().min(1).optional(),
  /** 本 run 被哪次修订停下并替代（`stopped(superseded)` 的结算袋）；未被替代则缺席。 */
  supersededBy: z.string().min(1).optional(),
  ownedByThisSession: z.boolean(),
  /** 「本会话无法证实它还活着」的标注，为真时才在场。绝不是状态改写。 */
  possiblyInterrupted: z.boolean().optional(),
  /** epoch ms（journal 的 time_created / time_updated）。 */
  createdAt: z.number(),
  updatedAt: z.number(),
});

// 列表行的完整形状：共享摘要截面 + 本 run 的 token 花费。strict 保证列表不会悄悄带上
// 详情专属字段（日志尾、最终结果），否则模型会把"列表能拿到全部"当成事实。
export const ListWorkflowRunsRunSchema = WorkflowRunSummarySchema.extend({
  // 本 run 累计消耗的 token 数；由 run service 从 journal 聚合，是精确值而非估算。
  spentTokens: z.number(),
}).strict();

// 列表行的内部类型，供 handler 以 satisfies 构造输出。
export type ListWorkflowRunsRun = z.infer<typeof ListWorkflowRunsRunSchema>;

// 输出快照：runs 按 updatedAt 从新到旧，truncated 只在真被 limit+1 探到更多时在场。
// 它没有 cursor——分页靠模型调大 limit 或按 statuses 缩小集合，而不是翻页令牌。
export const ListWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(ListWorkflowRunsRunSchema),
    /** 还有更多 run 没进这一页（按 limit+1 探到）。为真时才在场。 */
    truncated: z.boolean().optional(),
  })
  .strict();

// 输出快照的内部类型；handler 用 satisfies 构造，truncated 为假时省略该键。
export type ListWorkflowRunsOutput = z.infer<typeof ListWorkflowRunsOutputSchema>;

// provider 可见的输出 schema，供工具结果回放校验与模型投影；字段演进必须与运行时 schema
// 同步，否则旧 run 数据会在列表渲染时被判无效。
export const ListWorkflowRunsOutputJsonSchema = toToolJsonSchema(ListWorkflowRunsOutputSchema);

/**
 * limit 是**钳制**而不是拒绝：一次只读枚举没有理由因为一个越界数字变成模型要从中恢复的工具
 * 错误；`limit` 默认 20，并钳到 [1, 50]。
 *
 * 钳制放在 preprocess 里而不是 handler 里，图的是两件事同时成立：JSON schema 仍然按内层
 * schema 投影（`type: integer` + minimum/maximum/default，模型看得到界），而运行时的越界值被
 * 折进界内。写在 handler 里的 `Math.min/max` 会被本 schema 的 min/max 抢先拒掉，是永不执行的
 * 死代码。语义强制转换走 preprocess 是既有惯例（task-output 的 semanticBoolean、bash 的
 * timeout）。
 */
function clampedLimit(): z.ZodEffects<z.ZodDefault<z.ZodNumber>, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      LIST_WORKFLOW_RUNS_MAX_LIMIT,
      Math.max(LIST_WORKFLOW_RUNS_MIN_LIMIT, Math.trunc(value)),
    );
  }, z.number().int().min(LIST_WORKFLOW_RUNS_MIN_LIMIT).max(LIST_WORKFLOW_RUNS_MAX_LIMIT).default(LIST_WORKFLOW_RUNS_DEFAULT_LIMIT));
}
