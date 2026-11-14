// INV-01 预置看板不读字节：守住位置 种类判断；改错故障 看板等待字节加载。
// INV-02 元数据未读完不报缺失：守住位置 展开条件；改错故障 每次打开先闪错误。
// INV-03 字节错误优先展示：守住位置 空值判断；改错故障 错误被加载态覆盖。
// INV-04 无字节即加载态：守住位置 空值分支；改错故障 查看器用空数据渲染。
// INV-05 内容分派单独组件：守住位置 钩子拆分；改错故障 条件渲染改变钩子数量。
// INV-06 文本按类型解码：守住位置 三态判断；改错故障 二进制被当文本。
// INV-07 markdown 传主题：守住位置 属性；改错故障 深色底出现深色字。
// INV-08 pdf 用 Blob 数据源：守住位置 回退构造；改错故障 空 Blob 渲染失败。
// INV-09 图片缺地址给错误提示：守住位置 空值分支；改错故障 出现破图。
// INV-10 pptx 复制独立缓冲：守住位置 切片；改错故障 带偏移的视图渲染错位。
// INV-11 office 仅两种类型编码：守住位置 类型判断；改错故障 大文件白算 base64。
// INV-12 html 走浏览器卡片：守住位置 类型分支；改错故障 进程内执行脚本。
// INV-13 旧版 html 不给预览：守住位置 版本标志；改错故障 预览与文件内容不符。
// INV-14 表外类型给元数据卡：守住位置 末尾回退；改错故障 未知类型白屏。
// INV-15 懒加载重量级查看器：守住位置 动态导入；改错故障 首屏包体膨胀。
// INV-16 内容类型有缺省值：守住位置 空值合并；改错故障 空类型无法分派。
// INV-17 解码按字节与类型记忆：守住位置 依赖数组；改错故障 切版本后显示旧文本。
// INV-18 在浏览器打开可选注入：守住位置 可选属性；改错故障 无宿主时按钮无响应。
//
// 模块职责：工作流产物标签页的正文分派与懒加载查看器装配。
// 状态所有权：产物内容由上层查询，本组件只按类型选择渲染器。
// 阅读顺序：先看文本语言判定，再看正文分派，最后看内容分派。
import { lazy, Suspense, useMemo } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import {
  ArtifactMetadataCard,
  ArtifactNotice,
  WorkflowArtifactHtmlCard,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactCards.js";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import type { Theme } from "@/useTheme.js";

/**
 * `workflow-artifact` tab 的正文。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出。
 *
 * **零新渲染依赖**：pdf / 图片 / markdown / office / 文本全部走既有的叶子查看器，预置看板走
 * 4b 的四个渲染器。分派的判据是 journal 记录上的 `contentType`——它由 driver 按扩展名表算出、
 * 可被 `opts.contentType` 覆盖，是这条链路唯一的类型真相（store 读回来时会自己重新嗅一次，
 * 那个值刻意不用）。
 *
 * **刻意不做 iframe**：renderer 没有 CSP，`allow-scripts allow-same-origin` 的 sandbox 组合
 * 等价于逃逸。html 因此走既有的浏览器 tab（见 `WorkflowArtifactHtmlCard`）。
 */

// 三个重量级查看器都懒加载：pdf.js / docx-preview / xlsx wasm 各自都是几百 KB，
// 而绝大多数会话从不打开产物 tab。既有的 previewPane* 包装本身已经带 Suspense。
const PdfPreviewContent = lazy(() =>
  import("@/previewPanePdfContent.js").then((module) => ({ default: module.PdfPreviewContent })),
);
const PptxPreviewContent = lazy(() =>
  import("@/previewPanePptxContent.js").then((module) => ({ default: module.PptxPreviewContent })),
);
const PreviewPaneOfficeContent = lazy(() =>
  import("@/previewPaneOfficeContent.js").then((module) => ({
    default: module.PreviewPaneOfficeContent,
  })),
);

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 文本类：正文用等宽 code viewer 呈现。`text/markdown` 不在其中——它走 MessageResponse。 */
// application/json 与 text/csv 映射到 json 和 csv。
// 其余 text/* 统一按 text 纯文本渲染。
// 未知 content type 返回 undefined，不参与高亮。
// markdown 不在此列。
// 返回的语言只交给 code viewer 决定高亮。
function textLanguageFor(contentType: string): string | undefined {
  if (contentType === "application/json") return "json";
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain") return "text";
  if (contentType.startsWith("text/")) return "text";
  return undefined;
}

interface WorkflowArtifactBodyProps {
  artifact: WorkflowRunArtifactView;
  /** 正在查看的版本；内容产物的字节按它读。 */
  version: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  objectUrl: string | null;
  /** 字节读取的状态：loading 与 error 都由本组件呈现（各查看器自己的 loading 只覆盖解析）。 */
  loading: boolean;
  error: string | null;
  /** 预置看板的条目流；内容产物恒空。 */
  items: readonly ArtifactItem[];
  theme: Theme;
  resolvedTheme: "light" | "dark";
  /** html 的「在浏览器中打开」；缺席即只显示提示。 */
  onOpenBrowserUrl?: (url: string) => void;
  /** 本地文件系统上的绝对路径（desktop-local ∧ `sourcePath` 在场时才有）。 */
  localSourcePath?: string;
  /** 「在工作区显示」：已绑定好路径的文件树 reveal；缺席即无渲染器的卡片上不出这个按钮。 */
  onReveal?: () => void;
  /** 查看的是不是最新版——旧版的工作区原文件早就被覆盖了，html 预览因此只对最新版开放。 */
  isLatestVersion: boolean;
  /** 元数据（含预置看板的 spec）还在读；预置正文据此区分「还没到」与「真的没有」。 */
  metadataLoading: boolean;
}

// isArtifactPresetKind() 为真时先分派预置看板。
// metadataLoading 为真时不传 missingLabel。
// props.error 非空时先返回 ArtifactNotice。
// props.loading 或 bytes === null 时统一走加载态。
// 就绪后把 props 与 bytes 交给 WorkflowArtifactContent。
// WorkflowArtifactBody 本身不持有状态。
export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {
  const { intl } = useZCodeIntl();
  const { artifact } = props;

  // 预置看板不读字节，直接画。
  if (isArtifactPresetKind(artifact.kind)) {
    const labels = buildPresetLabels((descriptor, values) =>
      intl.formatMessage(descriptor, values),
    );
    return (
      <div className="h-full min-h-0 overflow-auto p-4" data-artifact-body="preset">
        <ArtifactPresetBody
          artifact={artifact}
          items={props.items}
          labels={labels}
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          // spec 只有 journal 查询带得回来，所以**元数据读完之前**不能说「读不到」——
          // 否则每个看板打开时都先闪一次错误文案。
          {...(props.metadataLoading
            ? {}
            : {
                missingLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.run.artifacts.unavailable",
                }),
              })}
        />
      </div>
    );
  }

  if (props.error !== null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-error"
        tone="error"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
        detail={props.error}
      />
    );
  }
  if (props.loading || props.bytes === null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-loading"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loading" })}
      />
    );
  }

  return <WorkflowArtifactContent {...props} bytes={props.bytes} />;
}

