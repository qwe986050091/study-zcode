// INV-01 权威来源二选一：带会话标识走会话冻结目录，不带走工作区实时目录，守住位置 引用目录函数的分支；改错故障：混用两种权威会让草稿与会话引用同一插件却指向不同身份。
// INV-02 会话不存在时必须失败而不是回退：守住位置 会话获取调用；改错故障：静默回退到工作区会让已结束会话的残余请求读到当前目录，产生越权引用。
// INV-03 会话分支只读冻结快照：不得重新解析插件目录，守住位置 会话分支的目录读取；改错故障：重新解析会让会话中途的目录变更污染已冻结身份。
// INV-04 展示字段与身份字段分离：图标与显示名来自商店，身份来自冻结目录，守住位置 条目投影函数；改错故障：把展示字段并进身份会让会话引用随商店更新而漂移。
// INV-05 展示合并不用空值覆盖非空：后出现的来源只补空缺，守住位置 展示映射的展开顺序；改错故障：直接覆盖会让已安装插件的本地化名被空字段抹掉。
// INV-06 身份投影显式丢弃根路径：路径不出协议，守住位置 条目投影的字段清单；改错故障：透传根路径会把本机路径泄漏给渲染层。
// INV-07 推荐引用只信任官方市场：来源与稳定标识正则同时校验，守住位置 推荐解析的首个分支；改错故障：放宽来源会让同名第三方插件被自动安装。
// INV-08 稳定标识以最后一个连接符为界拆成名称与市场：守住位置 末位查找的取值；改错故障：按首个连接符切分会让作用域形式的包名解析出错误市场段。
// INV-09 冲突状态禁止自动安装：同名多来源一律判冲突，守住位置 结果状态推导；改错故障：冲突时按启用态返回会让用户装到非预期来源。
// INV-10 本地缺失时先刷新再判定缺失：守住位置 刷新前后的两次读取；改错故障：只读本地快照会把可安装插件误报为不存在。
// INV-11 刷新前必须通知进度：守住位置 刷新中通知；改错故障：无反馈会让用户在长时间网络等待中重复点击。
// INV-12 刷新超时必须中止底层请求：守住位置 超时定时器中的中止调用；改错故障：仅结束协议等待会让旧操作继续改写目录快照。
// INV-13 取消信号透传到刷新与定时器：守住位置 中止函数与收尾清理；改错故障：漏清理监听会让已取消的操作仍占用连接并重复上报。
// INV-14 刷新失败与取消要区分错误码：守住位置 异常分支的三个返回值；改错故障：统一成失败会让界面无法区分用户取消与真实网络错误。
// INV-15 图标只取目标 Host 已缓存的商店条目：守住位置 图标惰性解析；改错故障：为图标触发网络会让选择器打开被网络阻塞。
// INV-16 刷新后仍未列出即判未上架：名称与市场都要复核，守住位置 候选插件的三项判断；改错故障：只判存在会把同名不同市场的结果误认为可引用。
// INV-17 展示查询不得改变安装态：只读概览，守住位置 展示映射函数体；改错故障：在读路径里触发写入会让一次选择器打开产生副作用。
// INV-18 协议结果字段可选且不写空值：用条件展开，守住位置 各返回对象；改错故障：写出空值键会在序列化时改变客户端默认值判断。
//
// 模块职责：提供插件对话引用目录与推荐引用解析两条只读协议，把身份投影与商店展示字段分开处理。
// 状态所有权：无持久状态；刷新用的中止控制器与定时器都是单次调用的局部资源，在收尾块释放。
// 阅读顺序：先看目录函数的会话与工作区分支，再看推荐解析的校验与刷新流程，最后看展示合并与身份投影。
// Plugin 对话引用 catalog 的协议 handler。
// 与 plugins.ts（安装/市场/启停等管理面）分文件：本查询是会话/草稿 Picker 的只读投影，
// 且 plugins.ts 已接近 max-lines 门禁。
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  zcodeProtocolNotifications,
  zcodePluginsReferenceCatalogParamsSchema,
  zcodePluginsResolveSuggestedReferenceParamsSchema,
  type ZCodePluginReferenceCatalogEntry,
  type ZCodePluginDiagnostic as SharedPluginDiagnostic,
  type ZCodePluginsReferenceCatalogResult,
  type ZCodePluginsResolveSuggestedReferenceResult,
} from "@zcode/shared";
import type { PluginReferenceCatalogEntry } from "@zcode/contracts";
import { buildPluginReferenceCatalog } from "@zcode/core";
import {
  enrichCachedClaudeMarketplaceIconsForOverview,
  getZCodePluginsOverview,
  resolveZCodePlugins,
  updateZCodePluginMarketplace,
} from "../plugins.js";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

