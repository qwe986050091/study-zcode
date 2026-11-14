//
// 文件职责：任务列表行（默认列表与 timeline 两行布局）的展示与行内动作，
// 并导出右键菜单内容组件 TaskListItemContextMenuContent。
// 职责边界：只消费已投影的 task meta 与 activity sidecar；不拥有任务队列与已提交输入，
// 不直接访问服务或 Repo，所有写操作通过 props 回调上抛给列表容器。
//
// 不变量（INV）：
// INV-01 断言：memo 比较必须覆盖全部影响渲染的 props，包括 intl 与回调引用。
//        位置：areTaskListItemPropsEqual；故障：行不刷新或整列表误刷新，拖拽与确认态卡住。
// INV-02 断言：task 只按白名单字段比较，不能退化成对象身份比较。
//        位置：areTaskListItemTaskFieldsEqual；故障：上游替换对象但字段相同时整列表重渲染。
// INV-03 断言：JSON 字段比较前必须把 undefined 归一为 null。
//        位置：areJsonFieldsEqual；故障：null 与 undefined 被当成不同值，行抖动刷新。
// INV-04 断言：自动化身份兼容 cronAutomationId 与旧 automationId 两个字段。
//        位置：getTaskAutomationIdentity；故障：旧任务改名后行显示错乱。
// INV-05 断言：行内动作禁用状态由 actionsDisabled 与 workspace 只读态合成。
//        位置：workspaceActionsDisabled 的 useOptionalTabStore selector；故障：只读 workspace 仍可归档或置顶。
// INV-06 断言：归档确认态的点击边界用组件自身 ref 判断，不拼 CSS selector。
//        位置：handlePointerDown 的 itemRef.current?.contains；故障：Windows 反斜杠路径被当转义，确认被误取消。
// INV-07 断言：鼠标离开只清 hover，不得取消归档确认。
//        位置：handleMouseLeave；故障：确认按钮刚出现就消失，二次确认无法完成。
// INV-08 断言：仅未禁用、分屏可用且不在工作台分组时才允许拖拽。
//        位置：canDragToWorkbench；故障：拖入自己的工作台分组产生重复标签。
// INV-09 断言：拖拽 effectAllowed 必须是 copyMove，而不是单一 copy。
//        位置：handleDragStart 的 dataTransfer.effectAllowed；故障：项目侧拒绝 move/drop。
// INV-10 断言：拖拽 payload 必须同时写入内部 MIME 与 text/plain。
//        位置：handleDragStart 的两次 setData；故障：外部应用拿不到标题，内部拖拽拿不到会话。
// INV-11 断言：drag preview 的清理必须在下一帧执行。
//        位置：ownerWindow.requestAnimationFrame(cleanupDragPreview)；故障：同步清理会抹掉浏览器正在生成的预览。
// INV-12 断言：归档与置顶必须先拦截只读 workspace，再执行业务回调。
//        位置：handleArchive / handleTogglePin 的 workspaceActionsDisabled 判断；故障：只读目录产生静默失败写操作。
// INV-13 断言：任务选择必须经过 runUserAction 记录，不能直接调用 onSelectTask。
//        位置：handleSelect；故障：埋点缺失，任务打开链路无法统计。
// INV-14 断言：leading 槽优先级固定为 error > unread > loading，手机激活时让位。
//        位置：leadingIndicator 与 showPinnedState；故障：置顶图标盖住错误或手机标记。
// INV-15 断言：hover 只抑制元信息，不得卸载整行动作容器。
//        位置：shouldSuppressWorkspaceTaskMetadata / shouldMountWorkspaceTaskActions；故障：触摸端首击只进入 hover。
// INV-16 断言：pin 只在 hover:none 或抑制元信息时接管 leading 槽。
//        位置：shouldRenderPinAction；故障：Pin 永久替换未读与 loading 状态。
// INV-17 断言：cron / off-peak 图标归属时间列，不占左侧状态槽。
//        位置：isTaskCron / isTaskOffPeak 渲染分支；故障：未读或运行中时图标消失。
// INV-18 断言：远程断连徽标只对 remote: 前缀的 identity 且存在 overlay 时显示。
//        位置：shouldShowRemoteConnectionOverlay；故障：本地任务被误标为远控断连。
// INV-19 断言：右键菜单只在真正打开时挂载，路径探测随打开态运行。
//        位置：TaskListItemContextMenuContent 的 loadTaskPaths / loadProviderConfig；故障：每个 idle row 都订阅与探测。
// INV-20 断言：反馈预填只传脱敏线索，附件由用户主动添加。
//        位置：handleOpenTaskFeedback 的 buildTaskFeedbackDescription；故障：日志或截图被自动外发。
//
import { RemoteTaskDeviceLabel } from "@/remote-connection/RemoteTaskDeviceLabel.js";
/* eslint-disable max-lines -- task item 同时承载默认列表和 timeline 两行布局的共享交互，先保持动作链路集中避免归档/置顶回归。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CloudUpload,
  LoaderIcon,
  ListTree,
  Moon,
  Pin,
  Smartphone,
} from "lucide-react";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import { resolveTaskSourceLabel } from "@/lib/taskSourceAttribution.js";
import { logger } from "@/logger.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";

type TaskListItemIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isArchived?: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  hoverEnabled?: boolean;
  connectionOverlay?: "disconnected" | "reconnecting";
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: () => void | Promise<void>;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

// [契约] 判定只认 remote: 前缀的 workspaceIdentity 且存在连接 overlay；
// 本地任务即使连接异常也不显示远控徽标，避免语义混淆。
// identity 先 trim 再判断，空串等价于本地。
// [权衡] 用前缀而不是结构化 kind，是因为身份格式由 shared 统一生成。
export function shouldShowRemoteConnectionOverlay(params: {
  workspaceIdentity?: string;
  connectionOverlay?: "disconnected" | "reconnecting";
}): boolean {
  // [契约] 空值统一归一为空串，后续 startsWith 才有确定结果；
  // 这里不做 lowercase 或路径规范化，身份格式必须由生产者保证。
  // 若在此处改写 identity，可能与真实 key 不一致。
  // [失败路径] 用 includes 代替 startsWith 会把 local:remote: 误判为远控。
  const workspaceIdentity = params.workspaceIdentity?.trim() ?? "";
  return Boolean(workspaceIdentity.startsWith("remote:") && params.connectionOverlay);
}

// [契约] 结构比较用 JSON 序列化，undefined 先归一为 null；
// 字段顺序由对象字面量固定，不能依赖上游动态插入顺序。
// [权衡] 该比较不做深排序，字段顺序不同会被判为不等，属于保守选择。
// [失败路径] 大对象序列化的开销可接受，因为只在 memo 比较时触发。
function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

// [契约] 新字段 cronAutomationId 优先，旧任务回落到 automationId；
// 两字段都可能缺省，返回 undefined 表示非自动化任务。
// 不能用空串代替 undefined，否则 memo 比较会把两者视为相同。
// [权衡] 兼容读取只在此处集中，避免各处重复做字段探测。
function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

// [契约] 这是 task 的显式字段白名单，新增渲染依赖的字段必须同步加入；
// 遗漏字段会让行在数据变化后不刷新，多写字段时间接导致过度刷新。
// pendingInteraction、activity、changeSummary 走结构比较。
// [失败路径] 不要改成 JSON.stringify(left) === JSON.stringify(right)，字段顺序不稳定。
function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  // [契约] 引用相同直接判等，跳过逐字段比较；
  // 这是常见路径，上游 selector 保持引用稳定时可省掉全部字段读取。
  // 该早退不影响正确性，因为没有字段能比同一引用更相等。
  // [权衡] 不能反向用它缓存结果，task 是不可变投影，引用变化才需要比较。
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    // [契约] status 是行渲染的直接输入（loading/错误指示），必须逐值比较；
    // 与 resolveTaskSourceLabel 一起覆盖派生展示字段。
    // [失败路径] 用 statusObject === 比较会因每次投影新对象而失效。
    // 新增派生展示时优先比较派生结果，而不是原始字段集合。
    left.status === right.status &&
    resolveTaskSourceLabel(left) === resolveTaskSourceLabel(right) &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

// [契约] props 比较分为四组：作用域、task、展示开关、回调；
// 回调必须比较引用，父级需保证 useCallback 稳定，否则 memo 形同虚设。
// intl 也参与比较，语言切换时整列表需要重渲染。
// [失败路径] 漏掉任一回调会让该动作持有旧闭包，操作到错误任务。
function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isArchived === right.isArchived &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.hoverEnabled === right.hoverEnabled &&
    left.connectionOverlay === right.connectionOverlay &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}

// [契约] memo 的比较函数显式传入，禁止依赖默认浅比较；
// 默认浅比较会把 task 新对象当成变化，导致整列表刷新。
// 组件只在列表容器内使用，不对外暴露未 memo 的版本。
// [权衡] 自定义比较的维护成本换来大列表滚动稳定。
export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isArchived = false,
  isActive,
  isMobileActive = false,
  hoverEnabled = true,
  connectionOverlay,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  // [并发] hover 与 focus 是两套独立可见性来源，不能合并成单一布尔；
  // 键盘聚焦时鼠标可能不在行上，合并会让 focus 态被 mouseleave 清掉。
  // 初始 false，保证首屏不闪出动作区。
  // [权衡] 两份 state 带来一次额外渲染，换取输入方式互不干扰。
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  // [契约] hover:none 能力在首次渲染时探测一次并固定，不随旋转或设备变化重算；
  // 惰性初始化避免每次渲染都调用 matchMedia。
  // [失败路径] 在 SSR 或测试环境无 window 时回落 false，保持桌面语义。
  // [权衡] 固定值意味着外接鼠标场景不会即时切换，属于可接受偏差。
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  // [契约] 禁用状态 = 父级显式禁用 或 workspace 只读，二者取或；
  // selector 只返回布尔，避免把整个 store 订阅进每一行。
  // [失败路径] 直接读 store 快照会让行在无关 tab 变化时重渲染。
  // 只读判定同时使用 workspacePath 与 workspaceIdentity，缺一不可。
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  // [契约] 只有禁用时才计算提示文案，禁用原因优先使用父级传入值；
  // 缺省回落 i18n 的不可用本地目录文案，保证 tooltip 不为空。
  // [失败路径] 在未禁用时也生成原因会让 tooltip 出现误导性提示。
  // [权衡] 文案在此计算而非在 JSX 内联，减少渲染期分支。
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  // [契约] 作用域对象必须携带 workspacePath，identity 与 remoteSessionId 仅在存在时展开；
  // 缺失字段不能传 undefined 键，保持与 hook 的参数形状一致。
  // [并发] hook 内部按 sessionId 计时，行卸载后必须自行清理。
  // [失败路径] 传空字符串 identity 会被当成合法远程身份，必须用条件展开。
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  // [资源] 确认态监听在 window 捕获阶段注册，卸载时必须成对移除；
  // 依赖仅包含确认态与取消回调，避免每次渲染重装监听。
  // [并发] 捕获阶段保证先于行内点击处理，能在外部点击时及时取消。
  // [失败路径] 缺少 cleanup 会在列表滚动后累积监听器。
  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    // [契约] 仅 Escape 取消确认，其他按键不拦截；
    // 函数内不调用 stopPropagation，避免影响全局快捷键。
    // [失败路径] 若拦截 Enter，会让确认按钮的键盘激活失效。
    // [权衡] 捕获阶段监听意味着输入框内 Escape 也会取消确认，符合预期。
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    // [契约] 指针落在行内（含确认按钮）时不取消，落在行外才取消；
    // 边界判断基于 itemRef 的 DOM 包含关系，与业务 key 无关。
    // [失败路径] 用事件目标 data 属性判断会在按钮内部子节点上漏判。
    // [权衡] 使用 pointerdown 而不是 click，避免拖拽选择时误确认。
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // 全局时间线和置顶列表的确认 key 含 workspacePath，Windows
    // 反斜杠拼进 CSS selector 后会被当作转义，确认按钮因此被误判为条目外点击。
    // 确认项直接使用自身 ref 判断事件边界，避免业务 key 与 CSS 语法耦合。
    // [资源] 两个监听都用捕获阶段，保证在行内交互之前处理；
    // 注册顺序固定：先 keydown 后 pointerdown，清理时反向移除。
    // [并发] 多个行同时处于确认态时，各行独立处理，不会相互取消。
    // [失败路径] 使用 passive 选项对 keydown 无效，反而可能影响 preventDefault。
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  // [契约] 分屏入口能力来自上下文，行内只读取启用位；
  // 未包裹 Provider 时 hook 返回默认值，保证独立渲染不抛错。
  // [失败路径] 在行内自行探测布局能力会与容器口径不一致。
  // [权衡] 每次渲染读取上下文的成本很低，无需 memo 包装。
  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  // [契约] 作用域对象只在 workspace 相关输入变化时重建，保持引用稳定；
  // identity 仅在 trim 后非空时展开，避免空串进入下游 key。
  // [并发] 作为 workbench key 的输入，引用抖动会导致分组订阅反复重算。
  // [失败路径] 把 task 其他字段放进依赖会让每行每次更新都重建。
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  // [契约] 会话 key 统一由 buildWorkbenchSessionKey 生成，禁止手写拼接；
  // 依赖 taskWorkspaceScope 与 taskId，前者已保证引用稳定。
  // [失败路径] 直接用 workspacePath 拼 key 会忽略远程 identity，产生跨环境冲突。
  // [权衡] 依赖数组含整个 scope 对象，前提是上一处 memo 已稳定。
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  // [契约] 拖拽需同时满足：动作未禁用、分屏入口可用、会话不在工作台分组；
  // 三个条件顺序无关，但缺任一项都必须禁用，而不是在 dragStart 里补救。
  // [失败路径] 只判断前两项会让已在分屏中的会话被重复拖入。
  // [权衡] 该值决定 draggable 属性，禁用后浏览器根本不会发起拖拽。
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  // V4 runtime/interaction 已由 sessions-index 投影，旧 Zustand map 不再接收
  // 后台会话 delta。row 直接消费随列表条目到达的 activity sidecar，避免 spinner/attention 假静止。
  // [并发] activity 直接取随条目到达的 sidecar，不订阅全局 map；
  // 后台会话的 delta 由 sessions-index 投影，行内不做第二次归并。
  // [失败路径] 回退到旧 Zustand map 会让 spinner 与 attention 假静止。
  // [契约] 该函数是纯读取，不修改 task。
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // [契约] 待交互或待关注任一成立即视为占用右侧状态位；
  // hasPendingInteraction 同时驱动元信息隐藏、归档动作隐藏与交互胶囊渲染。
  // [失败路径] 只判断 pendingInteraction 会让 attention 与时间并排挤压标题。
  // [权衡] 用两个来源合成而不是新增投影字段，减少协议改动。
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
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
  // [契约] 来源标签由共享函数派生，行内不自行判断 fork/remote；
  // 该值同时参与 memo 比较，必须保持派生稳定。
  // [失败路径] 内联三元会让默认列表与 timeline 的标签口径分叉。
  // [权衡] resolveTaskSourceLabel 每次渲染调用一次，函数内部无重计算。
  const taskSourceLabel = resolveTaskSourceLabel(task);
  // [契约] 标题为空时按是否 fork 选择占位文案，均由 i18n 提供；
  // 空串与纯空白都视为空标题，不做 trim 后回填。
  // [失败路径] 直接渲染空串会让行高塌陷，无法点击。
  // [权衡] 占位文案不进入 memo 比较，因为它只依赖 task 字段。
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  // [契约] 选择动作经 runUserAction 包裹，featureId/action/trigger 固定；
  // completed 标记 optimistic_projection，失败阶段为 task_open。
  // [失败路径] 直接把 onSelectTask 传给 onClick 会丢失埋点与失败归因。
  // [权衡] runUserAction 是同步包装，不改变原回调时序。
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  // [契约] 拖拽开始时先确认能力，再写 payload、MIME、纯文本、预览；
  // payload 与 MIME 必须来自同一对象，避免内部外部看到不同内容。
  // [资源] 预览清理函数交给下一帧，不能在 dragstart 同步执行。
  // [失败路径] 能力不足时调用 preventDefault，阻止浏览器发起半成品拖拽。
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      // [失败路径] 禁用态下必须 preventDefault 并立即返回，不写入任何 payload；
      // 否则浏览器仍会生成拖拽影像，用户会误以为可以放置。
      // 该早退不清理全局 payload，因为此处从未设置。
      // [权衡] 在 dragstart 兜底而不是仅依赖 draggable，防止外部合成事件。
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      // 原因：此行同时可复制到分屏、移动到项目；只允许 copy 会让浏览器拒绝项目的 move/drop。
      // [契约] 同一行既可复制到分屏，也可移动到项目，因此必须是 copyMove；
      // 单一 copy 会让项目侧的 move/drop 被浏览器拒绝。
      // [失败路径] 设为 all 会暴露不可用的 link 语义，drop 端仍需再校验。
      // [权衡] effectAllowed 只是声明，最终仍由 drop 目标决定。
      event.dataTransfer.effectAllowed = "copyMove";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      // [并发] 全局 payload 是拖拽期间的临时单例，供 drop 端读取完整对象；
      // 必须在 setData 之前写入，保证 drop 同步读取时已就绪。
      // [资源] 拖拽结束或取消时必须由 handleDragEnd 清除。
      // [失败路径] 只写 dataTransfer 不写全局，内部 drop 拿不到 remoteSessionId。
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // Bugfix：浏览器默认 drag preview 背景透明、边界不清晰；保留原行内容，
      // 只补齐拖动 overlay 使用的背景、边框和阴影。
      // [资源] 预览生成返回清理函数，调用方负责在下一帧释放；
      // 传入 clientX/clientY 与 dataTransfer，保持拖拽锚点与浏览器一致。
      // [失败路径] 不清理会在 body 上留下隐藏节点，长时间使用后内存增长。
      // [权衡] 预览复用原行内容，只补背景与边框，避免视觉跳变。
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      // [契约] 使用元素所属 window 而不是全局 window，兼容多窗口与 iframe；
      // ownerWindow 可能为 null（文档已脱离），此时同步清理。
      // [失败路径] 用全局 requestAnimationFrame 会在错误窗口调度，预览残留。
      // [权衡] 多一次判空换取跨窗口正确性。
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  // [资源] 拖拽结束（含取消与放到非法区域）都走这里清全局 payload；
  // 只清全局引用，不动 dataTransfer，浏览器自行回收。
  // [失败路径] 漏清会让下一次 drop 读到上一次的陈旧会话。
  // [权衡] 回调无依赖，保持引用稳定以减少子组件重渲染。
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  // [契约] 右键只通知容器打开菜单（onOpenTaskContextMenu），行内不自行定位或渲染菜单；
  // 菜单是列表级单例，避免每个 row 都挂一份。
  // [失败路径] 在行内 open 自己的菜单会与容器菜单重复弹出。
  // [权衡] taskId 由行传入，容器据此决定选中项。
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  // [契约] 归档前先拦截只读 workspace，拦截时必须阻止冒泡与默认行为；
  // 真正执行经 runUserAction 包裹，failureStage 为 task_archive。
  // [并发] 确认态与普通态共用此回调，确认态重复点击由容器幂等处理。
  // [失败路径] 不 stopPropagation 会同时触发行选择。
  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  // [契约] 置顶切换总是 preventDefault + stopPropagation，避免触发行选择；
  // 只读 workspace 下直接返回，不做乐观更新。
  // 目标值使用 !isPinned 而不是读取 store，避免与当前渲染不一致。
  // [失败路径] 在禁用态仍调用回调会让父级产生无效写请求。
  const handleTogglePin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // 归档二次确认依赖用户第二次点击确认；鼠标离开 row 时清理 hover 展示即可。
    // 如果同步取消确认，用户移动鼠标稍微离开任务行后确认按钮会消失，导致二次确认无法稳定完成。
  }, []);

  // [契约] leading 指示器由 task 与 activity 共同派生，优先级在派生函数内固定；
  // memo 依赖包含 taskActivity，确保 sidecar 变化能刷新。
  // [失败路径] 只依赖 task 会让运行中状态停留在旧值。
  // [权衡] 派生结果只有三种状态，比较成本极低。
  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  // [契约] cron 身份由共享判定函数给出，行内不读取调度配置；
  // isTaskCron 只决定时间列是否显示时钟图标。
  // [失败路径] 行内自行判断 schedule 字段会把一次性定时任务误标。
  // [权衡] isCronTask 每次渲染调用一次，函数内部为字段检查。
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  // [契约] 低峰任务身份改为读取持久 meta 标记，不再反查全局 store；
  // 反查在任务被删除后会丢失溯源，且每行多一个订阅。
  // [失败路径] 恢复 store 反查会让已删除任务的行显示错误图标。
  // [权衡] 标记可能滞后于调度状态，但展示只需最终归属。
  const isTaskOffPeak = isOffPeakTask(task);
  // Bugfix: 手机远控标记和置顶状态共用左侧 leading 槽。
  // 已置顶任务如果继续常显 Pin，会和绝对定位的手机图标重叠；手机激活态默认让手机图标优先，hover 时再显示 Pin 操作。
  // [契约] 置顶图标只在 leading 槽空闲且非手机激活时显示；
  // leading 有 error/unread/loading 时让位，手机激活时让位给手机标记。
  // [失败路径] 去掉 !isMobileActive 会让 Pin 与绝对定位的手机图标重叠。
  // [权衡] hover 时仍显示 Pin 操作，由 shouldRenderPinAction 另行判断。
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  // 修复原因：手机会在 click 前合成 mouseenter/focus；此时切换内容会让首次点击只进入 hover。
  // 远控入口固定操作区和元信息，避免触摸引发 DOM 切换；桌面仍沿用 hover/focus 展示。
  // [契约] 只有 hoverEnabled 且 hover/focus 可见时才抑制元信息；
  // 移动端 hoverEnabled 为 false，保证元信息与动作常驻。
  // [失败路径] 去掉 hoverEnabled 判断会让触摸端首击只进入 hover 态。
  // [权衡] shouldSuppressWorkspaceTaskMetadata 抑制的是元信息列，不是整行内容。
  const shouldSuppressWorkspaceTaskMetadata =
    hoverEnabled && (hoverActionsVisible || focusActionsVisible);
  // [契约] 桌面端在抑制元信息时挂载动作；触屏或 hover:none 时恒挂载；
  // 该值只影响动作是否渲染，不影响其禁用状态。
  // [失败路径] 与禁用条件合并会让只读 workspace 的动作直接消失，用户无法看到原因。
  // [权衡] 动作区挂载后由 CSS 控制可见性，避免布局跳动。
  const shouldMountWorkspaceTaskActions =
    !hoverEnabled || shouldSuppressWorkspaceTaskMetadata || isHoverNone;
  // [契约] 相对时间由 formatTaskRelativeTime 生成，行内不做时间差计算；
  // intl 参与 memo 比较，语言切换时必然刷新。
  // [失败路径] 在渲染期读取 Date.now 会让同一行在不同渲染间跳变。
  // [权衡] 相对时间不自动走秒，刷新由列表更新（task.updatedAt）驱动。
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  // [契约] 远程任务以 workspaceIdentity 是否存在判定，而不是 remoteSessionId；
  // identity 存在即表示该任务归属远程 workspace，决定归档图标语义。
  // [失败路径] 用 remoteSessionId 判断会漏掉已断连但有身份的远程任务。
  // [权衡] 该值与连接状态无关，断连仍显示云图标。
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const remoteConnectionUnavailable = shouldShowRemoteConnectionOverlay({
    workspaceIdentity: task.workspaceIdentity,
    connectionOverlay,
  });
  const remoteConnectionBadge = remoteConnectionUnavailable ? (
    <Badge
      data-remote-connection-overlay="true"
      className="h-5 shrink-0 border-transparent bg-warning-surface px-2 text-ui-xs font-medium text-warning-surface-foreground"
    >
      {intl.formatMessage({ id: "taskList.remoteConnectionUnknown" })}
    </Badge>
  ) : null;
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming
      ? "common.confirm"
      : isArchived
        ? "taskList.unarchive"
        : "taskList.archive",
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  // [契约] 行 key 由 workspace key 与 taskId 复合，必须复用共享构造函数；
  // 单一 taskId 在不同 workspace 下可能重复，不能作为 key。
  // [失败路径] 手拼路径会忽略 identity，远程与本地同名任务互相顶替。
  // [权衡] key 只用于 DOM 与测试定位，不参与业务查询。
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // 工作流运行行：标题下的第二条通道，
  // 与前置 16px 槽（error > unread > spinner）互不占位。只在会话带 run 摘要时挂组件。
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  const workflowRunLinesNode = hasWorkflowRunLines ? (
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
  const changeSummaryNode =
    !hasPendingInteraction && taskChangeSummary ? (
      <span className="shrink-0 text-ui-base">
        {taskChangeSummary.added > 0 ? (
          <span className="text-diff-added">+{taskChangeSummary.added}</span>
        ) : null}
        {taskChangeSummary.removed > 0 ? (
          <span className="ml-1 text-diff-removed">-{taskChangeSummary.removed}</span>
        ) : null}
      </span>
    ) : null;
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = shouldRenderArchiveAction ? (
    /* 交互调整：任务进入“等待归档确认”后，右侧 hover 区不再显示归档按钮。
       否则一个 item 同时出现“待确认状态”和“可归档操作”，视觉重心会互相打架。 */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={handleArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // Bugfix: 归档确认态是显式等待用户决策的状态，必须持续显示 destructive 按钮。
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // 普通归档态复用共享 action 的 hover 背景、尺寸和提示。
        <TaskRowActionButton
          label={archiveLabel}
          onClick={handleArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // 本地和远端 task 混排时，统一 archive 图标无法提示操作会落在哪个 sqlite。
            // 远端任务使用 cloud 语义图标，避免用户误把远端归档当成本地归档。
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // 原因：置顶任务常跨项目，查看文件必须保留独立入口；复用共享 action，避免点击选择任务。
  const fileTreeActionNode =
    onOpenFileTree &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive) ? (
      <TaskRowActionButton
        label={intl.formatMessage({ id: "git.action.showTree" })}
        showTooltip
        testId={`task-files-${task.taskId}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void runUserActionAsync({
            input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
            operation: async () => onOpenFileTree?.(),
            completed: { resultSource: "local_commit" },
            failureStage: "file_tree_open",
          }).catch((cause) => {
            logger.error("[task-list] 查看文件失败", cause);
            toast(String(cause));
          });
        }}
      >
        <ListTree className="size-3.5" />
      </TaskRowActionButton>
    ) : null;
  const taskActionGroupNode =
    fileTreeActionNode || archiveActionNode ? (
      <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
        {fileTreeActionNode}
        {archiveActionNode}
      </span>
    ) : null;
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );
  // hover:none 只让右侧 task actions 常驻；如果也用它接管 leading 槽，
  // 触屏端的错误、未读和 loading 状态会被 Pin 永久替换。
  // [契约] Pin 渲染需同时满足：功能开启、且（置顶态可见 或 元信息被抑制）；
  // hover:none 只让动作常驻，不能让它接管 leading 槽的状态语义。
  // [失败路径] 去掉 showPinAction 会让调用方无法关闭置顶入口。
  // [权衡] 置顶态与操作态复用同一按钮，靠 shouldRenderPinAction 的可见性区分。
  const shouldRenderPinAction =
    showPinAction && (showPinnedState || shouldSuppressWorkspaceTaskMetadata);
  return (
    <li
      ref={itemRef}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={taskItemKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      draggable={canDragToWorkbench}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={hoverEnabled ? handleMouseEnter : undefined}
      onMouseLeave={hoverEnabled ? handleMouseLeave : undefined}
      onFocusCapture={hoverEnabled ? () => setFocusActionsVisible(true) : undefined}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusActionsVisible(false);
        }
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelect();
        }
      }}
      className={cn(
        "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
        // 默认行 32px 时前置槽整行居中；长出工作流运行行后行体是两行的纵向列，槽改为对齐首行。
        variant === "timeline"
          ? "items-start py-1.5"
          : hasWorkflowRunLines
            ? "items-start"
            : "items-center",
        isActive ? "bg-selected" : hoverEnabled && "hover:bg-surface-hover",
      )}
    >
      {/* Bugfix: 之前任务列表依赖 divide-y 画分隔线，深色侧栏里每个 item 上下都会出现明显黑线，
              视觉上像被两条边框夹住。这里改成“列表留白 + item 自己带圆角态”，
              让 hover/active 的层级由卡片背景承担，不再依赖分隔线。 */}

      <div
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center",
          // 行体是纵向列（标题行 + 运行行）时前置槽对齐首行而不是整行：默认 24px 首行居中 = 上留 4px。
          variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 items-center justify-center transition-opacity",
            // SVG 自身旋转会逐帧重算样式；让现有 HTML 槽位合成旋转，保留图标与状态语义。
            leadingIndicator === "loading" && "animate-spin",
            shouldRenderPinAction && "hidden",
            isMobileActive && "invisible",
          )}
        >
          {/* 无状态只保留对齐槽，不显示代表空闲的占位圆点。 */}
          {leadingIndicator === "error" ? (
            <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : leadingIndicator === "unread" ? (
            <span data-unread-indicator="true" className="size-[7px] rounded-full bg-icon-blue" />
          ) : leadingIndicator === "loading" ? (
            <LoaderIcon className="size-4 text-foreground-subtle" />
          ) : null}
        </span>
        {shouldRenderPinAction ? (
          <ControlHintTooltip
            title={
              workspaceActionsDisabledReason ??
              intl.formatMessage({
                id: isPinned ? "taskList.unpin" : "taskList.pin",
              })
            }
            side="top"
            align="center"
          >
            {pinActionButton}
          </ControlHintTooltip>
        ) : null}
      </div>

      {variant === "timeline" ? (
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
              <ControlHintTooltip
                title={intl.formatMessage({ id: "taskList.mobileActive" })}
                side="right"
                align="center"
                triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
              >
                <span
                  data-mobile-active-task="true"
                  className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                  aria-label={intl.formatMessage({
                    id: "taskList.mobileActive",
                  })}
                >
                  <Smartphone className="size-3.5" />
                </span>
              </ControlHintTooltip>
            ) : null}
            {remoteConnectionBadge}
            <TaskTitleOverflowText
              className="text-ui-base text-foreground"
              title={taskTitleWithChanges}
            >
              {/* Bugfix: task 标题之前使用 truncate，会在长标题末尾显示省略号；
                      这里统一改为右侧渐隐，避免同一侧栏里出现两种截断语义。 */}
              {taskTitle}
            </TaskTitleOverflowText>
            {task.pendingInteraction ? (
              <TaskInteractionBadge
                interaction={task.pendingInteraction}
                formatMessage={(id) => intl.formatMessage({ id })}
                onSnoozeCountdown={snoozeInteractionAutoResolution}
              />
            ) : taskAttentionDisplay ? (
              <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
                {taskAttentionDisplay}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" data-task-workspace-label="true">
                {workspaceLabel}
              </span>
              {taskSourceLabel ? (
                <>
                  <span aria-hidden="true" className="text-foreground-subtlest">
                    ·
                  </span>
                  <RemoteTaskDeviceLabel task={task} className="truncate" />
                </>
              ) : null}
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
              {!hasPendingInteraction ? (
                <span
                  data-task-row-metadata="true"
                  className={cn(
                    "flex items-center gap-1.5",
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                  {changeSummaryNode ? (
                    <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                      ·
                    </span>
                  ) : null}
                  {isTaskCron ? (
                    // Bugfix: 定时任务 icon 不能占用左侧状态槽；未读、运行中、置顶 hover 都会接管那里。
                    // 放在时间前面，与其它元信息同列，状态变化时也不会丢。
                    <Clock
                      data-cron-task-icon="true"
                      aria-label={intl.formatMessage({
                        id: "taskList.cronTaskLabel",
                      })}
                      className="size-3.5 shrink-0"
                    />
                  ) : isTaskOffPeak ? (
                    <Moon
                      data-off-peak-task-icon="true"
                      aria-label={intl.formatMessage({
                        id: "taskList.offPeakTaskLabel",
                      })}
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                  <span className="mr-1">{taskTimeLabel}</span>
                </span>
              ) : null}
              {taskActionGroupNode}
            </div>
          </div>
          {workflowRunLinesNode}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
              {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "taskList.mobileActive" })}
                  side="right"
                  align="center"
                  triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
                >
                  <span
                    data-mobile-active-task="true"
                    className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                    aria-label={intl.formatMessage({
                      id: "taskList.mobileActive",
                    })}
                  >
                    {/* Bugfix: mobileViewState 已经能告诉桌面端手机正在看的 task，
                        但列表未消费这个状态，用户会误以为只有桌面端在操作。上一版把图标作为标题前的 flex 子项，
                        会把当前行标题往右挤，造成上下 task 标题不对齐；这里改成绝对定位到原有 leading 槽，
                        标题文本仍然从原来的位置开始；同时 hover 时隐藏手机标记，把原来的置顶按钮还给用户。 */}
                    <Smartphone className="size-3.5" />
                  </span>
                </ControlHintTooltip>
              ) : null}
              {/* 默认行与 timeline 共用远程断连投影，工作流多行布局不改变连接状态。 */}
              {remoteConnectionBadge}
              <TaskTitleOverflowText
                className="text-ui-base text-foreground"
                title={taskTitleWithChanges}
              >
                {/* Bugfix: 默认 workspace task item 和 timeline item 共享标题溢出规则；
                        使用 mask 渐隐而不是省略号，和 grouped task row 保持一致。 */}
                {taskTitle}
              </TaskTitleOverflowText>
              {changeSummaryNode ? (
                <span
                  className={cn(
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                </span>
              ) : null}
              {task.pendingInteraction ? (
                <TaskInteractionBadge
                  interaction={task.pendingInteraction}
                  formatMessage={(id) => intl.formatMessage({ id })}
                  onSnoozeCountdown={snoozeInteractionAutoResolution}
                />
              ) : taskAttentionDisplay ? (
                <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18">
                  {taskAttentionDisplay}
                </Badge>
              ) : null}
            </div>

            {!hasPendingInteraction ? (
              // 交互胶囊已经占用右侧状态位；继续显示相对时间会和“等待确认”并排挤压标题。
              <span
                data-task-row-metadata="true"
                className={cn(
                  "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
                  isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
                )}
              >
                {isTaskCron ? (
                  // 定时任务 icon 归属时间元信息，而不是左侧状态位；否则 unread/loading 会把 icon 顶掉。
                  <Clock
                    data-cron-task-icon="true"
                    aria-label={intl.formatMessage({
                      id: "taskList.cronTaskLabel",
                    })}
                    className="size-3.5 shrink-0"
                  />
                ) : isTaskOffPeak ? (
                  <Moon
                    data-off-peak-task-icon="true"
                    aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
                {taskTimeLabel}
              </span>
            ) : null}

            {taskActionGroupNode}
          </div>
          {workflowRunLinesNode}
        </div>
      )}
    </li>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";

export function TaskListItemContextMenuContent({
  organizationActions,
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isArchived = false,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  organizationActions?: React.ReactNode;
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isArchived?: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
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
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // row 级菜单已收敛为列表级单例，只有菜单真正打开时才挂载此组件。
    // 因此路径探测和 provider 配置探测可以直接随打开态运行，避免每个 idle row 订阅和计算。
    // [契约] 菜单只在真正打开时挂载，因此路径探测可以直接开启；
    // 若未来改成常驻挂载，必须把该值改为按需，否则每行都会探测磁盘。
    // [失败路径] 常驻挂载加 true 会在大型列表上触发大量 IO。
    // [权衡] 组件级挂载策略与 loadTaskPaths 探测开关是一对约束，改动需成对评估。
    loadTaskPaths: true,
    loadProviderConfig: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  // [契约] 反馈复用反馈中心 draft，仅预填脱敏的任务线索；
  // 标题截断到 80 字符，type/module/severity 为固定初值。
  // [失败路径] includeLogs 只是允许用户选择，不能在此自动附加日志。
  // [权衡] 该回调依赖多个路径字段，依赖数组必须完整，否则会带旧路径。
  const handleOpenTaskFeedback = useCallback(async () => {
    // 任务右键菜单之前只能复制日志/路径，反馈时缺少任务上下文。
    // 这里复用反馈中心 draft，只预填脱敏后的任务线索，附件由用户主动选择。
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
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      organizationActions={organizationActions}
      intl={intl}
      isPinned={isPinned}
      isArchived={isArchived}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      providerConfigFile={providerConfigFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
      }}
      onCopyTaskPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyTaskPath" }),
          taskSessionFile.path,
        );
      }}
      onCopyTaskLogPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyLogPath" }),
          taskNativeSessionLogFile.path,
        );
      }}
      onCopySessionId={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // 通过单例 store 把“打开轨迹”请求交给所属 workspace 的侧边栏控制器（useAppPanels）。
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
      onOpenProviderConfig={() => {
        void handleOpenProviderConfig();
      }}
    />
  );
}
