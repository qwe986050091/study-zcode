// INV-01 可见条数上限为三：守住位置 常量；改错故障 浮层挤占输入区。
// INV-02 面板高按实际行数：守住位置 计算；改错故障 空态与满态高度不一致。
// INV-03 每行恒为一行高：守住位置 行样式；改错故障 长文案换行破坏对齐。
// INV-04 选择符宽度固定：守住位置 常量；改错故障 选中态让整行右移。
// INV-05 detail 至多占 65%：守住位置 预算函数；改错故障 名称被压到不可读。
// INV-06 名称最少保留六列：守住位置 预算；改错故障 窄终端只剩省略号。
// INV-07 内容宽最小十二列：守住位置 归一化；改错故障 极窄终端出现负宽度。
// INV-08 宽度非法回落八十：守住位置 归一化；改错故障 NaN 传入布局导致崩渲染。
// INV-09 空候选显示提示行：守住位置 分支；改错故障 面板高度塌陷。
// INV-10 选中下标先夹取：守住位置 窗口函数；改错故障 越界下标导致切片为空。
// INV-11 窗口以选中项为底部：守住位置 起点计算；改错故障 选中项滚出可视区。
// INV-12 起点不越界：守住位置 双重夹取；改错故障 末尾候选下方留白。
// INV-13 返回相对下标：守住位置 返回值；改错故障 行高亮错位。
// INV-14 返回窗口起点：守住位置 返回值；改错故障 调用方无法定位全局位置。
// INV-15 说明为空省两段：守住位置 条件渲染；改错故障 出现孤立间隔。
// INV-16 间隔用弹性盒：守住位置 行结构；改错故障 说明被推到下一行。
// INV-17 当前模式追加标记：守住位置 modeDetail；改错故障 用户看不出当前生效项。
// INV-18 纯展示不写状态：守住位置 组件边界；改错故障 切换逻辑被复制到面板内。
//
// 模块职责：渲染模式候选浮层，含裁剪、窗口滚动与选中高亮。
// 状态所有权：无状态；选中项与当前模式都由父层给出。
// 阅读顺序：先看常量，再看面板与窗口函数，最后看行渲染与宽度预算。
// 模式候选浮层的布局与渲染。
// 职责：按可用宽度裁剪并渲染模式窗口、选中高亮与当前模式标记。
// 边界：纯展示组件，模式切换由调用方处理，本文件不持有业务状态。
// 副作用：无 IO，仅按 palette 取色；不发起请求、不写日志。
// 降级：宽度非法回落到 80 列，空候选显示提示行而非抛错。

import React from "react";
import { clampIndex } from "./app-input.js";
import { palette } from "./app-model.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiModeOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// MODE_OPTION_VISIBLE_COUNT 与面板外观行数分开两个常量。
// MODE_OPTION_ROW_HEIGHT 恒为一行。
// MODE_ROW_SELECTOR_WIDTH 与 MODE_ROW_DETAIL_GAP_WIDTH 各占固定列。
// MODE_ROW_MIN_CONTENT_WIDTH 保护窄终端。
// MODE_ROW_MAX_DETAIL_RATIO 与 MODE_ROW_MIN_LABEL_WIDTH 共同约束。
const MODE_OPTION_VISIBLE_COUNT = 3;
const MODE_OPTION_PANEL_CHROME_ROWS = 2;
const MODE_OPTION_ROW_HEIGHT = 1;
const MODE_ROW_SELECTOR_WIDTH = 2;
const MODE_ROW_DETAIL_GAP_WIDTH = 2;
const MODE_ROW_MIN_CONTENT_WIDTH = 12;
const MODE_ROW_MIN_LABEL_WIDTH = 6;
const MODE_ROW_FALLBACK_CONTENT_WIDTH = 80;
const MODE_ROW_MAX_DETAIL_RATIO = 0.65;

// 已按可用宽度裁剪的单行模式候选：detail 为说明（可能被截断），detailWidth 为显示宽度，
// label 为模式展示名；宽度按显示列计算（含东亚宽字符），不是字符数。
type FittedModeOptionRow = {
  detail: string;
  detailWidth: number;
  label: string;
};

