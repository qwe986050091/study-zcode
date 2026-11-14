// TUI 审批面板（L2）：把一条待审批的权限请求渲染为定高文本面板。
// 只负责呈现与行高计算，不修改权限状态；选中项由父层保存在 approval.selectedDecision。
// 行高按 wordWrappedLineCount 计算，宽度单位为终端显示列，窄终端靠回退值兜底。
import React from "react";
import type { ApprovalPrompt } from "./app-model.js";
import { palette } from "./app-model.js";
import { decisionsForApproval } from "./app-approval.js";
import {
  approvalDecisionLabel,
  isOfficialCuaProjectApproval,
  approvalPermissionScopes,
  approvalRequestDescription,
  previewPermissionInput,
} from "./app-approval.js";
import { truncateDisplay, wordWrappedLineCount } from "./app-terminal-width.js";
import { QuestionPanel } from "./app-question-panel.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 面板固定外观行数（边框 + 标题 + 底部留白），用于把内容行数换算成 box 总高度。
// 以下宽度常量单位均为显示列：缺失/非法时回退 80 列，最小 8 列，输入预览最多截断 120 列。
const APPROVAL_PANEL_CHROME_ROWS = 4;
const APPROVAL_FALLBACK_CONTENT_WIDTH = 80;
const APPROVAL_MIN_CONTENT_WIDTH = 8;
const APPROVAL_PREVIEW_MAX_CELLS = 120;

// 面板中的一行文本（纯展示数据，不持有 React 元素）。
type ApprovalTextRow = {
  // 前景色 token，取自 palette（warning/muted/accent/text）。
  fg: string;
  // 该行在目标宽度下占用的终端行数，>= 1；用于精确计算面板高度。
  height: number;
  // React 列表 key，需在本面板内唯一（如 reason / scope-0 / allow_once）。
  key: string;
  // 原始文本（可能已被截断），换行交由渲染层的 wrapMode: word 完成。
  text: string;
};

// 渲染审批面板。approval.questionState 存在时整体让位给 QuestionPanel（提问式审批）。
// contentWidth 未传或非有限数时按 80 列计算；返回高度 = 固定 chrome 行 + 各内容行换行行数之和。
// 无副作用：不调用 approval.resolve/cleanup，键盘处理见 app-approval.ts。
export function ApprovalPanel({
  approval,
  contentWidth,
}: {
  approval: ApprovalPrompt;
  contentWidth?: number;
}): React.ReactElement {
  if (approval.questionState) {
    return h(QuestionPanel, { state: approval.questionState });
  }

  const rowContentWidth = normalizeApprovalContentWidth(contentWidth);
  const rows = approvalRows(approval, rowContentWidth);
  const panelHeight =
    APPROVAL_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);

  return h(
    "box",
    {
      title: `Approval required: ${approval.request.toolName}`,
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.warning,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        padding: 1,
        width: "100%",
      },
    },
    ...rows.map((row) =>
      h(
        "text",
        {
          key: row.key,
          style: {
            fg: row.fg,
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

// 组装面板内容行：审批原因 → 输入预览 → 允许范围 → （可选）CUA 项目级提示 → 决策项 → 操作提示。
// 决策项顺序与 decisionsForApproval 一致，选中项加 ">" 前缀并使用 accent 高亮。
// 返回数组顺序即渲染顺序，调用方不得再排序。
function approvalRows(approval: ApprovalPrompt, contentWidth: number): ApprovalTextRow[] {
  const rows = [
    approvalTextRow(
      "reason",
      approvalRequestDescription(approval.request),
      palette.warning,
      contentWidth,
    ),
    approvalTextRow(
      "input",
      truncateDisplay(previewPermissionInput(approval.request.input), APPROVAL_PREVIEW_MAX_CELLS),
      palette.muted,
      contentWidth,
    ),
  ];

  for (const [index, scope] of approvalPermissionScopes(approval.request).entries()) {
    rows.push(
      approvalTextRow(
        `scope-${index}`,
        `${scope.kind === "prefix" ? "Command prefix" : "Exact command only"}: ${scope.text}`,
        palette.muted,
        contentWidth,
      ),
    );
  }

  if (isOfficialCuaProjectApproval(approval.request)) {
    rows.push(
      approvalTextRow(
        "computer-use-scope",
        "Do not ask again for official Computer Use actions in this project",
        palette.muted,
        contentWidth,
      ),
    );
  }

  for (const decision of decisionsForApproval(approval.request)) {
    rows.push(
      approvalTextRow(
        decision,
        `${approval.selectedDecision === decision ? ">" : " "} ${approvalDecisionLabel(decision, approval.request)}`,
        approval.selectedDecision === decision ? palette.accent : palette.text,
        contentWidth,
      ),
    );
  }

  rows.push(
    approvalTextRow(
      "help",
      "Up/Down choose, Enter confirms, Esc denies",
      palette.muted,
      contentWidth,
    ),
  );
  return rows;
}

// 按目标宽度预估一行文本的换行行数，构造 ApprovalTextRow。
// 空字符串经 wordWrappedLineCount 仍按 1 行计，避免出现 0 高度导致布局塌陷。
function approvalTextRow(
  key: string,
  text: string,
  fg: string,
  contentWidth: number,
): ApprovalTextRow {
  return {
    fg,
    height: wordWrappedLineCount(text, contentWidth),
    key,
    text,
  };
}

// 归一化内容宽度：undefined/NaN/Infinity 回退 80 列，其余向下取整并夹到 >= 8 列。
// 保证后续换行计算不会得到 0 或负宽度。
function normalizeApprovalContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return APPROVAL_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(APPROVAL_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
