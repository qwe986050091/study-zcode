import type {
  ProjectDirectories,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";
import { ServiceChannels } from "@zcode/shared";
import type { FileEntry } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
// 项目服务契约：项目容器、目录树、任务归属与准备会话目录的对外接口，同时再导出 project-storage 类型。
// 边界：本层只声明语义与不变量，不访问 SQLite、不触碰文件系统，实现由当前所属 Host 提供。
// INV：hostId 缺省即当前 Host，跨 Host 写操作必须显式传递并拒绝越权，不能靠路径推断归属。
export { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project-storage/contract.js";
export type {
  ProjectDirectories,
  ProjectTask,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
  ProjectRoot,
} from "#src/project-storage/contract.js";

/** 当前 Host 的权威项目服务；远端通过现有 attachment 的服务代理调用。 */
// 读接口一律是只读投影，不启动 Agent、不触发自动归档；只有写接口才可改动快照与磁盘布局。
export interface IProjectService {
  /** 项目选目录只访问所属 Host 的文件服务；不建立 workspace 或启动 Agent。 */
  readDirectory(params?: {
    hostId?: string;
    path?: string;
    includeHidden?: boolean;
  }): Promise<{ path: string; entries: FileEntry[] }>;
  /** 配置目录与项目选择；所属 Host 派生主目录状态，不加载任务。 */
// 默认过滤软删项目；includeDeleted 只服务回收站视图，普通调用方误传 true 会破坏列表语义。
  readProjects(params?: { includeDeleted?: boolean; hostId?: string }): Promise<VirtualProject[]>;
  /** SQLite 快照与所属 Host 主目录状态的只读投影；不为查询启动 Agent，也不触发自动归档。 */
  readTree(params?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    hostId?: string;
  }): Promise<ProjectTree>;
  /** 提交前校验目录存在；root 改动不触碰既有任务 cwd。恢复必须明确给出 ID。 */
  saveProject(input: SaveProjectInput): Promise<VirtualProject>;
  /** 幂等软删除容器，保留任务归属与 roots。 */
  deleteProject(id: string, hostId?: string): Promise<void>;
  /** 跨 host 拒绝；缺 root 时必须明确 addMissingRoot 才原子加入并移动。 */
  moveTask(input: {
    task: ProjectTaskRef;
    projectId: string;
    hostId?: string;
    addMissingRoot?: boolean;
  }): Promise<void>;
// 全量 ID 重排需单事务完成；缺失或多余 ID 应整体拒绝而非部分应用，否则顺序不可预测。
  reorderProjects(ids: string[], hostId?: string): Promise<void>;
  /** 固化本次创建 cwd 并复检主目录；已配置目录失效时拒绝，空项目或全局任务才创建默认目录。 */
  prepareSession(params?: {
    projectId?: string;
    hostId?: string;
    draftId?: string;
    reuseDraft?: boolean;
  }): Promise<ProjectDirectories>;
  /** 缺 task = []，缺 project / DB 错误必须拒绝。软删项目仍可恢复历史任务。 */
  resolveSessionDirectories(task: ProjectTaskRef, hostId?: string): Promise<ProjectDirectories>;
}
// 通道名是跨进程路由键，必须与实现端一致；改名后只会在运行时暴露调用失败。
export const IProjectService = createServiceDescriptor<IProjectService>(ServiceChannels.Project);
