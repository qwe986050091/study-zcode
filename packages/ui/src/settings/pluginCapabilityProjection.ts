// INV-01 未物化插件不进设置页：守住位置 packageStatus 过滤；改错故障 出现已装却缺失的矛盾行。
// INV-02 内置组按文档优先级排序：守住位置 compareDocumentPluginPriority；改错故障 内置列表顺序随返回抖动。
// INV-03 内置候选只取未安装：守住位置 selectBuiltInPlugins 双条件；改错故障 已装插件重复出现在内置区。
// INV-04 名称归一化统一小写：守住位置 canonicalPluginName；改错故障 同插件名大小写不同即分组分裂。
// INV-05 名称归一化先去空白：守住位置 trim 调用；改错故障 带空格插件名匹配失败。
// INV-06 需要授权按 URL 判定：守住位置 needsMcpAttention；改错故障 需登录的 MCP 不显示提醒。
// INV-07 空查询返回全部插件：守住位置 filterPluginsByQuery 提前返回；改错故障 初次进入列表为空。
// INV-08 搜索同时匹配双语显示名：守住位置 第二组关键词；改错故障 中文名搜不到英文插件。
// INV-09 市场条目按 id 对齐：守住位置 candidate.id 校验；改错故障 错配条目污染展示名。
// INV-10 作用域不再做归属过滤：守住位置 selectPluginsForScope 原样返回；改错故障 工作区丢失继承插件。
// INV-11 技能跟随插件启用态：守住位置 enabledPlugins 过滤；改错故障 停用插件的技能仍可搜索。
// INV-12 旧协议按名称唯一回退：守住位置 matchingIds 长度判断；改错故障 跨市场同名插件被误纳入。
// INV-13 用户命令按作用域映射：守住位置 isUserCommand 分支；改错故障 用户命令在工作区丢失。
// INV-14 插件命令按市场拼 id：守住位置 名称与市场拼接；改错故障 同名插件命令互相串台。
// INV-15 技能分组保留直属组：守住位置 direct 收集分支；改错故障 非插件技能整组消失。
// INV-16 插件组按标签排序：守住位置 localeCompare；改错故障 顺序随 Map 插入顺序变化。
// INV-17 插件组 id 带固定前缀：守住位置 plugin: 前缀；改错故障 与直属组 id 冲突。
// INV-18 本模块不访问存储：守住位置 纯函数集合；改错故障 与设置状态形成隐式耦合。
//
// 模块职责：设置页插件、技能与命令的作用域投影和分组。
// 状态所有权：无状态；全部为只读入参的纯函数。
// 阅读顺序：先看名称归一与授权判定，再读插件分组，最后看技能与命令投影。
import {
  resolveManagedPluginDisplay,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import type {
  SkillSummary,
  ZCodeCommand,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginScope,
} from "@zcode/shared";
import { compareDocumentPluginPriority, isPluginCommand, isUserCommand } from "@zcode/shared";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";

function canonicalPluginName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function needsMcpAttention(resource: {
  authorization?: { authorizationUrl?: string };
}): boolean {
  return Boolean(resource.authorization?.authorizationUrl);
}

export function selectBuiltInPlugins(
  plugins: readonly ZCodePluginInfo[],
  installedPlugins: readonly ZCodeInstalledPluginSummary[],
): ZCodePluginInfo[] {
  const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));
  return plugins.filter((plugin) => plugin.source === "official" && !installedIds.has(plugin.id));
}

export interface PluginSettingsGroups {
  installed: ZCodePluginInfo[];
  builtIn: ZCodePluginInfo[];
}

/**
 * 设置页只展示已物化的插件；Agent 为保留目标 Host 配置而返回的 missing 投影不能
 * 进入 Installed / Built-in，否则会出现“已安装分组 + 未安装状态”的矛盾行。
 */
// 分组互斥：先滤掉 packageStatus === "missing"；builtIn 按 compareDocumentPluginPriority 排序，installed 保持入参顺序。
export function partitionPluginsForSettings(
  plugins: readonly ZCodePluginInfo[],
  builtInPluginIds: ReadonlySet<string>,
): PluginSettingsGroups {
  const materializedPlugins = plugins.filter((plugin) => plugin.packageStatus !== "missing");
  return {
    installed: materializedPlugins.filter((plugin) => !builtInPluginIds.has(plugin.id)),
    builtIn: materializedPlugins
      .filter((plugin) => builtInPluginIds.has(plugin.id))
      .toSorted((left, right) => compareDocumentPluginPriority(left.id, right.id)),
  };
}

