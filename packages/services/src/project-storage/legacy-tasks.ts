import type { DatabaseSync } from "node:sqlite";
import {
  resolveWorkspaceKey,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { tableExists } from "#src/project-storage/schema.js";

// 旧版任务/定义表的身份补写：把历史行（host_id IS NULL）迁到由 workspaceKey 派生的 host 与项目上。
// INV-01：本文件只写 host_id/root_path/project_id 与 CLI 兼容列，绝不改动任务业务内容；
//         破坏后果：桌面与 Source Server 共用 tasks-index 时，两边对同一 owner 的认知分叉，
//         后写者会被 projects.host_id 外键拒绝，启动阶段直接抛错（守住：initializeLegacyTaskIdentity）。
// INV-02：handoff_pending 只做按位或，从不覆盖已有位（守住：reconcileLegacy 的两条 UPDATE）。
//         破坏后果：已排出但未消费的交接事件被抹掉，出现「本地删了远端还在」的双份事实。
// INV-03：所有补写在 BEGIN IMMEDIATE 内完成，失败必须 ROLLBACK（守住：reconcileLegacy 的 catch）。
//         半写状态会让下一轮按 host_id IS NULL 再也选不中该行，等于永久丢失归属。
export const HANDOFF_DELETE = 1;
export const HANDOFF_TITLE = 2;
export const HANDOFF_ORPHAN = 4;
export const OWNERSHIP_DECIDED = 8;

// 身份键到 host 的纯函数映射：remote workspace 的 kind 由 identity 自带，本地键没有前缀即 local。
// 刻意不查库，让迁移判据只依赖键本身，避免在 BEGIN 之前引入额外读取。
export function hostForWorkspace(workspaceKey: string): { hostId: string; kind: string } {
  const parsed = parseRemoteWorkspaceIdentity(workspaceKey);
  return {
    hostId: remoteHostIdFromWorkspaceIdentity(workspaceKey) ?? "local",
    kind: parsed?.kind ?? "local",
  };
}

// 幂等登记 host 行：迁移按库只跑一次，后打开同一库的进程不会再有自己的 host 行，
// 所以每次启动都要补一次，否则它新建项目时 projects.host_id 的外键检查会失败。
// ownerHostId 显式给出时不再解析 workspaceKey：调用方已知真实 owner，重解析会把 server 键降级成 local。
export function ensureHost(db: DatabaseSync, workspaceKey: string, ownerHostId?: string): string {
  const { hostId, kind } = ownerHostId
    ? { hostId: ownerHostId, kind: ownerHostId === "local" ? "local" : "server" }
    : hostForWorkspace(workspaceKey);
  db.prepare(
// [权衡] 用 INSERT OR IGNORE 加 count(*) 当 position，而不是先查后插：
// 单语句内完成，两个进程同时补同一 host 时不会出现重复行或 position 冲突。
    "INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES(?,?,(SELECT count(*) FROM hosts))",
  ).run(hostId, kind);
  return hostId;
}

// 只有恰好一个未删除项目匹配该 root 时才返回 id：0 个说明项目还没建，多个说明
// 该目录建过多项目。猜错会把任务挂到别人项目上，所以宁可留空交给后续归属流程。
export function uniqueRootProject(
  db: DatabaseSync,
  hostId: string,
  rootPath: string,
): string | null {
  const projects = db
    .prepare(`SELECT p.project_id FROM projects p JOIN project_roots r USING(project_id)
    WHERE p.host_id=? AND p.deleted=0 AND r.root_path=? LIMIT 2`)
    .all(hostId, rootPath) as { project_id: string }[];
  return projects.length === 1 ? projects[0]!.project_id : null;
}

// 历史行的一次性归属判定。cli_title/cli_last_outcome 等列由旧列派生，方向只能是旧到新：
// 反向回写会覆盖用户在 CLI 侧的修改；派生后 CLI 读路径在迁移完成当刻就有值，不必等首次写入。
export function initializeLegacyTaskIdentity(
  db: DatabaseSync,
  assignProject: boolean,
  ownerHostId?: string,
): void {
// [失败路径] tasks 表不存在说明是全新的库，没有历史行可迁。这里不建表，
// 建表属于 schema 迁移职责，在此补建会绕过版本号让后续迁移误判。
  if (!tableExists(db, "tasks")) return;
  const rows = db
    .prepare(
      "SELECT workspace_key,workspace_path,task_id,project_id FROM tasks WHERE host_id IS NULL",
    )
    .all() as {
    workspace_key: string;
    workspace_path: string;
    task_id: string;
    project_id: string | null;
  }[];
// WHERE 带 host_id IS NULL：迁移必须可重入，已判定的行不能被第二遍改写成别的结论。
// 身份、项目与 handoff 位在同一条语句里算完，避免分两步时崩溃留下半迁移行。
  const update = db.prepare(`UPDATE tasks SET host_id=?,root_path=workspace_path,project_id=?,
    cli_title=title,cli_title_source=CASE WHEN title_overridden=1 THEN 'custom' ELSE 'default' END,
    cli_created_at=created_at,cli_updated_at=updated_at,
    cli_last_outcome=CASE WHEN task_status='error' THEN 'error' WHEN task_status='interrupted' THEN 'interrupted' WHEN task_status='completed' THEN 'completed' ELSE NULL END,
    cli_deleted=0,handoff_pending=handoff_pending | ? | CASE WHEN deleted=1 THEN 1 ELSE 0 END | CASE WHEN title_overridden=1 THEN 2 ELSE 0 END
    WHERE workspace_key=? AND task_id=? AND host_id IS NULL`);
  for (const row of rows) {
    const hostId = ensureHost(db, row.workspace_key, ownerHostId);
// project_id 优先沿用旧列，只有旧列为空且允许分配时才按 root 反查。
// assignProject=false 的场景必须跳过反查，否则会把尚未确认的绑定当事实写库。
    const projectId =
      row.project_id ?? (assignProject ? uniqueRootProject(db, hostId, row.workspace_path) : null);
    update.run(
      hostId,
      projectId,
      assignProject ? OWNERSHIP_DECIDED : 0,
      row.workspace_key,
      row.task_id,
    );
  }
}

// automations 与 off_peak_tasks 结构同构，按表名循环而不是复制两份逻辑；
// 将来沿用 workspace_key/workspace_path 的新表只需加入列表，不会被漏迁。
function initializeLegacyDefinitions(db: DatabaseSync, ownerHostId?: string): void {
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    const rows = db
      .prepare(
        `SELECT DISTINCT workspace_key,workspace_path,project_id FROM ${table} WHERE host_id IS NULL`,
      )
      .all() as {
      workspace_key: string;
      workspace_path: string;
      project_id: string | null;
    }[];
    const update =
// 回填 additional_directories 为 []：旧版只有 cwd，没有附加目录概念，留 NULL 会让下游多一条特例分支。
      db.prepare(`UPDATE ${table} SET host_id=?,project_id=?,additional_directories=coalesce(additional_directories,'[]')
      WHERE workspace_key=? AND workspace_path=? AND host_id IS NULL`);
    for (const row of rows) {
      const hostId = ensureHost(db, row.workspace_key, ownerHostId);
      // 原因：旧版本新增定义不会重跑 v3 migration；host_id 标识一次性交接，不能重算合法 NULL 归属。
      // 旧版只有 cwd，附加目录保持 []，不因当前项目 roots 扩大既有自动执行范围。
      update.run(
        hostId,
        row.project_id ?? uniqueRootProject(db, hostId, row.workspace_path),
        row.workspace_key,
        row.workspace_path,
      );
    }
  }
}

