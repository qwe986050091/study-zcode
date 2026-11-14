// DOM 工具层：选区/查找/高亮、滚动定位、链接守卫与顶页跟踪，供各查看器复用。
// 边界：只读渲染后的 DOM 与样式，不回写文档数据；所有函数都可由查看器重复调用且幂等。
// 失败语义：找不到元素/文本时返回 null 或空数组，不抛错；仅链接守卫会阻止未授权导航。
// 校验外链：仅允许 http(s) 与 mailto；相对地址按无效基址解析后会被拒绝，其余协议返回 null。
// 白名单式外链过滤：只放行 http/https/mailto，相对地址和 javascript: 等一律返回 null。
// 不可解析的 URL 直接拒绝，不抛错；调用方拿到 null 时应阻止导航而不是尝试修复链接。
/** Only http(s) and mailto links leave the document; everything else is blocked. */
export function safeExternalUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://invalid.invalid/");
    if (url.hostname === "invalid.invalid") return null;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// 在 root 上以捕获阶段拦截链接点击：外部链接交给 external，页内 #锚点交给 internal。
// 返回解绑函数；未识别的链接只 preventDefault，避免宿主窗口被意外导航。
/**
 * Route clicks on links inside rendered documents: external links go to the host, in-document
 * anchors (`#bookmark`) are handled by `internal`, anything else is cancelled.
 */
export function installLinkGuard(
  root: HTMLElement,
  external: (url: string) => void,
  internal?: (hash: string, link: Element) => boolean,
): () => void {
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a, [href]") : null;
    if (!link || !root.contains(link)) return;
    const href = link.getAttribute("href") ?? link.getAttribute("xlink:href");
    if (!href) return;
    event.preventDefault();
    if (href.startsWith("#")) {
      if (internal?.(href.slice(1), link)) event.stopPropagation();
      return;
    }
    const url = safeExternalUrl(href);
    if (url) {
      event.stopPropagation();
      external(url);
    }
  };
  root.addEventListener("click", onClick, true);
  return () => root.removeEventListener("click", onClick, true);
}

// 取当前选区：仅当选区非折叠且完全位于 root 内才返回，空白文本视为无选区。
// 返回的 range 供上层做高亮或定位，text 已折叠连续空白并去首尾空格。
// 无选区、跨出 root 或折叠光标一律返回 null；不修改选区本身，纯读取。
/** Text of the current DOM selection if it lies inside `root`. */
export function selectionIn(root: HTMLElement): { text: string; range: Range } | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().replace(/\s+/g, " ").trim();
  return text ? { text, range } : null;
}

// 文本归一化：连续空白折叠为单空格、去首尾、转小写，用于大小写与空白不敏感匹配。
const normalise = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

// 扁平化结果：text 为归一化后的可视文本，map 逐字符指回原始 Text 节点与偏移。
interface Flat {
  text: string;
  map: { node: Text; offset: number }[];
}

// 遍历 root 下所有文本节点并拼接为归一化字符串，同时维护字符到节点的映射。
// 不同文本块之间补一个空格，避免跨块的词被误拼；行内空白则折叠。
/** The text under `root`, lower-cased with whitespace collapsed, mapped back to (node, offset). */
function flatten(root: Node): Flat {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let text = "";
  const map: { node: Text; offset: number }[] = [];
  let lastSpace = true;
  for (const node of nodes) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (/\s/.test(char)) {
        if (lastSpace) continue;
        text += " ";
        lastSpace = true;
      } else {
        text += char.toLowerCase();
        lastSpace = false;
      }
      map.push({ node, offset: i });
    }
    // Separate text nodes from different blocks (e.g. pdf.js spans without trailing spaces).
    if (!lastSpace) {
      text += " ";
      lastSpace = true;
      map.push({ node, offset: value.length });
    }
  }
  return { text, map };
}

// 把扁平文本区间映射回 DOM Range；结束偏移 +1 以包含末字符，并对节点长度做钳制。
function toRange(flat: Flat, span: [number, number]): Range {
  const start = flat.map[span[0]];
  const end = flat.map[Math.min(flat.map.length - 1, span[1])];
  const range = document.createRange();
  range.setStart(start.node, Math.min(start.node.data.length, start.offset));
  range.setEnd(end.node, Math.min(end.node.data.length, end.offset + 1));
  return range;
}

// 在 root 内查找 quote：先做精确匹配，失败再退化为忽略空白的模糊匹配（应对 pdf.js 分 span）。
// quote 归一化后为空返回 null；未找到同样返回 null，调用方应视为“无法高亮”而非错误。
// 使用 TreeWalker 逐文本节点匹配，返回首个命中区间；不抛错，也不会为失败创建标记。
/**
 * Find `quote` in the text of `root` (whitespace- and case-insensitive) and return a DOM Range.
 */
