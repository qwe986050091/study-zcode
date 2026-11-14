// INV-01 全局旗标只有一个真相来源：parseGlobalArgs 内 options 字面量配合 strict: true。守住位置是该对象的每个键与其 type 声明；漏登记或写错 type 会让合法旗标被 strict 当成未知参数抛错，或让值被误读成位置参数。
// INV-02 [并发] parseGlobalArgs 必须保持纯函数语义，每次调用返回全新的 values 与 positionals。守住位置是函数体内不得引入模块级缓存或复用解析结果；一旦缓存，同一进程内并发启动的多个 session 会互相串用参数。
// INV-03 [失败路径] parseArgs 抛出的错误不在本文件捕获，也不降级为默认值。守住位置是 parseGlobalArgs 的函数体边界；在此 try 包裹并返回兜底值会掩盖非法参数，让进程带着错误配置继续启动。
// INV-04 协议判定顺序不可调换：isProtocolServerInvocation 先排除 prompt 与 target 有值，再排除 help 与 version，最后才比对 positionals[0]。调换顺序会把普通提问误判为协议启动并抢走 stdout。
// INV-05 [失败路径] isProtocolServerInvocation 的 catch 只在解析失败时按 argv[0] 裸文本兜底，不放行其他逻辑。守住位置是该 catch 块；删掉兜底会让 `app-server --bogus` 这类启动失去 stdout 保护，协议帧与错误文本混流。
// INV-06 [并发] isProtocolServerInvocation 每次调用都重新解析，不缓存布尔结论。守住位置是函数入口；缓存会让入口判定与命令路由两次调用复用同一结果，而两次传入的 argv 可能不同。
// INV-07 DISALLOWED_TOOLS_FLAGS 用 Set 同时登记 --disallowedTools 与 --disallowed-tools 两种拼写，是剥离逻辑唯一的字面量清单。守住位置是该常量定义；只留一种拼写会让另一种写法绕过剥离，直接撞上 strict 报错。
// INV-08 [事务] extractDisallowedToolsArgs 中 `--flag=value` 的等号分支必须先于 Set 成员判断执行，并用 continue 跳过本轮。守住位置是 for 循环体首段；颠倒顺序会让等号形式被当成裸旗标，进而吞掉紧随其后的位置参数。
// INV-09 [资源] extractDisallowedToolsArgs 用显式 index 原地推进消费值，每次取值后必须 index += 1。守住位置是 while 循环体；改成 for...of 或漏写自增会重复消费或漏消费，工具清单被截断或错位。
// INV-10 [失败路径] consumed 标志保证旗标后没有工具时立即抛错，而不是静默通过。守住位置是 while 之后的那次判断；去掉 throw 会让用户以为限制已生效，实际全部工具仍然可用。
// INV-11 isCliOptionToken 决定值消费的终止边界：`--` 以及任意 -x、--xxx 都算新选项起点。守住位置是该谓词的正则；放宽判定会把 `--disallowed-tools Read --verbose` 中的 --verbose 吞成工具名。
// INV-12 [权衡] isCliOptionToken 的正则只做前缀判断，不加结尾锚点，因此 -pfoo 这类黏连形式仍被视为选项。守住位置是该正则；改成全串匹配会让黏连写法被当成普通值参与消费。
// INV-13 normalizeCliToolRuleList 用 seen 集合去重并保留首次出现顺序。守住位置是该 Set 与 push 的先后；去掉去重会让同一规则重复进入白名单，下游按顺序渲染权限提示时出现重复条目。
// INV-14 normalizeCliToolRuleList 在结果为空时返回 undefined，而不是空数组，用以表达未指定。守住位置是该函数末尾的三元返回；改成空数组会让上层无法区分没传旗标与传了但全被过滤，可能覆盖默认白名单。
// INV-15 [事务] splitCliToolRules 用 inToolArgs 记录括号深度，决定逗号与空格是分隔符还是规则内容的组成部分。守住位置是循环内的 switch 各分支；丢掉该状态会把 `Bash(git status)` 拆成两条规则，权限匹配随之失效。
// INV-16 [失败路径] splitCliToolRules 遍历结束后必须再 flush 一次，收走末尾无分隔符的规则。守住位置是函数 return 前的最后一次 flush；漏掉会让最后一条工具限制静默丢失。
// INV-17 normalizeCliToolRule 只承担 web_search 到 WebSearch 的旧名映射，其余规则原样返回。守住位置是该函数的两个分支；在此叠加更多别名会让 CLI 层与工具注册表各存一份规范名，形成第二处真相。
// INV-18 本文件只解析参数形状，不读取环境变量、不落盘、不输出终端、不决定退出码。守住位置是整个模块的副作用边界；在解析层引入副作用会让同一 argv 在不同环境下得出不同结果，破坏可测试性与入口层的错误归属。
//
// 模块职责：集中声明 zcode CLI 的全局旗标形态（类型、短名、multiple），并提供协议命令识别与 --disallowed-tools 的剥离归一化，供入口与命令路由复用。
// 状态所有权：解析结果与剥离结果都是一次性返回的局部值，模块内无缓存、无全局可变状态；参数唯一来源是调用方传入的 argv。
// 阅读顺序：先 parseGlobalArgs 的 options 与 strict，再 isProtocolServerInvocation 的判定顺序与 catch 兜底，最后 DISALLOWED_TOOLS_FLAGS 及配套的四个纯函数。
import { parseArgs } from "node:util";

