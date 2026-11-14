import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

// PDF 单文件 20MiB 上限。超过后附件降级为路径引用，不再尝试放入请求体；
// 该值与 provider 侧 PDF 输入限制对齐，本地读盘（readBinaryFile.maxBytes）也复用它。
export const PDF_INPUT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 严格解析 inline PDF data URL。
 *
 * 校验链（任一不满足即 undefined，调用方降级为 attachment_pdf_invalid）：
 * 1. 必须是 `data:` 且含逗号；
 * 2. header 首个字段必须是 application/pdf；
 * 3. header 最后一个字段必须是 base64（允许中间有 charset 等参数）；
 * 4. 正文必须是严格 base64；
 * 5. 解码后前 5 字节必须是 `%PDF-`。
 *
 * 输出：sizeBytes 取 base64 正文换算出的原始字节数（不是解码后 Buffer 长度，避免 padding 误差）；
 * bytes 是已解码内容，供调用方复用（本地分支不经过本函数，自己拼 data URL）。
 * 副作用：一次 Buffer 解码（CPU）；无 IO。
 * 不变量：返回 undefined 时调用方不得再尝试"宽松解析"或按文本读取。
 */
export function parseInlinePdfDataUrl(
  dataUrl: string,
): { mediaType: "application/pdf"; sizeBytes: number; bytes: Buffer } | undefined {
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = dataUrl.slice("data:".length, commaIndex).split(";");
  const mediaType = headerParts.shift()?.trim().toLowerCase();
  const payload = dataUrl.slice(commaIndex + 1);
  if (
    mediaType !== "application/pdf" ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(payload, "base64");
  if (!isPdfBytes(bytes)) return undefined;
  return {
    mediaType: "application/pdf",
    sizeBytes: base64PayloadByteLength(payload),
    bytes,
  };
}

/**
 * PDF 魔数判定：文件必须以 `%PDF-`（0x25 0x50 0x44 0x46 0x2D）开头。
 *
 * 只做长度与首 5 字节检查，不解析 xref/版本；用来挡住"扩展名是 .pdf 或 header 声称 pdf，
 * 但内容其实是文本/图片"的伪造载荷，避免把非 PDF 字节送进 provider。
 * 纯函数，无副作用。
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
