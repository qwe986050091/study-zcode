// ============================================================
// Plugin Contracts - 插件清单、发现结果与对话引用身份目录
// ============================================================
// 生产方：adapters/src/plugins 的 plugin loader 读取 manifest（plugin.json）、枚举组件并产出
// PluginLoadOutcome；消费方：bootstrap/core/tui 通过 PluginPort 把命令/Skill/MCP/Hook 根注入各层。
// 关键边界：插件只能通过声明贡献“根目录 + 名称”，具体实现由适配器按需加载；插件能力不得直接
// 获得宿主内部实现或任意进程能力。命名空间（`${name}:${skill}`、`plugin:${name}:${server}`、
// `${name}:${agent}`）是隔离手段，不是展示前缀。
// 信任模型 fail-closed：同名 manifest name 冲突走 conflictingPluginIds，禁止 last-write-wins；
// 诊断码稳定可判别，message 仅供人读。
import type { CustomCommandRoot } from "../commands/index.js";
import type { HookEventName, HookMatcherConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { SkillRoot } from "../skills/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 市场 ID 字面量：ZCode 官方市场与兼容 Claude 的官方市场属于受信集合，`inline` 是配置内联
// 市场的保留名。这些值是身份而非路径，配置/远端目录里的市场名必须与字面量精确相等，
// 禁止用前缀、大小写近似或本地化名称匹配，否则会绕过官方身份判定。
// 三个常量同时被 bootstrap 默认根与 loader 的 provenance 使用，改字面量会破坏历史数据关联。
export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE = "claude-plugins-official";
export const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
// 隐藏子命令：插件宿主的内部入口名，由 CLI 在解析用户命令前分派，不进入公开命令补全。
// 与 ZCODE_DWF_CHILD_COMMAND 同族——SEA 单文件二进制不解释 Node CLI 旗标，需要自 re-exec
// 并把内部入口作为首参。常量放在 contracts 是为了让 bootstrap 与 CLI 共享同一字面量，
// 避免两份字符串漂移；它不是用户可调用的 slash command，也不得暴露给插件进程自选。
export const ZCODE_PLUGIN_HOST_COMMAND = "__zcode-plugin-host";
// 与插件宿主命令同族的隐藏入口：dynamic workflow 沙箱子进程的自 re-exec 命令。
// 生产者：bootstrap 在 SEA 判定后把它作为 argsPrefix 交给 harness；消费者：CLI 的 run.ts 在
// parseArgs 之前按该字面量分派。payload 走 harness 写好的入口文件路径，不经过命令行，
// 避免把工作流参数暴露在进程 argv 中；它不是可供插件/模型调用的公开命令。
/**
 * 隐藏子命令：dynamic workflow 的沙箱子进程入口（`__zcode-dwf-child <entry path>`；argv 末位是
 * harness 写好的入口文件路径，payload 不过命令行）。
 *
 * 与 {@link ZCODE_PLUGIN_HOST_COMMAND} 同族、同机制：SEA 单文件二进制不解释 Node CLI 旗标，
 * 于是 harness 默认的 `node --max-old-space-size=… <entry>` spawn 在 SEA 下会把旗标交给严格
 * parseArgs 而必然失败。SEA 下改为自 re-exec 本二进制并由 `run.ts` 在 parseArgs **之前**分派。
 * 常量放在 contracts 而非 dynamic-workflow-runtime：后者刻意不依赖 contracts（app-free 证明），
 * 由 bootstrap 在 SEA 判定后把它作为 argsPrefix 递给 harness。
 */
export const ZCODE_DWF_CHILD_COMMAND = "__zcode-dwf-child";

// 官方市场判定：只认 ZCode 与 Claude 两个官方 ID，精确匹配、不带 trim/大小写折叠。
// 该结果用于默认启用策略与信任标记，不代表“插件已安装/已启用”，也不授予额外进程能力。
// 调用方传入的市场名若来自用户配置，未命中即按社区市场处理，不得回退猜测。
export function isOfficialMarketplaceId(id: string): boolean {
  return id === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE || id === CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE;
}

// 插件内容的实际来源：official（内置官方根）、inline（配置内联声明）、cache（远端市场拉取
// 到本地 cache 后的副本）。它是 provenance 与信任/展示口径，不是可用性开关；
// cache 来源同样要经过完整清单校验，不能因为“已在本地”就跳过诊断。
export type PluginSource = "official" | "inline" | "cache";
// 诊断级别：warning 表示跳过该组件/该市场条目但插件整体仍可加载；error 表示该插件或入口不可用。
// 这是稳定判别字段，调用方按 severity 决定是否继续，不得解析 message 文本。
export type PluginDiagnosticSeverity = "warning" | "error";

// 稳定的插件诊断码，跨进程/日志可长期依赖；新增码必须同步 loader 与 UI 文案，不得复用旧码
// 表示不同语义。`plugin_dependency_*` 描述插件间依赖（缺失/环/跨市场）而 `plugin_*_invalid`
// 描述单个组件非法；`plugin_validation_deferred` 表示因依赖或市场条件暂缓校验。
// `plugin_duplicate_id`/`plugin_ambiguous_name` 对应身份冲突，属于 fail-closed 判定。
export type PluginDiagnosticCode =
  | "plugin_root_not_found"
  | "plugin_manifest_not_found"
  | "plugin_manifest_invalid"
  | "plugin_component_path_invalid"
  | "plugin_unsupported_component"
  | "plugin_skill_root_empty"
  | "plugin_mcp_read_failed"
  | "plugin_mcp_invalid"
  | "plugin_mcp_server_disabled"
  | "plugin_hook_read_failed"
  | "plugin_hook_invalid"
  | "plugin_hook_unsupported_event"
  | "plugin_dependency_invalid"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_dependency_cross_marketplace"
  | "plugin_marketplace_invalid"
  | "plugin_marketplace_declaration_reserved"
  | "plugin_git_unavailable"
  | "plugin_archive_fetch_failed"
  | "plugin_marketplace_source_unsupported"
  | "plugin_validation_deferred"
  | "plugin_variable_missing"
  | "plugin_duplicate_id"
  | "plugin_not_found"
  | "plugin_ambiguous_name";

// 插件 manifest 的 `userConfig` 声明：描述“需要用户提供哪些值”。`sensitive` 标记的字段必须在
// 日志/事件/遥测中脱敏且不得回显；`required` 缺失时 loader 产出诊断而不是猜测默认值；
// `default` 只是建议值，用户配置层（PluginConfig.options）优先级更高。
// `type` 决定 UI 控件与校验形态，不做文件系统访问；实际值以 PluginOptionValue 存储。
export interface PluginUserConfigOption {
  default?: string | number | boolean;
  description?: string;
  title?: string;
  required?: boolean;
  sensitive?: boolean;
  type?: "string" | "number" | "boolean" | "directory" | "file";
}

// 用户为插件配置提供的单个值，只允许标量：结构化配置不走 options，避免跨进程序列化时出现
// 任意对象。`PluginOptionValues` 以 manifest 的 key 为索引，存活在 PluginConfig.options 中，
// 与插件 id 关联后才是完整键；缺省时由 loader 按 default 合并，不会写入用户配置本身。
export type PluginOptionValue = string | number | boolean;
export type PluginOptionValues = Record<string, PluginOptionValue>;

// 市场来源的判别联合：url（可带 headers，可能含鉴权信息，禁止写入日志或诊断）、github/git
// （可指定 ref/path/sparsePaths）、npm（包名）、file/directory（本地路径）。
// `source` 是唯一判别字段，新增变体必须同时更新 loader 与 `plugin_marketplace_source_unsupported`
// 诊断；本地来源不联网，远端来源先拉取到 cache（PluginSource="cache"）再解析，二者身份与信任判定一致。
export type PluginMarketplaceSourceConfig =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string };

