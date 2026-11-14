import { createPortal } from "react-dom";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
/* eslint-disable max-lines -- PreviewPane 当前同时承载文件读取、图片与 Office 预览、markdown/code 渲染和顶部路径面包屑；后续需按 header/body 边界继续拆分。 */
// PreviewPane 是「右侧预览面板」的唯一容器：它把宿主给的 CodeViewerSource 归一化，
// 按类型分派到文本 / 图片 / 媒体 / PDF / Office / PPTX / 差异预览读取链路，并把
// 结果交给 PreviewPaneContent 渲染。本文件承担的是「读取与生命周期」，不是渲染细节。
//
// INV 不变量表（行号会随注释漂移，按符号检索；覆盖整个文件）：
// INV-1: rawSource 只能在 source useMemo 里被 normalize 一次，后续一切都用 source —— 破坏后果：同一路径同时以 file/text 两种 type 存在，分支互斥条件失效，出现两套读取链路。
// INV-2: image / media / pdf / pptx / office 派生源互斥，fileSource 必须在其全部为空时才成立 —— 破坏后果：同一文件被两条链路同时读取，互相覆盖 error 与 loading 状态。
// INV-3: 每个异步 effect 必须同时具备 disposed 守卫与 generation 校验（媒体）—— 破坏后果：切换文件后旧请求回写新状态，用户看到上一个文件的错误或图片。
// INV-4: 由 URL.createObjectURL 创建的 objectUrl 必须在 cleanup 中 revoke —— 破坏后果：反复打开大视频/音频时内存单调增长，最终整页卡死。
// INV-5: mediaPreviewService.prepare 返回的 previewId 必须 release（含竞态分支）—— 破坏后果：Host 侧预览句柄泄漏，后续 prepare 被限流。
// INV-6: 文本预览禁止把 truncated 分块拼接后展示 —— 破坏后果：UTF-8 多字节字符被从中间切断成乱码，且每块行号从 1 重置。
// INV-7: PDF 小文件走全量、大文件走 range，阈值与 service 的 readFileRange 分块对齐 —— 破坏后果：range 尺寸与服务端不一致时每次请求都拿不到完整块，pdf.js 卡在加载中。
// INV-8: PPTX 读完必须二次 stat 并 assertPptxPreviewDataComplete —— 破坏后果：读取期间文件被替换时把旧版本前缀当完整 PPTX 解析，渲染出损坏页面或崩溃。
// INV-9: PPTX 必须等 usePptxFileWatch ready 才能读 —— 破坏后果：在写入过程中读取，必然拿到不完整文件，提示语还会误导用户以为文件坏了。
// INV-10: 错误文案必须经 getPreviewPaneSafeErrorMessage 脱敏 —— 破坏后果：远端绝对路径出现在 UI 与日志里，泄漏目录结构，且对用户毫无意义。
// INV-11: codeComments 的 selector 在无 bucket 时必须返回同一个 EMPTY 常量 —— 破坏后果：useSyncExternalStore 的快照每次都是新引用，触发无限重渲染。
// INV-12: 滚动位置只在 renderHeavyContent 由 false→true 的瞬间恢复一次 —— 破坏后果：每次投影都强制回滚，用户在预览里滚动会被持续拽回顶部。
// INV-13: 面包屑只在 breadcrumb 内容变化时滚到最右，之后不得干预 —— 破坏后果：用户向左翻阅长路径时被强行拉回文件名，无法阅读上级目录。
// INV-14: headerContainer 存在时 header 只能通过 portal 渲染一次 —— 破坏后果：同一份 header 出现两处，ref 与事件被后挂载者覆盖。
// INV-15: markdownViewMode / svgViewMode / wrapLongLinesOverride 必须随 source 变化重置 —— 破坏后果：从 markdown 源码切到图片时仍带着「源码视图」偏好，图片区空白。
// INV-16: 图片/媒体/PDF/Office/PPTX 不提供「自动换行」开关 —— 破坏后果：开关对只读预览无效却被显示，用户以为坏了。
// INV-17: 提交评论后必须复查 isCodeCommentMarkedRemoved，已移除则不写入 store —— 破坏后果：刚删除的评论被同一次提交又加回来，出现幽灵评论。
// INV-18: 远程能力过滤得到的编辑器 fallback 不得写回偏好 —— 破坏后果：切回本地文件仍沿用远程 VS Code，打开动作去错 Host。
// INV-19: 图片拖拽引用必须校验 workspaceIdentity，跨 Host 一律返回 undefined —— 破坏后果：把另一台 Host 的绝对路径塞进当前草稿，拖拽后打开错误文件。
// INV-20: 派生数据（breadcrumb / displayOptions / labels）必须 useMemo，依赖列全 —— 破坏后果：memo 化的子组件每次重渲染，长文档滚动时明显掉帧。
//
// 五类标记（行首，便于检索）：
// [并发] 多个异步读取竞争同一份 state 时谁赢；[事务] 一次动作必须原子完成的写入；
// [资源] objectURL / previewId / timer / observer 的释放；[失败路径] 字段缺失与旧 Host 兼容；
// [权衡] 阈值、缓存与即时性的取舍。
import {
  Fragment,
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EditorInfo } from "@zcode/shared";
import {
  ChevronRightIcon,
  Ellipsis,
  EyeIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  CopyIcon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { TID_PREVIEW_PANE } from "@zcode/shared/test-ids";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePptxFileWatch } from "@/hooks/usePptxFileWatch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import {
  FILE_VIEWER_MAX_TEXT_BYTES,
  createDiffSourceFilePreviewSource,
  inferImageMediaType,
  inferMediaPreview,
  isPdfPreviewPath,
  isPptxPreviewPath,
  type CodeViewerSource,
  type MediaCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { decodeBase64ToArrayBuffer, getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { resolveTheme } from "@/useTheme.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { PreviewPaneContent } from "@/previewPaneContent.js";
import {
  dispatchCodeCommentAddToChat,
  dispatchCodeCommentRemoveFromChat,
  isCodeCommentMarkedRemoved,
  type CodeCommentPreview,
  type CodeCommentRange,
} from "@/lib/codeCommentContext.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import {
  assertPptxPreviewDataComplete,
  isPptxPreviewIncompleteFileError,
  readPptxPreviewData,
} from "@/lib/pptxPreviewData.js";

interface CodeViewerBreadcrumbData {
  rootLabel: string | null;
  parentSegments: string[];
  fileLabel: string;
  fileIconSrc: string | null;
}

type BreadcrumbMaskState = "none" | "left" | "right" | "both";

const BREADCRUMB_MASK_CLASS_BY_STATE: Record<BreadcrumbMaskState, string> = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)]",
};
const PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS = [
  44, 72, 58, 86, 64, 78, 52, 90, 68, 48, 82, 60,
] as const;
const EMPTY_CODE_COMMENT_PREVIEWS: readonly CodeCommentPreview[] = [];

// 统一分隔符后再 split：Windows 路径可能混用 \ 与 /（尤其是 Host 拼出来的绝对路径），
// 不统一会让 parentSegments 里出现整条 `C:\Users\x` 这样的单段。
// filter(Boolean) 同时吃掉开头的空段与前导斜杠造成的空段。
function normalizeBreadcrumbPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

// 判据是 language 而不是扩展名：同一条 markdown 可能来自 diff 片段或粘贴内容，
// 那里没有 path；反过来 .md 文件被显式当 text 打开时也仍然算 markdown。
// 两种来源必须都认，否则其中一种会退化成源码视图。
function isMarkdownSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.language === "markdown";
}

// SVG 是唯一「既是图片又是文本」的类型：这里只认扩展名，不认 mediaType，
// 因为 inferImageMediaType 也会把 svg 判成图片，而我们要把它交给文本链路渲染成矢量预览。
// 于是下游 getFileImageMediaType 必须显式排除 image/svg+xml（见该函数）。
function isSvgSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.path?.toLowerCase().endsWith(".svg") === true;
}

// 扩展名判断必须先 trim/判空：source.path 允许为 undefined（来自粘贴或 diff 的来源），
// 直接调用 endsWith 会抛错，而这个函数被用在 render 路径上（不是 effect），抛错即白屏。
// 大小写不敏感是因为 Host 可能给出 .MD（Windows 上常见）。
function isMarkdownFilePath(path?: string): boolean {
  if (!path) {
    return false;
  }

  const normalizedPath = path.toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

// 「文件不存在」需要同时看结构化 code 与自由文本 message：本地 RPC 会带 code=ENOENT，
// 远端 Host 往往只回一句 "no such file or directory"，两者都要认。
// 顺序上先查 code（更可靠），再回退正则；正则会命中路径里恰好包含 ENOENT 的误报，
// 但代价仅是显示「文件不存在」文案，比把整段路径回显给用户更安全。
export function isPreviewPaneMissingFileError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
}

// 只有「PPTX 被引用导航打开」且文件确实不存在时才 toast：
// 普通预览缺失由面板内 error 区展示（就地可见），而引用导航来自另一个上下文，
// 用户视线还在原处，必须主动提示，否则点击像是没反应。
// referenceNavigation 判断不能省：否则每次打开不存在的 pptx 都会弹一个多余 toast。
export function shouldToastPptxReferenceFileMissing(
  source: CodeViewerSource | null,
  error: unknown,
): boolean {
  return (
    source?.type === "pptx" &&
    source.referenceNavigation !== undefined &&
    isPreviewPaneMissingFileError(error)
  );
}

// 超限错误同样只有 message 可用（service 抛的是普通 Error），因此走正则。
// 匹配的是 service 固定文案，不是「too large」这种泛词：后者会误伤
// 「图片分辨率 too large」之类其实可以预览的错误。
export function isPreviewPaneFileTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is too large to preview/i.test(message);
}

// 脱敏的唯一目的：把消息里出现的「完整绝对路径」降级为文件名，保留其余可读信息。
// 同时枚举 \ 与 / 两种写法，是因为同一个路径可能在错误里以任一种形式出现（Host 拼接）。
// 用 split/join 而不是正则替换：路径里含有 . ( ) 等正则元字符，转义遗漏会误伤。
// 非绝对路径（相对路径或纯文件名）直接原样返回，避免误删有效上下文。
export function getPreviewPaneSafeErrorMessage(error: unknown, sourcePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isAbsoluteFilePath(sourcePath)) {
    return message;
  }

  const sourceLeaf = getPathLeaf(sourcePath);
  const pathVariants = new Set([
    sourcePath,
    sourcePath.replace(/\\/g, "/"),
    sourcePath.replace(/\//g, "\\"),
  ]);

  let safeMessage = message;
  for (const pathVariant of pathVariants) {
    if (pathVariant !== sourceLeaf) {
      safeMessage = safeMessage.split(pathVariant).join(sourceLeaf);
    }
  }
  return safeMessage;
}

// 三类已知错误各有专属文案，其余一律脱敏后原样展示：
// 依次判断而不是 switch，是因为错误对象没有稳定的 kind 字段，只能靠谓词（且谓词互斥）。
// incompleteFile 必须排在通用分支之前：它是「读取期间文件被改」的警示，
// 若落到通用分支，用户会看到一句英文超限错误，完全无法判断该不该重试。
export function resolvePptxPreviewReadErrorMessage(
  error: unknown,
  options: {
    sourcePath: string;
    fileMissingMessage: string;
    legacyFileTooLargeMessage: string;
    incompleteFileMessage: string;
  },
): string {
  if (isPreviewPaneMissingFileError(error)) {
    return options.fileMissingMessage;
  }
  if (isPreviewPaneFileTooLargeError(error)) {
    return options.legacyFileTooLargeMessage;
  }
  if (isPptxPreviewIncompleteFileError(error)) {
    return options.incompleteFileMessage;
  }
  return getPreviewPaneSafeErrorMessage(error, options.sourcePath);
}

