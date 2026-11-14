/**
 * ============================================================================
 * runtime/methods/resume.ts —— 冷恢复(cold resume)的装配顺序
 * ============================================================================
 *
 * resumeFromStore 把一个已落盘的 session 重新装回内存 runtime。顺序很重要,
 * 因为后面的步骤依赖前面的状态:
 *   1. 会话级事实:软删除校验、异常路径修复、branchGeneration、目录/任务类型/记忆根;
 *   2. 环境与 shell:envInfo、shell 选择(都来自落盘时的事实,不能沿用进程默认);
 *   3. 读态与上下文:readFileState 必须在 Context 初始化**之前** hydrate,
 *      否则随后单次加载的 MEMORY.md 会与 provider 所见内容不一致;
 *   4. 历史:恢复中断的 compact 时间线 → hydrate messageHistory;
 *   5. 锚点:latestConversationMessageId / latestAssistant* / turnNumber
 *      (compact preserved segment 不能当作 timeline anchor);
 *   6. 工作区:checkpoint 与 file-rewind 事件;
 *   7. 执行态与权限:mode/executionState 只从权威事件/entry 恢复;
 *   8. 续跑上下文:todos、target、SessionStart hooks;
 *   9. 收尾:SessionResumed 事件与 persistedMessagesReloadRequired。
 *
 * 【branchGeneration】rewind/编辑重发会推进 branch generation;
 * resume 必须把同一个值交给 runtimeTaskRegistry,否则后台任务会挂到旧分支。
 * ============================================================================
 */
import { restorePermissionGrantMarker } from "../helpers/permission-grant-resume.js";
import { executionStateSchema, resolveExecutionState } from "@zcode/shared";
import { SESSION_ENTRY_EXECUTION_STATE } from "@zcode/contracts";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createCoreError,
  traceContextToLogContext,
  formatGoalStateForModel,
  activeSessionMessages,
  hydrateReadFileStateFromSession,
  hydrateMessageHistoryFromSession,
  MessageHistoryImpl,
} from "../deps.js";
import type {
  EnvInfo,
  MessageWithParts,
  SessionEvent,
  SessionGoal,
  SessionInfo,
  SessionTitleSource,
  TodoItem,
  TraceContext,
  TurnId,
  TurnState,
  ToolSchedule,
} from "../deps.js";
import { getLatestActiveSessionMessageId } from "../helpers/index.js";
import type { ResumeSessionOptions, ResumeSessionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  announceSessionShellEnvironmentNoticeAfterResume,
  getSessionShellSelection,
  restoreSessionShellEnvironmentSelectionForResume,
} from "./session-shell-environment.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { restoreDynamicWorkflowActivationOnResume } from "./dynamic-workflow-activation.js";
import { repairPersistedRemoteSessionPaths } from "../helpers/persisted-remote-session-path-repair.js";
import {
  restoreWorkspaceCheckpointEntries,
  restoreWorkspaceFileRewindEntries,
} from "./workspace-checkpoint-persistence.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";

