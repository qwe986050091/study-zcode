// INV-01 身份优先：守住位置 状态键解析；改错故障：同一路径的多个远程窗口读到同一份任务。
// INV-02 桶不混写：守住位置 identity 桶写入；改错故障：远程状态污染路径桶，本地窗口串台。
// INV-03 命中才复制：守住位置 任务条目筛选；改错故障：未命中条目被带入新身份。
// INV-04 无引用共享：守住位置 空结果返回；改错故障：新身份直接持有旧记录引用。
// INV-05 双源收集：守住位置 列表与乐观表遍历；改错故障：仅在乐观表出现的任务无法迁移。
// INV-06 空身份不迁移：守住位置 身份判断；改错故障：无身份时把全部任务搬进新桶。
// INV-07 种子分层：守住位置 展示级与任务级来源；改错故障：任务配置跨身份泄漏。
// INV-08 迁移有界：守住位置 一次性迁移判断；改错故障：每次读取都重复搬迁任务。
// INV-09 空迁移保默认：守住位置 活动任务回退；改错故障：活动任务指向不存在的标识。
// INV-10 读取互斥：守住位置 identity 桶存在判断；改错故障：身份桶与路径桶动态合并，状态串台。
// INV-11 未变即回：守住位置 引用相等判断；改错故障：无意义写回击穿选择器缓存。
// INV-12 草稿回退：守住位置 活动任务空值分支；改错故障：无任务时读取到空运行态。
// INV-13 默认对齐：守住位置 运行态获取；改错故障：缺失任务返回未定义状态。
// INV-14 权限聚合：守住位置 两类待决请求判断；改错故障：人工介入请求被漏判。
// INV-15 乐观优先：守住位置 合并函数；改错故障：列表缓存覆盖乐观更新的展示字段。
// INV-16 去重合并：守住位置 任务标识映射；改错故障：同一任务在列表中出现两次。
// INV-17 已读优先级：守住位置 存储与回退任务顺序；改错故障：旧列表覆盖会话内已读。
// INV-18 纯读取：守住位置 全部选择器；改错故障：读取过程写入 store。
//
// 模块职责：提供工作区状态读写辅助与按任务粒度的只读选择器。
// 状态所有权：状态归会话 store；本模块不持有任何可变数据。
// 阅读顺序：键解析 → 迁移辅助 → 工作区读写 → 任务访问器 → 独立选择器。
/**
 * ZCode Session Store 选择器与内部辅助函数
 *
 * 从 zcodeSessionStore.ts 拆分出来，包含 workspace 状态读取/更新辅助函数，
 * 以及所有按 task 粒度的只读访问器和独立选择器。
 */
import type {
  ZCodeTaskRuntimeStatus,
  ZCodeTaskMeta,
} from "@zcode/shared";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  DEFAULT_TASK_UI_STATE,
  DEFAULT_WORKSPACE_INIT_STATE,
  DEFAULT_TASK_RUNTIME_STATE,
  createDefaultWorkspaceState,
  getDefaultWorkspaceState,
  type ZCodeSessionStoreState,
  type WorkspaceInitState,
  type TaskRuntimeState,
  type WorkspaceZCodeUIState,
} from "./zcodeSessionStoreTypes.js";

// ────────────────────────────────────────────
// Internal helpers（store 本体也需要使用）
// ────────────────────────────────────────────

// 身份优先于路径，二者都为空时仍返回路径。
// resolveWorkspaceStateKey 只 trim 身份，不做大小写或路径分隔符的规范化。
//
export function resolveWorkspaceStateKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

// 只复制命中集合内的任务条目。
// 没有命中时返回空对象，避免共享原引用。
//
function copyTaskRecordEntries<T>(
  record: Record<string, T>,
  taskIds: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([taskId]) => taskIds.has(taskId));
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

// 从列表缓存与乐观表两处收集任务标识。
// collectIdentityTaskIds 用 trim 后的 normalizedIdentity 与两侧 task.workspaceIdentity 判等，空身份不参与。
//
function collectIdentityTaskIds(
  baseState: WorkspaceZCodeUIState,
  workspaceIdentity: string,
): Set<string> {
  const normalizedIdentity = workspaceIdentity.trim();
  const taskIds = new Set<string>();
  for (const task of baseState.taskListCache ?? []) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  for (const task of Object.values(baseState.optimisticTaskListByTaskId)) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  return taskIds;
}

