/**
 * 文件职责：把 OpenAI 系响应（Chat Completions / Responses / SSE 流）归并为一条 assistant 消息。
 * 输入是原始 JSON 或流式文本块，输出是 OpenAiMessage 或 null（表示没有可记录的回复）。
 * 纯函数、无副作用、不写盘；对不认识的形状一律返回 null，而不是抛错中断录制。
 * 不变量：返回消息的 role 定为 assistant；工具调用的参数按 index 顺序拼接与排序。
 */

import type { OpenAiMessage } from "./types.js";

/**
 * 工具调用累加器：把流式分片合并成一条完整 tool_call。
 * 字段全部可选，因为分片可能分多帧到达；缺失表示尚未收到该部分。
 */
interface ToolCallAccumulator {
  function?: {
    arguments?: string;
    name?: string;
  };
  id?: string;
  type?: string;
}

/**
 * 归并非流式响应体为 assistant 消息。
 * 输入：任意 JSON；支持 Chat Completions 的 choices[0].message 与 Responses 的 output 数组。
 * 输出：assistant 消息（深拷贝）或 null（无可用回复）。
 * 副作用：无；ensureAssistantRole 内部做 JSON 深拷贝，避免引用外部对象。
 * 失败语义：不抛错，形状不符即返回 null。
 * 优先级：先看 choices，再回退 Responses output，保证两种协议都能录制。
 */
export function assembleNonStreamingAssistantMessage(body: unknown): OpenAiMessage | null {
  const message = firstChoiceMessage(body);
  if (!message) return responseOutputMessage(body);
  return ensureAssistantRole(message);
}

/**
 * 归并 SSE 流式为一条 assistant 消息。
 * 输入：按到达顺序的原始文本或 Uint8Array 块；内部先拼接再按行解析 `data:` 负载。
 * 输出：累计后的 content/reasoning_content/tool_calls；完全没有内容且 role 为 assistant 时返回 null。
 * 副作用：无（TextDecoder 为局部实例）。
 * 失败语义：`[DONE]`、非 JSON、缺 delta 的帧全部跳过，不抛错。
 * 不变量：tool_calls 以 index 为键合并，最终按 index 升序输出；同名分片按到达顺序拼接。
 */
export function assembleStreamingAssistantMessage(chunks: readonly (string | Uint8Array)[]): OpenAiMessage | null {
  const text = chunks
    .map((chunk) => (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)))
    .join("");
  let role = "assistant";
  let content = "";
  let reasoningContent = "";
  const toolCalls = new Map<number, ToolCallAccumulator>();

  for (const payload of parseSseDataPayloads(text)) {
    // [DONE] 是协议结束哨兵，不是 JSON；跳过它而不是当成解析失败。
    if (payload === "[DONE]") continue;
    const parsed = parseJson(payload);
    // 空行、心跳或半帧会解析失败，录制应继续而不是中断整条流。
    if (!parsed) continue;
    const delta = firstChoiceDelta(parsed);
    if (!delta) continue;

    if (typeof delta.role === "string") {
      role = delta.role;
    }
    if (typeof delta.content === "string") {
      content += delta.content;
    }
    if (typeof delta.reasoning_content === "string") {
      reasoningContent += delta.reasoning_content;
    }
    mergeToolCallDeltas(toolCalls, delta.tool_calls);
  }

  const message: OpenAiMessage = { role };
  if (content.length > 0 || toolCalls.size > 0) {
    message.content = content;
  }
  if (reasoningContent.length > 0) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => normalizeToolCall(toolCall));
  }

  return Object.keys(message).length > 1 || role === "assistant" ? message : null;
}

/**
 * 取 Chat Completions 的首个 choice.message。
 * 输入：任意响应体。
 * 输出：消息对象引用；形状不符返回 null。
 * 无副作用；不拷贝，调用方需自行隔离。
 */
function firstChoiceMessage(body: unknown): OpenAiMessage | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  return message as OpenAiMessage;
}

/**
 * 把 Responses 协议的 output 数组转成一条 assistant 消息。
 * 输入：任意响应体；只识别 type=function_call 与 type=message。
 * 输出：assistant 消息或 null。
 * 优先级：function_call 优先于 message，保证工具调用不因同帧文本被丢弃。
 * 无副作用；content 中的非文本块按空串处理，不报错。
 */
