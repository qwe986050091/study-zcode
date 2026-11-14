// INV-01 存储键是唯一持久化契约，改名等同清空所有用户偏好；守住位置：SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY 常量；改错故障：升级后侧栏分区全部回到展开，自定义顺序丢失。
// INV-02 分区 id 列表同时是类型来源、默认顺序和校验白名单，三处必须同源；守住位置：SIDEBAR_PURPOSE_SECTION_IDS；改错故障：新增分区被规范化静默丢弃，界面顺序与声明不一致。
// INV-03 读到的 JSON 一律视为不可信外部输入，每个字段都要逐个类型守卫；守住位置：readSidebarPurposeSectionPreferences 的字段三元分支；改错故障：存储被手工篡改后侧栏崩溃或出现非法类型。
// INV-04 解析失败、类型不符、存储不可用三种情况统一降级为默认值，不向上抛错；守住位置：read 的 try/catch 与三处提前返回；改错故障：旧版本或损坏数据让侧栏白屏。
// INV-05 未知 id、重复 id、长度不符的 sectionOrder 整体作废并回到默认顺序；守住位置：normalizeSectionOrder；改错故障：出现缺失分区或重复渲染两个同名分区。
// INV-06 来源分组覆盖只接受布尔值，其余键值静默忽略；守住位置：normalizeSourceGroupExpandedSections 的白名单遍历；改错故障：脏数据把布尔值写成字符串导致折叠状态永远为真。
// INV-07 规范化后为空的来源分组折叠为 undefined，不落空对象；守住位置：normalizeSourceGroupExpandedSections 末尾与 read 的条件展开；改错故障：存储堆积空对象，且有无覆盖的判定失真。
// INV-08 读取优先级固定为来源分组覆盖高于全局字段，缺省覆盖回落全局；守住位置：resolveSidebarPurposeSectionExpanded 与 getExpandedFallback；改错故障：某分组展开后又跳回旧值。
// INV-09 无变化的更新必须返回原对象引用，供上层做引用相等判断；守住位置：update 的两处提前返回；改错故障：每次点击都触发全量重渲染，侧栏列表抖动。
// INV-10 分组覆盖值等于全局值时删除该键，而不是写入同值；守住位置：updateSidebarPurposeSectionExpanded 的 delete 分支；改错故障：全局折叠切换后该分组仍被旧覆盖钉死。
// INV-11 更新分组覆盖时先复制再写，绝不修改入参对象；守住位置：nextSourceSections 与 sourceGroupExpandedSections 的两次展开；改错故障：上层认为状态未变而不重渲染，点击无响应。
// INV-12 分组覆盖清空后连同来源键一起删除，避免残留空分组；守住位置：update 的 Object.keys 判空分支；改错故障：反复切换分组后存储无限膨胀。
// INV-13 排序是纯函数，输入非法或目标相同都原样返回规范化后的顺序；守住位置：reorderSidebarPurposeSections 的早退分支；改错故障：拖到无效位置后分区顺序被打乱。
// INV-14 排序先移除再插入，插入下标基于移除后的数组；守住位置：两处 splice 调用；改错故障：向后拖拽时目标位置偏移一位。
// INV-15 写入前同样执行两次规范化，保证持久化内容永远合法；守住位置：persistSidebarPurposeSectionPreferences；改错故障：调用方传入脏状态污染存储，下次读取被判废。
// INV-16 写入失败（配额、隐私模式、受限 WebView）只吞异常，不阻断交互；守住位置：persist 的 try/catch；改错故障：一次写存储失败让折叠点击冒泡成未捕获异常。
// INV-17 存储访问统一经由 StorageLike 注入，默认参数才去取浏览器实现；守住位置：getBrowserStorage 与两个函数的默认参数；改错故障：单测或 SSR 环境直接触碰 window 报错。
// INV-18 序列化输出保持最小形状，可选字段为空时不写入；守住位置：persist 的对象字面量与条件展开；改错故障：存储被无意义字段撑大，跨版本比较出现噪声差异。
//
// 本文件是侧栏分区偏好唯一的读写与规范化层：常量收敛、非法数据降级、无变化不写、写入失败静默。
// 三条主线：ID 列表充当白名单与默认顺序，来源分组覆盖按需删除，读写两端各做一次规范化。
// 改动前先确认存储键与字段语义是否需要迁移，旧版本数据只做忽略不做猜测。
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SidebarPurposeSectionPreferences {
  projectsExpanded: boolean;
  conversationsExpanded: boolean;
  sectionOrder: SidebarPurposeSectionId[];
  sourceGroupExpandedSections?: Record<
    string,
    Partial<Record<SidebarPurposeSectionId, boolean>>
  >;
}

