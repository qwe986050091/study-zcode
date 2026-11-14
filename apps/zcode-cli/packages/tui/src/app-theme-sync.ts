// 终端主题同步模块：把显式 theme 配置与终端上报的明暗模式合成最终主题模式并下发。
// 边界：只处理主题这一项全局单例与终端背景色，不涉及会话/模式/模型等业务状态。
// 副作用：每次渲染写模块级主题单例，并以 effect 推送终端背景色、订阅明暗变化。
// 失败语义：订阅与背景色回调均为可选，缺失时静默跳过；调用方需保证 options 引用稳定。
import React from "react";
import { activeTuiTheme, resolveTuiThemeMode, setActiveTuiThemeMode } from "./theme/index.js";
import type { TuiOptions } from "./types.js";

// 终端主题同步 hook：把配置里的 theme 与终端上报的明暗模式合成最终主题模式，并下发到全局。
// 输入 options.theme 为显式配置（优先）；initialThemeMode 为终端初始明暗；subscribeThemeMode 为可选订阅源。
// 行为：state 变化即调用 setActiveTuiThemeMode（同步写入模块级单例，供非 React 代码读取），
// 并在 effect 中把主题背景色推给终端（setTerminalBackgroundColor 缺省时跳过）。
// 副作用：修改全局主题单例与终端背景色；订阅函数返回取消订阅句柄由 React 清理。
// 注意：options 为依赖项，调用方需保证其引用稳定，否则每次渲染都会重复订阅。
export function useTuiThemeSync(options: TuiOptions): void {
  const [terminalThemeMode, setTerminalThemeMode] = React.useState(options.initialThemeMode);
  const resolvedThemeMode = resolveTuiThemeMode(options.theme, terminalThemeMode);
  setActiveTuiThemeMode(resolvedThemeMode);

  React.useEffect(() => options.subscribeThemeMode?.(setTerminalThemeMode), [options]);

  React.useEffect(() => {
    options.setTerminalBackgroundColor?.(activeTuiTheme(resolvedThemeMode).background);
  }, [options, resolvedThemeMode]);
}
