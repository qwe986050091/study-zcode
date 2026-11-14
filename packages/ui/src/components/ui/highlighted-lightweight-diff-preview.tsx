// INV-01 超长文本不再高亮：守住位置 字符数上限；改错故障 大 diff 阻塞主线程。
// INV-02 上限按字符数计：守住位置 常量 120000；改错故障 按行数判断漏掉超长单行。
// INV-03 空文本直接跳过高亮：守住位置 effect 首段；改错故障 空串进入 highlighter。
// INV-04 入参变化先清空旧结果：守住位置 effect 首行；改错故障 新文件短暂显示旧颜色。
// INV-05 语言不支持仍走回调：守住位置 shouldUseSyntaxHighlighting；改错故障 纯文本高亮卡死。
// INV-06 取消标志阻止迟到写入：守住位置 cancelled；改错故障 卸载后仍 setState。
// INV-07 同步结果立即写入：守住位置 tokenized 判断；改错故障 首帧无颜色。
// INV-08 清理只置取消位：守住位置 effect 返回函数；改错故障 清理阶段触发额外渲染。
// INV-09 无令牌时返回空：守住位置 render 首段；改错故障 空数组渲染出空片段。
// INV-10 令牌片段带色输出：守住位置 style 构造；改错故障 高亮颜色丢失。
// INV-11 片段键含序号与内容：守住位置 key 拼接；改错故障 重复内容导致 React 警告。
// INV-12 缺色时继承外层颜色：守住位置 条件 style；改错故障 令牌被强制黑色。
// INV-13 高亮文本按行拼接：守住位置 build 函数；改错故障 行号与令牌错位。
// INV-14 行内容仍用原行：守住位置 renderLineContent；改错故障 标记符号被高亮吞掉。
// INV-15 高亮状态写入数据属性：守住位置 data 属性；改错故障 测试无法区分回退态。
// INV-16 其余属性透传底层组件：守住位置 展开 props；改错故障 外层事件与样式丢失。
// INV-17 设置项只取三项：守住位置 类型 Pick；改错故障 无关设置触发重渲。
// INV-18 本组件不持有全局状态：守住位置 仅 useState 令牌；改错故障 多实例共享高亮结果。
//
// 模块职责：带语法高亮的轻量 diff 预览容器。
// 状态所有权：令牌结果为本组件局部状态；高亮器由 lib 层持有缓存。
// 阅读顺序：先看行拆分，再读高亮 hook，最后看渲染与属性透传。
import { useEffect, useMemo, useState, type HTMLAttributes } from "react";
import type { BundledTheme, ThemedToken } from "shiki";
import {
  getLightweightDiffLineParts,
  LightweightDiffPreview,
} from "@/components/ui/lightweight-diff-preview.js";
import {
  highlightCode,
  shouldUseSyntaxHighlighting,
  type TokenizedCode,
} from "@/lib/shikiHighlighter.js";
import { logger } from "@/logger.js";
import type { CodePreviewSettings } from "@/store/index.js";

// 超过 HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS（120_000 字符）就不再高亮，整段回退纯文本。
// HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS 是渲染期性能护栏：主题只影响着色，不改变是否进高亮路径。
const HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS = 120_000;

export function getHighlightedLightweightDiffLine(line: string) {
  const lineParts = getLightweightDiffLineParts(line);
  return {
    code: lineParts.content,
    marker: lineParts.marker,
  };
}

export function buildHighlightedLightweightDiffCode(lines: readonly string[]): string {
  return lines.map((line) => getHighlightedLightweightDiffLine(line).code).join("\n");
}

// code/language/path/theme 一变先清空 tokenizedCode；空文本或超长文本直接返回空，语言不支持时仍调用 onTokens 回调。
// 异步回写前先看 cancelled：effect 清理只把该位翻转，迟到结果因此不会覆盖新一轮的 tokenizedCode。
function useHighlightedLightweightDiffTokens({
  code,
  language,
  path,
  theme,
}: {
  code: string;
  language: string;
  path?: string;
  theme: BundledTheme;
}) {
  const [tokenizedCode, setTokenizedCode] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    setTokenizedCode(null);

    if (!code || code.length > HIGHLIGHTED_LIGHTWEIGHT_DIFF_MAX_CHARS) {
      return;
    }

    const shouldHighlight = shouldUseSyntaxHighlighting(language);
    const startedAt = Date.now();
    let cancelled = false;

    if (shouldHighlight) {
      logger.debug("[HighlightedLightweightDiffPreview] 启动异步 diff 高亮", {
        chars: code.length,
        language,
        path,
        theme,
      });
    }

    const tokenized = highlightCode(code, language, theme, (result) => {
      if (cancelled) {
        return;
      }

      if (shouldHighlight) {
        logger.debug("[HighlightedLightweightDiffPreview] 异步 diff 高亮完成", {
          durationMs: Date.now() - startedAt,
          language,
          path,
          theme,
        });
      }

      setTokenizedCode(result);
    });

    if (tokenized) {
      setTokenizedCode(tokenized);
    }

    return () => {
      cancelled = true;
    };
  }, [code, language, path, theme]);

  return tokenizedCode;
}

// tokens 为空或长度为 0 时返回 null；否则逐令牌生成带色片段，key 由序号与 token.content 组成。
// 缺色沿用外层颜色且内容原样输出；相邻同色片段不合并，保证与高亮器的 token 边界一致。
function renderHighlightedLightweightDiffTokens(tokens: readonly ThemedToken[] | undefined) {
  if (!tokens || tokens.length === 0) {
    return null;
  }

  return tokens.map((token, index) => (
    <span
      key={`${index}:${token.content}`}
      style={token.color ? { color: token.color } : undefined}
    >
      {token.content}
    </span>
  ));
}

function HighlightedLightweightDiffCodeLine({
  code,
  tokens,
}: {
  code: string;
  tokens?: readonly ThemedToken[];
}) {
  const tokenNodes = renderHighlightedLightweightDiffTokens(tokens);

  return <>{tokenNodes ?? (code || " ")}</>;
}

export interface HighlightedLightweightDiffPreviewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  codePreviewSettings: Pick<
    CodePreviewSettings,
    "fontSizePx" | "showLineNumbers" | "wrapLongLines"
  >;
  language: string;
  lines: readonly string[];
  path?: string;
  theme: BundledTheme;
}

// 先把 lines 拼成 code 交给 useHighlightedLightweightDiffTokens；行内容与行号仍由原 lines 提供，高亮结果只按行切分注入。
// data-* 状态写给测试断言，其余 props 透传到底层 diff 预览组件。
export function HighlightedLightweightDiffPreview({
  codePreviewSettings,
  language,
  lines,
  path,
  theme,
  ...props
}: HighlightedLightweightDiffPreviewProps) {
  const highlightCodeText = useMemo(() => buildHighlightedLightweightDiffCode(lines), [lines]);
  const tokenizedCode = useHighlightedLightweightDiffTokens({
    code: highlightCodeText,
    language,
    path,
    theme,
  });

  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-lightweight-diff-highlight-language={language}
      data-lightweight-diff-highlight-theme={theme}
      data-lightweight-diff-highlighted={tokenizedCode ? "true" : "false"}
      lines={lines}
      renderLineContent={(line, index) => (
        <HighlightedLightweightDiffCodeLine
          code={line.content}
          tokens={tokenizedCode?.tokens[index]}
        />
      )}
      {...props}
    />
  );
}
