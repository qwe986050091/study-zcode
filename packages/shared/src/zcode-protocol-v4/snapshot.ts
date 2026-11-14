// INV-01 A 区必须字段级整体替换而不是深合并：守住位置是消费 state.updated 的赋值分支；改错故障是深合并把上一帧数组残留带进来，交互与命令重复堆积。
// INV-02 meta 必须带 default 才能上冻结契约：守住位置是会话快照的 meta 字段声明；改错故障是旧快照解析直接失败，round-trip 测试长期变红。
// INV-03 workspaceHookAdmission 缺省必须解析为 null 而不是必填：守住位置是顶层字段声明与 delta 里的同构投影；改错故障是旧发送端不带该字段时整帧解析抛错。
// INV-04 交互的 kind 必须与载荷 kind 相等：守住位置是 superRefine 的第一条校验；改错故障是 UI 按 kind 取错载荷分支，渲染出空白面板并吞掉用户答复。
// INV-05 Hook 审核的 interactionId 必须等于不可变载荷内的 id：守住位置是 superRefine 的第三条校验；改错故障是审核回执写到另一条 hook 上，原 hook 永久卡在待审。
// INV-06 行窗口必须与总数、首行标识自洽：守住位置是 rowsWindow 三个字段的声明与写入点；改错故障是滚动条估高失真，到顶判定提前触发放大式重复分页。
// INV-07 协议版本必须是字面量 1 而非数字区间：守住位置是 protocolVersion 字段声明；改错故障是新端把未知版本当同构结构解析，字段偏移错乱后读到别的值。
// INV-08 冷快照必须携带 workflowRuns：守住位置是顶层字段声明与投影构造处；改错故障是刷新或重连后正在运行的 run 从界面消失，而进程里仍在飞。
// INV-09 子代理目录的 revision 必须与运行列表同批写入：守住位置是投影状态的四个字段声明；改错故障是局部更新让 UI 看到 revision 与运行条目互相对不上的旧目录。
// INV-10 目标的 targetId 缺省必须是空串而不是省略：守住位置是目标状态的默认值声明；改错故障是旧快照被当成全新目标，已累计的计时与迭代被重置。
// INV-11 paused 只能由 stop 施加：守住位置是目标状态枚举与停止逻辑的唯一写入处；改错故障是别处手动置 paused，让停止后的恢复路径误判为无需恢复。
// INV-12 计划条目的 id 必须在单个计划内唯一：守住位置是计划条目数组的渲染与更新处；改错故障是列表键冲突，勾选状态串到相邻条目上。
// INV-13 活动工作的开始时间必填：守住位置是活动摘要的 startedAt 字段；改错故障是悬浮提示用缺省时间算耗时得到无效值，显示成荒谬时长。
// INV-14 错误归因必须严格拒绝未知键：守住位置是归因对象的 strict 收尾；改错故障是历史残留字段被静默接受，污染归因统计且难以察觉。
// INV-15 highspeedCardId 的三种取值含义不可混用：守住位置是字段声明与渲染端作废匹配卡的分支；改错故障是把缺省当成未使用，旧 Agent 的卡被错误作废。
// INV-16 上下文用量用 null 表达不可用而非零：守住位置是可空声明与百分比计算处；改错故障是零值触发除零或显示零占用，误导压缩时机。
// INV-17 确认预览解析失败必须退化为缺省而不是报错：守住位置是 display 字段的 catch 分支；改错故障是一份坏预览拒收整份快照，会话界面白屏。
// INV-18 队列不得持久化：守住位置是队列状态的构造与序列化路径；改错故障是把队列写盘后重启重放，已消费的输入被重复发送。
//
// 模块职责：定义 v4 协议会话快照的全部 schema，覆盖控制面、阻塞交互、队列、子代理目录、目标与行窗口，是跨进程的冻结契约。
// 状态所有权：所有状态归 CLI 侧投影所有，快照只是单帧只读切片，客户端不得回写，也不得据此推导服务端未下发的裁决。
// 阅读顺序：先看会话快照的分区与默认值约定，再按 A 区控制面到 B 区行窗口逐段理解各子结构。
/* oxlint-disable max-lines -- v4 snapshot schema is a frozen cross-process contract; additions stay grouped here. */
// ConversationSnapshot A 区。
// A 区更新语义 = 字段级整体替换（state.updated），绝不深合并——深合并是错乱之母。
import { z } from "zod";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
export { sharedContextImportStateSchema } from "./shared-context-import.js";
import { conversationInputDispatchSchema, conversationInputIntentSchema } from "./input-intent.js";
import {
  zcodeContextUsageBreakdownSchema,
  zcodeInteractionRequestOriginSchema,
  zcodePermissionResponseSchema,
  zcodeSessionContextCacheUsageSchema,
} from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { toolCallDisplaySchema } from "./toolDisplay.js";

