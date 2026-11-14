import type { MessageId, PartId, ToolCallId } from "../interfaces/shared.js";
import type { ModelToolSideEffectScope } from "../model/index.js";

/**
 * 工具执行的时机：end_of_stream（流结束后随批次执行）与 during_stream（流进行中提前执行）。
 * 生产者：流式工具协调器决定是否提前执行安全工具；消费者：账本与 UI 区分
 * "已开跑"与"仅声明未执行"两种状态。
 * 不变量：提前执行只允许安全工具；该字段记录执行事实，恢复重试不会把它改写回
 * end_of_stream，否则账本无法解释为何该工具已有副作用。
 */
export type StreamingToolExecutionTiming = "end_of_stream" | "during_stream";

/**
 * 流式工具账本的状态机：tool_input_streaming → tool_call_closed → tool_queued →
 * tool_started → tool_result_committed；终止分支为 tool_cancelled / tool_abandoned /
 * recovery_blocked。
 * 生产者：协调器（提前执行/放弃）与 executor（提交结果）在每次迁移时发账本事件；
 * 消费者：投影的 streamingToolLedger 与 UI 工具卡——只有 committed 才代表有真实结果。
 * 不变量：状态只前进；恢复重试**不会**把旧 attempt 的行改写成新 attempt 的状态，
 * 旧行以 cancelled/abandoned 结算，新 attempt 另起一行（同一 toolCallId 允许两行）。
 */
export type StreamingToolLedgerStatus =
  | "tool_input_streaming"
  | "tool_call_closed"
  | "tool_queued"
  | "tool_started"
  | "tool_result_committed"
  | "tool_cancelled"
  | "tool_abandoned"
  | "recovery_blocked";

/**
 * 恢复锚点的种类：上一条已提交助手消息、已提交工具结果、工具错误、工具取消。
 * 生产者：锚点选择逻辑（有已结算工具就用最后一个工具锚点，否则用上一条消息锚点）；
 * 消费者：恢复流程决定从哪重开流，UI 展示"从 A 恢复到 B"。
 * 不变量：只有已持久提交的事实才能当锚点；tool_cancelled 也合法，因为工具已结算进
 * 历史，从这里续跑不会重复副作用；绝不能用未提交的 streaming tail 当锚点。
 */
export type StreamRecoveryAnchorKind =
  | "assistant_message"
  | "tool_result"
  | "tool_error"
  | "tool_cancelled";

/**
 * stream recovery 作废半截 assistant 输出时写在 transcript 上的标记。
 * 它只是一段被丢弃的 tail，不是本轮失败：压缩/fork 边界靠 error 字段把半截输出隔离，
 * 冷恢复与子会话终态判定必须把它当非终态跳过，和 live 投影一致。
 * 消费者：v4 投影据此把失败行标 interrupted，并用新的 assistant identity 打开新行，
 * 避免 UI 看起来像一次连续完整输出。
 */
export const STREAM_RECOVERY_DISCARDED_ERROR_NAME = "StreamRecoveryDiscarded";
export const STREAM_RECOVERY_DISCARDED_FINISH = "stream_recovery_discarded";

/**
 * 恢复失败的粗分类：provider 超时 / 网络错误 / 流错误 / 整轮失败 / 未知。
 * 生产者：沿错误链（含 cause）的分类器；消费者：UI 的重试原因码与遥测聚合。
 * 不变量：分类只服务展示与统计，是否值得重试由独立的可重试判定决定，
 * 不能用 failureKind 反推重试策略。
 */
export type StreamRecoveryFailureKind =
  | "provider_timeout"
  | "provider_network_error"
  | "provider_stream_error"
  | "provider_turn_failed"
  | "unknown";

