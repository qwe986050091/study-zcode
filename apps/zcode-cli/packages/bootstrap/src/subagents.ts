// INV-01 迁移先于读取：守住位置 加载入口；改错故障 旧格式文件被当成新格式解析。
// INV-02 迁移失败保留原文件：守住位置 失败分支；改错故障 用户数据在迁移中被删。
// INV-03 迁移失败转诊断：守住位置 循环；改错故障 单个坏文件中断启动。
// INV-04 额外目录按解析路径去重：守住位置 Set 构造；改错故障 同一目录被读两次。
// INV-05 排除当前工作区：守住位置 比较；改错故障 同名目录自我嵌套。
// INV-06 额外目录以 basename 加前缀：守住位置 入队；改错故障 同名 profile 跨目录覆盖。
// INV-07 只读根目录直接文件：守住位置 列目录；改错故障 递归读取拖慢启动。
// INV-08 扩展名只认两种：守住位置 过滤；改错故障 无关文件被当成 profile。
// INV-09 列目录失败按空处理：守住位置 捕获；改错故障 首次启动因缺目录失败。
// INV-10 结果按路径排序：守住位置 排序；改错故障 诊断顺序随文件系统抖动。
// INV-11 解析统一交给纯函数：守住位置 调用；改错故障 禁用态与覆盖逻辑分散在多处。
// INV-12 只遍历已启用插件：守住位置 早退；改错故障 停用插件仍暴露 agent。
// INV-13 模板路径固定拼接：守住位置 路径构造；改错故障 模板里的任意路径被读取。
// INV-14 单模板失败只产诊断：守住位置 逐项处理；改错故障 一个坏模板阻断全部插件。
// INV-15 正名恒带插件前缀：守住位置 命名函数；改错故障 不同插件同名 agent 冲突。
// INV-16 裸名别名要求全局唯一：守住位置 计数；改错故障 别名指向不确定的实现。
// INV-17 保留名不给别名：守住位置 集合判断；改错故障 内置 agent 被插件顶替。
// INV-18 状态文件坏则退空：守住位置 捕获；改错故障 状态损坏导致无法启动。
//
// 模块职责：从用户、项目与插件来源汇总 Agent profile 与诊断。
// 状态所有权：无长驻状态；覆盖与禁用信息经参数传入。
// 阅读顺序：先看磁盘加载，再看插件模板，最后看命名与状态归一。
// 子代理（Agent Profile）加载边界：把用户/项目/额外 workspace 的 Markdown 与插件模板
// 汇总为 AgentProfile 列表，并应用禁用态与模型覆盖。
//
// - 用户目录统一做一次迁移（失败保留原文件并转成诊断），随后只读取根目录 *.md；
// - 项目目录只读当前 workspace，额外目录以 basename 作为 namespace，避免同名 profile 覆盖；
// - 插件模板走独立入口：只同步读取 enabled 插件声明过的 agents，解析失败不影响其它插件；
// - 名称规则：插件 profile 的正名恒为 `plugin:name`；裸名别名仅当全局唯一且不是保留名。
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseRuntimeSubagentConfig } from "./runtime-subagents/index.js";
import { migrateUserSubagentMarkdown, migrateSubagentStateFile } from "@zcode/shared/node";
import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
} from "@zcode/core";
import type { Logger, PluginMetadata } from "@zcode/contracts";
import {
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@zcode/shared";

interface LoadZCodeAgentProfilesInput {
  /** 诊断与迁移失败日志出口。 */
  logger?: Logger;
  /** CLI 存储根；用户 agents 目录与 v2 状态文件都在此下。 */
  storageRoot: string;
  /** 当前 workspace；用于定位 <cwd>/.zcode/agents。 */
  workingDirectory: string;
  /** 额外 workspace 根；去重后以 basename 加 namespace 前缀。 */
  additionalDirectories?: readonly string[];
}

interface LoadZCodeAgentProfilesResult {
  /** 内置 profile 的模型覆盖（把 agents-state.json 中合法选择透传出去）。 */
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  /** 插件 profile 的模型覆盖，key 为 pluginId:bareName 派生 id。 */
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  /** 迁移失败与解析诊断合并结果（不抛错，由调用方决定展示）。 */
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}

interface LoadPluginAgentProfilesInput {
  logger?: Logger;
  plugins: readonly PluginMetadata[];
  reservedProfileNames?: Iterable<string>;
  /** 来自已完成存储迁移的启动快照；不在插件 loader 另读磁盘或查询账号。 */
  modelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
}

interface ParsedPluginAgentProfile {
  bareName: string;
  plugin: PluginMetadata;
  profile: AgentProfile;
}

const RESERVED_AGENT_NAMES = new Set(["general-purpose", "Explore"]);

/**
 * 加载所有磁盘来源的 Agent profile（不含插件）。
 *
 * 顺序：先迁移用户 Markdown 与 v2 状态文件（失败保留原文件），再并行读取所有根目录，
 * 最后交给纯解析器 parseRuntimeSubagentConfig 统一应用 disabled/模型覆盖。
 * 额外目录按 resolve 后去重并排除当前 workspace，避免同一目录被读两次或自我嵌套。
 * 所有失败都转成 diagnostics，不中断启动。
 */
// 先跑 migrateUserSubagentMarkdown 与 migrateSubagentStateFile：两者都在读盘之前完成，迁移失败只留原文件。
// roots 先用户后项目：顺序决定同名 profile 谁覆盖谁，项目级必须排在后面。
// additionalRoots 按 resolve 后的真实路径去重并排除当前 workspace，否则同一目录会被读两次。
// 迁移与读盘的每个失败都进 diagnostics，单个坏文件不中断启动。
// 所有 root 并行读取后拍平。
export async function loadZCodeAgentProfiles(
  input: LoadZCodeAgentProfilesInput,
): Promise<LoadZCodeAgentProfilesResult> {
  const migration = await migrateUserSubagentMarkdown(join(input.storageRoot, "agents"));
  await migrateSubagentStateFile(join(input.storageRoot, "v2", "agents-state.json"));
  const roots: Array<{ path: string; source: "user" | "project"; namespace?: string }> = [
    { path: join(input.storageRoot, "agents"), source: "user" as const },
    { path: join(input.workingDirectory, ".zcode", "agents"), source: "project" as const },
  ];
  for (const directory of new Set(
    (input.additionalDirectories ?? []).map((path) => resolve(path)),
  )) {
    if (directory === resolve(input.workingDirectory)) continue;
    roots.push({
      path: join(directory, ".zcode", "agents"),
      source: "project",
      namespace: basename(directory),
    });
  }
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const failure of migration.failures) {
    diagnostics.push({
      code: "agent_read_failed",
      message: "Subagent Markdown migration failed; original file preserved",
      path: failure.path,
    });
    input.logger?.warn("Subagent Markdown migration failed", {
      module: "bootstrap.subagents",
      path: failure.path,
      error: String(failure.error),
    });
  }
  const agentState = await readAgentState(input.storageRoot);
  const documents = (
    await Promise.all(
      roots.map(async (root) =>
        Promise.all(
          (await listMarkdownFiles(root.path)).map(async (path) => ({
            path,
            source: root.source,
            namespace: root.namespace,
            content: await readFile(path, "utf8"),
          })),
        ),
      ),
    )
  ).flat();
  const parsed = parseRuntimeSubagentConfig({
    documents,
    state: { ...agentState, disabledAgentIds: [...agentState.disabledAgentIds] },
  });
  for (const diagnostic of parsed.diagnostics)
    input.logger?.warn("Agent profile diagnostic", {
      ...diagnostic,
      module: "bootstrap.subagents",
    });
  return { ...parsed, diagnostics: [...diagnostics, ...parsed.diagnostics] };
}

