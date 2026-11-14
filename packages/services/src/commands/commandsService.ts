/* eslint-disable max-lines -- commandsService 需要集中处理目录来源优先级、读写和命令解析，拆分会削弱读取顺序的一致性 */
// ============================================================================
// commandsService：命令目录扫描与命令文件 CRUD
// 职责：按「来源优先级 + 作用域」枚举 .zcode/.agents 与插件目录下的命令文件，
// 解析成共享类型 ZCodeCommand，并提供创建/重命名/删除/启停能力。
// 本文件是命令读取顺序的唯一权威；UI 与 RPC 层不得自行拼路径或重排结果。
//
// INV-01：同一命令名只保留第一次出现的条目（见 dedupeCommandsByName）。
//         守住位置：list() 末尾去重、插件侧 seenFilePaths 去重。
//         破坏后果：同名命令出现两行，执行命中哪个取决于数组顺序，行为不可复现。
// INV-02：项目级 .zcode 命令必须排在 .agents 之前；同 scope 内 .zcode 读到有效
//         命令后不再读 .agents。守住位置：COMMAND_DIRECTORY_SOURCE_DESCRIPTORS
//         与 discoverCommandsFromDirectorySources 的 break。
//         破坏后果：用户在 .zcode 的定制命令被 .agents 旧副本静默覆盖。
// INV-03：启用状态按「命令文件绝对路径」持久化到 CLI config 的 command 段。
//         守住位置：readCommandEnabledOverrides/setCommandEnabledOverride。
//         破坏后果：改名后路径变化，禁用状态丢失，用户刚禁用的命令又出现。
// INV-04：插件清单里的相对路径必须经 resolveInside 校验后仍落在插件根内。
//         守住位置：resolveInside()。
//         破坏后果：../../ 形式的条目把扫描范围扩到用户主目录，泄露任意文件。
// INV-05：插件命令可见 = 插件自身启用 且 该文件未被单独禁用。
//         守住位置：discoverPluginCommandsRecursive 里 enabled 的计算。
//         破坏后果：停用插件后命令仍可执行，或文件级开关完全失效。
// INV-06：写路径要么成功要么抛出，不允许「文件写了但配置没写」的半状态；
//         删除对 ENOENT 幂等。守住位置：write/update/deleteCommandFile。
//         破坏后果：配置与磁盘不一致，下次启动命令列表与实际文件对不上。
// ============================================================================
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ZCODE_COMMAND_AGENT_SOURCE,
  ZCODE_COMMAND_AGENT_SOURCES,
  type CommandAgentSource,
  type CommandCreateParams,
  type CommandDeleteParams,
  type CommandConfig,
  type CommandSetEnabledParams,
  type CommandUpdateParams,
  type CommandsListResult,
  type PluginCommand,
  type SettingsDirectoryLocation,
  type SettingsDirectorySource,
  type UserCommand,
  type ZCodeCommand,
} from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import type { ICommandsService } from "./commands.js";
import { CommandFileParser, type CommandFileFormat } from "./commandFileParser.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";

// HOME 优先于 USERPROFILE：Windows 上两者可能同时存在且指向不同目录，
// 以 HOME 为准与 CLI 其它模块保持一致，否则同一台机器会扫到两套命令目录。
function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 一个来源描述符同时编码四项事实：目录段、扩展名、解析格式、命名空间分隔符。
// 它们必须成组变化——例如 markdown 用 "/" 分命名空间，toml 用 ":"，
// 拆开改会让 getCommandName 与 getCommandFileName 生成不一致的名字。
interface CommandAgentSourceDescriptor {
  agentSource: CommandAgentSource;
  directorySource: SettingsDirectorySource;
  userDirectorySegments: readonly string[];
  workspaceDirectorySegments: readonly string[];
  fileExtension: ".md" | ".toml";
  format: CommandFileFormat;
  namespaceSeparator: "/" | ":";
  supportsArgumentHint: boolean;
}

// 默认来源与顺序都从共享常量取，不在本文件硬编码字面量：
// 新增来源时只需改共享包，扫描顺序自动跟随，避免两处定义漂移。
const DEFAULT_COMMAND_AGENT_SOURCE: CommandAgentSource = ZCODE_COMMAND_AGENT_SOURCE;
const COMMAND_AGENT_SOURCE_ORDER: readonly CommandAgentSource[] = ZCODE_COMMAND_AGENT_SOURCES;
const ENABLE_OVERRIDE_KEY = "enable";
const HOME_PREFIX = "~/";
const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
// 三种清单路径覆盖 ZCode/Claude/Codex 插件布局，查找顺序即优先级；
// 后两者只读兼容，写操作永远落到 .zcode-plugin。
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
// ZCode 命令统一用 markdown 加 frontmatter，命名空间用 "/"（/group/name）；
// supportsArgumentHint 决定写回时是否保留该字段，不同格式能力不同不能混用。
const ZCODE_COMMAND_DESCRIPTOR: CommandAgentSourceDescriptor = {
  agentSource: "zcodeAgent",
  directorySource: "zcode",
  userDirectorySegments: [".zcode", "commands"],
  workspaceDirectorySegments: [".zcode", "commands"],
  fileExtension: ".md",
  format: "markdown",
  namespaceSeparator: "/",
  supportsArgumentHint: true,
};

