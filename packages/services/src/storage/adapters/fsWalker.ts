/**
 * 数据根遍历器：异步、有界并发、可取消、不跟随符号链接。
 * 产出 (relativePath, bytes, mtimeMs)，分类与聚合由 domain 在调用方完成。
 * 每处理 yieldEvery 个条目让出一次事件循环，避免在 Worker/host 内长时间独占。
 */
import { lstat, opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { StorageScanEntry } from "../domain/usageAggregate.js";
import type { StoragePathError } from "@zcode/shared";

export interface WalkStorageRootOptions {
  rootPath: string;
  onEntry: (entry: StorageScanEntry) => void;
  onError?: (error: StoragePathError) => void;
  signal?: AbortSignal;
  /** 同时打开的目录数，默认 4。 */
  concurrency?: number;
  /** 每处理多少条目让出一次事件循环，默认 256。 */
  yieldEvery?: number;
}

export interface WalkStorageRootResult {
  directoriesScanned: number;
  filesScanned: number;
  /** 根目录本身不存在时为 true（视为空根，不算错误）。 */
  missingRoot: boolean;
}

export function createStorageAbortError(): Error {
  return new DOMException("storage scan aborted", "AbortError");
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function toRelative(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

// 遍历算法说明：显式维护待扫描目录队列而非递归，
// 这样能在不加深调用栈的前提下实现有界并发（默认同时打开 4 个目录），
// 避免深目录树在 Worker 内耗尽文件描述符。
// 队列按 LIFO（pop）消费，目录内条目依底层 opendir 的返回顺序入队，
// 因此产出顺序不稳定；需要确定性顺序的调用方应自行排序。
// onEntry / onError 在遍历过程中同步触发，可能多次调用且顺序不定，
// 遍历只负责列举与错误归类，不做去重、分类或持久化。
export async function walkStorageRoot(
  options: WalkStorageRootOptions,
): Promise<WalkStorageRootResult> {
  const { rootPath, onEntry, onError, signal } = options;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const yieldEvery = Math.max(1, options.yieldEvery ?? 256);
  const pending: string[] = [rootPath];
  const result: WalkStorageRootResult = {
    directoriesScanned: 0,
    filesScanned: 0,
    missingRoot: false,
  };
  let processedSinceYield = 0;
  let active = 0;

  // 取消是协作式的：每个目录打开前、每个 dirent 处理前各检查一次，
  // 不保证毫秒级中断，最坏会多处理一个条目后才抛出。
  // 抛 DOMException(name=AbortError) 以便调用方与真实 IO 错误区分。
  const throwIfAborted = () => {
    if (signal?.aborted) throw createStorageAbortError();
  };
  // 让出事件循环按「已处理条目数」计数，而非按耗时判断，
  // 使快盘与慢盘上的行为都可比、可预期。
  // 达到阈值时用 setImmediate 只让出一次宏任务，不引入定时器额外延迟；
  // 让出后立刻复查取消状态，保证中断仍能及时生效。
  const maybeYield = async () => {
    processedSinceYield += 1;
    if (processedSinceYield >= yieldEvery) {
      processedSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted();
    }
  };

  // 单目录失败不中断整棵树：只有根目录 ENOENT 被识别为 missingRoot，
  // 其余打开错误（EACCES、ENOTDIR、EMFILE 等）经 onError 归类后跳过该子树，
  // 保证剩余目录仍可被扫描；结果完整性由调用方结合 onError 自行判断。
  // 目录句柄在 finally 中关闭，即使回调抛错或遍历提前失败也不会泄漏 fd。
  // 本函数自身只在取消或回调抛错时抛出，IO 错误均已转为 onError 回调。
  const scanDirectory = async (directoryPath: string): Promise<void> => {
    throwIfAborted();
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      if (directoryPath === rootPath && errorCode(error) === "ENOENT") {
        result.missingRoot = true;
        return;
      }
      onError?.({ path: toRelative(rootPath, directoryPath), code: errorCode(error) });
      return;
    }
    result.directoriesScanned += 1;
    try {
      for await (const dirent of directory) {
        throwIfAborted();
        const entryPath = join(directoryPath, dirent.name);
        // 显式跳过符号链接：既避免链接环导致无限遍历，也避免跟随链接把根目录
        // 之外（挂载点、其他盘符）的内容纳入统计口径。
        // dirent 的类型来自 lstat 语义，链接既不算目录也不算普通文件。
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!dirent.isFile()) continue;
        try {
          // dirent 与实际读取之间存在竞态，再用 lstat 确认最终类型：
          // 条目可能已被替换为目录或链接，只有仍是普通文件才计入 filesScanned，
          // 保证 bytes 与 mtimeMs 取自同一份元数据快照。
          const stats = await lstat(entryPath);
          if (!stats.isFile()) continue;
          result.filesScanned += 1;
          onEntry({
            relativePath: toRelative(rootPath, entryPath),
            bytes: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        } catch (error) {
          // 扫描期间文件可能被日志轮转或 Agent 删除；ENOENT 属于正常竞态，不计为错误。
          if (errorCode(error) !== "ENOENT") {
            onError?.({ path: toRelative(rootPath, entryPath), code: errorCode(error) });
          }
        }
        await maybeYield();
      }
    } finally {
      await directory.close().catch(() => {});
    }
  };

  // 有界并发：最多 concurrency 个目录同时打开；队列为空且无活动任务时结束。
  // pump 以「队列为空且无在途任务」作为完成条件，每完成一个目录再 pump 一次，
  // 形成自驱动调度循环，无需轮询或额外等待。
  // 任一任务以非预期错误 reject 时置 failed，阻止后续 pump 继续入队。
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (pending.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && pending.length > 0) {
        const next = pending.pop()!;
        active += 1;
        scanDirectory(next)
          .then(() => {
            active -= 1;
            pump();
          })
          .catch((error: unknown) => {
            failed = true;
            reject(error);
          });
      }
    };
    pump();
  });
  return result;
}
