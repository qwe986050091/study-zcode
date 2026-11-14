import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- session event 契约集中在单文件导出，避免 app/agent 协议类型分散后漂移。 */
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================
//
// 【文件定位】本文件是 session 事件信封与全部 payload 形状的唯一定义处：
//   core 运行时铸造、持久层落盘、EventReducer 折叠、协议映射与 TUI 展示都从这里取形。
//   字段一旦漂移，live 投影与冷恢复两条路径会同时失真，改字段前必须先对齐
//   event-reducer / event-reducer-helpers 的消费口径。
// 【持久化不变量】payload 里的身份字段（messageId / toolCallId / pendingInputId /
//   goalIteration）是幂等合并键，同一事件重放不得产生重复条目；时间字段只用于展示。
// 【跨进程】信封上的 sequenceNumber 是唯一日志 cursor，timestamp 不承担定序职责。

import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type {
  CollaborationMode,
  HighspeedMessageMetadata,
  RiskLevel,
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
} from "../interfaces/session.port.js";
import type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
  ModelUsageSummary,
} from "../model/index.js";
import { createModelUsageSummary } from "../model/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/index.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

// Re-export for convenience
export type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

// Base Event
/**
 * 事件溯源日志的**持久事实信封**：一条 SessionEvent 一旦 append 即不可改写，
 * 会话投影只能由它（而不是另一份 message 表）折叠出来。
 * 生产者：core 的 createSessionEvent + appendEvent，以及 v4 bridge 的 feedback /
 * highspeed 指标写入（它们同样走 event store 拿 seq）。
 * 消费者：EventReducer（live apply 与冷恢复 reduce 同一套 handler）、协议映射层、
 * getEventsAfter 的增量重放。
 * 不变量：id/traceId 在铸造时固定；sequenceNumber 由 appendEvent 单调分配，
 * 跨进程恢复只认 "> cursor" 增量，绝不按 timestamp 重排。
 */
export interface SessionEvent {
  // 事件自身身份：幂等写入/去重按 id 判定，而不是按 (type, timestamp)。
  id: EventId;
  // 事件只归属一个 session；跨 session 的因果由 traceId 串联，不靠 sessionId 传递。
  sessionId: SessionId;
  // 仅 turn 级事件在场；会话级事件（created / title / mode）没有 turn 归属。
  turnId?: TurnId;
  // 决定 payload 的解释方式；reducer 按它分发，未知值走"只推进 updatedAt"兼容分支。
  type: SessionEventType;
  // 墙钟时间，只用于展示与 projection.updatedAt；不参与排序或重放定序。
  timestamp: Date;
  // 顶层任务链身份；子 session、重试请求、后台任务都继承同一个值。
  traceId: TraceId;
  // appendEvent 单调分配的日志 cursor（从 1 递增）；增量重放按 > cursor 过滤。
  // 不能用 timestamp 替代：同毫秒多条事件会丢序，跨进程时钟也不可比。
  sequenceNumber: number;
  // 具体事实体；由 type 决定形状，冷恢复时必须容忍旧版本缺失字段。
  payload: unknown;
}

/**
 * 事件类型字典：字符串值就是持久化日志里的 `type`，改名等同于破坏历史会话的可读性。
 * 生产者：core 的 createEvent 逐个引用；消费者：reducer 的 handlers 表、协议映射、
 * 事件暴露过滤器（如 shouldExposeSessionEventToProtocol）都按这些字面量分支。
 * 不变量：只增不改；新增类型时旧 reducer 必须落到"未知事件只推进 updatedAt"的兜底，
 * 因此新增事件不得承担改变既有投影语义的职责。
 */
export const SessionEventType = {
  SessionCreated: "session_created",
  SessionResumed: "session_resumed",
  SessionForked: "session_forked",
  SessionCompacted: "session_compacted",
  SessionTitleUpdated: "session_title_updated",
  SessionModeChanged: "session_mode_changed",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // guide 未遇到可用 tool batch 即收口时，原 intent 原地改投普通 queue。
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // sendQueuedNow 原子提升：reservation/promoting/rollback 均进入事件流，投影不本地猜测。
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input 与 user message/parts 已在同一事务 promotion；CommandInbox 可安全解除 pin。
  SessionInputPromoted: "session_input_promoted",
  // v4 queue 重排：queue 项顺序变化（reducer 按 orderedPendingInputIds 重排 queue rows）。
  TurnSteerReordered: "turn_steer_reordered",
  // v4 输入控制：queue autoDrain 开关（held 派生 heldQueueInputRequiresChoice 的授权位）。
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 输入控制：followup 路由模式（running 时 enqueue vs guide）。
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  HighspeedMetricsUpdated: "highspeed_metrics_updated",
  // （2026-09-12）：原 ToolWidgetStateUpdated / SessionPluginUiStateUpdated 已删除，
  // 插件 UI widgetState 回退 renderer 内存，不再经 CLI 事件流。
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  TurnExecutionModelFallback: "turn_execution_model_fallback",
  ModelStreaming: "model_streaming",
  StreamingToolLedgerUpdated: "streaming_tool_ledger_updated",
  StreamRecoveryAnchorCreated: "stream_recovery_anchor_created",
  StreamRecoveryStarted: "stream_recovery_started",
  StreamRecoveryAnchorSelected: "stream_recovery_anchor_selected",
  StreamRecoveryTailDiscarded: "stream_recovery_tail_discarded",
  StreamRecoveryRetryStarted: "stream_recovery_retry_started",
  StreamRecoveryBlocked: "stream_recovery_blocked",
  ModelNetworkStatus: "model_network_status",
  ModelAnomalyWarning: "model_anomaly_warning",
  NetworkRequestStatus: "network_request_status",
  ModelComplete: "model_complete",
  ModelError: "model_error",
  ToolCallScheduled: "tool_call_scheduled",
  ToolCallStarted: "tool_call_started",
  ToolCallProgress: "tool_call_progress",
  ToolCallResult: "tool_call_result",
  ToolCallError: "tool_call_error",
  ToolBatchComplete: "tool_batch_complete",
  BackgroundTaskStarted: "background_task_started",
  BackgroundTaskUpdated: "background_task_updated",
  BackgroundTaskCompleted: "background_task_completed",
  // workflow run 的实时进度：一条引擎 RunEvent 一条事件，追加到**父会话**（run 自己没有会话）。
  // v4 侧归约成 workflowRuns 状态键；v3 侧在 shouldExposeSessionEventToProtocol 剥离。
  // 命名刻意带 dynamic_：legacy `Workflow` 工具的 script run 事件（workflow_started /
  // workflow_completed，script-workflow-runtime.ts）是另一套日志，同名会真的混淆。
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  // 插件 UI 订阅的 MCP 资源变化。只进 live 投影（v4Gateway.ingest，seq 0），不落盘、不进冷恢复。
  PluginUiResourceUpdated: "plugin_ui_resource_updated",
  PluginUiResourceListChanged: "plugin_ui_resource_list_changed",
  /** App-Provided Tools：模型发起的页面工具调用，只进 live 投影（实例信箱），不落盘。 */
  PluginUiInstanceClosed: "plugin_ui_instance_closed",
  PluginUiAppToolCallRequested: "plugin_ui_app_tool_call_requested",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // 软门禁:准入状态变化时发射,pendingCount=0 时投影层清空 snapshot 字段。
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  HookRunStarted: "hook_run_started",
  HookRunProgress: "hook_run_progress",
  HookRunCompleted: "hook_run_completed",
  HookRunFailed: "hook_run_failed",
  HookRunBlocked: "hook_run_blocked",
  CompactStarted: "compact_started",
  CompactCompleted: "compact_completed",
  CompactFailed: "compact_failed",
  CompactBoundary: "compact_boundary",
  MicrocompactBoundary: "microcompact_boundary",
  RewindTriggered: "rewind_triggered",
  CheckpointCreated: "checkpoint_created",
  TargetChanged: "target_changed",
  TargetCompletionVerification: "target_completion_verification",
  SubagentSpawned: "subagent_spawned",
  SubagentMessage: "subagent_message",
  SubagentStopped: "subagent_stopped",
  Interrupt: "interrupt",
  Cancel: "cancel",
  Resume: "resume",
  Error: "error",
} as const;

/**
 * 字典值联合，用于信封 type 字段与 switch 穷尽检查。
 * 它固化的是"可被持久化的事件种类闭集"：运行时写入的字符串必须落在其中，
 * 否则冷恢复时 reducer 只能按未知事件跳过语义（向前兼容的代价，而非报错）。
 */
export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

