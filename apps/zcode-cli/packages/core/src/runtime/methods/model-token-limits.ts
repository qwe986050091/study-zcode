/**
 * ============================================================================
 * model-token-limits.ts —— 请求输出预算计算
 * ============================================================================
 *
 * 两层预算:
 *   1) resolveNormalRequestMaxOutputTokens:普通请求的 baseline(模型声明上限,
 *      未声明时退回 32K 默认值);
 *   2) resolveModelStepMaxOutputTokens:再叠加"剩余上下文窗口"约束
 *      (contextWindow - 当前输入估算 - 1K 余量),避免 input + output 超窗。
 *
 * 注意:32K 只是"模型未声明"时的默认值,不是全局上限;64K 模型必须原样使用 64K。
 * ============================================================================
 */
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";

const DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS = 32_000;

/** baseline 输出预算:模型声明值优先,未声明/非法时使用 32K 默认值。 */
export function resolveNormalRequestMaxOutputTokens(input: {
  modelMaxOutputTokens: number | undefined;
}): number {
  // 32K 是模型未声明输出预算时的默认值，不是对模型级配置的全局上限。
  // 已解析到模型值时必须原样使用，否则 64K 模型的请求预算会被错误裁剪为 32K。
  return (
    positiveFlooredTokens(input.modelMaxOutputTokens) ?? DEFAULT_NORMAL_REQUEST_MAX_OUTPUT_TOKENS
  );
}

/**
 * 单步输出预算 = min(baseline, 剩余上下文窗口)。
 * 输入信息不可用/估算为负时返回 baseline(让 provider 权威拒绝,而不是本地静默缩小)。
 * 保留 1K 余量,避免因投影差异导致 input+output 恰好顶到窗口边界。
 */
export function resolveModelStepMaxOutputTokens(input: {
  baselineMaxOutputTokens: number;
  contextWindow: number | undefined;
  estimatedCurrentUsage: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
}): number {
  // legacy 仅为入参兼容；所有请求（含工具续轮）都按剩余窗口计算 preflight cap。
  if (
    input.contextWindow === undefined ||
    !Number.isFinite(input.contextWindow) ||
    input.contextWindow <= 0 ||
    !Number.isFinite(input.estimatedCurrentUsage) ||
    input.estimatedCurrentUsage < 0
  ) {
    return input.baselineMaxOutputTokens;
  }

  const estimatedAvailable = Math.floor(input.contextWindow - input.estimatedCurrentUsage - 1_000);
  if (estimatedAvailable <= 0) {
    // 本地估算不是 provider 权威拒绝；无正数可发送时保留 baseline 走既有错误恢复。
    // 这里刻意不返回 1 或 0:发一个极小 max_tokens 会让 provider 立刻截断,
    // 把"上下文超窗"伪装成"输出长度不足",错误分类随之错位。
    return input.baselineMaxOutputTokens;
  }
  // 取 min:baseline 是模型能力上限,estimatedAvailable 是本次窗口的物理剩余。
  // 两个约束都必须满足,所以是交集而不是任一。
  const candidate = Math.min(input.baselineMaxOutputTokens, estimatedAvailable);
  return candidate;
}

/** 生成 token 预算诊断日志字段(inputBudget = contextWindow - maxOutputTokens)。 */
export function modelRequestTokenLimitLogContext(input: {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  modelContextBudgetStrategy: "legacy" | "preflight-v1" | undefined;
  traceContext: TraceContext;
}) {
  return {
    ...traceContextToLogContext(input.traceContext),
    contextWindow: input.contextWindow,
    event: "model.request.token_limits",
    inputBudgetTokens: inputBudgetTokens(input.contextWindow, input.maxOutputTokens),
    maxOutputTokens: input.maxOutputTokens,
    // 日志固定记录当前真实策略,而不是回显入参:legacy 只为兼容旧调用点,
    // 实际计算已统一走 preflight cap;回显入参会让日志与实际行为不一致。
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    module: "core.runtime",
  };
}

function inputBudgetTokens(
  contextWindow: number | undefined,
  maxOutputTokens: number | undefined,
): number | undefined {
  // 诊断字段缺失任一侧(窗口或输出预算)就不产出:undefined 表示"不可计算",
  // 写成 0 会让日志看起来像"输入预算耗尽",误导排障方向。
  if (
    contextWindow === undefined ||
    maxOutputTokens === undefined ||
    !Number.isFinite(contextWindow) ||
    !Number.isFinite(maxOutputTokens)
  ) {
    return undefined;
  }

  return Math.max(0, Math.floor(contextWindow) - Math.floor(maxOutputTokens));
}

function positiveFlooredTokens(value: number | undefined): number | undefined {
  // 非正/非有限值等价于"模型未声明";floor 是必要的,部分 provider 会拒绝小数 max_tokens。
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}
