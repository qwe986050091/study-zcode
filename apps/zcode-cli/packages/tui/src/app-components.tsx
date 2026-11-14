// INV-01 分层只读：守住位置 三个导出组件的入参；改错故障：外壳组件读取业务状态，同一布局在不同页面分叉。
// INV-02 停靠覆盖互斥：守住位置 dockedSidebar 与 overlaySidebar 的条件；改错故障：侧边栏同时渲染两份。
// INV-03 主区最小宽：守住位置 APP_MAIN_MIN_WIDTH；改错故障：窄终端下主区被压到不可读。
// INV-04 空命令不占位：守住位置 commands 长度判断；改错故障：没有可选项时仍留出六行空白。
// INV-05 可见窗口收敛：守住位置 visibleSlashCommandWindow 调用；改错故障：选中项越界导致窗口为空。
// INV-06 行高随摘要：守住位置 slashCommandRowHeight；改错故障：窄终端下摘要压到下一行命令上。
// INV-07 面板高度累加：守住位置 panelHeight 的 reduce；改错故障：面板高度与行数不符，内容被裁。
// INV-08 命令名不换行：守住位置 命令文本的 flexShrink；改错故障：长命令名换行挤掉摘要。
// INV-09 选择符定宽：守住位置 SLASH_COMMAND_SELECTOR_WIDTH；改错故障：选中与未选中行左右错位。
// INV-10 宽度归一：守住位置 normalizeSlashCommandContentWidth；改错故障：NaN 宽度传到布局层导致崩溃。
// INV-11 宽度下限：守住位置 最小 8 列与 80 列回退；改错故障：负宽度或零宽度进入换行计算。
// INV-12 反推扣费完整：守住位置 actionPanelContentWidthForTerminal 的减法；改错故障：面板比可用区宽一列而折行。
// INV-13 主区下限参与反推：守住位置 Math.max；改错故障：窄终端反推出负数内容宽。
// INV-14 登录面板定高：守住位置 高度 5；改错故障：父层按测量高度排版，提示被截断。
// INV-15 文案缺省：守住位置 copy 默认值；改错故障：未注入 i18n 的测试环境渲染为空。
// INV-16 覆盖层吃满：守住位置 绝对定位的四边；改错故障：侧边栏覆盖层只盖住部分屏幕。
// INV-17 无副作用：守住位置 全部组件体；改错故障：渲染期间发起订阅或写全局。
// INV-18 行键唯一：守住位置 行元素 key；改错故障：命令增删时终端行错位闪烁。
//
// 模块职责：提供 TUI 主布局、斜杠命令建议面板与未登录提示面板，并集中宽度换算。
// 状态所有权：无状态；选中项、命令列表与 i18n 文案全部由 props 传入。
// 阅读顺序：布局常量 → 外壳 → 建议面板 → 宽度反推 → 登录面板 → 行文本与行高。
// TUI 通用外壳与建议面板（L2）：应用主布局、斜杠命令面板、登录提示面板。
// 仅做布局与文本拟合，不持有业务状态；选择态/命令列表全部由调用方以 props 传入。
// 所有尺寸单位为终端行列；宽度非法时统一回退 80 列、最小 8 列。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { SlashCommand } from "./app-model.js";
import { palette } from "./app-model.js";
import { visibleSlashCommandWindow } from "./app-input.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { SIDEBAR_OVERLAY_BACKGROUND, type SidebarLayout } from "./app-sidebar-layout.js";
import { displayWidth, wordWrappedLineCount } from "./app-terminal-width.js";

// 用 createElement 别名代替 JSX，避免 TUI 场景引入额外编译产物。
// 子节点统一以可变参数传入，空子节点会被渲染库忽略。
//
const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 布局常量（单位：终端行 / 显示列）。
// selector 与 summary gap 参与行高换算；APP_MAIN_MIN_WIDTH 保证侧边栏不会把主区压到不可读。
// 可见条数与面板装饰行数固定，行高换算依赖这两个常量。
// 内容宽度下限 8 列，保证选择符与命令名仍可辨认。
// 主区最小宽度 40 列，防止侧边栏把内容压到不可读。
//
const SLASH_COMMAND_VISIBLE_COUNT = 6;
const SLASH_COMMAND_PANEL_CHROME_ROWS = 2;
const SLASH_COMMAND_FALLBACK_CONTENT_WIDTH = 80;
const MIN_SLASH_COMMAND_CONTENT_WIDTH = 8;
const SLASH_COMMAND_SELECTOR_WIDTH = 2;
const SLASH_COMMAND_SUMMARY_GAP_WIDTH = 2;
const APP_SHELL_HORIZONTAL_PADDING_COLUMNS = 2;
const APP_MAIN_MARGIN_RIGHT_COLUMNS = 1;
const PANEL_HORIZONTAL_CHROME_COLUMNS = 4;
const APP_MAIN_MIN_WIDTH = 40;

