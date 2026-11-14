// Config Factory - Load and merge all config sources

/*
 * ============================================================
 * config / config-factory.ts —— 配置总装配
 *
 * 定位：按固定优先级加载默认/用户/项目/环境/CLI 五层配置，合并后生成 ConfigPort，
 * 并回传每层来源与诊断，供 CLI/设置页判断“配置到底来自哪”。
 *
 * 优先级（低→高）：System 默认 < 用户 config.json < 项目配置（根→cwd，再显式路径）
 * < ZCODE_* 环境变量 < CLI 覆盖。MCP server 是例外：user 反而覆盖 project（见
 * resolveEffectiveMcpServers），但不改变其余字段的全局优先级。
 *
 * 副作用：读取配置文件、写诊断日志（warn）；不写配置；不发起网络。
 *
 * 失败语义：单个文件解析失败只产生 diagnostics 并跳过；合并/ConfigPort 构造不抛错。
 *
 * 不变量：Project hooks 不进入可执行配置，只经 workspaceHookSnapshot 旁路；同一
 * runtimeRoot 必须同时用于 snapshot 与下游 toggle 校验。
 * ============================================================
 */

import { resolve } from "node:path";
import type {
  ConfigPort,
  HookConfigSource,
  LoggerFactory,
  McpServerConfig,
  RuntimeConfig,
  RuntimeConfigPatch,
  WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  ConfigScope,
  DefaultRuntimeConfig,
  createWorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  buildWorkspaceHookBundleSnapshot,
  resolveWorkspaceHookRuntimeRoot,
  type WorkspaceHookRuntimeRoot,
} from "@zcode/shared/workspace-hook-discovery";
import { createConfigPort } from "./index.js";
import { loadFileConfig, getDefaultConfigPath, type LoadedConfig } from "./file-config.adapter.js";
import { parseEnvConfig } from "./env-config.adapter.js";
import { mergeConfigs, createPrioritizedConfig } from "./config-merger.js";
import { createNodeLoggerFactory } from "../logging/index.js";
import {
  loadProjectConfigFile,
  loadProjectConfigs,
  summarizeProjectConfigs,
  type ProjectConfigDiscovery,
  type ProjectConfigFile,
} from "./project-config.adapter.js";

export interface ConfigFactoryOptions {
  /** Path to user config file (default: ~/.zcode/cli/config.json) */
  userConfigPath?: string;
  /** Path to project config file */
  projectConfigPath?: string;
  /** Working directory used to discover project config files */
  workingDirectory?: string;
  /** Opaque workspace identity supplied by the existing Host resolver; local callers fall back to workspacePath. */
  workspaceIdentity?: string;
  /** Environment variables (default: process.env) */
  env?: Record<string, string | undefined>;
  /** CLI overrides (highest priority) */
  cliOverrides?: RuntimeConfigPatch;
  /** Skip loading user config file */
  skipUserConfig?: boolean;
  /** Optional logger factory for tests or embedding runtimes. Defaults to the node JSONL logger. */
  loggerFactory?: LoggerFactory;
}

export interface ConfigResult {
  /** 合并后的运行时配置端口（支持 observe/set）。 */
  configPort: ConfigPort;
  /** 合并结果的快照（等价于 configPort.getAll()）。 */
  config: RuntimeConfig;
  sources: {
    /** 用户配置文件来源：路径、是否加载、诊断与关键字段标记。 */
    user: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string;
      loaded: boolean;
      hasMcpServers: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      mcpServerNames: string[];
    };
    /** 项目配置来源：多文件路径、逐字段来源路径与 hook 旁路快照。 */
    project: {
      diagnostics: LoadedConfig["diagnostics"];
      path: string | undefined;
      paths: string[];
      loaded: boolean;
      hasUiLocale: boolean;
      hasUiTheme: boolean;
      hasMcpServers: boolean;
      mcpServerNames: string[];
      /** 实际决定 ui.locale 的文件路径（最后一个声明者）。 */
      uiLocalePath: string | undefined;
      /** 实际决定 ui.theme 的文件路径（最后一个声明者）。 */
      uiThemePath: string | undefined;
      workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
      /**
       * 审核请求与「审核中 toggle」曾各自推导 runtimeRoot（前者遍历
       * default/user/project/env/cli 全部层，后者只读单层 runtimeConfig.hooks），
       * 两者只要有一处不同就产生不同 bundleDigest，toggle 会被误判为
       * workspace_hooks_snapshot_mismatch。这里导出快照实际使用的 runtimeRoot，
       * 让下游复用同一个值，把一致性变成结构性约束而不是巧合。
       */
      workspaceHookRuntimeRoot?: WorkspaceHookRuntimeRoot;
    };
    /** 插件配置来源（enabled/marketplaces/options/dirs 的 scope 归属）。 */
    plugins: PluginConfigSources;
    /** 每个 MCP server 最终来源层。 */
    mcp: {
      serverSources: Record<string, McpServerConfigSource>;
    };
    /** 是否解析到任何 ZCODE_* 变量。 */
    env: boolean;
    /** 是否提供了 CLI 覆盖。 */
    cli: boolean;
  };
}

