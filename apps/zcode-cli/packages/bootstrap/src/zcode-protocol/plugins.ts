// zcode-protocol 插件域处理器 —— 把 bootstrap 的插件能力投影成 V4 协议可序列化的结果。
// 做：校验 params、按 scope 读取配置视图、投影插件/市场/安装摘要、统一诊断形态，
//     并在变更类操作上串行化 plugin storage 锁。
// 不做：不实现插件发现/安装/校验本身（都在 ../plugins.js），不维护进程内缓存，
//       不持有 UI 状态，也不决定权限；本文件只做协议适配与形态转换。
// 依赖：@zcode/shared 的 schema 与结果类型、../plugins.js 的 core、withPluginStorageLock、
//       createConfig/resolvePath；跨包导入一律走公开入口。
// 边界：协议层无业务状态；每次调用现算配置与目录，保证手改文件后 GUI 立即可见。
//
// INV-01 断言：所有入参必须先经 parseParams 用 schema 校验 —— 守住它的位置：每个 export handler 的第一行 —— 改错故障：绕过校验会把脏参数直接喂给文件读写与安装逻辑。
// INV-02 断言：configScope 为 user 时不得传 workingDirectory —— 守住它的位置：createPluginConfigView 的条件展开 —— 改错故障：传了会把 Workspace override 投影成 User 当前值。
// INV-03 断言：每次 list 都重新解析目录、不缓存 —— 守住它的位置：listPlugins 内调用 resolveZCodePlugins —— 改错故障：加缓存后手改配置文件 GUI 不再刷新。
// INV-04 断言：配置里存在但磁盘缺失的插件必须补进列表 —— 守住它的位置：createMissingConfiguredPluginInfos —— 改错故障：用户会看到「启用却不显示」的幽灵插件。
// INV-05 断言：缺失插件 id 必须含 @ 且后缀非空 —— 守住它的位置：separatorIndex 的两个边界判断 —— 改错故障：畸形 id 会生成 source=missing 的假条目。
// INV-06 断言：敏感 option 不得出现在 configuredOptions —— 守住它的位置：toPluginInfo 的 filter —— 改错故障：凭据会经协议下发给所有客户端。
// INV-07 断言：可选字段用条件展开而不是显式 undefined —— 守住它的位置：所有 { ...(x ? {x} : {}) } —— 改错故障：序列化差异会让客户端把缺字段读成显式清空。
// INV-08 断言：路径比较前必须先归一化 —— 守住它的位置：normalizePluginRootForComparison —— 改错故障：Windows 大小写与斜杠差异会把自有插件判成无归属。
// INV-09 断言：Workspace 归属优先于 user —— 守住它的位置：resolveInlinePluginRootSource 的判定顺序 —— 改错故障：顺序反转会把项目声明的插件记成用户级。
// INV-10 断言：市场/安装/更新/校验必须共用同一 storageRoot 锁 —— 守住它的位置：withPluginStorageLock 的包裹层 —— 改错故障：并发安装会交错读改写 installed_plugins.json。
// INV-11 断言：锁粒度按 storageRoot 而不是进程全局 —— 守住它的位置：resolvePluginStorageRoot 的键 —— 改错故障：全局锁会串行化不同 workspace 的无关操作。
// INV-12 断言：dryRun 由 core 决定是否真正落盘 —— 守住它的位置：params.dryRun 原样透传 —— 改错故障：协议层自己短路会让校验型调用变成真实写入。
// INV-13 断言：setPluginEnabled 的写入当前不可回滚 —— 守住它的位置：两次 throwIfAborted 之间的注释 —— 改错故障：假装回滚会与磁盘真实状态不一致。
// INV-14 断言：取消只能阻断后续响应 —— 守住它的位置：IO 之后的第二次 abortSignal 检查 —— 改错故障：删掉第二次检查会返回成功但已被取消的结果。
// INV-15 断言：install 失败以 diagnostics 返回而不是抛错 —— 守住它的位置：installPlugin 的返回构造 —— 改错故障：抛错会让 GUI 丢掉依赖闭包等部分成功信息。
// INV-16 断言：update 必须聚合每条记录的诊断 —— 守住它的位置：updatePlugin 的 diagnostics 累加 —— 改错故障：失败的重装会被静默当成成功。
// INV-17 断言：update 过滤顺序是 pluginId → marketplace → 全部 —— 守住它的位置：filter 内的 if 链 —— 改错故障：顺序反转会在指定插件时误更新整张表。
// INV-18 断言：describe 只有懒加载 manifest 写入进锁 —— 守住它的位置：withWriteLock 回调 —— 改错故障：整段持锁会让纯读路径也被串行化。
// INV-19 断言：校验 ok 只看是否存在 error 级诊断 —— 守住它的位置：diagnostics.every(...) —— 改错故障：把 warning 也判成失败会让可安装插件被拒。
// INV-20 断言：compatibility 是能力声明常量而不是校验结果 —— 守住它的位置：validatePlugin 的返回字面量 —— 改错故障：把 diagnosticOnly 挪进 runnable 会让 GUI 放行不支持的能力。
//
// 阅读顺序：先看 toPluginInfo 的投影规则，再看 createPluginConfigView 的 scope 语义，然后看各
// export handler 的锁边界，最后看三个 to*Summary 的可选字段写法。
// 常见误改：给 list 加缓存、给 user 视图也传 workingDirectory、把 install 失败改成 throw、
// 把 withPluginStorageLock 从 update 外层挪进循环体。四处都会破坏「读到即磁盘现状」。
// 与 core 的关系：本文件只做参数与结果形态转换，业务判断必须落在 ../plugins.js。
// 与 GUI 的契约：可选字段缺失表示「未知」，显式 undefined 与缺字段序列化后不可区分。
// 错误边界：core 用 diagnostics 表达可恢复失败时不要抛错，只有参数校验失败才抛。
// 并发边界：锁只保护 installed_plugins.json 与 cache 目录的读改写，不保护网络请求。
// 平台边界：路径归一化依赖 process.platform，测试需覆盖 win32 与 posix 两个分支。
// 维护提示：新增协议 handler 时先判断它是否写盘；写盘就必须套同一个 storageRoot 锁。
import {
  zcodePluginsConfigureParamsSchema,
  zcodePluginsResetConfigParamsSchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsMarketplaceAddParamsSchema,
  zcodePluginsMarketplaceRemoveParamsSchema,
  zcodePluginsMarketplaceUpdateParamsSchema,
  zcodePluginsOverviewParamsSchema,
  zcodePluginsListParamsSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUpdateParamsSchema,
  zcodePluginsValidateParamsSchema,
  zcodePluginsDescribeParamsSchema,
  zcodePluginsRestoreBuiltinParamsSchema,
  type ZCodeAvailablePluginSummary,
  type ZCodeInstalledPluginSummary,
  type ZCodePluginComponentGroup,
  type ZCodePluginDiagnostic,
  type ZCodePluginInfo,
  type ZCodePluginMarketplaceSummary,
  type ZCodePluginsConfigureResult,
  type ZCodePluginsDescribeResult,
  type ZCodePluginsInstallResult,
  type ZCodePluginsListResult,
  type ZCodePluginsMarketplaceMutationResult,
  type ZCodePluginsOverviewResult,
  type ZCodePluginsRestoreBuiltinResult,
  type ZCodePluginsSetEnabledResult,
  type ZCodePluginsUninstallResult,
  type ZCodePluginsValidateResult,
} from "@zcode/shared";
import type { PluginDiagnostic, PluginMetadata } from "@zcode/contracts";
import {
  addZCodePluginMarketplace,
  configureZCodePlugin,
  describeZCodePlugin,
  enrichCachedClaudeMarketplaceIconsForOverview,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  removeZCodePluginMarketplace,
  resolveZCodePlugins,
  resetZCodePluginConfig,
  restoreBuiltinPlugin as restoreBuiltinPluginCore,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePlugin,
} from "../plugins.js";
// [契约] 已安装记录只从 adapters 的公开入口读取，不要直接读 installed_plugins.json。
// 绕开 adapters 会跳过形态归一与版本兼容，文件格式一变这里先崩。
// 本导入仅用于 update 枚举候选集，不参与任何安装决策。
// 若 adapters 将来改成异步接口，这里与 updatePlugin 必须同步改为 await。
// [权衡] 保持同步读取是因为 update 需要在进锁前确定候选集，避免锁内做枚举。
import { listInstalledPluginRecords } from "@zcode/adapters/plugins";
// [并发] 锁的键是 plugin storage root 而不是 workspacePath：不同 workspace 可能共用同一个 root。
// 锁必须包在 await 外层，放进循环体后并发 install 仍会交错。
// [权衡] 这是进程内锁，跨进程（多实例 CLI）不生效，只能依赖单实例假设。
// 不要在持锁期间做长网络请求：会阻塞同 root 的其他协议调用。
// 锁回调内抛错要能冒泡，不要 try/catch 后返回空诊断。
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { resolveOfficialPluginHostMcpServerNames } from "../app/official-plugin-definitions.js";
import { createConfig, resolvePath, type ConfigResult } from "@zcode/adapters/config";
// [契约] parseParams 是入参唯一入口，同时完成类型收窄与运行时校验。
// 不要在 handler 里对 rawParams 做 as 断言，那等于跳过校验。
// context.logger 只在中转给 core 时使用，本文件不自行打印日志。
// context.deps 只在 createConfig 读 env，不要顺手取其他字段。
// 新增 handler 必须复用 parseParams，不要为「简单参数」开口子。
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

