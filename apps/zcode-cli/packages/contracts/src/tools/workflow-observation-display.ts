// ============================================================
// 观察类工作流工具的结果卡 display 载荷
// （GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet / ListSavedWorkflows /
//   ListModels / ResumeWorkflowRun）
// ============================================================
// 生产者：core 的 executor/workflow-observation-display.ts——按工具名分派、safeParse 工具
// 输出 schema、再逐字段限长；消费者：实时事件与 tool part 的 `metadata.display`（UI 渲染）。
// display 与模型可见结果（`formatModelContent` 产出的 text/XML 投影）是两条独立通道：
// 这里的内容永不进入模型上下文，因此字段集、枚举与限长都在本文件单独定义，只对齐 UI 镜像。
// 冻结契约：每个 payload 都 `.strict()`，packages/shared 另有逐帧镜像 schema；多一个键
// 不是"旧客户端少读一个字段"，而是整条工具结果卡校验失败、会话恢复 fail-closed。
// 界值在此声明、构造侧与 UI 共用同一把尺；超界由构造侧 slice/bound 并打 `truncated`。
// ============================================================

import { z } from "zod";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS,
  GetWorkflowRunActorSchema,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentLastToolSchema,
  GetWorkflowRunUsageSchema,
} from "./get-workflow-run.js";
import {
  ListWorkflowRunsRunSchema,
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

/**
 * 观察类工作流工具（GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
 * ListSavedWorkflows / ListModels）的结果卡 display 载荷。
 *
 * 限长常量与构造侧（core 的 workflow-observation-display.ts）一一对应：display 不经过
 * result budget，文本字段与数组长度必须在进入实时事件和持久化 metadata 前独立限长，
 * 超限由构造侧打 truncated 标记。
 */
// display 通道不过 resultBudget，所有界必须在这里独立给出，逐项口径：
// - LOG_ENTRIES 40：日志尾最多几行（构造侧取**尾巴**，最新进展优先）；
// - LOG_CHARS 1_024：单条日志/失败原因的字符上限；
// - ACTORS 32：花名册行数上限（取**头部**，没有"最新"概念）；
// - RESULT_CHARS 4_000：最终结果正文的字符上限（与模型通道的序列化上限互不替代）；
// - META_CHARS 2_048：providerLabel / description / whenToUse 等自由文本的上限；
// - RUNS 50：列表卡一次最多画多少行 run/工作流（与工具面 limit 封顶同值）；
// - ARGS 32：目录卡里一个工作流的参数**名字**数量上限（声明细节归确认窗）。
// 超界一律由构造侧裁剪并把一个 `truncated` 标记并进该卡，而不是让某个字段静默消失。
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES = 40;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS = 1_024;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS = 32;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS = 4_000;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS = 2_048;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS = 50;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS = 32;
/** 目录卡一次最多画几行模型（超出由构造侧 slice 并打 truncated）。 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS = 100;
/** 情势截面在卡上的界，与工具面同值（{@link GET_WORKFLOW_RUN_ROSTER_LIMITS}）。 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES = GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS =
  GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents;

/**
 * 卡上的一个子代理。刻意是**扁平行**而不是工具输出的嵌套形状：卡画的是一行，
 * `currentAsk` 里那几件事（派去干什么、第几轮、最后碰了哪个工具）就是这一行的后半截，
 * 多一层嵌套只会让渲染端先解构再拼回来。
 *
 * 枚举集与工具面**逐字相同且闭合**：消费 bundle 会拒收未知枚举值（曾因此让一整条
 * 订阅失效），所以这两处永远一起改。
 */
export const getWorkflowRunToolResultDisplaySubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    /** 当前 ask 的任务摘要与进度读数（缺席 = 不知道，绝不是 0）。 */
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
    /** 在等什么（原因文本不上卡：卡只需要「等槽位」还是「在退避」和还要等多久）。 */
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

export const getWorkflowRunToolResultDisplayLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS),
    // 事件落 journal 的时刻（epoch ms），与工具输出的 `logTail[].at` 同源；卡上的年龄对
    // `generatedAt` 算。可选：情势截面之前的载荷没有它，与 shared 侧同步为可选。
    at: z.number().optional(),
  })
  .strict();

/**
 * 工具卡上的结构化失败：**只有 code 与 message**，刻意不复用工具输出的
 * `GetWorkflowRunErrorSchema`。
 *
 * 两个通道的读者不同：输出是模型在读，它需要 `providerStop` 才知道该修什么；display 是
 * 渲染端在读，而渲染端用 packages/shared 的镜像 schema 严格校验每一帧。复用等于让
 * display 跟着输出长字段，镜像没跟上就是整条 row 被拒、会话恢复 fail-closed。
 * 这份定义是那份镜像的对侧，两边逐字段同步。
 */
export const getWorkflowRunToolResultDisplayErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

/**
 * GetWorkflowRun 的结果卡载荷。预算 / actor 直接复用工具输出 schema（纯小数值或已有界的
 * 小结构）；错误走上面那份 display 专用 schema；logTail 与 result 在 display 侧独立限长——
 * 输出侧的 2048 字符/条与 artifact 序列化上限属于模型通道，两道界互不替代。
 */
