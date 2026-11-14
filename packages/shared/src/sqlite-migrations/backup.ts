// INV-01 空表不建备份：守住位置 全表列数为零判断；改错故障 首次安装制造空备份。
// INV-02 保留份数固定：守住位置 常量；改错故障 备份目录无限膨胀。
// INV-03 空间估算含余量：守住位置 余量常量；改错故障 写到一半磁盘满。
// INV-04 估算按字节加倍：守住位置 末尾乘二；改错故障 压缩后仍可能超限。
// INV-05 二进制按字节长度：守住位置 类型判断；改错故障 图片列被低估。
// INV-06 候选目录去重：守住位置 集合；改错故障 同一目录被尝试两次。
// INV-07 主目录优先：守住位置 生成顺序；改错故障 备份落到外接盘。
// INV-08 权限最小：守住位置 目录与文件模式；改错故障 他人可读数据库副本。
// INV-09 备份库单事务：守住位置 提交与回滚；改错故障 半截表结构留下。
// INV-10 失败目录即时清理：守住位置 捕获分支；改错故障 残留半成品目录。
// INV-11 非空间错误继续抛：守住位置 异常过滤；改错故障 真实缺陷被吞掉。
// INV-12 不可用卷换下一个：守住位置 跳过分支；改错故障 只读盘让迁移直接失败。
// INV-13 全部失败仍写元数据：守住位置 兜底写入；改错故障 用户不知道备份被跳过。
// INV-14 跳过原因写进元数据：守住位置 字段赋值；改错故障 启动提示没有依据。
// INV-15 回调通知跳过：守住位置 调用点；改错故障 上层无法提示。
// INV-16 只清理自己的目录：守住位置 前缀过滤；改错故障 误删用户文件夹。
// INV-17 缺元数据不清理：守住位置 读取判断；改错故障 半成品被当垃圾删除。
// INV-18 当前目录不清理：守住位置 路径比较；改错故障 刚写好的备份被删。
//
// 模块职责：迁移前的表快照备份、空间检查与保留份数裁剪。
// 状态所有权：无长期状态，目录与回调由调用方注入。
// 阅读顺序：先看备份主流程，再看空间估算，最后看裁剪与目录枚举。
import { discoverBackupVolumes } from "./backup-volumes.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MigrationBackup, MigrationOptions, SqliteMigration } from "./contract.js";
import { identifier, insertSnapshot, snapshotTable, type TableSnapshot } from "./table-snapshot.js";

const BACKUPS_TO_KEEP = 2;
const SPACE_MARGIN_BYTES = 1024 * 1024;
export const BACKUP_DATABASE_FILE = "tables.sqlite";

