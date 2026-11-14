/**
 * 自动压缩（autocompact）的阈值策略：把 context window、输出预留、buffer、
 * 连续失败次数折算成一次 shouldAutoCompact 决策。纯计算，不读写盘、不发事件。
 * 决策只描述"该不该压缩"，真正执行压缩由上层 runtime 负责；本模块不做任何副作用。
 * 不变量：阈值分母必须是 effectiveContextWindow（已扣除 output reserve），
 * 不能用完整 contextWindow，否则会把本该留给输出的空间算进输入预算。
 */

import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";

// 未显式传入 contextWindow 时的兜底窗口；只影响估算，不代表任何具体模型的真实上限。
export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
// preflight 策略下的硬上限：无论模型声明多大输出，最多只为其预留 21K。
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
// 摘要请求自身允许的输出上限，必须小于输出预留，否则压缩调用会挤爆预算。
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
// 阈值下方留出的安全余量，容纳一轮请求的估算误差与下一轮增长。
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
// 当前策略固定的触发百分比；单独导出便于上层在事件与日志里回读同一口径。
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
// 连续压缩失败达到该次数即触发 circuit breaker，避免在同一条坏上下文上反复烧 token。
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

// 自动压缩的可选配置：字段缺省时全部回落到本文件的默认常量。
// 上层只需传当前模型与 session 覆盖项，其余由 policy 自行折算，禁止调用方重复算阈值。
export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  bufferTokens?: number;
  thresholdPercentOverride?: number;
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
}

// token 计数来源：estimate 为本地估算，provider_usage 为 provider 回传的真实用量。
// 决策结果会把来源一并带出，便于日志区分"估算触发"与"真实触发"。
export type AutoCompactTokenSource = "estimate" | "provider_usage";

// provider 回传的 token 用量覆盖：存在时优先于本地估算，避免估算偏差导致错过压缩窗口。
export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

// 决策结果：除 shouldCompact 外还完整回传阈值口径与各来源 token 数，
// 使上层事件与日志可以解释"为什么压/不压"，无需重新计算。
export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  thresholdPercent: number;
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold";
}

// 计算可供输入使用的有效窗口：contextWindow 减去输出预留。
// 返回 0 表示窗口已被输出预留吃满；调用方据此判定不可能再容纳输入，不应再发起压缩。
// 纯函数、无缓存；同一 config 重复调用结果稳定，可作为阈值计算的唯一入口。
export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

// 决定为输出预留多少 token：取模型 maxOutputTokens 与 21K 硬上限的较小值。
// 模型未声明 maxOutputTokens 时回落到 32K 默认值，仍受 21K 上限约束。
// 该值必须与请求预算同源，否则压缩后仍可能因输出预留不足而失败。
export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在统一保留至多 21K。
  return Math.min(
    maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
}

// 触发阈值 = 有效窗口 - buffer；buffer 用于吸收估算误差与下一轮新增内容。
// 返回值下限为 0，保证 window 极小时不会出现负阈值导致"永远触发"。
// 与 getEffectiveContextWindowSize 共享口径，两者不可各自维护一套算法。
export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
}): AutoCompactDecision {
  // 判定顺序固定为 disabled → 消息不足 → circuit breaker → 阈值比较；
  // reason 是稳定契约，上层据此决定是否提示用户或重置失败计数。
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const thresholdPercent = DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!hasEnoughMessagesToCompact(input.messages)) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  if (tokenCount < threshold) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

// 只接受有限非负数并向下取整；非法值一律视为未配置，交给默认常量兜底。
// 不抛错是刻意的：配置来自外部，宁可回退默认值也不阻断整个 turn。
function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
