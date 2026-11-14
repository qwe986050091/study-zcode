/**
 * 危险命令识别：把一条 shell 命令按 dialect 解析成若干 invocation，逐个套用规则表。
 * 纯函数，不做 IO、不执行命令；输出只描述"是否命中、命中的规则 id 与字符区间"。
 * 失败语义：解析失败或存在无法判定的语法时返回 unsupported，而不是 notMatched——
 * 调用方必须把 unsupported 当成"不可确认安全"，绝不能降级为放行。
 * 不变量：一旦命中即立即返回，规则优先级由 matchInvocation 的判定顺序决定。
 */

import type { ExecutionShellSelection } from "@zcode/contracts";
import { analyzeBashCommand } from "../bash-command-parser.js";
import { analyzeCmdCommand } from "./cmd.js";
import { matchGit, type RuleMatch } from "./git.js";
import { matchFindDelete } from "./find.js";
import { matchCmdDelete, matchRobocopyDelete } from "./windows-delete.js";
import { COMMAND_SCAN, enabled, optionTable, parseOptions, settleRule } from "./options.js";
import { unwrapCommand } from "./wrappers.js";
import { commandBasename, type CommandWord } from "./word.js";

export type DangerousCommandResult =
  | { status: "matched"; ruleId: string; start: number; end: number }
  | { status: "notMatched" | "unsupported" };

// rm 的选项表：危险判定只关心递归/强制等开关，其余展示类选项仅用于跳过取值。
const RM = optionTable(
  "-r -R --recursive -f --force -i -I --one-file-system --preserve-root --no-preserve-root -v --verbose -d --dir --help --version",
  "",
  "--interactive",
);
const RSYNC_DELETE = [
  "--delete",
  "--del",
  "--delete-before",
  "--delete-during",
  "--delete-delay",
  "--delete-after",
  "--delete-excluded",
];
// rsync 的删除类选项集合单独列出：只有出现其中之一才构成"可能删除远端/本地文件"。
const RSYNC = optionTable(
  `-a -r -v -q -z -h -P -p -t -g -o -D -l -H -A -X -u -c -n --dry-run --archive --recursive --verbose --quiet --compress --progress --partial --checksum --update --numeric-ids --ignore-errors --force --help --version ${RSYNC_DELETE.join(" ")}`,
  "-e --rsh -f --filter --include --exclude --include-from --exclude-from --files-from --rsync-path --log-file --out-format --backup-dir --suffix --chmod --chown --max-delete --timeout --bwlimit --compare-dest --copy-dest --link-dest",
);
// 解释器名单：这些命令的真实行为无法从 argv 静态推断，一律不判为危险（交给权限层）。
// 注意这是"不命中"而不是"安全"：调用方仍需按不可静态确认处理。
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  "eval",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
]);
// 命令长度上限：超长命令解析成本与误判风险都不可控，直接判 unsupported。
const MAX_LENGTH = 10_000;

