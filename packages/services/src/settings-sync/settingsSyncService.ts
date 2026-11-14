// ============================================================================
// 设置同步服务：把其它 AI 编码 Agent 的资源导入 ZCode
//
// 链路：detect（发现）→ 用户在设置页勾选 → importSelected（导入）。
// 四类资源各有独立的扫描根表、候选结构、去重键与落盘方式，但共享同一套
// 「候选 → 跳过判定 → 写入 → 结果统计」状态机。
//
// INV-1 扫描路径只由 SUPPORTED_*_AGENT_SOURCES 表决定。新增 Agent 时改表即可，
//       不要在收集函数里写死路径，否则 detect 与 import 会看到不同的资源集合。
// INV-2 源目录只读。本文件只读取外部 Agent 的目录与配置，写入目标永远是
//       ~/.zcode 或 <workspace>/.zcode；写错方向会污染用户的 Claude/Codex 配置。
// INV-3 去重键：skills/commands 用 name（trim + 小写），plugins 用 name@inline，
//       MCP 用 server name（trim + 小写）。改键会让「已存在」判断失效并重复导入。
// INV-4 目标已存在一律跳过（targetExists），绝不覆盖用户已有资源；
//       静默覆盖会丢掉用户手工修改，而且从结果里看不出来。
// INV-5 detect 与 import 必须共用 collect*Candidates 与 skipReason 判定，
//       任何一处单独实现都会让「可导入数」与实际导入结果不一致。
// INV-6 importMode=symlink 时：Windows 目录用 junction、命令文件用硬链接（免提权），
//       其它平台用 symlink；硬链接跨分区失败必须回退复制，不能中断整批。
// INV-7 单个候选失败只累加 failedCount 与 failed 结果，不抛出中断其余候选；
//       中断会让用户重试时面对半套结果，且难以判断哪些已导入。
// INV-8 不缓存磁盘扫描结果：每次 detect/import 都重新遍历，保证用户新装的
//       外部资源立刻可见（代价是 IO；设置页是低频操作，可以接受）。
// INV-9 写入 config.json 一律「读全量 → 合并字段 → 整文件重写」，保留未知字段，
//       避免把用户或其它模块写入的配置抹掉。
// ============================================================================
/* eslint-disable max-lines -- settings-sync 需要集中维护外部 skills/commands/plugins/MCP 扫描、去重和导入状态机，后续按资源类别拆分 */
import type {
  McpServerConfig,
  SettingsSyncAgent,
  SettingsSyncCategory,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncCommandImportResult,
  SettingsSyncCommandSkipReason,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncPluginImportResult,
  SettingsSyncPluginSkipReason,
  SettingsSyncMcpServerImportResult,
  SettingsSyncMcpServerSkipReason,
  SettingsSyncSelection,
  SettingsSyncImportMode,
  SettingsSyncSkillImportResult,
  SettingsSyncSkillSkipReason,
  SettingsSyncSourceScope,
  SettingsSyncSourceRootSummary,
  SettingsSyncTaskImportResult,
} from "@zcode/shared";
import { copyFile, cp, link, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { CommandFileParser } from "../commands/commandFileParser.js";
import type { ISettingService } from "../setting/setting.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { walkSkillMarkdownPaths } from "../skills/skillDiscoveryWalk.js";
import type { ISettingsSyncService } from "./settingsSync.js";

// 统一服务日志：前缀 settings-sync 便于按模块过滤。
// 只记录路径、scope 与错误码，不打印 MCP 配置内容，避免把 env/token 写进日志。
const log = createServiceLogger("settings-sync");

// 依赖刻意保持最小：只有 settingService，用于首启提示的一次性状态。
// 不注入文件系统抽象，是因为同步大量依赖 symlink/junction/硬链接的平台语义，
// 多一层抽象只会把 Windows 与 POSIX 的差异藏起来，反而更难排查。
interface SettingsSyncServiceDependencies {
  settingService: ISettingService;
}

// 内部作用域：user = 用户主目录下的 Agent 目录，workspace = 当前工作区。
// 对外映射为 SettingsSyncSourceScope 的 global / project，映射只发生在
// collect*Candidates 里（root.scope === workspace ? project : global）。
type SkillImportScope = "user" | "workspace";

// 一个待导入 skill 的完整快照。技能以「目录」为单位导入，所以
// sourcePath / targetPath 都指向目录；sourceRootPath 只用于来源摘要分组。
// targetRoot 记录「按来源 scope 推断的默认目标」，import 阶段可被
// selection.targetScope 覆盖；覆盖不回头修改候选本身。
// nameKey 是唯一参与去重的字段，展示用 name 保留大小写。
interface SkillImportCandidate {
  agent: SettingsSyncAgent;
  name: string;
  nameKey: string;
  version?: string;
  sourceRootScope: SettingsSyncSourceScope;
  sourceRootPath: string;
  sourcePath: string;
  targetRoot: string;
  targetPath: string;
  scope: SkillImportScope;
}

// 技能扫描根：agent + 绝对路径 + 作用域；同一 agent 最多两个根（user/workspace）。
interface SkillSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: SkillImportScope;
}

// 外部 Agent 路径表的一行：projectPath 相对工作区，globalPath 相对用户主目录。
// 用字符串数组而不是拼好的路径，跨平台 join 时不会出现分隔符不一致。
interface ExternalAgentPathSource {
  agent: SettingsSyncAgent;
  projectPath: string[];
  globalPath: string[];
}

// 命令与技能同样区分 user/workspace，区别是导入单位为一个 .md 文件。
type CommandImportScope = "user" | "workspace";

// 命令候选：sourceRelativePath 保留源根下的子目录结构（如 git/commit.md），
// 目标路径按同样结构拼接，避免不同子目录下的同名命令互相覆盖。
// name 是带前导 / 的命令名（/git/commit），与 ZCode 的命令寻址方式一致。
interface CommandImportCandidate {
  agent: SettingsSyncAgent;
  argumentHint?: string;
  description?: string;
  name: string;
  nameKey: string;
  sourcePath: string;
  sourceRelativePath: string;
  sourceRootPath: string;
  sourceRootScope: SettingsSyncSourceScope;
  targetPath: string;
  targetRoot: string;
  scope: CommandImportScope;
}

// 命令扫描根，语义同 SkillSourceRoot。
interface CommandSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: CommandImportScope;
}

// 插件同样按 user/workspace 划分来源。
type PluginImportScope = "user" | "workspace";

// 插件候选：id 形如 name@inline，用于与 config.json 里已登记的插件比对。
// 插件按目录整体导入，成功后还要把目标目录写进 plugins.dirs，否则运行时不加载。
interface PluginImportCandidate {
  agent: SettingsSyncAgent;
  id: string;
  name: string;
  sourcePath: string;
  sourceRootPath: string;
  sourceRootScope: SettingsSyncSourceScope;
  targetPath: string;
  targetRoot: string;
  version?: string;
}

// 插件扫描根；只有含 manifest 的子目录才会产出候选。
interface PluginSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: PluginImportScope;
}

// MCP 没有目录概念，导入单位是「某个配置文件里的一个 server 条目」。
type McpImportScope = "user" | "workspace";
type McpConfigFormat = "mcpServersJson" | "mcpJson" | "codexToml";

// MCP 候选：sourcePath 采用「文件路径#serverName」形式，既是前端唯一标识，
// 也直接作为 selection.mcpServerPaths 的匹配键。
interface McpImportCandidate {
  agent: SettingsSyncAgent;
  name: string;
  nameKey: string;
  config: McpServerConfig;
  sourceRootScope: SettingsSyncSourceScope;
  sourceRootPath: string;
  sourcePath: string;
}

// MCP 扫描根：一个配置文件 + 解析格式；一个文件可包含多个 server。
interface McpSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: McpImportScope;
  format: McpConfigFormat;
}

// MCP 路径表：同一 Agent 可能有多个候选配置文件（如 Claude 的 settings.json
// 与 .mcp.json），因此 projectFiles / globalFiles 是二维数组。
interface ExternalAgentMcpPathSource {
  agent: SettingsSyncAgent;
  projectFiles: string[][];
  globalFiles: string[][];
  format: McpConfigFormat;
}

// 技能扫描表。数组顺序决定设置页里 Agent 的展示顺序，改动时保持成组、不要重排。
// openClaw 的项目级路径是工作区根下的 skills/（不是 .openclaw/skills），这是上游约定。
// 新增 Agent 前先确认 SettingsSyncAgent 联合类型已包含该值，否则 typecheck 会失败。
// 表里同时给出 user 与 workspace 两套路径，collectSkillImportCandidates 会两遍展开。
const SUPPORTED_SKILL_AGENT_SOURCES: ExternalAgentPathSource[] = [
  { agent: "claudeCode", projectPath: [".claude", "skills"], globalPath: [".claude", "skills"] },
  { agent: "codexCli", projectPath: [".codex", "skills"], globalPath: [".codex", "skills"] },
  {
    agent: "openCode",
    projectPath: [".opencode", "skills"],
    globalPath: [".config", "opencode", "skills"],
  },
  { agent: "openClaw", projectPath: ["skills"], globalPath: [".openclaw", "skills"] },
  { agent: "augment", projectPath: [".augment", "skills"], globalPath: [".augment", "skills"] },
  {
    agent: "continue",
    projectPath: [".continue", "skills"],
    globalPath: [".continue", "skills"],
  },
  { agent: "goose", projectPath: [".goose", "skills"], globalPath: [".config", "goose", "skills"] },
  { agent: "qwenCode", projectPath: [".qwen", "skills"], globalPath: [".qwen", "skills"] },
  { agent: "qode", projectPath: [".qoder", "skills"], globalPath: [".qoder", "skills"] },
  { agent: "qodeCn", projectPath: [".qoder", "skills"], globalPath: [".qoder-cn", "skills"] },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "skills"],
    globalPath: [".codeium", "windsurf", "skills"],
  },
  { agent: "trae", projectPath: [".trae", "skills"], globalPath: [".trae", "skills"] },
  { agent: "traeCn", projectPath: [".trae", "skills"], globalPath: [".trae-cn", "skills"] },
  { agent: "kiroCli", projectPath: [".kiro", "skills"], globalPath: [".kiro", "skills"] },
  { agent: "roo", projectPath: [".roo", "skills"], globalPath: [".roo", "skills"] },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "skills"],
    globalPath: [".codebuddy", "skills"],
  },
];

// 命令扫描表。注意 traeCn 在这里没有独立条目（只有 trae），
// 而技能表与 MCP 表里有；这是各 Agent 实际目录布局的差异，不是遗漏。
const SUPPORTED_COMMAND_AGENT_SOURCES: ExternalAgentPathSource[] = [
  {
    agent: "claudeCode",
    projectPath: [".claude", "commands"],
    globalPath: [".claude", "commands"],
  },
  {
    agent: "codexCli",
    projectPath: [".codex", "commands"],
    globalPath: [".codex", "commands"],
  },
  {
    agent: "openCode",
    projectPath: [".opencode", "commands"],
    globalPath: [".config", "opencode", "commands"],
  },
  {
    agent: "openClaw",
    projectPath: ["commands"],
    globalPath: [".openclaw", "commands"],
  },
  {
    agent: "augment",
    projectPath: [".augment", "commands"],
    globalPath: [".augment", "commands"],
  },
  {
    agent: "continue",
    projectPath: [".continue", "commands"],
    globalPath: [".continue", "commands"],
  },
  {
    agent: "goose",
    projectPath: [".goose", "commands"],
    globalPath: [".config", "goose", "commands"],
  },
  {
    agent: "qwenCode",
    projectPath: [".qwen", "commands"],
    globalPath: [".qwen", "commands"],
  },
  {
    agent: "qode",
    projectPath: [".qoder", "commands"],
    globalPath: [".qoder", "commands"],
  },
  {
    agent: "qodeCn",
    projectPath: [".qoder", "commands"],
    globalPath: [".qoder-cn", "commands"],
  },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "commands"],
    globalPath: [".codeium", "windsurf", "commands"],
  },
  {
    agent: "trae",
    projectPath: [".trae", "commands"],
    globalPath: [".trae", "commands"],
  },
  {
    agent: "kiroCli",
    projectPath: [".kiro", "commands"],
    globalPath: [".kiro", "commands"],
  },
  {
    agent: "roo",
    projectPath: [".roo", "commands"],
    globalPath: [".roo", "commands"],
  },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "commands"],
    globalPath: [".codebuddy", "commands"],
  },
];

// 插件扫描表：路径下每个含 manifest 的一级子目录算一个插件，不递归。
const SUPPORTED_PLUGIN_AGENT_SOURCES: ExternalAgentPathSource[] = [
  {
    agent: "claudeCode",
    projectPath: [".claude", "plugins"],
    globalPath: [".claude", "plugins"],
  },
  {
    agent: "codexCli",
    projectPath: [".codex", "plugins"],
    globalPath: [".codex", "plugins"],
  },
  {
    agent: "openCode",
    projectPath: [".opencode", "plugins"],
    globalPath: [".config", "opencode", "plugins"],
  },
  {
    agent: "openClaw",
    projectPath: ["plugins"],
    globalPath: [".openclaw", "plugins"],
  },
  {
    agent: "augment",
    projectPath: [".augment", "plugins"],
    globalPath: [".augment", "plugins"],
  },
  {
    agent: "continue",
    projectPath: [".continue", "plugins"],
    globalPath: [".continue", "plugins"],
  },
  {
    agent: "goose",
    projectPath: [".goose", "plugins"],
    globalPath: [".config", "goose", "plugins"],
  },
  {
    agent: "qwenCode",
    projectPath: [".qwen", "plugins"],
    globalPath: [".qwen", "plugins"],
  },
  {
    agent: "qode",
    projectPath: [".qoder", "plugins"],
    globalPath: [".qoder", "plugins"],
  },
  {
    agent: "qodeCn",
    projectPath: [".qoder", "plugins"],
    globalPath: [".qoder-cn", "plugins"],
  },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "plugins"],
    globalPath: [".codeium", "windsurf", "plugins"],
  },
  {
    agent: "trae",
    projectPath: [".trae", "plugins"],
    globalPath: [".trae", "plugins"],
  },
  {
    agent: "kiroCli",
    projectPath: [".kiro", "plugins"],
    globalPath: [".kiro", "plugins"],
  },
  {
    agent: "roo",
    projectPath: [".roo", "plugins"],
    globalPath: [".roo", "plugins"],
  },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "plugins"],
    globalPath: [".codebuddy", "plugins"],
  },
];

