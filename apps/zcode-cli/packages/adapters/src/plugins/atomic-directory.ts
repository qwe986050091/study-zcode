import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";

/*
 * ============================================================
 * plugins / atomic-directory.ts —— 插件目录的原子替换 / 回滚 / 崩溃恢复
 *
 * 定位：插件缓存目录不能出现“半个版本”。本文件用 staging 目录 + 确定性 backup +
 * 排他事务 marker 实现提交/回滚，并在任何读取前先做 crash recovery。
 *
 * 输入输出：activate 返回 {finalize, rollback, transactionId}；replace = activate+finalize；
 * writeFileAtomically 用于状态文件；recoverAtomicTargetSync 返回“当前应读的路径”。
 *
 * 副作用：mkdir/cp/rename/rm 及 .<name>.transaction.json 写入；不访问网络。
 *
 * 失败语义：rename 失败自动回滚 backup；marker 已存在→already active；staging 失败只清理
 * staging（不碰 target）；恢复时标记 owner 仍存活则只读不恢复，避免抢走别人的快照。
 *
 * 不变量：同一 target 进程内只允许一个事务；marker 用 `wx` 排他创建以覆盖跨进程；
 * 提交点（rename 完成）之后不再响应取消；backup 只在权威状态持久化后删除。
 * ============================================================
 */

export interface ActivateDirectoryAtomicallyInput {
  /** 协调事务的权威状态文件（如 marketplace.json）；缺省为 standalone 模式。 */
  authorityPath?: string;
  /** 在 staging 已复制完成后、提交前执行的额外准备（如写入 manifest）。 */
  prepare?: (stagedPath: string) => Promise<void>;
  /** 取消信号；只在提交点之前生效。 */
  signal?: AbortSignal;
  /** 源目录；缺省时只创建空 staging（用于生成式内容）。 */
  sourcePath?: string;
  /** 最终目录绝对路径。 */
  targetPath: string;
}

export interface ReplaceDirectoryAtomicallyInput extends ActivateDirectoryAtomicallyInput {
  /** 必须提供的源目录。 */
  sourcePath: string;
}

export interface AtomicDirectoryActivation {
  /** 提交完成：删除 backup 与 marker，释放 owner。可重复调用。 */
  finalize: () => Promise<void>;
  /** 撤销：删除新 target 并把 backup 换回。可重复调用。 */
  rollback: () => Promise<void>;
  /** 本次事务 id，写入权威状态用于判定是否已提交。 */
  transactionId: string;
}

interface AtomicTransactionRecordV1 {
  /** 旧格式只记录 staging 目录名，无 owner/事务 id。 */
  stageName: string;
  /** 格式版本判别字段。 */
  version: 1;
}

interface AtomicTransactionRecordV2 {
  /** 协调模式的权威文件绝对路径。 */
  authorityPath?: string;
  /** 事务开始前 target 是否存在（决定崩溃时是否恢复 backup）。 */
  hadTarget: boolean;
  /** coordinated=需要等权威状态提交；standalone=目录本身就是权威。 */
  mode: "coordinated" | "standalone";
  /** 进程实例 id，用于同 pid 复用场景判定 owner 归属。 */
  ownerId: string;
  /** 写入进程 pid，用于存活检测。 */
  ownerPid: number;
  /** staging 容器目录名（相对父目录）。 */
  stageName: string;
  /** 事务 id，与权威状态中的 cacheTransactionId 对应。 */
  transactionId: string;
  /** 格式版本判别字段。 */
  version: 2;
}

type AtomicTransactionRecord = AtomicTransactionRecordV1 | AtomicTransactionRecordV2;

const atomicProcessOwnerId = randomUUID();
const activeAtomicReservations = new Set<string>();
const activeAtomicTargets = new Map<
  string,
  Pick<AtomicTransactionRecordV2, "authorityPath" | "hadTarget" | "mode" | "transactionId">
>();

/** backup 与 marker 固定命名在 target 同目录，保证 rename 在同一文件系统内原子生效。 */
function getAtomicRecoveryPaths(targetPath: string): {
  backupPath: string;
  transactionPath: string;
} {
  const parent = dirname(targetPath);
  const name = basename(targetPath);
  return {
    backupPath: join(parent, `.${name}.backup`),
    transactionPath: join(parent, `.${name}.transaction.json`),
  };
}

/**
 * 同步崩溃恢复：读取 marker，判断事务是否已提交/仍在活跃，然后把磁盘恢复到一致状态。
 *
 * 返回“应当读取的路径”。三种情况：本进程活跃事务→只返回读路径不清理；其他进程仍存活→
 * 同样只读；owner 已死→按 coordinated 权威状态决定删除或回滚 backup，并清理 staging。
 *
 * 纯本地 IO；解析失败按无 marker 处理，绝不让损坏 marker 阻断读取。
 */
