/**
 * ============================================================================
 * runtime/agent-runtime.ts —— AgentRuntime 的实例骨架与对外门面
 * ============================================================================
 *
 * 【定位】本文件只做两件事:
 *   1) 持有单个 session 的全部内存态字段(消息历史、队列、activeTurn、上下文/记忆、
 *      MCP、子代理与工作流端口等),并在 constructor 里装配它们;
 *   2) 声明对外的 AgentRuntime 接口。方法实现不在本文件——由文件末尾的
 *      installAgentRuntimeMethods(AgentRuntime) 把 methods/*.ts 的实现挂到 prototype。
 *      所以这里看到的方法签名与内部字段之间是"声明合并",不是普通 class 成员。
 *
 * 【事实分层】字段分三类:内存态(messageHistory/readFileState/队列/activeTurn)、
 * durable 句柄(eventStore/sessionStore,经 persist* 写入)、投影来源(eventReducer +
 * eventStore 重放)。不要绕开 persist* / appendEvent 直接改 durable。
 *
 * 【不变量】同一个 session 只允许一份 runtime;closeBrowserSession/beginShutdown 是
 * 单向的,调用后不再接受新 turn;所有 busy 判定字段(activeTurn / activeTurnStartReservation /
 * activeForegroundExecution / foregroundPromotionLease / runtimeCommandDrainActive)
 * 必须在同一同步段内复合读取,不能分两次判断。
 * ============================================================================
 */
