import type { ZCodeSessionEvent } from "@zcode/shared";
import type { ZCodeAgentServiceEvent } from "#src/zcode-agent/zcodeAgent.js";

// [权衡] 1.5s 聚合窗口是后台订阅的降频粒度：
// 太短起不到降频作用，太长会让后台任务的状态在切回前台时明显滞后。
const DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS = 1_500;
// [资源] 条数上限强制刷出：多个会话同时 streaming 时，
// 只按时间聚合会让缓冲无限增长，这里用条数兜底内存。
// [权衡] 96 条上限是内存与延迟的折中：它只约束待合并队列的长度，
// 超过即提前 flush，绝不丢事件；增量本身仍会先合并再入队。
const DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS = 96;
const SESSION_EVENT_KEY_SEPARATOR = "\u0000";
// 只有增量文本类可以合并：它们的 payload 是纯 append 语义。
// 其它 streaming kind（如工具状态迁移）带非可加字段，合并会丢失中间状态。
const COALESCIBLE_MODEL_STREAMING_KINDS = new Set([
  "text_delta",
  "reasoning_delta",
  "tool_input_delta",
]);

type SessionServiceEvent = Extract<ZCodeAgentServiceEvent, { type: "session.event" }>;

// 缓冲项只保留 key 与最新事件：合并后旧事件被整体替换，不需要历史链。
interface PendingBackgroundSessionEvent {
  key: string;
  event: SessionServiceEvent;
}

// 三个动作：投递、立即刷出、释放。dispose 会先刷出再停止，
// 因为待刷的 delta 仍是用户可见正文，不能当垃圾丢掉。
// 对外只有三个动作：accept 收事件、flush 立即排空、dispose 先刷后停。
// 刻意不暴露队列状态，调用方无法据此做分支，避免把降频细节带进主链路。
export interface BackgroundSessionEventCoalescer {
  accept(event: ZCodeAgentServiceEvent): void;
  flush(): void;
  dispose(): void;
}

// 数组与 null 都不算对象：payload 走弱类型，这里只做最小可判定校验。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

