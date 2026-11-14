// INV-01 标题是后台增强：守住位置 全局捕获；改错故障 标题失败中断主轮。
// INV-02 一次性尝试：守住位置 尝试标记；改错故障 失败后反复调用模型。
// INV-03 显式关闭优先：守住位置 enabled 判断；改错故障 用户关闭后仍然生成。
// INV-04 无 store 不生成：守住位置 早退；改错故障 白费一次模型调用。
// INV-05 子会话不生成：守住位置 父会话判断；改错故障 fork 产物继承错误标题。
// INV-06 只取首轮输入：守住位置 turnNumber；改错故障 后续输入被当成初始意图。
// INV-07 短输入跳过：守住位置 长度判断；改错故障 简短问候被改成泛化标题。
// INV-08 协议命令可绕过短输入：守住位置 绕过标志；改错故障 目标永远没有标题。
// INV-09 运行头刷新竞争先让主轮：守住位置 延迟判断；改错故障 标题请求抢占刷新。
// INV-10 无法判断选择时保守延迟：守住位置 selection 缺省；改错故障 与主请求并发。
// INV-11 入队冻结因果链：守住位置 捕获调用；改错故障 后台 trace 丢失指向。
// INV-12 入队冻结模型上下文：守住位置 保留调用；改错故障 稍后读到新配置。
// INV-13 生成结束释放票据：守住位置 finally；改错故障 闲时额度泄漏。
// INV-14 写回前重读会话：守住位置 重读调用；改错故障 旧标题覆盖用户编辑。
// INV-15 首查被编辑只记用量：守住位置 抑制判断；改错故障 编辑后仍写旧标题。
// INV-16 custom 永不被自动覆盖：守住位置 来源比较；改错故障 用户命名被冲掉。
// INV-17 CAS 期望来源限制写回：守住位置 期望来源；改错故障 并发改名被覆盖。
// INV-18 条件不满足不发事件：守住位置 返回值比对；改错故障 界面显示未生效标题。
//
// 模块职责：编排会话标题的后台生成、写回与自定义改名的持久化。
// 状态所有权：会话数据归 session store；后台任务由 runtime 追踪。
// 阅读顺序：先看入口与前置条件，再看生成与写回，最后看编辑抑制与自定义改名。
// ============================================================
// runtime/methods/session-title.ts —— 会话标题生成的编排层（首条输入 → sidecar → 落库/事件）
// ============================================================
// 定位：旁支：首条真实用户输入后异步生成会话标题并写回 session meta；/goal 复用同一
//   sidecar 生成目标摘要标题（summaryTitle）。
// 输入：首条 input + messageID + trace；输出：session title / SessionTitleUpdated 事件，
//   或写回 goal summary title 的兜底。
// 关键不变量：标题是后台增强，失败只 warn、绝不能影响 turn；写回前必须重读 session，
//   防止旧 query 的标题覆盖用户编辑后的标题；titleSource=custom 后永不自动覆盖；
//   标题提示属于 query-local 旁路，不进持久化对话历史（不变量 #9 的同类约束）。
// ============================================================
import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  ModelSelection,
  SessionInfo,
  SessionTitleSource,
  TraceContext,
} from "../deps.js";
import type { AgentTelemetryCausation } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistFallbackGoalSummaryTitle,
  persistGeneratedGoalSummaryTitle,
} from "./goal-summary-title.js";
import {
  SESSION_TITLE_QUERY_SOURCE,
  generateTitleCandidate,
  normalizeTitleInput,
  retainTitleModelContext,
  type TitleModelContext,
} from "./title-generation-sidecar.js";

// GENERATED_TITLE_EXPECTED_SOURCES 只列三种自动来源，custom 不在其中。
// custom 永远不在集合内。
// 该集合是写回 CAS 的期望值。
// 新增来源必须同步这张表，否则自动覆盖会被 CAS 挡住。
const GENERATED_TITLE_EXPECTED_SOURCES: readonly SessionTitleSource[] = [
  "default",
  "first_input",
  "generated",
];
const MIN_GENERATED_TITLE_INPUT_CHARS = 10;

