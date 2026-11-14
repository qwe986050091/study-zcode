// 助手反馈（like / dislike）的持久化入口。
//
// 职责：把客户端反馈写成 transcript message metadata，并追加一条
// AssistantFeedbackUpdated 事件，让 live projection 与冷恢复读到同一事实。
// 口径：transcript 是持久权威，event 只是把同一写入推进投影层，不是第二真相源。
// 失败：目标 message 不存在或不是 assistant → proto.staleTarget；event append 失败必须
// 补偿回滚 metadata；event 已 durable 后 live 投影失败不得再回失败 ACK。
// 副作用：durable 写 sessionStore + eventStore；最后同步回调 onPersistedEvent。
import {
  SessionEventType,
  createEventId,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";

// 反馈写入所需的全部外部依赖；本函数不持有任何状态，调用方负责编排。
export interface PersistAssistantFeedbackInput {
  // transcript 读取 + metadata 写入的唯一入口（持久权威）。
  sessionStore: SessionStorePort;
  // 事件日志写入入口；负责序号分配与 durable 落盘。
  eventStore: SessionEventStorePort;
  // 目标会话；messageId 必须属于该会话，否则按 staleTarget 失败。
  sessionId: string;
  // 被反馈的 assistant 消息 id；不要求是“最后一条”，但必须是 assistant 角色。
  messageId: string;
  // 反馈实体 id（投影侧 entityId），仅随事件透传，不写入 transcript。
  entityId: string;
  // null 表示取消反馈（删除 metadata 字段）；非 null 才写入。
  feedback: "like" | "dislike" | null;
  // 事件追溯 id，必须与本次命令链一致，用于 live 事件可观测性。
  traceId: string;
  // 时钟注入，仅测试/回放使用；缺省 Date.now。
  now?: () => number;
  // 事件 durable 之后的 live 推送；抛错不会让调用方看到失败。
  onPersistedEvent(event: SessionEvent): void;
  // live 投影失败的诊断旁路；不影响已 durable 的事实。
  onLiveProjectionError?(error: unknown): void;
}

// 顺序：读 messages → 定位 assistant → 改 metadata（保留其它字段）→ saveMessage
// → 以“最新序号 + 1”追加事件 → live 推送。先落 transcript 是刻意的：即使崩在
// append 之前，重开也能从 metadata 恢复；失败时再用原 info 反向补偿。
// 返回 void：反馈没有业务结果值，成功即代表两处均已 durable。
// 幂等：同一 messageId 重复写同一 feedback 会得到同样的 metadata 与一条新事件，
// 投影按最后值收敛，不做额外去重。调用方不得吞掉抛出的错误。
/** transcript 是反馈持久权威；event 只负责把同一写入推进 live/cold projection。 */
export async function persistAssistantFeedback(
  input: PersistAssistantFeedbackInput,
): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const assistant = messages.find((message) => String(message.info.id) === input.messageId);
  if (!assistant || assistant.info.role !== "assistant") {
    throw new Error("proto.staleTarget");
  }
  // 复制再改单键：原 info 保留给失败回滚，且不能就地改动已读对象。
  const metadata = { ...assistant.info.metadata };
  if (input.feedback === null) {
    delete metadata.assistantFeedback;
  } else {
    metadata.assistantFeedback = input.feedback;
  }
  const { metadata: _previousMetadata, ...assistantInfoWithoutMetadata } = assistant.info;
  const nextAssistantInfo = {
    ...assistantInfoWithoutMetadata,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  await input.sessionStore.saveMessage(nextAssistantInfo);

  // 事件序号必须接在当前日志水位之后，否则投影会把它当成乱序/回放帧。
  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.AssistantFeedbackUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: {
      entityId: input.entityId,
      feedback: input.feedback,
    },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    // transcript 先成功、event append 后失败时，renderer 会按失败 ACK 回滚，
    // 但重开又从半提交 metadata 恢复反馈。append 失败必须补偿回原始 message info。
    try {
      await input.sessionStore.saveMessage(assistant.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "assistant feedback event append failed and transcript rollback failed",
      );
    }
    throw error;
  }

  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    // event 已 durable 后不能再给 renderer 失败 ACK，否则 UI 回滚会与持久事实相反；
    // live projection 失败留给 resync/hydration 收敛，并只走诊断回调。
    input.onLiveProjectionError?.(error);
  }
}
