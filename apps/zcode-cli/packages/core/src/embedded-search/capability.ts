// 默认进入 provider-visible embedded search branch。Bash 的 find/grep prelude
// 注入由执行层单独控制，不能因为当前 shell 不支持 function 注入就改变模型看到的
// tool/prompt surface。
const ENABLE_EMBEDDED_SEARCH_BRANCH = true;

// 能力评估输入：bashAvailable 表示当前会话是否真能执行 Bash；
// embeddedSearchBranchEnabled 为 undefined 时按全局开关默认值判定，不做二次推断。
export interface EmbeddedSearchBranchCapabilityContext {
  // 会话实际可用的 Bash 能力；false 时嵌入式搜索分支不可用。
  bashAvailable: boolean;
  // 上层显式覆盖开关；省略表示沿用全局 ENABLE_EMBEDDED_SEARCH_BRANCH。
  embeddedSearchBranchEnabled?: boolean;
}

// 决策原因，供日志和诊断使用：supported 可用，其余两种为不可用原因。
// disabled_by_global_flag 优先于 bash_unavailable，保证开关关闭时原因稳定。
export type EmbeddedSearchBranchCapabilityReason =
  | "supported"
  | "disabled_by_global_flag"
  | "bash_unavailable";

// 评估结果：useEmbeddedSearchBranch 是唯一的消费口径，reason 仅用于解释；
// 两者必须保持一致，不能出现 reason=supported 但 useEmbeddedSearchBranch=false。
export interface EmbeddedSearchBranchCapabilityDecision {
  reason: EmbeddedSearchBranchCapabilityReason;
  useEmbeddedSearchBranch: boolean;
}

// 纯函数能力判定：先看全局/显式开关，再看 Bash 可用性，返回不带副作用的决策对象。
// 顺序固定，开关关闭时不读取 bashAvailable 结论，避免把配置问题误报成环境缺失。
// 不抛错：所有不可用情况都折算成 reason + false，调用方按结果降级。
export function evaluateEmbeddedSearchBranchCapability(
  context: EmbeddedSearchBranchCapabilityContext,
): EmbeddedSearchBranchCapabilityDecision {
  // 显式值（含 false）优先于全局默认，保证调用方可以单独关闭某次会话的分支。
  const branchEnabled = context.embeddedSearchBranchEnabled ?? ENABLE_EMBEDDED_SEARCH_BRANCH;

  if (!branchEnabled) {
    return {
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    };
  }

  if (!context.bashAvailable) {
    return {
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    };
  }

  return {
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}

// 与 evaluate 等价的结构化入参版本，只做字段搬运，不缓存、不校验额外条件。
// 供上层按命名参数调用，返回值与 evaluate 完全同构，便于两条入口共享同一判定。
export function resolveEmbeddedSearchBranchCapability(input: {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}): EmbeddedSearchBranchCapabilityDecision {
  return evaluateEmbeddedSearchBranchCapability({
    bashAvailable: input.bashAvailable,
    embeddedSearchBranchEnabled: input.embeddedSearchBranchEnabled,
  });
}
