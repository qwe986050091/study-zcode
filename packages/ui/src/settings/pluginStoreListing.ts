// INV-01 守住位置：buildStoreItems 产出的 StorePluginItem 是商店、管理列表与详情页共用的唯一视图模型。改错故障：字段语义漂移会同时污染三处渲染，出现商店已装而详情未装的矛盾。
// INV-02 守住位置：isItemBusy 的忙碌键必须与安装、恢复、卸载、更新、重置、保存配置的操作 id 逐字对齐。改错故障：前缀或分隔符写错一个字，按钮可点但操作被静默吞掉。
// INV-03 守住位置：canUpdatePluginItem 必须同时校验 orphaned 与 updateStatus。改错故障：只看缓存的更新状态，孤立插件会在菜单已禁用更新时仍露出更新入口。
// INV-04 守住位置：resolveUniquePluginListingByName 仅在 count 为 1 时接管 listing。改错故障：同名插件并存时按裸名称 join，第三方条目的品牌与图标会挂到别的 marketplace 上。
// INV-05 守住位置：resolvePluginStoreSegment 先判 isPublicStoreMarketplaceId，再看 publisherType。改错故障：顺序颠倒会把个人源误判成 community，分段页签整组错位。
// INV-06 守住位置：isUiPluginItem 先看 info 的 uiSurfaces，再回落 installedMeta 与 summary 的 componentTypes。改错故障：顺序颠倒会让已安装清单里的真实元数据被目录宣传字段盖掉。
// INV-07 守住位置：sortMarketplaceSources 的官方置顶只认 OFFICIAL_MARKETPLACE_ORDER 的下标。改错故障：丢掉一侧 undefined 分支，自定义源会插到官方源之前。
// INV-08 守住位置：sortPersonalMarketplaceGroups 用 ISO 时间串的字典序模拟时间倒序。改错故障：把缺失的 lastUpdated 当成有效值，未刷新过的市场会浮到最上面。
// INV-09 守住位置：selectFeaturedItems 先用 byName 按名字建索引，再用 seen 按 id 去重。改错故障：漏掉 seen 会让同一插件在 Featured 里重复出现。
// INV-10 守住位置：groupItemsByCategory 先排序再落桶。改错故障：先分桶后排序会把分类内顺序还原成输入顺序，与商店整体顺序不一致。
// INV-11 守住位置：storeItemMatches 把名称、id、市场、本地化名与描述、分类与作者一并交给 pluginSearchMatches。改错故障：少传字段会出现搜得到标题却搜不到作者的死角。
// INV-12 守住位置：sortInstalledStripItems 以 compareDocumentPluginPriority 为首关键字。改错故障：文档插件优先级后移会让已安装图标条首屏顺序抖动。
// INV-13 [失败路径] 守住位置：overview 失败时 marketplaceAvailabilityKnown 为 false，不得把 source 为 cache 的插件推导成孤立。改错故障：无依据地把正常插件标成 orphaned，用户被引导去卸载重装。
// INV-14 [失败路径] 守住位置：packageStatus 为 missing 的插件既不进商店条目，也不凭运行时发现生成安装入口。改错故障：缺包诊断被当成可安装来源，点击安装后必然失败。
// INV-15 [权衡] 守住位置：restorableBuiltins 覆盖已有条目时先看 installed、installedMeta、info 三项归属。改错故障：任一归属已存在仍改写为 restorable，详情页会把用户插件误显示成 Restore。
// INV-16 [并发] 守住位置：isItemBusy 还要单独比对 togglingPluginId。改错故障：启停进行中仍可发起安装或更新，同一插件出现两条互相覆盖的写操作。
// INV-17 [资源] 守住位置：两个排序函数都用 toSorted 返回新数组，不改写入参。改错故障：换回就地排序会污染调用方持有的市场源数组，刷新后顺序错乱。
// INV-18 [事务] 守住位置：buildStoreItems 三段循环共用 items 这一个 Map，重复 id 必须显式判断。改错故障：直接覆盖会丢掉已建好的安装态与 installedMeta。
//
// 模块职责：settings 插件商店的纯函数层，负责 listing 关联、分段判定、分类分组、搜索匹配与各式排序，不持有状态也不发起请求。
// 状态所有权：overview 数据与 actions 由调用方注入，本模块只读入参，只返回新数组或新对象。
// 阅读顺序：先看 buildStoreItems 的条目宇宙，再看 isItemBusy 与 canUpdatePluginItem 的门禁，最后看分段、分组与排序。
import type {
  PluginStoreModeOrder,
  ZCodeAvailablePluginSummary,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import {
  sortPluginStoreEntries,
  compareDocumentPluginPriority,
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  formatCanonicalPluginName,
  isPublicStoreMarketplaceId,
  resolveLocalizedText,
  resolvePluginDisplayName,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
} from "@zcode/shared";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

export {
  formatCanonicalPluginName,
  resolveLocalizedText,
  resolvePluginDisplayName,
} from "@zcode/shared";

export { isPublicStoreMarketplaceId };
export { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

/**
 * 仅在名称唯一时允许从目录条目回退解析 listing。
 * 能力协议的旧 payload 可能没有 pluginId；同名插件并存时继续按裸名称 join
 * 会把第三方条目的品牌和图标误挂到另一个 marketplace，安全降级为 slug 更可靠。
 */
// 名称先 trim 再 toLocaleLowerCase 归一化，比较基准是归一化结果而不是原始 name。
// [权衡] 只有 count 恰好为 1 才返回 match，0 或多于 1 一律降级为 undefined，宁可显示 slug 也不让同名插件串源。
// 循环里 match 每次覆盖只用于取唯一值，真正的判定依据是 count；删掉计数会让最后一个同名条目静默胜出。
export function resolveUniquePluginListingByName(
  plugins: readonly Pick<ZCodeAvailablePluginSummary, "name" | "listing">[],
  name: string,
): ZCodePluginStoreListing | undefined {
  const normalizedName = name.trim().toLocaleLowerCase();
  let match: ZCodePluginStoreListing | undefined;
  let count = 0;
  for (const plugin of plugins) {
    if (plugin.name.trim().toLocaleLowerCase() !== normalizedName) continue;
    count += 1;
    match = plugin.listing;
  }
  return count === 1 ? match : undefined;
}

/**
 * 商店条目：把 overview 的目录条目（listing/安装态）、运行时插件信息（启用态/组件）与
 * 已安装记录（更新徽标/安装时间）按 id join 成 UI 单一视图模型。
 */
// installed、restorable、orphaned 三者语义互斥，同时为真会让按钮在安装、恢复、更新之间反复横跳。
// listing 来自目录、summary 来自可用插件、info 来自运行时发现、installedMeta 来自已安装记录，四源缺失组合决定 UI 能显示哪些字段。
// [失败路径] orphaned 只表示原来源已移除，仍可运行与管理但不可更新；判定收敛在 canUpdatePluginItem，不在此处重算。
export interface StorePluginItem {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  /** 已卸载的内置插件（可恢复）：安装按钮走 restoreBuiltin。 */
  restorable: boolean;
  /** 已安装但原 marketplace 已移除；仍可运行和管理，但不能更新。 */
  orphaned: boolean;
  listing?: ZCodePluginStoreListing;
  summary?: ZCodeAvailablePluginSummary;
  /** 运行时信息（仅已发现的已安装插件有）：启用态、组件、manifest 回退字段。 */
  info?: ZCodePluginInfo;
  installedMeta?: ZCodeInstalledPluginSummary;
}

// 市场和右侧推荐共用按插件的忙碌判定，避免安装一个插件时禁用整个推荐列表。
// 忙碌 id 由前缀加 item.name、item.marketplace 或 item.id 拼出，改动前缀或分隔符必须与操作生成处同步。
// [并发] configure 与 reset-config 同属写操作，漏掉任一都会在保存配置期间允许恢复默认或更新。
// togglingPluginId 单独比对 item.id，它与 activeOperations 不同源，只查数组会漏掉启停中的插件。
export function isItemBusy(
  item: StorePluginItem,
  actions: { activeOperations: ReadonlyArray<{ id: string }>; togglingPluginId: string | null },
): boolean {
  return (
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:install:${item.name}@${item.marketplace}`,
    ) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:restore:${item.id}`) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:uninstall:${item.id}`) ||
    actions.activeOperations.some((operation) => operation.id === `plugin:update:${item.id}`) ||
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:reset-config:${item.id}`,
    ) ||
    // 保存配置也是同插件写操作；漏掉它时恢复默认、更新可在保存期间被点击。
    actions.activeOperations.some((operation) => operation.id === `plugin:configure:${item.id}`) ||
    actions.togglingPluginId === item.id
  );
}

