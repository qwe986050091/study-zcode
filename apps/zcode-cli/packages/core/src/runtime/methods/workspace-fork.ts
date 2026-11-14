// INV-01 先读全快照再动文件：守住位置 两阶段；改错故障 半途失败留下中间态工作区。
// INV-02 缺端口即配置错误：守住位置 前置判断；改错故障 恢复静默跳过却报告成功。
// INV-03 每文件前查取消：守住位置 循环首行；改错故障 取消后继续写剩余文件。
// INV-04 原来不存在就删除：守住位置 分支；改错故障 fork 后残留不该存在的文件。
// INV-05 删除允许缺失：守住位置 missingOk；改错故障 外部已删文件导致整体失败。
// INV-06 写入必须原子：守住位置 参数；改错故障 中断留下半截文件。
// INV-07 只撤销 fork 点之后的检查点：守住位置 切片；改错故障 目标回合自身改动被回退。
// INV-08 历史前缀命中即视为之前：守住位置 集合差；改错故障 跨 turn 检查点被误回退。
// INV-09 同文件取最早 before：守住位置 映射写入；改错故障 恢复成较晚状态而非 fork 点。
// INV-10 无后续检查点走纯对话 fork：守住位置 早退；改错故障 无谓改盘或直接报错。
// INV-11 缺 artifact 与文件端口整体失败：守住位置 判断；改错故障 部分恢复被当成成功。
// INV-12 子会话先建：守住位置 副作用顺序；改错故障 消息复制缺目标会话。
// INV-13 消息复制产出 id 映射：守住位置 解构；改错故障 goal 锚点仍指向父会话。
// INV-14 文件恢复排在复制之后：守住位置 调用顺序；改错故障 复制失败但文件已改。
// INV-15 三条路径都要写 fork 时间线：守住位置 持久化；改错故障 冷恢复边界形态漂移。
// INV-16 通知只带受控标识：守住位置 metadata；改错故障 文件内容被复制进事件。
// INV-17 事件最后落库：守住位置 appendEvent；改错故障 订阅者跳转到尚未建好的会话。
// INV-18 forkPoint 用历史结束下标：守住位置 事件字段；改错故障 子会话历史长度对不上。
//
// 模块职责：在指定消息处 fork 会话，并把工作区文件恢复到该点状态。
// 状态所有权：无长驻状态；读写都经 runtime 注入的端口。
// 阅读顺序：先看文件恢复，再看 fork 主流程，最后看两阶段副作用顺序。
/**
 * ============================================================================
 * runtime/methods/workspace-fork.ts —— 在消息点 fork 工作区（文件恢复 + 会话分叉）
 * ============================================================================
 * 【定位】链路 6：把父会话复制到 fork 点，并把工作区文件回退到该点“之后”应有的状态，
 *   再写 session_fork timeline、notice 与 SessionForked 事件，保持三条 fork 路径同形。
 * 【关键点】只有 fork 点之后的 checkpoint 才回退；同一文件取最早一份 beforeContent。
 * 【关键不变量】#8：消息复制走 id map，文件状态与 message 历史必须同时落在 fork 点。
 * 【失败语义】先读全 artifact 再产生副作用：任一缺失整体失败，不留半 fork 的工作区。
 * ============================================================================
 */
