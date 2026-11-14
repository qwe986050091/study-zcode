// CLI 侧技能发现入口（skills list / inspect）。
//
// 门控与来源：
// - 必须同时满足 features.skill 与 skills.enabled，否则 list 返回空、inspect 抛「已禁用」；
// - extraRoots 是配置里的用户自定义根（原样传入），extraResolvedRoots 是插件技能根 + 内置技能包，
//   两者共享同一 discovery，保证 CLI 与 runtime 看到一致结果；
// - visualize 技能默认不注入，仅协议宿主草稿目录显式开启 includeVisualize；
// - disabledPaths 来自 skillOverrides，在发现阶段剔除（不是加载后隐藏）。
import { resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { Logger, SkillContent, SkillDiagnostic, SkillLoadOutcome } from "@zcode/contracts";
import { resolveBundledSkillRoots } from "./app/bundled-skills.js";
import { getCliStorageRoot } from "./app/paths.js";
import { filterVisualizeSkillRoots } from "./app/visualize-skill-gate.js";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeSkillsOptions {
  /** 环境变量表；影响配置、技能门控与路径解析。 */
  env?: NodeJS.ProcessEnv;
  /** 协议宿主草稿目录使用；CLI 命令缺省关闭。 */
  includeVisualize?: boolean;
  /** 插件/内置技能根解析的诊断日志出口。 */
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  /** 发现基准目录；缺省 cwd，决定项目级技能的可见范围。 */
  workingDirectory?: string;
}

export interface InspectZCodeSkillOptions extends ListZCodeSkillsOptions {
  name: string;
}

export interface ZCodeSkillInspection {
  diagnostics: SkillDiagnostic[];
  skill: SkillContent;
}

/**
 * 列出可见技能：禁用时返回结构完整的空结果（不抛错），否则委托适配器做只读发现。
 * 发现阶段的单文件错误通过 diagnostics 返回，不阻断其它技能。
 */
export async function listZCodeSkills(
  options: ListZCodeSkillsOptions = {},
): Promise<SkillLoadOutcome> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    return {
      diagnostics: [],
      skills: [],
      totalDiscovered: 0,
    };
  }

  return await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
}

/**
 * 读取单个技能正文：先校验启用态，再确认该名字存在（name 或 qualifiedName 任一命中），
 * 最后才 loadSkill。这样不存在/被禁用的技能不会产生额外读取副作用。
 * 未找到与禁用都直接抛错（CLI 需要非零退出），诊断随成功结果一起返回。
 */
export async function inspectZCodeSkill(
  options: InspectZCodeSkillOptions,
): Promise<ZCodeSkillInspection> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    throw new Error("Skills are disabled.");
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
  if (
    !outcome.skills.some(
      (skill) => skill.name === options.name || skill.qualifiedName === options.name,
    )
  ) {
    throw new Error(`Skill not found: ${options.name}`);
  }

  const skill = await discovery.skillPort.loadSkill({
    name: options.name,
    workingDirectory: discovery.workingDirectory,
  });

  return {
    diagnostics: outcome.diagnostics,
    skill,
  };
}

// 装配技能发现：workingDirectory 绝对化 → 解析配置 → 双重门控 → 收集插件/内置根。
// 注意 extraRoots 保留配置原值，让适配器按自身规则解析；extraResolvedRoots 是已解析绝对路径，
// 两者分开传是为了避免相对路径在适配器内被按错误基准展开。
function createSkillDiscovery(options: ListZCodeSkillsOptions):
  | {
      enabled: false;
      workingDirectory: string;
    }
  | {
      enabled: true;
      skillPort: ReturnType<typeof createNodeSkillAdapter>;
      workingDirectory: string;
    } {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });

  if (!configResult.config.features.skill || !configResult.config.skills.enabled) {
    return {
      enabled: false,
      workingDirectory,
    };
  }
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });

  // 内置技能包与插件技能根并列注入：`zcode skills list`、引用目录与 runtime 看到同一份发现结果。
  const bundledSkillRoots = resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
    logger: options.logger,
  });

  return {
    enabled: true,
    skillPort: createNodeSkillAdapter({
      extraRoots: configResult.config.skills.roots,
      extraResolvedRoots: [
        ...filterVisualizeSkillRoots(pluginOutcome.skillRoots, options.includeVisualize),
        ...bundledSkillRoots,
      ],
      disabledPaths: collectDisabledPaths(configResult.config.skillOverrides),
    }),
    workingDirectory,
  };
}