/**
 * 读取插件声明的 agent 模板（同步 IO，供启动阶段一次性调用）。
 *
 * 只遍历 enabled 插件；文件路径固定 <plugin.rootPath>/agents/<name>.md，不信任模板里的
 * 任意路径。单个模板读取/解析失败只产出 diagnostic，其它插件继续加载。
 */
// 同步读盘供启动期调用。
// 跳过 !plugin.enabled：禁用插件残留的模板若被读入，插件关掉后仍能被 @ 到。
// agent 声明来自组件分组。
// 路径固定为 agents 目录。
// 每个模板独立解析：一个 parsePluginAgentProfile 失败只产 diagnostic，其余插件照常加载。
export function loadPluginAgentTemplates(
  input: Pick<LoadPluginAgentProfilesInput, "plugins" | "logger">,
): { profiles: ParsedPluginAgentProfile[]; diagnostics: AgentProfileParseDiagnostic[] } {
  const parsedProfiles: ParsedPluginAgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const plugin of input.plugins) {
    if (!plugin.enabled) continue;
    const agents = plugin.components.find((group) => group.kind === "agent")?.items ?? [];
    for (const agent of agents) {
      const filePath = join(plugin.rootPath, "agents", `${agent.name}.md`);
      const result = parsePluginAgentProfile({ filePath, logger: input.logger, plugin });
      if (result.diagnostic) diagnostics.push(result.diagnostic);
      if (result.parsed) parsedProfiles.push(result.parsed);
    }
  }

  return { profiles: parsedProfiles, diagnostics };
}

