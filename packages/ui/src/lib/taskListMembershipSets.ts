// INV-01 三个持久分区的行并集构成任务行集合：守住位置 合并入口；改错故障：只取单一分区会让列表漏掉置顶或归档任务。
// INV-02 pinnedIds 合并 id 列表与 pinned 行自身的 taskId：守住位置 pinned 组装；改错故障：辅助 id 失败会把已读到的置顶行误分到时间线。
// INV-03 archivedIds 只来自归档行：守住位置 归档组装；改错故障：从 id 列表取会让归档集合长期为空。
// INV-04 deletedIds 来自删除墓碑：守住位置 墓碑合并；改错故障：忽略墓碑会让已删除任务重新出现在列表。
// INV-05 unreadAt 覆盖活跃、置顶、归档三类行：守住位置 未读收集；改错故障：漏一类会让该类任务的未读红点消失。
// INV-06 终态映射只收 completed 与 error：守住位置 状态过滤；改错故障：把运行中当作终态会让红点在重启后误亮。
// INV-07 标题覆盖只收被标记过且非空的标题：守住位置 标题收集；改错故障：空标题会覆盖会话侧的真实名字。
// INV-08 定时任务身份从三类行里一并收集：守住位置 身份收集；改错故障：只从一类取会让部分任务丢掉定时归属。
// INV-09 任一行分区读取失败即抛错：守住位置 可用性判断；改错故障：把降级空集当权威发布会清空旧缓存。
// INV-10 辅助集合读取失败按空集降级：守住位置 容错包装；改错故障：辅助集合异常会连带整个列表不可用。
// INV-11 抛错时调用方保留旧视图：守住位置 主流程末尾；改错故障：吞掉错误会让列表闪成空。
// INV-12 E2E 暂停发生在读取完成之后、返回之前：守住位置 暂停调用点；改错故障：放在读取前无法制造旧快照晚到的窗口。
// INV-13 已暂停时重复进入只累加计数：守住位置 暂停计数；改错故障：重复建信号会让已有等待永远不释放。
// INV-14 释放后暂停钩子清空，后续调用直通：守住位置 释放函数；改错故障：残留钩子会让生产路径被永久挂起。
// INV-15 缓存键包含版本与 endpoint 签名：守住位置 缓存键构造；改错故障：漏版本会让归属变更后仍读到旧集合。
// INV-16 缓存键再拼服务实例身份：守住位置 键后缀；改错故障：不同服务共享缓存会让测试 mock 与真实代理串数据。
// INV-17 失败不入缓存：守住位置 失败回调；改错故障：缓存失败会让一次短暂异常粘住整个版本。
// INV-18 缓存超过上限时淘汰最旧键：守住位置 容量控制；改错故障：无界缓存会随历史版本无限增长。
//
// 模块职责：从 tasks-index 并行读取持久任务行与 pin、归档、删除、未读等归属集合，并按 endpoint 合并。
// 状态所有权：缓存与 E2E 暂停钩子是模块级单例；其余集合都是单次调用的局部值。
// 阅读顺序：先看归属集合的字段含义，再看单 endpoint 拉取与校验，最后看跨 endpoint 合并与缓存。
// 侧栏持久行与 pin/archive/groups 权威读取。tasks-index.sqlite 提供行集合和
// membership，sessions-index 只在后续投影中补充实时 activity/detail。
// unread 同为组织态（setTaskUnread 写 tasks-index），与 pin/archive 同类，
// 不进冻结的 sessions-index schema；这里平行拉取 unreadAt map，列表构建时 join。
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export interface TaskListMembershipScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type TaskListMembershipService = Pick<
  IZCodeTaskService,
  "listPinnedTaskIds" | "listArchivedTasks" | "listTasks" | "listPinnedTasks"
> &
  Partial<Pick<IZCodeTaskService, "listDeletedTaskIds">>;