// -----------------------------------------------
// Event Payloads
// -----------------------------------------------

/**
 * 会话诞生时的初始事实：协作模式、plan 开关与上下文窗口预算。
 * 生产者：SessionManager.createSession（新会话与子会话）；
 * 消费者：reducer 的 SessionCreated handler 据此重置 id/mode/contextWindow 并落到 idle。
 * 跨进程不变量：它是事件流的第一条（seq 最小）；但旧会话可能缺这条事件，
 * reducer 因此用首个事件的 sessionId 兜底，不能假设本 payload 一定存在。
 */
export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

/**
 * 会话恢复的"恢复了什么"摘要：中断工具数、消息/part 数、压缩线、排队输入、todo 数。
 * 生产者：resume 流程读完持久 store 后一次性发射；
 * 消费者：协议层/UI 的恢复提示，不参与状态重建——真实状态仍由随后重放的历史事件决定。
 * 不变量：计数字段是恢复那一刻的快照，重复 resume 只会追加新事件，不得回写旧事件。
 */
export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

/**
 * 分叉事实：从哪个会话/检查点/消息切出新 session，以及可复制的文件快照引用。
 * 生产者：SessionManager.forkSession；消费者：协议层展示分叉来源，冷恢复据此复制快照。
 * 不变量：forkPoint 是已废弃的消息下标口径，新调用方只能读 targetMessageId /
 * targetCheckpointId；restored* 缺失表示没有可复制快照，不能解读成"恢复了 0 个文件"。
 */
export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

/**
 * 一次压缩终结后的持久快照：压缩边界（token/保留消息数）+ 可选摘要 + 事件清理计数。
 * 生产者：压缩编排完成后发射；消费者：reducer 的 SessionCompacted handler 委托
 * applyCompactBoundary 更新 contextUsed 与 lastCompact。
 * 不变量：压缩是"上下文事实"而不是"消息被删"事实；removedEventCount /
 * preservedEventCount 只用于审计，不得据此推断消息是否仍存在于存储。
 */
export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

/**
 * 压缩生命周期事件（compact_started / completed / failed）的载荷别名，
 * 直接复用 compact 包的 CompactTimelinePayload，避免契约包与 compact 模块出现两份字段定义。
 * 生产者：compact 编排层；消费者：协议/UI 的压缩进度与失败原因展示。
 */
export type CompactLifecyclePayload = CompactTimelinePayload;

/**
 * microcompact 边界事件的载荷别名（复用 MicrocompactBoundaryPayload）。
 * 与 session_compacted 的区别：microcompact 只裁工具结果/低价值片段，不重写历史摘要，
 * 因此不携带 summary，也不清理事件条目；reducer 仍按同一边界 helper 更新上下文用量。
 */
export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

/**
 * 附件渲染（additive）：用户输入附件的轻量展示元信息，随 TurnStarted 下发，
 * v4 投影据此填 userInput row 的 attachments。
 * 只承载展示所需字段，不含内容本体（内容经 resolve/persist 走 FilePart/artifact）。
 * 生产者：turn 入口在 admission 时从 pending 附件解析出展示元信息。
 * 消费者：v4 投影填 userInput row 的 attachments；冷恢复从消息 metadata 读同形数据。
 * 不变量：ref 缺失只表示没有稳定内容引用（如 data URL），不能用文件名反查内容。
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** 内容引用（本地路径 / artifact URI）；data URL 等无稳定引用时缺省。 */
  ref?: string;
}

/**
 * workflow 通知的结构化载荷。
 * 发射侧铸造、有界（summary≤500 / result≤4000 / error≤2000 / reports.preview 逐条≤500、≤8 条 /
 * artifacts ≤8 条、title≤120 / question·context≤4000）；与 shared 的
 * workflowNotificationMetaSchema 保持手工同步。
 * 批量通知轮刻意不携带——一轮一张 manifest 的对应关系在批量下不成立。
 */
export type WorkflowNotificationMeta =
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      /** `status === "stopped"` 才在场。 */
      stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
      summary: string;
      result?: string;
      resultForm?: "prose" | "json";
      resultTruncated?: true;
      error?: string;
      reports?: { count: number; shown: number; preview: string[] };
      /**
       * 用户面产物的 chips 载荷：≤ 8 条，
       * 超出（含被种类过滤掉的）置 `artifactsTruncated`。
       *
       * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与同一载荷上的
       * `result`（脚本顶层返回值，引擎内部也叫 artifact）是两件不同的东西。
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** run 的交付物；清单以它带头。只有它带 `description`（完成卡的交付物行要念）。 */
        primary?: true;
        description?: string;
      }[];
      artifactsTruncated?: true;
      durationMs?: number;
    }
  | {
      kind: "escalation";
      qid: string;
      actor: string;
      question: string;
      context?: string;
      askedAt?: number;
    }
  /**
   * 脚本到达一处留白（docs/dynamic-workflow/transcript-and-notifications.md 的 `hole` 载荷）：
   * 主代理欠这个 run 一段代码。`prompt` ≤4000（与升级问题同界）；`before` / `after` 是留白前后
   * 的阶段名，`draftPath` / `line` 指向 run 草稿里的那一行。每个 `hole-reached` 恰好一条。
   */
  | {
      kind: "hole";
      siteId: string;
      ordinal: number;
      name: string;
      type: string;
      prompt?: string;
      draftPath?: string;
      line?: number;
      before?: string;
      after?: string;
      reachedAt?: number;
    }
  /** run 级停滞：每个 stall 段一条，不是终态。 */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/**
 * 主代理闲着、run 还欠着决定时的提醒：每个 run 一条，带发出那一刻开着的问题数、等着的留白数与
 * 其中最久的等待。不是 run 事件——由父会话的空闲钟发出。
 *
 * 它是 originMeta 上独立的键，不是 WorkflowNotificationMeta 的成员：那个 union 在线上是闭集，多一个
 * kind 会让不认识它的客户端拒掉整帧、打不开会话；不认识的键只是被剥掉
 * （docs/dynamic-workflow/transcript-and-notifications.md「The payload」）。
 */
export interface WorkflowBlockedMeta {
  questions: number;
  holes: number;
  sinceMs: number;
}

// 生产者：后台任务/工作流完成后的通知轮，写进 TurnStarted.originMeta（冷恢复来源是消息 metadata）。
// 消费者：投影按 backgroundSource 选卡片形态；workflowNotification 与 workflowBlocked 至多在场一个。
/** 独立后台结果轮的展示元信息；批量轮可复用代表任务身份并合成 title，不从通知文本反向解析。 */
export interface BackgroundResultOriginMeta {
  /** `workflow` 是 dynamic-workflow run（workId ≡ runId），复用整条后台通知管线。 */
  backgroundSource: "bash" | "subagent" | "workflow";
  workId: string;
  title: string;
  /** 只在 backgroundSource === "workflow" 的单条通知轮上在场；manifest 渲染的唯一数据源。 */
  workflowNotification?: WorkflowNotificationMeta;
  /** 空闲提醒的载荷；与 workflowNotification 至多在场一个。 */
  workflowBlocked?: WorkflowBlockedMeta;
}

/**
 * turn 是否承载真实 Agent 执行。controlOnly 只为可见控制输入建立时间线边界，
 * 不得推进 session running/activeWorks，也不应产生“工作中/已工作”状态。
 */
export type TurnExecutionKind = "agent" | "controlOnly";

/**
 * 离峰（off-peak）后台执行轮的类型：init 是首次初始化 run，resume 是断点续跑。
 * 生产者：离峰调度器在创建 TurnStarted 时写进 backgroundAttribution；
 * 消费者：投影/UI 区分两类离峰任务，避免把"续跑"误显示成新任务。
 * 不变量：它只在携带 offPeakTaskId 的分支在场，与 automationId 互斥。
 */
export type OffPeakRunType = "init" | "resume";

/**
 * turn 的后台归因三元组（automation / off-peak task / 无归因），用互斥可选字段表达。
 * 生产者：中枢启动器与离峰调度器在铸造 TurnStarted 时选择其中一个分支；
 * 消费者：投影据此把该轮归到自动化或离峰任务账本，而不是普通用户轮。
 * 不变量：三个分支彼此互斥（never 字段保证不会同时出现），且必须是可判别联合，
 * 不能靠字段是否存在猜测来源——冷恢复读到的 metadata 与活投影必须落到同一分支。
 */
export type TurnBackgroundAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: OffPeakRunType;
      automationId?: never;
    }
  | {
      automationId?: undefined;
      offPeakTaskId?: undefined;
      offPeakRunType?: never;
    };

