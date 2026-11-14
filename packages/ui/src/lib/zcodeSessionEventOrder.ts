// INV-01 去重窗口有上限：守住位置 MAX_TRACKED；改错故障 长会话内存无界增长。
// INV-02 超出上限只淘汰最旧：守住位置 shift；改错故障 新事件被误删。
// INV-03 已投递 id 不进队列：守住位置 ids.has；改错故障 重放事件被二次渲染。
// INV-04 首次事件锁定起始序号：守住位置 nextSeq 赋值；改错故障 历史事件全部丢弃。
// INV-05 小于水位的序号视为重复：守住位置 比较分支；改错故障 旧事件插回正文。
// INV-06 同序号只保留一份：守住位置 pendingEvents.has；改错故障 同一增量重复应用。
// INV-07 连续序号才放行：守住位置 while 循环；改错故障 缺口被静默跳过。
// INV-08 缺口只在有后续时报告：守住位置 currentGap；改错故障 空洞被误报重启。
// INV-09 缺口取最小待处理序号：守住位置 Math.min；改错故障 报错位置偏移。
// INV-10 快照水位只进不退：守住位置 Math.max；改错故障 回退导致事件重放。
// INV-11 快照序号加一作为水位：守住位置 nextSnapshotSeq；改错故障 快照事件被当新事件。
// INV-12 负序号快照忽略：守住位置 seq 小于零分支；改错故障 水位被置成零。
// INV-13 保留模式只保留水位前的：守住位置 filter；改错故障 首段正文在切换会话时丢失。
// INV-14 保留事件先删后放：守住位置 delete 调用；改错故障 同一事件被放行两次。
// INV-15 非保留模式清掉旧序号：守住位置 keys 遍历；改错故障 过期事件占住水位。
// INV-16 清空后水位归零：守住位置 clearPendingAfterGap；改错故障 重连后从旧水位继续。
// INV-17 非正序号事件直接放行：守住位置 seq 判断；改错故障 本地事件被去重吞掉。
// INV-18 缺口释放按序号排序：守住位置 sort；改错故障 乱序放行打乱正文。
//
// 模块职责：为会话事件流提供去重、序号排序与缺口检测闸门。
// 状态所有权：每个 gate 实例独占自己的集合与水位。
// 阅读顺序：先看单事件入队，再看快照水位，最后看缺口释放。
import type { ZCodeSessionEvent } from "@zcode/shared";

// MAX_TRACKED_SESSION_EVENT_IDS 固定为一万，避免长会话无界增长。
// 这个上限覆盖单会话重放可能出现的全部事件标识。
// 超出上限时 rememberBoundedId() 从 order 头部淘汰最旧标识。
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;

// ZCodeSessionEventGap 同时记录 expectedSeq 与 receivedSeq 两端。
// 两字段都取自服务端下发的 event.seq。
// ZCodeSessionEventGap 只用于诊断与续传提示，不参与去重决策。
export interface ZCodeSessionEventGap {
  expectedSeq: number;
  receivedSeq: number;
}

export interface ZCodeSessionEventOrderResult {
  duplicate?: boolean;
  gap?: ZCodeSessionEventGap;
  readyEvents: ZCodeSessionEvent[];
}

// 写入口只有 push 与快照标记。
// 接口把缺口读取与释放分开，releasePendingAfterGap() 才真正清空队列。
// 清空用于重连后的重置。
export interface ZCodeSessionEventOrderGate {
  clearPendingAfterGap(): void;
  getGap(): ZCodeSessionEventGap | undefined;
  markSnapshotSeq(seq: number, options?: { preservePendingEvents?: boolean }): ZCodeSessionEvent[];
  push(event: ZCodeSessionEvent): ZCodeSessionEventOrderResult;
  releasePendingAfterGap(options?: {
    preserve?: (event: ZCodeSessionEvent) => boolean;
  }): ZCodeSessionEvent[];
}

