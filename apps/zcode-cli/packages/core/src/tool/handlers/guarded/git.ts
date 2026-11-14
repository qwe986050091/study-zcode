// INV-01 前置参数只跳过不解释：守住位置 FRONT 表；改错故障 配置内容被当作命令解析。
// INV-02 前置不支持即整条放弃：守住位置 front.unsupported；改错故障 误判为安全命令。
// INV-03 前置操作数动态即放弃：守住位置 dynamic 判断；改错故障 变量拼出的命令被放行。
// INV-04 未识别子命令返回未定义：守住位置 default 分支；改错故障 未知命令默认安全。
// INV-05 帮助标志视为查询退出：守住位置 hasHelp 判断；改错故障 帮助请求被当成危险操作。
// INV-06 干扰项取反优先：守住位置 enabled 第三参；改错故障 --no-force 仍判强推。
// INV-07 试运行抑制破坏判定：守住位置 dryRun 合取；改错故障 dry-run 被拦截。
// INV-08 reset 只认硬重置：守住位置 hard 标志；改错故障 软重置也被要求确认。
// INV-09 clean 需强制且非试运行：守住位置 合取条件；改错故障 预演被拦或真删被放。
// INV-10 push 证据三选一：守住位置 析取条件；改错故障 漏判镜像或租约强推。
// INV-11 repo 参数改变操作数含义：守住位置 refspecs 分支；改错故障 首个操作数被误当远端。
// INV-12 加号前缀即强推证据：守住位置 startsWith；改错故障 glob 场景漏判。
// INV-13 checkout 命中工作树即破坏：守住位置 TREE 集合；改错故障 覆盖未提交修改。
// INV-14 restore 仅暂存区不判破坏：守住位置 stagedOnly；改错故障 常规暂存被误拦。
// INV-15 stash 只处理 clear：守住位置 子命令判断；改错故障 保存操作被当成删除。
// INV-16 worktree 只处理强制删除：守住位置 remove 判断；改错故障 新建工作树被误拦。
// INV-17 规则标识即契约键：守住位置 字符串常量；改错故障 审批文案与规则错配。
// INV-18 解析器只读不改词：守住位置 words 入参；改错故障 调用方观察到被改写的参数。
//
// 模块职责：判定 git 子命令是否属于需要确认的破坏性操作。
// 状态所有权：无状态；选项表为模块级只读常量。
// 阅读顺序：先看前置参数处理，再看子命令分派，最后看各规则条件。
import {
  COMMAND_SCAN,
  enabled,
  optionTable,
  parseOptions,
  settleRule,
  WRAPPER_SCAN,
} from "./options.js";
import type { CommandWord } from "./word.js";

// 前置参数走 abort 策略，未知即整体 unsupported，因此这里必须认识 -c/-p/-P/--exec-path 这类常见前置项；
// -c 只按取值 arity 跳过，不解释配置内容。
// FRONT 第一组是无取值布尔开关（--no-pager、--bare 等）。
// FRONT 第二组是必须取值的选项（-C、--git-dir、-c 等）。
// FRONT 第三组是取值可选的选项（--exec-path）。
// optionTable 的调用只声明文法，不解释 git 语义。
const FRONT = optionTable(
  "--no-pager -P --paginate -p --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --bare --no-replace-objects --no-optional-locks",
  "-C --git-dir --work-tree --namespace -c --config-env --super-prefix",
  "--exec-path",
);
const HELP = "-h --help";
const COMMON = `${HELP} -q --quiet -v --verbose`;
const RESET = optionTable(
  `${COMMON} --hard --soft --mixed --merge --keep -p --patch -N --intent-to-add --no-refresh --refresh --recurse-submodules --no-recurse-submodules`,
);
const CLEAN = optionTable(
  `${COMMON} -f --force -d -x -X -n --dry-run --no-dry-run -i --interactive`,
  "-e --exclude",
);
const PUSH = optionTable(
  `${COMMON} -f --force --no-force --mirror --no-mirror -n --dry-run --no-dry-run --no-force-with-lease --force-if-includes --no-force-if-includes --all --branches --tags --delete -d --prune --atomic --no-atomic --porcelain --follow-tags --no-follow-tags --set-upstream -u --thin --no-thin --progress --no-progress --ipv4 -4 --ipv6 -6`,
  "--repo --receive-pack --exec -o --push-option",
  "--force-with-lease --signed --recurse-submodules",
);
const CHECKOUT = optionTable(
  `${COMMON} -f --force --no-force --detach --ours --theirs -m --merge --conflict -p --patch --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --no-overlay --overlay`,
  "-b -B --orphan --conflict",
);
const RESTORE = optionTable(
  `${COMMON} -W --worktree --no-worktree -S --staged --no-staged --ours --theirs -m --merge -p --patch --ignore-unmerged --overlay --no-overlay --recurse-submodules --no-recurse-submodules`,
  "-s --source --conflict",
);
const FORCE = ["-f", "--force"];
const TREE = new Set([".", "./", ":/"]);
export type RuleMatch = string | false | undefined;

