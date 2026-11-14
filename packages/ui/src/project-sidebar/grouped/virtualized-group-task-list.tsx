// INV-01 虚拟化阈值只认「任务数严格大于 80」，守住 shouldVirtualizeGroupedTasks 里的比较符与常量。改错故障：改成 >= 或调低阈值会让小组也走绝对定位路径，首帧只有估算高度，内容区短暂空白。
// INV-02 非虚拟化时必须整表渲染全部任务且保持原数组顺序。守住位置：shouldVirtualize 为 false 时的早返回分支。改错故障：漏掉该分支会返回空容器，阈值以内的分组整组消失。
// INV-03 useVirtualizer 的 count 必须跟随 shouldVirtualize，非虚拟时传 0。守住位置：count 表达式。改错故障：恒传任务数会让隐藏的虚拟层继续测量，留下无主测量元素并让行定位错乱。
// INV-04 scrollElement 只能来自 DOM 逐级反查，不得写死某个父节点。守住位置：updateScrollMargin 内对 findNearestScrollableAncestor 结果的写入。改错故障：分组展开或折叠时滚动容器会换，虚拟列表挂到错误容器，滚动事件失效。
// INV-05 scrollMargin 必须按列表元素与滚动容器的当前几何实时重算，并含 scrollTop。守住位置：resolveScrollMargin 与 updateScrollMargin 的写回。改错故障：用缓存值会让 translateY 偏移累计，越往下滚行越漂。
// INV-06 找不到滚动祖先时必须让 scrollElement 为 null 且 scrollMargin 归零。守住位置：updateScrollMargin 的早返回。改错故障：保留上一轮差值会让虚拟行按错误原点绘制，整组整体上移或下移。
// INV-07 getScrollElement 必须返回 state 里的节点，不能在渲染期现查 DOM。守住位置：useVirtualizer 的 getScrollElement 回调。改错故障：绕过 effect 的订阅时机后，滚动监听绑到过期节点，滚动不再触发重渲染。
// INV-08 initialOffset 必须传回调，让求值发生在挂载之后。守住位置：initialOffset 传 resolveInitialScrollOffset 而不是数字。改错故障：传常量 0 会让中段重新挂载的分组被拉回顶部，原注释描述的 scrollTo 归零问题复现。
// INV-09 滚动写入必须统一走 scrollGroupedTaskVirtualizerToOffset。守住位置：useVirtualizer 的 scrollToFn 参数。改错故障：换回默认实现会让分组内列表与顶层列表的滚动语义分叉，出现滚动跳变。
// INV-10 行 key 必须由 taskKey 派生，禁止使用数组下标。守住位置：getItemKey 回调。改错故障：下标作 key 在任务排序或移动分组后复用错误行，选中态与拖拽态会串到别的任务上。
// INV-11 getItemKey 里的占位对象只用于越界兜底，不得当作真实任务。守住位置：tasks 取下标后的空值合并。改错故障：去掉兜底会在列表缩短的瞬间抛错；把占位对象当数据则渲染出幽灵行。
// INV-12 renderTask 的依赖数组必须覆盖全部透传 props。守住位置：renderTask 的 useCallback 依赖列表。改错故障：漏依赖会让行保留旧回调，点击、归档、重命名命中过期闭包。
// INV-13 每个虚拟行都必须挂 measureElement 并带 data-index。守住位置：行容器的 ref 与 data-index 属性。改错故障：漏挂测量会一直沿用 32px 估算，48px 的运行行与相邻行重叠。
// INV-14 行的 translateY 必须减去 scrollMargin。守住位置：行内联 transform。改错故障：不做减法会让虚拟坐标以整个滚动容器为原点，所有行恒定偏移一个 scrollMargin。
// INV-15 容器高度必须取虚拟器总高度，并禁用滚动锚点。守住位置：外层容器 style。改错故障：高度写死会让滚动条长度失真；恢复锚点选择会让测量回写把 scrollTop 拉回顶部。
// INV-16 resize 监听、rAF 与 ResizeObserver 必须在同一个清理函数里释放。守住位置：useLayoutEffect 返回的 cleanup。改错故障：漏清理会累积监听与观察器，卸载后仍写 state，产生警告和内存泄漏。
// INV-17 effect 依赖必须包含 groupId、shouldVirtualize、tasks.length。守住位置：useLayoutEffect 依赖数组。改错故障：切换分组或跨越阈值时不重算，scrollMargin 停在上一组，行位置错乱。
// INV-18 两个常量与判定函数是对外契约，文件末尾导出块不可随意增删。守住位置：export 块。改错故障：改名或改数值会静默改变上层列表的虚拟化行为，并让既有引用与断言失配。
//
// 模块职责：在分组任务列表里按阈值切换整表渲染与窗口化渲染，并在挂载期把滚动容器、scrollMargin、行高测量三件事对齐。
// 状态所有权：scrollElement 与 scrollMargin 只是 DOM 几何的本地镜像，任务、分组、选中态、拖拽态全部由 props 传入，本组件不持有第二份业务状态。
// 阅读顺序：先看常量与 shouldVirtualizeGroupedTasks，再看两个几何函数，最后看 useVirtualizer 参数、effect 清理与非虚拟早返回。
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/project-sidebar/grouped/virtualized-scroll.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/types.js";