export function toScheduleState(
  this: AgentRuntimeInternal,
  schedule: ToolSchedule,
): TurnState["scheduledTools"] {
  return {
    items: schedule.items.map((item) => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}

export async function resumeFromStore(
  this: AgentRuntimeInternal,
  options?: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  // 冷恢复的全部事实都来自 store：没有 store 就无法伪造内存态，
  // 必须 fail fast，而不是返回一个"看起来能跑"的空 runtime（后续 turn 会污染新历史）。
  if (!this.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot resume session without a session store",
      { recoverable: false },
    );
  }

  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const persistedSession = await this.sessionStore.getSession(this.sessionId);
  // 删除 = CLI 软删除（time_deleted）。归档已归 Host 组织态，CLI 不再有归档列；
  // 旧的 time.archived 判断永远为 false，这里改为拒绝恢复已软删除的会话。
  if (!persistedSession || persistedSession.time.deleted !== undefined) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: { sessionId: this.sessionId },
      recoverable: true,
    });
  }
  // 路径修复失败只降级为"内存内修复"：resume 不能因为旧路径不可写而整体失败，
  // 但必须留 warn——它意味着落盘里存在跨机器/已移动的脏路径。
  const session = await repairPersistedRemoteSessionPaths(this.sessionStore, persistedSession, {
    onPersistenceFailure: (error) => {
      this.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.path_repair.persist_failed",
        module: "core.runtime",
        sessionId: this.sessionId,
      });
    },
  });

  const messages =
    options?.persistedMessages ??
    (await this.sessionStore.messages({
      sessionID: this.sessionId,
    }));
  // 四个 revert 指针是"活动分支"的定义，必须成套传给 history/readState/锚点/checkpoint
  // 恢复；少传一个就会把已 rewind 掉的旧分支重新复活（不变量 7 的前置事实）。
  const rewindTargetMessageId = session.revert?.targetMessageID;
  const rewindCreatedMessageId = session.revert?.createdMessageID;
  const rewindKeptMessageIds = session.revert?.keptMessageIDs;
  const branchCutAfterMessageId = session.revert?.branchCutAfterMessageID;
  // branchGeneration 是"当前活动分支"的版本号:rewind/编辑重发会推进它,
  // 后台任务/子代理用它判断自己是否还挂在活动分支上。resume 必须沿用落盘值,
  // 不能从 0 重新开始,否则旧分支的后台任务会被误认为仍然有效。
  this.branchGeneration = session.revert?.branchGeneration ?? 0;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
  if (messages.length === 0) {
    // 合法但值得告警:空会话可能来自"首轮输入前就崩溃",也可能是 store 读失败被吞。
    // 日志里带上 rewind 指针,便于区分"历史被回退到空"与"真的没有历史"。
    this.logger?.warn("Session resume loaded zero persisted messages", {
      ...traceContextToLogContext(traceContext),
      directory: session.directory,
      event: "session.resume.persisted_messages_zero",
      module: "core.runtime",
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }
  const persistedEnvInfo = extractPersistedEnvInfo(messages);
  if (persistedEnvInfo) {
    // envInfo 从"第一条带 contextSnapshot 的 user 消息"恢复:
    // 环境(OS/终端/仓库)属于会话开始时的既定事实,不能拿当前进程环境覆盖,
    // 否则恢复后的 context 段会与模型之前看到的不一致。
    this.config.envInfo = persistedEnvInfo;
  }
  // shell 选择必须恢复为落盘值：后续 Bash 命令要在同一 shell 家族里执行，
  // 沿用进程默认（可能是别的平台/别的 shell）会改变命令语义与路径展开规则。
  const shellRestore = await restoreSessionShellEnvironmentSelectionForResume(this, {
    currentSelection: getSessionShellSelection(this),
    traceContext,
  });

  // cwd 以落盘 directory 为准：进程启动目录可能是另一个 workspace，
  // 错用会让文件工具与 checkpoint 路径解析到错误仓库。
  this.workingDirectory = session.directory;
  this.config.taskType = session.taskType;
  if (this.config.memory) {
    // Memory root 必须使用会话落盘时的 workspace identity，不能沿用进程启动 workspace。
    this.config.memory.workspaceIdentity = session.workspaceID
      ? String(session.workspaceID)
      : undefined;
  }
  resetProjectMemoryRecall(this);
  // 全部运行时历史状态重建而不是"补写":
  // resume 对应一个新的 runtime 实例,旧实例的 messageHistory/contextBuilder
  // 可能来自别的会话或已失效,复用会串历史。
  this.messageHistory = new MessageHistoryImpl();
  this.contextBuilder = null;
  this.contextInitialized = false;
  this.lastEmittedLocalDate = undefined;
  // cold resume 的历史 hydration 会先清空 runtime-local read-state；必须在
  // Context 初始化前完成，确保随后单次加载的 MEMORY.md 状态与 provider 所见内容一致。
  const readFileStateHydration = await hydrateReadFileStateFromSession({
    branchCutAfterMessageId,
    messages,
    readFileState: this.readFileState,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
  });
  // Context 在历史 hydrate 之前初始化：system/meta 段只拼一次，之后再改注入顺序
  // 会让 provider 看到的段顺序与 turn 期间不一致（影响 prompt cache 命中）。
  await this.ensureContextInitialized(traceContext);
  // 中断的 compact 必须先把 timeline part 修到终态，否则随后 hydration 会把
  // started/retrying 的 compaction 当成活跃边界，直接截断历史。
  const recoveredCompactTimelineCount = await this.recoverInterruptedCompactTimelines(
    messages,
    traceContext,
  );
  // hydration 负责把中断的 tool part 收口成终态（不变量 1）；它返回的计数直接进
  // SessionResumed，是判断"这次恢复是否可信"的唯一结构化证据。
  const hydration = await hydrateMessageHistoryFromSession({
    logger: this.logger,
    artifactStore: this.artifactStore,
    branchCutAfterMessageId,
    history: this.messageHistory,
    messages,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  announceSessionShellEnvironmentNoticeAfterResume(this, {
    persistedEnvInfo,
    restore: shellRestore,
  });
  const activeMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  // compact preserved segment 会把 compact 前消息插回 provider 上下文，
  // 但它不是 compact 后时间线的 latest anchor，不能用于后续 compact parentID。
  const timelineActiveMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  // 三个锚点都从 timelineActiveMessages(不含 compact preserved segment)取:
  // preserved segment 是"插回上下文的旧消息",不是时间线末尾,
  // 用它做 anchor 会让下一次 compact/fork 指到过去。
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  // 上次 assistant 完成时间供 microcompact 判断"刚压缩过"等冷却逻辑,
  // 缺失时保持 undefined,不能填 0(0 会被当成"很久以前")。
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;

  // checkpoint 与 file-rewind 是两类事件，分别恢复：前者供 /rewind latest 选择目标，
  // 后者供文件回退预览；缺一都会让冷启动后 UI 显示"没有可回退的检查点"。
  await restoreWorkspaceCheckpointEntries(this, traceContext);
  await restoreWorkspaceFileRewindEntries(this, traceContext);
  const restoredEvents = await this.eventStore.getEvents(this.sessionId);
  const restoredModeEvents = restoredEvents.filter(
    (event) =>
      event.type === SessionEventType.SessionCreated ||
      event.type === SessionEventType.SessionModeChanged,
  );
  const restoredMode =
    restoredModeEvents.length > 0 ? this.eventReducer.reduce(restoredModeEvents).mode : undefined;
  const resolvedMode = options?.modeOverride ?? restoredMode ?? session.permission?.mode;
  if (resolvedMode !== undefined) {
    // cold resume 会先把 checkpoint/rewind 等局部事件恢复到新的内存 eventStore。
    // 这些事件不携带 mode，若仅按“存在任意事件”reduce，会用默认 build 覆盖 headless yolo。
    // 只有权威 mode 事件能恢复历史值；本次 invocation 的显式/default mode 仍保持最高优先级。
    Object.assign(this.config, resolveExecutionState({ mode: resolvedMode }));
  }
  // 会话自己的新记录优先于项目偏好；旧记录仅兼容读取，不批量回填。
  // 两者都低于本次 invocation 的显式 modeOverride（用户当前选择必须立即生效）。
  const executionEntries = await this.sessionStore.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
  });
  const savedExecution = executionStateSchema.safeParse(executionEntries?.at(-1)?.data);
  if (savedExecution.success && options?.modeOverride === undefined) {
    Object.assign(this.config, savedExecution.data);
  }
  // onDemand 会话的工具面随记录恢复（launch.md「On demand: activation」）：entry 在场，或历史里
  // 有过 `/workflow` / 十个工具的调用。要在首轮之前完成，所以放在 resume 里而不是等下一次 turn。
  await restoreDynamicWorkflowActivationOnResume.call(this, messages);

  // 权限批准标记要在 SessionStart hook 之前恢复：hook 执行期间的权限判断
  // 依赖这个 marker，晚恢复会让本会话已批过的操作重新弹审批。
  await restorePermissionGrantMarker(this, traceContext);

  // 缓存命中汇总只用于诊断；从 activeMessages 计算以排除被 rewind 的分支，
  // 否则统计会把用户已经丢弃的历史算进来。
  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: messages,
  });
  this.turnNumber = activeMessages.filter(
    // user 轮次只数"真实用户输入":summary(compact 摘要)不算一轮,
    // 否则压缩后每次 resume 都会把 turnNumber 多推进一格。
    (message) => message.info.role === "user" && !message.info.summary,
  ).length;
  this.sessionPersisted = true;
  // 标题只在"事件流里还没有同 title/source 记录"时补写：重复补会让列表标题的
  // 更新时间漂移，也会在 V4 投影里产生多余 revision。
  await syncPersistedSessionTitleForResume.call(this, {
    restoredEvents,
    session,
    traceContext,
  });
  // resume 不自动重放"未消费的 steer 输入":它们属于上一个 runtime 的交互意图,
  // 自动执行会在用户不知情的情况下多跑一轮。这里丢弃并留下审计日志。
  await this.discardPersistedPendingSteerInputs(traceContext);
  const recoveredSteerInputCount = 0;
  // todo/target 读失败在各自函数里降级为空/ null，resume 仍可继续；
  // 但缺失会让续跑上下文不完整，所以两者内部都有 warn 留痕。
  const resumedTodos = await this.readSessionTodosForContext(traceContext);
  const resumedTarget = await this.readSessionTargetForContext(traceContext);
  this.injectTargetStateIntoMessageHistory(resumedTarget);

  const resumedEvent = this.createEvent(
    SessionEventType.SessionResumed,
    {
      directory: session.directory,
      interruptedToolCount: hydration.interruptedToolCount,
      messageCount: hydration.messageCount,
      partCount: hydration.partCount,
      recoveredCompactTimelineCount,
      recoveredSteerInputCount,
      resumedTodoCount: resumedTodos.length,
      resumedTarget: resumedTarget?.status,
    },
    traceContext,
  );
  // SessionResumed 是"冷恢复已完成"的唯一 durable 信号：bootstrap 据此决定
  // 是否需要向 V4 重放 hydrated 历史；缺它客户端会一直停在"恢复中"。
  await this.appendEvent(resumedEvent, traceContext);
  const sessionStartHookResult = await this.runSessionStartHooks(
    "resume",
    traceContext,
    options?.abortSignal,
  );
  // SessionStart hook 的附加上下文只进入当前 runtime 的 messageHistory，不落库：
  // 写进 durable 会在每次 resume 重复注入同一段提示，越积越长。
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );

  // 两个"零值"告警是排查数据损坏的第一现场：
  // 前者=选择器把全部历史过滤掉（revert 指针与消息不匹配），
  // 后者=hydration 拒绝应用（part 结构非法）。它们不影响 resume 返回，但必须留证。
  if (messages.length > 0 && activeMessages.length === 0) {
    this.logger?.warn("Session resume produced zero active messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      appliedMessageCount: hydration.appliedMessageCount,
      directory: session.directory,
      event: "session.resume.active_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      sessionId: this.sessionId,
      rewindTargetMessageId,
    });
  }
  if (activeMessages.length > 0 && hydration.appliedMessageCount === 0) {
    this.logger?.warn("Session resume applied zero history messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      directory: session.directory,
      event: "session.resume.applied_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }

  this.logger?.info("Session resumed", {
    ...traceContextToLogContext(traceContext),
    appliedMessageCount: hydration.appliedMessageCount,
    directory: session.directory,
    event: "session.resumed",
    interruptedToolCount: hydration.interruptedToolCount,
    messageCount: hydration.messageCount,
    module: "core.runtime",
    partCount: hydration.partCount,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    recoveredCompactTimelineCount,
    resumedTodoCount: resumedTodos.length,
    resumedTargetStatus: resumedTarget?.status,
    sessionId: this.sessionId,
    status: "completed",
  });

  return {
    ...hydration,
    directory: session.directory,
    // 中断 compact 恢复会写回 timeline part；bootstrap 不能继续把恢复前
    // messages 交给 V4，否则首帧会短暂复活 started/retrying 状态。
    persistedMessagesReloadRequired: recoveredCompactTimelineCount > 0,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    traceId: traceContext.traceId,
  };
}

async function syncPersistedSessionTitleForResume(
  this: AgentRuntimeInternal,
  input: {
    restoredEvents: SessionEvent[];
    session: SessionInfo;
    traceContext: TraceContext;
  },
): Promise<void> {
  const title = input.session.title.trim();
  if (!title) return;
  const source = input.session.titleSource ?? "generated";
  if (hasRestoredTitleEvent(input.restoredEvents, title, source)) return;

  // fork child 创建时 title 已写进 sessionStore，但复制历史不会复制父会话的
  // SessionTitleUpdated 事件。v4 live 投影只消费事件流，缺这条事件就会把列表标题降级成"新任务"。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle: "",
        source,
        title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

function hasRestoredTitleEvent(
  events: readonly SessionEvent[],
  title: string,
  source: SessionTitleSource,
): boolean {
  return events.some((event) => {
    if (event.type !== SessionEventType.SessionTitleUpdated) return false;
    const payload = event.payload as { source?: unknown; title?: unknown };
    return payload.title === title && payload.source === source;
  });
}

function extractPersistedEnvInfo(messages: MessageWithParts[]): EnvInfo | undefined {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }

    const envInfo = message.info.contextSnapshot?.envInfo;
    if (envInfo) {
      return envInfo;
    }
  }

  return undefined;
}