/** false=已支持且未命中；undefined=超出当前命令/选项文法。 */
// matchGit 先 parseOptions(words, FRONT, WRAPPER_SCAN) 剥前置。
// front.unsupported 或首操作数 dynamic 时返回 undefined。
// 剥完没有 head 时返回 false，表示已支持但未命中。
// switch (head.value) 选对应子命令的选项表。
// 最终交给 settleRule(规则名, parsed) 结算。
export function matchGit(words: CommandWord[]): RuleMatch {
  const front = parseOptions(words, FRONT, WRAPPER_SCAN);
  if (front.unsupported || front.operands[0]?.dynamic) return undefined;
  const [head, ...args] = front.operands;
  if (!head) return false;
  let table;
  switch (head.value) {
    case "reset":
      table = RESET;
      break;
    case "clean":
      table = CLEAN;
      break;
    case "push":
      table = PUSH;
      break;
    case "checkout":
      table = CHECKOUT;
      break;
    case "restore":
      table = RESTORE;
      break;
    case "stash": {
      if (args[0]?.dynamic) return undefined;
      if (args[0]?.value !== "clear") return false;
      const parsed = parseOptions(args.slice(1), optionTable(HELP), COMMAND_SCAN);
      return settleRule(!hasHelp(parsed.flags) && "git-stash-clear", parsed);
    }
    case "worktree": {
      if (args[0]?.dynamic) return undefined;
      if (args[0]?.value !== "remove") return false;
      const parsed = parseOptions(
        args.slice(1),
        optionTable(`${HELP} -f --force --no-force`),
        COMMAND_SCAN,
      );
      return settleRule(
        !hasHelp(parsed.flags) &&
          enabled(parsed.flags, FORCE, ["--no-force"]) &&
          "git-worktree-force-remove",
        parsed,
      );
    }
    default:
      return undefined;
  }
  const parsed = parseOptions(args, table, COMMAND_SCAN);
  const { flags, operands } = parsed;
  // Git 的 -h/--help 是可靠的查询退出；未知选项不改变这一点，也不抹去已识别的 force/hard。
  if (hasHelp(flags)) return false;
  // dryRun 用 enabled() 读取，第三个参数给出取反形式。
  // 取反形式优先于肯定形式，--no-dry-run 压过 -n。
  // dryRun 与 force 参与多条规则的合取。
  // hasHelp(flags) 在上方已提前 return false。
  // 强推判定只看 force，与 dryRun 无耦合。
  const dryRun = enabled(flags, ["-n", "--dry-run"], ["--no-dry-run"]);
  const force = enabled(flags, FORCE, ["--no-force"]);
  switch (head.value) {
    case "reset":
      return settleRule(
        enabled(flags, ["--hard"], ["--soft", "--mixed", "--merge", "--keep", "-p", "--patch"]) &&
          "git-reset-hard",
        parsed,
      );
    case "clean":
      return settleRule(!dryRun && force && "git-clean-force", parsed);
    case "push": {
      const refspecs = flags.includes("--repo") ? operands : operands.slice(1);
      // glob 会让整词标为 dynamic，但已知的 + 前缀仍是强推证据。
      return settleRule(
        !dryRun &&
          (force ||
            enabled(flags, ["--force-with-lease"], ["--no-force-with-lease"]) ||
            enabled(flags, ["--mirror"], ["--no-mirror"]) ||
            refspecs.some((w) => w.value.startsWith("+"))) &&
          "git-push-force",
        parsed,
      );
    }
    case "checkout":
      return settleRule(
        (force || operands.some((w) => !w.dynamic && TREE.has(w.value))) && "git-discard-tree",
        parsed,
      );
    case "restore": {
      const stagedOnly =
        enabled(flags, ["-S", "--staged"], ["--no-staged"]) &&
        !enabled(flags, ["-W", "--worktree"], ["--no-worktree"]);
      return settleRule(
        !stagedOnly && operands.some((w) => !w.dynamic && TREE.has(w.value)) && "git-discard-tree",
        parsed,
      );
    }
    default:
      return false;
  }
}

function hasHelp(flags: string[]): boolean {
  return flags.includes("--help") || flags.includes("-h");
}