// 分区 id 的唯一来源：类型推导、默认顺序、校验白名单三处复用同一数组。
// 顺序即默认展示顺序，新增分区直接改变默认布局，不需要另改常量。
// [并发] 该数组为只读元组，任何调用方都应展开复制后再排序，不得原地修改。
export const SIDEBAR_PURPOSE_SECTION_IDS = ["projects", "conversations"] as const;

export type SidebarPurposeSectionId = (typeof SIDEBAR_PURPOSE_SECTION_IDS)[number];

// [契约] 存储键值是跨版本事实，改名等于清空所有已保存偏好，必须配合迁移或保留旧键读取。
// 键名带 zcode 前缀与功能域，便于在 localStorage 列表中一眼定位归属。
// [权衡] 只保存一份扁平 JSON，不做分键存储，换取原子读写与简单降级。
export const SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY =
  "zcode-sidebar-purpose-section-preferences";

// 默认值集中在这一个对象，读取与缺失字段回落都引用它，避免字面量散落。
// 两个全局分区默认展开，保证首次使用看不到空白侧栏。
// [权衡] sectionOrder 复制 ID 数组而非引用，防止后续排序改动污染默认值。
const DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES: SidebarPurposeSectionPreferences = {
  projectsExpanded: true,
  conversationsExpanded: true,
  sectionOrder: [...SIDEBAR_PURPOSE_SECTION_IDS],
};

// SSR 或非浏览器环境下 window 不存在，直接返回 null，调用方据此走默认值。
// [失败路径] 取 localStorage 属性本身在某些受限 WebView 或隐私模式会抛异常，故包一层 try。
// [资源] 该函数只做探测不缓存，每次读写都重新取，避免持有失效的存储引用。
function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// 返回全新对象，sectionOrder 单独复制，防止调用方修改默认常量。
// sourceGroupExpandedSections 不出现，表示没有任何来源分组覆盖。
function getDefaultPreferences(): SidebarPurposeSectionPreferences {
  return {
    ...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES,
    sectionOrder: [...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.sectionOrder],
  };
}

// 外部顺序不可信：长度、去重、成员合法性三道检查，任一不过整体回到默认。
// 返回值始终是新数组或规范化副本，调用方可安全排序。
// [权衡] 不做部分修复也不补缺失项，脏顺序一律丢弃，避免出现半合法布局。
function normalizeSectionOrder(value: unknown): SidebarPurposeSectionId[] {
  if (!Array.isArray(value) || value.length !== SIDEBAR_PURPOSE_SECTION_IDS.length) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  // 先用 Set 去掉重复，再比较大小与成员，能同时挡住重复 id 和未知 id。
  // 成员检查反向遍历白名单，保证每个合法分区都恰好出现一次。
  const sectionIds = new Set(value);
  if (
    sectionIds.size !== SIDEBAR_PURPOSE_SECTION_IDS.length ||
    SIDEBAR_PURPOSE_SECTION_IDS.some((sectionId) => !sectionIds.has(sectionId))
  ) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  return value as SidebarPurposeSectionId[];
}

