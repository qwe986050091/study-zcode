// ==== model/runner-normalization.ts ====
// 定位：把 AI SDK 的 usage / reasoning / stream chunk / tool call / source 归一化为 Core 契约类型。
// 输入：AI SDK 的 Partial<LanguageModelUsage>、TextStreamPart、generateText 结果等。
// 输出：ModelUsage、ReasoningBlock、ModelStreamEvent、toolCalls/toolResults、ModelSource。
// 副作用：无 IO；normalizeToolCalls 归一化输入时可能通过 logger 记录告警。
// 失败语义：不抛错；无法识别的 chunk/来源被丢弃，字段缺失保持 undefined 或空字符串。
// 不变量：事件与工具调用保持原顺序；没有内容时返回 undefined 而非空数组。
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type {
  Logger,
  ModelReasoningContentBlock,
  ModelSource,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolResult,
  ModelUsage,
} from "@zcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { asRecord, isRecord, numberProperty, stringProperty } from "./runner-record.js";
import { normalizeModelToolName } from "./tool-call-validation.js";

/**
 * 归一化 token 用量。
 * input/output/total/cache/reasoning 直接取自 AI SDK 明细字段（单位：token 数）。
 * 仅当 provider raw 中报告了 server_tool_use 的 web_search/web_fetch 次数时才附带
 * serverToolUse 子对象，否则保持输出形状精简。
 */
export function normalizeUsage(usage?: Partial<LanguageModelUsage>): ModelUsage {
  const rawUsage = isRecord(usage?.raw) ? usage.raw : undefined;
  const rawServerToolUse = isRecord(rawUsage?.server_tool_use)
    ? rawUsage.server_tool_use
    : undefined;
  const webSearchRequests = numberProperty(rawServerToolUse, "web_search_requests");
  const webFetchRequests = numberProperty(rawServerToolUse, "web_fetch_requests");

  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
    ...(webSearchRequests !== undefined || webFetchRequests !== undefined
      ? {
          serverToolUse: {
            webFetchRequests,
            webSearchRequests,
          },
        }
      : {}),
  };
}

/**
 * 把 AI SDK reasoning part 归一为 Core 的 reasoning 块。
 * 只保留 type=reasoning 且 text 为字符串的项，丢弃空数组并返回 undefined；
 * providerMetadata 作为 providerOptions 原样透传，供后续历史回放使用。
 */
export function normalizeReasoning(
  reasoning?: readonly {
    providerMetadata?: unknown;
    text?: string;
    type?: string;
  }[],
): ModelReasoningContentBlock[] | undefined {
  if (!reasoning || reasoning.length === 0) {
    return undefined;
  }

  return reasoning
    .filter((part) => part.type === "reasoning" && typeof part.text === "string")
    .map((part) => ({
      type: "reasoning",
      text: part.text!,
      providerOptions: isRecord(part.providerMetadata) ? part.providerMetadata : undefined,
    }));
}

/**
 * 单条 stream chunk → Core 事件的映射。
 * 未识别的 chunk 类型返回 undefined（由调用方过滤），不抛错、不产生占位事件。
 * tool-input-start 会先按 provider 规则归一化工具名；final tool-call 保留原始 name/input，
 * 由 assembler 统一校验，避免多处以不同口径重复解析并告警。
 */
export function toModelStreamEvent(chunk: TextStreamPart<ToolSet>): ModelStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return {
        type: "start",
      };

    case "text-start":
      return {
        type: "text_start",
        id: chunk.id,
      };

    case "text-delta":
      return {
        type: "text_delta",
        id: chunk.id,
        text: chunk.text,
      };

    case "text-end":
      return {
        type: "text_end",
        id: chunk.id,
      };

    case "reasoning-start":
      return {
        type: "reasoning_start",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-delta":
      return {
        type: "reasoning_delta",
        id: chunk.id,
        text:
          stringProperty(asRecord(chunk), "delta") ?? stringProperty(asRecord(chunk), "text") ?? "",
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-end":
      return {
        type: "reasoning_end",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "tool-input-start": {
      const inputStartToolName = normalizeModelToolName(chunk.toolName, {
        providerExecuted: chunk.providerExecuted,
        source: "streamText",
        streamChunkType: chunk.type,
        toolCallId: chunk.id,
      });
      return {
        type: "tool_input_start",
        id: chunk.id,
        providerExecuted: chunk.providerExecuted,
        toolName: inputStartToolName,
      };
    }

    case "tool-input-delta":
      return {
        type: "tool_input_delta",
        id: chunk.id,
        delta: chunk.delta,
      };

    case "tool-input-end":
      return {
        type: "tool_input_end",
        id: chunk.id,
      };

    case "tool-call": {
      return {
        type: "tool_call",
        toolCall: {
          id: chunk.toolCallId,
          // Final tool-call 的 name/input 由 assembler 统一校验和归一化。
          name: chunk.toolName,
          providerExecuted: chunk.providerExecuted,
          // 执行参数只取 AI SDK final tool-call，避免从展示用 delta 猜测输入，
          // 也避免 stream/model-io 多次解析并重复告警。
          input: chunk.input,
        },
      };
    }

    case "finish":
      return {
        type: "finish",
        finishReason: chunk.finishReason,
        providerMetadata: buildFinishProviderMetadata(chunk),
        usage: normalizeUsage(chunk.totalUsage),
      };

    case "error":
      return {
        type: "error",
        error: chunk.error,
      };

    default:
      // 未知 chunk 静默丢弃：上游可能新增事件类型，不能因此中断整条流。
      return undefined;
  }
}

/**
 * 归一化 generateText 的 toolCalls。
 * 缺失 id 时生成随机 UUID 保证父子/结果配对的幂等键可用；
 * 工具名走统一归一化；input 显式区分 undefined（用 args 兜底），但显式 null 必须保留。
 * 非数组时返回 undefined，表示本次结果没有工具调用。
 */
export function normalizeToolCalls(
  result: AiSdkGenerateTextResult,
  logger?: Logger,
): ModelTextResult["toolCalls"] {
  const toolCalls = (result as unknown as { toolCalls?: unknown[] }).toolCalls;
  if (!Array.isArray(toolCalls)) return undefined;

  return toolCalls.map((toolCall, index) => {
    const value = toolCall as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      args?: unknown;
      providerExecuted?: boolean;
    };
    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    const name = normalizeModelToolName(value.toolName ?? value.name, {
      providerExecuted: value.providerExecuted,
      source: "generateText",
      toolCallId: id,
      toolCallIndex: index,
    });

    return {
      id,
      name,
      providerExecuted: value.providerExecuted,
      // 上游会把 JSON "null" 转成原生 null；显式 null 不能被
      // nullish fallback 擦成旧版 args，否则 runtime 与 provider-visible input 漂移。
      input: normalizeModelToolInput(value.input !== undefined ? value.input : value.args, {
        logger,
        source: "generateText",
        toolName: name,
      }),
    };
  });
}

