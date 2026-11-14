// INV-01 拖拽期间不得写入持久状态，预览仅存在于 preview 与 latestPreview；守住位置：onDragStart 与 applyPreview；改错故障：松手后列表跳回旧位置或出现残留重影。
// INV-02 手势结束只能提交一条单节点命令，未发生位移时命令必须为空；守住位置：onDragEnd 的 command 分支；改错故障：原地松手也触发持久化，产生无意义写盘与闪烁。
// INV-03 取消必须完全回到起点视图；守住位置：onDragCancel；改错故障：按 Esc 后列表停在预览布局，权威数据与界面不一致。
// INV-04 群组拖拽的临时展开必须在结束或取消时按快照回滚；守住位置：restoreCollapsed；改错故障：用户原有折叠状态被永久展开。
// INV-05 折叠快照只能抓取一次，且只对组拖拽生效；守住位置：onDragStart 的 groupId 分支；改错故障：任务拖拽误改折叠集，侧栏整组闪开。
// INV-06 指针捕获与监听释放交给 dnd-kit，reset 负责清空全部手势 ref；守住位置：reset；改错故障：下一次手势继承上次增量，方向判定从错误基线开始。
// INV-07 同一时刻只能有一个活动身份，任务与组互斥；守住位置：onDragStart 的两个分支；改错故障：宽度与高亮同时命中两者，预览宽度取错。
// INV-08 拖拽方向只有 before 与 after 两种取值；守住位置：onDragMove；改错故障：方向抖动导致落点在上下来回跳。
// INV-09 方向翻转时必须基于缓存的 over 立即重算；守住位置：onDragMove 的 lastOver 分支；改错故障：越过目标后不换边，插入位置滞后一拍。
// INV-10 预览内容按签名去重，相同签名不得刷新状态；守住位置：applyPreview 的早退分支；改错故障：高频 over 事件引发连续重渲染与动画抖动。
// INV-11 布局动画必须基于更新前的矩形集合做 FLIP；守住位置：animate；改错故障：动画起点错位，列表整体瞬移。
// INV-12 同一帧内只允许一个待执行动画帧；守住位置：animate 中的帧号检查；改错故障：多帧叠加互相取消，出现可见闪烁。
// INV-13 卸载时必须撤销未执行的动画帧；守住位置：光标 effect 之前的清理 effect；改错故障：组件卸载后仍回调动画，控制台报错或内存泄漏。
// INV-14 拖拽光标状态必须成对设置与恢复；守住位置：cursor effect 的清理函数；改错故障：拖拽结束后光标卡在抓取态。
// INV-15 拖拽中禁止读取容器最新尺寸做决策；守住位置：宽度测量只在 onDragStart；改错故障：强制同步布局，长列表拖拽掉帧。
// INV-16 预览不存在时渲染必须回落权威视图；守住位置：view 的取值表达式；改错故障：空闲态读到空视图，侧栏空白。
// INV-17 结束提交的预览必须是最近一次有效预览；守住位置：onDragEnd 的 latestPreview 取值；改错故障：提交落点与用户最后看到的落点不一致。
// INV-18 迟到的旧命令不得清除后续手势的预览；守住位置：onDragEnd 的 pendingPreview 比对；改错故障：连续拖动时后一次预览被前一次回调清空。
//
// 总述：本 hook 把一次拖拽拆成「冻结起点 → 逐帧求预览 → 单次提交或回滚」三段。
// 状态分层：ref 保存手势上下文，state 只保存渲染需要的投影，持久层只在结束时被触达一次。
// 阅读顺序建议：先看 onDragStart 与 onDragEnd 的两端，再看 applyPreview 的中间求值。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
// [资源] 只从 React 取 hooks 与类型：本地状态负责手势投影，不引入全局 store。
// 该 hook 是纯 UI 层，持久化入口只有参数 onMove，依赖方向保持单向。
} from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragMoveEvent,
  type DragEndEvent,
