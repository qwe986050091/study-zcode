// ============================================================
// submit_result Tool Handler
// ============================================================
// 工作流 actor（子 AgentRuntime）用它提交本次 ask 的结构化终态结果。handler 把结果交给
// 注入的 WorkflowSubmitPort，阻塞等待引擎裁决：
//   - accept → 返回成功 output；executor 会在成功结果上挂 turnControl 终止本 turn。
//   - reject → 以 ToolHandlerFailure 形式返回违规列表；它成为一条 error tool_result，
//     不带 turnControl，循环继续，模型在同一会话内重试——这就是修复通道。
// 具体 per-ask schema 不进工具声明，而是随 ask 指令的 epilogue 下发（frozen-tool 缓存
// 不变式）；本 handler 只做通用转交，schema 校验由引擎在 port 侧完成。
//
// 不变量（对应总表 #1 与终态收口）：accept 是唯一会挂 turnControl 的结果；reject 必须
// 保留为一条普通 error tool_result，否则模型失去"在同一会话内改到过"的修复通道。
// 并发：`concurrentSafe:false` 让它独占串行组——一个有效提交执行时，晚于它调度的兄弟
// 工具收到合成 ToolCancelled，早于它的先完成，终止语义不需要在调度器里另加机制。

import {
  CoreErrorType,
  SUBMIT_RESULT_TOOL_NAME,
  SubmitResultInputJsonSchema,
  SubmitResultInputSchema,
  SubmitResultOutputJsonSchema,
  SubmitResultOutputSchema,
  createCoreError,
  typedSubmitResultInputSchema,
  type JsonSchema,
  type SubmitResultInput,
  type SubmitResultOutput,
  type SubmitViolation,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

// 模型可见结果的字节上限（inline/model/preview 共用）：accept 只回一句话，reject 的
// 违规列表通常也只有几行，16KB 留足余量。
const MAX_SUBMIT_RESULT_MODEL_BYTES = 16_000;

// reject 的违规列表以此 errorCode 归一化，落到 error tool_result 的 code 字段。
const SUBMIT_RESULT_REJECTED_ERROR_CODE = 1;

/**
 * 通用转交：schema 解析 → 端口 gate → 等待引擎裁决。
 *
 * 输入：SubmitResultInput（`result` 任意 JSON；per-ask 形状由引擎校验）。输出：accept 时
 *   `{status:"accepted"}`；reject 时返回 ToolHandlerFailure（不是抛出）。
 * 副作用：把结果交给 WorkflowSubmitPort，并阻塞到裁决返回（可能任意久，因此无墙钟超时）。
 * 失败语义：端口缺席是装配错误（不可恢复、重试无意义）；reject 是可预期业务失败，
 *   由 call-runner 转成 error tool_result，不带 turnControl，循环继续。
 * 不变量：accept 必须让 executor 的 `stopTurnOnSuccess` 终止 actor 的 turn；reject 绝不能
 *   终止。
 */
const submitResultHandler: ToolHandler = async (input, context) => {
  const parsed = SubmitResultInputSchema.parse(input) as SubmitResultInput;

  // Gate：workflow actor 会话才注入 workflowSubmitPort。不按 runtimeScope 判断——workflow
  // actor 是 taskType "workflow_child"，其 runtimeScope 目前是 "main"；端口存在与否才是
  // 与 taskType 无关的正确判据。
  if (!context.workflowSubmitPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Workflow submit port is not configured for submit_result",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SUBMIT_RESULT_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const verdict = await context.workflowSubmitPort.respond({
    toolCallId: context.toolCallId,
    result: parsed.result,
    trace: resolveToolTraceContext(context),
  });

  if (verdict.accept) {
    return { status: "accepted" } satisfies SubmitResultOutput;
  }

  // reject：以 ToolHandlerFailure 返回，call-runner 将其转成 error tool_result，
  // 违规列表作为 modelContent 存活；不挂 turnControl，循环继续 → 模型在会话内修复重试。
  return submitResultRejection(verdict.violations);
};

/**
 * submit_result 的工具条目。不带 schema = 通用声明（`result` 任意 JSON，per-ask schema 走 ask 尾注）；
 * 带 schema = dwf mono 子代理的 typed 声明（`result` 就是该 actor 唯一的 ask 结果 schema，对该 actor
 * 冻结、跨 ask 不变，因此不破坏缓存前缀），并标 `strict` 资格让 Anthropic adapter 原生约束它。
 * 两者只有 provider 可见的声明与描述不同：handler、权限、并发组、终止语义、预算逐字节相同——
 * 引擎侧校验对两者一致，typed 声明只是让 provider 也看见（并在支持时强制）这份形状。
 */
