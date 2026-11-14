// ============================================================================
// zcodeSessionStoreTaskSlice —— task 级状态切片（renderer 侧 Zustand）
//
// 职责边界：
//   只负责把 task 维度的运行态与 UI 态写入 workspace 分桶：runtime status、usage、
//   contextWindow、apiRetry、configOptions、权限/问答请求队列与表单草稿、task error、
//   任务列表 cache 与 optimistic overlay。
//   不负责 task 生命周期编排、协议解析、Host 路由、持久化与网络请求。
//
// 不变量（INV）：
//   INV-01 usage 五个子树等价时必须返回原 state｜setTaskUsage → areTaskUsageStatesEqual｜改错会让流式重复事件唤醒全部订阅者并掉帧
//   INV-02 终态必须清空 activeInputId 与 activeTurnKind｜setTaskRuntimeState → isRunningStatus｜改错会让移动端把已结束任务判成 loading 或压缩中
//   INV-03 写 contextWindow 不得重建 usage 对象｜setTaskContextWindow updater｜改错会把正数 used 覆盖成 0
//   INV-04 权限请求按 requestId 去重｜arePermissionRequestsEquivalent｜改错会造成重复弹窗与 ChatView 重渲染
//   INV-05 权限 pending 队列保持 FIFO｜setTaskPermissionRequest 的追加分支｜改错会让后到请求覆盖前一个，先到的永远无人响应
//   INV-06 移除主权限请求时必须由队列头补位｜removeTaskPermissionRequest 解构分支｜改错会导致确认后下一个请求不顶上
//   INV-07 重复移除权限必须幂等返回 current｜removeTaskPermissionRequest 的 pendingPermissionIndex < 0 分支｜改错会让确认后 CPU 飙高
//   INV-08 问答与权限各自独立的主槽与队列｜setTaskElicitationRequest｜改错会让两类弹窗互相覆盖
//   INV-09 问答置 null 必须清空主槽与队列｜setTaskElicitationRequest 的 request === null 分支｜改错会让旧请求在重置后顶回来
//   INV-10 表单草稿必须按 requestId 存放｜setTaskElicitationFormDraft｜改错会让切换 task 后丢失分题进度
//   INV-11 删除草稿前必须判断 key 存在｜removeTaskElicitationFormDraft｜改错会让重复删除也触发无意义重渲染
//   INV-12 configOptions 内容与状态同时等价才跳过写｜setTaskConfigOptions 的联合判断｜改错会让 recovery effect 自激成死循环
//   INV-13 configOptions 与 status 必须同事务写入｜setTaskConfigOptions 的返回对象｜改错会出现内容已更新但状态仍是旧值的撕裂
//   INV-14 workspace 分桶 key 统一走 resolveWorkspaceStateKey｜updateWorkspaceStateForIdentityScopedTaskState｜改错会让同路径的本地与远程会话串桶
//   INV-15 删除 task 必须先清理 composer 持久化草稿｜removeTaskState 首行｜改错会让重启后出现幽灵草稿
//   INV-16 删除当前 task 必须回收 activeTaskId 与 draftRuntime｜shouldCloseDeletedTask 分支｜改错会让主区继续渲染已删除任务
//   INV-17 删除 task 必须同步剔除导航历史｜removeTaskFromHistory 合并返回｜改错会让返回栈指向不存在的任务
//   INV-18 任务列表比较必须形成全序｜sortTasksByUpdatedAt 的三级比较｜改错会让列表项在流式刷新时抖动
//   INV-19 optimistic 合并必须单调 updatedAt｜mergeTaskWithOptimisticMeta 调用点｜改错会让旧快照把新任务压回底部
//   INV-20 后台任务首发只允许一次事务写入｜initializeBackgroundTaskRuntime｜改错会在并发创建时引发订阅风暴
//   INV-21 成本比较必须把 undefined 与 null 归一｜areTaskUsageCostsEqual｜改错会让等价 usage 反复重建对象
//   INV-22 完整错误对象必须按 task 落库｜setTaskError 的 error 字段｜改错会让切页后丢失 traceId 与 code
//   INV-23 apiRetry 只允许改自身字段｜setTaskApiRetryStatus｜改错会覆盖 status/error/provider
//   INV-24 本文件只新增注释，不改变任何运行时行为｜全文件｜违反即破坏注释工程只增不改约束
// ============================================================================
/* oxlint-disable eslint(max-lines) -- 当前文件承接 task 级状态切片，先保持最小改动修复草稿逻辑，后续再统一拆分 */
import {
  normalizeAgentProviderToZCodeAgent,
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeProvider,
  type ZCodeTaskRuntimeStatus,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { removeTaskFromHistory } from "@/lib/taskNavigationHistory.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import type {
  ConfigOptionsStatus,
  ElicitationFormDraft,
  ZCodeSessionStoreState,
  TaskUsageState,
} from "@/store/zcodeSessionStoreTypes.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import { clearPersistedComposerDraft } from "@/lib/chatComposerDraftStorage.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import {
  getTaskRuntimeState,
  getTaskUiState,
  getWorkspaceState,
  resolveWorkspaceStateKey,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

// [契约] 任务列表必须按 updatedAt → createdAt → taskId 形成全序。
// 前两级处理同一毫秒内的并发创建；taskId 兜底保证跨进程序列化后顺序稳定。
// 只比较 updatedAt 会让流式刷新期间列表项互换位置，用户点击目标会跳到相邻任务。
// 该比较器同时服务 taskListCache 与 optimistic 合并，改口径要同步检查两处调用点。
// 排序返回新数组而不原地 sort，避免污染调用方持有的 readonly 输入。
function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

// [契约] 权限选项按 optionId/kind/name 逐项比较，顺序敏感。
// 长度先短路，避免 every 在长度不同的数组上给出误导性的 true。
// 不比较 raw/description 等大字段：它们可能包含整段 diff，纳入比较会放大每次事件成本。
// 若换成 JSON.stringify，对象键顺序变化会让等价请求被当成新请求，造成重复弹窗。
// 缺项时返回 false，宁可多弹一次也不静默吞掉用户确认。
function arePermissionOptionsEqual(
  left: ZCodePermissionRequest["options"],
  right: ZCodePermissionRequest["options"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const otherOption = right[index];
    if (!otherOption) {
      return false;
    }

    return (
      option.optionId === otherOption.optionId &&
      option.kind === otherOption.kind &&
      option.name === otherOption.name
    );
  });
}