/**
 * 中枢直接启动已保存工作流的启动轮元数据。同一份同时写进 user message 的 `metadata`（冷恢复来源）与 `TurnStarted`
 * payload（活投影来源）——冷热同形，投影据它画启动卡而不是显示文本。
 */
// 消费者：启动卡与工具卡复用同一 display 投影，冷热两路都必须能画出一致的因果图。
/** 启动元数据上的 display 只允许 create_workflow 这一种投影（与 shared 行 schema 同形）。 */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * 设置轮（docs/dynamic-workflow/launch.md「The settings turn」）的「改了什么」：只有改动过的设置在场，
 * 每项 from / to 缺一端即那一端是默认（模型 = 会话模型，上限 = 默认并发）。`ceiling` 是默认并发 D
 * （线上键名早于「默认并发」这个概念，为兼容旧端保留），供「默认 13 → 4」这种读法。与 shared 的 `workflowSettingsAmendMetaSchema` 同形。
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * 被这次调整替代（或接着跑）的那个 run。**缺席即就地生效**
   * （docs/dynamic-workflow/launch.md「The settings turn」）：只改并发上界、run 又还在飞时，
   * 那次「配置」既不停这次 run 也不另起一次，于是没有前驱可指——`runId` 指的就是被调整的那一个。
   * 与 shared 的 `workflowSettingsAmendMetaSchema` 同形（那边记着老桌面上的偏斜）。
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

/**
 * 中枢直接启动已保存工作流的启动轮元数据。同一份同时写进 user message 的 `metadata`（冷恢复来源）
 * 与 `TurnStarted` payload（活投影来源）——冷热同形，投影据它画启动卡而不是显示文本。
 * 生产者：workflow launch 路径在铸造 turn 时生成，并经 boundWorkflowLaunchMeta 收进边界。
 * 消费者：v4 投影的启动卡、会话标题、run 详情侧板（按 toolCallId 反查发起行）。
 * 不变量：runId 是唯一身份（≡ backgroundTaskId ≡ cancel 的 workId）；缺字段表示该轮没有
 * 对应事实（例如设置轮没有保存文件可指），不能靠空串占位。
 */
export interface WorkflowLaunchMeta {
  /** run 的身份（≡ backgroundTaskId ≡ cancelBackgroundWork 的 workId）。 */
  runId: string;
  /**
   * 启动这次 run 的合成 toolCall id（中枢启动 `launch-<uuid>`，设置轮 `settings-<uuid>`；
   * 工具卡 → 详情页关联键）。
   */
  toolCallId: string;
  /**
   * 工作流名（解析结果，非用户/模型可覆盖）；启动卡题名与会话标题都取它。中枢启动恒在场；设置轮取被
   * 调整的 run 自己的名字，无名 run 即缺席（UI 换用兜底词，不拿 run id 当标题）。
   */
  name?: string;
  /** 解析出的实际作用域（不是请求里可能缺席的 scope）。只属于中枢启动：设置轮没有保存文件可指。 */
  scope?: SavedWorkflowScope;
  /** 保存文件的落点，用于详情/诊断；不参与执行。只属于中枢启动。 */
  path?: string;
  /** 本次 run 的实参（已按声明校验并回填默认值）；有界见 {@link boundWorkflowLaunchMeta}。 */
  args?: Record<string, unknown>;
  /** 工作流说明（saved 元数据的 description），有界 ≤ 500 字符。 */
  description?: string;
  /**
   * 启动前编译得到的 `create_workflow` 结果 display（有界因果图 + 诊断），与 CreateWorkflow 工具行
   * `display` 同一投影、同一构造函数。run 详情侧板按 toolCallId 找「发起行」取图——直接启动没有
   * 工具行，图就从这里取。
   */
  display?: WorkflowLaunchDisplay;
  /**
   * 本次 run 实际执行的脚本原文（与 `port.submit.scriptText` 同一份）。工具路径把它放在工具入参
   * `input.script` 上供侧板 Script 区读取，这里是同一事实的启动轮落点；有界见
   * {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS}（超界整体缺席，侧板 Script 区随之缺席）。
   */
  script?: string;
  /** 设置轮才在场：这次 run 是用「配置」从哪个 run 修订来的、改了什么。 */
  amend?: WorkflowSettingsAmendMeta;
}

/** {@link WorkflowLaunchMeta.args} 的 JSON 序列化上界（字节）。超界即丢，换成一个标记键。 */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** {@link WorkflowLaunchMeta.description} 的字符上界。 */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * {@link WorkflowLaunchMeta.script} 的字符上界。工具路径的 `input.script` 本就不设界地进转写，
 * 这里取一个远大于任何合理 dwf 脚本、又能挡住误塞整份仓库的上限；超界整体缺席而非截断
 * （半截脚本对 Script 区没有意义，图仍在 display 里）。
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * args 超界时的替身键。真实实参永远走模型面的规范句（那份不截断），这里的元数据只喂启动卡；
 * 一个大到 4KB 的实参袋在卡上本就无从展示，所以整体替换成单条可读标记而不是硬塞。用省略号
 * 作键：它落在 `SAVED_WORKFLOW_NAME_PATTERN` 之外，不可能与真实实参名相撞。
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * 把启动轮元数据收进边界内。args 序列化后超 {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES} 即整体
 * 换成 `{ "…": "arguments omitted (N bytes)" }` 标记（见 {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY}）；
 * description 超 {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} 即截断加省略号。铸造侧就地调用，
 * 让 message metadata 与 TurnStarted payload 拿到同一份有界值。
 */
export function boundWorkflowLaunchMeta(input: WorkflowLaunchMeta): WorkflowLaunchMeta {
  const bounded: WorkflowLaunchMeta = {
    runId: input.runId,
    toolCallId: input.toolCallId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.args !== undefined) {
    const serialized = JSON.stringify(input.args);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    bounded.args =
      bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES
        ? { [WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY]: `arguments omitted (${bytes} bytes)` }
        : input.args;
  }
  if (input.description !== undefined) {
    bounded.description =
      input.description.length > WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS
        ? `${input.description.slice(0, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS - 1)}…`
        : input.description;
  }
  // display 已在构造处（createCreateWorkflowDisplay + boundCausalityGraph）限长，原样透传。
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // amend 块本身有界（两个模型串由调用方取自已解析的规范形，与 run 状态同一条上界）。
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

/**
 * TurnStarted 的公共载荷：这一轮用户输入的执行入口事实（输入文本、turn 号、身份与来源）。
 * 生产者：turn 入口在真正开始执行前铸造，与 user message 在同一事务窗口内落盘。
 * 消费者：reducer 的 TurnStarted handler（置 running、清 lastError、turnCount+1）、
 * v4 投影的 userInput row，以及冷恢复的重建逻辑。
 * 不变量：messageId 必须与持久 user message 同一 id，否则 checkpoint 无法按 turn 反查；
 * executionStartedAt 是执行入口的时刻，不能用事件发布时间反推。
 */
export interface TurnStartedPayloadBase {
  /** 执行入口的单调 epoch 毫秒；hooks/持久化发生在 TurnStarted 发布前，不能据发布时间反推执行开始。 */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 文件摘要按 turn rowId 发起 query，但 workspace checkpoint 以 user messageId
   * 为恢复锚点；TurnStarted 必须携带同一个持久 id，投影才能把 userInput row
   * 反查到对应 checkpoint。
   */
  messageId?: MessageId;
  inputId?: string;
  /** 仅 admission 透传给无正文 telemetry fact；不能从 session 归属反推。 */
  /** 同一 runtime command 内覆盖 primary turn → goal verify/continue 的稳定取消身份。 */
  // Stop 的 stale guard 按它比对：同一个 runtime command 内 verify/continue 复用同一个 id，
  // 不能从 sessionId/turnId 反推，否则跨轮 Stop 会误杀或漏杀。
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** 缺省为 agent，兼容旧事件与历史 transcript。 */
  executionKind?: TurnExecutionKind;
  /**
   * `input` 从此下标起是引擎附加文本（dwf ask 尾注 / nudge），GUI 把它折进披露；0 = 整条都是；
   * 缺席 = 无。与消息 metadata 里的同一份对齐（冷热同形）。
   */
  epilogueStart?: number;
  /** idle background wake 的结构化来源；active-loop 合流不会创建独立 TurnStarted。 */
  originMeta?: BackgroundResultOriginMeta;
  /** 仅当一个 background notification batch 的所有成员来源一致时透传；混合来源留空。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** 本轮用户输入的附件元信息（无附件时缺省）。 */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata；inputId 继续作为 sourceCommandId 兼容锚点。 */
  intent?: TurnInputIntentMetadata;
}

/**
 * 完整的 TurnStarted 载荷 = 公共部分 + 后台归因分支。
 * 之所以拆成交叉类型而不是把归因字段平铺，是为了让"自动化 / 离峰 / 无归因"三分支
 * 在类型层互斥：生产者只能同时满足一个分支，消费者可穷尽判别。
 */
export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

/**
 * 旧版/辅助的"收到用户输入"事件：只带文本与附件，用于兼容早期协议与入口审计。
 * 生产者：turn 入口（历史路径）；消费者：协议映射与审计，不参与投影状态重建。
 * 不变量：附件里可能含内联 content，仅用于即时消费，不保证可跨进程复原。
 */
export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

/**
 * steer 输入入队（含"编辑排队项"）的事实：排队身份、展示预览、投递语义与目标 turn。
 * 生产者：CommandInbox 的 admission；消费者：reducer 的 TurnSteerQueued handler 按
 * pendingInputId 做 upsert（编辑时保留原排队时间与数组位置）。
 * 不变量：pendingInputId 是幂等键；同 id 重发只能更新内容字段，不能把它当成新入场
 * 排到队尾，否则 runtime 冷重建后队列顺序会变。
 */
export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** 当前排队输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  /** 投递语义：queue=消费时切新 product turn；guide=内联当前轮。 */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

/**
 * 投递语义被"降级改写"的事实：请求 guide，但当前没有可用 tool batch，于是原地改投 queue。
 * 生产者：runtime 的 steer 投递判定；消费者：reducer 的 TurnSteerDeliveryChanged handler
 * 把新 intent 整包替换或只改写 admittedDelivery/fallbackReasonCode。
 * 不变量：投影必须从事件 payload 读投递语义，不得从旁路内存状态猜测，否则冷恢复会
 * 把 guide 误当成 queue（或反之）而切出多余 turn。
 */
export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** 已改投后的完整 intent；reducer/cold replay 不从旁路状态猜 delivery。 */
  intent?: TurnInputIntentMetadata;
}

