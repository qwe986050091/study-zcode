// INV-01 双输出：守住位置 收集器结构；改错故障：只产 errors，模型无法按路径纠错。
// INV-02 顺序分层：守住位置 legacy 与 issues 的生成次序；改错故障：参数回退顺序与解析器分叉。
// INV-03 空 schema 放行：守住位置 入口判断；改错故障：未写 schema 的工具被全线拒绝。
// INV-04 纯校验：守住位置 全部校验函数；改错故障：校验过程抛异常或改写入参。
// INV-05 缺失即缺省值：守住位置 required 分支；改错故障：缺失字段被误报成类型错误。
// INV-06 oneOf 互斥：守住位置 命中数判断；改错故障：命中多个候选仍判通过。
// INV-07 候选问题全留：守住位置 联合类型收集；改错故障：模型看不到其他分支失败原因。
// INV-08 类型短路：守住位置 类型不符返回；改错故障：派生错误刷屏，掩盖真实问题。
// INV-09 值约束优先：守住位置 valueConstraintFailed 标记；改错故障：值不合法被重复归为类型错误。
// INV-10 只认显式拒绝：守住位置 additionalProperties 判断；改错故障：未知字段在缺省下被误拒。
// INV-11 properties 顺序：守住位置 缺失字段问题生成；改错故障：序列化顺序与解析器不一致。
// INV-12 元素先于长度：守住位置 数组问题追加位置；改错故障：长度问题排到元素问题之前。
// INV-13 联合类型：守住位置 matchesType 数组分支；改错故障：联合类型只尝试第一个候选。
// INV-14 整数语义：守住位置 integer 分支；改错故障：带小数的值被当作整数通过。
// INV-15 有限数值：守住位置 number 分支；改错故障：NaN 与 Infinity 通过数值校验。
// INV-16 未知类型放行：守住位置 matchesType 默认分支；改错故障：陌生关键字让全部输入失败。
// INV-17 缺失问题推导：守住位置 createMissingPropertyIssues；改错故障：缺失字段报成未知类型。
// INV-18 类型推断保守：守住位置 inferSchemaType；改错故障：无 schema 的字段被推断成对象。
//
// 模块职责：按工具契约需要的子集校验 JSON Schema，并产出两套错误视图。
// 状态所有权：无状态；收集器随调用创建，不跨调用复用。
// 阅读顺序：入口 → 递归分发 → 对象与数组 → 标量 → 类型判定辅助。
// ============================================================
// Minimal JSON Schema validator for tool contract boundaries
// ============================================================
//
// 【定位】只实现工具契约需要的 JSON Schema 子集（type/const/enum/oneOf/required/
//   properties/additionalProperties/items/length/大小约束），不追求完整规范。
//
// 【双输出口径】同时产出两份结果：
//   errors —— 人读的 legacy 字符串，保持原有顺序与文案（日志/UI 诊断依赖它）；
//   issues —— 结构化的 provider-visible 参数问题，供模型按 path/类型精确纠错。
//   两者顺序刻意不同：结构化 issues 按 properties 顺序或"元素问题先于数组长度问题"
//   生成，以匹配 schema parser 的稳定顺序；legacy errors 不因此重排。
//
// 【失败语义】纯校验、不抛异常；空 schema 视为无约束。value 为 undefined 表示字段
//   缺失，由 required 分支决定是 missing 还是 invalid_type。
// ============================================================

import type { JsonSchema } from "@zcode/contracts";
import {
  createInvalidTypeIssue,
  createInvalidUnionIssue,
  createInvalidValueIssue,
  createTooBigIssue,
  createTooSmallIssue,
  createUnrecognizedKeysIssue,
  type ToolInputValidationIssue,
  type ToolInputValidationPath,
} from "./tool-input-validation-issues.js";

export type {
  ToolInputValidationIssue,
  ToolInputValidationPath,
} from "./tool-input-validation-issues.js";

interface JsonSchemaValidationResult {
  valid: boolean;
  errors: string[];
  issues: ToolInputValidationIssue[];
}

interface ValidationCollector {
  errors: string[];
  issues: ToolInputValidationIssue[];
}

/**
 * 按工具契约的子集校验一个值。
 *
 * @returns valid 等价于 errors 为空；errors 是 legacy 文案，issues 是结构化问题。
 * @sideEffect 无；不修改 value，也不读外部状态。
 * @note 空 schema `{}` 与 undefined 都表示"无约束"，直接通过——这是工具可以不写
 *   schema 的兼容路径，不应被当成漏校验。
 */