// dnd-kit 只提供传感器、事件类型与自动滚动阈值；命中判定由 drag.js 自研替换。
// 事件对象是短暂快照，不能跨手势缓存整只 event，只缓存 over 引用。
} from "@dnd-kit/core";
import type { MoveGroupNode, GroupNode } from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import type { ZCodeGroupedTaskView } from "@/project-sidebar/grouped/types.js";
import { findTaskInGroupedView } from "@/project-sidebar/grouped/view.js";
import {
  getGroupedTaskDragTaskKey,
  getGroupedTaskDragGroupId,
  getGroupedTaskViewSignature,
  getGroupedGroupOverTaskPreviewView,
  getGroupedGroupOverGroupPreviewView,
  getGroupedTaskOverTaskPreviewView,
  getGroupedTaskOverEmptyDropZonePreviewView,
  getGroupedTaskOverGroupFooterPreviewView,
  getGroupedTaskOverGroupHeaderPreviewView,
  getGroupedTaskOverCollapsedGroupPreviewView,
  collectGroupedTaskLayoutRects,
  animateGroupedTaskLayoutFrom,
  measureGroupedTaskPreviewWidth,
  measureGroupedGroupPreviewWidth,
  groupedTaskCollisionDetection,
  GROUPED_TASK_AUTO_SCROLL_THRESHOLD,
} from "@/project-sidebar/grouped/drag.js";
import { logger } from "@/logger.js";

