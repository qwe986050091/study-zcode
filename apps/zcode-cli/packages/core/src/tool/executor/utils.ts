/**
 * 普通对象判定：`typeof object`、非 null、**排除数组**。
 *
 * 注意：与 background-task-output.ts 的私有同名函数不同（那个允许数组）；executor 内部
 * 用它判断"是不是结构化入参记录"，数组入参必须走数组分支处理。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 输入形状摘要：只产出 type/keys/length，**绝不带原始值**（用于权限拒绝事件与日志脱敏）。
 *
 * 口径：`keys` 最多取前 20 个键（顺序即对象自身可枚举顺序）；字符串的 `length` 是
 * JS UTF-16 码元数，不是 UTF-8 字节——这里只求"大概多大"，不参与预算计算。
 * 空值/数组/标量各有固定分支，未知类型只报 `typeof`，不抛错。
 */
export function summarizeInput(input: unknown): Record<string, unknown> {
  if (input === null) return { type: "null" };
  if (Array.isArray(input)) return { type: "array", length: input.length };
  if (typeof input === "object") {
    return {
      type: "object",
      keys: Object.keys(input as Record<string, unknown>).slice(0, 20),
    };
  }
  if (typeof input === "string") return { type: "string", length: input.length };
  return { type: typeof input };
}

/**
 * hook 值的可读预览：字符串原样，其余先 `JSON.stringify`，超过 4000 **字符**截断并加后缀。
 *
 * 口径：这里是字符口径（`serialized.length`），不是字节；用于诊断日志，不参与模型预算。
 * 降级：循环引用/含 BigInt 等导致 stringify 抛错时退回 `String(value)`，保证永不抛。
 */
export function previewHookValue(value: unknown): string {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return "";
    // 注意：4000 是字符数，后缀本身另算，所以最终长度会略超 4000。
    return serialized.length <= 4000 ? serialized : `${serialized.slice(0, 4000)}...[truncated]`;
  } catch {
    return String(value);
  }
}