// 空 schema 与缺省都表示无约束，直接通过。
// 命令式执行后统一组装两份结果，valid 等价于 errors 为空。
// 校验是纯函数，不修改入参，也不读外部状态。
// issues 与 errors 顺序刻意不同，各自服务不同消费方。
//
export function validateJsonSchemaValue(
  value: unknown,
  schema: JsonSchema | undefined,
): JsonSchemaValidationResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, errors: [], issues: [] };
  }

  const collector: ValidationCollector = {
    errors: [],
    issues: [],
  };
  validateNode(value, schema, "$", [], collector);
  return {
    valid: collector.errors.length === 0,
    errors: collector.errors,
    issues: collector.issues,
  };
}

// validateNode 递归承担 properties / items / allOf 等全部分发，collector 一路下传。
// displayPath 供人读文案，issuePath 供结构化问题定位。
// 收集器一路下传，避免返回值层层合并。
//
function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  // oneOf 语义是恰好命中一个，零个与多个都失败。
  // 每个候选独立收集，失败候选的问题全部保留。
  // 候选内部路径从根重算，避免把外层路径带进分支。
  //
  const oneOf = asSchemaArray(schema.oneOf);
  if (oneOf) {
    const candidates = oneOf.map((candidate) => {
      const candidateCollector: ValidationCollector = {
        errors: [],
        issues: [],
      };
      validateNode(value, candidate, "$", [], candidateCollector);
      return candidateCollector;
    });
    // oneOf 语义是"恰好命中一个"：0 个与多个都算失败，且每个候选的错误都要保留，
    // 否则模型无法判断该往哪个 union 分支修。
    const matches = candidates.filter((candidate) => candidate.errors.length === 0);
    if (matches.length !== 1) {
      collector.errors.push(
        `${displayPath} must match exactly one oneOf schema, matched ${matches.length}`,
      );
      collector.issues.push(
        createInvalidUnionIssue(
          candidates.map((candidate) => candidate.issues),
          issuePath,
        ),
      );
    }
    return;
  }

  // const/enum 先判：它们表达的是"值不合法"，优先于类型错误归类。
  let valueConstraintFailed = false;
  if ("const" in schema && !Object.is(value, schema.const)) {
    collector.errors.push(`${displayPath} must be ${JSON.stringify(schema.const)}`);
    collector.issues.push(createInvalidValueIssue([schema.const], issuePath));
    valueConstraintFailed = true;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && !enumValues.some((item) => Object.is(item, value))) {
    collector.errors.push(
      `${displayPath} must be one of ${enumValues.map((item) => JSON.stringify(item)).join(", ")}`,
    );
    collector.issues.push(createInvalidValueIssue(enumValues, issuePath));
    valueConstraintFailed = true;
  }

  // 类型不符时直接返回：继续往下校验 properties/items 只会产生一串误导性的派生错误。
  // 类型不符立即返回，继续下钻只会产生误导性派生错误。
  // enum / const 与推导出的 type 同时存在时按两条独立规则各报一次，不因为类型已匹配就跳过值约束。
  // 类型为数组时按联合类型逐个尝试匹配。
  //
  const type = schema.type;
  if (type !== undefined && !matchesType(value, type)) {
    collector.errors.push(`${displayPath} must be ${formatSchemaType(type)}`);
    // provider JSON Schema 会同时包含 enum/const 与推导出的 type，但目标
    // 校验行为在值约束失败时只产生 invalid_value；保留 legacy errors，同时避免
    // 重复的 invalid_type 改变 provider-visible 参数错误分类。
    if (!valueConstraintFailed) {
      if (Array.isArray(type)) {
        collector.issues.push(
          createInvalidUnionIssue(
            type.map((candidate) => [createInvalidTypeIssue(value, candidate, [])]),
            issuePath,
          ),
        );
      } else {
        collector.issues.push(createInvalidTypeIssue(value, type, issuePath));
      }
    }
    return;
  }

  if (typeof value === "string") {
    validateString(value, schema, displayPath, issuePath, collector);
  }

  if (typeof value === "number") {
    validateNumber(value, schema, displayPath, issuePath, collector);
  }

  if (Array.isArray(value)) {
    validateArray(value, schema, displayPath, issuePath, collector);
  }

  if (isRecord(value)) {
    validateObject(value, schema, displayPath, issuePath, collector);
  }
}

