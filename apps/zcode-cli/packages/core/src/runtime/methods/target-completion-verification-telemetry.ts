/**
 * ============================================================================
 * target-completion-verification-telemetry.ts —— 完成验证的遥测包装
 * ============================================================================
 * 定位：链路 8 的裁判链路外层，给 target-completion-verification 的执行套一个
 *       detached foreground span（goal_completion_verification）。
 * 输入/输出：输入 abortSignal/target/trace 与 execute 回调；原样输出验证结果。
 * 关键不变量：本层只观察、不改写结果；裁判自身失败才 fail-open（不变量 #12），这里只把
 *       取消/失败归类到 telemetry，随后重抛原始错误，由上层决定是否 fail-open。
 * ============================================================================
 */
import type { SessionGoal, TraceContext } from "../deps.js";
import { isTurnCancellationError } from "../helpers/turn-errors.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TargetCompletionVerificationResult } from "./target-completion-verification.js";

export async function runTargetCompletionVerificationWithTelemetry(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
  execute: () => Promise<TargetCompletionVerificationResult>,
): Promise<TargetCompletionVerificationResult> {
  // detached：验证有自己的 foreground operation，不跟随调用方 ALS 上下文；trace 显式传入。
  const scope = runtime.agentTelemetry.detached({
    executionKind: "foreground",
    operation: "goal_completion_verification",
    targetKind: "goal",
    trigger: "turn",
    traceContext: input.traceContext,
  });
  // 在独立 span 内执行，保证 setResult/finish 一定配对到同一个 scope。
  return scope.run(async () => {
    try {
      // 真正的裁判请求（无工具）；成功与否的语义由 execute 决定，本层不解释 passed。
      const result = await execute();
      scope.setResultType("boolean");
      scope.finishCompleted();
      // 原样返回，不在这里把 fail-open 的 passed=true 再改写一次。
      return result;
    } catch (error) {
      // 用户取消（abortSignal）不算失败：归为 cancelled 后重抛，上层据此 pause target（链路 8）。
      if (isTurnCancellationError(error, input.abortSignal)) {
        scope.finishCancelled("abort_signal");
      } else {
        // 其它错误才记 execute 失败；"unknown" 是错误码占位，原始 error 留给上层归一化。
        scope.finishFailed("execute", "unknown", error);
      }
      // 必须重抛：telemetry 不能吞掉裁判失败，否则上层的 fail-open 决策会失去输入。
      throw error;
    }
  });
}