import { workspaceHookReviewRequestPayloadSchema } from "./workspace-hook-review.js";
import { workflowRunsStateSchema } from "./workflow-runs.js";
import { sessionConfigStateSchema, sessionModelTransitionSchema } from "./session-config.js";
export {
  sessionConfigStateSchema,
  sessionModelTransitionSchema,
  type SessionConfigState,
  type SessionModelTransition,
} from "./session-config.js";
// ── SessionControl ──
export const sessionPhaseSchema = z.enum([
  // draft 裁决保留——纯内存态、sessions-index 可见、无 row、
  // 不落盘、CLI 重启即消失；firstInput 到达 → prewarming/running。
  "draft",
  "prewarming",
  "running",
  "completedSuccess",
  "completedInterrupted",
  "error",
]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const stopTargetKindSchema = z.enum([
  "assistant",
  "tool",
  "subagent",
  "compact",
  "goalVerifier",
  "goalContinuation",
  "turnSteer",
  "mixed",
  "unknown",
]);
export type StopTargetKind = z.infer<typeof stopTargetKindSchema>;

export const activeWorkSummarySchema = z.object({
  kind: z.enum([
    "primaryTurn",
    "foregroundSubagent",
    "compact",
    "goalVerifier",
    "goalContinuation",
    "turnSteer",
  ]),
  foregroundExecutionId: z.string().min(1).optional(),
  sourceCommandId: z.string().min(1).optional(),
  startedAt: timestampSchema,
});
export type ActiveWorkSummary = z.infer<typeof activeWorkSummarySchema>;

// 错误码分为 fault.*、proto.* 与 guard.*。
// [权衡] 归因是尽力而为的诊断附加物，全部字段可选，缺失时只降级展示，绝不能让解析失败阻断整帧。
// 严格的未知键拒绝是有意为之：这一层会被跨版本写入历史残留，所以新增字段必须同时考虑旧数据回放的合法性。
// 来源与错误阶段描述的是错误发生在哪一层，而不是错误类型，两者都缺时界面只能呈现裸错误码。
// 状态码限定在三位数区间，是为了让网络栈的负值与零在本层就被拒绝，而不是流到 UI 参与重试判断。
// 可重试由产生方裁决而非客户端推断，客户端自行重试会绕过退避策略，形成重试风暴。
// [失败路径] 归因字段只增不减，一旦发布就不能删除，否则旧快照回放时严格校验会把历史记录判为非法。
export const errorAttributionSchema = z
  .object({
    source: z.enum(["provider", "runtime", "tool", "network"]).optional(),
    reason: z.string().min(1).max(160).optional(),
    errorPhase: z
      .enum([
        "prepare",
        "configuration",
        "connect",
        "response",
        "stream",
        "parse",
        "validation",
        "unhandled",
      ])
      .optional(),
    exceptionKind: z
      .enum([
        "api_call",
        "generic",
        "protocol",
        "provider_business",
        "transport",
        "type_error",
        "validation",
      ])
      .optional(),
    providerId: z.string().min(1).max(160).optional(),
    modelId: z.string().min(1).max(160).optional(),
    providerKind: z.string().min(1).max(160).optional(),
    transport: z.enum(["http", "sse", "websocket"]).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    providerErrorCode: z.string().min(1).max(160).optional(),
    retryable: z.boolean().optional(),
    /** string=使用该 Highspeed 卡，null=明确未使用，undefined=旧 Agent 未发布。 */
    highspeedCardId: z.string().nullable().optional(),
    /** true=本轮 Highspeed 失败已命中退回声明但无可用退回目标；Renderer 据此作废匹配卡。 */
    highspeedFallbackUnavailable: z.boolean().optional(),
  })
  .strict();
export type ErrorAttribution = z.infer<typeof errorAttributionSchema>;

export const sessionErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  at: timestampSchema,
  source: z.enum(["provider", "runtime", "tool", "network"]),
  traceId: z.string().optional(),
  detail: z.string().optional(),
  underlyingErrorMessage: z.string().optional(),
  underlyingErrorDetail: z.string().optional(),
  attribution: errorAttributionSchema.optional(),
});
export type SessionErrorInfo = z.infer<typeof sessionErrorInfoSchema>;

