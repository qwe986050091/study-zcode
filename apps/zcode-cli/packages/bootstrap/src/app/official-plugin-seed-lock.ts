import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SEED_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_PLUGIN_SEED_LOCK_TIMEOUT";

interface OfficialPluginSeedLockOptions {
  retryDelayMs?: number;
  staleLockAgeMs?: number;
  timeoutMs?: number;
}

/**
 * 以跨进程目录锁串行化官方插件 seed：`<targetRoot>.seed-lock` 的 mkdir 是唯一抢锁动作。
 *
 * 输入：`targetRoot` 为本次要写的缓存目录；`action` 在持锁期间同步执行；`options` 可调
 * 轮询间隔 / 僵尸锁年龄 / 总等待上限（默认 50ms / 60s / 15s）。
 * 输出：原样返回 `action()` 的结果。副作用：建锁目录、写 owner.json（pid + 时间），finally
 * 必删锁目录——无论 action 成功、抛错还是进程内异常，都不把锁留给下一次启动。
 * 失败语义：等锁超时抛带稳定 code `ZCODE_PLUGIN_SEED_LOCK_TIMEOUT` 的错误，调用方按降级处理；
 * 其他 fs 错误冒泡。僵尸锁用 rename 取得所有权后再删，避免 TOCTOU 误删别人刚建的新锁。
 */
export function withOfficialPluginSeedLock<T>(
  targetRoot: string,
  action: () => T,
  options: OfficialPluginSeedLockOptions = {},
): T {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockRoot = `${targetRoot}.seed-lock`;
  const startedAt = Date.now();

  mkdirSync(dirname(lockRoot), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockRoot);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      tryTakeOverStaleLock(lockRoot, staleLockAgeMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(
          new Error(`[official-plugin-seed-lock] timed out waiting for ${lockRoot}`),
          { code: SEED_LOCK_TIMEOUT_ERROR_CODE },
        );
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    writeFileSync(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    return action();
  } finally {
    removeLockDirectory(lockRoot);
  }
}

/** 稳定错误码判定（项目规范：不靠错误文本分流），供调用方把等锁超时按降级处理。 */
// 只认 withOfficialPluginSeedLock 赋的 code；其他错误（含嵌套 fs 错误）一律 false。
export function isOfficialPluginSeedLockTimeoutError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return errorCode(error) === SEED_LOCK_TIMEOUT_ERROR_CODE;
}

function tryTakeOverStaleLock(lockRoot: string, staleLockAgeMs: number): void {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockRoot).mtimeMs;
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const ownerPid = readLockOwnerPid(lockRoot);
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
  if (ownerPid === undefined && ageMs < staleLockAgeMs) return;

  const staleRoot = `${lockRoot}.stale-${process.pid}-${Date.now()}`;
  try {
    // 直接删除 stale lock 存在 TOCTOU，可能误删另一进程刚创建的新锁。
    // 先原子改名取得旧锁所有权，只清理自己成功改名的目录。
    renameSync(lockRoot, staleRoot);
  } catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  removeLockDirectory(staleRoot);
}

function readLockOwnerPid(lockRoot: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(lockRoot, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
      ? owner.pid
      : undefined;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows/Unix 都可能因权限返回 EPERM；这代表进程存在，只是不可探测。
    return errorCode(error) === "EPERM";
  }
}

function removeLockDirectory(path: string): void {
  rmSync(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: DEFAULT_RETRY_DELAY_MS,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isTransientLockRace(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(errorCode(error));
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  // bootstrap 的 filesystem seed 本身是同步启动边界；这里短暂阻塞当前 Agent
  // 进程，换取跨进程同版本缓存只有一个写入者。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
