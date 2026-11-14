import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginDiagnostic, PluginManifest, PluginStoreListing } from "@zcode/contracts";
import { isOfficialMarketplaceId, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { DEFAULT_PLUGIN_MARKETPLACES, sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import {
  appendPluginSourceCleanupError,
  cleanupPluginSourceBestEffort,
  directoryExists,
  fileExists,
  isRecord,
  resolveInside,
  sanitizePluginId,
} from "./helpers.js";
import { enumeratePluginComponents, type PluginComponentGroup } from "./plugin-components.js";
import { applyNetworkEgressEnv } from "../network/subprocess-env.js";
import { createNodeWebFetchHttpClientAdapter } from "../http/index.js";
import { writeCdnOfficialMarketplacePartitionSync } from "./official-marketplace.js";
import {
  isZipPluginUrlSource,
  readZipPluginSourceSha256,
  resolveZipPluginSource,
} from "./zip-source.js";
import {
  activateDirectoryAtomically,
  recoverAtomicTargetSync,
  writeFileAtomically,
  type AtomicDirectoryActivation,
} from "./atomic-directory.js";
import {
  resolveGitHubArchiveSource,
  shouldFallbackGitHubArchiveToGit,
} from "./github-archive-source.js";
import {
  createArchiveFetchError,
  createGitUnavailableError,
  getPluginSourceDiagnosticCode,
  isCommandUnavailableError,
  PluginSourceMaterializationError,
} from "./source-errors.js";

/*
 * ============================================================
 * plugins / marketplaces.ts —— 插件市场注册、拉取、安装、卸载与校验
 *
 * 定位：维护 known_marketplaces.json 与 installed_plugins.json，把 marketplace.json 中的插件
 * 条目解析为本地缓存目录（git clone / GitHub Archive / zip / 目录 / bundled cache）。
 *
 * 输入输出：source 可为 url/github/git/npm/file/directory/settings；安装返回依赖闭包与记录。
 * marketplace 目录与安装缓存均通过 atomic-directory 做事务提交/回滚。
 *
 * 副作用：读写 storageRoot 下 JSON、临时 clone/解压目录、Git 子进程、HTTP 请求（经统一客户端）；
 * 临时目录在 finally 中清理，清理错误追加到主错误。
 *
 * 失败语义：manifest 声明官方 id 但来源不可信→拒绝（trustedId 守卫）；依赖环/跨市场依赖
 * 默认拒绝；刷新失败持久化 lastRefreshFailure，但用户取消不写入失败状态；
 * 事务阶段失败按 authority 是否恢复决定 rollback 或 finalize，避免跨代状态。
 *
 * 不变量：marketplace 与 known state 使用同一 transactionId 提交；缓存版本取自插件自带
 * plugin.json（而非条目 version）；所有相对路径经 resolveInside 限制；uninstall 最后一份时
 * 才删 data 目录。
 * ============================================================
 */

// ============================================================
// 模块不变量（改代码前先对照，每条都对应一类线上故障）
//
// INV-1: known_marketplaces.json 与 marketplace 目录必须用同一个 transactionId 提交。
//        破坏后果：崩溃恢复时按新代际回滚，会把另一事务刚写好的目录一起删掉或留下跨代混合状态。
// INV-2: 缓存版本号一律取插件自带 plugin.json 的 version，绝不取 marketplace 条目的 version。
//        破坏后果：条目版本与真实包不一致时，已安装记录会显示一个本地并不存在的版本，升级判断失效。
// INV-3: 所有来自 manifest 的相对路径必须经 resolveInside 限制在目标根目录内。
//        破坏后果：`../../` 路径可以读写市场目录之外的任意文件，构成路径穿越。
// INV-4: 只有当插件是 marketplace 最后一份安装记录时才删除 data 目录。
//        破坏后果：同一插件在 user/workspace 两个 scope 各装一次时，卸载其一会把另一份的数据一起删掉。
// INV-5: manifest 声明官方 id 但来源不是可信 registry 时必须拒绝（trustedId 守卫）。
//        破坏后果：任意第三方市场可冒充官方市场，用同名插件覆盖官方包。
// INV-6: 跨市场依赖默认拒绝，只有列在 allowCrossMarketplaceDependenciesOn 中的市场才放行。
//        破坏后果：一个市场可以静默把另一市场的插件拉进依赖闭包，绕过用户已确认的安装范围。
// INV-7: 依赖闭包必须按拓扑序安装（依赖在前），出现环时整体拒绝。
//        破坏后果：先装依赖方再装依赖，后者失败时前者已落盘，形成无法自愈的半装状态。
// INV-8: 刷新失败写 lastRefreshFailure，但用户主动取消（AbortError）不写入。
//        破坏后果：用户点「取消」会被记成市场故障，下次打开看到虚假的红色告警。
// INV-9: 目录激活的 rollback 与 finalize 二选一，且必须在同一事务内完成。
//        破坏后果：既回滚又保留会让新旧两代目录同时存在，安装路径指向其中任一个都不确定。
// INV-10: 临时 clone/解压目录必须在 finally 里清理，清理失败只追加诊断，不覆盖主错误。
//         破坏后果：主错误被清理错误吞掉后，用户看到的失败原因与实际根因无关。
// INV-11: 下载/解压产物必须先落到 staging 目录，成功后再原子 rename 到目标。
//         破坏后果：直接写目标目录时，中断会留下半个包，但已安装记录仍认为它可用。
// INV-12: 市场来源切换（source 变更）必须使旧缓存失效，不能复用旧目录。
//         破坏后果：用户把市场从 A 仓库切到 B 后，仍装出 A 的插件，来源与内容不一致。
// INV-13: Git 子进程必须使用 buildMarketplaceGitEnv 构造的环境，不能直接继承 process.env。
//         破坏后果：代理/CA 配置缺失，安装在内网环境卡到超时；运行时私有变量也会泄漏给子进程。
// INV-14: 对外的错误一律经 getPluginSourceDiagnosticCode 映射为诊断码，不把原始栈抛给 UI。
//         破坏后果：UI 展示不稳定的内部错误文本，文案无法本地化，也暴露本机路径。
// INV-15: 市场目录解析失败时回退到市场根目录，而不是抛错终止整个市场加载。
//         破坏后果：单个 pluginRoot 配错会让该市场其余几十个可安装插件一起消失。
// INV-16: 超时与用户取消必须可区分（TimeoutError vs AbortError）。
//         破坏后果：两者混为一谈后，UI 无法决定「重试」还是「尊重用户意图」，会反复自动重试。
// ============================================================
const execFileAsync = promisify(execFile);
// 两个状态文件名是磁盘契约：改名等价于「丢弃全部已安装记录」，用户升级后会看到插件全部消失。
// 因此只能在带迁移逻辑的前提下改，不能为了整齐顺手重命名。
const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
const MARKETPLACE_FILE = "marketplace.json";
const CLAUDE_OFFICIAL_MARKETPLACE = "claude-plugins-official";
const PLUGIN_ICON_SOURCES_FILE = "icon-sources.json";
const PLUGIN_ICON_ASSETS_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/assets/";
const PLUGIN_ICON_SOURCES_URL = `${PLUGIN_ICON_ASSETS_BASE_URL}${PLUGIN_ICON_SOURCES_FILE}`;
const MARKETPLACE_JSON_MAX_BYTES = 10 * 1024 * 1024;
const MARKETPLACE_JSON_MAX_REDIRECTS = 5;
const MARKETPLACE_JSON_TIMEOUT_MS = 180_000;
// 三个上限共同构成远程 manifest 的防护边界：
// - 体积上限挡住「无限流式响应」，否则 readFile 会把内存打满；
// - 重定向上限挡住重定向环，fetch 的默认行为会一直跟下去；
// - 180s 是「大仓库 + 慢网络」的经验上限，调小会让弱网用户无法添加市场，调大会让 UI 长时间无反馈。
const claudeIconMigrationAttempts = new Set<string>();
const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");
const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
// Git clone 的重试只针对「瞬时失败」（网络抖动、远端 5xx），不区分错误码就重试会把
// 「仓库不存在/无权限」也重试三遍，用户要等满 270s 才能看到正确的失败原因。
const GIT_CLONE_MAX_ATTEMPTS = 3;
const GIT_COMMAND_TIMEOUT_MS = 90_000;
const GIT_CLONE_RETRY_DELAY_MS = 1_000;
const CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS = 30_000;
// 市场名与插件名共用同一字符集：它们会拼进 `<name>@<marketplace>` 与磁盘目录名。
// 禁止大写与首字符符号，是为了让「同一名字」在不同平台上不会因大小写不敏感文件系统互相覆盖。
const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SOURCE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
// 这些字段在插件 manifest 里合法，但本运行时不支持：列出它们是为了「明确拒绝」而不是静默忽略。
// 静默忽略会让用户以为 lspServers/settings 已生效，实际插件行为与声明不符，且极难排查。
const UNSUPPORTED_MANIFEST_FIELDS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;

/** 市场来源判别联合：npm/hostPattern/pathPattern 仅识别不支持；settings 为内存内联 manifest。 */
// 不可实现的来源也保留在联合里，是刻意的：解析阶段能识别出「这是 npm 市场」并给出
// 「暂不支持」的准确诊断，而不是报「格式非法」。若从联合中删掉，用户只会看到一句无意义的解析失败。
// settings 变体用于官方 seed 与测试：它不落盘，直接带着 manifest 对象，因此不能有 path。
export type MarketplaceSource =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface PluginMarketplaceEntry {
  /** 市场内唯一插件名（也是 `<name>@<marketplace>` 的 name 段）。 */
  // 唯一性由市场内去重保证，不靠 manifest 作者自觉：重名条目后者覆盖前者会导致
  // 用户装到的插件与自己看到的描述不是同一个。sanitizePluginId 负责把非法字符挡在入口。
  name: string;
  /** 展示分类，仅用于 UI 分组。 */
  category?: string;
  /** 条目级短描述（listing 缺失时展示）。 */
  description?: string;
  /** 条目版本；仅作兜底，真实版本优先读插件自带 manifest。 */
  // 之所以不信任条目 version：市场维护者经常忘记同步它，而安装产物是插件包 manifest 本身。
  // 用条目版本会导致「列表显示 1.2、实际装的是 1.0」，升级提示永远不出现（INV-2）。
  version?: string;
  /** 安装源（字符串相对路径或对象 source 判别；语义见 resolvePluginSourceRoot）。 */
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  /** 依赖插件 id 列表（`name` 或 `name@marketplace`），安装时展开闭包。 */
  // 无 marketplace 后缀的依赖按「同市场」解释，不按「任意已安装市场」解释：
  // 后者会让同名插件在不同市场间隐式串味，闭包结果取决于用户装过什么。
  dependencies?: string[];
  /** false 表示允许无 manifest 的“合成 manifest”安装；默认 strict。 */
  strict?: boolean;
  /** 展示标签，仅用于 UI。 */
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  /** 条目原始 JSON，写入合成 manifest 时作为基底并剔除展示字段。 */
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  /** 市场 id（`MARKETPLACE_NAME_PATTERN` 约束），也是插件 id 的 marketplace 段。 */
  name: string;
  /** 市场描述（可来自 metadata.description）。 */
  description?: string;
  /** 已归一化的插件条目（字段与目录 JSON 对齐），读取方不再做兼容处理。 */
  plugins: PluginMarketplaceEntry[];
  /** 允许依赖的其他市场 id 白名单；未列出时跨市场依赖被拒绝。 */
  allowCrossMarketplaceDependenciesOn?: string[];
  /** 插件相对路径基准目录（相对市场目录）；越界或不存在时回退市场目录。 */
  pluginRoot?: string;
  // 商店「公开」分段 Featured 区的策展名单（插件 name，按序）；由目录 JSON 顶层 featured 字段远程控制。
  featured?: string[];
  /** 目录原始 JSON。 */
  raw: Record<string, unknown>;
}

export interface KnownMarketplaceRecord {
  /** 市场 id（manifest.name）。 */
  id: string;
  /** 规范化来源，刷新时用它重新拉取；未知类型在解析期已剔除。 */
  source: MarketplaceSource;
  /** 展示名，当前与 id 相同；UI 改版后可独立于 id 变化。 */
  name: string;
  /** 市场描述，可缺省；缺省时详情页回退到 manifest 的 description。 */
  description?: string;
  /** 首次添加时间（ISO 8601）。 */
  addedAt: string;
  /** 最近一次成功刷新时间（ISO 8601）；UI 据此判断是否过期。 */
  lastUpdated?: string;
  /** 最近一次刷新失败的诊断；成功刷新会清除。 */
  // 只保留「最近一次」而不累积历史：UI 只展示当前状态，历史失败会让用户误以为市场仍在故障。
  // 但用户取消不写这里（INV-8），否则一次取消会把上一次真实故障覆盖掉，反而更难定位。
  lastRefreshFailure?: MarketplaceRefreshFailure;
  /** 条目数量，与 plugins.length 同步写入。 */
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface MarketplaceRefreshFailure {
  /** 诊断码（来自 PluginDiagnostic）。 */
  code: PluginDiagnostic["code"];
  /** 失败时间（ISO 8601）。 */
  failedAt: string;
  /** 面向用户的错误原因（已脱敏），可直接进 toast。 */
  message: string;
}

export interface InstalledPluginRecord {
  /** `<name>@<marketplace>`。 */
  id: string;
  /** 插件名（不含 marketplace 段），安装解析时与 marketplace 拼成 id。 */
  name: string;
  /** 来源市场 id，指向 manifest.name；跨市场依赖校验按它比对。 */
  marketplace: string;
  /** 实际安装版本（取自插件 manifest，非条目）。 */
  // 这个字段是升级判断的唯一依据，必须与磁盘上的插件包一致（INV-2）。
  // 若这里写条目 version，会出现「记录说 2.0、磁盘是 1.0」，导致永远不会触发升级。
  version: string;
  /** 安装缓存绝对路径（可能被 atomic recovery 调整）。 */
  // 不能假设它等于 `cacheRoot/id`：崩溃恢复可能把上一代目录改名为 `.prev` 再激活新目录，
  // 因此所有读取都必须以本字段为准，用规则拼路径会在恢复后指向不存在的目录。
  installPath: string;
  /** 首次安装时间（ISO 8601），升级时不改写。 */
  installedAt: string;
  /** 最近升级时间（ISO 8601）；首次安装时缺省。 */
  updatedAt?: string;
  /** 安装作用域：user 全局 / workspace 当前工作区。 */
  // scope 同时参与「记录唯一性」与「数据目录归属」：同一插件在两个 scope 是两条独立记录，
  // 卸载时必须按 (id, scope) 精确定位，只按 id 删会误删另一个 scope 的安装（INV-4）。
  scope: "user" | "workspace";
  /** 依赖 id 列表。 */
  dependencies?: string[];
  /** 原始 source（用于重装/诊断）。 */
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

interface PluginIconSourceRecord {
  name: string;
  icon: string;
  mimeType?: string;
  sha256?: string;
}

export interface InstalledPluginsState {
  /** 状态文件格式版本，固定为 1。 */
  version: 1;
  /** plugins 保存全部 InstalledPluginRecord，以 id 与 scope 组合唯一。 */
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  /** 本次安装的依赖闭包（拓扑序，依赖在前）。 */
  // 顺序即安装顺序：调用方若按此顺序写 state，崩溃后恢复也能从「第一个缺失项」继续，
  // 而不是重新计算闭包（重算可能因市场内容变化得到不同结果）。
  closure: string[];
  /** 已写入 state 的安装记录（与 closure 对应）。 */
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  /** 诊断码（PluginDiagnostic 枚举），用于 UI 分类。 */
  code: PluginDiagnostic["code"];
  /** 面向用户的消息。 */
  message: string;
  /** 相关文件或目录路径。 */
  path?: string;
  /** pluginId 指出问题的插件；目录级诊断不针对单个插件时此字段缺省。 */
  pluginId?: string;
  /** error 阻断安装，warning 仅提示。 */
  severity: PluginDiagnostic["severity"];
}

// 诊断必须区分 severity：error 让整个安装中止，warning 只展示。
// 若把「缺图标」这类 warning 升成 error，会让大量本可安装的插件被拒；
// 反之把「manifest 声明了不支持的字段」降成 warning，则用户会装上一个行为不完整的插件。
// 组件枚举的类型定义在 plugin-components.ts；这里再导出，保持 adapter barrel 的对外契约稳定。
export type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from "./plugin-components.js";

export interface DescribeMarketplacePluginResult {
  /** 按类型分组的组件名称与描述，顺序沿用 plugin.json 声明序。 */
  components: PluginComponentGroup[];
  /** 降级过程中收集的诊断（不回滚已读到的组件）。 */
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  /** 作者名，取自 plugin.json 的 author 字段。 */
  author?: string;
  /** 作者主页 URL。 */
  authorUrl?: string;
  /** 插件主页 URL。 */
  homepage?: string;
  /** 插件版本，与安装记录的 version 同源。 */
  version?: string;
}

/** 构造 Git 子进程环境：清理 ZCode 运行时变量后，从显式网络配置恢复 HTTP(S)/NO_PROXY/CA。 */
export function buildMarketplaceGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = sanitizeZCodeRuntimeEnv(sourceEnv);
  // marketplace 安装会启动 Git 子进程，不能只依赖父进程继承的 shell 代理。
  // 这里统一从 ZCode 显式网络环境恢复 HTTP(S)/NO_PROXY/CA，避免安装按钮卡到协议超时。
  // 先 sanitize 再 apply 的顺序不能反：apply 会读取「干净后的 sourceEnv」里的网络配置，
  // 若先注入再清理，刚注入的代理变量会被当成运行时私有变量删掉。
  return applyNetworkEgressEnv(env, { sourceEnv });
}

/** 取消检查：抛出可被上层识别为 AbortError 的操作取消错误。 */
function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  // 每个耗时步骤（git、HTTP、解压）开始前都要重新检查一次：AbortSignal 只会通知，
  // 不会自动中断已经排队的同步逻辑。少检查一次，用户取消后仍会继续下载几十 MB。
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

/** 构造统一的插件操作取消错误（name=AbortError，区别于超时错误）。 */
// name 必须是字面量 "AbortError"：上层按 name 判断，而不是 instanceof（跨模块可能有多份 Error 构造）。
// 改掉 name 会让「用户取消」被当成真实故障写入 lastRefreshFailure（INV-8/INV-16）。
function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

interface MarketplaceOperationSignalScope {
  cleanup: () => void;
  signal?: AbortSignal;
  timedOut: boolean;
  timeoutError: Error;
}

interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

// Claude 官方市场只提供可选目录，外部网络不可达时必须中止底层请求，不能拖住其他插件市场。
/**
 * 为单次市场操作创建信号作用域。仅 Claude 官方市场加 30s 超时（外部网络不可达时不能拖住
 * 其他市场），其他来源直接透传外部 signal。
 * 返回 cleanup（清 timer/监听器）与 timedOut 标记，供上层区分超时与用户取消。
 */
function createMarketplaceOperationSignalScope(
  trustedId: string | undefined,
  externalSignal?: AbortSignal,
): MarketplaceOperationSignalScope {
  // 只有 Claude 官方市场加超时：它是外部网络来源，不可达时若没有超时，
  // 整个「加载全部市场」会被一个 180s 的请求串行拖住，用户看到的是所有市场都不出现。
  // 其它来源（本地目录/官方 CDN）要么快、要么有自己的超时，再加一层只会误杀慢网络。
  if (trustedId !== CLAUDE_OFFICIAL_MARKETPLACE) {
    return {
      cleanup: () => {},
      signal: externalSignal,
      timedOut: false,
      timeoutError: new Error("Marketplace operation timed out"),
    };
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    `Claude marketplace refresh timed out after ${CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS / 1000} seconds`,
  );
  timeoutError.name = "TimeoutError";
  const scope: MarketplaceOperationSignalScope = {
    cleanup: () => {
      // [资源] timer 与监听器都必须清：只清 timer 会让每个请求在长驻的 externalSignal 上
      // 累积一个 listener，几十次刷新后触发 MaxListenersExceededWarning；
      // 只清 listener 则会让已完成的请求仍被 30s 定时器 abort 一次。
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
    signal: controller.signal,
    timedOut: false,
    timeoutError,
  };
  const abortExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    // 先置 timedOut 再 abort：abort 监听器可能同步抛错或被上层立即读取，
    // 顺序反过来会让上层看到「timedOut=false 但已 abort」，从而把超时判成用户取消。
    scope.timedOut = true;
    controller.abort(timeoutError);
  }, CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS);

  // 外部 signal 已经 abort 时不再 addEventListener：{ once: true } 也不会对已触发过的 signal
  // 补发事件，直接同步 abort 才能让下游立刻看到取消。
  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
  return scope;
}

interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}

/**
 * 解析命令行/UI 传入的市场来源字符串为规范 MarketplaceSource。
 *
 * 口径：http(s) 且 .git/_git → git；github.com 仓库 → git；git@host:path → git；
 * 本地路径必须存在（文件需 .json）；`owner/repo` → github shorthand；其余报错。
 * 纯解析，无 IO 副作用（仅对本地路径做存在性检查）。
 */
export async function parseMarketplaceSourceInput(input: string): Promise<MarketplaceSource> {
  const trimmed = input.trim();
  // 先 trim 再判空：UI 输入框常见粘贴带入的换行与空格，
  // 不 trim 会把 "  https://x  " 当成未知来源，报出误导性的「不支持」。
  if (trimmed.length === 0) {
    throw new Error("Marketplace source is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const { url, ref } = splitRef(trimmed);
    // 先剥离 ref 再判结尾：带 ref 的地址末尾不是 .git，不先剥离就看不出仓库后缀，
    // 会被误判成普通 url 去当静态 JSON 下载，得到 404 而不是可用的 git 来源。
    if (url.endsWith(".git") || url.includes("/_git/")) {
      return ref ? { source: "git", url, ref } : { source: "git", url };
    }
    const parsed = tryParseUrl(url);
    // github.com 的网页地址（blob/tree 等）按「仓库根」理解：pathname 只取前两段，
    // 避免把 /tree/main/sub 当成 repo 名。匹配失败则退回普通 url，交给调用方按 JSON 处理。
    if (parsed && (parsed.hostname === "github.com" || parsed.hostname === "www.github.com")) {
      const match = parsed.pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|\.git|$)/);
      if (match?.[1]) {
        const gitUrl = url.endsWith(".git") ? url : `${url}.git`;
        return ref ? { source: "git", url: gitUrl, ref } : { source: "git", url: gitUrl };
      }
    }
    return { source: "url", url };
  }

  if (isGitSshUrl(trimmed)) {
    const { url, ref } = splitRef(trimmed);
    return ref ? { source: "git", url, ref } : { source: "git", url };
  }

  const resolved = resolvePathInput(trimmed);
  if (resolved) {
    // 存在性检查放在这里而不是加载阶段：解析阶段就能给出「路径不存在」的明确文案，
    // 否则会走到 git/HTTP 分支，用户看到的是与本地路径无关的网络错误。
    if (!existsSync(resolved))
      throw new Error(`Marketplace source path does not exist: ${resolved}`);
    if (fileExists(resolved)) {
      if (!resolved.endsWith(".json")) {
        throw new Error(`Marketplace file must be a .json file: ${resolved}`);
      }
      return { source: "file", path: resolved };
    }
    if (directoryExists(resolved)) return { source: "directory", path: resolved };
    throw new Error(`Marketplace source path is not a file or directory: ${resolved}`);
  }

  if (trimmed.includes("/") && !trimmed.includes(":")) {
    // `owner/repo` 简写只在「不含冒号」时生效：含冒号可能是 Windows 盘符（C:/x）
    // 或 ssh 地址，那两类必须走前面的路径/ssh 分支，否则会被误当成 GitHub 仓库。
    const { url: repo, ref } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo, ref } : { source: "github", repo };
  }

  throw new Error(`Unsupported marketplace source: ${input}`);
}

