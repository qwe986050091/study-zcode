/* eslint-disable max-lines -- 设置导航意图集中管理 sessionStorage、事件桥接和解析校验，拆分会让一次性意图消费顺序更难保证。 */
// 设置导航意图中枢：把「打开设置页的某个分区/子 tab」编码为 sessionStorage 键 + 同窗口自定义事件，
// 供 quickpick、头像菜单、插件商店、模型供应商、远程设备等入口写入，由设置页挂载时消费一次即清。
// 不负责设置页渲染、tab 数据加载、权益判定，也不做跨窗口/跨标签同步（那是 broadcastService 的职责）。
//
// INV-01 断言：写入意图时先落 sessionStorage 再派发事件 —— 守住它的位置：setPendingSettingsSectionIntent 末尾的 dispatchEvent —— 改错故障：已打开页面跳对了，关闭后重开却丢失这次直达意图
// INV-02 断言：每个可选字段都有「有值则写入 / 无值则删除」两条分支 —— 守住它的位置：setPendingSettingsSectionIntent 的 pluginTab、pluginOrigin、usageTab 分支 —— 改错故障：上一次跳转的 usageTab 残留，下次打开 Usage 落在错误 tab
// INV-03 断言：消费即删除，同一意图只生效一次 —— 守住它的位置：consumePendingSettingsSection 与 consumePendingSettingsUsageTab —— 改错故障：二次挂载被陈旧意图劫持，用户感觉设置页跳错
// INV-04 断言：监听器收到事件先清存储再回调 —— 守住它的位置：addPendingSettingsSectionListener 的 handleIntent —— 改错故障：切到别的分区退出后，下次挂载仍被旧意图覆盖「上次停留分区」
// INV-05 断言：事件清理发生在分区合法性校验之后 —— 守住它的位置：handleIntent 里的 isSettingsSectionId 判断 —— 改错故障：脏事件误清合法意图，并发跳转丢失
// INV-06 断言：旧 id 迁移分支必须排在通用校验之前 —— 守住它的位置：consumePendingSettingsSection 里 skills 的前置分支 —— 改错故障：旧链接判为非法值落入 general，用户找不到原页面
// INV-07 断言：旧插件 id plugins 一律折叠为 plugin —— 守住它的位置：resolveSettingsSection 首行与 readLastSettingsSectionPreference 的迁移 —— 改错故障：插件直达入口打开后停在常规设置
// INV-08 断言：隐藏分区仍保留类型 id，只在落地时回退 fallback —— 守住它的位置：HIDDEN_SETTINGS_SECTIONS 与 isSettingsSectionEnabled —— 改错故障：旧值被当作脏数据清掉，或定时任务重新出现在设置侧栏
// INV-09 断言：resolve 是纯函数，不写存储也不派事件 —— 守住它的位置：resolveSettingsSection 全体 —— 改错故障：读取路径变成写路径，重入时意图被反复改写
// INV-10 断言：上次分区的 fallback 由调用方传入，不得写死 —— 守住它的位置：consumeInitialSettingsSection —— 改错故障：没有显式意图时打开设置页永远进模型供应商
// INV-11 断言：一次性意图必须能覆盖上次分区偏好 —— 守住它的位置：consumeInitialSettingsSection 的嵌套 resolve —— 改错故障：quickpick 指定分区后仍停在旧页面
// INV-12 断言：存储不可用时返回 null 或 fallback 而不是抛错 —— 守住它的位置：getLocalStorage 与各处的 try/catch —— 改错故障：受限 WebView 里设置页完全打不开
// INV-13 断言：pluginTab 只在 tab 为 plugins 时写键 —— 守住它的位置：setPendingSettingsPluginIntent 的三元 —— 改错故障：从 MCP tab 进入后在插件页误开子 tab
// INV-14 断言：tab 到 section 的映射与消费端合法值集合一致 —— 守住它的位置：setPendingSettingsPluginIntent 与 consumePendingSettingsPluginTab —— 改错故障：新增 tab 被静默过滤成 undefined
// INV-15 断言：usageTab 缺失代表沿用用户原 tab，不得默认切 app —— 守住它的位置：setPendingSettingsUsageIntent 与消费端 —— 改错故障：普通入口强行重置用户已选的统计 tab
// INV-16 断言：codingPlan 回退要等 loading 与权益检查都结束 —— 守住它的位置：shouldFallbackSettingsUsageTabToApp —— 改错故障：首帧把 codingPlan 改回 app，出现跳 tab 抖动
// INV-17 断言：监听器返回的取消函数必须成对调用 —— 守住它的位置：addPendingSettingsSectionListener 的返回值 —— 改错故障：HMR 或重复挂载累积监听器，一次跳转触发多次
// INV-18 断言：新增意图键必须同时加入清理清单 —— 守住它的位置：clearPendingSettingsSectionIntent 的 removeItem 列表 —— 改错故障：键永久残留，下次打开设置页被陈旧意图带偏
//
// 键位约定：zcode-settings-*-intent 为一次性意图（sessionStorage，读完即删）；
// zcode-settings-last-section 为跨会话偏好（localStorage，只在分区切换时覆写）。
// 事件约定：zcode:settings-section-intent 只服务同窗口已挂载的设置页，detail 与存储键同构。
// 兼容约定：plugins、skills、codePreview 等旧 id 只在读取侧迁移，写入侧永远落规范化后的新 id。
//
// 所有消费函数都返回 undefined、false 或 fallback 而不是抛错：导航失败最多回到默认分区；
// 反过来让存储异常冒泡，会直接打断「打开设置页」这个动作。
import { logger } from "@/logger.js";