/**
 * queue 重排事实：一次给出完整的目标顺序（orderedPendingInputIds）。
 * 生产者：v4 queue 的拖拽/编辑重排；消费者：reducer 按 id 重排已知项并回写 queuePosition。
 * 不变量：列表外的已知项必须原序追加到尾部（兼容并发新增/删除的旧快照），
 * 不能因为重排事件把未列出的输入丢掉或重复。
 */
export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

/**
 * sendQueuedNow 的原子提升状态机：queued → reserved → promoting（失败回滚也进事件流）。
 * 生产者：runtime 的原子提升路径；消费者：投影据 state 判断该输入是否已取得执行权，
 * 不再由本地猜测。reservationId 是这次提升的认领凭据，用于回滚与去重。
 * 不变量：状态只能沿事件推进；投影重放时不得因缺少本地 reservation 而把 promoting 降回 queued。
 */
export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

/**
 * queue 的自动排空开关：held 状态派生 heldQueueInputRequiresChoice 的授权位。
 * 生产者：v4 输入控制（用户切换/内部抢占）；消费者：投影与 runtime 决定 turn 结束后
 * 是否自动消费队列。
 * 不变量：这是会话级状态而非 turn 级，事件不带 turnId；重放后必须覆盖到最新一次取值。
 */
export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

/**
 * running 状态下后续输入的默认路由：queue（起新轮）或 guide（内联当前轮）。
 * 生产者：v4 输入控制设置；消费者：admission 决定后续提交的 delivery，投影展示当前模式。
 * 不变量：会话级设置，不带 turnId；新事件覆盖旧值，旧事件不得在重放末尾重新生效。
 */
export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

/**
 * 排队输入被 drain（真正投递给模型）的事实：哪些 pendingInputId 出队、注入了哪些 messageId。
 * 生产者：runtime 在消费队列时发射；消费者：reducer 的 TurnSteerDrained handler 只做出队。
 * 不变量：drainedInputs 自带文本与持久 messageId，投影不再依赖内存 queue 取文本
 * （查不到队列项就静默丢 user 行）；缺省 delivery 按 queue（每条一轮）处理。
 */
export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * drain 事实自带文本与持久 messageId，投影不再依赖
   * 内存 queue 状态取文本（查不到 queue item 就静默丢 user 行）。
   * delivery 决定切轮语义；缺省按 queue（每条一轮）。
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

/**
 * steer 被拒绝的事实：拒绝原因、期望/实际的 turn 身份与输入规模。
 * 生产者：admission（空输入、超长、无活跃 turn、turn 不匹配等）；
 * 消费者：协议/UI 给用户可操作提示，投影不改队列（被拒输入从未入队）。
 * 不变量：reason 是稳定枚举而非文案，判断流程不得依赖 message 文本。
 */
export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

/**
 * 排队输入被丢弃的事实：turn 取消/失败/会话恢复/用户手动移除/promoted 后从 queue 摘除。
 * 生产者：runtime 的队列生命周期；消费者：reducer 只做出队（不存在于队列的 id 是 no-op）。
 * 不变量：reason=promoted 时只摘 queue 投影，session_input 仍需保持 admitted 直到 user
 * message 原子 promotion 或重启后转 discarded，不能把"出队"当成"输入已失效"。
 */
export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed（v4 queue 单项删除）：用户显式从 queue 移除某项，区别于 turn 生命周期丢弃。
  // promoted：sendQueuedNow 已取得执行权，只从 queue 投影摘除；session_input 必须继续
  // 保持 admitted，直到 user message 原子 promotion（或重启后 discarded）。
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

/**
 * 排队输入已原子提升为持久 user message 的事实（pendingInputId → messageId / sourceCommandId）。
 * 生产者：promotion 事务在 session_input 与 user message/parts 落盘后发射；
 * 消费者：CommandInbox 据此安全解除 pin，投影据此把该输入从 pending 转为正式消息。
 * 不变量：messageId 必须与持久消息一致；重复重放同一 promotion 不得产生第二条消息。
 */
export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

/**
 * 一轮正常/可继续结束的事实：回复文本、token 用量、工具次数、耗时与结果类型。
 * 生产者：turn 循环收口时发射（用户取消也走这里，见 TurnResultType 的 cancelled）；
 * 消费者：reducer 的 TurnComplete handler 是**唯一**把 session 置回 idle 并累加
 * totalTokenCount 的地方，协议层据此结束本轮展示。
 * 不变量：tool_batch_complete 不能替代它置 idle；重复重放不得让 token 计数翻倍
 * （幂等由事件 id / turn 生命周期保证，而不是靠 payload 去重）。
 */
export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** 当前 query 已成功提交到 provider 可见持久历史的模型产物数量。 */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
  /** 内部抢占（如 sendQueuedNow）只终止当前 turn，不等价于用户手动 Stop 队列。 */
  preserveQueueAutoDrainOnCancel?: boolean;
}

/**
 * 一轮异常结束的事实：结构化错误 + 失败阶段，并带上后台结果消费标记。
 * 生产者：turn 循环的错误收口；消费者：reducer 的 TurnError handler 把 status 置 error，
 * 并把 type/code/message/detail/attribution 完整投影到 lastError（供重启后展示与遥测）。
 * 不变量：attribution 必须保留（provider/network 归因是 live 与 cold 的共同事实），
 * 且该错误只在本轮有效——下一次 TurnStarted 会清掉它，不得跨轮残留。
 */
export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** 当前 turn 是否消费过来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed?: boolean;
  /** 当前 turn 是否消费过来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed?: boolean;
}

/**
 * turn 结束的结果分类：成功、用户主动取消、以及四类到达上限/执行期错误。
 * 生产者：turn 循环按终止原因选择；消费者：协议/UI 的结束态文案与遥测分类。
 * 不变量：cancelled 是正常结束，必须复用 TurnComplete 上报而不是 TurnError，
 * 否则取消会被错误地投影成失败，下一次 TurnStarted 前用户会看到红色错误横幅。
 */
export type TurnResultType =
  | "success"
  // "cancelled": 用户主动中断（TurnCancelled）属于正常结束，复用 TurnComplete 上报而非 TurnError。
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

/**
 * 用户消息事实（文本 + 附件），用于在事件流里留下与持久 message 对应的轻量副本。
 * 生产者：turn 入口/promotion；消费者：冷恢复与协议映射，投影通常以持久 message 为准。
 * 不变量：正文是可读快照，不承载隐藏 metadata；附件 content 允许内联，不保证长期可复原。
 */
export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

