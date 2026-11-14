// 插件服务对外契约：只描述渲染层可调用的方法与参数形状，不含安装/启用逻辑本身。
// 所有方法以 workspacePath 定位工作区，workspaceIdentity 用于身份隔离（去重、绑定、缓存键）；
// 两者何时回退由实现决定，契约层不假定路径一定等于身份。
import type {
  PluginScope,
  PluginsOverviewResult,
  ZCodePluginsMarketplaceMutationResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 市场与插件是两级资源：操作插件时必须同时给出来源市场，
// 因为同名插件可能来自不同市场，仅凭名称无法唯一定位。
export interface IPluginsService {
// 总览是只读聚合：返回市场列表、已安装插件与启用状态的合并视图；
// 不分页，因为单个工作区的插件规模远小于任务列表。
  getOverview(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<PluginsOverviewResult>;
// 新增与移除市场以 source 或 marketplace 字符串标识，具体解析（地址、别名）留给实现，
// 契约层不固化来源格式，便于后续支持新的来源类型。
  addMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    source: string;
  }): Promise<void>;
// 移除市场不负责卸载其下已安装插件，调用方需自行处理依赖关系，避免隐式连锁删除。
  removeMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    marketplace: string;
  }): Promise<void>;
// marketplace 可选：缺省表示刷新全部已配置市场；
// 返回类型允许 void，表示该实现不回报逐市场的更新结果。
  updateMarketplace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    marketplace?: string;
  }): Promise<ZCodePluginsMarketplaceMutationResult | void>;
// 安装与卸载都用 scope 区分用户级与工作区级位置；
// 未指定 scope 时默认值由实现决定，契约层不固化，以免两端行为分叉。
  installPlugin(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
  }): Promise<void>;
  uninstallPlugin(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
  }): Promise<void>;
  setPluginEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    pluginName: string;
    marketplace: string;
    scope?: PluginScope;
    nativeScope?: "user" | "project" | "local";
    enabled: boolean;
  }): Promise<void>;
}

// 服务描述符仅绑定频道，实际实例在 Host 装配阶段创建；
// Plugins 频道是所有插件读写操作的唯一入口，渲染层不得绕过它直接访问磁盘。
export const IPluginsService = createServiceDescriptor<IPluginsService>(ServiceChannels.Plugins);
