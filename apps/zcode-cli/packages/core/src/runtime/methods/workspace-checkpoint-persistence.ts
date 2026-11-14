// INV-01 条目写入是可选能力：守住位置 存储端口检查；改错故障 无端口适配器写出半套事实。
// INV-02 写入全部尽力而为：守住位置 捕获分支；改错故障 持久化失败中断 turn。
// INV-03 条目标识由业务标识派生：守住位置 标识拼接；改错故障 重复消费产生第二条记录。
// INV-04 关联载荷必须一并落库：守住位置 数据字段；改错故障 冷恢复找不到产物。
// INV-05 文件撤销限定工作区范围：守住位置 范围与原因比较；改错故障 会话级回滚重复记账。
// INV-06 撤销按业务标识去重：守住位置 标识字段；改错故障 同一撤销写入多条。
// INV-07 恢复入口缺能力即跳过：守住位置 读取端口检查；改错故障 无读取能力时抛错。
// INV-08 读库失败不阻断恢复：守住位置 捕获后返回；改错故障 恢复整体失败。
// INV-09 去重集合按事件构建：守住位置 事件过滤；改错故障 重复恢复叠加事件。
// INV-10 单条事件损坏只跳过：守住位置 解析捕获；改错故障 一条坏数据废掉整次恢复。
// INV-11 回放顺序按原序号：守住位置 排序比较；改错故障 检查点早于所属消息。
// INV-12 时间与序号复用原值：守住位置 事件字段赋值；改错故障 投影事件序漂移。
// INV-13 本轮内继续去重：守住位置 循环内加入集合；改错故障 同一检查点回放两次。
// INV-14 单条条目失败不影响其余：守住位置 循环内捕获；改错故障 一条异常终止全部回放。
// INV-15 持久数据逐字段校验：守住位置 读取函数；改错故障 损坏数据混入投影。
// INV-16 未知结构返回空值：守住位置 早退判断；改错故障 老结构被当作新结构解析。
// INV-17 两种恢复路径口径一致：守住位置 对称实现；改错故障 检查点与撤销行为分叉。
// INV-18 失败日志带链路信息：守住位置 上下文展开；改错故障 无法按会话定位问题。
//
// 模块职责：把工作区检查点与文件撤销事件落成会话条目，并在冷恢复时按原序回放。
// 状态所有权：事件真值在事件存储，本模块只负责条目账本与幂等回放。
// 阅读顺序：先看两条写入路径，再看两条恢复路径，最后看数据校验函数。
/**
 * ============================================================================
 * runtime/methods/workspace-checkpoint-persistence.ts —— checkpoint/文件撤销的 durable 账本
 * ============================================================================
 * 【定位】链路 5：把内存 eventStore 里的 CheckpointCreated / RewindTriggered 事件
 *   落成 session entry，并在冷恢复时按原 sequenceNumber 回放进 eventStore。
 * 【为什么】eventStore 随 child runtime 释放；只留 artifact 会让冷恢复后的
 *   preview/apply 找不到 checkpoint，也会让已撤销的文件重新显示为“撤销”。
 * 【关键不变量】#7 写入顺序与幂等：entry id 由业务 id 派生，恢复时按已有事件去重。
 * 【失败语义】全部 best-effort：写失败只 warn 不中断 turn；单条坏 entry 不影响其余恢复。
 * ============================================================================
 */