// [权衡] 只按可见字段判等，不按对象引用：同一 requestId 常被连续投递成新对象。
// requestId 是协议层身份，必须比较；漏掉它会把两个不同请求误判成同一个。
// [失败路径] 任一展示字段缺失即返回 false，保证确认动作不会丢。
// 该判等是权限弹窗与 ChatView 重渲染的闸门，放宽条件会引入无意义重绘。
// traceId/inputId 同步比较，便于日志把同一次请求的多次投递串起来。
function arePermissionRequestsEquivalent(
  left: ZCodePermissionRequest,
  right: ZCodePermissionRequest,
): boolean {
  if (left === right) {
    return true;
  }

  // 同一 requestId 可能被连续投递成不同对象。raw 只用于展示预览，协议上 requestId 才是权限请求身份；
  // 这里按可见字段去重，避免重复请求把权限弹窗和 ChatView 整体重渲染。
  return (
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.inputId === right.inputId &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    arePermissionOptionsEqual(left.options, right.options)
  );
}

// [契约] undefined 与 null 在成本维度都表示没有成本，先归一再比较。
// 历史快照写 undefined、运行态写 null 的情况很常见，不归一就会误报差异。
// 误报会让 setTaskUsage 失去短路，流式期间每个 token 都重建 usage 对象。
// amount 与 currency 必须同时相等，金额相同但币种不同仍是不同成本。
function areTaskUsageCostsEqual(
  left: TaskUsageState["cost"] | undefined,
  right: TaskUsageState["cost"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.amount === normalizedRight.amount &&
    normalizedLeft.currency === normalizedRight.currency
  );
}

// [契约] 缓存命中率相关字段全部参与比较，任一变化都算新 usage。
// 只比 inputTokens 会漏掉 cacheRead/cacheWrite 变化，界面命中率停在旧值。
// 先做引用相等短路，高频重复事件下省掉十个字段的逐项读取。
// 累计字段与最近一次字段分开比较，避免把会话累计值当成单次值展示。
function areTaskUsageCachesEqual(
  left: TaskUsageState["cache"] | undefined,
  right: TaskUsageState["cache"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.inputTokens === right.inputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.latestHitRate === right.latestHitRate &&
    left.hitRate === right.hitRate &&
    left.hitRateRequestCount === right.hitRateRequestCount &&
    left.totalInputTokens === right.totalInputTokens &&
    left.totalCacheReadTokens === right.totalCacheReadTokens &&
    left.totalCacheWriteTokens === right.totalCacheWriteTokens
  );
}

// [契约] breakdown 是逐来源计费明细，顺序有意义，按下标逐项比较。
// 长度不同直接判不等；不能合并成 map，否则来源顺序变化会被误判等价。
// 漏比该项会让多来源模型的分项图表与总额不同步。
// 元素只比 source/chars，不引入内部缓存，避免比较成本随来源数增长。
function areTaskUsageBreakdownsEqual(
  left: TaskUsageState["breakdown"] | undefined,
  right: TaskUsageState["breakdown"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) => item.source === right[index]?.source && item.chars === right[index]?.chars,
  );
}

