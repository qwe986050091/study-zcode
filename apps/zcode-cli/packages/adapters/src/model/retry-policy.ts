// ============================================================
// AI SDK 模型重试策略默认值与解析
// 定位：把"调用方 options → 环境变量 → 内置默认"三级覆盖收敛到一个纯函数，产出全字段必填对象。
// 输入：可选 options 与 env 快照。输出：ResolvedAiSdkModelRetryOptions（字段全部已归一化）。
// 副作用：无（env 由调用方传入，不直接读 process.env）。失败语义：非法值静默回退到下一级/默认。
// 不变量：maxAttempts 含首次请求（env 暴露的是 retry 次数，故解析时 +1）；延迟类字段非负、因子为正。
// ============================================================

/** 重试参数（全部可空，缺省由环境变量或内置默认补齐）。 */
export interface AiSdkModelRetryOptions {
  /** 总尝试数（含首次）；undefined=不指定。 */
  maxAttempts?: number;
  /** 首次退避基数，单位 ms；undefined=默认 2000。 */
  baseDelayMs?: number;
  /** 退避指数因子；undefined=默认 2（>=1 才有意义）。 */
  backoffFactor?: number;
  /** 单次退避上限，单位 ms；undefined=默认 60000。 */
  maxDelayMs?: number;
  /** 是否加抖动；undefined=默认开启，避免多客户端同步重试。 */
  jitter?: boolean;
}

/** 解析后的完整重试参数（无 undefined，可直接参与计算）。 */
export type ResolvedAiSdkModelRetryOptions = Required<AiSdkModelRetryOptions>;

type EnvRecord = Record<string, string | undefined>;

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_FACTOR = 2;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

const ENV_MODEL_RETRY_MAX_RETRIES = "ZCODE_MODEL_RETRY_MAX_RETRIES";
const ENV_MODEL_RETRY_BASE_DELAY_MS = "ZCODE_MODEL_RETRY_BASE_DELAY_MS";
const ENV_MODEL_RETRY_BACKOFF_FACTOR = "ZCODE_MODEL_RETRY_BACKOFF_FACTOR";
const ENV_MODEL_RETRY_MAX_DELAY_MS = "ZCODE_MODEL_RETRY_MAX_DELAY_MS";

const DEFAULT_RETRY_OPTIONS: ResolvedAiSdkModelRetryOptions = {
  backoffFactor: DEFAULT_RETRY_BACKOFF_FACTOR,
  baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  jitter: true,
  // maxAttempts includes the first request; env/config names expose retry count.
  maxAttempts: DEFAULT_MAX_RETRIES + 1,
  maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
};

/**
 * 解析最终生效的重试参数：每个字段独立按 options → env → 默认 逐级回退。
 * 数值字段先归一化（整数取 floor、正数判 >0、延迟判 >=0），非法输入不会抛错只回退。
 * jitter 只能用布尔覆盖，env 不参与（避免字符串 "false" 被误判为真）。
 */
export function resolveAiSdkModelRetryOptions(
  options: AiSdkModelRetryOptions | undefined,
  env: EnvRecord,
): ResolvedAiSdkModelRetryOptions {
  const envOptions = readRetryOptionsFromEnv(env);
  return {
    backoffFactor: normalizePositiveNumber(
      options?.backoffFactor,
      normalizePositiveNumber(envOptions.backoffFactor, DEFAULT_RETRY_OPTIONS.backoffFactor),
    ),
    baseDelayMs: normalizeNonNegativeInteger(
      options?.baseDelayMs,
      normalizeNonNegativeInteger(envOptions.baseDelayMs, DEFAULT_RETRY_OPTIONS.baseDelayMs),
    ),
    jitter: options?.jitter ?? DEFAULT_RETRY_OPTIONS.jitter,
    maxAttempts: normalizePositiveInteger(
      options?.maxAttempts,
      normalizePositiveInteger(envOptions.maxAttempts, DEFAULT_RETRY_OPTIONS.maxAttempts),
    ),
    maxDelayMs: normalizeNonNegativeInteger(
      options?.maxDelayMs,
      normalizeNonNegativeInteger(envOptions.maxDelayMs, DEFAULT_RETRY_OPTIONS.maxDelayMs),
    ),
  };
}

/** 从环境变量读取重试参数；空串/非法值返回 undefined（表示"未设置"，交由默认值兜底）。 */
function readRetryOptionsFromEnv(env: EnvRecord): AiSdkModelRetryOptions {
  const maxRetries = parseNonNegativeInteger(env[ENV_MODEL_RETRY_MAX_RETRIES]);
  return {
    backoffFactor: parsePositiveNumber(env[ENV_MODEL_RETRY_BACKOFF_FACTOR]),
    baseDelayMs: parseNonNegativeInteger(env[ENV_MODEL_RETRY_BASE_DELAY_MS]),
    maxAttempts: maxRetries === undefined ? undefined : maxRetries + 1,
    maxDelayMs: parseNonNegativeInteger(env[ENV_MODEL_RETRY_MAX_DELAY_MS]),
  };
}

/** 解析非负整数（允许 0）：负数/NaN/Infinity 视为未设置；小数向下取整。 */
function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/** 解析正数（必须 >0）：用于退避因子，0 或负数会让重试退化成无间隔。 */
function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** 正整数归一化：下限夹到 1（至少尝试一次），小数取 floor；非法值用 fallback。 */
function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

/** 正数归一化：<=0 与非法值回退默认（用于退避因子）。 */
function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/** 非负整数归一化：负数夹到 0，小数取 floor；用于延迟配置。 */
function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