// 把 CLI 的 PluginMetadata 投影成协议可序列化的 ZCodePluginInfo (只保留 UI 需要的字段)。
// [契约] toPluginInfo 是 PluginMetadata → 协议形态的唯一投影点，禁止在 handler 里手工拼对象。
// configResult 可选：只有 list 传它，其余场景缺来源信息时就应省略字段而不是猜。
// 函数保持纯粹：不读文件、不打日志，否则投影结果会随调用次数变化。
// 只保留 UI 需要的字段，manifest 原文等内部结构不得透出。
// 新增字段前先判断是展示需要还是执行需要，执行相关的不要走协议下发。
function toPluginInfo(plugin: PluginMetadata, configResult?: ConfigResult): ZCodePluginInfo {
  const hostMcpServerNames = resolveOfficialPluginHostMcpServerNames(plugin.id);
  // [契约] 敏感 option 必须在投影处过滤，不能依赖 UI 侧隐藏。
  // 过滤依据是 userConfig[key].sensitive === true，判断键是 key 不是值。
  // 过滤后为空对象时，外层条件展开会省略该字段，表示「没有非敏感配置」。
  // [失败路径] sensitive 标记缺失视为非敏感，这是既有语义，改动会泄漏凭据。
  const configuredOptions = Object.fromEntries(
    Object.entries(plugin.configuredOptions ?? {}).filter(
      ([key]) => plugin.userConfig?.[key]?.sensitive !== true,
    ),
  );
  const enabledSource = configResult?.sources.plugins.enabled[plugin.id];
  const optionSources = configResult?.sources.plugins.options[plugin.id];
  // [契约] rootSource 只对 inline 来源且存在 configResult 的场景计算。
  // 非 inline 插件没有「配置目录归属」概念，强行计算会得到错误来源。
  // 该字段只用于 Settings 展示归属，不参与启用判定。
  // configResult 缺失时保持 undefined，由外层条件展开省略该字段。
  const rootSource =
    plugin.source === "inline" && configResult
      ? resolveInlinePluginRootSource(plugin.rootPath, configResult)
      : undefined;
  return {
    id: plugin.id,
    name: plugin.name,
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    enabled: plugin.enabled,
    source: plugin.source,
    marketplace: plugin.marketplace,
    // manifest 的作者/主页回退字段（商店 listing 优先）。
    ...(plugin.author !== undefined ? { author: plugin.author } : {}),
    ...(plugin.authorUrl !== undefined ? { authorUrl: plugin.authorUrl } : {}),
    ...(plugin.homepage !== undefined ? { homepage: plugin.homepage } : {}),
    skillCount: plugin.skillCount,
    skillRootCount: plugin.skillRootCount,
    commandRootCount: plugin.commandRootCount,
    // 权威组件清单随 list 下发，名称+描述由 loader 枚举（与启用态无关），供详情 UI 直接展示。
    components: plugin.components.map((group) => ({
      kind: group.kind,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    })),
    declaredMcpServerNames: plugin.declaredMcpServerNames,
    ...(plugin.uiSurfaces?.length ? { uiSurfaces: plugin.uiSurfaces.map((surface) => ({
      pluginId: plugin.id, pluginName: plugin.name, id: surface.id, title: surface.title,
      ...(surface.icon ? { icon: surface.icon } : {}), server: surface.server,
      resourceUri: surface.resourceUri, availability: surface.availability,
    })) } : {}),
    mcpServerNames: plugin.mcpServerNames,
    ...(hostMcpServerNames.length > 0 ? { hostMcpServerNames } : {}),
    hookDetails: plugin.hookDetails,
    rootPath: plugin.rootPath,
    ...(plugin.userConfig ? { userConfig: plugin.userConfig } : {}),
    ...(Object.keys(configuredOptions).length > 0 ? { configuredOptions } : {}),
    ...(rootSource ? { rootSource } : {}),
    ...(enabledSource ? { enabledSource } : {}),
    ...(optionSources && Object.keys(optionSources).length > 0 ? { optionSources } : {}),
  };
}