/**
 * 助手消息事实（文本 + 本轮声明的 tool calls），供事件流与持久 message/parts 对齐。
 * 生产者：模型流收口/消息持久化后；消费者：协议映射与审计，投影的正文仍来自持久 message。
 * 不变量：toolCalls 的 id 必须与随后 ToolCallScheduled/Started 使用的一致，
 * 否则跨进程恢复时工具卡无法挂回助手消息。
 */
export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

/**
 * 助手消息点赞/点踩的更新事实：entityId 是被评价的消息，feedback 为三态（含清除）。
 * 生产者：v4 bridge 的 feedback 写入（同样经 event store 分配 seq 后落盘）；
 * 消费者：冷恢复重建评价状态，避免重启后已有点赞消失。
 * 不变量：null 表示显式清除，不能用 undefined 表达"没改过"；同一 entityId 后写覆盖前写。
 */
export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

/**
 * 单条消息的加速卡（highspeed）指标更新：entityId 指向消息，highspeed 是持久化契约快照。
 * 生产者：v4 bridge 在指标结算后追加事件；消费者：冷恢复后重新展示节省耗时/回退原因。
 * 不变量：payload 只含无凭据的统计字段（cardId/taskId 等），不得携带运行时凭据；
 * 同一 entityId 后写覆盖前写，旧事件仅作为审计历史保留。
 */
export interface HighspeedMetricsUpdatedPayload {
  entityId: string;
  highspeed: HighspeedMessageMetadata;
}

/**
 * 系统消息事实：init（会话初始化）、compact_boundary（压缩边界）、interrupted（中断提示）。
 * 生产者：会话初始化、压缩流程与中断收口；消费者：协议/UI 的时间线展示与冷恢复重建。
 * 不变量：type 是稳定枚举，展示文案由消费者本地化；compact_boundary 分支必须同时带
 * compactBoundary 快照，否则 UI 只有边界文案而无法画出上下文变化。
 */
export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

/**
 * 会话标题变更事实：旧标题、新标题与来源（自动生成/用户改名等）。
 * 生产者：标题生成器或用户命令；消费者：协议/UI 标题与会话列表，冷恢复据此回放最终标题。
 * 不变量：previousTitle 供生成器判断"是否被用户改过"，不用于回滚；messageID 是触发
 * 本次命名的消息锚点，缺失表示与具体消息无关（如手动改名）。
 */
export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

/**
 * 协作模式切换事实（plan/build/edit/yolo/guarded/auto），可同时携带 permissionGrant。
 * 生产者：模式命令、工具或系统切换；消费者：reducer 的 SessionModeChanged handler 更新
 * mode/planEnabled，并把 permissionGrant 命中的排队项 intent.mode 就地升级为 yolo。
 * 不变量：permissionGrant 是一次性批量放行凭据，必须与 queueItemIds 精确对齐——
 * 漏升级会让 runtime 冷重建后这些输入退回只读模式，用户授权形同失效。
 */
export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

/**
 * 目标完成校验的生命周期状态：started / completed / failed_closed / cancelled。
 * 生产者：goal verifier 的每次尝试；消费者：reducer 按 (targetId, goalIteration) 合并成
 * 一条时间线，而不是按 verificationId 追加。
 * 不变量：failed_closed / cancelled 表示没有 model_complete 结果，必须由事件本身补齐结论，
 * 否则冷恢复后这次校验会永远停在 started。
 */
export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

/**
 * 一次目标完成校验的尝试事实：目标、状态、单次 verificationId 与本轮迭代号。
 * 生产者：target-completion-verification 流程（started 之后按结果发 completed/failed）；
 * 消费者：reducer 的 TargetCompletionVerification handler、持久 timeline 分区、
 * 协议层的目标进度展示。
 * 不变量：goalIteration 是 UI 身份（同一 target + iteration 合并成一条横线），
 * verificationId 只是单次尝试；重试会产生新 verificationId 但沿用同一 iteration。
 * foregroundExecutionId 与触发校验的前台 command 共用，Stop 的 stale guard 靠它判定。
 */
export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** 与触发该验证的前台 runtime command 共用，供 Stop 做 stale guard。 */
  foregroundExecutionId?: string;
  /** sendQueuedNow 抢占 verifier 时只暂停 goal，不暂停 future queue。 */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

/**
 * 模型请求事实：这次要发给 provider 的完整消息、选型与采样参数。
 * 生产者：turn 循环在每次请求前发射；消费者：审计/调试、live sink 的 JSONL 落盘，
 * 以及重放时复原"当时发的是什么"。
 * 不变量：messages 是完整上下文快照，体积随轮次增长；内存 store 在 turn sealed 后会
 * 用 slimRetainedModelRequest 换成 messageCount，只保留计数（读者不读 messages 本身）。
 * querySource 标识请求用途：只有 main_turn 代表用户当前上下文，sidecar 请求不得覆盖它。
 */
export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 选型变更的来由：目前只有 registryFallback（registry 回退到可用模型）。
 * 生产者：模型解析逻辑；消费者：协议层区分"用户选择"与"系统回退"，避免把回退
 * 误显示成用户操作。
 * 不变量：闭集枚举，新增来源必须同时让旧客户端能安全忽略（缺失字段即普通选型）。
 */
export type ModelSelectionOrigin = "registryFallback";

/**
 * 模型选型变更事实：稀疏 Selection、实际应用的推理档位、上下文窗口与能力集合原子发布。
 * 生产者：选型命令/自动恢复；消费者：投影的当前模型、UI 的能力提示，冷恢复据此复原选型。
 * 不变量：previousModelSelection 缺失表示只更新当前选型，null 表示显式清除边界；
 * effectiveReasoningLevel/contextWindow 是执行事实，不属于稀疏 Selection 本身。
 */
export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Active Model 已解析出的 reasoning，仅供执行事实/展示投影，不属于稀疏 Selection。 */
  effectiveReasoningLevel?: string;
  /** 缺失表示只更新当前选型；null 表示显式 ∅→selection 模型边界。 */
  previousModelSelection?: ModelSelection | null;
  /** 只有 Agent 自动恢复模型时携带；缺失表示普通选型或旧事件。 */
  origin?: ModelSelectionOrigin;
  /** 当前 selection 对应的思考档位能力；与模型选型同事件原子发布。 */
  supportedThoughtLevels?: string[];
  /** 当前 selection 在 runtime 实际应用的上下文窗口；null 表示显式清除，字段缺失兼容旧事件。 */
  contextWindow?: number | null;
}

/**
 * 执行 Selection 退回会话 Selection 的原因，与 @zcode/shared 的 selectionFallback 规则同值域：
 * 卡过期由声明的 provider 错误码命中，其余任何加速请求失败归为 request_failed。
 */
export type TurnExecutionModelFallbackReason =
  | "highspeed_card_expired"
  | "highspeed_request_failed"
  | "highspeed_selection_unavailable";

/**
 * 本轮执行模型（加速卡）退回会话常驻选型的结算事实：from 是 execution 作用域选型，to 是会话选型。
 * 生产者：模型请求失败后的兜底路径；消费者：UI 作废对应加速卡、展示回退原因，遥测统计回退率。
 * 不变量：from/to 是稀疏 Selection 而非旧 ModelRef；reason 是稳定枚举，不得用错误文案判定。
 */
export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * Provider 重构后单轮执行模型统一用稀疏 Selection 表达（旧的 ModelRef 已删除）：
   * from 是本轮 execution 作用域的加速 Selection，to 是会话常驻 Selection。
   */
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
}

/**
 * 模型流的增量种类：start / text|reasoning|tool_input 三段式 / tool_call / finish / error。
 * 生产者：provider 流解析器逐 chunk 发射；消费者：投影只按它拼展示态，不据此写历史。
 * 不变量：这些是瞬态事件（见 TRANSIENT_SESSION_EVENT_TYPES），turn 结束后可被淘汰；
 * 完成态文本由持久消息重新合成，因此丢失 delta 不影响冷恢复正确性。
 */
export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

/**
 * 一条流式增量：delta 文本 + 种类 + 归属的 assistantMessageId/partId/toolCallId。
 * 生产者：模型流解析器（每次 text/reasoning/tool_input 片段一条）；
 * 消费者：live 投影与 TUI 的实时渲染，按 partId 追加而不重建消息。
 * 不变量：增量顺序只由信封 sequenceNumber 保证，payload 内没有序号；
 * 冷恢复不得依赖这些事件拼最终文本——那由持久 message/parts 承担。
 */
export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

