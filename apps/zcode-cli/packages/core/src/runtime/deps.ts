// INV-01 runtime 的外部依赖只走本门面：守住位置 全部 re-export；改错故障 深引内部模块导致替换点扩散。
// INV-02 本文件不持有状态：守住位置 仅导出与三个纯函数；改错故障 模块级缓存污染多次运行。
// INV-03 本文件不做 I/O：守住位置 无文件与网络调用；改错故障 导入即产生副作用。
// INV-04 queryId 前缀固定：守住位置 模板字符串；改错故障 日志检索规则失效。
// INV-05 queryId 用随机 UUID：守住位置 crypto.randomUUID；改错故障 并发查询标识碰撞。
// INV-06 子上下文强制继承父 queryId：守住位置 queryId 覆盖表达式；改错故障 同一查询的子步骤断链。
// INV-07 显式覆盖优先于继承：守住位置 空值合并顺序；改错故障 调用方无法纠正上下文。
// INV-08 子上下文其余字段原样派生：守住位置 契约层实现；改错故障 会话与回合标识丢失。
// INV-09 属性覆盖保持浅合并：守住位置 options 透传；改错故障 深度合并引入意外键。
// INV-10 日志投影只搬运标识：守住位置 字段展开；改错故障 用户内容进入日志。
// INV-11 日志投影补齐 queryId：守住位置 显式赋值；改错故障 按查询过滤失效。
// INV-12 缺字段保持未定义：守住位置 不补默认值；改错故障 日志出现虚假空值。
// INV-13 契约值只从契约包转出：守住位置 export 列表；改错故障 本地另造同义实现。
// INV-14 契约类型与值分区转出：守住位置 两个 export 块；改错故障 类型被当运行时而报错。
// INV-15 core 内部实现不承诺对外稳定：守住位置 第二段说明；改错故障 外部直接被内部签名绑定。
// INV-16 新增依赖先在此登记：守住位置 文件说明；改错故障 依赖清单与实际引用漂移。
// INV-17 转出顺序按来源分组：守住位置 三段导出；改错故障 审查时无法区分契约与实现。
// INV-18 本文件不定义 runtime 私有类型：守住位置 纯转出；改错故障 私有类型泄漏成公共契约。
//
// 模块职责：runtime 层唯一依赖门面，集中转出契约包与 core 内部实现。
// 状态所有权：无状态；三个本地函数均为纯构造。
// 阅读顺序：先看文件头定位说明，再看三个工具函数，最后看两段转出清单。
/**
 * ============================================================================
 * runtime/deps.ts —— runtime 层的统一依赖门面(re-export barrel)
 * ============================================================================
 *
 * 【定位】
 *   runtime/* 与 runtime/methods/* 不直接 import @zcode/contracts、agent、tool 等
 *   具体模块,而是统一从本文件取类型与实现。这样 runtime 的"外部世界"只有一份
 *   清单,替换/裁剪实现时不必改上百个 import 点。
 *
 * 【三类内容】
 *   1) 少量本地工具:queryId / 子 traceContext / 日志上下文转换;
 *   2) @zcode/contracts 的值与类型:事件、错误、ID 生成、模型输入/输出、端口契约;
 *   3) core 内部实现:message history、turn machine、工具注册/执行、权限、context、
 *      compact、subagent、MCP 等(runtime 自身消费,不对外承诺)。
 *
 * 【不变量】
 *   - 本文件只做转出与三个纯函数,不持有状态、不做 I/O、不写事件;
 *   - createChildTraceContext 强制沿用父 queryId,保证一次 query 的整棵调用链可关联;
 *   - 新增 runtime 依赖应先在此登记,而不是在业务文件里直接深引内部模块。
 * ============================================================================
 */
