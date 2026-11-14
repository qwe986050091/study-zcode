// 展开所需的最小命令内容契约：只依赖正文与 metadata 的 name/scope/source/skills，
// 不耦合 bootstrap 的完整 inspection 类型，便于单测构造最小输入。
interface CliCustomCommandContent {
  content: string;
  metadata: {
    name: string;
    scope: string;
    skills?: string[];
    source: string;
  };
}

// 展开结果：argumentCount 为解析出的位置参数个数（引号内空白不计数）；
// prompt 为最终交给模型的多段文本；usedArgumentsPlaceholder 表示正文是否消费了参数占位符。
interface CliCustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

// 全量参数占位符：正文出现时整体替换为原始参数串。
const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
// 不支持的动态 shell 形态：```! ... ``` 块与 !`...` 内联，命中即拒绝执行（防止隐式运行命令）。
const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
// 位置参数占位符：$1/$2...，1 基索引，越界替换为空串。
const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;

// 展开自定义命令正文为最终 prompt：替换 $ARGUMENTS 与 $1/$2 占位符；
// 若正文未消费参数但用户传了参数，则把参数追加到末尾（避免静默丢弃输入）。
// 失败语义：正文含动态 shell 时抛错（当前不支持），不降级执行；无参数时不做追加。
export function expandCliCustomCommandPrompt(input: {
  args: string;
  command: CliCustomCommandContent;
}): CliCustomCommandExpansion {
  if (usesUnsupportedDynamicShell(input.command.content)) {
    // 动态 shell 展开尚未实现：宁可显式失败，也不把原文（含命令）当普通文本发给模型。
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported shell expansion. Dynamic expansion is not available yet.`,
    );
  }

  const args = input.args.trim();
  const positional = splitCliCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    return positional[Number(index) - 1] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    // 用户传了参数但模板没写占位符：显式追加，避免输入被静默丢弃。
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder,
  };
}

// 生成技能前置指令：列出需先加载的技能名，并明确要求先调用 Skill 工具再执行正文；
// 无技能时返回空数组（不产生空行）。
function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

// 解析命令参数为位置参数数组：支持单/双引号包裹、反斜杠转义；引号内空白不切分，
// 空段丢弃；结尾悬空反斜杠按字面量保留，避免吞字符。
function splitCliCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let escaping = false;
  let quote: "'" | '"' | null = null;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

// 检测不支持的动态 shell 语法（内联或围栏），命中任一种即认为需要拒绝展开。
function usesUnsupportedDynamicShell(content: string): boolean {
  return INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content);
}
