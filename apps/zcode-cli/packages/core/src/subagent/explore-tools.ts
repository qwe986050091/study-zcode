// 对齐文件搜索型子 agent 的工具面。direct branch 会暴露 Glob/Grep；
// embedded search branch 则通过 Bash find/grep 接管搜索。注意：白名单刻意不含任何
// 文件写工具（Write/Edit/ApplyPatch），因此 Bash 是唯一的副作用入口，只读语义靠 Explore prompt 约束。
// 本文件只维护“允许哪些工具”与“如何向模型描述这些工具”，不负责过滤或执行。
// 工具列表顺序会影响描述文案的优先级展示，但集合成员才是权限真相。
export const EXPLORE_AGENT_ALLOWED_TOOLS = [
  "ToolSearch",
  "DeferredToolCall",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

// 允许工具名的联合类型，供配置、profile 与校验逻辑共用，避免散落字符串。
export type ExploreAgentAllowedTool = (typeof EXPLORE_AGENT_ALLOWED_TOOLS)[number];

// 内嵌搜索（embedded search）模式的白名单：不含 Glob/Grep，搜索改由 Bash 的
// find/grep 承担，其余读工具保持不变。
export const EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS = [
  "ToolSearch",
  "DeferredToolCall",
  "Bash",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

// 面向模型描述时的展示优先级（不是权限顺序）：先列检索类工具，再列辅助工具。
const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY = [
  "Glob",
  "Grep",
  "Read",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const satisfies readonly ExploreAgentAllowedTool[];
// 优先级集合用于在格式化时去重，避免同一工具既走优先序列又走尾部追加。
const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET = new Set<ExploreAgentAllowedTool>(
  EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY,
);

// 按搜索模式选择 Explore 白名单：embeddedSearchEnabled 为真时用内嵌搜索集合，
// 否则用常规集合（含 Glob/Grep）。undefined 明确按常规模式处理。
// 返回的是共享只读常量数组，调用方不得就地修改；无 IO、无副作用。
export function buildExploreAllowedTools(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): readonly ExploreAgentAllowedTool[] {
  return options.embeddedSearchEnabled
    ? EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS
    : EXPLORE_AGENT_ALLOWED_TOOLS;
}

// 生成 agent description 中 “(Tools: ...)” 的工具名列表文本，逗号分隔。
// 输出顺序：先按展示优先级排列的已允许工具，再追加未列入优先级的其余工具；
// ToolSearch / DeferredToolCall 属于内部调度能力，刻意不出现在描述里。
// 不筛选权限、不改动入参，纯粹是展示层格式化。
export function formatExploreAllowedToolsForAgentDescription(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): string {
  const allowedTools = buildExploreAllowedTools(options);
  // 用交集而非直接遍历优先级表，保证描述里不会出现当前模式未允许的工具。
  const allowedToolSet = new Set(allowedTools);
  const prioritizedTools = EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY.filter((tool) =>
    allowedToolSet.has(tool),
  );
  // 尾部追加：保留未来新增但未进优先级表的工具，仅排除内部调度类工具。
  const unprioritizedTools = allowedTools.filter(
    (tool) =>
      tool !== "ToolSearch" &&
      tool !== "DeferredToolCall" &&
      !EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET.has(tool),
  );
  return [...prioritizedTools, ...unprioritizedTools].join(", ");
}