export { basename, join, resolve as resolvePath } from "node:path";
import {
  createChildTraceContext as createContractChildTraceContext,
  traceContextToLogContext as contractTraceContextToLogContext,
} from "@zcode/contracts";
import type {
  LogContext as ContractLogContext,
  QueryId as ContractQueryId,
  SessionId as ContractSessionId,
  TraceContext as ContractTraceContext,
  TurnId as ContractTurnId,
} from "@zcode/contracts";

/**
 * 生成一次 query 的标识(前缀 query_ + UUID)。
 *
 * 输入:无。输出:品牌化 QueryId。副作用:无(不使用全局计数器或存储)。
 * queryId 的口径是"一次用户请求/一轮执行的关联键",一个 turn 内所有模型请求、
 * 工具与子代理都沿用同一个值;失败路径不存在,不抛错。
 */
// 格式固定为 query 前缀加 UUID。
// createQueryId 不使用全局计数器，冲突概率交给 crypto.randomUUID。
// createQueryId 不读取任何外部配置，重启后仍能独立生成。
// 同一进程内多次调用 createQueryId 互不相关，调用方不能假设顺序。
export function createQueryId(): ContractQueryId {
  return `query_${crypto.randomUUID()}` as ContractQueryId;
}

/**
 * 由父 traceContext 派生一个子上下文(turn / tool / subagent 各一层)。
 *
 * 输入:父上下文 + 可选覆盖(queryId/sessionId/turnId/attributes)。
 * 输出:新的 TraceContext。副作用:无(纯构造),但会被写入日志与事件 payload。
 * 口径:queryId 必须继承父级,除非调用方显式指定——否则同一 query 的子步骤会
 * 断链。失败语义:options 缺省时等于浅派生子上下文,不抛错。
 */
