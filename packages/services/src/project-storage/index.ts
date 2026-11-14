// 项目存储模块的统一装配入口：把迁移编排、身份准入与仓储构造收敛到同一个可注入实现，
// 上层 host / server 只依赖 ProjectStorageContract，无需感知具体 SQLite 版本与迁移顺序。
// 本文件只做组合与契约导出，真正的读写逻辑下沉到 project-repository、legacy-tasks 等子模块，
// 因此新增能力时必须同步 contract，而不是在装配层写业务分支。
import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";
import { reconcileLegacy, admitTaskIdentity } from "#src/project-storage/legacy-tasks.js";
import { migrateProjects } from "#src/project-storage/migrate-projects.js";
import {
  INITIAL_WORKSPACE_ORDER_SQL,
  migrateInitialWorkspaceOrder,
} from "#src/project-storage/migration-order/migration.js";
import {
  DEFAULT_WORKSPACE_CANDIDATES_SQL,
  migrateDefaultWorkspaceTasks,
} from "#src/project-storage/default-workspace/migration.js";
import {
  PROJECT_MIGRATION_TABLES,
  PROJECT_SCHEMA_SQL,
  TASK_PROJECT_COLUMNS,
} from "#src/project-storage/schema.js";

export type {
  ProjectMigrationContext,
  ProjectStorageContract,
} from "#src/project-storage/contract.js";
// 契约对象本身无状态，成员都是函数或工厂；同一进程内多个窗口复用它，
// 避免各自构造迁移器导致迁移状态分叉。
export const projectStorage: ProjectStorageContract = {
  migrate: async (db, context) => {
// 0007 需要知道 0005 是否在本次事务中刚执行：全新库要补种初始顺序，
// 老库升级则不能重放，否则会把用户已调整的排序覆盖回默认值。
    let firstProjectMigration = false;
    const result = await sqliteMigrations.migrate(
      db,
      [
        {
// 0005 建立项目与任务归属的基础表结构；previousIds 兼容早期的 0001 命名，
// 保证跑过旧版本迁移的库不会被重复建表。
          id: "0005_projects",
          previousIds: ["0001_projects"],
          appVersion: "3.12.0",
          touchedTables: PROJECT_MIGRATION_TABLES,
          sql: `${PROJECT_SCHEMA_SQL}\n-- tasks columns: ${JSON.stringify(TASK_PROJECT_COLUMNS)}\n-- v3 workspace/group first assignment and CLI intent handoff`,
          apply: (database) => {
            migrateProjects(database, context);
            firstProjectMigration = true;
          },
        },
        {
// 0006 清理默认工作区候选数据：解除任务的项目归属并软删未被编辑的系统容器，
// 保留任务事实，避免升级后用户看不到历史任务。
          id: "0006_default_workspace_tasks",
          appVersion: "3.12.0",
          touchedTables: ["tasks", "projects"],
          sql: `${DEFAULT_WORKSPACE_CANDIDATES_SQL}\n-- v1 clear project ownership and soft-delete the unedited system container; preserve task facts`,
          apply: (database) => migrateDefaultWorkspaceTasks(database, context),
        },
        {
// 0007 无论 0005 是否本次执行都先补齐排序字段，再由 firstProjectMigration 决定是否补种，
// 两步拆开保证老库升级与全新初始化都幂等。
          id: "0007_initial_workspace_order",
          appVersion: "3.16.2",
          touchedTables: ["projects", "remote_project_entries"],
          sql: `${INITIAL_WORKSPACE_ORDER_SQL}\n-- seed mixed order only when 0005 runs in this transaction`,
          apply: (database) => {
            database.exec(INITIAL_WORKSPACE_ORDER_SQL);
            if (firstProjectMigration) migrateInitialWorkspaceOrder(database, context);
          },
        },
      ],
      {
// 迁移落在 tasks_index 库上，备份目录与时间源由调用方注入，方便测试重放；
// 备份空间不足只告警不阻断，因为项目迁移失败会让应用整体不可用。
        database: "tasks_index",
        backupDirectories: context.backupDirectories,
        now: context.now,
        onBackupSkipped: () => context.warn?.("项目迁移备份因可写卷空间不足跳过"),
      },
    );
// 结构迁移完成后做一次遗留任务对账：老版本只存路径、没有项目实体的数据要补归属，
// 放在事务外按 hostId 收敛，避免与结构迁移互相依赖。
    reconcileLegacy(db, context.hostId);
    return result;
  },
// admitTaskIdentity 直接透传：任务身份判定属于领域规则，由 legacy-tasks 单点实现，
// 这里不再包装，防止出现两条准入路径给出不同结论。
  admitTaskIdentity,
// 仓储按 host 构造：每个 host 绑定自己的数据库连接与 hostId；
// 不在模块级缓存实例，避免多窗口共享连接导致事务互相干扰。
  repository: (db, hostId) => new ProjectRepository(db, hostId),
};
