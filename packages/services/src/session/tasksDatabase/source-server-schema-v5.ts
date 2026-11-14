// Source Server 工作区 schema 接管（迁移 0005）：把历史 ledger/conflicts 表升级到 v2 结构。
// 职责链固定为 hasTable/hasColumn 探测 → 暂存表重建 → INSERT ... SELECT 搬运 → 版本记账。
// 所有 SQL 常量都是 checksum 输入，发布后不可修改。
// 本文件不依赖上层 Repo，可被启动期的库初始化单独调用。
import type { DatabaseSync } from "node:sqlite";

// 升级路径只能向前：已发布版本的 SQL 文本与转换语义都视作不可变契约。
// 读旧库时先探测再决策，缺表/缺列都走「补结构」而不是直接失败。
// 表存在性探测：sqlite_master 是唯一权威来源，不依赖 PRAGMA 的返回顺序。
function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
  );
}
// 列存在性探测：先确认表存在，再查 PRAGMA table_info，避免对缺表报错。
// 列探测必须容忍表不存在：旧库可能只建了其中一张表。
// 返回 false 时调用方按“需要补列/需要重建”处理。
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (
    hasTable(db, table) &&
    db
// table 只来自本文件常量与 hasTable 白名单，不是外部输入，所以 PRAGMA table_info(${table}) 可安全拼接。
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column)
  );
}

// 冻结声明：以下常量参与 0005 的 checksum，改动任意字符都会被视为新迁移。
// 旧版本库的转换语义只能增强兼容性，不能改变已发布数据的解释方式。
// 冻结旧 v1/v2/v3 接管规则；新变更必须追加 migration，不修改这里的 SQL 或转换语义版本。
// v2→v3 的唯一结构变化：ledger 增加 session_db_generation 列。
const ADD_SESSION_GENERATION_COLUMN =
  "ALTER TABLE workspace_migration_ledger ADD COLUMN session_db_generation TEXT";
