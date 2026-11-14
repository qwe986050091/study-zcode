// INV-01 只记计时事件：守住位置 全部导出函数；改错故障 启动埋点顺手改配置或插件状态。
// INV-02 插件事实唯一：守住位置 resolveStartupPlugins 返回值；改错故障 后续阶段重新发现一次插件。
// INV-03 抑制集合必须传入：守住位置 suppressedBuiltins；改错故障 已卸载的内置插件复活。
// INV-04 默认开启名单必须传入：守住位置 officialPluginsEnabledByDefault；改错故障 skills 列表显示启用但会话报找不到。
// INV-05 技能门在发现之后：守住位置 filterVisualizeSkillRoots；改错故障 未开 visualize 仍暴露该技能。
// INV-06 事件名与阶段固定：守住位置 event / stage 字段；改错故障 计时看板无法按阶段聚合。
// INV-07 只记来源布尔：守住位置 configSource* 字段；改错故障 配置内容进入日志。
// INV-08 只记计数：守住位置 mcpServerCount / toolCount；改错故障 工具名与密钥落盘。
// INV-09 阶段语义固定：守住位置 各函数注释中的 stage；改错故障 同名阶段出现两次导致耗时翻倍。
// INV-10 顺序由调用方保证：守住位置 本模块无内部状态；改错故障 埋点之间产生隐式依赖。
// INV-11 计时器由外部注入：守住位置 startupTimer 参数；改错故障 模块自建计时器，单测无法断言。
// INV-12 参数只读：守住位置 全部 input 解构；改错故障 调用方配置被就地改写。
// INV-13 resume 与注入状态入首事件：守住位置 startAppStartup 的 context；改错故障 无法解释冷启动差异。
// INV-14 调试摘要受 logger 级别约束：守住位置 logger.debug；改错故障 生产环境默认落盘调试信息。
//
// 模块职责：启动各阶段的计时与调试埋点，只产出事件，不承载业务状态。
// 阅读顺序：先看插件发现，再看四个阶段标记，最后看启动完成与调试摘要。
import type { ConfigResult } from "@zcode/adapters/config";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import type { StartupTimer } from "../startup-logging.js";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "./official-plugin-definitions.js";
import { getPluginStorageRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import { filterVisualizeSkillRoots } from "./visualize-skill-gate.js";

/**
 * 启动期插件发现：解析插件根（含官方内置 seed / 抑制集合）→ 同步发现 → visualize 技能门 →
 * 记一条 `resolve_plugins` 完成事件。
 *
 * 顺序敏感：`suppressedBuiltins` 必须在发现时传入，否则已卸载的内置插件会被重新解析出来；
 * `officialPluginsEnabledByDefault` 也必须在这里传（CLI 子命令路径同样要传），否则 shop 里显示
 * enabled、会话里却报 Skill not found。返回的 PluginLoadOutcome 是本次启动唯一的插件事实，
 * 后续 MCP / hooks / skillRoots 都从它派生，不另起第二次发现。
 */
// 再跑一次 discoverNodePluginsSync 会让 MCP 与 hooks 拿到第二份事实，两处 enabled 状态随即分叉。
export function resolveStartupPlugins(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  options: Pick<ZCodeAppOptions, "officialPluginRoots" | "pluginStorageRoot" | "includeVisualize">;
  startupTimer: StartupTimer;
  workingDirectory: string;
}): PluginLoadOutcome {
  // pluginStorageRoot 优先取 input.options.pluginStorageRoot，缺省才回落到 getPluginStorageRoot(cliStorageRoot)。
  const pluginStorageRoot =
    input.options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot);
  const pluginOutcome = discoverNodePluginsSync({
    config: input.configResult.config.plugins,
    env: input.env ?? process.env,
    officialPluginRoots: resolveOfficialPluginRoots({
      extraRoots: input.options.officialPluginRoots,
      logger: input.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(input.configResult.config.plugins.suppressedBuiltins),
    }),
    // defaultEnabled 的 official plugin (如 skill-creator) 只有在这里
    // 把名单传给 discoverNodePluginsSync 才会真正默认开启。CLI 子命令路径
    // (resolveZCodePlugins) 和应用启动路径都要传，否则 `/skill skill-creator` 在会话里
    // 报 "Skill not found: skill-creator"，但 `zcode plugins list` 却显示它是 enabled。
    // 默认开启名单必须显式传入。
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory: input.workingDirectory,
  });
  // skillRoots 在 discoverNodePluginsSync 的返回值上就地过滤，按 includeVisualize 收窄而非重新发现。
  pluginOutcome.skillRoots = filterVisualizeSkillRoots(
    pluginOutcome.skillRoots,
    input.options.includeVisualize,
  );
  // 插件结果只上报计数。
  input.startupTimer.mark("ZCode plugins resolved", {
    context: {
      commandRootCount: pluginOutcome.commandRoots.length,
      diagnosticCount: pluginOutcome.diagnostics.length,
      enabledPluginCount: pluginOutcome.plugins.filter((plugin) => plugin.enabled).length,
      hookCount: Object.values(pluginOutcome.hooks ?? {}).reduce(
        (sum, matchers) =>
          sum + (matchers ?? []).reduce((inner, matcher) => inner + matcher.hooks.length, 0),
        0,
      ),
      mcpServerCount: Object.keys(pluginOutcome.mcpServers).length,
      pluginCount: pluginOutcome.plugins.length,
      pluginStorageRoot,
      skillRootCount: pluginOutcome.skillRoots.length,
    },
    event: "bootstrap.app.startup.plugins.completed",
    stage: "resolve_plugins",
  });
  return pluginOutcome;
}

