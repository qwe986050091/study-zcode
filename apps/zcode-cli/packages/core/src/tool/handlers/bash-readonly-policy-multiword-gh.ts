/**
 * gh 的多词只读前缀表（issue/pr/release/repo/run/workflow/search 的列举与查看形态）。
 * gh 的写命令（create/edit/merge/close/delete）不在此表，因此根本不会命中；
 * 每个条目都挂 ghCommandIsDangerous：参数里出现 URL/宿主或 owner/repo 形态即判危险。
 * 表在 bash-readonly-policy-commands.ts 中与 core 多词表合并，键是两词前缀。
 */

// gh 多词只读前缀声明表：只用静态数据描述 gh 的列举与查看类子命令在何种 flag 形态下算只读。
// 不解析命令行、不切词、不执行 gh，也不定义 flag 取值语义（取值类型统一来自 flags 模块）。
// 不负责：危险参数判定实现（callbacks 模块）、多词表合并与查找（commands 模块）、最终权限放行。
//
// INV-01 断言：键必须是 gh 加两词子命令且属于列举/查看白名单 —— 守住它的位置：每个条目的首元素 —— 改错故障：写命令被收进表后会以只读身份直接执行。
// INV-02 断言：safeFlags 只收录筛选与输出控制类 flag，不得含任何触发远端写入的项 —— 守住它的位置：各条目 safeFlags 字面量 —— 改错故障：--web 一类参数把只读判定变成真实动作。
// INV-03 断言：面向当前仓库的条目必须挂 ghCommandIsDangerous —— 守住它的位置：16 个 repo 作用域条目的回调字段 —— 改错故障：URL、@ 宿主与多段路径指向不再被拦截。
// INV-04 断言：search 系列刻意不挂回调，安全完全落在白名单上 —— 守住它的位置：5 个 search 条目 —— 改错故障：一旦放宽 allowAnyArgs，检索命令成为任意参数通道。
// INV-05 断言：共享常量展开必须写在前面，具体 flag 覆盖在后 —— 守住它的位置：safeFlags 对象成员顺序 —— 改错故障：后置展开会抹掉个别覆盖项，出现难以察觉的行为回退。
// INV-06 断言：flag 取值类型必须与实际指向一致 —— 守住它的位置：每个 safeFlags 的 none、string、number —— 改错故障：布尔项写成 string 会吞掉下一个参数，参数校验序列错位。
// INV-07 断言：未登记的 flag 由判定层拒绝，因此漏登记只会更严不会更松 —— 守住它的位置：safeFlags 缺省语义 —— 改错故障：为修误拒而铺开整张共享表，反而放行新参数。
// INV-08 断言：条目必须保持只读二元组形状 —— 守住它的位置：同时约束类型的 as const satisfies 行 —— 改错故障：改成对象或三元组后合并处解构失败，gh 多词命令全部不可读。
// INV-09 断言：键名是合并后 Map 的唯一索引 —— 守住它的位置：命令模块的两表展开 —— 改错故障：改名等同删条目，旧命令立刻回落到不可读。
// INV-10 断言：本文件必须保持纯数据、无 IO、无副作用 —— 守住它的位置：模块顶层表达式 —— 改错故障：运行时读取会让策略表在导入阶段抛错，拖垮整条只读判定链。
// INV-11 断言：回调只做补充判定，不能替代 safeFlags —— 守住它的位置：policy 对象上的两个字段 —— 改错故障：只挂回调而不登记 flag，合法筛选参数被大面积误拒。
// INV-12 断言：布尔开关的类型不得改成 string —— 守住它的位置：--comments、--watch、--yaml 等 none 项 —— 改错故障：后续位置参数被当作开关取值吞掉，远端形态逃过回调。
// INV-13 断言：数量类 flag（-L、--limit、--interval、-a）必须保持 number —— 守住它的位置：相关条目的取值类型 —— 改错故障：数字被当字符串接受后，非数字参数也能进入只读通道。
// INV-14 断言：写命令的缺席是设计而非遗漏 —— 守住它的位置：数组中不存在的 create、edit、merge、close、delete 键 —— 改错故障：为图省事补 allowAnyArgs，等于给未命中前缀放行任意参数。
// INV-15 断言：gh 条目不得在 core 多词表重复定义 —— 守住它的位置：命令模块合并顺序 —— 改错故障：重复键由后写入者覆盖，gh 条目被 core 表静默替换。
//
// 共享常量分三层叠加：GH_REPO_FLAGS 提供 -R 与 --repo，GH_JSON_REPO_FLAGS 追加 --json，GH_LIMIT_REPO_FLAGS 再追加 -L 与 --limit。
// issue、pr、release、repo、run、workflow 作用于当前仓库，统一挂 ghCommandIsDangerous。
// search 系列是对 GitHub 的远端检索，不改变仓库状态，因此不挂回调。
// 回调只识别 URL、@ 宿主与两段斜杠形态，不识别 --web 之类动作型参数。
// 判定层先按两词前缀命中本表，再逐个校验 safeFlags，遇到未登记 flag 直接判不可读。
// 本表与 core 多词表在命令模块合并为 Map，同名键由后写入者覆盖。
// as const satisfies 同时保留字面量类型与元组形状，供合并处按只读元组解构。
// 新增条目时应同时登记长选项与其短写，只登记一侧会造成等价写法判定不一致。
// 列表类条目的筛选 flag 不改变远端状态，但绝不能因此追加动作型 flag。
// 任何键名或取值类型改动都要复核回调覆盖范围与只读判定用例。
import type { BashReadonlyCommandPolicy } from "./bash-readonly-policy-types.js";
import { ghCommandIsDangerous } from "./bash-readonly-policy-callbacks.js";
import {
  GH_JSON_REPO_FLAGS,
  GH_LIMIT_REPO_FLAGS,
  GH_REPO_FLAGS,
} from "./bash-readonly-policy-flags.js";

