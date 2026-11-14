// ============================================================
// Compact Contracts - boundary payloads and active-chain helpers
// ============================================================
//
// 横向能力：上下文压缩（compact）的事实形状。生产者是 core/runtime 的 compact 执行链
// （compact-active.ts 生成 boundary 与 timeline，compact-persistence.ts 写入 compaction part
// 与 timeline part，microcompact.ts 生成本地裁剪 boundary）。
// 消费者是 contracts/events 的事件 schema 与重放、contracts/rewind 的边界定位、
// bootstrap 的 V4 投影与 transcript hydration、以及 UI 的压缩分隔线。
// 跨进程/持久化不变量：boundary 与 timeline 会以 JSON 写入 SessionStore 的 message part
// 并随 SessionEvent 广播，因此字段必须可 zod 校验、可稳定 JSON 化；
// 禁止携带 Date、函数、循环引用或不可回查的临时句柄。

import { z } from "zod";

import type { MessageId, PartId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";

// compact 的触发来源，是最外层判别字段：决定选择策略、重试上限与 UI 文案。
// manual=用户显式 /compact（单次尝试，默认全部摘要）；auto=请求前 token 阈值触发
// （最多 3 次外层重试，保留最近 1 个 assistant 轮次）；partial=部分压缩；
// reactive=provider 溢出后的补救；session_memory=由会话记忆派生的摘要。
// 一旦写入 boundary/timeline 即为持久化事实，新增取值必须同步 schema 与所有消费端分支。
export const CompactTrigger = {
  Manual: "manual",
  Auto: "auto",
  Partial: "partial",
  Reactive: "reactive",
  SessionMemory: "session_memory",
} as const;

// 上列常量对象的取值联合；消费端 switch 依赖它做穷尽检查。
// 从持久化/事件读回时先经 zod 校验再断言，不能直接信任 JSON 里的字符串。
export type CompactTrigger = (typeof CompactTrigger)[keyof typeof CompactTrigger];

// microcompact 的触发来源：time_based=定时触发；token_pressure=token 压力触发。
// 与 CompactTrigger 分离，因为本地裁剪不生成历史分界，只清理旧工具结果。
export const MicrocompactTrigger = {
  TimeBased: "time_based",
  TokenPressure: "token_pressure",
} as const;

// MicrocompactTrigger 的取值联合，持久化格式与常量字符串完全一致。
export type MicrocompactTrigger = (typeof MicrocompactTrigger)[keyof typeof MicrocompactTrigger];

// microcompact 的执行策略枚举：当前只有本地清空工具结果一种。
// 新增策略必须同时扩展 microcompactBoundaryPayloadSchema，否则写入会被 schema 拒绝。
export const MicrocompactStrategy = {
  LocalToolResultClear: "local_tool_result_clear",
} as const;

// MicrocompactStrategy 的取值联合。
export type MicrocompactStrategy = (typeof MicrocompactStrategy)[keyof typeof MicrocompactStrategy];

// 压缩发生在 turn 的哪个时点：standalone_turn=独立压缩 turn（/compact）；
// pre_request=请求发送前；mid_turn=turn 执行中途；reactive=溢出后的补救。
// phase 不决定选择策略（由 trigger 决定），只用于时间线展示与统计归因；
// 旧事件可能没有该字段，读回方必须容忍缺省。
export const CompactPhase = {
  StandaloneTurn: "standalone_turn",
  PreRequest: "pre_request",
  MidTurn: "mid_turn",
  Reactive: "reactive",
} as const;

// CompactPhase 的取值联合。
export type CompactPhase = (typeof CompactPhase)[keyof typeof CompactPhase];

// 面向 UI/统计的“为什么压缩”：user_requested=用户主动；context_limit=上下文上限；
// model_downshift=模型降档导致窗口变小；provider_overflow=provider 实际溢出。
// 缺省时由 trigger 映射（defaultCompactReasonForTrigger），不在此处推导。
export const CompactReason = {
  UserRequested: "user_requested",
  ContextLimit: "context_limit",
  ModelDownshift: "model_downshift",
  ProviderOverflow: "provider_overflow",
} as const;

// CompactReason 的取值联合。
export type CompactReason = (typeof CompactReason)[keyof typeof CompactReason];

// compact 业务阶段：started → boundary_created → summary_created → completed / failed。
// 这是“一次压缩操作”的内部进度，区别于下面 UI 时间线的展示状态；
// 两者不能混用，持久化的 part 记录的是 timelineStatus 而非本枚举。
export const CompactStatus = {
  Started: "started",
  BoundaryCreated: "boundary_created",
  SummaryCreated: "summary_created",
  Completed: "completed",
  Failed: "failed",
} as const;

// CompactStatus 的取值联合。
export type CompactStatus = (typeof CompactStatus)[keyof typeof CompactStatus];

// UI 时间线的展示状态，是持久化在 compaction part 上的终态口径。
// started/retrying 是“进行中”；skipped/completed/failed/interrupted 是终态。
// 冷恢复只允许把 started/retrying 收敛为 completed 或 interrupted，
// 不得改写已有终态（否则会覆盖真实结果）；取消必须落 interrupted 而不是 failed。
export const CompactTimelineStatus = {
  Started: "started",
  Retrying: "retrying",
  Skipped: "skipped",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;

// CompactTimelineStatus 的取值联合；事件与持久化两侧共用同一组字面量。
export type CompactTimelineStatus =
  (typeof CompactTimelineStatus)[keyof typeof CompactTimelineStatus];

// 时间线条目的展示形态；当前只有分隔线一种，schema 中作为 literal 固定。
export const CompactTimelineDisplay = {
  Separator: "separator",
} as const;

// CompactTimelineDisplay 的取值联合。
export type CompactTimelineDisplay =
  (typeof CompactTimelineDisplay)[keyof typeof CompactTimelineDisplay];

// 失败原因码，写入时间线供 UI/排障区分失败路径；不是给用户看的文案。
// not_enough_messages=历史不足；prompt_too_long=摘要请求超窗且缩输入失败；
// no_summary=模型未产出可用摘要；api_error=provider 错误；cancelled=用户中断；
// hook_failed=压缩相关 hook 失败；relink_failed=压缩后重新关联失败；unknown=兜底。
// 消费端按码分支，禁止依赖 reason 文本（文本会变）。
export const CompactFailureReason = {
  NotEnoughMessages: "not_enough_messages",
  PromptTooLong: "prompt_too_long",
  NoSummary: "no_summary",
  ApiError: "api_error",
  Cancelled: "cancelled",
  HookFailed: "hook_failed",
  RelinkFailed: "relink_failed",
  Unknown: "unknown",
} as const;

// CompactFailureReason 的取值联合。
export type CompactFailureReason = (typeof CompactFailureReason)[keyof typeof CompactFailureReason];

// 时间线 payload 的写入/读回 schema，strict 表示未知字段一律拒绝。
// 同一 operation 会随状态推进被反复重写，因此除 status/display 外的字段全部 optional：
// 持久化侧只搬运显式给出的字段，未给出的不能写成 undefined，否则会丢失前序事实。
// sourceCommandId 是可选的幂等回链键（来自 /compact 的 command id），用于 ACK/重放定位；
// tailStartMessageId 与 boundary 的 lastSummarizedMessageId 同源，live/cold edit 判定必须一致。
const compactTimelinePayloadInputSchema = z
  .object({
    operationId: z.string().min(1),
    messageId: z.string().min(1),
    partId: z.string().min(1).optional(),
    status: z.enum([
      CompactTimelineStatus.Started,
      CompactTimelineStatus.Retrying,
      CompactTimelineStatus.Skipped,
      CompactTimelineStatus.Completed,
      CompactTimelineStatus.Failed,
      CompactTimelineStatus.Interrupted,
    ]),
    trigger: z.enum([
      CompactTrigger.Manual,
      CompactTrigger.Auto,
      CompactTrigger.Partial,
      CompactTrigger.Reactive,
      CompactTrigger.SessionMemory,
    ]),
    phase: z
      .enum([
        CompactPhase.StandaloneTurn,
        CompactPhase.PreRequest,
        CompactPhase.MidTurn,
        CompactPhase.Reactive,
      ])
      .optional(),
    compactReason: z
      .enum([
        CompactReason.UserRequested,
        CompactReason.ContextLimit,
        CompactReason.ModelDownshift,
        CompactReason.ProviderOverflow,
      ])
      .optional(),
    display: z.literal(CompactTimelineDisplay.Separator).default(CompactTimelineDisplay.Separator),
    text: z.string().min(1).optional(),
    replace: z.boolean().optional(),
    reason: z.string().min(1).optional(),
    boundaryId: z.string().min(1).optional(),
    summaryMessageId: z.string().min(1).optional(),
    // compact 覆盖前缀的最后一条 transcript message；live/cold edit 判定必须同源。
    tailStartMessageId: z.string().min(1).optional(),
    sourceCommandId: z.string().min(1).optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

// 旧版本把分隔线文案写在 text 字段；transform 主动丢弃它，
// 让新 payload 不再把展示文案当作事实持久化，同时保证旧事件读回不因多出字段而失败。
export const compactTimelinePayloadSchema = compactTimelinePayloadInputSchema.transform(
  ({ text: _legacyText, ...payload }) => payload,
);

// 对外的强类型视图：把 schema 里的 string 收窄为品牌化的 MessageId/PartId。
// 品牌类型只在编译期生效，运行时仍是同一份 payload，不额外包装。
export type CompactTimelinePayload = Omit<
  z.infer<typeof compactTimelinePayloadSchema>,
  "messageId" | "partId" | "summaryMessageId" | "tailStartMessageId"
> & {
  messageId: MessageId;
  partId?: PartId;
  summaryMessageId?: MessageId;
  tailStartMessageId?: MessageId;
};

// 时间线 payload 的读回入口（事件重放、冷恢复、V4 transcript hydration 均由此进入）。
// 校验失败直接抛错：损坏的时间线宁可中断读取，也不能被猜测补全后展示成“压缩成功”。
export function parseCompactTimelinePayload(input: unknown): CompactTimelinePayload {
  return compactTimelinePayloadSchema.parse(input) as CompactTimelinePayload;
}

// 保留区间在 SessionStore 真实消息上的坐标：head→tail 是原样保留的消息范围，
// anchor 是插入保留段落的前一条消息（作为锚点对齐插入位置）。
// 三者都是数据库里真实存在的 MessageId，恢复时必须能回查；不能记录 runtime 条数。
export const compactPreservedSegmentSchema = z
  .object({
    headMessageId: z.string().min(1),
    anchorMessageId: z.string().min(1),
    tailMessageId: z.string().min(1),
  })
  .strict();

// 保留区间的强类型视图；恢复、编辑判定与 rewind 都读同一组指针，
// 三者不一致时视为数据损坏，不允许部分回退。
export type CompactPreservedSegment = {
  headMessageId: MessageId;
  anchorMessageId: MessageId;
  tailMessageId: MessageId;
};

// 压缩边界（历史分界线）的权威 schema，一次压缩只产生一个 boundary。
// 逐字段口径：
// - boundaryId：生产端由 createCompactBoundaryId() 生成；UI 去重、恢复、事件关联都按它，
//   同一 operation 重写必须复用，不能每步重新生成。
// - trigger/phase/compactReason：谁触发、turn 哪个时点、为什么压缩；后两者对旧事件可缺省。
// - summarySource：model=模型生成摘要，session_memory=会话记忆派生的摘要。
// - preCompactTokenCount：压缩前按 provider 渲染估算的入口占用（必填）。
//   postCompactTokenCount：summary 请求的 provider usage 总量；
//   truePostCompactTokenCount：压缩后新历史（摘要+保留轮次+reminder）的本地估算。
//   三者口径不同，展示/策略分别取用，禁止互相替代。
// - autoCompactThreshold/willRetriggerNextTurn：仅 auto 路径携带；后者表示压缩后真实占用
//   仍 >= 阈值，下一轮会立刻再次触发，供策略层与 UI 提前提示。
// - summarizedMessageCount：真正进入摘要的消息数（不含 context prefix）；
//   keptMessageCount：原样保留的消息数，仅当保留了最近轮次时才记录。
// - lastSummarizedMessageId：被摘要覆盖到的最后一条 transcript message（必填于 timeline 的
//   tailStartMessageId），保留段推送必须与它同源。
// - preservedSegment：保留区间在 SessionStore 真实消息上的首尾/锚点；无 store 时缺省。
// - summaryMessageIds：摘要消息 id 列表，default([]) 兼容旧 payload 缺字段；
//   attachmentMessageIds/hookResultMessageIds 记录随压缩重建的附件与 hook 结果 id。
// - preCompactDiscoveredTools：压缩前已发现的延迟工具名，避免压缩后被重新公告为待加载。
// - customInstructions：只记录“用户是否附加了自定义指令”的布尔值，不保存指令正文。
// - traceId 必填 + turnId/spanId/parentSpanId 可选：保证压缩可归因到同一条调用链。
export const compactBoundaryPayloadSchema = z
  .object({
    boundaryId: z.string().min(1),
    trigger: z.enum([
      CompactTrigger.Manual,
      CompactTrigger.Auto,
      CompactTrigger.Partial,
      CompactTrigger.Reactive,
      CompactTrigger.SessionMemory,
    ]),
    phase: z
      .enum([
        CompactPhase.StandaloneTurn,
        CompactPhase.PreRequest,
        CompactPhase.MidTurn,
        CompactPhase.Reactive,
      ])
      .optional(),
    compactReason: z
      .enum([
        CompactReason.UserRequested,
        CompactReason.ContextLimit,
        CompactReason.ModelDownshift,
        CompactReason.ProviderOverflow,
      ])
      .optional(),
    summarySource: z.enum(["model", "session_memory"]).optional(),
    preCompactTokenCount: z.number().int().nonnegative(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
    autoCompactThreshold: z.number().int().nonnegative().optional(),
    willRetriggerNextTurn: z.boolean().optional(),
    summarizedMessageCount: z.number().int().nonnegative(),
    keptMessageCount: z.number().int().nonnegative().optional(),
    lastSummarizedMessageId: z.string().min(1).optional(),
    preservedSegment: compactPreservedSegmentSchema.optional(),
    summaryMessageIds: z.array(z.string().min(1)).default([]),
    attachmentMessageIds: z.array(z.string().min(1)).optional(),
    hookResultMessageIds: z.array(z.string().min(1)).optional(),
    preCompactDiscoveredTools: z.array(z.string().min(1)).optional(),
    customInstructions: z.boolean().optional(),
    traceId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
    parentSpanId: z.string().min(1).optional(),
  })
  .strict();

// 边界 payload 的强类型视图：只把 id 类字段收窄为品牌类型，其余数值/布尔保持原样。
// 该类型同时用于内存条目、SQLite compaction part 与 SessionEvent payload，三者字段必须一致。
export type CompactBoundaryPayload = Omit<
  z.infer<typeof compactBoundaryPayloadSchema>,
  "lastSummarizedMessageId" | "preservedSegment" | "summaryMessageIds" | "traceId" | "turnId"
> & {
  lastSummarizedMessageId?: MessageId;
  preservedSegment?: CompactPreservedSegment;
  summaryMessageIds: MessageId[];
  traceId: TraceId;
  turnId?: TurnId;
};

// 本地裁剪（不调用模型）的边界事实，只描述清掉了哪些工具结果、省了多少 token。
// cleared/keptToolCallIds 是工具调用维度而非消息维度；tokensSaved 为前后估算差值。
// 与 CompactBoundaryPayload 互不替代：microcompact 不改写历史分界，只清空旧工具结果正文，
// 因此没有 boundaryId/summarizedMessageCount 这类“摘要”字段。
export const microcompactBoundaryPayloadSchema = z
  .object({
    trigger: z.enum([MicrocompactTrigger.TimeBased, MicrocompactTrigger.TokenPressure]),
    strategy: z.enum([MicrocompactStrategy.LocalToolResultClear]),
    preMicrocompactTokenCount: z.number().int().nonnegative(),
    postMicrocompactTokenCount: z.number().int().nonnegative(),
    tokensSaved: z.number().int().nonnegative(),
    clearedToolCallIds: z.array(z.string().min(1)),
    keptToolCallIds: z.array(z.string().min(1)),
    clearedMessageCount: z.number().int().nonnegative(),
    traceId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  })
  .strict();

// microcompact 边界的强类型视图；工具调用 id 与 trace 字段在编译期被品牌化。
export type MicrocompactBoundaryPayload = Omit<
  z.infer<typeof microcompactBoundaryPayloadSchema>,
  "clearedToolCallIds" | "keptToolCallIds" | "traceId" | "turnId"
> & {
  clearedToolCallIds: ToolCallId[];
  keptToolCallIds: ToolCallId[];
  traceId: TraceId;
  turnId?: TurnId;
};

// 摘要正文与它所属边界的关联载荷（CompactSummary 事件/通知使用）。
// summaryMessageId 必须指向真实落库的 summary 消息；source 与 boundary.summarySource 同口径，
// 不能出现“boundary 说是 model、摘要却来自 session_memory”的分裂事实。
export interface CompactSummaryPayload {
  boundaryId: string;
  summary: string;
  summaryMessageId: MessageId;
  source: "model" | "session_memory";
}

// 投影层（UI/协议快照）使用的压缩摘要视图：由 boundary 派生，不单独持久化。
// compactedAt 仅供展示，真实时间事实在 boundary/timeline 的 startedAt/endedAt；
// token 与计数口径必须与 boundary 保持一致，避免两处展示对不上。
export interface CompactProjectionInfo {
  boundaryId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  compactedAt: Date;
  preCompactTokenCount: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  summarizedMessageCount: number;
  keptMessageCount?: number;
  willRetriggerNextTurn?: boolean;
}

// 通用上下文条目形状：id 加可选的 boundary / “是否压缩摘要”标记。
// 内存条目与持久化 message part 共用此形状，边界扫描（isCompactBoundaryItem）不假设其他字段。
export interface CompactContextItem {
  id: string;
  compactBoundary?: CompactBoundaryPayload;
  isCompactSummary?: boolean;
}

// 压缩后新上下文的组装输入，字段顺序即最终顺序（见 buildPostCompactItems）：
// boundary 标记 → 摘要消息 → 保留消息 → 附件 → hook 结果。
// 调用方只提供数组，不决定顺序；顺序本身是 provider 可见语义，不能随意调整。
export interface CompactPostContext<T> {
  boundaryMarker: T;
  summaryMessages: readonly T[];
  messagesToKeep?: readonly T[];
  attachments?: readonly T[];
  hookResults?: readonly T[];
}

// 从事件/持久化 JSON 读回 boundary 的唯一入口（rewind、V4 投影、冷恢复共用）。
// 为什么要兼容旧事件：早期写入的 payload 没有 phase/compactReason/summaryMessageIds
// 等后加字段，schema 因此把前两者设为 optional、把 summaryMessageIds 设为 default([])；
// 若收紧成必填，历史会话的压缩事件会整段读不出来。
// 校验失败必须抛错而不是猜补全：boundary 决定“从哪里续接”，猜错会让模型看到错误历史。
export function parseCompactBoundaryPayload(input: unknown): CompactBoundaryPayload {
  return compactBoundaryPayloadSchema.parse(input) as CompactBoundaryPayload;
}

// microcompact 边界的读回入口；同样在读取侧做完整校验，不使用宽松断言。
export function parseMicrocompactBoundaryPayload(input: unknown): MicrocompactBoundaryPayload {
  return microcompactBoundaryPayloadSchema.parse(input) as MicrocompactBoundaryPayload;
}

// 类型收窄：只有通过完整 schema 校验的条目才算压缩边界。
// 不能只判断 compactBoundary 字段是否存在——损坏或半写入的 payload 必须判为 false，
// 否则 rewind/投影会把非边界条目当成续接起点。
export function isCompactBoundaryItem(item: unknown): item is CompactContextItem & {
  compactBoundary: CompactBoundaryPayload;
} {
  if (typeof item !== "object" || item === null || !("compactBoundary" in item)) {
    return false;
  }

  const boundary = (item as { compactBoundary?: unknown }).compactBoundary;
  return compactBoundaryPayloadSchema.safeParse(boundary).success;
}

// 按固定顺序展开压缩后的条目；入参数组被视为只读，这里只做浅展开复制。
// 顺序（标记→摘要→保留→附件→hook）是 provider 可见语义，调用点不得重排。
export function buildPostCompactItems<T>(postContext: CompactPostContext<T>): T[] {
  return [
    postContext.boundaryMarker,
    ...postContext.summaryMessages,
    ...(postContext.messagesToKeep ?? []),
    ...(postContext.attachments ?? []),
    ...(postContext.hookResults ?? []),
  ];
}

// 截取“最后一条 boundary 及其之后”的条目（包含 boundary 本身）。
// rewind 与投影依赖这个含边界的语义定位活动链；不能改成 slice(boundaryIndex + 1)。
// 找不到 boundary 时返回全部条目的副本，表示从未压缩过的会话。
export function getItemsAfterLastCompactBoundary<T>(
  items: readonly T[],
  isBoundary: (item: T) => boolean = (item) => isCompactBoundaryItem(item),
): T[] {
  const boundaryIndex = items.findLastIndex(isBoundary);
  if (boundaryIndex < 0) {
    return [...items];
  }
  return items.slice(boundaryIndex);
}

// 给已存在 boundary 的条目补写 preservedSegment，返回新对象、不修改原对象。
// 条目没有 compactBoundary 时抛错：说明调用方把保留段指针挂到了错误的对象上，
// 静默丢弃会让恢复阶段丢失保留区间，因此必须显式失败。
export function annotateBoundaryWithPreservedSegment<T extends CompactContextItem>(
  boundary: T,
  preservedSegment: CompactPreservedSegment,
): T {
  if (!boundary.compactBoundary) {
    throw new Error("Cannot annotate a compact boundary on an item without compactBoundary");
  }

  return {
    ...boundary,
    compactBoundary: {
      ...boundary.compactBoundary,
      preservedSegment,
    },
  };
}
