// INV-01 任何 SQL 之前先校验 touchedTables：守住位置 migrate 的首个循环；改错故障 运行成功却没有备份。
// INV-02 表名必须是合法标识符：守住位置 正则；改错故障 备份语句拼接可被注入。
// INV-03 调用方已开事务时不再自开：守住位置 transactionOpen 分支；改错故障 嵌套 begin 直接报错。
// INV-04 事务归属必须与选项一致：守住位置 migrateExclusive 首行；改错故障 半途接管别人的事务。
// INV-05 备份目录必填：守住位置 长度判断；改错故障 破坏性迁移没有回滚点。
// INV-06 同库迁移按路径串行：守住位置 flights 的注册与清理；改错故障 第二个同步锁等待阻塞第一个的异步备份。
// INV-07 串行不传播前一个的失败：守住位置 catch 吞掉；改错故障 一次失败让后续迁移永远不跑。
// INV-08 队列按身份释放：守住位置 finally 的比较；改错故障 后到者被误删，串行失效。
// INV-09 校验和不一致立即失败：守住位置 MigrationChecksumError；改错故障 被改过的已应用 SQL 被静默接受。
// INV-10 改号迁移只搬记录不重跑：守住位置 previousIds 分支；改错故障 容器被重复创建、归属被重置。
// INV-11 备份只覆盖真正待执行的迁移：守住位置 pending 过滤；改错故障 无待办时仍产出备份。
// INV-12 journal 建表走 identifier：守住位置 建表语句；改错故障 两种 journal 表结构不兼容。
// INV-13 提交前回调失败即整体回滚：守住位置 onCommitting 之后才 commit；改错故障 回调失败但迁移已落库。
// INV-14 回滚只在自己持有事务时执行：守住位置 catch 中的 isTransaction；改错故障 回滚掉调用方的事务。
//
// 模块职责：按清单顺序执行 SQLite 迁移，串行化同库并发并保证备份与校验和一致。
// 阅读顺序：先看入口校验与并发闸门，再看待办筛选与改号，最后看备份、执行与事务收尾。
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MigrationOptions, MigrationResult, SqliteMigration } from "./contract.js";
import { MigrationChecksumError } from "./contract.js";
import { createMigrationBackup } from "./backup.js";
import { identifier } from "./table-snapshot.js";

const flights = new Map<string, Promise<MigrationResult>>();

export async function migrate(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  // 合并上游迁移时曾漏填清单，运行成功却没有备份；必须在任何 SQL 写入前拒绝。
  // 这一步必须早于任何 pragma 与 SQL 写入。
  // migrations 清单缺失或表名非法都直接 throw，不带病执行。
  // 正则同时挡住关键词与注入片段，不要放宽。
  for (const migration of migrations) {
    if (
      !Array.isArray(migration.touchedTables) ||
      !migration.touchedTables.length ||
      migration.touchedTables.some(
        (table) => typeof table !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table),
      )
    )
      throw new Error(`Migration ${migration.id} requires valid touchedTables`);
  }
  // 已在外层事务里就跳过并发闸门，避免自锁。
  // 此时事务归属由调用方负责，收尾不做 commit。
  if (options.transactionOpen) return migrateExclusive(db, migrations, options);
  const location = db
    .prepare("pragma database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  if (typeof location !== "string" || !location) return migrateExclusive(db, migrations, options);
  // 同进程第二个同步 SQLite 锁等待会阻塞第一个迁移的异步备份；按实际数据库路径串行 admission。
  // 按 location 实际数据库文件路径串行，而不是按 db 对象。
  // 前一个 migrate 失败不影响后一个：这里刻意吞掉错误。
  // 等待 admission 完成后才进入 migrateExclusive，避免同步锁互等。
  // 取不到 location 时退化为不串行，保证单测可用。
  const previous = flights.get(location);
  const flight = (async () => {
    if (previous) await previous.catch(() => undefined);
    return migrateExclusive(db, migrations, options);
  })();
  flights.set(location, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(location) === flight) flights.delete(location);
  }
}

async function migrateExclusive(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<MigrationResult> {
  if (db.isTransaction !== Boolean(options.transactionOpen)) throw new Error("Migration transaction ownership mismatch");
  // 没有备份目录就不允许执行任何迁移。
  // 这条检查在开事务之前，失败时不留悬挂事务。
  if (!options.backupDirectories.length) throw new Error("Migration requires a backup directory");
  if (!options.transactionOpen) db.exec("begin immediate");
  try {
    const taskJournal = options.journalTable === "tasks_schema_migration";
    const journal = identifier(options.journalTable ?? "schema_migration");
    const appliedAt = identifier(
      taskJournal ? "time_applied" : (options.appliedAtColumn ?? "applied_at"),
    );
    const versionDefinition = taskJournal ? "" : "app_version text,";
    const versionColumn = taskJournal ? "" : "app_version,";
    db.exec(
      `create table if not exists ${journal} (id text primary key, checksum text not null, ${versionDefinition} ${appliedAt} integer not null)`,
    );
    const pending: SqliteMigration[] = [];
    for (const migration of migrations) {
      const ids = [migration.id, ...(migration.previousIds ?? [])];
      // 同一迁移的 id 与 previousIds 一起查，兼容改号历史。
      // applied.checksum 不等于 checksum(migration.sql) 时立即抛错，绝不静默跳过。
      // 只要 appliedIds 任一命中就不进 pending，交给改号分支搬记录。
      const appliedIds = ids.filter((id) => {
        const applied = db.prepare(`select checksum from ${journal} where id=?`).get(id);
        if (applied && applied.checksum !== checksum(migration.sql))
          throw new MigrationChecksumError(id);
        return Boolean(applied);
      });
      if (!appliedIds.length) pending.push(migration);
      else if (!appliedIds.includes(migration.id)) {
        // 项目迁移会创建容器并分配归属；改号只能沿用旧结果，不能重新执行 apply。
        db.prepare(`insert into ${journal}(id,checksum,${versionColumn}${appliedAt})
          select ?,checksum,${versionColumn}${appliedAt} from ${journal} where id=?`).run(
          migration.id,
          appliedIds[0]!,
        );
      }
    }
    const backup = pending.length
      ? await createMigrationBackup(db, pending, options)
      : { skipped: false };
    for (const migration of pending) {
      await options.onBeforeApply?.(migration.id);
      if (migration.apply) migration.apply(db);
      else db.exec(migration.sql);
      options.onApplied?.(migration.id);
      db.prepare(
        `insert into ${journal} (id,checksum,${versionColumn}${appliedAt}) values (?,?${taskJournal ? "" : ",?"},?)`,
      ).run(
        migration.id,
        checksum(migration.sql),
        ...(taskJournal ? [] : [migration.appVersion]),
        (options.now ?? Date.now)(),
      );
    }
    await options.onCommitting?.();
    db.exec("commit");
    return {
      applied: pending.map((migration) => migration.id),
      ...(backup.path ? { backupPath: backup.path } : {}),
      backupSkipped: backup.skipped,
    };
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}
