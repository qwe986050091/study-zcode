// INV-01 本文件只声明类型、常量与默认值工厂，所有写入动作留在 zcodeSessionStore 切片内，越界新增 setter 会让状态变更绕开单一入口。
// INV-02 workspaces 以 workspacePath 为键，读取必须经 getWorkspaceState 兜底，直接下标取值会拿到 undefined 并在渲染期抛错。
// INV-03 workspaceInit 收敛为 workspace 单一事实源，不得按 provider 再分桶，否则切换 provider 后 UI 会读到历史 ready 或 failed。
// INV-04 draftRuntime 只描述尚未创建 taskId 的草稿运行态，已建 task 必须读 taskRuntimeByTaskId，混用会让草稿错误覆盖真实 task 状态。
// INV-05 taskRuntimeByTaskId 与 taskUiByTaskId 的生命周期都锚在 taskId 上，删除任务时必须同时回收，否则右侧继续展示已删任务。
// INV-06 TaskUsageState 的 used 只由真实 usage 事件更新，contextWindow 单独存放，让模型状态事件写 used 会让弹窗比例失真。
// INV-07 activeTurnKind 用于区分普通生成与 compact 维护态，改默认值会让维护态被误判成可发送的新一轮。
// INV-08 activeInputId 与 activeInputOwnerClientId 标识输入独占者，[并发] 缺少归属校验时两个 renderer 会同时写同一个 task 的输入。
// INV-09 modelSwitchRequestId 是模型切换的并发票据，只允许最新请求落库，[并发] 省掉比较会让旧请求覆盖新阶段。
// INV-10 modelSwitchStage 的枚举顺序即真实迁移顺序，新增阶段要让 startModelSwitch 与 updateModelSwitchStage 同时理解。
// INV-11 composerTextInsertRequest 与 timelineBottomRequest 靠 requestId 配对，清除时必须校验 id，[失败路径] 误清会让新请求静默丢失。
// INV-12 draftRuntimeInvalidationVersion 只在插件与 Skill 能力变化时自增，[资源] 滥用递增会让 V4 pane 的独占预热会话被反复重建。
// INV-13 taskConfigOptionsByTaskId 与 taskConfigOptionsStatusByTaskId 必须成对推进，只写选项不写状态会让工具栏长期停在 loading。
// INV-14 optimisticTaskListByTaskId 只在新 task 落盘前兜底展示，落盘后必须移除，[权衡] 长期保留会掩盖真实列表的删除结果。
// INV-15 taskUnreadByTaskId 仅是兼容缓存，真实未读以 task meta 的 unreadAt 为准，把这里当权威会让蓝点与列表分叉。
// INV-16 pendingPermissionRequests 与 pendingElicitationRequests 是待回放队列，[失败路径] 覆盖式赋值会丢掉尚未处理的第二个弹窗。
// INV-17 elicitationFormDraftsByRequestId 是 renderer-local 草稿，按 requestId 隔离，请求结束时不同步清理会让草稿串到下一个问答。
// INV-18 getDefaultWorkspaceState 返回稳定引用 DEFAULT_WORKSPACE_STATE，[资源] 改成每次新建对象会让 selector 快照抖动并触发无限重渲染。
//
// 模块职责：集中声明 ZCode Session Store 的类型契约、默认常量与默认 workspace 状态工厂，供 store 本体与 selectors 共享。
// 状态所有权：写入归 zcodeSessionStore 切片；读取方只消费这里声明的字段，持久化交给 Host，renderer 内存态不落盘。
// 阅读顺序：先看 WorkspaceInitState 与 TaskRuntimeState，再看 WorkspaceZCodeUIState，最后看 ZCodeSessionStoreState 的动作签名与默认值工厂。
/* oxlint-disable eslint(max-lines) -- ZCode Agent store 类型和默认状态集中导出，避免切片间重复定义共享结构。 */
/**
 * ZCode Session Store 类型定义、接口、常量与默认值工厂
 *
 * 从 zcodeSessionStore.ts 拆分出来，供 store 本体和 selectors / navigation 等子模块共享。
 */
