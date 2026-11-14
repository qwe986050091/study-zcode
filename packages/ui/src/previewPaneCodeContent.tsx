// INV-01 mermaid 走专用组件而不是代码高亮：守住位置 isMermaidLanguage 分支；改错故障 流程图被渲染成源码文本。
// INV-02 两种形态共用同一个滚动容器 ref：守住位置 ref 挂载位置；改错故障 外部定位滚动失效。
// INV-03 mermaid 分支自己承担滚动与内边距：守住位置 overflow-auto 与 p-4；改错故障 图被裁切。
// INV-04 主题缺省按 system 兜底：守住位置 theme 透传；改错故障 暗色主题下图表仍用亮色。
// INV-05 展示参数全部来自 codePreviewSettings：守住位置 showLineNumbers 与 fontSizePx；改错故障 设置项不生效。
// INV-06 firstLineNumber 只在代码形态透传：守住位置 CodeViewer 入参；改错故障 行号起点错位。
// INV-07 批注参数整体透传不加工：守住位置 五个 comment props；改错故障 选中范围与聚焦请求错位。
// INV-08 行选择与行内工具默认关闭：守住位置 两个默认值；改错故障 只读预览被误触发行内输入。
// INV-09 onScroll 两种形态都要挂：守住位置 两处 onScroll；改错故障 外部同步滚动失效。
// INV-10 className 是追加而不是替换：守住位置 cn 调用；改错故障 外部布局类覆盖内边距。
// INV-11 组件不持有任何状态：守住位置 无 hook；改错故障 预览与父级不同步。
// INV-12 语言类型即 shiki 语言集合：守住位置 BundledLanguage；改错故障 传入未注册语言时高亮失败。
//
// 模块职责：按语言在 mermaid 预览与通用代码查看器之间分流。
// 阅读顺序：先看 mermaid 分支的容器约定，再看代码分支的参数映射。
import type { BundledLanguage, BundledTheme } from "shiki";
import type { Ref, UIEventHandler } from "react";
import { cn } from "@/components/lib/utils.js";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block.js";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isMermaidLanguage } from "@/lib/mermaidLanguage.js";
import type { Theme } from "@/useTheme.js";

interface CodeContentProps {
  code: string;
  language: BundledLanguage;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  /** 应用主题（store 耦合剥离）：透传给 Mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  wrapLongLines: boolean;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  focusRequestId?: string;
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
  className?: string;
}

export function CodeContent({
  code,
  language,
  codePreviewSettings,
  codeTheme,
  theme,
  wrapLongLines,
  firstLineNumber,
  comments,
  topComment,
  topCommentShowRange,
  topCommentNotice,
  focusedRange,
  focusRequestId,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
  className,
}: CodeContentProps) {
  // mermaid 不进入代码高亮，直接交给图表组件渲染。
  // 判断放在最前，避免为图表语言准备无用的高亮参数。
  // 分支返回自己的容器，滚动与背景与代码形态保持一致的观感。
  if (isMermaidLanguage(language)) {
    return (
      <div
        // 外层容器承接 ref，调用方据此恢复滚动位置。
        // 两种形态必须挂同一个 ref，否则切换语言后定位错乱。
        ref={scrollContainerRef}
        className={cn("h-full w-full overflow-auto bg-background p-4", className)}
        onScroll={onScroll}
      >
        <MermaidBlock
          code={code}
          theme={theme}
          className="min-h-full rounded-xl border border-border"
        />
      </div>
    );
  }

  return (
    <CodeViewer
      code={code}
      language={language}
      // showLineNumbers 与 fontSizePx 都取自 codePreviewSettings，组件内不写死默认值。
      // firstLineNumber 由调用方按片段位置传入：只有代码形态需要行号起点，其它形态不传。
      // wrapLongLines 由调用方传入，与 codePreviewSettings 解耦，可按形态覆盖换行策略。
      showLineNumbers={codePreviewSettings.showLineNumbers}
      // 高亮主题与 mermaid 主题是两个来源，不要混用。
      // comments、focusedRange 与 enableLineSelection 全部保持原样透传给 CodeViewer，组件不解释也不缓存。
      theme={codeTheme}
      wrapLongLines={wrapLongLines}
      fontSizePx={codePreviewSettings.fontSizePx}
      firstLineNumber={firstLineNumber}
      comments={comments}
      topComment={topComment}
      topCommentShowRange={topCommentShowRange}
      topCommentNotice={topCommentNotice}
      focusedRange={focusedRange}
      focusRequestId={focusRequestId}
      // 只读预览下这两项保持关闭，避免误触发行内输入。
      // 需要行内编辑的调用方必须同时传 enableLineSelection 与 enableGutterUtility，默认值不在这里兜底。
      enableLineSelection={enableLineSelection}
      enableGutterUtility={enableGutterUtility}
      labels={labels}
      onSubmitCodeComment={onSubmitCodeComment}
      onDeleteCodeComment={onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
      // 外部类通过 cn 追加，不能覆盖内部内边距与尺寸。
      // scroll 回调与 ref 一起透传，保证两个形态行为一致。
      className={className}
    />
  );
}