export function findTextRange(root: Node, quote: string): Range | null {
  const needle = normalise(quote);
  if (!needle) return null;
  const flat = flatten(root);
  const exact = flat.text.indexOf(needle);
  const span: [number, number] | null =
    exact >= 0 ? [exact, exact + needle.length - 1] : fuzzy(flat.text, needle);
  return span ? toRange(flat, span) : null;
}

// 匹配互不重叠：每次从上一命中末尾继续搜索，因此 "aa" 在 "aaa" 中只算一次；limit 非正数时返回空数组。
// 列出 root 内 query 的所有命中（按文档顺序，最多 limit 个）；空 query 返回空数组。
// 返回的 Range 可能共享文本节点但互不覆盖；limit 用于防止超大文档产生过多高亮。
/** Every occurrence of `query` under `root`, in document order (at most `limit`). */
export function findAllRanges(root: Node, query: string, limit = 1000): Range[] {
  const needle = normalise(query);
  if (!needle) return [];
  const flat = flatten(root);
  const ranges: Range[] = [];
  for (
    let at = flat.text.indexOf(needle);
    at >= 0 && ranges.length < limit;
    at = flat.text.indexOf(needle, at + needle.length)
  )
    ranges.push(toRange(flat, [at, at + needle.length - 1]));
  return ranges;
}

// 不做 findTextRange 的忽略空格退让：仅折叠空白后按字面量查找，其余字符按原样比较。
// 按与 findAllRanges 相同的规则（大小写与空白不敏感）统计纯文本中的命中数；空 query 返回 0。
// 仅用于计数，不返回位置；非重叠匹配，因此重复模式按正则 exec 的推进方式计算。
/** Count occurrences of `query` in plain text the same way `findAllRanges` matches the DOM. */
export function countMatches(text: string, query: string): number {
  const needle = normalise(query);
  if (!needle) return 0;
  const haystack = normalise(text);
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count++;
  return count;
}

