// TaskGroupedView（ui/project-sidebar）深注：分组列表的展示投影，不承载业务状态。
// 做：把权威分组视图与拖动投影渲染成列表，桥接选择、移动、重命名、归档与草稿动作。
// 不做：不保存任务或分组事实、不直接调服务、不在组件内维护第二份顺序。
// 依赖：ProjectDirectoryProvider 提供分组事实，状态 store 提供 activeTaskId 与草稿归属。
// 边界：业务状态归服务端与 store；本组件只保留临时交互态（展开、重命名、sticky），并在卸载时丢弃。
// 边界：所有写操作都经 action/mutate 收敛错误，组件不向上抛业务异常。
//
// INV-01 断言：workspaceKey 必须 identity 优先、path 兜底 —— 守住它的位置：state 选择器 —— 改错故障：同路径的另一远端 workspace 互相串线。
// INV-02 断言：分组结构只读权威视图或 drag 投影 —— 守住它的位置：authoritativeView 与 drag.view —— 改错故障：组件持有第二份业务状态，与服务端不一致。
// INV-03 断言：草稿归属只来自 store 与草稿内存 —— 守住它的位置：draftGroupId 计算 —— 改错故障：localStorage 复活已提交的旧 placement。
// INV-04 断言：存在 activeTaskId 时不读 draftTaskGroupId —— 守住它的位置：draftGroupId 三元式 —— 改错故障：查看会话时显示未提交的分组草稿。
// INV-05 断言：折叠集合持久化必须在 effect 中，不能在 set 回调里 —— 守住它的位置：persist effect —— 改错故障：并发 set 触发重复写入。
// INV-06 断言：折叠集合必须不可变更新 —— 守住它的位置：toggleCollapsed 与 createTask —— 改错故障：原地修改 Set 不触发重渲染。
// INV-07 断言：移动命令基于 authoritativeView 计算 —— 守住它的位置：moveTask —— 改错故障：用 drag 投影生成命令会带上临时顺序。
// INV-08 断言：拖动只改投影，提交仍走 organization.move —— 守住它的位置：useGroupedDrag 的 onMove —— 改错故障：两处写导致顺序竞争。
// INV-09 断言：移动失败后必须 refresh —— 守住它的位置：move 的 catch —— 改错故障：本地投影与服务器不一致且不会自愈。
// INV-10 断言：归档成功后必须移除 task state —— 守住它的位置：mutate —— 改错故障：已归档任务的 UI 状态残留。
// INV-11 断言：mutate 后无条件 refresh —— 守住它的位置：mutate 尾部 —— 改错故障：本地看不到服务端权威结果。
// INV-12 断言：dragging 时必须清空 sticky —— 守住它的位置：sticky effect 早退 —— 改错故障：sticky header 指向已在投影中消失的分组。
// INV-13 断言：sticky 同时监听 scroll、resize 与 ResizeObserver —— 守住它的位置：订阅块 —— 改错故障：展开动画结束后尺寸变化不再更新 sticky。
// INV-14 断言：effect 清理必须取消 frame 并断开 observer —— 守住它的位置：返回的清理函数 —— 改错故障：卸载后仍 setState。
// INV-15 断言：首帧无 overflow 不能提前 return —— 守住它的位置：scrollRef 判空 —— 改错故障：漏订阅后续滚动，sticky 永久钉在错误分组。
// INV-16 断言：自动化分组的新建要直接回调，不建普通任务 —— 守住它的位置：createTask 首个分支 —— 改错故障：误建一条普通任务。
// INV-17 断言：新建任务前先展开目标分组 —— 守住它的位置：createTask —— 改错故障：新任务落在收起的分组里不可见。
// INV-18 断言：关闭草稿同时清持久草稿与内存归属 —— 守住它的位置：closeDraft —— 改错故障：两份草稿不同步，刷新后草稿复活。
// INV-19 断言：onSelect 必须带上解析出的 remoteSessionId —— 守住它的位置：rowCallbacks.onSelectTask —— 改错故障：远端任务打开到错误会话。
// INV-20 断言：rowCallbacks 每次渲染重建，不要 memo 成常量 —— 守住它的位置：对象字面量 —— 改错故障：闭包捕获旧视图与旧 activeTaskId。
//
// 阅读提示：先分清权威视图、拖动投影、临时交互态三层，再判断某段代码该不该改。
// 组件边界：这里不判断权限、不决定重连策略，这些由服务与 store 负责。
// 失败语义：业务失败统一走 report 提示；组件不抛出，避免整棵列表被错误边界吞掉。
// 可观测性：分组操作失败必须经 logger 记录原始错误，只提示用户会丢失排障线索。
// 改动前自检：是否新增了第二份顺序或归属？是否让拖动状态写回了权威视图？
// 改动前自检：是否把订阅或解析放进渲染期？是否漏掉 effect 清理？
// 改动前自检：是否为某条路径绕过了 refresh，导致本地与服务端长期不一致？
// 权衡：rowCallbacks 每次重建带来少量分配，换取永不捕获过期闭包。
// 权衡：折叠状态放在本地 state 并持久化，服务端不参与，避免高频交互产生写请求。
// 结束：正文按组件执行顺序给出，锚点均落在语句之间，未进入 JSX 子节点与属性行。
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Hash, Maximize2, Minimize2 } from "lucide-react";
import { OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import type {
  ProjectTask,
  ProjectSidebarProps,
  MoveGroupNode,
  TaskGroupColor,
} from "@/project-sidebar/contract.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import {
  readGroupedTaskCollapsedGroupIds,
  persistGroupedTaskCollapsedGroupIds,
} from "@/project-sidebar/grouped-expansion.js";
import { buildGroupedTaskView, groupedMoveCommand } from "@/project-sidebar/grouped/model.js";
import { GroupItem } from "@/project-sidebar/grouped/group-item.js";
import { GroupedTaskItem } from "@/project-sidebar/grouped/task-item.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { GroupDragOverlay } from "@/project-sidebar/grouped/group-drag-overlay.js";
import { StickyGroupHeader } from "@/project-sidebar/grouped/sticky-group-header.js";
import { StickyGroupHeaderSlot } from "@/project-sidebar/grouped/sticky-group-header-slot.js";
import { VirtualizedGroupedTopLevelList } from "@/project-sidebar/grouped/virtualized-top-level-list.js";
import { useGroupedDrag } from "@/project-sidebar/grouped/useGroupedDrag.js";
import {
  GROUPED_TASK_DROP_ANIMATION,
  findNearestScrollableAncestor,
  resolveStickyGroupedTaskGroupId,
} from "@/project-sidebar/grouped/drag.js";
import { taskKey } from "@/project-sidebar/grouped/ids.js";
import {
  findTaskInGroupedView,
  moveTaskByMenu,
  moveTaskToTopByMenu,
} from "@/project-sidebar/grouped/view.js";
import { mutateProjectTask, type ProjectTaskMutation } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  clearV4ComposerDraftTaskGroup,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

