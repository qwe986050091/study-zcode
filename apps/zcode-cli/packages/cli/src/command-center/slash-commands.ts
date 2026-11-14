// slash 命令面：把一行原始输入解析成 SlashCommand，并向 TUI/CLI 提供命令建议、/help 文案与未知命令提示。
// 单点职责：命令名大小写归一、别名到规范名折叠、参数切分都发生在这里，下游只认 SlashCommand.name。
// 本文件不执行命令、不决定退出码；只产出结构化结果与可直接打印的文案，回显与退出由调用方掌握。
// 可见集合由 workflowMode 门控，保证 TUI 补全、/help、未知提示三处看到同一批命令。
//
// INV-01 匹配命令名前统一 toLowerCase，因此 /Help 与 /HELP 都落到 help；守住位置：parseSlashCommand 的 rawName；改错故障：大小写变体被判未知，用户拿到误导性的可用列表。
// INV-02 别名只在解析层折叠成规范 name，rawName 保留用户原样输入；守住位置：各 known 分支的 name/rawName 赋值；改错故障：回显篡改用户输入，脚本按输出断言会失败。
// INV-03 别名与规范名不得跨命令复用；守住位置：parseSlashCommand 的 if 链顺序；改错故障：先命中的分支吞掉输入，用户以为执行了 A 实际执行 B。
// INV-04 args 只取命令名之后的原文并 trim，不参与命令名匹配；守住位置：commandEnd 切分；改错故障：带参数的命令（如 /skill foo）被判未知。
// INV-05 空输入或无斜杠输入返回 null 而非 unknown；守住位置：parseSlashCommand 首行；改错故障：普通对话文本被当未知命令，每条消息都回显报错。
// INV-06 只认前导斜杠；行内出现斜杠不影响判定；守住位置：startsWith 检查；改错故障：路径或正则被误当成命令。
// INV-07 命令名后允许跟空白（/help 加两个空格合法），trim 只在切分前做一次；守住位置：trimmed/commandEnd；改错故障：尾随空格让命令落到 unknown。
// INV-08 未知命令一律返回 type=unknown 并保留 rawName 与 args；守住位置：parseSlashCommand 末尾；改错故障：自定义命令注册表匹配不到，用户自定义斜杠命令全部失效。
// INV-09 skill 分支的空技能名表示“只加载技能”，与缺省 task 区分；守住位置：parseSkillCommandArgs 的 null 分支；改错故障：下游把空串当有效技能名调用 Skill 工具，必然失败。
// INV-10 可见集合必须与 builtin resolver 对 /workflow 的展开保持一致；守住位置：visibleHelpEntries；改错故障：补全里出现执行时被拒的命令。
// INV-11 workflowMode 缺席视为不设门，保持单测与嵌入方行为不变；守住位置：SlashCommandSurfaceOptions；改错故障：未传选项的调用方莫名丢失 /workflow。
// INV-12 建议列表的前缀必须带斜杠；守住位置：listAvailableCommandNames；改错故障：TUI 插入的命令缺斜杠，被当普通文本发送。
// INV-13 内置命令与自定义命令可能重名，内置优先；守住位置：listSlashCommandSuggestions 的展开顺序；改错故障：自定义条目盖住内置语义，用户再也访问不到内置命令。
// INV-14 帮助查找顺序为内置先于自定义；守住位置：formatSlashCommandHelp 的 target 分支；改错故障：同名时展示自定义文档，与真实执行路径不符。
// INV-15 未知帮助目标不得抛错，只返回可打印文案；守住位置：formatSlashCommandHelp 的兜底返回；改错故障：/help 拼错导致进程异常退出。
// INV-16 帮助目标的斜杠前缀与大小写都必须归一；守住位置：normalizeHelpTarget；改错故障：/help /Help 查不到条目，退回未知提示。
// INV-17 帮助条目按 name 或 aliases 命中，二者来自共享表；守住位置：findSlashCommandHelpEntry；改错故障：别名能执行但 /help 别名查不到说明。
// INV-18 摘要行必须复用 entry.usage，禁止在本文件重新拼参数签名；守住位置：formatSlashCommandHelp 的列表分支；改错故障：帮助与实际用法长期漂移。
// INV-19 手工技能提示必须显式要求先调用 Skill 工具；守住位置：buildManualSkillPrompt；改错故障：模型不加载技能正文，凭空作答。
import type { DynamicWorkflowMode } from "@zcode/shared";
import type { TuiSlashCommandSuggestion } from "@zcode/tui";
import {
  findCustomCommandHelpEntry,
  formatAvailableCommandNames,
  formatCustomCommandHelpEntry,
  listCustomCommandSuggestions,
  type CommandCenterCustomCommandListOutcome,
} from "../command-center-custom.js";
import { SLASH_COMMAND_HELP_ENTRIES, type SlashCommandHelpEntry } from "./slash-command-help.js";
import type { SlashCommand } from "./slash-command-types.js";
import { splitArgs } from "./utils.js";
import { isWorkflowModeEnabled } from "../workflow-mode.js";

