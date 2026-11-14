// 侧栏已修改文件分区。
// 职责：展示每个文件的增删行数与路径，最多 6 行并提示剩余数量。
// 边界：顺序与去重由上层聚合决定，本组件不排序、不合并统计。
// 副作用：无，纯展示；列宽固定以保证增删计数对齐。
// 降级：空数组显示 empty 文案；路径超宽截断而非撑高侧栏。

import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ModifiedFileStat } from "./app-modified-files.js";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { formatNumber, truncatePlain } from "./state.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 文件行布局常量：最多列 6 个改动文件；增删计数列各 7 列，剩余宽度归路径列，
// 保证 +N/-N 两位数字在长路径下仍不被挤压。
const MODIFIED_FILE_ROW_LIMIT = 6;
const MODIFIED_FILE_COUNT_WIDTH = 7;
const MODIFIED_FILE_PATH_WIDTH = SIDEBAR_CONTENT_WIDTH - MODIFIED_FILE_COUNT_WIDTH * 2;

// 已修改文件 section：展示每个文件的增删行数与路径。
// expanded 为 false 时只渲染标题；files 为空数组时显示 empty 文案而非空 section。
// 输入：files 已由上层聚合（顺序即展示顺序，本组件不排序、不去重）。
// 副作用：无，纯展示。
export function ModifiedFilesSection(props: {
  copy: TuiCopy;
  expanded: boolean;
  files: ModifiedFileStat[];
  onToggle?: () => void;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    SidebarSectionHeader({
      expanded: props.expanded,
      onToggle: props.onToggle,
      title: props.copy.sidebar.sections.modifiedFiles,
    }),
    ...(props.expanded ? modifiedFileLines(props.copy, props.files) : []),
  );
}

// section 内容：最多渲染 MODIFIED_FILE_ROW_LIMIT 行，超出用 "more(N)" 提示剩余数量。
// 限制行数是为了让侧边栏高度可预期，避免大改动集把其它 section 挤出可视区。
function modifiedFileLines(copy: TuiCopy, files: ModifiedFileStat[]): React.ReactNode[] {
  if (files.length === 0) {
    return [
      h("text", { key: "empty", style: { fg: palette.muted } }, copy.sidebar.modifiedFiles.empty),
    ];
  }

  const visibleFiles = files.slice(0, MODIFIED_FILE_ROW_LIMIT);
  const lines = visibleFiles.map((file) => modifiedFileLine(file));
  if (files.length > MODIFIED_FILE_ROW_LIMIT) {
    lines.push(
      h(
        "text",
        { key: "more", style: { fg: palette.muted } },
        copy.sidebar.modifiedFiles.more(files.length - MODIFIED_FILE_ROW_LIMIT),
      ),
    );
  }
  return lines;
}

// 单个文件行：路径（muted，截断）+ 新增数（accent）+ 删除数（danger），三列定宽对齐。
// 增删计数为 0 时仍显示 "+0/-0"，保持列结构一致，便于纵向快速对比。
function modifiedFileLine(file: ModifiedFileStat): React.ReactElement {
  const additions = countLabel("+", file.additions);
  const deletions = countLabel("-", file.deletions);

  return h(
    "box",
    {
      key: file.filePath,
      style: {
        flexDirection: "row",
        width: SIDEBAR_CONTENT_WIDTH,
      },
    },
    h(
      "text",
      {
        style: {
          fg: palette.muted,
          flexShrink: 0,
          width: MODIFIED_FILE_PATH_WIDTH,
        },
      },
      truncatePlain(file.filePath, MODIFIED_FILE_PATH_WIDTH),
    ),
    h(
      "text",
      {
        style: {
          fg: palette.accent,
          flexShrink: 0,
          width: MODIFIED_FILE_COUNT_WIDTH,
        },
      },
      additions,
    ),
    h(
      "text",
      {
        style: {
          fg: palette.danger,
          flexShrink: 0,
          width: MODIFIED_FILE_COUNT_WIDTH,
        },
      },
      deletions,
    ),
  );
}

// 计数标签：前缀与格式化后的数字拼接后截断并左补空格到固定列宽，保证个位/万位数都右对齐。
function countLabel(prefix: string, value: number): string {
  return truncatePlain(`${prefix}${formatNumber(value)}`, MODIFIED_FILE_COUNT_WIDTH).padStart(
    MODIFIED_FILE_COUNT_WIDTH,
  );
}
