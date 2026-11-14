// 启动占位屏模块：在首个 session 就绪前展示 logo、工作区路径与"正在启动"文案。
// 边界：只读取 TuiOptions 的 workspaceDirectory/locale 与 onExit 回调，不持有任何会话业务状态。
// 副作用：注册键盘监听，仅在 Ctrl+C 时以 130 退出码转交 onExit，不主动结束进程。
// 失败语义：不发起 IO 与异步请求，渲染阶段没有可失败路径。
import { useKeyboard } from "@mbears/opentui-react";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { palette } from "./app-model.js";
import type { TuiOptions } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 启动占位屏：在首个 session 就绪前展示 logo、工作区路径与"正在启动"文案。
// 输入 options 提供 workspaceDirectory/locale；onExit 用于响应退出请求（Ctrl+C 以 130 退出）。
// 副作用：注册键盘监听，仅拦截 Ctrl+C 并转交 onExit，不主动结束进程。
// 该屏不渲染任何业务数据，避免首帧出现空状态误导用户。
export function TuiStartupScreen({
  options,
  onExit,
}: {
  options: TuiOptions;
  onExit: (code: number) => void;
}): React.ReactElement {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") onExit(130);
  });
  return h(
    "box",
    { style: { flexDirection: "column", width: "100%", height: "100%", padding: 1 } },
    h(EmptyTranscriptLogo),
    h("text", { style: { fg: palette.muted } }, options.workspaceDirectory),
    h("text", { style: { fg: palette.text } }, getZCodeCopy(options.locale).tui.terminal.starting),
  );
}