// [契约] 比较前必须对两侧路径调用 normalizePluginRootForComparison。
// 用全等而不是 startsWith：前缀比较会让父目录误命中子目录。
// 返回类型只有 user/workspace/undefined 三态，undefined 表示无归属而非错误。
// 本函数不抛错，resolvePath 对畸形输入的行为由 adapters 决定。
// 判定顺序是 Workspace 在前，这是项目声明优先于用户配置的体现。
function resolveInlinePluginRootSource(
  pluginRootPath: string,
  configResult: ConfigResult,
): "user" | "workspace" | undefined {
  const resolvedPluginRoot = normalizePluginRootForComparison(pluginRootPath);
  // Workspace 优先：同一路径同时出现在两层配置时，项目声明是更高优先级的归属证据。
  if (
    configResult.sources.plugins.dirs.workspace.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "workspace";
  }
  if (
    configResult.sources.plugins.dirs.user.some(
      (rootPath) => normalizePluginRootForComparison(rootPath) === resolvedPluginRoot,
    )
  ) {
    return "user";
  }
  return undefined;
}

// [契约] configScope === user 时不得传 workingDirectory，否则会读到 project 层 override。
// 非 user 时 workingDirectory 决定 project config 与 package storage 的相对上下文。
// [权衡] 两个 scope 共用同一批 Host Plugin，只是配置视图不同，不要在这里过滤插件。
// env 只从 context.deps 取，不要读 process.env：协议层必须可测试。
// 返回值直接交给 core，本文件不对 ConfigResult 再做加工。
function createPluginConfigView(
  context: ZCodeProtocolAgentServerContext,
  workspacePath: string,
  configScope: "user" | "workspace" | undefined,
): ConfigResult {
  // Settings 的 User 与 Workspace 现在是同一批 Host Plugin 的两个配置视图。
  // User 视图若继续加载 project config，会把 Workspace override 投影成 User 当前值；
  // 不传 workingDirectory 可保留 User/default 层，同时仍由调用方的 workspacePath 决定
  // package storage 和相对执行上下文。
  return createConfig({
    env: context.deps?.env,
    ...(configScope === "user" ? {} : { workingDirectory: workspacePath }),
  });
}

