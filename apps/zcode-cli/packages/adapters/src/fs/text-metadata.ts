/**
 * ============================================================================
 * fs/text-metadata.ts —— 文本编码探测、编解码与换行归一
 * ============================================================================
 *
 * 【定位】读文本时决定"这是什么编码"，并保证写入时能被目标编码无损表示；
 * 供 readTextFile / readTextFileRange 共用。
 *
 * 【探测顺序】UTF-8 BOM → UTF-16LE BOM → 二进制判定 → 严格 UTF-8 →
 * GB2312/GBK/GB18030 往返校验。二进制判定：含 0x00 或控制字节占比 >30%。
 *
 * 【失败语义】无法判定编码/疑似二进制抛 FileSystemPortError(code="unsupported")；
 * 写入内容无法被目标编码无损编码也抛 unsupported（先编码再解码比对，防止
 * iconv 静默替换成 '?'）。
 *
 * 【换行口径】可解码编码归一为 LF；base64/base64url/hex 等非文本编码不归一。
 * ============================================================================
 */
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import {
  createFileSystemError,
  type FileSystemLineEndings,
  type FileSystemTextEncoding,
} from "@zcode/contracts";
import iconv from "iconv-lite";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const LEGACY_CHINESE_ENCODINGS = ["gb2312", "gbk", "gb18030"] as const;
const BINARY_CONTROL_BYTE_THRESHOLD = 0.3;
const MAX_DETECTION_TRAILING_DROP_BYTES = 3;
const MAX_UTF8_SEQUENCE_BYTES = 4;
const NON_TEXT_ENCODINGS = new Set(["base64", "base64url", "hex"]);

type LegacyChineseEncoding = (typeof LEGACY_CHINESE_ENCODINGS)[number];

interface DecodedTextBuffer {
  content: string;
  encoding: FileSystemTextEncoding;
}

interface StreamingTextDecoder {
  write(buffer: Buffer): string;
  end(): string;
}

/**
 * 探测文本编码。
 *
 * 输入为文件字节（通常是头部或整文件），path 仅用于错误信息。
 * 返回 utf8/utf16le/gb2312/gbk/gb18030 之一；疑似二进制或无法匹配任何
 * 候选编码时抛 unsupported。纯函数，不读盘。
 */
export function detectTextEncoding(buffer: Buffer, path?: string): FileSystemTextEncoding {
  if (buffer.length >= 3 && bytesStartWith(buffer, UTF8_BOM)) {
    return "utf8";
  }
  if (buffer.length >= 2 && bytesStartWith(buffer, UTF16LE_BOM)) {
    return "utf16le";
  }
  if (looksLikeBinary(buffer)) {
    throw createUnsupportedTextEncodingError(path);
  }
  if (isValidUtf8(buffer)) {
    return "utf8";
  }
  for (const encoding of LEGACY_CHINESE_ENCODINGS) {
    if (roundTripsWithOptionalTrailingDrop(buffer, encoding)) {
      return encoding;
    }
  }
  throw createUnsupportedTextEncodingError(path);
}

/**
 * 按指定编码（缺省自动探测）解码字节。
 *
 * 返回 content 与实际采用的 encoding；encoding 由调用方显式给出时不再探测，
 * 因此可能解出乱码但仍返回该编码。解码本身不抛错（除不支持编码）。
 */