const COMMAND_AGENT_SOURCE_DESCRIPTORS: Record<CommandAgentSource, CommandAgentSourceDescriptor> = {
  zcodeAgent: ZCODE_COMMAND_DESCRIPTOR,
};

// 数组顺序就是同 scope 内的优先级：.zcode 在前、.agents 在后。
// .agents 复用同一份描述符、只替换目录段，保证两种来源解析格式与命名规则一致，
// 区别仅在 location.source，UI 据此展示“来自哪个目录”。
const COMMAND_DIRECTORY_SOURCE_DESCRIPTORS: readonly CommandAgentSourceDescriptor[] = [
  ZCODE_COMMAND_DESCRIPTOR,
  {
    ...ZCODE_COMMAND_DESCRIPTOR,
    directorySource: "agents",
    userDirectorySegments: [".agents", "commands"],
    workspaceDirectorySegments: [".agents", "commands"],
  },
];

// 不做未知来源的兜底：查表得到 undefined 会在调用处立刻暴露（拼路径失败），
// 比静默回落到 zcode 更安全——后者会把别的 agent 的命令写进 zcode 目录。
function getCommandSourceDescriptor(
  agentSource: CommandAgentSource = DEFAULT_COMMAND_AGENT_SOURCE,
): CommandAgentSourceDescriptor {
  return COMMAND_AGENT_SOURCE_DESCRIPTORS[agentSource];
}

