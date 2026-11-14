// 项目迁移：为已升级的本地库补写 workspace 的初始排序位置（initial_position / position）。
// 边界：只处理 hostId 为 local 的迁移；远端 Host 有自己的顺序来源，不能被本地猜测覆盖。
// 不变量(INV)：position 从 0 连续递增，同一 workspace/项目只分配一次，重复命中必须跳过。
// 改错会怎样：漏掉去重会让同路径项目互相覆盖 position，用户侧项目顺序会随机漂移。
import type { DatabaseSync } from "node:sqlite";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";

// DDL 必须与升级脚本里的列定义保持一致；已迁移的库不会重跑，改这里只影响新建库。
export const INITIAL_WORKSPACE_ORDER_SQL =
  "ALTER TABLE remote_project_entries ADD COLUMN initial_position INTEGER";

/** 只在同一事务首次建立项目时调用；已经升级的用户不能再从旧 settings 猜顺序。 */
// 只在建库的同一事务里调用一次：依赖 position 从 0 重新分配来还原本地与远端的混排顺序。
export function migrateInitialWorkspaceOrder(
  db: DatabaseSync,
  context: ProjectMigrationContext,
): void {
// hostId 缺省视为 local 以兼容旧数据；非本地 Host 直接跳过，避免写坏远端项目排序。
  if ((context.hostId ?? "local") !== "local") return;
  let position = 0;
  const assigned = new Set<string>();
  for (const workspace of context.settings?.lastWorkspaceSession ?? []) {
    if (workspace.kind === "remote") {
      // 原迁移分开写本地项目和远端入口，丢失了混排位置；按同事务复制的完整入口匹配，避免同路径串 Host。
// 用整条入口 JSON 作匹配键：旧迁移丢过位置信息，只能靠同事务复制过来的完整记录对齐。
      const legacy = JSON.stringify(workspace);
      if (assigned.has(legacy)) continue;
      assigned.add(legacy);
      const result = db
        .prepare(
          "UPDATE remote_project_entries SET initial_position=? WHERE legacy_workspace_json=?",
        )
        .run(position, legacy);
      if (result.changes) position++;
    } else {
// 本地分支按 root_path 关联 project_roots，并排除已删除项目，防止复活软删数据。
      const project = db
        .prepare(`SELECT p.project_id FROM projects p
        JOIN project_roots r ON r.project_id=p.project_id
        WHERE p.host_id='local' AND p.deleted=0 AND r.root_path=?`)
        .get(workspace.workspacePath);
      if (!project || assigned.has(String(project.project_id))) continue;
      assigned.add(String(project.project_id));
// position++ 在去重通过后自增：跳过重复项时序号仍连续，不留空洞。
      db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(
        position++,
        project.project_id!,
      );
    }
  }
}
