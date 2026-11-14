/**
 * 高速指标持久化：transcript 是完成态统计的持久权威，event 只用于推进 live/replayable 投影。
 *
 * 两个入口分工：persistHighspeedTiming 在 turn 终态落真实耗时拆分（不要求 healthy TPS）；
 * persistHighspeedMetrics 在卡片/HUD 指标确定后补齐卡级指标（要求已有 highspeed 元数据）。
 * 写入口径：先改 user message metadata 并 saveMessage，再 append HighspeedMetricsUpdated 事件；
 * event append 失败时回滚 transcript，回滚再失败用 AggregateError 同时保留两个错误。
 * 失败与降级：找不到目标 user/highspeed 元数据缺失时静默返回或抛 proto.staleTarget /
 * guard.actionUnavailable；onPersistedEvent 抛错只上报 live 投影错误，不回滚已持久化事实。
 * 时间戳单调性：sequenceNumber 以 store 当前最大值为基线 +1，timestamp 由注入 now 生成。
 */
import {
  SessionEventType,
  createEventId,
  type HighspeedMessageMetadata,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";
import { highspeedMessageMetaSchema } from "@zcode/shared";

/**
 * 补齐卡级指标所需的输入：按 messageId 精确定位 user message，写入 regular/highspeed TPS、
 * 节省时长与 token/duration；entityId 决定 live 事件挂到哪张卡。
 */
export interface PersistHighspeedMetricsInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  metrics: {
    regularTps: number;
    outputTokens: number;
    durationMs: number;
    highspeedTps: number;
    savedDurationMs: number;
    modelDurationMs?: number;
    toolDurationMs?: number;
    otherDurationMs?: number;
  };
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/**
 * 补齐时序拆分所需的输入：按 sourceCommandId 定位 user message，并合并 outputTokens/durationMs
 * 与 model/tool/other 三段耗时。fallbackAt/fallbackReason 只增不删（transcript 已有值优先）。
 */
export interface PersistHighspeedTimingInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  sourceCommandId: string;
  timing: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  };
  outputTokens?: number;
  durationMs?: number;
  /**
   * live 投影中该 Turn 已产生的卡失效降级时刻。它只存在于 live 投影，终态持久化若不把它一并写入
   * transcript，HighspeedMetricsUpdated 与 cold hydration 都会丢掉它（spec §5）。
   */
  fallbackAt?: number;
  /** 与 fallbackAt 同源的降级原因；同一规则只增不删，缺省时冷恢复按卡过期文案处理。 */
  fallbackReason?: HighspeedMessageMetadata["fallbackReason"];
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/**
 * turn 终态由 CLI 自己把真实拆分落到 transcript，renderer 不在场也不会丢失耗时。
 * 该阶段不要求 healthy TPS；卡到期后 renderer/后续 CLI 流程再补齐卡级指标。
 */
// 定位口径：sourceCommandId 必须命中 user message；找不到或元数据不合 schema 时静默跳过，
// 因为 timing 是补充信息，不得让终态写入失败。只在 transcript 尚未记录 fallbackAt 时补 live 值。
// 副作用：saveMessage 后 append HighspeedMetricsUpdated；append 失败回滚 transcript 并抛原错。
// 并发口径：sequenceNumber 取 store 最大值 +1，写入按单 session 串行由上层保证。
export async function persistHighspeedTiming(input: PersistHighspeedTimingInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => {
    if (message.info.role !== "user") return false;
    const intent = message.info.metadata?.conversationInputIntent as
      | Record<string, unknown>
      | undefined;
    return (
      intent &&
      typeof intent === "object" &&
      !Array.isArray(intent) &&
      intent.sourceCommandId === input.sourceCommandId
    );
  });
  if (!user || user.info.role !== "user") return;
  const current = highspeedMessageMetaSchema.safeParse(user.info.metadata?.highspeed);
  if (!current.success) return;
  const highspeed = highspeedMessageMetaSchema.parse({
    ...current.data,
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...input.timing,
    // 只增不删：transcript 已持久化的 fallbackAt 优先；缺失时才补写 live 投影的值。
    ...(current.data.fallbackAt === undefined && input.fallbackAt !== undefined
      ? { fallbackAt: input.fallbackAt }
      : {}),
    ...(current.data.fallbackReason === undefined && input.fallbackReason !== undefined
      ? { fallbackReason: input.fallbackReason }
      : {}),
  });
  const metadata: Record<string, unknown> = {
    ...(user.info.metadata as Record<string, unknown>),
    highspeed,
  };
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  await input.sessionStore.saveMessage({ ...userInfoWithoutMetadata, metadata });
  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: String(user.info.id), highspeed },
  };
  try {
    input.onPersistedEvent(await input.eventStore.append(event));
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "highspeed timing rollback failed");
    }
    throw error;
  }
}

/** transcript 是 Highspeed 完成态统计的持久权威；event 只推进 live/replayable 投影。 */
// 输入：messageId 精确指向 user message；metrics 覆盖已有 highspeed 字段。输出：无（完成即写入）。
// 失败：目标不存在抛 proto.staleTarget；缺 highspeed 元数据抛 guard.actionUnavailable（调用方降级）。
// append 失败回滚 transcript；onPersistedEvent 失败只走 onLiveProjectionError，不回滚已落盘事实。
export async function persistHighspeedMetrics(input: PersistHighspeedMetricsInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => String(message.info.id) === input.messageId);
  if (!user || user.info.role !== "user") throw new Error("proto.staleTarget");

  const metadata = { ...user.info.metadata };
  const currentHighspeed = highspeedMessageMetaSchema.safeParse(metadata.highspeed);
  if (!currentHighspeed.success) throw new Error("guard.actionUnavailable");
  const highspeed = highspeedMessageMetaSchema.parse({
    ...currentHighspeed.data,
    ...input.metrics,
  });
  metadata.highspeed = highspeed;
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  const nextUserInfo = { ...userInfoWithoutMetadata, metadata };
  await input.sessionStore.saveMessage(nextUserInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: input.entityId, highspeed },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "highspeed metrics event append failed and transcript rollback failed",
      );
    }
    throw error;
  }
  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    input.onLiveProjectionError?.(error);
  }
}
