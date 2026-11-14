// INV-01 表项键必须是「git 加子命令」两词前缀：守住位置 每个二元组首元素；改错故障 参数匹配落空，只读命令被误判为不可读。
// INV-02 未列出的参数一律判不可读：守住位置 各子命令白名单；改错故障 新参数被默认放行，写操作混进只读判定。
// INV-03 参数值类型只能是 none、string、number：守住位置 每个白名单条目；改错故障 解析器按错误元数吞掉后续位置参数。
// INV-04 有语义风险的子命令必须挂回调：守住位置 branch、for-each-ref、log 三处；改错故障 只按白名单放行，格式化串触发外部程序。
// INV-05 config 只覆盖取值形态：守住位置 该条目键字面量；改错故障 设置与取消形态被当作只读查询放行。
// INV-06 log 允许紧凑数字计数缩写：守住位置 allowCompactNumericCountFlag；改错故障 计划模式误拦纯历史查询。
// INV-07 颜色相关通用参数统一走共享常量：守住位置 公共颜色常量展开；改错故障 各子命令颜色支持不一致。
// INV-08 diff、grep、log 的白名单只能引用共享常量：守住位置 三处直接引用；改错故障 同一参数在多处漂移。
// INV-09 同一白名单内的键按字母序排列：守住位置 各白名单对象；改错故障 人工审阅漏看重复项。
// INV-10 branch 只保留列举形态：守住位置 该子命令白名单；改错故障 创建、删除、重命名等写形态进入白名单。
// INV-11 需要额外判断的回调在策略对象内声明，不在此文件实现：守住位置 additionalCommandIsDangerousCallback；改错故障 判定逻辑分散，无法单点审计。
// INV-12 每个条目必须是完整策略对象，不能只给数组：守住位置 二元组第二元素；改错故障 合并阶段读取字段时崩。
// INV-13 导出整体用只读断言双重约束：守住位置 文件末尾断言；改错故障 类型放宽后拼写错误不报。
// INV-14 顺序不影响匹配，但保持按字典序便于比对：守住位置 条目排列；改错故障 审阅时误以为先匹配先生效。
// INV-15 ls-files 的排除模式参数取字符串：守住位置 两个短参数与两个长参数条目；改错故障 模式串被当成位置参数。
// INV-16 cat-file 只放行只读查询形态：守住位置 该子命令白名单；改错故障 批量写入形态被放行。
// INV-17 describe 的候选数与缩写长度取数字：守住位置 两个条目；改错故障 数值参数被当成子命令。
// INV-18 for-each-ref 只放行查询与排序类选项：守住位置 该子命令白名单；改错故障 引用改写类选项进入只读路径。
//
// 模块职责：维护 git 只读子命令白名单中的核心查询部分，供策略合并层拼接成完整表。
// 状态所有权：本文件只产出不可变常量，不持有运行时状态，也不做任何判定。
// 阅读顺序：先看文件头的合并约定，再按子命令顺序读白名单，重点关注挂了回调的三项。
/**
 * git 只读子命令表的"核心/查询"部分（blame、branch、cat-file、config --get、describe、diff、
 * for-each-ref、grep、log、ls-files），以 [子命令名, policy] 二元组数组导出，
 * 由 bash-readonly-policy-commands.ts 与 history 表合并成 GIT_READONLY_SUBCOMMAND_POLICIES。
 * key 是 "git + 子命令" 两词前缀，由 -argv-git.ts 在剥离全局选项后精确匹配；
 * 需要额外语义判断的子命令通过 additionalCommandIsDangerousCallback 挂回调，
 * 没挂回调的只按 safeFlags 校验，未列出的 flag 一律判不可读。
 */

import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  gitBranchCommandIsDangerous,
  gitRevisionFormatCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";
import {
  COMMON_GIT_COLOR_FLAGS,
  GIT_DIFF_SAFE_FLAGS,
  GIT_GREP_SAFE_FLAGS,
  GIT_LOG_SAFE_FLAGS,
} from "./bash-readonly-policy-flags.js";