/**
 * 账本条目：每次状态迁移一条事件，payload 是 (attemptId, toolCallId) 二元组的增量快照。
 * 生产者：协调器（提前执行/放弃：cancelled 或 abandoned）与 executor（提交结果）；
 * 消费者：applyStreamingToolLedgerUpdate 按二元组 upsert，冷恢复据此得到每个 attempt 的终态。
 * 不变量：同一二元组后写覆盖前写；**不能**只按 toolCallId 合并——重试会产生新 attempt，
 * 同一 toolCallId 在旧 attempt 里可能已结算为 not_executed，新 attempt 又要重新执行，
 * 单键合并会让旧记录被覆盖，流恢复时分不清两次尝试。
 * readOnly/destructive/sideEffectScope 是解析后的能力快照，不是工具声明的原件。
 */
export interface StreamingToolLedgerPayload {
  attemptId: string;
  assistantMessageId: MessageId;
  toolCallId: ToolCallId;
  toolName: string;
  status: StreamingToolLedgerStatus;
  executionTiming: StreamingToolExecutionTiming;
  input?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  startedAt?: Date;
  committedAt?: Date;
  resultPartId?: PartId;
  recoveryAnchorId?: string;
  blockedReason?: string;
}

/**
 * 一个"已提交"的恢复锚点：锚点身份、所属 attempt、类型与被提交工具 id 列表。
 * 生产者：emitStreamRecoveryAnchor 在工具结果/错误落盘之后发射；
 * 消费者：applyStreamRecoveryAnchorCreated 只保留最近一个（projection.lastStreamRecoveryAnchor）。
 * 不变量：锚点指向的 assistant/tool part 必须已经持久化，否则重放会指向不存在的事实；
 * 旧锚点被覆盖是设计选择——最新锚点才是可安全重放点，历史仍可从事件流里查，
 * 因此覆盖不得伴随着删除历史事件。
 */
export interface StreamRecoveryAnchorPayload {
  anchorId: string;
  attemptId: string;
  kind: StreamRecoveryAnchorKind;
  assistantMessageId?: MessageId;
  toolCallId?: ToolCallId;
  toolName?: string;
  resultPartId?: PartId;
  committedToolCallIds: ToolCallId[];
  committedAt: Date;
}

/**
 * 开始一次流恢复的事实：失败类型/原文、失败请求 id 与本次重试进度（retryNumber / maxRetries）。
 * 生产者：core 的 beginStreamRecoveryAttempt + emitStreamRecoveryStarted；
 * 消费者：v4 投影的 apiRetry 状态、UI 的"正在恢复流"提示。
 * 不变量：retryNumber 从 1 开始、受 maxRetries 预算约束；attemptId 标识同一次恢复尝试，
 * 与随后 AnchorSelected/TailDiscarded/RetryStarted 共用，UI 靠它把三连事件对齐。
 */
export interface StreamRecoveryStartedPayload {
  attemptId: string;
  assistantMessageId?: MessageId;
  failedRequestId?: string;
  failureKind: StreamRecoveryFailureKind;
  message: string;
  retryNumber: number;
  maxRetries: number;
}

/**
 * 恢复锚点选择结果：选了哪个 anchorId、为什么选它、以及该锚点已提交的工具集合。
 * 生产者：recoverFromModelFailure 的锚点选择；消费者：恢复流程与 UI 解释恢复点。
 * 不变量：reason 三值对应两种恢复对象——有已提交工具结果取最后一个（latest_committed_tool_result），
 * 否则退回上一条消息（latest_committed_message），完全无工具提交时是 no_tool_committed；
 * committedToolCallIds 是账本口径，决定哪些工具可复用、哪些要重新执行。
 */
export interface StreamRecoveryAnchorSelectedPayload {
  attemptId: string;
  anchorId: string;
  reason: "latest_committed_tool_result" | "latest_committed_message" | "no_tool_committed";
  committedToolCallIds: ToolCallId[];
}