/** 读取 known_marketplaces.json；兼容数组与 map 两种历史形态，过滤非法记录。 */
// 两种形态都要支持：早期版本写数组，后来为了按 id 查找改成 map。老用户的文件不会自动迁移，
// 只认一种形态会让升级后「所有已添加市场消失」。过滤而不是抛错：单条脏记录不应毁掉整个列表。
export function loadKnownMarketplacesSync(storageRoot: string): KnownMarketplaceRecord[] {
  const parsed = readJsonFileSync(join(storageRoot, KNOWN_MARKETPLACES_FILE));
  if (!isRecord(parsed)) return [];
  const value = parsed.marketplaces;
  if (Array.isArray(value)) return value.filter(isKnownMarketplaceRecord);
  if (isRecord(value)) return Object.values(value).filter(isKnownMarketplaceRecord);
  return [];
}

/**
 * 幂等补齐内置默认市场：按 id 去重，只追加缺失项并同步写回。
 * 副作用：可能写 known_marketplaces.json；已齐全时不写盘。
 */
export function ensureDefaultPluginMarketplaces(storageRoot: string): KnownMarketplaceRecord[] {
  const known = loadKnownMarketplacesSync(storageRoot);
  const existingIds = new Set(known.map((record) => record.id));
  const now = new Date().toISOString();
  // 只补充缺失项，不覆盖已存在的同 id 记录：用户可能已经改过默认市场的显示名或来源，
  // 每次启动都覆盖会让这些修改被静默还原。
  const missing = DEFAULT_PLUGIN_MARKETPLACES.filter(
    (marketplace) => !existingIds.has(marketplace.id),
  ).map(
    (marketplace): KnownMarketplaceRecord => ({
      id: marketplace.id,
      source: defaultMarketplaceSourceFromString(marketplace.source),
      name: marketplace.name,
      description: marketplace.description,
      addedAt: now,
      ...(marketplace.lastUpdated ? { lastUpdated: marketplace.lastUpdated } : {}),
      pluginCount: marketplace.pluginCount,
    }),
  );
  if (missing.length === 0) return known;
  // 只有真的要补才写盘：每次启动都重写会让文件 mtime 变化，触发其它进程的文件监听，
  // 也会在只读磁盘环境里直接抛错、阻断启动。
  const next = [...known, ...missing];
  writeKnownMarketplacesSync(storageRoot, next);
  return next;
}

/**
 * 确保指定市场已有本地 manifest：已存在直接返回记录；缺失则用 known record 的规范 source
 * 做一次受信任懒加载（trustedId=record.id，防止来源冒用官方 id）。未知 id 返回 null。
 */
export async function ensureMarketplaceManifestAvailable(input: {
  marketplace: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord | null> {
  throwIfPluginOperationAborted(input.signal);
  // 每次都先补齐默认市场：本地 manifest 的判定依赖 known record，而新装环境里两者都缺，
  // 顺序反过来会直接返回 null，表现为「官方市场第一次打开是空的」。
  ensureDefaultPluginMarketplaces(input.storageRoot);
  if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) {
    // 已有 manifest 时只回读 known record，不再重新拉取：这是「打开列表」路径，
    // 每次都拉一次远端会把打开插件页变成网络请求。
    return (
      loadKnownMarketplacesSync(input.storageRoot).find(
        (record) => record.id === input.marketplace,
      ) ?? null
    );
  }
  const record = loadKnownMarketplacesSync(input.storageRoot).find(
    (item) => item.id === input.marketplace,
  );
  if (!record) return null;
  // 受信任的内部懒加载：用 known record 的规范 source 拉取，并以 record.id 作为 trustedId，
  // 使官方 id 只能由本来就是该官方 id 的记录刷新得到。
  return await addMarketplace({
    signal: input.signal,
    source: record.source,
    storageRoot: input.storageRoot,
    trustedId: record.id,
  });
}

/**
 * 添加/刷新市场：解析来源（persist:false 先校验，避免用不可信 manifest.name 覆盖官方目录）
 * → trustedId/expectedId 守卫 → 图标增强 → official CDN 分片 → staging 目录 → 写 known state。
 *
 * 事务：marketplace 目录与 known state 使用同一 transactionId；提交前可取消，提交后不可取消。
 * 失败语义：authority 恢复成功则回滚 marketplace 目录；authority 本身失败则 finalize 保留新
 * manifest，避免跨代状态；超时会被转换为 PluginSourceMaterializationError（若可归类）。
 */
export async function addMarketplace(input: {
  expectedId?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
  // 受信任的内部刷新传入正在刷新的 known record 规范 id。守卫只在 manifest 声明了官方 id
  // 且该 id 不等于本次刷新的 trustedId 时拒绝，避免来源在刷新过程中被改名冒用：
  //   - 用户侧新增（trustedId 缺失）声明官方 id → 拒绝；
  //   - 非官方市场日后把 manifest 改名成官方 id，刷新时 trustedId 不匹配 → 拒绝；
  // 非官方 manifest 名不受此约束，保持既有行为。
  trustedId?: string;
}): Promise<KnownMarketplaceRecord> {
  // persist:false 先只解析 manifest，不落盘——否则 marketplace 目录激活会用
  // 不可信 manifest.name 作为 target，先 rm 掉本地官方目录再 cp，等守卫抛错时
  // 官方 manifest 已被污染；守卫通过后才持久化。
  throwIfPluginOperationAborted(input.signal);
  const operationScope = createMarketplaceOperationSignalScope(input.trustedId, input.signal);
  const operationSignal = operationScope.signal;
  let loaded: LoadMarketplaceResult | undefined;
  let knownMarketplaceActivation: KnownMarketplaceActivation | undefined;
  let marketplaceActivation: AtomicDirectoryActivation | undefined;
  try {
    // Claude 官方目录与图标映射并行获取；图标只是展示增强，失败时会回退本地缓存或空映射。
    const iconSourcesPromise =
      input.trustedId === CLAUDE_OFFICIAL_MARKETPLACE
        ? loadClaudePluginIconSources(input.storageRoot, operationSignal)
        : null;
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: operationSignal,
    });
    throwIfPluginOperationAborted(operationSignal);
    if (isOfficialMarketplaceId(loaded.manifest.name) && loaded.manifest.name !== input.trustedId) {
      throw new Error(
        `Cannot add a marketplace named "${loaded.manifest.name}": that id is reserved for the official marketplace.`,
      );
    }
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      throw new Error(
        `Marketplace declaration id mismatch: expected ${input.expectedId}, received ${loaded.manifest.name}`,
      );
    }
    if (
      input.trustedId === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      loaded.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
    ) {
      throw new Error(
        `Official marketplace source must provide ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}, received ${loaded.manifest.name}`,
      );
    }
    const iconSources = iconSourcesPromise ? await iconSourcesPromise : new Map<string, string>();
    // 图标只做展示增强：即使 iconSources 为空也继续走主流程，不能因为图标缺失拒绝安装。
    // 但对 Claude 市场要重解析一遍 enrichedRaw：图标字段会被写进 manifest，
    // 必须重新过校验，避免远端图标路径把非法字符带进本地索引。
    const enrichedRaw =
      loaded.manifest.name === CLAUDE_OFFICIAL_MARKETPLACE
        ? applyClaudePluginIcons(loaded.manifest.raw, iconSources)
        : loaded.manifest.raw;
    const enrichedManifest = parseRequiredMarketplaceManifest(enrichedRaw);
    // 官方市场的 manifest 额外写一份 CDN 分片：分片是给 Web 端读取的只读投影，
    // 必须在写 known state 之前完成，否则 known 已经指向新代际、分片却还是旧的。
    // 写分片用 raw 而非 enriched 版本：分片需要的是市场原始内容，图标由各端自行补。
    const persistedManifest =
      loaded.manifest.name === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE
        ? parseRequiredMarketplaceManifest(
            writeCdnOfficialMarketplacePartitionSync({
              manifest: loaded.manifest.raw,
              storageRoot: input.storageRoot,
            }),
          )
        : enrichedManifest;
    // 修复原因：旧流程先删 marketplace target 再复制 source，刷新失败会丢失最后成功快照。
    // source tree 与规范 manifest 在同一 staging 目录准备完毕后一次 rename 激活。
    if (loaded.sourceRoot) {
      // 有 sourceRoot 说明来源是一个完整目录树：需要把插件包本体一起搬进来，
      // 只写 manifest 会让插件「列表可见但无法安装」。stage* 只准备不提交，
      // 真正生效依赖下面的 finalize（INV-11）。
      marketplaceActivation = await stageMarketplaceDirectoryPlugins(
        loaded.sourceRoot,
        input.storageRoot,
        loaded.manifest.name,
        persistedManifest.raw,
        operationSignal,
      );
    } else if (loaded.manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
      marketplaceActivation = await stageMarketplaceManifest(
        input.storageRoot,
        loaded.manifest.name,
        enrichedRaw,
        operationSignal,
      );
    }
    throwIfPluginOperationAborted(operationSignal);
    const now = new Date().toISOString();
    // pluginCount 取 persistedManifest（已过滤非法条目）而不是 raw 的 plugins.length：
    // 否则列表里会被算进「解析阶段已经丢弃」的条目，UI 显示的数量与实际可安装数不一致。
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      source: input.source,
      name: loaded.manifest.name,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: now,
      lastUpdated: now,
      pluginCount: persistedManifest.plugins.length,
      ...(marketplaceActivation ? { cacheTransactionId: marketplaceActivation.transactionId } : {}),
    };
    knownMarketplaceActivation = await upsertKnownMarketplace(input.storageRoot, record);
    if (marketplaceActivation) {
      // 写 known state 之后再做最后一次取消检查，且只在「还有目录事务要提交」时检查：
      // 此时 known 已指向新代际，若直接抛错，catch 会回滚 known（authority），
      // 而目录事务尚未 finalize —— 两条路径仍保持同一代际（INV-1/INV-9）。
      throwIfPluginOperationAborted(operationSignal);
    }
    // authority state 已落盘且 deadline 检查通过后才进入不可取消的提交尾声；
    // 先解除 timer，再清理 backup/marker，避免清理耗时把已提交事务反判成超时。
    operationScope.cleanup();
    await marketplaceActivation?.finalize();
    knownMarketplaceActivation.finalize();
    return record;
  } catch (error) {
    let rollbackError: unknown;
    // 先回滚 authority（known state），再决定目录是回滚还是 finalize：
    // authority 是「谁指向哪个代际」的唯一事实源，它恢复不了时目录必须保留新的，
    // 否则会留下「known 指向旧代际、目录是新代际」的跨代状态（INV-9）。
    try {
      await knownMarketplaceActivation?.rollback();
    } catch (currentRollbackError) {
      rollbackError = currentRollbackError;
    }
    try {
      if (rollbackError === undefined) {
        await marketplaceActivation?.rollback();
      } else {
        // authority 无法恢复时保留其指向的新 manifest，避免再次制造跨代状态。
        await marketplaceActivation?.finalize();
      }
    } catch (currentRollbackError) {
      rollbackError =
        rollbackError === undefined
          ? currentRollbackError
          : appendPluginSourceCleanupError(currentRollbackError, rollbackError);
    }
    const operationError = operationScope.timedOut
      ? (() => {
          // 超时要把原始错误「归类」成可展示的诊断：直接抛 timeoutError 会丢失
          // 「是 clone 失败还是下载失败」的信息。归类失败才退回裸超时错误。
          const sourceDiagnosticCode = getPluginSourceDiagnosticCode(error);
          return sourceDiagnosticCode
            ? new PluginSourceMaterializationError(
                sourceDiagnosticCode,
                operationScope.timeoutError.message,
              )
            : operationScope.timeoutError;
        })()
      : error;
    throw appendPluginSourceCleanupError(operationError, rollbackError);
  } finally {
    // [资源] 两处清理都要执行：source cleanup 释放 clone/解压的临时目录，
    // operationScope.cleanup 释放 timer 与监听器。cleanup 是 best-effort，
    // 失败只追加诊断 —— 不能让清理失败覆盖上面已经构造好的主错误（INV-10）。
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
    operationScope.cleanup();
  }
}

