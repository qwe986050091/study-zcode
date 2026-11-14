import type { SessionEventStorePort, SessionEventStoreStats } from "../interfaces/session.port.js";
import type { SessionId } from "../interfaces/shared.js";
import type { SessionEvent } from "./session.events.js";
import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SEALED_TURN_TRANSIENT_GRACE_MS,
  slimRetainedModelRequest,
  type SessionEventRetentionMode,
  type SessionEventRetentionPolicy,
} from "./session-event-retention.js";

/**
 * 进程内 event store 的构造选项：驻留策略与可注入时钟。
 * 生产者：会话 bootstrap 按配置创建 store；消费者：store 自身与回滚/对照测试。
 * 不变量：默认 turn-window；unbounded 只用于回滚与对照测试，生产开启会让长会话内存
 * 按 token 线性增长。retention 传函数时按 session 各建一份策略，策略状态不可跨会话共享。
 */
export interface InMemorySessionEventStoreOptions {
  /** 默认 `turn-window`；`unbounded` 供回滚与对照测试。也可注入自定义策略工厂（按 session 创建）。 */
  retention?: SessionEventRetentionMode | (() => SessionEventRetentionPolicy);
  /** 供测试注入的时钟；生产用 Date.now。 */
  now?: () => number;
}

interface SessionEventState {
  events: SessionEvent[];
  latestSequenceNumber: number;
  policy: SessionEventRetentionPolicy;
  evictedEvents: number;
}

/**
 * 进程内 session event store。
 *
 * 它是 live / replay / snapshot 序号的唯一来源，因此所有事件都经 `append` 分配 seq；
 * 但瞬态事件只按 turn 窗口驻留，已完成并被下一 turn 取代的桶会从内存淘汰。
 * append 若每次全量拷贝数组且永不淘汰，长会话内存就会按 token 线性增长。
 *
 * 【不变量】latestSequenceNumber 只增不减：淘汰事件不能让后续分配复用旧 seq，
 * 否则 getEventsAfter(cursor) 会漏掉重新编号的事件；getEventsAfter 按 > cursor 过滤，
 * 是跨进程增量重放的唯一入口。淘汰只针对瞬态类型，持久事件（message/turn 边界/
 * 工具结算等）永不从内存删除，否则冷恢复会缺事实。
 */
export class InMemorySessionEventStore implements SessionEventStorePort {
  private readonly sessions = new Map<SessionId, SessionEventState>();
  private readonly createPolicy: () => SessionEventRetentionPolicy;
  private readonly now: () => number;

  constructor(options: InMemorySessionEventStoreOptions = {}) {
    const retention = options.retention ?? "turn-window";
    this.createPolicy =
      typeof retention === "function"
        ? retention
        : () => createSessionEventRetentionPolicy(retention);
    this.now = options.now ?? (() => Date.now());
  }

  private stateFor(sessionId: SessionId): SessionEventState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        events: [],
        latestSequenceNumber: 0,
        policy: this.createPolicy(),
        evictedEvents: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async append(event: SessionEvent): Promise<SessionEvent> {
    const state = this.stateFor(event.sessionId);
    const sequenceNumber =
      event.sequenceNumber > 0 ? event.sequenceNumber : state.latestSequenceNumber + 1;
    // 计数器只增不减：淘汰不能让后续 getLatestSequenceNumber()+1 生成重复 seq。
    state.latestSequenceNumber = Math.max(state.latestSequenceNumber, sequenceNumber);
    const storedEvent = { ...event, sequenceNumber };
    state.events.push(storedEvent);
    const evictTurnIds = state.policy.onAppend(storedEvent, this.now());
    if (evictTurnIds.length > 0) {
      this.evictTransientEvents(state, new Set(evictTurnIds));
    }
    return storedEvent;
  }

  /**
   * 时间兜底（由 60s 低频 tick 调用）：淘汰结束超过 grace 且没有后继 turn 的 sealed turn 的瞬态事件。
   * 覆盖 subagent 子 session 这类一次性 session。返回本次淘汰条数。
   */
  pruneTransientEvents(
    nowMs: number = this.now(),
    graceMs: number = SEALED_TURN_TRANSIENT_GRACE_MS,
  ): number {
    let evicted = 0;
    for (const state of this.sessions.values()) {
      const expired = state.policy.collectExpired(nowMs, graceMs);
      if (expired.length === 0) {
        continue;
      }
      const before = state.evictedEvents;
      this.evictTransientEvents(state, new Set(expired));
      evicted += state.evictedEvents - before;
    }
    return evicted;
  }

  // 只清瞬态事件，且必须命中待淘汰的 turnId：持久事件即便属于被淘汰的 turn 也必须保留，
  // 否则冷恢复会缺 turn 边界/工具结算事实；同节拍顺带做 model_request 元数据瘦身。
  private evictTransientEvents(state: SessionEventState, turnIds: ReadonlySet<string>): void {
    const retained: SessionEvent[] = [];
    for (const event of state.events) {
      if (isTransientSessionEvent(event) && event.turnId && turnIds.has(event.turnId)) {
        state.evictedEvents += 1;
        continue;
      }
      // 同一淘汰节拍：已 sealed 且已持久化的 turn，其 model_request 只需保留元数据。
      retained.push(
        event.turnId && turnIds.has(event.turnId) ? slimRetainedModelRequest(event) : event,
      );
    }
    state.events = retained;
  }

  async getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId)?.events ?? [])];
  }

  async getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]> {
    return (this.sessions.get(sessionId)?.events ?? []).filter(
      (event) => event.sequenceNumber > sequenceNumber,
    );
  }

  async getLatestSequenceNumber(sessionId: SessionId): Promise<number> {
    return this.sessions.get(sessionId)?.latestSequenceNumber ?? 0;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** 供内存诊断日志读取驻留规模；只数长度，不拷贝。 */
  getStats(): SessionEventStoreStats {
    let events = 0;
    let evictedEvents = 0;
    let retainedTransient = 0;
    for (const state of this.sessions.values()) {
      events += state.events.length;
      evictedEvents += state.evictedEvents;
      for (const event of state.events) {
        if (isTransientSessionEvent(event)) {
          retainedTransient += 1;
        }
      }
    }
    return { sessions: this.sessions.size, events, evictedEvents, retainedTransient };
  }
}

/**
 * 工厂函数：按选项构造进程内 store（等价于 new，供依赖注入处使用统一入口）。
 * 生产者：会话 bootstrap；消费者：SessionEventStorePort 的调用方。
 * 不变量：每次调用得到独立实例与独立 Map，不同会话/测试之间不共享驻留状态。
 */
export function createInMemorySessionEventStore(
  options?: InMemorySessionEventStoreOptions,
): InMemorySessionEventStore {
  return new InMemorySessionEventStore(options);
}
