/**
 * 把一条 Bash 命令翻译成"权限规则策略"：生成可评估的 subject 组、必须覆盖的命令组，
 * 以及在 UI 上建议添加的 allow 规则。由 bash.ts 的权限能力装配阶段调用。
 * 只有静态可分析（无重定向、无动态词、环境变量赋值可静态化）时才按命令前缀分组，
 * 否则退化为整条命令的精确匹配；任何拿不准的形态都不生成宽松前缀规则。
 */

// 本文件是 Bash 权限策略的唯一翻译层：把一条命令的静态分析结果转换成可评估的 subject 组、
// 需要被规则覆盖的命令组，以及建议用户写入的 allow 规则。调用方是 bash.ts 的权限能力装配阶段。
// 不负责命令解析与语义判断（bash-command-parser / bash-semantics），也不负责规则命中裁决
// （bash-command-rule-evaluator）：本文件只在其结论之上做保守分组与降级，自身不执行任何命令。
// 所有导出都是纯函数式构造，不持有会话状态、不做 I/O、不缓存解析结果。
//
// INV-01 断言：静态安全是生成前缀规则的前置条件 —— 守住它的位置：isAnalysisSafeForPrefix —— 改错故障：重定向或命令替换被前缀覆盖，用户一次确认即放行任意命令
// INV-02 断言：任一 invocation 不安全即整体降级 —— 守住它的位置：isAnalysisSafeForPrefix 的 every 分支 —— 改错故障：复合命令里只有一段带管道，其余段的分组仍被按前缀放行
// INV-03 断言：高危根命令永远不产出前缀 —— 守住它的位置：HIGH_RISK_ROOT_COMMANDS 的早退判断 —— 改错故障：rm:* 或 bash:* 写入配置后等价于关闭权限审批
// INV-04 断言：前缀至少包含两个 token —— 守住它的位置：serializePrefix 的长度检查 —— 改错故障：单 token 前缀放行整个命令族，规则宽于用户本意
// INV-05 断言：动态词与路径类 token 不得进入前缀 —— 守住它的位置：isStableActionToken 与 looksLikePathOrUrl —— 改错故障：目录或 URL 被固化进规则，规则从此不再命中或误命中
// INV-06 断言：环境变量赋值必须可静态化才进前缀 —— 守住它的位置：staticAssignmentTokens —— 改错故障：含命令替换的赋值被当成常量写入规则
// INV-07 断言：每条命令同时保留 raw 与稳定前缀两种 subject —— 守住它的位置：buildInvocationRuleSubjects —— 改错故障：用户已保存的 pnpm run lint:* 下一轮不再命中并重复弹窗
// INV-08 断言：建议规则数量上限 5 且判两次 —— 守住它的位置：buildSuggestedUpdates 的两处长度判断 —— 改错故障：一次点击写入过多宽松前缀，或去重后超限漏判
// INV-09 断言：没有必需命令时回退精确规则 —— 守住它的位置：buildSuggestedUpdates 的早退条件 —— 改错故障：返回空更新，UI 无法给用户任何放行选项
// INV-10 断言：exactCommands 同时保留原串与 trim 串 —— 守住它的位置：createBashPermissionRulePolicy —— 改错故障：命令首尾空白导致用户已保存的精确规则失配
// INV-11 断言：safe 为假时 subject 组必须为空数组 —— 守住它的位置：allSubjectGroups 的三元表达式 —— 改错故障：evaluator 拿到未验证分组，复合命令绕过 deny
// INV-12 断言：只读命令先剔除再建组 —— 守住它的位置：requiredCommands 的过滤 —— 改错故障：allow 要求覆盖 cat/ls 之类只读命令，导致 allow 永不命中
// INV-13 断言：wrapper 最多剥两层 —— 守住它的位置：unwrapCommand 的深度上限 —— 改错故障：深层嵌套 sudo 被解析出错误目标命令并产出过宽前缀
// INV-14 断言：wrapper 的带值选项必须跳过其取值 —— 守住它的位置：WRAPPER_OPTIONS_WITH_VALUES —— 改错故障：sudo -u root 里的 root 被当成目标命令
// INV-15 断言：registry 里查不到的命令即放弃前缀 —— 守住它的位置：resolveStableCommandPrefix 的节点查询 —— 改错故障：未知命令按猜测深度产出错误前缀
// INV-16 断言：建议规则按最终 ruleContent 去重 —— 守住它的位置：buildSuggestedUpdates 的 seen 集合 —— 改错故障：同一前缀重复写入配置，弹窗条目重复
// INV-17 断言：命令输入只接受字符串 —— 守住它的位置：readCommand —— 改错故障：非字符串被强转后参与规则生成，产出不可预期内容
//
// 修改守则一：新增命令族支持应改 registry 数据或 FAMILY_DEPTH_OVERRIDES，不要在分支里写死命令名。
// 修改守则二：任何放宽方向的改动都要附带反例命令（重定向、命令替换、路径参数）证明仍会降级。
// 修改守则三：前缀规则写入用户配置后不再经过本文件，错误规则无法靠回滚代码修复，宁可少建议。
// 修改守则四：安全语义的解释权在 evaluator，本文件只生产数据，不复制其匹配逻辑。
// 修改守则五：所有函数保持无缓存纯计算，同一命令在不同 context 下只允许因 context 不同而不同。
// 修改守则六：MAX_SUGGESTED_RULES 与退化阈值是产品可见行为，调整需同步 UI 文案与快照。
import type { PermissionRuleValue, PermissionUpdate } from "@zcode/contracts";
import type {
  ToolPermissionRulePolicy,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
  type BashCommandAnalysis,
  type BashCommandInvocation,
} from "./bash-command-parser.js";
import { evaluateBashRules } from "./bash-command-rule-evaluator.js";
import {
  BASH_COMMAND_REGISTRY,
  type BashCommandRegistryNode,
} from "./generated/bash-command-registry.js";
import { isRuntimeReadOnlyBashCommand } from "./bash-semantics.js";