export const apiRetryStateSchema = z.object({
  attempt: z.number(),
  maxAttempts: z.number(),
  nextRetryAt: timestampSchema,
  reasonCode: z.string(),
});
export type ApiRetryState = z.infer<typeof apiRetryStateSchema>;

// [权衡] 控制面是每帧都要下发的高频区，因此只放客户端无法自行推导的裁决事实，任何能从行数据或阶段算出的量都不许再进来。
// 会话结束与可停止是刻意的冗余派生值，必须由服务端在同一处计算下发，客户端各自推导会与真正的停止语义分叉。
// [失败路径] 最近错误与重试状态用可空而非缺省表达，用来区分「确实没有错误」和「旧发送端还没实现该字段」。
// 活动工作只描述正在占用前台的条目，停止后的收尾阶段仍可能非空，UI 不能把空数组当成会话已结束。
// 停止目标的混合态与未知态是给上层兜底的取值，新增具体种类必须先扩枚举再改投影，否则旧端会因非法值拒收整帧。
// [并发] 该对象每次由投影层整体重建而不是就地修改，避免 UI 读到一半被下一次更新覆盖出撕裂状态。
export const sessionControlSchema = z.object({
  phase: sessionPhaseSchema,
  // 派生值（= phase ∈ completed*），为 UI 便利保留。
  sessionEnded: z.boolean(),
  canStop: z.boolean(),
  stopState: z.enum(["idle", "stoppable", "stopping"]),
  stopTargetKind: stopTargetKindSchema,
  // 轻量证据/悬浮提示用，UI 不得据此推导 flag。
  // hasBackgroundWork 不在载荷内：客户端按 backgroundWorks.some(w => w.status === "running") 一行派生。
  activeWorks: z.array(activeWorkSummarySchema),
  lastError: sessionErrorInfoSchema.nullable(),
  apiRetry: apiRetryStateSchema.nullable(),
});
export type SessionControl = z.infer<typeof sessionControlSchema>;

// ── availability 与 inputRouting ──
export const actionAvailabilitySchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  // reasonCode = product-protocol guard id，驱动禁用态 tooltip。
  z.object({ allowed: z.literal(false), reasonCode: z.string() }),
]);
export type ActionAvailability = z.infer<typeof actionAvailabilitySchema>;

export const sessionActionAvailabilitySchema = z.object({
  fork: actionAvailabilitySchema,
  compact: actionAvailabilitySchema,
  switchModelConfig: actionAvailabilitySchema,
  setFollowupMode: actionAvailabilitySchema,
  queueEdit: actionAvailabilitySchema,
  sendQueuedNow: actionAvailabilitySchema,
  pauseGoal: actionAvailabilitySchema,
  resumeGoal: actionAvailabilitySchema,
});
export type SessionActionAvailability = z.infer<typeof sessionActionAvailabilitySchema>;

export const inputRoutingSchema = z.object({
  // choice：held（completed+queue>0+autoDrain=false）下
  // 输入不静默入队，客户端呈现「清空 queue 后发送 / 保留 queue 立即发送」。
  mode: z.enum(["startNow", "enqueue", "guide", "reject", "choice"]),
  // mode=reject 必带；enqueue/guide/choice 可带（如 guide 不合格回退原因）。
  reasonCode: z.string().optional(),
});
export type InputRouting = z.infer<typeof inputRoutingSchema>;

// ── meta（会话级元信息：标题）。renameSession/自动标题落此。──
export const sessionMetaStateSchema = z.object({
  title: z.string(),
  // default = 未命名；generated = 模型自动生成；custom = 用户显式重命名（不再被自动标题覆盖）。
  titleSource: z.enum(["default", "generated", "custom"]),
});
export type SessionMetaState = z.infer<typeof sessionMetaStateSchema>;