// 每个条目是「两词前缀加策略对象」的二元组，合并层只做拼接不去重。
// 顺序按子命令字典序，便于与历史表对照审阅。
// 策略对象可只带白名单，也可额外挂回调与计数缩写开关。
// 末尾的只读断言保证拼写错误在编译期暴露。
export const GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE = [
  [
    // blame 全部是只读检索选项，行范围参数需要字符串值。
    // 复制检测的重复次数语义由 git 自身处理，这里只校验形态。
    // 忽略修订文件参数接受文件路径，仍属于读取。
    // 未列出的输出格式选项一律拒绝，避免未来新增写语义。
    "git blame",
    {
      safeFlags: {
        ...COMMON_GIT_COLOR_FLAGS,
        "-C": "none",
        "-L": "string",
        "-M": "none",
        "-e": "none",
        "-f": "none",
        "-l": "none",
        "-n": "none",
        "-p": "none",
        "-s": "none",
        "-t": "none",
        "-w": "none",
        "--abbrev": "number",
        "--date": "string",
        "--ignore-rev": "string",
        "--ignore-revs-file": "string",
        "--incremental": "none",
        "--line-porcelain": "none",
        "--porcelain": "none",
        "--root": "none",
        "--score-debug": "none",
        "--show-email": "none",
        "--show-name": "none",
        "--show-number": "none",
        "--show-stats": "none",
      },
    },
  ],
  [
    // 只保留列举形态，创建、删除、重命名交给回调拒绝。
    // 详细输出两档与长参数并存是 git 的历史兼容，都放行。
    // 包含与指向参数取字符串引用，不做引用存在性校验。
    // 回调在这里只做语义拒绝，白名单负责形态收敛。
    "git branch",
    {
      // 只保留列举形态（-l/--list/-a/-r）；创建、删除、重命名由 gitBranchCommandIsDangerous 拒绝。
      safeFlags: {
        "-a": "none",
        "-i": "none",
        "-l": "none",
        "-r": "none",
        "-v": "none",
        "-vv": "none",
        "--abbrev": "number",
        "--all": "none",
        "--color": "none",
        "--column": "none",
        "--contains": "string",
        "--ignore-case": "none",
        "--list": "none",
        "--merged": "none",
        "--no-abbrev": "none",
        "--no-color": "none",
        "--no-column": "none",
        "--no-contains": "string",
        "--no-merged": "none",
        "--points-at": "string",
        "--remotes": "none",
        "--show-current": "none",
        "--sort": "string",
        "--verbose": "none",
      },
      additionalCommandIsDangerousCallback: gitBranchCommandIsDangerous,
    },
  ],
  [
    // safeFlags 只放行 -e/-p/-s/-t 四个键，且值都是 "none"。
    // --batch-check 属于批量查询，批量写入形态不在白名单内。
    // 未挂 additionalCommandIsDangerousCallback：该子命令无需额外语义判断。
    "git cat-file",
    {
      safeFlags: {
        "-e": "none",
        "-p": "none",
        "-s": "none",
        "-t": "none",
        "--allow-undetermined-type": "none",
        "--batch-check": "none",
      },
    },
  ],
  [
    // key 限定到 config --get，写形态 set/unset 根本不匹配这个前缀。
    // --global/--local/--system/--worktree 只限定读取范围。
    // 默认值参数需要一个回退值，其余均为开关。
    "git config --get",
    {
      // 只读范围限定在 config --get；config set/unset/--unset 等写形态根本不会匹配到这个 key。
      safeFlags: {
        "-z": "none",
        "--bool": "none",
        "--bool-or-int": "none",
        "--default": "string",
        "--expiry-date": "none",
        "--global": "none",
        "--int": "none",
        "--local": "none",
        "--name-only": "none",
        "--null": "none",
        "--path": "none",
        "--show-origin": "none",
        "--show-scope": "none",
        "--system": "none",
        "--type": "string",
        "--worktree": "none",
      },
    },
  ],
  [
    "git describe",
    {
      safeFlags: {
        "--abbrev": "number",
        "--always": "none",
        "--broken": "none",
        "--candidates": "number",
        "--contains": "none",
        "--dirty": "none",
        "--exclude": "string",
        "--exact-match": "none",
        "--first-match": "none",
        "--long": "none",
        "--match": "string",
        "--tags": "none",
      },
    },
  ],
  ["git diff", { safeFlags: GIT_DIFF_SAFE_FLAGS }],
  [
    "git for-each-ref",
    {
      safeFlags: {
        "--contains": "string",
        "--count": "number",
        "--format": "string",
        "--merged": "string",
        "--no-contains": "string",
        "--no-merged": "string",
        "--points-at": "string",
        "--sort": "string",
      },
      additionalCommandIsDangerousCallback: gitRevisionFormatCommandIsDangerous,
    },
  ],
  ["git grep", { safeFlags: GIT_GREP_SAFE_FLAGS }],
  [
    // 紧凑计数缩写由开关显式允许，其余数字参数不推断。
    // 格式化串可能触发签名校验参与，因此挂回调做二次拒绝。
    // GIT_LOG_SAFE_FLAGS 本身只覆盖检索与输出形态。
    // 分页与交互式遍历选项保持关闭，避免阻塞。
    "git log",
    {
      // `git log -8` / `git log -1` 是 Git 历史查询的只读 max-count 缩写；
      // 需要由 policy 明确声明，避免 Plan mode 错拦纯历史查询。
      allowCompactNumericCountFlag: true,
      safeFlags: GIT_LOG_SAFE_FLAGS,
      // --format/--pretty 里的 %G / %(signature) 会让 gpg 参与，因此额外挂回调。
      additionalCommandIsDangerousCallback: gitRevisionFormatCommandIsDangerous,
    },
  ],
  [
    // 全部是索引与工作区查询选项，-c/-d/-f 都只读。
    // -x/-X 两个排除模式短参数只读模式串，不会改写索引。
    // 未匹配选项会改变退出码，但仍是只读查询。
    // --recurse-submodules 只在查询范围内生效。
    "git ls-files",
    {
      // 全部是索引/工作区查询选项；-x/-X 只读取排除模式，不会改索引。
      safeFlags: {
        "-c": "none",
        "-d": "none",
        "-f": "none",
        "-i": "none",
        "-k": "none",
        "-m": "none",
        "-o": "none",
        "-s": "none",
        "-t": "none",
        "-u": "none",
        "-v": "none",
        "-x": "string",
        "-X": "string",
        "-z": "none",
        "--abbrev": "number",
        "--cached": "none",
        "--debug": "none",
        "--deleted": "none",
        "--directory": "none",
        "--eol": "none",
        "--error-unmatch": "none",
        "--exclude": "string",
        "--exclude-from": "string",
        "--exclude-per-directory": "string",
        "--exclude-standard": "none",
        "--full-name": "none",
        "--ignored": "none",
        "--killed": "none",
        "--modified": "none",
        "--no-empty-directory": "none",
        "--others": "none",
        "--recurse-submodules": "none",
        "--stage": "none",
        "--unmerged": "none",
      },
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