export const parseGlobalArgs = (argv: string[]) =>
  parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      // help 绑定短名 h、version 绑定短名 v，二者都是 boolean，入口据此走帮助或版本分支后提前返回。
      //
      // 新增旗标必须核对短名是否与既有 h、p、c、f、v、a、s 冲突；重复短名会让 strict 解析器在注册阶段直接抛错。
      // output-format、toolsearch-mode、mode、surface、workflow-mode 都是 string，缺省值为 undefined，不要在此填默认值。
      // boolean 与 string 的声明决定取值方式：类型写错时 `--flag value` 里的 value 会被当作位置参数而不是旗标值。
      // no-color 与 no-browser 用 no- 前缀表达关闭语义，值仍是 boolean，下游不要再取反一次。
      // attach 与 sparse 声明 multiple: true 才能聚合重复出现；去掉后只保留最后一次，多值输入会静默丢失。
      // prompt 绑定短名 p 且为 string，协议识别依赖它是否有值来排除普通提问，改类型会连带影响该判定。
      help: {
        short: "h",
        type: "boolean",
      },
      json: {
        type: "boolean",
      },
      "output-format": {
        type: "string",
      },
      "record-conversation": {
        type: "boolean",
      },
      "record-conversation-dir": {
        type: "string",
      },
      "no-color": {
        type: "boolean",
      },
      "no-browser": {
        type: "boolean",
      },
      "browser-use": {
        type: "string",
      },
      "browser-executable": {
        type: "string",
      },
      prompt: {
        short: "p",
        type: "string",
      },
      "memory-bench": {
        type: "boolean",
      },
      attach: {
        multiple: true,
        type: "string",
      },
      cwd: {
        type: "string",
      },
      locale: {
        type: "string",
      },
      resume: {
        type: "string",
      },
      target: {
        type: "string",
      },
      "target-replace": {
        type: "boolean",
      },
      continue: {
        short: "c",
        type: "boolean",
      },
      force: {
        short: "f",
        type: "boolean",
      },
      "toolsearch-mode": { type: "string" },
      "force-mcs": {
        type: "boolean",
      },
      mode: {
        type: "string",
      },
      verbose: {
        type: "boolean",
      },
      version: {
        short: "v",
        type: "boolean",
      },
      "prepare-storage": { type: "boolean" },
      stdio: {
        type: "boolean",
      },
      surface: {
        type: "string",
      },
      "workflow-mode": {
        type: "string",
      },
      // `zcode plugins` 子命令旗标：strict 解析器要求
      // 在全局注册，run.ts 收集后透传给 plugins-command，不污染其他命令的选项语义。
      // all、available、keep-data、scope、sparse 是 plugins 子命令旗标，因 strict 解析器要求才在全局注册。
      //
      // 这里只登记形状，语义解释权归 plugins-command；run.ts 负责收集并透传，不在此做命令维度的过滤。
      // [权衡] 全局注册的代价是其他命令也能接受这些旗标而不报错；这是有意的取舍，不要再加一层 commands 白名单。
      // scope 的短名 s 与 sparse 的多值声明是 plugins 侧既有契约，改名会影响已发布脚本的调用方式。
      //
      // [失败路径] 若把这组旗标移出 options，strict 解析器会在任何命令下把它们视为未知参数并抛错。
      // keep-data 为 boolean：语义是保留插件数据目录，解析层不判断其副作用，避免参数知识外溢。
      all: {
        short: "a",
        type: "boolean",
      },
      available: {
        type: "boolean",
      },
      "keep-data": {
        type: "boolean",
      },
      scope: {
        short: "s",
        type: "string",
      },
      sparse: {
        multiple: true,
        type: "string",
      },
    },
    // strict: true 是本文件的核心防线：未在 options 登记的旗标会抛 TypeError，而不会被静默当成位置参数。
    //
    // [失败路径] 该错误不在解析函数内转成提示文本，由调用方负责格式化与退出码；在此吞掉会让未知旗标一路下渗。
    // allowPositionals: true 让子命令与自由文本留在 positionals，但形如 --x 的未知旗标仍会触发 strict 失败。
    // [权衡] 因此每个子命令自己的旗标都必须在 options 中出现，参数契约随命令扩张而集中收敛到这一处。
    // 修改键名属于对外契约变更，会同时影响协议识别与插件透传两条调用链，需要同步调用方与测试。
    // 解析结果只含 values 与 positionals，不要在此追加派生字段，派生逻辑应留给调用方。
    strict: true,
  });

