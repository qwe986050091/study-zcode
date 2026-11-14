// INV-01 子命令缺省为 list：守住位置 args 首项；改错故障 空参报用法错误。
// INV-02 list 拒绝多余参数：守住位置 长度判断；改错故障 拼写错误被静默忽略。
// INV-03 inspect 必须带名字：守住位置 长度与空白检查；改错故障 空名字进入发现层。
// INV-04 未知子命令写用法：守住位置 末段；改错故障 用户只能猜测语法。
// INV-05 用法错误统一出口：守住位置 failUsage；改错故障 文案多处漂移。
// INV-06 退出码只由本层决定：守住位置 返回值；改错故障 低层直接退出进程。
// INV-07 数据写 stdout 诊断写 stderr：守住位置 ctx 分流；改错故障 重定向拿不到数据。
// INV-08 依赖可注入：守住位置 deps 结构；改错故障 单测被迫拉起 bootstrap。
// INV-09 列举实现惰性解析：守住位置 resolve 函数；改错故障 启动即加载重依赖。
// INV-10 工作目录取 cwd 依赖：守住位置 回退 process.cwd；改错故障 单测读到真实目录。
// INV-11 错误统一上报：守住位置 reportCommandsError；改错故障 异常被吞成空输出。
// INV-12 详细模式才附栈：守住位置 verbose 判断；改错故障 默认输出泄露实现细节。
// INV-13 空列表给固定提示：守住位置 早退；改错故障 输出空行难以辨认。
// INV-14 非交互命令加后缀：守住位置 描述格式化；改错故障 headless 误用只能交互的命令。
// INV-15 诊断区仅详细模式：守住位置 appendDiagnostics；改错故障 默认输出被噪声淹没。
// INV-16 列表 JSON 不含正文：守住位置 顶层字段；改错故障 大正文灌进列表输出。
// INV-17 详情 JSON 含截断信息：守住位置 bytesRead 与 sizeBytes；改错故障 调用方无法判断完整度。
// INV-18 可选字段仅在有值时出现：守住位置 条件展开；改错故障 缺失与空串无法区分。
//
// 模块职责：实现 `zcode commands` 的 list 与 inspect 子命令及两种输出格式。
// 状态所有权：无状态；运行环境与发现实现均可注入。
// 阅读顺序：先看入口分发，再看两个子命令，最后看输出格式化。
import { formatJson } from "@zcode/core";
import type { Logger } from "@zcode/contracts";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type {
  inspectZCodeCustomCommand,
  InspectZCodeCustomCommandOptions,
  listZCodeCustomCommands,
  ListZCodeCustomCommandsOptions,
  ZCodeCustomCommandInspection,
} from "@zcode/bootstrap";
import type { CliEnv } from "./env.js";

type BootstrapModule = typeof import("@zcode/bootstrap");
type CustomCommandListOutcome = Awaited<ReturnType<typeof listZCodeCustomCommands>>;
// 列表结果中单条命令的类型别名，便于格式化函数复用而不重复推导。
type CustomCommandListItem = CustomCommandListOutcome["commands"][number];

// `zcode commands` 的依赖注入：cwd/env 提供运行环境；inspect/list 可替换为 bootstrap 实现；
// loadBootstrapModule 用于延迟加载重依赖；logger 透传到发现层用于诊断。
// 全部可选，缺省时在调用点按需回退，便于 CLI 单测不拉起完整 bootstrap。
interface CommandsCommandDependencies {
  cwd?: () => string;
  env?: CliEnv;
  inspectCustomCommand?: (
    options: InspectZCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectZCodeCustomCommand>;
  listCustomCommands?: (
    options: ListZCodeCustomCommandsOptions,
  ) => ReturnType<typeof listZCodeCustomCommands>;
  loadBootstrapModule?: () => Promise<BootstrapModule>;
  logger?: Logger;
}

// 命令用法文案；参数数量不符或未知子命令时输出，避免用户猜测语法。
const COMMANDS_COMMAND_USAGE = "Usage: zcode commands [list|inspect <name>]";

// `zcode commands` 入口：分发 list/inspect 子命令并返回进程退出码（0 成功，1 失败/用法错误）。
// 输出写 ctx.stdout（数据）或 ctx.stderr（诊断），不直接 process.exit；
// 未知子命令、多余参数、inspect 缺名字均视为用法错误。
// 缺省子命令为 list。
// list 拒绝多余参数。
// inspect 必须带非空名字。
// 未知子命令输出用法并返回 1。
export async function runCommandsCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: CommandsCommandDependencies,
  args: string[],
): Promise<number> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    if (args.length > 1) return failUsage(ctx);
    return await runCommandsListCommand(ctx, options, deps);
  }
  if (subcommand === "inspect") {
    if (args.length !== 2 || args[1]?.trim().length === 0) return failUsage(ctx);
    return await runCommandsInspectCommand(ctx, options, deps, args[1]);
  }

  ctx.stderr.write(`Unknown commands command: ${subcommand}\n${COMMANDS_COMMAND_USAGE}\n`);
  return 1;
}

