// INV-01 查询去空白后判空：守住位置 hasMentionQuery；改错故障 空格被当成有效查询。
// INV-02 空查询才用默认分组上限：守住位置 三元；改错故障 有查询时仍截断结果。
// INV-03 空查询展示上限固定：守住位置 DISPLAY_CAP；改错故障 巨型仓库全量渲染。
// INV-04 要求查询时不展示默认项：守住位置 requireQuery；改错故障 打开面板就渲染全量。
// INV-05 前缀命中优先于子串：守住位置 前缀分支；改错故障 相关度排序颠倒。
// INV-06 子串命中带位置权重：守住位置 索引偏移；改错故障 越靠后反而越靠前。
// INV-07 中文只走前两级：守住位置 汉字正则；改错故障 「浏器」命中「浏览器操作」。
// INV-08 英文保留子序列匹配：守住位置 子序列循环；改错故障 英文缩写搜不到。
// INV-09 匹配失败返回空：守住位置 返回 null；改错故障 无关项混入结果。
// INV-10 同分保持原序：守住位置 索引比较；改错故障 同分项顺序抖动。
// INV-11 同分再按标签排序：守住位置 localeCompare；改错故障 多语言下顺序不稳定。
// INV-12 分数加成体现字段权重：守住位置 加权常量；改错故障 描述命中压过标题命中。
// INV-13 插件不参与描述匹配：守住位置 类别判断；改错故障 长描述引入无关候选。
// INV-14 关键词命中附加固定分：守住位置 加分；改错故障 关键词结果排在标题后。
// INV-15 上限非有限时返回全量：守住位置 有限性判断；改错故障 NaN 截断成空。
// INV-16 上限取整且不为负：守住位置 夹取；改错故障 负数导致反向切片。
// INV-17 目录排在文件之后：守住位置 默认优先级；改错故障 空查询时目录抢占首位。
// INV-18 空分组结果被过滤：守住位置 buildVisibleMentionGroups；改错故障 渲染空标题分组。
//
// 模块职责：对提及候选项做空查询排序、模糊打分与结果上限裁剪。
// 状态所有权：无状态；所有导出均为纯函数。
// 阅读顺序：先看查询判空，再看打分与排序，最后看结果上限。
import type { MentionItem } from "@/mentions/mentionTypes.js";

/**
 * Safety-net cap for virtualized display. Large enough to never feel
 * "incomplete" to users, small enough to keep fuzzy-sort and virtualizer
 * memory in check for enormous monorepos.
 */
const MENTION_DISPLAY_CAP = 1000;
export const MENTION_DEFAULT_GROUP_PREVIEW_LIMIT = 3;
export const MENTION_FILES_ONLY_DEFAULT_PREVIEW_LIMIT = 10;

// hasMentionQuery 只看 query.trim() 是否非空，不解析 @ 前缀。
// query.trim() 为全空白串时视为无查询，调用方据此跳过过滤。
// hasMentionQuery 的布尔值供 @ 面板决定展示默认列表还是搜索结果。
export function hasMentionQuery(query: string): boolean {
  return query.trim().length > 0;
}

export function getMentionGroupLimitForQuery(
  query: string,
  defaultLimit = MENTION_DEFAULT_GROUP_PREVIEW_LIMIT,
): number | undefined {
  return hasMentionQuery(query) ? undefined : defaultLimit;
}

interface FilterMentionItemsOptions {
  limit?: number;
  requireQuery?: boolean;
}

export interface MentionResultGroup<TItem = MentionItem> {
  id: string;
  title: string;
  items: TItem[];
  loading: boolean;
  errorText: string | null;
  emptyText: string;
}

export function buildVisibleMentionGroups<TItem>(
  groups: MentionResultGroup<TItem>[],
): MentionResultGroup<TItem>[] {
  return groups.filter((group) => group.loading || group.errorText !== null || group.items.length > 0);
}

// 中文查询只走前缀/子串两级：逐字符子序列匹配对 CJK 过宽（「浏器」会命中「浏览器操作」），
// 中文用户的预期是连续子串命中；英文 query 保持子序列级不变。
const HAN_QUERY_RE = /\p{Script=Han}/u;

