// ============================================================
// 文件定位：CLI 主机侧的 deviceMid（设备身份）首次生成与持久化，与 Desktop 共用 telemetry-state.json。
// 输入输出：ensureCliDeviceMid 返回 deviceMid；可注入 baseDir/env/createId 便于测试。
// 副作用：mkdir、写临时文件后 rename 原子替换、创建/删除 .lock、stat/unlink 过期锁。
// 失败语义：任何文件系统异常都不阻断模型请求——回退为本次进程内固定的随机 UUID 并缓存。
// 不变量：同一 stateFile 只生成一次（Promise 缓存）；锁文件带 pid，进程已死且超时可抢占。
// ============================================================
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createUuid } from "@zcode/shared";

// 锁重试：10ms × 200 次 ≈ 2s；锁超过 5 分钟且持有进程已退出才视为 stale。
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;
const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";

// state 文件是宽松 JSON：只保证 deviceMid 为字符串，其余字段原样透传回写。
interface TelemetryState {
  // 设备身份；缺失或空串时视为未初始化。
  deviceMid?: unknown;
  [key: string]: unknown;
}

// 锁文件内容：写入时刻用于 stale 判定，pid 用于“持锁进程是否仍存活”判定。
interface TelemetryLockOwner {
  // 毫秒时间戳（Date.now()）。
  createdAt: number;
  // 持锁进程 pid；非本机/复用 pid 的极端情况由 mtime 超时兜底。
  pid: number;
}

export interface EnsureCliDeviceMidOptions {
  // 数据根目录覆盖；缺省读 ZCODE_DATA_BASE_DIR，再缺省 homedir。
  baseDir?: string;
  // 生成 id 的注入点，测试可固定值。
  createId?: () => string;
  // env 覆盖，便于测试 ZCODE_DATA_BASE_DIR。
  env?: Record<string, string | undefined>;
}

// 按 state 文件绝对路径缓存 Promise：并发调用共享同一次读写，失败结果也缓存。
const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

/**
 * 在 CLI 所在主机独立确保 deviceMid 存在；它是反馈与 provider 请求头使用的设备身份，
 * 与 Desktop 共享同一个 state 文件与字段。
 * 文件系统异常不阻断模型请求；同一进程会继续使用首次生成的 fallback UUID。
 */
// 返回 deviceMid（持久化值或进程内 fallback）；永不 reject，调用方无需 try/catch。
export function ensureCliDeviceMid(options: EnsureCliDeviceMidOptions = {}): Promise<string> {
  const stateFile = resolveCliTelemetryStateFile(options);
  const cached = deviceMidCacheByStateFile.get(stateFile);
  if (cached) {
    return cached;
  }

  const createId = options.createId ?? createUuid;
  // fallback 只在本次进程内生成一次：保证“写盘失败后重试/重复调用”仍拿到同一身份。
  let generatedDeviceMid: string | undefined;
  const getGeneratedDeviceMid = () => {
    generatedDeviceMid ??= createId();
    return generatedDeviceMid;
  };
  // 失败被 catch 成 fallback：设备身份的可用性优先于持久化一致性。
  const pending = ensurePersistedDeviceMid({
    getGeneratedDeviceMid,
    stateFile,
  }).catch(() => getGeneratedDeviceMid());
  deviceMidCacheByStateFile.set(stateFile, pending);
  return pending;
}

// 解析 state 路径：显式 baseDir > ZCODE_DATA_BASE_DIR > homedir，统一追加 .zcode/v2/telemetry-state.json。
// 支持 "~" 与 "~/xxx" 展开；空串按 homedir 处理，避免落到相对路径。
function resolveCliTelemetryStateFile(options: EnsureCliDeviceMidOptions): string {
  const env = options.env ?? process.env;
  const configuredBaseDir =
    options.baseDir ?? env[ZCODE_DATA_BASE_DIR_ENV_KEY]?.trim() ?? homedir();
  const baseDir = configuredBaseDir.length > 0 ? configuredBaseDir : homedir();
  return join(resolveUserPath(baseDir), ".zcode", "v2", "telemetry-state.json");
}

