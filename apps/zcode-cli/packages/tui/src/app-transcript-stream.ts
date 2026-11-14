// 流式投影模块：维护模型流式文本/思考增量在 transcript 中的本地投影与收尾。
// 边界：只操作消息数组，不读会话状态、不写 IO；快照替换由上层负责。
// 口径：空增量短路并保留原引用；投影消息带 streamProjected/streaming 标记，便于收尾统一清理。
// 失败语义：全部为不可变纯函数，未命中 id 时按相同 id 补建消息或原样返回，不抛错。
import type { Message, TextTranscriptPart, ThoughtTranscriptPart } from "./app-model.js";

const AGENT_ROLE = "agent";
const STREAMING_THOUGHT_STATUS = "thinking";
const COMPLETED_THOUGHT_STATUS = "thought";

// 将流式文本增量追加到指定 assistant 消息：存在同 id 消息时原地合并，不存在则新建投影消息。
// 输入 delta 为空串时直接返回原数组（引用不变），避免无内容事件触发无谓重渲染。
// 输出不可变新数组；消息标记 streamProjected=true / streaming=true，供收尾时统一清理。
// 纯函数，无 IO；最终以 snapshot 消息替换由上层负责。
export function appendStreamingTextDelta(
  messages: Message[],
  assistantMessageId: string,
  delta: string,
): Message[] {
  // 空增量不产生任何可见变化，直接短路保留引用。
  if (delta.length === 0) return messages;

  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== assistantMessageId) return message;
    found = true;
    return appendTextPart(message, delta);
  });

  // 未命中说明首个流事件先于占位消息到达，按相同 id 补建一条投影消息。
  if (found) return updated;
  return [
    ...updated,
    appendTextPart(
      {
        content: "",
        id: assistantMessageId,
        parts: [],
        role: AGENT_ROLE,
        streamProjected: true,
        streaming: true,
      },
      delta,
    ),
  ];
}

// 收尾指定消息的流式状态：streaming 置 false，并把仍在 thinking 的 thought 段转为完成态。
// 未命中 id 时原样返回；不清理消息内容或投影标记。
// 用于快照替换前的定点收尾，与批量收尾的区别是只影响指定消息。
export function markStreamingMessageComplete(
  messages: Message[],
  assistantMessageId: string,
): Message[] {
  return messages.map((message) =>
    message.id === assistantMessageId
      ? { ...completeThoughtParts(message), streaming: false }
      : message,
  );
}

// 会话结束/替换时批量收尾所有仍在流式输出中的投影消息；非流式消息保持原引用。
// 只处理带 streamProjected 标记的消息，因此不会误改历史恢复或用户输入的消息。
// 返回新数组（内部逐条浅拷贝），调用方可直接交给 setMessages。
export function finalizeStreamProjectedMessages(messages: Message[]): Message[] {
  return messages.map((message) =>
    message.streamProjected && message.streaming
      ? { ...completeThoughtParts(message), streaming: false }
      : message,
  );
}

// 续写条件：仅末段仍是 thinking 的 thought 段会接收增量；末段已结束则新开一段 thinking，不污染历史思考。
// 与文本增量的边界：思考增量只动 thought 段、文本增量只动 text 段，二者各自推进，互不覆盖对方内容。
// 将思考增量追加到指定 assistant 消息的最后一个 thinking 段；无匹配消息时补建投影消息。
// 空增量直接短路；thought 段的 contentCharCount 与 text 同步累加，供折叠视图统计字符数。
export function appendStreamingThoughtDelta(
  messages: Message[],
  assistantMessageId: string,
  delta: string,
): Message[] {
  if (delta.length === 0) return messages;

  let found = false;
  const updated = messages.map((message) => {
    if (message.id !== assistantMessageId) return message;
    found = true;
    return appendThoughtPart(message, delta);
  });

  if (found) return updated;
  return [
    ...updated,
    appendThoughtPart(
      {
        content: "",
        id: assistantMessageId,
        parts: [],
        role: AGENT_ROLE,
        streamProjected: true,
        streaming: true,
      },
      delta,
    ),
  ];
}

