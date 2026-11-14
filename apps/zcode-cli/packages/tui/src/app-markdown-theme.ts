// Markdown 高亮主题适配（L2）：把 TuiThemeTokens 转换为渲染器可用的 SyntaxStyle。
// 规则表顺序即匹配优先级，纯函数输出；构造失败返回 undefined，由调用方降级为纯文本。
// 不缓存、不访问全局状态，每次调用都基于传入 theme 重新生成。
import { SyntaxStyle, type ThemeTokenStyle } from "@mbears/opentui-core";
import type { TuiThemeTokens } from "./theme/index.js";

// 依据当前主题 tokens 生成 Markdown 高亮规则表（Tree-sitter scope → 样式）。
// 输入：已解析的 TuiThemeTokens（前台/背景/语法色均非空字符串）。
// 输出：按渲染器约定顺序排列的 ThemeTokenStyle[]，供 SyntaxStyle.fromTheme 消费；
// 数组顺序即匹配优先级，越靠前的 scope 越具体（如 markup.heading.1 先于 default）。
// 副作用：无，纯函数，不访问全局主题或 IO；每次调用都返回新数组，调用方可安全缓存结果。
// 不变量：所有 scope 都必须能映射到一个主题颜色，避免渲染时回落到终端默认色导致主题不一致。
export function markdownSyntaxRules(theme: TuiThemeTokens): ThemeTokenStyle[] {
  return [
    token(["default"], { foreground: theme.markdownText }),
    token(["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3"], {
      bold: true,
      foreground: theme.markdownHeading,
    }),
    token(["markup.heading.4", "markup.heading.5", "markup.heading.6"], {
      bold: true,
      foreground: theme.markdownHeading,
    }),
    token(["markup.bold", "markup.strong"], {
      bold: true,
      foreground: theme.markdownStrong,
    }),
    token(["markup.italic"], { foreground: theme.markdownEmph, italic: true }),
    token(["markup.list"], { foreground: theme.markdownListItem }),
    token(["markup.quote"], { foreground: theme.markdownBlockQuote, italic: true }),
    token(["markup.raw", "markup.raw.block"], { foreground: theme.markdownCodeBlock }),
    token(["markup.raw.inline"], {
      background: theme.backgroundPanel,
      foreground: theme.markdownCode,
    }),
    token(["markup.link", "markup.link.url"], {
      foreground: theme.markdownLink,
      underline: true,
    }),
    token(["markup.link.label", "label"], {
      foreground: theme.markdownLinkText,
      underline: true,
    }),
    token(["conceal"], { foreground: theme.textMuted }),
    token(["comment"], { foreground: theme.syntaxComment, italic: true }),
    token(["string", "symbol"], { foreground: theme.syntaxString }),
    token(["number", "boolean"], { foreground: theme.syntaxNumber }),
    token(["keyword"], { foreground: theme.syntaxKeyword }),
    token(["function", "function.call", "function.method.call"], {
      foreground: theme.syntaxFunction,
    }),
    token(["type", "type.builtin"], { foreground: theme.syntaxType }),
    token(["operator"], { foreground: theme.syntaxOperator }),
    token(["punctuation", "punctuation.bracket"], { foreground: theme.syntaxPunctuation }),
    token(["diff.plus"], { foreground: theme.diffAdded }),
    token(["diff.minus"], { foreground: theme.diffRemoved }),
    token(["diff.delta"], { foreground: theme.diffHunkHeader }),
    token(["error"], { foreground: theme.error }),
    token(["warning"], { foreground: theme.warning }),
    token(["info"], { foreground: theme.info }),
  ];
}

// 把主题规则包装成渲染器可用的 SyntaxStyle；失败时返回 undefined 而不是抛错。
// 降级语义：渲染器不接受该规则集（如未知 scope 或解析器缺失）时，调用方据此退回纯文本渲染，
// 保证 Markdown 内容在能力不足的终端仍可读，不影响主流程。
// 副作用：仅一次同步构造，无 IO/缓存；不会修改传入的 theme。
export function createMarkdownSyntaxStyle(theme: TuiThemeTokens): SyntaxStyle | undefined {
  try {
    return SyntaxStyle.fromTheme(markdownSyntaxRules(theme));
  } catch {
    // 语法高亮属于增益能力，构造失败不应中断消息渲染，交由调用方降级为纯文本。
    return undefined;
  }
}

// 组装单条 scope → 样式的映射项；scope 为 Tree-sitter 节点名数组，style 为对应的颜色/字重修饰。
function token(
  scope: string[],
  style: ThemeTokenStyle["style"],
): ThemeTokenStyle {
  return { scope, style };
}
