// ==========================================================================
// 职责边界（project-sidebar/grouped/view.ts）
// 做：
//   - 提供分组视图的纯函数变换：克隆、查找、插入、移除、拖拽重排、菜单移动。
//   - 维护折叠集合的收敛与全部展开判定。
// 不做：
//   - 不读写 store、不发请求、不产生副作用；入参与返回值都是普通对象。
//   - 不判定任务归属或可用性，projectId 与 taskGroupId 由调用方给出。
// 依赖：
//   - taskKey 是任务唯一身份，视图内所有比较都必须走它，不能比对象引用。
//   - 视图只有一层分组：顶层是 task 或 group，group 内只能是 task。
// 边界：
//   - 所有重排都写时复制：返回新容器引用，但不深拷贝 task 元数据。
//   - 找不到目标时一律原样返回 view，禁止返回半完成状态。
//
// INV 不变量表（18 条；破坏任一条会让拖拽结果错位或任务丢失）：
// INV-01 断言：所有移动操作都基于写时复制，返回新容器引用 —— 守住它的位置：cloneNodes 与 cloneGroupNode —— 改错故障：拖拽一次后原视图被就地改写，回滚拿到脏快照
// INV-02 断言：任务身份只由 taskKey 决定 —— 守住它的位置：全部比较点 —— 改错故障：同一任务出现两份或匹配不到
// INV-03 断言：removeTaskFromView 必须同时返回新视图与被移除任务 —— 守住它的位置：removeTaskFromView —— 改错故障：调用方拿不到任务，移动后任务消失
// INV-04 断言：移除成功后必须重新定位插入点，不能用移除前的下标 —— 守住它的位置：moveTaskOverTask 与 moveGroupAroundTopLevelNode —— 改错故障：同组向下移动偏一格
// INV-05 断言：组内插入下标必须用 findIndex，找不到时回退到末尾 —— 守住它的位置：insertTaskIntoGroup —— 改错故障：跨组拖拽把任务插到错误位置或丢失
// INV-06 断言：beforeTaskKey 为 null 表示追加到组尾 —— 守住它的位置：insertTaskIntoGroup —— 改错故障：置顶到空组时任务凭空消失
// INV-07 断言：顶层与组内两层都必须参与查找与替换 —— 守住它的位置：findTaskLocation 与 replaceTaskInGroupedView —— 改错故障：任务标题只更新一处
// INV-08 断言：分组节点必须在 tasks 数组被改写前克隆 —— 守住它的位置：cloneGroupNode —— 改错故障：上游视图被污染，列表不重渲染
// INV-09 断言：隐藏集合为空时 filterGroupedViewByTaskKeys 返回原引用 —— 守住它的位置：函数首行 —— 改错故障：每次渲染都产生新对象，整表重渲染
// INV-10 断言：过滤只删任务，不删除变空的 group 节点 —— 守住它的位置：过滤循环 —— 改错故障：分组存在性随可见任务消失，折叠状态错乱
// INV-11 断言：折叠集合收敛后只保留仍然存在的 groupId —— 守住它的位置：pruneCollapsedGroupedTaskGroupIds —— 改错故障：删除后重建同名分组继承旧折叠状态
// INV-12 断言：空分组列表的全展开判定必须为 false —— 守住它的位置：areAllGroupedTaskGroupsExpanded —— 改错故障：无分组视图显示无意义的全部折叠按钮
// INV-13 断言：拖动组时组内 task 必须归一化为所属 group —— 守住它的位置：moveGroupAroundTopLevelNode —— 改错故障：拖到组内容区不触发组间移动
// INV-14 断言：active 与 over 为同一目标时必须直接返回 view —— 守住它的位置：moveTaskOverTask 与 moveGroupAroundTopLevelNode —— 改错故障：原样重排导致元素闪动或丢失
// INV-15 断言：菜单移动前先比较当前组与目标组 —— 守住它的位置：moveTaskByMenu —— 改错故障：同组移动被当作换组，任务被重复插入
// INV-16 断言：移出分组时先按原组定位后继节点再插入 —— 守住它的位置：moveTaskByMenu 末尾 —— 改错故障：任务跳到列表末尾，空间上下文丢失
// INV-17 断言：置顶时已在首位必须直接返回 —— 守住它的位置：moveTaskToTopByMenu —— 改错故障：无意义重排导致顺序回弹
// INV-18 断言：草稿落点未命中任务时回退顶层 —— 守住它的位置：resolveGroupedDraftTaskPlacementForTask —— 改错故障：新建草稿分配到不存在的分组
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  GroupedDraftTaskPlacement,
} from "@/project-sidebar/grouped/types.js";

