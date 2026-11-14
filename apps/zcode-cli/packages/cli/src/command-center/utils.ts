// 按空白切分参数并丢弃空段；首段（子命令/动作）统一转小写，其余保留原大小写以保留路径/模型 id。
export function splitArgs(args: string): string[] {
  return args
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part.toLowerCase() : part));
}

// 单行化并截断文本：折叠所有空白为单空格，超长时保留前 maxLength-3 字符加 "..."；
// 保证输出长度不超过 maxLength（maxLength 过小时下限为 0）。
export function shortText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

// id 短化：长度 ≤18 原样返回，否则保留前 15 字符加 "..."，用于列表副标题展示。
export function shortId(id: string): string {
  return id.length <= 18 ? id : `${id.slice(0, 15)}...`;
}

// 时间格式化：Date/数字/字符串统一转 Date，输出 "YYYY-MM-DD HH:mm"（UTC）；
// 非法时间回退为原始字符串，避免展示 Invalid Date。
export function formatTime(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").slice(0, 16);
}