// key 决定「哪些事件可以合并成一条」。返 null 表示不可合并、必须立即投递。
// key 的每一段都取自结构性标识，绝不能用内容摘要——
// 内容会随合并变化，用它做 key 会导致永不复用同一条目。
function getBackgroundSessionEventCoalesceKey(event: ZCodeSessionEvent): string | null {
  const payload = asRecord(event.payload);
// 模型流式的 key 覆盖 turn、kind 与所有父子工具 id：
// 并行子代理的同名 kind 必须分行，否则正文会串到别的 tool call 上。
  if (event.type === "model.streaming") {
    const kind = stringField(payload, "kind");
    if (!kind || !COALESCIBLE_MODEL_STREAMING_KINDS.has(kind)) {
      return null;
    }
// 没有 delta 的 streaming 事件（例如只带元数据）不可合并：
// 合并函数会把缺失的 delta 当成空串拼接，从而吞掉原事件。
    if (stringField(payload, "delta") === undefined) {
      return null;
    }
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      kind,
      stringField(payload, "inputId") ?? "",
      stringField(payload, "assistantMessageId") ?? "",
      stringField(payload, "toolCallId") ?? "",
      stringField(payload, "parentToolUseId") ?? "",
      stringField(payload, "parentToolCallId") ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

// 只有 progress 可以合并且只需保留最新：它描述的是「还在跑」的可见摘要；
// 工具开始/结束属于交互边界，必须立即投递。
  if (event.type === "tool.updated" && stringField(payload, "kind") === "progress") {
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      stringField(payload, "inputId") ?? "",
      stringField(payload, "toolCallId") ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

// 恢复状态按 traceId 分开：同一 turn 可能有多条恢复尝试，
// 合并会掩盖其中一次的失败。
  if (event.type === "streamRecovery.updated") {
    return [
      event.type,
      event.sessionId,
      event.turnId ?? "",
      stringField(payload, "inputId") ?? "",
      event.traceId ?? "",
    ].join(SESSION_EVENT_KEY_SEPARATOR);
  }

  return null;
}

// 合并只实现两条规则：模型增量拼 delta，其余一律取后者。
// 取后者不是偷懒：progress 类事件的语义就是最新状态覆盖旧状态。
function mergeBackgroundSessionEvents(
  current: ZCodeSessionEvent,
  next: ZCodeSessionEvent,
): ZCodeSessionEvent {
  if (current.type === "model.streaming" && next.type === "model.streaming") {
    const currentPayload = asRecord(current.payload);
    const nextPayload = asRecord(next.payload);
    const currentDelta = stringField(currentPayload, "delta") ?? "";
    const nextDelta = stringField(nextPayload, "delta") ?? "";
    return {
      ...next,
      payload: {
        ...nextPayload,
        delta: `${currentDelta}${nextDelta}`,
      },
    } as ZCodeSessionEvent;
  }

  // 性能优化：后台工具 progress 只用于“还在跑”的可见摘要，保留最新状态即可。
// 非流式（progress/恢复）直接覆盖：保留旧 payload 的字段反而会让 UI 显示过期进度。
  return next;
}

// emit 是唯一的出口，必须是同步调用：调用方依赖事件顺序，
// 这里不做任何异步排队，聚合只发生在 accept 阶段。
export function createBackgroundSessionEventCoalescer(params: {
  emit: (event: ZCodeAgentServiceEvent) => void;
  flushDelayMs?: number;
  maxItems?: number;
}): BackgroundSessionEventCoalescer {
// 传入 0 或负数表示关闭聚合，accept 会退化成直通。
  const flushDelayMs = params.flushDelayMs ?? DEFAULT_BACKGROUND_SESSION_EVENT_COALESCE_MS;
  const maxItems = params.maxItems ?? DEFAULT_BACKGROUND_SESSION_EVENT_MAX_ITEMS;
// [状态归属] 数组而不是 Map：需要保持首次出现顺序，
// 刷新时整体替换数组，避免遍历过程中修改集合。
  let pendingEvents: PendingBackgroundSessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearFlushTimer(): void {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

// [事务] 先快照再清空再发送：发送过程中若回调触发新的 accept，
// 新事件会进入新数组，不会被这次循环重复或漏掉。
// 定时器与缓冲必须在同一处一起清，防止空缓冲仍挂着 timer。
  function flushPending(): void {
    if (pendingEvents.length === 0) {
      clearFlushTimer();
      return;
    }
    const events = pendingEvents.map((item) => item.event);
    pendingEvents = [];
    clearFlushTimer();
    for (const event of events) {
      params.emit(event);
    }
  }

// [并发] 已有定时器就不重复排程：多次 accept 共享同一个刷出点，
// 这正是聚合窗口的实现方式。disposed 之后不再排程。
// [资源] 全生命周期只保留一个定时器：重复 schedule 不会叠加计时，
// 已排期时直接返回，避免高频 delta 把延时不断重置成永不触发。
  function scheduleFlush(): void {
    if (disposed || flushTimer || flushDelayMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!disposed) {
        flushPending();
      }
    }, flushDelayMs);
  }

// 不可合并事件要先刷出已有缓冲再投递：
// 否则用户会先看到权限请求、后看到它之前的那段正文。
  function acceptSessionEvent(event: SessionServiceEvent): void {
    const key = getBackgroundSessionEventCoalesceKey(event.event);
    if (!key) {
      // 后台降频只能影响可重组的增量。权限、终态、tool result 等结构化事件
      // 必须先落完已有摘要再立即投递，否则会破坏 task 的交互边界。
      flushPending();
      params.emit(event);
      return;
    }

// 线性查找是刻意的：缓冲上限 96，Map 的额外索引与维护成本不成比例。
// 命中即原地替换事件，保持首次出现的发送顺序。
    const existing = pendingEvents.find((item) => item.key === key);
    if (existing) {
      existing.event = {
        type: "session.event",
        event: mergeBackgroundSessionEvents(existing.event.event, event.event),
      };
    } else {
      pendingEvents.push({ key, event });
    }

// 达到条数上限立即刷出；flushDelayMs<=0 时缓冲最多只有一条，直接走直通。
// 达到上限立即 flush 而不是丢弃：队列语义是延迟投递，不是采样。
    if (pendingEvents.length >= maxItems || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
// 非 session.event 的服务事件（状态通知、权限请求）一律先刷缓冲再直通。
    accept(event: ZCodeAgentServiceEvent): void {
      if (disposed) {
        return;
      }
      if (event.type !== "session.event") {
        flushPending();
        params.emit(event);
        return;
      }
      acceptSessionEvent(event);
    },

// 外部主动刷出：切换会话或前台接管前调用，保证正文完整。
    flush(): void {
      flushPending();
    },

// [事务] 先刷出再置 disposed：顺序反了会丢掉最后一段 delta，
// 切回前台后消息会从下一段才开始显示。
    dispose(): void {
      // desktop continuous 后台订阅被前台接管时会 dispose。
      // 待 flush 的 text/reasoning delta 仍是用户可见正文，不能按普通清理丢弃；
      // 否则切回 session 后运行中消息会从下一段 delta 才开始显示。
      flushPending();
      disposed = true;
      clearFlushTimer();
    },
  };
}
