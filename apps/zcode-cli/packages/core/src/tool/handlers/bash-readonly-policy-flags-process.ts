/**
 * 进程/网络/系统信息类只读命令的安全 flag 表（ps、pyright、man、netstat、lsof、pgrep、tput、ss）。
 * 这些命令的参数语义无法被通用 flag 规则覆盖（ps 的 BSD 风格位置参数、ss 的过滤表达式），
 * 所以除了本文件的表，还会叠加 bash-readonly-policy-callbacks.ts 里的 *CommandIsDangerous 回调：
 * 回调返回 true 时即使 flag 合法也判不可读，返回 false 才继续按表校验其余参数。
 */

// 模块说明：本文件是纯数据策略模块，不含可执行分支，全部导出为 as const satisfies 的只读字面量。
// 模块说明：表被 bash-readonly-policy 的 argv 解析器与 *CommandIsDangerous 回调共同消费，表自身不触碰文件、网络或子进程。
// 模块说明：新增一条 flag 等于给命令放行一种参数形态，放行面越宽，误判为只读的风险越大，故按命令逐张分表隔离。
// 模块说明：表中缺项一律走拒绝路径而不是默认放行，白名单的失败方向必须始终偏向保守。
// INV-01 只读命令判定须命令名与参数白名单双重命中才算放行；守住位置：各 *_SAFE_FLAGS 导出表；改错故障：只认命令名会让 ps 被塞入写盘参数后仍判只读。
// INV-02 每张表只描述一个命令的参数语义，同名键跨命令不共享含义；守住位置：PYRIGHT/MAN/NETSTAT 三张独立表；改错故障：合并表后 -f 在 netstat 与 man 下被按同一取值规则解析，过滤表达式被误当成合法开关。
// INV-03 取值为 string 的键必须消费紧随其后的一个 argv 元素；守住位置：各表 "-x": "string" 条目；改错故障：不消费取值会把用户传入的路径当成下一个 flag，后续危险参数被跳过校验。
// INV-04 取值为 number 的键必须校验实参可解析为数字；守住位置：PS_SAFE_FLAGS 的 --width 与 GH_LIMIT_REPO_FLAGS 的 --limit；改错故障：--limit 吞掉非数字后 gh 查询行为退化，用户拿不到预期的条数截断。
// INV-05 位置参数不由表覆盖，必须交给 *CommandIsDangerous 回调兜底；守住位置：ps 的 BSD 风格参数与 ss 的过滤表达式；改错故障：把位置参数一律视为安全会放行 ps 中可触发写文件的参数组合。
// INV-06 能主动改变系统状态的选项刻意不收录，缺项即拒绝；守住位置：PGREP_SAFE_FLAGS 排除 --signal；改错故障：收录发信号选项后 pgrep --signal 会向任意进程投递信号，形成真实进程副作用。
// INV-07 判定只读不等于保证零副作用，读取本身也可能触发内核侧动作；守住位置：NETSTAT_SAFE_FLAGS 与 LSOF_SAFE_FLAGS 的放行面；改错故障：审计时把 netstat -r 视为纯内存查询，忽略其触发路由表遍历的权限与耗时开销。
// INV-08 会留下持久化痕迹的选项一律排除，读取通道不得落盘；守住位置：PGREP_SAFE_FLAGS 对 --pidfile 的取舍；改错故障：--pidfile 会写入文件，误收录后只读通道可以直接在用户机器上创建文件。
// INV-09 每个键的取值类型必须与该命令的真实语法一致；守住位置：TEST_SAFE_FLAGS 全部声明为 string；改错故障：把 test 操作符当成 none 会丢失操作数，test -f 之后的路径未被消费并被当成新参数解析。
// INV-10 docker logs 的 -f/--follow 会长驻输出但不改变容器状态；守住位置：DOCKER_LOGS_SAFE_FLAGS；改错故障：误当成写操作而拒绝会切断用户排查容器故障的唯一只读通道。
// INV-11 长驻流式输出的超时与取消由上层执行器承担，不在本表表达；守住位置：DOCKER_LOGS_SAFE_FLAGS 的 --since/--until；改错故障：表里承诺超时会让调用方误以为资源生命周期已被兜住而不再设置取消。
// INV-12 docker inspect 只读元数据，但 -f/--format 会在客户端执行模板求值；守住位置：DOCKER_INSPECT_SAFE_FLAGS；改错故障：把 format 当成普通字符串放行后，模板求值失败只以原始报错暴露给用户，缺少可操作提示。
// INV-13 gh 表按片段叠加，基础片段只含目标仓库定位；守住位置：GH_REPO_FLAGS 与 GH_JSON_REPO_FLAGS 的展开顺序；改错故障：把 --json 混进基础片段会让所有 gh 子命令默认继承查询输出契约，写入型子命令同样被污染。
// INV-14 叠加使用对象展开，后者覆盖前者，键冲突时以最具体的表为准；守住位置：GH_LIMIT_REPO_FLAGS 对 GH_JSON_REPO_FLAGS 的展开；改错故障：反转展开顺序会让 --limit 的 number 约束被旧值覆盖为未声明。
// INV-15 所有表都是 as const satisfies，编译期即校验键值属于 SafeFlagValue 联合；守住位置：每张表末尾的类型断言；改错故障：去掉 satisfies 后拼错的 "strings" 会静默退化，该键不再消费实参。
// INV-16 表是编译期常量，进程内无共享可变状态，多会话并发读取无需加锁；守住位置：全部 export const 字面量；改错故障：把表改成运行时可变对象后，一个会话的放行调整会泄漏到其他并发会话。
// INV-17 拒绝路径的默认结果是判定失败并回落审批，不得静默降级为可读；守住位置：表查不到键时调用方的分支；改错故障：静默放行会让用户在没有确认弹窗的情况下执行被拒命令。
// INV-18 误判为只读的代价是不可回滚的真实副作用，故宁拒绝不误放；守住位置：全部白名单的收口处；改错故障：可写选项混入后只读判定直接绕过权限审批，用户失去最后一次拦截机会。
// INV-19 表项顺序与上游命令手册的顺序保持一致，便于逐项对照；守住位置：各表键的排列；改错故障：乱序后新增项容易与相邻命令的可写选项混淆，评审时难以发现越权放行。
import type { SafeFlagValue } from "./bash-readonly-policy-types.js";

