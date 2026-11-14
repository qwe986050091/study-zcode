// 插件子系统在 Bootstrap 层的统一门面：市场（marketplace）目录、插件目录/商店信息、
// 启用开关、安装/更新/卸载/恢复、配置项写入。
//
// 三层身份与来源：
// - marketplace：由 known 记录（Host 已物化）与 User 配置声明（extraKnownMarketplaces）合并；
//   同 id 不同 source 一律 fail closed（只出诊断、不读取缓存），官方 id 为保留身份；
// - plugin：id 固定为 `${name}@${marketplace}`，同名不同市场互不覆盖；
// - 内置官方插件：资产随 CLI 分发，不写入 installed_plugins.json；「卸载」只是写 suppressed
//   标记，Catalog/cache 保留，便于离线详情与一键恢复。
//
// 写操作口径：
// - 所有会改插件存储的操作经 withPluginStorageLock 串行化（单进程 promise-chain，不是跨进程锁）；
// - install/update/uninstall 失败不抛异常，转成 diagnostics 返回（供 UI 展示）；
//   参数错误（如未安装、市场不存在、名称歧义）才直接 throw；
// - 启用态默认只补「用户配置里尚未显式声明」的 id，绝不覆盖用户的显式选择；
// - workspace scope 仅影响配置文件落点，Marketplace 安装/记录始终写 User inventory。
// 模块职责：把插件适配器与配置适配器的能力收敛为 Bootstrap 层可复用的门面，读投影与写编排都在这里对齐。
// 边界：本文件只做选择、投影与诊断归一；克隆、复制、目录解析和原子写盘全部下沉到适配器。
// 状态所有权：known marketplace 记录与 installed_plugins.json 归适配器，enabled/suppressed/options 归配置文件。
// 调用约定：读路径无锁且可重入，写路径必须落在 withPluginStorageLock 的 promise-chain 语义内。
// INV-01 插件 id 恒为 `${name}@${marketplace}`，所有关联按完整 id 而非裸 name；守住位置：resolvePluginSelector 与 toAvailablePluginData；改错故障：同名插件互相覆盖，用户装错或卸错插件。
// INV-02 marketplace 同 id 异 source 必须 fail closed，只出诊断且禁用缓存；守住位置：resolveEffectiveMarketplaceRecords 与 overview 的 manifest 读取分支；改错故障：把旧来源目录展示成新来源，安装落到错误仓库。
// INV-03 官方 marketplace id 是 Host 保留身份，项目声明不可重定向；守住位置：resolveEffectiveMarketplaceRecords 的 isOfficialMarketplaceId 分支；改错故障：项目配置能劫持官方插件源，形成供应链风险。
// INV-04 所有改动插件存储的操作在单进程 promise-chain 锁内串行；守住位置：uninstall、restore、install 公开入口；改错故障：并发 read-modify-write 丢失启用态或安装记录。
// INV-05 已持锁的调用方必须走无锁核心 restoreBuiltinPluginCore，不得二次加锁；守住位置：installZCodeMarketplacePlugin 的 suppressed 分支；改错故障：同一 storageRoot 等待自身，进程永久阻塞。
// INV-06 installed_plugins.json 是 marketplace 插件所有权的唯一权威；守住位置：uninstallZCodeMarketplacePlugin 的 installedRecord 判定；改错故障：CDN 插件被误判为内置，只写抑制导致界面永远显示已安装。
// INV-07 内置插件的卸载只写 suppressed 并保留 Catalog 与不可变 cache；守住位置：uninstall 的 builtin 分支；改错故障：离线详情不可读，恢复需要重新下载。
// INV-08 install、update、uninstall 的仓储失败必须转成 diagnostics，参数错误才抛；守住位置：installZCodeMarketplacePlugin 的 catch 与 toMarketplaceInstallDiagnostic；改错故障：界面无法批量展示问题，首个失败即中断整条命令。
// INV-09 默认启用只补用户配置里未显式声明的 id；守住位置：enablePluginsByDefaultInFileConfig 的调用点；改错故障：用户手动停用的插件在重装后被重新打开。
// INV-10 Marketplace 安装与安装记录始终归 User inventory，scope 只影响配置文件落点；守住位置：install 的 scope=user 与 resolvePluginConfigPath；改错故障：兼容参数污染全局 inventory 或反写 workspace override。
// INV-11 配置读取必须复用调用方传入的 configResult，只有写盘之后才重读；守住位置：resolvePluginContext 与 restoreBuiltinPluginCore 的 fresh 读取；改错故障：同一请求内前后判断基于两份不同配置快照。
// INV-12 workspace 写入固定到当前工作目录的 .zcode/config.json，而非发现到的最外层文件；守住位置：resolvePluginConfigPath；改错故障：内层配置继续盖住修改，用户看到开关不生效。
// INV-13 相对 file 与 directory 市场源以 User 配置所在目录为基准解析；守住位置：resolveDeclaredMarketplaceSource；改错故障：路径按 cwd 解析导致换目录后市场失效。
// INV-14 refresh-all 只刷新 Host known 记录，项目声明必须显式物化；守住位置：resolveMarketplaceRefreshTargetIds；改错故障：一次全量刷新把 workspace 声明写进全局状态。
// INV-15 单市场刷新失败只降级为诊断，不阻断其余市场；守住位置：updateZCodePluginMarketplace 的目标循环；改错故障：一个坏源让所有市场都无法更新。
// INV-16 插件 options 只接受 string、number、boolean，其余类型静默丢弃；守住位置：normalizePluginOptions；改错故障：对象或密钥明文写入普通配置文件。
// INV-17 workspace scope 的配置重置只删 enabled，保留 options 与 secret；守住位置：resetZCodePluginConfig 的分支；改错故障：恢复继承顺手抹掉用户在该 workspace 的参数。
// INV-18 可恢复内置集合等于官方定义与 suppressedBuiltins 的交集，computer-use 还需功能开关；守住位置：overview 的 restorableBuiltins；改错故障：展示无法恢复的入口，或协议绕过界面写盘。
// INV-19 详情与计数投影只读缓存，不触发刷新、安装或写入；守住位置：getZCodePluginsOverview 与 describeZCodePlugin；改错故障：打开设置页就产生网络请求与磁盘写入。
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  addSuppressedBuiltinInFileConfig,
  createConfig,
  resolvePath,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
  type ConfigResult,
} from "@zcode/adapters/config";
import {
  addMarketplace,
  comparePluginUpdate,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  discoverNodePluginsSync,
  ensureMarketplaceManifestAvailable,
  getPluginSourceDiagnosticCode,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  parseMarketplaceSourceInput,
  parseEntryStoreListing,
  readPluginSourceIdentityPin,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginMarketplaceEntry,
} from "@zcode/adapters/plugins";
import type {
  Logger,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginStoreListing,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, isOfficialMarketplaceId } from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "./app/official-plugin-definitions.js";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";
import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";

// [契约] 该 options 同时服务读与写：configResult 复用、env 注入、storageRoot 与配置路径覆盖。
// [权衡] configResult 传入即跳过 createConfig，避免同一次请求里出现两份配置快照。
// [资源] pluginStorageRoot 缺省由 CLI storage root 派生，缓存、安装记录与 data 目录共享同一根。
// [边界] 路径类覆盖只改配置与落盘位置，不改变 marketplace 记录的 Host 归属。
export interface ResolveZCodePluginsOptions {
  /** 已解析配置；传入时跳过 createConfig（供上层复用同一次读取）。 */
  configResult?: ConfigResult;
  /** 环境变量表；影响配置、CUA 功能开关与插件运行器环境。 */
  env?: NodeJS.ProcessEnv;
  /** 插件发现/缓存锁降级等诊断日志出口。 */
  logger?: Logger;
  /** 额外内置插件根（测试或私有分发）；与 bundled roots 一起参与发现。 */
  officialPluginRoots?: string[];
  /** 插件存储根覆盖；缺省由 CLI storage root 派生（缓存/安装记录/data 都在这下面）。 */
  pluginStorageRoot?: string;
  /** 项目配置路径覆盖。 */
  projectConfigPath?: string;
  /** 跳过用户级配置（隔离/受限会话）。 */
  skipUserConfig?: boolean;
  /** 用户配置路径覆盖。 */
  userConfigPath?: string;
  /** 工作目录基准；决定项目配置发现与 workspace 配置落点。 */
  workingDirectory?: string;
}

export interface ListZCodePluginsOptions extends ResolveZCodePluginsOptions {}

