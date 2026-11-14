// ============================================================================
// plugins/index.ts —— 插件发现与运行时组件装配（Node 适配器）
//
// 职责边界：把磁盘上的插件目录翻译成 PluginLoadOutcome——定位并校验 manifest、过滤重复
// 与已卸载的内置插件、解析 skill/command/hook/MCP/UI 组件、产出诊断。
// 不负责：市场下载安装卸载（marketplace.ts）、hook 实际执行与 MCP 连接（runtime 侧）、
// 网络请求与 UI 渲染。全流程同步执行，discoverPlugins 只是 Promise 外观。
//
// INV-01 断言：插件 id 恒为 `<manifest.name>@<marketplace>` —— 守住它的位置：loadPlugin 构造返回值处 —— 改错故障：同一插件在 inline 与 official 下成为两个实体，停用与启用状态互相错位
// INV-02 断言：重复 id 先到先得，后到者只记 warning —— 守住它的位置：discoverPluginsSync 的 seen 集合 —— 改错故障：后扫描的旧缓存覆盖新版本，命令与技能出现重复或幽灵条目
// INV-03 断言：已卸载的内置插件按权威 id 过滤，不依赖缓存是否被物理删除 —— 守住它的位置：来源为 official 且命中 suppressedBuiltins 的分支 —— 改错故障：升级遗留的缓存目录让用户卸载过的官方插件复活
// INV-04 断言：official 来源的组件作用域恒为 system，其余为 user —— 守住它的位置：resolveComponentRoots 与 materializeCommandMetadataRoot 的作用域赋值 —— 改错故障：市场插件命令拿到系统优先级，覆盖内置命令
// INV-05 断言：manifest 声明的每个路径都必须经 resolveInside 落在插件根内 —— 守住它的位置：resolveComponentRoots、materializeCommandMetadataRoot、warnEmptyDeclaredSkillRoots —— 改错故障：父目录跳转读取宿主任意文件并被当作技能或命令内容
// INV-06 断言：priority 按候选顺序单调递增，每组步长 10 —— 守住它的位置：FIRST_PLUGIN_PRIORITY、PRIORITY_STEP 与 priority 自增处 —— 改错故障：命令与技能排序抖动，同名命令命中不确定
// INV-07 断言：未启用插件仍进入 plugins 列表，但组件为空 —— 守住它的位置：enabled 三元的两条分支 —— 改错故障：设置页整块插件消失，用户无法再启用
// INV-08 断言：manifest 缺失或非法只降级为 diagnostic，不中断发现 —— 守住它的位置：loadPlugin 与 readManifest 返回 null 的路径 —— 改错故障：一个坏插件导致整个 CLI 启动失败
// INV-09 断言：hook 事件只认 SUPPORTED_HOOK_EVENTS 白名单 —— 守住它的位置：parsePluginHookEvents 的事件循环 —— 改错故障：未知事件被静默注入或运行时报错
// INV-10 断言：hook 的执行配置与展示明细来自同一次 schema 校验 —— 守住它的位置：parsePluginHookEvents 中校验结果的两处消费 —— 改错故障：UI 展示的 hook 与实际执行的 hook 不是同一条
// INV-11 断言：停用插件也必须透出 hookDetails —— 守住它的位置：emptyComponents 的入参 —— 改错故障：停用后 hook 面板空白，用户无法判断副作用的来源
// INV-12 断言：技能计数按绝对文件路径去重 —— 守住它的位置：countSkillFiles 的 seenFiles 集合 —— 改错故障：同时声明根目录与默认技能目录时数量翻倍
// INV-13 断言：bundled marketplace 分片存在时它是官方缓存的唯一权威 —— 守住它的位置：scanOfficialCache 的提前返回分支 —— 改错故障：旧版本缓存抢先加载，官方回滚失效
// INV-14 断言：config.enabled 为 false 时零副作用地返回空结果 —— 守住它的位置：discoverPluginsSync 首行短路 —— 改错故障：关闭插件功能后仍在用户磁盘建目录写文件
// INV-15 断言：插件技能扫描一律不跟随符号链接 —— 守住它的位置：warnEmptyDeclaredSkillRoots 与 countSkillFiles 的扫描参数 —— 改错故障：符号链接把插件根外的文件读成技能
// ============================================================================
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CustomCommandRoot,
  HookConfig,
  HookEventName,
  HookMatcherConfig,
  HookPluginContext,
  PluginConfig,
  PluginDiagnostic,
  PluginDiscoverRequest,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginManifest,
  PluginUiSurfaceDefinition,
  PluginMetadata,
  PluginOperationOptions,
  PluginPort,
  SkillRoot,
} from "@zcode/contracts";
import {
  HookEventName as HookEventNameValue,
  HookMatcherConfigSchema,
  ZCODE_INLINE_PLUGIN_MARKETPLACE,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@zcode/contracts";
import {
  directoryExists,
  fileExists,
  isMissingPath,
  isNotFoundError,
  isRecord,
  parsePathList,
  resolveInside,
  sanitizePluginId,
  throwIfAborted,
} from "./helpers.js";
import { scanSkillFilesUnderRootSync } from "../skills/scan.js";
import { loadPluginMcpServerDefinitions, resolvePluginMcpServers } from "./mcp.js";
import { parsePluginUiSurfaces } from "./ui-surfaces.js";
import { listPluginHookSources } from "./hook-sources.js";
import { enumeratePluginComponents } from "./plugin-components.js";
import {
  listInstalledPluginRecords,
  normalizeAuthorValue,
  resolveInstalledPluginRoot,
} from "./marketplace.js";
import { loadBundledOfficialPluginRootsSync } from "./official-marketplace.js";
import type {
  LoadedPlugin,
  PluginAbortOptions,
  PluginCandidate,
  PluginComponents,
} from "./types.js";

/*
 * ============================================================
 * plugins / index.ts —— 插件发现与运行时组件装配（Node 适配器）
 *
 * 定位：收集 inline / official / cache 三类候选插件，读取 manifest，过滤重复与已抑制的内置
 * 插件，再把 skill/command/hook/MCP/UI 组件解析成 PluginLoadOutcome。
 *
 * 输入输出：输入 PluginDiscoverRequest（config.dirs、officialPluginRoots、storageRoot、env、
 * workingDirectory 等）；输出 plugins 元数据 + 各类可执行根（按 priority 排序）+ diagnostics。
 *
 * 副作用：mkdir data 目录、写 generated-commands markdown、读缓存/bundled 清单；不发网络请求。
 *
 * 失败语义：全局 config.enabled=false 直接返回空结果；单个插件 manifest 缺失/非法只记
 * diagnostic 并跳过；单个 MCP/hook 解析失败同样降级为诊断，不影响其他插件。
 *
 * 不变量：插件 id = `<manifest.name>@<marketplace>`，重复 id 先到先得；被卸载的 official
 * 插件按权威 id 过滤（不看缓存是否残留）；official 组件 scope=system，其余=user；
 * command/skill 路径必须经 resolveInside 落在插件根内。
 * ============================================================
 */

// 导出面：本文件是 plugins 子模块的公开入口，市场安装卸载、官方分片写盘、版本比较都由被转出的模块实现。
// [权衡] 改动这里只改变对外符号集合，会影响上层 import 与未使用导出检查，实际行为请改对应实现文件。
export {
  addMarketplace,
  applyClaudePluginIcons,
  describeMarketplacePlugin,
  enrichCachedClaudeMarketplaceIcons,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryStoreListing,
  parsePluginIconSources,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateLocalPluginPath,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginComponentGroup,
  type PluginComponentItem,
  type PluginComponentKind,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from "./marketplace.js";

export {
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
} from "./official-marketplace.js";

export { getPluginSourceDiagnosticCode } from "./source-errors.js";

export {
  comparePluginUpdate,
  comparePluginVersions,
  type PluginUpdateStatus,
} from "./version-compare.js";

// manifest 目录优先级在此固化为常量，真正决定顺序的是 findManifest 的三段回退，只改这里不会生效。
// 新增目录约定时必须同时改 findManifest，否则插件永远读不到 manifest 而只报未找到。
const ZCODE_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");
const DEFAULT_VERSION = "0.0.0";
const FIRST_PLUGIN_PRIORITY = 1_000;
const PRIORITY_STEP = 10;
// 插件名同时充当 id 前缀与 data 目录名后缀，放行 `@` 会让名字加市场标识的拼接产生歧义。
// 上限 128 字符是为了拼接生成的 markdown 文件名不超常见文件系统限制。
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UNSUPPORTED_COMPONENT_KEYS = ["channels", "lspServers", "outputStyles", "settings"] as const;
const SUPPORTED_HOOK_EVENTS = new Set<string>(Object.values(HookEventNameValue));

interface PluginHookInspection {
  /** 所有已解析 hook 的只读展示信息（含不可执行项，供 UI 展示）。 */
  details: PluginHookDetail[];
  /** 按事件聚合的可执行 matcher 配置，供运行时注入。 */
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export interface NodePluginAdapterOptions {
  /** 插件数据/缓存的存储根；request.storageRoot 优先。 */
  storageRoot: string;
}

/**
 * 插件端口实现：发现流程完全同步执行（discoverPlugins 只是 Promise 包装）。
 * 存储根来自构造参数，可被单次 request.storageRoot 覆盖。
 */
export class NodePluginAdapter implements PluginPort {
  constructor(private readonly options: NodePluginAdapterOptions) {}

  /** 异步端口入口；内部同步扫描，便于 CLI/IDE 在启动阶段调用。 */
  async discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome> {
    return this.discoverPluginsSync(request, options);
  }

  /**
   * 发现主流程：候选→加载→过滤→解析组件→汇总。
   *
   * 输入：request.config（enabled/dirs/enabledPlugins/options/suppressedBuiltins）、
   * officialPluginRoots、storageRoot、env、workingDirectory。
   * 输出：plugins 元数据、commandRoots/skillRoots（按 priority 递增）、hooks/mcpServers 映射、
   * diagnostics。
   *
   * 副作用：创建每个插件的 data 目录，可能写 generated-commands。
   * 降级：任何单插件失败只产生 diagnostic；config.enabled=false 返回空结果。
   */
  discoverPluginsSync(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): PluginLoadOutcome {
    // [契约] 全局开关必须在任何副作用之前短路，空结果不含诊断，调用方不得据此判断插件系统故障。
    // 如果把这行下移，data 目录已在组件解析时被创建，关闭功能后仍会在用户磁盘留痕。
    // 配置缺省由 contracts 侧补全，这里不做缺省兼容，否则配置未加载会被误当成已启用。
    if (!request.config.enabled) return emptyOutcome();

    const diagnostics: PluginDiagnostic[] = [];
    const dataRoot = join(request.storageRoot || this.options.storageRoot, "data");
    // 候选顺序即优先级顺序，也是同 id 竞争时的胜负顺序，不要在这条链路中间插入新的候选源。
    // 候选构造阶段可能读取官方缓存清单，此时 diagnostics 已可写入目录不存在的告警。
    const candidates = this.resolveCandidates(request, diagnostics, options);
    const commandRoots: CustomCommandRoot[] = [];
    const hooks: PluginLoadOutcome["hooks"] = {};
    const mcpServers: PluginLoadOutcome["mcpServers"] = {};
    const plugins: PluginMetadata[] = [];
    const seen = new Set<string>();
    const skillRoots: SkillRoot[] = [];
    let priority = FIRST_PLUGIN_PRIORITY;

    for (const candidate of candidates) {
      // [并发] 每个候选前检查一次取消，插件较多时这里是唯一的协作式中断点，解析 hook 与 MCP 期间不再响应。
      // 抛出的取消错误直接冒泡给调用方，不转成诊断——用户取消不是插件缺陷。
      throwIfAborted(options);
      // [失败路径] 返回 null 表示该候选的问题已记录成诊断，循环里只需跳过，不要重复上报告造成 UI 上同一问题出现两次。
      // 该函数不向外抛异常，是发现流程能继续处理后续候选的前提。
      const loaded = loadPlugin(candidate, diagnostics);
      if (!loaded) continue;
      // 内置（官方）插件被「卸载」后只在 user config 写 suppressedBuiltins 标记。这里在发现层
      // 用插件的权威 id（manifest 名 @ marketplace）过滤，不依赖缓存文件是否已被物理删除——
      // 这样即便 app 升级遗留了旧版本缓存目录、或会话内 facade 持有过时配置，被卸载的内置插件
      // 也不会被重新发现。仅作用于 official 源，inline/cache（市场安装）不受影响。
      if (loaded.source === "official" && request.config.suppressedBuiltins.includes(loaded.id)) {
        continue;
      }
      // [契约] 重复 id 先到先得，先出现的 inline 永远压过 official 与市场缓存，这是本地目录调试优先的依据。
      // 被跳过的后者只发 warning 不报错，市场安装与官方内置撞名属于预期场景。
      // 改错故障：若改成后到覆盖或按来源重排，已安装插件可能被同名官方版本顶替，用户配置指向失效。
      if (seen.has(loaded.id)) {
        diagnostics.push({
          code: "plugin_duplicate_id",
          message: `Duplicate plugin ignored: ${loaded.id}`,
          path: loaded.rootPath,
          pluginId: loaded.id,
          severity: "warning",
        });
        continue;
      }
      seen.add(loaded.id);
      warnUnsupportedComponents(loaded, diagnostics);

      // candidate.defaultEnabled 在 candidate 构造时无法访问 plugin id,
      // 这里再叠加 bootstrap 提供的 "默认开" 名单 (按 `<name>@<marketplace>` 匹配)。
      const candidateDefaultEnabled =
        candidate.defaultEnabled ||
        (request.officialPluginsEnabledByDefault?.has(loaded.id) ?? false);
      const enabled = resolveEnabled(request.config, loaded.id, candidateDefaultEnabled);
      const dataPath = join(dataRoot, sanitizePluginId(loaded.id));
      // 只从启用后解析出的 component.mcpServers 生成 mcpServerNames，
      // 未启用插件的内置 MCP 就会在管理页完全不可见。这里先读取声明名给 UI 只读展示，
      // 实际 runtime 注入仍只使用 enabled 分支解析出的 component.mcpServers。
      const mcpServerDefinitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
      const hooksRunnable = canRunPluginHooks(loaded);
      // [权衡] hook 解析放在启用判定之前，停用插件也要把明细交给 UI，否则用户看不到停用后仍有副作用的来源。
      // 注意 runnable 只影响明细里的可执行标记，真正注入执行仍由启用分支解析出的 hookEvents 决定。
      const hookInspection = inspectPluginHooks({
        dataPath,
        diagnostics,
        loaded,
        runnable: hooksRunnable,
      });
      // [契约] 三元两条分支都必须携带 hookInspection 的 details，禁用分支用占位组件承载。
      // 启用分支负责建目录与生成命令，禁用分支不得产生任何写盘行为。
      // 改动这里容易漏掉明细，症状是插件停用后详情页的 hook 列表整块消失。
      const component = enabled
        ? resolveEnabledComponents({
            dataPath,
            diagnostics,
            env: request.env ?? {},
            hookEvents: hooksRunnable ? hookInspection.events : {},
            hookDetails: hookInspection.details,
            loaded,
            mcpServerDefinitions,
            options: request.config.options[loaded.id] ?? {},
            priority,
            workingDirectory: request.workingDirectory,
          })
        : emptyComponents(hookInspection.details);
      // 禁用插件同样消耗一个 priority 区间，避免启用或停用状态变化引起其他插件的排序跳动。
      // 步长 10 是给单插件内部的命令根与生成根留出的次级槽位。
      priority += PRIORITY_STEP;

      // [契约] MCP 服务按名称扁平合并，同名键被后者直接覆盖，既无告警也无来源标记。
      // 因此插件间 MCP 撞名是静默覆盖，若需要可诊断应在这里补来源维度，而不是改 runtime 侧。
      // 覆盖结果依赖候选顺序，调整候选构造会连带改变同名服务的胜者。
      Object.assign(mcpServers, component.mcpServers);
      mergeHookEvents(hooks, component.hooks);
      skillRoots.push(...component.skillRoots);
      commandRoots.push(...component.commandRoots);
      const declaredMcpServerNames = Object.keys(mcpServerDefinitions);
      plugins.push(
        createPluginMetadata(
          loaded,
          component,
          dataPath,
          enabled,
          declaredMcpServerNames,
          request.config.options[loaded.id] ?? {},
          // 插件 UI 面板入口（A5）：与启用态无关地解析，禁用插件的入口由 listUiSurfaces 过滤。
          parsePluginUiSurfaces({ loaded, declaredMcpServerNames, diagnostics }),
        ),
      );
    }

    return {
      commandRoots,
      diagnostics,
      hooks,
      mcpServers,
      plugins,
      skillRoots,
    };
  }

  /**
   * 构造候选列表，优先级：config.dirs(inline) → bundled/显式 official → 官方缓存 → 已安装
   * marketplace 缓存。inline 默认启用，其余默认关闭；同 id 冲突由上层先到先得处理。
   */
  private resolveCandidates(
    request: Pick<PluginDiscoverRequest, "config" | "officialPluginRoots" | "storageRoot">,
    diagnostics: PluginDiagnostic[],
    options?: PluginAbortOptions,
  ): PluginCandidate[] {
    const candidates: PluginCandidate[] = [];
    for (const rootPath of request.config.dirs) {
      candidates.push({
        defaultEnabled: true,
        marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "inline",
      });
    }
    for (const rootPath of request.officialPluginRoots ?? []) {
      candidates.push({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "official",
      });
    }
    candidates.push(
      ...scanOfficialCache(request.storageRoot, diagnostics, options).map((rootPath) => ({
        defaultEnabled: false,
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath,
        source: "official" as const,
      })),
    );
    // 市场安装的插件走 cache 来源且默认关闭，用户必须在设置里显式启用，避免装完即产生副作用。
    // 安装记录里的 marketplace 直接进 id，改名会让已启用状态整体丢失。
    for (const installed of listInstalledPluginRecords(request.storageRoot)) {
      candidates.push({
        defaultEnabled: false,
        marketplace: installed.marketplace,
        rootPath: resolveInstalledPluginRoot(request.storageRoot, installed),
        source: "cache",
      });
    }
    return candidates;
  }
}

/** 便捷工厂：仅需 storageRoot，等价于 new NodePluginAdapter。 */
export function createNodePluginAdapter(options: NodePluginAdapterOptions): NodePluginAdapter {
  return new NodePluginAdapter(options);
}

/** 一次性发现入口：用 request.storageRoot 建临时适配器并同步执行发现。 */
export function discoverNodePluginsSync(
  request: PluginDiscoverRequest,
  options?: PluginAbortOptions,
): PluginLoadOutcome {
  return createNodePluginAdapter({ storageRoot: request.storageRoot }).discoverPluginsSync(
    request,
    options,
  );
}

/**
 * 组装插件元数据：id/name/version/source/marketplace 来自 loaded，组件计数来自 component，
 * author/homepage 以 manifest 为回退（商店 listing 优先），components 独立于启用态枚举。
 */
// [契约] 元数据在插件未启用时也要完整可读，组件计数来自解析结果，组件清单与 UI 入口独立枚举。
// 作者与主页以商店条目优先、manifest 为回退，两处都为空时字段整体省略而不是给空串。
// 字段省略与否被 UI 用来区分未提供与提供空值，不要改成默认值填充。
function createPluginMetadata(
  loaded: LoadedPlugin,
  component: PluginComponents,
  dataPath: string,
  enabled: boolean,
  declaredMcpServerNames: string[],
  configuredOptions: Record<string, string | number | boolean>,
  uiSurfaces: PluginUiSurfaceDefinition[],
): PluginMetadata {
  // manifest 的 author/homepage 作为详情页信息区的回退来源（商店 listing 优先）。
  const author = normalizeAuthorValue(loaded.manifest.author);
  const homepage =
    typeof loaded.manifest.homepage === "string" && loaded.manifest.homepage.trim().length > 0
      ? loaded.manifest.homepage
      : undefined;
  return {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    commandRootCount: component.commandRoots.length,
    // 详情 UI 过去靠 plugin.skillCount（权威计数）+ 一条 UI 侧 join（按 pluginName 过滤
    // skillsService 结果）拿名称，二者数据源分离。停用插件走 emptyComponents() 使 skillCount=0、
    // 且 UI join 对停用插件不产出名称（skillsService 里 `if (!enabled) continue`），导致：停用时
    // 整个技能分组消失、启用时只有数量没有名称。这里改为对插件根目录做权威枚举（与启用态无关），
    // 直接把名称+描述随 list 下发，UI 不再需要脆弱的 join。
    // 这里刻意重新枚举插件根，而不是复用已解析组件：停用插件计数为 0，UI 会因此失去技能名称。
    // [失败路径] 枚举异常在组件枚举函数内部降级为空数组，不会让整个插件列表失败。
    // 改回复用已解析组件会让停用插件的技能分组整块消失，这是历史回归点。
    components: enumeratePluginComponents(loaded.rootPath, loaded.manifest, { loaded }),
    configuredOptions,
    dataPath,
    declaredMcpServerNames,
    description: loaded.manifest.description,
    enabled,
    id: loaded.id,
    manifestPath: loaded.manifestPath,
    marketplace: loaded.marketplace,
    mcpServerNames: Object.keys(component.mcpServers),
    name: loaded.manifest.name,
    hookDetails: component.hookDetails,
    rootPath: loaded.rootPath,
    skillCount: component.skillCount,
    skillRootCount: component.skillRoots.length,
    source: loaded.source,
    ...(uiSurfaces.length > 0 ? { uiSurfaces } : {}),
    userConfig: loaded.manifest.userConfig,
    version: loaded.manifest.version,
  };
}

/**
 * 仅对启用插件解析可执行组件：建 data 目录，解析 skill/command 根、hooks、MCP。
 * priority 在该插件内递增分配，保证插件间排序稳定。
 */
// [资源] 只有启用插件进入这里，建目录、生成命令 markdown、扫描技能等副作用全部被启用态收口。
// 优先级 priority 与 priority+1 分别给技能根和命令根，生成命令根再用 priority+1，靠步长 10 保证不撞。
// 输入里的 hookEvents 已按可执行性过滤，这里不再重复判断。
function resolveEnabledComponents(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  hookDetails: PluginHookDetail[];
  hookEvents: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  loaded: LoadedPlugin;
  mcpServerDefinitions: Record<string, unknown>;
  options: Record<string, string | number | boolean>;
  priority: number;
  workingDirectory: string;
}): PluginComponents {
  // [资源] data 目录是所有插件私有产物的唯一创建点，放在最前避免后续写文件遇到目录不存在。
  // 递归创建保证首次运行与目录被外部清理后都能自动补齐。
  mkdirSync(input.dataPath, { recursive: true });

  const skillRoots = resolveSkillRoots(input, input.priority);
  return {
    commandRoots: resolveCommandRoots(input, input.priority + 1),
    hooks: input.hookEvents,
    hookDetails: input.hookDetails,
    mcpServers: resolvePluginMcpServers({
      ...input,
      definitions: input.mcpServerDefinitions,
    }),
    // 插件页要展示真实技能数量。之前只统计 skills root 数，
    // document-skills 这种一个 root 下有多个 SKILL.md 的插件会被显示成 1。
    skillCount: countSkillFiles(skillRoots),
    skillRoots,
  };
}

/** hook 可执行性判定：当前对三方/官方/inline 一律放行（信任边界有意放宽，见函数内注释）。 */
// [权衡] 此处对所有来源一律返回 true，是有意放弃仅官方可执行 hook 的信任边界，三方市场插件 hook 会真实执行。
// 若要收紧要回到这里加逐插件信任判定，但必须同步 UI 的可执行标记，否则出现显示可执行却实际不执行。
// 参数保留未使用是为了将来按插件判定，不要因为静态检查提示就删掉签名。
function canRunPluginHooks(_loaded: LoadedPlugin): boolean {
  // 三方 marketplace 插件 hook 默认放行（与内置/官方一致）。
  // 上限：放弃了「仅官方可执行 hook」的信任边界，三方插件 hook 会直接执行；
  // 升级路径：需要逐插件 trust（如 user config 白名单）时，把判断收回这里。
  return true;
}

/** 对当前运行时只做诊断（不支持执行）的 manifest 组件键发 warning，不阻断插件加载。 */
function warnUnsupportedComponents(loaded: LoadedPlugin, diagnostics: PluginDiagnostic[]): void {
  for (const key of UNSUPPORTED_COMPONENT_KEYS) {
    if (key in loaded.manifest) {
      diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this ZCode runtime: ${key}`,
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
}

/** 解析技能根：先对显式声明但无技能的路径发诊断，再按通用组件根规则生成。 */
function resolveSkillRoots(
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): SkillRoot[] {
  warnEmptyDeclaredSkillRoots(input);
  return resolveComponentRoots("skills", input, priority);
}

/**
 * manifest 显式声明的 skills 路径没有可用技能时发出诊断，避免路径配置错误静默失败。
 * 声明集合独立于 roots 列表计算，默认 skills/ 目录为空时不误报；路径缺失、目录为空和
 * 符号链接越界分别保留可操作的诊断信息，权限错误交给实际扫描链路报告。
 *
 * 口径：只检查 manifest 显式声明的 skills 路径；默认 skills/ 目录为空不告警。
 * 失败语义：ENOENT/ENOTDIR 报“不存在”，扫描为空报“不含技能”，扫描异常静默跳过。
 * 信任边界：扫描不跟随符号链接，防止声明路径逃逸插件根。
 */
function warnEmptyDeclaredSkillRoots(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): void {
  // [契约] 只有 manifest 显式声明的技能路径参与告警，默认技能目录为空属于正常形态，不产生诊断。
  // 声明为空时直接返回，避免为每个插件都扫一遍默认目录。
  const declared = parsePathList(input.loaded.manifest.skills);
  if (declared.length === 0) return;
  const seenPaths = new Set<string>();
  for (const rawPath of declared) {
    const resolved = resolveInside(input.loaded.rootPath, rawPath);
    if (!resolved || seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    // 路径缺失判定只认 ENOENT/ENOTDIR（statSync 精确分类），EACCES 等权限
    // 错误不得误报成「不存在」——此时没有证据下结论，跳过告警，由 skill adapter
    // 扫描同一目录时发 skill_scan_failed。
    // message 按原因区分：「路径不存在」是 manifest 配错，「存在但没有技能」
    // 是内容问题，「symlink 逃逸出插件根」是安全拒绝，三者修复方式不同；
    // code 保持单一，UI 无需感知分类。
    if (isMissingPath(resolved)) {
      input.diagnostics.push({
        code: "plugin_skill_root_empty",
        message: `Plugin skills path does not exist: ${rawPath}`,
        path: resolved,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    // 信任边界：声明路径是插件内容，扫描不跟随符号链接（目录级/文件级逃逸
    // 一并拒绝，含 Windows junction）。链接根/链接 SKILL.md 扫描为空后落入下方
    // 「没有任何技能」告警，不误报「不存在」（词法路径本身存在）。
    // [失败路径] 扫描异常（权限、IO）在这里静默跳过，不报空技能：没有证据时宁可不下结论。
    // 真正的扫描失败诊断由技能适配器在运行时扫同一目录时发出，避免同一问题两条诊断。
    // 扫描一律不跟随符号链接，链接内容不算技能。
    let skillFiles: string[];
    try {
      skillFiles = scanSkillFilesUnderRootSync(resolved, { followSymbolicLinks: false });
    } catch {
      continue;
    }
    if (skillFiles.length > 0) continue;
    input.diagnostics.push({
      code: "plugin_skill_root_empty",
      message: `Plugin skills path does not contain any skills: ${rawPath}`,
      path: resolved,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
}

/**
 * 解析命令根：manifest/默认 commands 目录 + 从 manifest.commands 元数据生成的 markdown 根。
 * 生成根 priority 紧随其后，保证显式命令优先于生成内容。
 */
// [契约] 显式与默认命令根先产出，随后追加由 manifest 元数据生成的根，保证手写命令优先于生成内容。
// 生成根用 priority+1，紧贴显式根之后，避免落到下一个插件的区间。
// 这里传入的插件上下文让命令执行时能拿到 dataPath 定位插件私有资源。
function resolveCommandRoots(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot[] {
  const roots = resolveComponentRoots<CustomCommandRoot>(
    "commands",
    input,
    priority,
    createHookPluginContext(input.loaded, input.dataPath),
  );
  const generatedRoot = materializeCommandMetadataRoot(input, priority + 1);
  if (generatedRoot) roots.push(generatedRoot);
  return roots;
}

/** 汇总各 hook 来源（hooks/hooks.json 与 manifest.hooks）的解析结果，事件追加、明细合并。 */
function inspectPluginHooks(input: {
  dataPath: string;
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  runnable: boolean;
}): PluginHookInspection {
  const inspection = emptyHookInspection();
  for (const source of listPluginHookSources({
    diagnostics: input.diagnostics,
    loaded: input.loaded,
  })) {
    const loaded = parsePluginHookEvents({
      diagnostics: input.diagnostics,
      loaded: input.loaded,
      pluginDataPath: input.dataPath,
      rawHooks: source.rawHooks,
      runnable: input.runnable,
      sourcePath: source.sourcePath,
      wrapper: source.wrapper,
    });
    mergeHookInspection(inspection, loaded);
  }

  return inspection;
}

/**
 * 解析单个 hook 来源：按 wrapper 形态取 hooks 根，逐事件校验数组与 matcher schema。
 * 不支持的事件、非数组配置、schema 失败都只产生 error 诊断并跳过该项。
 * 通过校验的 hook 会附加插件上下文，并同时产出事件注入配置与展示明细。
 */
function parsePluginHookEvents(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
  pluginDataPath: string;
  rawHooks: unknown;
  runnable: boolean;
  sourcePath: string;
  wrapper: boolean;
}): PluginHookInspection {
  const hooksRoot = input.wrapper
    ? isRecord(input.rawHooks)
      ? input.rawHooks.hooks
      : undefined
    : input.rawHooks;
  const inspection = emptyHookInspection();
  if (!isRecord(hooksRoot)) {
    input.diagnostics.push({
      code: "plugin_hook_invalid",
      message: input.wrapper
        ? "Plugin hooks file must contain a hooks object"
        : "Plugin manifest hooks entry must be an object, a path, or an array",
      path: input.sourcePath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return inspection;
  }

  const plugin = createHookPluginContext(input.loaded, input.pluginDataPath, input.sourcePath);
  for (const [eventName, matcherConfigs] of Object.entries(hooksRoot)) {
    // [契约] 事件白名单来自 contracts 的事件枚举，两侧任何一边增删都会在这里显形。
    // 未知事件只报 warning 并跳过，老版本插件写了新事件时不应整体失败。
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) {
      input.diagnostics.push({
        code: "plugin_hook_unsupported_event",
        message: `Plugin hook event is not supported by this ZCode runtime: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
      continue;
    }
    if (!Array.isArray(matcherConfigs)) {
      input.diagnostics.push({
        code: "plugin_hook_invalid",
        message: `Plugin hook event must be an array: ${eventName}`,
        path: input.sourcePath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const event = eventName as HookEventName;
    for (const matcherConfig of matcherConfigs) {
      // [契约] 用安全解析而不是抛错解析，单条 matcher 非法不应中断其余 matcher，也不应抛到发现流程。
      // 错误信息把校验问题的字段路径拼成点分形式，便于用户定位 manifest 里的字段。
      // 校验失败的事件不会进入注入配置，也不会出现在展示明细，两边保持一致。
      const validation = HookMatcherConfigSchema.safeParse(matcherConfig);
      if (!validation.success) {
        input.diagnostics.push({
          code: "plugin_hook_invalid",
          message: `Invalid plugin hook matcher for ${eventName}: ${validation.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          path: input.sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      const withPlugin: HookMatcherConfig = {
        ...validation.data,
        hooks: validation.data.hooks.map((hook) => attachPluginToHook(hook, plugin)),
      };
      // [契约] 注入事件与下方展示明细必须同一轮循环成对写入，一个供 runtime 执行，一个供 UI 展示。
      // 注入侧挂的是附加了插件上下文的副本，明细保留未附加的原始 hook，两者字段并不完全相同。
      // 只写一处会让 UI 显示有 hook 但实际不执行，或反之，属于最难排查的一类问题。
      (inspection.events[event] ??= []).push(withPlugin);
      for (const hook of validation.data.hooks) {
        inspection.details.push(
          toPluginHookDetail({
            event,
            hook,
            ...(validation.data.matcher !== undefined ? { matcher: validation.data.matcher } : {}),
            runnable: input.runnable,
            sourcePath: input.sourcePath,
          }),
        );
      }
    }
  }

  return inspection;
}

/** 生成 hook 展示明细：process 类型带 args，其余带 async/shell/timeout；runnable 反映能否执行。 */
function toPluginHookDetail(input: {
  event: HookEventName;
  hook: HookConfig;
  matcher?: string;
  runnable: boolean;
  sourcePath: string;
}): PluginHookDetail {
  const detail: PluginHookDetail = {
    command: input.hook.command,
    event: input.event,
    runnable: input.runnable,
    sourcePath: input.sourcePath,
    type: input.hook.type,
  };
  if (input.matcher !== undefined) detail.matcher = input.matcher;
  if (input.hook.statusMessage !== undefined) detail.statusMessage = input.hook.statusMessage;
  if (input.hook.timeoutMs !== undefined) detail.timeoutMs = input.hook.timeoutMs;
  if (input.hook.type === "process") {
    if (input.hook.args !== undefined) detail.args = input.hook.args;
    return detail;
  }
  if (input.hook.async !== undefined) detail.async = input.hook.async;
  if (input.hook.shell !== undefined) detail.shell = input.hook.shell;
  if (input.hook.timeout !== undefined) detail.timeout = input.hook.timeout;
  return detail;
}

/** 构造 hook 插件上下文：id 为权威 `<name>@<marketplace>`，dataPath 指向插件私有目录。 */
function createHookPluginContext(
  loaded: LoadedPlugin,
  dataPath: string,
  sourcePath?: string,
): HookPluginContext {
  return {
    dataPath,
    id: loaded.id,
    name: loaded.manifest.name,
    rootPath: loaded.rootPath,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/** 给 hook 附加插件上下文（不改变 hook 其他字段），用于运行时定位来源。 */
function attachPluginToHook(hook: HookConfig, plugin: HookPluginContext): HookConfig {
  return {
    ...hook,
    plugin,
  };
}

/** 事件级合并：同名事件的 matcher 追加（插件 hook 只增不减，避免覆盖其他来源）。 */
function mergeHookEvents(
  target: Partial<Record<HookEventName, HookMatcherConfig[]>>,
  source: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): void {
  for (const [eventName, matchers] of Object.entries(source) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length > 0) {
      (target[eventName] ??= []).push(...matchers);
    }
  }
}

/** 合并两次解析结果：事件追加、明细直接拼接。 */
function mergeHookInspection(target: PluginHookInspection, source: PluginHookInspection): void {
  mergeHookEvents(target.events, source.events);
  target.details.push(...source.details);
}

/** 空的 hook 检查结果（无事件、无明细）。 */
function emptyHookInspection(): PluginHookInspection {
  return {
    details: [],
    events: {},
  };
}

/** 统计技能文件数：按绝对路径去重，插件根不跟随符号链接；扫描异常时该根计 0。 */
// [契约] 计数按绝对文件路径去重，同一个技能文件可能同时被显式声明根与默认技能目录命中。
// 是否跟随符号链接由根来源决定，插件根一律不跟随，改动会让链接逃逸被计入。
// [失败路径] 单个根扫描抛错只让该根计 0，不影响其他根与整个插件加载。
function countSkillFiles(skillRoots: SkillRoot[]): number {
  // 技能识别规则收敛到共享 scan helper（根自身含
  // SKILL.md 时根自身是一个技能）；同时声明根与
  // 默认 skills/ 根会命中同一个 SKILL.md，必须按文件路径去重，否则计数翻倍。
  // 顺带修正漂移：只认 isDirectory() 会漏掉 symlink 技能子目录，统一 helper 后一并计入。
  // helper 只吞 ENOENT；权限错误（EACCES 等）会抛出，这里按原语义把该根计 0，
  // 真正的 skill_scan_failed 诊断由 skill adapter 在运行时扫描同一目录时发出。
  // 信任边界：这里只消费 plugin roots（resolveSkillRoots 产物），不跟随符号链接。
  const seenFiles = new Set<string>();
  for (const skillRoot of skillRoots) {
    try {
      for (const file of scanSkillFilesUnderRootSync(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
      })) {
        seenFiles.add(file);
      }
    } catch {
      // 概览计数降级为 0；扫描诊断由 skill adapter 负责。
    }
  }
  return seenFiles.size;
}

/**
 * 通用组件根解析：显式声明路径优先，其次默认同名目录；路径经 resolveInside 限制在插件根内，
 * 越界只记 diagnostic 并跳过。official 源 scope=system，其余=user。
 */
// [契约] 显式声明路径优先、默认同名目录其次，两者解析后按绝对路径去重，最终每个根只保留一份。
// 每个路径都必须过 resolveInside，返回空视为逃逸出插件根，记 error 并跳过整条而不是截断。
// 作用域由来源决定：official 给 system，inline 与市场缓存给 user，直接决定命令与技能的可见层级。
function resolveComponentRoots<T extends CustomCommandRoot | SkillRoot>(
  key: "commands" | "skills",
  input: { diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
  plugin?: HookPluginContext,
): T[] {
  const paths = parsePathList(input.loaded.manifest[key]);
  const defaultPath = join(input.loaded.rootPath, key);
  if (directoryExists(defaultPath)) {
    paths.unshift(key);
  }
  const roots: T[] = [];
  const seenPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = resolveInside(input.loaded.rootPath, rawPath);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin ${key} path escapes plugin root: ${rawPath}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    roots.push({
      path,
      ...(plugin ? { plugin } : {}),
      ...(key === "skills" ? { pluginId: input.loaded.id } : {}),
      priority,
      scope: input.loaded.source === "official" ? "system" : "user",
      source: "plugin",
    } as T);
  }
  return roots;
}

/**
 * 把 manifest.commands 的元数据物化为 `${dataPath}/generated-commands/<name>.md`，供只扫描
 * markdown 根的命令加载器使用。
 *
 * 输入：每条命令必须恰好提供 source 或 content 之一；source 必须落在插件根内且文件存在。
 * 副作用：mkdir + writeFileSync，会覆盖同名生成文件。
 * 失败语义：单条非法/越界/缺文件只记 diagnostic 并跳过；全部失败返回 null。
 */
// [资源] 本函数是发现阶段唯一写业务文件的地方，内容落到 data 下的生成命令目录，同名文件直接覆盖。
// 命令来源与内联内容二选一，来源必须经 resolveInside 且文件存在，任何一条非法只跳过该条。
// 全部条目失败或 commands 元数据不是对象时返回 null，调用方据此不追加根。
function materializeCommandMetadataRoot(
  input: { dataPath: string; diagnostics: PluginDiagnostic[]; loaded: LoadedPlugin },
  priority: number,
): CustomCommandRoot | null {
  const spec = input.loaded.manifest.commands;
  if (!isRecord(spec)) return null;

  const generatedRoot = join(input.dataPath, "generated-commands");
  let wroteCommand = false;
  mkdirSync(generatedRoot, { recursive: true });

  for (const [rawName, rawMetadata] of Object.entries(spec)) {
    if (!isRecord(rawMetadata)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command metadata must be an object: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const name = normalizeGeneratedCommandName(rawName);
    if (!name) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Invalid plugin command name: ${rawName}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    const source = typeof rawMetadata.source === "string" ? rawMetadata.source : undefined;
    const content = typeof rawMetadata.content === "string" ? rawMetadata.content : undefined;
    // [契约] 必须恰好提供来源或内联内容之一：两者都给无法判断以谁为准，两者都不给就没有内容。
    // 空字符串内容会被判为未提供，因此只给空 content 的命令会落到这条错误上。
    // 诊断里保留原始命令名，便于用户对照 manifest 定位条目。
    if ((source && content) || (!source && !content)) {
      input.diagnostics.push({
        code: "plugin_manifest_invalid",
        message: `Plugin command '${rawName}' must provide exactly one of source or content`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      continue;
    }

    let markdown = content;
    if (source) {
      const sourcePath = resolveInside(input.loaded.rootPath, trimRelativePrefix(source));
      if (!sourcePath) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source escapes plugin root: ${source}`,
          path: input.loaded.manifestPath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      if (!fileExists(sourcePath)) {
        input.diagnostics.push({
          code: "plugin_component_path_invalid",
          message: `Plugin command source file not found: ${source}`,
          path: sourcePath,
          pluginId: input.loaded.id,
          severity: "error",
        });
        continue;
      }
      markdown = readFileSync(sourcePath, "utf8");
    }
    if (markdown === undefined) continue;

    // 市场清单支持 commands object mapping 和 inline content。
    // ZCode 的 custom command loader 只扫描 markdown 根目录，因此把低风险命令内容
    // materialize 到插件 data 目录；生成路径不在 plugin root 外暴露，也不执行命令本身。
    // [事务] 先拼好完整 markdown 再一次性写入，不追加也不做原子替换，进程中断可能留下半文件。
    // 生成路径固定为生成目录下的命令名文件，命令名已归一化，不会写出子目录。
    // 磁盘不可写时异常会冒泡到发现主流程，不会降级成诊断。
    writeFileSync(
      join(generatedRoot, `${name}.md`),
      applyCommandMetadataFrontmatter(markdown, rawMetadata),
      "utf8",
    );
    wroteCommand = true;
  }

  return wroteCommand
    ? {
        path: generatedRoot,
        plugin: createHookPluginContext(input.loaded, input.dataPath),
        priority,
        scope: input.loaded.source === "official" ? "system" : "user",
        source: "plugin",
      }
    : null;
}

/** 归一生成命令名：去前导 `/`、转小写，仅允许 `[a-z0-9_:-]`；非法返回 null。 */
function normalizeGeneratedCommandName(name: string): string | null {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(normalized)) return null;
  return normalized;
}

/** 去掉命令 source 常见的 `./` 前缀，便于后续 resolveInside 判定。 */
function trimRelativePrefix(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * 把 manifest 命令元数据写成 markdown frontmatter（description/argument-hint/model/allowed-tools）；
 * 元数据为空时原样返回，已有 frontmatter 会被剥离后重建。仅做文本拼装，不执行命令。
 */
function applyCommandMetadataFrontmatter(
  markdown: string,
  metadata: Record<string, unknown>,
): string {
  const frontmatter = new Map<string, string>();
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    frontmatter.set("description", metadata.description.trim());
  }
  if (typeof metadata.argumentHint === "string" && metadata.argumentHint.trim()) {
    frontmatter.set("argument-hint", metadata.argumentHint.trim());
  }
  if (typeof metadata.model === "string" && metadata.model.trim()) {
    frontmatter.set("model", metadata.model.trim());
  }
  if (Array.isArray(metadata.allowedTools)) {
    const allowedTools = metadata.allowedTools
      .filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
      .map((tool) => tool.trim());
    if (allowedTools.length > 0) frontmatter.set("allowed-tools", allowedTools.join(", "));
  }
  if (frontmatter.size === 0) return markdown;
  const body = stripMarkdownFrontmatter(markdown).trimStart();
  return `---\n${Array.from(frontmatter, ([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;
}

/** 去除 markdown 头部 `---` frontmatter（BOM 容忍）；无合法 frontmatter 时原样返回。 */
function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return markdown;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return markdown;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex > 0 ? lines.slice(endIndex + 1).join("\n") : markdown;
}

/**
 * 扫描官方插件缓存根（cache/<official>/<plugin>/<version>）。
 *
 * 权威优先：若 bundled marketplace 分片存在，以其 cachePath 为准（避免旧版本缓存抢先生效，
 * 且不回退到“最高 semver”，以支持官方回滚）。
 * 失败语义：目录不存在返回空；其他读取错误记 warning 并返回空。
 */
// [契约] 缓存结构为 cache 下官方市场再分插件名与版本，返回顺序即目录遍历顺序，不做版本排序。
// 随应用发布的分片清单存在时它是唯一权威，直接返回，只有分片缺失才回退遍历磁盘。
// [失败路径] 目录不存在返回空数组（首次运行），其他读取错误记 warning 后同样返回空。
function scanOfficialCache(
  storageRoot: string,
  diagnostics: PluginDiagnostic[],
  options?: PluginAbortOptions,
): string[] {
  // 官方插件升级会保留旧版本缓存目录；若遍历全部目录再按插件 id
  // “先到先得”，旧版本会抢在 bundled marketplace 指向的当前版本前被加载。
  // bundled 分片是当前随应用发布资产的权威清单；存在时只加载其 cachePath。
  // 不能简单选择最高 semver，否则官方回滚版本时仍会错误加载旧缓存。
  const bundledRoots = loadBundledOfficialPluginRootsSync(storageRoot);
  // [契约] 用是否为 undefined 判断分片存在，而不是判空数组：分片存在但内容为空也必须视为权威，不回退磁盘。
  // 分片里的缓存路径允许指向滞留的旧版本，这是官方回滚的唯一手段，不能改成取最高版本。
  // 返回前逐项检查取消，保证官方插件较多时仍可中断。
  if (bundledRoots !== undefined) {
    for (const rootPath of bundledRoots) {
      throwIfAborted(options);
    }
    return bundledRoots;
  }

  const cacheRoot = join(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  try {
    const roots: string[] = [];
    for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
      throwIfAborted(options);
      if (!pluginEntry.isDirectory()) continue;
      const pluginDir = join(cacheRoot, pluginEntry.name);
      for (const versionEntry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (versionEntry.isDirectory()) roots.push(join(pluginDir, versionEntry.name));
      }
    }
    return roots;
  } catch (error) {
    if (isNotFoundError(error)) return [];
    diagnostics.push({
      code: "plugin_root_not_found",
      message: error instanceof Error ? error.message : `Failed to scan ${cacheRoot}`,
      path: cacheRoot,
      severity: "warning",
    });
    return [];
  }
}

/**
 * 加载候选插件：目录存在性 → manifest 定位（.zcode-plugin/.claude-plugin/.codex-plugin）
 * → 读取并校验 manifest。任一步失败记 diagnostic 并返回 null，不抛出。
 */
// [失败路径] 目录存在性、manifest 定位、manifest 校验三步任一失败都返回空并已写入诊断，调用方不再重复报错。
// 插件 id 在这里定型为名字加市场标识，后续所有去重、抑制与启用状态都以它为主键。
// 根路径保留候选原值，后续越界校验以它为界，改动会影响逃逸判定。
function loadPlugin(
  candidate: PluginCandidate,
  diagnostics: PluginDiagnostic[],
): LoadedPlugin | null {
  if (!directoryExists(candidate.rootPath)) {
    diagnostics.push({
      code: "plugin_root_not_found",
      message: `Plugin root does not exist: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "warning",
    });
    return null;
  }

  const manifestPath = findManifest(candidate.rootPath);
  if (!manifestPath) {
    diagnostics.push({
      code: "plugin_manifest_not_found",
      message: `Plugin manifest not found: ${candidate.rootPath}`,
      path: candidate.rootPath,
      severity: "error",
    });
    return null;
  }

  const manifest = readManifest(manifestPath, diagnostics);
  if (!manifest) return null;
  return {
    id: `${manifest.name}@${candidate.marketplace}`,
    manifest,
    manifestPath,
    marketplace: candidate.marketplace,
    rootPath: candidate.rootPath,
    source: candidate.source,
  };
}

/** 按稳定优先级查找 manifest：.zcode-plugin → .claude-plugin → .codex-plugin，均无则 null。 */
function findManifest(rootPath: string): string | null {
  const zcodePath = join(rootPath, ZCODE_MANIFEST_PATH);
  if (fileExists(zcodePath)) {
    return zcodePath;
  }

  // 兼容不同 manifest 目录约定，发现阶段按稳定优先级回退。
  const claudePath = join(rootPath, CLAUDE_MANIFEST_PATH);
  if (fileExists(claudePath)) {
    return claudePath;
  }
  const codexPath = join(rootPath, CODEX_MANIFEST_PATH);
  return fileExists(codexPath) ? codexPath : null;
}

/**
 * 读取 manifest：必须是 JSON 对象，name 满足 PLUGIN_NAME_PATTERN，version 缺省为 0.0.0。
 * 解析/校验失败记 error diagnostic 并返回 null（插件整体跳过）。
 */
// [契约] 只做最小校验：必须是 JSON 对象且名字匹配插件名模式，版本缺失补默认值而不是报错。
// 其余字段原样透传，由各组件解析函数按需校验，避免 manifest 演进时这里成为瓶颈。
// [失败路径] 解析与校验错误统一转成 manifest 非法诊断，单个插件整体跳过但不影响其他插件。
function readManifest(path: string, diagnostics: PluginDiagnostic[]): PluginManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      ...parsed,
      name,
      version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
    } as PluginManifest;
  } catch (error) {
    diagnostics.push({
      code: "plugin_manifest_invalid",
      message: error instanceof Error ? error.message : `Invalid plugin manifest: ${path}`,
      path,
      severity: "error",
    });
    return null;
  }
}

/** 全局插件功能关闭时的空结果：无插件、无组件、无诊断。 */
function emptyOutcome(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

/** 禁用插件/空插件的组件占位：保留 hookDetails 供 UI 展示，其余为空。 */
function emptyComponents(hookDetails: PluginHookDetail[] = []): PluginComponents {
  return {
    commandRoots: [],
    hooks: {},
    hookDetails,
    mcpServers: {},
    skillCount: 0,
    skillRoots: [],
  };
}

/** 启用判定：用户显式 enabledPlugins 覆盖优先，否则用 candidate/bootstrap 默认值。 */
function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}
