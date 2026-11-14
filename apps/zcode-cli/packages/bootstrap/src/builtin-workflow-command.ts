import { expandCustomCommandPrompt, type CustomCommandContent } from "@zcode/contracts";
import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "./app/bundled-skills.js";

/**
 * 内置 `/workflow` 命令（docs/dynamic-workflow/authoring.md「The `/workflow` command and the skill」）。
 *
 * 它曾是 zcode-guide 内置插件的 `commands/workflow.md`：插件一被卸载/停用，命令与加号菜单入口一起消失，
 * 而十个工作流工具仍在（2026-09-19 事故）。现在命令正文随 CLI 编译，与 `/init` 同为代码定义的
 * prompt 型内置命令；名字进入保留字表，用户或插件同名命令不再被展开。
 *
 * 正文刻意复用 contracts 的 custom command 展开（$ARGUMENTS 替换 + `skills:` 前言），
 * 让模型看到的提示词与插件时代逐字同形，不重新调教。
 */
export const BUILTIN_WORKFLOW_COMMAND_NAME = "workflow";

const helpEntry = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find(
  (entry) => entry.name === BUILTIN_WORKFLOW_COMMAND_NAME,
);
if (!helpEntry) {
  // 共享 help 表是保留字、TUI 候选与 App 目录的唯一来源；条目缺席时命令根本不可寻址。
  throw new Error(`Missing builtin slash command help entry: ${BUILTIN_WORKFLOW_COMMAND_NAME}`);
}

const USAGE_PREFIX = `/${BUILTIN_WORKFLOW_COMMAND_NAME} `;
export const BUILTIN_WORKFLOW_COMMAND_DESCRIPTION = helpEntry.summary;
export const BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT = helpEntry.usage.startsWith(USAGE_PREFIX)
  ? helpEntry.usage.slice(USAGE_PREFIX.length)
  : "";

/** `$ARGUMENTS` 必须在场：否则展开会把参数追加成位置不受控的 "User arguments:" 尾块。 */
const BUILTIN_WORKFLOW_COMMAND_BODY = [
  `Use the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill to design and launch a dynamic workflow for this request:`,
  "",
  "$ARGUMENTS",
  "",
  "Decide the subagent topology before writing any code: how many subagents, which of them",
  "share a context, what result each one returns. Then write the script and call the",
  "`CreateWorkflow` tool. (`CreateWorkflow` is the dynamic-workflow tool. Do not use the",
  "legacy `Workflow` tool, and do not substitute the `Agent` tool.)",
  "",
].join("\n");

/**
 * 内置 /workflow 命令的静态内容对象（与从磁盘加载的 CustomCommandContent 同形）。
 *
 * 字段口径：
 * - scope=system / source=zcode / path=builtin:workflow：表明不是用户或插件文件，
 *   目录展示与优先级判断依赖这组值；
 * - metadata.skills 指向动态工作流 skill，展开时生成 `skills:` 前言；
 * - bytesRead/sizeBytes/truncated 是读取契约字段，内置内容视为完整读取；
 * - allowedTools=[] 表示不额外限制工具，仍走全局权限。
 */
export const BUILTIN_WORKFLOW_COMMAND: CustomCommandContent = {
  bytesRead: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  content: BUILTIN_WORKFLOW_COMMAND_BODY,
  metadata: {
    allowedTools: [],
    argumentHint: BUILTIN_WORKFLOW_COMMAND_ARGUMENT_HINT,
    description: BUILTIN_WORKFLOW_COMMAND_DESCRIPTION,
    disableNonInteractive: false,
    frontmatterKeys: ["description", "argument-hint", "skills"],
    name: BUILTIN_WORKFLOW_COMMAND_NAME,
    path: `builtin:${BUILTIN_WORKFLOW_COMMAND_NAME}`,
    rootPath: "builtin:",
    scope: "system",
    skills: [DYNAMIC_WORKFLOW_SKILL_NAME],
    source: "zcode",
  },
  sizeBytes: Buffer.byteLength(BUILTIN_WORKFLOW_COMMAND_BODY),
  truncated: false,
};

/**
 * 用与自定义命令完全相同的展开器生成提示词：$ARGUMENTS 原位替换 + skills 前言，
 * 保证与插件时代逐字同形；args 为空时也保留 $ARGUMENTS 的展开位置，不追加额外尾块。
 */
export function expandBuiltinWorkflowCommandPrompt(args: string): string {
  return expandCustomCommandPrompt({ args, command: BUILTIN_WORKFLOW_COMMAND }).prompt;
}
