/**
 * ============================================================================
 * runtime/methods/model-streaming-event.ts —— 模型流式事件的统一发射口
 * ============================================================================
 *
 * 链路 1（模型请求与流式恢复）里所有 ModelStreaming 事件都从这里出去：
 * createEvent 统一补齐 session/trace 字段，appendEvent 负责 durable 投影事实，
 * events 数组则回传给调用方，用于同轮内的可见内容投影。
 *
 * 顺序是刻意的：先 append 再 push。events 只能是"已经进了 event store"的事件，
 * 否则 append 失败时内存里会多出一条从未持久化的事件（投影与 store 分叉）。
 * ============================================================================
 */
import { SessionEventType } from "../deps.js";
import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export async function emitModelStreamingEvent(
  this: AgentRuntimeInternal,
  payload: ModelStreamingPayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  // payload 由调用方按流式事件契约组装，本层不做字段裁剪或改写：
  // 同一条事件若在两处被改写，重放与实时两边的口径就会漂移。
  const event = this.createEvent(SessionEventType.ModelStreaming, payload, traceContext);
  // 先落 event store 再进事件数组：appendEvent 失败会直接抛给上层，
  // 此时数组里不能提前出现"以为已持久化"的事件（durable 与内存态分叉）。
  await this.appendEvent(event, traceContext);
  events.push(event);
}
