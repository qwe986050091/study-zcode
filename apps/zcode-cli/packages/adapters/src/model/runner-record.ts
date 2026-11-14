// ============================================================
// 未知 JSON 值的宽化读取工具（runner-* 系列共用）
// 定位：SDK provider 错误/元数据是 any，本文件把读取收窄成显式口径，避免各调用点各写一套判断。
// 输入输出：全部为纯函数；"取不到"一律返回 undefined 或空对象，永不抛错。
// 副作用：无。失败语义：类型不符即静默丢弃，而不是抛出类型错误。
// 不变量：空字符串不算有效 stringProperty（避免把 "" 当成合法 id/错误码）。
// ============================================================

/**
 * 把未知值宽化为可索引对象；null、原始类型、数组都返回空对象（数组按对象形态暴露下标键）。
 * 返回值始终可安全读取属性，调用方无需再判空。
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 类型守卫：仅排除 null 与原始类型，不排除数组（调用点若需要纯对象需自行再判）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** 读取非空字符串属性；空串视为缺失返回 undefined，避免空错误码/空 id 继续传播。 */
export function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 读取有限数字属性；NaN/Infinity 与非 number 一律 undefined，
 * 因为状态码、耗时、retry-after 等字段若为 NaN 会污染后续比较与日志。
 * record 本身可为 undefined（便于链式访问可选嵌套字段）。
 */
export function numberProperty(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读取字符串元数据；与 stringProperty 不同，允许空串（某些 provider 显式用 "" 表示"无"）。 */
export function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
