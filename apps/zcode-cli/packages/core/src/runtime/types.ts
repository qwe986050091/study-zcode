/**
 * ============================================================================
 * runtime/types.ts —— core/runtime 对外与跨方法共享的类型契约
 * ============================================================================
 *
 * 【定位】本文件只放 runtime/ 顶层与方法签名共用的结构:运行时配置(AgentRuntimeConfig)、
 * 依赖注入(AgentRuntimeDeps)、turn/prompt 的入参与结果、rewind/fork/compact 的返回值、
 * 活动 turn 的 busy 真相(activeTurn / foreground execution / promotion lease),以及
 * ContextUsage 诊断结构。实现细节留在 deps.ts(外部端口再导出)与 internal.ts(实例字段)。
 *
 * 【口径】这里的字段多数由 Bootstrap、协议层与 GUI 消费,改名或改语义属于跨层契约变更;
 * `undefined` 普遍表示"未指定/向下继承",而不是"关闭"——关闭要用显式 false。
 * 本文件被 eslint max-lines 豁免(见下方 disable),新增结构优先合并进已有接口。
 *
 * 【不变量】类型本身无运行时副作用;配置字段大多在 AgentRuntime 构造期被消费后不再变,
 * 唯一例外是 mode/planEnabled:它们由 execution-state.ts 提交后原地更新(先持久化再改内存),
 * 因此读取执行态必须走 readRuntimeExecutionState,不要直接读 config 猜测。
 * ============================================================================
 */
import type { ToolSearchExecutionContext, ToolSearchMode } from "@zcode/contracts";
import type { RequestVerificationReason } from "@zcode/shared";
import type { GetAgentDefinitions, LoadAgentDefinitions } from "../subagent/definitions.js";
import type { RuntimeInputPresentation, TurnExecutionModelFallbackReason } from "@zcode/contracts";
/* eslint-disable max-lines -- Runtime 类型集中承载 core/runtime 对外结构，拆分需要单独迁移。 */
import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  JsonSchema,
  AgentExecutionTelemetryPort,
  AgentTelemetryCausation,
  BackgroundResultOriginMeta,
  ContextUsageBreakdownItem,
  CoordinatorResponsePort,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelSelection,
  PluginReferenceCatalog,
  ResolvedUserInstructions,
  StableForkGoalBoundaryMetadata,
  StableForkTargetMetadata,
  WorkspaceHookBundleSnapshot,
  WorkspaceId,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CollaborationMode,
  EmbeddedSearchBackend,
  Logger,
  AttachmentStorageMetadata,
  MessageId,
  MessageVisibility,
  FilePartSource,
  ModelRequestAdmission,
  Model,
  ModelNetworkStatusEvent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelStreamRecoveryStatus,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  ModelInputMessage,
  MessageWithParts,
  PendingTurnInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  PartId,
  PermissionBrokerPort,
  PermissionUpdate,
  QueryId,
  RewindScope,
  RewindStrategy,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionTaskType,
  SessionMailboxPort,
  SessionProjection,
  SessionStorePort,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  HooksRuntimeConfig,
  SkillPort,
  McpPort,
  McpServerConfig,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
  TraceContext,
  TraceId,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  SessionHistoryHydrationResult,
  SyntheticUserMessageSource,
  HookRunner,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  EnvInfo,
  ProjectContext,
  UserInstructionsOptions,
  AutoCompactPolicyConfig,
  ModelAnomalyGuardConfig,
  OutputStylePromptConfig,
} from "./deps.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { BashTimeoutPolicy } from "../tool/bash-timeout-policy.js";
import type { PresentationSurface } from "../context/types.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

// -----------------------------------------------
// Agent Runtime
// -----------------------------------------------

/**
 * 单个 AgentRuntime 实例的构造期配置。绝大多数字段在 constructor 里被消费后不再变,
 * 改配置需要新建 runtime;唯一例外是 mode/planEnabled,由执行态提交路径原地更新。
 * 分组依次为:宿主路由 → 执行/预算 → 工具面 → 子代理/MCP/插件 → 模型与记忆 →
 * 动态工作流灰度门 → Context Builder 与工作区身份。
 */