export type PluginUpdateStatus = NonNullable<ZCodeInstalledPluginSummary["updateStatus"]>;

// 只有 update-available 与 version-changed 视为待更新，none 以及后续新增枚举值默认不打扰用户。
// 类型谓词把 undefined 一并收窄，调用方据此省掉空值判断；改签名会波及 canUpdatePluginItem。
export function isPluginUpdatePending(
  updateStatus: PluginUpdateStatus | undefined,
): updateStatus is Exclude<PluginUpdateStatus, "none"> {
  return updateStatus === "update-available" || updateStatus === "version-changed";
}

/**
 * 孤立插件可能保留删除来源前的 updateStatus；若各入口只判断该缓存状态，
 * 详情页会在菜单已禁用更新时仍显示更新按钮。更新能力必须同时满足“来源存在”和“有更新”。
 */
// [失败路径] orphaned 优先于 updateStatus，孤立插件残留的旧状态不能复活更新入口。
// 入参允许 null 与 undefined，item 为空必须返回 false，短路顺序反了会在详情页抛异常。
export function canUpdatePluginItem(
  item: Pick<StorePluginItem, "installedMeta" | "orphaned"> | null | undefined,
): boolean {
  return Boolean(item && !item.orphaned && isPluginUpdatePending(item.installedMeta?.updateStatus));
}

