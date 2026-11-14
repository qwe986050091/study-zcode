import type { SessionResidencyFinalizationOwner } from "./contract.js";
export type { SessionResidencyFinalizationOwner } from "./contract.js";

/**
 * residency lease 只覆盖 Bootstrap detached runner 的收尾窗口，避免 pool 回收仍在使用的
 * record。Prompt admission 的 busy/idle authority 已归 Core；activeAbortController 仅是旧命令
 * 路径的兼容取消句柄，不能再作为 prompt 调度锁。
 */
// 计数语义：只增在原 record 上（不新建第二个 record / 锁）；release 幂等（Math.max 兜底 0），
// pool 回收据此判断 record 是否仍被使用；返回函数必须在成功/失败/同步抛错所有终态执行。
export function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

// 同步登记先于 run() 是必要的：run 可能在首个 await 前就被 pool 回收扫描命中；
// 同步抛错时手动 release 并返回 rejected promise，保证 await 语义与释放一致。
// 注意不能在这里再次套一层 busy/idle 锁——Prompt admission 的权威已归 Core。
/** 同步登记 lease，再启动 detached runner；同步抛错和异步终态都保证释放。 */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}
