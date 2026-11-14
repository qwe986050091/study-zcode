// 文件头：侧栏「分组」标题行组件，承载折叠、重命名、颜色与拖放落点。
// 职责：group 头部的交互编排（焦点、IME、菜单、DnD 注册）与组内容挂载/卸载时序。
// 边界：任务行渲染委托 virtualized-group-task-list；分组数据与持久化在 store，不在此处。
//
// 不变量（INV）：
// INV-01 断言：重命名期间必须禁用 group 拖拽，避免输入选择触发拖拽。
// 守护：useDraggable 的 disabled: renaming。
// 改错故障：拖选文字时整组被拖动，drop 后分组顺序错乱。
// INV-02 断言：系统分组（cron / off-peak）不可重命名、不可解散。
// 守护：isSystemGroup 控制 ContextMenu 中 rename/ungroup 两项是否渲染。
// 改错故障：用户改掉系统分组名称，后续按固定 id 归类的逻辑仍然生效但 UI 不一致。
// INV-03 断言：系统分组展示标题必须走本地化，不读 DB 的占位标题。
// 守护：displayTitle 由 getTaskGroupDisplayTitle 按 intl 消息生成。
// 改错故障：切换语言后仍显示 'cron' 字样。
// INV-04 断言：菜单触发的重命名必须先关闭菜单再聚焦输入框。
// 守护：menuRenamePendingRef → handleContextMenuOpenChange → consumePendingMenuRename。
// 改错故障：菜单 focus restore 抢走 input 焦点，重命名框不可输入。
// INV-05 断言：菜单关闭后的迟到 blur 不得提交重命名。
// 守护：menuRenameFocusGuardRef 350ms 窗口内 handleRenameBlur 只回焦不 commit。
// 改错故障：首次聚焦前被 blur，重命名立即被取消。
// INV-06 断言：新建分组的颜色菜单初始展开不得被输入框回焦关闭。
// 守护：newGroupInitialFocusGuardRef 在 handleColorMenuOpenChange 中强制保持 open。
// 改错故障：新建分组时颜色菜单一闪即关，用户无法选色。
// INV-07 断言：IME 组字中的 Enter 不得提交重命名。
// 守护：handleRenameKeyDown 中 isImeComposingKeyEvent 早退。
// 改错故障：中文输入法选词确认即结束编辑，标题被截断。
// INV-08 断言：Esc 取消重命名必须阻止冒泡。
// 守护：handleRenameKeyDown 的 Escape 分支 preventDefault + stopPropagation。
// 改错故障：Esc 同时关闭外层弹层或退出分屏。
// INV-09 断言：提交重命名时空白标题回退为原标题。
// 守护：commitRename 中 renameDraft.trim() || node.group.title。
// 改错故障：用户清空标题后分组名变为空串，侧栏出现无标题行。
// INV-10 断言：标题未变化时不得调用 onRenameGroup。
// 守护：commitRename 的 nextTitle === node.group.title 早退。
// 改错故障：每次失焦都写库，触发无意义持久化与重渲染。
// INV-11 断言：重命名草稿在非编辑态必须跟随外部标题更新。
// 守护：第一个 useLayoutEffect 在 !renaming 时 setRenameDraft。
// 改错故障：别处改名后再次进入编辑仍显示旧草稿。
// INV-12 断言：测量按钮的宽度变化由 ResizeObserver 驱动，编辑结束即断开。
// 守护：useLayoutEffect 返回 resizeObserver.disconnect。
// 改错故障：输入框宽度停留在旧值或被反复 setState 抖动。
// INV-13 断言：测量节点宽度不受 label 的 max-w-full 约束。
// 守护：测量 button 使用 whiteSpace: pre 与绝对定位。
// 改错故障：输入变长时测量值被当前宽度反向卡住，输入框不再增长。
// INV-14 断言：折叠时内容延迟 180ms 卸载，保证收起动画可见。
// 守护：shouldRenderGroupContent 的 setTimeout(180) 与清理。
// 改错故障：点折叠后内容瞬间消失，过渡动画失效。
// INV-15 断言：折叠内容不使用 Radix Collapsible。
// 守护：本地受控 div + grid-rows 过渡。
// 改错故障：频繁挂载时 Presence 重放动画，出现闪烁。
// INV-16 断言：头部键盘操作只响应 Enter/Space，且只处理自身聚焦。
// 守护：handleHeaderKeyDown 的 currentTarget === target 与 key 判断。
// 改错故障：子按钮回车触发折叠，双击语义。
// INV-17 断言：头部内所有按钮的指针事件必须 stopPropagation。
// 守护：onMouseDown/onPointerDown/onTouchStart 的 stopPropagation。
// 改错故障：点颜色或新建按钮同时触发 group 折叠/拖拽。
// INV-18 断言：两个 focus guard 定时器必须在卸载时清理。
// 守护：useEffect(() => () => clearTimeout(...), [])。
// 改错故障：卸载后定时器仍持有 ref，dev 严格模式下重复执行。
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import type {
  ZCodeGroupedTaskViewNode,
  ZCodeTaskGroupColor,
} from "@/project-sidebar/grouped/types.js";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";

