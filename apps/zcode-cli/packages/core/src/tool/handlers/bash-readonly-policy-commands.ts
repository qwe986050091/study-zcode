/**
 * 只读策略的"命令族"聚合层：把 simple-commands 的逐命令表与 git 子命令表、多词前缀表
 * 组装成三个 Map 再对外导出，供 bash-readonly-policy-argv.ts / -argv-git.ts /
 * -argv-direct.ts 查询。
 * 这里只做拼装，不改变任何条目；未出现在 Map 中的命令/子命令即不在白名单，
 * 由 evaluateBashReadonlyPolicy 返回 undefined（上层按不可读处理）。
 */

import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE } from "./bash-readonly-policy-git-subcommands-core.js";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY } from "./bash-readonly-policy-git-subcommands-history.js";
import { READONLY_MULTIWORD_POLICY_ENTRIES_CORE } from "./bash-readonly-policy-multiword-core.js";
import { READONLY_MULTIWORD_POLICY_ENTRIES_GH } from "./bash-readonly-policy-multiword-gh.js";

export {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES,
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
} from "./bash-readonly-policy-simple-commands.js";

// git 子命令只读策略表：合并 core 与 history 两组条目，键为两词形式 "git <子命令>"。
// 合并顺序为 core 在前、history 在后，同键时后者覆盖前者；当前两组键不相交。
// 只读常量 Map，无 IO；未登记的子命令不会命中，调用方按 undefined（不可读）处理。
export const GIT_READONLY_SUBCOMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE,
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY,
]);

export const READONLY_MULTIWORD_COMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...READONLY_MULTIWORD_POLICY_ENTRIES_CORE,
  ...READONLY_MULTIWORD_POLICY_ENTRIES_GH,
]);