// [契约] 分区 id 是持久化格式：localStorage、sessionStorage 与旧值迁移分支都按字面值匹配。
// 改字面值等于丢掉用户上次停留的分区；新增分区必须同步 isSettingsSectionId 的判定链。
// 隐藏分区也要保留 id，才能让旧值被识别后回退，而不是当成脏数据清掉。
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "migration"
  | "browser"
  | "modelProvider"
  | "remoteDevices"
  | "memory"
  | "plugin"
  | "mcp"
  | "skill"
  | "plugins"
  | "archives"
  | "usage"
  | "subagents"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "computerUse"
  | "automations"
  | "shortcuts";

export type SettingsUsageTabTarget = "app" | "codingPlan";
export type SettingsPluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type SettingsPluginNavigationOrigin = "plugin-store";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_USAGE_TAB_INTENT_KEY = "zcode-settings-usage-tab-intent",
  SETTINGS_PLUGIN_TAB_INTENT_KEY = "zcode-settings-plugin-tab-intent",
  SETTINGS_PLUGIN_ORIGIN_INTENT_KEY = "zcode-settings-plugin-origin-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_SOURCE_SERVER_ID_INTENT_KEY = "zcode-settings-source-server-id-intent";
const SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY = "zcode-settings-source-server-details-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
// [契约] 这里只控制「能否作为落地分区」，不删类型：resolveSettingsSection 命中隐藏项会回退 fallback。
// 把 hooks 加进来会让所有 hooks 直达入口跳回 general，看起来像快捷入口失效。
// 反过来删掉 automations，定时任务会重新出现在设置侧栏，与 workspace 主视图的产品口径冲突。
// 判定发生在读取路径上，因此隐藏一个分区后旧的持久化值无需清理，会自动降级。
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // 产品语义：定时任务是 workspace 主视图，不能再作为设置页分区出现。
  // 注意：hooks 已是正式设置页分区，不在此列。
  "automations",
  // 旧插件市场已迁出设置页；保留 id 只用于迁移历史偏好和旧调用。
  "plugins",
  // 工作区搜索（.zcodeignore）设置入口先隐藏：规则文件仍生效并可手动编辑，
  // 编辑页代码保留，放开时从这里移除即可。
  "workspaceFileSearch",
]);

export interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginTab?: SettingsPluginTabTarget;
  pluginOrigin?: SettingsPluginNavigationOrigin;
  pluginScopeKey?: string;
  usageTab?: SettingsUsageTabTarget;
  modelProviderId?: string;
  sourceServerId?: string;
  sourceServerDetails?: boolean;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "appearance" ||
    value === "migration" ||
    value === "browser" ||
    value === "modelProvider" ||
    value === "remoteDevices" ||
    value === "memory" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugins" ||
    value === "archives" ||
    value === "usage" ||
    value === "subagents" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "computerUse" ||
    value === "automations" ||
    value === "shortcuts"
  );
}

// [契约] 唯一判定入口：侧栏过滤、resolve 回退、消费校验都走这里，不要在调用点另写 section 比较。
// 分散判断会导致「侧栏已隐藏但深链仍能打开」的不一致。
// `buildSettingsLocation` 是纯函数且无存储副作用，可在渲染期安全调用。
export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

