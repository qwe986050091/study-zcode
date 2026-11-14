/**
 * wrapper（env / time / sudo）剥离：危险命令匹配前先把包装层去掉，避免把
 * "sudo rm -rf" 误当成一个名为 sudo 的未知命令而漏检。纯函数，无 IO、无状态。
 * 失败语义：无法确定 wrapper 的选项边界时返回 undefined，调用方据此判 unsupported，
 * 绝不能把未剥离的 argv 继续当作真实命令检查。
 */

import { optionTable, parseOptions, WRAPPER_SCAN } from "./options.js";
import { commandBasename, type CommandWord } from "./word.js";

// 已知 wrapper 的选项表：左列为无值开关，右列为需要消费一个值的选项。
// 表外的 wrapper 名称不会被剥离，而是直接视为真实命令参与后续规则判定。
const WRAPPERS = {
  env: optionTable("-i --ignore-environment -0 --null -v --debug", "-u --unset -C --chdir"),
  time: optionTable(
    "-a --append -p --portability -v --verbose -q --quiet",
    "-o --output -f --format",
  ),
  sudo: optionTable(
    "-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin",
    "-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot",
  ),
} as const;

// 剥离 env/time/sudo 等 wrapper，返回真实命令的词序列，供危险命令匹配使用。
// 输入是词法分析后的 CommandWord[] 与是否 Windows 平台；返回 undefined 表示无法确定真实命令。
// 纯函数、无 IO/状态；遇到不认识的 wrapper 选项或词被剥空时整体放弃，避免误判真实命令。
export function unwrapCommand(input: CommandWord[], windows: boolean): CommandWord[] | undefined {
  let words = input;
  // 循环处理可嵌套 wrapper（如 sudo env ...），每次只剥掉当前首词这一层。
  while (words.length) {
    const name = commandBasename(words[0]!, windows);
    if (!name) return undefined;
    if (!(name in WRAPPERS)) return words;
    // wrapper 的未知选项决定真实命令从哪个词开始，猜不出只能整体放弃。
    const parsed = parseOptions(
      words.slice(1),
      WRAPPERS[name as keyof typeof WRAPPERS],
      WRAPPER_SCAN,
    );
    if (parsed.unsupported) return undefined;
    words = parsed.operands;
    if (name === "env" || name === "sudo") {
      // KEY=VALUE 是 wrapper 自身的环境注入，不属于真实命令，继续剥掉。
      while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1);
    }
  }
  // 词被逐层剥空仍没找到真实命令，按无法判定返回 undefined。
  return undefined;
}
