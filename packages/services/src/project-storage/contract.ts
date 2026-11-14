// 项目存储端口（contract-only）：定义 Host 侧 SQLite 项目库的迁移、仓库与任务归属接口。
// 本文件只有类型与常量，没有实现；host 与 desktop 各自注入实现，UI 层不得直接触碰 SQLite。
// 除 migrate 为异步外，其余方法都是同步短事务；外层读快照与写事务边界由调用方控制。
import type { DatabaseSync } from "node:sqlite";
import type { AppSettings } from "@zcode/shared";
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";

// 迁移上下文由持库 Host 组装：hostId 用于归属校验，不能取自客户端请求或旧 canonical route。
// backupDirectories 只在遇阻时用于定位备份，迁移本身不写外部目录；settings 是一次性快照。
export interface ProjectMigrationContext {
  /** 可信持库 Server 身份；不受客户端请求或旧 canonical route 影响。 */
  hostId?: string;
  backupDirectories: readonly string[];
  settings?: Pick<
    AppSettings,
    "lastWorkspaceSession" | "recentProjects" | "sourceServers" | "connectionProfiles"
  >;
  now?: () => number;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

// 存储总值域：migrate 负责版本升级，repository 产出按 hostId 隔离的读写视图，admitTaskIdentity 做任务预占。
// migrate 每次启动都调用且需幂等；已处理的 NULL 不重算，避免覆盖用户后续的组织操作。
/** Host 数据库的版本化迁移端口；不读取或修改 CLI db.sqlite。 */
export interface ProjectStorageContract {
  /** 加法升级后同事务交接旧版本新增行/删除/标题意图；每次启动调用，不重算已处理的 NULL。 */
  migrate(db: DatabaseSync, context: ProjectMigrationContext): Promise<MigrationResult>;
  repository(db: DatabaseSync, hostId?: string): ProjectRepositoryContract;
  admitTaskIdentity(db: DatabaseSync, task: ProjectTaskRef, hostId?: string): void;
}

export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}
// 项目投影：roots 顺序即展示顺序，isPrimary 指出执行目录；可选字段来自所属 Host 探测，不落库。
export interface VirtualProject {
  /** 所属 Host 异步探测的只读投影，不写入项目数据库或远端入口缓存；旧 Server 可省略。 */
  primaryRootStatus?: "available" | "missing" | "unavailable";
  /** 旧 Server 的只读单 root 投影，不是本机持久化项目。 */
  legacySingleRoot?: true;
  /** 旧单 root 按所属 Host 规则派生的目录匹配值；不落库，不改变原 root、项目 ID 或任务 cwd。 */
  directoryMatchPath?: string;
  id: string;
  hostId: string;
  name: string;
  nameOverridden: boolean;
  roots: ProjectRoot[];
  position: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
}
// 任务寻址键：workspaceIdentity 优先、缺省回落 workspacePath，与仓库的 workspace 身份约定一致。
export interface ProjectTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}
// 任务视图 = 共享 ZCodeTaskMeta（CLI 为事实源）加项目组织态；pinned 与 archived 只存在项目库。
// 因此 CLI 侧删掉任务后项目库可能仍留引用，读取方需按缺失或离线标记区分，不能当作已删除。
export type ProjectTask = import("@zcode/shared").ZCodeTaskMeta & {
  projectId: string | null;
  hostId: string;
  pinned: boolean;
  archived: boolean;
};
// 一次读取返回的项目与任务快照；deletedTasks 仅在显式请求时填充，未返回不等于已删除。
export interface ProjectTree {
  legacySingleRoot?: true;
  projects: VirtualProject[];
  tasks: ProjectTask[];
  /** 仅显式请求时返回删除事实；离线缺席不能替代这些引用。 */
  deletedTasks?: Array<ProjectTaskRef & { hostId: string }>;
}

// 旧单 root 项目的合成 ID 前缀：只是内存投影标识，不写入数据库，也不能用于反查持久项目。
export const LEGACY_SINGLE_ROOT_PROJECT_PREFIX = "legacy-single-root:";
// 字段全可选以同时表达新建与局部更新：带 id 为更新，restoreProjectId 用于恢复已删除项目。
export interface SaveProjectInput {
  id?: string;
  hostId?: string;
  name?: string;
  defaultName?: string;
  roots?: string[];
  primaryRoot?: string;
  pinned?: boolean;
  restoreProjectId?: string;
}
// 解析出的执行目录：workspacePath 用于文件操作、cwd 与 Git，workspaceIdentity 仅用于远端 attachment 匹配。
export interface ProjectDirectories {
  workspacePath: string;
  /** 远端装配层登记后的 attachment 身份；执行仍使用 workspacePath。 */
  workspaceIdentity?: string;
  additionalDirectories: string[];
  projectId: string | null;
}
export interface AutoArchiveInput {
  cutoff: number;
  activeTasks: readonly ProjectTaskRef[];
}
// 仓库接口在调用方给定的事务与快照语义内工作，自身不提交事务；写方法只改组织态，不动 CLI 数据。
export interface ProjectRepositoryContract {
  /** 单事务纯按 CLI 最后活动时间筛选，置顶与 activeTasks 除外，仅写组织态；覆盖未归类 cwd。 */
  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[];
  /** 可只取目录，并参与调用方已有的 SQLite 读快照。 */
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree;
  saveProject(input: SaveProjectInput): VirtualProject;
  deleteProject(id: string): void;
  /** 在写事务内只为空项目初始化 root；并发编辑已添加的目录优先。 */
  initializeProjectRoot(id: string, path: string): VirtualProject;
  // 迁移任务归属：既有 roots 保持不变，addMissingRoot 仅在目标项目缺该目录时补建，避免重复插入。
  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void;
  reorderProjects(ids: string[]): void;
  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories;
  /** CLI 创建之前原子预留归属；无事实的预留行不进入列表，重试不覆盖组织操作。 */
  reserveCreatedTask(input: {
    task: ProjectTaskRef;
    projectId: string | null;
    /** Host 已固化的执行目录；首次预留持久化，重试不改。undefined 为普通新建。 */
    additionalDirectories?: string[];
  }): ProjectDirectories;
}