// 只把最后一个仍为 thinking 的 thought 段置为完成态；后续文本/工具段之前必须先结束思考。
// 未命中消息或没有活跃思考段时原样返回，可安全重复调用，不会抛错。
// 不复位 contentCharCount，折叠视图仍能展示已累积的字符数。
export function markStreamingThoughtComplete(
  messages: Message[],
  assistantMessageId: string,
): Message[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? completeActiveThoughtPart(message) : message,
  );
}

// 判定最终快照是否已由本地流式投影覆盖，用于决定是否还要追加一条完整 assistant 消息。
// response 非空时比较最后一条投影消息的文本；空 response 只要存在投影消息即视为已覆盖。
// 比较前 trim，忽略流式拼接与快照在首尾空白上的差异。
export function projectedTranscriptHasResponse(messages: Message[], response: string): boolean {
  const normalized = response.trim();
  const projectedMessages = messages.filter((message) => message.streamProjected);
  if (normalized.length === 0) return projectedMessages.length > 0;
  const lastProjected = projectedMessages.at(-1);
  return lastProjected ? transcriptText(lastProjected).trim() === normalized : false;
}

// 复用末段流式 text 段做拼接，否则新开一段；避免每个 token 都生成新 part 导致列表膨胀。
function appendTextPart(message: Message, delta: string): Message {
  const parts = [...(message.parts ?? [])];
  const last = parts.at(-1);
  if (last?.type === "text" && last.streamProjected) {
    parts[parts.length - 1] = {
      ...last,
      text: `${last.text}${delta}`,
    };
  } else {
    parts.push({
      streamProjected: true,
      text: delta,
      type: "text",
    } satisfies TextTranscriptPart);
  }

  return {
    ...message,
    content: "",
    parts,
    role: AGENT_ROLE,
    streamProjected: true,
    streaming: true,
  };
}

// 仅当末段仍是 thinking 状态才续写；已完成的思考段不再接收增量，避免污染历史折叠内容。
function appendThoughtPart(message: Message, delta: string): Message {
  const parts = [...(message.parts ?? [])];
  const last = parts.at(-1);
  if (last?.type === "thought" && last.status === STREAMING_THOUGHT_STATUS) {
    parts[parts.length - 1] = {
      ...last,
      contentCharCount: last.contentCharCount + delta.length,
      text: `${last.text}${delta}`,
    };
  } else {
    parts.push({
      contentCharCount: delta.length,
      status: STREAMING_THOUGHT_STATUS,
      streamProjected: true,
      text: delta,
      type: "thought",
    } satisfies ThoughtTranscriptPart);
  }

  return {
    ...message,
    content: "",
    parts,
    role: AGENT_ROLE,
    streamProjected: true,
    streaming: true,
  };
}

// 无 parts 或无活跃 thinking 段时原样返回，保证调用方可以安全重复调用。
function completeActiveThoughtPart(message: Message): Message {
  const parts = message.parts;
  if (!parts) return message;
  const lastActiveIndex = parts.findLastIndex(
    (part) => part.type === "thought" && part.status === STREAMING_THOUGHT_STATUS,
  );
  if (lastActiveIndex === -1) return message;
  const updated = [...parts];
  const thought = updated[lastActiveIndex];
  if (thought?.type === "thought") {
    updated[lastActiveIndex] = {
      ...thought,
      status: COMPLETED_THOUGHT_STATUS,
    };
  }
  return { ...message, parts: updated };
}

// 收尾时把所有残留的 thinking 段一次性转为 thought，防止快照替换后仍显示转圈。
function completeThoughtParts(message: Message): Message {
  const parts = message.parts;
  if (!parts) return message;
  return {
    ...message,
    parts: parts.map((part) =>
      part.type === "thought" && part.status === STREAMING_THOUGHT_STATUS
        ? { ...part, status: COMPLETED_THOUGHT_STATUS }
        : part,
    ),
  };
}

// 聚合消息中的文本段用于快照比对；无 parts 的老消息回退到 content 字段。
function transcriptText(message: Message): string {
  if (!message.parts) return message.content;
  return message.parts
    .filter((part): part is TextTranscriptPart => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}
