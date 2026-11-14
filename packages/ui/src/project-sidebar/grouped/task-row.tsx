// task-row.tsx —— 项目侧栏分组视图里的任务行：一行承载标题、状态点、交互胶囊、拖拽与右键菜单。
// 做：把任务元数据渲染成可点击行，转发选中/关闭/置顶/文件树/归档等动作；接上拖拽与可放置；
//     悬停或聚焦时挂载操作按钮，右键时挂载菜单内容；拖动中的叠加层复用同一份展示结构。
// 不做：不拉取任务列表、不排序、不做分组归属计算，也不写任何持久化状态。
// 依赖：dnd-kit 提供拖拽与放置，Radix 提供右键菜单与气泡，标签 store 提供只读判定。
// 被调用：分组任务列表与拖拽叠加层；所有回调由列表容器注入。
// 边界：只读状态只关闭写操作入口，不影响选择与查看；不直接访问服务或仓库。
// 状态归属：行内只保留悬停、焦点、菜单开合与触屏判定，任务事实全部来自注入的元数据。
//
// INV-01 断言：叠加层路径必须只做纯展示 —— 守住它的位置：if (dragOverlay) return taskRow —— 改错故障：拖动时每帧触发右键菜单订阅与路径查询，明显掉帧。
// INV-02 断言：工作区键统一用身份优先、路径兜底 —— 守住它的位置：buildTaskWorkspaceKey 的调用 —— 改错故障：远端与本地同路径被当成同一工作区，高亮与操作串台。
// INV-03 断言：活跃判定必须同时比对工作区键与任务标识 —— 守住它的位置：isActive 的两个与条件 —— 改错故障：不同工作区的同名任务同时高亮。
// INV-04 断言：移动端活跃键的拼接格式固定为工作区键加冒号加任务标识 —— 守住它的位置：isMobileActive 的模板字符串 —— 改错故障：格式漂移后手机端当前任务不再高亮。
// INV-05 断言：只读判定必须走 selector —— 守住它的位置：useOptionalTabStore 的选择器 —— 改错故障：整对象订阅会让任一标签变化都重渲染整行列表。
// INV-06 断言：远端任务没有会话标识时禁用文件树入口 —— 守住它的位置：canOpenFileTree 的条件 —— 改错故障：点击后被解析器拒绝，用户看到无反馈的失败。
// INV-07 断言：待处理交互优先于注意力徽章与相对时间 —— 守住它的位置：hasPendingInteraction 与渲染分支顺序 —— 改错故障：同一行并排出现两个状态，标题被挤压。
// INV-08 断言：加载态与状态点互斥 —— 守住它的位置：leadingIndicator 的三元链 —— 改错故障：转圈与色点同时出现，状态语义冲突。
// INV-09 断言：定时与错峰图标只在没有待处理交互时出现 —— 守住它的位置：两个图标的条件 —— 改错故障：图标与交互胶囊挤在同一行，右侧溢出。
// INV-10 断言：标题必须有兜底文案 —— 守住它的位置：taskTitle 的或运算与格式化 —— 改错故障：空标题行变成可点击的空白，无法辨认。
// INV-11 断言：标题溢出用渐隐而不是省略号 —— 守住它的位置：TaskTitleOverflowText 的使用 —— 改错故障：省略号与右侧元信息挤在一起，标题读不全。
// INV-12 断言：右键菜单打开时必须禁用拖动 —— 守住它的位置：dragDisabled 的 contextMenuOpen 项 —— 改错故障：在菜单上滑动被识别为拖拽，任务意外移动。
// INV-13 断言：拖拽与放置必须共用同一个 DOM 节点 —— 守住它的位置：setTaskRowRef 同时喂两套句柄 —— 改错故障：只能拖不能放，或只能放不能拖。
// INV-14 断言：缺少拖拽标识时仍要使用稳定占位标识 —— 守住它的位置：useDraggable 的 id 兜底 —— 改错故障：每次渲染换 id，拖拽中途丢失跟随。
// INV-15 断言：附加数据的类型标记是放置方唯一识别依据 —— 守住它的位置：useDraggable 与 useDroppable 的 data —— 改错故障：类型改名后放置逻辑静默拒绝所有任务。
// INV-16 断言：写操作入口必须在校验前阻止默认行为与冒泡 —— 守住它的位置：三个点击处理器的前两行 —— 改错故障：点关闭按钮顺带选中任务，打开新会话。
// INV-17 断言：键盘激活只响应事件源就是当前行 —— 守住它的位置：handleKeyDown 的 target 判断 —— 改错故障：行内按钮回车时同时触发整行选中。
// INV-18 断言：操作按钮由交互状态决定挂载，不用样式显隐 —— 守住它的位置：shouldMountHoverActions —— 改错故障：弹层在指针到达后才获得尺寸，提示框定位漂移。
// INV-19 断言：元信息只在真实悬停或焦点内时让位 —— 守住它的位置：shouldSuppressTaskMetadata —— 改错故障：触屏设备永久丢失时间与状态点。
// INV-20 断言：右键菜单内容只在打开时挂载 —— 守住它的位置：contextMenuOpen 的条件渲染 —— 改错故障：常驻挂载会在拖拽重排时触发嵌套更新循环。
//
// 阅读顺序：先看纯计算的派生状态，再看叠加层的提前返回，最后看拖拽句柄与交互状态驱动的渲染分支。
// 常见误改：把 dragDisabled 里的菜单条件删掉、把叠加层分支挪到 Hook 之后、把只读判定改成整对象订阅。
// 与外部的关系：属性回调签名是对外契约，列表容器依赖这些签名，改名属于破坏性变更。
// 测试关注点：只读工作区的写入口、远端未就绪时的文件树入口、触屏设备的常驻操作按钮。
// 样式边界：类名只表达布局、层级与语义色，行高与间距沿用分组行的公共类。
// 性能边界：派生状态每次渲染重算，成本可忽略；重活是路径查询，已按菜单打开状态懒加载。
// 可访问性：整行是 role=button 的容器，行内按钮各自可聚焦，避免嵌套原生按钮。
// 国际化边界：全部文案经格式化函数产出，本文件不保留硬编码文案。
// 维护提示：新增右侧状态时先确定优先级，再同步时间、图标与操作区三处条件。
// 安全边界：反馈草稿会携带任务与会话路径，本文件只组织内容，不负责脱敏与上报。
import { TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { memo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask } from "@zcode/shared";
import { ArrowUpToLine, Clock, Cloud, Folder, ListTree, LoaderIcon, Moon, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { formatGroupedTaskHoverChangeParts } from "@/project-sidebar/grouped/task-row-tooltip.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/project-sidebar/grouped/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

// [契约] 这是分组任务列表的单行实现，属性全部由列表容器注入，自己不取数据。
// 任务元数据、分组列表与回调一起传入，保证拖动预览与真实列表复用同一份渲染逻辑。
// [边界] 组件不订阅任务集合，也不做排序，顺序由上游分组视图决定。
// 拖拽标识可选：没有标识时依然可以正常渲染与点击，只是不能拖。
// [权衡] 属性面板很长但保持平铺，避免为每种入口定义新的上下文对象。
function GroupedTaskRowComponent({
  task,
  currentGroupId,
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
  currentGroupId?: string;
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
  // [契约] 国际化实例从 Provider 取，本文件不引入新的文案来源。
  // 所有可见文案都经格式化函数产出，包括相对时间、状态标签与无障碍名称。
  // [边界] 这里不缓存格式化结果，语言切换后立即生效。
  // [权衡] 不为每一行单独建格式化器，复用 Provider 实例，减少分配。
  // 文案标识属于对外契约，改名会同时影响翻译资源，需成对修改。
  const { intl } = useZCodeIntl();
  // [契约] 只读判定通过选择器订阅工作区标识，不整对象订阅整个标签 store。
  // 选择器返回布尔，引用稳定，避免无关字段变化触发整行重渲染。
  // [边界] 只读只影响写操作入口，不影响选择、展开与复制。
  // [失败路径] 缺少标签 Provider 时选择器返回可用，保证独立渲染不因缺上下文报错。
  // [权衡] 判定放在行内而不是列表层，让每一行只关心自己的 workspacePath 与 workspaceIdentity。
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  // [契约] 交互自动解除的订阅按任务会话建立，工作区与远端会话标识都可选。
  // 可选参数用条件展开而不是传空值，避免订阅键出现字符串形式的空值。
  // [边界] 该钩子只负责倒计时与解除，不在这里处理点击后的跳转。
  // [资源] 订阅随行卸载自动释放，不要在渲染中手动创建第二个 useTaskInteractionAutoResolutionSnooze()。
  // [并发] 拖动预览里不挂该订阅，避免叠加层产生重复副作用。
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  // [契约] 工作区键统一用身份标识优先、路径兜底，全仓同一口径。
  // 不要改成只拼路径：远端与本地同路径会被误判成同一工作区。
  // [边界] 该键用于比较与条件拼接，不用于请求参数，请求仍传原始路径与身份。
  // [权衡] 每次渲染重新计算，避免缓存键与身份更新不同步。
  // 移动端活跃键与它共用同一格式，改动必须同步。
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  // [契约] 行活动与注意力信息都是纯派生，不写入任何状态。
  // taskActivity 由 getTaskListRowActivity() 派生，决定标题下是否追加运行行。
  // [边界] 这里只读取任务元数据，不触发远端查询。
  // [权衡] taskActivity 派生放在行内而不是列表层，允许拖动预览拿到同样的展示结果。
  // [失败路径] 元数据字段缺失时派生返回空，渲染自动省略对应区域。
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // 交互胶囊是当前最高优先级的右侧状态；无论来自 sessions-index 摘要还是
  // activity attention，都不应再并排显示相对时间并挤压任务标题。
  // [契约] 待处理交互是右侧最高优先级状态，优先于注意力徽章与相对时间。
  // 注意力徽章有两条来源：task.pendingInteraction 与 taskAttention，任一存在即视为有交互。
  // [边界] 该布尔只影响展示，不改变任务的实际状态。
  // [权衡] 用 hasPendingInteraction 布尔汇总而不是直接判空，让三个渲染分支共用同一个条件。
  // 改动优先级必须同时检查时间、图标与操作区的条件，否则会出现双状态并排。
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // Bugfix：远端 session 未就绪时打开文件树必然会被 resolver 拒绝，因此不要暴露
  // 无效 action；本地 task 不需要 remoteSessionId，仍保持入口可用。
  // [契约] 打开文件树需要回调存在，且远端任务必须已有可用会话。
  // 本地任务没有远端会话标识，因此不受该限制。
  // [边界] 这里只判断入口可用性，不校验目录是否存在。
  // [失败路径] 远端会话未就绪时隐藏入口，避免点击后被解析器拒绝。
  // [权衡] canOpenFileTree 选择隐藏而不是禁用，减少用户对不可用按钮的无效尝试。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskChangeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  // [契约] 活跃判定必须同时匹配工作区键与任务标识，二者缺一不可。
  // 只比任务标识会让不同工作区里的同名任务一起高亮。
  // [边界] 高亮属于展示态，不触发选中回调。
  // [并发] 活跃键在拖动预览里也参与计算，保证预览与真实行一致。
  // [权衡] 每次渲染计算两个键，成本极低，避免缓存过期。
  const isActive =
    buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity) === workspaceKey &&
    activeTaskId === task.taskId;
  const isMobileActive = mobileActiveTaskKey === `${workspaceKey}:${task.taskId}`;
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // Bugfix: grouped task 未读点需要和普通 task list 共用 sky 色，避免 brand 色在不同主题下表达漂移。
          "bg-sky-500 dark:bg-sky-400"
        : null;
  // [契约] 叠加层不提供悬停操作，它只是拖动中的视觉替身。
  // dragOverlay 为真时 canShowHoverActions 为假，同时控制悬停态样式与操作按钮分支。
  // [边界] 真实行即使被禁用拖动，仍然可以显示操作按钮。
  // [权衡] 用组件级布尔而不是媒体查询，保证行为在测试里可预测。
  // 新增操作按钮时也要受它约束，否则叠加层会出现可点击的空按钮。
  const canShowHoverActions = !dragOverlay;
  // 工作流运行行：分组行同样长在标题下；
  // drag overlay 只是纯展示，不挂确认副作用与点击入口。
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // drag overlay 也复用 grouped row 元信息；clock 放时间前面，不能跟未读点互斥。
              <Clock
                data-cron-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : !hasPendingInteraction && isTaskOffPeak ? (
              <Moon
                data-off-peak-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
            {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
          </span>
        </span>
      </span>
    </div>
  );

  // DragOverlay 高频渲染时只返回纯展示节点，避免隐藏 action tooltip 的 Radix ref 循环和 task 路径 RPC。
  // [契约] 叠加层路径只返回纯展示节点，不注册状态、订阅与路径加载。
  // 提前返回必须发生在第二组 Hook 之前，否则叠加层会执行右键菜单的懒加载。
  // [边界] 这里的任务行不含拖拽句柄与点击语义，仅用于跟随指针绘制。
  // [权衡] dragOverlay 复制一份展示结构而不是复用交互行，代价是两处样式需同步。
  // [失败路径] 删掉该分支后，拖动时每帧都会触发路径查询，明显掉帧。
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  // [契约] 触屏判定只在首次挂载读取一次，避免每次渲染都调用媒体查询。
  // 惰性初始化保证服务端渲染时不访问 window。
  // [边界] 该值只用于常驻操作按钮，不改动其他元信息。
  // [权衡] 不监听媒体查询变化：设备输入方式在会话内极少变化。
  // 若未来支持外接鼠标热插拔，应改成订阅而不是在这里加轮询。
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  // [契约] 反馈入口从反馈 store 只取打开动作，不订阅其状态。
  // [边界] 行组件只负责组织草稿内容，提交过程由反馈面板负责。
  // [资源] 选择器返回稳定引用，不会因反馈草稿变化而重渲染该行。
  // [权衡] 不自建反馈弹窗，避免每个任务行持有一份弹窗状态。
  // 失败上报的日志与截图归属由反馈 store 决定，本文件不参与。
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
    loadProviderConfig: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = async () => {
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };
  // [契约] 键盘激活只响应事件源就是当前行的情况，避免子按钮的回车冒泡触发选中。
  // handleKeyDown 只接受 "Enter" 与 " "，其余按键保持浏览器默认行为。
  // [边界] 这里不处理 Escape 与方向键，列表级导航由上游负责。
  // [失败路径] 阻止默认行为必须发生在选中之前，否则空格会滚动页面。
  // [并发] 选中回调直接调用，不做去重，重复触发由上游切换逻辑吸收。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  // [契约] 只读、缺少拖拽标识、右键菜单打开、叠加层四种情况都禁用拖动。
  // 右键菜单打开时必须禁用，否则菜单上的指针移动会被识别成拖拽。
  // [边界] 禁用只影响拖动，不影响点击、键盘与右键。
  // [权衡] 用单个布尔汇总而不是分散判断，保证可拖与可放置的口径一致。
  // 新增 dragDisabled 条件时，这里与 useDroppable() 的禁用条件要一起评估。
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  // [契约] 拖拽标识优先使用外部注入，缺失时使用带禁用前缀的稳定占位标识。
  // 占位标识包含工作区键与任务标识，保证同一行在不同渲染中不换标识。
  // 附加数据里的类型标记是放置逻辑识别任务来源的唯一依据。
  // [边界] 这里不定义拖拽视觉，跟随指针的样式由叠加层负责。
  // [并发] 拖动开始与结束由列表层 useDraggable/useDroppable 统一处理，行组件不监听。
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  // [契约] 可放置与可拖动共用同一个标识，任务既能被拖也能作为落点。
  // 只读或缺少标识时禁用放置，避免把任务拖进不可写的工作区。
  // data.type 同为 "grouped-task"，放置方据此判断是否接受。
  // [边界] 这里不计算插入位置，位置由碰撞检测与预览函数决定。
  // [权衡] 不在行内做落点高亮，避免每行维护一份悬停状态。
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  // [契约] 同一个 DOM 节点必须同时交给拖拽与放置两套句柄。
  // 只喂一个会导致可拖但不可放，或可放但拖不起来，症状很隐蔽。
  // [边界] 回调允许空值，卸载时两套句柄都要收到空值以释放引用。
  // [权衡] 用内联函数而不是缓存，节点引用变化频率低，不值得加记忆化。
  // 新增第三套句柄时必须同样在这里汇合，避免多套引用各自为政。
  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug 原因：CSS hidden → flex 会让 action trigger 在 pointer 到达时才获得布局尺寸，
  // Tooltip Portal 可能先以未定位坐标绘制。改为交互状态决定 action 是否挂载，
  // 同时保留键盘、触摸设备和手机远控 active task 的入口。
  // [契约] 操作按钮由交互状态决定是否挂载，不依赖样式显隐。
  // 挂载条件包含悬停、焦点在行内、触屏设备与移动端活跃任务。
  // [边界] 存在待处理交互时不挂载操作按钮，避免与交互胶囊抢位置。
  // [权衡] 触屏设备常驻操作按钮，是为了 isHoverNone 时仍可操作。
  // [失败路径] 用样式隐藏会让弹层在指针到达时才拿到尺寸，出现定位漂移。
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // 触屏端 isHoverNone 只负责常驻 action；时间、状态点和 cron/off-peak 元信息
  // 仍应保留，仅在真实 hover / focus 交互时让位，避免手机端永久丢失任务状态。
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <div
      ref={setTaskRowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setTaskRowHovered(true)}
      onMouseLeave={() => setTaskRowHovered(false)}
      onFocusCapture={() => setTaskRowFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTaskRowFocusWithin(false);
        }
      }}
      data-grouped-task-key={groupedTaskDomKey}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // 可交互 grouped row 之前漏渲染 clock，导致 Projects 分组里的定时任务没有 icon。
                // 这里和普通 task list 一样放在时间前面，同时不再被未读/运行状态顶掉。
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={handleOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={handleMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={handleCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );

  // grouped row 不能用原生 button 承载整行；行内还有菜单、关闭、文件树等 button，外层继续用 role=button，避免嵌套 button 破坏键盘和右键菜单语义。
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // overlay 拖拽时指针下方的真实 row 仍可能被 Radix 识别为 hover，跳过 TooltipTrigger 避免底层 row 或 action 弹出悬浮提示。
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" sideOffset={6}>
            {remoteSessionId ? (
              <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Folder aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 max-w-48 truncate">{workspaceLabel}</span>
            {taskChangeParts.length > 0 ? (
              <>
                <span className="text-tooltip-foreground/60">·</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  {taskChangeParts.map((part) => (
                    <span
                      key={part}
                      className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
                    >
                      {part}
                    </span>
                  ))}
                </span>
              </>
            ) : null}
          </TooltipContent>
        </Tooltip>
      )}
      {contextMenuOpen ? (
        // 右键菜单内容带 Radix Presence/Portal，拖拽重排时常驻挂载会触发嵌套更新循环；仅在菜单打开时挂载内容，配合路径懒加载避免拖拽过程刷 task path RPC。
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          providerConfigFile={providerConfigFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenProviderConfig={() => void handleOpenProviderConfig()}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
// [契约] 对外只导出 memo 包裹后的组件，内部实现不导出。
// memo 生效依赖上游回调引用稳定，列表层应使用稳定回调。
// [权衡] 不做自定义比较函数，属性多且包含对象，浅比较已足够。
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