// ps 的安全表：进程查询类开关；带值的选项声明为 string，位置参数（BSD 风格）由回调兜底判定。
// 不变量：ps 只读取内核进程表快照，任何键都不得触发信号投递或写文件。
// 设计权衡：BSD 风格位置参数无法用键值白名单表达，本表只覆盖选项形态，剩余形态交给回调判定。
// 失败路径：表内查不到键时判定失败并回落审批，不能默认放行。
// 并发语义：ps -p 只观测瞬时快照，进程在两次采样之间退出属于正常竞态，不做重试。
// 资源生命周期：-ww 放宽列宽只影响输出格式，不改变采样成本，也不延长进程存活时间。
export const PS_SAFE_FLAGS = {
  "-A": "none",
  "-C": "string",
  "-F": "none",
  "-G": "string",
  "-H": "none",
  "-L": "none",
  "-N": "none",
  "-T": "none",
  "-U": "string",
  "-V": "none",
  "-a": "none",
  "-c": "none",
  "-d": "none",
  "-e": "none",
  "-f": "none",
  "-g": "string",
  "-j": "none",
  "-l": "none",
  "-m": "none",
  "-n": "string",
  "-p": "string",
  "-q": "string",
  "-s": "string",
  "-t": "string",
  "-u": "string",
  "-w": "none",
  "-ww": "none",
  "-y": "none",
  "--deselect": "none",
  "--forest": "none",
  "--headers": "none",
  "--help": "none",
  "--info": "none",
  "--no-headers": "none",
  "--pid": "string",
  "--quick-pid": "string",
  "--sid": "string",
  "--sort": "string",
  "--tty": "string",
  "--user": "string",
  "--version": "none",
  "--width": "number",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// pyright 的安全表：类型检查工具的输出/范围选项，均不写文件、不联网。
// 不变量：这些选项只影响类型检查的输入范围与输出格式，不写缓存目录也不联网。
// 设计权衡：--outputjson 改变输出协议但仍是只读查询，故保留在白名单而不是分流到专用通道。
// 失败路径：未知选项不匹配任何键，判定失败并回落审批，而不是直接执行。
export const PYRIGHT_SAFE_FLAGS = {
  "--dependencies": "none",
  "--level": "string",
  "--outputjson": "none",
  "--pythonplatform": "string",
  "--pythonversion": "string",
  "--stats": "none",
  "--verbose": "none",
  "--version": "none",
  "--warnings": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// man 的安全表：只读手册页；-k/-f 等搜索模式同样不产生副作用。
// 不变量：man 只渲染手册页，-k/-f 仅切换检索模式。
// 设计权衡：-w 只打印手册文件位置而不读取内容，放行它不会扩大读取面。
// 失败路径：-P 可指定任意分页器，等于执行外部命令，未被收录，命中时走拒绝路径。
export const MAN_SAFE_FLAGS = {
  "-S": "string",
  "-a": "none",
  "-d": "none",
  "-f": "none",
  "-h": "none",
  "-k": "none",
  "-s": "string",
  "-w": "none",
  "--all": "none",
  "--apropos": "none",
  "--whatis": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// netstat 的安全表：只列举连接与统计；-f 的地址族取值交给 argv 层校验。
// 不变量：netstat 只读取内核网络统计，不建立连接也不改动路由表。
// 设计权衡：-f 的地址族实参交给 argv 层校验，表内只负责声明需要消费取值。
// 并发语义：连接表在采样期间持续变化，统计数字存在天然漂移，不属于判定错误。
// 失败路径：表外选项不消费实参，若放行会让后续参数整体错位，故直接判拒绝。
export const NETSTAT_SAFE_FLAGS = {
  "-I": "string",
  "-L": "none",
  "-a": "none",
  "-f": "string",
  "-g": "none",
  "-i": "none",
  "-l": "none",
  "-m": "none",
  "-n": "none",
  "-r": "none",
  "-s": "none",
  "-v": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// lsof 的安全表：文件/端口占用查询；-k 等带值选项按 string 处理，其余为开关。
// 不变量：lsof 只枚举已打开的文件与端口占用，不关闭任何描述符也不修改文件。
// 设计权衡：带值选项统一声明为 string，避免取值与下一个 flag 粘连造成参数错位。
// 资源生命周期：大范围查询会临时占用较多内存，由上层输出截断承载，不由本表限制。
// 失败路径：-k 等需取值的键缺少实参时判定失败，不退回默认开关语义。
export const LSOF_SAFE_FLAGS = {
  "-?": "none",
  "-A": "string",
  "-C": "none",
  "-E": "none",
  "-F": "none",
  "-H": "none",
  "-K": "none",
  "-L": "none",
  "-N": "none",
  "-O": "none",
  "-P": "none",
  "-Q": "none",
  "-R": "none",
  "-S": "none",
  "-T": "none",
  "-U": "none",
  "-V": "none",
  "-X": "none",
  "-a": "none",
  "-b": "none",
  "-c": "string",
  "-d": "string",
  "-e": "string",
  "-g": "none",
  "-h": "none",
  "-i": "none",
  "-k": "string",
  "-l": "none",
  "-n": "none",
  "-o": "none",
  "-p": "string",
  "-r": "none",
  "-s": "none",
  "-t": "none",
  "-u": "string",
  "-v": "none",
  "-x": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// pgrep 的安全表：进程匹配查询；--signal 之类能发信号的选项刻意不收录。
// 不变量：pgrep 只按条件匹配进程并打印 pid，不向匹配结果发送任何信号。
// 设计权衡：--signal 及可发信号的组合刻意不收录，缺项即走拒绝路径。
// 失败路径：--pidfile 会写入文件，属于进程副作用的持久化形态，必须排除在只读表之外。
// 并发语义：匹配与打印之间进程可能退出，pid 失效属于正常现象，本表不做存在性校验。
// 资源生命周期：--older 与 --newest 只比较进程起始时间，不创建或回收任何系统资源。
export const PGREP_SAFE_FLAGS = {
  "-F": "string",
  "-G": "string",
  "-L": "none",
  "-O": "string",
  "-P": "string",
  "-U": "string",
  "-V": "none",
  "-a": "none",
  "-c": "none",
  "-d": "string",
  "-f": "none",
  "-g": "string",
  "-i": "none",
  "-l": "none",
  "-n": "none",
  "-o": "none",
  "-r": "string",
  "-s": "string",
  "-t": "string",
  "-u": "string",
  "-v": "none",
  "-w": "none",
  "-x": "none",
  "--count": "none",
  "--delimiter": "string",
  "--euid": "string",
  "--exact": "none",
  "--full": "none",
  "--group": "string",
  "--help": "none",
  "--ignore-case": "none",
  "--inverse": "none",
  "--lightweight": "none",
  "--list-full": "none",
  "--list-name": "none",
  "--logpidfile": "none",
  "--newest": "none",
  "--ns": "string",
  "--nslist": "string",
  "--older": "string",
  "--oldest": "none",
  "--parent": "string",
  "--pgroup": "string",
  "--pidfile": "string",
  "--runstates": "string",
  "--session": "string",
  "--terminal": "string",
  "--uid": "string",
  "--version": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 不变量：tput 只查询终端能力或输出控制序列，不改终端驱动配置。
// 设计权衡：-T 显式指定终端类型，需要消费实参，故声明为 string 而非 none。
// 失败路径：表外子命令会重置终端状态，命中时拒绝，避免污染用户当前会话。
export const TPUT_SAFE_FLAGS = {
  "-T": "string",
  "-V": "none",
  "-x": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// ss 的安全表：socket 统计查询；过滤表达式无法用 flag 表覆盖，依赖 ssCommandIsDangerous 兜底。
// 不变量：ss 只读取 socket 统计，能关闭或重置连接的选项不在表内。
// 设计权衡：过滤表达式无法用键值表表达，本表只放行选项形态，表达式语义交给回调判定。
// 失败路径：表达式中出现可执行或写文件形态时回调返回 true，整条命令判不可读。
// 并发语义：socket 表随连接建立与关闭实时变化，统计与列举结果不一致属于预期。
export const SS_SAFE_FLAGS = {
  "-0": "none",
  "-4": "none",
  "-6": "none",
  "-A": "string",
  "-E": "none",
  "-H": "none",
  "-M": "none",
  "-O": "none",
  "-S": "none",
  "-V": "none",
  "-Z": "none",
  "-a": "none",
  "-b": "none",
  "-d": "none",
  "-e": "none",
  "-f": "string",
  "-h": "none",
  "-i": "none",
  "-l": "none",
  "-m": "none",
  "-n": "none",
  "-o": "none",
  "-p": "none",
  "-s": "none",
  "-t": "none",
  "-u": "none",
  "-w": "none",
  "-x": "none",
  "-z": "none",
  "--all": "none",
  "--bpf": "none",
  "--cgroup": "none",
  "--contexts": "none",
  "--context": "none",
  "--dccp": "none",
  "--events": "none",
  "--extended": "none",
  "--family": "string",
  "--help": "none",
  "--inet-sockopt": "none",
  "--info": "none",
  "--ipv4": "none",
  "--ipv6": "none",
  "--listening": "none",
  "--memory": "none",
  "--mptcp": "none",
  "--no-header": "none",
  "--numeric": "none",
  "--oneline": "none",
  "--options": "none",
  "--packet": "none",
  "--processes": "none",
  "--query": "string",
  "--raw": "none",
  "--sctp": "none",
  "--socket": "string",
  "--summary": "none",
  "--tcp": "none",
  "--tipc": "none",
  "--tipcinfo": "none",
  "--tos": "none",
  "--udp": "none",
  "--unix": "none",
  "--version": "none",
  "--vsock": "none",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// test 的每个操作符都固定消费一个操作数（test -f FILE），所以全部声明为 "string"；
// -a/-o 会组合表达式、-v/-R 会解析变量/递归路径，均不在表中，由回调兜底判危险。
// 不变量：test 的每个操作符固定消费一个操作数，表内全部声明为 string。
// 设计权衡：-a 与 -o 会组合多个表达式，组合后无法保证每个分支都只读，故不收录。
// 失败路径：-v 会解引用变量名，-R 会递归路径，两者都排除，命中即拒绝。
// 资源生命周期：-e/-f 等做一次元数据查询就返回，不持有文件句柄。
// 并发语义：判定期间文件可能被其他进程删除或替换，结果只反映判定时刻的状态。
export const TEST_SAFE_FLAGS = {
  "-b": "string",
  "-c": "string",
  "-d": "string",
  "-e": "string",
  "-ef": "string",
  "-eq": "string",
  "-f": "string",
  "-g": "string",
  "-G": "string",
  "-ge": "string",
  "-gt": "string",
  "-h": "string",
  "-k": "string",
  "-L": "string",
  "-le": "string",
  "-lt": "string",
  "-N": "string",
  "-n": "string",
  "-ne": "string",
  "-nt": "string",
  "-O": "string",
  "-ot": "string",
  "-p": "string",
  "-r": "string",
  "-s": "string",
  "-S": "string",
  "-t": "string",
  "-u": "string",
  "-w": "string",
  "-x": "string",
  "-z": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// docker logs 的安全表：只读容器日志；--tail/--since 需要取值，其余为开关。
// 不变量：docker logs 只读取容器已有日志，不重启容器也不写入容器文件系统。
// 资源生命周期：-f 会长期持有输出流直到超时或取消，生命周期由上层执行器管理。
// 设计权衡：--tail 与 --since 需要取值，声明为 string 以正确消费实参。
export const DOCKER_LOGS_SAFE_FLAGS = {
  "-f": "none",
  "-n": "string",
  "-t": "none",
  "--details": "none",
  "--follow": "none",
  "--since": "string",
  "--tail": "string",
  "--timestamps": "none",
  "--until": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// docker inspect 的安全表：元数据查询；-f/--format 与 --type 需要取值。
// 不变量：docker inspect 只返回容器或镜像的元数据快照，不触发状态变更。
// 设计权衡：-f/--format 会做模板求值，属于读取侧计算，仍保留在白名单内。
// 失败路径：--type 取值非法时由 docker 自身报错，本表不重复校验取值集合。
export const DOCKER_INSPECT_SAFE_FLAGS = {
  "-f": "string",
  "-s": "none",
  "--format": "string",
  "--size": "none",
  "--type": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// gh 的仓库定位片段：只指定目标 repo，不携带任何写入语义。
// 后续 gh 子命令表按需叠加 --json / --limit，避免把查询能力混进基础片段。
// 不变量：基础片段只表达目标仓库定位，不携带任何写入或变更语义。
// 设计权衡：把 --json 与 --limit 拆到上层片段，避免所有 gh 子命令被动继承查询输出形态。
// 失败路径：-R 缺少实参时判定失败，不能把下一条参数当成仓库名消费掉。
// 并发语义：片段是编译期常量，多个 gh 调用并发读取同一对象不存在共享写。
export const GH_REPO_FLAGS = {
  "-R": "string",
  "--repo": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 叠加 JSON 输出：--json 需要字段列表取值，仍属于只读查询形态。
// 不变量：--json 需要字段列表取值，仍属于只读查询，不触发远端写操作。
// 设计权衡：用对象展开复用基础片段，键冲突时后写的 --json 生效。
// 失败路径：字段名非法由 gh 返回错误，本表只负责消费实参，不校验字段集合。
export const GH_JSON_REPO_FLAGS = {
  ...GH_REPO_FLAGS,
  "--json": "string",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;

// 叠加条数限制：-L/--limit 必须消费数字，防止把后续参数误读成数量。
// 不变量：-L 与 --limit 必须消费一个数字，防止后续参数被误读成数量。
// 设计权衡：声明为 number 而非 string，让非数字实参在解析阶段即判定失败。
// 失败路径：数量缺省时不回退到无限条，交由 gh 默认值决定，避免本表隐式放行。
// 资源生命周期：条数上限约束单次输出体量，避免大仓库查询把整页结果灌进上下文。
export const GH_LIMIT_REPO_FLAGS = {
  ...GH_JSON_REPO_FLAGS,
  "-L": "number",
  "--limit": "number",
} as const satisfies Readonly<Record<string, SafeFlagValue>>;