// normalizedText 为空时返回 null，该条目不进入排序。
// normalizedQuery 为空时返回 0，空前缀不匹配任何字符。
// 前缀命中返回长度差，子串命中返回 100 + indexOf，前者天然更优。
// HAN_QUERY_RE 命中时不再做子序列，避免「浏器」匹配「浏览器操作」。
function scoreFuzzyMatch(text: string, query: string): number | null {
  const normalizedText = text.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedText) {
    return null;
  }

  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedText.startsWith(normalizedQuery)) {
    return normalizedText.length - normalizedQuery.length;
  }

  const substringIndex = normalizedText.indexOf(normalizedQuery);
  if (substringIndex !== -1) {
    return 100 + substringIndex;
  }

  if (HAN_QUERY_RE.test(normalizedQuery)) {
    return null;
  }

  let score = 200;
  let searchStart = 0;

  for (const char of normalizedQuery) {
    const foundIndex = normalizedText.indexOf(char, searchStart);
    if (foundIndex === -1) {
      return null;
    }

    score += foundIndex - searchStart;
    searchStart = foundIndex + 1;
  }

  return score + (normalizedText.length - normalizedQuery.length);
}

// 先调用 getScore，返回 null 的条目在 filter 里丢弃。
// 同分时按原下标升序，sort 的比较器自己保证稳定。
// 分数与下标都相同的才用 getLabel 的 localeCompare 兜底。
function sortScoredItems<T>(
  items: T[],
  getScore: (item: T) => number | null,
  getLabel: (item: T) => string,
): T[] {
  return items
    .map((item, index) => {
      const score = getScore(item);
      if (score === null) {
        return null;
      }

      return { index, item, score };
    })
    .filter(
      (
        item,
      ): item is {
        index: number;
        item: T;
        score: number;
      } => item !== null,
    )
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.index !== right.index) {
        return left.index - right.index;
      }

      return getLabel(left.item).localeCompare(getLabel(right.item));
    })
    .map((item) => item.item);
}

export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  return filterMentionItemsWithOptions(items, query);
}

// limit 不是有限数（undefined/Infinity）时直接返回全量。
// Math.max(0, Math.trunc(limit)) 把负数与小数夹到合法范围。
// items.slice(0, safeLimit) 返回新数组，不修改入参。
function applyMentionItemLimit(items: MentionItem[], limit?: number): MentionItem[] {
  if (!Number.isFinite(limit)) {
    return items;
  }

  const safeLimit = Math.max(0, Math.trunc(limit ?? 0));
  return items.slice(0, safeLimit);
}

function getDefaultMentionItemPriority(item: MentionItem): number {
  if (item.category !== "files") {
    return 0;
  }
  return item.data?.kind === "directory" ? 1 : 0;
}

function sortDefaultMentionItems(items: MentionItem[]): MentionItem[] {
  return items
    .map((item, index) => ({ index, item, priority: getDefaultMentionItemPriority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ item }) => item);
}

// 空查询走 sortDefaultMentionItems，按 files 与 directory 的默认优先级。
// 有查询时用 scoreFuzzyMatch 打分，再交给 sortScoredItems 排序。
// 两条分支最后都经 applyMentionItemLimit 裁剪 effectiveLimit。
export function filterMentionItemsWithOptions(
  items: MentionItem[],
  query: string,
  options: FilterMentionItemsOptions = {},
): MentionItem[] {
  const effectiveLimit = options.limit ?? MENTION_DISPLAY_CAP;
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    // `@` 面板一打开就会进入这里。之前空 query 直接返回全量文件，
    // 大工作区会瞬间渲染成千上万条 option，随后上下键每切一次都要让整棵列表参与更新，体感就会非常卡。
    // 这里支持按需要求”必须先输入 query 才展示结果”，并保留结果上限，避免再次把大列表打进渲染层。
    return options.requireQuery
      ? []
      : applyMentionItemLimit(sortDefaultMentionItems(items), effectiveLimit);
  }

  return applyMentionItemLimit(
    sortScoredItems(
      items,
      (item) => {
        const labelScore = scoreFuzzyMatch(item.label, normalizedQuery);
        // 插件长描述仅展示，避免子序列匹配把无关候选带入搜索（plugin-reference-mention）。
        const descriptionScore =
          item.category === "plugins" ? null : scoreFuzzyMatch(item.description, normalizedQuery);
        const valueScore = scoreFuzzyMatch(item.value, normalizedQuery);
        const keywordScore = Math.min(
          ...(item.keywords ?? []).map((keyword) => {
            const score = scoreFuzzyMatch(keyword, normalizedQuery);
            return score === null ? Number.POSITIVE_INFINITY : score + 300;
          }),
          Number.POSITIVE_INFINITY,
        );
        const bestScore = Math.min(
          labelScore ?? Number.POSITIVE_INFINITY,
          valueScore !== null ? valueScore + 25 : Number.POSITIVE_INFINITY,
          descriptionScore !== null ? descriptionScore + 100 : Number.POSITIVE_INFINITY,
          keywordScore,
        );

        return Number.isFinite(bestScore) ? bestScore : null;
      },
      (item) => item.label,
    ),
    effectiveLimit,
  );
}