// 来源分组覆盖是可选结构，任何一层形状不对就返回 undefined，等同于没有覆盖。
// 只保留布尔值，未知分区与非法值静默丢弃，不报错也不中断读取。
function normalizeSourceGroupExpandedSections(
  value: unknown,
): SidebarPurposeSectionPreferences["sourceGroupExpandedSections"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  // 用 fromEntries 重建对象，内层 flatMap 负责丢弃非法分组。
  // [权衡] 重建而非就地清洗，保证新对象与存储中的引用彻底脱钩。
  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([sourceGroupKey, sections]) => {
      if (
        !sourceGroupKey ||
        !sections ||
        typeof sections !== "object" ||
        Array.isArray(sections)
      ) {
        return [];
      }
      const sectionValue = sections as Record<string, unknown>;
      const normalizedSections = Object.fromEntries(
        SIDEBAR_PURPOSE_SECTION_IDS.flatMap((sectionId) =>
          typeof sectionValue[sectionId] === "boolean"
            ? [[sectionId, sectionValue[sectionId]]]
            : [],
        ),
      );
      return Object.keys(normalizedSections).length > 0
        ? [[sourceGroupKey, normalizedSections]]
        : [];
    }),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// 全局折叠状态的唯一读取点，projects 之外的 id 都落到 conversations 字段。
// [权衡] 分区只有两个，用三元而非映射表，新增分区时这里必须同步。
function getExpandedFallback(
  preferences: SidebarPurposeSectionPreferences,
  sectionId: SidebarPurposeSectionId,
): boolean {
  return sectionId === "projects"
    ? preferences.projectsExpanded
    : preferences.conversationsExpanded;
}

// 读取优先级：来源分组覆盖高于全局字段，这是唯一允许的覆盖方向。
// 无来源键时跳过覆盖层，直接读全局，避免空键误命中某条脏数据。
// [并发] 纯读不写，可在渲染期任意调用，不引入额外状态。
export function resolveSidebarPurposeSectionExpanded(
  preferences: SidebarPurposeSectionPreferences,
  sectionId: SidebarPurposeSectionId,
  sourceGroupKey?: string,
): boolean {
  if (sourceGroupKey) {
    const sourceValue =
      preferences.sourceGroupExpandedSections?.[sourceGroupKey]?.[sectionId];
    if (typeof sourceValue === "boolean") {
      return sourceValue;
    }
  }
  return getExpandedFallback(preferences, sectionId);
}

// 更新是纯函数，返回新对象或原引用，不触碰存储，持久化由调用方决定。
// 分两条路径：无来源键改全局字段，有来源键改分组覆盖。
export function updateSidebarPurposeSectionExpanded(
  preferences: SidebarPurposeSectionPreferences,
  update: {
    sectionId: SidebarPurposeSectionId;
    expanded: boolean;
    sourceGroupKey?: string;
  },
): SidebarPurposeSectionPreferences {
  const { sectionId, expanded, sourceGroupKey } = update;
  if (!sourceGroupKey) {
    const field =
      sectionId === "projects"
        ? "projectsExpanded"
        : "conversationsExpanded";
    // 值相同就返回原对象，引用相等让上层可以跳过重渲染与重复写存储。
    // 字段名由 sectionId 映射而来，新增分区时映射需与默认值同步扩展。
    return preferences[field] === expanded
      ? preferences
      : { ...preferences, [field]: expanded };
  }

  const fallback = getExpandedFallback(preferences, sectionId);
  const currentSourceSections =
    preferences.sourceGroupExpandedSections?.[sourceGroupKey];
  const currentExpanded = currentSourceSections?.[sectionId] ?? fallback;
  if (currentExpanded === expanded) {
    return preferences;
  }

  const nextSourceSections = { ...currentSourceSections };
  if (expanded === fallback) {
    // expanded === fallback 时删除该分组键，用缺省表达继承，而不是写入同值。
    // [权衡] 删除让全局后续切换继续影响该分组，写入同值会把它钉死。
    delete nextSourceSections[sectionId];
  } else {
    nextSourceSections[sectionId] = expanded;
  }

  const sourceGroupExpandedSections = {
    ...preferences.sourceGroupExpandedSections,
  };
  if (Object.keys(nextSourceSections).length === 0) {
    delete sourceGroupExpandedSections[sourceGroupKey];
  } else {
    sourceGroupExpandedSections[sourceGroupKey] = nextSourceSections;
  }

  return {
    ...preferences,
    sourceGroupExpandedSections:
      Object.keys(sourceGroupExpandedSections).length > 0
        ? sourceGroupExpandedSections
        : undefined,
  };
}