// [契约] usage 等价必须覆盖 size/used/cost/cache/breakdown 五个子树。
// 任一层短路失败都会导致重新写 state，触发 React 订阅者重渲染。
// 这是 usage_update 唯一的去重闸门，删掉任一层都等于放弃去重。
// 新增 usage 字段时必须同步加入比较，否则新字段变化不会刷新界面。
function areTaskUsageStatesEqual(
  left: TaskUsageState | null,
  right: TaskUsageState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.size === right.size &&
    left.used === right.used &&
    areTaskUsageCostsEqual(left.cost, right.cost) &&
    areTaskUsageCachesEqual(left.cache, right.cache) &&
    areTaskUsageBreakdownsEqual(left.breakdown, right.breakdown)
  );
}

// [契约] contextWindow 统一归一为非负整数或 null，非法值一律落成 null。
// Number.isFinite 同时挡住 NaN 与 Infinity；小于等于 0 视为未知窗口而不是 0。
// 放行 0 会让 token 进度条以 0 为分母，出现 NaN 百分比。
// Math.floor 抹掉小数，避免浮点窗口值进入快照后比较永不相等。
function normalizeTaskContextWindow(contextWindow: number | null): number | null {
  if (contextWindow === null) {
    return null;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.floor(contextWindow);
}

// [契约] identity key 统一走 resolveWorkspaceStateKey，不在本文件手写拼接。
// key 恰好等于 workspacePath 时复用公共 updateWorkspaceState，保持本地语义一致。
// [权衡] 只有远程 identity 才走独立分桶分支，缺省桶用默认状态兜底。
// 若这里按路径直接取桶，同一路径的本地与远程会话会互相覆盖运行态。
// 返回 Pick 而不是整份 state，由调用方负责与其它字段合并。
function updateWorkspaceStateForIdentityScopedTaskState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  updater: (
    current: ReturnType<typeof getDefaultWorkspaceState>,
  ) => ReturnType<typeof getDefaultWorkspaceState>,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  // [契约] 先算 identity key 再决定写入路径，key 是分桶唯一依据。
  // 本地路径场景下 key 与 workspacePath 相同，必须走公共 updateWorkspaceState。
  // 远程场景可能同一路径对应多个 identity，必须各自独立分桶。
  // 取桶时用 ?? getDefaultWorkspaceState()，避免历史持久化缺桶导致读 undefined。
  // updater 只接收当前桶并返回新桶，不接触整份 store state。
  // 返回 Pick 由调用方合并，保证其它顶层字段不被覆盖。
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return updateWorkspaceState(state, workspacePath, updater);
  }
  const current = state.workspaces[workspaceKey] ?? getDefaultWorkspaceState();
  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: updater(current),
    },
  };
}

