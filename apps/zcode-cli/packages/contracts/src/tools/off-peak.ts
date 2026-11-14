// ============================================================
// Off-Peak tools - session-level idle-time task creation
// ============================================================
// 闲时任务与 cron automation 是兄弟实体：schema 独立镜像，禁止互相复用。
// workspace/凭证不是模型入参；permissionMode/model/thoughtLevel 缺省在 host 端解析
// （yolo / allowed_models 末位 / 最高推理档），模型只在用户显式要求时覆盖。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

// 创建闲时任务的入参。任务绑定"当前会话"：稍后代表本会话无人值守继续执行，因此输入里
// 刻意没有工作区路径/身份——那些由 host 侧补齐，模型写进来只会产生第二真相源。
// 三个可选字段（permissionMode/model/thoughtLevel）都是"仅用户显式要求时才设"，缺省在 host
// 解析（yolo / allowed_models 末位 / 最高推理档）；strict 让未知字段成为可见错误。
export const OffPeakCreateInputSchema = z
  .object({
    // 用户可读的短标题；不带文件路径，避免把实现细节塞进展柜卡片。
    title: nonEmptyString.describe(
      "Concise idle-time task title describing the deferred work, for example '重构 utils 目录' or 'Fix flaky auth tests'. Keep it short and do not include file paths.",
    ),
    // 派发时要执行的最终工作说明：无人值守阶段没人回答追问，所以必须写清交付物；同时禁止
    // 让这轮再去创建闲时任务/自动化，否则会形成自我增殖的任务链。
    prompt: nonEmptyString.describe(
      "Instructions for the deferred run, which later continues THIS conversation unattended with the full history available, so it may refer to context already established here. State the expected deliverable explicitly (nobody will answer questions during the run); never ask the run to create, schedule, or configure another idle-time task or automation.",
    ),
    // 无人值守运行时的权限模式；缺省是 yolo（全自动）。其余档位只在用户明确要求"要确认/
    // 只读规划"时才设，语义与常规会话模式一致。
    permissionMode: z
      .enum(["build", "edit", "plan", "yolo", "guarded"])
      .optional()
      .describe(
        "Unattended run permission mode. Omit for the default full-automatic mode (yolo). Set only when the user explicitly asks for confirmation-gated execution: 'build' pauses for approval before changes, 'edit' auto-applies edits, 'plan' is read-only planning, 'guarded' runs like yolo but pauses once for explicitly recognized dangerous shell commands (rm -rf, git reset --hard, force push, rsync --delete, etc.).",
      ),
    // 闲时执行所用模型 id；必须在 host 的 allowed_models 名单内。缺省取名单末位（通常是最新
    // 允许模型），模型只在用户点名某模型时才覆盖。
    model: nonEmptyString
      .optional()
      .describe(
        "Idle-plan model id. Must be one of the idle-time allowed models; omit to use the default (the newest allowed model). Set only when the user names a specific model.",
      ),
    // 推理档位；缺省取该模型的最高档。降低档位只在用户明确要求"省点推理/更快"时才设。
    thoughtLevel: nonEmptyString
      .optional()
      .describe(
        "Reasoning effort level for the chosen model. Omit to use the default (the highest level). Set only when the user explicitly asks for a lower reasoning effort.",
      ),
  })
  .strict();
// 创建入参的运行时类型；handler 解析后原样交给 offPeakPort.create，本层不补默认值
// （缺省语义属于 host 的闲时策略，契约层不复制一份）。
export type OffPeakCreateInput = z.infer<typeof OffPeakCreateInputSchema>;
// provider 可见的创建入参 schema；描述里带"省略即用默认"，模型据此知道不必填满三个可选字段。
export const OffPeakCreateInputJsonSchema = toToolJsonSchema(OffPeakCreateInputSchema);

