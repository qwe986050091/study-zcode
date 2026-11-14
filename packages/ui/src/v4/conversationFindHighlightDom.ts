// INV-01 三层高亮名必须保持常量导出，名称是 CSS ::highlight 选择器与 JS 注册表之间的唯一契约。
// INV-02 FIND_STYLE_ID 必须全局唯一；若与其它注入样式重名，find 样式块会被其它模块覆盖或被误删。
// INV-03 样式表内容必须与 FIND_HIGHLIGHT_STYLE 常量严格一致；哈希或截断写入会让三层高亮中有层失去背景色。
// INV-04 ensureConversationFindHighlightStyle 必须在每次应用高亮前调用，否则新挂载页面缺少 style 节点。
// INV-05 服务端渲染环境下 document 不存在，必须提前返回，不得触碰 window 或 CSS 全局。
// INV-06 CSS Custom Highlight API 缺失时 getCssHighlightSupport 返回 null，调用方必须降级为无高亮而非抛错。
// INV-07 同一 Highlight 名重复写入会整体替换，调用方不得假定旧区间仍被保留。
// INV-08 优先级必须严格 0 小于 1 小于 2：全部匹配、当前匹配、搜索结果，倒序会让当前项被普通项盖住。
// INV-09 Range 必须逐个新建，禁止复用同一对象；复用会让注册表内所有区间塌缩到最后一次截取位置。
// INV-10 文本归一化只允许 toLocaleLowerCase，禁止额外 trim 或去除空白，否则偏移与 DOM 原文错位。
// INV-11 区间偏移基于单个文本节点的字符数据，跨节点短语不会命中，这是有意取舍。
// INV-12 查询串必须先 trim 再归一化；空串直接返回 null，避免匹配推进零长度造成死循环。
// INV-13 行元素只按 data-row-id 精确匹配，行未挂载时必须返回 null，不得回退到模糊查询。
// INV-14 rowMatchIndex 是行内序号，越界时返回 null；不得做取模或夹取，否则高亮会跳到错误区间。
// INV-15 可交互区域与显式忽略标记必须在文本节点层面跳过，否则按钮文案会被重复染色。
// INV-16 清理函数只删自己注册的名字，禁止通配清理，避免误伤其它模块的高亮。
// INV-17 滚动使用居中平滑策略，容器非 Element 时要回退到 parentElement，不能假定祖先一定是元素。
// INV-18 本模块不持有匹配数据，一切状态由调用方传入，模块只做 DOM 读与注册表写。
//
// 模块职责：把 find 索引产出的匹配项映射成 DOM Range，写入 CSS Custom Highlight 注册表，并负责样式注入、滚动定位与清理。
// 状态所有权：匹配集合、当前项、查询串归调用方；模块独占 style 节点与三个 Highlight 名。
// 阅读顺序：常量与样式 → 能力探测 → 区间收集 → 行内定位 → 应用/滚动/清理。
import type { ConversationFindMatch } from "@/v4/conversationFindIndex.js";

// 三个导出常量是样式模板与注册表共用的名字来源，任何一处改动都必须三处同步。
// [权衡] 名称写死为字符串而非从索引派生，换取与 CSS 模板的静态可读性。
// 改名后旧注册项不会被自动回收，需依赖清理函数显式删除。
export const FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find";
export const ACTIVE_FIND_HIGHLIGHT_NAME = "zcode-v4-conversation-find-active";
export const SEARCH_RESULT_HIGHLIGHT_NAME = "zcode-v4-conversation-search-result";

// 固定 id 用于在热更新与重复调用之间复用同一个 style 节点。
// [失败路径] 若页面里已存在同 id 的非本模块节点，会被就地覆写文本内容。
const FIND_STYLE_ID = "zcode-v4-conversation-find-highlight-style";
// 样式模板用变量加兜底色，主题未定义变量时仍有可辨识的背景。
// 三层配色刻意共享 active 色，仅靠优先级区分观感，改动时需同步优先级约定。
const FIND_HIGHLIGHT_STYLE = `
::highlight(${FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight, #fde68a);
  color: var(--color-foreground);
}
::highlight(${ACTIVE_FIND_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
::highlight(${SEARCH_RESULT_HIGHLIGHT_NAME}) {
  background-color: var(--color-find-highlight-active, #facc15);
  color: var(--color-foreground);
}
`;

// 只声明用到的 set 与 delete，避免依赖浏览器完整注册表类型。
// [权衡] 结构类型而非实例类型，使能力探测可在无 DOM 环境中编译通过。
interface CssHighlightRegistryLike {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
}

type CssHighlightLike = { priority?: number };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

// 幂等入口：无论调用多少次，最终只保留一个 style 节点且内容与常量一致。
// [资源] 未连接时才追加，防止热更新期间重复插入导致样式节点堆积。
// [并发] 文本内容比对与赋值非原子，但同帧内多次调用结果收敛到同一内容。
export function ensureConversationFindHighlightStyle() {
  if (typeof document === "undefined") {
    return;
  }

  const style =
    document.getElementById(FIND_STYLE_ID) ?? document.createElement("style");
  style.id = FIND_STYLE_ID;
  if (style.textContent !== FIND_HIGHLIGHT_STYLE) {
    // 开发态 HMR 会复用旧 style 节点；内容变化时必须同步更新。
    style.textContent = FIND_HIGHLIGHT_STYLE;
  }
  if (!style.isConnected) {
    document.head.append(style);
  }
}

