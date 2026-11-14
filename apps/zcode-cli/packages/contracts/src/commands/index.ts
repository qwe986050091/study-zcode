// ============================================================
// Custom Command Contracts - user-defined slash prompt commands
// ============================================================
// 生产方：adapters/src/commands 的 NodeCustomCommandAdapter 扫描各 root（按 priority 升序、
// 先到先得）解析 .md frontmatter；消费方：core 的 slash command 处理器负责发现、读取与展开。
// 该契约只描述“命令元数据 + 原文 + 展开结果”，不承载执行权限：`allowedTools` 是声明性建议，
// 实际工具授权仍由权限层决定；`disableNoninteractive` 只影响非交互入口是否可见。
// 本契约不带命令级幂等键——`sourceCommandId` 位于 bootstrap 的 CommandInbox 与 compact
// timeline，同一 slash 命令的重复提交由 inbox 去重，而不是由这个 Port 保证。
// 所有 path 均为适配器解析后的绝对路径，跨进程消费方不得自行拼接、改写或做平台转换。

import type { HookPluginContext } from "../hooks/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 命令来源的层级：project/user/system/admin。它只描述“这条命令存放在哪一层”，
// 不表达优先级本身——同名命令由哪个 root 胜出，取决于 CustomCommandRoot.priority。
// admin 层通常由托管安装注入，适配器不把它当成用户可写目录处理。
// 消费方据此展示来源，不得用它做权限提升判断。
export type CustomCommandScope = "project" | "user" | "system" | "admin";

// 命令的产出来源：agents（`.agents` 约定目录）、zcode（ZCode 自有目录）、plugin（插件携带）。
// 与 scope 正交：插件命令同样可能落在 project/user 层；命名冲突诊断会同时保留二者便于归因。
// `source` 只用于诊断与展示，不参与查找优先级，也不赋予任何执行权限。
export type CustomCommandSource = "agents" | "zcode" | "plugin";

// 诊断级别：warning 表示跳过单条但整体仍可用；error 表示该命令不可用（名称非法、正文缺失等）。
// 这是稳定判别字段，调用方按 severity 决定是否继续，不得解析 message 文案。
export type CustomCommandDiagnosticSeverity = "warning" | "error";

// 稳定的诊断码，跨进程/日志可长期依赖；message 是给人看的，可能随文案调整。
// `custom_command_duplicate_name` 只是 warning：同名命令在 priority 更高的 root 中先到先得，
// 后到者被丢弃但仍计入 totalDiscovered；其余 error 码表示该命令未进入可用集合。
// `custom_command_unsupported_dynamic_syntax` 对应展开阶段拒绝 `!` 内联/围栏 shell 片段。
export type CustomCommandDiagnosticCode =
  | "custom_command_duplicate_name"
  | "custom_command_invalid_frontmatter"
  | "custom_command_invalid_name"
  | "custom_command_read_failed"
  | "custom_command_root_not_found"
  | "custom_command_scan_failed"
  | "custom_command_too_large"
  | "custom_command_unknown_frontmatter"
  | "custom_command_unsupported_dynamic_syntax";

// 一个待扫描的命令根目录。`priority` 越小越先扫描，同 name 先出现者胜出；适配器发现阶段
// 按升序排序后遍历，因此调整优先级是唯一改变“同名命令归谁”的正式手段。
// `namespace` 会给命令名加上 `<namespace>/` 前缀（适配器统一转小写），仅用于避免附加目录的
// 命名冲突，不是项目身份；`plugin` 保存插件 provenance，供 hook/诊断回溯。
// `path` 必须是绝对路径，且由 root 解析层（adapters/commands/roots）产出，跨平台转换在那一层完成。
export interface CustomCommandRoot {
  /** 附加目录能力的目录限定名；不是项目身份。 */
  namespace?: string;
  path: string;
  plugin?: HookPluginContext;
  scope: CustomCommandScope;
  source: CustomCommandSource;
  priority: number;
}

