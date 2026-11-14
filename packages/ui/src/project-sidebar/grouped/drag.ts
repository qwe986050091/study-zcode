// drag.ts —— 分组任务视图的拖拽支撑层：碰撞过滤、落点预览变换、布局快照与补间动画。
// 做：解析 dnd-kit 附加数据里的拖拽种类与标识；按种类过滤候选落点；把落点事件翻译成
//     视图变换；采集布局矩形；解析吸附分组；用前后快照播放重排动画。
// 不做：不渲染任何 UI、不管理拖拽状态、不写持久化，也不决定任务最终归属。
// 依赖：dnd-kit 的碰撞检测与事件类型；分组视图目录下的视图变换与标识工具。
// 被调用：分组任务视图的拖拽容器与行组件；所有导出都是纯函数或纯 DOM 测量。
// 边界：本文件只回答「拖到哪里、看起来如何」，真正的数据写入由调用方在放置结束时执行。
//
// INV-01 断言：只有分组拖拽允许以组间落点为候选 —— 守住它的位置：碰撞检测的活动类型分支 —— 改错故障：任务落到组间落点时触发错误的顶级重排。
// INV-02 断言：任务拖拽必须排除组间落点 —— 守住它的位置：过滤条件里的类型比较 —— 改错故障：任务松手后位置回弹，看起来像拖拽失效。
// INV-03 断言：碰撞检测只过滤候选，不重写排序 —— 守住它的位置：最近中心算法的调用 —— 改错故障：自研排序会让落点在快速移动时跳变。
// INV-04 断言：所有标识解析先判对象再断言 —— 守住它的位置：五个解析器开头的类型判断 —— 改错故障：对空数据取属性直接抛错，拖拽中断。
// INV-05 断言：标识解析失败返回空值而不是抛错 —— 守住它的位置：各解析器的兜底返回 —— 改错故障：一次脏数据让整个列表无法拖动。
// INV-06 断言：类型标记字符串与写入侧逐字一致 —— 守住它的位置：各解析器里的字面量比较 —— 改错故障：改名后所有落点被识别为无效，拖拽毫无反应。
// INV-07 断言：拖到自身必须短路 —— 守住它的位置：预览函数里的标识相等判断 —— 改错故障：拖到自己身上触发无意义重排，列表抖动。
// INV-08 断言：不满足条件时必须返回原视图引用 —— 守住它的位置：各预览函数的提前返回 —— 改错故障：返回新对象会让上层每帧都认为结构变化。
// INV-09 断言：组头前置表示插到组外上方 —— 守住它的位置：组头预览的前置分支 —— 改错故障：分组永远无法被拖到另一个组上方。
// INV-10 断言：组头后置表示插到组首 —— 守住它的位置：组头预览的默认分支 —— 改错故障：任务落到组外，用户以为没放进组里。
// INV-11 断言：组脚前置表示插到组尾 —— 守住它的位置：组脚预览的前置分支 —— 改错故障：拖到组底却插到组首。
// INV-12 断言：组脚后置表示落到组外下方 —— 守住它的位置：组脚预览的默认分支 —— 改错故障：无法把任务移出到组的下方。
// INV-13 断言：分组拖拽只做顶级重排 —— 守住它的位置：两个分组预览函数的变换调用 —— 改错故障：分组被塞进另一个组，数据模型被破坏。
// INV-14 断言：视图签名必须包含组成员 —— 守住它的位置：组节点分支的成员键拼接 —— 改错故障：组内重排后签名不变，界面不刷新。
// INV-15 断言：布局快照必须区分节点种类前缀 —— 守住它的位置：两套前缀不同的映射键 —— 改错故障：同名键互相覆盖，补间起点错位。
// INV-16 断言：快照必须记录高度 —— 守住它的位置：矩形采集里的高度字段 —— 改错故障：展开与收起没有补间，尺寸瞬间跳变。
// INV-17 断言：预览宽度查找前必须编码任务键 —— 守住它的位置：宽度测量函数里的编码 —— 改错故障：含特殊字符的键永远测不到宽度。
// INV-18 断言：吸附分组必须跳过折叠组 —— 守住它的位置：吸附解析里的折叠判断 —— 改错故障：折叠组头部被误吸附，悬浮标题错位。
// INV-19 断言：补间前必须取消节点上已有动画 —— 守住它的位置：动画列表的取消循环 —— 改错故障：新旧动画叠加，重排时元素明显跳动。
// INV-20 断言：动画结束与取消都必须恢复溢出样式 —— 守住它的位置：两个事件监听回调 —— 改错故障：快速连续重排后元素永久裁剪，内容被截断。
//
// 阅读顺序：先看五个标识解析器，再看碰撞过滤，然后是各组预览变换，最后是布局快照与动画。
// 常见误改：碰撞过滤条件写反、组头与组脚的方向语义互换、动画只在完成时恢复样式。
// 与外部的关系：导出的常量与函数签名被拖拽容器直接依赖，改动属于跨文件契约变更。
// 测试关注点：任务与分组各自的落点集合、同键自移动短路、编码后的宽度测量。
// 性能边界：快照与补间都是线性于节点数，只在放置瞬间执行，不在拖拽帧内运行。
// 样式边界：动画只改位移与高度，不触碰颜色与描边，避免与主题样式抢控制权。
// 可访问性：键盘拖拽依赖拖拽库的播报能力，本文件不提供替代交互。
// 边界情形：根节点为空、找不到滚动容器、节点上没有布局键，都必须安全返回。
// 维护提示：新增拖拽种类时，解析器、碰撞过滤、预览分派三处必须同时补齐。
// 调试建议：先打印活动与目标两侧的附加数据，再确认落点类型落在预期分支。
// 安全边界：只读取 DOM 属性与尺寸，不解析用户文本，不拼接 HTML。
// 恢复自分组删除前的碰撞、落点与动画实现；不包含旧数据服务。
import {
  closestCenter,
  type CollisionDetection,
  type DragOverEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import type { ZCodeGroupedTaskView } from "@/project-sidebar/grouped/types.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  moveGroupAroundTopLevelNode,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
} from "@/project-sidebar/grouped/view.js";
// [契约] 只向上寻找真正可滚动的 ancestor：overflow 为 auto/scroll 且内容超出。
// 只检查纵向溢出，是因为分组列表的滚动方向固定，横向滚动不属于本视图。
// [边界] 找不到时返回空值，调用方必须自行处理没有滚动容器的情况。
// [权衡] 逐层读取计算样式而不是调用滚动到可视区，保证后续吸附计算拿到真实容器。
// [失败路径] 判断内容溢出必须比较内容高度与可视高度，否则会选中只是声明了样式但不可滚动的节点。
export function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const canScrollY =
      /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (canScrollY) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