// gh 多词只读前缀条目表（issue/pr/release/repo/run/workflow/search 的列举与查看形态）。
// 键是两词前缀；safeFlags 限定筛选参数，ghCommandIsDangerous 拦截 URL/宿主或 owner/repo 形态。
// 只读数组字面量，无 IO；写命令（create/edit/merge/close/delete）不在此表，天然不会命中。
export const READONLY_MULTIWORD_POLICY_ENTRIES_GH = [
  [
    // [契约] 状态、作者、标签、里程碑、搜索词都只收窄查询范围，不改变 issue 数据，因此可登记为只读。
    // [失败路径] 不要补 --web：回调识别不了它，安全边界完全依赖未登记即拒绝这道闸。
    // [权衡] 短写 -s 与长写 --state 分开登记，删掉任一条都会让等价写法一半放行一半拒绝，表现为随机的判定不一致。
    "gh issue list",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-s": "string",
        "--app": "string",
        "--assignee": "string",
        "--author": "string",
        "--label": "string",
        "--milestone": "string",
        "--search": "string",
        "--state": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 只返回与当前用户相关的 issue 概览，靠 GH_JSON_REPO_FLAGS 提供 --json 与 -R。
    // 该子命令没有筛选参数，新增任何 flag 都要先确认 gh 侧真实存在，否则只是白白扩大允许面。
    // [失败路径] 回调是本条唯一入口，去掉后带 https 前缀的远端指向将不再被拦截。
    "gh issue status",
    { safeFlags: GH_JSON_REPO_FLAGS, additionalCommandIsDangerousCallback: ghCommandIsDangerous },
  ],
  [
    // 查看单条 issue，--comments 是布尔开关，故类型为 none，不消费紧随其后的参数。
    // [失败路径] 把它写成 string 会让下一个位置参数被当作取值吞掉，位置参数校验被绕开。
    // 编号是纯数字位置参数，不含斜杠，不会被回调误判成远端路径，因此无需额外登记。
    "gh issue view",
    {
      safeFlags: { ...GH_JSON_REPO_FLAGS, "--comments": "none" },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 列出标签定义，-S 是 --search 短写，--order 与 --sort 只影响排序，均不写远端。
    // [权衡] 长短写法必须成对登记，缺一侧会产生难以复现的时好时坏现象。
    // 标签写操作在 create、edit、delete 条目，本表不能为图方便加 allowAnyArgs。
    "gh label list",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-S": "string",
        "--order": "string",
        "--search": "string",
        "--sort": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 查看 CI 检查结果，--watch 与 --fail-fast 只改变等待与中断方式，不触发重跑。
    // [契约] --interval 取 number，类型必须保留，否则数字后的参数会被判成多余位置参数。
    // 不要补 --web，也不要把布尔等待项改成 string 风格，等待语义与取值消费是两件不同的事。
    "gh pr checks",
    {
      safeFlags: {
        ...GH_JSON_REPO_FLAGS,
        "--fail-fast": "none",
        "--interval": "number",
        "--required": "none",
        "--watch": "none",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 输出 PR 的 diff 文本，--color 需要取值，--name-only 与 --patch 是不取值的开关。
    // [契约] 这里用 GH_REPO_FLAGS 而非 JSON 变体，因为 diff 没有 --json 输出形态，误加会放行无意义参数。
    // --patch 与 --name-only 的组合由 gh 自行处理，策略层不要做互斥判断，否则会把合法组合误拒。
    "gh pr diff",
    {
      safeFlags: {
        ...GH_REPO_FLAGS,
        "--color": "string",
        "--name-only": "none",
        "--patch": "none",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // PR 列表筛选，-L 是数量上限，-s 是状态短写，--draft 是不取值的开关。
    // [失败路径] 数量、状态与布尔项的类型必须区分，写错会吞掉后面的位置参数或把取值当操作数。
    // 不要补 --web 或额外输出类开关，白名单越宽，未登记即拒绝这道防线越薄。
    "gh pr list",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-L": "number",
        "-s": "string",
        "--app": "string",
        "--assignee": "string",
        "--author": "string",
        "--base": "string",
        "--draft": "none",
        "--head": "string",
        "--label": "string",
        "--search": "string",
        "--state": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 当前用户的 PR 概览，-c 与 --conflict-status 是布尔开关，因此类型为 none。
    // [失败路径] 把 -c 当 string 处理会让紧随其后的参数被吞掉，导致参数校验序列整体错位。
    // 本条不接收位置参数，出现编号即被判定层拒绝，不要为兼容旧写法放开 allowAnyArgs。
    "gh pr status",
    {
      safeFlags: { ...GH_JSON_REPO_FLAGS, "-c": "none", "--conflict-status": "none" },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 查看单条 PR 详情，--comments 为布尔开关，不消费后续参数。
    // [权衡] 与 issue view 保持同一形态，两处必须一起改，否则同类命令会出现不一致的只读判定。
    // PR 编号是纯数字位置参数，跨仓库只能走 -R 取值，不要在此额外铺开仓库作用域参数。
    "gh pr view",
    {
      safeFlags: { ...GH_JSON_REPO_FLAGS, "--comments": "none" },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 列出发版，-O 是 --order 短写，--exclude-drafts 与 --exclude-pre-releases 只过滤结果。
    // [失败路径] 过滤类布尔开关必须是 none，写成 string 会把后续参数吞成取值。
    // 发版的 create、delete、edit 不在此表，不要因为列表安全就给本条加 allowAnyArgs。
    "gh release list",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-O": "string",
        "--exclude-drafts": "none",
        "--exclude-pre-releases": "none",
        "--order": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 查看单个 release，只登记 GH_JSON_REPO_FLAGS，没有额外筛选参数。
    // [失败路径] 不要顺手补 --web：回调检测不到它，拦截完全靠这里不登记。
    // 标签名是可含斜杠的位置参数，回调按两段斜杠判危险，调整判定口径前先确认不会误伤正常标签。
    "gh release view",
    { safeFlags: GH_JSON_REPO_FLAGS, additionalCommandIsDangerousCallback: ghCommandIsDangerous },
  ],
  [
    // [契约] 只允许 --json 查询当前仓库，-R 与 --repo 以及 owner/repo 位置形态都不登记。
    // 该条目下方的既有注释已说明位置参数属于跨仓库访问，不要为方便把 GH_REPO_FLAGS 整体铺开。
    // [权衡] 回调按 URL、@ 宿主与两段斜杠识别远端形态，是这条窄白名单的第二道防线，两者必须同时保留。
    // [失败路径] 若既去掉回调又展开共享常量，gh repo view 会变成可指向任意仓库的读通道。
    "gh repo view",
    {
      // 只允许 --json 查询当前仓库；带 owner/repo 位置参数属于跨仓库访问，由回调拒绝。
      safeFlags: { "--json": "string" },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 工作流运行列表，-b、-c、-e、-s、-u、-w 是长选项短写，必须与长名同时登记。
    // [失败路径] 短写漏登记表现为等价命令一半可用一半被拒，最容易被误报成随机失败。
    // 这些 flag 都只筛选历史运行，触发运行的是 rerun、cancel 一类写命令，不在表内。
    "gh run list",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-b": "string",
        "-c": "string",
        "-e": "string",
        "-s": "string",
        "-u": "string",
        "-w": "string",
        "--branch": "string",
        "--commit": "string",
        "--created": "string",
        "--event": "string",
        "--status": "string",
        "--user": "string",
        "--workflow": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 查看运行详情，--log 与 --log-failed 只是输出开关，--exit-status 用退出码表达结果。
    // [契约] -a 与 --attempt、-j 与 --job 需要取值，类型写错会吞掉后续参数或把取值当成位置参数。
    // 不要补 --web 等动作型开关，cancel 与 rerun 属于写命令，绝不能合并进本条。
    "gh run view",
    {
      safeFlags: {
        ...GH_JSON_REPO_FLAGS,
        "-a": "number",
        "-j": "string",
        "-v": "none",
        "--attempt": "number",
        "--exit-status": "none",
        "--job": "string",
        "--log": "none",
        "--log-failed": "none",
        "--verbose": "none",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // [契约] search 系列是远端只读检索，刻意不挂回调，安全边界完全由未登记即拒绝承担。
    // 因此这里更要克制：任何会触发写、浏览器或登录的 flag 都不能补进来，回调不会兜底。
    // --owner 只是检索条件，不是 -R 式的仓库作用域，别把它误当成跨仓库写权限。
    // [失败路径] 若误挂放宽策略或补 allowAnyArgs，检索命令会变成任意参数通道，等于绕过整张表。
    "gh search code",
    {
      // search 系列本身是远端只读检索，因此不挂危险回调；只用 safeFlags 限定筛选参数。
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "--extension": "string",
        "--filename": "string",
        "--language": "string",
        "--match": "string",
        "--owner": "string",
        "--size": "string",
      },
    },
  ],
  [
    // 按作者、提交者与时间窗口过滤提交，全部是检索条件。
    // [权衡] 没有挂回调并非遗漏，--web 之类参数只要不登记就永远进不来，这是有意设计。
    // 新增 flag 前先确认它不发起写操作，search 系列一旦放开回调会连带放宽其余检索子命令。
    "gh search commits",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "--author": "string",
        "--author-date": "string",
        "--author-email": "string",
        "--author-name": "string",
        "--committer": "string",
        "--committer-date": "string",
        "--committer-email": "string",
        "--committer-name": "string",
        "--hash": "string",
        "--merge": "none",
        "--order": "string",
        "--owner": "string",
        "--parent": "string",
        "--sort": "string",
        "--tree": "string",
        "--visibility": "string",
      },
    },
  ],
  [
    // issue 检索参数最多，--include-prs、--no-label 等布尔项必须保持 none。
    // [失败路径] 把布尔项写成 string 会吞掉下一个参数，造成检索条件被静默改写。
    // 本表未登记 --web，回调也不参与，跨仓库检索只能靠 --owner 与 -R 这类检索条件表达。
    "gh search issues",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-R": "string",
        "--app": "string",
        "--assignee": "string",
        "--author": "string",
        "--closed": "string",
        "--commenter": "string",
        "--comments": "string",
        "--created": "string",
        "--include-prs": "none",
        "--interactions": "string",
        "--involves": "string",
        "--label": "string",
        "--language": "string",
        "--locked": "none",
        "--match": "string",
        "--mentions": "string",
        "--milestone": "string",
        "--no-assignee": "none",
        "--no-label": "none",
        "--no-milestone": "none",
        "--no-project": "none",
        "--order": "string",
        "--owner": "string",
        "--project": "string",
        "--reactions": "string",
        "--sort": "string",
        "--state": "string",
        "--team-mentions": "string",
        "--updated": "string",
        "--visibility": "string",
      },
    },
  ],
  [
    // PR 检索，-B、-H、-R 分别是 --base、--head、--repo 的短写，需与长名成对维护。
    // [契约] --merged、--draft、--locked 是布尔过滤项，类型必须是 none，否则取值消费会错位。
    // 这里同样不挂回调：search 是远端查询，不改变任何仓库状态，安全只依赖白名单本身。
    "gh search prs",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "-B": "string",
        "-H": "string",
        "-R": "string",
        "--app": "string",
        "--assignee": "string",
        "--author": "string",
        "--base": "string",
        "--checks": "string",
        "--closed": "string",
        "--commenter": "string",
        "--comments": "string",
        "--created": "string",
        "--draft": "none",
        "--head": "string",
        "--interactions": "string",
        "--involves": "string",
        "--label": "string",
        "--language": "string",
        "--locked": "none",
        "--match": "string",
        "--mentions": "string",
        "--merged": "none",
        "--merged-at": "string",
        "--milestone": "string",
        "--no-assignee": "none",
        "--no-label": "none",
        "--no-milestone": "none",
        "--no-project": "none",
        "--order": "string",
        "--owner": "string",
        "--project": "string",
        "--reactions": "string",
        "--review": "string",
        "--review-requested": "string",
        "--reviewed-by": "string",
        "--sort": "string",
        "--state": "string",
        "--team-mentions": "string",
        "--updated": "string",
        "--visibility": "string",
      },
    },
  ],
  [
    // 仓库检索，--archived 是布尔项，其余为 stars、forks、size、language 等排序过滤条件。
    // 检索对象本身就是任意远端仓库，但这只是读，不构成跨仓库写，不要因此给它挂危险回调。
    // [权衡] 宁可少支持几个排序别名，也不要为便利铺开 GH_LIMIT_REPO_FLAGS 之外的其他参数。
    // [失败路径] 一旦补上 --web 或交互式参数，白名单这道唯一防线立刻失效。
    "gh search repos",
    {
      safeFlags: {
        ...GH_LIMIT_REPO_FLAGS,
        "--archived": "none",
        "--created": "string",
        "--followers": "string",
        "--forks": "string",
        "--good-first-issues": "string",
        "--help-wanted-issues": "string",
        "--include-forks": "string",
        "--language": "string",
        "--license": "string",
        "--match": "string",
        "--number-topics": "string",
        "--order": "string",
        "--owner": "string",
        "--size": "string",
        "--sort": "string",
        "--stars": "string",
        "--topic": "string",
        "--updated": "string",
        "--visibility": "string",
      },
    },
  ],
  [
    // 列出工作流定义，-a 与 --all 是布尔开关，用于展开被隐藏的禁用工作流。
    // GH_LIMIT_REPO_FLAGS 提供 -R、--repo 与 --json，跨仓库形态仍由回调补充判断。
    // [失败路径] 不要因为只读就移除回调，否则带远端 URL 的 --repo 取值会被放行。
    "gh workflow list",
    {
      safeFlags: { ...GH_LIMIT_REPO_FLAGS, "-a": "none", "--all": "none" },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
  [
    // 查看单个工作流，-r 是 --ref 短写，-y 与 --yaml 输出原始 YAML 而不跳浏览器。
    // [契约] 默认形态会打开浏览器，--yaml 是唯一不产生外部动作的输出方式，因此 -y 与 --yaml 都必须登记。
    // [失败路径] 绝不能补 --web：它会拉起浏览器，而回调不识别该参数，唯一拦截点就是这里不登记。
    // [权衡] 移除 --yaml 会退回浏览器行为，移除回调会放行远端仓库，两者是彼此独立的防线。
    "gh workflow view",
    {
      safeFlags: {
        ...GH_REPO_FLAGS,
        "-r": "string",
        "-y": "none",
        "--ref": "string",
        "--yaml": "none",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
