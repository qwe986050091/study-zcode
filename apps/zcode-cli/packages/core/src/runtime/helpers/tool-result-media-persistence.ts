/**
 * ============================================================================
 * runtime/helpers/tool-result-media-persistence.ts —— 工具结果里的媒体块落 artifact
 * ============================================================================
 *
 * 【定位】工具结果（MCP/Read 等）可能带 data: URL 形态的图片/视频/文件。直接塞进会话消息
 *   会让 durable transcript 体积失控，也无法做冷恢复。本文件把这些媒体写成 artifact，
 *   消息里只留 artifact URI + 供模型使用的"文本/附件"布局。
 *
 * 【不变量】只有全部内容块都能归为"文本"或"data: 媒体"时才返回投影；混入不可持久化的块
 *   整体返回 undefined（不部分持久化），避免消息里出现一半 data: 一半 artifact 的混合态。
 *   已带 zcode-artifact:// 的块直接复用 URI，不重复写 artifact。
 *
 * 【失败语义】有媒体但缺 artifactStore 时抛错（不能静静丢掉媒体）；缺 sessionStore 时
 *   返回 undefined（调用方保留原始内容）。
 * ============================================================================
 */
import type { FilePart } from "@zcode/contracts";
import { createPartId } from "../deps.js";
import type {
  MessageId,
  ModelMessageContent,
  ModelMessageContentBlock,
  SessionId,
  SessionStorePort,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
} from "../deps.js";

/**
 * 可被持久化的媒体块：image / video，或带 dataUrl 的 file。
 *
 * 类型收窄的意义：只有这些块在投影阶段能确定拿到了 data: 内容并可以写 artifact；
 *   其它块（text、纯 uri 引用等）不参与媒体落盘。
 */
type DataBackedToolMediaBlock =
  | Extract<ModelMessageContentBlock, { type: "image" | "video" }>
  | (Extract<ModelMessageContentBlock, { type: "file" }> & { dataUrl: string });

/**
 * 持久化后模型内容的布局项：按原顺序记录"这段是文本"或"这段是第 N 个附件"。
 *
 * 用途：回放时按该布局重建模型可见内容，保证文本与媒体的相对顺序不变；
 *   attachmentIndex 指向 attachments 数组下标，不做内容拷贝。
 */
type PersistedToolMediaLayoutEntry =
  | { type: "attachment"; attachmentIndex: number }
  | { type: "text"; text: string };

/**
 * 把工具结果中的 data: 媒体块写入 artifact store，产出消息级附件与模型内容布局。
 *
 * 输入：artifactStore / sessionStore、assistantMessageId、工具结果 content、
 *   sessionId、toolCallId、toolName、traceContext、turnId。
 * 输出：{ attachments, modelContentLayout } 或 undefined（不该/无法持久化时）。
 *   undefined 的两种情形：没有 sessionStore（无落库能力）或 content 里没有可持久化媒体。
 * 写入口径：每个媒体块一个 artifact，toolCallId 用 `${toolCallId}-media-${n}` 保证唯一；
 *   contentType 固定 text/plain（内容是 data URL 文本本身），retention=session；
 *   已带 zcode-artifact:// 的块复用原 URI，避免重复写。
 * 副作用：写 artifact store（有 I/O）；不吞 Stop 信号 —— 结果收尾阶段的媒体保存必须完成，
 *   否则冷恢复会丢内容。
 * 失败：有媒体但缺 artifactStore 直接抛错，不允许静默丢弃。
 */
export async function persistToolResultMediaAttachments(input: {
  artifactStore?: ToolArtifactStorePort;
  assistantMessageId: MessageId;
  content: ModelMessageContent;
  sessionId: SessionId;
  sessionStore?: SessionStorePort;
  toolCallId: string;
  toolName: string;
  traceContext: TraceContext;
  turnId: TurnId;
}): Promise<
  | {
      attachments: FilePart[];
      modelContentLayout: PersistedToolMediaLayoutEntry[];
    }
  | undefined
> {
  if (!input.sessionStore) return undefined;
  const projection = persistedToolMediaProjection(input.content);
  if (!projection) return undefined;
  if (!input.artifactStore) {
    throw new Error("Cannot persist tool result media without an artifact store");
  }

  const attachments: FilePart[] = [];
  for (const [index, block] of projection.mediaBlocks.entries()) {
    const existingArtifactUri = block.source?.uri?.startsWith("zcode-artifact://")
      ? block.source.uri
      : undefined;
    // 已完成工具的媒体属于结果收尾；继承本轮 Stop 信号会中断保存并丢失冷恢复内容。
    const artifactUri =
      existingArtifactUri ??
      (
        await input.artifactStore.writeToolResultArtifact({
          content: block.dataUrl,
          contentType: "text/plain",
          retention: "session",
          sessionId: input.sessionId,
          toolCallId: `${input.toolCallId}-media-${index + 1}`,
          toolName: input.toolName,
          trace: input.traceContext,
          turnId: input.turnId,
        })
      ).uri;

    attachments.push({
      id: createPartId(),
      messageID: input.assistantMessageId,
      sessionID: input.sessionId,
      type: "file",
      mime: block.mediaType,
      ...(block.type === "file" && block.name
        ? { filename: block.name }
        : block.source?.placeholder
          ? { filename: block.source.placeholder }
          : {}),
      url: artifactUri,
      metadata: {
        artifactUri,
        recoverability: "provider_ready",
        storageKind: "artifact",
        ...(block.source?.sizeBytes !== undefined ? { sizeBytes: block.source.sizeBytes } : {}),
        ...(block.source?.sha256 ? { sha256: block.source.sha256 } : {}),
      },
    });
  }
  return { attachments, modelContentLayout: projection.modelContentLayout };
}

/**
 * 把模型内容投影成"媒体块数组 + 布局"（私有）。
 *
 * 输入：ModelMessageContent（可能是字符串或块数组）。
 * 输出：媒体块（保持原顺序）与逐块布局；无媒体、空数组、非数组输入一律 undefined。
 * 规则：
 *   - text 块只进布局，不算媒体；
 *   - image/video 必须 dataUrl 以 "data:" 开头才算可持久化媒体；
 *   - file 块可选 dataUrl，同样要求 data: 前缀；
 *   - 遇到其它块（或非 data: 媒体）立即整体返回 undefined —— 宁可整段不持久化，
 *     也不产生"部分块丢内容"的消息。
 * 副作用：无；只做分类与引用收集。
 */
function persistedToolMediaProjection(content: ModelMessageContent):
  | {
      mediaBlocks: DataBackedToolMediaBlock[];
      modelContentLayout: PersistedToolMediaLayoutEntry[];
    }
  | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const mediaBlocks: DataBackedToolMediaBlock[] = [];
  const modelContentLayout: PersistedToolMediaLayoutEntry[] = [];
  for (const block of content) {
    if (block.type === "text") {
      modelContentLayout.push({ type: "text", text: block.text });
      continue;
    }
    if ((block.type === "image" || block.type === "video") && block.dataUrl.startsWith("data:")) {
      modelContentLayout.push({ type: "attachment", attachmentIndex: mediaBlocks.length });
      mediaBlocks.push(block);
      continue;
    }
    if (block.type === "file" && block.dataUrl?.startsWith("data:")) {
      modelContentLayout.push({ type: "attachment", attachmentIndex: mediaBlocks.length });
      mediaBlocks.push(block as DataBackedToolMediaBlock);
      continue;
    }
    return undefined;
  }
  return mediaBlocks.length > 0 ? { mediaBlocks, modelContentLayout } : undefined;
}
