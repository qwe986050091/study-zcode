import type { ToolSearchExecutionContext, ModelCallWrapper } from "@zcode/contracts";
import type { McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================
//
// 【定位】tool 层的唯一类型契约：handler 向 registry 声明能力（ToolEntry/ToolMetadata），
//   executor 用同一份声明做调度、权限、超时与结果序列化，不按工具名特判。
//
// 【关键不变量】
//   1) metadata 的能力声明（readOnly/destructive/concurrentSafe/sideEffectScope）是调度与
//      权限的唯一依据；调用点不得临时猜测，写错会同时改变并行性、审批与截断行为。
//   2) resolveInput 在 validateInput 之后、PreToolUse hook 之前执行；后续 hook、权限规则、
//      审批载荷与 handler 共享同一份归一化入参，保证"批准的就是执行的"。
//   3) returnedBytes 必须计入结构化媒体（CUA 栅格），否则成本/用量观测会少计图片。
//   4) 每个 tool_call 必须有配对结果：handler 的业务失败用 ToolHandlerFailure 表达，
//      而不是 throw；throw 会被 executor 归因为基础设施故障。
// ============================================================

import type {
  CollaborationMode,
  AutomationPort,
  BrowserControlPort,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  JsonSchema,
  Model,
  ModelCatalogPort,
  ModelContentProtection,
  ModelMessageContent,
  ModelToolSideEffectScope,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerReasonSource,
  PermissionCapabilityGroup,
  PermissionRuleBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  ProviderNativeToolSpec,
  RiskLevel,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  ToolCancellationPolicy,
  ToolContractDeclaration,
  ToolExecutionMode,
  ToolExecutionSpanWriter,
  ToolExecutionTelemetry,
  ToolResultBudgetStrategy,
  ToolResultDisplayPayload,
  ToolTimeoutPolicy,
  TraceContext,
  TraceId,
  TurnId,
  WorkflowEscalatePort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type {
  PersistedReadFileStateMetadata,
  PersistedReadFileStateTool,
} from "./read-file-state-metadata.js";

// -----------------------------------------------
// Tool Metadata
// -----------------------------------------------

/**
 * 工具的静态能力声明。registry 用它生成模型可见 schema、调度分组与权限默认值，
 * executor 视其为唯一事实来源；因此这里的字段既影响"能否并行"，也影响"要不要审批、
 * 结果如何截断"。运行时想按入参改这些结论，只能走 resolve* 钩子，不能在调用点覆盖。
 */
export interface ToolMetadata {
  /** 声明为延迟工具：默认不进入首轮工具面，模型需先 ToolSearch 发现后再用 DeferredToolCall 调用。 */
  shouldDefer?: boolean;
  /** 即使延迟加载机制开启，也强制进入首轮工具面（用于必须常驻的基础工具）。 */
  alwaysLoad?: boolean;
  /** 提供给 ToolSearch 的检索提示词；只影响发现排序/召回，不参与执行与权限。 */
  searchHint?: string;
  /** 模型可见的稳定工具名；也是 registry 查表、事件归因与权限规则匹配的键。 */
  name: string;
  /** 模型可见的一句话描述；未提供时由工具自身 schema/prompt 兜底。 */
  description?: string;
  /** 追加进系统提示的逐条使用说明；只写"怎么用"，不承载权限语义。 */
  modelInstructions?: readonly string[];
  /** plan 模式下是否放行；false 时由权限层拒绝，handler 不会被执行。 */
  allowedInPlanMode?: boolean;
  /** 无写副作用：流式预执行、并行分组与只读策略都以它为前提，误报会直接放大并发风险。 */
  readOnly: boolean;
  /** 破坏性操作（删除/覆盖/不可逆写入）：调度强制独占，通常还需要审批。 */
  destructive: boolean;
  /** 同批可并发；false 时 scheduler 让它独占一个 parallelGroup，避免与他人交错副作用。 */
  concurrentSafe: boolean;
  /** 需要用户交互（如确认窗）：流式预执行与批量并行必须为它让路。 */
  requiresUserInteraction?: boolean;
  /** 默认执行超时（毫秒）；handler 可用 resolveTimeoutBudgetMs 按入参再算一个更精确的值。 */
  timeoutMs?: number;
  /** 模型可见输出的字节预算上限；超过后由 result-serialization 截断或转 artifact。 */
  maxOutputBytes?: number;
  /** 副作用域（none/workspace/git/network/system）；权限、sandbox 与审计按它收口。 */
  sideEffectScope: ModelToolSideEffectScope;
  /** 风险等级：审批提示与策略默认值的输入，不替代具体的规则判定。 */
  riskLevel: RiskLevel;
  /** 是否默认进入审批门；权限规则只能在此基础上收紧，不能把 deny 放宽。 */
  needsApproval: boolean;
  /** 是否投影到 provider 的工具列表；false 表示仅内部/延迟可用，模型直接看不到。 */
  providerVisible?: boolean;
  /**
   * 声明该工具是“成功即终止 turn”的终态工具：一旦返回成功结果，executor 就在该结果上挂
   * turnControl 终止当前 turn。这是工具的内在能力声明（像 concurrentSafe/destructive），
   * 由 executor 读取，而不是在调用点按工具名猜测。submit_result 用它实现 actor 的终态提交。
   */
  stopTurnOnSuccess?: boolean;
  /** MCP discovery 的可信展示来源；只参与 UI 投影，不参与权限判定。 */
  mcpPresentation?: {
    serverName: string;
    toolName: string;
    description?: string;
    /** 来自声明 zcode_official 鉴权的 MCP server；仅用于信任其结果里的结构化标识。 */
    official?: boolean;
    /** 该 server 所属插件的稳定 id（`${name}@${marketplace}`）；非插件 MCP 为空。 */
    pluginId?: string;
    /** 工具 `_meta` 归一化后的 MCP App 描述；存在即投影 display.ui（pluginId 缺省时用 serverName 顶替）。 */
    ui?: McpToolUiDescriptor;
  };
}

// -----------------------------------------------
// Tool Execution Context
// -----------------------------------------------

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** 谁在停：TaskStop 填 "model"，终态通知据此措辞。 */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

/**
 * 一次工具调用能看到的全部世界。原则是"能力注入而不是直接 I/O"：handler 只依赖这里的端口，
 * 不碰 fs/child_process/fetch/process.env，这样超时、取消、审计、测试才能统一收口。
 *
 * 生命周期：executor 在权限通过后构造，handler 执行期间有效；abortSignal 由 turn 取消、
 * 工具超时和审批拒绝共同驱动，handler 必须把它传给下游 I/O。返回值只表达业务结果，
 * 基础设施故障应 throw 由 executor 归因。
 */
export interface ToolExecutionContext {
  toolSearch?: ToolSearchExecutionContext;
  /** 当前 tool_call 的稳定 id；事件、日志与结果配对都以它为准（不变量1）。 */
  toolCallId: string;
  /**
   * 当前 Tool 的实时观测写入器。Handler 只能通过窄接口写事实，不能接触原始 OTel Span。
   */
  telemetry?: ToolExecutionSpanWriter;
  /** 当前工具调用是否属于 automation 派发轮；写工具 handler 用它做最终权限校验。 */
  automationTurn?: boolean;
  /** 当前工具调用是否属于闲时任务派发轮；OffPeakCreate handler 用它做最终拒绝。 */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** browser-use 控制端口；node_repl 的 agent.browsers.* 经此执行。缺省则 browser 不可用。 */
  browserControlPort?: BrowserControlPort;
  /** 官方 browser-use plugin docs 资产目录；只在 browser-use 启用时用于 agent.browsers.documentation()。 */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  /** Core Server 对前台 child 的 Selection override。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** 工作流 actor 提交终态结果并等待引擎裁决的端口；仅在 workflow actor 会话注入。 */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** 工作流 actor 升级阻塞问题并等待主代理作答的端口；仅在 workflow actor 会话注入。 */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** workflow run 提交端口；缺席则 CreateWorkflow 回占位诊断而不启动。 */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** dwf snippet 同步执行端口；缺席则 EvalWorkflowSnippet 报能力缺席的业务失败。 */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** 模型目录端口；缺席则 ListModels 报能力缺席，CreateWorkflow 的 subagent_model 被拒。 */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** 记录 Skill resolved metadata；仅用于 telemetry，不改变模型可见结果。 */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
  /**
   * 用户在确认窗里调整过、且已应用到本次入参的字段（{@link ToolEntry.applyInputAdjustments} 的
   * `applied`）。handler 据它告诉模型「实际跑的不是你传的那个值」；缺席即没有调整。
   */
  inputAdjustments?: Readonly<Record<string, unknown>>;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

/**
 * 最近一次"模型读过这个文件"的内存事实，供 Edit/Write 做陈旧性判断：
 * 只有模型读过的内容才允许被改，避免基于幻觉或过期上下文覆盖用户改动。
 */
export interface ReadFileStateEntry {
  /** 规范化后的路径键；同一文件的不同写法必须落到同一条目。 */
  path: string;
  /** 读取时的内容快照；Edit 用它定位 old_string，也是判断"是否读过"的依据。 */
  content: string;
  /** 读取起点（0-based 行偏移）；与 limit 一起界定模型实际看过的窗口。 */
  offset?: number;
  /** 读取行数上限；缺席表示读到文件末尾。 */
  limit?: number;
  /** true 表示模型只看到文件的一部分：整文件覆盖写必须额外确认，不能假装读全了。 */
  isPartialView: boolean;
  /** 读取发生时间；仅用于诊断/排序，陈旧性以 mtimeMs 与 revisionId 为准。 */
  readAt: Date;
  /** 哪类读取产生该条目（Read/Glob/Grep 等）；不同来源的保真度不同。 */
  sourceTool?: PersistedReadFileStateTool;
  /** 文件修订标识（内容 hash 或等价物）；与当前磁盘不一致即视为 stale。 */
  revisionId?: string;
  /** 读取时的 mtime（毫秒）；快速路径的陈旧性比较。 */
  mtimeMs?: number;
  /** 读取时的字节数；用于判断"文件在被读后又长大/缩小"。 */
  sizeBytes?: number;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

// tool handler 用该返回值表达可预期业务失败；成功 output 不使用此保留形状。
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

export type ToolInputValidationResult = { result: true } | ToolHandlerFailure;

/**
 * {@link ToolEntry.resolveInput} 的上下文。窄到只有解析真正需要的东西——工作目录是「项目内
 * 的东西住在哪」的唯一入口，再多给就会把一个归一化钩子变成第二个执行入口。
 */
export interface ToolInputResolutionContext {
  workingDirectory?: string;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /**
   * workflow run 端口与本会话 id：AmendWorkflow 用它们把 `run_id` 解析成「前驱是不是本会话的、
   * 还在不在跑」的事实块。仍然只读——
   * 归一化钩子不因此变成第二个执行入口。
   */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * 模型目录端口：CreateWorkflow / AmendWorkflow 用它把 `subagent_model` 解析成规范形，解不出来
   * 在确认窗**之前**就作为业务失败退回。
   * 同步、只读，与 `dynamicWorkflowRunPort` 同一条理由待在这里。缺席时给了字段即被拒——
   * 不静默放行一个宿主解不了的字符串。
   */
  modelCatalogPort?: ModelCatalogPort;
  sessionId?: string;
  /**
   * 「这个会话此刻加载着某个技能吗」的探针（handlers/workflow-skill-gate.ts）。由 runtime 用
   * provider 可见历史回答（agent/loaded-skills.ts），所以 compaction 之后答案随历史一起变回
   * 否。缺席 = 本会话没有 Skill 工具或调用方不参与（单元测试直接造的 context），门不生效。
   */
  hasLoadedSkill?: (skillName: string) => boolean;
}

export type ToolInputResolutionResult = { result: true; input: unknown } | ToolHandlerFailure;

/**
 * {@link ToolEntry.applyInputAdjustments} 的结果：调整后的入参，与**实际生效**的那部分调整
 * （键同入参字段名；与入参原值相同的改动不算）。`applied` 缺席即什么都没变。
 */
export type ToolInputAdjustmentResult =
  | { result: true; input: unknown; applied?: Readonly<Record<string, unknown>> }
  | ToolHandlerFailure;

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export interface ToolEntry extends ToolContractDeclaration {
  /** 宿主资源在审批之前固定归属；所有返回路径均释放，撤销信号进入现有取消链。 */
  retainExecution?: (callId: string) => { signal: AbortSignal; release(): void };
  /** 旧名/别名：只为兼容历史 tool_call 解析，权限与调度仍按规范名收口。 */
  aliases?: readonly string[];
  /**
   * Host-issued atomicity policy for model content. Only an authority-verified
   * registration path may set this; executor code must never infer it from a
   * tool name or from model-visible content.
   */
  modelContentProtection?: ModelContentProtection["kind"];
  /**
   * Optional provider-visible character threshold for tools whose upstream contract
   * budgets UTF-16 characters rather than UTF-8 bytes.
   */
  maxModelChars?: number;
  /**
   * MIME type for provider-visible model content persisted by the result budget.
   * Defaults to the handler result shape when omitted.
   */
  resultArtifactContentType?: string;
  /** 工具能力声明；executor 的调度/权限/预算全部读这里，见 ToolMetadata 的字段口径。 */
  metadata: ToolMetadata;
  /**
   * 只由宿主验证后的可信来源写入；不能从模型可见的 MCP 名称或 descriptor 推导。
   */
  permissionCapabilityGroup?: PermissionCapabilityGroup;
  /** provider 原生工具 vs 受 executor 管线的本地工具；决定是否走权限/hook/序列化链。 */
  executionMode?: ToolExecutionMode;
  /** provider 原生工具描述；仅在 executionMode 指明原生执行时由 provider 直接调用。 */
  providerNative?: ProviderNativeToolSpec;
  /** 真正的工具实现；入参已经过 validateInput/resolveInput/hook/权限/审批，且与批准内容同字节。 */
  handler: ToolHandler;
  /** 当前 turn 模型能力对 provider descriptor 与 executor schema 的同源投影。 */
  resolveModelContract?: (context: ToolExecutionModelContext) => {
    description?: string;
    inputSchema?: JsonSchema;
  };
  validateInput?: (
    input: unknown,
    context: ToolInputValidationContext,
  ) => ToolInputValidationResult;
  /**
   * 把模型发出的入参**归一化成将要发生的执行事实**。executor 在 `validateInput` 之后、
   * PreToolUse hook 之前调用，返回值直接替换 `executionInput`。
   *
   * 位置就是全部的意义。此后 hook、项目权限规则、权限事件载荷、`prepareApproval`、handler
   * 读到的都是同一份归一化输入，于是三件事一次到位：
   *   1. 策略不被绕开——一条扫描脚本的 PreToolUse hook 在 saved run 上也能看到真正的脚本；
   *   2. 跨版本可见——入参通道对每个客户端版本都是无 schema 的透传，而 display 通道不是；
   *   3. 确认与执行同字节——只解析一次，那份字节一路带到 handler，不存在批准 A 跑 B。
   *
   * 因此返回值必须仍然满足 `inputSchema` / `runtimeInputSchema`（hook 改写后 executor 会
   * 再校验一次）。解析失败回 {@link ToolHandlerFailure}，executor 在 hook 之前收口——那是
   * 业务失败，不是基础设施故障，不该先打断用户一次确认。
   */
  resolveInput?: (
    input: unknown,
    context: ToolInputResolutionContext,
  ) => Promise<ToolInputResolutionResult> | ToolInputResolutionResult;
  /**
   * 应用用户在确认窗里对入参做的调整（docs/dynamic-workflow/launch.md「Adjusting the settings in
   * the window」）。executor 在授权之后、handler 之前调用，`adjustments` 是 broker 结果的
   * `inputAdjustments`。返回的入参必须仍是 `resolveInput` 产出的那种形状——handler 不为调整另开
   * 一条路；失败即工具失败，handler 不跑。同步：只读上下文里已有的端口，不做 I/O。
   * 不声明的工具忽略一切调整。
   */
  applyInputAdjustments?: (
    input: unknown,
    adjustments: Readonly<Record<string, unknown>>,
    context: ToolInputResolutionContext,
  ) => ToolInputAdjustmentResult;
  /** 把 handler 输出投影成模型可见内容；缺省走通用序列化/预算链（artifact、预览、截断）。 */
  formatModelContent?: (output: unknown) => ModelMessageContent;
  /**
   * 结果已落 artifact 时的模型可见投影；返回 undefined 表示沿用通用"预览 + 路径"降级，
   * 而不是让工具自定义一个可能缺路径的形态。
   */
  formatPersistedModelContent?: (
    input: ToolPersistedModelContentInput,
  ) => ModelMessageContent | undefined;
  /**
   * 按入参解析本次执行的超时预算（毫秒）；返回 undefined 表示使用 metadata.timeoutMs。
   * 只做计算、不做 I/O，且不能突破 cancellation 策略承诺的取消语义。
   */
  resolveTimeoutBudgetMs?: (
    input: unknown,
    context?: ToolExecutionModelContext,
  ) => number | undefined;
  resolvePermissionCapability?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolRuntimePermissionCapability | undefined;
  resolvePermissionRulePolicy?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolPermissionRulePolicy | undefined;
  /**
   * Last word on an `ask` decision, owned by the tool. Runs after the permission service
   * has already decided to ask, so it can only narrow the ask to a pass (`proceed`) or
   * enrich it with a preview — it can never turn an allow into an ask.
   *
   * Synchronous like the other permission hooks: it inspects the input the executor
   * already holds and must not perform I/O on the approval path. A tool that needs to
   * read the world before it can build a preview belongs in {@link resolveInput}, which
   * runs earlier, is async, and whose result the whole downstream chain shares.
   */
  prepareApproval?: (input: unknown) => ToolApprovalGate;
  /** 模型可见入参 schema；校验与 provider descriptor 同源，避免"告诉模型一套、执行另一套"。 */
  inputSchema: JsonSchema;
  /** 执行前的运行时校验（可含 provider 不接受但 executor 需要的字段）；与 inputSchema 同源投影。 */
  runtimeInputSchema?: unknown;
  /** 输出运行时校验；失败视为工具实现违约，不计为业务失败。 */
  runtimeOutputSchema?: unknown;
  /** 超时策略：硬上限 + 取消语义；handler 的 resolveTimeoutBudgetMs 只能在其中取更小值。 */
  timeout: ToolTimeoutPolicy;
  /** 取消策略：哪些阶段可中断、取消后如何落终态，executor 与后台任务据此收口。 */
  cancellation: ToolCancellationPolicy;
}

export type ToolApprovalGate =
  | { gate: "proceed" }
  | { gate: "ask"; display?: ToolResultDisplayPayload };

export interface ToolPermissionRulePolicy {
  evaluateRules: (
    behavior: PermissionRuleBehavior,
    rules: readonly PermissionRuleValue[],
  ) => boolean;
  suggestedPermissionUpdates: PermissionUpdate[];
}

export interface ToolPersistedModelContentInput {
  output: unknown;
  content: string;
  persistedPath: string;
  originalBytes: number;
}

export interface ToolRuntimePermissionCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  readOnly?: boolean;
  requiresUserInteraction?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: Partial<ToolContractDeclaration["permission"]>;
}

export interface ToolRuntimePermissionCapabilityContext {
  mode?: CollaborationMode;
  bashShellSelection?: ExecutionShellSelection;
  runtimeScope?: ToolRuntimeScope;
  workingDirectory?: string;
  workspaceRoot?: string;
}

export interface ToolExecutionModelContext {
  model?: Model;
}

// -----------------------------------------------
// Execution Results
// -----------------------------------------------

/**
 * executor 对一次 tool_call 的完整结算结果（成功与业务失败都长这个样子）。
 * 它是"配对结果"的唯一载体：只要进入这里，就必须能被序列化成一条 tool_result，
 * 不允许出现只有 tool_call 没有结果的状态（不变量1）。
 */
export interface ToolExecutionResult {
  /** 与发起调用时的 id 一一对应；结果合并/配对失败会造成历史缺块。 */
  toolCallId: string;
  /** 实际执行的工具名（延迟工具解析后是真实工具名，不是包装名）。 */
  toolName: string;
  /** 业务是否成功；权限拒绝/校验失败也是 false，但 error 里保留可归因的 code/type。 */
  success: boolean;
  /** handler 的原始输出；展示与模型投影都从这里派生，不直接等于发给模型的内容。 */
  output: unknown;
  /** 该结果对 turn 收口的指令（如终态工具成功即停、plan 退出被拒）。 */
  turnControl?: ToolExecutionTurnControl;
  /** 需要作为下一轮用户输入追加的内容（如权限拒绝后的引导语）。 */
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  /** 面向客户端的有界展示投影；生成失败即为 undefined，不影响模型结果。 */
  display?: ToolResultDisplayPayload;
  /** 实际发给模型的投影（可能被预算截断/转 artifact），与 display 相互独立。 */
  modelContent?: ModelMessageContent;
  /** 读取类工具回报的文件状态，供后续 Edit 判断新鲜度。 */
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  /** 序列化统计（原始字节、返回字节、是否截断、artifact 路径）；成本观测读取这里。 */
  serialization?: ToolResultSerialization;
  /** Executor 汇总后的内部性能事实；不进入模型可见 Tool Output。 */
  performance?: ToolExecutionTelemetry;
  /** 失败归因：type/code 是稳定判定依据，message 只供展示；reasonSource 保留审批拒绝的来源。 */
  error?: {
    code?: string;
    detail?: string;
    type: string;
    message: string;
    reasonSource?: PermissionBrokerReasonSource;
    stack?: string;
  };
  /** 端到端耗时（含排队/审批/handler），用于超时归因与性能统计。 */
  durationMs: number;
  /** 开始/完成时间戳；与 durationMs 一起构成可观测时间线。 */
  startedAt: Date;
  completedAt: Date;
}

export interface ToolExecutionFollowUpUserInput {
  input: string;
  reasonSource: PermissionBrokerReasonSource;
}

export interface ToolExecutionTurnControl {
  reason: "automation_create_limit" | "plan_exit_denied" | "subagent_terminal";
  stopTurnAfterResult: boolean;
}

/**
 * 结果预算的最终账本：既告诉模型"看到多少"，也告诉成本观测"实际发了多少"。
 * 两个字节数不可混用：originalBytes 是 handler 原始产出，returnedBytes 才是计费口径。
 */
export interface ToolResultSerialization {
  /** 序列化后的文本正文（可能是预览/截断后的形态）；展示与日志读取它。 */
  content: string;
  /** 结构化模型内容（文本块/媒体块）；与 content 同源，具体发送以它为准。 */
  modelContent?: ModelMessageContent;
  /** handler 原始输出的字节数（截断前），用于计算压缩比与预算归因。 */
  originalBytes: number;
  /**
   * 实际进入模型请求的字节。对受保护 CUA 结构化帧，序列化文本里 image 块
   * 只渲染为短占位符，但真实 base64 栅格原样发送——因此这里 = 序列化文本
   * 字节 + 真实媒体载荷，成本/用量观测（setOutputBytes、turn-tool-usage、
   * usage-observability）不得少计图片。该 aggregate 是唯一公开计量状态。
   */
  returnedBytes: number;
  /** 是否发生截断/预览替代全文；true 时模型看不到完整输出，只能按 artifactPath 再读。 */
  truncated: boolean;
  /** 命中的预算策略（内联/artifact/预览等）；用于解释为什么模型看到的是这个形态。 */
  budgetStrategy: ToolResultBudgetStrategy;
  /** 大结果落盘路径；存在时模型可见内容通常是"预览 + 该路径"。 */
  artifactPath?: string;
}

/**
 * 一个并行组/批次的聚合结果。results 保留原 tool_call 顺序，便于上层按 id 配对；
 * allSucceeded 只是便捷判断，失败详情仍逐个保留，不能据此丢弃失败项。
 */
export interface ToolBatchResult {
  /** 批次标识（通常取组内首个调用 id）；日志/事件按它聚合。 */
  toolCallId: string;
  /** 组内每个调用的独立结算结果；即使某项失败也必须有条目。 */
  results: ToolExecutionResult[];
  /** 是否全部成功；任一项业务失败或基础设施失败即为 false。 */
  allSucceeded: boolean;
}

// -----------------------------------------------
// Executable Tool Call
// -----------------------------------------------

/**
 * 进入 executor 的最小调用单元。延迟工具解析发生在上游，因此这里的 name 应是规范名；
 * modelCallWrapper 保留包装身份，供失败时原样回报给模型而不是伪装成真实工具。
 */
export interface ExecutableToolCall {
  /** 模型发出的原始包装信息（如 DeferredToolCall）；解析失败时用于保留包装身份。 */
  modelCallWrapper?: ModelCallWrapper;
  /** 与 tool_result 配对的稳定 id。 */
  id: string;
  /** 解析后的规范工具名。 */
  name: string;
  /** 已通过 schema/语义校验的入参（或待校验的原始入参）。 */
  input: unknown;
}

// -----------------------------------------------
// Batch Events
// -----------------------------------------------

/** 批次执行过程中的内部事件；只用于观测/调试，不是 durable 事实，也不进入模型历史。 */
export type ToolBatchEvent =
  | { type: "batch_start"; parallelGroupIndex: number; toolCallIds: string[] }
  | {
      type: "batch_complete";
      parallelGroupIndex: number;
      results: ToolExecutionResult[];
    }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_complete"; result: ToolExecutionResult }
  | { type: "error"; error: Error; toolCallId?: string };
