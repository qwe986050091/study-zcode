const PERSISTED_OUTPUT_OPEN_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSE_TAG = "</persisted-output>";
// Artifact strategy uses resultBudget as the persistence trigger; once persisted, this independent
// preview budget controls the provider-visible <persisted-output> snippet.
const PERSISTED_OUTPUT_PREVIEW_CHARS = 2_000;

export interface PersistedOutputEnvelopeInput {
  /** 落盘前的完整结果文本；只用于生成预览，不会被整体放进模型上下文。 */
  content: string;
  /** 字节数格式化函数；调用方传入自己的口径（通用入口用十进制单位）。 */
  formatBytes: (bytes: number) => string;
  /** 原始结果总字节数；写入提示行，模型据此判断是否需要回读全文。 */
  originalBytes: number;
  /** 全文落盘路径；模型可据此用 Read 取回完整内容。 */
  persistedPath: string;
  /** 预览保留的字符数上限（UTF-16 code unit，不是 UTF-8 字节）。 */
  previewChars: number;
}

/**
 * 生成“结果已落盘”给模型看的通用信封。
 * 输入：预览内容、原始字节数、落盘路径。
 * 输出：`<persisted-output>` 包裹的固定格式：提示行 + 预览头 + 截断预览 + 结束标签。
 * 预览上限固定 2000 字符；与 resultBudget 是两套独立预算——落盘由总字节触发，
 * 预览只影响模型可见片段，不改变磁盘上的全文。
 * 纯函数；不读写文件，落盘动作由调用方（result-serialization）完成。
 */
export function formatGenericPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatDecimalBytes,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: PERSISTED_OUTPUT_PREVIEW_CHARS,
  });
}

/**
 * 按给定预览预算生成落盘信封（通用入口的底层实现）。
 * 输出行顺序固定：开标签、超限说明、空行、预览头、预览正文、可选省略号、闭标签。
 * 空行/undefined 行在这里被过滤，保证 envelope 结构可被稳定解析。
 * 注意：预览头里的 `${formatBytes(previewChars)}` 按“字符数当字节数”格式化，
 * 多字节文本下该标签会小于真实字节量；它只是提示，不是精确预算。
 * 纯函数；不含任何 I/O。
 */
export function formatPersistedOutputEnvelope(input: PersistedOutputEnvelopeInput): string {
  const preview = previewFirstChars(input.content, input.previewChars);
  return [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${input.formatBytes(input.originalBytes)}). Full output saved to: ${input.persistedPath}`,
    "",
    `Preview (first ${input.formatBytes(input.previewChars)}):`,
    preview.preview,
    preview.hasMore ? "..." : undefined,
    PERSISTED_OUTPUT_CLOSE_TAG,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * 判断一段模型可见内容是否已经是落盘信封。
 * 判定口径：以 `<persisted-output>` 开头且包含 `</persisted-output>`（轻量启发式）。
 * 用途：防止二次序列化/再包裹，以及让 hook 追加逻辑识别“正文在磁盘上”。
 * 注意：没有严格解析标签，工具输出本身伪造该标签时会误判；但它只影响展示层，
 * 不改变 artifact 路径或权限决策。
 */
export function isPersistedOutputContent(content: string): boolean {
  return (
    content.startsWith(PERSISTED_OUTPUT_OPEN_TAG) && content.includes(PERSISTED_OUTPUT_CLOSE_TAG)
  );
}

/**
 * 截取前 maxChars 个 UTF-16 code unit 作为预览。
 * 若截断点落在行中间且最后一个换行在预算后半段，则退到换行处，避免预览断在词/行中间。
 * 返回 hasMore 表示原文是否还有未展示部分（仅用于追加 "..."）。
 * 纯函数；不保证按 grapheme cluster 截断，极端情况下可能切到代理对。
 */
function previewFirstChars(
  content: string,
  maxChars: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) return { preview: content, hasMore: false };

  const newlineIndex = content.slice(0, maxChars).lastIndexOf("\n");
  // 为什么要求超过预算一半：过早的换行（如首行很短）会让预览严重缩水，
  // 宁可按硬上限截断，也保留足够的上下文给模型。
  const endIndex = newlineIndex > maxChars * 0.5 ? newlineIndex : maxChars;
  return {
    preview: content.slice(0, endIndex),
    hasMore: true,
  };
}

/** 十进制字节格式化（1 KB=1000 B），仅用于人类可读提示，不参与任何预算计算。 */
function formatDecimalBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}
