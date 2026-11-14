// ============================================================
// WebSearch Tool
// ============================================================
// 用**当前模型提供方**的原生 web_search 能力做一次搜索：一次工具调用 = 一次辅助模型请求，
// 搜索本身由 provider 在服务端完成，结果由 websearch-results.ts 归一化成 WebSearchOutput。
//
// 定位与边界：
//   - 只读、无审批（`sideEffectScope: "network"`），可并发；一次调用不写任何 durable 事实。
//   - 依赖 `context.model` 且 `supportsNativeWebSearch`，任一不满足即抛 ConfigurationError——
//     这是「宿主没接上能力」而非「搜索无结果」，不允许静默返回空列表（不变量：结果通道不能
//     用空成功掩盖能力缺失）。
//   - 内部请求走流式聚合（见 handler 内注释）：非流式 JSON 在部分兼容端点上会因裸 tool_result
//     过不了 AI SDK 的 schema 校验；流式路径复用既有 SSE compat，失败只在 error 事件上抛出。
//   - 模型面文本由 formatWebSearchModelContent 生成，工具描述里的月份是每次读取时现算，
//     避免长驻进程跨月后给模型一个过期的「current month」。

import {
  CoreErrorType,
  WEBSEARCH_PROVIDER_NATIVE_SPEC,
  WEBSEARCH_TOOL_CONTRACT,
  WebSearchInputJsonSchema,
  WebSearchInputSchema,
  WebSearchOutputJsonSchema,
  WebSearchOutputSchema,
  createCoreError,
  runWithModelInvocationContext,
  toWebSearchProviderNativeArgs,
  type ModelStreamEvent,
  type ModelTextResult,
  type ModelToolCall,
  type ModelUsage,
  type ModelToolContract,
  type WebSearchInput,
  type WebSearchOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { buildWebSearchOutput, formatWebSearchModelContent } from "./websearch-results.js";
import { webSearchTraceFromContext } from "./websearch-support.js";

const WEBSEARCH_TOOL_NAME = "WebSearch";
const PROVIDER_WEBSEARCH_TOOL_NAME = "web_search";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_USES = 8;

const WEBSEARCH_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function buildWebSearchProviderDescription(now: Date = new Date()): string {
  const currentMonth = `${WEBSEARCH_MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  return [
    "Search the web. Returns result blocks with titles and URLs. US-only.",
    "",
    `- The current month is ${currentMonth} — use this when searching for recent information.`,
    "- `allowed_domains` / `blocked_domains` filter results.",
    '- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.',
  ].join("\n");
}

/**
 * 执行一次原生搜索。
 *
 * 输入：`input.query` 是用户/模型查询原文（不再二次改写）；上下文要提供 `model`、
 * `abortSignal` 与 trace id。
 * 输出：`buildWebSearchOutput` 的归一化结果（results/sources/summary/durationMs/usage）。
 * 副作用：一次外部网络请求（通过 model.streamText 进 provider），无落盘、无 registry 变更。
 * 失败语义：缺 model / 模型不支持原生搜索 → 抛配置错误（后者 recoverable=true，让上层可换
 * 模型重试）；流内 error 事件 → 原样或包装后抛出，由 executor 记成这次 tool_call 的失败结果，
 * 不变量「每个 tool_call 有配对结果」因此仍成立。取消经 abortSignal 透传，不吞成空结果。
 */
const webSearchHandler: ToolHandler<WebSearchInput, WebSearchOutput> = async (input, context) => {
  const startedAt = Date.now();
  const model = context.model;

  if (!model) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Model is required for WebSearch", {
      context: { toolCallId: context.toolCallId, toolName: WEBSEARCH_TOOL_NAME },
      recoverable: false,
    });
  }

  if (!model.properties.supportsNativeWebSearch) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Current model does not support native WebSearch",
      {
        context: { toolCallId: context.toolCallId, toolName: WEBSEARCH_TOOL_NAME },
        recoverable: true,
      },
    );
  }

  const request: Parameters<typeof model.streamText>[0] = {
    messages: [
      {
        role: "system",
        content: "You are an assistant for performing a web search tool use.",
      },
      {
        role: "user",
        content: `Perform a web search for the query: ${input.query}`,
      },
    ],
    tools: [createProviderNativeWebSearchContract(input)],
    // BigModel 的 Anthropic 兼容端点会拒绝 named forced web_search tool_choice（1210）。
    // 这里保持自动选择，依靠单工具请求和 prompt 触发 provider-native 搜索。
    options: {
      ...auxiliaryModelOptions(model),
      // 搜索结果只需要短摘要，4096 已足够；再与模型自身的输出上限取 min，避免给一个
      // 上限更低的模型传超限值（provider 会直接 400）。
      maxOutputTokens: Math.min(4096, model.optionSpecs.maxOutputTokens.max),
    },
    abortSignal: context.abortSignal,
  };

  // BigModel Anthropic 兼容端点的非流式 JSON 会把 provider 内部
  // web_search 结果返回为 assistant-side 裸 tool_result，AI SDK 会在 schema
  // 校验阶段抛 Invalid JSON response。走流式可复用现有 SSE compat。
  const result = await collectWebSearchStreamResult({
    events: runWithModelInvocationContext(
      {
        metadata: {
          traceId: context.traceId,
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
          toolName: WEBSEARCH_TOOL_NAME,
          querySource: "web_search_tool",
        },
        modelCall: { operation: "web_search" },
        // statusSink 不在这里设：执行器交出的 context.model 已带默认会话事件出口。
        traceContext: webSearchTraceFromContext(context),
      },
      () => model.streamText(request),
    ),
  });

  return buildWebSearchOutput(input, result, startedAt);
};

/**
 * 工具注册项。
 *
 * 关键口径：
 *   - `providerNative: undefined`：对上层模型隐藏「provider 原生工具」身份，本工具在工具面里
 *     是一个普通只读工具；原生契约只在 handler 内部的辅助请求里使用。
 *   - `description` 是 getter：每次读都重算当前月份，长驻进程跨月也不会投递过期描述。
 *   - `maxOutputBytes` 20_000 与结果预算同档；超出部分由 executor 的 truncate/preview 负责，
 *     handler 不做截断（否则结构化 sources 会与模型面文本不一致）。
 */
export const webSearchToolEntry: ToolEntry = {
  ...WEBSEARCH_TOOL_CONTRACT,
  providerNative: undefined,
  metadata: {
    shouldDefer: true,
    name: WEBSEARCH_TOOL_NAME,
    searchHint: "search the web for current information",
    // 写死月份会导致模型可见的 WebSearch 描述过期。
    // 每次读取时重新生成，避免长驻进程跨月后继续投递旧月份。
    get description() {
      return buildWebSearchProviderDescription();
    },
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: 20_000,
    sideEffectScope: "network",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: webSearchHandler as ToolHandler,
  formatModelContent: formatWebSearchModelContent,
  inputSchema: WebSearchInputJsonSchema,
  outputSchema: WebSearchOutputJsonSchema,
  runtimeInputSchema: WebSearchInputSchema,
  runtimeOutputSchema: WebSearchOutputSchema,
};

/**
 * 构造只用于本次辅助请求的 provider-native 工具契约。
 *
 * 输入 `input` 只取 query 与可选的域过滤；`maxUses` 固定 8，是「一次搜索最多让 provider
 * 消化的结果数」的预算，不是模型侧可见的字段。输出给 `model.streamText` 的 tools 数组消费。
 * 副作用无；它不上报给工具面，也不参与权限判定。
 */
function createProviderNativeWebSearchContract(input: WebSearchInput): ModelToolContract {
  return {
    name: PROVIDER_WEBSEARCH_TOOL_NAME,
    capability: "web_search",
    description: "Provider-native web search used internally by the WebSearch tool",
    executionMode: "providerNative",
    providerNative: {
      ...WEBSEARCH_PROVIDER_NATIVE_SPEC,
      args: toWebSearchProviderNativeArgs(input, {
        maxUses: DEFAULT_MAX_USES,
      }),
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    outputSchema: { type: "object" },
  };
}

/**
 * 把一个流式事件序列聚合成 ModelTextResult。
 *
 * 口径：只累积 text_delta；tool_call 全部收集（provider 原生搜索的结果以工具调用/结果形态
 * 出现，交给 websearch-results.ts 归一化）；finish 事件提供 finishReason / usage /
 * providerMetadata；error 事件立即抛出，**不**把它折成 finishReason——搜索失败必须让 tool_call
 * 得到失败结果，而不是一条内容为空的成功。
 * 副作用无；调用方负责在请求前后取时间戳。流被取消时由 abortSignal 终止迭代，异常自然上抛。
 */
async function collectWebSearchStreamResult(input: {
  events: AsyncIterable<ModelStreamEvent>;
}): Promise<ModelTextResult> {
  let text = "";
  let finishReason = "unknown";
  let providerMetadata: Record<string, unknown> | undefined;
  let usage: ModelUsage = {};
  const toolCalls: ModelToolCall[] = [];

  for await (const event of input.events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "tool_call":
        toolCalls.push(event.toolCall);
        break;
      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;
      case "error":
        throw normalizeStreamError(event.error);
    }
  }

  return {
    finishReason,
    providerMetadata,
    text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

// 流内错误归一化：已经是 Error 就原样保留（不丢 provider 的错误类型与 stack），只有非 Error
// 的裸值才包装成 recoverable 的 ModelError。刻意不在这里改写成成功/空结果——失败语义必须
// 一路传到 executor，才能维持「每个 tool_call 有配对结果」。
function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return createCoreError(CoreErrorType.ModelError, "WebSearch stream failed", {
    context: { error },
    recoverable: true,
  });
}
