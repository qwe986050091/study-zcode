/**
 * ============================================================================
 * runtime/off-peak/turn.ts —— turn 循环侧的 off-peak 接管钩子
 * ============================================================================
 *
 * 【定位】只有两个薄函数：主轮在"完整请求边界"应用用户接管后的模型切换，
 *   以及识别 lifecycle 抛出的 takeover 错误码。
 *
 * 【边界】子轮不调用 refresh；接管只改归属与模型选择，不重建工作、不重跑工具。
 * ============================================================================
 */
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "../methods/turn-loop-state.js";
import { createTurnModel } from "../methods/turn-model.js";
import { getOffPeakModelBinding } from "./model-binding.js";
import { getOffPeakExecution } from "./runtime.js";

/** 用户接纳只改变归属；主轮在完整请求边界应用新选择，子轮不调用本钩子。 */
/**
 * 在用户接管后刷新本 turn 的模型绑定（主轮专用，子轮不调用）。
 *
 * 输入：runtime + 主循环状态。输出：true = 已切换；false = 无需切换。
 * 前置：state 带有 offPeakExecutionId，且当前控制器恰好是同一个执行、且已被用户接管。
 * 执行：创建新的 turn model（重新按当前配置解析）、释放旧的 off-peak binding，
 *   清空 modelSelectionScope / subagentModelOverride / offPeakTaskId / offPeakExecutionId，
 *   使本 turn 后续请求回到普通执行语义。
 * 副作用：改写 state.model 与相关 off-peak 标记；释放旧票据占用。
 * 时序：调用方必须保证在请求边界调用，避免半途换模型导致消息/工具语义不一致。
 */
export function refreshOffPeakTurnAfterTakeover(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): boolean {
  if (!state.offPeakExecutionId) return false;
  const execution = getOffPeakExecution(runtime);
  if (!execution?.lifecycle.ownedByUser || execution.executionId !== state.offPeakExecutionId)
    return false;
  const model = createTurnModel(runtime);
  getOffPeakModelBinding(state.subagentModelOverride?.requestDependencies)?.release();
  state.model = model;
  state.modelSelectionScope = undefined;
  state.subagentModelOverride = undefined;
  state.offPeakTaskId = undefined;
  state.offPeakExecutionId = undefined;
  return true;
}

/**
 * 判断一个错误是否是"用户已接管闲时执行"（按 code 判定，不看 message）。
 *
 * 输入：任意 catch 到的值。输出：boolean。
 * 用途：调用方据此把该错误转成"让位/重试普通请求"，而不当成真实失败上报 TurnError。
 * 非对象/无 code 安全返回 false，不抛错。
 */
export function isOffPeakUserTakeover(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "off_peak_user_takeover"
  );
}