import { taskKey } from "@/project-sidebar/grouped/ids.js";

// [契约] 只复制容器层：task 节点浅拷贝，group 节点额外复制 tasks 数组。
// 不深拷贝 task 元数据是刻意的：任务对象由 store 持有，视图不产生第二份事实。
// 必须返回新引用，调用方依赖引用变化触发侧栏重渲染。
// 改错故障：拖动后视图不更新，因为 selector 判定状态对象未变。
function cloneView(view: ZCodeGroupedTaskView): ZCodeGroupedTaskView {
  return {
    nodes: view.nodes.map((node) =>
      node.type === "task" ? { ...node } : { ...node, tasks: [...node.tasks] },
    ),
  };
}

// [契约] 顶层节点数组的唯一浅拷贝入口，所有移动操作都从它开始改写。
// 它不复制节点内部，必须配合 cloneGroupNode 才构成完整写时复制。
// 不要先 slice 再就地修改原数组元素：会污染上游 view。
// 改错故障：拖拽一次后原视图被就地改写，撤销拿到错误快照。
function cloneNodes(view: ZCodeGroupedTaskView): ZCodeGroupedTaskViewNode[] {
  return [...view.nodes];
}

// [契约] group 节点的写时复制：外层节点与 tasks 数组都必须是新引用。
// 只改 tasks 内容却不换节点引用时，列表 memo 比较会失败。
// 不要在这里顺带复制 task 元数据：任务身份必须保持稳定。
// 改错故障：组内重排后行组件不重新渲染，位置看起来没变。
function cloneGroupNode(
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>,
): Extract<ZCodeGroupedTaskViewNode, { type: "group" }> {
  return { ...node, tasks: [...node.tasks] };
}

// [契约] 同时返回新 view 与被移除的 task；找不到时 task 为 null，调用方必须短路。
// 顶层命中直接 splice；组内命中先 clone 组节点再 splice。
// nodes 已经是克隆数组，但仍不能就地修改组节点本身。
// 改错故障：找不到任务却继续插入，把 null 当任务写进视图。
function removeTaskFromView(
  view: ZCodeGroupedTaskView,
  targetTaskKey: string,
): {
  nextView: ZCodeGroupedTaskView;
  task: ZCodeTaskMeta | null;
} {
  const nodes = cloneNodes(view);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      nodes.splice(index, 1);
      return { nextView: { nodes }, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const nextGroupNode = cloneGroupNode(node);
        const [task] = nextGroupNode.tasks.splice(taskIndex, 1);
        nodes[index] = nextGroupNode;
        return { nextView: { nodes }, task: task ?? null };
      }
    }
  }
  return { nextView: { nodes }, task: null };
}

