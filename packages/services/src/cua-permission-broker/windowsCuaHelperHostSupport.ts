// Windows CUA Helper 的宿主侧支撑：spawn 适配、代际进程生命周期收敛、控制消息解析。
// Helper 是持有桌面控制能力的高权限子进程，本文件任何判断错误都可能留下失控的孤儿进程，
// 或把「已退出」误判成「仍在运行」而让宿主一直等待。
// INV-01：一次 terminate 必须收敛（退出或抛 termination blocker），不允许静默返回
//         （守住位置：terminate 的两轮 wait + throw）；否则恢复流程会以为旧 Helper 已死。
// INV-02：exit 事实只由 exit 事件写入 generation.exitObserved，任何超时路径都不能反向判定存活。
// INV-03：协议不匹配的控制消息必须返回 ignore 而非 null，新增消息类型不得让当前代际失败。
import { fork as nodeFork, type ForkOptions } from "node:child_process";

import {
  mintBrokerSocketPath,
  probeHelperHealth,
  type HelperHealth,
} from "@zcode/zcode-cua/broker";
// Contract constants are single-sourced from the producer package: locally re-declared literals here had drifted risk — a rename in the
// producer would silently orphan these. Kept as aliases for existing callers.
import { HELPER_ADDON_ENV, WINDOWS_DEV_CONTROL_PROTOCOL } from "@zcode/zcode-cua/broker/server";

import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { WindowsCuaRuntime } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

export const CONTROL_PROTOCOL = WINDOWS_DEV_CONTROL_PROTOCOL;
export const ADDON_ENV = HELPER_ADDON_ENV;

export interface WindowsCuaChild {
  readonly pid?: number;
  send(message: unknown): boolean;
  kill(): boolean;
  on(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this;
  off(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): this;
}

export interface WindowsCuaChildProcessAdapter {
  /** command 是运行时 Node/Electron，argv[0] 是 Helper entry。 */
  fork(command: string, argv: string[], options: ForkOptions): WindowsCuaChild;
}

export interface WindowsCuaHelperHostOptions {
  runtime: WindowsCuaRuntime;
  childProcess?: WindowsCuaChildProcessAdapter;
  mintSocketPath?: () => string;
  mintPluginAuthority?: () => string;
  healthProbe?: (socketPath: string, timeoutMs: number) => Promise<HelperHealth>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  logger?: ServiceLogger;
  /** Ready Helper 意外退出后通知生命周期 owner，仅触发 Helper recovery。 */
  onUnexpectedExit?: (info: { generation: number; pid: number | undefined }) => void;
}

export interface Generation {
  id: number;
  child: WindowsCuaChild;
  socketPath: string;
  stopped: boolean;
  exitObserved: boolean;
  abort?: (error: Error) => void;
  terminationPromise?: Promise<void>;
  removeMainListeners(): void;
}

export const defaultChildProcess: WindowsCuaChildProcessAdapter = {
  fork(command, argv, options) {
    const [entryPath, ...args] = argv;
    if (!entryPath) throw new Error("Windows Computer Use Helper entry path is required");
    return nodeFork(entryPath, args, { ...options, execPath: command });
  },
};

// socket 路径由 broker 统一铸造：命名管道路径含用户标识与随机段，宿主不得自行拼接，
// 否则不同账户/会话可能落到同一管道，造成跨权限边界的健康检查串号。
export const defaultSocketPathFactory = mintBrokerSocketPath;
export const defaultHealthProbe = (
  socketPath: string,
  timeoutMs: number,
): Promise<HelperHealth> => probeHelperHealth(socketPath, { timeoutMs });

export class WindowsCuaChildLifecycle {
  constructor(private readonly logger: ServiceLogger) {}

// [资源] 两阶段收敛：先 shutdown（快），再 kill（慢但强制）；两轮都先挂 listener 再发信号，
// 目的是让「进程恰好在信号下发瞬间退出」也能被观测到，而不是落入超时分支。
// 全程只操作传入的 generation，不读全局状态，保证并发恢复时代际之间互不干扰。
  async terminate(generation: Generation, context: string, timeoutMs: number): Promise<void> {
    if (generation.exitObserved) {
      generation.removeMainListeners();
      return;
    }
// [并发] 退出事件可能在下一条同步语句之前就触发，因此 wait 必须先注册。
// 这里用临时 exit listener 而非轮询 exitCode，避免两次采样之间错过退出的中间态。
    // 先挂 wait listener 再发送 shutdown/kill，避免进程在 signal 的同一同步轮次退出而漏观测。
// 第一轮只发 shutdown，给 Helper 清理命名管道与授权句柄的机会；超时后再进入 kill 分支。
// 返回值 false 表示超时而非失败，terminate 继续走强制路径。
    const firstExit = this.waitForExit(generation, "first-wait", timeoutMs);
    this.sendShutdown(generation, context);
    if (await firstExit) {
      generation.removeMainListeners();
      return;
    }
// 第二轮 kill 同样先挂 listener：kill 在 Windows 上是异步投递，进程退出可能在 await 前发生。
// [失败路径] 两轮都超时才抛 blocker，调用方据此判定「无法收敛」，而不是重试整条链。
    const secondExit = this.waitForExit(generation, "second-wait", timeoutMs);
    this.kill(generation, context);
    if (await secondExit) {
      generation.removeMainListeners();
      return;
    }
// [失败路径] 抛错而非返回：调用方必须知道旧 Helper 仍存活，否则会启动第二代并出现两个控制端。
// 错误只携带静态文案，不含 socket 路径，避免把敏感路径带进日志链路。
    const blocker = new Error(
      "Windows Computer Use Helper termination blocker: child did not exit after kill",
    );
    this.logFailure(generation.id, generation.child.pid, `${context}-termination-blocker`, blocker);
    throw blocker;
  }

