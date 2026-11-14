// ============================================================
// Cron automation tools - session-level scheduled task management
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);
// contracts 仍使用 Zod 3，而 shared protocol 使用 Zod 4；跨版本 schema 实例不可组合。
// 字段契约与 shared ModelSelection 保持逐叶一致，后续统一 Zod 版本后删除本地声明。
const cronModelSelectionSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
    options: z
      .object({
        reasoningLevel: nonEmptyString.optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 相对任务判定的唯一口径：只有显式的正整数才是相对延迟。
 * delayMinutes 曾是必填 nullable，普通 cron 创建被迫显式传 null——
 * 省略字段的旧调用方/不稳定保留 null 的 provider 会直接 parse 失败，或在
 * `!== null` 判定下把 undefined 误走相对分支、把 recurring 任务错建成一次性。
 * undefined 与 null 都表示“非相对”，向后兼容既有 { cron, prompt, title } 协议。 */
export function hasRelativeDelayMinutes(input: { delayMinutes?: number | null }): boolean {
  return typeof input.delayMinutes === "number";
}

/**
 * CronCreate 入参：调度来源二选一——`cron`（本地时区的 5 段表达式，绝对/周期）
 * 或 `delayMinutes`（相对延迟，正整数分钟，上限 525600）。两者互斥且必居其一，
 * 相对延迟只能建一次性任务（不得 recurring=true / maxRuns）。
 * 自定义周期走 intervalUnit+interval（1-200）carrier，真实间隔由 host 的 scheduleRule
 * 承载，cron 只是兼容展示；carrier 与 delayMinutes 互斥，且要求 recurring=true。
 * 所有组合不变量在 schema 的 refine 层拒绝，service 层另有领域防御。
 */
export const CronCreateInputSchema = z
  .object({
    cron: nonEmptyString
      .optional()
      .describe(
        "Standard 5-field cron expression in the user's local timezone: minute hour day-of-month month day-of-week. Use it only for an absolute named date/time or a recurring schedule; required unless delayMinutes is set. For any relative delay such as 'in 8 minutes'/'8分钟后' or 'in 2 hours'/'2小时后', omit cron and use delayMinutes instead — never convert a relative phrase into a fixed clock time or calendar date, because a just-passed one-shot time silently rolls a full year forward. Examples: '*/20 * * * *' means every 20 minutes, '0 * * * *' means hourly, and '0 9 * * 1-5' means weekdays at 09:00. Do not convert to UTC.",
      ),
    delayMinutes: z
      .number()
      .int()
      .positive()
      .max(525_600)
      .nullable()
      .optional()
      .describe(
        "For any relative delay from now — 'in 3 minutes' (3), '8分钟后' (8), 'in 2 hours' (120), 'later'/'稍后' — set the exact positive delay in whole minutes and omit cron. The host calculates the future local schedule from its real current clock, so never compute an absolute time or cron yourself. For an absolute named date/time or a recurring schedule, omit it (or set null) and provide cron.",
      ),
    prompt: nonEmptyString.describe(
      "Complete prompt to send at every scheduled fire. Include all instructions needed when the automation runs. Describe the final work directly; do not ask it to create or schedule another automation or call CronCreate.",
    ),
    title: nonEmptyString.describe(
      "Concise automation title that preserves the user's natural-language schedule phrase verbatim. For example, for '每20分钟提醒我喝水', use '每20分钟喝水提醒', not '喝水提醒'.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "true (default) repeats until paused or deleted. false creates a finite automation; without maxRuns it runs once.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum successful scheduled dispatch count. Use only with recurring=false; omit for a one-shot automation (defaults to 1).",
      ),
    // 会话侧「自定义重复」carrier。每 N 分钟/小时/天/周/月/年与 UI 一样由
    // intervalUnit + interval 表示，真实间隔由 host scheduleRule 承载；cron 仅是合法兼容展示。
    // 不能让 cron 字段步长上限（minute 59、hour 24、day-of-month 31、month 12）篡改真实频率。
    // carrier 与 delayMinutes（一次性）互斥。
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Custom recurring interval unit for every N minutes/hours/days/weeks/months/years. Pair with interval (1-200) for every N-unit request, even if cron can express N; submit a legal compatible cron whose time/day slots are used by the scheduleRule. Omit both for ordinary calendar cron schedules.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Integer interval from 1 to 200 paired with intervalUnit. The host carries the real interval via scheduleRule; the compatible cron is only a legal display expression. Must be set together with intervalUnit.",
      ),
  })
  .strict()
  .refine((input) => hasRelativeDelayMinutes(input) || input.cron !== undefined, {
    message: "cron is required when delayMinutes is not set",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.cron === undefined, {
    message: "a relative delay must omit cron; the host computes the schedule from its real clock",
    path: ["cron"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.recurring !== true, {
    message: "a relative delay creates a one-shot automation and cannot use recurring=true",
    path: ["recurring"],
  })
  .refine((input) => !hasRelativeDelayMinutes(input) || input.maxRuns === undefined, {
    message: "a relative delay runs once and cannot use maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit+interval 是周期 carrier，与一次性相对延迟 delayMinutes 在语义上冲突
  // （周期 vs 一次性）；同传会形成矛盾状态，必须在 contract 层拒绝（service 层另有领域防御）。
  .refine((input) => input.intervalUnit === undefined || !hasRelativeDelayMinutes(input), {
    message: "intervalUnit is a recurring carrier and cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  // intervalUnit 与 interval 必须配对：只传其一无法确定真实间隔，拒绝。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // carrier 的定义就是长周期无限循环；一次性 / 有限次数与其调度语义冲突。
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and requires recurring=true",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
/** 归一化后的创建入参；`recurring` 缺席按 true 处理，`maxRuns` 只与一次性语义配合。 */
export type CronCreateInput = z.infer<typeof CronCreateInputSchema>;
/** 面对模型的 JSON schema；组合约束以 description 提示，运行时仍由 refine 强制。 */
export const CronCreateInputJsonSchema = toToolJsonSchema(CronCreateInputSchema);

const CronUpdateInputObjectSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
    cron: nonEmptyString
      .optional()
      .describe(
        "Replacement standard 5-field cron expression in the user's local timezone. Omit to preserve the existing schedule. Do not convert to UTC.",
      ),
    prompt: nonEmptyString
      .optional()
      .describe(
        "Replacement prompt for future scheduled fires. Omit to preserve the existing prompt.",
      ),
    // title 可选时，模型只改 cron/prompt 会把旧时间或旧任务语义留在标题中。
    // 会话更新必须显式提交最终标题，让同一次原地更新同步持久化并回显一致结果。
    title: nonEmptyString.describe(
      "Required synchronized automation title describing the task after this update. Keep the user's natural-language schedule phrase consistent with cron (for example, changing every 5 minutes to every 6 minutes must also change the title), and update the title when the prompt meaning changes.",
    ),
    recurring: z
      .boolean()
      .optional()
      .describe(
        "Replacement recurrence mode. true repeats indefinitely and clears any old finite maxRuns limit; false is finite. Do not combine true with a numeric maxRuns.",
      ),
    maxRuns: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "Replacement maximum successful scheduled dispatch count for recurring=false. null clears the existing limit and is valid only when recurring=true is included in the same update; when recurring=true is supplied without maxRuns, the service clears the old limit automatically.",
      ),
    // 自定义重复 carrier，语义同 create 侧 intervalUnit+interval（每 N 单位统一经 scheduleRule 执行）。
    intervalUnit: z
      .enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe(
        "Switch this automation to a long recurring interval whose step exceeds a cron field ceiling (hourly N>24, daily N>31, etc.). Pair with interval and submit a legal compatible cron (omit cron to keep the existing schedule's minute).",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Positive integer interval paired with intervalUnit. Must be set together with intervalUnit.",
      ),
  })
  .strict();

const CRON_UPDATE_FIELDS = [
  "cron",
  "prompt",
  "title",
  "recurring",
  "maxRuns",
  "intervalUnit",
  "interval",
] as const;
/**
 * CronUpdate 入参：所有字段可选，但至少给一个；`title` 必填是刻意的——只改 cron/prompt
 * 会把旧时间或旧语义留在标题里，要求同一次原地更新把标题同步成最终事实。
 * `maxRuns: null` 只能在同次 recurring=true 时出现（清空上限）；recurring=true 不得
 * 与数值 maxRuns 同传；intervalUnit+interval 仍必须配对，且不得与 recurring=false 组合。
 */
export const CronUpdateInputSchema = CronUpdateInputObjectSchema.refine(
  (input) => CRON_UPDATE_FIELDS.some((field) => input[field] !== undefined),
  { message: "CronUpdate requires at least one field to update" },
)
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "Clearing maxRuns requires recurring=true in the same update",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit 与 interval 必须配对（同 create 侧语义）。
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // carrier 会将历史一次性任务切换为无限循环，调用方不能同传矛盾的有限次数语义。
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
/** 归一化后的更新入参；null 与 undefined 语义不同，handler 据此区分“清空”与“沿用”。 */
export type CronUpdateInput = z.infer<typeof CronUpdateInputSchema>;
// provider-visible schema 曾用顶层 anyOf 表达 recurring/maxRuns 组合约束，
// 与 core 的跨 provider 守卫（禁止 $ref/$defs/anyOf 等 provider-internal key）直接冲突；
// anyOf 还引出“部分 provider 只读分支 required、漏掉顶层 id/title”的连带问题。
// provider 只投影干净的 object schema（顶层 required 自然生效），组合不变量由
// runtime CronUpdateInputSchema 的 refine 强制，模型侧靠 recurring/maxRuns 的
// description 提示，非法组合在工具执行时被拒绝并回带明确错误。
export const CronUpdateInputJsonSchema = toToolJsonSchema(CronUpdateInputObjectSchema);

/** CronList 入参：空对象且 strict，列表能力不接收过滤参数（会话内任务量有界）。 */
export const CronListInputSchema = z.object({}).strict();
/** CronList 的 TS 视图；恒为空对象，保留类型只为统一工具签名。 */
export type CronListInput = z.infer<typeof CronListInputSchema>;
/** 面对模型的 JSON schema；空 object，provider 侧无需任何字段。 */
export const CronListInputJsonSchema = toToolJsonSchema(CronListInputSchema);

/** CronDelete 入参：只按 CronCreate/CronList 返回的 automation id 删除，不接受模糊匹配。 */
export const CronDeleteInputSchema = z
  .object({
    id: nonEmptyString.describe("Automation id returned by CronCreate or CronList"),
  })
  .strict();
/** CronDelete 的 TS 视图；id 已 trim 且非空。 */
export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;
/** 面对模型的 JSON schema；单字段 object。 */
export const CronDeleteInputJsonSchema = toToolJsonSchema(CronDeleteInputSchema);

/**
 * 自定义重复规则的 contract 层镜像 schema（zod v3）。
 * 与 @zcode/shared 的 ZCodeAutomationScheduleRule 结构同步——此处不 import shared，
 * 避免 agent contracts 的 zod v3 与 shared zod v4 交叉依赖（同 browser-control 镜像约定）。
 * cronExpr 保留为兼容展示，调度以本字段为权威；会话侧长间隔 carrier 归一化后由本字段承载。
 */
export const CronAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
/** scheduleRule 的 TS 视图；与 shared 的 ZCodeAutomationScheduleRule 逐字段一致。 */
export type CronAutomationScheduleRule = z.infer<typeof CronAutomationScheduleRuleSchema>;

/**
 * 会话内一条定时任务的快照，由 automation service 生产、Cron 工具与会话卡片消费。
 * `automationId` 是删除/更新的稳定键；`title` 保留用户的自然语言调度短语；`cronExpr`
 * 只是兼容展示，真实周期以 `scheduleRule` 为权威（缺席才回退解析 cronExpr）。
 * `nextRunAt`/`lastRunAt` 是 epoch ms，`runCount` 只计成功派发；`lifecycleStatus`
 * 是持久生命周期（active/completed/failed/paused），与 `enabled` 的运行开关分开。
 * `modelSelection`/`mode` 记录创建时的执行设定，属于任务事实而非展示字段。
 */
export const CronAutomationSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    enabled: z.boolean(),
    /** 持久生命周期；`paused` 与 enabled=false 不必同步，前者是状态机，后者是开关。 */
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    /** 下一次应触发的本地时刻（epoch ms）；一次性任务跑完后可能缺席。 */
    nextRunAt: z.number().int().nonnegative().optional(),
    /** 上一次实际派发的时刻（epoch ms）；从未跑过则缺席。 */
    lastRunAt: z.number().int().nonnegative().optional(),
    /** 成功派发次数；达到 maxRuns 后任务转 completed。 */
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    modelSelection: cronModelSelectionSchema.optional(),
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]).optional(),
    // 自定义重复规则；缺省时调度回退到解析 cronExpr。会话卡片必须读到本字段才能展示
    // cron 无法表达的真实间隔（如每50小时、每40天，兼容 cronExpr 只是 0 * * * *）。
    scheduleRule: CronAutomationScheduleRuleSchema.optional(),
  })
  .strict();
/** 任务快照的 TS 视图；字段口径见上方 CronAutomationSchema 的块注释。 */
export type CronAutomation = z.infer<typeof CronAutomationSchema>;

/**
 * CronCreate 输出：`automation` 是落库后的事实（不是入参回显），`message` 是给模型的
 * 确认文案。调用方应按 automationId 而不是 message 做后续更新/删除。
 */
export const CronCreateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
/** CronCreate 输出的 TS 视图。 */
export type CronCreateOutput = z.infer<typeof CronCreateOutputSchema>;
/** 面对模型的创建输出 JSON schema。 */
export const CronCreateOutputJsonSchema = toToolJsonSchema(CronCreateOutputSchema);

/**
 * CronUpdate 输出与创建同形：`automation` 是更新后的完整快照（含新的 scheduleRule 与
 * nextRunAt），`message` 只是确认文案；不要用它推断字段是否真的变了。
 */
export const CronUpdateOutputSchema = z
  .object({
    automation: CronAutomationSchema,
    message: nonEmptyString,
  })
  .strict();
/** CronUpdate 输出的 TS 视图。 */
export type CronUpdateOutput = z.infer<typeof CronUpdateOutputSchema>;
/** 面对模型的更新输出 JSON schema。 */
export const CronUpdateOutputJsonSchema = toToolJsonSchema(CronUpdateOutputSchema);

/**
 * CronList 输出：会话可见的全部任务快照（无分页、无过滤），顺序由 service 决定；
 * 空数组是合法结果，表示没有任何任务。
 */
export const CronListOutputSchema = z
  .object({
    automations: z.array(CronAutomationSchema),
  })
  .strict();
/** CronList 输出的 TS 视图。 */
export type CronListOutput = z.infer<typeof CronListOutputSchema>;
/** 面对模型的列表输出 JSON schema。 */
export const CronListOutputJsonSchema = toToolJsonSchema(CronListOutputSchema);

/**
 * CronDelete 输出：`deleted` 是幂等结果位（找不到时 false），`id` 回显请求键，
 * `message` 是确认文案。删除不是错误路径，调用方据 deleted 判断是否真的移除。
 */
export const CronDeleteOutputSchema = z
  .object({
    deleted: z.boolean(),
    id: nonEmptyString,
    message: nonEmptyString,
  })
  .strict();
/** CronDelete 输出的 TS 视图；deleted=false 表示该 id 不存在或已删。 */
export type CronDeleteOutput = z.infer<typeof CronDeleteOutputSchema>;
/** 面对模型的删除输出 JSON schema。 */
export const CronDeleteOutputJsonSchema = toToolJsonSchema(CronDeleteOutputSchema);
