// previewPaneContent.tsx —— 预览面板内容路由：把预览源分派到文本、图片、媒体、Office、PDF、PPTX。
//
// 职责边界
//   做什么：按 source.type 选择渲染分支，并决定加载态、错误态与空态文案。
//   不做什么：不发起文件读取、不解码二进制、不维护预览缓存，数据均由上层准备好。
//   依赖谁：各预览子组件、代码查看器、diff 查看器与国际化实例。
//   被谁调用：预览面板容器，滚动容器与源数据都由它提供。
//   边界：本文件是纯路由层，除 memo 缓存外不持有任何状态。
//
//
// INV-01 路由顺序固定：patch、多文件 diff、文本、图片、媒体、PDF、Office、PPTX、纯文件 —— 守住它的位置：各 if 分支的先后 —— 改错故障：带扩展名的 office 文件被当成普通文本渲染
// INV-02 multiFileDiffFiles 必须用 memo 保持引用稳定 —— 守住它的位置：useMemo —— 改错故障：父级滚动时 diff 被强制重渲染，长文档卡顿
// INV-03 错误文本样式必须区分文件缺失与真实错误 —— 守住它的位置：getPreviewPaneErrorTextClass —— 改错故障：文件被删除时显示成刺眼的失败色
// INV-04 图片、PDF、PPTX 的加载判断必须保留同时无错误且无数据两个条件 —— 守住它的位置：各 loading 分支 —— 改错故障：请求失败后一直转圈，看不到错误
// INV-05 code-review 分支必须禁用行选择与评论提交 —— 守住它的位置：CodeContent 的 enable 与 onSubmit —— 改错故障：评审视图里出现可提交的行内评论入口
// INV-06 code-review 的注释来源必须覆盖默认注释 —— 守住它的位置：comments 的取值 —— 改错故障：评审定位注释被普通注释覆盖，看不到问题点
// INV-07 markdown 预览必须透传选择目标与工作区路径 —— 守住它的位置：MarkdownPreviewContent 参数 —— 改错故障：从预览里选中文本后无法生成引用
// INV-08 svg 预览只在视图模式为 preview 时走图片渲染 —— 守住它的位置：svgViewMode 判断 —— 改错故障：切到代码模式后仍渲染图形
// INV-09 文本分支的 sourceKey 必须稳定 —— 守住它的位置：sourceKey 表达式 —— 改错故障：每次父级渲染都重建 markdown，滚动位置丢失
// INV-10 路由层不得发起任何 IO —— 守住它的位置：整个函数体 —— 改错故障：渲染期间触发读取，出现重复请求与竞态
// INV-11 空内容判断必须早于语言推断 —— 守住它的位置：content.length 检查 —— 改错故障：空文件被推断出语言并渲染空代码块
// INV-12 文件过大必须优先于内容判空 —— 守住它的位置：fileTooLarge 分支 —— 改错故障：超大文件先显示空内容提示，误导用户
// INV-13 pptx 的可选参数必须条件展开：不能传 undefined 字段 —— 守住它的位置：两处条件展开 —— 改错故障：查看器把缺省引用当成有效引用并尝试定位
// INV-14 错误文案必须复用同一个文件缺失消息实例 —— 守住它的位置：fileMissingMessage —— 改错故障：两处文案不一致，样式判断失效
// INV-15 每个分支只返回单一节点：不要在外层再包容器 —— 守住它的位置：全部 return —— 改错故障：滚动容器多出一层，滚动监听拿到错误的元素
// INV-16 不得修改 source 的任何字段 —— 守住它的位置：全部分支 —— 改错故障：上游数据被就地改写，其他消费者读到脏值
// INV-17 diff 的 cacheKey 必须包含内容切片 —— 守住它的位置：多文件 diff 的 useMemo —— 改错故障：内容变化但长度相近时 diff 不刷新
// INV-18 组件不缓存 filePreview 内容 —— 守住它的位置：整个函数体 —— 改错故障：切换文件后仍显示上一份内容
//
// 维护提示
//   新增预览类型时先确定它在路由中的位置，再补加载态与错误态，最后补空态。
//   这里每个分支都是提前返回，顺序即优先级，调整顺序等于改变产品行为。
//   子组件负责自己的内部布局，路由层不要追加 padding 或容器。
//   所有文案来自 intl，不要在分支里拼中文。
//   code-review 是唯一会改写多个渲染参数的分支，改动前先看代码评审模块。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
/* eslint-disable max-lines -- PreviewPane 内容路由同时承载文本、图片、媒体、Office、PDF 和 PPTX 渲染。 */
import type { BundledTheme } from "shiki";
import { useMemo, type Ref, type SyntheticEvent, type UIEventHandler } from "react";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { CodeCommentLabels } from "@/components/ui/code-viewer.js";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { CodeContent } from "@/previewPaneCodeContent.js";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import type { WorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";
import { PreviewPaneMediaContent } from "@/previewPaneMediaContent.js";
import { PdfPreviewContent } from "@/previewPanePdfContent.js";
import { PptxPreviewContent } from "@/previewPanePptxContent.js";
import { PatchFallbackContent } from "@/previewPanePatchFallbackContent.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { PptxPreviewViewerLabels } from "@/components/ui/pptx-preview-viewer.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { Theme } from "@/useTheme.js";
import type { OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { PreviewPaneOfficeContent } from "@/previewPaneOfficeContent.js";
import type { PptxElementReferenceSource } from "@/lib/pptxElementReference.js";
import type { MediaCodeViewerSource, PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import { resolveCodeReviewContentProjection } from "@/previewPaneCodeReview.js";

// PreviewPaneContentProps 的字段全部由 props 注入：每个 source.type 分支只读自己那组字段，新增字段设为可选，否则所有构造该 props 的调用点都要同步改动。
interface PreviewPaneContentProps {
  source: CodeViewerSource;
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
  loadingInitial: boolean;
  loadingImagePreview: boolean;
  imagePreview: FileMediaPreview | null;
  imageFileReference?: WorkspaceFileDragPayload;
  loadImageDownloadSource?: () => Promise<string>;
  mediaSource: MediaCodeViewerSource | null;
  loadingMediaPreview: boolean;
  mediaPreviewUrl: string | null;
  onMediaError: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
  loadingPdfPreview: boolean;
  pdfViewerSource: PdfViewerSource | null;
  pdfViewerLabels: PdfViewerLabels;
  loadingOfficePreview: boolean;
  officePreview: FileBinaryPreview | null;
  officePreviewKind: OfficeFilePreviewKind | null;
  loadingPptxPreview: boolean;
  pptxPreviewData: ArrayBuffer | null;
  pptxViewerLabels: PptxPreviewViewerLabels;
  pptxReferenceSource: PptxElementReferenceSource | null;
  pptxReferenceNavigation: PptxReferencePreviewNavigation | null;
  pptxReferenceNavigationReady: boolean;
  error: string | null;
  codePreviewSettings: CodePreviewSettings;
  codeTheme: BundledTheme;
  resolvedTheme: "light" | "dark";
  /** 应用主题（store 耦合剥离）：透传给 markdown/mermaid 预览，缺省按 "system" 兜底。 */
  theme?: Theme;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  markdownSelectionTarget?: MarkdownSelectionTarget;
  markdownViewMode: "preview" | "code";
  svgViewMode: "preview" | "code";
  wrapLongLines: boolean;
  codeComments: readonly CodeCommentPreview[];
  enableCodeLineSelection?: boolean;
  enableCodeGutterUtility?: boolean;
  codeCommentLabels: CodeCommentLabels;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  onScroll?: UIEventHandler<HTMLDivElement>;
  scrollContainerRef?: Ref<HTMLDivElement>;
}

// [契约] isSvgPath 先 toLowerCase 再 endsWith(".svg")，扩展名大小写不影响判断。
// 路径可能缺失，缺省时按非 svg 处理。
function isSvgPath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

// getPreviewPaneErrorTextClass 把 error === fileMissingMessage 单独判成 text-foreground-subtlest，其余走 text-destructive：文件缺失与真实错误共用同一条渲染路径，判断分散到各分支会让同一错误出现两种颜色。
export function getPreviewPaneErrorTextClass(
  error: string | null,
  fileMissingMessage: string,
): "text-destructive" | "text-foreground-subtlest" {
  return error === fileMissingMessage ? "text-foreground-subtlest" : "text-destructive";
}

// enableCodeLineSelection 与 enableCodeGutterUtility 在 PreviewPaneContent 解构时默认 false：只有显式传入才允许选行与写评论，否则只读预览会出现可编辑入口。
export function PreviewPaneContent({
  source,
  filePreview,
  fileTooLarge,
  loadingInitial,
  loadingImagePreview,
  imagePreview,
  imageFileReference,
  loadImageDownloadSource,
  mediaSource,
  loadingMediaPreview,
  mediaPreviewUrl,
  onMediaError,
  onMediaLoadedMetadata,
  loadingPdfPreview,
  pdfViewerSource,
  pdfViewerLabels,
  loadingOfficePreview,
  officePreview,
  officePreviewKind,
  loadingPptxPreview,
  pptxPreviewData,
  pptxViewerLabels,
  pptxReferenceSource,
  pptxReferenceNavigation,
  pptxReferenceNavigationReady,
  error,
  codePreviewSettings,
  codeTheme,
  resolvedTheme,
  theme,
  workspacePath,
  onOpenBrowserUrl,
  markdownSelectionTarget,
  markdownViewMode,
  svgViewMode,
  wrapLongLines,
  codeComments,
  enableCodeLineSelection = false,
  enableCodeGutterUtility = false,
  codeCommentLabels,
  onSubmitCodeComment,
  onDeleteCodeComment,
  onScroll,
  scrollContainerRef,
}: PreviewPaneContentProps) {
  // [契约] 文案与错误消息共享同一个 intl 实例。
  // 文件缺失消息在多个分支里复用，
  // 必须来自同一份格式化结果。
  const { intl } = useZCodeIntl();
  const fileMissingMessage = intl.formatMessage({ id: "codeViewer.fileMissing" });
  // mediaLabels 在 PreviewPaneContent 内用同一个 intl 一次构造 loading/unavailable/unsupported 三条文案再传给 PreviewPaneMediaContent：子组件内部不再取 intl，避免两处语言切换时机不一致。
  const mediaLabels = {
    loading: intl.formatMessage({ id: "codeViewer.loadingMedia" }),
    unavailable: intl.formatMessage({ id: "codeViewer.mediaUnavailable" }),
    unsupported: intl.formatMessage({ id: "codeViewer.mediaUnsupported" }),
  };
  // [资源] 这里必须 memo，因为下游查看器是 memo 组件。
  // 父级滚动或加载状态变化时，
  // 内联对象会让 diff 整块重算，
  // 长文档会出现明显掉帧。
  // cacheKey 里带内容首尾切片，
  // 是为了在长度相同但内容变化时仍能失效。
  const multiFileDiffFiles = useMemo(() => {
    // [契约] 非 diff 源直接返回 null，不构造占位对象。
    // 占位对象会让下游多一次无意义的比较。
    if (source.type !== "multi-file-diff") {
      return null;
    }

    // DiffViewer 是 memo 组件，预览 pane 父级滚动/加载状态刷新时，
    // JSX 内联 oldFile/newFile 会生成新对象并强制 diff 重新渲染。
    return {
      oldFile: {
        name: source.path ?? source.title,
        contents: source.beforeContent,
        cacheKey: `old:${source.path ?? source.title}:${source.beforeContent.length}:${source.beforeContent.slice(0, 100)}:${source.beforeContent.slice(-100)}`,
      },
      newFile: {
        name: source.path ?? source.title,
        contents: source.afterContent,
        cacheKey: `new:${source.path ?? source.title}:${source.afterContent.length}:${source.afterContent.slice(0, 100)}:${source.afterContent.slice(-100)}`,
      },
    };
  }, [
    source.type,
    source.type === "multi-file-diff" ? source.afterContent : null,
    source.type === "multi-file-diff" ? source.beforeContent : null,
    source.type === "multi-file-diff" ? source.path : null,
    source.type === "multi-file-diff" ? source.title : null,
  ]);

  // [失败路径] patch 是兜底渲染分支。
  // 它既不是 markdown 也不是代码，
  // 但仍然需要独立的 diff 展示，
  // 因此排在所有分支之前。
  if (source.type === "patch") {
    return (
      // 兜底分支：patch 既不是 markdown/code/image，但仍然需要独立渲染。
      <PatchFallbackContent
        patch={source.patch}
        codePreviewSettings={codePreviewSettings}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
        sourceTitle={source.title}
      />
    );
  }

  // [契约] 多文件 diff 需要同时满足类型与数据齐备。
  // 数据未就绪时落到后面的通用分支，
  // 而不是渲染一个空的 diff 查看器。
  if (source.type === "multi-file-diff" && multiFileDiffFiles) {
    return (
      <DiffViewer
        oldFile={multiFileDiffFiles.oldFile}
        newFile={multiFileDiffFiles.newFile}
        diffClassName="block"
        fontSizePx={codePreviewSettings.fontSizePx}
        lightTheme={codePreviewSettings.lightTheme}
        darkTheme={codePreviewSettings.darkTheme}
        themeType={resolvedTheme}
      />
    );
  }

  // [契约] 文本源内部再按 markdown 与 svg 细分。
  // 两种视图模式互斥，
  // 否则同一份内容会被渲染两次。
  if (source.type === "text") {
    const isMarkdownSource = source.language === "markdown";
    const isSvgSource = isSvgPath(source.path);
    if (isMarkdownSource && markdownViewMode === "preview") {
      return (
        <MarkdownPreviewContent
          selectionTarget={markdownSelectionTarget}
          sourceKey={
            source.path ??
            JSON.stringify([source.title, source.type === "text" ? source.content : ""])
          }
          sourceTitle={source.path ?? source.title}
          sourcePath={source.path}
          content={source.content}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
      );
    }

    // [契约] svg 在预览模式下走图片组件。
    // 下载源回调用同一个引用，
    // 保证图形与文本分支的下载行为一致。
    if (isSvgSource && svgViewMode === "preview") {
      return (
        <SvgPreviewContent
          title={source.title}
          svgContent={source.content}
          fileReference={imageFileReference}
          sourcePath={source.path}
          loadDownloadSource={loadImageDownloadSource}
        />
      );
    }

    return (
      <CodeContent
        code={source.content}
        language={source.language}
        codePreviewSettings={codePreviewSettings}
        codeTheme={codeTheme}
        theme={theme}
        wrapLongLines={wrapLongLines}
        comments={codeComments}
        enableLineSelection={enableCodeLineSelection}
        enableGutterUtility={enableCodeGutterUtility}
        labels={codeCommentLabels}
        onSubmitCodeComment={onSubmitCodeComment}
        onDeleteCodeComment={onDeleteCodeComment}
        onScroll={onScroll}
        scrollContainerRef={scrollContainerRef}
      />
    );
  }

  // image 分支的加载条件是 loadingImagePreview || (!error && !imagePreview)：error 必须参与判断，否则请求失败后 imagePreview 仍为 null，界面会永远停在 codeViewer.loadingImage。
  if (source.type === "image") {
    // [契约] image 分支只在 loadingImagePreview 或「无错误且 imagePreview 为 null」时显示加载态。
    // 去掉错误条件会让失败请求永远停在加载文案上。
    if (loadingImagePreview || (!error && !imagePreview)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingImage" })}
        </div>
      );
    }

    // error || !imagePreview 时用 error ?? intl.formatMessage({ id: "codeViewer.imageUnavailable" }) 兜底：即使没有 error 也要渲染错误页，样式统一走 getPreviewPaneErrorTextClass。
    if (error || !imagePreview) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.imageUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <ImagePreviewContent
        title={source.title}
        imageSource={`data:${imagePreview.mediaType};base64,${imagePreview.dataBase64}`}
        sourcePath={source.path}
        fileReference={imageFileReference}
      />
    );
  }

  // source.type === "media" && mediaSource 才渲染 PreviewPaneMediaContent：mediaSource 为 null 时继续往下落到通用分支；onMediaError 与 onMediaLoadedMetadata 只透传，媒体错误状态不在本组件内维护。
  if (source.type === "media" && mediaSource) {
    return (
      <PreviewPaneMediaContent
        error={error}
        labels={mediaLabels}
        loading={loadingMediaPreview}
        onMediaError={onMediaError}
        onMediaLoadedMetadata={onMediaLoadedMetadata}
        source={mediaSource}
        url={mediaPreviewUrl}
      />
    );
  }

  // [契约] PDF 与图片使用同一套加载/错误判定结构。
  // 两类二进制预览共用 loading/error/content 三段式，
  // 新增预览类型时补一个 source.type 分支即可，不必另写判定逻辑。
  if (source.type === "pdf") {
    // [契约] PDF 加载判断同样排除错误态。
    // 不能在错误存在时继续渲染加载文案。
    if (loadingPdfPreview || (!error && !pdfViewerSource)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPdf" })}
        </div>
      );
    }

    if (error || !pdfViewerSource) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pdfUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return <PdfPreviewContent source={pdfViewerSource} labels={pdfViewerLabels} />;
  }

  // [契约] Office 分支依赖种类判定结果。
  // 没有识别出种类时回落到普通文件分支，
  // 而不是强行用 Office 查看器打开。
  if (source.type === "file" && officePreviewKind) {
    return (
      <PreviewPaneOfficeContent
        error={error}
        kind={officePreviewKind}
        loading={loadingOfficePreview}
        onOpenBrowserUrl={onOpenBrowserUrl}
        preview={officePreview}
        resolvedTheme={resolvedTheme}
        sourcePath={source.path}
      />
    );
  }

  // [契约] PPTX 使用 ArrayBuffer 数据而不是文本。
  // 加载与错误判定结构与 PDF 一致，
  // 引用源与导航必须成对判断后再展开。
  if (source.type === "pptx") {
    // [契约] PPTX 加载判断同样排除错误态。
    // 失败后必须立刻切到错误页，
    // 不能继续显示加载文案。
    if (loadingPptxPreview || (!error && !pptxPreviewData)) {
      return (
        <div className="p-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.loadingPptx" })}
        </div>
      );
    }

    if (error || !pptxPreviewData) {
      const errorMessage = error ?? intl.formatMessage({ id: "codeViewer.pptxUnavailable" });
      return (
        <div
          className={`p-3 text-ui-base ${
            error ? getPreviewPaneErrorTextClass(error, fileMissingMessage) : "text-destructive"
          }`}
        >
          {errorMessage}
        </div>
      );
    }

    return (
      <PptxPreviewContent
        data={pptxPreviewData}
        labels={pptxViewerLabels}
        fileName={source.path}
        onOpenBrowserUrl={onOpenBrowserUrl}
        {...(pptxReferenceSource ? { referenceSource: pptxReferenceSource } : {})}
        {...(pptxReferenceNavigation ? { referenceNavigation: pptxReferenceNavigation } : {})}
        referenceNavigationReady={pptxReferenceNavigationReady}
      />
    );
  }

  // [契约] loadingInitial 为真且 filePreview 为空时才进初始加载态。
  // 已拿到数据的增量刷新不应重新显示加载文案。
  if (loadingInitial && !filePreview) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.loadingFile" })}
      </div>
    );
  }

  // [失败路径] 只有完全没有内容时才用错误页替代预览。
  // 已有内容时即使刷新失败也要保留旧内容，
  // 否则用户正在阅读的位置会突然变成错误提示。
  if (error && !filePreview) {
    return (
      <div
        className={`p-3 text-ui-base ${getPreviewPaneErrorTextClass(error, fileMissingMessage)}`}
      >
        {error}
      </div>
    );
  }

  // fileTooLarge 必须在 !filePreview 之前判断：超大文件通常不返回内容，若先判空会显示 codeViewer.empty 而不是 codeViewer.fileTooLarge，用户会误以为文件是空的。
  if (fileTooLarge) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.fileTooLarge" })}
      </div>
    );
  }

  // !filePreview 且无 error 时返回 null 而不是错误页：这是 source 已确定但数据尚未注入的正常出口，父级拿到 filePreview 后会重新渲染，提前报错会把加载过程显示成故障。
  if (!filePreview) {
    return null;
  }

  // filePreview.isBinary 必须在 inferCodeLanguage 之前拦截：二进制内容送进 CodeContent 会被当成未知语言渲染成乱码代码块，还会触发无意义的行选择与评论能力。
  if (filePreview.isBinary) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.binary" })}
      </div>
    );
  }

  // filePreview.content.length === 0 时直接返回 codeViewer.empty：空串交给 inferCodeLanguage 得不到有效语言，还会让 CodeContent 挂载一个没有任何行的空块。
  if (filePreview.content.length === 0) {
    return (
      <div className="p-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "codeViewer.empty" })}
      </div>
    );
  }

  // fileLanguage 用 inferCodeLanguage(source.path, filePreview.content) 同时看路径与内容：只看路径会漏掉无扩展名文件，只看内容对短文件判断不准。
  const fileLanguage = inferCodeLanguage(source.path, filePreview.content);
  // codeReviewProjection 只在 source.type === "code-review" 时调用 resolveCodeReviewContentProjection：投影会改写 inlineComments、focusedRange 与 topCommentNotice，普通文件套用会把评审提示带进日常预览。
  const codeReviewProjection =
    source.type === "code-review"
      ? resolveCodeReviewContentProjection(source, filePreview.content)
      : null;
  const isMarkdownFile = fileLanguage === "markdown";
  // [契约] 纯文件分支也要识别 svg。
  // 否则从文件树打开 svg 只能看到源码。
  // 这条判断与文本分支的 svg 判断保持同一含义。
  const isSvgFile = isSvgPath(source.path);
  // [契约] 评审源强制走代码视图。
  // 评审需要行号与定位，
  // 渲染成 markdown 会丢失行对应关系。
  if (source.type !== "code-review" && isMarkdownFile && markdownViewMode === "preview") {
    return (
      <MarkdownPreviewContent
        selectionTarget={markdownSelectionTarget}
        sourceKey={source.path ?? source.title}
        sourceTitle={source.path ?? source.title}
        sourcePath={source.path}
        content={filePreview.content}
        workspacePath={workspacePath}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    );
  }

  // source.type !== "code-review" && isSvgFile && svgViewMode === "preview" 才走 SvgPreviewContent：评审源需要逐行定位，渲染成图片会让 focusedRange 与行内评论失去锚点。
  if (source.type !== "code-review" && isSvgFile && svgViewMode === "preview") {
    return (
      <SvgPreviewContent
        title={source.title}
        svgContent={filePreview.content}
        fileReference={imageFileReference}
        sourcePath={source.path}
        loadDownloadSource={loadImageDownloadSource}
      />
    );
  }

  return (
    <CodeContent
      code={filePreview.content}
      language={fileLanguage}
      codePreviewSettings={codePreviewSettings}
      codeTheme={codeTheme}
      theme={theme}
      wrapLongLines={wrapLongLines}
      comments={codeReviewProjection?.inlineComments ?? codeComments}
      topComment={codeReviewProjection?.topComment}
      topCommentShowRange={false}
      topCommentNotice={
        codeReviewProjection?.targetLineOutOfRange
          ? intl.formatMessage({ id: "codeViewer.review.targetLineMissing" })
          : undefined
      }
      focusedRange={codeReviewProjection?.focusedRange}
      focusRequestId={source.type === "code-review" ? source.review.requestId : undefined}
      enableLineSelection={source.type === "code-review" ? false : enableCodeLineSelection}
      enableGutterUtility={source.type === "code-review" ? false : enableCodeGutterUtility}
      labels={codeCommentLabels}
      onSubmitCodeComment={source.type === "code-review" ? undefined : onSubmitCodeComment}
      onDeleteCodeComment={source.type === "code-review" ? undefined : onDeleteCodeComment}
      onScroll={onScroll}
      scrollContainerRef={scrollContainerRef}
    />
  );
}