  sendShutdown(generation: Generation, context: string): void {
    try {
      generation.child.send({ protocol: CONTROL_PROTOCOL, type: "shutdown" });
    } catch (error) {
      this.logFailure(generation.id, generation.child.pid, `${context}-send`, error);
    }
  }

  kill(generation: Generation, context: string): void {
    try {
      generation.child.kill();
    } catch (error) {
      this.logFailure(generation.id, generation.child.pid, `${context}-kill`, error);
    }
  }

  on(
    child: WindowsCuaChild,
    event: "message" | "error" | "exit",
    listener: (...args: unknown[]) => void,
    generation: number,
    errorClass: string,
  ): boolean {
    try {
// [失败路径] 注册 listener 失败不抛出：宿主启动流程要能继续记录并收敛，而不是半途崩溃。
// 返回 false 让调用方走 fail closed（放弃本次等待），与 on/off 的对称容错保持一致。
      child.on(event, listener);
      return true;
    } catch (error) {
      this.logFailure(generation, child.pid, errorClass, error);
      return false;
    }
  }

  off(
    child: WindowsCuaChild,
    event: "message" | "error" | "exit",
    listener: (...args: unknown[]) => void,
    generation: number,
    errorClass: string,
  ): void {
    try {
      child.off(event, listener);
    } catch (error) {
      this.logFailure(generation, child.pid, errorClass, error);
    }
  }

  logFailure(
    generation: number,
    pid: number | undefined,
    errorClass: string,
    error: unknown,
  ): void {
// 统一用 warn：生命周期失败可恢复（下次恢复会重新拉起），但必须留痕；
// 只记录 error 的类型名而非 message，避免把 Helper 输出里的用户路径带进日志。
    this.logger.warn(undefined, "Windows Computer Use Helper lifecycle failure", {
      generation,
      pid,
      errorClass,
      error: error instanceof Error ? error.name : typeof error,
    });
  }

// [并发] 单次等待：注册临时 exit listener + 超时定时器，两者谁先触发谁生效。
// done 标志让 finish 幂等，避免 exit 与 timeout 竞态时重复 resolve 或重复 removeListener。
// 超时返回 false 而非 reject：把「是否退出」与「是否出错」分开，由 terminate 决定如何升级。
  private waitForExit(
    generation: Generation,
    errorClass: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (generation.exitObserved) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off(generation.child, "exit", onExit, generation.id, `${errorClass}-off`);
        resolve(exited);
      };
// 只有真正的 exit 事件才写 exitObserved；这是全局唯一写入点，超时不能伪造退出事实。
// 该标记同时被 terminate 入口短路与 waitForExit 复用，故必须在这里而不是调用处更新。
      const onExit = () => {
        generation.exitObserved = true;
        finish(true);
      };
// timer.unref 让进程不会因为等待退出而被吊住：宿主退出时不该被 Helper 的清理阻塞。
// [资源] finish 里 clearTimeout，防止已完成的等待留下悬挂定时器并重复触发。
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      if (!this.on(generation.child, "exit", onExit, generation.id, `${errorClass}-on`))
        finish(false);
      // send() 后、临时 listener 注册前 child 可能已经触发主 exit listener；再次读取
      // generation 事实，避免把已退出 H1 错当成超时并留下不存在的 termination blocker。
// send 之后、临时 listener 注册之前，主 exit listener 可能已经更新了 generation.exitObserved。
// [并发] 再读一次事实，避免把已退出的 H1 误判成超时并抛出并不存在的 termination blocker。
      else if (generation.exitObserved) finish(true);
    });
  }
}

