/** Host 在途发送屏障；accepted input 和 commandId 幂等仍由 CLI 管理。 */
// 按 key 维护的在途屏障：它只保证发送顺序与失效语义，不承担 commandId 幂等。
export function createBotTopicAdmission() {
// 版本号用于让尚未发送的准备工作失效：run 前会重新比对捕获值。
  const versions = new Map<string, number>();
// tail 记录该 key 上最后一个发送的完成信号，新发送必须排在它之后。
  const tails = new Map<string, Promise<void>>();
  const capture = (key: string) => versions.get(key) ?? 0;

  return {
    capture,
// [并发] 先递增版本再等待已有 tail：顺序反了会漏掉「已经越过版本检查、
// 但尚未真正发出」的命令。
    async invalidate(key: string): Promise<void> {
      // 先使尚未发送的准备工作失效，再等待已发送的命令收口。
      // 若直接返回，Agent 内部等待连接/上下文的旧命令可能在取消完成后才发出。
      versions.set(key, capture(key) + 1);
      await tails.get(key);
    },
// 先排队、再校验版本、最后发送：释放与登记都在 finally 中完成。
    async run<T>(key: string, version: number, send: () => Promise<T>): Promise<T> {
      const previous = tails.get(key);
      let release!: () => void;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, tail);
      try {
        await previous;
        if (version !== capture(key))
          throw new Error("Topic input was cancelled during preparation");
        return await send();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}
