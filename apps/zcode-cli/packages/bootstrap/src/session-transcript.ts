import {
  parseCompletedToolPartMetadata,
  parseToolResultDisplayPayload,
  type MessagePart,
  type MessageWithParts,
  type SessionId,
  type SessionStorePort,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import { getConversationMessageProjectionPolicy } from "@zcode/shared";

// 会话 transcript 的「展示投影」：从持久化 raw history 生成用户可见的对话列表。
//
// raw history 面向模型恢复（含 goal continuation 等内部 user 输入、summary 压缩消息、
// 被忽略的 part），transcript 面向 UI，必须剔除这些内部语义，否则用户会看到自己不存在的发言。
// 本模块纯映射、只读 store，不写任何状态；store 缺席时返回空数组（headless/未开持久化）。
export type SessionTranscriptPart =
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "thought";
    }
  | {
      error?: string;
      input: Record<string, unknown>;
      output?: string;
      // resultDisplay 是结构化展示载荷（如图片/表格），缺席时 UI 退回 output 文本。
      resultDisplay?: ToolResultDisplayPayload;
      // 原始 running/pending 直接透传；error 会归一为 failed（见 toolReplayPartFromPart）。
      status: "pending" | "running" | "completed" | "failed";
      title?: string;
      toolCallId: string;
      toolName: string;
      type: "tool";
    };

export interface SessionTranscriptMessage {
  /** 纯文本拼装结果（多条 text part 用空行连接），供不支持 parts 的调用方使用。 */
  content: string;
  /** 结构化 part（thought/tool 等）；全为 text 时省略，避免与 content 重复渲染。 */
  parts?: SessionTranscriptPart[];
  role: "agent" | "user";
}

/**
 * 从 session store 读取消息并投影；store 未接入时返回空数组（不抛错）。
 * 只读，不创建 session，也不触发任何回放/补全。
 */
export async function loadSessionTranscriptFromStore(input: {
  sessionId: SessionId;
  sessionStore?: SessionStorePort;
}): Promise<SessionTranscriptMessage[]> {
  if (!input.sessionStore) {
    return [];
  }

  const messages = await input.sessionStore.messages({
    sessionID: input.sessionId,
  });
  return projectSessionTranscript(messages);
}

/**
 * 把 raw history 投影成可见消息，规则按顺序：
 * 1. 跳过 summary 消息（压缩产生的摘要不是用户可见对话）；
 * 2. 跳过「非真实用户输入」的 user 消息（goal continuation、runtime 注入）；
 * 3. part 按 id 去重（保留最后写入的版本，顺序按首次出现）；
 * 4. user 侧只保留未 ignored 的 text/file/agent，并转成 `[Attached file: ...]`、
 *    `[Selected agent: ...]` 占位；投影后为空则整条丢弃；
 * 5. assistant 侧 text/reasoning/tool 映射为 text/thought/tool；只要有非 text 结构，
 *    就同时输出 parts；纯文本时只给 content（避免两套渲染）。
 *
 * 返回值保持原始时间顺序；不做分页/截断（由调用方按 UI 需要处理）。
 */
