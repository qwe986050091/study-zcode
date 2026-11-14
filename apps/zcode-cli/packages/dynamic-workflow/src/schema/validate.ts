// INV-01 违规不抛错：守住位置 validate 的返回；改错故障：中间层用异常中断，后续错误丢失。
// INV-02 根与路径：守住位置 初始 $ 与 root 透传；改错故障：$defs 解析不到根。
// INV-03 ref 先解：守住位置 $ref 分支；改错故障：引用类型被当成空 schema 全部放行。
// INV-04 解不开即报：守住位置 未解析 $ref 的违规；改错故障：悬空引用静默通过。
// INV-05 const 优先：守住位置 const 分支提前返回；改错故障：同一 schema 既比常量又比类型。
// INV-06 enum 深比：守住位置 enum 的逐项深比较；改错故障：对象枚举项按引用比较恒不等。
// INV-07 anyOf 试算：守住位置 分支临时违规列表；改错故障：首个分支失败就整体失败。
// INV-08 类型先判：守住位置 typeMatches 前置检查；改错故障：类型不符仍进入对象与数组检查。
// INV-09 必须项：守住位置 checkObject 的 required；改错故障：缺键不被报告。
// INV-10 额外键：守住位置 additionalProperties 三分支；改错故障：多余键被静默接受。
// INV-11 数组边界：守住位置 minItems 与 maxItems；改错故障：长度越界不报。
// INV-12 元组前缀：守住位置 prefixItems 与 items 衔接；改错故障：rest 元素漏校验。
// INV-13 字符串约束：守住位置 checkString 的 pattern；改错故障：正则不匹配被放过。
// INV-14 数值开闭：守住位置 exclusive 两个分支；改错故障：开区间边界值被当成合法。
// INV-15 报告可读：守住位置 describeValue 截断；改错故障：超长字符串刷屏。
// INV-16 深相等自洽：守住位置 deepEqual 的键集比较；改错故障：多余键的对象被判相等。
// INV-17 defs 限定：守住位置 resolveRef 的匹配式；改错故障：非 $defs 路径被误解析。
// INV-18 子集边界：守住位置 只覆盖发射器产出的关键字；改错故障：误以为这里实现了完整 JSON Schema。
//
// 模块职责：校验生成器产出的 schema 所覆盖的那部分 JSON Schema 子集。
// 状态所有权：无状态；违规列表由调用方持有并在返回后消费。
// 阅读顺序：入口 → 引用与常量 → 联合试算 → 结构检查 → 基础类型 → 辅助函数。
import type { JsonSchema, JsonSchemaType, Violation } from "./types.js";

/**
 * 纯校验器，覆盖范围恰好是 {@link synthesizeAskSchemas} 会发射的 JSON Schema 子集
 * （不是通用 JSON Schema）。产出违规列表，每条设计成可直接进修复用 tool_result：
 * 一行 JSON 路径 + 期望 + 实得。
 *
 * 空 schema `{}`（unknown 的许可式 schema）匹配任意合法 JSON。`$ref` 在传入的根 schema
 * 的 `$defs` 内解析。
 */

// 违规收集到数组里返回，不在中途抛异常。
// 根 schema 一路透传给引用解析。
// 路径从 $ 开始，逐层拼出字段与下标。
//
export function validate(schema: JsonSchema, value: unknown): Violation[] {
  const violations: Violation[] = [];
  check(schema, value, "$", schema, violations);
  return violations;
}

/** 把一条违规格式化为单行：`<path>: expected <expected>, got <got>`。 */
export function formatViolation(violation: Violation): string {
  return `${violation.path}: expected ${violation.expected}, got ${violation.got}`;
}

/** 把违规列表格式化为多行文本（每行一条）。 */
export function formatViolations(violations: readonly Violation[]): string {
  return violations.map(formatViolation).join("\n");
}

