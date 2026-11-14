/**
 * Bash 工具的超时预算。
 * defaultTimeoutMs：模型未传 timeout（或传 0）时使用的毫秒数，默认 120_000；
 * maxTimeoutMs：显式 timeout 也不可越过的毫秒上限，默认 600_000。
 * 由 resolveBashTimeoutPolicy 从环境变量解析，消费者是 bash.ts 的 handler 与 watchdog。
 * 两个字段都是“毫秒”单位且必须为正数；上限失效会让工具超时保护整体失效。
 */
export interface BashTimeoutPolicy {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

// 120s：未指定 timeout 时的默认执行窗口，也是 BASH_MAX_TIMEOUT_MS 的下限基准。
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
// 600s：单次 Bash 调用的硬上限；执行层按该值设置终止上限，避免命令无限挂起。
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;

export const DEFAULT_BASH_TIMEOUT_POLICY: BashTimeoutPolicy = {
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_MS,
  maxTimeoutMs: DEFAULT_BASH_MAX_TIMEOUT_MS,
};

/**
 * 从环境变量解析超时策略，返回统一的毫秒口径。
 * BASH_DEFAULT_TIMEOUT_MS 只接受正整数，空值/非法值/非正数回落到 120s；
 * BASH_MAX_TIMEOUT_MS 同理回落到 600s，并与 default 取 max。
 * 纯读取 env：不写回、不抛错，变量缺失时结果与常量默认值完全一致。
 * 不变量：返回的 maxTimeoutMs 永远 >= defaultTimeoutMs（否则 clamp 会把默认值压小）。
 */
export function resolveBashTimeoutPolicy(
  env: Readonly<Record<string, string | undefined>>,
): BashTimeoutPolicy {
  const defaultTimeoutMs =
    parsePositiveTimeout(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_BASH_TIMEOUT_MS;
  const configuredMaxTimeoutMs = parsePositiveTimeout(env.BASH_MAX_TIMEOUT_MS);

  return {
    defaultTimeoutMs,
    // 为什么取 max：若显式配置的 max 小于 default，未指定 timeout 的调用会被
    // 压到比默认值更低的窗口；这里统一抬到至少等于 default。
    maxTimeoutMs:
      configuredMaxTimeoutMs !== undefined
        ? Math.max(configuredMaxTimeoutMs, defaultTimeoutMs)
        : Math.max(DEFAULT_BASH_MAX_TIMEOUT_MS, defaultTimeoutMs),
  };
}

/**
 * 把工具入参 timeout 折算成实际执行毫秒数。
 * 输入：inputTimeoutMs 来自模型入参（可能 undefined/0），policy 来自环境解析。
 * 输出：`min(input || default, max)`，因此结果永远为正且不超过 maxTimeoutMs。
 * `||` 语义是刻意的：0 与 NaN 都视为“未指定”，避免 0ms 被当成立即超时。
 * 纯函数、无副作用；字符串数字由 schema 层先行转换，这里不再解析。
 */
export function resolveBashTimeoutMs(
  inputTimeoutMs: number | undefined,
  policy: BashTimeoutPolicy,
): number {
  return Math.min(inputTimeoutMs || policy.defaultTimeoutMs, policy.maxTimeoutMs);
}

/** 解析正整数毫秒；空串、非数字、0 与负数一律返回 undefined，由调用方回落默认值。 */
function parsePositiveTimeout(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}
