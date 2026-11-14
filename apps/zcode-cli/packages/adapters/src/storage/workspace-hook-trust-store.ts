// ============================================================
// File-backed Workspace Hook Trust store
// ============================================================
// 定位：把「用户已信任某 workspace 的某份 hook 声明」持久化为单个 JSON 文件，
// 跨进程安全地支持 grant / revoke / touch / compact。文件位置默认为
// ~/.zcode/security/workspace-hook-trust-v1.json，目录 0700、文件 0600。
// 输入输出：load 返回 missing / ok / corrupt 三态；mutate 类接口返回写入后的
// 完整 store 文件对象（schemaVersion + records）。
// 副作用：mkdir/chmod、lock 文件创建与删除、临时文件 + fsync + rename 原子替换。
// 失败语义：锁超时 → throw；读取损坏 → 改名隔离并返回 corrupt（fail-closed，
// 即全部 hook 视为不受信）；rename 占用类错误有界重试后仍抛出。
// 不变量：互斥靠 O_EXCL lock + pid/startTime/token；释放前验证 token 所有权；
// 写入必须先写临时文件并 fsync，再 rename 覆盖，读方永远看到完整 JSON。

import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceHookTrustRecord, WorkspaceHookTrustStoreFile } from "@zcode/contracts";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/contracts";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const SECURITY_DIRECTORY = "security";
const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";
// 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
const LOCK_START_TIME_TOLERANCE_MS = 2_000;
const PROC_CLOCK_TICKS_PER_SECOND = 100;

const execFileAsync = promisify(execFile);

interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** 进程实例启动时间（墙钟 ms）；上一版锁格式无此字段（undefined）。 */
  startTime?: number;
}

async function defaultWriteLockOwnerMetadata(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.writeFile(content, "utf8");
}

/** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
let ownStartTimeMs: number | undefined;
function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

/**
 * 查询指定 pid 的当前进程实例启动时间（墙钟毫秒）；无法确定时返回 null。
 * 用于 stale 回收时区分「原 owner 实例仍存活」与「pid 已被复用给无关进程」
 * （裸 pid 只标识进程表槽位，不具备跨时间唯一性）。
 * - linux: /proc/<pid>/stat 字段 22（boot 后 ticks）
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime（成本较高，但只在超龄回收路径触发）
 * - 失败/不支持 → null，调用方保守视为原 owner 存活（不回收）。
 */
async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是 state（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export type WorkspaceHookTrustStoreLoadResult =
  // 文件不存在：等同“没有任何信任记录”，不是错误。
  | { status: "missing"; records: [] }
  // 解析并校验通过：records 为当前全部可信记录。
  | { status: "ok"; records: WorkspaceHookTrustRecord[] }
  // 文件损坏：records 恒为空（fail-closed），并给出改名后的隔离路径。
  | { status: "corrupt"; records: []; recoveredCorruptPath: string };

export interface FileWorkspaceHookTrustStoreOptions {
  /** store 文件绝对路径；lock 文件为同路径 + .lock。 */
  filePath: string;
  /** 时钟注入点，影响 corrupt 文件名与 touch 的 lastUsedAt。 */
  now?: () => number;
  /** 获取锁的最长等待（默认 5s），超时抛错而不是无限等待。 */
  lockTimeoutMs?: number;
  /** 锁文件 mtime 超过该值才考虑 stale 回收（默认 30s）。 */
  staleLockMs?: number;
  /** 测试钩子：在 rename 之前执行，用于制造并发窗口。 */
  beforeRename?: () => void | Promise<void>;
  /** 测试钩子：替换 rename 实现（Windows 占用重试验证）。 */
  renameFile?: typeof rename;
  /** rename 重试退避序列；耗尽即抛出。 */
  renameRetryDelaysMs?: readonly number[];
  /** 测试注入：查询 pid 当前实例启动时间；默认按平台实现（/proc / ps / powershell）。 */
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
  /** 测试注入：写锁 owner metadata；默认 FileHandle.writeFile。 */
  writeLockOwnerMetadata?: (handle: FileHandle, content: string) => Promise<void>;
}

