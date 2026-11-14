// INV-01 渲染只在字节变化时重跑：守住位置 首个副作用依赖；改错故障 无关重渲反复替换 DOM。
// INV-02 渲染前必须清空正文与样式容器：守住位置 replaceChildren；改错故障 旧文档与新文档叠加。
// INV-03 卸载后不得再调用回调：守住位置 active 标记；改错故障 已卸载组件的回调被触发。
// INV-04 渲染失败只走 onError：守住位置 catch；改错故障 非法文档让整页白屏。
// INV-05 项目符号修复只改样式文本：守住位置 fixSymbolBullets；改错故障 正文文本被意外替换。
// INV-06 未知私用区字形统一退化为圆点：守住位置 映射回退；改错故障 列表出现豆腐块。
// INV-07 表格行只取直属本表的行：守住位置 rowsOf；改错故障 嵌套表行列号与服务端错位。
// INV-08 缩放基准必须避免零尺寸除零：守住位置 scale 计算；改错故障 首帧得到 NaN 比例。
// INV-09 适配模式与手动百分比共用同一比例：守住位置 zoom 分支；改错故障 百分比切换后跳回适配。
// INV-10 缩放变化要保持视口中心：守住位置 useLayoutEffect；改错故障 每次缩放跳回左上角。
// INV-11 比例未变或首次布局时不得滚动：守住位置 before 判断；改错故障 首帧无故滚动。
// INV-12 三层高亮必须按固定顺序重绘：守住位置 paint；改错故障 当前查找命中被 Agent 标记盖住。
// INV-13 挂载期监听必须在卸载时逐个解绑：守住位置 清理函数；改错故障 多文档切换后监听累积。
// INV-14 选区跨段时合并为区间锚点：守住位置 p 区间判断；改错故障 只上报起始段，丢失选择范围。
// INV-15 鼠标抬起必须延迟读取选区：守住位置 deferred；改错故障 拖选结束瞬间读到旧选区。
// INV-16 显式锚点找不到时截图必须报错：守住位置 capture 的抛错；改错故障 静默截到错误页面。
// INV-17 定位目标找不到时静默跳过，不中断其余目标：守住位置 reveal 的 continue；改错故障 一个坏锚点让整批定位失败。
// INV-18 命令式句柄只读 ref，不额外依赖 props：守住位置 空依赖数组；改错故障 句柄重建导致调用方持有旧实例。
//
// 模块职责：把 docx 字节渲染为分页 DOM，并提供定位、高亮、查找、缩放、截图与选择能力。
// 状态所有权：DOM 由 docx-preview 生成并归本组件；缩放与尺寸状态在本地，文档数据来自 props。
// 阅读顺序：先看锚点映射与项目符号修复，再读渲染副作用，最后看事件接线与命令式句柄。
// docx 查看器：用 docx-preview 把字节渲染成分页 DOM，再按服务端块锚点打 data-at 标记。
// 边界：渲染与定位全在本地完成，不联网；对外副作用只经 props 回调，不持久化状态。
// 失败语义：渲染失败走 onError；查找/定位找不到目标时静默跳过，不让整页失败。
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { renderAsync } from "docx-preview";
import { parseLocator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";
import {
  boxOf,
  findAllRanges,
  pointOn,
  findTextRange,
  installLinkGuard,
  paintRanges,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
  unionBox,
} from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import { alignBlocks } from "#ui/viewers/align.ts";
import {
  nextZoom,
  type FitMode,
  type RevealedTarget,
  type ViewerHandle,
  type ViewerProps,
} from "#ui/viewers/types.ts";

// docx-preview 生成的 section/article 类名；渲染后据此划分页与定位块。
const CLASS = "office-docx";

// 锚点到渲染元素的映射：段落支持 p:N–p:M 区间，表格支持整表或单格 t:N/rRcC；
// 找不到时返回空数组（调用方把空结果当作“该目标不存在”并跳过），不抛错。
/** Block element for a locator: `p:N` / `t:N` map to rendered elements, `t:N/rRcC` to a cell. */
// elementsFor 先用 parseLocator("docx", at) 判 kind：paragraph 展开 from..to 的 [data-at="p:N"]，table 无 cell 直接返回 [data-at="t:N"]，有 cell 取 rowsOf(table)[row-1]?.cells[col-1]，越界回退整表；locator 不匹配或找不到时返回 []，由 reveal 当目标不存在跳过而不是抛错。
function elementsFor(root: HTMLElement, at: string): HTMLElement[] {
  const locator = parseLocator("docx", at);
  if (locator.kind !== "docx") return [];
  if (locator.type === "paragraph") {
    const out: HTMLElement[] = [];
    for (let n = locator.from; n <= locator.to; n++)
      out.push(...root.querySelectorAll<HTMLElement>(`[data-at="p:${n}"]`));
    return out;
  }
  const tables = [...root.querySelectorAll<HTMLElement>(`[data-at="t:${locator.table}"]`)];
  if (!locator.cell) return tables;
  for (const table of tables) {
    const cell = rowsOf(table)[locator.cell.row - 1]?.cells[locator.cell.col - 1];
    if (cell) return [cell as HTMLElement];
  }
  return tables;
}

/**
 * Word list bullets use private-use glyphs of the Symbol / Wingdings fonts, which the sandbox does
 * not have; map the common ones to Unicode bullets in docx-preview's generated numbering CSS.
 */
// Word 列表项目符号使用 Symbol/Wingdings 的私用区字形（U+F0xx），沙箱没有这些字体；
// 常见符号映射到等价 Unicode，未知私用字形统一退化为圆点，保证列表不出现豆腐块。
const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: "\u2022",
  0xf0a7: "\u25aa",
  0xf06f: "\u25e6",
  0xf0a8: "\u25cb",
  0xf0d8: "\u27a2",
  0xf0e0: "\u27a2",
  0xf0fc: "\u2713",
  0xf076: "\u2756",
};
// 只改 docx-preview 生成的 <style> 文本（编号/符号定义），不动正文文本节点；
// 没有私用区字符时保持原字符串，避免无意义的重写。
// fixSymbolBullets 用 /[\uf020-\uf0ff]/g 匹配私用区字形，按 SYMBOL_BULLETS 映射，未知字形回退 "\u2022"；next === text 时不写 style.textContent。
function fixSymbolBullets(styles: HTMLElement) {
  for (const style of styles.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const next = text.replace(
      /[\uf020-\uf0ff]/g,
      (char) => SYMBOL_BULLETS[char.charCodeAt(0)] ?? "\u2022",
    );
    if (next !== text) style.textContent = next;
  }
}