// 回退顺序为精确 locale、同语言前缀、base，跳过中间层会让 zh-CN 拿不到 zh 的列表。
// 空数组与 undefined 等价处理，否则空本地化会覆盖可用的 base 文案。
export function resolveLocalizedList(
  locale: string,
  base: string[] | undefined,
  i18n: Record<string, string[]> | undefined,
): string[] | undefined {
  if (i18n) {
    const exact = i18n[locale];
    if (exact && exact.length > 0) return exact;
    const language = locale.split("-")[0];
    if (language) {
      const match = Object.entries(i18n).find(([key]) => key.split("-")[0] === language);
      if (match?.[1] && match[1].length > 0) return match[1];
    }
  }
  return base && base.length > 0 ? base : undefined;
}

export function formatCanonicalMarketplaceName(name: string, locale: string): string {
  return formatCanonicalPluginName(name, locale);
}

export function resolveItemDisplayName(item: StorePluginItem, locale: string): string {
  return resolvePluginDisplayName(item, locale);
}

export function resolveItemDescription(item: StorePluginItem, locale: string): string | undefined {
  const base =
    item.summary?.description ?? item.info?.description ?? item.installedMeta?.description;
  return resolveLocalizedText(locale, base, item.listing?.descriptionI18n);
}

/** 管理列表与商店复用完整 ID 关联的展示信息，避免英文 manifest 绕过本地化。 */
export function resolveManagedPluginDisplay(
  plugin: ZCodePluginInfo,
  item: StorePluginItem | undefined,
  locale: string,
): { name: string; description: string | undefined } {
  const matchingItem = item?.id === plugin.id ? item : undefined;
  return {
    name: resolvePluginDisplayName(matchingItem ?? plugin, locale),
    description: matchingItem ? resolveItemDescription(matchingItem, locale) : plugin.description,
  };
}

/** 已知分类的 i18n 映射；未知分类原样展示。无分类 → "other" 区块（排最后）。 */
// 键必须与 resolveStoreCategory 的返回值逐一对应，多一个或少一个都会让该分类退化成原样英文。
// other 必须在表内，无分类条目归入它并排在最后，缺键会让兜底文案变成裸标识。
export const KNOWN_CATEGORY_LABEL_IDS: Record<string, string> = {
  "developer-tools": "settings.plugins.store.category.developerTools",
  productivity: "settings.plugins.store.category.productivity",
  utilities: "settings.plugins.store.category.utilities",
  legal: "settings.plugins.store.category.legal",
  template: "settings.plugins.store.category.template",
  finance: "settings.plugins.store.category.finance",
  other: "settings.plugins.store.category.other",
};

