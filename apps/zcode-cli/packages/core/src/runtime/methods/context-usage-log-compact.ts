/**
 * ============================================================================
 * runtime/methods/context-usage-log-compact.ts —— context usage 快照的日志瘦身投影
 * ============================================================================
 * 【定位】链路 4 的遥测旁路：只在写日志前裁剪 context usage 快照，不改变真实用量与预算判断。
 * 【输入/输出】输入原始 usage snapshot；输出固定字段 + 计数 + top N contributor 的可序列化对象。
 * 【关键口径】快照可能很大（systemTools/skills 全量），这里只保留结构计数与 top 贡献者，
 *            防止单条日志超限；contributorCount 保留截断前数量，不能用 top N 长度代替。
 * ============================================================================
 */
const CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT = 5;

export function compactContextUsageSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  // 白名单投影：未列出的字段（包括未来新增的大字段）不会进入日志，保持日志体积可预期。
  // 工具/skill/提示词只留数量，明细在 categoryBreakdown 里按贡献度采样。
  return {
    tokenMethod: snapshot.tokenMethod,
    confidence: snapshot.confidence,
    tokenizer: snapshot.tokenizer,
    totalChars: snapshot.totalChars,
    totalTokens: snapshot.totalTokens,
    model: snapshot.model,
    categories: snapshot.categories,
    categoryBreakdown: compactCategoryBreakdown(snapshot.categoryBreakdown),
    messageBreakdown: snapshot.messageBreakdown,
    mcpToolCount: arrayLength(snapshot.mcpTools),
    skillCount: arrayLength(snapshot.skills),
    systemPromptSectionCount: arrayLength(snapshot.systemPromptSections),
    systemToolCount: arrayLength(snapshot.systemTools),
    warningCount: arrayLength(snapshot.warnings),
  };
}

function compactCategoryBreakdown(value: unknown): Array<Record<string, unknown>> | undefined {
  // 非数组不构造空分类：undefined 能区分"该快照没有 breakdown"与"确实为空"。
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isRecord).map((category) => {
    // 先过滤非对象贡献者再排序，避免脏数据在排序比较里抛错。
    const contributors = Array.isArray(category.contributors)
      ? category.contributors.filter(isRecord)
      : [];
    return {
      ...pickDefined(category, [
        "chars",
        "confidence",
        "name",
        "percentTokens",
        "source",
        "tokenMethod",
        "tokens",
        "tokenizer",
      ]),
      // 计数在截断前取：日志读者能知道还有多少贡献者没展示，top N 只是采样。
      contributorCount: contributors.length,
      // toSorted 复制后排序，不改原始 snapshot；降序取前 5 控制单条日志体积。
      contributors: contributors
        .toSorted((left, right) => contributorSortValue(right) - contributorSortValue(left))
        .slice(0, CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT)
        .map(compactContextUsageContributor),
    };
  });
}

function compactContextUsageContributor(
  contributor: Record<string, unknown>,
): Record<string, unknown> {
  return pickDefined(contributor, [
    "cacheHint",
    "categorySource",
    "chars",
    "confidence",
    "count",
    "injectionTarget",
    "kind",
    "label",
    "name",
    "path",
    "readOnly",
    "role",
    "scope",
    "serverName",
    "sideEffectScope",
    "source",
    "tokenMethod",
    "tokens",
    "tokenizer",
  ]);
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function contributorSortValue(contributor: Record<string, unknown>): number {
  // 排序优先级 tokens → chars → count：不同来源只填其中一种，取第一个可用值。
  // 全部缺失返回 0，保证比较函数始终返回数字且不产生 NaN 破坏稳定排序。
  const tokens = contributor.tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    return tokens;
  }
  const chars = contributor.chars;
  if (typeof chars === "number" && Number.isFinite(chars)) {
    return chars;
  }
  const count = contributor.count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function arrayLength(value: unknown): number | undefined {
  // 非数组返回 undefined 而不是 0：日志里"字段缺失"和"空数组"是两种不同事实。
  return Array.isArray(value) ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