/**
 * 丢弃未提交 tail 的事实：丢弃的正文/推理字节数与被作废的 toolCallIds。
 * 生产者：recoverFromModelFailure / emitStreamRecoveryRetryEvents；
 * 消费者：v4 投影把失败行标 interrupted、把仍处于 inputStreaming 的工具行标 cancelled，
 * 并用新的 assistant identity 打开新行。
 * 不变量：字节数按 UTF-8 计，用于向用户解释"内容去哪了"；这些内容不会进入历史，
 * 因此重放不得尝试恢复它们，只能依据持久 message/parts。
 */
export interface StreamRecoveryTailDiscardedPayload {
  attemptId: string;
  anchorId: string;
  assistantMessageId?: MessageId;
  discardedTextBytes: number;
  discardedReasoningBytes: number;
  discardedToolCallIds: ToolCallId[];
}

/**
 * 真正发起恢复请求的事实：锚点、来源失败请求、重试进度与传输模式（当前固定 sse）。
 * 生产者：emitStreamRecoveryRetryEvents；消费者：apiRetry 状态与下一次 model_request
 * 的 recoveredFromRequestId 标记（后者写在 runtime 的 pendingStreamRecoveryRequest 上）。
 * 不变量：它必须与同批 AnchorSelected/TailDiscarded 共用 attemptId/anchorId；
 * 恢复请求是**新请求**而不是 adapter 的同请求重试，因此请求身份必须显式挂接。
 */
export interface StreamRecoveryRetryStartedPayload {
  attemptId: string;
  anchorId: string;
  failedRequestId?: string;
  retryNumber: number;
  maxRetries: number;
  streamMode: "sse";
}

/**
 * 恢复被阻断的事实：有副作用正在跑（running_side_effect）、副作用未知（unknown_side_effect）
 * 或失败本身不可重试（non_retryable_failure）。
 * 生产者：恢复判定（工具协调器/错误分类）；消费者：UI 给出明确失败原因，遥测统计阻断类型。
 * 不变量：只要有副作用可能已发生，就不能重开流——重复执行会带来真实副作用；
 * 阻断是终态而不是"再试一次"，消费方不得据此自动重试。
 */
export interface StreamRecoveryBlockedPayload {
  attemptId: string;
  toolCallId?: ToolCallId;
  toolName?: string;
  reason: "running_side_effect" | "unknown_side_effect" | "non_retryable_failure";
  message: string;
}

/**
 * 账本条目的投影形态 = 账本 payload + updatedAt（最近一次账本事件时间）。
 * 生产者：applyStreamingToolLedgerUpdate；消费者：SessionProjection.streamingToolLedger
 * 的读者（UI/恢复判定）。
 * 不变量：updatedAt 来自信封 timestamp 而非业务时间；条目本身仍以
 * (attemptId, toolCallId) 为身份，投影不得把它压成单键。
 */
export interface StreamingToolLedgerProjectionInfo {
  attemptId: string;
  assistantMessageId: MessageId;
  toolCallId: ToolCallId;
  toolName: string;
  status: StreamingToolLedgerStatus;
  executionTiming: StreamingToolExecutionTiming;
  input?: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  startedAt?: Date;
  committedAt?: Date;
  resultPartId?: PartId;
  recoveryAnchorId?: string;
  blockedReason?: string;
  updatedAt: Date;
}

/**
 * 锚点的投影形态 = 锚点 payload + updatedAt；对应 projection.lastStreamRecoveryAnchor。
 * 生产者：applyStreamRecoveryAnchorCreated；消费者：恢复流程读取"最新可重放点"。
 * 不变量：投影里只留最近一个锚点（历史在事件流里），updatedAt 用于判断锚点新旧，
 * 不得用 committedAt 替代它做排序——它才是投影可见的事实时间。
 */
export interface StreamRecoveryAnchorProjectionInfo {
  anchorId: string;
  attemptId: string;
  kind: StreamRecoveryAnchorKind;
  assistantMessageId?: MessageId;
  toolCallId?: ToolCallId;
  toolName?: string;
  resultPartId?: PartId;
  committedToolCallIds: ToolCallId[];
  committedAt: Date;
  updatedAt: Date;
}
