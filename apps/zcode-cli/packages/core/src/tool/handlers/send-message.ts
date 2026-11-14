// ============================================================
// SendMessage Tool Handler
// ============================================================
// 定位：主代理与本地子代理之间的显式文字通道。子代理的普通文本输出不会回流给调用方，
// 因此"要不要说"必须变成一次工具调用，而不是靠模型在正文里自言自语。
// 职责：解析入参 → 检查 SubagentPort → 把 (to/summary/message) + 会话/回合/父 toolCallId +
//   工作目录 + trace 交给端口。本文件不做寻址解析、不做投递重试、不落盘消息正文。
// 失败/降级：端口缺席是装配错误（ConfigurationError，不可恢复）；端口正常但投递失败仍以
//   SendMessageOutput 的 status/error 形状返回，让模型能区分"没送到"与"调用本身错了"。
// 副作用：把消息写入目标 agent 的队列（session 作用域），不触达工作区或网络。
// 不变量：`parentToolCallId = context.toolCallId` 是目标侧回答"这条消息谁发的"的唯一依据；
//   trace 必须从当前工具上下文派生，缺席会切断父子链路。

import {
  CoreErrorType,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageInputJsonSchema,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  createCoreError,
  type SendMessageInput,
  type SendMessageOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

// 模型可见结果的字节上限（inline/model/preview 共用）：消息本身很短，4KB 足够回显投递状态。
const MAX_SEND_MESSAGE_MODEL_BYTES = 4096;

const SEND_MESSAGE_PROVIDER_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Refer to local agents by the `agentId` returned in the Agent spawn result. To resume a completed agent, use its `agentId`; it resumes in the background and you'll be notified when it finishes.",
].join("\n");

const SEND_MESSAGE_TOOL_OUTPUT_SCHEMA = {
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
 * 转交实现：schema 解析 + 端口存在性检查 + 字段搬运，不做投递策略。
 *
 * 输入：SendMessageInput（`to` 由调用方给出 agentId，summary/message 是正文）。
 * 输出：SendMessageOutput（status、messageId、delivery/error 等由端口填充）。
 * 副作用：消息进入目标 agent 的队列；同时把 `sessionId/turnId/toolCallId` 作为溯源坐标。
 * 失败语义：端口缺席抛不可恢复配置错误（不是业务失败，重试无意义）；投递层的失败则留在
 *   output 里，由 formatModelContent 措辞，保证每个 tool_call 仍有配对结果。
 */
const sendMessageHandler: ToolHandler = async (input, context) => {
  const parsed = SendMessageInputSchema.parse(input) as SendMessageInput;

  if (!context.subagentPort?.sendMessage) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Subagent port is not configured for SendMessage",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: SEND_MESSAGE_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.subagentPort.sendMessage(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      parentToolCallId: context.toolCallId,
      to: parsed.to,
      summary: parsed.summary,
      message: parsed.message,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    {
      signal: context.abortSignal,
      model: context.model,
      modelOverride: context.subagentModelOverride,
    },
  ) satisfies Promise<SendMessageOutput>;
};

/**
 * SendMessage 的工具声明。
 *
 * 权限：`agent.message.send`，`needsApproval:false` + `sideEffectScope:"session"`——只写
 *   会话内队列，不碰工作区/网络，属于低风险内部通信，不该反复打断用户。
 * 并发：`concurrentSafe:true`，多个 agent 同时发消息互不覆盖；超时固定 10s，不接受覆盖。
 * 预算：4096 字节同时是 inline 与 model 上限，超出按头部截断（状态信息在开头，截尾不丢结论）。
 * 降级：端口不支持时不是本文件兜底，而是 handler 抛配置错误 → error tool_result。
 */
export const sendMessageToolEntry: ToolEntry = {
  capability: "Send a short message to a local agent",
  metadata: {
    shouldDefer: true,
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: "send messages to agent teammates",
    description: SEND_MESSAGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendMessageHandler,
  formatModelContent: formatSendMessageModelContent,
  inputSchema: SendMessageInputJsonSchema,
  outputSchema: SEND_MESSAGE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: SendMessageInputSchema,
  runtimeOutputSchema: SendMessageOutputSchema,
  permission: {
    permission: "agent.message.send",
    reason: "SendMessage writes a message to a local agent queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    maxModelBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SendMessage was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

/**
 * 把投递结果压成一行模型可见文本。优先级：端口给的 `message` > success（delivery 存在时
 * 说明最终状态，否则是 queued）> failed。
 *
 * `agentId` 与 `taskId` 都可能是空（任务式投递只有 taskId），统一回落 "unknown" 而不抛错：
 * 投递结果已经定型，序列化阶段不该再制造一次失败。
 */
function formatSendMessageModelContent(output: unknown): string {
  const result = SendMessageOutputSchema.parse(output);
  if (result.message) return result.message;
  if (result.status === "success") {
    if (result.delivery) {
      return `Message ${result.messageId} was ${result.delivery} for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
    }
    return `Message ${result.messageId} was queued for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
  }
  return `Message ${result.messageId} failed to send to local agent ${result.agentId ?? result.taskId ?? "unknown"}: ${result.error ?? "unknown error"}.`;
}

/**
 * trace 派生：优先复用调用方已归一化的 traceContext（其中 span 已指向本次工具调用）；
 * 缺席时用扁平字段拼一个最小上下文，保证子代理侧仍能把消息挂回同一 trace。
 * 这里不做校验也不生成新 id——凭空造 trace 会产生不可观测的孤立链路。
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
