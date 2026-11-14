// Controller 远端身份迁移：把任务库中旧 workspace key 的全部行改写到稳定 identity。
// 整个迁移在单个 IMMEDIATE 事务内完成，并写入审计表供重连时判断是否已迁移。
// 目标库路径由调用方给出，本文件不负责选择数据库。
// 迁移前必须先跑结构迁移，保证目标表与列存在。
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { cancelConflictingOffPeakBindings } from "#src/session/offPeakWorkspaceIdentityMigration.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

// 需要统计行数的表清单：前后计数用于审计与失败诊断。
// 视图节点排序表没有 workspace_key 列，单独按 node_key 前缀计数。
// 清单顺序即审计 JSON 的字段顺序。
const INVENTORIED_TABLES = [
  "tasks",
  "task_group_members",
  "task_group_admissions",
  "task_group_workspace_bootstraps",
  "task_group_view_node_orders",
  "automations",
  "automation_runs",
  "off_peak_tasks",
] as const;

// 表名联合类型由数组推导，新增表只改数组即可。
type InventoriedTable = (typeof INVENTORIED_TABLES)[number];
type MigrationCounts = Record<InventoriedTable, number>;

// migrationId 缺省由 randomUUID 生成，重试时可由调用方复用。
// now 可注入，保证测试中的审计时间可预期。
// old/new key 必须不同，否则直接拒绝。
// dbPath 指向任务库文件；调用方负责保证同一路径不被并发打开写。
export interface ControllerRemoteIdentityMigrationOptions {
  dbPath: string;
  oldWorkspaceKey: string;
  newWorkspaceKey: string;
  migrationId?: string;
  now?: () => number;
}

// 报告同时给出前后计数；失败时 error 必填且 after 为全零。
// status 只有 completed/failed 两种终态。
export interface ControllerRemoteIdentityMigrationReport {
  migrationId: string;
  status: "completed" | "failed";
  before: MigrationCounts;
  after: MigrationCounts;
  error?: string;
}

type Database = InstanceType<typeof DatabaseSync>;

// 表存在性以 sqlite_master 为准，兼容未初始化的空库。
function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

// 列探测先确认表存在，避免 PRAGMA 对缺表抛错。
function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column);
}

// 全零计数既是初始值，也是失败报告的占位值。
function emptyCounts(): MigrationCounts {
  return {
    tasks: 0,
    task_group_members: 0,
    task_group_admissions: 0,
    task_group_workspace_bootstraps: 0,
    task_group_view_node_orders: 0,
    automations: 0,
    automation_runs: 0,
    off_peak_tasks: 0,
  };
}

