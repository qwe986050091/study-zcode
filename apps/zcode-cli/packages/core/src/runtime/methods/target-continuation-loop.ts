/**
 * ============================================================================
 * runtime/methods/target-continuation-loop.ts —— Goal 自动续跑循环
 * ============================================================================
 *
 * 一个 Goal 可能需要在多轮模型迭代之间连续推进,直到:
 *   - verifier 判定完成(target 被标记 complete);
 *   - 目标变为 paused/complete/被替换;
 *   - 出现新的待处理命令(prompt/通知),必须先让它们执行;
 *   - 用户取消;
 *   - 某次续跑返回 null(没有可续跑的候选)。
 *
 * 【为什么是循环 + 队列命令】
 *   continueActiveTargetLoop 把整条循环包成一个 target-continuation-loop 命令,
 *   与其它 runtime command 共用同一队列与取消语义;
 *   runActiveTargetContinuationLoop 才真正迭代,每次迭代复用一次
 *   executeTargetContinuationCommand(单轮续跑)。
 *
 * 【首次 vs 后续迭代】
 *   - 第一次可带 verifyBeforeFirstContinue 与 intent(属于触发它的那次用户提交);
 *   - 之后每轮强制 verifyBeforeContinue=true,并清空 intent:
 *     后续自动轮读取新的 Session Selection,也允许中间插入的用户 turn 成为新权威。
 * ============================================================================
 */
import type { AgentRuntimeInternal } from "../internal.js";
import type { ContinueActiveTargetLoopOptions, TurnResult } from "../types.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { TargetContinuationLoopRuntimeCommand } from "../command-queue.js";
import { executeTargetContinuationCommand } from "./target.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

interface RunActiveTargetContinuationLoopOptions extends ContinueActiveTargetLoopOptions {
  yieldBeforeFirstContinue?: boolean;
}

export async function continueActiveTargetLoop(
  this: AgentRuntimeInternal,
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationLoopRuntimeCommand
  >(this, {
    abortSignal: options.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "target-continuation-loop",
      options: {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
        traceContext,
        trigger: options.trigger,
        ...(options.verifyBeforeFirstContinue !== undefined
          ? { verifyBeforeFirstContinue: options.verifyBeforeFirstContinue }
          : {}),
      },
      priority: "next",
      reject,
      resolve,
      traceContext,
    }),
  });
}

export async function runActiveTargetContinuationLoop(
  this: AgentRuntimeInternal,
  options: RunActiveTargetContinuationLoopOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext ?? this.rootTraceContext;
  let verifyBeforeContinue = options.verifyBeforeFirstContinue === true;
  let lastResult: TurnResult | null = null;
  let yieldToPendingCommands = options.yieldBeforeFirstContinue !== false;
  let continuationIntent = options.intent;

  // 循环退出条件 1：abortSignal 触发（用户取消 / 队列立即发送抢占）。
  // 用 signal 而不是内部 flag，是为了让外层 enqueueCancellableRuntimeCommand
  // 的两阶段取消能穿透到循环内部，避免续跑在取消后还多跑一轮。
  while (!options.abortSignal?.aborted) {
    if (yieldToPendingCommands && this.runtimeCommandQueue.hasPending()) {
      // 队列里有待处理命令(prompt/通知/control-only)时先让位:
      // 自动续跑不能长期霸占执行权,否则用户输入要等整个 goal 跑完。
      return lastResult;
    }

    if (
      options.trigger === "task-notification" &&
      verifyBeforeContinue &&
      this.config.targetCompletionVerification?.enabled === false
    ) {
      // 通知驱动、且完成验证被禁用时不再续跑:
      // 没有 verifier 就无法判断"这条通知是否已让目标完成",继续跑会无限迭代。
      // 循环退出条件 2：通知驱动 + 验证被禁用，无法收敛。
      return lastResult;
    }

    const result = await executeTargetContinuationCommand.call(this, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      ...(continuationIntent ? { intent: continuationIntent } : {}),
      traceContext,
      verifyBeforeContinue,
    });
    // 循环退出条件 3：单轮续跑返回 null（候选不存在 / verifier 通过已标 complete /
    // 无 nextAction / 目标在验证期间变了）。lastResult 保留上一轮结果。
    if (!result) return lastResult;

    lastResult = result;
    // 第一次 continuation 应用并持久化本次 Submission；后续自动轮次读取新的
    // Session Selection，从而沿用上一轮，也允许中间插入的用户 Turn 成为新权威。
    continuationIntent = undefined;
    verifyBeforeContinue = true;
    yieldToPendingCommands = true;
  }

  return lastResult;
}