export function projectSessionTranscript(
  messages: readonly MessageWithParts[],
): SessionTranscriptMessage[] {
  const transcript: SessionTranscriptMessage[] = [];

  for (const message of messages) {
    if (isSummaryMessage(message)) {
      continue;
    }
    if (isModelOnlyUserMessage(message)) {
      // goal continuation 等 runtime 内部输入需要保留在 raw history 供模型恢复，
      // 但 transcript 是用户可见投影，不能把这类 user-role 输入展示成用户发言。
      continue;
    }

    const parts = dedupeMessageParts(message.parts);

    if (message.info.role === "user") {
      const text = userReplayTextFromParts(parts);
      if (text.trim().length === 0) {
        continue;
      }
      transcript.push({
        content: text,
        role: "user",
      });
      continue;
    }

    const transcriptParts = assistantReplayPartsFromParts(parts);
    const hasStructuredParts = transcriptParts.some((part) => part.type !== "text");
    const visibleParts = hasStructuredParts ? transcriptParts : [];
    const text = transcriptParts
      .filter(
        (part): part is Extract<SessionTranscriptPart, { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n\n");
    if (text.trim().length === 0 && visibleParts.length === 0) {
      continue;
    }
    transcript.push({
      content: text,
      ...(visibleParts.length > 0 ? { parts: visibleParts } : {}),
      role: "agent",
    });
  }

  return transcript;
}

// summary 的判定因角色而不同：user 消息用「字段存在」表示摘要，assistant 用布尔 true；
// 两种形态都来自不同历史版本的压缩实现。
function isSummaryMessage(message: MessageWithParts): boolean {
  return message.info.role === "user"
    ? message.info.summary !== undefined
    : message.info.summary === true;
}

// 只有投影策略为 realUserInput 的 user 消息才算用户发言；其余（goal continuation 等）
// 必须留在 raw history 供模型恢复，但不能出现在 transcript 里。
function isModelOnlyUserMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return false;
  }
  return getConversationMessageProjectionPolicy(message) !== "realUserInput";
}

// 同一 part id 可能因流式增量/重放出现多次：Map.set 后写覆盖前写，最终顺序保留首次插入位置。
function dedupeMessageParts(parts: readonly MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();

  for (const part of parts) {
    byId.set(part.id, part);
  }

  return [...byId.values()];
}

// 用户消息可回放三类内容：未 ignored 的文本、附件（占位显示文件名或 URL）、
// 选中的 agent（占位显示名字）；其余 part 类型在 transcript 中没有用户语义，忽略。
function userReplayTextFromParts(parts: readonly MessagePart[]): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      chunks.push(part.text);
      continue;
    }

    if (part.type === "file") {
      chunks.push(`[Attached file: ${part.filename ?? part.url}]`);
      continue;
    }

    if (part.type === "agent") {
      chunks.push(`[Selected agent: ${part.name}]`);
    }
  }

  return chunks.join("\n\n");
}

// agent 消息映射：text→text、reasoning→thought、tool→tool；ignored 文本不进入 transcript。
function assistantReplayPartsFromParts(parts: readonly MessagePart[]): SessionTranscriptPart[] {
  const transcriptParts: SessionTranscriptPart[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      transcriptParts.push({ text: part.text, type: "text" });
      continue;
    }

    if (part.type === "reasoning") {
      transcriptParts.push({ text: part.text, type: "thought" });
      continue;
    }

    if (part.type === "tool") {
      transcriptParts.push(toolReplayPartFromPart(part));
    }
  }

  return transcriptParts;
}

// 工具状态映射：completed 保留 output/title/结构化展示；error 归一为 failed 并带错误文本；
// pending/running 原样透传（title 仅在存在时附带）。
function toolReplayPartFromPart(
  part: Extract<MessagePart, { type: "tool" }>,
): SessionTranscriptPart {
  const base = {
    input: part.state.input,
    toolCallId: part.callID,
    toolName: part.tool,
    type: "tool" as const,
  };

  if (part.state.status === "completed") {
    const resultDisplay = replayToolResultDisplay(part.state.metadata);
    return {
      ...base,
      output: part.state.output,
      ...(resultDisplay ? { resultDisplay } : {}),
      status: "completed",
      title: part.state.title,
    };
  }

  if (part.state.status === "error") {
    return {
      ...base,
      error: part.state.error,
      status: "failed",
    };
  }

  return {
    ...base,
    status: part.state.status,
    ...("title" in part.state && part.state.title ? { title: part.state.title } : {}),
  };
}

// 优先读已完成元数据里的 display；旧历史可能只有顶层 metadata.display，做一次兜底解析。
function replayToolResultDisplay(
  metadata: Record<string, unknown> | undefined,
): ToolResultDisplayPayload | undefined {
  const parsed = parseCompletedToolPartMetadata(metadata);
  if (parsed?.display) {
    return parsed.display;
  }

  return parseToolResultDisplayPayload(metadata?.display);
}