// [失败路径] 配置里存在但未被发现的插件必须出现在列表里，否则 Settings 里根本看不到它。
// 只合并 enabledPlugins 与 options 两个来源的 id，不要扫描其他配置节。
// packageStatus 与 source 都固定为 missing，二者语义不同不要合并成布尔。
// 名称与 marketplace 由 id 拆分得出，拆分失败直接丢弃该条。
// 这一层不产生诊断，缺失原因由 core 的 diagnostics 负责说明。
function createMissingConfiguredPluginInfos(
  configResult: ConfigResult,
  discoveredPluginIds: ReadonlySet<string>,
): ZCodePluginInfo[] {
  // [契约] 用 Set 去重合并两个来源，同一 id 可能同时出现在 enabledPlugins 与 options。
  // 不要改成数组拼接，重复条目会让列表里出现两个相同插件。
  // 顺序由 Set 插入顺序决定：enabledPlugins 在前，展示顺序依赖这一点。
  // 已发现插件用 discoveredPluginIds 按 id 全等排除，不要按名称比较。
  // 这里的 id 是「name@marketplace」复合形式，不是单纯的插件名。
  const configuredPluginIds = new Set([
    ...Object.keys(configResult.config.plugins.enabledPlugins),
    ...Object.keys(configResult.config.plugins.options),
  ]);
  return [...configuredPluginIds].flatMap((pluginId) => {
    if (discoveredPluginIds.has(pluginId)) return [];
    const separatorIndex = pluginId.lastIndexOf("@");
    if (separatorIndex <= 0 || separatorIndex === pluginId.length - 1) {
      return [];
    }
    const enabledSource = configResult.sources.plugins.enabled[pluginId];
    const optionSources = configResult.sources.plugins.options[pluginId];
    return [
      {
        id: pluginId,
        name: pluginId.slice(0, separatorIndex),
        enabled: configResult.config.plugins.enabledPlugins[pluginId] ?? false,
        source: "missing",
        marketplace: pluginId.slice(separatorIndex + 1),
        skillCount: 0,
        skillRootCount: 0,
        commandRootCount: 0,
        components: [],
        declaredMcpServerNames: [],
        mcpServerNames: [],
        rootPath: "",
        packageStatus: "missing",
        ...(enabledSource ? { enabledSource } : {}),
        ...(optionSources && Object.keys(optionSources).length > 0
          ? { optionSources }
          : {}),
      },
    ];
  });
}

