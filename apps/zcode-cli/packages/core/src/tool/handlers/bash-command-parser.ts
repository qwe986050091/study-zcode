// INV-01 守住位置：analyzeBashCommand 是唯一入口，输入原始 command 串、输出分析对象。改错故障：改成接收已切分的 argv，引号与转义信息在入口即丢失。
// INV-02 守住位置：解析失败一律折算为带 hasParseErrors 的空分析，不向上抛。改错故障：抛异常会让权限层把「解析不了」当成工具执行失败，绕过保守审批。
// INV-03 守住位置：超长判断先于 parse，阈值是 MAX_BASH_PARSE_LENGTH。改错故障：先解析再判断，超长输入会成为解析成本放大器。
// INV-04 守住位置：trim 后为空立即返回空分析，不调用 unbash。改错故障：把空串送进解析器会产生错误标记，合法的空命令被误判为不可判定。
// INV-05 守住位置：isBashCommandPermissionSafe 要求三个标记全为假才返回真。改错故障：漏判任一标记，动态词或未支持语法会被当成可判定的普通命令。
// INV-06 守住位置：动态词检查覆盖 argv、赋值前缀、重定向目标三处。改错故障：只查 argv 会漏掉赋值前缀里的命令替换，前缀规则匹配到错误命令名。
// INV-07 守住位置：statement 级与 command 级重定向合并后再置 hasRedirects。改错故障：只认 command 级重定向，`cmd > file` 会被当成只读命令。
// INV-08 守住位置：operatorBefore 描述与本命令左侧相邻的连接符。改错故障：偏移一位会让 `a && b` 的后半段被当成首命令，前缀规则错位匹配。
// INV-09 守住位置：顶层多条 statement 之间补 sequence 连接符。改错故障：缺失连接符会让两条独立命令在语义上被拼成一条，权限前缀提取越界。
// INV-10 守住位置：非容器节点类型记入 unsupportedNodeTypes。改错故障：直接忽略会让 if、for、子 shell 等结构被当作可判定语法放行。
// INV-11 守住位置：SUPPORTED_CONTAINER_NODES 只含 AndOr、Pipeline、Statement。改错故障：把叶子节点加进白名单，真正不支持的语法会逃过过滤。
// INV-12 守住位置：statement.background 记为 background 标记。改错故障：漏掉后台符会让脱管子进程逃出超时与取消的覆盖范围。
// INV-13 守住位置：CommandWord 的 glob 证据只取顶层 Literal 片段。改错故障：把替换载荷当成词面证据，删除目标判定会失准。
// INV-14 守住位置：commandText 由源码区间切片得到，不从 argv 重新拼接。改错故障：重组文本丢失原始引号与空格，权限展示与规则匹配对不上。
// INV-15 守住位置：Pipeline.time 为真时把 time 词补回首命令的 words。改错故障：不补会让 time 的参数被当成可执行名，真实命令被漏判。
// INV-16 守住位置：freezeAnalysis 只做标记收口，不再改写 commands 内容。改错故障：在收口阶段改 argv，调用方已持有的引用与分析结果不一致。
// INV-17 守住位置：isWord 只过滤 undefined，不做内容校验。改错故障：在此顺带改词会让 words 与 argv 的下标对应关系断裂。
// INV-18 守住位置：本模块不读环境变量、不碰文件系统、不发起子进程。改错故障：引入外部状态后，同一 command 的判定结果无法复现。
//
// 模块职责：把 bash 文本解析成扁平的 BashCommandInvocation 列表，为只读判定与权限前缀提取提供结构事实。
// 状态所有权：分析结果归调用方所有，本模块只产出一次性不可变对象，不缓存、不跨调用共享。
// 阅读顺序：先看 analyzeBashCommand 主流程与三条早返回，再按 statement、node、simple 三层下钻，最后看动态片段判定。
/**
 * Bash 命令文法解析：把原始 command 串交给 unbash 解析成 AST，再摊平成
 * BashCommandInvocation[]（每个简单命令的 argv、环境变量前缀、重定向、与前一个命令的
 * 连接符），供 bash-semantics.ts 的只读判定与 bash-command-permission-policy.ts 的
 * 权限规则前缀提取使用。
 *
 * 口径是"能确定才放行"：解析失败、超过 10k 字符、出现不支持节点（后台 `&`、if/for 等）、
 * 或任一单词含变量/命令替换/进程替换，都会在 analysis 上打标记，让上层退回不可判定。
 * 失败语义：不抛异常，统一返回带 hasParseErrors 的空分析结果。
 */

