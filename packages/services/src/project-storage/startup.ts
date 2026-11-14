// 任务索引存储的启动准备：打开 SQLite、等待写锁、执行迁移，再做既有 Repo 修复。
// 与旧初始化路径共享迁移 SQL 和修复逻辑，差异只在于这里的锁等待是异步的，
// 因而可以在等待期间通过 onProgress 向宿主报告阶段，而不是阻塞整个进程。
// 本模块不负责调度和重试，调用方需保证同一数据库只有一个启动准备在跑。
import type { AppSettings, DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";
import {
  runTasksDatabaseMigrations,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

export type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
// 锁等待上限取一小时：首次启动可能遇到大规模迁移，超时过短会让用户反复失败。
// 该值同时传给各 Repo，保证迁移与后续修复共享同一等待口径。
const LOCK_WAIT_MS = 60 * 60_000;

/** 由 Host Worker 调用，SQL 和迁移后修复与旧 Repo 共用，只有获取写锁异步等待。 */
// 该函数是 Host Worker 启动任务索引的唯一入口：先迁移，再做既有修复，最后落标记。
// settings 只用于构造 Repo，不参与迁移决策；缺省时沿用各 Repo 的兼容默认值。
// 函数本身不吞异常：所有失败都会抛出，由调用方决定是否加锁重试或降级启动。
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
  settings?: Pick<
    AppSettings,
    "lastWorkspaceSession" | "recentProjects" | "sourceServers" | "connectionProfiles"
  >,
): Promise<void> {
  // 回调拿到的是当时事实，不共享后续执行会继续递增的内部对象。
// 进度回调是单向的，重复发布相同阶段无副作用，调用方可据此刷新 UI。
// migration 缺省时只上报阶段，不构造空对象，避免消费方误判迁移未开始。
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
// 同步连接从打开到 finally 关闭之间不跨 await 释放，保证同一时刻只有一个写者。
// 打开失败会直接抛出，无需在此处理，Worker 会按启动失败上报。
  const db = new DatabaseSync(path);
  let failure: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
// 统一的重试入口：只重试 SQLITE_BUSY（errcode 低字节为 5），其它错误立即上抛，
// 避免把权限、损坏等真实故障拖到锁超时后才暴露。
// 首次遇到锁才发布 waiting_for_lock，防止误报正常路径的瞬时竞争。
    const acquire = async (operation: string | (() => void)) => {
      // 预检前后可分别遇锁；确认迁移后的等待需要重新发布可见状态。
      let waiting = false;
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Task storage lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          if (!waiting) {
            waiting = true;
            report("waiting_for_lock", migration);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
// WAL 也放在重试循环里，因为切换模式需要短暂排他锁，可能与其他进程冲突。
// busy_timeout 设得较短，真正的等待由 acquire 的退避循环承担并上报进度。
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire(() => {
      migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
    });
    report("checking", migration);
// BEGIN IMMEDIATE 立即拿写锁：迁移期间不允许其它进程写入旧库。
// 事务边界由这里开启、由迁移函数内部提交，失败时依赖连接关闭回滚。
    await acquire("BEGIN IMMEDIATE");
    await runTasksDatabaseMigrations(db, { transactionOpen: true, migration, onProgress: report });
    // COMMIT 已成功，先发布事实；后续 close 失败不能把已提交误报为未提交。
    report("maintaining", migration);
  } catch (error) {
    failure = error;
    // 失败事实随原异常交给 Worker，不倒退发布 checking/migrating，也不覆盖首因。
    if (migration && error && typeof error === "object") {
      try {
// 把迁移事实挂到原始异常上，Worker 侧无需再读库即可展示进度；
// 拷贝一份而非引用，防止后续字段变化污染已抛出的错误对象。
        Object.assign(error, { startupMigration: { ...migration } });
      } catch {
        /* 不可扩展异常仍保留原错误。 */
      }
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
// 迁移事务已提交且连接已关闭，此时才落迁移标记，避免把未提交状态持久化。
// 标记完成后即使后续 Repo 修复失败，下次启动也不会重复执行迁移。
  markTasksStorageMigrated(path);
// 与旧初始化路径使用同一组 Repo 和同一锁等待上限，保证迁移前后修复行为一致。
// 这些实例只在本次准备流程内使用，结束后立即 close，不长期持有连接。
  const repos = [
    new TaskIndexRepo(settings, undefined, path, LOCK_WAIT_MS),
    new AutomationRepo(path, LOCK_WAIT_MS),
    new OffPeakTaskRepo(path, LOCK_WAIT_MS),
  ];
  let preparationFailure: unknown;
  try {
    // 这些是原本就在初始化时执行的修复，不创建新的迁移或改变已有事务边界。
// 逐个串行执行：三者共用同一个数据库文件，并发修复会互相争锁。
// 任一失败即中止后续修复，并把首因抛给 Host Worker 决定重试策略。
    for (const repo of repos) await repo.ensureReady();
  } catch (error) {
    preparationFailure = error;
    throw error;
  } finally {
    let closeFailure: unknown;
    for (const repo of repos) {
      try {
        repo.close({ throwOnError: true });
      } catch (error) {
        closeFailure ??= error;
      }
    }
    if (!preparationFailure && closeFailure) throw closeFailure;
  }
// 全部 Repo 就绪后才写 prepared 标记，标记一旦存在即代表本次启动可以跳过修复。
// 标记写在 close 之后，防止修复失败却被误认为已准备完成。
  markTasksStoragePrepared(path);
  report("ready", migration);
}
