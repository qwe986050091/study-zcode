// 文本截断的唯一入口，供上下文组装、工具预览等处复用。
// 返回长度不超过 maxChars：maxChars 大于 20 时预留余量追加 "\n...[truncated]"，
// 小于等于 20 时省略标记本身就会超预算，退化为硬切、不追加标记。
// text 为空串时原样返回；maxChars 非正数时返回空串。纯函数，无 IO/副作用。
export function truncateText(text: string, maxChars: number): string {
  // 恰好等于上限不算超限，避免对未超预算的文本追加无意义标记。
  if (text.length <= maxChars) return text;
  // 上限过小时任何标记都会突破预算，只能按原样硬切以保证长度口径。
  if (maxChars <= 20) return text.slice(0, maxChars);
  // 预留 18 字符给省略标记（实际标记 15 字符），确保截断后总长不超过 maxChars。
  return `${text.slice(0, maxChars - 18)}\n...[truncated]`;
}

// 把任意值序列化为字符串：优先 JSON.stringify，失败（循环引用、BigInt 等）时降级 String(value)。
// 只保证"可打印"，不保证可回解析；用于日志与上下文预览，不用于协议传输。
// 无副作用。注意 JSON.stringify 对 undefined/函数返回 undefined，调用方按字符串拼接口径使用。
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // 降级路径保证调用方不会因序列化失败中断预览生成，代价是丢失结构信息。
    return String(value);
  }
}
