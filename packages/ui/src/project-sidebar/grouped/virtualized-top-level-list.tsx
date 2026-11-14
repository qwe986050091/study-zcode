// INV-01 未超阈值不启用虚拟化：守住位置 shouldVirtualizeGroupedTopLevelNodes；改错故障 小列表多一层绝对定位。
// INV-02 阈值固定八十：守住位置 虚拟化阈值常量；改错故障 滚动切换点随数据漂移。
// INV-03 任务行估算三十二像素：守住位置 任务行常量；改错故障 滚动高度持续跳动。
// INV-04 分组头估算四十像素：守住位置 分组头常量；改错故障 折叠后出现大块空白。
// INV-05 展开分组按封顶任务数估算：守住位置 Math.min；改错故障 超大分组撑爆滚动高度。
// INV-06 缺失节点给出稳定键：守住位置 getTopLevelNodeKey 首支；改错故障 复用错误行状态。
// INV-07 分组与任务键前缀不同：守住位置 三元拼接；改错故障 分组与任务键冲突。
// INV-08 只认当前已可滚祖先：守住位置 isPotentialVerticalScrollContainer；改错故障 过渡帧丢失滚动元素。
// INV-09 找不到滚动容器回退零边距：守住位置 setScrollMargin(0)；改错故障 列表整体偏移。
// INV-10 边距含列表相对位置：守住位置 resolveScrollMargin；改错故障 虚拟行与真实行错位。
// INV-11 布局副作用在绘制前完成：守住位置 useLayoutEffect；改错故障 首帧位置闪烁。
// INV-12 容器尺寸变化重新测量：守住位置 ResizeObserver；改错故障 折叠后高度不更新。
// INV-13 窗口尺寸变化也重测：守住位置 resize 监听；改错故障 缩放窗口后行错位。
// INV-14 副作用全部可清理：守住位置 返回的清理函数；改错故障 监听与观察器泄漏。
// INV-15 初始偏移从 DOM 反查：守住位置 resolveInitialScrollOffset；改错故障 首次绑定即回顶。
// INV-16 共享滚动器用自定义位移：守住位置 scrollToFn；改错故障 与外层滚动竞争。
// INV-17 虚拟行只渲染窗口附近：守住位置 renderedVirtualNodes；改错故障 两千行全量挂载。
// INV-18 禁用子树滚动锚点：守住位置 overflowAnchor 注释；改错故障 滚动中突然回顶。
//
// 模块职责：VirtualizedGroupedTopLevelList 的分组任务视图顶层节点轻量虚拟化。
// 状态所有权：滚动元素与边距为本组件局部状态；节点数据由外部传入。
// 阅读顺序：先看阈值与估算，再读滚动容器探测，最后看虚拟器与渲染。
import type { ZCodeGroupedTaskViewNode } from "@/project-sidebar/grouped/types.js";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/project-sidebar/grouped/virtualized-scroll.js";

const GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX = 40;
// GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD = 80（INV-02）：节点数超过它才走虚拟化，小于等于八十仍直接 map（INV-01）；
// 它同时是 shouldVirtualizeGroupedTopLevelNodes 与渲染分支的判据，改大或改小会让列表在滚动到临界点时换实现，
// 这种换实现会让总高度与行复用状态在临界点错乱（INV-02）。
const GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTopLevelNodes(nodeCount: number): boolean {
  return nodeCount > GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD;
}

function getTopLevelNodeKey(node: ZCodeGroupedTaskViewNode | undefined, index: number): string {
  if (!node) {
    return `missing:${index}`;
  }
  return node.type === "group" ? `group:${node.group.id}` : `task:${taskKey(node.task)}`;
}

// estimateTopLevelNodeSize 按节点形态给估算高度（INV-03/04/05）：task 与缺失节点用 GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX，
// 折叠分组只算 GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX；展开分组按 Math.min(node.tasks.length, 24) 封顶，超限会撑大总高度。
// 漏掉封顶会让超大分组把滚动高度撑爆，折叠后残留大块空白。
function estimateTopLevelNodeSize(
  node: ZCodeGroupedTaskViewNode | undefined,
  isGroupCollapsed: (groupId: string) => boolean,
): number {
  if (!node || node.type === "task") {
    return GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX;
  }
  if (isGroupCollapsed(node.group.id)) {
    return GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX;
  }
  return (
    GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX +
    Math.min(node.tasks.length, 24) * GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX
  );
}

