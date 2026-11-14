// 侧栏快捷键的执行层。
// 职责：把按键解析为意图，并执行侧栏显隐或分区折叠。
// 边界：只调用 toggle 回调，不直接改布局状态。
// 副作用：命中时 consumeKey 阻止默认输入，并写状态栏提示。
// 口径：返回 true 表示按键已被消费，false 表示未命中、交给后续分发。

import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, SetStateAction } from "react";
import type { SidebarSectionId } from "./app-sidebar-layout.js";
import {
  resolveSidebarShortcut,
  SIDEBAR_APIS_COLLAPSED_STATUS,
  SIDEBAR_APIS_EXPANDED_STATUS,
  SIDEBAR_FILES_COLLAPSED_STATUS,
  SIDEBAR_FILES_EXPANDED_STATUS,
  SIDEBAR_HIDDEN_STATUS,
  SIDEBAR_LEADER_HINT,
  SIDEBAR_SHOWN_STATUS,
  type SidebarShortcutState,
} from "./app-sidebar-shortcut.js";

// 处理侧边栏快捷键：把原始按键交给 resolveSidebarShortcut 判定意图，再执行对应切换。
// 返回 true 表示按键已被本模块消费，调用方应停止后续快捷键分发；false 表示未命中、透传。
// 副作用：命中时调用 consumeKey（阻止默认输入写入）并通过 setStatus 写状态栏提示。
// 状态口径：仅当 toggleSidebar / toggleSidebarSection 返回切换后的可见性/展开态时，
// 才据此选择"显示/隐藏"文案，避免提示与实际界面不一致。
export function handleSidebarShortcutKey(input: {
  consumeKey: (key: KeyEvent) => void;
  key: KeyEvent;
  nowMs: number;
  setStatus: Dispatch<SetStateAction<string>>;
  shortcutState: SidebarShortcutState;
  toggleSidebar: () => boolean;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
}): boolean {
  const sidebarIntent = resolveSidebarShortcut(input.shortcutState, input.key, input.nowMs);

  if (sidebarIntent === "arm") {
    // leader 键本身不切换任何状态，只进入等待后续字母的窗口并给出提示。
    input.consumeKey(input.key);
    input.setStatus(SIDEBAR_LEADER_HINT);
    return true;
  }
  if (sidebarIntent === "toggle") {
    input.consumeKey(input.key);
    input.setStatus(input.toggleSidebar() ? SIDEBAR_SHOWN_STATUS : SIDEBAR_HIDDEN_STATUS);
    return true;
  }
  if (sidebarIntent === "toggle-files") {
    // 分区切换只影响该分区的展开态；返回值直接决定状态栏用 expanded/collapsed 文案。
    input.consumeKey(input.key);
    input.setStatus(
      input.toggleSidebarSection("modifiedFiles")
        ? SIDEBAR_FILES_EXPANDED_STATUS
        : SIDEBAR_FILES_COLLAPSED_STATUS,
    );
    return true;
  }
  if (sidebarIntent === "toggle-apis") {
    input.consumeKey(input.key);
    input.setStatus(
      input.toggleSidebarSection("apis")
        ? SIDEBAR_APIS_EXPANDED_STATUS
        : SIDEBAR_APIS_COLLAPSED_STATUS,
    );
    return true;
  }

  return false;
}
