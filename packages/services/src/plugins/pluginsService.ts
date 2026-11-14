/**
 * ============================================================================
 * services/plugins/pluginsService.ts —— 已退役的旧插件管理实现
 * ============================================================================
 *
 * 【重要】本文件是兼容壳，不是插件能力的真实实现：
 *   - getOverview 返回 capability.supported=false 的空概览；
 *   - 所有变更方法统一抛 "Legacy plugin management has been retired"。
 *
 * 【为什么保留】旧协议/旧客户端仍可能调用 IPluginsService；保留明确的退役响应，
 *   比删除后返回未定义行为更容易诊断。真正的插件事实源在 zcode-cli 进程
 *   （读写 ~/.zcode 插件目录并热更新运行态），Host 侧经
 *   pluginManagementService 转发 agent 协议往返，不保存副本。
 *
 * 【不要在这里加新能力】新增插件功能应走 pluginManagement /
 *   IZCodeAgentService 的 V4 路径，而不是复活本文件。
 * ============================================================================
 */
// 兼容壳追加说明：本文件仅承载旧 IPluginsService 的显式退役语义，不读盘、不缓存、不转发。
// INV：getOverview 恒返回 supported=false 的空概览，所有变更方法恒抛同一错误文案，便于旧客户端识别。
// 边界：插件目录读写与热更新归 zcode-cli 进程，Host 侧经 pluginManagementService 转发，禁止在此补实现。
// 改错后果：若在此恢复部分能力，会出现两套事实源，运行态与用户可见状态长期不一致。
import type { PluginScope, PluginsOverviewResult } from "@zcode/shared";
import type { IPluginsService } from "./plugins.js";

interface PluginsServiceOptions {
  isDesktopRuntime?: boolean;
}

function createRetiredOverview(): PluginsOverviewResult {
  return {
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    capability: { supported: false },
  };
}

function throwRetiredPluginManagement(): never {
  throw new Error("Legacy plugin management has been retired in ZCode Agent mode");
}

// 工厂不依赖 isDesktopRuntime：退役响应在桌面与 Web 端保持一致，避免按运行时分支产生行为差异。
export function createPluginsService(_options?: PluginsServiceOptions): IPluginsService {
  return {
    async getOverview(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<PluginsOverviewResult> {
      return createRetiredOverview();
    },

    async addMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      source: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async removeMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      marketplace: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async updateMarketplace(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      marketplace?: string;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async installPlugin(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async uninstallPlugin(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },

    async setPluginEnabled(_params: {
      workspacePath: string;
      workspaceIdentity?: string;
      pluginName: string;
      marketplace: string;
      scope?: PluginScope;
      nativeScope?: "user" | "project" | "local";
      enabled: boolean;
    }): Promise<void> {
      throwRetiredPluginManagement();
    },
  };
}
