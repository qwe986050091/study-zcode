/**
 * 解析 data URL 的媒体类型（只取逗号前的头，不负责正文）。
 *
 * 口径：返回的 mediaType 一律小写；不是 `data:` 前缀或缺少逗号 → undefined；
 * header 为空（如 `data:;base64,`）也视为无效。
 * 刻意宽松：不要求 `;base64` 标记，因为调用点用它做"展示层推断"（TurnStarted 元信息），
 * 真正需要严格校验的路径（pdf/video）另有 isStrictBase64Payload + 各自 header 校验。
 * 无副作用、无异常。
 */
export function parseDataUrlHeader(dataUrl: string): { mediaType: string } | undefined {
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const mediaType = dataUrl.slice("data:".length, commaIndex).split(";", 1)[0]?.trim();
  return mediaType ? { mediaType: mediaType.toLowerCase() } : undefined;
}

/**
 * base64 正文对应的原始字节数（无需解码）。
 *
 * 按 4 字符 → 3 字节换算，并扣除末尾 padding（`==` 2 字节、`=` 1 字节）。
 * 用于"体积上限"判定：如果算上 padding，恰好卡在边界处的合法媒体会被误判超限。
 * 不做合法性校验；非法 payload 的长度结果没有意义，调用前应先过 isStrictBase64Payload。
 * 纯函数，无副作用。
 */
/** base64 正文对应的原始字节数（无需解码）。 */
export function base64PayloadByteLength(payload: string): number {
  // base64 末尾的 padding 不代表内容字节；扣除它，避免上限处的合法媒体被多算 1–2 字节。
  const paddingBytes = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - paddingBytes;
}

/**
 * 严格校验 base64 正文是否合法。
 *
 * 规则：长度必须是 4 的倍数；内容区只允许 A-Z a-z 0-9 + /；padding 只允许出现在末尾且最多 2 个。
 * 空串视为合法（例如允许 0 字节媒体先进入后续"空内容"校验，由调用方给出更精确的错误码）。
 * 用途：video/pdf 的 inline 解析先用它挡掉"带 base64 标记但正文非法"的载荷，避免把垃圾
 * 送进持久化或通用文本分支。纯函数，无副作用。
 */
export function isStrictBase64Payload(payload: string): boolean {
  if (payload.length === 0) return true;
  if (payload.length % 4 !== 0) return false;
  const paddingBytes = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const contentLength = payload.length - paddingBytes;
  for (let index = 0; index < contentLength; index += 1) {
    const code = payload.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = contentLength; index < payload.length; index += 1) {
    if (payload.charCodeAt(index) !== 61) return false;
  }
  return true;
}
