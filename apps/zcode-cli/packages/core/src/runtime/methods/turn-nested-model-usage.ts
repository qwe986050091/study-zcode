/**
 * ============================================================================
 * turn-nested-model-usage.ts —— 工具内部模型调用的用量补报
 * ============================================================================
 *
 * 【问题】某些工具（WebSearch、子代理、工作流）会在工具内部再调一次模型，
 *   这部分 token 不包含在主请求的 provider usage 里。若不补报，费用与
 *   上下文统计会系统性偏低。
 *
 * 【做法】从工具 output.modelUsage 提取消耗，合成一条
 *   ModelComplete(stopReason="tool_internal", querySource 缺省) 事件，
 *   追加到本 turn 的事件流。缺省 querySource 很重要：event-reducer 的
 *   shouldModelCompleteUpdateContextUsed 会因此拒绝用它覆盖主会话的 contextUsed
 *   （旧数据兼容分支按 stopReason=tool_internal 判断）。
 *
 * 【副作用】appendEvent 会持久化该事件，所以补报是"一次性的"：
 *   冷恢复重放事件流时不会再重复补报，也不会重复计费。
 */
import { SessionEventType } from "../deps.js";
import type { ModelUsage, ToolExecutionResult, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/** 遍历工具结果,为带有 modelUsage 的结果补发 ModelComplete(工具内部调用)事件。 */
export async function emitNestedModelUsageEvents(
  runtime: AgentRuntimeInternal,
  input: {
    events: RegularTurnLoopState["events"];
    results: ToolExecutionResult[];
    traceContext: TraceContext;
  },
): Promise<void> {
  for (const result of input.results) {
    const usage = extractNestedModelUsage(result.output);
    if (!usage) continue;

    const event = runtime.createEvent(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "tool_internal",
        usage,
        toolCallCount: 0,
      },
      input.traceContext,
    );
    await runtime.appendEvent(event, input.traceContext);
    input.events.push(event);
  }
}

/**
 * 从工具 output 里提取 modelUsage。
 *
 * 这是跨模块的弱契约：工具 output 是 unknown（可能是字符串、artifact 引用），
 * 因此必须逐层 isRecord 校验；字段缺失就留 undefined，不填 0——
 * 0 与"没上报"在成本统计里语义完全不同。
 * serverToolUse（webFetch/webSearch 次数）只在存在时透传，供服务端计费对账。
 */
function extractNestedModelUsage(output: unknown): ModelUsage | undefined {
  if (!isRecord(output) || !isRecord(output.modelUsage)) return undefined;
  const serverToolUse = isRecord(output.modelUsage.serverToolUse)
    ? {
        webFetchRequests: numberProperty(output.modelUsage.serverToolUse, "webFetchRequests"),
        webSearchRequests: numberProperty(output.modelUsage.serverToolUse, "webSearchRequests"),
      }
    : undefined;

  return {
    inputTokens: numberProperty(output.modelUsage, "inputTokens"),
    outputTokens: numberProperty(output.modelUsage, "outputTokens"),
    totalTokens: numberProperty(output.modelUsage, "totalTokens"),
    cacheReadTokens: numberProperty(output.modelUsage, "cacheReadTokens"),
    cacheWriteTokens: numberProperty(output.modelUsage, "cacheWriteTokens"),
    reasoningTokens: numberProperty(output.modelUsage, "reasoningTokens"),
    ...(serverToolUse ? { serverToolUse } : {}),
  };
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