// workflow 命令名只在这里定义一次：可见集合的过滤与测试断言都引用同一常量，
// 避免某处写成带斜杠的形式后，过滤条件静默失效。
const WORKFLOW_COMMAND_NAME = "workflow";

// 选项整体可选是契约的一部分：缺省表示“不设 workflow 门”，让单测与嵌入方能直接调用命令面，
// 而不必构造一个假的 DynamicWorkflowMode。
export type SlashCommandSurfaceOptions = {
  /** 缺席不设门（单测、嵌入方）；CLI 入口总会传入解析后的 `--workflow-mode`。 */
  workflowMode?: DynamicWorkflowMode;
};

/**
 * 命令面（建议、`/help`、未知命令提示）共用的可见集合：`disabled` 下去掉 `/workflow`，
 * 与 builtin resolver 不展开它是同一个结论（launch.md「The standalone CLI: `--workflow-mode`」）。
 */
// 建议、/help、未知提示三处入口都必须经过本函数，而不是各自过滤一遍；
// 一旦某处绕过，就会出现“补全里有、执行时报未知”的不一致。
// [权衡] 每次调用现算并重建数组：表规模只有几十条，换取无需缓存失效逻辑。
function visibleHelpEntries(
  options?: SlashCommandSurfaceOptions,
): readonly SlashCommandHelpEntry[] {
  // 判定委托给 isWorkflowModeEnabled 而非比较字面量，新增模式在共享层落地后这里自动跟随。
  // [失败路径] options 为 undefined 时走 undefined 分支，语义是“不设门”，不是“关闭”。
  return isWorkflowModeEnabled(options?.workflowMode)
    ? SLASH_COMMAND_HELP_ENTRIES
    : SLASH_COMMAND_HELP_ENTRIES.filter((entry) => entry.name !== WORKFLOW_COMMAND_NAME);
}

// 返回带前导斜杠的完整命令名，供 TUI 直接插入输入框；不带斜杠会让补全结果被当普通文本发送。
// 自定义命令不在此列，由 formatAvailableCommandNames 在提示文案里补齐。
export function listAvailableCommandNames(options?: SlashCommandSurfaceOptions): string[] {
  return visibleHelpEntries(options).map((entry) => `/${entry.name}`);
}

// 用法串单独抽常量：帮助文本、参数错误回显与测试断言共用一份，避免三处漂移。
// 方括号表示可选段：无参数时 skillName 为空串，由调用方决定回显用法还是进入选择流程。
const SKILL_COMMAND_USAGE = "Usage: /skill [<skill-name> [task]]";

