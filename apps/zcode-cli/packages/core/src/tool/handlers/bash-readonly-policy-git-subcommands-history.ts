// INV-01 守住位置：条目元组第 0 位是「git <子命令>」整串 key，两级子命令也压成单串；改错故障：若把 remote show 拆成两个元素，commands 层按 key 查表将永远不命中。
// INV-02 守住位置：key 在本表内唯一且与 core 表无重叠；改错故障：重复 key 在合并时后者覆盖前者，远端条目的回调会静默失效，只读判定退回仅看 safeFlags。
// INV-03 守住位置：写仓库或写配置的子命令（stash push、tag -d、remote add）不得进表；改错故障：一旦进表，安全层会当作可读命令直接放行，且没有二次校验。
// INV-04 守住位置：safeFlags 只登记不写盘、不联网、不落文件的选项；改错故障：把 --output 一类写盘 flag 登记为 none，等于开出一条免检通道。
// INV-05 守住位置：远端语义不写进 safeFlags，而由 additionalCommandIsDangerousCallback 表达；改错故障：删掉回调后 ls-remote 只剩 flag 白名单，默认的位置参数会直接触发网络访问。
// INV-06 守住位置：回调返回 true 表示危险，是黑名单语义而非白名单；改错故障：写成反向判断会让所有带位置参数的查询被放行。
// INV-07 守住位置：git remote 的内联回调只允许 -v 与 --verbose，其余参数一律判危险；改错故障：改用 safeFlags 描述后，add、remove、prune、set-url 会以位置参数形式绕过白名单。
// INV-08 守住位置：git tag 的 -d 与 -f 刻意缺席 safeFlags，列举形态由回调放行；改错故障：补登记 -d 会把删除标签变成只读命令，且回调根本不会被调用，因而不会报错。
// INV-09 守住位置：共享 flag 集合以展开运算符注入，条目不复制其字面量；改错故障：就地复制后上游收紧某个 flag，本文件仍保留旧集合，两份白名单开始分叉。
// INV-10 守住位置：ref、date、count 三类共享集合的展开顺序在 reflog、rev-list、shortlog 中保持一致；改错故障：后展开的同名键会覆盖先展开者，取值类型会在 none 与 number 之间被悄悄改写。
// INV-11 守住位置：纯白名单条目只保留 safeFlags 一个字段，只有存在形态歧义时才追加回调；改错故障：给无歧义条目挂空回调会掩盖其本不联网的事实，后续维护者误判风险面。
// INV-12 守住位置：GIT_SHOW_SAFE_FLAGS 与 GIT_STATUS_SAFE_FLAGS 以整表引用，不在本文件二次裁剪；改错故障：就地增删会把 show 与 status 的特化扩散到其他引用方。
// INV-13 守住位置：表体是 as const 的只读元组数组，元素与对象均为字面量；改错故障：去掉 as const 后 none 与 number 退化为 string，类型层对取值形态的校验失效。
// INV-14 守住位置：末尾 satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[] 是唯一形状约束点；改错故障：删掉它后误加的第三元或多余字段不会报错，直到运行时被 commands 层静默忽略。
// INV-15 守住位置：本模块导入期只构造字面量与回调引用，没有任何顶层逻辑；改错故障：引入顶层计算（读环境变量、拼表）后，只读策略的加载顺序会与配置初始化耦合。
// INV-16 守住位置：回调一律从 bash-readonly-policy-callbacks.ts 具名导入，仅 git remote 例外使用内联箭头；改错故障：把回调内联到多处会产生同形不同判的实现漂移。
// INV-17 守住位置：git worktree list 的 --expire 登记为 string 而非 none，因为它后面必须跟时间值；改错故障：写成 none 会让带值形态被判成多余参数，命令被错误降级为不可读。
// INV-18 守住位置：git rev-parse 只收查询类选项，--parseopt 与 --sq 等可拼接输出的形态不在表内；改错故障：一旦纳入，参数内容会作为 shell 片段回显，形成注入面。
//
// 模块职责：声明 git 历史与远端查询类只读子命令的静态策略表，键统一为「git <子命令>」，由 commands 层与 core 表合并。
// 状态所有权：无状态；表内只有 flag 取值声明与危险判定回调引用，判定结果由上层安全模块持有。
// 阅读顺序：先看 INV-01 到 INV-08 的 key 与 flag 约定，再看各条目回调的歧义消解，最后对照 flags 与 callbacks 两个依赖模块。
/**
 * git 只读子命令表的"历史/远端查询"部分（ls-remote、merge-base、reflog、remote、rev-list、
 * rev-parse、shortlog、show、stash list/show、status、tag、worktree list）。
 * 与 core 表在 bash-readonly-policy-commands.ts 中合并；每个条目同样以 "git <子命令>" 为 key。
 * 远端类子命令（ls-remote / remote show / remote）必须挂回调，因为参数形态决定是否联网，
 * 单靠 safeFlags 无法区分"看本地配置"和"访问远端"。
 */

