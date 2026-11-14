// INV-01 保守判定：守住位置 所有不确定分支；改错故障：看起来只读的命令被放行。
// INV-02 分类不授权：守住位置 搜索读取列举集合；改错故障：界面分类被当成免审批依据。
// INV-03 解析失败即否：守住位置 解析错误与动态词检查；改错故障：半解析的命令进入放行链。
// INV-04 前缀即否：守住位置 赋值前缀判断；改错故障：环境变量改写命令行为仍判只读。
// INV-05 写选项即否：守住位置 已知写选项检查；改错故障：就地编辑被当成读取。
// INV-06 单命令要求：守住位置 命令条数判断；改错故障：复合命令只校验第一段。
// INV-07 git 与目录隔离：守住位置 两者同现的拒绝；改错故障：外部仓库钩子被执行。
// INV-08 运行时上下文：守住位置 git 上下文检查；改错故障：工作区外仓库配置被信任。
// INV-09 至少一条命中：守住位置 只读计数；改错故障：全中性命令被当成只读。
// INV-10 匹配器兜底：守住位置 复合命令返回恒真；改错故障：规则匹配不到，权限链失去兜底。
// INV-11 规范化匹配：守住位置 argv 拼接；改错故障：引号差异让已保存规则失效。
// INV-12 前缀边界：守住位置 冒号星号处理；改错故障：前缀匹配误中更长的命令名。
// INV-13 转义完整：守住位置 通配转正则；改错故障：特殊字符被当成正则语法。
// INV-14 静默认兜底：守住位置 或运算后的中性命令；改错故障：失败提示让静默命令被判非静默。
// INV-15 语义非错误：守住位置 退出码一的解释；改错故障：无匹配被记为执行失败。
// INV-16 只看末条：守住位置 管道末命令；改错故障：前面出现过的命令影响退出码解释。
// INV-17 提示行剥离：守住位置 内部标记清理；改错故障：内部提示泄漏给模型。
// INV-18 顺序即优先级：守住位置 返回码解释顺序；改错故障：超时被退出码分支覆盖。
//
// 模块职责：汇总 Bash 的只读判定、权限匹配、分类、返回码解释与输出清理。
// 状态所有权：无运行时状态，全部为纯函数与常量集合。
// 阅读顺序：常量集合 → 分类 → 只读判定 → 权限匹配 → 静默与截断 → 返回码解释 → 内部辅助。
/**
 * Bash 语义层：只读判定、权限 pattern 匹配、命令分类、返回码解释与 stdout 清理的汇总入口。
 * 输入是原始 command 字符串（或执行结果），内部依赖 bash-command-parser.ts 的分析结果；
 * 被 bash.ts（isBashInputReadOnly / prepareBashPermissionMatcher）、bash-output.ts
 * （返回码解释、silent 判定）、bash-model-content.ts、bash-image-output.ts、
 * bash-metadata.ts、bash-command-permission-policy.ts、bash-read-file-state.ts 调用。
 *
 * 判定口径统一朝保守方向：解析不安全、命令不在白名单、出现未知 flag 都返回 false / undefined，
 * 由权限链决定是否让用户审批，绝不因为"看起来像只读"而放行。
 */

import type { ExecutionResult } from "@zcode/contracts";
import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";
import {
  analysisContainsGitAndDirectoryChange,
  analysisContainsGitCommand,
  isGitRuntimeContextUnsafe,
  type BashReadonlyRuntimeContext,
} from "./bash-git-runtime-safety.js";
import {
  evaluateBashReadonlyPolicy,
  hasKnownBashWriteOption,
  isSedInPlaceOption,
} from "./bash-readonly-policy.js";

export interface BashCommandClassification {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
}

export type BashPermissionMatcher = (pattern: string) => boolean;

// EMPTY_CLASSIFICATION 把 isList / isRead / isSilent 等字段全部置 false，解析不确定时直接展开它。
// 返回副本而不是共享对象，避免调用方改写常量。
//
const EMPTY_CLASSIFICATION: BashCommandClassification = {
  isList: false,
  isRead: false,
  isSearch: false,
};

