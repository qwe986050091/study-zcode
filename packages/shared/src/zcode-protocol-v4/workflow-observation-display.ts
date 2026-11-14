// INV-01 两侧同步：守住位置 各 display schema；改错故障：与 contracts 侧成员不一致，整行校验失败。
// INV-02 全 strict：守住位置 每个对象；改错故障：多余字段被静默接受，前端读到未声明键。
// INV-03 新增即可选：守住位置 情势截面五件；改错故障：升级后历史会话的卡整块被剥。
// INV-04 限长对齐：守住位置 各 max 常量；改错故障：构造侧可写出校验侧拒收的载荷。
// INV-05 枚举闭合：守住位置 状态与原因枚举；改错故障：新状态让整卡退化成纯文本。
// INV-06 非负计数：守住位置 计数字段；改错故障：前端进度出现负值。
// INV-07 最小必填：守住位置 用量五项；改错故障：缺项被当成零，误导预算判断。
// INV-08 类型字面量：守住位置 kind；改错故障：不同卡片渲染器互相抢渲染。
// INV-09 诊断可空：守住位置 诊断数组；改错故障：无诊断的成功结果被拒。
// INV-10 日志有界：守住位置 日志条数与单条长度；改错故障：长日志撑爆卡面。
// INV-11 结果与错误互斥可选：守住位置 两字段；改错故障：失败卡仍显示旧结果。
// INV-12 截断标记：守住位置 truncated；改错故障：被截断的结果看起来完整。
// INV-13 标签来源：守住位置 labelSource；改错故障：脚本名与用户命名无法区分样式。
// INV-14 归属标记：守住位置 ownedByThisSession；改错故障：他会话的运行被当成当前会话的。
// INV-15 可能中断：守住位置 possiblyInterrupted；改错故障：异常退出被显示成正常停止。
// INV-16 时间戳可选：守住位置 进入退出时刻；改错故障：旧载荷缺少时间时整卡失败。
// INV-17 并发可选：守住位置 并发块；改错故障：未采集并发时健康块整体拒绝。
// INV-18 类型导出：守住位置 每个 schema 的 infer 类型；改错故障：UI 与构造侧各写一份接口。
//
// 模块职责：工作流观察类工具卡的 display 载荷 schema。
// 状态所有权：无状态；只做结构校验与类型推导，不持有数据。
// 阅读顺序：枚举 → 公共子 schema → 运行详情 → 列表卡 → 其余工具卡。
// ============================================================
// 观察类工作流工具（GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
// ListSavedWorkflows / ListModels）的工具卡 display 载荷
// ============================================================
// 照 create-workflow-display.ts 的先例单独成模块（特性级 schema 不堆进 toolDisplay.ts）。
//
// ⚠ 与 apps/zcode-cli/packages/contracts/src/tools/workflow-observation-display.ts 的
// toolResultDisplayPayloadSchema 成员必须同步——两侧都是 strict，少一侧整条 row/display
// 校验失败、工具卡退化成文本（create_workflow display 注释记录过同款坑）。
// 限长常量与 CLI 构造侧一一对应；display 不经过 result budget。

import { z } from "zod";