// 只做类型导入：该依赖在编译期被擦除，本表不引入任何运行时模块
// 依赖方向单向：types 不反向引用本文件，避免策略表与类型定义互相牵制
// 回调与共享 flag 全部具名导入，便于在各自模块内单独收紧判定规则
// 导入按用途分组：远端判定、历史判定、revision 格式判定、tag 判定各占一处
// 新增子命令若复用既有判定，应扩展对应回调，不要在此新增内联分支
// 本文件不读环境变量也不碰仓库路径，导入期零副作用是只读策略可被静态分析的前提
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import {
  gitLsRemoteCommandIsDangerous,
  gitReflogCommandIsDangerous,
  gitRemoteShowCommandIsDangerous,
  gitRevisionFormatCommandIsDangerous,
  gitTagCommandIsDangerous,
} from "./bash-readonly-policy-callbacks.js";
import {
  COMMON_GIT_COLOR_FLAGS,
  COMMON_GIT_COUNT_FLAGS,
  COMMON_GIT_DATE_FLAGS,
  COMMON_GIT_LOG_STYLE_FLAGS,
  COMMON_GIT_PATCH_FLAGS,
  COMMON_GIT_REF_FLAGS,
  COMMON_GIT_STAT_FLAGS,
  GIT_SHOW_SAFE_FLAGS,
  GIT_STATUS_SAFE_FLAGS,
} from "./bash-readonly-policy-flags.js";