import { parse } from "unbash";
import { literalPosixWord, type CommandWord } from "./guarded/word.js";
import type {
  AndOr,
  Command,
  Node,
  Pipeline,
  Redirect,
  Script,
  Statement,
  Word,
  WordPart,
} from "unbash";

// 对外契约固定为分析结果结构，上游只读这些字段，不直接接触 unbash 的 AST 类型。
// 连接符取值收窄为五种，前缀规则与只读判定都按此枚举分支，不做字符串猜测。
// operatorBefore 可选，表示该命令左侧的实际连接符，首条命令没有左邻。
// words 与 argv 一一对应，words 承载位置与 glob 证据，argv 只服务字面比较。
// 类型声明不承担运行时校验，字段是否可信由 analyzeBashCommand 的标记决定。
// 改错故障：把 AST 节点类型暴露给调用方，上游会耦合 unbash 版本，升级即破坏调用点。
export type BashCommandOperator = "&&" | "||" | "|" | "|&" | "sequence";

export interface BashCommandEnvAssignment {
  readonly name: string | undefined;
  readonly value: string | undefined;
}

export interface BashCommandRedirect {
  readonly fileDescriptor: number | undefined;
  readonly operator: Redirect["operator"];
  readonly target: string;
}

export interface BashCommandInvocation {
  readonly words: CommandWord[];
  readonly argv: string[];
  readonly commandText: string;
  readonly envAssignments: BashCommandEnvAssignment[];
  readonly hasAssignmentPrefix: boolean;
  readonly hasDynamicWords: boolean;
  readonly hasRedirects: boolean;
  readonly name: string;
  readonly operatorBefore?: BashCommandOperator;
  readonly redirects: BashCommandRedirect[];
}

export interface BashCommandAnalysis {
  readonly commands: BashCommandInvocation[];
  readonly hasDynamicWords: boolean;
  readonly hasParseErrors: boolean;
  readonly hasRedirects: boolean;
  readonly hasUnsupportedSyntax: boolean;
  readonly unsupportedNodeTypes: string[];
}

// 超长脚本直接按解析失败处理：限制解析成本，也不给超长输入留下歧义空间。
const MAX_BASH_PARSE_LENGTH = 10_000;
// 这些只是语法容器，不是"不支持的语法"；真正需要拦截的是容器里的未知叶子节点。
const SUPPORTED_CONTAINER_NODES = new Set(["AndOr", "Pipeline", "Statement"]);

// 主流程顺序固定：空串、超长、parse、遍历、收口，任一步提前都改变对外语义。
// 空串判断放在超长判断之前，空命令既不需要解析，也不应被打上解析错误。
// 异常捕获只包住 parse 调用，收集阶段的异常不被这段捕获吞掉。
// script.errors 非空时仍继续收集命令，错误标记与已解析结果一起交给上层判断。
// 顶层 statement 之间没有显式连接符，按下标补 sequence 维持命令连续性。
// 改错故障：把收口逻辑散落在遍历途中，任一早返回都会产出字段残缺的分析结果。
export function analyzeBashCommand(command: string): BashCommandAnalysis {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return emptyAnalysis();
  }
  if (command.length > MAX_BASH_PARSE_LENGTH) {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  let script: Script & { errors?: unknown[] };
  try {
    script = parse(command);
  } catch {
    return {
      ...emptyAnalysis(),
      hasParseErrors: true,
    };
  }

  const analysis: MutableBashCommandAnalysis = {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: Boolean(script.errors?.length),
    hasRedirects: false,
    unsupportedNodeTypes: new Set(),
  };

  for (let index = 0; index < script.commands.length; index += 1) {
    collectStatementCommands(command, script.commands[index]!, {
      analysis,
      operatorBefore: index === 0 ? undefined : "sequence",
      statementRedirects: [],
    });
  }

  return freezeAnalysis(analysis);
}

/**
 * 权限匹配可用前提：无解析错误、无未支持语法、无动态词。
 * 三条任一不满足时上层一律按"不可判定"处理（保守地走审批），而不是猜一个结果。
 */
// [契约] isBashCommandPermissionSafe 回答的是「能否进入前缀匹配」而不是「命令本身安全」，调用方不能把 true 读成放行。
// 三个标记任一为真即退回审批，宁可多问一次也不去猜动态内容。
// hasRedirects 不参与此判定，但调用方要单独识别写入型重定向。
// 函数无副作用，同一份分析可被权限层重复调用，不得在此累计状态。
// 新增标记必须同步加进表达式，否则新语法会被静默放行。
// 改错故障：为兼容旧调用改成默认返回真，解析失败的命令会绕过审批直达执行。
export function isBashCommandPermissionSafe(analysis: BashCommandAnalysis): boolean {
  return !analysis.hasParseErrors && !analysis.hasUnsupportedSyntax && !analysis.hasDynamicWords;
}

