import type { TuiSubmitPromptResult } from "@zcode/tui";
import {
  formatAvailableCommandCenterModes,
  isSwitchableCommandCenterMode,
} from "../modes.js";
import type { CommandCenterDeps } from "../types.js";

// 处理 /mode：无参展示当前模式与可切换列表；带参校验后委托 deps.setMode 切换。
// 非法值或不支持切换的客户端返回提示文本并保留当前模式；setMode 失败则向上抛（由调用方处理）。
export async function handleModeCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const current = deps.getMode?.() ?? "build";
  if (args.length === 0) {
    return {
      mode: current,
      response: `Current mode: ${current}. Available modes: ${formatAvailableCommandCenterModes()}.`,
    };
  }

  const requested = args.toLowerCase();
  if (!isSwitchableCommandCenterMode(requested)) {
    return {
      mode: current,
      response: `Unsupported mode: ${args}. Available modes: ${formatAvailableCommandCenterModes()}.`,
    };
  }

  if (!deps.setMode) {
    return {
      mode: current,
      response: "Mode switching is not available in this client.",
    };
  }

  const next = await deps.setMode(requested);
  return {
    mode: next,
    response: `Mode switched to ${next}.`,
  };
}
