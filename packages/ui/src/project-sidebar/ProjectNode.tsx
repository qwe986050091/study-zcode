// INV-01 在线才可编辑：守住位置 editable 组合；改错故障 离线节点仍可接收会话拖入。
// INV-02 单根旧项目禁拖入：守住位置 legacySingleRoot；改错故障 旧协议项目出现无效放置目标。
// INV-03 拖入用深度计数：守住位置 dragDepth；改错故障 子元素切换导致高亮闪烁。
// INV-04 深度归零才复位：守住位置 归零判断；改错故障 拖过子节点就丢高亮。
// INV-05 拖出与松手都清理：守住位置 两个文档监听；改错故障 高亮残留不消失。
// INV-06 监听走捕获阶段：守住位置 第三参数为真；改错故障 子组件阻止冒泡后收不到事件。
// INV-07 目录失效不折叠：守住位置 isOpen 组合；改错故障 主目录缺失时历史消息不可见。
// INV-08 手机远端禁用排序：守住位置 isWebRemoteControl；改错故障 滑动列表误触发拖动。
// INV-09 拖拽数据只含稳定字段：守住位置 useMemo 两键；改错故障 数据变化引发重排抖动。
// INV-10 落点由同一状态推导：守住位置 dropPosition 计算；改错故障 提示位置与提交目标分叉。
// INV-11 落点仅在非拖动时显示：守住位置 isDragging 取反；改错故障 被拖动项自身出现插入线。
// INV-12 只与同置顶状态比较：守住位置 pinned 相等判断；改错故障 置顶与普通项互相插入。
// INV-13 缩放被显式还原：守住位置 两个缩放分量；改错故障 高度不一时活动项被拉伸。
// INV-14 层级按状态提升：守住位置 zIndex 三元；改错故障 插入线被相邻项遮挡。
// INV-15 放置只认会话载荷：守住位置 载荷解析函数；改错故障 普通文件拖入触发移动。
// INV-16 放置效果标记为移动：守住位置 dropEffect；改错故障 光标显示复制语义。
// INV-17 远端身份只对单根生成：守住位置 主机与根数判断；改错故障 本地项目被写入远端身份。
// INV-18 本组件不持有排序结果：守住位置 全部交给排序库；改错故障 拖动结束状态与列表不一致。
//
// 模块职责：侧边栏单个项目节点，组合排序、折叠与会话拖入放置。
// 状态所有权：拖入高亮与深度为局部状态；排序与折叠状态由外部持有。
// 阅读顺序：先看可编辑判定，再读拖入监听与落点推导，最后看节点渲染。
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Collapsible } from "@/components/ui/collapsible.js";
import { ProjectNodeContent, type ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { projectKey } from "@/project-sidebar/view.js";
import { parseWorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";

export function ProjectNode(props: ProjectNodeProps) {
  const { project, expanded, onExpandedChange, onMove } = props;
  const { isWebRemoteControl = false } = useContext(ProjectTaskListContext);
  const online = props.availability?.online ?? true;
  const editable = online && !project.legacySingleRoot;
  const [sessionDropOver, setSessionDropOver] = useState(false);
  const dragDepth = useRef(0);
  const sessionDropTarget = editable && sessionDropOver;
  useEffect(() => {
    if (!editable) {
      dragDepth.current = 0;
      setSessionDropOver(false);
    }
    if (!sessionDropTarget) return;
    const clear = () => {
      dragDepth.current = 0;
      setSessionDropOver(false);
    };
    // Escape 或在其他区域松手时，源节点才收到 dragend；目标也要清除临时高亮。
    // dragend 只在源节点触发：另一个区域松手时目标收不到，必须由 document 捕获阶段兜住
    // drop 也走捕获阶段：子元素 stopPropagation 后冒泡到不了目标，高亮会卡住
    // 两个监听共用 clear：松手位置不受控，只在目标内清理会残留高亮
    // dragDepth 与 sessionDropOver 必须一起复位：只清一个会让下一次 enter 从旧深度继续加
    // effect 清理移除两个监听：document 级监听不随组件卸载自动回收，会泄漏并操作已卸载状态
    document.addEventListener("dragend", clear, true);
    document.addEventListener("drop", clear, true);
    return () => {
      document.removeEventListener("dragend", clear, true);
      document.removeEventListener("drop", clear, true);
    };
  }, [editable, sessionDropTarget]);
  // 主目录失效限制新建和文件入口，历史消息由独立存储读取；不能把目录存在性当作折叠开关。
  // canOpen 取 online：离线节点展开后子树全是失效入口，等于给用户死路
  // primaryRootStatus 不进 canOpen：目录失效只影响新建与文件入口，折叠仍要能开
  // isOpen = canOpen && expanded：离线时即使 expanded 为真也不渲染子树，收起状态不被改写
  // onOpenChange 里再过一次 canOpen：离线节点被点开的请求丢弃，不回写外部 expanded
  // 历史消息走独立存储，不依赖主目录存在：目录失效不等于会话丢失
  // canOpen 只控制展开，editable 才控制拖入：目录失效的项目仍可接收会话
  const canOpen = online;
  const isOpen = canOpen && expanded;
  // data 只含 hostId 与 pinned：多放字段会让排序库认为数据变了，拖动中途重排
  // 依赖数组与两个键一一对应：多列依赖会重建对象，少列则读到旧值
  // useMemo 保住引用稳定：每次渲染新建对象会让 dnd-kit 丢掉当前排序上下文
  // 这份 data 随排序提交一起回传：落点比较读到的是拖动开始时的 pinned，不是中途改的
  // 不放 project 整体：它每次列表刷新都换引用，放进依赖会让 memo 形同虚设
  const data = useMemo(
    () => ({ hostId: project.hostId, pinned: project.pinned }),
    [project.hostId, project.pinned],
  );
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
    active,
    activeIndex,
    index,
    isOver,
  } = useSortable({
    id: projectKey(project),
    // 修复原因：共享项目行曾在手机注册排序手势，滑动列表会误拖；由入口统一禁用。
    disabled: isWebRemoteControl,
    data,
  });
  // 原因：仅有排序位移无法明确落点；直接读取同一拖拽状态，避免提示与提交目标分叉。
  // dropPosition 要求 isOver 且非 isDragging：被拖动项自身不能显示插入线
  // activeIndex 必须 ≥0：拿不到活动项下标时无法判断前后，直接不显示插入线
  // active.data.current.pinned 必须等于 project.pinned：跨置顶分组不画插入线
  // activeIndex > index 时落点在 before：下标比较反了会把插入线画到反方向
  // 条件不满足时返回 null：宁可没有提示，也不给一个会提交到错误位置的提示
  const dropPosition =
    isOver &&
    active &&
    !isDragging &&
    activeIndex >= 0 &&
    active.data.current?.pinned === project.pinned
      ? activeIndex > index
        ? "before"
        : "after"
      : null;
  return (
    <Collapsible
      asChild
      open={isOpen}
      onOpenChange={(value) => {
        if (canOpen) onExpandedChange(value);
      }}
    >
      <section
        ref={setNodeRef}
        style={{
          // 原因：项目高度不一致时 dnd-kit 会缩放活动项；只保留排序位移。
          transform: transform
            ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
            : undefined,
          transition,
          position: "relative",
          zIndex: dropPosition ? 20 : isDragging ? 10 : undefined,
        }}
        data-project-id={project.id}
        data-project-host={project.hostId}
        data-project-workspace-identity={
          project.hostId !== "local" && project.roots.length === 1
            ? buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0]!.rootPath)
            : undefined
        }
        data-connection-state={props.remoteHost?.connectionStatus}
        data-project-name={project.name}
        data-primary-root-status={project.primaryRootStatus}
        className={`min-w-0 rounded-xl ${sessionDropTarget ? "bg-accent" : ""}`}
        onDragEnter={(event) => {
          if (!editable || !parseWorkbenchSessionDragPayload(event.dataTransfer)) return;
          dragDepth.current++;
          setSessionDropOver(true);
        }}
        onDragLeave={() => {
          // 子节点切换也会发 enter/leave；只在退出整个项目时移除容器反馈。
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setSessionDropOver(false);
        }}
        onDragOver={(event) => {
          if (!editable) return;
          if (parseWorkbenchSessionDragPayload(event.dataTransfer)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setSessionDropOver(false);
          if (!editable) return;
          event.preventDefault();
          const task = parseWorkbenchSessionDragPayload(event.dataTransfer);
          if (task)
            onMove({
              workspacePath: task.workspacePath,
              workspaceIdentity: task.workspaceIdentity,
              taskId: task.sessionId,
            });
        }}
      >
        {sessionDropTarget && (
          <div
            aria-hidden="true"
            data-testid="project-session-drop-target"
            className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-icon-blue"
          />
        )}
        {dropPosition && (
          <div
            aria-hidden="true"
            data-testid="project-drop-indicator"
            data-drop-position={dropPosition}
            className={`pointer-events-none absolute left-5 right-2 z-20 h-0.5 bg-icon-blue ${dropPosition === "before" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"}`}
          >
            <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full border-2 border-icon-blue bg-sidebar" />
          </div>
        )}
        <ProjectNodeContent
          {...props}
          editable={editable}
          dragEnabled={!isWebRemoteControl}
          canOpen={canOpen}
          isOpen={isOpen}
          attributes={attributes}
          listeners={listeners}
          setActivatorNodeRef={setActivatorNodeRef}
        />
      </section>
    </Collapsible>
  );
}
