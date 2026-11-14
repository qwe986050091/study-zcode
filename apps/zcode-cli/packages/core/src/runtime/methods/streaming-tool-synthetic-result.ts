import { SessionEventType, createPartId } from "../deps.js";
import type {
  ModelToolCall,
  SessionEvent,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import { toRecordInput } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";

const STREAM_RECOVERY_TOOL_ERROR_TYPE = "stream_recovery_interrupted_tool";

const TOOL_NOT_EXECUTED_MESSAGE =
  "Tool execution was interrupted during streaming recovery before this tool was executed. Treat this tool call as failed and do not retry blindly.";

const TOOL_STATE_UNKNOWN_MESSAGE =
  "Tool execution was interrupted during streaming recovery before a result was committed. Side effects may be unknown; inspect current state before retrying.";

type SyntheticStreamedToolReason = "not_executed" | "unknown_execution_state";

export function createSyntheticStreamedToolResult(
  toolCall: ModelToolCall,
  reason: SyntheticStreamedToolReason,
): StreamedToolExecutionResult {
  const now = new Date();
  // reason 二选一决定给模型的语义:
  //   not_executed → 工具从未被调度执行(准入失败/不安全/流结束前未到齐),
  //     提示模型"当成失败处理,不要盲目重试";
  //   unknown_execution_state → 已启动提前执行但中断时未拿到终态,副作用可能已发生,
  //     提示模型"重试前先检查当前状态"。
  // 失败处理:纯同步构造,不抛错;success=false 让 settlement 走 error 分支落库。
  // 维护不变量#1:每个 tool_call 必须有配对结果,ToolPart 不能停在 pending/running——
  // synthetic 结果是取消/恢复路径上为"无真实结果"的 call 兜底的唯一配对。
  const message =
    reason === "not_executed" ? TOOL_NOT_EXECUTED_MESSAGE : TOOL_STATE_UNKNOWN_MESSAGE;
  const result: ToolExecutionResult = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    modelContent: message,
    error: {
      type: STREAM_RECOVERY_TOOL_ERROR_TYPE,
      message,
    },
    durationMs: 0,
    startedAt: now,
    completedAt: now,
  };

  return {
    input: toRecordInput(toolCall.input),
    ledgerRecorded: false,
    partID: createPartId(),
    result,
    toolCallId: toolCall.id as ToolCallId,
  };
}

export async function emitSyntheticStreamedToolError(
  runtime: AgentRuntimeInternal,
  events: SessionEvent[],
  traceContext: TraceContext,
  result: ToolExecutionResult,
): Promise<void> {
  // 无 error 就不发:ToolCallError 事件必须只对应真实失败的工具。
  // 失败处理:appendEvent 失败会抛出——事件落库失败不能让 UI 以为工具成功。
  // events.push 紧跟 appendEvent:保证返回的事件数组与持久化一致,供 turn 收尾汇总。
  if (!result.error) return;
  const event = runtime.createEvent(
    SessionEventType.ToolCallError,
    {
      toolCallId: result.toolCallId as ToolCallId,
      error: result.error,
    },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}