/** 启动计时起点（stage=start）：记录是否注入 model adapter 与是否 resume，用于解释后续阶段耗时。 */
// 首事件记录冷启动的两个前提。
export function startAppStartup(input: {
  hasInjectedModelAdapter: boolean;
  resume: boolean;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.start("ZCode app startup started", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      resume: input.resume,
    },
    event: "bootstrap.app.startup.started",
    stage: "start",
  });
}

/** 配置加载完成（stage=load_config）：只记 env / project / user 三个来源是否命中，不记配置内容。 */
// 配置阶段只记三个来源是否命中。
export function markConfigurationLoaded(input: {
  configResult: ConfigResult;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode app configuration loaded", {
    context: {
      configSourceEnv: input.configResult.sources.env,
      configSourceProject: input.configResult.sources.project.loaded,
      configSourceUser: input.configResult.sources.user.loaded,
    },
    event: "bootstrap.app.startup.config.completed",
    stage: "load_config",
  });
}

/** 存储适配器就绪（stage=initialize_storage）：记本进程是自有还是注入 store / artifact store。 */
// 两个布尔分开记：session store 与 artifact store 可以只注入其中一个，合并成一位会丢信息。
export function markStorageAdaptersInitialized(input: {
  cliStorageRoot: string;
  hasInjectedArtifactStore: boolean;
  hasInjectedSessionStore: boolean;
  startupTimer: StartupTimer;
  storageRoot: string;
}): void {
  input.startupTimer.mark("ZCode storage adapters initialized", {
    context: {
      hasInjectedArtifactStore: input.hasInjectedArtifactStore,
      hasInjectedSessionStore: input.hasInjectedSessionStore,
      cliStorageRoot: input.cliStorageRoot,
      storageRoot: input.storageRoot,
    },
    event: "bootstrap.app.startup.storage.completed",
    stage: "initialize_storage",
  });
}

/** MCP 适配器就绪（stage=initialize_mcp）：此时只完成配置合并 / 信任判定，连接仍由 runtime 按需建立。 */
// MCP 阶段只代表配置与信任就绪。
export function markMcpAdapterInitialized(input: {
  configuredMcpServers: Record<string, McpServerConfig>;
  hasInjectedMcpPort: boolean;
  mcpEnabled: boolean;
  startupTimer: StartupTimer;
  trustedMcpServerCount: number;
}): void {
  input.startupTimer.mark("ZCode MCP adapter initialized", {
    context: {
      hasInjectedMcpPort: input.hasInjectedMcpPort,
      mcpEnabled: input.mcpEnabled,
      mcpServerCount: Object.keys(input.configuredMcpServers).length,
      trustedMcpServerCount: input.trustedMcpServerCount,
    },
    event: "bootstrap.app.startup.mcp.completed",
    stage: "initialize_mcp",
  });
}

/** AgentRuntime 构造完成（stage=create_runtime）：此时三条 workflow 子装配线尚未挂上 facade。 */
// runtime 构造完成时子装配线尚未挂载。
export function markRuntimeConstructed(input: {
  hasInjectedModelAdapter: boolean;
  sessionId: string;
  startupTimer: StartupTimer;
}): void {
  input.startupTimer.mark("ZCode runtime constructed", {
    context: {
      hasInjectedModelAdapter: input.hasInjectedModelAdapter,
      sessionId: input.sessionId,
    },
    event: "bootstrap.app.startup.runtime.completed",
    stage: "create_runtime",
  });
}

/** 启动总完成（stage=total）：最后一条计时事件，此后 facade 已可接收输入。 */
// 总事件是最后一条计时记录。
export function completeAppStartup(input: {
  sessionId: string;
  startupTimer: StartupTimer;
  workingDirectory: string;
}): void {
  input.startupTimer.complete("ZCode app startup completed", {
    context: {
      sessionId: input.sessionId,
      workingDirectory: input.workingDirectory,
    },
    event: "bootstrap.app.startup.completed",
    stage: "total",
  });
}

/**
 * 调试级配置摘要：模式、权限来源与工具清单数量。
 * 只记计数与来源布尔，不落具体工具名 / Key；生产环境由 logger.debug 决定是否落盘。
 */
// 调试摘要只在 debug 级别输出。
export function debugRuntimeConfigResolved(input: {
  configResult: ConfigResult;
  logger: Logger;
  runtimeConfig: AgentRuntimeConfig;
}): void {
  // 字段均为计数或布尔，不含正文。
  input.logger.debug("Runtime config resolved", {
    mode: input.runtimeConfig.mode,
    module: "bootstrap",
    permissionAllowedToolCount: input.configResult.config.permission.allowedTools.length,
    permissionDisallowedToolCount: input.configResult.config.permission.disallowedTools.length,
    permissionSourceEnv: input.configResult.sources.env,
    permissionSourceUserConfig: input.configResult.sources.user.loaded,
  });
}
