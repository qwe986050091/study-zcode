// 自动化轮必须禁止再创建/修改/删除定时任务，防止自我复制式调度。
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;

// 合并而不是覆盖：调用方原有的 deny 项必须保留。
export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  // 先复制现有 deny 名单：直接改调用方传入的数组会污染上层策略，Set 同时承担去重。
  const merged = new Set(current);
  // 逐个加入而不是整体替换：automation 轮之外的 deny 项（例如 Bash 限制）必须原样保留。
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  // Set 转数组沿用首次插入顺序，便于日志比对；重复项已在 Set 内合并。
  return [...merged];
}

// 闲时派发轮只 deny OffPeakCreate（防止闲时任务递归自我派生、无限调度），OffPeakList 只读保留。
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation 轮
// 明确放行 OffPeakCreate（定时派生闲时任务），混入会让 automation 轮误 deny。
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

// 闲时轮单独维护一份名单，绝不能与 automation 轮共用。
export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  // 同样先复制再合并：绝不能复用 automation 轮那份名单常量，否则两轮会互相放开对方的限制。
  const merged = new Set(current);
  // 只加 OffPeakCreate：OffPeakList 是只读查询必须保留，混入会让闲时轮看不到已有任务。
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  // 返回顺序沿用调用方原有项在前、新增项在后，调试时能一眼看出哪些是合并进来的。
  return [...merged];
}