// createChildTraceContext 的 parent 是必填入参，缺省会在派生时抛错。
// options 里的 queryId、sessionId、turnId 与 attributes 全部由调用方决定，均可选。
// options 缺省为空对象，默认值因此落在空对象上。
// 子上下文先交给 createContractChildTraceContext 派生，再补 queryId。
// 再用覆盖值修正 queryId。
export function createChildTraceContext(
  parent: ContractTraceContext,
  options: {
    queryId?: ContractQueryId;
    sessionId?: ContractSessionId;
    turnId?: ContractTurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): ContractTraceContext {
  const child = createContractChildTraceContext(parent, options);
  return {
    ...child,
    queryId: options.queryId ?? parent.queryId,
  };
}

/**
 * 把 TraceContext 投影成日志上下文。
 *
 * 输入:traceContext;输出:LogContext(同样补上 queryId,便于按 query 过滤日志)。
 * 副作用:无。口径:只搬运标识字段,不含用户内容/密钥,可直接进 logger.child。
 * 失败语义:纯对象展开,不抛错;缺字段时保持 undefined,由日志层决定是否输出。
 */
// traceContextToLogContext 先取 contractTraceContextToLogContext 的投影。
// 再补上 queryId。
// traceContextToLogContext 只搬运标识字段而不写入用户内容。
// 缺字段保持原样。
export function traceContextToLogContext(context: ContractTraceContext): ContractLogContext {
  return {
    ...contractTraceContextToLogContext(context),
    queryId: context.queryId,
  };
}

/**
 * 契约层运行时值:事件构造/归约、ID 生成、错误构造与判定、模型输入媒体判定、
 * compact/goal/rewind/checkpoint 的 payload 解析与格式化常量。
 * 它们是 runtime 写 durable 事实与事件的唯一"语法",不要在业务文件里另造同义实现。
 */
export {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CoreErrorType,
  EventReducer,
  HookEventName,
  ModelErrorCode,
  RewindScope,
  RewindStrategy,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  createCoreError,
  createModelUsageSummaryFromEvents,
  createMessageId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionEvent,
  createSessionId,
  createToolCallId,
  createTurnId,
  createUnsupportedModelInputMediaText,
  getModelUsageTotalTokens,
  getCurrentTraceContext,
  getCurrentModelInvocationContext,
  getUnsupportedModelInputMediaKind,
  isFileSystemPortError,
  isCoreError,
  isProviderVisibleModelInputMediaBlock,
  isProviderVisiblePdfModelInputBlock,
  isProviderVisibleVideoModelInputBlock,
  modelMessageContentToText,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  parseCompactBoundaryPayload,
  parseWorkspaceCheckpointArtifact,
  evaluateRewindTarget,
  selectActiveConversationBranch,
  formatLocalIsoDate,
  runWithContextAsync,
  runWithModelInvocationContext,
  formatTodoStateForModel,
  formatGoalStateForModel,
  formatGoalContinuationPrompt,
  failOpenGoalCompletionVerification,
  failedGoalCompletionVerification,
  formatGoalCompletionVerificationFailurePrompt,
  formatGoalCompletionVerificationPassedContent,
  formatGoalCompletionVerificationPrompt,
  parseGoalCompletionVerificationText,
  escapeGoalPromptText,
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_TARGET_BYTES,
  VIDEO_INPUT_MAX_BYTES,
  READ_VIDEO_MAX_INPUT_BYTES,
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
} from "@zcode/contracts";
/**
 * 契约层公共类型:身份(MessageId/TurnId/SessionId)、消息与 part、模型请求/流事件/
 * 用量、权限与审批、外部端口(store/mailbox/workflow/mcp/subagent/execution)、
 * 事件与投影、compact/target/checkpoint 的 payload 类型。
 * 这里只转出,不定义 runtime 私有类型(那些在 types.ts / internal.ts)。
 */
export type {
  CollaborationMode,
  GoalStatus,
  Logger,
  AttachmentStorageMetadata,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  BackgroundExecutionSnapshot,
  BackgroundTaskCancelResult,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
  CompactBoundaryPayload,
  CompactPreservedSegment,
  CompactTimelinePayload,
  MessageAnchorOrigin,
  MessageId,
  MessageWithParts,
  MessageInfo,
  MessagePart,
  MessageProjectionAnchor,
  MessageSemantics,
  MessageVisibility,
  SavedWorkflowScope,
  WorkflowLaunchMeta,
  FilePartSource,
  ModelSelectionOrigin,
  ModelNetworkStatusEvent,
  ModelAnomalyGuardConfig,
  Model,
  ModelEvent,
  ModelInvocationContext,
  ModelOptions,
  ModelProperties,
  ModelRequest,
  ModelRequestAdmission,
  ModelSelection,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  ModelStreamEvent,
  ModelStreamingPayload,
  ModelToolSideEffectScope,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelVideoContentBlock,
  ModelInputMessage,
  ModelInputFormat,
  ModelReasoningContentBlock,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  PendingSteerInputInfo,
  PendingTurnInput,
  TurnAttachmentMeta,
  PartId,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerRequestOptions,
  PermissionBrokerResult,
  PermissionUpdate,
  ProjectId,
  SessionEvent,
  SessionEntryInfo,
  SessionEventSink,
  SessionEventStorePort,
  SessionInfo,
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionModePort,
  StreamRecoveryAnchorPayload,
  StreamingToolExecutionTiming,
  StreamingToolLedgerPayload,
  StreamingToolLedgerStatus,
  DynamicWorkflowRunProgressPayload,
  TargetChangedPayload,
  UserInputAutoResolutionUpdatedPayload,
  TargetCompletionVerificationPayload,
  TimelinePart,
  TimelinePartDraft,
  GoalCompletionVerificationOutput,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionTaskType,
  SessionTitleSource,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  InteractionRequestOrigin,
  HooksRuntimeConfig,
  SkillLoadOutcome,
  SkillContent,
  SkillOperationOptions,
  SkillPort,
  SyntheticUserMessageSource,
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  SubagentPort,
  SubagentTaskSnapshot,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
  TodoItem,
  SessionGoal,
  SessionModeChangedPayload,
  QueryId,
  TokenUsageInfo,
  TraceContext,
  TraceId,
  TurnFileChangeSummary,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnExecutionKind,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
  ContextSourceSnapshot,
  DiffHunk,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  CompletedToolPartMetadata,
} from "@zcode/contracts";
/**
 * core 内部实现的转出:agent(历史/回合状态)、hooks、tool(调度/执行/注册表)、
 * permission、context 构建、compact、subagent、MCP。
 * 这些不是对外契约,而是 runtime 组装内核时直接消费的实现;签名变化会直接影响
 * runtime 行为,改动需与 runtime 同步评审。
 */
// 内部实现的转出由 turn-state 的 ToolCall、TurnAttachment 与 TurnState 类型开始。
// 类型与值分开声明：export type 与 export 各占一段。
// 签名变化需要 runtime 同步评审。
// 这里直接转出实现而不额外包装，签名变化即 runtime 行为变化。
export type { ToolCall, TurnAttachment, TurnState } from "../agent/turn-state.js";
export {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "../agent/session-history-hydrator.js";
export type { SessionHistoryHydrationResult } from "../agent/session-history-hydrator.js";
export { hydrateReadFileStateFromSession } from "../agent/read-file-state-hydrator.js";
export type { ReadFileStateHydrationResult } from "../agent/read-file-state-hydrator.js";
export { countContextPrefixMessages, MessageHistoryImpl } from "../agent/message-history.js";
export type { MessageHistory } from "../agent/message-history.js";
export { TurnMachineImpl } from "../agent/turn-machine.js";
export {
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
} from "../hooks/index.js";
export type { HookRunner, HookRunResult } from "../hooks/index.js";
export type { ToolDependency, ToolSchedule } from "../tool/scheduler.js";
export { defaultToolScheduler as defaultScheduler, ToolScheduler } from "../tool/scheduler.js";
export { PermissionService, defaultPermissionConfig } from "../permission/service.js";
export { createDenyPermissionBroker } from "../permission/broker.js";
export { createToolExecutor, createToolRegistry, registerBuiltInTools } from "../tool/index.js";
export type {
  ExecutableToolCall,
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
} from "../tool/index.js";
export type {
  ContextBuilder,
  ContextBuilderConfig,
  ContextBuildResult,
  OutputStylePromptConfig,
} from "../context/index.js";
export { createContextBuilder, estimateTokens } from "../context/index.js";
export type { EnvInfo, ProjectContext, UserInstructionsOptions } from "../context/index.js";
export {
  COMPACT_PROMPT_TOO_LONG_RETRY_MARKER,
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  MAX_COMPACT_PROMPT_TOO_LONG_RETRIES,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  estimateMessageTokens,
  formatCompactSummary,
  getAutoCompactThreshold,
  getMessagesToSummarize,
  getUsageTotalTokens,
  hasEnoughMessagesToCompact,
  maybeLocalMicrocompactMessages,
  shouldAutoCompact,
  buildDefaultMicrocompactThreshold,
} from "../compact/index.js";
export type { AutoCompactPolicyConfig } from "../compact/index.js";
export type { AutoCompactTokenOverride } from "../compact/index.js";
export type { LocalMicrocompactPolicyConfig } from "../compact/index.js";
export {
  EXPLORE_AGENT_ALLOWED_TOOLS,
  EXPLORE_AGENT_TYPE,
  GENERAL_PURPOSE_AGENT_TYPE,
  DEFAULT_SUBAGENT_TYPE,
  buildGeneralPurposeSystemPrompt,
  buildExploreAllowedTools,
  buildExploreAgentPrompt,
  buildExploreSystemPrompt,
  createSubagentContextBuilder,
  createExploreSubagentPort,
} from "../subagent/index.js";
export type { AgentProfile, ExploreSubagentRuntimeRequest } from "../subagent/index.js";
export { registerMcpTools } from "../mcp/index.js";