// Picker 权威：带 sessionId → 该 Session 创建时冻结的 identity catalog（session-owned）；
// 不带 → workspace 当前 catalog（新建草稿）。session 不存在时按协议错误 fail closed，
// 禁止静默回退 workspace authority——否则草稿/会话两种权威会被混淆。
// 两个入口共享同一返回类型，调用方按权威字段区分来源
// [失败路径] 权威字段只作说明，真正的权威由分支决定，二者不能脱节
// 分类字段默认关闭，避免给不需要分类的调用方增加输出形状
// 参数一律先过 schema 解析，不直接信任协议原文
// 本函数只读，不触发任何目录刷新
export async function getPluginReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  includeCategory = false,
): Promise<ZCodePluginsReferenceCatalogResult> {
  // 参数解析是协议边界，非法输入在这里统一失败
  // [失败路径] 跳过解析直接取字段，会让缺失的工作区在深处才暴露为空值访问
  // schema 同时约束结构与可选字段，避免各处理器各自兜底
  // 解析结果随后只读使用，不再二次校验
  // 该行为两条分支共用，保证输入语义一致
  const params = parseParams(zcodePluginsReferenceCatalogParamsSchema, rawParams);
  // 带会话标识即代表会话权威，必须使用该会话创建时冻结的目录
  // [失败路径] 会话不存在时按协议错误失败，禁止回退到工作区
  // 冻结快照保证同一会话多次打开选择器得到相同身份
  // 展示字段仍从目标 Host 的商店缓存补齐，与冻结身份不冲突
  // 该分支不读取工作区解析结果，避免两条权威混流
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const displayByPluginId = resolveReferenceListingDisplayByPluginId(
      params.workspace.workspacePath,
    );
    return {
      authority: "session",
      plugins: record.app
        .getPluginReferenceCatalog()
        .plugins.map((entry) => toReferenceCatalogEntry(entry, displayByPluginId, includeCategory)),
    };
  }
  const outcome = resolveZCodePlugins({
    workingDirectory: params.workspace.workspacePath,
  });
  const displayByPluginId = resolveReferenceListingDisplayByPluginId(
    params.workspace.workspacePath,
  );
  return {
    authority: "workspace",
    plugins: buildPluginReferenceCatalog(outcome.plugins).plugins.map((entry) =>
      toReferenceCatalogEntry(entry, displayByPluginId, includeCategory),
    ),
  };
}

const SUGGESTED_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;
const SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS = 10_000;