/** 解析图标映射：name/icon 必须通过名称与安全相对路径校验，可选 mimeType/sha256 也需合法。 */
export function parsePluginIconSources(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  // 非数组直接返回空映射：图标清单来自远端，格式随时可能变；这里宁可「没有图标」
  // 也不能抛错，否则整个市场加载会因一个展示字段失败。
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    // 逐条 continue 而不是整体 reject：一条脏数据不应让其余几十个图标全部失效。
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const icon = typeof item.icon === "string" ? item.icon.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const sha256 = typeof item.sha256 === "string" ? item.sha256 : undefined;
    if (!PLUGIN_NAME_PATTERN.test(name) || !isSafePluginIconPath(icon)) continue;
    // mimeType 只接受 image/png：其它类型需要额外的解码器，而图标是 <img> 直接加载的，
    // 放过 svg 会引入脚本执行面。
    if (mimeType !== undefined && mimeType !== "image/png") continue;
    // sha256 格式不合法就整条丢弃，而不是忽略校验和：校验和存在却无法验证，
    // 等于给了「已校验」的假象。
    if (sha256 !== undefined && !SOURCE_SHA256_PATTERN.test(sha256)) continue;
    // 用 new URL(icon, base) 解析成绝对地址：相对路径若直接拼字符串，遇到 `../` 会跳出 CDN 目录。
    // isSafePluginIconPath 已先否决含 `..` 的写法，两步一起才构成完整的路径约束。
    result.set(name, new URL(icon, PLUGIN_ICON_ASSETS_BASE_URL).href);
  }
  return result;
}

/** 给缺少 icon 的条目补图标；已有 icon 的条目不动。无变化时返回原对象（引用相等用于跳过写盘）。 */
export function applyClaudePluginIcons(
  manifest: Record<string, unknown>,
  iconByPluginName: ReadonlyMap<string, string>,
): Record<string, unknown> {
  // 空映射或无 plugins 时直接返回原对象：调用方用引用相等判断「是否需要写盘」，
  // 这里若返回新对象会让每次启动都重写 manifest（见 enrichCachedClaudeMarketplaceIcons）。
  if (!Array.isArray(manifest.plugins) || iconByPluginName.size === 0) return manifest;
  let changed = false;
  const plugins = manifest.plugins.map((plugin) => {
    // 已有非空 icon 的条目不覆盖：市场作者显式给的图标优先级高于 CDN 兜底清单，
    // 覆盖会让自定义图标「升级后突然变了」。
    if (!isRecord(plugin) || typeof plugin.name !== "string") return plugin;
    if (typeof plugin.icon === "string" && plugin.icon.trim().length > 0) return plugin;
    const icon = iconByPluginName.get(plugin.name);
    if (!icon) return plugin;
    changed = true;
    return { ...plugin, icon };
  });
  return changed ? { ...manifest, plugins } : manifest;
}

/**
 * 一次性为已缓存的 Claude 官方市场回填图标：进程内去重（每个 storageRoot 只尝试一次）。
 * 网络请求不持写入锁；拿到锁后重读 manifest 再写，避免覆盖并发更新。
 * 失败为 best-effort 静默（下次启动可重试），不影响 overview。
 */
export async function enrichCachedClaudeMarketplaceIcons(
  storageRoot: string,
  withWriteLock: (write: () => Promise<void>) => Promise<void> = (write) => write(),
): Promise<void> {
  const attemptKey = resolve(storageRoot);
  // 进程内去重放在「读 manifest」之前：这是启动热路径，若每次都读盘再判断，
  // 已经回填过的环境仍会产生一次同步 IO。用 resolve 后的路径归一，避免同一目录的两种写法绕过去重。
  if (claudeIconMigrationAttempts.has(attemptKey)) return;
  claudeIconMigrationAttempts.add(attemptKey);

  const manifest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
  if (!manifest) return;
  try {
    const iconSources = await loadClaudePluginIconSources(storageRoot);
    await withWriteLock(async () => {
      // 网络请求期间不持 plugin storage 锁；获得锁后必须重读，避免覆盖并发 marketplace 更新。
      const latest = loadMarketplaceManifestSync(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE);
      if (!latest) return;
      const enriched = applyClaudePluginIcons(latest.raw, iconSources);
      // 引用相等即「无变化」：applyClaudePluginIcons 在无需修改时返回原对象，
      // 这里跳过写盘可避免每次启动都把 manifest 的 mtime 改掉，触发无谓的缓存失效。
      if (enriched === latest.raw) return;
      // Bugfix：升级前已有 lastUpdated 的 catalog 不会触发 UI 自动刷新，导致新图标功能永远不可见。
      // 这里只回写展示增强字段，不重拉 marketplace，也不改变更新检测时间。
      await writeMarketplaceManifest(storageRoot, CLAUDE_OFFICIAL_MARKETPLACE, enriched);
    });
  } catch {
    // 存量图标迁移是 best-effort；失败不能让 plugins/overview 不可用，下次 Agent 启动可重试。
  }
}

/** 图标相对路径安全校验：必须是 .png、无盘符/反斜杠/绝对前缀，每段满足插件名模式。 */
function isSafePluginIconPath(icon: string): boolean {
  // 四类拒绝各自对应一种攻击面：绝对路径/盘符、反斜杠（Windows 分隔符绕过）、
  // 非 png（内容类型伪装）、以及段数不足（不接受当前目录下的裸文件名）。
  // 每段复用插件名模式，等价于禁止 `..`、空段与隐藏文件。
  if (!icon.endsWith(".png") || icon.startsWith("/") || icon.includes("\\")) return false;
  const segments = icon.split("/");
  return segments.length >= 2 && segments.every((segment) => PLUGIN_NAME_PATTERN.test(segment));
}

/**
 * 拉取官方图标清单（10s 超时）：成功则净化后写缓存并返回；失败/为空回退本地缓存。
 * 缓存只保留 name/icon/mimeType，不落盘素材源及其 provenance。
 */
async function loadClaudePluginIconSources(
  storageRoot: string,
  operationSignal?: AbortSignal,
): Promise<Map<string, string>> {
  const cachePath = join(storageRoot, PLUGIN_ICON_SOURCES_FILE);
  const cached = (): Map<string, string> => parsePluginIconSources(readJsonFileSync(cachePath));
  // 独立的 controller 而不是复用 operationSignal：图标请求有自己更短的 10s 上限，
  // 且它的失败不应把整个市场刷新 abort 掉。只把外部的 abort 事件「转发」进来。
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  operationSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 10_000);
  try {
    const response = await requestMarketplaceJson(
      PLUGIN_ICON_SOURCES_URL,
      undefined,
      controller.signal,
      10_000,
    );
    const value = response;
    const parsed = parsePluginIconSources(value);
    // 空结果回退本地缓存：远端返回空数组通常意味着清单还在发布中，
    // 直接用空会把用户已有的图标全部抹掉（展示回退，不是数据回退）。
    if (parsed.size === 0) return cached();
    // 缓存只保留产品需要的字段，不落盘素材源机器路径等 provenance 信息。
    const sanitized: PluginIconSourceRecord[] = [...parsed.entries()].map(([name, iconUrl]) => ({
      name,
      icon: new URL(iconUrl).pathname.slice(new URL(PLUGIN_ICON_ASSETS_BASE_URL).pathname.length),
      mimeType: "image/png",
    }));
    try {
      await writeJsonFile(cachePath, sanitized);
    } catch {
      // 图标缓存写入失败不影响本次 marketplace 主数据刷新。
      // 这里必须吞掉异常：缓存只是加速下一次启动，写失败最多让下次多一次网络请求，
      // 若向上抛，调用方会把整次「添加市场」判为失败。
    }
    return parsed;
  } catch {
    // 网络/解析/超时统统回退本地缓存：图标是展示增强，任何失败都不应阻断市场刷新。
    return cached();
  } finally {
    // [资源] timer 与外层监听器都要清：本函数每次加载 Claude 市场都会调用，
    // 不清会让长驻的 operationSignal 上不断累积 listener。
    clearTimeout(timeout);
    operationSignal?.removeEventListener("abort", abort);
  }
}

/**
 * 手动跟随最多 5 次重定向请求市场 JSON（10MB/可配置超时，经统一 HttpClient）。
 * 跨 origin 重定向时丢弃自定义 header（避免凭据泄露给 CDN）；非 2xx 抛错；返回解析后的 JSON。
 */