// [契约] beforeTaskKey 为 null 表示追加到组尾，否则插到该 task 之前。
// 目标组不存在时返回 nodes 拷贝，静默降级而不是抛错。
// 插入下标由 findIndex 得到，找不到时回退到末尾。
// 改错故障：跨组拖拽把任务插到错误位置或直接丢弃。
function insertTaskIntoGroup(
  view: ZCodeGroupedTaskView,
  task: ZCodeTaskMeta,
  groupId: string,
  beforeTaskKey: string | null,
): ZCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const groupIndex = nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
  const groupNode = nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex =
    beforeTaskKey === null
      ? nextGroupNode.tasks.length
      : nextGroupNode.tasks.findIndex((item) => taskKey(item) === beforeTaskKey);
  nextGroupNode.tasks.splice(insertIndex < 0 ? nextGroupNode.tasks.length : insertIndex, 0, task);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

// [契约] 先扫组内再扫顶层，命中第一个即返回，不做全量删除。
// 语义是移除一个引用：同一 task 若被重复登记，只清第一条。
// 返回新 view，组节点被就地 splice，该路径由 cloneView 隔离。
// 改错故障：重复登记的任务清不干净，删除后仍出现在列表。
function removeTaskFromGroupedView(
  view: ZCodeGroupedTaskView,
  targetTaskKey: string,
): ZCodeGroupedTaskView {
  const nextView = cloneView(view);
  for (const node of nextView.nodes) {
    if (node.type !== "group") {
      continue;
    }
    const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
    if (taskIndex >= 0) {
      node.tasks.splice(taskIndex, 1);
      return nextView;
    }
  }

  const nodeIndex = nextView.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
  if (nodeIndex >= 0) {
    nextView.nodes.splice(nodeIndex, 1);
  }
  return nextView;
}

// [契约] 隐藏集合为空时直接返回原 view，避免无意义的新引用。
// 只有真正删掉节点或任务时才标记 changed，否则保留原引用。
// 组被过滤空后仍保留空组节点：分组存在性不由可见任务决定。
// 改错故障：每次渲染都产生新对象，侧栏整表重渲染。
function filterGroupedViewByTaskKeys(
  view: ZCodeGroupedTaskView,
  hiddenTaskKeys: ReadonlySet<string>,
): ZCodeGroupedTaskView {
  if (hiddenTaskKeys.size === 0) {
    return view;
  }

  let changed = false;
  const nodes: ZCodeGroupedTaskView["nodes"] = [];
  for (const node of view.nodes) {
    if (node.type === "task") {
      if (!hiddenTaskKeys.has(taskKey(node.task))) {
        nodes.push(node);
      } else {
        changed = true;
      }
      continue;
    }

    const tasks = node.tasks.filter((task) => !hiddenTaskKeys.has(taskKey(task)));
    if (tasks.length === node.tasks.length) {
      nodes.push(node);
      continue;
    }
    changed = true;
    nodes.push({ ...node, tasks });
  }

  return changed ? { nodes } : view;
}

// [契约] 只读查找，先顶层后组内，返回第一个命中的 task 元数据。
// 它不返回位置信息；需要位置请用 findTaskLocation。
// 不要在查找里做去重或改序：查找必须无副作用。
// 改错故障：调用方以为拿到的是唯一任务，实际存在重复登记。
function findTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  targetTaskKey: string,
): ZCodeTaskMeta | null {
  for (const node of view.nodes) {
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return node.task;
    }
    if (node.type === "group") {
      const task = node.tasks.find((item) => taskKey(item) === targetTaskKey);
      if (task) {
        return task;
      }
    }
  }
  return null;
}

// [契约] 按 taskKey 替换元数据，保留节点在视图中的位置与层级。
// 顶层与组内都要替换，漏掉任一层会让同一任务出现两个版本。
// 未命中时仍返回新数组，但元素引用不变。
// 改错故障：`replaceTaskInGroupedView` 漏掉任一层，同一任务会出现两个版本的标题。
function replaceTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  nextTask: ZCodeTaskMeta,
): ZCodeGroupedTaskView {
  const targetTaskKey = taskKey(nextTask);
  return {
    nodes: view.nodes.map((node) => {
      if (node.type === "task") {
        return taskKey(node.task) === targetTaskKey ? { ...node, task: nextTask } : node;
      }
      return {
        ...node,
        tasks: node.tasks.map((task) => (taskKey(task) === targetTaskKey ? nextTask : task)),
      };
    }),
  };
}

