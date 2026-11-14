import type { SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * 与消息流同频的瞬态事件。
 * 它们仍经 event store 分配 seq 并交给 live sink，但 turn 结束并被下一 turn 取代后即可从内存淘汰：
 * 已完成 turn 的文本由持久化消息重新合成，reducer / rewind / fork / checkpoint 不消费这些类型。
 * 生产者：模型流解析器、工具执行器与网络观测；消费者：live 投影/TUI（不参与冷恢复）。
 * 不变量：这份集合只包含"可由持久事实重建"的类型。任何被 reducer 用来改语义状态、
 * 或冷恢复必须读到的类型都不能加进来——淘汰它等于删掉持久事实，恢复会失真。
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * sealed turn 没有后继 turn 时的时间兜底。
 * subagent 子 session 只有一个 turn，永远等不到下一个 turn_started，
 * 真机上一次子 session 留下约 1 万条 delta 直到 record 被池子回收；
 * 由 60s 采样节拍调用 `collectExpired`，超过 grace 的 sealed turn 一并淘汰。
 * 不变量：grace 只影响"何时回收"，不影响保留哪些类型——持久事件永远不会被时间兜底删除；
 * 一旦提前淘汰，该 turn 尚在落盘窗口的文本就没有内存副本可拼。
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

/**
 * 判定一个事件是否属于"可从内存淘汰"的瞬态类型（只看 type，不看 payload/turn）。
 * 生产者：本文件的瞬态集合；消费者：内存 store 的淘汰与 getStats 的驻留统计。
 * 不变量：纯函数、无副作用；淘汰调用方还必须同时校验 turnId 是否已被封窗，
 * 仅凭本判定不足以决定删除。
 */
export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

/**
 * sealed turn 淘汰时 `model_request` 驻留副本的元数据瘦身（spec 同上"model_request 元数据瘦身"）。
 * Bug 根因：`messages` 是每次模型请求的完整上下文，每个工具迭代一条且作为非瞬态永久驻留；
 * compact 只截断后续请求，不回收已驻留事件，长会话实测 event store 驻留随轮次线性涨约 150MB。
 * 内存 store 的读者只用 `messages.length`，live sink（debug JSONL）拿的是 append 返回的完整对象，
 * 因此只把驻留副本换成 `messageCount`，事件 id / seq / 其它 payload 字段保持不变。
 * 消费者：内存 store 的 evictTransientEvents 在封窗节拍调用；live sink 拿到的是
 * append 返回的原对象，因此 JSONL 落盘仍是完整 messages，只有内存副本变瘦。
 * 不变量：必须返回新对象（不得原地改 payload），否则 append 已交给 sink 的同一引用
 * 会被篡改；非 ModelRequest 或 messages 不是数组时原样返回。
 */
export function slimRetainedModelRequest(event: SessionEvent): SessionEvent {
  if (event.type !== SessionEventType.ModelRequest) {
    return event;
  }
  const payload = event.payload as { messages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.messages)) {
    return event;
  }
  const { messages, ...metadata } = payload;
  return { ...event, payload: { ...metadata, messageCount: messages.length } } as SessionEvent;
}

/**
 * 驻留策略模式：unbounded（永不淘汰，供回滚/对照测试）与 turn-window（生产默认）。
 * 生产者：会话 bootstrap 的配置；消费者：createSessionEventRetentionPolicy 选择实现。
 * 不变量：模式只决定内存驻留，不改变事件的 seq 分配或落盘行为——切换模式不会
 * 影响冷恢复读到的事件内容。
 */
export type SessionEventRetentionMode = "unbounded" | "turn-window";

/**
 * 驻留策略接口：按事件序列推导"哪些 turn 的瞬态事件可以出内存"。
 * 生产者：两个内置实现（unbounded / turn-window）；消费者：InMemorySessionEventStore
 * 在 append 与低频 tick 时调用。
 * 不变量：策略只看事件本身（type/turnId/时间），**不依赖持久化结果**——持久化是异步的，
 * 若策略等落盘确认，淘汰就会被 I/O 阻塞；反过来策略也绝不返回持久类型。
 * collectExpired 必须幂等：同一 turn 被多次返回只是重复空删，不能累计副作用。
 */
export interface SessionEventRetentionPolicy {
  /**
   * 每次 append 后调用一次。返回值是应从内存淘汰其瞬态事件的 turnId 列表；空数组表示不淘汰。
   * 策略只看事件序列本身，不依赖持久化结果。
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * 时间兜底：返回在 `nowMs - graceMs` 之前就已结束、且至今没有后继 turn 的 sealed turnId 列表，
   * 并把它们从待淘汰集合移除。由低频 tick 调用。
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * turn 窗口策略：`turn_complete` / `turn_error` 只把 turn 标为已结束（sealed），
 * 等下一个 `turn_started` 到达时再一次性淘汰所有 sealed turn 的瞬态事件（一 turn 滞后）。
 * 滞后的原因：turn 刚结束时消息可能尚未落盘，冷恢复仍要靠内存瞬态事件拼文本；
 * 下一 turn 开始意味着用户又发了消息，上一 turn 必定已持久化。
 * 窗口口径 = 进行中 turn + 至多一个已 sealed 且未被下一 turn 取代的 turn。
 * 淘汰只针对 TRANSIENT_SESSION_EVENT_TYPES：持久事件（turn 边界、工具结算、model_request
 * 元数据等）即使属于已 sealed 的 turn 也必须留在内存，因为 reducer/冷恢复要读它们；
 * 把"turn 结束"当成"整桶删除"会直接删掉持久事实。
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          // 新 turn 开始才回收上一轮：排除当前 turnId（重复 turn_started 的同轮重放不能误删自己），
          // 其余 sealed 一次性交给 store，由 store 再按瞬态类型过滤。
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          // 只封窗、不立即淘汰：此刻消息可能还没落盘；等下一个 turn_started 或 grace 兜底。
          // 同一 turn 重复收口（complete 后又 error）不刷新 sealedAt，避免延长驻留窗口。
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
  };
}

/**
 * 按模式构造策略实例；每个 session 应各自持有一份（turn-window 内部有可变集合）。
 * 生产者：store 的 createPolicy 工厂；消费者：store 的 append / pruneTransientEvents。
 * 不变量：返回的策略状态不共享；unbounded 的实现返回常量空数组，因此可以安全复用。
 */
export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
