// 侧栏 MCP 状态分区。
// 职责：展示 server 连接汇总与逐 server 的状态/传输/工具数/错误。
// 边界：只读 mcpStatus，不重连、不改配置、不隐藏已有数据。
// 副作用：无，纯展示；行序按名称字典序稳定排列。
// 降级：加载中/失败/空分别给出提示；刷新失败时保留旧数据并追加提示行。

import type { McpServerStatus, McpServerStatusKind } from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { McpSidebarState } from "./app-model.js";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// MCP 行布局常量：状态列 12 列、传输/工具数列 13 列，剩余宽度归 server 名称；
// 最多展示 MCP_SERVER_ROW_LIMIT 行，超出用 "more" 行提示，避免 section 无限增高。
const MCP_SERVER_ROW_LIMIT = 5;
const MCP_STATUS_WIDTH = 12;
const MCP_META_WIDTH = 13;
const MCP_NAME_WIDTH = SIDEBAR_CONTENT_WIDTH - MCP_STATUS_WIDTH - MCP_META_WIDTH - 2;
const SIDEBAR_LABEL_WIDTH = 9;
const SIDEBAR_ROW_VALUE_WIDTH = SIDEBAR_CONTENT_WIDTH - SIDEBAR_LABEL_WIDTH - 1;
const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };

// MCP section：展示 server 汇总（连接数/总数）与逐 server 状态。
// expanded 为 false 时只渲染标题；mcpStatus 的 servers 为空对象表示尚未发现任何 server。
// 展示口径：loading 且无数据时只显示 loading 行；无数据时区分「加载失败」与「空」；
// 有数据但仍有 error 时追加一行刷新失败提示，不隐藏已拿到的旧数据。
// 副作用：无，纯展示；数据由上层 session 事件驱动。
export function McpSection(props: {
  copy: TuiCopy;
  expanded: boolean;
  mcpStatus: McpSidebarState;
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
      title: props.copy.sidebar.sections.mcp,
    }),
    ...(props.expanded ? mcpLines(props.copy, props.mcpStatus) : []),
  );
}

// section 内容：server 按名称字典序排序以稳定行序，先输出汇总行再输出明细。
// connected 计数只统计 status === "connected"，connecting/failed/untrusted 均不计入。
// 每个 server 若带 error 则紧跟一行错误摘要（warning 色），保持名称与错误就近可读。
function mcpLines(copy: TuiCopy, state: McpSidebarState): React.ReactNode[] {
  const entries = Object.entries(state.servers).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const connected = entries.filter(([, server]) => server.status === "connected").length;
  const lines = [
    rowLine(
      copy.sidebar.mcp.servers,
      copy.sidebar.mcp.summary({ connected, total: entries.length }),
      "mcp-summary",
    ),
  ];

  if (state.loading && entries.length === 0) {
    lines.push(textLine(copy.sidebar.mcp.loading, palette.muted, "mcp-loading"));
    return lines;
  }
  if (entries.length === 0) {
    lines.push(
      textLine(
        state.error ? copy.sidebar.mcp.loadFailed : copy.sidebar.mcp.empty,
        errorColor(state),
        "mcp-empty",
      ),
    );
    if (state.error) lines.push(textLine(state.error, palette.danger, "mcp-error"));
    return lines;
  }

  for (const [name, status] of entries.slice(0, MCP_SERVER_ROW_LIMIT)) {
    lines.push(mcpServerLine(copy, name, status));
    if (status.error) {
      lines.push(
        textLine(
          truncateDisplay(status.error, SIDEBAR_CONTENT_WIDTH),
          palette.warning,
          `mcp-${name}-error`,
        ),
      );
    }
  }
  if (entries.length > MCP_SERVER_ROW_LIMIT) {
    lines.push(
      textLine(
        copy.sidebar.mcp.more(entries.length - MCP_SERVER_ROW_LIMIT),
        palette.muted,
        "mcp-more",
      ),
    );
  }
  if (state.error) {
    lines.push(textLine(copy.sidebar.mcp.loadFailed, palette.warning, "mcp-refresh-error"));
  }
  return lines;
}

// 单个 server 行：状态（定宽 12）+ 名称（截断）+ 传输方式与工具数（定宽 13），
// 三段按列对齐，保证不同名称长度下状态列仍然齐整。
function mcpServerLine(copy: TuiCopy, name: string, status: McpServerStatus): React.ReactElement {
  const statusLabel = copy.sidebar.mcp.status[status.status];
  const meta = `${status.transport} ${copy.sidebar.mcp.tools(status.toolCount)}`;
  return textLine(
    `${padEndDisplay(statusLabel, MCP_STATUS_WIDTH)} ${truncateDisplay(name, MCP_NAME_WIDTH)} ${truncateDisplay(meta, MCP_META_WIDTH)}`,
    serverStatusColor(status.status),
    `mcp-${name}`,
  );
}

// 键值行：label 按显示列宽对齐补空格，value 截断到剩余宽度，中间固定 1 列间隔。
function rowLine(label: string, value: string, key: string): React.ReactElement {
  return textLine(
    `${padEndDisplay(label, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(value, SIDEBAR_ROW_VALUE_WIDTH)}`,
    palette.text,
    key,
  );
}

// 通用文本行：固定 1 行高、不换行、超宽截断，防止 server 名称或错误信息撑高侧边栏。
function textLine(value: string, color: string, key: string): React.ReactElement {
  return h("text", { key, style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: color } }, value);
}

// 按显示列宽右补空格；先截断再补，保证宽度精确等于 targetCells（宽字符按 2 列计算）。
function padEndDisplay(value: string, targetCells: number): string {
  const visible = truncateDisplay(value, targetCells);
  return `${visible}${" ".repeat(Math.max(0, targetCells - displayWidth(visible)))}`;
}

// 状态配色：connected 成功色、connecting 强调色、failed 危险色、untrusted 警告色，
// 其余（disabled/unknown 等）用 muted，保持灰度可区分。
function serverStatusColor(status: McpServerStatusKind): string {
  if (status === "connected") return palette.success;
  if (status === "connecting") return palette.accent;
  if (status === "failed") return palette.danger;
  if (status === "untrusted") return palette.warning;
  return palette.muted;
}

// 空态文案配色：有 error 时用 warning 提示「加载失败」，否则用 muted 表示「确实没有 server」。
function errorColor(state: McpSidebarState): string {
  return state.error ? palette.warning : palette.muted;
}