export function recoverAtomicTargetSync(targetPath: string): string {
  const parent = dirname(targetPath);
  const name = basename(targetPath);
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(targetPath);
  const targetKey = resolve(targetPath);
  const activeTransaction = activeAtomicTargets.get(targetKey);

  let transaction: AtomicTransactionRecord | undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(transactionPath, "utf8"),
    ) as Partial<AtomicTransactionRecord>;
    if (parsed.version === 1 && typeof parsed.stageName === "string") {
      transaction = { stageName: parsed.stageName, version: 1 };
    } else if (
      parsed.version === 2 &&
      typeof parsed.stageName === "string" &&
      typeof parsed.transactionId === "string" &&
      typeof parsed.ownerId === "string" &&
      Number.isSafeInteger(parsed.ownerPid) &&
      (parsed.ownerPid ?? 0) > 0 &&
      typeof parsed.hadTarget === "boolean" &&
      (parsed.mode === "coordinated" || parsed.mode === "standalone") &&
      (parsed.authorityPath === undefined || typeof parsed.authorityPath === "string")
    ) {
      transaction = parsed as AtomicTransactionRecordV2;
    }
  } catch {
    transaction = undefined;
  }

  // marker 只表示事务已经开始，不能证明 writer 已退出。普通 overview/discovery
  // 读取若恢复仍活跃的事务，会抢走 rollback backup，甚至删除 writer 的 staging。
  // 读取活跃事务时返回“已提交的一代”：权威状态未带 transactionId 时读 backup，带 id 后读 target。
  if (activeTransaction) {
    return resolveLiveAtomicReadPath(targetPath, backupPath, activeTransaction);
  }
  if (transaction?.version === 2 && isAtomicTransactionOwnerAlive(transaction)) {
    return resolveLiveAtomicReadPath(targetPath, backupPath, transaction);
  }

  if (transaction?.version === 2 && transaction.mode === "coordinated") {
    const authorityCommitted =
      typeof transaction.authorityPath === "string" &&
      authorityContainsTransactionSync(transaction.authorityPath, transaction.transactionId);
    if (authorityCommitted) {
      if (existsSync(targetPath) && existsSync(backupPath)) {
        rmSync(backupPath, { force: true, recursive: true });
      } else if (!existsSync(targetPath) && existsSync(backupPath)) {
        // 理论上权威状态只会在 target 激活后写入；异常磁盘状态下优先恢复一个完整版本。
        renameSync(backupPath, targetPath);
      }
    } else if (existsSync(backupPath)) {
      rmSync(targetPath, { force: true, recursive: true });
      renameSync(backupPath, targetPath);
    } else if (!transaction.hadTarget) {
      rmSync(targetPath, { force: true, recursive: true });
    }
  } else if (!existsSync(targetPath) && existsSync(backupPath)) {
    renameSync(backupPath, targetPath);
  } else if (existsSync(targetPath) && existsSync(backupPath)) {
    rmSync(backupPath, { force: true, recursive: true });
  }

  if (transaction?.stageName.startsWith(`.${name}.stage-`)) {
    rmSync(join(parent, transaction.stageName), { force: true, recursive: true });
  }
  rmSync(transactionPath, { force: true });
  return targetPath;
}

/**
 * 活跃事务下的只读路径选择：权威状态已带 transactionId→读新 target；否则读 backup。
 * 不删除任何文件，避免读取方干扰正在进行的 writer。
 */
function resolveLiveAtomicReadPath(
  targetPath: string,
  backupPath: string,
  transaction: Pick<
    AtomicTransactionRecordV2,
    "authorityPath" | "hadTarget" | "mode" | "transactionId"
  >,
): string {
  if (
    transaction.mode === "coordinated" &&
    transaction.authorityPath &&
    authorityContainsTransactionSync(transaction.authorityPath, transaction.transactionId)
  ) {
    return targetPath;
  }
  if (existsSync(backupPath)) return backupPath;
  if (transaction.hadTarget && existsSync(targetPath)) return targetPath;
  return backupPath;
}

/**
 * 判断 marker 所属进程是否仍存活：同 pid 时比对进程实例 id；其他 pid 用 signal 0 探测，
 * EPERM 视为存活（进程存在但无权限），ESRCH 才视为已退出。
 */
