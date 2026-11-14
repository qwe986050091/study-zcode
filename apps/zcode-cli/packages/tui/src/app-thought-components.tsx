// 思考片段视图模块：渲染思考占位行，并在展开时追加正文。
// 边界：只消费 ThoughtTranscriptPart（状态/文本）与 i18n copy，不读写会话状态。
// 副作用：有状态版本在本地维护展开态并响应点击切换，不触发任何请求。
// 失败语义：纯展示无失败路径；copy 缺省时回退 DEFAULT_TUI_COPY。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { ThoughtTranscriptPart } from "./app-model.js";
import { palette } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 折叠标记常量：折叠用 "+"、展开用 "-"，与文件/工具区的行首指示保持一致。
const COLLAPSED_MARKER = "+";
const EXPANDED_MARKER = "-";

// 思考片段视图（有状态版）：本地维护展开态，默认折叠；点击行切换展开。
// 把状态与渲染拆开，便于 ThoughtTranscriptPartFrame 作为纯视图被复用（例如恢复历史时直接给定展开态）。
// 展开态不随 part 更新重置，避免流式追加文本时折叠动作被覆盖。
export function ThoughtTranscriptPartView({
  copy = DEFAULT_TUI_COPY,
  part,
}: {
  copy?: TuiCopy;
  part: ThoughtTranscriptPart;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  return h(ThoughtTranscriptPartFrame, {
    copy,
    expanded,
    onToggle: () => setExpanded((current) => !current),
    part,
  });
}

// 思考片段纯视图：渲染「标记 + 占位文案」一行，展开时追加正文（muted、按词换行、整宽）。
// 输入 expanded/onToggle 由调用方控制；part.status === "thinking" 时使用强调色与"思考中"文案。
// 副作用：无，点击仅回调 onToggle；正文为空时展开仍渲染空文本行，保持高度可预期。
export function ThoughtTranscriptPartFrame({
  copy = DEFAULT_TUI_COPY,
  expanded,
  onToggle,
  part,
}: {
  copy?: TuiCopy;
  expanded: boolean;
  onToggle: () => void;
  part: ThoughtTranscriptPart;
}): React.ReactElement {
  const label = thoughtPlaceholderLabel(part, copy);
  const marker = expanded ? EXPANDED_MARKER : COLLAPSED_MARKER;

  return h(
    "box",
    {
      onMouseUp: onToggle,
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginBottom: 1,
        marginTop: 1,
        width: "100%",
      },
    },
    h(
      "text",
      {
        selectable: false,
        style: { fg: part.status === "thinking" ? palette.accent : palette.muted },
      },
      `${marker} ${label}`,
    ),
    ...(expanded
      ? [
          h(
            "text",
            {
              key: "thought-content",
              style: { fg: palette.muted, width: "100%", wrapMode: "word" },
            },
            part.text.trim(),
          ),
        ]
      : []),
  );
}

// 思考占位文案：thinking 状态取"思考中"，其余（complete 等）取"思考完成"，
// 文案来自 i18n copy，缺省由调用方传入 DEFAULT_TUI_COPY。
// 未识别的 status 一律按完成态处理，未知状态不会显示"思考中"。
export function thoughtPlaceholderLabel(part: ThoughtTranscriptPart, copy: TuiCopy): string {
  return part.status === "thinking"
    ? copy.transcript.thought.thinking
    : copy.transcript.thought.complete;
}