// filterPluginsByQuery 先把 query trim + toLocaleLowerCase；空查询返回浅拷贝，不返回入参本身。
// 匹配对象是 resolveManagedPluginDisplay 拼出的显示名与描述（双语），任一关键词命中即保留。
export function filterPluginsByQuery(
  plugins: readonly ZCodePluginInfo[],
  query: string,
  itemsById?: ReadonlyMap<string, StorePluginItem>,
  locale = "en-US",
): ZCodePluginInfo[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...plugins];
  return plugins.filter((plugin) => {
    const candidate = itemsById?.get(plugin.id);
    const item = candidate?.id === plugin.id ? candidate : undefined;
    const display = resolveManagedPluginDisplay(plugin, item, locale);
    return pluginSearchMatches(
      normalizedQuery,
      [plugin.name, plugin.id, plugin.marketplace, display.name, display.description],
      [
        plugin.name,
        item?.listing?.displayName,
        ...Object.values(item?.listing?.displayNameI18n ?? {}),
      ],
    );
  });
}

export function selectPluginsForScope(
  plugins: readonly ZCodePluginInfo[],
  _installedPlugins: readonly ZCodeInstalledPluginSummary[],
  _scope: ZCodePluginScope,
): ZCodePluginInfo[] {
  // User / Workspace 已经由 plugins/list(configScope) 返回各自的配置投影。
  // 这里不能再按 enabledSource/rootSource 做“归属”过滤，否则 Workspace 会丢掉继承 User
  // 的 Host inventory，User 也会被当前 Workspace override 污染后的来源字段误删。
  return [...plugins];
}

// selectSkillsForScope 先用启用插件建 id 集合与「规范化名 → id 列表」索引，非插件技能只按 skill.scope === scope 过滤。
// pluginId 存在时只认 id；否则按 canonicalPluginName 回退，且仅当同名 id 恰好一个才纳入（远程市场重名不合并）。
export function selectSkillsForScope(
  skills: readonly SkillSummary[],
  scopedPlugins: readonly Pick<ZCodePluginInfo, "id" | "name" | "enabled">[],
  scope: ZCodePluginScope,
): SkillSummary[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return skills.filter((skill) => {
    if (skill.scope !== "plugin") {
      return skill.scope === scope;
    }
    if (skill.pluginId) return scopedPluginIds.has(skill.pluginId);
    const matchingIds = skill.pluginName
      ? scopedPluginIdsByName.get(canonicalPluginName(skill.pluginName))
      : undefined;
    // 旧协议没有 pluginId 时，仅在名称唯一的兼容场景下回退，避免跨 marketplace 合并。
    return matchingIds?.length === 1;
  });
}

// selectCommandsForScope 只收作用域内的非插件命令，插件命令一律排除。
// 有 marketplace 时拼完整插件 id 查集合；无市场时按规范化名唯一匹配，重名的一律不用。
export function selectCommandsForScope(
  commands: readonly ZCodeCommand[],
  scopedPlugins: readonly Pick<ZCodePluginInfo, "id" | "name" | "enabled">[],
  scope: ZCodePluginScope,
): ZCodeCommand[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return commands.filter((command) => {
    if (isUserCommand(command)) {
      return command.location.scope === (scope === "user" ? "user" : "project");
    }
    if (!isPluginCommand(command)) return false;
    const marketplace = command.pluginMarketplace?.trim() ?? "";
    const pluginId = `${command.pluginName.trim()}@${marketplace}`;
    if (marketplace) return scopedPluginIds.has(pluginId);
    const matchingIds = scopedPluginIdsByName.get(canonicalPluginName(command.pluginName));
    return matchingIds?.length === 1;
  });
}

export interface SkillSourceGroup {
  id: string;
  label: string;
  pluginId?: string;
  skills: SkillSummary[];
  source: "direct" | "plugin";
}

export function groupScopedSkillsBySource(
  skills: readonly SkillSummary[],
  directLabel: string,
): SkillSourceGroup[] {
  const direct: SkillSummary[] = [];
  const pluginGroups = new Map<string, SkillSourceGroup>();
  for (const skill of skills) {
    if (skill.scope !== "plugin") {
      direct.push(skill);
      continue;
    }
    const pluginName = skill.pluginName?.trim();
    if (!pluginName) continue;
    const pluginId = skill.pluginId?.trim();
    const id = pluginId || canonicalPluginName(pluginName);
    const group = pluginGroups.get(id) ?? {
      id: `plugin:${id}`,
      label: pluginName,
      ...(pluginId ? { pluginId } : {}),
      skills: [],
      source: "plugin" as const,
    };
    group.skills.push(skill);
    pluginGroups.set(id, group);
  }
  return [
    ...(direct.length > 0
      ? [
          {
            id: "direct",
            label: directLabel,
            skills: direct,
            source: "direct" as const,
          },
        ]
      : []),
    ...Array.from(pluginGroups.values()).sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
  ];
}