// 下面几组集合只服务 UI/自动分类（搜索、读取、列举），不参与只读放行；
// 能否免审批由 bash-readonly-policy.ts 的 evaluateBashReadonlyPolicy 决定。
// 搜索命令集合只服务界面分类，不参与放行。
// 能否免审批完全由只读策略模块决定。
//
const BASH_SEARCH_COMMANDS = new Set([
  "ag",
  "ack",
  "egrep",
  "fgrep",
  "grep",
  "locate",
  "rg",
  "which",
  "whereis",
]);
const BASH_READ_COMMANDS = new Set([
  "awk",
  "cat",
  "cut",
  "file",
  "head",
  "jq",
  "less",
  "more",
  "sed",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "uniq",
  "wc",
  "yq",
]);
const BASH_LIST_COMMANDS = new Set(["du", "find", "ls", "tree"]);
// BASH_SEMANTIC_NEUTRAL_COMMANDS（echo / printf / true 等）不改变语义，循环里直接跳过。
// 只出现中性命令时不算有效只读调用。
//
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["", ":", "echo", "false", "printf", "true"]);
const BASH_SILENT_COMMANDS = new Set([
  "cd",
  "chgrp",
  "chmod",
  "chown",
  "cp",
  "export",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "touch",
  "unset",
  "wait",
]);
// 这些 exit 1 表示"查询结果为否"（grep 无匹配、diff 有差异、test 为假），
// 属于命令事实而不是执行失败，避免被 UI/遥测记成 Bash 报错。
// 这些退出码表示查询结果为否而非执行失败。
// 避免被界面与遥测记录成真实报错。
//
const SEMANTIC_NON_ERROR_MESSAGES = new Set([
  "Condition is false",
  "Files differ",
  "No matches found",
  "Some directories were inaccessible",
]);
const SEMANTIC_NO_MATCH_COMMANDS = new Set(["egrep", "fgrep", "grep", "rg"]);
const CLAUDE_CODE_HINT_LINE_RE = /^[ \t]*<claude-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm;

// 解析失败、语法不支持或动态词一律判否。
// 先剥掉 VAR=x 赋值前缀与已知写选项，再按 BASH_READ_COMMANDS / BASH_LIST_COMMANDS 分类。
//
export function isSearchOrReadBashCommand(command: string): BashCommandClassification {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords) {
    return { ...EMPTY_CLASSIFICATION };
  }
  if (analysis.commands.length === 0) return { ...EMPTY_CLASSIFICATION };

  let hasList = false;
  let hasNonNeutralCommand = false;
  let hasRead = false;
  let hasSearch = false;

  for (const commandPart of analysis.commands) {
    // 环境变量前缀可能改写命令行为（PATH/LD_PRELOAD 等），写选项（如 sed -i）直接改变文件，
    // 这两种情况都不能再算"纯搜索/读取"。
    if (commandPart.hasAssignmentPrefix) return { ...EMPTY_CLASSIFICATION };
    if (hasKnownBashWriteOption(commandPart)) return { ...EMPTY_CLASSIFICATION };

    const commandName = commandPart.name;
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) continue;

    hasNonNeutralCommand = true;
    const isSearch = BASH_SEARCH_COMMANDS.has(commandName);
    const isRead = BASH_READ_COMMANDS.has(commandName);
    const isList = BASH_LIST_COMMANDS.has(commandName);
    if (!isSearch && !isRead && !isList) return { ...EMPTY_CLASSIFICATION };

    hasSearch ||= isSearch;
    hasRead ||= isRead;
    hasList ||= isList;
  }

  if (!hasNonNeutralCommand) return { ...EMPTY_CLASSIFICATION };
  return { isList: hasList, isRead: hasRead, isSearch: hasSearch };
}

export function isBashReadOnlyCommand(command: string): boolean {
  return isRuntimeReadOnlyBashCommand(command);
}

// 要求解析安全且恰好只有一条命令。
// 最后仍要过只读策略，任一环节不通过即否。
//
export function isSimpleReadOnlyBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length !== 1) return false;
  const commandPart = analysis.commands[0]!;
  return commandPart.argv.length > 0 && evaluateBashReadonlyPolicy(commandPart) === true;
}

