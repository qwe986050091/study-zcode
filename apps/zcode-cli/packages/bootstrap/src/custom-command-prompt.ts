// 自定义斜杠命令（用户/项目/插件 commands 目录下的 .md）的解析入口。
//
// 与内置命令的边界：保留名（含 /init、/workflow 等）在这里直接返回 undefined，内置命令
// 必须先由 builtin-prompt-command.ts 展开；否则同名自定义文件就能绕过内置语义与灰度门。
// 只有「命令不存在」被吞成 undefined；权限/读取/展开等其它错误一律上抛，避免静默失效。
import {
  expandCustomCommandPrompt,
  expandCustomCommandTemplate,
  formatCustomCommandPrompt,
  type ExecutionPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  loadZCodeCustomCommand,
  type ListZCodeCustomCommandsOptions,
} from "./custom-commands.js";
import { expandCustomCommandShellSyntax } from "./custom-command-shell-expansion.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export interface ResolveZCodeCustomCommandPromptOptions extends ListZCodeCustomCommandsOptions {
  executionPort?: ExecutionPort;
  sessionId?: SessionId;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

/**
 * 把 `/name args...` 解析成最终 prompt，未命中返回 undefined。
 *
 * 两条展开路径：
 * 1. 提供 executionPort 时：先 template 展开（不触发 `!` 不支持错误），再执行 shell 片段，
 *    最后 format——顺序不能换成 expandCustomCommandPrompt，否则 `!` 语法会在 turn 创建前抛错；
 * 2. 未提供 executionPort 时：直接 expandCustomCommandPrompt，`!` 语法按契约报不支持。
 *
 * 失败语义：仅在消息匹配 "not found" 时视为命令不存在；其余错误原样抛出，
 * 由命令调度层决定是提示用户还是中断。
 */
export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ResolveZCodeCustomCommandPromptOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // 保留名（含内置 `workflow`）在这里直接返回 undefined，与「命令不存在」同形：内置命令由
  // builtin-prompt-command.ts 先行展开，这里拒绝的是借同名自定义命令绕过内置语义（或灰度门）的路径。
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    if (options.executionPort) {
      // 调用 slash command 时先执行并替换输出，避免 unsupported error
      // 在 turn 创建前抛出后让 UI 长时间停在“正在思考”。
      //
      // 复用 contracts 的底层 template/format 函数，而非 expandCustomCommandPrompt：
      // 后者内部 detectUnsupportedDynamicSyntax 会对 `!` 语法直接抛错，而本路径
      // 恰恰要支持 shell 展开，只能在 expandCustomCommandTemplate 与
      // formatCustomCommandPrompt 之间插入 expandCustomCommandShellSyntax。
      const expanded = expandCustomCommandTemplate({
        args: invocation.args,
        command,
      });
      const body = await expandCustomCommandShellSyntax({
        command,
        content: expanded.body,
        executionPort: options.executionPort,
        sessionId: options.sessionId,
        signal: options.signal,
        traceContext: options.traceContext,
        workingDirectory: options.workingDirectory ?? process.cwd(),
      });
      return formatCustomCommandPrompt({
        argumentCount: expanded.argumentCount,
        body,
        command,
        usedArgumentsPlaceholder: expanded.usedArgumentsPlaceholder,
      }).prompt;
    }
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

// 与内置命令共用同一形态：首 token 为命令名（小写化），其余为参数（trim 但保留换行）。
// 只识别带参数的裸文本输入，不解析 shell 转义——转义交给后续展开器。
function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
