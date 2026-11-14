// 任务库迁移编排：定义 0001~0006 的结构变更、checksum 输入与执行顺序。
// 迁移由 sqliteMigrations 统一加锁执行，本文件只声明“做什么”。
// checksum 输入必须冻结：一旦发布，改动会让已升级的库被判定为被篡改。
// 迁移 ID 同时是账本主键与执行顺序，不能复用或重排。
// 依赖方向：本文件引用各迁移的 SQL 常量，反向不成立。
// 修改任何 checksumInput 都会被视为一次新的迁移语义。
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import { sqliteMigrations, type SqliteMigration } from "@zcode/shared/sqlite-migrations";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
import { CONTROLLER_REMOTE_SCHEMA_SQL } from "#src/session/tasksDatabase/controller-remote-schema-v4.js";
import {
  adoptSourceServerWorkspaceSchema,
  SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
} from "#src/session/tasksDatabase/source-server-schema-v5.js";

// 0001 的补列清单：全部是历史上通过 ALTER TABLE 追加的列。
// 这里必须逐字冻结列名与类型，不能引用运行时 schema 生成。
// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
// 列顺序即补列顺序，同时参与 checksum。
// 默认值必须写在声明里，旧行回填依赖它。
// 新增列只能追加到数组尾部，并同步提升迁移版本。
// 每项为 [表名, 列名, 列声明]，执行时逐项 PRAGMA 检查后 ALTER。
// 列声明中的 DEFAULT 决定旧行回填值。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
// 0001 附带的部分索引：只覆盖未删除且关联字段非空的行。
// 索引定义同样是 checksum 输入。
// 三个索引都只覆盖关联字段非空且未删除的任务。
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
// 错峰任务的终态集合；绑定唯一索引只约束非终态行。
const terminalStatuses = "'completed','failed','cancelled'";
// 活跃绑定谓词：同一 workspace 下同一 session 只能有一个未结束的错峰任务。
// 该谓词同时用于建索引前的重复检测。
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
// 部分唯一索引：终态行不参与唯一性约束。
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;
// 0004 的执行作用域列：project_id/host_id/additional_directories，全部可空。
const executionColumns = [
  ["automations", "project_id"],
  ["automations", "host_id"],
  ["automations", "additional_directories"],
  ["off_peak_tasks", "project_id"],
  ["off_peak_tasks", "host_id"],
  ["off_peak_tasks", "additional_directories"],
] as const;

