/**
 * ============================================================================
 * tool-result-settlement.ts —— 工具结果的"提交点"(执行完成 → 历史可配对)
 * ============================================================================
 *
 * 【为什么单独成文件】
 *   工具执行完成不等于历史成立:模型下一次请求必须能看到"每个 tool_call 都有
 *   对应 tool result"。本文件负责这个原子语义:
 *     1) 先把整批真实结果同步写入两份模型历史(live + turn-local);
 *     2) 再逐项做持久化收尾(part 更新、媒体附件、checkpoint、恢复锚点、ledger)。
 *
 * 【顺序约束】
 *   第 1 步必须在任何异步收尾之前完成(见下方根因注释):如果按项 await 后再追加结果,
 *   中途失败会留下"有 tool_call 无 result"的残缺历史。
 *
 * 【失败与取消】
 *   checkpoint 失败不阻断其他结果;若失败原因是用户取消,先完成所有兄弟结果的
 *   持久化,最后再把取消错误抛出,避免半途终止导致工具卡悬挂。
 * ============================================================================
 */
import { traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  PartId,
  ToolCall,
  ToolCallId,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import {
  createStreamRecoveryAnchorId,
  emitStreamRecoveryAnchor,
  emitStreamingToolLedgerUpdate,
  isErrorForToolResult,
  isTurnCancellationError,
  modelContentForToolResult,
  stringifyToolResultOutput,
} from "../helpers/index.js";
import { persistToolResultMediaAttachments } from "../helpers/tool-result-media-persistence.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { StreamedToolExecutionResult } from "../types.js";
import { createRuntimeToolResultEntry } from "../../agent/message-history.js";
import { recordBrowserTurnToolResult } from "../../repl/browser-turn-state.js";
import { completedToolPartMetadata, mcpToolPartMetadata } from "./tool-part-metadata.js";
import { projectToolNameForNonEmptyBoundary } from "./tool-part-persistence.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { emitNestedModelUsageEvents } from "./turn-nested-model-usage.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import { recordToolUsageFromResult } from "./turn-tool-usage.js";

export interface ToolResultPart {
  partID: PartId;
  declarationIndex: number;
  input: Record<string, unknown>;
  startedAt: number;
}

/**
 * 结算一批工具结果:写入历史、更新状态机、持久化 part、发恢复锚点与 ledger 事件。
 *
 * @param options.toolParts        每个 tool call 的持久化 part 信息(pending 时已创建)
 * @param options.streamedResultsById 流式期间提前执行的结果(用于标注 executionTiming)
 */
export async function settleToolResults(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    results: ToolExecutionResult[];
    toolParts: ReadonlyMap<string, ToolResultPart>;
    toolCallById: ReadonlyMap<string, ToolCall>;
    streamedResultsById: ReadonlyMap<ToolCallId, StreamedToolExecutionResult>;
  },
): Promise<void> {
  const { results, toolParts, toolCallById, streamedResultsById } = options;
  // 根因：工具调用已进入历史，但旧逻辑在异步保存之后逐项加入结果；中途失败会
  // 留下缺失结果的调用。整批真实结果必须在任何异步收尾之前同步进入两份模型历史。
  // 这只保证当前进程历史完整，恢复锚点仍以各项持久化成功为前提。
  // 维护不变量#1:每个 tool_call 必须有配对结果;commitTurnRequestEntries 把整批结果
  // 原子写入 turn-local 历史,避免部分结果丢失导致 tool_call 悬空。
  commitTurnRequestEntries(
    this,
    state.turnRequestState,
    results.map((result) =>
      createRuntimeToolResultEntry(
        result.toolCallId,
        result.toolName,
        modelContentForToolResult(result),
        isErrorForToolResult(result),
        toolCallById.get(result.toolCallId)?.modelCallWrapper,
      ),
    ),
  );
  // 浏览器 turn 状态:记录本次工具结果,供 browser turn 的后续截图/恢复使用(非阻塞)。
  for (const result of results) {
    recordBrowserTurnToolResult({
      output: result.output,
      sessionId: this.sessionId,
      toolName: result.toolName,
      turnId: state.turnId,
    });
  }
  // 嵌套模型调用(例如工具内部又调用了模型)产生的 usage 事件,在这里统一补发。
  await emitNestedModelUsageEvents(this, {
    events: state.events,
    results,
    traceContext: options.modelTraceContext,
  });
  // turn 状态机逐项标记工具完成,最后聚合为"工具批次完成"状态。
  for (const toolResult of results) {
    const resultContent = toolResult.success
      ? modelContentForToolResult(toolResult)
      : (toolResult.error?.message ?? stringifyToolResultOutput(toolResult));
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.completeTool(toolResult.toolCallId as ToolCallId, {
        success: toolResult.success,
        content: resultContent,
      }),
    );
  }
  state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  this.logger?.debug("Tools executed", {
    resultCount: results.length,
    results: results.map((r) => ({
      toolName: r.toolName,
      success: r.success,
      output: typeof r.output === "string" ? r.output.substring(0, 50) : "[object]",
    })),
  });

  this.logger?.debug("Injecting tool results", { resultCount: results.length });
  let deferredCheckpointCancellation: unknown;
  // 逐项持久化收尾:part 状态、媒体附件、checkpoint、恢复锚点、ledger、后续输入。
  for (const result of results) {
    // 工具自身消耗(如嵌套模型调用)先记用量,再处理结果持久化。
    await recordToolUsageFromResult(this, result, options.modelTraceContext);
    const content = stringifyToolResultOutput(result);
    const projectedResultToolName = projectToolNameForNonEmptyBoundary(result.toolName);
    const persisted = toolParts.get(result.toolCallId);
    if (persisted) {
      // 成功结果先尝试把媒体输出转成附件(图片等),失败不影响主结果;
      // 随后把 part 从 running/pending 更新为 completed/error 终态。
      // completed 记录 output/attachments/时间;error 记录 error 文案与 modelContent,
      // 保证 cold hydration 能精确重放模型当时收到的内容。
      // 维护不变量#1:ToolPart 不能停在 pending/running;persistPart 把每个 tool part
      // 推进到终态(completed/error),冷恢复时不会看到"永远在跑"的工具卡。
      const mediaPersistence = result.success
        ? await persistToolResultMediaAttachments({
            artifactStore: this.artifactStore,
            assistantMessageId: options.assistantMessageId,
            content: modelContentForToolResult(result),
            sessionId: this.sessionId,
            sessionStore: this.sessionStore,
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            traceContext: options.modelTraceContext,
            turnId: state.turnId,
          })
        : undefined;
      await this.persistPart(
        {
          id: persisted.partID,
          sessionID: this.sessionId,
          messageID: options.assistantMessageId,
          type: "tool",
          callID: result.toolCallId,
          declarationIndex: persisted.declarationIndex,
          tool: projectedResultToolName.toolName,
          metadata: {
            ...projectedResultToolName.metadata,
            ...(toolCallById.get(result.toolCallId)?.modelCallWrapper
              ? { modelCallWrapper: toolCallById.get(result.toolCallId)?.modelCallWrapper }
              : {}),
          },
          state: result.success
            ? {
                status: "completed",
                input: persisted.input,
                output: content,
                title: projectedResultToolName.toolName,
                metadata: {
                  ...completedToolPartMetadata(result),
                  ...(mediaPersistence
                    ? { modelContentLayout: mediaPersistence.modelContentLayout }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
                ...(mediaPersistence ? { attachments: mediaPersistence.attachments } : {}),
              }
            : {
                status: "error",
                input: persisted.input,
                error: result.error?.message ?? content,
                // 修复原因：state.error 面向 UI / 日志，可能比模型实际收到的
                // modelContent 更笼统；仅附加保存 string 内容供冷恢复精确重放。
                metadata: {
                  ...mcpToolPartMetadata(
                    this.registry.getMetadata(result.toolName)?.mcpPresentation,
                  ),
                  ...(typeof result.modelContent === "string"
                    ? { modelContent: result.modelContent }
                    : {}),
                },
                time: {
                  start: result.startedAt.getTime(),
                  end: result.completedAt.getTime(),
                },
              },
        },
        options.modelTraceContext,
      );
    }
    this.logger?.debug("addToolResult", {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      success: result.success,
      contentLength: content.length,
    });
    try {
      // 修复原因：checkpoint 是 tool result 闭合后的附加操作。Stop 若在这里
      // 触发，必须先完成所有 sibling 的持久化收尾，不能提前进入 reminder flush。
      await this.emitFileMutationCheckpoint({
        abortSignal: state.turnAbortSignal,
        events: state.events,
        messageId: state.userMessageId,
        result,
        toolMessageId: options.assistantMessageId,
        traceContext: options.modelTraceContext,
      });
    } catch (error) {
      if (!isTurnCancellationError(error, state.turnAbortSignal)) throw error;
      deferredCheckpointCancellation ??= error;
      continue;
    }
    const toolCall = toolCallById.get(result.toolCallId as ToolCallId);
    if (toolCall) {
      // 恢复锚点:标记"该工具结果已提交",供流恢复/冷恢复判断从哪继续;
      // ledger 事件记录最终状态与执行时机(during_stream / end_of_stream)。
      // 维护不变量#2:已提交的工具结果是恢复锚点,流恢复不会重放它之后的内容;
      // 锚点事件先于重试请求发出,保证 UI 与恢复链路看到一致的"提交边界"。
      const resultPartId = persisted?.partID;
      const recoveryAnchorId = createStreamRecoveryAnchorId(
        options.assistantMessageId,
        result.toolCallId as ToolCallId,
      );
      await emitStreamRecoveryAnchor(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCallId: result.toolCallId as ToolCallId,
        toolName: projectedResultToolName.toolName,
        success: result.success,
        resultPartId,
        committedAt: result.completedAt,
      });
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_result_committed",
        executionTiming: streamedResultsById.has(result.toolCallId as ToolCallId)
          ? "during_stream"
          : "end_of_stream",
        input: persisted?.input,
        startedAt: result.startedAt,
        committedAt: result.completedAt,
        resultPartId,
        recoveryAnchorId,
      });
    }
    await enqueueFollowUpUserInputFromToolResult.call(
      this,
      state,
      result,
      options.modelTraceContext,
    );
  }

  if (deferredCheckpointCancellation) {
    throw deferredCheckpointCancellation;
  }
}

