// 模型流式事件到 TUI 消息状态的投影。
// 职责：按事件 kind 追加文本/思考增量、记录 tool_call 归属、标记消息完成。
// 边界：只写本地渲染状态，不创建会话事实、不持久化。
// 副作用：写 React 状态；维护 toolCallId → assistantMessageId 的可变 Map。
// 降级：未知 kind 静默忽略；无 assistantMessageId 的文本增量转入全局 live buffer。

import type React from "react";
import type { Message } from "./app-model.js";
import {
  appendStreamingTextDelta,
  appendStreamingThoughtDelta,
  markStreamingMessageComplete,
  markStreamingThoughtComplete,
} from "./app-transcript-stream.js";
import { stringField } from "./state.js";

// 把模型流式事件 payload 投影到 TUI 消息状态；所有字段都按可选字符串读取，缺失不抛错。
// 输入：payload 为 provider/协议层原始事件（kind 决定分支），handlers 提供三个写入点与工具映射表。
// 输出：无返回值；通过 setMessages / setLiveModelText / setStatus 反映进度，未识别的 kind 静默忽略。
// 副作用：写 React 状态；assistantMessageIdsByToolCallId 为可变 Map，会在 tool_call 时被写入。
// 口径：带 assistantMessageId 的增量按消息就地追加，保持 text/tool/text 的原始顺序；
// 不带 id 的文本增量写入全局 live buffer（渲染在工具行下方）。
// 失败语义：kind 缺失但存在 delta 时按文本增量处理，兼容精简事件；无 delta 则什么都不做。
// 不变量：reasoning_end/finish 需要 assistantMessageId 才会标记完成，缺失时仅更新状态栏。
export function applyModelStreamingEvent(
  payload: Record<string, unknown>,
  handlers: {
    assistantMessageIdsByToolCallId: Map<string, string>;
    setLiveModelText: React.Dispatch<React.SetStateAction<string>>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setStatus: (status: string) => void;
  },
): void {
  const kind = stringField(payload, "kind");
  const delta = stringField(payload, "delta") ?? "";
  if (kind === "reasoning_start") {
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_delta") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    // 无 assistantMessageId 时无法定位目标消息，丢弃增量但不影响后续事件处理。
    if (assistantMessageId) {
      handlers.setMessages((current) =>
        appendStreamingThoughtDelta(current, assistantMessageId, delta),
      );
    }
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_end") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingThoughtComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model reasoning received.");
    return;
  }
  if (kind === "tool_call") {
    rememberStreamingToolMessage(payload, handlers.assistantMessageIdsByToolCallId);
    handlers.setStatus(`Tool ${stringField(payload, "toolName") ?? "tool"} pending.`);
    return;
  }
  if (kind === "tool_input_start" || kind === "tool_input_delta" || kind === "tool_input_end") {
    // provider tool-input deltas are JSON arguments for a future tool call, not assistant text.
    handlers.setStatus(`Preparing tool ${stringField(payload, "toolName") ?? "tool"}...`);
    return;
  }
  if (kind === "text_delta" || (!kind && delta)) {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      // a global live text buffer renders below tool rows; assistant-scoped deltas
      // keep text/tool/text in the provider's original transcript order.
      handlers.setMessages((current) =>
        appendStreamingTextDelta(current, assistantMessageId, delta),
      );
    } else {
      // 无消息归属（例如尚未收到 assistant_message 事件）时退化为全局缓冲，内容不丢失。
      handlers.setLiveModelText((current) => `${current}${delta}`);
    }
    handlers.setStatus("Streaming model response...");
    return;
  }
  if (kind === "finish") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingMessageComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model response received.");
  }
}

// 记录 tool_call 与其所属 assistant 消息的映射，供后续工具结果回填时定位消息分段。
// 任一侧 id 缺失则不记录（无法建立有效关联），Map 只增不删，由会话生命周期统一清理。
function rememberStreamingToolMessage(
  payload: Record<string, unknown>,
  assistantMessageIdsByToolCallId: Map<string, string>,
): void {
  const toolCallId = stringField(payload, "toolCallId");
  const assistantMessageId = stringField(payload, "assistantMessageId");
  if (toolCallId && assistantMessageId) {
    assistantMessageIdsByToolCallId.set(toolCallId, assistantMessageId);
  }
}
