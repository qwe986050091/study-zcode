// ============================================================
// RespondToCoordinator Tool Handler
// ============================================================
// 子代理专用：回复拥有它的 coordinator（父 runtime）。
//
// 准入条件：`context.runtimeScope === "subagent"` **且** 存在 coordinatorResponsePort。
// 这是 fail closed 的：普通会话里误配该工具会抛 ConfigurationError（recoverable=false），
// 而不是把消息丢进一个不存在或错误的父队列。
//
// 语义边界：这是"过程中的沟通通道"，不是任务结果。工具描述明确要求模型
// "不要用 assistant 文本当回复""不要拿它替代最终结果"，因为 coordinator 只从
// 端口消息里读取子代理的进展；写成普通正文会被当成最终答复而丢失中间状态。
//
// 副作用：向父 runtime 队列写入一条消息（sideEffectScope=session），可在计划模式使用
// （allowedInPlanMode=true）：通信不改变工作区，也不越权。
// 输出形状：provider schema 只暴露 {success,message}，真正的 responseId/status 由
// runtimeOutputSchema 承载；模型只需知道"是否已排队"。
// ============================================================

import {
  CoreErrorType,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorInputJsonSchema,
  RespondToCoordinatorInputSchema,
  RespondToCoordinatorOutputSchema,
  createCoreError,
  type RespondToCoordinatorInput,
  type RespondToCoordinatorOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

// 模型可见内容的硬上限（4KB）：summary/message 都是短消息口径，正常调用远低于此。
// 同一常量同时喂给 metadata.maxOutputBytes 与 resultBudget，保证"声明上限"和"实际截断"
// 不会漂移；调大它等于放宽模型侧上下文占用，需要同步评估 resultBudget。
const MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES = 4_096;

// provider 侧输出 schema：只暴露模型判断所需的最小形状。
// 为什么不是 runtimeOutputSchema：responseId/status/error 是执行面事实，模型看它们
// 既无决策价值，还会诱导模型复述 id；由 runtimeOutputSchema 承载、经 formatModelContent
// 压缩成一句话。
const RESPOND_TO_COORDINATOR_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

/**
 * 把一条短消息写进"拥有当前子代理的 coordinator"的消息队列。
 *
 * 输入：`summary`（给追踪/日志的一句话摘要）+ `message`（正文），均由 runtime schema 校验。
 * 输出：`RespondToCoordinatorOutput`（responseId / status / error / message），直接取自端口，
 *       本层不做二次加工，保证与父 runtime 的实际投递状态一致。
 * 副作用：向父 runtime 队列追加一条消息，因此属于 session 级副作用（非工作区变更）。
 * 失败语义：准入失败抛 recoverable=false 的 ConfigurationError（fail closed，见下）；
 *       端口自身投递失败由端口返回结构化结果，不在此处 throw。
 * 不变量：每条 tool_call 仍必须产出配对结果，所以即便投递失败也返回 output 而非抛错。
 */
const respondToCoordinatorHandler: ToolHandler = async (input, context) => {
  const parsed = RespondToCoordinatorInputSchema.parse(input) as RespondToCoordinatorInput;

  if (context.runtimeScope !== "subagent" || !context.coordinatorResponsePort) {
    // 为什么：两个条件都不可放宽。端口存在但 scope 不是 subagent，说明是主 agent 误配；
    // 此时投递会把消息塞进错误的父通道。recoverable=false 让错误直接暴露而不是静默重试。
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Coordinator response port is not configured for RespondToCoordinator",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: RESPOND_TO_COORDINATOR_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  // childToolCallId 用于让父 runtime 把这条回复关联回具体的子代理工具调用，
  // 而不是靠 message 文本猜测来源；trace 则保证跨 runtime 的消息可回溯。
  return context.coordinatorResponsePort.respond({
    childToolCallId: context.toolCallId,
    summary: parsed.summary,
    message: parsed.message,
    trace: resolveToolTraceContext(context),
  }) satisfies RespondToCoordinatorOutput;
};

// 工具注册项：把 handler 接入统一执行链路（权限、超时、预算、脱敏、追踪都在 executor 侧）。
// 关键取舍：
//   - shouldDefer=true：该工具只在子代理收到 coordinator 消息后才可能出现，常驻 schema
//     会白占上下文；
//   - allowedInPlanMode=true：通信不改变工作区，越权风险为零，禁用它反而会切断计划阶段的
//     协调通道；
//   - concurrentSafe=true：消息投递幂等语义由端口保证，并行多条回复不互相阻塞；
//   - 超时固定 10s 且 allowCallOverride=false：投递是本地入队，超时只可能来自父 runtime
//     卡死，让模型自调大只会掩盖问题。
export const respondToCoordinatorToolEntry: ToolEntry = {
  capability: "Respond to the coordinator that owns this subagent",
  metadata: {
    shouldDefer: true,
    name: RESPOND_TO_COORDINATOR_TOOL_NAME,
    description: "Respond to the coordinator that owns this subagent.",
    modelInstructions: [
      'When you receive "The coordinator sent a message while you were working:" (or the legacy "Message from coordinator:" prefix), use this tool to answer it.',
      "Use this tool for a concise response or progress update to the coordinator.",
      "When replying while work remains, do not use assistant text as the reply.",
      "Place this call before or alongside the next work tool call when possible.",
      "Continue the current task unless the coordinator explicitly changed or ended it.",
      "Do not use this tool as a substitute for the final task result.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: respondToCoordinatorHandler,
  formatModelContent: formatRespondToCoordinatorModelContent,
  inputSchema: RespondToCoordinatorInputJsonSchema,
  outputSchema: RESPOND_TO_COORDINATOR_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: RespondToCoordinatorInputSchema,
  runtimeOutputSchema: RespondToCoordinatorOutputSchema,
  permission: {
    // 独立权限位（不复用 agent.* 之外的通用写权限）：告警/审计时可精确区分"向父代理发消息"。
    permission: "agent.message.respond",
    reason: "RespondToCoordinator writes a message to the parent runtime queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    // summary/message 进入匹配面，项目规则可以按消息内容做放行或拒绝；
    // alwaysAllow 只按工具名放行，避免每次回复都弹窗。
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    maxModelBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    // 支持取消：用户在子代理等待投递期间按 Esc 应立刻生效；cleanup=none 因为消息要么已入队
    // 要么没有，没有需要回收的中间资源。
    supported: true,
    cleanup: "none",
    userVisibleMessage: "RespondToCoordinator was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    // 只记录 summary，不记录 message：正文可能含较长进展描述，追踪日志只保留定位信息，
    // 避免把子代理完整输出落到 trace 存储。
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * 把运行时输出压成一句模型可读的话。
 * 成功与失败都附上"继续当前任务"的指引，否则模型会把这条通信误读成任务结束信号。
 * 失败分支把 continuation 放在 error 之前：error/message 长度不设限，resultBudget 的
 * head 截断只会切尾部，关键指引必须先出现。
 */
function formatRespondToCoordinatorModelContent(output: unknown): string {
  const result = RespondToCoordinatorOutputSchema.parse(output);
  const continuation =
    "Continue the current task unless the coordinator explicitly changed or ended it.";
  if (result.status === "success") {
    return `Response ${result.responseId} was queued for the coordinator. ${continuation}`;
  }
  // 错误详情无长度上限，continuation 必须放在它之前，避免 resultBudget 截断关键指引。
  return `Response ${result.responseId} failed to queue for the coordinator. ${continuation} Failure: ${result.error ?? result.message}.`;
}

/**
 * 取本次调用的追踪上下文：优先用 context 已注入的 traceContext，缺失时用扁平字段兜底。
 * 为什么兜底：子代理路径上部分适配器只透传 traceId/spanId，不构造完整 TraceContext；
 * 缺少它会让端口消息在父 runtime 侧断链，因此宁可补一个最小对象也不传 undefined。
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
