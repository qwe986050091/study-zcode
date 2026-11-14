// INV-01 位置：ToolCallBody 是工具 body 的唯一装配点，子块顺序固定为 preview、plan、input、output、kind。改错顺序会让用户先看到输出后看到计划。
// INV-02 位置：inlinePreview 取 inlinePreviewOverride ?? displayModel.inlinePreview。写反优先级会吞掉调用方的定制预览。
// INV-03 位置：childToolList 非空即短路整个 body。漏掉短路会让父子重复渲染同一批工具。
// INV-04 位置：text 预览只认 type 等于 text。用 truthy 判断会把 image 也喂给 CodeBlock。
// INV-05 位置：image 预览独立成 InlineImageContent。把它内联回装配层会让异步读取逻辑污染展示结构。
// INV-06 位置：planResult 分支在 input/output 之前。后移会被长输出挤出可视区。
// INV-07 位置：showInput 与 input 非 undefined 是双条件。去掉后者会出现空白输入块。
// INV-08 位置：showOutput 只决定是否渲染，成败样式交给 ToolOutput。前置判断会丢掉错误文案。
// INV-09 位置：showKind 固定在最后作兜底。提前会让正常工具多出冗余类型标签。
// INV-10 位置：markdown 早返回 MessageResponse，其余语言落到 CodeBlock。合并两条路径会丢失链接分流。
// INV-11 位置：markdown 的 onOpenFileLink 优先于 onOpenExternalUrl。互换会让文件链接走浏览器打开。
// INV-12 位置：图片能力从 useToolPresentationCapabilities 取。直接拿服务会破坏注入边界。
// INV-13 位置：directSrc 命中时跳过异步读取。漏判会为同一张图重复发请求。
// INV-14 位置：结果必须同时匹配 path 与 reader 才可采用。只比 path 会闪现旧能力的图片。
// INV-15 位置：读取失败必须落 failed 终态。漏掉终态会永久 loading 并积压未处理拒绝。
// INV-16 位置：effect 依赖含 directSrc、readMediaPreview、preview.path，并用 cancelled 防卸载后写入。删依赖会读到过期能力。
// INV-17 位置：无 src 时按失败、不可用、加载中三态出文案。顺序错会把加载中写成失败。
// INV-18 位置：InlinePlanResult 的 planFilePath 可选，缺失时不渲染文件行。强渲染会留下空标签。
//
// 模块职责：把 displayModel 投影成工具调用 body，统一装配 inline 预览、plan、input、output、kind 五类子块
// 状态所有权：展示开关与 plan 内容归 displayModel，图片读取结果只在本组件内部缓存，不回写全局
// 阅读顺序：ToolCallBody 装配分支 → InlineCodeContent 两条渲染路径 → InlineImageContent 能力与副作用 → InlinePlanResult 可选文件行
import { useEffect, useState, type ReactNode } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  CodeViewerSource,
  ImageCodeViewerSource,
  TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel, ToolInlinePreview } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";

