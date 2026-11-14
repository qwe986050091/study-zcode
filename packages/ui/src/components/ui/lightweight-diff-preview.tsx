// INV-01 纯展示：守住位置 组件与解析函数；改错故障：渲染期改动入参或发起副作用。
// INV-02 首字符判定：守住位置 行类型识别；改错故障：行中出现加号被误判为新增。
// INV-03 原文保留：守住位置 raw 字段；改错故障：调用方拿不到未处理的原始行。
// INV-04 前缀剥离：守住位置 内容提取；改错故障：界面把统一 diff 的标记当代码显示。
// INV-05 空标记：守住位置 无前缀分支；改错故障：上下文行被标成已修改。
// INV-06 配色同源：守住位置 行号与行背景取色；改错故障：两处色值漂移，主题切换不一致。
// INV-07 上下文克制：守住位置 上下文行样式；改错故障：无增删的行也被涂上底色。
// INV-08 内容宽度：守住位置 内层滚动面；改错故障：短行背景提前结束，横向出现断层。
// INV-09 行号粘性：守住位置 行号列定位；改错故障：横向滚动时行号被推出视野。
// INV-10 行号可关：守住位置 行号条件渲染；改错故障：关闭设置后仍占一列宽度。
// INV-11 截断优先：守住位置 标记行识别；改错故障：截断提示被当成代码行参与编号。
// INV-12 空行占位：守住位置 内容回退；改错故障：空行高度塌陷，行号与内容错位。
// INV-13 字号直写：守住位置 内层 style；改错故障：字号设置被类名覆盖。
// INV-14 换行切换：守住位置 换行分支；改错故障：关闭换行后仍折行，内容宽度失真。
// INV-15 属性透传：守住位置 外层 div；改错故障：宿主测试标识与事件丢失。
// INV-16 受控渲染：守住位置 renderLineContent；改错故障：自定义渲染被内置内容覆盖。
// INV-17 无障碍：守住位置 行号 aria-hidden；改错故障：读屏把行号当正文朗读。
// INV-18 键稳定：守住位置 行列表 key；改错故障：滚动或更新时行状态错挂到相邻行。
//
// 模块职责：轻量 diff 的行解析、配色与只读预览组件。
// 状态所有权：无状态；行数据与预览设置全部由调用方传入。
// 阅读顺序：类型 → 行解析 → 配色 → 预览组件。
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getPatchPreviewLineContent,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/store/index.js";

// LightweightDiffLineKind 只有 added / removed / context，不引入修改态
// context 行的 marker 固定为空串，内容取自 getPatchPreviewLineContent
// parseLightweightDiffLines 按行返回，组件内不缓存结果
//
export type LightweightDiffLineKind = "added" | "removed" | "context";

export interface LightweightDiffLineParts {
  content: string;
  kind: LightweightDiffLineKind;
  marker: string;
  raw: string;
}

type LightweightDiffLineStyles = {
  gutterStyle?: CSSProperties;
  lineNumberClassName: string;
  rowStyle?: CSSProperties;
};

// 设置项只取三个与排版相关的字段，避免整包穿透。
// 隐藏原生 children，行内容改由 lines 驱动。
// 行内容渲染函数可选，缺省显示剥离前缀后的文本。
//
export interface LightweightDiffPreviewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  codePreviewSettings: Pick<
    CodePreviewSettings,
    "fontSizePx" | "showLineNumbers" | "wrapLongLines"
  >;
  lines: readonly string[];
  renderLineContent?: (line: LightweightDiffLineParts, index: number) => ReactNode;
}

// 只按首个字符判定增删，不改写原始行文本。
// raw 保留原始行，供调用方自行解析。
// 标记为空表示这行没有统一 diff 前缀。
// 内容统一交给 patchDiffPreview 提取，剥离前缀。
// 四种分支返回同一结构，调用方无需区分。
//
export function getLightweightDiffLineParts(line: string): LightweightDiffLineParts {
  if (line.startsWith("+")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "added",
      marker: "+",
      raw: line,
    };
  }

  if (line.startsWith("-")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "removed",
      marker: "-",
      raw: line,
    };
  }

  if (line.startsWith(" ")) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: "context",
      marker: " ",
      raw: line,
    };
  }

  return {
    content: getPatchPreviewLineContent(line),
    kind: "context",
    marker: "",
    raw: line,
  };
}