// 应用外层布局：左侧主区 + 可选侧边栏。
// sidebarLayout.overlay 为真时侧边栏绝对定位覆盖主区，否则作为 docked 列参与 flex 排布；
// 不可见时两者都为 null。onMouseUp 透传给最外层 box，用于结束文本选择；无其他副作用。
// 两种形态共用同一份 sidebar 子树，切换 docked / overlay 只换外层容器，不会重建内容。
// flexGrow 恒为 1，右边距只在 docked 分支设为 1 列，overlay 下不占位。
// overlay 用 position=absolute 覆盖父级，zIndex 高于主区以免被内容遮住。
//
export function AppShell({
  children,
  onMouseUp,
  sidebar,
  sidebarLayout,
}: {
  children: React.ReactNode;
  onMouseUp?: () => void;
  sidebar: React.ReactNode | null;
  sidebarLayout: SidebarLayout;
}): React.ReactElement {
  const dockedSidebar = sidebarLayout.visible && !sidebarLayout.overlay ? sidebar : null;
  // 覆盖态与停靠态互斥：同一时刻只会渲染其中一个，避免侧边栏出现两份。
  const overlaySidebar = sidebarLayout.visible && sidebarLayout.overlay ? sidebar : null;

  return h(
    "box",
    {
      onMouseUp,
      style: {
        backgroundColor: palette.background,
        flexDirection: "row",
        height: "100%",
        padding: 0,
        width: "100%",
      },
    },
    h(
      "box",
      {
        style: {
          flexDirection: "column",
          flexGrow: 1,
          height: "100%",
          marginRight: dockedSidebar ? 1 : 0,
          minWidth: APP_MAIN_MIN_WIDTH,
          padding: 1,
        },
      },
      children,
    ),
    dockedSidebar,
    overlaySidebar
      ? h(
          "box",
          {
            style: {
              alignItems: "flex-end",
              backgroundColor: SIDEBAR_OVERLAY_BACKGROUND,
              bottom: 0,
              left: 0,
              position: "absolute",
              right: 0,
              top: 0,
              zIndex: 10,
            },
          },
          overlaySidebar,
        )
      : null,
  );
}

// 斜杠命令建议面板。commands 为空返回 null（完全不占布局）。
// 只展示以 selectedIndex 为中心的可见窗口（最多 6 条），每条高度按 summary 换行行数动态计算，
// 因此面板高度随终端宽度变化；contentWidth 缺失或非法时按 80 列。
// 空命令返回空值，完全不占布局高度。
// 可见窗口以选中项为中心，最多六条，越界由窗口函数收敛。
// 每行高度按摘要换行行数计算，终端变宽变窄时面板高度随之变化。
//
export function SlashSuggestionPanel({
  commands,
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  selectedIndex,
}: {
  commands: readonly SlashCommand[];
  contentWidth?: number;
  copy?: TuiCopy;
  selectedIndex: number;
}): React.ReactElement | null {
  // 早退发生在宽度归一化之前，没有命令就不做任何尺寸计算。
  // 返回空值而非空盒子，调用方无需额外判断高度。
  // 这一段也避免了对空数组取选中项而读到 undefined。
  //
  if (commands.length === 0) return null;
  const visible = visibleSlashCommandWindow(commands, selectedIndex, SLASH_COMMAND_VISIBLE_COUNT);
  const rowContentWidth = normalizeSlashCommandContentWidth(contentWidth);
  // Fixed one-row heights let wrapped text draw over later commands in narrow terminals.
  const rows = visible.commands.map((command, index) => {
    const selected = index === visible.selectedIndex;
    const parts = slashCommandRowParts(command, selected);
    return {
      command,
      parts,
      selected,
      height: slashCommandRowHeight(parts, rowContentWidth),
    };
  });
  const panelHeight =
    SLASH_COMMAND_PANEL_CHROME_ROWS + rows.reduce((height, row) => height + row.height, 0);
  return h(
    "box",
    {
      title: copy.slash.title,
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
    ...rows.map((row) =>
      h(
        "box",
        {
          key: row.command.name,
          style: {
            alignItems: "flex-start",
            flexDirection: "row",
            height: row.height,
            width: "100%",
          },
        },
        h(
          "text",
          {
            style: {
              fg: row.selected ? palette.accent : palette.muted,
              flexShrink: 0,
              width: SLASH_COMMAND_SELECTOR_WIDTH,
            },
          },
          row.parts.selector,
        ),
        h(
          "text",
          {
            style: {
              fg: row.selected ? palette.accent : palette.text,
              flexShrink: 0,
              width: displayWidth(row.parts.command),
            },
          },
          row.parts.command,
        ),
        h("text", { style: { fg: palette.muted, flexShrink: 0 } }, "  "),
        h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 1,
              minWidth: 1,
              wrapMode: "word",
            },
          },
          row.parts.summary,
        ),
      ),
    ),
  );
}