import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { ChevronDownIcon, ChevronRightIcon, MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { EmptyGroupDropZone } from "@/project-sidebar/grouped/task-item.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { getTaskGroupDisplayTitle } from "@/project-sidebar/grouped/group-title.js";
import { VirtualizedGroupedTaskList } from "@/project-sidebar/grouped/virtualized-group-task-list.js";
import {
  TASK_GROUP_BORDER_COLOR_CLASS,
  TASK_GROUP_COLORS,
  TASK_GROUP_CONTAINER_CLASS,
  TASK_GROUP_CONTENT_CLASS,
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_TITLE_CLASS,
  TaskGroupColorDot,
  TaskGroupColorMark,
} from "@/project-sidebar/grouped/shared.js";
import type { TaskGroupMenuItem } from "@/project-sidebar/grouped/shared.js";

// [契约] 纯展示型受控组件：所有写操作都通过 props 回调上抛。
// 不读 store、不发请求，保证同一 props 渲染结果确定。
// 新增交互一律走 props 回调上抛，不要让 GroupItem 直接改写 node.group 里的分组数据。
export function GroupItem({
  node,
  groups,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  // [契约] 选中任务时同时携带 workspacePath 与 workspaceIdentity。
  // 身份优先由调用方决定，组件内不做 identity 归一化。
  // 改动参数顺序会影响所有上层调用点。
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onCreateTask,
  hasDraftTask,
  draftTaskActive,
  draftWorkspaceLabel,
  onSelectDraftTask,
  onCloseDraftTask,
  onRenameGroup,
  onUpdateGroupColor,
  onUngroupGroup,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  newGroupSetup,
  onNewGroupSetupStarted,
  collapsed,
  onToggleCollapsed,
  activeDragTaskKey,
  activeDragGroupId,
  // [契约] tooltipsDisabled 用于触摸/窄屏场景关闭悬浮提示。
  // 关闭时仍保留 aria-label，不牺牲可访问性。
  // tooltipsDisabled 只关闭悬浮提示，按钮是否可用由各自的 disabled 条件决定。
  tooltipsDisabled,
}: {
  // [契约] node 已被上层收窄为 group 节点，组件内不再判 type。
  // props 类型收窄失败会在调用点报错，而不是运行期兜底。
  // 不要为了兼容传普通节点而放宽为联合类型。
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
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
  onCreateTask: () => void;
  hasDraftTask?: boolean;
  draftTaskActive?: boolean;
  draftWorkspaceLabel?: string;
  onSelectDraftTask?: () => void;
  onCloseDraftTask?: () => void;
  onRenameGroup: (groupId: string, title: string) => void;
  onUpdateGroupColor: (groupId: string, color: ZCodeTaskGroupColor) => void;
  onUngroupGroup: (groupId: string) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  newGroupSetup: boolean;
  onNewGroupSetupStarted: (groupId: string) => void;
  // [契约] collapsed 是受控折叠态，来源是侧栏视图状态。
  // 组件内只用 visualCollapsed 派生，不持有自己的折叠状态。
  // 本地状态只保留动画用的 shouldRenderGroupContent。
  collapsed: boolean;
  onToggleCollapsed: (groupId: string) => void;
  activeDragTaskKey?: string | null;
  activeDragGroupId?: string | null;
  // [契约] 可选，缺省视为启用 tooltip。
  // 该字段会继续下传给虚拟列表，保证任务行与分组行口径一致。
  // 删除它会让移动端出现多余悬浮层。
  tooltipsDisabled?: boolean;
}) {
  // [契约] 所有文案走 intl.formatMessage，禁止硬编码中文/英文。
  // displayTitle 的系统分组名称也由 intl 注入。
  // 缺消息 id 会抛错，新增文案需同步语言包。
  const { intl } = useZCodeIntl();
  // [契约] renaming 是编辑态唯一真相，同时驱动拖拽禁用与输入框渲染。
  // 进入编辑只能走 startRename，退出只能走 commitRename/cancelRename。
  // 直接 setRenaming(false) 会绕过草稿重置与写库。
  const [renaming, setRenaming] = useState(false);
  // [契约] renameDraft 是编辑中的本地草稿，失焦提交前不回写父级。
  // 非编辑态由 useLayoutEffect 跟随 node.group.title 同步。
  // 不要在 onChange 里直接调用 onRenameGroup，会产生逐字写库。
  const [renameDraft, setRenameDraft] = useState(node.group.title);
  // [资源] 输入框 ref 仅用于聚焦、全选与宽度测量。
  // 多处 rAF/timeout 会延迟访问它，必须使用可选链。
  // 卸载后延迟回调命中 null，属预期而非错误。
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  // [资源] 隐藏测量按钮的 ref，用于计算输入框目标宽度。
  // 仅在 renaming 时存在，ResizeObserver 需判空后再 observe。
  // titleMeasureButtonRef 只服务于标题宽度测量，不要复用它做布局定位（节点随 renaming 卸载）。
  const titleMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  // [并发] 标记“菜单已请求重命名但菜单尚未真正关闭”。
  // 由 startRenameFromMenu 置 true，consumePendingMenuRename 取出并清零。
  // 消费必须是幂等的一次性动作，重复消费会重复聚焦。
  const menuRenamePendingRef = useRef(false);
  // [并发] 350ms 焦点保护窗口，覆盖 Radix 菜单关闭的迟到 focus restore。
  // 窗口内 blur 只回焦不提交；窗口结束由定时器清除。
  // 取消/提交重命名时也要清零，避免污染下一次编辑。
  const menuRenameFocusGuardRef = useRef(false);
  // [资源] 保护窗口的定时器句柄，重复 arm 时必须先清旧定时器。
  // 卸载时由 useEffect 清理，避免悬挂回调。
  // 用 number 而非 NodeJS.Timeout，因为这是 renderer 的 window 定时器。
  const menuRenameFocusGuardTimeoutRef = useRef<number | null>(null);
  // [并发] 新建分组场景的焦点保护窗口，语义与菜单保护不同。
  // 它同时用于阻止颜色菜单被回焦误关。
  // 两个 guard 必须分别判断，不能合并成一个布尔。
  const newGroupInitialFocusGuardRef = useRef(false);
  // [资源] 新建分组保护窗口的定时器句柄。
  // newGroupInitialFocusGuardTimeoutRef 与 menuRenameFocusGuardTimeoutRef 分开保存，两个保护窗口可能同时生效。
  // 卸载时同样要清理（INV-18）。
  const newGroupInitialFocusGuardTimeoutRef = useRef<number | null>(null);
  // [并发] 记录 IME 组字状态，供 Enter 判定使用。
  // 用 ref 而非 state，避免组字过程触发重渲染。
  // compositionstart/end 成对维护，异常中断时以 keydown 的 nativeEvent 兜底。
  const renameCompositionActiveRef = useRef(false);
  // [契约] 颜色菜单受控开合状态，新建分组时被强制打开。
  // 关闭请求会经过 handleColorMenuOpenChange 过滤。
  // 不要在别处直接 setColorMenuOpen，否则绕过初始窗口保护。
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  // [契约] 输入框目标宽度，null 表示未测量、跟随内容自适应。
  // 仅编辑态测量，退出编辑时重置为 null。
  // 用 Math.ceil 取整，避免亚像素宽度造成抖动。
  const [titleEditorWidth, setTitleEditorWidth] = useState<number | null>(null);
  // [契约] 生成 aria-controls 与内容容器 id，保证同页多分组唯一。
  // 不要用 group.id 拼 id，重复渲染会冲突。
  // 该 id 同时用于 aria-expanded 的关联。
  const groupContentId = useId();
  // [契约] 控制内容是否挂载：展开立即挂载，收起延迟卸载（INV-14）。
  // 初始值来自 collapsed，避免首帧无谓挂载。
  // 它与 collapsed 是两个状态，不要合并。
  const [shouldRenderGroupContent, setShouldRenderGroupContent] = useState(() => !collapsed);
  // [契约] shouldShowEmptyDropZone 仅在 !hasDraftTask 且 node.tasks 为空时成立，此时才渲染空分组投放区。
  // 有草稿时由 draft 行自身承接拖放，不再叠加空态；两者同时出现会让用户误以为分组为空。
  // 先判 hasDraftTask 再判任务数：顺序反过来会让草稿行与空态同时挂载。
  const shouldShowEmptyDropZone = !hasDraftTask && node.tasks.length === 0;
  // [契约] 视觉折叠态别名，供 DnD 与 aria 使用。
  // visualCollapsed 目前等同于 collapsed，保留这层别名是为了给“动画中”单独留出扩展位。
  // 改动时同步 shouldRenderGroupContent 的延迟逻辑。
  const visualCollapsed = collapsed;
  const titleEditorText = renameDraft || node.group.title;
  // 系统分组（cron / 闲时）：固定归类，禁止重命名与删除(解散)；颜色可改（与 cron 既有行为一致）。
  // [契约] 系统分组按固定 id 识别，不按标题或排序位置识别。
  // id 常量来自 shared，禁止在此硬编码字符串。
  // 重命名/解散的禁用都依赖它。
  const isCronGroup = node.group.id === CRON_DEFAULT_GROUP_ID;
  // [契约] 闲时分组与 cron 分组同属系统分组。
  // 新增系统分组需同时扩展这里与 isSystemGroup。
  // 漏改会让新系统分组可被用户删除。
  const isOffPeakGroup = node.group.id === OFF_PEAK_DEFAULT_GROUP_ID;
  const isSystemGroup = isCronGroup || isOffPeakGroup;
  // 系统分组的标题按语言环境本地化展示，忽略 DB 里存的固定占位标题（'cron' / 'off-peak'）。
  // [契约] 展示标题由 group 标题 + 系统分组本地化共同决定（INV-03）。
  // 传入的 cron/offPeak 文案已本地化，函数只做选择。
  // 不要把 displayTitle 写回 group.title。
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });
  // [契约] 拖拽态由外部 activeDragGroupId 对齐得出，组件不自持。
  // 拖拽中头部 opacity-0，仅保留落点提示。
  // 不要用本地 DnD isDragging 替代，跨组拖拽时口径不同。
  const dragging = activeDragGroupId === node.group.id;
  // [契约] group 头部作为拖拽源，id 前缀 group: 区分任务行拖拽。
  // disabled: renaming 落实 INV-01。
  // attributes/listeners 只挂在头部，不能挂到内容区。
  const groupDraggable = useDraggable({
    id: `group:${node.group.id}`,
    disabled: renaming,
    data: {
      type: "grouped-group",
      groupId: node.group.id,
    },
  });
  // [契约] groupOverDroppable 让整组容器接收“拖到组上”的投放，与折叠态落点互斥。
  // id 前缀 group-over: 与折叠态落点区分。
  // 与 collapsedGroupDroppable 互斥使用，由视觉折叠态决定。
  const groupOverDroppable = useDroppable({
    id: `group-over:${node.group.id}`,
    data: {
      type: "grouped-group-over",
      groupId: node.group.id,
    },
  });
  // [契约] collapsedGroupDroppable 只在 visualCollapsed 时启用，避免同一次拖拽命中两个组级落点。
  // disabled: !visualCollapsed 保证同时只有一个组级落点生效。
  // 否则同一次拖拽会命中两个 drop 目标。
  const collapsedGroupDroppable = useDroppable({
    id: `group-drop:${node.group.id}`,
    disabled: !visualCollapsed,
    data: {
      type: "grouped-collapsed-group",
      groupId: node.group.id,
    },
  });
  // [契约] expandedGroupHeaderDroppable 表示插入到本组最前，折叠时禁用以免与组级落点重叠。
  // 它挂在头部元素上，与拖拽源共用同一个 ref 回调。
  // 展开时启用、折叠时禁用，避免与组级落点重叠。
  const expandedGroupHeaderDroppable = useDroppable({
    id: `group-header-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-header",
      groupId: node.group.id,
    },
  });
  // [契约] expandedGroupFooterDroppable 表示追加到本组末尾，热区高度只有 2.5 且不占布局。
  // 高度仅 2.5，视觉上是一条热区，不影响布局。
  // 折叠时禁用，由 h-0 pointer-events-none 配合。
  const expandedGroupFooterDroppable = useDroppable({
    id: `group-footer-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-footer",
      groupId: node.group.id,
    },
  });
  // [资源] 头部同时是拖拽源与落点，一个 ref 回调注册两次 setNodeRef。
  // 依赖数组必须包含两个 setNodeRef，否则 DnD 绑定陈旧。
  // 不要在这里做其他副作用，ref 回调每次渲染都可能执行。
  const setGroupHeaderNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      groupDraggable.setNodeRef(element);
      expandedGroupHeaderDroppable.setNodeRef(element);
    },
    [expandedGroupHeaderDroppable.setNodeRef, groupDraggable.setNodeRef],
  );
  // [资源] setGroupItemNodeRef 同时注册 collapsedGroupDroppable 与 groupOverDroppable 两个 setNodeRef。
  // 与头部 ref 分开，保证命中区域粒度可区分。
  // 同样需要两个 setNodeRef 都在依赖数组内。
  const setGroupItemNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      collapsedGroupDroppable.setNodeRef(element);
      groupOverDroppable.setNodeRef(element);
    },
    [collapsedGroupDroppable.setNodeRef, groupOverDroppable.setNodeRef],
  );
  useLayoutEffect(() => {
    if (!renaming) {
      setRenameDraft(node.group.title);
    }
  }, [node.group.title, renaming]);

  useLayoutEffect(() => {
    if (!renaming) {
      setTitleEditorWidth(null);
      return undefined;
    }
    // [失败路径] 测量节点尚未挂载时直接返回，不设置宽度。
    // 测量按钮未挂载时 titleEditorWidth 保持 null，输入框退回内容自适应而不是 0 宽度兜底。
    // 不要在缺失时用 0 宽度兜底，会压扁输入框。
    const measureButton = titleMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    const updateWidth = () => {
      setTitleEditorWidth(Math.ceil(measureButton.getBoundingClientRect().width));
    };
    updateWidth();
    // [资源] 监听测量节点尺寸，内容变化即同步输入框宽度。
    // effect 清理函数负责 disconnect（INV-12）。
    // 避免在回调里直接读输入框宽度，会造成反馈循环。
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    return () => resizeObserver.disconnect();
  }, [renaming, titleEditorText]);

  useLayoutEffect(() => {
    if (!renaming) {
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      if (titleInputRef.current?.value === node.group.title) titleInputRef.current.select();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [renaming, node.group.title]);

  // [并发] 双通道聚焦：rAF 与 setTimeout(0) 各一次，覆盖不同调度时机。
  // 两者共享同一个 focus 闭包，select 语义一致。
  // 清理函数只取消 rAF，timeout 有意保留以免错过菜单关闭时机。
  const focusRenameInput = useCallback(
    (options?: { select?: boolean }) => {
      const focus = () => {
        titleInputRef.current?.focus();
        if (options?.select) {
          if (titleInputRef.current?.value === node.group.title) titleInputRef.current.select();
        }
      };
      const animationFrame = window.requestAnimationFrame(focus);
      window.setTimeout(focus, 0);
      return () => window.cancelAnimationFrame(animationFrame);
    },
    [node.group.title],
  );

  // [并发] 开启 350ms 菜单焦点保护窗口，重复调用会重置计时。
  // 窗口内 blur 由 handleRenameBlur 拦截并回焦。
  // 不要延长窗口来“更稳”，会吞掉用户真实失焦。
  const armMenuRenameFocusGuard = useCallback(() => {
    menuRenameFocusGuardRef.current = true;
    if (menuRenameFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
    }
    menuRenameFocusGuardTimeoutRef.current = window.setTimeout(() => {
      menuRenameFocusGuardRef.current = false;
      menuRenameFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  const armNewGroupInitialFocusGuard = useCallback(() => {
    newGroupInitialFocusGuardRef.current = true;
    if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
    }
    newGroupInitialFocusGuardTimeoutRef.current = window.setTimeout(() => {
      newGroupInitialFocusGuardRef.current = false;
      newGroupInitialFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  // [契约] 进入编辑态的唯一入口：重置草稿为当前标题再标记 renaming。
  // 先重置草稿可丢弃上一次未提交的编辑。
  // 外部想改名请走 onRenameGroup，不要直接调用它。
  const startRename = useCallback(() => {
    setRenameDraft(node.group.title);
    setRenaming(true);
  }, [node.group.title]);

  // [事务] startRenameFromMenu 只把 menuRenamePendingRef 置 true，真正进入编辑要等菜单关闭。
  // 真正的编辑要等菜单关闭后再执行（INV-04）。
  // 在此直接 startRename 会被菜单的 focus restore 打断。
  const startRenameFromMenu = useCallback(() => {
    menuRenamePendingRef.current = true;
  }, []);

  // [事务] 消费一次性重命名意图并返回是否命中。
  // 命中后依次：清标记 → 记日志 → 上保护窗口 → 进入编辑 → 聚焦。
  // 顺序不可换：保护窗口必须先于聚焦建立。
  const consumePendingMenuRename = useCallback(() => {
    if (!menuRenamePendingRef.current) {
      return false;
    }
    menuRenamePendingRef.current = false;
    logger.debug("[WorkspaceGroupedTasksSection] context menu rename focus handoff", {
      groupId: node.group.id,
    });
    armMenuRenameFocusGuard();
    startRename();
    focusRenameInput({ select: true });
    return true;
  }, [armMenuRenameFocusGuard, focusRenameInput, node.group.id, startRename]);

  // [并发] 菜单关闭后用 setTimeout(0) 延后消费重命名意图。
  // 延后是为了让 Radix 的 focus restore 先完成。
  // 直接同步消费会被随后的焦点回退覆盖。
  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        window.setTimeout(consumePendingMenuRename, 0);
      }
    },
    [consumePendingMenuRename],
  );

  // [并发] handleContextMenuCloseAutoFocus 先调 consumePendingMenuRename，命中才 preventDefault 阻止回焦。
  // 命中则 preventDefault，阻止焦点回到 trigger。
  // 未命中保持默认行为，不影响普通菜单操作。
  const handleContextMenuCloseAutoFocus = useCallback(
    (event: Event) => {
      // Radix context menu 关闭时会把焦点还给 trigger。
      // Rename 需要把焦点交给新出现的 input；这里先阻止默认 focus restore，再进入编辑态。
      if (consumePendingMenuRename()) {
        event.preventDefault();
      }
    },
    [consumePendingMenuRename],
  );

  // [契约] 取消编辑：清两个 guard、恢复草稿、退出编辑态。
  // 不调用 onRenameGroup，保证数据零写入。
  // 清 guard 是必须的，否则下次编辑继承旧窗口。
  const cancelRename = useCallback(() => {
    menuRenameFocusGuardRef.current = false;
    newGroupInitialFocusGuardRef.current = false;
    setRenameDraft(node.group.title);
    setRenaming(false);
  }, [node.group.title]);

  // [事务] 提交：先清 guard，再取 trim 后的标题，最后按变化决定是否写库。
  // 空标题回退原标题（INV-09），无变化不写库（INV-10）。
  // 先 setRenaming(false) 再回调，避免父级重渲染时仍处编辑态。
  const commitRename = useCallback(() => {
    menuRenameFocusGuardRef.current = false;
    newGroupInitialFocusGuardRef.current = false;
    const nextTitle = renameDraft.trim() || node.group.title;
    setRenaming(false);
    if (nextTitle === node.group.title) {
      return;
    }
    onRenameGroup(node.group.id, nextTitle);
  }, [node.group.id, node.group.title, onRenameGroup, renameDraft]);

  // [契约] Enter 提交、Escape 取消，二者都必须阻止冒泡。
  // Enter 需先过 IME 组字判断（INV-07）。
  // 其他按键保持默认，输入法组字依赖它们。
  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: renameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // group 重命名里中文输入法用 Enter 确认候选词时也会冒出 keydown。
          // 这不是用户要提交重命名，不能 blur，否则 blur 会继续触发 commitRename。
          logger.debug("[WorkspaceGroupedTasksSection] ignore group rename enter during IME", {
            groupId: node.group.id,
          });
          return;
        }
        // 回归实测：显式 Enter 若只触发 blur，会被旧版菜单的焦点保护吞掉。
        // 直接提交用户意图，保留保护逻辑处理菜单自动抢焦和 IME 候选确认。
        event.preventDefault();
        event.stopPropagation();
        commitRename();
        return;
      }
      if (event.key === "Escape") {
        // group 标题编辑态按 Esc 只取消本次重命名，不能冒泡到外层弹层快捷键。
        event.preventDefault();
        event.stopPropagation();
        cancelRename();
      }
    },
    [cancelRename, commitRename, node.group.id],
  );

  // [并发] 失焦分三种：菜单保护窗口内回焦、新建保护窗口内回焦、真实提交。
  // 两个 guard 的判断顺序先菜单后新建。
  // 任一命中都不得 commitRename，否则编辑被意外结束。
  const handleRenameBlur = useCallback(() => {
    if (menuRenameFocusGuardRef.current) {
      // ContextMenu 的关闭动画和 focus restore 可能在 input 首次 focus 后继续触发 blur。
      // 这是菜单收尾阶段的焦点竞争，不代表用户结束重命名；保护窗口内保持编辑态并回焦。
      logger.debug(
        "[WorkspaceGroupedTasksSection] keep group rename focus after context menu blur",
        {
          groupId: node.group.id,
        },
      );
      focusRenameInput({ select: true });
      return;
    }
    if (newGroupInitialFocusGuardRef.current) {
      // 新建 group 会同时打开颜色菜单；Radix DropdownMenu 可能在打开瞬间抢焦，
      // 这个 blur 不代表用户结束命名，只在初始展开窗口内把焦点还给 name input。
      logger.debug("[WorkspaceGroupedTasksSection] keep new group initial name focus", {
        groupId: node.group.id,
      });
      focusRenameInput({ select: true });
      return;
    }
    commitRename();
  }, [commitRename, focusRenameInput, node.group.id]);

  useEffect(() => {
    return () => {
      if (menuRenameFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
      }
      if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
      }
    };
  }, []);

  // [并发] 新建分组初始窗口内忽略关闭请求并强制保持打开（INV-06）。
  // 窗口结束后的关闭按正常逻辑处理。
  // handleColorMenuOpenChange 只在 open 为 false 时走保护分支，打开请求照常透传给 setColorMenuOpen。
  const handleColorMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open && newGroupInitialFocusGuardRef.current) {
        // 新建 group 同时要求 name input 保持焦点、color menu 自动展开。
        // Radix 在 input 回焦时会把这次初始展开判成外部焦点移动并请求关闭；
        // 只忽略初始窗口内的这一次关闭，窗口结束后点击空白仍按正常关闭处理。
        logger.debug("[WorkspaceGroupedTasksSection] keep new group initial color menu open", {
          groupId: node.group.id,
        });
        setColorMenuOpen(true);
        return;
      }
      setColorMenuOpen(open);
    },
    [node.group.id],
  );

  // [契约] handleGroupColorChange 把 color 直接交给 onUpdateGroupColor，取值合法性由上层类型与校验负责。
  // 类型收窄到 ZCodeTaskGroupColor 依赖颜色常量表。
  // 系统分组也允许改色：isSystemGroup 只拦截重命名与解散，颜色变更不受这条约束。
  const handleGroupColorChange = useCallback(
    (color: string) => {
      onUpdateGroupColor(node.group.id, color as ZCodeTaskGroupColor);
    },
    [node.group.id, onUpdateGroupColor],
  );

  // [契约] 点击头部切换折叠；重命名输入框与按钮已 stopPropagation。
  // 不要在这里加选中逻辑，选中属于任务行。
  // 折叠状态由父级持有，组件只上报 groupId。
  const handleHeaderClick = useCallback(() => {
    onToggleCollapsed(node.group.id);
  }, [node.group.id, onToggleCollapsed]);

  // [契约] 键盘折叠：仅当事件源就是头部本身，且按键为 Enter/Space。
  // currentTarget !== target 直接返回，避免子元素按键冒泡误触发。
  // 必须 preventDefault，否则 Space 会滚动页面。
  const handleHeaderKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onToggleCollapsed(node.group.id);
    },
    [node.group.id, onToggleCollapsed],
  );

  useEffect(() => {
    if (!visualCollapsed) {
      setShouldRenderGroupContent(true);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setShouldRenderGroupContent(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [visualCollapsed]);

  useEffect(() => {
    if (!newGroupSetup) {
      return;
    }
    logger.debug("[WorkspaceGroupedTasksSection] start new group setup", {
      groupId: node.group.id,
    });
    armNewGroupInitialFocusGuard();
    startRename();
    setColorMenuOpen(true);
    focusRenameInput({ select: true });
    onNewGroupSetupStarted(node.group.id);
  }, [
    armNewGroupInitialFocusGuard,
    focusRenameInput,
    newGroupSetup,
    node.group.id,
    onNewGroupSetupStarted,
    startRename,
  ]);

  // [契约] 新建任务按钮在所有指针事件上 stopPropagation。
  // 否则按下即触发头部折叠或启动拖拽。
  // 按钮始终渲染，禁用态由上层 onCreateTask 语义决定。
  const newTaskButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-foreground-subtle hover:text-foreground"
      data-testid="task-group-new-task"
      aria-label={intl.formatMessage({ id: "taskGroup.newTask" })}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5" />
    </Button>
  );
  const newTaskAction = tooltipsDisabled ? (
    newTaskButton
  ) : (
    <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newTask" })}>
      {newTaskButton}
    </ControlHintTooltip>
  );

  return (
    <div
      ref={setGroupItemNodeRef}
      className={TASK_GROUP_CONTAINER_CLASS}
      data-grouped-group-item-id={node.group.id}
      data-task-group-id={node.group.id}
      data-task-group-title={node.group.title}
      data-group-collapsed={visualCollapsed ? "true" : "false"}
    >
      <ContextMenu onOpenChange={handleContextMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            ref={setGroupHeaderNodeRef}
            {...groupDraggable.attributes}
            {...groupDraggable.listeners}
            // 改名仅暂停拖拽；容器不可用会让内部输入框也继承禁用语义。
            aria-disabled={undefined}
            data-grouped-group-header-id={node.group.id}
            data-testid="task-group-menu"
            role="button"
            tabIndex={0}
            aria-controls={groupContentId}
            aria-expanded={!visualCollapsed}
            className={cn(
              TASK_GROUP_HEADER_CLASS,
              renaming ? "cursor-default" : "cursor-pointer",
              dragging && "opacity-0",
            )}
            onClick={handleHeaderClick}
            onKeyDown={handleHeaderKeyDown}
          >
            <DropdownMenu
              open={colorMenuOpen}
              onOpenChange={handleColorMenuOpenChange}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
                  data-testid="task-group-color-trigger"
                  aria-label={intl.formatMessage({ id: "taskGroup.color" })}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                >
                  <TaskGroupColorMark color={node.group.color} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-40 min-w-40"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuLabel>
                  {intl.formatMessage({ id: "taskGroup.color" })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={node.group.color}
                  onValueChange={handleGroupColorChange}
                >
                  {TASK_GROUP_COLORS.map((color) => (
                    <DropdownMenuRadioItem
                      key={color}
                      value={color}
                      data-testid={`task-group-color-${color}`}
                    >
                      <TaskGroupColorDot color={color} />
                      <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {renaming ? (
                <label
                  className="relative min-w-6 max-w-full shrink overflow-hidden align-middle"
                  onClick={(event) => event.stopPropagation()}
                  style={titleEditorWidth ? { width: `${titleEditorWidth}px` } : undefined}
                >
                  <span className="sr-only">{intl.formatMessage({ id: "taskGroup.rename" })}</span>
                  <button
                    ref={titleMeasureButtonRef}
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 invisible overflow-hidden rounded-sm px-1 text-left text-ui-base text-foreground"
                    // 测量节点不能跟随 label 的 max-w-full，否则输入变长时会被当前宽度反向卡住。
                    // 外层 label 继续用 max-w-full 负责视觉裁剪，这里只测真实内容宽度。
                    style={{ whiteSpace: "pre" }}
                  >
                    {titleEditorText}
                  </button>
                  <input
                    data-testid="task-group-title-input"
                    ref={titleInputRef}
                    autoFocus
                    className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-base leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
                    value={renameDraft}
                    onBlur={handleRenameBlur}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onCompositionEnd={() => {
                      renameCompositionActiveRef.current = false;
                    }}
                    onCompositionStart={() => {
                      renameCompositionActiveRef.current = true;
                    }}
                    onFocus={(event) => {
                      // 菜单收尾的迟到回焦不能全选已输入内容，否则后续按键会覆盖名称前缀。
                      if (event.currentTarget.value === node.group.title)
                        event.currentTarget.select();
                    }}
                    onKeyDown={handleRenameKeyDown}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => event.stopPropagation()}
                    placeholder={node.group.title}
                  />
                </label>
              ) : (
                <SidebarNativeTooltip>
                  <button
                    type="button"
                    className={TASK_GROUP_TITLE_CLASS}
                    title={displayTitle}
                    aria-label={displayTitle}
                  >
                    {displayTitle}
                  </button>
                </SidebarNativeTooltip>
              )}
              {visualCollapsed ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              ) : (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              )}
            </div>
            <span className={TASK_GROUP_COUNT_BADGE_CLASS}>
              {node.tasks.length + (hasDraftTask ? 1 : 0)}
            </span>
            {newTaskAction}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44" onCloseAutoFocus={handleContextMenuCloseAutoFocus}>
          <ContextMenuItem onSelect={onCreateTask}>
            {intl.formatMessage({ id: "taskGroup.newTask" })}
          </ContextMenuItem>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem data-testid="task-group-rename" onSelect={startRenameFromMenu}>
                {intl.formatMessage({ id: "taskGroup.renameAction" })}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              {intl.formatMessage({ id: "taskGroup.changeColor" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              className="w-40"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {TASK_GROUP_COLORS.map((color) => (
                <ContextMenuItem key={color} onSelect={() => handleGroupColorChange(color)}>
                  <TaskGroupColorDot color={color} />
                  <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-testid="task-group-ungroup"
                onSelect={() => onUngroupGroup(node.group.id)}
              >
                {intl.formatMessage({ id: "taskGroup.ungroup" })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <div
        id={groupContentId}
        data-grouped-group-content-id={node.group.id}
        aria-hidden={visualCollapsed}
        className={cn(
          "grid overflow-hidden",
          "transition-[grid-template-rows,opacity] duration-200 ease-out",
          visualCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* Bugfix: grouped task 的折叠内容不再走 Radix Collapsible。
                Radix Presence 和高度变量会在频繁挂载时重放动画；这里用本地受控容器，
                并在收起动画后卸载组内 task。 */}
          {shouldRenderGroupContent ? (
            <div
              className={cn(
                TASK_GROUP_CONTENT_CLASS,
                TASK_GROUP_BORDER_COLOR_CLASS[node.group.color],
              )}
            >
              {hasDraftTask ? (
                <>
                  <GroupedDraftTaskRow
                    active={Boolean(draftTaskActive)}
                    workspaceLabel={draftWorkspaceLabel ?? ""}
                    onSelect={onSelectDraftTask ?? onCreateTask}
                    onClose={onCloseDraftTask}
                  />
                  <VirtualizedGroupedTaskList
                    tasks={node.tasks}
                    groupId={node.group.id}
                    groups={groups}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getTaskWorkspaceLabel}
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
                    activeDragTaskKey={activeDragTaskKey}
                    tooltipsDisabled={tooltipsDisabled}
                  />
                </>
              ) : (
                <>
                  {shouldShowEmptyDropZone ? (
                    <EmptyGroupDropZone groupId={node.group.id} onCreateTask={onCreateTask} />
                  ) : null}
                  {node.tasks.length > 0 ? (
                    <VirtualizedGroupedTaskList
                      tasks={node.tasks}
                      groupId={node.group.id}
                      groups={groups}
                      getTaskRemoteSessionId={getTaskRemoteSessionId}
                      getTaskWorkspaceLabel={getTaskWorkspaceLabel}
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
                      activeDragTaskKey={activeDragTaskKey}
                      tooltipsDisabled={tooltipsDisabled}
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div
        ref={expandedGroupFooterDroppable.setNodeRef}
        aria-hidden="true"
        className={cn(
          "transition-[height,opacity] duration-150 ease-out motion-reduce:transition-none",
          visualCollapsed ? "h-0 pointer-events-none opacity-0" : "h-2.5 opacity-100",
        )}
      />
    </div>
  );
}
