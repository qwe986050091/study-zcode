// INV-01 活动态只覆盖已有行：不新增任务也不改归属，守住位置 活动应用函数；改错故障：控制器快照被当作行集合，侧栏出现不存在的任务。
// INV-02 活动按实体键匹配：主机与任务共同成键，守住位置 键构造；改错故障：只用任务号会让不同主机的同名任务互相染色。
// INV-03 稳定化只在等价时复用旧对象：守住位置 稳定化函数；改错故障：无条件复用会让组织变化不反映到界面。
// INV-04 项目比较包含归属与活动字段：守住位置 等价比较调用；改错故障：只比名称会把旧归属粘在新行上。
// INV-05 项目与任务都稳定化后才可能整体复用旧树：守住位置 返回判断；改错故障：任一维度不同却返回旧树，界面停止更新。
// INV-06 行排序与选择器共用同一比较器：守住位置 比较函数；改错故障：两处口径不同会让选中行跳位。
// INV-07 时间线按更新时间排序，项目区按运行优先：守住位置 分支比较；改错故障：统一口径会让时间线被运行态打断。
// INV-08 相同时间再按主机与实体键倒序兜底：守住位置 次级比较；改错故障：缺少兜底会让顺序依赖引擎实现。
// INV-09 项目行过滤排除归档与置顶：守住位置 行选择器；改错故障：置顶行重复出现在项目区，计数翻倍。
// INV-10 未读判断只看未归档且有未读时间的行：守住位置 未读判定；改错故障：统计归档行会让蓝点数量永远不清零。
// INV-11 未读总数只计已渲染项目：守住位置 渲染项目键集合；改错故障：孤儿任务被计入，出现有角标无蓝点的幽灵提醒。
// INV-12 未读总数按主机、工作区与任务去重：守住位置 去重集合；改错故障：同一任务多行展示会重复计数。
// INV-13 未读数据源必须是权威树：守住位置 函数签名；改错故障：改读渲染缓存会丢失后台工作区的未读。
// INV-14 项目键为主机与项目号的组合：守住位置 键函数；改错故障：只用项目号会让不同主机的同名项目互相覆盖。
// INV-15 条目解析先精确匹配再走遗留前缀回退：守住位置 解析函数；改错故障：跳过精确匹配会让重命名后的项目被误判为遗留项。
// INV-16 遗留回退只在唯一候选时成立：守住位置 候选数量判断；改错故障：多候选任取会让任务挂到错误的项目。
// INV-17 合并只追加不覆盖本机项目：守住位置 合并循环；改错故障：远端同名项目覆盖本机项，丢失本地偏好。
// INV-18 错误文案只翻译已知状态，其余保留原文：守住位置 错误格式化；改错故障：未知错误被吞成通用文案，线上无法定位。
//
// 模块职责：集中项目树与任务列表的纯派生逻辑，含活动附加、稳定化、排序、过滤、未读统计与多源合并。
// 状态所有权：无状态；入参树与目录由调用方持有，返回值要么复用旧引用要么是新对象。
// 阅读顺序：先看活动与稳定化，再看排序与行选择，最后看未读统计与合并。
import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  ProjectAvailability,
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@/project-sidebar/contract.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { compareTaskListItemsByTime, compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@/project-sidebar/contract.js";
import {
  areStabilizedValuesEquivalent,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";

/** 活动态只覆盖已有行的 UI sidecar；Controller 快照不能替代项目树的行集合和事实。 */
// 活动是行的展示侧车，不是行本身：缺行时不生成新行
// [失败路径] 把活动快照当作任务来源会让侧栏出现控制器虚拟行
// byKey 用 buildTaskEntityKey() 建 Map，避免逐行线性查找。
// activity 为空时直接返回 task 原引用，保留记忆化命中。
// 返回新 tree 对象，但未变化的 task 行引用保持稳定。
export function applyProjectTaskActivities(
  tree: ProjectTree,
  activities: readonly {
    address: WindowHostTaskAddress;
    activity: WindowHostControllerTaskActivity;
  }[],
): ProjectTree {
  const byKey = new Map(
    activities.map(({ address, activity }) => [buildTaskEntityKey(address), activity]),
  );
  return {
    ...tree,
    tasks: tree.tasks.map((task) => {
      const activity = byKey.get(buildTaskEntityKey(task));
      return activity ? attachTaskListRowActivity(task, activity) : task;
    }),
  };
}

/** 复用等价对象以保留行 memo；组织变化和 activity 都参加比较，不把旧项目归属粘在行上。 */
// 稳定化目标：内容等价的行复用旧引用，让下游记忆化生效
// [失败路径] 无条件复用会让项目组织变化无法反映到界面
// 先分别稳定化 projects 与 tasks，最后再判断整棵树能否复用。
// areStabilizedValuesEquivalent() 比较内容与组织归属，避免旧归属粘在行上。
// 只有三层等价标志全为真才返回 previous，否则构造新树。
export function stabilizeProjectTree(previous: ProjectTree, next: ProjectTree): ProjectTree {
  const previousProjects = new Map(
    previous.projects.map((project) => [projectKey(project), project]),
  );
  let sameProjects = previous.projects.length === next.projects.length;
  const projects = next.projects.map((project, index) => {
    const old = previousProjects.get(projectKey(project));
    const stable = old && areStabilizedValuesEquivalent(old, project) ? old : project;
    if (previous.projects[index] !== stable) sameProjects = false;
    return stable;
  });
  const tasks = stabilizeTaskListItems(previous.tasks, next.tasks);
  return sameProjects &&
    tasks === previous.tasks &&
    areStabilizedValuesEquivalent(previous.deletedTasks, next.deletedTasks)
    ? previous
    : { ...next, projects: sameProjects ? previous.projects : projects, tasks };
}

export type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "timeline" }
  | { kind: "pinned" };

/** 选择器和行列表共用同一比较器，避免时间线在渲染时又被运行优先覆盖。 */
// 选择器与行列表共用同一比较器，避免两处排序口径分叉
// [失败路径] 时间线若在渲染时被运行优先覆盖，选中行会跳到别处
// 时间线按更新时间，项目区与置顶按运行优先
// 次级比较用主机与实体键倒序，保证同值时顺序稳定
// [权衡] 次级比较走序列化字符串，换取实现简单且可预测
export function compareProjectTaskRows(
  left: ProjectTask,
  right: ProjectTask,
  kind: "project" | "pinned" | "timeline",
): number {
  return (
    (kind === "timeline"
      ? compareTaskListItemsByTime(left, right, "updated")
      : compareZCodeTaskListItems(left, right, "updated")) ||
    JSON.stringify([right.hostId, buildTaskEntityKey(right)]).localeCompare(
      JSON.stringify([left.hostId, buildTaskEntityKey(left)]),
    )
  );
}
/** 只从 Host 已提交的行派生显示；相同 cwd 不代表相同项目。 */
// 行选择只从 tree.tasks 派生，相同 cwd 不代表相同项目。
// pinned 区跨项目；timeline 只排除 archived；项目区再排除 pinned。
// [失败路径] 项目区不排除 pinned 会让同一任务出现两次。
// hostId 存在时才按主机过滤，兼容单主机旧数据。
// 过滤后统一走 compareTaskListItems()，保证渲染顺序与选择一致。
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (selection.kind === "timeline") return !task.archived;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId) &&
        !task.archived &&
        !task.pinned
      );
    })
    .sort((left, right) => compareProjectTaskRows(left, right, selection.kind));
}

