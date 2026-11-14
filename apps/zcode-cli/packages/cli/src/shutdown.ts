// CLI 退出编排：信号处理、清理超时、E2E coverage 落盘与退出看门狗。
// 目标是在任何退出路径上既不挂死进程，也不丢失关键清理（关闭会话、释放 Host 连接、刷新诊断产物）。
import { takeCoverage } from "node:v8";

// 单次清理的默认上限（毫秒）：超时即放弃清理并继续退出，避免 Ctrl+C 后进程卡住。
const DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS = 2_000;
// 供入口处传入的更宽裕上限，覆盖需要关闭远端连接的场景。
export const DEFAULT_CLI_CLEANUP_TIMEOUT_MS = 6_000;
// 退出看门狗默认等待时长（毫秒）：正常 run() 完成后仍有残留 handle 时兜底退出。
const DEFAULT_CLI_EXIT_WATCHDOG_TIMEOUT_MS = 1_000;
// 信号 → shell 约定退出码；未列出的信号回落 1。
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

// 信号监听器签名：不接收参数，信号名由注册处闭包捕获。
type SignalListener = () => void;

// 退出编排所需的进程能力子集，便于测试注入假 process。
export interface CliShutdownProcess {
  // 当前平台；决定监听哪些信号（Windows 无 SIGHUP）。
  platform: NodeJS.Platform;
  // 解绑/绑定一次性信号监听。
  off(signal: NodeJS.Signals, listener: SignalListener): unknown;
  once(signal: NodeJS.Signals, listener: SignalListener): unknown;
}

// registerCliShutdownHandlers 的选项。
interface CliShutdownOptions {
  // 收到信号时先通知业务侧中止（如取消进行中的 turn），可为空。
  abort?: (signal: NodeJS.Signals) => void;
  // 业务清理动作；抛错会被吞掉，不阻塞退出。
  cleanup: () => Promise<void> | void;
  // 清理超时（毫秒）；0 表示不设超时，缺省 DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS。
  cleanupTimeoutMs?: number;
  // 实际退出函数；缺省 process.exit。
  exitProcess?: (code: number) => void;
  // 进程替身；缺省全局 process。
  process?: CliShutdownProcess;
}

// 退出看门狗选项。
interface CliExitWatchdogOptions {
  // 看门狗触发时使用的退出码；0 表示正常结束。
  exitCode: number;
  // 实际退出函数；缺省 process.exit。
  exitProcess?: (code: number) => void;
  // 等待时长（毫秒），最小 1；缺省 DEFAULT_CLI_EXIT_WATCHDOG_TIMEOUT_MS。
  timeoutMs?: number;
}

// 注册信号处理并返回注销函数。
// 输入：abort/cleanup/超时/进程替身，均可选（cleanup 必填）。
// 输出：unregister —— 幂等，解绑全部监听；必须在正常结束路径上调用，否则监听会阻止进程退出。
// 副作用：注册 SIGINT/SIGTERM（非 Windows 还有 SIGHUP）一次性监听；收到信号后执行 abort、清理、coverage 落盘并 exit。
// 重入保护：shuttingDown 保证连续两次 Ctrl+C 只跑一次清理；第二次不会再触发退出码计算。
// 失败语义：清理抛错或超时都继续退出；只有 exitProcess 本身抛错才会向上传播。
export function registerCliShutdownHandlers(options: CliShutdownOptions): () => void {
  const signalTarget = options.process ?? process;
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const cleanupTimeoutMs = Math.max(
    0,
    Math.trunc(options.cleanupTimeoutMs ?? DEFAULT_SHUTDOWN_CLEANUP_TIMEOUT_MS),
  );
  const signals = shutdownSignals(signalTarget.platform);
  const listeners: Array<[NodeJS.Signals, SignalListener]> = [];
  let disposed = false;
  let shuttingDown = false;

  const unregister = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      signalTarget.off(signal, listener);
    }
  };

  const shutdown = async (signal: NodeJS.Signals) => {
    // 用户可能连按多次 Ctrl+C；清理只跑一次，避免重复关闭 adapter 造成状态错乱。
    if (shuttingDown) return;
    shuttingDown = true;
    // detached shell processes form their own process group, so parent
    // process shutdown must explicitly close the app before Node exits.
    options.abort?.(signal);
    await runCliCleanupWithTimeout(options.cleanup, cleanupTimeoutMs);
    await flushE2ECoverage();
    unregister();
    exitProcess(exitCodeForSignal(signal));
  };

  for (const signal of signals) {
    const listener = () => {
      void shutdown(signal);
    };
    signalTarget.once(signal, listener);
    listeners.push([signal, listener]);
  }

  return unregister;
}

