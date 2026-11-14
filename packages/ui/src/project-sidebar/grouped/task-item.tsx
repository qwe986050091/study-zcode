// INV-01 空分组拖放区独立组件：守住位置 EmptyGroupDropZone；改错故障 分区逻辑重复。
// INV-02 拖放标识带分组前缀：守住位置 拖放 id；改错故障 多个空分组互相覆盖。
// INV-03 点击不冒泡到分组：守住位置 stopPropagation；改错故障 点击创建同时触发选中。
// INV-04 指针与触摸同样阻止冒泡：守住位置 三个事件；改错故障 移动端触发父级拖拽。
// INV-05 拖放区可访问性保留：守住位置 button 元素；改错故障 键盘无法触发创建。
// INV-06 文案走国际化：守住位置 formatMessage；改错故障 硬编码中文。
// INV-07 列表项组件纯展示：守住位置 GroupedTaskItemComponent；改错故障 组件内私藏业务状态。
// INV-08 回调全部由外部注入：守住位置 props 结构；改错故障 内部直接访问 store。
// INV-09 分组标识可为空：守住位置 groupId 可选；改错故障 未分组任务无法渲染。
// INV-10 远程会话标识透传：守住位置 remoteSessionId；改错故障 远程任务操作打到本地。
// INV-11 工作区身份透传：守住位置 activeWorkspaceIdentity；改错故障 同名路径工作区串数据。
// INV-12 当前任务标识透传：守住位置 activeTaskId；改错故障 选中态错误。
// INV-13 拖拽状态透传：守住位置 dragging 与 dragOverlay；改错故障 拖影与占位不一致。
// INV-14 提示可按场景禁用：守住位置 tooltipsDisabled；改错故障 拖拽时提示遮挡。
// INV-15 行容器样式统一：守住位置 外层 div；改错故障 悬浮态与分组不一致。
// INV-16 记忆化避免重复渲染：守住位置 memo 包装；改错故障 大列表每次全量重绘。
// INV-17 所有属性原样下传：守住位置 GroupedTaskRow；改错故障 新增属性在半路丢失。
// INV-18 组件只负责布局：守住位置 单一返回；改错故障 副作用散落在渲染路径。
//
// 模块职责：渲染分组侧栏中的单个任务行，并提供空分组拖放区。
// 状态所有权：无；任务数据与回调全部由上层注入。
// 阅读顺序：先看空分组拖放区，再看任务行组件，最后看记忆化导出。
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";

import { MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/shared.js";

// useDroppable() 的 id 拼成 group-empty-drop:${groupId}，空分组之间不冲突。
// onClick() 先 stopPropagation() 再调用 onCreateTask()。
// onMouseDown()、onPointerDown() 与 onTouchStart() 都阻止冒泡。
// 按钮文案取 taskGroup.emptyDropZoneAction，组件内不写死中文。
export function EmptyGroupDropZone({
  groupId,
  onCreateTask,
}: {
  groupId: string;
  onCreateTask: () => void;
}) {
  // 文案统一走国际化。
  // useZCodeIntl() 拿到的 intl 是唯一文案来源。
  // 缺失键由 provider 兜底。
  const { intl } = useZCodeIntl();
  // useDroppable() 让空分组也注册成可放置区域。
  // data 里带 grouped-empty-drop-zone 与 groupId，供拖拽回调识别。
  // 节点引用交给 button。
  const droppable = useDroppable({
    id: `group-empty-drop:${groupId}`,
    data: {
      type: "grouped-empty-drop-zone",
      groupId,
    },
  });
  return (
    <button
      ref={droppable.setNodeRef}
      type="button"
      data-grouped-empty-drop-zone-id={groupId}
      className={cn(
        "flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-2 text-center text-ui-base text-foreground-subtle transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-border-hover hover:bg-surface-hover hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0">{intl.formatMessage({ id: "taskGroup.emptyDropZoneAction" })}</span>
    </button>
  );
}

// GroupedTaskItemComponent 的 props 全部由上层注入，不直接访问 store。
// remoteSessionId 原样透传给 GroupedTaskRow。
// 本组件只组合 GroupedTaskRow 与外壳 div。
function GroupedTaskItemComponent({
  task,
  groupId,
  groups,
  remoteSessionId,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  groupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-transparent py-px")}>
      <GroupedTaskRow
        task={task}
        currentGroupId={groupId}
        groups={groups}
        remoteSessionId={remoteSessionId}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        mobileActiveTaskKey={mobileActiveTaskKey}
        workspaceLabel={workspaceLabel}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={dragId}
        dragging={dragging}
        dragOverlay={dragOverlay}
        tooltipsDisabled={tooltipsDisabled}
      />
    </div>
  );
}

// GroupedTaskItem 用 memo() 包装，属性不变时跳过重渲染。
// props 通过展开原样下传给 GroupedTaskRow。
// memo() 返回的引用稳定，可安全作为依赖项。
export const GroupedTaskItem = memo(GroupedTaskItemComponent);
