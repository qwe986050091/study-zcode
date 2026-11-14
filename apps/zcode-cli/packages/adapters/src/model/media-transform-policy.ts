// ============================================================
// 输入媒体策略（协议不支持时如何降级）
// 定位：在序列化请求前判定某内容块是否被目标 inputFormat 支持，不支持则生成占位文本。
// 输入：内容块 + 目标格式（undefined 表示未知格式）。输出：占位文本或 undefined（无需降级）。
// 副作用：无。失败语义：不抛错；格式未知时选择"不降级"，交由下游自行处理。
// 不变量：支持判定完全委托 @zcode/contracts，adapter 不维护第二套格式能力表。
// ============================================================

import {
  createUnsupportedModelInputMediaText,
  getUnsupportedModelInputMediaKind,
  type ModelInputFormat,
  type ModelMessageContentBlock,
} from "@zcode/contracts";

/**
 * 若 block 在 inputFormat 下不受支持，返回可读占位文本（含媒体类型说明）；
 * 支持或格式未知（undefined）时返回 undefined，表示"原样传递"。
 */
export function unsupportedInputMediaText(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat | undefined,
): string | undefined {
  if (!inputFormat) return undefined;
  const unsupportedKind = getUnsupportedModelInputMediaKind(block, inputFormat);
  return unsupportedKind ? createUnsupportedModelInputMediaText(block, unsupportedKind) : undefined;
}

/**
 * 解析 data URL（`data:<mediaType>;base64,<payload>`），返回 mediaType 与 base64 数据。
 * 返回 undefined 的四种情况：非 data: 前缀、无逗号分隔、末段不是 base64、mediaType 或载荷为空。
 * 只支持 base64 编码，非 base64 的 data URL 视为不可用（不尝试 percent-decode）。
 */
export function dataUrlToDataContent(
  dataUrl: string,
): { mediaType: string; data: string } | undefined {
  // Provider 格式重构与 PDF 支持发生冲突时，旧正则解析和新实现的
  // 返回语句被错误拼接，导致 mediaType 未定义。保留统一的 ModelInputFormat，
  // 同时完整采用支持参数化 Data URL 的解析路径，避免再次混用两套实现。
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = dataUrl.slice("data:".length, commaIndex).split(";");
  const mediaType = headerParts.shift()?.trim();
  if (headerParts.at(-1)?.trim().toLowerCase() !== "base64" || !mediaType) return undefined;
  const data = dataUrl.slice(commaIndex + 1);
  if (data.length === 0) return undefined;
  return { mediaType: mediaType.toLowerCase(), data };
}
