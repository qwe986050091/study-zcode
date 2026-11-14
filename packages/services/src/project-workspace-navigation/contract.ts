// 本文件定义 Window Host 侧的工程/工作区导航协议：把「打开哪个工程、用哪个远端宿主」收敛为一次 prepare。
// 调用方（main / renderer）只消费结果，不解释 project/task 语义，也不创建物理连接。
// INV：目录解析与远端 admission 必须由 Window Host 同一所有者完成，否则两个作用域会各自持有 provisional 连接并在 Registry 提交前互相覆盖。
import type { IProjectService, ProjectDirectories } from "#src/project/contract.js";
import type { IRemoteProjectService, RemoteProjectHost } from "#src/remote-projects/contract.js";
import type { WindowHostRemoteWorkspaceDescriptor } from "@zcode/shared";
export type { ProjectDirectories, WindowHostRemoteWorkspaceDescriptor };
// request 同时容纳本地草稿与远端任务两种入口；hostId 只做路由，不代表物理连接已建立。
export interface ProjectNavigationRequest {
  projectId?: string | null;
  hostId?: string;
  draftId?: string;
  reuseDraft?: boolean;
  task?: { taskId: string; workspaceKey: string };
}
// directories 与 remote 必须来自同一次解析：两者不配对时，后续文件操作会落到错误的 workspaceIdentity 上。
// remote 只由 Registry admission 填充，本地工程不应伪造该字段。
export interface ProjectNavigationResult extends ProjectDirectories {
  hostId: string;
  /** 由窗口 Registry admission 返回；本地没有远端 descriptor。 */
  remote?: WindowHostRemoteWorkspaceDescriptor;
}
// 端口按需裁剪 IProjectService 能力，避免导航层顺手触发会话启动等副作用。
export interface ProjectNavigationPort {
  projectService: Pick<
    IProjectService,
    "readProjects" | "readTree" | "prepareSession" | "resolveSessionDirectories"
  >;
  remoteProjectService: Pick<IRemoteProjectService, "readDirectory">;
  readConnectionOwner(hostId: string): object | undefined;
  /** 仅复用在线物理连接；在 Registry 提交前 await assertCurrent，失败只回收自己的 provisional scope。 */
  openRemoteWorkspace(input: {
    host: RemoteProjectHost;
    directories: ProjectDirectories;
    owner: object;
    assertCurrent(): Promise<void>;
  }): Promise<WindowHostRemoteWorkspaceDescriptor>;
}
/** Window Host 负责目录解析和 admission；main 不解释 project/task，也不创建物理连接。 */
export interface ProjectWorkspaceNavigation {
  prepare(request: ProjectNavigationRequest): Promise<ProjectNavigationResult>;
}