export function ToolCallBody({
  childToolList,
  displayModel,
  inlinePreviewOverride,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  childToolList: ReactNode;
  displayModel: ToolDisplayModel;
  inlinePreviewOverride?: ToolInlinePreview;
  toolCall: TaskChatToolCallTreeNode["toolCall"];
  workspacePath: string;
  /** 应用主题（store 耦合剥离）：透传给 markdown / 代码块渲染，缺省按 "system" 兜底。 */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：透传给 markdown 渲染，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  // 参数契约：body 只消费 displayModel 与 toolCall，不自行推导工具状态
  // inlinePreviewOverride 优先于 displayModel.inlinePreview，调用方需要覆盖预览时只改这一处
  // 若把优先级写反，子工具列表与搜索命中场景的定制预览会被 displayModel 吞掉
  // inlinePreview 是判别联合，下面按 type 逐个收窄，不要用断言绕开
  // props 里的回调全部可选，缺省即降级为不可点击，body 内不补默认实现
  // theme 与 codePreviewSettings 只做透传，本组件不读写 store，保持展示层无状态
  const inlinePreview = inlinePreviewOverride ?? displayModel.inlinePreview;

  return (
    <>
      {childToolList ?? (
        <>
          {inlinePreview.type === "text" ? (
            <InlineCodeContent
              preview={inlinePreview.source}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {inlinePreview.type === "image" ? (
            <InlineImageContent preview={inlinePreview.source} />
          ) : null}
          {displayModel.planResult ? (
            <InlinePlanResult
              plan={displayModel.planResult.plan}
              planFilePath={displayModel.planResult.planFilePath}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {displayModel.showInput && toolCall.input !== undefined ? (
            <ToolInput input={toolCall.input} />
          ) : null}
          {displayModel.showOutput ? (
            <ToolOutput errorText={toolCall.error} output={toolCall.output} />
          ) : null}
          {displayModel.showKind ? (
            <p className="text-ui-base text-muted-foreground">{toolCall.kind}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function InlineCodeContent({
  preview,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  preview: TextCodeViewerSource;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  // markdown 走 MessageResponse 并早返回，其余语言落到 CodeBlock，两条路径互斥
  // 早返回保证同一份 content 只被一个渲染器消费，不会产生双份 DOM
  // 把 markdown 也交给 CodeBlock 会丢失链接分流与段落排版
  if (preview.language === "markdown") {
    return (
      <div className="max-h-60 overflow-auto rounded-xl border border-border bg-muted/15 px-3 py-3">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          // 工具输出里的 markdown 文件链接之前只拿到 onOpenCodeViewer，
          // 点击会退化成 code viewer fallback；有 diff source 上下文时容易打开变更视图。
          // 这里优先交给 shell 的文件链接分流，文件看内容，目录走文件树 reveal。
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {preview.content}
        </MessageResponse>
      </div>
    );
  }

  return (
    <div className="max-h-60 overflow-auto rounded-xl bg-muted/15">
      <CodeBlock code={preview.content} language={preview.language} appTheme={theme} />
    </div>
  );
}

function InlineImageContent({ preview }: { preview: ImageCodeViewerSource }) {
  // 图片读取能力来自 presentationCapabilities，组件不直接取服务或 Repo
  // readMediaPreview 与 resourceUrl 都可能缺省，能力未注入时只能出不可用文案
  // 状态所有权在本组件：result 只缓存一次读取结果，不回写全局
  // result 额外保存 reader 引用，用于识别能力实例是否已被替换
  // directSrc 由 resourceUrl 同步解析，命中时无需异步读取
  // 能力对象变化会触发重读，所以不要把它固化到依赖之外的闭包里
  const { readMediaPreview, resourceUrl } = useToolPresentationCapabilities();
  const { intl } = useZCodeIntl();
  const directSrc = resourceUrl?.(preview.path);
  const [result, setResult] = useState<{
    path: string;
    reader: typeof readMediaPreview;
    src?: string;
    failed?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (directSrc || !readMediaPreview) return;
    // 图片读取失败曾留下永久 loading 和未处理 rejection；终态必须收口。
    // 异步 IIFE 统一 catch 所有 rejection，避免出现未处理的 Promise
    // 成功与失败都必须把 result 落到终态，任何提前返回都要先看 cancelled
    // 外层用 void 明确丢弃 promise，防止未捕获拒绝告警
    void (async () => {
      try {
        const media = await readMediaPreview(preview.path);
        if (!cancelled)
          setResult({ path: preview.path, reader: readMediaPreview, src: media?.dataBase64 });
      } catch (error) {
        if (cancelled) return;
        logger.warn("[ToolCallBody] 内嵌图片读取失败", {
          path: preview.path,
          error: String(error),
        });
        setResult({ path: preview.path, reader: readMediaPreview, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directSrc, readMediaPreview, preview.path]);

  // 在 effect 清理前也不能显示旧路径或旧能力的图片。
  const current =
    result?.path === preview.path && result.reader === readMediaPreview ? result : null;
  const src = directSrc ?? current?.src;
  if (!src) {
    return (
      <p>
        {intl.formatMessage({
          id: current?.failed
            ? "chat.toolCall.previewFailed"
            : !readMediaPreview || current
              ? "chat.toolCall.previewUnavailable"
              : "chat.toolCall.loading",
        })}
      </p>
    );
  }

  return <img src={src} alt={preview.title} />;
}

function InlinePlanResult({
  plan,
  planFilePath,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  plan: string;
  planFilePath?: string;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-3 rounded-xl border border-outline/60 bg-muted/15 p-3">
      {planFilePath ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-base text-on-surface-muted">
          <span>{intl.formatMessage({ id: "chat.toolCall.planFile" })}</span>
          <span className="cursor-default rounded-md bg-muted/70 px-2 py-1 font-mono text-on-surface">
            {planFilePath}
          </span>
        </div>
      ) : null}
      <MessageResponse
        className="size-full min-w-0 break-words whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        workspacePath={workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
      >
        {plan}
      </MessageResponse>
    </div>
  );
}
