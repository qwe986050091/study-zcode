// ============================================================
// 流式空闲超时与父级 abort 联动
// 定位：provider 长时间不吐 chunk 时主动判失败，同时保证用户 Stop 能立即打断读取。
// 输入：baseTimeoutMs/retryNumber（递增重试）、iterator、AbortController。
// 输出：resolveModelStreamIdleTimeoutMs 返回有效超时（<=0 表示显式禁用）；读取返回 IteratorResult。
// 副作用：setTimeout/clearTimeout、注册与移除 abort 监听、按超时 abort controller。
// 失败语义：超时抛 ModelStreamIdleTimeoutError；外部 abort 抛 signal.reason；两者形状不同，供上层分型。
// 不变量：每次重试把超时上调固定步长；竞态结束后必须清理定时器与监听，避免泄漏。
// ============================================================

import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "@zcode/contracts";

export { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "@zcode/contracts";

export const MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS = 30_000;

/**
 * 计算本次实际空闲超时：缺省/非法 base 用 contracts 默认值；
 * base <= 0 视为显式禁用，原样返回（后续读取走无超时快路径）。
 * retryNumber 越大超时越长（每次 +30s），给已重试的慢模型更多时间，避免重试后更容易超时。
 */
export function resolveModelStreamIdleTimeoutMs(options: {
  baseTimeoutMs?: number;
  retryNumber?: number;
}): number {
  const baseTimeoutMs =
    options.baseTimeoutMs === undefined || !Number.isFinite(options.baseTimeoutMs)
      ? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS
      : options.baseTimeoutMs;
  if (baseTimeoutMs <= 0) {
    return baseTimeoutMs;
  }

  const retryNumber =
    options.retryNumber === undefined || !Number.isFinite(options.retryNumber)
      ? 0
      : Math.max(0, Math.floor(options.retryNumber));
  return baseTimeoutMs + retryNumber * MODEL_STREAM_IDLE_TIMEOUT_RETRY_INCREMENT_MS;
}

/**
 * 空闲超时错误。idleMs 为实际静默时长，timeoutMs 为当次配置阈值（用于文案与归因）；
 * code 固定字符串便于跨进程/包装层识别（instanceof 在跨 realm 不可靠）。
 */
class ModelStreamIdleTimeoutError extends Error {
  readonly code = "MODEL_STREAM_IDLE_TIMEOUT";
  readonly idleMs: number;
  readonly timeoutMs: number;

  constructor(options: { idleMs: number; timeoutMs: number }) {
    super(`Model stream stalled: no event received for ${options.timeoutMs}ms.`);
    this.name = "ModelStreamIdleTimeoutError";
    this.idleMs = options.idleMs;
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * 识别空闲超时错误：先 instanceof，再按 code/name 兜底，
 * 因为错误可能被 SDK 包装或跨 warp 传递，单纯 instanceof 会漏判。
 */
export function isModelStreamIdleTimeoutError(
  error: unknown,
): error is ModelStreamIdleTimeoutError {
  if (error instanceof ModelStreamIdleTimeoutError) {
    return true;
  }

  if (error === null || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    record.code === "MODEL_STREAM_IDLE_TIMEOUT" ||
    record.name === "ModelStreamIdleTimeoutError"
  );
}

/** 与父信号联动的 controller 及其清理函数；cleanup 幂等且不改变 signal 状态。 */
interface LinkedAbortController {
  controller: AbortController;
  signal: AbortSignal;
  cleanup(): void;
}

/**
 * 创建子 AbortController 并把父信号的 abort 转发过来（reason 原样透传，保留 cancelled 语义）。
 * 父信号已 abort 时立即同步转发布 abort；无父信号时 cleanup 为空操作。
 * 调用方必须在结束时 cleanup，否则父信号长期存活会累积监听器。
 */
export function createLinkedAbortController(parentSignal?: AbortSignal): LinkedAbortController {
  const controller = new AbortController();

  if (!parentSignal) {
    return {
      controller,
      signal: controller.signal,
      cleanup() {},
    };
  }

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return {
      controller,
      signal: controller.signal,
      cleanup() {},
    };
  }

  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason);
    }
  };
  parentSignal.addEventListener("abort", abortFromParent, { once: true });

  return {
    controller,
    signal: controller.signal,
    cleanup() {
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * 带空闲超时地读取下一个 chunk：iterator.next() 与 timeout/abort 三个 Promise 竞速。
 * timeoutMs 非正或非有限时退化为直接 next()（不设超时）。
 * 超时分支会先 abort controller 再 reject，确保底层请求被真正取消；同时回调 onTimeout（发状态事件）。
 * 非超时失败（含外部 abort）原样抛出，不做包装；finally 清理定时器与 abort 监听。
 */
export async function readNextWithStreamIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  options: {
    abortController: AbortController;
    onTimeout?: (error: ModelStreamIdleTimeoutError) => void | Promise<void>;
    timeoutMs: number;
  },
): Promise<IteratorResult<T>> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return iterator.next();
  }

  const readStartedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timedOut = false;
  let timeoutError: ModelStreamIdleTimeoutError | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      if (options.abortController.signal.aborted) {
        reject(options.abortController.signal.reason ?? new Error("Model stream aborted."));
        return;
      }
      timedOut = true;
      timeoutError = new ModelStreamIdleTimeoutError({
        idleMs: Math.max(0, Date.now() - readStartedAt),
        timeoutMs: options.timeoutMs,
      });
      options.abortController.abort(timeoutError);
      reject(timeoutError);
    }, options.timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const signal = options.abortController.signal;
    const rejectAbort = () => {
      reject(signal.reason ?? new Error("Model stream aborted."));
    };
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    // Stop 按钮会 abort 当前模型请求；如果底层 provider 没有让 iterator.next()
    // 立刻返回，这里必须主动结束等待，否则 UI 会一直卡到 idle timeout。
    signal.addEventListener("abort", rejectAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", rejectAbort);
  });

  try {
    return await Promise.race([iterator.next(), timeoutPromise, abortPromise]);
  } catch (error) {
    if (!timedOut) {
      throw error;
    }

    const idleError =
      timeoutError ??
      new ModelStreamIdleTimeoutError({
        idleMs: Math.max(0, Date.now() - readStartedAt),
        timeoutMs: options.timeoutMs,
      });
    await options.onTimeout?.(idleError);
    throw idleError;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    removeAbortListener?.();
  }
}
