// ============================================================
// GetWorkflowRun 的**情势截面** schema：阶段 / 子代理 / 健康
// ============================================================
// 从 get-workflow-run.ts 拆出，理由与端口侧 dynamic-workflow-run-roster.port.ts 同一条：
// 那份文件已接近 oxlint 的 max-lines 上限，而这三组 schema 自成一块。公开面不变——
// get-workflow-run.ts 原地再导出这里的每一个名字，`@zcode/contracts` 的导入路径逐字不动。
//
// 这里是端口类型（DynamicWorkflowRunPhaseView / …SubagentView / …Health）的**逐字段镜像**，
// 只多了 zod 的界。两侧必须同步：端口是读面的事实，这里是模型面的契约，缺一个字段就意味着
// 一件已经查出来的事实到不了模型。

import { z } from "zod";

/**
 * 情势截面的界。每一条都与已有的某条界同值，不另起一套：
 * 阶段数与阶段名随 reducer 的 `WORKFLOW_RUNS_LIMITS.maxPhases` / `maxPhaseNameLength`，
 * 指令头与工具名/目标随引擎侧的 `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`。
 *
 * 生产方是 contracts；消费方是 core 的 roster 投影（先按这里 slice）与同文件的 schema
 * （再按同值校验）。两侧同值才保证「截断」与「校验」不打架，改界必须同时改引擎与 display。
 */
export const GET_WORKFLOW_RUN_ROSTER_LIMITS = {
  /** 阶段表的行数上界（与 reducer 的 maxPhases 同值）。 */
  maxPhases: 32,
  maxPhaseNameLength: 128,
  /**
   * 花名册的行数上界。刻意高于阶段表：一次 50 路 fan-out 是平常事，而读者问的正是
   * 「谁在干什么」。超出这条界时整块被裁，并由 `subagentsTruncated` 说明裁过——
   * 一个静默少掉 18 行的花名册读起来像「只有 64 个子代理」。
   */
  maxSubagents: 64,
  maxActorNameLength: 128,
  /** 一次 ask 的任务摘要（`node-queued` 的 `instructionsHead`）。 */
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
  /** `node-waiting` 的自由文本原因（退避里的 provider 错误一句话）。 */
  maxWaitReasonLength: 240,
} as const;

/** 一个阶段在情势截面里的处境（端口 `DynamicWorkflowRunPhaseView` 的镜像）。 */
/**
 * 阶段行的模型面 schema。生产方是引擎 reducer 的阶段推进事实（进入/离开/轮次结算），
 * 消费方是 GetWorkflowRun handler 的投影与模型面的阶段表。
 *
 * `ahead` 是「声明了但控制流还没到」的唯一 `rounds: 0` 状态；`enteredAt` / `exitedAt` 缺席
 * 表示事件没有时间列，绝不补 0——0 会被读成 1970 年。strict 让端口多出的字段暴露为契约漂移。
 */
export const GetWorkflowRunPhaseSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength),
    /** `ahead` = 脚本声明了它但控制流还没到，也是唯一 `rounds: 0` 的状态。 */
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    /** 最近一次进入 / 离开的时刻（epoch ms）。事件无时间戳时缺席，绝不给 0。 */
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

/** 一次 ask 里最近被观察到的工具调用。`target` 是线索（路径 / 命令头），不是入参全文。 */
/**
 * 子代理当前 ask 里「最近一次工具调用」的摘要。`name` 截到 64、`target` 截到 120：
 * target 只是线索而不是入参全文，避免把子代理的内部输入整段带进模型面。
 *
 * 由引擎在 journal 记录，GetWorkflowRun handler 投影进 `currentAsk`；`at` 缺席即该事件
 * 没有时间列，读侧不得用读时时钟补。
 */
export const GetWorkflowRunSubagentLastToolSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolNameLength),
    target: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolTargetLength).optional(),
    at: z.number().optional(),
  })
  .strict();

/**
 * 子代理此刻正在跑的那一次 ask。`turn` / `toolCalls` **缺席读作「不知道」**，`0` 读作
 * 「一个工具都没调过」——老 journal 没有 `node-progress`，两者必须可分辨。
 *
 * `siteId` + `ordinal` 是这次 ask 在 run 内的稳定定位键（`actorSeq` 是同一 actor 的序号），
 * 由引擎写入、GetWorkflowRun handler 读出；三者的缺席/为 0 语义各不相同，不能默认填 0。
 */
export const GetWorkflowRunSubagentAskSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    actorSeq: z.number().int().nonnegative().optional(),
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
  })
  .strict();