async function requestMarketplaceJson(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = MARKETPLACE_JSON_TIMEOUT_MS,
): Promise<unknown> {
  const client = createNodeWebFetchHttpClientAdapter({
    env: process.env,
    // maxResponseBytes 在客户端层生效，而不是读完再判断长度：后者需要先把整个响应读进内存，
    // 恶意/异常源可以直接打爆进程（INV 的防护边界见 MARKETPLACE_JSON_MAX_BYTES 的说明）。
    maxResponseBytes: MARKETPLACE_JSON_MAX_BYTES,
    timeoutMs,
  });
  let currentHeaders = headers;
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MARKETPLACE_JSON_MAX_REDIRECTS; redirectCount += 1) {
    // redirect: "manual" 是必须的：手动跟随才能在下一次请求前判断 origin 并清 header，
    // 交给底层自动跟随会把 Authorization 一路带到第三方 CDN。
    const response = await client.request(
      {
        ...(currentHeaders ? { headers: currentHeaders } : {}),
        method: "GET",
        redirect: "manual",
        url: currentUrl,
      },
      { signal },
    );
    if (isMarketplaceJsonRedirectStatus(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new Error(`Marketplace redirect is missing Location header: ${currentUrl}`);
      }
      const redirectUrl = new URL(location, currentUrl);
      // 代理/自定义 CA 分支的 http.request 不会执行 redirect:follow；
      // 这里统一有界跟随，并在跨 origin 时清理市场自定义 header，避免凭据泄露给 CDN。
      // 用「相对当前 URL」解析 Location：直接 new URL(location) 在相对地址时会抛错。
      if (redirectUrl.origin !== new URL(currentUrl).origin) {
        currentHeaders = undefined;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      // 非 2xx 一律抛错，不尝试解析 body：错误页通常是 HTML，
      // 解析后的错误信息会变成「Unexpected token <」，对用户毫无意义。
      throw new Error(`Failed to fetch marketplace: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  }
  throw new Error(`Marketplace fetch exceeded redirect limit: ${url}`);
}

/** 可跟随的市场 JSON 重定向状态码：301/302/303/307/308。 */
function isMarketplaceJsonRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 刷新一个或全部已知市场（默认全量），逐个用其规范 source 受信任重拉。
 *
 * 失败语义：单个市场失败只持久化 lastRefreshFailure，不中断其他市场；用户取消（signal.aborted）
 * 直接抛出且不写失败状态，避免把取消误报成市场故障。
 * 返回本次成功刷新的记录列表。
 */
export async function updateMarketplace(input: {
  marketplace?: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord[]> {
  ensureDefaultPluginMarketplaces(input.storageRoot);
  const known = loadKnownMarketplacesSync(input.storageRoot);
  // selected 保留 known 的顺序：UI 按返回顺序展示刷新结果，重排会让列表在每次刷新后跳动。
  const selected = input.marketplace
    ? known.filter((record) => record.id === input.marketplace)
    : known;
  if (input.marketplace && selected.length === 0) {
    throw new Error(`Marketplace not found: ${input.marketplace}`);
  }
  const updated: KnownMarketplaceRecord[] = [];
  for (const record of selected) {
    // 每轮开始都检查取消：全量刷新可能串行处理十几个市场，用户取消后应立即停止，
    // 而不是等当前这个市场跑完 180s 超时。
    throwIfPluginOperationAborted(input.signal);

    // 受信任的刷新会重新拉取已知 marketplace 自带的 source；record.id 作为 trustedId，
    // 使官方 id 只能由原本就是该 id 的记录刷新得到。
    try {
      updated.push(
        await addMarketplace({
          signal: input.signal,
          source: record.source,
          storageRoot: input.storageRoot,
          trustedId: record.id,
        }),
      );
    } catch (error) {
      // 取消是当前 operation 的控制流，不是 Marketplace 健康状态；不得把 AbortError
      // 持久化成 refresh failure，避免后续普通商店页面误报官方源故障。
      if (input.signal?.aborted) throw error;
      // 失败只写诊断、不中断循环：某个市场挂掉不能让其它市场也刷新不了（INV-8 的反面）。
      // toValidationDiagnostic 负责把任意错误收敛成可展示的诊断码，避免把栈写进状态文件。
      const diagnostic = toValidationDiagnostic(error, record.id);
      await persistMarketplaceRefreshFailure(input.storageRoot, record.id, {
        code: diagnostic.code,
        failedAt: new Date().toISOString(),
        message: diagnostic.message,
      });
    }
  }
  return updated;
}

/** 从 known_marketplaces.json 移除指定市场；只改注册表，不删除已安装插件缓存。 */
// 只改注册表是刻意的：用户移除市场后，已安装的插件仍应可用（否则会出现「插件还在跑但找不到来源」）。
// 缓存的清理交给 uninstall，两者生命周期不同，不能在这里顺手 rm。
export async function removeMarketplace(input: {
  marketplace: string;
  storageRoot: string;
}): Promise<void> {
  const known = loadKnownMarketplacesSync(input.storageRoot).filter(
    (record) => record.id !== input.marketplace,
  );
  await writeKnownMarketplaces(input.storageRoot, known);
}

/**
 * 读取市场 manifest：先对 marketplaces/<id> 目录做崩溃恢复，若 writer 仍活跃则读取其
 * 已提交代（backup 或新 target），避免 UI 看到跨代 manifest。文件缺失/非法返回 null。
 */
export function loadMarketplaceManifestSync(
  storageRoot: string,
  marketplace: string,
): PluginMarketplaceManifest | null {
  const manifestPath = getMarketplaceManifestPath(storageRoot, marketplace);
  // 崩溃残留先恢复；若 writer 仍活跃，则在权威 known state 落盘前读 backup，
  // 落盘后读新 target，避免 overview 看见跨代 manifest/summary。
  // 注意这里读的是 readableDirectory 而不是 manifestPath 的目录：恢复会返回一个「可读代」，
  // 直接按原路径读会读到正在被替换的目录（INV-1 的读侧对应规则）。
  const readableDirectory = recoverAtomicTargetSync(dirname(manifestPath));
  const parsed = readJsonFileSync(join(readableDirectory, basename(manifestPath)));
  return parseMarketplaceManifest(parsed);
}

/** 读取 installed_plugins.json 并归一化（兼容 map/数组两种历史形态）；文件损坏返回空状态。 */
export function loadInstalledPluginsSync(storageRoot: string): InstalledPluginsState {
  const parsed = readJsonFileSync(join(storageRoot, INSTALLED_PLUGINS_FILE));
  return normalizeInstalledPluginsState(parsed);
}

/** 原子写入 installed_plugins.json（先写临时文件再 rename，避免半写状态）。 */
// 必须走 writeJsonFile 的临时文件+rename，而不是直接 writeFile：
// 进程在写一半时被杀会留下截断的 JSON，下一次启动会读成「零安装」，用户所有插件凭空消失。
export async function saveInstalledPlugins(
  storageRoot: string,
  state: InstalledPluginsState,
): Promise<void> {
  await writeJsonFile(join(storageRoot, INSTALLED_PLUGINS_FILE), state);
}

/** 列出已安装插件记录（不含状态 wrapper）。 */
export function listInstalledPluginRecords(storageRoot: string): InstalledPluginRecord[] {
  return loadInstalledPluginsSync(storageRoot).plugins;
}

/**
 * 解析已安装插件的实际读取根：优先记录里的 installPath，缺失时按 cache 约定推算；
 * 最终经 recoverAtomicTargetSync 处理崩溃残留，保证返回可读目录。
 */
export function resolveInstalledPluginRoot(
  storageRoot: string,
  record: InstalledPluginRecord,
): string {
  const root =
    record.installPath ||
    // 回退到约定路径只用于老记录（早期版本没写 installPath）。新记录必须以 installPath 为准，
    // 因为版本升级后约定路径会随 version 变化，按约定推算会指向不存在的目录（见字段注释）。
    getPluginCacheDir(storageRoot, record.marketplace, record.name, record.version);
  return recoverAtomicTargetSync(root);
}

/**
 * 安装市场插件：确保 manifest → 计算依赖闭包 → 逐个物化到 cache（原子激活）→ 写 state。
 *
 * 副作用：clone/下载/解压插件源、创建 cache 目录、写 installed_plugins.json。
 * 失败语义：任一插件失败按逆序回滚已激活目录，清理错误追加到原错误；state 写入失败同样回滚。
 * 成功后统一 finalize 所有 activation。
 */
export async function installMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  signal?: AbortSignal;
  storageRoot: string;
  scope?: "user" | "workspace";
  allowCrossMarketplaces?: ReadonlySet<string>;
}): Promise<MarketplaceInstallResult> {
  await ensureMarketplaceManifestAvailable({
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  throwIfPluginOperationAborted(input.signal);
  const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  // 闭包在动任何磁盘之前算完：如果闭包里有环或缺依赖，应在「零副作用」阶段就失败，
  // 而不是装到一半才发现，再走一遍回滚。
  const closure = resolveDependencyClosure({
    allowCrossMarketplaces:
      input.allowCrossMarketplaces ??
      new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });
  const state = loadInstalledPluginsSync(input.storageRoot);
  const installed: InstalledPluginRecord[] = [];
  const activations: AtomicDirectoryActivation[] = [];
  try {
    for (const pluginId of closure) {
      const { marketplace, name } = parsePluginId(pluginId);
      const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
      if (!manifest) throw new Error(`Marketplace not found: ${marketplace}`);
      const entry = manifest.plugins.find((plugin) => plugin.name === name);
      if (!entry) throw new Error(`Plugin not found: ${pluginId}`);
      const cached = await cacheMarketplacePlugin({
        entry,
        marketplace,
        signal: input.signal,
        scope: input.scope ?? "user",
        state,
        storageRoot: input.storageRoot,
      });
      installed.push(cached.record);
      // activation 可能为空（同一版本已装过、无需换目录）：只有真正新建了目录的才需要 finalize/rollback，
      // 对空值调用会把「复用的旧目录」也纳入回滚范围，失败时删掉用户已有的安装。
      if (cached.activation) activations.push(cached.activation);
    }
    throwIfPluginOperationAborted(input.signal);
    // state 必须在所有目录都 stage 成功之后才写：先写 state 再物化，
    // 中途失败会留下「state 说有安装、磁盘没有」的不一致（INV-7/INV-11）。
    await saveInstalledPlugins(input.storageRoot, state);
  } catch (error) {
    let rollbackError: unknown;
    // 逆序回滚：后装的可能依赖先装的，反向释放才能保证依赖仍然完整地存在到最后一步。
    for (const activation of activations.reverse()) {
      try {
        await activation.rollback();
      } catch (currentRollbackError) {
        rollbackError ??= currentRollbackError;
      }
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  }
  for (const activation of activations) await activation.finalize();
  // finalize 放在 try 之外：走到这里说明 state 已落盘，提交失败已无法回滚，
  // 再套 try 只会把提交错误伪装成安装失败，让 UI 提示「安装失败」但实际已装好。
  return { closure, installed };
}

/**
 * 卸载插件：从 state 移除记录；removeCache=true 时删缓存目录，默认同时删 data/<id> 用户数据，
 * keepData=true 可保留数据目录。记录不存在返回 null（幂等）。
 */
export async function uninstallMarketplacePlugin(input: {
  pluginId: string;
  storageRoot: string;
  removeCache?: boolean;
  /** `zcode plugins uninstall --keep-data`：删安装缓存但保留 data/<plugin-id> 用户数据目录。 */
  keepData?: boolean;
}): Promise<InstalledPluginRecord | null> {
  const state = loadInstalledPluginsSync(input.storageRoot);
  const index = state.plugins.findIndex((record) => record.id === input.pluginId);
  // 记录不存在返回 null 而不是抛错：卸载是幂等操作，重复点击/并发调用都应成功。
  // 但这里只按 id 找，记录来自当前 storageRoot 的 state，scope 由 state 自身区分（见 INV-4）。
  if (index < 0) return null;
  const [removed] = state.plugins.splice(index, 1);
  // 先写 state 再删目录：反过来若删目录后写 state 失败，会留下指向空目录的安装记录，
  // 用户看到「已安装」但插件加载失败。
  await saveInstalledPlugins(input.storageRoot, state);
  if (removed && input.removeCache === true) {
    await rm(removed.installPath, { force: true, recursive: true });
    // 彻底卸载：data/<plugin-id> 是持久化的 per-plugin 目录（含 materialize 的 generated-commands）。
    // 按「卸载最后一份安装时一并删除」语义，保证重装是干净的。

    if (input.keepData !== true) {
      await rm(getPluginDataDir(input.storageRoot, removed.id), { force: true, recursive: true });
    }
  }
  return removed ?? null;
}

/**
 * 校验单个市场插件：市场/条目存在性 → 依赖诊断 → 解析源根 → manifest/MCP 校验。
 * 所有失败都转为结构化诊断返回（不抛出）；临时源目录在 finally 清理。
 */
export async function validateMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  try {
    // 校验前先确保 manifest 就绪：否则「市场存在但从未拉取」会被误报成 plugin_not_found，
    // 用户会以为插件被删了，实际只是本地没缓存。
    await ensureMarketplaceManifestAvailable({
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
    return diagnostics;
  }
  const manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }
  const plugin = manifest.plugins.find((entry) => entry.name === input.name);
  if (!plugin) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${input.name}@${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return diagnostics;
  }

  pushDependencyDiagnostics({
    diagnostics,
    // 依赖诊断只收集、不早退：用户需要一次看到「缺哪个依赖 + manifest 有什么问题」，
    // 分两次运行才发现下一个错误会让修复体验变成猜谜。
    marketplace: input.marketplace,
    name: input.name,
    storageRoot: input.storageRoot,
  });

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry: plugin,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    diagnostics.push(
      ...validatePluginRoot({
        entry: plugin,
        marketplace: input.marketplace,
        rootPath: resolved.path,
        storageRoot: input.storageRoot,
      }),
    );
  } catch (error) {
    // 源解析失败（网络/解压/路径）也必须转成诊断返回，而不是抛给上层：
    // 校验接口的契约是「永远返回诊断列表」，UI 依赖它一次性渲染所有问题。
    diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  } finally {
    // [资源] 解析可能产生临时 clone 目录，必须在这里释放；即使是校验（不安装）也不能漏，
    // 否则用户反复点「详情」会把临时目录堆满磁盘（INV-10）。
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
  return diagnostics;
}

/**
 * 按需枚举单个插件的组件「名称 + 描述」，供 marketplace 详情 UI 使用。
 * - 已安装插件：直接读本地缓存/安装目录，无需联网。
 * - 未安装候选：解析并按需临时 clone 插件源（finally 清理临时目录），参照 validateMarketplacePlugin。
 * 组件名称与描述来自组件目录的 frontmatter（command/agent 的 .md、skill 的 SKILL.md）、
 * 以及 manifest（hooks 事件名、mcpServers 名称、object 形式声明的 commands/agents）。
 * 任何一类组件读取失败都降级为「能拿到多少返回多少」+ 诊断，不抛断整个详情。
 *
 * 副作用：未安装候选会临时 clone/下载源（finally 清理）；manifest 缺失时才进写锁懒加载。
 * 失败语义：市场/插件不存在返回空组件 + 诊断；组件读取失败不影响其余分组。
 * 不变量：已安装优先读本地目录（离线可用）；诊断不阻断返回。
 */
export async function describeMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
  /** 只包住会写 known/manifest 的懒加载分支；其余只读路径不进锁。 */
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}): Promise<DescribeMarketplacePluginResult> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.name}@${input.marketplace}`;

  // 已安装优先：本地目录无需 clone，速度快且离线可用。
  // 这也是唯一能保证「详情页展示的组件 == 实际运行的组件」的路径：
  // 走市场条目解析拿到的是最新版本（entry.version），可能与用户当前安装的版本不一致。
  const installedRecord = loadInstalledPluginsSync(input.storageRoot).plugins.find(
    (record) => record.marketplace === input.marketplace && record.name === input.name,
  );
  if (installedRecord) {
    const rootPath = resolveInstalledPluginRoot(input.storageRoot, installedRecord);
    if (directoryExists(rootPath)) {
      const read = readComponentsAtRoot({
        diagnostics,
        marketplace: input.marketplace,
        // 已安装路径不传 entry：此时以本地 plugin.json 为唯一事实源，
        // 混入市场条目会让「本地版本没有的组件」也出现在详情里。
        rootPath,
      });
      return {
        components: read.components,
        diagnostics,
        ...(read.metadata ? { metadata: read.metadata } : {}),
      };
    }
    // 安装记录存在但缓存缺失（被清理）——继续走源解析兜底，而不是直接报错。
  }

  let manifest: PluginMarketplaceManifest | null = null;
  try {
    manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    if (!manifest) {
      // Bugfix：describe 曾整体持 storage lock，安装下载期间所有详情都排在锁后。
      // 只有 manifest 缺失时才写 known/manifest，此时必须与安装、市场刷新串行。
      const withWriteLock = input.withWriteLock ?? ((write) => write());
      await withWriteLock(() =>
        ensureMarketplaceManifestAvailable({
          marketplace: input.marketplace,
          storageRoot: input.storageRoot,
        }),
      );
      manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  }
  if (!manifest) {
    // 没有 manifest 说明这个市场从未成功拉取过；这里返回 error 而不是空组件，
    // 否则 UI 会展示一个「存在但什么都没有」的详情页，用户无法判断是插件问题还是市场问题。
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }
  const entry = manifest.plugins.find((candidate) => candidate.name === input.name);
  if (!entry) {
    // 条目缺失与「市场缺失」用不同的 code：前者是 plugin_not_found（用户可换市场找），
    // 后者是 marketplace_invalid（用户需要重新添加市场），混用会让排障建议指错方向。
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${pluginId}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    const read = readComponentsAtRoot({
      diagnostics,
      entry,
      marketplace: input.marketplace,
      rootPath: resolved.path,
    });
    return {
      components: read.components,
      diagnostics,
      ...(read.metadata ? { metadata: read.metadata } : {}),
    };
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
}

/** 读插件根目录的 manifest（失败按 null 降级），再交给纯枚举器列出组件名称+描述。 */
// 无 manifest 时仍按默认目录约定扫描；strict:false 条目会合成 manifest。
// 输入 rootPath/marketplace/entry/storageRoot；输出按类型分组的名称+描述，失败降级不抛出。
function readComponentsAtRoot(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry?: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
}): { components: PluginComponentGroup[]; metadata?: PluginManifestDisplayMetadata } {
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(
      input.rootPath,
      input.entry ?? { name: "__describe__", raw: {} },
    );
  } catch {
    // manifest 解析失败不致命：仍可按默认目录约定扫描组件。
    loadedManifest = null;
  }
  const loaded = loadedManifest
    ? {
        id: `${loadedManifest.manifest.name}@${input.marketplace}`,
        manifest: loadedManifest.manifest,
        manifestPath: loadedManifest.manifestPath ?? input.rootPath,
        marketplace: input.marketplace,
        rootPath: input.rootPath,
        source: "cache" as const,
      }
    : undefined;
  const components = enumeratePluginComponents(input.rootPath, loadedManifest?.manifest ?? null, {
    diagnostics: input.diagnostics as PluginDiagnostic[],
    ...(loaded ? { loaded } : {}),
  });
  const metadata = loadedManifest ? toManifestDisplayMetadata(loadedManifest.manifest) : undefined;
  return { components, ...(metadata ? { metadata } : {}) };
}

/** 抽取 plugin.json 里可展示的回退字段；一个都没有时返回 undefined。 */
// 口径：author 兼容 string 与 {name,url}；homepage/version 仅取非空字符串。
function toManifestDisplayMetadata(
  manifest: PluginManifest,
): PluginManifestDisplayMetadata | undefined {
  const author = normalizeAuthorValue(manifest.author);
  const homepage =
    typeof manifest.homepage === "string" && manifest.homepage.trim().length > 0
      ? manifest.homepage
      : undefined;
  const metadata: PluginManifestDisplayMetadata = {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * 市场级 dry-run 校验：按来源解析 manifest（persist:false 不落盘），校验条目形状/依赖/
 * 可解析性。远端 git 源默认延迟到单插件安装时再 clone（返回 plugin_validation_deferred）。
 * 所有异常都转为诊断；临时源目录在 finally 清理。
 */
export async function validateMarketplaceSource(input: {
  expectedId?: string;
  pluginName?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  let loaded: LoadMarketplaceResult | null = null;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: input.signal,
    });
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      // id 不符时立即返回：后续所有诊断都基于「这是目标市场」这一前提，
      // 继续校验只会给出一堆与用户输入无关的错误，反而掩盖真正原因（INV-5 的校验侧）。
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message:
          `Marketplace declaration id mismatch: expected ${input.expectedId}, ` +
          `received ${loaded.manifest.name}`,
        pluginId: input.expectedId,
        severity: "error",
      });
      return diagnostics;
    }
    if (loaded.manifest.plugins.length === 0) {
      // 空市场只是 warning：技术上可以添加，用户可能还没往里发布插件。
      // 升成 error 会让「先建市场、后补内容」的正常流程被拒之门外。
      diagnostics.push({
        code: "plugin_marketplace_invalid",
        message: `Marketplace has no plugins: ${loaded.manifest.name}`,
        severity: "warning",
      });
    }
    const entries = input.pluginName
      ? loaded.manifest.plugins.filter((entry) => entry.name === input.pluginName)
      : loaded.manifest.plugins;
    if (input.pluginName && entries.length === 0) {
      diagnostics.push({
        code: "plugin_not_found",
        message: `Plugin not found: ${input.pluginName}@${loaded.manifest.name}`,
        pluginId: `${input.pluginName}@${loaded.manifest.name}`,
        severity: "error",
      });
      return diagnostics;
    }
    for (const entry of entries) {
      diagnostics.push(
        ...validateMarketplaceEntryShape(entry, loaded.manifest.name, {
          includeEntryCompatibility: false,
        }),
      );
      pushDependencyDiagnosticsFromManifest({
        diagnostics,
        manifest: loaded.manifest,
        marketplace: loaded.manifest.name,
        name: entry.name,
        storageRoot: input.storageRoot,
      });
      const deferred = getMarketplaceSourceValidationDeferral(entry, loaded.manifest.name);
      if (deferred) {
        // 远端 git 源在这一步只做「形状校验 + 延迟安装」：dry-run 校验若也 clone，
        // 添加一个含 50 个插件的市场会串行下载 50 次仓库。
        // 能力风险诊断仍然要出，因为它只依赖 entry 原文，不需要下载。
        diagnostics.push(deferred);
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
        continue;
      }
      let resolved: ResolvedPluginSourceRoot | null = null;
      try {
        resolved = await resolvePluginSourceRoot({
          entry,
          marketplace: loaded.manifest.name,
          manifest: loaded.manifest,
          signal: input.signal,
          sourceRoot: loaded.sourceRoot,
          storageRoot: input.storageRoot,
        });
        diagnostics.push(
          ...validatePluginRoot({
            entry,
            marketplace: loaded.manifest.name,
            rootPath: resolved.path,
            storageRoot: input.storageRoot,
          }),
        );
      } catch (error) {
        diagnostics.push(toValidationDiagnostic(error, `${entry.name}@${loaded.manifest.name}`));
        // validate source 是 dry-run, 但也必须给 UI 展示 marketplace 条目里声明的能力风险。
        // 当远端/相对 plugin source 暂时不可解析时, 仍基于 entry 原文输出 diagnostic-only 能力诊断。
        pushEntryCompatibilityDiagnostics({
          diagnostics,
          entry,
          marketplace: loaded.manifest.name,
        });
      } finally {
        await cleanupPluginSourceBestEffort(resolved?.cleanup);
      }
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error));
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
  return diagnostics;
}

/**
 * 校验本地插件或 marketplace 路径，只读解析 manifest 并返回结构化诊断，不写入 storage。
 * 输入可以是目录或 manifest 文件；目录按 marketplace 优先、插件根目录其次的顺序识别。
 *
 * 副作用：只读解析，不写入 storage；本地目录无市场条目时用 manifest.name 合成 strict 条目，
 * 复用与已安装插件相同的 manifest/MCP 校验路径。
 * 失败语义：路径不存在、manifest 缺失/非法都返回诊断而非抛出。
 */
