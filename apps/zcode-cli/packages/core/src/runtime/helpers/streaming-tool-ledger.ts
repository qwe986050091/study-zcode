/**
 * ============================================================================
 * runtime/helpers/streaming-tool-ledger.ts —— 流式工具账本与恢复锚点的唯一发射器
 * ============================================================================
 *
 * 【定位】把"某个 toolCall 在流式阶段走到哪一步"写成 durable 事件：
 *   StreamingToolLedgerUpdated（逐状态 upsert）与 StreamRecoveryAnchorCreated
 *   （"从这里开始可以安全重放"的锚点）。两者同时 appendEvent 落库并 push 进本 turn 的
 *   events，供 usage/诊断与终态处理读取。
 *
 * 【状态机】tool_input_streaming → tool_call_closed → tool_queued → tool_started
 *   → tool_result_committed；异常收口为 tool_cancelled（用户取消）或
 *   tool_abandoned（放弃/未执行），恢复被拒时记 recovery_blocked。
 *   投影按 (attemptId, toolCallId) upsert，同一次模型重试会产生新 attempt，
 *   旧记录不会被新 attempt 覆盖（见 contracts 的 applyStreamingToolLedgerUpdate）。
 *
 * 【不变量 1】"每个 tool_call 必须有配对结果"依赖本文件的终态：进入账本的 call
 *   必须最终落到 committed / cancelled / abandoned 之一，否则冷恢复会看到停在
 *   started 的悬空工具。
 * 【不变量 2】attemptId 只能由 assistantMessageId 推导（一次模型响应 = 一个 attempt），
 *   不允许调用方自造，保证重试/恢复能按 attempt 精确分组。
 * 【口径提醒】契约枚举里的 tool_input_streaming 当前 core 侧没有发射点：实际可见的
 *   首个状态是 tool_call_closed；读代码时不要假设存在"输入流式"阶段的事件。
 * ============================================================================
 */
