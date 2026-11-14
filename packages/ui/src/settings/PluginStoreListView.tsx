// PluginStoreListView —— 插件商店的浏览投影层：把来源分段、搜索、UI 插件推荐、精选、
// 分类分组与个人市场分组收敛成一个可折叠的列表界面。它不安装、不卸载、不校验插件能力，
// 也不直接访问服务，所有动作通过 actions 与父级回调向上委托。
//
// 职责边界
// 做：基于 items / marketplaces / order 计算各处展示投影，维护展开态并派生搜索结果。
// 不做：网络请求、store 写入、安装状态变更、插件权限判断与文案词条定义。
// 依赖：@zcode/shared 的商店类型、pluginStoreListing 的纯函数、PluginStoreCard 的动作接口。
// 被谁用：插件商店设置页，既有整页挂载也有侧栏「查看全部」的嵌入式挂载。
// 边界：props 视为不可变输入；需要持久化的状态必须留在上层，本文件只在内存里记展开态。
//
// INV 不变量（每一条都是浏览面与插件管理页事实一致的底线，改动前先确认不触碰）
// INV-01 退役条目只从商店浏览投影剔除、插件管理与已安装列表仍可见：该条目只影响商店 —— 守住它的位置：items 的 useMemo 与 RETIRED_STORE_PLUGIN_ID 的精确比较 —— 改错故障：已安装用户会以为插件消失，管理页也找不到卸载入口。
// INV-02 UI 插件与公共插件是严格互补集合，二者并集等于 segmentItems —— 守住它的位置：publicItems 的 !isUiPluginItem 过滤 —— 改错故障：同一条目同时出现在 UI 区和分类栏，或两边都不出现。
// INV-03 来源分段只由 resolvePluginStoreSegment 判定，本文件不按字段自行推断 —— 守住它的位置：segmentItems 的 useMemo —— 改错故障：切到「公开」时个人市场条目漏进列表，搜索结果跨段。
// INV-04 空搜索词必须返回空数组，是否进入搜索分支由 keyword 决定 —— 守住它的位置：searchResults 首行的提前返回 —— 改错故障：搜索框为空却渲染「搜索结果」分区，条目被重复展示两次。
// INV-05 搜索范围是 segmentItems 而不是全量 items —— 守住它的位置：searchResults 的过滤输入 —— 改错故障：在个人分段里搜索会命中公开市场插件，点击后跳到不存在的来源。
// INV-06 展开态缺省语义是「展开」，所有读取点必须用空值合并取 true —— 守住它的位置：expandedGroups 在 UI 区、分类、市场三处的读取 —— 改错故障：首次进入分组全部收起，用户误以为分类为空。
// INV-07 折叠映射的 key 必须带类型前缀，三类分组共用一张表 —— 守住它的位置：toggleGroup 调用方传入的 groupKey —— 改错故障：同名市场与分类互相覆盖展开态，折叠一个分组会连带另一个。
// INV-08 收起时 hidden 与 visible 必须互补且能拼回 items —— 守住它的位置：CollapsibleCardGroup 里的两次 slice —— 改错故障：部分插件既不展示也不计入「还有 N 个」，用户永远看不到它们。
// INV-09 收起阈值 CATEGORY_VISIBLE_LIMIT 与「查看更多」文案的剩余数同源 —— 守住它的位置：模块级常量及其在 slice 与文案中的两处使用 —— 改错故障：按钮提示的数字与实际展开后新增的条目数不一致。
// INV-10 办公模式与代码模式的市场顺序不得互相回退 —— 守住它的位置：modeOrder 的三元表达式 —— 改错故障：办公模式套用代码排序，分类顺序与另一模式串味。
// INV-11 未知分类必须原样展示远端字符串，不能拼造词条 id —— 守住它的位置：resolveCategoryLabel 的 labelId 判断 —— 改错故障：intl 抛缺失词条异常，整个分类区白屏。
// INV-12 分组与排序结果只读，渲染期不得就地排序或追加 —— 守住它的位置：categoryGroups 与 personalGroups 的 memo 结果及其消费点 —— 改错故障：memo 缓存被改写，重复渲染时顺序随机漂移。
// INV-13 精选只从公开插件中挑选，且必须依赖 marketplaces —— 守住它的位置：featuredItems 的依赖数组 —— 改错故障：市场刷新后精选仍是旧的，已下架插件继续出现在首屏。
// INV-14 个人市场分组不得改写 Map 里累积的数组 —— 守住它的位置：personalGroups 内组内排序的 toSorted —— 改错故障：同一市场的条目顺序在多次渲染间跳变。
// INV-15 推荐数据只参与 UI 区排序，绝不作为存在性或可安装性的判据 —— 守住它的位置：uiItems 的 filter 与 sort 组合 —— 改错故障：未进入推荐的插件被隐藏，与新标签页推荐语义冲突。
// INV-16 未推荐条目共享同一序号并保持输入顺序 —— 守住它的位置：ranks.size 作为排序哨兵 —— 改错故障：每次渲染 UI 插件区顺序抖动，卡片图标重复闪烁。
// INV-17 渲染优先级固定为「搜索 > 分段」，搜索态不渲染精选与分类 —— 守住它的位置：组件返回值的三元分支顺序 —— 改错故障：有搜索词时下方仍渲染全部分类，用户以为搜索没生效。
// INV-18 分段按钮必须受控并暴露 aria-pressed —— 守住它的位置：SegmentPill 的 active 与 onClick 两个入参 —— 改错故障：按钮视觉选中但列表未切换，读屏也无法得知当前分段。
// INV-19 空态必须区分「加载中」与「确实没有内容」 —— 守住它的位置：PublicSegment 的 isEmpty 分支与 loading 判断 —— 改错故障：目录还在加载时提示「暂无插件」，用户提前放弃。
// INV-20 卡片列表的 key 使用条目 id，网格布局不参与排序 —— 守住它的位置：CardGrid 的 map 与 PluginStoreCard 的 key —— 改错故障：排序变化时卡片被整体重建，图标与滚动位置丢失。
//
// 看起来可以顺手优化、其实不能动的三处：
// 1) 推荐排序里的 ranks.size 哨兵，换成无穷大会让未推荐项之间的相对顺序不再受控。
// 2) 折叠读写的空值合并默认展开，改成默认收起会让首次进入把所有分组都收起来。
// 3) 退役条目的完整三段式 ID 判定，换成前缀匹配会误伤同前缀的新插件。
// 校验入口：pluginStoreListing 的纯函数单测，以及商店页分段切换、搜索空态两条端到端用例。
import { useUiPluginRecommendations } from "@/plugin-ui/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
/* eslint-disable max-lines -- 商店列表页把搜索/公开-社区-个人分段/Featured/分类折叠聚合成一个连贯浏览面，拆散反而难以维持 1:1 布局。 */
import { useMemo, useState } from "react";
import type { PluginStoreOrder, ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PluginStoreCard, type PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  FALLBACK_CATEGORY,
  KNOWN_CATEGORY_LABEL_IDS,
  groupItemsByCategory,
  resolvePluginStoreSegment,
  isUiPluginItem,
  resolveItemDisplayName,
  selectFeaturedItems,
  sortPersonalMarketplaceGroups,
  storeItemMatches,
  type PersonalMarketplaceGroup,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { resolveMarketplaceDisplayName } from "@/settings/pluginSourceLabel.js";

// 分类/市场分组手动收起后的展示数量；默认完整展示，避免较少的插件又被自动隐藏。
const CATEGORY_VISIBLE_LIMIT = 6;
// [契约] retired 条目只从商店投影剔除，插件管理页仍按原始条目管理已安装 instance。
// [契约] 这里用「插件 ID + 官方市场 ID」的完整三段式，避免同名插件在第三方市场被误伤。
// [契约] 判定必须保持精确相等而不是前缀或模糊匹配，否则同前缀的新插件会整类从商店消失。
// [权衡] 常量留在模块作用域而不是搬进组件，是为了让上面的筛选 memo 依赖保持单一来源。
const RETIRED_STORE_PLUGIN_ID = `restore-legacy-sessions@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;

// [契约] 分段类型是转发导出，真正的枚举定义在 pluginStoreListing，本文件不复制一份。
// [契约] 紧邻其后的类型导入是同一个符号的本地绑定，两行必须同时存在，缺任一行下方 props 就失去类型。
// [失败路径] 若要改成引入后直接使用，务必保留对外转发，否则设置页其他入口的类型引用会断链。
export type { PluginStoreSegment } from "@/settings/pluginStoreListing.js";
import type { PluginStoreSegment } from "@/settings/pluginStoreListing.js";

export function PluginStoreListView({
  items: allItems,
  order,
  marketplaces,
  actions,
  loading,
  query,
  onQueryChange,
  onSearchSubmit,
  segment,
  onSegmentChange,
}: {
  items: StorePluginItem[];
  order?: PluginStoreOrder | null;
  marketplaces: ZCodePluginMarketplaceSummary[];
  actions: PluginStoreActions;
  loading: boolean;
  query: string;
  onSearchSubmit?: () => void;
  onQueryChange: (query: string) => void;
  segment: PluginStoreSegment;
  onSegmentChange: (segment: PluginStoreSegment) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  // [契约] 排序权重按当前界面模式二选一：办公模式读 work，代码模式读 code。
  // [契约] order 允许为空，此时两个分支都得到空值，下游分组函数必须按无权重处理。
  // [权衡] 不要用空值合并把两种顺序串成一条回退链，它们语义不同，混用会把办公排序漏进代码模式。
  // [契约] 模式来自界面模式 hook，切换模式会重算下方 memo，因此不要把它缓存成 ref。
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  // [契约] 搜索词统一去空白再小写后才参与匹配，大小写与首尾空格不能改变结果条数。
  // [契约] 只有空串才算「无搜索」；仅输入空格也视为无搜索，避免整页突然变空。
  // [权衡] 这里不做防抖，输入框受控于父级，防抖责任留在上层，本组件只保证过滤是纯计算。
  const keyword = query.trim().toLowerCase();
  // [状态] 展开态只属于当前视图，不写 store、不持久化，刷新后回到默认全部展开。
  // [契约] 映射里缺失的 key 语义是「展开」，所以读取方一律用空值合并取 true，不能把缺失当成收起。
  // [契约] key 带前缀（UI 区、分类、市场），三类分组共用一张表也不会互相覆盖。
  // [权衡] 用一次对象展开生成新表，保证 React 看到新引用；就地改旧对象会让折叠点击完全不生效。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // 旧版会话恢复入口退出市场；统一过滤所有浏览投影，旧缓存/精选也不能重新露出。
  // 完整 ID 只命中官方插件，插件管理页继续使用原始条目管理已有安装。
  const items = useMemo(
    () => allItems.filter((item) => item.id !== RETIRED_STORE_PLUGIN_ID),
    [allItems],
  );

  // [契约] 来源分段是浏览面的第一层过滤，推荐、精选、分类、个人市场都基于它而不是全量条目。
  // [契约] 判定函数是唯一口径，本文件不再按字段自己猜来源。
  // [契约] 依赖只有条目与分段：市场摘要或推荐数据变化不应改变分段成员。
  // [失败路径] 若某处直接用全量条目渲染，切到「公开」时会把个人市场条目漏出来，搜索结果也会跨段。
  // [权衡] 过滤放在最前面而不是每个子组件内部，保证「搜索命中数」与「分段内条目」永远是同一集合。
  const segmentItems = useMemo(
    () => items.filter((item) => resolvePluginStoreSegment(item) === segment),
    [items, segment],
  );
  // [并发] 这个 hook 订阅推荐配置，入参 true 表示启用；返回最近一次成功投影，不在这里发请求。
  // [契约] 推荐只在 UI 插件区用于排序，不参与条目是否存在、是否可安装的判断。
  // [权衡] 推荐数据可能晚于目录到达；排序必须能在推荐为空时退化成原顺序，而不是把整个 UI 区清空。
  // [失败路径] 若把推荐当成白名单过滤，未推荐插件会被隐藏，与新标签页推荐语义冲突。
  const { recommendations } = useUiPluginRecommendations(true);
  // [权衡] UI 插件按推荐顺序排，未出现在推荐里的统一排在推荐集合之后。
  // [契约] ranks.size 是动态哨兵：所有未推荐项共享同一个序号，稳定排序会保留它们在输入中的相对顺序。
  // [契约] 用当前表长而不是无穷大做哨兵，推荐项数量变化时未推荐项之间仍然可比较。
  // [契约] 去重只在建表时做，重复的插件 id 不会把后面的条目挤走。
  // [契约] 只保留 UI 插件判定为真的条目，UI 插件与公共插件是互补集合。
  // [失败路径] 若排序前丢掉分段内顺序，未推荐项的展示次序会在每次渲染之间抖动。
  // [权衡] 依赖是分段结果与推荐两个投影，原始条目变化已被分段结果吸收。
  const uiItems = useMemo(() => {
    // 市场目录顺序与新标签页推荐顺序不同；复用推荐配置，未推荐项稳定排到末尾。
    const ranks = new Map<string, number>();
    for (const { pluginId } of recommendations) {
      if (!ranks.has(pluginId)) ranks.set(pluginId, ranks.size);
    }
    return segmentItems
      .filter(isUiPluginItem)
      .sort(
        (left, right) => (ranks.get(left.id) ?? ranks.size) - (ranks.get(right.id) ?? ranks.size),
      );
  }, [segmentItems, recommendations]);
  // [契约] 公共插件等于分段内非 UI 插件，与 UI 区严格互补，并集就是分段结果。
  // [契约] 判定继续复用同一个 UI 插件函数，不允许出现第二套「是否 UI 插件」的规则。
  // [契约] 精选与分类都从这里派生，所以 UI 插件既不会进精选也不会进分类栏。
  // [失败路径] 若改成按 id 黑白名单过滤，两套规则会漂移，同一条目可能同时出现在两个区域。
  const publicItems = useMemo(
    () => segmentItems.filter((item) => !isUiPluginItem(item)),
    [segmentItems],
  );
  // [权衡] 个人分段复用公共集合作别名，不额外过滤：来源分段已经决定了成员。
  // [契约] 这个别名只用于可读性，不应在此处引入新的筛选条件。
  // [失败路径] 若给别名加上额外过滤，个人分段会漏掉本该展示的市场条目，且与搜索集合不一致。
  const personalItems = publicItems;
  // [契约] 分类标题只把已知分类映射到词条 id，未知分类原样返回远端字符串。
  // [契约] 依赖 intl：语言切换后必须重新生成解析函数，否则标题停留在旧语言。
  // [权衡] 返回函数而不是映射表，让调用点保持一次调用的简单形态，也便于向下透传。
  // [失败路径] 若把未知分类也拼成词条 id，intl 会抛缺失词条错误，整个分类区无法渲染。
  const resolveCategoryLabel = useMemo(() => {
    return (category: string): string => {
      const labelId = KNOWN_CATEGORY_LABEL_IDS[category];
      return labelId ? intl.formatMessage({ id: labelId }) : category;
    };
  }, [intl]);

  // [契约] 精选条目只能从公开插件里挑，且需要市场摘要提供来源信息。
  // [契约] 选择规则集中在选择函数里，本文件不重复实现「哪些算精选」。
  // [契约] 依赖市场摘要是必要的：市场刷新会改变精选可用性，不能只依赖公开插件。
  // [失败路径] 精选为空是合法状态，渲染层必须整段略过而不是留下空标题。
  // [权衡] 这里不按模式权重排序，精选顺序由选择函数决定，避免与分类顺序互相干扰。
  const featuredItems = useMemo(
    () => selectFeaturedItems(publicItems, marketplaces),
    [marketplaces, publicItems],
  );
  // [契约] 分组按 locale 比较名称、按 mode 权重排组内次序。
  // [契约] 分组只在公开插件上进行，UI 插件区是独立分区，不参与分类。
  // [契约] 分组结果是只读投影，渲染层不得就地排序数组，否则会改到 memo 缓存。
  // [失败路径] 若漏掉模式依赖，切换办公与代码模式后分类顺序不更新，看起来像排序失效。
  const categoryGroups = useMemo(
    () => groupItemsByCategory(publicItems, locale, modeOrder),
    [locale, publicItems, modeOrder],
  );

  // 个人分段：按市场分组，最近刷新的市场排最前（见 sortPersonalMarketplaceGroups）。
  // [契约] 个人分段按市场字段分组，组标题由市场摘要或回退名解析，缺失时也必须有可读标题。
  // [契约] 组内条目用本地化比较器排序，避免直接改写 Map 里累积的数组。
  // [契约] 市场之间由排序函数决定次序（最近刷新优先），本文件不自己写比较逻辑。
  // [契约] 遍历使用输入顺序，保证同一市场内的相对顺序可预测。
  // [失败路径] 若原地排序 Map 缓存的数组，下次分组访问会看到被改写过的顺序。
  // [权衡] fallback title 只取一次而非每次解析名字都取，减少 formatMessage 调用。
  // [契约] 依赖语言、市场摘要、个人条目三项齐全，缺任一项都会让标题或顺序陈旧。
  const personalGroups = useMemo(() => {
    const claudeCodePlugins = intl.formatMessage({
      id: "settings.plugins.marketplace.claudeCodePlugins",
    });
    // [契约] 分组键就是条目自身的市场字段，不做归一化，避免把两个市场错误合并。
    // [契约] 用取不到再建空数组的方式累积，保证首次出现即建组，且不改动其他组的结构。
    // [失败路径] 若键做了去空白而标题解析仍用原值，会出现两个组标题相同但条目被拆开。
    // [权衡] 分组是单趟线性遍历，条目规模只有几十级，不需要额外索引。
    const groups = new Map<string, StorePluginItem[]>();
    for (const item of personalItems) {
      const group = groups.get(item.marketplace) ?? [];
      group.push(item);
      groups.set(item.marketplace, group);
    }
    const titled: PersonalMarketplaceGroup[] = [...groups.entries()].map(
      ([marketplace, groupItems]) => ({
        marketplace,
        title: resolveMarketplaceDisplayName(marketplace, marketplaces, claudeCodePlugins),
        items: groupItems.toSorted((left, right) =>
          resolveItemDisplayName(left, locale).localeCompare(
            resolveItemDisplayName(right, locale),
            locale,
          ),
        ),
      }),
    );
    return sortPersonalMarketplaceGroups(titled, marketplaces, locale);
  }, [intl, locale, marketplaces, personalItems]);

  // [契约] 空关键词必须返回空数组而不是全部条目，渲染层用关键词判断是否走搜索分支。
  // [契约] 搜索范围是分段结果，切换分段后不会搜到别的来源。
  // [契约] 匹配规则覆盖名称、描述、市场等字段，本文件不再补充字段。
  // [契约] 结果按本地化显示名升序，保证同一关键词多次搜索的顺序一致。
  // [失败路径] 若把空词判断放在渲染层而这里仍返回全量，搜索空态与结果计数会同时出错。
  const searchResults = useMemo(() => {
    if (!keyword) return [];
    return segmentItems
      .filter((item) => storeItemMatches(item, keyword, locale))
      .toSorted((left, right) =>
        resolveItemDisplayName(left, locale).localeCompare(
          resolveItemDisplayName(right, locale),
          locale,
        ),
      );
  }, [segmentItems, keyword, locale]);

  // [状态] 折叠是幂等切换：读取当前值（缺省展开）后取反，再写回一张新表。
  // [契约] 使用函数式更新，连续快速点击不会读到过期快照。
  // [契约] 只写当前 key，其他分组的展开态必须原样保留，否则一次点击会连带展开或收起全部。
  // [失败路径] 若在事件里读取渲染闭包中的旧表再构造新表，快速连点会丢一次切换。
  // [权衡] toggleGroup 不包 useCallback：只下传给子树，重建成本可忽略。
  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  };

  // [契约] 渲染优先级固定为「搜索优先于分段」：有搜索词时只看搜索结果，不再渲染精选与分类。
  // [契约] 搜索分支无 loading 态，因为它是对已加载投影的本地 filter。
  // [失败路径] 若把搜索分支挪到分段判断之后，个人分段会无视搜索词展示全部条目。
  // [契约] 顶部工具栏始终渲染，分段切换与搜索框不随结果为空而消失，用户始终有退出空态的入口。
  return (
    <div className="space-y-6" data-testid="plugin-store-list">
      {/* 对齐原型：来源分段在左、搜索右对齐同一行；搜索及专区均限定当前来源。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <SegmentPill
            active={segment === "public"}
            testId="plugin-store-segment-public"
            label={intl.formatMessage({
              id: "settings.plugins.store.segment.public",
            })}
            onClick={() => onSegmentChange("public")}
          />
          <SegmentPill
            active={segment === "community"}
            testId="plugin-store-segment-community"
            label={intl.formatMessage({ id: "settings.plugins.store.segment.community" })}
            onClick={() => onSegmentChange("community")}
          />
          <SegmentPill
            active={segment === "personal"}
            testId="plugin-store-segment-personal"
            label={intl.formatMessage({
              id: "settings.plugins.store.segment.personal",
            })}
            onClick={() => onSegmentChange("personal")}
          />
        </div>
        <SettingsSearchInput
          data-testid="plugin-store-search"
          containerClassName="ml-auto min-w-0 flex-[1_1_14rem] sm:max-w-xs"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) onSearchSubmit?.();
          }}
          placeholder={intl.formatMessage({ id: "settings.plugins.store.searchPlaceholder" })}
        />
      </div>

      {!keyword && uiItems.length > 0 ? (
        <section data-testid="plugin-store-ui-section">
          <div className="pb-2">
            <h2 className="text-ui-lg font-semibold">
              {intl.formatMessage({ id: "settings.plugins.store.ui.title" })}
            </h2>
          </div>
          <div aria-hidden="true" className="h-px bg-surface" />
          <div className="mt-2">
            {/* 独立“查看全部”页让返回入口难以识别；复用分组展开并按来源保留选择。 */}
            <CollapsibleCardGroup
              groupKey={`ui:${segment}`}
              items={uiItems}
              expanded={expandedGroups[`ui:${segment}`] ?? true}
              onToggle={toggleGroup}
              actions={actions}
              locale={locale}
            />
          </div>
        </section>
      ) : null}

      {keyword ? (
        <StoreSection
          key="search"
          title={intl.formatMessage(
            { id: "settings.plugins.store.searchResults" },
            { count: String(searchResults.length) },
          )}
        >
          {searchResults.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.plugins.store.searchEmpty" })}
            </p>
          ) : (
            <CardGrid items={searchResults} actions={actions} locale={locale} />
          )}
        </StoreSection>
      ) : segment !== "personal" ? (
        <>
          {segment === "community" && segmentItems.length === 0 && !loading ? (
            <p
              data-testid="plugin-store-community-empty"
              className="py-8 text-center text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({ id: "settings.plugins.store.communityEmpty" })}
            </p>
          ) : null}
          {loading ||
          categoryGroups.length > 0 ||
          featuredItems.length > 0 ||
          (segment === "public" && uiItems.length === 0) ? (
            <PublicSegment
              actions={actions}
              categoryGroups={categoryGroups}
              expandedGroups={expandedGroups}
              featuredItems={featuredItems}
              loading={loading}
              locale={locale}
              resolveCategoryLabel={resolveCategoryLabel}
              onToggleGroup={toggleGroup}
            />
          ) : null}
        </>
      ) : (
        <PersonalSegment
          actions={actions}
          expandedGroups={expandedGroups}
          groups={personalGroups}
          locale={locale}
          onToggleGroup={toggleGroup}
        />
      )}
    </div>
  );
}

// [契约] 分段按钮用 aria-pressed 表达选中态，样式变化与可访问状态必须同源。
// [契约] 显式声明按钮类型，避免嵌在表单里时被当作提交按钮。
// [权衡] 只做受控展示，选中值与点击回调都由父级决定，组件本身不持有当前分段。
// [失败路径] 若在这里自己存状态，工具栏与列表会各存一份分段，出现按钮亮着但列表未切换。
export function SegmentPill({
  active,
  label,
  onClick,
  testId,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        active
          ? "bg-selected text-foreground"
          : "text-foreground-subtle hover:bg-hover hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// [契约] 分区标题、分隔线、内容三段结构由本组件统一，避免每个分区各写一套留白。
// [权衡] 类名透传用于首尾分区的内边距微调，默认保持空值以复用同一间距。
// [契约] 分隔线是装饰元素，必须对辅助技术隐藏，读屏不应读出多余分隔。
function StoreSection({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div aria-hidden="true" className="h-px bg-surface" />
      <div className="mt-2">{children}</div>
    </section>
  );
}

// [契约] 卡片网格只负责布局，条目的可操作行为全部来自传入的动作集合。
// [契约] 用条目 id 作 key，顺序变化时 React 复用卡片而不是重建，避免图标重复加载。
// [权衡] 两列断点用 container query，窄侧栏里也能落成单列。
function CardGrid({
  items,
  actions,
  locale,
}: {
  items: StorePluginItem[];
  actions: PluginStoreActions;
  locale: string;
}) {
  return (
    <div className="grid gap-x-6 gap-y-1 @min-[40rem]/plugin-store:grid-cols-2">
      {items.map((item) => (
        <PluginStoreCard key={item.id} item={item} actions={actions} locale={locale} />
      ))}
    </div>
  );
}

/** 分类/市场分组：默认全部展开，手动收起后展示前 6 个和展开入口。 */
function CollapsibleCardGroup({
  groupKey,
  items,
  expanded,
  onToggle,
  actions,
  locale,
}: {
  groupKey: string;
  items: StorePluginItem[];
  expanded: boolean;
  onToggle: (key: string) => void;
  actions: PluginStoreActions;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  // [契约] 展开时展示全部，收起时只展示前若干个，数量由模块常量决定。
  // [契约] 该常量是展示约定，改动会影响「查看更多」文案里的剩余数量，需要同步产品口径。
  // [契约] 切片不修改原数组，条目仍是 memo 结果，渲染期不产生副作用。
  // [契约] 隐藏集与可见集互补，二者拼接必须等于输入条目，不能出现条目既展示又被计入隐藏。
  // [失败路径] 若收起时用过滤而不是切片，顺序会被比较器打乱，用户看到的「前几个」不稳定。
  // [权衡] 默认展开意味着首次进入不做截断，分类条目较少时不会被无谓隐藏。
  // [契约] 这里的默认值与展开态读取的默认值必须一致，任一处改成默认收起都会让两套语义打架。
  const visible = expanded ? items : items.slice(0, CATEGORY_VISIBLE_LIMIT);
  const hidden = expanded ? [] : items.slice(CATEGORY_VISIBLE_LIMIT);
  // [契约] 「查看更多」文案只点名前 2 个隐藏条目，剩余数量用总数减去点名数。
  // [契约] 点名使用本地化显示名，回退规则与卡片标题一致，避免同一插件两种叫法。
  // [权衡] 只点名 2 个是文案长度限制：更多名字会让按钮在窄容器里换行。
  // [契约] 隐藏数不多于点名上限时走「少量」文案分支，不再拼剩余数量。
  // [失败路径] 若直接用隐藏总数当剩余数，被点名的条目会被重复计数，提示数字偏大。
  // [契约] 头像只取前 3 个，与文案点名数解耦，二者各自有上限。
  const hiddenNames = hidden.slice(0, 2).map((item) => resolveItemDisplayName(item, locale));
  return (
    <div>
      <CardGrid items={visible} actions={actions} locale={locale} />
      {hidden.length > 0 ? (
        <button
          type="button"
          data-testid="plugin-store-group-toggle"
          data-group-key={groupKey}
          className="mt-2 flex w-full min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={() => onToggle(groupKey)}
        >
          <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
            {hidden.slice(0, 3).map((item) => (
              <PluginStoreAvatar
                key={item.id}
                item={item}
                className="size-5 rounded-md"
                iconClassName="size-2.5"
              />
            ))}
          </span>
          <span className="min-w-0 truncate">
            {hidden.length > hiddenNames.length
              ? intl.formatMessage(
                  { id: "settings.plugins.store.viewMore" },
                  {
                    names: hiddenNames.join(intl.formatMessage({ id: "common.listSeparator" })),
                    count: String(hidden.length - hiddenNames.length),
                  },
                )
              : intl.formatMessage(
                  { id: "settings.plugins.store.viewMoreFew" },
                  {
                    names: hiddenNames.join(intl.formatMessage({ id: "common.listSeparator" })),
                  },
                )}
          </span>
        </button>
      ) : expanded && items.length > CATEGORY_VISIBLE_LIMIT ? (
        <button
          type="button"
          data-testid="plugin-store-group-toggle"
          data-group-key={groupKey}
          className="mt-2 rounded-xl px-2 py-2 text-ui-base text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onClick={() => onToggle(groupKey)}
        >
          {intl.formatMessage({ id: "settings.plugins.store.showLess" })}
        </button>
      ) : null}
    </div>
  );
}

function PublicSegment({
  actions,
  categoryGroups,
  expandedGroups,
  featuredItems,
  loading,
  locale,
  resolveCategoryLabel,
  onToggleGroup,
}: {
  actions: PluginStoreActions;
  categoryGroups: ReturnType<typeof groupItemsByCategory>;
  expandedGroups: Record<string, boolean>;
  featuredItems: StorePluginItem[];
  loading: boolean;
  locale: string;
  resolveCategoryLabel: (category: string) => string;
  onToggleGroup: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // [失败路径] 精选与分类都为空才算「无内容」；任一有内容就继续渲染分区。
  // [契约] 空态文案区分加载中与确实无数据两种，加载态不能用「暂无插件」误导用户。
  // [契约] 提前返回发生在所有 hook 调用之后，不存在条件调用 hook 的问题。
  // [权衡] isEmpty 空态用虚线提示块而非整页插画，与搜索空态同一视觉语言。
  const isEmpty = featuredItems.length === 0 && categoryGroups.length === 0;
  if (isEmpty) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
        {loading
          ? intl.formatMessage({
              id: "settings.plugins.marketplace.catalogLoading",
            })
          : intl.formatMessage({
              id: "settings.plugins.marketplacePlugins.empty",
            })}
      </p>
    );
  }
  return (
    <div>
      {featuredItems.length > 0 ? (
        <StoreSection
          title={intl.formatMessage({ id: "settings.plugins.store.featured" })}
          className="py-4 first:pt-0 last:pb-0"
        >
          <CardGrid items={featuredItems} actions={actions} locale={locale} />
        </StoreSection>
      ) : null}
      {categoryGroups.map((group) => (
        <StoreSection
          key={group.category}
          className="py-4 first:pt-0 last:pb-0"
          title={
            group.category === FALLBACK_CATEGORY
              ? intl.formatMessage({
                  id: "settings.plugins.store.category.other",
                })
              : resolveCategoryLabel(group.category)
          }
        >
          <CollapsibleCardGroup
            groupKey={`category:${group.category}`}
            items={group.items}
            expanded={expandedGroups[`category:${group.category}`] ?? true}
            onToggle={onToggleGroup}
            actions={actions}
            locale={locale}
          />
        </StoreSection>
      ))}
    </div>
  );
}

function PersonalSegment({
  actions,
  expandedGroups,
  groups,
  locale,
  onToggleGroup,
}: {
  actions: PluginStoreActions;
  expandedGroups: Record<string, boolean>;
  groups: PersonalMarketplaceGroup[];
  locale: string;
  onToggleGroup: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // [失败路径] 个人市场一个都没有时给出专门文案，不能复用公共分段的空态。
  // [契约] 空判断基于分组结果而非原始条目，分组若过滤掉全部市场此处即为空。
  // [契约] 提前返回前没有新增 hook 调用，本组件每次渲染的 hook 数量始终为一。
  // [权衡] 个人分段不提供新建入口，市场由插件来源决定，这里只负责浏览。
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.store.personalEmpty" })}
      </p>
    );
  }
  return (
    <div>
      {groups.map((group) => (
        <StoreSection
          key={group.marketplace}
          title={group.title}
          className="py-4 first:pt-0 last:pb-0"
        >
          <CollapsibleCardGroup
            groupKey={`marketplace:${group.marketplace}`}
            items={group.items}
            expanded={expandedGroups[`marketplace:${group.marketplace}`] ?? true}
            onToggle={onToggleGroup}
            actions={actions}
            locale={locale}
          />
        </StoreSection>
      ))}
    </div>
  );
}