// 能力探测集中在此，返回 null 即代表本次调用放弃高亮。
// [失败路径] 非浏览器环境或旧版内核缺少 Highlight 构造器时返回 null，不抛异常。
// 探测结果不缓存，调用方可能在能力恢复后重新拿到可用注册表。
function getCssHighlightSupport(): {
  highlights: CssHighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return null;
  }

  const highlights = (CSS as unknown as { highlights?: CssHighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!highlights || !Highlight) {
    return null;
  }
  return { highlights, Highlight };
}

// 统一在这里挂优先级，避免各调用点遗漏导致层级错乱。
// [权衡] 返回 unknown 而非具体类型，是因为不同内核的 Highlight 实例接口不一致。
function createHighlight(
  Highlight: HighlightConstructor,
  ranges: Range[],
  priority: number,
): unknown {
  const highlight = new Highlight(...ranges) as CssHighlightLike;
  highlight.priority = priority;
  return highlight;
}

// [边界] 无父元素的游离文本节点一律跳过，避免祖先查询抛错。
// 选择器同时覆盖表单控件、可编辑区与显式忽略标记，任一命中即整体跳过。
// [权衡] 跳过按父元素整体判定，宁可少染也不误染输入框内的占位文案。
function shouldSkipTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement;
  if (!parent) {
    return true;
  }
  return Boolean(
    parent.closest(
      'button,input,textarea,select,[contenteditable="true"],[data-conversation-find-ignore="true"]',
    ),
  );
}

// 收集单一元素内全部命中区间，返回顺序即文档顺序。
// [边界] 遍历只接受文本节点，元素节点被拒绝而非下钻，命中判定放在 acceptNode 内。
// [失败路径] 内层循环以 searchStart 递进推进，matchIndex 为 -1 时立即跳出，杜绝零长度死循环。
function collectTextRangesInElement(
  element: HTMLElement,
  normalizedQuery: string,
): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || shouldSkipTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.toLocaleLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const normalizedText = textNode.data.toLocaleLowerCase();
    let searchStart = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      const range = document.createRange();
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, matchIndex + normalizedQuery.length);
      ranges.push(range);
      searchStart = matchIndex + normalizedQuery.length;
    }
    currentNode = walker.nextNode();
  }

  return ranges;
}

// 按行 id 精确取元素，未挂载时返回 null 交由上层判定。
// [边界] 使用属性选择器拼接数字 id，调用方必须保证 rowId 为非负整数。
function getMountedRowElement(
  root: HTMLElement,
  rowId: number,
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
}

// 公共查询入口：把查询串与匹配项翻译成可注册的 Range，失败一律返回 null。
// [并发] 同一行可能在多次调用间被虚拟列表复用，返回的 Range 只在该次 DOM 快照内有效。
// 行内序号越界即视为失效，不做夹取以免高亮落到相邻匹配上。
export function getMountedConversationFindRange(
  root: HTMLElement,
  query: string,
  match: ConversationFindMatch,
): Range | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return null;
  }
  const rowElement = getMountedRowElement(root, match.rowId);
  if (!rowElement) {
    return null;
  }
  const rowRanges = collectTextRangesInElement(rowElement, normalizedQuery);
  return rowRanges[match.rowMatchIndex] ?? null;
}

// 主应用流程：先确保样式，再探测能力，最后整体替换两个 Highlight 名。
// [资源] 两次写入是就地替换，上一轮区间会被注册表丢弃，无需手动删除。
// 返回值是当前项的 Range，供滚动定位复用，避免二次遍历文本。
export function applyConversationFindHighlights({
  root,
  query,
  matches,
  activeMatch,
}: {
  root: HTMLElement;
  query: string;
  matches: readonly ConversationFindMatch[];
  activeMatch: ConversationFindMatch | null;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }

  const ranges = matches
    .map((match) => getMountedConversationFindRange(root, query, match))
    .filter((range): range is Range => range !== null);
  const activeRange = activeMatch
    ? getMountedConversationFindRange(root, query, activeMatch)
    : null;

  support.highlights.set(
    FIND_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, ranges, 0),
  );
  support.highlights.set(
    ACTIVE_FIND_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, activeRange ? [activeRange] : [], 1),
  );
  return activeRange;
}

// 搜索结果高亮独立成名，避免与 find 的两层互相覆盖。
// 单区间也用数组包装注册，保持与多区间路径一致的优先级语义。
// [失败路径] 匹配未挂载时 range 为 null，注册空数组等于清掉旧结果高亮。
export function applySearchResultHighlight({
  root,
  query,
  match,
}: {
  root: HTMLElement;
  query: string;
  match: ConversationFindMatch;
}): Range | null {
  ensureConversationFindHighlightStyle();
  const support = getCssHighlightSupport();
  if (!support) {
    return null;
  }
  const range = getMountedConversationFindRange(root, query, match);
  support.highlights.set(
    SEARCH_RESULT_HIGHLIGHT_NAME,
    createHighlight(support.Highlight, range ? [range] : [], 2),
  );
  return range;
}

// 以区间公共祖先定位滚动目标，文本节点的祖先需回退到父元素。
// [权衡] 居中加平滑带来更好的可视性，代价是快速连续调用时会堆叠动画。
export function scrollConversationFindRangeIntoView(range: Range) {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// 只清 find 的两层名字，搜索结果高亮由独立函数管理。
// [失败路径] 能力缺失时 support 为 null，清理静默跳过，不视为错误。
export function clearConversationFindHighlights() {
  const support = getCssHighlightSupport();
  support?.highlights.delete(FIND_HIGHLIGHT_NAME);
  support?.highlights.delete(ACTIVE_FIND_HIGHLIGHT_NAME);
}

// 搜索结果的单项清理，与应用路径成对，保持注册表不残留僵尸区间。
export function clearSearchResultHighlight() {
  getCssHighlightSupport()?.highlights.delete(SEARCH_RESULT_HIGHLIGHT_NAME);
}