// createMigrationBackup 先把涉及表去重再快照。
// tables.size === 0 时直接跳过。
// metadata 不含行数据，只有表名与行数。
// 候选目录按 writable 优先级逐个尝试。
// ENOSPC 时换下一个目录。
export async function createMigrationBackup(
  db: DatabaseSync,
  migrations: readonly SqliteMigration[],
  options: MigrationOptions,
): Promise<{ path?: string; skipped: boolean }> {
  const tables = [...new Set(migrations.flatMap((migration) => migration.touchedTables))].map(
    (table) => snapshotTable(db, table),
  );
  // 新库没有待保护的历史表；不为每个内存测试或首次安装制造空备份。
  if (tables.every((table) => table.columns.length === 0)) return { skipped: false };
  const metadata: MigrationBackup = {
    version: 1,
    database: options.database,
    ...(options.journalTable ? { journalTable: options.journalTable } : {}),
    migrations: migrations.map((migration) => migration.id),
    tables: tables.map(({ values: _values, ...table }) => table),
  };
  const estimate = estimateBytes(tables);
  const prefix = `${identifier(options.database).slice(1, -1)}-`;
  let skippedPath: string | undefined;
  for await (const directory of candidateDirectories(options)) {
    let path: string | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const space = await statfs(directory, { bigint: true });
      if (space.bavail * space.bsize < BigInt(estimate)) {
        skippedPath ??= directory;
        continue;
      }
      path = join(directory, `${prefix}${(options.now ?? Date.now)()}-${randomUUID()}`);
      await mkdir(path, { mode: 0o700 });
      const backup = new DatabaseSync(join(path, BACKUP_DATABASE_FILE));
      try {
        backup.exec("begin");
        for (const table of tables) {
          if (!table.columns.length) continue;
          backup.exec(
            `create table ${identifier(table.name)} (${table.columns.map(identifier).join(",")})`,
          );
          insertSnapshot(backup, table);
        }
        backup.exec("commit");
      } finally {
        backup.close();
      }
      await writeFile(join(path, "backup.json"), JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });
      await pruneBackups(directory, prefix, path);
      return { path, skipped: false };
    } catch (error) {
      if (path) await rm(path, { recursive: true, force: true });
      if (!isUnavailableVolume(error)) throw error;
      skippedPath ??= directory;
    }
  }
  metadata.skipped = "insufficient-space";
  // 无空间不是数据迁移失败；保留显式结果，让启动入口提示用户，不能静默略过。
  if (skippedPath) {
    const path = join(skippedPath, `${prefix}${(options.now ?? Date.now)()}-${randomUUID()}`);
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(join(path, "backup.json"), JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      if (!isUnavailableVolume(error)) throw error;
    }
  }
  options.onBackupSkipped?.(metadata);
  return { skipped: true };
}

// estimateBytes 先计入 SPACE_MARGIN_BYTES。
// 每个 cell 至少按 32 字节估算。
// 二进制按 Buffer.byteLength 真实长度。
// 其余按 UTF-8 字节数。
// 总量乘 2 留出 SQLite 页对齐的浮动空间。
function estimateBytes(tables: TableSnapshot[]): number {
  return (
    SPACE_MARGIN_BYTES +
    tables.reduce(
      (total, table) =>
        total +
        table.values.reduce(
          (sum, row) =>
            sum +
            row.reduce<number>(
              (bytes, value) =>
                bytes +
                (value instanceof Uint8Array
                  ? value.byteLength
                  : Buffer.byteLength(String(value))) +
                32,
              0,
            ),
          0,
        ),
      0,
    ) *
      2
  );
}

// isUnavailableVolume 只认 object 形态的错误。
// 错误对象必须带 code 字段。
// ENOSPC 与 EACCES 归为不可用。
// 其他错误原样 throw。
// 不吞掉 TypeError 之类的程序缺陷。
function isUnavailableVolume(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["ENOSPC", "EACCES", "EPERM", "EROFS", "EEXIST", "ENOTDIR"].includes(String(error.code))
  );
}

// pruneBackups 只扫描同前缀目录。
// 无 metadata 的目录跳过。
// BACKUPS_TO_KEEP 的保留额度含当前目录。
// 超出额度的目录用 rmSync 递归删除。
// pruneBackups 只删目录，不触碰普通文件。
async function pruneBackups(directory: string, prefix: string, current: string): Promise<void> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  let kept = 1;
  for (const name of names) {
    const path = join(directory, name);
    if (path === current) continue;
    // 只消费本模块生成且有完成元数据的目录；不清理用户文件或半成品。
    const metadata = await readFile(join(path, "backup.json"), "utf8").catch(() => null);
    if (!metadata) continue;
    if (kept++ < BACKUPS_TO_KEEP) continue;
    await rm(path, { recursive: true, force: true });
  }
}

async function* candidateDirectories(options: MigrationOptions): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (const directory of options.backupDirectories) {
    seen.add(directory);
    yield directory;
  }
  const fallback = await (options.fallbackBackupDirectories ?? discoverBackupVolumes)();
  for (const directory of fallback)
    if (!seen.has(directory)) {
      seen.add(directory);
      yield directory;
    }
}
