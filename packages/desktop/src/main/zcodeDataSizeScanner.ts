// INV-01 三个上限都来自请求：守住位置 选项接口；改错故障 调用方无法收紧扫描。
// INV-02 结果状态与部分原因互斥：守住位置 联合类型；改错故障 完整结果带残留原因。
// INV-03 终止信号必须转 AbortError：守住位置 ensureWithinLimits；改错故障 上层收到普通异常。
// INV-04 超时优先于文件上限：守住位置 先判时长再判文件数；改错故障 超时被记成文件上限。
// INV-05 首次目录缺失视为空目录完整：守住位置 首个 opendir 失败分支；改错故障 未初始化数据根被报错。
// INV-06 非首次目录错误计入 scanErrorCount：守住位置 捕获续扫；改错故障 单个坏目录中断整次扫描。
// INV-07 符号链接一律跳过：守住位置 isSymbolicLink；改错故障 循环或越界统计。
// INV-08 目录后进先出：守住位置 directories.pop；改错故障 扫描顺序不可预测。
// INV-09 文件上限只统计普通文件：守住位置 filesScanned 递增；改错故障 目录被计入文件数。
// INV-10 局部 lstat 失败标记 partial：守住位置 内层捕获；改错故障 把下界当完整值上报。
// INV-11 目录句柄必须关闭：守住位置 finally；改错故障 句柄泄漏。
// INV-12 关闭失败不覆盖主错误：守住位置 关闭的 catch；改错故障 真实原因被吞。
// INV-13 io_error 只在无更强原因时使用：守住位置 原因折叠；改错故障 超时被降级。
// INV-14 计时函数可注入：守住位置 now 选项；改错故障 时间上限无法单测。
// INV-15 耗时按单调时间差计算并夹到 0：守住位置 elapsed；改错故障 时钟回拨产生负数。
// INV-16 Worker 外调用不安全：守住位置 文档注释；改错故障 主线程被大目录阻塞。
// INV-17 结果守卫校验五个数值字段：守住位置 isZCodeDataSizeScanResult；改错故障 非法负载进入界面。
// INV-18 完整结果不得带 partialReason：守住位置 守卫分支；改错故障 状态与原因同时成立。
//
// 模块职责：在 Worker 中统计 ZCode 数据根的逻辑字节数并给出完整或部分结果。
// 状态所有权：无长期状态；scanZCodeDataDirectory 的计数与终止原因都在单次调用闭包内。
// 阅读顺序：先看类型与选项，再读扫描主循环，最后看结果守卫。
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";

export type ZCodeDataSizePartialReason = "file_limit" | "io_error" | "time_limit";

export type ZCodeDataSizeScanResult = {
  bytes: number;
  directoriesScanned: number;
  durationMs: number;
  filesScanned: number;
  scanErrorCount: number;
} & (
  | { status: "complete"; partialReason?: never }
  | { status: "partial"; partialReason: ZCodeDataSizePartialReason }
);

export interface ZCodeDataSizeScanRequest {
  rootPath: string;
  maxDurationMs: number;
  maxFiles: number;
}

export interface ZCodeDataSizeScanOptions extends ZCodeDataSizeScanRequest {
  signal?: AbortSignal;
  /** 仅用于定向测试时间上限，不进入 Worker 消息。 */
  now?: () => number;
}

