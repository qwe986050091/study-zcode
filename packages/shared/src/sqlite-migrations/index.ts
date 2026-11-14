/**
 * ============================================================================
 * shared/sqlite-migrations/index.ts —— 可复用 SQLite 迁移机制的公开出口
 * ============================================================================
 *
 * 【定位】与具体业务表无关的迁移基础设施：
 *   - migrate：按 id 顺序执行、校验 checksum、必要时备份；
 *   - restore：从备份恢复；
 *   - legacy：旧版 schema_migration 表与 identity migration 的兼容入口。
 *
 * 【为什么放在 shared】CLI session DB 与 desktop 侧存储都需要同一套
 *   "只增不改 + checksum fail closed + 备份"语义；各端只提供自己的
 *   SQLITE_MIGRATIONS 列表，不复制执行器。
 *
 * 【契约】MigrationChecksumError 是显式失败信号：已发布迁移被修改时必须
 *   让启动失败，不能自动重写 checksum 或跳过迁移。
 * ============================================================================
 */
import type { SqliteMigrationsContract } from "./contract.js";
import { migrate } from "./runner.js";
import { restore } from "./restore.js";

export type {
  MigrationBackup,
  MigrationOptions,
  MigrationResult,
  SqliteMigration,
  SqliteMigrationsContract,
} from "./contract.js";
export {
  MigrationChecksumError,
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "./contract.js";
export const sqliteMigrations: SqliteMigrationsContract = { migrate, restore };

export {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
  SqliteSchemaMigrationChecksumError,
  SESSION_DATABASE_IDENTITY_MIGRATION,
  runSessionDatabaseIdentityMigration,
} from "./legacy.js";
export type { SqliteSchemaMigration } from "./legacy.js";