export function createSubmitResultToolEntry(resultSchema?: JsonSchema): ToolEntry {
  const typed = resultSchema !== undefined;
  return {
    capability: "Submit the structured terminal result for a workflow subagent's ask",
    metadata: {
      shouldDefer: true,
      name: SUBMIT_RESULT_TOOL_NAME,
      description: typed
        ? "Submit the structured result for the current ask. The `result` argument must match this tool's schema."
        : "Submit the structured result for the current ask. The required JSON shape is described in the ask instructions.",
      readOnly: false,
      destructive: false,
      // 载荷性质：声明 concurrentSafe:false，调度器会把它放进独立的串行组。这样一个有效提交
      // （成功即请求终止 turn）执行时，晚于它调度的兄弟工具会收到既有的合成 ToolCancelled，
      // 早于它的先行完成——终止语义无需新增机制。
      concurrentSafe: false,
      // 终态工具：一次有效提交（引擎 accept）就是成功，且必须结束 actor 的 turn。用声明式
      // metadata 表达该内在能力，executor 的通用 withTerminalToolTurnStop 据此在成功结果上挂
      // turnControl，无需在执行点按工具名硬编码，也无需 handler 侧新增 stop 信号通道。
      stopTurnOnSuccess: true,
      maxOutputBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      sideEffectScope: "session",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: submitResultHandler,
    formatModelContent: formatSubmitResultModelContent,
    inputSchema: typed ? typedSubmitResultInputSchema(resultSchema) : SubmitResultInputJsonSchema,
    ...(typed ? { strict: true } : {}),
    outputSchema: SubmitResultOutputJsonSchema,
    // 运行时 zod 校验两者同一份（result 任意 JSON）：per-ask 形状由引擎在端口侧校验并给出可修复的违规。
    runtimeInputSchema: SubmitResultInputSchema,
    runtimeOutputSchema: SubmitResultOutputSchema,
    permission: {
      permission: "workflow.submitResult",
      reason: "submit_result delivers the subagent's terminal result to the workflow engine",
      riskLevel: "low",
      sideEffectScope: "session",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      maxModelBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
      strategy: "truncate",
      preview: {
        maxBytes: MAX_SUBMIT_RESULT_MODEL_BYTES,
        direction: "head",
      },
    },
    // 引擎裁决可能耗时任意长；用 kind:"none" 不设墙钟超时，取消由中止该 tool call（abort）处理。
    timeout: {
      kind: "none",
    },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "submit_result was cancelled before the engine returned a verdict",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}

/** 通用声明的条目（内建工具表里的那一份）。 */
export const submitResultToolEntry: ToolEntry = createSubmitResultToolEntry();

/**
 * reject 的统一出口：errorCode 固定为 1（结构违规），把违规列表整体塞进 message，
 * 让模型看到的是"哪里不对"而不是一个错误码。这里不挂 turnControl，也不带 status 字段。
 */
function submitResultRejection(violations: readonly SubmitViolation[]): ToolHandlerFailure {
  return {
    result: false,
    errorCode: SUBMIT_RESULT_REJECTED_ERROR_CODE,
    message: formatSubmitViolations(violations),
  };
}

// 违规格式与 dynamic-workflow 合成侧一致：一行一条，`<path>: expected <expected>, got <got>`，
// 便于模型逐条对照修复。
function formatSubmitViolations(violations: readonly SubmitViolation[]): string {
  const header = "The submitted result does not match the required schema:";
  if (violations.length === 0) {
    return `${header}\n(no details provided)`;
  }
  const lines = violations.map(
    (violation) => `${violation.path}: expected ${violation.expected}, got ${violation.got}`,
  );
  return [header, ...lines].join("\n");
}

/**
 * 成功结果对模型只回一句 "The result was accepted."——载荷已经进了引擎，重复回显只会
 * 浪费上下文。schema 不匹配时返回固定占位而不抛错：裁决已经完成，序列化失败不该反悔。
 */
function formatSubmitResultModelContent(output: unknown): string {
  const parsed = SubmitResultOutputSchema.safeParse(output);
  if (!parsed.success) return "submit_result returned an invalid result.";
  return "The result was accepted.";
}

/**
 * trace 派生：优先复用已归一化的 traceContext（span 已指向本次工具调用）；缺失时用扁平
 * 字段拼最小上下文，保证引擎侧的裁决日志仍挂在同一 trace 下，而不是各自断开。
 */
function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
