// ============================================================
// model-io 调试记录脱敏
// 定位：model-io 落盘是唯一保留请求/响应原文的调试路径，必须在写盘前删除凭据与媒体原始数据。
// 输入：任意调试记录对象。输出：新对象（request/response 的 headers 打码，image/video 数据替换为摘要）。
// 副作用：无（纯递归复制）；不修改入参。
// 失败语义：任何非法形态都原样保留或安全降级，不抛错中断调试记录。
// 不变量：媒体原文绝不落盘；字段替换后仍保留类型、mime 与字符数等可诊断信息。
// ============================================================

import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

/**
 * 对 model-io 记录做整体脱敏：分别处理 request/response 分区头，再全量递归替换媒体数据。
 * 分区不存在时保持原样（不注入空对象），避免改变落盘结构。
 */
export function sanitizeModelIODebugRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const request = sanitizeModelIOSectionHeaders(asRecord(record.request));
  const response = sanitizeModelIOSectionHeaders(asRecord(record.response));
  return redactModelIOImageAndVideoData({
    ...record,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
  }) as Record<string, unknown>;
}

/**
 * 处理单个分区：只有自身确实带 headers 键时才归一化并打码；
 * 用 Object.hasOwn 而非直接取值，避免原型链上的 headers 被误处理。
 */
function sanitizeModelIOSectionHeaders(
  section: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!section || !Object.hasOwn(section, "headers")) {
    return section;
  }
  return {
    ...section,
    headers: sanitizeModelNetworkHeaders(section.headers),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 递归替换内嵌图片/视频：data URL 按 mime 判定，AI SDK file/image 块按 mediaType 判定；
 * 命中则把值换成"[省略 + mime + 字符数]"的摘要字符串，其余字段继续递归。
 * 三种 wire 形态（base64 原始数据、file、image）的键名不同，因此统一在此处收口。
 */
// 内部 dataUrl、AI SDK image/file 与 provider wire 的媒体键名不同，
// 分散在调用方脱敏会遗漏 image/video 形态；统一在 model-I/O 落盘边界递归处理。
function redactModelIOImageAndVideoData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactModelIOImageAndVideoData(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const rawDataMediaType =
    record.type === "base64" && typeof record.media_type === "string"
      ? record.media_type
      : (record.type === "file" || record.type === "image") && typeof record.mediaType === "string"
        ? record.mediaType
        : undefined;
  const rawDataKey = record.type === "image" ? "image" : "data";
  const isRawImageOrVideo = isImageOrVideoMimeType(rawDataMediaType);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      const dataUrlMimeType = readDataUrlMimeType(child);
      if (isImageOrVideoMimeType(dataUrlMimeType)) {
        result[key] = `[${key} omitted from model-io: ${dataUrlMimeType}, ${child.length} chars]`;
        continue;
      }
      if (key === rawDataKey && isRawImageOrVideo) {
        result[key] = `[${key} omitted from model-io: ${rawDataMediaType}, ${child.length} chars]`;
        continue;
      }
    }
    result[key] = redactModelIOImageAndVideoData(child);
  }
  return result;
}

/** 从 data URL 提取 mime；不符合 data:<type>[;,] 形式时返回 "unknown"（仍按未知类型参与判定）。 */
function readDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? "unknown";
}

/**
 * 是否图片/视频 mime；缺失或空串返回 false（不脱敏未知类型，避免误伤文本）。
 * 先 trim+lowercase，否则非规范大小写可绕过脱敏。
 */
function isImageOrVideoMimeType(mimeType: string | undefined): boolean {
  // MIME type 大小写不敏感，直接比较会让非规范大小写绕过日志脱敏。
  const normalized = mimeType?.trim().toLowerCase();
  return normalized?.startsWith("image/") === true || normalized?.startsWith("video/") === true;
}