interface MutableBashCommandAnalysis {
  commands: BashCommandInvocation[];
  hasDynamicWords: boolean;
  hasParseErrors: boolean;
  hasRedirects: boolean;
  unsupportedNodeTypes: Set<string>;
}

interface CollectContext {
  analysis: MutableBashCommandAnalysis;
  operatorBefore?: BashCommandOperator;
  statementRedirects: Redirect[];
}

// statement 级重定向与后台标记只能在此采集，子节点拿不到这两项信息。
// statementRedirects 用展开合并向下传递，管道两侧因此都能看到 statement 级重定向。
// 每层递归新建 context 对象，兄弟节点之间不会互相污染标记。
// background 只打标记不中断遍历，后续命令仍要完整产出供上层展示。
// 重定向目标的动态词必须同时置 hasDynamicWords，否则目标可能来自替换却被当作字面路径。
// 改错故障：就地修改 context.statementRedirects，后续 statement 会继承上一轮重定向并被误标记。
function collectStatementCommands(
  source: string,
  statement: Statement,
  context: CollectContext,
): void {
  if (statement.background) {
    // `cmd &` 会脱离本次执行的生命周期：超时、取消、输出收集都管不到它，无法给出确定结果。
    context.analysis.unsupportedNodeTypes.add("background");
  }
  if (statement.redirects.length > 0) {
    // 重定向可能是 `>`/`>>` 写文件；先标记 hasRedirects，让上层拒绝把它当只读命令。
    context.analysis.hasRedirects = true;
    if (redirectsHaveDynamicWords(statement.redirects)) context.analysis.hasDynamicWords = true;
  }

  collectNodeCommands(source, statement.command, {
    ...context,
    statementRedirects: [...context.statementRedirects, ...statement.redirects],
  });
}

// 以 node.type 做穷举分派，未知类型统一记入 unsupportedNodeTypes。
// 各分支处理完立即 return，避免同一次遍历被重复计数。
// 改错故障：default 分支若静默忽略，unbash 升级新增的节点类型会直接失去拦截。
function collectNodeCommands(source: string, node: Node, context: CollectContext): void {
  switch (node.type) {
    case "Command":
      collectSimpleCommand(source, node, context);
      return;
    case "AndOr":
      collectAndOrCommands(source, node, context);
      return;
    case "Pipeline":
      collectPipelineCommands(source, node, context);
      return;
    case "Statement":
      collectStatementCommands(source, node, context);
      return;
    default:
      context.analysis.unsupportedNodeTypes.add(node.type);
  }
}

// 连接符按下标取 operators，首项沿用外层 operatorBefore 表示左侧相邻符。
// 下标判断必须用 index === 0，写成常量 0 会让后续项全部继承错误前缀。
// 改错故障：假设 operators 与 commands 等长，尾部会取到 undefined 而丢失连接语义。
function collectAndOrCommands(source: string, node: AndOr, context: CollectContext): void {
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
}

function collectPipelineCommands(source: string, node: Pipeline, context: CollectContext): void {
  const firstCommandIndex = context.analysis.commands.length;
  for (let index = 0; index < node.commands.length; index += 1) {
    collectNodeCommands(source, node.commands[index]!, {
      ...context,
      operatorBefore: index === 0 ? context.operatorBefore : node.operators[index - 1],
    });
  }
  // unbash 将 time 关键字从 argv 提升为 Pipeline.time；恢复这个已定位的 wrapper，
  // 否则 time -o file 的参数会被误当成 executable，漏掉后续真实命令。
  const first = context.analysis.commands[firstCommandIndex];
  if (node.time && first) {
    const prefix = source.slice(node.pos, first.words[0]?.start);
    const time = /\btime\b/.exec(prefix);
    if (time)
      first.words.unshift({
        value: "time",
        dynamic: false,
        hasUnquotedGlob: false,
        start: node.pos + time.index,
        end: node.pos + time.index + 4,
      });
  }
}

