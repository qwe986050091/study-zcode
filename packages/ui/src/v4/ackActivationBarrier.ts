// INV-01 暂存按主题分组：守住位置 映射结构；改错故障 同一主题的并发订阅互相覆盖。
// INV-02 暂存与订阅标识双索引：守住位置 两张映射；改错故障 写入时找不到待激活批次。
// INV-03 上限同时约束条数与字节：守住位置 三重条件；改错故障 单条超大帧撑爆内存。
// INV-04 越界整批清空而非截头：守住位置 溢出分支；改错故障 激活后缺片却看似完整。
// INV-05 溢出原因在绑定时抛出：守住位置 绑定入口；改错故障 订阅静默成立但收不到帧。
// INV-06 绑定前收到的帧留在暂存：守住位置 空标识判断；改错故障 早到帧被丢弃。
// INV-07 激活只投递本订阅帧：守住位置 过滤条件；改错故障 并发订阅收到别人的帧。
// INV-08 激活返回主题与前驱：守住位置 返回对象；改错故障 上层无法清理旧所有权。
// INV-09 激活后移除暂存：守住位置 清理调用；改错故障 暂存批次长期滞留。
// INV-10 新激活替换旧所有权：守住位置 主题映射覆盖；改错故障 两个订阅同时被视为活动。
// INV-11 旧订阅标识同步移除：守住位置 反向映射删除；改错故障 旧标识仍能触发删除。
// INV-12 已激活的帧直接投递：守住位置 入口判断；改错故障 活动订阅的帧被暂存。
// INV-13 无待激活批次即丢弃：守住位置 分组空值检查；改错故障 建出无主暂存组。
// INV-14 取消与遗忘共用清理：守住位置 统一函数；改错故障 两处清理逻辑分叉。
// INV-15 遗忘同时清三种索引：守住位置 三步删除；改错故障 残留活动主题指向空订阅。
// INV-16 清理释放帧引用：守住位置 长度与字节归零；改错故障 帧对象长期滞留。
// INV-17 全清用于代次失效：守住位置 清空调用；改错故障 重连后旧帧被投递。
// INV-18 本层只处理物理帧：守住位置 职责注释；改错故障 在暂存期做逻辑拼装。
//
// 模块职责：在确认到达前有界暂存订阅帧，激活后按所有权投递。
// 状态所有权：待激活与活动两套索引都封闭在闭包内，不暴露给调用方。
// 阅读顺序：先看上限与接口，再看创建与清理，最后看绑定、激活与接收。
// subscribe ACK activation barrier：notification 可能先于 RPC response 抵达 renderer。
// transport 先按 topic 有界暂存，store 写入 ACK subscriptionId 后显式 activate；
// 这里只暂存 physical wire；logical assembly 在 ownership 激活后执行。
interface PendingFrameSubscription<T> {
  topic: string;
  subscriptionId: string | null;
  frames: T[];
  stagedBytes: number;
  overflowReason: string | null;
}

// MAX_STAGED_FRAMES=1024 与 MAX_STAGED_BYTES=32MB 双重上限。
// 溢出统一用 fault.subscription.initialFrameStagingOverflow 故障键。
// 上限是模块常量，不随 topic 或订阅者变化。
const MAX_STAGED_FRAMES = 1024;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const STAGING_OVERFLOW_REASON = "fault.subscription.initialFrameStagingOverflow";

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// begin() 返回的 token 是不透明 object，调用方不得解构。
// activate() 返回 topic 与 previousSubscriptionId。
// clear() 在代次失效时丢弃全部 active 与 pending 归属。
export interface AckActivationBarrier<T extends { topic: string; subscriptionId: string }> {
  begin(topic: string): object;
  bind(token: object, subscriptionId: string): void;
  cancel(token: object): void;
  activate(
    subscriptionId: string,
  ): { topic: string; previousSubscriptionId: string | null } | undefined;
  forget(subscriptionId: string): void;
  accept(frame: T): void;
  /** runtime/attachment generation invalidation：丢弃全部 active/pending ownership。 */
  clear(): void;
}