// 排序入口先做规范化，拖拽来源可能是旧快照或非法 id。
// 无效拖拽返回规范化顺序而非入参，保证调用方拿到的始终合法。
export function reorderSidebarPurposeSections(
  sectionOrder: readonly SidebarPurposeSectionId[],
  activeSectionId: string,
  overSectionId: string,
): SidebarPurposeSectionId[] {
  const currentOrder = normalizeSectionOrder(sectionOrder);
  const activeIndex = currentOrder.indexOf(activeSectionId as SidebarPurposeSectionId);
  const overIndex = currentOrder.indexOf(overSectionId as SidebarPurposeSectionId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const activeSection = nextOrder[activeIndex];
  if (!activeSection) {
    return currentOrder;
  }
  nextOrder.splice(activeIndex, 1);
  nextOrder.splice(overIndex, 0, activeSection);
  return nextOrder;
}

// 默认参数注入浏览器存储，测试可传内存实现或 null。
// [失败路径] 无论存储异常还是数据损坏，都返回默认偏好，绝不向上抛。
export function readSidebarPurposeSectionPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): SidebarPurposeSectionPreferences {
  try {
    const rawValue = storage?.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return getDefaultPreferences();
    }

    // 解析结果先标为 unknown，后续每个字段都要过守卫，不做整体断言后直接使用。
    // [失败路径] JSON 语法错误由外层 catch 接住，与存储读取异常走同一条降级路径。
    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultPreferences();
    }

    const value = parsed as Partial<SidebarPurposeSectionPreferences>;
    const sourceGroupExpandedSections = normalizeSourceGroupExpandedSections(
      value.sourceGroupExpandedSections,
    );
    return {
      projectsExpanded:
        // 逐字段做类型守卫，非布尔值不猜测，直接使用集中定义的默认值。
        // conversationsExpanded 用同一模式，两个全局分区不能只校验一个。
        typeof value.projectsExpanded === "boolean"
          ? value.projectsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.projectsExpanded,
      conversationsExpanded:
        typeof value.conversationsExpanded === "boolean"
          ? value.conversationsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.conversationsExpanded,
      sectionOrder: normalizeSectionOrder(value.sectionOrder),
      ...(sourceGroupExpandedSections ? { sourceGroupExpandedSections } : {}),
    };
  } catch {
    return getDefaultPreferences();
  }
}

// 写入是尽力而为：调用方不等待结果，函数也没有返回值。
// 写前重新规范化顺序与分组，保证存储内容始终满足读取端的校验。
// [失败路径] 捕获全部异常并静默，配额溢出或隐私模式只影响持久化，不影响当前交互。
export function persistSidebarPurposeSectionPreferences(
  preferences: SidebarPurposeSectionPreferences,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    const sourceGroupExpandedSections = normalizeSourceGroupExpandedSections(
      preferences.sourceGroupExpandedSections,
    );
    storage?.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        projectsExpanded: preferences.projectsExpanded,
        conversationsExpanded: preferences.conversationsExpanded,
        sectionOrder: normalizeSectionOrder(preferences.sectionOrder),
        ...(sourceGroupExpandedSections ? { sourceGroupExpandedSections } : {}),
      }),
    );
  } catch {
    // catch 里吞异常是刻意选择，不是遗漏，日志层必须不记录也不上报。
    // 若未来需要诊断写入失败，应在此处加可观测计数，而不是把异常重新抛出。
    // 受限 WebView 或隐私模式可能禁止写 localStorage；偏好写入失败不能阻断侧栏交互。
  }
}