type OptionalPathLoadedConfig = Omit<LoadedConfig, "path"> & {
  /** 无有效项目配置时为 undefined。 */
  path: string | undefined;
};

export type McpServerConfigSource = "system" | "project" | "user" | "env" | "cli";
export type PluginConfigScope = "user" | "workspace";

export interface PluginConfigSources {
  /** 两层候选插件根目录（user/workspace），保留重复由 resolver 去重。 */
  dirs: {
    user: string[];
    workspace: string[];
  };
  /** enabledPlugins 的 key → 最后声明它的 scope。 */
  enabled: Record<string, PluginConfigScope>;
  /** extraKnownMarketplaces 的 key → 来源 scope（Project 层被过滤后通常只有 user）。 */
  marketplaces: Record<string, PluginConfigScope>;
  /** pluginId → option key → 来源 scope。 */
  options: Record<string, Record<string, PluginConfigScope>>;
  /** 两层配置文件路径，便于 UI 展示与写入定位。 */
  paths: {
    user: string;
    workspace: string | undefined;
  };
}

/**
 * Create ConfigPort with all sources merged
 *
 * Priority (lowest to highest):
 * 1. System defaults
 * 2. User config file (~/.zcode/cli/config.json)
 * 3. Project config files (root to cwd, then explicit projectConfigPath)
 * 4. Environment variables (ZCODE_*)
 * 5. CLI overrides
 *
 * 流程：逐层构造 PrioritizedConfig → 汇总项目配置并写诊断 → 推导 hook runtimeRoot/
 * snapshot → mergeConfigs → 解析插件与 MCP 来源 → createConfigPort。副作用仅读文件与
 * 写 warn 日志。
 */
