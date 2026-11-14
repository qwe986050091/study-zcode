// INV-01 复用任务列表时每行只传单元素数组：守住位置 行数组计算；改错故障 每次渲染全表重建，任务行闪烁。
// INV-02 置顶标识与真实渲染集合必须分开传：守住位置 任务集合与置顶集合；改错故障 置顶区把非置顶任务也渲染出来。
// INV-03 空数组常量必须模块级复用：守住位置 空常量；改错故障 每次渲染新建数组，击穿记忆化比较。
// INV-04 工作区键优先取身份，其次取路径：守住位置 工作区键计算；改错故障 远程与本地同名目录共用活跃态。
// INV-05 活跃任务只订阅当前工作区切片：守住位置 状态选择器；改错故障 任一工作区变更导致全部行重渲染。
// INV-06 文件入口只在有身份时要求远程会话存在：守住位置 文件回调条件；改错故障 远程任务点开文件树失败。
// INV-07 组织菜单与行内容都按任务记忆化：守住位置 组织菜单计算；改错故障 内联节点让记忆化失效。
// INV-08 排序必须走统一比较器并带上列表种类：守住位置 排序结果；改错故障 时间线与置顶区顺序不一致。
// INV-09 分页上限按种类区分：时间线 20、其余 5：守住位置 分页步长；改错故障 侧栏初次展开过长。
// INV-10 置顶区使用显示全部开关，其余种类用增量上限：守住位置 可见切片；改错故障 置顶区无法收起。
// INV-11 更多按钮文案随开关切换：守住位置 文案标识；改错故障 展开后仍显示「显示更多」。
// INV-12 日期标题只在时间线种类生成：守住位置 标题数组；改错故障 普通列表出现无意义日期头。
// INV-13 日期标题与行共用同一个稳定键：守住位置 片段键；改错故障 跨日期更新时重挂载正在操作的行。
// INV-14 空态只由列表持有者展示一次：守住位置 空列表提前返回；改错故障 每个复用的列表各显示一次空态。
// INV-15 置顶区与时间线空列表返回空，不显示空态：守住位置 返回分支；改错故障 侧栏出现两块空提示。
// INV-16 行变体由列表种类推导，不由调用方覆盖：守住位置 变体传参；改错故障 时间线行样式与布局错位。
// INV-17 文件入口只在置顶区展示：守住位置 文件开关传参；改错故障 普通项目行出现多余文件按钮。
// INV-18 悬浮效果在远控模式下关闭：守住位置 悬浮开关；改错故障 手机远控出现无法生效的悬浮反馈。
//
// 模块职责：把任务数组渲染成项目侧栏的行列表，并处理分页、日期分组与空态归属。
// 状态所有权：分页与展开开关是本地状态；任务数据、活跃任务与操作回调全部来自上游。
// 阅读顺序：先看行组件与记忆化点，再看列表组件的分页、排序与分组，最后看空态与更多按钮。
import { Fragment, memo, useCallback, useContext, useMemo, useState } from "react";
import type { ProjectTask, ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { TaskGroupTaskMenu } from "@/project-sidebar/TaskGroupTaskMenu.js";
import { TaskList } from "@/TaskList.js";
import { Button } from "@/components/ui/button.js";
import { useProjectTaskActions } from "@/project-sidebar/useProjectTaskActions.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { compareProjectTaskRows } from "@/project-sidebar/view.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { timelineDateHeadings } from "@/project-sidebar/timelineDates.js";

// 模块级空数组常量：既能稳定引用，也避免每次渲染新建。
// pinnedTasks 只在任务未置顶时取 EMPTY，避免每行各建一个空数组。
// 显式的 ProjectTask[] 标注让 TS 拒绝向 EMPTY 推入元素，只能读取。
// EMPTY 以只读方式传给 TaskList，改它会被类型检查拦下。
// [权衡] 不用空集合构造器：保持与任务数组同类型，减少一层转换。
const EMPTY: ProjectTask[] = [];
export const ProjectTaskRow = memo(function Row({
  task,
  onSelect,
  refresh,
  variant,
  showFiles,
}: {
  task: ProjectTask;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  variant: "default" | "timeline";
  showFiles: boolean;
}) {
  const presentation = useContext(ProjectTaskListContext);
  const { remoteSessionId, rename, pin, archive, unread } = useProjectTaskActions(task, refresh);
  // 身份存在时优先用身份作为工作区键，路径只作本地兜底。
  // 身份会去除首尾空白，避免空串被当成有效值。
  // 活跃任务订阅只取这一键对应的切片，其它工作区变更不影响本行。
  // 键的计算放在订阅之前，保证选择器依赖稳定。
  const workspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
  const activeId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  // rows 用 useMemo 包住单元素数组，否则每次 render 都给 TaskList 一个新引用。
  // 依赖数组只有 task，task 引用不变时 rows 与 organizationActions 一起命中 memo。
  // rows 同时传给 TaskList 的 tasks 与 pinnedTasks，两处共享引用才能命中浅比较。
  const rows = useMemo(() => [task], [task]);
  const select = useCallback(
    () =>
      onSelect(task.workspacePath, task.taskId, task.workspaceIdentity, undefined, task.unreadAt),
    [onSelect, task],
  );
  const openFiles = useCallback(
    () => presentation.onOpenTaskFiles?.(task, remoteSessionId ?? undefined),
    [presentation.onOpenTaskFiles, task, remoteSessionId],
  );
  // 原因：内联 JSX 每次都会创建新引用，导致 TaskList 的 memo 比较失效。
  const organizationActions = useMemo(() => <TaskGroupTaskMenu task={task} />, [task]);
  // 原因：会话行复用项目详情会在浏览任务时重复弹层；远程身份详情只由项目入口承载。
  return (
    <div>
      <TaskList
        organizationActions={organizationActions}
        workspacePath={task.workspacePath}
        workspaceIdentity={task.workspaceIdentity}
        remoteSessionId={remoteSessionId ?? undefined}
        // pinnedTasks 只负责标识样式；TaskList 的真实渲染集合始终是 tasks。
        tasks={rows}
        pinnedTasks={task.pinned ? rows : EMPTY}
        activeTaskId={activeId}
        isWorkspaceActive={presentation.activeWorkspaceKey === workspaceKey}
        mobileActiveTaskKey={presentation.mobileActiveTaskKey}
        onOpenFileTree={
          presentation.onOpenTaskFiles &&
          showFiles &&
          (!task.workspaceIdentity?.trim() || remoteSessionId)
            ? openFiles
            : undefined
        }
        showCreateButton={false}
        showFooter={false}
        showEmptyState={false}
        // 原因：旧接线只传排序，遗漏 timeline 样式，导致目录信息和空闲灰点消失。
        taskRowVariant={variant}
        hoverEnabled={!presentation.isWebRemoteControl}
        sortBy="updated"
        onSelectTask={select}
        onRenameTask={rename}
        onSetTaskPinned={pin}
        onArchiveTask={archive}
        isArchived={task.archived}
        onSetTaskUnread={unread}
      />
    </div>
  );
});

// 入参包含任务、选择回调、刷新函数与列表种类。
// pageSize 与 taskRowVariant 由 kind 决定，缺省 "project" 走普通项目列表。
// showEmptyState 只透传给 TaskList，是否展示空态由列表持有者决定。
// 组件不持有任务数据，只持有分页与展开开关。
export function ProjectTaskRows({
  tasks,
  onSelect,
  refresh,
  kind = "project",
  showEmptyState = true,
}: {
  showEmptyState?: boolean;
  kind?: "project" | "pinned" | "timeline";
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  // 时间线一次给足 20 条，其余列表从 5 条起。
  // pageSize 是首次展开条数，更多按钮每次把 limit 加一页。
  // kind === "pinned" 时忽略 limit，改用 showAll 一次展开全部。
  // pageSize 只在挂载时算一次并作 useState 初值，之后不随 kind 变化重算。
  const pageSize = kind === "timeline" ? 20 : 5;
  const [limit, setLimit] = useState(pageSize);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => compareProjectTaskRows(a, b, kind)),
    [tasks, kind],
  );
  const visible =
    kind === "pinned" ? (showAll ? ordered : ordered.slice(0, 20)) : ordered.slice(0, limit);
  const hasMore = kind === "pinned" ? ordered.length > 20 : ordered.length > limit;
  // 日期标题只在时间线种类生成，普通列表为空数组。
  // 基准时间取当前时刻，用于把任务归入今天、昨天等分组。
  // 标题与可见行一一对应，索引可直接对齐。
  const headings =
    kind === "timeline"
      ? timelineDateHeadings(
          visible.map((task) => task.updatedAt),
          Date.now(),
          locale,
        )
      : [];
  // 原因：逐行复用 TaskList 后，空数组不再挂载旧空态；列表 owner 统一展示一次。
  // 空列表时置顶区与时间线直接返回空，避免重复空态。
  // 项目列表按开关展示一次空态文案。
  // 该判断必须在使用可见切片之前，防止无谓排序与分组。
  if (!tasks.length)
    return kind === "pinned" || !showEmptyState ? null : (
      <div
        className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
        data-testid="project-no-tasks"
      >
        {intl.formatMessage({ id: "taskList.noTasks" })}
      </div>
    );
  return (
    <div
      className={kind === "pinned" || kind === "timeline" ? "px-2" : undefined}
      data-testid={
        kind === "pinned"
          ? "project-pinned-tasks"
          : kind === "timeline"
            ? "project-timeline-tasks"
            : undefined
      }
    >
      {kind === "pinned" ? (
        // 原因：重构遗漏了原置顶区的外层留白，并把分区标题降成了辅助字号。
        <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
          {intl.formatMessage({ id: "taskList.pinnedSection" })}
        </h3>
      ) : null}
      {visible.map((task, index) => (
        // 日期标题与行共用完整任务 key；跨日期段更新不能重挂载正在操作的任务行。
        <Fragment
          key={JSON.stringify([
            task.hostId,
            task.workspaceIdentity?.trim() || task.workspacePath,
            task.taskId,
          ])}
        >
          {headings[index] ? (
            <h3
              data-timeline-date-heading={headings[index].key}
              className="px-2.5 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: headings[index].id }, headings[index].values)}
            </h3>
          ) : null}
          <ProjectTaskRow
            task={task}
            onSelect={onSelect}
            refresh={refresh}
            variant={kind === "timeline" ? "timeline" : "default"}
            showFiles={kind === "pinned"}
          />
        </Fragment>
      ))}
      {hasMore ? (
        <Button
          data-task-list-show-more="true"
          variant="ghost"
          size="sm"
          // 原因：分页入口误用辅助字号和次级颜色，与任务标题及空态不一致；仅交互时提亮。
          className="ml-8.5 h-auto p-0 text-ui-base text-foreground-subtlest hover:bg-transparent focus-visible:text-foreground"
          onClick={() =>
            kind === "pinned" ? setShowAll((value) => !value) : setLimit((n) => n + pageSize)
          }
        >
          {intl.formatMessage({
            id: kind === "pinned" && showAll ? "taskList.showLess" : "taskList.showMore",
          })}
        </Button>
      ) : null}
    </div>
  );
}