// [契约] 只有类型标记为分组任务且键为字符串时才返回，其他情况一律返回空值。
// 先判对象再断言，避免对空值取属性直接抛错。
// [边界] 该函数只做识别，不做合法性校验，键是否存在于视图中由预览函数判断。
// [权衡] 返回空值而不是抛错，让拖拽事件在数据不完整时自然退化。
// 类型字符串是对外契约，与写入侧的附加数据必须逐字一致。
export function getGroupedTaskDragTaskKey(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; taskKey?: unknown };
  return data.type === "grouped-task" && typeof data.taskKey === "string" ? data.taskKey : null;
}

// [契约] 分组拖拽的标识解析与任务解析同构，只是类型标记不同。
// 两者不能合并成一个通用解析器，否则误把任务标识当分组标识会拖动错误对象。
// [边界] 只认字符串标识，数字或对象一律视为无效。
// [权衡] 重复的四行判断换来每个解析器的类型收窄，比抽象更可读。
// 若新增拖拽种类，应新增解析器而不是放宽这里的类型判断。
export function getGroupedTaskDragGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group" && typeof data.groupId === "string" ? data.groupId : null;
}

// [契约] 只取类型标记本身，用于碰撞检测区分活动对象的种类。
// 返回空值表示数据缺失，调用方据此走默认分支。
// [边界] 这里不校验类型是否属于已知集合，未知类型由下游忽略。
// [权衡] 保持极简，避免解析器之间互相依赖形成环。
// 新增类型时必须同步碰撞过滤与预览分派两处。
export function getGroupedTaskDragType(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown };
  return typeof data.type === "string" ? data.type : null;
}

export function getGroupedGroupOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group-over" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