export interface AgentRuntimeConfig {
  // ---- 工具搜索:决定工具面是"全量直出"还是走 search 工具按需发现。
  toolSearch?: { mode?: ToolSearchMode };
  /** shared-host CUA request routing metadata; desktop is the safe default. */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  remoteSessionId?: string;
  // ---- 执行/展示口径:超时策略、渲染面与输出根目录,与仓库本身无关。
  bashTimeoutPolicy?: BashTimeoutPolicy;
  presentationSurface?: PresentationSurface;
  /** Execution Host's output root, independent of the working repository. */
  genUiOutputRoot?: string;
  // ---- 会话级行为开关:mode 是协作模式,planEnabled 是本 runtime 独立的 Plan Mode 开关
  //      (因此 getPrePlanMode() 恒为 undefined);streaming 只影响 UI 与工具执行时机。
  mode?: CollaborationMode;
  planEnabled?: boolean;
  modelStreaming?: "off" | "on";
  streamingToolExecution?: "off" | "readOnly";
  /** Session 创建时固定；缺省使用共享的模型上下文预算默认策略。 */
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  // ---- 预算与终态:maxTurns 限制单轮循环次数;permissionTimeoutMs 是权限 ask 的等待上限;
  //      compact 是自动压缩阈值策略;targetCompletionVerification 控制目标完成校验。
  maxTurns?: number;
  permissionTimeoutMs?: number;
  compact?: AutoCompactPolicyConfig;
  targetCompletionVerification?: { enabled?: boolean };
  midConversationSystem?: {
    mode?: "auto" | "force";
  };
  // ---- 子代理:enabled 关闭后不注册 Agent 工具;inactivityTimeoutMs 是前台子代理
  //      无任何 child 事件的最大静默时间,超时后由 runtime 判定异常或转后台。
  subagents?: {
    enabled?: boolean;
    // foreground subagent 没有任何 child 事件的最大静默时间；默认对齐模型流 idle timeout。
    inactivityTimeoutMs?: number;
    autoBackgroundMs?: number;
    backgroundBashMaxMs?: number;
    maxTurns?: number;
    outputRootDir?: string;
    profiles?: readonly AgentProfile[];
    builtInModelSelectionOverrides?: Partial<Record<"general-purpose" | "Explore", ModelSelection>>;
  };
  // ---- 工具面:allowlist/disallowlist 是构造期一次性的直接过滤;toolset 决定主/只读探索
  //      两套默认工具面;toolConcurrency 只限制同批并发,不改变调度依赖。
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  /**
   * Defaults to main. Explore child runtimes use the explore toolset to opt into
   * 只读探索工具白名单；是否包含 direct Glob/Grep 由 embedded search branch 决定。
   * 主模式下 allowlist 仅做直接交集过滤，explore 子运行时还会补齐默认只读白名单。
   */
  toolset?: "main" | "explore";
  toolConcurrency?: { maxConcurrency?: number };
  // ---- 宿主能力开关:由 Bootstrap 按官方插件启停推导,普通插件 manifest 不能自声明。
  runtimeFeatures?: {
    /**
     * 是否注册 node_repl 工具（js）。
     * 由 bootstrap 根据 ZCode 官方插件启停推导，不由普通插件 manifest 自声明。
     */
    nodeRepl?: boolean;
    /**
     * 是否允许 node_repl 注入 agent.browsers。还需要宿主提供 browserControlPort。
     */
    browserUse?: boolean;
    /** 是否把 CUA broker 凭据注入共享 node_repl；不代表注册独立 CUA MCP。 */
    computerUse?: boolean;
    /**
     * 官方 browser-use plugin 的 docs 资产目录。由 bootstrap 从 plugin metadata.rootPath 推导，
     * 不属于 plugin manifest schema。
     */
    browserDocumentationRoot?: string;
  };
  // ---- 安全与外部能力:异常守卫、MCP 服务、插件身份 catalog、hooks 与 shell/搜索后端。
  modelAnomalyGuard?: Partial<ModelAnomalyGuardConfig>;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
    /**
     * Process-local provenance supplied by bootstrap after resolving bundled
     * official plugins. Never derive this list from serialized MCP config.
     */
    trustedOfficialCuaServerNames?: readonly string[];
  };
  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 由 bootstrap 在 App 创建时从 plugin loader 结果构建；runtime 只读，
   * 用于 turn start 解析 `plugin://` 引用并与 live inventory 取交集。
   */
  pluginReferenceCatalog?: PluginReferenceCatalog;
  hooks?: HooksRuntimeConfig;
  bashShellSelection?: ExecutionShellSelection | undefined;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  /** 根 Session runtime 创建时固定；false 只关闭 Bash 的 bfs/ugrep prelude。 */
  nativeSearchEnhancementsEnabled?: boolean;
  // ---- 模型与记忆:modelSelection 可以只含 provider/model 身份;titleGeneration 是
  //      独立的小模型任务;parentSessionId/taskType 决定子会话身份与持久化归类。
  memory?: MemoryRuntimeConfig;
  /** 历史恢复允许未绑定；只有完整选择才能创建本轮执行 Model。 */
  modelSelection?: ModelSelection;
  titleGeneration?: {
    enabled?: boolean;
    modelSelection?: ModelSelection;
    timeoutMs?: number;
  };
  parentSessionId?: SessionId;
  taskType?: SessionTaskType;
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）：Host 判定后经
   * ZCode Protocol 下发，runtime 只消费。**缺席即开启**（进程内嵌入方靠这个极性）；
   * 独立 CLI 的 TUI 与 headless 按 --workflow-mode 显式传 true/false（缺省 disabled，DWG-04），
   * workflow_child 继承父配置。
   * false 会关闭十个工作流工具，不改变其他工具的注册策略。
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * 灰度 mode `onDemand`（docs/dynamic-workflow/launch.md「On demand: activation」）：十个工作流
   * 工具推迟到会话首次 `/workflow`（或 GUI 对本会话 run 的 Resume / 配置 / 直接启动、冷恢复时记录里
   * 已有工作流）才注册。**缺席即立刻注册**，与 dynamicWorkflowEnabled 同极性；只有协议服务端在
   * Host 下发的 mode 为 onDemand 时写 true。激活状态归 runtime（dynamicWorkflowToolsActivated）。
   */
  dynamicWorkflowToolsOnDemand?: boolean;

  // ---- Context Builder 与工作区身份:决定 provider 可见的系统提示、语言与目录;
  //      workspacePath/workspaceIdentity 只用于持久化与本地身份恢复,执行仍用 workingDirectory。
  // Context Builder config
  systemPrompt?: string;
  /**
   * 动态工作流子代理的身份输入：在场即让
   * context builder 走「基座 + 工作流子代理契约 + persona 叠加」路径，而不是把 persona 当
   * `systemPrompt` 整段替换。与 `systemPrompt` 互斥（builder 抛错）。
   */
  workflowActor?: { name?: string; persona?: string };
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: {
    agentPrompt: string;
    userInstructions?: ResolvedUserInstructions;
  };
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  agentName?: string; // Default: "zcode-agent"
  workingDirectory?: string; // Required for context builder
  /** 本次运行的附加目录，仅用于环境 prompt 展示，不参与配置发现或持久化。 */
  additionalDirectories?: readonly string[];
  /**
   * 调用方传入的实际工作区路径表示，用于 session 持久化与本地身份恢复。
   * 文件和命令执行仍只使用规范化后的 workingDirectory。
   */
  workspacePath?: string;
  /** 仅用于持久化隔离；文件与命令执行仍使用 workingDirectory。 */
  workspaceIdentity?: WorkspaceId;
  envInfo?: EnvInfo; // Optional, will be auto-detected if not provided
  currentDate?: string; // YYYY-MM-DD, resolved by adapter when omitted
  userInstructions?: UserInstructionsOptions; // P1: AGENTS.md
  projectContext?: ProjectContext; // P2: auto-detected if not provided
  skillMetadataBudget?: number;
}

