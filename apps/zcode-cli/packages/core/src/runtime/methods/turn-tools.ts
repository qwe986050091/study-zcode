/**
 * ============================================================================
 * turn-tools.ts —— 单次模型步之后的"工具批次"执行编排
 * ============================================================================
 *
 * 【调用链】
 *   turn-model-step.ts(有可执行工具时)
 *     └─ executeToolCallsForModelStep(本文件)
 *          ├─ 为每个 tool call 落 pending part + ledger 事件
 *          ├─ scheduleTools(按只读/并发/副作用分组)
 *          ├─ executeTools(ToolExecutor 执行,边跑边发 batch 事件)
 *          ├─ 合并"流式期间已执行"与"流结束后执行"的结果
 *          ├─ settleToolResults(把结果写回 part/历史,生成模型可见 tool result)
 *          └─ 返回 "continue"(下一轮请求)或 "break"(工具要求结束 turn)
 *
 * 【两个特殊控制】
 *   - turnControl.stopTurnAfterResult:某些工具(如创建定时任务达到上限)返回后
 *     整个 turn 立即收口,不再让模型继续调用工具;
 *   - automation create limit:命中后本 turn 降级为纯文本,跳过后续工具执行与提醒注入。
 * ============================================================================
 */
import type { ToolSearchExecutionContext } from "@zcode/contracts";
import { createPartId, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolExecutionResult,
} from "../deps.js";
import { emitStreamingToolLedgerUpdate, toRecordInput } from "../helpers/index.js";
import type { RuntimeModelTextResult, StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitSyntheticStreamedToolError } from "./streaming-tool-synthetic-result.js";
import {
  persistPendingToolPart,
  projectToolNameForNonEmptyBoundary,
} from "./tool-part-persistence.js";
import { persistToolModelStepFinish } from "./turn-step-finish.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { handleToolCallAnomalyWarnings } from "./turn-tool-warnings.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordCompletedToolBatch,
} from "./turn-loop-state.js";
import type { ToolCallInput } from "../../agent/message-history.js";
import { settleToolResults, type ToolResultPart } from "./tool-result-settlement.js";

/**
 * 执行一次模型步产出的全部工具调用,并把结果写回历史。
 *
 * 返回 "continue" 表示工具结果已就绪,主循环应带着结果发起下一次模型请求;
 * 返回 "break" 表示某个工具通过 turnControl 要求结束本 turn。
 *
 * 关键点:
 *   - 流式期间已执行的只读工具不会重复执行,直接复用其结果;
 *   - 未在流式期间执行的工具在这里统一调度/执行;
 *   - 结果必须为每个 tool call 都有一条(含取消/失败),否则历史配对不完整。
 */
