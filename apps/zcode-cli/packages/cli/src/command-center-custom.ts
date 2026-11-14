import type { TuiSlashCommandSuggestion } from "@zcode/tui";
import { expandCliCustomCommandPrompt } from "./custom-command-expand.js";

// 只把「模板不存在」识别为可降级信号；loader 抛出的其他错误（IO/权限/模板语法）继续向上抛，
// 避免真实故障被静默当作未知命令。
const customCommandNotFoundPattern = /not found/i;

// 自定义命令发现结果：commands 为可用项；diagnostics 为解析告警（结构由 bootstrap 定义，原样透传）；
// totalDiscovered 为发现总数，含因重名/禁用未进入 commands 的项。
export type CommandCenterCustomCommandListOutcome = {
  commands: CommandCenterCustomCommand[];
  diagnostics: unknown[];
  totalDiscovered: number;
};

// 自定义命令元数据：name 不含前导斜杠；path 为源文件绝对路径，rootPath 为所属命令根目录（可空）；
// scope/source 共同描述作用域与来源（如 project/workspace）；allowedTools/skills/model 来自 frontmatter，
// 缺省即 undefined（不表示空数组）；frontmatterKeys 仅用于诊断展示。
export type CommandCenterCustomCommand = {
  allowedTools?: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive?: boolean;
  frontmatterKeys?: string[];
  model?: string;
  name: string;
  path: string;
  rootPath?: string;
  scope: string;
  skills?: string[];
  source: string;
};

// 命令内容快照：content 可能被截断；bytesRead 为实际读取字节数，sizeBytes 为文件总大小（字节），
// truncated 为 true 表示 content 不完整；metadata 与列表项同一口径。
export type CommandCenterCustomCommandContent = {
  bytesRead?: number;
  content: string;
  metadata: CommandCenterCustomCommand;
  sizeBytes?: number;
  truncated?: boolean;
};

// 依赖注入：listCustomCommands 服务于帮助/补全，loadCustomCommand 服务于展开执行；
// 两者均可缺省，缺省时对应能力降级为「不可用」而非报错。
interface CommandCenterCustomCommandDeps {
  listCustomCommands?: () => Promise<CommandCenterCustomCommandListOutcome>;
  loadCustomCommand?: (name: string) => Promise<CommandCenterCustomCommandContent>;
}

// 把自定义命令映射为 slash 补全项：usage 带 argumentHint（若有），summary 附带作用域/来源。
// customCommands 为 undefined 时返回空数组（不是 null），调用方可直接展开。
export function listCustomCommandSuggestions(
  customCommands?: CommandCenterCustomCommandListOutcome,
): TuiSlashCommandSuggestion[] {
  return (customCommands?.commands ?? []).map((command) => ({
    name: command.name,
    summary: `${command.description} (${command.scope}/${command.source})`,
    usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
  }));
}

// 按命令名精确查找帮助项；无列表或未命中时返回 undefined（不是抛错）。
export function findCustomCommandHelpEntry(
  name: string,
  customCommands?: CommandCenterCustomCommandListOutcome,
): CommandCenterCustomCommand | undefined {
  return customCommands?.commands.find((command) => command.name === name);
}

// 输出单条命令帮助文本：首行 usage（含 argumentHint）、描述、来源、文件路径，各占一行。
export function formatCustomCommandHelpEntry(command: CommandCenterCustomCommand): string {
  return [
    `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    command.description,
    `Source: ${command.scope}/${command.source}`,
    `Path: ${command.path}`,
  ].join("\n");
}

// 合并内置命令与自定义命令为逗号分隔串；自定义命令补前导 "/"。无自定义时只列内置，返回非空字符串。
export function formatAvailableCommandNames(
  builtInCommands: readonly string[],
  customCommands?: CommandCenterCustomCommandListOutcome,
): string {
  const names = [
    ...builtInCommands,
    ...(customCommands?.commands.map((command) => `/${command.name}`) ?? []),
  ];
  return names.join(", ");
}

// 读取并展开自定义命令为最终 prompt；未注入 loader 或命令不存在时返回 undefined，
// 其他错误继续抛出，保证调用方能区分「不存在」与「执行失败」。
export async function buildCustomCommandPrompt(
  name: string,
  args: string,
  deps: CommandCenterCustomCommandDeps,
): Promise<string | undefined> {
  if (!deps.loadCustomCommand) return undefined;

  try {
    const command = await deps.loadCustomCommand(name);
    return expandCliCustomCommandPrompt({ args, command }).prompt;
  } catch (error) {
    // 「not found」按契约降级为 undefined，让未知命令/帮助流程继续；其余错误原样向上抛。
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

// 尽力获取命令列表供帮助展示：未注入返回 undefined；列表失败也返回 undefined，
// 因为帮助文本不应因发现阶段故障而整体失败。
export async function listCustomCommandsForHelp(
  deps: CommandCenterCustomCommandDeps,
): Promise<CommandCenterCustomCommandListOutcome | undefined> {
  if (!deps.listCustomCommands) return undefined;
  try {
    return await deps.listCustomCommands();
  } catch {
    return undefined;
  }
}