// 无锁快速路径读取；读不到再加锁做“二次检查 + 生成 + 原子写”，避免多进程同时生成不同 id。
async function ensurePersistedDeviceMid(input: {
  getGeneratedDeviceMid: () => string;
  stateFile: string;
}): Promise<string> {
  const existingDeviceMid = await readExistingDeviceMid(input.stateFile);
  if (existingDeviceMid) {
    return existingDeviceMid;
  }

  return withTelemetryStateLock(input.stateFile, async (state) => {
    // 锁内二次检查：另一个进程可能已在等待期间写入，必须以其值为准。
    const lockedExistingDeviceMid = readDeviceMid(state);
    if (lockedExistingDeviceMid) {
      return lockedExistingDeviceMid;
    }

    const deviceMid = input.getGeneratedDeviceMid();
    state.deviceMid = deviceMid;
    await writeTelemetryState(input.stateFile, state);
    return deviceMid;
  });
}

async function readExistingDeviceMid(stateFile: string): Promise<string | undefined> {
  return readDeviceMid(await readTelemetryState(stateFile));
}

function readDeviceMid(state: TelemetryState): string | undefined {
  return typeof state.deviceMid === "string" && state.deviceMid.length > 0
    ? state.deviceMid
    : undefined;
}

// 解析 state 文件：非 JSON/非对象/读取失败都返回空对象，绝不让坏文件阻断生成流程。
async function readTelemetryState(stateFile: string): Promise<TelemetryState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// 原子写：同目录临时文件 + rename；失败时清掉临时文件再抛，避免残留垃圾。
async function writeTelemetryState(stateFile: string, state: TelemetryState): Promise<void> {
  const directory = dirname(stateFile);
  await mkdir(directory, { recursive: true });
  const tempFile = join(
    directory,
    `.${basename(stateFile)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );

  try {
    await writeFile(tempFile, JSON.stringify(state, null, 2), "utf-8");
    await rename(tempFile, stateFile);
  } catch (error) {
    await unlink(tempFile).catch(() => undefined);
    throw error;
  }
}

// 互斥锁：以 "wx"（不存在才创建）抢占 lock 文件；EEXIST 时判断是否 stale，否则退避重试。
// 持锁期间执行 run，finally 必定关句柄并删除锁；超时由外层 catch 转成 fallback。
async function withTelemetryStateLock<T>(
  stateFile: string,
  run: (state: TelemetryState) => Promise<T>,
): Promise<T> {
  const lockFile = join(dirname(stateFile), "telemetry-state.lock");
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            createdAt: Date.now(),
            pid: process.pid,
          }),
          "utf-8",
        );
        return await run(await readTelemetryState(stateFile));
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => undefined);
      }
    } catch (error) {
      // 非 EEXIST（如权限/磁盘）直接抛出，交给上层 fallback；只有“锁被占用”才重试。
      if (!isNodeErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (await removeStaleTelemetryLockIfNeeded(lockFile, Date.now())) {
        continue;
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("CLI telemetry state lock timeout");
}

// stale 判定：mtime 超过 5 分钟，或锁内 pid 对应的进程已不存在，才允许删除。
// 返回 true 表示已删除（调用方立即重试），false 表示继续退避。
async function removeStaleTelemetryLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    // 锁未超时：若能读到 owner 且进程仍存活，就必须继续等待；读不到 owner 按可疑锁清理。
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readTelemetryLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function readTelemetryLockOwner(lockFile: string): Promise<TelemetryLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockFile, "utf-8")) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return {
      createdAt: parsed.createdAt,
      pid: parsed.pid,
    };
  } catch {
    return null;
  }
}

// 存活探测：signal 0 不发信号只做存在性检查；EPERM 说明进程存在但无权限，也视为存活。
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}

// 用户路径展开：单独 "~" → homedir；"~/x" → homedir/x；其余 resolve 成绝对路径。
function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
