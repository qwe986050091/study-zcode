import type { ConfigResult } from "@zcode/adapters/config";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  listZCodePlugins,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
} from "../plugins.js";
import type {
  ZCodeApp,
  ZCodeAppOptions,
  ZCodePluginSetResult,
  ZCodePluginUninstallResult,
} from "./types.js";

type PluginFacade = Pick<
  ZCodeApp,
  "listPlugins" | "setPluginEnabled" | "uninstallPlugin"
>;

interface CreatePluginFacadeOptions {
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  workingDirectory: string;
}

/**
 * App 级插件门面：在 configResult 之上维护本会话内的启用态 / 内置抑制态副本。
 *
 * 三个方法都直接转发到 `../plugins.js` 的真实实现，并在每次调用时把本地副本拼回
 * configResult——因为磁盘配置在一次会话内不会重读，若不镜像，set/uninstall 之后同一会话的
 * list 会按启动时的旧值解析（卸载的内置插件还会被重新发现）。
 * 失败语义：底层抛错原样上抛，本地副本不更新（只有成功结果才写回）。
 */
function createPluginFacade(options: CreatePluginFacadeOptions): PluginFacade {
  let enabledPlugins = { ...options.configResult.config.plugins.enabledPlugins };
  // 会话内还要镜像 suppressedBuiltins：卸载内置插件后若沿用启动时的旧抑制集合，后续 list
  // 会把它重新解析出来。和 enabledPlugins 同样维护本地副本，随卸载更新。
  let suppressedBuiltins = [...options.configResult.config.plugins.suppressedBuiltins];
  const commonOptions = () => ({
    configResult: currentConfigResult(options.configResult, enabledPlugins, suppressedBuiltins),
    env: options.env,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot: options.pluginStorageRoot,
    workingDirectory: options.workingDirectory,
  });

  return {
    listPlugins: async (): Promise<PluginLoadOutcome> => listZCodePlugins(commonOptions()),
    setPluginEnabled: async (
      plugin: string,
      enabled: boolean,
    ): Promise<ZCodePluginSetResult> => {
      const result = await setZCodePluginEnabled({
        ...commonOptions(),
        enabled,
        plugin,
      });
      enabledPlugins = {
        ...enabledPlugins,
        [result.plugin.id]: result.enabled,
      };
      return result;
    },
    uninstallPlugin: async (plugin: string): Promise<ZCodePluginUninstallResult> => {
      const removed = await uninstallZCodeMarketplacePlugin({
        ...commonOptions(),
        pluginId: plugin,
      });
      if (removed) {
        // 卸载会清掉 user config 里的 enabledPlugins[id]；同步本地缓存，避免后续 list 仍按旧值解析启用态。
        const next = { ...enabledPlugins };
        delete next[removed.id];
        enabledPlugins = next;
        // 内置（官方）插件卸载是写 suppressedBuiltins 标记；同步本地抑制集合，
        // 否则同一会话内后续 list 会用启动时的旧集合，把它重新解析出来。
        if (removed.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
          if (!suppressedBuiltins.includes(removed.id)) {
            suppressedBuiltins = [...suppressedBuiltins, removed.id];
          }
        }
      }
      return { removed };
    },
  };
}

/**
 * 从 createZCodeApp 的装配输入构造插件门面。
 *
 * 只读取 `configResult`（配置真相的一次快照）与 AppOptions 里的插件相关字段（env、官方插件
 * 根、插件 storage、工作目录）；返回值不持有 App 其他端口，关闭顺序与 App 无关。
 * 配置 revision 热更新不经过这里——门面内的副本只反映本会话内已成功执行的 set/uninstall。
 */
export function createPluginFacadeForApp(input: {
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  workingDirectory: string;
}): PluginFacade {
  return createPluginFacade({
    configResult: input.configResult,
    env: input.options.env,
    officialPluginRoots: input.options.officialPluginRoots,
    pluginStorageRoot: input.options.pluginStorageRoot,
    workingDirectory: input.workingDirectory,
  });
}

function currentConfigResult(
  configResult: ConfigResult,
  enabledPlugins: Record<string, boolean>,
  suppressedBuiltins: string[],
): ConfigResult {
  return {
    ...configResult,
    config: {
      ...configResult.config,
      plugins: {
        ...configResult.config.plugins,
        enabledPlugins,
        suppressedBuiltins,
      },
    },
  };
}