function createAbortError(): DOMException {
  return new DOMException("ZCode data size scan aborted", "AbortError");
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * 异步统计数据根下普通文件的逻辑字节数。调用方必须把它放在 Worker 中执行；这里不跟随
 * 符号链接，避免循环或越出用户选择的数据根。
 */
// 根目录作为唯一初始工作项，所有累计值在 scanZCodeDataDirectory 的闭包内推进；终止原因只记录非 io 类别；时长与文件数在上限内均放宽；返回值始终包含五项计数。
export async function scanZCodeDataDirectory(
  options: ZCodeDataSizeScanOptions,
): Promise<ZCodeDataSizeScanResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const directories = [options.rootPath];
  let bytes = 0;
  let directoriesScanned = 0;
  let filesScanned = 0;
  let scanErrorCount = 0;
  let terminalPartialReason: Exclude<ZCodeDataSizePartialReason, "io_error"> | null = null;

  const elapsed = () => Math.max(0, now() - startedAt);
  // 已中止时立即抛出。
  // 到达 maxDurationMs 上限记为超时。
  // 超时返回 false 让调用方退出。
  // 返回 true 表示可以继续。
  // ensureWithinLimits 在每次取值前调用。
  const ensureWithinLimits = (): boolean => {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
    if (elapsed() >= Math.max(0, options.maxDurationMs)) {
      terminalPartialReason = "time_limit";
      return false;
    }
    return true;
  };

  if (!ensureWithinLimits()) {
    return {
      bytes,
      directoriesScanned,
      durationMs: elapsed(),
      filesScanned,
      partialReason: "time_limit",
      scanErrorCount,
      status: "partial",
    };
  }

  // 终止原因一旦写入即停止外层循环；每轮先复查时长；出栈目录为空时跳过；打开失败按首目录与后续目录分别处理；遍历条目时再次复查上限。
  while (directories.length > 0 && terminalPartialReason == null) {
    if (!ensureWithinLimits()) {
      break;
    }
    const directoryPath = directories.pop();
    if (!directoryPath) {
      continue;
    }

    let directory;
    try {
      directory = await opendir(directoryPath);
      directoriesScanned += 1;
    } catch (error) {
      if (directoriesScanned === 0 && isMissingPathError(error)) {
        return {
          bytes: 0,
          directoriesScanned: 0,
          durationMs: elapsed(),
          filesScanned: 0,
          scanErrorCount: 0,
          status: "complete",
        };
      }
      scanErrorCount += 1;
      continue;
    }

    try {
      for await (const entry of directory) {
        if (!ensureWithinLimits()) {
          break;
        }
        if (filesScanned >= Math.max(0, options.maxFiles)) {
          terminalPartialReason = "file_limit";
          break;
        }

        const entryPath = join(directoryPath, entry.name);
        try {
          const metadata = await lstat(entryPath);
          if (metadata.isSymbolicLink()) {
            continue;
          }
          if (metadata.isDirectory()) {
            directories.push(entryPath);
            continue;
          }
          if (metadata.isFile()) {
            bytes += metadata.size;
            filesScanned += 1;
          }
        } catch {
          // 目录扫描期间文件可能被 Agent/日志轮转删除；局部错误不能让整次低频
          // 遥测失败，但必须标记 partial，避免把下界误当完整值。
          scanErrorCount += 1;
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }

  const durationMs = elapsed();
  // partialReason 必须先取文件或时间上限，没有更强原因才回落到 io 错误；两个原因都为空时结果为完整；部分结果保留已统计的下界。
  const partialReason = terminalPartialReason ?? (scanErrorCount > 0 ? "io_error" : null);
  if (partialReason) {
    return {
      bytes,
      directoriesScanned,
      durationMs,
      filesScanned,
      partialReason,
      scanErrorCount,
      status: "partial",
    };
  }
  return {
    bytes,
    directoriesScanned,
    durationMs,
    filesScanned,
    scanErrorCount,
    status: "complete",
  };
}

// 非对象直接拒绝；五个计数字段必须是非负有限数；完整状态不允许出现部分原因；部分状态的原因必须是 ZCodeDataSizePartialReason 三个枚举之一。
export function isZCodeDataSizeScanResult(value: unknown): value is ZCodeDataSizeScanResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ZCodeDataSizeScanResult>;
  const finiteNumbers = [
    candidate.bytes,
    candidate.directoriesScanned,
    candidate.durationMs,
    candidate.filesScanned,
    candidate.scanErrorCount,
  ].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
  if (!finiteNumbers) {
    return false;
  }
  if (candidate.status === "complete") {
    return candidate.partialReason === undefined;
  }
  return (
    candidate.status === "partial" &&
    ["file_limit", "io_error", "time_limit"].includes(candidate.partialReason ?? "")
  );
}