// [契约] plugins 是旧 id，必须折叠到 plugin；漏掉这一步，旧链接会落到 general 而不是插件页。
// 折叠只做一层、不递归：拿到 plugin 后再由 isSettingsSectionEnabled 判定是否可用。
// fallback 默认 general，但 consumeInitialSettingsSection 会传「上次分区」，因此这里不能写死 general。
// 不要在此写存储或派事件，否则读取路径会变成写入路径。
export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (section === "plugins") return "plugin";
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

// [失败路径] 部分 WebView / 移动远控容器禁用 localStorage，连访问 getter 都会抛异常，必须包 try。
// 返回 null 而不是抛错：分区记忆只是 UI 偏好，存储不可用时设置页仍要能打开。
// typeof window 判断留给 SSR 与非浏览器宿主，不能假设 window 一定存在。
// 调用方一律做 null 兜底，不要在别处直接读 window.localStorage。
function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // 部分 WebView / 移动远控容器可能禁用 localStorage。
    // 设置页分区记忆只是 UI 偏好，存储不可用时回退默认入口，不应阻断打开设置页。
    logger.warn("[settingsNavigation] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// [事务] 读到旧 id 时先回写新 id 再返回，保证下一次读取不再走迁移分支。
// plugins 迁移额外播种 pluginTab=plugins：旧用户上次停在插件 tab，要在插件页里恢复该 tab。
// skills 到 skill、codePreview 到 appearance 只改字面值、不派事件，此刻设置页通常还没挂载。
// 无法识别的非空值会被 removeItem，避免每次打开都重复解析同一份脏数据。
// [权衡] 无效值选择删除而不是回退覆盖：用户下次留下新值时会自然重建，省一次写。
export function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    // 旧 section id 已并入 plugin；迁移持久化值，避免继续传播历史路由语义。
    if (raw === "plugins") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "plugin");
      setPendingPluginTab("plugins");
      return "plugin";
    }
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // 旧版“代码预览”已并入“外观”，保留用户上次停留位置的迁移语义。
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] 读取上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

// [契约] 写入前必须 resolve：否则关闭设置页时会把 plugins 这类旧或隐藏 id 固化进 localStorage。
// 写失败只告警：配额满或隐私模式下不应影响关闭设置页这一动作。
// 与读取共用 getLocalStorage，保证两端对「存储不可用」的判断一致。
export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] 写入上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// [契约] 顺序不能反：先读上次分区，再用一次性意图覆盖，最后再 resolve 一次。
// 历史上这里把 fallback 写死为 modelProvider，导致无意图打开也总进模型供应商，这是回归点，别改回去。
// 二次 resolve 覆盖「一次性意图指向隐藏分区」的情况，保证最终落点可用。
// 只在首次挂载时调用；重复调用会重复消费意图。
export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // 普通打开设置页以前把 consumePendingSettingsSection 的 fallback 写死为
  // modelProvider，导致没有显式跳转意图时也总进“模型供应商”。这里先读上次停留分区，
  // 再让 quickpick / 管理模型这类一次性意图覆盖它，保留显式入口的直达语义。
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

// [契约] 对外薄封装，真正的键位编排集中在 setPendingSettingsSectionIntent。
// 调用方不要直接写 sessionStorage，否则会漏掉事件派发，已挂载的页面收不到通知。
export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}

// [权衡] 只打开 Usage 分区、不带 usageTab：强制切 tab 会覆盖用户上次查看的统计 tab。
// 剩余额度直达另走 setPendingSettingsUsageCodingPlanIntent。
export function setPendingSettingsUsageIntent(): void {
  // 使用统计入口只负责打开 Usage 分区，不强行覆盖用户要看的具体统计 tab。
  setPendingSettingsSectionIntent("usage");
}

export function setPendingSettingsUsageCodingPlanIntent(): void {
  // 剩余额度详情入口需要直达 Coding Plan 使用统计；
  // 头像菜单入口则只打开 Usage 分区，避免覆盖用户上次查看的统计 tab。
  setPendingSettingsSectionIntent("usage", { usageTab: "codingPlan" });
}

