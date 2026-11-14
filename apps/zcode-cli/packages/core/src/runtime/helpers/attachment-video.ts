// video 附件共用的 mime 推断与大小校验。
// Read 工具（read-video.ts）与 prompt 附件解析（attachments.ts）都从这里取，
// 保证扩展名→mime 的映射只有一份事实；mime 枚举的唯一事实源在 contracts（ReadVideoOutput）。
//
// 【为什么集中在这里】prompt 附件与工具读视频必须给出同一个 mime，否则同一文件在
// "用户附件"和"工具读取"两条路径下会得到不同 contentBlock，冷恢复比对时被视为不一致。
// 对外只暴露三个符号：类型别名（来自 contracts）、扩展名映射函数、inline data URL 解析。
import type { ReadVideoOutput } from "@zcode/contracts";
import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

export type VideoInputMimeType = ReadVideoOutput["mimeType"];

// 受支持视频扩展名 → mime。未列出的扩展名一律返回 undefined，由调用方决定降级或拒绝；
// 新增格式必须先确认 contracts 的 ReadVideoOutput.mimeType 枚举已包含，否则类型不通过。
const VIDEO_INPUT_MIME_BY_EXTENSION: Record<string, VideoInputMimeType> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** 按扩展名推断视频 mime；非受支持视频扩展名返回 undefined。 */
/**
 * 按扩展名推断视频 mime；非受支持视频扩展名返回 undefined。
 *
 * 口径：大小写不敏感的后缀匹配（endsWith），不看文件内容；undefined 表示"不是受支持的视频"，
 * 调用方不得自行猜测成 video/mp4，否则会把非视频文件当视频发送。
 * 纯函数，无副作用。
 */
export function inferVideoMimeFromPath(path: string): VideoInputMimeType | undefined {
  const lower = path.toLowerCase();
  for (const [extension, mime] of Object.entries(VIDEO_INPUT_MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

/**
 * 严格解析 inline 视频 data URL。
 *
 * 校验：`data:` 头 + 显式 `;base64` + 媒体类型必须以 video/ 开头 + 正文严格 base64。
 * 输出：mediaType（小写）与 sizeBytes（按 base64 换算的原始字节数，供上游做上限判定）。
 * 返回 undefined 表示"不是可发送的 inline 视频"，调用方转 attachment_video_invalid 占位，
 * 绝不能回落到通用文本分支（那会把 base64 正文当文本塞进 prompt）。
 * 无 IO、无副作用。
 */
export function parseInlineVideoDataUrl(
  dataUrl: string,
): { mediaType: string; sizeBytes: number } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const mediaType = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  // video inline 过去只检查宽松 data URL header，缺少 base64 标记、
  // 非法正文和非 video MIME 会继续进入持久化或通用文本分支。
  if (
    !mediaType?.startsWith("video/") ||
    payload === undefined ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  return { mediaType, sizeBytes: base64PayloadByteLength(payload) };
}
