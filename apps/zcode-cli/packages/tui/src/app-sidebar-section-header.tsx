// 侧栏分区标题行。
// 职责：渲染「展开/折叠标记 + 标题」，并处理点击切换。
// 边界：只上抛 onToggle，不持有展开态；onToggle 缺省时为静态标题。
// 副作用：点击时先 stopPropagation 再回调，避免冒泡触发父级选择。
// 口径：固定单行高、超宽截断，保证各分区标题视觉等高。

import { TextAttributes } from "@mbears/opentui-core";
import React from "react";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 展开/折叠标记常量：展开态用 ▼，折叠态用 ▶，与标题文字一起构成可点击的分区标题行。
const EXPANDED_MARKER = "▼";
const COLLAPSED_MARKER = "▶";
const SIDEBAR_SECTION_HEADER_STYLE = {
  attributes: TextAttributes.BOLD,
  fg: palette.text,
  flexShrink: 0,
  height: 1,
  truncate: true,
  width: SIDEBAR_CONTENT_WIDTH,
  wrapMode: "none",
};

// 鼠标事件的最小子集：仅用于阻止冒泡，避免点击标题同时触发外层容器的选择行为。
type MouseEventLike = {
  stopPropagation?: () => void;
};

// 侧边栏分区标题行：渲染「标记 + 标题」，整行可点击切换展开态。
// 输入 expanded 决定标记方向；onToggle 缺省时标题仍可渲染但点击无效果（纯静态标题）。
// 副作用：点击时先 stopPropagation 再回调 onToggle，避免事件冒泡到父级造成重复切换。
// 固定单行高、超宽截断，保证所有分区标题在视觉上等宽等高。
export function SidebarSectionHeader(props: {
  expanded: boolean;
  onToggle?: () => void;
  title: string;
}): React.ReactElement {
  const marker = props.expanded ? EXPANDED_MARKER : COLLAPSED_MARKER;
  return h(
    "text",
    {
      onMouseUp: (event: MouseEventLike) => {
        event.stopPropagation?.();
        props.onToggle?.();
      },
      selectable: false,
      style: SIDEBAR_SECTION_HEADER_STYLE,
    },
    `${marker} ${props.title}`,
  );
}
