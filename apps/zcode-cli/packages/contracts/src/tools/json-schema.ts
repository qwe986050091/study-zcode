// ============================================================
// Zod -> provider-neutral JSON Schema for tool contracts
// ============================================================
//
// 这是工具契约的唯一边界转换层：运行时用 zod schema 校验，provider/跨进程侧只看这里产出的
// JSON Schema。任何工具都不得手写第二份 provider schema，否则"模型看到的参数"与"执行侧
// 接受的参数"会分叉。产出刻意是自包含的 JSON Schema 子集（无 $ref/$defs），因为对端可能
// 是远端 provider 或另一进程的最小校验器，无法解析跨文档引用。

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { JsonSchema } from "../model/index.js";

const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
]);
// 所有工具 JSON Schema 统一声明的方言版本。写进每个 schema 的 $schema 字段，让消费方
// （provider、回放校验、录制对比）按同一套 2020-12 语义解释，而不是按各自默认方言猜。
export const TOOL_JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

/**
 * Convert a Zod runtime schema into the JSON Schema subset exposed to model
 * providers. Keep all built-in tool schemas on this path so runtime validation
 * and provider-facing function parameters cannot drift.
 */
// 把 zod 运行时 schema 投影成工具对外的 JSON Schema。选择 $refStrategy:"none" 是为了让
// 结果自包含（跨进程/远端 provider 不能解析引用）；effectStrategy:"input" 表示带
// preprocess/refine 的字段按"输入侧"形状暴露，运行时仍执行变换与精化。转换后统一走
// normalizeToolJsonSchema，再由本函数补 $schema 版本。
export function toToolJsonSchema(schema: ZodTypeAny): JsonSchema {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    effectStrategy: "input",
    target: "jsonSchema7",
  }) as JsonSchema;

  normalizeToolJsonSchema(jsonSchema);
  jsonSchema.$schema = TOOL_JSON_SCHEMA_VERSION;
  return jsonSchema;
}

// 就地规范化一份已生成的 JSON Schema，使其成为 CLI/远端校验器共同支持的子集：
// 剥除引用类键（$id/$ref/$defs 等）、把 anyOf 收敛为 oneOf、补齐可推断的 type，并为
// object/array 补最小合法形状。原地修改并返回同一个对象，调用方不应依赖旧引用被保留。
// 不负责补 $schema——那是 toToolJsonSchema 的职责，手工传入的 schema 需自行保证。
export function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  normalizeSchemaNode(schema);
  return schema;
}

function normalizeSchemaNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeSchemaNode(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const key of STRIPPED_SCHEMA_KEYS) {
    delete value[key];
  }

  if (isRecord(value.properties)) {
    for (const child of Object.values(value.properties)) {
      normalizeSchemaNode(child);
    }
  }

  normalizeSchemaNode(value.items);
  normalizeSchemaNode(value.additionalProperties);
  normalizeSchemaNode(value.oneOf);
  normalizeSchemaNode(value.anyOf);
  normalizeSchemaNode(value.allOf);

  if (Array.isArray(value.anyOf) && value.oneOf === undefined) {
    value.oneOf = value.anyOf;
    delete value.anyOf;
  }

  if (value.type === undefined) {
    const inferredType = inferSchemaType(value);
    if (inferredType) {
      value.type = inferredType;
    }
  }

  const typeValues = Array.isArray(value.type) ? value.type : [value.type];
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    isRecord(value.additionalProperties) &&
    value.propertyNames === undefined
  ) {
    value.propertyNames = { type: "string" };
  }
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    value.additionalProperties === undefined
  ) {
    value.properties = {};
  }
  if (typeValues.includes("array") && value.items === undefined) {
    value.items = {};
  }
}

function inferSchemaType(schema: Record<string, unknown>): string | undefined {
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    return "object";
  }
  if (schema.items !== undefined || typeof schema.minItems === "number" || typeof schema.maxItems === "number") {
    return "array";
  }
  if (Array.isArray(schema.enum)) {
    return inferTypeFromValues(schema.enum);
  }
  if ("const" in schema) {
    return inferTypeFromValues([schema.const]);
  }
  if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
    return "string";
  }
  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") {
    return "number";
  }
  return undefined;
}

function inferTypeFromValues(values: unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => Number.isInteger(value))) return "integer";
  if (values.every((value) => typeof value === "number")) return "number";
  if (values.every((value) => value === null)) return "null";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
