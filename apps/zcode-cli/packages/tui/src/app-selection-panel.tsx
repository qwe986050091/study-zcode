// INV-01 三态互斥且优先级固定为 input > pending > 列表：守住位置 SelectionPanel 的三元判断；改错故障 输入态被列表态覆盖，用户看不到正在输入的内容。
// INV-02 面板高度固定不随条目数变化：守住位置 CHOICE_PANEL_HEIGHT 常量；改错故障 上下翻页时弹层抖动。
// INV-03 可见窗口固定 5 行：守住位置 SELECTION_VISIBLE_COUNT；改错故障 选中项滚出可视区。
// INV-04 内容宽度必须归一化后才能进入布局：守住位置 normalizeSelectionContentWidth；改错故障 负数列宽导致裁切异常。
// INV-05 非法宽度回落到 80 列：守住位置 SELECTION_ROW_FALLBACK_CONTENT_WIDTH；改错故障 无宽度信息时渲染成 0 列。
// INV-06 detail 预算不得超过内容宽度的 55%：守住位置 SELECTION_ROW_MAX_DETAIL_RATIO；改错故障 主文本被压缩到不可读。
// INV-07 主文本至少保留 1 列：守住位置 fitSelectionRow 的 Math.max；改错故障 极窄终端出现负宽。
// INV-08 主文本最小宽度预留 8 列：守住位置 SELECTION_ROW_MIN_PRIMARY_WIDTH；改错故障 detail 独占整行。
// INV-09 内容最小宽度为 12 列：守住位置 SELECTION_ROW_MIN_CONTENT_WIDTH；改错故障 窄屏下选择器与文本重叠。
// INV-10 禁用项仍渲染且只改色不隐藏：守住位置 SelectionRow 的 primaryColor；改错故障 列表行数随状态跳动。
// INV-11 选中标记固定 2 列：守住位置 SELECTION_ROW_SELECTOR_WIDTH；改错故障 主文本起始列漂移。
// INV-12 detail 前的弹性间隔固定 2 列：守住位置 SELECTION_ROW_DETAIL_GAP_WIDTH；改错故障 补充信息贴住主文本。
// INV-13 detail 宽度按显示列而非字符数计算：守住位置 displayWidth；改错故障 中文站点右对齐错位。
// INV-14 所有文本裁切都走 truncateDisplay：守住位置 输入行、主文本与 detail；改错故障 宽字符被截成半个。
// INV-15 空列表渲染 emptyMessage 且面板不塌陷：守住位置 visibleWindow.items 判断；改错故障 出现空白弹层。
// INV-16 帮助行缺失时用 copy 默认文案兜底：守住位置 help 的空值合并；改错故障 帮助行显示 undefined。
// INV-17 detail 片段为空时不得留下分隔符：守住位置 filter 与 join；改错故障 行尾出现多余空格。
// INV-18 组件不持有筛选与选中状态：守住位置 入参只读；改错故障 键盘事件与渲染状态不同步。
//
// 模块职责：按输入态、等待态与列表态渲染通用选区弹层，并保证终端列宽下的稳定布局。
// 状态所有权：过滤结果、选中索引与过滤词全部由调用方持有，本文件只读。
// 阅读顺序：先看尺寸常量与三态分派，再读三种内容构造，最后看行裁切与列宽预算。
// 通用选区弹层的渲染。
// 职责：按 input / pending / 列表三态输出候选窗口、帮助行与空态。
// 边界：纯展示组件，过滤与选中由调用方持有，组件不回写状态。
// 副作用：无 IO、不触发事件；宽度与截断均按显示列计算。
// 降级：空列表渲染 emptyMessage；宽度非法回落 80 列并保证最小内容宽。

import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { SelectionState } from "./app-model.js";
import { palette } from "./app-model.js";
import {
  filterSelectionItems,
  selectionInputDisplayValue,
  visibleSelectionItemWindow,
} from "./app-selection-keyboard.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 面板固定尺寸参数：PANEL_CHROME_ROWS 为标题/边框/内边距等非内容行数，
// 列表固定展示 SELECTION_VISIBLE_COUNT 行、每行 1 行高，保证弹层高度不随条目数抖动。
// 非内容行数只算 title 与 border，再加 padding。
// 列表高度固定 7 行，等于 5 行内容加 2 行提示。
// 这些常量同时决定 overlay 定位，改一个要连带改另一个。
// 行高固定为 1，禁止条目换行。
// 尺寸单位是终端 cell，不是 px。
const PANEL_CHROME_ROWS = 4;
const CHOICE_PANEL_HEIGHT = PANEL_CHROME_ROWS + 7;
const SELECTION_VISIBLE_COUNT = 5;
const SELECTION_ROW_HEIGHT = 1;
const SELECTION_ROW_SELECTOR_WIDTH = 2;
const SELECTION_ROW_DETAIL_GAP_WIDTH = 2;
const SELECTION_ROW_MIN_CONTENT_WIDTH = 12;
const SELECTION_ROW_MIN_PRIMARY_WIDTH = 8;
const SELECTION_ROW_FALLBACK_CONTENT_WIDTH = 80;
const SELECTION_ROW_MAX_DETAIL_RATIO = 0.55;