// [契约] tab 到 section 的映射必须与消费端合法值集合一致，否则 tab 会在读取时被丢弃。
// 只有 tab 为 plugins 才写 pluginTab 键：mcp、skill、commands 已是独立分区，再写会让插件页误开子 tab。
// origin 与 scopeKey 用于插件详情返回态，透传时保持 undefined 而不是空串。
// 新增 tab 必须同时改 SettingsPluginTabTarget 与本映射，漏一处会被消费端静默过滤。
export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    origin?: SettingsPluginNavigationOrigin;
    scopeKey?: string;
  } = {},
): void {
  const section =
    tab === "mcps"
      ? "mcp"
      : tab === "skills"
        ? "skill"
        : tab === "commands"
          ? "commands"
          : "plugin";
  setPendingSettingsSectionIntent(section, {
    pluginTab: tab === "plugins" ? tab : undefined,
    pluginOrigin: options.origin,
    pluginScopeKey: options.scopeKey,
  });
}

// [事务] 每个可选字段都成对存在「有值写入 / 无值删除」：漏掉 else 分支会把上次意图残留到下一次跳转。
// 先写存储再派事件；写存储失败被 catch 吞掉，但事件仍会派发，已挂载页面照常跳转。
// sourceServerId 与 sourceServerDetails 只在 remoteDevices 下生效，其它分区会主动清键。
// pluginScopeKey 先 trim，空白串按未提供处理，避免消费端拿到空字符串。
// [并发] 同窗口连续两次调用后者覆盖前者、不排队；这是有意为之，UI 只认最后一次点击。
export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginTab?: SettingsPluginTabTarget;
    pluginOrigin?: SettingsPluginNavigationOrigin;
    pluginScopeKey?: string;
    modelProviderId?: string;
    sourceServerId?: string;
    sourceServerDetails?: boolean;
    usageTab?: SettingsUsageTabTarget;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
    if (options.pluginTab) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, options.pluginTab);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    }
    if (options.pluginOrigin) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY, options.pluginOrigin);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    }
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.usageTab) {
      window.sessionStorage.setItem(SETTINGS_USAGE_TAB_INTENT_KEY, options.usageTab);
    }
    if (section === "remoteDevices" && options.sourceServerId?.trim()) {
      window.sessionStorage.setItem(
        SETTINGS_SOURCE_SERVER_ID_INTENT_KEY,
        options.sourceServerId.trim(),
      );
    } else {
      window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    }
    if (
      section === "remoteDevices" &&
      options.sourceServerId?.trim() &&
      options.sourceServerDetails
    ) {
      window.sessionStorage.setItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY, "true");
    } else {
      window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    }
    if (options.modelProviderId) {
      window.sessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  // 设置页已经打开时不会重新挂载，单纯写 sessionStorage 没有订阅者会响应。
  // 同窗口补发自定义事件，让已打开的 SettingsPage 也能即时跳到 quickpick 指定分区。
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
        pluginTab: options.pluginTab,
        pluginOrigin: options.pluginOrigin,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        usageTab: options.usageTab,
        modelProviderId: options.modelProviderId,
        ...(section === "remoteDevices" && options.sourceServerId?.trim()
          ? {
              sourceServerId: options.sourceServerId.trim(),
              ...(options.sourceServerDetails ? { sourceServerDetails: true } : {}),
            }
          : {}),
      },
    }),
  );
}

// [资源] 一次性意图的完整键清单；新增键必须加进来，否则监听器消费后残留，下次挂载被陈旧意图劫持。
// 与 setPendingSettingsSectionIntent 内的删除集合不同：这里连事件已消费的 usage 与 model 键也一并清。
// 清理失败静默：最多影响下一次跳转，不应阻断当前导航。
function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

// [事务] 读到即删：意图只能生效一次，二次挂载必须回落到 fallback。
// skills 的迁移分支必须在通用校验之前，否则会被 isSettingsSectionId 判为非法值丢弃。
// 删除发生在解析之前：即使解析失败也不再保留，避免坏值反复触发分支。
// 存储抛错时返回 fallback，不向上抛。
export function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // 旧 Skills 使用复数 id；迁移到当前独立 skill 分区。
      return "skill";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  return fallbackSection;
}

function setPendingPluginTab(tab: SettingsPluginTabTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, tab);
  } catch {
    // 忽略浏览器存储异常，不影响设置页打开。
  }
}

// [契约] 返回值集合与 SettingsPluginTabTarget 手工同步，多出来的历史值直接判 undefined。
// 无论值是否合法都 removeItem，保证脏值不会永久占据键位。
// 消费顺序要晚于分区消费，否则插件页还没挂载就拿不到 tab。
export function consumePendingSettingsPluginTab(): SettingsPluginTabTarget | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    return raw === "plugins" || raw === "mcps" || raw === "skills" ? raw : undefined;
  } catch {
    return undefined;
  }
}