/** 原 WorkspaceGroupedTasksSection 的手势生命周期；持久化替换为当前单节点命令。 */
export function useGroupedDrag({
  authoritativeView,
  collapsedGroupIds,
  onCollapsedGroupIdsChange,
  onMove,
}: {
  authoritativeView: ZCodeGroupedTaskView;
  collapsedGroupIds: Set<string>;
  onCollapsedGroupIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onMove(command: MoveGroupNode): Promise<void>;
}) {
  // [资源] root 是布局测量的唯一容器指针：矩形采集、宽度测量、动画起点都从这里出发。
  // 四个 useState 只描述「当前拖谁、多宽」，真正的数据快照在 ref 里，避免闭包读到旧值。
  // [并发] ref 写入不触发重渲染，可安全地在同一帧内先采集再提交预览。
  // 这些 ref 的初值必须在 reset 中统一回归，否则下一次手势会继承上次残留。
  const root = useRef<HTMLDivElement>(null);
  // preview 仅在拖拽期间非空：渲染层看到的是「投影视图」，不是权威视图。
  // 松手或取消后必须回到 null，让 authoritativeView 重新成为唯一渲染来源。
  // [权衡] 用 state 驱动重渲染而非 ref，换来动画正确性，代价是每次命中都要比对 signature。
  const [preview, setPreview] = useState<ZCodeGroupedTaskView | null>(null);
  const [activeTaskKey, setActiveTaskKey] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  // origin 冻结手势开始时的权威视图，用于结束阶段计算单节点命令。
  // latestPreview 记录最近一次有效预览，结束提交以它为准，再接 authoritativeView 兜底。
  const origin = useRef<ZCodeGroupedTaskView | null>(null);
  const latestPreview = useRef<ZCodeGroupedTaskView | null>(null);
  const direction = useRef<"before" | "after">("after");
  const deltaY = useRef(0);
  const lastOver = useRef<DragOverEvent | null>(null);
  const collapsedSnapshot = useRef<Set<string> | null>(null);
  const animationFrame = useRef<number | null>(null);
  const pendingPreview = useRef<ZCodeGroupedTaskView | null>(null);
  // activationConstraint.distance 设为 6 像素：低于阈值视为点击，避免误拖。
  // [权衡] 阈值过大手感迟钝，过小则右键菜单与文本选择会和拖拽抢事件。
  // 传感器在渲染期创建，useSensors 内部按稳定引用缓存，不会每次渲染重建监听。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // view 是渲染唯一入口：拖拽中读 preview，空闲时回落 authoritativeView。
  // 组件层不直接触碰 authoritativeView，避免绕过手势状态造成双源。
  const view = preview ?? authoritativeView;
  // [事务] 先采集旧布局矩形，再提交新预览，最后在下一帧做 FLIP 动画。
  // 同帧多次调用只保留最后一帧，前一帧通过 cancelAnimationFrame 撤销。
  // [失败路径] 采集发生在 DOM 更新前，节点缺失时矩形为空，动画退化为直接跳变。
  const animate = useCallback((next: ZCodeGroupedTaskView) => {
    const rects = collectGroupedTaskLayoutRects(root.current);
    setPreview(next);
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    animationFrame.current = requestAnimationFrame(() => {
      animationFrame.current = null;
      animateGroupedTaskLayoutFrom(root.current, rects);
    });
  }, []);
  useEffect(
    () => () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (!activeTaskKey && !activeGroupId) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [activeTaskKey, activeGroupId]);
  // 群组拖拽会临时展开目标组，取消或结束后按快照精确回滚。
  // [事务] 快照为空表示本次手势没动过折叠集，直接返回，不能误写空集合。
  // [失败路径] 不校验快照就把空值写回，会把用户原有折叠状态全部抹掉。
  const restoreCollapsed = () => {
    if (!collapsedSnapshot.current) return;
    onCollapsedGroupIdsChange(collapsedSnapshot.current);
    collapsedSnapshot.current = null;
  };
  // reset 是手势的单一收口：清身份、清宽度、清方向与增量缓存、回滚折叠集。
  // 所有可变 ref 都必须在同一处归零，避免分散清理漏掉某一项。
  // [资源] 不在这里撤销动画帧：动画属于预览生命周期，由 animate 与卸载 effect 负责。
  // reset 之后不得再读 origin 与 latestPreview，否则会拿到已清空的旧手势数据。
  const reset = () => {
    setActiveTaskKey(null);
    setActiveGroupId(null);
    setWidth(null);
    direction.current = "after";
    deltaY.current = 0;
    lastOver.current = null;
    origin.current = null;
    latestPreview.current = null;
    restoreCollapsed();
  };
  // onDragStart 冻结起点：origin 与 latestPreview 同时指向当次权威视图。
  // 群组分支先抓折叠快照再展开目标组，保证取消时能精确还原。
  // 宽度只在起点测量一次，拖拽中不再触碰 DOM 尺寸，避免强制同步布局。
  // [并发] 任务分支取不到 key 直接返回，此时宽度与活动身份都保持空，渲染回到空闲态。
  const onDragStart = (event: DragStartEvent) => {
    pendingPreview.current = null;
    direction.current = "after";
    deltaY.current = 0;
    lastOver.current = null;
    origin.current = authoritativeView;
    latestPreview.current = authoritativeView;
    setPreview(authoritativeView);
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    if (groupId) {
      collapsedSnapshot.current = new Set(collapsedGroupIds);
      setActiveGroupId(groupId);
      setWidth(measureGroupedGroupPreviewWidth(root.current, groupId));
      onCollapsedGroupIdsChange((current) => new Set(current).add(groupId));
    } else {
      const key = getGroupedTaskDragTaskKey(event.active.data.current);
      if (!key) return;
      setWidth(measureGroupedTaskPreviewWidth(root.current, key));
      setActiveTaskKey(key);
    }
  };
  // applyPreview 只做纯计算：把当前预览交给 drag.js 的层叠视图函数，得到下一份视图。
  // 组与任务走两条不同管道，组优先处理跨组命中，任务再逐层收敛到具体落点。
  // [事务] 引用相等或 signature 相同即视为无变化，直接返回，避免无意义的动画与重渲染。
  const applyPreview = (event: DragOverEvent) => {
    const taskKey = getGroupedTaskDragTaskKey(event.active.data.current);
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    if ((!taskKey && !groupId) || !event.over) return;
    const current = latestPreview.current ?? authoritativeView;
    const side = direction.current;
    const next = groupId
      ? getGroupedGroupOverTaskPreviewView(
          getGroupedGroupOverGroupPreviewView(current, event, side),
          event,
          side,
        )
      : getGroupedTaskOverTaskPreviewView(
          getGroupedTaskOverEmptyDropZonePreviewView(
            getGroupedTaskOverGroupFooterPreviewView(
              getGroupedTaskOverGroupHeaderPreviewView(
                getGroupedTaskOverCollapsedGroupPreviewView(current, event, side),
                event,
                side,
              ),
              event,
              side,
            ),
            event,
          ),
          event,
          side,
        );
    if (
      next === current ||
      getGroupedTaskViewSignature(next) === getGroupedTaskViewSignature(current)
    )
      return;
    latestPreview.current = next;
    animate(next);
  };
  // 方向由累计位移增量决定：向下记为 after，向上记为 before，相等时保持原方向。
  // [并发] 只有方向翻转且存在上次 over 时才重算预览，减少高频事件的计算量。
  const onDragMove = (event: DragMoveEvent) => {
    const previous = direction.current;
    if (event.delta.y > deltaY.current) direction.current = "after";
    else if (event.delta.y < deltaY.current) direction.current = "before";
    deltaY.current = event.delta.y;
    if (direction.current !== previous && lastOver.current) applyPreview(lastOver.current);
  };
  // lastOver 缓存最近一次带 over 的事件，供方向翻转时复用。
  // [失败路径] over 为空表示指针离开所有可投放目标，此时清空缓存且不应用预览。
  const onDragOver = (event: DragOverEvent) => {
    lastOver.current = event.over ? event : null;
    applyPreview(event);
  };
  const onDragCancel = () => {
    reset();
    setPreview(null);
  };
  // [事务] 结束阶段先算 `groupedMoveCommand` 再复位手势：命令为空时只清预览，不触达持久层。
  // source 从 origin 反查：组用 groupId，任务用 groupTaskRef 生成引用，避免持有整棵树。
  // groupedMoveCommand 对起点与终点做纯函数差分，原地未动自然得到空命令。
  // [并发] pendingPreview 按本次预览的身份收口，迟到的旧命令不能清除后来手势的预览。
  const onDragEnd = (event: DragEndEvent) => {
    const before = origin.current;
    const next = latestPreview.current ?? authoritativeView;
    const groupId = getGroupedTaskDragGroupId(event.active.data.current);
    const key = getGroupedTaskDragTaskKey(event.active.data.current);
    const task = before && key ? findTaskInGroupedView(before, key) : null;
    const source: GroupNode | null = groupId
      ? { type: "group", groupId }
      : task
        ? { type: "task", task: groupTaskRef(task) }
        : null;
    const command = before && source ? groupedMoveCommand(before, next, source) : null;
    reset();
    if (!command) {
      setPreview(null);
      return;
    }
    logger.debug("[task-groups] 旧版手势提交单节点", command);
    pendingPreview.current = next;
    setPreview(next);
    // 按这次手势的身份收口，旧命令迟到不能清除后来手势的预览。
    void onMove(command).finally(() => {
      if (pendingPreview.current !== next) return;
      pendingPreview.current = null;
      setPreview(null);
    });
  };
  // 返回值是 hook 的对外契约：root 供容器绑定，view 供渲染，dragging 供样式。
  // dnd 配置集中在此，命中算法与自动滚动阈值都来自 drag.js 的同一份常量。
  // [权衡] 自动滚动阈值随返回值透出，调用方不再重复定义，避免两处漂移。
  return {
    root,
    view,
    activeTaskKey,
    activeGroupId,
    width,
    dragging: Boolean(activeTaskKey || activeGroupId),
    dnd: {
      sensors,
      autoScroll: { threshold: GROUPED_TASK_AUTO_SCROLL_THRESHOLD },
      collisionDetection: groupedTaskCollisionDetection,
      onDragStart,
      onDragOver,
      onDragMove,
      onDragEnd,
      onDragCancel,
    },
  };
}
