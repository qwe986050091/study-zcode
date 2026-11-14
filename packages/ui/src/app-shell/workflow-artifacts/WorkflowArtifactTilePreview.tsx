// INV-01 形态唯一：守住位置 previewModeFor；改错故障：同一产物同时命中两种预览。
// INV-02 类别优先：守住位置 markdown 判定；改错故障：按 mime 误判，文档走纯文本路径。
// INV-03 上限拒绝：守住位置 字节阈值判断；改错故障：超大产物被整份读取。
// INV-04 图片阈值独立：守住位置 图片分支上限；改错故障：图片按文本上限被拒，预览空白。
// INV-05 最小 CSV：守住位置 行解析；改错故障：把完整 CSV 解析器引入预览路径，体积膨胀。
// INV-06 空行跳过：守住位置 行过滤；改错故障：缩略表格出现整行空白。
// INV-07 列行截断：守住位置 行列上限；改错故障：宽表撑破缩略框。
// INV-08 单元格截断：守住位置 超长文本处理；改错故障：单个长字段占满整行。
// INV-09 解码有界：守住位置 decodeHead；改错故障：整份文档解码，主线程卡顿。
// INV-10 静默等待：守住位置 Pending；改错故障：字节未到先闪骨架或字形，随后跳变。
// INV-11 渐隐语义：守住位置 Fade；改错故障：截断看起来像内容损坏。
// INV-12 预设独立：守住位置 preset 分支；改错故障：预设产物也走字节读取，白拉一遍。
// INV-13 spec 缺失留白：守住位置 空 spec 判断；改错故障：journal 未到时闪出无法渲染提示。
// INV-14 请求门控：守住位置 enabled 参数；改错故障：不可预览的产物仍发起字节请求。
// INV-15 字段门控：守住位置 数据请求启用条件；改错故障：spec 未到就请求看板数据。
// INV-16 回退字形：守住位置 错误与不可预览分支；改错故障：失败时留下空白框。
// INV-17 图片覆盖：守住位置 object-cover；改错故障：缩略图留白边或拉伸变形。
// INV-18 主题传入：守住位置 markdown 渲染；改错故障：代码块配色与实际主题不符。
//
// 模块职责：产物瓦片与侧板画廊共用的缩略预览。
// 状态所有权：无状态；字节、数据与主题均由 hook 或调用方提供。
// 阅读顺序：常量 → 形态判定 → CSV 读法 → 占位 → 主组件。
import { useMemo } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  artifactFileBadge,
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import { artifactPresetFieldPaths } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import {
  ArtifactSheetGlyph,
  type WorkflowCompletionArtifact,
} from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";

/**
 * 产物瓦片的预览区（侧板画廊同用）：产物**本身**的缩略。
 *
 * - markdown / 纯文本：文档开头按 2× 宽排版再 `scale(0.5)`——是内容的缩略，不是把界面字号调小；
 * - CSV：前几行的迷你表格；
 * - 图片：渲染本身；
 * - chart / table / metrics / board：`ArtifactPresetBody` compact，按自然尺寸在框里居中，随 report
 *   条目实时长；
 * - 其余（PDF / 二进制 / 超大文件）：纸页字形 + 扩展名徽字。
 *
 * 两处框同一档、同一画法：交付物行的框（160 × 100）与侧板画廊的瓦片框（130–180px 一列）。没有更小
 * 的档——预览要么读得清，要么不画。
 *
 * 字节还没到时整块留空白（不闪骨架屏，也不先画一张字形再换掉）。字节走与产物 tab 同一条
 * 分块读取（journal-backed，冷恢复也在）；上限之外不读——卡是转录的一部分，不该为一份 20 MiB
 * 的产物拉整条链路。
 */
