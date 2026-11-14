/* eslint-disable max-lines -- rewind message primitive 与 cascade 封装共享 conversation/workspace 语义，避免拆分时误改原 /rewind 行为。 */
/**
 * ============================================================================
 * runtime/methods/rewind-message.ts —— 消息级 rewind(conversation / workspace / both + cascade)
 * ============================================================================
 * 【定位】链路 6：/rewind 与 v4 edit/retry 的底层原语，负责 branch cut、checkpoint 回退与派生状态重建。
 * 【输入/输出】输入 RewindScope + targetMessageId；输出结果对象，并写 SessionEvent 与 session.revert 指针。
 * 【关键不变量】#6 分支代际递增后旧分支任务/通知必须丢弃；#7 latest 指针与锚点必须与保留前缀一致。
 * ============================================================================
 */
// ============================================================================
// runtime/methods/rewind-message.ts —— 消息级回退（conversation / workspace / both / cascade）
// ============================================================================
// 【职责边界】只做 rewind 原语三件事：分支切点、checkpoint 文件回退、派生状态重建。
// 不归本文件：UI 投影渲染、compact 触发、turn 调度、持久化实现（由 sessionStore 承担）。
// 【幂等键】每次调用生成一个 rewindId，同一 rewindId 只允许提交一次，重放由上层丢弃。
// 【失败姿态】所有不可用分支 fail closed：不写 branch cut、不发 RewindTriggered、不动工作区。
// 【不变量表】以下每条给出「守在哪 / 改错故障」，改代码前逐条核对，勿凭直觉放宽。
// INV-01 断言：Workspace scope 只走文件快照，不落对话分支 —— 守住它的位置：rewindToMessage 的首个 scope 判定 —— 改错故障：纯文件撤销会连带裁掉对话，UI 与持久链错位。
// INV-02 断言：Both 先回工作区，且仅 ActiveChain 才继续回退对话 —— 守住它的位置：rewindToMessage 的 Both 分支 —— 改错故障：FileOnly 降级后仍裁消息，用户见到文件回了、历史没了。
// INV-03 断言：cascade 的 Both 必须先规划对话，不可用时在动工作区之前返回 —— 守住它的位置：rewindCascadeToMessage —— 改错故障：只回退一半，重试时 checkpoint 基线漂移。
// INV-04 断言：工作区回退以目标消息之前的 checkpoint 为界，缺失即 Unavailable —— 守住它的位置：rewindWorkspaceToMessage 的快照选择 —— 改错故障：无快照却报成功，文件停在中间态且无提示。
// INV-05 断言：活动后缀为空时，checkpoint 候选回落到目标消息自身 —— 守住它的位置：cascade 的 suffix 计算之后 —— 改错故障：撤销最后一条消息不恢复任何文件。
// INV-06 断言：多个 checkpoint 必须先读完所有 artifact，再按创建顺序倒序写盘 —— 守住它的位置：rewindWorkspaceToCheckpoints 的两阶段 —— 改错故障：快照损坏发生在半回退之后，工作区不一致。
// INV-07 断言：单 checkpoint 直接走单点回退，不进入多段合并 —— 守住它的位置：数量为 1 的分支 —— 改错故障：多读一次快照，且合并顺序语义被改变。
// INV-08 断言：工作区 cascade 只接受 ActiveChain 与 FileOnly 两种策略 —— 守住它的位置：策略过滤，其余一律 Unavailable —— 改错故障：目标不在可回退链上仍改文件，回退范围越界。
// INV-09 断言：取消错误必须抛出，不得降级为快照不可用 —— 守住它的位置：读取 artifact 的 catch 内对取消错误的识别 —— 改错故障：用户中断被显示成目标不可回退，误导排查。
// INV-10 断言：对话回退必须有 sessionStore，没有就降级 —— 守住它的位置：buildConversationRewindPlan 开头 —— 改错故障：UI 裁了内存历史而持久事实没变，冷恢复旧分支复活。
// INV-11 断言：branch cut 记录当前最后一条持久消息，保留前缀记录目标之前的消息 —— 守住它的位置：写 revert 指针处 —— 改错故障：连续编辑或重启会把旧前缀重新浮出。
// INV-12 断言：分支代际只能单调加一，且在切点确定后立即写回运行时 —— 守住它的位置：plan 构造与 apply 的顺序 —— 改错故障：旧代际后台任务被当成新代际，继续写工作区。
// INV-13 断言：必须先停掉被移除 turn 的运行中任务，再写 revert 指针 —— 守住它的位置：applyConversationRewindPlan 的调用顺序 —— 改错故障：旧任务在新分支上继续改文件。
// INV-14 断言：任何不可用路径都不得写 branch cut、不得发 RewindTriggered —— 守住它的位置：两个 finishUnavailable 实现 —— 改错故障：live 投影裁 UI 而 store 保留旧分支，两侧永久不一致。
// INV-15 断言：对话与工作区双段回退必须两段都成功后拼接响应 —— 守住它的位置：Both 的两个返回点 —— 改错故障：用户只看到一半结果，误判失败并重复点击。
// INV-16 断言：助手锚点回溯后的有效目标才是校验与截断基准 —— 守住它的位置：buildConversationRewindPlan 的锚点重映射 —— 改错故障：edit/retry 截到助手消息，用户提示残留在新分支。
// INV-17 断言：summary 伪用户消息不能作为回退锚点 —— 守住它的位置：isRewindableUserPrompt —— 改错故障：compact 后回退命中摘要，落进压缩边界内部。
// INV-18 断言：派生状态必须全量重建，不做增量裁剪 —— 守住它的位置：rebuildConversationDerivedState 开头 —— 改错故障：压缩、读取缓存、用量统计残留旧分支引用。
// INV-19 断言：最新指针只在排除压缩保留段的 timeline 链上取 —— 守住它的位置：timeline 视图构造 —— 改错故障：续跑落到不可见消息，UI 显示错位。
// INV-20 断言：分支切换后必须置 cache miss 并重算命中聚合 —— 守住它的位置：派生状态重建尾部 —— 改错故障：新分支首次请求被记成命中，计费与统计虚高。
// INV-21 断言：轮次号用非 summary 的用户提示条数重算，文件变更与连续失败计数清零 —— 守住它的位置：重建函数末尾 —— 改错故障：压缩后轮次跳变，压缩策略被旧分支污染。
// INV-22 断言：回退说明必须同时落持久化与内存附件 —— 守住它的位置：写 synthetic notice 的两步 —— 改错故障：冷恢复缺说明，用户以为文件被他人改动。
// ----------------------------------------------------------------------------
// 读法建议：先看 INV-03（不可用先于副作用）与 INV-13（先停任务后写指针），再读正文块。
import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  activeSessionMessages,
  createMessageId,
  evaluateRewindTarget,
  hydrateMessageHistoryFromSession,
  hydrateReadFileStateFromSession,
  parseWorkspaceCheckpointArtifact,
  selectActiveConversationBranch,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  MessageWithParts,
  SessionEvent,
  TraceContext,
  TurnId,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  activeSuffixMessageIdsForRewind,
  buildMessageRewindEvaluationItems,
  createTurnCancelledError,
  formatUnavailableRewindResponse,
  formatWorkspaceRewindNoticeBody,
  getLatestActiveSessionMessageId,
  isTurnCancellationError,
  selectCheckpointForMessage,
  selectCheckpointsForMessages,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type {
  ConversationRewindResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";

export async function rewindToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult | WorkspaceRewindResult> {
  if (options.scope === RewindScope.Workspace) {
    // [契约] 纯工作区 scope 在这里直接短路由，不进入下面的 Both 拼装逻辑。
    // 看起来可以复用 Both 的拼装：那样会给只有文件回退的调用方塞入对话响应段。
    // 改错后的线上表现：TUI 对工作区撤销显示两段文案，客户端把不存在的对话回退当真。
    return this.rewindWorkspaceToMessage(options);
  }

  // Both 先回工作区；若工作区已降级为 FileOnly 则不再做 conversation 回退，
  // 保持"文件已回退、历史留在 compacted context"的一致语义。
  // [事务] Both 是两阶段：先文件快照，再对话截断，第二阶段只在前者仍为 ActiveChain 时执行。
  // 看起来该无条件继续截断：但当工作区已降级为 FileOnly，历史必须停在压缩上下文里。
  // 改错后的线上表现：文件回到目标点、对话却多裁一段，用户重放时丢失已被压缩的上下文。
  // 边界：工作区返回 Unavailable 时同样不进入第二阶段，避免只提交一半。
  if (options.scope === RewindScope.Both) {
    const workspace = await this.rewindWorkspaceToMessage(options);
    if (workspace.strategy !== RewindStrategy.ActiveChain) {
      return workspace;
    }
    const conversation = await this.rewindConversationToMessage(options);
    return {
      ...conversation,
      response: `${workspace.response}\n${conversation.response}`,
    };
  }

  return this.rewindConversationToMessage(options);
}

export async function rewindCascadeToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult | WorkspaceRewindResult> {
  if (options.scope === RewindScope.Workspace) {
    return rewindWorkspaceCascadeToMessage.call(this, options);
  }

  // cascade 先规划 conversation：不可用时必须在动 workspace 之前返回，避免只回退一半。
  if (options.scope === RewindScope.Both) {
    // [事务] cascade 的 Both 先规划对话、后动工作区，是为了让不可用判定发生在第一处副作用之前。
    // 看起来该先回文件更直观：一旦对话不可用，文件已经被改写且无法撤回。
    // 改错后的线上表现：用户看到目标不可回退，但磁盘文件已经变了，重试时的基线漂移。
    // 幂等性：计划构造只读，不写指针、不发事件，重复调用不产生任何副作用。
    const conversationPlan = await buildConversationRewindPlan.call(this, options);
    if (conversationPlan.kind === "unavailable") {
      return finishUnavailableConversationRewind.call(this, {
        evaluation: conversationPlan.evaluation,
        events: options.events,
        reason: conversationPlan.reason,
        rewindId: conversationPlan.rewindId,
        targetMessageId: options.targetMessageId,
        traceContext: options.traceContext,
      });
    }

    const workspace = await rewindWorkspaceCascadeToMessage.call(this, options);
    if (workspace.strategy !== RewindStrategy.ActiveChain) {
      return workspace;
    }
    const conversation = await applyConversationRewindPlan.call(this, {
      abortSignal: options.abortSignal,
      events: options.events,
      plan: conversationPlan,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
    return {
      ...conversation,
      response: `${workspace.response}\n${conversation.response}`,
    };
  }

  return this.rewindConversationToMessage(options);
}

// [契约] 单点文件回退：只认目标消息之前最近的一个 checkpoint，不跨范围合并。
// 事件流是 checkpoint 的权威来源，不读内存缓存，热路径与冷恢复走同一条判定。
// 边界：目标消息之前没有快照时返回 Unavailable，不猜测、不取最近快照兜底。
// [权衡] 少读一次事件存储的优化会破坏冷恢复一致性，因此这里显式全量取事件。
export async function rewindWorkspaceToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  // 事件流是 checkpoint 的权威来源：按 target message 找它之前的文件快照。
  // [资源] 这里一次性拉全量事件，会话越长成本越高，但快照选择必须看到完整前缀。
  // 看起来该按 checkpoint 建索引：索引与事件流会出现双写窗口，恢复时对不齐。
  // [失败路径] 事件读取抛错直接向上冒泡，不降级为空列表，否则会被误判成没有快照。
  // 边界：target 是首条消息时，仍以它之前的事件为界，不包含它自身产生的快照。
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const checkpoint = selectCheckpointForMessage(sessionEvents, options.targetMessageId);
  // 没有快照不能伪装成功；返回 Unavailable 让调用方明确提示"目标不可回退"。
  // [失败路径] 没有快照一律走 Unavailable，响应携带 rewindId 便于日志串联。
  // 看起来该返回成功并留空恢复列表：UI 显示已回退 0 个文件，用户以为操作生效。
  // 守住点：不可用路径不得发 RewindTriggered，否则投影与持久链会分叉。
  if (!checkpoint) {
    return this.finishUnavailableRewind({
      events: options.events,
      reason: "target_checkpoint_not_found",
      rewindId: `rewind_${crypto.randomUUID()}`,
      scope: options.scope,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  return this.rewindWorkspaceToCheckpoint({
    abortSignal: options.abortSignal,
    events: options.events,
    targetCheckpointId: checkpoint.checkpointId,
    traceContext: options.traceContext,
  });
}

async function rewindWorkspaceCascadeToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const activeMessages = await readActiveMessagesForWorkspaceRewind.call(this);
  // cascade 覆盖 target 之后的所有消息：收集活动后缀的 checkpoint，空后缀退回 target 自身。
  // [契约] cascade 覆盖面是目标消息之后的所有活动消息，不是单条消息。
  // 后缀为空说明目标就是最后一条，此时候选回落到目标自身，否则会漏掉它自己的快照。
  // 看起来该直接拿全量 checkpoint：那会跨过更早的目标，把本次范围外的文件一起回退。
  // 依赖活动链判定，旧分支消息不得进入后缀，否则回退范围被历史残留放大。
  const suffixMessageIds = activeSuffixMessageIdsForRewind(activeMessages, options.targetMessageId);
  const checkpoints = selectCheckpointsForMessages(
    sessionEvents,
    suffixMessageIds.length > 0 ? suffixMessageIds : [options.targetMessageId],
  );
  if (checkpoints.length === 0) {
    return this.finishUnavailableRewind({
      events: options.events,
      reason: "target_checkpoint_not_found",
      rewindId: `rewind_${crypto.randomUUID()}`,
      scope: options.scope,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  // 单 checkpoint 无需多段合并，直接走单点回退，避免多读一次 artifact。
  // [权衡] 只有一个快照时不做多段合并，直接单点回退，避免多读一次 artifact。
  // 看起来该统一走合并路径减少分支：合并会颠倒单快照的响应文案与事件里的目标快照。
  // 改错后的线上表现：用户看到 restoredCheckpoints 计数为 1，却出现多段恢复提示。
  // 边界：数量为 0 已在上一步返回，因此这里的首尾下标访问是安全的。
  if (checkpoints.length === 1) {
    return this.rewindWorkspaceToCheckpoint({
      abortSignal: options.abortSignal,
      events: options.events,
      targetCheckpointId: checkpoints[0]!.checkpointId,
      traceContext: options.traceContext,
    });
  }

  return rewindWorkspaceToCheckpoints.call(this, {
    abortSignal: options.abortSignal,
    checkpoints,
    events: options.events,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });
}

async function readActiveMessagesForWorkspaceRewind(
  this: AgentRuntimeInternal,
): Promise<MessageWithParts[]> {
  // 无 store 就没有活动分支语义；cascade 只作用于持久化会话，返回空让上层降级。
  // [契约] 无 store 表示没有持久化分支语义，cascade 返回空让上层降级为单点回退。
  // [权衡] 不用内存历史补位：投影裁剪后的内存副本与 sessionStore 的持久事实可能分叉，回退范围必须以 store 为准。
  // [失败路径] 不抛错是刻意的：纯内存会话仍允许文件级撤销。
  // 边界：返回空后后缀为空，上游以目标消息自身作为候选。
  if (!this.sessionStore) return [];

  const session = await this.sessionStore.getSession(this.sessionId);
  const persistedMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // 必须用 session.revert 指针还原当前活动分支，不能直接拿全量 messages（旧分支仍在 store 里）。
  return activeSessionMessages(persistedMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
}

// [事务] 两阶段提交：第一阶段只读全部快照，第二阶段才写文件。
// 回调顺序即创建顺序，首个快照是回退基线，末个快照用于事件与提示引用。
// 看起来该边读边写以省内存：可预见的读失败会落在已经改过的文件之后。
// 幂等键 rewindId 在这里生成一次，贯穿快照读取、事件与响应。
async function rewindWorkspaceToCheckpoints(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    checkpoints: CheckpointCreatedPayload[];
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<WorkspaceRewindResult> {
  // 回调顺序即创建顺序：第一个是回退基线，最后一个是错误提示/事件引用的最新快照。
  const baselineCheckpoint = options.checkpoints[0]!;
  const latestCheckpoint = options.checkpoints.at(-1)!;
  const rewindId = `rewind_${crypto.randomUUID()}`;

  // 回退依赖 artifact 与文件端口；缺任一个 fail closed，不尝试部分恢复。
  // [资源] 快照存储与文件端口缺任一个即 fail closed，不做部分恢复。
  // 看起来该跳过缺失端口继续回退另一侧：工作区停在既不完整也不可重放的状态。
  // 原因字段区分存储未配置与端口未配置，便于定位部署问题。
  if (!this.artifactStore || !this.fileSystemPort) {
    return this.finishUnavailableRewind({
      checkpoint: latestCheckpoint,
      events: options.events,
      reason: !this.artifactStore
        ? "artifact_store_not_configured"
        : "file_system_port_not_configured",
      rewindId,
      targetCheckpointId: latestCheckpoint.checkpointId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  // 再按活动消息做一次目标校验：checkpoint 存在不代表 target 仍在当前活动分支上。
  const evaluation = evaluateRewindTarget({
    checkpointAvailable: true,
    items: buildMessageRewindEvaluationItems(await readActiveMessagesForWorkspaceRewind.call(this)),
    scope: RewindScope.Workspace,
    targetMessageId: options.targetMessageId,
  });

  // 只接受 ActiveChain/FileOnly；其它策略说明目标不在可回退链上，直接 Unavailable。
  if (
    evaluation.strategy !== RewindStrategy.ActiveChain &&
    evaluation.strategy !== RewindStrategy.FileOnly
  ) {
    return this.finishUnavailableRewind({
      checkpoint: latestCheckpoint,
      evaluation,
      events: options.events,
      reason: evaluation.reason,
      rewindId,
      targetCheckpointId: latestCheckpoint.checkpointId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  // 第一阶段先完整读取全部 artifact：读失败必须发生在任何文件改动之前，工作区才不会半回退。
  // [事务] 倒序写盘：后创建的快照先写、最早的基线最后写，最终落点是回退基线。
  // 看起来该按创建顺序写：中间快照会覆盖基线，文件停在错误的版本。
  // [并发] 先复制再反转，避免就地修改调用方传入的 checkpoint 数组。
  // 边界：写盘途中取消时已写文件不回滚，所以读取阶段的失败必须前置。
  const checkpointsToRestore = [...options.checkpoints].reverse();
  const artifacts: Array<{
    checkpoint: CheckpointCreatedPayload;
    artifact: WorkspaceCheckpointArtifact;
  }> = [];
  for (const checkpoint of checkpointsToRestore) {
    // 每个快照读取前检查取消：用户中断后不再继续产生新的读盘副作用。
    throwIfTurnAborted(options.abortSignal);
    try {
      artifacts.push({
        checkpoint,
        artifact: await readWorkspaceCheckpointArtifact.call(this, {
          checkpoint,
          traceContext: options.traceContext,
          abortSignal: options.abortSignal,
        }),
      });
    // [失败路径] 取消错误向上抛，其余读取失败才降级为快照不可用。
    // 看起来该统一换成 Unavailable：用户中断会被记成目标不可回退，误导排查。
    // 降级时记录 checkpointId 与 snapshotRef，事件名对齐快照读取失败，便于比对存储。
    // 边界：这里仍是第一阶段，抛错或降级都不会留下半回退的工作区。
    } catch (error) {
      // 取消错误向上抛（不降级为 Unavailable）；其它读失败才视为"快照不可用"。
      if (isTurnCancellationError(error, options.abortSignal)) {
        throw createTurnCancelledError(error);
      }
      this.logger?.warn("Workspace cascade rewind checkpoint read failed", {
        ...traceContextToLogContext(options.traceContext),
        checkpointId: checkpoint.checkpointId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "rewind.cascade.snapshot.read.failed",
        module: "core.runtime",
        snapshotRef: checkpoint.snapshotRef,
        status: "failed",
      });
      return this.finishUnavailableRewind({
        checkpoint,
        events: options.events,
        reason: "checkpoint_snapshot_unavailable",
        rewindId,
        targetCheckpointId: checkpoint.checkpointId,
        targetMessageId: options.targetMessageId,
        traceContext: options.traceContext,
      });
    }
  }

  // [事务] 第二阶段按快照顺序恢复文件，累计结果用于提示与响应。
  // 每个快照写盘前检查取消，中断后不再产生新的文件副作用。
  // 看起来该并行写多个快照：同路径文件会互相覆盖，结果依赖调度顺序。
  // 边界：恢复列表可能为空（快照内无改动文件），仍视为成功并写通知。
  const restoredFiles: WorkspaceRewindRestoredFile[] = [];
  for (const { artifact } of artifacts) {
    throwIfTurnAborted(options.abortSignal);
    // cascade 是 UI 消息级撤销的外置高阶接口。一个消息级撤销可能跨过多个
    // 文件变更 checkpoint。先完整读取全部 artifact，再按创建顺序倒序写文件；这样
    // artifact 缺失/损坏这类可预见失败不会发生在 workspace 已经半回退之后。
    restoredFiles.push(
      ...(await this.restoreWorkspaceCheckpointArtifact(
        artifact,
        options.traceContext,
        options.abortSignal,
      )),
    );
  }

  // 回退成功后写 synthetic notice，并把"持久化消息 + 工作区事件"成对提交。
  const createdMessageId = createMessageId();
  const noticeBody = `${formatWorkspaceRewindNoticeBody({
    checkpoint: baselineCheckpoint,
    evaluation,
    restoredFiles,
    rewindId,
  })}\nrestoredCheckpoints: ${options.checkpoints.length}`;
  // notice 同时进持久化与内存附件，保证 UI 和冷恢复都能看到同一条回退说明。
  // [契约] 回退说明同时进持久化消息与内存附件，保证 UI 与冷恢复看到同一条。
  // 看起来该只写内存：冷恢复后会话里没有任何回退痕迹，用户以为文件被外部改动。
  // [事务] 说明消息的 messageId 先生成，随后事件引用它，两侧指向同一条消息。
  // 边界：说明正文附恢复文件数与快照数，供客户端做折叠展示。
  await this.persistSyntheticUserNotice(createdMessageId, noticeBody, options.traceContext);
  this.messageHistory.addAttachment("rewind_notice", noticeBody);

  // [契约] RewindTriggered 是投影唯一信号，事件必须携带基线的快照引用与策略。
  // 看起来该在文件写入前就发事件：写盘失败时投影已经裁了 UI，无法回退。
  // 事件同时推入本次 turn 的事件数组供上层转发，顺序在持久化之后。
  // 边界：FileOnly 策略下提示文案额外说明历史停在压缩上下文。
  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Workspace,
      strategy: evaluation.strategy,
      targetMessageId: options.targetMessageId,
      targetCheckpointId: baselineCheckpoint.checkpointId,
      compactBoundaryId: evaluation.compactBoundaryId,
      restoredSnapshotRef: baselineCheckpoint.snapshotRef,
      createdMessageId,
      reason: evaluation.reason,
    },
    options.traceContext,
  );
  // RewindTriggered 是投影唯一信号；同时 push 进本次 turn 的 events 供上层转发。
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  const fileText = `${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"}`;
  const checkpointText = `${options.checkpoints.length} checkpoint${options.checkpoints.length === 1 ? "" : "s"}`;
  const strategyText =
    evaluation.strategy === RewindStrategy.FileOnly
      ? " Workspace files were restored; conversation history stayed at the compacted context."
      : "";

  return {
    checkpoint: baselineCheckpoint,
    evaluation,
    restoredFiles,
    response: `Rewound workspace through ${checkpointText} to checkpoint ${baselineCheckpoint.checkpointId}: restored ${fileText}.${strategyText}`,
    rewindId,
    strategy: evaluation.strategy,
  };
}

async function readWorkspaceCheckpointArtifact(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    checkpoint: CheckpointCreatedPayload;
    traceContext: TraceContext;
  },
): Promise<WorkspaceCheckpointArtifact> {
  // artifactStore 已在调用方校验非空；取消信号必须透传（大快照读取可能耗时可观）。
  const read = await this.artifactStore!.readToolResultArtifact(
    {
      uri: options.checkpoint.snapshotRef,
      trace: options.traceContext,
    },
    { signal: options.abortSignal },
  );
  return parseWorkspaceCheckpointArtifact(JSON.parse(read.content));
}
type ConversationRewindPlan =
  | {
      // ConversationRewindResult.evaluation 是对外结果的可选字段，
      // 但 available plan 已经完成 active-chain 校验，后续落事件必须有 evaluation。
      evaluation: NonNullable<ConversationRewindResult["evaluation"]>;
      branchCutAfterMessageId: MessageId;
      branchGeneration: number;
      keptMessages: MessageWithParts[];
      kind: "available";
      persistedMessages: MessageWithParts[];
      removedTurnIds: string[];
      rewindId: string;
    }
  | {
      evaluation?: NonNullable<ConversationRewindResult["evaluation"]>;
      kind: "unavailable";
      reason: string;
      rewindId: string;
    };

// [契约] 对话回退的唯一入口：先规划、后应用，规划阶段零副作用。
// 纯对话 scope 才开启助手锚点回溯，Both 与 cascade 走严格目标校验。
// 看起来该对所有入口都开启回溯：显式 TUI 流会隐式扩大回滚范围，与预览不一致。
// [失败路径] 计划不可用时直接返回，不写 branch cut，也不发事件。
export async function rewindConversationToMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope?: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  const plan = await buildConversationRewindPlan.call(this, {
    targetMessageId: options.targetMessageId,
    // 仅纯 conversation scope 开启 assistant 锚点回溯（v4 edit/retry 路径）；
    // both/cascade 的显式流保持严格目标校验。
    remapAssistantAnchor: options.scope === undefined || options.scope === RewindScope.Conversation,
  });
  // 不可用 plan 不写任何 branch cut：否则 live 投影会裁 UI，而 store 仍保留旧分支。
  if (plan.kind === "unavailable") {
    return finishUnavailableConversationRewind.call(this, {
      evaluation: plan.evaluation,
      events: options.events,
      reason: plan.reason,
      rewindId: plan.rewindId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  return applyConversationRewindPlan.call(this, {
    abortSignal: options.abortSignal,
    events: options.events,
    plan,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });
}

// [事务] 计划构造只读：取会话、取消息、算活动链与切点，不写 revert 指针。
// 分支代际在这里加一确定，写入留给应用阶段，保证规划可重复调用。
// 看起来该把写指针放进计划里：预览与真实提交共享副作用，无法 dry run。
// 边界：没有 store 直接返回不可用，reason 单独区分，便于客户端提示。
async function buildConversationRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    targetMessageId: MessageId;
    /**
     * assistant 锚点回溯映射开关：仅纯 conversation scope（v4 editUserQuery/retryTurn
     * 的 `/rewind conversation <assistantMessageId>`）开启；cascade/both 的显式 TUI
     * 流保持严格 user prompt 目标校验（precheck reject，不隐式扩大回滚范围）。
     */
    remapAssistantAnchor?: boolean;
  },
): Promise<ConversationRewindPlan> {
  const rewindId = `rewind_${crypto.randomUUID()}`;
  // conversation rewind 必须能改持久事实；无 store 时直接降级，不做内存-only 回退。
  if (!this.sessionStore) {
    return {
      kind: "unavailable",
      reason: "conversation_rewind_requires_session_store",
      rewindId,
    };
  }

  const session = await this.sessionStore.getSession(this.sessionId);
  const persistedMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // rewind target 可以位于当前 compact boundary 之前。定位 edit target 时只能
  // 应用 append-only branch cut，compact scope 只用于 provider history，不能提前隐藏 target。
  // [契约] 只用 append-only branch cut 还原活动链，压缩边界只影响 provider 历史。
  // 回退目标可以位于当前压缩边界之前，提前隐藏目标会让编辑定位失败。
  // 看起来该直接按压缩边界裁剪：用户无法对压缩前的消息做编辑重放。
  // 边界：会话从未回退时三个指针都为空，活动链等价于全量持久消息。
  const activeMessages = selectActiveConversationBranch(persistedMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  // 在活动消息里定位 target；未命中时后续用 requestedIndex/targetIndex 区分"不存在"与"非 user prompt"。
  const requestedIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  // v4 editUserQuery/retryTurn 使用同一 turn 的 assistant messageId 作为 rewind 锚点，
  // 因为 user 行没有稳定的 messageId。将该锚点回溯到所属 turn 的 user prompt，
  // 让持久消息与运行时历史都从该 prompt 开始截断，避免编辑重跑或冷恢复时带回旧分支。
  let targetIndex = requestedIndex;
  if (
    options.remapAssistantAnchor === true &&
    requestedIndex >= 0 &&
    !isRewindableUserPrompt(activeMessages[requestedIndex]!)
  ) {
    targetIndex = -1;
    for (let index = requestedIndex - 1; index >= 0; index -= 1) {
      if (isRewindableUserPrompt(activeMessages[index]!)) {
        targetIndex = index;
        break;
      }
    }
  }
  const effectiveTargetMessageId =
    targetIndex >= 0 ? activeMessages[targetIndex]!.info.id : options.targetMessageId;
  // 用回溯后的 effective target 做最终策略判定，保证检查与截断目标一致。
  const evaluation = evaluateRewindTarget({
    items: buildMessageRewindEvaluationItems(activeMessages),
    scope: RewindScope.Conversation,
    targetMessageId: effectiveTargetMessageId,
  });

  // 任何非 ActiveChain（compact 边界/分支冲突）或 target 不在链上，都拒绝，不降级为部分回退。
  // [失败路径] 策略非 ActiveChain 或目标不在链上，一律不可用，不降级为部分回退。
  // reason 区分目标不存在、目标不是用户提示、以及评估给出的具体原因。
  // 看起来该继续按最近的用户提示兜底：截断点与用户选择不一致，属于静默越权。
  // 边界：助手锚点回溯失败时 targetIndex 为负，走同一拒绝路径。
  if (evaluation.strategy !== RewindStrategy.ActiveChain || targetIndex < 0) {
    return {
      evaluation,
      kind: "unavailable",
      reason:
        targetIndex < 0
          ? requestedIndex < 0
            ? "target_message_not_found"
            : "target_message_is_not_user_prompt"
          : evaluation.reason,
      rewindId,
    };
  }

  const targetMessage = activeMessages[targetIndex]!;
  if (!isRewindableUserPrompt(targetMessage)) {
    // 严格路径（remapAssistantAnchor 未开启）：非 user prompt 目标维持 precheck reject。
    return {
      evaluation,
      kind: "unavailable",
      reason: "target_message_is_not_user_prompt",
      rewindId,
    };
  }

  // 分支切点取当前最后一条持久消息（不裁 store），再以 generation+1 标识新分支；
  // keptMessages 是目标之前的前缀，removedTurnIds 供后续取消旧分支后台任务。
  return {
    evaluation,
    branchCutAfterMessageId: persistedMessages.at(-1)!.info.id as MessageId,
    branchGeneration: (session?.revert?.branchGeneration ?? 0) + 1,
    keptMessages: activeMessages.slice(0, targetIndex),
    kind: "available",
    persistedMessages,
    removedTurnIds: activeMessages
      .slice(targetIndex)
      .flatMap((message) =>
        message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
      ),
    rewindId,
  };
}

// [并发] 提交前再检查一次取消：切点一旦写入，无法在原分支上撤销。
// 先停旧分支后台任务、再写指针、再重建派生状态，顺序不可调整。
// 看起来该先写指针再停任务：旧任务会读到新代际并继续写工作区。
// [事务] 三段中任一步抛错都让 rewind 整体失败，不做补偿写入。
async function applyConversationRewindPlan(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    plan: Extract<ConversationRewindPlan, { kind: "available" }>;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  // 提交前检查取消：branch cut 一旦写入就不可能在原分支上回滚。
  throwIfTurnAborted(options.abortSignal);
  const {
    branchCutAfterMessageId,
    branchGeneration,
    evaluation,
    keptMessages,
    persistedMessages,
    removedTurnIds,
    rewindId,
  } = options.plan;
  // 先停旧分支后台任务（fail closed），再写 revert；否则旧任务可能继续改新分支的 workspace。
  await cancelRemovedBranchBackgroundTasks.call(this, {
    removedTurnIds,
    traceContext: options.traceContext,
  });
  // 持久化 branch cut 指针：冷恢复依赖它重建同一条活动链（不变量 #7）。
  // [契约] 指针只有这一次写入，冷恢复全靠它重建同一条活动链。
  // 保留前缀存的是本次回退前的活动前缀，只存目标与创建消息无法还原连续编辑。
  // 看起来该顺便裁掉 store 里的旧消息：历史仍需保留以便审计与分支对比。
  // 边界：保留前缀为空时，messageID 回落到调用方传入的目标消息。
  await this.sessionStore!.setRevert({
    sessionID: this.sessionId,
    revert: {
      // 只保存 target/created 无法在连续编辑或重启后还原旧 rewind 前缀。
      // keptMessageIDs 保存的是本次 rewind 前 active branch 的保留前缀，避免旧分支重新浮出。
      keptMessageIDs: keptMessages.map((message) => message.info.id as MessageId),
      branchCutAfterMessageID: branchCutAfterMessageId,
      branchGeneration,
      messageID: keptMessages.at(-1)?.info.id ?? options.targetMessageId,
      kind: "conversation_rewind",
      scope: RewindScope.Conversation,
      targetMessageID: options.targetMessageId,
    },
  });
  // 运行时与任务注册表同步新代际；旧代际的命令/通知据此被丢弃（不变量 #6）。
  this.branchGeneration = branchGeneration;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(branchGeneration);

  // 重建内存派生状态（历史、read cache、latest 指针），避免旧分支残留被下一轮继续使用。
  await rebuildConversationDerivedState.call(this, {
    branchCutAfterMessageId,
    keptMessageIds: keptMessages.map((message) => message.info.id as MessageId),
    persistedMessages,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext,
  });

  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Conversation,
      strategy: evaluation.strategy,
      targetMessageId: options.targetMessageId,
      compactBoundaryId: evaluation.compactBoundaryId,
      branchCutAfterMessageId,
      branchGeneration,
      reason: evaluation.reason,
    },
    options.traceContext,
  );
  // 只有真正提交成功后才发 RewindTriggered；失败/不可用路径不能伪造事件（见 finishUnavailable）。
  await this.appendEvent(event, options.traceContext);
  options.events.push(event);

  this.logger?.info("Conversation rewind applied", {
    ...traceContextToLogContext(options.traceContext),
    event: "rewind.conversation.completed",
    keptMessageCount: keptMessages.length,
    branchGeneration,
    module: "core.runtime",
    status: "completed",
    targetMessageId: options.targetMessageId,
  });

  return {
    evaluation,
    keptMessageCount: keptMessages.length,
    response: `Rewound conversation to before message ${options.targetMessageId}.`,
    rewindId,
    strategy: evaluation.strategy,
    targetMessageId: options.targetMessageId,
  };
}

async function cancelRemovedBranchBackgroundTasks(
  this: AgentRuntimeInternal,
  options: { removedTurnIds: string[]; traceContext: TraceContext },
): Promise<void> {
  const removed = new Set(options.removedTurnIds);
  // 没有移除任何 turn 时无事可做，避免无意义的全表扫描。
  if (removed.size === 0) return;
  // 只停"当前代际 + 被移除 turn + running"的任务；其它代际的任务已随分支废弃（不变量 #6）。
  // [并发] 只停当前代际、被移除 turn、且仍在运行的任务。
  // 看起来该按 turn 全停：其它代际任务已随分支废弃，误停会打断新分支。
  // 边界：任务没有 turnId 时不参与匹配，避免误伤会话级任务；空移除集合直接返回。
  const tasks = Object.values(this.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.branchGeneration === this.branchGeneration &&
      task.turnId !== undefined &&
      removed.has(String(task.turnId)) &&
      task.status === "running",
  );
  for (const task of tasks) {
    const result = await this.stopBackgroundTask(task.taskId, {
      traceContext: options.traceContext,
    });
    // 停不掉就整体失败：宁可 rewind 失败，也不能让旧分支任务继续写 workspace。
    if (!result.ok) {
      // fail closed：无法确认旧分支后台工作已停时，不提交 branch cut，也不碰 workspace。
      throw new Error(`rewind background task cancellation failed: ${task.taskId}`);
    }
  }
}

async function finishUnavailableConversationRewind(
  this: AgentRuntimeInternal,
  options: {
    evaluation?: NonNullable<ConversationRewindResult["evaluation"]>;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<ConversationRewindResult> {
  // 失败/冲突不是一次已经提交的 branch cut，不能伪造 RewindTriggered。
  // 否则 live projection 会裁 UI，而 store/provider history 仍保留旧分支。
  return {
    evaluation: options.evaluation,
    keptMessageCount: 0,
    response: formatUnavailableRewindResponse(options.reason, undefined, options.targetMessageId),
    rewindId: options.rewindId,
    strategy: options.evaluation?.strategy ?? RewindStrategy.Unavailable,
    targetMessageId: options.targetMessageId,
  };
}

// [契约] 派生状态全量重建：历史、读取缓存、最新指针、用量聚合、轮次号。
// 看起来该增量裁剪以省开销：压缩与缓存都可能持有旧分支引用。
// 重建基于持久消息加本次分支参数，不基于内存现状，避免二次污染。
// [事务] 重建发生在指针写入之后，失败即整体 rewind 失败。
async function rebuildConversationDerivedState(
  this: AgentRuntimeInternal,
  options: {
    branchCutAfterMessageId: MessageId;
    keptMessageIds: MessageId[];
    persistedMessages: MessageWithParts[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const branchOptions = {
    branchCutAfterMessageId: options.branchCutAfterMessageId,
    rewindKeptMessageIds: options.keptMessageIds,
    rewindTargetMessageId: options.targetMessageId,
  };

  // branch 重建，避免 compact/microcompact/read cache 或 provider usage 泄漏旧分支。
  // 全量重建而非增量裁剪：上述派生状态都可能持有旧分支引用。
  this.messageHistory.reset();
  // 从持久消息重新水合内存历史，branchOptions 保证只恢复保留前缀。
  await hydrateMessageHistoryFromSession({
    artifactStore: this.artifactStore,
    history: this.messageHistory,
    messages: options.persistedMessages,
    ...branchOptions,
  });
  // read cache 也必须按分支重算，否则 read 工具会把已回退的文件当成已读。
  await hydrateReadFileStateFromSession({
    messages: options.persistedMessages,
    readFileState: this.readFileState,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
    ...branchOptions,
  });
  rebuildContextPrefix(this);
  this.injectTargetStateIntoMessageHistory(
    await this.readSessionTargetForContext(options.traceContext),
  );

  const activeMessages = activeSessionMessages(options.persistedMessages, branchOptions);
  // latest 指针只在 timeline 可见链上取（排除 compact preserved segment），与冷恢复口径一致（不变量 #7）。
  const timelineActiveMessages = activeSessionMessages(options.persistedMessages, {
    ...branchOptions,
    includeCompactPreservedSegment: false,
  });
  // assistant 指针与完成时间用于续跑/UI，必须指向保留链上的最后一条 assistant。
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;
  // 分支已变，provider cache 失效，必须按 miss 计费。
  this.messageHistory.setCacheMiss();
  // 重新聚合 cache 命中统计，不能沿用旧分支的 usage。
  // [契约] 命中聚合必须按新活动链重算，不能沿用旧分支的用量。
  // 看起来该保留旧统计做对比：客户端会把旧分支命中算进新分支，计费虚高。
  // 边界：活动链比持久消息少时，聚合只统计可见部分。
  // 轮次号随后用非 summary 的用户提示条数重算，与活动链口径一致。
  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: options.persistedMessages,
  });
  // turnNumber 用非 summary 的 user prompt 条数重算，保持与活动链一致。
  this.turnNumber = activeMessages.filter(
    (message) => message.info.role === "user" && !message.info.summary,
  ).length;
  // 本轮文件变更与失败计数属于旧分支，重置避免影响新分支的 compact 策略。
  this.currentTurnFileChanges = new Map();
  this.autoCompactConsecutiveFailures = 0;
}

// [契约] summary 是压缩注入的伪用户消息，不能作为回退锚点。
// 改错后的线上表现：回退落到摘要上，截断点位于压缩边界内部，历史无法自洽。
// 边界：角色判断与摘要标记同时成立才算可回退提示，缺一即拒绝。
function isRewindableUserPrompt(message: MessageWithParts): boolean {
  // summary 是 compact 注入的伪 user 消息，不能作为 rewind 锚点（不变量 #8）。
  return message.info.role === "user" && !message.info.summary;
}