// 纯函数：不做 I/O、不查自定义命令、不判断开关，只把文本折成判别联合，
// 因此 headless 入口、TUI 与单测能以完全相同的方式调用。
export function parseSlashCommand(input: string): SlashCommand | null {
  // [失败路径] 非斜杠输入返回 null 而不是 unknown：调用方据此走普通对话路径，
  // 否则每一句普通文本都会被当成未知命令并回显可用列表。
  if (!input.startsWith("/")) return null;

  const trimmed = input.trim();
  // 以第一个空白为界切出命令名；search 返回 -1 表示整行都是命令名，
  // 此时 args 必须是空串而不是 undefined，保证下游可直接 trim 与判空。
  const commandEnd = trimmed.search(/\s/);
  // 先截断再 toLowerCase，顺序不能反：先切分才能保证大小写归一只作用于名字、
  // 不误伤参数里的路径或技能名。
  // 前导斜杠已由 startsWith 保证存在，slice(1) 不会丢字符。
  const rawName = (
    commandEnd === -1 ? trimmed.slice(1) : trimmed.slice(1, commandEnd)
  ).toLowerCase();
  const args = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();

  if (rawName === "compact") {
    return {
      args,
      name: "compact",
      rawName,
      type: "known",
    };
  }

  if (rawName === "expert") {
    return {
      args,
      name: "expert",
      rawName,
      type: "known",
    };
  }

  // variant 是 effort 的别名：历史入口保留，但规范名统一为 effort，
  // 下游只需处理一种 name，不必在每个分支里重复两种写法。
  if (rawName === "effort" || rawName === "variant") {
    return {
      args,
      name: "effort",
      rawName,
      type: "known",
    };
  }

  if (rawName === "dwf") {
    return {
      args,
      name: "dwf",
      rawName,
      type: "known",
    };
  }

  if (rawName === "fork") {
    return {
      args,
      name: "fork",
      rawName,
      type: "known",
    };
  }

  // help 的参数解释在 formatSlashCommandHelp：名字在解析层定，目标查找在帮助层做，
  // 两处必须共用 visibleHelpEntries，否则关闭 workflow 后帮助仍会列出它。
  if (rawName === "help") {
    return {
      args,
      name: "help",
      rawName,
      type: "known",
    };
  }

  if (rawName === "init") {
    return {
      args,
      name: "init",
      rawName,
      type: "known",
    };
  }

  // `/workflow` 与 `/init` 同为 bootstrap 展开的内置 prompt 命令：这里只识别名字，
  // 正文由 builtin-prompt-command.ts 生成；headless 下按 known 且非 expert/goal 走普通 prompt 路径。
  // [权衡] 即使 workflowMode 关闭也解析成 known，而不是直接 unknown：
  // 解析层不掌握开关状态，拒绝的责任留给执行层，报错信息才准确。
  if (rawName === "workflow") {
    return {
      args,
      name: "workflow",
      rawName,
      type: "known",
    };
  }

  if (rawName === "login") {
    return {
      args,
      name: "login",
      rawName,
      type: "known",
    };
  }

  if (rawName === "logout") {
    return {
      args,
      name: "logout",
      rawName,
      type: "known",
    };
  }

  // language 折叠到 locale，避免“显示语言”存在两个执行路径；
  // rawName 仍保留用户写法，回显与日志能看出原始意图。
  if (rawName === "locale" || rawName === "language") {
    return {
      args,
      name: "locale",
      rawName,
      type: "known",
    };
  }

  // continue 是 resume 的别名：两者语义都是续接最近会话，
  // 分发只认 resume，防止下游长期维护两套续接逻辑。
  if (rawName === "resume" || rawName === "continue") {
    return {
      args,
      name: "resume",
      rawName,
      type: "known",
    };
  }

  // clear 折叠到 new：清空上下文的唯一动作是新建会话，
  // 若各留一条路径，状态重置时机与退出码容易分叉。
  if (rawName === "new" || rawName === "clear") {
    return {
      args,
      name: "new",
      rawName,
      type: "known",
    };
  }

  if (rawName === "rewind") {
    return {
      args,
      name: "rewind",
      rawName,
      type: "known",
    };
  }

  if (rawName === "mode") {
    return {
      args,
      name: "mode",
      rawName,
      type: "known",
    };
  }

  if (rawName === "mcp") {
    return {
      args,
      name: "mcp",
      rawName,
      type: "known",
    };
  }

  if (rawName === "plugins" || rawName === "plugin") {
    return {
      args,
      name: "plugins",
      rawName,
      type: "known",
    };
  }

  if (rawName === "model") {
    return {
      args,
      name: "model",
      rawName,
      type: "known",
    };
  }

  if (rawName === "goal" || rawName === "target") {
    return {
      args,
      name: "goal",
      rawName,
      type: "known",
    };
  }

  // skill 是唯一需要二次解析的参数化命令：解析失败仍返回 known，
  // 让执行层统一走“空技能名就回显用法”，而不是在这里抛错中断整条输入。
  if (rawName === "skill") {
    // [失败路径] parsed 为 null 只表示没给技能名，不是语法错误；
    // 用空串占位保持 SlashCommand 形状稳定，下游无需再做可选链。
    const parsed = parseSkillCommandArgs(args);
    if (!parsed) {
      return {
        args,
        name: "skill",
        rawName,
        skillName: "",
        task: "",
        type: "known",
      };
    }
    return {
      args,
      name: "skill",
      rawName,
      skillName: parsed.skillName,
      task: parsed.task,
      type: "known",
    };
  }

  // 兜底返回 unknown 并原样带回 rawName 与 args：自定义命令注册表靠 rawName 匹配，
  // args 透传后由自定义命令自行解析；解析层不做纠错猜测，避免把拼错的名字悄悄改掉。
  return {
    args,
    rawName,
    type: "unknown",
  };
}

// 手工 /skill 走先加载技能、再执行任务的两段式：提示里必须显式点名 Skill 工具与技能名，
// 否则模型可能跳过加载、直接按技能名猜测作答。
export function buildManualSkillPrompt(skillName: string, task: string): string {
  const trimmedTask = task.trim();
  // 任务块只在有内容时加 User request 前缀；空任务给一句明确占位，
  // 防止模型把缺失的任务段当成上下文被截断而反复追问。
  const taskBlock =
    trimmedTask.length > 0
      ? `User request:\n${trimmedTask}`
      : "No additional user request was provided. Load the skill and respond according to its instructions.";

  return [
    `Use the skill named \`${skillName}\` for this turn.`,
    `First call the \`Skill\` tool with name \`${skillName}\` before doing the task.`,
    "After the skill content is loaded, follow its instructions and continue.",
    "",
    taskBlock,
  ].join("\n");
}

export function manualSkillCommandUsage(): string {
  return SKILL_COMMAND_USAGE;
}