function getUserCommandsRoot(agentSource?: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

function getUserCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

// 数组也是 object，必须排除：CLI config 的 command 段若被写成数组，应按空处理。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 读配置失败（文件不存在、JSON 损坏、权限不足）一律返回空对象：
// 命令列表是只读视图，不能因为配置文件损坏就让整个列表报错；
// 写路径随后会覆盖重建，损坏内容不会扩散。
async function readUserCliConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(getUserCliConfigPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// 先 mkdir 再写：首装用户没有 ~/.zcode 目录，直接 writeFile 会 ENOENT。
// 写前不读旧文件、整份覆盖——调用方都是「读-改-写」，
// 因此同一进程内的并发写会互相覆盖，命令操作必须串行发起。
async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  const filePath = getUserCliConfigPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

// 只接受布尔值条目：历史配置里可能有对象/字符串残留，跳过而不是猜测，
// 否则一条脏数据就能把某命令永久置为禁用。键是文件绝对路径。
function readCommandEnabledOverrides(config: Record<string, unknown>): Map<string, boolean> {
  const commandConfig = config.command;
  const overrides = new Map<string, boolean>();
  if (!isRecord(commandConfig)) {
    return overrides;
  }

  for (const [filePath, entry] of Object.entries(commandConfig)) {
    if (isRecord(entry) && typeof entry[ENABLE_OVERRIDE_KEY] === "boolean") {
      overrides.set(filePath, entry[ENABLE_OVERRIDE_KEY]);
    }
  }
  return overrides;
}

async function readCommandEnabledOverridesFromUserConfig(): Promise<Map<string, boolean>> {
  return readCommandEnabledOverrides(await readUserCliConfig());
}

// 缺省为启用：只有显式写过 false 才算禁用。这样新装/新拉取的命令默认可见，
// 也避免升级后把用户从没碰过的命令全部隐藏。
function getCommandEnabled(filePath: string, overrides: ReadonlyMap<string, boolean>): boolean {
  return overrides.get(filePath) ?? true;
}

// 启用时删除该路径的条目而不是写 true：config 里只保留“被禁用”的差量，
// 配置文件不会随着命令增删无限膨胀，也天然兼容“默认启用”的语义。
// 条目清空后连 command 键一起删，避免留下空对象影响其它读取方。
function setCommandEnabledOverride(
  config: Record<string, unknown>,
  filePath: string,
  enabled: boolean,
): Record<string, unknown> {
  const commandConfig = isRecord(config.command) ? { ...config.command } : {};

// [权衡] 这里用 delete 而不是赋 true，代价是“已启用”无法与“从未设置”区分；
// 但当前没有依赖这种区分的调用方，换来的是配置文件可被人工审阅。
  if (enabled) {
    delete commandConfig[filePath];
  } else {
    commandConfig[filePath] = { [ENABLE_OVERRIDE_KEY]: false };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(commandConfig).length > 0) {
    nextConfig.command = commandConfig;
  } else {
    delete nextConfig.command;
  }
  return nextConfig;
}

// 插件配置在读取时就归一成强类型：后续扫描只关心“是否启用、扫哪些目录、
// 哪些内置插件被压制”，不再反复做 unknown 收窄。
interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  commands?: unknown;
  name: string;
}

interface PluginCommandRootDescriptor {
  pluginEnabled: boolean;
  pluginMarketplace: string;
  pluginName: string;
  rootPath: string;
}

// 非字符串项直接丢弃而不是 String()：目录清单里混入数字会导致拼出错误路径。
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

// storage.dir 缺省为 ~/.zcode：插件 cache、installed 清单都相对它定位，
// 空串会被当作未配置，否则会解析成当前工作目录，扫描结果随 cwd 漂移。
function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isRecord(config.storage) ? config.storage : {};
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  return {
    dirs: readStringArray(plugins.dirs),
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    storageDir: readStorageDirFromConfig(config),
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

// 支持 ~/ 前缀是配置文件的既定写法；展开后仍要 resolve 成绝对路径，
// 因为后续要拿它做 Set 去重与权限判断，相对路径会因 cwd 不同而指向不同目录。
function resolveConfigPath(path: string): string {
// 只识别 ~/ 前缀而不做 ~user 展开：配置里从未出现过后者，
// 支持它会引入额外的用户查找与跨平台差异，收益为零。
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// 允许用户把 dir 直接配成 .../cli（已包含子目录），此时不再重复拼接；
// 判断依据是最后一段目录名而不是 endsWith 字符串，避免误伤 cli-old 这类名字。
function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
// storageRoot 既可能是 ~/.zcode，也可能被用户直接配成 ~/.zcode/cli；
// 用最后一段目录名判断可同时兼容两种写法，又不会把 ~/.zcode/cli-old 误判。
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

function parsePathList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return readStringArray(value);
}

// [失败路径] 绝对路径一律拒绝：resolve 会忽略 root，直接返回清单里写的路径。
// 用 relative 结果判断是否越界：以 . 开头或等于空串都视为仍在根内，
// 但必须排除 ".." 与 "../x"，否则 ../secret 会被判成合法兄弟目录。
// 返回 null 让调用方跳过该条目，而不是抛错中断整个插件的命令扫描。
// 这里只做字符串级校验，不解析符号链接；插件目录本身由安装流程控制。
function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  const relativePath = relative(rootPath, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  return null;
}

// 官方插件的 cache 布局是 cache/<marketplace>/<plugin>/<version>/，
// 版本目录才是插件根。逐层 readdir 且每层独立 try：任一层不可读时只丢该分支，
// 不阻断其它插件；最后排序保证多次调用得到稳定顺序（影响去重谁先胜出）。
async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: string[] = [];
  try {
    pluginEntries = await readdir(cacheRoot);
  } catch {
    return [];
  }

  const roots: string[] = [];
// 版本目录不排序就遍历会让“同一插件多个版本”时选中哪个不确定，
// 因此外层统一对结果排序，顺序稳定后再交给 seenPluginIds 去重。
  for (const pluginEntry of pluginEntries) {
    const pluginDir = join(cacheRoot, pluginEntry);
    let versionEntries: string[] = [];
    try {
      versionEntries = await readdir(pluginDir);
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      const rootPath = join(pluginDir, versionEntry);
      try {
        if ((await lstat(rootPath)).isDirectory()) {
          roots.push(rootPath);
        }
      } catch {
        // ignore inaccessible plugin cache entries
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

// 清单只读一次并复用 name/commands：name 参与 pluginId 去重与命令 ID 生成，
// commands 决定扫描根。任一字段非法都整份放弃，避免半可信插件贡献命令。
async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
// 插件名同时是 pluginId 的一段和命令 ID 的一段，必须限制字符集：
// 允许 ":" 或路径分隔符会让 ID 产生歧义，也会破坏 config 的键结构。
// 长度上限 128 防止异常清单撑大配置文件。
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    return { commands: parsed.commands, name };
  } catch {
    return null;
  }
}

// 用 existsSync 而不是 readFile 试探：这里只需要“存在性”，
// 顺序即优先级，先命中 ZCode 原生布局，再回落到 Claude/Codex 兼容布局。
async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

// commands 字段可以是单个字符串或字符串数组（旧清单），统一 parsePathList。
// 显式声明了 commands 但全部非法时返回空，不回落默认目录——
// 否则清单的“我有命令目录”声明会被悄悄改写，造成命令凭空出现。
function resolvePluginCommandRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.commands)) {
    const rootPath = resolveInside(params.rootPath, rawPath);
    if (rootPath) {
      roots.push(rootPath);
    }
  }
// 只有完全没写 commands 字段时才试用根下 commands/：裸插件最常见布局，
// 且必须存在才加入，否则会白扫一个不存在的目录。
  if (roots.length === 0 && params.manifest.commands === undefined) {
// 默认命令目录是插件根的 commands/，这是 ZCode/Claude/Codex 三种布局的共识；
// 只有它在磁盘上真实存在时才纳入，避免产生空扫描根。
    const defaultRoot = join(params.rootPath, "commands");
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

// 候选来源三段：用户显式配置的目录（默认启用）、官方 cache（默认停用）、
// 已安装市场插件清单。顺序决定同 pluginId 谁先被采用，因此先内联后 cache 后 installed。
async function resolvePluginCommandRootDescriptors(): Promise<PluginCommandRootDescriptor[]> {
  const config = readPluginConfigFromConfig(await readUserCliConfig());
  if (!config.enabled) {
    return [];
  }

  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
// defaultEnabled 与 marketplace 一起决定可见性：官方 cache 里的插件必须显式启用，
// 否则升级后会把所有内置插件命令一次性灌进命令面板。
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];
  const descriptors: PluginCommandRootDescriptor[] = [];
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
// 清单读取失败直接跳过该候选：候选来自配置与磁盘扫描，
// 目录可能刚被卸载，不能因为一个坏候选中断整轮插件发现。
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
// pluginId 必须带 marketplace：不同市场的同名插件是两个独立实体，
// 只按 name 去重会让后装的市场插件永远看不到命令。
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // 内置官方插件被「卸载」后只在 CLI config 写入 suppressedBuiltins；desktop 直接扫
    // 官方 cache 时不经过 CLI resolve 的过滤，需要在这里同样跳过，否则被卸载的内置插件
    // 仍会从 cache 贡献命令。
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
// pluginId 是 name@marketplace：同一插件可能同时出现在内联目录与 installed 清单，
// 先到先得，保证一次列表里不会出现两份同名命令（INV-01）。
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
// 显式开关优先于默认值：用户手动停用的插件必须立即失效；
// 若用 || 而非 ??，显式 false 会被默认值吞掉，停用操作看起来没反应。
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      continue;
    }

    // 命令管理页过去只展示本地命令，且插件扫描只覆盖内置官方 cache。
    // marketplace installed_plugins.json 里的官方/自建市场插件也要纳入只读命令来源。
    for (const rootPath of resolvePluginCommandRoots({
      manifest,
      rootPath: candidate.rootPath,
    })) {
      descriptors.push({
        pluginEnabled: enabled,
        pluginMarketplace: candidate.marketplace,
        pluginName: manifest.name,
        rootPath,
      });
    }
  }