/** 入口与命令路由复用同一参数定义，不能把 prompt/cwd 的值误当成协议命令。 */
// 唯一职责是判断本次启动是否进入 app-server 或 agent-server 协议模式，从而决定 stdout 是否被协议帧独占。
//
// [失败路径] return 中的四个排除条件用 && 串联：prompt 或 target 有值、help 或 version 为真，一律返回 false。
// 去掉任一排除条件，`zcode -p app-server` 这类普通提问会被误判为协议启动，用户输出被写进协议通道。
// positionals[0] 只做两个字符串的精确相等，不用前缀或包含判断，避免 `app-server-xxx` 误命中。
// [并发] 每次调用重新解析，不缓存结论；入口判定与命令路由可能传入不同 argv，缓存会让后一次判定复用旧结果。
// 解析与判定都放在同一代码块内，任何异常都会落入 catch，体现协议模式优先保护 stdout 的保守取向。
export function isProtocolServerInvocation(argv: string[]): boolean {
  try {
    const parsed = parseGlobalArgs(argv);
    return (
      parsed.values.prompt === undefined &&
      parsed.values.target === undefined &&
      !parsed.values.help &&
      !parsed.values.version &&
      (parsed.positionals[0] === "app-server" || parsed.positionals[0] === "agent-server")
    );
  // [失败路径] catch 不绑定错误对象，说明这里刻意不依赖错误内容，只做降级判定。
  // 降级规则直接比较 argv[0] 文本，不经过 parseGlobalArgs，因此对非法参数依然可用。
  //
  // [权衡] 兜底只看 argv[0]：`app-server --bogus` 仍会被判为协议启动以保护 stdout，而非法旗标在前时返回 false，属有意的保守取舍。
  // 该分支的两个字符串必须与前面的判定分支保持一致，否则路由结论会随参数是否合法而漂移。
  // 不要在这里补日志或写终端，stdout 属于协议通道，任何多余输出都会破坏帧解析。
  } catch {
    // 无效参数由 run 格式化；明确的协议命令仍保护 stdout。
    return argv[0] === "app-server" || argv[0] === "agent-server";
  }
}

// DISALLOWED_TOOLS_FLAGS 同时登记 --disallowedTools 与 --disallowed-tools 两种拼写，剥离逻辑只认这一份清单。
//
// [权衡] 两个旗标故意不进入 options：先由 extractDisallowedToolsArgs 剥离，再交给 strict 解析剩余 argv。
// 若把它们加进 options，会出现两处语义并存的局面，剥离与解析的先后关系也会变得不再必要。
// [失败路径] 漏掉短横线拼写时，使用 kebab 写法的调用方会直接撞上 strict 报错，而不是被安静剥离。
// 常量只做成员判断，不承担归一化；规则清洗与去重由 normalizeCliToolRuleList 负责。
// [资源] 值消费的终止边界由 isCliOptionToken 判定，`--` 与任意 -x、--xxx 都会终止消费，避免吞掉后续旗标。
const DISALLOWED_TOOLS_FLAGS = new Set(["--disallowedTools", "--disallowed-tools"]);

export const extractDisallowedToolsArgs = (
  argv: readonly string[],
): { args: string[]; toolDisallowlist?: readonly string[] } => {
  const args: string[] = [];
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equalsMatch = arg.match(/^(--disallowedTools|--disallowed-tools)=(.*)$/);
    if (equalsMatch) {
      values.push(equalsMatch[2] ?? "");
      continue;
    }

    if (!DISALLOWED_TOOLS_FLAGS.has(arg)) {
      args.push(arg);
      continue;
    }

    let consumed = false;
    while (index + 1 < argv.length && !isCliOptionToken(argv[index + 1])) {
      values.push(argv[index + 1]);
      index += 1;
      consumed = true;
    }
    if (!consumed) {
      throw new Error(`${arg} requires at least one tool.`);
    }
  }

  return {
    args,
    toolDisallowlist: normalizeCliToolRuleList(values),
  };
};

const isCliOptionToken = (value: string): boolean => value === "--" || /^-[^-]?|^--/.test(value);

const normalizeCliToolRuleList = (values: readonly string[]): readonly string[] | undefined => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const part of splitCliToolRules(value)) {
      const rule = normalizeCliToolRule(part);
      if (!rule || seen.has(rule)) continue;
      seen.add(rule);
      normalized.push(rule);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
};

const splitCliToolRules = (value: string): readonly string[] => {
  const rules: string[] = [];
  let current = "";
  let inToolArgs = false;
  const flush = () => {
    const rule = current.trim();
    if (rule) rules.push(rule);
    current = "";
  };

  for (const char of value) {
    switch (char) {
      case "(":
        inToolArgs = true;
        current += char;
        break;
      case ")":
        inToolArgs = false;
        current += char;
        break;
      case ",":
        if (inToolArgs) {
          current += char;
        } else {
          flush();
        }
        break;
      case " ":
        if (inToolArgs) {
          current += char;
        } else {
          flush();
        }
        break;
      default:
        current += char;
        break;
    }
  }
  flush();
  return rules;
};

const normalizeCliToolRule = (rule: string): string => {
  if (!rule) return "";
  if (rule === "web_search") return "WebSearch";
  if (rule.startsWith("web_search(")) return `WebSearch${rule.slice("web_search".length)}`;
  return rule;
};
