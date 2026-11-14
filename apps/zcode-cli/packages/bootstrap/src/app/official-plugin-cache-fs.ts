import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ============================================================
// 官方插件缓存目录的 FS 原语：瞬时错误的有界重试与原子写入
// ============================================================
// Windows 的杀毒 / 索引器会短暂占用刚写出的文件，rmSync / renameSync 因此可能抛
// EACCES/EBUSY/EPERM。缓存是“可重建的派生物”，值得吸收这种瞬时失败；但整个启动链路当前是
// 同步 API，不能为一处重试改成异步，所以这里用 Atomics.wait 做同步短等待，并用一份共享的
// 截止时间把总等待封顶。非瞬时错误、预算耗尽、重试次数用尽一律原样抛出，不做兜底写半份缓存。

const DEFAULT_RETRY_DURATION_MS = 1_500;
const RETRY_DELAYS_MS = [25, 50, 100] as const;
const RETRY_ATTEMPTS_FIELD = "zcodeOfficialPluginCacheAttempts";
const TRANSIENT_ERROR_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]);

/**
 * 一次缓存操作的重试预算：绝对截止时间 + 可注入的 now / sleep。
 *
 * `deadlineAt` 是绝对毫秒（不是剩余量），所以多个原语共享同一份预算时不会各自重新计时；
 * `sleep` 在生产是同步 Atomics.wait，测试可注入空实现让重试立即发生。
 */
export interface OfficialPluginCacheRetryBudget {
  deadlineAt: number;
  now: () => number;
  sleep: (delayMs: number) => void;
}

/**
 * 建立默认预算：现在 + 1.5 秒；`now` / `sleep` 可替换，便于测试假时钟。
 * 每个独立缓存操作通常各建一份；嵌套调用（如 write → rename）必须显式传递同一份预算。
 */
export function createOfficialPluginCacheRetryBudget(input?: {
  durationMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => void;
}): OfficialPluginCacheRetryBudget {
  const now = input?.now ?? Date.now;
  return {
    deadlineAt: now() + (input?.durationMs ?? DEFAULT_RETRY_DURATION_MS),
    now,
    sleep: input?.sleep ?? sleepSync,
  };
}

/**
 * 判定错误是否为 Windows 文件占用类的瞬时错误（EACCES/EBUSY/EEXIST/ENOTEMPTY/EPERM）。
 *
 * 只看 `code`，不看 message；ENOENT / 磁盘满 / 只读文件系统等不可恢复错误不在此列，必须冒泡。
 */
export function isTransientOfficialPluginCacheFsError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    TRANSIENT_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}

/**
 * 读取错误对象上已经试过的次数（由 {@link retryOfficialPluginCacheFs} 写入）。
 * 非对象或无该字段一律回 1，供上层日志 / 计数使用；它只是诊断元数据，不参与重试判定。
 */
export function getOfficialPluginCacheRetryAttempts(error: unknown): number {
  if (typeof error !== "object" || error === null) return 1;
  const attempts = (error as Record<string, unknown>)[RETRY_ATTEMPTS_FIELD];
  return typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 1;
}

/**
 * 同步执行一次缓存 FS 操作，只对瞬时错误按 25/50/100ms 退避重试；每次失败都把尝试次数写回
 * error，然后判定：非瞬时、没有下一次退避、或“现在 + 下一次延迟”已越过预算截止 → 原样抛出。
 *
 * 预算是共享对象，调用方在嵌套原语间传入同一份，保证总等待有界；`operation` 必须可重入且
 * 幂等（典型是 rm / rename / 覆盖写），不能被调用两次却产生不同结果。
 */
export function retryOfficialPluginCacheFs<T>(
  operation: () => T,
  options?: {
    budget?: OfficialPluginCacheRetryBudget;
  },
): T {
  const budget = options?.budget ?? createOfficialPluginCacheRetryBudget();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      return operation();
    } catch (error) {
      setRetryAttempts(error, attempts);
      const delayMs = RETRY_DELAYS_MS[attempts - 1];
      if (
        !isTransientOfficialPluginCacheFsError(error) ||
        delayMs === undefined ||
        budget.now() + delayMs > budget.deadlineAt
      ) {
        throw error;
      }
      budget.sleep(delayMs);
    }
  }
}

/**
 * 递归删除缓存目录（force + 内置 maxRetries），外层再套统一预算重试。
 * 返回 void；目录本身不存在视为成功。失败抛出最后一次错误，调用方可据此决定是否放弃本次缓存换代。
 */
export function removeOfficialPluginCacheDirectory(
  path: string,
  budget = createOfficialPluginCacheRetryBudget(),
): void {
  retryOfficialPluginCacheFs(
    () => {
      rmSync(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 25,
      });
    },
    { budget },
  );
}

/**
 * 重命名缓存路径（同卷原子替换 / 目录换名），走调用方给的预算。
 * 与 rm 共用预算才能让“先删旧、再换新”的总等待仍是一个上界；跨卷 rename 的 EXDEV 属不可重试错误。
 */
export function renameOfficialPluginCachePath(
  fromPath: string,
  toPath: string,
  budget: OfficialPluginCacheRetryBudget,
): void {
  retryOfficialPluginCacheFs(() => renameSync(fromPath, toPath), { budget });
}

/**
 * 原子写文本：先写同目录的唯一临时文件（名字含 pid / 时间 / 随机段，避免并发互踩），再用
 * rename 换名；每一步都在同一份预算内重试瞬时错误。
 *
 * 失败语义：任何一步失败都尝试删除临时文件后原样抛错；清理失败被忽略，因为不能拿清理错误覆盖
 * 真正的写入错误，残留的唯一临时文件不会挡住下次启动（下次用新名字）。
 */
export function writeTextFileAtomicallyWithRetry(
  filePath: string,
  contents: string,
  budget: OfficialPluginCacheRetryBudget,
): void {
  const temporaryPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    retryOfficialPluginCacheFs(() => writeFileSync(temporaryPath, contents), { budget });
    renameOfficialPluginCachePath(temporaryPath, filePath, budget);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // 清理临时文件失败不能覆盖真正的写入错误；下次启动会使用新的唯一临时文件。
    }
    throw error;
  }
}

function setRetryAttempts(error: unknown, attempts: number): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Object.defineProperty(error, RETRY_ATTEMPTS_FIELD, {
      configurable: true,
      value: attempts,
      writable: true,
    });
  } catch {
    // 某些第三方错误对象可能被冻结；此时日志退回 attempts=1，不改变原始异常。
  }
}

function sleepSync(delayMs: number): void {
  // 官方插件发现链路当前是同步 API。Windows 杀毒/索引器可能短暂占用缓存，
  // 用总预算受限的短等待吸收瞬时 EPERM，避免为热修扩大成整条启动链路异步化。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