export async function validateLocalPluginPath(input: {
  path: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<PluginValidationDiagnostic[]> {
  const resolved = resolve(input.path);
  // 先 exists 再 stat：statSync 对不存在的路径会抛 ENOENT，这里要把它转成诊断，
  // 而不是让命令以未捕获异常退出。
  if (!existsSync(resolved)) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Path does not exist: ${resolved}`,
        path: resolved,
        severity: "error",
      },
    ];
  }
  const rootPath = statSync(resolved).isDirectory() ? resolved : resolveManifestRootFromFile(resolved);
  // 目录识别顺序：marketplace 优先、插件根其次。反过来的话，一个同时含
  // marketplace.json 与 plugin.json 的仓库会被当成单插件校验，漏掉整个市场的内容。
  if (findMarketplaceManifestPath(rootPath)) {
    return validateMarketplaceSource({
      signal: input.signal,
      source: { source: "directory", path: rootPath },
      storageRoot: input.storageRoot,
    });
  }
  const manifestPath = findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return [
      {
        code: "plugin_manifest_not_found",
        message: `Plugin manifest not found: ${rootPath}`,
        path: rootPath,
        severity: "error",
      },
    ];
  }
  let name = "";
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.name === "string") name = parsed.name.trim();
  } catch (error) {
    return [
      {
        code: "plugin_manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
        path: manifestPath,
        severity: "error",
      },
    ];
  }
  // 本地目录没有 marketplace 条目：用 manifest 自己的 name 合成一个 strict 条目，
  // 让 validatePluginRoot 走与已安装插件完全相同的 manifest/MCP 校验。
  // name 为空时回退目录名，而不是空串：空 name 会生成非法插件 id，后续诊断全部失真。
  return validatePluginRoot({
    entry: { name: name || basename(rootPath), raw: {} },
    marketplace: "inline",
    rootPath,
    storageRoot: input.storageRoot,
  });
}

/** 用户传入 manifest 文件时，回推对应的插件根目录。 */
// 文件位于 `.xxx-plugin/` 时取上一级，否则取所在目录。
function resolveManifestRootFromFile(filePath: string): string {
  const dir = dirname(filePath);
  const dirName = basename(dir);
  return dirName.startsWith(".") && dirName.endsWith("-plugin") ? dirname(dir) : dir;
}

/** 市场 manifest 路径：`<storageRoot>/marketplaces/<sanitized id>/marketplace.json`。 */
export function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, "marketplaces", sanitizePluginId(marketplace), MARKETPLACE_FILE);
}

/**
 * 深度优先展开依赖闭包（拓扑序，依赖在前）。跨市场依赖必须在白名单内，依赖环直接报错，
 * 已访问节点去重；任一依赖缺失则抛错（安装整体失败）。
 */
function resolveDependencyClosure(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  // visiting 用数组而不是 Set：报错文案需要还原出完整环路径（a -> b -> a），
  // Set 只能告诉用户「有环」，无法定位是哪几个插件互相依赖。
  const visiting: string[] = [];
  const visited = new Set<string>();

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    // 跨市场检查必须放在「读 manifest」之前：否则会为了判断一个被禁止的依赖而先去读
    // 另一个市场的本地文件，把一个纯策略判断变成带 IO 的操作（也泄露了对方市场是否存在）。
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      // 环检测必须在 visited 判断之前：走回头路时该节点还没被标记 visited，
      // 顺序反过来会先命中 visited 把环当成「已处理」，最终闭包里静默少一个依赖。
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;
    const manifest = loadMarketplaceManifestSync(input.storageRoot, marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);
    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      // 依赖 id 先补全为 `name@marketplace` 再递归：不补全就会被当成「无归属的裸名」，
      // 后续 parsePluginId 会按当前市场解释，跨市场依赖被静默改成同市场查找而报「找不到」。
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    // push 放在所有依赖之后 = 拓扑序（依赖在前）；放到进入时 push 会得到反序，
    // 安装时先装依赖方、后装依赖（INV-7）。
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

/**
 * 把单个插件条目物化到 cache：解析源根 → zip 源先校验插件根 → 解析真实版本 → 原子激活。
 *
 * 副作用：可能 clone/下载/解压并复制目录；临时源目录在 finally 清理（清理失败不阻断 state 写入）。
 * 不变量：缓存版本取自插件自带 manifest；源根与 target 相同时不自我复制；strict:false 合成 manifest。
 * 返回记录与 activation（由调用方统一 finalize/rollback），并原地更新 state.plugins。
 */
async function cacheMarketplacePlugin(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  signal?: AbortSignal;
  scope: "user" | "workspace";
  state: InstalledPluginsState;
  storageRoot: string;
}): Promise<CachedMarketplacePluginResult> {
  throwIfPluginOperationAborted(input.signal);
  const sourceRoot = await resolvePluginSourceRoot({
    entry: input.entry,
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  // 解析可能产生临时 clone/解压目录，之后所有路径都必须走 try/finally：
  // 任何一步抛错（zip 校验、版本解析、原子激活）都要保证临时目录被清理（INV-10）。
  let version: string;
  let target: string;
  let activation: AtomicDirectoryActivation | undefined;
  try {
    // 多顶层 ZIP 未显式 path 时 resolver 会回退到 extract root，
    // 原安装流程未在删除旧 cache 前校验 manifest，仍会写 installed record 并默认启用，最终 runtime
    // 无法 discover。ZIP 源必须先确认根目录可形成合法插件；strict:false 继续复用 synthetic manifest。
    if (isZipPluginUrlSource(input.entry.source)) {
      assertZipPluginInstallRoot(sourceRoot.path, input.entry, input.marketplace);
    }
    // 缓存目录的版本段与安装记录的 version 不能取自 marketplace 条目的
    // version 字段：git/url 源插件的条目通常不带 version，取了也只会兜底成
    // "0.0.0"，导致 Root path 落到 .../<name>/0.0.0；而 UI 展示读的是插件自带 plugin.json 里的
    // 真实版本，两者割裂。因此在 clone/拷贝后的源根目录上按加载器同样的规则解析真实
    // 版本（详见 resolveInstalledPluginVersion），让缓存路径段与安装记录、UI 展示版本一致。
    version = resolveInstalledPluginVersion(sourceRoot.path, input.entry);
    target = getPluginCacheDir(input.storageRoot, input.marketplace, input.entry.name, version);
    // 内置 filesystem/sea 插件的 cachePath 即缓存目录本身，源根目录可能与 target 相同；
    // 此时无需（也不能）先 rm 再自我拷贝，否则会把源删掉。
    // 用 resolve 归一后再比较：Windows 大小写/分隔符差异会让同一目录看起来不同，
    // 误判成「不同路径」就会把正在用的缓存目录删掉再拷贝。
    if (resolve(sourceRoot.path) !== resolve(target)) {
      throwIfPluginOperationAborted(input.signal);
      activation = await activateDirectoryAtomically({
        authorityPath: join(input.storageRoot, INSTALLED_PLUGINS_FILE),
        prepare: async (stagedPath) => {
          await ensureMarketplaceEntryManifest({ entry: input.entry, target: stagedPath });
        },
        signal: input.signal,
        sourcePath: sourceRoot.path,
        targetPath: target,
      });
    }
    if (resolve(sourceRoot.path) === resolve(target)) {
      await ensureMarketplaceEntryManifest({ entry: input.entry, target });
    }
  } finally {
    // cache 已复制成功后，临时目录 cleanup 失败不能阻断 installed record 落盘。
    await cleanupPluginSourceBestEffort(sourceRoot.cleanup);
  }

  const now = new Date().toISOString();
  const record: InstalledPluginRecord = {
    id: `${input.entry.name}@${input.marketplace}`,
    name: input.entry.name,
    marketplace: input.marketplace,
    version,
    installPath: target,
    installedAt: now,
    updatedAt: now,
    scope: input.scope,
    ...(input.entry.dependencies ? { dependencies: input.entry.dependencies } : {}),
    ...(input.entry.source !== undefined ? { source: input.entry.source } : {}),
    ...(activation ? { cacheTransactionId: activation.transactionId } : {}),
  };
  const existingIndex = input.state.plugins.findIndex((plugin) => plugin.id === record.id);
  if (existingIndex >= 0) {
    // 升级复用旧记录时显式丢弃旧的 cacheTransactionId：它指向上一代目录事务，
    // 保留会让「崩溃恢复」把旧事务当成当前事务去回滚，删掉刚激活的新目录。
    const { cacheTransactionId: _previousCacheTransactionId, ...previousRecord } =
      input.state.plugins[existingIndex] ?? record;
    input.state.plugins[existingIndex] = {
      ...previousRecord,
      ...record,
      installedAt: previousRecord.installedAt ?? record.installedAt,
    };
  } else {
    input.state.plugins.push(record);
  }
  return { ...(activation ? { activation } : {}), record };
}

/**
 * 把条目 source 解析为本地可读根（临时目录需调用方 cleanup）。
 *
 * 支持：filesystem/sea 直接定位 cachePath；字符串相对/绝对目录；对象 directory/github/git/
 * url(zip|git)/git-subdir；npm/pip 明确报不支持；未声明 source 时回退市场内同名目录。
 * 失败语义：显式 object source 非法时不降级到同名目录，避免安装错误来源。
 */
async function resolvePluginSourceRoot(input: {
  entry: PluginMarketplaceEntry;
  manifest?: PluginMarketplaceManifest;
  marketplace: string;
  signal?: AbortSignal;
  sourceRoot?: string;
  storageRoot: string;
}): Promise<ResolvedPluginSourceRoot> {
  throwIfPluginOperationAborted(input.signal);
  const source = input.entry.source;
  const marketplaceDir =
    input.sourceRoot ?? dirname(getMarketplaceManifestPath(input.storageRoot, input.marketplace));
  const manifest =
    input.manifest ?? loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const pluginBaseDir = resolveMarketplacePluginBaseDir(marketplaceDir, manifest);
  // 相对目录基准随 manifest 的位置而变：manifest.pluginRoot 可以覆盖默认的 marketplace 目录。
  // 用 marketplaceDir 直接拼相对路径会忽略 pluginRoot，插件被解析到市场根之外。
  // 内置 official 插件 seed 到 marketplace.json 时 source 写的是裸 kind 字符串
  // "filesystem"/"sea"（见 bootstrap/app/bundled-plugins.ts writeOfficialMarketplace），
  // 原逻辑落到下面的 `typeof source === "string"` 分支，把 "filesystem" 当相对路径解析后抛
  // "Unsupported or missing plugin source: filesystem"，导致市场详情页对内置插件枚举不出组件。
  // 这类插件已落盘在 cachePath（缺失时按 cache/<marketplace>/<name>/<version> 兜底），直接定位即可。
  if (source === "filesystem" || source === "sea") {
    const cachePath = input.entry.cachePath;
    if (cachePath && directoryExists(cachePath)) return { path: cachePath };
    const computed = getPluginCacheDir(
      input.storageRoot,
      input.marketplace,
      input.entry.name,
      input.entry.version ?? DEFAULT_VERSION,
    );
    if (directoryExists(computed)) return { path: computed };
    throw new Error(
      `Bundled plugin cache directory missing: ${input.entry.name}@${input.marketplace}`,
    );
  }
  if (typeof source === "string") {
    // 相对 source 必须经 resolveInside：`../../../etc` 这类字符串会读到市场目录之外，
    // 且 string 形态最容易出现在第三方市场里（INV-3）。
    // 先去掉开头的 `./`：市场作者习惯写 "./plugins/x"，保留它会让拼出的路径多一段，
    // 在按段校验的 resolveInside 里被当成可疑路径而误拒。
    const local = resolveInside(pluginBaseDir, source.replace(/^\.\//, ""));
    if (local && directoryExists(local)) return { path: local };
    // fallback 只接受绝对路径且目录存在：这是为「source 直接写本机绝对路径」的调试场景保留的，
    // 不存在时继续抛错，不会降级成市场内同名目录。
    const fallback = resolve(source);
    if (directoryExists(fallback)) return { path: fallback };
    throw new Error(`Unsupported or missing plugin source: ${source}`);
  }
  if (isRecord(source)) {
    const sourceKind = typeof source.source === "string" ? source.source : "";
    if (sourceKind === "directory") {
      const path = resolve(readRequiredPluginSourceString(source, "path", "directory path"));
      if (directoryExists(path)) return { path };
      throw new Error(`Plugin source directory does not exist: ${path}`);
    }
    if (sourceKind === "github") {
      // repo 必填：缺失时拼出的是 https://github.com/.git，git 会报一个与配置无关的远端错误，
      // 用户无法从错误里看出「是 manifest 少了 repo 字段」。
      const repo = readRequiredPluginSourceString(source, "repo", "GitHub repo");
      const url = `https://github.com/${repo}.git`;
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git") {
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: readRequiredPluginSourceString(source, "url", "Git URL"),
      });
    }
    if (sourceKind === "url") {
      const url = readRequiredPluginSourceString(source, "url", "URL");
      // type 缺省按 git 处理：早期市场只写 url 不写 type，缺省即 git 是兼容约定。
      // 但显式写了其它 type（例如 tar）必须报「不支持」，不能偷偷按 git 拉取 ——
      // 那会把一个压缩包当仓库 clone，错误信息完全对不上用户配置。
      const sourceType = typeof source.type === "string" ? source.type : "";
      if (sourceType === "zip") {
        return resolveZipPluginSource({
          headers: readPluginSourceHeaders(source),
          path: readOptionalZipPluginSourcePath(source),
          sha256: readRequiredZipPluginSourceSha256(source),
          signal: input.signal,
          stripRoot: readOptionalZipPluginSourceStripRoot(source),
          url,
        });
      }
      if (sourceType && sourceType !== "git") {
        throw new UnsupportedPluginSourceError(`url:${sourceType}`);
      }
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git-subdir") {
      return resolveRepositoryPluginSource({
        path: readRequiredPluginSourceString(source, "path", "git-subdir path"),
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: normalizeGitUrl(readRequiredPluginSourceString(source, "url", "git-subdir URL")),
      });
    }
    if (sourceKind === "npm" || sourceKind === "pip") {
      throw new UnsupportedPluginSourceError(sourceKind);
    }
    // 显式 object source 配置错误时不能降级到 marketplace 内同名目录，否则会安装错误来源。
    throw new Error(
      `Plugin source is invalid or unsupported for ${input.entry.name}@${input.marketplace}: ${sourceKind || "missing kind"}`,
    );
  }
  const localByName = join(pluginBaseDir, input.entry.name);
  // 最后才回退「市场内同名目录」：这是未声明 source 的隐式约定。
  // 放在显式 object 校验之后，保证配置写错时不会被这条兜底规则掩盖（INV 的校验顺序）。
  if (directoryExists(localByName)) return { path: localByName };
  throw new Error(`Plugin source is not supported for ${input.entry.name}@${input.marketplace}`);
}

/** 读取 source 身份 pin（zip sha256 优先，其次 sha/commit）；无则 undefined。 */
export function readPluginSourceSha(source: unknown): string | undefined {
  return readPluginSourceIdentityPin(source);
}

/**
 * 统一读取源身份 pin：zip 源取 sha256，git 源取 sha，兼容旧版/第三方 marketplace 的 commit。
 * 优先级固定为 sha256 → sha → commit。
 */
export function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  // 优先级 sha256 → sha → commit 是兼容性契约：zip 源只有 sha256 有校验意义，
  // 而旧版市场用 commit 表示 git pin。反过来（先 commit）会让同一 source 在
  // 「zip 带 sha256、又残留 commit」时选错校验值，导致完整性校验失败但原因难查。
  const zipSha256 = readZipPluginSourceSha256(source);
  if (zipSha256) return zipSha256;
  if (typeof source.sha === "string") return source.sha;

  // 兼容旧版及第三方 marketplace 的 source identity 写法。
  if (typeof source.commit === "string") return source.commit;
  return undefined;
}

/** zip 源强制要求 sha256（缺省即配置错误，不允许无校验下载）。 */
// 这里刻意不做「缺省放行」：zip 没有内容寻址，若不校验 sha256，被篡改的包会被直接解压执行。
// 报错文案是用户唯一的线索，保持固定措辞以便检索与文档引用，不要改成动态拼接。
function readRequiredZipPluginSourceSha256(source: Record<string, unknown>): string {
  if (typeof source.sha256 === "string") return source.sha256;
  throw new Error("Plugin zip source sha256 is required");
}

