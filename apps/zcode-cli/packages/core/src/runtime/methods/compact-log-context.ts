/**
 * ============================================================================
 * runtime/methods/compact-log-context.ts —— auto compact 决策的日志字段投影
 * ============================================================================
 * 【定位】链路 4 的纯诊断旁路：把 AutoCompactDecision 压平为日志 context，不参与任何压缩决策。
 * 【输入/输出】输入 compact 策略决策快照；输出可直接落日志的扁平对象，无副作用。
 * 【口径】inputBudgetTokens 与 effectiveContextWindow 同源，表示本次估算使用的输入预算；
 *         thresholdPercent 是已折算的百分比，日志侧不要再用 threshold 二次计算。
 * ============================================================================
 */
import type { AutoCompactDecision } from "../../compact/policy.js";

// 将一次 auto compact 决策压平成日志字段；仅用于观测，不影响后续压缩判断。
// 返回对象可安全 JSON 化，字段全部取自同一 decision 快照，不存在跨时刻拼接。
// 无 IO、无缓存副作用；调用方负责实际写日志并控制采样频率。
export function autoCompactDecisionLogContext(decision: AutoCompactDecision) {
  // 显式列出字段而不是展开 decision：日志 schema 需要稳定，内部新增字段不应自动泄漏。
  // 预算/阈值/usage 全部取自同一决策快照，避免日志里出现跨时刻拼接的数字。
  return {
    contextWindow: decision.contextWindow,
    effectiveContextWindow: decision.effectiveContextWindow,
    estimatedTokenCount: decision.estimatedTokenCount,
    inputBudgetTokens: decision.effectiveContextWindow,
    maxOutputTokens: decision.maxOutputTokens,
    modelContextBudgetStrategy: decision.modelContextBudgetStrategy,
    outputReserveTokens: decision.outputReserveTokens,
    providerBaseTokenCount: decision.providerBaseTokenCount,
    providerCacheReadTokens: decision.providerCacheReadTokens,
    providerCacheWriteTokens: decision.providerCacheWriteTokens,
    providerContextUsageTokenCount: decision.providerContextUsageTokenCount,
    providerIncrementalTokenCount: decision.providerIncrementalTokenCount,
    providerOutputTokens: decision.providerOutputTokens,
    threshold: decision.threshold,
    thresholdPercent: decision.thresholdPercent,
    tokenCount: decision.tokenCount,
    tokenSource: decision.tokenSource,
  };
}