// `GROUPED_TASK_ROW_ESTIMATE_PX` 等三个常量共同定义虚拟化策略，调用点不得写魔法数字。
// 估算行高 32px 只是首帧初值，真实高度由 measureElement 量回，调大它只影响首屏占位。
// 阈值 80 是「不值得虚拟化」的分界：低于该值整表渲染更便宜，也避免小列表出现测量抖动。
// overscan 12 决定窗口外预挂载的行数：给小了快速滚动会露白，给大了等于放弃虚拟化收益。
const GROUPED_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TASK_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TASK_VIRTUALIZATION_OVERSCAN = 12;

// 对外只承诺「任务数严格大于阈值才虚拟化」，比较符必须保持大于号。
// 改成大于等于会让恰好 80 条的分组也进入虚拟路径，滚动条长度先短后长，视觉上跳一下。
// 该函数被导出且可能被上层直接调用，保持无副作用、只依赖入参，不要在这里读 DOM 或全局状态。
function shouldVirtualizeGroupedTasks(taskCount: number): boolean {
  return taskCount > GROUPED_TASK_VIRTUALIZATION_THRESHOLD;
}

// 必须逐级向上走到文档根部，而不是只看直接父节点：分组外层可能套了多层布局容器。
// 是否可滚动只认 overflowY，并统一交给 isPotentialVerticalScrollContainer 判定，避免各处标准漂移。
// 每层都要读计算样式，属于强制样式计算：只在挂载、resize 与分组切换时执行，不要放进滚动回调。
// 返回 null 是合法失败路径，调用方必须按「暂无滚动容器」降级，而不是把最近的 div 硬当滚动容器。
function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // group 展开动画刚开始时，祖先容器可能还没被内容撑到 scrollHeight > clientHeight。
      // 如果因此返回 null，react-virtual 会短暂没有 scrollElement，表现成内容区有高度但行不渲染。
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

// 返回值是列表顶边相对滚动内容原点的距离，必须把 scrollTop 加回去抵消当前滚动。
// 少加 scrollTop 会让偏移随滚动线性漂移，表现为越往下滚行越靠上。
// 计算只依赖包围盒与 scrollTop，不读 offsetTop：后者受定位上下文影响，嵌套容器里不可靠。
function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