export async function readSessionTodosForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<TodoItem[]> {
  if (!this.sessionStore) {
    return [];
  }

  try {
    return await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    // Todo state is continuity context. If the store cannot read it, resume/compact can still
    // proceed from transcript history while surfacing the degradation in structured logs.
    this.logger?.warn("Failed to read session todos for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "todo.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return [];
  }
}

export async function readSessionTargetForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) {
    return null;
  }

  try {
    return await this.sessionStore.readTarget({ sessionID: this.sessionId });
  } catch (error) {
    // Goal state is continuity context. Resume should still work from transcript history
    // if goal storage is temporarily unavailable.
    this.logger?.warn("Failed to read session goal for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

export function injectTargetStateIntoMessageHistory(
  this: AgentRuntimeInternal,
  target: SessionGoal | null,
): void {
  const targetState = formatGoalStateForModel(target);
  if (!targetState) {
    return;
  }

  // goal 以 attachment 注入而不是 user message：不污染 turnNumber/transcript，
  // 但每次请求都会随上下文带给模型，作为续跑目标的权威事实。
  this.messageHistory.addAttachment(
    "resume_goal_state",
    [
      "The current session goal state was restored from session storage.",
      targetState,
      "Use it as the authoritative long-running objective unless a later GoalRead result or runtime goal event updates it.",
      "Do not mark the goal complete unless real evidence shows the objective has been achieved.",
      "A completed plan, todo list, checklist, or planning phase is not completion evidence unless the objective was only to produce that artifact.",
    ].join("\n"),
  );
}