// 输出用法提示并返回 1；集中复用避免多处文案漂移。
function failUsage(ctx: RunContext): number {
  ctx.stderr.write(`${COMMANDS_COMMAND_USAGE}\n`);
  return 1;
}

// list 子命令：解析工作目录与列举实现，按 --json 选择机器可读或人类可读输出；
// 发现层抛错统一交给 reportCommandsError（返回 1，不吞错误信息）。
// 工作目录优先取注入值。
// listCustomCommands 由 resolveListCustomCommands 惰性解析，模块加载期不引入发现层。
// 按 json 选项选择格式。
// catch 块不自行格式化，统一转给 reportCommandsError 并返回它的退出码。
async function runCommandsListCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: CommandsCommandDependencies,
): Promise<number> {
  try {
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const listCustomCommands = await resolveListCustomCommands(deps);
    const outcome = await listCustomCommands({
      env: deps.env ?? process.env,
      logger: deps.logger,
      workingDirectory,
    });

    ctx.stdout.write(
      options.json
        ? formatCommandJson(outcome, workingDirectory)
        : formatHumanCommandList(outcome, options),
    );
    return 0;
  } catch (error) {
    return reportCommandsError(ctx, options, error);
  }
}

// inspect 子命令：按名称加载单条命令详情；--json 输出完整 metadata 与截断信息，
// 人类可读模式仅在 --verbose 时附正文，避免默认输出过大。
// inspectCustomCommand 同样惰性解析，与 list 共用 CommandsCommandDependencies。
// name 原样传给发现层，不做前缀补全或大小写归一。
// 人类可读的 inspect 只在 --verbose 时附 Content 段，默认不输出正文。
async function runCommandsInspectCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: CommandsCommandDependencies,
  name: string,
): Promise<number> {
  try {
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const inspectCustomCommand = await resolveInspectCustomCommand(deps);
    const inspection = await inspectCustomCommand({
      env: deps.env ?? process.env,
      logger: deps.logger,
      name,
      workingDirectory,
    });

    ctx.stdout.write(
      options.json
        ? formatCommandInspectionJson(inspection, workingDirectory)
        : formatHumanCommandInspection(inspection, options),
    );
    return 0;
  } catch (error) {
    return reportCommandsError(ctx, options, error);
  }
}

// 解析列举实现：显式注入优先，否则延迟加载 bootstrap；不缓存结果，每次调用取最新实现。
async function resolveListCustomCommands(deps: CommandsCommandDependencies) {
  if (deps.listCustomCommands) return deps.listCustomCommands;
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
  return (await bootstrap()).listZCodeCustomCommands;
}

// 解析详情实现：规则同 resolvelist，缺省时才触发 bootstrap 动态导入。
async function resolveInspectCustomCommand(deps: CommandsCommandDependencies) {
  if (deps.inspectCustomCommand) return deps.inspectCustomCommand;
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
  return (await bootstrap()).inspectZCodeCustomCommand;
}

// 统一错误出口：错误信息写 stderr；--verbose 且是 Error 时附加 stack；始终返回退出码 1。
function reportCommandsError(ctx: RunContext, options: GlobalOptions, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  ctx.stderr.write(`Error: ${message}\n`);
  if (options.verbose && error instanceof Error && error.stack) {
    ctx.stderr.write(`${error.stack}\n`);
  }
  return 1;
}

// 人类可读列表：空列表输出固定提示；每条含 usage、描述（非交互命令加后缀）与来源路径；
// --verbose 时追加诊断区，默认不展示以免噪声。
function formatHumanCommandList(
  outcome: CustomCommandListOutcome,
  options: GlobalOptions,
): string {
  if (outcome.commands.length === 0) {
    return "No custom commands found.\n";
  }

  const lines = [`Custom commands (${outcome.commands.length})`];
  for (const command of outcome.commands) {
    lines.push(`- /${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`);
    lines.push(`  ${formatCommandDescription(command)}`);
    lines.push(`  ${command.scope}/${command.source}: ${command.path}`);
  }

  appendDiagnostics(lines, outcome.diagnostics, options);
  return `${lines.join("\n")}\n`;
}