/** 恢复删除前的组件与手势（fd2f4f38a4a^1）；仅将旧事实缓存/applyOrder 改接当前 owner。 */
// [契约] 组件是受控展示层：tasks 与 organization 是入参事实，内部不另存副本。
// 新增 props 必须来自上层投影，不能在组件内读服务补齐。
// [边界] 组件不自带 Provider，依赖由调用方注入。
export function TaskGroupedView({
  tasks,
  onSelect,
  refresh,
  onCreate,
  workspacePath,
  workspaceIdentity,
  onOpenAutomations,
  toolbarTarget,
  stickyTarget,
  scrollRef,
}: {
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  onCreate(groupId: string | null): void;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenAutomations?: () => void;
  toolbarTarget: HTMLElement | null;
  stickyTarget: HTMLElement | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  // [契约] organization 是分组事实与写入口，改名会同时影响渲染与命令构造。
  // [契约] loading 只用于空态判断，不能用来阻止移动等写操作。
  // [边界] 这里不复制 organization 内部结构，避免快照过期。
  const { groups: organization, loading } = useProjectDirectory();
  const { intl } = useZCodeIntl();
  const presentation = useContext(ProjectTaskListContext);
  const { zcodeTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  // [契约] 身份 key 必须先 trim 再判空，空 identity 视为缺失。
  // 该 key 同时用于 activeTaskId 与草稿归属，两处必须共用同一个值。
  // [契约] 不要在这里回落成 remoteSessionId：身份隔离的粒度不同。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const composerClientNamespace = useComposerClientNamespace();
  // [契约] draftScope 由 workspace 身份与 composer 命名空间共同决定。
  // 草稿读取与清除必须使用同一个 scope，否则会清到别人的草稿。
  // [边界] 这里只解析 scope，不读写草稿内容。
  const draftScope = readComposerWorkspaceScope(
    workspacePath,
    workspaceIdentity,
    composerClientNamespace,
  );
  // [契约] 选择器只取当前 workspace 的 activeTaskId，避免订阅整棵 store。
  // 缺省用 null 而不是 undefined：后续三元判断依赖 null 表示无活动任务。
  // [边界] activeTaskId 只影响展示，不决定路由或持久化。
  const activeTaskId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  // [契约] 该版本号只用于触发滚动复位，不代表草稿内容变化。
  // 不要用草稿内容做依赖：内容高频变化会导致滚动被反复重置。
  // [边界] 版本号缺失属正常，滚动 effect 会跳过。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftFocusVersion,
  );
  // 空正文不再持久化；分组行订阅现有内存草稿，不能靠 localStorage 或手动重绘维持归属。
  // [契约] currentDraftGroupId 是内存中的草稿归属，空正文不再写 localStorage。
  // 分组行订阅它，不能改用 localStorage 或手动重绘维持归属。
  // [边界] 该值只在本会话有效，跨窗口不共享。
  const currentDraftGroupId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftTaskGroupId,
  );
  // 查看会话时仅显示尚未提交的文字草稿；首发已移除保存记录，不能复活旧的内存 placement。
  // [事务] 有活动任务时读持久草稿，否则读内存归属：两条路径不能同时生效。
  // 持久草稿只在查看会话时展示，且仅当正文尚未提交。
  // [契约] 首发已移除保存记录，不能在这里复活旧 placement。
  // [边界] undefined 与 null 语义不同：前者表示不确定，后者表示无草稿分组。
  const draftGroupId = activeTaskId
    ? readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, draftScope)
        ?.taskGroupId
    : currentDraftGroupId;
  // [契约] 初始值来自持久化读取，只执行一次，后续由 effect 写回。
  // 不要把它提升到 store：折叠是纯 UI 交互态，不属于业务状态。
  // [边界] 读取函数必须容错，坏数据应返回空集合而不是抛错。
  const [collapsed, setCollapsed] = useState(readGroupedTaskCollapsedGroupIds);
  const changeCollapsed = useCallback<Dispatch<SetStateAction<Set<string>>>>((update) => {
    setCollapsed((current) => (typeof update === "function" ? update(current) : update));
  }, []);
  useEffect(() => {
    // [事务] 持久化只发生在折叠集合变化之后，不在 set 回调里写。
    // effect 依赖必须是集合本身，不能依赖其长度或序列化结果。
    // [边界] 写入失败由持久化层吞掉，组件不感知。
    persistGroupedTaskCollapsedGroupIds(collapsed);
  }, [collapsed]);
  // [契约] 该状态只表示正在命名的新分组，不表示选中状态。
  // 结束命名由 onNewGroupSetupStarted 回调清空，不依赖失焦事件。
  // [边界] 组件卸载即丢弃，不需要持久化。
  const [newGroupSetupId, setNewGroupSetupId] = useState<string | null>(null);
  // [契约] 重命名对象是任务快照，不是 id：弹窗需要展示原文与 workspace 信息。
  // [边界] 快照过期不影响提交，提交仍按 taskId 走服务端。
  const [renamingTask, setRenamingTask] = useState<ProjectTask | null>(null);
  // [契约] renameDraft 只活在弹窗生命周期内，关闭弹窗即重置为空串。
  // [边界] 提交时才 trim，编辑过程中保留用户原文。
  const [renameDraft, setRenameDraft] = useState("");
  // [资源] ref 只用于聚焦与全选，不承载状态。
  // [边界] 弹窗未挂载时为 null，调用点必须可选链。
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renamingTask) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTask]);
  // [契约] 用 useShallow 只订阅三个映射，避免任意远端会话变化都触发重渲染。
  // 这三个映射共同构成解析远端 sessionId 的输入，缺一会解析失败。
  // [边界] 这里不写入远端会话状态，只读。
  const remoteState = useRemoteWorkspaceSessionStore(
    useShallow((state) => ({
      sessionsById: state.sessionsById,
      sessionIdByWorkspaceIdentity: state.sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath: state.sessionIdByWorkspacePath,
    })),
  );
  // [契约] 只解析既有 attachment，不在选择时新建远端会话。
  // 传入完整 identity，阻止同路径的另一远端串线。
  // [失败路径] 解析失败返回 undefined，而不是回落到 path 匹配。
  const getTaskRemoteSessionId = useCallback(
    (task: ProjectTask) => {
      // 只解析既有 attachment；完整 identity 阻止同路径的另一远端串线。
      return (
        resolveRemoteWorkspaceSessionIdForTarget({
          ...task,
          state: remoteState,
        }) ?? undefined
      );
    },
    [remoteState],
  );
  // [契约] 权威视图只由 tasks 与 organization.structure 推导。
  // 它不包含拖动中的临时位置：拖动投影在 drag.view，两者不可互换。
  // 依赖必须是结构引用，不能用序列化字符串，否则每次渲染都会重算。
  // [边界] 本组件不修改该视图，所有变更都回到服务端。
  const authoritativeView = useMemo(
    () => buildGroupedTaskView(tasks, organization.structure),
    [tasks, organization.structure],
  );
  // [失败路径] 原始错误进 logger，用户只看到可操作提示，两者缺一不可。
  // 默认文案是分组更新失败；具体动作可传更精确的 messageId。
  // [边界] 该函数不返回布尔，调用方不据此分支。
  const report = (error: unknown, messageId = "taskGroup.updateFailed") => {
    logger.error("[task-groups] 分组操作失败", error);
    toast(intl.formatMessage({ id: messageId }));
  };
  // [失败路径] 用 void 吞掉 promise，避免未处理 rejection 冒到全局。
  // 错误统一交给 report，调用点不再重复 catch。
  // [边界] 该包装不重试：重试策略属于服务层。
  const action = (work: () => Promise<unknown>, messageId?: string) => {
    void work().catch((error) => report(error, messageId));
  };
  // [事务] 提交前不动本地投影：拖动层已负责临时展示，等 organization.move 返回再刷新。
  // 成功后不在这里 refresh：organization.move 会更新权威结构。
  // 失败时必须 refresh，用服务端结果覆盖本地错误投影。
  // [失败路径] refresh 自身失败不再上抛，避免掩盖原始移动错误。
  // [边界] command 由 groupedMoveCommand 生成，这里不做二次组装。
  const move = async (command: MoveGroupNode) => {
    try {
      await organization.move(command);
    } catch (error) {
      report(error);
      await organization.refresh();
    }
  };
  // [契约] 拖动层接收权威视图与折叠集合，输出投影视图与事件处理器。
  // onMove 必须复用上面的 move，不能另写一条提交路径。
  // onCollapsedGroupIdsChange 必须复用 changeCollapsed，保证持久化一致。
  // [边界] drag.view 只用于渲染与命令定位，不写回 authoritativeView。
  // [并发] 拖动期间不发起 refresh，避免投影被中途覆盖。
  const drag = useGroupedDrag({
    authoritativeView,
    collapsedGroupIds: collapsed,
    onCollapsedGroupIdsChange: changeCollapsed,
    onMove: move,
  });
  // [契约] 只从投影视图提取顶层分组，顺序即渲染顺序。
  // 不要从 organization 直接取分组：拖动期间会与投影不一致。
  // [边界] 该列表用于全展开/全收起，不参与单组渲染。
  const groups = useMemo(
    () => drag.view.nodes.flatMap((node) => (node.type === "group" ? [node.group] : [])),
    [drag.view.nodes],
  );
  // [契约] 空分组列表时 every 为 true，按钮展示收起语义但不产生副作用。
  // [边界] 该值只读，不写回折叠状态。
  const allExpanded = groups.every((group) => !collapsed.has(group.id));
  // [事务] 每次基于 current 复制新 Set，保证引用变化触发重渲染。
  // 先判 has 再决定 add 或 delete，不能依赖顺序调用。
  // [契约] 该函数可被 sticky header 与分组行同时调用，必须无副作用。
  // [边界] 它不负责持久化，写回由 effect 统一完成。
  const toggleCollapsed = (id: string) =>
    changeCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // [契约] 自动化默认分组走独立回调，不创建普通任务。
  // 普通分组新建前先展开目标分组，否则新任务不可见。
  // 展开使用不可变更新，且只删除不添加。
  // [边界] groupId 为 null 表示顶层草稿行，直接交给 onCreate。
  // [契约] 该函数不做异步提交，任务创建归上层。
  const createTask = (groupId: string | null) => {
    if (groupId === OFF_PEAK_DEFAULT_GROUP_ID) {
      onOpenAutomations?.();
      return;
    }
    if (groupId)
      changeCollapsed((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
    onCreate(groupId);
  };
  // [事务] 先清持久草稿，再清内存归属：顺序反过来会让内存先空、持久值仍在。
  // 两处必须都传同一 scope，否则会清到别的 workspace 的草稿。
  // [边界] 该函数不刷新列表，草稿行由订阅自动消失。
  const closeDraft = () => {
    clearV4ComposerDraftTaskGroup(workspacePath, workspaceIdentity, draftScope);
    useZCodeSessionStore.getState().clearDraftTaskGroup(workspacePath, workspaceIdentity);
  };
  useEffect(() => {
    if (draftGroupId !== null || !drag.root.current) return;
    const root = drag.root.current;
    const frame = requestAnimationFrame(() =>
      findNearestScrollableAncestor(root)?.scrollTo({ top: 0 }),
    );
    return () => cancelAnimationFrame(frame);
  }, [draftFocusVersion, draftGroupId, drag.root]);
  // [事务] 先解析远端 sessionId，再提交变更：迟到解析会作用到错误连接。
  // 归档成功后才移除 task state，失败时保留原状态。
  // 无论成功失败都 refresh，让本地回到服务端权威结果。
  // [失败路径] 提交错误直接上抛给 action 的统一 catch，不在内部吞掉。
  // [契约] 返回值透传给调用方，重命名等场景依赖它判断结果。
  const mutate = async (task: ProjectTask, mutation: ProjectTaskMutation) => {
    const result = await mutateProjectTask(
      { service, controller },
      task,
      mutation,
      getTaskRemoteSessionId(task),
    );
    if (mutation.kind === "archive" && mutation.archived)
      useZCodeSessionStore
        .getState()
        .removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
    await refresh();
    return result;
  };
  // [契约] groupId 为 undefined 表示置顶，null 表示移出分组，二者语义不同。
  // 移动计算基于 authoritativeView，不能用 drag.view。
  // [事务] moveTask 先生成 groupedMoveCommand 再提交；命令为空表示无需移动，直接返回。
  const moveTask = (task: ProjectTask, groupId?: string | null) => {
    const next =
      groupId === undefined
        ? moveTaskToTopByMenu(authoritativeView, task)
        : moveTaskByMenu(authoritativeView, task, groupId);
    const command = groupedMoveCommand(authoritativeView, next, {
      type: "task",
      task: groupTaskRef(task),
    });
    if (command) void move(command);
  };
  // [契约] 颜色写回走 organization.save，只提交变更字段。
  // [失败路径] 失败由 action 统一提示，不在此回滚颜色。
  // [边界] 该函数不修改本地分组对象。
  const updateColor = (id: string, color: TaskGroupColor) =>
    action(() => organization.save({ id, color }));
  const ungroup = (id: string) => action(() => organization.ungroup(id));
  // [契约] 会话类型 workspace 显示统一文案，不显示路径尾段。
  // 路径尾段按两种分隔符切分并过滤空段，兼容 Windows 与 POSIX。
  // [边界] 兜底返回完整路径，避免标签为空。
  const getWorkspaceLabel = (task: Pick<ProjectTask, "workspacePath" | "workspacePurpose">) =>
    task.workspacePurpose === "conversation"
      ? intl.formatMessage({ id: "workspaceSidebar.conversationsSection" })
      : task.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || task.workspacePath;
  // [契约] 这是一次渲染内的回调集合，必须随视图与活动任务重建。
  // onSelectTask 先按 taskKey 找回任务，再带出 remoteSessionId 与 unreadAt。
  // 找不到任务时仍允许选择，只是不传远端会话，避免阻断打开。
  // [边界] 归档与关闭复用同一条 mutate 路径，不各自实现。
  // [契约] tooltipsDisabled 绑定拖动状态，拖动中不弹提示。
  const rowCallbacks = {
    groups,
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    activeTaskId,
    mobileActiveTaskKey: presentation.mobileActiveTaskKey,
    onSelectTask: (path: string, id: string, identity?: string) => {
      const task = findTaskInGroupedView(
        authoritativeView,
        taskKey({ workspacePath: path, taskId: id, workspaceIdentity: identity }),
      );
      onSelect(path, id, identity, task ? getTaskRemoteSessionId(task) : undefined, task?.unreadAt);
    },
    onCloseTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onArchiveTask: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "archive", archived: true }), "taskList.archiveFailed"),
    onOpenFileTree: presentation.onOpenTaskFiles
      ? (task: ProjectTask) =>
          action(() => presentation.onOpenTaskFiles!(task, getTaskRemoteSessionId(task)))
      : undefined,
    onMoveTaskToGroup: (task: ProjectTask, id: string | null) => moveTask(task, id),
    onMoveTaskToTop: (task: ProjectTask) => moveTask(task),
    onStartRenameTask: (task: ProjectTask) => {
      setRenamingTask(task);
      setRenameDraft(task.title ?? "");
    },
    onMarkTaskAsUnread: (task: ProjectTask) =>
      action(() => mutate(task, { kind: "mark-unread" }), "taskList.markAsUnreadFailed"),
    tooltipsDisabled: drag.dragging,
  };
  // [并发] 拖动中清空 sticky：投影正在变化，钉住的分组可能已不存在。
  // root 未就绪时清空并返回，不能提前订阅。
  // scroll 容器缺失时同样清空：sticky 依赖它的滚动位置。
  // [资源] 订阅与清理必须成对，卸载后不得再 setState。
  // [契约] sticky 只影响头部展示，不改变分组顺序。
  const [stickyId, setStickyId] = useState<string | null>(null);
  useEffect(() => {
    const root = drag.root.current;
    if (!root || drag.dragging) {
      setStickyId(null);
      return;
    }
    // 展开动画首帧尚无 overflow，不能因此漏订阅后续滚动；当前滚动 owner 由侧栏直接提供。
    const scroll = scrollRef.current;
    if (!scroll) {
      setStickyId(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      setStickyId(resolveStickyGroupedTaskGroupId(root));
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [scrollRef, drag.root, drag.dragging, drag.view.nodes, collapsed, draftGroupId]);
  // [契约] 从投影视图查找 sticky 分组，保证与渲染内容同源。
  // 找不到时为 undefined，header 插槽渲染 null。
  // [边界] 这里不再二次校验折叠状态，展示层自行判断。
  const sticky = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === stickyId,
  );
  const activeTask = drag.activeTaskKey
    ? findTaskInGroupedView(drag.view, drag.activeTaskKey)
    : null;
  const activeGroup = drag.view.nodes.find(
    (node) => node.type === "group" && node.group.id === drag.activeGroupId,
  );
  // [契约] overlayStyle 的宽度由拖动层测量提供，缺失时返回 undefined 交给默认样式。
  // [边界] 这里只生成内联宽度，不控制过渡动画。
  const overlayStyle = drag.width ? { width: `${drag.width}px` } : undefined;
  // [契约] 同一个按钮承担全展开与全收起，文案必须随状态切换。
  // [边界] 文案只影响展示，不参与点击行为判断。
  // [契约] 图标与文案同源，切换时不能只替换图标而留下旧 aria-label。
  const toggleLabel = intl.formatMessage({
    id: allExpanded ? "taskGroup.collapseAll" : "taskGroup.expandAll",
  });
  return (
    <>
      {toolbarTarget &&
        createPortal(
          <>
            <ControlHintTooltip title={toggleLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={toggleLabel}
                data-testid="task-group-toggle-all"
                disabled={!groups.length}
                onClick={() =>
                  changeCollapsed(
                    allExpanded ? new Set(groups.map((group) => group.id)) : new Set(),
                  )
                }
              >
                {allExpanded ? (
                  <Minimize2 className="size-3.5" />
                ) : (
                  <Maximize2 className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
            <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newGroup" })}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                data-testid="task-group-add"
                aria-label={intl.formatMessage({ id: "taskGroup.newGroup" })}
                disabled={!organization.available}
                onClick={() =>
                  action(async () => {
                    const group = await organization.save({
                      title: intl.formatMessage({ id: "taskGroup.defaultTitle" }),
                    });
                    setNewGroupSetupId(group.id);
                  }, "taskGroup.createFailed")
                }
              >
                <Hash className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </>,
          toolbarTarget,
        )}
      {stickyTarget &&
        createPortal(
          <StickyGroupHeaderSlot
            header={
              sticky?.type === "group" ? (
                <StickyGroupHeader
                  node={sticky}
                  collapsed={collapsed.has(sticky.group.id)}
                  tooltipsDisabled={drag.dragging}
                  onCreateTask={() => createTask(sticky.group.id)}
                  onToggleCollapsed={toggleCollapsed}
                  onUpdateGroupColor={updateColor}
                  onUngroupGroup={ungroup}
                />
              ) : null
            }
          />,
          stickyTarget,
        )}
      <TaskRenameDialog
        open={renamingTask !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) setRenamingTask(null);
        }}
        onChange={setRenameDraft}
        onCancel={() => setRenamingTask(null)}
        onConfirm={() =>
          action(async () => {
            if (!renamingTask) return;
            await mutate(renamingTask, { kind: "rename", title: renameDraft.trim() });
            setRenamingTask(null);
          }, "taskList.renameFailed")
        }
      />
      <DndContext {...drag.dnd}>
        <div ref={drag.root} className="px-2 pb-4" data-testid="task-grouped-view">
          {draftGroupId === null && (
            <GroupedDraftTaskRow
              active={!activeTaskId}
              workspaceLabel={getWorkspaceLabel({ workspacePath })}
              onSelect={() => createTask(null)}
              onClose={closeDraft}
            />
          )}
          <VirtualizedGroupedTopLevelList
            nodes={drag.view.nodes}
            isGroupCollapsed={(id) => collapsed.has(id)}
            renderNode={(node) =>
              node.type === "group" ? (
                <div key={node.group.id} data-grouped-layout-key={`group:${node.group.id}`}>
                  <GroupItem
                    {...rowCallbacks}
                    node={node}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getWorkspaceLabel}
                    onCreateTask={() => createTask(node.group.id)}
                    hasDraftTask={draftGroupId === node.group.id}
                    draftTaskActive={!activeTaskId}
                    draftWorkspaceLabel={getWorkspaceLabel({ workspacePath })}
                    onSelectDraftTask={() => createTask(node.group.id)}
                    onCloseDraftTask={closeDraft}
                    onRenameGroup={(id, title) =>
                      action(() => organization.save({ id, title }), "taskGroup.renameFailed")
                    }
                    onUpdateGroupColor={updateColor}
                    onUngroupGroup={ungroup}
                    newGroupSetup={newGroupSetupId === node.group.id}
                    onNewGroupSetupStarted={(id) =>
                      setNewGroupSetupId((current) => (current === id ? null : current))
                    }
                    collapsed={collapsed.has(node.group.id)}
                    onToggleCollapsed={toggleCollapsed}
                    activeDragTaskKey={drag.activeTaskKey}
                    activeDragGroupId={drag.activeGroupId}
                  />
                </div>
              ) : (
                <GroupedTaskItem
                  {...rowCallbacks}
                  key={taskKey(node.task)}
                  task={node.task}
                  remoteSessionId={getTaskRemoteSessionId(node.task)}
                  workspaceLabel={getWorkspaceLabel(node.task)}
                  dragId={taskKey(node.task)}
                  dragging={drag.activeTaskKey === taskKey(node.task)}
                />
              )
            }
          />
          {drag.view.nodes.length === 0 && draftGroupId === undefined && !loading && (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.noTasks" })}
            </div>
          )}
          {organization.error && (
            <p role="alert" className="px-3 text-ui-sm text-destructive">
              {organization.error}
            </p>
          )}
        </div>
        {createPortal(
          <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
            {activeTask ? (
              <div
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
                style={overlayStyle}
              >
                <GroupedTaskItem
                  {...rowCallbacks}
                  task={activeTask}
                  remoteSessionId={getTaskRemoteSessionId(activeTask)}
                  workspaceLabel={getWorkspaceLabel(activeTask)}
                  dragId={drag.activeTaskKey ?? undefined}
                  dragOverlay
                />
              </div>
            ) : activeGroup?.type === "group" ? (
              <GroupDragOverlay
                node={activeGroup}
                style={overlayStyle}
                className="transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none"
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </>
  );
}