// baseState 为 undefined 时 createIdentityWorkspaceStateSeed 直接返回默认状态，不做迁移。
// 只有 workspaceIdentity 非空才复制任务级状态，无身份时只继承展示级种子。
// 展示级字段整体从 baseState 继承，任务级状态由 copyTaskRecordEntries 按 taskIds 筛选。
// 迁移为空时保持默认活动任务，避免指向不存在的任务。
//
function createIdentityWorkspaceStateSeed(
  baseState: WorkspaceZCodeUIState | undefined,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  if (!baseState) {
    return createDefaultWorkspaceState(getDefaultWorkspaceState().selectedProvider);
  }

  const seededState = createDefaultWorkspaceState(baseState.selectedProvider);
  const migratedTaskIds = workspaceIdentity
    ? collectIdentityTaskIds(baseState, workspaceIdentity)
    : new Set<string>();
  const migratedTaskListCache =
    baseState.taskListCache?.filter((task) => migratedTaskIds.has(task.taskId)) ?? null;
  return {
    ...seededState,
    // identity 首次写入时可以继承 workspace/draft 级展示种子，
    // 但 task 状态只能按已持久化的 workspaceIdentity 做一次性迁移，不能动态合并 path 桶。
    selectedSupplierKey: baseState.selectedSupplierKey,
    isGhostSupplier: baseState.isGhostSupplier,
    supplierMismatchReason: baseState.supplierMismatchReason,
    configOptions: baseState.configOptions,
    configOptionsStatus: baseState.configOptionsStatus,
    slashCommands: baseState.slashCommands,
    ...(migratedTaskIds.size > 0
      ? {
          activeTaskId:
            baseState.activeTaskId && migratedTaskIds.has(baseState.activeTaskId)
              ? baseState.activeTaskId
              : seededState.activeTaskId,
          optimisticTaskListByTaskId: copyTaskRecordEntries(
            baseState.optimisticTaskListByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsStatusByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsStatusByTaskId,
            migratedTaskIds,
          ),
          taskListCache: migratedTaskListCache,
          taskListVersion: baseState.taskListVersion,
          taskRuntimeByTaskId: copyTaskRecordEntries(
            baseState.taskRuntimeByTaskId,
            migratedTaskIds,
          ),
          taskUiByTaskId: copyTaskRecordEntries(baseState.taskUiByTaskId, migratedTaskIds),
          taskUnreadByTaskId: copyTaskRecordEntries(
            baseState.taskUnreadByTaskId,
            migratedTaskIds,
          ),
        }
      : {}),
  };
}

// 路径桶只作本地回退与首次迁移起点。
// 身份桶一旦存在就独占读取，不再合并路径任务。
//
export function getWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  const baseState = state.workspaces[workspacePath] ?? getDefaultWorkspaceState();
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return baseState;
  }

  const identityState = state.workspaces[workspaceKey];
  if (!identityState) {
    return baseState;
  }

  // workspaceIdentity 表示远程/隔离 workspace 身份，path 桶只用于本地 fallback
  // 和 identity 桶首次写入前的一次性迁移起点。identity 桶一旦存在，就不能再动态合并
  // path task maps，否则同一路径的不同 SSH/WSL/Docker 窗口会互相读到 task config、队列和错误态。
  return identityState;
}

// updateWorkspaceState 先 parseWorkspaceStateKey 解析键，再据此决定是否走身份迁移种子。
// 更新未改变引用时原样返回，保住选择器缓存。
//
export function updateWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  updater: (current: WorkspaceZCodeUIState) => WorkspaceZCodeUIState,
  workspaceIdentity?: string,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const current =
    workspaceKey === workspacePath
      ? getWorkspaceState(state, workspacePath, workspaceIdentity)
      : (state.workspaces[workspaceKey] ??
        createIdentityWorkspaceStateSeed(state.workspaces[workspacePath], workspaceIdentity));
  const nextWorkspaceState = updater(current);

  if (nextWorkspaceState === current) {
    // 单 ZCode Agent 迁移后旧 provider 选择都会归一为 glm，很多调用实际不会改变状态。
    // 如果仍把 merged overlay 快照写回 identity bucket，会打破 selector 的引用缓存并触发无意义重渲染。
    return { workspaces: state.workspaces };
  }

  if (workspaceKey === workspacePath) {
    return {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: nextWorkspaceState,
      },
    };
  }

  return {
    workspaces: {
      ...state.workspaces,
      // 远程 workspace 的 workspace 级状态必须只写 identity key。
      // 不能为了兼容未透传 identity 的调用同时写 path key：同一路径的另一个远程窗口会从 path fallback
      // 读到这份状态，造成 slashCommands、模型切换与初始化状态串台。相关调用链已补齐 identity，
      // 这里不再污染 path 桶。
      [workspaceKey]: nextWorkspaceState,
    },
  };
}