const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const IMAGE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
/** 文档缩略只解码开头这么多字节：一屏缩略装不下更多，整份解码是白算。 */
const TEXT_DECODE_BYTES = 8 * 1024;
const TEXT_PREVIEW_CHARS = 1_600;
const CSV_PREVIEW_ROWS = 6;
const CSV_PREVIEW_COLUMNS = 5;
const CSV_CELL_MAX_CHARS = 28;

type PreviewMode = "markdown" | "csv" | "text" | "image";

// 按 kind 与 contentType 双通道判定预览形态。
// markdown 优先按 kind，其次按 mime。
// 超过文本上限时返回不可预览，不截断读取。
// 图片上限更高，但仍拒绝超大二进制。
//
export function previewModeFor(artifact: {
  kind: WorkflowCompletionArtifact["kind"];
  contentType?: string;
  bytes?: number;
}): PreviewMode | undefined {
  const contentType = artifact.contentType?.split(";")[0]?.trim() ?? "";
  const bytes = artifact.bytes;
  if (artifact.kind === "markdown" || contentType === "text/markdown") {
    return bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES ? undefined : "markdown";
  }
  if (contentType.startsWith("image/")) {
    return bytes !== undefined && bytes > IMAGE_PREVIEW_MAX_BYTES ? undefined : "image";
  }
  if (bytes !== undefined && bytes > TEXT_PREVIEW_MAX_BYTES) return undefined;
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain" || contentType === "application/json") return "text";
  return undefined;
}

/** 最小的 CSV 读法：只认逗号与成对引号，够画一张缩略；不是解析器。 */
// 最小 CSV 读法只认逗号与成对引号。
// 空行直接跳过，列数截断到 `CSV_PREVIEW_COLUMNS`。
// 单元格 trim 后超过 `CSV_CELL_MAX_CHARS` 就截断并补省略号。
// 达到 `CSV_PREVIEW_ROWS` 立即 break，不读完整份文本。
//
export function csvPreviewRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        cells.push(cell);
        cell = "";
      } else cell += char;
    }
    cells.push(cell);
    rows.push(
      cells.slice(0, CSV_PREVIEW_COLUMNS).map((value) => {
        const trimmed = value.trim();
        return trimmed.length > CSV_CELL_MAX_CHARS
          ? `${trimmed.slice(0, CSV_CELL_MAX_CHARS)}…`
          : trimmed;
      }),
    );
    if (rows.length >= CSV_PREVIEW_ROWS) break;
  }
  return rows;
}

// 只解码开头固定字节数，避免整份文档解码。
// 统一走 TextDecoder，天然处理 UTF-8。
//
function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder()
    .decode(bytes.subarray(0, TEXT_DECODE_BYTES))
    .slice(0, TEXT_PREVIEW_CHARS);
}

/** 空白占位：字节在路上。测试与调用方据它区分「还没到」与「画不了」。 */
// 空白占位用于字节尚未到达的中间态。
// 测试据此区分未到与不可渲染。
//
function Pending() {
  return <span className="absolute inset-0" data-testid="workflow-artifact-preview-pending" />;
}

/** 文档缩略底部渐隐到面板色：截断的文档看起来是「还有」，不是「断了」。看板与图片不要它。 */
// 底部渐隐让截断看起来是还有更多。
// 只用于文档与表格，看板与图片不加。
//
function Fade() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[28%]"
      style={{ background: "linear-gradient(to bottom, transparent, var(--color-panel))" }}
    />
  );
}