// [契约] 只收集顶层 group 节点的 id，顺序与视图一致。
// 空结果用于全部折叠判定，调用方必须能区分空数组与全展开。
// 不要在这里排序：折叠集合的比较依赖稳定顺序。
// 改错故障：折叠状态在重排后被误判为失效并全部展开。
function getGroupedTaskGroupIds(view: ZCodeGroupedTaskView): string[] {
  return view.nodes.flatMap((node) => (node.type === "group" ? [node.group.id] : []));
}

// [契约] 空分组列表返回 false，避免把没有分组当成全展开。
// 判定依据是 collapsedGroupIds 是否包含任一 id，未收录即视为展开。
// 不要改成检查分组内部状态：折叠是集合不是布尔。
// 改错故障：无分组视图显示全部折叠按钮，但点击没有任何效果。
function areAllGroupedTaskGroupsExpanded(
  groupIds: readonly string[],
  collapsedGroupIds: ReadonlySet<string>,
): boolean {
  return groupIds.length > 0 && groupIds.every((groupId) => !collapsedGroupIds.has(groupId));
}

// [事务] 每次视图重算后收敛折叠集合，只保留仍然存在的 groupId。
// 必须在分组增删后调用，否则已删除分组的 id 会永久占用集合。
// 返回新 Set，不能就地删除，避免与上一次渲染共享引用。
// 改错故障：删除后重建同名分组，会意外继承旧的折叠状态。
function pruneCollapsedGroupedTaskGroupIds(
  collapsedGroupIds: ReadonlySet<string>,
  groupIds: readonly string[],
): Set<string> {
  const knownGroupIds = new Set(groupIds);
  return new Set([...collapsedGroupIds].filter((groupId) => knownGroupIds.has(groupId)));
}

// [契约] 返回任务所在顶层分组的 id，未分组返回 null。
// 只认组内任务，顶层散任务即使有草稿分组也不算。
// 它是菜单移动判断是否换组的唯一依据。
// 改错故障：同组内移动被判定为换组，任务被重复插入。
function getTaskGroupIdInView(view: ZCodeGroupedTaskView, targetTaskKey: string): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

type GroupedTaskLocation =
  | {
      parent: "root";
      nodeIndex: number;
      task: ZCodeTaskMeta;
    }
  | {
      parent: "group";
      groupId: string;
      nodeIndex: number;
      taskIndex: number;
      task: ZCodeTaskMeta;
    };

type GroupedTaskInsertPosition = "before" | "after";

// [契约] 只在顶层节点里找 task，返回下标，未命中为 -1。
// 组内任务不参与，因为顶层插入点的语义是同级移动。
// 不要用它做存在性判断：-1 与组内命中要分开处理。
// 改错故障：把组内任务当成顶层任务，插入位置错一位。
function findTopLevelTaskIndex(view: ZCodeGroupedTaskView, targetTaskKey: string): number {
  return view.nodes.findIndex(
    (node) => node.type === "task" && taskKey(node.task) === targetTaskKey,
  );
}

// [契约] 只匹配顶层 group 节点，返回下标，未命中为 -1。
// 与 findTopLevelTaskIndex 共用 -1 语义，调用方统一按缺失处理。
// 不要在这里做嵌套分组查找：当前模型只有一层分组。
// 改错故障：误把子节点当分组，移动后顺序错乱。
function findGroupIndex(view: ZCodeGroupedTaskView, groupId: string): number {
  return view.nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
}

