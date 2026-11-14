// INV-01 危险回调返回 true 即判定整条命令不可读，只有 false 才允许执行；守住位置：本文件全部导出函数的返回语句；改错故障：写文件或联网命令被当成只读放行
// INV-02 本文件只承接无法用 flag 表穷举参数语义的命令，其余交给简单命令规则；守住位置：文件顶部职责边界；改错故障：简单只读命令被误拒导致日常查询不可用
// INV-03 sed 的原地改写识别覆盖 -i、-i.bak、-i'' 与 --in-place 三种写法；守住位置：isSedInPlaceOption；改错故障：带备份后缀的原地改写绕过检查并覆盖源文件
// INV-04 sed 脚本内的 w 命令与 s///w 后置写标志同样按写文件处理；守住位置：sedScriptWritesToFile；改错故障：未带 -i 的 sed 把结果落盘改动工作区
// INV-05 sed 参数解析必须跨过 -e、--expression、-l、--line-length 的取值；守住位置：sedCommandIsDangerous 的选项分支；改错故障：取值被当作脚本判定，真正的写脚本漏检
// INV-06 sed 仅把第一个非选项参数视为脚本，其后的位置参数多是输入文件；守住位置：firstScriptSeen 分支；改错故障：文件名被误当脚本造成整类 sed 查询被拒
// INV-07 jq 的 -f、-L、--argfile、--rawfile、--slurpfile、--from-file、--run-tests 让过滤器脱离命令行字面量；守住位置：isJqDangerousOption；改错故障：jq 读取任意文件并经输出外泄
// INV-08 jq 过滤器中的 $ENV 与 env 读取进程环境，include 与 import 加载外部模块；守住位置：jqFilterIsDangerous；改错故障：环境变量里的密钥被打印进工具结果
// INV-09 jq 在定位首个 filter 时跳过选项取值与 --indent 参数，-- 之后的第一个参数直接按 filter 判定；守住位置：jqCommandIsDangerous 的循环；改错故障：filter 定位偏移使危险表达式漏检
// INV-10 date 只接受 +format 形态，任何非 + 开头的位置参数都视为设置系统时间；守住位置：dateCommandIsDangerous；改错故障：系统时钟被改动影响构建时间戳与证书有效期
// INV-11 ps 的 BSD 风格位置参数会输出进程环境；守住位置：psCommandIsDangerous 的正则；改错故障：进程环境中的令牌进入模型上下文
// INV-12 pyright 的 --watch 与 -w 是常驻监视而非一次性检查；守住位置：pyrightCommandIsDangerous；改错故障：工具调用长时间不返回并持续占用会话
// INV-13 man 在非 apropos 与 whatis 模式下把含斜杠的位置参数当本地文件读取；守住位置：manCommandIsDangerous 的斜杠分支；改错故障：任意本地文件被 man 渲染后原样回显
// INV-14 lsof 的 +m 与 -i@host 形态会触发命名服务或远端查询；守住位置：lsofCommandIsDangerous；改错故障：只读查询隐式发起 DNS 请求并阻塞执行
// INV-15 tput 的 clear、reset、smcup 等 capability 会改写终端状态；守住位置：TPUT_DANGEROUS_CAPABILITIES；改错故障：终端被清屏或复位导致交互界面错乱
// INV-16 tput 的 -S 从标准输入读取能力名，粘连短选项簇中的 S 具有同等风险；守住位置：tputCommandIsDangerous 的 -S 分支；改错故障：能力名来自管道输入而无法静态判定
// INV-17 ss 只接受纯数字地址与端口，含字母的 token 需要额外解析可能走网络；守住位置：ssCommandIsDangerous 的字母检测；改错故障：主机名解析触发 DNS 查询并泄露内网域名
// INV-18 test 的 -v、-R、-a、-o 与嵌套方括号无法静态判定；守住位置：testCommandIsDangerous 的首轮扫描；改错故障：递归路径或变量解析被当作纯比较放行
// INV-19 test 数值比较要求两侧都命中 TEST_SAFE_NUMBER；守住位置：数值操作符分支；改错故障：命令替换形式的操作数被当成只读比较执行
// INV-20 xargs 的目标命令只能来自 XARGS_TARGET_COMMANDS，gh 与 docker 的远端形态同理；守住位置：xargsCommandIsDangerous 与 hasDangerousDockerOption；改错故障：输入被拼成参数交给 rm 或 sh 形成任意命令执行
//
// 全文件遵循保守失败原则：只放行代码里写明安全语义的形态，未覆盖的参数组合一律判危险。
// 这些回调只做静态判定，不执行命令、不读取文件、不发网络请求，因此可以在每个策略条目上高频调用。
// 新增命令支持时优先扩展 flag 白名单表，确实无法穷举再落到本文件，并同步补充危险形态的回归用例。
//
/**
 * 只读策略里"单条命令的参数语义无法用 flag 表穷举"时使用的危险回调：
 * 每个函数接收 (commandText, argsAfterPrefix)，返回 true 表示该命令带写/联网/任意执行能力。
 * 由 bash-readonly-policy-simple-commands.ts、-argv-direct.ts、-argv-git.ts、
 * -git-subcommands-*.ts、-multiword-*.ts 的 policy 条目引用；返回 true 时整条命令判不可读。
 * 口径：宁可误拒也不误放——只验证代码里写明的安全形态，其余全部当作危险。
 */

