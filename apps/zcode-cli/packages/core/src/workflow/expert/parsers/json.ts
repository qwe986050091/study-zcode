/**
 * ============================================================================
 * workflow/expert/parsers/json.ts —— 模型输出 JSON 的容错解析原语
 * ============================================================================
 *
 * 【定位】planner / critic / graph-seed / node-prompts 各解析器共用的一层：
 *   - parsePlannerJson 负责从模型回复里抠出 JSON 主体；
 *   - readLoose* 负责字段名大小写、下划线、驼峰变体的归一化读取；
 *   - 本文件不产出业务对象，也不做 schema 校验（由各 parser 自行 safeParse）。
 *
 * 【失败口径】JSON 语法解析失败是硬错误（抛 Error）；字段缺失或类型不符是
 * 软失败（返回 undefined / 空数组由调用方兜底），两者不可混用，否则畸形模型
 * 输出会被当成"合法的空规划"。
 * ============================================================================
 */

/**
 * 从模型回复文本中提取并解析 JSON。
 * 输入形态按优先级：整体即 JSON → ```json 围栏块 → 首个 '{' 到最后一个 '}' 的片段。
 * 成功返回解析后的 unknown（类型校验由调用方负责）。
 * 失败语义：三种形态都取不到或 JSON.parse 语法错误时抛 Error，绝不返回 null，
 * 以便上层把"模型没给 JSON"计为一次规划失败而不是静默空结果。
 */
export function parsePlannerJson(response: string): unknown {
  const trimmed = response.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error("Workflow planner did not return JSON graph expansion data");
}

/**
 * 判断值是否为普通对象（排除 null 与数组）。
 * 纯类型守卫，无副作用；解析器用它把非对象候选直接判为"不可归一化"。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 字段名归一化：去空白、转小写、删掉所有非字母数字字符。
 * 因此 nodeId / node_id / node-id / Node ID 都会折叠成 nodeid，用于宽松匹配。
 */
function normalizeLooseFieldKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * 按候选键列表读取字段值，先精确匹配、再归一化匹配。
 * 归一化匹配只在精确键全都不存在时启用，避免把含义不同的同形键误读。
 * 返回 unknown；任何情况都不抛错，未命中返回 undefined。
 */
export function readLooseValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }

  const normalizedKeys = new Set(keys.map(normalizeLooseFieldKey).filter(Boolean));
  if (normalizedKeys.size === 0) return undefined;

  for (const [key, value] of Object.entries(record)) {
    if (normalizedKeys.has(normalizeLooseFieldKey(key))) {
      return value;
    }
  }
  return undefined;
}

/**
 * 读取数组字段；值不是数组时返回 undefined 而不是抛错。
 * 调用方通常用 `?? []` 兜底，因此"字段缺失"和"类型写错"都退化为空集合。
 */
export function readLooseArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  const value = readLooseValue(record, keys);
  return Array.isArray(value) ? value : undefined;
}

/**
 * 读取字符串字段并经 stringValue 归一化（trim，空串视为缺失）。
 * 返回 undefined 表示字段不存在、非字符串或只有空白。
 */
export function readLooseString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return stringValue(readLooseValue(record, keys));
}

/**
 * 读取字符串数组字段，逐项 trim 并丢弃非字符串/空白项。
 * 非数组返回 undefined；数组中的无效元素被静默过滤而不是让整批失败。
 */
export function readLooseStringArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  const value = readLooseValue(record, keys);
  if (!Array.isArray(value)) return undefined;
  return value.map(stringValue).filter((item): item is string => item !== undefined);
}

/**
 * 读取布尔字段；只有真正的 boolean 才被接受。
 * 字符串 "true"/"false" 故意不转换，避免模型把语义写错时被悄悄纠正。
 */
export function readLooseBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  const value = readLooseValue(record, keys);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 读取正整数（如集合的 frontierTarget）。
 * 仅接受 number 且为整数且大于 0；浮点、0、负数、字符串数字都按缺失处理。
 */
export function readLoosePositiveInteger(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  const value = readLooseValue(record, keys);
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 把 unknown 收敛为非空字符串：非字符串或 trim 后为空都返回 undefined。
 * 全仓库解析器的"字符串字段口径"以这里为唯一实现，别在调用点另写 trim 判断。
 */
export function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
