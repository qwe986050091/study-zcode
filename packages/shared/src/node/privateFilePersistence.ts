// INV-01 进程内先 FIFO 再抢 OS 锁：守住位置 withFileLock 的 tails 链；改错故障 同进程惊群导致后排假超时。
// INV-02 队列节点必须释放：守住位置 finally 的 releaseProcessQueue；改错故障 后续同文件调用永久挂起。
// INV-03 尾部登记按值比对再删除：守住位置 currentTail 相等判断；改错故障 新排队者被旧清理逻辑摘掉。
// INV-04 取锁失败也要走 finally：守住位置 releaseLock?.()；改错故障 异常路径把队列卡死。
// INV-05 目录必须先建：守住位置 mkdir recursive；改错故障 首次写入因父目录缺失失败。
// INV-06 临时文件名含 pid/时间/随机数：守住位置 tempPath 拼接；改错故障 并发写撞同名临时文件。
// INV-07 临时文件权限 0600：守住位置 writeFile 的 mode；改错故障 凭据文件对同机其他用户可读。
// INV-08 写完必须 rename 原子替换：守住位置 renameWithRetry；改错故障 读者可能看到半截内容。
// INV-09 rename 只重试三类错误：守住位置 isRetryableRenameError；改错故障 永久错误被拖到超时。
// INV-10 失败必须清理临时文件：守住位置 catch 的 rm force；改错故障 磁盘堆积 .tmp。
// INV-11 清理失败不掩盖原始错误：守住位置 rm 的吞错回调；改错故障 用户看到 ENOENT 而非真实原因。
// INV-12 损坏备份名按内容哈希确定：守住位置 sha256 前缀；改错故障 每次重试都新建一份备份。
// INV-13 备份用 wx 排他创建：守住位置 flag: "wx"；改错故障 覆盖已有证据文件。
// INV-14 EEXIST 视为成功：守住位置 getErrorCode 判定；改错故障 并发备份互相报错。
// INV-15 备份最终强制 0600：守住位置 chmod；改错故障 继承历史宽松权限。
//
// 模块职责：私有文本文件的原子写入、跨进程锁排队与损坏文件证据备份。
// 阅读顺序：先看锁队列与释放，再看临时文件写入与 rename 重试，最后看损坏备份。
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "./atomicFileLock.js";

// 退避序列总时长远小于 maxWait，保证重试次数内能给出明确结果。
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
// 键是文件路径，值是该路径当前队尾的完成信号。
const processFileLockTails = new Map<string, Promise<void>>();

export interface SharedFileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// Windows 上杀软或索引器短暂占用会报这三类，其余错误立即上抛。
function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

// attempt 递增读取延迟表，越界即放弃，避免无限重试。
// sleep 在重试之间让出事件循环，不阻塞其他文件的写入。
async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

// 前一个队尾完成才继续，保证同进程对同一文件严格串行。
// 释放顺序固定：先还 OS 锁再放队列，反过来会让下一个抢锁者空转。
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: SharedFileLockOptions = {},
): Promise<T> {
  // 同一进程几十个 caller 同时轮询目录锁会形成惊群，后排请求可能在
  // 很短的实际写入之后仍撞上 8 秒超时。先做进程内 FIFO，每个进程只让队首竞争 OS 锁。
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      filePath,
      options.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
      options.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
      options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

// 临时文件与目标同目录，保证 rename 不跨设备。
// 错误分支里先清临时文件再抛出，调用方只需处理一个错误。
export async function atomicWritePrivateTextFile(
  filePath: string,
  content: string,
  renameRetryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath, renameRetryDelaysMs);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// 读取原始字节做哈希，避免先解码再编码造成证据偏差。
// 截断到 24 位十六进制足够区分，又不至于让文件名过长。
// chmod 放在写之后执行，覆盖潜在的历史权限。
export async function backupCorruptFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const contentId = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const backupPath = `${filePath}.corrupt-${contentId}.bak`;
  try {
    // 同一损坏凭据会被 Desktop、CLI 和重试循环反复读取。按内容确定备份名并
    // 排他创建，让失败路径稳定收敛到一份证据，同时避免 copyFile 继承历史宽松权限。
    await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
}