function check(schema: JsonSchema, value: unknown, path: string, root: JsonSchema, out: Violation[]): void {
  // 先按 $ref 解引用再递归 check，resolveRef 失败单独记一条 unresolved 违规。
  // resolved 为 undefined 时立即 return，不再对原值做兜底判断。
  // 递归引用由 check 的调用栈深度自然收敛，不另设深度上限。
  if (schema.$ref !== undefined) {
    const resolved = resolveRef(root, schema.$ref);
    if (resolved === undefined) {
      out.push({ expected: `schema ${schema.$ref}`, got: "unresolved $ref", path });
      return;
    }
    check(resolved, value, path, root, out);
    return;
  }

  if ("const" in schema) {
    if (!deepEqual(value, schema.const)) {
      out.push({ expected: describeValue(schema.const as unknown), got: describeValue(value), path });
    }
    return;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      out.push({ expected: `one of ${schema.enum.map((v) => describeValue(v)).join(", ")}`, got: describeValue(value), path });
    }
    return;
  }

  // anyOf 逐个分支试算，任一分枝零违规则 matched 为真。
  // 每个分支用独立 trial 列表试算，失败分支的违规不外泄到 out。
  // 全部失败只 push 一条 one of N variants 聚合违规，避免逐分支刷屏。
  //
  if (schema.anyOf !== undefined) {
    const matched = schema.anyOf.some((branch) => {
      const trial: Violation[] = [];
      check(branch, value, path, root, trial);
      return trial.length === 0;
    });
    if (!matched) {
      out.push({ expected: `one of ${schema.anyOf.length} variants`, got: describeValue(value), path });
    }
    return;
  }

  // 类型不匹配立即记违规并返回，不再下发结构检查。
  // typeName 把联合类型逐项拼接，报告里能看出候选集。
  // 实得值经 describeValue 归一成短串。
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    out.push({ expected: typeName(schema.type), got: describeValue(value), path });
    return;
  }

  if (schema.type === "object") checkObject(schema, value as Record<string, unknown>, path, root, out);
  if (schema.type === "array") checkArray(schema, value as unknown[], path, root, out);
  if (typeof value === "string") checkString(schema, value, path, out);
  if (typeof value === "number") checkNumber(schema, value, path, out);
}

// 先查 required：缺键逐条报告，路径指向该键。
// 已声明属性递归校验，路径继续下钻。
// 未声明键看 additionalProperties：false 拒绝，true 放行。
//
function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string, root: JsonSchema, out: Violation[]): void {
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      out.push({ expected: "present", got: "missing", path: `${path}.${key}` });
    }
  }
  const properties = schema.properties ?? {};
  for (const [key, propValue] of Object.entries(value)) {
    const propSchema = properties[key];
    if (propSchema !== undefined) {
      check(propSchema, propValue, `${path}.${key}`, root, out);
      continue;
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      out.push({ expected: "no additional property", got: describeValue(propValue), path: `${path}.${key}` });
    } else if (additional !== undefined && additional !== true) {
      check(additional, propValue, `${path}.${key}`, root, out);
    }
  }
}

// 长度上下界先判，越界各记一条。
// 有 prefixItems 时按下标逐个校验。
// 超出前缀的部分交给 items，rest 元素不落空。
//
function checkArray(schema: JsonSchema, value: unknown[], path: string, root: JsonSchema, out: Violation[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    out.push({ expected: `at least ${schema.minItems} items`, got: `array(${value.length})`, path });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    out.push({ expected: `at most ${schema.maxItems} items`, got: `array(${value.length})`, path });
  }
  if (schema.prefixItems !== undefined) {
    schema.prefixItems.forEach((itemSchema, index) => {
      if (index < value.length) check(itemSchema, value[index], `${path}[${index}]`, root, out);
    });
    if (schema.items !== undefined) {
      for (let index = schema.prefixItems.length; index < value.length; index += 1) {
        check(schema.items, value[index], `${path}[${index}]`, root, out);
      }
    }
    return;
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => check(schema.items!, item, `${path}[${index}]`, root, out));
  }
}

// 长度上下界与 pattern 三项独立判断。
// pattern 每次现编译，schema 数量有限可接受。
// 违规文本给出期望与实得，便于模型修复。
//
function checkString(schema: JsonSchema, value: string, path: string, out: Violation[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    out.push({ expected: `string length >= ${schema.minLength}`, got: `length ${value.length}`, path });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    out.push({ expected: `string length <= ${schema.maxLength}`, got: `length ${value.length}`, path });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    out.push({ expected: `match /${schema.pattern}/`, got: describeValue(value), path });
  }
}

function checkNumber(schema: JsonSchema, value: number, path: string, out: Violation[]): void {
  if (schema.type === "integer" && !Number.isInteger(value)) {
    out.push({ expected: "integer", got: `number ${value}`, path });
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ expected: `>= ${schema.minimum}`, got: `number ${value}`, path });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ expected: `<= ${schema.maximum}`, got: `number ${value}`, path });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    out.push({ expected: `> ${schema.exclusiveMinimum}`, got: `number ${value}`, path });
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    out.push({ expected: `< ${schema.exclusiveMaximum}`, got: `number ${value}`, path });
  }
}

function typeMatches(type: JsonSchemaType | JsonSchemaType[], value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => matchesOne(candidate, value));
}

function matchesOne(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

function typeName(type: JsonSchemaType | JsonSchemaType[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  if (match === null) return undefined;
  return root.$defs?.[match[1]!];
}

/** JSON 深相等：基础值、数组、纯对象。用于 const/enum 比较。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/** 值的简短描述，用于 got/expected：类型 + 精简取值。 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case "string": {
      const shown = value.length > 20 ? `${value.slice(0, 20)}…` : value;
      return `string ${JSON.stringify(shown)}`;
    }
    case "number":
      return `number ${value}`;
    case "boolean":
      return `boolean ${value}`;
    case "object":
      return "object";
    case "undefined":
      return "undefined";
    default:
      return typeof value;
  }
}