/**
 * 字节已就绪之后的分派。拆成第二个组件的理由是 hooks：markdown 的解码、office 的 base64
 * 回程都得用 `useMemo`，而它们在「还没读到字节」的那一帧不能被跳过（hooks 数量必须恒定）。
 */
// 文本三态共用一次解码。
// office 只在两种类型编码。
// pptx 切片得到独立缓冲。
// 分派只按 artifact.kind 的内容类型。
// 每个 render 分支各自带 div 容器，避免重复布局。
// 末尾回退到 ArtifactMetadataCard 默认分支。
function WorkflowArtifactContent({
  artifact,
  bytes,
  blob,
  objectUrl,
  theme,
  resolvedTheme,
  onOpenBrowserUrl,
  onReveal,
  localSourcePath,
  isLatestVersion,
}: WorkflowArtifactBodyProps & { bytes: Uint8Array<ArrayBuffer> }) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const contentType = artifact.contentType ?? "application/octet-stream";

  // 文本三态（markdown / 代码 / html 源）共用一次解码。TextDecoder 在 renderer 里恒在。
  const text = useMemo(() => {
    if (
      contentType !== "text/markdown" &&
      contentType !== "text/html" &&
      textLanguageFor(contentType) === undefined
    ) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }, [bytes, contentType]);

  // office 查看器只吃 `FileBinaryPreview.dataBase64`，所以这里走一次回程编码。
  // 只在真的是 office 文件时才算——20 MiB 的 base64 不该为一份 pdf 白算一遍。
  // 非 office 直接返回空。
  // 路径优先取源文件。
  // 字节转成 base64。
  // 总长度取字节长度。
  // 按标识与类型记忆。
  const officePreview = useMemo<FileBinaryPreview | null>(() => {
    if (contentType !== DOCX_CONTENT_TYPE && contentType !== XLSX_CONTENT_TYPE) return null;
    return {
      path: artifact.sourcePath ?? artifact.id,
      dataBase64: encodeBytesToBase64(bytes),
      totalBytes: bytes.length,
    };
  }, [artifact.id, artifact.sourcePath, bytes, contentType]);

  // pptx 查看器吃 ArrayBuffer。`slice` 出一份独立缓冲：Uint8Array 的 buffer 可能带偏移。
  const pptxBuffer = useMemo(
    () =>
      contentType === PPTX_CONTENT_TYPE
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null,
    [bytes, contentType],
  );

  if (contentType === "text/markdown") {
    return (
      // markdown 必须**传 theme**：portfolio 修过一次深底深字（渲染器按 theme 选代码块配色）。
      <div className="h-full min-h-0 overflow-y-auto px-4 py-4" data-artifact-body="markdown">
        <MessageResponse
          className="mx-auto w-full min-w-0 max-w-4xl break-words text-foreground"
          theme={theme}
        >
          {text ?? ""}
        </MessageResponse>
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <div className="h-full min-h-0" data-artifact-body="pdf">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          {/* PdfViewerSource 接受 Blob——不必落地成文件也不必走 range transport。 */}
          <PdfPreviewContent labels={pdfLabels} source={blob ?? new Blob([bytes])} />
        </Suspense>
      </div>
    );
  }

  if (contentType.startsWith("image/")) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background-alt p-4"
        data-artifact-body="image"
      >
        {objectUrl === null ? (
          <ArtifactNotice
            text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
            tone="error"
          />
        ) : (
          <img
            alt={artifact.title ?? artifact.id}
            className="max-h-full max-w-full object-contain"
            data-testid="workflow-artifact-image"
            src={objectUrl}
          />
        )}
      </div>
    );
  }

  if (contentType === PPTX_CONTENT_TYPE && pptxBuffer !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="pptx">
        <Suspense fallback={<ArtifactNotice text={pptxLabels.loading} />}>
          <PptxPreviewContent
            data={pptxBuffer}
            fileName={artifact.sourcePath ?? artifact.id}
            labels={pptxLabels}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (officePreview !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="office">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          <PreviewPaneOfficeContent
            error={null}
            kind={contentType === XLSX_CONTENT_TYPE ? "excel" : "docx"}
            loading={false}
            preview={officePreview}
            resolvedTheme={resolvedTheme}
            sourcePath={artifact.sourcePath ?? artifact.id}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (contentType === "text/html") {
    return (
      <WorkflowArtifactHtmlCard
        artifact={artifact}
        bytes={bytes.length}
        isLatestVersion={isLatestVersion}
        {...(localSourcePath === undefined ? {} : { localSourcePath })}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onReveal === undefined ? {} : { onReveal })}
      />
    );
  }

  const language = textLanguageFor(contentType);
  if (language !== undefined && text !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-auto" data-artifact-body="text">
        <CodeBlock appTheme={theme} code={text} language={language} showLineNumbers />
      </div>
    );
  }

  // 表外类型（`application/octet-stream` 与一切没人认得的东西）：给一张**元数据卡**，
  // 不假装能渲染。卡上带「在工作区显示」；交给别的 App 打开走 tab 头部的「作为文件打开」。
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes.length}
      note={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.unsupported" })}
      testId="workflow-artifact-unsupported"
      {...(onReveal === undefined
        ? {}
        : {
            action: {
              label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
              onActivate: onReveal,
              testId: "workflow-artifact-unsupported-reveal",
            },
          })}
    />
  );
}
