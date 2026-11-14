// INV-01 未登记即需审批：守住位置 白名单缺省；改错故障 未知参数被静默放行。
// INV-02 git 全局 flag 三分类：守住位置 三个集合；改错故障 危险 flag 落入只读分支。
// INV-03 带值全局 flag 当前为空：守住位置 空集合；改错故障 误放行带值全局参数。
// INV-04 重定向类一律危险：守住位置 危险集合；改错故障 指定仓库目录绕过权限。
// INV-05 危险集合先于白名单判断：守住位置 查表顺序；改错故障 白名单覆盖危险项。
// INV-06 命令级策略三种形态：守住位置 策略对象字段；改错故障 参数形态被误判。
// INV-07 裸命令最严格：守住位置 仅命令判断；改错故障 带参调用被判只读。
// INV-08 任意参数需真无害：守住位置 放宽标记；改错故障 写操作命令进入只读。
// INV-09 安全 flag 未列出即拒绝：守住位置 集合查找；改错故障 新 flag 默认放行。
// INV-10 双横线语义可关闭：守住位置 标志位；改错故障 待处理内容被截断解析。
// INV-11 回调补充逐命令判断：守住位置 附加判断函数；改错故障 特定子命令写文件。
// INV-12 正则限定的命令不认位置参数：守住位置 整行匹配；改错故障 位置参数改写系统状态。
// INV-13 兜底集合只放无写命令：守住位置 注释约束；改错故障 用户数据被改写。
// INV-14 兜底集合先于逐命令表：守住位置 判定顺序；改错故障 严格策略被放宽覆盖。
// INV-15 兜底集合绕过 flag 限制：守住位置 集合语义；改错故障 带写 flag 的命令放行。
// INV-16 docker 只放列举子命令：守住位置 两词前缀；改错故障 启动容器被判只读。
// INV-17 前缀按段比较：守住位置 元组数组；改错故障 相似命令被误命中。
// INV-18 表结构只读：守住位置 导出常量；改错故障 运行期修改污染全局判定。
//
// 模块职责：单命令只读策略表，供 argv 查表与整体判定使用。
// 状态所有权：全部为模块级常量，运行期不修改。
// 阅读顺序：先看 git 全局分类，再看逐命令白名单，最后看兜底集合与前缀。
/**
 * 单命令只读策略表：git 全局 flag 分类（NO_VALUE / VALUE / DANGEROUS）、逐命令
 * READONLY_COMMAND_POLICIES、放宽集合 READONLY_ALLOW_ANY_ARG_COMMANDS 与
 * docker 多词前缀（docker images / docker ps）。
 * 输入形态是 bash-command-parser.ts 产出的 argv；由 bash-readonly-policy-argv.ts 查表，
 * 再由 bash-semantics.ts 汇总为整体只读判定。
 * 口径：只登记"参数不可能写文件/改系统状态"的命令与 flag；没登记即不可只读，
 * 宁可多要一次审批，也不放行未知的参数形态。
 */

import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  dateCommandIsDangerous,
  jqCommandIsDangerous,
  lsofCommandIsDangerous,
  manCommandIsDangerous,
  psCommandIsDangerous,
  pyrightCommandIsDangerous,
  sedCommandIsDangerous,
  ssCommandIsDangerous,
  testCommandIsDangerous,
  tputCommandIsDangerous,
  xargsCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";
import {
  BASE64_SAFE_FLAGS,
  CAT_SAFE_FLAGS,
  DATE_SAFE_FLAGS,
  FD_SAFE_FLAGS,
  FILE_SAFE_FLAGS,
  GREP_SAFE_FLAGS,
  HEAD_TAIL_SAFE_FLAGS,
  HOSTNAME_SAFE_FLAGS,
  JQ_SAFE_FLAGS,
  LSOF_SAFE_FLAGS,
  MAN_SAFE_FLAGS,
  NETSTAT_SAFE_FLAGS,
  PGREP_SAFE_FLAGS,
  PS_SAFE_FLAGS,
  PYRIGHT_SAFE_FLAGS,
  RG_SAFE_FLAGS,
  SED_SAFE_FLAGS,
  SHA_SUM_SAFE_FLAGS,
  SORT_SAFE_FLAGS,
  SS_SAFE_FLAGS,
  TEST_SAFE_FLAGS,
  TPUT_SAFE_FLAGS,
  TREE_SAFE_FLAGS,
  WC_SAFE_FLAGS,
  XARGS_SAFE_FLAGS,
} from "./bash-readonly-policy-flags.js";

