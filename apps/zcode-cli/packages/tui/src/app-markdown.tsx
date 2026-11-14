// Markdown 渲染入口（L2）：按运行时组件能力选择 markdown/code/plain 三条渲染路径。
// 读取当前全局主题生成语法样式；样式不可用时降级纯文本，保证内容始终可读。
// 纯展示组件，不持有业务状态、不发 IO；空内容直接输出空 text 节点。
import { baseComponents } from "@mbears/opentui-react";
import React from "react";
import { createMarkdownSyntaxStyle } from "./app-markdown-theme.js";
import { activeTuiTheme } from "./theme/index.js";

// 渲染模式：markdown=交给渲染器做完整 Markdown 解析；code=按代码高亮渲染；
// plain=纯文本兜底，用于终端或运行时缺少对应组件/语法样式的场景。
type MarkdownRenderMode = "markdown" | "code" | "plain";

type MarkdownTextProps = {
  // 覆盖默认 markdownText 前景色；undefined 时回落到当前主题，不做空串判断。
  backgroundColor?: string;
  // 待渲染文本，空串视为“无内容”并直接渲染空 text 节点，不进入解析流程。
  content: string;
  // 自定义前景色，优先级高于主题色；仅在内部预览/特殊消息中使用。
  foregroundColor?: string;
  // 渲染模式；缺省时按运行时组件能力自动探测（见 detectMarkdownRenderMode）。
  mode?: MarkdownRenderMode;
  // 是否为流式增量内容：透传给渲染器以启用增量解析，非流式时一次性布局。
  streaming?: boolean;
};

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 根据运行时提供的组件集合探测可用的最高渲染能力。
// 输入：组件注册表，默认为 baseComponents；传入对象缺少对应字段不影响判断。
// 输出：优先 markdown 组件，其次 code 组件，都没有则返回 "plain"（纯文本兜底）。
// 副作用：无，纯能力探测；不修改传入对象。
export function detectMarkdownRenderMode(
  components: Record<string, unknown> = baseComponents,
): MarkdownRenderMode {
  if (typeof components.markdown === "function") return "markdown";
  if (typeof components.code === "function") return "code";
  return "plain";
}

// 统一的 Markdown 文本渲染入口：按能力与语法样式选择 markdown/code/text 三条路径。
// 输入：content 为空串时直接输出空 text 节点，避免渲染器解析空文档。
// 输出：始终返回 React 元素；不会返回 null，调用方可直接挂载。
// 降级语义：markdown 模式但语法样式构造失败 → 纯文本；code 模式但语法样式缺失 → 纯文本。
// 副作用：读取当前全局主题 activeTuiTheme()，不发起 IO；每次渲染都会重建语法样式（不缓存）。
export function MarkdownText({
  content,
  foregroundColor,
  mode = detectMarkdownRenderMode(),
  streaming = false,
}: MarkdownTextProps): React.ReactElement {
  const theme = activeTuiTheme();
  const textColor = foregroundColor ?? theme.markdownText;
  if (!content) {
    // 空内容无需解析，直接渲染空 text，保证组件始终返回元素而不产生额外节点。
    return h("text", { style: { fg: textColor } }, "");
  }

  const syntaxStyle = createMarkdownSyntaxStyle(theme);
  if (mode === "markdown") {
    if (syntaxStyle) {
      return h("markdown", {
        conceal: true,
        content,
        streaming,
        syntaxStyle,
      });
    }
    // 无语法样式时不放弃渲染，降级为纯文本以保持内容可读。
    return h("text", { style: { fg: textColor } }, content);
  }

  if (mode === "code" && syntaxStyle) {
    return h("code", {
      conceal: true,
      content,
      drawUnstyledText: false,
      fg: textColor,
      filetype: "markdown",
      streaming,
      syntaxStyle,
    });
  }

  return h("text", { style: { fg: textColor } }, content);
}