// sed 的 -i 是唯一能直接改写文件内容的开关，本函数只回答「这个词是不是原地改写开关」。
// [权衡] 前缀匹配会把 -i.bak、-i'' 这类带备份后缀的写法一起收进来，宁可多拒也不漏放。
export function isSedInPlaceOption(word: string): boolean {
  // sed 的 -i 可以带备份后缀（-i.bak / -i''），只要前缀是 -i 就是原地改写文件。
  // [权衡] 只认词首的 -i 前缀，-ni 这类粘连短选项依赖上层 argv 规范化后才会命中这里。
  return word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=");
}

// jq 的危险性完全由 filter 内容与加载类选项决定，因此先定位 filter 再交给内容判定。
// [失败路径] 数组里没有 filter 时返回 false，等价于没有可执行的过滤器。
export function jqCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 找到第一个真正的 filter（跳过选项与 --indent 的取值），然后交给 filter 内容判定。
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isJqDangerousOption(arg)) return true;
    // [边界] -- 之后不再有选项语义，紧随其后的一个参数就是 filter，取不到时按空过滤器处理。
    if (arg === "--") return jqFilterIsDangerous(args[index + 1] ?? "");
    if (arg === "--indent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return jqFilterIsDangerous(arg);
  }
  return false;
}

function isJqDangerousOption(word: string): boolean {
  // 这些选项让 jq 从文件加载过滤器/模块/原始输入（-f/-L/--argfile/--slurpfile/--rawfile/
  // --from-file/--run-tests），读取范围不再由命令行字面量决定。
  return (
    word === "-f" ||
    word.startsWith("-f") ||
    word === "-L" ||
    word.startsWith("-L") ||
    word === "--argfile" ||
    word.startsWith("--argfile=") ||
    word === "--from-file" ||
    word.startsWith("--from-file=") ||
    word === "--library-path" ||
    word.startsWith("--library-path=") ||
    word === "--rawfile" ||
    word.startsWith("--rawfile=") ||
    word === "--run-tests" ||
    word.startsWith("--run-tests=") ||
    word === "--slurpfile" ||
    word.startsWith("--slurpfile=")
  );
}

function jqFilterIsDangerous(filter: string): boolean {
  // $ENV / env 会读取进程环境（可能包含密钥）；include/import 会加载任意 jq 模块文件。
  return (
    /\$ENV\b/.test(filter) ||
    /(^|[^A-Za-z0-9_$.])env(?=$|[^A-Za-z0-9_])/.test(filter) ||
    /(^|[^A-Za-z0-9_])(?:include|import)(?=$|[^A-Za-z0-9_])/.test(filter)
  );
}

// sed 的写路径只有两条：-i 原地改写，以及脚本内部的 w 写文件命令。
// [权衡] 其余参数组合不产生磁盘副作用，因此只要两条写路径都不命中就放行。
export function sedCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 只需要识别两种写路径：-i 原地改写，以及脚本里的 `w file` 命令。
  let firstScriptSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (isSedInPlaceOption(arg)) return true;
    // [边界] -e 与 --expression 后面紧跟一段脚本，取值必须跳过，否则会被当成位置参数反复检查。
    if (arg === "-e" || arg === "--expression") {
      index += 1;
      if (sedScriptWritesToFile(args[index] ?? "")) return true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (sedScriptWritesToFile(arg.slice("--expression=".length))) return true;
      continue;
    }
    if (arg === "-l" || arg === "--line-length") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--line-length=")) continue;
    if (arg === "--") {
      // [边界] -- 之后的第一段是脚本而不是选项，即使以 - 开头也按脚本内容检查写命令。
      const script = args[index + 1] ?? "";
      return sedScriptWritesToFile(script);
    }
    if (!arg.startsWith("-") && !firstScriptSeen) {
      firstScriptSeen = true;
      if (sedScriptWritesToFile(arg)) return true;
    }
  }
  return false;
}