// findNearestScrollableAncestor 从 parentElement 逐级向上，用 isPotentialVerticalScrollContainer 判定 overflowY（INV-08）：
// 只认当前已可滚的祖先，过渡帧里会错过刚变可滚的容器，使 virtualizer 丢 scrollElement、展开后只剩头部有状态；
// 找不到时返回 null，由调用方 setScrollMargin(0) 回退（INV-09）。
function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // 折叠/展开时顶层行高度会先变、滚动高度后变；只认“当前已可滚”
      // 会让虚拟器在过渡帧丢失 scrollElement，展开后出现 header 有状态但内容空白。
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

// VirtualizedGroupedTopLevelList 用 listRef 探测滚动容器、用 shouldVirtualize 决定是否计数（INV-01/17）：
// getItemKey 走 getTopLevelNodeKey（INV-06/07）；estimateSize 走 estimateTopLevelNodeSize 并按节点缓存变化。
// scrollMargin 由 updateScrollMargin 随布局重算（INV-10）；initialOffset 必须从 DOM 反查（INV-15）。
function VirtualizedGroupedTopLevelList({
  nodes,
  isGroupCollapsed,
  renderNode,
}: {
  nodes: ZCodeGroupedTaskViewNode[];
  isGroupCollapsed: (groupId: string) => boolean;
  renderNode: (node: ZCodeGroupedTaskViewNode, index: number) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTopLevelNodes(nodes.length);
  const getItemKey = useCallback(
    (index: number) => getTopLevelNodeKey(nodes[index], index),
    [nodes],
  );
  const estimateSize = useCallback(
    (index: number) => estimateTopLevelNodeSize(nodes[index], isGroupCollapsed),
    [isGroupCollapsed, nodes],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [nodes.length, shouldVirtualize, updateScrollMargin]);

  // rowVirtualizer 的 count 在未启用时传 0，等价关闭虚拟化；getScrollElement 允许先返回 null 等绑定；
  // scrollToFn 固定为 scrollGroupedTaskVirtualizerToOffset（INV-16），避免与外层滚动竞争；
  // initialOffset 取 resolveInitialScrollOffset（INV-15），默认为 0 会让首次绑定立即回顶。
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? nodes.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey,
    overscan: GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // 虚拟器可能在共享滚动容器已经滚动后重新绑定 scrollElement。
    // react-virtual 默认 initialOffset 是 0，初次绑定时会主动 scrollTo(0)，
    // 造成左侧任务列表滚动中偶发回顶；这里从 DOM 现场反查真实 scrollTop，
    // 避免首个 layout effect 里 scrollElement state 尚未写回时提前缓存 0。
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  const renderedVirtualNodes = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const node = nodes[virtualRow.index];
        if (!node) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            data-index={virtualRow.index}
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderNode(node, virtualRow.index)}
          </div>
        );
      }),
    [nodes, renderNode, rowVirtualizer.measureElement, scrollMargin, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{nodes.map((node, index) => renderNode(node, index))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* 非 group 顶层 task 也可能有 2000+ 条；以前只虚拟化 group 内任务，
          顶层 view.nodes 仍一次性挂载全部行。这里保留 dnd-kit 的真实 index，
          但只渲染滚动窗口附近节点，降低初次渲染和滚动 CPU。 */}
      {/* 虚拟行会在滚动中频繁挂载/卸载，Chrome 的 scroll anchoring 偶尔会
          把这些绝对定位节点选为锚点并反向修正 scrollTop，表现成列表突然回顶。
          这里禁用虚拟列表子树的锚点选择，滚动位置只由用户滚轮和虚拟器控制。 */}
      {renderedVirtualNodes}
    </div>
  );
}

export {
  GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD,
  VirtualizedGroupedTopLevelList,
  shouldVirtualizeGroupedTopLevelNodes,
};