// MCP 扫描表：codex 用 TOML（config.toml 的 mcp_servers），openCode 用自有
// mcpJson 结构（command 可能是数组、type 用 local/remote），其余按 mcpServers 包裹。
// agents 是跨工具通用约定目录（.agents/mcp.json），不属于任何具体厂商。
const SUPPORTED_MCP_AGENT_SOURCES: ExternalAgentMcpPathSource[] = [
  {
    agent: "claudeCode",
    projectFiles: [[".claude", "settings.json"], [".mcp.json"]],
    globalFiles: [[".claude", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codexCli",
    projectFiles: [[".codex", "config.toml"]],
    globalFiles: [[".codex", "config.toml"]],
    format: "codexToml",
  },
  {
    agent: "openCode",
    projectFiles: [[".opencode", "opencode.json"]],
    globalFiles: [[".config", "opencode", "opencode.json"]],
    format: "mcpJson",
  },
  {
    agent: "openClaw",
    projectFiles: [["settings.json"]],
    globalFiles: [[".openclaw", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qwenCode",
    projectFiles: [[".qwen", "settings.json"]],
    globalFiles: [[".qwen", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qode",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qodeCn",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder-cn", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "trae",
    projectFiles: [[".trae", "settings.json"]],
    globalFiles: [[".trae", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "kiroCli",
    projectFiles: [[".kiro", "settings.json"]],
    globalFiles: [[".kiro", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "roo",
    projectFiles: [[".roo", "settings.json"]],
    globalFiles: [[".roo", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codeBuddy",
    projectFiles: [[".codebuddy", "settings.json"]],
    globalFiles: [[".codebuddy", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "agents",
    projectFiles: [[".agents", "mcp.json"]],
    globalFiles: [[".agents", "mcp.json"]],
    format: "mcpServersJson",
  },
];

// 插件 manifest 的候选位置，按 zcode → claude → codex 顺序尝试。
// 只取第一个命中的 manifest，保证同一插件不会被识别成多个来源。
const ZCODE_PLUGIN_MANIFEST_PATH = [".zcode-plugin", "plugin.json"] as const;
const CLAUDE_PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;
const CODEX_PLUGIN_MANIFEST_PATH = [".codex-plugin", "plugin.json"] as const;
const INLINE_PLUGIN_MARKETPLACE = "inline";

// 优先读 HOME / USERPROFILE，再回落 os.homedir()：
// 测试与打包环境里 homedir() 可能指向真实用户目录，环境变量可以被显式覆盖。
function resolveUserHomeDir(): string {
// Windows 用 USERPROFILE，POSIX 用 HOME；两者都 trim 后再判空，
// 避免环境变量被设成空格时返回一个不存在的根目录。
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
// 环境变量优先，取不到才回落 os.homedir()；homedir 在部分打包环境下可能被重定向。
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 目标目录统一收口：改目录结构时只改这些 getter，不要在调用点拼路径。
function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
// 与工作区技能目录一致：<ws>/.zcode/skills。
  return join(workspacePath, ".zcode", "skills");
}

// 用户级技能目标根：~/.zcode/skills。
function getUserZcodeSkillRoot(): string {
// 与用户级技能目录一致：~/.zcode/skills。
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

// 工作区命令目标根：<ws>/.zcode/commands。
function getWorkspaceZcodeCommandRoot(workspacePath: string): string {
// 工作区命令目录：<ws>/.zcode/commands。
  return join(workspacePath, ".zcode", "commands");
}

// 用户级命令目标根：~/.zcode/commands。
function getUserZcodeCommandRoot(): string {
// 用户级命令目录：~/.zcode/commands。
  return join(resolveUserHomeDir(), ".zcode", "commands");
}

// 工作区插件目标根：<ws>/.zcode/plugins。
function getWorkspaceZcodePluginRoot(workspacePath: string): string {
// 工作区插件目录：<ws>/.zcode/plugins。
  return join(workspacePath, ".zcode", "plugins");
}

// 用户级插件目标根：~/.zcode/plugins。
function getUserZcodePluginRoot(): string {
// 用户级插件目录：~/.zcode/plugins。
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

// 全局 CLI 配置：~/.zcode/cli/config.json。
// 用户级插件登记与 MCP server 都写这里，写前必须整文件读入再合并。
function getUserZcodeCliConfigPath(): string {
// 全局 CLI 配置；插件登记与用户级 MCP server 都落在这个文件。
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

// 工作区配置：<ws>/.zcode/config.json，结构与全局配置一致但作用域不同。
function getWorkspaceZcodeConfigPath(workspacePath: string): string {
// 工作区配置；与全局配置同构，但只影响当前工作区。
  return join(workspacePath, ".zcode", "config.json");
}

// Claude 的全局指令文件：~/.claude/CLAUDE.md，是迁移到 AGENTS.md 的来源。
function getClaudeUserAgentsFileSourcePath(): string {
// 迁移源固定为用户级文件，不读取工作区里的 CLAUDE.md。
  return join(resolveUserHomeDir(), ".claude", "CLAUDE.md");
}

// ZCode 的全局指令文件：~/.zcode/AGENTS.md，迁移的目标。
function getUserZcodeAgentsFilePath(): string {
// 迁移目标固定为 ZCode 用户级指令文件。
  return join(resolveUserHomeDir(), ".zcode", "AGENTS.md");
}

// 把「目标作用域」解析为技能目标根：global → ~/.zcode/skills，
// project → <ws>/.zcode/skills；工作区未打开时返回 null，
// 由调用方记为 skipped(targetExists)，不猜测落点。
function resolveTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
// global 作用域不依赖工作区，始终可解析。
    return getUserZcodeSkillRoot();
  }
// project 作用域必须有工作区路径；没有则返回 null，由调用方记为跳过。
  return workspacePath ? getWorkspaceZcodeSkillRoot(workspacePath) : null;
}

// 按「来源作用域」推断默认目标根：工作区来源进工作区，用户来源进用户目录。
// 不处理 selection.targetScope 覆盖，覆盖只发生在 import 阶段。
function resolveCandidateTargetRoot(
  sourceScope: SkillImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
// 工作区来源但窗口未打开：没有目标目录，候选在收集阶段即被丢弃。
    ? workspacePath ? getWorkspaceZcodeSkillRoot(workspacePath) : null
    : getUserZcodeSkillRoot();
}

// 命令目标根解析，规则同技能，落点为 .zcode/commands。
function resolveCommandTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
// 命令的 global 目标根，不依赖工作区。
    return getUserZcodeCommandRoot();
  }
// project 作用域必须由调用方给出 workspacePath；缺失时返回 null，
// 调用方据此跳过该作用域，而不是悄悄回落到 global 目录。
  return workspacePath ? getWorkspaceZcodeCommandRoot(workspacePath) : null;
}

// 命令候选的默认目标根；工作区缺失时返回 null。
function resolveCommandCandidateTargetRoot(
  sourceScope: CommandImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
// project 作用域缺 workspacePath 时定位不到 .zcode/commands，
// 返回 null 让调用方把候选记为"无目标根"并跳过。
    ? workspacePath ? getWorkspaceZcodeCommandRoot(workspacePath) : null
    : getUserZcodeCommandRoot();
}

// 插件目标根解析，落点为 .zcode/plugins。
function resolvePluginTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
// 插件的 global 目标根，不依赖工作区。
    return getUserZcodePluginRoot();
  }
// project 作用域缺 workspacePath 时定位不到 .zcode/plugins；
// 这里返回 null 而不是回落到用户目录，避免把工程级插件写成全局插件。
  return workspacePath ? getWorkspaceZcodePluginRoot(workspacePath) : null;
}

// resolvePluginCandidateTargetRoot 给出插件候选的默认目标根。
function resolvePluginCandidateTargetRoot(
  sourceScope: PluginImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
// project 作用域缺 workspacePath 时没有可写的插件目录，
// 返回 null 由调用方跳过，不能退化成用户级根。
    ? workspacePath ? getWorkspaceZcodePluginRoot(workspacePath) : null
    : getUserZcodePluginRoot();
}

// 插件注册表路径：global 写 ~/.zcode/cli/config.json，project 写 <ws>/.zcode/config.json。
// 两份配置结构一致（plugins.dirs），但作用域不同，不能互相代替。
function resolvePluginConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
// 插件注册表与 MCP 配置同址：global 取用户级 CLI 配置，project 取工作区配置。
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
// 缺少工作区时返回 null，调用方据此把该作用域记为「无配置落点」，不回落到全局文件。
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

// MCP 与插件共用同一份 config.json，只是写入字段不同（mcp.servers）。
function resolveMcpConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
// 落点与插件注册表一致，后续写入的是 mcp.servers 而不是 plugins.dirs。
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
// project 写入工作区 config.json；把两个作用域合并会破坏 MCP 的可见性边界。
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

// 技能以「目录」为单位导入：symlink 模式建目录链接，否则递归复制。
// cp 固定 errorOnExist + force:false：目标存在时必须抛错而不是覆盖，
// 覆盖会静默替换用户手工改过的技能文件；调用方会把它计入 failed。
// symlink 模式不额外占用磁盘，源目录更新会立即反映到目标；
// 复制模式让目标独立，源目录被删除或卸载后已导入技能仍可用。
// 两种模式由 importMode 决定，默认 symlink 是为了节省空间并保持同步。
// 目标父目录由调用方 mkdir，本函数只负责最后一步链接/复制。
// 失败时不做半成品清理：cp 可能已经写入部分文件，
// 主动递归删除有误删风险（目标路径由外部输入拼接），
// 留待用户按结果里的路径自行处理更安全。
// symlink 失败通常只剩一个空父目录，影响可忽略。
async function importSkillDirectory(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
// symlink 分支只建一条指向源目录的链接，源目录后续更新会即时反映到目标。
  if (importMode === "symlink") {
    await createDirectorySymlink(sourcePath, targetPath);
    return;
  }
// 复制分支用 errorOnExist + force:false：目标已存在时抛错交给批量层记 failed，
// 既不覆盖用户改过的文件，也不在失败后递归清理半成品。
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

// Windows 的目录软链需要开发者模式或管理员权限，junction 不需要且对本地盘等价；
// 其它平台用 dir。导出这个判断是为了让同步实现与测试复用同一结论，
// 不要在调用点各自判断 process.platform。
export function getSkillDirectorySymlinkType(
  platform: NodeJS.Platform | string = process.platform,
): "dir" | "junction" {
// junction 只支持本地绝对路径目录，正好匹配这里的用法；
// 其它平台用 dir 类型，行为与普通软链一致。
  return platform === "win32" ? "junction" : "dir";
}

// 命令是单文件，非 Windows 平台直接建文件软链；
// 返回字面量类型而不是 string，是为了让 symlink 的类型收窄通过。
export function getCommandFileSymlinkType(): "file" {
  return "file";
}

// 统一入口：source 先 resolve 成绝对路径再建链。
// junction 会原样保存目标字符串，相对路径在不同 cwd 下会解析到不同位置。
async function createDirectorySymlink(sourcePath: string, targetPath: string): Promise<void> {
  // Windows 创建目录软链需要 junction；其它平台使用 dir。source 使用绝对路径，避免 junction
  // 在不同 cwd 下解析目标不一致。
// [失败路径] 目标已存在时 symlink 会抛 EEXIST；
// 调用方在此之前已做 targetExists 判定，这里不吞异常以便暴露竞态。
  await symlink(resolve(sourcePath), targetPath, getSkillDirectorySymlinkType());
}

// 命令文件导入按平台分三条路径：
// - Windows：文件级 symlink 需提权，改用硬链接；硬链接双向同步且免提权；
// - 非 Windows：直接 symlink；
// - Windows 硬链接失败（EXDEV 跨分区、EACCES 等）：回退复制，保证单个文件失败
//   不会让整批导入中断。三路最终都落到同一个目标路径，调用方无需感知差异。
// 目标父目录（含子目录结构）由调用方创建，本函数只写最终路径。
// 三种平台分支的最终目标路径完全一致，因此 skipReason 与 discover 无需感知模式。
// 回退复制时会丢失「源文件修改自动同步」的能力，日志里保留原始错误码。
// Windows 的回退分支只在 link 抛错时执行，成功路径没有额外判断；
// 因此正常导入的性能与直接 link 相同。
// 回退前不会删除已半创建的链接：link 失败时目标并未产生。
async function importCommandFile(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
  if (importMode === "symlink") {
// [权衡] Windows 优先硬链接而不是复制：硬链接让源文件后续修改能立刻反映过来，
// 更接近 symlink 的语义；代价是跨分区不可用，因此必须有回退。
    if (process.platform === "win32") {
      // Windows 创建文件级 symlink 需要管理员权限，改用硬链接。
      // 硬链接不需要提权，且文件修改能双向同步。
      // 跨分区（EXDEV）等硬链接失败时回退到复制。
      try {
// 硬链接目标必须是绝对路径，否则会相对进程 cwd 解析。
        await link(resolve(sourcePath), targetPath);
        log.info(undefined, "[importCommandFile] Windows 硬链接创建成功", {
          sourcePath,
          targetPath,
        });
        return;
      } catch (linkError) {
        // 记录硬链接失败原因（EXDEV 跨分区 / EACCES 权限等），便于排查
        const linkErrorCode = (linkError as NodeJS.ErrnoException)?.code;
        log.warn(undefined, "[importCommandFile] Windows 硬链接失败，回退到复制模式", {
          sourcePath,
          targetPath,
          linkErrorCode,
          linkErrorMessage: (linkError as Error)?.message,
        });
      }
    } else {
      // 非 Windows 平台使用 symlink，不需要提权。
// [失败路径] 非 Windows 的 symlink 失败不吞掉：目标目录已由调用方 mkdir，
// 这里的失败通常是权限或文件系统限制，应计入 failed 让用户看到。
      await symlink(resolve(sourcePath), targetPath, getCommandFileSymlinkType());
      return;
    }
  }
  await cp(sourcePath, targetPath, {
    errorOnExist: true,
    force: false,
  });
}

// 插件按整个目录导入，语义同技能目录。
// 必须保留目录内相对结构（commands/、agents/ 等），运行时按相对路径查找资源。
// cp 失败可能留下部分目录；下一次导入会因 targetExists 跳过，
// 需要用户手动删除残留后重试。这是两阶段写入的已知代价。
// symlink 模式只在目标不存在时建链，不会合并到已有目录。
async function importPluginDirectory(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
// symlink 分支不合并进已有目录，只在目标不存在时建立整目录链接。
  if (importMode === "symlink") {
    await createDirectorySymlink(sourcePath, targetPath);
    return;
  }
// 复制分支保留 commands/、agents/ 等相对结构，运行时依赖这些相对路径定位资源。
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

// 汇总技能扫描根：先全部 user 根，再追加 workspace 根。
// 顺序决定同名资源「先到先得」：user 在前可避免工作区里的临时副本
// 抢占用户级技能。未提供 workspacePath 时只返回 user 根，
// 因为全局导入不应该要求当前必须有打开的窗口。
function getExternalSkillRoots(workspacePath?: string): SkillSourceRoot[] {
  const home = resolveUserHomeDir();
// user 根由 globalPath 拼接用户主目录；map 不改变表顺序。
  const userRoots: SkillSourceRoot[] = SUPPORTED_SKILL_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
// 没有工作区时只返回 user 根：全局导入与当前窗口无关，不应因此被拦住。
  if (!workspacePath) {
    // 全局技能导入不应依赖当前窗口必须打开 workspace。
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_SKILL_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

// 命令扫描根，构造方式与技能一致：user 在前、workspace 在后。
function getExternalCommandRoots(workspacePath?: string): CommandSourceRoot[] {
  const home = resolveUserHomeDir();
// 命令 user 根，构造方式与技能一致。
  const userRoots: CommandSourceRoot[] = SUPPORTED_COMMAND_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
// 命令扫描也允许只做全局导入，此时不要求窗口绑定工作区。
  if (!workspacePath) {
    return userRoots;
  }
// workspace 根追加在 user 根之后，保证同名命令优先命中用户级来源。
  return [
    ...userRoots,
    ...SUPPORTED_COMMAND_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

// 插件扫描根：按 SUPPORTED_PLUGIN_AGENT_SOURCES 为每个外部 Agent 展开 user 根，
// 有 workspacePath 时再叠加 project 根，结构与命令扫描根一致（每 Agent 一根）。
function getExternalPluginRoots(workspacePath?: string): PluginSourceRoot[] {
  const home = resolveUserHomeDir();
// 插件 user 根，构造方式与技能一致。
  const userRoots: PluginSourceRoot[] = SUPPORTED_PLUGIN_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
// 无工作区时插件只扫 user 根，与命令/技能保持同一套「全局优先」顺序。
  if (!workspacePath) {
    return userRoots;
  }
// project 根按同一 Agent 表展开，保证每个 Agent 的插件目录一一对应。
  return [
    ...userRoots,
    ...SUPPORTED_PLUGIN_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

// MCP 扫描根：globalFiles / projectFiles 是二维数组，flatMap 后一个文件一个根。
// 同一 Agent 的多个文件都可能贡献 server，最终由候选收集阶段的 seenKey 去重。
// 这里不检查文件是否存在，存在性判断留给收集函数，便于统一处理缺失目录。
function getExternalMcpRoots(workspacePath?: string): McpSourceRoot[] {
  const home = resolveUserHomeDir();
// flatMap 把「每个 Agent 的多个配置文件」摊平成多个根；
// 顺序保持表顺序，便于结果稳定。
  const userRoots: McpSourceRoot[] = SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) =>
    source.globalFiles.map((globalFile) => ({
      agent: source.agent,
      rootPath: join(home, ...globalFile),
      scope: "user" as const,
      format: source.format,
    })),
  );
// 没有工作区就只返回全局配置文件根，MCP 的全局导入不依赖窗口。
  if (!workspacePath) {
    return userRoots;
  }
// project 文件同样一文件一根，scope 标成 workspace 供后续作用域判定使用。
  return [
    ...userRoots,
    ...SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) =>
      source.projectFiles.map((projectFile) => ({
        agent: source.agent,
        rootPath: join(workspacePath, ...projectFile),
        scope: "workspace" as const,
        format: source.format,
      })),
    ),
  ];
}

// 目录存在性判断：用 readdir 而不是 stat，文件路径会因 ENOTDIR 返回 false，
// 语义上等价于「不是一个可读目录」。捕获所有异常是刻意的：
// 权限不足同样视为不可扫描，而不是让整个 detect 失败。
async function exists(path: string): Promise<boolean> {
  try {
// 能 readdir 才说明是可扫描目录；普通文件会以 ENOTDIR 落到 catch。
    await readdir(path);
    return true;
  } catch {
// 权限不足、路径不存在都归为「不可扫描」，让 detect 继续处理其它根。
    return false;
  }
}

// 任意路径存在性判断，lstat 不跟随软链：断链的软链仍算存在。
// 这一点对命令文件与插件目录很重要——断链不应被当成「空位」而被覆盖。
async function pathExists(path: string): Promise<boolean> {
  try {
// lstat 不跟随软链，断链也会返回成功，从而被判定为「已占用」。
    await lstat(path);
    return true;
  } catch {
// 只有真正不存在或无权访问才返回 false，避免把断链当成空位覆盖。
    return false;
  }
}

// 复用共享的有界遍历（限制深度、跳过 node_modules 等内容目录、软链去重），
// 避免在用户主目录这类巨型目录上无限递归或卡死。
// 结果用 Set 去重后排序，保证不同文件系统返回顺序不一致时 detect 输出仍然稳定。
async function collectSkillMarkdownPaths(rootPath: string): Promise<string[]> {
  // 复用共享的有界遍历（排除 node_modules 等内容目录、限制深度、软链去重），
  // 与桌面端技能扫描保持一致，避免设置同步在巨型目录上卡死。
  const discovered = new Set<string>();
// 异步迭代器逐个产出 SKILL.md 路径；这里用 Set 兜底，防止软链指向同一文件时重复。
  for await (const skillPath of walkSkillMarkdownPaths(rootPath)) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

// 命令目录遍历没有复用技能遍历，因为命令允许任意层级子目录，
// 且需要跳过以 . 开头的目录（.git、.DS_Store 同级目录等）。
// 用显式栈而不是递归，避免深层嵌套爆栈；单个目录读取失败静默跳过，
// 让一个不可读目录不会毁掉整次扫描。
async function collectCommandMarkdownPaths(rootPath: string): Promise<string[]> {
  const discovered = new Set<string>();
// [资源] 深度优先但结果统一排序；栈里只放绝对路径，pop 后直接 readdir。
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries;
    try {
// withFileTypes 省掉每个子项一次 stat；读取失败直接 continue，
// 让单个不可读子目录不阻塞其它目录。
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
// 先拼绝对路径再按类型分流，避免目录/文件判断各拼一次。
      const fullPath = join(currentDir, entry.name);
// 目录入栈继续遍历；进入前已过滤 . 开头目录（.git 等）。
      if (entry.isDirectory()) {
// 目录入栈后继续展开；子目录里的 .md 同样视为命令。
        stack.push(fullPath);
        continue;
      }
// 只认 .md（大小写不敏感）；其它文件（README、脚本）不是命令。
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
// 只收 .md 文件；目录继续入栈，因此命令可以放在任意深度。
        discovered.add(fullPath);
      }
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

// 按 zcode → claude → codex 顺序找 manifest，返回第一个存在的路径。
// 顺序即优先级：ZCode 自己的 manifest 覆盖同名外部插件；
// 三项都缺失则返回 null，调用方据此判断该目录不是插件。
async function findPluginManifestPath(pluginPath: string): Promise<string | null> {
// 第一优先：ZCode 自有 manifest 目录。
  const zcodeManifestPath = join(pluginPath, ...ZCODE_PLUGIN_MANIFEST_PATH);
// 命中即返回，不再尝试后面的候选，保证同一插件只有一个识别结果。
  if (await pathExists(zcodeManifestPath)) {
    return zcodeManifestPath;
  }
// 第二优先：Claude 插件规范；两者结构兼容，按目录名区分来源。
  const claudeManifestPath = join(pluginPath, ...CLAUDE_PLUGIN_MANIFEST_PATH);
// 只有在没有 zcode manifest 时才会走到这里。
  if (await pathExists(claudeManifestPath)) {
    return claudeManifestPath;
  }
// 第三优先：Codex 插件规范。
  const codexManifestPath = join(pluginPath, ...CODEX_PLUGIN_MANIFEST_PATH);
// 最后一个候选；仍不存在则由调用方判定该目录不是插件。
  if (await pathExists(codexManifestPath)) {
    return codexManifestPath;
  }
  return null;
}

// 插件只扫描根下一层目录（含软链目录），不递归：插件目录本身是一个整体。
// 目录名以 . 开头的跳过（.git 等）；是否算插件取决于目录内是否有 manifest，
// 避免把任意子目录误判成插件。读取根失败时返回空数组而不是抛错。
async function collectPluginPaths(rootPath: string): Promise<string[]> {
  let entries;
  try {
// 插件根读取失败时返回空数组而不是抛错：根可能在扫描期间被删除。
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
// 只收集有 manifest 的一级子目录；数组类型由 push 推导出 string[]。
  const discovered = [];
  for (const entry of entries) {
// 插件目录可以是真实目录或软链：插件市场常用软链把外部仓库挂进来。
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }
// 插件路径是根 + 目录名，不递归；manifest 只在该层查找。
    const pluginPath = join(rootPath, entry.name);
// 只看「有 manifest」这一事实，不解析内容；name 的校验留给 readPluginMetadata。
    if (await findPluginManifestPath(pluginPath)) {
      discovered.push(pluginPath);
    }
  }
// 排序保证不同文件系统下的发现顺序一致，避免 UI 抖动。
  return discovered.sort((left, right) => left.localeCompare(right));
}

// 通用对象收窄：排除 null 与数组。JSON/YAML 解析结果在边界上都是 unknown，
// 后续所有字段访问都先过这个守卫。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 技能去重键：trim + 小写。大小写不敏感是为了兼容 macOS 默认文件系统，
// 同时也让 frontmatter 里手写的 Name 与目录名视为同名。
function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// 简易 YAML 标量去引号：只处理成对的首尾引号，不解析转义。
// 仅用于 YAML 解析失败时的宽松兜底，不要把它当成通用 YAML 解析器。
function stripYamlScalarQuotes(value: string): string {
// 先去空白再判断引号，避免 " x " 这类写法漏掉去引号逻辑。
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
// 只有成对首尾引号才剥一层；单边引号按普通字符保留，避免误伤正文内容。
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// 宽松读取 frontmatter 的 name 行：YAML 解析失败时仍尽量拿到名字，
// 取不到则回落到目录名，保证候选不会因为元数据损坏而消失。
function readLooseSkillName(frontmatterText: string, fallbackName: string): string {
// 宽松正则只认行首 name:，不处理嵌套或注释；用于 YAML 失败后的兜底。
  const match = /^name\s*:\s*(.+)$/m.exec(frontmatterText);
  return stripYamlScalarQuotes(match?.[1] ?? fallbackName) || fallbackName;
}

// 宽松读取 version 行；空串视为未声明，统一返回 undefined。
function readLooseSkillVersion(frontmatterText: string): string | undefined {
// version 的兜底读取：YAML 解析失败时只认行首 version:，去引号后仍有内容才算声明。
  const match = /^version\s*:\s*(.+)$/m.exec(frontmatterText);
  const version = stripYamlScalarQuotes(match?.[1] ?? "");
  return version.length > 0 ? version : undefined;
}

// 从 SKILL.md 的 frontmatter 读 name / version：
// - 先按 --- 切出 frontmatter，没有则直接用目录名；
// - 优先走 YAML 解析，字段类型不符时用宽松正则兜底；
// - name 缺省回落目录名，version 缺省则不写该字段（保持 undefined 语义）。
// 这里吞掉解析异常是刻意的：单个损坏的技能文件不应让整次扫描失败。
function readSkillMetadataFromMarkdown(
  content: string,
  fallbackName: string,
): { name: string; version?: string } {
// 先把 CRLF/CR 统一成 LF，frontmatter 正则只认 \n；
// 否则 Windows 上手工编辑过的 SKILL.md 会被判成没有 frontmatter。
  const normalized = content.replace(/\r\n|\r/g, "\n");
// 先统一换行再匹配，避免 CRLF 文件被当成「没有 frontmatter」；
// 正则要求 --- 独占一行，正文里的水平线不会误触发。
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
// 没有 frontmatter 不是错误：很多简单技能只写正文。
// 此时 name 用目录名，version 视为未声明。
  if (!frontmatterMatch) {
    return { name: fallbackName };
  }
// 捕获组可能为空（--- 之间没有内容），用空串兜底以保持后续解析类型稳定。
  const frontmatterText = frontmatterMatch[1] ?? "";
  try {
// [失败路径] YAML 解析可能抛错（缩进错误、重复键等），
// 因此整段包在 try 里，失败后走宽松正则兜底而不是让候选消失。
    const parsed = parseYaml(frontmatterText);
// 只有对象才按字段读取；YAML 顶层是标量时走下面的兜底分支。
    if (isRecord(parsed)) {
// YAML name 是字符串且非空才采用；否则回落到宽松读取/目录名。
      const name = typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : readLooseSkillName(frontmatterText, fallbackName);
// 版本允许写成数字（如 1.2），统一转成字符串；
// 其它类型（对象/数组）视为未声明。
      const parsedVersion = typeof parsed.version === "string" || typeof parsed.version === "number"
        ? String(parsed.version).trim()
        : "";
// YAML 拿到空版本时再用宽松正则补一次，兼容 version 写成注释等畸形情况。
      const version = parsedVersion || readLooseSkillVersion(frontmatterText);
      return {
        name,
        ...(version ? { version } : {}),
      };
    }
  } catch {
    const version = readLooseSkillVersion(frontmatterText);
    return {
      name: readLooseSkillName(frontmatterText, fallbackName),
      ...(version ? { version } : {}),
    };
  }
  const version = readLooseSkillVersion(frontmatterText);
  return {
    name: readLooseSkillName(frontmatterText, fallbackName),
    ...(version ? { version } : {}),
  };
}

// 读单个技能文件；IO 失败（权限、竞态删除）同样回落目录名，
// 保证候选列表不会因为个别文件不可读而出现空洞。
async function readSkillMetadata(skillPath: string): Promise<{ name: string; version?: string }> {
// 技能目录名是 frontmatter 缺失时的默认名字；
// 用 dirname 而不是 basename(skillPath)，因为路径指向 SKILL.md 本身。
  const fallbackName = basename(dirname(skillPath));
  try {
// 读文件后交给纯函数解析；目录名作为 fallback 一并传入。
    return readSkillMetadataFromMarkdown(await readFile(skillPath, "utf-8"), fallbackName);
  } catch {
    return { name: fallbackName };
  }
}

// 只需要去重键时不必构造完整元数据；单独收口避免调用点重复 normalize。
async function readSkillNameKey(skillPath: string): Promise<string> {
// 读全量元数据再取 name，保证与导入阶段使用的名字完全一致。
  return normalizeSkillNameKey((await readSkillMetadata(skillPath)).name);
}

// 收集目标根下已有技能的名键，用于 sameNameExists 判断。
// 目标根不存在直接返回空集，避免首次导入时做无意义遍历。
// 调用方按 targetRoot 缓存这份集合，同批次内不重复扫描。
async function collectExistingSkillNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
// 目标根尚未创建时直接返回空集，省掉一次无意义的目录遍历。
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
// 目标根下每个 SKILL.md 贡献一个已占用名键；不解析目录名，只看 frontmatter/name。
  for (const skillPath of await collectSkillMarkdownPaths(rootPath)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

// 命令去重键：trim + 小写；命令名本身带前导 /，不做额外归一。
function normalizeCommandNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// 由相对路径生成命令名：去掉 .md、按 / 归一，最终形如 /git/commit。
// 归一化分隔符是为了让 Windows 上的反斜杠不会进入命令名。
// 子目录结构被保留，因此不同目录下的同名文件不会撞名。
function getCommandNameFromPath(rootPath: string, filePath: string): string {
// 相对路径是命令名的唯一来源，与文件内容无关，因此坏文件也能得到稳定名字。
// 去掉扩展名时大小写不敏感：.MD 也认；保留其余相对路径层级用于命令名。
  const relativePath = relative(rootPath, filePath).replace(/\.md$/i, "");
  return `/${relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/")}`;
}

// 读取命令元数据：name 由路径推导，description / argumentHint 交给 CommandFileParser。
// 解析失败只丢元数据、不丢候选——name 已经可以从路径得到，
// 因此损坏的命令文件仍会出现在发现列表里，由用户自行决定是否导入。
async function readCommandMetadata(params: {
  filePath: string;
  rootPath: string;
}): Promise<{
  argumentHint?: string;
  description?: string;
  name: string;
}> {
  const name = getCommandNameFromPath(params.rootPath, params.filePath);
// name 先固定，后续解析即使失败也仍能返回一个可用于展示与命名的候选。
  try {
// 命令文件通常很小，整文件读取即可；读取失败由外层 catch 兜底为「只有 name」。
    const content = await readFile(params.filePath, "utf-8");
// 复用命令模块的解析器，保证设置页展示的描述与实际执行时的解析一致。
    const parsed = CommandFileParser.parseCommandFile(content, params.filePath);
    return {
      name,
      ...(parsed?.description ? { description: parsed.description } : {}),
      ...(parsed?.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
    };
  } catch {
    return { name };
  }
}

// 读取插件 manifest：
// - 无 manifest 返回 null（该目录不算插件）；
// - name 必须是非空字符串，否则返回 null；
// - id 固定拼成 name@inline，内置市场名不参与去重，避免外部路径差异；
// - version 只在非空时出现，保持可选字段语义。
async function readPluginMetadata(pluginPath: string): Promise<{
  id: string;
  name: string;
  version?: string;
} | null> {
// [失败路径] manifest 缺失或 JSON 损坏都返回 null，不抛错：
// 用户目录里存在半成品插件目录是常态，不应打断整次扫描。
  const manifestPath = await findPluginManifestPath(pluginPath);
  if (!manifestPath) {
    return null;
  }
  try {
// 先解析成 unknown 再用 isRecord 收窄；manifest 是外部文件，不能假设结构。
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
// name 是插件的展示名与去重键来源，非字符串或空白一律视为无效 manifest。
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
// 空名 manifest 不算插件：没有 name 就无法生成 id，也无法在 UI 里区分。
    if (name.length === 0) {
      return null;
    }
// 只接受字符串版本的 manifest；数字版本在 JSON 里合法，但插件规范要求字符串，
// 这里直接忽略比隐式转换更安全。
    const version = typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : undefined;
    return {
      id: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      name,
      ...(version ? { version } : {}),
    };
  } catch {
    return null;
  }
}

// 收集目标命令根下已有命令名键；根不存在返回空集。
// 注意比较的是推导出的命令名（/a/b），而不是文件路径。
async function collectExistingCommandNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
// 命令根可能因首次导入而不存在，此时没有已占用名，返回空集即可。
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
// 已占用命令名由相对路径推导，与候选的 nameKey 使用同一函数。
  for (const commandPath of await collectCommandMarkdownPaths(rootPath)) {
    nameKeys.add(normalizeCommandNameKey(getCommandNameFromPath(rootPath, commandPath)));
  }
  return nameKeys;
}

// 读 JSON 并保证返回对象：文件缺失、内容损坏、顶层不是对象一律返回 {}。
// 这样「首次写入」与「追加写入」可以走同一条合并路径，不需要分支。
async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
// 只在顶层是普通对象时采用；数组、标量都按空配置处理，保持返回类型稳定。
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
// 首次写入与追加写入因此共用同一条合并路径，调用方无需区分文件是否存在。
    return isRecord(parsed) ? parsed : {};
  } catch {
// 文件缺失、权限不足、JSON 损坏都回落空对象，不让单个坏文件中断整批。
    return {};
  }
}

// MCP server 去重键：trim + 小写，与另外三类资源的键风格保持一致。
function normalizeMcpServerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// 把任意 mcpServers 形状收敛成 name → config：
// 跳过空名与非对象配置，避免把注释字段或字符串当成 server 写进 ZCode 配置。
// 这里只做结构过滤，不做字段改名，字段兼容由各来源的 reader 负责。
function normalizeMcpServerMap(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    return {};
  }
// 用普通对象而不是 Map：结果要直接参与 JSON 序列化与展开运算。
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(value)) {
// 空名无法定位，非对象配置无法序列化，两者都丢弃；
// 这比把脏值写进 ZCode 配置后再由运行时崩溃更安全。
    if (!name.trim() || !isRecord(config)) {
      continue;
    }
// 只做类型断言，不改字段；来源差异由上方各 reader 处理。
    servers[name] = config as McpServerConfig;
  }
  return servers;
}

// 移除外部 Agent 特有的超时字段（timeout / startup_timeout_sec）：
// 它们的单位与语义都和 ZCode 不同，直接带入会让 MCP 启动行为不可预期。
// 只删这两个已知字段，其余字段（command/env/args）原样透传。
function stripExternalMcpTimeoutFields(config: McpServerConfig): McpServerConfig {
  const {
    timeout: _timeout,
    startup_timeout_sec: _startupTimeoutSec,
    ...rest
  } = config as Record<string, unknown>;
// 两个解构变量只用于把字段从 rest 中排除，函数体不再引用它们。
// 除两个超时字段外全部保留；类型断言只用于擦除解构产生的宽类型。
  return rest as McpServerConfig;
}

// ZCode 自身结构：config.json 的 mcp.servers。
function readZcodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
// mcp 字段缺失或类型不对时返回空表：ZCode 配置里可能还没写过 mcp 段。
  if (!isRecord(parsed.mcp)) {
    return {};
  }
// servers 是 ZCode 的实际存储位置；mcp 下的其它键与 server 无关。
  return normalizeMcpServerMap(parsed.mcp.servers);
}

// Claude / Qwen / Trae / Kiro / Roo / CodeBuddy 等结构：顶层 mcpServers。
function readWrappedMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
// Claude 系配置把 server 直接放在顶层 mcpServers。
  return normalizeMcpServerMap(parsed.mcpServers);
}

// OpenCode 结构：顶层 mcp，command 可能是数组、type 用 local/remote。
// 先统一成 map 再逐条做字段映射，避免在 normalizeMcpServerMap 里混入来源差异。
function readOpenCodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
// OpenCode 的 mcp 本身就是 name → config 映射，先归一化再逐条转换字段。
  const servers = normalizeMcpServerMap(parsed.mcp);
// 逐条转换字段后重建对象；Object.fromEntries 不改变键的顺序（插入序）。
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, normalizeOpenCodeMcpConfig(config)]),
  );
}

// OpenCode → ZCode 的字段映射：
// - command 为数组时取首项为 command、其余为 args；
// - type local→stdio、remote→http；未知 type 不写，保留原值；
// - command 为字符串且 type=local 时也归一到 stdio。
// 其余字段（env 等）原样透传，不做白名单过滤。
function normalizeOpenCodeMcpConfig(config: McpServerConfig): McpServerConfig {
// command 在 OpenCode 里可能是字符串或数组，先取出原始值再分支处理。
  const rawCommand = (config as Record<string, unknown>).command;
// [权衡] 数组形式的 command 只提取字符串项，数字/对象项直接丢弃：
// 宁可少传参数，也不要把无法解释的值拼进 args 导致启动失败。
  if (Array.isArray(rawCommand)) {
// 首项是命令，其余是参数；filter 已剔除非字符串项，解构后类型可收窄。
    const [firstCommand, ...args] = rawCommand.filter(
      (item): item is string => typeof item === "string",
    );
// 空数组或首项为空串时不改写配置，保持原样交给运行时/用户排查。
    if (firstCommand) {
// [权衡] 解构丢弃原 command 与 type，再显式写回归一后的值；
// 其余字段通过 rest 原样保留。
      const { command: _command, type, ...rest } = config;
      return {
        ...rest,
        command: firstCommand,
        args,
        ...(type === "local" ? { type: "stdio" } : type === "remote" ? { type: "http" } : {}),
      };
    }
  }
// 字符串 command + local 视为 stdio；trim 后为空则不改写，保持原样交由用户排查。
  if (config.type === "local" && typeof rawCommand === "string" && rawCommand.trim()) {
    return {
      ...config,
      type: "stdio",
      command: rawCommand.trim(),
    };
  }
// 无法识别的结构原样返回，交给 normalizeMcpServerMap 的结构过滤兜底。
  return config;
}

// Codex 的 TOML 结构：mcp_servers（同时兼容驼峰写法，避免版本差异）。
function readTomlMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
// Codex 新版用 mcp_servers，旧版可能写 mcpServers；优先下划线写法。
  return normalizeMcpServerMap(parsed.mcp_servers ?? parsed.mcpServers);
}

// 按 format 选择解析器：codexToml 走 TOML，其它走 JSON 再按 mcpJson / 包裹结构分流。
// 任何读取或解析失败都返回空表：单个损坏的外部配置不应影响其它 Agent 的扫描。
async function readMcpServersFromSourceFile(
  filePath: string,
  format: McpConfigFormat,
): Promise<Record<string, McpServerConfig>> {
  try {
// 一次读入后再按格式解析，避免 TOML/JSON 各读一遍文件。
    const raw = await readFile(filePath, "utf-8");
// TOML 与 JSON 的解析异常都在同一个 try 里捕获，返回空表。
    if (format === "codexToml") {
// smol-toml 返回 unknown 结构，这里先断言成对象再交给 reader 做字段收窄；
// 这里的 as Record 断言只影响类型，不做运行时校验。
      return readTomlMcpServers(parseToml(raw) as Record<string, unknown>);
    }
// JSON 解析结果可能是数组或标量，交给 isRecord 收窄后再按 format 分流。
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
// 只有 OpenCode 用顶层 mcp 结构，其余外部 Agent 都是 mcpServers 包裹。
    return format === "mcpJson"
      ? readOpenCodeMcpServers(parsed)
      : readWrappedMcpServers(parsed);
  } catch {
    return {};
  }
}

// 收集目标 config.json 里已有的 server 名键；按 scope 取不同配置路径。
// 配置不存在时 ReadJsonFileOrEmpty 返回 {}，因此这里无需额外的存在性判断。
async function collectExistingMcpServerNameKeys(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): Promise<Set<string>> {
  const nameKeys = new Set<string>();
// 目标路径可能为 null（project scope 但工作区未打开），此时没有已存在的 server。
  const targetConfigPath = resolveMcpConfigPathForScope(targetScope, workspacePath);
// 只有能解析出配置路径时才需要读文件；null 场景没有可比较的历史 server。
  if (targetConfigPath) {
    for (const name of Object.keys(readZcodeMcpServers(await readJsonFileOrEmpty(targetConfigPath)))) {
      nameKeys.add(normalizeMcpServerNameKey(name));
    }
  }
  return nameKeys;
}

// 向 config.json 追加一个 MCP server：
// - 保留文件里的其它顶层字段（...parsed）；
// - 保留 mcp 下的其它键（...currentMcp）；
// - 同名 server 直接覆盖：上游已做 sameNameExists 过滤，
//   这里的覆盖只可能来自并发写入，覆盖比写坏结构更安全。
async function addMcpServerToZcodeConfig(
  filePath: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  const parsed = await readJsonFileOrEmpty(filePath);
// [事务] 整文件重写：先把非 mcp 字段与 mcp 的其它键都展开，再覆盖 servers，
// 保证写回后除目标 server 外的内容逐字不变（除 JSON 缩进）。
  const currentMcp = isRecord(parsed.mcp) ? parsed.mcp : {};
  const servers = readZcodeMcpServers(parsed);
  await writeJsonFile(filePath, {
    ...parsed,
    mcp: {
// 保留 mcp 下的其它键（例如版本号或用户自定义字段），只覆盖 servers。
      ...currentMcp,
      servers: {
        ...servers,
// 同名覆盖是刻意设计：上游 sameNameExists 已拦住正常路径，这里只兜并发。
        [name]: config,
      },
    },
  });
}

// 只取字符串元素，过滤配置文件里的脏值（数字、对象、null）。
function readStringArray(value: unknown): string[] {
// 非数组直接当空表；数组内只保留字符串，数字与对象都是脏值。
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// 统一写盘格式：2 空格缩进 + 末尾换行，mkdir 递归保证父目录存在。
// 不写临时文件再 rename：导入在单进程内串行执行，且目标文件是用户可见配置，
// 原子替换会让外部编辑器丢失 file watch，收益不足以抵消复杂度。
async function writeJsonFile(filePath: string, value: Record<string, unknown>): Promise<void> {
// 递归建父目录：~/.zcode 可能尚未创建（全新安装）。
  await mkdir(dirname(filePath), { recursive: true });
// 末尾补换行符合 POSIX 文本文件约定，也能避免部分编辑器提示「文件末尾无换行」。
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// 把插件目录登记进 config.json 的 plugins.dirs。
// 先 resolve 成绝对路径再比较，避免相对路径与绝对路径写法不同导致重复登记；
// 已登记则直接返回，不重写文件（减少无意义的文件变更事件）。
async function addPluginDirToConfig(filePath: string, pluginPath: string): Promise<void> {
  const parsed = await readJsonFileOrEmpty(filePath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
// plugins 必须是对象才展开；如果是脏值，按空对象处理并整体重建。
  const dirs = readStringArray(plugins.dirs);
// 登记进配置的必须是绝对路径：运行时按该路径直接加载插件。
  const resolvedPluginPath = resolve(pluginPath);
// 去重比较前统一 resolve：用户手工写过的相对路径也能被识别为已登记。
  if (dirs.map((item) => resolve(item)).includes(resolvedPluginPath)) {
    return;
  }
  await writeJsonFile(filePath, {
    ...parsed,
    plugins: {
      ...plugins,
// 追加而不是替换：plugins.dirs 可能包含用户手工登记或其它模块写入的插件。
      dirs: [...dirs, resolvedPluginPath],
    },
  });
}

// 从 plugins.dirs 反查已登记插件的 id，用于 sameNameExists。
// 读不到 manifest 的目录直接忽略（可能已被用户删除）；
// id 统一小写，避免大小写差异绕过去重。
async function collectConfiguredPluginIds(configPath: string): Promise<Set<string>> {
// 读不到（首次导入）按空对象处理，后续遍历 plugins.dirs 得到空集合。
  const parsed = await readJsonFileOrEmpty(configPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
// 用 Set 存小写 id，去重判断 O(1)；顺序无意义。
  const ids = new Set<string>();
  for (const pluginPath of readStringArray(plugins.dirs)) {
// 已登记目录的 manifest 可能已删除；读不到就跳过，不把 null 当插件。
    const metadata = await readPluginMetadata(resolve(pluginPath));
// 只有拿到合法 metadata 才计入已登记 id 集合。
    if (metadata) {
// 统一小写后再存，与候选 id.toLowerCase() 的比较口径保持一致。
      ids.add(metadata.id.toLowerCase());
    }
  }
  return ids;
}

// discover 用的布尔包装：与 import 阶段共用 skipReason 判定，
// 保证设置页显示的「可导入」与真正导入时的结果一致；
// 若要新增跳过原因，只改 getSkillImportCandidateSkipReason 即可。
// 这里没有缓存，缓存由调用方按 targetRoot 传入的 Map 持有。
async function isSkillImportCandidateImportable(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
// 可导入等价于「没有 skipReason」，不另写一套判定，避免发现与导入结论漂移。
  return (await getSkillImportCandidateSkipReason(
    candidate,
    existingNameKeysByTargetRoot,
  )) === undefined;
}

// 技能跳过的两种原因：
// - targetExists：目标目录已存在（可能是同名目录，也可能是手工放的文件）；
// - sameNameExists：目标根下已有同名技能（frontmatter 里的 name 相同）。
// 先判精确目标路径再看名字集合，前者更便宜，也覆盖了目录已存在的绝大多数情况。
// 已存在名键按 targetRoot 缓存：同一目标根下的多个候选只遍历一次目录。
async function getSkillImportCandidateSkipReason(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<SettingsSyncSkillSkipReason | undefined> {
// [失败路径] 目标目录存在即跳过，不做内容比较：
// 即使内容完全相同也不覆盖，避免用户改过的文件被源目录「回滚」。
  if (await exists(candidate.targetPath)) {
    return "targetExists";
  }
  let existingNameKeys = existingNameKeysByTargetRoot.get(candidate.targetRoot);
  if (!existingNameKeys) {
// 首次遇到该目标根时扫描一次，之后复用 Set；同一批次内目标根内容只增不减。
    existingNameKeys = await collectExistingSkillNameKeys(candidate.targetRoot);
    existingNameKeysByTargetRoot.set(candidate.targetRoot, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

// 命令跳过判定：先看精确目标文件（pathExists，含断链软链），
// 再看目标根下是否已有同名命令。两步顺序不能颠倒：
// 目标文件存在时无需遍历整个命令根，设置页打开会快很多。
async function getCommandImportCandidateSkipReason(
  candidate: CommandImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<SettingsSyncCommandSkipReason | undefined> {
// 精确目标文件优先判定：断链软链也算占用，不能把它当成可写入的空位。
  if (await pathExists(candidate.targetPath)) {
    return "targetExists";
  }
  let existingNameKeys = existingNameKeysByTargetRoot.get(candidate.targetRoot);
  if (!existingNameKeys) {
// 命令根同理：按目标根缓存已占用命令名。
    existingNameKeys = await collectExistingCommandNameKeys(candidate.targetRoot);
    existingNameKeysByTargetRoot.set(candidate.targetRoot, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

// 布尔包装，语义同技能；命令的 nameKey 是带前导 / 的相对路径名。
async function isCommandImportCandidateImportable(
  candidate: CommandImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
// 与技能同构：跳过原因存在即不可导入，保证列表标记与批量导入结果一致。
  return (await getCommandImportCandidateSkipReason(
    candidate,
    existingNameKeysByTargetRoot,
  )) === undefined;
}

// 插件跳过判定：
// - 目标目录已存在 → targetExists；
// - 解析不到 config 路径（工作区未打开且非 global）→ targetExists，
//   与 import 阶段保持同一结论，避免发现时显示可导入、导入时却跳过；
// - config.json 里已登记同 id 插件 → sameNameExists。
// 已登记 id 按 configPath 缓存，因为同一 scope 的候选共享一份配置。
async function getPluginImportCandidateSkipReason(
  candidate: PluginImportCandidate,
  existingPluginIdsByConfigPath: Map<string, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<SettingsSyncPluginSkipReason | undefined> {
  if (await pathExists(candidate.targetPath)) {
    return "targetExists";
  }
// 目标作用域可能来自 selection，而不是候选来源：
// 用户可以把工作区插件导入到用户目录，因此这里按 targetScope 重新解析配置。
  const configPath = resolvePluginConfigPathForScope(targetScope, workspacePath);
  if (!configPath) {
    return "targetExists";
  }
// 首次访问某个 config 时读取全部已登记插件的 manifest；
// 后续同 config 的候选直接复用这份 id 集合。
  let existingPluginIds = existingPluginIdsByConfigPath.get(configPath);
  if (!existingPluginIds) {
// 配置里登记的插件 id 需要读每个目录的 manifest，因此按 config 缓存避免重复 IO。
    existingPluginIds = await collectConfiguredPluginIds(configPath);
    existingPluginIdsByConfigPath.set(configPath, existingPluginIds);
  }
  return existingPluginIds.has(candidate.id.toLowerCase()) ? "sameNameExists" : undefined;
}

// 布尔包装，透传 targetScope：插件是四类资源里唯一在发现阶段
// 就可能跨 scope 判定的类别（目标目录与注册表可能不在同一作用域）。
async function isPluginImportCandidateImportable(
  candidate: PluginImportCandidate,
  existingPluginIdsByConfigPath: Map<string, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
// 插件把 targetScope 原样传下去：发现阶段的目标作用域可能已被用户覆盖。
// 判定仍只走 skipReason 一条路径，不在这里重复读 config 或 manifest。
  return (await getPluginImportCandidateSkipReason(
    candidate,
    existingPluginIdsByConfigPath,
    workspacePath,
    targetScope,
  )) === undefined;
}

// MCP 跳过判定只看目标 config 里是否已有同名 server，没有目录概念。
// 名键集合按 targetScope 缓存：global 与 project 是两份不同配置，不能共用缓存。
// 注意这里不检查 server 内容是否相同：同名即跳过，覆盖风险大于收益。
async function getMcpImportCandidateSkipReason(
  candidate: McpImportCandidate,
  existingNameKeysByTargetScope: Map<SettingsSyncSourceScope, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<SettingsSyncMcpServerSkipReason | undefined> {
// 缓存键是 scope 而不是路径：同一 scope 的配置路径由 workspacePath 唯一决定，
// 在一次调用内不会变化。
  let existingNameKeys = existingNameKeysByTargetScope.get(targetScope);
  if (!existingNameKeys) {
// 按 scope 读取对应 config.json；同一 scope 在一次调用内只读一次。
    existingNameKeys = await collectExistingMcpServerNameKeys(targetScope, workspacePath);
    existingNameKeysByTargetScope.set(targetScope, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

// 布尔包装，透传 targetScope，供 discover 统计可导入数量。
async function isMcpImportCandidateImportable(
  candidate: McpImportCandidate,
  existingNameKeysByTargetScope: Map<SettingsSyncSourceScope, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
// MCP 的缓存键是 scope 而非路径，这里同样透传 targetScope 保持命中口径一致。
// 没有目录概念，因此不存在 targetExists，只有同名 server 这一种跳过原因。
  return (await getMcpImportCandidateSkipReason(
    candidate,
    existingNameKeysByTargetScope,
    workspacePath,
    targetScope,
  )) === undefined;
}

// 把技能候选按「来源根」分组，生成设置页的来源摘要：
// - discoveredCount / importableCount / skippedCount 三数自洽；
// - skills 按 name 排序，来源根按 scope + path 排序，保证 UI 顺序稳定；
// - 组内复用同一个名键缓存，避免对同一目标根重复遍历；
// - 没有任何候选的组不会出现（分组来自候选本身）。
async function buildSourceRootSummaries(
  candidates: SkillImportCandidate[],
): Promise<SettingsSyncSourceRootSummary[]> {
// 一份缓存贯穿整个分组过程：同一目标根只在第一次遇到时扫描目录。
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
// 分组键用「来源 scope + 绝对路径」：同一路径在 user 与 workspace 下
// 可能是两个不同来源（例如 ~/.claude/skills 与 <ws>/.claude/skills）。
// 这里用 Map 而不是 object，避免路径里的特殊字符影响键。
  const grouped = new Map<string, SkillImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

// 逐组生成摘要；组内 discovered/importable/skipped 三个计数由同一轮遍历得出。
  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
// 摘要里的明细数组；类型由 push 的对象字面量推导。
    const skills = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getSkillImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetRoot,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      skills.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
// 摘要内按展示名排序，与服务端扫描顺序无关，保证 UI 稳定。
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

// 命令版来源摘要，结构与技能一致；
// 额外带 description / argumentHint 供设置页展示命令用途。
// 计数口径与技能完全对齐，便于前端复用同一套摘要组件。
async function buildCommandSourceRootSummaries(
  candidates: CommandImportCandidate[],
): Promise<SettingsSyncSourceRootSummary[]> {
// 命令与技能共用「目标根 → 已占用名键」的缓存策略，避免重复扫描目录。
// 缓存只在本次调用内有效：跨请求复用会读到其它窗口导入后的过期集合。
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
// 分组键与技能相同；命令的 sourceRootPath 是命令目录而不是单个文件。
  const grouped = new Map<string, CommandImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
// 命令摘要明细，额外带 description/argumentHint。
    const commands = [];
    for (const candidate of groupCandidates) {
// 复用导入阶段的跳过判定，摘要里的 importable 与真正导入时的结果同源。
      const skipReason = await getCommandImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetRoot,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
// 明细只带展示所需字段；path 用来源路径，便于用户定位到具体文件。
      commands.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.description ? { description: candidate.description } : {}),
        ...(candidate.argumentHint ? { argumentHint: candidate.argumentHint } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
// 命令按 /a/b 形式的名字排序，天然按目录分块。
      commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

// 外层再按 scope + path 排序：分组来自 Map，本身顺序不可依赖。
  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

// 插件版来源摘要；跳过判定需要 workspacePath（决定 config 路径），
// 因此这个函数比技能/命令多一个参数。
async function buildPluginSourceRootSummaries(
  candidates: PluginImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
// 插件按 config 路径缓存已登记 id：同一 config 下多个候选只读一次 manifest。
// 这份缓存不跨请求保留，避免设置页长时间打开时读到旧的插件登记表。
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
// 插件按 sourceRootPath 分组；同一根下的多个插件共享 config 缓存。
  const grouped = new Map<string, PluginImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
// 插件摘要明细，带 version（如果有）。
    const plugins = [];
    for (const candidate of groupCandidates) {
// 判定需要 workspacePath 才能解析 config，这里按候选逐个传入而不做预解析。
      const skipReason = await getPluginImportCandidateSkipReason(
        candidate,
        existingPluginIdsByConfigPath,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
// version 只在存在时出现：缺省版本不应显示成空字符串。
      plugins.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
// 插件按展示名排序；同名不同版本仍会各自出现。
      plugins: plugins.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

// 来源根按 scope + path 排序，前端折叠面板的顺序因此与扫描顺序解耦。
  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

// MCP 版来源摘要：sourceRootPath 是一个配置文件，
// 同一文件里的多个 server 归到同一组，前端可以按文件折叠展示。
async function buildMcpSourceRootSummaries(
  candidates: McpImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
// global 与 project 是两份配置，缓存必须按 scope 分开，不能按来源文件合并。
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
// 分组键是「文件 + scope」；MCP 的名键缓存按 targetScope 而不是路径，
// 因为最终写入的是 config.json 而不是来源文件。
  const grouped = new Map<string, McpImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
// MCP 摘要明细，只带 name/path/importable/skipReason。
    const mcpServers = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getMcpImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetScope,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
// MCP 没有目录与版本概念，明细只保留能直接展示的四个字段。
      mcpServers.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
// server 按名排序，便于用户在同一文件下快速定位。
      mcpServers: mcpServers.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

// 文件级来源同样按 scope + path 排序，保证多份配置文件的展示顺序稳定。
  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

// 技能候选收集：
// - 根不存在直接跳过，避免对每个 Agent 都做一次无效遍历；
// - seenSourcePaths 去重：同一物理目录可能被多个 Agent 路径命中（软链、嵌套）；
// - targetRoot 为 null（工作区未打开）时跳过该根；
// - sourcePath 存目录（技能按目录导入），targetPath 用目录名拼接。
// 结果不排序：排序由来源摘要与前端负责，这里保持扫描顺序。
async function collectSkillImportCandidates(
  workspacePath?: string,
): Promise<SkillImportCandidate[]> {
  const candidates: SkillImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalSkillRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const skillPath of await collectSkillMarkdownPaths(root.rootPath)) {
// 同一 SKILL.md 可能从多个 Agent 根被发现（嵌套目录、软链），
// 只保留第一次出现的来源，避免同一技能在列表里重复。
      if (seenSourcePaths.has(skillPath)) {
        continue;
      }
      seenSourcePaths.add(skillPath);
// 遍历产出的是 SKILL.md 路径，而导入单位是它所在的目录，
// 因此这里向上取一层；targetPath 也用目录名，保持与源同名。
      const sourceDir = dirname(skillPath);
// 默认目标根由来源 scope 决定；workspace 来源但工作区未打开时返回 null，
// 该候选直接丢弃——没有目标路径的候选无法参与导入。
      const targetRoot = resolveCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
// 元数据读取失败不会抛错（readSkillMetadata 内部兜底目录名），
// 所以这里不需要 try/catch。
      const skillMetadata = await readSkillMetadata(skillPath);
      candidates.push({
        agent: root.agent,
        name: skillMetadata.name,
// nameKey 与 collectExistingSkillNameKeys 的键算法一致，否则同名校验失效。
        nameKey: normalizeSkillNameKey(skillMetadata.name),
        ...(skillMetadata.version ? { version: skillMetadata.version } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
// 技能候选的 sourcePath 是目录而不是 SKILL.md，导入时整体复制这个目录。
        sourcePath: sourceDir,
        targetRoot,
// 目标目录名与源目录同名；不同来源的同名技能会在 skipReason 阶段被判重。
        targetPath: join(targetRoot, basename(sourceDir)),
        scope: root.scope,
      });
    }
  }
  return candidates;
}

// 命令候选收集：与技能类似，但 sourcePath 是文件而不是目录，
// targetPath 保留源根下的相对子路径，避免不同子目录的同名命令互相覆盖。
// 去重的键仍是绝对源路径，同一文件被多个 Agent 根命中时只保留先到的一份。
async function collectCommandImportCandidates(
  workspacePath?: string,
): Promise<CommandImportCandidate[]> {
  const candidates: CommandImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalCommandRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const commandPath of await collectCommandMarkdownPaths(root.rootPath)) {
// 命令按文件去重：同一 .md 被多个 Agent 根命中时只保留第一份。
      if (seenSourcePaths.has(commandPath)) {
        continue;
      }
      seenSourcePaths.add(commandPath);
// 命令的默认目标根；null 时丢弃候选，原因同技能。
      const targetRoot = resolveCommandCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
// [权衡] 为拿 description/argumentHint 需要读一次文件；
// 发现阶段就读取是为了设置页能直接展示，代价是每命令一次 IO。
      const metadata = await readCommandMetadata({
        filePath: commandPath,
        rootPath: root.rootPath,
      });
// 相对路径同时用于目标拼接与展示；不做 normalize 是为了保留源目录结构。
      const sourceRelativePath = relative(root.rootPath, commandPath);
      candidates.push({
        agent: root.agent,
        name: metadata.name,
// 命令 nameKey 同样走统一 normalize，保证大小写不敏感。
        nameKey: normalizeCommandNameKey(metadata.name),
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
// 命令候选的 sourcePath 是具体文件，便于前端展示完整路径。
        sourcePath: commandPath,
        sourceRelativePath,
        targetRoot,
// 目标保留源根下的子目录结构，这是不同子目录同名命令不互相覆盖的关键。
        targetPath: join(targetRoot, sourceRelativePath),
        scope: root.scope,
      });
    }
  }
  return candidates;
}

// 插件候选收集：无 manifest 的目录直接丢弃（不算插件）；
// targetPath 用目录名拼接，插件目录内部结构整体保留。
// 与命令不同，插件不需要额外读取内容，manifest 已在 collectPluginPaths 阶段确认。
async function collectPluginImportCandidates(
  workspacePath?: string,
): Promise<PluginImportCandidate[]> {
  const candidates: PluginImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalPluginRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const pluginPath of await collectPluginPaths(root.rootPath)) {
// 插件按目录去重；同一目录被多个 Agent 插件根命中时只保留一份。
      if (seenSourcePaths.has(pluginPath)) {
        continue;
      }
      seenSourcePaths.add(pluginPath);
// 插件默认目标根；null 时丢弃，与 import 阶段的跳过语义保持一致。
      const targetRoot = resolvePluginCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
// 这里再读一次 manifest 是为了拿到 name/version/id；
// 读失败（竞态删除或损坏）返回 null，直接跳过该目录。
      const metadata = await readPluginMetadata(pluginPath);
      if (!metadata) {
        continue;
      }
      candidates.push({
        agent: root.agent,
// id 已由 readPluginMetadata 统一成 name@inline，此处不再改写。
        id: metadata.id,
        name: metadata.name,
        ...(metadata.version ? { version: metadata.version } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
// 插件候选的 sourcePath 是插件目录，导入时整体复制/建链。
        sourcePath: pluginPath,
        targetRoot,
// 目标目录名与源目录同名；插件 id 的去重发生在 skipReason 阶段。
        targetPath: join(targetRoot, basename(pluginPath)),
      });
    }
  }
  return candidates;
}

// MCP 候选收集：
// - 一个配置文件可产出多个候选，sourcePath 用「文件#server」保证唯一；
// - seenKey 带 agent，允许不同 Agent 出现同名 server（由 sameNameExists 收敛）；
// - 导入前剥掉外部超时字段，其余配置原样透传；
// - 只判断文件存在，不判断目录：MCP 配置就是普通文件。
async function collectMcpImportCandidates(
  workspacePath?: string,
): Promise<McpImportCandidate[]> {
  const candidates: McpImportCandidate[] = [];
  const seenSourceNames = new Set<string>();
  for (const root of getExternalMcpRoots(workspacePath)) {
// MCP 根是文件，用 pathExists 而不是 exists（后者只认目录）。
// 断链的配置文件同样视为存在，交给解析阶段失败后返回空表。
    if (!(await pathExists(root.rootPath))) {
      continue;
    }
// 解析失败返回空表而不是抛错；单个损坏的配置文件只会让该根产出 0 个候选。
    const serverMap = await readMcpServersFromSourceFile(root.rootPath, root.format);
// 一个文件可能含多个 server，逐个展开成候选；
// 名称保持原样展示，nameKey 只用于去重。
    for (const [name, config] of Object.entries(serverMap)) {
// 用 # 拼接文件与 server 名：前端可直接按该字符串回传 selection.mcpServerPaths，
// 同时保证同一文件内不同 server 的 key 不冲突。
      const sourcePath = `${root.rootPath}#${name}`;
// key 带 agent：不同 Agent 可以有同名 server，由目标 config 的 sameNameExists 收敛。
      const seenKey = `${root.agent}:${sourcePath}`;
// 同一 Agent 的多个路径可能指向同一文件（如软链），这里做最后一道去重。
      if (seenSourceNames.has(seenKey)) {
        continue;
      }
      seenSourceNames.add(seenKey);
      candidates.push({
        agent: root.agent,
        name,
// MCP nameKey 只做 trim + 小写，server name 允许空格等字符。
        nameKey: normalizeMcpServerNameKey(name),
// 导入前统一剥掉外部超时字段，保证写入 ZCode 配置的内容只含通用字段。
        config: stripExternalMcpTimeoutFields(config),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath,
      });
    }
  }
  return candidates;
}

// 技能发现：按 SUPPORTED_SKILL_AGENT_SOURCES 逐 Agent 汇总，
// 只返回至少发现一个候选的 Agent（空 Agent 不进 UI）。
// 每个 Agent 单独建名键缓存：不同 Agent 的目标根可能相同，
// 但发现阶段重复遍历的代价可接受，换来的是逻辑简单、无跨 Agent 状态。
// selectedByDefault = 有可导入项，符合首启场景「有就默认勾选」的产品决策。
// 某个 Agent 的所有路径都不存在时，它不会出现在 agents 里，
// 而不是以 discovered=false 的空壳出现；前端无需过滤空项。
// 只有至少一个候选的 Agent 才需要计算可导入数，减少无谓遍历。
// sourceRoots 内部已按 scope + path 排序，Agent 级顺序由 SUPPORTED 表决定；
// 两层顺序都是稳定的，前端可以安全地做增量渲染。
// importableCount 为 0 时 selectedByDefault 为 false，避免用户勾选后全部跳过。
async function buildSkillsDiscovery(
  workspacePath?: string,
): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectSkillImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_SKILL_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath))]
      .sort((left, right) => left.localeCompare(right));
// 技能是唯一默认勾选的类别：只读资源，导入后不改变用户既有输入行为。
// 来源摘要与下面的一次计数都用同一份候选，但在实现上会各自判定一次可导入性；
// 两处必须使用相同 skipReason 逻辑，否则摘要里的 importableCount 会和
// 顶部统计对不上。
    const sourceRoots = await buildSourceRootSummaries(agentCandidates);
    let importableCount = 0;
    const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
// 逐候选复核可导入性：buildSourceRootSummaries 内部已经算过一遍，
// 这里再算一次是为了拿到 Agent 级总数；因为有了按根缓存，
// 第二次遍历只做内存判断，不会重复读盘。
      if (await isSkillImportCandidateImportable(candidate, existingNameKeysByTargetRoot)) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "skills",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
// selectedByDefault 技能默认勾选：importableCount > 0 就选。
// 命令/插件/MCP 则一律不默认勾选，原因见各自函数。
          selectedByDefault: importableCount > 0,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

// 命令发现：结构与技能一致，但 selectedByDefault 恒为 false——
// 命令会改变用户输入行为（/xxx），默认勾选容易造成意外覆盖或误导入。
// 用户必须显式选择才会导入。
async function buildCommandsDiscovery(
  workspacePath?: string,
): Promise<SettingsSyncDiscoveryResult> {
// 先一次性收集全部命令候选，再按 Agent 分组，避免每个 Agent 重复扫描同一来源根。
  const candidates = await collectCommandImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_COMMAND_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
// sourcePaths 去重后排序，供前端直接渲染来源目录清单，不需要再处理顺序。
    const sourcePaths = [...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath))]
      .sort((left, right) => left.localeCompare(right));
// 命令来源摘要；每个来源根内按命令名排序，保证设置页展开顺序稳定。
    const sourceRoots = await buildCommandSourceRootSummaries(agentCandidates);
    let importableCount = 0;
    const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
// 与技能相同的两级判定：目标文件存在优先，其次同名命令；
// 缓存键是 targetRoot，同批次内同一目标目录只扫描一次。
      if (await isCommandImportCandidateImportable(candidate, existingNameKeysByTargetRoot)) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
// Agent 级计数与来源摘要使用同一批候选，因此三个数字在 UI 上互相自洽。
          category: "commands",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

// 插件发现：selectedByDefault 恒为 false——插件会注入命令/agent 能力，
// 影响面比技能大，必须由用户显式勾选。
// 插件可导入性依赖 workspacePath（决定写哪份 config.json），
// 因此这里的缓存是「configPath → 已登记 id」。
async function buildPluginsDiscovery(
  workspacePath?: string,
): Promise<SettingsSyncDiscoveryResult> {
// 插件候选已带 manifest 元数据，发现阶段不再重复读 manifest。
  const candidates = await collectPluginImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_PLUGIN_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath))]
      .sort((left, right) => left.localeCompare(right));
// 插件摘要需要 workspacePath 才能解析目标 config；
// 工作区未打开时 project 来源的候选会被判为不可导入。
    const sourceRoots = await buildPluginSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
    const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
// 注意这里没有传 targetScope：发现阶段按候选来源 scope 判定，
// 与 import 阶段未指定 targetScope 时的默认行为一致。
      if (await isPluginImportCandidateImportable(
        candidate,
        existingPluginIdsByConfigPath,
        workspacePath,
      )) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
// 插件一律不默认勾选：注入的命令与 agent 能力影响面大于普通技能文件。
          category: "plugins",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

// MCP 发现：selectedByDefault 恒为 false——导入会写全局或工作区 config.json，
// 并且可能启动外部进程，风险高于技能/命令。
// 名键缓存按 scope 建立：global 与 project 是两份独立配置。
async function buildMcpDiscovery(
  workspacePath?: string,
): Promise<SettingsSyncDiscoveryResult> {
// 收集阶段已按文件解析并剥掉超时字段，这里只做分组与计数。
  const candidates = await collectMcpImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
// 只遍历表里登记的 Agent；表外的外部 Agent 即使有配置文件也不会被展示。
  for (const { agent } of SUPPORTED_MCP_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath))]
      .sort((left, right) => left.localeCompare(right));
// 同一配置文件里的多个 server 会归到同一来源根，前端可按文件折叠。
    const sourceRoots = await buildMcpSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
// 缓存按 scope 分开，global 与 project 各自只读一次 config。
    const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
    for (const candidate of agentCandidates) {
// 与 find 阶段一致的判定：只看目标 config 是否已有同名 server。
      if (await isMcpImportCandidateImportable(
        candidate,
        existingNameKeysByTargetScope,
        workspacePath,
      )) {
        importableCount += 1;
      }
    }
// 只有确实发现候选的 Agent 才进入结果，空 Agent 由末尾的 filter 兜底剔除。
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
// MCP 导入会写配置并可能拉起外部进程，因此同样不默认勾选。
          category: "mcpServers",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

// 技能导入主流程：
// - 候选过滤：agent + sourceScope + 显式 skillPaths（三者都可缺省）；
// - targetScope 指定时覆盖候选默认目标根，工作区缺失则跳过；
// - 逐个导入，跳过/失败都写入 skillResults，不中断批次；
// - 导入成功后把 nameKey 加进缓存，保证同批次内后续同名候选被判 sameNameExists；
// - 顶层 status：有失败即 failed，否则有导入即 success，全跳过则 skipped。
// 这里串行执行，是为了让同批次内先导入的 nameKey 对后面的候选立即可见。
// importMode 缺省为 symlink；选择复制通常意味着用户希望脱离源目录独立维护。
// 失败结果里的 error 字段直接来自异常 message，便于前端原样展示。
// 本函数不抛错：除非 collect 阶段本身失败，否则总会返回结果对象。
// skillResults 与过滤后的 candidates 数量严格一致（每个候选一条），
// 前端可以按下标与候选列表对齐展示。
async function importSkillsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  skillPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
// null 表示「不按路径过滤」，空数组表示「什么都不导入」；
// 用 Set 是为了让前端回传的路径列表匹配变成 O(1)。
  const selectedSkillPaths = skillPaths ? new Set(skillPaths) : null;
// 每次都重新收集：不信任前一次 detect 的结果，避免用户在两次调用之间
// 安装/删除资源导致导入列表与实际不一致。
  const candidates = (await collectSkillImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedSkillPaths || selectedSkillPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
// 三个计数只增不减，最终由 status 汇总：任一失败优先于「有成功」，全跳过才是 skipped。
// 结果与候选一一对应（含 skipped/failed），前端据此展示每个技能的最终状态。
  const skillResults: SettingsSyncSkillImportResult[] = [];
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();

// 串行执行而非并发：先导入的技能会立刻加入名键缓存，后续同名候选据此跳过。
  for (const candidate of candidates) {
    const selectedTargetRoot = targetScope
      ? resolveTargetRootForScope(targetScope, workspacePath)
      : candidate.targetRoot;
// targetScope 覆盖后目标根可能为 null（project 但工作区未打开），此时无法落盘。
    if (!selectedTargetRoot) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
// 复制一份候选而不是原地改：原候选保留来源 targetRoot，结果里仍能追溯来源。
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getSkillImportCandidateSkipReason(
      targetCandidate,
      existingNameKeysByTargetRoot,
    );
    if (skipReason) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
// 父目录必须先存在：junction/复制都不会替调用方创建上级目录。
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
// [资源] mkdir 先建父目录，再建链/复制；importSkillDirectory 内部
// 对「目标已存在」用 errorOnExist 抛错，因此这里到达时目标必然不存在。
// 任一步失败都会进入下面的 catch，只影响当前候选。
      await importSkillDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetRoot.get(targetCandidate.targetRoot);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
// 单个技能失败只记 failed 并继续下一个，整批导入不会因此中断。
      failedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "skills",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    skillResults,
  };
}

// 命令导入主流程，结构与技能一致；差异：
// - 导入单位是单个 .md 文件（复制/硬链接/软链）；
// - 目标路径保留源根下的相对子路径，避免不同子目录同名命令互相覆盖。
// 失败/跳过同样只记录不抛出。
async function importCommandsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  commandPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
// 与技能相同的三态语义：undefined/null 不过滤，空集全跳过。
  const selectedCommandPaths = commandPaths ? new Set(commandPaths) : null;
// 重新扫描而不是复用 detect 结果，保证导入列表反映当前磁盘状态。
  const candidates = (await collectCommandImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedCommandPaths || selectedCommandPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
// 计数与技能同口径：failed 优先，其次 success，全部跳过才落到 skipped。
// 每个候选一条结果；skipped 的 skipReason 直接来自共用判定函数。
  const commandResults: SettingsSyncCommandImportResult[] = [];
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();

// 与技能一样串行：先导入的命令进入名键缓存，后续同名候选直接跳过。
  for (const candidate of candidates) {
    const selectedTargetRoot = targetScope
      ? resolveCommandTargetRootForScope(targetScope, workspacePath)
      : candidate.targetRoot;
// 目标根解析失败说明该作用域没有可写目录，记 skipped 而不是抛错。
    if (!selectedTargetRoot) {
      skippedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
      });
      continue;
    }
// 命令保留相对子路径：不同子目录的同名文件落到不同目标，不会互相覆盖。
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, candidate.sourceRelativePath),
    };
// 跳过判定放在写入前，命中即整条影子文件不落地，减少无谓 IO。
    const skipReason = await getCommandImportCandidateSkipReason(
      targetCandidate,
      existingNameKeysByTargetRoot,
    );
// skipReason 非空时结果里带上原因，前端可区分「已占用」与「同名」。
    if (skipReason) {
      skippedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
      });
      continue;
    }
    try {
// 子目录结构可能不存在，先递归补齐父目录再写入命令文件。
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
// [资源] Windows 硬链接失败会内部回退复制，因此这里不会因为跨分区而失败；
// 只有目标父目录不可写等硬错误才会抛到 catch。
// 平台分支由 importCommandFile 内部处理（软链/硬链接/复制），这里不感知平台。
      await importCommandFile(candidate.sourcePath, targetCandidate.targetPath, importMode);
      importedCount += 1;
// 成功后才更新缓存：失败项不应占用名字，允许用户修复源文件后重试。
      const existingNameKeys = existingNameKeysByTargetRoot.get(targetCandidate.targetRoot);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
      });
    } catch {
// 拷贝/链接失败只影响当前命令，批次继续；错误细节不写进结果以免泄露路径。
      failedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
      });
    }
  }

  return {
    agent,
    category: "commands",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    commandResults,
  };
}

// 插件导入主流程：
// - 目标根与 config 路径都必须可解析，否则跳过；
// - 复制/软链插件目录后，必须把目标目录写进 config.json，否则运行时不会加载；
// - config 写入成功后才计入 imported，任何一步失败统一进 failed；
// - 目标 scope 缺省为候选来源 scope，可被 selection.targetScope 覆盖。
async function importPluginsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  pluginPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
// 路径过滤语义同技能/命令；插件路径是目录。
  const selectedPluginPaths = pluginPaths ? new Set(pluginPaths) : null;
// 重新扫描，保证 plugin 目录/manifest 的当前状态被采纳。
  const candidates = (await collectPluginImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedPluginPaths || selectedPluginPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
// 每个插件一条结果；id 用于前端与 config 里的登记项对应。
  const pluginResults: SettingsSyncPluginImportResult[] = [];
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
// 目标作用域可能被 selection 覆盖，因此不能复用候选里的 targetRoot。
    const selectedTargetRoot = resolvePluginTargetRootForScope(selectedTargetScope, workspacePath);
// [事务] 目录导入与 config 登记是两步写操作：
// 若目录成功但登记失败，会留下一个「存在但未登记」的插件目录；
// 下次导入会因 targetExists 跳过，需要用户手动处理。
// 这是有意接受的代价——两阶段提交需要事务日志，收益不足。
    const selectedConfigPath = resolvePluginConfigPathForScope(selectedTargetScope, workspacePath);
// 目录与注册表缺一不可：只复制目录不登记等于没导入，只登记不复制会指向空目录。
    if (!selectedTargetRoot || !selectedConfigPath) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getPluginImportCandidateSkipReason(
      targetCandidate,
      existingPluginIdsByConfigPath,
      workspacePath,
      selectedTargetScope,
    );
    if (skipReason) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
// [资源] 插件目录整体导入；symlink 模式下建 junction/dir 链接，
// 源目录后续更新会直接反映到目标。
      await importPluginDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
// [事务] 登记到 plugins.dirs：读全量 → 去重 → 整文件重写。
// 只有这一步成功，插件才算 imported；否则进入 catch 记 failed。
      await addPluginDirToConfig(selectedConfigPath, targetCandidate.targetPath);
      importedCount += 1;
// 导入成功后把 id 加进缓存，保证同批次内同名插件立即被视为已存在。
// 缓存可能为空（该 config 尚未读取过），此时不补建——下一次候选会走读取路径。
      const existingPluginIds = existingPluginIdsByConfigPath.get(selectedConfigPath);
      if (existingPluginIds) {
        existingPluginIds.add(candidate.id.toLowerCase());
      }
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
      failedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "plugins",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    pluginResults,
  };
}

// MCP 导入主流程：
// - 目标是 config.json 的 mcp.servers，逐个 server 合并写入；
// - 没有目标配置路径（工作区未打开且未指定 global）时按 sameNameExists 跳过；
// - 写入成功后更新名键缓存，使同批次后续同名 server 被跳过；
// - MCP 没有 importMode：只写配置，不复制文件。
// 同名 server 已存在时直接跳过，不比较配置差异：
// 用户可能在 ZCode 里改过 env 或命令，覆盖会丢失这些修改。
// 结果里记录 name 而不是完整 config，避免把 token 写进日志或前端状态。
async function importMcpServersForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  mcpServerPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
// 匹配键是「文件#server」；为空集时不会导入任何 server。
  const selectedMcpServerPaths = mcpServerPaths ? new Set(mcpServerPaths) : null;
// 重新解析所有外部配置文件，保证用户刚改的 server 列表生效。
  const candidates = (await collectMcpImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedMcpServerPaths || selectedMcpServerPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
// 每个 server 一条结果，便于前端逐条展示成功/失败。
  const mcpServerResults: SettingsSyncMcpServerImportResult[] = [];
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
// 目标配置路径必须可解析；null 表示该 scope 没有可写位置（工作区未打开）。
    const selectedConfigPath = resolveMcpConfigPathForScope(selectedTargetScope, workspacePath);
// 没有可写配置路径（工作区未打开）时跳过，skipReason 记 sameNameExists，
// 与 discover 阶段的不可导入结论保持一致。
    if (!selectedConfigPath) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "sameNameExists",
      });
      continue;
    }
    const skipReason = await getMcpImportCandidateSkipReason(
      candidate,
      existingNameKeysByTargetScope,
      workspacePath,
      selectedTargetScope,
    );
// 同名 server 直接跳过：不比较配置差异，避免覆盖用户在 ZCode 里改过的 env。
    if (skipReason) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
      });
      continue;
    }
    try {
// 写入单位是单个 server，但每次都会重读并重写整份 config，不依赖内存快照。
// [事务] 单个 server 一次整文件重写：多个 server 依次导入意味着多次写盘，
// 但每次重写都基于最新内容，因此不会互相覆盖。
      await addMcpServerToZcodeConfig(selectedConfigPath, candidate.name, candidate.config);
      importedCount += 1;
// 导入成功后更新缓存，避免同批次重复导入同名 server。
      const existingNameKeys = existingNameKeysByTargetScope.get(selectedTargetScope);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
      });
    } catch {
// 该 server 的写盘失败不阻断后续 server；MCP 结果只回 name，不回配置内容。
      failedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
      });
    }
  }

  return {
    agent,
    category: "mcpServers",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    mcpServerResults,
  };
}

