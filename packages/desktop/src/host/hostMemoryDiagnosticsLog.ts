// Host 进程自身的内存诊断日志。
//
// 职责：每 60s 读一次 process.memoryUsage()，经变化 / 心跳门控后写一行
// `[memory] role=utility_host ...` 到既有 host logger，由 logger 转发到 Desktop 主日志。
// 输入输出：输入 logger / collectCounters / 可选 readMemoryUsage / onMemoryUsage / now /
// intervalMs / timer；输出 { sampleNow, stop }，sampleNow 返回本次是否真正写盘。
// 副作用：创建 setInterval（若可用会 unref，不阻止进程退出）；写日志；调用 onMemoryUsage
// 遥测出口。不新增 parentPort 消息类型。
// 失败语义：读数失败、门控不写、日志异常均只丢当前样本并返回 false，绝不影响 Host 服务；
// 遥测出口抛错只丢遥测，本地日志照写。
// 维护的不变量：本地日志与遥测共享同一次 memoryUsage 读数；stop 幂等且释放定时器，
// 避免 Host 退出阶段残留 interval。

import {
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryUsageToSampleFields,
  type MemorySample,
} from "@zcode/shared";

interface HostMemoryDiagnosticsLogger {
  info(...args: unknown[]): void;
}

interface HostMemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface StartHostMemoryDiagnosticsLogOptions {
  logger: HostMemoryDiagnosticsLogger;
  /** services 层的领域计数器（`collectServiceMemoryDiagnostics`）。 */
  collectCounters(): Record<string, number>;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  /**
   * 同一次 `memoryUsage()` 读数的第二个出口：资源遥测的 host 样本
   *
   * 与写盘门控无关——本地日志可能被门控跳过，遥测样本每 60 秒都要发；
   * 该回调抛错只丢遥测样本，不影响本地日志。
   */
  onMemoryUsage?: (memoryUsage: NodeJS.MemoryUsage) => void;
  now?: () => number;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): HostMemoryDiagnosticsTimerHandle;
    clearInterval(handle: HostMemoryDiagnosticsTimerHandle): void;
  };
}

export interface HostMemoryDiagnosticsLog {
  /** 立即采样一次（供测试与手动触发），返回是否写盘。 */
  sampleNow(): boolean;
  stop(): void;
}

// 启动内存诊断日志，返回手动采样与停止句柄。
// 默认依赖（process.memoryUsage / Date.now / setInterval）都可注入，便于测试与假时钟。
// 定时器创建后尝试 unref：诊断日志不应成为 Host 进程存活的理由。
// 失败语义：所有内部异常都被吞掉，只影响当前样本；stop 后 handle 置空，重复 stop 为 no-op。
/**
 * Local Host 进程自身的内存诊断日志。
 * 60s 采样、变化/心跳门控后写一行 `[memory] role=utility_host ...`，经既有 host logger
 * 转发到 Desktop 主日志；不新增 parentPort 消息类型。
 */
export function startHostMemoryDiagnosticsLog(
  options: StartHostMemoryDiagnosticsLogOptions,
): HostMemoryDiagnosticsLog {
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: HostMemoryDiagnosticsTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const gate = createMemorySampleWriteGate();

  // 采样一次：读数 → 遥测出口 → 门控 → 本地写盘，三步各自独立容错。
  // 返回 false 表示「没写盘」而不是「失败」——门控跳过也返回 false，调用方不能据此判定异常。
  // 先发遥测再判断门控，保证本地日志被门控跳过时远端样本仍按 60s 节奏发送。
  const sampleNow = (): boolean => {
    let memoryUsage: NodeJS.MemoryUsage;
    try {
      memoryUsage = readMemoryUsage();
    } catch {
      // 读数失败时两个出口都没有事实可用，只丢当前样本。
      return false;
    }

    try {
      options.onMemoryUsage?.(memoryUsage);
    } catch {
      // 遥测出口失败只丢当前样本，本地诊断日志照写。
    }

    try {
      const sample: MemorySample = {
        role: "utility_host",
        ...memoryUsageToSampleFields(memoryUsage),
        counters: options.collectCounters(),
      };
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      options.logger.info(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // 诊断采样失败只丢当前样本，不能影响 Host 服务。
      return false;
    }
  };

  let handle: HostMemoryDiagnosticsTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // unref 不可用时仍保留 handle 供 stop 回收。
  }

  return {
    sampleNow,
    // 停止采样：先取走并清空 handle 再 clearInterval，防止并发 stop 重复清理同一个句柄。
    // 句柄为空时直接返回，因此 stop 可安全重复调用。
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      timer.clearInterval(current);
    },
  };
}