// 简单命令是唯一产出 BashCommandInvocation 的位置，字段必须一次算全，避免二次补写。
// redirects 来自 statement 继承与 command 自身两处，合并顺序决定后续展示与去重顺序。
// words 与 argv 必须同源同序，words 额外携带位置与 glob 证据供删除类规则使用。
// hasDynamicWords 同时覆盖 argv、赋值前缀、重定向目标，三者任一为真都要标记。
// commandText 取自源码区间，保留原始引号与空格，供权限提示原样展示。
// 改错故障：只对 argv 做动态词检查，赋值前缀里的命令替换会绕过上层审批。
function collectSimpleCommand(source: string, command: Command, context: CollectContext): void {
  const redirects = [...context.statementRedirects, ...command.redirects];
  const words = [command.name, ...command.suffix].filter(isWord);
  const argv = words.map(wordValue);
  const envAssignments = command.prefix.map((assignment) => ({
    name: assignment.name,
    value: assignment.value ? wordValue(assignment.value) : undefined,
  }));
  const hasDynamicWords =
    words.some(wordHasDynamicParts) ||
    command.prefix.some(
      (assignment) => assignment.value !== undefined && wordHasDynamicParts(assignment.value),
    ) ||
    redirectsHaveDynamicWords(redirects);

  if (hasDynamicWords) context.analysis.hasDynamicWords = true;
  if (redirects.length > 0) context.analysis.hasRedirects = true;

  const name = command.name ? wordValue(command.name) : "";
  context.analysis.commands.push({
    words: words.map((word) => {
      const fact = literalPosixWord(word.text, word.pos, word.end);
      // 只取顶层字面片段的 glob；变量/命令替换/brace 的载荷不是删除目标的词面证据。
      if (word.parts)
        fact.hasUnquotedGlob = word.parts.some(
          (part) =>
            part.type === "Literal" &&
            literalPosixWord(part.text, 0, part.text.length).hasUnquotedGlob,
        );
      return fact;
    }),
    argv,
    commandText: source.slice(command.pos, command.end),
    envAssignments,
    hasAssignmentPrefix: command.prefix.length > 0,
    hasDynamicWords,
    hasRedirects: redirects.length > 0,
    name,
    operatorBefore: context.operatorBefore,
    redirects: redirects.map((redirect) => ({
      fileDescriptor: redirect.fileDescriptor,
      operator: redirect.operator,
      target: redirectTargetValue(redirect),
    })),
  });
}

function redirectTargetValue(redirect: Redirect): string {
  if (redirect.target !== undefined) return wordValue(redirect.target);
  return redirect.content ?? "";
}

function redirectsHaveDynamicWords(redirects: Redirect[]): boolean {
  return redirects.some((redirect) => {
    return (
      (redirect.target !== undefined && wordHasDynamicParts(redirect.target)) ||
      (redirect.body !== undefined && wordHasDynamicParts(redirect.body))
    );
  });
}

function wordHasDynamicParts(word: Word): boolean {
  // 命令替换和进程替换会在主命令前执行，权限判断不能把它们当成普通 argv。
  return word.parts?.some(partHasDynamicExecution) ?? false;
}

// 静态片段走白名单返回假，其余一律返回真，失败方向固定为保守。
// DoubleQuoted 与 LocaleString 必须下钻，双引号内的替换同样会先执行。
// 改错故障：在 default 分支返回假，新增 WordPart 类型会默认被当作安全字面量。
function partHasDynamicExecution(part: WordPart): boolean {
  switch (part.type) {
    case "AnsiCQuoted":
    case "Literal":
    case "SingleQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(partHasDynamicExecution);
    case "CommandExpansion":
    case "ProcessSubstitution":
      // 这两种替换会在主命令之前先执行任意命令，argv 的其余字面量已不能代表实际执行内容。
      return true;
    case "ArithmeticExpansion":
    case "BraceExpansion":
    case "ExtendedGlob":
    case "ParameterExpansion":
    case "SimpleExpansion":
      return true;
    default:
      return true;
  }
}

function wordValue(word: Word): string {
  return word.value ?? word.text;
}

function isWord(word: Word | undefined): word is Word {
  return word !== undefined;
}

function emptyAnalysis(): BashCommandAnalysis {
  return {
    commands: [],
    hasDynamicWords: false,
    hasParseErrors: false,
    hasRedirects: false,
    hasUnsupportedSyntax: false,
    unsupportedNodeTypes: [],
  };
}

function freezeAnalysis(analysis: MutableBashCommandAnalysis): BashCommandAnalysis {
  // 容器节点只是正常语法结构，过滤掉后再判断是否真的存在"不支持语法"。
  const unsupportedNodeTypes = [...analysis.unsupportedNodeTypes].filter(
    (type) => !SUPPORTED_CONTAINER_NODES.has(type),
  );

  return {
    commands: analysis.commands,
    hasDynamicWords: analysis.hasDynamicWords,
    hasParseErrors: analysis.hasParseErrors,
    hasRedirects: analysis.hasRedirects,
    hasUnsupportedSyntax: unsupportedNodeTypes.length > 0,
    unsupportedNodeTypes,
  };
}