export function maybeStartSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  options?: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    offPeakExecutionId?: string;
  },
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    deferIfProviderRuntimeHeadersRefresh: options?.deferIfProviderRuntimeHeadersRefresh,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    offPeakExecutionId: options?.offPeakExecutionId,
    messageID,
    traceContext,
  });
}

export function maybeStartDeferredSessionTitleGeneration(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId,
  traceContext: TraceContext,
  offPeakExecutionId?: string,
): boolean {
  return maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    messageID,
    traceContext,
    offPeakExecutionId,
  });
}

// maybeStartSessionTitleGenerationFromExternalInput 复用同一套标题种子。
// 只读入参，不额外持久化用户消息。
// 入参里的 skip 标志可跳过短输入保护，不重新判定长度。
// 无 trace 时使用根上下文。
export function maybeStartSessionTitleGenerationFromExternalInput(
  this: AgentRuntimeInternal,
  input: string,
  options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
): void {
  // /goal 这类协议命令不走普通 executeTurn，但 objective 仍是用户可见的首条意图。
  // 这里复用 title seed，不额外持久化 user message，避免为了标题生成污染聊天 transcript。
  maybeStartSessionTitleGenerationFromSeed.call(this, input, {
    bypassShortInputGuard: true,
    goalSummaryTargetID: options?.goalSummaryTargetID,
    traceContext: options?.traceContext ?? this.rootTraceContext,
  });
}

function maybeStartSessionTitleGenerationFromSeed(
  this: AgentRuntimeInternal,
  input: string,
  options: {
    deferIfProviderRuntimeHeadersRefresh?: boolean;
    goalSummaryTargetID?: string;
    messageID?: MessageId;
    traceContext: TraceContext;
    bypassShortInputGuard?: boolean;
    offPeakExecutionId?: string;
  },
): boolean {
  // 前置条件不满足（已尝试/开关关闭/非首轮/非交互会话）时返回 false，调用方无副作用可做。
  if (
    !shouldAttemptSessionTitleGeneration(this, input, {
      bypassShortInputGuard: options.bypassShortInputGuard,
    })
  ) {
    return false;
  }
  if (
    options.deferIfProviderRuntimeHeadersRefresh &&
    shouldDeferSessionTitleForRuntimeHeaders(this)
  ) {
    // 首条消息的 title generation 和主消息会共享同一个 runtimeModel。
    // 需要刷新 runtime headers 的 provider 先让主 turn 发出去，再异步补标题。
    return false;
  }
  // 先置一次性标记再异步：同一会话只允许一次标题尝试，失败也不重排队。
  // 先在本轮同步段把 sessionTitleGenerationAttempted 置 true。
  // 置位后即使生成失败也不重新排队。
  // 标记写入发生在 await 之前，并发调用看到已尝试。
  // 函数返回本次是否启动了生成，调用方据此决定后续。
  this.sessionTitleGenerationAttempted = true;
  // 标题任务会越过当前 Turn 的生命周期。入队时冻结 causation，避免后续 await、
  // 调度器或实现重构使后台 Trace 静默丢失指向触发 Span 的 Link。
  const causation = this.agentTelemetry.captureCausation();
  // 入队时冻结模型选择与闲时票据：sidecar 会越过当前 turn 生命周期，稍后不能再"现取"。
  const modelContext = retainTitleModelContext(this, options.offPeakExecutionId);

  // 兜底吞掉标题失败：主流程已继续，不能因旁路异常冒泡；/goal 还要补 summaryTitle。
  const generation = generateAndPersistSessionTitle
    .call(this, input, options.messageID, options.traceContext, {
      causation,
      modelContext,
      goalSummaryTargetID: options.goalSummaryTargetID,
    })
    .catch(async (error) => {
      this.logger?.warn("Session title generation failed", {
        ...traceContextToLogContext(options.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_title_generation.failed",
        module: "core.runtime",
        status: "failed",
      });
      // goal 侧没有标题就没有可读的迭代名称，必须写 fallback；普通会话保留默认标题即可。
      if (options.goalSummaryTargetID) {
        await persistFallbackGoalSummaryTitle.call(this, {
          objective: input,
          reason: "session_title_generation_failed",
          targetID: options.goalSummaryTargetID,
          traceContext: options.traceContext,
        });
      }
    })
    .finally(() => modelContext.release());
  // 注册为 residency 阻塞工作：进程退出前会等它收尾；外层再 catch 只为避免 unhandled rejection。
  void this.trackResidencyBlockingWork(generation).catch((error) => {
    this.logger?.warn("Session title fallback persistence failed", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_title_generation.fallback_failed",
      module: "core.runtime",
      status: "failed",
    });
  });
  return true;
}