/**
 * 冷恢复(resume)的调用级参数。所有字段都不写入 session 持久化;
 * `modeOverride` 只在本次 invocation 生效,高于历史 session mode。
 */
export interface ResumeSessionOptions {
  /** 中止 cold-resume admission wait；不会伪造 Workspace Hook review decision。 */
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  /** 冷恢复调用方提供的调用级已物化结果；不进入生命周期缓存，修补后按返回值重新读取。 */
  persistedMessages?: MessageWithParts[];
  /**
   * 本次 invocation 已解析出的 mode。显式 --mode 与 headless 默认 yolo 都属于调用级覆盖，
   * 必须高于历史 session mode；交互式 resume 未指定时保持 undefined，让历史 mode 生效。
   */
  modeOverride?: CollaborationMode;
}

export interface MainTurnCacheHitAggregate {
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export type BackgroundTaskNotificationSealReason = "subagent_terminal" | "subagent_cancelled";

export interface SealBackgroundTaskNotificationsInput {
  reason: BackgroundTaskNotificationSealReason;
  traceContext?: TraceContext;
}

export interface PendingModelChangeTimeline {
  createdAt: number;
  fromModel?: ModelSelection;
  fromModelLabel?: string;
  requestId: string;
  toModel: ModelSelection;
  toModelLabel: string;
}

export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}

export interface MemoryRuntimeConfig {
  cliStorageRoot?: string;
  enabled?: boolean;
  /** 是否调度成功 Main turn 后的自动 Extraction；缺省按 true 处理。 */
  extractionEnabled?: boolean;
  storageRoot?: string;
  use?: boolean;
  workspaceIdentity?: string;
}

/**
 * 构造 AgentRuntime 时注入的宿主端口集合。全部由 Bootstrap 组装,runtime 只消费;
 * 选择性端口缺席时对应能力降级(工具不注册、命令报能力缺席),而不是在 runtime 内兜底实现。
 * 分组:子代理定义 → 遥测 → durable 存储 → 模型工厂/请求准入 → 权限/工具/hook →
 * 宿主执行与 IO → 工作流与后台 → 装配辅助(事件 sink / logger / contextBuilder)。
 */