// [契约] 折叠组、组头、组脚、空投放区各有独立类型标记，必须分别解析。
// 合并成一个解析器会让不同落点走错预览分支，视觉与最终结果不一致。
// [边界] 标识为空字符串时同样视为无效。
// [权衡] 四个函数形状相同是刻意的冗余，便于逐个演进而不互相牵连。
// 改动任一标记都要同步投放侧的附加数据写入。
export function getGroupedTaskCollapsedOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-collapsed-group" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskHeaderOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-header" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskFooterOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-footer" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskEmptyOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-empty-drop-zone" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

// [契约] 落点方向只有前置与后置两种，足以覆盖所有插入语义。
// 方向与落点类型的组合决定调用哪个视图变换函数。
// [边界] 不存在中间插入，组内位置由组首与组尾两个特殊落点表达。
// [权衡] 不用数值索引，避免视图重排后索引失效。
// 新增方向会成倍放大分支组合，非必要不扩展。
export type GroupedTaskDragDirectionPosition = "before" | "after";

// [契约] collisionDetection 只负责筛选候选容器，排序仍交给 closestCenter。
// 拖动分组时只允许任务与组间落点参与，避免分组落到自身或其他组的折叠区。
// [边界] 拖动任务时排除组间落点，任务只能落到任务、组头、组脚或空投放区。
// [权衡] 在 collisionDetection 里过滤而非重写排序，复用成熟算法，行为更可预期。
// [失败路径] 过滤条件写反会让任务无法落到任何组内，表现为拖拽无响应。
export const groupedTaskCollisionDetection: CollisionDetection = (args) => {
  // [契约] 活动对象的类型来自其附加数据，是分派碰撞策略的唯一依据。
  // 附加数据结构由拖拽侧写入，两端必须保持一致。
  // [边界] 类型缺失时走任务分支，这是更常见的默认路径。
  // [权衡] 不在渲染期缓存类型，拖拽数据每帧变化，缓存反而增加同步成本。
  // 新增拖拽种类必须在此处补分支，否则会误用任务策略。
  const activeType = getGroupedTaskDragType(args.active.data.current);
  const droppableContainers =
    activeType === "grouped-group"
      ? args.droppableContainers.filter((container) => {
          const type = getGroupedTaskDragType(container.data.current);
          return type === "grouped-task" || type === "grouped-group-over";
        })
      : args.droppableContainers.filter(
          (container) => getGroupedTaskDragType(container.data.current) !== "grouped-group-over",
        );
  return closestCenter({
    ...args,
    droppableContainers,
  });
};

// [契约] 任务覆盖任务时按方向把活动任务插到目标前后。
// 缺少任一标识或两者相同都直接返回原视图，保证引用不变。
// [并发] 拖动过程中同一帧可能重复调用，纯函数保证结果幂等。
// [边界] 这里不改分组归属，仅在同一层级内重排。
// [权衡] 返回原视图而不是深拷贝，让上层可以用引用比较跳过重渲染。
export function getGroupedTaskOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeTaskKey || !overTaskKey || activeTaskKey === overTaskKey) {
    return view;
  }
  return moveTaskOverTask(view, {
    activeTaskKey,
    overTaskKey,
    position,
  });
}

export function getGroupedTaskOverCollapsedGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskCollapsedOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position,
  });
}

// [契约] 组头落点的方向有不同语义：前置表示插到组外上方，后置表示插到组首。
// 两种语义分别调用根级插入与组首插入，不能统一成组内插入。
// [边界] 只处理已展开组的头部，折叠组由折叠落点负责。
// [权衡] 用两个分支表达而不是加布尔参数，调用点更易读。
// [失败路径] 前置也走组内插入会让组永远无法被拖到另一个组的上方。
export function getGroupedTaskOverGroupHeaderPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskHeaderOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToRootAroundGroup(view, {
      activeTaskKey,
      groupId: overGroupId,
      position: "before",
    });
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

// [契约] 组脚落点的方向语义与组头相反：前置进组尾，后置落到组外下方。
// 该对称关系是整个拖拽模型的约定，两处必须成对检查。
// [边界] 组脚只存在于展开组，折叠组不渲染。
// [权衡] 不合并组头与组脚函数，避免方向语义互相污染。
// [失败路径] 两个方向写反会让用户把任务拖到组底时却插到组首。
export function getGroupedTaskOverGroupFooterPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskFooterOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToGroupEnd(view, {
      activeTaskKey,
      groupId: overGroupId,
    });
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position: "after",
  });
}

export function getGroupedTaskOverEmptyDropZonePreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
): ZCodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskEmptyOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

// [契约] 分组拖到分组上时走顶级节点重排，不进入任何组内部。
// 活动组与目标组相同则直接返回原视图，避免自引用移动。
// [边界] 分组拖到任务上同样走顶级重排，任务只作为参照锚点。
// [权衡] group 不支持嵌套，因此这里不存在组内插入分支。
// 标识解析失败时返回原视图，保证拖拽数据异常不会破坏布局。
export function getGroupedGroupOverGroupPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overGroupId = getGroupedGroupOverGroupId(event.over?.data.current);
  if (!activeGroupId || !overGroupId || activeGroupId === overGroupId) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "group", groupId: overGroupId },
    position,
  });
}

export function getGroupedGroupOverTaskPreviewView(
  view: ZCodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ZCodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeGroupId || !overTaskKey) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "task", taskKey: overTaskKey },
    position,
  });
}

// [契约] 签名把视图压成字符串，用于快速判断结构是否变化。
// 任务节点用前缀加键，组节点用前缀加组标识加成员键列表，保证不同类型不碰撞。
// [边界] 签名只覆盖结构与顺序，不覆盖标题等展示字段。
// [权衡] 用字符串而不是深度比较，实现简单且可直接作为缓存键。
// [失败路径] 漏掉组成员会让组内重排不触发更新。
export function getGroupedTaskViewSignature(view: ZCodeGroupedTaskView): string {
  return view.nodes
    .map((node) =>
      node.type === "task"
        ? `t:${taskKey(node.task)}`
        : `g:${node.group.id}[${node.tasks.map(taskKey).join(",")}]`,
    )
    .join("|");
}

type GroupedTaskLayoutRects = Map<
  string,
  {
    height: number;
    left: number;
    top: number;
  }
>;

// [契约] 落点动画时长与缓动固定，保证整个列表的收尾节奏一致。
// 数值偏短是为了让重排尽快结束，避免遮住用户的下一次操作。
// [边界] GROUPED_TASK_DROP_ANIMATION 只描述放置回弹，不参与布局补间。
// [权衡] duration 不随距离动态调整，行为可预期优先。
// 改 GROUPED_TASK_DROP_ANIMATION.duration 会同时影响所有分组视图，属于全局视觉决策。
export const GROUPED_TASK_DROP_ANIMATION: DropAnimation = {
  duration: 150,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};
export const GROUPED_TASK_AUTO_SCROLL_THRESHOLD = {
  x: 0.1,
  y: 0.1,
} as const;

// [契约] 一次遍历采集布局容器与任务行的位置快照，供后续补间使用。
// 布局节点与任务行使用不同前缀，避免同名键互相覆盖。
// [边界] 根节点为空时返回空映射，调用方据此跳过动画。
// [权衡] 只测量 height/left/top 三个量，width 对纵向重排没有意义。
// [失败路径] 缺少高度会让展开与收起的补间变成瞬变。
export function collectGroupedTaskLayoutRects(root: HTMLElement | null): GroupedTaskLayoutRects {
  const rects: GroupedTaskLayoutRects = new Map();
  if (!root) {
    return rects;
  }
  root.querySelectorAll<HTMLElement>("[data-grouped-layout-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-layout-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`layout:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  root.querySelectorAll<HTMLElement>("[data-grouped-task-key]").forEach((element) => {
    const key = element.getAttribute("data-grouped-task-key");
    if (!key) {
      return;
    }
    const rect = element.getBoundingClientRect();
    rects.set(`task:${key}`, {
      height: rect.height,
      left: rect.left,
      top: rect.top,
    });
  });
  return rects;
}

// [契约] 预览宽度按任务键查找真实行，保证拖动替身与原行同宽。
// DOM 上的任务键经过编码，查找前必须同样编码，否则永远匹配不到。
// [边界] 找不到时返回空值，由调用方回退到默认宽度。
// [权衡] 逐行比较属性而不是用属性选择器，避免键里的特殊字符破坏选择器语法。
// [失败路径] 忘记编码会让含斜杠或冒号的任务键全部测不到宽度。
export function measureGroupedTaskPreviewWidth(
  root: HTMLElement | null,
  targetTaskKey: string,
): number | null {
  if (!root) {
    return null;
  }
  const targetDomKey = encodeURIComponent(targetTaskKey);
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-task-key]")) {
    if (element.getAttribute("data-grouped-task-key") === targetDomKey) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

