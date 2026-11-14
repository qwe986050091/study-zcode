// ============================================================
// WebSearch 的 trace 上下文适配
// ============================================================
// WebSearch 的模型请求走的是 tool handler → ModelInvocationContext，而 TraceContext 的类型
// 不带工具身份。这里把 executor 交来的执行上下文投影成 TraceContext，并补上 `toolCallId` /
// `toolName` 两个 attribute——遥测侧靠它们把这次搜索请求归到具体的 tool call 上。
//
// 无失败语义：纯映射，字段缺席（如未设 spanId）就原样缺席，绝不伪造新 id——伪造会让调用链
// 断开，比缺失更难排查。

import type { TraceContext } from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";

// 常量而非字面量：trace attribute 与工具注册名必须逐字一致，改一处就得两处一起改。
const WEBSEARCH_TOOL_NAME = "WebSearch";

/**
 * 把工具执行上下文投影成模型请求的 TraceContext。
 *
 * 输入口径：所有 id 字段原样透传（traceId/spanId/parentSpanId/sessionId/turnId），不生成、
 * 不覆盖；`attributes` 只加工具维度，不携带用户输入或 query 内容（避免敏感内容进 trace）。
 * 输出只被 `runWithModelInvocationContext` 消费；无副作用，失败即类型错误而非运行时降级。
 */
export function webSearchTraceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      toolCallId: context.toolCallId,
      toolName: WEBSEARCH_TOOL_NAME,
    },
  };
}