export function projectHasUnread(
  tree: ProjectTree,
  project: Pick<VirtualProject, "id" | "hostId">,
): boolean {
  // 置顶只改变显示位置，不改变项目归属；不能只从截断/排除置顶的可见行汇总。
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

/**
 * 任务栏/托盘角标的未读总数：与侧栏蓝点同源（host readTree 的权威树），
 * 过滤条件与 projectHasUnread 一致（非归档 + 有 unreadAt），按 host+workspace+task 去重。
 * 不能改读 renderer 的 taskListCache/taskQueryCache：它们只装载活跃 workspace 的列表，
 * 背景工作区有蓝点时这两份缓存是空的，角标会丢数。
 */
// 角标未读数与侧栏蓝点同源，避免两处数字不一致
// [失败路径] 只统计可见行会漏掉折叠区域的未读
// 只计已渲染项目：孤儿任务与已删项目的未读没有蓝点落点
// 置顶跨项目可见，本地无项目任务按主机归属判定
// 按主机、工作区与任务去重，防止同一任务多行重复计数
export function countProjectTreeUnreadTasks(tree: ProjectTree): number {
  // 只统计侧边栏实际渲染的项目（非软删）：孤儿任务（项目不存在）与已删项目的
  // 未读在界面上没有蓝点落点，计入只会产生「有角标没蓝点」的幽灵提醒。
  const renderedProjectKeys = new Set(
    tree.projects
      .filter((project) => !project.deleted)
      .map((project) => `${project.hostId}::${project.id}`),
  );
  const seen = new Set<string>();
  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) {
      continue;
    }

    // 可见性对齐渲染分区：置顶区跨项目渲染；本地无项目任务区只渲染
    // host=local 的 null-project 任务；其余任务必须归属渲染项目。
    const visible =
      task.pinned ||
      (task.projectId == null && task.hostId === "local") ||
      renderedProjectKeys.has(`${task.hostId}::${task.projectId}`);
    if (!visible) {
      continue;
    }

    seen.add(
      JSON.stringify([
        task.hostId,
        task.workspaceIdentity?.trim() || task.workspacePath,
        task.taskId,
      ]),
    );
  }

  return seen.size;
}