// 只读两个数值而不是返回 DOM 引用：调用方（恢复滚动逻辑）只需要快照，
// 持有容器引用会让「保存」与「恢复」之间隔着一次重挂时指向已卸载节点。
// 容器为 null 时返回 null 而不是 {0,0}：0 是合法的 scrollTop，无法与「没测量到」区分。
export function readPreviewPaneScrollMetrics(
  container: Pick<HTMLElement, "scrollHeight" | "scrollTop"> | null,
) {
  if (!container) {
    return null;
  }

  return {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

// truncated 与 isBinary 的语义完全不同，不能合并成一个「太大」：
// 二进制（图片被当文本打开等）仍可交给下游按字节处理，因此保留 filePreview；
// 只有「文本被截断」才必须丢弃内容并置 fileTooLarge——半个文件比提示更危险，
// 用户会把没显示出来的部分当成「文件里没有」（INV-6）。
export function resolvePreviewPaneTextFileResult(result: FileTextSlice): {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
} {
  if (result.isBinary) {
    return {
      filePreview: result,
      fileTooLarge: false,
    };
  }

  return result.truncated
    ? {
        filePreview: null,
        fileTooLarge: true,
      }
    : {
        filePreview: result,
        fileTooLarge: false,
      };
}

// 与 isSvgSource 分开：那个判 CodeViewerSource（type + path），这个只判路径字符串，
// 供 isPlainCodeSource / displayOptions 在还没有归一化 source 时使用。
// `?? false` 保证 undefined 走「不是 svg」而不是抛错或返回 undefined。
function isSvgFilePath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

// 显式排除 svg：SVG 走文本链路（可切换源码视图、可评论），若在这里返回 image/svg+xml，
// 会被 resolvePreviewPaneImageSource 抢先接走，用户再也看不到源码。
// 返回 null 表示「不是位图」，调用方据此继续往下判 pdf/office/pptx。
function getFileImageMediaType(path?: string): string | null {
  const mediaType = inferImageMediaType(path);
  return mediaType && mediaType !== "image/svg+xml" ? mediaType : null;
}

// 与 service 层 readFileRange 的默认分段大小对齐，一次 range 请求对应一次 RPC 调用。
const PDF_RANGE_CHUNK_BYTES = 256 * 1024;
// 小 PDF 直接循环拉全量（少量往返、渲染路径最简单）；超过阈值交给 pdf.js range 按需分段加载。
const PDF_FULL_READ_MAX_BYTES = 2 * 1024 * 1024;
// 2MB 是「一次全量读」与「交给 pdf.js 分段」的分界：低于它时循环 range 往返少、
// 且能整块交给 pdf.js 快速渲染；高于它必须走 range，否则一次 IPC 传几十 MB 会卡住主线程。
// 两个常量都与 service 的读取能力绑定，不能按 UI 需要单独调大（INV-7）。
export const PPTX_MAX_FILE_BYTES = 64 * 1024 * 1024;

// 用 > 而不是 >=：恰好等于 64MB 的文件仍允许解析（边界值按「可预览」处理，
// 与 service 侧的判定保持一致）。改小阈值会让此前能打开的文件突然报错。
export function isPptxPreviewFileTooLarge(size: number): boolean {
  return size > PPTX_MAX_FILE_BYTES;
}

// 这是「重内容尚未就绪」时的占位骨架：resize / 侧栏开合的过程中不挂载 CodeViewer，
// 但完全留白会让预览区闪一下。用固定宽度的静态条模拟代码行，既有视觉重量又不参与布局测量。
// aria-hidden + 无交互：它对读屏和键盘用户没有意义，绝不能成为焦点目标。
function PreviewPaneDeferredHeavyContent({ style }: { style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      className="h-full w-full overflow-hidden bg-background"
      data-preview-pane-heavy-content-deferred="true"
      style={style}
    >
      {/* Bugfix: resize/sliver 阶段不能展示大文件 CodeViewer，但只放空白会明显闪烁。
          这里用少量静态 code-line 纹理保留预览区的视觉重量，不让千行 Shadow DOM 参与可见布局。 */}
      <div
        className="sticky top-0 flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-3"
        data-preview-pane-heavy-content-placeholder="true"
      >
        {PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS.map((width, index) => (
          <div key={`${width}-${index}`} className="flex h-4 shrink-0 items-center gap-2">
            <span className="h-3 w-8 shrink-0 rounded-sm bg-surface" />
            <span className="h-3 rounded-sm bg-surface-hover" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// 三种输入：已经是 image（下游传上来的）→ 原样；file 且有位图扩展名 → 升级成 image；
// 其它（text/media/pdf/pptx/patch/…）→ null，表示「不归图片链路管」。
// 顺序不能反：先判 type==="image" 再判 file，否则 file 分支的扩展名判断会把
// 已经是 image 的来源再包一层，丢掉原有的 mediaType（可能来自 Host 探测而非扩展名）。
export function resolvePreviewPaneImageSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "image" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "image") {
    return source;
  }

  if (source.type !== "file") {
    return null;
  }

  const mediaType = getFileImageMediaType(source.path);
  if (!mediaType) {
    return null;
  }

  return {
    type: "image",
    title: source.title,
    path: source.path,
    mediaType,
  };
}

// 与图片不同，媒体来源必须由 inferMediaPreview 给出 kind/mime（视频与音频的播放器不同），
// 因此这里用展开 {...source, type:"media", ...media} 保留原 path/title/workspace 信息。
// 没有 media 推断结果就返回 null：宁可让下游报「不支持」，也不要用错误的 mime 交给 <video>。
export function resolvePreviewPaneMediaSource(
  source: CodeViewerSource | null,
): MediaCodeViewerSource | null {
  if (!source) return null;
  if (source.type === "media") return source;
  if (source.type !== "file") return null;
  const media = inferMediaPreview(source.path);
  if (!media) return null;
  return { ...source, type: "media", ...media };
}

// MediaError.code 3/4 是 DECODE_ERR / SRC_NOT_SUPPORTED，属于「这个文件本身放不了」，
// 其余（1 ABORTED、2 NETWORK）是传输问题，提示「加载失败」并允许重试。
// 两者文案不同，是用户决定「换文件」还是「再点一次」的唯一依据，不能合并成一句。
export function resolveMediaPlaybackErrorMessageId(
  code: number | undefined,
): "codeViewer.mediaUnsupported" | "codeViewer.mediaLoadFailed" {
  return code === 3 || code === 4 ? "codeViewer.mediaUnsupported" : "codeViewer.mediaLoadFailed";
}

// PDF 只有两种合法来源：已经是 pdf，或 file 且扩展名为 .pdf（isPdfPreviewPath 兜住大小写）。
// 不认 mime sniffing：PDF 的 Host 侧读取成本高，误判会把普通文本文件送进 pdf.js 并报错。
// 返回对象刻意只带 title/path，不展开原 source：pdf 链路不消费其余字段，展开会引入
// 与 media/pptx 分支的字段耦合（改一处影响三处）。
export function resolvePreviewPanePdfSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pdf" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pdf") {
    return source;
  }

  if (source.type !== "file" || !isPdfPreviewPath(source.path)) {
    return null;
  }

  return {
    type: "pdf",
    title: source.title,
    path: source.path,
  };
}

// 这里必须展开 {...source} 而不是只挑字段：PPTX 的引用导航（referenceNavigation）
// 与 workspace 身份都在原 source 上，丢了它们，引用跳转会退化成普通预览且无法 toast。
// type 放最后覆盖，保证展开后类型一定是 pptx（顺序反了会被原 type 覆盖）。
export function resolvePreviewPanePptxSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pptx" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pptx") {
    return source;
  }

  if (source.type !== "file" || !isPptxPreviewPath(source.path)) {
    return null;
  }

  return {
    ...source,
    type: "pptx",
  };
}

// 分隔线表示「下面是文档型预览，不是源码」：PDF/PPTX/媒体/Office 都需要与面包屑隔开，
// 文本与图片则沿用原有视觉（图片自带边框）。
// 用 resolve* 谓词而不是再写一遍扩展名判断，保证这条线与实际走哪条链路永远同源。
export function shouldShowPreviewPaneHeaderDivider(source: CodeViewerSource | null): boolean {
  return Boolean(
    resolvePreviewPanePdfSource(source) ||
    resolvePreviewPanePptxSource(source) ||
    resolvePreviewPaneMediaSource(source) ||
    (source?.type === "file" && getOfficeFilePreviewKind(source.path)),
  );
}

// 「纯代码」的语义是「有行号、可换行、可评论的文本视图」。因此这是一个排除式判断：
// text 里排除 markdown/svg（它们有自己的预览形态），file 里排除所有专用预览类型，
// media 一律排除，code-review 恒为真（差异本身就是要看代码）。
// 任何新增的专用预览类型都必须在这里补一条排除，否则它会错误地拿到换行开关（INV-16）。
function isPlainCodeSource(source: CodeViewerSource | null): boolean {
  if (!source) {
    return false;
  }

  if (source.type === "text") {
    return !isMarkdownSource(source) && !isSvgSource(source);
  }

  if (source.type === "file") {
    return (
      !isMarkdownFilePath(source.path) &&
      !isSvgFilePath(source.path) &&
      !getFileImageMediaType(source.path) &&
      // PDF、Office 和 PPTX 走专用只读预览，没有源码视图，也不该出现自动换行开关。
      !isPdfPreviewPath(source.path) &&
      !getOfficeFilePreviewKind(source.path) &&
      !isPptxPreviewPath(source.path)
    );
  }

  // media 恒为 false 且不给任何开关：播放器的换行没有任何意义，
  // 若在这里返回 true，头部会多出一个点了没反应的菜单项（INV-16）。
  if (source.type === "media") return false;

  if (source.type === "code-review") {
    return true;
  }

  return false;
}

// canToggle 系列与 hasMoreMenu 必须对齐：菜单只有在这些开关存在时才出现，
// 「有菜单项但点开是空菜单」是这个函数要防的主要故障（历史上 hasMoreMenu 曾漏算换行）。
// 换行开关是派生的：markdown/svg 只有切到 code 视图时才成立，因此要读 viewModes 而不是只看文件类型。
export function getPreviewPaneDisplayOptions(
  source: CodeViewerSource | null,
  viewModes: {
    markdownViewMode?: "preview" | "code";
    svgViewMode?: "preview" | "code";
  } = {},
) {
  const canToggleMarkdownView =
    source !== null &&
    (isMarkdownSource(source) || (source.type === "file" && isMarkdownFilePath(source.path)));
  const canToggleSvgView =
    source !== null &&
    (isSvgSource(source) || (source.type === "file" && isSvgFilePath(source.path)));
  // 换行开关不能只看 isPlainCodeSource：markdown/svg 处在 code 视图时也显示源码行，
  // 此时不提供换行会让长行只能横向滚动。反过来在 preview 视图里提供开关，
  // 则是对渲染后的 HTML 的无效操作，用户点了看不到任何变化。
  const canToggleCodeWrap =
    isPlainCodeSource(source) ||
    (canToggleMarkdownView && viewModes.markdownViewMode === "code") ||
    (canToggleSvgView && viewModes.svgViewMode === "code");

  return {
    canToggleCodeWrap,
    canToggleMarkdownView,
    canToggleSvgView,
    hasMoreMenu: canToggleMarkdownView || canToggleSvgView || canToggleCodeWrap,
  };
}

// 面包屑有三种形态，优先级从高到低：
// 1) 无 path 但有 title（粘贴的 diff 片段）→ 只有文件名，没有根；
// 2) path 在工作区内 → 根显示工作区名，其余按相对路径切段；
// 3) path 在工作区外 → 根是盘符或 "/"，其余按绝对路径切段。
// 第 2、3 种必须分开，因为相对路径与绝对路径的切段起点不同（差一个根段）。
function buildCodeViewerBreadcrumb(
  source: CodeViewerSource,
  workspacePath?: string,
): CodeViewerBreadcrumbData | null {
  const sourcePath = source.path;
  if (!sourcePath) {
    if (!source.title.trim()) {
      return null;
    }

    return {
      rootLabel: null,
      parentSegments: [],
      fileLabel: source.title,
      fileIconSrc: null,
    };
  }

  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const normalizedWorkspacePath = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const sourceLeaf = getPathLeaf(sourcePath);
  const descriptor = resolveFileDisplayDescriptor(sourcePath);
  // 大小写不敏感的路径比较在 Windows 上不成立（C:\A 与 c:\a 实际相同），这里刻意不做
  // toLowerCase：Linux/macOS 区分大小写，统一小写反而会把两个不同目录合并。
  // 代价是 Windows 上大小写不一致时会被判成工作区外，退化为显示完整路径（可接受降级）。
  if (
    normalizedWorkspacePath &&
    (normalizedSourcePath === normalizedWorkspacePath ||
      normalizedSourcePath.startsWith(`${normalizedWorkspacePath}/`))
  ) {
    // 相对路径用工作区长度切片而不是按段数截取：路径里可能含重复目录名，
    // 按名字找起点会切到错误的层级，面包屑显示成另一个文件的路径。
    const relativePath =
      normalizedSourcePath === normalizedWorkspacePath
        ? ""
        : normalizedSourcePath.slice(normalizedWorkspacePath.length + 1);
    const relativeSegments = normalizeBreadcrumbPathSegments(relativePath);

    return {
      rootLabel: getPathLeaf(normalizedWorkspacePath),
      parentSegments: relativeSegments.slice(0, -1),
      fileLabel: relativeSegments.at(-1) ?? sourceLeaf,
      fileIconSrc: descriptor.fileIconSrc,
    };
  }

  // 工作区外路径的根段处理必须区分 POSIX 与 Windows："/a/b" 的第一段是目录，
  // 而 "C:/a/b" 的第一段是盘符。统一 slice(1, -1) 会让 Linux 路径丢掉一级目录，
  // 反过来统一保留首段则会让 Windows 路径把盘符重复显示成两级。
  const sourceSegments = normalizeBreadcrumbPathSegments(normalizedSourcePath);
  return {
    rootLabel: sourcePath.startsWith("/") ? "/" : (sourceSegments[0] ?? null),
    parentSegments: sourcePath.startsWith("/")
      ? sourceSegments.slice(0, -1)
      : sourceSegments.slice(1, -1),
    fileLabel: sourceSegments.at(-1) ?? sourceLeaf,
    fileIconSrc: descriptor.fileIconSrc,
  };
}

// 返回 undefined 表示「不能拖」，而不是返回一个空 payload：调用方据此决定是否
// 注册 dragstart，返回空对象会让拖拽开始但放下时打开一个错误路径（INV-19）。
// 三个身份来源（source.workspacePath / workspacePath / workspaceIdentity）必须
// 合并成一个 key 再比较，任何一处缺失都会让远端路径被误当成同一台机器。
export function resolvePreviewPaneImageFileReference(
  source: CodeViewerSource | null,
  workspacePath?: string,
  targetWorkspaceKey?: string,
): WorkspaceFileDragPayload | undefined {
  // source 自带的 workspacePath 优先于 props：source 可能来自另一个工作区的标签页，
  // 用 props 的工作区会把它与其来源身份拆开，拖拽时被判成跨工作区而静默失效。
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  const workspaceIdentity = source?.workspaceIdentity?.trim();
  if (!source?.path || !sourceWorkspacePath) return undefined;
  const sourceWorkspaceKey = workspaceIdentity || sourceWorkspacePath;
  const sourceIsRemote = Boolean(workspaceIdentity || source.workspaceRemoteSessionId);
  const targetIsRemote = Boolean(
    workspacePath && targetWorkspaceKey && targetWorkspaceKey !== workspacePath,
  );
  // 本地文件沿用文件树的跨工作区绝对引用；远端必须匹配身份，不能把另一 Host 的 path 交给当前草稿。
  // 本地文件沿用文件树的相对路径 helper；工作区外文件必须用绝对路径，
  // 因为 helper 对外部文件只返回文件名，会把 /tmp/a/x.png 误指向工作区内的同名文件。
  // 这段是 [失败路径]：三种身份都缺失时前面已 return，走到这里一定有一段可用路径。
  if ((sourceIsRemote || targetIsRemote) && sourceWorkspaceKey !== targetWorkspaceKey)
    return undefined;
  return {
    type: "file",
    workspacePath: sourceWorkspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: source.path,
    // 相对路径只在这个分支可信：isWorkspaceFilePathInside 已确认同源，
    // 若反过来无条件调用 helper，工作区外文件会被降级成同名文件，拖拽打开错文件。
    // 预览允许工作区外路径；文件树的相对路径 helper 对外部文件只返回文件名，会误指向同名文件。
    relativePath: isWorkspaceFilePathInside(sourceWorkspacePath, source.path)
      ? getWorkspaceFileRelativePath(sourceWorkspacePath, source.path)
      : source.path,
    name: getPathLeaf(source.path) || source.title,
  };
}

// 组件的 props 全部由宿主（文件管理器 / 侧栏）传入，组件自己不写回任何业务状态：
// source 是「要预览什么」，headerContainer 是「头部挂到哪里」，renderHeavyContent 是
// 「此刻是否允许挂载重内容」。最后一个不是性能装饰，而是布局稳定性的前提：
// 侧栏动画期间必须为 false，否则每帧都会重排 CodeViewer（见 deferred 相关逻辑）。
export function PreviewPane({
  source: rawSource,
  workspacePath,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  renderHeavyContent = true,
  headerContainer,
  markdownSelectionTarget,
}: {
  source: CodeViewerSource | null;
  onClose: () => void;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  renderHeavyContent?: boolean;
  /** 文件管理器将面包屑与目录开关放在同一工具栏，仍由预览维护文件操作。 */
  headerContainer?: HTMLElement | null;
  markdownSelectionTarget?: MarkdownSelectionTarget;
}) {
  // platform 只在这里取一次并向下传递：它是「当前进程的能力边界」，
  // 每个子组件各自 usePlatform() 会在多窗口/远程场景下拿到不同实例，
  // 导致同一个文件在两处用不同的 openInEditor 实现（见 INV-18）。
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  // theme 用选择器订阅而不是 useZCodeStore() 整体订阅：整体订阅会让主题之外的任何
  // store 变化都重渲染预览面板，而预览面板里挂着 CodeViewer，代价很高。
  // 这里只取原始值 "light"/"dark"/"system"，真正的解析在下面 resolveTheme。
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  // rawSource → source 的归一化只做一次（INV-1）：下游所有分支（isMarkdownSource、
  // fileSource、各个 resolve*）都假定 source 已归一。若在这里之外再 normalize 一次，
  // 两次结果可能不同（normalize 会补 language/type），分支互斥条件随之失效。
  const source = useMemo(
    () => (rawSource ? normalizeCodeViewerSource(rawSource) : null),
    [rawSource],
  );
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  // targetWorkspaceKey 来自 markdownSelectionTarget（聊天里选中的文件目标），
  // 不是当前面板的工作区：拖拽语义是「把这张图拖进正在编辑的那份草稿」，
  // 因此比较的是「图片来源身份」与「草稿来源身份」（INV-19）。
  const imageFileReference = useMemo(
    () =>
      resolvePreviewPaneImageFileReference(
        source,
        workspacePath,
        markdownSelectionTarget?.workspaceKey,
      ),
    [source, workspacePath, markdownSelectionTarget?.workspaceKey],
  );
  // 打开上下文由专门的 hook 解析（本地路径 / 远程会话 / Electron 编辑器），
  // 不能在这里用「有没有 remoteSessionId」自行判断：远程目标的可用性还取决于
  // 当前窗口是否连着那台 Host，判断逻辑必须集中在一处（否则两处结论不一致）。
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: sourceWorkspacePath,
    workspaceIdentity: source?.workspaceIdentity,
    workspaceRemoteSessionId: source?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  // isRemoteSource 有三个来源，任一成立即为远程：前两个是 source 自带的身份，
  // 第三个是 hook 解析出的实际连通状态。漏掉第三个会让「本地打开但指向远端仓库」
  // 的文件被当成本地，从而列出本机编辑器（点开必然失败）。
  const isRemoteSource = Boolean(
    source?.workspaceIdentity ||
    source?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  // fileActions 是「复制路径」等动作的唯一实现来源，必须通过 hook 取而不是直接调 platform：
  // hook 内部会按当前工作区身份选择正确的实现（远程会话要走 Host RPC），
  // 直接调 platform 会把远端路径当本地路径复制（或反之）。
  const fileActions = useFileContextActions();
  // 三个 service 都按「工作区身份」解析，必须一起取：分两次调用 useWorkspaceServices
  // 可能在会话切换的中间帧拿到不同代的实例，出现「用 A 的 fileService 配 B 的 media」。
  // 依赖里显式带上 remoteSessionId 与 identity，缺一个都会让面板继续用旧会话的服务。
  const { fileService, fileWatcherService, mediaPreviewService } = useWorkspaceServices(
    sourceWorkspacePath,
    source?.workspaceRemoteSessionId,
    source?.workspaceIdentity,
  );
  // sourceFilePath 单独取出并作为 useCallback 依赖：直接依赖 source 会让回调
  // 在 source 对象每次重建时失效，拖拽 payload 的工厂函数随之重建，进而让
  // PreviewPaneContent 的 memo 失效（INV-20）。
  const sourceFilePath = source?.path;
  // 下载图片必须重新从 Host 读原始字节，而不是复用 <img> 的 url：
  // 图片预览 url 可能是 objectURL 或带鉴权的临时地址，两者都无法作为下载来源；
  // 而且 SVG 走文本预览时原字节与展示文本并不相同（编码/XML 声明）。
  // 抛错而不是返回空串：调用方（下载动作）需要区分「读失败」与「空图片」。
  const loadImageDownloadSource = useCallback(async () => {
    if (!sourceFilePath) throw new Error("Image source path is unavailable");
    // SVG 文本预览按 UTF-8 解码；下载必须从同一来源 Host 读取原字节，保留其他编码及 XML 声明。
    const original = await fileService.readMediaPreview({ path: sourceFilePath });
    return `data:${original.mediaType};base64,${original.dataBase64}`;
  }, [fileService, sourceFilePath]);
  // 文本读取结果与「超限」分开存：filePreview 用于渲染，fileTooLarge 用于说明为什么没有内容。
  // 合并成一个 union 会让「超限且无内容」和「空文件」在渲染分支里难以区分，
  // 而两者的 UI 差异很大（一个给提示，一个正常显示空行号）。
  const [filePreview, setFilePreview] = useState<FileTextSlice | null>(null);
  // fileTooLarge 是独立布尔而不是从 filePreview===null 推断：
  // 「空文件」与「太大没读」都满足 filePreview===null，但前者要正常显示空编辑器，
  // 后者必须显示提示。两个状态在 source 变化时一起被重置（见大 effect 开头）。
  const [fileTooLarge, setFileTooLarge] = useState(false);
  // loadingInitial 只服务「首屏骨架」：后续的分区加载（图片/媒体/PDF）各有自己的 loading，
  // 不复用这一个——否则图片还在加载时，文本区也会显示骨架，看起来像两份内容都没好。
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingImagePreview, setLoadingImagePreview] = useState(false);
  // 图片结果与 media 分开存，是因为它们来自不同的 Host 接口（readMediaPreview 不返回
  // 预览句柄），生命周期也不同：图片是一次性 base64，media 需要 revoke/release。
  const [imagePreview, setImagePreview] = useState<FileMediaPreview | null>(null);
  const [loadingMediaPreview, setLoadingMediaPreview] = useState(false);
  // objectURL 与 previewId 是两个必须成对释放的资源，因此分别存：
  // url 给 <video src>，id 用于通知 Host 释放句柄。只存 url 会泄漏 Host 侧；
  // 只存 id 则无法在 UI 里回退到「还没准备好」。清理见媒体 effect 的闭包。
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  // mediaPreviewId 与 url 分开：重试播放（refreshPlaybackUrl）只需要 id，
  // 而 UI 只需要 url。合成一个对象会让「换 url 但保留 id」这一步必须整体替换，
  // 期间 <video> 会先失去 src 再拿到新的，产生一次黑屏闪烁。
  const [mediaPreviewId, setMediaPreviewId] = useState<string | null>(null);
  // generation 是媒体链路的「事务号」：每次切换 source 自增，异步回调只有在
  // 号段仍匹配时才允许 setState。disposed 只能防卸载，防不住「同一组件内切换文件」，
  // 这正是媒体最容易出现的竞态（旧视频的 onLoadedMetadata 覆盖新视频时长）。
  const mediaPreviewGenerationRef = useRef(0);
  // 三个重试相关 ref 必须分开：attempted 防「重试多次」，inFlight 防「并发重试」，
  // timer 持有延迟句柄用于 cleanup。合并成布尔会让「定时器已排期但还没执行」
  // 这一状态无法表达，清理时就不知道该不该取消。
  const mediaRefreshAttemptedRef = useRef(false);
  // 与 attempted 的区别：attempted 表示「这次加载已经用过一次重试机会」，
  // inFlight 表示「refresh 请求正在路上」。只看 attempted 时，
  // 500ms 定时器窗口内的连续 error 事件会排队多个 refresh 请求。
  const mediaRefreshInFlightRef = useRef(false);
  // 存句柄（而不是布尔）才能在 cleanup 里真正取消排期；类型写成 ReturnType<typeof setTimeout>
  // 是为了同时兼容浏览器 number 与 Node 的 Timeout 对象——本文件会被 SSR/测试导入。
  const mediaRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 刷新预览（Host 侧重新 prepare）会让 <video> 换 src 并重置播放进度，
  // 因此这里暂存播放位置、暂停态与音量，等新 url 就绪后恢复一次。
  // 只存一个快照而不是持续同步：播放中每秒更新 ref 没有意义，且会让恢复值滞后。
  const mediaPlaybackRestoreRef = useRef<{
    currentTime: number;
    paused: boolean;
    volume: number;
    muted: boolean;
  } | null>(null);
  // PDF 的 loading 与 viewerSource 成对出现：viewerSource 为 null 且 loading=true 是
  // 「正在读」，两者都为 null/false 是「没有 PDF」。若只有 viewerSource，
  // 无法区分「还没读完」与「读取失败后清空」，骨架屏会闪错。
  const [loadingPdfPreview, setLoadingPdfPreview] = useState(false);
  // viewerSource 有两种形态（data URL 或「总长 + 取块函数」），组件侧统一消费，
  // 因此类型是 PdfViewerSource 而不是 string。把它置 null 是「清空」的唯一方式，
  // 也让切换文件时旧 PDF 立刻卸载（pdf.js 的 worker 会随之释放）。
  const [pdfViewerSource, setPdfViewerSource] = useState<PdfViewerSource | null>(null);
  // Office 结果与 PPTX 分开存：docx/xlsx 走「转 HTML/表格」的通用通道，
  // pptx 需要单独的解析器与 watch 流程（INV-8/9）。合并会让 PPTX 的完整性校验
  // 误作用到 docx 上（docx 的 stat 与读取之间没有 watch 保护）。
  const [officePreview, setOfficePreview] = useState<FileBinaryPreview | null>(null);
  const [loadingOfficePreview, setLoadingOfficePreview] = useState(false);
  // PPTX 的 loading 单独一个：它比 Office 多两步（等 watch ready、二次 stat），
  // 耗时不可预测。共用一个 loading 会让「打开 docx」时也显示 PPTX 的进度文案。
  const [loadingPptxPreview, setLoadingPptxPreview] = useState(false);
  // PPTX 数据用 ArrayBuffer 而不是 base64 字符串：解析器直接消费二进制，
  // 转成字符串会多出一份约 1.33 倍的常驻副本（几十 MB 级）。置 null 即释放。
  const [pptxPreviewData, setPptxPreviewData] = useState<ArrayBuffer | null>(null);
  // 单独记录「已验证存在」的 requestId，而不是布尔：同一个面板可能连续收到
  // 两个引用导航请求，布尔无法区分「当前这个已验证」与「上一个已验证」，
  // 会让第二次跳转复用一个陈旧的成功结论，于是文件已删却仍按存在处理。
  const [validatedPptxReferenceNavigationRequestId, setValidatedPptxReferenceNavigationRequestId] =
    useState<string | null>(null);
  // error 是「单一展示位」：任一链路失败都写到这里，由顶部的 error 区统一呈现。
  // 它的值必须已经脱敏（INV-10）。多个链路不会并发写——每当 source 变化，
  // 下面的大 effect 先把它清空，因此不存在两条链路互相覆盖的窗口。
  const [error, setError] = useState<string | null>(null);
  // code-review 没有真实文件路径（它是多个文件的差异集合），传 path 进去会让
  // getInstalledEditors 去探测一个不存在的路径，返回空列表并让「在编辑器中打开」永远灰着。
  const editorFilePath = source?.type !== "code-review" ? source?.path : undefined;
  // 结果与查询路径一起存：异步返回时若只存 editors，无法判断它属于哪个文件，
  // 快速切换文件后旧结果会被当成新路径的列表（下面 installedEditors 正是靠 path 比对丢弃它），
  // 用户点「在编辑器中打开」就会把新文件交给一个只装旧路径的编辑器集。
  const [installedEditorQuery, setInstalledEditorQuery] = useState<{
    path: string | undefined;
    editors: EditorInfo[];
  } | null>(null);
  // 文件类型变化后不能沿用上一份应用列表；查询结果与路径绑定，旧请求由 effect 清理失效。
  const installedEditors = useMemo(
    () =>
      installedEditorQuery?.path === editorFilePath ? (installedEditorQuery?.editors ?? []) : [],
    [installedEditorQuery, editorFilePath],
  );
  // 偏好只读一次（惰性初始化）：用户在本面板里改选编辑器时会写 localStorage，
  // 但那个写入不驱动重渲染，下一帧读到的偏好不应影响当前这次打开动作。
  // 用 useState 而不是模块级常量，是为了每个面板实例各拿一份，避免跨窗口共享旧值。
  const [preferredEditorId] = useState<string | null>(() => readLastSelectedEditorId());
  // 三个视图偏好都是本地状态而不是全局设置：它们属于「这一份内容此刻怎么读」，
  // 切换文件后必须重置（见对应 effect），否则从 md 源码切到图片会留下无效的 code 模式。
  // 初始值 preview 对 md/svg 都合法，纯文本文件不会用到这两个值。
  const [markdownViewMode, setMarkdownViewMode] = useState<"preview" | "code">("preview");
  // svg 与 markdown 分开存而不是共用一个 viewMode：两种文件的默认视图不同，
  // 共用会让切换类型时互相污染（例如从 md 源码切到 svg 仍停在 code，看不到图形）。
  const [svgViewMode, setSvgViewMode] = useState<"preview" | "code">("preview");
  // 三态而不是布尔：null 才能表达「跟随全局设置」，布尔会把用户没动过的开关
  // 固化成当时的值，之后修改全局换行设置也不再生效。
  const [wrapLongLinesOverride, setWrapLongLinesOverride] = useState<boolean | null>(null);
  // 遮罩状态由测量得出而不是用 CSS 自动淡出：CSS 无法「只在溢出方向」加渐变，
  // 而测量结果可以精确区分左/右/两侧，避免短路径也出现渐隐、看起来像内容缺失。
  const [breadcrumbMaskState, setBreadcrumbMaskState] = useState<BreadcrumbMaskState>("none");
  // 面包屑的滚动容器与内容容器分开持有：判断「是否被裁切」需要比较 scrollWidth 与
  // clientWidth，而遮罩状态要挂在滚动容器上。只留一个 ref 就无法在内容变化时测量。
  const breadcrumbScrollRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbContentRef = useRef<HTMLDivElement | null>(null);
  // 这个 ref 由 CodeViewer 内部转发回来（外层 div 不滚动），
  // 因此它只在重内容挂载后才有值：滚动恢复必须先判空再赋值，否则写入无效且无提示。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // 只保存两个数而不是 DOM 引用：恢复滚动发生在重内容挂载之后，
  // 那时旧容器可能已被替换（CodeViewer 内部自建滚动容器），持有引用等于持有已卸载节点。
  // 初始 0 表示「还没记录过」，与真实滚到 0 的行为一致（都是回到顶部），无需额外哨兵。
  const preservedScrollMetricsRef = useRef({
    scrollHeight: 0,
    scrollTop: 0,
  });
  // 只在 false→true 的边沿做一次滚动恢复；若每次渲染都比较，重内容内部的
  // 增量渲染（加载更多行）也会被误判成「刚挂载」，把用户拽回旧位置（INV-12）。
  const previousRenderHeavyContentRef = useRef(renderHeavyContent);
  // theme 可能是 "system"，必须先 resolve：CodeViewer 只接受明/暗两套色板，
  // 直接透传会让它在换系统主题时拿到非法值并回退到默认浅色（与界面其余部分不一致）。
  // codeTheme 再按解析结果选一套 token，两步不能合并，否则 system 无法区分。
  const resolvedTheme = resolveTheme(theme);
  const codeTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;
  // 五个派生源全部在这里一次性算完，顺序即优先级：image → media → pdf → office → pptx。
  // 每个都依赖同一个 source，因此 useMemo 的意义不是省计算，而是保持引用稳定，
  // 让下面的 fileSource 与各 effect 的依赖比较不会因为新对象而反复触发（INV-20）。
  const imageSource = useMemo(() => resolvePreviewPaneImageSource(source), [source]);
  const mediaSource = useMemo(() => resolvePreviewPaneMediaSource(source), [source]);
  const pdfSource = useMemo(() => resolvePreviewPanePdfSource(source), [source]);
  const officePreviewKind = useMemo(
    () => (source?.type === "file" ? getOfficeFilePreviewKind(source.path) : null),
    [source],
  );
  const pptxSource = useMemo(() => resolvePreviewPanePptxSource(source), [source]);
  const showDocumentHeaderDivider = shouldShowPreviewPaneHeaderDivider(source);
  const pptxSourcePath = pptxSource?.path ?? null;
  const pptxReferenceNavigation = pptxSource?.referenceNavigation ?? null;
  // ready 表示「文件已停止变化且已稳定」，只有它为真才允许读取 PPTX（INV-9）。
  // reloadGeneration 在外部重写文件时自增，用来触发重读——它是 effect 依赖，
  // 因此 PPTX 的读取 effect 必须同时依赖这两个值，漏一个都会读到旧内容。
  const { ready: pptxFileWatchReady, reloadGeneration: pptxReloadGeneration } = usePptxFileWatch({
    filePath: pptxSourcePath,
    fileWatcherService,
  });
  // diff 的「打开为代码查看器」需要一个单文件来源：从 patch 里挑出被聚焦的那个文件，
  // 但只在 source.type === "code-review" 时有意义，其它类型这里恒为 undefined。
  // memo 依赖 diff 内容与回调，避免头部「打开」按钮的可用性在每次渲染时重算。
  const diffFilePreviewSource = useMemo(
    () =>
      source?.type === "patch" || source?.type === "multi-file-diff"
        ? createDiffSourceFilePreviewSource(source, sourceWorkspacePath)
        : null,
    [source, sourceWorkspacePath],
  );
  // fileSource 是「兜底分支」：只有当没有任何专用预览源接手时才成立（INV-2）。
  // 五个否定条件缺一不可——例如漏掉 mediaSource，音频文件会同时走文本读取，
  // 二进制内容被当 UTF-8 解码，界面出现一大段乱码且没有播放器。
  const fileSource =
    (source?.type === "file" || source?.type === "code-review") &&
    !imageSource &&
    !pdfSource &&
    !officePreviewKind &&
    !pptxSource &&
    !mediaSource
      ? source
      : null;
  // bucket 是评论 store 的键：路径 + 工作区身份三元组。缺任一字段就不建 bucket，
  // 因为「同一个相对路径在不同 Host 上是不同文件」，只按 path 取评论会串台。
  // code-review 单独排除：它的评论以「文件+行区间」聚合，不走单文件 store。
  const codeCommentBucket = useMemo(
    () =>
      source?.type !== "code-review" && source?.path && sourceWorkspacePath
        ? {
            workspacePath: sourceWorkspacePath,
            workspaceIdentity: source.workspaceIdentity,
            sourcePath: source.path,
          }
        : null,
    [source, sourceWorkspacePath],
  );
  // selector 必须返回稳定引用（INV-11）：没有 bucket 时返回模块级空常量，
  // 而不是 [] 或 state.getComments 的新对象。useSyncExternalStore 会在快照
  // 每次变化时重渲染，新引用等价于「永远在变化」，直接进入无限更新循环。
  const codeComments = useCodeCommentPreviewStore((state) =>
    // code-review 不读取 Composer 评论 store，但这里每次 selector 求值都不能返回新的 []，
    // 否则会破坏 useSyncExternalStore 的稳定 snapshot 契约并触发无限更新。
    codeCommentBucket ? state.getComments(codeCommentBucket) : EMPTY_CODE_COMMENT_PREVIEWS,
  );
  const addCodeCommentPreview = useCodeCommentPreviewStore((state) => state.addComment);
  const removeCodeCommentPreview = useCodeCommentPreviewStore((state) => state.removeComment);
  // 面包屑是纯派生数据，但必须 memo：它参与两个 useLayoutEffect 的依赖，
  // 每次渲染新建对象会让那两个 effect 每帧重挂监听并重算遮罩，长文档滚动时掉帧。
  const breadcrumb = useMemo(
    () => (source ? buildCodeViewerBreadcrumb(source, sourceWorkspacePath) : null),
    [source, sourceWorkspacePath],
  );
  // 远程来源时把 installedEditors 置空（除非鸿蒙/远程目标已知）：本机安装的 VS Code
  // 无法打开另一台 Host 上的文件，列出来只会让用户点出一个必然失败的动作（INV-18）。
  // 这里传 [] 而不是过滤 installedEditors，是为了让 resolveWorkspaceEditorSelection
  // 的「无可用编辑器」分支统一生效，而不是在 UI 层另写一套禁用逻辑。
  const editorSelection = useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        installedEditors: isRemoteSource && !openInEditorRemoteTarget ? [] : installedEditors,
        selectedEditorId: preferredEditorId,
        remoteTarget: openInEditorRemoteTarget,
      }),
    [installedEditors, isRemoteSource, openInEditorRemoteTarget, preferredEditorId],
  );
  const selectedEditor = editorSelection.selectedEditor;
  const canOpenInEditor = Boolean(source?.path && selectedEditor);
  // 可点 = 有来源 + 宿主接了打开回调。两者缺一时按钮 disabled 而不是隐藏，
  // 保证头部按钮数量恒定（隐藏会让面包屑宽度在切换文件时跳变）。
  const canOpenDiffFilePreview = Boolean(diffFilePreviewSource && onOpenCodeViewer);
  // 三态：null 表示「跟随设置」，true/false 是用户这一次的显式选择。
  // 用 ?? 而不是 ||：用户明确关掉换行（false）必须能压过设置为 true，
  // 用 || 会让「关」这个动作失效，表现为点了菜单项没反应。
  const wrapLongLines = wrapLongLinesOverride ?? codePreviewSettings.wrapLongLines;
  const canCreateCodeComment = Boolean(
    source?.type !== "code-review" && source?.path && sourceWorkspacePath,
  );
  // 派生选项只依赖 source 与两个视图模式，而不是 wrapLongLinesOverride：
  // 换行开关是否「可切换」与当前值无关，把它加进依赖会让菜单在每次切换时重建。
  // 返回值里的 hasMoreMenu 直接决定菜单挂不挂载，避免渲染一个空菜单。
  const displayOptions = useMemo(
    () =>
      getPreviewPaneDisplayOptions(source, {
        markdownViewMode,
        svgViewMode,
      }),
    [markdownViewMode, source, svgViewMode],
  );
  const { canToggleCodeWrap, canToggleMarkdownView, canToggleSvgView, hasMoreMenu } =
    displayOptions;
  // labels 对象一次性构造并 memo：CodeViewer 内部会把它放进依赖数组，
  // 每次渲染新建对象会让评论区的 memo 失效，输入时每个字符都重渲染整块代码。
  // 只依赖 intl（语言切换时才变），不依赖 source——文案与文件无关。
  const codeCommentLabels = useMemo(
    () => ({
      addComment: intl.formatMessage({ id: "codeViewer.comment.add" }),
      addCommentTooltip: intl.formatMessage({
        id: "codeViewer.comment.addTooltip",
      }),
      commentPlaceholder: intl.formatMessage({
        id: "codeViewer.comment.placeholder",
      }),
      submitComment: intl.formatMessage({ id: "codeViewer.comment.submit" }),
      cancelComment: intl.formatMessage({ id: "common.cancel" }),
      deleteComment: intl.formatMessage({ id: "codeViewer.comment.delete" }),
      commentLine: intl.formatMessage({ id: "codeViewer.comment.line" }),
      commentRange: intl.formatMessage({ id: "codeViewer.comment.range" }),
    }),
    [intl],
  );
  // PDF / PPTX 的标签与 dwf 的 workflow-artifact tab 共用一份（见该 hook 的注释）：
  // 两个 labels 接口都是必填全字段，各写一份漏的不会是类型错误，而是一句没翻译的文案。
  // PDF 与 PPTX 的 labels 必须是完整字段对象：缺字段不会报类型错，
  // 而是渲染出一句英文 key 或空白按钮，所以统一从 hook 取而不是就地拼。
  const pdfViewerLabels = usePdfViewerLabels();
  // 与 PDF 共用同一套实现，但分开调用：两者将来若出现专属文案，
  // 合并成一个 hook 会让改一处影响另一处。
  const pptxViewerLabels = usePptxViewerLabels();

  useEffect(() => {
    let disposed = false;

    // 失败只 warn 不 setError：拿不到编辑器列表只影响「在编辑器中打开」这一个动作，
    // 不该用错误横幅盖住正在正常预览的内容。disposed 守卫防止卸载后 setState。
    platform
      .getInstalledEditors(editorFilePath)
      .then((editors) => {
        if (disposed) {
          return;
        }

        setInstalledEditorQuery({ path: editorFilePath, editors });
      })
      .catch((platformError) => {
        logger.warn("[PreviewPane] 获取已安装编辑器列表失败", {
          error: platformError instanceof Error ? platformError.message : String(platformError),
        });
      });

    return () => {
      disposed = true;
    };
  }, [platform, editorFilePath]);

  // source 变化的唯一职责：把三个视图偏好重置成「这份文件的合理默认」（INV-15）。
  // 必须无条件执行（即使 source 为空时提前 return，也是刻意的：关闭预览不应重置偏好，
  // 这样重新打开同一文件时能保留上次的视图选择）。
  // 依赖只有 source：加入 viewMode 会让「用户切换视图」反过来又触发一次重置，形成死循环。
  useEffect(() => {
    if (!source) {
      return;
    }

    setMarkdownViewMode(
      source.type !== "code-review" && (isMarkdownSource(source) || isMarkdownFilePath(source.path))
        ? "preview"
        : "code",
    );
    setSvgViewMode(
      source.type !== "code-review" && (isSvgSource(source) || isSvgFilePath(source.path))
        ? "preview"
        : "code",
    );
    setWrapLongLinesOverride(null);
  }, [source]);

  // 评论提交是「先发到聊天，再写预览 store」的两步：
  // 第一步让评论进入 Composer（可被用户编辑/发送），第二步才是代码行上的气泡。
  // 顺序不能反——若先写气泡，dispatch 失败时会出现「行上有评论但聊天里没有」，
  // 用户点删除也只能删掉气泡，评论内容却已丢失。
  const handleSubmitCodeComment = useCallback(
    (params: { range: CodeCommentRange; selectedText: string; comment: string }) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }

      const normalizedComment = params.comment.trim();
      const commentId = nanoid();
      dispatchCodeCommentAddToChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        sourceTitle: source.title,
        startLine: params.range.startLine,
        endLine: params.range.endLine,
        selectedText: params.selectedText,
        comment: normalizedComment,
        contextLabel: intl.formatMessage({
          id: "codeViewer.comment.contextLabel",
        }),
        commentLabel: intl.formatMessage({
          id: "codeViewer.comment.commentLabel",
        }),
      });
      // 幂等保护（INV-17）：dispatch 期间用户可能已经删掉这条评论，
      // 此时 isCodeCommentMarkedRemoved 为真，必须放弃写入，否则刚删的评论会被复活。
      // 这是一个真实的时序窗口（dispatch 会同步通知 store 订阅者），不是防御性代码。
      if (
        isCodeCommentMarkedRemoved({
          id: commentId,
          workspacePath: sourceWorkspacePath,
          workspaceIdentity: source.workspaceIdentity,
        })
      ) {
        return;
      }
      addCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        comment: {
          id: commentId,
          sourcePath: source.path,
          sourceTitle: source.title,
          startLine: params.range.startLine,
          endLine: params.range.endLine,
          selectedText: params.selectedText,
          comment: normalizedComment,
        },
      });
    },
    [addCodeCommentPreview, intl, source, sourceWorkspacePath],
  );

  // 删除同样两步，但顺序相反：先删气泡再通知聊天。若先通知聊天，
  // 聊天侧移除会触发一次重渲染，此时气泡还在，用户会看到「删了又回来」的闪烁。
  // 两步都不能失败重试——删除是不可逆动作，重试只会在已删状态下产生噪音。
  const handleDeleteCodeComment = useCallback(
    (commentId: string) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }
      removeCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        id: commentId,
      });
      dispatchCodeCommentRemoveFromChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
      });
    },
    [removeCodeCommentPreview, source, sourceWorkspacePath],
  );

  // 记录滚动指标的唯一入口：只在「即将卸载重内容」时调用（见 deferred 布局 effect）。
  // 不监听 scroll 事件持续记录，是因为那会在滚动时不断写 ref 并触发不必要的比较；
  // 恢复点只取「卸载前那一帧」，`rememberScrollMetrics` 由卸载 effect 调用而非滚动监听。
  const rememberScrollMetrics = useCallback(() => {
    const metrics = readPreviewPaneScrollMetrics(scrollContainerRef.current);
    if (!metrics) {
      return;
    }

    // 只记录 scrollTop 与 scrollHeight 两个数：scrollLeft 不参与恢复
    // （代码行不横向滚动），多存字段会让 ref 的比较逻辑变得不必要地复杂。
    preservedScrollMetricsRef.current = metrics;
  }, []);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    if (!viewport) {
      return;
    }

    // 交互说明：长路径首次打开时，用户最关心的是末尾文件名。
    // 这里在 breadcrumb 内容变更后只初始化滚到最右侧，后续用户手动滚动不再强行回弹。
    // 为什么用 RAF 而不是同步赋值：首次挂载时 scrollWidth 可能还没完成布局
    // （字体/图标异步加载），同步滚会滚到一个偏小的位置，表现为「差一点点没到底」。
    // cancelAnimationFrame 是必要的清理：breadcrumb 快速连续变化时避免旧帧覆盖新位置。
    const frameId = requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [breadcrumb, headerContainer]);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    const content = breadcrumbContentRef.current;
    if (!viewport || !content) {
      setBreadcrumbMaskState("none");
      return;
    }

    const updateMaskState = () => {
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      if (maxScrollLeft <= 1) {
        setBreadcrumbMaskState("none");
        return;
      }

      // 1px 容差：滚动位置是浮点数，高分屏下 scrollLeft 常常是 0.5 的倍数，
      // 严格比较会让遮罩在「刚好到边」时仍然显示，看起来像内容被截断。
      // left/right 分别判、再合成 both，是为了让 CSS 只处理两种方向的渐变。
      const hasHiddenLeft = viewport.scrollLeft > 1;
      const hasHiddenRight = viewport.scrollLeft < maxScrollLeft - 1;
      setBreadcrumbMaskState(
        hasHiddenLeft && hasHiddenRight
          ? "both"
          : hasHiddenLeft
            ? "left"
            : hasHiddenRight
              ? "right"
              : "none",
      );
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateMaskState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    // 先同步跑一次再挂监听：首帧若只依赖 scroll 事件，遮罩要等用户滚动才出现，
    // 长路径初始就溢出时看起来像被裁掉一截却没有提示。
    updateMaskState();
    viewport.addEventListener("scroll", updateMaskState, { passive: true });

    // ResizeObserver 不存在的环境（旧 Safari / 测试 jsdom）退化为只监听 window resize：
    // 面板宽度变化不一定伴随 window resize（拖拽侧栏），所以这是一次降级而非等价实现，
    // 但至少保证遮罩不会永远停在初始值。两条清理路径都必须完整，否则监听器泄漏。
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateMaskState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    // observer 同时观察 viewport 与 content：只观察 viewport 时，
    // 内容变化（文件名变长）但容器尺寸不变，遮罩状态会停留在旧值。
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateMaskState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateMaskState);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [breadcrumb, headerContainer]);

  useEffect(() => {
    let disposed = false;

    preservedScrollMetricsRef.current = {
      scrollHeight: 0,
      scrollTop: 0,
    };
    setFilePreview(null);
    setFileTooLarge(false);
    setError(null);
    // 先清空所有读取结果再发请求：不清的话，切换文件的那一帧会同时显示
    // 新面包屑与旧内容（旧图片/旧错误），用户会以为预览加载错了文件。
    setLoadingInitial(Boolean(fileSource));
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    if (!fileSource) {
      return () => {
        disposed = true;
      };
    }

    // 把传输分块直接当成多个文档解码和渲染，会在 UTF-8 字符中间产生乱码，
    // 同时让每块行号从 1 重置。文本预览现在只读取 service 允许的完整上限；
    // 非二进制结果返回 truncated 时丢弃局部文本并提示文件过大，不再拼接分块。
    // length 用 FILE_VIEWER_MAX_TEXT_BYTES 而不是「按块循环读」：一次完整读取才能保证
    // 多字节字符不被切断（INV-6）。分块拼接看起来省内存，实际会制造乱码与行号重置，
    // 这是本项目明确放弃的方案，改动前先看 INV-6 的后果。
    void fileService
      .readTextFile({
        path: fileSource.path,
        offset: 0,
        length: FILE_VIEWER_MAX_TEXT_BYTES,
      })
      .then((result) => {
        if (disposed) {
          return;
        }

        // 归一化必须在这一层做，而不是在两个 setState 里各判一次：
        // resolvePreviewPaneTextFileResult 同时处理 truncated 与 isBinary，
        // 拆开写会让「二进制且超限」落进两个分支之间的缝隙（既显示乱码又显示提示）。
        const nextFileState = resolvePreviewPaneTextFileResult(result);
        setFilePreview(nextFileState.filePreview);
        setFileTooLarge(nextFileState.fileTooLarge);
      })
      .catch((readError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取文件失败 path=${fileSource.path}:`, readError);
        setError(
          isPreviewPaneMissingFileError(readError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : readError instanceof Error
              ? readError.message
              : String(readError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingInitial(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, fileSource, intl]);

  useEffect(() => {
    let disposed = false;

    // 没有图片来源时必须把三个状态一起清掉（含 loading）：否则从图片切到文本，
    // loadingImagePreview 会永远停在 true，下游的骨架屏会一直显示。
    // 这里不清 error：error 的清理统一由「大 effect」在 source 变化时负责，避免两条链路互相清对方的消息。
    if (!imageSource) {
      setImagePreview(null);
      setLoadingImagePreview(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingImagePreview(true);
    setImagePreview(null);
    setError(null);

    // 图片读取不走 mediaPreview 的句柄流程：它没有播放器与进度恢复，
    // 一个 base64 就够。用 prepare 会额外产生需要 release 的 previewId（INV-5）。
    void fileService
      .readMediaPreview({ path: imageSource.path })
      .then((result) => {
        if (disposed) {
          return;
        }

        // 成功分支同样依赖上面的 disposed 检查：切换文件后旧结果若写进来，
        // 新文件的预览区会显示上一张图片，且没有任何 loading 覆盖它。
        setImagePreview(result);
      })
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取图片预览失败 path=${imageSource.path}:`, previewError);
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : previewError instanceof Error
              ? previewError.message
              : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingImagePreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, imageSource, intl]);

  useEffect(() => {
    let disposed = false;
    // 两个局部变量是 cleanup 的唯一抓手：它们在 effect 闭包里被赋值，
    // 而 cleanup 也闭包捕获同一份绑定，因此能取到请求返回后写入的值。
    // 若改成 ref，并发切换时 cleanup 会读到下一次请求刚写入的句柄，释放错对象。
    let objectUrl: string | null = null;
    let preparedPreviewId: string | null = null;
    // generation 在每次 effect 执行时自增，必须在任何 await 之前完成（这里是最顶部）：
    // 放到 await 之后的话，两个并发 effect 可能拿到同一个号，竞态保护失效。
    // 注意它与 disposed 是两套机制：disposed 管卸载，generation 管「同实例换 source」。
    const generation = ++mediaPreviewGenerationRef.current;

    if (!mediaSource) {
      setLoadingMediaPreview(false);
      setMediaPreviewUrl(null);
      setMediaPreviewId(null);
      mediaRefreshAttemptedRef.current = false;
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      mediaPlaybackRestoreRef.current = null;
      return () => {
        disposed = true;
      };
    }

    // 进入「准备中」态：此时既没有 url 也没有 id，UI 显示播放器骨架。
    // 这个 true 必须在 await 之前设置，否则快速切换时会出现一帧「既没骨架也没内容」。
    setLoadingMediaPreview(true);
    setMediaPreviewUrl(null);
    setMediaPreviewId(null);
    setError(null);
    mediaRefreshAttemptedRef.current = false;
    mediaRefreshInFlightRef.current = false;
    if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
    mediaRefreshTimerRef.current = null;
    mediaPlaybackRestoreRef.current = null;
    // 没有 mediaPreviewService 是「旧 Host / 精简构建」的正常形态，必须给出可读提示
    // 而不是静默失败：用户看到一片黑只会以为文件坏了，无从判断是能力缺失。
    // 这里提前 return 而不是把 prepare 包在 try 里，是为了让 loading 立刻收敛。
    if (!mediaPreviewService) {
      setLoadingMediaPreview(false);
      setError(intl.formatMessage({ id: "codeViewer.mediaUnavailable" }));
      return () => {
        disposed = true;
      };
    }

    void mediaPreviewService
      .prepare({
        path: mediaSource.path,
        expectedKind: mediaSource.kind,
      })
      // 返回值有两种形状（带 url 的直链 / 带 previewId 的句柄），必须先用 in 判别再取值：
      // 直接访问 preview.url 在句柄形态下是 undefined，会让 <video src={undefined}> 静默失败。
      .then((preview) => {
        const previewId = "previewId" in preview ? preview.previewId : null;
        if (previewId) preparedPreviewId = previewId;
        // 这是资源释放最容易漏的一条路径（INV-5）：请求成功返回时 effect 可能已经
        // 因为切换文件而清理过，此刻 preparedPreviewId 的句柄无人持有，
        // 必须在「发现自己是过期请求」的分支里立刻 release，否则 Host 侧永久泄漏。
        // 这里不能只靠 cleanup——cleanup 执行时 preparedPreviewId 还是 null（请求未回）。
        if (disposed || generation !== mediaPreviewGenerationRef.current) {
          if (previewId && mediaPreviewService?.release) {
            void mediaPreviewService.release({ previewId }).catch(() => undefined);
          }
          return;
        }
        // 直链形态不需要 objectURL，也不能 revoke（它不由我们创建）；
        // 句柄形态才走 Blob + createObjectURL。两条路径的 cleanup 不同，
        // 这就是 objectUrl 变量必须从外部闭包捕获的原因。
        if ("url" in preview) {
          if (previewId) setMediaPreviewId(previewId);
          setMediaPreviewUrl(preview.url);
        } else {
          // base64 → Blob 是同步的大字符串操作，几十 MB 时会有明显卡顿；
          // 但相比把 base64 直接塞进 <video src>（部分浏览器拒绝超长 data URL）这是必要代价。
          objectUrl = URL.createObjectURL(
            new Blob([decodeBase64ToArrayBuffer(preview.dataBase64)], {
              type: preview.mediaType,
            }),
          );
          setMediaPreviewUrl(objectUrl);
        }
      })
      .catch((previewError: unknown) => {
        if (disposed || generation !== mediaPreviewGenerationRef.current) return;
        logger.error("[PreviewPane] 读取媒体预览失败", {
          path: mediaSource.path,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : previewError instanceof Error
              ? previewError.message
              : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed && generation === mediaPreviewGenerationRef.current) {
          setLoadingMediaPreview(false);
        }
      });

    // cleanup 必须同时处理四件事，缺一即泄漏：
    // 1) revoke objectURL（否则 Blob 常驻内存）；2) 清 refresh 定时器；
    // 3) release Host 句柄；4) 标记 disposed 拦住后续 then。
    // release 用 .catch(() => undefined) 吞错：卸载路径上抛错会污染控制台且无法补救。
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      if (preparedPreviewId && mediaPreviewService?.release) {
        void mediaPreviewService.release({ previewId: preparedPreviewId }).catch(() => undefined);
      }
    };
  }, [intl, mediaPreviewService, mediaSource]);

  // 媒体错误处理是一条「先重试一次，再报错」的状态机：
  // 有 previewId 且 Host 支持 refreshPlaybackUrl 时，先换一个临时 URL 重试，
  // 因为视频播放失败最常见的原因是签名 URL 过期，而不是文件损坏。
  // 重试只允许一次（mediaRefreshAttemptedRef），否则过期 URL 会形成无限重试。
  const handleMediaError = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const mediaElement = event.currentTarget;
      const refreshPlaybackUrl = mediaPreviewService?.refreshPlaybackUrl;
      if (!mediaPreviewId || !refreshPlaybackUrl) {
        setError(
          intl.formatMessage({
            id: resolveMediaPlaybackErrorMessageId(mediaElement.error?.code),
          }),
        );
        return;
      }
      // 两个 ref 分别防「已经重试过」与「正在重试中」：只用其中一个，
      // 在 500ms 定时器触发前的窗口里连续报错会排队多次 refresh，导致播放器反复换源。
      if (mediaRefreshAttemptedRef.current || mediaRefreshInFlightRef.current) {
        setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
        return;
      }

      mediaRefreshAttemptedRef.current = true;
      const generation = mediaPreviewGenerationRef.current;
      // 快照必须在换源之前取：setError(null) 与新 url 的 setState 会触发重渲染，
      // 之后 currentTime 可能已被浏览器重置为 0，再取就丢失了用户的播放位置。
      // Number.isFinite 兜住 NaN（某些编码下 duration/currentTime 为 NaN）。
      mediaPlaybackRestoreRef.current = {
        currentTime: Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0,
        paused: mediaElement.paused,
        volume: mediaElement.volume,
        muted: mediaElement.muted,
      };
      setError(null);
      // 延迟 500ms 再换源，给浏览器一次「自己重试」的机会（网络抖动常在一秒内恢复）；
      // 立即换源会让本来能自愈的播放变成一次可见的重载。定时器句柄存 ref 以便 cleanup 取消。
      mediaRefreshTimerRef.current = setTimeout(() => {
        mediaRefreshTimerRef.current = null;
        if (generation !== mediaPreviewGenerationRef.current) return;
        mediaRefreshInFlightRef.current = true;
        void refreshPlaybackUrl({ previewId: mediaPreviewId })
          // 只替换 url，不动 previewId 与 loading：播放器不卸载，
          // 因此进度恢复由 handleMediaLoadedMetadata 完成，这里不重复设置。
          .then(({ url }) => {
            if (generation === mediaPreviewGenerationRef.current) setMediaPreviewUrl(url);
          })
          .catch(() => {
            if (generation === mediaPreviewGenerationRef.current) {
              setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
            }
          })
          .finally(() => {
            mediaRefreshInFlightRef.current = false;
          });
      }, 500);
    },
    [intl, mediaPreviewId, mediaPreviewService],
  );

  // 元数据就绪后恢复一次播放状态，然后立刻把快照置空：
  // 置空是为了让「用户自己暂停/调音量」不会被下一次 loadedmetadata（例如切码率）覆盖。
  // currentTime 赋值可能抛 InvalidStateError（可 seek 范围未就绪），捕获后放弃恢复进度，
  // 由浏览器按默认从头播放——这比让整个播放器报错要好。
  const handleMediaLoadedMetadata = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const restore = mediaPlaybackRestoreRef.current;
    if (!restore) return;
    const mediaElement = event.currentTarget;
    // 音量恢复必须夹在 0..1：浏览器会拒绝越界值并抛 IndexSizeError，
    // 而快照可能来自被 Host 改写过的异常状态。muted 单独恢复，因为 volume=0 与 muted 语义不同。
    mediaElement.volume = restore.volume;
    mediaElement.muted = restore.muted;
    try {
      mediaElement.currentTime = restore.currentTime;
    } catch {
      // 媒体元数据尚未完全就绪时由浏览器稍后继续处理，不阻断播放器加载。
    }
    if (!restore.paused) void mediaElement.play().catch(() => undefined);
    mediaPlaybackRestoreRef.current = null;
  }, []);

  useEffect(() => {
    let disposed = false;

    if (!pdfSource) {
      setPdfViewerSource(null);
      setLoadingPdfPreview(false);
      return () => {
        disposed = true;
      };
    }

    // 先置 loading 再 stat：PDF 的 stat + 读取可能跨两次 IPC，
    // 这期间若显示旧内容，用户会以为打开的是上一个文件。清空 viewerSource 同理。
    setLoadingPdfPreview(true);
    setPdfViewerSource(null);
    setError(null);

    // 路径在 effect 开头就固化：后续闭包（readWholeFile / requestRange）都引用它，
    // 若在回调里重新读 pdfSource.path，source 切换后可能读到新路径而写到旧请求上。
    const path = pdfSource.path;
    // 全量读取用「循环 range + 预分配」而不是逐步 push 到可增长数组：
    // pdf.js 需要一段连续的 Uint8Array，多次拼接会产生大量中间副本（几十 MB 级）。
    // 读取期间每块后都检查 disposed（INV-3）：文件大到需要多块时，用户可能已经切走。
    const readWholeFile = async (totalBytes: number): Promise<Uint8Array | null> => {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < totalBytes) {
        const chunk = await fileService.readFileRange({
          path,
          offset,
          length: PDF_RANGE_CHUNK_BYTES,
        });
        if (disposed) {
          return null;
        }
        if (chunk.length === 0) {
          // 读取期间文件被截断时按已读部分返回，交给 pdf.js 判定完整性，避免死循环
          break;
        }
        chunks.push(chunk);
        offset += chunk.length;
      }
      // 预分配后再逐块 set：pdf.js 需要连续的 Uint8Array，
      // 用 chunks.flat() 或反复 concat 会复制出多份中间缓冲，
      // 大文件（数十 MB）下内存峰值翻倍且触发 GC 抖动。
      const data = new Uint8Array(offset);
      let position = 0;
      for (const chunk of chunks) {
        data.set(chunk, position);
        position += chunk.length;
      }
      return data;
    };

    void (async () => {
      const fileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }

      if (typeof fileStat.size !== "number") {
        // 版本偏差兜底：旧远端 stat 不返回 size，也一定没有 readFileRange，
        // 回退整档 base64 的旧通道（保留其 8MB 上限，超限走 catch 报错文案）。
        const preview = await fileService.readMediaPreview({ path });
        if (disposed) {
          return;
        }
        // 小文件走 data URL 而不是 objectURL：PDF 组件内部可能跨 iframe 使用该地址，
        // blob: 在部分沙箱 iframe 里不可访问（被当作不透明源），data: 则始终可用。
        setPdfViewerSource(`data:application/pdf;base64,${preview.dataBase64}`);
        return;
      }

      // 小文件全量读：阈值与 PPTX/文本共用同一「一次 IPC 可接受体积」的量级判断。
      // 用 <= 而不是 <：恰好等于阈值的文件按全量处理，避免一次只取到一字节的 range 边界。
      if (fileStat.size <= PDF_FULL_READ_MAX_BYTES) {
        const data = await readWholeFile(fileStat.size);
        // 只有读到的数据非空才提交：data 为 null 表示中途被判为 disposed，
        // 此时提交会让 pdf.js 拿到一个空文档并显示「无法打开 PDF」的错误页。
        if (!disposed && data) {
          setPdfViewerSource(data);
        }
        return;
      }

      // 大文件只交出「总字节数 + 取块函数」，不预先读任何内容：
      // pdf.js 按需 range，用户只看第 1 页时不必付出整个文件的代价。
      // totalBytes 必须来自 stat 而不是 pdf.js 自己探测，否则首屏要多一次网络往返。
      const totalBytes = fileStat.size;
      setPdfViewerSource({
        totalBytes,
        requestRange: (offset, length) => fileService.readFileRange({ path, offset, length }),
      });
    })()
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取 PDF 预览失败 path=${path}:`, previewError);
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : previewError instanceof Error
              ? previewError.message
              : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingPdfPreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, pdfSource, intl]);

  useEffect(() => {
    let disposed = false;

    // Office 预览要求 type === "file"：diff / 粘贴来源没有真实路径，readBinaryPreview
    // 无从下手。这里把「类型不符」与「没有 kind」合并成同一个空态，因为对用户而言
    // 两者都表现为「这个来源不支持 Office 预览」，不需要区分。
    if (!officePreviewKind || source?.type !== "file") {
      setOfficePreview(null);
      setLoadingOfficePreview(false);
      return () => {
        disposed = true;
      };
    }

    // Office 预览同样先置 loading 并清空旧数据：docx/xlsx 的转换在 Host 侧可能耗时数秒，
    // 保留旧内容会让用户误以为新文件已打开（面包屑已变，内容未变）。
    setLoadingOfficePreview(true);
    setOfficePreview(null);
    setError(null);

    void fileService
      .readBinaryPreview({ path: source.path })
      .then((result) => {
        // Office 结果只在此处提交：失败分支保持 officePreview 为 null，
        // 保证「加载失败」不会残留上一份文档的 HTML。
        if (!disposed) {
          setOfficePreview(result);
        }
      })
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error("[PreviewPane] 读取 Office 文件预览失败", {
          path: source.path,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : isPreviewPaneFileTooLargeError(previewError)
              ? intl.formatMessage({ id: "codeViewer.officeTooLarge" })
              : previewError instanceof Error
                ? previewError.message
                : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingOfficePreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, intl, officePreviewKind, source]);

  useEffect(() => {
    // 引用导航的校验只做一件事：确认目标文件此刻存在，存在才把 requestId 标为「已验证」。
    // 这一步与真正的读取分开，是因为引用跳转需要先决定「要不要 toast」，
    // 而读取失败的原因更多（超限/损坏），不该都归到「文件不存在」。
    const navigation = pptxReferenceNavigation;
    if (!navigation || !pptxSourcePath) {
      setValidatedPptxReferenceNavigationRequestId(null);
      return;
    }
    // disposed 必须在 stat 之前声明并复位 requestId：这个 effect 每次依赖变化都会
    // 重新执行，旧请求可能在新请求已标为「已验证」之后才返回，
    // 若不守卫就会用旧结论覆盖新结论（两个 requestId 不同）。
    // 复位放到 await 之前，保证任何时刻都只承认「当前这一次」的验证结果。
    let disposed = false;
    setValidatedPptxReferenceNavigationRequestId(null);
    void fileService
      .stat({ path: pptxSourcePath })
      .then(() => {
        if (!disposed) {
          setValidatedPptxReferenceNavigationRequestId(navigation.requestId);
        }
      })
      .catch((navigationError: unknown) => {
        if (!disposed && shouldToastPptxReferenceFileMissing(pptxSource, navigationError)) {
          toast(
            intl.formatMessage({
              id: "chat.pptxElements.previewFileMissing",
            }),
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [fileService, intl, pptxReferenceNavigation, pptxSource, pptxSourcePath]);

  useEffect(() => {
    let disposed = false;

    if (!pptxSourcePath) {
      setPptxPreviewData(null);
      setLoadingPptxPreview(false);
      return () => {
        disposed = true;
      };
    }

    // 未就绪时必须清空上次的数据并置 loading，而不是保留旧内容：
    // 保留会让「引用到另一个 pptx」的瞬间仍显示上一个文件，用户以为跳转没生效。
    // 这里同样返回 cleanup（虽然只是置 disposed），因为 watch 就绪后会重新进入本 effect。
    if (!pptxFileWatchReady) {
      setPptxPreviewData(null);
      setLoadingPptxPreview(true);
      setError(null);
      return () => {
        disposed = true;
      };
    }

    // 每次真正开始读取都重新清空：watch 就绪后可能因为 reloadGeneration 再次进来，
    // 此时旧 ArrayBuffer 已过期。保留旧值会让用户在文件保存后的短暂窗口里
    // 看到上一版幻灯片，并误以为新内容已生效。
    setLoadingPptxPreview(true);
    setPptxPreviewData(null);
    setError(null);

    const path = pptxSourcePath;
    void (async () => {
      const fileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }

      if (typeof fileStat.size !== "number") {
        // 兼容旧远端：旧 Host 没有 size/range 能力，只能使用现有 8MB base64 通道。
        const preview = await fileService.readMediaPreview({ path });
        if (!disposed) {
          setPptxPreviewData(decodeBase64ToArrayBuffer(preview.dataBase64));
        }
        return;
      }

      // 超限检查放在读取之前：先读再判会让一次 64MB+ 的读取白白发生，
      // 而且 readPptxPreviewData 内部没有中途放弃机制（它会一直读完）。
      // 文案用 pptx.fileTooLarge 而不是通用超限：后者会带上旧通道的 8MB 数字。
      if (isPptxPreviewFileTooLarge(fileStat.size)) {
        setError(intl.formatMessage({ id: "codeViewer.pptx.fileTooLarge" }));
        return;
      }

      // readRange 直接绑到 fileService：不要在箭头函数里做 catch，
      // 让错误统一冒泡到外层 catch，才能保证「读失败」只走一套脱敏文案。
      // isDisposed 传闭包而不是布尔，因为读取过程跨多块，需要每块都重新检查。
      const data = await readPptxPreviewData({
        fileSize: fileStat.size,
        readRange: (offset, length) => fileService.readFileRange({ path, offset, length }),
        isDisposed: () => disposed,
      });
      if (disposed || !data) {
        return;
      }

      // 文件可能在分段读取期间被替换成另一个大小不同的版本；再次 stat 可以阻止把旧版本的
      // 前缀当作完整 PPTX 解析。相同大小的内容替换仍需 Host 提供 fingerprint 才能检测，暂不扩展现有协议。
      // 第二次 stat 是「读完再确认」的闭环（INV-8）：
      // 读取期间文件可能被另一个进程替换，此时 data 的长度或文件大小会不一致，
      // assertPptxPreviewDataComplete 会抛 incomplete 错误而不是让解析器崩在半个 zip 上。
      const currentFileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }
      assertPptxPreviewDataComplete({
        expectedBytes: fileStat.size,
        actualBytes: data.byteLength,
        observedFileSize: currentFileStat.size,
      });

      // 只有完整性断言通过才提交数据：先 set 再 assert 会让残缺 ArrayBuffer
      // 短暂进入渲染，PPTX 解析器可能同步抛错并打穿错误边界。
      setPptxPreviewData(data);
    })()
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        // 「读到的字节数少于 stat」= 文件在读取期间被改写（编辑器保存、构建产物覆盖）。
        // 这种情况绝不能把部分数据交给解析器：PPTX 是 zip，截断的前缀会抛出难以理解的
        // inflate 错误，用户只会看到「文件损坏」，而实际上重试一次就能读到完整版本。
        if (isPptxPreviewIncompleteFileError(previewError)) {
          logger.warn("[PreviewPane] PPTX 文件读取不完整，已阻止解析残缺数据", {
            path,
            expectedBytes: previewError.expectedBytes,
            actualBytes: previewError.actualBytes,
            observedFileSize: previewError.observedFileSize,
          });
        } else {
          logger.error(`[PreviewPane] 读取 PPTX 预览失败 path=${path}:`, previewError);
        }
        // 旧 Host 的 8MB base64 通道会把绝对路径拼进英文超限错误；原样展示既误导
        // 用户又泄漏远端目录。这里保留真实的 8MB 兼容边界，并对其它错误只展示文件名。
        setError(
          resolvePptxPreviewReadErrorMessage(previewError, {
            sourcePath: path,
            fileMissingMessage: intl.formatMessage({ id: "codeViewer.fileMissing" }),
            legacyFileTooLargeMessage: intl.formatMessage({
              id: "codeViewer.pptx.legacyFileTooLarge",
            }),
            incompleteFileMessage: intl.formatMessage({ id: "codeViewer.pptx.incomplete" }),
          }),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingPptxPreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, intl, pptxFileWatchReady, pptxReloadGeneration, pptxSourcePath]);

  // 滚动回调只做记录，不做节流：它仅在重内容卸载前的那一次布局 effect 里被调用，
  // 不是高频事件。加节流反而会让最后一次滚动位置丢失，恢复时回退一屏。
  const handlePreviewContentScroll = useCallback(() => {
    rememberScrollMetrics();
  }, [rememberScrollMetrics]);

  useLayoutEffect(() => {
    // 这个 effect 只负责「重内容即将卸载前保存位置」：renderHeavyContent=false 时
    // 内容区切到骨架屏，此时读到的 scrollTop 才是用户真实的阅读位置。
    // 顺序上它必须排在「恢复」effect 之前，否则同一帧内先恢复后保存，位置被覆盖。
    if (!renderHeavyContent) {
      return;
    }

    // 只在 false→true 的边沿恢复：若每次 renderHeavyContent 变化都恢复，
    // 用户在重内容里的滚动会被一次无关的父级重渲染拉回（INV-12）。
    // 注意这里只做「是否刚挂载」的判定，真正的赋值在下面的 RAF 里，避免读到未布局的 scrollHeight。
    if (!previousRenderHeavyContentRef.current) {
      return;
    }

    rememberScrollMetrics();
  }, [filePreview, rememberScrollMetrics, renderHeavyContent, source]);

  useLayoutEffect(() => {
    // 先读旧值再写入新值：这个顺序一旦颠倒，边沿判断永远为假（自己和自己比较），
    // 表现为「面板收起再展开后回到顶部」。wasRenderingHeavyContent 同时用于决定
    // 是否要清空保存的指标——离开重内容时保留，回来时才消费一次。
    const wasRenderingHeavyContent = previousRenderHeavyContentRef.current;
    previousRenderHeavyContentRef.current = renderHeavyContent;

    if (!renderHeavyContent) {
      return;
    }

    // 已经是重内容时不重复恢复：这条分支挡住的是「父级因无关状态重渲染」，
    // 若继续恢复，用户正在滚动的位置会被静默改回上次记录点（INV-12）。
    if (wasRenderingHeavyContent) {
      return;
    }

    // 恢复的目标容器是 CodeViewer 内部的滚动视口，而不是外层 div：
    // 记错容器会让 scrollTop 写入无效（外层不滚动），表现为「恢复静默失效」。
    const container = scrollContainerRef.current;
    const preservedScrollTop = preservedScrollMetricsRef.current.scrollTop;
    if (!container || preservedScrollTop <= 0) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      // 用 min 而不是直接赋值：内容可能在收起期间变短（换行开关改变行数），
      // 超出 maxScroll 的值会被浏览器静默夹紧并触发一次滚动事件，导致遮罩抖动。
      container.scrollTop = Math.min(
        preservedScrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight),
      );
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [renderHeavyContent, source]);

  if (!source) {
    return null;
  }

  // 打开动作只在「有路径 + 选中了编辑器」时发起：selectedEditor 可能是远程过滤后的
  // fallback（不是用户偏好），因此每次调用都重新传 remoteTarget/workspaceIdentity，
  // 由 platform 侧决定落到哪台 Host（INV-18）。
  const handleOpenInEditor = async () => {
    if (!source.path || !selectedEditor) {
      return;
    }

    try {
      // 远程能力过滤产生的 fallback 只用于本次打开；不能把它写回面板偏好，
      // 否则同一 PreviewPane 切回本地文件时仍会错误沿用远程 VS Code。
      const result = await platform.openInEditor(selectedEditor.id, source.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: source.workspaceIdentity,
      });
      if (result.success) {
        return;
      }

      logger.warn("[PreviewPane] 用编辑器打开文件失败", {
        editorId: selectedEditor.id,
        path: source.path,
        error: result.error ?? "unknown-error",
      });
    // 打开失败只 warn 不 toast：平台差异导致的失败很常见（未安装、远程不可用），
    // 而 openInEditor 自己会给出更具体的提示，这里再弹一层会形成双提示。
    } catch (platformError) {
      logger.warn("[PreviewPane] 打开文件失败", {
        path: source.path,
        error: platformError instanceof Error ? platformError.message : String(platformError),
      });
    }
  };

  // 差异预览的「打开」不是内部导航，而是把单文件来源交给上层打开完整的代码查看器：
  // 这样 diff 里的文件可以继续拥有自己的评论与滚动上下文，而不是嵌在 diff 行里。
  const handleOpenDiffFilePreview = () => {
    // 没有可打开的单文件来源时直接 return：按钮本身已 disabled，
    // 但键盘仍可能通过快捷键触发这个回调，这里必须再兜一层，避免把 undefined 传给宿主。
    if (!diffFilePreviewSource) {
      return;
    }

    onOpenCodeViewer?.(diffFilePreviewSource);
  };

  // 骨架屏占位高度取「上次记录的内容高度」：高度为 0（首次打开/从未渲染过内容）时
  // 不设高度，让骨架自然铺开。设 0px 会让面板塌陷，侧栏随之跳动。
  // 这里读 ref 而不进 state 是刻意的：它只影响一帧的占位，不需要触发重渲染。
  const deferredBodyStyle: CSSProperties | undefined =
    !renderHeavyContent && preservedScrollMetricsRef.current.scrollHeight > 0
      ? {
          height: `${preservedScrollMetricsRef.current.scrollHeight}px`,
        }
      : undefined;

  const header = (
    // header 是「值」而不是直接写进 aside 的 children：headerContainer 存在时要
    // 通过 portal 挂到宿主的头部槽位（INV-14）。写成内联 JSX 就无法在两种挂载方式间选择。
    // 注意：header 只能被求值/挂载一次，两个分支是互斥的（?: 而非 &&）。
    <div
      className={cn(
        "flex h-10 min-w-0 shrink-0 items-center gap-2",
        !headerContainer && "bg-surface/30",
        !headerContainer && showDocumentHeaderDivider && "border-b border-border",
      )}
    >
      <div
        ref={breadcrumbScrollRef}
        className={cn(
          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide",
          BREADCRUMB_MASK_CLASS_BY_STATE[breadcrumbMaskState],
        )}
      >
        <div
          ref={breadcrumbContentRef}
          className="flex min-w-max items-center px-3 gap-0.5 text-ui-base text-foreground-subtle"
        >
          {breadcrumb?.rootLabel ? (
            <span className="shrink-0 text-foreground-subtle">{breadcrumb.rootLabel}</span>
          ) : null}
          {breadcrumb?.rootLabel ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          ) : null}
          {breadcrumb?.parentSegments.map((segment, index) => (
            // key 拼 index 而不是只用 segment：同一路径里可能出现同名目录
            // （如 src/a/src），只用 segment 会让 React 复用错节点并吞掉一段。
            <Fragment key={`${segment}-${index}`}>
              <span className="shrink-0">{segment}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
            </Fragment>
          ))}

          <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
            {breadcrumb?.fileIconSrc ? (
              <FileDisplayIcon src={breadcrumb.fileIconSrc} size={14} className="shrink-0" />
            ) : null}
            <span className="truncate">{breadcrumb?.fileLabel ?? source.title}</span>
          </span>
        </div>
      </div>

      <div className="flex shrink-0 pr-1.5 items-center gap-2">
        {canOpenDiffFilePreview ? (
          <Button
            type="button"
            size="default"
            variant="ghost"
            className="shrink-0 rounded-lg text-foreground-subtle hover:text-foreground"
            data-diff-source-preview-trigger
            onClick={handleOpenDiffFilePreview}
            title={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
            aria-label={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
          >
            <FileCode2Icon className="size-3.5" data-icon="inline-start" />
            <span>
              {intl.formatMessage({
                id: "codeViewer.openSourcePreview",
              })}
            </span>
          </Button>
        ) : null}
        {/* Bugfix: 图片和 patch 这类预览没有任何显示选项，继续渲染触发器会打开空菜单，所以只在存在菜单项时显示更多按钮。 */}
        {hasMoreMenu || source.path ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canToggleMarkdownView ? (
                <>
                  <DropdownMenuLabel>
                    {intl.formatMessage({ id: "codeViewer.markdownMode" })}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={markdownViewMode}
                    onValueChange={(value) => {
                      setMarkdownViewMode(value as "preview" | "code");
                    }}
                  >
                    <DropdownMenuRadioItem value="preview">
                      <EyeIcon className="size-4" />
                      {intl.formatMessage({
                        id: "codeViewer.markdownPreview",
                      })}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="code">
                      <FileCode2Icon className="size-4" />
                      {intl.formatMessage({
                        id: "codeViewer.markdownSource",
                      })}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {canToggleSvgView ? (
                <>
                  {canToggleMarkdownView ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>
                    {intl.formatMessage({ id: "codeViewer.svgMode" })}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={svgViewMode}
                    onValueChange={(value) => {
                      setSvgViewMode(value as "preview" | "code");
                    }}
                  >
                    <DropdownMenuRadioItem value="preview">
                      <EyeIcon className="size-4" />
                      {intl.formatMessage({ id: "codeViewer.svgPreview" })}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="code">
                      <FileCode2Icon className="size-4" />
                      {intl.formatMessage({ id: "codeViewer.svgSource" })}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {canToggleCodeWrap ? (
                <>
                  {canToggleMarkdownView || canToggleSvgView ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuCheckboxItem
                    checked={wrapLongLines}
                    onCheckedChange={(checked) => {
                      setWrapLongLinesOverride(Boolean(checked));
                    }}
                  >
                    <FileCode2Icon className="size-4" />
                    {intl.formatMessage({ id: "codeViewer.wrapLines" })}
                  </DropdownMenuCheckboxItem>
                </>
              ) : null}
              {source.path ? (
                <>
                  {hasMoreMenu ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    onSelect={() => void fileActions.copyAbsolutePath({ path: source.path! })}
                  >
                    <CopyIcon className="size-4" />
                    {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void fileActions.copyRelativePath({
                        path: source.path!,
                        relativePath: sourceWorkspacePath
                          ? getWorkspaceFileRelativePath(sourceWorkspacePath, source.path!)
                          : source.path!,
                      })
                    }
                  >
                    <CopyIcon className="size-4" />
                    {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* 第一期 PPTX 明确为只读预览，不展示任何编辑入口。 */}
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          className="shrink-0 text-foreground-subtle hover:text-foreground disabled:text-foreground-subtlest"
          onClick={() => {
            // 打开动作是 fire-and-forget：失败信息由 platform 层 toast 呈现，
            // 这里不捕获也不改本地状态——预览面板不应因为「打开编辑器失败」而显示红条，
            // 那会让用户误以为预览本身出错了。
            void handleOpenInEditor();
          }}
          disabled={!canOpenInEditor}
          title={
            selectedEditor
              ? intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: selectedEditor.name },
                )
              : intl.formatMessage({ id: "chat.changeSummary.openInEditor" })
          }
          aria-label={
            selectedEditor
              ? intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: selectedEditor.name },
                )
              : intl.formatMessage({ id: "chat.changeSummary.openInEditor" })
          }
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <aside
      data-testid={TID_PREVIEW_PANE}
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      {headerContainer ? createPortal(header, headerContainer) : header}
      <div className="min-h-0 flex-1">
        {renderHeavyContent ? (
          // source 的合成顺序就是渲染优先级：pptx → image → pdf → media → 原始 source。
          // 与上面的派生源顺序不完全相同（media 在 pdf 之后），因为 PPTX/PDF 有专用大组件，
          // 一旦命中就不该再让媒体播放器参与（同一文件不会同时是两者）。
          <PreviewPaneContent
            source={pptxSource ?? imageSource ?? pdfSource ?? mediaSource ?? source}
            filePreview={filePreview}
            fileTooLarge={fileTooLarge}
            loadingInitial={loadingInitial}
            loadingImagePreview={loadingImagePreview}
            imagePreview={imagePreview}
            imageFileReference={imageFileReference}
            loadImageDownloadSource={sourceFilePath ? loadImageDownloadSource : undefined}
            mediaSource={mediaSource}
            loadingMediaPreview={loadingMediaPreview}
            mediaPreviewUrl={mediaPreviewUrl}
            onMediaError={handleMediaError}
            onMediaLoadedMetadata={handleMediaLoadedMetadata}
            loadingPdfPreview={loadingPdfPreview}
            pdfViewerSource={pdfViewerSource}
            pdfViewerLabels={pdfViewerLabels}
            loadingOfficePreview={loadingOfficePreview}
            officePreview={officePreview}
            officePreviewKind={officePreviewKind}
            loadingPptxPreview={loadingPptxPreview}
            pptxPreviewData={pptxPreviewData}
            pptxViewerLabels={pptxViewerLabels}
            pptxReferenceSource={
              pptxSource && sourceWorkspacePath
                ? {
                    workspacePath: sourceWorkspacePath,
                    ...(pptxSource.workspaceIdentity
                      ? { workspaceIdentity: pptxSource.workspaceIdentity }
                      : {}),
                    ...(pptxSource.workspaceRemoteSessionId
                      ? { remoteSessionId: pptxSource.workspaceRemoteSessionId }
                      : {}),
                    sourcePath: pptxSource.path,
                    sourceTitle: pptxSource.title,
                  }
                : null
            }
            pptxReferenceNavigation={pptxReferenceNavigation}
            pptxReferenceNavigationReady={
              pptxReferenceNavigation !== null &&
              validatedPptxReferenceNavigationRequestId === pptxReferenceNavigation.requestId
            }
            error={error}
            codePreviewSettings={codePreviewSettings}
            codeTheme={codeTheme}
            resolvedTheme={resolvedTheme}
            theme={theme}
            workspacePath={sourceWorkspacePath}
            onOpenBrowserUrl={onOpenBrowserUrl}
            markdownSelectionTarget={
              markdownSelectionTarget &&
              (source.workspaceIdentity?.trim() || sourceWorkspacePath) ===
                markdownSelectionTarget.workspaceKey
                ? markdownSelectionTarget
                : undefined
            }
            markdownViewMode={markdownViewMode}
            svgViewMode={svgViewMode}
            wrapLongLines={wrapLongLines}
            codeComments={codeComments}
            enableCodeLineSelection={canCreateCodeComment}
            enableCodeGutterUtility={canCreateCodeComment}
            codeCommentLabels={codeCommentLabels}
            onSubmitCodeComment={handleSubmitCodeComment}
            onDeleteCodeComment={handleDeleteCodeComment}
            // PreviewPane 外层只是 flex 壳，真实滚动发生在具体内容组件的 overflow 容器。
            // 折叠侧边面板卸载重内容前必须保存该容器的位置。
            onScroll={handlePreviewContentScroll}
            scrollContainerRef={scrollContainerRef}
          />
        ) : (
          // 骨架屏与真内容共用同一个父容器（min-h-0 flex-1），因此切换时不会出现
          // 高度从 0 长到内容高度的动画；deferredBodyStyle 进一步把高度锁在旧值上。
          <PreviewPaneDeferredHeavyContent style={deferredBodyStyle} />
        )}
      </div>
    </aside>
  );
}
