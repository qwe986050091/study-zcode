// 取消语义助手：登录链路可能同时受用户取消与总超时控制（AbortSignal.any），
// 这两条工具把「已取消」转成异常/提前结束，避免迟到的网络响应继续写凭据。

/**
 * 同步检查取消信号；aborted 时优先抛 signal.reason（保留 auth_timeout 等原始错误类型），
 * 没有 reason 才退回通用取消错误。用于每个关键步骤之间的检查点。
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Login cancelled.");
}

// 即使注入的 transport 忽略 signal，也要在取消时立即停止等待：
// 用 Promise.race 把 abort 变成 rejection，并在 finally 里移除监听，避免长轮询泄漏监听器。
// 取消后原 Promise 仍可能完成，但其结果已被丢弃，不会再进入持久化步骤。
/** Stop awaiting cancelled I/O even when an injected transport ignores its signal. */
export async function waitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("Login cancelled."));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