export function measureGroupedGroupPreviewWidth(
  root: HTMLElement | null,
  targetGroupId: string,
): number | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    if (element.getAttribute("data-grouped-group-item-id") === targetGroupId) {
      return element.getBoundingClientRect().width;
    }
  }
  return null;
}

// [契约] 吸附组取最后一个头部已滚过容器顶、且自身仍覆盖顶部的未折叠组。
// 跳过折叠组，因为折叠组的头部不会吸附。
// [边界] 头部高度兜底为 32，防止首帧测量为零导致判定失效。
// [权衡] 容差取半像素以吸收舍入误差，避免临界滚动时吸附抖动。
// [失败路径] 缺少仍覆盖顶部的判断会让吸附组在滚出视口后仍然保留。
export function resolveStickyGroupedTaskGroupId(root: HTMLElement | null): string | null {
  if (!root) {
    return null;
  }
  const scrollContainer = findNearestScrollableAncestor(root);
  if (!scrollContainer) {
    return null;
  }
  const containerTop = scrollContainer.getBoundingClientRect().top;
  let stickyGroupId: string | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-grouped-group-item-id]")) {
    const groupId = element.getAttribute("data-grouped-group-item-id");
    if (element.getAttribute("data-group-collapsed") === "true") {
      continue;
    }
    const header = groupId
      ? root.querySelector<HTMLElement>(`[data-grouped-group-header-id="${CSS.escape(groupId)}"]`)
      : null;
    if (!groupId || !header) {
      continue;
    }
    const groupRect = element.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const headerHeight = headerRect.height || 32;
    const headerHasScrolledPastTop = headerRect.top < containerTop - 0.5;
    const groupStillCoversTop = groupRect.bottom > containerTop + headerHeight + 0.5;
    if (headerHasScrolledPastTop && groupStillCoversTop) {
      stickyGroupId = groupId;
    }
  }
  return stickyGroupId;
}

// [契约] 用前后快照做补间：位移用变换表达，高度变化才动高度属性。
// 先取消节点上已有动画，避免新旧补间叠加产生跳动。
// [边界] 系统偏好减少动效时整体跳过，尊重用户设置。
// [资源] 动画结束与取消都要恢复原溢出样式，防止裁剪效果泄漏到后续渲染。
// [失败路径] 只在完成事件恢复而不管取消事件，快速重排时元素会一直保持裁剪。
export function animateGroupedTaskLayoutFrom(
  root: HTMLElement | null,
  previousRects: GroupedTaskLayoutRects,
) {
  if (!root || previousRects.size === 0) {
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const selector = "[data-grouped-layout-key], [data-grouped-task-key]";
  root.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    const layoutKey = element.getAttribute("data-grouped-layout-key");
    const taskKeyValue = element.getAttribute("data-grouped-task-key");
    const previousRect = layoutKey
      ? previousRects.get(`layout:${layoutKey}`)
      : taskKeyValue
        ? previousRects.get(`task:${taskKeyValue}`)
        : null;
    if (!previousRect) {
      return;
    }
    const nextRect = element.getBoundingClientRect();
    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    const deltaHeight = previousRect.height - nextRect.height;
    const shouldAnimateHeight = Boolean(layoutKey) && Math.abs(deltaHeight) >= 0.5;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5 && !shouldAnimateHeight) {
      return;
    }
    element.getAnimations().forEach((animation) => animation.cancel());
    const previousOverflow = element.style.overflow;
    if (shouldAnimateHeight) {
      element.style.overflow = "hidden";
    }
    const animation = element.animate(
      [
        {
          height: shouldAnimateHeight ? `${previousRect.height}px` : undefined,
          transform: `translate(${deltaX}px, ${deltaY}px)`,
        },
        {
          height: shouldAnimateHeight ? `${nextRect.height}px` : undefined,
          transform: "translate(0, 0)",
        },
      ],
      {
        duration: 150,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      },
    );
    animation.addEventListener(
      "finish",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
    animation.addEventListener(
      "cancel",
      () => {
        element.style.overflow = previousOverflow;
      },
      { once: true },
    );
  });
}
