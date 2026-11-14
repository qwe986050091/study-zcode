import type { ToolExecutionSpanWriter } from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

/**
 * 给单次工具调用套一层 telemetry span；没有 telemetry 端口时直接执行（零开销降级）。
 *
 * 输入：`execute` 接收 span writer（可为 undefined），业务侧负责所有**正常返回分支**的
 * finish；本函数只在业务抛出未被自己收口的异常时兜底。
 *
 * 兜底语义：`signal` 已中止 → `finishCancelled("abort_signal")`；否则
 * `finishFailed("unhandled","unknown",error)`，随后原样 rethrow，不改变错误链。
 *
 * 不变量：任何执行路径结束时 span 必须有终态，不能停在 missing_terminal；
 * 副作用仅限 telemetry 端口写入，工具结果本身不受影响。
 */
export async function runToolCallWithTelemetry(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  options: ToolExecuteOptions | undefined,
  execute: (telemetry: ToolExecutionSpanWriter | undefined) => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const scope = deps.agentTelemetry?.startTool({
    registeredToolName: toolCall.name,
    toolCallId: toolCall.id,
  });
  // 没有 agentTelemetry 端口：不包装、不吞错，直接执行。
  if (!scope) return execute(undefined);
  return scope.run(async () => {
    try {
      return await execute(scope);
    } catch (error) {
      // 业务执行器会在所有正常返回分支按事实收口；这里只负责连 ToolCallStarted/Error
      // 事件发布都直接抛出的非结构化异常，避免 Span 最终只能标记为 missing_terminal。
      // 注意：cancel 与 failed 必须区分——取消不是缺陷，不能污染失败归因统计。
      if (options?.signal?.aborted) {
        scope.finishCancelled("abort_signal");
      } else {
        scope.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}