export interface SetZCodePluginEnabledOptions extends ResolveZCodePluginsOptions {
  /** 目标启用态；写入的是用户/项目配置文件里的 enabledPlugins。 */
  enabled: boolean;
  /** 插件 id 或唯一 name；歧义名称会抛错，要求改用完整 id。 */
  plugin: string;
  /** 配置落点；缺省 user（workspace 时写 <cwd>/.zcode/config.json）。 */
  scope?: "user" | "workspace";
}

export interface SetZCodePluginEnabledResult {
  /** 实际写入后的启用态（可能与入参不同，若配置层做了规范化）。 */
  enabled: boolean;
  /** 被修改的配置文件路径。 */
  path: string;
  /** 写入后的插件元数据快照，enabled 已同步。 */
  plugin: PluginMetadata;
}

export interface ZCodeMarketplaceSummaryData {
  /** 市场 id；官方 id 为保留身份，不能被项目声明重定向。 */
  id: string;
  name: string;
  /** 来源快照（git/github/file/directory）；仅展示用途，不用于重新抓取判定。 */
  source: Record<string, unknown>;
  description?: string;
  /** 上次成功物化的时间；缺省表示尚未刷新/物化。 */
  lastUpdated?: string;
  /** 用户可见条目数（官方市场会排除 node-repl-host 宿主条目）。 */
  pluginCount: number;
  isOfficial: boolean;
  /** 上次刷新失败：只做展示与诊断，不阻断已缓存目录的使用。 */
  refreshFailure?: {
    code: string;
    failedAt: string;
    message: string;
  };
  // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区），随 manifest 下发。
  featured?: string[];
}

export interface ZCodeAvailablePluginData {
  /** 完整 id `${name}@${marketplace}`；installed 判定按完整 id，不做裸名匹配。 */
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  /** 目录条目当前版本；可能只有 sha 来源，故允许缺席。 */
  version?: string;
  installed: boolean;
  /** 从 manifest 结构推断的能力类型（agent/command/skill/hook/mcp/lsp/ui）。 */
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  // 商店信息（显示名/icon/分类/作者/链接/hero/示例提示词），来自目录条目。
  listing?: PluginStoreListing;
}

export interface ZCodeInstalledPluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  /** 已加载的运行态版本优先，其次安装记录版本。 */
  version?: string;
  /** 用户配置的启用态（安装默认启用只补未声明的 id）。 */
  enabled: boolean;
  scope: "user" | "workspace";
  /** 实际安装目录；内置插件指向不可变 cache。 */
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  /** 更新检测结果：none / 有更新 / 同版本但内容变化（sha 轴）。 */
  updateStatus?: "none" | "update-available" | "version-changed";
  /** 展示用最新版本标签：优先 manifest version，否则短 sha。 */
  latestVersion?: string;
  // 已安装插件的商店信息由目录条目按 id join 得到（市场被移除时缺失，UI 走降级）。
  listing?: PluginStoreListing;
}

// [契约] overview 是设置页的唯一读投影：市场、可安装、已安装、可恢复与诊断一次性给出。
// [权衡] 五段数据必须来自同一轮读取，避免界面拼接时看到互相矛盾的已安装态与市场摘要。
// [边界] diagnostics 合并发现诊断、声明冲突诊断与 known 记录里的 lastRefreshFailure。
// [失败路径] 任一段为空只代表该段无数据，不等价于加载失败，界面需按 code 区分。
export interface ZCodePluginsOverviewData {
  /** 市场摘要（含失败信息与 featured）。 */
  marketplaces: ZCodeMarketplaceSummaryData[];
  /** 目录里可安装的条目（按完整 id 关联已安装态）。 */
  availablePlugins: ZCodeAvailablePluginData[];
  installedPlugins: ZCodeInstalledPluginData[];
  /** 被抑制（卸载）的内置插件：仅存在于 Runtime 抑制投影，可一键恢复。 */
  restorableBuiltins: ZCodeAvailablePluginData[];
  /** 插件发现 + 市场声明 + 最近刷新失败合并后的诊断。 */
  diagnostics: PluginLoadOutcome["diagnostics"];
}

export interface ZCodeMarketplaceUpdateData {
  diagnostics: PluginLoadOutcome["diagnostics"];
  marketplaces: ZCodeMarketplaceSummaryData[];
}

export interface AddZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  /** 取消信号；仅影响网络/复制阶段，已写入的 known 记录不会回滚。 */
  abortSignal?: AbortSignal;
  /** 只解析并回显 source，不读取/复制/联网，也不写 known 列表。 */
  dryRun?: boolean;
  /** 用户输入的 source 字符串（路径/URL/owner/repo 等），由适配器解析类型。 */
  source: string;
  /** `marketplace add --sparse`：仅 git/github 源支持 sparse checkout 子目录。 */
  sparsePaths?: string[];
}

export interface RemoveZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
}

export interface UpdateZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  marketplace?: string;
}

export interface InstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  /** 只做校验/诊断，不下载也不写安装记录。 */
  dryRun?: boolean;
  /** 目标市场 id；条目名必须在该市场 manifest 中唯一。 */
  marketplace: string;
  pluginName: string;
  /** 兼容旧协议的字段：Marketplace 安装记录始终属于 User inventory，不随此值改变。 */
  scope?: "user" | "workspace";
}

export interface UninstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  /** 完整 id 优先；与 pluginName+marketplace 二选一。 */
  pluginId?: string;
  pluginName?: string;
  marketplace?: string;
  /** 缺省 true：同时删除 cache；显式 false 才保留缓存。 */
  removeCache?: boolean;
  /** 保留 data/<plugin-id> 用户数据目录（`zcode plugins uninstall --keep-data`）。 */
  keepData?: boolean;
}

export interface UpdateZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  pluginId: string;
}

export interface ValidateZCodePluginPathOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  path: string;
}

export interface ZCodePluginUpdateData extends ZCodePluginInstallData {
  /** 更新前的版本，供 UI 展示 from→to；无版本（sha 来源）时为空串。 */
  previousVersion: string;
}

export interface RestoreBuiltinPluginOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
}

export interface ConfigureZCodePluginOptions extends ResolveZCodePluginsOptions {
  /** 需要显式清除的键（与 options 合并写入，避免 undefined 被当成保留）。 */
  clearOptionKeys?: string[];
  dryRun?: boolean;
  /** 只接受 string/number/boolean；其它类型被静默丢弃（secret 走独立通道）。 */
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ResetZCodePluginConfigOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ValidateZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface DescribeZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
  pluginName: string;
  /** 注入写锁实现（协议层可能已持有同一 storageRoot 的锁，避免二次加锁死锁）。 */
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}

