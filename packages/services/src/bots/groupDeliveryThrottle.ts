// bots/groupDeliveryThrottle.ts — 群消息发送的按 chatKey 串行节流。
//
// [并发] 同一 chatKey 的发送按 250ms 间隔排队；只预留时间片，不排队消息内容。
// [资源] map 只在存在未来预约时保留 key，空闲后删除，避免群数量增长导致常驻。
// 注意：等待用 setTimeout 实现，进程退出时未完成的等待不会补偿，也不应补偿。
/** 群消息共享发送额度；只预留发送时间，不保存或执行任务输入。 */
export function createGroupDeliveryThrottle() {
  // 每个 chatKey 记录最早可发送时刻：用时间点而不是消息队列，等待期间不持有消息内容，进程退出也不会重放。
  const nextSendAt = new Map<string, number>();
  return async (chatKey: string): Promise<void> => {
    // 只保证同一 chatKey 的发送起点间隔，不保证投递完成顺序；跨群协调由上层串行队列负责。
    // 整段计算只取一次 now：多次调用 Date.now 会在两次读取之间漂移，把 250ms 间隔算短。
    const now = Date.now();
    // at 取 now 与已预约时刻的较大值：首次发送不等待，连续发送则严格继承上一个 250ms 槽位。
    const at = Math.max(now, nextSendAt.get(chatKey) ?? now);
    // 先占位再等待：并发调用在同一 tick 看到的都是已推迟的额度，否则两个调用会同时通过。
    nextSendAt.set(chatKey, at + 250);
    // 时间片一旦占用就不回滚：本次 send 失败时下一个调用仍按原节奏等待，
    // 避免失败重试把同一群的消息挤成并发风暴。
    // 只有被推迟的调用才真正 sleep；未推迟的立即返回，避免给群里的第一条消息平白增加 250ms 延迟。
    if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
    // 空闲 key 不常驻；后续调用已预约时不能清掉它的额度。
    if ((nextSendAt.get(chatKey) ?? 0) <= Date.now()) nextSendAt.delete(chatKey);
  };
}
