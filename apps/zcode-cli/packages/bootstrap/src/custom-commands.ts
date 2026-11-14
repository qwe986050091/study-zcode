// 自定义命令的「发现 / 读取」边界：配置 + 插件命令根 + 禁用覆盖合并后交给 adapters。
//
// 一次 discovery 固定做三件事：
// 1. createConfig 解析用户/项目配置（skipUserConfig 用于隔离测试或受限会话）；
// 2. resolveZCodePlugins 收集已启用插件的 commandRoots（插件命令与用户命令同池竞争）；
// 3. commandOverrides 转成 disabledPaths，交给 adapter 在枚举阶段剔除，避免仅靠 UI 隐藏。
// 本模块不执行命令，也不解析 prompt 展开；只负责「有哪些命令、内容是什么」。
import { resolve } from "node:path";
import { createConfig } from "@zcode/adapters/config";
import { createNodeCustomCommandAdapter } from "@zcode/adapters/commands";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  Logger,
} from "@zcode/contracts";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeCustomCommandsOptions {
  /** 环境变量表；影响配置解析、插件启用与目录根（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 用户主目录；测试可指向临时目录，避免读写真实 ~/.zcode。 */
  homeDirectory?: string;
  /** 诊断日志出口；插件解析告警也走这里。 */
  logger?: Logger;
  /** 项目配置路径覆盖；缺省按 workingDirectory 查找 .zcode 配置。 */
  projectConfigPath?: string;
  /** 跳过用户级配置（隔离/受限会话）；不影响项目级与插件。 */
  skipUserConfig?: boolean;
  /** 用户配置路径覆盖；与 homeDirectory 一起用于定位用户命令目录。 */
  userConfigPath?: string;
  /** 命令发现基准目录；缺省 process.cwd()，会影响项目级命令与相对路径。 */
  workingDirectory?: string;
  /** 额外命令根（多 workspace 场景）；与插件根并列参与发现。 */
  additionalDirectories?: readonly string[];
}

export interface InspectZCodeCustomCommandOptions extends ListZCodeCustomCommandsOptions {
  name: string;
}

export interface ZCodeCustomCommandInspection {
  command: CustomCommandContent;
  diagnostics: CustomCommandDiagnostic[];
}

/** 列命令只读发现：返回命令与诊断，不加载正文；单个坏文件通过 diagnostics 上报而非中断。 */
export async function listZCodeCustomCommands(
  options: ListZCodeCustomCommandsOptions = {},
): Promise<CustomCommandLoadOutcome> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.discoverCommands({
    workingDirectory: discovery.workingDirectory,
  });
}

/**
 * 按名字读取命令并附带发现期诊断；名字先归一（去前导 /、小写）再匹配。
 * 不存在时抛 "Custom command not found"，上层 prompt 解析据此转成 undefined。
 * 存在性检查在 load 之前进行：避免对不存在/被禁用的命令产生读取副作用。
 */
export async function inspectZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<ZCodeCustomCommandInspection> {
  const discovery = createCustomCommandDiscovery(options);
  const workingDirectory = discovery.workingDirectory;
  const adapter = discovery.adapter;
  const outcome = await adapter.discoverCommands({ workingDirectory });
  const normalizedName = normalizeCommandName(options.name);
  if (!outcome.commands.some((command) => command.name === normalizedName)) {
    throw new Error(`Custom command not found: ${options.name}`);
  }

  return {
    command: await adapter.loadCommand({
      name: normalizedName,
      workingDirectory,
    }),
    diagnostics: outcome.diagnostics,
  };
}

/**
 * 只读正文、不做存在性预检（调用方通常已从目录得知该命令存在）。
 * 名字同样归一化；读取失败（文件消失/权限/超限）直接上抛，由调用方决定降级还是报错。
 */
export async function loadZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<CustomCommandContent> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.loadCommand({
    name: normalizeCommandName(options.name),
    workingDirectory: discovery.workingDirectory,
  });
}

// 三个入口共用的装配：workingDirectory 绝对化后再解析配置（相对路径不能泄漏给 adapter）。
// disabledPaths 只在发现阶段生效，确保被禁用的插件/用户命令连诊断都不出现。
function createCustomCommandDiscovery(options: ListZCodeCustomCommandsOptions) {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });
  return {
    adapter: createNodeCustomCommandAdapter({
      extraResolvedRoots: pluginOutcome.commandRoots,
      disabledPaths: collectDisabledPaths(configResult.config.commandOverrides),
      homeDirectory: options.homeDirectory,
      additionalDirectories: options.additionalDirectories,
    }),
    workingDirectory,
  };
}

// 命令名的统一口径：trim、去掉任意数量前导斜杠、小写。三处调用必须一致，
// 否则目录展示名与查找名会分叉（例如 `/Foo` 与 `foo`）。
function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}