// required 缺失先进 legacy errors，保持原有文案顺序。
// 结构化的缺失字段按 properties 顺序生成。
// 未声明在 properties 里的 required 单独补一条类型问题。
// 只有显式 additionalProperties 为 false 才拒绝未知字段。
//
function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredSet = new Set(required);
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      collector.errors.push(`${displayPath}.${key} is required`);
    }
  }

  // 先按 properties 声明顺序生成缺失字段的 issues，再校验已存在字段；
  // 这样参数 fallback 序列化后的顺序与 schema parser 一致（legacy errors 不受影响）。
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) {
      if (requiredSet.has(key)) {
        // 参数 fallback 会原样序列化 issues；必须像 schema parser 一样按
        // properties 顺序生成，不能把所有 required 问题提前到已有字段的约束问题之前。
        collector.issues.push(
          ...createMissingPropertyIssues(isRecord(propertySchema) ? propertySchema : undefined, [
            ...issuePath,
            key,
          ]),
        );
      }
      continue;
    }
    if (!isRecord(propertySchema)) continue;
    validateNode(
      value[key],
      propertySchema,
      `${displayPath}.${key}`,
      [...issuePath, key],
      collector,
    );
  }

  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
    if (!(key in value) || value[key] === undefined) {
      collector.issues.push(createInvalidTypeIssue(undefined, "unknown", [...issuePath, key]));
    }
  }

  // 只有显式 additionalProperties:false 才拒绝未知字段；缺省保持 JSON Schema 的宽松语义。
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    const unexpectedKeys: string[] = [];
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        collector.errors.push(`${displayPath}.${key} is not allowed`);
        unexpectedKeys.push(key);
      }
    }
    if (unexpectedKeys.length > 0) {
      collector.issues.push(createUnrecognizedKeysIssue(unexpectedKeys, issuePath));
    }
  }
}

// 长度问题先记进 legacy errors，保持原有顺序。
// 元素校验先执行，长度问题最后追加。
// 这样结构化问题与 schema 解析器的顺序一致。
//
function validateArray(
  value: unknown[],
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  let minimumIssue: ToolInputValidationIssue | undefined;
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    collector.errors.push(`${displayPath} must contain at least ${schema.minItems} items`);
    minimumIssue = createTooSmallIssue("array", schema.minItems, issuePath);
  }
  let maximumIssue: ToolInputValidationIssue | undefined;
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    collector.errors.push(`${displayPath} must contain at most ${schema.maxItems} items`);
    maximumIssue = createTooBigIssue("array", schema.maxItems, issuePath);
  }

  if (isRecord(schema.items)) {
    value.forEach((item, index) => {
      validateNode(
        item,
        schema.items as Record<string, unknown>,
        `${displayPath}[${index}]`,
        [...issuePath, index],
        collector,
      );
    });
  }

  // parser 会先产生元素问题，再产生数组自身的长度问题；legacy errors
  // 仍保持原顺序，只调整 provider-visible issues，避免改变 UI / 日志诊断。
  // 因此先逐个校验 items（上面），最后才追加 min/maxItems 的 issue。
  if (minimumIssue) collector.issues.push(minimumIssue);
  if (maximumIssue) collector.issues.push(maximumIssue);
}

// 最小与最大长度各自独立上报，可同时命中。
// minLength 与 maxLength 同时越界时两条 issue 都进 issues，不做去重也不合并成一条。
//
function validateString(
  value: string,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    collector.errors.push(`${displayPath} must be at least ${schema.minLength} characters`);
    collector.issues.push(createTooSmallIssue("string", schema.minLength, issuePath));
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    collector.errors.push(`${displayPath} must be at most ${schema.maxLength} characters`);
    collector.issues.push(createTooBigIssue("string", schema.maxLength, issuePath));
  }
}

// minimum 与 maximum 各自独立判断，两个边界都越界时各报一条。
// 数值边界不影响类型归属，只报范围问题。
//
function validateNumber(
  value: number,
  schema: Record<string, unknown>,
  displayPath: string,
  issuePath: ToolInputValidationPath,
  collector: ValidationCollector,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    collector.errors.push(`${displayPath} must be >= ${schema.minimum}`);
    collector.issues.push(createTooSmallIssue("number", schema.minimum, issuePath));
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    collector.errors.push(`${displayPath} must be <= ${schema.maximum}`);
    collector.issues.push(createTooBigIssue("number", schema.maximum, issuePath));
  }
}

function createMissingPropertyIssues(
  propertySchema: Record<string, unknown> | undefined,
  path: ToolInputValidationPath,
): ToolInputValidationIssue[] {
  if (propertySchema) {
    const collector: ValidationCollector = {
      errors: [],
      issues: [],
    };
    validateNode(undefined, propertySchema, "$", path, collector);
    if (collector.issues.length > 0) return collector.issues;
  }

  return [createInvalidTypeIssue(undefined, inferSchemaType(propertySchema), path)];
}

function inferSchemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "unknown";
  if (typeof schema.type === "string") return schema.type;
  if (isRecord(schema.properties) || Array.isArray(schema.required)) return "object";
  if (isRecord(schema.items)) return "array";
  return "unknown";
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) {
    return type.some((item) => matchesType(value, item));
  }

  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function asSchemaArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const schemas = value.filter(isRecord);
  return schemas.length === value.length ? schemas : undefined;
}

function formatSchemaType(type: unknown): string {
  if (Array.isArray(type)) {
    return type.map((item) => String(item)).join(" or ");
  }
  return String(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