// [契约] 由任务反查所属分组，用于把拖到组内任务归一化为拖到组上。
// 未命中返回 null，调用方必须与顶层任务区分。
// 只在组内 tasks 里匹配，不看顶层散任务。
// 改错故障：`findGroupIdByTaskKey` 漏看组内任务，组内容区拖放不会触发组间移动。
function findGroupIdByTaskKey(view: ZCodeGroupedTaskView, targetTaskKey: string): string | null {
  for (const node of view.nodes) {
    if (node.type !== "group") {
      continue;
    }
    if (node.tasks.some((task) => taskKey(task) === targetTaskKey)) {
      return node.group.id;
    }
  }
  return null;
}

// [契约] 返回带 parent 判别式的定位：root 只有 nodeIndex，group 还带 taskIndex。
// 它是所有移动逻辑的唯一寻址入口，遍历顺序必须与 removeTaskFromView 一致。
// 组内命中却取不到 task 时直接返回 null，不允许返回半成品位置。
// 改错故障：移动时走错 parent 分支，任务被插入到另一个层级。
function findTaskLocation(
  view: ZCodeGroupedTaskView,
  targetTaskKey: string,
): GroupedTaskLocation | null {
  for (let nodeIndex = 0; nodeIndex < view.nodes.length; nodeIndex += 1) {
    const node = view.nodes[nodeIndex];
    if (!node) {
      continue;
    }
    if (node.type === "task" && taskKey(node.task) === targetTaskKey) {
      return { parent: "root", nodeIndex, task: node.task };
    }
    if (node.type === "group") {
      const taskIndex = node.tasks.findIndex((task) => taskKey(task) === targetTaskKey);
      if (taskIndex >= 0) {
        const task = node.tasks[taskIndex];
        if (!task) {
          return null;
        }
        return {
          parent: "group",
          groupId: node.group.id,
          nodeIndex,
          taskIndex,
          task,
        };
      }
    }
  }
  return null;
}

// [契约] 草稿落点：空 key 落顶层，命中组内则落该组，其余一律落顶层。
// 未找到任务时也回退顶层，而不是抛错或返回 null。
// 不要在这里读取 activeTaskId：落点只由传入 key 决定。
// 改错故障：`resolveGroupedDraftTaskPlacementForTask` 落错分组，用户会以为草稿丢失。
function resolveGroupedDraftTaskPlacementForTask(
  view: ZCodeGroupedTaskView,
  targetTaskKey: string | null | undefined,
): GroupedDraftTaskPlacement {
  if (!targetTaskKey) {
    return { type: "top" };
  }
  const location = findTaskLocation(view, targetTaskKey);
  return location?.parent === "group"
    ? { type: "group", groupId: location.groupId }
    : { type: "top" };
}

// [契约] 在 over task 的前或后插入，父级由 over task 所在层级决定。
// 顶层用 nodeIndex 加减 1；组内先 clone 组节点再按 taskIndex 加减 1。
// 它假设 active task 已被移除，否则同组向下移动会多偏一位。
// 改错故障：跨层级拖拽时任务落到组外或插到组节点之间。
function insertTaskNearTask(
  view: ZCodeGroupedTaskView,
  task: ZCodeTaskMeta,
  overTaskKey: string,
  position: GroupedTaskInsertPosition,
): ZCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const overLocation = findTaskLocation({ nodes }, overTaskKey);
  if (!overLocation) {
    return { nodes };
  }

  if (overLocation.parent === "root") {
    const insertIndex = overLocation.nodeIndex + (position === "after" ? 1 : 0);
    nodes.splice(insertIndex, 0, { type: "task", task });
    return { nodes };
  }

  const groupNode = nodes[overLocation.nodeIndex];
  if (!groupNode || groupNode.type !== "group") {
    return { nodes };
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  const insertIndex = overLocation.taskIndex + (position === "after" ? 1 : 0);
  nextGroupNode.tasks.splice(insertIndex, 0, task);
  nodes[overLocation.nodeIndex] = nextGroupNode;
  return { nodes };
}