// 脚本判定的目标是把可能落盘的 sed 语法一次筛掉，包括 w、1,2w、/re/w 以及 s///w 后缀。
// [失败路径] 正则只认命令位置上的 w，普通文本里的字母 w 不会触发误拒。
function sedScriptWritesToFile(script: string): boolean {
  // 匹配 `w`/`1,2w`/`/re/w` 这类写文件命令；`s///w` 也属于写，因此必须拒绝整段脚本。
  // [权衡] 该正则覆盖 s///w 这种把替换结果写进文件的后缀，代价是含 w 的模糊脚本可能被误拒。
  return /(?:^|[;{\n])\s*(?:[0-9,$!+~-]+)?\s*w(?:\s|$)/.test(script);
}

// date 的只读形态只有 +format 与 -d、-r 等取值选项，设置系统时间是唯一的位置参数用法。
// [并发] 系统时钟被改动会波及同时运行的其他任务，因此这里按最严口径判定。
export function dateCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // date 的纯读形态只有 `+format` 或带 -d/-r 等取值选项；出现普通位置参数意味着在设置系统时间。
  const valueFlags = new Set(["-d", "--date", "-r", "--reference", "--rfc-3339"]);
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg.startsWith("--") && arg.includes("=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += valueFlags.has(arg) ? 2 : 1;
      continue;
    }
    // [失败路径] 非 + 开头的普通参数直接判危险，宁可误拒一次时间格式化也不放行改时钟。
    if (!arg.startsWith("+")) return true;
    index += 1;
  }
  return false;
}

// ps 的选项大多以 - 开头，只有 BSD 风格的位置参数会把 e 当成打印环境变量。
export function psCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // BSD 风格的位置参数（如 `ps e`）会把进程环境变量打印出来，可能泄露密钥，故判危险。
  return args.some((arg) => !arg.startsWith("-") && /^[a-zA-Z]*e[a-zA-Z]*$/.test(arg));
}

// pyright 一次性运行即为只读检查，--watch 与 -w 会把它变成常驻进程。
export function pyrightCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // --watch 会常驻监视文件变化，不是一次性只读检查。
  return args.some((arg) => arg === "--watch" || arg === "-w");
}

// man 的查询模式与文件名模式共用位置参数，只有 apropos 与 whatis 模式才保证参数是关键词。
// [权衡] 判定按「是否进入 apropos 模式」记账，而不是按参数内容猜，避免漏判本地文件读取。
export function manCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 不在 apropos/whatis 模式下时，带 `/` 的位置参数会被 man 当作本地文件路径读取。
  const aproposFlags = new Set(["-k", "-f", "--apropos", "--whatis"]);
  const valueFlags = new Set(["-S", "-s"]);
  let isApropos = false;
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-") && arg !== "-") {
      if (aproposFlags.has(arg)) isApropos = true;
      if (valueFlags.has(arg)) index += 1;
      continue;
    }
    afterDoubleDash = true;
    // [失败路径] 含斜杠的位置参数在非 apropos 模式下会被 man 当成路径打开并渲染，直接判危险。
    if (arg.includes("/")) return !isApropos;
  }
  return false;
}

// lsof 的列举模式是只读的，风险集中在 +m 模式与 -i 里带主机名的网络过滤表达式。
// [资源] 带主机名的过滤会先做名称解析，可能卡在 DNS 上并产生对外查询。
export function lsofCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // +m 不是纯列举模式；`-i@host` 会解析远端主机名（可能触发网络/命名服务查询）。
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "+m" || arg.startsWith("+m")) return true;
    if (/^-[a-zA-Z]*i\S*@/.test(arg)) {
      const host = arg.slice(arg.indexOf("@") + 1).split(":")[0] ?? "";
      if (/[a-zA-Z]/.test(host)) return true;
    }
    if (/^-[a-zA-Z]*i$/.test(arg)) {
      const next = args[index + 1] ?? "";
      if (next.includes("@")) {
        const host = next.slice(next.indexOf("@") + 1).split(":")[0] ?? "";
        if (/[a-zA-Z]/.test(host)) return true;
      }
    }
  }
  return false;
}

