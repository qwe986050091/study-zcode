// 连续流合并器：把高频小 chunk 收敛成按帧发送的批次，降低跨进程 RPC 次数。
import type { ZCodeStreamEvent } from "@zcode/shared";

// 16ms 对应约一帧，兼顾延迟与吞吐。
// 单批最多 4096 字符或 128 个事件，先到先触发。
// key 分隔符使用 NUL，正常文本不会出现，避免拼接键冲突。
const CONTINUOUS_CHUNK_FLUSH_DELAY_MS = 16;
const CONTINUOUS_CHUNK_MAX_CHARS = 4096;
const CONTINUOUS_CHUNK_MAX_EVENTS = 128;
const CONTINUOUS_CHUNK_KEY_SEPARATOR = "\u0000";

// 只有 message/thought 正文块可合并；带时间线的消息块必须逐条发送。
type ContinuousCoalescibleChunk =
  | Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }>
  | Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" }>;

type ContinuousCoalescibleState =
  | Extract<ZCodeStreamEvent, { type: "usage_update" }>
  | Extract<ZCodeStreamEvent, { type: "session_info_update" }>;

// chunk 项携带累积计数，达到阈值立即 flush。
interface PendingContinuousChunkItem {
  kind: "chunk";
  event: ContinuousCoalescibleChunk;
  chunkCount: number;
  charCount: number;
}

// state 项按 stateKey 去重，同帧只保留最新值。
interface PendingContinuousStateItem {
  kind: "state";
  event: ContinuousCoalescibleState;
  stateKey: string;
}

type PendingContinuousItem = PendingContinuousChunkItem | PendingContinuousStateItem;

// 对外只暴露 accept/flush/dispose 三个动作。
interface ContinuousStreamCoalescer {
  accept(event: ZCodeStreamEvent): void;
  flush(): void;
  dispose(): void;
}

// 带 zcodeTimeline 的 message chunk 属于结构化时间线事件，不参与合并。
function isContinuousCoalescibleChunk(event: ZCodeStreamEvent): event is ContinuousCoalescibleChunk {
  return (
    event.type === "agent_thought_chunk" ||
    (event.type === "agent_message_chunk" && !event.zcodeTimeline)
  );
}

// usage_update 恒可合并。
function isContinuousCoalescibleState(event: ZCodeStreamEvent): event is ContinuousCoalescibleState {
  if (event.type === "usage_update") {
    return true;
  }

  // Bugfix: api_retry 会以 session_info_update 高频推送，但 title/target 是会话元信息变更。
  // 这里只合并纯重试状态，避免标题或目标补丁被延迟后影响任务列表/目标展示的一致性。
  return (
// session_info_update 只合并纯 apiRetry 状态。
    event.type === "session_info_update" &&
    event.title === undefined &&
    event.target === undefined &&
    "apiRetry" in event
  );
}

// 缺失 parentToolUseId 统一为空串，避免 undefined 参与键拼接。
function normalizeChunkParentToolUseId(event: ContinuousCoalescibleChunk): string {
  return event.parentToolUseId ?? "";
}