// 主入口：dialect 决定用 cmd 还是 bash 解析器；legacy-shell 无法可靠解析，直接 unsupported。
// 命中时返回规则 id 与原始字符区间（start/end），供上层高亮定位；未命中返回 notMatched。
// 只要任一 invocation 无法确定真实命令或含动态片段，就把整体降级为 unsupported。
// 无副作用、可重复调用；同一命令重复判定结果一致。
export function matchDangerousCommand(
  command: string,
  dialect: ExecutionShellSelection["dialect"],
): DangerousCommandResult {
  // 超长命令与 legacy-shell 都不具备可靠解析能力，宁可判 unsupported 也不猜。
  if (command.length > MAX_LENGTH || dialect === "legacy-shell") return { status: "unsupported" };
  const windows = dialect === "cmd" || dialect === "git-bash";
  let commands: CommandWord[][];
  let unsupported: boolean;
  if (dialect === "cmd") {
    ({ commands, unsupported } = analyzeCmdCommand(command));
  } else {
    const analysis = analyzeBashCommand(command);
    // 解析失败没有可依赖的定位；局部 unsupported 节点则不丢弃其它独立命令。
    if (analysis.hasParseErrors) return { status: "unsupported" };
    commands = analysis.commands.map((c) => c.words);
    unsupported = analysis.hasUnsupportedSyntax;
  }
  for (const invocation of commands) {
    // wrapper 无法剥离时保留其余 invocation 的判定结果，只把当前这条记为不确定，
    // 避免一条 sudo 失败就放弃对整条命令链的检查。
    const words = unwrapCommand(invocation, windows);
    if (!words?.[0]) {
      unsupported = true;
      continue;
    }
    const name = commandBasename(words[0], windows);
    const result = name ? matchInvocation(name, words.slice(1), dialect) : undefined;
    if (result)
      return {
        status: "matched",
        ruleId: `safety.bash.${result}`,
        start: words[0].start,
        end: words.at(-1)!.end,
      };
    // result 为 false 表示"明确不危险"，可继续看下一条；但含动态词（变量/命令替换）时
    // 实际执行内容未知，只能保守记为 unsupported。
    if (result === undefined || words.some((word) => word.dynamic)) unsupported = true;
  }
  return { status: unsupported ? "unsupported" : "notMatched" };
}

// 单条 invocation 的规则分派：返回 false 明确安全、字符串规则 id 表示命中、undefined 表示无法判定。
// 判定顺序有意从具体到一般（git/解释器/平台删除命令 → 通用危险命令），避免宽规则吞掉精确规则。
function matchInvocation(
  name: string,
  args: CommandWord[],
  dialect: ExecutionShellSelection["dialect"],
): RuleMatch {
  if (name === "git") return matchGit(args);
  if (INTERPRETERS.has(name)) return undefined;
  if (dialect === "cmd" && ["rd", "rmdir", "del", "erase"].includes(name))
    return matchCmdDelete(name, args);
  if (dialect !== "cmd" && name === "find") return matchFindDelete(args);
  if ((dialect === "cmd" || dialect === "git-bash") && name === "robocopy")
    return matchRobocopyDelete(args, dialect);
  if (name === "rm") {
    const parsed = parseOptions(args, RM, COMMAND_SCAN);
    // BSD rm 在首个目标后不再解析选项；存在性扫描会吞掉后续 --help 等真实文件名。
    // 目标计数单独按该语义扫描，危险选项仍保留 GNU 的交错扫描，不探测运行平台。
    const targets = parseOptions(args, RM, { ordering: "stop-at-operand", unknown: "continue" });
    // 递归或语法上的批量即可；不展开目标，不用帮助/交互选项取消已知危险证据。
    return settleRule(
      (enabled(parsed.flags, ["-r", "-R", "--recursive"]) ||
        targets.operands.length >= 2 ||
        targets.operands.some((word) => word.hasUnquotedGlob)) &&
        "remove-critical-path",
      parsed,
    );
  }
  if (["dd", "mount", "umount", "mkfs"].includes(name) || /^mkfs\.[a-zA-Z0-9_-]+$/.test(name)) {
    // 只豁免独立且明确的查询形式，不能把 -o/其它参数值中的 --help 当成退出选项。
    if (args.length === 1 && !args[0]!.dynamic && ["--help", "--version"].includes(args[0]!.value))
      return false;
    return !(name === "mount" && args.length === 0) && "system-storage";
  }
  if (name === "rsync") {
    const parsed = parseOptions(args, RSYNC, COMMAND_SCAN);
    return settleRule(
      !parsed.flags.some((f) => ["-n", "--dry-run", "--help", "--version"].includes(f)) &&
        parsed.flags.some((f) => RSYNC_DELETE.includes(f)) &&
        "rsync-delete",
      parsed,
    );
  }
  return false;
}