// [事务] 顺序固定：先记录 active 与 over 位置，再移除 active，最后按 over 重新定位。
// 移除后必须重新 find，因为旧下标在 splice 之后已经失效。
// 同 key 或任一定位失败时原样返回 view，不做部分修改。
// 改错故障：同组向下移动时插入点后移一格，任务落到错误位置。
function moveTaskOverTask(
  view: ZCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    overTaskKey: string;
    position: GroupedTaskInsertPosition;
  },
): ZCodeGroupedTaskView {
  if (params.activeTaskKey === params.overTaskKey) {
    return view;
  }
  const activeLocation = findTaskLocation(view, params.activeTaskKey);
  const overLocation = findTaskLocation(view, params.overTaskKey);
  if (!activeLocation || !overLocation) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }

  // task over task 的目标父级由 over task 所在层级决定。
  // 先移除 active 再按 over task 重新定位，避免同组向下移动时旧 index 把插入点推后一格。
  return insertTaskNearTask(nextView, task, params.overTaskKey, params.position);
}

// [契约] 在 group 节点的前或后插入顶层 task，只改顶层顺序。
// 分组下标不存在时返回 nodes 拷贝，静默降级。
// 它不负责从原位置删除，调用方必须先 removeTaskFromView。
// 改错故障：同一任务出现两份，视图 key 冲突导致渲染告警。
function insertTaskAroundGroup(
  view: ZCodeGroupedTaskView,
  task: ZCodeTaskMeta,
  groupId: string,
  position: GroupedTaskInsertPosition,
): ZCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const groupIndex = nodes.findIndex((node) => node.type === "group" && node.group.id === groupId);
  if (groupIndex < 0) {
    return { nodes };
  }
  nodes.splice(groupIndex + (position === "after" ? 1 : 0), 0, { type: "task", task });
  return { nodes };
}

// [事务] 先把任务从原位置移除，再按目标 group 的当前下标插入。
// 必须先验证 group 存在：移除后再失败会返回 view，任务被吞掉。
// 插入使用 nextView 的下标，而不是原始 view。
// 改错故障：拖到分组旁边后任务消失。
function moveTaskToRootAroundGroup(
  view: ZCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
    position: GroupedTaskInsertPosition;
  },
): ZCodeGroupedTaskView {
  const groupNode = view.nodes.find(
    (node) => node.type === "group" && node.group.id === params.groupId,
  );
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }

  return insertTaskAroundGroup(nextView, task, params.groupId, params.position);
}

// [事务] 移除 active 后重新查组，取当前首个任务的 key 作为插入锚点。
// 空组时锚点为 null，走 insertTaskIntoGroup 的追加分支。
// 组不存在时返回原 view，不能返回已移除任务的中间态。
// 改错故障：置顶到空组时任务丢失。
function moveTaskToGroupStart(
  view: ZCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): ZCodeGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupNode = nextView.nodes.find(
    (node) => node.type === "group" && node.group.id === params.groupId,
  );
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
  return insertTaskIntoGroup(nextView, task, params.groupId, firstTaskKey);
}

// [事务] 移除后按下标取组节点，clone 后 push，再写回节点数组。
// 写回必须用 groupIndex：移除任务不改变顶层下标，但组可能已移位。
// 组不存在或已变成 task 节点时返回原 view。
// 改错故障：任务被追加到错误的组，或组节点被原地改写。
function moveTaskToGroupEnd(
  view: ZCodeGroupedTaskView,
  params: {
    activeTaskKey: string;
    groupId: string;
  },
): ZCodeGroupedTaskView {
  const { nextView, task } = removeTaskFromView(view, params.activeTaskKey);
  if (!task) {
    return view;
  }
  const groupIndex = findGroupIndex(nextView, params.groupId);
  const groupNode = nextView.nodes[groupIndex];
  if (!groupNode || groupNode.type !== "group") {
    return view;
  }
  const nextGroupNode = cloneGroupNode(groupNode);
  nextGroupNode.tasks.push(task);
  const nodes = cloneNodes(nextView);
  nodes[groupIndex] = nextGroupNode;
  return { nodes };
}

