// 任务库启动态缓存：migrated/prepared 记录本进程内已迁移/已准备的库路径，避免重复执行建表与迁移。
// 该缓存仅是进程内快速路径，最终判定仍以库内 migration 记录为准。
import type { DatabaseSync } from "node:sqlite";
import { areTasksDatabaseMigrationsApplied } from "#src/session/tasksDatabase/migrations.js";
// 仅当前进程的启动交接凭据；不落盘、不代替 SQLite 账本，不影响不同路径的新库。
// 两个 Set 都以调用方传入的 path 原串为键：同一库经不同分隔符或大小写传入会被当成两个库，调用方必须先归一化路径。
const migrated = new Set<string>();
const prepared = new Set<string>();
// 迁移完成只标记 migrated；不代表连接已就绪，调用方不能据此跳过 open。
export function markTasksStorageMigrated(path: string): void {
  // migrated.add 只写进程内 Set，进程重启后标记消失，冷启动重跑迁移必须保持幂等。
  // 标记不代表连接可用：调用方仍必须 open 并校验 areTasksDatabaseMigrationsApplied，不能凭 migrated 直接发查询。
  migrated.add(path);
}
// 准备完成同时写入两个集合：prepared 必然蕴含 migrated。
export function markTasksStoragePrepared(path: string): void {
  // 先写 migrated 再写 prepared，两次 add 之间抛错也不会留下 prepared 命中而 migrated 缺失。
  // prepared 只是本进程的快速路径：进程重启后 Set 为空，冷启动必须重新跑建表与迁移，不能把它当跨进程缓存。
  migrated.add(path);
  prepared.add(path);
}
// 双重判定：进程缓存命中且库内迁移记录齐全才算已迁移，避免快照回滚后误判。
export function isTasksStorageMigrated(path: string, db: DatabaseSync): boolean {
  // 缓存命中只是快速路径，仍必须读 schema_migrations 才能确认迁移记录齐全。
  return migrated.has(path) && areTasksDatabaseMigrationsApplied(db);
}
export function isTasksStoragePrepared(path: string, db: DatabaseSync): boolean {
  // prepared 命中后仍走同一条库内校验，建表语句缺失时返回 false 让调用方重建。
  return prepared.has(path) && areTasksDatabaseMigrationsApplied(db);
}
