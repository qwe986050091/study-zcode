import type { JsonSchema } from "./types.js";

/**
 * 确定性序列化：把 schema 的对象键递归排序后再 JSON.stringify，保证快照稳定，与发射
 * 时的插入顺序无关。数组（enum/required/prefixItems/anyOf 等）保持原有顺序不动 ——
 * 它们的顺序是有意义的（且由 checker 的属性/成员顺序确定）。
 */

// 把 JsonSchema 规范化后以 2 空格缩进序列化，并强制以单个换行结尾（便于按行 diff 与
// 内容哈希）。按 JSON 语义处理：值为 undefined 的键被 JSON.stringify 直接丢弃，null 保留。
// 无 IO、无缓存；同一输入在任意进程、任意对象插入顺序下输出逐字节相同。
export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(canonicalize(schema), null, 2)}\n`;
}

// 递归规范化：对象按键名排序（默认按 UTF-16 码元序，稳定且与 locale 无关），数组保持
// 原有顺序（enum/required/prefixItems/anyOf 的顺序有语义）。先判数组、再判非 null 对象，
// 避免把 null 当成对象；原始值原样返回。空对象/空数组各自保留形态，不折叠成 null。
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
