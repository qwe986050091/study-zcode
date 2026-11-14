/**
 * Bash 工具提供给 provider 的描述文本（模型看到的工具说明）。
 * 由 bash.ts 的 toolEntry 构建时传入 default/max timeout 与 embeddedSearch 能力开关；
 * 只影响提示文案，不参与权限判定。embeddedSearch 开启时已有内置检索工具，
 * 因此不再劝退 grep/find，只劝退 cat/head/sed 这类文件查看命令。
 */

// 构建 Bash 工具暴露给模型的描述文本（纯字符串，无副作用）。
// defaultTimeoutMs/maxTimeoutMs 单位均为毫秒并原样写入文案；embeddedSearchEnabled 未传视为 false。
// 只影响模型提示，不参与权限或执行判定；同一输入始终返回同一文案。
export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  // 是否劝退 find/grep 取决于宿主是否提供内置搜索，避免模型放着更好的工具不用。
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    // 这几条对应 bash.ts 的真实行为：cwd 跨调用持久化、shell 环境不持久化、后台任务跨轮次运行。
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "",
    "# Git",
    // 非 TTY 执行环境里 git 的交互式命令会挂起，因此明确禁止模型使用。
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
