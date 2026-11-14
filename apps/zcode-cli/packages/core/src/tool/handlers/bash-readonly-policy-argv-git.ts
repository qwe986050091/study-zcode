/**
 * git 命令的只读判定：先把全局 flag 规范化（去掉 --no-pager 之类、拒绝危险全局项），
 * 再按"词数从长到短"匹配子命令前缀白名单（GIT_READONLY_SUBCOMMAND_POLICIES）。
 * 由 bash-readonly-policy-argv.ts 在 argv[0] === "git" 时直接调用；bash-semantics.ts
 * 还会先检查运行目录的 git 上下文（bash-git-runtime-safety.ts）。
 * 失败语义：规范化不出一条 git 子命令（只剩 flag、未知全局 flag、危险全局 flag）返回 false，
 * 未命中任何子命令前缀同样返回 false——不在白名单的 git 子命令一律视为可写。
 */

import {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_READONLY_SUBCOMMAND_POLICIES,
} from "./bash-readonly-policy-commands.js";
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { isArgvAllowedByPolicy } from "./bash-readonly-policy-argv-flags.js";

// git 的 -c/-C 支持粘连写法（-cKEY=VALUE、-C/path），单独成词已登记在危险集合，这里补粘连形式。
const GIT_ATTACHED_DANGEROUS_SHORT_FLAGS = ["-c", "-C"];

export function isGitReadOnlyCommand(argv: readonly string[]): boolean {
  const normalized = normalizeGitArgv(argv);
  if (!normalized) return false;

  // 长前缀优先：`git config --get` 必须先于候选的 `git config` 被匹配到。
  for (const [commandPrefix, policy] of sortedGitPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => normalized[index] === word)) continue;
    if (
      policy.additionalCommandIsDangerousCallback?.(
        commandPrefix,
        normalized.slice(prefixWords.length),
      )
    )
      return false;
    return isArgvAllowedByPolicy(normalized, policy, "git", prefixWords.length);
  }

  return false;
}

function normalizeGitArgv(argv: readonly string[]): readonly string[] | undefined {
  const normalized = ["git"];
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word) continue;
    // 纯输出控制类全局 flag，去掉后不影响子命令语义。
    if (GIT_GLOBAL_NO_VALUE_FLAGS.has(word)) continue;
    if (hasDangerousGitGlobalOptionWord(word)) return undefined;
    if (GIT_GLOBAL_VALUE_FLAGS.has(word)) {
      // 登记为取值型时连同下一个 argv 一起跳过；缺值说明写法不完整，判不可读。
      index += 1;
      if (!argv[index]) return undefined;
      continue;
    }
    // 未登记的全局 flag 一律拒绝，避免把 `git -x status` 误当成 `git status`。
    if (word.startsWith("-")) return undefined;
    // 第一个非 flag 词起全是子命令与参数，交给前缀白名单。
    normalized.push(...argv.slice(index));
    return normalized;
  }

  // 只有全局 flag、没有子命令：没有可判定的动作。
  return undefined;
}

export function hasDangerousGitGlobalOption(argv: readonly string[]): boolean {
  return argv.some(hasDangerousGitGlobalOptionWord);
}

function hasDangerousGitGlobalOptionWord(word: string): boolean {
  if (hasDangerousAttachedGitShortOptionWord(word)) return true;
  if (GIT_GLOBAL_DANGEROUS_FLAGS.has(word)) return true;
  return [...GIT_GLOBAL_DANGEROUS_FLAGS].some((flag) => word.startsWith(`${flag}=`));
}

function hasDangerousAttachedGitShortOptionWord(word: string): boolean {
  return GIT_ATTACHED_DANGEROUS_SHORT_FLAGS.some((flag) => {
    return (
      word.length > flag.length &&
      word.startsWith(flag) &&
      // -C 任何粘连形式都危险；-c 后紧跟 `-` 说明可能只是短 flag 簇，留给其它规则判断。
      (flag === "-C" || word[flag.length] !== "-")
    );
  });
}

let gitPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedGitPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  gitPoliciesByLength ??= [...GIT_READONLY_SUBCOMMAND_POLICIES.entries()].sort((left, right) => {
    return right[0].split(" ").length - left[0].split(" ").length;
  });
  return gitPoliciesByLength;
}
