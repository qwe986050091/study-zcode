/**
 * ============================================================================
 * runtime/methods/runtime-command-submit.ts —— 可取消的"入队并等待"原语
 * ============================================================================
 *
 * 把"创建命令 → 入队 → 等它被执行/拒绝"包成一个 Promise,并处理三种竞态:
 *   1. 入队前 signal 已 abort → 直接拒绝,不创建队列残留;
 *   2. 还在队列里时 abort → removeById 成功,按 turn 取消错误拒绝;
 *   3. 刚出队、尚未真正执行时 abort → removeById 失败,改用 markCancelPending,
 *      由执行侧看到标记后跳过(两阶段取消,避免"取消丢掉正在执行的命令")。
 *
 * 【提交点】onCommandAccepted 在"已通过 abort 检查、尚未入队"的同步点调用:
 * 调用方用它登记账本/占位,若它抛错则不入队并回滚(按取消处理)。
 * Promise 的 resolve/reject 由命令自身在真正执行完成时调用,本函数只负责清理监听。
 * ============================================================================
 */
import type { RuntimeCommand, RuntimeCommandId } from "../command-queue.js";
import { createTurnCancelledError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ResolvableRuntimeCommand<Result> = RuntimeCommand & {
  readonly id: RuntimeCommandId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: Result) => void;
};

export function enqueueCancellableRuntimeCommand<
  Result,
  Command extends ResolvableRuntimeCommand<Result>,
>(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    createCommand: (handlers: {
      reject: (error: unknown) => void;
      resolve: (result: Result) => void;
    }) => Command;
    onCommandCancelled?: () => void;
    /** 已通过取消检查，尚未进入 drain 的同步接纳点。 */
    onCommandAccepted?: () => void;
  },
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    // settled 是双保险:abort 与命令自身的 resolve/reject 可能并发到达,
    // 只允许第一个生效,避免 Promise 被 settle 两次(后续调用静默忽略)并重复清理。
    let settled = false;
    const abortSignal = input.abortSignal;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", abortQueuedCommand);
    };
    const resolveCommand = (result: Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectCommand = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const command = input.createCommand({
      reject: rejectCommand,
      resolve: resolveCommand,
    });
    function abortQueuedCommand() {
      if (settled) return;
      const removed = runtime.runtimeCommandQueue.removeById(command.id);
      if (removed) {
        // 还在队列里:移除即取消,onCommandCancelled 负责回滚账本/占位。
        // 竞态窗口 1：命令仍在队列中，removeById 成功，直接 reject。
        input.onCommandCancelled?.();
        rejectCommand(createTurnCancelledError(abortSignal?.reason));
        return;
      }
      // 取消可能撞上 command 刚出队但尚未进入实际执行的窄窗口，先记账让执行侧跳过。
      // 这里不 reject:命令已经在执行侧手里,由它 consume 标记后自行终止并 settle。
      // 竞态窗口 2：命令刚出队但尚未执行，removeById 失败。
      // 不变量 5：两阶段取消（markCancelPending → consumeCancelPending）保证
      // "取消信号到达时命令不会被执行两次"，也不会被静默丢失。
      runtime.runtimeCommandQueue.markCancelPending(command.id);
    }
    // 竞态窗口 0：入队前 signal 已 abort。
    if (abortSignal?.aborted) {
      // 入队前已取消:连命令都不创建队列项,直接按取消拒绝。
      input.onCommandCancelled?.();
      rejectCommand(createTurnCancelledError(abortSignal.reason));
      return;
    }
    abortSignal?.addEventListener("abort", abortQueuedCommand, { once: true });
    try {
      // 同步接纳点:调用方在这里登记账本/预留资源。抛错则不把命令放进队列,
      // 并按"取消"回滚,避免账本已记但队列没有对应项。
      input.onCommandAccepted?.();
    } catch (error) {
      input.onCommandCancelled?.();
      rejectCommand(error);
      return;
    }
    // 入队后 resolve/reject 由命令执行侧调用;本 Promise 只等待结果。
    runtime.enqueueRuntimeCommand(command);
  });
}
