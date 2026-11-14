import type { TokenUsageInfo } from "@zcode/contracts";

// 从持久化会话中可复用的 token 用量基线；单位一律为 token 数，不是字节或字符数。
// 由 persistedTokenUsageBaseline 从历史 TokenUsageInfo 归一出，供 resume 时恢复用量与上下文水位。
export interface PersistedTokenUsageBaseline {
  // 命中 KV 缓存读取的 token 数；缺省按 0，恒 >= 0。
  cacheReadTokens: number;
  // 写入 KV 缓存的 token 数；缺省按 0，恒 >= 0。
  cacheWriteTokens: number;
  // 用于上下文水位计算的 token 数（input+output 或 total）；undefined 表示历史无法证明已覆盖 assistant。
  contextUsageTokens?: number;
  // 输入（prompt）窗口 token 数；baseline 存在时必 > 0，作为主轴不可缺失。
  inputTokens: number;
  // 输出（completion）token 数；缺省为 0，但 0 无法区分“真无输出”与“provider 未上报”。
  outputTokens: number;
}

// 从一条历史 TokenUsageInfo 提取可复用基线，供 resume 后恢复 token 统计。
// tokens 为 undefined、或输入窗口无法确定（<=0）时返回 undefined（语义是“不可用”），
// 调用方应回退到本地估算，不能把 0 当成真实值。
// 纯函数：不改入参、无 IO、无日志；输出各字段均为向下取整后的整数。
// 不变量：返回对象的 inputTokens > 0，其余计数 >= 0，contextUsageTokens 缺省为 undefined。
export function persistedTokenUsageBaseline(
  tokens: TokenUsageInfo | undefined,
): PersistedTokenUsageBaseline | undefined {
  if (!tokens) return undefined;
  const inputTokens = persistedInputWindowTokens(tokens);
  // 输入窗口是基线主轴；缺失时总量也无从校验，直接让调用方走本地估算路径。
  if (inputTokens === undefined || inputTokens <= 0) return undefined;

  const outputTokens = positiveInteger(tokens.output) ?? 0;
  const cacheReadTokens = nonNegativeInteger(tokens.cache.read) ?? 0;
  const cacheWriteTokens = nonNegativeInteger(tokens.cache.write) ?? 0;
  const totalTokens = positiveInteger(tokens.total);
  // 历史 TokenUsageInfo 会把缺失的 provider outputTokens 归一化成 0。
  // 没有可用 total 时，0 无法证明 usage 已覆盖 assistant，必须把 assistant 留给本地估算。
  const contextUsageTokens =
    outputTokens > 0
      ? inputTokens + outputTokens
      : totalTokens !== undefined && totalTokens >= inputTokens
        ? totalTokens
        : undefined;

  return {
    cacheReadTokens,
    cacheWriteTokens,
    contextUsageTokens,
    inputTokens,
    outputTokens,
  };
}

// 推算输入窗口 token 数，按 input > total-output > cache 合计 的优先级降级。
// 全部缺失时返回 undefined；total 小于 output 时钳到 0，保证不出现负值。
// 纯函数，无副作用。
function persistedInputWindowTokens(tokens: TokenUsageInfo): number | undefined {
  const inputTokens = positiveInteger(tokens.input);
  if (inputTokens !== undefined) return inputTokens;

  const totalTokens = positiveInteger(tokens.total);
  if (totalTokens !== undefined) {
    return Math.max(0, totalTokens - (nonNegativeInteger(tokens.output) ?? 0));
  }

  const cacheTokens =
    (nonNegativeInteger(tokens.cache.read) ?? 0) + (nonNegativeInteger(tokens.cache.write) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

// 归一为正整数：undefined、非有限数、<=0 一律返回 undefined（表示“未提供”而非 0）。
function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

// 归一为非负整数：undefined、非有限数、负数返回 undefined；0 是合法值。
function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}
