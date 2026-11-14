/**
 * 只读判定的总调度：对单个 BashCommandInvocation 依次检查环境变量前缀、重定向、
 * wrapper 前缀、Windows UNC 路径，再按 git / 精确 argv / 多词前缀 / 放宽集合 / 逐命令
 * flag 白名单的顺序判定。
 * 输入来自 bash-command-parser.ts（argv 与 commandText 已规范化）；返回 true=只读、
 * false=明确可写、undefined=无法确定。调用方 bash-semantics.ts 把 undefined 与 false
 * 都当作不可读，因此这里只需要保证"不确定时不要返回 true"。
 * 也导出 hasKnownBashWriteOption，供 semantics 在整体判定前先短路写选项。
 */

import type { BashCommandInvocation } from "./bash-command-parser.js";
import {
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
  READONLY_MULTIWORD_COMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import { isSedInPlaceOption } from "./bash-readonly-policy-callbacks.js";
import {
  evaluateDirectReadonlyArgv,
  isFindWriteOption,
} from "./bash-readonly-policy-argv-direct.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";
import {
  hasDangerousGitGlobalOption,
  isGitReadOnlyCommand,
} from "./bash-readonly-policy-argv-git.js";
import {
  areEnvAssignmentsAllowed,
  areRedirectsAllowed,
  isUnsafeWindowsUncPath,
  stripSafeCommandWrappers,
} from "./bash-readonly-policy-argv-io.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";

export function evaluateBashReadonlyPolicy(
  commandPart: BashCommandInvocation,
): boolean | undefined {
  if (!areEnvAssignmentsAllowed(commandPart)) return false;
  // 输出重定向/追加写可能是唯一真正的写副作用，必须在任何命令白名单之前拦下。
  if (!areRedirectsAllowed(commandPart)) return false;

  const argv = stripSafeCommandWrappers(commandPart.argv);
  if (argv.length === 0) return false;
  // UNC 路径会触发 SMB/网络访问（Windows 上还可能长时间挂起），不属于本地只读。
  if (argv.some(isUnsafeWindowsUncPath)) return false;
  if (argv[0] === "git") return isGitReadOnlyCommand(argv);

  // 精确 argv 白名单与多词前缀先于通用白名单：它们能覆盖带位置参数的命令（docker ps 等）。
  const directArgvResult = evaluateDirectReadonlyArgv(argv);
  if (directArgvResult !== undefined) return directArgvResult;

  const prefixPolicyResult = evaluateReadonlyPrefixPolicy(argv, commandPart.commandText);
  if (prefixPolicyResult !== undefined) return prefixPolicyResult;

  if (READONLY_ALLOW_ANY_ARG_COMMANDS.has(argv[0] ?? "")) return true;
  // Windows 下 xargs 的行为与 POSIX 差异大（参数拼接/引号规则不同），明确不判定。
  if (process.platform === "win32" && argv[0] === "xargs") return undefined;

  const policy = READONLY_COMMAND_POLICIES.get(argv[0] ?? "");
  if (!policy) return undefined;
  // cd 只接受一个目标目录；多目标写法在部分 shell 里含义不同，直接判可写。
  if (argv[0] === "cd" && argv.length > 2) return false;
  if (policy.additionalCommandIsDangerousCallback?.(commandPart.commandText, argv.slice(1)))
    return false;
  if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "")) return false;
  if (policy.regex && !policy.regex.test(commandPart.commandText)) return false;
  return true;
}

export function hasKnownBashWriteOption(commandPart: BashCommandInvocation): boolean {
  // 只看少数"同一条命令既能读也能写"的情况：sed/find/tree 的输出参数与 git 的全局重定向参数。
  const argv = stripSafeCommandWrappers(commandPart.argv);
  const commandName = argv[0];
  if (commandName === "sed") return argv.some(isSedInPlaceOption);
  if (commandName === "find") return argv.some(isFindWriteOption);
  if (commandName === "tree") return treeArgvHasOutputOption(argv);
  if (commandName === "git") return hasDangerousGitGlobalOption(argv);
  return false;
}

function evaluateReadonlyPrefixPolicy(
  argv: readonly string[],
  commandText: string,
): boolean | undefined {
  // 按词数从长到短匹配，避免 `docker inspect` 被更短的通用前缀抢先命中。
  for (const [commandPrefix, policy] of sortedReadOnlyMultiwordPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => argv[index] === word)) continue;
    const args = argv.slice(prefixWords.length);
    // 前缀命中后仍可能带参数展开：$ 与 {a,b}/{1..2} 会改变参数个数，白名单无法预判。
    if (argsContainUnsafeSafeFlagText(args)) return false;
    if (policy.additionalCommandIsDangerousCallback?.(commandPrefix, args)) return false;
    if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "", prefixWords.length)) return false;
    if (policy.regex && !policy.regex.test(commandText)) return false;
    return true;
  }
  return undefined;
}

let readOnlyMultiwordPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedReadOnlyMultiwordPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  readOnlyMultiwordPoliciesByLength ??= [...READONLY_MULTIWORD_COMMAND_POLICIES.entries()].sort(
    (left, right) => {
      return right[0].split(" ").length - left[0].split(" ").length;
    },
  );
  return readOnlyMultiwordPoliciesByLength;
}

function argsContainUnsafeSafeFlagText(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg.includes("$") || (arg.includes("{") && (arg.includes(",") || arg.includes(".."))),
  );
}

function treeArgvHasOutputOption(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    // `--` 之后都是路径参数，不再有选项；提前结束避免把文件名 -o 当成输出选项。
    if (word === "--") return false;
    if (word === "-o" || word === "--output" || word.startsWith("--output=")) return true;
    if (word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes("o")) return true;
  }
  return false;
}