// 本组件是纯受控视图：任务、分组、选中态、拖拽态全部由 props 传入，内部只维护滚动几何。
// 所有 on 前缀回调原样透传给 GroupedTaskItem，组件既不缓存也不改写它们的语义。
// tooltipsDisabled 与 mobileActiveTaskKey 是两端的差异开关，不要合并成单一标志。
// 不要在组件内按 groupId 过滤任务：分组归属由父级算好，这里再过滤就会出现两份真相。
export function VirtualizedGroupedTaskList({
  tasks,
  groupId,
  groups,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  activeDragTaskKey,
  tooltipsDisabled,
}: {
  tasks: ZCodeTaskMeta[];
  groupId: string;
  groups: TaskGroupMenuItem[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  activeDragTaskKey?: string | null;
  tooltipsDisabled?: boolean;
}) {
  // listRef 只用于量取几何，不作为渲染门控：首帧渲染早于 effect 赋值，拿到 null 必须安全跳过。
  // scrollElement 用 state 而不是 ref，是为了让虚拟器在容器变化后重新订阅滚动事件。
  // scrollMargin 与 scrollElement 必须由同一次测量成对写入，否则会出现容器已换、偏移仍是旧值的中间帧。
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTasks(tasks.length);
  const getItemKey = useCallback(
    (index: number) => taskKey(tasks[index] ?? { workspacePath: "", taskId: String(index) }),
    [tasks],
  );

  // 这是全部几何写入的唯一入口，新增第二个入口就会让容器与偏移不同步。
  // 列表节点尚未挂载时直接返回，不写 state，避免卸载阶段的无意义更新与告警。
  // 找不到滚动祖先时先把偏移清零再返回，防止上一轮的数值残留到新容器。
  // 必须先写 scrollElement 再算偏移：偏移计算依赖新容器，顺序颠倒会按旧容器算出脏值。
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

  // 非虚拟化分支只做状态复位并返回 undefined，保证不留下任何订阅。
  // ResizeObserver 跟容器尺寸、rAF 补首帧、window resize 跟窗口缩放，三者缺一都会出现偏移不刷新。
  // 清理函数必须同时取消 rAF、移除 resize 监听并断开观察器，否则重挂载后旧回调继续写 state。
  // 依赖必须带上 groupId 与任务数量：分组切换、数量跨越阈值时都要重新量一次。
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
  }, [groupId, shouldVirtualize, tasks.length, updateScrollMargin]);

  // count 必须与 shouldVirtualize 联动：非虚拟时传 0，避免虚拟层继续测量不存在的行。
  // getScrollElement 返回 state 里的节点，不要在回调里现查 DOM，否则订阅对象与测量对象可能不是同一个。
  // scrollToFn 统一走 scrollGroupedTaskVirtualizerToOffset，保证与顶层列表的滚动写入语义一致。
  // overscan 与 scrollMargin 都在这里接入，删掉任一项会让窗口边缘行消失或整体偏移。
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => GROUPED_TASK_ROW_ESTIMATE_PX,
    getItemKey,
    overscan: GROUPED_TASK_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // group 内虚拟列表会和顶层列表共用左侧滚动容器。
    // 当 group 行在中段滚动时重新挂载，react-virtual 默认 initialOffset=0
    // 会在 _willUpdate 里 scrollTo(0)。这里从 DOM 现场反查真实 scrollTop，
    // 避免首个 layout effect 里 scrollElement state 尚未写回时提前缓存 0。
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const measureElement = rowVirtualizer.measureElement;

  const renderTask = useCallback(
    (task: ZCodeTaskMeta) => (
      <GroupedTaskItem
        key={taskKey(task)}
        task={task}
        groupId={groupId}
        groups={groups}
        remoteSessionId={getTaskRemoteSessionId(task)}
        workspaceLabel={getTaskWorkspaceLabel(task)}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        mobileActiveTaskKey={mobileActiveTaskKey}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={taskKey(task)}
        dragging={activeDragTaskKey === taskKey(task)}
        tooltipsDisabled={tooltipsDisabled}
      />
    ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupId,
      groups,
      mobileActiveTaskKey,
      onArchiveTask,
      onCloseTask,
      onMarkTaskAsUnread,
      onMoveTaskToGroup,
      onMoveTaskToTop,
      onOpenFileTree,
      onSelectTask,
      onStartRenameTask,
      activeDragTaskKey,
      tooltipsDisabled,
    ],
  );

  const renderedVirtualTasks = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const task = tasks[virtualRow.index];
        if (!task) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            // 行高不再恒定：挂着工作流运行行的会话是 48px 而不是 28px。估算值只作初值，
            // 真实高度由 measureElement 量回，否则相邻行会叠在一起。
            ref={measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderTask(task)}
          </div>
        );
      }),
    [measureElement, renderTask, scrollMargin, tasks, virtualRows],
  );

  // 非虚拟分支直接按原数组顺序返回全部行，key 仍由 taskKey 提供，保证与虚拟分支行为一致。
  // 这条早返回必须排在 useVirtualizer 之后：hooks 不能条件调用，提前返回会破坏调用顺序。
  // 任务量在阈值附近抖动时会在两条路径间切换，所以两边的 key 生成方式必须相同，避免行被重建。
  if (!shouldVirtualize) {
    return <>{tasks.map((task) => renderTask(task))}</>;
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
      {/* Bugfix: 大 group 以前一次渲染所有 task 行，2000 条会制造数万 DOM 节点并拖高
          JS/布局 CPU。这里只挂载滚动窗口内的行，保持点击和菜单操作可用。 */}
      {/* Bugfix: group 内虚拟行会在滚动时不断挂载/卸载，浏览器滚动锚点可能误把
          这些绝对定位行当成稳定锚点，测量回写时就可能把 scrollTop 拉回顶部。
          禁用虚拟列表子树的锚点选择，避免和 react-virtual 的定位计算打架。 */}
      {renderedVirtualTasks}
    </div>
  );
}

// 对外只暴露估算行高、阈值、判定函数三项，overscan 属于内部实现细节，不要顺手导出。
// 常量与判定函数必须成对导出：上层按阈值做布局预留时读到的值要和这里一致。
// 重命名或改数值属于破坏性变更，会同时影响测试断言与上层列表，改动前先查引用。
export {
  GROUPED_TASK_ROW_ESTIMATE_PX,
  GROUPED_TASK_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTasks,
};