// 只取直属本表的行：docx 表格可嵌套，row.closest("table") 能过滤掉内层表的行，保证行列号与服务端一致。
// rowsOf 从 (table as HTMLTableElement).rows 出发，用 row.closest("table") === table 过滤掉嵌套表的行，返回顺序与 alignBlocks/服务端行列号一致；少这层过滤会让内层表的行被算进外层表。
function rowsOf(table: HTMLElement): HTMLTableRowElement[] {
  return [...(table as HTMLTableElement).rows].filter((row) => row.closest("table") === table);
}

// 画布内边距（像素）：实际可用宽度 = 容器宽 - 2×PADDING，需与 CSS 的 .docx-scroll 保持一致。
/** Canvas padding (CSS keeps .docx-scroll in step). */
const PADDING = 16;

// docx 查看器：用 docx-preview 渲染字节为分页 DOM，再按服务端块锚点打 data-at 标签，
// 从而支持 reveal/goTo/capture/find/选择。渲染完全在本地完成，不联网。
// 副作用：写 bodyRef/styleRef 的 DOM；通过回调上报页数/缩放/位置/选择/错误。
// 失败语义：渲染失败走 onError；定位目标找不到时静默跳过，不让整页失败。
// 维护不变量：data-at 与 alignBlocks 的结果一一对应；reveal 与 find 的高亮互斥（由外部保证）。
// DocxView 用 scrollRef/bodyRef/styleRef 分别持有滚动容器、正文与样式容器；zoom 的 mode 为 null 表示手动 percent，natural 只在渲染后量一次；callbacks.current 每帧赋 props 防止闭包过期，ViewerHandle 经 forwardRef 暴露给 Shell。
export const DocxView = forwardRef<ViewerHandle, ViewerProps>(function DocxView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  // zoom.mode 为 null 表示手动百分比（percent 生效）；mode 非空时 percent 只是展示值。
  const [zoom, setZoom] = useState<{ mode: FitMode | null; percent: number }>({
    mode: "width",
    percent: 100,
  });
  /** Natural (unzoomed) page size, measured once after rendering. */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);

  // 缩放基准：natural 是未缩放的单页尺寸（渲染后量一次），box 是滚动容器可视尺寸；
  // 两者缺失时 scale 保持 1，避免首帧用 0 尺寸算出 NaN。
  const scale = (() => {
    if (!natural || !box.width) return 1;
    const fitWidth = Math.min(2, (box.width - PADDING * 2) / natural.width);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page")
      return Math.min(fitWidth, (box.height - PADDING * 2) / natural.height);
    if (zoom.mode === "actual") return 1;
    return zoom.percent / 100;
  })();
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const previousScale = useRef(scale);
  /** The agent's marks: painted quote ranges, and per target what a click on it hits. */
  const reveal = useRef<{ ranges: Range[]; hits: (Range | HTMLElement[])[] }>({
    ranges: [],
    hits: [],
  });
  const find = useRef<{ ranges: Range[]; current: number } | null>(null);

  // 页的枚举口径：正文里 class 为 office-docx 的 section 按 DOM 顺序排列，下标 0 即第 1 页。
  // 每次调用都重新查询（渲染是异步替换的），不在闭包里缓存列表。
  const sections = () => [
    ...(bodyRef.current?.querySelectorAll<HTMLElement>(`section.${CLASS}`) ?? []),
  ];

  // 渲染只在字节变化时重跑：先清空容器（避免旧 DOM 残留）再调 docx-preview；
  // 完成后修项目符号、打 data-at 标签、量首屏自然尺寸、上报页数与 ready。
  // active 标志防止卸载后仍调用回调（React 不再关心已卸载组件的 setState）。
  // 失败（非法 docx/加密文档）只走 onError，不清空已加载的其他状态（Shell 负责展示）。
  useEffect(() => {
    let active = true;
    const body = bodyRef.current!;
    const styles = styleRef.current!;
    body.replaceChildren();
    styles.replaceChildren();
    // renderAsync 的选项固定 breakPages/renderHeaders/renderFooters/renderFootnotes 为 true，renderComments 与 renderChanges 为 false，避免只读视图出现批注修订痕迹；then 里先 fixSymbolBullets(styles) 再 annotate(body)，页数取 Math.max(1, sections().length) 防止空文档显示 0/0。
    renderAsync(props.bytes, body, styles, {
      className: CLASS,
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
      renderAltChunks: false,
      useBase64URL: true,
    })
      .then(() => {
        if (!active) return;
        fixSymbolBullets(styles);
        annotate(body);
        const page = sections()[0];
        // 用渲染后的实际矩形反推 1 倍尺寸（除回当前 scale），这样缩放基准不受首次适配影响。
        if (page) {
          const current = scaleRef.current || 1;
          const rect = page.getBoundingClientRect();
          setNatural({ width: rect.width / current, height: rect.height / current });
        }
        // 页数至少为 1，避免空文档让分页控件出现 0/0。
        callbacks.current.onPage?.({ current: 1, count: Math.max(1, sections().length) });
        callbacks.current.onReady();
      })
      // 组件已卸载（active=false）时错误无人消费，直接忽略。
      .catch((error) => active && callbacks.current.onError(error));
    return () => {
      active = false;
    };
  }, [props.bytes]);

  // 服务端块锚点与渲染元素的映射：只给能对上的元素写 data-at，对不上就不写（后续 reveal 会跳过）。
  // 依赖 docx-preview 的固定结构（section > article > p/h1-6/table），升级该库时需同步检查。
  /** Tag rendered body elements with their locators (data-at). */
  // annotate 只遍历 section.${CLASS} > article：P 与 /^H[1-6]$/ 作为块级锚点，TABLE 整体入列且内部单元格不再展开，保证与 alignBlocks 粒度一致；keys[i] 存在时才写 element.dataset.at，对不上的元素留给 reveal 跳过。
  function annotate(body: HTMLElement) {
    const elements: HTMLElement[] = [];
    for (const article of body.querySelectorAll<HTMLElement>(`section.${CLASS} > article`)) {
      const walk = (parent: Element) => {
        for (const child of parent.children) {
          const tag = child.tagName;
          // 表格当整体处理（锚点 t:N），其内部单元格不再单独进入 elements，保证与 alignBlocks 的粒度一致。
          if (tag === "P" || /^H[1-6]$/.test(tag)) elements.push(child as HTMLElement);
          else if (tag === "TABLE") elements.push(child as HTMLElement);
          else if (!["HEADER", "FOOTER", "OL", "UL"].includes(tag) || child.children.length)
            walk(child);
        }
      };
      walk(article);
    }
    const keys = alignBlocks(
      elements.map((element) => ({
        text: element.textContent ?? "",
        table: element.tagName === "TABLE",
      })),
      callbacks.current.blocks ?? [],
    );
    elements.forEach((element, i) => {
      if (keys[i]) element.dataset.at = keys[i]!;
    });
  }

  // 缩放变化时保持视口中心不动：按新旧比例换算滚动位置（先扣掉内边距再缩放再加回），
  // 否则每次放大/缩小都会“跳”回到左上角，阅读位置丢失。
  // Report zoom; keep the centre of the view in place when it changes.
  // useLayoutEffect 先把 previousScale.current 更新为当前 scale 再判断：scroll 为空、before 为 0（首次布局）或 before === scale 时直接 return；否则按 ratio = scale / before 换算 scrollLeft/scrollTop，并扣减再加回 PADDING 以保持视口中心不动。
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const before = previousScale.current;
    previousScale.current = scale;
    if (natural) callbacks.current.onZoom?.({ mode: zoom.mode, percent: Math.round(scale * 100) });
    // 容器未挂载、首次布局（before=0）或比例未变时无需重排，直接返回。
    if (!scroll || !before || before === scale) return;
    const ratio = scale / before;
    const x = scroll.clientWidth / 2;
    const y = scroll.clientHeight / 2;
    scroll.scrollTo({
      left: Math.max(0, (scroll.scrollLeft + x - PADDING) * ratio + PADDING - x),
      top: Math.max(0, (scroll.scrollTop + y - PADDING) * ratio + PADDING - y),
    });
  }, [scale, natural, zoom.mode]);

  // 三层高亮互斥叠加：Agent 标记为底层，查找其余命中其次，当前查找命中在最上层，
  // 保证“当前一处”永远可见且不被其它高亮盖住。
  function paint() {
    paintRanges("office-reveal", reveal.current.ranges);
    const state = find.current;
    const current = state ? state.ranges[state.current] : undefined;
    paintRanges("office-find", state ? state.ranges.filter((range) => range !== current) : []);
    paintRanges("office-find-current", current ? [current] : []);
  }

  // 挂载期一次性接线：尺寸观察、链接拦截、位置/页码跟踪、选择处理。
  // 全部依赖 ref + callbacks，因此空依赖数组即可，不会因 props 变化重复注册。
  // 卸载时逐个解绑，避免滚动/点击监听在多文档切换后累积。
  useEffect(() => {
    const scroll = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      // 仅当尺寸变化超过 1px 才更新：过滤亚像素抖动与滚动条出现带来的 1px 循环重排。
      setBox((previous) =>
        Math.abs(previous.width - scroll.clientWidth) > 1 ||
        Math.abs(previous.height - scroll.clientHeight) > 1
          ? { width: scroll.clientWidth, height: scroll.clientHeight }
          : previous,
      ),
    );
    resize.observe(scroll);
    // 外部链接交给宿主打开（不离开面板）；文档内 #hash 走文档内锚点滚动，找不到则交回默认行为。
    const unguard = installLinkGuard(
      bodyRef.current!,
      (url) => callbacks.current.onLink(url),
      (hash) => {
        const target = bodyRef.current!.querySelector(
          `[id="${CSS.escape(hash)}"], a[name="${CSS.escape(hash)}"]`,
        );
        if (target) scrollToElement(target, "start");
        return Boolean(target);
      },
    );
    const untrack = trackTopmost(
      scroll,
      () => scroll.querySelectorAll<HTMLElement>("[data-at]"),
      (element) => element.dataset.at ?? null,
      (at) => callbacks.current.onLocation(at),
    );
    // 页码跟踪用 1/3 偏置：一行只需滚过三分之一就算“当前页”，比中线判定更符合阅读直觉。
    const untrackPages = trackTopmost(
      scroll,
      sections,
      (element) => String(sections().indexOf(element) + 1),
      (page) =>
        callbacks.current.onPage?.({
          current: Number(page),
          count: Math.max(1, sections().length),
        }),
      1 / 3,
    );
    const clearOutline = () =>
      scroll
        .querySelectorAll(".office-selected")
        .forEach((element) => element.classList.remove("office-selected"));
    const select = (event: Event) => {
      const selected = selectionIn(bodyRef.current!);
      if (selected) {
        const start =
          selected.range.startContainer.parentElement?.closest<HTMLElement>("[data-at]")?.dataset
            .at;
        const end =
          selected.range.endContainer.parentElement?.closest<HTMLElement>("[data-at]")?.dataset.at;
        if (!start) return;
        let at = start;
        const a = /^p:(\d+)$/.exec(start);
        const b = end && /^p:(\d+)$/.exec(end);
        if (a && b && Number(b[1]) > Number(a[1])) at = `p:${a[1]}-${b[1]}`;
        clearOutline();
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "click") return;
      // A click on one of the agent's marks brings its note back instead of selecting.
      const { clientX, clientY } = event as MouseEvent;
      const hit = reveal.current.hits.findIndex((mark) =>
        Array.isArray(mark)
          ? mark.some((element) => pointOn(element, clientX, clientY))
          : pointOn(mark, clientX, clientY),
      );
      if (hit >= 0 && callbacks.current.onRevealHit?.(hit)) {
        clearOutline();
        callbacks.current.onSelect(null);
        return;
      }
      const target = event.target as Element;
      if (target.closest("a[href]")) return;
      const cell = target.closest("td, th");
      const block = target.closest<HTMLElement>("[data-at]");
      clearOutline();
      if (!block?.dataset.at) {
        callbacks.current.onSelect(null);
        return;
      }
      let at = block.dataset.at;
      let text = block.textContent ?? "";
      // 表格内点击细化为单元格锚点 t:N/rRcC（行列从 1 起），让模型拿到更精确的位置。
      if (cell && block.tagName === "TABLE") {
        const rows = rowsOf(block);
        const row = rows.findIndex((item) => item.contains(cell));
        const col = row >= 0 ? [...rows[row].cells].indexOf(cell as HTMLTableCellElement) : -1;
        if (row >= 0 && col >= 0) {
          at = `${block.dataset.at}/r${row + 1}c${col + 1}`;
          text = cell.textContent ?? "";
        }
      }
      const outlined = (cell && at.includes("/r") ? cell : block) as HTMLElement;
      outlined.classList.add("office-selected");
      callbacks.current.onSelect(
        { at, text: cut(text.replace(/\s+/g, " ").trim(), 0, 2000) },
        { text: false, locate: () => boxOf(outlined), user: true },
      );
    };
    // 延迟到下一轮任务再处理 mouseup：拖选结束时浏览器尚未稳定选区，立即读取可能拿到旧值。
    const deferred = (event: Event) => setTimeout(() => select(event), 0);
    scroll.addEventListener("mouseup", deferred);
    scroll.addEventListener("click", select);
    return () => {
      resize.disconnect();
      unguard();
      untrack();
      untrackPages();
      scroll.removeEventListener("mouseup", deferred);
      scroll.removeEventListener("click", select);
    };
  }, []);

  // 命令式句柄：Shell 通过它定位、清除标记、截图、缩放、查找与选择，避免把查看器内部状态暴露给 React。
  // 方法都返回 Promise 或 void，失败只抛给直接调用方（capture 会抛，其余静默跳过）。
  // 句柄只创建一次，内部通过 ref 读取最新 DOM 与比例，所以空依赖数组是安全的。
  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      // 定位多个目标：先清旧标记，再逐个找 anchor 与 quote 范围；有 quote 用高亮范围，否则给整块加类。
      // 返回每个成功目标的位置与滚动函数，顺序与输入一致（找不到的不会出现在结果里）。
      // 副作用：只改本地高亮类与 ref，不修改正文文本；不负责滚动（由调用方决定是否滚第一处）。
      async reveal(targets) {
        this.clearReveal();
        const body = bodyRef.current!;
        const results: RevealedTarget[] = [];
        for (const target of targets) {
          const elements = elementsFor(body, target.at);
          // 锚点对不上渲染结构时跳过该目标，不中断其余目标（结果数量可能少于请求数）。
          if (!elements.length) continue;
          let range: Range | null = null;
          if (target.quote)
            for (const element of elements) {
              range = findTextRange(element, target.quote);
              if (range) break;
            }
          if (range) reveal.current.ranges.push(range);
          else for (const element of elements) element.classList.add("office-revealed");
          reveal.current.hits.push(range ?? elements);
          const found = range;
          results.push({
            at: target.at,
            locate: () =>
              found ? boxOf(found) : unionBox(elements.map((element) => boxOf(element))),
            scrollTo: () =>
              found ? scrollToRange(found, "upper") : scrollToElement(elements[0], "upper"),
          });
        }
        paint();
        // 只自动滚到第一处；其余目标以标记形式呈现，交给“下一处”交互，避免连续滚屏。
        results[0]?.scrollTo();
        return results;
      },
      // 跳转到块锚点；锚点不存在或元素未渲染时静默无效（例如内容已被截断）。
      goTo(at) {
        const element = elementsFor(bodyRef.current!, at)[0];
        if (element) scrollToElement(element, "start");
      },
      // 清除所有 Agent 标记：范围高亮与整块 class 同时清理，再重绘查找层（避免互相覆盖）。
      clearReveal() {
        reveal.current = { ranges: [], hits: [] };
        bodyRef.current
          ?.querySelectorAll(".office-revealed")
          .forEach((element) => element.classList.remove("office-revealed"));
        paint();
      },
      // 截图：有锚点就截其所在页（并返回该锚点作为 at）；无锚点则取当前视口下方第一页。
      // 返回 at 恒非空（无锚点时用 "page N" 字符串），便于模型理解截的是哪一页。
      // 失败抛错：锚点找不到（文档结构与请求不符）或尚未渲染任何页。
      async capture(at, maxWidth) {
        const body = bodyRef.current!;
        const scroll = scrollRef.current!;
        let anchor: HTMLElement | null = at ? (elementsFor(body, at)[0] ?? null) : null;
        // 显式请求了锚点却找不到，说明请求与当前渲染不同步；这里必须报错，不能退回可视区截图。
        if (at && !anchor) throw new Error(`Cannot find ${at} in the rendered document.`);
        let page: HTMLElement | null = anchor?.closest<HTMLElement>(`section.${CLASS}`) ?? null;
        // 无锚点时取首个“下边缘越过视口顶部 8px”的页，即用户正在看的那一页（容差避免边界页两可）。
        if (!page) {
          const top = scroll.getBoundingClientRect().top;
          page =
            sections().find((section) => section.getBoundingClientRect().bottom > top + 8) ?? null;
        }
        if (!page) throw new Error("Nothing is rendered yet.");
        // 没有锚点时用页内第一个块做 at 标签；页内没有块则退回 "page N" 文案。
        anchor ??= page.querySelector<HTMLElement>("[data-at]");
        const raster = await rasterize(page, { maxWidth, context: body, background: "#fff" });
        return { ...raster, at: anchor?.dataset.at ?? `page ${sections().indexOf(page) + 1}` };
      },
      // 手动缩放：mode 置空表示不再跟随适配，percent 由 nextZoom 夹到允许区间。
      zoom(direction) {
        setZoom({ mode: null, percent: nextZoom(Math.round(scaleRef.current * 100), direction) });
      },
      // 切回适配模式（width/page/actual）：percent 复位为 100，实际比例由 scale 计算。
      fit(mode) {
        setZoom({ mode, percent: 100 });
      },
      // 查找：空查询直接清空（返回 0）；有命中时 current 置 -1，等 findGo 决定第一处。
      // 只返回数量，高亮交给 paint；不滚动（滚动由 Shell 在得到数量后触发）。
      async find(query) {
        const ranges = query.trim() ? findAllRanges(bodyRef.current!, query) : [];
        find.current = ranges.length ? { ranges, current: -1 } : null;
        paint();
        return ranges.length;
      },
      // 切到第 index 处命中；越界或未查找时静默返回，不改变当前高亮。
      findGo(index) {
        const state = find.current;
        if (!state?.ranges[index]) return;
        state.current = index;
        paint();
        scrollToRange(state.ranges[index], "center");
      },
      // 关闭查找：丢掉全部命中并重绘，Agent 标记不受影响。
      clearFind() {
        find.current = null;
        paint();
      },
      // 清除选择态：先摘掉块/单元格的高亮类，再仅当选区确实落在文档内时才清空浏览器选区，
      // 避免误清用户在其他输入框里的选区。
      clearSelection() {
        scrollRef.current
          ?.querySelectorAll(".office-selected")
          .forEach((element) => element.classList.remove("office-selected"));
        if (bodyRef.current && selectionIn(bodyRef.current))
          document.getSelection()?.removeAllRanges();
      },
      // 跳页：页码从 1 起，越界时夹到 [1, 页数]；页列表可能为空（渲染中），此时静默无效。
      goToPage(page) {
        const all = sections();
        const target = all[Math.min(Math.max(1, page), all.length) - 1];
        if (target) scrollToElement(target, "start");
      },
    }),
    [],
  );

  return (
    <div ref={scrollRef} className={`viewer-scroll docx-scroll${glance ? " glance" : ""}`}>
      <div ref={styleRef} />
      <div className="docx-zoom" style={{ zoom: scale }}>
        <div ref={bodyRef} />
      </div>
    </div>
  );
});
