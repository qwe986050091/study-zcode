import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  Logger,
  ModelSelection,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
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
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
} from "./deps.js";
import type {
  ActiveTurnSteeringState,
  ActiveTurnStartReservation,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  PendingModelChangeTimeline,
  ProviderRuntimeHeadersPort,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

/**
 * ============================================================================
 * runtime/internal.ts —— AgentRuntime 的内部结构类型(字段 + 方法名的合并视图)
 * ============================================================================
 *
 * 【为什么存在】methods/*.ts 里的实现都是独立函数,签名形如
 * `function xxx(this: AgentRuntimeInternal, ...)`,再由 installAgentRuntimeMethods
 * 挂到 AgentRuntime.prototype。本接口把 class 的字段与三组方法契约交叉在一起,
 * 让实现函数能像方法一样访问 runtime 状态,同时不把实现细节暴露给外部调用方
 * (对外公开面是 agent-runtime.ts 的 AgentRuntime 接口)。
 *
 * 【字段分组】按职责:身份/配置 → 日志与事件 → 模型 → 工具与 hook → 上下文与记忆
 * → MCP → 子代理/工作流 → I/O 端口 → 持久化指针 → 队列与 turn 生命周期 → 关闭与遥测。
 * 所有字段都是内存态;durable 事实一律经 sessionStore/eventStore 写入。
 *
 * 【不变量】同一 runtime 同时只有一个 activeTurn / activeForegroundExecution /
 * foregroundPromotionLease;三个字段的组合决定"是否 busy",见 methods/residency.ts。
 * ============================================================================
 */
export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  // ---- 身份与配置:构造时固定,运行期只允许通过受控方法修改 config.mode/planEnabled。
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  // ---- 可观测性与事件:eventStore 是 durable 事件源,eventSinks 只做 live 扇出。
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  // ---- 工具/hook 装配:registry 是工具面事实,cachedTools 是"发给 provider 的声明"缓存。
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  // ---- 模型:modelFactory 按 selection 造 Model;sessionModelSelection 是会话常驻选择。
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  sessionModelSelection: ModelSelection | undefined;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  cachedTools: ModelToolContract[] | null;
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  // ---- 上下文与记忆:contextBuilder 懒初始化;初始化前不允许发模型请求。
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  latestContextBuildResult?: ContextBuildResult;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryRecallState: MemoryRecallState;
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  memoryDreamLastScanAtMs: number;
  pendingMemoryUpdate?: ProjectMemoryUpdate;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  // ---- MCP:两段式启动(mcpStartupPromise)+ 工具面签名/版本,用于回合边界刷新。
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  /** 常驻池判断"是否还有越过同步栈的 work"的计数器,按同步片 +1、promise finally -1。 */
  residencyBlockingWorkCount: number;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  // ---- 子代理:subagentPort 缺失时构造期会尝试 createDefaultSubagentPort;
  // getAgentDefinitions 是统一读取出口(含 memory 工具补齐),prepare 每轮刷新快照。
  subagentPort?: SubagentPort;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  // ---- 工作流/后台:runPort 缺席时 CreateWorkflow 走占位诊断;
  // runtimeTaskRegistry 是后台任务(含 branchGeneration)的权威登记表。
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /**
   * 「run 还欠着决定、主代理闲着」的提醒钟（methods/dynamic-workflow-blocked-reminder.ts）。真实 runtime 上
   * 恒在场；可选只为让手写的局部 runtime 桩不必带它。
   */
  workflowBlockedReminder?: WorkflowBlockedReminderClock;
  /** rewind / 编辑重发推进的分支代际;旧分支通知据此丢弃(见 runtime-command-generation)。 */
  branchGeneration: number;
  // ---- I/O 端口:全部可选,缺席时对应能力降级(大结果不落 artifact、无后台执行等)。
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  // ---- 路径口径:workingDirectory 用于文件/命令执行;workspaceRoot 是启动时快照。
  workingDirectory: string;
  workspaceRoot: string;
  // ---- 持久化:sessionStore 缺席时只保留内存态;sessionPersisted 标记"首条事实已落库"。
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  /** 是否已把会话本体写入 store(首条输入后为 true);协议层据此判断 draft/deferred。 */
  sessionPersisted: boolean;
  /** planEnabled 刚翻转时置位,下一轮注入"计划约束"提醒后由下游清除。 */
  needsPlanModeExitReminder: boolean;
  // ---- 会话级指针:在落库前更新,用于冷恢复锚点与 UI 最新消息定位(见链路 5)。
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  // ---- 用量/压缩诊断:主轮 cache 命中累计与连续 auto-compact 失败计数(熔断依据)。
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  lastEmittedLocalDate?: string;
  autoCompactConsecutiveFailures: number;
  // ---- 队列与 turn:全部为内存态,组合成 busy 真相。
  runtimeCommandQueue: RuntimeCommandQueue;
  /** drain 单飞标记:防同一 runtime 并发 drain 导致命令被重复消费。 */
  runtimeCommandDrainActive: boolean;
  /** 当前正在执行的整条 runtime command(覆盖 turn + goal 续跑两阶段),Stop 以此为准。 */
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  /** admission 已建 reservation 但 turn 尚未真正 begin 的窗口;也是"busy"的一部分。 */
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  /** pendingInputId -> reservationId:防止 drain 与多端提升把同一条输入消费两次。 */
  pendingInputReservations: Map<string, string>;
  /** 完全访问放行事务进行中;期间拒绝并发审批与 mode 变更。 */
  permissionFullAccessPending?: boolean;
  /** 进行中的行内 drain 计数;>0 时不允许抓取队列快照做权限授权。 */
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  /** v4 setAutoDrain 的会话级授权位:false 时排队输入不被自动消费,turn-stop 不续跑。 */
  queueAutoDrain: boolean;
  /** 外部(CLI)按投影 FIFO 恢复消费的窗口;此期间 core 不得行内 drain(避免越过暂停项)。 */
  queueExternalDrainActive: boolean;
  // ---- 关闭/遥测:beginShutdown 后所有"会唤起新 turn"的旁路都必须停摆。
  shuttingDown: boolean;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  sessionStartHookRan: boolean;
  sessionTitleGenerationAttempted: boolean;
  agentTelemetry: RuntimeTelemetryFacade;
}