export function decodeTextBuffer(request: {
  buffer: Buffer;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): DecodedTextBuffer {
  const encoding = request.encoding ?? detectTextEncoding(request.buffer, request.path);
  return {
    content: decodeBufferWithEncoding(request.buffer, encoding),
    encoding,
  };
}

/**
 * 把文本编码成字节。
 *
 * encoding 缺省 utf8；GB 系编码先 iconv 编码再做往返校验，不可无损表示时抛
 * unsupported（不静默替换字符）。其他编码交给 Buffer.from。
 */
export function encodeTextContent(request: {
  content: string;
  encoding?: FileSystemTextEncoding;
  path?: string;
}): Buffer {
  const encoding = request.encoding ?? "utf8";
  if (isLegacyChineseEncoding(encoding)) {
    const encoded = iconv.encode(request.content, encoding);
    assertLegacyEncodingRoundTrip({
      decoded: request.content,
      encoded,
      encoding,
      path: request.path,
    });
    return encoded;
  }
  return Buffer.from(request.content, encoding);
}

/**
 * 创建流式解码器（大文件分块读取用）。
 *
 * GB 系用 iconv 的 getDecoder（多字节字符可跨 chunk）；其余用 StringDecoder。
 * end() 返回尾部残留（可能为空串），调用方必须调用它以免丢最后一个字符。
 */
export function createStreamingTextDecoder(encoding: FileSystemTextEncoding): StreamingTextDecoder {
  if (isLegacyChineseEncoding(encoding)) {
    const decoder = iconv.getDecoder(encoding);
    return {
      write(buffer) {
        return decoder.write(buffer);
      },
      end() {
        return decoder.end() ?? "";
      },
    };
  }
  const decoder = new StringDecoder(encoding);
  return {
    write(buffer) {
      return decoder.write(buffer);
    },
    end() {
      return decoder.end();
    },
  };
}

/**
 * 是否需要对换行归一。
 *
 * base64/base64url/hex 是"字节的文本表示"，换行没有语义，归一反而破坏内容；
 * 其余文本编码统一归一到 LF。
 */
export function shouldNormalizeLineEndings(encoding: FileSystemTextEncoding): boolean {
  return !NON_TEXT_ENCODINGS.has(normalizeEncodingName(encoding));
}

function decodeBufferWithEncoding(buffer: Buffer, encoding: FileSystemTextEncoding): string {
  if (isLegacyChineseEncoding(encoding)) {
    return iconv.decode(buffer, encoding);
  }
  return buffer.toString(encoding);
}

function assertLegacyEncodingRoundTrip(request: {
  decoded: string;
  encoded: Buffer;
  encoding: LegacyChineseEncoding;
  path?: string;
}): void {
  if (iconv.decode(request.encoded, request.encoding) === request.decoded) return;
  throw createFileSystemError({
    code: "unsupported",
    path: request.path,
    message: `Content cannot be encoded as ${request.encoding}${
      request.path ? `: ${request.path}` : ""
    }`,
  });
}

/**
 * GB 系编码往返校验（允许尾部最多丢 3 字节）。
 *
 * 文件尾被截断时最后一个多字节字符可能不完整；依次丢弃 0~3 个尾字节再
 * 编码/解码比对，任一命中即认为该编码成立。内部用 iconv。
 */
function roundTripsWithOptionalTrailingDrop(
  buffer: Buffer,
  encoding: LegacyChineseEncoding,
): boolean {
  if (buffer.length === 0) return true;
  for (
    let drop = 0;
    drop <= Math.min(MAX_DETECTION_TRAILING_DROP_BYTES, buffer.length);
    drop += 1
  ) {
    const candidate = drop === 0 ? buffer : buffer.subarray(0, buffer.length - drop);
    if (candidate.length === 0) continue;
    const decoded = iconv.decode(candidate, encoding);
    const encoded = iconv.encode(decoded, encoding);
    if (encoded.equals(candidate)) return true;
  }
  return false;
}

/**
 * 估算 UTF-8 尾部未完成序列还缺几个字节。
 *
 * 从末尾回退到最后一个非续字节（最多回看 4 字节），按其首字节推断应有长度；
 * 返回"还需补多少字节"。注释强调：补齐后仍须严格校验，不能仅凭此确认编码。
 */
export function getUtf8CompletionBytes(buffer: Buffer): number {
  // 这里只计算尾部候选所缺的字节；补齐后仍须严格校验，不能据此确认编码。
  let start = buffer.length - 1;
  const earliestStart = Math.max(0, buffer.length - MAX_UTF8_SEQUENCE_BYTES);
  while (start > earliestStart && (buffer[start]! & 0xc0) === 0x80) start -= 1;
  const lead = buffer[start];
  if (lead === undefined) return 0;
  const sequenceBytes =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  return Math.max(0, sequenceBytes - (buffer.length - start));
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    // stream 模式会把 GBK 的 D6 暂存为 UTF-8 候选；必须补齐后严格校验，拒绝 D6 D0 等非法序列。
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function looksLikeBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let controlBytes = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      controlBytes += 1;
    }
  }
  return controlBytes / buffer.length > BINARY_CONTROL_BYTE_THRESHOLD;
}

function bytesStartWith(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

function isLegacyChineseEncoding(
  encoding: FileSystemTextEncoding,
): encoding is LegacyChineseEncoding {
  return LEGACY_CHINESE_ENCODINGS.includes(encoding as LegacyChineseEncoding);
}

function normalizeEncodingName(encoding: FileSystemTextEncoding): string {
  return encoding.toLowerCase();
}

function createUnsupportedTextEncodingError(path?: string): Error {
  return createFileSystemError({
    code: "unsupported",
    path,
    message: `Unsupported or binary text encoding${path ? `: ${path}` : ""}`,
  });
}

/**
 * 检测换行风格：CRLF 数量多于 LF 才判 CRLF，否则 LF。
 *
 * 只统计 \n 并回看前一个字符是否为 \r；孤立 \r（老 Mac）不计入，按 LF 处理。
 */
export function detectLineEndings(content: string): FileSystemLineEndings {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") continue;
    if (index > 0 && content[index - 1] === "\r") {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}

/** 把 CRLF 统一成 LF（只处理成对 \r\n，孤立 \r 保留）。 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

/**
 * 按请求的换行风格输出。
 *
 * undefined 表示"保持原样"（不做归一也不转换）；否则先归一到 LF，再按目标
 * 风格拼回 CRLF 或保持 LF。注意这是纯文本替换，不检查字符串内的裸 \r。
 */
export function applyRequestedLineEndings(
  content: string,
  lineEndings: FileSystemLineEndings | undefined,
): string {
  if (lineEndings === undefined) {
    return content;
  }
  const normalized = normalizeLineEndings(content);
  return lineEndings === "CRLF" ? normalized.split("\n").join("\r\n") : normalized;
}
