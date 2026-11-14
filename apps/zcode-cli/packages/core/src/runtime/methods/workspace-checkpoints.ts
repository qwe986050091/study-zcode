/**
 * ============================================================================
 * runtime/methods/workspace-checkpoints.ts —— 工作区检查点、消息复制与 fork 编排
 * ============================================================================
 *
 * 【checkpoint 是什么】
 *   CheckpointCreated 事件里带 snapshotRef(artifact 引用),artifact 内容是一组
 *   文件快照(files: path + beforeContent/afterContent 等)。它描述"某个消息点
 *   工作区是什么样",用于 rewind 与 fork。
 *
 * 【两种 fork 语义(最容易混淆)】
 *   message 目标(targetMessageId):历史包含目标回合,工作区停在 fork 点**之后**——
 *     不能恢复目标回合自己的 beforeContent,否则会把该回合刚产出的文件删掉;
 *   checkpoint 目标(/fork latest、targetCheckpointId):rewind 式语义,
 *     回到该 checkpoint **修改前**。
 *   代码里两种目标的差异全部在 forkWorkspaceFromCheckpoint 开头分派。
 *
 * 【复制的关键】message/part 都要换新 id,并用 messageIdMap 重写 parentID/引用;
 *   否则子会话会指向父会话的消息,分叉后编辑/删除会互相污染。
 * ============================================================================
 */
import {
  CoreErrorType,
  RewindScope,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  getCurrentTraceContext,
  parseCheckpointCreatedPayload,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  SessionId,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointForRewind,
  previewTextFromMessage,
  formatWorkspaceForkNoticeBody,
  cloneMessageForFork,
  clonePartForFork,
} from "../helpers/index.js";
import {
  buildForkHistoryMessages,
  copyGoalStateForFork,
  createForkedSession,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork.js";
import { forkWorkspaceAtMessage, restoreWorkspaceCheckpointFiles } from "./workspace-fork.js";
import type {
  WorkspaceRewindRestoredFile,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function restoreWorkspaceCheckpointArtifact(
  this: AgentRuntimeInternal,
  artifact: WorkspaceCheckpointArtifact,
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<WorkspaceRewindRestoredFile[]> {
  // 只做文件层恢复(写回/删除),不碰会话历史;
  // 历史侧由 rewind/fork 的调用方负责,两者分开是为了让"只恢复文件"的入口可复用。
  return await restoreWorkspaceCheckpointFiles(this, artifact.files, traceContext, abortSignal);
}

export async function copySessionMessagesForFork(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  },
): Promise<{
  copiedMessageCount: number;
  messageIdMap: Map<MessageId, MessageId>;
}> {
  // 静默降级：调用方必须把 copiedMessageCount=0 当作"历史没复制"，
  // 不能据此认为子会话已可用（store 缺席时只能保留 child 元数据）。
  if (!this.sessionStore) {
    return { copiedMessageCount: 0, messageIdMap: new Map() };
  }

  const messageIdMap = new Map<MessageId, MessageId>();
  let copied = 0;
  for (const message of options.messages) {
    // 每条消息换新 id,并先写入 map:后面的 part 复制与 parentID 重写
    // 都依赖这张 map,顺序反了会复制出悬空引用。
    const nextMessageId = createMessageId();
    messageIdMap.set(message.info.id, nextMessageId);
    await this.persistMessage(
      cloneMessageForFork(message.info, {
        forkedSessionId: options.forkedSessionId,
        messageIdMap,
        nextMessageId,
      }),
      options.traceContext,
      // copyFrom 只带"源消息坐标",让 store 复制大字段而不必重新序列化;
      // 这是跨会话复制的性能关键,也避免文本被二次转义。
      { sessionID: message.info.sessionID, id: message.info.id },
    );

    // part 逐条复制：copyFrom 让 store 复用源内容而不重新序列化；
    // 逐条 await 保证子消息不会出现"有 message 无 part"的中间态（legacy 路径非原子）。
    for (const part of message.parts) {
      await this.persistPart(
        clonePartForFork(part, {
          forkedSessionId: options.forkedSessionId,
          nextMessageId,
          messageIdMap,
        }),
        options.traceContext,
        { sessionID: part.sessionID, id: part.id },
      );
    }
    copied += 1;
  }

  return { copiedMessageCount: copied, messageIdMap };
}

export async function listWorkspaceCheckpoints(
  this: AgentRuntimeInternal,
  options: { limit?: number } = {},
): Promise<WorkspaceCheckpointSummary[]> {
  // checkpoint 只存在于事件流里(CheckpointCreated),不从 message 表反推:
  // 事件是唯一权威来源,message/part 只是它的产物。
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const previews = await this.loadCheckpointMessagePreviews();
  const summaries = sessionEvents
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      return { checkpoint, timestamp: event.timestamp };
    })
    // 只保留 workspace/both：session-only checkpoint 的回退语义不同，
    // 混进列表会让 /rewind 选中一个"只能回历史、不能回文件"的目标。
    .filter(
      ({ checkpoint }) =>
        checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both,
    )
    .map(({ checkpoint, timestamp }) => ({
      checkpointId: checkpoint.checkpointId,
      compactBoundaryId: checkpoint.compactBoundaryId,
      // coveredByCompact=true 表示该 checkpoint 对应的消息已被压缩摘要覆盖,
      // UI 需要据此禁用/提示"回退到这里只能恢复文件,历史已不可展开"。
      coveredByCompact: checkpoint.coveredByCompact,
      createdAt: timestamp,
      diffRef: checkpoint.diffRef,
      fileCount: checkpoint.fileCount,
      messageId: checkpoint.messageId,
      targetMessageId: checkpoint.targetMessageId,
      toolMessageId: checkpoint.toolMessageId,
      // preview 优先取 targetMessageId(真正被回退的那条消息),
      // 缺失时退回 messageId(checkpoint 挂载点)。
      preview: previews.get(checkpoint.targetMessageId ?? checkpoint.messageId),
      scope: checkpoint.scope,
      snapshotRef: checkpoint.snapshotRef,
    }))
    // 事件流是时间正序;对外列表按"最新在前"展示,所以反转而不是排序。
    .reverse();

  // 先反转再切片：limit 是"最新 N 条"，不是事件流里最早的 N 条。
  return options.limit && options.limit > 0 ? summaries.slice(0, options.limit) : summaries;
}

