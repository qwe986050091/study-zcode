export const AGENT_TOOL_NAME = "Agent";
export const TASK_TOOL_NAME = "Task";

// Agent/Task 都是“派发子代理”的工具名；注册过滤与调度判定必须同时认这两个名字。
const subagentDispatchToolNames = new Set<string>([AGENT_TOOL_NAME, TASK_TOOL_NAME]);

/**
 * hook matcher 的别名扩展表：hook 配置里写下的工具名要同时匹配其兼容名字。
 * Agent ↔ Task、ApplyPatch ↔ Write/Edit 是历史配置与模型习惯各写一半的产物；
 * 若只按原名匹配，工具改名/换实现后 hook 会静默不触发——而 hook 承担权限收紧，
 * 不触发等于放宽。这里只扩大匹配集合，不改变实际执行的工具身份/权限。
 */
const hookMatcherAliasesByToolName = new Map<string, readonly string[]>([
  [AGENT_TOOL_NAME, [TASK_TOOL_NAME]],
  [TASK_TOOL_NAME, [AGENT_TOOL_NAME]],
  ["ApplyPatch", ["Write", "Edit"]],
]);

/**
 * 判断工具名是否属于“子代理派发”类工具。
 * 输入 toolName 可能 undefined（registry miss 的早退路径），此时返回 false。
 * 纯函数；消费者用它决定是否要求 includeAgent 才能注册、以及是否按子代理语义记账。
 */
export function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName ? subagentDispatchToolNames.has(toolName) : false;
}

/**
 * 返回某个工具名在 hook matcher 里应当匹配的全部名字（含自身）。
 * 无别名时返回 [toolName]；有别名时返回“原名 + 别名”的去重集合。
 * 输出顺序不影响匹配，只用于生成 hook payload 的 matchValues。
 * 纯函数；不读注册表，因此对尚未注册的工具名也同样安全。
 */
export function hookMatcherToolNamesForTool(toolName: string): readonly string[] {
  const aliases = hookMatcherAliasesByToolName.get(toolName) ?? [];
  if (aliases.length === 0) return [toolName];

  const values = new Set<string>([toolName]);
  for (const alias of aliases) values.add(alias);
  return [...values];
}
