// ============================================================================
// services/subagents/subagentsService.ts —— Subagent 配置发现、持久化与写序列化
// ============================================================================
// 【定位】把内置 agent、用户/工作区 Markdown profile、插件 agent 三条来源合并成
// 一份 UI/runtime 视图，并把用户的启用状态与模型覆盖写回 ~/.zcode/cli 下的状态文件。
//
// 【不变量】
// INV-01：任一时刻只有一个写任务在跑；状态文件读改写全部经 enqueue 串行化。
//   守住它的位置：enqueue/mutate。破坏后果：两次读改写交叉会让后写者回滚先写者。
// INV-02：覆盖只由结构化字段表达，legacy builtInModelOverrides 永不参与恢复。
//   守住它的位置：readAgentStateAtPath 与 AgentsStateFile 定义。破坏后果：旧档位被复活。
// INV-03：插件裸名只是运行时别名，不进入一文件一条的 profiles 投影。
//   守住它的位置：discoverPluginAgents 的 runtimeAgents 分支。破坏后果：UI 出现重复条目。
// INV-04：profile 文件名由 name 派生并小写；重命名必须迁移 disabledAgentIds。
//   守住它的位置：updateAgent + migrateDisabledAgentId。破坏后果：已禁用 agent 改名后复活。
// INV-05：落盘前先 parse 一次即将写入的 Markdown；serializer 回归不能把坏内容写盘。
//   守住它的位置：createAgent/updateAgent 中的 parseSavedAgent 调用。
// INV-06：插件 agent 恒为 readOnly 且不可禁用（enabled 恒 true）。
//   守住它的位置：attachEnabledState 的 scope 判定与 discoverPluginAgents 的 readOnly 赋值。
/* eslint-disable max-lines */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  modelSelectionSchema,
  type SubagentRuntimeConfig,
  type AgentCreateParams,
  type AgentDeleteParams,
  type AgentDiagnostic,
  type AgentScope,
  type AgentSummary,
  type AgentUpdateParams,
  type AgentsCapability,
  type AgentsListResult,
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelOverrideParams,
  type PluginSubagentModelSelectionOverrides,
  type SubAgentConfig,
  type SubagentsListMode,
  type ZCodeProvider,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "./subagentModelSelection.js";
import { serializeSubagentMarkdown, parseSubagentMarkdown } from "./subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  resolveZCodeStorageRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";
import type { ISubagentsService } from "./subagents.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
  scanOfficialPluginCacheRoots,
} from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

import { createSubagentRuntimeConfigCache } from "./subagentRuntimeConfig.js";

const subagentLogger = createServiceLogger("subagents");

// [权衡] 状态文件只承载三类事实：内置覆盖、插件覆盖、禁用 id。
// 三者都按 id 存而不是按 name，因为 name 是用户可改的显示属性；id 由
// createAgentStateId 从 name+scope+source 派生，改名后可重算，按 name 存则查找断链。
// 破坏后果：改一次名，模型覆盖与禁用状态全部静默失效。
interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

interface InstalledPluginsStateFile {
  plugins?: unknown;
}

interface PluginConfigSummary {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
}

interface InstalledPluginRecord {
  id: string;
  installPath: string;
  name: string;
  scope?: "user" | "workspace";
  projectPath?: string;
}

interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
}

interface PluginAgentDiscovery {
  profiles: AgentSummary[];
  runtimeAgents: AgentSummary[];
}

// 这份名单必须与 createBuiltInAgents 完全一致：它同时被 assertNotBuiltInName
// 与插件裸名冲突判定消费。名单漂移后，用户能建出与内置同名的 profile，
// applyRuntimePrecedence 再按后写胜出把内置条目挤掉，表现为内置 agent 消失。
const BUILT_IN_AGENT_NAMES = new Set(["general-purpose", "Explore"]);
// 三种清单路径按优先级排列，readPluginManifest 读到第一个可解析的就返回。
// .zcode-plugin 放最前：同目录多套清单并存时以 ZCode 自有约定为准，
// 否则会被 Claude/Codex 的字段语义带偏，agents 目录解析到错位置。
const PLUGIN_MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
] as const;