/**
 * 分享导入的只读来源标记。
 *
 * shared_context 正文只给模型使用，不能通过 userInput row 伪造到会话气泡里；
 * 这个 additive 元数据让 Desktop 在新会话中仍能明确告诉用户上下文来自哪里。
 */
export type { SharedContextImportState } from "./shared-context-import.js";

// ── usage。conflation：值未变不下发──
export const sessionUsageStateSchema = z.object({
  contextWindow: z
    .object({
      usedTokens: z.number(),
      maxTokens: z.number(),
      autoCompactThresholdTokens: z.number().nullable(),
      cache: zcodeSessionContextCacheUsageSchema.optional(),
      breakdown: zcodeContextUsageBreakdownSchema.optional(),
    })
    .nullable(),
  cumulative: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheWriteTokens: z.number(),
  }),
});
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

// ── queue（不持久化，裁决：CLI 进程死亡即丢，客户端对账后由用户决定重发）──
export const queueItemSchema = conversationInputIntentSchema.extend({
  dispatch: conversationInputDispatchSchema.extend({
    state: z.enum(["queued", "reserved", "promoting"]),
  }),
  toolDisallowlist: z.array(z.string().min(1)).optional(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueStateSchema = z.object({
  items: z.array(queueItemSchema),
  // stop 后 = false（暂停队列）；setAutoDrain 恢复。
  autoDrain: z.boolean(),
  // additive：旧快照缺省时 UI 使用通用暂停文案；Stop/TurnError 可显示原因文案。
  pauseReason: z.enum(["stopped", "manual", "error"]).optional(),
});
export type QueueState = z.infer<typeof queueStateSchema>;

// ── pendingInteractions（阻塞交互 → 状态）──
export const MAX_PERMISSION_FEEDBACK_CHARS = 4_096;

export const PERMISSION_FULL_ACCESS_OPTION_ID = "fullAccess";
const permissionOptionSchema = z.object({
  optionId: z.string(),
  label: z.string(),
  kind: z.enum(["allowOnce", "allowAlways", "deny", "custom"]),
  response: zcodePermissionResponseSchema.optional(),
});

export const permissionRequestPayloadSchema = z.object({
  kind: z.literal("permission"),
  toolCallId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  detail: z.unknown(),
  // additive：旧 snapshot 缺省时 UI 不显示反馈输入；V4 新投影可显式开启。
  freeText: z.boolean().optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
  // 工具自报的确认预览，复用 row 的 display 投影（同一有界形状）。缺省 = 纯文本 ask。
  // 同样不设门：预览解析失败退化成纯文本 ask，不拒整份 snapshot（见 toolDisplay.ts 注释）。
  display: toolCallDisplaySchema.optional().catch(undefined),
  // 独立 additive 能力：旧 UI 忽略此字段，仍只显示原 options，不出现半实现授权入口。
  fullAccessOption: permissionOptionSchema
    .extend({
      optionId: z.literal(PERMISSION_FULL_ACCESS_OPTION_ID),
      kind: z.literal("custom"),
    })
    .optional(),
  options: z.array(permissionOptionSchema),
});
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;

export const userInputOptionPayloadSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
});
export type UserInputOptionPayload = z.infer<typeof userInputOptionPayloadSchema>;

export const userInputQuestionPayloadSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(userInputOptionPayloadSchema),
  multiSelect: z.boolean().optional(),
});
export type UserInputQuestionPayload = z.infer<typeof userInputQuestionPayloadSchema>;

export const userInputRequestPayloadSchema = z.object({
  kind: z.literal("userInput"),
  prompt: z.string(),
  freeText: z.boolean(),
  options: z.array(z.object({ optionId: z.string(), label: z.string() })).optional(),
  // true → 输入框按密码处理，客户端不入草稿/历史。
  sensitive: z.boolean().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  traceId: z.string().optional(),
  input: z.unknown().optional(),
  schema: z.unknown().optional(),
  questions: z.array(userInputQuestionPayloadSchema).optional(),
  currentQuestionIndex: z.number().optional(),
  answerDrafts: z.record(z.string(), z.array(z.string())).optional(),
  origin: zcodeInteractionRequestOriginSchema.optional(),
});
export type UserInputRequestPayload = z.infer<typeof userInputRequestPayloadSchema>;

