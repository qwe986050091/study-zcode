// ============================================================
// JSON column codecs
// ============================================================
// 定位：SQLite 文本列与 JS 值之间的最小序列化工具，供各仓储统一处理 JSON 列。
// 输入输出：encodeJson 对 undefined/null 返回 null（写入 SQL NULL）；decodeJson
// 对 null 与空串返回 undefined（把“无值”与“空字符串”统一成缺席）。
// 副作用：无。
// 失败语义：非法 JSON 由 JSON.parse 直接抛出，不吞错、不做兜底默认值。
// 类型口径：decodeJson<T> 的 T 只是调用方断言，库里可能残留旧版本的列形状。
// 兼容性：编码结果依赖 JSON.stringify 的字段顺序，不承诺与外部实现逐字节一致。

// 写库前编码：null/undefined 统一落成 SQL NULL，避免存入字符串 "null"。
// 返回字符串（含引号）直接作为 TEXT 绑定参数，调用方不要再次 JSON.stringify。
// 失败语义：循环引用、BigInt 等不可序列化值会抛错，应让所在事务回滚而不是写半条记录。
export function encodeJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// 读库后解码：空值返回 undefined；非空则信任列内容并 cast 为 T（不做 schema 校验）。
// 注意字符串 "null" 会被解析成 null（而非 undefined），与“列无值”的语义不同。
// 不补默认值：字段缺失/多出由上层仓储映射逻辑决定如何兼容。
export function decodeJson<T>(value: string | null): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined;
}
