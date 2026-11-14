// 子 Agent transcript 投影模块：把持久化快照与实时会话事件归约为与主会话同构的消息模型。
// 边界：只维护详情视图的本地投影（消息、流式文本、工具反查表），不读主会话状态、不做 IO。
// 口径：事件按 sessionId 与 sequenceNumber 严格过滤，乱序/重复/工具镜像事件一律丢弃。
// 失败语义：不抛异常；未知事件类型原样返回状态，调用方可安全传入全量事件流。
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type React from "react";
import type { Message } from "./app-model.js";
import { applyModelStreamingEvent } from "./app-model-streaming.js";
import { applyToolTranscriptEvent } from "./app-tool-transcript.js";
import { appendAgentResult } from "./app-submit.js";
import { finalizeStreamProjectedMessages } from "./app-transcript-stream.js";
import { isSubagentToolMirror } from "./app-subagent-events.js";
import type { TuiSubagentTranscriptSnapshot } from "./types.js";

// 子 Agent transcript 的本地投影状态：与主会话消息模型同构，但独立维护。
// sessionId 限定事件归属；sequenceNumber 为已应用的最大事件序号，用于丢弃乱序/重复事件。
// messages 为已持久化历史 + 增量事件投影；liveModelText 是尚未落地的流式文本（提交时清空）。
// toolNamesById / assistantMessageIdsByToolCallId 为工具投影所需的反查表，随事件更新。
export type SubagentTranscript = {
  sessionId: string;
  sequenceNumber: number;
  messages: Message[];
  liveModelText: string;
  toolNamesById: Map<string, string>;
  assistantMessageIdsByToolCallId: Map<string, string>;
};

// 由快照恢复子 Agent transcript：先把持久化消息还原为结构化 Message，再按序重放保留的事件补齐
// 流式/工具细节（历史已落库的内容不会重复追加）。workspaceDirectory 用于工具标题的路径相对化。
// 输入：snapshot.events 允许为空数组（仅历史消息）；replayMessageIds 标记哪些流式事件仍有效。
// 输出 sequenceNumber 取快照序号，保证后续实时事件从正确位置续接。
// 无副作用：纯函数，不修改 snapshot。
export function hydrateSubagentTranscript(
  snapshot: TuiSubagentTranscriptSnapshot,
  workspaceDirectory?: string,
): SubagentTranscript {
  let state: SubagentTranscript = {
    sessionId: snapshot.sessionId,
    sequenceNumber: 0,
    messages: appendAgentResult(
      [],
      { response: "", restoredMessages: snapshot.messages },
      { workspaceDirectory },
    ),
    liveModelText: "",
    toolNamesById: new Map(),
    assistantMessageIdsByToolCallId: new Map(),
  };
  const replayIds = new Set(snapshot.replayMessageIds);
  // 只重放流式文本与工具类事件：其它事件已在持久化消息中体现，重放会导致内容重复。
  for (const event of snapshot.events) {
    // Completed replies already exist in persisted history. Replaying historical
    // turn_complete/assistant_message would append previous turns a second time.
    if (event.type !== SessionEventType.ModelStreaming && !event.type.startsWith("tool_call_"))
      continue;
    const payload = event.payload as Record<string, unknown>;
    // Completed history without retained stream events is already in messages.
    if (
      event.type === SessionEventType.ModelStreaming &&
      !replayIds.has(String(payload.assistantMessageId))
    )
      continue;
    state = applySubagentTranscriptEvent(state, event, workspaceDirectory);
  }
  return { ...state, sequenceNumber: snapshot.sequenceNumber };
}

/** This reducer can update only transcript data; it has no composer/runtime controls. */
// 应用单条子 Agent 事件，返回新的状态（不可变更新，原状态不修改）。
// 过滤口径：sessionId 不匹配、属于子 Agent 工具镜像、或序号不大于已处理序号的事件一律原样返回，
// 因此该函数可安全地接受全量事件流，无需调用方预筛。
// 副作用：无（不写 IO）；setStatus 为占位空实现，因为子 Agent 视图不展示主会话状态栏。
export function applySubagentTranscriptEvent(
  state: SubagentTranscript,
  event: SessionEvent,
  workspaceDirectory?: string,
): SubagentTranscript {
  if (
    event.sessionId !== state.sessionId ||
    isSubagentToolMirror(event) ||
    event.sequenceNumber <= state.sequenceNumber
  )
    return state;
  const next = { ...state, sequenceNumber: event.sequenceNumber };
  const payload = event.payload as Record<string, unknown>;
  const setMessages = (action: React.SetStateAction<Message[]>) => {
    next.messages = typeof action === "function" ? action(next.messages) : action;
  };
  if (event.type === SessionEventType.ModelStreaming) {
    applyModelStreamingEvent(payload, {
      setMessages,
      assistantMessageIdsByToolCallId: next.assistantMessageIdsByToolCallId,
      setLiveModelText: (action) => {
        next.liveModelText = typeof action === "function" ? action(next.liveModelText) : action;
      },
      setStatus: () => {},
    });
  } else if (event.type.startsWith("tool_call_")) {
    applyToolTranscriptEvent(event, {
      setMessages,
      toolNamesById: next.toolNamesById,
      assistantMessageIdsByToolCallId: next.assistantMessageIdsByToolCallId,
      workspaceDirectory,
    });
    const result = payload.result as Record<string, unknown> | undefined;
    // 工具结果优先取结构化 content；缺省时回退拼接 stdout/stderr 尾部，
    // 再回填到对应 toolCallId 的 part，保证视图能看到输出而非空块。
    const output =
      typeof result?.content === "string"
        ? result.content
        : [payload.stdoutTail, payload.stderrTail]
            .filter((value): value is string => typeof value === "string")
            .join("\n");
    if (output)
      next.messages = next.messages.map((message) => ({
        ...message,
        parts: message.parts?.map((part) =>
          part.type === "tool" && part.toolCallId === payload.toolCallId
            ? { ...part, output }
            : part,
        ),
      }));
  } else if (event.type === SessionEventType.AssistantMessage) {
    appendResponse(next, payload.content);
  } else if (
    event.type === SessionEventType.TurnComplete ||
    event.type === SessionEventType.TurnError
  ) {
    next.messages = finalizeStreamProjectedMessages(next.messages);
    if (next.liveModelText) {
      next.messages = [...next.messages, { role: "agent", content: next.liveModelText }];
      next.liveModelText = "";
    }
    if (event.type === SessionEventType.TurnComplete) appendResponse(next, payload.response);
    if (event.type === SessionEventType.TurnError) {
      const error = payload.error as Record<string, unknown> | undefined;
      if (typeof error?.message === "string")
        next.messages = [...next.messages, { role: "system", content: error.message }];
    }
  }
  return next;
}

// 追加最终回复：空串/纯空白直接忽略（流式路径可能已写入内容或本就无新增文本）。
// 去重依据：若最后一条 agent 消息的纯文本部分与 response 相同，则不重复追加，
// 优先读取 parts 中的 text（结构化消息），回退到 content（历史消息）。
function appendResponse(state: SubagentTranscript, response: unknown): void {
  if (typeof response !== "string" || !response.trim()) return;
  const last = state.messages.filter((message) => message.role === "agent").at(-1);
  const text = last?.parts?.length
    ? last.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : last?.content;
  if (text?.trim() !== response.trim())
    state.messages = [...state.messages, { role: "agent", content: response }];
}
