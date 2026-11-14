// TUI 主题状态（L2）：保存进程内当前主题模式，提供 token 查询、切换与偏好解析。
// 只维护内存中的模块级单例，不订阅事件、不持久化；跨进程同步与 renderer 背景色由上层负责。
// 模式取值受 UiThemeMode 约束，非法写入会让 activeTuiTheme 返回 undefined，调用前应先过 isTuiThemeMode。
import type { UiThemeMode, UiThemePreference } from "@zcode/contracts";
import { BUILTIN_TUI_THEMES, DEFAULT_TUI_THEME_MODE } from "./defaults.js";
import type { TuiThemeTokens } from "./types.js";

// 进程内共享的当前主题模式；模块单例，切换后所有通过 palette 读取颜色的组件立即生效。
let activeThemeMode: UiThemeMode = DEFAULT_TUI_THEME_MODE;

// 输入：mode 缺省时读取模块单例，因此无参调用等价于“跟随当前全局主题”；未知键不在内置表内，会返回 undefined。
// 引用稳定：同一 mode 恒返回同一 token 对象，可安全用作 useMemo 依赖；但本函数不触发订阅，重绘需调用方安排。
// 返回指定模式（缺省用当前模式）对应的 token 表；引用稳定，便于渲染层做浅比较。
// 返回的是内置常量对象本身，调用方不得就地修改，否则会污染全局主题。
export function activeTuiTheme(mode: UiThemeMode = activeThemeMode): TuiThemeTokens {
  return BUILTIN_TUI_THEMES[mode];
}

// 返回的是调用瞬间的快照，不会随后续 setActiveTuiThemeMode 变化；需要响应式更新应经上层订阅后再读取。
// 与 activeTuiTheme() 无参调用同源，二者读到的是同一模式，不会出现 token 表与 mode 不一致。
// 读取当前生效的主题模式，供订阅方判断是否需要重新渲染。
// 只读查询，不触发通知；跨进程同步或持久化由上层负责。
export function getActiveTuiThemeMode(): UiThemeMode {
  return activeThemeMode;
}

// 切换后新调用 activeTuiTheme 立即返回新 token 表，但已渲染节点不会自动重绘，重绘时机由调用方安排。
// 连续多次调用只保留最后一次值，中间值不可观察；赋值本身是单线程操作，无需加锁。
// 覆盖进程级主题模式；调用方负责同步 renderer 背景色，本函数只更新内存状态，不触发事件。
// 入参不做运行时校验，非法值会让 activeTuiTheme 取到 undefined，故调用前应先过 isTuiThemeMode。
export function setActiveTuiThemeMode(mode: UiThemeMode): void {
  activeThemeMode = mode;
}

// 合并主题偏好与终端探测结果：显式 dark/light 优先，"auto"/缺省则采用终端模式。
// terminalThemeMode 为 null/undefined 时回退到 DEFAULT_TUI_THEME_MODE，保证始终有值。
// 纯函数，不写全局状态；返回"auto"等非法偏好以外的具体模式。
export function resolveTuiThemeMode(
  preference: UiThemePreference | undefined,
  terminalThemeMode: UiThemeMode | null | undefined,
): UiThemeMode {
  if (preference === "dark" || preference === "light") return preference;
  return terminalThemeMode ?? DEFAULT_TUI_THEME_MODE;
}

// 输入为任意 unknown：null/undefined/对象/大写 "Dark" 等一律返回 false，不做 trim 或大小写归一。
// 作为 type guard，返回 true 的分支可把 value 收窄为 UiThemeMode；本函数无副作用，渲染期可安全调用。
// 运行时类型守卫：仅接受 "dark"/"light"，用于过滤终端上报的任意字符串。
// 收口在此，避免各处散落 "=== 'dark' || === 'light'" 的字符串比较。
export function isTuiThemeMode(value: unknown): value is UiThemeMode {
  return value === "dark" || value === "light";
}