export {
  resolvePluginStoreCategory as resolveStoreCategory,
  FALLBACK_PLUGIN_STORE_CATEGORY as FALLBACK_CATEGORY,
  PLUGIN_STORE_CATEGORY_ORDER as KNOWN_CATEGORY_ORDER,
} from "@zcode/shared";

export interface StoreCategoryGroup {
  category: string;
  items: StorePluginItem[];
}

export type PluginStoreSegment = "public" | "community" | "personal";

// 先判 isPublicStoreMarketplaceId 再看 publisherType，非公开源一律 personal，顺序颠倒会把私源社区插件混进 community。
// publisherType 缺省时按 public 处理；把缺省当 community 会让官方插件从公开分段消失。
export function resolvePluginStoreSegment(item: StorePluginItem): PluginStoreSegment {
  if (!isPublicStoreMarketplaceId(item.marketplace)) return "personal";
  return item.listing?.publisherType === "community" ? "community" : "public";
}

// 已安装清单优先：info 存在时只看 uiSurfaces，避免目录宣传字段盖过真实安装元数据。
// 回退链为 installedMeta 的 componentTypes 再到 summary 的 componentTypes，判定错会让纯后台插件出现在 UI 分组。
export function isUiPluginItem(item: StorePluginItem): boolean {
  // 已安装清单优先于目录宣传；禁用仍保留经过校验的 surface 元数据。
  if (item.info) return Boolean(item.info.uiSurfaces?.length);
  return Boolean(
    (item.installedMeta?.componentTypes ?? item.summary?.componentTypes)?.includes("ui"),
  );
}

/** 个人分段的市场分组：marketplace 是排序键，title 是展示名。 */
export interface PersonalMarketplaceGroup {
  marketplace: string;
  title: string;
  items: StorePluginItem[];
}

const OFFICIAL_MARKETPLACE_ORDER = [
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  DEFAULT_MARKETPLACE_ID,
] as const;

/**
 * 市场源管理排序：官方源固定置顶；自定义源按最近刷新时间倒序，未刷新过的沉底。
 * 同一时间使用本地化名称稳定兜底，避免市场源顺序随持久化数组历史漂移。
 */
// 官方源按 OFFICIAL_MARKETPLACE_ORDER 的下标排序，只在一侧命中官方时立即分出胜负。
// 自定义源按 lastUpdated 倒序，缺失时间用空串沉底，同刻再按本地化名称与 id 稳定。
// [资源] 全程 toSorted 返回新数组，就地排序会改写调用方持有的市场源数组。
export function sortMarketplaceSources(
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): ZCodePluginMarketplaceSummary[] {
  const officialRank = new Map(OFFICIAL_MARKETPLACE_ORDER.map((id, index) => [id, index]));
  return marketplaces.toSorted((left, right) => {
    const leftRank = officialRank.get(left.id);
    const rightRank = officialRank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }

    const leftAt = left.lastUpdated ?? "";
    const rightAt = right.lastUpdated ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    const byName = left.name.localeCompare(right.name, locale);
    return byName !== 0 ? byName : left.id.localeCompare(right.id, locale);
  });
}

/**
 * 个人分段市场分组排序：按 lastUpdated 倒序——最近刷新/添加的市场在最上，
 * 用户添加成功跳转过来第一眼就能看到；无 lastUpdated（官方 seed 未刷新过）的沉底，
 * 同刻或都缺失时按显示名字母序稳定兜底。ISO 时间串的字典序即时间序。
 */
// 分组本身不带时间，必须先由 marketplaces 建 lastUpdatedById 再查，直接读分组字段会永远并列。
// [权衡] 时间相同则按 title 本地化比较，保证刷新后顺序不随 Map 插入序漂移。
export function sortPersonalMarketplaceGroups(
  groups: PersonalMarketplaceGroup[],
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  locale: string,
): PersonalMarketplaceGroup[] {
  const lastUpdatedById = new Map(
    marketplaces.flatMap((marketplace) =>
      marketplace.lastUpdated ? ([[marketplace.id, marketplace.lastUpdated]] as const) : [],
    ),
  );
  return groups.toSorted((left, right) => {
    const leftAt = lastUpdatedById.get(left.marketplace) ?? "";
    const rightAt = lastUpdatedById.get(right.marketplace) ?? "";
    // 空串字典序小于任何时间串，倒序比较自然把缺失时间沉底。
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return left.title.localeCompare(right.title, locale);
  });
}

