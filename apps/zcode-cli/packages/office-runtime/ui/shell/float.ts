// 浮层定位 Hook：按锚点元素与容器可视区计算 top/bottom 位置，空间不足时自动换边。
// 边界：只读布局（getBoundingClientRect）并写内联 left/top；不持有业务状态。
// 副作用：监听 resize/scroll 重算，卸载时移除监听；dock 模式下无锚点则停靠容器顶部居中。
import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Locate } from "#ui/viewers/types.ts";

// 元素与容器边缘的最小间距（像素），与 ZCode popover 的 collision padding 一致。
const EDGE = 8;

// 浮层定位参数：side 只是偏好，实际方向由可用空间决定；offset 缺省 8px；
// dock 为 true 时，无锚点则退化为容器顶部居中（不隐藏），用于操作条这类常驻浮层。
export interface FloatOptions {
  /** Preferred side of the anchor; flips when there is no room. */
  side: "top" | "bottom";
  /** Gap between anchor and element (ZCode's popover uses 8). */
  offset?: number;
  /** With no anchor box, sit at the top centre of the frame instead of hiding. */
  dock?: boolean;
}

// 定位语义：每帧读取锚点与容器矩形，直接写 element.style，不触发 React 重渲染；
// 锚点为 null 时按 dock 决定隐藏或顶部居中；锚点完全离开容器可视区时隐藏（同 Radix 行为）。
// 输入 locate 为惰性函数（可能为 null），options 只提供偏好；返回值是 element ref，由调用方挂载。
// 输出：元素获得 data-side（top/bottom/none）与 --tip（箭头相对左侧的像素位置，至少离边 14px）。
// 副作用：监听 scroll/resize，并每 250ms 兜底重算；卸载时全部解除。
// 失败语义：frame/element 未挂载时直接不工作（不抛错），因此调用方需保证 ref 稳定。
/**
 * Keep an absolutely positioned element next to an anchor inside `frame` while the document
 * scrolls, like ZCode's Radix popovers (collision padding 8, hidden when the anchor leaves view).
 * Positions are written straight to the element every frame, so scrolling never re-renders React.
 * The element gets `data-side` ("top" | "bottom" | "none") and `--tip` for its arrow.
 */
export function useFloating<T extends HTMLElement>(
  frame: RefObject<HTMLElement | null>,
  locate: Locate | null | undefined,
  options: FloatOptions,
) {
  const ref = useRef<T>(null);
  const { side, offset = 8, dock = false } = options;
  useLayoutEffect(() => {
    const element = ref.current;
    const container = frame.current;
    if (!element || !container) return;
    let frameId = 0;
    // 一帧内多次 scroll/resize 只排一次计算：rAF 句柄非 0 时不再重复申请。
    const place = () => {
      frameId = 0;
      const bounds = container.getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const box = locate?.() ?? null;
      const show = (left: number, top: number, placed: string, centre: number) => {
        element.style.visibility = "";
        element.style.left = `${Math.round(left)}px`;
        element.style.top = `${Math.round(top)}px`;
        element.dataset.side = placed;
        element.style.setProperty(
          "--tip",
          `${Math.round(Math.max(14, Math.min(width - 14, centre - left)))}px`,
        );
      };
      if (!box) {
        // 无锚点（未定位或目标已卸载）：dock 时常驻顶部居中，否则隐藏，不能留在旧坐标上。
        if (dock) show((bounds.width - width) / 2, EDGE, "none", bounds.width / 2);
        else element.style.visibility = "hidden";
        return;
      }
      // 锚点完全离开可视区就隐藏；4px 容差避免滚动到边界像素时反复闪烁。
      if (box.bottom < bounds.top + 4 || box.top > bounds.bottom - 4) {
        element.style.visibility = "hidden";
        return;
      }
      // centre 是相对容器的锚点中心，用于居中与箭头定位；left 夹在两侧 EDGE 内，防止被裁切。
      const centre = (box.left + box.right) / 2 - bounds.left;
      const left = Math.max(EDGE, Math.min(bounds.width - width - EDGE, centre - width / 2));
      const above = box.top - bounds.top - height - offset;
      const below = box.bottom - bounds.top + offset;
      const fitsAbove = above >= EDGE;
      const fitsBelow = below + height <= bounds.height - EDGE;
      // 先按偏好侧判断；放不下则翻转；两侧都放不下（锚点比视口还高）时贴最近的可视边并标记 none。
      if (side === "top" ? fitsAbove : !fitsBelow && fitsAbove) show(left, above, "top", centre);
      else if (fitsBelow) show(left, below, "bottom", centre);
      // A tall anchor (a whole page): pin to the visible edge nearest the preferred side.
      else show(left, side === "top" ? EDGE : bounds.height - height - EDGE, "none", centre);
    };
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(place);
    };
    place();
    container.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(container);
    resize.observe(element);
    // Rendering (fonts, lazy pages, zoom) can move the anchor without a scroll.
    // 250ms 兜底轮询覆盖“锚点移动但不产生 scroll 事件”的情况（字体加载、懒加载页面、缩放）。
    const settle = setInterval(schedule, 250);
    return () => {
      container.removeEventListener("scroll", schedule, { capture: true });
      resize.disconnect();
      clearInterval(settle);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [frame, locate, side, offset, dock]);
  return ref;
}