// [契约] 切片只暴露 setter，不保存私有可变状态，所有写入经 set 的 updater 完成。
// 每个 action 都带 workspaceIdentity 参数，调用方必须透传，否则远程会话落错桶。
// 返回对象字面量交给主 store 展开合并，切片之间不互相 import。
export function createTaskSlice(set: SetFn) {
  return {
    setTaskRuntimeState: (
      workspacePath: string,
      taskId: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
      provider?: ZCodeProvider,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            // [并发] 运行态按 taskId 读取当前快照，再基于它做不可变合并。
            // 不要在 updater 外缓存 currentTaskRuntime：并发 set 时读到的是上一轮快照。
            // 同一 task 的创建与流式启动可能在同一批次内连续写入，必须每次重读。
            // provider 缺省时保留旧值，避免只更新状态却清掉模型来源。
            const currentTaskRuntime = getTaskRuntimeState(current, taskId);
            // [契约] 只有 creating/restoring/streaming 属于本轮仍在运行。
            // 其余状态（idle/error/done 等）视为终态，由下方统一清空轮次标识。
            // activeTurnKind 决定 app 层是否把发送判为压缩中；终态不清会让后续发送被吞。
            // activeInputOwnerClientId 一并清空，避免移动端按旧 owner 继续路由。
            // 新增运行态时若不加入此判断，终态清理会误删正在使用的 inputId。
            const isRunningStatus =
              status === "creating" || status === "restoring" || status === "streaming";
            // [事务] status/error/provider 与三个轮次字段在同一对象字面量里一次写完。
            // 拆成两次 set 会让订阅者看到已终态但仍带旧 inputId 的中间帧。
            // error 用 ?? null 归一，undefined 与 null 在快照里必须只有一种形态。
            // 展开 currentTaskRuntime 而不是重建，保证未列出的字段原样保留。
            const nextTaskRuntime = {
              ...currentTaskRuntime,
              status,
              error: error ?? null,
              provider: provider ?? currentTaskRuntime.provider,
              // activeInputId 是当前生成轮次的命令路由标识。
              // 终态/非运行态如果继续保留旧 inputId，移动端只靠快照补齐时会把已结束任务误判成仍在 loading。
              // activeTurnKind 同样是 session 运行态；compact 完成后必须清掉，
              // 否则 app 层会继续把同一 task 的发送误判为“压缩中”并吞掉。
              activeTurnKind: isRunningStatus ? currentTaskRuntime.activeTurnKind : undefined,
              activeInputId: isRunningStatus ? currentTaskRuntime.activeInputId : undefined,
              activeInputOwnerClientId: isRunningStatus
                ? currentTaskRuntime.activeInputOwnerClientId
                : undefined,
            };
            return {
              ...current,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [taskId]: nextTaskRuntime,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskUsage: (
      workspacePath: string,
      taskId: string,
      usage: TaskUsageState | null,
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        // [并发] usage_update 在流式期间会以相同数值重复到达。
        // 等价时直接返回 state，避免创建新的 workspace/taskRuntime 对象。
        // 这是掉帧修复的关键短路，删除后 React 会被每条事件唤醒一次。
        // 返回原 state 也让上层 useSyncExternalStore 的引用比较直接命中。
        if (areTaskUsageStatesEqual(currentRuntime.usage, usage)) {
          // usage_update 在流式期间可能以相同数值重复到达。
          // 如果继续创建新的 workspace/taskRuntime 对象，React 会被无意义唤醒并造成掉帧。
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                usage,
              },
            },
          }),
        );
      });
    },

    setTaskContextWindow: (
      workspacePath: string,
      taskId: string,
      contextWindow: number | null,
      workspaceIdentity?: string,
    ) => {
      // `persistTaskState` 写库前先归一，后续比较与存储都使用同一份归一值。
      // 若直接写入原始值，null 与非法数字会以不同形态进入快照，去重失效。
      // 归一函数与 setTaskContextWindow 必须成对出现，不能只在渲染层兜底。
      // 该值同时被 token 进度与移动端快照消费，任何非法值都会放大到 UI。
      const normalizedContextWindow = normalizeTaskContextWindow(contextWindow);
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        // [权衡] 窗口值未变时不写库，usage 的变化由 setTaskUsage 独立负责。
        // 两个 action 各管一个字段，跨字段合并只会制造写放大与职责纠缠。
        // 比较用归一后的值而不是入参，否则 3.7 与 3 会被当成两次不同写入。
        if (currentRuntime.contextWindow === normalizedContextWindow) {
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                // contextWindow 来自模型状态，usage.used 来自运行时 token 统计。
                // 两者流式到达顺序不同，窗口刷新不能重建 usage 对象，否则会把正数 used 覆盖成 0。
                contextWindow: normalizedContextWindow,
              },
            },
          }),
        );
      });
    },

    // [失败路径] apiRetry 覆盖只影响重试提示，不得触碰 status/error/provider。
    // 重试开始与结束都可能以 null 到达，这里保留 null 而不是删除 key。
    // 若把 null 当成无更新跳过，重试成功后旧提示会一直挂在界面上。
    // 该 action 不参与运行态推算，避免重试次数影响任务终态判断。
    setTaskApiRetryStatus: (
      workspacePath: string,
      taskId: string,
      apiRetry: ZCodeApiRetryStatus | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                apiRetry,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskConfigOptions: (
      workspacePath: string,
      taskId: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
      status: ConfigOptionsStatus = "ready",
    ) => {
      // [契约] 入参先浅拷贝，防止调用方后续修改同一数组影响已写入的快照。
      // 元素不深拷贝：configOptions 视为只读，归一化会返回新对象。
      // 拷贝后立即用于比较与写入，两处必须使用同一个引用以免比较失效。
      const normalizedOptions = [...options];
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        // [契约] 读旧值必须带 ?? []，历史 task 可能从未写过配置。
        // status 缺省为 ready，表示有内容且可用，避免工具栏长时间停在 loading。
        // 两个桶按 taskId 平行存放，读写顺序必须始终一致。
        // 缺桶不等于空配置：只有显式写入空数组才代表确实没有可选项。
        const currentOptions = current.taskConfigOptionsByTaskId[taskId] ?? [];
        const currentStatus = current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready";
        if (
          // [事务] 内容与状态同时等价才跳过写入，任一变化都必须落库。
          // 只比内容会让 loading→ready 的状态迁移被吞掉，工具栏永远转圈。
          // 只比状态会让新模型配置被当成重复丢弃，发送时用回旧模型。
          // 等价判断走 areConfigOptionsEquivalent，不按引用比较。
          // 该短路阻止 recovery effect 自激：等价写入不再通知订阅者。
          currentStatus === status &&
          areConfigOptionsEquivalent(currentOptions, normalizedOptions)
        ) {
          // 历史 task 恢复旧模型或无 API key 自动清空模型时，多个恢复路径可能反复提交
          // 内容相同但引用不同的 configOptions。这里直接跳过等价写入，避免 Zustand 通知触发 React effect 循环。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            return {
              ...current,
              taskConfigOptionsByTaskId: {
                ...current.taskConfigOptionsByTaskId,
                [taskId]: normalizedOptions,
              },
              taskConfigOptionsStatusByTaskId: {
                ...current.taskConfigOptionsStatusByTaskId,
                [taskId]: status,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },

    // [契约] 权限请求分当前主槽与 pending 队列两段存储，不允许合并。
    // 合并成单字段时后到请求会直接覆盖前一个，前面的确认永远等不到。
    // 两段都放在 taskUiByTaskId 下，随 task 删除一起回收。
    setTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodePermissionRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            // [失败路径] null 表示清空当前请求与整个队列，用于任务取消或会话重置。
            // 仅当主槽与队列都已为空时返回 current，避免空清空也重渲染。
            // 若只清主槽而留队列，重置后下一次渲染会把旧请求顶回来。
            // 清理在这里一次完成，不拆成两个 action，防止中间帧出现空主槽带队列。
            if (request === null) {
              if (
                taskUiState.permissionRequest === null &&
                taskUiState.pendingPermissionRequests.length === 0
              ) {
                return current;
              }

              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: null,
                    pendingPermissionRequests: [],
                  },
                },
              };
            }

            // [并发] 每次事件都重新读取主请求，不信任上一次渲染捕获的闭包值。
            // 连续到达的权限事件可能在同一个微任务批次内先后写入。
            // 队列同样现读，避免用旧长度做下标判断导致越界。
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            let nextPermissionRequest = currentPermissionRequest;
            let nextPendingPermissionRequests = pendingPermissionRequests;

            // [契约] requestId 相同视为同一请求的更新，只替换内容，不改变队列位置。
            // 内容也等价时返回 current，确认框与预览树不再重绘。
            // 不替换 taskId/traceId 等身份字段，防止伪造请求改写归属。
            if (currentPermissionRequest?.requestId === request.requestId) {
              if (arePermissionRequestsEquivalent(currentPermissionRequest, request)) {
                return current;
              }
              nextPermissionRequest = request;
            // [事务] 主槽为空时新请求直接上位，同时把它从 pending 队列移除。
            // 不移除会让同一请求既在主槽又在队列里，确认一次后还会再弹一次。
            // filter 按 requestId 剔除，重复投递的同一请求不会残留多份。
            } else if (currentPermissionRequest === null) {
              nextPermissionRequest = request;
              nextPendingPermissionRequests = pendingPermissionRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              // [契约] 主槽被占用时请求进入 pending 队列；已在队列则原位替换。
              // 原位替换保证先来先响应，插队会让确认顺序与到达顺序不一致。
              // 找不到旧项时追加到队尾，队列只增不重排。
              // 主槽过期后由 remove 动作按 FIFO 补位，形成完整的串行确认链。
              const existingPendingIndex = pendingPermissionRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                const existingPendingRequest = pendingPermissionRequests[existingPendingIndex];
                if (!existingPendingRequest) {
                  return current;
                }
                if (arePermissionRequestsEquivalent(existingPendingRequest, request)) {
                  return current;
                }
                nextPendingPermissionRequests = pendingPermissionRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                // 同一 task 里可能连续出现多个权限请求。只有一个 permissionRequest 字段时，
                // 后到的请求会直接覆盖前一个，导致前面的 pending 权限永远没人响应，任务表面上像是“卡住”。
                // 这里把后续请求按 task 入队，保证用户确认当前请求后，下一个还能自动顶上来继续处理。
                // [契约] 主槽被占时新权限请求追加到队尾，不插队也不合并。
                // 同一 task 可能连续弹出多个权限请求，单字段会覆盖导致先到的永远无人响应。
                // 追加前已按 requestId 去重，这里只处理真正的新请求。
                // 队尾追加保证用户确认顺序与事件到达顺序一致，便于日志对账。
                nextPendingPermissionRequests = [...pendingPermissionRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  permissionRequest: nextPermissionRequest,
                  pendingPermissionRequests: nextPendingPermissionRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            if (currentPermissionRequest?.requestId === requestId) {
              // [契约] 主槽确认后由 pending 队列头补位，其余队列项顺延。
              // 补位用展开解构而不是 shift，保持不可变并让剩余数组可安全共享。
              // 队列为空时主槽落成 null，界面回到无待确认状态。
              // 不能在补位时自动确认下一个：权限必须由用户逐个点击。
              const [nextPermissionRequest, ...restPendingPermissionRequests] =
                pendingPermissionRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: nextPermissionRequest ?? null,
                    pendingPermissionRequests: restPendingPermissionRequests,
                  },
                },
              };
            }

            const pendingPermissionIndex = pendingPermissionRequests.findIndex(
              (item) => item.requestId === requestId,
            );
            // [资源] 本地乐观清理与 stream 回放会各触发一次删除。
            // 第二次找不到目标时直接返回 current，不重建 taskUiState。
            // 重建会唤醒 ChatView 与权限预览树，确认后 CPU 飙高的根因就在这里。
            // 幂等返回也让上层可以无条件重复调用，不必自己维护已删集合。
            if (pendingPermissionIndex < 0) {
              // 权限响应会走本地乐观清理，也会再收到一次 stream 回放的 permission_response。
              // 第二次清理如果继续重建 taskUiState，会触发 ChatView 和权限预览树无意义重渲染，导致确认后 CPU 飙高。
              return current;
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingPermissionRequests: pendingPermissionRequests.filter(
                    (_item, index) => index !== pendingPermissionIndex,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [契约] elicitation 与 permission 各自独立的主槽与队列，互不覆盖。
    // 共享队列会让问答弹窗盖掉安全检查，或反向吞掉问答。
    // 两类请求都随 task 删除整桶回收，不单独做跨桶清理。
    setTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodeElicitationRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: null,
                    pendingElicitationRequests: [],
                  },
                },
              };
            }

            // [并发] 问答请求按最新快照合并，避免旧闭包覆盖新到达的请求。
            // 主槽为空时同样从 pending 队列移除同 id 项，防止重复入队。
            // 与权限不同，这里不维护 owner 字段，请求本身即身份。
            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            let nextElicitationRequest = currentElicitationRequest;
            let nextPendingElicitationRequests = pendingElicitationRequests;

            // [契约] requestId 相同的 elicitation 视为更新，直接替换主槽内容。
            // 不做字段级去重：表单字段多，逐项比较成本高于一次重绘。
            // 替换时保留队列原顺序，不因内容更新而把请求挪到队尾。
            if (currentElicitationRequest?.requestId === request.requestId) {
              nextElicitationRequest = request;
            } else if (currentElicitationRequest === null) {
              nextElicitationRequest = request;
              nextPendingElicitationRequests = pendingElicitationRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingElicitationRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                nextPendingElicitationRequests = pendingElicitationRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                nextPendingElicitationRequests = [...pendingElicitationRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationRequest: nextElicitationRequest,
                  pendingElicitationRequests: nextPendingElicitationRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [契约] 移除主槽时把队列头补位，移除队列项时按下标剔除。
    // 补位保证前一个问答关闭后，后一个自动进入可交互状态。
    // 队列项不存在时当前实现仍会重建一次状态，若改为幂等需同步检查上游重复回放。
    removeTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            if (currentElicitationRequest?.requestId === requestId) {
              // [契约] 问答主槽移除后同样由队列头补位，语义与权限队列保持一致。
              // 两条队列各自独立补位，不互相等待，避免一类弹窗阻塞另一类。
              // 补位结果写回同一 taskUiState，不使用两次 set 造成中间帧。
              // 队列为空时主槽落 null，表单草稿仍按 requestId 保留以便回看。
              const [nextElicitationRequest, ...restPendingElicitationRequests] =
                pendingElicitationRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: nextElicitationRequest ?? null,
                    pendingElicitationRequests: restPendingElicitationRequests,
                  },
                },
              };
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingElicitationRequests: pendingElicitationRequests.filter(
                    (item) => item.requestId !== requestId,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [资源] 草稿按 requestId 存在 taskUi 下，组件卸载后仍可恢复。
    // 不写入 runtime 或 replayable snapshot，草稿是本地交互态而非会话事实。
    // 每个 request 独立 key，多题表单切题不会互相覆盖。
    setTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      draft: ElicitationFormDraft,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  // 问答进度原本只存在弹窗 useState，切换 task 后组件卸载，
                  // 再挂载只能从原始 request 初始化。按 task/request 提升到 renderer store，
                  // 既能恢复本地草稿，也不会把分题状态误写入 runtime/replayable snapshot。
                  elicitationFormDraftsByRequestId: {
                    ...taskUiState.elicitationFormDraftsByRequestId,
                    [requestId]: draft,
                  },
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            // [契约] 删除前先判断 key 是否存在，不存在直接返回 current。
            // 无条件展开重建会让重复删除也触发订阅者重渲染。
            // 复制后 delete 再写回，保持不可变语义，不直接改原对象。
            if (!(requestId in taskUiState.elicitationFormDraftsByRequestId)) {
              return current;
            }
            const nextDrafts = { ...taskUiState.elicitationFormDraftsByRequestId };
            // [契约] 删除草稿前已复制一份，delete 只作用于副本。
            // 直接 delete 原对象会破坏 Zustand 的不可变假设，订阅者感知不到变化。
            // 删除后写回新对象，即使剩余为空也不复用旧引用。
            delete nextDrafts[requestId];
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationFormDraftsByRequestId: nextDrafts,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [失败路径] 完整错误对象（含 traceId/code）按 task 存，而不是只留纯文本。
    // 组件卸载后错误仍可恢复，切页不会丢失排查信息。
    // 错误清空同样走这里传 null，不另开 action 造成两条写入路径。
    // 与 taskRuntime.error 的纯文本并存：前者供展示，后者供运行态判断。
    setTaskError: (
      workspacePath: string,
      taskId: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskUiByTaskId: {
              ...current.taskUiByTaskId,
              [taskId]: {
                ...getTaskUiState(current, taskId),
                // 完整错误对象之前只放在 ChatView/useZCodeChat 的本地 state。
                // 一旦切换页面或任务，组件卸载后 traceId/code 就会一起丢失，只剩 taskRuntime.error 的纯文本。
                // 这里改成按 task 写进 store，让错误提示能跟 plan/permission 一样跨页面恢复。
                error,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    // [事务] 后台任务首发的 task meta、runtime、selectedProvider 合并为一次写入。
    // 分多轮 set 会在并发创建时触发订阅风暴，列表与运行态短暂不一致。
    // 与 optimisticTaskListByTaskId 合并时必须保留已有 optimistic 字段。
    // identity 优先取参数，缺省才回落到 task 自带值，保证调用方可以覆盖。
    initializeBackgroundTaskRuntime: (
      workspacePath: string,
      params: {
        task: ZCodeTaskMeta;
        provider: ZCodeProvider;
        activeInputId: string;
        workspaceIdentity?: string;
      },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            // [契约] optimistic 条目存在时以合并结果为准，否则直接采用服务端 meta。
            // 合并是单调的：只补字段，不把服务端旧值盖回本地新值。
            // 三元分支必须保留两个来源，删除任一分支都会丢失一方信息。
            const existingTask = current.optimisticTaskListByTaskId[params.task.taskId];
            // [契约] optimistic 条目存在时以合并结果为准，否则直接采用服务端 meta。
            // 合并是单调的：只补字段，不把服务端旧值盖回本地新值。
            // 三元分支必须保留两个来源，删除任一分支都会丢失一方信息。
            const nextTask = existingTask
              ? mergeTaskWithOptimisticMeta(params.task, existingTask)
              : params.task;
            const currentTaskRuntime = getTaskRuntimeState(current, params.task.taskId);
            const cachedTasks = current.taskListCache ?? [];
            // [契约] cache 为 null 表示尚未加载，保持 null；否则插入并重排。
            // 把 null 当空数组写回会让后续加载逻辑误以为已经拉取过。
            // 插入前先剔除同 id 旧项，避免同一任务在缓存里出现两次。
            const nextTaskListCache =
              current.taskListCache === null
                ? current.taskListCache
                : sortTasksByUpdatedAt([
                    nextTask,
                    ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== params.task.taskId),
                  ]);

            return {
              ...current,
              // [契约] 后台任务首发同时绑定 provider，保证工具栏与 runtime 同源。
              // 归一化统一走 normalizeAgentProviderToZCodeAgent，不直接写原始 provider。
              // selectedProvider 属于 workspace 级，不按 taskId 分桶。
              selectedProvider: normalizeAgentProviderToZCodeAgent(params.provider),
              // 性能优化：后台首发不需要先经历 optimistic -> cache -> runtime 多轮 set。
              // 合到一次写入可以削掉并发压测创建任务时的 renderer 订阅风暴。
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                [params.task.taskId]: nextTask,
              },
              taskListCache: nextTaskListCache,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [params.task.taskId]: {
                  ...currentTaskRuntime,
                  status: "streaming",
                  error: null,
                  provider: params.provider,
                  activeInputId: params.activeInputId,
                },
              },
            };
          },
          params.workspaceIdentity ?? params.task.workspaceIdentity,
        ),
      );
    },

    // [并发] desktop-continuous 的 readSession 快照可能旧于本地首次乐观写入。
    // 这里按 mergeTaskWithOptimisticMeta 单调合并，避免旧快照把新任务压回底部。
    // 合并不删除任何本地字段，删除语义只属于 removeOptimisticTaskListItem。
    // identity 同样支持参数覆盖，缺省回落到任务自带值。
    upsertOptimisticTaskListItem: (
      workspacePath: string,
      task: ZCodeTaskMeta,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[task.taskId];
            const nextTask = existingTask ? mergeTaskWithOptimisticMeta(task, existingTask) : task;

            return {
              ...current,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // desktop-continuous 的 readSession 快照可能旧于首发 optimistic Date.now()。
                // 这里按 updatedAt 单调合并，避免旧快照把新 task 压回列表下面。
                [task.taskId]: nextTask,
              },
            };
          },
          workspaceIdentity ?? task.workspaceIdentity,
        ),
      );
    },

    // [契约] 删除只移除 optimistic overlay，不影响 taskListCache 与 runtime 桶。
    // cache 是服务端事实，runtime 由 removeTaskState 统一回收，混在一起会漏清。
    // 解构剩余对象保留其余任务，避免整表替换造成引用抖动。
    // 目标不存在时仍返回新对象：删除是显式意图，调用方不关心是否存在。
    removeOptimisticTaskListItem: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            // [契约] 删除 optimistic 条目用解构剔除，保留其余任务引用。
            // 丢弃的变量名以 _ 开头，明确表示只用于剔除而不是读取。
            // 不修改原 map，返回新对象让订阅者按引用变化重渲染。
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            return {
              ...current,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [资源] 删除 task 必须同步清理 composer 的 localStorage 草稿桶。
    // 只清内存会让重启后已删除任务的草稿重新出现，形成幽灵会话。
    // 清理放在 set 之前，即使 store 写入抛错也不会留下持久化残留。
    // 传 identity 而不是仅路径，远程会话的草稿桶按 identity 隔离。
    removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      // task 删除会清内存 task state，但 composer 草稿还有桌面端 localStorage 桶。
      // 如果不在统一删除 action 里同步清理，重启后已删除 task 的草稿会继续残留。
      clearPersistedComposerDraft(workspacePath, taskId, workspaceIdentity);
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskRuntime, ...restTaskRuntimeByTaskId } =
              current.taskRuntimeByTaskId;
            const { [taskId]: _removedTaskUi, ...restTaskUiByTaskId } = current.taskUiByTaskId;
            const { [taskId]: _removedTaskConfigOptions, ...restTaskConfigOptionsByTaskId } =
              current.taskConfigOptionsByTaskId;
            const {
              [taskId]: _removedTaskConfigOptionsStatus,
              ...restTaskConfigOptionsStatusByTaskId
            } = current.taskConfigOptionsStatusByTaskId;
            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;

            // [事务] 删除的是当前选中任务时，必须同时把 activeTaskId 与 draftRuntime 归位。
            // 只改列表不改选中态，右侧主区会继续按已删除 taskId 渲染详情。
            // 非选中任务保留当前选中态，不能顺手把用户所在任务关掉。
            const shouldCloseDeletedTask = current.activeTaskId === taskId;

            // 删除左侧当前正在查看的任务时，之前只更新了任务列表数据，
            // workspace 里的 activeTaskId 仍指向已删除 task，右侧主区就会继续按旧 taskId 渲染详情。
            // 这里在删除成功后统一回收选中态和运行态，让主区域立即退出这条已删除任务。
            return {
              ...current,
              activeTaskId: shouldCloseDeletedTask ? null : current.activeTaskId,
              draftRuntime: shouldCloseDeletedTask
                ? { status: "idle", error: null }
                : current.draftRuntime,
              taskRuntimeByTaskId: restTaskRuntimeByTaskId,
              taskUiByTaskId: restTaskUiByTaskId,
              taskConfigOptionsByTaskId: restTaskConfigOptionsByTaskId,
              taskConfigOptionsStatusByTaskId: restTaskConfigOptionsStatusByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        );

        return {
          ...workspaceUpdate,
          // [契约] 导航历史同样要剔除该 task，否则返回栈会指向已删除任务。
          // taskNavHistory 是顶层字段，不在 workspace 分桶内，需与 workspaceUpdate 合并返回。
          // 合并时展开 workspaceUpdate 在前，历史覆盖在后，避免两个字段互相遮盖。
          taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
        };
      });
    },
  };
}
