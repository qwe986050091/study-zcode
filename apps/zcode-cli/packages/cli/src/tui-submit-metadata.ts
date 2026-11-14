// submitPrompt 结果的元数据补全：把 App 当前的 locale/mode/model/theme/thoughtLevel 附着到 TUI 返回值。
// 目的：TUI 提交后需要立刻刷新状态栏，而 App 侧可能尚未通过事件回传这些值。
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterMode, CommandCenterApp } from "./command-center.js";

// 给 submit 结果补上展示元数据。
// 输入：result 为 TUI 原始返回值；activeApp 提供兜底值；mode 为本次提交使用的命令模式（必填，不兜底）。
// 输出：包装成 `{ kind: "started_turn", result }`，表示"已经开始一轮对话"，调用方据此切换 UI 状态。
// 副作用：无；只读调用 activeApp 的 getter，不写状态、不发事件。
// 口径：result 已有值优先，App getter 仅在字段缺失时补位（避免覆盖 TUI 侧刚算出的精确值）。
export function withTuiMetadata(
  result: TuiSubmitPromptResult,
  activeApp: CommandCenterApp,
  mode: CommandCenterMode,
): { kind: "started_turn"; result: TuiSubmitPromptResult } {
  return {
    kind: "started_turn",
    result: {
      ...result,
      // 以下五项均按"result 优先、App 兜底"合并；getter 为可选，缺失时字段保持 undefined。
      locale: result.locale ?? activeApp.getLocale?.(),
      // mode 由调用方显式传入，不参与兜底链。
      mode,
      model: result.model ?? activeApp.getModel?.(),
      theme: result.theme ?? activeApp.getTheme?.(),
      thoughtLevel: result.thoughtLevel ?? activeApp.getThoughtLevel?.(),
    },
  };
}