// Range 的容器只要有一个脱离文档即视为失效；零宽或零高（如隐藏元素）同样返回 null。
// 取目标在屏幕上的包围盒；目标为空、已脱离文档或宽高为 0 时返回 null。
// 坐标为视口坐标系（非文档坐标），滚动后需重新调用；不修改任何节点。
/** On-screen box of a range or element; null when it is detached or has no size. */
export function boxOf(target: Range | Element | null | undefined): DOMRect | null {
  if (!target) return null;
  if (target instanceof Element && !target.isConnected) return null;
  if (target instanceof Range && !target.startContainer.isConnected) return null;
  const rect = target.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

// slack 同时向外扩展四条边，落在边界像素上算命中；目标为空或没有任何行盒时返回 false。
// 判断客户端坐标是否落在目标任一行盒内，slack 提供几像素容差；已脱离文档的目标直接为 false。
// 多行 Range 逐行判断，命中任意一行即返回 true；纯几何判断，不读文本内容。
/** Whether a client point falls on the boxes of a range or element (with a little slack). */
export function pointOn(
  target: Range | Element | null | undefined,
  x: number,
  y: number,
  slack = 2,
): boolean {
  if (!target) return false;
  if (target instanceof Element ? !target.isConnected : !target.startContainer.isConnected)
    return false;
  for (const rect of target.getClientRects())
    if (
      x >= rect.left - slack &&
      x <= rect.right + slack &&
      y >= rect.top - slack &&
      y <= rect.bottom + slack
    )
      return true;
  return false;
}

// 返回新建 DOMRect（非任一输入引用）；只读取 left/top/right/bottom，输入框的 width/height 不参与计算。
// 合并多个包围盒；忽略 null，全部缺失时返回 null（表示无可滚动目标）。
// 结果是紧包所有输入的最小矩形，可能包含空白区域；输入顺序不影响结果。
/** Union of boxes, ignoring missing ones. */
export function unionBox(boxes: (DOMRect | null)[]): DOMRect | null {
  const present = boxes.filter((box): box is DOMRect => Boolean(box));
  if (!present.length) return null;
  const left = Math.min(...present.map((box) => box.left));
  const top = Math.min(...present.map((box) => box.top));
  const right = Math.max(...present.map((box) => box.right));
  const bottom = Math.max(...present.map((box) => box.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

// 完全忽略空格的模糊匹配：pdf.js 常把单词拆成多个 span，归一化后仍可能匹配失败。
// 返回在原始 flat 文本中的 [start, end]；无命中返回 null。
/** Match ignoring spaces entirely (pdf.js often splits words into spans). Returns [start, end] in `flat`. */
function fuzzy(flat: string, needle: string): [number, number] | null {
  const compactNeedle = needle.replace(/ /g, "");
  const positions: number[] = [];
  let compact = "";
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === " ") continue;
    compact += flat[i];
    positions.push(i);
  }
  const at = compactNeedle ? compact.indexOf(compactNeedle) : -1;
  return at < 0 ? null : [positions[at], positions[at + compactNeedle.length - 1]];
}

// CSS Custom Highlight API 的类型与访问器；宿主旧版浏览器不支持时返回 null。
type HighlightRegistry = Map<string, unknown>;
const registry = (): HighlightRegistry | null =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;

// 用 CSS Custom Highlight API 以 name 绘制高亮，不修改 DOM；ranges 为空时清除该名称的高亮。
// 运行环境不支持 Highlight 时静默跳过，高亮失效但不影响渲染。
// 同名高亮会被整组替换，调用方负责区分 find/reveal 等不同名称，避免互相清除。
/** Paint ranges with the CSS Custom Highlight API under `name` (no DOM mutation). */
export function paintRanges(name: string, ranges: Range[]) {
  const highlights = registry();
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (!highlights || !HighlightCtor) return;
  if (ranges.length) highlights.set(name, new HighlightCtor(...ranges));
  else highlights.delete(name);
}

// 滚动最近的 .viewer-scroll 容器使 element 可见；找不到容器则不滚动。
// 不使用 scrollIntoView：它会连锁滚动祖先与应用外壳，把工具栏挤出视野。
/**
 * Scroll the viewer's own scroll container so `element` is visible. Never use scrollIntoView: it
 * also scrolls every ancestor (the app shell and the host frames), which pushes the toolbar away.
 */
export function scrollToElement(element: Element, block: "start" | "center" | "upper" = "center") {
  const container = element.closest<HTMLElement>(".viewer-scroll");
  if (container) scrollToBox(container, element.getBoundingClientRect(), block);
}

// 容器取 range 起点所在元素的最近 .viewer-scroll，跨容器的 Range 只滚动起点一侧；平滑滚动可能触发 scroll 监听。
// 滚动包含 range 的 viewer 容器；默认 upper 让目标位于视口上方 30% 处，符合揭示习惯。
// range 已脱离文档或找不到 .viewer-scroll 时不滚动，也不回退到 window；纯副作用，无返回值。
/** Scroll the viewer that contains `range` so it sits 30% from the top ("upper"), as reveals do. */
export function scrollToRange(range: Range, block: "start" | "center" | "upper" = "upper") {
  const container = range.startContainer.parentElement?.closest<HTMLElement>(".viewer-scroll");
  if (container) scrollToBox(container, range.getBoundingClientRect(), block);
}

// 计算滚动位置：垂直方向按 block 对齐并至少留 12px 边距，水平方向仅在目标越界时调整。
// 最终位置钳制为非负，平滑滚动以免长文档跳转过于突兀。
function scrollToBox(container: HTMLElement, rect: DOMRect, block: "start" | "center" | "upper") {
  const box = container.getBoundingClientRect();
  let top = container.scrollTop + rect.top - box.top;
  top -=
    block === "center"
      ? Math.max(12, (box.height - rect.height) / 2)
      : block === "upper"
        ? Math.max(12, box.height * 0.3)
        : 12;
  let left = container.scrollLeft;
  if (rect.right > box.right || rect.left < box.left) left += rect.left - box.left - 12;
  container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior: "smooth" });
}

// 监听容器滚动与尺寸变化，回调当前子项的 key：优先取探针线（顶部起 probe 比例处）覆盖的子项，
// 否则取视口内最靠上的子项。滚动事件经 requestAnimationFrame 合并，返回解绑函数。
// key 返回 null 的子项不参与回调；同一 key 连续出现不会重复通知。
/**
 * Watch which child of `container` is current; calls back with its key. The current child is the
 * one under the probe line (`probe` × the view height from the top, e.g. 1/3 for pages), else the
 * topmost one in view.
 */
export function trackTopmost(
  container: HTMLElement,
  items: () => Iterable<HTMLElement>,
  key: (element: HTMLElement) => string | null,
  onChange: (key: string) => void,
  probe = 0,
): () => void {
  // last 记录上一次通知的 key，避免重复回调；frame 用于合并同一帧内的多次事件。
  let last: string | null = null;
  let frame = 0;
  const check = () => {
    frame = 0;
    const top = container.getBoundingClientRect().top;
    const line = top + container.clientHeight * probe;
    let best: HTMLElement | null = null;
    let bestDistance = Infinity;
    for (const element of items()) {
      const rect = element.getBoundingClientRect();
      if (probe && rect.top <= line && rect.bottom >= line) {
        best = element;
        break;
      }
      if (rect.bottom < top + 8) continue;
      const distance = Math.abs(rect.top - top);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
      if (rect.top > top + container.clientHeight) break;
    }
    const next = best ? key(best) : null;
    if (next && next !== last) {
      last = next;
      onChange(next);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  container.addEventListener("scroll", schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  schedule();
  return () => {
    container.removeEventListener("scroll", schedule);
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