/**
 * 把 overview 数据 join 成商店条目集合。
 * 条目宇宙 = availablePlugins ∪ restorableBuiltins ∪ 实际发现的插件包（覆盖 inline/孤儿插件）。
 */
// 条目宇宙为 availablePlugins、restorableBuiltins 与 plugins 的并集，少一段就会让 inline 或孤立安装从商店消失。
// 第一段以 summary.id 建条目，info 存在且 packageStatus 非 missing 时才认定为已安装。
// 第二段处理恢复态，已存在条目需先检查 installed、installedMeta、info 三项归属。
// 第三段补运行时发现的插件，[失败路径] packageStatus 为 missing 的直接跳过，阻断安装入口。
// [事务] orphaned 只在 marketplaceAvailabilityKnown、source 为 cache、市场不在 marketplaceIds 三者同时成立时才置真。
export function buildStoreItems(input: {
  marketplaces: ZCodePluginMarketplaceSummary[];
  marketplaceAvailabilityKnown: boolean;
  availablePlugins: ZCodeAvailablePluginSummary[];
  installedPlugins: ZCodeInstalledPluginSummary[];
  plugins: ZCodePluginInfo[];
  restorableBuiltins: ZCodeAvailablePluginSummary[];
}): StorePluginItem[] {
  const infoById = new Map(input.plugins.map((plugin) => [plugin.id, plugin]));
  const metaById = new Map(input.installedPlugins.map((item) => [item.id, item]));
  const marketplaceIds = new Set(input.marketplaces.map((item) => item.id));
  const items = new Map<string, StorePluginItem>();

  for (const summary of input.availablePlugins) {
    const info = infoById.get(summary.id);
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed:
        info?.packageStatus === "missing" ? false : summary.installed || info !== undefined,
      restorable: false,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
      ...(info ? { info } : {}),
      ...(metaById.get(summary.id) ? { installedMeta: metaById.get(summary.id) } : {}),
    });
  }
  for (const summary of input.restorableBuiltins) {
    const existing = items.get(summary.id);
    if (existing) {
      // 内置卸载态同时存在于完整 Catalog 和 restorable 列表：只有没有实际
      // Marketplace ownership 时才覆盖为 restorable。若 installed/installedMeta/info
      // 已表明同名 CDN 插件归用户所有，必须保留 installed，避免详情页误显示 Restore。
      const hasMarketplaceOwnership =
        existing.installed || existing.installedMeta !== undefined || existing.info !== undefined;
      if (hasMarketplaceOwnership) continue;
      items.set(summary.id, {
        ...existing,
        installed: false,
        restorable: true,
        ...(existing.listing || summary.listing
          ? { listing: existing.listing ?? summary.listing }
          : {}),
        ...(existing.summary ? {} : { summary }),
      });
      continue;
    }
    items.set(summary.id, {
      id: summary.id,
      name: summary.name,
      marketplace: summary.marketplace,
      installed: false,
      restorable: true,
      orphaned: false,
      ...(summary.listing ? { listing: summary.listing } : {}),
      summary,
    });
  }
  // 运行时发现、但不在任何目录里的插件（inline、被移除市场的遗留安装）也要可见/可搜索。
  for (const info of input.plugins) {
    if (items.has(info.id)) continue;
    // 旧插件拆分/下架后，配置仍会生成缺包诊断；它不是可安装目录来源。
    // 保留原 plugins 给设置页诊断，但不凭此生成商店安装入口；有目录/恢复来源的条目已在上面保留。
    if (info.packageStatus === "missing") continue;
    items.set(info.id, {
      id: info.id,
      name: info.name,
      marketplace: info.marketplace,
      installed: true,
      restorable: false,
      // 目录条目缺失不等于 Marketplace Source 已删除，overview 失败时来源状态也未知。
      // official/inline 插件不能由目录缺失推导成孤立安装。
      orphaned:
        input.marketplaceAvailabilityKnown &&
        info.source === "cache" &&
        !marketplaceIds.has(info.marketplace),
      info,
      ...(metaById.get(info.id) ? { installedMeta: metaById.get(info.id) } : {}),
    });
  }
  return [...items.values()];
}

