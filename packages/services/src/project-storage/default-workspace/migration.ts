// 默认工作区任务迁移：把旧版隐式创建的 default workspace 自动项目中的任务交还出去。
// 边界：只认单 root、未重命名、未编辑且早于首次迁移创建的自动项目，其余必须跳过。
// INV：迁移只改组织归属，必须幂等；重复执行不得二次改写或删除已交接的任务。
import type { DatabaseSync } from "node:sqlite";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";

// 原因：旧 settings 的 purpose 缺失/误标会把系统任务目录迁成项目。
// 限定首次迁移创建且未编辑的单 root 自动项目，不能按名称隐藏用户项目或任务。
export const DEFAULT_WORKSPACE_CANDIDATES_SQL = `
SELECT p.project_id FROM projects p JOIN project_roots r USING(project_id)
WHERE p.host_id=? AND p.deleted=0 AND p.name_overridden=0
  AND p.updated_at=p.created_at
  AND p.created_at<=(SELECT applied_at FROM schema_migration WHERE id='0005_projects')
  AND (SELECT count(*) FROM project_roots other WHERE other.project_id=p.project_id)=1
  AND replace(r.root_path, char(92), '/') GLOB '*/.zcode/workspace/default'
`;

// 事务边界由调用方的数据库上下文保证；本函数只做两类确定性更新，不读业务缓存。
// 若放宽候选条件，用户自建项目会被误标删除，任务归属丢失且不可逆。
export function migrateDefaultWorkspaceTasks(db: DatabaseSync, context: ProjectMigrationContext) {
  // 候选 SQL 已限定单 root 与未改名以及创建时间不晚于首次迁移，漏一条就会动到用户项目
  // 候选为空不报错：schema_migration 里缺 0005_projects 记录时子查询返回 NULL，迁移会静默跳过而不是失败退出。
  const ids = db.prepare(DEFAULT_WORKSPACE_CANDIDATES_SQL).all(context.hostId ?? "local");
  // 所有行共用同一个时间戳，避免同一批迁移的 deleted_at 出现毫秒级差异
  const now = (context.now ?? Date.now)();
  // 逐条处理而不是一条 UPDATE 全改，任务解绑与项目软删必须成对出现
  // 顺序约束：必须先解绑 tasks.project_id 再软删 projects。若两条 UPDATE 之间崩溃，当前顺序最坏只留下空壳项目，
  // 下一轮迁移仍会重新选中并补完；反序则留下「项目已 deleted 但任务仍指向它」的悬挂引用，且不会再次被选中。
  // 若外层没包事务，自动提交会让上面的中间态真实落盘，崩溃后悬挂引用不再自愈。
  for (const { project_id } of ids) {
    // 只交接组织归属；保留归档、置顶、未读、CLI 镜像及已固化的执行目录。
    // 只清 project_id，归档与置顶以及执行目录都保留，迁移不应改写会话状态
    db.prepare("UPDATE tasks SET project_id=NULL WHERE project_id=? AND host_id=?").run(
      // 参数用 String 包一层，sqlite 返回的 id 可能是数字或大整数
      String(project_id),
      context.hostId ?? "local",
    );
    // 项目软删而不是物理删除，任务行清空 project_id 后仍需保留可追溯的旧项目
    db.prepare("UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=?").run(
      now,
      now,
      String(project_id),
    );
  }
}
