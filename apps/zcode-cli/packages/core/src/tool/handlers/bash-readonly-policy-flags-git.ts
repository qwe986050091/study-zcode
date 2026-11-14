// INV-01 片段只读：守住位置 每个常量表的内容；改错故障：写选项混进安全表，只读判断整体失效。
// INV-02 表外从严：守住位置 未被收录即走危险分支；改错故障：新选项默认放行。
// INV-03 取值标注：守住位置 需要参数的项声明；改错故障：argv 层把参数当成下一条命令。
// INV-04 开关标注：守住位置 无值项声明；改错故障：多消费一个 token，后续参数错位。
// INV-05 数字校验：守住位置 数字型取值；改错故障：非数字被当成条数接受。
// INV-06 复用优先：守住位置 通用片段；改错故障：各子命令重复维护，规则漂移。
// INV-07 片段单调：守住位置 通用片段不含写选项；改错故障：任意组合都带上危险能力。
// INV-08 组合顺序：守住位置 展开顺序；改错故障：专属项被同名通用项覆盖，来源难辨。
// INV-09 状态表限展示：守住位置 状态选项集合；改错故障：列格式化之外的写选项被收录。
// INV-10 diff 不写索引：守住位置 no-index 与只读选项；改错故障：比较动作触碰索引。
// INV-11 退出码语义：守住位置 安静与退出码选项；改错故障：只看退出码的调用被判成写操作。
// INV-12 子模块契约：守住位置 导出常量名；改错故障：core 与 history 引用不到片段。
// INV-13 类型约束：守住位置 satisfies 声明；改错故障：拼错取值类型却无编译报错。
// INV-14 无副作用：守住位置 模块体；改错故障：加载时读环境或写全局。
// INV-15 键名原样：守住位置 命令行写法；改错故障：改写短选项导致真实 argv 匹配不上。
// INV-16 大小写敏感：守住位置 原始键；改错故障：把大写选项当同义项放行。
// INV-17 单值语义：守住位置 string 与 number 标注；改错故障：多值命令只消费一个参数。
// INV-18 可审计：守住位置 注释与表项对应；改错故障：表项来源无法追溯，新增项无从核对。
//
// 模块职责：集中定义 git 只读 flag 表与可复用片段，供各子命令策略组合。
// 状态所有权：纯常量模块，无运行时状态。
// 阅读顺序：通用片段 → 子命令专属表 → log 组合表。
/**
 * git 的安全 flag 表与可复用片段（ref/date/log 样式/计数/stat/color/patch）。
 * 被 bash-readonly-policy-git-subcommands-core.ts / -history.ts 用展开运算符组合进各子命令 policy；
 * 片段本身只含输出/筛选类选项，不含 --delete、--force、-d、-D 这类写选项，
 * 因此拼出的集合仍然描述"只读列举/查看"。未被收录的 git flag 一律走危险分支。
 */

import type { SafeFlagValue } from "./bash-readonly-policy-types.js";

