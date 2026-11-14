// ============================================================================
// zcodeSessionStoreWorkspaceSlice —— workspace 级状态与草稿生命周期切片
//
// 职责边界：
//   管理选中任务、草稿态、composer 文本插入/初始化请求、时间线滚动请求、模型切换阶段、
//   configOptions 投影、slashCommands、任务列表缓存与未读投影。
//   不负责 task 级运行态（见 task slice）、Host 路由、协议解析与持久化实现。
//
// 不变量（INV）：
//   INV-01 thought_level 空值必须回落到首个选项｜normalizeThoughtLevelConfigOption｜改错会让工具栏 Select 进入空选中态
//   INV-02 只有 select 类型的 thought_level 才归一｜type 与 category 判断｜改错会篡改其它配置项
//   INV-03 所有 configOptions 写入必须先归一｜normalizeConfigOptions 调用点｜改错会让未归一值进入快照
//   INV-04 配置克隆必须深拷贝 options｜cloneConfigOptions｜改错会让草稿与仓库共享引用
//   INV-05 mode 配置替换必须保持原位置｜replaceModeConfigOption 的 modeIndex｜改错会让模式入口跳到列表末尾
//   INV-06 modeId 为空且无选项时必须移除配置项｜updateCurrentModeConfigOption｜改错会留下空选择框
//   INV-07 无现有 mode 且 modeId 非空时必须创建 fallback｜createFallbackModeOption｜改错会让模式入口消失
//   INV-08 active task 配置缺失时不得新建桶｜updateActiveTaskConfigOptions 的 null 返回｜改错会给未初始化 task 造空配置
//   INV-09 配置未变化时必须返回 null｜nextTaskOptions 比较｜改错会造成写放大与无效重渲染
//   INV-10 切 task 时优先复用缓存配置｜resolveActiveTaskConfigOptionsOnSwitch 的 cachedTaskConfigOptions 分支｜改错会回退到上一条任务的模型
//   INV-11 无缓存时用 task meta 预热并置 loading｜preloadedOptions 分支｜改错会展示旧模型配新上下文
//   INV-12 打开 task 必须清除未读投影｜setActiveTaskId 中 optimistic unreadAt 清空｜改错会让列表把蓝点合并回来
//   INV-13 打开 task 与导航历史必须一次提交｜setActiveTaskId 的合并返回｜改错会出现列表与历史不同步
//   INV-14 composer 初始化只在 taskId 与配置齐备时写入｜composerInitialization 三元｜改错会清掉同 task 的初始化
//   INV-15 draftRuntime 失效版本必须递增｜invalidateDraftRuntime｜改错会让预热快照不被回收
//   INV-16 文本插入必须返回新的 requestId｜requestComposerTextInsert 的 nextRequestId｜改错调用方无法确认消费
//   INV-17 消费请求必须按 requestId 匹配｜clearComposerTextInsertRequest｜改错会误清后到的新请求
//   INV-18 startDraft 必须清空 activeTaskId 与 composer 初始化｜startDraft 返回对象｜改错会让草稿继承旧任务
//   INV-19 换项目必须使预热 runtime 失效｜draftRuntimeInvalidationVersion 的项目差异累加｜改错会复用旧项目目录范围
//   INV-20 草稿必须继承当前 task 的完整配置｜inheritedDraftConfigOptions｜改错会让已选模型回弹成默认
//   INV-21 只有真正切换 provider 才重置 supplier｜shouldResetSupplierForDraftProvider｜改错会出现 custom 选项被锁的撕裂态
//   INV-22 只有从 task 切草稿或 provider 变化才清 slashCommands｜shouldClearSlashCommands｜改错会误清草稿态命令
//   INV-23 模型切换回包必须按 requestId 过滤｜updateModelSwitchStage 与 finishModelSwitch｜改错会让旧回包覆盖新选择
//   INV-24 未读状态必须由 task meta 统一派生｜setTaskUnreadIndicator｜改错会出现两份未读真相源
//   INV-25 本文件只新增注释，不改变任何运行时行为｜全文件｜违反即破坏注释工程只增不改约束
// ============================================================================
import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- workspace 级状态动作集中在同一 slice，先保持收口便于维护。 */
import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type ZCodeConfigOption,
  type ModelSelectionResolution,
  type ZCodeProvider,
  type ZCodeSlashCommand,
  type ZCodeTaskMeta,
  type ZCodeTaskRuntimeStatus,
  type ZCodeWorkspaceInitStatus,
} from "@zcode/shared";
import { persistLastSelectedAgentProvider } from "@/lib/zcodeProviderPreference.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import type {
  ZCodeSessionStoreState,
  ComposerInitialConfig,
  ComposerInitialization,
  ConfigOptionsStatus,
  ComposerMentionPrefill,
  ModelSwitchStage,
  WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStoreTypes.js";
