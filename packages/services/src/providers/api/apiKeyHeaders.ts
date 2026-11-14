// 职责边界：只负责把用户粘贴的 key 规整成可安全放进 HTTP header 的字符串，不做有效期校验与持久化。
// INV：返回值必为可见 ASCII 前缀，绝不包含非 ASCII 备注，也不保留 Bearer 前缀。
// INV：发送链路必须经由本函数，不得直接透传用户原始输入。
// 改错后果：放宽正则或跳过 ASCII 截断，会让含中文备注的 key 在构造 Authorization 时整条请求失败。
const STRUCTURED_API_KEY_PATTERN = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const HEADER_VISIBLE_ASCII_PREFIX_PATTERN = /^[\x21-\x7e]+/;

export function normalizeApiKeyForHeader(value: string): string {
  // 先去掉首尾空白并剥掉用户自带的 Bearer 前缀；不剥离会让拼出的头变成 Bearer Bearer 双前缀。
  const trimmed = value
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  // 结构化 key 优先整段返回：它形如两段由点分隔的长串，按 ASCII 前缀截取会丢掉后半段。
  const matchedStructuredKey = trimmed.match(STRUCTURED_API_KEY_PATTERN)?.[0];
  if (matchedStructuredKey) {
    return matchedStructuredKey;
  }

  // 非结构化输入才截可见 ASCII 前缀；整串都是非 ASCII 时返回空串，由调用方按无 key 处理。
  const asciiPrefix = trimmed.match(HEADER_VISIBLE_ASCII_PREFIX_PATTERN)?.[0];
  if (!asciiPrefix) {
    return "";
  }

  // 用户复制 API key 时可能把中文备注一并粘进输入框。
  // fetch header value 必须是 ByteString，发送链路统一截取 ASCII key，避免非 ASCII 字符在构造 Authorization 时直接抛错。
  // 前缀可能以空格结尾（中文备注前通常有空格），再 trim 一次才得到干净的 header 值。
  // 失败后果：这里返回空串而不抛错，调用方按「无 key」降级，避免一次脏粘贴阻塞整个请求构造。
  return asciiPrefix.trim();
}