// added / removed 各自返回 rowStyle 与 gutterStyle
// lineNumberClassName 与 rowStyle 同用 --color-diff-* 变量，避免色值漂移
// context 只给 text-foreground-subtlest 行号色，不设 rowStyle
// 颜色经 color-mix 与面板色混合，适配深浅主题。
// 样式按类型一次性算好，渲染循环内不重复判断。
//
function getLightweightDiffLineStyles(kind: LightweightDiffLineKind): LightweightDiffLineStyles {
  if (kind === "added") {
    return {
      lineNumberClassName: "text-diff-added",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
      },
      gutterStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-added) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-added)",
        color: "var(--color-diff-added)",
      },
    };
  }

  if (kind === "removed") {
    return {
      lineNumberClassName: "text-diff-removed",
      rowStyle: {
        backgroundColor: "color-mix(in srgb, var(--color-diff-removed) 14%, transparent)",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
      },
      gutterStyle: {
        backgroundColor:
          "color-mix(in srgb, var(--color-diff-removed) 18%, var(--color-background))",
        boxShadow: "inset 3px 0 0 var(--color-diff-removed)",
        color: "var(--color-diff-removed)",
      },
    };
  }

  return {
    lineNumberClassName: "text-foreground-subtlest",
    gutterStyle: {
      backgroundColor: "var(--color-background)",
    },
  };
}

// 外层 overflow-auto 负责裁剪，内层 w-max 负责真实内容宽度
// 不换行时内层用 w-max，让短行背景延伸到最大宽度。
// 字号由设置直接写进内层 style，不做类名拼装。
// 透传其余 div 属性，便于宿主挂测试标识与事件。
// 截断标记行单独渲染为提示，不参与行号计数。
//
export function LightweightDiffPreview({
  className,
  codePreviewSettings,
  lines,
  renderLineContent,
  ...props
}: LightweightDiffPreviewProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      className={cn("w-full min-w-0 overflow-auto bg-background", className)}
      data-lightweight-diff-preview
      {...props}
    >
      <div
        className={cn(
          "min-w-full font-mono leading-relaxed text-foreground",
          !codePreviewSettings.wrapLongLines && "w-max",
        )}
        data-lightweight-diff-scroll-content
        style={{ fontSize: codePreviewSettings.fontSizePx }}
      >
        {lines.map((line, index) => {
          // parseTruncatedMarkerOmittedLineCount 先于内容识别，命中即渲染提示行
          // getPatchPreviewLineContent 与 getLightweightDiffLineStyles 分开，便于单测
          // 行号在 sticky 列内右对齐，横向滚动不丢失
          // showLineNumbers 为假时整列不渲染，内容占满剩余宽度
          // 轻量 diff 不显示统一 diff 的增删前缀字符。
          //
          const omittedLineCount = parseTruncatedMarkerOmittedLineCount(line);

          if (omittedLineCount !== null) {
            return (
              <div className="px-3 py-1 text-foreground-subtle" key={index}>
                {intl.formatMessage(
                  { id: "diff.preview.truncatedLines" },
                  { count: String(omittedLineCount) },
                )}
              </div>
            );
          }

          const lineParts = getLightweightDiffLineParts(line);
          const lineStyles = getLightweightDiffLineStyles(lineParts.kind);

          return (
            <div className="flex min-w-full w-full" key={index} style={lineStyles.rowStyle}>
              {/* 不换行时由内层滚动面统一计算 max-content 宽度。
              如果每行各自 w-max，横向滚动到右侧时短行背景会提前结束，产生黑色断层。 */}
              {codePreviewSettings.showLineNumbers ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "sticky left-0 z-[1] w-12 shrink-0 select-none border-r border-border px-2 text-right tabular-nums",
                    lineStyles.lineNumberClassName,
                  )}
                  style={lineStyles.gutterStyle}
                >
                  {index + 1}
                </span>
              ) : null}
              <code
                className={cn(
                  "block flex-1 px-3",
                  codePreviewSettings.wrapLongLines
                    ? "whitespace-pre-wrap break-words"
                    : "whitespace-pre",
                )}
              >
                {/* 轻量 diff 只用行背景、状态条和行号颜色表达增删，和富 DiffViewer 保持一致；
                不能把 unified diff 的 `+/-/空格` 协议 marker 当成代码内容显示出来。 */}
                {renderLineContent?.(lineParts, index) ?? (lineParts.content || " ")}
              </code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