// 结果保持候选遍历顺序：同一插件多版本时先命中的根先输出，
// 后续 seenFilePaths 去重会让先到者胜出，因此这里不能再排序。
  return descriptors;
}

function getUserCommandsRootForDescriptor(descriptor: CommandAgentSourceDescriptor): string {
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

// 写操作只允许两个落点：project 必须带 workspacePath，user 固定到用户主目录。
// 缺 workspacePath 时抛错而不是退回 user：否则 UI 选了项目却写进全局目录，
// 造成“在当前项目看不到新命令”的错觉。
function getCommandsRootForStorage(params: {
  descriptor: CommandAgentSourceDescriptor;
  storageLevel?: "user" | "project";
  workspacePath?: string;
}): {
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
} {
// 项目级命令写进 <workspace>/.zcode/commands，与读取侧 workspaceDirectorySegments
// 必须完全一致，否则写进去的命令下次列表扫不到。
  if (params.storageLevel === "project") {
    if (!params.workspacePath) {
      throw new Error("Missing workspace path for project command");
    }
    return {
      commandsRoot: join(params.workspacePath, ...params.descriptor.workspaceDirectorySegments),
      scope: "project",
      projectPath: params.workspacePath,
    };
  }

  return {
    commandsRoot: getUserCommandsRootForDescriptor(params.descriptor),
    scope: "global",
  };
}

function getLocationScope(scope: UserCommand["scope"]): SettingsDirectoryLocation["scope"] {
  return scope === "project" ? "project" : "user";
}

// location 是 UI 与 open-in-file-manager 的唯一定位依据：source/scope 决定展示分组，
// directoryPath 决定打开哪个目录，projectPath 只在 project scope 下出现。
function buildCommandLocation(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
}): SettingsDirectoryLocation {
  return {
    source: params.descriptor.directorySource,
    scope: getLocationScope(params.scope),
    directoryPath: params.commandsRoot,
    ...(params.projectPath ? { projectPath: params.projectPath } : {}),
  };
}

// ============================================================================
// CommandsService 实现
// ============================================================================

// 选项目前只保留 isDesktopRuntime 的形状，用于后续按运行时裁剪能力；
// 传入 undefined 也必须可用，服务在 CLI 与测试里都会无参构造。
interface CommandsServiceOptions {
  isDesktopRuntime?: boolean;
}

// 命令名由相对 root 的路径推导：子目录即命名空间，分隔符随来源变化。
// 正则只锚定结尾的扩展名且大小写不敏感，避免 .MD 被当成命令名的一部分；
// filter(Boolean) 去掉空段，防止 "//" 出现在命令名里导致查表失败。
// 返回值始终以 "/" 开头，这是命令面板的显示与匹配契约。
function getCommandName(
  rootDir: string,
  filePath: string,
  descriptor: CommandAgentSourceDescriptor,
): string {
  const relativePath = relative(rootDir, filePath);
  const extensionPattern = new RegExp(`${descriptor.fileExtension.replace(".", "\\.")}$`, "i");
  const withoutExtension = relativePath.replace(extensionPattern, "");
  return `/${withoutExtension
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(descriptor.namespaceSeparator)}`;
}