function responseOutputMessage(body: unknown): OpenAiMessage | null {
  if (!body || typeof body !== "object") return null;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const functionCall = output.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as { type?: unknown }).type === "function_call",
  ) as Record<string, unknown> | undefined;
  if (functionCall) {
    return {
      content: "",
      role: "assistant",
      tool_calls: [
        {
          id: typeof functionCall.call_id === "string" ? functionCall.call_id : undefined,
          type: "function",
          function: {
            arguments:
              typeof functionCall.arguments === "string" ? functionCall.arguments : "",
            name: typeof functionCall.name === "string" ? functionCall.name : "",
          },
        },
      ],
    };
  }

  const message = output.find(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as { type?: unknown }).type === "message",
  ) as Record<string, unknown> | undefined;
  if (!message) return null;

  const content = Array.isArray(message.content)
    ? message.content
        .map((item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as { text?: unknown }).text === "string"
            ? ((item as { text: string }).text)
            : "",
        )
        .join("")
    : "";
  return {
    content,
    role: "assistant",
  };
}

/**
 * 深拷贝消息并补齐 assistant 角色。
 * 输入：可能缺 role 的消息对象。
 * 输出：新对象；role 保持原值（若为字符串），否则补 "assistant"。
 * 副作用：无；JSON 深拷贝会丢失 undefined 与函数字段，但响应体本应为纯 JSON。
 */
function ensureAssistantRole(message: OpenAiMessage): OpenAiMessage {
  return {
    ...JSON.parse(JSON.stringify(message)),
    role: typeof message.role === "string" ? message.role : "assistant",
  };
}

/**
 * 取流式帧的首个 choice.delta。
 * 输入：单帧 JSON。
 * 输出：delta 对象引用；形状不符返回 null，由调用方跳过。
 * 无副作用；不拷贝。
 */
function firstChoiceDelta(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const delta = (first as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return null;
  return delta as Record<string, unknown>;
}

/**
 * 从完整 SSE 文本中提取所有 data 负载。
 * 输入：已拼接的原始响应文本，兼容 CRLF/LF。
 * 输出：按出现顺序的负载字符串，已 trim 并丢弃空负载。
 * 无副作用；只识别 `data:` 前缀行，忽略 event/id/注释行。
 */
function parseSseDataPayloads(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload.length > 0);
}

/**
 * 安全解析 JSON。
 * 输入：任意字符串；输出：解析值或 null（解析失败）。
 * 失败语义：吞掉 SyntaxError，返回 null 让调用方跳过该帧；不区分错误原因。
 */
function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * 把单帧的 tool_calls 分片并入累加器。
 * 输入：以 index 为键的 Map 与帧内的 tool_calls 数组。
 * 输出：原地更新 Map，无返回值。
 * 副作用：修改入参 Map 与其中的累加器对象。
 * 合并语义：id/type 后到覆盖；name/arguments 为流式分片，必须追加拼接。
 * 失败语义：非数组或非对象分片直接跳过。
 */
function mergeToolCallDeltas(
  toolCalls: Map<number, ToolCallAccumulator>,
  deltas: unknown,
): void {
  if (!Array.isArray(deltas)) return;

  for (const delta of deltas) {
    if (!delta || typeof delta !== "object") continue;
    const record = delta as {
      function?: {
        arguments?: unknown;
        name?: unknown;
      };
      id?: unknown;
      index?: unknown;
      type?: unknown;
    };
    // 缺 index 时按当前条数新建，避免覆盖已累积的同序调用。
    const index = typeof record.index === "number" ? record.index : toolCalls.size;
    const current = toolCalls.get(index) ?? {};
    if (typeof record.id === "string") {
      current.id = record.id;
    }
    if (typeof record.type === "string") {
      current.type = record.type;
    }
    if (record.function && typeof record.function === "object") {
      current.function = current.function ?? {};
      if (typeof record.function.name === "string") {
        current.function.name = `${current.function.name ?? ""}${record.function.name}`;
      }
      if (typeof record.function.arguments === "string") {
        current.function.arguments = `${current.function.arguments ?? ""}${record.function.arguments}`;
      }
    }
    toolCalls.set(index, current);
  }
}

/**
 * 输出统一形状的 tool_call。
 * 输入：可能缺字段的累加器。
 * 输出：新对象；id 为空时省略该键，type 缺省为 "function"，name/arguments 缺省为空串。
 * 无副作用；不修改累加器。
 */
function normalizeToolCall(toolCall: ToolCallAccumulator): Record<string, unknown> {
  return {
    ...(toolCall.id ? { id: toolCall.id } : {}),
    type: toolCall.type ?? "function",
    function: {
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "",
    },
  };
}
