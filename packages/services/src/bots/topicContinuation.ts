// bots/topicContinuation.ts — 话题续接的暂停-提交协调器。
//
// INV-01 先停止当前 run 再等待材料；旧实现相反，导致后来的输入无法及时打断。
// INV-02 generation 是取消令牌：每次 cancel 递增，任何跨 await 的阶段都必须
//        比对，旧代次的批次不能提交。
// INV-03 批次以“等待期间新增消息”为边界重取，保证提交顺序等于到达顺序，
//        而不是附件准备完成顺序。
// INV-04 run 的权威状态由调用方从 CLI 读取；本模块只协调未提交材料，不维护
//        accepted queue。
// [失败路径] 任何准备失败都整批 failed，不提交部分材料，避免半个话题被续接。
interface TopicContinuationPorts<T> {
  // 返回当前运行的 runId；没有运行返回 undefined。
  readRunningRun(): Promise<string | undefined>;
  /** 必须等到指定 run 的权威终态；停止 RPC 返回不等于运行已经结束。 */
  stopAndWait(runId: string): Promise<void>;
  /** 只提交到既有 CLI admission，不能在这里另建 accepted queue。 */
  // 提交顺序即最终注入顺序。
  submit(messages: T[]): Promise<void>;
  // 失败回调必须覆盖整批 id，便于 UI 标记。
  failed(messageIds: string[], error: unknown): void | Promise<void>;
}

type Prepared<T> = { ok: true; value: T } | { ok: false; error: unknown };
interface Pending<T> {
  id: string;
  prepared: Promise<Prepared<T>>;
}

/** 仅协调未提交的材料；run 的权威状态仍由调用方从 CLI 获取。 */
export function createTopicContinuation<T>(ports: TopicContinuationPorts<T>) {
  // 待提交材料；只存 Promise，不缓存已解析内容。
  let pending: Pending<T>[] = [];
  // 取消代次，见 INV-02。
  let generation = 0;
  let releaseCancellation!: () => void;
  let cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  // 单飞：同一时刻只有一个 drain 在跑。
  let draining: Promise<void> | undefined;
  // 入站 id 去重；重复投递不重复准备。
  const seen = new Set<string>();

  async function drain(): Promise<void> {
    while (pending.length) {
      const currentGeneration = generation;
      const cancelled = cancellation;
      let submitting: Pending<T>[] | undefined;
      try {
        // 读取 run 与取消信号竞速，取消优先。
        const runId = await Promise.race([ports.readRunningRun(), cancelled.then(() => undefined)]);
        if (currentGeneration !== generation) continue;
        // 旧实现串行等待附件，导致后来的输入无法及时停止运行。先停止，再等材料。
        // 先停止再等材料（见 INV-01）。
        if (runId) await Promise.race([ports.stopAndWait(runId), cancelled]);
        if (currentGeneration !== generation) continue;
        let batch: Pending<T>[] = [];
        let prepared: Prepared<T>[] = [];
        do {
          // 每轮重取快照；等待期间新增的消息属于下一轮。
          batch = [...pending];
          prepared = await Promise.race([
            Promise.all(batch.map((message) => message.prepared)),
            cancelled.then(() => []),
          ]);
          if (currentGeneration !== generation) break;
          // 等附件期间到达的消息也属于下一轮，保留到达顺序而非完成顺序。
          // 长度不变才说明这一批已经稳定。
        } while (batch.length !== pending.length);
        if (currentGeneration !== generation) continue;
        pending.splice(0, batch.length);
        // 任一条准备失败即整批失败（见失败路径）。
        const failure = prepared.find((item) => !item.ok);
        if (failure && !failure.ok) {
          await ports.failed(
            batch.map((message) => message.id),
            failure.error,
          );
          continue;
        }
        // 标记已进入提交阶段；此阶段失败只回滚这一批。
        submitting = batch;
        await ports.submit(
          prepared.map((item) => {
            if (!item.ok) throw item.error;
            return item.value;
          }),
        );
      } catch (error) {
        if (currentGeneration !== generation) continue;
        // 提交阶段失败只报当前批；准备阶段失败报全部待处理。
        const failed = submitting ?? pending;
        if (!submitting) pending = [];
        await ports.failed(
          failed.map((message) => message.id),
          error,
        );
      }
    }
  }

  // 幂等启动；已有 drain 时不重复进入。
  function start(): void {
    if (draining) return;
    draining = drain().finally(() => {
      draining = undefined;
      // drain 结束后若有新到材料则继续消费。
      if (pending.length) start();
    });
  }

  return {
    // 返回 false 表示重复投递，已被忽略。
    receive(id: string, prepare: () => Promise<T>): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      // 立刻开始准备，但错误被折叠进结果，不产生未处理拒绝。
      const prepared = Promise.resolve()
        .then(prepare)
        .then<Prepared<T>, Prepared<T>>(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      pending.push({ id, prepared });
      start();
      return true;
    },
    // 取消只影响未提交材料；已提交内容不回滚。
    cancel(): void {
      generation++;
      pending = [];
      releaseCancellation();
      cancellation = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      });
    },
    // 等待当前 drain 收敛，测试与关停路径使用。
    async settled(): Promise<void> {
      while (draining) await draining;
    },
  };
}