function shouldAttemptSessionTitleGeneration(
  runtime: AgentRuntimeInternal,
  input: string,
  options: { bypassShortInputGuard?: boolean } = {},
): boolean {
  // 一次性：同一会话只尝试一次标题生成，失败也不重试。
  if (runtime.sessionTitleGenerationAttempted) return false;
  // 显式 enabled=false 优先；完全没配置时同样不生成（旧会话保持旧标题语义）。
  if (runtime.config.titleGeneration?.enabled === false) return false;
  if (!runtime.config.titleGeneration) return false;
  // 没有 store 无法写回标题，生成只会白费一次模型调用。
  if (!runtime.sessionStore) return false;
  // 子会话沿用父会话的标题语义，不单独生成。
  if (runtime.config.parentSessionId) return false;
  // 只有交互式会话存在"首条用户意图"这一标题素材。
  if (runtime.config.taskType && runtime.config.taskType !== "interactive") return false;
  // 只取首轮：之后的输入不是会话的初始意图。
  if (runtime.turnNumber !== 0) return false;
  const normalizedInput = normalizeTitleInput(input);
  // 纯空白输入没有可总结内容。
  if (normalizedInput.length === 0) return false;
  // 短首发输入本身已经是可读标题，继续走 generated title sidecar
  // 会把 "hi" 这类标题稳定覆盖成泛化的 "New Coding Session"。
  return (
    options.bypassShortInputGuard ||
    Array.from(normalizedInput).length >= MIN_GENERATED_TITLE_INPUT_CHARS
  );
}

function shouldDeferSessionTitleForRuntimeHeaders(runtime: AgentRuntimeInternal): boolean {
  const runtimeHeadersPort = runtime.providerRuntimeHeadersPort;
  // 没有 runtime headers 端口就不存在与主请求的刷新竞争，可直接启动。
  if (!runtimeHeadersPort) return false;
  const selection =
    runtime.config.titleGeneration?.modelSelection ?? runtime.getSessionModelSelection();
  // 选不出模型说明主轮可能还没定下 selection，保守延迟。
  if (!selection) return true;
  // 端口无法判断时按"需要刷新"处理：宁可延后标题，也不要和主请求抢刷新。
  return (
    runtimeHeadersPort.shouldRefreshBeforeModelRequest?.({
      providerId: selection.providerId,
      modelId: selection.modelId,
    }) ?? true
  );
}