export interface WorkspaceHookTrustStoreCompactOptions {
  /** 当前仍在使用（受信）的 workspace+digest，永不被淘汰。 */
  current: Array<{ workspaceIdentity: string; hookDeclarationDigest: string }>;
  /** 非 current 记录的最长保留时长（按 lastUsedAt/grantedAt 计算）。 */
  maxAgeMs: number;
  /** 总记录上限；优先保留 current，其余按最近使用排序填满。 */
  maxRecords: number;
  /** 覆盖时钟，便于确定性测试。 */
  now?: number;
}

export interface WorkspaceHookTrustStoreRevokeOptions {
  workspaceIdentity: string;
  /** undefined = 撤销该 workspace 全部；非空数组 = 精确撤销；空数组 = 非法。 */
  hookDeclarationDigests?: readonly string[];
}

export interface WorkspaceHookTrustStorePathOptions {
  homeDir?: string;
  userConfigPath?: string;
}

/**
 * 解析 trust store 路径：读用户 config.json 的 storage.dir（缺省 ~/.zcode），
 * 拼 security/workspace-hook-trust-v1.json。config 读失败（非 ENOENT）会 throw。
 * 相对路径一律绑定 home 而非 cwd——安全文件不能随启动目录漂移。
 */
export async function resolveWorkspaceHookTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  const home = resolve(options.homeDir ?? homedir());
  const userConfigPath = resolve(
    options.userConfigPath ?? join(home, ".zcode", "cli", "config.json"),
  );
  const config = await readUserConfig(userConfigPath);
  const storage = isRecord(config.storage) ? config.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const storageRoot = configured ? resolveTrustedUserPath(configured, home) : join(home, ".zcode");
  return join(storageRoot, SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

/**
 * 默认工厂：先解析路径再构造 store。返回已可用的实例，不做预热读取；
 * 目录/文件只在实际 load/mutate 时创建。
 */
export async function createDefaultFileWorkspaceHookTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceHookTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceHookTrustStore> {
  return createFileWorkspaceHookTrustStore({
    ...options,
    filePath: await resolveWorkspaceHookTrustStorePath(options),
  });
}

// 工厂：只做构造，不校验文件；非法记录会在 grant 时被 schema 拒绝。
export function createFileWorkspaceHookTrustStore(
  options: FileWorkspaceHookTrustStoreOptions,
): FileWorkspaceHookTrustStore {
  return new FileWorkspaceHookTrustStore(options);
}

// 文件型 trust store：进程内串行化（mutationQueue）+ 跨进程文件锁；
// 所有读写都包在锁内，读-改-写在锁内完成，避免旧快照覆盖新提交。
export class FileWorkspaceHookTrustStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly beforeRename?: () => void | Promise<void>;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private readonly writeLockOwnerMetadata: (
    handle: FileHandle,
    content: string,
  ) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  // 依赖注入集中在构造期；lockPath 由 filePath 派生，调用方不能单独配置。
  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.beforeRename = options.beforeRename;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
    this.writeLockOwnerMetadata = options.writeLockOwnerMetadata ?? defaultWriteLockOwnerMetadata;
  }

  /**
   * 读取当前信任集合：missing（文件不存在）/ ok / corrupt 三态。
   * 读取也在锁内进行，并会先确保 security 目录存在（0700）。
   * corrupt 时会把原文件改名为 *.corrupt-<now>，随后返回空记录（fail-closed）。
   */
  load(): Promise<WorkspaceHookTrustStoreLoadResult> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(() => this.readCurrent(true));
    });
  }

  /**
   * 新增/更新信任记录：按 (workspaceIdentity, hookDeclarationDigest) 去重合并，
   * 后写覆盖前写。记录先经 schema 校验，非法则 reject 且不产生任何写入。
   * 返回写入后的完整 store（包含未受影响的旧记录）。
   */
  grant(records: readonly WorkspaceHookTrustRecord[]): Promise<WorkspaceHookTrustStoreFile> {
    const validated = records.map((record) => workspaceHookTrustRecordSchema.parse(record));
    return this.mutate((current) => {
      const next = new Map(current.records.map((record) => [trustKey(record), record] as const));
      for (const record of validated) next.set(trustKey(record), record);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  /**
   * 撤销信任：digests 为 undefined 时撤销该 workspace 全部记录；非空数组时
   * 只撤销命中的 digest。空数组被显式拒绝（见下方三态说明），避免“看起来
   * 成功但什么都没撤销”。返回撤销后的完整 store。
   */
  revoke(options: WorkspaceHookTrustStoreRevokeOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (options.hookDeclarationDigests?.length === 0) {
      // 空数组会生成空 Set，filter 因而保留全部记录并静默成功，调用方无法
      // 区分“撤销全部”的 undefined 与“没有目标”的无效请求。三态固定为：undefined
      // 撤销 workspace 全部、非空数组精确撤销、空数组在任何 IO 前拒绝。
      return Promise.reject(
        new Error("hookDeclarationDigests must be undefined or non-empty"),
      );
    }
    const selected = options.hookDeclarationDigests
      ? new Set(options.hookDeclarationDigests)
      : undefined;
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.hookDeclarationDigest)),
      ),
    }));
  }

  /**
   * 刷新命中记录的 lastUsedAt（用于 compact 的“最近使用”排序）。
   * 不新增记录；未命中的记录原样保留。usedAt 缺省取当前时间 ISO 字符串。
   */
  touch(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
    usedAt?: string;
  }): Promise<WorkspaceHookTrustStoreFile> {
    const selected = new Set(input.hookDeclarationDigests);
    const usedAt = input.usedAt ?? new Date(this.now()).toISOString();
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.map((record) =>
        record.workspaceIdentity === input.workspaceIdentity &&
        selected.has(record.hookDeclarationDigest)
          ? { ...record, lastUsedAt: usedAt }
          : record,
      ),
    }));
  }

  /**
   * 压缩存储：current 集合无条件保留；其余按 maxAgeMs 过期淘汰，再按最近使用
   * 降序填满 maxRecords 剩余名额。参数非法（负数/非整数）在进入 IO 前 throw。
   * 无删除以外的副作用，写入仍走原子替换。
   */
  compact(options: WorkspaceHookTrustStoreCompactOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a nonnegative finite number");
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    const now = options.now ?? this.now();
    const current = new Set(
      options.current.map((entry) =>
        trustKey({
          workspaceIdentity: entry.workspaceIdentity,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        }),
      ),
    );
    return this.mutate((store) => {
      const retained = store.records.filter((record) => {
        if (current.has(trustKey(record))) return true;
        const timestamp = Date.parse(record.lastUsedAt ?? record.grantedAt);
        return Number.isFinite(timestamp) && now - timestamp <= options.maxAgeMs;
      });
      const currentRecords = retained.filter((record) => current.has(trustKey(record)));
      const nonCurrent = retained
        .filter((record) => !current.has(trustKey(record)))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      const available = Math.max(0, options.maxRecords - currentRecords.length);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...currentRecords, ...nonCurrent.slice(0, available)],
      };
    });
  }

  // mutate 的统一骨架：串行化 → 建目录 → 加锁 → 读取当前（损坏则视为空）
  // → 应用变更 → schema 校验 → 原子写。任何一步失败都不会写文件。
  private mutate(
    update: (current: WorkspaceHookTrustStoreFile) => WorkspaceHookTrustStoreFile,
  ): Promise<WorkspaceHookTrustStoreFile> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(async () => {
        const loaded = await this.readCurrent(true);
        const current: WorkspaceHookTrustStoreFile = {
          schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
          records: loaded.status === "ok" ? loaded.records : [],
        };
        const next = workspaceHookTrustStoreFileSchema.parse(update(current));
        await this.atomicWrite(next);
        return next;
      });
    });
  }

  // 进程内串行队列：无论前一个操作成功或失败都继续执行下一个；
  // 队列本身只用于排序，不吞掉调用方拿到的 result 错误。
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // 临界区包装：acquire → 执行 → 关闭句柄 → 仅当锁仍属于自己时删除。
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      // 释放前必须验证所有权。本进程的锁可能已被 stale 回收并归属
      // 新持有者；无条件 unlink 会删掉新持有者的锁，让后续 writer 与之并发
      // 进入临界区，造成基于旧快照的 read-modify-write 覆盖已提交的 revoke/grant。
      await this.releaseLockIfOwned(token);
    }
  }

  // 自旋获取锁：open(wx) 抢锁，EEXIST 时先尝试回收 stale，再检查 deadline 重试。
  private async acquireLock(): Promise<{ handle: FileHandle; token: string }> {
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        // 锁内容写入 pid + 进程启动时间 + 不可预测 owner token。
        // startTime 是进程实例标识——裸 pid 会被系统复用，仅凭
        // process.kill(pid, 0) 判活会把「崩溃后 pid 被复用」的锁误判为
        // 活 owner 而永不回收，revoke/grant 全部卡死。回收侧用 probe 比对
        // 当前实例启动时间与锁内记录来区分原 owner 与复用者。
        const token = randomUUID();
        const owner = `${JSON.stringify({
          pid: process.pid,
          startTime: currentProcessStartTimeMs(),
          token,
        })}\n`;
        await this.writeLockOwnerMetadata(handle, owner);
        return { handle, token };
      } catch (error) {
        // open(wx) 成功但 metadata 写失败（磁盘满等）时，必须关闭句柄
        // 并删除自己刚创建的锁——残留空锁会被后续 writer 当作无主锁回收，
        // 破坏互斥；这里只可能删掉自己 wx 独占创建的文件，无越权风险。
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring Workspace Hook Trust store lock: ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  /** 仅当锁仍属于 token 对应持有者时才删除；无主（缺失/他人）一律不动。 */
  private async releaseLockIfOwned(token: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  // 读取锁内 owner 信息并校验 token；损坏/旧版空锁按无主处理（返回 null）。
  private async readLockOwner(): Promise<LockOwnerMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { pid?: unknown }).pid === "number" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          token: (parsed as { token: string }).token,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === "number"
              ? (parsed as { startTime: number }).startTime
              : undefined,
        };
      }
      return null;
    } catch {
      // 旧版本空锁/损坏锁 → 无主。
      return null;
    }
  }

  /** pid 存活检测：signal 0 探测。EPERM（Windows 无权限）视为存活，ESRCH/EINVAL 视为死亡。 */
  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error, "EPERM");
    }
  }

  // stale 回收：mtime 未超龄直接返回；超龄时优先用 pid 存活 + 实例启动时间判定，
  // 无法确定一律保守不回收（宁可等待超时，也不误删活锁导致并发写）。
  private async removeStaleLock(): Promise<void> {
    try {
      const lockStats = await stat(this.lockPath);
      if (Date.now() - lockStats.mtimeMs <= this.staleLockMs) return;
      // 超龄但持有进程仍存活（休眠/调试暂停/杀毒拖慢 IO）→ 不回收。
      // mtime 无法区分"持有者死亡"与"持有者暂停或慢"；pid 存活检测可以。
      // 无法解析的锁（旧版空文件）无 pid 可查 → 按死亡回收。
      const owner = await this.readLockOwner();
      if (!owner) {
        await rm(this.lockPath, { force: true });
        return;
      }
      if (owner.pid === process.pid) return;
      if (!this.isProcessAlive(owner.pid)) {
        await rm(this.lockPath, { force: true });
        return;
      }
      // pid 存活 ≠ 原 owner 存活。pid 会被系统复用——原 owner 崩溃后
      // 其 pid 若被分配给无关长命进程，纯 kill(0) 判活会让锁永不回收，
      // revoke/grant 全部卡死。用进程实例启动时间核验：锁内记录的 startTime
      // 与该 pid 当前实例的实际启动时间一致 → 原 owner 确实活着（不回收）；
      // 不一致 → 原 owner 已死、pid 已易主（安全回收）。probe 不可用（平台
      // 不支持/查询失败）或锁记录无 startTime（上一版格式混存窗口）→ 保守
      // 视为原 owner 存活，不回收。
      const currentStart = await this.probeProcessStartTime(owner.pid);
      if (currentStart === null || owner.startTime === undefined) return;
      if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  // 安全目录：递归创建后强制 0700，防止同机其他用户读取信任记录。
  private async ensureSecurityDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  // 读取并校验 store；损坏时可选择改名隔离（recoverCorrupt=true）或原样抛出。
  // 返回 corrupt 时 records 恒为空：调用方应把整个 trust 集合视为失效。
  private async readCurrent(recoverCorrupt: boolean): Promise<WorkspaceHookTrustStoreLoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing", records: [] };
      throw error;
    }

    try {
      const parsed = workspaceHookTrustStoreFileSchema.parse(JSON.parse(content) as unknown);
      // chmod 是权限加固副作用，不是 load 的核心职责。只读目录/异常所有权下
      // chmod 会抛 EPERM/EROFS，若任其冒泡，整个 load 都会失败——比一次加固失败
      // 应有的后果重得多。加固失败只降级为忽略：读出来的记录仍然有效，
      // 后续 mutate 的 atomicWrite 会再次尝试。
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", records: parsed.records };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // 损坏文件改名失败（只读目录等）若让错误冒泡，会绕过"返回 corrupt 状态"
      // 的设计路径——调用方看到的是意外异常而非 fail-closed 的 corrupt 状态。
      // 改名失败仍按 corrupt 返回：corrupt 语义即全部 Hook 不受信（fail-closed），
      // 原文件残留在原地不会让任何记录被当作可信。
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // 改名失败：仍返回 corrupt 状态，原损坏文件留在原地（下次 load 仍判 corrupt）。
      }
      return { status: "corrupt", records: [], recoveredCorruptPath };
    }
  }

  // 原子写：同目录临时文件（wx 0600）→ 写 JSON → fsync → close → rename 覆盖。
  // 任一步失败都关闭句柄并删除临时文件，原 store 保持不变。
  private async atomicWrite(store: WorkspaceHookTrustStoreFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.();
      await renameWithRetry(
        this.renameFile,
        tempPath,
        this.filePath,
        this.renameRetryDelaysMs,
      );
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

// rename 有界重试：Windows 上杀软/索引器可能短暂占用目标文件；只对
// EPERM/EBUSY/EACCES 重试，其余错误立即上抛，退避序列耗尽后也上抛。
async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件，单次 rename 会让已完成
      // fsync 的 Trust mutation 误报失败。仅对已知短暂占用错误做有界异步重试。
      await sleep(delayMs);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

// 读用户配置：文件不存在视为空配置 {}；解析失败/IO 失败则包装 cause 后抛出。
async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

// storage.dir 解析：~/ 展开为 home；绝对路径原样；相对路径绑定 home（不随 cwd 漂移）。
function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // 安全原因：user config 中的相对 storage.dir 绑定用户目录，不能随 workspace cwd 漂移。
  return resolve(home, path);
}

// 复合唯一键：用 NUL 分隔，避免 workspaceIdentity 与 digest 拼接产生歧义。
function trustKey(record: { workspaceIdentity: string; hookDeclarationDigest: string }): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

// 最近使用时间：优先 lastUsedAt，缺失回落到 grantedAt；解析失败得到 NaN，
// compact 会因 Number.isFinite 判假而淘汰该记录。
function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