export interface AgentRuntimeDeps {
  // ---- 子代理定义:父上下文只读一次;子执行不得继承加载器,避免递归加载。
  /** 只读目录入口；必须同步读取内存，不在请求收集阶段进行 I/O。 */
  getAgentDefinitions?: GetAgentDefinitions;
  /** 新父上下文读取一次；子执行不得继承此加载器。 */
  loadAgentDefinitions?: LoadAgentDefinitions;
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryCausation?: AgentTelemetryCausation;
  agentTelemetryCausationMode?: "child" | "linked_root";
  appVersion?: string;
  // ---- durable 存储:eventStore 必填(事件是唯一事实源),其余可缺席并降级为内存态。
  eventStore: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  // ---- 模型工厂:selection → Model 的唯一创建入口;requestDependencies 只绑本次 Model。
  modelFactory: RuntimeModelFactory;
  /** 可选宿主能力：解析未来执行的显式意图；不用于修改已冻结 Model。 */
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  // ---- 权限/工具/hook:缺席时对应工具不注册或审批一律 fail closed,不做隐式放行。
  permissionService?: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  toolScheduler?: ToolScheduler;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  // ---- 宿主执行与 IO 端口:命令、文件、网络、图片、PDF、技能与搜索都经这些端口转发。
  executionPort?: ExecutionPort;
  /** browser-use 控制端口；透传到 ToolExecutionContext.browserControlPort 供 node_repl 使用。 */
  browserControlPort?: BrowserControlPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  // ---- 工作流:端口存在即注册对应工具/真启动;缺席则走占位诊断,不是静默成功。
  /** 工作流 actor 提交终态结果的端口；存在即作为 submit_result 工具的注册门。 */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * mono 子代理的 typed `submit_result`：在场时注册的工具声明是 `{ result: <这份 schema> }` 而非
   * 任意 JSON。只改
   * provider 可见的声明与 strict 资格；handler、权限、终止语义与 workflowSubmitPort 单独在场时相同。
   * 没有端口时忽略（端口才是注册门）。
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * 工作流 actor 升级阻塞问题的端口；存在即作为 escalate 工具的注册门。与 workflowSubmitPort 同一注入方式与同一条门。
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * 模型请求的进程级准入端口：在场时
   * 每次模型请求尝试先经它拿票据；沿调用上下文到 adapter。dwf actor runtime 拿 driver 的 per-actor
   * 包装（受闸门约束），主 runtime 拿治理器的 observer（只喂信号）；缺席即不设闸门。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  onOffPeakLifecycleEvent?: (
    event: import("./off-peak/lifecycle.js").OffPeakLifecycleEvent,
  ) => void;
  workflowPort?: WorkflowPort;
  /** workflow run 的提交/观察/取消端口；存在即 CreateWorkflow 真启动，缺席则回占位诊断。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  contextSourcePort?: ContextSourcePort;
  // ---- 装配辅助:eventSink 只扇出(不落库);now 便于测试注入;contextBuilder 缺席时由 config 建。
  eventSink?: SessionEventSink;
  logger?: Logger;
  traceContext?: TraceContext;
  contextBuilder?: ContextBuilder; // Optional, will be created from config
  now?: () => Date;
  isRemoteWorkspace?: () => boolean;
  memoryRoot?: string;
}

export interface RuntimeModelFactoryInput {
  selection: ModelSelection;
  /** 只绑定到本次创建的 Model，不进入公共 ModelRequest 或 Session 持久化。 */
  requestDependencies?: ModelRequestDependencies;
}

export type RuntimeModelFactory = (input: RuntimeModelFactoryInput) => Model;

/**
 * 面向协议客户端的 provider runtime headers 端口。
 *
 * 入参的 sessionId 必须能路由到客户端持有的会话。child runtime 的账本身份不能
 * 直接用于客户端请求，否则客户端无法找到会话并返回响应，首个模型请求会一直等待。
 * 子 runtime 通过 deriveChildClientPorts 派生端口，将请求路由到父端口绑定的客户端会话。
 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest?(input: { providerId: string; modelId: string }): boolean;
  refreshBeforeModelRequest(input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    abortSignal?: AbortSignal;
    modelId: string;
    providerId: string;
    reason: RequestVerificationReason;
    sessionId: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  }): Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

/**
 * 一次 turn 的最终结果。`events` 只含本轮新增事件,`projection` 是应用这些事件后的
 * 最新会话投影;调用方不应再用 events 自行重放。`usage` 缺席表示没有 provider 用量
 * (例如纯本地取消或压缩跳过),不代表零消耗。
 */
export interface TurnResult {
  response: string;
  turnId: TurnId;
  traceId: TraceId;
  usage?: ModelUsageSummary;
  events: SessionEvent[];
  projection: SessionProjection;
}

