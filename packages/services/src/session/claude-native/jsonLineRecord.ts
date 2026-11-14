// Claude 原生 JSONL 的单行记录：字段名与取值由外部 CLI 版本决定，本层不做 schema 约束。
// 真正的字段校验在导入 parser 中完成，这里只提供最小读取原语。
export type JsonLineRecord = Record<string, unknown>;

// 判定“纯对象记录”：排除 null 与数组，避免把 JSON 数组误当成一条消息。
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 读取可选字符串：非字符串或空白串统一归为 undefined，防止空串绕过后续必填校验。
export function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
