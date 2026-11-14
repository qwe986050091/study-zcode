/**
 * gh 限流提示：Bash 输出里出现 GitHub API rate limit 报错时，给模型追加一条 system-reminder，
 * 建议先查 rate_limit 并等待重置，而不是盲目重试。由 bash-output.ts / bash.ts 在结果组装阶段调用。
 * 只对真正的 gh 命令生效（排除 auth/help/config 等本地子命令），并带 60s 全局冷却避免刷屏。
 */

const GH_RATE_LIMIT_HINT_COOLDOWN_MS = 60_000;
// 命令边界匹配 gh，并排除 auth/help/version/alias/completion/config 这类不访问 API 的子命令。
const GH_COMMAND_RE =
  /(?:^|[;&|]|\b(?:then|do)\b)\s*gh\s+(?!auth\b|help\b|version\b|alias\b|completion\b|config\b)/;
// 同时识别 primary/secondary 限流文案与结构化 RATE_LIMITED 输出。
const GH_RATE_LIMIT_RE =
  /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\bRATE_LIMITED\b/i;
const GH_RATE_LIMIT_HINT =
  "<system-reminder>GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and sleep until reset before further gh calls. If polling in a loop, use ScheduleWakeup instead of retrying.</system-reminder>";
let nextGhRateLimitHintAt = 0;

// 根据被执行的命令文本与输出，决定是否追加 gh 限流 system-reminder。
// 返回 string 表示命中且未处于冷却期；返回 undefined 表示命令不是 gh、输出无限流字样或仍在 60s 冷却内。
// 副作用仅为更新模块级冷却时间戳（进程内共享），不改输出、不写日志、不访问网络。
export function getGhRateLimitHint(command: string, output: string): string | undefined {
  // 必须同时满足"命令是 gh"且"输出含限流字样"；单独命中任一条都不提示。
  if (!GH_COMMAND_RE.test(command) || !GH_RATE_LIMIT_RE.test(output)) return undefined;
  const now = Date.now();
  // 冷却期内重复的限流输出不再追加提示，避免批量执行时提示爆炸。
  if (now < nextGhRateLimitHintAt) return undefined;
  nextGhRateLimitHintAt = now + GH_RATE_LIMIT_HINT_COOLDOWN_MS;
  return GH_RATE_LIMIT_HINT;
}
