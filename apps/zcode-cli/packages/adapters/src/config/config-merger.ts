// Config Merger - Merge configs by priority

/*
 * ============================================================
 * config / config-merger.ts —— 按 scope 优先级深合并配置
 *
 * 定位：把 System/User/Project/Env/Cli/Session 多层 RuntimeConfigPatch 依次叠加，
 * 低优先级先应用、高优先级覆盖；嵌套对象做深合并而非整体替换。
 *
 * 输入输出：mergeConfigs 接收 createPrioritizedConfig 产出的条目，返回合并后的 patch；
 * 纯函数，无 IO/副作用。
 *
 * 失败语义：无异常路径；输入不合法（缺 priority）由调用方保证。
 *
 * 不变量：Project 层的 extraKnownMarketplaces 一律被丢弃；plugins 的 dirs/enabledPlugins/
 * options/extraKnownMarketplaces 跨层合并；hooks 只追加事件，enabled 取“任一为 true”。
 * ============================================================
 */

import type {
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, ConfigScopePriority } from "@zcode/contracts";

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  /** 该层的配置片段。 */
  config: RuntimeConfigPatch;
  /** 来源 scope，决定特殊规则（Project 的 marketplace 过滤）。 */
  scope: ConfigScope;
  /** 数值优先级，越大越后应用（越高优先）。 */
  priority: number;
}

/**
 * 按 priority 升序逐层合并，返回新对象且不修改入参。
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 *
 * 每个已知子对象做属性级浅合并；plugins/hooks 有更细的跨层规则；
 * Project 层会在合并前剔除 extraKnownMarketplaces。
 * 无副作用、无失败路径。
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  const result: RuntimeConfigPatch = {};

  for (const { config: inputConfig, scope } of sorted) {
    const config =
      scope === ConfigScope.Project && inputConfig.plugins
        ? (() => {
            // Marketplace 是 Host User inventory 的目录配置，不属于 Workspace 项目配置。
            // 保留 schema 兼容旧文件，但不能让项目层字段进入 merged RuntimeConfig/catalog。
            const projectPlugins = { ...inputConfig.plugins };
            delete projectPlugins.extraKnownMarketplaces;
            return { ...inputConfig, plugins: projectPlugins };
          })()
        : inputConfig;
    const previousHooks = result.hooks;
    const previousPlugins = result.plugins;
    Object.assign(result, config);

    // Deep merge nested objects
    if (config.modelStream) {
      result.modelStream = { ...result.modelStream, ...config.modelStream };
    }
    if (config.permission) {
      result.permission = { ...result.permission, ...config.permission };
    }
    if (config.storage) {
      result.storage = { ...result.storage, ...config.storage };
    }
    if (config.network) {
      result.network = { ...result.network, ...config.network };
    }
    if (config.features) {
      result.features = { ...result.features, ...config.features };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.mcp) {
      result.mcp = {
        ...result.mcp,
        ...config.mcp,
        servers: {
          ...result.mcp?.servers,
          ...config.mcp.servers,
        },
      };
    }
    if (config.plugins) {
      // Workspace Plugin 配置和 User Plugin 配置共用同一个 RuntimeConfig，不能让后一个
      // `plugins` 对象整体覆盖前一个来源；否则 Workspace 只声明一个插件时会丢掉 User
      // 的其它启用项和 options。enabledPlugins 按 pluginId、options 按 pluginId/option key
      // 合并，dirs 保留两层候选根目录，最终 resolver 再做去重和路径校验。
      result.plugins = {
        // Object.assign 已先把 result.plugins 指向当前高优先级层。若这里只展开
        // result.plugins，Workspace 仅写 options 时会把 User 层 dirs 整体丢掉，导致下一次
        // configure 连插件本身都无法发现。必须显式从 previousPlugins 开始构造。
        ...previousPlugins,
        ...config.plugins,
        ...(config.plugins.dirs
          ? {
              dirs: [...new Set([...(previousPlugins?.dirs ?? []), ...config.plugins.dirs])],
            }
          : {}),
        ...(config.plugins.enabledPlugins
          ? {
              enabledPlugins: {
                ...previousPlugins?.enabledPlugins,
                ...config.plugins.enabledPlugins,
              },
            }
          : {}),
        ...(config.plugins.extraKnownMarketplaces
          ? {
              extraKnownMarketplaces: {
                ...previousPlugins?.extraKnownMarketplaces,
                ...config.plugins.extraKnownMarketplaces,
              },
            }
          : {}),
        ...(config.plugins.options
          ? {
              options: mergePluginOptions(previousPlugins?.options, config.plugins.options),
            }
          : {}),
      };
    }
    if (config.skills) {
      result.skills = {
        ...result.skills,
        ...config.skills,
      };
    }
    if (config.skillOverrides) {
      result.skillOverrides = {
        ...result.skillOverrides,
        ...config.skillOverrides,
      };
    }
    if (config.commandOverrides) {
      result.commandOverrides = {
        ...result.commandOverrides,
        ...config.commandOverrides,
      };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.recording) {
      result.recording = {
        ...result.recording,
        conversation: {
          ...result.recording?.conversation,
          ...config.recording.conversation,
        },
      };
    }
    if (config.toolConcurrency) {
      result.toolConcurrency = { ...result.toolConcurrency, ...config.toolConcurrency };
    }
    if (config.modelAnomalyGuard) {
      result.modelAnomalyGuard = {
        ...result.modelAnomalyGuard,
        ...config.modelAnomalyGuard,
      };
    }
    if (config.hooks) {
      result.hooks = mergeHooksConfig(previousHooks, config.hooks);
    }
    if (config.ui) {
      result.ui = { ...result.ui, ...config.ui };
    }
  }

  return result;
}

/**
 * 两层 plugin options 合并：pluginId 维度整体合并，同名 option key 由 next 覆盖。
 * 上层未声明即沿用下层（与 enabledPlugins 一致），不做删除语义。
 */
function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...(current ?? {}) };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...(merged[pluginId] ?? {}),
      ...options,
    };
  }
  return merged;
}

/**
 * 合并 hooks：事件按来源追加、不覆盖；enabled 为各层 OR。
 * 这样 Project 的 enabled:false 不会关闭 User hooks。
 */
function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // project hooks 不能整体覆盖 user hooks，空的 project `enabled:false` 也不能
  // 关闭 user hooks。每个配置文件只控制自己的事件，因此仅在该来源启用时追加事件，
  // effective enabled 由任一已启用来源决定。
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * 由 scope 查询数值优先级（越大越后应用）。
 * Get priority for a config scope
 * 优先级只在 ConfigScopePriority 中定义一处，避免各 adapter 自行硬编码顺序。
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * 创建带优先级的配置条目（mergeConfigs 的输入单元），不修改传入 patch。
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
