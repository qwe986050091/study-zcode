// INV-01 高亮接口按能力探测：守住位置 支持函数；改错故障 旧浏览器直接抛错。
// INV-02 样式只注入一次：守住位置 标识判断；改错故障 重复插入样式节点。
// INV-03 主题变量带兜底色：守住位置 样式声明；改错故障 深色主题下高亮不可见。
// INV-04 全部命中与当前命中分开注册：守住位置 两个名称；改错故障 当前项与其余同色。
// INV-05 空命中仍清空注册表：守住位置 空数组构造；改错故障 上一次高亮残留。
// INV-06 清理只删自己的名称：守住位置 删除调用；改错故障 清掉其他功能的高亮。
// INV-07 目标按展开键定位：守住位置 数据属性比较；改错故障 命中落到别的消息。
// INV-08 字段按名称筛选：守住位置 属性选择器；改错故障 在错误字段里找匹配。
// INV-09 首选展开态字段：守住位置 展开判断；改错故障 当前命中停在折叠摘要上。
// INV-10 展开字段为空时退回全部：守住位置 长度判断；改错故障 展开后命中消失。
// INV-11 索引越界退回首段：守住位置 空值兜底链；改错故障 命中没有高亮。
// INV-12 文本节点遍历用树遍历器：守住位置 遍历器创建；改错故障 标签结构被打断。
// INV-13 区间偏移取原文位置：守住位置 起止设置；改错故障 高亮错位。
// INV-14 目标挂载判断看展开键：守住位置 存在性检查；改错故障 滚动到尚未渲染的命中。
// INV-15 已可见不滚动：守住位置 边界比较；改错故障 每次查找页面都跳动。
// INV-16 滚动量为中心差值：守住位置 计算表达式；改错故障 命中停在容器边缘。
// INV-17 滚动不调用全局定位：守住位置 直接改滚动位置；改错故障 祖先链整体位移。
// INV-18 无窗口环境安全返回：守住位置 全局检查；改错故障 服务端渲染报错。
//
// 模块职责：把轨迹搜索命中映射为浏览器高亮并滚动到可见位置。
// 状态所有权：高亮注册表属于文档全局，本模块只按固定名称增删。
// 阅读顺序：先看常量与样式，再看应用与清理，最后看区间收集与能力探测。
import { findTrajectoryTextMatches, type TrajectorySearchMatch } from "@/ModelTrajectorySearch.js";

// HIGHLIGHT_NAME 标记全部命中，ACTIVE_HIGHLIGHT_NAME 单独标记当前项。
// STYLE_ID 是样式注入幂等的唯一判据，重复调用只更新同一个节点。
// 背景取 --color-find-highlight 主题变量，回退值 #fde68a 保证浅色下仍可见。
// HIGHLIGHT_STYLE 等四个常量只在模块内使用，不从包出口导出。
const HIGHLIGHT_NAME = "zcode-model-trajectory-find";
const ACTIVE_HIGHLIGHT_NAME = "zcode-model-trajectory-find-active";
const STYLE_ID = "zcode-model-trajectory-find-highlight-style";
const HIGHLIGHT_STYLE = `
::highlight(${HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

// getHighlightSupport() 返回 null 时直接返回，旧浏览器不抛错。
// ensureStyle() 先于任何 CSS.highlights 写入，避免注册了名称却没有样式。
// ACTIVE_HIGHLIGHT_NAME 用独立 Highlight 注册当前项，深浅两色才能同时存在。
export function applyTrajectorySearchHighlights({
  root,
  query,
  matches,
  activeMatch,
}: {
  root: HTMLElement;
  query: string;
  matches: readonly TrajectorySearchMatch[];
  activeMatch: TrajectorySearchMatch | null;
}): Range | null {
  const support = getHighlightSupport();
  if (!support) return null;
  ensureStyle();
  const ranges = matches
    .map((match) => getMatchRange(root, query, match, false))
    .filter((range): range is Range => range !== null);
  const activeRange = activeMatch ? getMatchRange(root, query, activeMatch, true) : null;
  support.registry.set(HIGHLIGHT_NAME, new support.Highlight(...ranges));
  support.registry.set(
    ACTIVE_HIGHLIGHT_NAME,
    new support.Highlight(...(activeRange ? [activeRange] : [])),
  );
  return activeRange;
}

export function clearTrajectorySearchHighlights(): void {
  const support = getHighlightSupport();
  support?.registry.delete(HIGHLIGHT_NAME);
  support?.registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

export function isTrajectorySearchTargetMounted(root: HTMLElement, expansionKey: string): boolean {
  return [...root.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]")].some(
    (element) => element.dataset.trajectorySearchTargetKey === expansionKey,
  );
}

// rangeRect 完全落在 containerRect 内时返回 false，页面不跳动。
// 直接改 scrollContainer.scrollTop，绕开 scrollIntoView() 对祖先链的位移。
// 返回 true 表示本次确实改写了 scrollTop。
export function scrollTrajectorySearchRangeIntoView(
  range: Range,
  scrollContainer: HTMLElement,
): boolean {
  const rangeRect = range.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  if (rangeRect.top >= containerRect.top && rangeRect.bottom <= containerRect.bottom) return false;

  // 不能在 virtualizer 预定位后再用 scrollIntoView 滚动整个祖先链；直接修正轨迹容器
  // 的 scrollTop，确保一次“下一个”只有最终文本定位这一段可见滚动。
  const rangeCenter = rangeRect.top + rangeRect.height / 2;
  const containerCenter = containerRect.top + containerRect.height / 2;
  scrollContainer.scrollTop += rangeCenter - containerCenter;
  return true;
}

function getMatchRange(
  root: HTMLElement,
  query: string,
  match: TrajectorySearchMatch,
  preferExpanded: boolean,
): Range | null {
  const target = [
    ...root.querySelectorAll<HTMLElement>("[data-trajectory-search-target-key]"),
  ].find((element) => element.dataset.trajectorySearchTargetKey === match.expansionKey);
  if (!target) return null;
  let fields = [
    ...target.querySelectorAll<HTMLElement>(`[data-trajectory-search-field="${match.field}"]`),
  ];
  if (preferExpanded && target.dataset.state === "open") {
    const expandedFields = fields.filter((element) =>
      element.closest("[data-trajectory-message-expanded]"),
    );
    if (expandedFields.length > 0) fields = expandedFields;
  }
  const ranges = fields.flatMap((element) => collectRanges(element, query));
  return ranges[match.fieldMatchIndex] ?? ranges[0] ?? null;
}

// collectRanges() 用 createTreeWalker() 只走 element 内的 SHOW_TEXT 节点。
// findTrajectoryTextMatches() 按归一化查询切段，返回成对的原文区间。
// setStart()/setEnd() 取 match.sourceStart 与 match.sourceEnd 两个原文偏移。
function collectRanges(element: HTMLElement, normalizedQuery: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    for (const match of findTrajectoryTextMatches(textNode.data, normalizedQuery)) {
      const range = document.createRange();
      range.setStart(textNode, match.sourceStart);
      range.setEnd(textNode, match.sourceEnd);
      ranges.push(range);
    }
    node = walker.nextNode();
  }
  return ranges;
}

function ensureStyle(): void {
  const style = document.getElementById(STYLE_ID) ?? document.createElement("style");
  style.id = STYLE_ID;
  if (style.textContent !== HIGHLIGHT_STYLE) style.textContent = HIGHLIGHT_STYLE;
  if (!style.isConnected) document.head.append(style);
}

function getHighlightSupport(): {
  registry: HighlightRegistry;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}
