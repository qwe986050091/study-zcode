// 文件定位：apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-text.ts
// 职责：为 tree/cat/head/tail/wc/rg/grep/sed/xargs/file/jq 提供只读 flag 白名单，纯数据、无副作用
// 消费方：bash-readonly-policy-flags.ts 的 barrel 汇总后，由 simple-commands 表与 argv 校验层读取
// 判定口径：只有表内登记且取值形态合法的 flag 才算只读，未登记一律拒绝（fail-closed）
//
// INV-01 所有导出表均以 as const satisfies Readonly<Record<string, SafeFlagValue>> 收尾，键只读、值受 SafeFlagValue 约束；守卫在每张表的结尾断言处；去掉 satisfies 会丢失字面量检查，拼错的取值形态（如 numbr）将静默通过并在运行期被判非法
// INV-02 表键必须是命令真实接受的 flag 字面量（含前导短横线），argv 层用整词相等查表；把 --ignore_case 这类变体写进表不会生效，反而让合法命令被拒
// INV-03 取值形态 none 表示不消费后续 argv，守卫在 bash-readonly-policy-argv-flags.ts 的 flagValue 等于 none 分支（同时拒绝 --flag=value 内联写法）；误标为 string 会吞掉下一个文件名，使其后的 flag 逃过校验
// INV-04 number 只接受纯十进制数字（matchesFlagValueKind 的锚定数字正则），负数、小数、带单位一律拒绝；放宽成更宽的正则会让 -n -1 这类形态吃掉下一个 argv
// INV-05 char 只允许长度恰为 1，xargs 的 -d 依赖该约束；放宽成任意串会让 -d ,,, 通过并改变切分语义
// INV-06 形态 {} 与 EOF 是 xargs 专用的占位符与结束符，必须逐字相等；改动这两个常量会让 -I 与 -E 全部被判非法
// INV-07 短 flag 簇展开要求簇内每个字符都在表内且形态为 none（isShortFlagClusterAllowed）；任何取值型 flag 混入簇即整体拒绝，这是不做猜测的兜底
// INV-08 -- 终止解析由策略对象的 respectsDoubleDash 控制，本文件不参与该判断，但 grep/sed 等表必须与 POSIX 语义一致；错标会让 -- 之后的操作数被当成 flag
// INV-09 未登记 flag 先尝试 -Ifoo 粘连取值，再尝试短簇展开，两者都失败才返回 false；表里误收看似无害的短选项会扩大粘连路径的接受面
// INV-10 tree 的 -o/--output（写文件）、grep 的 --pre（执行程序）、sed 的 -i（原地写）、jq 的 -f/--argfile（读脚本）必须保持不收录；这四项是整张表的核心安全边界，误收录等于放弃只读判定
// INV-11 sed 的 -i 变体（-i.bak、-i 加空串、--in-place 加后缀）由 isSedInPlaceOption 单独拦截，不依赖本表；删除该回调而只靠白名单会让原地改写通过
// INV-12 jq 的脚本读取能力由 jqCommandIsDangerous 回调拦截，本表只列格式化与输入模式开关；回调与表是逻辑与的关系，缺任一环都会放宽可执行面
// INV-13 rg 的 --follow 只让遍历穿过符号链接、不写盘，因此收录；它不扩大写入面，只扩大可读范围
// INV-14 rg/grep 的 --sort/--sortr 取值是字符串形态，必须恰好消费一个 argv；漏标成 none 会让排序键被当作新 flag 或操作数处理
// INV-15 xargs 目标命令白名单（XARGS_TARGET_COMMANDS）与本表是两道独立闸门：本表管 xargs 自身参数，白名单管执行什么；只改本表无法放行新的目标命令
// INV-16 本文件是纯常量模块，加载期即完成索引构造，不读取文件系统、网络或环境变量；因此并发调用之间没有共享可变状态，也不需要加锁
// INV-17 全部表经 bash-readonly-policy-flags.ts 的 barrel 二次导出，被简单命令表与 git 子命令表组合引用；改名导出会破坏 export * 的传递，引用处将拿不到 safeFlags
// INV-18 OPTION_PATTERN 只判定看起来像短选项的起点，不判定安全性；把它的字符类放宽会改变 argv 层的分流顺序，让路径片段或纯 - 也进入查表
// INV-19 表项只增不改语义：新增 flag 必须同时确认取值形态与是否写盘；删除既有项会让原本合法的只读命令降级为需人工确认，这是可用性回退而非安全问题
// INV-20 本文件无分支、无 IO、无异常抛出，唯一失败路径是 tsc 对 satisfies 的类型校验；因此不要在此加入条件判断、缓存或懒加载
// 维护约束：只允许新增表项或注释，不允许修改既有键的取值形态，否则会改变 argv 消费长度并引发错位
// 核查方式：改动后运行 handlers 目录下只读策略相关单测，重点覆盖短 flag 簇、粘连取值与 --flag=value 三种形态
//
/**
 * 文本查看/搜索类命令的完整安全 flag 表（tree、cat、head/tail、wc、rg、grep、sed、xargs、file、jq）
 * 以及 OPTION_PATTERN。表经 bash-readonly-policy-flags.ts 汇总，由 -simple-commands.ts 的条目引用。
 * 只列"不写文件、不联网、不执行子进程"的 flag；例如 tree 的 -o（写文件）、grep 的 --pre（执行程序）
 * 都故意不收录。jq 的 -f/--argfile 等由 jqCommandIsDangerous 回调额外拦截。
 */