/**
 * 标准 Submission Selection 的执行期约束。它不携带 Provider/Model 静态事实，
 * 也不会成为 Session Selection 的第二份来源。
 */
export interface ModelExecutionContext {
  // ---- 执行归属:offPeak 让本轮走谷时执行;selectionScope 固定为 execution,表示
  //      这份 Selection 只活在本轮,不回写 Session Selection。
  offPeak?: { executionId: string; ticketId: string; providerErrorCode: string };
  /** 仅当前 Turn 跳过自动 Project Memory Extraction；不修改 Session Memory 配置。 */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  /** 接纳加速输入前固定的 Session 候选；仅在内存中随本条命令传递。 */
  highspeedFallbackSelection?: ModelSelection;
  requestDependencies?: ModelRequestDependencies;
  // ---- 子代理模型口径:前台必须用本轮 submission 的模型,后台可拒绝(deny)或放行(allow)。
  subagents?: {
    foregroundModel: "submission";
    background: "deny" | "allow";
  };
  /**
   * 本次执行的 Selection 失败时，同一 Turn 内退回原模型继续跑完（保留已提交历史，只替换后续请求的
   * 模型），而不是让整轮直接失败。触发条件必须由发起方声明：`providerId` 限定只匹配本轮 execution
   * Selection 指向的 provider，`rules` 按声明顺序匹配、首个命中决定退回原因，`providerErrorCode` 缺省
   * 表示该 provider 的任何失败。core 不按 provider id、模型名或错误文案硬编码。
   * 退回目标先取 `target`（发起方抽卡时的提交选择，即会话原模型），再取本轮接纳前复制的会话常驻 Session Selection；
   * 两者都解析不出时无处可退，按真实错误失败。
   */
  selectionFallback?: {
    providerId: string;
    rules: Array<{
      reason: TurnExecutionModelFallbackReason;
      providerErrorCode?: string;
    }>;
    target?: ModelSelection;
  };
}

/**
 * 单次 turn 的执行参数(不含 TurnBackgroundAttribution)。这里的字段都是"本次调用"的
 * 覆盖项,不写回 Session 配置;`undefined` 表示沿用会话默认。
 */
export interface ExecuteTurnOptionsBase {
  // ---- 归属与模型:offPeakExecutionId 只活在内存用于通知去重;executionSelection 只影响本轮。
  /** 内存后台命令归属；不进入 canonical intent 或持久化模型默认。 */
  offPeakExecutionId?: string;
  executionSelection?: ModelSelection;
  abortSignal?: AbortSignal;
  browserAmbientContext?: {
    tabCount: number;
    currentUrl?: string;
  };
  continueActiveTargetAfterTurn?: boolean;
  displayInput?: string;
  /**
   * `input` 从此下标起是调用方追加的引擎文本（dwf ask 尾注 / nudge）。只进 TurnStarted 与用户
   * 消息 metadata 供 GUI 折叠；模型历史、持久 text part 仍是全文（amend-resume 的转录复制要全文）。
   */
  epilogueStart?: number;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  inputVisibility?: MessageVisibility;
  originMeta?: BackgroundResultOriginMeta;
  /** 仅用于冻结 background notification batch 的整批因果来源，不用于展示。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  /** 由 runtime command drain 计算，表示本轮消费过 subagent 后台结果。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 由 runtime command drain 计算，表示本轮消费过 dynamic-workflow run 的通知（完成 / 提问）。 */
  workflowResultConsumed?: boolean;
  // ---- 输入记录与 hook:skipInputRecord 用于内部合成输入不再落一条 user message;
  //      skipUserPromptSubmitHooks 只跳过 hook,不影响输入持久化。
  recordedInputMessageId?: MessageId;
  skipInputRecord?: boolean;
  skipUserPromptSubmitHooks?: boolean;
  targetId?: string;
  /** 仅当前 turn 对 provider 隐藏的工具；不修改 session runtime 的持久工具面。 */
  toolDisallowlist?: readonly string[];
  traceContext?: TraceContext;
  /** 当前 Submission 的 Selection 只用于本次执行，并可绑定逐请求依赖。 */
  modelExecution?: ModelExecutionContext;
}

export type ExecuteTurnOptions = ExecuteTurnOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

/**
 * Core prompt admission 的调用参数。Bootstrap 只提供输入事实和期望投递语义，
 * start/queue 的选择由持有该 session 状态的 AgentRuntime 原子完成。
 */