/** 当前 ask 正在等什么。`slot` = 等进程级准入闸门；`backoff` = runner 在退避重试。 */
/**
 * 子代理等待原因 schema。`slot` 表示卡在进程级准入闸门（并发上限），`backoff` 表示 runner
 * 正在按 `retryAfterMs` 退避；两者是不同事实，不能把退避误读为并发受限。
 *
 * 由引擎 runner 写入 journal，GetWorkflowRun handler 投影进花名册的 `wait`；`since` 缺席即
 * 「不知道从何时开始等」，读侧不得自行补时钟。
 */
export const GetWorkflowRunSubagentWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    since: z.number().optional(),
  })
  .strict();

/**
 * 花名册里的一个子代理（端口 `DynamicWorkflowRunSubagentView` 的镜像）。
 *
 * `state` 的七个词是闭集，且读的顺序就是写的顺序（端口注释有完整判定链）：run 活着时
 * `parked` → `waiting` → `executing` → `failed` → `idle`，run 终态时只剩
 * `unfinished` → `failed` → `done`。
 */
export const GetWorkflowRunSubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    currentAsk: GetWorkflowRunSubagentAskSchema.optional(),
    wait: GetWorkflowRunSubagentWaitSchema.optional(),
    /** 它停在哪个问题上；`health.pendingQuestionsKnown` 为假的那次读永不在场。 */
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

/**
 * run 级并发现状。**整个对象只在被压到自己那条界以下时在场**：跑满自己那条界的 run 没有
 * 可说的，而它在场就等于「正被限着」。
 *
 * `effective` 是此刻实际在飞的子代理数，`cap` 是当前天花板；`since` 缺席表示不知道从何时
 * 开始受限。由引擎的准入闸门写入、GetWorkflowRun handler 投影，模型不应据此自行推算新上限。
 */
export const GetWorkflowRunConcurrencyHealthSchema = z
  .object({
    effective: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    since: z.number().optional(),
  })
  .strict();

/** run 整体还在不在动（端口 `DynamicWorkflowRunHealth` 的镜像）。 */
/**
 * run 级健康快照 schema。生产方是引擎从 journal 推导的最后进展/停滞/连续失败/缓存步数，
 * 消费方是 GetWorkflowRun 输出与确定性 summary；恒随输出返回，是「还在不在动」的唯一依据。
 *
 * `pendingQuestionsKnown === false` 表示这次读无法回答「有没有问题在等」：此时
 * `pendingQuestions` 整字段缺席、也没有子代理被报成 `parked`——「不知道」不能被渲染成「没有」。
 * `leftoverRunning` 只对终态 run 有意义，为 0 时缺席，不能用它推断仍在运行。
 */
export const GetWorkflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: GetWorkflowRunConcurrencyHealthSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    /** 仅终态 run：还标着 `running` 的节点行数（进程死在它们下面）。为 0 时缺席。 */
    leftoverRunning: z.number().int().positive().optional(),
    /**
     * 这次读能不能回答「有没有问题在等答案」。为假时 `pendingQuestions` 整字段缺席，
     * 且没有任何子代理会被报成 `parked`——「没有人在等」与「不知道」是两个不同的事实。
     */
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

/**
 * 阶段行的模型面类型，仅由 schema 推导，不另立字段。
 * 与端口 `DynamicWorkflowRunPhaseView` 保持逐字段同形，供 handler 以 satisfies 构造输出。
 */
export type GetWorkflowRunPhase = z.infer<typeof GetWorkflowRunPhaseSchema>;
/**
 * 花名册行的模型面类型；字段全部来自 GetWorkflowRunSubagentSchema。
 * handler 逐字段搬运端口快照，模型据此判断「谁在跑、停在哪个问题或闸门上」。
 */
export type GetWorkflowRunSubagent = z.infer<typeof GetWorkflowRunSubagentSchema>;
/**
 * 当前 ask 的模型面类型。只有 siteId/ordinal 等定位键必填，进度计数保持可选，
 * 以便区分「老 journal 没有 node-progress」（缺席）与「确实一个工具都没调」（0）。
 */
export type GetWorkflowRunSubagentAsk = z.infer<typeof GetWorkflowRunSubagentAskSchema>;
/**
 * run 健康快照的模型面类型。恒随输出返回，是模型判断 run 是否停滞、
 * 是否还有问题待答、是否被并发闸门限住的唯一结构化依据。
 */
export type GetWorkflowRunHealth = z.infer<typeof GetWorkflowRunHealthSchema>;
