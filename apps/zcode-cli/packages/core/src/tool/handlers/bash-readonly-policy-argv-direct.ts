/**
 * "精确 argv / 少量自定义文法"的只读判定：
 *  - 整条命令必须完全等于某个白名单 argv（node -v、ip addr 等）；
 *  - docker 的列举前缀 + 拒绝危险全局 flag；
 *  - printf / find / history / arch / ifconfig 用函数逐参数校验。
 * 由 bash-readonly-policy-argv.ts 在 git 之后、多词前缀之前调用；返回 undefined 表示
 * 本文件不负责该命令，交给后续白名单。任何无法穷举参数含义的情况都返回 false（保守）。
 */

import { READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES } from "./bash-readonly-policy-commands.js";
import { hasDangerousDockerOption } from "./bash-readonly-policy-callbacks.js";

// find 的写能力不止 -delete：-exec/-execdir/-ok 会执行命令，-fls/-fprint* 会写文件，
// -files0-from 会读任意 NUL 分隔清单，全部必须判为写。
const FIND_WRITE_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-files0-from",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

export function isFindWriteOption(word: string): boolean {
  return FIND_WRITE_OPTIONS.has(word);
}

// 这些 find 选项会吃掉后面一个参数；必须跳过，否则值会被误当成下一个选项/路径来判定。
const FIND_VALUE_OPTIONS = new Set([
  "-Bmin",
  "-Bnewer",
  "-Btime",
  "-D",
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-context",
  "-ctime",
  "-f",
  "-flags",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-iwholename",
  "-lname",
  "-links",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mnewer",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-samefile",
  "-size",
  "-type",
  "-used",
  "-user",
  "-wholename",
  "-xattrname",
  "-xtype",
  "-uid",
]);

export function evaluateDirectReadonlyArgv(argv: readonly string[]): boolean | undefined {
  if (argvMatchesAny(argv, READONLY_EXACT_ARGV_COMMANDS)) return true;
  // docker 列举命令仍要排除 -H/--context 等全局 flag：它们把请求指向别的 daemon。
  if (argv[0] === "docker" && argvMatchesAnyPrefix(argv, READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES))
    return !hasDangerousDockerOption(argv);
  if (argv[0] === "printf") return isSafePrintfArgv(argv);
  // find 在这里总是返回布尔（不再落到通用表），所以 simple-commands 里的 find 条目不会生效。
  if (argv[0] === "find") return isSafeFindArgv(argv);
  // 裸 history 只打印；带参数只接受数字条数。-c/-w/-a 会清空或写历史文件，必须拒绝。
  if (argv[0] === "history")
    return argv.length === 1 || (argv.length === 2 && /^\d+$/.test(argv[1] ?? ""));
  if (argv[0] === "arch")
    return argv.length === 1 || (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help"));
  // ifconfig 只在无参数或单接口名（纯字母开头）时算只读，避免 "up/down" 之类改网络状态。
  if (argv[0] === "ifconfig")
    return argv.length === 1 || (argv.length === 2 && /^[a-zA-Z]/.test(argv[1] ?? ""));
  return undefined;
}

const READONLY_EXACT_ARGV_COMMANDS = [
  ["ip", "addr"],
  ["node", "-v"],
  ["node", "--version"],
  ["python", "--version"],
  ["python3", "--version"],
] as const;

function argvMatchesAny(
  argv: readonly string[],
  expectedCommands: readonly (readonly string[])[],
): boolean {
  return expectedCommands.some((expected) => {
    return argv.length === expected.length && expected.every((word, index) => argv[index] === word);
  });
}

function argvMatchesAnyPrefix(
  argv: readonly string[],
  expectedCommands: readonly (readonly string[])[],
): boolean {
  return expectedCommands.some((expected) => {
    return argv.length >= expected.length && expected.every((word, index) => argv[index] === word);
  });
}

function isSafePrintfArgv(argv: readonly string[]): boolean {
  // 带其它选项的 printf（如 -v）语义未知；`--` 之后才是格式串。
  if (argv[1]?.startsWith("-") && argv[1] !== "--") return false;
  const formatIndex = argv[1] === "--" ? 2 : 1;
  const format = argv[formatIndex] ?? "";
  // 格式串里出现 $ 说明还留着参数展开，实际输出不可确定。
  if (format.includes("$")) return false;
  const normalizedFormat = format.replace(/%%/g, "");
  // ANSI-C 转义（\0nnn、\xHH、\uHHHH）会二次解释格式串，直接拒绝。
  if (/%[^%a-zA-Z]*(?:hh|ll|[lLhqjzZt])?\\[0-7xX]/.test(normalizedFormat)) return false;
  if (/\\[uU]/.test(normalizedFormat)) return false;
  const numericFormat = /%[-+ 0#']*[0-9.*]*(?:hh|ll|[lLhqjzZt])?[diouxXeEfFgGaAn]/.test(
    normalizedFormat,
  );
  // 有数值转换符时，剩余参数必须全是数字字面量；出现 [ / 反引号 / $( 说明参数可能被再次展开。
  if (numericFormat || /%[^%a-zA-Z]*\*/.test(normalizedFormat)) {
    for (let index = formatIndex + 1; index < argv.length; index += 1) {
      const value = argv[index] ?? "";
      if (value.includes("[") || value.includes("`") || value.includes("$(")) return false;
      if (
        !/^[-+]?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?)$/.test(
          value,
        )
      )
        return false;
    }
  }
  return true;
}

function isSafeFindArgv(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    if (isFindWriteOption(word)) return false;
    // 取值型选项（-name/-type/...）后面的参数是值而不是选项，跳过它再继续校验。
    if (FIND_VALUE_OPTIONS.has(word) || /^-newer[aBcm][aBcmt]$/.test(word)) {
      index += 1;
      continue;
    }
  }
  return true;
}