export type PromptAdmissionOptions = ExecuteTurnOptions & {
  // ---- 调用意图:commandKind 只用于诊断与事件归类;delivery 是期望投递方式,
  //      最终 start/steer/queue 由 admission 依据真实 busy 状态决定;
  //      expectedTurnId 用于 steer 时防止投递到已结束的 turn。
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  expectedTurnId?: TurnId;
  /** busy 时的产品队列语义；附件或不可 steer 时由 Core 回退 queue。 */
  queueDelivery?: "guide" | "queue";
  /** 强制进入 FIFO；用于携带只能在未来独立 turn 安装的临时运行模型。 */
  requireQueue?: boolean;
  /** queue promotion 等内部调用要求 admission 必须 idle，否则直接拒绝。 */
  requireIdle?: boolean;
};

/**
 * admitPrompt 的回执:started 表示已建立 reservation 并入队,completion 在 turn 终态
 * resolve/reject;其余分支是 TurnSteerResult(steered / rejected),拒绝不抛异常。
 */
export type PromptAdmissionReceipt =
  | {
      kind: "started";
      completion: Promise<TurnResult>;
      turnId: TurnId;
    }
  | TurnSteerResult;

export type ActiveTargetLoopTrigger = "manual" | "user-prompt" | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}

/**
 * 当前正在执行的前台 turn 的取消句柄。存在该字段本身就是 busy 真相的一部分;
 * controller 只取消本次前台执行,disposeParentAbort 负责解绑父级 abort 监听。
 */
export interface ActiveForegroundExecutionState {
  controller: AbortController;
  disposeParentAbort: () => void;
  foregroundExecutionId: string;
  /** Stop 后是否保留队列自动排空:true 让已排队命令继续,false 在取消时一并止住。 */
  preserveQueueAutoDrainOnCancel: boolean;
}

export interface StopActiveForegroundExecutionOptions {
  expectedForegroundExecutionId?: string;
  preserveQueueAutoDrainOnCancel?: boolean;
  reason?: string;
}

export type StopActiveForegroundExecutionResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

export type ForegroundPromotionLeaseMode = "after-current" | "idle-only";

/**
 * "立即发送"命令的独占执行租约。持租约期间普通队列不得出队其他命令;
 * 出队 promoted command 与清空 lease 必须在同一同步步完成(否则通知会抢占)。
 */
export interface ForegroundPromotionLeaseState {
  leaseId: string;
  promotedInputId: string;
}

export type AcquireForegroundPromotionLeaseResult =
  | { kind: "acquired"; leaseId: string }
  | { kind: "busy" }
  | { kind: "conflict"; leaseId: string };

/**
 * 对 GUI / 协议层暴露的 activeTurn 快照(只读投影,不持有内部可变对象)。
 * queueLength 只数 activeTurn 内尚未注入的 pendingInputs,不包含 runtime command
 * 队列里的 held prompt;steerable 为 false 时 admission 只能排队,不能 steer。
 */
export interface ActiveTurnInfo {
  kind: ActiveTurnKind;
  /** 本轮的 inputId（TurnStarted.inputId 的同一个值）；workflow run 的发起锚点从这里取。 */
  inputId?: string;
  queueLength: number;
  steerable: boolean;
  turnId: TurnId;
}

// ---- rewind 返回值:会话回退(branchGeneration 推进、保留消息)与工作区回退(文件恢复)
//      可以分别发生;两者都带 rewindId 便于把诊断事件与调用方报告对齐。
export interface WorkspaceRewindRestoredFile {
  action: "delete" | "restore";
  bytesWritten?: number;
  path: string;
}

export interface WorkspaceRewindResult {
  checkpoint?: CheckpointCreatedPayload;
  evaluation?: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
}

// ---- 工作区文件 rewind 预览:安全/不安全/忽略三类互斥,preview 只读不落盘,
//      apply 必须复用同一份 preview,避免预览与实际写入之间文件被外部改动。
export type WorkspaceFileRewindAction = "restore" | "delete";

export type WorkspaceFileRewindUnsafeReason =
  | "checkpoint_missing"
  | "checkpoint_unreadable"
  | "external_modified"
  | "file_read_failed"
  | "unsupported_checkpoint";

export interface WorkspaceFileRewindSafeFile {
  action: WorkspaceFileRewindAction;
  operationCount: number;
  path: string;
  toolNames: string[];
}

export interface WorkspaceFileRewindUnsafeFile {
  currentHash?: string;
  expectedHash?: string;
  message?: string;
  operationCount: number;
  path: string;
  reason: WorkspaceFileRewindUnsafeReason;
  toolNames: string[];
}

export interface WorkspaceFileRewindIgnoredFile {
  operationCount: number;
  path: string;
  reason: "bash_ignored";
  toolNames: string[];
}

export interface WorkspaceFileRewindPreview {
  canApply: boolean;
  ignoredFiles: WorkspaceFileRewindIgnoredFile[];
  safeFiles: WorkspaceFileRewindSafeFile[];
  unsafeFiles: WorkspaceFileRewindUnsafeFile[];
}