// 扫描意图判定：只有 manualImport 且显式包含该类别才扫描；
// 首启（firstRun）不自动扫描，避免启动时遍历用户主目录造成卡顿。
// 四个 shouldScan* 与 SettingsSyncCategory 的四个取值一一对应，不能漏。
function shouldScanSkills(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("skills") === true;
}

// shouldScanCommands 的命令类别判定，条件与 shouldScanSkills 完全一致。
function shouldScanCommands(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("commands") === true;
}

// shouldScanPlugins 的插件类别判定，条件与 shouldScanSkills 完全一致。
function shouldScanPlugins(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("plugins") === true;
}

// MCP 类别判定；条件与技能完全一致。
function shouldScanMcpServers(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("mcpServers") === true;
}

// Claude 的 ~/.claude/CLAUDE.md → ~/.zcode/AGENTS.md 迁移状态：
// 只报告两侧是否存在，不做内容比较；supported 取决于源文件是否存在。
// 源缺失时给出 missingSource，前端据此禁用入口而不是报错。
// 状态查询是纯读操作：不创建目录、不写文件，
// 因此可以在设置页每次打开时安全调用。
async function getClaudeAgentsFileMigrationStatus(): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
// 两侧都用 pathExists（不跟随软链）：断链的 AGENTS.md 不应被当成「不存在」。
  const sourcePath = getClaudeUserAgentsFileSourcePath();
  const sourceExists = await pathExists(sourcePath);
  const targetPath = getUserZcodeAgentsFilePath();
  const targetExists = await pathExists(targetPath);

  return {
    sourcePath,
    targetPath,
    sourceExists,
    targetExists,
// supported 只取决于源文件是否存在；目标是否存在不影响「可执行迁移」这一判断。
    supported: sourceExists,
// 源缺失时才带原因字段；存在时保持对象干净，前端无需处理 undefined 分支。
    ...(sourceExists ? {} : { unavailableReason: "missingSource" as const }),
  };
}

