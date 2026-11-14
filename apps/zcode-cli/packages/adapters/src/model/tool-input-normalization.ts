// ============================================================
// 模型 tool input 归一化（容错解析）
// 定位：SDK 给出的 tool 参数可能是已解析对象，也可能是半截 JSON 文本；此处统一成对象。
// 输入：unknown（undefined/null/空串/字符串/对象）。输出：对象或原值；无法解析时降级 {}。
// 副作用：解析失败写 warn 日志（含 source/toolName/长度，不含原文）。失败语义：绝不抛错。
// 不变量：JSON null 与空串一律视为 {}；参数错误降级为空对象，由工具 schema 决定后续，
// 不能升级为整个模型请求失败。
// ============================================================

import type { Logger } from "@zcode/contracts";

/** 归一化选项：source 区分 generate/stream（日志归因），toolName 仅用于日志。 */
interface NormalizeModelToolInputOptions {
  logger?: Logger;
  source: "generateText" | "streamText";
  toolName?: string;
}

/**
 * 归一化 tool 输入：undefined/空串直接 {}；非字符串原样返回（已是对象）；
 * 字符串先剥 BOM 再 JSON.parse，解析值为 null 视为非法；任何失败都降级 {} 并告警。
 */
export function normalizeModelToolInput(
  input: unknown,
  options: NormalizeModelToolInputOptions,
): unknown {
  if (input === undefined) {
    return {};
  }
  if (input === null) {
    // 上游会先把合法 JSON 字面量 "null" 解析成原生 null；
    // 这里必须与 string parse-null 使用相同恢复语义，且不能伪造原始长度。
    warnAndRecoverMalformedToolInput(new TypeError("Model tool input must not be null"), options, {
      inputType: "null",
    });
    return {};
  }
  if (typeof input !== "string") {
    return input;
  }
  if (input.length === 0) {
    return {};
  }

  try {
    const normalizedInput = JSON.parse(stripByteOrderMark(input));
    if (normalizedInput === null) {
      // JSON null 虽然语法合法，但不能表示工具参数。与 malformed
      // JSON 一样降级为空对象，让既有工具 schema 决定后续结果。
      throw new TypeError("Model tool input must not be null");
    }
    return normalizedInput;
  } catch (error) {
    warnAndRecoverMalformedToolInput(error, options, {
      inputLength: input.length,
    });
    // AI SDK 已提供 final tool-call；此处抛 invalid_model_response
    // 会把参数错误错误地升级为整个模型请求失败。严格解析失败后只降级为
    // 空对象，由普通工具 schema 决定返回 error result 还是继续执行。
    return {};
  }
}

/**
 * 记录一次降级：只写结构化字段（事件名、输入长度或 null 标记、解析错误类型、recovery），
 * 不记录原始输入内容，避免把用户参数写进日志。
 */
function warnAndRecoverMalformedToolInput(
  error: unknown,
  options: NormalizeModelToolInputOptions,
  inputContext: { inputLength: number } | { inputType: "null" },
): void {
  options.logger?.warn("Model tool input JSON normalization failed", {
    event: "model.tool_input.normalize_failed",
    ...inputContext,
    module: "adapters.model.tool-input-normalization",
    parseErrorType: parseErrorType(error),
    recovery: "empty_object",
    source: options.source,
    status: "failed",
    toolName: options.toolName,
  });
}

/** 剥离开头的 UTF-8 BOM（\uFEFF），否则 JSON.parse 会直接失败。 */
function stripByteOrderMark(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

/** 解析错误类型名（如 SyntaxError/TypeError），不可用时退化为 typeof。 */
function parseErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
