// ============================================================
// 文件定位：exec adapter 的超时/输出预算常量与跨模块小工具集合。
// 输入输出：常量给出毫秒与字节口径的默认值；函数返回路径、布尔或“是否已结算”的布尔。
// 副作用：仅 resolveDefaultOutputRootDir 读 env；waitForPromise 挂一个已 unref 的计时器。
// 失败语义：非法数值一律回默认值，不抛出；等待超时返回 false，不 reject。
// 不变量：时间统一毫秒、容量统一字节；所有计时器 unref，不单独保活 CLI 进程。
// ============================================================
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequest } from "@zcode/contracts";

// 默认超时 5 分钟；内联输出 10MB、通用落盘 50MB；Bash 原始文件硬上限 5GB。
// IO 排空与强杀等待都有独立短超时，避免 kill 之后仍无限期挂在 pipe 上。
export const DEFAULT_TIMEOUT_MS = 300_000;
const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const DEFAULT_INLINE_OUTPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PERSISTED_OUTPUT_BYTES = 50 * 1024 * 1024;
export const BASH_RUNTIME_OUTPUT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
export const IO_DRAIN_TIMEOUT_MS = 1_000;
export const FORCE_EXIT_AFTER_KILL_MS = 5_000;
export const DEFAULT_PROGRESS_THRESHOLD_MS = 2_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
export const DEFAULT_PROGRESS_TAIL_BYTES = 4 * 1024;

// 解析落盘根目录：ZCODE_STORAGE_DIR 优先，否则 ~/.zcode，统一追加 cli/exec。
// 只算路径不建目录，真正写文件时由调用方 mkdir。
export function resolveDefaultOutputRootDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  const storageRoot = processEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
  return join(storageRoot, "cli", "exec");
}

// 子进程提前关闭 stdin 属于预期噪声（EPIPE/流已销毁），不能升级成命令失败。
export function isExpectedChildStdinClosureError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

// Bash 走“stdout/stderr 合并直写文件”，其余 execution 走内存 collector + pipe。
export function isBashMergedOutputRequest(request: ExecutionRequest): boolean {
  return request.command.mode === "shell" && request.command.shellProfile === "posix-bash";
}

// 会话 id / 工具调用 id 进文件名前消毒：仅保留 [A-Za-z0-9._-]，截 120 字符且保证非空。
export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

// 取 AbortSignal.reason 而不抛出；无 signal 或无 reason 字段时返回 undefined。
export function abortSignalReason(signal: AbortSignal | undefined): unknown {
  if (!signal || !("reason" in signal)) return undefined;
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

// 在 timeoutMs 内等待 promise 结算（成功/失败都算结算），返回是否已结算；超时返回 false。
// 计时器 unref，已完成的 promise 不会因等待器继续保活 CLI。
export function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    // losing timeout 不应在目标 Promise 已完成后继续单独保活 CLI。
    timer.unref?.();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

// 把毫秒格式化成 5s / 2m / 1.5h 等人类可读形式，用于超时错误文案；非法或负值按 0ms 处理。
export function formatTimeoutDuration(timeoutMs: number): string {
  if (!Number.isFinite(timeoutMs) || timeoutMs < MS_PER_SECOND) {
    return `${Math.max(0, Math.round(timeoutMs))}ms`;
  }

  if (timeoutMs < MS_PER_MINUTE) {
    return `${formatUnitValue(timeoutMs / MS_PER_SECOND)}s`;
  }

  if (timeoutMs < MS_PER_HOUR) {
    return `${formatUnitValue(timeoutMs / MS_PER_MINUTE)}m`;
  }

  return `${formatUnitValue(timeoutMs / MS_PER_HOUR)}h`;
}

function formatUnitValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/u, "");
}