/**
 * 模型网络状态事件的载荷别名，直接复用 model 包的 ModelNetworkStatusEvent。
 * 生产者：provider/adapter 的连接与重试观测；消费者：UI 的"等待/重试"提示与用量补充。
 * 不变量：它是瞬态事件，只进 live 投影；失败请求的 usage 会被
 * createModelUsageSummaryFromEvents 单独计入，成功请求由 ModelComplete 计入，避免双计。
 */
export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

/**
 * 模型异常告警的分类：工具调用预算耗尽、重复调用、finish 原因不匹配、畸形 tool call。
 * 生产者：turn 循环的异常观测器；消费者：UI 告警与遥测，以及"是否已注入提醒"的审计。
 * 不变量：分类是稳定枚举，新增类别不得让旧端把未知值当成致命错误。
 */
export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

/**
 * 告警严重度：info（仅提示）与 warning（可能影响后续行为）。
 * 生产者：异常观测器按阈值判定；消费者：UI 选择提示强度，遥测按级别聚合。
 */
export type ModelAnomalyWarningSeverity = "info" | "warning";

/**
 * 一条模型异常告警事实：类别/级别、观测计数与阈值，以及是否已给模型注入提醒。
 * 生产者：异常观测器；消费者：UI 告警条、遥测；warningInjected 关联被注入的模型可见消息。
 * 不变量：这是"已发生的事实"而不是待办指令，重放不得因此在恢复时重复注入提醒；
 * observedCount/threshold 是判定依据，缺失旧事件按 1 次观测处理。
 */
export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

/**
 * 一次网络请求的来源归类：统一 HTTP 客户端、模型、工具、MCP、插件或未知。
 * 生产者：统一请求入口在发请求前打标；消费者：网络状态面板与遥测按来源聚合。
 * 不变量：unknown 是显式兜底值，调用方不得为"省事"省略 source。
 */
export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

/**
 * 网络请求生命周期：pending → complete / error。
 * 生产者：统一请求入口在开始与结束时各发一条；消费者：面板按 requestId 配对耗时。
 * 不变量：同一 requestId 的 pending 与终态必须成对，重复终态不得把耗时覆盖成更小值。
 */
export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

/**
 * 单次外部请求的观测事实：requestId、来源、方法/URL、耗时、状态码与出网信息。
 * 生产者：统一 HTTP 入口（含模型 SSE 与工具/MCP/插件调用）；消费者：网络诊断面板与遥测。
 * 不变量：requestId 是配对键，attempt 表示同一逻辑请求的重试次数（不是新的 requestId）；
 * egress 只描述出口策略，不包含凭据；URL 需按脱敏规则产出，不得泄露查询串里的密钥。
 */
export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

/**
 * 一次模型补全完成的事实：正文、停止原因、token/缓存用量、上下文占比与文件改动摘要。
 * 生产者：provider 流收口；消费者：reducer 的 ModelComplete handler 更新 contextUsed
 * （仅 main_turn）、goal 校验摘要，并用 createModelUsageSummaryFromEvents 汇总用量。
 * 不变量：querySource 决定本次是否代表"用户当前上下文"——标题生成/压缩/子代理等
 * sidecar 请求绝不能覆盖主会话的 contextUsed，否则 UI 会显示 89/1m 这类误导值；
 * 旧事件缺 querySource 时只能靠 stopReason=tool_internal 排除，不能一律当主会话。
 */
export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** 当前模型请求组装出的完整 tool call 数量；旧事件可能缺失。 */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

/**
 * 一轮内的文件改动汇总：总增删行、涉及文件数与逐文件明细。
 * 生产者：工具执行器按 turn 累加写操作；消费者：UI 的改动摘要与 checkpoint 展示。
 * 不变量：items 的顺序即展示顺序；files 是去重后的文件数，不等于 items.length
 * （同一文件多次写入会合并成一条并累加 writeCount）。
 */
export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

/**
 * 单文件改动明细：增删行、路径、导致改动的工具名与写入次数。
 * 生产者：工具执行器在写入后累加；消费者：改动列表与 diff 入口。
 * 不变量：path 是工作区相对路径口径（由上层统一规范化），不得存绝对路径；
 * writeCount 记录多次写同一文件的次数，用于解释为何增删行与单次 diff 不一致。
 */
export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

/**
 * 上下文占用的来源分区：系统提示、元用户上下文、技能、工具提示、工具 schema、MCP schema、消息。
 * 生产者：上下文组装器在构造请求时统计；消费者：上下文占用明细面板。
 * 不变量：分区是闭集，新增来源必须同步 UI 的映射，否则该部分占用会显示成"未知"。
 */
export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

/**
 * 一个来源的字符数占用（chars 而非 token）：用于展示上下文被谁吃掉。
 * 生产者：上下文组装器；消费者：UI 明细条。
 * 不变量：不同来源的 chars 相加近似总量，但换算 token 只做展示估算，不能据此计费。
 */
export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

/**
 * 单次模型请求失败的事实：结构化错误与是否可重试。
 * 生产者：provider/adapter 的错误收口；消费者：重试决策、UI 错误提示与遥测。
 * 不变量：retryable 是本次失败的判定结果，重试预算耗尽后即使原错误可重试也必须为 false，
 * 不能让消费者自行按错误码重新推断。
 */
export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}

/**
 * 工具调用被调度的事实：调度器排出的执行计划（并行分组、依赖、展示投影与调度快照）。
 * 生产者：工具批次调度器；消费者：reducer 的 ToolCallScheduled handler 建一条 pending
 * ActiveToolCall，UI 据此提前画出"待执行"工具卡。
 * 不变量：toolCallId 必须与助手消息里声明的 id 一致；dependencies 只能引用同批次内
 * 已声明的 id，否则调度顺序在冷恢复时无法重建。
 */
export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

/**
 * 工具开始执行的事实：工具名、真实开始时刻与**解析后**的副作用能力。
 * 生产者：工具执行器在 handler 动手之前发射；消费者：reducer 把活跃工具置 running，
 * 并让订阅者在第一个字节落盘前就知道"这次要写了"（如 dwf 关闭 amend-resume 导入缓存）。
 * 不变量：startedAt 是执行起点（不取事件发布时间）；readOnly/sideEffectScope 是解析结果，
 * 不能由调用点按工具名重新猜测，且旧事件缺这两个字段时只能按未知处理。
 */
export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * 这次调用**解析后**的副作用能力（工具元数据 + 按入参解析的运行时能力，例如 Bash 的只读命令判定）。
   * 事件在 handler 动手之前发出，所以订阅者能在第一个字节落盘前知道「要写了」——dynamic-workflow 的
   * driver 据此关闭 amend-resume 的导入缓存（`isWorkspaceMutatingToolCall`）。可选：早于本字段的事件没有。
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

/**
 * 工具执行进度事实：耗时、MCP progress 三元组、进程 id 与输出字节/尾部预览。
 * 生产者：工具执行器按节拍发射（属瞬态事件，turn 结束后可淘汰）；
 * 消费者：live 投影/TUI 的工具卡进度，不参与冷恢复。
 * 不变量：进度是增量快照，缺字段表示本次没更新，不能当作"清零"；
 * stdout/stderr 尾部是有界预览，完整输出在落盘路径里。
 */
export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  /** MCP `notifications/progress`（A8）：progress / total / message 原样转发。 */
  progress?: number;
  total?: number;
  message?: string;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

/**
 * 工具返回的事实：结果体（success 表达业务成败）、耗时、展示投影与插件归属。
 * 生产者：工具执行器/命令执行器；消费者：reducer 把它置 completed 或 failed，
 * 协议层据此渲染结果卡。
 * 不变量：success=false 仍走本事件（模型还能继续），执行链异常才走 ToolCallError；
 * display 与持久 part 的投影同形，冷恢复后仍能画出同一张结果卡。
 */
export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata 仅用于 telemetry，不进入模型可见的 result.content。 */
  skillMetadata?: SkillTelemetryMetadata;
  /** 执行时 ToolEntry 的插件归属，不从工具名称推断。 */
  pluginId?: string;
}

/**
 * 工具执行链异常的事实：结构化错误（含中止/崩溃），与"业务失败"分开表达。
 * 生产者：工具执行器；消费者：reducer 只把该工具置 failed，**不写 lastError**
 * （工具失败不等于整轮失败），协议层展示错误卡。
 * 不变量：skillMetadata/pluginId 仅供遥测，不得混入模型可见的错误正文。
 */
export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata 仅用于 telemetry，不进入模型可见的错误正文。 */
  skillMetadata?: SkillTelemetryMetadata;
  /** 执行时 ToolEntry 的插件归属，不从工具名称推断。 */
  pluginId?: string;
}