// 归属集合的返回形态：任务行并集与五类附属映射
// taskIndexItems 是三个持久分区的并集，供列表左表使用
// [失败路径] 丢弃已读到的任务行会让列表改从会话索引反向枚举
// unreadAt 与终态映射按 taskId 关联，列表构建时再 join
// 标题覆盖是旧数据的用户重命名，只带出而不迁移表
// 映射类字段只增不减，缺失的 taskId 由列表层自行兜底
export interface TaskListMembershipSets {
  /** tasks-index 三个持久分区（active/pinned/archived）的完整 task 行并集。 */
  taskIndexItems: ZCodeTaskMeta[];
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  /** tasks-index 持久删除 tombstone；优先于所有列表 kind。 */
  deletedIds: Set<string>;
  /** taskId → unreadAt（tasks-index 组织态；sessions-index 不携带，join 用）。 */
  unreadAtByTaskId: Map<string, number>;
  /** taskId → terminal status（tasks-index 历史终态；用于冷启动 stored summary 补红点）。 */
  terminalStatusByTaskId: Map<string, Extract<ZCodeTaskMeta["status"], "completed" | "error">>;
  /**
   * taskId → 旧 task-index 手动标题。
   *
   * v4 sessions-index 主列表来自 CLI session store；老数据的用户重命名只在
   * tasks-index.title/titleOverridden 中。这里在既有 membership 读取里顺手带出，不迁移表。
   */
  titleOverrideByTaskId: Map<string, string>;
  /** taskId -> cronAutomationId（tasks-index 持久化身份；sessions-index 冻结 schema 不携带）。 */
  cronAutomationIdByTaskId: Map<string, string>;
}

export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

/**
 * E2E-only：暂停已经读取完成、但尚未返回给 renderer join 的 membership 快照。
 * TSL18 必须确定性制造“旧 running 快照在 Stop 终态之后返回”的窗口；
 * 真实 SQLite 太快，不能用 sleep 碰运气。入口只由受保护的 window.__testActions 暴露。
 */
// E2E 专用：holdTaskListMembershipRefreshResultForE2E 把已读好的快照挂在 await 上
// 已有 activeTaskListMembershipRefreshHold 时抛错，避免两套暂停互相覆盖
// 先 clearTaskListMembershipCache，下一次读取必然走到暂停点
// [失败路径] 真实存储太快，不暂停就无法稳定复现旧快照晚到
// 释放由配套函数负责，挂起本身只等待信号
// 暂停状态对外只暴露只读快照，调用方不能改内部计数
export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold 已经启动");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
  clearTaskListMembershipCache();
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}

async function holdTaskListMembershipRefreshResultForE2E(): Promise<void> {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    enteredCallCount: taskListMembershipRefreshHoldState.enteredCallCount + 1,
  };
  await hold.released;
}

/** M5 ③：remote shard 的归属在各自 endpoint 的 tasks-index，按 endpoint 分片拉取后求并。 */
export interface TaskListMembershipEndpoint {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}

// scopeParams 把 scope 转成服务入参，workspaceIdentity 为空时不展开该键
// [边界] 写成空串而非省略会让服务按 workspaceIdentity = "" 查询
// 不做默认值填充，缺 workspaceIdentity 就不带该字段
// 返回值只含 TaskListMembershipService 认识的 workspacePath 与 workspaceIdentity
// 用条件 spread 展开 workspaceIdentity，为空时对象不含该键
function scopeParams(scope: TaskListMembershipScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

/** 可选辅助集合读取失败时按空集降级。 */
async function listOrEmpty<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch {
    return [];
  }
}

async function listWithAvailability<T>(
  list: () => Promise<T[]>,
): Promise<{ items: T[]; available: boolean }> {
  try {
    return { items: await list(), available: true };
  } catch {
    return { items: [], available: false };
  }
}

function collectUnreadAt(unreadAtByTaskId: Map<string, number>, tasks: ZCodeTaskMeta[]): void {
  for (const task of tasks) {
    if (typeof task.unreadAt === "number") {
      unreadAtByTaskId.set(task.taskId, task.unreadAt);
    }
  }
}

function collectTerminalStatuses(
  terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"],
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "error") {
      terminalStatusByTaskId.set(task.taskId, task.status);
    }
  }
}

function collectTitleOverrides(
  titleOverrideByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.titleOverridden === true && task.title.trim().length > 0) {
      titleOverrideByTaskId.set(task.taskId, task.title);
    }
  }
}

function collectCronAutomationIds(
  cronAutomationIdByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.cronAutomationId) {
      cronAutomationIdByTaskId.set(task.taskId, task.cronAutomationId);
    }
  }
}

function mergeTaskIndexItems(lists: ZCodeTaskMeta[][]): ZCodeTaskMeta[] {
  const itemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const task of lists.flat()) {
    itemByEntityKey.set(buildTaskEntityKey(task), task);
  }
  return [...itemByEntityKey.values()];
}

