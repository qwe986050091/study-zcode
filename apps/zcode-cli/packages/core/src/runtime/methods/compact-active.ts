/**
 * ============================================================================
 * compact-active.ts —— 活动会话的上下文压缩(compact)核心实现
 * ============================================================================
 *
 * 【这个文件解决什么问题】
 * 模型的上下文窗口有限。当会话历史(activeEntries)累积到接近/超过上限时,
 * 需要发起一次模型调用,把"较早的对话轮次"压缩成一段结构化的摘要(summary),
 * 然后把运行时历史整体替换为:
 *
 *   [context prefix(系统提示/技能清单等)] → [摘要消息] → [保留的最近轮次] → [压缩后提醒]
 *
 * 这样既腾出了 token 空间,又通过"摘要 + 保留最近原文 + 文件/工具提醒"维持住模型的连续性。
 *
 * 【与 microcompact 的区别】
 * microcompact(见 microcompact.ts)是纯本地的裁剪(清理旧工具结果等),不调用模型;
 * 本文件是 "active" compact:会真实发起一次 provider 请求生成摘要,
 * customInstructions 可以让用户在压缩时附加额外要求。
 *
 * 【内部分层】
 * compactActiveConversation          外层薄包装:只负责 telemetry 生命周期与完成/失败/取消上报
 *   └─ compactActiveConversationImpl  真正的压缩流程:
 *        ① 决策:归一化 trigger/phase/reason,确定模型,切分"要摘要的历史"与"要保留的最近轮次"
 *        ② 生成摘要:循环调用模型;按 prompt-too-long / media-too-large 分支出不同的降输入重试
 *        ③ 收尾:重建压缩后提醒 → 构造 boundary → 持久化摘要 → 发送事件
 *        ④ 替换内存历史:更新 latestConversationMessageId,整体替换 messageHistory,清理读取态/记忆缓存
 *
 * 【trigger 语义】(取值见 contracts/compact)
 *   manual         用户显式 /compact;单次尝试,默认不保留最近轮次(全部摘要)
 *   auto           请求前因 token 阈值触发;最多 3 次外层尝试,保留最近 1 个 assistant 轮次
 *   reactive       真实 provider 溢出后补救;保留最近轮次,单次
 *   partial        部分压缩;单次
 *   session_memory 由会话记忆派生的摘要;单次
 *   (是否保留最近轮次由 selectCompactEntries 内部按 trigger 决定,详见 helpers/compact-selection.ts)
 *
 * 【时间线事件】
 *   CompactStarted → (Retrying...) → CompactCompleted / CompactFailed(取消时为 Interrupted)
 *   另外还有 ModelRequest / ModelComplete / CompactBoundary 事件。
 *   所有 timeline payload 共用同一个 operationId / messageId / partId,
 *   并通过 replace:true 让 UI 就地更新同一条时间线,而不是每步新增一行。
 * ============================================================================
 */
import { TOOL_SEARCH_NAME, type ModelToolContract } from "@zcode/contracts";
import { buildToolSearchAnnouncement, buildToolExposure } from "../../tool/search/exposure.js";
import { prepareRuntimeProviderRequest } from "../helpers/runtime-provider-request-messages.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../../tool/search/history.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  SessionEventType,
  createChildTraceContext,
  isCoreError,
  createMessageId,
  createPartId,
  traceContextToLogContext,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  getUsageTotalTokens,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  buildPostCompactReadStateReminderEntries,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

// auto compact 的外层最多尝试次数。仅应对瞬时故障(网络/5xx 等);
// 非 auto trigger 的 maxAttempts 恒为 1,不做外层重试。
// 注意:内层还有针对 prompt-too-long 的输入缩减重试,两层次数不能混算(见 createCompactPromptTooLongError)。
const AUTO_COMPACT_MAX_ATTEMPTS = 3;

// 当 ToolSearch 实际不可启用、退回"普通工具"策略时,压缩请求最多携带的工具数量。
// 超过该数量说明 MCP schema 会再次撑大请求,此时宁可一个工具都不带(见下方 fallback 分支)。
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

/**
 * 对外入口:对"当前活动会话"执行一次上下文压缩。
 *
 * 这是一个以 `this: AgentRuntimeInternal` 绑定的方法(通过 methods/index.ts 挂到 runtime 原型上),
 * 它本身不实现压缩算法,只做三件事:
 *   1. 归一化 trigger / phase,建立 compaction telemetry span;
 *   2. 调用 compactActiveConversationImpl 执行真正的压缩;
 *   3. 按结果上报 telemetry(completed / cancelled / failed),并把错误原样抛回调用方。
 *
 * @param customInstructions 用户在压缩时附加的额外要求(例如 "/compact 重点保留 API 设计"),
 *                           会被拼接进 summary prompt;undefined 表示使用内置 prompt。
 * @param turnTraceContext   本次 turn 的 trace 上下文;timeline / boundary 事件都会沿用。
 * @param events             本轮 turn 已产生的事件数组;新增事件会 push 进来供上层/UI/持久化消费。
 * @param options            可选参数,字段含义见下方对象内的注释。
 *
 * @returns
 *   displayText 给用户看的完成文案:"Compacted" / "Context is up to date; no compression needed"
 *   entries     压缩后的运行时消息条目(跳过压缩时原样返回当前历史)
 *   outcome     "compacted" 表示真的替换了历史;"skipped" 表示历史太少/刚压缩过,没做事
 *   tokenCount  压缩后 token 数,优先使用 provider 上报的 usage 总量
 */