export async function forkWorkspaceFromCheckpoint(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  } = {},
): Promise<WorkspaceForkResult> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;

  // message 目标的 fork 语义是"历史包含目标回合，工作区停在 fork 点时刻"。
  // 恢复目标回合自身 checkpoint 的 beforeContent 会把该回合刚产出的文件回退/删除——
  // fork 与父会话共用工作区目录，父会话的产物也随之丢失（在最新回复上分叉时最明显）。
  // message fork 只撤销 fork 点之后的 checkpoint；显式 checkpoint 目标（/fork latest、
  // targetCheckpointId）仍保留"回到该 checkpoint 修改前"的 rewind 式语义。
  if (options.targetMessageId && !options.targetCheckpointId) {
    return await forkWorkspaceAtMessage.call(this, {
      abortSignal: options.abortSignal,
      forkedSessionId: options.forkedSessionId,
      targetMessageId: options.targetMessageId,
      traceContext,
    });
  }

  // checkpoint 只从事件流选取：CheckpointCreated 是唯一权威来源，
  // 从 message 表反推会在 compact/rewind 后选中已被覆盖的旧快照。
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  const checkpoint = selectCheckpointForRewind(sessionEvents, options.targetCheckpointId);

  if (!checkpoint) {
    // recoverable=true：用户还可以换目标，不能把"没选到 checkpoint"当成会话损坏。
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      options.targetCheckpointId
        ? `Checkpoint not found: ${options.targetCheckpointId}`
        : "No workspace checkpoint is available yet.",
      {
        context: {
          targetCheckpointId: options.targetCheckpointId,
          targetMessageId: options.targetMessageId,
        },
        recoverable: true,
      },
    );
  }

  // 三件套缺一不可：复制历史要 sessionStore、读快照要 artifactStore、恢复文件要
  // fileSystemPort；任一缺失都只能产出半成品子会话，所以提前失败而不是部分执行。
  if (!this.sessionStore || !this.artifactStore || !this.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Fork requires session, artifact, and file-system adapters.",
      {
        context: {
          hasArtifactStore: Boolean(this.artifactStore),
          hasFileSystemPort: Boolean(this.fileSystemPort),
          hasSessionStore: Boolean(this.sessionStore),
        },
        recoverable: true,
      },
    );
  }

  // 父会话必须仍可读：child 的 parentID 指向它，父行被软删后 fork 出来的子会话
  // 将没有可追溯来源（V4 列表也无法归组）。
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const read = await this.artifactStore.readToolResultArtifact(
    {
      uri: checkpoint.snapshotRef,
      trace: traceContext,
    },
    { signal: options.abortSignal },
  );
  // artifact 内容是 JSON 快照;parse 成强类型后只依赖其中的 files 列表,
  // 不信任其它字段(快照是跨包契约,老版本可能缺字段)。
  const artifact = parseWorkspaceCheckpointArtifact(JSON.parse(read.content));
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  // 编辑重发后 session store 会保留被 rewind 掉的旧分支。
  // fork 复制历史必须基于 active branch，否则子会话会重新带入旧 prompt 和被取消的 assistant。
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetMessageIdResolved = checkpoint.targetMessageId ?? checkpoint.messageId;
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === targetMessageIdResolved,
  );
  // 目标必须落在活动分支上：被 rewind 掉的旧消息仍在 store 里，但不在
  // forkSourceMessages 中；直接报错，不能悄悄回退到别的历史点。
  if (targetIndex < 0) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Checkpoint message not found in session store: ${targetMessageIdResolved}`,
      {
        context: {
          checkpointId: checkpoint.checkpointId,
          messageId: targetMessageIdResolved,
        },
        recoverable: true,
      },
    );
  }

  // 先建 child 再复制消息：legacy 路径非原子，后续任一步失败都会留下空/半成品
  // 子会话；调用方（及用户）必须容忍这种残留，stable 路径正是为消除它而存在。
  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });

  // fork 历史结束点:message/checkpoint 两种语义共用同一段"目标及之前"的历史,
  // 区别只在工作区恢复范围(见函数开头的分派)。
  const forkHistoryEndIndex = resolveForkHistoryEndIndex(forkSourceMessages, targetIndex, false);
  const forkHistoryMessages = buildForkHistoryMessages(
    parentMessages,
    forkSourceMessages,
    targetIndex,
    forkHistoryEndIndex,
  );
  // 历史复制失败会让 child 只有部分消息；这里不重试也不回滚，
  // 因为后续所有读取都按 active branch 选择器过滤（不变量 8 的依赖前提）。
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext,
  });
  // goal 复制是独立步骤：store 不支持 cloneTargetForFork 时静默跳过，
  // child 将没有 goal 状态（legacy 路径可接受的降级）。
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext,
  });
  // 文件恢复发生在历史复制之后：这里失败时 child 已 durable 但工作区未回退，
  // 结果会作为错误返回，child 保留供排障（不做隐式删除）。
  const restoredFiles = await this.restoreWorkspaceCheckpointArtifact(
    artifact,
    traceContext,
    options.abortSignal,
  );
  const copiedTargetMessageId = messageIdMap.get(targetMessageIdResolved);
  const forkTimelineCreated = Date.now();
  // 分隔卡与提示都写进**子会话**,不在父会话里插入任何内容:
  // 父会话的历史保持原样,子会话从 fork 点继续,UI 用分隔卡说明来源。
  // partID 从 parentSession + targetMessage + checkpoint 派生,重复 fork 同一目标时稳定。
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(targetMessageIdResolved)}_${checkpoint.checkpointId}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: targetMessageIdResolved,
      targetCheckpointId: checkpoint.checkpointId,
      restoredFileCount: restoredFiles.length,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatWorkspaceForkNoticeBody({
      checkpoint,
      parentSessionId: this.sessionId,
      restoredFiles,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: targetMessageIdResolved,
        targetCheckpointId: checkpoint.checkpointId,
        restoredFileCount: restoredFiles.length,
      },
    },
    traceContext,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      // 事件发在父会话的事件流里并记录双方 id:父会话要能回溯"哪些子会话由我分出",
      // 子会话的 projection 靠自己的 timeline/提示来还原来源。
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: forkHistoryEndIndex,
      targetMessageId: targetMessageIdResolved,
      targetCheckpointId: checkpoint.checkpointId,
      restoredSnapshotRef: checkpoint.snapshotRef,
      restoredFileCount: restoredFiles.length,
      strategy: RewindStrategy.ForkRequired,
    },
    traceContext,
  );
  // 事件发在父会话流里，是"父会话确实分出过这个 child"的 durable 记录；
  // 子会话不写此事件，靠自己的 fork timeline/notice 还原来源。
  await this.appendEvent(forkedEvent, traceContext);

  const response = `Forked session ${forkedSessionId} from checkpoint ${checkpoint.checkpointId}: copied ${copiedMessageCount} messages and restored ${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"}.`;
  return {
    checkpoint,
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: targetMessageIdResolved,
    targetCheckpointId: checkpoint.checkpointId,
    restoredFiles,
    response,
  };
}

export async function loadCheckpointMessagePreviews(
  this: AgentRuntimeInternal,
): Promise<Map<MessageId, string>> {
  // 无 store 时 preview 为空：列表仍能展示 checkpointId/diffRef，
  // 但不能据此判断"没有可回退消息"。
  if (!this.sessionStore) return new Map();

  const messages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const messagesById = new Map(messages.map((message) => [message.info.id, message]));
  const previews = new Map<MessageId, string>();

  for (const message of messages) {
    // assistant 消息本身通常没有可展示文本(文本在 part 里,或它是纯 tool call),
    // 所以预览退回它的 parentID(user 消息):列表里显示"这一轮用户问了什么"
    // 比显示一条空白 assistant 更有意义。
    const source =
      message.info.role === "assistant" ? messagesById.get(message.info.parentID) : message;
    const preview = source ? previewTextFromMessage(source) : undefined;
    if (preview) {
      previews.set(message.info.id, preview);
    }
  }

  return previews;
}