// 执行迁移复制：
// - 源不存在 → skipped(missingSource)；
// - 目标存在且未显式 overwrite → skipped(targetExists)，保护用户已有 AGENTS.md；
// - 成功时 overwritten 表示本次是否覆盖了旧文件。
// 这里用复制而不是软链：AGENTS.md 之后会被 ZCode 与用户各自修改，
// 软链会让 Claude 侧的改动意外影响 ZCode 行为。
async function copyClaudeAgentsFileToZcodeAgentsFile(params: {
  overwrite?: boolean;
}): Promise<SettingsSyncClaudeAgentsFileCopyResult> {
  const sourcePath = getClaudeUserAgentsFileSourcePath();
  const targetPath = getUserZcodeAgentsFilePath();
  const sourceExists = await pathExists(sourcePath);
  const targetExists = await pathExists(targetPath);

// 源缺失是正常情况（用户没用过 Claude），返回 skipped 而不是 failed。
  if (!sourceExists) {
    return {
      sourcePath,
      targetPath,
      status: "skipped",
      overwritten: false,
      skippedReason: "missingSource",
    };
  }

// [失败路径] 必须显式 overwrite=true 才覆盖：默认保护用户已写的 AGENTS.md，
// 且 overwrite 只接受布尔 true，'true' 字符串不生效。
  if (targetExists && params.overwrite !== true) {
    return {
      sourcePath,
      targetPath,
      status: "skipped",
      overwritten: false,
      skippedReason: "targetExists",
    };
  }

  await mkdir(dirname(targetPath), { recursive: true });
// 父目录已在上一步 mkdir；复制失败会抛给 IPC 层，由前端展示错误。
  await copyFile(sourcePath, targetPath);

  return {
    sourcePath,
    targetPath,
    status: "copied",
// overwritten 反映「本次是否覆盖了旧文件」，而不是请求里是否传了 overwrite。
    overwritten: targetExists,
  };
}