// git 与目录切换同现必须拒绝。
// 工作区外仓库上下文同样拒绝，避免加载外部钩子。
//
export function isRuntimeReadOnlyBashCommand(
  command: string,
  context?: BashReadonlyRuntimeContext,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return false;
  if (analysis.commands.length === 0) return false;
  // git 与 cd/pushd/popd 同现时必须拒绝：git 会在目标目录加载 hooks/config，
  // 换目录后再跑 git 等于在不可控的仓库上下文里执行。
  if (analysisContainsGitAndDirectoryChange(analysis.commands)) return false;
  // 当前工作目录若指向工作区外的 .git / 裸仓库指示，git 会信任那份配置（含 hooks）。
  if (analysisContainsGitCommand(analysis.commands) && isGitRuntimeContextUnsafe(context))
    return false;

  let hasReadOnlyCommand = false;

  for (const commandPart of analysis.commands) {
    // 含已知写选项的命令整体判可写（例如 find -delete、sed -i、tree -o）。
    if (hasKnownBashWriteOption(commandPart)) return false;

    const policyResult = evaluateBashReadonlyPolicy(commandPart);
    if (policyResult === false) return false;
    if (policyResult === true) {
      hasReadOnlyCommand = true;
      continue;
    }

    // undefined 表示"没有白名单能覆盖这条命令"，同样不能放行。
    return false;
  }

  // 全部命令都只读，且至少有一条真正被白名单命中的命令才算只读。
  return hasReadOnlyCommand;
}

// 拆不出唯一 argv 时返回恒真的匹配器。
// 把处置权交回上层权限链，不代表已允许执行。
//
export function prepareBashPermissionMatcherForCommand(
  command: string,
): BashPermissionMatcher | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return () => false;

  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) {
    // 复合命令/动态命令拆不出唯一 argv：返回恒真 matcher，表示任何规则模式都命中它，
    // 由上层权限流程（拒绝优先）自行处理，不能把这当成"已允许执行"。
    return () => true;
  }

  const commandPart = analysis.commands[0]!;
  if (commandPart.hasAssignmentPrefix || commandPart.hasRedirects) return () => true;

  // 用规范化后的 argv 拼接串匹配规则，避免引号/空白写法差异导致已保存规则失效。
  const normalizedCommand = commandPart.argv.join(" ");
  if (normalizedCommand.length === 0) return () => false;
  return (pattern) => matchesBashPermissionPattern(pattern, normalizedCommand);
}

export function hasBestEffortWritePattern(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(hasKnownBashWriteOption);
}

export function isSedInPlaceBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors) return false;
  return analysis.commands.some(
    (commandPart) => commandPart.name === "sed" && commandPart.argv.some(isSedInPlaceOption),
  );
}

// 失败兜底的中性命令不改变静默事实。
// silent 判定要求每个 commandPart 都落在 BASH_SILENT_COMMANDS 内，任一不在就整体返回 false。
//
export function isSilentBashCommand(command: string): boolean {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax || analysis.hasDynamicWords)
    return false;
  if (analysis.commands.length === 0) return false;

  let hasNonFallbackCommand = false;

  for (const commandPart of analysis.commands) {
    const commandName = commandPart.name;
    if (!commandName) continue;
    // `cmd || echo xxx` 里的 echo 只是失败兜底提示，不改变 cmd 是否静默的事实。
    if (commandPart.operatorBefore === "||" && BASH_SEMANTIC_NEUTRAL_COMMANDS.has(commandName)) {
      continue;
    }

    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(commandName)) return false;
  }

  return hasNonFallbackCommand;
}