import {
  getTaskMeta,
  getWorkspaceState,
  getWorkspaceInitState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

// [契约] thought_level 的 currentValue 必须命中某个可选项，否则回落到首个选项。
// 归一在 store 写入前完成，避免工具栏消费者各自兜底、行为分叉。
// 只处理 select 类型且 id 或 category 匹配的配置项，其余原样返回。
// 空选项列表时无法回落，保留原值并交由上层决定是否移除。
function normalizeThoughtLevelConfigOption(option: ZCodeConfigOption): ZCodeConfigOption {
  if (
    option.type !== "select" ||
    (option.id !== "thought_level" && option.category !== "thought_level")
  ) {
    return option;
  }
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  // [契约] currentValue 仍命中 option.options 时原样返回 option，保持引用不变，上层按引用判等可直接短路。
  // 引用不变让上层等价判断可以直接短路，避免无意义写库。
  // some 只遍历到首个命中，选项数量通常很小，无需建索引。
  // 若把空字符串也视为命中，会掩盖真正的空选中态。
  if (option.options?.some((entry) => entry.value === currentValue)) {
    return option;
  }
  const fallbackValue = option.options?.[0]?.value;
  // [失败路径] 没有可回落选项时保留原对象，不构造非法选择项。
  // 空字符串 fallback 同样视为不可用，避免生成空 value 的选项。
  // 该分支返回原引用，便于调用方按引用判断是否变化。
  // 选项缺失属于上游数据问题，不在 store 层造默认值。
  if (!fallbackValue) {
    return option;
  }
  // 模型切换竞态里 thought_level 可能短暂为空；store 统一归一，避免工具栏 Select 进入空选中态。
  return { ...option, currentValue: fallbackValue };
}

function normalizeConfigOptions(options: ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map(normalizeThoughtLevelConfigOption);
}

// [契约] 克隆必须覆盖 options 数组及其元素，避免草稿与仓库共享引用。
// 浅拷贝只复制外层数组，修改某一项仍会污染 task 级缓存。
// 克隆只用于草稿继承，不用于持久化，字段结构保持原样。
// 新增嵌套字段时必须同步扩展克隆深度。
function cloneConfigOptions(options: readonly ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options?.map((entry) => ({ ...entry })),
  }));
}

function isModeConfigOption(option: ZCodeConfigOption): boolean {
  return option.category === "mode" && option.type === "select";
}

// [契约] 无现有 mode 配置时创建最小可用项，保证模式入口始终可见。
// 调用方提供选项列表则直接复用，否则用当前 modeId 造单选项。
// id 固定为 mode，避免与其它分类的配置项冲突。
// 该 fallback 只是展示兜底，真实模式仍以服务端 update 为准。
function createFallbackModeOption(params: {
  currentModeId: string;
  options?: NonNullable<ZCodeConfigOption["options"]>;
}): ZCodeConfigOption {
  const options = params.options?.length
    ? params.options
    : [{ value: params.currentModeId, name: params.currentModeId }];
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: params.currentModeId,
    options,
  };
}