/** 公开分段：Featured（CDN featured 名单按序）+ 分类聚合（无分类归 other，排最后）。 */
// byName 只保留首个同名条目，Featured 名单按名字命中，重名时以先入者为准。
// seen 按 item.id 去重，同一插件出现在多个公开源的 featured 里也只保留一次。
export function selectFeaturedItems(
  publicItems: StorePluginItem[],
  marketplaces: ZCodePluginMarketplaceSummary[],
): StorePluginItem[] {
  const byName = new Map<string, StorePluginItem>();
  for (const item of publicItems) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const featured: StorePluginItem[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!isPublicStoreMarketplaceId(marketplace.id)) continue;
    for (const name of marketplace.featured ?? []) {
      const item = byName.get(name);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        featured.push(item);
      }
    }
  }
  return featured;
}

// 先经 sortPluginStoreEntries 排序再落桶，保证分类内顺序与商店整体一致。
// 分类回退链为 resolveStoreCategory 再到 FALLBACK_CATEGORY，未分类条目必须归入 other 并靠后。
export function groupItemsByCategory(
  items: StorePluginItem[],
  locale: string,
  order?: PluginStoreModeOrder,
): StoreCategoryGroup[] {
  const groups = new Map<string, StorePluginItem[]>();
  const sorted = sortPluginStoreEntries(
    items,
    (item) => ({
      id: item.id,
      category: item.listing?.category,
      displayName: resolveItemDisplayName(item, locale),
    }),
    locale,
    order,
  );
  for (const item of sorted) {
    const category = resolveStoreCategory(item.listing?.category) ?? FALLBACK_CATEGORY;
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

// 搜索主体含名称、id、市场、本地化名与描述、分类与作者，字段缺失只会降低召回，不会误报。
// 高亮候选单独传名字与 displayNameI18n，与搜索主体错位会导致命中位置高亮不到。
export function storeItemMatches(item: StorePluginItem, keyword: string, locale: string): boolean {
  return pluginSearchMatches(
    keyword,
    [
      item.name,
      item.id,
      item.marketplace,
      resolveItemDisplayName(item, locale),
      resolveItemDescription(item, locale) ?? "",
      item.listing?.category ?? "",
      item.listing?.author ?? "",
    ],
    [item.name, item.listing?.displayName, ...Object.values(item.listing?.displayNameI18n ?? {})],
  );
}

/**
 * 已安装图标条排序：官方文档插件优先，其余内置/inline 按名称稳定排序；
 * 市场安装插件随后按安装时间倒序，同一时间再按名称排序。
 */
// 首关键字是 compareDocumentPluginPriority，文档插件必须稳定前置，否则图标条首屏顺序抖动。
// 内置与 inline 以 info 的 source 是否为 cache 区分，非 cache 视为内置并按显示名排序。
// 市场安装插件按 installedMeta 的 installedAt 倒序，缺失时间用空串沉底后再按显示名兜底。
export function sortInstalledStripItems(
  items: StorePluginItem[],
  locale: string,
): StorePluginItem[] {
  return items.toSorted((left, right) => {
    const documentPriority = compareDocumentPluginPriority(left.id, right.id);
    if (documentPriority !== 0) return documentPriority;

    const leftIsBuiltin = Boolean(left.info && left.info.source !== "cache");
    const rightIsBuiltin = Boolean(right.info && right.info.source !== "cache");
    if (leftIsBuiltin !== rightIsBuiltin) return leftIsBuiltin ? -1 : 1;

    const compareByName = () =>
      resolveItemDisplayName(left, locale).localeCompare(
        resolveItemDisplayName(right, locale),
        locale,
      );
    if (leftIsBuiltin) return compareByName();

    const leftAt = left.installedMeta?.installedAt ?? "";
    const rightAt = right.installedMeta?.installedAt ?? "";
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt);
    return compareByName();
  });
}
