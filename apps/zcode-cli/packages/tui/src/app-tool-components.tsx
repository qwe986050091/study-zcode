// 工具片段视图模块：渲染工具标题、详情行、结构化结果（diff/行列表）与原始输出尾部。
// 边界：输入为已投影的 ToolTranscriptPart 与终端宽度，本组件不解析事件、不持有状态。
// 口径：展示顺序固定为标题 → detailLines → resultDisplay → output 尾部 → error，超出部分截断。
// 失败语义：纯展示无失败路径；缺 title 时回退状态色文案，空输出不渲染区块。
import React from "react";
import type { ToolResultDisplayLine, ToolTranscriptPart } from "./app-model.js";
import { ShikiDiffView, diffViewForWidth } from "./app-shiki-diff-view.js";
import { palette } from "./app-model.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { activeTuiTheme } from "./theme/index.js";

// 输出展示常量：最多展示 8 行原始输出；缩进 4 列用于对齐正文；
// 详情行与输出行前缀固定为 2/4 空格，保证多层级缩进在终端中可读。
const MAX_OUTPUT_LINES = 8;
const OUTPUT_LINE_INDENT_WIDTH = 4;
const TOOL_DETAIL_INDENT = "  ";
const TOOL_OUTPUT_LINE_INDENT = "    ";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 工具片段视图：渲染标题、详情行、结构化结果（diff/行列表）与原始输出尾部。
// 输入 part 为已投影的工具片段（title 可能为 undefined，此时用状态色显示 "Tool <name> <status>"）；
// terminalWidth 缺省 100，仅用于 diff 视图选型与输出行截断，不改变数据。
// 展示顺序固定：标题 → detailLines → resultDisplay → output 尾部 → error，
// output 截断为 MAX_OUTPUT_LINES 行且过滤空行，避免大输出撑爆 transcript。
// 副作用：无；不发起请求、不写状态，纯展示。
export function ToolTranscriptPartView({
  part,
  terminalWidth = 100,
}: {
  part: ToolTranscriptPart;
  terminalWidth?: number;
}): React.ReactElement {
  const statusColor = colorForStatus(part.status);
  const title = part.title ?? `Tool ${part.toolName} ${part.status}`;
  const outputLines = part.output ? restoredOutputLines(part.output, terminalWidth) : [];
  // tool rows should align with assistant text; child detail rows carry their own indent.
  return h(
    "box",
    {
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginTop: 1,
        width: "100%",
      },
    },
    h("text", { style: { fg: part.title ? palette.muted : statusColor } }, title),
    ...part.detailLines.map((line, index) =>
      h(
        "text",
        { key: `detail-${index}`, style: { fg: palette.muted } },
        `${TOOL_DETAIL_INDENT}${line}`,
      ),
    ),
    ...(part.resultDisplay
      ? [
          ...(part.resultDisplay.title
            ? [
                h(
                  "text",
                  { key: "result-title", style: { fg: palette.muted } },
                  `${TOOL_DETAIL_INDENT}${part.resultDisplay.title}`,
                ),
              ]
            : []),
          ...resultDisplayNodes(part.resultDisplay, terminalWidth),
        ]
      : []),
    ...(outputLines.length > 0
      ? [
          h(
            "text",
            { key: "output-title", style: { fg: palette.muted } },
            `${TOOL_DETAIL_INDENT}output:`,
          ),
          ...outputLines.map((line, index) =>
            h(
              "text",
              { key: `output-${index}`, style: { fg: palette.muted } },
              `${TOOL_OUTPUT_LINE_INDENT}${line}`,
            ),
          ),
        ]
      : []),
    ...(part.error ? [h("text", { key: "error", style: { fg: palette.danger } }, part.error)] : []),
  );
}

// 结构化结果渲染：有 structuredPatch 时交给 ShikiDiffView（按宽度选左右/统一视图），
// 否则退化为逐行文本，按 tone 着色并统一加 2 列缩进。
// 两条路径互斥，避免同一个结果既渲染 diff 又渲染行列表造成重复。
function resultDisplayNodes(
  display: NonNullable<ToolTranscriptPart["resultDisplay"]>,
  terminalWidth: number,
): React.ReactElement[] {
  if (display.structuredPatch?.length) {
    return [
      h(ShikiDiffView, {
        filePath: display.filePath,
        key: "result-shiki-diff",
        structuredPatch: display.structuredPatch,
        terminalWidth,
        truncated: display.truncated,
        view: diffViewForWidth(terminalWidth),
      }),
    ];
  }
  return display.lines.map((line, index) =>
    h(
      "text",
      { key: `result-${index}`, style: styleForDiffLine(line) },
      `${TOOL_DETAIL_INDENT}${line.text}`,
    ),
  );
}

// 状态配色：completed 成功色、failed 危险色、running 强调色，其余（pending/interrupted 等）用警告色；
// 仅当片段没有自定义 title 时才用该色显示标题，有 title 时标题统一为 muted。
function colorForStatus(status: ToolTranscriptPart["status"]): string {
  if (status === "completed") return palette.success;
  if (status === "failed") return palette.danger;
  if (status === "running") return palette.accent;
  return palette.warning;
}

// diff 行样式：addition/deletion 同时给前景与背景色；其余（context/meta）只用前景色，
// meta 行用行号色弱化，避免与正文混淆。每次调用读取当前激活主题，保证运行时换主题立即生效。
function styleForDiffLine(line: ToolResultDisplayLine): Record<string, string> {
  const theme = activeTuiTheme();
  if (line.tone === "addition") {
    return { bg: theme.diffAddedBg, fg: theme.diffAdded };
  }
  if (line.tone === "deletion") {
    return { bg: theme.diffRemovedBg, fg: theme.diffRemoved };
  }
  return { fg: line.tone === "meta" ? theme.diffLineNumber : theme.diffContext };
}

// 原始输出尾部展示：取前 8 行并按剩余宽度（至少 20 列）截断，超出部分用一行提示补充总行数；
// 最后过滤全空白行，避免输出末尾的连续换行在界面上留下空白行。空输出返回空数组。
function restoredOutputLines(output: string, terminalWidth: number): string[] {
  const width = Math.max(20, terminalWidth - OUTPUT_LINE_INDENT_WIDTH);
  const lines = output.split(/\r?\n/u);
  const visible = lines.slice(0, MAX_OUTPUT_LINES).map((line) => truncateDisplay(line, width));
  if (lines.length > MAX_OUTPUT_LINES) {
    visible.push(`[truncated ${lines.length - MAX_OUTPUT_LINES} lines]`);
  }
  return visible.filter((line) => line.trim().length > 0);
}
