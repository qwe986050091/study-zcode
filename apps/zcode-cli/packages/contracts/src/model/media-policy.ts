import {
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContentBlock,
} from "./index.js";

// ---------------------------------------------------------------
// 模型输入媒体策略：判定哪些内容块会真正发给 provider，以及不支持时的降级
//
// 生产者：core 在组装模型请求、按模型能力裁剪多模态输入时调用。
// 消费者：adapter 用 isProviderVisible* 决定是否序列化二进制；getUnsupported*
// 决定是否需要替换成占位文本；createUnsupported*Text 生成降级文案。
// 判定顺序：先按“provider 可见形态”收敛（image / PDF 文件数据 / video），
// 再逐项对照 ModelInputFormat 的 supportsImage/PDF/Video；顺序不可颠倒，
// 否则会把已被文本替代的 PDF 误判为可见媒体，或把普通文件当成视频。
// 放宽权：能力结论只来自模型配置的 inputFormat，调用方与 adapter 均不得
// 通过请求级参数临时放宽；预算裁剪另行处理，不在本文件决策。
// ---------------------------------------------------------------

/**
 * 被模型能力拒绝的媒体类别，同时用作降级文案里的类别名。
 *
 * 生产者：getUnsupportedModelInputMediaKind 在能力不匹配时返回。
 * 消费者：createUnsupportedModelInputMediaText 拼接用户可读说明。
 * 不变量：取值是面向用户/诊断的稳定英文短语，新增类别必须同步文案分支。
 */
export type UnsupportedModelInputMediaKind = "image input" | "PDF input" | "video input";

/**
 * 内容块是否以“provider 可见的二进制媒体”形态存在（图片/PDF 文件数据/视频）。
 *
 * 生产者：core 的媒体裁剪与 adapter 的序列化分支判断。
 * 消费者：决定是否走媒体能力校验、是否需要用占位文本替换。
 * 不变量：这是形态判断而非能力判断——不看模型是否支持，只看块当前是否还携带
 * 可发送的数据；PDF 文本替代后即不再可见，因此这里必须与 PDF 判定保持同源。
 */
export function isProviderVisibleModelInputMediaBlock(block: ModelMessageContentBlock): boolean {
  return (
    block.type === "image" ||
    isProviderVisiblePdfModelInputBlock(block) ||
    isProviderVisibleVideoModelInputBlock(block)
  );
}

/**
 * 判断一个 file 块当前是否仍以 PDF 文件数据形式发给 provider。
 *
 * 生产者：core 的 PDF 输入处理与媒体能力校验。
 * 消费者：getUnsupportedModelInputMediaKind 的 PDF 分支；adapter 的 file-data 回退。
 * 不变量：必须同时满足 mediaType 主体为 application/pdf、携带 dataUrl、且 text 为空
 * （undefined 或空串）。因为文本提取成功时 adapter 优先发文本，此时 PDF 数据不再可见，
 * 不能按“模型不支持 PDF”去降级——这正是判定顺序里最容易出错的一环。
 */
export function isProviderVisiblePdfModelInputBlock(block: ModelMessageContentBlock): boolean {
  return (
    block.type === "file" &&
    block.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" &&
    block.dataUrl !== undefined &&
    // PDF 提取文本为空字符串时，adapter 会回退发送 file-data。
    // 只有非空文本能替代 provider-visible PDF 文件数据。
    (block.text === undefined || block.text.length === 0)
  );
}

/**
 * 判断内容块是否会以视频二进制形式发给 provider（video 块或 video/* 的 file 块）。
 *
 * 生产者：core 的视频输入处理与媒体能力校验。
 * 消费者：getUnsupportedModelInputMediaKind 的 video 分支。
 * 不变量：必须携带 dataUrl 才算可见数据；mediaType 只看 `video/` 前缀，
 * 不依赖块类型名——视频既可能用专用 video 块，也可能复用 file 块。
 */
export function isProviderVisibleVideoModelInputBlock(block: ModelMessageContentBlock): boolean {
  return (
    (block.type === "video" || block.type === "file") &&
    block.mediaType.toLowerCase().startsWith("video/") &&
    block.dataUrl !== undefined
  );
}

/**
 * 按模型 inputFormat 判定某个媒体块是否不受支持，并给出类别。
 *
 * 生产者：core 在请求装配阶段逐块检查，决定是否替换为占位文本。
 * 消费者：降级文案生成与诊断日志；adapter 据此跳过二进制序列化。
 * 不变量：检查顺序为 image → PDF → video，且只对“provider 可见”的块生效
 * （普通文本/链接/资源引用永远返回 undefined）。能力值只读 inputFormat，
 * 不做请求级覆盖；返回 undefined 表示该块可以原样发送。
 */
export function getUnsupportedModelInputMediaKind(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): UnsupportedModelInputMediaKind | undefined {
  if (block.type === "image" && !inputFormat.supportsImage) {
    return "image input";
  }
  if (isProviderVisiblePdfModelInputBlock(block) && !inputFormat.supportsPdf) {
    return "PDF input";
  }
  if (isProviderVisibleVideoModelInputBlock(block) && !inputFormat.supportsVideo) {
    return "video input";
  }
  return undefined;
}

/**
 * 生成“媒体被省略”的降级文本：保留可读占位符并说明原因，替代原始二进制。
 *
 * 生产者：core 在模型不支持该媒体时替换内容块。
 * 消费者：adapter 把文本发给 provider，UI/回放展示同一段说明。
 * 不变量：占位符来自 modelMessageContentToText（与正常内容块同一口径），
 * 为空时回退到固定 `[Attached media]`；说明句必须包含具体 unsupportedKind，
 * 但不得泄漏文件内容或本地路径。
 */
export function createUnsupportedModelInputMediaText(
  block: ModelMessageContentBlock,
  unsupportedKind: UnsupportedModelInputMediaKind,
): string {
  const placeholder = modelMessageContentToText([block]) || "[Attached media]";
  return `${placeholder}\n[Media omitted from provider request because the selected model does not support ${unsupportedKind}.]`;
}
