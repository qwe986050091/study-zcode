/**
 * ============================================================================
 * logging/retention.ts —— 日志保留期清理
 * ============================================================================
 *
 * 【定位】按文件名中的本地日期（zcode-YYYY-MM-DD.jsonl）删除超过保留期的
 * 日志；非本格式文件一律不动，避免误删用户文件。
 *
 * 【口径】保留期按"自然日"计：retentionDays=7 表示保留今天在内最近 7 个
 * 日期，cutoff 为 today-6。最小值 1，非法值回退默认 7。
 *
 * 【失败语义】目录不存在视为成功（无可清理）；单文件删除失败只记录
 * failedFiles 并把 status 置 failed，不中断其余文件；不抛错。
 *
 * 【副作用】unlink 文件；启动清理用 unref 定时器，不阻止进程退出。
 * ============================================================================
 */
import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";

/** 默认保留 7 个自然日（含当天）。 */
export const LOG_RETENTION_DAYS = 7;
/** 启动后延迟 60 秒清理，避开 CLI 启动关键路径。 */
export const LOG_CLEANUP_STARTUP_DELAY_MS = 60_000;

const LOG_FILE_NAME_PATTERN = /^zcode-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const MIN_RETENTION_DAYS = 1;

export interface LogRetentionCleanupOptions {
  logDir: string;
  logger?: Logger;
  now?: Date;
  retentionDays?: number;
}

export interface LogRetentionCleanupResult {
  /** 早于该本地日期的日志会被删除。 */
  cutoffDate: string;
  /** 成功 unlink 的文件名（不含目录）。 */
  deletedFiles: string[];
  /** 删除失败且原因不是 ENOENT 的文件名。 */
  failedFiles: string[];
  /** 实际生效的保留天数（已归一化）。 */
  retentionDays: number;
  /** 匹配日志命名规则、实际参与判断的文件数。 */
  scannedFiles: number;
  /** 任一删除失败即为 failed；目录不存在仍算 completed。 */
  status: "completed" | "failed";
}

export interface LogRetentionTimer {
  unref?(): void;
}

export interface LogRetentionScheduleOptions extends Omit<LogRetentionCleanupOptions, "now"> {
  delayMs?: number;
  now?: () => Date;
  setTimeout?: (callback: () => void, delayMs: number) => LogRetentionTimer;
}

/**
 * 执行一次保留期清理。
 *
 * 扫描 logDir 下符合 `zcode-YYYY-MM-DD.jsonl` 的文件，删除日期早于 cutoff 的；
 * 只处理普通文件，目录/其他命名一律跳过。返回值是统计结果而非异常，便于
 * 调用方在启动路径里 fire-and-forget。
 */
export async function cleanupLogRetention(
  options: LogRetentionCleanupOptions,
): Promise<LogRetentionCleanupResult> {
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  const cutoffDate = getCutoffDate(options.now ?? new Date(), retentionDays);
  const result: LogRetentionCleanupResult = {
    cutoffDate,
    deletedFiles: [],
    failedFiles: [],
    retentionDays,
    scannedFiles: 0,
    status: "completed",
  };

  let entries: Dirent[];
  try {
    entries = await readdir(options.logDir, { withFileTypes: true });
  } catch (error) {
    // 日志目录尚未创建（首次运行/已关闭日志）是正常状态，不视为失败。
    if (hasFileSystemCode(error, "ENOENT")) {
      return result;
    }
    result.status = "failed";
    warnCleanupFailed(options, result, error);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const logDate = parseLogFileDate(entry.name);
    if (!logDate) continue;

    result.scannedFiles += 1;
    // 等于 cutoff 的当天仍在保留窗口内，只有严格早于才删除。
    if (logDate >= cutoffDate) continue;

    try {
      await unlink(join(options.logDir, entry.name));
      result.deletedFiles.push(entry.name);
    } catch (error) {
      // 并发清理/用户手动删除导致的 ENOENT 等价于"已达成目标"，不计失败。
      if (hasFileSystemCode(error, "ENOENT")) continue;
      result.failedFiles.push(entry.name);
      result.status = "failed";
      warnDeleteFailed(options, result, entry.name, error);
    }
  }

  options.logger?.debug("Log retention cleanup completed", {
    cutoffDate,
    deletedFileCount: result.deletedFiles.length,
    event: "log.retention.cleanup.completed",
    failedFileCount: result.failedFiles.length,
    logDir: options.logDir,
    module: "adapters.logging",
    retentionDays,
    scannedFiles: result.scannedFiles,
    status: result.status,
  });
  return result;
}

