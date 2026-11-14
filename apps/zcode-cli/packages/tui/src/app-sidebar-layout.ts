// 侧栏布局计算与本地 UI 偏好。
// 职责：按终端宽度推导可见/浮层/占宽，并维护分区展开态。
// 边界：只保存界面偏好与展开态，不承载 session 业务数据。
// 副作用：订阅终端尺寸变化；状态仅存组件内，不落盘、不下发。
// 不变量：layout 恒由 (terminalWidth, state) 纯函数推导，避免多处重复计算。

import { RGBA } from "@mbears/opentui-core";
import { useTerminalDimensions } from "@mbears/opentui-react";
import { useCallback, useMemo, useState } from "react";

// 侧边栏布局常量：总宽 42 列、左右各 1 列内边距，内容区 40 列；
// 终端宽度超过 120 列时默认自动显示侧边栏，否则需要用户手动唤出（以浮层形式覆盖）。
export const SIDEBAR_WIDTH = 42;
// 侧栏左右各留 1 列内边距；它与 SIDEBAR_WIDTH 联动，改动时须同步保证内容区宽度为正。
export const SIDEBAR_HORIZONTAL_PADDING_COLUMNS = 1;
// 内容区可用列数（单位：列）：渲染行宽、文本截断与分区布局都以它为基准，不直接使用 SIDEBAR_WIDTH。
export const SIDEBAR_CONTENT_WIDTH = SIDEBAR_WIDTH - SIDEBAR_HORIZONTAL_PADDING_COLUMNS * 2;
const SIDEBAR_AUTO_VISIBLE_BREAKPOINT = 120;
// 窄终端浮层遮罩：黑色、alpha 70（约 27% 不透明），压暗被覆盖的主内容；RGBA 不可变，不得就地改写。
export const SIDEBAR_OVERLAY_BACKGROUND = RGBA.fromInts(0, 0, 0, 70);

type SidebarPreference = "auto" | "hidden";
// 侧边栏分区标识：与 SidebarState 的 section 顺序解耦，新增分区时此联合类型必须同步扩展。
export type SidebarSectionId = "apis" | "mcp" | "modifiedFiles" | "todos" | "subagents";
// 各分区展开态映射：缺省全部展开；只保存 UI 交互态，不承载业务数据。
export type SidebarSectionExpansion = Record<SidebarSectionId, boolean>;

type SidebarControllerState = {
  narrowOverlayOpen: boolean;
  preference: SidebarPreference;
  sections: SidebarSectionExpansion;
};

// 布局计算结果：visible 为最终是否渲染，wide 表示终端是否达到自动显示阈值；
// overlay 为 true 时侧边栏浮在内容之上（不占列宽），reservedWidth 是主内容需要让出的列数。
// 三者不变量：reservedWidth > 0 时必满足 visible 且非 overlay；overlay 时 reservedWidth 为 0。
export type SidebarLayout = {
  overlay: boolean;
  reservedWidth: number;
  visible: boolean;
  wide: boolean;
};

type SidebarController = {
  layout: SidebarLayout;
  sections: SidebarSectionExpansion;
  terminalWidth: number;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
  toggleSidebar: () => boolean;
};

// 默认状态：preference 为 auto（宽终端自动显示、窄终端隐藏），所有分区默认展开。
// narrowOverlayOpen 记录窄终端下用户手动唤出的浮层是否打开，切换 session 时由调用方重置。
export const DEFAULT_SIDEBAR_STATE: SidebarControllerState = {
  narrowOverlayOpen: false,
  preference: "auto",
  sections: {
    subagents: true,
    apis: true,
    mcp: true,
    modifiedFiles: true,
    todos: true,
  },
};

// 侧边栏控制器 hook：订阅终端尺寸并维护本地 UI 偏好（preference/浮层开关/分区展开态）。
// 返回 layout（当前渲染参数）、sections（展开态）、terminalWidth（取整后的列数）
// 以及两个切换函数。切换函数同步返回切换后的结果，便于调用方立即写状态提示。
// 副作用：订阅终端尺寸变化（useTerminalDimensions）；状态仅存于组件内，不落盘、不下发。
// 维护的不变量：layout 始终由 (terminalWidth, state) 纯函数推导，避免多处重复计算导致不一致。
export function useSidebarController(): SidebarController {
  const { width } = useTerminalDimensions();
  const [state, setState] = useState<SidebarControllerState>(DEFAULT_SIDEBAR_STATE);
  const terminalWidth = Math.floor(width);
  const layout = useMemo(
    () => sidebarLayoutForTerminal(terminalWidth, state),
    [state, terminalWidth],
  );
  const toggleSidebar = useCallback(() => {
    const nextState = toggleSidebarState(state, terminalWidth);
    const nextLayout = sidebarLayoutForTerminal(terminalWidth, nextState);

    setState(nextState);
    return nextLayout.visible;
  }, [state, terminalWidth]);
  const toggleSidebarSection = useCallback(
    (section: SidebarSectionId) => {
      const sections = toggleSidebarSectionState(state.sections, section);
      setState({ ...state, sections });
      return sections[section];
    },
    [state],
  );

  return {
    layout,
    sections: state.sections,
    terminalWidth,
    toggleSidebarSection,
    toggleSidebar,
  };
}

// 由终端宽度与控制器状态推导布局：
// 可见性 = 窄屏浮层已打开 || (偏好 auto 且终端足够宽)；浮层 = 可见但不宽。
// 只有内联显示（可见且非浮层）才占用列宽，浮层模式主内容宽度不变。
export function sidebarLayoutForTerminal(
  terminalWidth: number,
  state: SidebarControllerState,
): SidebarLayout {
  const wide = isWideSidebarTerminal(terminalWidth);
  const visible = state.narrowOverlayOpen || (state.preference === "auto" && wide);
  const overlay = visible && !wide;

  return {
    overlay,
    reservedWidth: visible && !overlay ? SIDEBAR_WIDTH : 0,
    visible,
    wide,
  };
}

// 切换侧边栏可见性并返回新状态（纯函数，不修改入参）：
// 当前可见时改为 hidden 并关闭浮层；当前不可见时回到 auto，窄终端同时打开浮层。
// 宽终端不设置 narrowOverlayOpen，因为 auto 偏好本身已足以让它显示。
export function toggleSidebarState(
  state: SidebarControllerState,
  terminalWidth: number,
): SidebarControllerState {
  const layout = sidebarLayoutForTerminal(terminalWidth, state);
  if (layout.visible) {
    return {
      narrowOverlayOpen: false,
      preference: "hidden",
      sections: state.sections,
    };
  }

  return {
    narrowOverlayOpen: !layout.wide,
    preference: "auto",
    sections: state.sections,
  };
}

// 分区宽度阈值判定：终端列数向下取整后严格大于 120 才视为宽屏，等于 120 仍按窄屏处理。
function isWideSidebarTerminal(terminalWidth: number): boolean {
  return Math.floor(terminalWidth) > SIDEBAR_AUTO_VISIBLE_BREAKPOINT;
}

// 输入：section 由 SidebarSectionId 约束；映射中缺该键时按 undefined 取反得到 true，不会抛错。
// 返回新对象而非原地修改，调用方可据返回值中的 [section] 立即得知切换后的展开态，无需再推导。
// 切换单个分区的展开态并返回新映射（浅拷贝），仅翻转目标分区，其余分区原样保留。
export function toggleSidebarSectionState(
  sections: SidebarSectionExpansion,
  section: SidebarSectionId,
): SidebarSectionExpansion {
  return {
    ...sections,
    [section]: !sections[section],
  };
}
