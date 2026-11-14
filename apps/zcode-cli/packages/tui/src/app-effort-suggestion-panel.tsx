// INV-01 可见窗口由父层给出：守住位置 入参；改错故障 本组件二次过滤。
// INV-02 空候选仍渲染占位：守住位置 三元；改错故障 面板高度跳动。
// INV-03 面板高度按行数：守住位置 计算；改错故障 六行窗口错位。
// INV-04 内容宽异常回退八十：守住位置 归一化；改错故障 窄终端布局崩。
// INV-05 内容宽下限十二列：守住位置 取大值；改错故障 文字被压没。
// INV-06 detail 上限六成五：守住位置 比例常量；改错故障 标题被挤掉。
// INV-07 标题至少保留四列：守住位置 预算公式；改错故障 标题截成空。
// INV-08 选择符宽度固定：守住位置 常量；改错故障 两行文字错位。
// INV-09 当前项只标记不选中：守住位置 参数用途；改错故障 选中态被覆盖。
// INV-10 detail 三段拼接：守住位置 过滤连接；改错故障 出现多余空格。
// INV-11 别名仅在与标识不同时出现：守住位置 比较；改错故障 重复显示同一名。
// INV-12 空 detail 不渲染间隔：守住位置 条件；改错故障 右侧留白。
// INV-13 行键用候选标识：守住位置 键属性；改错故障 选中跳动。
// INV-14 选中色仅两处：守住位置 样式分支；改错故障 整行高亮刺眼。
// INV-15 截断按显示宽度：守住位置 工具函数；改错故障 中文宽度算错。
// INV-16 行高恒为一行：守住位置 常量；改错故障 换行破坏对齐。
// INV-17 面板宽度占满：守住位置 样式；改错故障 边框不齐。
// INV-18 占位文案用警告色：守住位置 颜色常量；改错故障 空态不易察觉。
//
// 模块职责：effort 建议面板的单行拟合与渲染。
// 状态所有权：可见窗口与选中态归父层，本件只做布局。
// 阅读顺序：先看面板装配，再看单行渲染，最后看宽度拟合。
// effort 建议面板（L2）：展示 /effort 候选列表，含 description、别名与 current 标记。
// 每行固定 1 行高，超长 label/detail 用截断而非换行，避免破坏 6 行窗口的对齐与面板总高。
// 纯展示：可见窗口与选中态由父层给出，本组件不做过滤。
import React from "react";
import { visibleEffortOptionWindow } from "./app-input.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiEffortOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 面板外观行数（边框/标题）+ 可见条数上限；每行固定 1 行高，面板高 = chrome + max(1, 行数)。
// 宽度常量单位为显示列：detail 最多占内容宽 65%，label 至少保留 4 列，内容宽最小 12 列。
const EFFORT_OPTION_VISIBLE_COUNT = 6;
const EFFORT_OPTION_PANEL_CHROME_ROWS = 2;
const EFFORT_OPTION_ROW_HEIGHT = 1;
const EFFORT_ROW_SELECTOR_WIDTH = 2;
const EFFORT_ROW_DETAIL_GAP_WIDTH = 2;
const EFFORT_ROW_MIN_CONTENT_WIDTH = 12;
const EFFORT_ROW_MIN_LABEL_WIDTH = 4;
const EFFORT_ROW_FALLBACK_CONTENT_WIDTH = 80;
const EFFORT_ROW_MAX_DETAIL_RATIO = 0.65;

// 单行拟合结果：detail 已按预算截断，detailWidth 为其显示宽度（= 0 表示无 detail 列），label 同理已截断。
type FittedEffortOptionRow = {
  detail: string;
  detailWidth: number;
  label: string;
};

