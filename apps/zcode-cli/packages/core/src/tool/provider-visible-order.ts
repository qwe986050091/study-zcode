// 参与“稳定参考顺序”的内置工具名白名单。名单内的工具按名称字典序输出，
// 名单外的工具（MCP/延迟/动态工作流等）保持注册顺序并整体排在其后。
const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "CronUpdate",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "NotebookEdit",
  "Read",
  "ScheduleWakeup",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);

/**
 * 决定 provider 可见工具合同的拼接顺序（只影响顺序，不决定可见性）。
 * 输入：已按可见性/模型过滤后的合同数组；输出新数组，不修改入参。
 * 规则：白名单内置工具按 name 字典序排在前面，其余工具保持原注册顺序排在后面。
 * 为什么这样排：内置工具集合跨 session/turn 基本稳定，固定字典序能让 provider 请求
 * 的前缀保持稳定（利于 prompt 缓存与回归对比）；动态工具放尾部，其增删只影响尾段。
 * 纯函数；同名项会保持相对稳定性由 sort 实现决定，调用方不应依赖重复名。
 */
export function orderProviderVisibleToolContracts<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const referenceTools: T[] = [];
  const localTools: T[] = [];
  for (const tool of tools) {
    if (SORTED_PROVIDER_TOOL_NAMES.has(tool.name)) {
      referenceTools.push(tool);
    } else {
      localTools.push(tool);
    }
  }

  return [
    // sort 作用于本函数内的临时数组，不会重排调用方传入的 tools。
    ...referenceTools.sort((left, right) => left.name.localeCompare(right.name)),
    ...localTools,
  ];
}
