// 插件同步服务契约：本文件只声明接口与 RPC 频道，不含任何实现。
// 所有方法都返回 Promise，因为实现侧需要访问文件系统与远端用户存储。
// 导入导出以 archive（Uint8Array）为交换格式，避免契约里出现临时路径。
// overwrite 目前只允许 false：覆盖语义尚未开放，提前放行会被调用方误用。
// 方法命名与 shared 中的结果类型一一对应，新增能力需先落 shared 再改这里。
import type {
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 本地候选、远端状态、归档导入导出与写权限检查共同构成插件同步的完整能力面。
// 写权限是独立方法而非前置条件：调用方需要先显式询问，再决定是否展示导入入口。
// 新增方法必须同步加到 host 实现与 RPC handler，否则调用会在频道上超时。
export interface IPluginSyncService {
// 列出本地用户插件（只读）。返回结构由 shared 定义，services 不额外包装。
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
// 导出为压缩包；pluginIds 为空时的语义由实现决定，契约层不做兜底。
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<{
    archive: Uint8Array;
    archiveBytes: number;
    marketplaceId: string;
    pluginNames: string[];
  }>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
// 探测远端是否允许写入；失败以结果对象返回而不是抛错，便于 UI 直接展示原因。
// 该检查不能替代导入时的真实写入校验，只是入口处的提示。
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMarketplaceSourceArchive(params: { archive: Uint8Array; overwrite?: false }): Promise<{
    marketplaceId: string;
    path: string;
    status: "skipped" | "synced";
  }>;
}

// 频道描述符：服务发现与代理都以此为准，名称变更属于破坏性改动。
export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
);