export interface WorkspaceFileRewindApplyResult {
  applied: boolean;
  preview: WorkspaceFileRewindPreview;
  response: string;
}

/**
 * 会话回退结果。branchGeneration 是回退后的新代际(缺席表示本次只做工作区回退);
 * keptMessageCount 是保留的消息数,用于调用方校验是否切到了预期边界。
 */
export interface ConversationRewindResult {
  branchGeneration?: number;
  evaluation?: RewindTargetEvaluation;
  keptMessageCount: number;
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
  targetMessageId: MessageId;
}

/**
 * fork 结果:复制消息到 forkedSessionId,父会话身份保持不变。
 * checkpoint/restoredFiles 只反映工作区侧;消息复制与文件恢复分别 best-effort,
 * 任一失败都会在 response 中给出可读说明而不是部分成功静默返回。
 */
export interface WorkspaceForkResult {
  checkpoint?: CheckpointCreatedPayload;
  copiedMessageCount: number;
  forkedSessionId: SessionId;
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
}

/** V4 resolver 已固定的目标 product turn raw transcript segment。 */
export type StableConversationForkTarget = StableForkTargetMetadata;

/** 显式 none 或完整 fork 点 goal/verifier 快照；undefined 不属于新数据。 */
export type StableConversationForkGoalBoundary = StableForkGoalBoundaryMetadata;

export type StableConversationForkChildMetadata = ForkChildSessionMetadata;

/**
 * 稳定 fork 的输入:target 是已由 V4 resolver 冻结的产品 turn 区间,
 * goalBoundary 显式区分"none"与"完整快照";sourceCommandId 保证同一命令幂等重放。
 */
export interface StableConversationForkOptions {
  forkedSessionId?: SessionId;
  modelSelection?: ModelSelection;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  revisionAtDecision?: number;
  target: StableConversationForkTarget;
  traceContext?: TraceContext;
}

/** 从父会话稳定落盘边界创建隐藏副屏 child；不复制 goal/queue/阻塞运行态。 */
export interface SelectionSideChatCreateOptions {
  modelSelection?: ModelSelection;
  sourceCommandId: string;
  revisionAtDecision?: number;
  traceContext?: TraceContext;
}

export interface ConversationBeforeInputForkOptions {
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  targetMessageId: MessageId;
  targetProductTurnId: string;
  targetTranscriptTurnId: string;
  initialInput: ForkCommitBundle["initialInput"];
  commandFact: ForkCommitBundle["commandFact"];
  traceContext?: TraceContext;
}

/**
 * checkpoint 列表项(只读投影)。coveredByCompact 表示该检查点已被压缩边界覆盖;
 * snapshotRef 只是存储引用,不能当作可直接读取的内容。
 */