function isAtomicTransactionOwnerAlive(transaction: AtomicTransactionRecordV2): boolean {
  if (transaction.ownerPid === process.pid) {
    return transaction.ownerId === atomicProcessOwnerId;
  }
  try {
    process.kill(transaction.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 检查权威状态 JSON 中是否出现给定 transactionId（递归遍历对象/数组）。
 * 先对 authorityPath 做恢复读取，解析失败一律视为“未提交”。
 */
function authorityContainsTransactionSync(authorityPath: string, transactionId: string): boolean {
  const readableAuthorityPath = recoverAtomicTargetSync(authorityPath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(readableAuthorityPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (!Array.isArray(current) && "cacheTransactionId" in current) {
      const record = current as { cacheTransactionId?: unknown };
      if (record.cacheTransactionId === transactionId) return true;
    }
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return false;
}

/**
 * 以 `wx` 排他创建事务 marker；已存在说明另一个 writer 持有该 target，立即失败。
 * 这是跨进程互斥的关键：内存 reservation 只能防同进程。
 */
async function writeAtomicTransaction(
  targetPath: string,
  stagePath: string,
  input: Pick<AtomicTransactionRecordV2, "authorityPath" | "hadTarget" | "mode" | "transactionId">,
): Promise<void> {
  const { transactionPath } = getAtomicRecoveryPaths(targetPath);
  const record: AtomicTransactionRecordV2 = {
    ...(input.authorityPath ? { authorityPath: resolve(input.authorityPath) } : {}),
    hadTarget: input.hadTarget,
    mode: input.mode,
    ownerId: atomicProcessOwnerId,
    ownerPid: process.pid,
    stageName: basename(stagePath),
    transactionId: input.transactionId,
    version: 2,
  };
  try {
    // in-process reservation 无法覆盖 CLI/Desktop 等多进程 writer。
    // marker 必须排他创建，避免第二个进程覆写仍存活事务的 owner 与 rollback 快照。
    await writeFile(transactionPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Atomic directory activation is already active: ${targetPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** 激活后立即提交，不暴露 rollback 句柄；用于无需后续状态写入的简单替换。 */
export async function replaceDirectoryAtomically(
  input: ReplaceDirectoryAtomicallyInput,
): Promise<void> {
  const activation = await activateDirectoryAtomically(input);
  await activation.finalize();
}

/**
 * 两阶段目录替换：先在 staging 完整准备，再在提交点后 rename 激活，返回 finalize/rollback。
 *
 * 输入 target 与可选 source/prepare/authority。副作用为 mkdir/cp/rename/rm 与 marker 写入。
 * 失败语义：提交前失败不触碰 target；rename 失败尽力回滚 backup；marker 冲突抛 already
 * active；信号只在提交点前检查（提交后不再取消）。
 */
export async function activateDirectoryAtomically(
  input: ActivateDirectoryAtomicallyInput,
): Promise<AtomicDirectoryActivation> {
  throwIfAborted(input.signal);
  const parent = dirname(input.targetPath);
  const name = basename(input.targetPath);
  await mkdir(parent, { recursive: true });
  recoverAtomicTargetSync(input.targetPath);
  const stagingContainer = await mkdtemp(join(parent, `.${name}.stage-`));
  const stagedPath = join(stagingContainer, "content");
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(input.targetPath);
  const targetKey = resolve(input.targetPath);
  const transactionId = randomUUID();
  let targetMoved = false;
  let committed = false;
  let transactionWritten = false;
  let ownershipActive = false;
  let reservationActive = false;

  try {
    // 固定 backup/marker 只能支持 single writer。允许第二个 activation
    // 覆盖内存 owner，并在失败清理时删除第一个事务的 marker，最终让 rollback 丢失快照。
    if (activeAtomicReservations.has(targetKey) || activeAtomicTargets.has(targetKey)) {
      throw new Error(`Atomic directory activation is already active: ${input.targetPath}`);
    }
    activeAtomicReservations.add(targetKey);
    reservationActive = true;
    // URL/settings marketplace 只有规范化 manifest，没有可复制的 source tree；
    // 仍需复用同一套 authority generation 与 rollback，不能退回直接覆盖 active 文件。
    if (input.sourcePath) {
      await cp(input.sourcePath, stagedPath, { force: true, recursive: true });
    } else {
      await mkdir(stagedPath, { recursive: true });
    }
    await input.prepare?.(stagedPath);
    throwIfAborted(input.signal);

    // 旧流程先 rm target 再 cp，下载后复制失败或取消会把最后可用缓存删掉。
    // staging 已完整准备后才进入提交点；提交点之后完成 rename/状态落盘，不再响应取消。
    const hadTarget = await pathExists(input.targetPath);
    activeAtomicTargets.set(targetKey, {
      ...(input.authorityPath ? { authorityPath: resolve(input.authorityPath) } : {}),
      hadTarget,
      mode: input.authorityPath ? "coordinated" : "standalone",
      transactionId,
    });
    ownershipActive = true;
    await writeAtomicTransaction(input.targetPath, stagingContainer, {
      ...(input.authorityPath ? { authorityPath: input.authorityPath } : {}),
      hadTarget,
      mode: input.authorityPath ? "coordinated" : "standalone",
      transactionId,
    });
    transactionWritten = true;
    if (hadTarget) {
      await rename(input.targetPath, backupPath);
      targetMoved = true;
    }
    try {
      await rename(stagedPath, input.targetPath);
      committed = true;
    } catch (error) {
      if (targetMoved && !(await pathExists(input.targetPath))) {
        try {
          await rename(backupPath, input.targetPath);
          targetMoved = false;
        } catch (rollbackError) {
          throw appendPluginSourceCleanupError(error, rollbackError);
        }
      }
      await cleanupPluginSourceBestEffort(async () => {
        await rm(transactionPath, { force: true });
      });
      transactionWritten = false;
      activeAtomicTargets.delete(targetKey);
      ownershipActive = false;
      throw error;
    }
    await cleanupPluginSourceBestEffort(async () => {
      await rm(stagingContainer, { force: true, recursive: true });
    });
    let settled = false;
    return {
      finalize: async () => {
        if (settled) return;
        settled = true;
        try {
          if (targetMoved) {
            // 权威状态带同一 transactionId 落盘后才删除 backup。
            await cleanupPluginSourceBestEffort(async () => {
              await rm(backupPath, { force: true, recursive: true });
            });
          }
          await cleanupPluginSourceBestEffort(async () => {
            await rm(transactionPath, { force: true });
          });
        } finally {
          activeAtomicTargets.delete(targetKey);
          activeAtomicReservations.delete(targetKey);
          ownershipActive = false;
          reservationActive = false;
        }
      },
      rollback: async () => {
        if (settled) return;
        try {
          // 依赖 closure 的后续插件或 installed state 写入失败时，撤销已激活目录。
          await rm(input.targetPath, { force: true, recursive: true });
          if (targetMoved) await rename(backupPath, input.targetPath);
          await cleanupPluginSourceBestEffort(async () => {
            await rm(transactionPath, { force: true });
          });
          settled = true;
        } finally {
          activeAtomicTargets.delete(targetKey);
          activeAtomicReservations.delete(targetKey);
          ownershipActive = false;
          reservationActive = false;
        }
      },
      transactionId,
    };
  } finally {
    if (!committed) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(stagingContainer, { force: true, recursive: true });
      });
      if (transactionWritten && !targetMoved) {
        await cleanupPluginSourceBestEffort(async () => {
          await rm(transactionPath, { force: true });
        });
      }
      if (ownershipActive) activeAtomicTargets.delete(targetKey);
      if (reservationActive) activeAtomicReservations.delete(targetKey);
    }
  }
}

/**
 * 单文件原子写：先写临时文件，优先直接 rename 覆盖（POSIX 无缺失窗口）；Windows 拒绝
 * 覆盖时改走“确定性 backup + marker”的可恢复路径，失败自动把 backup 换回。
 *
 * 副作用：mkdir/writeFile/rename/rm；提交后删除 backup 与 marker。失败时保留原文件。
 */
export async function writeFileAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const parent = dirname(path);
  const name = basename(path);
  await mkdir(parent, { recursive: true });
  recoverAtomicTargetSync(path);
  const temporaryPath = join(parent, `.${name}.stage-${randomUUID()}`);
  const { backupPath, transactionPath } = getAtomicRecoveryPaths(path);
  const transactionId = randomUUID();
  let targetMoved = false;
  let committed = false;
  try {
    await writeFile(temporaryPath, data);
    try {
      // POSIX 可直接原子替换同目录文件，不制造 target 缺失窗口。
      // Windows 若拒绝覆盖已有目标，再进入带确定性 backup 的可恢复路径。
      await rename(temporaryPath, path);
      committed = true;
      return;
    } catch (replaceError) {
      if (!(await pathExists(path))) throw replaceError;
    }
    await writeAtomicTransaction(path, temporaryPath, {
      hadTarget: true,
      mode: "standalone",
      transactionId,
    });
    await rename(path, backupPath);
    targetMoved = true;
    try {
      await rename(temporaryPath, path);
      committed = true;
    } catch (error) {
      if (targetMoved && !(await pathExists(path))) {
        try {
          await rename(backupPath, path);
          targetMoved = false;
        } catch (rollbackError) {
          throw appendPluginSourceCleanupError(error, rollbackError);
        }
      }
      throw error;
    }
  } finally {
    await cleanupPluginSourceBestEffort(async () => {
      await rm(temporaryPath, { force: true });
    });
    if (committed && targetMoved) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(backupPath, { force: true });
      });
    }
    if (committed || !targetMoved) {
      await cleanupPluginSourceBestEffort(async () => {
        await rm(transactionPath, { force: true });
      });
    }
  }
}

/** 异步存在性探测：access 成功即存在，任何异常都按“不存在”处理。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 取消检查：抛出 name=AbortError 的固定错误，便于上层按标准取消语义识别。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  throw error;
}