import {
  buildNativeSupplierKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeApiRetryStatus,
  type ModelSelectionGhostReason,
  type ModelSelectionResolution,
  type ZCodeWorkspaceInitStatus,
  type ZCodeTaskRuntimeStatus,
  type ZCodeProvider,
  type ZCodeTaskMeta,
  type ZCodeContextCacheUsage,
  type ZCodeConfigOption,
  type ZCodeSlashCommand,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeSessionActiveTurnKind,
  type ZCodeContextUsageBreakdownItem,
  type InputId,
  type SessionCreateSource,
} from "@zcode/shared";
import type { SessionConfigState, SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import type {
  AutomationsNavigationTab,
  TaskNavigationHistory,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";

// ────────────────────────────────────────────
// Interfaces
// ────────────────────────────────────────────

// workspace 初始化三态契约：status 取自 ZCodeWorkspaceInitStatus，error 保留最后一次失败原因。
// [失败路径] attempts 由 setWorkspaceInitAttempts 单独推进，重置时不清零会让自动重试永远达不到上限。
// 默认值只能由 DEFAULT_WORKSPACE_INIT_STATE 展开，就地写字面量会漏键并让状态变成 undefined。
export interface WorkspaceInitState {
  status: ZCodeWorkspaceInitStatus;
  error: string | null;
  attempts: number;
}

// 单个 task 的运行态归属：status、error、usage、apiRetry 全部按 taskId 分桶存放。
// provider 记录该 task 运行态绑定的进程 provider，[并发] workspace 级进程重建依赖它做 busy lock。
// contextWindow 与 usage.used 分离，模型状态事件只改前者，覆盖 used 会让成本与比例一起算错。
// backgroundTaskControls 是 host 运行期状态，新增字段时不要顺手写入持久化路径。
export interface TaskRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
  /** 该 task 当前运行态绑定的 ZCode Agent 进程 provider，用于 workspace 级进程重建 busy lock。 */
  provider?: ZCodeProvider;
  /** 当前模型上下文窗口容量；模型状态事件只更新这里，不覆盖真实 usage.used。 */
  contextWindow: number | null;
  usage: TaskUsageState | null;
  apiRetry: ZCodeApiRetryStatus | null;
  /** Agent 明确上报的后台任务控制项；host 运行期状态，不落盘持久化。 */
  backgroundTaskControls: ZCodeBackgroundTaskControlItem[];
  /** 当前 session active turn 的类型；用于区分普通生成和 compact 维护态。 */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  activeInputId?: InputId;
  activeInputOwnerClientId?: string;
}

export interface DraftRuntimeState {
  status: ZCodeTaskRuntimeStatus;
  error: string | null;
}

// 上下文用量展示模型：used 与 size 构成比例，cost 与 cache 只在 Agent 上报时出现。
// breakdown 只服务弹窗比例展示，[权衡] 用它反推 used 会让两个来源长期互相打架。
// 读侧遇到 usage 为 null 必须回落到 DEFAULT_TASK_RUNTIME_STATE，直接解构会让空态崩溃。
export interface TaskUsageState {
  /** 当前上下文窗口已使用的 token 数 */
  used: number;
  /** 当前上下文窗口总 token 容量 */
  size: number;
  /** Agent 上报的累计费用 */
  cost?: { amount: number; currency: string } | null;
  /** Agent/app 协议返回的当前主轮缓存命中信息。 */
  cache?: ZCodeContextCacheUsage;
  /** Agent 按来源估算的上下文字符量，只用于 context usage 弹窗比例展示。 */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}

export interface ElicitationAnswerDraft {
  selectedValues: string[];
  customAnswer: string;
}

export interface ElicitationFormDraft {
  questionIndex: number;
  drafts: Record<string, ElicitationAnswerDraft>;
}

/**
 * store 收尾：TaskUiState 收敛为「远端广播仍需回放的人工介入面」——
 * 权限/问答弹窗 pending 队列、renderer-local 问答草稿 + 错误横幅。plan/goal/token debug 等旧 ChatView
 * 展示态的写入方已随旧协议链路删除，读侧由 v4 conversation 投影承接。
 */
// 人工介入面收敛：只保留权限与问答的 pending 队列、问答草稿和错误横幅。
// pendingPermissionRequests 是远端广播待回放队列，[失败路径] 用单值覆盖会丢掉后到的第二个请求。
// elicitationFormDraftsByRequestId 按 requestId 隔离草稿，移除请求时不同步回收会让草稿串号。
// plan、goal、token debug 等旧展示态已删除，读侧由 v4 conversation 投影承接，不要在这里补回。
export interface TaskUiState {
  permissionRequest: ZCodePermissionRequest | null;
  pendingPermissionRequests: ZCodePermissionRequest[];
  elicitationRequest: ZCodeElicitationRequest | null;
  pendingElicitationRequests: ZCodeElicitationRequest[];
  elicitationFormDraftsByRequestId: Record<string, ElicitationFormDraft>;
  error: ZCodeUiError | null;
}

// 模型切换阶段机：顺序即真实迁移，从 settingModel 到 persistingWorkspace 不可跳步。
// [并发] 阶段推进必须带上 startModelSwitch 发放的 requestId，否则旧请求能把新请求打回 idle。
export type ModelSwitchStage =
  | "idle"
  | "settingModel"
  | "fallbackConfigOption"
  | "applyingCustomProvider"
  | "restartingRuntime"
  | "syncingSession"
  | "persistingWorkspace";

export type ConfigOptionsStatus = "idle" | "loading" | "ready" | "error";

export interface ComposerMentionPrefill {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

// 输入框文本插入请求：requestId 由 requestComposerTextInsert 分配，清除时必须带回同一个 id。
// mode 为 replace 会覆盖现有输入，[权衡] 改成默认覆盖会让等待期间用户键入的文字丢失。
export interface ComposerTextInsertRequest {
  requestId: number;
  text: string;
  mention?: ComposerMentionPrefill;
  mode?: "replace" | "prepend-if-missing";
}

export interface TimelineBottomRequest {
  requestId: number;
  taskId: string;
}

export type ComposerInitialConfig = Pick<
  Partial<SessionConfigState>,
  "planEnabled" | "modelSelection"
> & { mode?: SubmissionMode };
export interface ComposerInitialization {
  taskId: string;
  config: ComposerInitialConfig;
}

// 单个 workspace 的 UI 状态全集：task 列表、运行态分桶、模型选择、导航与各类版本号都在这里。
// activeTaskId 是当前激活 task，切换 workspace 或删除后必须归位，残留会让右侧继续渲染旧 task。
// taskRuntimeByTaskId 与 taskUiByTaskId 按 taskId 分桶，[资源] 删除 task 时两处都要回收，否则内存与 UI 一起泄漏。
// draftRuntimeInvalidationVersion 用于让 V4 pane 的独占预热会话失效，只在插件与 Skill 能力变化时自增。
// composerTextInsertVersion 与 timelineBottomRequestVersion 是递增票据，读侧据此判断请求是否已被消费。
// selectedSupplierKey 由 buildNativeSupplierKey 生成，isGhostSupplier 与 supplierMismatchReason 必须与之同步写入。
export interface WorkspaceZCodeUIState {
  /** 首次分享导入的导航参数；接收、换任务或新建后结束，不持久化。 */
  composerInitialization?: ComposerInitialization;
  /** 当前 workspace 激活中的 task */
  activeTaskId: string | null;
  /**
   * ZCode Agent 的 workspace 初始化状态。
   *
   * 单 ZCode Agent 迁移后继续按 provider 分桶会保留多份已经不会再被真实运行时更新的旧状态，
   * UI 在 task / draft / remote identity 切换时容易读到历史 provider 的 ready/failed。这里把状态收敛成
   * workspace 单一事实源，provider 参数只作为旧调用兼容输入。
   */
  workspaceInit: WorkspaceInitState;
  /** 草稿态尚未创建 taskId 前的短期运行状态；已有 task 的状态从 taskRuntimeByTaskId 派生。 */
  draftRuntime: DraftRuntimeState;
  /** 未提交草稿的项目选择；已提交归属只在 Host。 */
  draftProjectId?: string | null;
  /** 未提交任务的分组意图；无文字时仅保留在当前 Renderer 内存。 */
  draftTaskGroupId?: string | null;
  /**
   * 草稿运行时能力失效版本；插件、Skill 等能力变化时递增。
   * V4 pane 独占预热会话，配置界面只发布失效版本。
   */
  draftRuntimeInvalidationVersion: number;
  composerTextInsertVersion: number;
  composerTextInsertRequest: ComposerTextInsertRequest | null;
  timelineBottomRequestVersion: number;
  timelineBottomRequest: TimelineBottomRequest | null;
  /** 草稿态错误需要跨页面保留，避免切走再回来后提示被本地 state 一起卸载 */
  draftError: ZCodeUiError | null;
  /** 模型切换中的并发保护 requestId；只允许最新请求落库 */
  modelSwitchRequestId: string | null;
  /** 模型切换是否进行中（用于禁发和工具栏 loading） */
  modelSwitchPending: boolean;
  /** 模型切换阶段（用于细分 loading 文案） */
  modelSwitchStage: ModelSwitchStage;
  /** 每个 task 各自的运行时状态，供任务列表和状态栏读取真实 task 状态 */
  taskRuntimeByTaskId: Record<string, TaskRuntimeState>;
  /** 每个 task 自己的临时 UI 态，避免切换任务后丢失计划面板和权限弹窗 */
  taskUiByTaskId: Record<string, TaskUiState>;
  taskConfigOptionsByTaskId: Record<string, ZCodeConfigOption[]>;
  taskConfigOptionsStatusByTaskId: Record<string, ConfigOptionsStatus>;
  /** task 未读状态的兼容缓存；真实未读状态以 task meta.unreadAt 为准 */
  taskUnreadByTaskId: Record<string, boolean>;
  /** 任务列表的乐观元数据，解决新 task 落盘前左侧列表显示慢半拍的问题 */
  optimisticTaskListByTaskId: Record<string, ZCodeTaskMeta>;
  draftCreateSource: SessionCreateSource;
  /** 当前 workspace 选中的 ZCode Agent provider */
  selectedProvider: ZCodeProvider;
  /** 当前模型供应商选中键（native/custom/ghost） */
  selectedSupplierKey: string;
  /** 当前供应商是否为 ghost 态 */
  isGhostSupplier: boolean;
  /** 当前 ghost 态来源 */
  supplierMismatchReason: ModelSelectionGhostReason | null;
  /** ZCode Agent configOptions（模型、模式、思考级别等） */
  configOptions: ZCodeConfigOption[] | null;
  /** configOptions 加载状态 */
  configOptionsStatus: ConfigOptionsStatus;
  /** 可用的 slash commands */
  slashCommands: ZCodeSlashCommand[];
  /** 任务列表版本号，每次创建/删除任务时自增，驱动 TaskList 刷新 */
  taskListVersion: number;
  /** 缓存已拉取的任务列表，避免组件 remount 时闪烁 */
  taskListCache: ZCodeTaskMeta[] | null;
  /** 新建草稿时递增，驱动输入框在切到草稿态后主动聚焦 */
  draftFocusVersion: number;
}

// 动作契约：所有方法首参都是 workspacePath，可选 workspaceIdentity 用于区分同一路径下的多份身份。
// 每个 setter 只改本 workspace 桶，[并发] 绕过 getWorkspaceState 直接改 workspaces 会撕裂快照并丢更新。
// removeTaskState 负责删除后的联动回收，选中态、运行态、UI 态与导航历史要一起清理。
// taskNavHistory 是全局跨 workspace 的导航栈，push、后退、前进与 removeTaskFromNavHistory 需成对使用。
// bumpTaskListVersion 与 setTaskListCache 分工明确，版本号驱动重拉，缓存只承接结果，不要互相顶替。
export interface ZCodeSessionStoreState {
  /** 按 workspace 维护聊天相关 UI 状态 */
  workspaces: Record<string, WorkspaceZCodeUIState>;
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) => WorkspaceZCodeUIState;

  setActiveTaskId: (
    workspacePath: string,
    id: string | null,
    workspaceIdentity?: string,
    composerConfig?: ComposerInitialConfig,
  ) => void;
  consumeComposerInitialization: (
    workspacePath: string,
    initialization: ComposerInitialization,
    workspaceIdentity?: string,
  ) => void;
  invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => void;
  requestComposerTextInsert: (
    workspacePath: string,
    text: string,
    workspaceIdentity?: string,
    mention?: ComposerMentionPrefill,
    mode?: "replace" | "prepend-if-missing",
  ) => number;
  clearComposerTextInsertRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  requestTimelineBottom: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => number;
  clearTimelineBottomRequest: (
    workspacePath: string,
    requestId: number,
    workspaceIdentity?: string,
  ) => void;
  clearDraftTaskGroup: (workspacePath: string, workspaceIdentity?: string) => void;
  startDraft: (
    workspacePath: string,
    provider?: ZCodeProvider,
    workspaceIdentity?: string,
    options?: {
      projectId?: string | null;
      taskGroupId?: string | null;
      createSource?: SessionCreateSource;
    },
  ) => void;
  bindRuntimeProvider: (
    workspacePath: string,
    provider: ZCodeProvider,
    workspaceIdentity?: string,
  ) => void;
  setModelSelectionResolution: (
    workspacePath: string,
    resolution: Pick<
      ModelSelectionResolution,
      "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
    >,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitState: (
    workspacePath: string,
    status: ZCodeWorkspaceInitStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setWorkspaceInitAttempts: (
    workspacePath: string,
    attempts: number,
    workspaceIdentity?: string,
  ) => void;
  setTaskState: (
    workspacePath: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskRuntimeState: (
    workspacePath: string,
    taskId: string,
    status: ZCodeTaskRuntimeStatus,
    error?: string | null,
    workspaceIdentity?: string,
    provider?: ZCodeProvider,
  ) => void;
  setTaskUsage: (
    workspacePath: string,
    taskId: string,
    usage: TaskUsageState | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskContextWindow: (
    workspacePath: string,
    taskId: string,
    contextWindow: number | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskApiRetryStatus: (
    workspacePath: string,
    taskId: string,
    apiRetry: ZCodeApiRetryStatus | null,
    workspaceIdentity?: string,
  ) => void;
  setTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodePermissionRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskPermissionRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    request: ZCodeElicitationRequest | null,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationRequest: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    draft: ElicitationFormDraft,
    workspaceIdentity?: string,
  ) => void;
  removeTaskElicitationFormDraft: (
    workspacePath: string,
    taskId: string,
    requestId: string,
    workspaceIdentity?: string,
  ) => void;
  setTaskError: (
    workspacePath: string,
    taskId: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  setDraftError: (
    workspacePath: string,
    error: ZCodeUiError | null,
    workspaceIdentity?: string,
  ) => void;
  startModelSwitch: (
    workspacePath: string,
    requestId: string,
    stage?: ModelSwitchStage,
    workspaceIdentity?: string,
    options?: { pending?: boolean },
  ) => void;
  updateModelSwitchStage: (
    workspacePath: string,
    requestId: string,
    stage: ModelSwitchStage,
    workspaceIdentity?: string,
  ) => void;
  finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => void;
  setTaskConfigOptions: (
    workspacePath: string,
    taskId: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
    status?: ConfigOptionsStatus,
  ) => void;
  initializeBackgroundTaskRuntime: (
    workspacePath: string,
    params: {
      task: ZCodeTaskMeta;
      provider: ZCodeProvider;
      activeInputId: InputId;
      workspaceIdentity?: string;
    },
  ) => void;
  upsertOptimisticTaskListItem: (
    workspacePath: string,
    task: ZCodeTaskMeta,
    workspaceIdentity?: string,
  ) => void;
  removeOptimisticTaskListItem: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /** 删除任务后同步回收选中态和乐观态，避免右侧继续展示已删除任务 */
  removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

  setConfigOptions: (
    workspacePath: string,
    options: ZCodeConfigOption[],
    workspaceIdentity?: string,
  ) => void;
  setConfigOptionsStatus: (
    workspacePath: string,
    status: "idle" | "loading" | "ready" | "error",
    workspaceIdentity?: string,
  ) => void;
  setSlashCommands: (
    workspacePath: string,
    commands: ZCodeSlashCommand[],
    workspaceIdentity?: string,
  ) => void;
  setCurrentModeId: (
    workspacePath: string,
    modeId: string | null,
    workspaceIdentity?: string,
  ) => void;
  /** 任务列表变更时调用（创建/删除任务），驱动 zcodeTaskMetaMerge 重新拉取列表 */
  bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => void;
  /** 更新已拉取的任务列表缓存 */
  setTaskListCache: (
    workspacePath: string,
    tasks: ZCodeTaskMeta[],
    workspaceIdentity?: string,
  ) => void;
  /** 更新 task 的未读提示，控制左侧蓝点显示 */
  setTaskUnreadIndicator: (
    workspacePath: string,
    taskId: string,
    hasUnread: boolean,
    workspaceIdentity?: string,
  ) => void;

  /** workspace 导航历史（全局、跨 workspace，包含 task 与 Automations） */
  taskNavHistory: TaskNavigationHistory;
  /** 记录 Automations 主视图或详情导航。 */
  taskNavPushAutomations: (
    workspacePath: string,
    workspaceIdentity?: string,
    automationId?: string,
    automationTab?: AutomationsNavigationTab,
  ) => void;
  /** 记录插件市场主视图导航。 */
  taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => void;
  /** 后退，返回目标 entry；到头了返回 null */
  taskNavGoBack: () => WorkspaceNavEntry | null;
  /** 前进，返回目标 entry；到头了返回 null */
  taskNavGoForward: () => WorkspaceNavEntry | null;
  /** task 被删除时清理导航历史中的对应 task 条目 */
  removeTaskFromNavHistory: (taskId: string) => void;
}

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

// workspace 初始化默认态固定为 idle、无错误、零尝试，是 getWorkspaceState 的兜底来源。
// [权衡] 消费方需要独立副本时必须展开拷贝，直接引用再原地改字段会污染所有未初始化的 workspace。
// 新增字段要同时更新 WorkspaceInitState 与这里，漏改会让默认对象缺键并让首次渲染读到 undefined。
export const DEFAULT_WORKSPACE_INIT_STATE: WorkspaceInitState = {
  status: "idle",
  error: null,
  attempts: 0,
};

export const FALLBACK_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;

export const DEFAULT_TASK_UI_STATE: TaskUiState = {
  permissionRequest: null,
  pendingPermissionRequests: [],
  elicitationRequest: null,
  pendingElicitationRequests: [],
  elicitationFormDraftsByRequestId: {},
  error: null,
};

// task 运行态默认值是新建 task 的起点，status 取 notReady 表示尚未收到任何运行事件。
// backgroundTaskControls 与 activeTurnKind 等可选字段显式写 undefined，方便消费方按 key 存在性判断。
// [失败路径] 把 usage 默认成对象而非 null，UI 会把零用量当成真实上报，弹窗比例永远为 0。
export const DEFAULT_TASK_RUNTIME_STATE: TaskRuntimeState = {
  status: "notReady",
  error: null,
  provider: undefined,
  contextWindow: null,
  usage: null,
  apiRetry: null,
  backgroundTaskControls: [],
  activeTurnKind: undefined,
  activeInputId: undefined,
  activeInputOwnerClientId: undefined,
};

// ────────────────────────────────────────────
// Factory functions
// ────────────────────────────────────────────

// 默认 workspace 工厂：所有分桶字段在这里一次性建空，避免首次读写时残留 undefined。
// selectedProvider 由调用方注入，selectedSupplierKey 通过 buildNativeSupplierKey 派生，[权衡] 两者必须来自同一入参。
// 给 WorkspaceZCodeUIState 新增字段时必须在这里补初值，否则 getWorkspaceState 会返回缺键的半成品对象。
export function createDefaultWorkspaceState(
  selectedProvider: ZCodeProvider,
): WorkspaceZCodeUIState {
  return {
    activeTaskId: null,
    workspaceInit: { ...DEFAULT_WORKSPACE_INIT_STATE },
    draftRuntime: { status: "idle", error: null },
    draftRuntimeInvalidationVersion: 0,
    composerTextInsertVersion: 0,
    composerTextInsertRequest: null,
    timelineBottomRequestVersion: 0,
    timelineBottomRequest: null,
    draftError: null,
    modelSwitchRequestId: null,
    modelSwitchPending: false,
    modelSwitchStage: "idle",
    taskRuntimeByTaskId: {},
    taskUiByTaskId: {},
    taskConfigOptionsByTaskId: {},
    taskConfigOptionsStatusByTaskId: {},
    taskUnreadByTaskId: {},
    optimisticTaskListByTaskId: {},
    draftCreateSource: "session",
    selectedProvider,
    selectedSupplierKey: buildNativeSupplierKey(selectedProvider),
    isGhostSupplier: false,
    supplierMismatchReason: null,
    configOptions: null,
    configOptionsStatus: "idle",
    slashCommands: [],
    taskListVersion: 0,
    taskListCache: null,
    draftFocusVersion: 0,
  };
}

// 模块级单例默认状态，以 FALLBACK_PROVIDER 构造，供 getDefaultWorkspaceState 直接返回。
// [资源] 该对象被所有未写入桶的读取共享，任何就地修改都会跨 workspace 生效。
const DEFAULT_WORKSPACE_STATE = createDefaultWorkspaceState(FALLBACK_PROVIDER);

// 返回稳定引用而非每次新建，保证未落桶的连续 selector 读取得到同一快照。
// [失败路径] 改成返回浅拷贝会让 zustand 判等持续失败，触发无休止重渲染。
export function getDefaultWorkspaceState(): WorkspaceZCodeUIState {
  // 单 ZCode Agent 迁移后默认 provider 必须收敛到 glm。
  // 这里返回稳定引用，避免未写入 workspace bucket 的连续 selector 读取产生不同快照。
  return DEFAULT_WORKSPACE_STATE;
}