// 启动期总入口，必须整体原子：任一表补写失败都回滚，下一轮才有机会按 host_id IS NULL 重新选中。
export function reconcileLegacy(db: DatabaseSync, ownerHostId?: string): void {
// [事务] IMMEDIATE 立即拿写锁：本库被桌面与 Source Server 两进程共用，延迟升级到写锁会在中间态被对方写入。
  db.exec("BEGIN IMMEDIATE");
  try {
    // Bug 原因：同一台机器上本机桌面与 Source Server 共用 tasks-index；0005 按库只执行一次，
    // 只写入首个打开者的 host 行，后打开的 owner 新建项目触发 projects.host_id 外键失败。
    // 每次启动幂等补齐当前 owner 的 host 行；不改任务 host_id 与项目归属。
    ensureHost(db, "local", ownerHostId);
    initializeLegacyTaskIdentity(db, true, ownerHostId);
    initializeLegacyDefinitions(db, ownerHostId);
    if (tableExists(db, "tasks")) {
      db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_DELETE} WHERE deleted=1 AND coalesce(cli_deleted,0)=0;
        UPDATE tasks SET handoff_pending=handoff_pending | ${HANDOFF_TITLE}
        WHERE title_overridden=1 AND (coalesce(cli_title_source,'')<>'custom' OR coalesce(cli_title,'')<>title);`);
    }
// [事务] 提交点之前崩溃 = 整批未生效，下次启动重跑；提交点之后崩溃 = 全部生效，
// 因为所有判据都是 host_id IS NULL，重跑不会二次改写。
    db.exec("COMMIT");
  } catch (error) {
// [失败路径] 只在事务仍活跃时回滚：错误可能来自 BEGIN 本身或驱动已自动回滚，
// 无条件执行 ROLLBACK 会抛出第二个错误，把原始失败原因盖掉。
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** 新版本插入身份和首次归属，不借旧列生成 CLI 事实。调用方与 INSERT 共用写事务。 */
// 新写入路径：INSERT 之后补身份，条件同样是 host_id IS NULL，与旧迁移互不覆盖。
// 调用方必须已开启写事务，这里不再 BEGIN，避免嵌套事务改变外层提交语义。
export function admitTaskIdentity(
  db: DatabaseSync,
  task: { workspacePath: string; workspaceIdentity?: string; taskId: string },
  ownerHostId?: string,
): void {
  const key = resolveWorkspaceKey(task);
  const hostId = ensureHost(db, key, ownerHostId);
  db.prepare(
    "UPDATE tasks SET host_id=?,root_path=workspace_path,project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=? AND host_id IS NULL",
  ).run(
    hostId,
    uniqueRootProject(db, hostId, task.workspacePath),
    OWNERSHIP_DECIDED,
    key,
    task.taskId,
  );
}