// /mode 建议面板：渲染当前模式候选窗口，并高亮当前选中项与当前生效模式。
// 输入：contentWidth 为可用内容列宽（undefined/非有限数时回落到 80 列）；
// modes 可为空数组（显示“无匹配”行）；selectedIndex 越界时由窗口函数内部夹取。
// 输出：始终返回一个 box 元素（含空态提示行），不会返回 null；height 按实际行数计算，
// 保证面板不会撑破父布局。
// 副作用：无 IO/持久化，纯渲染；每次渲染按当前模式与主题取色。
// 不变量：行数不超过 MODE_OPTION_VISIBLE_COUNT，选中项始终落在可见窗口内。
export function ModeSuggestionPanel({
  contentWidth,
  currentMode,
  modes,
  selectedIndex,
}: {
  contentWidth?: number;
  currentMode: string;
  modes: readonly TuiModeOption[];
  selectedIndex: number;
// visibleModeOptionWindow 给出可见窗口。
// contentWidth 先经 normalizeModeRowContentWidth 归一。
// 候选逐行交给 fitModeOptionRow 拟合。
// 面板高按 visible.modes.length 计算。
// 空候选仍占 MODE_OPTION_ROW_HEIGHT 一行提示。
}): React.ReactElement | null {
  const visible = visibleModeOptionWindow(modes, selectedIndex, MODE_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeModeRowContentWidth(contentWidth);
  const rows =
    visible.modes.length > 0
      ? visible.modes.map((mode, index) => ({
          fitted: fitModeOptionRow(
            {
              detail: modeDetail(mode, mode.id === currentMode),
              label: mode.label,
            },
            rowContentWidth,
          ),
          mode,
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    MODE_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * MODE_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Modes",
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
          h(ModeSuggestionRow, {
            key: row.mode.id,
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: MODE_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching modes.",
        ),
  );
}

// 计算候选的滚动可见窗口，保证选中项可见（类似列表滚动跟随）。
// 输入：完整候选、选中下标、最大可见条数；maxVisible <= 0 或候选为空时返回空窗口。
// 输出：modes 为切片后的可见子集，selectedIndex 为相对窗口的下标（非全局下标），
// startIndex 为窗口在完整列表中的起点，供调用方需要时定位。
// 口径：先夹取全局下标，再让窗口尽量以选中项为底部，最后回退到不越界的起点；
// 副作用：无，纯函数，不修改入参。
export function visibleModeOptionWindow(
  modes: readonly TuiModeOption[],
  selectedIndex: number,
  maxVisible: number,
): {
  modes: readonly TuiModeOption[];
  selectedIndex: number;
  startIndex: number;
} {
  if (modes.length === 0 || maxVisible <= 0) {
    return {
      modes: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  // modes 为空或 maxVisible <= 0 时直接返回空窗。
  // selectedIndex 先经 clampIndex 夹到范围内。
  // visibleCount 取 maxVisible 与 modes.length 的较小值。
  // startIndex 让选中项尽量靠底部。
  // 返回值带 startIndex 作为全局起点。
  const clampedSelectedIndex = clampIndex(selectedIndex, modes.length);
  const visibleCount = Math.min(maxVisible, modes.length);
  const maxStartIndex = modes.length - visibleCount;
  const startIndex = Math.min(Math.max(0, clampedSelectedIndex - visibleCount + 1), maxStartIndex);

  return {
    modes: modes.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

// 单行候选渲染：选择符、模式名、弹性间隔、说明四段；说明为空时省略后两段，避免留白错位。
function ModeSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedModeOptionRow;
  selected: boolean;
// 选择符与名称宽度固定，flexShrink 为 0。
// description 为空时省略间隔与文本。
// 间隔用 flexGrow 吸收剩余宽度。
// 颜色取自当前主题的 panel 配色。
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: MODE_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: MODE_ROW_SELECTOR_WIDTH,
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
            minWidth: MODE_ROW_DETAIL_GAP_WIDTH,
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

// 生成候选说明：当前生效模式追加 "current" 标记，便于用户确认切换后的目标。
function modeDetail(mode: TuiModeOption, current: boolean): string {
  return current ? `${mode.description}  current` : mode.description;
}

// 按行宽裁剪说明列与名称列：先给说明列分配预算（上限 65% 且需保留最小名称宽度），
// 剩余宽度全给名称列；名称至少保留 1 列，说明为空时不留间隔。
function fitModeOptionRow(
  parts: { detail: string; label: string },
  contentWidth: number,
): FittedModeOptionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? MODE_ROW_DETAIL_GAP_WIDTH : 0;
  const labelBudget = Math.max(
    1,
    contentWidth - MODE_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    label: truncateDisplay(parts.label, labelBudget),
  };
}

// 说明列预算：取“比例上限”和“扣除选择符/间隔/最小名称后剩余”两者的较小值，且不小于 0。
function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * MODE_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth - MODE_ROW_SELECTOR_WIDTH - MODE_ROW_DETAIL_GAP_WIDTH - MODE_ROW_MIN_LABEL_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

// 归一化内容宽：undefined/NaN/Infinity 回落到 80 列，其余向下取整并保证不小于最小内容宽。
function normalizeModeRowContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return MODE_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MODE_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
