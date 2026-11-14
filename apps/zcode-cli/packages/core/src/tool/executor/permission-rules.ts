// ============================================================
// executor/permission-rules.ts —— 权限规则增量的纯函数合并
// ============================================================
// 只做一件事：把 PermissionUpdate(addRules) 合并进 PermissionRuleset；不读写存储、不做权限判定。
// 语义：只增不删、按 toolName + ruleContent 去重、version 归一为 1（当前无迁移需求）。
// 不变量：合并只可能让规则集"多出允许/询问/拒绝条目"；实际优先级由 PermissionService 固定，
//   不靠数组顺序，因此这里只保证去重与分组正确，不承担"谁压过谁"。

import type { PermissionRuleset, PermissionUpdate } from "@zcode/contracts";

/**
 * 返回新的 ruleset（不修改入参）。每个 update 只处理 addRules：按 behavior 取现有组，
 * 追加后去重。非 addRules 的 update 被忽略（当前契约只有这一种类型，分支留作向前兼容）。
 */
export function applyPermissionUpdates(
  current: PermissionRuleset,
  updates: PermissionUpdate[],
): PermissionRuleset {
  // 复制并归并版本号：规则集同时出现在存储与 wire 上，不能让调用方共享可变对象。
  let next: PermissionRuleset = {
    ...current,
    version: 1,
  };

  for (const update of updates) {
    // 只支持追加；未来若加 removeRules，必须在这里显式分支，不能默默忽略。
    if (update.type !== "addRules") continue;
    const existing = getPermissionRules(next, update.behavior);
    // 按 behavior 分组写回：allow/deny/ask 各自独立，不会把一条规则串到别的组。
    next = {
      ...next,
      [update.behavior]: dedupePermissionRules([...existing, ...update.rules]),
    };
  }

  return next;
}

/** 读某个 behavior 的规则数组；缺失/非数组一律当空组，兼容只声明了部分字段的 ruleset（含 wire 数据）。 */
function getPermissionRules(
  ruleset: PermissionRuleset,
  behavior: PermissionUpdate["behavior"],
): NonNullable<PermissionRuleset["allow"]> {
  const rules = ruleset[behavior];
  return Array.isArray(rules) ? rules : [];
}

/**
 * 按 `${toolName}\0${ruleContent}` 去重，保留首次出现的位置。
 * 用 \0 作分隔符：toolName/ruleContent 都可能含普通分隔符，而 \0 不会出现在两者中，
 * 避免 "a|b" 与 "a"+"|b" 拼出同一个键被误删。
 */
function dedupePermissionRules(
  rules: NonNullable<PermissionRuleset["allow"]>,
): NonNullable<PermissionRuleset["allow"]> {
  const seen = new Set<string>();
  const deduped: NonNullable<PermissionRuleset["allow"]> = [];

  for (const rule of rules) {
    const key = `${rule.toolName}\u0000${rule.ruleContent ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(rule);
  }

  return deduped;
}