// 单行已裁切结果：primary 为主文本，detail 为右侧补充说明（无补充时为空串）。
// detailWidth 按终端显示列宽计算（中文/宽字符计 2 列），供布局直接固定宽度使用。
type FittedSelectionRow = {
  detail: string;
  detailWidth: number;
  primary: string;
};

// 通用选择面板：渲染 slash 命令、模型/模式选择等列表型弹层，纯展示组件。
// 输入：contentWidth 缺省或非有限数时回退到 80 列；selection 由调用方持有
// filter 与 selectedIndex，组件只按当前窗口读取，不缓存、不回写状态。
// 内容形态互斥：input（输入态）> pending（等待态）> 列表态，任一时刻只渲染一种。
// 副作用：无。不访问终端、不触发事件；空列表时渲染 emptyMessage 而非抛错。
export function SelectionPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  selection,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  selection: SelectionState;
}): React.ReactElement {
  const visible = filterSelectionItems(selection);
  const visibleWindow = visibleSelectionItemWindow(
    visible,
    selection.selectedIndex,
    SELECTION_VISIBLE_COUNT,
  );
  // 入参宽度可能来自尚未完成布局的终端。
  // undefined 与非有限数都视为未知宽度。
  // 归一化后宽度一定不小于 12 列。
  // 后续列宽预算都基于 usableWidth。
  // 子函数不要对 usableWidth 再次归一化。
  const rowContentWidth = normalizeSelectionContentWidth(contentWidth);

  return h(
    "box",
    {
      title: selection.title,
      style: panelStyle({ borderColor: palette.accent, height: CHOICE_PANEL_HEIGHT }),
    },
    ...(selection.input
      ? inputSelectionContent(selection.input, rowContentWidth)
      : selection.pending
        ? pendingSelectionContent(selection.pending)
        : selectionContent(selection, copy, visibleWindow, rowContentWidth)),
  );
}

// 输入态内容：首行 primary，其后按非空情况追加 secondary、输入行与 help。
// 输入行以 "> " 前缀展示并截断到内容宽度；value 为空时用 muted 色表示尚未输入。
// 输入行前缀固定两字符，不计入内容宽度。
// 空输入使用 muted 色表示尚未键入。
// secondary 与 help 允许自动换行。
// 输入行按内容宽度裁切，避免横向溢出。
// 空片段返回 null 后统一过滤。
function inputSelectionContent(
  input: NonNullable<SelectionState["input"]>,
  rowContentWidth: number,
): React.ReactNode[] {
  const value = selectionInputDisplayValue(input);
  const inputLine = `> ${value}`;
  const inputColor = input.value ? palette.text : palette.muted;
  return [
    h("text", { key: "primary", style: { fg: palette.accent } }, input.primary),
    input.secondary
      ? h("text", { key: "secondary", style: { fg: palette.muted, wrapMode: "word" } }, input.secondary)
      : null,
    h(
      "text",
      { key: "input", style: { fg: inputColor } },
      truncateDisplay(inputLine, rowContentWidth),
    ),
    input.help
      ? h("text", { key: "help", style: { fg: palette.muted, wrapMode: "word" } }, input.help)
      : null,
  ].filter((child): child is React.ReactElement => Boolean(child));
}

// 等待态内容：仅展示提示文案，不渲染列表项；secondary/help 为空时自动省略。
// 用于调用方已确定要执行的动作但尚未拿到结果的过渡画面。
function pendingSelectionContent(
  pending: NonNullable<SelectionState["pending"]>,
): React.ReactNode[] {
  return [
    h("text", { key: "primary", style: { fg: palette.accent } }, pending.primary),
    pending.secondary
      ? h("text", { key: "secondary", style: { fg: palette.muted, wrapMode: "word" } }, pending.secondary)
      : null,
    pending.help
      ? h("text", { key: "help", style: { fg: palette.muted, wrapMode: "word" } }, pending.help)
      : null,
  ].filter((child): child is React.ReactElement => Boolean(child));
}

// 列表态内容：prompt + 帮助行 + 可见窗口；窗口为空时展示 emptyMessage（warning 色）。
// 每行先由 selectionRowDetail 汇总补充信息，再由 fitSelectionRow 按内容宽度裁切。
// 第一行永远是 prompt，第二行永远是帮助行。
// items 为空时只替换列表行，标题与边框仍保留。
// 每行 detail 先汇总再统一裁切。
// 选中索引来自窗口计算结果而不是遍历下标。
// 行键使用条目 id，避免重排错位。
function selectionContent(
  selection: SelectionState,
  copy: TuiCopy,
  visibleWindow: ReturnType<typeof visibleSelectionItemWindow>,
  rowContentWidth: number,
): React.ReactNode[] {
  return [
    h("text", { style: { fg: palette.text } }, selection.prompt),
    h("text", { style: { fg: palette.muted } }, selectionHelperText(selection, copy)),
    ...(visibleWindow.items.length === 0
      ? [h("text", { key: "empty", style: { fg: palette.warning } }, selection.emptyMessage)]
      : visibleWindow.items.map((item, index) =>
          h(SelectionRow, {
            fitted: fitSelectionRow(
              {
                detail: selectionRowDetail(item, copy),
                primary: item.primary,
              },
              rowContentWidth,
            ),
            itemDisabled: Boolean(item.disabledReason),
            key: item.id,
            selected: index === visibleWindow.selectedIndex,
          }),
        )),
  ];
}

