/**
 * 把工具名归一成策略判定使用的名字（目前只有 `web_search` → `WebSearch`）。
 * 注意：这是可见性/禁用名单口径的别名，不是 registry 的 alias 解析；
 * 调用方两侧都必须归一，否则规则只写一边时会漏判。
 */
export function normalizeToolNameAlias(toolName: string): string {
  return toolName === "web_search" ? "WebSearch" : toolName;
}

/**
 * 从一条工具规则（如 `Bash(git push:*)`）中取出工具名部分。
 * 口径：截断第一个 `(` 及其后内容，再套用别名归一；空规则返回空串（由调用方过滤）。
 * 注意：`Bash(...)` 的括号内容在可见性层被丢弃——禁用名单只按“整个工具”生效，
 * 具体命令级的放行/拒绝由权限规则（permission）负责，不能在这里按子命令拆分。
 * 纯函数；不校验规则语法。
 */
export function getToolRuleName(rule: string): string {
  const trimmed = rule.trim();
  const parenIndex = trimmed.indexOf("(");
  const rawName = parenIndex > 0 ? trimmed.slice(0, parenIndex) : trimmed;
  return normalizeToolNameAlias(rawName);
}

/**
 * 把规则数组编译成工具名集合。
 * 返回 undefined 表示“没有规则”（空数组/全部为空名），让调用方走无过滤快速路径；
 * 返回非空 Set 表示至少有一条有效规则。集合里只有工具名，不含括号参数。
 * 纯函数；重复名自动去重。
 */
export function createToolRuleNameSet(
  rules: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!rules || rules.length === 0) return undefined;
  const names = new Set<string>();
  for (const rule of rules) {
    const name = getToolRuleName(rule);
    if (name) names.add(name);
  }
  return names.size > 0 ? names : undefined;
}

/**
 * 判断某个工具是否被禁用名单命中（toolName 与规则两侧都做别名归一）。
 * 返回 true 表示该工具不应注册/不应对模型可见；没有禁用名单时恒为 false。
 * 纯函数；只做“整工具”判定，不解释规则里的命令参数。
 */
export function isToolNameDisallowed(
  toolName: string,
  disallowedTools: readonly string[] | undefined,
): boolean {
  const disallowed = createToolRuleNameSet(disallowedTools);
  return disallowed?.has(normalizeToolNameAlias(toolName)) === true;
}

/**
 * 从工具名列表中过滤掉被禁用名单命中的项。
 * 无禁用名单时原样返回入参（不复制、不排序）；有名单时返回新数组并保持原顺序。
 * 纯函数；用于 subagent 工具面裁剪，不改变注册表本身。
 */
export function filterDisallowedToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  const disallowed = createToolRuleNameSet(disallowedTools);
  if (!disallowed) return toolNames;
  return toolNames.filter((toolName) => !disallowed.has(normalizeToolNameAlias(toolName)));
}
