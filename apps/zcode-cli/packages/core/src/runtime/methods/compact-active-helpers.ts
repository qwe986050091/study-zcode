/**
 * ============================================================================
 * runtime/methods/compact-active-helpers.ts —— compact 摘要的阶段辅助
 * ============================================================================
 * 【定位】链路 4：compact-active 调摘要模型前后的边界归一化层（错误分类 / 请求拼装 / 摘要校验 / 事件双写）。
 * 【输入/输出】输入 provider 结果、待摘要条目与 compact prompt；输出统一错误、请求消息、摘要文本与 timeline 事件。
 * 【关键口径】摘要阶段不允许未配对工具调用（不变量 #1）；超窗终态 retryable=false，防止外层把
 *             已完成的截断重试再次放大；timeline/摘要消息的口径必须与冷恢复一致（链路 4/5）。
 * ============================================================================
 */
import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
} from "../deps.js";
import type { CompactTimelinePayload, SessionEvent, SessionEventType, TraceContext } from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON =
  "compaction agent should only produce text summary";

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  // 把 compact 内部"截断后仍超窗"归一为 ModelContextExceeded：外层据此降输入或终止，
  // 而不是当作普通模型错误重试（防止 compact 重试预算被外层放大）。
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
    {
      cause: options.cause instanceof Error ? options.cause : undefined,
      context: {
        compactPromptTooLongAttempts: options.attempt,
        preCompactTokenCount: options.preCompactTokenCount,
      },
      recoverable: true,
      // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
      // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
      retryable: false,
    },
  );
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // 只有 provider 明确超窗、或 compact 空 length 才归一为超窗；其余 finishReason 交回上层
  // 按普通失败处理，避免把所有 length/异常都误判成上下文压力。
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  // 先写 durable timeline part，再写投影事件：冷恢复读的是 store，顺序保证事件永不早于事实（链路 5）。
  await runtime.persistCompactTimeline(payload, traceContext);
  // 事件同时追加到本次操作的事件列表，供上层在同一 turn 内转发给客户端。
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  // 摘要请求复用 provider 消息组装：写入 cache control 但 skipCacheWrite，
  // 避免一次临时摘要请求污染后续正常回合的 provider cache 读命中。
  return buildProviderRequestMessages({
    entries: [
      ...entriesForSummary,
      { message: { role: "user" as const, content: compactPrompt } },
    ],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  // compact 代理只允许纯文本摘要：出现 toolCalls 一律拒绝，避免摘要阶段产生
  // 无法配对结果的工具调用（不变量 #1）。
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  // 空摘要不可用于替换历史；retryable=true 让 compact 循环有机会重新请求。
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}