// 单条命令的发现结果，由适配器解析 frontmatter 得到。`description` 必填（frontmatter 或正文首段），
// 缺失即不进入可用集合；`name` 已归一化（去前导 `/`、小写）并可能带 namespace 前缀，
// 与 `path` 不构成一一对应——namespace 只影响展示与调用名。
// `frontmatterKeys` 保留原始键供诊断；未知键只产生 warning，不影响加载。
// `allowedTools`/`skills` 是声明性的建议与依赖提示，仍需权限层与 Skill 工具二次确认。
// `plugin`/`rootPath`/`scope`/`source` 全部是 provenance，供归因与 UI 展示，不参与执行判定。
export interface CustomCommandMetadata {
  allowedTools: string[];
  argumentHint?: string;
  description: string;
  disableNonInteractive: boolean;
  frontmatterKeys: string[];
  model?: string;
  name: string;
  path: string;
  plugin?: HookPluginContext;
  rootPath: string;
  scope: CustomCommandScope;
  skills: string[];
  source: CustomCommandSource;
}

// 单条诊断。`code`/`severity` 是机器可判别字段，`message` 仅供人读；`path` 与 `commandName`
// 可能缺省（例如 root 级扫描失败时只有 path）。诊断不持久化，随 discover/load 结果一次性返回。
export interface CustomCommandDiagnostic {
  code: CustomCommandDiagnosticCode;
  severity: CustomCommandDiagnosticSeverity;
  message: string;
  path?: string;
  commandName?: string;
}

// 一次发现的结果。`commands` 已按 name 排序，且已剔除同名重复与 config 禁用项；
// `totalDiscovered` 统计“通过解析的候选数”（含因同名被丢弃者），可能大于 commands 长度，
// 不能当作可用命令数。单条命令失败只产出 diagnostic，不中断整体扫描。
export interface CustomCommandLoadOutcome {
  commands: CustomCommandMetadata[];
  diagnostics: CustomCommandDiagnostic[];
  totalDiscovered: number;
}