/** 读取必填非空字符串字段；缺失/空白即抛错（用于 source 的 url/repo/path）。 */
function readRequiredPluginSourceString(
  source: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = source[field];
  // trim 后判空再返回原值：空字符串字段（例如 url: ""）会让后续 fetch 报一个
  // 与配置无关的协议错误；在这里拦住能给出「缺少 url」的准确文案。
  // 返回未 trim 的原值：本函数只负责校验、不负责规范化，
  // 同一字段若在两个地方被不同方式 trim，会出现「校验通过但使用值不同」的隐蔽问题。
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin ${label} source requires a non-empty ${field}`);
  }
  return value;
}

/** 可选 zip 子目录：缺省 undefined，类型错误抛错（不静默忽略）。 */
function readOptionalZipPluginSourcePath(source: Record<string, unknown>): string | undefined {
  if (source.path === undefined) return undefined;
  if (typeof source.path === "string") return source.path;
  throw new Error("Plugin zip source path must be a string");
}

/** 可选 stripRoot：缺省 undefined，类型错误抛错（避免歧义默认值）。 */
function readOptionalZipPluginSourceStripRoot(
  source: Record<string, unknown>,
): boolean | undefined {
  if (source.stripRoot === undefined) return undefined;
  if (typeof source.stripRoot === "boolean") return source.stripRoot;
  throw new Error("Plugin zip source stripRoot must be a boolean");
}

/** 读取 zip 源 header 映射：值必须全为字符串，否则抛错（白名单校验在下游 zip-source 再做）。 */
function readPluginSourceHeaders(
  source: Record<string, unknown>,
): Record<string, string> | undefined {
  if (source.headers === undefined) return undefined;
  if (!isRecord(source.headers)) {
    throw new Error("Plugin zip source headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Git 源物化：clone 到临时目录（可 checkout sha），可选 path 子目录必须存在且位于仓库根内。
 * 失败时清理临时目录并把清理错误追加到原错误。
 */
async function resolveGitPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  const dir = await clonePluginSource(input.url, input.ref, input.sha, input.signal);
  // cleanup 必须在任何早退之前构造好：从 clone 成功那一刻起，临时目录就归本函数管，
  // 后续路径校验失败若不清理，每失败一次就留下一个完整仓库副本（INV-10）。
  const cleanup = async (): Promise<void> => {
    await rm(dir, { force: true, recursive: true });
  };
  if (!input.path) return { cleanup, path: dir };
  throwIfPluginOperationAborted(input.signal);
  // path 子目录同样要过 resolveInside：`path: "../../other"` 能读到仓库外的本机文件，
  // clone 出来的仓库是第三方内容，不能信任它声明的子路径（INV-3）。
  const subdir = resolveInside(dir, input.path);
  if (!subdir || !directoryExists(subdir)) {
    const primaryError = new Error(`Plugin source subdirectory does not exist: ${input.path}`);
    // 先清理再抛：append 把清理错误挂在主错误上，既保证主因不被覆盖，又保留清理失败的线索。
    const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
    throw appendPluginSourceCleanupError(primaryError, cleanupError);
  }
  return { cleanup, path: subdir };
}

/**
 * 仓库源优先走 GitHub Archive（免 Git 依赖）；仅当错误可回退（非公开仓库/submodule/LFS 等）
 * 时才落回系统 Git clone；不可回退错误包装为 Archive 抓取错误抛出。
 */
async function resolveRepositoryPluginSource(input: {
  path?: string;
  ref?: string;
  signal?: AbortSignal;
  sha?: string;
  url: string;
}): Promise<ResolvedPluginSourceRoot> {
  try {
    return await resolveGitHubArchiveSource({
      path: input.path,
      // pin 取 sha ?? ref：sha 是不可变身份，ref 只是分支/标签名（会移动）。
      // 反过来优先 ref 会让「同一 ref 内容已变」的缓存判定失效，用户装到与上次不同的代码。
      pin: input.sha ?? input.ref,
      signal: input.signal,
      url: input.url,
    });
  } catch (error) {
    // 只有「可回退」的错误才继续走 git：私有仓库、submodule、LFS 等 Archive 不支持的场景
    // 必须降级；而 404/网络超时这类 Archive 专属失败若也降级，会让用户多等一次完整 clone，
    // 最终得到一个与 Archive 无关的 git 报错（INV-16 的错误分类原则）。
    if (!shouldFallbackGitHubArchiveToGit(error)) {
      throw createArchiveFetchError(input.url, error);
    }
  }
  return resolveGitPluginSource(input);
}

/**
 * clone 插件源到临时目录：无 sha 时 --depth 1，有 sha 时完整 clone 后 checkout。
 * 失败时删除临时目录，清理错误追加到主错误后抛出。
 */
async function clonePluginSource(
  url: string,
  ref: string | undefined,
  sha?: string,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-src-"));
  const args = ["clone"];
  // 无 sha 时 --depth 1 是性能关键：插件仓库常带上百个提交历史，全量 clone 会让
  // 「添加市场」从秒级变成分钟级。有 sha 时必须完整 clone，否则 checkout 找不到目标提交。
  if (!sha) args.push("--depth", "1");
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sha) await execGitCommand(["-C", dir, "checkout", sha], signal);
    return dir;
  } catch (error) {
    // [资源] clone 失败时 mkdtemp 创建的目录仍然存在（可能是空目录或半个仓库），
    // 必须 rm 后重新抛出；清理失败只作为附加信息，不能替换主错误（INV-10）。
    const cleanupError = await cleanupPluginSourceBestEffort(async () => {
      await rm(dir, { force: true, recursive: true });
    });
    throw appendPluginSourceCleanupError(error, cleanupError);
  }
}

/** 把 `owner/repo` 简写补成 https GitHub URL；其他形式原样返回。 */
function normalizeGitUrl(value: string): string {
  // 只把「恰好两段、且不含冒号」的字符串当简写：含冒号可能是 ssh 或协议前缀，
  // 已是完整 URL 的不能再拼 gh 域名，否则会得到 https://github.com/https://...
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(":")) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

/** 插件相对路径的基准目录：manifest.pluginRoot 合法且存在时使用，否则回退市场目录。 */
function resolveMarketplacePluginBaseDir(
  marketplaceDir: string,
  manifest: PluginMarketplaceManifest | null,
): string {
  const pluginRoot = manifest?.pluginRoot;
  if (!pluginRoot) return marketplaceDir;
  // pluginRoot 同样必须 resolveInside：它对市场作者是自由字段，
  // 写 `../..` 就能把插件基准指到市场目录之外（INV-3）。
  const resolved = resolveInside(marketplaceDir, pluginRoot);
  // 解析失败或目录不存在时回退而不是抛错：pluginRoot 只是「子目录重排」的增强，
  // 一个配置错误不应让整个市场加载失败（INV-15）。
  return resolved && directoryExists(resolved) ? resolved : marketplaceDir;
}

/**
 * 确保安装目录内有 manifest：已有则跳过；strict:false 时按条目合成 `.claude-plugin/plugin.json`，
 * strict 条目缺失 manifest 直接返回（由上层校验报错）。
 * 副作用：可能 mkdir + 写文件。
 */
async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry;
  target: string;
}): Promise<void> {
  if (findPluginManifestPath(input.target)) return;
  // strict 条目缺 manifest 时直接返回，把「拒绝安装」留给上层校验：
  // 这里若抛错，错误会发生在 staging 目录里，路径是临时目录，用户完全看不懂。
  if (input.entry.strict !== false) return;
  // 只有 strict:false 才合成 manifest：它表示「老式条目，没有 plugin.json，用条目字段代替」。
  // 对 strict 条目也合成会掩盖「作者漏提交 manifest」这一真实问题。
  const manifestDir = join(input.target, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeJsonFile(
    join(manifestDir, "plugin.json"),
    createManifestFromMarketplaceEntry(input.entry),
  );
}

/**
 * zip 源的安装前校验：解压根必须能形成合法插件（manifest 存在且 name 与条目一致），
 * 否则安装会写出无法被 runtime discover 的缓存。strict:false 仍走合成 manifest。
 */
function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string,
): void {
  const loaded = readPluginManifestFromRoot(rootPath, entry);
  const pluginId = `${entry.name}@${marketplace}`;
  if (!loaded) {
    throw new Error(`Plugin manifest not found: ${pluginId}`);
  }
  if (loaded.manifest.name !== entry.name) {
    // name 不一致必须在安装前拒绝：缓存目录按 entry.name 建，而 runtime 按 manifest.name
    // 注册插件，两者不同会导致「装好了但永远 discover 不到」，且卸载时按 id 找不到记录。
    throw new Error(
      `Plugin manifest name '${loaded.manifest.name}' does not match marketplace entry '${entry.name}'`,
    );
  }
}

/**
 * 从条目 raw 合成 manifest：剔除 source/category/tags/strict 与商店展示字段，保留合法 manifest
 * 字段（author/homepage），并以条目 name/version 兜底。
 */
function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
): Record<string, unknown> {
  const raw = { ...entry.raw };
  delete raw.source;
  delete raw.category;
  delete raw.tags;
  delete raw.strict;
  // 商店信息（Store Listing）是目录层展示元数据，不属于插件 manifest；
  // 合成 manifest 时剔除，避免污染 plugin.json 语义（author/homepage 是合法 manifest 字段，保留）。
  delete raw.displayName;
  delete raw.displayName_i18n;
  delete raw.description_i18n;
  delete raw.icon;
  delete raw.privacyPolicy;
  delete raw.termsOfService;
  delete raw.heroImage;
  delete raw.examplePrompts;
  delete raw.examplePrompts_i18n;
  delete raw.requiresPaidPlan;
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION,
  };
}

/**
 * 按来源加载市场 manifest。settings 为内存内联；file/directory/url 直接读取；github/git 先
 * clone/Archive，persist=true 时把 source tree + 规范 manifest 原子落盘。临时目录随返回值
 * 交给调用方 cleanup，失败路径自行清理并追加清理错误。
 * npm/hostPattern/pathPattern 明确报不支持。
 */
async function loadMarketplaceFromSource(
  source: MarketplaceSource,
  storageRoot: string,
  options: { persist: boolean; signal?: AbortSignal },
): Promise<LoadMarketplaceResult> {
  throwIfPluginOperationAborted(options.signal);
  switch (source.source) {
    case "settings":
      // settings 变体不落盘、也不设 sourceRoot：它只用于官方 seed 与测试，
      // 返回 sourceRoot 会让调用方误以为可以从该路径物化插件目录。
      return { manifest: normalizeMarketplaceManifest(source.marketplace) };
    case "file": {
      const parsed = JSON.parse(await readFile(source.path, "utf8")) as unknown;
      // file 源把 dirname 作为 sourceRoot：单文件市场的插件目录相对该文件所在目录，
      // 用 cwd 作为基准会让相对 source 全部解析失败。
      return {
        manifest: parseRequiredMarketplaceManifest(parsed),
        sourceRoot: dirname(source.path),
      };
    }
    case "directory": {
      const file = findMarketplaceManifestPath(source.path);
      if (!file) throw new Error(`Marketplace manifest not found in directory: ${source.path}`);
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      const manifest = parseRequiredMarketplaceManifest(parsed);
      if (options.persist) {
        // directory 源的 persist 分支在返回前就 finalize：它的 sourceRoot 是用户目录，
        // 不是临时 clone，调用方后续回收没有意义。stage 失败会直接抛错，不留下半代目录。
        const activation = await stageMarketplaceDirectoryPlugins(
          source.path,
          storageRoot,
          manifest.name,
          manifest.raw,
          options.signal,
        );
        await activation.finalize();
      }
      return { manifest, sourceRoot: source.path };
    }
    case "url": {
      const parsed = await requestMarketplaceJson(source.url, source.headers, options.signal);
      return { manifest: parseRequiredMarketplaceManifest(parsed) };
    }
    case "github": {
      const resolved = await resolveRepositoryMarketplaceSource(
        `https://github.com/${source.repo}.git`,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        // GitHub 仓库的 manifest 允许用 source.path 指定子目录：默认在仓库根，
        // 大仓库常把市场放在子包里，忽略这个字段会让「添加市场」直接报找不到。
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in GitHub repo: ${source.repo}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          // 成功路径也返回 cleanup 交给调用方：sourceRoot 是临时 clone，
          // 调用方要在「目录事务提交完成」后才能删，提前删会让 stage 读到空目录。
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        // 解析/落盘失败时必须回收 clone 目录：这个函数内没有别的地方会拿到 cleanup，
        // 漏掉就等于每次失败泄漏一份完整仓库（INV-10）。
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "git": {
      const resolved = await resolveRepositoryMarketplaceSource(
        source.url,
        source.ref,
        source.sparsePaths,
        options.signal,
      );
      const cleanup = resolved.cleanup;
      try {
        const file = findMarketplaceManifestPath(resolved.path, source.path);
        if (!file) throw new Error(`Marketplace manifest not found in git repo: ${source.url}`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        const manifest = parseRequiredMarketplaceManifest(parsed);
        if (options.persist) {
          const activation = await stageMarketplaceDirectoryPlugins(
            resolved.path,
            storageRoot,
            manifest.name,
            manifest.raw,
            options.signal,
          );
          await activation.finalize();
        }
        return { cleanup, manifest, sourceRoot: resolved.path };
      } catch (error) {
        const cleanupError = await cleanupPluginSourceBestEffort(cleanup);
        throw appendPluginSourceCleanupError(error, cleanupError);
      }
    }
    case "npm":
      // 三种不支持来源各自抛专用错误：UI 据此展示「npm 市场暂不支持」，
      // 若统一成「格式非法」，用户会反复修改输入却永远无法通过。
      throw new UnsupportedMarketplaceSourceError("npm");
    case "hostPattern":
      throw new UnsupportedMarketplaceSourceError("hostPattern");
    case "pathPattern":
      throw new UnsupportedMarketplaceSourceError("pathPattern");
  }
}

/**
 * 仓库型市场源：无 sparsePaths 时优先 GitHub Archive；可回退错误再走系统 Git。
 * sparsePaths 会保留 sparse checkout 路由（Archive 目前需整仓下载，易触发大小上限）。
 */
async function resolveRepositoryMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedPluginSourceRoot> {
  // sparsePaths 是既有 MarketplaceSource 契约。Archive 需要先下载整仓，
  // 会让原本能 sparse clone 的大仓库因下载上限失败；在 Archive 尚未实现等价投影前，
  // 显式保留系统 Git 的 sparse checkout 路由。
  if (!sparsePaths?.length) {
    try {
      // 市场的 ref 直接当 Archive 的 pin：这里没有 sha 可选，ref 是用户显式指定的版本意图，
      // 与插件源的 pin 优先级不同（插件源优先 sha），因为市场源只暴露 ref。
      return await resolveGitHubArchiveSource({ pin: ref, signal, url });
    } catch (error) {
      if (!shouldFallbackGitHubArchiveToGit(error)) {
        throw createArchiveFetchError(url, error);
      }
    }
  }
  // sparse 场景跳过 Archive 是刻意的降级：Archive 目前只能整仓下载，
  // 对「仓库巨大但市场只在子目录」的场景会超限失败，此时系统 Git 更可靠（见上方注释）。
  const dir = await cloneMarketplaceSource(url, ref, sparsePaths, signal);
  return {
    cleanup: async () => {
      await rm(dir, { force: true, recursive: true });
    },
    path: dir,
  };
}

/**
 * clone 市场源到临时目录：--depth 1，可选 sparse checkout（blob:none + sparse paths）。
 * 失败时删除临时目录后原样抛出。
 */
