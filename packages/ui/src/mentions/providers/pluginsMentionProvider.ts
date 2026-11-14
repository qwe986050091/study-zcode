// INV-01 禁用插件不进候选：守住位置 启用过滤；改错故障 已禁用插件仍可引用。
// INV-02 冲突插件保持可见：守住位置 冲突判断；改错故障 冲突插件从列表消失。
// INV-03 冲突条目禁选并给出原因：守住位置 禁用字段；改错故障 点选后引用失败。
// INV-04 官方市场条目优先排序：守住位置 排序分支；改错故障 商店条目排在本地之后。
// INV-05 其余市场条目保持原序：守住位置 展开顺序；改错故障 本地插件顺序被打乱。
// INV-06 无分类时不排序：守住位置 分类判断；改错故障 无分类目录被重排。
// INV-07 展示名随语言本地化：守住位置 名称解析；改错故障 中文界面显示英文名。
// INV-08 引用标签固定原名：守住位置 直接取值；改错故障 气泡文案随语言变化分裂。
// INV-09 关键词并入多语言名：守住位置 数组展开；改错故障 英文界面搜不到中文名插件。
// INV-10 关键词同时含标识与市场：守住位置 数组前两项；改错故障 只能按显示名搜到。
// INV-11 引用载体固定协议形式：守住位置 工厂调用；改错故障 引用无法被解析回插件。
// INV-12 图标缺席不写键：守住位置 条件展开；改错故障 数据里出现未定义图标。
// INV-13 描述缺省为空串：守住位置 空值兜底；改错故障 描述显示未定义。
// INV-14 分区标识固定为插件：守住位置 字面量；改错故障 面板把插件并到别的分区。
// INV-15 办公模式取工作排序：守住位置 三元选择；改错故障 办公模式套用编码排序。
// INV-16 未启用时不发请求：守住位置 入参开关；改错故障 隐藏面板仍在拉目录。
// INV-17 空查询也展示全部候选：守住位置 查询选项；改错故障 未输入时列表为空。
// INV-18 未启用时返回空清单：守住位置 三元返回；改错故障 关闭后仍渲染旧候选。
//
// 模块职责：把插件目录映射成提及面板的候选分区。
// 状态所有权：无状态；目录、排序与查询全部由调用方注入。
// 阅读顺序：先看映射规则，再看 hook 接线，最后看两层缓存。
import { useMemo } from "react";
import {
  sortPluginStoreEntries,
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolvePluginDisplayName,
  resolveLocalizedText,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface PluginMentionLabels {
  conflictReason: string;
}

// - 只展示 catalog 中 enabled 的 Plugin；disabled 条目不可被引用，不进入候选。
// - 同名 manifest 冲突（conflictingPluginIds 非空）保持可见但禁选，展示冲突原因（V1 fail closed）。
// - markdown 载体固定 `[@Label](plugin://stable-id)`；label 仅展示，身份在 destination。
//   面板展示名 displayLabel 按当前 locale 走全 app 统一的 resolvePluginDisplayName；label 与
//   载体 label 固定 entry.name，chip/canonical text/reminder 不随 locale 变化（chip 节点复用
//   item.label，若本地化 label 会与按 markdown 重建的消息气泡文案分裂）。
// - keywords 并入 listing 的全部语言显示名（无论当前 locale）：英文界面下打中文
//   也能搜到官方插件（插件 @ 引用中文搜索）。
// 官方市场条目排在企业自带条目之前，排序键由 sortPluginStoreEntries 决定。
// 非公开市场条目原样拼在已排序段之后，不参与 sortPluginStoreEntries。
// filter(entry => entry.enabled) 在映射前剔除禁用插件，禁用项不会出现在提及列表。
// conflictingPluginIds 命中的条目仍保留，但带 disabled: true 与 labels.conflictReason。
export function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
        ]
      : entries;
  return sorted
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const conflicted = entry.conflictingPluginIds.length > 0;
      return {
        id: `plugin:${entry.pluginId}`,
        category: "plugins" as const,
        label: entry.name,
        displayLabel: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
        description: resolveLocalizedText(locale, entry.description, entry.descriptionI18n) ?? "",
        value: entry.pluginId,
        markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
        keywords: [
          entry.name,
          entry.pluginId,
          entry.marketplace,
          ...(entry.displayName ? [entry.displayName] : []),
          ...Object.values(entry.displayNameI18n ?? {}),
        ],
        data: {
          pluginId: entry.pluginId,
          ...(entry.icon ? { icon: entry.icon } : {}),
        },
        ...(conflicted
          ? {
              disabled: true,
              disabledReason: labels.conflictReason,
            }
          : {}),
      };
    });
}

// modeOrder 取 order?.work 或 order?.code，由 useIsOfficeMode 决定。
// enabled 为 false 时 usePluginReferenceCatalog 不发请求，直接返回空目录。
// 目录请求失败时把 error 包成异常对象返回，调用方据此展示错误态。
export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(workspacePath, workspaceIdentity, sessionId, enabled);

  // displayLabel 走 resolvePluginDisplayName，按当前 locale 取显示名。
  // item.label 固定 entry.name，chip 与 markdown 载体都不随 locale 变化。
  // keywords 合并 listing.displayNameI18n 的全部语言名，中文界面外也能搜到。
  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({ id: "chat.mention.plugins.conflict" }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}
