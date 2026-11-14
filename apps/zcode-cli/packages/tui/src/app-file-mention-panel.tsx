// 文件 @ 提及建议面板（L2）：展示匹配的 workspace 路径，当前选中项 accent 高亮。
// 数据来源为 app-file-mentions.ts 的 FileMentionState；本组件只做布局与换行行高，不做查询。
// items 为空时展示 loading/empty 文案（warning 色），面板始终渲染，不返回 null。
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import {
  FILE_MENTION_VISIBLE_COUNT,
  type FileMentionState,
  visibleFileMentionWindow,
} from "./app-file-mentions.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { wordWrappedLineCount } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 面板外观行数（边框/标题）；宽度缺失或非法时回退 80 列，最小 8 列。
const FILE_MENTION_PANEL_CHROME_ROWS = 2;
const FILE_MENTION_FALLBACK_CONTENT_WIDTH = 80;
const MIN_FILE_MENTION_CONTENT_WIDTH = 8;

// 渲染面板。每行文本由 copy.fileMention.row 生成（含选择符，保证跨语言一致）。
// 行高按 wordWrappedLineCount 计算，窄终端下长路径换行而不是截断；空列表固定 1 行兜底。
// 签名允许 null 以兼容父层布局，但当前实现恒定返回元素。
export function FileMentionPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  state,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  state: FileMentionState;
}): React.ReactElement | null {
  const rowContentWidth = normalizeFileMentionContentWidth(contentWidth);
  const visible = visibleFileMentionWindow(
    state.items,
    state.selectedIndex,
    FILE_MENTION_VISIBLE_COUNT,
  );
  const rows =
    visible.items.length > 0
      ? visible.items.map((item, index) => {
          const text = copy.fileMention.row({
            path: item.path,
            selected: index === visible.selectedIndex,
          });
          return {
            item,
            selected: index === visible.selectedIndex,
            text,
            height: wordWrappedLineCount(text, rowContentWidth),
          };
        })
      : [
          {
            item: undefined,
            selected: false,
            text: state.loading ? copy.fileMention.loading : copy.fileMention.empty,
            height: 1,
          },
        ];
  const panelHeight =
    FILE_MENTION_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);

  return h(
    "box",
    {
      title: copy.fileMention.title,
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    ...rows.map((row, index) =>
      h(
        "text",
        {
          key: row.item?.path ?? `file-mention-${index}`,
          style: {
            fg: row.selected ? palette.accent : row.item ? palette.text : palette.warning,
            height: row.height,
            width: "100%",
            wrapMode: "word",
          },
        },
        row.text,
      ),
    ),
  );
}

// 归一化内容宽度：undefined/NaN/Infinity → 80，其余向下取整并夹到 >= 8。
function normalizeFileMentionContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return FILE_MENTION_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MIN_FILE_MENTION_CONTENT_WIDTH, Math.floor(contentWidth));
}