export interface ZCodePluginInstallData {
  /** 本次安装解析出的依赖闭包（含自身），按解析顺序；卸载时用于提示连带项。 */
  dependencyClosure: string[];
  /** 安装后可展示的已安装条目（含默认启用结果）。 */
  installedPlugins: ZCodeInstalledPluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

/**
 * 市场插件计数只数用户可见条目。
 *
 * node-repl-host 是 Browser Use 与 Computer Use 共用的运行时宿主：它必须留在官方 manifest 里
 * （否则不会被发现、安装、启用），但没有 skill、没有 listing，也不该出现在设置页。计进去会让
 * 显示的插件数比它能列出的条目多一个。
 *
 * 判据故意是「官方市场里的这个具名条目」，而不是「没有 listing 的条目」—— 后者会误伤第三方
 * 市场：自定义 manifest 里的条目本来就可以不带 listing，它们是真实可见的插件。
 */
// [契约] 计数口径是用户可见条目，官方市场需排除 node-repl-host 宿主条目。
// [权衡] 判据用官方市场里的具名条目而非没有 listing 的条目，否则会误伤第三方无 listing 插件。
// [失败路径] manifest 缺失时返回 undefined，由调用方回退到 known 记录的 pluginCount。
function countVisibleMarketplacePlugins(
  marketplaceId: string,
  plugins: readonly { name: string }[] | undefined,
): number | undefined {
  if (!plugins) return undefined;
  if (marketplaceId !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return plugins.length;
  return plugins.filter((entry) => entry.name !== OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME).length;
}

/**
 * 纯发现：合并配置 + bundled official roots + 已安装记录，返回运行态插件与诊断。
 *
 * 不写任何文件（不 seed 市场、不建目录）；缓存锁冲突只降级为 diagnostic，不阻断发现。
 * 已抑制的官方插件不会出现在 plugins 中（由 resolveOfficialPluginRoots 过滤），
 * 需要「可恢复」信息请走 overview。
 */
// [契约] 纯发现：只读配置、bundled roots 与安装记录，不写文件、不 seed 市场。
// [资源] bundled roots 的 cache 锁冲突降级为 diagnostic，不阻断普通插件入口。
// [权衡] suppressed 内置插件在此被过滤掉，可恢复信息必须走 overview 而不是这里。
// [并发] 同步发现不持有存储锁，因此只能读取已经原子落盘的配置与缓存快照。
export function resolveZCodePlugins(options: ResolveZCodePluginsOptions = {}): PluginLoadOutcome {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);

  return discoverNodePluginsSync({
    config: configResult.config.plugins,
    env: options.env ?? process.env,
    officialPluginRoots: resolveOfficialPluginRoots({
      extraRoots: options.officialPluginRoots,
      // cache 锁冲突已从 fatal 改为 degraded，普通插件入口也必须保留诊断日志。
      logger: options.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
    }),
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory,
  });
}

/**
 * 设置页/商店的总投影：市场摘要、可安装条目、已安装条目、可恢复内置与诊断。
 *
 * 组装顺序固定：
 * 1. ensureDefaultPluginMarketplaces 先 seed 官方市场（幂等，失败不影响后续）；
 * 2. resolveZCodePlugins 得到运行态；known 记录与 User 声明合并成 effective 市场；
 *    useCachedManifest=false 表示「声明存在但从未物化/来源不一致」，不读取旧缓存；
 * 3. 每个 manifest 只读一次，同时取 entries、featured 与可见条目数；
 * 4. 收集每个插件的 version/sha 最新 pin 与 listing，供已安装条目 join；
 * 5. restorableBuiltins = 官方定义 ∩ suppressedBuiltins（computer-use 还需功能开关）；
 * 6. diagnostics = 发现诊断 + 声明冲突 + known 记录里的 lastRefreshFailure。
 *
 * 只读，不触发 marketplace 刷新或插件加载。
 */
export function getZCodePluginsOverview(
  options: ResolveZCodePluginsOptions = {},
): ZCodePluginsOverviewData {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const effectiveMarketplaces = resolveEffectiveMarketplaceRecords({
    configResult,
    known,
    workingDirectory,
  });
  const marketplaceDeclarationDiagnostics = resolveMarketplaceDeclarationDiagnostics({
    configResult,
    known,
    workingDirectory,
  });
  // [事务] 安装记录只在本次 overview 开头读一次，后续 id 关联与更新检测都基于这份快照。
  // [权衡] 单次快照避免遍历目录时安装态漂移，代价是并发安装要到下次 overview 才可见。
  // [失败路径] 快照为空时所有可安装条目都显示未安装，但不会误删已有记录。
  const installed = listInstalledPluginRecords(pluginStorageRoot);
  const installedIds = new Set(installed.map((record) => record.id));

  // 每个市场的 manifest 只读一次：同时取 entries（目录条目）与 featured（策展名单）。
  // zcode-plugins-official 的内置与 CDN 分片已在 adapter 层合并为唯一 canonical manifest。
  const catalogs: Array<{
    summary: ZCodeMarketplaceSummaryData;
    entries: PluginMarketplaceEntry[];
  }> = [];
  // [安全] useCachedManifest 为假表示声明存在但从未物化或来源冲突，此时禁止读旧缓存。
  // [失败路径] manifest 为 null 时目录为空，宁可少展示也不展示错误来源的内容。
  // [资源] 每个市场只读取一次 manifest，同一次循环内同时取 entries、featured 与可见条目数。
  // [契约] 官方 id 即使声明冲突也保留缓存，避免保留身份被项目配置清空。
  for (const { record, useCachedManifest } of effectiveMarketplaces) {
    // Marketplace source 只来自 User/Host 配置。只有目标 Host 已经通过显式 refresh/install
    // 物化了同一 source 时，才读取 Host cache；同 id 不同 source 必须 fail closed，避免
    // 不同 Host 或旧配置误用错误的全局 marketplace 快照。
    const manifest = useCachedManifest
      ? loadMarketplaceManifestSync(pluginStorageRoot, record.id)
      : null;
    catalogs.push({
      summary: toMarketplaceSummaryData(
        record,
        manifest?.featured,
        countVisibleMarketplacePlugins(record.id, manifest?.plugins),
      ),
      entries: manifest?.plugins ?? [],
    });
  }

  // 边遍历 marketplace catalog 边记录每个插件 id 的最新「版本 pin」用于更新检测。

  // 条目可能只有 version、只有 sha 或两者兼有，因此同时收集 version 与 sha
  // 两个轴，由 comparePluginUpdate 决定用哪条轴比对 installed 记录。
  // [事务] 最新版本 pin 在同一轮目录遍历中收集，version 与 sha 两个轴并存。
  // [权衡] 同 id 多条目录条目按遍历顺序后者覆盖，跨市场同名条目靠完整 id 天然隔离。
  // [契约] 由 comparePluginUpdate 决定用版本轴还是 sha 轴比对已安装记录。
  const latestPinByPluginId = new Map<string, { version?: string; sha?: string }>();
  // 同时按 id 收集目录条目的商店信息，供已安装插件 join（详情/图标条/管理视图共用）。
  const listingByPluginId = new Map<string, PluginStoreListing>();
  const availablePlugins = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => {
      const data = toAvailablePluginData(entry, catalog.summary.id, installedIds);
      latestPinByPluginId.set(data.id, {
        ...(entry.version ? { version: entry.version } : {}),
        ...(readPluginSourceIdentityPin(entry.source)
          ? { sha: readPluginSourceIdentityPin(entry.source) }
          : {}),
      });
      if (entry.listing) listingByPluginId.set(data.id, entry.listing);
      return data;
    }),
  );
  const loadedById = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));

  // 被抑制（uninstall）的内置（官方）插件可一键恢复：从 OFFICIAL_PLUGIN_DEFINITIONS
  // 里挑出 id 落在 suppressedBuiltins 集合内的，映射成 available 形态供 UI 的「恢复」入口使用。
  // 完整 Catalog/cache 仍然保留，restorable 只是 Runtime 抑制态的投影，商店信息直接取定义里的 listing seed。
  const suppressed = new Set(configResult.config.plugins.suppressedBuiltins);
  // [契约] 可恢复集合等于官方定义与 suppressedBuiltins 的交集，只是抑制态的投影。
  // [安全] computer-use 的恢复入口还要求 internal 特性开启，与 restoreBuiltinPluginCore 同口径。
  // [权衡] listing 直接取定义里的种子数据，保证市场被移除后详情仍可展示。
  // [回归] componentTypes 必须透传，否则卸载后插件会从 UI 插件掉回普通分组。
  const restorableBuiltins: ZCodeAvailablePluginData[] = OFFICIAL_PLUGIN_DEFINITIONS.filter(
    (def) =>
      suppressed.has(`${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`) &&
      // computer-use 的恢复入口需要 internal 特性开启（与 restoreBuiltinPluginCore 同口径）。
      (def.name !== "computer-use" || isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)),
  ).map((def) => {
    const listing = def.listing
      ? parseEntryStoreListing({ name: def.name, ...def.listing })
      : undefined;
    return {
      id: `${def.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      name: def.name,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      version: def.version,
      installed: false,
      // Bugfix：可恢复条目只带 listing 时丢了 "ui"，卸载后的文档插件从「UI 插件」掉进分类分组。
      ...(def.componentTypes ? { componentTypes: [...def.componentTypes] } : {}),
      ...(listing ? { listing } : {}),
    };
  });

  return {
    marketplaces: catalogs.map((catalog) => catalog.summary),
    availablePlugins,
    installedPlugins: installed.map((record) => {
      const enabled = configResult.config.plugins.enabledPlugins[record.id] ?? false;
      const data = toInstalledPluginData(record, enabled, loadedById.get(record.id));
      const pin = latestPinByPluginId.get(record.id);
      const installedSha = readPluginSourceIdentityPin(record.source);
      const updateStatus = comparePluginUpdate({
        installedVersion: data.version,
        installedSha,
        latestVersion: pin?.version,
        latestSha: pin?.sha,
      });
      // latestVersion 展示：优先用 manifest 的 version；否则用最新 sha（短 7 位）让 UI 有可读提示。
      const latestLabel = pin?.version ?? (pin?.sha ? pin.sha.slice(0, 7) : undefined);
      const listing = listingByPluginId.get(record.id);
      return {
        ...data,
        updateStatus,
        ...(latestLabel ? { latestVersion: latestLabel } : {}),
        ...(listing ? { listing } : {}),
      };
    }),
    restorableBuiltins,
    diagnostics: [
      ...outcome.diagnostics,
      ...marketplaceDeclarationDiagnostics,
      ...known.flatMap((record): PluginLoadOutcome["diagnostics"] =>
        record.lastRefreshFailure
          ? [
              {
                code: record.lastRefreshFailure.code,
                message: record.lastRefreshFailure.message,
                pluginId: record.id,
                severity: "error",
              },
            ]
          : [],
      ),
    ],
  };
}

// 图标补齐是可选展示增强：fire-and-forget，不阻塞 overview；只把写回阶段包进存储锁，
// 避免与安装/卸载的 read-modify-write 并发。失败不抛（void 丢弃），下次仍可重试。
// [资源] 图标补齐是可选展示增强，发起后不等待，不阻塞 overview 返回。
// [并发] 只有写回阶段进入 storage lock，避免与安装卸载的 read-modify-write 交叉。
// [失败路径] 失败被 discard 且不重试，下次 overview 仍会再尝试一次。
export function enrichCachedClaudeMarketplaceIconsForOverview(
  options: ResolveZCodePluginsOptions = {},
): void {
  const { pluginStorageRoot } = resolvePluginContext(options);
  // 图标是可选展示增强：overview 不等待网络；仅写回阶段进入 storage lock。
  void enrichCachedClaudeMarketplaceIcons(pluginStorageRoot, (write) =>
    withPluginStorageLock(pluginStorageRoot, write),
  );
}

/**
 * 运行时列表：在 resolve 结果上补 pluginListingsById（完整 id → 商店信息）。
 * listing 只用于展示，不混入 PluginMetadata，也不按裸 name 关联（同名插件会串）。
 */
export function listZCodePlugins(options: ListZCodePluginsOptions = {}): PluginLoadOutcome {
  const outcome = resolveZCodePlugins(options);
  const { pluginStorageRoot } = resolvePluginContext(options);
  return {
    ...outcome,
    // 用户可见名称必须从 marketplace listing 解析；这里按完整 id 传递给 CLI，
    // 不把展示元数据混入 adapter 的运行时 PluginMetadata，也不按裸 name 猜测。
    pluginListingsById: loadPluginListingsById(pluginStorageRoot),
  };
}

function loadPluginListingsById(storageRoot: string): Record<string, PluginStoreListing> {
  const listings = new Map<string, PluginStoreListing>();

  // 没有 marketplace 快照时，bundled official definition 仍是内置插件 listing 的安全回退。
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (!definition.listing) continue;
    const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
    if (listing) {
      listings.set(`${definition.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`, listing);
    }
  }

  // 目录条目按完整 `${name}@${marketplace}` 关联；同名插件不会互相覆盖。
  for (const marketplace of loadKnownMarketplacesSync(storageRoot)) {
    const manifest = loadMarketplaceManifestSync(storageRoot, marketplace.id);
    for (const entry of manifest?.plugins ?? []) {
      if (entry.listing) listings.set(`${entry.name}@${marketplace.id}`, entry.listing);
    }
  }

  return Object.fromEntries(listings);
}

/**
 * 切换启用态：先解析出唯一插件（id 或唯一 name），再写目标 scope 的配置文件。
 *
 * 只改 enabledPlugins 一个键，不动 options/secret；workspace scope 写入当前 workspace 的
 * <cwd>/.zcode/config.json（不是项目发现得到的第一个外层文件）。
 * 未找到或名称歧义会抛错（这是用户输入错误，不降级成诊断）。
 */
// [契约] 先解析唯一插件再写配置，未找到或名称歧义属于用户输入错误，直接抛。
// [事务] 只 patch enabledPlugins 一个键，不动 options 与 secret 维度。
// [边界] workspace scope 写当前工作目录的 .zcode/config.json，并回传实际落点。
// [失败路径] 写盘异常向上抛出，不回滚已读取的配置，也不产生半条记录。
export async function setZCodePluginEnabled(
  options: SetZCodePluginEnabledOptions,
): Promise<SetZCodePluginEnabledResult> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

/**
 * 新增市场：解析 source（含 --sparse 仅限 git/github），dryRun 只回显不写盘；
 * 真正添加由适配器负责克隆/复制与 known 记录落盘，失败直接抛（CLI 需要非零退出）。
 */
// [契约] dryRun 只解析并回显 source，不读目录、不复制、不写 known 记录。
// [失败路径] sparse 只允许 git 与 github 源，装配阶段即抛错，避免先联网再失败。
// [事务] 真正添加由适配器完成克隆与 known 落盘，失败直接抛给 CLI 换非零退出码。
export async function addZCodePluginMarketplace(
  options: AddZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

// 移除市场只删 known 记录与缓存登记；已安装插件记录不在此处清理（由卸载流程负责）。
export async function removeZCodePluginMarketplace(
  options: RemoveZCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

/**
 * 刷新市场目录。
 *
 * - 未指定 marketplace 时只刷新「Host 已知记录」，不会把项目声明顺手物化成全局记录；
 * - 指定时要求 known 或声明中存在，否则抛 Marketplace not found；
 * - 显式刷新某个市场时，若声明 source 与 known source 不一致，只产生 repoint 诊断并跳过，
 *   不覆盖官方/既有市场（fail closed）；
 * - 声明存在但从未物化时，本次顺带 addMarketplace；单市场失败降级为诊断，不中断其它市场；
 * - 结束后重读 known（适配器已写盘），把所选市场的 lastRefreshFailure 一并回传。
 */
// [契约] 未指定市场时只刷新 Host 已知记录，不会把项目声明顺手物化成全局记录。
// [安全] 指定市场时若声明与 known 来源不一致，只产 repoint 诊断并跳过，不覆盖既有市场。
// [失败路径] 单市场刷新失败降级为诊断，其他市场继续执行。
// [事务] 结束后重读 known，拿到适配器已落盘的最新记录与 lastRefreshFailure。
export async function updateZCodePluginMarketplace(
  options: UpdateZCodeMarketplaceOptions,
): Promise<ZCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  // [并发] 循环内逐个市场串行刷新，避免多个 git 操作同时争抢同一缓存目录。
  // [失败路径] repoint 冲突走 continue，不写盘也不阻断后续市场。
  // [事务] 声明存在但未物化时本次顺带 addMarketplace，与刷新共用同一个 abortSignal。
  // [契约] 只有显式指定市场才做来源一致性检查，全量刷新以 known 记录为准。
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // map 回调只吃第一个参数：toMarketplaceSummaryData 的第二参是 featured，不能接 map 的 index。
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

/**
 * 从市场安装插件（含依赖闭包），返回安装结果与诊断。
 *
 * 关键分支：
 * - dryRun：只做「来源一致性 / 声明物化校验 / 条目校验」，返回 diagnostics，不写盘；
 * - suppressed bundled official：同名内置插件已被用户卸载时，安装语义等价于「恢复」，
 *   必须走 restoreBuiltinPluginCore（且本函数在协议层已持锁，不能二次加锁），
 *   否则会把官方 cache 写成 installed_plugins.json 记录，破坏卸载/恢复语义；
 * - 常规路径：先物化项目声明（失败抛源冲突），再以 scope=user 安装（旧协议 workspace
 *   仅为兼容，不改变 User inventory 归属）；失败转成 install 诊断而不是抛异常；
 * - 官方市场安装成功后清理历史 suppression（同名 CDN 插件重新安装应视为已拥有）；
 * - 默认启用只补用户配置中未显式声明的 id，已有开关选择绝不被覆盖。
 */
// [契约] 三条路径：dryRun 只校验、suppressed 内置等价恢复、常规走 marketplace 安装。
// [失败路径] dryRun 的来源冲突与条目校验都返回 diagnostics，由调用方负责展示。
// [事务] 常规路径先物化项目声明，再以 scope=user 写安装记录，顺序不可颠倒。
// [回归] 官方市场安装成功后清理历史 suppression，同名 CDN 插件重装视为已拥有。
export async function installZCodeMarketplacePlugin(
  options: InstallZCodeMarketplacePluginOptions,
): Promise<ZCodePluginInstallData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.dryRun === true) {
    const declarationSource = resolveDeclaredMarketplaceSources({
      configResult,
    }).get(options.marketplace);
    const known = loadKnownMarketplacesSync(pluginStorageRoot).find(
      (record) => record.id === options.marketplace,
    );
    if (declarationSource && known && !isDeepStrictEqual(known.source, declarationSource)) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [createMarketplaceSourceRepointDiagnostic(options.marketplace)],
      };
    }
    if (
      declarationSource &&
      (!known || !loadMarketplaceManifestSync(pluginStorageRoot, options.marketplace))
    ) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: (
          await validateMarketplaceSource({
            expectedId: options.marketplace,
            pluginName: options.pluginName,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          })
        ).map(toPluginDiagnostic),
      };
    }
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: (
        await validateMarketplacePlugin({
          marketplace: options.marketplace,
          name: options.pluginName,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic),
    };
  }
  const pluginId = `${options.pluginName}@${options.marketplace}`;
  const bundledEntry = loadMarketplaceManifestSync(
    pluginStorageRoot,
    options.marketplace,
  )?.plugins.find((entry) => entry.name === options.pluginName);
  // [契约] 判定需三个条件同时成立：官方市场、id 在抑制集合、条目来源是 filesystem 或 sea。
  // [安全] filesystem 与 sea 条目只是 Catalog 指针，直接安装会把同一份官方 cache 写进安装记录。
  // [并发] 此分支由协议层的存储锁保护，因此只能调用无锁的 restoreBuiltinPluginCore。
  // [失败路径] 恢复后重读配置与发现结果，仍找不到运行态则返回 plugin_not_found 诊断。
  const isSuppressedBundledOfficial =
    options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
    configResult.config.plugins.suppressedBuiltins.includes(pluginId) &&
    (bundledEntry?.source === "filesystem" || bundledEntry?.source === "sea");
  if (isSuppressedBundledOfficial) {
    // 内置插件的 filesystem/SEA entry 只是 Catalog 指针，不是普通 Marketplace source。
    // 直接安装必须复用 restore，避免把同一份官方 cache 写进 installed_plugins.json，
    // 否则卸载/更新会把内置资产误判成用户安装并破坏恢复语义。
    // 当前调用由协议层的 storage lock 保护；这里必须调用不再加锁的核心，
    // 否则同一 storageRoot 的 promise-chain lock 会等待自身而永久阻塞。
    await restoreBuiltinPluginCore({ ...options, configResult, pluginId });
    const fresh = resolvePluginContext({ ...options, configResult: undefined });
    const outcome = resolveZCodePlugins({
      ...options,
      configResult: fresh.configResult,
      pluginStorageRoot: fresh.pluginStorageRoot,
    });
    const restored = outcome.plugins.find((plugin) => plugin.id === pluginId);
    if (!restored) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          toPluginDiagnostic({
            code: "plugin_not_found",
            message: `Bundled plugin could not be restored: ${pluginId}`,
            pluginId,
            severity: "error",
          }),
        ],
      };
    }
    const now = new Date().toISOString();
    return {
      dependencyClosure: [pluginId],
      installedPlugins: [
        toInstalledPluginData(
          {
            id: restored.id,
            name: restored.name,
            marketplace: restored.marketplace,
            version: restored.version ?? "",
            installPath: restored.rootPath,
            installedAt: now,
            updatedAt: now,
            scope: "user",
          },
          restored.enabled,
          restored,
        ),
      ],
      diagnostics: [],
    };
  }
  // [事务] 先物化声明再安装，两步共用同一 abortSignal，取消只会留下已落盘的 known 记录。
  // [失败路径] 任一步失败转成安装诊断，不写启用态、不留半条安装结果。
  // [边界] 安装记录不带 workspace identity，不能被写入 workspace 配置归属。
  let installed: Awaited<ReturnType<typeof installMarketplacePlugin>>;
  try {
    await materializeDeclaredMarketplaceForExplicitAction({
      configResult,
      marketplaceId: options.marketplace,
      pluginStorageRoot,
      abortSignal: options.abortSignal,
      workingDirectory,
    });
    installed = await installMarketplacePlugin({
      signal: options.abortSignal,
      marketplace: options.marketplace,
      name: options.pluginName,
      // package/cache/installed record 是目标 Host 的 User inventory；
      // 旧协议的 Workspace scope 仅为兼容保留，不能改变 Marketplace 默认启用写入 User config
      // 的语义。installed record 没有 workspace identity，不能让它参与 Workspace 配置归属。
      scope: "user",
      storageRoot: pluginStorageRoot,
    });
  } catch (error) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: [
        toMarketplaceInstallDiagnostic(error, `${options.pluginName}@${options.marketplace}`),
      ],
    };
  }
  if (options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    // 官方 marketplace 复用内置插件的 id 空间。若同名 CDN 插件重新安装，
    // 清掉历史内置 suppression，否则 Runtime 仍会把已拥有的安装误判为 suppressed。
    for (const record of installed.installed) {
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, record.id);
    }
  }
  // Marketplace 只管理 Host User inventory；即使旧协议调用方传入 workspace scope，
  // 安装即默认启用也必须写入 User config，不能把 Marketplace 动作变成 Workspace override。
  // 仅作用于用户配置里尚未显式声明的 id（停用后重装等显式选择不被覆盖）。
  const { enabledIds } = await enablePluginsByDefaultInFileConfig(
    configResult.sources.user.path,
    installed.installed.map((record) => record.id),
  );
  const enabledIdSet = new Set(enabledIds);
  // 已有显式配置的，沿用其当前启用态；本次新置默认启用的标记为 true。
  const enabledById = (id: string): boolean =>
    enabledIdSet.has(id) || (configResult.config.plugins.enabledPlugins[id] ?? false);
  return {
    dependencyClosure: installed.closure,
    installedPlugins: installed.installed.map((record) =>
      toInstalledPluginData(record, enabledById(record.id)),
    ),
    diagnostics: [],
  };
}

/**
 * 卸载插件，返回被卸载条目（未找到返回 null）。
 *
 * 以「持久化安装记录」为所有权权威，而不是运行时 source 分类：
 * 官方 CDN 插件与内置插件共享 id 空间和 cache 目录，先看 source 会把 CDN 插件误判为内置，
 * 只写 suppression 却不删安装记录，导致 UI 永远 installed。因此先在 installed_plugins.json
 * 中匹配：命中即走 marketplace 卸载（默认连缓存/data 一起清），并清 enabled/options 与残留 suppression。
 *
 * 未命中安装记录才按内置插件处理：只写 suppressed 标记 + 清 config + 可选删 data，
 * 保留官方 Catalog 与不可变 cache，保证详情页可离线查看、恢复无需重新下载。
 * 整个过程在 storage lock 内执行（与 install/update 串行）。
 */
// [事务] 整个卸载在 storage lock 内完成，与 install 和 update 严格串行。
// [契约] 以持久化安装记录为所有权权威，而不是运行时 source 分类。
// [失败路径] 未命中安装记录才按内置处理，避免把 CDN 插件误判为内置。
// [资源] 默认连 cache 与 data 一起清除，显式 removeCache=false 才保留缓存。
export async function uninstallZCodeMarketplacePlugin(
  options: UninstallZCodeMarketplacePluginOptions,
): Promise<ZCodeInstalledPluginData | null> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const pluginId = resolvePluginIdForMutation(options);

    // 官方 CDN marketplace 与内置插件共享 zcode-plugins-official id 空间，且其缓存
    // 也位于 official cache 下。若先看 runtime source="official"，会把已有
    // installed_plugins.json 记录的 CDN 插件误判成内置插件，只写 suppression 却不删安装记录，
    // 导致 UI 永远保持 installed、无法重装。持久化安装记录是 marketplace 所有权的权威证据，
    // 必须优先于运行时来源分类；同时清掉可能遗留的错误 suppression，让状态自愈。
    const installedRecord = listInstalledPluginRecords(pluginStorageRoot).find(
      (record) => record.id === pluginId,
    );
    if (installedRecord) {
      const removed = await uninstallMarketplacePlugin({
        pluginId,
        // 卸载语义即彻底清除：除非调用方显式传 removeCache=false，否则连缓存与 data 目录一起删。
        removeCache: options.removeCache ?? true,
        keepData: options.keepData,
        storageRoot: pluginStorageRoot,
      });
      if (!removed) return null;
      await removePluginFromFileConfig(configResult.sources.user.path, removed.id);
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, removed.id);
      return toInstalledPluginData(removed, false);
    }

    // 内置（官方）插件不在 installed_plugins.json 里，无法走 marketplace 卸载路径。
    // 卸载只改变 Runtime 抑制态并清理用户数据/config；Catalog 与不可变 cache 必须保留，
    // 这样详情页仍能离线读取组件，且恢复动作不依赖重新下载或重新构造目录。
    const outcome = resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot,
      workingDirectory,
    });
    const builtin = outcome.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.source === "official",
    );
    // [事务] 抑制标记先原子写入，成为已卸载状态的唯一真相源。
    // [失败路径] 配置清理放在删除 data 之前，删除中途失败也能从干净状态恢复。
    // [资源] 官方 cache 与 Catalog 必须保留，详情离线可读且恢复无需重新下载。
    // [权衡] keepData 为真时跳过数据目录删除，只在用户显式要求时牺牲可恢复性换速度。
    if (builtin) {
      await addSuppressedBuiltinInFileConfig(configResult.sources.user.path, pluginId);
      // 先清掉 user config 里的 enabledPlugins[id] 与 options[id]，再删目录：抑制标记已是
      // 唯一真相源（写入用原子 temp+rename），即使后续删除抛错，下次 resolve 也会跳过并补删
      // 缓存；把 config 清理放在删除之前可保证「恢复时从干净状态开始」即便删除中途失败。
      await removePluginFromFileConfig(configResult.sources.user.path, pluginId);
      // 不删除官方 cache：它与 Marketplace Catalog 同属详情/恢复所需的只读资产。
      if (options.keepData !== true) {
        await rm(getPluginDataDir(pluginStorageRoot, pluginId), { force: true, recursive: true });
      }
      const now = new Date().toISOString();
      return toInstalledPluginData(
        {
          id: builtin.id,
          name: builtin.name,
          marketplace: builtin.marketplace,
          version: builtin.version ?? "",
          installPath: builtin.rootPath,
          installedAt: now,
          updatedAt: now,
          scope: "user",
        },
        false,
      );
    }

    return null;
  });
}

// 更新 = 刷新所属市场（失败即返回 refresh 诊断与旧版本，不做半更新） + 按同一条目重装。
// install 复用 cacheMarketplacePlugin 的原地覆盖并保留 installedAt；因此失败时旧安装仍可用。
/**
 * `zcode plugins update <plugin>`：先刷新所属 marketplace 目录，再按同一条目重装。
 * cacheMarketplacePlugin 对已存在的安装记录做原地覆盖并保留 installedAt；启用态只会给
 * 用户配置里尚未显式声明的 id 补默认值，因此更新不会改变用户已经做过的开关选择。
 */
export async function updateZCodeMarketplacePlugin(
  options: UpdateZCodeMarketplacePluginOptions,
): Promise<ZCodePluginUpdateData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const record = listInstalledPluginRecords(pluginStorageRoot).find(
    (installed) => installed.id === options.pluginId,
  );
  if (!record) throw new Error(`Plugin not installed: ${options.pluginId}`);
  const refreshed = await updateZCodePluginMarketplace({
    ...options,
    marketplace: record.marketplace,
  });
  const refreshErrors = refreshed.diagnostics.filter((item) => item.severity === "error");
  if (refreshErrors.length > 0) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: refreshErrors,
      previousVersion: record.version,
    };
  }
  const installed = await installZCodeMarketplacePlugin({
    ...options,
    marketplace: record.marketplace,
    pluginName: record.name,
    scope: record.scope,
  });
  return { ...installed, previousVersion: record.version };
}

// 诊断全部转成统一的 PluginDiagnostic 形态；校验不抛异常（除路径本身不可读），
// 让 CLI 可以一次打印多条问题而不是遇到第一条就退出。
/** `zcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
export async function validateZCodePluginPath(
  options: ValidateZCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

function applySparsePaths(
  source: MarketplaceSource,
  sparsePaths: string[] | undefined,
): MarketplaceSource {
  const paths = (sparsePaths ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
  if (paths.length === 0) return source;
  if (source.source !== "git" && source.source !== "github") {
    throw new Error("--sparse only applies to git or GitHub marketplace sources");
  }
  return { ...source, sparsePaths: paths };
}

/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */
// [并发] 无锁核心，调用方负责持锁，避免同一 storageRoot 二次加锁死锁。
// [安全] computer-use 在写盘前校验功能开关，关闭时用户配置与缓存保持零痕迹。
// [事务] 清除抑制后必须重读磁盘配置并重新 seed 官方根，插件立即可用。
async function restoreBuiltinPluginCore(options: RestoreBuiltinPluginOptions): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // overview 虽然隐藏了恢复入口，但协议调用仍可绕过 UI 写用户配置。
    // 功能开关关闭时在写盘前失败，确保用户配置与插件缓存都保持零痕迹。
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // 重读磁盘上的最新 config（patch 后），确保抑制集合不再包含刚恢复的 id；
  // 不能复用 patch 前可能被传入的 configResult。
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // 立即重新 seed，让插件即刻可用，无需等待下一次 resolve。
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

// 公开恢复入口只负责加锁；真正的写盘/重读/重新 seed 在 restoreBuiltinPluginCore。
// 恢复必须让插件立即可用（重新 seed 官方根），不能等下一次 overview/resolve。
export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}

/**
 * 写入插件 options（user/workspace 配置文件）。
 *
 * - 只接受 string/number/boolean：复杂对象/secret 不走此通道，避免明文落盘到普通配置；
 * - clearOptionKeys 显式删除，解决「传 undefined 无法区分保留与清除」的 JSON patch 语义；
 * - 先 resolve 插件（不存在/歧义即抛错），dryRun 在校验后直接返回，不产生文件修改；
 * - 文件路径由 resolvePluginConfigPath 决定：workspace 固定当前 <cwd>/.zcode/config.json。
 */
// [契约] 只接受标量 options，对象与数组被静默丢弃，secret 不走这条通道。
// [事务] clearOptionKeys 显式删除，弥补 JSON patch 无法区分保留与清除 undefined 的语义。
// [失败路径] 先解析插件再判断 dryRun，插件不存在或歧义时即使 dryRun 也抛错。
export async function configureZCodePlugin(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

// 注意 scope=workspace 时只删 enabledPlugins override，保留 workspace options/secret：
// 「恢复继承」是开关语义，不能顺手清掉用户在该 workspace 单独配置的参数。
/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export async function resetZCodePluginConfig(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}

/**
 * 校验命令的通用入口，三种输入形态各一支：
 * - source：解析用户给的 market 源并校验（解析失败也转成 plugin_marketplace_invalid 诊断）；
 * - marketplace + pluginName：先确保目录可用（必要时刷新/物化），再校验条目；
 * - 其余情况返回空诊断（无需校验）。
 * 只有 source 形态会触发网络/复制，marketplace 形态只在目录缺失时刷新。
 */
// [契约] 三种输入形态各一支：source、marketplace 加 pluginName、其余返回空诊断。
// [资源] 只有 source 形态触发网络或复制，marketplace 形态仅在目录缺失时刷新。
// [失败路径] 解析与物化失败都转成 plugin_marketplace_invalid 诊断，不抛异常。
export async function validateZCodePlugin(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

// 详情读取统一交给 describeMarketplacePlugin：只读目录/缓存，不安装、不触发来源冲突写盘；
// 返回条目描述与诊断，未知插件时由适配器给出 plugin_not_found。
export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  // 默认市场登记由 ensureMarketplaceManifestAvailable 在写锁内完成；这里不再无锁写 known 列表。
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
    ...(options.withWriteLock ? { withWriteLock: options.withWriteLock } : {}),
  });
}

// 统一装配：workingDirectory 先绝对化（相对路径会污染配置发现与 workspace 落点）；
// 外部已给 configResult 时直接复用，避免重复读配置造成前后不一致；
// storageRoot 推导链：config.storage.dir → CLI storage root → plugin storage root。
// [契约] workingDirectory 先绝对化，相对路径会污染配置发现与 workspace 落点。
// [权衡] 外部已给 configResult 时直接复用，避免同一请求读到两份配置快照。
// [资源] storageRoot 推导链为 config.storage.dir、CLI storage root、plugin storage root。
function resolvePluginContext(options: ResolveZCodePluginsOptions): {
  configResult: ConfigResult;
  pluginStorageRoot: string;
  workingDirectory: string;
} {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const storageRoot = resolvePath(configResult.config.storage.dir);
  return {
    configResult,
    pluginStorageRoot:
      options.pluginStorageRoot ?? getPluginStorageRoot(getCliStorageRoot(storageRoot)),
    workingDirectory,
  };
}

// 用户配置里的 extraKnownMarketplaces 声明（id → source）。相对 file/directory 路径
// 以 User config 所在目录为基准解析，而不是 cwd；这里只解析路径，不读取/复制/联网。
function resolveDeclaredMarketplaceSources(input: {
  configResult: ConfigResult;
}): Map<string, MarketplaceSource> {
  return new Map(
    Object.entries(input.configResult.config.plugins.extraKnownMarketplaces ?? {}).map(
      ([marketplaceId, declaration]) => {
        const baseDirectory = dirname(input.configResult.sources.plugins.paths.user);
        return [marketplaceId, resolveDeclaredMarketplaceSource(declaration.source, baseDirectory)];
      },
    ),
  );
}

// 声明来源只对 file/directory 展开相对路径；git/github/url 原样透传，由适配器解析。
function resolveDeclaredMarketplaceSource(
  source: ConfigResult["config"]["plugins"]["extraKnownMarketplaces"][string]["source"],
  baseDirectory: string,
): MarketplaceSource {
  // User Marketplace 的相对路径按 User config 所在目录解析；配置读取不触碰 source，
  // 只有显式 refresh/install 才会真正读取、复制或联网。
  if (source.source === "file" || source.source === "directory") {
    return {
      ...source,
      path: isAbsolute(source.path) ? resolve(source.path) : resolve(baseDirectory, source.path),
    };
  }
  return source;
}

// known 记录与 User 声明合并成「有效市场」。
//
// useCachedManifest 是安全开关：来源一致（或官方保留 id）才允许读缓存；
// 声明与 known 同 id 异 source 时返回一个 pluginCount=0 的占位记录且禁用缓存，
// 避免把旧来源的目录继续展示成新来源——宁可空列表 + 诊断，也不展示错误内容。
// 只有声明、没有 known 的市场同样禁用缓存（从未物化）。
// [安全] useCachedManifest 是安全开关，来源一致或官方保留 id 才允许读缓存。
// [失败路径] 同 id 异 source 时返回 pluginCount 为 0 的占位记录并禁用缓存。
// [边界] 只有声明没有 known 的市场同样禁用缓存，因为从未物化。
function resolveEffectiveMarketplaceRecords(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): Array<{ record: KnownMarketplaceRecord; useCachedManifest: boolean }> {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownIds = new Set(input.known.map((record) => record.id));
  const records = input.known.map((record) => {
    const declarationSource = declared.get(record.id);
    if (!declarationSource) return { record, useCachedManifest: true };
    if (isDeepStrictEqual(record.source, declarationSource)) {
      return { record, useCachedManifest: true };
    }
    // 官方 marketplace id 是 Host 保留身份。Workspace 声明同 id 异 source
    // 只能产生诊断，不能把官方缓存投影替换成 pluginCount=0 的空目录。
    if (isOfficialMarketplaceId(record.id)) {
      return { record, useCachedManifest: true };
    }
    return {
      record: createDeclaredMarketplaceRecord(record.id, declarationSource),
      useCachedManifest: false,
    };
  });
  for (const [marketplaceId, source] of declared) {
    if (knownIds.has(marketplaceId)) continue;
    if (isOfficialMarketplaceId(marketplaceId)) continue;
    records.push({
      record: createDeclaredMarketplaceRecord(marketplaceId, source),
      useCachedManifest: false,
    });
  }
  return records;
}

// 只对「官方保留 id」且来源与 known 不一致的声明发 warning；非官方 id 的来源冲突
// 已在 effective records 里以「禁用缓存」处理，这里不重复报错。
function resolveMarketplaceDeclarationDiagnostics(input: {
  configResult: ConfigResult;
  known: KnownMarketplaceRecord[];
  workingDirectory: string;
}): PluginLoadOutcome["diagnostics"] {
  const declared = resolveDeclaredMarketplaceSources(input);
  const knownById = new Map(input.known.map((record) => [record.id, record]));
  return [...declared.entries()].flatMap(([marketplaceId, source]) => {
    if (!isOfficialMarketplaceId(marketplaceId)) return [];
    const known = knownById.get(marketplaceId);
    if (known && isDeepStrictEqual(known.source, source)) return [];
    return [createReservedMarketplaceDeclarationDiagnostic(marketplaceId)];
  });
}

// 仅为「有效市场投影」构造的占位记录：不落盘、无 addedAt、pluginCount=0；
// 真正物化（add/refresh/install）时才由适配器生成正式 known 记录。
function createDeclaredMarketplaceRecord(
  marketplaceId: string,
  source: MarketplaceSource,
): KnownMarketplaceRecord {
  return {
    id: marketplaceId,
    source,
    name: marketplaceId,
    addedAt: "",
    pluginCount: 0,
  };
}

// 显式动作（install/update/describe）前的物化：仅当该 id 在 User 声明中才处理。
// - 声明与 known 来源不一致 → 抛 MarketplaceSourceRepointError（fail closed）；
// - 已物化且目录可用 → 直接返回，不做无谓刷新；
// - 其余 → addMarketplace 一次性完成拉取/复制与 known 写入。
async function materializeDeclaredMarketplaceForExplicitAction(input: {
  abortSignal?: AbortSignal;
  configResult: ConfigResult;
  marketplaceId: string;
  pluginStorageRoot: string;
  workingDirectory: string;
}): Promise<void> {
  const source = resolveDeclaredMarketplaceSources(input).get(input.marketplaceId);
  if (!source) return;
  const known = loadKnownMarketplacesSync(input.pluginStorageRoot).find(
    (record) => record.id === input.marketplaceId,
  );
  if (known && !isDeepStrictEqual(known.source, source)) {
    throw new MarketplaceSourceRepointError(
      createMarketplaceSourceRepointDiagnostic(input.marketplaceId).message,
    );
  }
  if (known && loadMarketplaceManifestSync(input.pluginStorageRoot, input.marketplaceId)) {
    return;
  }
  await addMarketplace({
    expectedId: input.marketplaceId,
    signal: input.abortSignal,
    source,
    storageRoot: input.pluginStorageRoot,
  });
}

// 选择器口径：完整 id 精确优先；裸 name 必须全局唯一；歧义时报错要求用完整 id
// （错误信息直接给用户看，不自动挑一个“看起来最像”的）。
function resolvePluginSelector(selector: string, plugins: PluginMetadata[]): PluginMetadata {
  const normalized = selector.trim();
  const exact = plugins.find((plugin) => plugin.id === normalized);
  if (exact) return exact;

  const nameMatches = plugins.filter((plugin) => plugin.name === normalized);
  if (nameMatches.length === 1 && nameMatches[0]) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(`Plugin name is ambiguous, use full plugin id: ${normalized}`);
  }
  throw new Error(`Plugin not found: ${normalized}`);
}

// 输出投影只做字段裁剪与可选字段省略；source 以 unknown 暴露给 UI（不承诺内部结构）。
// featured/pluginCount 允许调用方覆盖（目录页可能用本次 manifest 的实时值）。
function toMarketplaceSummaryData(
  record: KnownMarketplaceRecord,
  featured?: string[],
  pluginCount?: number,
): ZCodeMarketplaceSummaryData {
  return {
    id: record.id,
    name: record.name,
    source: record.source as unknown as Record<string, unknown>,
    ...(record.description ? { description: record.description } : {}),
    ...(record.lastUpdated ? { lastUpdated: record.lastUpdated } : {}),
    pluginCount: pluginCount ?? record.pluginCount,
    isOfficial: isOfficialMarketplaceId(record.id),
    ...(record.lastRefreshFailure
      ? {
          refreshFailure: {
            code: record.lastRefreshFailure.code,
            failedAt: record.lastRefreshFailure.failedAt,
            message: record.lastRefreshFailure.message,
          },
        }
      : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
  };
}

// available 条目与已安装态按完整 id 关联；componentTypes 从原始 manifest 键推断，
// 不依赖插件是否已加载（未安装的条目也要展示能力标签）。
function toAvailablePluginData(
  entry: PluginMarketplaceEntry,
  marketplace: string,
  installedIds: ReadonlySet<string>,
): ZCodeAvailablePluginData {
  const id = `${entry.name}@${marketplace}`;
  return {
    id,
    name: entry.name,
    marketplace,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    installed: installedIds.has(id),
    componentTypes: inferComponentTypes(entry.raw),
    ...(entry.listing ? { listing: entry.listing } : {}),
  };
}

// 已安装条目：加载态（loaded）优先提供 version/description/hookDetails；
// 未加载时退回安装记录。updateStatus/latestVersion/listing 由 overview 在外部合并。
function toInstalledPluginData(
  record: InstalledPluginRecord,
  enabled: boolean,
  loaded?: PluginMetadata,
): ZCodeInstalledPluginData {
  return {
    id: record.id,
    name: record.name,
    marketplace: record.marketplace,
    ...((loaded?.description ?? undefined) ? { description: loaded?.description } : {}),
    version: loaded?.version ?? record.version,
    enabled,
    scope: record.scope,
    installPath: record.installPath,
    installedAt: record.installedAt,
    componentTypes: loaded ? inferComponentTypesFromMetadata(loaded) : undefined,
    ...(loaded ? { hookDetails: loaded.hookDetails } : {}),
  };
}

// 从未加载的 market 条目推断能力：按 manifest 顶层键存在性判断（顺序固定，便于 UI 稳定排序）；
// ui 只在显式 componentTypes 里出现，避免把任意组件误标成 UI。
function inferComponentTypes(raw: Record<string, unknown>): string[] {
  const types: string[] = [];
  if ("agents" in raw) types.push("agent");
  if ("commands" in raw) types.push("command");
  if ("skills" in raw) types.push("skill");
  if ("hooks" in raw) types.push("hook");
  if ("mcpServers" in raw) types.push("mcp");
  if ("lspServers" in raw) types.push("lsp");
  if (Array.isArray(raw.componentTypes) && raw.componentTypes.includes("ui")) types.push("ui");
  return types;
}

// 已加载插件的推断改为基于解析结果（目录枚举/计数/声明的 MCP 名），比 manifest 更准确；
// 注意不推断 lsp（加载侧没有稳定计数），避免给出误导标签。
function inferComponentTypesFromMetadata(plugin: PluginMetadata): string[] {
  const types: string[] = [];
  // agent 由约定目录枚举，不一定出现在 manifest；只看 manifest 会让已安装列表漏报子代理能力。
  if (plugin.components.some((group) => group.kind === "agent" && group.items.length > 0)) {
    types.push("agent");
  }
  if (plugin.commandRootCount > 0) types.push("command");
  if (plugin.skillRootCount > 0 || plugin.skillCount > 0) types.push("skill");
  if (plugin.declaredMcpServerNames.length > 0 || plugin.mcpServerNames.length > 0) {
    types.push("mcp");
  }
  if (plugin.hookDetails.length > 0) types.push("hook");
  if (plugin.uiSurfaces?.length) types.push("ui");
  return types;
}

// 变更类操作的 id 解析：完整 id 直接使用；否则要求 name+marketplace 成对；
// 两者都缺属调用方错误，直接抛（不是「没找到」的 null 语义）。
function resolvePluginIdForMutation(options: UninstallZCodeMarketplacePluginOptions): string {
  if (options.pluginId) return options.pluginId;
  if (options.pluginName && options.marketplace) {
    return `${options.pluginName}@${options.marketplace}`;
  }
  throw new Error("pluginId or pluginName + marketplace is required");
}

// options 只允许标量：对象/数组/secret 无法安全写入普通配置文件，直接丢弃（不是报错），
// 保持 CLI 对脚本传参的宽容；需要结构化配置应走插件专属能力。
function normalizePluginOptions(
  options: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

// clearOptionKeys 去空 + 去重，避免重复 patch 或空串键污染文件。
function normalizePluginOptionKeys(keys: string[] | undefined): string[] {
  return [...new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0))];
}

// 写端必须锁定「当前 workspace」而不是 project discovery 的第一个（最外层）文件：
// 嵌套 workspace 读取端是 innermost 优先，写端若写外层会让内层配置永远盖住本次修改。
// 若发现结果里已有同一路径（规范化后比较，覆盖 Windows 大小写/分隔符差异），复用其原始形式。
function resolvePluginConfigPath(
  options: ResolveZCodePluginsOptions & { scope?: "user" | "workspace" },
  configResult: ConfigResult,
  workingDirectory: string,
): string {
  if (options.scope !== "workspace") {
    return configResult.sources.user.path;
  }

  // Workspace Plugin 配置固定落在当前 `<workspace>/.zcode/config.json`。嵌套 workspace
  // 可能同时发现仓库根与自身的配置，读取端 innermost 优先；写入端也必须锁定当前
  // workspace，不能用 project discovery 的第一个 outermost 文件。
  const workspaceConfigPath = join(workingDirectory, ".zcode", "config.json");
  const projectConfigPaths = [
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
    ...configResult.sources.project.paths,
  ];
  const existingWorkspaceConfig = projectConfigPaths.find(
    (path) =>
      normalizePluginConfigPathForComparison(path) ===
      normalizePluginConfigPathForComparison(workspaceConfigPath),
  );
  if (existingWorkspaceConfig) return existingWorkspaceConfig;
  return workspaceConfigPath;
}

// 平台相关规范化：Windows 走 win32.resolve 并统一分隔符/小写（大小写不敏感）；
// 其它平台保留大小写。仅用于「同一路径是否已存在」的等价比较。
function normalizePluginConfigPathForComparison(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolvedPath = platform === "win32" ? win32.resolve(path) : resolve(path);
  return platform === "win32" ? resolvedPath.replaceAll("\\", "/").toLowerCase() : resolvedPath;
}

// 判定路径是否为 workspace 级插件配置：父目录必须叫 .zcode、文件必须叫 config.json；
// Windows 下同样按不敏感比较，防止大小写差异让配置被误判成 user 级。
export function isWorkspacePluginConfigPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return (
      win32.basename(path).toLowerCase() === "config.json" &&
      win32.basename(win32.dirname(path)).toLowerCase() === ".zcode"
    );
  }
  return basename(path) === "config.json" && basename(dirname(path)) === ".zcode";
}

// 刷新目标选择：显式给了 marketplace 就只刷它；否则只刷 Host 已知记录（declaredIds 不参与），
// 防止一次 refresh-all 把任意 workspace 的项目声明写成全局 marketplace。
export function resolveMarketplaceRefreshTargetIds(input: {
  declaredIds: Iterable<string>;
  knownIds: Iterable<string>;
  marketplace?: string;
}): string[] {
  if (input.marketplace) return [input.marketplace];
  // refresh-all 只刷新已经物化的 Host known records；项目声明必须逐个显式物化，
  // 避免一次全量刷新把任意 Workspace 声明写进全局 marketplace 状态。
  return [...new Set(input.knownIds)];
}

// 来源重定向诊断：error 级，提示用户先移除既有市场或改用不同 id；附 pluginId=市场 id 便于 UI 定位。
function createMarketplaceSourceRepointDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_invalid",
    message:
      `Workspace marketplace declaration "${marketplaceId}" conflicts with an existing Host source. ` +
      "Remove the existing marketplace or use a different marketplace id before materializing it.",
    pluginId: marketplaceId,
    severity: "error",
  };
}