/**
 * 归一化 generateText 的 toolResults。
 * 以同 id 的已归一化 toolCall.input 覆盖 result 自带 input，防止 malformed input 从结果侧泄漏；
 * 找不到对应 call 时保留原 input。输出为空数组时返回 undefined。
 */
export function normalizeToolResults(
  result: AiSdkGenerateTextResult,
  normalizedToolCalls?: ModelTextResult["toolCalls"],
): ModelToolResult[] | undefined {
  const toolResults = (result as unknown as { toolResults?: unknown[] }).toolResults;
  if (!Array.isArray(toolResults)) return undefined;
  const normalizedInputByToolCallId = new Map(
    (normalizedToolCalls ?? []).map((toolCall) => [toolCall.id, toolCall.input]),
  );

  const normalized = toolResults.map((toolResult) => {
    const value = toolResult as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      output?: unknown;
      result?: unknown;
      providerExecuted?: boolean;
      providerMetadata?: unknown;
    };

    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    return {
      id,
      name: value.toolName ?? value.name ?? "unknown",
      // AI SDK 会为 invalid tool-call 生成携带原始 input 的 tool-error。
      // 复用同 id final call 的归一化结果，避免 malformed string/null 从 toolResults 泄漏。
      input: normalizedInputByToolCallId.has(id)
        ? normalizedInputByToolCallId.get(id)
        : value.input,
      output: value.output ?? value.result,
      providerExecuted: value.providerExecuted,
      providerMetadata: isRecord(value.providerMetadata)
        ? (value.providerMetadata as Record<string, unknown>)
        : undefined,
    };
  });

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 归一化来源（url/document）。
 * 非法记录、未知 sourceType 一律丢弃；字段缺失保留 undefined；
 * 过滤后为空返回 undefined，避免空数组进入下游渲染。
 */
export function normalizeSources(result: AiSdkGenerateTextResult): ModelSource[] | undefined {
  const sources = (result as unknown as { sources?: unknown[] }).sources;
  if (!Array.isArray(sources)) return undefined;

  const normalized = sources
    .map((source): ModelSource | undefined => {
      if (!isRecord(source)) return undefined;
      const sourceType = stringProperty(source, "sourceType");
      if (sourceType !== "url" && sourceType !== "document") return undefined;

      return {
        type: "source",
        sourceType,
        id: stringProperty(source, "id"),
        url: stringProperty(source, "url"),
        title: stringProperty(source, "title"),
        mediaType: stringProperty(source, "mediaType"),
        filename: stringProperty(source, "filename"),
        providerMetadata: isRecord(source.providerMetadata)
          ? (source.providerMetadata as Record<string, unknown>)
          : undefined,
      };
    })
    .filter((source): source is ModelSource => source !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 合并 finish chunk 的 providerMetadata。
 * response 与 response.body 的字段会平铺进 metadata，并补上 rawFinishReason；
 * 合并结果为空时返回 undefined，避免制造空对象。
 */
function buildFinishProviderMetadata(
  chunk: TextStreamPart<ToolSet>,
): Record<string, unknown> | undefined {
  if (chunk.type !== "finish") return undefined;

  const record = asRecord(chunk);
  const providerMetadata = isRecord(record.providerMetadata) ? { ...record.providerMetadata } : {};
  const response = isRecord(record.response) ? record.response : undefined;
  const responseBody = response && isRecord(response.body) ? response.body : undefined;

  const merged = {
    ...providerMetadata,
    ...(response ? { response } : {}),
    ...(responseBody ?? {}),
    ...(record.rawFinishReason === undefined ? {} : { rawFinishReason: record.rawFinishReason }),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}