// [契约] 只认 plugin-store；未知来源按无来源处理，插件页据此决定是否显示返回商店的入口。
// 此处不删键：清理由 clearPendingSettingsPluginOrigin 负责，便于详情页多次读取。
export function consumePendingSettingsPluginOrigin(): SettingsPluginNavigationOrigin | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    return raw === "plugin-store" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// [资源] scopeKey 可能在详情页存活多个渲染周期，因此消费与清理拆开，由页面卸载时显式清理。
// 与 origin 一样不做隐式删除，避免返回列表时丢失定位信息。
export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

export function clearPendingSettingsPluginOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响设置页打开。
  }
}

// [事务] 读到即删且删除先于校验：非法 tab 同样被丢弃，不会在下次打开时重现。
// 只允许 app 与 codingPlan 两个字面值，新增 tab 要同时改类型与这里。
// 返回 undefined 表示沿用用户原来的 tab，调用方不要强行切到 app。
export function consumePendingSettingsUsageTab(): SettingsUsageTabTarget | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    }
    return raw === "app" || raw === "codingPlan" ? raw : undefined;
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
    return undefined;
  }
}

// [契约] providerId 去空格后为空视为无目标，返回 undefined 而不是空对象。
// 先 removeItem 再判空，保证空值也被消费掉，避免空串长期占用键位。
// 只承载「打开某个供应商详情」的最小信息，不要在这里扩展其它供应商字段。
export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = window.sessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
    return undefined;
  }
}

// [权衡] 必须同时满足三个否定条件才回退：仍在 loading 或还在检查权益时保持 codingPlan，否则首帧会改回 app。
// 这是纯判定函数，刻意不读存储：调用方传入的 loading 标志才是唯一事实来源。
// activeTab 不是 codingPlan 时永远返回 false，避免误伤用户手动选择的 tab。
// 删掉任一 loading 判断都会复现「点了更多却停在 app」的抖动。
export function shouldFallbackSettingsUsageTabToApp({
  activeTab,
  checkingCodingPlanTab,
  loadingModelProviders,
  showCodingPlanTab,
}: {
  activeTab: SettingsUsageTabTarget;
  checkingCodingPlanTab: boolean;
  loadingModelProviders: boolean;
  showCodingPlanTab: boolean;
}): boolean {
  // Coding Plan 跳转意图可能先于 provider/entitlement 数据完成加载。
  // 只有确认不再 loading 且仍没有有效套餐时才回退到 App Usage，避免“更多”点击后被首帧误改回默认 tab。
  return (
    activeTab === "codingPlan" &&
    !showCodingPlanTab &&
    !loadingModelProviders &&
    !checkingCodingPlanTab
  );
}

// [并发] 收到事件后先清 sessionStorage 再回调：已挂载页面已拿到 detail，存储副本只会变成陈旧意图。
// 清理放在 isSettingsSectionId 校验之后，脏事件不触发清理，避免误删并发的合法意图。
// 返回的取消函数必须成对调用，否则热更新或重复挂载会累积监听器，一次跳转触发多次。
// SSR 下返回空函数而不是 undefined，调用方可以无条件执行清理。
// 同窗口多个设置页实例都会收到事件，此为预期；是否消费由各自挂载时的 consume 决定。
export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionId(detail.section)) {
      // 设置页已打开时，事件已经承载了这次跳转意图。
      // 这里同步清掉 sessionStorage，避免用户随后切到别的分区并退出后，
      // 下次挂载又被陈旧 pending 意图覆盖“上次停留分区”。
      clearPendingSettingsSectionIntent();
      listener(detail.section, detail);
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}

/** 设置页先消费分区，再消费卡片目标；已挂载页面由同一导航事件直接接收。 */
// [契约] 先消费分区、再消费卡片目标：sourceServerId 只在 remoteDevices 分区有意义。
// 读到即删并 trim，空串按 undefined 处理。
// details 标志单独成键，避免「有 id 但只想打开列表」与「要展开详情」被混为一谈。
export function consumePendingSettingsSourceServerId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const id = window.sessionStorage.getItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_ID_INTENT_KEY);
    return id?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsSourceServerDetails(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const details = window.sessionStorage.getItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_SOURCE_SERVER_DETAILS_INTENT_KEY);
    return details === "true";
  } catch {
    return false;
  }
}