export const getWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    /** `status === "stopped"` 才在场。 */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    /**
     * 情势截面：那一句摘要、快照时刻、阶段表、花名册、健康。
     *
     * 五个字段**全部可选**，尽管构造侧每次都填。理由是**已经躺在库里的 transcript**：
     * 情势截面上线之前持久化的 `get_workflow_run` 载荷没有这些键，而 display schema 是
     * strict 的——把它们设成必填，等于让升级后打开的每一条历史会话的这张卡整块校验失败、
     * 退化成纯文本。文本兜底只针对**完全没有载荷**的老行，不针对有载荷的。
     *
     * `generatedAt` 是卡上所有「多久以前」的基准：必须对快照时刻算，而不是对渲染时的
     * `Date.now()`——一条三天前的 transcript 重新打开时，卡上的年龄仍是当时那个年龄。
     */
    summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS).optional(),
    generatedAt: z.number().optional(),
    usage: GetWorkflowRunUsageSchema,
    phases: z
      .array(GetWorkflowRunPhaseSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES)
      .optional(),
    subagents: z
      .array(getWorkflowRunToolResultDisplaySubagentSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS)
      .optional(),
    health: GetWorkflowRunHealthSchema.optional(),
    actors: z.array(GetWorkflowRunActorSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS),
    logTail: z
      .array(getWorkflowRunToolResultDisplayLogEntrySchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    result: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS).optional(),
    error: getWorkflowRunToolResultDisplayErrorSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/** ListWorkflowRuns 的结果卡载荷：run 行直接复用输出 schema（limit 已封顶 50）。 */
export const listWorkflowRunsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(ListWorkflowRunsRunSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * EvalWorkflowSnippet 的结果卡载荷。诊断复用 create_workflow 的 display 诊断 schema
 * （同一 TS 诊断形状，同一道限长）；logs 取尾巴、response 独立限长。
 */
export const evalWorkflowSnippetToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    logs: z
      .array(z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS))
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    response: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * ListSavedWorkflows 的结果卡载荷。根因：v4 wire 上 output.text 是 formatModelContent
 * 的 XML 风格投影，UI 侧 JSON 探针永不命中（掉进 raw JSON 兜底卡）——结构化列表必须走
 * 本 display 通道。description / whenToUse 独立限长；args 只保留名字（声明细节归确认窗）。
 */
export const savedWorkflowListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            whenToUse: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * ListModels 的结果卡载荷。根因与 saved_workflow_list 同一条：v4 wire 上 output.text 是
 * formatModelContent 的 `<models>` 投影，UI 侧 JSON 探针永不命中——结构化目录只能走本通道。
 *
 * 字段就是工具输出本身（读侧要画的三件事「有哪些、来自哪里、哪个是当前」全在里面），
 * 多一个 truncated。providerLabel / disabledReason 是注册表来的自由文本，display 不过 result
 * budget，必须在这里独立限长；其余是短 id 与小数值，原样透传。
 */
export const listModelsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_models"),
    /** 会话此刻的模型（规范形）；目录里一条都对不上时缺席。 */
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS),
    truncated: z.boolean().optional(),
  })
  .strict();

// GetWorkflowRun 卡的 TS 投影。`runId` 是这张卡与后台 run 的唯一关联键；`status` /
// `stopReason` 复用工具面的闭合枚举，这里不引入 display 私有取值（否则镜像 schema 失配）。
export type GetWorkflowRunToolResultDisplayPayload = z.infer<
  typeof getWorkflowRunToolResultDisplayPayloadSchema
>;
// ListWorkflowRuns 卡的 TS 投影。每行是一条 run 的摘要，`run` 行直接取工具输出 schema，
// 不在这里复制字段；`truncated` 表示 list 被裁过，而不是某一行内容被裁。
export type ListWorkflowRunsToolResultDisplayPayload = z.infer<
  typeof listWorkflowRunsToolResultDisplayPayloadSchema
>;
// EvalWorkflowSnippet 卡的 TS 投影。`ok` 为 false 时诊断必在场、`response` 仍可能有内容；
// logs 与 response 是两条独立限长的文本，不合并成一个字符串。
export type EvalWorkflowSnippetToolResultDisplayPayload = z.infer<
  typeof evalWorkflowSnippetToolResultDisplayPayloadSchema
>;
// ListSavedWorkflows 卡的 TS 投影。`workflows` 与 `invalid` 分开：前者能再次运行，
// 后者是解析失败的文件（带 path/reason），UI 不把它们画成同一类条目。
export type SavedWorkflowListToolResultDisplayPayload = z.infer<
  typeof savedWorkflowListToolResultDisplayPayloadSchema
>;
// ListModels 卡的 TS 投影。`current` 是会话此刻的规范形模型名，目录里一条都对不上时缺席；
// 目录行的 id 三元组（providerId/modelId/modelId）与注册表同源，不属于 display 自造字段。
export type ListModelsToolResultDisplayPayload = z.infer<
  typeof listModelsToolResultDisplayPayloadSchema
>;

/**
 * ResumeWorkflowRun 的结果卡载荷。
 *
 * 刻意最小 `{runId}`：恢复卡要传达的信息就是「哪个 run 在后台继续」——response 引导文案是
 * 模型通道的话术，UI 有自己的本地化词汇表，多带字段只增 wire 字节没有消费者。构造侧
 * safeParse 输出 schema 失败即回 undefined（走文本兜底），与上面四个构造函数同一骨架。
 */
export const resumeWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
// ResumeWorkflowRun 恢复卡的 TS 投影：只有 `kind` 与 `runId`，`runId` 是新后台 run 的关联键。
// 刻意不携带 response 文案——那是模型通道的话术，UI 有自己的本地化词汇表。
export type ResumeWorkflowRunToolResultDisplayPayload = z.infer<
  typeof resumeWorkflowRunToolResultDisplayPayloadSchema
>;