/**
 * 延迟调度一次清理。
 *
 * 默认 60 秒后执行；timer.unref() 保证不拖住进程退出。调用方可通过注入
 * setTimeout/now 在测试中控制时间，不产生真实等待。
 */
export function scheduleLogRetentionCleanup(
  options: LogRetentionScheduleOptions,
): LogRetentionTimer {
  const delayMs = options.delayMs ?? LOG_CLEANUP_STARTUP_DELAY_MS;
  const retentionDays = normalizeRetentionDays(options.retentionDays);
  options.logger?.info("Log retention cleanup scheduled", {
    delayMs,
    event: "log.retention.cleanup.scheduled",
    logDir: options.logDir,
    module: "adapters.logging",
    retentionDays,
    status: "waiting",
  });
  const scheduleTimer =
    options.setTimeout ?? ((callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs));
  const timer = scheduleTimer(() => {
    void cleanupLogRetention({
      logDir: options.logDir,
      logger: options.logger,
      now: options.now?.() ?? new Date(),
      retentionDays,
    });
  }, delayMs);
  timer.unref?.();
  return timer;
}

/**
 * 本地日期格式化（YYYY-MM-DD）。
 *
 * 使用本地时区而非 UTC：日志文件名与用户看到的"今天"一致，避免跨时区
 * 边界处删错日期。
 */
export function formatLocalLogDate(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function getCutoffDate(now: Date, retentionDays: number): string {
  // 保留 N 天 = 含今天在内 N 个自然日，所以回退 N-1 天作为 cutoff。
  return formatLocalLogDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - retentionDays + 1),
  );
}

function normalizeRetentionDays(retentionDays: number | undefined): number {
  if (retentionDays === undefined || !Number.isFinite(retentionDays)) return LOG_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.trunc(retentionDays));
}

function parseLogFileDate(fileName: string): string | undefined {
  const match = LOG_FILE_NAME_PATTERN.exec(fileName);
  if (!match) return undefined;

  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  // 回写格式化再比对，过滤 2026-02-31 这类"看起来合法但溢出到下个月"的日期。
  const formatted = formatLocalLogDate(parsed);
  return formatted === `${year}-${month}-${day}` ? formatted : undefined;
}

function warnCleanupFailed(
  options: LogRetentionCleanupOptions,
  result: LogRetentionCleanupResult,
  error: unknown,
): void {
  options.logger?.warn("Log retention cleanup failed", {
    cutoffDate: result.cutoffDate,
    error: summarizeError(error),
    event: "log.retention.cleanup.failed",
    logDir: options.logDir,
    module: "adapters.logging",
    retentionDays: result.retentionDays,
    status: "failed",
  });
}

function warnDeleteFailed(
  options: LogRetentionCleanupOptions,
  result: LogRetentionCleanupResult,
  fileName: string,
  error: unknown,
): void {
  options.logger?.warn("Log retention file delete failed", {
    cutoffDate: result.cutoffDate,
    error: summarizeError(error),
    event: "log.retention.delete.failed",
    fileName,
    logDir: options.logDir,
    module: "adapters.logging",
    retentionDays: result.retentionDays,
    status: "failed",
  });
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      code,
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
    name: "UnknownError",
  };
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