/** transport-local physical-wire barrier；同 topic 并发 pending 各自等 ACK 决定 owner。 */
// pendingByTopic 与 pendingBySubscriptionId 双索引待激活帧。
// activeByTopic 与 topicByActiveSubscription 互查活动订阅。
// deliver 由 createAckActivationBarrier 的调用方注入。
export function createAckActivationBarrier<T extends { topic: string; subscriptionId: string }>(
  deliver: (frame: T) => void,
): AckActivationBarrier<T> {
  const pendingByTopic = new Map<string, Set<PendingFrameSubscription<T>>>();
  const pendingBySubscriptionId = new Map<string, PendingFrameSubscription<T>>();
  const activeByTopic = new Map<string, string>();
  const topicByActiveSubscription = new Map<string, string>();

  // removePending 先把 pending 从 pendingByTopic 的分组里 delete。
  // 分组 size 归零时删掉对应的 topic 键。
  // frames.length 与 stagedBytes 一起清零。
  const removePending = (pending: PendingFrameSubscription<T>): void => {
    const group = pendingByTopic.get(pending.topic);
    group?.delete(pending);
    if (group?.size === 0) pendingByTopic.delete(pending.topic);
    if (pending.subscriptionId) {
      pendingBySubscriptionId.delete(pending.subscriptionId);
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  return {
    begin(topic) {
      const pending: PendingFrameSubscription<T> = {
        topic,
        subscriptionId: null,
        frames: [],
        stagedBytes: 0,
        overflowReason: null,
      };
      const group = pendingByTopic.get(topic) ?? new Set();
      group.add(pending);
      pendingByTopic.set(topic, group);
      return pending;
    },
    bind(token, subscriptionId) {
      const pending = token as PendingFrameSubscription<T>;
      if (pending.overflowReason) {
        const reason = pending.overflowReason;
        removePending(pending);
        throw new Error(reason);
      }
      pending.subscriptionId = subscriptionId;
      pendingBySubscriptionId.set(subscriptionId, pending);
    },
    cancel(token) {
      removePending(token as PendingFrameSubscription<T>);
    },
    activate(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (!pending) return;
      const previous = activeByTopic.get(pending.topic);
      if (previous && previous !== subscriptionId) {
        topicByActiveSubscription.delete(previous);
      }
      activeByTopic.set(pending.topic, subscriptionId);
      topicByActiveSubscription.set(subscriptionId, pending.topic);
      const frames = pending.frames.filter((frame) => frame.subscriptionId === subscriptionId);
      removePending(pending);
      for (const frame of frames) deliver(frame);
      return {
        topic: pending.topic,
        previousSubscriptionId: previous ?? null,
      };
    },
    forget(subscriptionId) {
      const pending = pendingBySubscriptionId.get(subscriptionId);
      if (pending) removePending(pending);
      const topic = topicByActiveSubscription.get(subscriptionId);
      if (topic && activeByTopic.get(topic) === subscriptionId) {
        activeByTopic.delete(topic);
      }
      topicByActiveSubscription.delete(subscriptionId);
    },
    accept(frame) {
      if (activeByTopic.get(frame.topic) === frame.subscriptionId) {
        deliver(frame);
        return;
      }
      const group = pendingByTopic.get(frame.topic);
      if (!group) return;
      const bytes = encodedBytes(frame);
      for (const pending of group) {
        if (pending.overflowReason) continue;
        if (
          bytes > MAX_STAGED_BYTES ||
          pending.frames.length + 1 > MAX_STAGED_FRAMES ||
          pending.stagedBytes + bytes > MAX_STAGED_BYTES
        ) {
          // 通过 shift 头部来“维持上限”会留下一个看似可激活、
          // 实际缺片的 physical batch。越界必须整批清空并让 subscribe 明确失败。
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = STAGING_OVERFLOW_REASON;
          continue;
        }
        pending.frames.push(frame);
        pending.stagedBytes += bytes;
      }
    },
    clear() {
      for (const group of pendingByTopic.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
        }
      }
      pendingByTopic.clear();
      pendingBySubscriptionId.clear();
      activeByTopic.clear();
      topicByActiveSubscription.clear();
    },
  };
}