export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    /** 取消信号;压缩流程中每个耗时阶段都会检查,用户中断时用于区分"取消"与"失败" */
    abortSignal?: AbortSignal;
    /**
     * 来自策略层的上下文占用信息,只用于 telemetry,不参与压缩选择:
     * - Auto:复用 auto compact 策略决策时算出的占用;
     * - Reactive:复用 provider overflow 路径上的 activeMessages 统计;
     * - 其他 trigger:不传,避免重复投影。
     */
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    /** auto compact 的触发阈值;写入 boundary,用于判断"压缩后是否仍会立刻再次触发" */
    autoCompactThreshold?: number;
    /** 压缩原因(用户请求/上下文上限/模型降档/provider 溢出);缺省由 trigger 推导 */
    compactReason?: CompactReason;
    /** 若本次压缩是由"首次请求就 prompt too long"引起,传入原始错误:会据此按 token gap 多保留最近轮次 */
    initialPromptTooLongCause?: unknown;
    /** 压缩发生在 turn 的哪个阶段;缺省由 trigger 推导 */
    phase?: CompactPhase;
    /** 发起 /compact 的 command id,写入时间线用于回链 */
    sourceCommandId?: string;
    /** 触发来源;缺省 Manual */
    trigger?: CompactTrigger;
    /** 指定使用的模型(如模型降档后的目标模型);缺省按 session 选择新建 runtime model */
    model?: Model;
    /** 覆盖重建 agent 列表提醒时使用的工具集合;缺省用当前模型可用工具 */
    agentListingTools?: readonly { name: string }[];
    /** 显式的历史快照(turn-local 作用域);缺省从 messageHistory 借只读快照 */
    activeEntries?: readonly RuntimeMessageEntry[];
    /** 压缩后"继续执行"作用域下可用的工具;用于重建 ToolSearch 公告(区别于压缩候选的精简工具集) */
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  /** 面向用户的完成提示 */
  displayText: string;
  /** 压缩后的运行时消息条目(含摘要、保留轮次与提醒);skipped 时为原始历史 */
  entries: readonly RuntimeMessageEntry[];
  /** compacted = 历史已被替换;skipped = 历史不足,未执行压缩 */
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  /** 压缩后 token 数(provider usage 总量;skipped 时为压缩前估算) */
  tokenCount: number;
}> {
  // 1) 归一化触发来源与阶段:
  //    trigger 决定"谁"发起压缩(手动 / 自动阈值 / 溢出补救 ...),
  //    phase 描述压缩发生在 turn 的哪个时点;两者都会进入日志、时间线与 boundary。
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  // 2) 开启 compaction telemetry span:
  //    维度包括 trigger / phase / 最大尝试次数 / 是否流式 / 策略上下文窗口 / 阈值 / token 来源。
  //    稍后用 setInputTokens / setOutputTokens / finishXxx 填充结果。
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    // 这个 inputTokens 已经是"触发压缩时"看到的上下文占用,直接作为 telemetry 输入侧指标。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  // 3) telemetry.run 负责把整个异步压缩过程包成一个 span;其返回值原样透传给调用方。
  return compactTelemetry.run(async () => {
    try {
      // 真正的压缩逻辑在 impl 里;这里通过 .call 保持 `this` 绑定。
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      // 成功:输出侧 token 取返回的 tokenCount(compacted 时通常是 provider usage 总量)。
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      // 取消与失败要区分上报,但两种情况下都把原始 error 继续抛给上层:
      // turn loop 需要知道是"用户中断"(终止 turn)还是"压缩失败"(可能触发 reactive compact 等)。
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

/**
 * 压缩流程的真正实现。整体分为四个阶段:
 *
 *   ① 决策
 *      - 归一化 trigger / phase / compactReason,确定 summary 使用的模型;
 *      - 按 trigger 切分历史:哪些轮次进入摘要(entriesForSummary),哪些最近轮次原样保留;
 *      - 估算压缩前 token;历史不足(见 hasEnoughRuntimeEntriesToCompact)时直接 skipped。
 *
 *   ② 生成摘要(内层 while)
 *      - 组装 provider 请求并调用模型;prompt-too-long 时优先"多保留最近轮次"收缩输入,
 *        非 auto/reactive 还允许"丢弃更老轮次";媒体过大时剥掉媒体后重试一次;
 *      - 兼容 provider 以 finishReason 返回超窗(而不是抛异常)的情况。
 *
 *   ③ 收尾
 *      - 解析摘要文本(模型若返回 tool call 会被拒绝);
 *      - 重建压缩后提醒(agent 列表 / 计划文件 / 文件读取态 / ToolSearch 公告);
 *      - 构造 compact boundary 与摘要消息,先原子持久化,再发 CompactBoundary / CompactCompleted 事件。
 *
 *   ④ 替换内存历史
 *      - latestConversationMessageId 指向摘要消息,messageHistory 替换为压缩后的条目;
 *      - 清空 readFileState 与项目记忆 recall 缓存,返回 compacted 结果。
 *
 * 外层 while 是"自动压缩的外层尝试"(仅 auto trigger 最多 AUTO_COMPACT_MAX_ATTEMPTS 次);
 * 内层 while 是"单次尝试内针对输入过长/媒体过大的收缩重试",两者层次不同,不要混淆。
 *
 * 参数与返回值含义与 compactActiveConversation 完全一致(该方法只是加了 telemetry 包装),
 * 故 options 字段不在此重复注释。
 */
async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  // 压缩是可被用户取消的长流程:进入任何实质工作前先检查一次取消信号。
  throwIfTurnAborted(options.abortSignal);
  // trigger:谁触发压缩;缺省当作手动 /compact。
  const trigger = options.trigger ?? CompactTrigger.Manual;
  // phase:压缩发生在 turn 的哪个时点(独立 turn / 请求前 / 中途 / 溢出补救);缺省由 trigger 映射。
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  // compactReason:面向 UI/统计的"为什么压缩"(用户请求 / 上下文上限 / 模型降档 / provider 溢出)。
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  // 摘要模型:调用方可指定(例如降档后的目标模型),否则按当前会话选择的模型创建 runtime model。
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // 模型自身允许的最大输出 token。注意:该变量在当前实现中未被后续代码使用,
  // 属于历史遗留的悬空变量;真正的 summary 输出上限由 capCompactSummaryMaxOutputTokens 计算。
  const executionMaxOutputTokens = compactModel.optionSpecs.maxOutputTokens.max;
  // 取历史条目的"浅快照":数组本身是新建的,但元素仍是对共享 RuntimeMessageEntry 的引用。
  // 前提是 RuntimeMessageEntry 约定不可变 —— selection 阶段会 clone,provider 渲染与最终替换
  // 都会构造各自拥有的副本;禁止在 compact 期间原地修改 activeEntries 内的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  // 是否把 system 消息放在对话中间(部分模型原生支持,或配置强制开启)。
  // 该开关会影响 token 估算方式与 provider 消息渲染方式,因此后续所有估算都要带上它。
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  // 首次切分:决定"哪些条目进入摘要"与"哪些最近条目原样保留"。
  // - Auto / Reactive:保留最近 1 个 assistant 起始的轮次(group),其余全部摘要;
  // - Manual 等:默认不保留最近轮次(全部摘要),只保留 metadata 标记的 context prefix;
  // - 若本次压缩源于"首次请求就 prompt too long",会改用 token-gap 感知的切分:
  //   根据错误里的 actual > limit 差额,多保留足够覆盖该差额的最近轮次,让 summary 请求更小。
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  // currentSelection 会随 prompt-too-long 的降输入重试而更新(可能保留更多最近轮次)。
  let currentSelection = initialSelection;
  // 需要在压缩后原样保留的最近条目(可能为空);它们不经摘要,直接进入新历史。
  let preservedEntries = currentSelection.preservedEntries;
  // 第一次尝试的摘要输入快照;外层 auto 重试时用它把状态重置回初始切分。
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  // 本次实际发给 summary 模型的历史(可能因重试而收缩)。
  let entriesForSummary = initialEntriesForSummary;
  // 从摘要输入中剔除 context prefix 后的"真正被摘要"的条目,主要用于 boundary 的统计字段。
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  // 压缩前 token 估算:按 provider 实际渲染后的消息估算,用于事件/时间线/boundary 展示。
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  // 外层尝试次数:auto 允许最多 3 次(应对瞬时网络/5xx);其他 trigger 只跑 1 次且不重试。
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  // compactTimeline 是本次压缩"时间线"的公共上下文:
  // - operationId 标识一次压缩操作;
  // - messageId / partId 是 UI 上承载这条时间线的消息/片段;
  // - 后续 Started / Retrying / Skipped / Completed / Failed 全部复用它,
  //   并以 replace:true 就地更新同一行,而不是每一步新增一行。
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  // 压缩门槛:至少要能凑出 2 个"assistant 起始的轮次",且其中包含 assistant 消息,
  // 否则没有足够可压缩的历史(例如会话刚开始,或刚刚压缩过)。
  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    // 记录一条 Skipped 时间线;replace:true 表示就地替换同一条 UI 行。
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      // 明确告诉用户"无需压缩",而不是报错。
      displayText: "Context is up to date; no compression needed",
      // 历史原封不动返回。
      entries: activeEntries,
      // 让调用方区分"压缩成功"与"没做事"(决定后续 UI/统计分支)。
      outcome: "skipped",
      // token 统计保持压缩前的估算值。
      tokenCount: preCompactTokenCount,
    };
  }

  // 只有真正开始压缩后才发送 Started 事件;attempt/maxAttempts 仅在可重试(>1)时才展示。
  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  // 压缩模型可能持有 MCP 工具,先确保 MCP 客户端已初始化完成。
  await this.initializeMcp(turnTraceContext);
  // MCP 初始化可能耗时,再做一次取消检查。
  throwIfTurnAborted(options.abortSignal);
  // 压缩请求可用的工具集合。不会把全部工具都带给 summary 模型,只保留:
  //   Read                          —— 允许摘要模型读取文件(需要精确引用代码时)
  //   ToolSearch / DeferredToolCall —— 延迟工具发现机制本身
  //   registry 中带 mcpPresentation 的工具 —— 由 ToolSearch 按需暴露的 MCP 工具
  // 这样可以显著减小 summary 请求的 schema 体积(工具定义本身也占 token)。
  // 其余工具(Bash/Edit/Agent 等)对"总结已有对话"没有价值,带上只会挤占输入窗口。
  const runtimeCompactTools = this.getTools(compactModel);
  const registry = this.getToolRegistry();
  let compactCandidates = runtimeCompactTools.filter(
    (tool) =>
      tool.name === "Read" ||
      tool.name === TOOL_SEARCH_NAME ||
      tool.name === "DeferredToolCall" ||
      registry.get(tool.name)?.metadata.mcpPresentation,
  );
  // Bug 根因：只看 provider 能力会在 ToolSearch 被禁用或全部常驻时绕过数量保护，
  // 让大量 MCP schema 再次撑大压缩请求；实际不可启用时恢复原普通工具策略。
  if (
    !buildToolExposure({
      model: compactModel,
      mode: this.config.toolSearch?.mode,
      tools: compactCandidates,
      registry,
      entries: [],
    }).enabled
  ) {
    // ToolSearch 实际不可启用 → 退回"普通工具"策略:去掉搜索/延迟调用占位工具;
    // 但如果剩余工具数超过上限(会重新造成 schema 膨胀),就干脆一个工具都不带。
    compactCandidates = runtimeCompactTools.filter(
      (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== "DeferredToolCall",
    );
    if (compactCandidates.length > COMPACT_TOOL_KEEP_MAX_COUNT) compactCandidates = [];
  }

  // 外层重试循环:每次迭代 = 一次完整的"压缩尝试"(attempt)。
  // 只有 auto trigger 在同一次 operation 内失败且 error 可重试时,才会回到这里(见文件末尾 catch)。
  while (true) {
    try {
      // 记录"被摘要部分"的终点消息 id:boundary 的 tailStartMessageId 与
      // CompactCompleted 时间线都用它表达"本次压缩覆盖到哪条消息为止"。
      const lastSummarizedMessageId = this.latestConversationMessageId;
      // 为 summary 调用建立子 trace:标注实际模型与 querySource=compact,
      // 便于 provider 日志/用量统计与主 turn 的请求区分开。
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      // 压缩指令:内置 summary prompt +(可选)用户 customInstructions。
      const compactPrompt = buildCompactPrompt(customInstructions);
      let result: RuntimeModelTextResult;
      // 本次尝试内因 prompt too long 而重跑的次数(写入 ModelRequest 事件,便于排障)。
      let compactPromptTooLongAttempts = 0;
      // 是否已因"媒体过大"而剥掉请求中的媒体;每个尝试只允许触发一次该降级。
      let stripMediaForSummary = false;
      // 降输入策略一:重新切分,把更多"最近的轮次"留在原文中(不塞进摘要请求),
      // 从而缩小 summary 请求本身。由错误中的 token 差额驱动;返回 false 表示无法再保留更多。
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      // 降输入策略二:直接丢掉更老的轮次(并插入回填标记)。仅非 auto/reactive 的 trigger 允许,
      // 避免自动路径在用户无感知时静默丢弃历史;内部还受 MAX_COMPACT_PROMPT_TOO_LONG_RETRIES 限制。
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      // 内层循环:同一个 attempt 内,针对"输入过长/媒体过大"反复收缩请求后重试,直到拿到可用结果。
      while (true) {
        // 组装 provider 请求:
        //   tools   = 上一步筛过的压缩候选工具;
        //   entries = 要摘要的历史,末尾追加 compactPrompt(作为最后一条 user 消息);
        //   applyCacheControl=true : 历史前缀通常可命中缓存,降低成本;
        //   skipCacheWrite=true    : 压缩是旁路请求,不要为它写入缓存。
        const prepared = prepareRuntimeProviderRequest(this, {
          model: compactModel,
          tools: compactCandidates,
          registry,
          entries: entriesForSummary,
          prompt: compactPrompt,
          applyCacheControl: true,
          skipCacheWrite: true,
        });
        const requestMessages = prepared.request.messages;
        // 过滤 query-local 的"输出上限续写(Continue)"提示:它们不属于会话内容,
        // 既不应持久化进轨迹,也不应被压缩进摘要。若过滤改变了条目集合,
        // 需要基于过滤后的条目重新渲染一份消息数组,供事件记录使用(与下面 provider 请求保持结构对应)。
        const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
        const recordableRequestMessages =
          recordableEntries === prepared.entries
            ? requestMessages
            : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
                useMidConversationSystem,
                loadedToolCallIds: prepared.loadedToolCallIds,
              });
        // 媒体投影(1/2):能力投影。按模型的 inputFormat 把不支持的媒体做归一化/替换,
        // 并输出日志,便于排查"为什么某张图片被换成了占位文本"。
        // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
        // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
        const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
          requestMessages,
          compactModel.properties.inputFormat,
        );
        logMediaCapabilityProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.capabilityProjection,
          {
            event: "compact.request.media_capability_projection",
            message: "Compact request media capability projection",
            model: `${compactModel.providerId}/${compactModel.modelId}`,
          },
        );
        // 媒体投影(2/2):预算投影。对整段请求的媒体按 token 预算裁剪(单条/总量),
        // 避免一次压缩请求因大量图片/附件超过全局请求上限。
        logMediaBudgetProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.mediaBudgetProjection,
          {
            event: "compact.request.media_projection",
            message: "Compact request media budget projection",
          },
        );
        // 真正发给 provider 的消息(经过能力投影 + 预算投影)。
        let projectedRequestMessages = mediaPolicyProjection.messages;
        // 事件可记录副本:若之前因过滤 Continue 重渲染过,需要对那份数组做同样的媒体投影,
        // 保证事件记录与 provider 请求在媒体处理上保持一致。
        let projectedRecordableMessages =
          recordableRequestMessages === requestMessages
            ? projectedRequestMessages
            : projectMessagesForModelMediaPolicy(
                recordableRequestMessages,
                compactModel.properties.inputFormat,
              ).messages;
        if (stripMediaForSummary) {
          // 上一次尝试被 provider 因媒体过大拒绝:改用更"温和"的媒体剥离策略。
          // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
          const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
          projectedRequestMessages = mediaProjection.messages;
          projectedRecordableMessages =
            recordableRequestMessages === requestMessages
              ? projectedRequestMessages
              : projectCompactMediaForRetry(projectedRecordableMessages).messages;
          logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
        }

        // 发送 ModelRequest 事件。
        // 注意:事件里记录的是"可记录投影"(projectedRecordableMessages),而不是真正发给
        // provider 的完整请求(projectedRequestMessages),原因见下方注释。
        const modelRequestEvent = this.createEvent(
          SessionEventType.ModelRequest,
          {
            // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
            // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
            messages: projectedRecordableMessages,
            providerId: String(compactModel.providerId),
            modelId: String(compactModel.modelId),
            querySource: "compact",
            toolCount: prepared.request.tools.length,
            // 本次尝试内已做过的 prompt-too-long 重试次数(排障用)。
            compactPromptTooLongRetry: compactPromptTooLongAttempts,
          },
          modelTraceContext,
        );
        // 先落库再广播:appendEvent 失败会让本次压缩在"请求已构建、尚未发送"处终止,
        // 不会留下"模型请求已发出、持久化轨迹却缺 ModelRequest"的错位。
        await this.appendEvent(modelRequestEvent, modelTraceContext);
        // 同步进本 turn 的事件数组,供上层流式消费(UI/统计)。
        events.push(modelRequestEvent);
        const modelStartedAt = Date.now();
        // 记录请求开始前的事件下标:用量事实需要知道"本次模型调用"产生了哪些网络事件。
        const networkEventStartIndex = events.length;
        // summary 输出上限 = min(普通请求的 max output 策略, 20K summary 上限, 模型自身上限)。
        const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
        const compactModelRequest = {
          abortSignal: options.abortSignal,
          maxOutputTokens: compactSummaryMaxOutputTokens,
          // 发给 provider 的是完整消息(含 Continue 过滤后的上下文 + compactPrompt)。
          messages: projectedRequestMessages,
          metadata: traceContextToLogContext(modelTraceContext),
          // 标记这是一次 "context_compaction" 调用:带上外层 attempt 与 trigger,
          // 用量/费用统计可按 operationId 归组。
          modelCall: {
            attributes: {
              compactionOuterAttempt: attempt,
              compactionTrigger: trigger,
            },
            operation: "context_compaction" as const,
            operationId: compactTimeline.operationId,
          },
          // 把模型运行状态(重试/首个 token 等)转成 UI 事件。
          statusSink: this.createModelStatusSink(modelTraceContext, events),
          // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
          // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
          preserveProviderStreamBoundaries: true,
          traceContext: modelTraceContext,
          tools: prepared.request.tools,
          toolSearchEnabled: prepared.request.toolSearchEnabled,
          // 每次底层尝试前刷新运行时请求头(如鉴权 token),避免长时间压缩过程中凭证过期。
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
            abortSignal: options.abortSignal,
            model: compactModel,
            traceContext: modelTraceContext,
          }),
        };

        // 内层 try 只包住"一次 provider 调用":失败要区分取消/媒体过大/超窗,
        // 其余错误上抛给外层,由外层按 CoreError.retryable 决定是否换 attempt。
        try {
          // 优先流式获取摘要;内部在 content block 尚未提交的早期失败时,
          // 会安全地降级为非流式 HTTP 请求(runCompactSummaryModelRequest 负责)。
          result = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: compactModelRequest,
          });
        } catch (error) {
          // 先把这次失败调用记成用量事实(status=error/cancelled),统计侧才能区分失败请求。
          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            error,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            startedAt: modelStartedAt,
            status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
            traceContext: modelTraceContext,
          });
          if (isTurnCancellationError(error, options.abortSignal)) {
            // 用户取消:不重试,原样抛出;外层 telemetry 会标记 cancelled。
            throw error;
          }
          if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
            // 媒体过大:剥掉媒体后再试一次(每个 attempt 只允许一次)。
            stripMediaForSummary = true;
            this.logger?.info(
              "Compact summary hit media-size error; retrying with stripped media",
              {
                ...traceContextToLogContext(modelTraceContext),
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "compact.request.media_too_large.retry",
                module: "core.runtime",
              },
            );
            continue;
          }
          if (isModelContextExceededError(error)) {
            // prompt too long:先尝试"多保留最近轮次"来缩小摘要输入;
            if (reselectEntriesAfterPromptTooLong(error)) continue;
            // 再尝试"丢弃更老轮次"(仅 manual/partial/session_memory 可用);
            if (truncateEntriesAfterPromptTooLong(error)) continue;
            // 都失败 → 构造统一的 prompt-too-long 核心错误(标记 retryable:false,
            // 防止外层 auto 重试把"内层 3 次 × 外层 3 次"放大成 9 次无效请求)。
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: error,
              preCompactTokenCount,
            });
          }
          // 其他错误直接抛出,交给外层 catch 判定是否属于 auto 可重试错误。
          throw error;
        }

        // 成功:记录完成态用量事实。toolCallCount 正常应为 0(压缩不允许使用工具);
        // 若不为 0,后面的 formatCompactSummaryOrThrow 会拒绝这次结果。
        await recordModelUsageFact(this, {
          attemptIndex: compactPromptTooLongAttempts,
          events,
          model: compactModel,
          networkEventStartIndex,
          querySource: "compact",
          result,
          startedAt: modelStartedAt,
          status: "completed",
          toolCallCount: this.extractToolCallsFromResult(result).length,
          traceContext: modelTraceContext,
        });
        // 兼容"以 finishReason 返回超窗"的 provider:某些模型不抛异常,而是 finish=overflow。
        const contextError = createCompactContextExceededFinishError(result);
        if (contextError) {
          // compact summary 也可能以 finishReason 返回超窗而不是 throw；
          // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
          if (reselectEntriesAfterPromptTooLong(contextError)) continue;
          if (truncateEntriesAfterPromptTooLong(contextError)) continue;
          throw createCompactPromptTooLongError({
            attempt: compactPromptTooLongAttempts,
            cause: contextError,
            preCompactTokenCount,
          });
        }
        // 拿到有效摘要,退出内层请求重试。
        break;
      }

      // 解析并规范化摘要文本;若模型违反约定返回了 tool call,这里会抛错拒绝
      // (压缩只允许输出纯文本摘要,见 compact-active-helpers.ts)。
      const summary = formatCompactSummaryOrThrow(this, result);
      // 持久化与内存使用同一份文本,避免两处格式化产生差异。
      const persistedSummary = summary;
      // 若本会话已有"已批准的计划文件",重新注入它的引用提醒,
      // 让模型压缩后仍知道计划文件的位置(否则容易丢失任务上下文)。
      const planFileReferenceEntry = this.fileSystemPort
        ? await readApprovedPlanFileReferenceEntry({
            abortSignal: options.abortSignal,
            fileSystemPort: this.fileSystemPort,
            sessionId: this.sessionId,
            traceContext: modelTraceContext,
            workspaceRoot: this.workspaceRoot,
          })
        : undefined;
      // Bug 根因：compact 丢弃旧公告后曾依赖下一次请求补齐，纯 Continue 无正常收集机会。
      // 在取消检查后按保留历史重建，使用继续执行的作用域，不使用摘要候选工具。
      throwIfTurnAborted(options.abortSignal);
      // 收集"压缩前已经发现/加载过"的工具名并写入 boundary,
      // 让压缩后不会把这些工具重新公告为"待加载"。
      const preCompactDiscoveredTools = collectDiscoveredTools(activeEntries);
      const discovery = compactDiscoveryMetadata({
        boundaryId: createCompactBoundaryId(),
        preCompactDiscoveredTools: [...preCompactDiscoveredTools],
      });
      // 重建 ToolSearch 公告(告诉模型哪些延迟工具可以按需搜索加载)。
      // 新检查点尚未提交；公告使用同一候选分类，避免把即将提升的工具重新公告为待加载。
      // 候选工具使用"继续执行作用域"的工具集(getContinuationTools),而不是压缩用的精简集。
      const toolAnnouncement = buildToolSearchAnnouncement(
        {
          model: compactModel,
          mode: this.config.toolSearch?.mode,
          tools: options.getContinuationTools?.() ?? this.getTools(compactModel),
          registry,
          entries: preservedEntries,
        },
        preCompactDiscoveredTools,
      );
      // 重建 agent(子代理)列表提醒;仅在工具集中存在 Agent 工具时才会生成。
      const agentListingEntry = collectRuntimeAgentListing(
        this,
        preservedEntries,
        options.agentListingTools ?? this.getTools(options.model ?? compactModel),
      );
      // 压缩后要追加的提醒条目,顺序为:
      //   1) agent 列表(可用子代理)
      //   2) 计划文件引用
      //   3) 文件读取态提醒(保留最近读过的文件内容/引用,避免模型"忘记"看过什么)
      //   4) ToolSearch 公告
      // 它们会作为 attachment 条目,紧跟在"保留的最近轮次"之后进入新历史。
      const postCompactReminderEntries = [
        ...(agentListingEntry ? [agentListingEntry] : []),
        ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
        ...buildPostCompactReadStateReminderEntries({
          preservedEntries,
          readFileState: this.readFileState,
        }),
        ...(toolAnnouncement ? [toolAnnouncement] : []),
      ];

      // 记录 ModelComplete 事件:摘要文本、stopReason、usage;toolCallCount 固定 0。
      const modelCompleteEvent = this.createEvent(
        SessionEventType.ModelComplete,
        {
          content: summary,
          stopReason: result.finishReason,
          usage: result.usage,
          querySource: "compact",
          toolCallCount: 0,
        },
        modelTraceContext,
      );
      // 摘要正文先随 ModelComplete 落库,后续 summary/boundary 才有可引用的用量来源;
      // 事件顺序同时决定冷恢复时 timeline 的展示顺序。
      await this.appendEvent(modelCompleteEvent, modelTraceContext);
      events.push(modelCompleteEvent);

      const summaryMessageId = createMessageId();
      // 构造摘要消息正文:固定前缀("会话因上下文耗尽而续接")+ 格式化摘要 +
      // "直接继续、不要向用户提问"的续接指令。
      // suppressFollowup: true = 抑制模型在续接时反问用户,使其无缝接续任务。
      const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
        suppressFollowup: true,
      });
      // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
      const recordablePreservedEntries = filterOutputTokenContinuationEntries(preservedEntries);
      // 持久化侧"保留区间"必须基于 SessionStore 中的真实消息来计算:
      // runtime 与 DB 的 user/attachment 数量并非一一对应,不能直接用 runtime 条数。
      // 无 sessionStore(纯内存模式)时只统计数量,不产出 preservedSegment 指针。
      // 差异原因:纯内存模式没有可回查的消息 id,强行生成指针会在恢复时指向不存在的数据。
      const preservation = this.sessionStore
        ? await selectPersistedCompactTail({
            sessionStore: this.sessionStore,
            sessionId: this.sessionId,
            groupsPreserved: currentSelection.groupsPreserved,
            summaryMessageId,
          })
        : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
      // 摘要条目:role=user(作为"续接上下文"注入),带上 synthetic 元数据 +
      // compactBoundary 发现检查点(记录 boundaryId 与压缩前已发现的工具)。
      const summaryEntry = {
        message: { role: "user" as const, content: summaryMessageContent },
        metadata: { ...legacySyntheticRuntimeMetadata(), compactBoundary: discovery },
      };
      // 压缩后的完整历史顺序:
      //   [context prefix(系统/技能清单等)] → [摘要消息] → [保留的最近轮次] → [各类提醒]
      // buildPostCompactRuntimeEntries 内部按此顺序组装并 clone 各条目。
      const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, summaryEntry, {
        postCompactReminderEntries,
        preservedEntries,
      });
      // 压缩后的"真实占用"估算(本地按 provider 渲染估算),用于判断是否会再次触发压缩。
      const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
        useMidConversationSystem,
      });
      // provider 上报的 usage 总量(本次 summary 请求的 input+output),
      // 作为对外展示/时间线里的 postCompactTokenCount。
      const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
      // 构造 compact boundary(压缩边界):它是"历史分界线"的权威描述,
      // 记录摘要消息 id、被摘要到的最后一条消息 id、压缩前后 token、持久化保留区间等。
      const compactBoundary = buildManualCompactBoundary({
        ...discovery,
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions,
        lastSummarizedMessageId,
        phase,
        postCompactTokenCount: providerPostCompactTokenCount,
        preCompactTokenCount,
        summarizedMessageCount: entriesToSummarize.length,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        // 只有确实保留了最近轮次时才记录 keptMessageCount;否则该字段无意义。
        ...(currentSelection.groupsPreserved > 0
          ? {
              keptMessageCount: preservation.keptMessageCount,
            }
          : {}),
        // 持久化层保留区间的首尾指针(供恢复、编辑判定等场景使用)。
        preservedSegment: preservation.preservedSegment,
        truePostCompactTokenCount,
        // 压缩后如果真实占用仍 >= auto 阈值,说明"下一轮还会立刻再压缩"——
        // 记录该信号供策略层/UI 提示。只有调用方给了阈值才计算。
        willRetriggerNextTurn:
          options.autoCompactThreshold !== undefined
            ? truePostCompactTokenCount >= options.autoCompactThreshold
            : undefined,
      });

      // 先把摘要消息 + compaction part(+必要提醒)原子持久化成功,再替换内存历史;
      // 持久化失败会直接抛出,内存不会被提前改坏。
      // 发现检查点跟随 summary 原子保存；持久化成功后才替换 Runtime 历史。
      await this.persistCompactSummary(
        summaryMessageId,
        summaryMessageContent,
        persistedSummary,
        compactBoundary,
        modelTraceContext,
        {
          model: compactModel,
          operationId: compactTimeline.operationId,
          postCompactReminderEntries,
        },
      );

      // 发送 CompactBoundary 事件(真正的"历史分界"事件,恢复/回放依赖它)。
      const compactBoundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        compactBoundary,
        turnTraceContext,
      );
      await this.appendEvent(compactBoundaryEvent, turnTraceContext);
      events.push(compactBoundaryEvent);

      // 时间线收尾:同一个 operation 上 Started→Completed,replace:true 就地更新同一行;
      // 写入 boundaryId、压缩前后 token、summaryMessageId、被摘要到的最后一条消息 id。
      const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
        ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
        boundaryId: compactBoundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: providerPostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId,
        tailStartMessageId: lastSummarizedMessageId,
        truePostCompactTokenCount,
      });
      await persistCompactTimelineEvent(
        this,
        SessionEventType.CompactCompleted,
        compactCompletedPayload,
        turnTraceContext,
        events,
      );

      // 下一轮对话从摘要消息之后开始:更新 latestConversationMessageId。
      // §6-7:摘要消息与 boundary 已在上一步持久化成功,这里才推进 latest 指针;
      // 指针先于落库会指向不存在的消息,冷恢复直接失败。
      this.latestConversationMessageId = summaryMessageId;
      const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
      // 整体替换 Runtime 内存历史:
      // - 若调用方显式传了 activeEntries(turn-local 作用域),只提交"转换后的对话尾部",
      //   保留当前 canonical 前缀(配置刷新可能在压缩期间已替换前缀,整体回写会把它覆盖掉);
      // - 否则(独立 turn)直接整体替换。
      this.messageHistory.replaceMessages(
        options.activeEntries
          ? preserveCanonicalContextPrefix(
              this.messageHistory.borrowReadOnlyRuntimeEntries(),
              recordablePostCompactEntries,
            )
          : recordablePostCompactEntries,
      );
      // 压缩后旧的读取状态不再可信(内容可能已过时):清空后由 reminder 重新教导;
      // 同时重置项目记忆 recall 的 prefetch 缓存,避免后续请求携带压缩前的旧正文。
      this.readFileState.clear();
      resetProjectMemoryRecall(this);

      return {
        // UI 完成提示。
        displayText: "Compacted",
        // 压缩后完整历史(含 reminder),供上层继续本轮 turn。
        entries: postCompactEntries,
        outcome: "compacted",
        // 对外 token 统计使用 provider 上报的 usage 总量。
        tokenCount: providerPostCompactTokenCount,
      };
    } catch (error) {
      // 外层重试判定(仅 auto):
      //   - 还有剩余尝试次数(attempt < maxAttempts)
      //   - 不是用户取消
      //   - 错误可重试:CoreError 看 retryable 标记;非 CoreError(临时网络错误等)默认视为可重试。
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        // 用同一个 operation 发 Retrying:UI 上把这一行更新为"重试中",不新增行;
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        // 重试前把切分状态重置为初始选择:上一次可能因 prompt-too-long 收缩过输入,
        // 新一次尝试应从完整上下文重新开始(网络类错误通常与输入大小无关)。
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = initialEntriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        // 回到外层 while,开始下一次 attempt。
        continue;
      }
      // 不再重试:把时间线收敛为 Failed(用户取消则为 Interrupted),然后原样抛错。
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

