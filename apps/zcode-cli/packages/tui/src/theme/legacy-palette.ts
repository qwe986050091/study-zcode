// 旧版调色板兼容层（L2）：把新 token 映射为历史语义色名，并提供随主题切换自动更新的代理。
// 纯函数映射 + Proxy 读取，不持久化、不发事件；每次属性访问都从当前 active 主题即时换算。
// 新增 token 不会自动出现在旧调色板，需要兼容时须在 LEGACY_PALETTE_KEYS 与映射表显式登记。
import { activeTuiTheme } from "./state.js";
import type { TuiLegacyPalette, TuiThemeTokens } from "./types.js";

// 旧版调色板允许枚举的键集合；代理的 ownKeys/属性描述符只暴露这些键。
const LEGACY_PALETTE_KEYS = [
  "accent",
  "background",
  "border",
  "danger",
  "muted",
  "panel",
  "panelAlt",
  "success",
  "text",
  "userMessageBackground",
  "warning",
] as const satisfies readonly (keyof TuiLegacyPalette)[];

// 新版 token 到旧版语义名的只读映射；danger/muted/panel 等旧名在此统一对齐到新 token。
// 纯函数，无副作用；返回全新对象，调用方修改不会污染主题 token。
// 映射键固定，新增 token 不会自动出现在旧调色板，需要兼容时须显式登记。
export function themeToLegacyPalette(theme: TuiThemeTokens): TuiLegacyPalette {
  return {
    accent: theme.accent,
    background: theme.background,
    border: theme.border,
    danger: theme.error,
    muted: theme.textMuted,
    panel: theme.backgroundPanel,
    panelAlt: theme.backgroundElement,
    success: theme.success,
    text: theme.text,
    userMessageBackground: theme.backgroundMessageUser,
    warning: theme.warning,
  };
}

// 兼容旧代码的 palette 代理：每次读取都从当前 active 主题即时换算，主题切换后无需刷新引用。
// 非字符串键（如 Symbol）返回 undefined；未知属性不暴露描述符，避免 Object.keys 混入脏键。
// 代价是每次属性访问都要重建一次映射对象，适合渲染期读取，不要在热循环里反复取整份 palette。
export const palette = new Proxy({} as TuiLegacyPalette, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return themeToLegacyPalette(activeTuiTheme())[property as keyof TuiLegacyPalette];
  },
  getOwnPropertyDescriptor(_target, property) {
    // 只描述白名单键；返回 undefined 使 for...in / spread 不会枚举到代理内部属性。
    if (!LEGACY_PALETTE_KEYS.includes(property as keyof TuiLegacyPalette)) return undefined;
    return {
      configurable: true,
      enumerable: true,
      value: themeToLegacyPalette(activeTuiTheme())[property as keyof TuiLegacyPalette],
    };
  },
  ownKeys() {
    return [...LEGACY_PALETTE_KEYS];
  },
}) as TuiLegacyPalette;