// 预设类产物走 spec 数据，不走字节预览。
// 字节请求只在有预览形态时启用。
// 文本解码与 CSV 行解析都经 memo 缓存。
// 错误态与不支持预览的形态统一回退纸页字形，不复用空 div。
//
export function WorkflowArtifactTilePreview({
  artifact,
  runId,
  sessionId,
  theme,
}: {
  artifact: WorkflowCompletionArtifact;
  sessionId: string;
  runId: string;
  theme: Theme;
}) {
  const { intl } = useZCodeIntl();
  const preset = isArtifactPresetKind(artifact.kind);
  const mode = preset ? undefined : previewModeFor(artifact);
  const bytesState = useWorkflowRunArtifactBytes({
    sessionId,
    runId,
    artifactId: artifact.id,
    version: artifact.version ?? 1,
    enabled: mode !== undefined,
  });
  // 看板只让 CLI 取 spec 点名的字段；spec 还没到或画不了时不取数——预览此时本来也画不出图。
  // 看板字段由 spec 点名的路径决定。
  // spec 未到或不可画时不发起数据请求。
  //
  const fields = useMemo(
    () =>
      isArtifactPresetKind(artifact.kind)
        ? artifactPresetFieldPaths(artifact.kind, artifact.spec)
        : undefined,
    [artifact.kind, artifact.spec],
  );
  const dataState = useWorkflowRunArtifactData({
    sessionId,
    runId,
    artifactId: artifact.id,
    ...(artifact.itemCount === undefined ? {} : { itemCount: artifact.itemCount }),
    enabled: fields !== undefined,
    ...(fields === undefined ? {} : { fields }),
  });
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const text = useMemo(
    () =>
      bytesState.bytes !== null && (mode === "markdown" || mode === "csv" || mode === "text")
        ? decodeHead(bytesState.bytes)
        : undefined,
    [bytesState.bytes, mode],
  );
  const rows = useMemo(
    () => (mode === "csv" && text !== undefined ? csvPreviewRows(text) : []),
    [mode, text],
  );

  const badge = artifact.kind === "file" ? artifactFileBadge(artifact) : undefined;
  const glyph = <ArtifactSheetGlyph {...(badge === undefined ? {} : { badge })} />;

  if (preset) {
    // spec 只有 journal 带得回来；还没到时安静留白，不闪一句「无法渲染」。到了但坏了才说。
    if (artifact.spec === undefined) return <Pending />;
    return (
      <div
        className="absolute inset-0 flex flex-col overflow-hidden p-2.5 [justify-content:safe_center]"
        data-preview-mode="preset"
        data-testid="workflow-artifact-preview-body"
      >
        <ArtifactPresetBody
          artifact={{ kind: artifact.kind, spec: artifact.spec }}
          compact
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          items={dataState.items}
          labels={labels}
        />
      </div>
    );
  }

  if (mode === undefined) return glyph;
  if (bytesState.loading || (bytesState.bytes === null && bytesState.error === null)) {
    return <Pending />;
  }
  if (bytesState.error !== null) return glyph;

  if (mode === "image") {
    return bytesState.objectUrl === null ? (
      glyph
    ) : (
      <img
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        data-preview-mode="image"
        data-testid="workflow-artifact-preview-body"
        src={bytesState.objectUrl}
      />
    );
  }

  if (mode === "csv") {
    return (
      <>
        <div
          className="wf-preview-doc"
          data-preview-mode="csv"
          data-testid="workflow-artifact-preview-body"
        >
          <table className="w-full border-collapse font-mono text-ui-caption tabular-nums">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      className={cn(
                        "whitespace-nowrap border-b py-1.5 pr-3 text-foreground",
                        rowIndex === 0
                          ? "border-border font-sans text-ui-sm font-medium uppercase tracking-wide text-foreground-subtlest"
                          : "border-[var(--color-workflow-rule)]",
                      )}
                      key={cellIndex}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Fade />
      </>
    );
  }

  return (
    <>
      <div
        className="wf-preview-doc"
        data-preview-mode={mode}
        data-testid="workflow-artifact-preview-body"
      >
        {mode === "markdown" ? (
          // markdown 必须**传 theme**（渲染器按 theme 选代码块配色）。
          <MessageResponse className="w-full min-w-0 break-words text-foreground" theme={theme}>
            {text ?? ""}
          </MessageResponse>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-ui-caption text-foreground">
            {text ?? ""}
          </pre>
        )}
      </div>
      <Fade />
    </>
  );
}