// 返回值恒为 React 元素（不会返回 null），空候选用占位行而非隐藏面板，保持布局高度稳定。
// currentEffort 只参与 detail 的 "current" 标记，不决定选中项；选中态完全由 selectedIndex 决定。
// 渲染 effort 候选面板。候选为空时仍渲染一行 "No matching efforts."（warning 色），
// 保证边界与高度稳定。contentWidth 缺失/为 0/非有限数时按 80 列。
// 可见窗口由父层传入，EffortSuggestionPanel 不自己裁剪。
// 候选为空时仍渲染占位行（No matching efforts.），面板高度不塌。
// 面板高度按 efforts.length 算，空候选也占一行。
// contentWidth 先归一化，缺失/0/非有限数按 80 列。
// 组件无 useState，纯展示。
export function EffortSuggestionPanel({
  contentWidth,
  currentEffort,
  efforts,
  selectedIndex,
}: {
  contentWidth?: number;
  currentEffort: string;
  efforts: readonly TuiEffortOption[];
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleEffortOptionWindow(efforts, selectedIndex, EFFORT_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeEffortRowContentWidth(contentWidth);
  const rows =
    visible.efforts.length > 0
      ? visible.efforts.map((effort, index) => ({
          effort,
          fitted: fitEffortOptionRow(
            {
              detail: effortDetail(effort, effort.id === currentEffort),
              label: effort.label,
            },
            rowContentWidth,
          ),
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    EFFORT_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * EFFORT_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Effort",
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
    rows.length > 0
      ? rows.map((row) =>
          h(EffortSuggestionRow, {
            key: row.effort.id,
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: EFFORT_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching efforts.",
        ),
  );
}

// 单行渲染：选择符 + label + 弹性间隔 + detail。detail 为空时不渲染间隔与文本，label 占满剩余宽度。
// 选择符固定宽。
// label 宽按 displayWidth 的显示列算，不按字符数。
// detail 为空不画间隔。
// 选中色只用于两处。
// 行高固定一行，不换行。
function EffortSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedEffortOptionRow;
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: EFFORT_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: EFFORT_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.text,
          flexShrink: 0,
          width: displayWidth(fitted.label),
        },
      },
      fitted.label,
    ),
    fitted.detail
      ? h("box", {
          style: {
            flexGrow: 1,
            minWidth: EFFORT_ROW_DETAIL_GAP_WIDTH,
          },
        })
      : null,
    fitted.detail
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.detailWidth,
            },
          },
          fitted.detail,
        )
      : null,
  );
}

// 组装 detail 文本：描述 → 别名（label 与 id 不同时用 id）→ "current" 标记，非空项以两个空格连接。
// 描述缺失且无别名且非当前项时返回空串，调用方据此省略 detail 列。
function effortDetail(effort: TuiEffortOption, current: boolean): string {
  const description = effort.description?.trim();
  const alias = effort.label !== effort.id ? effort.id : "";
  return [description, alias, current ? "current" : ""].filter(Boolean).join("  ");
}

// 在给定内容宽内分配 detail/label 两列：先按 65% 上限与"label 至少 4 列"两约束算 detail 预算，
// 再截断 detail；剩余宽度（扣除选择符与间隔）给 label，至少 1 列。
// 先算 detail 预算。
// truncateDisplay 截断后，再用 displayWidth(detail) 量宽。
// labelBudget 把剩余宽度给 label，至少 1 列。
// Math.max(1, ...) 保证 label 至少一列。
// 返回 { detail, detailWidth, label } 三段。
function fitEffortOptionRow(
  parts: { detail: string; label: string },
  contentWidth: number,
): FittedEffortOptionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? EFFORT_ROW_DETAIL_GAP_WIDTH : 0;
  const labelBudget = Math.max(
    1,
    contentWidth - EFFORT_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    label: truncateDisplay(parts.label, labelBudget),
  };
}

// detail 列预算：无 detail 返回 0；否则取 min(内容宽 * 65%, 内容宽 - 选择符 - 间隔 - label 最小宽)，
// 并夹到 >= 0（窄终端下可能为 0，此时只显示 label）。
// 无 detail 返回零。
// detailMax 取 contentWidth * EFFORT_ROW_MAX_DETAIL_RATIO（65%）。
// 再与 contentWidth 减选择符、间隔、最小 label 宽的结果取小。
// 最终 Math.max(0, ...) 保证不为负。
function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * EFFORT_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth -
    EFFORT_ROW_SELECTOR_WIDTH -
    EFFORT_ROW_DETAIL_GAP_WIDTH -
    EFFORT_ROW_MIN_LABEL_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

// 归一化内容宽度：undefined/0/NaN/Infinity 都回退 80（0 视为未提供），否则向下取整并 >= 12 列。
function normalizeEffortRowContentWidth(contentWidth: number | undefined): number {
  if (!contentWidth || !Number.isFinite(contentWidth)) return EFFORT_ROW_FALLBACK_CONTENT_WIDTH;
  return Math.max(EFFORT_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
