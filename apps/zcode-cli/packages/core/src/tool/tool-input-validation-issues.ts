// 这些字段的插入顺序会直接进入 provider-visible JSON fallback，
// 必须保持稳定，不能改成只保证语义等价的通用错误对象。
//
// ============================================================================
// tool/tool-input-validation-issues.ts —— 结构化入参错误 issue 的构造器
// ============================================================================
//
// 【定位】把 schema 校验失败转换成 provider 能识别的一组 issue 形状（对齐 zod 的
//   issue 字段集合）。模型侧按 code/path/expected 精确纠错，UI/日志侧仍消费 legacy
//   errors 文案；两套口径在这里解耦。
//
// 【不变量】字段顺序与可选字段的"有则加、无则省略"必须稳定：序列化后的 JSON 会
//   直接成为 provider-visible fallback，重排字段会改变模型看到的错误形态。
//
// 【失败语义】纯构造器，不抛异常；path 一律做浅拷贝，避免调用方后续修改污染 issue。
// ============================================================================
export type ToolInputValidationPath = Array<string | number>;

export type ToolInputValidationIssue =
  | ToolInputCustomIssue
  | ToolInputInvalidFormatIssue
  | ToolInputInvalidTypeIssue
  | ToolInputInvalidValueIssue
  | ToolInputUnrecognizedKeysIssue
  | ToolInputTooSmallIssue
  | ToolInputTooBigIssue
  | ToolInputInvalidUnionIssue;