import { configureOffPeakRuntime, controlOffPeakRuntime } from "./off-peak/runtime.js";
import {
  createTurnAgentDefinitions,
  createAgentDefinitionsReader,
  type GetAgentDefinitions,
} from "../subagent/definitions.js";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@zcode/shared";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type {
  CollaborationMode,
  Logger,
  BackgroundTaskCancelResult,
  SessionEvent,
  MessageId,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  ModelToolContract,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  ProjectId,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionGoal,
  SavedWorkflowScope,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  ToolCall,
  TurnState,
  MessageHistory,
  ReadFileStateMap,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  ExecutionShellSelection,
  HookRunner,
  TurnId,
} from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";
import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type {
  ModelConnectivityTestInput,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./methods/workspace-generate-text.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import {
  resolveInitialDynamicWorkflowToolsActivated,
  type DynamicWorkflowActivationSource,
} from "./methods/dynamic-workflow-activation.js";
import type {
  ActiveTurnInfo,
  ActiveForegroundExecutionState,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContinueActiveTargetLoopOptions,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ForegroundPromotionLeaseMode,
  ForegroundPromotionLeaseState,
  PendingModelChangeTimeline,
  PermissionDecisionResult,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
  ResumeSessionOptions,
  ResumeSessionResult,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import { createWorkflowBlockedReminder } from "./methods/dynamic-workflow-blocked-reminder.js";
import { createMemoryRecallState } from "../memory/recall/index.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import { cloneModelSelection } from "./model-selection.js";

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
/**
 * 单个会话的运行时实例。构造一次即冻结配置;字段没有 public 可见性,跨文件实现
 * 统一以 AgentRuntimeInternal 交叉类型访问(this)。
 */
export class AgentRuntime {
  controlOffPeakExecution(
    input: import("@zcode/shared").OffPeakControlParams,
  ): Promise<import("@zcode/shared").OffPeakControlResult> {
    // 转成 Internal 交叉类型再委派：off-peak 实现要读写受保护字段，class 外只能用断言
    // 打开类型面；但运行时传的必须是同一个 this，换副本会让配置写不回当前实例。
    return controlOffPeakRuntime(
      this as unknown as import("./internal.js").AgentRuntimeInternal,
      input,
    );
  }
  // ---- 身份与配置:sessionId 恒定;turnNumber 只增;config 在构造期解析执行态后冻结。
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  // ---- 事件与投影:eventStore 是 durable 事实源;eventReducer 重放产出 projection;
  //      eventSinks 只扇出、不落库;rootTraceContext 是本会话所有 trace 的父上下文。
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  // ---- 工具与 hook 装配:registry/executor 由 initializeRuntimeTooling 建;cachedTools 可失效。
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  // ---- 内存态:sessionModelSelection 允许仅身份未选中档位;messageHistory 是 turn 内历史;
  //      readFileState 记录本会话读过的文件,用于编辑前置校验,冷恢复时可重建。
  private sessionModelSelection: ModelSelection | undefined;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  // 上面的 cachedTools 里 null 与空数组语义不同：null 表示尚未计算（下次 getTools 会重建），
  // 缓存的是"发给 provider 的声明"而非 registry 本体：registry 被原地改写后必须由
  // invalidateToolCache 置空，否则模型会继续收到旧工具声明，新工具永远不可见。
  /** launch.md「On demand: activation」：onDemand 会话出生为 false，`activateDynamicWorkflowTools` 翻为 true。 */
  private dynamicWorkflowToolsActivated: boolean;
  private dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  // ---- 上下文与记忆:contextBuilder 可延迟到首次构建;memory* 只服务 Project Memory,
  //      pendingMemoryUpdate 是"已生成但尚未落盘"的合并候选。
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private memoryRecallState: MemoryRecallState;
  private memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private memoryDreamLastScanAtMs = 0;
  private pendingMemoryUpdate?: ProjectMemoryUpdate;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  // ---- MCP:startup 只跑一次;工具注册用 signature/revision 判断是否需要重算;
  //      residencyBlockingWorkCount 让进行中的异步工作阻止会话被按 idle 关闭。
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private registeredMcpToolNames?: string[];
  private mcpToolsSignature?: string;
  private mcpToolListRevision?: number;
  // ---- 子代理与工作流:getAgentDefinitions 每轮重新投影(补 Memory 工具),不改原始配置。
  private subagentPort?: SubagentPort;
  private readonly getAgentDefinitions: GetAgentDefinitions;
  private readonly prepareAgentDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["prepare"];
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  // 「run 还欠着决定、主代理闲着」的提醒钟；由命令队列的忙 / 闲沿驱动，beginShutdown 停掉。
  private workflowBlockedReminder: WorkflowBlockedReminderClock;
  // ---- 分支代际:rewind/编辑重发时 +1,旧分支的后台通知与子代理消息据此丢弃。
  private branchGeneration = 0;
  // ---- 宿主 IO 端口:执行/文件/图片/PDF 都经端口转发,runtime 内不做真实 I/O。
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  // ---- 工作区与会话持久化:workspaceRoot 构造期等于 workingDirectory;sessionPersisted
  //      为 false 时执行态只写内存,首次 ensureSessionPersisted 后转为 true。
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  // 自动压缩的三个判定输入：上次 assistant 完成时间用于节流、已广播的本地日期用于
  // 避免重复的日期提示、连续失败计数用于熔断；任一项漏重置都会让压缩停摆或反复重试。
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  // ---- 队列与 turn:这组字段共同构成 busy 真相。队列入队即尝试 drain;drain 用
  //      runtimeCommandDrainActive 防重入;lease/reservation 保证"立即发送"与
  //      "已准入未执行"都算忙。
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  // 自增序号只保证本进程内 pendingInputId 唯一（拼成 pending_<turnId>_<n>），
  // 跨端顺序一律以投影为准，不能拿它当排队或渲染的排序依据。
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  private queueAutoDrain = true;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  private queueExternalDrainActive = false;
  // ---- 关闭与通知封口:shuttingDown 之后不再唤起新 turn;封印后后台任务的迟到
  //      通知只记录不再入队。agentTelemetry 是唯一遥测出口。
  private shuttingDown = false;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  /**
   * 装配单个 session 的 runtime。同步完成:配置合并(强制 preflight 预算策略并解析
   * mode/planEnabled)、子代理定义投影、遥测门面、权限/工具/hook 装配、内存态初始化;
   * 最后若注入 contextBuilder 则从上下文初始化 history,并异步启动 MCP(不阻塞构造)。
   * 失败语义:装配期抛错即构造失败,不留半个实例;部分端口缺席时按降级策略(default
   * permission config / deny broker / 内存 task registry)补齐。
   * 副作用:会设置 registry/executor、可能发起 MCP 连接;不写 durable(会话本体延迟到
   * ensureSessionPersisted)。
   */
  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    // 先固定 Internal 视图：后续 helper（initializeRuntimeTooling/startMcpStartup）都按
    // 这个类型访问字段，混用 this 与 runtime 会让编译器看不到声明合并出来的成员。
    const runtime = this as unknown as AgentRuntimeInternal;
    // sessionId 是会话唯一不变的身份，turnNumber 从 0 起单调递增；两者必须在任何可能
    // 触发事件的装配之前就位，否则首批事件会带上空身份或错位的回合号。
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = {
      ...config,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    };
    // 在复制出来的对象上再算一次执行态，保证 config 在构造期就冻结成最终值；
    // 直接改入参对象会让调用方持有的配置被 runtime 反向污染。
    Object.assign(this.config, resolveExecutionState(config));
    // 子代理定义走"每轮投影"而不是把 profiles 直接交给调用方：优先用 Host 注入的读取器，
    // 缺省才按 config.subagents 建 reader，避免两处来源同时存在。
    const definitions = createTurnAgentDefinitions(
      deps.getAgentDefinitions ??
        createAgentDefinitionsReader(this.config.subagents?.profiles ?? [], {
          builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
        }),
      deps.loadAgentDefinitions,
    );
    // Host 每轮加载的快照会替代启动配置；在统一读取出口补齐 Memory 工具，
    // 避免子 Agent 有持久记忆提示却没有 Write/Edit，也不回写原始配置。
    // 每次调用都重新 project 而不缓存：definitions.get() 随 Host 每轮快照变化，
    // 缓存一份会把上一轮的工具集发给下一轮，子 Agent 拿不到新启用的记忆工具。
    this.getAgentDefinitions = () =>
      projectPersistentAgentMemoryTools(definitions.get(), this.config.memory);
    this.prepareAgentDefinitions = definitions.prepare;
    // 遥测门面必须早于权限/工具装配创建：tooling 初始化时就会用它上报注册结果，
    // 晚建会让首批装配事件丢失，遥测里出现"有工具却没有注册记录"的空洞。
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    // 权限三件套按"注入优先、缺省降级"装配：缺省服务用 defaultPermissionConfig，
    // broker 缺省必须是 deny——构造期没有 UI 可确认，默认放行等于越权。
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    // 并发上限取自已冻结的 config（这一行之后改 config 不会再影响调度器）；
    // 缺省实例只属于本 runtime，跨会话共享会互相抢占并发配额。
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    // reducer 每个 runtime 独占：它持有重放进度与投影缓存，共享实例会让两个会话
    // 互相覆盖投影；eventStore 是 durable 事实源，这里只存句柄、写入统一走 persist*。
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    // 外部没给 trace 就自建根上下文：本会话所有子 trace（turn/tool/subagent）都挂在它下面，
    // 缺失会让调用链断成孤立 span，日志无法按 traceId 聚合。
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    // 用 child logger 把根 trace 字段固化进去：之后每条日志自动带 sessionId/traceId，
    // 避免调用点手工拼上下文（漏拼一次就成了不可关联日志）。
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    // 只加入 sink 集合、不立即回放：构造期还没有历史投影，
    // 早订阅的 sink 需要自己调 getProjection 补齐既有事件。
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    // 时间与远程判定都以函数注入：测试可注入固定时钟复现 turn 时间线，
    // 远程状态必须每次调用求值，不能在建实例时固化（同一进程内 workspace 可能切换）。
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    // 这些端口只是透传句柄，不做存在性校验：缺席是合法降级态（对应能力入口自行判断），
    // 构造期抛错会让只需要历史恢复的调用方也无法建 runtime。
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    // 准入端口随每次模型请求进调用上下文，而不是在构造期取一次策略快照：
    // 它必须在请求发生时仍能读到最新配置。
    this.modelRequestAdmission = deps.modelRequestAdmission;
    // 在装配继续之前登记 off-peak 状态与生命周期回调：后续 MCP/工具初始化期间就可能
    // 触发低峰事件，注册晚一步会丢掉首个状态迁移，低峰配额从此对不上。
    configureOffPeakRuntime(
      this as unknown as import("./internal.js").AgentRuntimeInternal,
      deps.onOffPeakLifecycleEvent,
    );
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    // 有值时深拷贝一份：调用方可能复用同一对象改档位，持有引用会让当前模型被外部改写。
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    // 内存态在这里一次建好：messageHistory 只是 turn 内工作副本，冷恢复时由
    // initializeMessageHistoryFromContext 重填；构造函数不读任何 durable 数据。
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = new Map();
    this.memoryRecallState = createMemoryRecallState();
    // 命令队列必须早于任何可能入队的 helper：入队即触发 drain，
    // 队列不存在时空闲沿检查会静默丢弃命令（用户侧表现为"发送后没反应"）。
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    // 用 "." 兜底而不用 process.cwd()：工作目录由入口层决定，
    // runtime 不隐式依赖进程状态；workspaceRoot 稍后与它对齐。
    this.workingDirectory = config.workingDirectory ?? ".";
    // 上下文/技能/MCP 端口同样只透传：三者缺席时对应能力入口自行降级，
    // 不在构造期统一报错，保证"只恢复历史"的路径也能建出实例。
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    // 后台任务表优先复用注入实例（同进程多 runtime 共享一张表），缺省才建内存实现；
    // 创建后立刻同步分支代际，否则旧分支的迟到任务不会被过滤掉。
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
    // 提醒钟绑定本 runtime 的队列忙/闲沿，必须在队列就绪后、turn 启动前建好；
    // 建晚了首个 run 结束时没有观察者，用户看不到"还欠决定"的提醒。
    this.workflowBlockedReminder = createWorkflowBlockedReminder(runtime);
    // 宿主 IO 端口全部透传，runtime 内不做真实读写：业务侧只表达意图，
    // 由 adapter 统一处理超时、取消与审计；缺省为 undefined 表示该能力不可用。
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    // 缺省子代理端口由 runtime 自造，但必须传原始 deps：此时 this 上还有一半端口没赋值，
    // 在 this 上读端口会拿到 undefined，子代理会缺模型/权限能力。
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    // 注入的 registry 可能与外部共享（dwf 运行时守卫会原地改写），不能假定它是空的；
    // 缺省时新建独占实例，内置工具注册留给 initializeRuntimeTooling。
    this.registry = deps.toolRegistry ?? createToolRegistry();
    // workspaceRoot 只在构造期从 workingDirectory 复制一次：二者语义不同
    // （展示/执行目录 vs 文件工具的工作区边界），工作区边界不应随目录切换而漂移。
    this.workspaceRoot = this.workingDirectory;
    // 必须先于工具装配：registerRuntimeBuiltInTools 的灰度门读的就是这个状态。
    this.dynamicWorkflowToolsActivated = resolveInitialDynamicWorkflowToolsActivated(this.config);
    // 工具装配放在 config/registry/权限/遥测都就位之后：initializeRuntimeTooling 会读
    // registry 与权限服务注册内置工具，任何一项缺失都会在构造期抛出，不留半个实例。
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    // hook 准入端口由 Host 层持有并跨会话共享限流，不能由 tooling 自建，
    // 否则每个 runtime 各有一份配额，全局并发上限形同虚设。
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    // 上下文构建器允许缺席：缺席时 history 保持空，首次 executeTurn 会再尝试初始化；
    // 只有在场才回填，避免用空上下文覆盖 resume 已经 hydrate 的消息。
    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(this.contextBuilder, this.rootTraceContext);
      // 回填成功才置位：这个标记用于跳过重复初始化，提前置位会让后续 resume 跳过
      // 历史重建，表现为"打开会话是空的"。
      this.contextInitialized = true;
    }
    // MCP 启动是异步且不阻塞构造：这里只发起连接，结果收敛到 mcpStartupPromise；
    // 所以构造返回不代表 MCP 工具可用，首个 turn 必须等待该 promise。
    runtime.startMcpStartup(this.rootTraceContext);
  }

  /**
   * 关闭该会话的 browser 资源。先 beginShutdown(进单向关闭态、停提醒钟与记忆提取),
   * 再释放 node_repl 会话,最后通知 browser backend 关闭;backend 失败只 warn,
   * 不阻断后续 execution/MCP/session store 的主关闭链路。
   */
  async closeBrowserSession(): Promise<void> {
    // 先进入单向关闭态再释放资源：反过来的话，释放期间到达的后台通知还能唤起新 turn，
    // 与正在关闭的 session store 竞态，写入已关闭的句柄。
    this.beginShutdown();
    // node_repl 会话按 sessionId 挂在全局注册表里，必须显式 dispose：
    // 漏掉会让 REPL 的子进程活过 runtime，长时间运行后表现为句柄与内存泄漏。
    disposeNodeReplSession(this.sessionId);
    // browser 关闭单独 try 且放在最后：backend 不可用只影响浏览器能力，
    // 不能阻断后续 execution/MCP/session store 的主关闭链路。
    try {
      await this.browserControlPort?.closeSession?.({
        // 带上根 trace：backend 侧清理日志要与本会话其余事件同一条链，
        // 否则排查关闭失败时拿不到 sessionId 关联。
        sessionId: this.sessionId,
        traceContext: this.rootTraceContext,
      });
    } catch (error) {
      // browser backend 清理失败不能阻断 execution/MCP/session store 的主关闭链路。
      // 所以这里只 warn 不 rethrow：抛出会让调用方的 finally 提前中断，后面的主链路永远不执行。
      this.logger?.warn("Browser session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.session_cleanup.failed",
      });
    }
  }

  /**
   * 进入单向关闭态:置 shuttingDown 以拒绝新 turn 唤起,停掉 workflow 提醒钟,
   * 并立即 shutdown 本 runtime 的记忆提取调度器(单会话关闭后进程仍存活,不能只等超时)。
   * 幂等:重复调用只是重复设 same flags/停已停的钟。
   */
  beginShutdown(): void {
    // 顺序固定为"先立标志、再停观察者、最后停调度器"：shuttingDown 是其他组件判断
    // 能否唤起新 turn 的唯一依据，必须最先置位，否则停钟期间仍有新 turn 挤进来。
    // ExecutionPort.close() 会把后台 Bash 收口为 cancelled；若允许
    // teardown terminal event 再唤醒模型，并与随后关闭的 session store 竞态。
    this.shuttingDown = true;
    // 同一条理由：会话在关，提醒钟不能再到点唤起一轮。
    // 停钟是同步且幂等的：重复 beginShutdown 只是再停一次已停的钟，不会重复注册定时器。
    this.workflowBlockedReminder.stop();
    // 关闭单个 session 后进程仍存活，
    // 因此必须先终止该 runtime 的 Extraction，不能只在超时后放弃等待。
    // 可选链是必需的：未启用 Project Memory 的会话没有调度器；shutdown 只终止已调度项，
    // 不等待正在跑的提取，所以单会话关闭不会被一次慢模型调用拖住。
    this.memoryExtractionScheduler?.shutdown();
  }
}