/** `stopped` 的原因。 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

export const WORKFLOW_RUN_OBSERVATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
] as const;

// usageSchema 用量五项全部必填，缺项视为旧载荷不兼容。
// strict 保证多余字段被拒，避免两侧静默漂移。
//
const usageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

// 演员只标识站点与序号，名字可选。
// 序号在同一运行内唯一，用于稳定排序。
//
const actorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

// 情势截面（阶段 / 子代理 / 健康）的卡面载荷。与 CLI 侧
// getWorkflowRunToolResultDisplayPayloadSchema 的对应成员**逐字段同步**，枚举集闭合且同词表——
// 两侧都是 strict，少一个字段或多一个枚举值，整条 row/display 校验失败、工具卡退化成文本。
// 数字界与 CLI 侧常量一一对应（32 阶段 / 64 子代理 / 240 指令头 / 400 摘要）。
// phase.state 是闭合四值，与前端步骤态一一对应。
// enteredAt 与 exitedAt 时刻可选，旧载荷没有时间线。
// 计数用 z.number().int().nonnegative()，避免前端出现负进度。
//
const workflowRunPhaseViewSchema = z
  .object({
    name: z.string().min(1).max(128),
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

const workflowRunLastToolSchema = z
  .object({
    name: z.string().min(1).max(64),
    target: z.string().max(120).optional(),
    at: z.number().optional(),
  })
  .strict();

// 子代理状态七值闭合，覆盖空闲到未完成。
// 指令头限长与 CLI 侧常量一致。
// waitCause 只允许 slot 与 backoff 两种。
//
const workflowRunSubagentViewSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(128).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(128).optional(),
    instructionsHead: z.string().max(240).optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: workflowRunLastToolSchema.optional(),
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

// workflowRunHealthSchema 健康块整体可选，旧载荷没有情势截面。
// concurrency 并发信息嵌套可选，缺省表示未采集。
// leftoverRunning 剩余运行数为正数才有意义，故用 positive 可选值。
//
const workflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: z
      .object({
        effective: z.number().int().nonnegative(),
        cap: z.number().int().positive(),
        reason: z.string().max(240).optional(),
        since: z.number().optional(),
      })
      .strict()
      .optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    leftoverRunning: z.number().int().positive().optional(),
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

const diagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(2_048),
  })
  .strict();

// 列表行只带展示必需字段，不带完整运行详情。
// 标签来源区分名字与脚本，供前端选择样式。
//
const workflowRunSummaryRowSchema = z
  .object({
    runId: z.string().min(1),
    label: z.string(),
    labelSource: z.enum(["name", "script"]),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    ownedByThisSession: z.boolean(),
    possiblyInterrupted: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
  })
  .strict();

// 情势截面五件全部可选，升级后旧会话仍可打开。
// 设为必填会让历史卡片整块被剥、退化成纯文本。
//
export const toolCallGetWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    // 情势截面五件全部可选：情势上线前持久化的 transcript 载荷没有这些键，而本 schema 是
    // strict 的——设成必填会让升级后打开的每一条历史会话里这张卡整块被剥、退化成纯文本。
    // 构造侧每次仍然全填（CLI 侧同款注释）。
    summary: z.string().max(400).optional(),
    generatedAt: z.number().optional(),
    usage: usageSchema,
    phases: z.array(workflowRunPhaseViewSchema).max(32).optional(),
    subagents: z.array(workflowRunSubagentViewSchema).max(64).optional(),
    health: workflowRunHealthSchema.optional(),
    actors: z.array(actorSchema).max(32),
    logTail: z
      .array(
        z
          .object({
            sequence: z.number(),
            message: z.string().max(1_024),
            // 事件落 journal 的时刻（epoch ms）；卡上的「多久以前」对 generatedAt 算。
            // 可选：这一列在情势截面之前的载荷上不存在，读旧行时缺席而不是拒收。
            at: z.number().optional(),
          })
          .strict(),
      )
      .max(40),
    result: z.string().max(4_000).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallGetWorkflowRunDisplay = z.infer<typeof toolCallGetWorkflowRunDisplaySchema>;

// 运行数量上限与 CLI 构造侧一致。
// 截断标记可选，缺失即视为未截断。
//
export const toolCallListWorkflowRunsDisplaySchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(workflowRunSummaryRowSchema).max(50),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListWorkflowRunsDisplay = z.infer<typeof toolCallListWorkflowRunsDisplaySchema>;

export const toolCallEvalWorkflowSnippetDisplaySchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(100),
    logs: z.array(z.string().max(1_024)).max(40),
    response: z.string().max(4_000),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallEvalWorkflowSnippetDisplay = z.infer<
  typeof toolCallEvalWorkflowSnippetDisplaySchema
>;

export const toolCallSavedWorkflowListDisplaySchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(2_048).optional(),
            whenToUse: z.string().max(2_048).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(32),
          })
          .strict(),
      )
      .max(50),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(1_024).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallSavedWorkflowListDisplay = z.infer<
  typeof toolCallSavedWorkflowListDisplaySchema
>;

// ListModels 的目录卡载荷。与
// contracts 侧 listModelsToolResultDisplayPayloadSchema 成员同步——两侧都 strict，缺成员整块
// 被剥、工具卡退化成 `<models>` 文本。限长数字与 CLI 侧常量一一对应（100 行 / 2048 字符）。
export const toolCallListModelsDisplaySchema = z
  .object({
    kind: z.literal("list_models"),
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(2_048).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(2_048).optional(),
          })
          .strict(),
      )
      .max(100),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListModelsDisplay = z.infer<typeof toolCallListModelsDisplaySchema>;

// ResumeWorkflowRun 的结果卡载荷。与 contracts 侧
// resumeWorkflowRunToolResultDisplayPayloadSchema 成员同步——两侧都 strict，缺成员整块被剥、
// 工具卡退化成文本。载荷刻意最小 {runId}（理由见 contracts 侧注释）。
export const toolCallResumeWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ToolCallResumeWorkflowRunDisplay = z.infer<
  typeof toolCallResumeWorkflowRunDisplaySchema
>;