// git 全局 flag 分三类：只控制输出的（--no-pager/--paginate，不改变执行方向）、
// 需要带值的（当前为空，因为不存在可安全放行的带值全局 flag）、以及会改变执行上下文的危险项。
// 只登记不改变执行方向的 flag。
// GIT_GLOBAL_VALUE_FLAGS 当前刻意留空。
// GIT_GLOBAL_DANGEROUS_FLAGS 含配置与目录重定向。
// 三个 Set 互不重叠，归属唯一。
// 新增 flag 先判断归属。
export const GIT_GLOBAL_NO_VALUE_FLAGS = new Set(["--no-pager", "--paginate"]);
export const GIT_GLOBAL_VALUE_FLAGS = new Set<string>();
// -c / -C 让 git 在指定配置或目录下运行（可触发外部 hooks、读取任意 config）；
// --git-dir / --work-tree / --namespace 重定向仓库位置；--exec-path 替换子命令实现。
// 这些一律判为不可只读，而不是尝试解析它们后面的值。
export const GIT_GLOBAL_DANGEROUS_FLAGS = new Set([
  "-c",
  "-C",
  "--attr-source",
  "--bare",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--shallow-file",
  "--super-prefix",
  "--work-tree",
]);

// 逐命令白名单：commandOnly = 只允许裸命令；allowAnyArgs = 参数不影响写语义；
// safeFlags = 只允许表中的 flag。未列出的命令由 evaluateBashReadonlyPolicy 返回 undefined，
// 上层即按可写/需审批处理。
// commandOnly 只允许裸命令，最严格。
// allowAnyArgs 仅用于无写命令。
// 安全 flag 未列出的参数一律拒绝。
// respectsDoubleDash 为 false 时关闭双横线语义。
// evaluator 回调负责子命令级追加判断。
// Map 里未登记的命令由上层按需审批。
export const READONLY_COMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ["alias", { commandOnly: true }],
  // 这些命令的 `--` 不是参数终止符，而是待处理内容的一部分。
  ["base64", { safeFlags: BASE64_SAFE_FLAGS, respectsDoubleDash: false }],
  ["cat", { safeFlags: CAT_SAFE_FLAGS }],
  // cd 只允许一个目标参数；更长的 argv 在 evaluateBashReadonlyPolicy 里单独拒绝。
  ["cd", { allowAnyArgs: true }],
  ["cut", { allowAnyArgs: true }],
  [
    "date",
    { safeFlags: DATE_SAFE_FLAGS, additionalCommandIsDangerousCallback: dateCommandIsDangerous },
  ],
  ["diff", { allowAnyArgs: true }],
  ["dirname", { allowAnyArgs: true }],
  ["du", { allowAnyArgs: true }],
  ["echo", { allowAnyArgs: true }],
  ["egrep", { safeFlags: GREP_SAFE_FLAGS }],
  ["false", { commandOnly: true }],
  ["fd", { safeFlags: FD_SAFE_FLAGS }],
  ["file", { safeFlags: FILE_SAFE_FLAGS }],
  // find 的实际判定先由 argv-direct 的 isSafeFindArgv 返回布尔，这里的 allowAnyArgs 不会生效。
  ["find", { allowAnyArgs: true }],
  ["fgrep", { safeFlags: GREP_SAFE_FLAGS }],
  ["fdfind", { safeFlags: FD_SAFE_FLAGS }],
  ["grep", { safeFlags: GREP_SAFE_FLAGS }],
  ["head", { safeFlags: HEAD_TAIL_SAFE_FLAGS }],
  ["help", { safeFlags: { "-d": "none", "-m": "none", "-s": "none" } }],
  ["hexdump", { allowAnyArgs: true }],
  // hostname 带非 flag 位置参数会设置主机名（写操作），regex 限定只能出现 flag。
  [
    "hostname",
    { safeFlags: HOSTNAME_SAFE_FLAGS, regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/ },
  ],
  ["id", { allowAnyArgs: true }],
  ["jq", { safeFlags: JQ_SAFE_FLAGS, additionalCommandIsDangerousCallback: jqCommandIsDangerous }],
  [
    "lsof",
    { safeFlags: LSOF_SAFE_FLAGS, additionalCommandIsDangerousCallback: lsofCommandIsDangerous },
  ],
  ["ls", { allowAnyArgs: true }],
  [
    "man",
    { safeFlags: MAN_SAFE_FLAGS, additionalCommandIsDangerousCallback: manCommandIsDangerous },
  ],
  ["md5sum", { safeFlags: SHA_SUM_SAFE_FLAGS }],
  ["netstat", { safeFlags: NETSTAT_SAFE_FLAGS }],
  ["nl", { allowAnyArgs: true }],
  ["pgrep", { safeFlags: PGREP_SAFE_FLAGS }],
  ["ps", { safeFlags: PS_SAFE_FLAGS, additionalCommandIsDangerousCallback: psCommandIsDangerous }],
  [
    "pyright",
    {
      safeFlags: PYRIGHT_SAFE_FLAGS,
      respectsDoubleDash: false,
      additionalCommandIsDangerousCallback: pyrightCommandIsDangerous,
    },
  ],
  ["printf", { allowAnyArgs: true }],
  ["pwd", { commandOnly: true }],
  ["readlink", { allowAnyArgs: true }],
  ["realpath", { allowAnyArgs: true }],
  ["rev", { allowAnyArgs: true }],
  ["rg", { safeFlags: RG_SAFE_FLAGS }],
  [
    "sed",
    { safeFlags: SED_SAFE_FLAGS, additionalCommandIsDangerousCallback: sedCommandIsDangerous },
  ],
  ["sha1sum", { safeFlags: SHA_SUM_SAFE_FLAGS }],
  ["sha256sum", { safeFlags: SHA_SUM_SAFE_FLAGS }],
  ["sort", { safeFlags: SORT_SAFE_FLAGS }],
  ["ss", { safeFlags: SS_SAFE_FLAGS, additionalCommandIsDangerousCallback: ssCommandIsDangerous }],
  ["stat", { allowAnyArgs: true }],
  ["strings", { allowAnyArgs: true }],
  ["tail", { safeFlags: HEAD_TAIL_SAFE_FLAGS }],
  [
    "test",
    {
      safeFlags: TEST_SAFE_FLAGS,
      respectsDoubleDash: false,
      additionalCommandIsDangerousCallback: testCommandIsDangerous,
    },
  ],
  [
    "tput",
    { safeFlags: TPUT_SAFE_FLAGS, additionalCommandIsDangerousCallback: tputCommandIsDangerous },
  ],
  ["tr", { allowAnyArgs: true }],
  ["tree", { safeFlags: TREE_SAFE_FLAGS }],
  ["true", { commandOnly: true }],
  ["uniq", { allowAnyArgs: true }],
  ["uname", { allowAnyArgs: true }],
  ["wc", { safeFlags: WC_SAFE_FLAGS }],
  ["which", { allowAnyArgs: true }],
  ["whoami", { commandOnly: true }],
  [
    "xargs",
    { safeFlags: XARGS_SAFE_FLAGS, additionalCommandIsDangerousCallback: xargsCommandIsDangerous },
  ],
  [
    "[",
    {
      safeFlags: TEST_SAFE_FLAGS,
      respectsDoubleDash: false,
      additionalCommandIsDangerousCallback: testCommandIsDangerous,
    },
  ],
  [
    "[[",
    {
      safeFlags: TEST_SAFE_FLAGS,
      respectsDoubleDash: false,
      additionalCommandIsDangerousCallback: testCommandIsDangerous,
    },
  ],
]);