export type WindowsDevHelperControlMessage =
  | { protocol: typeof CONTROL_PROTOCOL; type: "transport_ready"; socketPath: string; pid: number }
  | { protocol: typeof CONTROL_PROTOCOL; type: "ready"; socketPath: string; pid: number }
  | { protocol: typeof CONTROL_PROTOCOL; type: "error"; message: string };

/**
 * Parse a `zcode-cua-windows-dev/v1` control message from the helper child.
 *
 * "transport_ready" means the named pipe is bound and authenticated, while
 * "ready" remains the full health handshake. "error" is the helper's OWN startup-failure
 * report (windowsDevHelperMain.ts sends `{protocol, type:"error", message}`
 * before exiting 1/2) — previously this fell through to null and the host
 * misclassified it as "Invalid Windows Computer Use Helper control message"
 * (malformed-message), discarding the diagnostic string.
 * Any future additive message type parses as "ignore" (forward-compatible)
 * instead of failing the generation.
 */
// 控制消息解析的唯一入口：区分 ready / transport_ready / error 三类，其余一律 ignore。
// 返回 null 表示「消息格式非法」，会让当前代际失败；返回 ignore 表示「合法但不相关」。
// [权衡] 这个区分必须严格：新增消息类型若被判成 null，旧宿主升级前会直接无法启动。
export function parseReadyMessage(
  message: unknown,
): WindowsDevHelperControlMessage | "ignore" | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
// 协议号不同即视为其他程序的消息，直接忽略；不能报错，否则同管道上的无关写入会杀掉 Helper。
  if (value.protocol !== CONTROL_PROTOCOL) return "ignore";
// [失败路径] Helper 自报启动失败时必须原样带回 message，否则宿主只能报 malformed-message，
// 丢掉最有诊断价值的原因（例如缺少原生模块、端口被占）。
  if (value.type === "error") {
    if (typeof value.message !== "string" || value.message.length === 0) {
      return null;
    }
    return { protocol: CONTROL_PROTOCOL, type: "error", message: value.message };
  }
// 未知 type 与协议号不匹配同属向前兼容：新 Helper 增加消息类型时，旧宿主应忽略而不是失败。
  if (value.type !== "ready" && value.type !== "transport_ready") return "ignore";
  if (
    typeof value.socketPath !== "string" ||
    !value.socketPath ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0
  )
    return null;
  return {
    protocol: CONTROL_PROTOCOL,
    type: value.type,
    socketPath: value.socketPath,
    pid: value.pid as number,
  };
}

// 健康检查里的 pid 必须与 child.pid 完全一致，才认作同一次握手；
// 只看 pid 存在会让「旧代际残留的健康响应」被误认成当代 Helper 已就绪。
export function isExactHealthPid(
  health: HelperHealth,
  childPid: number | undefined,
): health is HelperHealth & { pid: number } {
  return Number.isInteger(health.pid) && (health.pid as number) > 0 && health.pid === childPid;
}

// 把未知抛出值规整成 Error，保证上层 catch 时能拿到 message/stack；
// 非 Error 抛出（字符串、对象）若直接使用，日志里只会得到 [object Object]。
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
