// 窗口项目目录服务的公开契约：组合窗口内三个互相依赖的服务句柄。
// 边界：仅声明类型与通道描述符，不含实现；窗口生命周期由宿主管理。
// INV：项目、远端项目与变更通知须同源获取，跨窗口复用会让目录状态互相污染。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

// 变更事件不带载荷：目录内容由调用方按需重拉，避免事件流与快照出现顺序竞争。
export interface IWindowProjectChangesService {
  getCapabilities(): Promise<{ version: 1 }>;
  onDidChange: Event<void>;
}

/** 整组选择，避免把窗口项目与 Source 成员目录或广播混用。 */
export interface WindowProjectDirectoryServices {
  projectService: IProjectService;
  remoteProjectService: IRemoteProjectService;
  changesService: IWindowProjectChangesService;
}

// 窗口项目通道与全局项目通道刻意分离：窗口内可见范围受窗口态约束，不能复用全局订阅。
export const IWindowProjectService = createServiceDescriptor<IProjectService>(
  ServiceChannels.WindowProject,
);
// 远端项目句柄与本地句柄并列注册，路由由 owner/lease 决定，不能按 hostId 猜测。
export const IWindowRemoteProjectService = createServiceDescriptor<IRemoteProjectService>(
  ServiceChannels.WindowRemoteProjects,
);
export const IWindowProjectChangesService = createServiceDescriptor<IWindowProjectChangesService>(
  ServiceChannels.WindowProjectChanges,
);
