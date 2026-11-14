/**
 * ============================================================================
 * contracts/events/event-reducer-helpers.ts —— 投影变换的"合并规则"实现
 * ============================================================================
 *
 * event-reducer 只负责"事件类型 → handler"，而真正需要幂等/合并的复合状态
 * （压缩边界、流式工具账本、后台任务）放在这里。拆出来的目的：
 *   - 这些变换被 live 与 cold 两条路径同时调用，规则必须只有一份；
 *   - 合并规则比 dispatch 更容易出错，独立成文件便于单测覆盖。
 *
 * 【通用合并语义】upsert + 保留旧字段：
 *   - started 是"新建/重置"，与旧记录同 taskId 时整条替换；
 *   - updated/completed 是"增量合并"，只覆盖 payload 里非 undefined 的字段，
 *     避免 15 秒一次的进度事件把 started 里的 command/pid 等静态信息冲掉。
 * ============================================================================
 */

import type { CompactBoundaryPayload } from "../compact/index.js";
import { parseCompactBoundaryPayload } from "../compact/index.js";
import type {
  ActiveToolCall,
  CollaborationMode,
  PendingPermission,
  PendingSteerInputInfo,
  SessionProjection,
  SessionStatus,
} from "../interfaces/session.port.js";
import type {
  BackgroundTaskCompletedPayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

/**
 * 冷启动基线：把"没有任何事件"时的会话投影固化成一份可复制的字面量。
 *
 * 生产者在 EventReducer.reduce 里浅拷贝它作为折叠起点；消费者是 live apply 与
 * cold reduce 两条路径——两者必须从同一基线出发，否则同一事件流会得到两种终态。
 *
 * 字段口径：createdAt/updatedAt 是"投影可见的会话时间"，不是事件时间；初始用
 * 构造时刻占位，SessionCreated 到达后会被事件时间覆盖。status 初始 idle、
 * turnCount/totalTokenCount/contextUsed 归零，保证 reduce 空事件流时 UI 仍能渲染
 * 一个"未开始"会话。contextWindow=200000 只是占位，真正的窗口由 SessionCreated
 * 的 payload 覆盖，不能把它当成任何模型的实际上限。
 *
 * 所有数组字段必须是新实例（不能共享同一个引用），因为 handler 总是"返回新对象"
 * 而不是原地 push；若复用同一数组，多次 reduce 会互相污染（冷恢复读到 live 的残留）。
 */
export const initialSessionProjection = {
  createdAt: new Date(),
  updatedAt: new Date(),
  mode: "build" as CollaborationMode,
  status: "idle" as SessionStatus,
  turnCount: 0,
  totalTokenCount: 0,
  contextUsed: 0,
  contextWindow: 200000,
  pendingPermissions: [] as PendingPermission[],
  pendingSteerInputs: [] as PendingSteerInputInfo[],
  activeToolCalls: [] as ActiveToolCall[],
  streamingToolLedger: [] as SessionProjection["streamingToolLedger"],
  backgroundTasks: [] as SessionProjection["backgroundTasks"],
  currentTurnId: undefined as string | undefined,
  lastError: undefined as SessionProjection["lastError"],
  lastCompact: undefined as SessionProjection["lastCompact"],
  lastCheckpoint: undefined as SessionProjection["lastCheckpoint"],
  lastStreamRecoveryAnchor: undefined as SessionProjection["lastStreamRecoveryAnchor"],
  lastRewind: undefined as SessionProjection["lastRewind"],
  target: undefined as SessionProjection["target"],
  targetCompletionVerifications: [] as SessionProjection["targetCompletionVerifications"],
  targetCompletionVerificationTimeline:
    [] as SessionProjection["targetCompletionVerificationTimeline"],
};

/**
 * 流式工具账本：按 (attemptId, toolCallId) 二元组 upsert。
 *
 * 为什么不能只用 toolCallId：同一次模型重试会产生新 attempt，同一个 toolCallId
 * 在旧 attempt 里可能已结算为 not_executed，新 attempt 又要重新执行；
 * 只按 toolCallId 合并会让重试结果覆盖旧记录，流恢复时无法区分两次尝试。
 * 合并时保留旧条目的未提供字段（payload 是增量快照）。
 */
export function applyStreamingToolLedgerUpdate(
  projection: SessionProjection,
  payload: StreamingToolLedgerPayload,
  timestamp: Date,
): SessionProjection {
  const next = { ...payload, updatedAt: timestamp };
  const found = projection.streamingToolLedger.some(
    (item) => item.attemptId === payload.attemptId && item.toolCallId === payload.toolCallId,
  );
  return {
    ...projection,
    streamingToolLedger: found
      ? projection.streamingToolLedger.map((item) =>
          item.attemptId === payload.attemptId && item.toolCallId === payload.toolCallId
            ? { ...item, ...next }
            : item,
        )
      : [...projection.streamingToolLedger, next],
    updatedAt: timestamp,
  };
}

/**
 * 流恢复锚点：只保留最近一个（lastStreamRecoveryAnchor）。
 * 新锚点代表"从这里开始可以安全重放"，旧锚点即使还能重放也已被覆盖，
 * 因此无需保留历史（历史在事件流里本身可查）。
 */
export function applyStreamRecoveryAnchorCreated(
  projection: SessionProjection,
  payload: StreamRecoveryAnchorPayload,
  timestamp: Date,
): SessionProjection {
  return {
    ...projection,
    lastStreamRecoveryAnchor: { ...payload, updatedAt: timestamp },
    updatedAt: timestamp,
  };
}

/**
 * 压缩边界：更新 contextUsed 与 lastCompact 摘要。
 *
 * 优先级 truePostCompactTokenCount > postCompactTokenCount > 保留旧值：
 * true 值来自压缩后真实重算（含 system prompt/工具定义），post 值是估算。
 * 没有可信新值时宁可保留旧值，也不能把 contextUsed 清零——否则 UI 会显示
 * "压缩后上下文 0 token"，用户会误以为上下文被清空。
 *
 * payload 用 parse 而不是 cast：需要兼容旧版本写下的、缺 phase/willRetriggerNextTurn
 * 等字段的历史事件。
 */
export function applyCompactBoundary(
  projection: SessionProjection,
  payload: unknown,
  timestamp: Date,
): SessionProjection {
  const compactBoundary = parseCompactBoundaryPayload(payload) as CompactBoundaryPayload;
  return {
    ...projection,
    contextUsed:
      compactBoundary.truePostCompactTokenCount ??
      compactBoundary.postCompactTokenCount ??
      projection.contextUsed,
    lastCompact: {
      boundaryId: compactBoundary.boundaryId,
      trigger: compactBoundary.trigger,
      phase: compactBoundary.phase,
      compactReason: compactBoundary.compactReason,
      compactedAt: timestamp,
      preCompactTokenCount: compactBoundary.preCompactTokenCount,
      postCompactTokenCount: compactBoundary.postCompactTokenCount,
      truePostCompactTokenCount: compactBoundary.truePostCompactTokenCount,
      summarizedMessageCount: compactBoundary.summarizedMessageCount,
      keptMessageCount: compactBoundary.keptMessageCount,
      willRetriggerNextTurn: compactBoundary.willRetriggerNextTurn,
    },
    updatedAt: timestamp,
  };
}

/**
 * 把任意输入收敛成"正整数或 undefined"。
 *
 * 用于从旧事件里解析计数字段（行数/字节数/token 数）：负数、0、NaN、Infinity
 * 都视为"没有有效值"，交给下游走缺省逻辑，而不是写入负数污染统计。
 */
export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

/**
 * 后台任务开始：以 taskId 为单位"整条替换"。
 *
 * 这里不用 merge 的原因：started 是任务生命周期起点，同 taskId 再次 started
 * 只可能来自恢复/重放，整条替换能保证字段集合与 payload 完全一致，
 * 不残留上一次运行的 completedAt/cancelRequestedAt 等终结字段。
 */
export function applyBackgroundTaskStarted(
  projection: SessionProjection,
  payload: BackgroundTaskStartedPayload,
  timestamp: Date,
): SessionProjection {
  const existing = projection.backgroundTasks.filter((task) => task.taskId !== payload.taskId);
  return {
    ...projection,
    backgroundTasks: [
      ...existing,
      {
        taskId: payload.taskId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        taskKind: payload.taskKind,
        childSessionId: payload.childSessionId,
        blocked: payload.blocked,
        blockedReason: payload.blockedReason,
        cancellable: payload.cancellable,
        cancelRequestedAt: payload.cancelRequestedAt,
        command: payload.command,
        description: payload.description,
        status: payload.status,
        pid: payload.pid,
        startedAt: payload.startedAt ?? timestamp,
        outputPath: payload.outputPath,
        stderrPersistedOutputPath: payload.stderrPersistedOutputPath,
        stdoutPersistedOutputPath: payload.stdoutPersistedOutputPath,
        outputBytes: payload.outputBytes,
        outputTruncated: payload.outputTruncated,
        outputTail: payload.outputTail,
        stderrBytes: payload.stderrBytes,
        stderrTail: payload.stderrTail,
        stdoutBytes: payload.stdoutBytes,
        stdoutTail: payload.stdoutTail,
        terminalId: payload.terminalId,
      },
    ],
    updatedAt: timestamp,
  };
}

/**
 * 后台任务进度更新：只做增量合并（见 mergeBackgroundTask）。
 * 事件里缺失的字段保持原值；未知 taskId 不新增条目（更新不是创建，
 * 避免恢复顺序错乱时凭空出现半截任务）。
 */
export function applyBackgroundTaskUpdated(
  projection: SessionProjection,
  payload: BackgroundTaskUpdatedPayload,
  timestamp: Date,
): SessionProjection {
  return {
    ...projection,
    backgroundTasks: projection.backgroundTasks.map((task) =>
      task.taskId === payload.taskId ? mergeBackgroundTask(task, payload) : task,
    ),
    updatedAt: timestamp,
  };
}

/**
 * 后台任务完成：若任务已存在则合并（保留 started 里的静态字段），
 * 若不存在则补建（兼容"只看到完成事件"的截断/迁移数据，否则该任务会凭空消失）。
 * completedAt 缺失时用事件时间兜底。
 */
export function applyBackgroundTaskCompleted(
  projection: SessionProjection,
  payload: BackgroundTaskCompletedPayload,
  timestamp: Date,
): SessionProjection {
  const next = {
    taskId: payload.taskId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    taskKind: payload.taskKind,
    childSessionId: payload.childSessionId,
    blocked: payload.blocked,
    blockedReason: payload.blockedReason,
    cancellable: payload.cancellable,
    cancelRequestedAt: payload.cancelRequestedAt,
    command: payload.command,
    description: payload.description,
    status: payload.status,
    pid: payload.pid,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt ?? timestamp,
    outputPath: payload.outputPath,
    stderrPersistedOutputPath: payload.stderrPersistedOutputPath,
    stdoutPersistedOutputPath: payload.stdoutPersistedOutputPath,
    outputBytes: payload.outputBytes,
    outputTruncated: payload.outputTruncated,
    outputTail: payload.outputTail,
    stderrBytes: payload.stderrBytes,
    stderrTail: payload.stderrTail,
    stdoutBytes: payload.stdoutBytes,
    stdoutTail: payload.stdoutTail,
    terminalId: payload.terminalId,
  } satisfies SessionProjection["backgroundTasks"][number];

  const found = projection.backgroundTasks.some((task) => task.taskId === payload.taskId);
  return {
    ...projection,
    backgroundTasks: found
      ? projection.backgroundTasks.map((task) =>
          task.taskId === payload.taskId ? mergeBackgroundTask(task, next) : task,
        )
      : [...projection.backgroundTasks, next],
    updatedAt: timestamp,
  };
}

/**
 * 后台任务的通用合并：next 里值为 undefined 的键不覆盖 current。
 *
 * 这是整个 helper 文件的核心不变量——进度/完成事件是"部分快照"，
 * 不能用 `{...current, ...next}` 直接展开，否则 undefined 会把
 * command、pid、outputPath 这类只在 started 里出现的字段抹掉。
 */
function mergeBackgroundTask(
  current: SessionProjection["backgroundTasks"][number],
  next: Partial<SessionProjection["backgroundTasks"][number]>,
): SessionProjection["backgroundTasks"][number] {
  return {
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  } as SessionProjection["backgroundTasks"][number];
}