/**
 * 工具结果携带"后续用户输入"(例如 ExitPlanMode 的审批反馈)时,把它作为 guide 注入:
 *   - 排队成功 → 等当前 turn 的合法边界消费(见 turn-guide-drain);
 *   - 被拒绝 → 记录 warn,不能静默吞掉(否则审批反馈会丢失)。
 */
async function enqueueFollowUpUserInputFromToolResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  result: ToolExecutionResult,
  traceContext: TraceContext,
): Promise<void> {
  const followUp = result.followUpUserInput;
  if (!followUp) return;

  const input = followUp.input.trim();
  if (!input) return;

  const steerResult = await this.steerTurn({
    delivery: "guide",
    expectedTurnId: state.activeTurn?.turnId,
    input,
    source: followUp.reasonSource,
    traceContext,
  });

  if (steerResult.kind === "queued") {
    this.logger?.debug("Queued follow-up user input from tool result", {
      ...traceContextToLogContext(traceContext),
      event: "tool.follow_up_user_input.queued",
      module: "core.runtime",
      pendingInputId: steerResult.pendingInputId,
      reasonSource: followUp.reasonSource,
      status: "waiting",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
    });
    return;
  }

  // 修复原因：ExitPlanMode 审批反馈必须升级成真实 user message；
  // 如果这里被拒绝，说明 active turn 状态异常或输入超过 steer 限制，不能静默吞掉。
  this.logger?.warn("Failed to queue follow-up user input from tool result", {
    ...traceContextToLogContext(traceContext),
    activeTurnId: steerResult.activeTurnId,
    event: "tool.follow_up_user_input.rejected",
    module: "core.runtime",
    reason: steerResult.reason,
    reasonSource: followUp.reasonSource,
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}