export interface ToolInputCustomIssue {
  code: "custom";
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidFormatIssue {
  origin?: "string";
  code: "invalid_format";
  format: string;
  pattern?: string;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidTypeIssue {
  expected: string;
  format?: string;
  code: "invalid_type";
  received?: string;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidValueIssue {
  code: "invalid_value";
  values: unknown[];
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputUnrecognizedKeysIssue {
  code: "unrecognized_keys";
  keys: string[];
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputTooSmallIssue {
  origin: "array" | "number" | "string";
  code: "too_small";
  minimum: number;
  inclusive: boolean;
  exact?: true;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputTooBigIssue {
  origin: "array" | "number" | "string";
  code: "too_big";
  maximum: number;
  inclusive: boolean;
  exact?: true;
  path: ToolInputValidationPath;
  message: string;
}

export interface ToolInputInvalidUnionIssue {
  code: "invalid_union";
  errors: ToolInputValidationIssue[][];
  path: ToolInputValidationPath;
  message: "Invalid input";
}

/**
 * 构造 invalid_type。expected 取 schema 声明的类型（integer 会额外标 format:"safeint"，
 * 与 zod 的整数口径一致）；received 只在特殊数值（NaN/Infinity）时出现，其余类型信息
 * 已写进 message，避免多一个非标准字段。
 */
export function createInvalidTypeIssue(
  value: unknown,
  schemaType: unknown,
  path: ToolInputValidationPath,
): ToolInputInvalidTypeIssue {
  const { expected, format } = expectedType(value, schemaType);
  const received = specialNumberReceived(value);
  const message = `Invalid input: expected ${expected}, received ${formatReceivedType(value)}`;

  // 可选字段按需出现：无 format/received 时保持对象最小，序列化形状才与既有 parser 对齐。
  if (format !== undefined) {
    return {
      expected,
      format,
      code: "invalid_type",
      path: [...path],
      message,
    };
  }
  if (received !== undefined) {
    return {
      expected,
      code: "invalid_type",
      received,
      path: [...path],
      message,
    };
  }
  return {
    expected,
    code: "invalid_type",
    path: [...path],
    message,
  };
}

/**
 * 构造 invalid_value（const/enum 失败）。单值走 "expected X"，多值走 "expected one of"；
 * values 做浅拷贝，防止调用方继续改 enum 数组影响已产生的 issue。
 */
export function createInvalidValueIssue(
  values: unknown[],
  path: ToolInputValidationPath,
): ToolInputInvalidValueIssue {
  return {
    code: "invalid_value",
    values: [...values],
    path: [...path],
    message:
      values.length === 1
        ? `Invalid input: expected ${formatIssueValue(values[0])}`
        : `Invalid option: expected one of ${formatIssueValues(values, "|")}`,
  };
}

/**
 * 构造 unrecognized_keys（additionalProperties:false 时触发）。message 按数量做单复数，
 * keys 保持原顺序并浅拷贝，供客户端精确高亮多余字段。
 */
export function createUnrecognizedKeysIssue(
  keys: string[],
  path: ToolInputValidationPath,
): ToolInputUnrecognizedKeysIssue {
  return {
    code: "unrecognized_keys",
    keys: [...keys],
    path: [...path],
    message: `Unrecognized key${keys.length > 1 ? "s" : ""}: ${formatIssueValues(keys, ", ")}`,
  };
}

/**
 * 构造 too_small。origin 决定 message 的单位（characters/items/无单位）；inclusive 默认
 * true（>=），false 表示严格 >。exact 只用于"必须恰好等于下限"的 schema，不能把
 * inclusive 的默认值误当精确约束。
 */
export function createTooSmallIssue(
  origin: ToolInputTooSmallIssue["origin"],
  minimum: number,
  path: ToolInputValidationPath,
  options: { exact?: boolean; inclusive?: boolean } = {},
): ToolInputTooSmallIssue {
  const inclusive = options.inclusive ?? true;
  return {
    origin,
    code: "too_small",
    minimum,
    inclusive,
    ...(options.exact === true ? { exact: true as const } : {}),
    path: [...path],
    message: formatSizeIssueMessage("too_small", origin, minimum, inclusive),
  };
}

/**
 * 构造 too_big。语义与 createTooSmallIssue 对称：inclusive 默认 true（<=），false 为严格 <，
 * origin 决定单位；exact 仅在 schema 表达"恰好等于上限"时出现。
 */
export function createTooBigIssue(
  origin: ToolInputTooBigIssue["origin"],
  maximum: number,
  path: ToolInputValidationPath,
  options: { exact?: boolean; inclusive?: boolean } = {},
): ToolInputTooBigIssue {
  const inclusive = options.inclusive ?? true;
  return {
    origin,
    code: "too_big",
    maximum,
    inclusive,
    ...(options.exact === true ? { exact: true as const } : {}),
    path: [...path],
    message: formatSizeIssueMessage("too_big", origin, maximum, inclusive),
  };
}

/**
 * 构造 invalid_union（oneOf/联合类型失败）。errors 按候选分支分组保留，调用方必须能看到
 * 每个分支为什么失败；message 固定为 "Invalid input"（细节在 errors 里，不再重复）。
 */
export function createInvalidUnionIssue(
  errors: ToolInputValidationIssue[][],
  path: ToolInputValidationPath,
): ToolInputInvalidUnionIssue {
  return {
    code: "invalid_union",
    errors,
    path: [...path],
    message: "Invalid input",
  };
}

/**
 * 构造 custom（工具自定义的业务校验错误）。message 直接展示给模型，必须写"哪里错、怎么改"；
 * 不要用它替代 schema 的类型/范围问题，否则会丢失结构化 path/code。
 */
export function createCustomIssue(
  message: string,
  path: ToolInputValidationPath,
): ToolInputCustomIssue {
  return {
    code: "custom",
    path: [...path],
    message,
  };
}

/**
 * 构造 invalid_format（字符串格式失败，如 url/date）。format 是稳定的机器可读标识，
 * message 是人读解释；pattern 只在有显式正则约束时出现，避免把实现细节泄给模型。
 */
export function createInvalidFormatIssue(
  format: string,
  message: string,
  path: ToolInputValidationPath,
  options: { origin?: "string"; pattern?: string } = {},
): ToolInputInvalidFormatIssue {
  return {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    code: "invalid_format",
    format,
    ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
    path: [...path],
    message,
  };
}

// integer 的 expected 文案与 format 特判：有限 number 标 safeint，非数字仍报 number，
// 这样模型能区分"类型不对"与"整数但不安全"。
function expectedType(value: unknown, schemaType: unknown): { expected: string; format?: string } {
  if (schemaType === "integer") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return { expected: "int", format: "safeint" };
    }
    return { expected: "number" };
  }
  return { expected: String(schemaType) };
}

// JSON 无法表达 NaN/Infinity，但上游可能送来；单独标 received，避免它们被当成普通 number。
function specialNumberReceived(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return "Infinity";
  return undefined;
}

function formatSizeIssueMessage(
  code: "too_big" | "too_small",
  origin: ToolInputTooBigIssue["origin"],
  limit: number,
  inclusive: boolean,
): string {
  const comparison = code === "too_big" ? (inclusive ? "<=" : "<") : inclusive ? ">=" : ">";
  const label = code === "too_big" ? "Too big" : "Too small";
  const unit = origin === "string" ? "characters" : origin === "array" ? "items" : undefined;
  if (unit) {
    return `${label}: expected ${origin} to have ${comparison}${limit.toString()} ${unit}`;
  }
  return `${label}: expected ${origin} to be ${comparison}${limit.toString()}`;
}

function formatIssueValues(values: unknown[], separator: string): string {
  return values.map(formatIssueValue).join(separator);
}

function formatIssueValue(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return `"${value}"`;
  return `${String(value)}`;
}

function formatReceivedType(value: unknown): string {
  const valueType = typeof value;
  if (valueType === "number") return Number.isNaN(value) ? "NaN" : "number";
  if (typeof value === "object") {
    if (Array.isArray(value)) return "array";
    if (value === null) return "null";
    if (Object.getPrototypeOf(value) !== Object.prototype && value.constructor) {
      return value.constructor.name;
    }
  }
  return valueType;
}