// 额外已知市场的配置壳：当前只承载 source，保留对象形态是为了未来加入市场级策略时不破坏
// `extraKnownMarketplaces` 的 Record 结构。市场名（Record 的键）是身份，不是路径或 URL；
// 同一市场名重复声明由配置合并层决定，loader 不再二次去重。
export interface PluginMarketplaceConfig {
  source: PluginMarketplaceSourceConfig;
}

// 单个插件 Hook 的解析结果，供详情 UI 与执行层使用。`runnable` 是 loader 判定结果（事件受支持、
// 命令可解析、所需变量存在），不是 manifest 声明；false 时仍展示但不可执行。
// `command`/`args`/`shell` 来自清单，`sourcePath` 指向声明文件；`timeout` 与 `timeoutMs` 是兼容
// 字段，实际生效值由执行层归一。该结构只描述“怎么跑”，不授予执行权限。
export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: HookEventName;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

// 生产者：plugin loader 解析插件根目录时按组件类型枚举；消费者：详情 UI 分组展示。
// 执行层不依赖 kind 做路由——各组件走各自的 Port；未知/不支持的组件在解析阶段被丢弃并产出
// `plugin_unsupported_component`，不会透传给下游。
/** 详情 UI 的组件分组类型，顺序与展示一致：agent / command / skill / hook / mcp。 */
export type PluginComponentKind = "agent" | "command" | "skill" | "hook" | "mcp";

