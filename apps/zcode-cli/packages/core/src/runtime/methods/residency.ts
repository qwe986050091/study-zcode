/**
 * ============================================================================
 * runtime/methods/residency.ts —— session 常驻池的"还有活"判定
 * ============================================================================
 *
 * 【定位】bootstrap 的常驻池只通过 hasResidencyBlockingWork 决定能否关闭
 * 一个空闲 session。本文件把"哪些工作仍然依赖该 runtime"收敛成单一判定，
 * 新增 sidecar 时只改这里，不再修改 bootstrap 的猜测列表。
 *
 * 【六类阻塞项】
 *   - off-peak 执行未终结（lifecycle.terminal === false）；
 *   - 有活跃/排队的 turn 工作（hasActiveOrQueuedTurnWork）；
 *   - 有运行中的后台任务（hasRunningBackgroundTasks）；
 *   - 有 detached Promise（residencyBlockingWorkCount）；
 *   - 记忆抽取调度器仍有待处理工作；
 *   - 记忆 recall 预取尚未 settle。
 *
 * 【计数纪律】trackResidencyBlockingWork 必须在 Promise 启动的同一同步片
 * 增加计数，并只在 finally 释放：若先 await 再登记，中间的空窗会让常驻池
 * 误判 idle 并关闭 runtime。
 * ============================================================================
 */

import type { AgentRuntimeInternal } from "../internal.js";
import { getOffPeakExecution } from "../off-peak/runtime.js";

/**
 * 登记会越过当前同步调用栈的 runtime-owned work。
 *
 * session 常驻池过去只观察 active turn 与 task registry；title、MCP startup、
 * ledger write 等 detached Promise 不在两者中，可能在仍读写 runtime 时被当作 idle 关闭。
 * 计数必须在 Promise 启动的同一同步片增加，并只在 finally 释放。
 */
export function trackResidencyBlockingWork<T>(
  this: AgentRuntimeInternal,
  work: Promise<T>,
): Promise<T> {
  this.residencyBlockingWorkCount += 1;
  return work.finally(() => {
    this.residencyBlockingWorkCount = Math.max(0, this.residencyBlockingWorkCount - 1);
  });
}

/**
 * Session 常驻池只消费这一项。
 *
 * 返回 true 表示"现在不能关闭"，任一条件成立即可。注意它是保守判定：
 * 宁可多留一个 session 几秒，也不能在 detached work 仍读写 runtime 时关掉它
 * （后者会造成写丢失或恢复出半截状态）。
 * 新增 sidecar 时把条件加在这里，不要改 bootstrap。
 */
export function hasResidencyBlockingWork(this: AgentRuntimeInternal): boolean {
  return (
    getOffPeakExecution(this)?.lifecycle.terminal === false ||
    this.hasActiveOrQueuedTurnWork() ||
    this.hasRunningBackgroundTasks() ||
    this.residencyBlockingWorkCount > 0 ||
    (this.memoryExtractionScheduler?.hasPendingWork() ?? false) ||
    (this.memoryRecallPrefetch !== undefined && !this.memoryRecallPrefetch.settled)
  );
}
