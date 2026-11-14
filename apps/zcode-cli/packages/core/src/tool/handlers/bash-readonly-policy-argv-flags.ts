// INV-01 白名单外一律拒绝：守住位置 末尾兜底 return false；改错故障 未登记 flag 被放行。
// INV-02 allowAnyArgs 优先级最高：守住位置 首个分支；改错故障 本就无限制的命令被逐词误拒。
// INV-03 commandOnly 要求零参数：守住位置 argv.length === startIndex；改错故障 pwd 带参仍判只读。
// INV-04 无 safeFlags 即拒绝：守住位置 末尾 return false；改错故障 未声明策略的命令默认放行。
// INV-05 xargs 目标必须在白名单：守住位置 XARGS_TARGET_COMMANDS；改错故障 等于任意命令执行。
// INV-06 `--` 之后不再校验：守住位置 respectsDoubleDash；改错故障 把内容当 flag 误判。
// INV-07 紧凑数字条数是特例：守住位置 isCompactNumericCountFlag；改错故障 head -10 被判成非法 flag。
// INV-08 短 flag 粘连取值需二次校验：守住位置 parseShortFlagWithAttachedValue；改错故障 -Ifoo 绕过类型检查。
// INV-09 短 flag 簇必须全为 none 型：守住位置 isShortFlagClusterAllowed；改错故障 取值型 flag 吞掉后续参数。
// INV-10 none 型禁止内联取值：守住位置 hasInlineValue；改错故障 --verbose=x 被接受。
// INV-11 取值型优先内联再消费下一个：守住位置 索引推进；改错故障 取值被当成新 flag 重复校验。
// INV-12 取值本身像 option 时默认拒绝：守住位置 isOptionLikeStringValueAllowed；改错故障 仅 git --sort 的显式例外失效。
// INV-13 校验是纯函数：守住位置 全文件只读入参；改错故障 判定结果受调用顺序影响。
//
// 模块职责：按 flag 白名单逐 token 校验 argv，供通用命令与 git 子命令共用。
// 阅读顺序：先看三种策略分流，再看循环里 xargs/`--`/紧凑条数特例，最后看 flag 取值校验。
/**
 * 按 flag 白名单逐 token 校验 argv：所有以 `-` 开头的词必须是策略表登记过的 flag，
 * 且按 SafeFlagValue 验证其后取值；位置参数（文件名、pattern 等）放行。
 * 被 bash-readonly-policy-argv.ts（通用命令/多词前缀）与 -argv-git.ts（git 子命令）共用。
 * 失败语义：遇到任何未登记 flag、非法取值、xargs 目标命令不在白名单，一律返回 false；
 * 拿不准的形态（例如 flag 簇里混入取值型 flag）不做猜测。
 */

import { XARGS_TARGET_COMMANDS } from "./bash-readonly-policy-callbacks.js";
import { OPTION_PATTERN } from "./bash-readonly-policy-flags.js";
import type { BashReadonlyCommandPolicy, SafeFlagValue } from "./bash-readonly-policy-types.js";

export function isArgvAllowedByPolicy(
  argv: readonly string[],
  policy: BashReadonlyCommandPolicy,
  commandName: string,
  startIndex = 1,
): boolean {
  // 空 argv 没有命令可校验，直接拒绝。
  // 这条先于 allowAnyArgs，避免把空数组当合法调用。
  if (argv.length === 0) return false;
  if (policy.allowAnyArgs) return true;
  // commandOnly：命令后不允许任何参数（pwd/true/alias 等裸命令）。
  // startIndex 之后必须一个参数都没有。
  // 用等号而不是 <=：多一个位置参数也拒绝。
  if (policy.commandOnly) return argv.length === startIndex;
  if (policy.safeFlags) return flagsAndPositionalsAllowed(argv, policy, commandName, startIndex);
  return false;
}