export function createConfig(options: ConfigFactoryOptions = {}): ConfigResult {
  // 1. System defaults
  const configs: ReturnType<typeof createPrioritizedConfig>[] = [
    createPrioritizedConfig(DefaultRuntimeConfig, ConfigScope.System),
  ];

  // 2. User config file
  const userConfigResult: LoadedConfig = options.skipUserConfig
    ? { config: {}, diagnostics: [], path: getDefaultConfigPath(), loaded: false }
    : loadFileConfig(options.userConfigPath);

  if (userConfigResult.loaded) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(userConfigResult.config, {
          kind: "user",
          path: userConfigResult.path,
        }),
        ConfigScope.User,
      ),
    );
  }

  // 3. Project config files
  const discoveredProjectConfigs: ProjectConfigDiscovery = options.workingDirectory
    ? loadProjectConfigs(options.workingDirectory, options.projectConfigPath)
    : options.projectConfigPath
      ? summarizeProjectConfigs([
          loadProjectConfigFile(options.projectConfigPath, {
            discoveryOrder: 0,
            explicitProjectConfig: true,
          }),
        ])
      : summarizeProjectConfigs([]);
  // explicit 配置曾在 auto-discovery 之后手工追加并自行编号，绕过 shared
  // canonical-path dedup；同一文件会进入 snapshot 两次并使既有 Trust 全部 stale。
  // 修法：有 workspace 时由 loadProjectConfigs 统一走 discoverWorkspaceHookConfigPaths，
  // 去重、失败候选占位和 discoveryOrder 均与 Settings builder 同源。
  const projectConfigFiles = discoveredProjectConfigs.files;
  const projectSummary = discoveredProjectConfigs;
  const projectDiagnostics = discoveredProjectConfigs.diagnostics;
  // 配置 diagnostics 过去只返回给调用方，用户导出日志时看不到加载失败或被跳过的 MCP server。
  // 在汇总入口统一写 warn，保留具体文件路径和 JSON path，方便定位迁移配置问题。
  logConfigDiagnostics({
    env: options.env,
    loggerFactory: options.loggerFactory,
    projectDiagnostics,
    userDiagnostics: userConfigResult.diagnostics,
  });
  const projectConfigResult: OptionalPathLoadedConfig =
    summarizeOptionalProjectConfig(projectConfigFiles);
  const projectUiLocalePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.locale !== undefined)?.path;
  const projectUiThemePath = [...projectConfigFiles]
    .reverse()
    .find((file) => file.config.ui?.theme !== undefined)?.path;

  for (const projectConfig of projectConfigFiles) {
    configs.push(createPrioritizedConfig(projectConfig.config, ConfigScope.Project));
  }

  // 4. Environment variables
  const envConfig = parseEnvConfig(options.env ?? process.env);
  if (Object.keys(envConfig).length > 0) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(envConfig, { kind: "internal" }),
        ConfigScope.Env,
      ),
    );
  }

  // 5. CLI overrides (applied last = highest priority)
  if (options.cliOverrides) {
    configs.push(
      createPrioritizedConfig(
        withHookConfigSource(options.cliOverrides, { kind: "internal" }),
        ConfigScope.Cli,
      ),
    );
  }

  const workspaceHookRuntimeRoot = resolveWorkspaceHookRuntimeRoot([
    DefaultRuntimeConfig.hooks,
    userConfigResult.config.hooks,
    ...projectSummary.hookCandidates.map((candidate) => candidate.hooks),
    envConfig.hooks,
    options.cliOverrides?.hooks,
  ]);
  const workspacePath = resolve(options.workingDirectory ?? process.cwd());
  const workspaceHookSnapshotData = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: options.workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    sources: projectSummary.hookCandidates,
    runtimeRoot: workspaceHookRuntimeRoot,
  });
  const workspaceHookSnapshot = workspaceHookSnapshotData
    ? createWorkspaceHookBundleSnapshot(workspaceHookSnapshotData)
    : undefined;

  // Project Hook events stay outside this executable merge. The snapshot above is the only
  // Phase 1 side-channel and cannot be consumed by configured-runner.
  const merged = mergeConfigs(...configs);
  const pluginConfigSources = resolvePluginConfigSources({
    projectConfig: projectConfigResult.config,
    projectPath: projectConfigResult.path,
    userConfig: userConfigResult.config,
    userPath: userConfigResult.path,
  });
  const mcpServerResolution = resolveEffectiveMcpServers({
    cliOverrides: options.cliOverrides,
    envConfig,
    projectConfig: projectConfigResult.config,
    userConfig: userConfigResult.config,
  });
  merged.mcp = {
    ...merged.mcp,
    servers: mcpServerResolution.servers,
  };

  // Create ConfigPort with merged config
  const configPort = createConfigPort(merged);

  return {
    configPort,
    config: configPort.getAll(),
    sources: {
      user: {
        diagnostics: userConfigResult.diagnostics,
        path: userConfigResult.path,
        loaded: userConfigResult.loaded,
        hasMcpServers: userConfigResult.config.mcp?.servers !== undefined,
        hasUiLocale: userConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: userConfigResult.config.ui?.theme !== undefined,
        mcpServerNames: Object.keys(userConfigResult.config.mcp?.servers ?? {}),
      },
      project: {
        diagnostics: projectDiagnostics,
        path: projectConfigResult.path,
        paths: projectSummary.paths,
        loaded: projectConfigResult.loaded,
        hasUiLocale: projectConfigResult.config.ui?.locale !== undefined,
        hasUiTheme: projectConfigResult.config.ui?.theme !== undefined,
        hasMcpServers: projectConfigResult.config.mcp?.servers !== undefined,
        mcpServerNames: projectSummary.mcpServerNames,
        uiLocalePath: projectUiLocalePath,
        uiThemePath: projectUiThemePath,
        ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
        workspaceHookRuntimeRoot,
      },
      plugins: pluginConfigSources,
      mcp: {
        serverSources: mcpServerResolution.sources,
      },
      env: Object.keys(envConfig).length > 0,
      cli: !!options.cliOverrides,
    },
  };
}