// [类型] SafeFlagValue 是跨表统一的取值形态联合类型，定义在 bash-readonly-policy-types.ts，本文件只引用不定义
// [权衡] 使用 import type 而非普通 import：运行期不依赖该模块，编译后语句被完全擦除，避免无谓的模块求值
// [失败路径] 若该类型改成运行期导出（如枚举），擦除失效且这里会多一次模块求值，循环依赖场景下可能提前触发半初始化模块
import type { SafeFlagValue } from "./bash-readonly-policy-types.js";

// 统一判定"看起来像短选项"的起点；长选项 `--xxx` 也会命中，后续由具体 flag 表再区分。
// [边界] 该正则只回答是否以短横线开头且第二字符属于字母、数字、下划线或短横线，不回答是否安全
// [权衡] 字符类比 \w 更严格：排除点号与斜杠，避免把 -. 或路径片段误判成选项
// [失败路径] 若放宽为只匹配单个短横线，argv 层会把独立的 - 与 -- 也送进查表，导致 cat - 这类管道用法被误拒
// [并发] 正则无 g 标志、无 lastIndex 状态，多个校验调用并发复用不会互相污染
export const OPTION_PATTERN = /^-[a-zA-Z0-9_-]/;

// tree 的安全表：目录展示类选项；-o（写文件）刻意不收录，命中即判不可只读。
// [范围] 仅收录 tree 的展示类开关：排序、着色、深度、忽略模式、字符集与输出格式，全部只读目录树
// [排除] -o 与 --output 写文件，故意不收录；一旦收录，带输出路径的 tree 会被判只读并直接落盘
// [排除] -R 会递归执行子 tree，属于进程派生，不收录；而 --fromfile 只读取列表文件，故保留
// [取值] -L/--filelimit 标为 number，-H/-I/-P/-T/--sort 标为 string；标错会让 argv 层少吞或多吞一个词
// [失败路径] 表项缺失时 tree 命令整体降级为「需确认」，不会误放行；这是刻意选择的保守失败方向
// [权衡] 收录面偏宽（含 -J/--json 等输出变体），因为 tree 本身没有写盘能力，风险集中收敛在 -o 一个开关上
// [资源] 本表只是字面量映射，不含任何目录遍历逻辑，深目录不会在此处产生栈深或句柄开销
export const TREE_SAFE_FLAGS = {
  "-A": "none",
  "-C": "none",
  "-D": "none",
  "-F": "none",
  "-H": "string",
  "-I": "string",
  "-J": "none",
  "-L": "number",
  "-N": "none",
  "-P": "string",
  "-Q": "none",
  "-S": "none",
  "-T": "string",
  "-U": "none",
  "-X": "none",
  "-a": "none",
  "-c": "none",
  "-d": "none",
  "-f": "none",
  "-g": "none",
  "-h": "none",
  "-i": "none",
  "-l": "none",
  "-n": "none",
  "-p": "none",
  "-q": "none",
  "-r": "none",
  "-s": "none",
  "-t": "none",
  "-u": "none",
  "-v": "none",
  "-x": "none",
  "--authority": "string",
  "--charset": "string",
  "--device": "none",
  "--dirsfirst": "none",
  "--du": "none",
  "--fflinks": "none",
  "--filelimit": "number",
  "--filesfirst": "none",
  "--fromfile": "none",
  "--fromtabfile": "none",
  "--gitfile": "string",
  "--gitignore": "none",
  "--help": "none",
  "--hintro": "string",
  "--houtro": "string",
  "--hyperlink": "none",
  "--ignore-case": "none",
  "--inodes": "none",
  "--info": "none",
  "--infofile": "string",
  "--matchdirs": "none",
  "--metafirst": "none",
  "--nolinks": "none",
  "--noreport": "none",
  "--prune": "none",
  "--scheme": "string",
  "--si": "none",
  "--sort": "string",
  "--timefmt": "string",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// cat 的安全表：全部是输出格式开关，不涉及写盘或执行子进程。
// [范围] cat 的全部选项都是输出变换（编号、显示制表符与行尾、压缩空行），不触碰文件内容
// [权衡] 收录 -u 无缓冲与 --number-nonblank 等 GNU 变体，兼容性优先于最小面
// [失败路径] cat 的写能力来自 shell 重定向而非自身 flag，本表无法也无需拦截重定向写法
// [并发] 表为只读常量，多个会话同时校验同一条命令不产生写竞争
export const CAT_SAFE_FLAGS = {
  "-A": "none",
  "-E": "none",
  "-T": "none",
  "-b": "none",
  "-e": "none",
  "-n": "none",
  "-s": "none",
  "-t": "none",
  "-u": "none",
  "-v": "none",
  "--number": "none",
  "--number-nonblank": "none",
  "--show-all": "none",
  "--show-ends": "none",
  "--show-nonprinting": "none",
  "--show-tabs": "none",
  "--squeeze-blank": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// head/tail 的安全表：-c/-n 需要数字取值，其余为静默/详细开关。
// [取值] -c/--bytes 与 -n/--lines 标为 number：必须消费一个纯数字 argv，否则 -n 之后的文件名会被当成计数
// [特例] 紧凑写法 -10 由 argv 层的 isHeadTailCompactCountFlag 单独放行，不依赖本表登记
// [排除] 不收录 -f/--follow 与 --pid 类持续读取选项，避免只读判定放行长驻不退出的进程
// [失败路径] 若把 -c 误标为 none，尾部计数会被当成操作数，其后的 flag 将逃过逐项校验
export const HEAD_TAIL_SAFE_FLAGS = {
  "-c": "number",
  "-n": "number",
  "-q": "none",
  "-v": "none",
  "--bytes": "number",
  "--lines": "number",
  "--quiet": "none",
  "--silent": "none",
  "--verbose": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// wc 的安全表：计数维度选择，均为无值开关，只读输入流。
// [范围] wc 只统计字节、字符、行、词与最长行，没有任何输出到文件的开关
// [权衡] -L 与 --max-line-length 同时保留：BSD 与 GNU 对短选项的含义不同，本表按命令名不做分支区分
// [失败路径] 表项缺失只会让 wc 被判不可只读，不会造成误放行
export const WC_SAFE_FLAGS = {
  "-L": "none",
  "-c": "none",
  "-l": "none",
  "-m": "none",
  "-w": "none",
  "--bytes": "none",
  "--chars": "none",
  "--lines": "none",
  "--max-line-length": "none",
  "--words": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// ripgrep 的安全表：搜索范围与输出选项；--follow 只跟随符号链接读取，不写盘。
// [范围] ripgrep 的搜索范围（--glob/--type/--max-depth）、上下文行数与输出格式开关
// [取值] -A/-B/-C/-m 与 --max-count 标为 number，-e/-g/-t 等标为 string；数值型若标成 string 会接受非数字取值
// [排除] --pre 与 --pre-glob（对每个文件执行外部程序）不收录，这是本表最重要的一条安全边界
// [排除] 解压搜索类选项（调用解压器读取压缩包）不收录，避免把子进程派生伪装成只读搜索
// [权衡] --follow 收录：它只让遍历穿过符号链接，不写盘，代价是可能读到链接目标，但仍是读操作
// [资源] --max-filesize 与 --max-depth 收录后可作为调用侧限制遍历规模的手段，表本身不设硬上限
// [失败路径] 未登记 flag 会走兼容路径（粘连取值、短簇展开），两者都不成立才拒绝；表越窄，兼容路径被触发得越频繁
// [并发] 表在模块初始化时构造完毕，之后只读，热路径上查表是纯内存散列访问
export const RG_SAFE_FLAGS = {
  "-A": "number",
  "-B": "number",
  "-C": "number",
  "-F": "none",
  "-H": "none",
  "-L": "none",
  "-N": "none",
  "-S": "none",
  "-T": "string",
  "-c": "none",
  "-e": "string",
  "-g": "string",
  "-h": "none",
  "-i": "none",
  "-l": "none",
  "-m": "number",
  "-n": "none",
  "-s": "none",
  "-t": "string",
  "-u": "none",
  "-v": "none",
  "-w": "none",
  "-x": "none",
  "--after-context": "number",
  "--before-context": "number",
  "--case-sensitive": "none",
  "--context": "number",
  "--count": "none",
  "--count-matches": "none",
  "--files": "none",
  "--files-with-matches": "none",
  "--fixed-strings": "none",
  "--follow": "none",
  "--glob": "string",
  "--hidden": "none",
  "--ignore-case": "none",
  "--ignore-file": "string",
  "--iglob": "string",
  "--invert-match": "none",
  "--json": "none",
  "--line-number": "none",
  "--line-regexp": "none",
  "--max-count": "number",
  "--max-depth": "number",
  "--max-filesize": "string",
  "--no-filename": "none",
  "--no-ignore": "none",
  "--no-ignore-parent": "none",
  "--no-ignore-vcs": "none",
  "--no-line-number": "none",
  "--pcre2": "none",
  "--regexp": "string",
  "--smart-case": "none",
  "--sort": "string",
  "--sortr": "string",
  "--type": "string",
  "--type-not": "string",
  "--unrestricted": "none",
  "--with-filename": "none",
  "--word-regexp": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// grep 的安全表：检索与输出选项；--pre（执行程序）类危险选项不收录。
// [范围] grep 的匹配模式（-E/-F/-P/-G）、递归与文件筛选（-r/-R/--include/--exclude）以及输出控制
// [排除] --pre 不收录：它把每个输入文件交给指定程序处理，等价于任意命令执行
// [取值] -D/--devices 与 -d/--directories 标为 string，-m/--max-count 与 -A/-B/-C 标为 number
// [特例] --binary-files 的取值是固定枚举串，这里按 string 处理，不做枚举校验，非法值交由 grep 自身报错
// [权衡] 同时收录 -r 与 -R：两者都只读，区别仅在符号链接的处理策略
// [失败路径] -f/--file 让模式来自文件，仍是读取；若误删该项，带模式文件的 grep 会被判不可只读，形成可用性回退
// [资源] grep 的递归深度由文件系统决定，本表不做限制，调用侧需依赖超时与输出截断兜底
export const GREP_SAFE_FLAGS = {
  "-A": "number",
  "-B": "number",
  "-C": "number",
  "-E": "none",
  "-F": "none",
  "-G": "none",
  "-H": "none",
  "-I": "none",
  "-L": "none",
  "-P": "none",
  "-R": "none",
  "-a": "none",
  "-b": "none",
  "-c": "none",
  "-D": "string",
  "-d": "string",
  "-e": "string",
  "-f": "string",
  "-h": "none",
  "-i": "none",
  "-l": "none",
  "-m": "number",
  "-n": "none",
  "-o": "none",
  "-q": "none",
  "-r": "none",
  "-s": "none",
  "-T": "none",
  "-u": "none",
  "-U": "none",
  "-v": "none",
  "-V": "none",
  "-w": "none",
  "-x": "none",
  "-Z": "none",
  "-z": "none",
  "--after-context": "number",
  "--basic-regexp": "none",
  "--before-context": "number",
  "--binary": "none",
  "--binary-files": "string",
  "--byte-offset": "none",
  "--color": "string",
  "--colour": "string",
  "--context": "number",
  "--count": "none",
  "--dereference-recursive": "none",
  "--directories": "string",
  "--devices": "string",
  "--exclude": "string",
  "--exclude-dir": "string",
  "--exclude-from": "string",
  "--extended-regexp": "none",
  "--file": "string",
  "--files-with-matches": "none",
  "--files-without-match": "none",
  "--fixed-strings": "none",
  "--group-separator": "string",
  "--help": "none",
  "--ignore-case": "none",
  "--include": "string",
  "--initial-tab": "none",
  "--invert-match": "none",
  "--label": "string",
  "--line-buffered": "none",
  "--line-number": "none",
  "--line-regexp": "none",
  "--max-count": "number",
  "--no-group-separator": "none",
  "--no-filename": "none",
  "--no-ignore-case": "none",
  "--no-messages": "none",
  "--null": "none",
  "--null-data": "none",
  "--only-matching": "none",
  "--perl-regexp": "none",
  "--quiet": "none",
  "--recursive": "none",
  "--regexp": "string",
  "--silent": "none",
  "--text": "none",
  "--unix-byte-offsets": "none",
  "--version": "none",
  "--with-filename": "none",
  "--word-regexp": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// sed 的安全表：仅覆盖"只输出到 stdout"的选项；-i（原地写）由 isSedInPlaceOption 单独拦截。
// [范围] 仅收录把结果写到 stdout 的选项：-n 静默、-e/--expression 提供脚本、-E/-r 启用扩展正则
// [排除] -i/--in-place 不收录；其变体（带后缀备份、带空串、长选项加等号）由 isSedInPlaceOption 回调统一拦截
// [权衡] 脚本内容本身不在此校验：sed 脚本里的写文件命令仍可落盘，故 sed 的安全性依赖调用侧的额外规则
// [失败路径] 若只依赖本表而删除 isSedInPlaceOption，原地改写会被判只读，这是最危险的一类回归
// [取值] -e/--expression 标为 string、-l/--line-length 标为 number，标错会错位消费后续 argv
// [并发] sed 脚本不在本文件求值，表不持有任何解释器状态，跨调用无共享数据
export const SED_SAFE_FLAGS = {
  "-E": "none",
  "-e": "string",
  "-l": "number",
  "-n": "none",
  "-r": "none",
  "-s": "none",
  "-u": "none",
  "-z": "none",
  "--debug": "none",
  "--expression": "string",
  "--help": "none",
  "--line-length": "number",
  "--posix": "none",
  "--quiet": "none",
  "--regexp-extended": "none",
  "--separate": "none",
  "--silent": "none",
  "--unbuffered": "none",
  "--version": "none",
  "--zero-terminated": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// -I 的取值是替换占位符（"{}"），-E 是输入结束符（"EOF"），-d 是单字符分隔符；
// 分别用专用类型声明，argv 层据此知道"必须且只能消费一个对应形态的取值"。
// [范围] xargs 自身的参数：分隔符、替换占位符、批大小、并行度与输入结束符
// [取值] -I 标为 {}、-E 标为 EOF、-d 标为 char，三者都比 string 更严，防止占位符或结束符写错却静默通过
// [失败路径] 目标命令是否可执行由 XARGS_TARGET_COMMANDS 决定，本表无权放行；两道闸门必须同时成立
// [排除] -a/--arg-file 暂不收录：从文件读参数虽只读，但仍需与目标命令白名单联合判断才安全
// [权衡] -P 并行度只影响调度，不改变只读性；标为 number 是为了让非法数值在取值校验处被挡住
// [资源] xargs 会派生目标命令，实际进程数由并行度与批大小决定，本表不做运行期限流
export const XARGS_SAFE_FLAGS = {
  "-0": "none",
  "-E": "EOF",
  "-I": "{}",
  "-L": "number",
  "-P": "number",
  "-d": "char",
  "-n": "number",
  "-r": "none",
  "-s": "number",
  "-t": "none",
  "-x": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// file 的安全表：类型探测与输出格式；-f/--magic-file 需要取值，但仍只读。
// [范围] file 的类型探测与输出格式选项：--mime 系列、--brief、--print0、--separator 等
// [取值] -f/--magic-file、-m、--separator、--exclude 标为 string：它们指向规则文件或分隔符，仍然只读
// [排除] 解压类选项不收录：解压需要派生外部程序，超出只读判定范围
// [排除] -C（编译 magic 文件并写出产物）不收录，因为它会生成新的二进制文件
// [权衡] --keep-going 与 --no-buffer 等行为开关照收，它们只影响错误处理与缓冲策略，不改变读写面
// [资源] --exclude-quiet 只抑制警告输出，不改变实际读取范围，也不减少句柄占用
export const FILE_SAFE_FLAGS = {
  "-0": "none",
  "-F": "string",
  "-L": "none",
  "-b": "none",
  "-c": "none",
  "-f": "string",
  "-h": "none",
  "-i": "none",
  "-k": "none",
  "-l": "none",
  "-m": "string",
  "-n": "none",
  "-p": "none",
  "-r": "none",
  "-s": "none",
  "-v": "none",
  "--apple": "none",
  "--brief": "none",
  "--check-encoding": "none",
  "--dereference": "none",
  "--exclude": "string",
  "--exclude-quiet": "string",
  "--help": "none",
  "--keep-going": "none",
  "--list": "none",
  "--magic-file": "string",
  "--mime": "none",
  "--mime-encoding": "none",
  "--mime-type": "none",
  "--no-buffer": "none",
  "--no-dereference": "none",
  "--preserve-date": "none",
  "--print0": "none",
  "--raw": "none",
  "--separator": "string",
  "--special-files": "none",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// jq 的安全表：输出格式与输入模式开关；-f/--argfile 等读脚本能力由 jqCommandIsDangerous 拦截。
// [范围] jq 的输入模式（-n/--null-input、-s/--slurp）与输出格式（-c/-r/-C/-S/--tab/--indent）
// [排除] -f/--from-file 与 --argfile/--slurpfile 会读取外部脚本或数据，由 jqCommandIsDangerous 回调判断
// [权衡] 回调与白名单是逻辑与的关系：表负责开关面，回调负责脚本内容与文件路径，任一放宽都会扩大可执行面
// [取值] --indent 标为 number 以限定缩进宽度；标成 string 会让非法宽度通过判定层，改为在 jq 侧报错
// [失败路径] -e/--exit-status 只改退出码语义，不影响只读性，收录无风险
// [并发] jq 进程由外部创建，本表不做进程管理，仅决定其参数是否被允许
export const JQ_SAFE_FLAGS = {
  "-C": "none",
  "-M": "none",
  "-S": "none",
  "-c": "none",
  "-e": "none",
  "-n": "none",
  "-r": "none",
  "-s": "none",
  "--color-output": "none",
  "--compact-output": "none",
  "--exit-status": "none",
  "--indent": "number",
  "--monochrome-output": "none",
  "--null-input": "none",
  "--raw-output": "none",
  "--slurp": "none",
  "--sort-keys": "none",
  "--tab": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;
