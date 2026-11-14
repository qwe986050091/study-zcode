// Source Server 工作区解析与迁移补偿契约：解析失败的路径不会自动清理，只能显式重试或放弃。
// 边界：只暴露计数与报告，不暴露源服务器内部目录布局，避免调用方依赖其路径规则。
// 不变量：failed 与 abandoned 互斥计数，同一条路径在任一时刻只能属于其中一种状态。
// 放弃是终止无限重试的唯一出口；缺了它，失败路径会永久残留在每次迁移报告里。
import type {
  SourceServerResolveWorkspaceRequest,
  SourceServerResolveWorkspaceResult,
  SourceServerMigrationPathAction,
  SourceServerMigrationReport,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// resolveWorkspace 必须幂等：重连或重放会让同一请求重复到达，不得因此产生第二份迁移记录。
// 报告是最近一次迁移的汇总，可能滞后于计数接口；调用方不要用它推导实时失败数量。
// 所有方法都可能跨进程调用，返回后不得假设远端目录状态仍然保持不变。
export interface ISourceServerWorkspaceService {
  resolveWorkspace(
    request: SourceServerResolveWorkspaceRequest,
  ): Promise<SourceServerResolveWorkspaceResult>;
  getFailedPathCount(): Promise<number>;
  getAbandonedPathCount(): Promise<number>;
  listMigrationReports(): Promise<SourceServerMigrationReport>;
  abandonFailedWorkspace(request: SourceServerMigrationPathAction): Promise<SourceServerMigrationReport>;
  retryWorkspaceMigration(request: SourceServerMigrationPathAction): Promise<SourceServerMigrationReport>;
}

export const ISourceServerWorkspaceService = createServiceDescriptor<ISourceServerWorkspaceService>(
  ServiceChannels.SourceServerWorkspace,
);
