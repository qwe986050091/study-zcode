// ============================================================
// 文件定位：Bash 输出进度与资源遥测的共享定时器池（按 interval 分组）。
// 输入输出：subscribe 返回退订函数；回调收到 isActive 谓词用于丢弃迟到结果。
// 副作用：注册 setInterval（已 unref），回调里异步读取输出文件/采样进程。
// 失败语义：单个订阅者抛错只吞掉本次，不影响同组其他 Bash；重复退订幂等。
// 不变量：同一 interval 全进程只有一个 timer；最后一个订阅者退订时才销毁该组。
// ============================================================
type ProgressSubscriber = {
  // 该订阅者本轮是否正在读取，防止 setInterval 在慢 IO 上重入。
  reading: boolean;
  poll: (isActive: () => boolean) => Promise<void>;
};
type PollingGroup = {
  subscribers: Set<ProgressSubscriber>;
  timer: NodeJS.Timeout;
};

// 按周期共享：产品默认只有一个 1 秒轮询器，内部自定义周期不改变其他任务的频率。
const pollingGroups = new Map<number, PollingGroup>();

// 订阅一个周期的 Bash 进度轮询；返回退订函数。
// 同周期订阅者共享一个 unref 定时器，读取是串行去重的（reading 标志）。
// 退订后 isActive() 立即为 false，异步读取的迟到结果必须由回调自行丢弃。
export function subscribeBashOutputProgress(
  intervalMs: number,
  poll: ProgressSubscriber["poll"],
): () => void {
  let group = pollingGroups.get(intervalMs);
  if (!group) {
    const subscribers = new Set<ProgressSubscriber>();
    const timer = setInterval(() => {
      for (const subscriber of subscribers) {
        if (subscriber.reading) continue;
        subscriber.reading = true;
        const isActive = () => subscribers.has(subscriber);
        void Promise.resolve()
          .then(() => {
            if (isActive()) return subscriber.poll(isActive);
          })
          // 预览是尽力读取；单个文件或回调失败不能停止其他 Bash 的共享进度。
          .catch(() => undefined)
          .finally(() => {
            subscriber.reading = false;
          });
      }
    }, intervalMs);
    timer.unref();
    group = { subscribers, timer };
    pollingGroups.set(intervalMs, group);
  }
  const subscriber = { reading: false, poll };
  const { subscribers, timer } = group;
  subscribers.add(subscriber);
  return () => {
    // 旧订阅重复清理时不能删除同周期的新轮询器。
    // 仅当确实删掉了自己的条目且组已空，才停表并从分组表移除；否则新订阅者会失去定时器。
    if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
    clearInterval(timer);
    pollingGroups.delete(intervalMs);
  };
}