// 逐表统计目标 workspace 的行数。
// 缺表或缺 workspace_key 列时保留 0，不视为错误。
// 视图节点排序表需要解析 node_key 的 JSON 前缀。
// 计数函数不写库，可在事务外安全调用。
function countRows(db: Database, workspaceKey: string): MigrationCounts {
  const counts = emptyCounts();
  for (const table of INVENTORIED_TABLES) {
// node_key 形如 [workspaceKey, nodeId]，只能逐行解析。
// 解析失败的行计为不属于该 workspace。
    if (table === "task_group_view_node_orders") {
      if (!hasTable(db, table)) continue;
      const rows = db
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      counts[table] = rows.filter((row) => {
        try {
          const parsed = JSON.parse(row.node_key) as unknown;
          return Array.isArray(parsed) && parsed[0] === workspaceKey;
        } catch {
          return false;
        }
      }).length;
      continue;
    }
// 其余表统一按 workspace_key 精确计数。
    if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) continue;
    counts[table] = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_key = ?`)
        .get(workspaceKey) as { count: number }
    ).count;
  }
  return counts;
}

// 通用身份列改写：同时更新 workspace_key 与可选的 workspace_identity。
// `updateIdentityColumn` 同时改写两张表：列名不同，语义一致。
function updateIdentityColumn(
  db: Database,
  table: Exclude<InventoriedTable, "task_group_view_node_orders">,
  oldWorkspaceKey: string,
  newWorkspaceKey: string,
): void {
  if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) return;
// 有身份列时两列一起改，避免出现 key 已变但 identity 仍旧的中间态。
  if (hasColumn(db, table, "workspace_identity")) {
    db.prepare(
      `UPDATE ${table} SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?`,
    ).run(newWorkspaceKey, newWorkspaceKey, oldWorkspaceKey);
  } else {
    db.prepare(`UPDATE ${table} SET workspace_key = ? WHERE workspace_key = ?`).run(
      newWorkspaceKey,
      oldWorkspaceKey,
    );
  }
}

// 任务行迁移最复杂：新旧 key 下可能存在同一 taskId，需要合并。
// 合并规则：保留 updated_at 较新的一行，删除较旧的一行。
// 处理完主键后再回写 meta_json 内的 workspaceIdentity。
// 任务表是唯一存在主键冲突的表，因此需要逐行处理。
function migrateTaskRows(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "tasks")) return;
  const rows = db
    .prepare("SELECT task_id, updated_at FROM tasks WHERE workspace_key = ?")
    .all(oldKey) as unknown as Array<{ task_id: string; updated_at: number }>;
  for (const row of rows) {
    const target = db
      .prepare("SELECT updated_at FROM tasks WHERE workspace_key = ? AND task_id = ?")
      .get(newKey, row.task_id) as { updated_at: number } | undefined;
// 目标已存在同 taskId：比较更新时间决定保留哪一行。
// 删除后仍会继续执行下面的 UPDATE，把存活行改到新 key。
    if (target) {
      if (row.updated_at > target.updated_at) {
        db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?").run(
          newKey,
          row.task_id,
        );
      } else {
        db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?").run(
          oldKey,
          row.task_id,
        );
        continue;
      }
    }
    db.prepare(
      "UPDATE tasks SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ? AND task_id = ?",
    ).run(newKey, newKey, oldKey, row.task_id);
  }
// meta_json 内的身份字段必须与列同步，否则读取方会看到旧身份。
// 只改 workspaceIdentity，其余 meta 字段原样保留。
  if (hasColumn(db, "tasks", "meta_json")) {
    const migrated = db
      .prepare("SELECT task_id, meta_json FROM tasks WHERE workspace_key = ?")
      .all(newKey) as unknown as Array<{ task_id: string; meta_json: string }>;
    const update = db.prepare(
      "UPDATE tasks SET meta_json = ? WHERE workspace_key = ? AND task_id = ?",
    );
    for (const row of migrated) {
      try {
        const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
        update.run(JSON.stringify({ ...meta, workspaceIdentity: newKey }), newKey, row.task_id);
      } catch {
// 解析失败不阻断迁移：坏 JSON 由读取侧降级，主键与身份列已正确。
        // 非法 meta_json 由 TaskIndexRepo 既有读取降级处理；身份列与主键仍已完成迁移。
      }
    }
  }
}

// 分组成员迁移：先删除目标 key 下已存在的同 taskId 行，避免主键冲突。
// 删除只针对冲突行，其余成员整体改 key。
// 分组成员只按 taskId 冲突，不需要比较时间。
function migrateGroupMembers(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_members")) return;
  db.prepare(`DELETE FROM task_group_members
    WHERE workspace_key = ? AND EXISTS (
      SELECT 1 FROM task_group_members target
      WHERE target.workspace_key = ? AND target.task_id = task_group_members.task_id
    )`).run(oldKey, newKey);
  updateIdentityColumn(db, "task_group_members", oldKey, newKey);
}

// 准入记录用 upsert 合并：冲突时取两端更“强”的值。
// user_organized 取 max，creation_id 取首个非空，避免丢失用户操作。
// 准入合并采用“保留更强状态”的规则。
function migrateGroupAdmissions(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_admissions")) return;
  // 身份合并不能遗失“已手动整理”或创建 receipt，否则重连后系统登记会覆盖用户操作。
  db.prepare(`INSERT INTO task_group_admissions(workspace_key,task_id,system_kind,user_organized,creation_id)
    SELECT ?,task_id,system_kind,user_organized,creation_id FROM task_group_admissions WHERE workspace_key=?
    ON CONFLICT(workspace_key,task_id) DO UPDATE SET
      system_kind=coalesce(task_group_admissions.system_kind,excluded.system_kind),
      user_organized=max(task_group_admissions.user_organized,excluded.user_organized),
      creation_id=coalesce(task_group_admissions.creation_id,excluded.creation_id)`).run(
    newKey,
    oldKey,
  );
  db.prepare("DELETE FROM task_group_admissions WHERE workspace_key=?").run(oldKey);
}

// 引导记录是单行语义：目标已存在时删除旧行，否则直接改 key。
// `migrateBootstrap` 不做合并：目标已有行时删除旧行，否则改 key。
function migrateBootstrap(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_workspace_bootstraps")) return;
  if (
    db.prepare("SELECT 1 FROM task_group_workspace_bootstraps WHERE workspace_key = ?").get(newKey)
  ) {
    db.prepare("DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?").run(oldKey);
  } else {
    updateIdentityColumn(db, "task_group_workspace_bootstraps", oldKey, newKey);
  }
}

// 视图节点排序的 key 是 JSON 数组，需解析后重写首元素。
// 目标 key 已存在时删除旧行，保持顺序唯一。
// 排序键重写后可能与目标已有键冲突，冲突时删除旧行。
function migrateTaskNodeOrders(db: Database, oldKey: string, newKey: string): void {
  if (!hasTable(db, "task_group_view_node_orders")) return;
  const rows = db
    .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
    .all() as unknown as Array<{ node_key: string }>;
  const deleteRow = db.prepare(
    "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
  );
  const updateRow = db.prepare(
    "UPDATE task_group_view_node_orders SET node_key = ? WHERE node_type = 'task' AND node_key = ?",
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.node_key);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== oldKey) continue;
    const nextKey = JSON.stringify([newKey, parsed[1]]);
    if (
      db
        .prepare(
          "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
        )
        .get(nextKey)
    ) {
      deleteRow.run(row.node_key);
    } else {
      updateRow.run(nextKey, row.node_key);
    }
  }
}

// 迁移主流程：打开库 → 跑 0004 结构迁移 → 统计前值 → 事务内改写 → 统计后值 → 写审计。
// 任何一步失败都写入 failed 审计并返回报告，不向调用方抛错。
// 无源行时走快速路径，避免与 Task Index 争锁。
// 函数返回报告而不抛错，调用方可直接把 report 传给上层展示。
export async function migrateControllerRemoteWorkspaceIdentity(
  options: ControllerRemoteIdentityMigrationOptions,
): Promise<ControllerRemoteIdentityMigrationReport> {
// 相同 key 的迁移没有意义，直接拒绝。
// 这是调用方参数错误，用抛错暴露而不是返回 failed。
  if (options.oldWorkspaceKey === options.newWorkspaceKey) {
    throw new Error("Controller remote identity migration requires different keys");
  }
// 目标目录不存在时先创建，权限错误会直接抛出。
// mkdir recursive 对已存在目录是幂等的。
  await mkdir(dirname(options.dbPath), { recursive: true });
  const now = options.now ?? Date.now;
  const migrationId = options.migrationId ?? randomUUID();
  const db = new DatabaseSync(options.dbPath);
// 5 秒忙等覆盖冷启动时的短暂锁竞争；外键打开保证改写不破坏引用。
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  try {
// 结构迁移失败时关闭连接后原样抛出，不写业务审计。
// 该 scope 只包含 0004，重复执行是安全的。
    await runTasksDatabaseMigrations(db, "controller-remote");
  } catch (error) {
    db.close();
    throw error;
  }
// 事务前统计旧 key 行数，作为审计与快速路径判定依据。
// 全零说明历史迁移早已完成，本次只补一次目标计数。
  const before = countRows(db, options.oldWorkspaceKey);
// 审计行先写入全零 after，完成后再更新为真实值。
  const emptyAfter = emptyCounts();
// 快速路径：不开启写事务，避免重连时与其它写入争抢锁。
  if (Object.values(before).every((count) => count === 0)) {
    // Bug 原因：Source 每次稳定重连都会再次请求 legacy→stable identity 迁移。旧实现即使
    // legacy 已清空，仍执行 BEGIN IMMEDIATE 并新增 ledger；冷启动时它会与 Task Index 写入
    // 争抢同一个 SQLite 锁，真实 pending interaction Source 因而超过 10 秒连接预算。
    // 已无源行时只读目标计数并直接完成，保留首次迁移 ledger 作为唯一审计轨迹。
    try {
      const after = countRows(db, options.newWorkspaceKey);
      return { migrationId, status: "completed", before, after };
    } finally {
      db.close();
    }
  }
  try {
// IMMEDIATE 立即取得写锁，保证统计与改写之间没有并发写入。
// 审计行先以 running 写入，事务提交前不会变成 completed。
// 所有表改写完成后才统计 after，确保计数反映最终状态。
    db.exec("BEGIN IMMEDIATE");
// 审计行与业务改写处于同一事务：要么都成功，要么都回滚。
// status 先写 running，成功后改 completed。
// before_json 记录迁移前各表行数，便于事后核对。
    db.prepare(`INSERT INTO controller_remote_identity_migrations (
      migration_id, old_workspace_key, new_workspace_key, status,
      before_json, after_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(
      migrationId,
      options.oldWorkspaceKey,
      options.newWorkspaceKey,
      JSON.stringify(before),
      JSON.stringify(emptyAfter),
      now(),
      now(),
    );
// 顺序固定：先任务主表，再依赖 taskId 的分组与准入，最后是独立表。
    migrateTaskRows(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateGroupMembers(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateGroupAdmissions(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateBootstrap(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    migrateTaskNodeOrders(db, options.oldWorkspaceKey, options.newWorkspaceKey);
    updateIdentityColumn(db, "automations", options.oldWorkspaceKey, options.newWorkspaceKey);
    updateIdentityColumn(db, "automation_runs", options.oldWorkspaceKey, options.newWorkspaceKey);
    cancelConflictingOffPeakBindings(db, options.oldWorkspaceKey, options.newWorkspaceKey, now());
    updateIdentityColumn(db, "off_peak_tasks", options.oldWorkspaceKey, options.newWorkspaceKey);
    const after = countRows(db, options.newWorkspaceKey);
// 所有改写完成后统计新 key 行数。
// 计数结果同时写审计与返回报告。
// 只有全部改写成功才把审计置为 completed。
// updated_at 使用注入的时钟，保证与其它字段一致。
    db.prepare(`UPDATE controller_remote_identity_migrations
      SET status = 'completed', after_json = ?, updated_at = ?
      WHERE migration_id = ?`).run(JSON.stringify(after), now(), migrationId);
// 提交成功才返回 completed；提交失败会进入 catch 并尝试回滚。
    db.exec("COMMIT");
    return { migrationId, status: "completed", before, after };
  } catch (error) {
    try {
// 失败路径：回滚事务，尽力写入 failed 审计，然后返回报告。
// 回滚与审计都可能失败，二者都不能覆盖原始错误。
      db.exec("ROLLBACK");
    } catch {
      // 无活动事务时无需二次处理。
    }
// 错误消息截断到 1000 字符，避免超大堆栈撑爆审计表。
// 非 Error 抛出物统一转字符串。
    const message = error instanceof Error ? error.message : String(error);
    try {
      db.prepare(`INSERT OR REPLACE INTO controller_remote_identity_migrations (
        migration_id, old_workspace_key, new_workspace_key, status,
        before_json, after_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)`).run(
        migrationId,
        options.oldWorkspaceKey,
        options.newWorkspaceKey,
        JSON.stringify(before),
        JSON.stringify(emptyAfter),
// 审计表只存截断后的消息，完整堆栈留在日志。
        message.slice(0, 1_000),
        now(),
        now(),
      );
    } catch {
      // 迁移与审计可能因同一磁盘/锁故障失败；二次写入不能覆盖原始错误或阻断握手。
    }
// 失败报告不包含部分成功的 after，避免误读为已迁移。
    return { migrationId, status: "failed", before, after: emptyAfter, error: message };
// 无论成功失败都关闭连接，避免句柄泄漏影响后续重连。
  } finally {
    db.close();
  }
}
