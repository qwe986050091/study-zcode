import type { TuiPromptInput } from "@zcode/tui";
import type { SlashCommand } from "./slash-command-types.js";
import type { CommandCenterDeps } from "./types.js";

// 识别「通过命令行参数携带 API key」的 /login 形式，用于避免把密钥写入可回放的历史记录。
const API_KEY_LOGIN_PATTERN = /(?:^|\s)(?:bigmodel|zai)-coding-plan-api-key(?:\s|$)/u;

// 记录 slash 命令输入到历史（品类 "slash_command"）；未注入记录器或命中敏感 key 时跳过。
// 历史属于召回 UX，写入失败被静默忽略，绝不影响命令本身执行。
export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
  command: SlashCommand,
): Promise<void> {
  if (!deps.recordInputHistory || !shouldRecordSlashCommand(command)) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}

// 是否记录该命令：未知命令也记录（便于用户回溯拼写）；除 /login 带 API key 外的所有已知命令都记录。
function shouldRecordSlashCommand(command: SlashCommand): boolean {
  if (command.type !== "known") return true;
  if (command.name !== "login") return true;
  return !API_KEY_LOGIN_PATTERN.test(command.args);
}