// 组件条目只携带名称与可选描述，不携带路径/实现/凭据：catalog 与详情 UI 只需要“有什么”，
// 具体加载由对应 Port 按 identity 解析。`name` 是已命名空间化的运行时名（如 `name:skill`）。
export interface PluginComponentItem {
  name: string;
  /** 来自组件 frontmatter / manifest 的描述；缺失时省略，绝不伪造。 */
  description?: string;
}

// 一类组件的聚合结果；`items` 可能为空（表示声明了该类型但没有有效条目），顺序与 loader 枚举
// 顺序一致。该结构是解析期快照，不随插件启用态变化，也不用于运行时能力判定。
export interface PluginComponentGroup {
  kind: PluginComponentKind;
  items: PluginComponentItem[];
}

// 生产者：市场目录（官方/远端）拉取时填入；消费者：CLI/TUI 商店页。它不参与 loader 的功能解析，
// 也不影响 PluginMetadata.enabled——listing 存在不代表插件已安装或已启用。
// 字段全部可选，UI 必须按降级矩阵展示，不能因缺字段隐藏整个条目。
/**
 * 商店信息（Store Listing）：市场目录条目携带的展示性元数据，描述"如何在商店里呈现"，
 * 不影响插件功能。字段全部可选，缺失时 UI 按降级矩阵处理（字母头像 / 隐藏区块 / 省略信息行）。
 */
export interface PluginStoreListing {
  /** 卡片/详情显示名，缺失回退插件 name slug。 */
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  /** 目录条目描述的多语言版本（description 本体已有独立字段）。 */
  descriptionI18n?: Record<string, string>;
  /** icon 图片：https URL 或内置插件的本地资源路径。 */
  icon?: string;
  category?: string;
  /** 官方市场内的维护归属；不参与执行权限和安装来源判定。 */
  publisherType?: "official" | "community";
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  /** 详情页 hero 横幅图。 */
  heroImage?: string;
  /** 详情页示例提示词胶囊；点击后新建会话预填。 */
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
   * 需要付费套餐才好用：目录条目声明 `requiresPaidPlan: true`，商店卡片与详情页
   * 标题右侧展示提示图标。表达「使用条件」，不代表插件本身是收费商品，
   * 因此不参与安装门禁与计费；命名不绑定具体套餐商品名，套餐改名不会让字段过期。
   */
  requiresPaidPlan?: boolean;
}

