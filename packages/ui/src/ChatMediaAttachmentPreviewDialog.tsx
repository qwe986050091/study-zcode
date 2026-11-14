// INV-01 PDF 组件只在渲染时加载：守住位置 LazyPdfViewer；改错故障 对话列表触发浏览器专属依赖。
// INV-02 懒加载边界只包 PDF：守住位置 dynamic import；改错故障 图片与视频加载行为被改变。
// INV-03 动态导入返回默认导出：守住位置 模块映射；改错故障 组件为空导致渲染崩溃。
// INV-04 附件为空仍可渲染标题：守住位置 attachment 可空；改错故障 关闭动画期间白屏。
// INV-05 文本内容优先于链接：守住位置 首个渲染分支；改错故障 文本附件被当图片加载。
// INV-06 PDF 源与普通链接分开判断：守住位置 pdfSource 分支；改错故障 PDF 走图片标签。
// INV-07 视频按 MIME 前缀识别：守住位置 isVideo；改错故障 视频被当图片。
// INV-08 PDF 判定去掉参数并小写：守住位置 isPdf；改错故障 带 charset 的 PDF 无法预览。
// INV-09 切换附件必须重置播放状态：守住位置 useEffect 依赖；改错故障 新视频沿用旧状态。
// INV-10 打开对话框也重置播放状态：守住位置 open 依赖；改错故障 二次打开直接显示错误。
// INV-11 不支持时只提示不阻断：守住位置 unsupported 分支；改错故障 解码失败导致对话框崩溃。
// INV-12 媒体错误不改写附件事实：守住位置 onError；改错故障 预览失败被当成发送失败。
// INV-13 加载文案按媒体类型分派：守住位置 loadingLabel 三元；改错故障 视频等待显示通用文案。
// INV-14 不可用文案同规则分派：守住位置 unavailableLabel；改错故障 错误提示与类型不符。
// INV-15 PDF 标签复用代码查看器文案：守住位置 pdfViewerLabels；改错故障 分页控件无本地化。
// INV-16 非 PDF 不构造标签对象：守住位置 isPdf 三元；改错故障 无谓对象进入渲染。
// INV-17 加载与错误态互斥展示：守住位置 末尾分支链；改错故障 同时出现两个提示。
// INV-18 组件不修改附件对象：守住位置 只读入参；改错故障 调用方数据被副作用改写。
//
// 模块职责：聊天媒体附件的图片、视频、PDF 与文本预览对话框。
// 状态所有权：仅播放状态为本地状态；附件与开关由调用方持有。
// 阅读顺序：先看懒加载，再读类型判定，最后看渲染分支。
import { lazy, Suspense, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// react-pdf/pdfjs 在模块导入阶段依赖浏览器 DOMMatrix；对话列表也会加载本组件，
// 导致 Node 测试和非 PDF 对话在真正打开预览前就触发浏览器专属依赖。仅在渲染 PDF 时懒加载，
// 保持图片/视频分支的加载行为不变，同时避免对话模块产生无条件的 PDF.js 副作用。
// PDF 组件只在渲染时加载。
// 对话列表也 import 本组件，因此 PDF.js 不能在模块顶层加载。
// 图片与视频分支保持原样，只把 PDF 挪进 LazyPdfViewer。
// import() 返回的模块没有 default，映射里显式取 module.PdfViewer。
// 测试环境不 import PDF 就不会触发 DOMMatrix 等浏览器垫片。
// 懒加载边界只包 PDF。
const LazyPdfViewer = lazy(async () => {
  const module = await import("@/components/ui/pdf-viewer.js");
  return { default: module.PdfViewer };
});

export interface ChatMediaAttachmentPreviewTarget {
  filename: string;
  mediaType: string;
  url?: string;
  pdfSource?: PdfViewerSource;
  textContent?: string;
}

// 入参由 attachment、open、onOpenChange 与可选的 loading/error 组成。
// attachment 为 null 时标题仍在渲染，关闭动画期间不会白屏。
// textContent 存在时走文本分支，先于 url 与 pdfSource 判断。
// PDF 源与普通链接分开判断。
// 错误态与加载态互斥展示。
// 组件不修改附件对象。
export function ChatMediaAttachmentPreviewDialog({
  attachment,
  open,
  onOpenChange,
  loading = false,
  error = false,
}: {
  attachment: ChatMediaAttachmentPreviewTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // 视频按 MIME 前缀识别。
  // PDF 判定去掉参数并小写。
  // attachment.mediaType、url 或 open 变化时 setVideoState("loading") 重置。
  // open 在依赖数组里，二次打开也会回到 loading 而不是旧错误态。
  // 视频解码失败时只显示 unsupportedVideoLabel，不向调用方抛错。
  // onError 只切 videoState，attachment 对象与发送结果都不动。
  const isVideo = attachment?.mediaType.startsWith("video/") === true;
  const isPdf = attachment?.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  useEffect(() => {
    setVideoState("loading");
  }, [attachment?.mediaType, attachment?.url, open]);
  const title = intl.formatMessage({
    id: "chat.attachments.preview.title",
  });
  const loadingLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoLoading"
      : isPdf
        ? "chat.attachments.preview.pdfLoading"
        : "chat.attachments.preview.loading",
  });
  const unavailableLabel = intl.formatMessage({
    id: isVideo
      ? "chat.attachments.preview.videoUnavailable"
      : isPdf
        ? "chat.attachments.preview.pdfUnavailable"
        : "chat.attachments.preview.unavailable",
  });
  const unsupportedVideoLabel = intl.formatMessage({
    id: "chat.attachments.preview.videoUnsupported",
  });
  // PDF 文案按需组装。
  // 非 PDF 时不构造标签。
  // 页导航文案复用 codeViewer.pdf.* 这几条已有 id。
  // 其余字段留空，由 PdfViewer 自己的默认文案兜底。
  // pdfViewerLabels 每次渲染都重新构造，对象引用必然变化。
  // 它只作为 props 传给 PdfViewer，不进入任何依赖数组比较。
  const pdfViewerLabels: Partial<PdfViewerLabels> | undefined = isPdf
    ? {
        loading: loadingLabel,
        loadError: unavailableLabel,
        noData: intl.formatMessage({ id: "codeViewer.pdf.noData" }),
        previousPage: intl.formatMessage({ id: "codeViewer.pdf.previousPage" }),
        nextPage: intl.formatMessage({ id: "codeViewer.pdf.nextPage" }),
        pageInput: intl.formatMessage({ id: "codeViewer.pdf.pageInput" }),
        zoomIn: intl.formatMessage({ id: "codeViewer.pdf.zoomIn" }),
        zoomOut: intl.formatMessage({ id: "codeViewer.pdf.zoomOut" }),
      }
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-xl max-w-5xl gap-0 overflow-hidden p-0" showCloseButton>
        <DialogHeader className="gap-1 border-b border-popover-border px-4 py-3 pr-12">
          <DialogTitle className="truncate">{attachment?.filename ?? title}</DialogTitle>
          <DialogDescription className="truncate text-ui-base">
            {attachment?.mediaType ?? title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[72vh] min-h-64 items-center justify-center bg-background-alt p-4">
          {attachment?.textContent !== undefined ? (
            <pre
              data-text-attachment-preview="true"
              className="max-h-[calc(72vh-2rem)] w-full overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-ui-base text-foreground"
            >
              {attachment.textContent}
            </pre>
          ) : attachment?.pdfSource || attachment?.url ? (
            isPdf ? (
              <Suspense
                fallback={
                  <p className="text-ui-base text-muted-foreground" role="status">
                    {loadingLabel}
                  </p>
                }
              >
                <LazyPdfViewer
                  source={attachment.pdfSource ?? attachment.url!}
                  className="h-[calc(72vh-2rem)] w-full"
                  labels={pdfViewerLabels}
                />
              </Suspense>
            ) : isVideo ? (
              videoState === "unsupported" ? (
                <p
                  className="max-w-xl px-6 text-center text-ui-base text-muted-foreground"
                  role="alert"
                >
                  {unsupportedVideoLabel}
                </p>
              ) : (
                <>
                  {videoState === "loading" ? (
                    <p className="text-ui-base text-muted-foreground" role="status">
                      {loadingLabel}
                    </p>
                  ) : null}
                  {/* MIME 可发送不代表当前 Chromium 能解码容器或 codec；
                  media error 只收口预览状态，不能反向修改附件或发送事实。 */}
                  <video
                    controls
                    playsInline
                    className={`max-h-[calc(72vh-2rem)] max-w-full rounded-lg ${
                      videoState === "loading" ? "invisible absolute" : ""
                    }`}
                    src={attachment.url}
                    onLoadedMetadata={() => setVideoState("ready")}
                    onError={() => setVideoState("unsupported")}
                  />
                </>
              )
            ) : (
              <img
                alt={attachment.filename}
                className="max-h-[calc(72vh-2rem)] max-w-full rounded-lg object-contain"
                src={attachment.url}
              />
            )
          ) : error ? (
            <p className="px-6 text-center text-ui-base text-destructive" role="alert">
              {unavailableLabel}
            </p>
          ) : loading ? (
            <p className="text-ui-base text-muted-foreground" role="status">
              {loadingLabel}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