// ref 范围选择：只改变"看哪些 ref"，不产生任何写入，可安全复用到 log/show 等子命令。
// 只选择 ref 范围，不产生任何写入。
// 可复用到 log 与 show 等只读子命令。
//
export const COMMON_GIT_REF_FLAGS = {
  "--all": "none",
  "--branches": "none",
  "--remotes": "none",
  "--tags": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 时间筛选：四个选项都必须吃一个日期字符串，声明为 "string" 以便 argv 层跳过取值。
// 四个时间筛选都必须吃一个日期字符串。
// 声明为取值类型，argv 层才会跳过参数。
//
export const COMMON_GIT_DATE_FLAGS = {
  "--after": "string",
  "--before": "string",
  "--since": "string",
  "--until": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 输出样式：只影响渲染，不改变仓库状态；--date 需要取值，其余为开关。
// 输出样式只影响渲染，不改变仓库状态。
// --date 需要取值，其余 flag 都是无值开关。
//
export const COMMON_GIT_LOG_STYLE_FLAGS = {
  "--date": "string",
  "--decorate": "none",
  "--graph": "none",
  "--no-decorate": "none",
  "--oneline": "none",
  "--relative-date": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 条数限制：值为数字，argv 层必须校验并消费一个数字 token，否则视为未知。
// 条数限制的值为数字，argv 层必须校验。
// 无法消费到数字时按未知选项处理。
//
export const COMMON_GIT_COUNT_FLAGS = {
  "-n": "number",
  "--max-count": "number",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 统计输出样式：均为无值开关，只改变展示粒度，不触发 diff 计算之外的行为。
// --stat 类选项只改展示粒度，不写盘。
// 全部无值，不触发 diff 之外的行为。
//
export const COMMON_GIT_STAT_FLAGS = {
  "--name-only": "none",
  "--name-status": "none",
  "--numstat": "none",
  "--shortstat": "none",
  "--stat": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 颜色开关：只影响 ANSI 输出，不影响退出码或仓库状态。
// --color 只影响 stdout，不影响只读判定。
// 不影响退出码，也不影响仓库状态。
//
export const COMMON_GIT_COLOR_FLAGS = {
  "--color": "none",
  "--no-color": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// patch 输出控制：-p/-s 被收录为无值开关，表示"关闭 patch 输出"这一侧的语义。
// patch 控制项表示关闭或开启输出。
// 这些 flag 全为无值开关，可跨子命令复用。
//
export const COMMON_GIT_PATCH_FLAGS = {
  "-p": "none",
  "-s": "none",
  "--no-ext-diff": "none",
  "--no-patch": "none",
  "--patch": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// git status 的安全表：全部为展示/筛选选项；--porcelain 等只是格式切换。
// 表外的 flag（尤其 --column=never 之外的写入类）一律走危险分支，不做猜测。
// 状态表全部是展示与筛选选项。
// 不在表中的 option 一律判危险，不猜语义。
//
export const GIT_STATUS_SAFE_FLAGS = {
  "-b": "none",
  "-M": "string",
  "-s": "none",
  "-u": "string",
  "--ahead-behind": "none",
  "--branch": "none",
  "--column": "none",
  "--find-renames": "string",
  "--ignore-submodules": "string",
  "--ignored": "none",
  "--long": "none",
  "--no-ahead-behind": "none",
  "--no-column": "none",
  "--no-renames": "none",
  "--porcelain": "none",
  "--renames": "none",
  "--short": "none",
  "--untracked-files": "string",
  "--verbose": "none",
  "-v": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// --no-index 只比较两个文件、不触碰索引，--quiet/--exit-code 也只是改变退出码语义，
// 因此可以把它们放进 diff 的安全表。
// diff 表刻意收录不触碰索引的选项。
// --quiet 与 --exit-code 只改语义，不写盘。
//
export const GIT_DIFF_SAFE_FLAGS = {
  "-B": "none",
  "-C": "none",
  "-D": "none",
  "-G": "string",
  "-M": "none",
  "-O": "string",
  "-R": "none",
  "-S": "string",
  "-l": "none",
  "-p": "none",
  "-s": "none",
  "-u": "none",
  "--cached": "none",
  "--check": "none",
  "--color": "none",
  "--color-words": "none",
  "--diff-algorithm": "string",
  "--diff-filter": "string",
  "--dirstat": "none",
  "--exit-code": "none",
  "--find-copies": "none",
  "--find-copies-harder": "none",
  "--find-renames": "none",
  "--full-index": "none",
  "--function-context": "none",
  "--histogram": "none",
  "--ignore-all-space": "none",
  "--ignore-blank-lines": "none",
  "--ignore-space-at-eol": "none",
  "--ignore-space-change": "none",
  "--inter-hunk-context": "number",
  "--irreversible-delete": "none",
  "--minimal": "none",
  "--name-only": "none",
  "--name-status": "none",
  "--no-ext-diff": "none",
  "--no-index": "none",
  "--no-renames": "none",
  "--no-color": "none",
  "--numstat": "none",
  "--patch-with-stat": "none",
  "--patience": "none",
  "--pickaxe-all": "none",
  "--pickaxe-regex": "none",
  "--quiet": "none",
  "--relative": "string",
  "--shortstat": "none",
  "--staged": "none",
  "--stat": "none",
  "--summary": "none",
  "--word-diff": "none",
  "--word-diff-regex": "string",
  "--ws-error-highlight": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// git log 的安全表：在通用片段之上补齐 log 专属的筛选/排序选项，
// 组合顺序刻意保持"通用片段在前、专属项在后"，便于阅读时快速区分来源。
// log 表先铺通用片段再补专属项。
// 顺序保持来源可辨，便于核对覆盖范围。
//
export const GIT_LOG_SAFE_FLAGS = {
  ...COMMON_GIT_LOG_STYLE_FLAGS,
  ...COMMON_GIT_REF_FLAGS,
  ...COMMON_GIT_DATE_FLAGS,
  ...COMMON_GIT_COUNT_FLAGS,
  ...COMMON_GIT_STAT_FLAGS,
  ...COMMON_GIT_COLOR_FLAGS,
  ...COMMON_GIT_PATCH_FLAGS,
  "-G": "string",
  "-S": "string",
  "--abbrev-commit": "none",
  "--ancestry-path": "none",
  "--author": "string",
  "--author-date-order": "none",
  "--boundary": "none",
  "--cherry-mark": "none",
  "--cherry-pick": "none",
  "--committer": "string",
  "--date-order": "none",
  "--dense": "none",
  "--diff-filter": "string",
  "--first-parent": "none",
  "--format": "string",
  "--full-history": "none",
  "--grep": "string",
  "--left-right": "none",
  "--max-age": "number",
  "--min-age": "number",
  "--merges": "none",
  "--no-max-parents": "none",
  "--no-merges": "none",
  "--no-min-parents": "none",
  "--no-walk": "none",
  "--pickaxe-all": "none",
  "--pickaxe-regex": "none",
  "--pretty": "string",
  "--reverse": "none",
  "--simplify-merges": "none",
  "--skip": "number",
  "--source": "none",
  "--sparse": "none",
  "--topo-order": "none",
  "--walk-reflogs": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// git show 的安全表：复用 log 样式与 stat/color/patch 片段，-m/--raw 只影响输出形态。
export const GIT_SHOW_SAFE_FLAGS = {
  ...COMMON_GIT_LOG_STYLE_FLAGS,
  ...COMMON_GIT_STAT_FLAGS,
  ...COMMON_GIT_COLOR_FLAGS,
  ...COMMON_GIT_PATCH_FLAGS,
  "-m": "none",
  "--abbrev-commit": "none",
  "--color-words": "none",
  "--diff-filter": "string",
  "--first-parent": "none",
  "--format": "string",
  "--pretty": "string",
  "--quiet": "none",
  "--raw": "none",
  "--word-diff": "none",
  "--word-diff-regex": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// git grep 的安全表：检索类选项，-e 需取值；--recurse-submodules 仅扩大检索范围不写盘。
export const GIT_GREP_SAFE_FLAGS = {
  "-A": "number",
  "-B": "number",
  "-C": "number",
  "-E": "none",
  "-F": "none",
  "-G": "none",
  "-H": "none",
  "-L": "none",
  "-P": "none",
  "-c": "none",
  "-e": "string",
  "-h": "none",
  "-i": "none",
  "-l": "none",
  "-n": "none",
  "-o": "none",
  "-q": "none",
  "-v": "none",
  "-w": "none",
  "--after-context": "number",
  "--and": "none",
  "--basic-regexp": "none",
  "--break": "none",
  "--cached": "none",
  "--color": "none",
  "--context": "number",
  "--count": "none",
  "--extended-regexp": "none",
  "--files-with-matches": "none",
  "--files-without-match": "none",
  "--fixed-strings": "none",
  "--full-name": "none",
  "--heading": "none",
  "--ignore-case": "none",
  "--invert-match": "none",
  "--line-number": "none",
  "--max-depth": "number",
  "--no-color": "none",
  "--no-index": "none",
  "--not": "none",
  "--only-matching": "none",
  "--or": "none",
  "--perl-regexp": "none",
  "--quiet": "none",
  "--recurse-submodules": "none",
  "--threads": "number",
  "--untracked": "none",
  "--word-regexp": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;