/**
 * 工具批次收尾事实：本批次涉及的 toolCallIds 与成功/失败计数。
 * 生产者：批次执行器；消费者：reducer 只从 activeToolCalls 里清理本批次的工具。
 * 不变量：它**不是**轮次结束——批次之后 turn 还会发起 follow-up 模型请求，
 * session 必须保持 running，只有 TurnComplete 才能置 idle。
 */
export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

/**
 * 后台任务状态闭集：running、completed、failed、timed_out、cancelled、spawn_error、lost。
 * 生产者：后台任务追踪器（bash/subagent/workflow 共用）；消费者：面板分组与状态徽标。
 * 不变量：除 running 外都是终态；lost 表示追踪器失联（既非成功也非用户取消），
 * 不能折叠进 failed，否则统计会把环境问题算成任务失败。
 */
export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

/**
 * 后台任务的公共载荷：身份（taskId/toolCallId/childSessionId）、状态、命令、进程与输出引用。
 * 生产者：后台任务追踪器按 per-tool lifecycleProvider 分派后统一成形；
 * 消费者：reducer 的 backgroundTasks（按 taskId upsert）、UI 面板与冷恢复。
 * 不变量：taskId 是合并键；进度/完成事件是**部分快照**，缺失字段不得覆盖 started
 * 里的静态信息（command/pid/outputPath），否则 15 秒一次的进度会把它们抹掉。
 */
export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run（CreateWorkflow）。追踪器的行为已按 per-tool lifecycleProvider
  // 分派，taskKind 只决定面板分组与图标，所以加宽是纯展示修正，不改任何生命周期语义。
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

/**
 * 后台任务开始事实（status 固定 running），是任务生命周期的起点。
 * 生产者：任务启动器；消费者：reducer 的 applyBackgroundTaskStarted 以 taskId 为单位
 * **整条替换**——started 是新建/重置语义，不能合并旧记录。
 * 不变量：同 taskId 再次 started 只可能来自恢复/重放，替换后不得残留上一次运行的
 * completedAt/cancelRequestedAt 等终结字段。
 */
export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & {
  status: "running";
};

/**
 * 后台任务增量更新事实（带任意状态，通常 running）。
 * 生产者：追踪器的周期采样；消费者：reducer 的 applyBackgroundTaskUpdated 只做
 * "非 undefined 字段合并"，未知 taskId 不新增条目。
 * 不变量：更新不是创建——恢复顺序错乱时宁可不显示，也不能凭空造出半截任务。
 */
export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

/**
 * 后台任务终态事实（status 排除 running），带 completedAt 与最终输出摘要。
 * 生产者：追踪器在进程退出/任务结算时发射；消费者：reducer 的 applyBackgroundTaskCompleted
 * 先合并已有记录（保留 started 的静态字段），不存在则补建。
 * 不变量：补建是为了兼容"只看到完成事件"的截断数据；completedAt 缺失用事件时间兜底，
 * 但不得把终态改回 running。
 */
export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};

/**
 * 一条 workflow run 进度事件（父会话）。字段与 {@link DynamicWorkflowRunEvent} 同形——
 * **一次序列化、两个消费者**：`listEvents` 的事件页与这里的会话事件用同一个有界载荷，
 * 读端因此不需要两套解释规则。`type` 已被会话事件信封占用，故引擎事件种类叫 `eventType`。
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** 发起这次 run 的 CreateWorkflow 工具调用（工具卡 → 详情页的关联键）。 */
  toolCallId?: ToolCallId | string;
  /** journal sequence（`appendEvent` 单调分配）；事件日志的 cursor 与它同一把尺。 */
  sequence: number;
  /** 引擎事件种类：run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled。 */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** 派生字段（toProgressPayload）：`actor-created` 上该子代理会话的 id（driver 铸的 `sess_dwf-…`）。 */
  actorSessionId?: string;
  /**
   * 派生字段（与 `actorSessionId` 同类，见 toProgressPayload）：该 run 的 `run-launched.inputId`。
   * 只挂在 `actor-created` / `run-settled` 两种事件上，供下游把子代理归到发起 run 的那一轮。升级前的 run 没有 `run-launched`，字段缺席。
   */
  launchInputId?: string;
}

/**
 * 权限请求事实：待审批工具、风险级别、原因、原始入参、可选建议与 ask 预览。
 * 生产者：权限层在工具执行前发射；消费者：reducer 把完整快照放进 pendingPermissions，
 * 使冷启动后仍能重建弹窗，而不是只看到"有工具卡住"。
 * 不变量：toolCallId 是跨事件关联键；display 必须进 projection（冷恢复的弹窗仍需带图），
 * input 可能含敏感内容，只进本地投影，不得原样写入遥测。
 */