// 兜底放宽集合：在 direct/prefix 策略未命中时直接判只读。因为它在逐命令白名单之前生效，
// 列出的命令会绕过 safeFlags 限制，所以只能放"参数不可能造成写入"的命令。
// READONLY_ALLOW_ANY_ARG_COMMANDS 在逐命令表之前生效。
// 因此 Set 里不能放任何写操作命令。
// 仅收录 argv 只影响查询的命令。
// 新增条目先在 bash-readonly-policy 测试里确认无副作用。
// Set 条目顺序无关但保持字母序。
// 与 READONLY_COMMAND_POLICIES 重复的条目是有意为之。
export const READONLY_ALLOW_ANY_ARG_COMMANDS = new Set([
  "basename",
  "cal",
  "cat",
  "cmp",
  "column",
  "comm",
  "cut",
  "df",
  "diff",
  "dirname",
  "du",
  "expand",
  "expr",
  "false",
  "fmt",
  "fold",
  "free",
  "groups",
  "head",
  "hexdump",
  "id",
  "locale",
  "nl",
  "nproc",
  "numfmt",
  "od",
  "paste",
  "pr",
  "readlink",
  "realpath",
  "rev",
  "seq",
  "sleep",
  "stat",
  "strings",
  "tac",
  "tail",
  "tr",
  "true",
  "tsort",
  "type",
  "uname",
  "unexpand",
  "uptime",
  "wc",
  "which",
]);

// 只放行 docker 的列举子命令；参数里的镜像/容器名只会缩小查询范围，不改变 daemon 状态。
// 只收 docker 的两词前缀。
// docker 列举子命令不改变 daemon 状态。
// argv 里的镜像名或容器名只缩小查询范围。
// prefix 按数组逐段比较。
// 新增 prefix 需同族审查。
// 不把 argv 拼成一条过长命令串。
export const READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES = [
  ["docker", "images"],
  ["docker", "ps"],
] as const;