/**
 * AgentRuntime 的对外接口,与上面的 class 声明合并。方法实现由 installAgentRuntimeMethods
 * 从 methods/*.ts 挂载;调用方不应依赖字段顺序或存在性,只依赖语义与不变量。
 * 分组:执行态/会话配置 → 身份与标题 → turn 准入与 busy → 队列操作 → 模型与事件 →
 * 子 runtime 接缝 → 上下文/恢复 → 目标与工作流 → 执行与工具 → fork/rewind → 记忆。
 */
export interface AgentRuntime {
  // ---- 执行态与会话级配置:权限授权 id、关闭、mode/planEnabled、shell 环境。
  lastPermissionGrantId?: string;
  beginShutdown(): void;
  closeBrowserSession(): Promise<void>;
  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  // ---- 模型选择:sessionModelSelection 允许未绑定;set 只改内存/投影,不重建 runtime。
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  // ---- 会话身份与标题:external activity 可能先于首条 prompt 落会话本体与标题。
  getProjectId(): ProjectId;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  // ---- turn 准入与 busy 真相:admitPrompt 原子决定 start/steer/queue;
  //      has* 系列是常驻池回收会话的唯一依据,必须包含队列/预留/后台工作。
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;
  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;
  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;
  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;
  // ---- 队列操作:reservation 与 promote 是两阶段;单项编辑/重排必须保位并校验 reservation。
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。 */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /**
   * v4 heldQueueDisposition=clearQueueAndSend 执行件：
   * 清空全部排队输入（active turn 内存项 + held 投影残留），返回丢弃条数。
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级）。 */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列外层 FIFO 已消费到空，恢复后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级）。 */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;
  /** v4 switchModelConfig：模型选型变化后补发 ModelSelected（config/marker 投影）。 */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;
  /** v4 switchCollaborationMode：协作模式切换后补发 SessionModeChanged（config.mode 投影）。 */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  // ---- 工具、事件与投影:appendEvent 是唯一 durable 写入路径;subscribe 返回退订函数。
  getToolRegistry(): ToolRegistry;
  /**
   * 注册表被外部改写后让 getTools 重算。公开它的唯一使用者是 dwf driver 的 submit profile 运行时
   * 守卫：静态 profile 与实际 ask 不符时把
   * typed 的 submit_result 换回通用声明——改的是同一个注册表，缓存不失效就会继续把旧声明发给模型。
   */
  invalidateToolCache(): void;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  /**
   * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store，供 class 外构造的子
   * runtime 共享（照 `subagent.ts` 的 `eventStore: this.eventStore`）。理由见
   * `methods/config.ts` 的实现注释。
   */
  // ---- 子 runtime 接缝:class 外构造的子 runtime 必须共享 eventStore、经本 runtime
  //      扇出事件,并经 createChildClientPorts 取交互端口(否则确认窗找不到父会话)。
  getSessionEventStore(): SessionEventStorePort;
  /**
   * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集
   * （保留子 sessionId、只通知不 append）。**必须在子 runtime 构造期装成它的
   * `deps.eventSink`**——理由见 `methods/config.ts` 的实现注释。
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    /**
     * 子 runtime 的交互归属（与 `createChildClientPorts` 同一份）。在场时交互事件
     * （PermissionRequested / Resolved / Denied）另镜像一份到本会话，确认窗才能在父界面出现。
     */
    interactionOrigin?: ChildClientPortsContext;
  }): Promise<void>;
  /**
   * 外部子 runtime 的接缝（三）：铸造子 runtime 的对外交互端口（permission broker +
   * provider runtime headers），已绑定本 runtime 的客户端路由身份。class 外构造的子 runtime
   * **必须**经这里取这两个端口，不能自行从 appOptions 取——理由见 `methods/config.ts` 的实现注释。
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;
  // ---- 上下文、技能与会话恢复:resume 只 hydrate,不启动 turn。
  getContextBuilder(): ContextBuilder;
  /** Composer 使用的 Session Skill 快照；同一 runtime 冻结，runtime 重建后重新发现。 */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  // ---- 目标 / 工作流 / 记忆事件记录:事件源在 bootstrap,这里只做校验后 append。
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** workflow run 进度的出回合追加（事件源在 bootstrap 的 run service）。 */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** 恢复的 dwf run 的追踪重臂（registry 登记 + started 事件 + waiter + 结算通知）。 */
  /**
   * onDemand 会话注册十个工作流工具（docs/dynamic-workflow/launch.md「On demand: activation」）。
   * 已激活时 no-op 返回 false。触发点：`/workflow` 展开、GUI 的 Resume / 配置 / 直接启动、冷恢复。
   */
  activateDynamicWorkflowTools(input: {
    source: DynamicWorkflowActivationSource;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 中枢直接启动一个已保存的工作流：解析 + 校验 + 编译，
   * 干净则 submit 启动 run、落 controlOnly 启动轮、登记后台追踪。`app.startSavedWorkflow` 能力的
   * 落地实现（端口在场时注册）。
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run、登记后台追踪、把设置轮排进队列。
   * `app.amendWorkflowRunSettings` 能力的落地实现。
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  // ---- 目标续跑与前台取消:continue* 只在 idle 边界起 turn;stop 返回 stopped/idle/mismatch。
  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
  // ---- 执行与工具编排:schedule 只算依赖,execute 才产生副作用;权限请求经 broker 挂起。
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;
  getSessionId(): SessionId;
  // ---- checkpoint / fork / rewind:会话侧与工作区侧可分别执行;preview 只读,apply 落盘。
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  /**
   * conversation edit/retry 的 same-session branch cut primitive。
   *
   * 该入口故意不经过 executeTurn command queue：组合文件 rewind 会在文件事务的
   * commit gate 内调用它；若再排队 `/rewind`，当前 edit command 会等待自己释放队列。
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  // ---- 采样与工作区生成:走独立模型请求,不复用 turn 历史,也不进会话投影。
  sampleModel(
    input: import("./methods/sample-model.js").SampleModelInput,
    options: { abortSignal: AbortSignal; traceContext?: TraceContext },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;
  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  // ---- Project Memory:enabled 由 config.memory 派生;drain 只等待已调度提取,不新调度。
  isProjectMemoryEnabled(): boolean;
  /** 缺省等待最多 60 秒；null 等待全部已调度提取结束，不设置 drain deadline。 */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
}

installAgentRuntimeMethods(AgentRuntime);