// [事务] 先把组内 task 归一化为所属 group，再比较是否同组，最后 splice 组节点。
// 移除 active 组后必须重新计算 overIndex，否则向下移动会偏一格。
// 归一化命中自身时直接返回 view，避免无意义重排。
// 改错故障：组拖到组内容区无效，或组顺序整体错位。
function moveGroupAroundTopLevelNode(
  view: ZCodeGroupedTaskView,
  params: {
    activeGroupId: string;
    over:
      | {
          type: "group";
          groupId: string;
        }
      | {
          type: "task";
          taskKey: string;
        };
    position: GroupedTaskInsertPosition;
  },
): ZCodeGroupedTaskView {
  if (params.over.type === "group" && params.activeGroupId === params.over.groupId) {
    return view;
  }
  // group 拖到另一个 group 的 content 上时，collision 可能返回组内 task；
  // 这里把组内 task 归一化为所属 group，避免 content 区域不触发 group over group。
  // [契约] 只有 over 是 task 时才反查分组，over 是 group 时保持 null。
  // 反查结果等于 activeGroupId 说明拖到了自己组内，直接返回。
  // 这里必须用原始 view 反查，不能先用已移除 active 的 nodes。
  // 改错故障：组内 task 的碰撞被当成顶层插入点，组顺序被打乱。
  const overGroupId =
    params.over.type === "task" ? findGroupIdByTaskKey(view, params.over.taskKey) : null;
  if (overGroupId === params.activeGroupId) {
    return view;
  }
  const nodes = cloneNodes(view);
  const activeIndex = nodes.findIndex(
    (node) => node.type === "group" && node.group.id === params.activeGroupId,
  );
  if (activeIndex < 0) {
    return view;
  }
  // [事务] 取出并移除 active 组是一次 splice，返回值必须校验存在。
  // 取出后 nodes 已变短，所有 over 下标必须重新计算。
  // activeNode 不是 group 时返回原 view，不能把半个结果写回。
  // 改错故障：同组或相邻组拖动时组节点被删除后未重新插入。
  const [activeNode] = nodes.splice(activeIndex, 1);
  if (!activeNode || activeNode.type !== "group") {
    return view;
  }
  const nextView = { nodes };
  const overIndex =
    params.over.type === "group"
      ? findGroupIndex(nextView, params.over.groupId)
      : overGroupId
        ? findGroupIndex(nextView, overGroupId)
        : findTopLevelTaskIndex(nextView, params.over.taskKey);
  if (overIndex < 0) {
    return view;
  }
  nodes.splice(overIndex + (params.position === "after" ? 1 : 0), 0, activeNode);
  return { nodes };
}

// [契约] 返回分组的紧邻下一个顶层节点，组在末尾时返回 null。
// 它用于移出分组时保留空间上下文，不能返回分组自身。
// 下标基于当前 view，调用方必须在移除任务之后使用。
// 改错故障：移出分组后任务跳到列表最末，位置语义丢失。
function getNodeIdAfterGroup(
  view: ZCodeGroupedTaskView,
  groupId: string,
): ZCodeGroupedTaskViewNode | null {
  const groupIndex = view.nodes.findIndex(
    (node) => node.type === "group" && node.group.id === groupId,
  );
  return groupIndex >= 0 ? (view.nodes[groupIndex + 1] ?? null) : null;
}