// `loadCommand` 的返回值：`content` 已剥离 frontmatter 并 trim，正文里的相对路径要基于
// `metadata.path` 所在目录解析；`bytesRead` 是实际读入的字节数（截断时等于 maxBytes），
// `sizeBytes` 是磁盘上的完整大小，`truncated` 由二者比较得出。
// 截断是“只读前 maxBytes 字节”，不是省略中间，调用方不能假设拿到的是完整正文。
export interface CustomCommandContent {
  metadata: CustomCommandMetadata;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

// `roots` 省略时由适配器按 workingDirectory 解析默认根（用户/项目/插件等）；显式传入时必须
// 给绝对路径。`workingDirectory` 决定默认根的位置，必须在调用前解析成绝对路径。
// `trace` 仅用于日志关联，不改变发现结果，也不跨进程持久化。
export interface CustomCommandDiscoverRequest {
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

// 按 name 加载命令；name 会在适配器内归一化（去前导 `/`、小写），因此 `/Foo` 与 `foo` 命中同一条。
// `maxBytes` 用于覆盖缺省截断上限，未提供时由适配器取默认值；`roots` 语义与 discover 相同。
// 未找到时抛 Error 而不是返回空结果；load 会重新执行完整发现，没有缓存，诊断会被重算。
export interface CustomCommandLoadRequest {
  maxBytes?: number;
  name: string;
  roots?: CustomCommandRoot[];
  trace?: TraceContext;
  workingDirectory: string;
}

// 所有命令操作的通用选项：`signal` 在扫描/解析的循环边界检查，用于及时中止；
// `context` 携带执行上下文供日志/追踪，不参与业务判定。
// 中止是协作式的——单次 read/stat 不会被立即打断，调用方不应依赖毫秒级取消。
export interface CustomCommandOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

// 命令端口的唯一契约。`discoverCommands` 返回元数据全集（不含正文），`loadCommand` 返回正文；
// 二者都在发现阶段应用 config 禁用名单与“同名先到先得”规则，保证 discover/load/inspect 口径一致。
// 实现方不得借该端口扩展执行能力；它只读文件，不运行命令、不展开模板。
// 跨进程调用时只能传相对/绝对路径与纯数据，不能传 AbortSignal 等活对象。
export interface CustomCommandPort {
  discoverCommands(
    request: CustomCommandDiscoverRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandLoadOutcome>;
  loadCommand(
    request: CustomCommandLoadRequest,
    options?: CustomCommandOperationOptions,
  ): Promise<CustomCommandContent>;
}

// 展开后的最终 prompt：`prompt` 已带 “Run custom command …”、来源行、所需 Skill 指令与正文；
// `argumentCount` 是按 shell 规则切分后的参数个数；`usedArgumentsPlaceholder` 表示正文里是否
// 出现过 `$ARGUMENTS`/`$n`，为 false 时参数被追加到末尾而非替换。
// 该结果直接进入模型上下文，调用方不应再二次拼接命令名或参数。
export interface CustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

// 仅做模板替换的中间结果：`body` 不含命令包装头与 Skill 指令，供需要自行组装的调用方使用；
// `argumentCount`/`usedArgumentsPlaceholder` 与 Expansion 口径一致。`$n` 越界替换为空串，
// 不保留字面量，也不报错；此处不做任何动态 shell 展开。
export interface CustomCommandTemplateExpansion {
  argumentCount: number;
  body: string;
  usedArgumentsPlaceholder: boolean;
}

const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;
const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;

// 展开命令正文并组装成最终 prompt。若正文含 `!` 内联或 ```! 围栏的动态 shell 语法，
// 这里 fail-closed 抛 Error（动态展开尚未实现），不会把可执行片段交给模型；
// 抛的是普通 Error 而非 CoreError，调用方需按“命令执行失败”处理而不是当作可恢复业务错误。
export function expandCustomCommandPrompt(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandExpansion {
  const expanded = expandCustomCommandTemplate(input);
  const dynamicSyntax = detectUnsupportedDynamicSyntax(expanded.body);
  if (dynamicSyntax) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported ${dynamicSyntax} expansion. Dynamic expansion is not available yet.`,
    );
  }

  return formatCustomCommandPrompt({
    body: expanded.body,
    command: input.command,
    argumentCount: expanded.argumentCount,
    usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
  });
}

// 先替换 `$ARGUMENTS`（全部出现位置），再按 `$1..$n` 做位置替换；参数由
// `splitCustomCommandArguments` 按引号/转义规则切分。正文未引用任何占位符但调用时带了参数时，
// 参数会以 "\n\nUser arguments:\n" 形式追加到末尾，避免用户输入被静默丢弃。
// `$0` 会因位置越界被替换为空串；这里不做变量转义或递归展开。
export function expandCustomCommandTemplate(input: {
  args: string;
  command: CustomCommandContent;
}): CustomCommandTemplateExpansion {
  const args = input.args.trim();
  const positional = splitCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    const offset = Number(index) - 1;
    return positional[offset] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    body,
    usedArgumentsPlaceholder,
  };
}

// 把已替换好的正文包装成模型可读的 prompt：首行固定 “Run custom command /<name>”，
// 第二行写 `scope/source` 便于模型与日志归因；若 metadata.skills 非空，会插入“必须先调用
// Skill 工具”的指令。正文再做一次 trim，因此开头/结尾空行不会进入 prompt。
export function formatCustomCommandPrompt(input: {
  argumentCount: number;
  body: string;
  command: CustomCommandContent;
  usedArgumentsPlaceholder: boolean;
}): CustomCommandExpansion {
  return {
    argumentCount: input.argumentCount,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      input.body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder: input.usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

// 按类 shell 规则切分参数：空白分隔，支持单/双引号包裹与反斜杠转义；引号内空白不切分，
// 引号本身不进入结果。末尾悬空的反斜杠按字面反斜杠保留。不做 glob、变量展开或命令替换，
// 因此 `$HOME`、`*` 不会被当作已展开的值——参数保持用户原文。
export function splitCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

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
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
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

// 检测命令正文是否含当前不支持的动态 shell 展开：内联 `!`…`` 或 ```! 围栏代码块。
// 命中返回 "shell"，调用方据此拒绝执行；这是当前唯一的返回值，新增语法需同步扩展返回类型。
// 该检测只看语法形态，不判断片段是否真的可执行，也不处理转义后的伪匹配。
export function detectUnsupportedDynamicSyntax(content: string): "shell" | undefined {
  if (INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content)) {
    return "shell";
  }
  return undefined;
}