/** 拉取服务端权威 task 行、pinned/archived id 集与其它持久元数据。 */
// 五项读取并行发出：pin 列表、归档行、活跃行、置顶行、删除墓碑
// 三类任务行读取都带可用性标记，失败时降级为空但记录不可用
// [失败路径] 把降级空集当权威发布，会把旧缓存整组清空
// 任一行分区不可用就抛错，由调用方保留旧视图
// 收集阶段逐项扫过三类行，同一 taskId 后写覆盖前写
// 删除墓碑直接展开，服务未实现时按空集处理
export async function fetchTaskListMembershipSets(params: {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}): Promise<TaskListMembershipSets> {
  const [
    pinnedList,
    archivedListResults,
    activeListResults,
    pinnedMetaListResults,
    deletedIdLists,
  ] = await Promise.all([
    listOrEmpty(() => params.service.listPinnedTaskIds()),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listArchivedTasks(scopeParams(scope))),
      ),
    ),
    // unread 覆盖三类成员：active（listTasks = 非 pinned 非 archived）、pinned、archived。
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listPinnedTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        params.service.listDeletedTaskIds
          ? listOrEmpty(() => params.service.listDeletedTaskIds!(scopeParams(scope)))
          : Promise.resolve([]),
      ),
    ),
  ]);
  await holdTaskListMembershipRefreshResultForE2E();
  // task 行现在是所有侧栏列表的左表。任一分区 RPC 失败都不能
  // 当作“权威空集”发布，否则会把旧缓存整组清空；抛出后由 hook 保留旧视图。
  if (
    activeListResults.some((result) => !result.available) ||
    archivedListResults.some((result) => !result.available) ||
    pinnedMetaListResults.some((result) => !result.available)
  ) {
    throw new Error("tasks-index task 行读取不完整");
  }
  const archivedLists = archivedListResults.map((result) => result.items);
  const activeLists = activeListResults.map((result) => result.items);
  const pinnedMetaLists = pinnedMetaListResults.map((result) => result.items);
  const unreadAtByTaskId = new Map<string, number>();
  const terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"] = new Map();
  const titleOverrideByTaskId = new Map<string, string>();
  const cronAutomationIdByTaskId = new Map<string, string>();
  collectUnreadAt(unreadAtByTaskId, archivedLists.flat());
  collectUnreadAt(unreadAtByTaskId, activeLists.flat());
  collectUnreadAt(unreadAtByTaskId, pinnedMetaLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, archivedLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, activeLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, pinnedMetaLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, archivedLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, activeLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, pinnedMetaLists.flat());
  // V4 侧栏主数据源切到 sessions-index 后，冻结的 SessionSummary 不带
  // cronAutomationId；如果这里不从 tasks-index 一并收集，持久化列虽有值，UI task 仍会丢身份。
  collectCronAutomationIds(cronAutomationIdByTaskId, archivedLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, activeLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, pinnedMetaLists.flat());
  return {
    // 持久 task 行存在性必须由 tasks-index 决定。之前这里只保留 membership
    // 集合并丢弃已经读取到的 task meta，迫使所有列表从 sessions-index 反向枚举行。
    taskIndexItems: mergeTaskIndexItems([
      activeLists.flat(),
      pinnedMetaLists.flat(),
      archivedLists.flat(),
    ]),
    // pinned task 行本身也是 membership 证据；即使辅助 id RPC 短暂失败，
    // 也不应把已经成功读到的 pinned 行误分到 timeline。
    pinnedIds: new Set([...pinnedList, ...pinnedMetaLists.flat().map((task) => task.taskId)]),
    archivedIds: new Set(archivedLists.flat().map((task) => task.taskId)),
    deletedIds: new Set(deletedIdLists.flat()),
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  };
}

// 差量更新修正：membership（pin/archive/unread）只随归属 mutation 变化（membershipVersion bump），
// 与 sessions-index 内容帧（title/status/lastActivity）无关。之前每帧都重拉——一次 title 变更
// 会让所有列表实例各发一轮 1+3×scopes 的 RPC（多 workspace 多实例下每帧上百次调用）。
// 这里按「membershipVersion + endpoints 签名」缓存 in-flight promise，跨 hook 实例共享；
// 版本 bump 或 endpoint 拓扑变化时自然换 key 重拉。缓存有界，避免历史版本堆积。
const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
const MEMBERSHIP_CACHE_MAX_KEYS = 8;
// service 实例身份进 key：不同 endpoint service（含测试 mock、重连后的新 proxy）不得共享缓存。
const membershipServiceIds = new WeakMap<TaskListMembershipService, number>();
let nextMembershipServiceId = 1;