export function projectKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

export function resolveEntryProject(
  entry: RemoteProjectEntry,
  tree: ProjectTree,
): VirtualProject | undefined {
  const exact = tree.projects.find(
    (project) => project.hostId === entry.hostId && project.id === entry.projectId,
  );
  if (exact) return exact;
  const legacyRoot =
    entry.projectId?.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX) && entry.roots.length === 1
      ? entry.roots[0]!.rootPath
      : entry.projectId
        ? undefined
        : entry.legacyWorkspace?.workspacePath;
  const candidates = tree.projects.filter(
    (project) =>
      project.hostId === entry.hostId &&
      !project.deleted &&
      legacyRoot !== undefined &&
      project.roots.some((root) => root.rootPath === legacyRoot),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** 聚合是展示投影，不复制远端事实；离线后只保留本机入口基础缓存。 */
// 合并是展示投影：本机项目优先，远端只补充条目
// [失败路径] 远端同名项目覆盖本机项，会丢失本机顺序与偏好
// 未解析到项目的条目构造占位项，并标记为未归属
// 只有条目所属主机仍在目录中才参与合并
// 任务只保留未归属或所属项目在线的行，其余留给离线缓存
export function mergeProjectTrees(
  local: ProjectTree,
  directory: RemoteProjectDirectory,
  remote: ReadonlyMap<string, ProjectTree>,
): {
  tree: ProjectTree;
  availability: Map<string, ProjectAvailability>;
} {
  const projects = [...local.projects];
  const tasks = [...local.tasks];
  const deletedTasks = [...(local.deletedTasks ?? [])];
  const availability = new Map(
    local.projects.map((project) => [projectKey(project), { online: true } as ProjectAvailability]),
  );
  const retainedHosts = new Set(directory.hosts.map((host) => host.id));
  for (const entry of directory.entries) {
    if (!retainedHosts.has(entry.hostId)) continue;
    const tree = remote.get(entry.hostId);
    const resolved = tree && resolveEntryProject(entry, tree);
    const source: VirtualProject = resolved ?? {
      id: entry.projectId ?? `legacy:${entry.id}`,
      hostId: entry.hostId,
      name: entry.name,
      roots: entry.roots,
      pinned: false,
      deleted: false,
      nameOverridden: false,
      position: projects.length,
      createdAt: 0,
      updatedAt: 0,
    };
    const project =
      entry.initialPosition == null ? source : { ...source, position: entry.initialPosition };
    const key = projectKey(project);
    if (!availability.has(key)) projects.push(project);
    availability.set(key, {
      entryId: entry.id,
      ...(entry.initialPosition == null ? {} : { upgradeEntryId: entry.id }),
      online: Boolean(resolved),
      ...(!resolved && tree ? { unresolved: true } : {}),
    });
  }
  for (const [hostId, tree] of remote) {
    if (!retainedHosts.has(hostId)) continue;
    deletedTasks.push(...(tree.deletedTasks ?? []).filter((task) => task.hostId === hostId));
    for (const task of tree.tasks) {
      if (task.hostId !== hostId) continue;
      if (
        task.projectId == null ||
        availability.get(projectKey({ hostId, id: task.projectId }))?.online
      )
        tasks.push(task);
    }
  }
  return {
    tree: { projects, tasks, ...(deletedTasks.length ? { deletedTasks } : {}) },
    availability,
  };
}

/** Host position 仅作为控制端首次初始化的种子；实际显示顺序由侧栏偏好覆盖。 */
export function selectSortedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => !project.deleted)
    .sort((a, b) => a.position - b.position);
}

export function projectSourceServerId(project: VirtualProject): string | undefined {
  return project.hostId === "local"
    ? undefined
    : parseRemoteWorkspaceIdentity(
        buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0]?.rootPath ?? "/"),
      )?.sourceServerId;
}

/** 内部错误码只用于判断；展示边界翻译已知状态，保留未知服务错误的诊断信息。 */
// 错误格式化只翻译已知状态码，未知原因保留原文
// [失败路径] 未知错误被统一吞成通用文案，线上无法定位
// 已知码覆盖 remote-project.host-removed 与 project.connection-unavailable 两类。
// 非 Error 对象走 String(cause)，避免界面出现空提示。
// formatProjectError() 不读全局文案表，formatMessage 由调用方注入。
export function formatProjectError(
  cause: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const code = cause instanceof Error ? cause.message : String(cause);
  if (code === "remote-project.host-removed") return formatMessage({ id: "project.hostRemoved" });
  if (code === "project.connection-unavailable")
    return formatMessage({ id: "project.connectionUnavailable" });
  return String(cause);
}