export const interactionAutoResolutionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.enum(["hiddenGrace", "visibleCountdown"]),
    startedAt: timestampSchema,
    visibleAt: timestampSchema,
    deadlineAt: timestampSchema,
  }),
  z.object({
    state: z.literal("snoozed"),
    startedAt: timestampSchema,
    snoozedAt: timestampSchema,
  }),
]);
export type InteractionAutoResolution = z.infer<typeof interactionAutoResolutionSchema>;

// [事务] 阻塞交互是唯一需要双端确认的状态，schema 层强制两个 kind 相等，避免 UI 拿到自己不认识的载荷形态。
// 锚定行为空表示会话级交互，不挂任何消息行；UI 必须把它渲染在输入区而不是气泡列表，否则刷新后入口会丢失。
// Hook 审核复用这条通道，但它不接受自动消解，因此校验明确拒绝自动消解字段，防止审核被倒计时悄悄通过。
// 该审核的标识必须与不可变载荷内的标识相同，这是防止回执写到另一条 hook 上的唯一防线。
// [失败路径] 三条校验规则都在解析期失败，不做运行时修补，宁可整帧被拒后由重同步重建，也不让矛盾状态进入内存。
// 自动消解用绝对时间戳而不是剩余秒数，避免客户端时钟漂移与后台挂起导致倒计时错位。
export const pendingInteractionSchema = z
  .object({
    interactionId: z.string(),
    kind: z.enum(["permission", "userInput", "workspaceHookReview"]),
    // null = 会话级（如 provider 交互和 workspace Hook review）。
    anchorRowId: z.number().nullable(),
    createdAt: timestampSchema,
    autoResolution: interactionAutoResolutionSchema.optional(),
    payload: z.discriminatedUnion("kind", [
      permissionRequestPayloadSchema,
      userInputRequestPayloadSchema,
      workspaceHookReviewRequestPayloadSchema,
    ]),
  })
  .superRefine((interaction, context) => {
    if (interaction.kind !== interaction.payload.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "pending interaction kind must match payload kind",
      });
    }
    if (interaction.kind === "workspaceHookReview" && interaction.autoResolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoResolution"],
        message: "workspaceHookReview cannot use AskUserQuestion auto-resolution",
      });
    }
    if (
      interaction.payload.kind === "workspaceHookReview" &&
      interaction.interactionId !== interaction.payload.interactionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactionId"],
        message: "workspaceHookReview interaction id must match its immutable payload",
      });
    }
  });
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

// ── pendingCommands / backgroundWorks ──
export const commandStateSummarySchema = z.object({
  commandId: z.string(),
  clientId: z.string(),
  type: z.string(),
  state: z.enum(["accepted", "executing"]),
  at: timestampSchema,
});
export type CommandStateSummary = z.infer<typeof commandStateSummarySchema>;

export const backgroundWorkSummarySchema = z.object({
  workId: z.string(),
  // workflow = workflow run（CreateWorkflow）。**闭集加值的偏斜代价**：
  // 旧桌面收到未知值时整个 state.updated patch 解析失败（已知键的非法值是错误，不是剥离），
  // 于是整帧被 assembler 拒收，且 resync 的 snapshot 携带同一个值、同样失败——不能优雅降级。
  // CLI 与桌面同批发布才使它可接受。
  kind: z.enum(["bash", "subagent", "workflow"]),
  title: z.string(),
  // resultPending = 已完成、结果在 continuation inbox 等待前台空闲；
  // 投递后条目消失（结果本体成为 origin=backgroundResult 的 userInput row）。
  status: z.enum(["running", "resultPending", "failed", "cancelled"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  cancellable: z.boolean().optional(),
  blocked: z.boolean().optional(),
  anchorRowId: z.number().nullable(),
  childSessionId: z.string().optional(),
});
export type BackgroundWorkSummary = z.infer<typeof backgroundWorkSummarySchema>;

// subagent 运行态属于 conversation 权威投影，而不是 renderer 查询缓存。
// ended 详情保持 cursor query；snapshot 只携带目录总数，避免运行中并发数量依赖查询时序。
export const runningSubagentSummarySchema = z.object({
  childSessionId: z.string(),
  agentId: z.string().optional(),
  toolCallId: z.string().optional(),
  subagentType: z.string(),
  title: z.string(),
  summary: z.string().optional(),
  status: z.enum(["running", "waiting", "blocked"]),
  startedAt: timestampSchema.optional(),
});
export type RunningSubagentSummary = z.infer<typeof runningSubagentSummarySchema>;

// 子代理目录属于会话权威投影，不是渲染端的查询缓存，因此快照必须能独立还原目录，而不依赖额外的游标查询。
// [并发] 修订号只在目录内容整体替换时递增，运行列表与结束总数必须与它同批写入，分开更新会让 UI 看到自相矛盾的目录。
// 运行列表只放仍在运行的条目，结束后从数组移除并让结束总数加一，这样列表不会随会话寿命无限增长。
// 子会话标识与运行摘要语义不同，前者是全部子会话的标识集合，后者带运行态，二者不能互相推导。
// [权衡] 结束详情留在游标查询里而非快照，是为了控制每帧体积，代价是展开历史子代理需要额外一次请求。
export const subagentProjectionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  childSessionIds: z.array(z.string()),
  running: z.array(runningSubagentSummarySchema),
  endedTotal: z.number().int().nonnegative(),
});
export type SubagentProjectionState = z.infer<typeof subagentProjectionStateSchema>;