function createBuiltInAgents(
// 内置 agent 不落盘：每次 list 现算，升级后新增或修改的描述与工具立刻生效。
// 代价是覆盖必须从 state 传入，不能缓存在模块级变量里，否则多实例会串味。
// path 用 built-in: 前缀而非真实文件路径，下游据此拒绝删除或写入。
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
): AgentSummary[] {
  const generalPurposeOverride = modelSelectionOverrides["general-purpose"];
  const exploreOverride = modelSelectionOverrides.Explore;
  return [
    {
      id: createAgentStateId({
        name: "general-purpose",
        scope: "built-in",
        source: "built-in",
      }),
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
// [权衡] 显式给 color 而不是留给 UI 按名称 hash：hash 结果可能落在红色，
// 而红色在本产品语义里表示故障，会把正常的内置 agent 显示成错误态。
      color: "blue",
      injectAgentsMd: true,
      modelSelection: generalPurposeOverride,
      modelSelectionOverride: generalPurposeOverride,
      systemPrompt: "",
      tools: ["*"],
      path: "built-in:general-purpose",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreOverride,
      modelSelectionOverride: exploreOverride,
      systemPrompt: "",
// Explore 只给只读工具，刻意不含 Bash/Write/Edit：它是搜索代理，
// 一旦能写就能绕过上层对写操作的审批，因此白名单必须在这里穷举。
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}

// 空状态只用于文件不存在与 JSON 语法错误两种场景（见读取分支），
// 不是所有错误的兜底：权限类 IO 失败必须继续抛，否则等于清空禁用表。
function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

// 用 access 探测而不是 stat：调用方只关心能否打开，不关心类型。
// 它吞掉所有错误（含 EACCES），因此绝不能用于权限判定。
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  return readAgentStateAtPath(await resolveSubagentStateFile(options));
}

// [事务] 读取前先跑一次迁移：旧文件的覆盖表格式不同，迁移是幂等的，
// 重复执行不会二次改写；只有迁移后的结构化字段才被信任。
async function readAgentStateAtPath(stateFile: string): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(stateFile);
  try {
    const raw = await readFile(stateFile, "utf-8");
// 故意用宽类型接收磁盘内容：字段可能来自旧版本或被手改，必须逐项归一化，
// 不能直接断言成 AgentsStateFile，否则一个 空值 字段就会在下游
// new Set(undefined) 处抛 TypeError，把整次 list 打成失败。
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      builtInModelOverrides?: unknown;
      builtInThoughtLevelOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
// [失败路径] 单条选择不合法时只丢弃该条：用户可以只配了 general-purpose
// 或只配了 Explore，schema 校验失败的条目退化成无覆盖而不是整体失败。
    const selections = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    return {
      ...parsed,
      builtInModelSelectionOverrides: selections,
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
// 过滤空串与非字符串项：空 id 进了 Set 也永远匹配不到 agent，只会越积越多；
// 非字符串项则在下次 JSON.stringify 时把状态文件写成不可解析的形态。
      disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
    };
  } catch (error) {
    // 文件缺失/损坏沿用既有空覆盖语义；IO 失败不能伪装为空配置并重新启用已禁用 agent。
// [失败路径] 区分 SyntaxError/ENOENT 与其它错误是本函数最关键的一条线：
// 把 EACCES/EBUSY 也当空配置返回，会让全部 agent 显示为启用（禁用表丢失），
// 用户明确关掉的 profile 会被 runtime 重新拉起，属于静默的安全降级。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyAgentsState();
    throw error;
  }
}

async function writeAgentStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
// [资源] 走原子写（同目录临时文件 + rename）而不是直写：进程写一半被杀会留下
// 半截 JSON，下次读到 SyntaxError 就退化成空状态，禁用表与覆盖一起丢失。
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