// 这些 termcap capability 会切换键盘/屏幕模式、清屏或复位终端，属于写终端状态而非查询，
// 所以即使参数只是 `tput <cap>` 也不能算只读。
// [资源] 这些 capability 操作的是终端设备状态，采用白名单列举危险项，未列出的按只读处理。
// [权衡] 白名单只能覆盖常见终端描述库，冷门 capability 仍可能改状态，属于已知残留风险。
const TPUT_DANGEROUS_CAPABILITIES = new Set([
  "clear",
  "flash",
  "if",
  "init",
  "iprog",
  "is1",
  "is2",
  "is3",
  "mc0",
  "mc4",
  "mc5",
  "mc5i",
  "mc5p",
  "pfkey",
  "pfloc",
  "pfx",
  "pfxl",
  "reset",
  "rf",
  "rmcup",
  "rs1",
  "rs2",
  "rs3",
  "smcup",
]);

// tput 的输入分两部分：选项与 capability 名，选项里 -S 会把 stdin 变成数据来源。
export function tputCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // -S 从 stdin 读能力名；init/reset/clear/smcup 等 capability 会改写终端状态，不是只读查询。
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; ) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      // [失败路径] -S 让能力名来自管道，静态无法确认最终执行哪个 capability，直接拒绝。
      if (arg === "-S") return true;
      if (!arg.startsWith("--") && arg.length > 2 && arg.includes("S")) return true;
      index += arg === "-T" ? 2 : 1;
      continue;
    }
    if (TPUT_DANGEROUS_CAPABILITIES.has(arg)) return true;
    index += 1;
  }
  return false;
}

// ss 的过滤表达式是小型 DSL，关键字与取值交替出现，只有纯数字地址端口不触发解析。
export function ssCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 只接受纯数字地址/端口；出现字母（服务名、主机名）时需要额外解析，可能走网络。
  const keywords =
    /^(dst|src|dport|sport|and|or|not|eq|ne|ge|le|gt|lt|autobound|state|exclude|dev|fwmark|cgroup)$/;
  const valueKeywords = /^(state|exclude|dport|sport|dev|fwmark|cgroup)$/;
  const valueFlags = /^(-f|--family|-A|--query|--socket)$/;
  const positional: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (valueFlags.test(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }

  const tokens = positional
    .join(" ")
    .split(/[\s()=!<>&|,]+/)
    .filter(Boolean);
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (keywords.test(token)) {
      skipValue = valueKeywords.test(token);
      continue;
    }
    if (
      /[g-zG-Z]/.test(token) ||
      (/[a-fA-F]/.test(token) && (token.includes(".") || !token.includes(":")))
    )
      return true;
  }
  return false;
}

// [权衡] 数值字面量只认十进制、十六进制与 base# 三种写法，其余形态一律按危险处理。
const TEST_NUMERIC_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const TEST_SAFE_NUMBER = /^-?(0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;

// test 的表达式能力足够强，任何无法静态展开的参数都按危险处理。
// [失败路径] 数值操作符两侧都要过 TEST_SAFE_NUMBER，防止命令替换混入比较表达式。
export function testCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // -v/-R 会解析变量/递归路径，-a/-o 是表达式逻辑，`[` 出现说明有嵌套表达式，均无法静态判定。
  if (
    args.some(
      (arg) => arg === "-v" || arg === "-R" || arg === "-a" || arg === "-o" || /\[/.test(arg),
    )
  )
    return true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (TEST_NUMERIC_OPERATORS.has(arg)) {
      for (const value of [args[index - 1], args[index + 1]]) {
        if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
      }
    }
    if (arg === "-t") {
      const value = args[index + 1];
      if (value !== undefined && !TEST_SAFE_NUMBER.test(value)) return true;
    }
  }
  return false;
}