// 合并键必须覆盖所有会影响渲染归属的字段。
// messageId 只对 message chunk 有意义，thought chunk 恒为空。
// 键不同即断批，保证不跨任务/跨消息合并。
function getContinuousChunkMergeKey(event: ContinuousCoalescibleChunk): string {
  return [
    event.type,
    event.taskId,
    event.traceId,
    normalizeChunkParentToolUseId(event),
    event.type === "agent_message_chunk" ? event.messageId ?? "" : "",
  ].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

// 状态键按 type + taskId + traceId 区分，同帧只保留最后一条。
function getContinuousStateMergeKey(event: ContinuousCoalescibleState): string {
  return [
    event.type,
    event.taskId,
    event.traceId,
  ].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

// 合并只拼接 content，其余字段沿用首个事件。
function mergeContinuousChunks(
  current: ContinuousCoalescibleChunk,
  next: ContinuousCoalescibleChunk,
): ContinuousCoalescibleChunk {
  return {
    ...current,
    content: `${current.content}${next.content}`,
  };
}

// 工厂函数返回闭包实例，所有状态都封装在闭包内。
// 阈值可注入，便于测试与不同宿主调参。
// emit 由调用方提供，合并器不持有任何传输层。
export function createContinuousStreamCoalescer(params: {
  emit: (event: ZCodeStreamEvent) => void;
  flushDelayMs?: number;
  maxChars?: number;
  maxEvents?: number;
}): ContinuousStreamCoalescer {
// 三个阈值都允许调用方覆盖，缺省使用模块常量。
  const flushDelayMs = params.flushDelayMs ?? CONTINUOUS_CHUNK_FLUSH_DELAY_MS;
  const maxChars = params.maxChars ?? CONTINUOUS_CHUNK_MAX_CHARS;
  const maxEvents = params.maxEvents ?? CONTINUOUS_CHUNK_MAX_EVENTS;
// pendingItems 保持接收顺序，flush 时按序 emit。
  let pendingItems: PendingContinuousItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
// disposed 之后 accept 静默丢弃，flush 仍可安全调用。
  let disposed = false;

// 清定时器必须幂等：flush 与 dispose 都可能调用。
  function clearFlushTimer(): void {
// [顺序] clearFlushTimer 先判 flushTimer 再 clearTimeout：重复调用必须幂等，不能把 undefined 传进去。
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

// 先快照并清空队列，再逐条 emit，避免 emit 回调重入导致重复发送。
// 空队列时只清定时器。
  function flushPending(): void {
// 空队列只清理定时器，不调用 emit。
    if (pendingItems.length === 0) {
      clearFlushTimer();
      return;
    }
// 取出事件数组后立即重置队列，后续 accept 进入新批次。
    const events = pendingItems.map((item) => item.event);
    pendingItems = [];
    clearFlushTimer();
// 按接收顺序逐条发送，不在此处再做合并。
    for (const event of events) {
      params.emit(event);
    }
  }

// 已有定时器、已销毁或禁用延迟时不重复调度。
  function scheduleFlush(): void {
// flushDelayMs<=0 表示同步模式，由调用方在 accept 后自行 flush。
    if (flushTimer || disposed || flushDelayMs <= 0) {
      return;
    }
// 定时器触发后先清句柄再 flush，避免 flush 内重入时看到过期句柄。
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, flushDelayMs);
  }

// 新开一段 chunk 累积，并立即判断是否触顶。
  function startPendingChunk(event: ContinuousCoalescibleChunk): void {
    pendingItems.push({
      kind: "chunk",
      event,
      chunkCount: 1,
      charCount: event.content.length,
    });
// 单块就超限、批内事件数超限或同步模式时立即发送。
// 顺序判断先看内容长度，再看事件数。
    if (event.content.length >= maxChars || pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

// 状态事件按 key 就地替换，不新增队列项。
  function acceptPendingState(event: ContinuousCoalescibleState): void {
// 先算键再查找，保证替换与查找使用同一口径。
    const stateKey = getContinuousStateMergeKey(event);
    const existingItem = pendingItems.find(
      (item): item is PendingContinuousStateItem =>
        item.kind === "state" && item.stateKey === stateKey,
    );
// 命中后只更新事件体，位置保持不变。
    if (existingItem) {
      existingItem.event = event;
      return;
    }

    // Bugfix: usage/apiRetry 这类状态事件会跟正文流同频到达。逐条透给桌面 continuous
    // 会让 renderer 反复写 store 并触发 React 同步渲染；按帧只保留最新状态即可保持 UI 语义。
// 未命中则追加；队列满时立即 flush。
    pendingItems.push({ kind: "state", event, stateKey });
    if (pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
// 统一入口按类型分派：状态 > 可合并 chunk > 结构化事件。
// 已销毁后静默丢弃，不再触发 emit。
    accept(event: ZCodeStreamEvent): void {
      if (disposed) {
        return;
      }

// 状态事件优先处理，避免与正文块共用累积逻辑。
      if (isContinuousCoalescibleState(event)) {
        acceptPendingState(event);
        return;
      }

      if (!isContinuousCoalescibleChunk(event)) {
        // Bugfix: 桌面 continuous 之前把几千个 1-5 字符 chunk 逐条塞进 RPC，
        // terminal 和 sendPrompt 返回会排在这些小包后面。这里在结构化事件前先 flush，
        // 保持工具、权限、快照和终态事件的相对顺序，同时把普通正文流收敛到帧级别。
        flushPending();
        params.emit(event);
        return;
      }

// 只与队尾比较：合并必须保持连续，不能跨过中间事件。
      const lastItem = pendingItems[pendingItems.length - 1];
      if (!lastItem) {
        startPendingChunk(event);
        return;
      }

      if (
// 队尾不是 chunk 或合并键不一致时，另起一段。
// 这保证不同任务、不同消息的正文不会混在同一条事件里。
        lastItem.kind !== "chunk" ||
        getContinuousChunkMergeKey(lastItem.event) !== getContinuousChunkMergeKey(event)
      ) {
        startPendingChunk(event);
        return;
      }

// 合并后原地替换队尾，避免队列无限增长。
      const nextItem: PendingContinuousChunkItem = {
        kind: "chunk",
        event: mergeContinuousChunks(lastItem.event, event),
        chunkCount: lastItem.chunkCount + 1,
        charCount: lastItem.charCount + event.content.length,
      };
// 替换而非 append，保持队列长度稳定。
      pendingItems[pendingItems.length - 1] = nextItem;
// 合并后再次检查双阈值，任一触顶即发送。
      if (nextItem.charCount >= maxChars || nextItem.chunkCount >= maxEvents) {
        flushPending();
      }
    },

// 外部可主动 flush：结构化事件到达前必须先清空正文批次。
    flush(): void {
      flushPending();
    },

// 销毁后清空队列并停表，之后的 accept 全部忽略。
    dispose(): void {
      disposed = true;
      pendingItems = [];
      clearFlushTimer();
    },
  };
}