// 保留 id 声明诊断：warning 级（声明被忽略而非报错），因为项目配置仍可正常加载，
// 只是该市场声明不生效。
function createReservedMarketplaceDeclarationDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_declaration_reserved",
    message:
      `Workspace marketplace declaration "${marketplaceId}" uses a reserved official id and was ignored. ` +
      "Use a different marketplace id for project declarations.",
    pluginId: marketplaceId,
    severity: "warning",
  };
}

// 专用错误类：install/dryRun 之外由协议层识别并转成 plugin_marketplace_invalid，不暴露堆栈。
class MarketplaceSourceRepointError extends Error {}

function toPluginDiagnostic(diagnostic: {
  code: string;
  message: string;
  pluginId?: string;
  severity: "warning" | "error";
}): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: diagnostic.code as PluginLoadOutcome["diagnostics"][number]["code"],
    message: diagnostic.message,
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
    severity: diagnostic.severity,
  };
}

function toMarketplaceInstallDiagnostic(
  error: unknown,
  pluginId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MarketplaceSourceRepointError) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_invalid",
      message,
      pluginId,
      severity: "error",
    });
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return toPluginDiagnostic({
      code: sourceCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.startsWith("Plugin not found:")) {
    return toPluginDiagnostic({
      code: "plugin_not_found",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("Cross-marketplace dependency")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cross_marketplace",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("dependency cycle")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cycle",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return toPluginDiagnostic({
      code: "plugin_dependency_missing",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("source is recognized but not supported")) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_source_unsupported",
      message,
      pluginId,
      severity: "error",
    });
  }
  return toPluginDiagnostic({
    code: "plugin_marketplace_invalid",
    message,
    pluginId,
    severity: "error",
  });
}

function toMarketplaceRefreshDiagnostic(
  error: unknown,
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  return toPluginDiagnostic({
    code: getPluginSourceDiagnosticCode(error) ?? "plugin_marketplace_invalid",
    message,
    pluginId: marketplaceId,
    severity: "error",
  });
}
