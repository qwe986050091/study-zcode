/**
 * ============================================================================
 * tool/executor/errors.ts —— 工具失败 → ToolExecutionResult 的组装
 * ============================================================================
 *
 * 【定位】工具执行链里的错误最终都要变成一条"成功=false 的 ToolExecutionResult"，
 * 而不是直接抛出：模型需要看到可读的失败原因，turn 仍可继续。
 *
 * 【两层输出】
 *   - modelContent：provider 可见的 <tool_use_error> 文本（仅输入预检失败或
 *     handler 结构化失败时生成；普通异常不塞文本，避免模型把异常当成指令）；
 *   - error：给 UI/日志/恢复的结构化载荷（type/message/code/detail/stack）。
 *
 * 【message 的特殊规则】plan 审批反馈 / workflow refine 反馈必须逐字保留：
 *   它们随后会原样转成 steer 输入，若被摘要器截断，超长反馈就永远不会触发
 *   input_too_large。preserveReasonFormatting 是同一规则的通用开关。
 *
 * 【根因保留】通用错误层不按工具名拼文案（那会反向依赖具体工具），
 *   只用 projectExecutionErrorPayload 从错误链里提取真实 provider/subagent 原因。
 * ============================================================================
 */

import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import { projectExecutionErrorPayload } from "../../errors/error-payload.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolHandlerFailure } from "../types.js";
import { getInitialInputValidationModelContent } from "./validation.js";

/**
 * 把任意错误组装成失败的 ToolExecutionResult。
 *
 * 优先级：
 *   - handlerFailure（CoreError.context.toolHandlerFailure）存在时，
 *     code 用它，modelContent 用它的 message（handler 已经写好了用户可读文案）；
 *   - 输入预检失败 → getInitialInputValidationModelContent；
 *   - 其余 → projectExecutionErrorPayload 的 message/detail。
 * type 用 CoreError.type，普通 Error 用 name（如 AbortError），保持稳定可判断。
 * stack 保留原始栈供排障，但不会进入模型上下文。
 */
export function createErrorResult(
  toolCall: ExecutableToolCall,
  error: Error,
  durationMs?: number,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  const handlerFailure =
    isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure)
      ? error.context.toolHandlerFailure
      : undefined;
  // 根因：通用错误层按 tool name 拼接 provider 文案会反向依赖具体工具。
  // handler 只返回自己的 code/message；这里统一组装 envelope，并保留裸 message 给 UI 和日志。
  const modelContent =
    getInitialInputValidationModelContent(error) ??
    (handlerFailure ? `<tool_use_error>${handlerFailure.message}</tool_use_error>` : undefined);
  // subagent/turn/model 错误常把真实 provider 原因包在 cause 链里；
  // tool result 是父模型和 UI hover 的共同来源，必须在这里统一投影成可读摘要。
  const projectedError = projectExecutionErrorPayload(error);
  const reasonSource =
    isCoreError(error) &&
    (error.context?.reasonSource === "plan_approval_feedback" ||
      error.context?.reasonSource === "workflow_refine_feedback")
      ? error.context.reasonSource
      : undefined;
  // ExitPlanMode / workflow Refine 的用户反馈会暂存在 PermissionDenied.message，
  // 后续还要原样转成 steer 输入；这里不能被展示摘要器截断，否则超长反馈不会触发 input_too_large。
  // 普通拒绝附带的自由文本反馈（preserveReasonFormatting）同理原样保留。
  const message =
    reasonSource !== undefined || options?.preserveReasonFormatting === true
      ? error.message
      : projectedError.message;
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    error: {
      type: isCoreError(error) ? error.type : error.name,
      message,
      // code 优先级:handlerFailure.code > projectedError.code > 无。
      // handlerFailure.code 是工具自己声明的稳定业务码，比通用投影更精确；
      // projectedError.code 是从 cause 链反推的 provider/subagent 码，作为兜底。
      ...(handlerFailure
        ? { code: String(handlerFailure.errorCode) }
        : projectedError.code
          ? { code: projectedError.code }
          : {}),
      // detail 只在投影出结构化详情时附加：纯字符串 message 已经够模型理解，
      // 多余的 detail 会撑大错误事件 payload。
      ...(projectedError.detail ? { detail: projectedError.detail } : {}),
      ...(reasonSource ? { reasonSource } : {}),
      stack: error.stack,
    },
    // modelContent 缺省时不写字段：序列化时 undefined 字段会被省略，
    // 比显式写 undefined 更干净，也避免 UI 把空字符串当成"有内容"渲染。
    ...(modelContent === undefined ? {} : { modelContent }),
    durationMs: durationMs ?? 0,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

/**
 * 把 handler 返回的 ToolHandlerFailure 提升成 CoreError。
 *
 * 用 ToolExecutionFailed + recoverable=true：这类失败（旧串不唯一、文件太大等）
 * 是模型可自行纠正的，不应终止 turn。toolHandlerFailure 放回 context，
 * createErrorResult 会据此还原 code 与 envelope 文案。
 */
export function createToolHandlerFailureError(
  toolCall: ExecutableToolCall,
  failure: ToolHandlerFailure,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, failure.message, {
    context: {
      code: failure.errorCode,
      toolHandlerFailure: failure,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    recoverable: true,
  });
}

/**
 * 运行时形状校验（不是类型断言）：result 必须为 false、errorCode 有限数字、
 * message 为字符串。跨模块/旧版本可能塞进不完整对象，校验失败就当普通错误处理。
 */
export function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  // 运行时形状校验（不是类型断言）：跨模块/旧版本可能塞进不完整对象，
  // 任何一条不满足都不能当作 handler failure，否则会用 undefined 的 code/message 拼错误文案。
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ToolHandlerFailure>;
  // result===false 是"业务失败"的唯一信号：true 表示成功，不能进失败收口；
  // errorCode 必须是有限数字（NaN/Infinity 会让遥测分桶失真）；
  // message 必须是字符串：它会原样进 <tool_use_error> 给模型看。
  return (
    candidate.result === false &&
    typeof candidate.errorCode === "number" &&
    Number.isFinite(candidate.errorCode) &&
    typeof candidate.message === "string"
  );
}

export function isToolHandlerFailureError(error: unknown): boolean {
  return isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure);
}

/**
 * 权限拒绝结果：PermissionDenied + recoverable=true。
 *
 * 拒绝是"用户/策略决定"，不是系统故障：模型应调整方案或请求用户，
 * 而不是把整轮判失败。context 会合并调用方提供的审计字段（toolName 强制覆盖）。
 */
export function createPermissionErrorResult(
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  context: Record<string, unknown>,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  // toolName 强制覆盖调用方 context：审计字段必须反映"被拒绝的真实工具"，
  // 不能让调用方传入的旧名/别名污染拒绝日志与规则归因。
  return createErrorResult(
    toolCall,
    createCoreError(
      CoreErrorType.PermissionDenied,
      reason ?? `Permission denied for ${toolCall.name}`,
      {
        context: {
          ...context,
          toolName: toolCall.name,
        },
        recoverable: true,
      },
    ),
    undefined,
    options,
  );
}