import { SessionEventType } from "../deps.js";
import type {
  MessageId,
  ModelToolSideEffectScope,
  PartId,
  SessionEvent,
  StreamRecoveryAnchorPayload,
  StreamingToolExecutionTiming,
  StreamingToolLedgerPayload,
  StreamingToolLedgerStatus,
  ToolCall,
  ToolCallId,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const END_OF_STREAM_ATTEMPT_SUFFIX = "end-of-stream";
const TOOL_RESULT_ANCHOR_SUFFIX = "tool-result";
const DEFAULT_EXECUTION_TIMING: StreamingToolExecutionTiming = "end_of_stream";

/**
 * 从 registry 读取并写进账本的工具元数据（工具契约的一部分，供流恢复判定
 * "这个调用有没有副作用/能不能提前执行"）。
 * 字段口径：
 *   - readOnly：只有 metadata.readOnly 为真**且** sideEffectScope === "none" 才为 true；
 *     缺省 undefined 表示"未知"，调用方必须按保守处理（不能当只读）。
 *   - destructive：是否破坏性操作（写入/删除），用于恢复期禁止重放。
 *   - concurrentSafe：是否可与同批其他工具并发。
 *   - sideEffectScope：副作用范围；优先取 permission 声明（权限口径更权威），
 *     再退回 metadata，保证权限收紧时账本跟着收紧。
 */
interface LedgerToolMetadata {
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

/**
 * 一次账本更新的输入。字段均为可选增量（payload 是快照式 upsert，未提供的字段
 * 在投影里保留旧值）：
 *   - assistantMessageId：attempt 的唯一来源，决定 attemptId。
 *   - toolCall：至少需要 id 与 name（name 用于取元数据）。
 *   - status：目标状态；发 tool_result_committed 时必须同时给 committedAt。
 *   - input：工具入参快照，供 UI 在未执行时也能展示。
 *   - startedAt/committedAt：执行区间；committedAt 是"结果已提交"的时间。
 *   - resultPartId：对应的 tool part；冷恢复据此定位 durable 结果。
 *   - recoveryAnchorId：本次结果写入的恢复锚点 id，便于二者关联。
 *   - blockedReason：仅 recovery_blocked 使用，说明为什么不能恢复。
 *   - executionTiming：during_stream / end_of_stream，缺省按 end_of_stream。
 */
interface EmitLedgerUpdateOptions {
  assistantMessageId: MessageId;
  toolCall: ToolCall;
  status: StreamingToolLedgerStatus;
  input?: Record<string, unknown>;
  startedAt?: Date;
  committedAt?: Date;
  resultPartId?: PartId;
  recoveryAnchorId?: string;
  blockedReason?: string;
  executionTiming?: StreamingToolExecutionTiming;
}

/**
 * 恢复锚点输入。锚点代表"该工具结果已提交，失败后可从这里继续"：
 *   - assistantMessageId + toolCallId：共同决定 anchorId。
 *   - toolName：展示与日志用，同时供恢复选择锚点时匹配。
 *   - success：true → kind=tool_result，false → kind=tool_error。
 *   - resultPartId：指向 durable tool part，冷恢复据此读取结果。
 *   - committedAt：提交时间，作为恢复选择"最新锚点"的排序依据。
 */
interface EmitRecoveryAnchorOptions {
  assistantMessageId: MessageId;
  toolCallId: ToolCallId;
  toolName: string;
  success: boolean;
  resultPartId?: PartId;
  committedAt: Date;
}

/**
 * 生成一次流式尝试的 attemptId：`<assistantMessageId>:end-of-stream`。
 * 一次模型响应只对应一个 attempt；后缀固定是为了让冷恢复能识别旧格式。
 * 纯函数，无副作用；调用方不得自行拼接 attemptId。
 */
export function createStreamingToolAttemptId(assistantMessageId: MessageId): string {
  return `${assistantMessageId}:${END_OF_STREAM_ATTEMPT_SUFFIX}`;
}

/**
 * 生成恢复锚点 id：`<assistantMessageId>:<toolCallId>:tool-result`。
 * 同一工具重复提交会得到同一 id，锚点事件因此是幂等覆盖而非无限增长。
 */
export function createStreamRecoveryAnchorId(
  assistantMessageId: MessageId,
  toolCallId: ToolCallId,
): string {
  return `${assistantMessageId}:${toolCallId}:${TOOL_RESULT_ANCHOR_SUFFIX}`;
}

/**
 * 发射一条流式工具账本更新事件。
 *
 * 输入：runtime（提供 createEvent/appendEvent 与 registry）、本 turn 的 events 数组、
 *   traceContext、options。
 * 输出：新建的 SessionEvent（已 appendEvent 并 push 进 events）。
 * 副作用：durable 写入（appendEvent）+ 内存数组追加；元数据来自 registry 快照，
 *   因此 registry 缺失该工具时 readOnly 等字段为 undefined（调用方按保守处理）。
 * 失败语义：appendEvent 抛错直接向上冒泡——账本事件是恢复前提，不能吞。
 */
export async function emitStreamingToolLedgerUpdate(
  runtime: AgentRuntimeInternal,
  events: SessionEvent[],
  traceContext: TraceContext,
  options: EmitLedgerUpdateOptions,
): Promise<SessionEvent> {
  const payload: StreamingToolLedgerPayload = {
    ...getLedgerToolMetadata(runtime, options.toolCall.name),
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    assistantMessageId: options.assistantMessageId,
    toolCallId: options.toolCall.id as ToolCallId,
    toolName: options.toolCall.name,
    status: options.status,
    executionTiming: options.executionTiming ?? DEFAULT_EXECUTION_TIMING,
    input: options.input,
    startedAt: options.startedAt,
    committedAt: options.committedAt,
    resultPartId: options.resultPartId,
    recoveryAnchorId: options.recoveryAnchorId,
    blockedReason: options.blockedReason,
  };
  const event = runtime.createEvent(
    SessionEventType.StreamingToolLedgerUpdated,
    payload,
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
  return event;
}

/**
 * 发射恢复锚点事件：标记"该工具结果已提交，可从这里安全重放"。
 *
 * 输入：runtime/events/traceContext + options；anchorId 由 messageId + toolCallId 推导。
 * 输出：已落库并 push 进 events 的事件对象。
 * 副作用：durable 写入 + 内存追加；同一锚点重复创建时投影只保留最新一个
 *   （见 applyStreamRecoveryAnchorCreated），不会累积历史。
 * 失败语义：appendEvent/parse 失败向上抛；本函数不做去重或补偿。
 */
export async function emitStreamRecoveryAnchor(
  runtime: AgentRuntimeInternal,
  events: SessionEvent[],
  traceContext: TraceContext,
  options: EmitRecoveryAnchorOptions,
): Promise<SessionEvent> {
  const anchorId = createStreamRecoveryAnchorId(options.assistantMessageId, options.toolCallId);
  const payload: StreamRecoveryAnchorPayload = {
    anchorId,
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    kind: options.success ? "tool_result" : "tool_error",
    assistantMessageId: options.assistantMessageId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    resultPartId: options.resultPartId,
    committedToolCallIds: [options.toolCallId],
    committedAt: options.committedAt,
  };
  const event = runtime.createEvent(
    SessionEventType.StreamRecoveryAnchorCreated,
    payload,
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
  return event;
}

/**
 * 读取工具元数据快照并收敛 readOnly 口径。
 *
 * 输入：runtime、工具名（可为空名或未注册名）。输出：4 个可选字段，缺失即 undefined。
 * 判定原因：只有"声明只读"且"副作用范围为 none"才算真正只读——声明漏写
 * sideEffectScope 时按未知处理，避免流式提前执行把有副作用的工具当成只读。
 * 副作用：只读 registry，不修改注册信息。
 */
function getLedgerToolMetadata(
  runtime: AgentRuntimeInternal,
  toolName: string,
): LedgerToolMetadata {
  const entry = runtime.registry.get(toolName);
  const metadata = entry?.metadata;
  const sideEffectScope = entry?.permission?.sideEffectScope ?? metadata?.sideEffectScope;
  return {
    readOnly:
      metadata?.readOnly === undefined
        ? undefined
        : metadata.readOnly && sideEffectScope === "none",
    destructive: metadata?.destructive,
    concurrentSafe: metadata?.concurrentSafe,
    sideEffectScope,
  };
}
