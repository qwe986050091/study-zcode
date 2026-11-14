/**
 * ============================================================================
 * executor/types.ts —— 工具执行器的依赖契约与执行选项
 * ============================================================================
 * ToolExecutorDeps 把所有外部能力以端口形式注入(fileSystem/http/execution/browser/
 * subagent/artifact/sessionStore 等):executor 与 handler 不直接触碰底层 I/O。
 * ToolExecuteOptions/ToolBatchExecuteOptions 携带本次执行的取消信号、trace、模型、
 * ToolSearch 上下文与 automation/off-peak 身份,由 runtime 逐层透传。
 * ============================================================================
 */
import type { ToolSearchExecutionContext } from "@zcode/contracts";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryActorKind,
  AutomationPort,
  BackgroundResultOriginMeta,
  BrowserControlPort,
  CollaborationMode,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  Model,
  ModelCatalogPort,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerPort,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
  WorkflowEscalatePort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import type { PermissionService } from "../../permission/service.js";
import type { RuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolSchedule } from "../scheduler.js";
import type {
  BackgroundTaskControlPort,
  ExecutableToolCall,
  ReadFileStateMap,
  ToolBatchEvent,
  ToolExecutionResult,
  ToolRuntimeScope,
} from "../types.js";

/**
 * 入队一条后台任务完成通知的命令。
 *
 * `text` 是已格式化的通知正文（含 `<result>` / `<reports>` 等已限长的节）；`taskId` /
 * `toolName` 用于去重与归因；`originMeta` 标记结果来源（如 workflow run）。
 *
 * `traceContext` 必带：异步通知必须能关联回原任务链，否则视为不可观测行为。
 */
export interface BackgroundTaskNotificationCommand {
  originMeta?: BackgroundResultOriginMeta;
  taskId?: string;
  text: string;
  toolName?: string;
  traceContext: TraceContext;
}

/**
 * 通知入队端口。按契约返回 `undefined`（fire-and-forget）：入队失败由调用方 catch 后
 * 用 `releaseRuntimeBackgroundTaskNotification` 回滚 `notified`，不要在这里吞错或自行重试。
 */
export type EnqueueBackgroundTaskNotification = (
  notification: BackgroundTaskNotificationCommand,
) => undefined;

/**
 * 通知门禁的输入：runtimeScope（main/subagent/...）、终态 status、任务/工具身份与 trace。
 * 策略据此决定"这个任务完成要不要进模型通知队列"——子代理的内部任务通常不应打扰主模型。
 */
export interface BackgroundTaskNotificationPolicyInput {
  runtimeScope: ToolRuntimeScope;
  status: string;
  taskId: string;
  toolName: string;
  traceContext: TraceContext;
}

/** 通知门禁谓词：true 才入队。实现应是纯判定，不能顺手改写 registry 或发事件。 */
export type ShouldEnqueueBackgroundTaskNotification = (
  input: BackgroundTaskNotificationPolicyInput,
) => boolean;

/**
 * 执行器构造参数（扁平、端口全部可注入）。
 *
 * 缺省口径由 `ToolExecutorImpl` 统一补：`permissionBroker` 缺省 deny-all（fail closed）、
 * `defaultTimeoutMs` 300000、`maxConcurrency` 10、`runtimeScope` "main"、`getMode` "build"；
 * `readFileState` 缺省新建 Map。本类型只声明能力，不持有会话状态。
 *
 * `sessionId` / `turnId` / `traceContext` 用来给本执行器产出的所有事件与日志定位调用链。
 */
export interface ToolExecutorOptions {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  defaultTimeoutMs?: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** actor 的升级端口；存在即为该会话注册 escalate。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 端口；按工具名查表时 CreateWorkflow 的后台生命周期提供者。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  /** 技能门的探针（ToolInputResolutionContext.hasLoadedSkill）；runtime 按 provider 可见历史回答。 */
  hasLoadedSkill?: (skillName: string) => boolean;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  workingDirectory?: string;
  workspaceRoot?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  runtimeScope?: ToolRuntimeScope;
  getWorkingDirectory?: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot?: () => string;
  getMemoryRoot?: () => string | undefined;
  traceContext?: TraceContext;
  mode?: CollaborationMode;
  getMode?: () => CollaborationMode;
  maxConcurrency?: number;
  hookRunner?: HookRunner;
}

