// TUI 主题内置色板（L2）：定义深/浅两套 TuiThemeTokens 常量及其按 mode 的静态索引。
// 仅提供纯数据，不读写全局状态、不探测终端、不发 IO；运行时切换由 theme/state.ts 负责。
// 深浅色板必须保持同一键集合，新增 token 时两套同步补充，否则渲染组件会取到 undefined。
import type { UiThemeMode } from "@zcode/contracts";
import type { TuiThemeTokens } from "./types.js";

// 未显式配置主题偏好且终端无法探测时的兜底模式，避免启动阶段出现无配色。
// 只在 resolveTuiThemeMode 的最终回退处使用，调用方不应据此判断用户偏好。
export const DEFAULT_TUI_THEME_MODE: UiThemeMode = "dark";

// 内置深色主题的完整 token 表；颜色均为 #RRGGBB 十六进制，供 OpenTUI 直接消费。
// 除 thinkingOpacity（0~1 透明度）外，所有字段都是颜色字符串，不允许缺省。
// 修改任一 token 都会同步影响 palette 兼容层与所有渲染组件，需保持与浅色主题键集合一致。
export const DARK_TUI_THEME: TuiThemeTokens = {
  mode: "dark",
  primary: "#7dd3fc",
  secondary: "#c4b5fd",
  accent: "#7dd3fc",
  error: "#fca5a5",
  warning: "#fbbf24",
  success: "#86efac",
  info: "#93c5fd",
  text: "#e5e7eb",
  textMuted: "#94a3b8",
  selectedListItemText: "#f8fafc",
  background: "#0f1419",
  backgroundPanel: "#161b22",
  backgroundElement: "#1f2937",
  backgroundMenu: "#161b22",
  backgroundMessageUser: "#30363d",
  border: "#3b4450",
  borderActive: "#7dd3fc",
  borderSubtle: "#26313d",
  // diff 语义色：正文/行号/高亮/背景四层，新增用绿系、删除用红系、上下文保持正文色。
  diffAdded: "#86efac",
  diffRemoved: "#fca5a5",
  diffContext: "#e5e7eb",
  diffHunkHeader: "#93c5fd",
  diffHighlightAdded: "#bbf7d0",
  diffHighlightRemoved: "#fecaca",
  diffAddedBg: "#12351e",
  diffRemovedBg: "#3b1717",
  diffContextBg: "#0f1419",
  diffLineNumber: "#94a3b8",
  diffAddedLineNumberBg: "#14532d",
  diffRemovedLineNumberBg: "#7f1d1d",
  // Markdown token 按语义元素拆分：正文/标题/链接/代码/引用等各自独立，便于统一调色。
  markdownText: "#e5e7eb",
  markdownHeading: "#e5e7eb",
  markdownLink: "#7dd3fc",
  markdownLinkText: "#86efac",
  markdownCode: "#86efac",
  markdownBlockQuote: "#fbbf24",
  markdownEmph: "#fbbf24",
  markdownStrong: "#e5e7eb",
  markdownHorizontalRule: "#3b4450",
  markdownListItem: "#7dd3fc",
  markdownListEnumeration: "#7dd3fc",
  markdownImage: "#c4b5fd",
  markdownImageText: "#86efac",
  markdownCodeBlock: "#86efac",
  // 语法高亮 token 对应 shiki 的语义类别，未匹配的 token 回退到正文色。
  syntaxComment: "#94a3b8",
  syntaxKeyword: "#7dd3fc",
  syntaxFunction: "#7dd3fc",
  syntaxVariable: "#e5e7eb",
  syntaxString: "#86efac",
  syntaxNumber: "#fbbf24",
  syntaxType: "#86efac",
  syntaxOperator: "#e5e7eb",
  syntaxPunctuation: "#e5e7eb",
  thinkingOpacity: 0.68,
};

// 内置浅色主题；键集合必须与深色主题完全一致，运行时按 mode 整体替换而无逐字段合并。
// 面向浅底终端：前景色整体加深以保持对比度，diff/markdown 背景改用浅色系。
export const LIGHT_TUI_THEME: TuiThemeTokens = {
  mode: "light",
  primary: "#0369a1",
  secondary: "#7c3aed",
  accent: "#0369a1",
  error: "#b91c1c",
  warning: "#a16207",
  success: "#15803d",
  info: "#2563eb",
  text: "#111827",
  textMuted: "#64748b",
  selectedListItemText: "#0f172a",
  background: "#f8fafc",
  backgroundPanel: "#ffffff",
  backgroundElement: "#e2e8f0",
  backgroundMenu: "#ffffff",
  backgroundMessageUser: "#e0f2fe",
  border: "#cbd5e1",
  borderActive: "#0284c7",
  borderSubtle: "#e5e7eb",
  diffAdded: "#166534",
  diffRemoved: "#991b1b",
  diffContext: "#111827",
  diffHunkHeader: "#1d4ed8",
  diffHighlightAdded: "#15803d",
  diffHighlightRemoved: "#b91c1c",
  diffAddedBg: "#dcfce7",
  diffRemovedBg: "#fee2e2",
  diffContextBg: "#f8fafc",
  diffLineNumber: "#64748b",
  diffAddedLineNumberBg: "#bbf7d0",
  diffRemovedLineNumberBg: "#fecaca",
  markdownText: "#111827",
  markdownHeading: "#111827",
  markdownLink: "#0369a1",
  markdownLinkText: "#15803d",
  markdownCode: "#15803d",
  markdownBlockQuote: "#a16207",
  markdownEmph: "#a16207",
  markdownStrong: "#111827",
  markdownHorizontalRule: "#cbd5e1",
  markdownListItem: "#0369a1",
  markdownListEnumeration: "#0369a1",
  markdownImage: "#7c3aed",
  markdownImageText: "#15803d",
  markdownCodeBlock: "#15803d",
  syntaxComment: "#64748b",
  syntaxKeyword: "#0369a1",
  syntaxFunction: "#0369a1",
  syntaxVariable: "#111827",
  syntaxString: "#15803d",
  syntaxNumber: "#a16207",
  syntaxType: "#15803d",
  syntaxOperator: "#111827",
  syntaxPunctuation: "#111827",
  thinkingOpacity: 0.72,
};

// 模式到 token 表的静态索引；新增模式时必须同步补充，否则 activeTuiTheme 会取到 undefined。
export const BUILTIN_TUI_THEMES: Record<UiThemeMode, TuiThemeTokens> = {
  dark: DARK_TUI_THEME,
  light: LIGHT_TUI_THEME,
};

