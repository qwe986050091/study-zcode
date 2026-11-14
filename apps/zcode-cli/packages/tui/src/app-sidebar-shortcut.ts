// 侧栏 leader 快捷键解析。
// 职责：识别 Ctrl+X 前缀与后续 b/m/a，返回侧栏显隐或分区折叠意图。
// 边界：只解析按键，不执行布局切换、不写状态栏。
// 副作用：原地更新 state.leaderArmedUntilMs（arm 或清空）。
// 口径：leader 在 2s 窗口内有效，超时自动失效并透传按键。

// leader 按键有效期：按下 leader（Ctrl+X）后 2s 内接受后续字母，超时则自动失效，
// 避免误按后长时间"吞掉"用户的普通输入。
const SIDEBAR_LEADER_TIMEOUT_MS = 2_000;
// 状态栏文案常量：集中定义便于统一措辞/国际化替换，keyboard 层只做选择不做拼接。
export const SIDEBAR_LEADER_HINT = "Press B for sidebar, M for files, A for APIs.";
// 收起/展开状态文案（两两成对）：collapsed/expanded 与 resolveSidebarShortcut 的 toggle 意图一一对应，
// 供状态栏在切换后立即提示；文案用完成时态，统一为 "<对象> collapsed/expanded." 句式。
// 侧栏整体显隐与分区折叠共用同一状态栏通道，由 keyboard 层按意图选词，不在此拼接。
export const SIDEBAR_HIDDEN_STATUS = "Sidebar hidden.";
// 侧栏由隐藏切换为可见后的状态栏反馈（对应 toggle 意图）。
export const SIDEBAR_SHOWN_STATUS = "Sidebar shown.";
// APIs 分区由展开切换为折叠后的状态栏反馈（对应 toggle-apis 意图）。
export const SIDEBAR_APIS_COLLAPSED_STATUS = "APIs collapsed.";
// APIs 分区由折叠切换为展开后的状态栏反馈（对应 toggle-apis 意图）。
export const SIDEBAR_APIS_EXPANDED_STATUS = "APIs expanded.";
// Modified files 分区由展开切换为折叠后的状态栏反馈（对应 toggle-files 意图）。
export const SIDEBAR_FILES_COLLAPSED_STATUS = "Modified files collapsed.";
// Modified files 分区由折叠切换为展开后的状态栏反馈（对应 toggle-files 意图）。
export const SIDEBAR_FILES_EXPANDED_STATUS = "Modified files expanded.";

type SidebarShortcutKey = {
  ctrl?: boolean;
  meta?: boolean;
  name: string;
  option?: boolean;
  shift?: boolean;
};

// leader 组合键状态：leaderArmedUntilMs 为绝对时间戳（毫秒），undefined 表示未 armed。
// 该对象由 resolveSidebarShortcut 原地更新（清空或重新 arm），调用方持有同一引用。
export type SidebarShortcutState = {
  leaderArmedUntilMs?: number;
};

type SidebarShortcutIntent = "arm" | "pass" | "toggle-apis" | "toggle-files" | "toggle";

// 空对象即「未 armed」：resolveSidebarShortcut 只在该字段存在且未过期时才匹配组合键。
// 每次调用都返回全新对象，避免多个调用方共享同一引用相互污染 leader 窗口。
// 创建初始快捷键状态：未 armed（无待生效窗口）。
export function createSidebarShortcutState(): SidebarShortcutState {
  return {};
}

// 解析侧边栏快捷键意图，返回 "arm"(按下 leader) / "toggle"/"toggle-files"/"toggle-apis"（命中组合）/ "pass"（不相关，透传）。
// 输入 nowMs 由调用方注入以便测试；timeoutMs 缺省 2s，可覆盖用于构造超时场景。
// 副作用：原地修改 state.leaderArmedUntilMs——命中组合或未命中时清空，按下 leader 时写入截止时间。
// 判定顺序：leader 生效期内优先匹配 b/m/a，其次才判断是否按下 leader，最后清空并透传；
// 这样 leader 键本身的重复按下不会误触发 toggle。
export function resolveSidebarShortcut(
  state: SidebarShortcutState,
  key: SidebarShortcutKey,
  nowMs: number,
  timeoutMs = SIDEBAR_LEADER_TIMEOUT_MS,
): SidebarShortcutIntent {
  const leaderActive =
    state.leaderArmedUntilMs !== undefined && nowMs <= state.leaderArmedUntilMs;

  if (leaderActive && isSidebarToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle";
  }
  if (leaderActive && isModifiedFilesToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle-files";
  }
  if (leaderActive && isApisToggleKey(key)) {
    state.leaderArmedUntilMs = undefined;
    return "toggle-apis";
  }

  if (isSidebarLeaderKey(key)) {
    state.leaderArmedUntilMs = nowMs + timeoutMs;
    return "arm";
  }

  state.leaderArmedUntilMs = undefined;
  return "pass";
}

// leader 键判定：仅 Ctrl+X（不区分大小写）作为前缀，不引入 meta/option 组合以免与系统快捷键冲突。
function isSidebarLeaderKey(key: SidebarShortcutKey): boolean {
  return key.name.toLowerCase() === "x" && key.ctrl === true;
}

// 侧边栏整体显隐快捷键：leader 之后按 b。
function isSidebarToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "b");
}

// 已修改文件分区折叠快捷键：leader 之后按 m。
function isModifiedFilesToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "m");
}

// API 分区折叠快捷键：leader 之后按 a。
function isApisToggleKey(key: SidebarShortcutKey): boolean {
  return isPlainLeaderFollowupKey(key, "a");
}

// leader 后续键的通用判定：字母匹配（忽略大小写）且不带 ctrl/meta/option 修饰，
// 允许 shift（即大写字母），否则视为其它组合键不参与侧边栏切换。
function isPlainLeaderFollowupKey(key: SidebarShortcutKey, name: string): boolean {
  return (
    key.name.toLowerCase() === name &&
    key.ctrl !== true &&
    key.meta !== true &&
    key.option !== true
  );
}
