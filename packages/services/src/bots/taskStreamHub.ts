// bots/taskStreamHub.ts — 按 taskKey 复用单条上游实时流，并向多个渠道目标扇出。
//
// INV-01 同一 taskKey 只有一个 upstream 订阅；多个 target 共享同一事件序列，
//        避免同一任务在多渠道各开一条流导致事件乱序或重复投递。
// INV-02 每个 target 自己串行消费；某渠道抛错不阻塞其他渠道，因此用
//        Promise.allSettled 而不是 Promise.all。
// INV-03 dispose 前必须确认该 target 仍绑定当前 listener：先 add 后 dispose 的
//        旧句柄不能误删新监听器（否则热重载会静默丢事件）。
// [资源] 最后一个 target 释放时才销毁 upstream 并从 map 删除；否则复用中的流
//        会被提前关闭。
// [失败路径] listener 的异常被 allSettled 吞掉，调用方看不到；渠道层必须自行
//        记录失败，不能假设上层会重试。
interface Disposable {
  dispose(): void;
}

/** 同一任务只有一个实时源；接收目标自己串行消费，单个渠道失败不阻塞其他渠道。 */
export function createBotTaskStreamHub<Event>() {
  const streams = new Map<
    string,
    {
      upstream: Disposable;
      listeners: Map<string, (event: Event) => Promise<void> | void>;
    }
  >();
  return {
    add(
      taskKey: string,
      targetKey: string,
      subscribe: (listener: (event: Event) => Promise<void>) => Disposable,
      listener: (event: Event) => Promise<void> | void,
    ): Disposable {
      // 复用已有流：首个 target 创建 upstream，其余 target 只挂监听器。
      let stream = streams.get(taskKey);
      if (!stream) {
        const listeners = new Map<string, (event: Event) => Promise<void> | void>();
        // 上游事件在这里扇出；listener 的返回值不参与收敛，只表示消费完成。
        const upstream = subscribe(async (event) => {
          await Promise.allSettled([...listeners.values()].map(async (receive) => receive(event)));
        });
        stream = { listeners, upstream };
        streams.set(taskKey, stream);
      }
      // 同一 targetKey 重复 add 视为替换监听器；旧句柄 dispose 时会被 INV-03 拦下。
      stream.listeners.set(targetKey, listener);
      // current 快照用于 dispose 闭包，避免闭包读到被替换后的 stream。
      const current = stream;
      return {
        dispose() {
          // 只有当前绑定的 listener 才允许注销，防止旧句柄误删新监听器。
          if (current.listeners.get(targetKey) !== listener) return;
          current.listeners.delete(targetKey);
          if (current.listeners.size === 0) {
            // 最后一个监听器释放后才关闭上游，避免其他渠道仍在消费时被切断。
            current.upstream.dispose();
            if (streams.get(taskKey) === current) streams.delete(taskKey);
          }
        },
      };
    },
    dispose() {
      // 整体销毁：先清监听器再关上游，确保 close 回调不会再触发 listener。
      for (const stream of streams.values()) {
        stream.listeners.clear();
        stream.upstream.dispose();
      }
      streams.clear();
    },
  };
}
