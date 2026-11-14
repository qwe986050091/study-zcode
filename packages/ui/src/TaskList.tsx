// TaskList.tsx —— 任务列表：排序、行内操作、重命名、归档确认与列表级右键菜单。
//
// 职责边界
//   做什么：渲染任务行、维护重命名与归档确认的临时状态、向父级上报选择与操作。
//   不做什么：不读写任务仓库、不管理会话、不决定任务是否可见。
//   依赖谁：会话草稿入口、Tab store、行组件与右键菜单内容、排序比较函数。
//   被谁调用：侧边栏任务区与归档列表，两条链路共用同一行渲染。
//   边界：组件只持有交互态，任务事实全部来自 props 与上层回调。
//
//
// INV-01 整体必须 memo：父级流式更新不能带动列表重排 —— 守住它的位置：导出处的 memo —— 改错故障：每次 token 增量都重新遍历任务并重建行组件
// INV-02 置顶列表默认值必须是模块级常量 —— 守住它的位置：EMPTY_PINNED_TASKS —— 改错故障：默认空数组每次渲染新建引用，memo 完全失效
// INV-03 回调 ref 必须在每次渲染同步赋值 —— 守住它的位置：六行 ref 赋值 —— 改错故障：稳定回调里读到上一次的父级函数，操作落到旧任务上
// INV-04 所有写操作入口先判只读原因 —— 守住它的位置：各 handler 首行 —— 改错故障：只读视图里仍能归档或重命名
// INV-05 归档必须二次确认：首击只进入待确认 —— 守住它的位置：handleArchiveTaskFromInline —— 改错故障：误触后任务直接消失，用户以为数据丢失
// INV-06 开始重命名时必须清空归档待确认 —— 守住它的位置：handleStartRenameTask —— 改错故障：同一行同时显示确认态与输入框
// INV-07 提交重命名前必须 trim 并与原标题比较 —— 守住它的位置：normalizedTitle 判断 —— 改错故障：只有空格变化也会发一次无意义的写请求
// INV-08 重命名失败必须提示并保留对话框 —— 守住它的位置：返回空 meta 的分支 —— 改错故障：输入框关闭但标题没变，用户不知道失败
// INV-09 任务消失时重命名、归档确认、右键目标三个状态必须各自清理 —— 守住它的位置：三个存在性 effect —— 改错故障：残留状态让下一次点击命中不存在的任务
// INV-10 重命名输入框挂载后必须聚焦并全选 —— 守住它的位置：renamingTaskId effect —— 改错故障：输入框出现但光标不在，键盘输入无效
// INV-11 排序不能就地修改 tasks 数组 —— 守住它的位置：visibleSourceTasks 的 useMemo —— 改错故障：父级持有的任务顺序被意外打乱
// INV-12 新建任务只进入草稿：不能立即创建 —— 守住它的位置：handleCreateTask —— 改错故障：侧边栏多出没有任何消息的空任务
// INV-13 行组件 key 必须是 taskId —— 守住它的位置：renderTaskItem —— 改错故障：重命名后行组件被重建，展开态与焦点丢失
// INV-14 移动端激活判定必须用统一的工作区 key —— 守住它的位置：buildTaskWorkspaceKey 调用 —— 改错故障：同名任务在不同工作区互相点亮
// INV-15 右键菜单是列表级单例：行只上报目标 id —— 守住它的位置：contextMenuTaskId —— 改错故障：每行常驻一个菜单根节点，大会话下开销暴涨
// INV-16 行内归档按钮必须阻止冒泡 —— 守住它的位置：handleArchiveTaskFromInline 首行 —— 改错故障：点归档同时选中并打开该任务
// INV-17 置顶集合必须由置顶列表 memo 得到 —— 守住它的位置：pinnedTaskIdSet —— 改错故障：每行渲染都重建 Set，长列表明显变慢
// INV-18 归档确认必须读 ref 里的最新值 —— 守住它的位置：pendingArchiveTaskIdRef —— 改错故障：连续快速点击两次被当成一次，无法确认
//
// 维护提示
//   这里的状态都是交互态，刷新后必须能自然消失，不要持久化。
//   新增行内操作时先想清楚它是否需要 ref 化，避免 memo 子组件频繁重建。
//   列表只做展示与转发，任务可见性由上游筛选，不要在这里加过滤条件。
//   归档与重命名共享同一行，操作互斥关系必须显式写清。
//   日志用于排查重命名链路，新增日志保持 info 级别并带任务 id。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
/* eslint-disable max-lines -- TaskList 同时承接 workspace 列表渲染、行内操作和外部数据源兼容，先集中收口避免 UI 结构漂移。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_LIST, TID_TASK_EMPTY, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { logger } from "@/logger.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

export { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";

// 默认参数里的 [] 会在每次 TaskList render 时创建新数组；
// 任务流刷新期间这会放大 memo 子组件的等价数据判断成本。
// [资源] 默认值必须是模块级常量。
// 写在参数默认值里会每次渲染新建数组，
// memo 的浅比较因此永远失败。
const EMPTY_PINNED_TASKS: ZCodeTaskMeta[] = [];

// 父级 App/Shell 可能因 stream 状态更新重渲，但列表 props 本身未变。
// TaskList 先整体 memo，避免无关父 render 重新遍历任务并触发 MemoTaskItem props 计算。
// [契约] 整个列表用 memo 包裹。
// 父级会因流式输出频繁重渲，
// 但任务数组引用不变时列表不需要重算。
export const TaskList = memo(function TaskList({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  tasks,
  pinnedTasks = EMPTY_PINNED_TASKS,
  activeTaskId,
  sortBy = "manual",
  isWorkspaceActive = true,
  onSelectTask,
  showCreateButton = true,
  showFooter = true,
  showEmptyState = true,
  taskRowVariant = "default",
  hoverEnabled = true,
  loading: inputLoading,
  hasMore = false,
  onShowMore,
  onRenameTask,
  onSetTaskPinned,
  onArchiveTask,
  isArchived = false,
  onSetTaskUnread,
  mobileActiveTaskKey,
  readOnlyReason,
  onOpenFileTree,
  organizationActions,
}: {
  organizationActions?: React.ReactNode;
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  tasks: ZCodeTaskMeta[];
  pinnedTasks?: ZCodeTaskMeta[];
  activeTaskId: string | null;
  sortBy?: "manual" | "created" | "updated";
  isWorkspaceActive?: boolean;
  onSelectTask: (taskId: string) => void;
  showCreateButton?: boolean;
  showFooter?: boolean;
  showEmptyState?: boolean;
  taskRowVariant?: "default" | "timeline";
  hoverEnabled?: boolean;
  loading?: boolean;
  hasMore?: boolean;
  onShowMore?: () => void;
  onRenameTask: (taskId: string, title: string) => Promise<ZCodeTaskMeta | null>;
  onSetTaskPinned: (taskId: string, pinned: boolean) => Promise<ZCodeTaskMeta | null>;
  onArchiveTask: (taskId: string) => Promise<ZCodeTaskMeta | null>;
  isArchived?: boolean;
  onSetTaskUnread: (taskId: string, unread: boolean) => Promise<ZCodeTaskMeta | null>;
  mobileActiveTaskKey?: string | null;
  readOnlyReason?: string;
  onOpenFileTree?: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  // [资源] pinnedTaskIdSet 按 pinnedTasks 缓存成一个 Set。
  // pinnedTaskIdSet.has 在每行渲染时都要调用，
  // 不缓存会让 useMemo 退化成平方级遍历。
  const pinnedTaskIdSet = useMemo(
    () => new Set(pinnedTasks.map((task) => task.taskId)),
    [pinnedTasks],
  );
  // [契约] taskLookup 合并 tasks 与 pinnedTasks 两张表。
  // 重命名与右键菜单都按 taskId 查找任务，
  // 两处共用同一份 taskLookup 顺序。
  const taskLookup = useMemo(() => [...tasks, ...pinnedTasks], [pinnedTasks, tasks]);
  // startDraft 从 useZCodeSessionStore 只取动作、不取 draft 内容：若把草稿字段一并订阅，每次输入都会让整个 TaskList 重渲，MemoTaskItem 也挡不住父级下发的重渲。
  const startDraft = useZCodeSessionStore((state) => state.startDraft);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  // [契约] pendingArchiveTaskId 是单个 id，不是集合。
  // useState 保证同一时刻只有一行处于确认态，
  // 避免多个 TaskItem 同时闪烁。
  const [pendingArchiveTaskId, setPendingArchiveTaskId] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [contextMenuTaskId, setContextMenuTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // renameInputRef 必须由 TaskList 持有并传给 TaskRenameDialog：打开瞬间由 renamingTaskId 的 effect 统一 focus/select，若对话框内部自建 ref，外部就拿不到挂载后的 input 完成聚焦与全选。
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // [并发] 确认态需要一份 ref 镜像。
  // 行内回调被 ref 化后不再随状态重建，
  // 只能通过 ref 读取最新值。
  const pendingArchiveTaskIdRef = useRef<string | null>(pendingArchiveTaskId);
  const renamingTaskIdRef = useRef<string | null>(renamingTaskId);
  const onSelectTaskRef = useRef(onSelectTask);
  const onSetTaskPinnedRef = useRef(onSetTaskPinned);
  const onArchiveTaskRef = useRef(onArchiveTask);
  const onSetTaskUnreadRef = useRef(onSetTaskUnread);
  // [契约] 每次渲染同步写回所有回调 ref。
  // 这段赋值必须留在渲染期。
  // 放进 effect 会晚一帧，点击时可能拿到上一次的父级函数。
  pendingArchiveTaskIdRef.current = pendingArchiveTaskId;
  renamingTaskIdRef.current = renamingTaskId;
  onSelectTaskRef.current = onSelectTask;
  onSetTaskPinnedRef.current = onSetTaskPinned;
  onArchiveTaskRef.current = onArchiveTask;
  onSetTaskUnreadRef.current = onSetTaskUnread;
  // [契约] handleCancelArchiveConfirm 只清 pendingArchiveTaskId。
  // 不能顺带清 renamingTaskId，两个交互互不影响。
  // 归档确认与 TaskRenameDialog 各自独立存在。
  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveTaskId(null);
  }, []);

  // [契约] handleCancelRenameTask 同时清 renamingTaskId 与 renameDraft。
  // 只清 id 会让 renameDraft 残留上一次的输入。
  // 取消走本地 setState，不通知父级。
  const handleCancelRenameTask = useCallback(() => {
    setRenamingTaskId(null);
    setRenameDraft("");
  }, []);

  // [契约] 选择通过 ref 转发给最新回调。
  // 依赖为空是刻意的，
  // 这样行组件的 props 不会随父级函数变化。
  const handleSelectTaskItem = useCallback((taskId: string) => {
    onSelectTaskRef.current(taskId);
  }, []);
  // [契约] TaskRow 只上报 taskId，菜单由列表级单例渲染。
  // 每行常驻 ContextMenu root 会放大浮层挂载成本。
  // 打开菜单时若 pendingArchiveTaskId 命中该行，要先取消。
  // 这个清理只能读 ref，因为回调不依赖确认状态。
  const handleOpenTaskContextMenu = useCallback((taskId: string) => {
    // 以前每个 task row 都常驻一个 Radix ContextMenu root/trigger。
    // 现在 row 只上报目标 task，真正的菜单树由列表级单例挂载，避免大会话里按行放大 Popper/MenuProvider 成本。
    if (pendingArchiveTaskIdRef.current === taskId) {
      setPendingArchiveTaskId(null);
    }
    setContextMenuTaskId(taskId);
  }, []);

  // handleCreateTask 只调 startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" }) 而不在点击时 createTask：提前创建会把零消息空任务写进侧边栏；readOnlyReason 非空必须先 return，否则只读视图仍能开出草稿。
  const handleCreateTask = useCallback(() => {
    if (readOnlyReason) {
      return;
    }
    // 新建会话如果在按钮点击时就立即 createTask，会把"空任务"也持久化到列表里，
    // 用户只是想先打开输入框，侧边栏却会平白多出一条没有任何消息的记录。
    // 这里改成进入 workspace 级草稿态，等用户真正发送首条消息时再自动创建 task。
    startDraft(workspacePath, undefined, workspaceIdentity, { createSource: "project" });
  }, [readOnlyReason, startDraft, workspaceIdentity, workspacePath]);

  // handleArchiveTaskFromInline 的顺序不可换：e.stopPropagation() 必须最先执行，否则点击归档会冒泡到行选择；pendingArchiveTaskIdRef.current !== taskId 时只 setPendingArchiveTaskId(taskId) 并 return，第二次点击才调 onArchiveTaskRef.current(taskId)，缺这层确认会让任务突然消失被当成数据丢失。
  const handleArchiveTaskFromInline = useCallback(
    async (e: React.MouseEvent, taskId: string) => {
      e.stopPropagation();
      if (readOnlyReason) {
        return;
      }
      if (renamingTaskIdRef.current) {
        handleCancelRenameTask();
      }

      if (pendingArchiveTaskIdRef.current !== taskId) {
        // 侧边栏 hover 操作现在改成“归档任务”，但它依旧会让任务从当前列表立刻消失，
        // 如果首击就直接执行，用户很容易把“临时收起”误触成“怎么整条任务没了”。
        // 这里改成“首次点击进入待确认态，二次点击原位确认”，既保留保护，也不离开当前上下文。
        setPendingArchiveTaskId(taskId);
        return;
      }

      setPendingArchiveTaskId(null);
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  // handleStartRenameTask 必须先 setPendingArchiveTaskId(null) 再 setRenamingTaskId(taskId)：同一行同时处于归档确认与重命名会叠出两个交互层；renameDraft 取 currentTitle ?? ""，不能塞占位文案，否则提交时 normalizedTitle 会把占位文本写成真实标题。
  const handleStartRenameTask = useCallback(
    (taskId: string, currentTitle: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename start", {
        taskId,
        workspacePath,
        workspaceIdentity,
        titleLength: currentTitle.length,
      });
      setPendingArchiveTaskId(null);
      setRenamingTaskId(taskId);
      setRenameDraft(currentTitle ?? "");
    },
    [readOnlyReason, workspaceIdentity, workspacePath],
  );

  // handleTogglePinTask 只把 onSetTaskPinnedRef.current(taskId, pinned) 的返回值当成败信号：空值直接 return，成功后也不写本地副本——列表由父级 pinnedTasks 回写，本地再存一份会和父级刷新后的顺序打架。
  const handleTogglePinTask = useCallback(
    async (taskId: string, pinned: boolean) => {
      if (readOnlyReason) {
        return;
      }
      const updatedTask = await onSetTaskPinnedRef.current(taskId, pinned);
      if (!updatedTask) {
        return;
      }
    },
    [readOnlyReason],
  );

  // handleArchiveTask 供列表级右键菜单使用，不经 pendingArchiveTaskId 二次确认——打开菜单再点归档已是两步；执行前必须同时 setPendingArchiveTaskId(null) 与 handleCancelRenameTask()，否则残留的确认态或重命名框会指向刚被归档的 taskId。
  const handleArchiveTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      setPendingArchiveTaskId(null);
      handleCancelRenameTask();
      await onArchiveTaskRef.current(taskId);
    },
    [handleCancelRenameTask, readOnlyReason],
  );

  // handleSubmitRenameTask 先从 taskLookup 找 taskId：找不到说明对话框打开期间任务已被其他端删除，必须 handleCancelRenameTask() 返回；normalizedTitle === task.title.trim() 时同样不调 onRenameTask，避免无内容变更的写请求与日志噪音。
  const handleSubmitRenameTask = useCallback(
    async (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      logger.info("[TaskList] rename submit entered", {
        taskId,
        workspacePath,
        workspaceIdentity,
        draftLength: renameDraft.length,
        trimmedLength: renameDraft.trim().length,
        taskCount: taskLookup.length,
      });
      const task = taskLookup.find((candidate) => candidate.taskId === taskId);
      if (!task) {
        logger.warn("[TaskList] rename submit task missing", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        handleCancelRenameTask();
        return;
      }

      // [契约] 提交前统一 trim。
      // 首尾空格会让显示与存储不一致，列表里看起来像标题丢了。
      // 比较也要基于 trim 后的值。
      const normalizedTitle = renameDraft.trim();
      if (normalizedTitle === task.title.trim()) {
        logger.info("[TaskList] rename submit unchanged", {
          taskId,
          workspacePath,
          workspaceIdentity,
          titleLength: normalizedTitle.length,
        });
        handleCancelRenameTask();
        return;
      }

      // task 标题如果直接保留用户输入的首尾空格，列表里看起来像“没对齐”或“标题丢了”，
      // 但真实持久化内容又已经变化，后续排查很难复现。这里在提交前统一 trim，保证显示和存储一致。
      logger.info("[TaskList] rename submit calling onRenameTask", {
        taskId,
        workspacePath,
        workspaceIdentity,
        previousTitleLength: task.title.length,
        nextTitleLength: normalizedTitle.length,
      });
      // [失败路径] 重命名抛错时不吞异常，先记录日志再原样抛出。
      // 异常上抛给 TaskRenameDialog 决定是否展示全局错误。
      // 返回空值则提示并保留对话框。
      let renamedTask: ZCodeTaskMeta | null;
      try {
        renamedTask = await onRenameTask(taskId, normalizedTitle);
      } catch (error) {
        logger.error("[TaskList] rename submit onRenameTask rejected", {
          taskId,
          workspacePath,
          workspaceIdentity,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.info("[TaskList] rename submit onRenameTask resolved", {
        taskId,
        workspacePath,
        workspaceIdentity,
        resolved: Boolean(renamedTask),
        resolvedTitleLength: renamedTask?.title.length,
      });
      if (!renamedTask) {
        logger.warn("[TaskList] rename submit returned empty meta", {
          taskId,
          workspacePath,
          workspaceIdentity,
        });
        toast(intl.formatMessage({ id: "taskList.renameFailed" }));
        return;
      }

      handleCancelRenameTask();
      logger.info("[TaskList] rename submit dialog closed", {
        taskId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [
      handleCancelRenameTask,
      intl,
      onRenameTask,
      readOnlyReason,
      renameDraft,
      taskLookup,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // handleMarkTaskAsUnread 用 void onSetTaskUnreadRef.current(taskId, true) 发起后立即返回：未读标记是弱一致操作，await 会阻塞行点击；失败提示由 onSetTaskUnread 的实现方统一处理，这里不再 try/catch。
  const handleMarkTaskAsUnread = useCallback(
    (taskId: string) => {
      if (readOnlyReason) {
        return;
      }
      void onSetTaskUnreadRef.current(taskId, true);
    },
    [readOnlyReason],
  );

  useEffect(() => {
    // renamingTaskId 为空时直接 return：TaskRenameDialog 尚未挂载，renameInputRef.current 为 null，继续往下只会做一次无效的 focus/select 调用。
    if (!renamingTaskId) {
      return;
    }

    // renamingTaskId 变化后必须先 focus() 再 select()：对话框此时才挂载，只 focus 不全选会让用户手动删原标题才能覆盖输入。
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskId]);

  // [契约] 手动排序直接使用原数组。
  // 其余排序复制一份再排，
  // 不能就地排序父级传入的 tasks。
  const visibleSourceTasks = useMemo(() => {
    const orderedTasks =
      sortBy === "manual"
        ? tasks
        : [...tasks].sort((left, right) => compareZCodeTaskListItems(left, right, sortBy));
    return orderedTasks;
  }, [sortBy, tasks]);
  useEffect(() => {
    // pendingArchiveTaskId 的 effect 用 visibleSourceTasks.some(...) 校验目标仍存在：列表刷新或切换工作区后 taskId 可能已不在，必须 setPendingArchiveTaskId(null)，否则残留确认态会让下一次点击命中不存在的任务。
    if (!pendingArchiveTaskId) {
      return;
    }

    const stillExists = visibleSourceTasks.some((task) => task.taskId === pendingArchiveTaskId);
    if (!stillExists) {
      setPendingArchiveTaskId(null);
    }
  }, [pendingArchiveTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!renamingTaskId) {
      return;
    }

    // renamingTaskId 的 effect 同样用 visibleSourceTasks 校验：任务被删除或归档后必须 handleCancelRenameTask()，否则对话框仍开着，handleSubmitRenameTask 会在 taskLookup 里查不到而落到静默取消。
    const stillExists = visibleSourceTasks.some((task) => task.taskId === renamingTaskId);
    if (!stillExists) {
      handleCancelRenameTask();
    }
  }, [handleCancelRenameTask, renamingTaskId, visibleSourceTasks]);

  useEffect(() => {
    if (!contextMenuTaskId) {
      return;
    }

    // [契约] contextMenuTaskId 指向的任务消失后关闭菜单。
    // 菜单内容依赖任务对象，
    // 目标不存在时渲染会拿到 null。
    const stillExists = visibleSourceTasks.some((task) => task.taskId === contextMenuTaskId);
    if (!stillExists) {
      setContextMenuTaskId(null);
    }
  }, [contextMenuTaskId, visibleSourceTasks]);

  // [契约] 菜单任务对象由 id 反查。
  // 查不到时返回 null，
  // 菜单据此决定是否渲染，
  // 不要在渲染期直接抛错。
  const contextMenuTask = useMemo(
    () =>
      contextMenuTaskId
        ? (taskLookup.find((task) => task.taskId === contextMenuTaskId) ?? null)
        : null,
    [contextMenuTaskId, taskLookup],
  );

  // renderTaskItem 定义在组件体内而不是模块级：它闭包了 pendingArchiveTaskId、pinnedTaskIdSet 与 handleSelectTaskItem 等当前渲染值；提成模块级函数只能靠参数透传，漏传任何一项都会渲染出上一帧的确认态。
  function renderTaskItem(task: (typeof visibleSourceTasks)[number]) {
    // isPinned 用 pinnedTaskIdSet.has(task.taskId) 而不是 pinnedTasks.some(...)：这个判断每行执行一次，数组查找在长列表下退化成 O(n²)，pinnedTaskIdSet 已按 pinnedTasks 做 useMemo 缓存。
    const isPinned = pinnedTaskIdSet.has(task.taskId);
    return (
      <MemoTaskItem
        key={task.taskId}
        workspacePath={workspacePath}
        remoteSessionId={remoteSessionId}
        task={task}
        variant={taskRowVariant}
        hoverEnabled={hoverEnabled}
        isPinned={isPinned}
        isArchived={isArchived}
        isActive={isWorkspaceActive && task.taskId === activeTaskId}
        isMobileActive={
          mobileActiveTaskKey ===
          `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${task.taskId}`
        }
        onSelectTask={handleSelectTaskItem}
        onArchiveTaskInline={handleArchiveTaskFromInline}
        onCancelArchiveConfirm={handleCancelArchiveConfirm}
        isArchiveConfirming={pendingArchiveTaskId === task.taskId}
        onTogglePinTask={handleTogglePinTask}
        onStartRenameTask={handleStartRenameTask}
        onArchiveTask={handleArchiveTask}
        onMarkTaskAsUnread={handleMarkTaskAsUnread}
        onOpenTaskContextMenu={handleOpenTaskContextMenu}
        onOpenFileTree={onOpenFileTree}
        actionsDisabled={Boolean(readOnlyReason)}
        actionsDisabledReason={readOnlyReason}
        intl={intl}
      />
    );
  }

  return (
    <div data-testid={TID_TASK_LIST} className={"flex flex-col gap-2"}>
      {renamingTaskId !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            logger.info("[TaskList] rename confirm dispatched", {
              renamingTaskId,
              workspacePath,
              workspaceIdentity,
              draftLength: renameDraft.length,
            });
            if (!renamingTaskId) {
              return;
            }
            void handleSubmitRenameTask(renamingTaskId);
          }}
        />
      ) : null}

      {showCreateButton ? (
        <div className="border-b p-3">
          <ControlHintTooltip
            title={readOnlyReason ?? intl.formatMessage({ id: "taskList.newThread" })}
          >
            <div>
              <NewTaskButtonGroup
                onCreateTask={handleCreateTask}
                disabled={Boolean(readOnlyReason)}
              />
            </div>
          </ControlHintTooltip>
        </div>
      ) : null}

      {/* 任务列表 */}
      <div>
        <div className="space-y-1">
          {Boolean(inputLoading) && visibleSourceTasks.length === 0 ? (
            <TaskListLoadingHint />
          ) : visibleSourceTasks.length === 0 ? (
            showEmptyState ? (
              <div
                data-testid={TID_TASK_EMPTY}
                className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
              >
                {intl.formatMessage({ id: "taskList.noTasks" })}
              </div>
            ) : null
          ) : (
            <ContextMenu
              onOpenChange={(open) => {
                if (!open) {
                  setContextMenuTaskId(null);
                }
              }}
            >
              <ContextMenuTrigger asChild>
                <ul className="space-y-0.5">{visibleSourceTasks.map(renderTaskItem)}</ul>
              </ContextMenuTrigger>
              {contextMenuTask ? (
                <TaskListItemContextMenuContent
                  workspacePath={workspacePath}
                  remoteSessionId={remoteSessionId}
                  task={contextMenuTask}
                  isPinned={pinnedTaskIdSet.has(contextMenuTask.taskId)}
                  isArchived={isArchived}
                  organizationActions={organizationActions}
                  intl={intl}
                  onTogglePinTask={handleTogglePinTask}
                  onStartRenameTask={handleStartRenameTask}
                  onArchiveTask={handleArchiveTask}
                  onMarkTaskAsUnread={handleMarkTaskAsUnread}
                  disableTaskActions={Boolean(readOnlyReason)}
                  disabledReason={readOnlyReason}
                />
              ) : null}
            </ContextMenu>
          )}
        </div>
        {hasMore && onShowMore ? (
          <div className="pl-8.5">
            <button
              type="button"
              data-task-list-show-more="true"
              className="rounded-sm bg-transparent p-0 text-ui-sm text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
              onClick={onShowMore}
            >
              {intl.formatMessage({ id: "taskList.showMore" })}
            </button>
          </div>
        ) : null}
      </div>

      {showFooter ? (
        <div className="border-t border-outline/40 p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openSettingsTab}
            data-testid={TID_TASK_SETTINGS_BUTTON}
            className="w-full justify-center"
          >
            <Settings2 className="h-3.5 w-3.5" />
            {intl.formatMessage({ id: "taskList.openSettings" })}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

TaskList.displayName = "TaskList";