async function cloneMarketplaceSource(
  url: string,
  ref: string | undefined,
  sparsePaths: string[] | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-marketplace-src-"));
  const args = ["clone", "--depth", "1"];
  // blob:none + sparse 组合能把大仓库的下载量降到只含市场目录，
  // 少了 --filter=blob:none 时 sparse-checkout 仍会先拉全部 blob，等于没有稀疏化。
  if (ref) args.push("--branch", ref);
  if (sparsePaths?.length) args.push("--filter=blob:none", "--sparse");
  args.push(url, dir);
  try {
    await execGitCloneWithRetry(args, dir, signal);
    if (sparsePaths?.length) {
      await execGitCommand(["-C", dir, "sparse-checkout", "set", ...sparsePaths], signal);
    }
    return dir;
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Git clone 最多重试 3 次，仅对明确的网络型错误（RPC failed/timeout/EOF 等）重试；
 * 每次重试前清空 targetDir。权限/路径/仓库不存在等确定性错误立即抛出。
 */
async function execGitCloneWithRetry(
  args: string[],
  targetDir: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
    try {
      throwIfPluginOperationAborted(signal);
      if (attempt > 1) {
        // 重试前必须清空：--depth 1 的半成品目录会让 git 报 "already exists and is not empty"，
        // 那是与根因无关的二次错误，会掩盖真正的网络失败。
        await rm(targetDir, { force: true, recursive: true });
        await mkdir(targetDir, { recursive: true });
      }
      await execGitCommand(args, signal);
      return;
    } catch (error) {
      lastError = error;
      // 不可重试就立即抛：确定性错误（权限/仓库不存在）重试只是把等待时间乘以 3，
      // 而且用户看到的仍是同一条错误（INV-16 的错误分类原则）。
      if (attempt >= GIT_CLONE_MAX_ATTEMPTS || !isRetryableGitCloneError(error)) {
        throw error;
      }
      // GitHub 偶发 RPC/recv timeout 会让官方 marketplace add 失败。
      // 仅对明确的网络型 clone 错误做短重试，避免掩盖权限、路径或仓库不存在等确定性错误。
      await delay(GIT_CLONE_RETRY_DELAY_MS * attempt, signal);
    }
  }
  throw lastError;
}

/**
 * 执行 Git 命令：支持 ZCODE_GIT_BINARY 覆盖（便于 E2E 验证 Archive 不依赖 Git），
 * 继承网络环境，SIGTERM + 90s 超时；命令不存在时抛 GitUnavailable 错误。
 */
async function execGitCommand(args: string[], signal?: AbortSignal): Promise<void> {
  throwIfPluginOperationAborted(signal);
  try {
    // 显式二进制覆盖既支持非标准 Git 安装位置，也让跨进程 E2E 能把 Git 指向不存在的
    // 绝对路径，真实证明 Archive 主链路不依赖开发机上偶然存在的 Git。
    const gitBinary = process.env.ZCODE_GIT_BINARY?.trim() || "git";
    await execFileAsync(gitBinary, args, {
      env: buildMarketplaceGitEnv(),
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (isCommandUnavailableError(error)) {
      const source = args.find(
        (arg) => arg.includes("://") || arg.startsWith("git@") || arg.startsWith("git+"),
      );
      throw createGitUnavailableError(source ?? args.at(-1) ?? "Git operation");
    }
    throw error;
  }
  throwIfPluginOperationAborted(signal);
}

/** 判断 clone 错误是否可重试：只匹配网络型输出特征，避免掩盖确定性失败。 */
function isRetryableGitCloneError(error: unknown): boolean {
  const output = getErrorOutput(error);
  // 白名单而非黑名单：只匹配已知的网络型特征。用黑名单（「不是权限错误就重试」）
  // 会把「仓库不存在」「磁盘写满」也重试，且最后一次错误可能变成超时，掩盖真实原因。
  return /RPC failed|Operation timed out|Recv failure|expected flush|early EOF|remote end hung up|HTTP\/2 stream|Connection reset|ETIMEDOUT|ECONNRESET|network timeout/iu.test(
    output,
  );
}

/** 汇总错误可读输出（message + stdout + stderr），用于重试判定。 */
function getErrorOutput(error: unknown): string {
  if (!isRecord(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const chunks = [
    error instanceof Error ? error.message : "",
    typeof error.stdout === "string" ? error.stdout : "",
    typeof error.stderr === "string" ? error.stderr : "",
  ];
  return chunks.filter(Boolean).join("\n");
}

/** 可取消的延迟：用于 clone 重试退避；取消时立即 reject AbortError 并清理 timer/监听器。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    // 已取消就直接 reject 且不注册 listener/timer：否则会先注册再立即触发，
    // 在长会话里累积「注册-清理」的噪声，还可能因 abort 同步触发导致 reject 顺序错乱。
    if (signal?.aborted) {
      rejectDelay(createPluginOperationCancelledError());
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      // timeout 置 undefined 是幂等标记：cleanup 可能被 abort 与正常到期两条路径各调用一次，
      // 不置空会对已清理的 timer 再 clearTimeout（无害但掩盖重复调用）。
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = (): void => {
      cleanup();
      // reject 用统一的 AbortError：重试循环据此区分「用户取消」与「网络失败」，
      // 若在这里 reject 原始 abort reason，取消可能被当成可重试错误继续重试（INV-16）。
      rejectDelay(createPluginOperationCancelledError());
    };
    timeout = setTimeout(() => {
      cleanup();
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * 在 staging 中复制 source tree 并写入规范 manifest，然后原子替换市场目录。
 * authority 为 known_marketplaces.json，确保目录与注册表同代提交。
 */
async function stageMarketplaceDirectoryPlugins(
  sourceDir: string,
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  throwIfPluginOperationAborted(signal);
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // authority 固定为 known_marketplaces.json：目录与注册表必须用同一 transactionId 提交，
  // 否则崩溃恢复时无法判断「新目录对应的是不是新记录」（INV-1）。
  // sourcePath 会整树复制，staged 目录里额外写一份规范 manifest 覆盖源里的旧版本。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    sourcePath: sourceDir,
    targetPath: targetDir,
  });
}

/**
 * 无 source tree 来源（url/settings）只替换 manifest：prepare-only activation 让 manifest 与
 * known state 使用同一 transactionId，写入失败时继续读上一代快照。
 */
async function stageMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  manifest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AtomicDirectoryActivation> {
  const targetDir = dirname(getMarketplaceManifestPath(storageRoot, marketplace));
  // URL/settings source 没有 sourceRoot；直接覆盖 manifest 时若写入期间
  // deadline 到达或 known state 落盘失败就无法回滚。prepare-only activation 让 manifest
  // 与 known_marketplaces.json 使用同一个 transactionId 提交，失败时继续读取上一代快照。
  return activateDirectoryAtomically({
    authorityPath: join(storageRoot, KNOWN_MARKETPLACES_FILE),
    prepare: async (stagedPath) => {
      await writeJsonFile(join(stagedPath, MARKETPLACE_FILE), manifest);
    },
    signal,
    targetPath: targetDir,
  });
}

/** 原子写入市场 manifest（用于图标回填等原地更新，不触发事务代际）。 */
async function writeMarketplaceManifest(
  storageRoot: string,
  marketplace: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(getMarketplaceManifestPath(storageRoot, marketplace), raw);
}

/**
 * 写入/更新 known 记录并返回 finalize/rollback 句柄。
 * 更新时保留原 addedAt 与成功态字段，清除 lastRefreshFailure；rollback 仅在记录未被并发修改
 * （lastUpdated + transactionId 匹配）时生效，否则抛错拒绝回滚。
 */
async function upsertKnownMarketplace(
  storageRoot: string,
  record: KnownMarketplaceRecord,
): Promise<KnownMarketplaceActivation> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((item) => item.id === record.id);
  const previous = index >= 0 ? known[index] : undefined;
  if (index >= 0) {
    // 更新时丢掉旧 cacheTransactionId 与 lastRefreshFailure：
    // - 前者指向上一代目录事务，保留会让恢复回滚错对象；
    // - 后者是本轮正在清掉的失败态，保留会让「刷新成功」后仍显示上一次错误。
    const {
      cacheTransactionId: _previousCacheTransactionId,
      lastRefreshFailure: _lastRefreshFailure,
      ...successfulPrevious
    } = previous ?? record;
    known[index] = {
      ...successfulPrevious,
      ...record,
      // addedAt 只保留首次添加时间：刷新会传入新的 addedAt，不覆盖会让「添加时间」
      // 随每次刷新漂移，无法用于统计市场存活时长。
      addedAt: previous?.addedAt ?? record.addedAt,
    };
  } else {
    known.push(record);
  }
  await writeKnownMarketplaces(storageRoot, known);
  let settled = false;
  return {
    finalize: () => {
      settled = true;
    },
    rollback: async () => {
      // settled 守卫让 rollback 幂等：catch 与 finally 可能各调一次，
      // 第二次再读盘/写盘会覆盖掉期间其它进程的更新。
      if (settled) return;
      const current = loadKnownMarketplacesSync(storageRoot);
      const currentIndex = current.findIndex((item) => item.id === record.id);
      const currentRecord = currentIndex >= 0 ? current[currentIndex] : undefined;
      // 三项必须全等才允许回滚：lastUpdated 判断「有没有人改过这条记录」，
      // cacheTransactionId 判断「改的是不是本事务的代际」。只比其中一项，
      // 在并发刷新（另一个进程刚成功写入）时会把别人的成果回滚掉。
      if (
        !currentRecord ||
        currentRecord.lastUpdated !== record.lastUpdated ||
        currentRecord.cacheTransactionId !== record.cacheTransactionId
      ) {
        throw new Error(
          `Cannot roll back marketplace authority after concurrent update: ${record.id}`,
        );
      }
      if (previous) {
        current[currentIndex] = previous;
      } else {
        current.splice(currentIndex, 1);
      }
      await writeKnownMarketplaces(storageRoot, current);
      settled = true;
    },
  };
}

/** 在 known 记录上持久化最近刷新失败（记录不存在则忽略）。 */
async function persistMarketplaceRefreshFailure(
  storageRoot: string,
  marketplace: string,
  failure: MarketplaceRefreshFailure,
): Promise<void> {
  const known = loadKnownMarketplacesSync(storageRoot);
  const index = known.findIndex((record) => record.id === marketplace);
  // 市场不存在时静默返回：这个函数在 catch 路径里被调用，此时可能是「添加失败」
  // （记录本来就没写进去），再抛错会把原始失败替换成「市场不存在」。
  if (index < 0 || !known[index]) return;
  known[index] = { ...known[index], lastRefreshFailure: failure };
  await writeKnownMarketplaces(storageRoot, known);
}

/** 原子写入 known_marketplaces.json（含 version:1 包装）。 */
async function writeKnownMarketplaces(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): Promise<void> {
  await writeJsonFile(join(storageRoot, KNOWN_MARKETPLACES_FILE), {
    version: 1,
    marketplaces,
  });
}

/** 同步写入 known_marketplaces.json（仅在启动期 bootstrap 使用；带 2 空格缩进与末尾换行）。 */
function writeKnownMarketplacesSync(
  storageRoot: string,
  marketplaces: KnownMarketplaceRecord[],
): void {
  const path = join(storageRoot, KNOWN_MARKETPLACES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        marketplaces,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** 内置默认市场 source 字符串解析：`owner/repo` → github shorthand，其余按 url 处理。 */
function defaultMarketplaceSourceFromString(source: string): MarketplaceSource {
  const trimmed = source.trim();
  // 简写正则要求「恰好两段 + 可选 #ref/@ref + 不含冒号」：冒号排除 Windows 盘符与 ssh，
  // 段数限制排除 `https://...`（否则它的第一个 / 之前就含冒号，虽然也会被冒号条件挡住）。
  if (/^[^/]+\/[^/]+(?:[#@].+)?$/u.test(trimmed) && !trimmed.includes(":")) {
    const { ref, url } = splitGitHubShorthand(trimmed);
    return ref ? { source: "github", repo: url, ref } : { source: "github", repo: url };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return { source: "url", url: trimmed };
  }
  return { source: "url", url: trimmed };
}

/** 归一 installed 状态：兼容 map 形态（值为单条或数组）与数组形态；损坏数据返回空状态。 */
function normalizeInstalledPluginsState(value: unknown): InstalledPluginsState {
  // 损坏/缺失数据返回空状态而不是抛错：调用方会用空状态重建，
  // 抛错会让「插件目录还在、但状态文件被写坏」的用户彻底无法启动插件系统。
  if (!isRecord(value)) return { version: 1, plugins: [] };
  const rawPlugins = value.plugins;
  if (isRecord(rawPlugins)) {
    // map 形态的值可能是单条或数组（同一插件在多个 scope 各一条），flatMap 统一拍平；
    // 若只取单条，会静默丢掉 workspace 那一份安装记录。
    return {
      version: 1,
      plugins: Object.entries(rawPlugins).flatMap(([pluginId, entry]) =>
        normalizeInstalledPluginRecordFromMap(pluginId, entry),
      ),
    };
  }
  const plugins = Array.isArray(rawPlugins) ? rawPlugins : [];
  return {
    version: 1,
    plugins: plugins.filter(isInstalledPluginRecord),
  };
}

/**
 * 把 map 形态的条目转为安装记录：id 由 key 解析；scope 将 project/local 归一为 workspace；
 * 缺少 installPath 或 id 非法则丢弃该条。
 */
function normalizeInstalledPluginRecordFromMap(
  pluginId: string,
  entry: unknown,
): InstalledPluginRecord[] {
  const entries = Array.isArray(entry) ? entry : [entry];
  return entries.flatMap((item): InstalledPluginRecord[] => {
    if (!isRecord(item)) return [];
    const installPath = typeof item.installPath === "string" ? item.installPath : "";
    // 无 installPath 的条目直接丢弃：没有它就无法定位插件，保留会让 UI 显示「已安装」
    // 但加载器找不到任何文件，且卸载时 rm 一个空路径（危险）。
    if (!installPath) return [];
    let parsed: { marketplace: string; name: string };
    try {
      parsed = parsePluginId(pluginId);
    } catch {
      // id 非法的条目跳过而不是让整份状态失效：一条脏 key 不应抹掉其余几十个有效安装。
      return [];
    }
    // project/local 统一归一为 workspace：这是历史 scope 命名，保留原值会让
    // 同一语义出现三个维度值，卸载时的 scope 匹配也会漏。
    const scope = item.scope === "project" || item.scope === "local" ? "workspace" : "user";
    return [
      {
        id: pluginId,
        name: parsed.name,
        marketplace: parsed.marketplace,
        version: typeof item.version === "string" ? item.version : DEFAULT_VERSION,
        installPath,
        installedAt:
          typeof item.installedAt === "string" ? item.installedAt : new Date(0).toISOString(),
        ...(typeof item.lastUpdated === "string" ? { updatedAt: item.lastUpdated } : {}),
        scope,
      },
    ];
  });
}

/** 解析并强制要求合法 manifest：解析失败直接抛错（用于落盘前校验）。 */
function parseRequiredMarketplaceManifest(value: unknown): PluginMarketplaceManifest {
  const parsed = parseMarketplaceManifest(value);
  if (!parsed) throw new Error("Marketplace manifest is invalid");
  return parsed;
}

/**
 * 宽容解析市场 manifest：name 必须合法；plugins 支持数组或 map（map key 补 name）；
 * 不合法返回 null（调用方决定是否报错）。
 */
function parseMarketplaceManifest(value: unknown): PluginMarketplaceManifest | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  // name 是市场 id：不合规直接判整份 manifest 无效，而不是「跳过 name 继续解析」。
  // 没有合法 id 就无法确定落盘目录，继续解析只会得到无处安放的数据。
  if (!MARKETPLACE_NAME_PATTERN.test(name)) return null;
  const rawPlugins = value.plugins;
  // plugins 支持数组或 map：map 形态用 key 兜底 name（条目自带 name 优先，spread 在后）。
  // 顺序不能反：若 key 覆盖条目，作者在条目里写的展示名会被索引键替换，用户看到的是内部键名。
  const pluginEntries = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  return normalizeMarketplaceManifest({
    ...value,
    name,
    plugins: pluginEntries,
  });
}

/**
 * 归一市场 manifest：已是规范形态直接返回；否则逐条清洗插件（丢无 name 项、归一依赖/source/
 * listing，保留 raw），并从顶层或 metadata 回退 description/pluginRoot/featured。
 */
function normalizeMarketplaceManifest(
  value: PluginMarketplaceManifest | Record<string, unknown>,
): PluginMarketplaceManifest {
  if (isPluginMarketplaceManifest(value)) return value;
  // 已是规范形态直接返回原引用：调用方用引用相等判断「是否需要重写 manifest」，
  // 每次都返回新对象会让启动回填逻辑反复写盘（见 applyClaudePluginIcons 的用法）。
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isRecord)
        .map((entry): PluginMarketplaceEntry | null => {
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          // 无 name 的条目丢弃：它无法生成插件 id，也无法定位缓存目录；
          // 保留一个空名条目会让 UI 出现一个点击后必然报错的占位项。
          if (name.length === 0) return null;
          const dependencies = Array.isArray(entry.dependencies)
            ? entry.dependencies
                .map(normalizeDependencyRef)
                .filter((item): item is string => item !== null)
            : undefined;
          const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((item): item is string => typeof item === "string")
            : undefined;
          const listing = parseEntryStoreListing(entry);
          return {
            name,
            ...(typeof entry.category === "string" ? { category: entry.category } : {}),
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(typeof entry.version === "string" ? { version: entry.version } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            ...(typeof entry.cachePath === "string" ? { cachePath: entry.cachePath } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof entry.strict === "boolean" ? { strict: entry.strict } : {}),
            ...(tags ? { tags } : {}),
            ...(listing ? { listing } : {}),
            raw: entry,
          };
        })
        .filter((entry): entry is PluginMarketplaceEntry => entry !== null)
    : [];
  const allowCrossMarketplaceDependenciesOn = Array.isArray(
    value.allowCrossMarketplaceDependenciesOn,
  )
    ? value.allowCrossMarketplaceDependenciesOn.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  // 目录顶层的 Featured 策展名单：仅接受非空字符串数组，去掉空白项。
  const featured = Array.isArray(value.featured)
    ? value.featured.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    name: String(value.name),
    // description 三级回退：顶层 > metadata > 省略。顺序固定，
    // 反过来会让 metadata 里的旧描述覆盖市场作者刚改的顶层描述，UI 长期显示过期文案。
    ...(typeof value.description === "string"
      ? { description: value.description }
      : typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    plugins,
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
    ...(typeof metadata.pluginRoot === "string" ? { pluginRoot: metadata.pluginRoot } : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
    raw: value,
  };
}

/**
 * 从目录条目解析可选的商店展示信息。兼容字符串或对象形式的 author、i18n map 和多值字段；
 * 解析不到有效内容时返回 undefined，避免给每个条目挂空对象。
 *
 * 口径：i18n 字段必须是 {locale: string} 或 {locale: string[]}；requiresPaidPlan 只认字面 true。
 */
export function parseEntryStoreListing(
  entry: Record<string, unknown>,
): PluginStoreListing | undefined {
  const readString = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const readStringMap = (key: string): Record<string, string> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [locale, text] of Object.entries(value)) {
      if (typeof text === "string") map[locale] = text;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };
  const readStringListMap = (key: string): Record<string, string[]> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string[]> = {};
    for (const [locale, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue;
      const items = list.filter((item): item is string => typeof item === "string");
      if (items.length > 0) map[locale] = items;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const listing: PluginStoreListing = {};
  if (entry.publisherType === "official" || entry.publisherType === "community") {
    listing.publisherType = entry.publisherType;
  }
  const displayName = readString("displayName");
  if (displayName) listing.displayName = displayName;
  const displayNameI18n = readStringMap("displayName_i18n");
  if (displayNameI18n) listing.displayNameI18n = displayNameI18n;
  const descriptionI18n = readStringMap("description_i18n");
  if (descriptionI18n) listing.descriptionI18n = descriptionI18n;
  for (const key of [
    "icon",
    "category",
    "homepage",
    "privacyPolicy",
    "termsOfService",
    "heroImage",
  ] as const) {
    const value = readString(key);
    if (value) listing[key] = value;
  }
  const author = normalizeAuthorValue(entry.author);
  if (author?.name) listing.author = author.name;
  if (author?.url) listing.authorUrl = author.url;
  const examplePrompts = Array.isArray(entry.examplePrompts)
    ? entry.examplePrompts.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  if (examplePrompts && examplePrompts.length > 0) listing.examplePrompts = examplePrompts;
  const examplePromptsI18n = readStringListMap("examplePrompts_i18n");
  if (examplePromptsI18n) listing.examplePromptsI18n = examplePromptsI18n;
  // 付费套餐提示只认显式布尔 true；字符串 "true"、1 等歧义写法一律按无需套餐处理，
  // 避免目录写错就给免费插件挂上付费提示。
  if (entry.requiresPaidPlan === true) listing.requiresPaidPlan = true;
  return Object.keys(listing).length > 0 ? listing : undefined;
}

/** author 字段兼容 string 与 {name,url}（plugin.json 与目录条目共用此规则）。 */
export function normalizeAuthorValue(value: unknown): { name?: string; url?: string } | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name.length > 0 ? { name } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!name && !url) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
  };
}

/** 归一依赖声明：字符串或 {name,marketplace} 对象；空名返回 null，带市场则拼成 id。 */
function normalizeDependencyRef(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/@\^[^@]*$/u, "");
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const marketplace = typeof value.marketplace === "string" ? value.marketplace.trim() : "";
  return marketplace ? `${name}@${marketplace}` : name;
}

/** 在市场目录内按优先级查找 marketplace.json：显式路径 → 根目录 → .claude-plugin → .zcode-plugin。 */
function findMarketplaceManifestPath(rootPath: string, explicitPath?: string): string | null {
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    CLAUDE_MARKETPLACE_FILE,
    MARKETPLACE_FILE,
  ];
  for (const candidate of candidates) {
    const path = resolveInside(rootPath, candidate);
    if (path && fileExists(path)) return path;
  }
  return null;
}

/** 查找插件 manifest：根目录标准文件 → .claude-plugin/plugin.json → .zcode-plugin/plugin.json。 */
function findPluginManifestPath(rootPath: string): string | null {
  for (const candidate of [ZCODE_MANIFEST_PATH, CLAUDE_MANIFEST_PATH, CODEX_MANIFEST_PATH]) {
    const path = join(rootPath, candidate);
    if (fileExists(path)) return path;
  }
  return null;
}

// 缓存路径段与安装记录的版本来源。优先取插件落盘 plugin.json 里的真实
// version（与加载器 readPluginManifestFromRoot/index.ts 展示版本同源），缺失时才回退到 marketplace
// 条目的 version，最后兜底 DEFAULT_VERSION。读取失败保持宽松回退，校验交给 validateMarketplacePlugin。
function resolveInstalledPluginVersion(rootPath: string, entry: PluginMarketplaceEntry): string {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // 落到下方回退：manifest 不可读/非法时不应中断安装，版本以条目或默认值兜底。
    }
  }
  return entry.version ?? DEFAULT_VERSION;
}