// 单行渲染：左侧 2 列选中标记（"> " / "  "），主文本固定宽度，detail 右对齐。
// 禁用项仍渲染并使用 muted 色而非隐藏，避免可用项变化时列表行数跳动。
// detail 非空时插入 2 列弹性间隔，把补充信息推到行尾。
function SelectionRow({
  fitted,
  itemDisabled,
  selected,
}: {
  fitted: FittedSelectionRow;
  itemDisabled: boolean;
  selected: boolean;
}): React.ReactElement {
  const primaryColor = selected ? palette.accent : itemDisabled ? palette.muted : palette.text;

  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: SELECTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: SELECTION_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: primaryColor,
          flexShrink: 0,
          width: displayWidth(fitted.primary),
        },
      },
      fitted.primary,
    ),
    fitted.detail
      ? h("box", {
          style: {
            flexGrow: 1,
            minWidth: SELECTION_ROW_DETAIL_GAP_WIDTH,
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

// 帮助行文案：不可过滤（filterable === false）时直接展示 help 或默认提示，
// 可过滤时拼接当前过滤词（空则用"无过滤"文案）与 help，两者均由 i18n copy 提供。
function selectionHelperText(selection: SelectionState, copy: TuiCopy): string {
  if (selection.filterable === false) return selection.help ?? copy.selection.defaultHelp;
  return copy.selection.filterLine({
    filter: selection.filter || copy.selection.noFilter,
    help: selection.help,
  });
}

// 行右侧补充信息：secondary、括号包裹的 meta、禁用原因三段，以两个空格连接；
// 缺失片段（undefined/空串）直接跳过，保证不会出现多余分隔符。
function selectionRowDetail(
  item: SelectionState["items"][number],
  copy: TuiCopy,
): string {
  return [
    item.secondary,
    item.meta ? `(${item.meta})` : undefined,
    item.disabledReason ? copy.selection.disabled(item.disabledReason).trim() : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("  ");
}

// 按内容宽度分配主文本与 detail 列：detail 先按预算裁切，剩余宽度扣除选择器
// 与间隔后归主文本，且主文本至少保留 1 列，避免极端宽度下出现负值。
// detail 先按预算裁切，再据实际宽度反推主文本预算。
// 主文本预算至少为 1，防止出现负值。
// detail 为空时不保留间隔宽度。
// 返回的 detailWidth 与裁切结果保持一致。
// 该函数是纯计算，不读取终端状态。
function fitSelectionRow(
  parts: { detail: string; primary: string },
  contentWidth: number,
): FittedSelectionRow {
  const detailBudget = detailColumnBudget(parts.detail, contentWidth);
  const detail = truncateDisplay(parts.detail, detailBudget);
  const detailWidth = displayWidth(detail);
  const detailGapWidth = detail ? SELECTION_ROW_DETAIL_GAP_WIDTH : 0;
  const primaryBudget = Math.max(
    1,
    contentWidth - SELECTION_ROW_SELECTOR_WIDTH - detailGapWidth - detailWidth,
  );

  return {
    detail,
    detailWidth,
    primary: truncateDisplay(parts.primary, primaryBudget),
  };
}

// detail 列预算：取「内容宽度 * 55%」与「扣掉选择器、间隔、主文本最小宽度后的余量」
// 中的较小值；detail 为空时返回 0，不占用主文本空间。
function detailColumnBudget(detail: string, contentWidth: number): number {
  if (!detail) return 0;
  const detailMax = Math.floor(contentWidth * SELECTION_ROW_MAX_DETAIL_RATIO);
  const detailBudget =
    contentWidth -
    SELECTION_ROW_SELECTOR_WIDTH -
    SELECTION_ROW_DETAIL_GAP_WIDTH -
    SELECTION_ROW_MIN_PRIMARY_WIDTH;
  return Math.max(0, Math.min(detailMax, detailBudget));
}

// 内容宽度归一化：undefined 或非有限数回退 80 列，否则向下取整并保证不小于 12 列，
// 防止超窄终端让后续列宽预算变成负数。
function normalizeSelectionContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return SELECTION_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(SELECTION_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

// 面板样式：固定高度 + 底部 1 行外边距，保证弹层在不同终端高度下位置稳定、不与后续内容贴合。
function panelStyle({
  borderColor,
  height,
}: {
  borderColor: string;
  height: number;
}): Record<string, unknown> {
  return {
    backgroundColor: palette.panel,
    border: true,
    borderColor,
    flexDirection: "column",
    height,
    marginBottom: 1,
    padding: 1,
    width: "100%",
  };
}
