// ============================================================
// 失败遥测字段投影（低基数、可聚合）
// 定位：把任意异常折算成状态事件/错误载荷可用的字段（阶段、异常类别、provider 错误码等）。
// 输入：原始 error、已分类 failure、可选 errorPhase。输出：字段对象；取不到的字段省略。
// 副作用：无（纯函数）；不读网络、不写日志。
// 失败语义：任何异常形态都退化为 generic/undefined，绝不因遥测本身抛错。
// 不变量：exceptionKind 只允许低基数枚举，禁止把 provider 自定义异常名写进错误载荷。
// ============================================================

import {
  ModelFailureReason,
  type ModelApiErrorPhase,
  type ModelFailureExceptionKind,
} from "@zcode/contracts";
import { APICallError } from "ai";
import {
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";

const MODEL_API_ERROR_PHASES = new Set<ModelApiErrorPhase>([
  "prepare",
  "configuration",
  "connect",
  "response",
  "stream",
  "parse",
  "validation",
  "unhandled",
]);

/**
 * 从 error.context.errorPhase 读取失败阶段，仅接受白名单内的枚举值。
 * 返回 undefined 表示错误未标注阶段或标注值非法，调用方应视为"未知阶段"而非猜测。
 */
export function readModelFailureErrorPhase(error: unknown): ModelApiErrorPhase | undefined {
  if (!error || typeof error !== "object") return undefined;
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") return undefined;
  const errorPhase = (context as { errorPhase?: unknown }).errorPhase;
  return typeof errorPhase === "string" &&
    MODEL_API_ERROR_PHASES.has(errorPhase as ModelApiErrorPhase)
    ? (errorPhase as ModelApiErrorPhase)
    : undefined;
}

/**
 * 生成终态错误载荷中的归因字段：errorPhase 仅在合法时附加，exceptionKind 必填。
 * 与 modelFailureStatusFields 的区别：这里刻意不带 provider 原文，用于对用户暴露的错误。
 */
export function modelFailureAttributionFields(
  error: unknown,
  failure: ClassifiedModelFailure,
  errorPhase: unknown,
): {
  errorPhase?: ModelApiErrorPhase;
  exceptionKind: ModelFailureExceptionKind;
} {
  // model status 虽然记录了原始异常类型和阶段，但终态 ErrorPayload 曾丢失这些事实；
  // 这里只保留可聚合的低基数类别，避免把 provider 自定义异常名带入错误载荷。
  return {
    ...(typeof errorPhase === "string" &&
    MODEL_API_ERROR_PHASES.has(errorPhase as ModelApiErrorPhase)
      ? { errorPhase: errorPhase as ModelApiErrorPhase }
      : {}),
    exceptionKind: classifyModelFailureExceptionKind(error, failure),
  };
}

/**
 * 归类异常大类：先看失败原因是否属于传输层（网络/代理/失联/空闲超时/超时/TLS），
 * 再看是否带 provider 业务码、是否 APICallError，最后按异常名兜底到 protocol/type/validation/generic。
 * 顺序很关键：同一错误可能同时是 APICallError 与网络错误，传输层判定优先，便于聚合。
 */
function classifyModelFailureExceptionKind(
  error: unknown,
  failure: ClassifiedModelFailure,
): ModelFailureExceptionKind {
  const transportFailure =
    failure.reason === ModelFailureReason.NetworkError ||
    failure.reason === ModelFailureReason.ProxyError ||
    failure.reason === ModelFailureReason.StaleConnection ||
    failure.reason === ModelFailureReason.StreamIdleTimeout ||
    failure.reason === ModelFailureReason.Timeout ||
    failure.reason === ModelFailureReason.TlsError;
  if (transportFailure) return "transport";
  if (findProviderBusinessError(error)) return "provider_business";
  if (APICallError.isInstance(error)) return "api_call";

  const name = errorName(error);
  if (name === "AiSdkModelAdapterError" || name === "ModelProtocolError") return "protocol";
  if (name === "TypeError") return "type_error";
  if (name && /validation|zod|parseerror|jsonparse/iu.test(name)) return "validation";
  return "generic";
}

/** 尽力取异常名：Error 实例优先 name，再退化到构造函数名；非对象返回 undefined。 */
function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || error.constructor.name;
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * 生成状态事件用的更详细字段：错误码、阶段、异常类型名、provider 错误码/消息/requestId、retry-after。
 * 与归因字段不同，这里保留 exceptionType 与 provider 原文，仅供内部状态/诊断，不进用户错误载荷。
 */
export function modelFailureStatusFields(
  error: unknown,
  failure: ClassifiedModelFailure,
  errorPhase: ModelApiErrorPhase,
): {
  errorCode: ClassifiedModelFailure["code"];
  errorPhase: ModelApiErrorPhase;
  exceptionType?: string;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
} {
  return {
    errorCode: failure.code,
    errorPhase,
    exceptionType: exceptionType(error),
    retryAfterMs: failure.retryAfterMs,
    ...inspectProviderFailure(error),
  };
}

/**
 * 按候选顺序从响应头找 provider request id（大小写不敏感），首个非空即返回并截断到 256 字符。
 * 返回 undefined 表示该响应未提供可关联 id，属于正常情况。
 */
export function providerRequestIdFromHeaders(headers: Record<string, string>): string | undefined {
  for (const candidate of [
    "x-request-id",
    "request-id",
    "x-amzn-requestid",
    "x-amz-request-id",
    "cf-ray",
  ]) {
    const value = Object.entries(headers).find(([name]) => name.toLowerCase() === candidate)?.[1];
    if (value?.trim()) return value.trim().slice(0, 256);
  }
  return undefined;
}

/** 异常类型名（截断 128 字符，防止异常名被用作日志注入超长载荷）。 */
function exceptionType(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || error.constructor.name;
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 128);
  }
  return undefined;
}