// 建议规则最多 5 条，超过就退化为整条命令精确规则，避免一次点击塞入过多宽松前缀。
// [权衡] 5 条上限是弹窗可逐条确认与覆盖面之间的折中：再多用户就不会认真看每一条前缀。
// 两处判断（必需命令数量、去重后 rules 数量）都要留，前者挡住明显过量的输入，后者兜住合并失败。
// 超限时不截断而是整条精确规则：截断会让未覆盖的命令下次继续弹窗，用户会重复点同一轮确认。
// 调低该值只会更保守，调高需要确认 UI 弹窗仍能容纳与阅读。
const MAX_SUGGESTED_RULES = 5;
// [契约] 这两个常量是 generated/bash-command-registry 的位标志约定，取值必须与生成器输出一致。
// node[2] 是位掩码字段，用按位与判断该层参数能否当作 action 消费。
// 改名或重排位序会让所有命令族的层级解析同时失效，症状是前缀少一层或多一层。
const ARG_IS_COMMAND = 1;
const ARG_IS_MODULE = 2;
// 这些根命令（shell、rm、chmod、mount 等）一旦放行就等价于任意执行/破坏，永远不生成前缀规则。
// [契约] 名单内的根命令即使 registry 有完整层级也不生成前缀：放行它们的前缀等于放行任意参数。
// 新增条目是安全方向，删除前必须确认该命令没有任何子命令能造成等价破坏。
// 判定只看 executableBasename，所以 /bin/rm 与 C:/Windows/System32/cmd.exe 同样被拦截。
const HIGH_RISK_ROOT_COMMANDS = new Set([
  "bash",
  "chgrp",
  "chmod",
  "chown",
  "cmd",
  "dd",
  "fish",
  "mkfs",
  "mount",
  "powershell",
  "pwsh",
  "rm",
  "rmdir",
  "sh",
  "umount",
  "zsh",
]);
// wrapper 的带值选项必须先跳过其取值，否则会把 `sudo -u root` 的 root 误认成目标命令。
// [契约] 这张表回答该 wrapper 的哪些选项会吃掉下一个 token，漏写会让 wrapper 的参数被当成目标命令。
// 例：sudo -u root npm test 若不跳过 -u 的取值，executable 会被认成 root，前缀错误且可能过宽。
// env 用空集合是特例：它的赋值形如 KEY=VALUE，由 isStaticAssignmentToken 单独处理。
// 新增 wrapper 时同时补 WRAPPER_OPTIONS（无值开关），两张表缺一都会让解析停在 wrapper 自身。
const WRAPPER_OPTIONS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set(),
  env: new Set(["-C", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"]),
  nohup: new Set(),
  sudo: new Set([
    "-C",
    "-D",
    "-R",
    "-T",
    "-a",
    "-c",
    "-g",
    "-h",
    "-p",
    "-r",
    "-t",
    "-u",
    "--askpass",
    "--chdir",
    "--chroot",
    "--close-from",
    "--group",
    "--host",
    "--prompt",
    "--role",
    "--type",
    "--user",
  ]),
  time: new Set(["-f", "-o", "--format", "--output"]),
};
const WRAPPER_OPTIONS = new Set(["-p", "-v", "-V", "--ignore-environment"]);
// [契约] 这些包管理器的 run 类动作必须连脚本名一起进前缀，否则 pnpm run:* 会放行任意脚本。
// 只有第二个 token 通过 isStableActionToken 时才取两层，脚本名带路径或变量时放弃前缀。
// 表外的执行器走 registry 兜底，不要为了省事直接往这里加，深度语义不同会产出错误前缀。
const SCRIPT_ACTIONS = new Map([
  ["bun", new Set(["run"])],
  ["deno", new Set(["task"])],
  ["npm", new Set(["run", "run-script"])],
  ["pnpm", new Set(["run"])],
  ["yarn", new Set(["run"])],
]);
const TARGET_ACTIONS = new Set(["just", "make"]);
const PYTHON_EXECUTABLES = new Set(["python", "python3", "py"]);
// [权衡] 云与容器命令的层级深度差异大，这里用首 token 到深度的映射覆盖 registry 的默认推导。
// "*" 表示任意首 token 都取固定深度（aws s3 ls 取两层），具名键只对特定子命令生效。
// 深度大于实际层级时 action 校验失败并放弃前缀，方向安全，但建议会退化为精确规则。
const FAMILY_DEPTH_OVERRIDES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  aws: { "*": 2 },
  az: { "*": 2 },
  docker: { compose: 2 },
  gcloud: { "*": 3 },
  kubectl: { config: 2 },
};

