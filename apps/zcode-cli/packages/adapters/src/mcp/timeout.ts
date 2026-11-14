/* ============================================================
 * MCP 超时与截止时间（adapters/src/mcp/timeout.ts）
 *
 * 定位：为 MCP 调用提供绝对 deadline 语义，并给“某个 waiter”加超时。
 * 输入：超时毫秒（可被夹到非负整数）、deadline、promise、可选 AbortSignal。
 * 输出：promise 结果，或 McpTimeoutError / abort reason。
 * 副作用：每个等待创建一个 setTimeout，结束后清理；不取消底层共享 promise。
 * 失败语义：deadline 已过立即抛 McpTimeoutError；signal 已中止立即以 reason 拒绝。
 * 不变量：deadline 在整个调用链中共享（绝对时间点），重复等待不会重置预算；
 * 只限制 waiter，不改变底层任务自己的生命周期（取消由任务 owner 的 signal 负责）。
 * ============================================================ */

/**
 * MCP 拨号超时错误。
 *
 * 仅用于区分“超出本地预算”，不代表底层连接已被取消；调用方据此决定快照/重连，
 * 不应把它当成 server 返回的协议错误。
 */
export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

/**
 * 绝对 deadline：expiresAt 为 epoch ms，timeoutMs 为创建时的预算（用于日志/诊断）。
 * 一旦创建不再重置，多个 waiter 共享同一截止点。
 */
export interface McpDeadline {
  expiresAt: number;
  timeoutMs: number;
}

/**
 * 创建 deadline：超时先取整并夹到 >=0，再基于 Date.now() 计算绝对过期点。
 * 0 表示立即过期；无副作用。
 */
export function createMcpDeadline(timeoutMs: number): McpDeadline {
  const normalizedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  return {
    expiresAt: Date.now() + normalizedTimeoutMs,
    timeoutMs: normalizedTimeoutMs,
  };
}

/**
 * 返回剩余毫秒；已到期（<=0）抛 McpTimeoutError(message)。
 * 用于在发起下一步 IO 之前快速失败，避免用负超时进入定时器。
 */
export function remainingMcpDeadlineMs(deadline: McpDeadline, timeoutMessage: string): number {
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    throw new McpTimeoutError(timeoutMessage);
  }
  return remainingMs;
}

/**
 * 只限制当前 waiter，不取消传入的共享 promise。底层任务是否取消由自己的 owner signal 决定。
 */
/**
 * 在 deadline 剩余预算内等待 promise。
 *
 * 只限制当前 waiter：超时后原 promise 仍在运行，其取消由该任务自己的 owner signal 决定。
 * signal 中止或 deadline 到期都会清理定时器；两种拒绝原因分别是 abort reason 与
 * McpTimeoutError。无额外副作用。
 */
export function waitWithinMcpDeadline<T>(
  promise: Promise<T>,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return withTimeout(
    promise,
    remainingMcpDeadlineMs(deadline, timeoutMessage),
    timeoutMessage,
    signal,
  );
}

/**
 * 通用超时包装：promise 与 timer/abort 三者只允许 settle 一次。
 *
 * 先检查 signal 已中止（此时不建 timer）；timer 到期 reject McpTimeoutError；
 * abort 时以 signal.reason（若为 Error）或通用 Error 拒绝。任何先触发者都会
 * cleanup（clearTimeout + removeEventListener），避免悬挂监听与泄漏。
 * 注意：不 abort 传入的 promise，它可能继续产生副作用，调用方需自行处理。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(
        signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"),
      );
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new McpTimeoutError(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"),
      );
    };

    signal?.addEventListener("abort", abortHandler);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}