// ────────────────────────────────────────────
// Per-task accessor functions
// ────────────────────────────────────────────

export function getTaskRuntimeState(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): TaskRuntimeState {
  return workspaceState.taskRuntimeByTaskId[taskId] ?? DEFAULT_TASK_RUNTIME_STATE;
}

interface WorkspaceDisplayedTaskState {
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

// 无活动任务时读取草稿运行态。
// 有活动任务时读取任务运行态并对齐默认值。
//
export function getWorkspaceDisplayedTaskState(
  workspaceState: WorkspaceZCodeUIState,
): WorkspaceDisplayedTaskState {
  if (!workspaceState.activeTaskId) {
    return {
      taskStatus: workspaceState.draftRuntime.status,
      taskError: workspaceState.draftRuntime.error,
    };
  }

  const runtimeState = getTaskRuntimeState(workspaceState, workspaceState.activeTaskId);
  return {
    taskStatus: runtimeState.status,
    taskError: runtimeState.error,
  };
}

export function getTaskUiState(workspaceState: WorkspaceZCodeUIState, taskId: string) {
  return workspaceState.taskUiByTaskId[taskId] ?? DEFAULT_TASK_UI_STATE;
}

export function hasTaskPendingPermissionRequest(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): boolean {
  const taskUiState = getTaskUiState(workspaceState, taskId);
  return taskUiState.permissionRequest != null ||
    (taskUiState.pendingPermissionRequests?.length ?? 0) > 0;
}

export function hasTaskPendingHumanInterventionRequest(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): boolean {
  const taskUiState = getTaskUiState(workspaceState, taskId);
  return hasTaskPendingPermissionRequest(workspaceState, taskId) ||
    taskUiState.elicitationRequest != null ||
    (taskUiState.pendingElicitationRequests?.length ?? 0) > 0;
}



export function getTaskMeta(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
  taskId: string,
): ZCodeTaskMeta | null {
  const optimisticTask = workspaceState.optimisticTaskListByTaskId?.[taskId];
  const cachedTask = workspaceState.taskListCache?.find((task) => task.taskId === taskId) ?? null;

  if (!optimisticTask) {
    return cachedTask;
  }

  if (!cachedTask) {
    return optimisticTask;
  }

  return mergeTaskWithOptimisticMeta(cachedTask, optimisticTask);
}

// 以任务标识为键合并两处来源。
// 乐观条目经合并函数覆盖缓存条目的展示字段。
//
export function getVisibleTaskMetas(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
): ZCodeTaskMeta[] {
  const taskById = new Map<string, ZCodeTaskMeta>();

  for (const task of workspaceState.taskListCache ?? []) {
    taskById.set(task.taskId, task);
  }

  for (const task of Object.values(workspaceState.optimisticTaskListByTaskId ?? {})) {
    taskById.set(task.taskId, getTaskMeta(workspaceState, task.taskId) ?? task);
  }

  return Array.from(taskById.values());
}

// 持久化已读时间优先于会话内标记。
// 仅当存储缺少该任务时才回退调用方提供的任务。
//
export function getTaskUnreadIndicator(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<
        Pick<
          WorkspaceZCodeUIState,
          "optimisticTaskListByTaskId" | "taskListCache" | "taskUnreadByTaskId"
        >
      >,
  taskId: string,
  fallbackTask?: Pick<ZCodeTaskMeta, "unreadAt">,
): boolean {
  const storedTask = getTaskMeta(workspaceState, taskId);
  // IDE 升级或重启后，任务列表会先从 query cache 恢复，而 session store 尚未水合；
  // 此时持久化 unreadAt 只存在于列表 task。仅在 store 缺少该 task 时回退，避免旧列表覆盖 optimistic 已读状态。
  return (
    Boolean((storedTask ?? fallbackTask)?.unreadAt) ||
    workspaceState.taskUnreadByTaskId?.[taskId] === true
  );
}

// ────────────────────────────────────────────
// Standalone selector functions
// ────────────────────────────────────────────

export function selectWorkspaceZCodeState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return getWorkspaceState(state, workspacePath, workspaceIdentity);
}

export function getWorkspaceInitState(
  workspaceState: Pick<WorkspaceZCodeUIState, "workspaceInit">,
): WorkspaceInitState {
  return workspaceState.workspaceInit ?? DEFAULT_WORKSPACE_INIT_STATE;
}
