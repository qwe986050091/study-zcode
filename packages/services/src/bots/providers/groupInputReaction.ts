// 群输入消息的 reaction 状态：waiting 表示已接收待处理，working 表示正在执行，
// done/failed/cancelled 是三个终态。它们最终由 provider 映射成各自的表情
// （飞书为 reaction emoji），因此这里的状态集必须与各 provider 的映射表一一对应。
export type GroupInputReaction = "waiting" | "working" | "done" | "failed" | "cancelled";

// 状态序：rank 只用于「禁止回退」，不用于比较终态之间的优先级。
// done/failed/cancelled 同为 2：任何一个终态落定后都不再接受其它状态，
// 这样「执行成功后用户立刻取消」不会把卡片从 ✅ 改成 ⛔，避免终态闪烁。
const rank: Record<GroupInputReaction, number> = {
  waiting: 0,
  working: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
};

// 构造一个「按消息串行 + 状态只进不退」的 reaction 更新器。
// 输入：apply 是实际的渠道调用（如飞书 updateInputReaction），key 通常是入站消息 id。
// 返回：update(key, state) —— 同一 key 的多次调用严格按调用顺序串行执行，不并发打渠道接口。
// 副作用：仅维护进程内 Map；不发请求、不设定时器，因此可在任意上下文调用。
// 失败语义：某次 apply 失败只让「该次调用返回的 Promise」reject，不阻断后续状态，
//   provider 不支持 reaction 时的降级由 apply 自己吞掉或上层忽略（INV-07）。
// [失败路径] 没有「撤销到上一个状态」的能力：reaction 语义只有设置，撤销由 stop/delete 单独承担，
//   所以这里宁可丢弃回退请求，也不尝试推断前一个状态。
export function createGroupInputReactionUpdater(
  apply: (key: string, state: GroupInputReaction) => Promise<void>,
) {
  // entries 的生命周期与 key 相同，但本函数不提供清理入口：条目会随消息数量单调增长。
  // [权衡] 不在这里加 TTL/上限：reaction 是短命对象，真正的释放应由持有者按会话关闭时统一清空；
  //   代价是长驻进程下 Map 会缓慢膨胀（见汇报中的风险点）。
  const entries = new Map<
    string,
    {
      // desired 是「最近一次被接受的状态」，也是回退判定的基准。
      desired: GroupInputReaction;
      // applied 是「已经成功写到渠道的状态」，用于跳过重复写入（幂等，INV-07）。
      applied?: GroupInputReaction;
      // pending 是该 key 的串行队列尾：每次都把新任务挂到它后面，保证顺序。
      pending: Promise<void>;
    }
  >();
  return (key: string, state: GroupInputReaction): Promise<void> => {
    let entry = entries.get(key);
    if (!entry) {
      // 新消息：desired 先落到本次状态，pending 用已解决的 Promise 作为队头，
      // 避免首帧出现一个无意义的 await；applied 留空表示「渠道侧还没有任何 reaction」。
      entry = { desired: state, pending: Promise.resolve() };
      entries.set(key, entry);
    } else if (
      // 回退判定：rank 更小 = 想从 working 退回 waiting，直接丢弃。
      rank[state] < rank[entry.desired] ||
      // 同 rank 的终态互斥：已是任一终态时，另一个不同终态（含 done->cancelled）也丢弃。
      // 若允许覆盖，异步完成与用户取消的竞态会让最终展示取决于到达顺序，用户看到的状态不可复现。
      (rank[entry.desired] === 2 && state !== entry.desired)
    ) {
      // 返回已解决的 Promise 而不是 reject：回退是正常并发现象，不是错误，
      // reject 会让调用方误以为渠道调用失败并触发告警。
      return Promise.resolve();
    }
    entry.desired = state;
    const current = entry;
    // 接收确认可能晚于开始/结束事件；单消息串行并禁止状态回退，避免覆盖终态。
    // [并发] 关键在 .catch(() => {}) 的位置：它挂在「上一条任务」上，用来吞掉前一次的失败，
    // 使队列不因一次超时/网络错误永久卡死；但本次任务自身的失败仍会传播给本次调用者。
    // [权衡] 换成共享一个 try/catch 包住整个队列，会把错误记到错误的调用者头上；
    // 现在的写法保证「谁的状态写入失败，谁的 Promise 失败」，同时后续状态继续推进。
    current.pending = current.pending
      .catch(() => {})
      .then(async () => {
        // 幂等短路：上一次已把同一状态写成功（例如重复收到两次 working），不再打渠道接口。
        // 注意比较的是 applied 而不是 desired：desired 可能被后续调用改掉，而 applied 才是渠道事实。
        if (current.applied === state) return;
        // await 放在 then 内，使同一 key 的下一个任务必须等这次写入完成才执行；
        // 这保证渠道侧最终状态与入参顺序一致，不会出现「done 先到、working 后到」的倒挂。
        await apply(key, state);
        // 只有 apply 成功才记录 applied：失败时保持旧值，后续重试仍会真正写入（而不是被幂等短路掉）。
        current.applied = state;
      });
    // 返回队列尾而不是 apply 的直接结果：调用方 await 它时，等价于「本次状态已被处理完」。
    return current.pending;
  };
}