// 首查确认会话形态。
// 首查确认会话形态；若标题已被编辑只记用量，不再覆盖。
// custom 场景仅为目标写摘要。
// 生成成功才写回标题。
async function generateAndPersistSessionTitle(
  this: AgentRuntimeInternal,
  input: string,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
  options: {
    causation?: AgentTelemetryCausation;
    goalSummaryTargetID?: string;
    modelContext?: TitleModelContext;
  } = {},
): Promise<void> {
  // 首查 session：取 titleSource 与 revert 状态；真正落库前还会再查一次（见 persist 函数）。
  const initialSession = await this.sessionStore?.getSession(this.sessionId);
  // 子会话/非交互会话不写标题，避免 fork 产物继承出错误标题。
  if (!initialSession || initialSession.parentID || initialSession.taskType !== "interactive") {
    return;
  }

  // 首查已被编辑：旧 query 的标题请求只能记用量，不能再写回标题。
  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(
      this,
      initialSession,
      messageID,
      traceContext,
    )
  ) {
    return;
  }

  // custom 是用户显式命名，自动标题永远不能覆盖它。
  const shouldPersistSessionTitle = initialSession.titleSource !== "custom";
  // custom 且非 goal 场景直接跳过；goal 仍需要为 target 写 summaryTitle。
  if (!shouldPersistSessionTitle && !options.goalSummaryTargetID) {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }
  // goal 场景单独打点：便于按 targetId 追踪"摘要标题"这条旁路。
  if (options.goalSummaryTargetID) {
    this.logger?.info("Goal summary title generation started", {
      ...traceContextToLogContext(traceContext),
      event: "goal_summary_title_generation.started",
      module: "core.runtime",
      querySource: SESSION_TITLE_QUERY_SOURCE,
      status: "started",
      targetId: options.goalSummaryTargetID,
    });
  }

  // 真正的模型调用在 sidecar；这里只负责"要不要写回"与 goal 兜底。
  const generated = await generateTitleCandidate.call(this, input, {
    causation: options.causation,
    modelContext: options.modelContext,
    messageID,
    querySource: SESSION_TITLE_QUERY_SOURCE,
    traceContext,
  });
  // 空结果（模型返回工具调用/空标题/超时）按"未生成"处理，绝不写入空标题。
  if (!generated) {
    if (options.goalSummaryTargetID) {
      // 首次 /goal 会把 session title sidecar 同时当作 summaryTitle 来源；
      // 这个 sidecar 空响应时必须给目标摘要写兜底，否则第一轮迭代没有语义标题。
      await persistFallbackGoalSummaryTitle.call(this, {
        objective: input,
        reason: "session_title_empty",
        targetID: options.goalSummaryTargetID,
        traceContext,
      });
    }
    return;
  }

  // 只有非 custom 才写回会话标题；写回函数内部还会做一次 CAS 校验。
  if (shouldPersistSessionTitle) {
    await persistGeneratedSessionTitle.call(this, {
      messageID,
      modelSelection: generated.modelSelection,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }

  // goal 摘要标题复用同一次生成结果，避免为了 summaryTitle 再打一次模型。
  if (options.goalSummaryTargetID) {
    await persistGeneratedGoalSummaryTitle.call(this, {
      targetID: options.goalSummaryTargetID,
      title: generated.title,
      traceContext: generated.traceContext,
    });
  }
}

/**
 * renameSession：用户显式重命名会话（titleSource=custom）。custom 之后自动标题
 * 生成会被跳过（见 persistGeneratedSessionTitle 的 custom_title 短路），持久化 + 发
 * SessionTitleUpdated(source:custom) 供 v4 投影 meta 更新。
 */
export async function setCustomSessionTitle(
  this: AgentRuntimeInternal,
  input: { title: string; traceContext: TraceContext },
): Promise<void> {
  // 先读旧标题，供 SessionTitleUpdated 的 previousTitle 使用；读不到按空串处理。
  const previous = await this.sessionStore?.getSession(this.sessionId);
  const previousTitle = previous?.title ?? "";
  // 先落 durable 的 custom 标记再发事件：即使事件失败，后续自动标题也会被 custom 短路。
  await this.sessionStore?.updateSession({
    id: this.sessionId,
    title: input.title,
    titleSource: "custom",
  });
  // 事件供 v4 投影更新 meta；source=custom 让 UI 知道这是用户显式改名。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle,
        source: "custom",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function persistGeneratedSessionTitle(
  this: AgentRuntimeInternal,
  input: {
    messageID: MessageId | undefined;
    modelSelection: ModelSelection;
    title: string;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 标题 sidecar 现在会在首条 query 落库后并发启动，用户可能在 LLM 返回前编辑首条 query。
  // 写回前重新读取 session，避免旧 query 的 generated title 覆盖编辑后的首屏标题语义。
  // 写回前重读：读不到/已变子会话/首查被编辑，都放弃写回。
  const session = await getSessionForGeneratedTitle.call(this, input.messageID, input.traceContext);
  if (!session) return;
  // 竞争窗口：sidecar 期间用户 rename 过，必须让 custom 赢。
  if (session.titleSource === "custom") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "custom_title",
    });
    return;
  }

  // previousTitle 用重读后的值，保证事件描述的是"这次真正被覆盖的标题"。
  const previousTitle = session.title;
  // CAS：expectedTitleSources 限定只有 default/first_input/generated 可被自动覆盖。
  // updateSession 带 expectedTitleSources，来源被改过就写不进去。
  // 同时写入 titleSource 与来源消息标识，两者成对落库。
  // updated 为空或标题不一致时视为未生效。
  // 未生效就不发标题变更事件。
  const updated = await this.sessionStore?.updateSession({
    expectedTitleSources: GENERATED_TITLE_EXPECTED_SOURCES,
    id: this.sessionId,
    title: input.title,
    ...(input.messageID ? { titleMessageID: input.messageID } : {}),
    titleSource: "generated",
  });
  // 条件不满足说明写回被并发改成 custom/其它来源，本次视为未生效，也不再发事件。
  if (!updated || updated.title !== input.title || updated.titleSource !== "generated") {
    this.logger?.debug("Session title generation skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "session_title_generation.skipped",
      module: "core.runtime",
      reason: "title_source_changed",
    });
    return;
  }

  // CAS 成功后发事件；messageID 仅在有值时带上，旧事件 DTO 尚未迁移。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        // 旧持久化事件 DTO 尚未迁移；不把该投影重新暴露为标题生成配置。
        ...(input.messageID ? { messageID: input.messageID } : {}),
        previousTitle,
        source: "generated",
        title: input.title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

