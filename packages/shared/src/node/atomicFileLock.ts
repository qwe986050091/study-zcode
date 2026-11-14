// INV-01 锁目录即互斥凭证：mkdir 原子成功者独占，守住位置 acquireFileLock 的创建调用；改错故障：改成先查后建，两个进程同时看到不存在并各自写入，互斥失效。
// INV-02 owner 文件名携带随机 token：由 pid、时间与随机串拼成，守住位置 owner 路径构造处；改错故障：token 可预测会让旧锁释放误删新 owner 的文件。
// INV-03 获取后校验目录身份：设备号、inode 与唯一 owner 名都要与创建时一致，守住位置 创建后的三项校验；改错故障：跳过校验后，抢到被别人替换的目录仍自认持锁。
// INV-04 释放只删自己的 owner 文件：按 token 精确删除再尝试移除空目录，守住位置 返回的释放闭包；改错故障：递归删目录会连带删掉接管者的锁，造成双持有。
// INV-05 自身等待时长不能证明锁陈旧：只回收 owner 已退出或无主超 grace 的锁，守住位置 重试分支与回收判定；改错故障：按等待时间判定会误删后来 writer 的新锁。
// INV-06 超时后不再尝试回收：达到上限直接抛错，守住位置 已等待时长的判断分支；改错故障：先回收再超时会让超时 waiter 越界删除他人锁。
// INV-07 无主宽限有上界：不超过最长等待的一半，守住位置 宽限值的计算；改错故障：宽限大于等待上限时，进程永远等不到回收时机而全部超时。
// INV-08 元数据时间戳逐个校验：有限、非负且不超出时钟偏移上界，守住位置 时间戳解析函数；改错故障：未来时间戳让锁永久达不到陈旧条件，目录泄漏。
// INV-09 PID 只接受正安全整数：只有内核认可的进程号才具备 owner 语义，守住位置 元数据解析的 pid 分支；改错故障：零或小数传入探活会被误判为存活，损坏锁无法回收。
// INV-10 元数据损坏时回退文件 mtime：解析失败不抛错，守住位置 解析函数的兜底分支；改错故障：直接抛错会让一次截断写导致后续全部获取失败。
// INV-11 目录与单文件两种形态都要兼容：目录是当前格式，单文件是升级前遗留，守住位置 回收函数的分支；改错故障：只处理目录会让老锁永久阻塞升级后的进程。
// INV-12 多 owner 目录必须全部可回收才删：任一 owner 存活即放弃，守住位置 owner 循环；改错故障：只检查第一个会删掉仍被活进程持有的目录。
// INV-13 删除单文件锁前做内容比对：两次读取一致才删，守住位置 单文件分支；改错故障：不加比对会删掉刚被其他进程重写的锁。
// INV-14 失败只归为可重试与终态两类：不存在与非空视为竞争，其余记错误，守住位置 异常分支；改错故障：把权限错误当竞争会无限重试到超时，掩盖真实故障。
// INV-15 权限错误优先原样抛出：不包装成超时，守住位置 超时与重试前的错误码判断；改错故障：包装后运维只看到超时，无法定位目录权限问题。
// INV-16 超时错误带结构化字段：错误码、路径与系统调用齐备，守住位置 超时错误构造处；改错故障：只给文案会让上层无法按错误码分支处理。
// INV-17 创建成功后中途失败要自清理：用标记触发回滚，守住位置 异常处理头部；改错故障：残留半初始化的锁目录会让后续所有获取等满超时。
// INV-18 重试退避有上限且不超过剩余时间：守住位置 休眠前的时长计算；改错故障：退避超过剩余预算会让实际等待远超调用方约定。
//
// 模块职责：提供基于目录创建的跨进程文件锁，包含获取、陈旧锁回收与结构化超时错误。
// 状态所有权：锁状态完全由文件系统持有；进程内只有本次获取的 token、owner 路径与重试计数。
// 阅读顺序：先看时间戳与探活工具，再看回收判定，最后看获取主循环与释放闭包。
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "../errors.js";
import { mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLockInstanceObserver, type ObserveLockInstance } from "./lockInstanceObserver.js";

