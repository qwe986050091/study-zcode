import { basename } from "../deps.js";
import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";
import { inferVideoMimeFromPath } from "./attachment-video.js";

/**
 * 路径引用（而非正文）交付的原因码。
 *
 * 口径：这个枚举同时驱动 metadata.storageKind=local_ref 的降级语义与写给模型的说明文本
 * （formatPathReferenceReason）。新增原因必须同时补文案，否则会落到 binary_file 的默认措辞。
 * 各值含义：
 * - binary_file：疑似二进制/未知扩展名，不应解码进 prompt；
 * - deferred_clipboard_text：长粘贴文本已落临时文件，按需读取以控制上下文体积；
 * - deferred_topic_history：话题历史材料延后读取，避免一次性灌入；
 * - image_too_large / pdf_too_large / text_too_large / video_too_large：超出对应预算，
 *   正文不发，只给路径与建议。
 */
type PathReferenceReason =
  | "binary_file"
  | "deferred_clipboard_text"
  | "deferred_topic_history"
  | "image_too_large"
  | "pdf_too_large"
  | "text_too_large"
  | "video_too_large";

/**
 * 内联纯文本附件：正文直接作为 text block 发送。
 *
 * 输入：attachment.content 为原文（非 data URL 分支才会走到这里）。
 * 输出：text contentBlock + preview（truncated=false，originalBytes 按 UTF-8 字节计），
 * recoverability=provider_ready、storageKind=inline —— 文本已经完整在请求里。
 * url 用 placeholder（path 或 attachment-N），仅作展示引用，不参与内容解析。
 * 副作用：无；不落盘。
 */
export function resolvedInlineTextAttachment(
  attachment: TurnAttachment,
  index: number,
): ResolvedTurnAttachment {
  const content = attachment.content ?? "";
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return {
    contentBlock: { type: "text", text: content },
    filename: attachment.path ? basename(attachment.path) : undefined,
    metadata: {
      originalUrl: safeAttachmentOriginalRef(attachment),
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: "text/plain",
    url: placeholder,
  };
}

/**
 * 把"本来该发正文、但被降级"的附件表达成一段可发送的路径引用文本。
 *
 * 职责：生成三行说明（附件 mime + 路径、为什么按路径发送、需要时可用文件工具读取），
 * 让模型既不误以为收到正文，也知道该用什么手段补读。
 *
 * 输出口径：
 * - contentBlock 是 text（不是 file/image），因此不占媒体预算；
 * - metadata.recoverability=metadata_only：冷恢复只能靠 metadata，无法重放正文；
 * - metadata.storageKind=local_ref，并保留 originalUrl；
 * - metadata.pathReferenceText 冗余保存完整说明（关键，见行内注释）。
 * 输入：placeholder 是展示用引用；options.sizeBytes/mime/filename/source 供 UI 与日志使用。
 * 副作用：无。失败：无（纯字符串拼装）。
 */
export function resolvedPathReferenceAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  options: {
    filename?: string;
    mime?: string;
    reason: PathReferenceReason;
    sizeBytes?: number;
    source?: FilePartSource;
  },
): ResolvedTurnAttachment {
  const mime =
    options.mime ?? (attachment.type === "image" ? "image/*" : "application/octet-stream");
  const content = [
    `Attached ${mime}: ${placeholder}`,
    `The file was sent by local path because ${formatPathReferenceReason(options.reason)}.`,
    "Use the available file reading tools if you need to inspect the file contents.",
  ].join("\n");
  return {
    contentBlock: { type: "text", text: content },
    filename: options.filename,
    metadata: {
      originalUrl: safeAttachmentOriginalRef(attachment),
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: "local_ref",
      // 原说明只存在于 contentBlock 时，冷恢复会丢失降级原因和读取提示，改变模型历史前缀。
      pathReferenceText: content,
    },
    mime,
    source: options.source,
    url: attachment.path ?? attachment.content ?? "",
  };
}

/**
 * 判断内容是否是"已在 durable 存储里的引用"。
 *
 * data: 表示正文在请求内部；zcode-artifact:// 表示内容已落 artifact store。
 * 两者都不该再按本地文件路径读取，也不该写进 path 字段。
 * 无副作用。
 */
export function isDataOrArtifactUrl(content: string): boolean {
  return content.startsWith("data:") || content.startsWith("zcode-artifact://");
}

/**
 * 按扩展名白名单判断"可以安全按文本读入 prompt"的文件。
 *
 * 白名单是刻意保守的：只列常见源码/配置/文档扩展名；未列出的（二进制、无扩展名、
 * 图片音视频容器等）一律走路径引用，防止把二进制解码成乱码正文。
 * 大小写不敏感（正则 u 标志 + i）；无副作用。
 */
export function isTextLikePath(path: string): boolean {
  return /\.(cjs|conf|cpp|cs|css|csv|go|h|hpp|html|ini|java|js|json|jsx|log|md|mjs|py|rs|sh|sql|toml|ts|tsx|txt|xml|yaml|yml)$/iu.test(
    path,
  );
}

/**
 * 附件展示层 mime 推断（无 IO，供 TurnStarted 等早期事件使用）。
 *
 * 优先级：pdf/json/csv/md 特判 → 视频扩展名（复用 attachment-video 的唯一映射表）
 * → 文本白名单 → application/octet-stream。
 * 注意：这里返回的是"用于展示/兜底"的值，不代表已校验真实字节；
 * image 的推断在 attachment-image.ts，不在此函数里。
 * 无副作用；不抛错。
 */
export function inferAttachmentMimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "json") return "application/json";
  if (extension === "csv") return "text/csv";
  if (extension === "md") return "text/markdown";
  // video 扩展名映射复用 attachment-video 的唯一事实源，避免两处维护同一张表。
  const videoMime = inferVideoMimeFromPath(path);
  if (videoMime) return videoMime;
  return isTextLikePath(path) ? "text/plain" : "application/octet-stream";
}

/**
 * 把路径引用的降级原因转成给模型看的可读文本。
 *
 * 每种 reason 对应一句解释，说明"为什么这次只给路径"（例如视频过大、附件无法读取、
 * 主题历史改为按需读取），让模型知道应改用文件读取工具而不是反复要求原文件。
 * 纯函数，无副作用；返回英文短句，作为 contentBlock.text 的一部分。
 */
function formatPathReferenceReason(reason: PathReferenceReason): string {
  if (reason === "deferred_topic_history") return "topic history is provided for on-demand reading";
  if (reason === "deferred_clipboard_text") {
    return "it is a pasted-text temporary attachment that is deferred to keep the model context small";
  }
  if (reason === "image_too_large") return "the image is larger than the inline media budget";
  if (reason === "pdf_too_large") return "the PDF is larger than the inline PDF input limit";
  if (reason === "text_too_large") return "the text file is larger than the inline text budget";
  if (reason === "video_too_large") return "the video is larger than the ZCode video input limit";
  return "the file is not a known text attachment";
}