// [契约] beforeNode 为 null 表示追加到末尾，否则按节点身份定位插入点。
// 身份分支：group 比 groupId，task 比 taskKey，两者不能混用。
// 找不到锚点时回退到末尾，保证任务一定被插入而不是丢弃。
// 改错故障：移出分组时任务消失或插到错误层级。
function insertTaskBeforeTopLevelNode(
  view: ZCodeGroupedTaskView,
  task: ZCodeTaskMeta,
  beforeNode: ZCodeGroupedTaskViewNode | null,
): ZCodeGroupedTaskView {
  const nodes = cloneNodes(view);
  const insertIndex =
    beforeNode === null
      ? nodes.length
      : nodes.findIndex((node) =>
          beforeNode.type === "group"
            ? node.type === "group" && node.group.id === beforeNode.group.id
            : node.type === "task" && taskKey(node.task) === taskKey(beforeNode.task),
        );
  nodes.splice(insertIndex < 0 ? nodes.length : insertIndex, 0, {
    type: "task",
    task,
  });
  return { nodes };
}

// [事务] 同组直接返回 view；换组时先移除，再按目标组插入或按原组后继插入。
// 移出分组分支必须在 remove 之后读取 nextView 的节点顺序。
// 目标分组为空时插入组尾，不做位置猜测。
// 改错故障：菜单移动后任务重复出现或消失在视图中。
function moveTaskByMenu(
  view: ZCodeGroupedTaskView,
  targetTask: ZCodeTaskMeta,
  targetGroupId: string | null,
): ZCodeGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const currentGroupId = getTaskGroupIdInView(view, targetTaskKey);
  if (currentGroupId === targetGroupId) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }
  if (targetGroupId) {
    return insertTaskIntoGroup(nextView, task, targetGroupId, null);
  }

  // 菜单移出分组时把 task 放到原 group 后面，避免用户刚操作完就丢失空间上下文。
  // [契约] 必须用原始 view 计算原组的后继节点，nextView 里原组可能已被清空。
  // currentGroupId 为 null 表示任务原本就在顶层，直接追加到末尾。
  // 这个锚点要在 remove 之前求值，否则相邻关系已经改变。
  // 改错故障：移出分组后任务插到错误位置，甚至插回原组之前。
  const beforeNode = currentGroupId ? getNodeIdAfterGroup(view, currentGroupId) : null;
  return insertTaskBeforeTopLevelNode(nextView, task, beforeNode);
}

// [事务] 已在最前（顶层 0 或组内 0）时直接返回，避免无意义重排。
// 组内置顶用当前首任务 key 作锚点，空组退化为追加。
// 顶层置顶直接构造新数组头插，不复用旧数组。
// 改错故障：置顶后任务重复或顺序回弹。
function moveTaskToTopByMenu(
  view: ZCodeGroupedTaskView,
  targetTask: ZCodeTaskMeta,
): ZCodeGroupedTaskView {
  const targetTaskKey = taskKey(targetTask);
  const location = findTaskLocation(view, targetTaskKey);
  if (
    !location ||
    (location.parent === "root" && location.nodeIndex === 0) ||
    (location.parent === "group" && location.taskIndex === 0)
  ) {
    return view;
  }

  const { nextView, task } = removeTaskFromView(view, targetTaskKey);
  if (!task) {
    return view;
  }

  if (location.parent === "group") {
    const groupNode = nextView.nodes.find(
      (node) => node.type === "group" && node.group.id === location.groupId,
    );
    if (!groupNode || groupNode.type !== "group") {
      return view;
    }
    const firstTaskKey = groupNode.tasks[0] ? taskKey(groupNode.tasks[0]) : null;
    return insertTaskIntoGroup(nextView, task, location.groupId, firstTaskKey);
  }

  return {
    nodes: [{ type: "task", task }, ...nextView.nodes],
  };
}

export {
  areAllGroupedTaskGroupsExpanded,
  cloneView,
  filterGroupedViewByTaskKeys,
  findTaskInGroupedView,
  getGroupedTaskGroupIds,
  moveTaskByMenu,
  moveGroupAroundTopLevelNode,
  moveTaskToTopByMenu,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  moveTaskOverTask,
  pruneCollapsedGroupedTaskGroupIds,
  removeTaskFromGroupedView,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
};
export type { GroupedTaskInsertPosition };