// 允许的时钟偏移上界：超过这个值的未来时间戳一律判为非法元数据
// [失败路径] 不设上界时，一次错误的系统时间会让锁永久无法回收
// 取五分钟是为了容忍时间同步校正与容器漂移，又不至于长期误判
// 该常量同时约束创建时间与文件修改时间两条取证路径
// [权衡] 上界越大越安全，但损坏锁被清理的延迟也越长
const MAX_LOCK_METADATA_CLOCK_SKEW_MS = 5 * 60_000;

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isFileExistsError(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

interface FileLockMetadata {
  createdAt: number | null;
  pid: number | null;
}

// 时间戳只接受有限、非负且不超过观测时刻加偏移的值
// [失败路径] 放行未来时间会让无主锁的存活计算恒为负数，永远达不到宽限
// 非法值统一返回空，由调用方决定回退修改时间还是实例观察
// 观测时刻只取一次，避免同一次判定内使用两个不同基准
// [权衡] 严格校验会丢弃部分可救的损坏时间，但换来可预测的回收行为
function parseLockTimestamp(value: unknown, observedAt: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= observedAt + MAX_LOCK_METADATA_CLOCK_SKEW_MS
    ? value
    : null;
}

function parseLockMetadata(raw: string, observedAt: number): FileLockMetadata {
  try {
    const parsed = JSON.parse(raw) as { createdAt?: unknown; pid?: unknown };
    return {
      // 非有限、负数或明显未来的 createdAt 会让 ownerless 锁永久达不到 stale。
      // 元数据非法时交给调用方回退到同样受校验的文件 mtime。
      createdAt: parseLockTimestamp(parsed.createdAt, observedAt),
      // 0、负数、小数或非有限 PID 传给 process.kill 后可能被误判为活进程，
      // 导致损坏锁永久无法回收。只有操作系统可用的正安全整数才具有 owner 语义。
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

// 用信号零探活：不投递信号，只让内核做存在性与权限检查
// [失败路径] 进程不存在与权限不足必须区分，后者应视为存活
// 把权限错误当死亡会误删其他用户持有的锁，导致两个进程同时写
// 本函数只回答存活问题，不判断锁是否应当被回收
// 探活结果与元数据中的进程号合法性共同决定回收条件
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== "ESRCH";
  }
}

interface LockRemovalAttempt {
  removed: boolean;
  error?: unknown;
}

// 判断单个 owner 是否可回收：owner 已退出，或无进程号且超过宽限
// [并发] 读取与判定之间锁可能被替换，因此后续删除还要按 token 精确命中
// 创建时间缺失时依次回退修改时间与实例观察，保证总有可用基准
// [失败路径] 把「无进程号」直接判为可回收，会让刚创建尚未写 owner 的锁被误删
// 该判定只读，不做任何删除，便于在多点复用时保持语义一致
async function isOwnerFileReclaimable(
  ownerFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<boolean> {
  const observedAt = Date.now();
  const raw = await readFile(ownerFile, "utf-8");
  const metadata = parseLockMetadata(raw, observedAt);
  let createdAt = metadata.createdAt;
  if (createdAt === null) {
    const ownerStat = await stat(ownerFile);
    createdAt =
      parseLockTimestamp(ownerStat.mtimeMs, observedAt) ??
      observeLockInstance(ownerFile, ownerStat, observedAt);
  }
  const ownerExited = metadata.pid !== null && !isProcessAlive(metadata.pid);
  const ownerlessLockIsStale = metadata.pid === null && observedAt - createdAt >= ownerlessGraceMs;
  return ownerExited || ownerlessLockIsStale;
}

// 回收入口按目录与单文件两种形态分别处理，任一形态都不假设布局完整
// [事务] 先确认全部 owner 可回收再删，避免删到一半发现仍有活进程
// 单 owner 目录按 owner 文件名精确删除，等价于一次所有权校验
// [失败路径] 目录被替换后旧文件名删除不会命中新 owner，随后的移除因目录非空而失败
// 空目录与损坏目录走时间戳加宽限的兜底判定，只清理观察到的条目
async function removeAbandonedLock(
  lockFile: string,
  ownerlessGraceMs: number,
  observeLockInstance: ObserveLockInstance,
): Promise<LockRemovalAttempt> {
  try {
    const lockStat = await stat(lockFile);
    if (lockStat.isDirectory()) {
      const entries = await readdir(lockFile);
      const owners = entries.filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (owners.length === 1) {
        const ownerFile = join(lockFile, owners[0]!);
        if (!(await isOwnerFileReclaimable(ownerFile, ownerlessGraceMs, observeLockInstance))) {
          return { removed: false };
        }

        // 按唯一 owner 文件删除相当于所有权校验。旧锁目录被替换后，新 owner 的
        // 文件名不同，当前 rm 不会命中新锁；随后 rmdir 也会因目录非空而拒绝删除。
        await rm(ownerFile, { force: true });
        await rmdir(lockFile);
        return { removed: true };
      }

      const observedAt = Date.now();
      const directoryTimestamp =
        parseLockTimestamp(lockStat.mtimeMs, observedAt) ??
        observeLockInstance(lockFile, lockStat, observedAt);
      if (observedAt - directoryTimestamp < ownerlessGraceMs) {
        return { removed: false };
      }
      for (const owner of owners) {
        if (
          !(await isOwnerFileReclaimable(
            join(lockFile, owner),
            ownerlessGraceMs,
            observeLockInstance,
          ))
        ) {
          return { removed: false };
        }
      }

      // mkdir 成功后、owner 文件落盘前崩溃会留下空目录；损坏目录也可能
      // 包含多个 owner。只清理 stale 时观察到的条目，后来 owner 新增会让 rmdir 失败。
      await Promise.all(entries.map((entry) => rm(join(lockFile, entry), { force: true })));
      await rmdir(lockFile);
      return { removed: true };
    }

    const raw = await readFile(lockFile, "utf-8");
    if (!(await isOwnerFileReclaimable(lockFile, ownerlessGraceMs, observeLockInstance))) {
      return { removed: false };
    }

    // 兼容升级前遗留的单文件锁。新实现创建的是非空目录，旧路径删除无法移除新 owner。
    if ((await readFile(lockFile, "utf-8")) !== raw) {
      return { removed: false };
    }
    await rm(lockFile, { force: true });
    return { removed: true };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false, error };
  }
}

function createFileLockTimeoutError(
  filePath: string,
  lockFile: string,
  waitedMs: number,
  cause?: unknown,
): NodeJS.ErrnoException {
  const error = new Error(
    `Timed out after ${waitedMs}ms waiting for the ZCode file lock: ${lockFile}`,
  ) as NodeJS.ErrnoException & { cause?: unknown };
  error.code = ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
  error.path = filePath;
  error.syscall = "mkdir";
  error.cause = cause;
  return error;
}

// 获取主循环：先建目录再写 owner，最后校验身份，三步都成功才算持锁
// [并发] 建目录的原子性是互斥基础，先查后建会让两个进程同时成功
// 每次失败都区分「竞争」与「真实错误」，只有竞争才进入重试与回收
// 等待期间只尝试回收确实陈旧的锁，自身等待时长不构成证据
// 返回的释放闭包只持有本次 token，天然不会误伤接管者
export async function acquireFileLock(
  filePath: string,
  retryDelaysMs: readonly number[],
  ownerlessGraceMs: number,
  maxWaitMs: number,
): Promise<() => Promise<void>> {
  const lockFile = `${filePath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerFile = join(lockFile, `owner-${token}.json`);
  const payload = `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token,
  })}\n`;
  const startedAt = Date.now();
  const effectiveOwnerlessGraceMs = Math.min(
    Math.max(ownerlessGraceMs, 0),
    Math.max(Math.floor(maxWaitMs / 2), 0),
  );
  const observeLockInstance = createLockInstanceObserver();
  let lastRemovalError: unknown;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      await mkdir(lockFile);
      createdLock = true;
      const createdLockStat = await stat(lockFile);
      await writeFile(ownerFile, payload, { encoding: "utf-8", flag: "wx" });
      const currentLockStat = await stat(lockFile);
      const currentOwners = (await readdir(lockFile)).filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json"),
      );
      if (
        currentLockStat.dev !== createdLockStat.dev ||
        currentLockStat.ino !== createdLockStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== `owner-${token}.json`
      ) {
        throw Object.assign(new Error("ZCode file lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      return async () => {
        // 只删除本 writer 的唯一 owner 文件；锁已被接管时不会碰到后来 writer 的 token。
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {
          // best-effort cleanup
        });
      };
    } catch (error) {
      if (createdLock) {
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lockFile).catch(() => {});
      }
      const lostCreatedLock = createdLock && getErrorCode(error) === "ENOENT";
      // 非竞争错误直接原样抛出，保留权限不足与磁盘已满等真实原因
      // [失败路径] 把权限错误并入重试会让调用方等到超时才失败，掩盖配置问题
      // 丢失刚建目录视为竞争，因为锁可能在两步之间被回收
      // 其余错误按原样上抛，不做字符串匹配或降级
      // 该分支是重试语义的边界：放宽会重试无意义错误，收窄会漏掉真实竞争
      if (!isFileExistsError(error) && !lostCreatedLock) {
        throw error;
      }

      // 等待者自身已等待多久不能证明当前锁 stale，否则旧锁释放后可能误删
      // 后来 writer 的新锁。这里只回收 owner 已退出或无 PID 且超过短 grace 的锁，
      // 其余竞争等待到 maxWaitMs，并保留明确的权限错误或锁超时。
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        // 旧顺序会在达到 maxWaitMs 后仍先做一次 stale 回收。
        // 损坏 ownerless 锁可能恰好在这次检查跨过 grace，导致超时 waiter 越过
        // 等待上限删除后来 writer 的锁。达到上限后直接超时，避免跨实例误删。
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, error);
      }
      const removalAttempt = await removeAbandonedLock(
        lockFile,
        effectiveOwnerlessGraceMs,
        observeLockInstance,
      );
      if (removalAttempt.removed) {
        continue;
      }
      if (removalAttempt.error) {
        lastRemovalError = removalAttempt.error;
      }

      const remainingMs = Math.max(maxWaitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(filePath, lockFile, elapsedMs, lastRemovalError ?? error);
      }

      const retryDelayMs =
        retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}