// 服务工厂：把内部自由函数包装成 ISettingsSyncService。
// 工厂内不持有可变状态，所有缓存都限制在单次调用内，
// 因此多窗口并发调用不会互相污染；代价是每次调用都会重新扫描/读取。
// 依赖只取 settingService，其余能力（文件系统、解析）都是模块内纯函数。
// 返回对象的方法通过闭包访问 dependencies，工厂本身不额外持有引用；
// 调用方销毁服务时无需清理资源（没有定时器、没有长连接）。
export function createSettingsSyncService(
  dependencies: SettingsSyncServiceDependencies,
): ISettingsSyncService {
// 未命中任何类别时返回空 agents，而不是抛错：
// 设置页据此展示「没有可导入资源」，属于正常状态。
  function buildEmptyDiscoveryResult(): SettingsSyncDiscoveryResult {
// 空 agents 是合法结果：调用方据此渲染「暂无可导入资源」，不区分未扫描与扫描为空。
    return {
      agents: [],
    };
  }

// 所有方法都是薄包装：真正的扫描/写入在模块级函数里完成，这里负责编排与日志。
  return {
// 接口层忽略 workspace 信息：迁移只针对用户级文件，与具体工作区无关。
    async getClaudeAgentsFileMigrationStatus(request): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
// 显式 void 掉未使用字段，既满足 lint 的 no-unused 规则，
// 也向读者说明「这里确实不需要工作区上下文」。
      void request.workspaceIdentity;
// 迁移接口不依赖工作区，显式忽略字段以保持接口签名统一。
      void request.workspacePath;
      return getClaudeAgentsFileMigrationStatus();
    },

// 默认参数 {} 让调用方可以不带 request；overwrite 缺省即 false。
// 完成后记录一次 info 日志，包含两侧路径与最终状态，便于用户排查迁移结果。
    async copyClaudeAgentsFileToZcodeAgentsFile(request = {}): Promise<SettingsSyncClaudeAgentsFileCopyResult> {
// 只透传 overwrite，其余参数（workspace）与迁移无关。
      const result = await copyClaudeAgentsFileToZcodeAgentsFile({
        overwrite: request.overwrite,
      });
// copied 与 skipped 都走同一条日志：迁移是低频操作，完整上下文比日志量更重要。
// 无论 copied/skipped 都记一条 info：迁移是低频操作，
// 留下完整上下文（源/目标/状态/原因）便于用户事后排查。
      log.info("[settings-sync] Claude AGENTS.md migration completed", {
// 日志里记录工作区仅用于定位调用来源，不参与迁移决策。
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: result.status,
        overwritten: result.overwritten,
        skippedReason: result.skippedReason,
      });
// 原样返回底层结果，不在这里追加或改写字段，保证 IPC 层拿到的形状单一。
      return result;
    },

// 发现入口：一次请求只扫描一个类别（由 categories + intent 决定），
// 避免设置页打开时同时遍历四类资源；多个类别由前端分多次请求。
    async detect(request): Promise<SettingsSyncDiscoveryResult> {
// 顺序即优先级；四个分支互斥（前端一次只传一个类别），
// 同时传多个时只会命中第一个。
      if (shouldScanSkills(request)) {
// 技能扫描不依赖 config，只有来源根不存在时才会返回空 agents。
        return buildSkillsDiscovery(request.workspacePath);
      }
// shouldScanCommands 分支与技能分支同构，仅 buildCommandsDiscovery 不同。
      if (shouldScanCommands(request)) {
        return buildCommandsDiscovery(request.workspacePath);
      }
// 插件分支；需要 workspacePath 解析目标 config。
      if (shouldScanPlugins(request)) {
// 插件分支需要 workspacePath 解析目标 config；缺省时 project 来源会被判不可导入。
        return buildPluginsDiscovery(request.workspacePath);
      }
// MCP 分支；解析外部配置文件而不是目录。
      if (shouldScanMcpServers(request)) {
        return buildMcpDiscovery(request.workspacePath);
      }
// 兜底：firstRun、未指定类别或类别未知时返回空结果，不隐式扫描全部。
// 刻意不「扫描全部」：首启同时遍历四类资源会显著拖慢设置页首次打开。
      return buildEmptyDiscoveryResult();
    },

// 导入入口：按 selection 逐项执行，串行而非并发——
// 多个 selection 可能写同一份 config.json，并发会互相覆盖，串行是正确性要求。
// 每个 selection 产出一个 TaskImportResult，最终聚合各计数；
// 未知类别记一条 skipped，保证结果数组与请求数量一致。
    async importSelected(request: {
      workspacePath?: string;
      workspaceIdentity?: string;
      selections: SettingsSyncSelection[];
    }): Promise<SettingsSyncImportResult> {
// 结果按请求顺序累积；聚合计数在最后统一 reduce，避免中途维护多个计数器。
      const taskResults: SettingsSyncTaskImportResult[] = [];
// 串行遍历 selection：同一份 config.json 可能被多个 selection 写入，并发会丢更新。
      for (const selection of request.selections) {
// 技能分支：透传 sourceScope / targetScope / importMode / skillPaths；
// 缺省值由 importSkillsForAgent 的默认参数决定（symlink）。
        if (selection.category === "skills") {
// 技能按目录导入，路径过滤走 skillPaths；缺省 importMode 在底层落为 symlink。
          taskResults.push(await importSkillsForAgent(
            request.workspacePath,
            selection.agent,
            selection.sourceScope,
            selection.targetScope,
            selection.importMode,
            selection.skillPaths,
          ));
          continue;
        }
// 命令分支：参数与技能同构，只是路径列表换成 commandPaths。
        if (selection.category === "commands") {
// 命令按单文件导入，额外携带 sourceRelativePath 以保留子目录层级。
          taskResults.push(await importCommandsForAgent(
            request.workspacePath,
            selection.agent,
            selection.sourceScope,
            selection.targetScope,
            selection.importMode,
            selection.commandPaths,
          ));
          continue;
        }
// 插件分支：注意没有 importMode 之外的额外开关，
// 目录导入与 config 登记在 importPluginsForAgent 内部成对完成。
        if (selection.category === "plugins") {
// 插件除复制目录外还要登记 plugins.dirs，两步都在底层同一次调用里完成。
          taskResults.push(await importPluginsForAgent(
            request.workspacePath,
            selection.agent,
            selection.sourceScope,
            selection.targetScope,
            selection.importMode,
            selection.pluginPaths,
          ));
          continue;
        }
// MCP 分支：没有 importMode（不涉及文件复制），只按 serverPaths 选择。
        if (selection.category === "mcpServers") {
// MCP 只写 config 的 mcp.servers，没有 importMode 与文件复制步骤。
          taskResults.push(await importMcpServersForAgent(
            request.workspacePath,
            selection.agent,
            selection.sourceScope,
            selection.targetScope,
            selection.mcpServerPaths,
          ));
          continue;
        }
// 未知类别不抛错：仍然产出一条 skipped，保持结果数组与请求顺序一一对应。
        taskResults.push({
          agent: selection.agent,
          category: selection.category,
          status: "skipped",
          importedCount: 0,
          skippedCount: 1,
          failedCount: 0,
        });
      }
// 聚合只做数值相加，不按 category 去重：不同 Agent 的同类资源本来就应分别计数。
      return {
// 聚合口径：successCount 累加 importedCount，skipped/failed 分别累加；
// 同一个资源不会同时计入两个计数。
        successCount: taskResults.reduce((sum, result) => sum + result.importedCount, 0),
        skippedCount: taskResults.reduce((sum, result) => sum + result.skippedCount, 0),
// 失败数同样聚合；failed 与 skipped 分开统计，前端可分别提示。
        failedCount: taskResults.reduce((sum, result) => sum + result.failedCount, 0),
// 原始任务结果一并返回，前端可展开查看每个 agent/category 的明细。
        taskResults,
      };
    },

// 首启提示状态：只有显式 true 才算已消费；undefined/false 都视为未消费，
// 这样旧版本配置文件（没有该字段）升级后仍会看到一次提示。
    async getFirstRunPromptState() {
// 读取全量设置对象再取字段，避免为单个开关引入新的读取接口。
      const settings = await dependencies.settingService.get();
// 返回形状只含 handled：调用方不需要知道底层设置的其它字段。
      return {
// 严格等于 true：旧配置里该字段可能是 undefined 或字符串，一律视为未处理。
        handled: settings.settingsSyncFirstRunPromptHandled === true,
      };
    },

// 标记首启提示已消费；写入的是提示状态而非导入结果，
// 因此「用户点击跳过」也必须调用本方法，否则下次启动会重复弹窗。
    async markFirstRunPromptHandled(): Promise<void> {
// 局部更新而不是整体 set，避免把并发修改的其它设置覆盖回旧值。
      await dependencies.settingService.update({
// markFirstRunPromptHandled 写入的键是独立开关，因此「跳过」也调用本方法。
        // 这里记录的是“首启导入提示是否已经被消费”，不是“导入是否成功”。
        // 如果把“用户点击跳过”遗漏掉，下次启动还会重复弹窗，造成首启流程打扰感。
// [事务] settingService.update 是局部更新：只写这一个字段，
// 不会覆盖用户同时修改的其它设置。
        settingsSyncFirstRunPromptHandled: true,
      });
    },
  };
}