// 在 E2E coverage 模式下强制把 V8 coverage 落盘。
// 输入：无；开关与目标目录来自环境变量。
// 输出：Promise，恒 resolve —— 写盘失败只影响诊断产物，不影响退出。
// 副作用：触发 V8 后台写盘，并额外等待 500ms 保证文件写完（即使覆盖写是异步的）。
// 降级语义：非 coverage 模式立即返回，不增加任何退出延迟。
export async function flushE2ECoverage(): Promise<void> {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return;
  }
  try {
    // Agent shutdown 最终调用 process.exit，SIGTERM 路径不会可靠触发
    // NODE_V8_COVERAGE 的自动落盘；只在 E2E coverage 模式下显式刷新。
    takeCoverage();
    // takeCoverage 会把写盘交给 V8 后台任务；立即 process.exit 偶发只留下 readiness
    // marker。coverage 模式留出短暂落盘窗口，普通 CLI shutdown 不增加延迟。
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  } catch {
    // coverage 是诊断产物，写盘失败不能阻塞 CLI 的既有退出流程。
  }
}

// 该平台需要监听的终止信号；Windows 无法投递 SIGHUP，监听它只会多一个永不触发的句柄。
function shutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

// 信号名折算成 shell 退出码；未知信号按 1 处理，避免退化为 0 让脚本误判成功。
function exitCodeForSignal(signal: NodeJS.Signals): number {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

// 在超时约束内执行清理，超时或失败都静默放过。
// 输入：cleanup 可为同步或异步；timeoutMs 为 0 表示不设超时（等待其自然完成）。
// 输出：恒 resolve 的 Promise，不会因为 cleanup 抛错或超时而 reject。
// 副作用：启动一个 unref 的超时定时器（不阻止进程退出），结束时清理。
export async function runCliCleanupWithTimeout(
  cleanup: () => Promise<void> | void,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const cleanupPromise = Promise.resolve().then(cleanup);
    if (timeoutMs === 0) {
      await cleanupPromise;
      return;
    }

    await Promise.race([
      cleanupPromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } catch {
    // Shutdown cleanup is best-effort; exiting should not be blocked by a
    // failing adapter close path.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// 安排一个退出看门狗：万一正常结束后仍有未知 handle 挂住 event loop，到点强制退出。
// 输入：退出码与等待时长（最小 1ms）。
// 输出：取消函数，正常退出路径应调用它清除定时器。
// 副作用：注册 unref 定时器，因此它自身不会拖住进程；只有真正卡住时才会触发。
export function scheduleCliExitWatchdog(options: CliExitWatchdogOptions): () => void {
  const exitProcess = options.exitProcess ?? ((code: number) => process.exit(code));
  const timeoutMs = Math.max(
    1,
    Math.trunc(options.timeoutMs ?? DEFAULT_CLI_EXIT_WATCHDOG_TIMEOUT_MS),
  );
  const timer = setTimeout(() => {
    // 正常 run() 已完成后仍可能残留未知 pipe/socket handle。watchdog
    // 只在 event loop 到 deadline 仍未耗尽时执行，因此不会延迟自然退出路径。
    void flushE2ECoverage().finally(() => exitProcess(options.exitCode));
  }, timeoutMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
