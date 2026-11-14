// ============================================================
// 模型请求 header 清洗与合并
// 定位：静态 provider 配置里的 header 不能携带请求用途与账号凭据，必须在每次请求前剥离并重写。
// 输入：只读 header 映射（undefined 视作空）。输出：新对象，永不修改入参。
// 副作用：无。失败语义：不抛错；值类型由调用方保证为字符串。
// 不变量：header 名大小写不敏感；同义头只保留最后写入的值，防止 SDK 拼出重复头。
// ============================================================

const MODEL_AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);
export const MODEL_QUERY_SOURCE_HEADER = "x-zcode-query-source";

/**
 * 剥离请求用途头，返回新映射。
 * 输入 undefined 等价于空映射（返回 {}），不会返回 undefined，调用方可直接展开使用。
 */
/** 请求用途由调用上下文拥有，不能从 Provider 静态配置或 SDK 默认 header 继承。 */
export function withoutModelQuerySourceHeader(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== MODEL_QUERY_SOURCE_HEADER,
    ),
  );
}

/**
 * 剥离账号凭据头（authorization / x-api-key，大小写不敏感），返回新映射。
 * 必须在请求期 owner 写入新凭据之前调用，避免残留的静态配置覆盖新票据。
 */
/** 账号认证由请求期 owner 决定，静态默认值和 Personal 配置不能覆盖新凭据。 */
export function withoutModelAuthHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_AUTH_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/**
 * 按优先级从左到右合并（后者覆盖前者，undefined 源视为空）。
 * 每次写入前删除所有大小写等价键，保证同一语义头只出现一次且保留最后提供者的大小写。
 */
/** HTTP 头名不区分大小写；后来的值替换旧值，避免不同大小写被 SDK 拼成重复头。 */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
