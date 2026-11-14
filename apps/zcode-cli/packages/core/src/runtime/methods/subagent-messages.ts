/**
 * ============================================================================
 * runtime/methods/subagent-messages.ts —— 子代理回父会话的消息通道
 * ============================================================================
 *
 * 【定位】子代理（通过 RespondToCoordinator 等）主动回话时，消息不能直接写进
 * 父消息历史，而要变成一条 runtime command 排队，由父 runtime 在安全边界消费。
 *
 * 【两阶段】
 *   1) enqueueSubagentMessage：校验 branchGeneration 后入队（priority="next"）；
 *   2) persistSubagentMessageCommand：真正消费时落库为 synthetic user notice
 *      （visibility="model-only"），并按 midTurn 决定 inputPresentation。
 *
 * 【为什么必须校验 branchGeneration】
 *   用户 rewind/fork 之后，旧分支上仍在运行的子代理可能晚到一条回复；
 *   若直接写进父会话，会把"另一个时间线"的内容混进当前对话。
 *   注册表里的 branchGeneration 是子代理出生时的分支，不一致即丢弃并记 debug。
 *
 * 【为什么是 model-only】
 *   这是 agent 间通信，不是用户输入；UI 不应把它显示成用户发言，
 *   但模型必须看到（否则协调回路断裂）。
 * ============================================================================
 */
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId } from "../deps.js";
import { createRuntimeCommandId, type SubagentMessageRuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { EnqueueSubagentMessageInput } from "../types.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { escapeXml } from "../../runtime-task/notification.js";

/**
 * 把子代理回复包成 XML 信封交给模型。
 *
 * 所有字段都 escapeXml：agent 输出的 summary/message 可能包含任意文本，
 * 不转义会破坏信封结构，甚至让模型把内容误读成新的指令块。
 */
export function formatSubagentMessage(input: {
  agentId: string;
  agentType: string;
  summary: string;
  message: string;
}): string {
  return [
    "<subagent-message>",
    `<agent-id>${escapeXml(input.agentId)}</agent-id>`,
    `<agent-type>${escapeXml(input.agentType)}</agent-type>`,
    `<summary>${escapeXml(input.summary)}</summary>`,
    `<message>${escapeXml(input.message)}</message>`,
    "</subagent-message>",
  ].join("\n");
}

/**
 * 把子代理回复排进父 runtime 命令队列。
 *
 * branchGeneration 取值优先用注册表里该 agent 出生时的分支，否则用父当前分支；
 * 只要与父当前分支不一致就丢弃（见文件头 rewind/fork 说明）。
 *
 * 日志里 message 只记长度与 summary 前 200 字符：回复正文可能包含敏感内容，
 * 不应完整落盘。
 */
export function enqueueSubagentMessage(
  this: AgentRuntimeInternal,
  input: EnqueueSubagentMessageInput,
): undefined {
  const branchGeneration =
    this.runtimeTaskRegistry.get(input.agentId)?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    // 不变量 6：子代理出生在旧分支，rewind/fork 后它的回复属于另一条时间线，
    // 必须丢弃。如果放行，模型会看到"已被回退的未来"的子代理结果。
    this.logger?.debug("Dropped stale-branch subagent response", {
      ...traceContextToLogContext(input.traceContext),
      agentId: input.agentId,
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "subagent.response.stale_branch_dropped",
      module: "core.runtime",
      responseId: input.responseId,
    });
    return undefined;
  }
  const command = {
    branchGeneration,
    responseId: input.responseId,
    agentId: input.agentId,
    agentType: input.agentType,
    childSessionId: input.childSessionId,
    childToolCallId: input.childToolCallId,
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    summary: input.summary,
    messageLength: input.message.length,
    traceContext: input.traceContext,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "subagent-message" as const,
    priority: "next" as const,
    source: "subagent_message" as const,
    text: formatSubagentMessage(input),
  } satisfies SubagentMessageRuntimeCommand;

  this.logger?.debug("Subagent response enqueued into runtime command queue", {
    ...traceContextToLogContext(command.traceContext),
    agentId: command.agentId,
    commandId: command.id,
    event: "subagent.response.runtime_enqueued",
    messageLength: command.messageLength,
    module: "core.runtime",
    queueSize: this.runtimeCommandQueue.size() + 1,
    responseId: command.responseId,
    summary: command.summary.slice(0, 200),
  });
  this.enqueueRuntimeCommand(command);
  return undefined;
}

/**
 * 真正消费该命令时，把回复写进父会话的消息历史。
 *
 * midTurn=true 表示当前 turn 仍在运行（这是 steer 式插入），
 * 否则作为下一轮的普通输入。两者用不同 inputPresentation，
 * 让 UI/遥测能区分"打断式回复"与"排队回复"。
 */
export async function persistSubagentMessageCommand(
  this: AgentRuntimeInternal,
  command: SubagentMessageRuntimeCommand,
  midTurn = false,
): Promise<MessageId> {
  await this.ensureContextInitialized(command.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "subagent_reply_steer" : "subagent_reply";
  this.messageHistory.addUser(command.text, runtimeInputMetadata(inputPresentation));
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "subagent_message",
    text: command.text,
    traceContext: command.traceContext,
    // visibility=model-only：这是 agent 间通信，不是用户输入。
    // UI 不应把它显示成用户发言，但模型必须看到（否则协调回路断裂）。
    visibility: "model-only",
    metadata: {
      inputPresentation,
      subagentMessage: {
        responseId: command.responseId,
        agentId: command.agentId,
        agentType: command.agentType,
        childSessionId: command.childSessionId,
        childToolCallId: command.childToolCallId,
        ...(command.parentToolCallId ? { parentToolCallId: command.parentToolCallId } : {}),
      },
    },
  });
  return messageID;
}