import {
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  RewindScope,
  SessionEventType,
  createSessionEvent,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  traceContextToLogContext,
} from "../deps.js";
import type {
  SessionEntryInfo,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface PersistedWorkspaceEvent {
  eventId: string;
  payload: unknown;
  sequenceNumber: number;
  traceId: string;
  turnId?: string;
}

// 适配器缺 saveSessionEntry 时直接 return，不制造半套持久事实。
// entry 写失败只发 checkpoint.persist.failed 警告，不让 turn 失败。
// 条目 id 由 eventId 派生，同一事件只写一次。
// payload 与 sequenceNumber 一起存，冷恢复才排得回原序。
export async function persistWorkspaceCheckpointEntry(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // 可选端口：没有 entry 写入能力的 adapter 只保留内存事件，不制造半套持久事实。
  if (!runtime.sessionStore?.saveSessionEntry) return;

  // best-effort：artifact 已落盘，entry 写失败只降低冷恢复可读性，不能让 turn 失败。
  try {
    const timestamp = event.timestamp.getTime();
    // id 由事件 id 派生，天然幂等：同一事件重复消费不会写出第二条 entry。
    await runtime.sessionStore.saveSessionEntry({
      id: `workspace-checkpoint:${String(event.id)}`,
      sessionID: event.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
      time: { created: timestamp, updated: timestamp },
      // checkpoint artifact 已落盘，但内存 eventStore 会随 child runtime 释放；
      // 只保留 artifact 而不持久化关联 payload，冷恢复后的 preview/apply 无法定位该 artifact。
      data: {
        eventId: String(event.id),
        payload: parseCheckpointCreatedPayload(event.payload),
        sequenceNumber: event.sequenceNumber,
        traceId: String(event.traceId),
        ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      } satisfies PersistedWorkspaceEvent,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to persist workspace checkpoint", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.persist.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

// 只有 workspace scope 且 reason 命中文件撤销时才记账。
// 会话级 rewind 交给消息历史，不写 workspace 条目。
// 撤销标识（rewindId）是这条记录的唯一键。
// 写失败同样只发 workspace_file_rewind.persist.failed 警告。
export async function persistWorkspaceFileRewindEntry(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;

  const payload = parseRewindTriggeredPayload(event.payload);
  // 只有 workspace scope 的文件撤销才需要单独记账；会话级 rewind 由消息历史自身表达。
  if (payload.scope !== RewindScope.Workspace || payload.reason !== "file_summary_rewind") return;

  try {
    const timestamp = event.timestamp.getTime();
    // 同一 rewindId 只对应一条 entry，重复事件不会重复记账。
    await runtime.sessionStore.saveSessionEntry({
      id: `workspace-file-rewind:${payload.rewindId}`,
      sessionID: event.sessionId,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
      time: { created: timestamp, updated: timestamp },
      // 文件已撤销是 child turn 的持久状态。只广播内存事件会在关闭详情或
      // 重启后重新显示“撤销”，并让已经恢复的文件再次进入预览。
      data: {
        eventId: String(event.id),
        payload,
        sequenceNumber: event.sequenceNumber,
        traceId: String(event.traceId),
        ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      } satisfies PersistedWorkspaceEvent,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to persist workspace file rewind", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "workspace_file_rewind.persist.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

// 先 await sessionEntries()，catch 只 warn 不抛。
// 已存在的 eventId 集合构成幂等基线。
// 回放按 sequenceNumber 与时间戳排序，不按数组顺序。
export async function restoreWorkspaceCheckpointEntries(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  // 冷恢复入口：没有读取能力就没有可恢复对象，直接跳过而不是当成错误。
  if (!runtime.sessionStore?.sessionEntries) return;

  let entries: SessionEntryInfo[];
  // 读库失败不阻塞 resume 主流程：checkpoint 是可选能力，warn 后继续装配其余状态。
  try {
    entries = await runtime.sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to read persisted workspace checkpoints", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.restore.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return;
  }

  // 先算出 eventStore 已有的事件 id，保证 restore 幂等：重复 resume 不会重复 append。
  const existingCheckpointIds = new Set(
    (await runtime.eventStore.getEvents(runtime.sessionId)).flatMap((event) => {
      if (event.type !== SessionEventType.CheckpointCreated) return [];
      // 单条事件 payload 损坏时跳过：去重集合宁可少一个 id，也不能让恢复整体失败。
      try {
        return [parseCheckpointCreatedPayload(event.payload).checkpointId];
      } catch {
        return [];
      }
    }),
  );
  // 按原 sequenceNumber 排序（同序号再按 created）：回放顺序必须与原始事件序一致，
  // 否则 reducer/投影会看到 checkpoint 早于其所属消息的假象。
  const orderedEntries = [...entries].sort((left, right) => {
    const leftSequence = readPersistedWorkspaceCheckpoint(left.data)?.sequenceNumber ?? 0;
    const rightSequence = readPersistedWorkspaceCheckpoint(right.data)?.sequenceNumber ?? 0;
    return leftSequence - rightSequence || left.time.created - right.time.created;
  });

  for (const entry of orderedEntries) {
    const data = readPersistedWorkspaceCheckpoint(entry.data);
    // 结构不合法的 entry（老 schema/被污染）直接跳过，不影响其余 checkpoint。
    if (!data) continue;
    try {
      const payload = parseCheckpointCreatedPayload(data.payload);
      // 已有同 checkpoint 的事件就跳过；这是 resume 重复执行时的幂等边界。
      if (existingCheckpointIds.has(payload.checkpointId)) continue;
      const event = createSessionEvent(
        SessionEventType.CheckpointCreated,
        runtime.sessionId,
        payload,
        {
          traceId: data.traceId as TraceId,
          ...(data.turnId ? { turnId: data.turnId as TurnId } : {}),
        },
      );
      // 时间取 entry 记录值而非恢复时刻；序号必须复用原值，投影的事件序才不漂移。
      event.timestamp = new Date(entry.time.created);
      event.sequenceNumber = data.sequenceNumber;
      await runtime.eventStore.append(event);
      // 本轮内也去重：多个 entry 可能指向同一 checkpoint。
      existingCheckpointIds.add(payload.checkpointId);
    } catch (error) {
      // 单条坏 entry 只 warn：恢复是 best-effort，不能让一个损坏记录废掉整次冷恢复。
      runtime.logger?.warn("Skipped invalid persisted workspace checkpoint", {
        ...traceContextToLogContext(traceContext),
        entryId: entry.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "checkpoint.restore.invalid_entry",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
}

// 与 restoreWorkspaceCheckpointEntries 同构。
// 幂等集合来自已存在的文件撤销事件。
// scope 与 reason 判断复用写入侧同一套条件。
export async function restoreWorkspaceFileRewindEntries(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  // 与 checkpoint 恢复同构：没有入口能力直接跳过，读失败只 warn 不阻断 resume。
  if (!runtime.sessionStore?.sessionEntries) return;

  let entries: SessionEntryInfo[];
  try {
    entries = await runtime.sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to read persisted workspace file rewinds", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "workspace_file_rewind.restore.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return;
  }

  // 以已有 RewindTriggered 事件做幂等集合，避免重复 resume 叠加同一条撤销。
  const existingRewindIds = new Set(
    (await runtime.eventStore.getEvents(runtime.sessionId)).flatMap((event) => {
      if (event.type !== SessionEventType.RewindTriggered) return [];
      // 解析失败的旧事件不参与去重，但也不会中断恢复。
      try {
        return [parseRewindTriggeredPayload(event.payload).rewindId];
      } catch {
        return [];
      }
    }),
  );
  // 同样按原序号回放：撤销事件的顺序决定 reducer 里“已撤销”状态的最终值。
  const orderedEntries = [...entries].sort((left, right) => {
    const leftSequence = readPersistedWorkspaceEvent(left.data)?.sequenceNumber ?? 0;
    const rightSequence = readPersistedWorkspaceEvent(right.data)?.sequenceNumber ?? 0;
    return leftSequence - rightSequence || left.time.created - right.time.created;
  });

  for (const entry of orderedEntries) {
    const data = readPersistedWorkspaceEvent(entry.data);
    // 结构不合法直接跳过，避免把损坏 data 当成事件回放。
    if (!data) continue;
    try {
      const payload = parseRewindTriggeredPayload(data.payload);
      // scope/reason 与写入侧保持同一口径；幂等命中则跳过，不重复 append。
      if (
        payload.scope !== RewindScope.Workspace ||
        payload.reason !== "file_summary_rewind" ||
        existingRewindIds.has(payload.rewindId)
      ) {
        continue;
      }
      const event = createSessionEvent(
        SessionEventType.RewindTriggered,
        runtime.sessionId,
        payload,
        {
          traceId: data.traceId as TraceId,
          ...(data.turnId ? { turnId: data.turnId as TurnId } : {}),
        },
      );
      // 复用 entry 的时间与序号，回放出的事件序与原始写入一致。
      event.timestamp = new Date(entry.time.created);
      event.sequenceNumber = data.sequenceNumber;
      await runtime.eventStore.append(event);
      existingRewindIds.add(payload.rewindId);
    } catch (error) {
      // 单个 entry 失败只影响这一条撤销事实，其余继续恢复。
      runtime.logger?.warn("Skipped invalid persisted workspace file rewind", {
        ...traceContextToLogContext(traceContext),
        entryId: entry.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "workspace_file_rewind.restore.invalid_entry",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
}

function readPersistedWorkspaceCheckpoint(value: unknown): PersistedWorkspaceEvent | null {
  return readPersistedWorkspaceEvent(value);
}

function readPersistedWorkspaceEvent(value: unknown): PersistedWorkspaceEvent | null {
  // 持久 data 是 unknown：逐字段校验后才当作事件回放，避免老 schema/损坏数据混入投影。
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.eventId !== "string" ||
    typeof data.sequenceNumber !== "number" ||
    typeof data.traceId !== "string" ||
    !("payload" in data) ||
    (data.turnId !== undefined && typeof data.turnId !== "string")
  ) {
    return null;
  }
  return data as unknown as PersistedWorkspaceEvent;
}