/** 归一化插件根路径用于归属比较：解析绝对路径，Windows 下再统一斜杠并小写。 */
// [契约] 先 resolvePath 再按平台决定是否小写与换正斜杠。
// platform 参数默认 process.platform，测试靠它覆盖 win32 与 posix 分支。
// 返回值只用于比较，不能拿去读写文件或展示。
// [契约] 归属比较只走 normalizePluginRootForComparison：调用点各自拼 resolve 与小写逻辑，win32 上必然出现两种结果。
export function normalizePluginRootForComparison(
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // [权衡] Windows 不区分大小写且斜杠混用，直接比较会把同一根误判为无归属。
  // posix 分支保持原样，避免在大小写不敏感文件系统上引入误判。
  // 归一化结果不得回写配置：配置里保存的仍是原始路径。
  // 未解析符号链接，这是既有取舍：解析会让真实路径与展示路径不一致。
  // 若未来出现大小写敏感但斜杠混用的平台，应新增分支而不是放宽判断。
  const resolvedRoot = resolvePath(rootPath);
  // Windows 路径不区分大小写，且配置与 loader 可能分别返回正斜杠和反斜杠。
  // 若直接做字符串比较，会把同一个 Workspace plugins.dirs 根误判为无归属。
  return platform === "win32"
    ? resolvedRoot.replaceAll("\\", "/").toLowerCase()
    : resolvedRoot;
}

function toPluginDiagnostic(diagnostic: PluginDiagnostic): ZCodePluginDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.pluginId !== undefined ? { pluginId: diagnostic.pluginId } : {}),
  };
}

/**
 * 列出已发现插件 + 配置里存在但已缺失的插件，并附诊断；configScope 决定读 user 还是 workspace 视图。
 * 每次调用现解析目录，不缓存，保证手改文件后 GUI 立即可见。
 */
