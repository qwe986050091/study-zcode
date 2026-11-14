import type { SwitchableCommandCenterMode } from "./types.js";

// 可切换模式全集（含历史遗留的 edit）；顺序即提示中的展示顺序。
// 校验用全集，展示时再过滤 edit，避免旧命令失效但也不主动推荐。
const SWITCHABLE_COMMAND_CENTER_MODES = [
  "plan",
  "build",
  "edit",
  "guarded",
  "yolo",
] as const satisfies readonly SwitchableCommandCenterMode[];

// 返回面向用户展示的可用模式串（逗号分隔），刻意过滤 edit：不推荐但仍可显式使用。
export function formatAvailableCommandCenterModes(): string {
  // 菜单不再推荐 Edit；显式旧命令仍由完整值域校验，不触发模式迁移。
  return SWITCHABLE_COMMAND_CENTER_MODES.filter((mode) => mode !== "edit").join(", ");
}

// 类型守卫：判断字符串是否属于可切换模式全集（包含 edit），不做大小写归一。
export function isSwitchableCommandCenterMode(value: string): value is SwitchableCommandCenterMode {
  return SWITCHABLE_COMMAND_CENTER_MODES.includes(value as SwitchableCommandCenterMode);
}