/** 读取插件 manifest（JSON，失败返回 null）；用于校验、版本解析与 UI 回退元数据。 */
function readPluginManifestFromRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
): { manifest: PluginManifest; manifestPath?: string } | null {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      manifest: {
        ...parsed,
        name,
        version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      } as PluginManifest,
      manifestPath,
    };
  }
  if (entry.strict === false) {
    const rawManifest = createManifestFromMarketplaceEntry(entry);
    return {
      manifest: rawManifest as unknown as PluginManifest,
    };
  }
  return null;
}

/**
 * 校验插件根：manifest 存在性/合法性 → 版本兼容性 → MCP 定义校验 → 依赖声明诊断。
 * 返回结构化诊断（不抛出）；error 级诊断由调用方决定阻断安装。
 */
function validatePluginRoot(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
  storageRoot: string;
}): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(input.rootPath, input.entry);
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : String(error),
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  if (!loadedManifest) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${pluginId}`,
      path: input.rootPath,
      pluginId,
      severity: "error",
    });
    return diagnostics;
  }

  const manifestPath = loadedManifest.manifestPath ?? input.rootPath;
  if (loadedManifest.manifest.name !== input.entry.name) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: `Plugin manifest name '${loadedManifest.manifest.name}' does not match marketplace entry '${input.entry.name}'`,
      path: manifestPath,
      pluginId,
      severity: "error",
    });
  }
  pushManifestCompatibilityDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    pluginId,
    source: "cache",
  });
  pushMcpValidationDiagnostics({
    diagnostics,
    manifest: loadedManifest.manifest,
    manifestPath,
    marketplace: input.marketplace,
    pluginId,
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
  });
  return diagnostics;
}

/** 检查 manifest 的兼容性问题（非法 name/version、unsupported 字段）并追加 warning/error 诊断。 */
function pushManifestCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  pluginId: string;
  source: "cache" | "inline" | "official";
}): void {
  for (const key of UNSUPPORTED_MANIFEST_FIELDS) {
    if (key in input.manifest) {
      input.diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  for (const [key, option] of Object.entries(input.manifest.userConfig ?? {})) {
    if (option.required === true && option.default === undefined) {
      input.diagnostics.push({
        code: "plugin_variable_missing",
        message: `Required plugin userConfig has no default and must be configured: ${key}`,
        path: input.manifestPath,
        pluginId: input.pluginId,
        severity: "warning",
      });
    }
  }
  if (containsMcpBundleSource(input.manifest.mcpServers)) {
    input.diagnostics.push({
      code: "plugin_marketplace_source_unsupported",
      message: "MCPB/DXT plugin bundles are recognized but not supported in this runtime",
      path: input.manifestPath,
      pluginId: input.pluginId,
      severity: "warning",
    });
  }
}

/** 解析并校验 manifest 内 MCP 定义；单个 server 失败记 warning，不阻断插件。 */
function pushMcpValidationDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  pluginId: string;
  rootPath: string;
  storageRoot: string;
}): void {
  const diagnostics = input.diagnostics as PluginDiagnostic[];
  const loaded = {
    id: input.pluginId,
    manifest: input.manifest,
    manifestPath: input.manifestPath,
    marketplace: input.marketplace,
    rootPath: input.rootPath,
    source: "cache" as const,
  };
  const definitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
  resolvePluginMcpServers({
    dataPath: join(input.storageRoot, "data", sanitizePluginId(input.pluginId)),
    definitions,
    diagnostics,
    env: {},
    loaded,
    options: {},
    workingDirectory: process.cwd(),
  });
}

/** 递归判断 manifest 是否声明了 mcpServers（对象/数组/字符串任一形态）。 */
function containsMcpBundleSource(value: unknown): boolean {
  if (typeof value === "string") return value.endsWith(".mcpb") || value.endsWith(".dxt");
  if (Array.isArray(value)) return value.some(containsMcpBundleSource);
  return false;
}

/**
 * 条目形状校验：name 合法且唯一、source 可解析、字段类型正确；返回诊断列表。
 * 无 source 且 strict:false 允许合成；strict 条目必须能定位到实际插件。
 */
function validateMarketplaceEntryShape(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  options: { includeEntryCompatibility?: boolean } = {},
): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${entry.name}@${marketplace}`;
  if (entry.source === undefined) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Plugin has no install source: ${pluginId}`,
      pluginId,
      severity: "error",
    });
  }
  if (isRecord(entry.source)) {
    const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
    if (sourceKind === "npm" || sourceKind === "pip") {
      diagnostics.push({
        code: "plugin_marketplace_source_unsupported",
        message: `Plugin source is recognized but not supported in V1 install: ${sourceKind}`,
        pluginId,
        severity: "warning",
      });
    }
    if (sourceKind === "url") {
      const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
      if (sourceType && sourceType !== "git" && sourceType !== "zip") {
        diagnostics.push({
          code: "plugin_marketplace_source_unsupported",
          message: `Plugin URL source type is not supported: ${sourceType}`,
          pluginId,
          severity: "error",
        });
      }
      try {
        readRequiredPluginSourceString(entry.source, "url", "URL");
        if (sourceType === "zip") {
          const sha256 = readRequiredZipPluginSourceSha256(entry.source).toLowerCase();
          if (!SOURCE_SHA256_PATTERN.test(sha256)) {
            throw new Error("Plugin zip source sha256 must be a 64 character hex string");
          }
          readPluginSourceHeaders(entry.source);
          readOptionalZipPluginSourcePath(entry.source);
          readOptionalZipPluginSourceStripRoot(entry.source);
        }
      } catch (error) {
        diagnostics.push({
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId,
          severity: "error",
        });
      }
    }
  }
  if (options.includeEntryCompatibility !== false) {
    pushEntryCompatibilityDiagnostics({ diagnostics, entry, marketplace });
  }
  return diagnostics;
}

/** 条目级兼容性诊断：非法 version/name/依赖格式等追加 warning。 */
function pushEntryCompatibilityDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry: PluginMarketplaceEntry;
  marketplace: string;
}): void {
  const pluginId = `${input.entry.name}@${input.marketplace}`;
  pushManifestCompatibilityDiagnostics({
    diagnostics: input.diagnostics,
    manifest: createManifestFromMarketplaceEntry(input.entry) as unknown as PluginManifest,
    manifestPath: pluginId,
    pluginId,
    source: "cache",
  });
}

/**
 * 市场源校验的“延迟”判定：远端 git/GitHub 源在 dry-run 时不 clone（成本高、需网络），
 * 改为返回 plugin_validation_deferred 诊断；本地源返回 null 继续完整校验。
 */
function getMarketplaceSourceValidationDeferral(
  entry: PluginMarketplaceEntry,
  marketplace: string,
): PluginValidationDiagnostic | null {
  if (!isRecord(entry.source)) return null;
  const sourceKind = typeof entry.source.source === "string" ? entry.source.source : "";
  if (sourceKind === "url") {
    const sourceType = typeof entry.source.type === "string" ? entry.source.type : "";
    if (sourceType && sourceType !== "git" && sourceType !== "zip") return null;
  }
  if (!["github", "git", "url", "git-subdir"].includes(sourceKind)) return null;
  const pluginId = `${entry.name}@${marketplace}`;
  const sourceLabel =
    typeof entry.source.repo === "string"
      ? entry.source.repo
      : typeof entry.source.url === "string"
        ? entry.source.url
        : sourceKind;
  return {
    code: "plugin_validation_deferred",

    // 聚合市场可能包含大量外部 git source；市场级 validate 不逐个 clone，单插件安装或校验时
    // 再深扫目标 root，避免设置页被网络操作拖到协议超时。
    message: `Remote plugin source validation is deferred until install or single-plugin validate: ${sourceLabel}`,
    pluginId,
    severity: "warning",
  };
}

/** 从 manifest 解析依赖闭包，失败转成单条 error 诊断（用于市场整体校验）。 */
function pushDependencyDiagnosticsFromManifest(input: {
  diagnostics: PluginValidationDiagnostic[];
  manifest: PluginMarketplaceManifest;
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    resolveDependencyClosureFromManifest({
      allowCrossMarketplaces: new Set(input.manifest.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      manifest: input.manifest,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}

/**
 * 基于已解析 manifest 的依赖闭包展开（内存版）：跨市场白名单校验、环检测、缺失检测，
 * 返回拓扑序 id 列表；供市场级 dry-run 校验复用，避免再次读盘。
 */
function resolveDependencyClosureFromManifest(input: {
  allowCrossMarketplaces: ReadonlySet<string>;
  marketplace: string;
  manifest: PluginMarketplaceManifest;
  name: string;
  storageRoot: string;
}): string[] {
  const rootId = `${input.name}@${input.marketplace}`;
  const closure: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();

  const loadManifest = (marketplace: string): PluginMarketplaceManifest | null =>
    marketplace === input.marketplace
      ? input.manifest
      : loadMarketplaceManifestSync(input.storageRoot, marketplace);

  const walk = (pluginId: string, requiredBy: string): void => {
    const { marketplace, name } = parsePluginId(pluginId);
    if (marketplace !== input.marketplace && !input.allowCrossMarketplaces.has(marketplace)) {
      throw new Error(
        `Cross-marketplace dependency is blocked: ${pluginId} required by ${requiredBy}`,
      );
    }
    if (visiting.includes(pluginId)) {
      // 环检测必须在 visited 判断之前：走回头路时该节点还没被标记 visited，
      // 顺序反过来会先命中 visited 把环当成「已处理」，最终闭包里静默少一个依赖。
      throw new Error(`Plugin dependency cycle: ${[...visiting, pluginId].join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;

    const manifest = loadManifest(marketplace);
    if (!manifest) throw new Error(`Marketplace not found for dependency: ${marketplace}`);
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (!entry) throw new Error(`Dependency not found: ${pluginId} required by ${requiredBy}`);

    visiting.push(pluginId);
    for (const dependency of entry.dependencies ?? []) {
      // 依赖 id 先补全为 `name@marketplace` 再递归：不补全就会被当成「无归属的裸名」，
      // 后续 parsePluginId 会按当前市场解释，跨市场依赖被静默改成同市场查找而报「找不到」。
      walk(qualifyDependency(dependency, marketplace), pluginId);
    }
    visiting.pop();
    // push 放在所有依赖之后 = 拓扑序（依赖在前）；放到进入时 push 会得到反序，
    // 安装时先装依赖方、后装依赖（INV-7）。
    visited.add(pluginId);
    closure.push(pluginId);
  };

  walk(rootId, rootId);
  return closure;
}

/** 单条目依赖闭包校验包装：成功不产出诊断，失败转一条 error 诊断。 */
function pushDependencyDiagnostics(input: {
  diagnostics: PluginValidationDiagnostic[];
  marketplace: string;
  name: string;
  storageRoot: string;
}): void {
  try {
    const rootManifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    resolveDependencyClosure({
      allowCrossMarketplaces: new Set(rootManifest?.allowCrossMarketplaceDependenciesOn ?? []),
      marketplace: input.marketplace,
      name: input.name,
      storageRoot: input.storageRoot,
    });
  } catch (error) {
    input.diagnostics.push(toValidationDiagnostic(error, `${input.name}@${input.marketplace}`));
  }
}

/**
 * 错误→诊断映射：不支持源→plugin_marketplace_source_unsupported；源错误码优先；
 * 依赖相关按 message 关键字分类；其余归 plugin_marketplace_invalid。优先级自上而下。
 */
function toValidationDiagnostic(error: unknown, pluginId?: string): PluginValidationDiagnostic {
  if (
    error instanceof UnsupportedMarketplaceSourceError ||
    error instanceof UnsupportedPluginSourceError
  ) {
    return {
      code: "plugin_marketplace_source_unsupported",
      message: error.message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return {
      code: sourceCode,
      message: error instanceof Error ? error.message : String(error),
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cross-marketplace dependency")) {
    // 这些字符串匹配依赖下方依赖解析器抛出的固定措辞。改错误文案时两处必须同步，
    // 否则跨市场依赖会被归到 plugin_marketplace_invalid，UI 给出错误的修复建议。
    return {
      code: "plugin_dependency_cross_marketplace",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (message.includes("dependency cycle")) {
    return {
      code: "plugin_dependency_cycle",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return {
      code: "plugin_dependency_missing",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  return {
    code: "plugin_marketplace_invalid",
    message,
    ...(pluginId ? { pluginId } : {}),
    severity: "error",
  };
}

/** 已识别但运行时无法实现的 marketplace 来源（npm/hostPattern 等），映射为 source_unsupported。 */
class UnsupportedMarketplaceSourceError extends Error {
  constructor(source: string) {
    super(`Marketplace source is recognized but not supported in this runtime: ${source}`);
  }
}

/** 已识别但运行时无法实现的插件来源（pip 等），映射为 source_unsupported。 */
class UnsupportedPluginSourceError extends Error {
  constructor(source: string) {
    super(`Plugin source is recognized but not supported in this runtime: ${source}`);
  }
}

/** 类型守卫：已归一 manifest 必须含字符串 name、数组 plugins 与对象 raw。 */
function isPluginMarketplaceManifest(value: unknown): value is PluginMarketplaceManifest {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.plugins) &&
    isRecord(value.raw)
  );
}

/** 同步读 JSON，先做原子恢复；解析/读取失败返回 undefined（调用方按缺省处理）。 */
// 不抛错：这些调用点都在启动或加载路径上，文件不存在（首次运行）、半写损坏
// 都是预期情况，抛错会直接阻断启动；返回 undefined 让调用方按「无数据」重建。
function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** 原子写 JSON（2 空格缩进 + 末尾换行），避免进程崩溃留下半写文件。 */
// 真正保证一致性的是 writeFileAtomically；缩进与末尾换行只是为了用户在 bug 报告里
// 贴出状态文件时可读。格式不能省掉换行，否则 tail/cat 输出会与下一条日志粘连。
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 安装缓存路径：`<storageRoot>/cache/<marketplace>/<name>/<version>`，各段经 sanitizePluginId。 */
function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  // 三个可变段全部 sanitize：marketplace/name/version 都来自远端 manifest，version 还可能带
  // `/`（如 `1.0/beta`），不净化会直接跳到别的目录层级（INV-3 的落盘侧）。
  // storageRoot 是宿主传入的可信根，不能再 join 一层净化结果，否则路径会与真实存储根错位。
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

/** 插件数据目录：`<storageRoot>/data/<sanitized 插件 id>`，卸载时按 keepData 决定是否删除。 */
export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPluginsSync 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

/** 类型守卫：known 记录必需 id/name/pluginCount 且 source 为对象（其余字段在读取后校验）。 */
function isKnownMarketplaceRecord(value: unknown): value is KnownMarketplaceRecord {
  // 只校验「不能缺失」的字段：source 留到读取后按 kind 再校验，
  // 因为它是判别联合，在这里展开会让守卫与来源种类强耦合，新增来源必须改两处。
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.pluginCount === "number" &&
    isRecord(value.source)
  );
}

/** 类型守卫：安装记录必需 id/name/marketplace/version/installPath/installedAt 与合法 scope。 */
function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  // scope 必须严格等于 user/workspace：这里放过 project/local 会让后续 normalize 之外的
  // 读写路径拿到未归一的值，卸载时按 scope 匹配失败，记录删不掉。
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.marketplace === "string" &&
    typeof value.version === "string" &&
    typeof value.installPath === "string" &&
    typeof value.installedAt === "string" &&
    (value.scope === "user" || value.scope === "workspace")
  );
}

/** 解析 `<name>@<marketplace>`（用最后一个 @，允许插件名含 @）；格式非法抛错。 */
function parsePluginId(pluginId: string): { marketplace: string; name: string } {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) {
    throw new Error(`Plugin id must use <name>@<marketplace>: ${pluginId}`);
  }
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

/** 依赖 id 补全：未带 @marketplace 时使用当前市场（同市场依赖可省略市场名）。 */
function qualifyDependency(dependency: string, marketplace: string): string {
  return dependency.includes("@") ? dependency : `${dependency}@${marketplace}`;
}

/**
 * 判断输入是否“像路径”（./ ../ / ~ 盘符）；是则返回展开后的绝对路径，否则 null。
 * 注意：~ 的展开使用 HOME，未设置时退化为根相对路径。
 */
function resolvePathInput(input: string): string | null {
  if (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    /^[a-zA-Z]:[/\\]/.test(input)
  ) {
    return input.startsWith("~") ? join(process.env.HOME ?? "", input.slice(1)) : resolve(input);
  }
  return null;
}

/** 按最后一个 `#` 拆出 ref（URL fragment 语义用于 git ref）；无则 ref 缺省。 */
function splitRef(input: string): { ref?: string; url: string } {
  const index = input.lastIndexOf("#");
  if (index < 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

/** `owner/repo@ref` 简写拆分：取最后一个 @ 或 # 的位置，前缀为仓库、后缀为 ref。 */
function splitGitHubShorthand(input: string): { ref?: string; url: string } {
  const hash = input.lastIndexOf("#");
  const at = input.lastIndexOf("@");
  const index = Math.max(hash, at);
  if (index <= 0) return { url: input };
  return { url: input.slice(0, index), ref: input.slice(index + 1) };
}

/** 识别 scp-like SSH 地址（user@host:path），用于避免误当成 shorthand。 */
function isGitSshUrl(input: string): boolean {
  return /^[a-zA-Z0-9._-]+@[^:]+:.+/.test(input);
}

/** 尝试解析 URL；非法返回 null（调用方据此走 shorthand/路径分支）。 */
function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}