// xargs 的目标命令只能来自这个显式集合；不在集合内（rm、sh、sed -i 等）一律判危险，
// 因为 xargs 会把输入拼成参数交给目标命令，等价于任意命令执行。
// [事务] 该集合是 xargs 允许执行的完整命令面，新增成员等于放开一类任意命令执行能力。
export const XARGS_TARGET_COMMANDS = new Set([
  "echo",
  "printf",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
]);
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-s", "-E", "-d"]);

// xargs 把标准输入拼成参数追加到目标命令，因此目标命令本身决定副作用范围。
// [失败路径] 找不到目标命令时返回 false，此时 xargs 默认调用 echo，不产生写操作。
export function xargsCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // xargs 会把输入拼进目标命令；目标命令必须来自 XARGS_TARGET_COMMANDS，否则等于任意执行。
  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && index + 1 < args.length) {
      index += 1;
      arg = args[index] ?? "";
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (XARGS_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    return !XARGS_TARGET_COMMANDS.has(arg);
  }
  return false;
}

// gh 的本地子命令与远端子命令共用参数形态，只能靠参数里是否出现宿主或路径特征区分。
// [失败路径] 带等号的选项只检查取值部分，因此 --repo=owner/name 也会被两级斜杠规则拦下。
export function ghCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  // 参数里出现 `://`、`@`（宿主/组织）或至少两个 `/`（owner/repo）意味着访问远端或跨仓库，
  // 不再是只读本地操作。
  for (const arg of args) {
    if (!arg) continue;
    let value = arg;
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex === -1) continue;
      value = arg.slice(equalsIndex + 1);
      if (!value) continue;
    }
    if (!value.includes("/") && !value.includes("://") && !value.includes("@")) continue;
    if (value.includes("://") || value.includes("@")) return true;
    if ((value.match(/\//g) ?? []).length >= 2) return true;
  }
  return false;
}

// 这些全局选项指向远端/自定义 docker daemon 或 TLS 凭据（-H/-c/--config/--host/--context），
// 会把本地只读查询变成跨主机操作，因此只要在任意位置出现就判危险。
// [权衡] 清单把远端 daemon 与 TLS 凭据选项集中在一处，新增全局选项只需改这张表。
// [资源] 短选项集合由清单过滤生成，任何长度大于两字符的选项都不会误入短选项白名单。
const DOCKER_DANGEROUS_GLOBAL_FLAGS = [
  "-H",
  "-c",
  "--config",
  "--context",
  "--host",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
];
const DOCKER_DANGEROUS_SHORT_FLAGS = new Set(
  DOCKER_DANGEROUS_GLOBAL_FLAGS.filter((flag) => flag.length === 2).map((flag) => flag[1]),
);

// `docker ps/logs/inspect` 的只读形态只允许连本机 daemon；任何远端/凭据选项都视为越权。
// docker 的只读子命令默认连本机 daemon，一旦出现远端或凭据选项就整体判危险。
export function dockerCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return hasDangerousDockerOption(args);
}

// 既检查独立的 `-H value`、`--host=...`，也检查粘连短选项簇（如 `-Htcp://...`），
// 因为 docker 允许把全局选项和子命令选项混写在一起，单看 flag 名无法判断取值边界。
// [契约] 判定覆盖三类写法；独立选项走 arg === flag，等号与粘连分别走 startsWith(flag + "=") 与 arg.startsWith(flag)。
// [失败路径] 粘连形态按前缀匹配，因此 -Htcp://host 这种没有空格的写法也能拦住。
// [权衡] 判定只加不减，短选项簇里出现任一危险字母即拒绝，避免逐字符解析取值边界。
export function hasDangerousDockerOption(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (
      DOCKER_DANGEROUS_GLOBAL_FLAGS.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && arg.length > 2 && arg.startsWith(flag)),
      )
    )
      return true;
    // [边界] 短选项簇按字母逐个比对，长度不足两个字母时不存在簇，直接跳过。
    const shortFlags = arg.match(/^-([A-Za-z]+)/)?.[1];
    if (shortFlags !== undefined && shortFlags.length >= 2) {
      for (const flag of shortFlags) {
        if (DOCKER_DANGEROUS_SHORT_FLAGS.has(flag)) return true;
      }
    }
    return false;
  });
}

// git 相关回调体量较大且与子命令表耦合，拆到独立模块后在此汇聚，保持对外导出面不变。
// [边界] 该转发必须是文件最后一条语句，上方任何新增实现都不影响它的导出语义。
export * from "./bash-readonly-policy-git-callbacks.js";
