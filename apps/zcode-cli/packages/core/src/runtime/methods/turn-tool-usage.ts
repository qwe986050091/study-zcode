/**
 * ============================================================================
 * turn-tool-usage.ts —— 工具执行完成后的"终态"用量事实
 * ============================================================================
 *
 * 【与 usage-observability.recordToolUsageFromEvent 的关系】
 *   那个函数消费的是事件流（可能只有 scheduled/progress 等中间态）；
 *   本函数消费的是 ToolExecutionResult 终态对象，字段更完整（durationMs、
 *   performance.detail、serialization.truncated）。
 *   两者都 upsert 同一个 `usage_tool_${sessionId}_${toolCallId}` 主键，
 *   因此后写者补齐字段，不会产生两行。
 *
 * 【为什么单独走一条路径】
 *   result 路径拿得到 serialization.returnedBytes（真正回灌模型的大小）
 *   与 command exitCode，这两项是分析"输出截断成本/命令失败率"的关键；
 *   事件 payload 里只有部分字段。
 *
 * 【失败策略】任何写入失败只记 warn：观测失败绝不能阻断工具结果持久化
 *   与模型续跑（见 catch 内的根因注释）。
 */
import type { ToolExecutionResult, TraceContext } from "../deps.js";
import type { UsageStorePort } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

/** 记录一次工具执行的用量事实(状态、时长、输出字节、截断、取消、错误类型等)。 */
export async function recordToolUsageFromResult(
  runtime: AgentRuntimeInternal,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const metadata = runtime.registry.get(result.toolName)?.metadata;
  const outputBytes = outputSizeBytes(result);
  const errorType = result.error?.type;

  try {
    await usageStore.upsertToolUsage({
      id: toolUsageId(runtime.sessionId, result.toolCallId),
      sessionID: runtime.sessionId,
      turnID: traceContext.turnId,
      traceID: traceContext.traceId,
      toolCallID: result.toolCallId,
      toolName: result.toolName,
      sideEffectScope: metadata?.sideEffectScope,
      readOnly: metadata?.readOnly,
      destructive: metadata?.destructive,
      approvalStatus: "none",
      status: result.success ? "completed" : "error",
      startedAt: result.startedAt.getTime(),
      firstOutputAt: result.completedAt.getTime(),
      completedAt: result.completedAt.getTime(),
      durationMs: result.durationMs,
      exitCode:
        result.performance?.detail?.kind === "command"
          ? result.performance.detail.command.exitCode
          : undefined,
      timeToFirstOutputMs: result.completedAt.getTime() - result.startedAt.getTime(),
      outputBytes,
      truncated: result.serialization?.truncated,
      retryCount: 0,
      retryable: false,
      cancelledByUser: errorType?.includes("cancel") ?? false,
      errorType,
      errorMessage: result.error?.message,
    });
  } catch (error) {
    // 结果路径的 SQLite Usage 写入没有旁路保护，磁盘/锁异常会阻断后续
    // Tool Result 持久化与模型续跑；观测失败绝不能改变 Agent 业务语义。
    runtime.logger?.warn("Usage tool fact write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.tool.write.failed",
      module: "core.runtime",
      status: "failed",
      toolCallId: result.toolCallId,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    });
  }
}

function usageStoreFor(runtime: AgentRuntimeInternal): UsageStorePort | undefined {
  const candidate = runtime.sessionStore as Partial<UsageStorePort> | undefined;
  return candidate?.recordModelUsage &&
    candidate.upsertTurnUsage &&
    candidate.upsertToolUsage &&
    candidate.pruneUsage
    ? (candidate as UsageStorePort)
    : undefined;
}

function toolUsageId(sessionId: string, toolCallId: string): string {
  return `usage_tool_${sessionId}_${toolCallId}`;
}

/**
 * 回灌模型的输出体积。
 *
 * 优先 serialization.returnedBytes（截断/artifact 化之后的真实大小）；
 * 没有序列化信息时，若 output 是字符串则按 UTF-8 字节计（不能用 .length，
 * 中文/emoji 会少算，导致体积统计偏差）；其它形态无法可靠计量，返回 undefined
 * 而不是编一个 0。
 */
function outputSizeBytes(result: ToolExecutionResult): number | undefined {
  if (result.serialization) return result.serialization.returnedBytes;
  if (typeof result.output === "string") {
    return new TextEncoder().encode(result.output).length;
  }
  return undefined;
}