// 三级来源合并的第一级：用户级与工作区级 Markdown。
// root 顺序固定 user 再 workspace，而 applyRuntimePrecedence 是后出现的胜出，
// 因此这里的顺序本身就是优先级，不能随意调整。
async function discoverFileAgents(params: {
  diagnostics: AgentDiagnostic[];
  includeUserAgents: boolean;
  includeWorkspaceAgents: boolean;
  storageOptions?: SubagentStorageOptions;
  workspacePath: string;
}): Promise<AgentSummary[]> {
// roots 的追加顺序就是优先级顺序（user 先、workspace 后），
// 后续 applyRuntimePrecedence 依赖它做后写胜出，不能改成按 scope 排序。
  const roots: Array<{ scope: AgentScope; rootPath: string }> = [];
  if (params.includeUserAgents) {
    roots.push({
      scope: "user",
      rootPath: await resolveUserSubagentRoot(params.storageOptions),
    });
  }
  if (params.includeWorkspaceAgents) {
    roots.push({
      scope: "workspace",
      rootPath: resolveWorkspaceSubagentRoot(params.workspacePath),
    });
  }

  const agents: AgentSummary[] = [];
// 串行遍历而不是 Promise.all：diagnostics 是共享数组，并发 push 会让诊断
// 顺序随 IO 完成顺序漂移，难以稳定复现用户看到的第一条错误。
  for (const root of roots) {
// [失败路径] 单个文件读失败或解析失败只记诊断并继续：一个坏 profile
// 不能让设置页整体打不开，否则用户无法进入 UI 修复它。
    for (const agentPath of await collectAgentMarkdownPaths(root.rootPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: root.scope,
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          agents.push({
            ...parsed.agent,
// projectPath 只在 workspace scope 上有意义：UI 用它判断该 profile 属于哪个项目；
// user scope 带上它会让同一条目跨项目串味。
            projectPath: root.scope === "workspace" ? params.workspacePath : undefined,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  return agents;
}

// recursive 由调用方决定：用户/工作区 profile 只扫一层（历史约定），
// 插件目录允许嵌套（插件自带 agents 子目录结构）。
async function collectAgentMarkdownPaths(rootPath: string, recursive = false): Promise<string[]> {
  if (!(await exists(rootPath))) {
    return [];
  }

// 用 lstat 而不是 stat：root 若是指向别处的符号链接就跳过，
// 避免扫描把任意目录当成 profile 来源，越界读取用户机器上的其它文件。
  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const result: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
// 只接受普通文件与普通目录，其它 Dirent 类型（socket/fifo）直接跳过，
// 避免对特殊文件调用 readFile 造成长时间阻塞。
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      // 自定义 profile 只支持第一层；插件保留已有递归发现规则。
      if (recursive) result.push(...(await collectAgentMarkdownPaths(entryPath, true)));
      continue;
    }
// 扩展名匹配大小写不敏感：Windows 用户常见大写 .MD，
// 忽略这一点会让文件在列表里凭空消失。
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }
// 返回前统一排序一次：上层按顺序渲染并生成 id，顺序不稳定会让同一份磁盘
// 内容在不同次请求里产出不同列表，触发无意义的重渲染。
  return result.sort((left, right) => left.localeCompare(right));
}

// 用户级目录只在桌面运行时可用：Web/CLI 侧没有稳定的 home 语义，
// 强行开放会让用户 agent 指向容器或服务进程的 HOME，看起来能存但读不回来。
function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
// 注入优先于环境变量：单测要能显式模拟两种运行时，不能依赖跑测机器的环境。
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
// 能力对象是 UI 决定是否渲染用户级分组的唯一依据，不要在页面里重复判断环境。
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

// 只有 user scope 的条目可被禁用，其余 enabled 恒为 true。若让 workspace 也可禁用，
// 同一份仓库配置在不同机器上会出现两种可用性，团队共享的 profile 会莫名消失。
function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

// [权衡] 用 Map 按 name 去重并保留最后一个写入者，而不是显式比较 scope 权重：
// 调用方已把数组按优先级拼好（builtin → user → workspace → plugin），
// 这里只负责兑现该顺序。改成按 source 排权重会让调用方顺序失去意义，
// 两处必须同时改才能维持语义，容易再次漂移。
function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

// 插件 agent 的 id 由 createPluginAgentStateId(pluginId, agentName) 生成，与用户
// agent 的 id 空间分开，插件升级换目录也不会覆盖用户配置。
// [权衡] 每个插件扫安装目录而不是读缓存清单：清单在手工复制插件时会失真，
// 磁盘才是事实来源；代价是每次 list 都有多次 readdir。
async function discoverPluginAgents(params: {
  diagnostics: AgentDiagnostic[];
  state: AgentsStateFile;
  reservedNames: Iterable<string>;
  storageOptions?: SubagentStorageOptions;
}): Promise<PluginAgentDiscovery> {
  const storageRoot = await resolveZCodeStorageRoot(params.storageOptions);
// 兼容两种传入形态：调用方可能给 ~/.zcode，也可能给 ~/.zcode/cli。
// 用 basename 判定而不是字符串 endsWith，避免 cli-backup 这类目录被误判。
  const cliStorageRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const pluginConfig = await readPluginConfig(params.storageOptions);
  const records = await readEnabledPluginRecords(join(cliStorageRoot, "plugins"), pluginConfig);
// 先收集再统一分配别名：裸名是否唯一要看全部插件的扫描结果，
// 边扫边决定会让结果依赖 readdir 顺序（不同文件系统顺序不同）。
  const parsedAgents: Array<{
    agent: AgentSummary;
    bareName: string;
    pluginName: string;
  }> = [];

  for (const record of records) {
    for (const agentPath of await collectPluginAgentMarkdownPaths(record.installPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: record.scope === "workspace" ? "workspace" : "user",
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
// id 用插件 id + 文件内 agent 名，不用展示名：展示名带插件前缀且可能随清单调整，
// 用它做键会让用户已保存的模型覆盖在插件改名后失配。
          const id = createPluginAgentStateId(record.id, parsed.agent.name);
          parsedAgents.push({
            agent: applyPluginAgentOverrides(
              {
                ...parsed.agent,
                id,
                name: `${record.name}:${parsed.agent.name}`,
                readOnly: true,
                source: "plugin",
                pluginId: record.id,
                pluginName: record.name,
                projectPath: record.scope === "workspace" ? record.projectPath : undefined,
              },
              params.state,
            ),
            bareName: parsed.agent.name,
            pluginName: record.name,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read plugin agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

// 保留名集合 = 内置名 + 已发现的用户/工作区 profile 名。
// 冲突时只发诊断、不注册裸名别名：裸名与内置同名时 UI 选中它会调起错误实现，
// 而用户从名称上根本看不出差别。
  const reservedNames = new Set([...BUILT_IN_AGENT_NAMES, ...params.reservedNames]);
  const bareNameCounts = new Map<string, number>();
  for (const parsed of parsedAgents) {
// 先统计裸名出现次数再决定是否注册别名：唯一性是对整批结果的判断，
// 不能边加边判定，否则结果取决于遍历顺序。
    bareNameCounts.set(parsed.bareName, (bareNameCounts.get(parsed.bareName) ?? 0) + 1);
  }

  const profiles: AgentSummary[] = [];
  const runtimeAgents: AgentSummary[] = [];
  for (const parsed of parsedAgents) {
    profiles.push(parsed.agent);
    runtimeAgents.push(parsed.agent);
// 裸名别名与带前缀的正式条目指向同一份配置，只改 id 与 name：
// 这样 runtime 既可用 plugin:agent 精确调用，也接受用户手写的短名。
    if (bareNameCounts.get(parsed.bareName) === 1 && !reservedNames.has(parsed.bareName)) {
      runtimeAgents.push({
        ...parsed.agent,
        id: createPluginAgentStateId(`${parsed.agent.id}:alias`, parsed.bareName),
        name: parsed.bareName,
      });
// 两种冲突用不同文案：与内置/已有 profile 冲突时说与已有 profile 冲突，
// 插件之间重名时说有歧义，用户才知道该改哪一个。
    } else if (reservedNames.has(parsed.bareName)) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    } else if ((bareNameCounts.get(parsed.bareName) ?? 0) > 1) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    }
  }

  return {
// [权衡] profiles 与 runtimeAgents 分开返回而不是一个数组加标记：
// 前者是 UI 的一文件一条投影，后者是 runtime 的可调用名称集合，
// 两者数量本就不同（别名会多出条目），合并后再过滤容易漏掉一边。
    // 裸名称只是同一插件 agent 的运行时调用别名，不能进入一文件一条的 UI 资源投影。
    profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    runtimeAgents: runtimeAgents.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

// 插件开关来自 CLI 的 config.json。读失败一律降级成全空：
// 这里只影响插件是否被发现，不影响用户已保存的 agent 配置，
// 不值得让整次 list 失败。
async function readPluginConfig(options?: SubagentStorageOptions): Promise<PluginConfigSummary> {
  try {
    const configPath = join(resolveUserHomeDir(options), ".zcode", "cli", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
// 逐层判型而不是一次断言：config.json 是用户可手改的，
// 任一层写成数组或 null 都会让后续属性访问抛错。
    if (!isRecord(parsed)) return { enabledPlugins: {}, suppressedBuiltins: [] };
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    return {
// 只保留 boolean 值：字符串 false 是真值，直接透传会把一个写成字符串的
// 开关当成启用，而 UI 上显示的却是关闭。
      enabledPlugins: Object.fromEntries(
        Object.entries(enabledPlugins).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
      suppressedBuiltins: Array.isArray(plugins.suppressedBuiltins)
        ? plugins.suppressedBuiltins.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { enabledPlugins: {}, suppressedBuiltins: [] };
  }
}

/** 内置插件没有安装记录，只扫描 installed 文件会漏掉；缓存只补缺失身份，不能复活禁用/卸载插件。 */
// [权衡] installed 记录是权威来源，缓存目录只用来补官方内置但没走安装流程的身份；
// 顺序上先 installed 再补缓存，保证 installed 的 installPath 优先。
// 若反过来，缓存里的旧版本目录会盖掉用户实际安装的位置。
async function readEnabledPluginRecords(
  pluginStorageRoot: string,
  config: PluginConfigSummary,
): Promise<InstalledPluginRecord[]> {
// 卸载抑制（suppressedBuiltins）必须在两个来源上都生效：只在缓存兜底处检查，
// 会让一条遗留的 installed 记录把已卸载的官方插件重新拉起。
  const installed = await readInstalledPluginRecords(pluginStorageRoot);
  const records = installed.filter(
    (record) =>
      config.enabledPlugins[record.id] === true &&
      // 卸载抑制优先于遗留的安装/启用记录，不能只在缓存兜底时检查而复活官方插件。
      !(
        record.id.endsWith(`@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`) &&
        config.suppressedBuiltins.includes(record.id)
      ),
  );
// seenIds 兼作去重与 installed 优先的守卫：缓存补录命中即跳过，
// 因此 installed 里记录的安装路径永远胜出。
  const seenIds = new Set(installed.map((record) => record.id));
  for (const cacheRoot of await scanOfficialPluginCacheRoots(pluginStorageRoot)) {
    const id = `${cacheRoot.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
    if (seenIds.has(id) || config.suppressedBuiltins.includes(id)) continue;
// [权衡] 官方内置插件缺省启用，第三方插件缺省禁用：前者是产品自带能力，
// 后者需要用户显式同意才扫描其目录。
    const enabled = config.enabledPlugins[id] ?? DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(id);
    if (!enabled) continue;
    for (const versionRoot of cacheRoot.versionRoots) {
      const manifest = await readPluginManifest(versionRoot);
// 目录名必须与清单 name 一致才认：缓存目录可能被手工改名或残留半次安装，
// 名字不符说明它不是一个完整可用的插件目录。
      if (manifest?.name !== cacheRoot.name) continue;
      records.push({ id, installPath: versionRoot, name: cacheRoot.name, scope: "user" });
      seenIds.add(id);
      break;
    }
  }
  return records;
}

// installed_plugins.json 的条目只做结构校验，路径是否仍存在交给下游
// readdir 自然失败：一次坏记录不能拖垮整个插件列表。
async function readInstalledPluginRecords(
  pluginStorageRoot: string,
): Promise<InstalledPluginRecord[]> {
  try {
    const raw = await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf-8");
    const parsed = JSON.parse(raw) as InstalledPluginsStateFile;
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.filter(isInstalledPluginRecord);
  } catch {
    return [];
  }
}

// 类型守卫只校验三个必填字段：版本、scope、projectPath 由后续逻辑按需读取，
// 缺失时按 undefined 语义降级，不能因此丢掉整条记录。
function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.name === "string"
  );
}

async function collectPluginAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  const manifest = await readPluginManifest(rootPath);
// 清单的 agents 字段可以指向任意相对目录，落盘位置因插件而异；
// 先算根列表再并发扫描，单个根的错误不会掩盖其它根的结果。
  const roots = collectPluginAgentRoots(rootPath, manifest?.agents);
  const paths = await Promise.all(roots.map((root) => collectAgentMarkdownPaths(root, true)));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<Record<string, unknown> | null> {
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    try {
      const raw = await readFile(join(rootPath, relativePath), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next supported manifest path.
    }
  }
  return null;
}

// 清单里的路径必须被约束在插件目录内：.. 或绝对路径会让扫描越界，
// 把用户机器上任意目录的 markdown 当成插件 agent 暴露出去。
function collectPluginAgentRoots(rootPath: string, manifestAgents: unknown): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const root = resolve(rootPath);
// [失败路径] 越界路径直接丢弃而不是报错：清单来自第三方插件，
// 一条坏声明不应让整个插件不可用，但也不能被采纳。
  const add = (relativePath: string) => {
    const resolved = resolve(root, relativePath.replace(/^\.\//u, ""));
    const relativeToRoot = relative(root, resolved);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  };
  add("agents");
  if (typeof manifestAgents === "string") add(manifestAgents);
  if (Array.isArray(manifestAgents)) {
    for (const value of manifestAgents) {
      if (typeof value === "string") add(value);
    }
  }
  return roots;
}

// defaultModelSelection 记录插件声明的原始值，modelSelection 才是生效值：
// UI 需要区分用户改过与回到插件默认，只存一份就无法表达重置。
function applyPluginAgentOverrides(agent: AgentSummary, state: AgentsStateFile): AgentSummary {
  const override = state.pluginAgentModelSelectionOverrides[agent.id];
  // 插件文件只提供默认值；覆盖替换整份选择，不能混入原模型的档位。
  return {
    ...agent,
    defaultModelSelection: agent.modelSelection,
    ...(override ? { modelSelection: override, modelSelectionOverride: override } : {}),
  };
}

// 数组也是 object，必须显式排除：把数组当配置对象会让后续 Object.entries
// 产出数字键，写出一个永远匹配不到 server 的配置。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// safeParse 而不是 parse：磁盘内容不可信，非法条目应退化成无覆盖，
// 而不是让整次读取抛错并连带清空禁用列表。
function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

// 服务实例持有三份进程内状态：写队列、disposed 标记、runtime 配置缓存。
// 它们不放进 options，因为这些必须按实例隔离（同进程可能建多个服务用于
// 不同 homeDir 的测试），共享会串味。
export function createSubagentsService(options?: SubagentsServiceOptions): ISubagentsService & {
// 这些方法不在 ISubagentsService 契约里：Host 内部使用，不进 RPC 暴露面。
  /** Host 启动/重启 Agent 前准备配置，不暴露为 Renderer RPC。 */
  prepareRuntimeState(workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  readRuntimeConfig(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SubagentRuntimeConfig>;
  disposeAll(): void;
} {
// [并发] writeQueue 是一条尾插队的串行链：新任务挂在链尾，且无论前一个
// 成功或失败都继续（见 enqueue 的 then(run, run)）。只有一条链，
// 所以读改写序列不会交叉；代价是一次慢 IO 会阻塞后续所有写。
  let writeQueue = Promise.resolve();
// 只在 disposeAll 置位，之后所有 mutate 直接抛错：已释放的实例不能再写磁盘，
// 否则会在进程退出阶段留下半写状态文件。
  let disposed = false;
// 显式重建 storageOptions 而不是直接用 options：只透传 homeDir，
// isDesktopRuntime 是行为开关，不能被误传进路径解析层。
  const storageOptions: SubagentsServiceOptions = {
    homeDir: options?.homeDir,
  };

  const runtimeConfig = createSubagentRuntimeConfigCache({
    readUserRoot: () => resolveUserSubagentRoot(storageOptions),
    readStatePath: () => resolveSubagentStateFile(storageOptions),
    readState: readAgentStateAtPath,
  });
// [并发] then(run, run) 让失败的前序任务不阻断后续：队列关心的是顺序，
// 不是前一个是否成功。若只写 then(run)，一次失败会让队列永久停在 rejected，
// 后续所有写都不再执行。
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(run, run);
// 链尾记录的是已消化的 Promise，必须吞掉错误：否则未处理的 rejection
// 会触发进程级 unhandledRejection，而错误已经通过返回值交给调用方了。
    writeQueue = queued.then(
      () => {},
      () => {},
    );
    return queued;
  }
  function mutate<T>(run: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
// [并发] disposed 判定放在队列内部而不是入队前：入队时未释放、执行时已释放
// 的任务也必须拒绝，否则 disposeAll 之后仍可能有一次写落到磁盘。
      if (disposed) throw new Error("Subagents service is disposed");
      return run();
    });
  }
// 内部 service 对象不包 mutate，导出时再包：prepareRuntimeState/list 这类
// 只读方法不进写队列，避免被一次慢写阻塞设置页。
  const service = {
// runtime 配置读取走独立缓存，与写队列解耦：agent 启动路径每次都要读，
// 不能排在用户保存设置后面。
    readRuntimeConfig: runtimeConfig.read,
// [资源] 只释放缓存并置位标记，不等待在飞任务：它们可能正在 await IO，
// 强行等待会卡住退出流程；任务恢复后会看到 disposed 并放弃写入。
    disposeAll() {
      disposed = true;
      runtimeConfig.dispose();
    },
// 启动前的准备阶段：迁移用户 Markdown 覆盖，再预热 runtime 配置缓存。
// 迁移失败只 warn 不抛：保留原文件、按旧格式继续可用，比让 CLI 起不来更好。
    async prepareRuntimeState(workspace?: { workspacePath: string; workspaceIdentity?: string }) {
      return enqueue(async () => {
        const markdownMigration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of markdownMigration.failures)
          subagentLogger.warn(undefined, "用户 Subagent Markdown 迁移失败，保留原文件", failure);
        // state 的迁移由缓存读取入口统一执行，IO 失败同样发布回退，不能提前阻断 CLI 启动。
// 预热必须发生在 Host 拉起 agent 之前：否则首个 agent 会读到未迁移的
// 状态文件，拿到过期的模型覆盖。
        await runtimeConfig.prepare(workspace);
      });
    },

    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      mode?: SubagentsListMode;
    }): Promise<AgentsListResult> {
// list 是纯读取，不入写队列：它需要反映磁盘当前内容，排在一次写后面只会增加延迟。
      const capability = resolveCapabilities(options);
      const mode = params.mode ?? "allRuntimeScopes";
      const diagnostics: AgentDiagnostic[] = [];
// 只在能力允许时迁移用户目录：非桌面运行时没有用户 scope，
// 去动 HOME 下的文件既无意义又可能改到宿主容器共享目录。
      if (capability.userScopeAvailable) {
        const migration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of migration.failures)
          diagnostics.push({
            code: "agent_read_failed",
            message: "Subagent Markdown migration failed; original file preserved",
            path: failure.path,
          });
      }
      const state = await readAgentStateFile(storageOptions);
// state 只读一次并在内存中复用：同一次 list 里内置覆盖、插件覆盖、禁用列表
// 必须来自同一个快照，否则并发写会让页面出现自相矛盾的组合。
      const builtInAgents = createBuiltInAgents(state.builtInModelSelectionOverrides);
      const fileAgents = await discoverFileAgents({
        diagnostics,
        includeUserAgents: capability.userScopeAvailable,
        includeWorkspaceAgents: mode === "allRuntimeScopes",
        storageOptions,
        workspacePath: params.workspacePath,
      });
// 分 scope 排序后再拼装，而不是先拼再排：顺序要稳定且与来源解耦，
// 否则 workspace 条目会插进 user 列表中间，UI 分组错乱。
      const sortedUserAgents = fileAgents
        .filter((agent) => agent.scope === "user")
        .sort((left, right) => left.name.localeCompare(right.name));
      const sortedWorkspaceAgents = fileAgents
        .filter((agent) => agent.scope === "workspace")
        .sort((left, right) => left.name.localeCompare(right.name));
      // 用户页不能读项目 profile，但仍需展示本地插件的只读覆盖入口；不能把两者一并剪掉。
// [权衡] settingsUserOnly 下仍完整跑一次插件发现，只为拿到 profiles；
// 略过它会让用户在设置页看不到任何插件 agent，无法做模型覆盖。
      const pluginAgentDiscovery = await discoverPluginAgents({
        diagnostics,
        state,
        reservedNames: [
          ...builtInAgents.map((agent) => agent.name),
          ...sortedUserAgents.map((agent) => agent.name),
          ...sortedWorkspaceAgents.map((agent) => agent.name),
        ],
        storageOptions,
      });
// 两种模式的分叉点：设置页只展示内置加用户，runtime scopes 才做四源合并。
// 若设置页也合并，用户会看到一堆 workspace/profile 条目却改不动。
      const discoveredAgents =
        mode === "settingsUserOnly"
          ? [...builtInAgents, ...sortedUserAgents]
          : applyRuntimePrecedence([
              ...builtInAgents,
              ...sortedUserAgents,
              ...sortedWorkspaceAgents,
              ...pluginAgentDiscovery.runtimeAgents,
            ]);
      const agents = attachEnabledState(discoveredAgents, state);

      return {
        agents,
// userAgents 从合并结果里再筛，而不是复用 sortedUserAgents：
// 前者带 enabled 状态，后者没有；两处字段不一致会让 UI 少一个开关。
        userAgents: agents.filter((agent) => agent.source === "user"),
        pluginAgents: attachEnabledState(pluginAgentDiscovery.profiles, state),
        capability,
        diagnostics,
      };
    },

// 启用状态只有一份事实：禁用集合。启用等价于从集合移除。
// [权衡] 不另存 enabled 列表，避免两个集合互相矛盾（同一 id 同时出现在两边）。
    async setEnabled(params: { agentId: string; enabled: boolean }): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
// 读改写都在队列内完成，因此这里拿到的是最新快照；
// 排序是为了让状态文件稳定 diff，避免同一集合写成不同顺序造成无谓写入。
        const previous = new Set(state.disabledAgentIds);
        if (params.enabled) {
          previous.delete(params.agentId);
        } else {
          previous.add(params.agentId);
        }
        state.disabledAgentIds = [...previous].sort();
        await writeAgentStateFile(state, storageOptions);
      };

      await mutate(runUpdate);
    },

// 覆盖是整份替换而不是字段合并：模型选择由 provider+model+档位组成，
// 合并会出现新 provider 配旧档位这种不存在的组合。
    async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
// 先浅拷贝再改，最后整份写回：直接改 state 上的对象会让后续
// 写失败时的内存快照与磁盘不一致。
        const builtInModelSelectionOverrides = {
          ...state.builtInModelSelectionOverrides,
        };
        const modelSelection = normalizeSubagentModelSelection(params.modelSelection);
        if (modelSelection) {
// [失败路径] normalize 返回 undefined 表示用户选择了默认，此时必须 delete 而不是
// 写 null：写 null 会让 modelSelectionSchema.safeParse 失败，覆盖永远清不掉。
          builtInModelSelectionOverrides[params.agentName] = modelSelection;
        } else {
          delete builtInModelSelectionOverrides[params.agentName];
        }
        await writeAgentStateFile(
          {
            ...state,
            builtInModelSelectionOverrides,
          },
          storageOptions,
        );
      };

      await mutate(runUpdate);
    },

// 插件身份必须先通过格式校验再进队列：id 会被当作 Map key 持久化，
// 前后带空白或缺少 plugin: 前缀的 id 永远匹配不到实际发现的 agent。
    async setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void> {
// [失败路径] trim 后仍要相等，是为了拒绝尾部空白这类看起来一样的 id；
// 它们一旦落盘，后续按 id 查找永远失败，用户也无法从 UI 看出差异。
      if (!params.agentId.startsWith("plugin:") || params.agentId.trim() !== params.agentId)
        throw new Error("无效插件 Subagent 身份");
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const overrides = { ...state.pluginAgentModelSelectionOverrides };
        const selection = normalizeSubagentModelSelection(params.modelSelection);
        if (selection) overrides[params.agentId] = selection;
        else delete overrides[params.agentId];
        await writeAgentStateFile(
          { ...state, pluginAgentModelSelectionOverrides: overrides },
          storageOptions,
        );
      };
      await mutate(runUpdate);
    },

// 目录按需创建：只有真正要打开目录时才需要它存在，
// 启动阶段提前 mkdir 会在只读 HOME 环境下制造无意义告警。
    async getPrimaryUserAgentsDirectory(_params: { provider: ZCodeProvider }): Promise<{
      path: string;
    }> {
      const path = await resolveUserSubagentRoot(storageOptions);
      await mkdir(path, { recursive: true });
      return { path };
    },

// 创建只允许用户 scope：workspace profile 由仓库提供，不应经由 UI 写入，
// 否则会对共享仓库产生未提交的本地改动。
    async createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
// [并发] 先查存在再写不是原子操作；同进程的互斥由 mutate 队列保证，
// 跨进程仍可能撞名，因此写文件还用了 wx 标志。
      if (await exists(filePath)) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 先验证即将写入的 Markdown 可解析，避免 serializer 回归时把坏 profile 落盘。
// [权衡] 加 wx 而不是走 atomicWriteText：创建语义要求不存在才成功，
// 临时文件加 rename 会覆盖同名文件，破坏上面的存在性检查。
      await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
      return { agent };
    },

// 更新按 name 定位文件：name 就是文件名，改名等价于写新文件再删旧文件。
// 这里没有 compare-and-swap，队列外的并发编辑仍可能互相覆盖（已知限制）。
    async updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });

// 改名目标已存在时拒绝而不是覆盖：两个不同 agent 合并成一个会让
// 后者的模型覆盖与禁用记录变成孤儿。
      if (params.oldFilePath && params.oldFilePath !== filePath && (await exists(filePath))) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 更新时同样先 parse 再覆盖旧文件，避免失败保存破坏已有用户 agent。
      await writeFile(filePath, content, "utf-8");
      // enabled 状态按 agent id 存储；重命名会生成新 id，必须迁移旧禁用记录，
// [事务] 顺序不能反：先落新文件、再迁移禁用 id、最后删旧文件。
// 若先删旧文件而迁移失败，用户既丢原文件又丢禁用状态。
// 迁移本身失败时旧记录仍在，最坏是禁用了两个 id，不会变成都没禁用。
      // 否则用户禁用的 agent 改名后会被 runtime 当成新启用 profile 重新加载。
      await migrateDisabledAgentId(params.agentId, agent.id, storageOptions);
      if (params.oldFilePath && params.oldFilePath !== filePath) {
        await rm(params.oldFilePath, { force: true });
      }
      return { agent };
    },

// 先删文件再清禁用记录：反过来会让删除失败后状态已被清空，
// 用户下次看到的是一个重新启用但文件仍在的条目。
    async deleteAgent(params: AgentDeleteParams): Promise<void> {
      await rm(params.filePath, { force: true });

      const state = await readAgentStateFile(storageOptions);
      const disabledSet = new Set(state.disabledAgentIds);
// 删除也要清禁用记录：留着会让同 id 重建时直接是禁用态，
// 用户新建后会以为创建失败。
      disabledSet.delete(params.agentId);
// 与 setEnabled 保持同一口径：集合转数组后排序，
// 状态文件内容才在不同操作路径下保持字节级一致。
      state.disabledAgentIds = [...disabledSet].sort();
      await writeAgentStateFile(state, storageOptions);
    },
  };
  return {
    ...service,
// 三个写操作在导出层统一包 mutate：调用方不必知道队列存在，
// 也不会漏包（漏一个就产生未串行的读改写路径）。
    createAgent: (params: AgentCreateParams) => mutate(() => service.createAgent(params)),
    updateAgent: (params: AgentUpdateParams) => mutate(() => service.updateAgent(params)),
    deleteAgent: (params: AgentDeleteParams) => mutate(() => service.deleteAgent(params)),
  };
}

// 校验在落盘前做，错误文案直接给用户看：name 会变成 名字.md，
// 允许路径分隔符或 .. 就能写到 profile 目录之外。
function validateUserAgentConfig(config: SubAgentConfig): void {
  const trimmedName = config.name.trim();
// [权衡] 只允许 ASCII 字母数字与连字符：name 同时是文件名与调用名，
// 放开非 ASCII 会在不同文件系统上产生归一化差异，也让调用名产生歧义。
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  const minNameLength = 3;
  const maxNameLength = 50;
  if (trimmedName.length < minNameLength || trimmedName.length > maxNameLength) {
    throw new Error(`Name must be between ${minNameLength} and ${maxNameLength} characters`);
  }
  if (!nameRegex.test(trimmedName)) {
    throw new Error("Name can only contain letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
// description 与 systemPrompt 都要求非空：前者是 UI 唯一可读说明，
// 后者为空会让 agent 以无角色状态启动，排查成本极高。
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
}

// 与内置名冲突必须在写入前拦住：一旦落盘，applyRuntimePrecedence 会按
// 后写胜出把内置条目挤掉，用户会以为内置 agent 消失了。
function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

// 重命名或改 scope 会改变 id，禁用记录必须跟着搬。
// [事务] 先读、再改集合、最后一次原子写，中途不删除：
// 失败时旧记录仍在，不会出现两边都没禁用的状态。
async function migrateDisabledAgentId(
  previousAgentId: string,
  nextAgentId: string,
  options?: SubagentStorageOptions,
): Promise<void> {
  if (previousAgentId === nextAgentId) {
    return;
  }
// 只有旧 id 确实在禁用集合里才写回；否则保持文件不动，
// 避免一次改名产生无意义的 mtime 变化（会触发外部 watch 重建）。
  const state = await readAgentStateFile(options);
  const disabledSet = new Set(state.disabledAgentIds);
  if (!disabledSet.has(previousAgentId)) {
    return;
  }
  disabledSet.delete(previousAgentId);
  disabledSet.add(nextAgentId);
  return writeAgentStateFile(
    {
      ...state,
      disabledAgentIds: [...disabledSet].sort(),
    },
    options,
  );
}

// 落盘前统一 trim：serialize 用的是原标题，前后空白会让文件名与
// Markdown 里的 name 字段不一致，重命名时按 name 找不到旧文件。
function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
  };
}

function requireWorkspacePath(workspacePath: string | undefined): string {
// workspace scope 必须显式给路径：否则会落到进程 cwd 上拼相对路径，
// 把 profile 写进一个错误的仓库。
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

// 写完立刻回读解析，等价于对 serializer 做一次自检：失败时抛错，
// 此时文件已落盘（见 updateAgent），因此报错必须足够明确以便人工修复。
function parseSavedAgent(
  content: string,
  path: string,
  scope: "user" | "workspace",
  workspacePath?: string,
): AgentSummary {
  const parsed = parseSubagentMarkdown({
    content,
    path,
    scope,
  });
// [失败路径] 诊断信息里带 path，直接透出给用户：这类错误只会出现在
// serializer 与 parser 不同步的回归场景，需要定位到具体文件。
  if (parsed.diagnostic || !parsed.agent) {
    throw new Error(parsed.diagnostic?.message ?? `Failed to parse saved agent: ${path}`);
  }
  return {
    ...parsed.agent,
    projectPath: scope === "workspace" ? workspacePath : undefined,
  };
}