// [契约] 替换必须保持 mode 项原有下标，不能追加到末尾。
// 未找到且无新值时返回原引用；未找到但有新值时追加并归一。
// 移除分支用切片拼接，保持其余项顺序不变。
// 所有返回路径都经过 normalizeConfigOptions，保证归一后置。
function replaceModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  nextModeOption: ZCodeConfigOption | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  // [契约] 只按 isModeConfigOption 识别模式项，id 与 category 双条件。
  // 下标是位置语义的唯一来源，后续所有分支都基于它切片。
  // 找不到时返回 -1，由调用方决定追加还是原样返回。
  // 不要在多个位置重复 findIndex，避免选项被并发修改后下标不一致。
  const modeIndex = options.findIndex(isModeConfigOption);
  if (modeIndex === -1) {
    if (!nextModeOption) {
      return currentOptions;
    }
    return normalizeConfigOptions([...options, nextModeOption]);
  }

  if (!nextModeOption) {
    return normalizeConfigOptions([
      ...options.slice(0, modeIndex),
      ...options.slice(modeIndex + 1),
    ]);
  }

  return normalizeConfigOptions([
    ...options.slice(0, modeIndex),
    nextModeOption,
    ...options.slice(modeIndex + 1),
  ]);
}

// [契约] modeId 为 null 表示清除模式，需要区分有无剩余选项。
// 还有其它选项时保留配置项但清空 currentValue，避免整项消失。
// 没有任何选项时整项移除，避免渲染空选择框。
// modeId 非空且无现有项时创建 fallback，保证入口可用。
function updateCurrentModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  modeId: string | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const existingModeOption = options.find(isModeConfigOption);
  // [失败路径] 清除模式时不能直接删除整项，否则用户无法再次选择。
  // 只有选项列表为空才整项移除，其余情况只清 currentValue。
  // 清空后的配置项仍参与等价判断，避免重复写入。
  // 该分支不写 selectedProvider 等其它字段。
  if (!modeId) {
    if (!existingModeOption) {
      return currentOptions;
    }
    if ((existingModeOption.options?.length ?? 0) === 0) {
      return replaceModeConfigOption(currentOptions, null);
    }
    return replaceModeConfigOption(currentOptions, {
      ...existingModeOption,
      currentValue: "",
    });
  }

  if (!existingModeOption) {
    return replaceModeConfigOption(
      currentOptions,
      createFallbackModeOption({ currentModeId: modeId }),
    );
  }

  return replaceModeConfigOption(currentOptions, {
    ...existingModeOption,
    currentValue: modeId,
  });
}

// [契约] 只为已存在配置桶的 active task 打补丁，不做隐式创建。
// 没有 active task 或没有缓存配置时返回 null，由调用方跳过写入。
// updater 返回原引用或空值时同样返回 null，避免写放大。
// 补丁只包含 taskConfigOptionsByTaskId，不触碰 workspace 级配置。
function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  // [契约] nextTaskOptions 与 currentTaskOptions 引用相等、或 updater 返回空值时都不写补丁，直接返回 null。
  // 引用比较是等价判断的一部分，依赖 updater 保持不可变。
  // 空结果用于表达「应该删除但当前无值」等无意义变更。
  // 返回 null 让上层可以一次判断是否合并补丁。
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

// [事务] 切 task 时先取缓存配置，再考虑用 task meta 预热。
// 缓存命中时状态取该 task 自己的 status，缺省 ready。
// 缓存未命中且预热为空时返回 null，表示没有可写内容。
// 预热结果统一归一，避免把未归一的模型配置写进桶。
function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  // [契约] meta 缺失时用 workspace 当前 provider 兜底，但仍尝试预热模型。
  // model/mode/thoughtLevel 直接取 meta，不做跨任务推断。
  // meta 只用于首次预热，运行态 settings 回填会覆盖它。
  // 不要把 meta 当成长期真相源，它可能落后于 runtime。
  const taskMeta = getTaskMeta(current, taskId);
  // 切到历史 task 时，工具栏模型和 context 用量来自不同状态桶。
  // 没有 task 级 settings 缓存时先用 task meta 预热模型，并进入 loading 等待运行态 settings 回填，
  // 避免继续展示上一条任务的模型（例如 glm-0531[1m]）配上当前任务的 contextWindow。
  // [契约] 预热配置必须经过统一归一，尤其是 thought_level 的空值。
  // 空数组表示 meta 没有可用信息，调用方应放弃写入。
  // 预热状态固定为 loading，提示消费者等待运行态回填。
  // 预热只写 task 桶，不修改 workspace 级 configOptions。
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}

