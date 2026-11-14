/**
 * ============================================================================
 * executor/batch-runner.ts —— 按调度批次执行工具
 * ============================================================================
 *
 * 【两层执行】
 *   executeToolBatch   一个批次内的并发(Promise.all,受 maxConcurrency 限制);
 *   executeToolSchedule 异步生成器:按 parallelGroups 顺序逐批执行,
 *                      每批前后 yield batch_start / batch_complete。
 *
 * 【turnControl 短路】
 *   某批结果的 turnControl.stopTurnAfterResult=true(如定时任务上限),
 *   则后续所有批次的工具立即以 ToolCancelled 收尾(而不是继续执行),
 *   保证"工具要求结束 turn"的语义不被后续批次破坏。
 *
 * 【失败不阻断后续批次】
 *   旧策略会在前序非 concurrentSafe 工具失败后跳过后续所有组;
 *   现在改为继续按 parallelGroups 执行,由每个工具自己的权限/取消/handler 决定结果
 *   (避免 TodoWrite 等本地失败误截断后续 Agent 调用)。
 * ============================================================================
 */
import {
  CoreErrorType,
  createCoreError,
  createRootTraceContext,
  traceContextToLogContext,
} from "@zcode/contracts";
import type { ToolSchedule } from "../scheduler.js";
import type { ExecutableToolCall, ToolBatchEvent, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { emitToolCallError } from "./events.js";
// import { emitSkippedToolError } from "./events.js";
import type { ToolBatchExecuteOptions, ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

// const TOOL_SKIPPED_AFTER_BLOCKING_FAILURE =
//   "Tool skipped because a previous tool call in the scheduled sequence failed.";
const TOOL_CANCELLED_AFTER_TURN_STOP =
  "Tool cancelled because a previous tool result requested a turn stop.";

type ExecuteToolCall = (
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
) => Promise<ToolExecutionResult>;

/**
 * 执行一个批次:全部并发,但受 maxConcurrency 分片(避免一次创建过多 Promise/进程)。
 * 每个 tool call 的失败由 executeOne 内部收敛为 ToolExecutionResult,不会 reject 整批。
 *
 * 两条路径的差异只在"分片",语义完全一致:
 *   - 数量 ≤ 上限时直接并发,少一次数组切分;
 *   - 超限时按固定窗口串行推进窗口,窗口内仍并发。
 * 注意这里**不重排**结果:返回值顺序始终与入参 toolCalls 一致,
 * 上层(turn-tools)靠这个顺序把 result 配对回 toolCall。
 */
export async function executeToolBatch(
  deps: ToolExecutorDeps,
  executeOne: ExecuteToolCall,
  toolCalls: ExecutableToolCall[],
  options?: ToolBatchExecuteOptions,
): Promise<ToolExecutionResult[]> {
  const maxConcurrency = options?.maxConcurrency ?? deps.maxConcurrency;

  // 不超过并发上限时直接 Promise.all：避免无意义的分片循环，
  // 此时结果天然与入参顺序一致（Promise.all 保序）。
  if (toolCalls.length <= maxConcurrency) {
    return Promise.all(toolCalls.map((tc) => executeOne(tc, options)));
  }

  // 超过上限时分片串行：窗口内并发，窗口间 await 衔接。
  // 用 results.push 而不是按索引赋值：push 天然保序，且不会产生稀疏数组。
  const results: ToolExecutionResult[] = [];
  for (let i = 0; i < toolCalls.length; i += maxConcurrency) {
    const batch = toolCalls.slice(i, i + maxConcurrency);
    // 传完整 options：信号/追踪/模型覆盖等必须透传，否则分片内的工具会丢失取消与 trace。
    const batchResults = await Promise.all(
      batch.map((tc) =>
        executeOne(tc, {
          automationTurn: options?.automationTurn,
          offPeakTurn: options?.offPeakTurn,
          signal: options?.signal,
          traceContext: options?.traceContext,
          subagentModelOverride: options?.subagentModelOverride,
          model: options?.model,
          toolSearch: options?.toolSearch,
        }),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * 按 schedule.parallelGroups 逐批执行,并向外 yield 批次事件。
 * 返回全部结果(含被 turnControl 短路后的 cancelled 结果)。
 *
 * 生成器契约:调用方 for-await 消费事件,并拿到 return 值(全部结果)。
 * 因此每个批次都严格"先 yield start → 执行 → yield complete → 再判短路",
 * 事件顺序就是执行顺序,UI 不会看到倒序的批次状态。
 *
 * schedule 里的分组只含 toolCallId;这里用 toolMap 还原成 call。
 * 查不到的 id 直接跳过(可能是已被过滤/提前完成的 call),不能让缺项扩成 undefined 执行。
 */
export async function* executeToolSchedule(
  deps: ToolExecutorDeps,
  executeBatch: (
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ) => Promise<ToolExecutionResult[]>,
  toolCalls: ExecutableToolCall[],
  schedule: ToolSchedule,
  options?: ToolBatchExecuteOptions,
): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void> {
  const toolMap = new Map(toolCalls.map((tc) => [tc.id, tc]));
  const allResults: ToolExecutionResult[] = [];
  const maxConcurrency = options?.maxConcurrency ?? deps.maxConcurrency;

  for (let groupIndex = 0; groupIndex < schedule.parallelGroups.length; groupIndex++) {
    const group = schedule.parallelGroups[groupIndex];
    const groupTools = group
      .map((id) => toolMap.get(id))
      .filter((tc): tc is ExecutableToolCall => tc !== undefined);

    if (groupTools.length === 0) continue;

    // batch_start 先发:即使本批工具全部在权限/校验阶段快速失败,
    // UI 也能看到"这一批开始过",不会出现只有 batch_complete 没有 start 的孤儿事件。
    // yield 前不 await：让调用方先消费 start 事件再执行，保证事件顺序与执行顺序一致。
    yield { type: "batch_start", parallelGroupIndex: groupIndex, toolCallIds: group };

    // 执行批次：executeBatch 内部已把每个工具的异常收敛为 ToolExecutionResult，
    // 这里不会 reject，所以不需要 try/catch 包裹。
    const groupResults = await executeBatch(groupTools, {
      automationTurn: options?.automationTurn,
      signal: options?.signal,
      traceContext: options?.traceContext,
      subagentModelOverride: options?.subagentModelOverride,
      model: options?.model,
      toolSearch: options?.toolSearch,
      maxConcurrency,
    });
    allResults.push(...groupResults);

    yield { type: "batch_complete", parallelGroupIndex: groupIndex, results: groupResults };

    // 检查本批是否有工具要求停止 turn（如 automation_create_limit、plan_exit_denied）。
    // 用 some 而非 find：只要有一个 stop 信号就短路，不关心是哪一个。
    const shouldStopTurn = groupResults.some(
      (result) => result.turnControl?.stopTurnAfterResult === true,
    );
    if (shouldStopTurn) {
      // 短路:后续批次不再执行,统一生成 ToolCancelled 结果并逐条发 ToolCallError 事件,
      // 让模型/UI 明确知道这些工具"因前序停止而未执行"。
      // 为什么补发事件而不是静默跳过:模型侧需要"每个 tool call 都有结果"的配对义务,
      // 少一条结果会让下一轮请求被 provider 拒绝;UI 也需要错误事件才能把工具卡收口。
      // 不变量 #1：每个 tool_call 必须有配对结果，这里为每个 skipped tool 显式生成 cancelled 结果。
      const skippedTools = schedule.parallelGroups
        .slice(groupIndex + 1)
        .flat()
        .map((id) => toolMap.get(id))
        .filter((toolCall): toolCall is ExecutableToolCall => toolCall !== undefined);
      // 短路可能发生在任何批次,这里不能依赖外部传入的 traceContext 一定存在;
      // 兜底新建 root 保证每条取消事件都有完整 trace 字段。
      const eventTraceContext =
        options?.traceContext ??
        deps.traceContext ??
        createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
      const turnId = eventTraceContext.turnId ?? deps.turnId;

      for (const toolCall of skippedTools) {
        // ToolCancelled + recoverable=true：取消不是系统故障，模型可在下一轮重新调度这些工具。
        const result = createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, TOOL_CANCELLED_AFTER_TURN_STOP, {
            context: { toolCallId: toolCall.id, toolName: toolCall.name },
            recoverable: true,
          }),
        );
        allResults.push(result);
        // 发错误事件：让事件存储记录"该 call 已收口为 cancelled"，
        // 与结果配对，避免 ToolPart 卡在 pending/running。
        await emitToolCallError(deps, result.toolCallId, eventTraceContext, turnId, result.error);
        deps.logger?.warn("Tool call cancelled after turn stop", {
          ...traceContextToLogContext(eventTraceContext),
          event: "tool.call.cancelled_after_turn_stop",
          module: "core.tool.executor",
          status: "cancelled",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        });
      }

      break;
    }

    // 旧策略会在前序非 concurrentSafe 工具失败后，跳过所有后续调度组。
    // 连续 subagent 场景里，TodoWrite 这类本地失败会误截断后续 Agent；现在改为继续按
    // parallelGroups 顺序执行，后续工具由自己的权限、取消信号和 handler 决定结果。
    // const hasBlockingFailure = groupResults.some(
    //   (result) => !result.success && !deps.registry.get(result.toolName)?.metadata.concurrentSafe,
    // );
    // if (!hasBlockingFailure) continue;
    //
    // const skippedTools = schedule.parallelGroups
    //   .slice(groupIndex + 1)
    //   .flat()
    //   .map((id) => toolMap.get(id))
    //   .filter((toolCall): toolCall is ExecutableToolCall => toolCall !== undefined);
    //
    // for (const toolCall of skippedTools) {
    //   const result = createErrorResult(
    //     toolCall,
    //     createCoreError(CoreErrorType.ToolExecutionFailed, TOOL_SKIPPED_AFTER_BLOCKING_FAILURE, {
    //       context: { toolCallId: toolCall.id, toolName: toolCall.name },
    //       recoverable: true,
    //     }),
    //   );
    //   allResults.push(result);
    //   await emitSkippedToolError(deps, result, options?.traceContext);
    // }
    //
    // break;
  }

  return allResults;
}