// ── goal / plan ──
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "inProgress", "completed"]),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const goalIterationStateSchema = z.object({
  iteration: z.number().int().positive(),
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type GoalIterationState = z.infer<typeof goalIterationStateSchema>;

// 目标标识缺省为空串而不是省略，是为了让旧快照解析后仍是一个完整目标对象，不会被上层误判为没有目标。
// [事务] 计时事实以绝对毫秒时间为准，已用秒数只是结算后的展示值，累加逻辑必须只在一个地方做。
// 未达成与失败必须分开：前者是验证得到的有效结论，后者是验证过程本身出错，文案与是否重试完全不同。
// 迭代历史带空数组默认值，保证旧快照渲染历史时不会因字段缺席而中断整块界面。
// [失败路径] 验证记录只追加不修改，锚定的行被裁剪后仍保留行标识，缺失时由 UI 降级为不带跳转的历史项。
export const goalStateSchema = z.object({
  // default 仅用于旧快照兼容；新投影始终携带当前 target 身份和计时事实。
  targetId: z.string().default(""),
  objective: z.string(),
  summaryTitle: z.string().nullable().default(null),
  timeUsedSeconds: z.number().int().nonnegative().default(0),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().default(null),
  // paused：stop 作用于任何 foreground work 时 target 强制进入（stopPausesActiveGoalTarget）。
  // notSatisfied 与 failed 分离：前者是有效结论，后者是验证过程失败。
  status: z.enum(["active", "paused", "verifying", "verified", "notSatisfied", "failed"]),
  iteration: z.number(),
  verifications: z.array(
    z.object({
      iteration: z.number(),
      outcome: z.enum(["pass", "notSatisfied", "failed"]),
      at: timestampSchema,
      anchorRowId: z.number().nullable(),
      reason: z.string().optional(),
      nextAction: z.string().optional(),
    }),
  ),
  iterations: z.array(goalIterationStateSchema).default([]),
});
export type GoalState = z.infer<typeof goalStateSchema>;

export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  updatedAt: timestampSchema,
});
export type PlanState = z.infer<typeof planStateSchema>;

// ── Snapshot 总览 ──
export const rowsWindowSchema = z.object({
  // 尾部窗口，rowId 升序。
  window: z.array(conversationRowSchema),
  // 当前全序行数（截断后会减小；仅用于滚动条估计）。
  totalCount: z.number(),
  // 全序第一行 rowId；window 首行等于它 ⇔ 已到顶（游标分页判定）。
  firstRowId: z.number().nullable(),
});
export type RowsWindow = z.infer<typeof rowsWindowSchema>;

// 软门禁(Soft Gate)：会话级待审核 hook 准入状态。
// snapshot 与 StatePatch(delta.ts)共用,保证投影补丁与快照字段同构。
export const workspaceHookAdmissionStateSchema = z.object({
  pendingCount: z.number().int().nonnegative(),
  bundleDigest: z.string(),
  workspaceIdentity: z.string().optional(),
});
export type WorkspaceHookAdmissionSnapshotState = z.infer<typeof workspaceHookAdmissionStateSchema>;

