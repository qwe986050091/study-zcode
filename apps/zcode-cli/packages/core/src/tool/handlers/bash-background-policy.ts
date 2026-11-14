/**
 * 决定一条 Bash 命令是否允许"前台超时后自动转后台"。
 * 被 bash.ts 在非显式后台路径上调用；返回 false 时超时仍按前台失败处理。
 * 口径保守：显式 run_in_background、空命令、以及 sleep 开头的命令一律不自动转后台。
 */

import type { BashInput } from "@zcode/contracts";

// 判定一条 Bash 命令是否允许在"前台超时"后自动转后台。
// 输入是工具原始 BashInput：run_in_background 为显式后台声明，command 仅按空白取首词，不解析引号/转义。
// 纯函数、无 IO/无状态；返回 false 表示超时后仍按前台失败处理，由调用方决定后续动作。
export function isBashAutoBackgroundEligible(input: BashInput): boolean {
  // 已显式要求后台的命令由 explicit 生命周期处理，这里不重复判定。
  if (input.run_in_background === true) return false;
  const command = input.command.trim();
  if (command.length === 0) return false;
  const firstToken = command.split(/\s+/u)[0];
  // sleep 常被用于"等待"，超时转后台只会留下无意义的常驻任务，因此排除。
  return firstToken !== "sleep";
}