// 迁移定义表：每项包含 id、影响表、apply 与 checksum 输入。
// apply 只在账本判定未应用时执行一次。
// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
// 0001 是基线：建表 + 补历史列 + 补索引 + 错峰绑定去重。
// 后续条目只做增量结构或数据转换，不得重写 0001。
// touchedTables 用于备份与 diagnostics，不参与校验。
// 数组顺序即执行顺序；sqliteMigrations 按 id 排序后仍保持该顺序。
// 新增迁移必须追加在末尾，编号递增且不复用。
const definitions = [
  {
// 0001 覆盖三组 schema 原文、补列清单、索引与绑定索引。
// checksum 中的 scheduled-count-backfill-v1 标记回填语义版本。
// 版本标记字符串本身也是 checksum 的一部分。
// 0001 的 touchedTables 覆盖三组 schema 的全部表，用于备份范围。
// apply 与 checksumInput 必须同步修改，但 0001 已冻结。
    id: "0001_adopt_task_schema",
    touchedTables: [
      "tasks",
      "task_groups",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ],
    apply: adoptSchema,
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
// 0002 把旧 provider/model 编码解码为 model_selection，只影响 automations。
    id: "0002_provider_selection",
    touchedTables: ["automations"],
    apply: importLegacyAutomationSelections,
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
// 0003 规范化官方 GLM 模型 ID 的大小写，SQL 完全冻结。
    id: "0003_official_glm_selection",
    touchedTables: ["automations"],
    apply: (db: DatabaseSync) => db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL),
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
  {
// 0004 为自动化与错峰任务追加项目执行作用域列。
    id: "0004_project_execution_scopes",
    touchedTables: ["automations", "off_peak_tasks"],
    checksumInput: [executionColumns, "nullable-text-v1"],
    apply: (db: DatabaseSync) => {
// 逐列检查后再 ALTER，保证重复执行幂等。
// 这些列不加进 0001，避免改变已发布的基线 checksum。
      // 原因：调度器可独立打开 Repo，不能等待项目归属转换，也不能把新列写进上游冻结 schema。
      for (const [table, column] of executionColumns) {
        if (
          !db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((entry) => entry.name === column)
        )
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    },
  },
  {
// 0006 建立任务分组准入表，SQL 来自 task-groups 域并原样引用。
    id: "0006_task_group_admissions",
    touchedTables: ["task_group_admissions"],
    checksumInput: [TASK_GROUP_ADMISSIONS_SQL],
    apply: (db: DatabaseSync) => db.exec(TASK_GROUP_ADMISSIONS_SQL),
  },
] as const;

// scope 决定使用哪一组迁移：base 为本地任务库，另两组为对端专属结构。
export type TasksDatabaseMigrationScope = "base" | "controller-remote" | "source-server";

// transactionOpen 表示调用方已持有事务，迁移不再自行开启。
// onProgress 用于把迁移阶段回传给启动界面。
interface TasksDatabaseMigrationOptions {
  scope?: TasksDatabaseMigrationScope;
  dbPath?: string;
  transactionOpen?: boolean;
  migration?: DatabaseMigrationFacts;
  onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
}

// 按 scope 选择迁移集合并补齐统一字段（appVersion、sql、checksum）。
function prepareMigrations(scope: TasksDatabaseMigrationScope) {
  // 两端专属表仍归同库账本协调，不会为另一端创建无关表。
// controller-remote 与 source-server 各自只有一条专属迁移，与 base 共用账本表。
  const migrations =
    scope === "base"
      ? definitions
      : scope === "controller-remote"
        ? [
            {
// 对端身份迁移的审计表结构独立于 base，不创建任务相关表。
              id: "0004_controller_remote_identity",
              checksumInput: [CONTROLLER_REMOTE_SCHEMA_SQL],
              touchedTables: ["controller_remote_identity_migrations"],
              apply: (db: DatabaseSync) => db.exec(CONTROLLER_REMOTE_SCHEMA_SQL),
            },
          ]
        : [
            {
// 0005 接管 Source Server 工作区表，touchedTables 含暂存表名便于备份覆盖。
              id: "0005_source_server_workspace_schema",
              checksumInput: SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
              touchedTables: [
                "workspace_alias",
                "workspace_migration_schema_version",
                "workspace_migration_ledger",
                "workspace_migration_conflicts",
                "workspace_migration_ledger_v2",
                "workspace_migration_conflicts_v2",
              ],
              apply: adoptSourceServerWorkspaceSchema,
            },
          ];
// 统一补齐 sql 字段供账本记录，checksum 只由 checksumInput 计算。
  return migrations.map((migration) => ({
    id: migration.id,
    appVersion: "3.12.0",
    sql: JSON.stringify(migration.checksumInput),
    touchedTables: migration.touchedTables,
    apply: migration.apply,
// JSON.stringify 的数组顺序必须稳定，否则 checksum 会随键顺序漂移。
// 不使用函数源码计算哈希，打包工具会改写函数文本。
    checksum: createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex"),
  }));
}

// 迁移入口兼容两种调用方式：字符串 scope 或完整 options 对象。
// 已全部应用且未处于事务时直接返回，避免无谓加锁。
// 迁移失败时把当前 migrationId 附着到错误对象，便于上层定位。
// 返回 migrate 的结果对象：applied 列表与 backupSkipped 标记。
// 调用方无需区分“无需迁移”和“已迁移完成”，两者都返回空 applied。
export async function runTasksDatabaseMigrations(
  db: DatabaseSync,
  scopeOrOptions: string | TasksDatabaseMigrationOptions = "base",
) {
  const options: TasksDatabaseMigrationOptions =
    typeof scopeOrOptions === "string"
      ? ["base", "controller-remote", "source-server"].includes(scopeOrOptions)
        ? { scope: scopeOrOptions as TasksDatabaseMigrationScope }
        : { dbPath: scopeOrOptions }
      : scopeOrOptions;
// scope 缺省为 base；字符串参数若不是已知 scope 则视为 dbPath。
  const scope = options.scope ?? "base";
  const migrations = prepareMigrations(scope);
// 事务内不能提前返回：调用方可能需要在同一事务里继续写入。
  if (!options.transactionOpen && areTasksDatabaseMigrationsApplied(db, scope))
    return { applied: [], backupSkipped: false };
  const facts = options.migration ?? {
    kind: inspectTasksMigrationKind(db, scope),
    executedCount: 0,
    committedCount: 0,
  };
// dbPath 未传时从 pragma database_list 读取主库文件；内存库回退 :memory:。
  const path =
    options.dbPath ??
    String(
      db
        .prepare("pragma database_list")
        .all()
        .find((row) => row.name === "main")?.file ?? ":memory:",
    );
  const directory = dirname(path);
// v2 数据目录把备份放在上一级，其余布局直接使用库所在目录。
  const dataRoot = basename(directory) === "v2" ? dirname(directory) : directory;
  let currentMigrationId: string | undefined;
  try {
// 统一迁移器负责加锁、备份与账本写入，本函数只提供参数。
// 备份目录固定为 dataRoot/backup。
// database 与 journalTable 名称固定，改名会导致账本丢失。
// transactionOpen 透传，由迁移器决定是否自行开事务。
    const result = await sqliteMigrations.migrate(db, migrations, {
      database: "tasks_schema",
      journalTable: "tasks_schema_migration",
      backupDirectories: [join(dataRoot, "backup")],
      transactionOpen: options.transactionOpen,
// 应用前刷新 facts 并回传进度；首次迁移时补读账本基线。
      onBeforeApply: (id) => {
        currentMigrationId = id;
        if (facts.kind === "none") facts.kind = "upgrade";
        if (facts.lastAppliedMigrationId === undefined) {
          const baseline = db
            .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
            .get();
          facts.lastAppliedMigrationId = baseline
            ? databaseMigrationIdSchema.safeParse(baseline.id).data
            : null;
        }
        options.onProgress?.("migrating", { ...facts });
      },
      onApplied: () => {
        facts.executedCount++;
      },
      onCommitting: () => {
        if (facts.lastAppliedMigrationId === undefined) {
          const baseline = db
            .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
            .get();
          facts.lastAppliedMigrationId = baseline
            ? databaseMigrationIdSchema.safeParse(baseline.id).data
            : null;
        }
        options.onProgress?.("committing", { ...facts });
      },
    });
    facts.committedCount = facts.executedCount;
    return result;
// 失败路径：给错误附加 migrationId 后原样抛出，保留原始错误类型。
  } catch (error) {
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

// 账本比对：未记录视为未应用，checksum 不一致视为被篡改并 fail-closed。
function isMigrationApplied(db: DatabaseSync, id: string, checksum: string): boolean {
  const applied = db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(id);
  if (!applied) return false;
// 校验失败必须抛错而不是重跑迁移，重跑可能覆盖用户数据。
  if (applied.checksum !== checksum)
    throw Object.assign(new Error(`Task database migration checksum mismatch: ${id}`), {
      kind: "checksum_mismatch",
      migrationId: id,
    });
  return true;
}

// 就绪判定：每条迁移都在账本中且 checksum 一致才算完成。
// [契约] ready 要求每条迁移在账本内且 checksum 一致：只查账本行数会把半应用当成已完成。
/** 交接只复用已完成初始化；每个新连接按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(
  db: DatabaseSync,
  scope: TasksDatabaseMigrationScope = "base",
): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  return prepareMigrations(scope).every(({ id, checksum }) => isMigrationApplied(db, id, checksum));
}

// 展示预检只回答 initialize/upgrade/none，不承担加锁。
// 真正执行前 runner 会重新校验，预检结果可能已过期。
/** 只读账本的展示预检，不授权执行；runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(
  db: DatabaseSync,
  scope: TasksDatabaseMigrationScope = "base",
): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
// 任意一条未应用即视为有待执行迁移。
  let pending = false;
  for (const { id, checksum } of prepareMigrations(scope)) {
    if (!hasLedger || !isMigrationApplied(db, id, checksum)) pending = true;
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}

// 0001 实际执行体：建表、补列、回填计数、建索引、去重后建唯一索引。
// 函数本身不开启事务，事务边界由迁移器负责。
function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
// 已存在则跳过，保证重复执行安全。
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
// 建唯一索引前先检测重复绑定；有重复时暂不建索引，交给后续人工处理。
// 检测使用同一活跃谓词，避免把终态行误判为冲突。
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
// 只看是否存在重复，不读取具体行，减少大表扫描开销。
// 重复检测与索引使用同一谓词，保证判定与约束完全一致。
// 查询带 LIMIT 1，遇到第一条重复即可停止。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
// 无重复才建索引；有重复时保留现状并让上层告警。
  if (!duplicate) db.exec(boundIndex);
}
