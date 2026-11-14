// 原子写工具：先写同目录临时文件，再用 rename 替换目标，配合跨进程 lock 文件串行化读改写。
// INV-01：tempFile 必须与 filePath 同目录，否则 rename 跨卷会退化成「复制 + 删除」，原子性丢失。
// INV-02：任何失败路径都必须删掉本次 tempFile，否则残留 .tmp 会让下次清理误判成他人正在写的文件。
// INV-03：lock 覆盖「清理陈旧 tmp → 写 tmp → rename」整段窗口，且只能由 finally 释放。
// INV-04：只对 EPERM/EBUSY/EACCES 做有限重试，真实权限错误必须原样抛出。
// 破坏任一条：读者可能读到半份 JSON，或两个进程同时替换同一文件互相覆盖。
import { mkdir, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

// 指数退避合计约 6.3s：够跨过一次杀软/索引器的短暂占用，又不至于把保存拖到界面超时。
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
// 60s 的陈旧阈值必须大于一次最长写窗口（等锁 8s + 退避 6.3s），否则会删掉别人正在写的 tmp。
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

export interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

// 供 read-modify-write 调用方使用的锁包装：临界区内必须完成「读旧值 → 合并 → 原子写」，
// 若在临界区里又调用了默认加锁的 atomicWriteText，同进程会自等直至超时。
export async function withAtomicFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
  options?: Pick<
    AtomicWriteTextOptions,
    "lockRetryDelaysMs" | "lockOwnerlessGraceMs" | "lockMaxWaitMs"
  >,
): Promise<T> {
  const releaseLock = await acquireFileLock(
    filePath,
    options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
    options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
    options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
  );
  try {
// [资源] task 抛错也必须释放锁：任何提前 return 都不能跳过 finally。
    return await task();
  } finally {
    await releaseLock();
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// [权衡] 这三个码在 Windows 上既可能是临时占用，也可能是真实 ACL 拒绝；用有限重试加原样抛出区分二者，
// 比无条件重试更快把权限故障暴露给调用方。
function isRetryableAtomicRenameError(error: unknown): boolean {
// [失败路径] 注入的故障代表「永不恢复」，重试会把它吞掉，必须立刻上抛。
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

// 重试次数由 delays 数组长度决定，数组耗尽即放弃：重试只用于等占用解除，不能用于绕过权限。
async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

// [并发] 退避期间不持有锁以外的状态，依赖 tempFile 仍在原处（失败才删，见 INV-02）。
      await sleep(retryDelayMs);
    }
  }
}

// 清理范围严格限定为「同目录 + 同目标 basename + .tmp 后缀」：宁可漏删，也不能删到别的目标文件。
async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
// [失败路径] readdir 失败（目录被删或无权限）直接放弃清理：清理是尽力而为，不能让主写入失败。
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
// [并发] 排除本次新建的 tempFile：两次写并发时，另一方的 tmp 可能已被误判为陈旧。
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
// [并发] 用 mtime 判断写入是否已结束，而不是目录项时间：rename 完成后 mtime 才停止变化。
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
// [失败路径] force 让「已被别的进程删除」不算错误；仍可能因占用抛错，由外层 catch 吞掉。
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * 使用临时文件 + rename 实现原子写入。
 * rename 在同文件系统上是原子的，避免读者看到半份内容；read-modify-write 需由调用方
 * 用 withAtomicFileLock 包住读取、合并及写入，并给内部原子写传 useFileLock: false。
 * 临时文件写在目标文件同目录下，避免 Windows 跨卷 rename 失败。
 */
// [事务] 对外可见的提交点只有 rename 这一条指令：它之前崩溃读者仍是旧内容，之后才是新内容。
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
// INV-01 落地：temp 与目标同目录，rename 才不会跨卷降级为复制。
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
// mkdir 必须先于加锁：锁文件所在目录不存在时，acquireFileLock 自身会失败。
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // Windows 上多个窗口/host process 可能同时保存同一个 task JSON，
  // 进程内 writeChains 无法覆盖这种抢写，最终在 rename 替换目标文件时高频 EPERM。
  // 这里用同目录 lock 文件做 ZCode 进程间协作串行化，再保留 rename 重试处理杀软/索引器的短暂占用。
// [并发] 可关闭：调用方已持有 withAtomicFileLock 时必须传 false，否则同进程二次加锁会自等。
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // 旧版本或崩溃后的失败 rename 会留下 config.json.*.tmp。
    // 只清理同一目标文件且超过阈值的临时文件，避免误删另一个进程刚创建的 active temp。
// [资源] 清理要在写新 temp 之前：先写再扫会把本次 temp 纳入范围，只能靠 excludeTempFile 兜底。
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
// [事务] 这里故意不 fsync：崩溃可能留下长度正确但内容未落盘的 tmp，但 rename 尚未执行，
// 目标文件不受影响；用这点风险换掉每次保存的 fsync 延迟。
    await writeFile(tempFile, content, "utf-8");
// beforeRename 让调用方在「内容已落盘、尚未替换」之间做校验或埋点；它抛错会走 catch 删掉 temp。
    await options?.beforeRename?.();
    // Windows Defender、索引服务或另一个窗口可能短暂占用目标 JSON，
    // 导致原子替换 rename 抛 EPERM/EBUSY/EACCES。这里只对这类临时锁做短暂重试，
    // 仍然把真实权限问题原样抛出，避免静默丢失会话快照。
// [权衡] 把 rename 包成可注入的 runRename：测试才能在「写入成功但替换失败」的窗口断言 INV-02 的清理行为。
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
// [失败路径] 失败即删 temp：残留会让下次清理看到「mtime 很新」的孤儿，磁盘占用也随失败次数增长。
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
// [资源] 先删 temp 再放锁：反序会让下一个持锁者扫描到本进程尚未删除的 tmp。
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}