async function getSessionForGeneratedTitle(
  this: AgentRuntimeInternal,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<SessionInfo | null> {
  // 重读后仍要校验会话形态：sidecar 期间可能被 fork 成子会话或变成非交互任务。
  const session = await this.sessionStore?.getSession(this.sessionId);
  if (!session || session.parentID || session.taskType !== "interactive") return null;
  // 首查被编辑时返回 null，让调用方按"跳过"处理而不是写回旧语义标题。
  if (
    await shouldSkipGeneratedTitleForFirstQueryEdit.call(this, session, messageID, traceContext)
  ) {
    return null;
  }
  return session;
}

async function shouldSkipGeneratedTitleForFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
  traceContext: TraceContext,
): Promise<boolean> {
  // 未被抑制就继续；被抑制时先记 debug（reason=first_query_edited）再返回 true。
  if (!(await isSuppressedByFirstQueryEdit.call(this, session, messageID))) return false;
  this.logger?.debug("Session title generation skipped", {
    ...traceContextToLogContext(traceContext),
    event: "session_title_generation.skipped",
    module: "core.runtime",
    reason: "first_query_edited",
  });
  return true;
}

async function isSuppressedByFirstQueryEdit(
  this: AgentRuntimeInternal,
  session: SessionInfo,
  messageID: MessageId | undefined,
): Promise<boolean> {
  // 编辑首条 query 会通过 conversation_rewind 把 target 指向旧用户消息。
  // 旧 query 的标题请求即使已经发出，也只能记录用量，不能再写回会话标题。
  // revert 目标正好是本条首查：说明它已被"编辑并重发"，标题不能再按旧 query 写回。
  if (messageID && session.revert?.targetMessageID === messageID) return true;
  return hasEditedFirstVisibleUserQuery.call(this, session);
}

async function hasEditedFirstVisibleUserQuery(
  this: AgentRuntimeInternal,
  session: SessionInfo,
): Promise<boolean> {
  const revert = session.revert;
  // 只有 conversation_rewind 才可能改写首查；其它 revert 类型不影响标题语义。
  if (revert?.kind !== "conversation_rewind" || !revert.targetMessageID) return false;
  const keptMessageIds = new Set(revert.keptMessageIDs ?? []);
  // 没有保留清单 = 首查被整体替换，按"已编辑"抑制。
  if (keptMessageIds.size === 0) return true;

  // 读真实消息确认：保留集合里是否还存在可见的真实用户消息。
  const messages = await this.sessionStore?.messages({ sessionID: this.sessionId });
  // 读不到消息时保守放行（宁可生成，也不要漏掉标题）。
  if (!messages) return false;
  // 没有任何"保留且可见的真实 user 消息" → 首查确实被编辑，抑制本次标题。
  return !messages.some(
    (message) => keptMessageIds.has(message.info.id) && isVisibleRealUserMessage(message),
  );
}

function isVisibleRealUserMessage(message: MessageWithParts): boolean {
  // synthetic / model-only 不是真实用户意图，不能当作"首查仍在"的证据。
  const info = message.info;
  return info.role === "user" && info.synthetic !== true && info.visibility !== "model-only";
}