/**
 * 汇总插件配置的来源归属。
 *
 * 只记录“哪个 scope 声明了 enabled/marketplace/option”，不合并值本身（合并已在
 * mergeConfigs 完成）。workspace 声明会覆盖同名 user 归属（最后声明者胜出），
 * 便于 UI 展示“这项来自项目配置”。
 */
function resolvePluginConfigSources(input: {
  projectConfig: RuntimeConfigPatch;
  projectPath: string | undefined;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginConfigSources {
  const enabled: Record<string, PluginConfigScope> = {};
  const marketplaces: Record<string, PluginConfigScope> = {};
  const options: Record<string, Record<string, PluginConfigScope>> = {};

  for (const pluginId of Object.keys(input.userConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "user";
  }
  for (const pluginId of Object.keys(input.projectConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "workspace";
  }

  for (const marketplaceId of Object.keys(input.userConfig.plugins?.extraKnownMarketplaces ?? {})) {
    marketplaces[marketplaceId] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(input.userConfig.plugins?.options ?? {})) {
    options[pluginId] = {};
    for (const key of Object.keys(pluginOptions)) options[pluginId][key] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(
    input.projectConfig.plugins?.options ?? {},
  )) {
    const sourceByKey = (options[pluginId] ??= {});
    for (const key of Object.keys(pluginOptions)) sourceByKey[key] = "workspace";
  }

  return {
    dirs: {
      user: input.userConfig.plugins?.dirs ?? [],
      workspace: input.projectConfig.plugins?.dirs ?? [],
    },
    enabled,
    marketplaces,
    options,
    paths: {
      user: input.userPath,
      workspace: input.projectPath,
    },
  };
}

/**
 * 给配置中的每个 hook 补齐来源（source），不改写已有 source。
 *
 * 用户文件来源标记为 {kind:"user", path}，env/cli 标记为 {kind:"internal"}；
 * 无 hooks/events 时直接返回原对象，避免无谓拷贝。
 */
function withHookConfigSource(
  config: RuntimeConfigPatch,
  source: HookConfigSource,
): RuntimeConfigPatch {
  if (!config.hooks?.events) return config;
  return {
    ...config,
    hooks: {
      ...config.hooks,
      events: Object.fromEntries(
        Object.entries(config.hooks.events).map(([eventName, matchers]) => [
          eventName,
          matchers?.map((matcher) => ({
            ...matcher,
            hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
          })),
        ]),
      ) as NonNullable<RuntimeConfigPatch["hooks"]>["events"],
    },
  };
}

/**
 * 计算工作区存储目录：env 层 > 项目层（后者覆盖前者，按发现顺序）> 基础配置。
 *
 * 这里只关心 storage.dir，不构造完整 ConfigPort，避免递归/副作用扩大；读取项目
 * 配置时仍走统一发现逻辑，保证与实际运行时一致。
 */
export function resolveWorkspaceStorageDir(input: {
  env?: Record<string, string | undefined>;
  workingDirectory: string;
}): string {
  const baseStorageDir = createConfig({ env: input.env }).config.storage.dir;
  const projectConfig = loadProjectConfigs(input.workingDirectory);
  let projectStorageDir: string | undefined;
  for (const file of projectConfig.files) {
    projectStorageDir = file.config.storage?.dir ?? projectStorageDir;
  }
  const envStorageDir = parseEnvConfig(input.env ?? process.env).storage?.dir;
  return envStorageDir ?? projectStorageDir ?? baseStorageDir;
}

/**
 * 解析最终生效的 MCP server 表及其来源层。
 *
 * 与全局配置优先级的唯一差异：user 覆盖 project（为兼容扩展发现规则），其余
 * system < project < user < env < cli 的覆盖顺序不变；同名 server 后应用者胜出。
 */
function resolveEffectiveMcpServers(input: {
  cliOverrides?: RuntimeConfigPatch;
  envConfig: RuntimeConfigPatch;
  projectConfig: RuntimeConfigPatch;
  userConfig: RuntimeConfigPatch;
}): {
  servers: Record<string, McpServerConfig>;
  sources: Record<string, McpServerConfigSource>;
} {
  const servers: Record<string, McpServerConfig> = {};
  const sources: Record<string, McpServerConfigSource> = {};
  const apply = (source: McpServerConfigSource, patch: RuntimeConfigPatch | undefined) => {
    for (const [name, server] of Object.entries(patch?.mcp?.servers ?? {})) {
      servers[name] = server;
      sources[name] = source;
    }
  };

  apply("system", DefaultRuntimeConfig);
  // MCP server discovery has an extension-specific rule: user config shadows project config.
  // This does not change the global config precedence for model/permission/UI fields.
  apply("project", input.projectConfig);
  apply("user", input.userConfig);
  apply("env", input.envConfig);
  apply("cli", input.cliOverrides);
  return { servers, sources };
}

/**
 * 把用户/项目配置诊断统一写 warn 日志（含文件路径与 JSON path）。
 *
 * 无诊断时不创建 logger；loggerFactory 可注入（测试/嵌入宿主），默认 node JSONL。
 * 单个诊断失败不应中断装配，但本函数本身不做额外 catch。
 */
function logConfigDiagnostics(input: {
  env?: Record<string, string | undefined>;
  loggerFactory?: LoggerFactory;
  projectDiagnostics: LoadedConfig["diagnostics"];
  userDiagnostics: LoadedConfig["diagnostics"];
}): void {
  const diagnostics = [
    ...input.userDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "user" })),
    ...input.projectDiagnostics.map((diagnostic) => ({ ...diagnostic, configScope: "project" })),
  ];
  if (diagnostics.length === 0) return;

  const loggerFactory = input.loggerFactory ?? createNodeLoggerFactory({ env: input.env });
  const logger = loggerFactory.createLogger("zcode").child({
    module: "adapters.config",
  });

  for (const diagnostic of diagnostics) {
    logger.warn(resolveConfigDiagnosticLogMessage(diagnostic.code), {
      configPath: diagnostic.filePath,
      configScope: diagnostic.configScope,
      diagnosticCode: diagnostic.code,
      diagnosticMessage: diagnostic.message,
      diagnosticPath: diagnostic.path,
      event: resolveConfigDiagnosticLogEvent(diagnostic.code),
      severity: diagnostic.severity,
    });
  }
}

/** 诊断 code → 人类可读告警文案；未知 code 统一归为“配置文件加载失败”。 */
function resolveConfigDiagnosticLogMessage(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "MCP server config skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "Project hooks pending workspace trust";
  }
  return "Config file failed to load";
}

/** 诊断 code → 稳定事件名（供日志检索/告警规则匹配）。 */
function resolveConfigDiagnosticLogEvent(
  code: LoadedConfig["diagnostics"][number]["code"],
): string {
  if (code === "config_mcp_server_invalid") return "config.mcp_server.skipped";
  if (code === "config_project_hooks_pending_trust") {
    return "config.project_hooks.pending_trust";
  }
  return "config.file.invalid";
}

/**
 * 把项目文件列表合并成单一加载结果（用于 sources 展示）。
 *
 * 无文件→empty/loaded=false；否则按 Project scope 合并配置、拼接诊断，path 取最后
 * 一个文件（即优先级最高的项目文件）。
 */
function summarizeOptionalProjectConfig(files: ProjectConfigFile[]): OptionalPathLoadedConfig {
  if (files.length === 0) {
    return { config: {}, diagnostics: [], path: undefined, loaded: false };
  }

  const path = files[files.length - 1]?.path;
  const config = mergeConfigs(
    ...files.map((file) => createPrioritizedConfig(file.config, ConfigScope.Project)),
  );

  return {
    config,
    diagnostics: files.flatMap((file) => file.diagnostics),
    path,
    loaded: true,
  };
}