// 建议列表 = 可见内置命令 + 自定义命令，顺序即展示顺序：内置在前，
// 保证同名时用户先看到并优先选中内置命令。
export function listSlashCommandSuggestions(
  customCommands?: CommandCenterCustomCommandListOutcome,
  options?: SlashCommandSurfaceOptions,
): TuiSlashCommandSuggestion[] {
  return [
    ...visibleHelpEntries(options).map((entry) => ({
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      name: entry.name,
      summary: entry.summary,
      usage: entry.usage,
    })),
    // 自定义命令整体追加在末尾，不参与排序或去重：注册表已按加载顺序排好，
    // 在这里再排会让补全顺序随会话变化。
    ...listCustomCommandSuggestions(customCommands),
  ];
}

// 帮助有两种形态：带目标出单条详情，不带目标出全量列表，两者共用同一份 entries，
// 保证列表里出现的命令一定能查到详情；返回值是可直接打印的字符串，不参与退出码判定。
export function formatSlashCommandHelp(
  args = "",
  customCommands?: CommandCenterCustomCommandListOutcome,
  options?: SlashCommandSurfaceOptions,
): string {
  const entries = visibleHelpEntries(options);
  // target 为空等价于“没给目标”，此时走全量列表；归一逻辑集中在 normalizeHelpTarget，
  // 把多余斜杠与大小写差异挡在查表之前。
  const target = normalizeHelpTarget(args);
  if (target) {
    const entry = findSlashCommandHelpEntry(entries, target);
    if (entry) return formatSlashCommandHelpEntry(entry);

    const custom = findCustomCommandHelpEntry(target, customCommands);
    if (custom) return formatCustomCommandHelpEntry(custom);

    // [失败路径] 未命中任何条目时给出未知命令加可用清单，而不是静默返回空串：
    // 用户至少能拿到正确拼写，CLI 也能据此把退出码置为非零。
    // 「未知命令」清单由 listAvailableCommandNames 与 customCommands 同源拼出，避免漏掉自定义命令。
    return `Unknown slash command: /${target}. Available commands: ${formatAvailableCommandNames(listAvailableCommandNames(options), customCommands)}.`;
  }

  const lines = [
    "Slash commands:",
    ...entries.map((entry) => `- ${entry.usage}: ${entry.summary}`),
  ];
  // 自定义命令段只在真的存在时追加，避免空标题占位；
  // 段首空行必须保留，否则标题会与上一条列表黏成连续文本。
  if (customCommands && customCommands.commands.length > 0) {
    lines.push(
      "",
      "Custom commands:",
      ...customCommands.commands.map(
        (command) =>
          `- /${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}: ${command.description}`,
      ),
    );
  }
  lines.push("", "Use /help <command> for details.");
  return lines.join("\n");
}

// 帮助目标先按空白取第一个 token，再剥掉可能重复的斜杠，因此两种写法都能用：
// 带斜杠的 /help /help 与不带斜杠的 /help help。
function normalizeHelpTarget(args: string): string | undefined {
  const [target] = splitArgs(args);
  const normalized = target?.replace(/^\/+/, "").toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

// name 与 aliases 用同一优先级匹配：别名在帮助里必须和规范名一样可查，
// 否则用户从补全看到 /variant，却查不到任何说明。
function findSlashCommandHelpEntry(
  entries: readonly SlashCommandHelpEntry[],
  name: string,
): SlashCommandHelpEntry | undefined {
  return entries.find((entry) => entry.name === name || entry.aliases?.includes(name));
}

function formatSlashCommandHelpEntry(entry: SlashCommandHelpEntry): string {
  // aliasLine 只在 entry.aliases 非空时加入并统一加斜杠前缀，与列表和补全保持同一展示形态；
  // [权衡] 不排序也不去重：别名数量固定且由共享表维护，运行期排序反而让输出不稳定。
  const aliasLine =
    entry.aliases && entry.aliases.length > 0
      ? [`Aliases: ${entry.aliases.map((alias) => `/${alias}`).join(", ")}`]
      : [];
  return [entry.usage, entry.summary, ...aliasLine, ...entry.details].join("\n");
}

// 只按第一个空白切分：技能名不允许含空格，剩余全部视为任务原文，
// 这样任务里的引号、换行与中文标点都不需要转义或二次解析。
// 返回 null 而不是空对象，让调用方区分“没写技能名”与“技能名为空串”。
function parseSkillCommandArgs(args: string): { skillName: string; task: string } | null {
  const trimmed = args.trim();
  if (trimmed.length === 0) return null;
  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace === -1) {
    return {
      skillName: trimmed,
      task: "",
    };
  }
  return {
    skillName: trimmed.slice(0, firstWhitespace),
    task: trimmed.slice(firstWhitespace + 1).trim(),
  };
}