/** 推荐 Prompt 的安装前可信解析；missing 必须先刷新官方目录，失败时禁止旧快照安装。 */
// 返回状态 ready/disabled/conflict/missing：conflict 指同名多来源，禁止自动安装；
// 图标只取目标 Host 已缓存的官方 listing，随解析一次性返回。
// 推荐解析是安装前的可信判定，任何不确定都必须落到不可用
// [失败路径] 来源或标识格式不符时直接返回不可信，而不是尝试兼容
// 稳定标识的三个片段在同一次解析中确定，避免各处重复切分
// 本地命中优先返回，避免为已安装插件发起网络刷新
// 只有本地缺失才进入刷新流程，且必须先通知进度
export async function resolveSuggestedPluginReference(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  signal?: AbortSignal,
): Promise<ZCodePluginsResolveSuggestedReferenceResult> {
  const params = parseParams(zcodePluginsResolveSuggestedReferenceParamsSchema, rawParams);
  const stableId = params.stableId.trim();
  const at = stableId.lastIndexOf("@");
  const pluginName = at > 0 ? stableId.slice(0, at) : "";
  const marketplace = at > 0 ? stableId.slice(at + 1) : "";
  const diagnostic = (code: string, message: string): SharedPluginDiagnostic => ({
    code,
    message,
    severity: "error",
    pluginId: stableId,
  });
  const unavailable = (code: string, message: string) => ({
    stableId,
    status: "unavailable" as const,
    diagnostics: [diagnostic(code, message)],
  });

  if (
    !pluginName ||
    marketplace !== SUGGESTED_PLUGIN_MARKETPLACE ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(stableId)
  ) {
    return unavailable(
      "plugin_suggested_reference_untrusted_source",
      "推荐插件不是受信任的官方 zcode-plugins-official 来源",
    );
  }

  // 刷新以工作区为作用域，官方市场是唯一目标
  // [并发] 刷新与协议等待之间用竞态与超时双保险，任一侧结束都要收敛
  // [失败路径] 超时只结束等待不够，必须中止底层请求，否则旧操作继续改写快照
  // 取消信号在监听与主动检查两处生效，覆盖信号早于注册的窗口
  // 刷新结束后重新读取一次状态，再决定就绪、缺失或不可用
  const workingDirectory = params.workspace.workspacePath;
  const readState = () => {
    const outcome = resolveZCodePlugins({ logger: context.logger, workingDirectory });
    const entry = buildPluginReferenceCatalog(outcome.plugins).plugins.find(
      (candidate) => candidate.pluginId === stableId,
    );
    return { outcome, entry };
  };
  let displayByPluginId: Map<string, PluginReferenceListingDisplay> | undefined;
  const resolveIcon = () => {
    // 图标只来自目标 Host 已缓存的官方 listing，并随可信解析一次返回；UI 不再为它读取
    // workspace referenceCatalog。overview 不等待网络，缺失时按无图标降级。
    displayByPluginId ??= resolveReferenceListingDisplayByPluginId(workingDirectory);
    return displayByPluginId.get(stableId)?.icon;
  };
  const toResult = (entry: PluginReferenceCatalogEntry) => {
    const icon = resolveIcon();
    return {
      stableId,
      status: (entry.conflictingPluginIds.length > 0
        ? "conflict"
        : entry.enabled
          ? "ready"
          : "disabled") as "conflict" | "ready" | "disabled",
      marketplace,
      pluginName,
      sourceTrust: "official" as const,
      ...(icon ? { icon } : {}),
      diagnostics:
        entry.conflictingPluginIds.length > 0
          ? [
              diagnostic(
                "plugin_suggested_reference_conflict",
                "推荐插件存在同名冲突，不能自动安装或引用",
              ),
            ]
          : [],
    };
  };

  const initial = readState();
  if (initial.entry) return toResult(initial.entry);

  // 旧流程只有官方 Marketplace 刷新完成后才把 missing 结果返回 UI，网络等待期间
  // 没有任何反馈，用户会误以为点击未生效。首次本地检查缺失后先通知同一 operation 进入 loading。
  context.notify({
    method: zcodeProtocolNotifications.pluginOperationProgress,
    params: { operationId: params.operationId, state: "refreshing" },
  });

  const refreshController = new AbortController();
  const abortRefresh = () => refreshController.abort(signal?.reason);
  if (signal?.aborted) abortRefresh();
  else signal?.addEventListener("abort", abortRefresh, { once: true });
  let refreshTimedOut = false;
  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const refreshRequest = updateZCodePluginMarketplace({
      abortSignal: refreshController.signal,
      logger: context.logger,
      marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
      workingDirectory,
    });
    const refreshTimeoutRequest = new Promise<never>((_, reject) => {
      // 刷新超时必须中止底层网络/进程；仅结束协议等待会让旧 operation 继续改写目录快照。
      refreshTimeout = setTimeout(() => {
        refreshTimedOut = true;
        const timeoutError = new Error("刷新 zcode-plugins-official 超时（10000 ms）");
        timeoutError.name = "TimeoutError";
        refreshController.abort(timeoutError);
        reject(timeoutError);
      }, SUGGESTED_PLUGIN_MARKETPLACE_REFRESH_TIMEOUT_MS);
    });
    const refreshed = await Promise.race([refreshRequest, refreshTimeoutRequest]);
    if (signal?.aborted) return unavailable("plugin_operation_cancelled", "插件操作已取消");
    const failure = refreshed.diagnostics.find(
      (item) => item.pluginId === SUGGESTED_PLUGIN_MARKETPLACE,
    );
    if (failure) return unavailable("marketplace_refresh_failed", failure.message);
  } catch (error) {
    if (refreshTimedOut) {
      return unavailable(
        "marketplace_refresh_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal?.aborted) {
      return unavailable("plugin_operation_cancelled", "插件操作已取消");
    }
    return unavailable(
      "marketplace_refresh_failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (refreshTimeout !== undefined) clearTimeout(refreshTimeout);
    signal?.removeEventListener("abort", abortRefresh);
  }

  const afterRefresh = readState();
  if (afterRefresh.entry) return toResult(afterRefresh.entry);
  const overview = getZCodePluginsOverview({ logger: context.logger, workingDirectory });
  const candidate = overview.availablePlugins.find((item) => item.id === stableId);
  if (
    !candidate ||
    candidate.name !== pluginName ||
    candidate.marketplace !== SUGGESTED_PLUGIN_MARKETPLACE
  ) {
    return unavailable("plugin_suggested_reference_not_listed", "刷新后的官方目录中未找到该插件");
  }
  const icon = candidate.listing?.icon?.trim();
  return {
    stableId,
    status: "missing",
    marketplace: SUGGESTED_PLUGIN_MARKETPLACE,
    pluginName: candidate.name,
    sourceTrust: "official",
    ...(icon ? { icon } : {}),
    ...(candidate.listing ? { listing: candidate.listing } : {}),
    diagnostics: [],
  };
}

/**
 * icon/displayName(I18n) 是目标 Host Marketplace listing 的可变展示投影，不属于冻结
 * Session 身份。根因：商店 listing 才是原始图标/本地化显示名的事实源，plugin
 * manifest/runtime metadata 不携带它们。workingDirectory 只用于沿既有 Host/config
 * 边界定位数据；这里按 stable ID join，只用于 Picker/chip 展示与搜索，
 * reminder 仍只消费 core identity catalog。
 */
// 展示投影只承载可变字段，身份字段不在此结构内
// [失败路径] 把图标或本地化名并进身份会让会话引用随商店更新漂移
// 合并时后出现的来源只覆盖非空字段，避免空值抹掉已有译文
// 全部字段为空时不写入映射，减少无意义的空条目
// 工作区路径只用于定位既有 Host 数据，不进入协议输出
interface PluginReferenceListingDisplay {
  category?: string;
  icon?: string;
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  description?: string;
  descriptionI18n?: Record<string, string>;
}

// 按 pluginId 合并 available/installed/restorableBuiltins 的 listing 展示字段；
// 后出现的来源只覆盖非空字段，避免已安装插件的本地化信息被空值抹掉。
function resolveReferenceListingDisplayByPluginId(
  workspacePath: string,
): Map<string, PluginReferenceListingDisplay> {
  enrichCachedClaudeMarketplaceIconsForOverview({ workingDirectory: workspacePath });
  const overview = getZCodePluginsOverview({ workingDirectory: workspacePath });
  const displayByPluginId = new Map<string, PluginReferenceListingDisplay>();
  for (const plugin of [
    ...overview.availablePlugins,
    ...overview.installedPlugins,
    ...overview.restorableBuiltins,
  ]) {
    const category = plugin.listing?.category?.trim();
    const icon = plugin.listing?.icon?.trim();
    const displayName = plugin.listing?.displayName?.trim();
    const displayNameI18n = plugin.listing?.displayNameI18n;
    const description = plugin.description?.trim();
    const descriptionI18n = plugin.listing?.descriptionI18n;
    if (!category && !icon && !displayName && !displayNameI18n && !description && !descriptionI18n)
      continue;
    displayByPluginId.set(plugin.id, {
      ...displayByPluginId.get(plugin.id),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
      ...(displayName ? { displayName } : {}),
      ...(displayNameI18n ? { displayNameI18n } : {}),
      ...(description ? { description } : {}),
      ...(descriptionI18n ? { descriptionI18n } : {}),
    });
  }
  return displayByPluginId;
}

// 身份/能力投影显式丢弃 rootPath（仅 runtime 内部 provenance 用，路径不出协议）；
// icon/displayName(I18n)/description(I18n) 仅供展示，不改变 identifiers-only reminder 契约。
// 身份投影的字段清单就是协议契约，增删都要评估兼容性
// [失败路径] 显式丢弃根路径，避免本机路径随协议进入渲染层
// 分类字段只在调用方要求时加入，默认不改变既有输出形状
// 展示字段存在才展开，缺失时客户端按无值处理
// 该函数不读取磁盘，全部输入来自已解析的目录与展示映射
function toReferenceCatalogEntry(
  entry: PluginReferenceCatalogEntry,
  displayByPluginId: ReadonlyMap<string, PluginReferenceListingDisplay>,
  includeCategory = false,
): ZCodePluginReferenceCatalogEntry {
  const display = displayByPluginId.get(entry.pluginId);
  return {
    ...(includeCategory ? { category: display?.category ?? "other" } : {}),
    pluginId: entry.pluginId,
    name: entry.name,
    marketplace: entry.marketplace,
    ...(display?.icon ? { icon: display.icon } : {}),
    ...(display?.displayName ? { displayName: display.displayName } : {}),
    ...(display?.displayNameI18n ? { displayNameI18n: display.displayNameI18n } : {}),
    ...(display?.description ? { description: display.description } : {}),
    ...(display?.descriptionI18n ? { descriptionI18n: display.descriptionI18n } : {}),
    enabled: entry.enabled,
    conflictingPluginIds: entry.conflictingPluginIds,
    skillQualifiedNames: entry.skillQualifiedNames,
    mcpServerNames: entry.mcpServerNames,
    subagentNames: entry.subagentNames ?? [],
  };
}
