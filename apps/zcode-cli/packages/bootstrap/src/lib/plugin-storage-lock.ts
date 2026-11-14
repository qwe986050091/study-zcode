// In-process serialization of plugin storage mutations (install/update/uninstall/
// restore). The desktop talks to a single app-server process, so a per-storageRoot
// promise chain is sufficient to prevent interleaved read-modify-write on
// installed_plugins.json / cache dirs / user config. Cross-process locking is a
// non-goal for this iteration.
const chains = new Map<string, Promise<unknown>>();

/**
 * 同一 storageRoot 上的插件存储写操作串行化（install/update/uninstall/restore）。
 *
 * 语义：
 * - 只有进程内 promise chain，没有跨进程锁：desktop 只连一个 app-server 进程，
 *   本轮目标就是防止同一进程内安装/卸载/更新互相穿插造成 read-modify-write 丢失；
 * - 前一次操作失败不影响后续排队（gate 吞掉 previous 的 rejection）；
 * - 返回的 run 保留原始结果/异常，调用方仍能拿到真实错误；
 * - 注意：已持有锁的路径不能再调用本函数，否则同一 storageRoot 会等待自己而死锁
 *   （plugins.ts 因此区分了「无锁核心 + 公开入口加锁」两层）。
 */
export async function withPluginStorageLock<T>(
  storageRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(storageRoot) ?? Promise.resolve();
  // Chain regardless of previous outcome; swallow prior errors for the gate only.
  const gate = previous.then(
    () => undefined,
    () => undefined,
  );
  const run = gate.then(() => operation());
  // Keep the chain alive but never let a rejection break future gating.
  chains.set(
    storageRoot,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