/**
 * 执行器对外契约（唯一实现是 `ToolExecutorImpl`）。
 *
 * 不变量：`execute` / `executeBatch` / `executeSchedule` 的每个 tool_call 都必须产出配对
 * 结果，失败以 `ToolExecutionResult.success=false` 返回而非抛错（保证模型历史不缺块）。
 *
 * `executeSchedule` 产出的 batch 事件只用于观测/调试，不是 durable 事实，也不进模型历史。
 */
export interface ToolExecutor {
  /** 同一权限链供 MCP App 使用；返回审批后的输入，不执行 handler / 不做模型结果投影。 */
  authorizeAppTool?(
    toolCall: ExecutableToolCall,
    entry: import("../types.js").ToolEntry,
    options?: ToolExecuteOptions,
  ): Promise<unknown>;

  execute(toolCall: ExecutableToolCall, options?: ToolExecuteOptions): Promise<ToolExecutionResult>;
  executeBatch(
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ): Promise<ToolExecutionResult[]>;
  executeSchedule(
    toolCalls: ExecutableToolCall[],
    schedule: ToolSchedule,
    options?: ToolBatchExecuteOptions,
  ): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void>;
  /**
   * 把一个**不由本回合工具调用启动**的后台任务纳入追踪（dwf run 的 resume 重臂）。`toolCall` 是调用方合成的描述子（id = 原始
   * toolCallId、name 决定 per-tool 生命周期分派）——tracker 只读它的 id/name/input，
   * 不要求一个真实在飞的工具调用。效果与 submit 路径完全同源：runtime-task registry 登记
   * （会话回收护栏）、BackgroundTaskStarted（backgroundWorks 面板 + cancellable）、
   * 轮询/终态 waiter、结算通知。同 taskId 重复调用由 tracker 的 poller 去重（幂等）。
   */
  trackExternalBackgroundTask(
    toolCall: ExecutableToolCall,
    output: Record<string, unknown>,
    traceContext: TraceContext,
    turnId?: TurnId,
  ): Promise<void>;
}

/**
 * 单次执行的可选项。
 *
 * `signal` 是取消源（用户取消/超时），取消语义必须传到 handler 与下游 I/O；
 * `traceContext` 用于事件/日志关联；`model` 与 `subagentModelOverride` 决定工具内部子请求
 * 用哪个模型；`toolSearch` 提供延迟工具解析上下文。
 *
 * `automationTurn` / `offPeakTurn` 标记 turn 来源（自动化调度 / 错峰执行），
 * 不是普通请求可以随意置位的开关。
 */
export interface ToolExecuteOptions {
  toolSearch?: ToolSearchExecutionContext;
  automationTurn?: boolean;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  model?: Model;
}

/** 批量执行选项：在单次选项之上加 `maxConcurrency`（本批次并行上限，缺省取 deps 的值）。 */
export interface ToolBatchExecuteOptions extends ToolExecuteOptions {
  maxConcurrency?: number;
}

/**
 * 归一化后的依赖集（`ToolExecutorOptions` 的必填版）：端口与默认值在构造时已定型。
 *
 * 关键必填项：`permissionBroker`（构造期缺省补 deny-all）、`defaultTimeoutMs`、
 * `readFileState`（跨 Edit 的新鲜度状态）、`getWorkingDirectory` / `getWorkspaceRoot`、
 * `runtimeScope`、`getMode`、`maxConcurrency`。
 *
 * 可选端口缺席不是错误：对应工具在能力检查时报告"能力缺席"，禁止用 `any` 强转绕过。
 */
export interface ToolExecutorDeps {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  /** 审批端口；构造期已保证存在（缺省 deny-all），权限链不得跳过它直接执行。 */
  permissionBroker: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  /** 工具级缺省超时（毫秒），构造期缺省 300000；单工具注册值优先。 */
  defaultTimeoutMs: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** actor 的升级端口；存在即为该会话注册 escalate。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 端口；按工具名查表时 CreateWorkflow 的后台生命周期提供者。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /** 已读文件状态（路径 → 内容/时间戳），供 Edit 判断"读取后是否被外部改动"；跨调用共享。 */
  readFileState: ReadFileStateMap;
  hasLoadedSkill?: (skillName: string) => boolean;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  getWorkingDirectory: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot: () => string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  getMemoryRoot?: () => string | undefined;
  /** 执行作用域（缺省 "main"）；决定后台任务通知策略与可见性边界。 */
  runtimeScope: ToolRuntimeScope;
  traceContext?: TraceContext;
  getMode: () => CollaborationMode;
  /** 批次内并行执行上限（缺省 10）；不是全局并发池容量。 */
  maxConcurrency: number;
  hookRunner?: HookRunner;
}