// 基础表：路径别名映射与 schema 版本账本。别名表以规范化路径为主键。
// 这两张表是版本分派的基础，必须在读取版本号之前创建。
// 版本表只保存 schema 名称与整数版本，不保存迁移细节。
const ALIAS_AND_LEGACY_VERSION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS workspace_alias (
        path TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_migration_schema_version (
        schema_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;

// 状态索引服务按 status + path 查询未完成迁移。
const LEDGER_STATUS_INDEX = `
        CREATE INDEX IF NOT EXISTS idx_workspace_migration_ledger_status_path
        ON workspace_migration_ledger(status, path);
      `;

// v2 暂存表：先建新表再搬运数据，最后 rename 发布，失败时旧表仍完整。
// status/phase 使用 CHECK 约束，非法状态在写入阶段即被拒绝。
// conflicts 的主键包含 source_key，同一冲突键可来自多个来源路径。
// conflict_kind 区分任务身份冲突与配置文件冲突。
// 暂存表名带 _v2 后缀，发布阶段才改名为正式表。
// task_backup_path 必填：迁移前必须先有任务库备份。
// 暂存表的列是旧 ledger 与新需求的并集，允许旧库缺列。
// 搬运 SQL 用 CASE 与条件列名补齐差异，避免多套 INSERT。
const STAGED_LEDGER_AND_CONFLICT_SCHEMA = `
      CREATE TABLE workspace_migration_ledger_v2 (
        migration_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        variant_keys_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'abandoned')),
        phase TEXT CHECK(phase IN ('preflight', 'backups-created', 'task-db-merged', 'session-db-merged', 'config-dirs-merged', 'alias-published', 'completed')),
        task_backup_path TEXT NOT NULL,
        session_backup_path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        abandoned_at INTEGER,
        abandoned_trigger TEXT,
        abandoned_activity_json TEXT,
        session_db_generation TEXT
      );
      CREATE TABLE workspace_migration_conflicts_v2 (
        migration_id TEXT NOT NULL,
        path TEXT NOT NULL,
        conflict_kind TEXT NOT NULL CHECK(conflict_kind IN ('task-identity', 'config-file')),
        conflict_key TEXT NOT NULL,
        task_id TEXT,
        relative_path TEXT,
        source_key TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (migration_id, conflict_kind, conflict_key, source_key)
      );
    `;

// 发布阶段：rename 暂存表并重建状态索引，改名后旧名不再存在。
const PUBLISH_LEDGER_AND_CONFLICT_SCHEMA = `
      ALTER TABLE workspace_migration_ledger_v2 RENAME TO workspace_migration_ledger;
      ALTER TABLE workspace_migration_conflicts_v2 RENAME TO workspace_migration_conflicts;
      CREATE INDEX idx_workspace_migration_ledger_status_path
      ON workspace_migration_ledger(status, path);
    `;

// 结构自检：WHERE 0 查询不返回数据，只让 SQLite 校验每张表的列是否齐全。
const VERIFY_CURRENT_SCHEMA = `
  SELECT path, canonical_key, created_at, updated_at FROM workspace_alias WHERE 0;
  SELECT migration_id, path, canonical_key, variant_keys_json, status, phase,
    task_backup_path, session_backup_path, error, created_at, updated_at,
    abandoned_at, abandoned_trigger, abandoned_activity_json, session_db_generation
    FROM workspace_migration_ledger WHERE 0;
  SELECT migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
    source_key, canonical_key, reason, created_at FROM workspace_migration_conflicts WHERE 0;
`;

// checksum 输入按固定顺序列出全部 SQL 与版本标记，数组顺序即语义。
// 自检 SQL 放在输入首位，结构变化会直接改变 checksum。
// 末尾的版本标记用于表达纯数据语义变化（无 DDL 改动）。
export const SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT = [
  VERIFY_CURRENT_SCHEMA,
  ALIAS_AND_LEGACY_VERSION_SCHEMA,
  LEDGER_STATUS_INDEX,
  STAGED_LEDGER_AND_CONFLICT_SCHEMA,
  PUBLISH_LEDGER_AND_CONFLICT_SCHEMA,
  ADD_SESSION_GENERATION_COLUMN,
  "legacy-ledger-conflicts-copy-and-v3-adoption-v1",
];

// adoptSourceServerWorkspaceSchema 按 versionRow.version 分派：等于 3 只补索引，等于 2 先补列再升版本，其余走重建。
// 高于 v3 的版本直接报错，防止旧二进制把未来 schema 降级。
// 每个分支返回前都执行 VERIFY_CURRENT_SCHEMA，避免升级成功但结构残缺。
// 本函数必须在库级事务内调用：重建失败时需整体回滚。
// 分支顺序固定为 高版本拒绝 → v3 → v2 → 旧版重建。
export function adoptSourceServerWorkspaceSchema(db: DatabaseSync): void {
// 先确保基础表存在，后续版本查询才有表可读。
  db.exec(ALIAS_AND_LEGACY_VERSION_SCHEMA);
// 版本记录以 schema_name 为键，缺失表示这是首次接管。
// 版本查询只读一行；schema_name 是固定常量。
  const versionRow = db
    .prepare(
      "SELECT version FROM workspace_migration_schema_version WHERE schema_name = 'workspace-migration'",
    )
    .get() as { version: number } | undefined;
// 未来版本必须 fail-closed，不能尝试猜测结构。
  if (versionRow && versionRow.version > 3) {
    // 旧二进制不能把未来 schema 静默重建并降回 v2。
    throw new Error(
      `Unsupported newer Source Server migration schema version: ${versionRow.version}`,
    );
  }
// v3 已是最新：只补状态索引（幂等）并自检。
  if (versionRow?.version === 3) {
    db.exec(LEDGER_STATUS_INDEX);
    db.exec(VERIFY_CURRENT_SCHEMA);
    return;
  }
// v2→v3：补 session_db_generation 列后升级版本号。
// version 2 分支先调 ADD_SESSION_GENERATION_COLUMN，再写 version = 3，避免只升版本号而漏列。
  if (versionRow?.version === 2) {
    if (!hasColumn(db, "workspace_migration_ledger", "session_db_generation")) {
      db.exec(ADD_SESSION_GENERATION_COLUMN);
    }
    db.prepare(
// 版本号与时间戳同一条 UPDATE 写入，避免出现版本已升但时间未更新的中间态。
      "UPDATE workspace_migration_schema_version SET version = 3, updated_at = ? WHERE schema_name = 'workspace-migration'",
    ).run(Date.now());
    db.exec(LEDGER_STATUS_INDEX);
    db.exec(VERIFY_CURRENT_SCHEMA);
    return;
  }

// 旧库探测先按表调 hasTable 再按列调 hasColumn，兼容只升级了一半的历史库。
// ledgerExists 与 conflictsExist 可能同时为 false，必须先探测完再决定 INSERT ... SELECT 的范围。
// 旧库列名差异全部在这里一次性收集，后续不再重复 PRAGMA。
  const ledgerExists = hasTable(db, "workspace_migration_ledger");
  const conflictsExist = hasTable(db, "workspace_migration_conflicts");
  const legacyHasPhase = hasColumn(db, "workspace_migration_ledger", "phase");
  const legacyHasAbandonedAt = hasColumn(db, "workspace_migration_ledger", "abandoned_at");
  const legacyHasAbandonedTrigger = hasColumn(
    db,
    "workspace_migration_ledger",
    "abandoned_trigger",
  );
  const legacyHasAbandonedActivity = hasColumn(
    db,
    "workspace_migration_ledger",
    "abandoned_activity_json",
  );
  // 旧版本标记缺失不等于代际缺失；重建时必须保留活动计划已冻结的 generation。
  const legacyHasSessionGeneration = hasColumn(
    db,
    "workspace_migration_ledger",
    "session_db_generation",
  );
  const conflictsHaveKind = hasColumn(db, "workspace_migration_conflicts", "conflict_kind");
  const conflictsHaveKey = hasColumn(db, "workspace_migration_conflicts", "conflict_key");
  const conflictsHaveRelativePath = hasColumn(db, "workspace_migration_conflicts", "relative_path");

// 先建暂存表；此时尚未触碰旧表，失败可直接中止。
  db.exec(STAGED_LEDGER_AND_CONFLICT_SCHEMA);
  if (ledgerExists) {
// phase 表达式按旧库是否已有该列选择不同 CASE，缺失时由 status 推导。
    const phaseExpression = legacyHasPhase
      ? `CASE
             WHEN status = 'completed' THEN 'completed'
             WHEN phase IS NOT NULL THEN phase
             WHEN status = 'failed' AND error IN (
               'workspace-task-identity-conflict', 'workspace-config-file-conflict'
             ) THEN NULL
             ELSE 'preflight'
           END`
      : `CASE
             WHEN status = 'completed' THEN 'completed'
             WHEN status = 'failed' AND error IN (
               'workspace-task-identity-conflict', 'workspace-config-file-conflict'
             ) THEN NULL
             ELSE 'preflight'
           END`;
    // 显式列名搬运：旧表缺失的列按 phaseExpression / NULL 补齐，不依赖 SELECT *。
    // session_db_generation 必须尽量保留，活动计划靠它定位会话库代次，缺失时写 NULL。
    db.exec(`
        INSERT INTO workspace_migration_ledger_v2 (
          migration_id, path, canonical_key, variant_keys_json, status, phase,
          task_backup_path, session_backup_path, error, created_at, updated_at,
          abandoned_at, abandoned_trigger, abandoned_activity_json,
          session_db_generation
        )
        SELECT migration_id, path, canonical_key, variant_keys_json, status,
          ${phaseExpression}, task_backup_path, session_backup_path, error,
          created_at, updated_at,
          ${legacyHasAbandonedAt ? "abandoned_at" : "NULL"},
          ${legacyHasAbandonedTrigger ? "abandoned_trigger" : "NULL"},
          ${legacyHasAbandonedActivity ? "abandoned_activity_json" : "NULL"},
          ${legacyHasSessionGeneration ? "session_db_generation" : "NULL"}
        FROM workspace_migration_ledger
      `);
  }
// 冲突表同样先搬入暂存表，缺少的列用旧版默认值补齐。
  if (conflictsExist) {
    // 旧版缺 conflict_kind 时按 'task-identity' 解释；缺 relative_path 时写 NULL，不伪造配置路径。
    // 两列都通过 conflictsHave* 探测动态选源，避免引用旧表不存在的列。
    db.exec(`
        INSERT INTO workspace_migration_conflicts_v2 (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        )
        SELECT migration_id, path,
          ${conflictsHaveKind ? "conflict_kind" : "'task-identity'"},
          ${conflictsHaveKey ? "conflict_key" : "task_id"},
          task_id,
          ${conflictsHaveRelativePath ? "relative_path" : "NULL"},
          source_key, canonical_key, reason, created_at
        FROM workspace_migration_conflicts
      `);
  }
// 搬运完成后删除旧表，随后 rename 才能使用正式表名。
  if (conflictsExist) db.exec("DROP TABLE workspace_migration_conflicts");
// 两张旧表都删除后才执行发布，避免 rename 撞名。
  if (ledgerExists) db.exec("DROP TABLE workspace_migration_ledger");
// 发布阶段：rename + 建索引，成功后正式表即为 v2 结构。
  db.exec(PUBLISH_LEDGER_AND_CONFLICT_SCHEMA);
  // upsert 保证首次接管插入、重复执行只更新版本号。
  // 只有 PUBLISH_LEDGER_AND_CONFLICT_SCHEMA 完成后才写 version=3，版本号必须代表真实发布状态。
  db.prepare(`
      INSERT INTO workspace_migration_schema_version (schema_name, version, updated_at)
      VALUES ('workspace-migration', 3, ?)
      ON CONFLICT(schema_name) DO UPDATE SET version = 3, updated_at = excluded.updated_at
    `).run(Date.now());
  db.exec(VERIFY_CURRENT_SCHEMA);
}