export interface WorkspaceCheckpointSummary {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  diffRef?: string;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  preview?: string;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RuntimeTurnFileChangeEntry {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

export type RuntimeTurnFileChangeMap = Map<string, RuntimeTurnFileChangeEntry>;

/**
 * 一次压缩尝试的时间线上下文:operationId 关联多次 attempt,boundary 与 message/part
 * 指向被替换的历史边界;startedAt/preCompactTokenCount 只用于诊断展示。
 */
export interface CompactTimelineContext {
  operationId: string;
  messageId: MessageId;
  partId: PartId;
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  sourceCommandId?: string;
  startedAt: number;
  preCompactTokenCount?: number;
}

/**
 * 冷恢复结果:在 history hydration 结果之上附带本会话的模型候选与 readFileState 恢复计数。
 * persistedMessagesReloadRequired 为 true 时,调用方必须重新读取 durable 消息,
 * 因为本次 resume 修补的 compact 事实无法由当前 materialization 完整表达。
 */
export interface ResumeSessionResult extends SessionHistoryHydrationResult {
  directory: string;
  /** 当前恢复候选：允许仅有有效模型身份供界面补选档位，不代表 Runtime 已绑定。 */
  modelSelection?: ModelSelection;
  /** resume 是否写回了当前 materialization 无法完整反映的 compact 修补事实。 */
  persistedMessagesReloadRequired: boolean;
  readFileStateRestoredCount: number;
  readFileStateSkippedRangeReadCount: number;
  readFileStateSkippedUnreadableEditCount: number;
  traceId: TraceId;
}

export interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
}

export interface ExecuteToolsOptions {
  toolSearch?: ToolSearchExecutionContext;
  automationTurn?: boolean;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  /** 仅透传给当前 turn 同步等待的 Agent child。 */
  subagentModelOverride?: import("@zcode/contracts").SubagentRunOptions["modelOverride"];
  model?: Model;
  onBatchStart?: (toolCallIds: string[]) => Promise<void>;
}

export interface ExecuteToolsResult {
  results: ToolExecutionResult[];
  events: SessionEvent[];
}

export type ActiveTurnKind = "regular" | "compact" | "rewind";

export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export const INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENT_DIMENSION = 2000;

export interface ResolvedTurnAttachment {
  contentBlock: ModelMessageContentBlock;
  filename?: string;
  metadata: AttachmentStorageMetadata;
  mime: string;
  source?: FilePartSource;
  url: string;
}

export interface PreparedImageData {
  dataUrl: string;
  mediaType: string;
  metadata?: AttachmentStorageMetadata["image"];
}

/**
 * activeTurn 的可变内存态(不落盘)。pendingInputs 是已接纳但尚未注入模型历史的输入;
 * goalStateChangeReminderDeferralOpen 是"先不插入提醒"的窗口,退出 regular loop 时必须
 * 先关闭并将 pendingGoalStateChangeReminder 物化,否则提醒会插进未闭合的 tool results。
 */
export interface ActiveTurnSteeringState {
  kind: ActiveTurnKind;
  // active turn 被 Stop 时，goal reminder 不能插进尚未闭合的 tool results。
  // deferral 只在 regular model/tool loop 内打开，退出 loop 时先关闭再物化 pending。
  goalStateChangeReminderDeferralOpen: boolean;
  pendingGoalStateChangeReminder?: {
    text: string;
  };
  pendingInputs: PendingTurnInput[];
  steerable: boolean;
  traceContext: TraceContext;
  turnId: TurnId;
  /** 本轮的 inputId（与 TurnStarted.inputId 同源）；regular turn 在 beginActiveTurn 时记下。 */
  inputId?: string;
}

/**
 * admission 建立、执行侧消费的"起跑预留"。存在即表示有一个 turn 已获准但尚未
 * 变成 activeTurn;它参与 busy 判定,防止同一 session 在跨 await 窗口再起第二条 turn。
 * traceContext 已带 turnId,后续执行必须复用它而不是新建。
 */
export interface ActiveTurnStartReservation {
  kind: ActiveTurnKind;
  traceContext: TraceContext;
  turnId: TurnId;
}

/**
 * 一次 pending input drain 的收据。runtimeEntries 是已写入内存 history 的不可变条目,
 * 调用方的 turn-local query 必须按它同步推进,不能只依赖 injectedMessageIds;
 * toolDisallowlist 是随输入带入的工具隐藏列表,必须延续到下一次 provider 请求。
 */
export interface DrainedPendingInputDiagnostics {
  injectedMessageIds: MessageId[];
  /** 行内 Guide 本身携带的原子 Submission 配置；由下一次 model-step 边界消费。 */
  intent?: TurnInputIntentMetadata;
  latestMessageId: MessageId | undefined;
  pendingInputIds: string[];
  queryIds?: QueryId[];
  /** 本次 drain 已提交 canonical history 的不可变 entries，供 turn-local query 同步推进。 */
  runtimeEntries: readonly RuntimeMessageEntry[];
  /** 本次 drain 注入的输入附带的工具隐藏列表，下一次 provider 请求必须继续生效。 */
  toolDisallowlist?: readonly string[];
}

/**
 * 一次 provider 请求后的上下文用量快照,用于诊断与自动压缩判断。
 * token 字段可以缺席(provider 未回传),缺席不等于 0;recordedAt/traceId 用于关联。
 */
export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

/**
 * 一次非工具编排的纯模型文本请求参数(标题、摘要、目标校验等)。messages 是最终
 * provider 输入;sourceEntries 与 messages 按索引对应,只用于本地用量归因。
 * 各 onStream* 回调是增量 UI 通道,不改变请求/持久化语义。
 */
export interface RunModelTextRequestOptions {
  toolSearchEnabled?: boolean;
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** 与 messages 按索引对应的 canonical 来源，仅用于本地用量统计。 */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  reasoning: ModelReasoningContentBlock[];
  text: string;
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

/**
 * 纯模型文本请求的结果。finishReason 是 provider 原始结束原因;toolCalls 在场表示
 * 模型仍请求了工具(由调用方决定忽略还是转为下一轮),usage 是 provider 计量,
 * reasoning 与 text 是最终非流式聚合值。
 */
export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  toolCalls?: ModelToolCall[];
  usage: ModelUsage;
}

export type ParsedRewindCommand =
  | {
      action: "apply";
      targetCheckpointId?: string;
    }
  | {
      action: "fork";
      targetCheckpointId?: string;
    }
  | {
      action: "cascade-message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "status";
    };

// ---- ContextUsage 诊断:只服务展示与压缩决策,不参与事实判定。tokenMethod 说明
//      数字来源(本地估算 / provider 计数 / 按比例分摊),confidence 是可信度分级。
export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

/** 单个统计单元的字符数、token 数与来源口径;各 detail 类型都在此基线上加名称/分类。 */
export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}