// 插件清单（plugin.json）的宽松形状：除 name 外大量字段是 `unknown`，由适配器按组件类型逐个
// 校验（命令/Skill/MCP/Hook/UI），非法条目产出 plugin_*_invalid 诊断而不是让整个插件失效。
// `userConfig` 的 key 会成为 PluginConfig.options 的索引；`ui.surfaces[]` 由 adapters 解析成
// PluginUiSurfaceDefinition。清单本身不包含可执行代码，`name` 是命名空间的基名。
export interface PluginManifest {
  agents?: unknown;
  author?: unknown;
  channels?: unknown;
  commands?: unknown;
  dependencies?: unknown;
  description?: string;
  homepage?: string;
  hooks?: unknown;
  keywords?: unknown;
  license?: string;
  lspServers?: unknown;
  mcpServers?: unknown;
  name: string;
  outputStyles?: unknown;
  repository?: string;
  settings?: unknown;
  skills?: unknown;
  /** 插件 UI：`ui.surfaces[]` 面板入口声明，adapters 解析。 */
  ui?: unknown;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

// 面板生命周期：第一版只接受 `session`，即面板随会话存在、不跨会话常驻；`draft` 是保留值，
// 尚未放开。该字段由 host 判定挂载时机，不是插件自述的权限。
/** 面板生命周期：第一版只接受会话级；`draft` 留待需要时放开。 */
export type PluginUiSurfaceAvailability = "session";
// 标题的两种合法形态：单一字符串，或按 locale 键的映射（如 `{ "zh-CN": "...", "en-US": "..." }`）。
// 选择哪个 locale 由 UI/宿主决定，契约层不规定回退顺序；映射缺 key 时由消费者自行降级。
/** 标题：单一字符串或按 locale 键的映射（`{ "zh-CN": "...", "en-US": "..." }`）。 */
export type PluginUiSurfaceTitle = string | Record<string, string>;
// 一个面板入口的解析结果。`server` 是运行时 namespaced MCP server 名
//（`plugin:${name}:${server}`），UI 用它调 mcp/uiReadResource；`declaredServer` 保留清单原始键，
// 仅供诊断与展示，两者不可混用。`resourceUri` 必须以 `ui://` 开头（loader 已校验）。
// `availability` 决定面板可挂载的生命周期；该定义在 Session 创建时随 catalog 冻结。
export interface PluginUiSurfaceDefinition {
  id: string;
  title: PluginUiSurfaceTitle;
  icon?: string;
  /** 运行时 namespaced MCP server 名（`plugin:${name}:${server}`），UI 直接用它调 mcp/uiReadResource。 */
  server: string;
  /** 清单里声明的原始 server 键，仅供诊断与展示。 */
  declaredServer: string;
  /** 必须以 `ui://` 开头。 */
  resourceUri: string;
  availability: PluginUiSurfaceAvailability;
}

// 插件总配置（来自 config 文件合并结果）。`enabled` 是全局开关，`enabledPlugins` 按完整 Plugin ID
// 单独开关，后者优先；`dirs` 是用户附加的插件根，`extraKnownMarketplaces` 是额外市场，
// `options` 按插件 id 存用户配置值，`suppressedBuiltins` 用于屏蔽内置插件。
// 该结构可持久化，不含密钥明文；`options` 中 `sensitive` 字段的展示/日志脱敏由消费方负责。
export interface PluginConfig {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, PluginMarketplaceConfig>;
  options: Record<string, PluginOptionValues>;
  suppressedBuiltins: string[];
}

// 单个插件的加载快照。`id` 是 `${manifest.name}@${marketplace}`，跨进程/持久化唯一身份；
// `components` 是 loader 解析阶段枚举的权威清单，与 enabled 无关，详情 UI 直接展示。
// `mcpServerNames`/`declaredMcpServerNames` 分别是运行时命名空间名与清单原始名；
// `dataPath`/`rootPath`/`manifestPath` 是宿主内路径，不得进入 provider 提示或跨进程协议投影。
// `enabled` 是当前生效态，不改变已枚举的组件事实；`uiSurfaces` 已校验，非法项已丢弃。
export interface PluginMetadata {
  /** manifest（plugin.json）里的作者名，规范化为字符串；商店信息缺失时作为详情页回退。 */
  author?: string;
  authorUrl?: string;
  commandRootCount: number;
  /**
   * 权威的组件清单（名称 + 可选描述），由 loader 在解析阶段对插件根目录枚举得出，
   * 与启用态无关。详情 UI 直接展示，无需再在 UI 侧 join Skills/Commands/Agents。
   */
  components: PluginComponentGroup[];
  configuredOptions?: PluginOptionValues;
  dataPath: string;
  declaredMcpServerNames: string[];
  description?: string;
  enabled: boolean;
  /** manifest（plugin.json）homepage；商店信息缺失时作为详情页回退。 */
  homepage?: string;
  id: string;
  manifestPath: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  hookDetails: PluginHookDetail[];
  rootPath: string;
  skillCount: number;
  skillRootCount: number;
  source: PluginSource;
  /** 清单 `ui.surfaces[]` 解析结果（已校验）；未声明或全部非法时缺省。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

// 插件诊断。`code` 稳定可判别，`message` 仅供人读；`pluginId` 在能确定身份时填写，
// 清单损坏等早期失败可能只有 path。诊断随 discover 结果返回，不持久化为会话事件。
export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

// ============================================================
// Plugin 对话引用（@ Plugin capability hint）的身份 catalog 契约。
// 语义：catalog 在 Session（App）创建时冻结，
// 只承载身份与能力"声明"；实际注入能力每轮与 live inventory 取交集。
// ============================================================

// 单个插件的“身份声明”。该条目在 Session（App）创建时冻结，只承载 identities 与声明，
// 不包含正文、MCP 实现或凭据；`enabled` 是冻结时刻的启用态，实际注入能力每轮还要与
// live inventory 取交集，因此 catalog 中 enabled 不代表本轮一定可用。
// `conflictingPluginIds` 非空即 fail-closed：Picker 禁选、runtime 按 ambiguous 跳过，
// 禁止 last-write-wins；`rootPath` 仅供 provenance 回溯，禁止进入 provider reminder。
export interface PluginReferenceCatalogEntry {
  /** 稳定 Plugin ID：`${manifest.name}@${marketplace}`，canonical plugin:// 链接的唯一身份。 */
  pluginId: string;
  /** manifest name（Skill/MCP/Subagent runtime 名字空间的基），仅用于展示与 provenance 匹配，不具权威性。 */
  name: string;
  marketplace: string;
  /** catalog 冻结时刻的启用态；disabled 条目保留用于 `disabled_in_session` 诊断，不可被引用。 */
  enabled: boolean;
  /**
   * 与本条目共享 manifest.name 的其他 enabled Plugin stable IDs。
   * 非空即 V1 fail closed 冲突：Picker 禁选、runtime 按 ambiguous 跳过，
   * 禁止 last-write-wins 或 display name 猜测。
   */
  conflictingPluginIds: string[];
  /** 身份声明的 Skill qualified names（`${name}:${skill}`）；来自组件枚举，与 live 发现解耦。 */
  skillQualifiedNames: string[];
  /** 身份声明的 namespaced MCP server names（`plugin:${name}:${server}`）。 */
  mcpServerNames: string[];
  /** 身份声明的 canonical Subagent names（`${name}:${agent}`）；来自组件枚举。 */
  subagentNames: string[];
  /**
   * Plugin 根目录，仅供 runtime 对 live Skill/Subagent 做 provenance 回溯（rootPath 前缀判定）。
   * 禁止进入 provider reminder 或协议投影——路径不属于 identifiers-only 契约。
   */
  rootPath: string;
  /** 面板入口声明（A5）；供 host 在 session 冻结 catalog 里查面板定义。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
}

// Session 级冻结目录。数组顺序不保证稳定，消费方应按 pluginId 建索引而不是依赖下标；
// 该对象只读，不随插件启停热更新——启停需要新 Session 或显式重建 catalog。
export interface PluginReferenceCatalog {
  plugins: PluginReferenceCatalogEntry[];
}

// 一次插件发现的全量产物：命令根、Skill 根、MCP server 配置、Hook 匹配器、插件元数据与诊断。
// `commandRoots`/`skillRoots` 交给对应 adapters 继续扫描，loader 不直接读组件正文；
// `mcpServers` 的键是运行时 namespaced 名；`pluginListingsById` 只用于展示，不参与身份判定。
// 该结果不是持久化格式，也不得跨进程直接传输活对象（AbortSignal 等）。
export interface PluginLoadOutcome {
  commandRoots: CustomCommandRoot[];
  diagnostics: PluginDiagnostic[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
  /** 商店 listing 按完整 Plugin ID 关联，供 CLI/TUI 展示；不参与运行时身份判断。 */
  pluginListingsById?: Record<string, PluginStoreListing>;
  plugins: PluginMetadata[];
  skillRoots: SkillRoot[];
}

// 发现请求。`config` 是合并后的插件配置（含 enabled/enabledPlugins/options）；`env` 用于变量展开
//（如市场 token），不得回显到诊断；`officialPluginRoots` 是内置官方插件根，
// `officialPluginsEnabledByDefault` 只对官方市场 id 生效，默认空集合保持现网行为。
// `storageRoot` 是插件 cache/data 的宿主内基准目录，`workingDirectory` 决定项目级根。
export interface PluginDiscoverRequest {
  config: PluginConfig;
  env?: Record<string, string | undefined>;
  // bootstrap 可以把"安全到默认就开"的 official plugin id 列表传进来,
  // 让用户不必先 `zcode plugins enable` 就能用 (例如纯内容型的 skill-creator)。
  // 默认空集合, 现有 plugin (含 ios-simulator/android-emulator 这种重负载) 行为不变。
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  officialPluginRoots?: string[];
  storageRoot: string;
  trace?: TraceContext;
  workingDirectory: string;
}

// 插件操作的通用选项：`signal` 用于中止漫长的市场拉取/目录扫描，`context` 用于日志与追踪。
// 中止在各阶段边界检查，网络请求是否真正可取消取决于底层实现，调用方不应依赖即时取消。
export interface PluginOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

// 插件端口的唯一契约：`discoverPlugins` 返回声明与配置产物，不返回可执行实现。
// 实现方必须完成 manifest 校验、命名空间隔离与 fail-closed 冲突判定；调用方不得从
// PluginMetadata 直接拼装内部路径或绕过对应 Port 访问插件资源。
// 跨进程调用只能传纯数据，不能传 AbortSignal/函数等活对象。
export interface PluginPort {
  discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome>;
}
