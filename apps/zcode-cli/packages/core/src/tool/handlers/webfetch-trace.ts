// WebFetch 的可观测性出口：网络请求状态事件 + 执行上下文 → TraceContext 投影。
//
// 两者都只做「搬运」不做决策：不生成新的 traceId，不改变 session/turn 归属，也不决定
// 事件是否落盘。缺少 emitter 或字段时以 no-op / 原样传递的方式降级，绝不让可观测性故障
// 反过来中断工具执行——审计缺失是运维问题，工具失败是用户问题，优先级不同。
import {
  SessionEventType,
  type NetworkRequestStatusPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

/**
 * 发出一条 NetworkRequestStatus 会话事件（pending / complete / error 三种 status 复用同一形状）。
 *
 * 输入：执行上下文（提供 emitEvent 与会话归属字段）与完整 payload（含 requestId、method、
 * URL、状态码、耗时、egress 等）。输出：Promise<void>，仅在事件被接收后 resolve。
 *
 * 降级语义：`emitEvent` 为可选依赖，未注入时整条事件静默丢弃，工具继续执行——网络审计
 * 是旁路，不是工具前置条件。注意 `id` 为随机 UUID、`sequenceNumber` 固定 0：序号由统一
 * 事件通道负责分配/补齐，本层不维护序号，避免与主事件流竞争。
 */
export async function emitNetworkRequestStatus(
  context: ToolExecutionContext,
  payload: NetworkRequestStatusPayload,
): Promise<void> {
  await context.emitEvent?.({
    id: crypto.randomUUID() as never,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.NetworkRequestStatus,
    timestamp: new Date(),
    traceId: context.traceId,
    sequenceNumber: 0,
    payload,
  });
}

/**
 * 把工具执行上下文投影成网络 adapter 需要的 TraceContext。
 *
 * 输出：traceId/spanId/parentSpanId 原样沿用，sessionId/turnId 一并带上，attributes 只加
 * toolCallId 与固定 toolName。不变量：绝不在这里新生成 id——一旦断开，adapter 侧的连接、
 * DNS、egress 日志就无法与这次 tool_call 归并，遥测会出现孤立 span。
 */
export function traceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
    },
  };
}
