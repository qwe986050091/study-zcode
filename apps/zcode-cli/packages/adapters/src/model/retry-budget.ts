// ============================================================
// 重试预算档位（unbounded / single-attempt / 默认）
// 定位：把"预算档位"收敛成少数纯函数，让 attempt 循环、放弃闸门、状态事件共享同一判定。
// 输入：ModelRetryBudget | undefined（undefined=按 maxAttempts 正常计数的默认档）。
// 输出：布尔/数字；所有函数纯计算，无副作用、无异步、不抛错。
// 失败语义：无；非法档位按默认档处理（仅认两个枚举值）。
// 不变量：unbounded 只放宽"放弃条件"，不放宽退避、错误分类、边界事件与空补全重试；
// single-attempt 只把 maxAttempts 收敛为 1，额外鉴权刷新尝试不计入该预算。
// ============================================================

import { ModelRetryBudget } from "@zcode/contracts";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

/**
 * 重试预算档位的判定。
 *
 * 「无上限」**只**放宽瞬态失败的放弃条件：runner 的 attempt 循环、失败后「还能不能再试」两处闸门；
 * 退避曲线（2s→60s、jitter、Retry-After 优先）、`isRetryableFailure` 的分类、
 * `emittedRetryBoundaryEvent` 之后不重试、空补全重试与 compact 路径一律不动。
 *
 * 「单次尝试」只把本次请求的 `maxAttempts` 收敛为 1：runner 两处闸门与 empty completion 重试都读
 * 同一个 `retry.maxAttempts`，因此瞬态失败首次即上抛；鉴权刷新/签名修复的额外尝试不占预算，语义不变。
 */

/** 状态事件里 `maxAttempts` 表示「无上限」的哨兵（Infinity 不可序列化，0 不占用合法计数）。 */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
/** `single-attempt` 预算下本次请求允许的总尝试数（含首次）。 */
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;

/** 是否为"无上限"档；undefined 不是，避免缺省配置被误当无限重试。 */
export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

/** 是否为"单次尝试"档；只允许一次请求，瞬态失败即刻上抛。 */
export function isSingleAttemptRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.SingleAttempt;
}

/**
 * 按预算档位解析本次请求实际生效的 retry 选项。runner 入口统一走这里，避免在 attempt 循环、
 * 失败闸门、empty completion 与状态事件四处分别特判档位。
 */
export function resolveRetryOptionsForBudget(
  retry: ResolvedAiSdkModelRetryOptions,
  budget: ModelRetryBudget | undefined,
): ResolvedAiSdkModelRetryOptions {
  return isSingleAttemptRetryBudget(budget)
    ? { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS }
    : retry;
}

/** 失败之后还允许再试一次吗（等价于既有的 `retryBudgetAttempt < maxAttempts`，unbounded 恒真）。 */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** attempt 循环的继续条件（等价于既有的 `attempt <= loopMaxAttempts`，unbounded 恒真）。 */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** 写进状态事件 / 日志的 maxAttempts：unbounded 下是哨兵 0。 */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