export async function executeToolCallsForModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    toolSearch?: ToolSearchExecutionContext;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
    streamedToolResults?: StreamedToolExecutionResult[];
    toolCalls: ToolCallInput[];
  },
): Promise<"continue" | "break"> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed tool execution requires the loop Model");
  }
  const coreToolCalls: ToolCall[] = options.toolCalls.map((tc) => ({
    id: tc.id as ToolCallId,
    // Model step admission 已完成类型/ID 校验；这里保留可恢复的原始空白名称，
    // 让 executor 强制走 registry miss，而不是把 storage 占位值当成真实工具。
    name: tc.name,
    input: tc.input,
    ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
  }));
  // 流式期间已执行的工具结果(按 toolCallId 索引):这些不会再进入 executeTools。
  const streamedResultsById = new Map(
    (options.streamedToolResults ?? []).map((entry) => [entry.toolCallId, entry]),
  );
  const toolCallById = new Map(coreToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  // 每个 tool call 的持久化 part 信息(partID/声明序号/输入/开始时间),
  // 后续 settlement 与 running 状态更新都依赖它。
  const toolParts = new Map<string, ToolResultPart>();
  // 第一遍:为每个工具建立 durable pending part 与 ledger 事件。
  // 流式期间已执行的工具会复用其 partID;若 coordinator 未记录 ledger,这里补齐。
  for (const [declarationIndex, toolCall] of coreToolCalls.entries()) {
    const streamed = streamedResultsById.get(toolCall.id as ToolCallId);
    if (streamed) {
      // 流式期间已执行:复用它的 partID/输入/开始时间;若协调器没来得及记录 ledger,
      // 这里补 pending part、tool_call_closed 与 synthetic 错误,保持和普通执行同一生命周期。
      toolParts.set(toolCall.id, {
        declarationIndex,
        partID: streamed.partID,
        input: streamed.input,
        startedAt: streamed.result.startedAt.getTime(),
      });
      if (streamed.ledgerRecorded === false) {
        await persistPendingToolPart(this, {
          assistantMessageId: options.assistantMessageId,
          declarationIndex,
          input: streamed.input,
          partID: streamed.partID,
          toolCall,
          traceContext: options.modelTraceContext,
          model,
          metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        });
        await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
          assistantMessageId: options.assistantMessageId,
          toolCall,
          status: "tool_call_closed",
          executionTiming: "during_stream",
          input: streamed.input,
        });
        await emitSyntheticStreamedToolError(
          this,
          state.events,
          options.modelTraceContext,
          streamed.result,
        );
      }
      continue;
    }
    const partID = createPartId();
    // 未流式执行:归一化输入(模型可能给出非对象/含多态字段),生成新的 partID,
    // 先写 pending part,再发 tool_call_closed,保证 UI 在排队阶段就能看到工具卡。
    // 维护不变量#1:每个 tool_call 必须先有 pending part 才能执行;
    // persistPendingToolPart 失败会抛出,此时工具未启动,不会留下"已执行无 part"的悬空状态。
    const normalizedInput = toRecordInput(toolCall.input);
    toolParts.set(toolCall.id, {
      declarationIndex,
      partID,
      input: normalizedInput,
      startedAt: Date.now(),
    });
    await persistPendingToolPart(this, {
      assistantMessageId: options.assistantMessageId,
      declarationIndex,
      input: normalizedInput,
      partID,
      toolCall,
      traceContext: options.modelTraceContext,
      model,
      metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
    });
    await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
      assistantMessageId: options.assistantMessageId,
      toolCall,
      status: "tool_call_closed",
      input: normalizedInput,
    });
  }

  // assistant tool_use 已经进入 history 后，Stop 不能在 tool result
  // 创建前直接抛出。继续把 aborted signal 交给 executor，由现有取消路径为
  // 每个 tool call 生成 ToolCancelled result，再由 turn loop 感知 abort。
  // 调度:按工具声明的 readOnly/concurrentSafe/sideEffectScope 生成并行分组与执行顺序。
  // 调度只决定"能并行谁",不执行任何工具。
  const schedule = await this.scheduleTools(coreToolCalls);
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.scheduleTools(coreToolCalls, this.toScheduleState(schedule)),
  );
  // 只对"未在流式期间执行"的工具走本地执行器;其余复用流式结果。
  const pendingToolCalls = coreToolCalls.filter(
    (toolCall) => !streamedResultsById.has(toolCall.id as ToolCallId),
  );
  let pendingExecutionResults: ToolExecutionResult[] = [];
  state.turnMachine = new TurnMachineImpl(state.turnMachine.startToolExecution());
  if (pendingToolCalls.length > 0) {
    // 若只有部分工具需要在本地执行,按子集重新调度:并行分组要基于"实际待执行集合"计算,
    // 否则可能把已完成的只读工具和新工具错误地排进同一批。
    const pendingSchedule =
      pendingToolCalls.length === coreToolCalls.length
        ? schedule
        : await this.scheduleTools(pendingToolCalls);
    // ToolCallScheduled 事件:让 UI 在真正执行前就能显示工具卡片与调度顺序。
    const scheduledEvents = await this.emitToolScheduledEvents(
      pendingToolCalls,
      pendingSchedule,
      options.assistantMessageId,
      options.modelTraceContext,
    );
    state.events.push(...scheduledEvents);
    for (const toolCall of pendingToolCalls) {
      // 排队态事件:与 scheduled 分开,表示"等待执行器分配批次"。
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_queued",
        input: toolParts.get(toolCall.id)?.input,
      });
    }

    this.logger?.debug("Executing tools", {
      streamedToolCallCount: streamedResultsById.size,
      toolCallCount: pendingToolCalls.length,
      tools: pendingToolCalls.map((tc) => tc.name),
    });
    // 交给工具执行器:按 parallelGroups 跑批次;onBatchStart 在任何 handler 执行前触发,
    // 用于把 part 从 pending 更新为 running(已取消的批次不会误标 running)。
    const execution = await this.executeTools(pendingToolCalls, pendingSchedule, {
      automationTurn: isAutomationMutationRestrictedTurn(state),
      offPeakTurn: isOffPeakCreateRestrictedTurn(state),
      signal: state.turnAbortSignal,
      traceContext: options.modelTraceContext,
      subagentModelOverride: state.subagentModelOverride,
      model: state.model,
      toolSearch: options.toolSearch,
      onBatchStart: async (toolCallIds) => {
        // 已取消的 batch 仍由 executor 返回 cancelled results，但不能把从未进入
        // handler 的 tool parts 误标记为 running。
        if (state.turnAbortSignal?.aborted) return;
        for (const toolCallId of toolCallIds) {
          const toolCall = toolCallById.get(toolCallId as ToolCallId);
          if (!toolCall) continue;
          const persisted = toolParts.get(toolCall.id);
          if (!persisted) continue;
          persisted.startedAt = Date.now();
          const projectedToolName = projectToolNameForNonEmptyBoundary(toolCall.name);
          await this.persistPart(
            {
              id: persisted.partID,
              sessionID: this.sessionId,
              messageID: options.assistantMessageId,
              type: "tool",
              callID: toolCall.id,
              declarationIndex: persisted.declarationIndex,
              tool: projectedToolName.toolName,
              metadata: {
                ...projectedToolName.metadata,
                ...(toolCall.modelCallWrapper
                  ? { modelCallWrapper: toolCall.modelCallWrapper }
                  : {}),
              },
              state: {
                status: "running",
                input: persisted.input,
                title: projectedToolName.toolName,
                metadata:
                  mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation) ??
                  {},
                time: {
                  start: persisted.startedAt,
                },
              },
            },
            options.modelTraceContext,
          );
          await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status: "tool_started",
            input: persisted.input,
            startedAt: new Date(persisted.startedAt),
          });
        }
      },
    });
    pendingExecutionResults = execution.results;
    state.events.push(...execution.events);
  }
  // 合并两类结果:流式期间提前完成的 + 本批次执行的。
  // 随后按原始 tool call 顺序重排,保证历史里的 tool result 顺序与 assistant 声明一致。
  const resultById = new Map<string, ToolExecutionResult>();
  for (const streamed of streamedResultsById.values()) {
    resultById.set(streamed.result.toolCallId, streamed.result);
  }
  for (const pending of pendingExecutionResults) {
    resultById.set(pending.toolCallId, pending);
  }
  const results = coreToolCalls
    .map((toolCall) => resultById.get(toolCall.id))
    .filter((result): result is ToolExecutionResult => result !== undefined);
  // settlement:把每个工具结果写回对应 part、更新 turn machine、并生成模型可见的
  // tool result 条目。它是"工具执行"与"下一次模型请求"之间的唯一提交点。
  await settleToolResults.call(this, state, {
    assistantMessageId: options.assistantMessageId,
    modelTraceContext: options.modelTraceContext,
    results,
    toolParts,
    toolCallById,
    streamedResultsById,
  });

  // 工具主动要求结束 turn(stopTurnAfterResult):先落 step-finish,再按原因分流。
  // automation create limit 是特殊分支:不结束 turn,而是降级为"纯文本收口",
  // 让模型用文本告知用户上限,避免它继续 List/Delete/Create 甚至 Bash 绕过。
  const stopTurnResult = results.find((result) => result.turnControl?.stopTurnAfterResult === true);
  if (stopTurnResult) {
    await persistToolModelStepFinish(this, state, options);
    if (stopTurnResult.turnControl?.reason === "automation_create_limit") {
      // 上限错误只能由用户手动释放名额。把普通 error 继续交给模型，
      // 导致模型循环 List/Delete/Create，甚至尝试 Bash 绕过。当前 turn 只保留一次文本收口。
      state.automationCreateLimitReached = true;
      recordCompletedToolBatch(state);
      this.logger?.info("Automation create limit switched turn to text-only response", {
        event: "automation.create_limit.text_only_continuation",
        module: "core.runtime",
        reason: stopTurnResult.turnControl.reason,
        status: "completed",
        toolCallId: stopTurnResult.toolCallId,
        toolName: stopTurnResult.toolName,
      });
      return "continue";
    }
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
    }
    this.logger?.info("Tool result requested turn stop", {
      event: "tool.turn_control.stop",
      module: "core.runtime",
      reason: stopTurnResult.turnControl?.reason,
      status: "completed",
      toolCallId: stopTurnResult.toolCallId,
      toolName: stopTurnResult.toolName,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }

  // 正常路径:检查工具调用异常(如重复调用/参数异常)并落 step-finish;
  // 只有"所有工具都拿到结果"才标记 completedRealToolResultBatch,
  // 后续主循环据此消费项目记忆 recall 等工具批次后置附件。
  await handleToolCallAnomalyWarnings(this, state, {
    modelTraceContext: options.modelTraceContext,
    toolCalls: options.toolCalls,
  });
  await persistToolModelStepFinish(this, state, options);
  if (coreToolCalls.length > 0 && results.length === coreToolCalls.length) {
    state.completedRealToolResultBatch = true;
  }
  // 消费工具批次边界可继续执行的 guide(用户在工具执行期间发来的新输入),
  // 然后重置"工具轮"计数并返回 continue,让主循环带着工具结果发起下一次请求。
  await drainInlineGuideForNextRequest(this, state);
  recordCompletedToolBatch(state);
  this.logger?.debug("After inject, message count", {
    compactToolTurnsSinceLastCompact: state.compactTracking?.toolTurnsSinceCompact,
    count: this.messageHistory.getMessageCount(),
    reactiveCompactAttemptedInCurrentModelStep: state.reactiveCompactAttemptedInCurrentModelStep,
  });
  return "continue";
}