/**
 * 把插件模板展开成最终 profile 列表（纯内存，不再读盘）。
 *
 * 每个模板先应用模型覆盖，再生成 `plugin:name` 正名；随后按裸名唯一性决定是否追加别名：
 * - 全局只出现一次且非保留名 → 追加裸名别名，方便用户直接 @name；
 * - 与内置保留名冲突 → 只保留正名并给 agent_ambiguous_name 诊断；
 * - 多个插件同名 → 只保留正名并给歧义诊断。
 * 内置/插件的覆盖映射在此不重新计算，返回空对象，避免与 loadZCodeAgentProfiles 结果重复。
 */
// reservedProfileNames = 内置保留名 ∪ 调用方传入集合，后面所有别名判定只认这一份并集。
// 先数每个裸名跨全部插件出现几次，count 为 1 才可能安全追加别名。
// 模型覆盖先落到 template 上再生成 plugin:name 正名，否则别名继承不到覆盖。
// count === 1 且不在 reservedProfileNames 里才追加裸名别名，用户才能直接 @name。
// 撞名或撞保留名时只留 plugin:name 并推 agent_ambiguous_name，避免静默覆盖。
export function resolvePluginAgentProfiles(
  input: LoadPluginAgentProfilesInput,
  templates: ReturnType<typeof loadPluginAgentTemplates>,
): LoadZCodeAgentProfilesResult {
  const diagnostics = [...templates.diagnostics];
  const parsedProfiles = templates.profiles;
  const reservedProfileNames = new Set([
    ...RESERVED_AGENT_NAMES,
    ...(input.reservedProfileNames ?? []),
  ]);
  const bareNameCounts = countBareProfileNames(parsedProfiles);
  const profiles: AgentProfile[] = [];
  for (const parsed of parsedProfiles) {
    const override =
      input.modelSelectionOverrides?.[createPluginAgentStateId(parsed.plugin.id, parsed.bareName)];
    // 先替换完整选择再展开别名，避免同一插件的两个调用入口使用不同模型/档位。
    const canonical = {
      ...namespacePluginAgentProfile(parsed),
      ...(override ? { modelSelection: override } : {}),
    };
    profiles.push(canonical);

    const bareName = parsed.bareName.trim();
    if (bareNameCounts.get(bareName) === 1 && !reservedProfileNames.has(bareName)) {
      profiles.push({ ...canonical, name: bareName });
    } else if (reservedProfileNames.has(bareName)) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    } else if ((bareNameCounts.get(bareName) ?? 0) > 1) {
      diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${canonical.name}: ${bareName}`,
        path: canonical.path,
      });
    }
  }

  input.logger?.debug("Plugin agent profiles loaded", {
    diagnosticCount: diagnostics.length,
    module: "bootstrap.subagents",
    profileCount: profiles.length,
  });

  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    diagnostics,
    profiles,
  };
}

// 插件模板解析：source 固定 "user"（插件资产对 core 而言等同只读用户文件，不代表信任来源）；
// 解析失败且没有 profile 时只返回 diagnostic；有 profile 但带警告时两者都返回，不丢功能。
function parsePluginAgentProfile(input: {
  filePath: string;
  logger?: Logger;
  plugin: PluginMetadata;
}): { diagnostic?: AgentProfileParseDiagnostic; parsed?: ParsedPluginAgentProfile } {
  try {
    const content = readFileSync(input.filePath, "utf8");
    const result = parseAgentProfileFromMarkdown({
      content,
      path: input.filePath,
      source: "user",
    });
    if (result.diagnostic) {
      input.logger?.warn("Plugin agent profile diagnostic", {
        code: result.diagnostic.code,
        message: result.diagnostic.message,
        module: "bootstrap.subagents",
        path: input.filePath,
        pluginId: input.plugin.id,
      });
      if (!result.profile) return { diagnostic: result.diagnostic };
    }
    if (!result.profile) return {};
    return {
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      parsed: {
        bareName: result.profile.name,
        plugin: input.plugin,
        profile: result.profile,
      },
    };
  } catch (error) {
    return {
      diagnostic: {
        code: "agent_read_failed",
        message:
          error instanceof Error ? error.message : `Failed to read plugin agent: ${input.filePath}`,
        path: input.filePath,
      },
    };
  }
}

// 正名必须带插件前缀：不同插件允许同名 agent，裸名只在唯一时才作为别名暴露。
function namespacePluginAgentProfile(parsed: ParsedPluginAgentProfile): AgentProfile {
  return {
    ...parsed.profile,
    name: `${parsed.plugin.name}:${parsed.bareName}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 统计裸名出现次数（trim 后比较），用于判定「唯一才可加别名」；保留名另行判定。
function countBareProfileNames(
  parsedProfiles: readonly ParsedPluginAgentProfile[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parsed of parsedProfiles) {
    const name = parsed.bareName.trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

// 读取 v2/agents-state.json：任何读取/解析失败都退回空状态（不阻断启动）；
// 只保留合法 modelSelection 与去空后的 disabledAgentIds，忽略未知字段。
// readFile 或 JSON.parse 抛错都退回空状态：启动阶段读不到 agents-state.json 不该阻断。
// 插件覆盖复用 parsePluginModelSelection，不在这里重写一遍校验。
// builtInModelSelectionOverrides 只认两个内置保留名，其余键按未知字段丢弃。
// disabledAgentIds 逐项 trim 并丢掉空串，否则 "" 会命中所有 profile。
// 未识别的顶层字段直接忽略，为将来加字段留前向兼容。
async function readAgentState(storageRoot: string): Promise<{
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: Set<string>;
}> {
  try {
    const raw = await readFile(join(storageRoot, "v2", "agents-state.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    return {
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      builtInModelSelectionOverrides: normalizeBuiltInSelectionOverrides(
        parsed.builtInModelSelectionOverrides,
      ),
      disabledAgentIds: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [],
      ),
    };
  } catch {
    return {
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
      disabledAgentIds: new Set(),
    };
  }
}

// 只接受两个内置保留名的覆盖；未通过 schema 的条目直接丢弃，不猜测或部分修正。
function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]);
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore);
  if (generalPurpose.success) result["general-purpose"] = generalPurpose.data;
  if (explore.success) result.Explore = explore.data;
  return result;
}

// 根目录只读直接子文件（不递归），扩展名仅 md/markdown；ENOENT/ENOTDIR 视为空目录，
// 其它错误上抛；结果按路径排序，保证诊断与加载顺序稳定可复现。
async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    // 与 Host / Settings 一致，只加载根目录直接文件；插件使用独立发现入口。
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(path);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}