function flagsAndPositionalsAllowed(
  argv: readonly string[],
  policy: BashReadonlyCommandPolicy,
  commandName: string,
  startIndex: number,
): boolean {
  const safeFlags = policy.safeFlags ?? {};
  let index = startIndex;
  while (index < argv.length) {
    const word = argv[index];
    if (!word) {
      index += 1;
      continue;
    }

    // xargs 真正的执行体是它后面的目标命令；目标必须本身在白名单里，否则等于任意执行。
    // xargs 的执行体是首个非 flag 词，必须本身在白名单里。
    // `--` 表示其后第一个词才是目标命令。
    // 命中后立即 break：目标命令之后的实参由目标自己决定。
    if (commandName === "xargs" && (!word.startsWith("-") || word === "--")) {
      const targetCommand = word === "--" ? argv[index + 1] : word;
      if (!targetCommand || !XARGS_TARGET_COMMANDS.has(targetCommand)) return false;
      break;
    }

    if (word === "--") {
      // base64/pyright/test 等的 `--` 会被当作内容而非分隔符，这些命令不在此收尾。
      // 这类命令的 `--` 是内容而非分隔符，跳过继续校验。
      // 默认把 `--` 当分隔符，其后不再检查。
      if (policy.respectsDoubleDash === false) {
        index += 1;
        continue;
      }
      break;
    }

    // head/tail 的 `-10` 是条数缩写，不是 flag 名（表里没有登记这种形态）。
    // `-10` 是条数缩写，不是可登记 flag。
    // 仅 head/tail 适用，其余命令的 -10 仍走正常校验。
    if (isHeadTailCompactCountFlag(commandName, word)) {
      index += 1;
      continue;
    }

    // git log -8 等由 policy 显式开启的紧凑数字条数写法。
    if (policy.allowCompactNumericCountFlag && isCompactNumericCountFlag(word)) {
      index += 1;
      continue;
    }

    if (word.startsWith("-") && word.length > 1 && OPTION_PATTERN.test(word)) {
      const parsed = parseOptionWord(word);
      const flagValue = safeFlags[parsed.flag];
      if (!flagValue) {
        // 未登记的 flag 名：先尝试 `-Ifoo` 这种短 flag 粘连取值（值本身还要校验）。
        // 未登记 flag 先尝试短 flag 粘连取值的形态。
        // 粘连出的值仍要过 option-like 与类型两道校验。
        // 都不成立才判失败，不做模糊放行。
        const shortAttached = parseShortFlagWithAttachedValue(word, safeFlags);
        if (shortAttached) {
          if (!isOptionLikeStringValueAllowed(shortAttached.value, commandName, shortAttached.flag))
            return false;
          if (!matchesFlagValueKind(shortAttached.value, shortAttached.kind)) return false;
          index += 1;
          continue;
        }
        // 再尝试 `-abc` 短 flag 簇，要求簇里每个 flag 都是"不取值"类型。
        if (isShortFlagClusterAllowed(parsed.flag, safeFlags)) {
          index += 1;
          continue;
        }
        return false;
      }

      // "none" 表示该 flag 不取值；`--flag=value` 这种内联写法和它矛盾，拒绝。
      // none 型不允许内联取值，`--flag=x` 与声明矛盾直接拒绝。
      if (flagValue === "none") {
        if (parsed.hasInlineValue) return false;
        index += 1;
        continue;
      }

      if (flagValue === "optionalString") {

        // 只拦截独立 argv 里看起来像 option 的字符串，避免误吞下一段参数。
        index += 1;
        continue;
      }

      // 其余类型必须有一个取值：优先内联 `=value`，否则消费下一个 argv。
      const value = parsed.hasInlineValue ? parsed.inlineValue : argv[index + 1];
      if (!isUsableFlagValue(value)) return false;
      if (
        flagValue === "string" &&
        !parsed.hasInlineValue &&
        !isOptionLikeStringValueAllowed(value, commandName, parsed.flag)
      )
        return false;
      if (!matchesFlagValueKind(value, flagValue)) return false;
      index += parsed.hasInlineValue ? 1 : 2;
      continue;
    }

    index += 1;
  }

  return true;
}

function parseShortFlagWithAttachedValue(
  word: string,
  safeFlags: Readonly<Record<string, SafeFlagValue>>,
): { flag: string; kind: SafeFlagValue; value: string } | undefined {
  if (!word.startsWith("-") || word.startsWith("--") || word.length <= 2) return undefined;
  const flag = word.slice(0, 2);
  const kind = safeFlags[flag];
  if (!kind || kind === "none") return undefined;
  return { flag, kind, value: word.slice(2) };
}

function isHeadTailCompactCountFlag(commandName: string, word: string): boolean {
  return (commandName === "head" || commandName === "tail") && /^-\d+$/.test(word);
}

function isCompactNumericCountFlag(word: string): boolean {
  return /^-\d+$/.test(word);
}

function parseOptionWord(word: string): {
  flag: string;
  hasInlineValue: boolean;
  inlineValue: string;
} {
  const equalsIndex = word.indexOf("=");
  if (equalsIndex < 0) return { flag: word, hasInlineValue: false, inlineValue: "" };
  return {
    flag: word.slice(0, equalsIndex),
    hasInlineValue: true,
    inlineValue: word.slice(equalsIndex + 1),
  };
}

function isShortFlagClusterAllowed(
  flag: string,
  safeFlags: Readonly<Record<string, SafeFlagValue>>,
): boolean {
  // 只有全部由 "none" 型 flag 组成的簇才可展开；含有取值型 flag 时无法判断后续 argv 归属。
  if (!flag.startsWith("-") || flag.startsWith("--") || flag.length <= 2) return false;
  for (const flagName of flag
    .slice(1)
    .split("")
    .map((name) => `-${name}`)) {
    if (safeFlags[flagName] !== "none") return false;
  }
  return true;
}

function isUsableFlagValue(value: string | undefined): value is string {
  return value !== undefined;
}

function isOptionLikeStringValueAllowed(value: string, commandName: string, flag: string): boolean {
  if (!value.startsWith("-") || value.length <= 1 || !OPTION_PATTERN.test(value)) return true;

  // 唯一例外：git --sort 的取值本身以 `-` 开头（如 -creatordate），否则会被误判成新 flag。
  return commandName === "git" && flag === "--sort" && /^-[a-zA-Z]/.test(value);
}

function matchesFlagValueKind(value: string, kind: SafeFlagValue): boolean {
  switch (kind) {
    case "none":
      return false;
    case "number":
      return /^\d+$/.test(value);
    case "optionalString":
      return true;
    case "string":
      return true;
    case "char":
      return value.length === 1;
    case "{}":
      return value === "{}";
    case "EOF":
      return value === "EOF";
  }
}