// 冷历史可读不代表 runtime 已可执行；缺席兼容旧发送端。
// 该字段可选意味着旧发送端从不提供它，客户端必须把缺席当作无需等待初始化，而不是当作初始化失败。
// 三个分支都带尝试标识，使得重试能区分同一会话的多次初始化，晚到的旧尝试结果会被丢弃。
// [失败路径] 失败分支同时携带原因码与文案，原因码供程序判断，文案只供展示，二者不能互相替代。
// 冷历史可读并不代表运行时已可执行，因此该状态与行数据是否存在完全解耦。
// [权衡] 没有单独的空闲分支，缺省即空闲，增加显式空闲态会让旧快照必须迁移后才能解析。
export const runtimeInitializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("initializing"), attemptId: z.string().min(1) }),
  z.object({ status: z.literal("ready"), attemptId: z.string().min(1) }),
  z.object({
    status: z.literal("failed"),
    attemptId: z.string().min(1),
    reasonCode: z.string(),
    message: z.string(),
  }),
]);
export type RuntimeInitialization = z.infer<typeof runtimeInitializationSchema>;

// 快照分为控制面与行窗口两段，控制面每帧整体下发，行窗口只带尾部若干行，其余靠游标补齐。
// [并发] 所有字段取自同一次内存投影的原子读数，序号与修订号因此可以当作同一时刻的水位，不能分两次读取再拼装。
// [权衡] 新增字段一律加法式且可选或带默认值，宁可让新端多一层判空，也不让旧端因未知字段或缺失字段整帧解析失败。
// 协议版本是字面量而不是区间，跨版本兼容靠加法演进，一旦需要改语义就必须新开 schema 文件而不是就地篡改。
// [失败路径] 解析失败被视为不可恢复，调用方丢弃该帧并走重同步，因此任何放宽的兜底只应出现在局部展示字段上。
// 行窗口为空是合法状态，表示会话尚无行或尚未加载，不允许用空值代替空数组来表达同一种含义。
export const conversationSnapshotSchema = z.object({
  runtimeInitialization: runtimeInitializationSchema.optional(),
  protocolVersion: z.literal(1),
  sessionId: z.string(),
  logEpoch: z.string(),
  // 快照对齐水位（= 所在帧 toSeq；从内存投影原子取值）。
  seq: z.number(),
  revision: z.number(),
  // A 区
  control: sessionControlSchema,
  availability: sessionActionAvailabilitySchema,
  inputRouting: inputRoutingSchema,
  // meta 是冻结 schema之后的
  // additive 新增，必须带 default 才不破坏旧快照/旧发送端的解析——备份分支曾把它设为
  // 必填，shared 的 round-trip 测试在该分支上一直是红的（当时未跑 root vitest 漏网）。
  meta: sessionMetaStateSchema.default({ title: "", titleSource: "default" }),
  // Additive：旧 CLI/旧快照不带该字段时仍按普通会话处理。
  sharedContextImport: sharedContextImportStateSchema.optional(),
  config: sessionConfigStateSchema,
  // 持久化稳定事实供 live 客户端识别一次性提示；旧快照缺字段时不触发。
  modelTransition: sessionModelTransitionSchema.nullable().default(null),
  usage: sessionUsageStateSchema,
  queue: queueStateSchema,
  pendingInteractions: z.array(pendingInteractionSchema),
  pendingCommands: z.array(commandStateSummarySchema),
  backgroundWorks: z.array(backgroundWorkSummarySchema),
  // optional 只服务旧快照 wire 兼容；新 CLI 的初始态和每次投影都始终携带该字段。
  subagents: subagentProjectionStateSchema.optional(),
  // 冷快照必须携带 workflowRuns：漏这一处，刷新/重连后正在跑的 run 会静默消失
  // （详情页因此空白，而 run 本身仍在飞）。optional 同样只服务旧快照 wire 兼容。
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable(),
  plan: planStateSchema.nullable(),
  // 软门禁(Soft Gate)：additive 字段,必须带 default(null)。
  // 旧快照/旧发送端不携带此字段 → 解析得 null,不破坏兼容性(遵守冻结规则)。
  // pendingCount === 0 时投影层置 null(提示条消失)。
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().default(null),
  // （2026-09-12）：原 additive 字段 pluginUiSurfaces 已删除，插件面板 widgetState 只留在
  // 宿主 renderer 内存。
  // B 区
  rows: rowsWindowSchema,
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
