// 协作模式切换的 TUI 侧封装。
// 职责：维护可切换模式清单，生成按住即忘的循环切换动作。
// 边界：只乐观更新本地 UI 模式，真实模式以 session handler 返回值为准。
// 副作用：调用 setModeHandler 并写状态栏；失败时回滚本地模式。
// 降级：客户端未提供切换能力时只提示，不修改本地状态。

import type { CollaborationMode } from "@zcode/contracts";
import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { TuiSetMode } from "./types.js";

// TUI 内可循环切换的协作模式完整枚举，顺序即 Tab/快捷键的轮转顺序。
// 口径：只包含界面允许切换的模式；其它模式值（如字符串扩展值）进入切换链时会被视为未知。
export const TUI_SWITCHABLE_MODES = ["plan", "build", "guarded", "yolo"] as const;

// 由常量数组推导出的合法模式字面量联合，供补全/校验处引用，避免与常量清单漂移。
export type TuiSwitchableMode = (typeof TUI_SWITCHABLE_MODES)[number];

// 计算环形轮转的下一模式：当前值不在清单内（未知/旧版本模式）时回到清单首项，
// 其余情况取下一个并回绕，保证切换永远落到一个界面可表示的模式上。
function nextTuiSwitchableMode(currentMode: CollaborationMode | string): TuiSwitchableMode {
  const currentIndex = TUI_SWITCHABLE_MODES.findIndex((mode) => mode === currentMode);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % TUI_SWITCHABLE_MODES.length;
  return TUI_SWITCHABLE_MODES[nextIndex];
}

function formatModeSwitchStatus(mode: CollaborationMode | string): string {
  return `Mode switched to ${formatTuiModeLabel(mode)}.`;
}

function formatModeSwitchFailedStatus(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Mode switch failed: ${message}`;
}

// 模式切换动作：返回一个稳定的无参回调，供键盘处理器即发即忘地调用。
// 输入：当前 mode、本地 setMode、可选的会话侧 setModeHandler 与状态栏 setter。
// 输出：无返回值；切换结果通过 setMode/setStatus 反馈，调用方不等待 Promise。
// 副作用：乐观更新本地模式 → 调用会话变更 → 成功时以服务端返回 mode 为准 → 失败回滚到 previousMode。
// 降级语义：setModeHandler 缺失（该客户端不支持切换）时只提示，不修改本地模式。
// 不变量：任何失败路径都必须恢复 previousMode，避免 UI 与 session 真实模式长期不一致。
export function useTuiModeSwitcher({
  mode,
  setMode,
  setModeHandler,
  setStatus,
}: {
  mode: CollaborationMode;
  setMode: Dispatch<SetStateAction<CollaborationMode>>;
  setModeHandler?: TuiSetMode;
  setStatus: Dispatch<SetStateAction<string>>;
}): () => void {
  return useCallback(() => {
    if (!setModeHandler) {
      setStatus("Mode switching is not available in this client.");
      return;
    }

    const previousMode = mode;
    const nextMode = nextTuiSwitchableMode(mode);
    // Keyboard handlers fire-and-forget this promise, so reflect the local mode
    // immediately and roll back if the session mutation fails.
    setMode(nextMode);
    void Promise.resolve(setModeHandler(nextMode)).then(
      (result) => {
        setMode(result.mode);
        setStatus(result.response ?? formatModeSwitchStatus(result.mode));
      },
      (error: unknown) => {
        setMode(previousMode);
        setStatus(formatModeSwitchFailedStatus(error));
      },
    );
  }, [mode, setMode, setModeHandler, setStatus]);
}

function formatTuiModeLabel(mode: CollaborationMode | string): string {
  if (mode.length === 0) return mode;
  return `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}`;
}