function membershipServiceIdOf(service: TaskListMembershipService): number {
  let id = membershipServiceIds.get(service);
  if (id === undefined) {
    id = nextMembershipServiceId++;
    membershipServiceIds.set(service, id);
  }
  return id;
}

// 缓存键由调用方给的版本签名再拼各服务实例身份组成
// 命中未完成的 promise 就直接复用，跨 hook 实例共享一轮请求
// [失败路径] 失败也缓存会让一次短暂异常粘住整个版本
// 超过上限时淘汰最旧键，避免历史版本无限堆积
// 返回的 promise 由调用方各自等待，缓存只负责去重
// 缓存只保存 promise，不保存结果，避免结果与键脱节
export function fetchTaskListMembershipSetsForEndpointsCached(params: {
  /** 建议形态：`${membershipVersion}::${endpoints 签名}`。 */
  cacheKey: string;
  endpoints: TaskListMembershipEndpoint[];
}): Promise<TaskListMembershipSets> {
  const fullCacheKey = `${params.cacheKey}::svc=${params.endpoints
    .map((endpoint) => membershipServiceIdOf(endpoint.service))
    .join(",")}`;
  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
  if (cached) {
    return cached;
  }
  const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
  membershipPromiseByCacheKey.set(fullCacheKey, promise);
  // 辅助集合可按空集降级，但 task 行分区读取不完整会 reject；不缓存失败，
  // 避免一次短暂 RPC 异常被当前 version 粘住。
  promise.catch(() => membershipPromiseByCacheKey.delete(fullCacheKey));
  while (membershipPromiseByCacheKey.size > MEMBERSHIP_CACHE_MAX_KEYS) {
    const oldestKey = membershipPromiseByCacheKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    membershipPromiseByCacheKey.delete(oldestKey);
  }
  return promise;
}

/** 测试/异常恢复用：清空 membership 缓存。 */
export function clearTaskListMembershipCache(): void {
  membershipPromiseByCacheKey.clear();
}

/** 按 endpoint 并行拉取归属并求并集（taskId 为 sessionId，跨 endpoint 不冲突）。 */
// 先过滤掉没有作用域的 endpoint，再并行拉取各自归属
// [边界] taskId 即会话 id，跨 endpoint 不会冲突，合并可直接求并
// 任务行按 taskId 去重，后者覆盖前者
// 五类附属映射逐项合并，Set 取并 Map 后写覆盖
// 返回合并后的 TaskListMembershipSets
export async function fetchTaskListMembershipSetsForEndpoints(
  endpoints: TaskListMembershipEndpoint[],
): Promise<TaskListMembershipSets> {
  const results = await Promise.all(
    endpoints
      .filter((endpoint) => endpoint.scopes.length > 0)
      .map((endpoint) =>
        fetchTaskListMembershipSets({
          service: endpoint.service,
          scopes: endpoint.scopes,
        }),
      ),
  );
  const merged: TaskListMembershipSets = {
    taskIndexItems: [],
    pinnedIds: new Set<string>(),
    archivedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    unreadAtByTaskId: new Map<string, number>(),
    terminalStatusByTaskId: new Map(),
    titleOverrideByTaskId: new Map<string, string>(),
    cronAutomationIdByTaskId: new Map<string, string>(),
  };
  const taskIndexItemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const result of results) {
    for (const task of result.taskIndexItems) {
      taskIndexItemByEntityKey.set(buildTaskEntityKey(task), task);
    }
    for (const taskId of result.pinnedIds) merged.pinnedIds.add(taskId);
    for (const taskId of result.archivedIds) merged.archivedIds.add(taskId);
    for (const taskId of result.deletedIds) merged.deletedIds.add(taskId);
    for (const [taskId, unreadAt] of result.unreadAtByTaskId) {
      merged.unreadAtByTaskId.set(taskId, unreadAt);
    }
    for (const [taskId, status] of result.terminalStatusByTaskId) {
      merged.terminalStatusByTaskId.set(taskId, status);
    }
    for (const [taskId, title] of result.titleOverrideByTaskId) {
      merged.titleOverrideByTaskId.set(taskId, title);
    }
    for (const [taskId, automationId] of result.cronAutomationIdByTaskId) {
      merged.cronAutomationIdByTaskId.set(taskId, automationId);
    }
  }
  merged.taskIndexItems = [...taskIndexItemByEntityKey.values()];
  return merged;
}