export function extractBashSearchText(output: { stderr?: string; stdout?: string }): string {
  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

export function isBashResultTruncated(output: { stderr?: string; stdout?: string }): boolean {
  return lineCount(output.stdout ?? "") > 4 || lineCount(output.stderr ?? "") > 4;
}

export function stripClaudeCodeHintLines(stdout: string): string {
  if (!stdout.includes("<claude-code-hint")) return stdout;
  // 修复原因：成功路径上先剥离内部 claude-code-hint 行，再继续 image/persisted mapping；
  // 这些内部 hint 不应成为 provider-visible Bash stdout。
  return stdout.replace(CLAUDE_CODE_HINT_LINE_RE, "").replace(/\n{3,}/g, "\n\n");
}

// 顺序即优先级，先看执行框架事实再看退出码。
// 只有退出码一才可能被解释为语义非错误。
//
export function interpretBashReturnCode(
  command: string,
  result: Pick<ExecutionResult, "error" | "exitCode" | "signal" | "status">,
): string | undefined {
  // 顺序即优先级：输出超限/超时/取消/启动失败是执行框架事实，先于退出码解释。
  if (result.error?.type === "output_limit") {
    return "Command stopped because output exceeded the configured limit";
  }
  if (result.status === "timed_out") return "Command timed out";
  if (result.status === "cancelled") return "Command was cancelled";
  if (result.status === "spawn_error") return "Command failed to start";
  if (result.exitCode !== undefined && result.exitCode !== 0) {
    // exit 1 对 grep/diff/test 等是"结果为否"；其余非零码仍然按失败解释。
    const semantic = semanticNonErrorExit(command, result.exitCode);
    return semantic ?? `Command exited with code ${result.exitCode}`;
  }
  if (result.signal) return `Command exited due to signal ${result.signal}`;
  return undefined;
}

export function isSemanticNonErrorInterpretation(message: string | undefined): boolean {
  return message !== undefined && SEMANTIC_NON_ERROR_MESSAGES.has(message);
}

export function isBashProviderErrorStatus(output: {
  exitCode?: unknown;
  returnCodeInterpretation?: unknown;
  status?: unknown;
}): boolean {
  if (output.status !== "failed") return false;
  if (typeof output.exitCode !== "number" || output.exitCode === 0) return false;
  return !isSemanticNonErrorInterpretation(
    typeof output.returnCodeInterpretation === "string"
      ? output.returnCodeInterpretation
      : undefined,
  );
}

function semanticNonErrorExit(command: string, exitCode: number): string | undefined {
  // 只把 exit 1 视作语义非错误：其他码在常见命令里都代表真实失败（如 grep 的 2 = 文件错误）。
  if (exitCode !== 1) return undefined;
  const commandName = statusCommandNameForExitOne(command);
  return commandName === undefined ? undefined : semanticExitOneInterpretation(commandName);
}

function statusCommandNameForExitOne(command: string): string | undefined {
  const analysis = analyzeBashCommand(command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) return undefined;
  // shell 的 $? 来自管道最后一个命令，所以只按最后一条命令解释退出码。
  const statusCommand = analysis.commands.at(-1);
  if (statusCommand === undefined) return undefined;

  // 不能因为命令行前面出现过 rg/grep，就把后续 test/exit 的 1 误判成 No matches found。
  if (statusCommand.name === "git") {
    // git grep/diff 同样是"结果为否"语义，但需要跳过 -C/-c 等全局选项再取子命令。
    const gitSubcommand = gitSemanticSubcommandName(statusCommand.argv);
    if (gitSubcommand === "grep") return "grep";
    if (gitSubcommand === "diff") return "diff";
  }
  return statusCommand.name;
}

function semanticExitOneInterpretation(commandName: string): string | undefined {
  if (SEMANTIC_NO_MATCH_COMMANDS.has(commandName)) return "No matches found";
  if (commandName === "find") return "Some directories were inaccessible";
  if (commandName === "diff") return "Files differ";
  if (commandName === "test" || commandName === "[") return "Condition is false";
  return undefined;
}

function gitSemanticSubcommandName(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      if (arg === "-C" || arg === "-c") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function matchesBashPermissionPattern(pattern: string, command: string): boolean {
  // `cmd:*` 表示"以 cmd 开头的任意命令"，必须按 token 边界匹配，
  // 否则 `git:*` 会错误命中 `gitk`。
  const prefix = permissionPatternPrefix(pattern);
  if (prefix !== null) return command === prefix || command.startsWith(`${prefix} `);
  return wildcardToRegExp(pattern).test(command);
}

function permissionPatternPrefix(pattern: string): string | null {
  return pattern.endsWith(":*") ? pattern.slice(0, -2) : null;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length;
}