// 任务状态词汇表：queued（排队中）/paused（暂停）/running（已派发执行中）/completed/failed/
// cancelled。与 shared 侧 ZCodeOffPeakTaskStatus 同值镜像——zod v3/v4 的包边界不允许直接
// import shared，所以这里重新声明；两侧分叉的症状是模型看到的状态与服务端实际不符。
/** 客户端执行态（与 shared ZCodeOffPeakTaskStatus 同值镜像；zod v3/v4 边界不 import shared）。 */
export const OffPeakTaskStatusSchema = z.enum([
  "queued",
  "paused",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
// 状态类型；summary 与列表都按这个集合校验，新增状态必须同时改 schema 与端口映射。
export type OffPeakTaskStatus = z.infer<typeof OffPeakTaskStatusSchema>;

// 任务卡与 OffPeakList 共用的最小快照。刻意不暴露 serverTicketId / providerName：票号是
// 服务端排队的内部凭据，provider 名可能与用户可读信息不一致，两者都不该进模型可见结果。
// queuePosition 只在真排队（queued/paused 等）时在场；sessionId 是任务绑定的会话。
/** 轮尾卡片与 OffPeakList 的最小任务快照：不暴露 serverTicketId / providerName。 */
export const OffPeakTaskSummarySchema = z
  .object({
    // 闲时任务的服务端标识（offpeak-... 族），后续查询/取消都靠它。
    offPeakTaskId: nonEmptyString,
    // 用户可读标题，原样来自创建入参；展示优先于 id。
    title: z.string(),
    // 生命周期状态，决定卡片文案与是否可取消。
    status: OffPeakTaskStatusSchema,
    // 队列位置（1 起）；只有处于排队阶段才在场，运行/终态时缺席。
    queuePosition: z.number().int().positive().optional(),
    // 绑定的会话 id；派发时在该会话继续执行，缺席表示 host 未回填。
    sessionId: nonEmptyString.optional(),
    // 创建时间，epoch 毫秒；用于列表内排序与展示。
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
// 快照类型；handler 用 satisfies 构造，未被 host 回填的可选字段不写键。
export type OffPeakTaskSummary = z.infer<typeof OffPeakTaskSummarySchema>;

// 创建成功的输出：任务快照 + 一句模型可转述的确认文案。message 由 handler 生成（含队列位置），
// 不属于契约事实，但 schema 保证它非空，避免模型收到空白确认。
export const OffPeakCreateOutputSchema = z
  .object({
    // 刚创建的任务快照；模型据此向用户展示任务 id 与队列位置。
    task: OffPeakTaskSummarySchema,
    // 确认文案；非空是硬约束，防止界面出现空行。
    message: nonEmptyString,
  })
  .strict();
// 创建输出类型；handler 用 satisfies 构造后交给 executor。
export type OffPeakCreateOutput = z.infer<typeof OffPeakCreateOutputSchema>;
// provider 可见的创建输出 schema；字段演进必须与运行时 schema 同步，否则回放旧结果会校验失败。
export const OffPeakCreateOutputJsonSchema = toToolJsonSchema(OffPeakCreateOutputSchema);

// OffPeakList 不带任何入参：列表恒限定在当前工作区/会话可见范围，strict 让多传字段成为
// 可见错误而不是被静默忽略。
export const OffPeakListInputSchema = z.object({}).strict();
// 空入参类型；handler 仍需 parse 一次以走统一的运行时校验路径。
export type OffPeakListInput = z.infer<typeof OffPeakListInputSchema>;
// provider 可见的列表入参 schema（空对象）。
export const OffPeakListInputJsonSchema = toToolJsonSchema(OffPeakListInputSchema);

// 列表输出是任务快照数组；没有分页游标——闲时任务数量天然有界（同一会话同时只允许一个
// 待派发任务），一次返回全量即可。
export const OffPeakListOutputSchema = z
  .object({
    // 当前工作区可见的闲时任务；顺序由端口决定，模型不应依赖其排序。
    tasks: z.array(OffPeakTaskSummarySchema),
  })
  .strict();
// 列表输出类型；handler 用 satisfies 构造。
export type OffPeakListOutput = z.infer<typeof OffPeakListOutputSchema>;
// provider 可见的列表输出 schema，用于跨进程回放校验。
export const OffPeakListOutputJsonSchema = toToolJsonSchema(OffPeakListOutputSchema);