// 与 getCommandName 互为逆运算：先去掉前导 "/"，再把命名空间分隔符还原成目录分隔符，
// 最后补回扩展名。两者规则不一致会导致“创建成功但列表里看不到”。
function getCommandFileName(config: CommandConfig, agentSource: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  const rawName = config.name.replace(/^\//, "");
  const relativeName = descriptor.namespaceSeparator === ":" ? rawName.replace(/:/g, "/") : rawName;
  return `${relativeName}${descriptor.fileExtension}`;
}

// 不支持 argumentHint 的格式必须显式清空该字段（而不是省略参数）：
// 写回时会整份序列化，残留字段会被当成格式不支持的键写出，解析端报错。
function getWritableCommandConfig(
  config: CommandConfig,
  descriptor: CommandAgentSourceDescriptor,
): CommandConfig {
// [权衡] 这里返回浅拷贝而不是原地 delete：调用方可能仍持有原始 config
// 用于回显或埋点，原地修改会让“用户填了 argumentHint”这一事实凭空消失。
  return descriptor.supportsArgumentHint ? config : { ...config, argumentHint: undefined };
}

function getCommandAgentSources(agentSource?: CommandAgentSource): readonly CommandAgentSource[] {
  return agentSource ? [agentSource] : COMMAND_AGENT_SOURCE_ORDER;
}

// id 由 agentSource/source/scope/name 四段拼成，保证跨目录同名命令仍可区分；
// 不含文件路径，因此改名但不改名时 id 稳定，UI 的选中态不会丢。
function buildCommandId(
  agentSource: CommandAgentSource,
  scope: UserCommand["scope"],
  name: string,
  location: SettingsDirectoryLocation,
): string {
// id 四段都不含文件路径：改名会换路径但不应换 id，否则 UI 的选中态、
// 详情抽屉的打开状态都会在保存后丢失。
  return `${agentSource}:${location.source}:${scope}:${name}`;
}

// 服务用闭包而非 class：所有方法共享同一份扫描函数，且天然没有 this 绑定问题，
// 便于在 RPC 层直接解构传递。返回对象必须完整实现 ICommandsService。
export function createCommandsService(_options?: CommandsServiceOptions): ICommandsService {
// list 的读取顺序（不可交换）：先 project 后 global，来源内先 .zcode 后 .agents。
// 这样 dedupeCommandsByName 的“首次出现优先”才等价于项目覆盖全局、
// zcode 覆盖 agents。任何顺序调整都会改变同名命令的最终胜出者。
// 插件命令必须排在用户命令之后：同名时用户自定义优先。
  async function list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult> {
    const userCommands: UserCommand[] = [];
// 只读一次配置并传给所有扫描函数：边扫边读会让同一次列表里出现不一致的启用态，
// 也会把多次磁盘 IO 放大到每个目录一次。
    const agentSources = getCommandAgentSources(params.agentSource);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();

    // ZCode Agent 需要先合并所有 workspace 目录，再合并所有 user 目录；
    // 按每个目录交错读取 project/user 会让 user .zcode 抢在 workspace .agents 前面。
    for (const agentSource of agentSources) {
// 只有 zcode agent 需要 .zcode/.agents 双来源；其它 agent 来自共享常量时
// 只有单一描述符，避免把 zcode 的约定套到别的 agent 目录上。
      const descriptors =
        agentSource === ZCODE_COMMAND_AGENT_SOURCE
          ? COMMAND_DIRECTORY_SOURCE_DESCRIPTORS
          : [getCommandSourceDescriptor(agentSource)];

      if (params.workspacePath) {
        const workspacePath = params.workspacePath;
        await discoverCommandsFromDirectorySources({
          descriptors,
          commandsRootForDescriptor: (descriptor) =>
            join(workspacePath, ...descriptor.workspaceDirectorySegments),
          commands: userCommands,
          enabledOverrides,
// project 段传入 projectPath 供 buildCommandLocation 生成 location；
// 这里不能省略，否则项目命令在 UI 里会被归到 user 分组。
          projectPath: workspacePath,
          scope: "project",
        });
      }

      await discoverCommandsFromDirectorySources({
        descriptors,
        commandsRootForDescriptor: getUserCommandsRootForDescriptor,
        commands: userCommands,
        enabledOverrides,
        scope: "global",
      });
    }

// 去重放在合并之后、插件命令之前：用户命令内部的同名冲突按扫描顺序解决，
// 插件命令不参与去重，但它排在后面，UI 匹配时仍以用户命令优先。
    const dedupedUserCommands = dedupeCommandsByName(userCommands);
    const pluginCommands =
      !params.agentSource || params.agentSource === ZCODE_COMMAND_AGENT_SOURCE
        ? await discoverPluginCommands(enabledOverrides)
        : [];

    return {
      commands: [...dedupedUserCommands, ...pluginCommands] as ZCodeCommand[],
      userCommands: dedupedUserCommands,
      pluginCommands,
      capability: { userScopeAvailable: true },
    };
  }

// 创建只写一个文件：先确定根目录、再确定文件名，两步都依赖 descriptor。
// 目标已存在时直接抛错而不是覆盖——覆盖会静默摧毁用户手写内容，
// 且调用方（UI 新建对话框）期望拿到“同名已存在”的明确提示。
  async function writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
// 先建目录再探测文件：首装用户没有 commands 目录，
// access 一个不存在的目录只会得到 ENOENT，无法区分“目录缺失”与“文件缺失”。
    await mkdir(commandsRoot, { recursive: true });

// 文件名由 config.name 反推，命名空间 "/" 会被还原成子目录，
// 因此 name 里的分隔符必须与 descriptor 一致，否则会写出多层错误目录。
    const fileName = getCommandFileName(params.config, agentSource);
    const filePath = join(commandsRoot, fileName);

    // 检查文件是否已存在
    try {
// [失败路径] 这里用 access 探测存在性，只有 ENOENT 才继续；
// EACCES、EPERM 等必须原样抛出，否则会在无权限目录上继续 writeFile，
// 最终错误信息变成“写文件失败”，掩盖真正的权限问题。
      await access(filePath);
      throw new Error(`Command file already exists: ${fileName}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
    );
// [事务] 文件写入后立刻把该路径的启用覆盖置为 true：
// 若用户之前在同名路径留下 false，新建命令会一出现就是灰的；
// 两步顺序不能反，先清覆盖再写文件失败会留下“已启用但无文件”的配置。
    await writeFile(filePath, content, "utf-8");
    await writeUserCliConfig(setCommandEnabledOverride(await readUserCliConfig(), filePath, true));

// 写完后回读解析而不是直接返回入参：frontmatter 的默认值、
// 字段裁剪（如 argumentHint）都由解析器决定，只有它才是列表里的真实形态。
    const parsed = CommandFileParser.parseCommandFile(content, filePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
// 命令名统一由文件路径推导，保证创建结果与下次 list 完全一致；
// 用 config.name 直接拼会出现大小写或分隔符差异，导致刚建完就匹配不到。
    const name = getCommandName(commandsRoot, filePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: true,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

// 更新本质是“可能改名”：oldFilePath 为空表示纯内容修改（原地写），
// 非空且路径变化则先删旧文件再写新文件。这两个分支的任何一端出错，
// 都必须保证不会同时存在新旧两份命令（否则列表出现重复项）。
  async function updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
// 文件名始终从新 config 推导：改名场景下 oldFilePath 只用于定位旧文件，
// 绝不能拿它当写入目标，否则用户看到“保存成功但名称没变”。
    const newFileName = getCommandFileName(params.config, agentSource);
// 新路径必须与读取侧同一拼接规则（commandsRoot + 相对名），
// 否则写进去的命令不在扫描范围内，表现为保存后从列表消失。
    const newFilePath = join(commandsRoot, newFileName);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();
// 先读出旧内容再删文件：解析器需要旧 frontmatter 来保留未在表单里暴露的字段，
// 读失败（文件已被手工删除）时降级为 undefined，仍允许继续写新文件。
    const existingContent = params.oldFilePath
      ? await readFile(params.oldFilePath, "utf-8").catch(() => undefined)
      : undefined;

    // 如果文件名变了，需要删除旧文件
// [事务] 先删旧再写新：顺序反了会在写入失败时留下两份命令；
// 删除失败被吞掉（ENOENT 属正常），因为真正的目标是让新文件落盘，
// 残留旧文件会在下次 list 中作为独立条目出现，用户可手工清理。
    if (params.oldFilePath && params.oldFilePath !== newFilePath) {
      try {
        await rm(params.oldFilePath);
      } catch {
// 删除失败一律吞掉会掩盖权限问题，但改名场景下旧文件已被用户手工删掉
// 是最常见的情况；ENOENT 与其它 errno 的区别已在上面分支处理，
// 这里只兜住“删的时候文件已经不在”的竞态。
        // 旧文件可能已被移除，忽略删除失败（ENOENT 属正常情况）。
      }
    }

    // 检查新文件是否已存在（排除自己的旧路径）
// 只有真的改名时才做“已存在”检查：同名保存是常规编辑，
// 若不做这个排除，任何内容修改都会被自己刚写出的文件判成冲突。
    if (newFilePath !== params.oldFilePath) {
      try {
        await access(newFilePath);
        throw new Error(`Command file already exists: ${newFileName}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
      existingContent,
    );
// 改名可能把命令移到新的命名空间子目录，写入前必须补齐层级；
// recursive 对已存在目录是幂等操作，不会影响原有文件。
    await mkdir(dirname(newFilePath), { recursive: true });
    await writeFile(newFilePath, content, "utf-8");

    if (
      params.oldFilePath &&
      params.oldFilePath !== newFilePath &&
// [事务] 只有旧路径存在显式覆盖时才迁移：启用状态用“缺省即启用”表示，
// 给新路径写 true 会凭空造出一条差量配置；迁移本身是先删旧键再加新键，
// 顺序保证即使中途失败，也只会退化成“启用”，不会两个路径同时禁用。
      enabledOverrides.has(params.oldFilePath)
    ) {
      // 禁用状态按命令文件路径存放；编辑命令改名会换文件路径，必须迁移 override，
      // 否则用户刚禁用的命令会因为改名重新启用。
      const migratedConfig = setCommandEnabledOverride(
        setCommandEnabledOverride(await readUserCliConfig(), params.oldFilePath, true),
        newFilePath,
        enabledOverrides.get(params.oldFilePath) ?? true,
      );
      await writeUserCliConfig(migratedConfig);
    }

    const parsed = CommandFileParser.parseCommandFile(content, newFilePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, newFilePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: getCommandEnabled(newFilePath, await readCommandEnabledOverridesFromUserConfig()),
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

// 删除对 ENOENT 幂等：文件可能已被用户在文件管理器里移除，
// 此时仍要继续清理启用覆盖，否则同一路径再次新建时会被旧配置误禁用。
  async function deleteCommandFile(params: CommandDeleteParams): Promise<void> {
    try {
      await rm(params.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
// 只吞 ENOENT：EBUSY/EPERM（Windows 上文件被占用）必须上抛，
// 否则 UI 会显示删除成功，但下次刷新命令又回来了。
      if (err.code === "ENOENT") {
        // 文件不存在，当作成功
      } else {
        throw error;
      }
    }
    await writeUserCliConfig(
      setCommandEnabledOverride(await readUserCliConfig(), params.filePath, true),
    );
  }

// 启停只改配置不改文件：命令文件属于用户资产，
// 删除/重命名都必须走显式 CRUD，这里保持“文件不动、只是隐藏”的语义。
  async function setCommandEnabled(params: CommandSetEnabledParams): Promise<void> {
// 读-改-写不是原子的：并发启停两条命令可能互相覆盖；
// 但命令面板的操作是用户逐个点击，串行发起即可，不额外引入锁文件。
    const nextConfig = setCommandEnabledOverride(
      await readUserCliConfig(),
      params.filePath,
      params.enabled,
    );
    await writeUserCliConfig(nextConfig);
  }

// 返回用户级命令目录而不是项目目录：入口是“打开命令文件夹”，
// 用户期望看到可长期编辑的全局命令，项目目录随 workspace 变化不适合作为默认落点。
  async function getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }> {
    const path = getUserCommandsRoot(params?.agentSource);
    // open-in-file-manager 在 Windows 上不能可靠打开不存在的路径，
    // 这里先确保命令目录落盘，再把路径交给系统文件管理器。
    await mkdir(path, { recursive: true });
    return { path };
  }

  return {
    list,
    writeCommandFile,
    updateCommandFile,
    deleteCommandFile,
    setCommandEnabled,
    getPrimaryUserCommandsDirectory,
  };
}

// 用 Map 而不是 filter+some：后者是 O(n^2)，命令数量虽小但扫描结果会随
// 插件增多线性放大。保留首次出现即保留最高优先级来源（INV-01、INV-02）。
function dedupeCommandsByName(commands: UserCommand[]): UserCommand[] {
  const selected = new Map<string, UserCommand>();
  for (const command of commands) {
    if (!selected.has(command.name)) {
      selected.set(command.name, command);
    }
  }
  return Array.from(selected.values());
}

// 插件命令 id 额外带 filePath：同一插件里允许存在同名文件（不同子目录），
// 只用 name 会让两条命令的 React key 冲突，点击其中一条却选中另一条。
function buildPluginCommandId(params: {
  filePath: string;
  name: string;
  pluginMarketplace: string;
  pluginName: string;
}): string {
  return `plugin:${params.pluginMarketplace}:${params.pluginName}:${params.name}:${params.filePath}`;
}

// 插件命令统一在最后排序：目录遍历顺序依赖文件系统，不稳定；
// 排序后再返回，保证同一份配置在任何机器上得到相同的命令面板顺序。
async function discoverPluginCommands(
  enabledOverrides: ReadonlyMap<string, boolean>,
): Promise<PluginCommand[]> {
// 先解析出“哪些插件根可见”再逐根扫描：可见性判断集中在 resolve 阶段，
// 扫描函数只负责遍历，避免在递归里重复读配置导致结论不一致。
  const rootDescriptors = await resolvePluginCommandRootDescriptors();
// 结果数组跨多个插件根累积，去重靠 seenFilePaths 而不是数组本身：
// 同一文件可能被两个根同时扫到，先扫到的插件信息才应被保留。
  const commands: PluginCommand[] = [];
// 去重集合在整轮扫描内共享：若每个根各建一个，重叠目录的同一文件会出现多次，
// 且两次生成的 id 不同，UI 选中态会跳。
  const seenFilePaths = new Set<string>();
  for (const descriptor of rootDescriptors) {
    await discoverPluginCommandsRecursive(descriptor.rootPath, descriptor.rootPath, commands, {
      descriptor,
      enabledOverrides,
      seenFilePaths,
    });
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

// ============================================================================
// 辅助函数
// ============================================================================

// 递归遍历不跟随符号链接（lstat 判断目录）：插件目录里的软链可能指向用户
// 主目录，跟随会把任意 markdown 当成可执行命令暴露出去。
async function discoverPluginCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: PluginCommand[],
  options: {
    descriptor: PluginCommandRootDescriptor;
    enabledOverrides: ReadonlyMap<string, boolean>;
    seenFilePaths: Set<string>;
  },
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }

    const fullPath = join(currentDir, entry);
    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
// 递归时把 rootDir 原样传下去：命令名必须相对插件命令根计算，
// 若改用 currentDir，子目录会丢掉命名空间前缀，出现重名命令。
      await discoverPluginCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (!entry.toLowerCase().endsWith(ZCODE_COMMAND_DESCRIPTOR.fileExtension)) {
      continue;
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const parsed = CommandFileParser.parseCommandFile(
        content,
        fullPath,
        ZCODE_COMMAND_DESCRIPTOR.format,
      );
      if (!parsed) {
        continue;
      }
      const name = getCommandName(rootDir, fullPath, ZCODE_COMMAND_DESCRIPTOR);
// 去重键做分隔符归一加小写：同一文件可能通过 config.dirs 与 installed 清单
// 两条路径进入候选（大小写不同的盘符/目录名在 Windows 上等价），
// 不归一会让同一命令出现两次，且 id 相同导致 UI 选中态异常。
      const commandKey = fullPath.replaceAll("\\", "/").toLowerCase();
      if (options.seenFilePaths.has(commandKey)) {
        continue;
      }
      options.seenFilePaths.add(commandKey);
      commands.push({
        ...parsed,
        enabled:
          options.descriptor.pluginEnabled && getCommandEnabled(fullPath, options.enabledOverrides),
        filePath: fullPath,
        id: buildPluginCommandId({
          filePath: fullPath,
          name,
          pluginMarketplace: options.descriptor.pluginMarketplace,
          pluginName: options.descriptor.pluginName,
        }),
        name,
// enabled 与 pluginEnabled 同时保留：前者是“最终是否可用”，
// 后者用于 UI 解释“为什么不可用”（插件停用 vs 单文件禁用），
// 合成一个布尔值会让用户无法判断该去插件页还是命令页恢复。
        pluginEnabled: options.descriptor.pluginEnabled,
        pluginMarketplace: options.descriptor.pluginMarketplace,
        pluginName: options.descriptor.pluginName,
        scope: "global",
// 插件命令一律标 global 与 source=plugin：插件安装在用户级存储下，
// 不随 workspace 变化；标成 project 会让切换项目后误以为插件命令消失。
        source: "plugin",
      });
    } catch {
      // 插件命令本身由插件管理；单个文件解析失败不阻断其它命令展示。
    }
  }
}

// 用户命令递归比插件多一层 scope/projectPath 透传：
// 每个文件都要生成带项目信息的 location，不能只在根目录算一次。
async function discoverUserCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: UserCommand[],
  options: {
    descriptor: CommandAgentSourceDescriptor;
    scope: UserCommand["scope"];
    enabledOverrides: ReadonlyMap<string, boolean>;
    projectPath?: string;
  },
): Promise<void> {
  const descriptor = options.descriptor;
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);

    // 跳过隐藏文件和目录
    if (entry.startsWith(".")) {
      continue;
    }

    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      // 无法访问，跳过
      continue;
    }

    if (isDir) {
      // 递归扫描子目录
// 用户命令同理：rootDir 是 <commands> 根，子目录层级即命名空间；
// 传错会让 /group/name 退化成 /name，与文件实际位置不符。
      await discoverUserCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

// 扩展名匹配大小写不敏感：macOS 上用户常写出 .MD，
// 严格匹配会让这类文件在列表里彻底消失，且没有任何提示。
    if (entry.toLowerCase().endsWith(descriptor.fileExtension)) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = CommandFileParser.parseCommandFile(content, fullPath, descriptor.format);
        if (parsed) {
          const name = getCommandName(rootDir, fullPath, descriptor);
          const location = buildCommandLocation({
            descriptor,
            commandsRoot: rootDir,
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
          commands.push({
            ...parsed,
            name,
            agentSource: descriptor.agentSource,
            location,
            id: buildCommandId(descriptor.agentSource, options.scope, name, location),
            source: "user",
// INV-05：插件启用与文件禁用是“与”关系。写成或会让停用的插件里
// 被单独启用过的命令重新出现，等于绕过插件总开关。
            enabled: getCommandEnabled(fullPath, options.enabledOverrides),
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
        }
      } catch {
        // 解析失败就跳过
      }
    }
  }
}

// 根不存在时返回 0 而不是抛错：绝大多数用户没有 .agents 目录，
// 这是常态而非异常；返回值只用于判断是否继续读低优先级来源。
async function discoverCommandsRoot(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<number> {
  const beforeCount = params.commands.length;
  try {
// 先 access 再 readdir：readdir 的 ENOENT 与 EACCES 都在下面的 catch 里，
// 提前探测让“目录不存在”走快路径，不产生一次异常开销。
    await access(params.commandsRoot);
  } catch {
    return 0;
  }

  try {
    await discoverUserCommandsRecursive(params.commandsRoot, params.commandsRoot, params.commands, {
      descriptor: params.descriptor,
      scope: params.scope,
      enabledOverrides: params.enabledOverrides,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
  } catch {
    // 扫描出错时返回已发现的命令
  }
// 返回本轮新增条数供上层判断是否短路低优先级来源；
// 用长度差而不是计数器，是因为递归内部有多条 skip 分支，
// 长度差天然只统计真正 push 进数组的有效命令。
  return params.commands.length - beforeCount;
}

// [权衡] 这里按 descriptor 串行扫描而不是 Promise.all：
// .zcode 一旦读到命令就要跳过 .agents，并发会白扫且可能让低优先级结果先入数组，
// 破坏“首次出现即胜出”的去重前提。
async function discoverCommandsFromDirectorySources(params: {
  descriptors: readonly CommandAgentSourceDescriptor[];
  commandsRootForDescriptor: (descriptor: CommandAgentSourceDescriptor) => string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<void> {
  for (const descriptor of params.descriptors) {
    const discoveredCount = await discoverCommandsRoot({
      descriptor,
      commandsRoot: params.commandsRootForDescriptor(descriptor),
      commands: params.commands,
      enabledOverrides: params.enabledOverrides,
      scope: params.scope,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
    // `.zcode` 是强优先级来源；只要读到有效命令，同 scope 的 `.agents` 就不再参与。
// INV-02 的落点：只在同 scope 内短路，且要求确实读到有效命令。
// 若 .zcode 目录存在但为空/全部解析失败，仍应回落到 .agents，
// 否则用户清空 .zcode 后会以为命令全丢了。
    if (descriptor.directorySource === "zcode" && discoveredCount > 0) {
      break;
    }
  }
}