/**
 * 判断 auto compact 的错误是否值得外层重试:
 * - 核心错误(CoreError)尊重其 retryable 标记
 *   (例如 prompt-too-long 明确标记 retryable=false,避免 3×3 放大);
 * - 非核心异常(网络抖动、流中断等)保守地视为可重试。
 */
function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

/**
 * 是否允许用"丢弃更老轮次"的破坏性收缩来应对 prompt too long。
 * 只允许 manual / partial / session_memory 这类"用户可见或明确发起"的压缩;
 * auto / reactive 属于自动补救路径,不允许静默丢弃历史
 * (它们改为"多保留最近轮次"策略 + 外层重试,见 reselectEntriesAfterPromptTooLong)。
 */
function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

/**
 * 首次切分入口(组合两层选择策略):
 * 1) 先按常规规则切分(selectCompactEntries):
 *    - Auto / Reactive 保留最近 1 个 assistant 轮次,其余进入摘要;
 *    - 其他 trigger 默认不保留(全部摘要,仅保留 context prefix);
 * 2) 若本次压缩由"首次请求就 prompt too long"触发(initialPromptTooLongCause 非空),
 *    改用 token-gap 感知的切分:根据溢出错误里 "actual > limit" 的差额,
 *    多保留足够覆盖差额的最近轮次,以缩小 summary 请求本身;
 *    若新切分不可用(无法解析 gap / 历史轮次不足)则回退常规结果。
 */
function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

/**
 * 计算 compact summary 请求的 maxOutputTokens:
 *   min(普通请求的 max output 策略值, 20K 的 summary 专用上限, 模型自身允许的上限)
 * 20K 上限的意义:摘要只做"信息压缩",不需要像正常回答那样长,
 * 限制输出可降低费用与延迟;同时保证不会超过模型能力。
 */
function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