// [契约] list 是只读操作：不持锁、不写缓存、每次现解析。
// configScope 决定配置视图，workspacePath 决定 project config 与相对上下文。
// 返回顺序是「已发现插件」在前、「配置里缺失」在后，调用方据此分组渲染。
// diagnostics 与 plugins 来源不同，不要按索引做关联。
export async function listPlugins(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsListResult> {
  const params = parseParams(zcodePluginsListParamsSchema, rawParams);
  const configResult = createPluginConfigView(
    context,
    params.workspace.workspacePath,
    params.configScope,
  );
  // [契约] outcome.plugins 是发现的插件，outcome.diagnostics 是解析诊断，两者不可互相推导。
  // configResult 必须与本次 list 是同一个视图，否则 enabled 与 enabledSource 会自相矛盾。
  // workingDirectory 必须与配置视图一致，混用会产生错位的 source。
  // 不要在协议层排序：排序属于展示层，这里保持 core 的稳定顺序。
  // [失败路径] 发现阶段的错误以 diagnostics 返回，list 不因单个坏插件整体失败。
  const outcome = resolveZCodePlugins({
    configResult,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const plugins = outcome.plugins.map((plugin) =>
    toPluginInfo(plugin, configResult),
  );
  return {
    plugins: [
      ...plugins,
      ...createMissingConfiguredPluginInfos(
        configResult,
        new Set(plugins.map((plugin) => plugin.id)),
      ),
    ],
    diagnostics: outcome.diagnostics.map(toPluginDiagnostic),
  };
}

// [事务] 启用/禁用是写操作，写入当前不可回滚。
// abortSignal 在写前检查一次、写后再检查一次，两次作用不同。
// scope 缺省时 enabledSource 记为 user，这是协议层对默认作用域的显式化。
// 返回值里的 plugin 必须由 core 返回的最新 metadata 投影，不要复用入参。
// 投影响应前不要吞掉 core 的异常：写失败必须让调用方看到。
export async function setPluginEnabled(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsSetEnabledResult> {
  const params = parseParams(zcodePluginsSetEnabledParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const result = await setZCodePluginEnabled({
    enabled: params.enabled,
    logger: context.logger,
    plugin: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启用配置写入当前不可回滚；若取消在 IO 期间到达，只阻断后续响应和 UI 写入。
  abortSignal?.throwIfAborted();
  return {
    plugin: {
      ...toPluginInfo(result.plugin),
      enabledSource: params.scope ?? "user",
    },
    enabled: result.enabled,
  };
}

// Overview 是市场/已安装/可恢复内置插件的聚合视图；图标来自已缓存 listing，不等待网络。
// [契约] overview 是市场/已安装/可恢复内置的聚合视图，纯只读。
// 图标来自已缓存的 listing：enrich 只读缓存，不得触发网络刷新。
// enrich 会补内存里的缓存对象，因此必须发生在投影之前。
// 顺序不能颠倒：先 enrich 再 getZCodePluginsOverview，否则新图标进不了结果。
// capability.supported 固定 true，表示本 Host 具备插件能力，与单个插件能否运行无关。
export async function getPluginsOverview(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsOverviewResult> {
  const params = parseParams(zcodePluginsOverviewParamsSchema, rawParams);
  enrichCachedClaudeMarketplaceIconsForOverview({
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const overview = getZCodePluginsOverview({
    configResult: createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    marketplaces: overview.marketplaces.map(toMarketplaceSummary),
    availablePlugins: overview.availablePlugins.map(toAvailablePluginSummary),
    installedPlugins: overview.installedPlugins.map(toInstalledPluginSummary),
    restorableBuiltins: overview.restorableBuiltins.map(toAvailablePluginSummary),
    diagnostics: overview.diagnostics.map(toPluginDiagnostic),
    capability: { supported: true },
  };
}

// 市场/安装类变更统一在 plugin storage 的 in-process 锁内执行，串行化 installed_plugins.json
// 与 cache 目录的读改写，避免并发 install/update 交错；dryRun 由 core 决定是否真正落盘。
// [并发] 与 install/update 共用同一个 storageRoot 锁，避免并发写 installed_plugins.json。
// dryRun 也在锁内执行：即使不落盘也要串行，保证读到一致的中间态。
// abortSignal 透传给 core，由 core 在关键点检查，协议层不重复判。
// core 抛错直接冒泡，不要转成 diagnostics：这是与 install 的刻意差异。
export async function addPluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceAddParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const marketplace = await withPluginStorageLock(pluginStorageRoot, async () =>
    addZCodePluginMarketplace({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { marketplace: toMarketplaceSummary(marketplace), diagnostics: [] };
}

export async function removePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceRemoveParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  await withPluginStorageLock(pluginStorageRoot, async () =>
    removeZCodePluginMarketplace({
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { diagnostics: [] };
}

export async function updatePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    updateZCodePluginMarketplace({
      abortSignal,
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    marketplaces: result.marketplaces.map(toMarketplaceSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

// 安装返回依赖闭包 + 新装插件摘要；失败以 diagnostics 返回而非抛错，由 GUI 展示。
export async function installPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsInstallParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    installZCodeMarketplacePlugin({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      scope: params.scope,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    dependencyClosure: result.dependencyClosure,
    installedPlugins: result.installedPlugins.map(toInstalledPluginSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function uninstallPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsUninstallResult> {
  const params = parseParams(zcodePluginsUninstallParamsSchema, rawParams);
  const removed = await uninstallZCodeMarketplacePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    removeCache: params.removeCache,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ...(removed ? { removedPlugin: toInstalledPluginSummary(removed) } : {}),
    diagnostics: [],
  };
}

// [事务] 整个重装循环必须在同一把锁内，不能每条记录各拿一次锁。
// 候选集在进锁前确定，缩短持锁时间，避免锁内做 I/O 枚举。
// 每条记录重装后立即累加三个数组，不保留中间对象。
// [失败路径] 单条重装失败不中断循环，失败以诊断形式聚合返回。
// 依赖闭包可能含重复项，本层不去重，由调用方决定合并策略。
export async function updatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  // [契约] 过滤顺序是 pluginId 优先、再 marketplace、最后全部，顺序即语义。
  // pluginId 与 marketplace 同时给出时 pluginId 生效，这是刻意的优先级。
  // 两者都不给时更新全部已安装插件，属于危险操作，UI 必须二次确认。
  // [失败路径] 记录读取是同步的，读失败会抛错并中断整个 update，不会静默返回空。
  // 这里不按 enabled 过滤：已禁用插件也需要跟随更新，否则版本会分裂。
  const installed = listInstalledPluginRecords(pluginStorageRoot).filter((record) => {
    if (params.pluginId) return record.id === params.pluginId;
    if (params.marketplace) return record.marketplace === params.marketplace;
    return true;
  });
  // 与 uninstall 一样把整个重装循环串行化到同一 storageRoot 的 in-process 锁里，
  // 避免并发 update/install 交错读改写 installed_plugins.json / cache。
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const installedPlugins: ZCodeInstalledPluginSummary[] = [];
    const dependencyClosure: string[] = [];
    // 聚合每条记录重装产生的诊断：installZCodeMarketplacePlugin 失败时不抛错，而是返回
    // CLI 形态的 PluginDiagnostic（见其错误分支的 toMarketplaceInstallDiagnostic），
    // 这里逐条经协议侧 toPluginDiagnostic 投影成 ZCodePluginDiagnostic 回传，
    // 让失败的重装显式暴露，而不是静默"成功"。
    const diagnostics: ZCodePluginDiagnostic[] = [];
    for (const record of installed) {
      const result = await installZCodeMarketplacePlugin({
        logger: context.logger,
        marketplace: record.marketplace,
        pluginName: record.name,
        scope: record.scope,
        workingDirectory: params.workspace.workspacePath,
      });
      installedPlugins.push(...result.installedPlugins.map(toInstalledPluginSummary));
      dependencyClosure.push(...result.dependencyClosure);
      diagnostics.push(...result.diagnostics.map(toPluginDiagnostic));
    }
    return { dependencyClosure, installedPlugins, diagnostics };
  });
}

// 恢复一个被抑制（"卸载"）的内置插件：清除 suppressedBuiltins 标记并立即重新 seed。
// bootstrap 侧的同名函数被别名为 restoreBuiltinPluginCore，避免与本协议处理器重名。
export async function restoreBuiltinPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsRestoreBuiltinResult> {
  const params = parseParams(zcodePluginsRestoreBuiltinParamsSchema, rawParams);
  await restoreBuiltinPluginCore({
    logger: context.logger,
    pluginId: params.pluginId,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

// 配置写入按 scope 持久化；dryRun 只校验不写，敏感 option 由 core 负责脱敏。
export async function configurePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsConfigureParamsSchema, rawParams);
  await configureZCodePlugin({
    clearOptionKeys: params.clearOptionKeys,
    dryRun: params.dryRun,
    logger: context.logger,
    options: params.options,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function resetPluginConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsResetConfigParamsSchema, rawParams);
  await resetZCodePluginConfig({
    logger: context.logger,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

// 校验结果按 severity 汇总 ok；compatibility 明示当前 Host 能运行/仅诊断/不支持的能力面。
// [契约] ok 只看是否存在 severity === error 的诊断，warning 不影响结果。
// compatibility 是能力声明常量而不是本次校验结果，不要与 ok 混为一谈。
// runnable 与 diagnosticOnly 必须互斥，重叠会让行为不确定。
// 校验也进锁：它会懒加载 manifest 并可能写缓存。
// [失败路径] 校验过程本身抛错时不返回 ok=false，而是让错误冒泡到协议层。
export async function validatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsValidateResult> {
  const params = parseParams(zcodePluginsValidateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const diagnostics = await withPluginStorageLock(pluginStorageRoot, async () =>
    validateZCodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics: diagnostics.map(toPluginDiagnostic),
    compatibility: {
      runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
      diagnosticOnly: ["agents", "lspServers", "outputStyles", "channels", "settings"],
      unsupported: ["mcpb", "dxt", "npm", "hostPattern", "pathPattern"],
    },
  };
}

// [并发] 已安装目录与已缓存 manifest 的读取不持锁，只有懒加载写入进锁。
// withWriteLock 以回调注入，core 决定何时需要写，protocol 不预判。
// 整段持锁会把纯读的 describe 也串行化，正是这条要防的退化。
// components 需重新投影成组件组，不能直接透传 core 结构。
// [契约] metadata 与 diagnostics 都是可选字段，空数组时不输出 diagnostics。
export async function describePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsDescribeResult> {
  const params = parseParams(zcodePluginsDescribeParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  // 已安装目录、已缓存 manifest 与临时 source 解析都不持锁；只有懒加载 manifest 写入进锁。
  const result = await describeZCodePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginName: params.pluginName,
    withWriteLock: (write) => withPluginStorageLock(pluginStorageRoot, write),
    workingDirectory: params.workspace.workspacePath,
  });
  const components: ZCodePluginComponentGroup[] = result.components.map((group) => ({
    kind: group.kind,
    items: group.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
  }));
  const diagnostics = result.diagnostics.map(toPluginDiagnostic);
  return {
    components,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

// [契约] 所有可选字段都用条件展开，undefined 不会出现在结果里。
// isOfficial 用 !== undefined 判断，因为它可能是 false，false 是有效值。
// featured 与 refreshFailure 用真值判断，空数组与 undefined 都视为缺失。
// pluginCount 必填，缺失时由 core 给 0，不要在这里兜底成 undefined。
function toMarketplaceSummary(input: {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial?: boolean;
  featured?: string[];
  refreshFailure?: ZCodePluginMarketplaceSummary["refreshFailure"];
}): ZCodePluginMarketplaceSummary {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    ...(input.description ? { description: input.description } : {}),
    ...(input.lastUpdated ? { lastUpdated: input.lastUpdated } : {}),
    pluginCount: input.pluginCount,
    ...(input.isOfficial !== undefined ? { isOfficial: input.isOfficial } : {}),
    ...(input.featured ? { featured: input.featured } : {}),
    ...(input.refreshFailure ? { refreshFailure: input.refreshFailure } : {}),
  };
}

function toAvailablePluginSummary(input: {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  listing?: ZCodeAvailablePluginSummary["listing"];
}): ZCodeAvailablePluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    installed: input.installed,
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

function toInstalledPluginSummary(input: {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: ZCodeInstalledPluginSummary["hookDetails"];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  listing?: ZCodeInstalledPluginSummary["listing"];
}): ZCodeInstalledPluginSummary {
  return {
    id: input.id,
    name: input.name,
    marketplace: input.marketplace,
    ...(input.description ? { description: input.description } : {}),
    ...(input.version ? { version: input.version } : {}),
    enabled: input.enabled,
    scope: input.scope,
    ...(input.installPath ? { installPath: input.installPath } : {}),
    ...(input.installedAt ? { installedAt: input.installedAt } : {}),
    ...(input.componentTypes ? { componentTypes: input.componentTypes } : {}),
    ...(input.hookDetails ? { hookDetails: input.hookDetails } : {}),
    ...(input.updateStatus ? { updateStatus: input.updateStatus } : {}),
    ...(input.latestVersion ? { latestVersion: input.latestVersion } : {}),
    ...(input.listing ? { listing: input.listing } : {}),
  };
}

// [契约] storage root 由 config.storage.dir 推导，必须先 createConfig 再 resolvePath。
// 不要在协议层硬编码目录名：路径规则属于 adapters。
// [权衡] 每次新建 config 而不缓存，保证配置改动后锁键立即正确。
// getCliStorageRoot → getPluginStorageRoot 的嵌套顺序不能颠倒。
// 该函数可能因配置不可读而抛错，由调用方冒泡，不在这里吞掉。
function resolvePluginStorageRoot(workingDirectory: string): string {
  const config = createConfig({ workingDirectory });
  const storageRoot = resolvePath(config.config.storage.dir);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}