// 人类可读详情：依次输出命令名、作用域/来源、路径、描述与可选字段（参数提示/工具/技能/模型）；
// size 行用「已读/总字节」并标记 truncated；--verbose 时附正文（空内容显示 (empty)）。
// 先写入 Command、scope/source、path、description 四个固定字段。
// argumentHint 等四个可选字段只在有值时追加，空数组不占一行。
// size 行写「已读/总字节」，truncated 为真时追加 (truncated) 标记。
function formatHumanCommandInspection(
  inspection: ZCodeCustomCommandInspection,
  options: GlobalOptions,
): string {
  const { metadata } = inspection.command;
  const lines = [
    `Command: /${metadata.name}`,
    `scope/source: ${metadata.scope}/${metadata.source}`,
    `path: ${metadata.path}`,
    `description: ${metadata.description}`,
  ];
  if (metadata.argumentHint) lines.push(`argumentHint: ${metadata.argumentHint}`);
  if (metadata.allowedTools.length > 0) {
    lines.push(`allowedTools: ${metadata.allowedTools.join(", ")}`);
  }
  if (metadata.skills.length > 0) lines.push(`skills: ${metadata.skills.join(", ")}`);
  if (metadata.model) lines.push(`model: ${metadata.model}`);
  lines.push(
    `size: ${inspection.command.bytesRead}/${inspection.command.sizeBytes} bytes${inspection.command.truncated ? " (truncated)" : ""}`,
  );
  if (options.verbose) lines.push("", "Content", inspection.command.content || "(empty)");

  appendDiagnostics(lines, inspection.diagnostics, options);
  return `${lines.join("\n")}\n`;
}

// 描述格式化：非交互专用命令追加 "(interactive only)"，提示该命令不能在 headless 流程中使用。
function formatCommandDescription(command: CustomCommandListItem): string {
  const suffix = command.disableNonInteractive ? " (interactive only)" : "";
  return `${command.description}${suffix}`;
}

// 诊断区追加：非 verbose 或无诊断时直接返回；每条输出 [severity] code: message（有 path 时附路径）。
function appendDiagnostics(
  lines: string[],
  diagnostics: CustomCommandListOutcome["diagnostics"],
  options: GlobalOptions,
): void {
  if (!options.verbose || diagnostics.length === 0) return;
  lines.push("", `Diagnostics (${diagnostics.length})`);
  for (const diagnostic of diagnostics) {
    const location = diagnostic.path ? ` (${diagnostic.path})` : "";
    lines.push(`- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}${location}`);
  }
}

// list 的 JSON 输出：顶层含 commands/cwd/diagnostics/totalDiscovered，序列化交给 core.formatJson
// 以保证统一的缩进与稳定字段顺序；不包含原始正文。
const formatCommandJson = (outcome: CustomCommandListOutcome, cwd: string): string =>
  formatJson({
    commands: outcome.commands.map(formatCommandMetadataJson),
    cwd,
    diagnostics: outcome.diagnostics.map(formatDiagnosticJson),
    totalDiscovered: outcome.totalDiscovered,
  });

// inspect 的 JSON 输出：包含正文与截断信息（bytesRead/sizeBytes/truncated）供调用方判断完整度。
const formatCommandInspectionJson = (
  inspection: ZCodeCustomCommandInspection,
  cwd: string,
): string =>
  formatJson({
    command: {
      bytesRead: inspection.command.bytesRead,
      content: inspection.command.content,
      metadata: formatCommandMetadataJson(inspection.command.metadata),
      sizeBytes: inspection.command.sizeBytes,
      truncated: inspection.command.truncated,
    },
    cwd,
    diagnostics: inspection.diagnostics.map(formatDiagnosticJson),
  });

// 命令 metadata 的 JSON 投影：显式列出稳定字段；argumentHint/model 仅在存在时输出，
// 避免下游把「字段缺失」与「空字符串」混淆。
// 稳定字段逐个列出而不用 spread 展开 command，避免新增字段悄悄进入 JSON。
// argumentHint 与 model 用条件展开，缺失时整个键不出现。
// 列表与详情共用 formatCommandMetadataJson 这一投影，两边输出字段不会漂移。
function formatCommandMetadataJson(command: CustomCommandListItem) {
  return {
    allowedTools: command.allowedTools,
    description: command.description,
    disableNonInteractive: command.disableNonInteractive,
    frontmatterKeys: command.frontmatterKeys,
    name: command.name,
    path: command.path,
    rootPath: command.rootPath,
    scope: command.scope,
    skills: command.skills,
    source: command.source,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.model ? { model: command.model } : {}),
  };
}

// 诊断项 JSON 投影：code/message/severity 必出；commandName/path 仅在有值时出现，
// 保持与人类可读输出同一口径。
function formatDiagnosticJson(diagnostic: CustomCommandListOutcome["diagnostics"][number]) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.commandName ? { commandName: diagnostic.commandName } : {}),
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    severity: diagnostic.severity,
  };
}
