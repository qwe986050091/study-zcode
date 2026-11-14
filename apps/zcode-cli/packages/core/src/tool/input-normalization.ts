// ============================================================================
// tool/input-normalization.ts —— 工具入参进入 executor 前的统一归一化
// ============================================================================
//
// 【职责】模型适配器、hook、权限 broker 都可能把入参以 JSON 字符串而非对象的形式送来；
//   这里先安全地 JSON.parse，再用工具声明的 runtimeInputSchema 做一次 safeParse，
//   把默认值/预处理/类型收窄后的结果交给下游。
//
// 【失败语义】解析失败不抛错，只记 warn 并保留原值——让后续 schema 校验把它变成一条
//   可恢复的业务失败，而不是在 executor 拿到结果之前就崩掉（不变量1：必须能配对结果）。
//   runtime schema 失败时保留原始输入，并附带 issues 供上层投影更完整的错误。
//
// 【为什么保留两份错误】runtime schema 已做完默认值与 preprocess；若失败时丢掉它、
//   让 JSON Schema 重新校验，会得到一份不完整且顺序不同的报错。
// ============================================================================

import type { Logger } from "@zcode/contracts";
import type { ToolEntry } from "./types.js";

interface NormalizeToolExecutionInputOptions {
  entry: ToolEntry;
  input: unknown;
  logger?: Logger;
  source: "initial" | "hook" | "permission";
}

export type RuntimeInputValidationIssue = Readonly<Record<string, unknown>>;

export interface PreparedInitialToolExecutionInput {
  input: unknown;
  runtimeValidationIssues?: readonly RuntimeInputValidationIssue[];
}

type SafeParseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error?: unknown };

interface SafeParseSchema<T = unknown> {
  safeParse(value: unknown): SafeParseResult<T>;
}

// Note: some model adapters and hook/broker paths can surface tool
// inputs as JSON strings instead of objects. We normalize safely here so bad
// input degrades into a recoverable validation error rather than crashing the
// executor before it can return a structured tool failure.
/**
 * 归一化后只取入参本身，丢弃 runtime 校验 issues。
 * 用于不需要把 issues 再投影给模型的路径；失败时仍返回可继续校验的原始值，不 throw。
 */
export function normalizeToolExecutionInput(
  options: NormalizeToolExecutionInputOptions,
): unknown {
  return prepareToolExecutionInput(options).input;
}

/**
 * 首次准入路径（source="initial"）：除入参外还返回 runtime schema 的 issues，
 * 供 call-runner 在 schema 失败时给出更完整的 invalid_value/invalid_type 分类。
 */
export function prepareInitialToolExecutionInput(
  options: Omit<NormalizeToolExecutionInputOptions, "source">,
): PreparedInitialToolExecutionInput {
  return prepareToolExecutionInput({ ...options, source: "initial" });
}

function prepareToolExecutionInput(
  options: NormalizeToolExecutionInputOptions,
): PreparedInitialToolExecutionInput {
  const jsonNormalized = normalizeTopLevelJsonString(options.input, options);
  const runtimeSchema = asSafeParseSchema(options.entry.runtimeInputSchema);
  // 没有 runtime schema 时直接放行：inputSchema 的校验由后续 validateInput/JSON Schema 负责。
  if (!runtimeSchema) {
    return { input: jsonNormalized };
  }

  const parsed = runtimeSchema.safeParse(jsonNormalized);
  if (!parsed.success) {
    // runtime schema 已经完成默认值、preprocess 和约束判断；失败时若只
    // 返回 raw input，后续 JSON Schema 会重新推导一份不完整且顺序不同的错误。
    const runtimeValidationIssues = readRuntimeValidationIssues(parsed.error);
    return {
      input: jsonNormalized,
      ...(runtimeValidationIssues.length === 0 ? {} : { runtimeValidationIssues }),
    };
  }

  return { input: parsed.data };
}

function normalizeTopLevelJsonString(
  input: unknown,
  options: NormalizeToolExecutionInputOptions,
): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    // 故意吞掉解析异常：这里只是"尽力还原对象"，真正的入参合法性由 schema 校验判定。
    options.logger?.warn("Tool execution input JSON normalization failed", {
      event: "tool.input.normalize_failed",
      inputLength: input.length,
      module: "core.tool.input-normalization",
      source: options.source,
      status: "failed",
      toolName: options.entry.metadata.name,
    });
    return input;
  }
}

/**
 * 结构性地识别 zod 风格 schema：只要求存在 safeParse 函数，避免 core 直接依赖具体 schema 库。
 * 不是 schema 的运行时值（如字符串）会返回 undefined，让上层跳过二次校验。
 */
function asSafeParseSchema(value: unknown): SafeParseSchema | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const safeParse = (value as { safeParse?: unknown }).safeParse;
  return typeof safeParse === "function" ? ({ safeParse } as SafeParseSchema) : undefined;
}

/**
 * 从 safeParse 的 error 里抽取可序列化的 issue 对象；结构不符（无 issues 数组）时返回空，
 * 保证归一化层永不因错误形态异常而抛出。
 */
function readRuntimeValidationIssues(error: unknown): RuntimeInputValidationIssue[] {
  if (!error || typeof error !== "object") return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is RuntimeInputValidationIssue =>
      typeof issue === "object" && issue !== null && !Array.isArray(issue),
  );
}