// git 历史/远端查询类只读子命令条目表，键统一为 "git <子命令>"，供 commands 层合并。
// 每个条目的 safeFlags 描述可接受选项，additionalCommandIsDangerousCallback 处理参数形态歧义。
// 只读数组字面量，无 IO/副作用；未命中的子命令或 flag 一律由上层按不可读处理。
// 导出名带 HISTORY 后缀，标明它只是全量只读表的一个分片，合并在 commands 层完成
// 数组顺序不参与判定：查表按 key 精确匹配，不存在先命中后覆盖的短路语义
// 每个元素是二元组，第一项 key、第二项策略对象，第三项一律不允许出现
// 合并阶段虽有 key 冲突兜底，本表仍应自持唯一，冲突检查不是设计许可
// 对象字段保持最小集：能靠 safeFlags 说清就不挂回调，减少一条判定路径
// 只读语义由末尾的类型断言固定，此处无需再叠加冻结操作
export const GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY = [
  [
    "git ls-remote",
    {
      safeFlags: {
        "-b": "none",
        "-h": "none",
        "-q": "none",
        "-t": "none",
        "--branches": "none",
        "--exit-code": "none",
        "--get-url": "none",
        "--heads": "none",
        "--quiet": "none",
        "--refs": "none",
        "--sort": "string",
        "--symref": "none",
        "--tags": "none",
      },
      // ls-remote 的默认形态就会访问远端，safeFlags 之外的参数必须由回调兜底
      // 回调语义是「是否危险」：返回 true 即拒绝，不做二次复核也不回退白名单
      // -b 与 --branches 只改变筛选范围，不改变是否联网，登记为 none 是安全的
      // --get-url 只回显已配置的 URL，属于本地查询，因此留在白名单内
      // --exit-code 影响的是退出码而非读写性质，仍按只读处理
      // 删掉这一行会让本条目退化成只认 flag 的表项，是整张表最容易被误改的位置
      additionalCommandIsDangerousCallback: gitLsRemoteCommandIsDangerous,
    },
  ],
  [
    "git merge-base",
    {
      safeFlags: {
        "--all": "none",
        "--fork-point": "none",
        "--independent": "none",
        "--is-ancestor": "none",
        "--octopus": "none",
      },
    },
  ],
  [
    "git reflog",
    {
      safeFlags: {
        ...COMMON_GIT_LOG_STYLE_FLAGS,
        ...COMMON_GIT_REF_FLAGS,
        ...COMMON_GIT_DATE_FLAGS,
        ...COMMON_GIT_COUNT_FLAGS,
        ...COMMON_GIT_STAT_FLAGS,
        "--grep": "string",
      },
      additionalCommandIsDangerousCallback: gitReflogCommandIsDangerous,
    },
  ],
  [
    "git remote show",
    {
      // remote show 的 -n 只决定是否抓取远端状态，是展示层开关
      // 真正决定联网的是紧随其后的远端名位置参数，因此 flag 表必须保持极小
      // 该条目故意不登记远端名以外的任何选项，形态判定全交给回调
      // safeFlags 越宽，回调需要拦截的面就越大，这里选择相反方向的收敛
      safeFlags: { "-n": "none" },
      additionalCommandIsDangerousCallback: gitRemoteShowCommandIsDangerous,
    },
  ],
  [
    "git remote",
    {
      safeFlags: { "-v": "none", "--verbose": "none" },
      // 除 -v/--verbose 外的任何参数（add/remove/prune/set-url）都是在写 remotes 配置。
      // 内联回调只放行 -v 与 --verbose 两种纯展示参数，其余一律按写配置处理
      // 判定扫描全部参数而非首个参数，因为写操作可能出现在选项之后
      // commandText 在此未被使用，保留它是为了与共享回调签名保持一致
      // add、remove、prune、set-url 都是位置参数形态，白名单覆盖不到，只能反向排除
      // 回调写在内联处是因为它只服务这一个 key，抽成公共函数反而掩盖专用性
      // 改动这里等同移动 git remote 的只读边界，任何放宽都会让远端配置可被静默改写
      additionalCommandIsDangerousCallback: (commandText, args) =>
        args.some((arg) => arg !== "-v" && arg !== "--verbose"),
    },
  ],
  [
    "git rev-list",
    {
      safeFlags: {
        ...COMMON_GIT_REF_FLAGS,
        ...COMMON_GIT_DATE_FLAGS,
        ...COMMON_GIT_COUNT_FLAGS,
        "--abbrev": "number",
        "--abbrev-commit": "none",
        "--ancestry-path": "none",
        "--count": "none",
        "--dense": "none",
        "--first-parent": "none",
        "--format": "string",
        "--full-history": "none",
        "--graph": "none",
        "--grep": "string",
        "--max-age": "number",
        "--max-parents": "number",
        "--merges": "none",
        "--min-age": "number",
        "--min-parents": "number",
        "--no-max-parents": "none",
        "--no-merges": "none",
        "--no-min-parents": "none",
        "--oneline": "none",
        "--pretty": "string",
        "--reverse": "none",
        "--skip": "number",
        "--source": "none",
        "--sparse": "none",
        "--walk-reflogs": "none",
      },
      // rev-list 的 --pretty 与 --format 可携带任意格式化串，需回调单独审查
      // 该回调同时服务 shortlog 与 show，三者共享格式化注入面
      // 因此在此扩充格式化相关 flag 时，另外两个子命令的判定会同时被改变
      additionalCommandIsDangerousCallback: gitRevisionFormatCommandIsDangerous,
    },
  ],
  [
    "git rev-parse",
    {
      safeFlags: {
        "--abbrev-ref": "none",
        "--absolute-git-dir": "none",
        "--git-common-dir": "none",
        "--git-dir": "none",
        "--is-bare-repository": "none",
        "--is-inside-git-dir": "none",
        "--is-inside-work-tree": "none",
        "--is-shallow-repository": "none",
        "--is-shallow-update": "none",
        "--path-prefix": "none",
        "--short": "string",
        "--show-cdup": "none",
        "--show-prefix": "none",
        "--show-superproject-working-tree": "none",
        "--show-toplevel": "none",
        "--symbolic": "none",
        "--symbolic-full-name": "none",
        "--verify": "none",
      },
    },
  ],
  [
    "git shortlog",
    {
      safeFlags: {
        ...COMMON_GIT_REF_FLAGS,
        ...COMMON_GIT_DATE_FLAGS,
        "-c": "none",
        "-e": "none",
        "-n": "none",
        "-s": "none",
        "--author": "string",
        "--committer": "none",
        "--email": "none",
        "--format": "string",
        "--group": "string",
        "--no-merges": "none",
        "--numbered": "none",
        "--summary": "none",
      },
      additionalCommandIsDangerousCallback: gitRevisionFormatCommandIsDangerous,
    },
  ],
  [
    "git show",
    {
      safeFlags: GIT_SHOW_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: gitRevisionFormatCommandIsDangerous,
    },
  ],
  [
    "git stash list",
    {
      safeFlags: {
        ...COMMON_GIT_LOG_STYLE_FLAGS,
        ...COMMON_GIT_REF_FLAGS,
        ...COMMON_GIT_COUNT_FLAGS,
      },
    },
  ],
  [
    "git stash show",
    {
      safeFlags: {
        ...COMMON_GIT_STAT_FLAGS,
        ...COMMON_GIT_COLOR_FLAGS,
        ...COMMON_GIT_PATCH_FLAGS,
        "--abbrev": "number",
        "--diff-filter": "string",
        "--word-diff": "none",
        "--word-diff-regex": "string",
      },
    },
  ],
  ["git status", { safeFlags: GIT_STATUS_SAFE_FLAGS }],
  [
    "git tag",
    {
      // -d（删除）与 -f（强建）不在 safeFlags；只有 --list/-l 列举形态由回调放行。
      safeFlags: {
        // tag 的列举类选项集中在此，-d 与 -f 的缺席是刻意设计而非遗漏
        // --contains 与 --merged 需要一次修订号参数，故登记为 string 而非 none
        // -n 后接行数，登记为 number，避免把数字误判成多余位置参数
        "-i": "none",
        "-l": "none",
        "-n": "number",
        "--column": "none",
        "--contains": "string",
        "--format": "string",
        "--ignore-case": "none",
        "--list": "none",
        "--merged": "string",
        "--no-column": "none",
        "--no-contains": "string",
        "--no-merged": "string",
        "--points-at": "string",
        "--sort": "string",
      },
      additionalCommandIsDangerousCallback: gitTagCommandIsDangerous,
    },
  ],
  [
    "git worktree list",
    {
      safeFlags: { "-v": "none", "--expire": "string", "--porcelain": "none", "--verbose": "none" },
    },
  ],
// satisfies 约束只在类型层校验元组形状，不产生任何运行时代码
// as const 锁字面量类型、satisfies 锁元素结构，二者缺一不可
// 此处的类型变化会直接改动 commands 层合并函数的入参推导
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