export interface PermissionRequestedPayload {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * 工具自报的确认预览，由 `prepareApproval` 钩子产出。复用结果通道的 display 投影，
   * 让 ask 与结果卡共享同一套有界形状，不新增无界字段。
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

// 订阅者以 (scopeId, generation) 标识沙箱实例；renderer 只投递给 generation 一致的实例。
// generation 在实例重建时递增：旧实例即使还持有 scopeId 也不该再收到资源更新。
/** 订阅者以 (scopeId, generation) 标识沙箱实例；renderer 只投递给 generation 一致的实例。 */
export interface PluginUiResourceSubscriberRef {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  scopeId: string;
  generation: number;
}
/**
 * 插件 MCP 资源已变化的通知：哪个 server 的哪个 uri 变了、要投给哪些沙箱实例。
 * 生产者：插件 MCP 资源订阅轮询；消费者：renderer 按 subscribers 逐个投递。
 * 不变量：只进 live 投影（v4Gateway.ingest，seq 0），**不落盘、不进冷恢复**——
 * 资源内容不属于会话事实，重启后由客户端重新订阅。
 */
export interface PluginUiResourceUpdatedPayload {
  pluginId: string;
  serverName: string;
  uri: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
/**
 * 插件 MCP 资源列表变化的通知：server 侧资源集合增删，需要刷新订阅方。
 * 生产者：插件 MCP 订阅；消费者：renderer 通知对应实例重新拉列表。
 * 不变量：同 PluginUiResourceUpdated 一样只进 live 投影，不落盘、不参与冷恢复。
 */
export interface PluginUiResourceListChangedPayload {
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
// cancelled=true 表示该调用在投递前已被调用方撤回，接收实例无需执行；
// activity 只是展示指示，不改变执行语义。callId 是实例侧回执的配对键。
/** App-Provided Tools：一次待执行的页面工具调用，投递给 subscribers 里唯一的实例。 */
export interface PluginUiAppToolCallRequestedPayload {
  activity?: boolean;
  cancelled?: boolean;
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * 权限已裁决的事实：决定（allow/deny/escalate/modify）、原因与可能改写后的入参。
 * 生产者：权限交互层（用户选择或策略自动判定）；消费者：reducer 按 toolCallId 清理
 * pendingPermissions 并同步工具状态（allow→completed、deny→denied）。
 * 不变量：必须按 toolCallId 而不是 requestId 清理——同一工具可能先后触发多次请求
 * （rewrite 重判），用 requestId 过滤会残留旧弹窗。
 */
export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

/**
 * 权限被系统直接拒绝的事实（无需用户交互，如策略/信任态不满足）。
 * 生产者：权限判定层；消费者：reducer 清理 pendingPermissions 并把工具置 denied。
 * 不变量：投影结果与 resolved(deny) 一致，保留独立类型只为区分"用户拒绝"与"系统拒绝"
 * 两种来源，审计与遥测不得把它们合并统计。
 */
export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

/**
 * 用户输入自动确认的状态机：hiddenGrace → visibleCountdown → 到点确认；或 snoozed 暂停。
 * 生产者：交互层的倒计时；消费者：TUI 渲染倒计时进度，runtime 到点后自动决议。
 * 不变量：所有时间戳都是绝对 epoch（startedAt/visibleAt/deadlineAt），跨进程恢复时
 * 用剩余时间续算，不能重新开始倒计时。
 */
export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

/**
 * 某个交互请求的自动确认状态更新：interactionId/toolCallId 定位，autoResolution 给新状态。
 * 生产者：自动确认计时器；消费者：TUI 倒计时展示，冷恢复据此判断是否仍在等待。
 * 不变量：interactionId 是合并键；同一交互的状态只能单向推进，snoozed 之后不得
 * 因重放旧事件而回到倒计时。
 */
export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

/**
 * workspace hook 需要人工复核的请求事实（载荷保持 unknown 以兼容 hook 侧结构演进）。
 * 生产者：workspace hook 执行器；消费者：UI 弹出复核面板，settled 事件收口。
 * 不变量：请求必须有稳定的 interactionId 才能与 settle/supersede 配对；
 * request 是外部结构，消费方须先做 schema 校验，不能直接信任。
 */
export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

/**
 * workspace hook 复核已结束的事实：resolved / timed_out / configuration_error 与原因码。
 * 生产者：复核交互的收口路径；消费者：UI 关闭面板，投影据此移除待复核项。
 * 不变量：这是终态，同一 interactionId 后续只允许 supersede，不得再次 settled。
 */
export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

/**
 * 旧复核请求被新请求取代的事实：旧 interactionId 让位给 supersededByInteractionId。
 * 生产者：新的 hook 复核到达时；消费者：UI 关闭旧面板并展示新请求，避免两个弹窗并存。
 * 不变量：被取代的请求按"已作废"处理，不能回落到 settled 语义（旧请求从未被用户裁决）。
 */
export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// 软门禁:准入层完成评估后上报 pending 状态。
// pendingCount = configuredEnabled && admissionClass === "pending" 的声明数;
// pendingCount === 0 → 投影层将 snapshot.workspaceHookAdmission 置 null(提示条消失)。
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

/**
 * 权限裁决的四种决定：允许、拒绝、升级为更高权限交互、改写入参后允许。
 * 生产者：权限交互层；消费者：reducer 的状态映射（allow→completed、deny→denied）、
 * 工具执行器（modify 使用 modifiedInput）。
 * 不变量：decision 是稳定枚举，新增取值必须同时更新 reducer 与执行器的 switch，
 * 不能让未知决定落到"默认允许"。
 */
export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

/**
 * 目标变更的动作：设置、状态更新、清除、用量记账、run 起止与摘要更新。
 * 生产者：目标命令、工具与 runtime；消费者：reducer 的 TargetChanged handler
 * （只有 action=set 且 targetID 变化时才清空历史校验记录）。
 * 不变量：同一目标的编辑必须保留已累计校验时间线，不能因为换了个 action 就重置。
 */
export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

/**
 * 目标变更的来源：命令、工具或 runtime 内部（如自动记账/结算）。
 * 生产者：三类调用点；消费者：UI 区分"用户显式设置"与"系统自动更新"。
 * 不变量：它只描述来由，不改变投影合并规则；重放时来源不参与幂等判定。
 */
export type TargetChangedSource = "command" | "tool" | "runtime";

/**
 * 目标（goal）变更事实：动作、来源、新目标与旧目标的完整快照。
 * 生产者：目标命令/工具/runtime 记账；消费者：reducer 更新 projection.target，
 * 并按 targetID 是否变化决定是否清空 targetCompletionVerifications/Timeline。
 * 不变量：payload.target 是完整快照而非 patch，重放同一事件必须得到同一目标状态；
 * previousTarget 缺失表示旧版本事件，不能据此推断"目标从无到有"。
 */
export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

// -----------------------------------------------
// Supporting Types
// -----------------------------------------------

/**
 * 用户输入的附件（事件流旧口径）：文件/图片/pdf/url，可携带路径或内联内容。
 * 生产者：turn 入口（历史路径）；消费者：协议映射与历史消息重建。
 * 不变量：content 是可选内联体，可能很大且含敏感内容；新路径请用 TurnAttachmentMeta
 * 只带展示元信息，不要在本类型继续扩展隐藏字段。
 */
export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

/**
 * 发给模型的一条消息（role + content + 可声明 toolCalls），是 ModelRequestPayload 的元素。
 * 生产者：turn 循环从持久 message/parts 拼装；消费者：provider adapter。
 * 不变量：这是模型可见投影，不含内部 metadata；toolCalls 的 id 必须与实际工具调用一致。
 */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

/**
 * 模型声明的一次工具调用（id / name / 原始 input），是助手消息与调度事件的关联载体。
 * 生产者：模型流解析器；消费者：调度器、ToolCallScheduled、持久 tool part。
 * 不变量：id 由模型给出且在本次响应内唯一，映射到本地 ToolCallId 后不得再改写。
 */
export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

/**
 * 工具结果体：业务成败、可读内容、展示投影、性能遥测与截断/落盘引用。
 * 生产者：工具执行器；消费者：ToolCallResult 事件、模型上下文与结果卡渲染。
 * 不变量：content 是模型可见正文；display/perf 只给 UI 与遥测，不得混入 content；
 * 超长结果必须走 artifactPath + 截断字段，不能把完整输出直接回灌上下文。
 */
export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: import("../tools/performance.js").ToolExecutionTelemetry;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

/**
 * 一次工具批次的调度快照：并行分组与最终执行顺序。
 * 生产者：工具批次调度器；消费者：调度事件携带、执行器按序执行、UI 展示并发关系。
 * 不变量：executionOrder 必须覆盖所有待执行 id 且与 parallelGroups 一致（同组可并行、
 * 组间串行），否则冷恢复时并发语义会与运行时不同。
 */
export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

/**
 * 旧口径的 token 用量（input/output/total 与可选 cache tokens），兼容早期事件与适配层。
 * 生产者：provider adapter；消费者：阈值判断与展示。
 * 不变量：totalTokens 通常等于 input+output，但缓存拆分口径因 provider 而异；
 * 需要精确上下文占用时应走 ModelUsage/getModelUsageContextTokens，而不是本类型。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

/**
 * 结构化错误体：type/code/message 为必需事实，detail/stack/data 为诊断补充，
 * attribution 承载可聚合的失败归因。
 * 生产者：各层错误归一化（provider/adapter/工具/runtime）；消费者：TurnError、
 * ModelError、ToolCallError、UI 与遥测。
 * 不变量：type 是稳定的错误类别（不是中文文案）；diagnostic 字段可能含敏感内容，
 * 只允许进受控调试路径，不得整体写入遥测或日志。
 */
export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** 错误链中最深的非 wrapper frame 的原始 message，供客户端 telemetry 定位根因。 */
  underlyingErrorMessage?: string;
  /** 同一底层 frame 的 detail/errorDetails/details 内容。 */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

// 消费者：遥测按 source/reason/errorPhase 聚合失败分布，UI 据此决定提示与重试入口。
/** 只承载可聚合的失败事实，不包含请求正文、凭据、URL 或监控策略。 */
export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
  /** string=使用该 Highspeed 卡，null=明确未使用，undefined=旧 Agent 未发布。 */
  highspeedCardId?: string | null;
  /**
   * true=本轮 Highspeed 创建期或请求期失败已命中退回声明，但所有退回目标都无法创建，整轮按真实错误
   * 结束。Renderer 据此作废匹配卡；不再按错误码推断，请求期 3402/网络失败的 code 是 provider 错误码。
   */
  highspeedFallbackUnavailable?: boolean;
}

// CollaborationMode and RiskLevel are re-exported from ports

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

/**
 * 事件工厂：铸造一条**尚未分配日志 cursor** 的信封（id/timestamp/traceId 在此生成）。
 * 生产者：core 的 createEvent 与少量外围写入方；消费者：appendEvent 会在落库时补齐
 * sequenceNumber，因此这里默认 0 表示"待分配"。
 * 不变量：调用方若显式传入 sequenceNumber，必须来自 event store 的当前游标 +1；
 * 自行编号会与 appendEvent 的单调分配冲突，导致增量重放漏事件。
 */
export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

/**
 * 从事件流汇总模型用量：成功请求取 ModelComplete，失败请求取 ModelNetworkStatus 的
 * model_request_failed 分支，避免同一次请求被计两遍。
 * 生产者：冷恢复/统计侧；消费者：会话用量展示与成本估算。
 * 不变量：只读取 usage，不改变事件；空流返回 undefined 表示"没有可汇总的用量"，
 * 不能当成 0 token 参与后续除法或均值计算。
 */
export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusEvent;
      // 成功请求由 ModelComplete 计入；只补充失败请求的已报告用量，避免双计。
      if (payload.type === "model_request_failed" && payload.usage) usages.push(payload.usage);
    }
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

/**
 * 所有事件 payload 的联合类型，用于跨模块（协议映射/持久化适配）按事件种类收敛类型。
 * 生产者：本文件的各 payload 定义；消费者：需要"任意事件载荷"签名的地方。
 * 不变量：它是纯类型联合，新增事件类型时必须同步加入，否则消费方会漏掉新事件
 * 的字段形状（而不是运行时出错，排查成本更高）。
 */
export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | TurnExecutionModelFallbackPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
