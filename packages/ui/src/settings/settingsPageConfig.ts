// INV-01 图标只负责展示：守住位置 分区定义里的 icon 字段；改错故障：图标误参与可见性判定，分区被隐藏。
// INV-02 顺序即渲染顺序：守住位置 主题数组与分区数组的书写顺序；改错故障：侧栏或外观项顺序与设计稿不一致。
// INV-03 分组三分：守住位置 SettingsSectionGroupId 的联合类型；改错故障：新增分组未登记，分区被过滤掉。
// INV-04 标题回退：守住位置 contentTitleId 的可选语义；改错故障：缺省时标题为空。
// INV-05 角标可选：守住位置 titleBadgeId 缺省分支；改错故障：无角标分区渲染出空角标位。
// INV-06 归属唯一：守住位置 分区到分组的 groupId 匹配；改错故障：分区挂到错误分组或同时出现在两组。
// INV-07 基线不裁剪：守住位置 BASE_SETTINGS_SECTIONS 全量清单；改错故障：门禁被写进定义，动态平台能力失效。
// INV-08 平台门禁：守住位置 三个 isDesktop 标志的或运算；改错故障：桌面端看不到 Computer Use。
// INV-09 灰度门禁：守住位置 isSettingsSectionEnabled 过滤；改错故障：被灰度关闭的分区仍出现在侧栏。
// INV-10 空组剔除：守住位置 分组过滤的 length 判断；改错故障：侧栏出现只有标题的空分组。
// INV-11 只读兼容：守住位置 SETTINGS_SECTIONS 常量；改错故障：Web 视图渠道意外获得 Computer Use。
// INV-12 回退链三级：守住位置 resolve 的分支顺序；改错故障：目标不可见时整页空白。
// INV-13 末级兜底：守住位置 首项回退到 general；改错故障：空列表返回 undefined 引发渲染异常。
// INV-14 远程设备判定：守住位置 isSettingsSectionAvailable 的比较；改错故障：非桌面端暴露远程设备入口。
// INV-15 分区 id 单一来源：守住位置 SettingsSectionId 的引用；改错故障：路由与侧栏使用两套 id。
// INV-16 分组对象不可变：守住位置 map 展开生成新对象；改错故障：过滤过程改写共享基线。
// INV-17 迁移项注释保留：守住位置 migration 注释块；改错故障：恢复入口时误删图标依赖。
// INV-18 纯函数：守住位置 本文件无副作用导出；改错故障：配置随调用次数变化。
//
// 模块职责：声明设置页的分组与分区基线，并按平台能力与灰度开关生成最终导航配置。
// 状态所有权：无状态；输入是平台标志，输出是新的分组与分区数组。
// 阅读顺序：主题模式 → 类型定义 → 基线数据 → 过滤导出 → 平台解析 → 可用性判定。
import {
  Archive,
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  WandSparkles,
  HardDrive,
  Keyboard,
  FileSearch,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

// 主题模式清单：system 跟随系统，两种 zai 主题是应用内的固定配色。
// 数组顺序即外观设置里的展示顺序，首项为跟随系统。
//
export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

// 分组标识只允许三类：基础、Agent 能力、数据与统计。
// 新增分组必须同时补分组标题与分区归属，否则相关分区会因找不到组被过滤掉。
//
export type SettingsSectionGroupId = "basics" | "agentCapabilities" | "dataAndStats";

// 分区定义：id 决定路由与灰度开关，icon 与标题只负责展示。
// contentTitleId 缺省时沿用 titleId，titleBadgeId 用于 Beta 等角标。
// groupId 是分区落到侧栏分组的唯一依据。
// 字段全部由基线数据静态提供，运行时不追加或改写。
//
interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

// 分组基线：只声明分组顺序与标题 key，内容由分区过滤后动态生成。
// 分组顺序即侧栏从上到下的顺序，调整顺序只需移动数组元素。
//
const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

// `SETTINGS_PAGE_SECTIONS` 保持全量清单：平台与灰度门禁都在消费时过滤，不在源头裁剪。
// remoteDevices 与 computerUse 排在浏览器之后，让本机操控类入口连成一段。
// migration 整项以注释保留，恢复时需同时补回图标导入。
//
const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
  },
  {
    id: "plugin",
    icon: Blocks,
    titleId: "settings.plugins.title",
    groupId: "agentCapabilities",
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "agentCapabilities",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "agentCapabilities",
  },
  {
    id: "browser",
    icon: Globe2,
    titleId: "settings.browser.title",
    groupId: "basics",
  },
  // 原型导航顺序：浏览器之后才是远程设备；电脑控制继续紧随其后并受灰度门禁。
  {
    id: "remoteDevices",
    icon: HardDrive,
    titleId: "settings.remoteDevicesTitle",
    contentTitleId: "settings.remoteDevicesTitle",
    groupId: "basics",
  },
  // 电脑控制紧跟「浏览器」：两者都是给 Agent 用的本机操控入口，
  // 放在基础设置里让用户在同一处理解「控制浏览器 / 控制整台电脑」的关系。
  {
    id: "computerUse",
    icon: Monitor,
    titleId: "settings.computerUse.title",
    groupId: "basics",
  },
  // 键盘快捷键紧跟「电脑控制」：同属本机操控/效率配置，收纳在基础设置尾部。
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
  },
  // 工作区搜索范围（.zcodeignore）：面向所有用户的基础工作区行为配置，收在基础设置末尾。
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
  },
  {
    id: "archives",
    icon: Archive,
    titleId: "archives.nav",
    groupId: "dataAndStats",
  },
  // 暂时隐藏设置页里的 Migration 入口，只保留页面实现，后续可以直接恢复这一项。
  // {
  //   id: "migration",
  //   icon: ArrowLeftRight,
  //   titleId: "settings.migration.title",
  // },
];

// 兼容既有只读消费者：默认配置代表不带桌面平台能力的 Web 视图；
// macOS/Windows/Linux 必须继续通过 createSettingsPageConfig 动态加入 Computer Use。
// 只读兼容导出：不含 Computer Use，且已剔除被灰度关闭的分区。
// 桌面端要看到 Computer Use 必须走 createSettingsPageConfig，不要改这里的过滤条件。
//
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) => section.id !== "computerUse" && isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

// 按平台能力生成：任一桌面标志为真即展示 Computer Use。
// 先按平台剔除分区，再按灰度剔除，最后按 groupId 把分区挂到分组。
// 空分组会被整体过滤，避免侧栏出现只有标题没有条目的分组。
//
export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isDesktop || isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

// 解析目标分区：请求的分区可见就用它，否则退回 fallback，再否则取首项。
// 首项也缺失时兜底 general，保证返回值永远是可渲染的分区。
//
export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export const SETTINGS_SECTION_GROUPS = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: SETTINGS_SECTIONS.filter((section) => section.groupId === group.id),
})).filter((group) => group.sections.length > 0);

export type { SettingsSectionId };

// 远程设备只在桌面端可用：非桌面直接判定不可用，用于路由层的入口拦截。
// 该判定不读灰度开关，灰度仍在 SETTINGS_SECTIONS 的过滤里完成。
//
export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isDesktop: boolean,
): boolean {
  return isDesktop || section !== "remoteDevices";
}
