// 项目目录聚合的端口契约：把本地虚拟项目读取与远端目录读取抽象为可注入依赖，供上层拼装统一目录视图。
// INV：projectService 只收敛到 readProjects，remoteProjectService 只收敛到 readDirectory，扩大 Pick 面会形成隐式耦合。
// INV：remoteProjectService 允许缺省，缺省即代表远端能力不可用，调用方须按空目录降级而不是抛错中断整个目录。
// 维护提示：快照字段属于跨进程传输结构，新增或改名需同步 schema，否则旧客户端会渲染出空白目录。
import type { IProjectService, VirtualProject } from "#src/project/contract.js";
import type {
  IRemoteProjectService,
  RemoteProjectDirectory,
} from "#src/remote-projects/contract.js";
export type { VirtualProject, RemoteProjectDirectory };
export interface ProjectCatalogPort {
  projectService: Pick<IProjectService, "readProjects">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
}
// 快照必须是可直接序列化的纯数据，放入类实例或函数会导致跨进程传输失败且难以定位。
export interface ProjectCatalogSnapshot {
  projects: VirtualProject[];
  directory: RemoteProjectDirectory;
}