// 返回值可直接作为建议面板的 contentWidth 传入，单位显示列，调用方无需再扣 chrome。
// terminalWidth 为非法数时中间结果变成 NaN，最终由归一化函数回退 80，不会产生负宽度。
// 由终端总宽度与侧边栏宽度反推动作面板可用内容宽度：
// 已扣侧边栏、外壳左右 padding、主区右边距与面板边框，主区宽度下限 40 列，最终再归一到 >= 8 列。
// 四个扣减项里只有 sidebarWidth 随布局变化，其余三项是外壳常量，改外壳样式必须同步这里。
// 主区宽度不低于 40 列，避免窄终端算出负值。
// 最终结果再归一到至少 8 列，负数与 NaN 都被收敛。
//
export function actionPanelContentWidthForTerminal(
  terminalWidth: number,
  sidebarWidth: number,
): number {
  const mainMarginRight = sidebarWidth > 0 ? APP_MAIN_MARGIN_RIGHT_COLUMNS : 0;
  const mainWidth = Math.max(
    APP_MAIN_MIN_WIDTH,
    Math.floor(terminalWidth) -
      sidebarWidth -
      APP_SHELL_HORIZONTAL_PADDING_COLUMNS -
      mainMarginRight,
  );
  return normalizeSlashCommandContentWidth(mainWidth - PANEL_HORIZONTAL_CHROME_COLUMNS);
}

// 无交互、无副作用，仅按 copy 渲染；高度固定 5 行，父层布局无需再测量文本。
// copy 缺省时使用 DEFAULT_TUI_COPY，保证未注入 i18n 的测试环境也能渲染。
// 未登录提示面板：固定 5 行高度（边框 + 标题 + 两行文案），文案来自 i18n copy。
// 固定五行高度：边框、标题、两行文案，父层无需测量文本。
// 标题与边框使用警告色，提示当前处于未登录状态。
//
export function LoginRequiredPanel({
  copy = DEFAULT_TUI_COPY,
}: {
  copy?: TuiCopy;
} = {}): React.ReactElement {
  return h(
    "box",
    {
      title: copy.loginRequired.title,
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.warning,
        flexDirection: "column",
        height: 5,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h("text", { style: { fg: palette.warning } }, copy.loginRequired.message),
    h("text", { style: { fg: palette.muted } }, copy.loginRequired.help),
  );
}

// 生成一行的三段文本：选择符（"> " / "  "）、"/命令名"、摘要。不截断，交由布局层处理。
function slashCommandRowParts(
  command: SlashCommand,
  selected: boolean,
): {
  command: string;
  selector: string;
  summary: string;
} {
  return {
    command: `/${command.name}`,
    selector: `${selected ? ">" : " "} `,
    summary: command.summary,
  };
}

// 计算该行高度：摘要可用宽度 = 内容宽 - 选择符 - 命令名 - 间隔，最小 1 列。
// 命令名不换行（flexShrink: 0），因此只有 summary 会影响行数。
// 摘要可用宽度等于内容宽减去选择符、命令名与间隔，最少一列。
// 命令名不换行，因此只有摘要会影响行高。
//
function slashCommandRowHeight(
  parts: ReturnType<typeof slashCommandRowParts>,
  rowContentWidth: number,
): number {
  const summaryWidth = Math.max(
    1,
    rowContentWidth -
      SLASH_COMMAND_SELECTOR_WIDTH -
      displayWidth(parts.command) -
      SLASH_COMMAND_SUMMARY_GAP_WIDTH,
  );
  return wordWrappedLineCount(parts.summary, summaryWidth);
}

// 归一化内容宽度：undefined/NaN/Infinity → 80，其余向下取整并夹到 >= 8。
// 缺失、NaN 与无穷都回退 80 列，其余向下取整。
// 结果下限 8 列，保证后续减法不会得到零或负数。
//
function normalizeSlashCommandContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return SLASH_COMMAND_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MIN_SLASH_COMMAND_CONTENT_WIDTH, Math.floor(contentWidth));
}