// [契约] 切片只通过 set 的 updater 写状态，不持有模块级可变状态。
// 所有 action 保持 workspaceIdentity 参数，调用方必须透传。
// 切片返回对象由主 store 展开合并，不与其它切片互相 import。
// 每个 action 都必须可重入，重复调用不应产生额外写入。
export function createWorkspaceSlice(set: SetFn) {
  return {
    // [事务] 打开任务是一个原子事务：清未读、切 active、写配置一次完成。
    // 导航历史与 workspace 状态在同一次 set 内合并返回。
    // 提交后回调放在 set 外，避免在 updater 内触发副作用。
    // composerConfig 只在显式传入时生效，普通切换不重建初始化。
    setActiveTaskId: (
      workspacePath: string,
      id: string | null,
      workspaceIdentity?: string,
      composerConfig?: ComposerInitialConfig,
    ) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            // [并发] 右键标记未读会同时写 unread map 与 optimistic task 的 unreadAt。
            // 打开任务时必须从 optimistic 投影里也清掉 unreadAt。
            // 只清 unread map 时，列表合并会再次把蓝点写回来。
            // 该投影清理与主状态更新在同一 updater 内完成。
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // 右键标记未读会把 unreadAt 同时写进 optimistic task；
                      // 之前重复打开当前 task 只清旧 unread map，列表合并又从 optimistic task
                      // 把蓝点写回来。打开 task 时必须在同一个 workspace 事务里清掉这份投影。
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            // [契约] 只有存在 active task 时才尝试解析切换配置。
            // 解析结果可能为 null，表示无缓存也无预热，不写配置桶。
            // 该值同时决定是否扩展返回对象，避免无意义字段。
            // 状态与内容成对写入，不允许只写其中之一。
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              composerInitialization:
                id && composerConfig
                  ? { taskId: id, config: composerConfig }
                  : current.activeTaskId === id
                    ? current.composerInitialization
                    : undefined,
            };
            // [事务] 有配置时把内容与状态合并进同一返回对象。
            // status 来自缓存或 loading，不能在此处硬编码 ready。
            // 无配置时直接返回基础切换结果，保持引用最小变化。
            // 两分支都展开 nextState，确保未读清理等字段不丢。
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
      // [契约] 只有在选中了具体任务时才通知导航已提交。
      // 通知放在 set 之后，保证订阅者读取到的是新状态。
      // 切到草稿态（id 为 null）不推送历史，也不发通知。
      // 通知参数带 identity，远程会话按 identity 区分历史。
      if (id) notifyTaskNavigationCommitted({ workspacePath, workspaceIdentity, taskId: id });
    },

    // [资源] 预热会话只存在于当前 pane，递增版本让 owner 回收并重建能力快照。
    // 版本号只增不减，避免通过相等比较误判无需重建。
    // 该 action 不清理 configOptions，草稿预热种子需要保留。
    // 重复调用会多次递增，owner 只需响应最新版本。
    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // 预热会话只存在于 V4 pane 内；递增版本让 owner 回收并重建能力快照。
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [契约] 文本插入用递增 requestId 表达一次性请求，消费方按 id 确认。
    // requestId 在 updater 内生成并写回闭包变量，返回值与状态同源。
    // mention 与 mode 只在显式提供时写入，避免覆盖消费方默认行为。
    // 同一时刻只有一个待消费请求，新请求覆盖旧请求是有意为之。
    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    // [契约] 只有 requestId 匹配时才清空，防止迟到消费清掉新请求。
    // 不匹配时返回原 state，避免无意义通知。
    // 该 action 不校验文本内容，请求身份只看 id。
    // 清空后版本号不回收，保证下一次请求继续递增。
    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    // [契约] 时间线滚动请求与文本插入使用相同的 id 递增值语义。
    // taskId 随请求一起写入，消费方需校验是否仍是当前任务。
    // 新请求覆盖旧请求，避免积压多次滚动意图。
    // 返回值供调用方在异步链路中确认是否被新请求取代。
    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    // [契约] 只有当前初始化对象与传入引用相同才消费。
    // 引用比较保证消费的是同一次初始化，不会误清后续新初始化。
    // 消费后置为 undefined，表示已由输入框接管。
    // 不匹配时返回原 state，调用方可安全重复调用。
    consumeComposerInitialization: (
      workspacePath: string,
      initialization: ComposerInitialization,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerInitialization === initialization
              ? { ...current, composerInitialization: undefined }
              : current,
          workspaceIdentity,
        ),
      );
    },

    // [权衡] 关闭分组只撤销组织意图，不调用 startDraft。
    // startDraft 会重置预热、配置与焦点，语义远大于关闭分组。
    // 已经是 undefined 时返回原 state，避免无效通知。
    // 该 action 不触碰 activeTaskId 与草稿文本。
    clearDraftTaskGroup: (workspacePath: string, workspaceIdentity?: string) => {
      // 关闭分组行只撤销组织意图；调用 startDraft 会重置预热、配置和焦点。
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.draftTaskGroupId === undefined
              ? current
              : { ...current, draftTaskGroupId: undefined },
          workspaceIdentity,
        ),
      );
    },

    // [事务] startDraft 在同一个返回对象里重置 draftProjectId、composerInitialization、draftRuntime 与 draftFocusVersion，不会出现中间帧混合态。
    // provider 只在显式传入时归一化并持久化偏好。
    // 配置继承、supplier 重置与 slashCommands 清理都基于同一次快照判断。
    // 所有字段在同一返回对象里写回，避免中间帧出现混合态。
    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        projectId?: string | null;
        taskGroupId?: string | null;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;
      if (normalizedProvider) {
        // [资源] 只有显式传入 provider 才写偏好，避免普通新建覆盖用户上次选择。
        // 持久化在 set 之前完成，失败不影响本次草稿创建。
        // 写入的是归一化后的 provider，与 store 内保持一致。
        // 该调用有副作用，不能放进 set 的 updater。
        persistLastSelectedAgentProvider(normalizedProvider);
      }

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            // [契约] 只有 provider 与当前值不同才重置 supplier。
            // 新建入口常把当前 provider 原样透传，此时强制重置会造成撕裂态。
            // 该布尔值同时决定是否清 slashCommands 与恢复 native supplier。
            // 比较使用归一化后的值，避免写法差异被当成切换。
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            // [权衡] 从 task 切到草稿、或 provider 真正切换时才清空命令列表。
            // 草稿态重复点击新建不应清空，否则命令列表被清后不会自动回填。
            // 从 task 进入草稿必须清空，避免看到旧任务遗留的命令。
            // 该判断与配置继承互斥使用同一组前置条件。
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            // [契约] 只有从已有 task 进入草稿且 provider 未切换时才继承配置。
            // provider 切换后旧 task 的配置不再适用，必须放弃继承。
            // 继承目标是当前 active task 的配置桶，不是 workspace 级配置。
            // 该布尔值决定后续读取哪个任务的缓存。
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            // [权衡] 优先使用 active task 的缓存配置，缺失时回落到 workspace 投影。
            // protocol-v4 下任务配置可能只完成 workspace 投影，缓存仍是空数组。
            // 回落保证草稿不会在没有种子的情况下被默认模型重建。
            // 两处来源都为空时返回 null，调用方不写配置字段。
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // Bug 原因：protocol-v4 当前任务的配置可能只完成了 workspace 投影，
                  // legacy task 缓存尚未写入或仍是首帧空数组。此时工具条已经显示
                  // current.configOptions，新草稿必须从当前投影继承，不能无种子预热。
                  current.configOptions
              : null;
            // [契约] 继承前必须深拷贝，草稿后续修改不能污染 task 级缓存。
            // 空数组同样视为无继承内容，避免写入无意义空配置。
            // 克隆结果与状态成对使用，不允许只继承内容不继承状态。
            // 该值只用于草稿初始化，不参与持久化。
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            return {
              ...current,
              activeTaskId: null,
              composerInitialization: undefined,
              draftProjectId: options?.projectId,
              draftTaskGroupId: options?.taskGroupId,
              // 同 cwd 可属于多个项目；换项目不能复用前一个项目的预热 runtime 目录范围。
              // [事务] 换项目时递增失效版本，强制重建预热 runtime 的目录范围。
              // 同一 cwd 可属于多个项目，不能仅凭路径判断是否可复用。
              // 递增量为项目是否变化的布尔投影，未变化时保持原版本。
              // draftRuntimeInvalidationVersion 与草稿字段在同一次写回里落库，不会出现新草稿配旧 runtime 的中间态。
              draftRuntimeInvalidationVersion:
                current.draftRuntimeInvalidationVersion +
                Number(current.draftProjectId !== options?.projectId),
              draftCreateSource: options?.createSource ?? "session",
              draftRuntime: { status: "idle", error: null },
              // 从已有 task 点 New Task 时，草稿输入框必须继承当前 task 的完整配置。
              // 否则后续 workspace prepare 会按 Team Plan / 默认模型重建草稿，把已选的其他模型回弹成 GLM。
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N 或任务列表"新建任务"之前只切了 store 状态，没有显式把焦点交还给输入框。
              // Electron 菜单和按钮点击会先拿走焦点，导致用户看到草稿已打开，但光标要过一拍才回来。
              // 这里在每次进入草稿态时递增版本号，让 ChatView 能在状态切换完成后主动 focus 到 Lexical 输入框。
              // [契约] 每次进入草稿态把 draftFocusVersion 加一，ChatView 监听该版本后主动 focus 到 Lexical 输入框。
              // 菜单与按钮点击会先拿走焦点，不递增会让光标延迟一拍回来。
              // 版本号只用于触发 focus，不参与业务判断。
              // 重复点击新建也会递增，属于可接受的幂等副作用。
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // 新建任务态（taskId=null）现在也有自己的未发送草稿。
              // 这里切到草稿态时只重置“本次创建任务的瞬时状态”，不主动清空 null 作用域草稿，
              // 这样用户从 taskA/B/C 切回“新建任务”时，才能继续编辑刚才没发出去的内容。
              // 新建草稿如果继续沿用上一条会话的 slashCommands，输入 `/` 时会看到旧任务遗留的命令。
              // 但以前这里每次“新建任务”都无条件清空，草稿态重复点击会把命令列表清空且不会触发回填。
              // 仅在“从 task 切到 draft”或“provider 真正切换”时清空，避免同草稿态重复点击误伤。
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // 某些“新建任务”入口会把当前 selectedProvider 透传回 startDraft。
                    // 如果 provider 实际没变化却强制重置 supplier，会出现“显示 custom 模型但 custom 选项被锁”的撕裂态。
                    // 这里只在 provider 真正切换时才回到 native，避免同 provider 新建草稿误伤现有 supplier 上下文。
                    // [契约] provider 真正切换时 supplier 必须回到 native。
                    // 只改 provider 而不重置 supplier，会出现显示 custom 模型但选项被锁。
                    // 重置同时清空 ghost 标记与 mismatch 原因，避免残留诊断信息。
                    // 该分支只在 shouldResetSupplierForDraftProvider 为真时展开。
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    // [失败路径] 草稿首发失败时没有 taskId，错误只能挂在 workspace 级。
    // 只留组件内存会让切页后错误消失，用户看不到失败原因。
    // 错误对象原样保存，包含 traceId 与 code。
    // 清空同样走该 action 传 null，不新增第二条写入路径。
    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // 草稿态首发失败时还没有 taskId，错误如果只留在组件内存里，
            // 切到别的页面再回来就看不到了。单独保存一份 workspace 级 draftError，
            // 保证"未建 task 的错误"也能在当前工作区里继续显示。
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [并发] 开启模型切换时写入 requestId，用于过滤过期回包。
    // 普通 setModel 已先乐观更新 UI，只需 requestId 防旧回包。
    // 重路径（custom provider、runtime restart）才把 toolbar 置为 loading。
    // stage 缺省为 settingModel，调用方可显式覆盖。
    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // 普通 session/setModel 已经先乐观更新 UI，只需要 requestId 防止旧回包覆盖新选择。
            // 只有 custom provider、runtime restart 等重路径才需要把 toolbar 置为 loading。
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [并发] 只有 requestId 仍是当前请求时才更新阶段。
    // 旧请求的阶段回包必须静默丢弃，不能把界面拉回旧状态。
    // 不匹配时返回原 state，避免无意义通知。
    // 该 action 不改变 pending 标记，结束由 finishModelSwitch 负责。
    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [并发] 结束时同样校验 requestId，防止旧请求清掉新请求的 pending。
    // 只有匹配时才同时清空 requestId、pending 与 stage。
    // 不匹配时保持当前状态，新请求继续等待自己的完成回调。
    // 该 action 是模型切换状态的唯一收敛点。
    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },

    // [事务] workspace 级配置写入前先归一，再与现有值做等价比较。
    // 等价时返回原 state，避免触发工具栏 effect 自激。
    // 不等价时只替换 configOptions，不清草稿预热种子。
    // 状态字段由 setConfigOptionsStatus 独立维护，两者职责分离。
    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        // [契约] 等价判断按内容而非引用，避免不同引用相同内容被反复写入。
        // 无 API key 或旧模型不可用时，recovery effect 会多次提交同一份配置。
        // 等价短路是该循环的唯一刹车，删除会让 ChatInputToolbar 反复自触发。
        // 判断结果同时用于决定是否进入 updateWorkspaceState。
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // 无 API key / 旧模型不可用时，工具栏 recovery effect 会多次提交同一份空模型配置。
          // 等价配置不应触发 workspace 级 store 通知，否则 ChatInputToolbar 会在 effect 中再次 setConfigOptions。
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft 先保存 active task 的预热种子，随后异步目录水合会走到这里。
            // 目录刷新不是草稿生命周期终点，不能清掉种子，否则 createSession 会回退全局默认模型。
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [事务] 模式更新需要同时落到 workspace 配置与 active task 配置桶。
    // active task 运行态会忽略 workspace_config_options_update。
    // first-send/restore 可能只写入含 model 的 task 配置，模式必须补写。
    // 两处都未变化时返回原 state，避免无意义通知。
    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            // [契约] 只有 workspace 配置与 task 补丁都无变化时才跳过写入。
            // 任一有变化都必须落库，否则模式入口会消失或状态落后。
            // 引用比较依赖两个 updater 保持不可变返回。
            // 跳过时返回 current，保持订阅者引用不变。
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // active task 运行态会忽略 workspace_config_options_update，
              // first-send/restore 又可能先写入只含 model 的 task 配置。
              // mode_update 是 session 事实源，必须同步补到 task 配置桶，否则发送后模式入口会消失。
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [契约] 列表缓存只保存服务端任务事实，不重建未读真相源。
    // 未读的唯一来源是 task meta.unreadAt，缓存刷新不再覆盖 unread map。
    // 直接替换缓存数组，调用方需保证传入的是新数组。
    // 该 action 不调整排序，排序由写入方决定。
    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // unread 的真实来源已经统一收敛到 task meta.unreadAt。
            // 这里不再把列表缓存重建成另一份“未读真相源”，避免 cache 刷新和局部 optimistic 更新互相打架。
            // [权衡] 显式回写未读 map 是为了表明缓存刷新不参与未读计算。
            // 若在此处按缓存重建未读，会与局部 optimistic 更新互相打架。
            // 回写的是同一引用，不会触发额外变化。
            // 删除该字段会让展开对象丢失未读桶。
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    // [事务] 未读设置需要同时更新 unread map 与 optimistic task 的 unreadAt。
    // 两处必须同源，否则列表合并会把状态改回旧值。
    // 设置与清除走同一 action，避免两条写入路径产生分叉。
    // 幂等判断放在最前，重复确认不触发重渲染。
    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            // [契约] 未读时间优先取 optimistic，其次取缓存 meta。
            // optimistic 是新状态的投影，缓存可能落后一个刷新周期。
            // 两者都缺失时只维护 unread map，不构造临时任务对象。
            // 该选择顺序保证本地操作不会被旧快照覆盖。
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            // [契约] 标记未读时复用已有 unreadAt，没有才取当前时间。
            // 已有未读且时间相同直接返回 current，保证幂等。
            // 时间写入 optimistic task，使列表投影与 unread map 同源。
            // 该分支不修改缓存数组，缓存由服务端刷新负责。
            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            // [资源] 权限确认后本地响应与 stream 回放都会清一次未读。
            // 已经是已读且无时间戳时直接返回 current，避免无意义刷新。
            // 该短路保护任务列表与 ChatView，防止确认后整树重渲染。
            // 清除分支会同时删除 unread map 项与 optimistic 的 unreadAt。
            if (!currentHasUnread && currentUnreadAt === undefined) {
              // 权限确认后本地响应和 stream 响应都会清一次未读。
              // 已经是已读时直接复用 workspace state，避免任务列表和 ChatView 被无意义刷新。
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}
