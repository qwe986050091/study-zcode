import type { TuiPromptInput, TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterApp, CommandCenterDeps } from "./types.js";

// 把 TUI 输入归一为对象形态：字符串输入等价于 { text }；对象原样返回（不复制）。
// 保证后续逻辑只需处理 text/attachments/modelSelection 等字段。
export function normalizeTuiPromptInput(input: TuiPromptInput): Exclude<TuiPromptInput, string> {
  if (typeof input === "string") return { text: input };
  return input;
}

// 用当前 app/deps 的实际状态补齐结果中缺失的 locale/mode/model/theme/thoughtLevel。
// 只填补 undefined（不用 ?? 覆盖空字符串）；结果已有字段优先，符合「命令结果 > 当前状态」的口径。
export function attachCurrentSessionMetadata(
  result: TuiSubmitPromptResult,
  deps: CommandCenterDeps,
  app?: CommandCenterApp,
): TuiSubmitPromptResult {
  return {
    ...result,
    locale: result.locale ?? app?.getLocale?.(),
    mode: result.mode ?? deps.getMode?.(),
    model: result.model ?? app?.getModel?.(),
    theme: result.theme ?? app?.getTheme?.(),
    thoughtLevel: result.thoughtLevel ?? app?.getThoughtLevel?.(),
  };
}
