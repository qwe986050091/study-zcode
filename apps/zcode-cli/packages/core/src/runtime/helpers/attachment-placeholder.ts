import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";

/**
 * 把"无法发送正文"的附件降级成一段占位文本。
 *
 * 职责：保证请求里每个附件都有对应的可见内容，同时把失败原因与原始引用留在 metadata 里。
 *
 * 输入：placeholder 是给模型看的引用（path 或 attachment-N）；errorCode 是稳定失败码
 * （attachment_image_invalid / attachment_pdf_invalid / attachment_read_failed /
 * attachment_not_file / attachment_image_resize_failed 等），必须原样保存，供遥测归因；
 * options.mime 缺省按附件类型给 image/*、application/pdf 或 text/plain。
 *
 * 输出口径：
 * - contentBlock 是 text，因此不占媒体预算；
 * - recoverability=metadata_only：冷恢复只能看到错误码与引用，无法重放正文；
 * - storageKind：有 path 时为 local_ref（还能按路径重读），否则 metadata_only；
 * - url 分支见下方行内注释（PDF/video 绝不把 base64 正文写进 part）。
 *
 * 副作用：无。失败：无（纯对象构造）。
 */
export function resolvedPlaceholderAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  errorCode: string,
  options: {
    filename?: string;
    mime?: string;
    sizeBytes?: number;
    source?: FilePartSource;
  } = {},
): ResolvedTurnAttachment {
  const mime =
    options.mime ??
    (attachment.type === "image"
      ? "image/*"
      : attachment.type === "pdf"
        ? "application/pdf"
        : "text/plain");
  const safeOriginalRef = safeAttachmentOriginalRef(attachment);
  return {
    contentBlock: { type: "text", text: `[Attached ${mime}: ${placeholder}]` },
    filename: options.filename,
    metadata: {
      errorCode,
      originalUrl: safeOriginalRef,
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: attachment.path ? "local_ref" : "metadata_only",
    },
    mime,
    source: options.source,
    // 无效 media data URL 虽已降级为占位文本，过去仍会通过 file part 的 url
    // 把 base64 正文落入 session。PDF 不得把 data URL 写入 part.data；可恢复的 artifact
    // URI 仍保留，便于后续诊断和按既定授权路径重试。
    url:
      attachment.type === "video" || attachment.type === "pdf"
        ? attachment.content?.startsWith("zcode-artifact://")
          ? attachment.content
          : (attachment.path ??
            (attachment.type === "pdf" ? "inline:pdf" : (safeOriginalRef ?? "")))
        : (attachment.path ?? attachment.content ?? ""),
  };
}
