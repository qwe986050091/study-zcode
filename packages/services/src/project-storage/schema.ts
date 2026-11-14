// 项目与会话（task）相关的 SQLite schema 定义与增量迁移入口，供本地库初始化时调用。
// 表结构全部使用 IF NOT EXISTS / ALTER TABLE ADD COLUMN，保证老库升级可重复执行且幂等。
// 该模块只负责结构，不含业务读写；调用方需自行保证单连接串行执行，SQLite 不支持并发 DDL。
import type { DatabaseSync } from "node:sqlite";

// hosts 是不落远端身份的本地投影，projects/project_roots 用 host_id 关联，删除靠外键级联。
// projects 的唯一索引带 deleted=0 条件：软删后同名项目可重新创建，历史行不阻塞。
// remote_project_entries 缓存远端项目快照，remote_project_id 可为空（尚未完成首次同步）。
// 所有时间字段用 INTEGER 毫秒时间戳，与任务表保持同一口径，避免跨表比较时做类型转换。
export const PROJECT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hosts (
 host_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_json TEXT, membership_id TEXT,
 position INTEGER NOT NULL DEFAULT 0, last_connection_status TEXT, last_connection_error TEXT, last_opened_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (
 project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id), name TEXT NOT NULL,
 name_overridden INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
 pinned_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_roots (
 project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
 root_path TEXT NOT NULL, position INTEGER NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project_id,root_path));
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_host_name ON projects(host_id,name) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS remote_project_entries (
 entry_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
 remote_project_id TEXT, cached_name TEXT NOT NULL, cached_roots_json TEXT NOT NULL DEFAULT '[]',
 legacy_workspace_json TEXT, last_synced_at INTEGER, UNIQUE(host_id,remote_project_id));
`;

// tasks 表由任务模块建表，这里只补项目维度列，避免两处同时定义同名表产生结构分歧。
// 值只写 SQLite 类型声明（可含 NOT NULL/DEFAULT），迁移时直接拼进 ADD COLUMN。
export const TASK_PROJECT_COLUMNS: Readonly<Record<string, string>> = {
  host_id: "TEXT",
  root_path: "TEXT",
  project_id: "TEXT",
  execution_directories: "TEXT",
  sort_order: "INTEGER",
  cli_title: "TEXT",
  handoff_pending: "INTEGER NOT NULL DEFAULT 0",
  cli_title_source: "TEXT",
  cli_created_at: "INTEGER",
  cli_updated_at: "INTEGER",
  cli_last_outcome: "TEXT",
  cli_deleted: "INTEGER",
};

// 迁移清单声明依赖项目上下文的表集合，供上层判断哪些表需要在本轮补列。
// 顺序对外无意义，hosts/projects 在 remote_project_entries 之前仅便于人工阅读。
export const PROJECT_MIGRATION_TABLES = [
  "tasks",
  "task_groups",
  "task_group_members",
  "task_group_view_node_orders",
  "task_group_workspace_bootstraps",
  "automations",
  "off_peak_tasks",
  "hosts",
  "projects",
  "project_roots",
  "remote_project_entries",
] as const;

// sqlite_master 查询是判断表存在的标准方式，不依赖 PRAGMA 的返回结构，兼容性好。
// 用于迁移前短路：对不存在的表执行 ALTER TABLE 会直接抛错。
export function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}

// 幂等补列：先查现有列，只对缺失列执行 ADD COLUMN，重复调用不产生副作用。
// 表不存在时直接返回，把「是否建表」的决定权留给调用方的 schema 脚本。
// SQLite 不支持事务外并发 DDL，这里假设同一时刻只有单个连接在跑迁移。
function ensureColumns(
  db: DatabaseSync,
  table: string,
  columns: Readonly<Record<string, string>>,
): void {
// 提前返回而非抛错：该函数被多次调用，缺表属于合法场景（例如尚未初始化的可选模块）。
  if (!tableExists(db, table)) return;
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
// 列名与类型来自常量映射，不接收外部输入，因此可直接拼接进 SQL，无需参数化。
  for (const [column, definition] of Object.entries(columns)) {
    if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// 先执行建表/索引脚本，再补历史库缺失的列，保证新库与升级库最终结构一致。
// 补列顺序按依赖排列：hosts 先于 tasks，automations/off_peak_tasks 依赖 project_id。
// 函数整体不开启显式事务，依赖调用方在初始化阶段串行执行。
export function addProjectSchema(db: DatabaseSync): void {
// 建表脚本先于补列执行，确保后续 ALTER TABLE 的目标表一定存在。
  db.exec(PROJECT_SCHEMA_SQL);
  ensureColumns(db, "hosts", { membership_id: "TEXT" });
  ensureColumns(db, "tasks", TASK_PROJECT_COLUMNS);
// 定时任务与低谷任务此前按全局维护，这里补项目归属列以支持按项目过滤。
// additional_directories 存 JSON 数组文本，列类型保持 TEXT，由业务层负责序列化。
  for (const table of ["automations", "off_peak_tasks"]) {
    ensureColumns(db, table, {
      project_id: "TEXT",
      host_id: "TEXT",
      additional_directories: "TEXT",
    });
  }
  if (tableExists(db, "tasks"))
// 仅在 tasks 已存在时建索引，任务表由其他模块负责创建，这里不主动建表。
// 部分索引带 deleted=0 条件，使软删任务不进入项目列表的扫描范围。
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id,archived,cli_updated_at DESC) WHERE deleted=0",
    );
}