import {
  CoreErrorType,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  MessageId,
  SessionId,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import {
  selectCheckpointsForMessages,
  formatWorkspaceForkAtMessageNoticeBody,
  throwIfTurnAborted,
} from "../helpers/index.js";
import {
  buildForkHistoryMessages,
  copyGoalStateForFork,
  createForkedSession,
  forkConversationFromMessage,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork.js";
import type { WorkspaceRewindRestoredFile, WorkspaceForkResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function restoreWorkspaceCheckpointFiles(
  runtime: AgentRuntimeInternal,
  files: WorkspaceCheckpointArtifact["files"],
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
// runtime.fileSystemPort 缺失时抛 ConfigurationError，不能假装成功。
// files 按数组顺序逐个恢复，顺序影响同路径覆盖结果。
// 每个文件处理前检查 abortSignal，支持中途取消。
// 快照里原本不存在的文件走 unlink 删除分支。
// 其余文件走原子写入，并把写入字节数回执给调用方。
): Promise<WorkspaceRewindRestoredFile[]> {
  // 文件恢复是这条路径唯一的工作区副作用；没有 fs port 就报配置错误，不能假装成功。
  if (!runtime.fileSystemPort) {
    throw createCoreError(CoreErrorType.ConfigurationError, "FileSystemPort is not configured", {
      recoverable: true,
    });
  }

  const restoredFiles: WorkspaceRewindRestoredFile[] = [];
  for (const file of files) {
    // 每个文件前检查取消：半途取消会留下部分回退的工作区，必须尽早抛而不是继续写。
    throwIfTurnAborted(abortSignal);
    // 快照记录“当时不存在” → 删除；missingOk 让已被外部删掉的文件不算失败。
    if (!file.existedBefore || file.beforeContent === null) {
      await runtime.fileSystemPort.removeFile(
        {
          path: file.path,
          missingOk: true,
          trace: traceContext,
        },
        { signal: abortSignal },
      );
      restoredFiles.push({
        action: "delete",
        path: file.path,
      });
      continue;
    }

    // atomic 写避免中断留下半截文件；bytesWritten 只是回执，不参与成功判定。
    const write = await runtime.fileSystemPort.writeTextFile(
      {
        path: file.path,
        content: file.beforeContent,
        createParents: true,
        atomic: true,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    restoredFiles.push({
      action: "restore",
      bytesWritten: write.bytesWritten,
      path: file.path,
    });
  }

  return restoredFiles;
}

export async function forkWorkspaceAtMessage(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  },
// 会话存储与父会话都必须存在。
// 以落库消息作为 fork 源。
// 目标消息缺失判定为非法状态。
// 历史结束下标交给共享 helper。
// 检查点只从事件流读取。
): Promise<WorkspaceForkResult> {
  // fork 必须写子会话；没有 session adapter 就不可能产生任何 durable 事实。
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  // 父会话必须已落库：后续消息复制与 goal 复制都以它为上下文。
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  // SessionNotFound 是可恢复错误（会话可能已被删除或未持久化），交给上层转成用户提示。
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  // 以 durable transcript 为准而不是内存 history；fork 必须基于已落库的事实。
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  // 目标消息必须出现在 fork 源里；找不到说明被 compact/rewind 改写过，不能凭空造 fork 点。
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      `Fork target message not found in session store: ${options.targetMessageId}`,
      {
        context: {
          messageId: options.targetMessageId,
        },
        recoverable: true,
      },
    );
  }

  // 结束下标由共享 helper 裁决（含 assistant 补齐规则），避免本文件另写一套边界算法。
  const forkHistoryEndIndex = resolveForkHistoryEndIndex(forkSourceMessages, targetIndex, true);
  // checkpoint 只来自事件流；与 sessionStore 读的是同一个 sessionId。
  const sessionEvents = await this.eventStore.getEvents(this.sessionId);
  // fork 点之后的 checkpoint 才需要撤销。目标回合自身的 checkpoint 属于已复制的历史，
  // 必须保留其产物；一个 checkpoint 可能同时挂在 assistant / tool 消息上，凡是命中
  // 历史前缀的都按"fork 点之前"处理，避免跨界 turn 被误回退。
  const historyMessageIds = forkSourceMessages
    .slice(0, forkHistoryEndIndex)
    .map((message) => message.info.id);
  const historyCheckpointIds = new Set(
    selectCheckpointsForMessages(sessionEvents, historyMessageIds).map(
      (checkpoint) => checkpoint.checkpointId,
    ),
  );
  const laterMessageIds = forkSourceMessages
    .slice(forkHistoryEndIndex)
    .map((message) => message.info.id);
  const laterCheckpoints = selectCheckpointsForMessages(sessionEvents, laterMessageIds).filter(
    (checkpoint) => !historyCheckpointIds.has(checkpoint.checkpointId),
  );

  if (laterCheckpoints.length === 0) {
    // fork 点之后没有文件变更，工作区已经处于 fork 点状态：等价纯对话 fork，不碰任何文件。
    return await forkConversationFromMessage.call(this, {
      forkedSessionId: options.forkedSessionId,
      targetMessageId: options.targetMessageId,
      traceContext: options.traceContext,
    });
  }

  // 有 checkpoint 要回退就必须同时能读 artifact、写文件；缺一个都只能整体失败。
  if (!this.artifactStore || !this.fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Fork requires session, artifact, and file-system adapters.",
      {
        context: {
          hasArtifactStore: Boolean(this.artifactStore),
          hasFileSystemPort: Boolean(this.fileSystemPort),
          hasSessionStore: true,
        },
        recoverable: true,
      },
    );
  }

  // 先读全所有快照、再产生任何副作用：任何一个 artifact 缺失都让 fork 整体失败，
  // 避免文件写到一半停在既不是 fork 点也不是当前态的中间状态。
  const artifacts: WorkspaceCheckpointArtifact[] = [];
  for (const checkpoint of laterCheckpoints) {
    // 读取阶段取消是安全的：此时尚未改动任何文件，抛出让 fork 整体失败即可重试。
    throwIfTurnAborted(options.abortSignal);
    // artifact 读取受 abortSignal 约束；任一缺失或 JSON 损坏都会让整个 fork 失败。
    const read = await this.artifactStore.readToolResultArtifact(
      {
        uri: checkpoint.snapshotRef,
        trace: options.traceContext,
      },
      { signal: options.abortSignal },
    );
    artifacts.push(parseWorkspaceCheckpointArtifact(JSON.parse(read.content)));
  }

  // 文件在 fork 点时刻的状态 = fork 点之后第一次变更记录的 before 状态；
  // 同一文件多次变更时只应用最早那份，后面的都被它覆盖。
  // earliestFileByPath 先读全全部快照，再开始任何写入。
  // 同一 file.path 只保留第一次出现的快照。
  // 后出现的变更被首次覆盖，等价于 fork 点状态。
  // 结果即 fork 点应有的文件状态。
  // 映射顺序不影响正确性。
  const earliestFileByPath = new Map<string, WorkspaceCheckpointArtifact["files"][number]>();
  for (const artifact of artifacts) {
    for (const file of artifact.files) {
      if (!earliestFileByPath.has(file.path)) {
        earliestFileByPath.set(file.path, file);
      }
    }
  }

  // 从这里开始产生 durable 副作用：先建子会话，再复制消息/目标，最后才改工作区文件。
  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });
  const forkHistoryMessages = buildForkHistoryMessages(
    parentMessages,
    forkSourceMessages,
    targetIndex,
    forkHistoryEndIndex,
  );
  // 复制会重写 message/part id 并返回 messageIdMap；后面的 goal 与 timeline 都靠它指向子会话。
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  // goal 快照同样要映射到子会话消息 id，避免 target 的 anchor 继续指向父会话。
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  // 文件恢复是唯一改工作区的步骤，放在消息与目标都复制成功之后，确保之前失败不会动文件。
  const restoredFiles = await restoreWorkspaceCheckpointFiles(
    this,
    Array.from(earliestFileByPath.values()),
    options.traceContext,
    options.abortSignal,
  );
  // 三路径归一：forkWorkspaceAtMessage 不能只写 synthetic notice、不写
  // session_fork timeline part（与另外两条 fork 路径不一致，冷恢复 fork 边界形态漂移）。
  // 子会话里对应 fork 目标的新 message id；timeline 与 notice 都以它为锚点。
  // copiedTargetMessageId 是子会话里对应目标消息的新 id。
  // session_fork timeline 与通知共用同一个 copiedTargetMessageId 锚点。
  // notice 只写受控标识，不透传整条消息内容。
  // session_fork 事件在 timeline 与 notice 全部写完之后写入。
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  // 三条 fork 路径都必须留下 session_fork timeline，否则冷恢复后的 fork 边界形态不一致。
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
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
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  // 用户可见的 fork 说明；metadata 只放受控标识，不复制文件内容。
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatWorkspaceForkAtMessageNoticeBody({
      parentSessionId: this.sessionId,
      restoredFiles,
      targetMessageId: options.targetMessageId,
      undoneCheckpointCount: laterCheckpoints.length,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: restoredFiles.length,
      },
    },
    traceContext: options.traceContext,
  });

  // 父会话的 SessionForked 用 forkHistoryEndIndex 作 forkPoint，与子会话历史长度对齐。
  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: forkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: restoredFiles.length,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  // 事件最后落库：此时子会话与文件都已就绪，订阅者收到事件即可直接跳转。
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles,
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages and restored ${restoredFiles.length} file${restoredFiles.length === 1 ? "" : "s"} to the fork point.`,
  };
}