// rememberBoundedId() 在 ids.has(id) 为真时返回 false，表示重复。
// 新标识同时写入 ids 与 order，两处保持同一顺序。
// order 超限时 shift() 弹出最旧项并从 ids 删除。
function rememberBoundedId(ids: Set<string>, order: string[], id: string): boolean {
  if (ids.has(id)) {
    return false;
  }
  ids.add(id);
  order.push(id);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

// createZCodeSessionEventOrderGate() 的闭包持有 ids、order、pendingEvents 与 nextSeq 四份状态。
// nextSeq 为 null 表示尚未收到任何事件。
// 返回对象只暴露 ZCodeSessionEventOrderGate 声明的五个方法。
export function createZCodeSessionEventOrderGate(): ZCodeSessionEventOrderGate {
  const deliveredEventIds = new Set<string>();
  const deliveredEventIdOrder: string[] = [];
  const pendingEvents = new Map<number, ZCodeSessionEvent>();
  let nextSeq: number | null = null;

  const drainReadyEvents = (): ZCodeSessionEvent[] => {
    if (nextSeq === null) {
      return [];
    }
    const readyEvents: ZCodeSessionEvent[] = [];
    while (nextSeq !== null) {
      const event = pendingEvents.get(nextSeq);
      if (!event) {
        break;
      }
      pendingEvents.delete(nextSeq);
      readyEvents.push(event);
      nextSeq += 1;
    }
    return readyEvents;
  };

  const currentGap = (): ZCodeSessionEventGap | undefined => {
    if (nextSeq === null || pendingEvents.size === 0) {
      return undefined;
    }
    const receivedSeq = Math.min(...pendingEvents.keys());
    return receivedSeq > nextSeq
      ? {
          expectedSeq: nextSeq,
          receivedSeq,
        }
      : undefined;
  };

  return {
    clearPendingAfterGap() {
      pendingEvents.clear();
      nextSeq = null;
    },

    getGap() {
      return currentGap();
    },

    markSnapshotSeq(seq: number, options: { preservePendingEvents?: boolean } = {}) {
      if (seq < 0) {
        return [];
      }
      const nextSnapshotSeq = seq + 1;
      if (options.preservePendingEvents) {
        // Bugfix: running snapshot 的 eventSeq 只能说明控制状态追到这里，不代表
        // 流式正文/思考已经写入 snapshot。已到达但尚未放行的 delta 需要继续交给
        // UI 消费，否则切 session 时会吞掉快照水位之前的首段正文。
        const preservedEvents = Array.from(pendingEvents.values())
          .filter((event) => event.seq < nextSnapshotSeq)
          .sort((left, right) => left.seq - right.seq);
        for (const event of preservedEvents) {
          pendingEvents.delete(event.seq);
        }
        nextSeq = nextSeq === null ? nextSnapshotSeq : Math.max(nextSeq, nextSnapshotSeq);
        return [...preservedEvents, ...drainReadyEvents()];
      }
      nextSeq = nextSeq === null ? nextSnapshotSeq : Math.max(nextSeq, nextSnapshotSeq);
      for (const pendingSeq of pendingEvents.keys()) {
        if (pendingSeq < nextSeq) {
          pendingEvents.delete(pendingSeq);
        }
      }
      return drainReadyEvents();
    },

    push(event: ZCodeSessionEvent) {
      if (event.seq <= 0) {
        return { readyEvents: [event] };
      }
      if (!rememberBoundedId(deliveredEventIds, deliveredEventIdOrder, event.eventId)) {
        return { duplicate: true, readyEvents: [] };
      }
      if (nextSeq === null) {
        nextSeq = event.seq;
      }
      if (event.seq < nextSeq || pendingEvents.has(event.seq)) {
        return { duplicate: true, readyEvents: [] };
      }
      pendingEvents.set(event.seq, event);
      return {
        gap: currentGap(),
        readyEvents: drainReadyEvents(),
      };
    },

    releasePendingAfterGap(options = {}) {
      const pending = Array.from(pendingEvents.values()).sort(
        (left, right) => left.seq - right.seq,
      );
      pendingEvents.clear();
      nextSeq = null;
      return options.preserve ? pending.filter(options.preserve) : [];
    },
  };
}
