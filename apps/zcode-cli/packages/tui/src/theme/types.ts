// TUI 主题类型契约（L2）：定义渲染层消费的完整 token 结构与旧版调色板视图。
// 仅含类型声明，无运行时逻辑与副作用；所有颜色字段为 #RRGGBB 字符串，thinkingOpacity 为 0~1。
// 深浅主题必须实现同一键集合，组件按语义取色，不在业务代码里硬编码颜色。
import type { UiThemeMode, UiThemePreference } from "@zcode/contracts";

// 重新导出 contracts 的主题类型，保持 TUI 包内引用入口统一。
export type { UiThemeMode as TuiThemeMode, UiThemePreference as TuiThemePreference };

// 完整主题 token 契约：所有颜色字段均为 #RRGGBB 字符串，thinkingOpacity 为 0~1 数字。
// 深浅主题必须实现同一键集合；components 直接按语义取色，不自行硬编码颜色。
// mode 仅用于标识来源主题，不参与渲染。
export type TuiThemeTokens = {
  // 主题模式标识：与色板一一对应（dark/light），仅用于标明来源，不参与取色。
  mode: UiThemeMode;
  // 主色：强调按钮、聚焦边框与主要图标。
  primary: string;
  // 次色：与主色配合的辅助强调，用于图片等次级高亮。
  secondary: string;
  // 强调色：表示"当前动作/选中"，通常与 primary 同值。
  accent: string;
  // 错误色：失败文本、错误边框与危险操作提示。
  error: string;
  // 警告色：system 消息与需要注意但不阻断的提示。
  warning: string;
  // 成功色：完成态标记与通过类提示。
  success: string;
  // 信息色：中性提示与链接型信息。
  info: string;
  // 正文默认前景色。
  text: string;
  // 次要文本：元信息、占位说明与弱化描述。
  textMuted: string;
  // 选中列表项的前景色，需与选中背景保持可读对比。
  selectedListItemText: string;
  // 应用主背景。
  background: string;
  // 面板背景：侧栏、浮层与卡片。
  backgroundPanel: string;
  // 次级块背景：内嵌块与代码块底色。
  backgroundElement: string;
  // 菜单/建议列表背景。
  backgroundMenu: string;
  // 用户消息行背景，需与 text 形成可读对比。
  backgroundMessageUser: string;
  // 默认边框。
  border: string;
  // 激活/聚焦边框，当前焦点控件使用。
  borderActive: string;
  // 弱分割线，用于非强调的区块分隔。
  borderSubtle: string;
  // diff 家族：正文色、行号色、高亮色与背景色，用于 shiki diff 与内置 diff 视图。
  // 新增行正文前景。
  diffAdded: string;
  // 删除行正文前景。
  diffRemoved: string;
  // 上下文行正文前景。
  diffContext: string;
  // hunk 头（@@ -a,b +c,d @@）前景。
  diffHunkHeader: string;
  // 行内词级高亮：新增片段。
  diffHighlightAdded: string;
  // 行内词级高亮：删除片段。
  diffHighlightRemoved: string;
  // 新增行的整行背景。
  diffAddedBg: string;
  // 删除行的整行背景。
  diffRemovedBg: string;
  // 上下文行的整行背景。
  diffContextBg: string;
  // 行号列前景。
  diffLineNumber: string;
  // 新增行行号槽背景。
  diffAddedLineNumberBg: string;
  // 删除行行号槽背景。
  diffRemovedLineNumberBg: string;
  // Markdown 家族：逐语义元素配色，未覆盖的元素回退到 markdownText。
  // markdown 正文默认色。
  markdownText: string;
  // 标题（# 到 ######）。
  markdownHeading: string;
  // 链接 URL 部分。
  markdownLink: string;
  // 链接显示文本。
  markdownLinkText: string;
  // 行内代码与代码块文本。
  markdownCode: string;
  // 引用块（>）文本。
  markdownBlockQuote: string;
  // 斜体文本。
  markdownEmph: string;
  // 粗体文本。
  markdownStrong: string;
  // 水平分隔线。
  markdownHorizontalRule: string;
  // 无序列表项目符号。
  markdownListItem: string;
  // 有序列表序号。
  markdownListEnumeration: string;
  // 图片占位标记。
  markdownImage: string;
  // 图片替代文本。
  markdownImageText: string;
  // 围栏代码块整体前景色。
  markdownCodeBlock: string;
  // 语法高亮家族：对应代码 token 类别，由高亮器按 token 类型映射。
  // 注释。
  syntaxComment: string;
  // 关键字（if/return/import 等）。
  syntaxKeyword: string;
  // 函数/方法名。
  syntaxFunction: string;
  // 变量与标识符。
  syntaxVariable: string;
  // 字符串字面量。
  syntaxString: string;
  // 数字字面量。
  syntaxNumber: string;
  // 类型名（含泛型参数）。
  syntaxType: string;
  // 运算符。
  syntaxOperator: string;
  // 标点符号。
  syntaxPunctuation: string;
  // 思考块整体透明度，取值 0~1，用于弱化推理内容。
  thinkingOpacity: number;
};

// 旧版调色板契约，供未迁移到 token 的组件使用；由 themeToLegacyPalette 从 TuiThemeTokens 派生。
// danger 对应 error、muted 对应 textMuted、panel/panelAlt 对应 backgroundPanel/backgroundElement。
export type TuiLegacyPalette = {
  // 强调色，派生自 accent。
  accent: string;
  // 应用主背景，派生自 background。
  background: string;
  // 默认边框，派生自 border。
  border: string;
  // 危险/错误色，派生自 error。
  danger: string;
  // 弱化文本，派生自 textMuted。
  muted: string;
  // 面板背景，派生自 backgroundPanel。
  panel: string;
  // 次级面板背景，派生自 backgroundElement。
  panelAlt: string;
  // 成功色，派生自 success。
  success: string;
  // 正文色，派生自 text。
  text: string;
  // 用户消息背景，派生自 backgroundMessageUser。
  userMessageBackground: string;
  // 警告色，派生自 warning。
  warning: string;
};

