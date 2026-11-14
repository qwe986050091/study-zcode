/**
 * 协议进程的诊断出口只有一个。必须监听真实流的异步 error，而不只是 catch write：
 * 否则 EPIPE -> uncaughtException -> 再写 stderr 会形成高 CPU 自激循环。
 *
 * 输入：stderr 为协议进程的真实错误流。
 * 输出：restore 回调，恢复原 write 并解绑监听；重复调用只生效一次。
 * 副作用：替换 stderr.write；失败后把该流标记为不可用，后续写入变为空操作。
 * 不变量：write 的返回值始终为 true —— 诊断输出不做背压，避免调用方因 drain 事件缺失而挂起。
 */
export function installProtocolStderrBoundary(stderr: NodeJS.WritableStream): () => void {
  const originalWrite = stderr.write;
  let unavailable = false;
  const onError = () => {
    unavailable = true;
  };
  stderr.on("error", onError);
  stderr.on("close", onError);
  stderr.write = ((chunk, encodingOrCallback, callback): boolean => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (!unavailable) {
      try {
        return originalWrite.call(stderr, chunk, encoding, (error) => {
          // 写回调带错即视为出口永久失效，后续诊断直接丢弃，避免反复触发同一失败路径。
          if (error) unavailable = true;
          writeCallback?.();
        });
      } catch {
        unavailable = true;
      }
    }
    // 诊断是 best effort；出口失效后仍完成调用方的 flush，不再写坏流或报告自身失败。
    // 丢弃时仍要异步回调一次，保证依赖 write(cb) 的库不会等待永不触发的 callback。
    if (writeCallback) queueMicrotask(() => writeCallback());
    return true;
  }) as typeof stderr.write;
  return () => {
    stderr.write = originalWrite;
    stderr.off("error", onError);
    stderr.off("close", onError);
  };
}