// [契约] 入口只从 input.command 取字符串，不做 schema 校验：非对象或非字符串一律返回 undefined。
// 返回 undefined 表示无法给出策略，调用方会走默认交互式审批，不等价于放行。
// 故意不在这里捕获解析异常：解析器抛错应冒泡到权限装配层，而不是静默降级成精确规则。
// 不读取 context 之外的全局状态，保证同一 input 在任意阶段得到同一策略。
export function resolveBashPermissionRulePolicy(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy | undefined {
  const command = readCommand(input);
  if (command === undefined) return undefined;
  return createBashPermissionRulePolicy(command, context);
}

export function createBashPermissionRulePolicy(
  command: string,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolPermissionRulePolicy {
  // [契约] 同时保留原串与 trim 串：用户从终端复制的命令常带首尾空白，而配置里保存的是 trim 形态。
  // evaluator 用 exactCommands.includes 逐条比较，两个元素顺序不影响命中，但少了任一个都会漏匹配。
  // 这个数组同时决定精确规则的内容，不要在这里追加去重或规范化，否则与用户已保存的规则对不上。
  const rawCommand = command.trim();
  // 同时保留原始命令与 trim 后版本，兼容用户保存规则时的首尾空白差异。
  const exactCommands = command === rawCommand ? [rawCommand] : [command, rawCommand];
  const analysis = analyzeBashCommand(command);
  const safe = isAnalysisSafeForPrefix(analysis);
  // [契约] 不安全时 subject 组必须是空数组而不是尽力而为的部分结果：evaluator 的 deny 分支会用
  // allSubjectGroups 做 some 匹配，塞入未验证分组会让复合命令绕过 deny。
  // safe 的判定只看 analysis 的字段，不要在这里追加新的安全条件，它同时决定必需命令与建议规则。
  // 每条 invocation 的 token 顺序被保留，evaluator 依赖该顺序做 token 边界比较。
  const allSubjectGroups = safe ? analysis.commands.map(buildInvocationRuleSubjects) : [];
  // [契约] allow 只要求覆盖非只读命令，所以先剔除只读命令，避免 cat/ls 也被要求配规则。
  // 只读判定必须走 isRuntimeReadOnlyBashCommand 并传入 context，它可能依赖运行时扩展配置。
  // 剔除必须发生在建组之前，顺序反了会让 requiredSubjectGroups 残留只读命令，导致 allow 永不命中。
  const requiredCommands = safe
    ? analysis.commands.filter(
        (invocation) => !isRuntimeReadOnlyBashCommand(invocation.commandText, context),
      )
    : [];
  const requiredSubjectGroups = requiredCommands.map(buildInvocationRuleSubjects);
  const suggestedPermissionUpdates = buildSuggestedUpdates(
    rawCommand,
    safe,
    requiredCommands,
  );

  return {
    // [契约] 闭包把这五个字段固化进策略对象，之后的规则变化只体现在 rules 入参。
    // 不要在闭包里读取外部可变状态：策略对象可能被缓存后跨会话复用，会拿到过期命令。
    // allow 与 deny 使用不同组的语义由 evaluator 决定，这里不能预先裁剪成单一形态。
    evaluateRules(behavior, rules) {
      return evaluateBashRules({
        allSubjectGroups,
        behavior,
        exactCommands,
        requiredSubjectGroups,
        rules,
        safe,
      });
    },
    suggestedPermissionUpdates,
  };
}

// [契约] 返回 1 到 2 个候选 subject：raw 形态兼容历史 wildcard，稳定前缀形态兼容新 resolver。
// 两个元素顺序不参与优先级，evaluator 对每个 subject 独立尝试匹配。
// 任何情况下都要保留 raw：只有它能让用户手写的完整命令规则继续命中。
function buildInvocationRuleSubjects(invocation: BashCommandInvocation): string[] {
  const rawSubject = normalizeInvocation(invocation);
  const stablePrefix = resolveStableCommandPrefix(invocation);
  // 保存规则会移除 --dir/-C 等全局 flag，但旧 evaluator 只拿原始 invocation
  // 比较，导致 UI 明明保存了 `pnpm run lint:*`，下一轮仍无法命中。保留 raw subject
  // 兼容历史 wildcard，同时加入相同 resolver 得出的稳定 action subject。
  return stablePrefix && stablePrefix !== rawSubject ? [rawSubject, stablePrefix] : [rawSubject];
}

// [契约] 这里产出的是建议而非生效规则：UI 展示后由用户确认才写入配置，因此宁缺毋滥。
// 空命令直接返回空数组，避免输入框还空着就往配置里写一条无意义的 allow。
// 所有分支最终都是 addRules 加 allow，本文件不会生成 deny 或 replace 类型更新。
function buildSuggestedUpdates(
  rawCommand: string,
  safe: boolean,
  requiredCommands: readonly BashCommandInvocation[],
): PermissionUpdate[] {
  if (rawCommand.length === 0) return [];
  // 无法安全分组、且没有需要单独放行的命令、或命令数超限时，统一退化为整条命令精确规则。
  // [失败路径] 三个条件任一成立都退化为整条命令精确规则，第三个条件用的是大于而非大于等于，
  // 即恰好 5 条时仍走前缀分支。改成大于等于会让 5 条建议的常规场景静默变成精确规则。
  // requiredCommands 为空时不能返回空数组：那等于不需要任何规则，UI 无法给用户任何选项。
  // 退化目标是仍可放行本次命令，不是更安全地拒绝，否则用户会以为权限系统坏了。
  if (!safe || requiredCommands.length === 0 || requiredCommands.length > MAX_SUGGESTED_RULES) {
    return exactUpdate(rawCommand);
  }

  const rules: PermissionRuleValue[] = [];
  // [契约] 去重键是最终 ruleContent（含 :* 后缀）而不是 prefix，同一命令的两种写法只占一格。
  // 去重发生在长度复查之前，重复项折叠后可能把超限压回合法范围。
  const seen = new Set<string>();
  for (const invocation of requiredCommands) {
    const prefix = resolveStableCommandPrefix(invocation);
    if (!prefix) return exactUpdate(rawCommand);
    const ruleContent = `${prefix}:*`;
    if (seen.has(ruleContent)) continue;
    seen.add(ruleContent);
    rules.push({ ruleContent, toolName: "Bash" });
  }
  // [契约] 这是去重之后的第二次长度判断：必需命令超限已在前面退化，这里兜的是前缀合并失败。
  // rules 为空说明没有任何命令能产出稳定前缀，此时必须回退，不能返回空 rules 的 addRules。
  // 空 rules 的更新对上层是无效更新，用户确认后没有任何规则落库，下次仍会弹窗。
  if (rules.length === 0 || rules.length > MAX_SUGGESTED_RULES) return exactUpdate(rawCommand);
  return [{ behavior: "allow", rules, type: "addRules" }];
}

// [契约] 精确规则用 trim 后的命令，与 exactCommands 的元素同形态，保证写入后立即命中。
// 不做截断或转义：ruleContent 原样落库，含引号与空格的命令也能精确比较。
// 精确规则是最后的安全网，任何前缀分支失败都必须回到这里，不能抛错或返回空数组。
function exactUpdate(rawCommand: string): PermissionUpdate[] {
  return [
    {
      behavior: "allow",
      rules: [{ ruleContent: rawCommand, toolName: "Bash" }],
      type: "addRules",
    },
  ];
}

// [契约] 安全等于可静态化加权：无重定向、有命令、每条 invocation 无动态词且赋值可静态化。
// 条件必须同时成立：只判顶层 hasRedirects 会漏掉子命令里的重定向（ls > out 可能出现在第二段）。
// staticAssignmentTokens 返回 undefined 即不可静态化，赋值含变量展开时就是这种情况。
// 放宽这里等于放宽所有下游：前缀规则、建议规则、deny 分组会一起变宽，不要在局部加例外。
function isAnalysisSafeForPrefix(analysis: BashCommandAnalysis): boolean {
  // 只要存在重定向或动态词（命令替换、变量展开），前缀就无法代表实际行为，直接降级为精确匹配。
  return (
    isBashCommandPermissionSafe(analysis) &&
    !analysis.hasRedirects &&
    analysis.commands.length > 0 &&
    analysis.commands.every(
      (invocation) =>
        !invocation.hasRedirects &&
        !invocation.hasDynamicWords &&
        staticAssignmentTokens(invocation) !== undefined,
    )
  );
}

function normalizeInvocation(invocation: BashCommandInvocation): string {
  return [...(staticAssignmentTokens(invocation) ?? []), ...invocation.argv].join(" ");
}

// [契约] 返回 undefined 表示这条命令不能生成前缀，调用方必须回退到精确规则而不是猜。
// 前缀由赋值、wrapper 链与 action 路径三段拼成，缺任何一段都会让规则与真实命令对不上。
// 不要做至少返回命令名的兜底：单 token 前缀会被 serializePrefix 拒绝，等于放行整个命令族。
function resolveStableCommandPrefix(invocation: BashCommandInvocation): string | undefined {
  // 目标是找到稳定的 action 前缀（如 `pnpm run lint`）供 `cmd:*` 规则复用；找不到就放弃前缀规则。
  const assignments = staticAssignmentTokens(invocation);
  if (!assignments || invocation.argv.length === 0) return undefined;
  const unwrapped = unwrapCommand(invocation.argv);
  if (!unwrapped) return undefined;
  const executableName = executableBasename(unwrapped.executable);
  if (HIGH_RISK_ROOT_COMMANDS.has(executableName)) return undefined;

  const prefix = [...assignments, ...unwrapped.prefix, unwrapped.executable];
  const remaining = invocation.argv.slice(unwrapped.nextIndex);
  const directOverride = resolveDepthOverride(executableName, remaining);
  if (directOverride) {
    prefix.push(...directOverride);
    return serializePrefix(prefix);
  }

  let node = BASH_COMMAND_REGISTRY[executableName];
  if (!node) return undefined;
  const override = resolveDepthOverride(
    executableName,
    skipLeadingKnownOptions(node, remaining),
  );
  if (override) {
    prefix.push(...override);
    return serializePrefix(prefix);
  }

  let index = 0;
  let matchedAction = false;
  while (index < remaining.length) {
    const optionEnd = skipKnownOption(node, remaining, index);
    if (optionEnd !== undefined) {
      index = optionEnd;
      continue;
    }

    const token = remaining[index]!;
    const child = node[3].find((candidate) => candidate[0].includes(token));
    if (child) {
      prefix.push(token);
      matchedAction = true;
      node = child;
      index += 1;
      continue;
    }

    if ((node[2] & (ARG_IS_COMMAND | ARG_IS_MODULE)) !== 0 && !looksLikePathOrUrl(token)) {
      prefix.push(token);
      matchedAction = true;
    }
    break;
  }

  return matchedAction ? serializePrefix(prefix) : undefined;
}

function skipLeadingKnownOptions(
  node: BashCommandRegistryNode,
  args: readonly string[],
): readonly string[] {
  let index = 0;
  while (index < args.length) {
    const optionEnd = skipKnownOption(node, args, index);
    if (optionEnd === undefined) break;
    index = optionEnd;
  }
  return args.slice(index);
}

interface UnwrappedCommand {
  executable: string;
  nextIndex: number;
  prefix: string[];
}

function unwrapCommand(argv: readonly string[]): UnwrappedCommand | undefined {
  // sudo/env/command/nohup 等 wrapper 要逐层剥掉；最多剥 2 层，超过视为不可静态化。
  const prefix: string[] = [];
  let index = 0;
  let wrapperDepth = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    const name = executableBasename(token);
    const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[name];
    if (!optionsWithValues) {
      return { executable: token, nextIndex: index + 1, prefix };
    }
    wrapperDepth += 1;
    // [失败路径] 嵌套超过两层直接放弃解析，返回 undefined 会让整条命令退化为精确规则。
    // 上限存在的理由是每多剥一层就多一次 wrapper 选项解析机会，深层嵌套形态难以穷举。
    // 计数发生在确认是 wrapper 之后，普通命令第一轮就返回，不会被误伤。
    if (wrapperDepth > 2) return undefined;
    prefix.push(token);
    index += 1;
    while (index < argv.length) {
      const wrapperToken = argv[index]!;
      if (name === "env" && isStaticAssignmentToken(wrapperToken)) {
        prefix.push(wrapperToken);
        index += 1;
        continue;
      }
      const optionName = wrapperToken.includes("=")
        ? wrapperToken.slice(0, wrapperToken.indexOf("="))
        : wrapperToken;
      if (optionsWithValues.has(optionName)) {
        index += wrapperToken.includes("=") ? 1 : 2;
        continue;
      }
      if (WRAPPER_OPTIONS.has(optionName) || wrapperToken.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return undefined;
}

function resolveDepthOverride(
  executableName: string,
  args: readonly string[],
): string[] | undefined {
  if (PYTHON_EXECUTABLES.has(executableName) && args[0] === "-m" && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  const scriptActions = SCRIPT_ACTIONS.get(executableName);
  if (scriptActions?.has(args[0] ?? "") && isStableActionToken(args[1])) {
    return [args[0]!, args[1]!];
  }
  if (TARGET_ACTIONS.has(executableName) && isStableActionToken(args[0])) {
    return [args[0]!];
  }
  const familyDepth = FAMILY_DEPTH_OVERRIDES[executableName];
  const depth = familyDepth?.[args[0] ?? ""] ?? familyDepth?.["*"];
  if (depth && args.length >= depth) {
    const action = args.slice(0, depth);
    if (action.every(isStableActionToken)) return action;
  }
  return undefined;
}

function skipKnownOption(
  node: BashCommandRegistryNode,
  args: readonly string[],
  index: number,
): number | undefined {
  const token = args[index]!;
  if (!token.startsWith("-") || token === "-") return undefined;
  if (token === "--") return index + 1;
  const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
  const option = node[1].find((candidate) => candidate[0].includes(optionName));
  if (!option) return undefined;
  return index + (option[1] === 1 && !token.includes("=") ? 2 : 1);
}

function staticAssignmentTokens(invocation: BashCommandInvocation): string[] | undefined {
  const tokens: string[] = [];
  for (const assignment of invocation.envAssignments) {
    if (!assignment.name || assignment.value === undefined) return undefined;
    const token = `${assignment.name}=${assignment.value}`;
    if (!isStaticAssignmentToken(token)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

function isStaticAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@,+-]*$/.test(token);
}

function isStableActionToken(token: string | undefined): token is string {
  return (
    Boolean(token) &&
    !token!.startsWith("-") &&
    !looksLikePathOrUrl(token!) &&
    !/\s/.test(token!)
  );
}

function looksLikePathOrUrl(token: string): boolean {
  // 路径/URL 每次调用都不同，放进规则前缀既无法复用又可能误放行，因此不算稳定 action。
  return (
    token.includes("://") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

function serializePrefix(tokens: readonly string[]): string | undefined {
  // 前缀至少要有两个 token（命令 + action）；单个 token 等于放行整个命令族，过宽。
  if (tokens.length < 2 || tokens.some((token) => token.length === 0 || /\s/.test(token))) {
    return undefined;
  }
  return tokens.join(" ");
}

function executableBasename(token: string): string {
  const normalized = token.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

function readCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}
