// ==== model/runner-options.ts ====
// 定位：把 Core 的模型请求与已解析 provider 配置组装成 AI SDK generate/stream 选项。
// 输入：AiSdkModelTextRequest、ResolvedAiSdkModel、statusContext，以及可选 env/Anthropic userId。
// 输出：AiSdkGenerateTextOptions / AiSdkStreamTextOptions，undefined 字段会被剔除。
// 副作用：无 IO；仅构造普通对象与 AI SDK 的 Output/jsonSchema 包装。
// 失败语义：jsonSchema/Output 构造可能抛错；消息/工具转换的非法输入由下游转换函数抛出。
// 不变量：maxRetries=0（重试由 runner 统一控制）；请求头按 toolSearch→attribution 合并并剔除 query-source；
//           providerOptions 以 resolved 为底、request 覆盖。
import { Output, jsonSchema } from "ai";
import type { ModelToolChoice } from "@zcode/contracts";
import type { EnvRecord } from "./model-execution.js";
import { toolSearchHeaders } from "./tool-search.js";
import { toAiSdkMessages } from "./transform.js";
import { toAiSdkTools } from "./tool-transform.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createModelRequestAttributionHeaders, type ModelStatusContext } from "./runner-status.js";
import { withoutModelQuerySourceHeader } from "./model-request-headers.js";

type ExperimentalIncludeWithResponseBody = {
  requestBody?: boolean;
  responseBody?: boolean;
};

/**
 * 判断流式请求是否必须保留 response.body。
 * 仅 openai-compatible 且账号模式为 start-plan 时需要：zcode-plan 的业务码常只出现在
 * finish chunk 的 response.body 中，不开启则流式路径拿不到错误码。
 */
/** zcode-plan 业务码常只出现在 finish chunk 的 response.body，流式路径需显式开启。 */
export function shouldIncludeStreamResponseBody(resolved: ResolvedAiSdkModel): boolean {
  return (
    resolved.providerKind === "openai-compatible" && resolved.accountAccess?.mode === "start-plan"
  );
}

/**
 * 合并 provider 头与请求归因头。
 * 归因头后写，确保同名的 query-source 等静态值被正确覆盖；
 * 这里刻意不做大小写通用去重，避免改变旧归因头在 SDK 内的合并结果。
 */
function mergeRequestHeaders(
  providerHeaders: Record<string, string> | undefined,
  attributionHeaders: Record<string, string>,
): Record<string, string> {
  // 通用大小写去重会改变旧归因头的 SDK 合并结果；本次只剔除 query-source 静态值。
  return {
    ...withoutModelQuerySourceHeader(providerHeaders),
    ...attributionHeaders,
  };
}

/**
 * 构造 generateText 的 AI SDK 选项。
 * 依次合并 providerOptions、注入 Anthropic metadata、按需改写结构化输出格式，
 * 再转换 messages/tools 并附加工具搜索头与归因头。
 * includeModelIO 决定是否额外采集请求/响应 body 用于调试，默认关闭以减少开销。
 * 返回对象中值为 undefined 的字段被移除，避免 AI SDK 误判“显式未设置”。
 */
export function createGenerateTextOptions(input: {
  /** Anthropic 专用：写入 metadata.userId；仅 anthropic provider 生效。 */
  anthropicMetadataUserId?: string;
  /** 环境变量快照，保留给 provider 扩展使用。 */
  env?: EnvRecord;
  /** 是否采集请求/响应 body（调试与失败分析用）。 */
  includeModelIO: boolean;
  /** 本次 Core 侧模型请求。 */
  request: AiSdkModelTextRequest;
  /** 已解析的 provider/模型配置（含 model 实例、properties、headers）。 */
  resolved: ResolvedAiSdkModel;
  /** 请求归因上下文（requestId/modelId/providerKind 等）。 */
  statusContext: ModelStatusContext;
}): AiSdkGenerateTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const providerOptionsWithMetadata = mergeAnthropicRequestMetadata({
    metadataUserId: input.anthropicMetadataUserId,
    providerKind: input.resolved.providerKind,
    providerOptions,
  });
  const requestProviderOptions = withNativeGenerateOutputFormat({
    providerOptions: providerOptionsWithMetadata,
    responseJsonSchema: input.request.responseJsonSchema,
    resolved: input.resolved,
  });
  return removeUndefined({
    model: input.resolved.model,
    messages: toAiSdkMessages(input.request.messages, {
      toolSearchEnabled: input.request.toolSearchEnabled,
      apiFormat: resolveProviderApiFormat(providerOptions),
      providerOptions,
      providerKind: input.resolved.providerKind,
      inputFormat: input.resolved.properties?.inputFormat,
    }),
    tools: toAiSdkTools(input.request.tools, {
      toolSearchEnabled: input.request.toolSearchEnabled,
      providerKind: input.resolved.providerKind,
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    output: input.request.responseJsonSchema
      ? Output.object({ schema: jsonSchema(input.request.responseJsonSchema) })
      : undefined,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    headers: mergeRequestHeaders(
      toolSearchHeaders(input.resolved.headers, input.request.toolSearchEnabled),
      createModelRequestAttributionHeaders(input.statusContext),
    ),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
    experimental_include: input.includeModelIO
      ? {
          requestBody: true,
          responseBody: true,
        }
      : undefined,
  }) as AiSdkGenerateTextOptions;
}

/**
 * 构造 streamText 的 AI SDK 选项。
 * 与 generateText 共享 messages/tools/header 组装逻辑，但额外开启 raw chunk
 * （preserveProviderStreamBoundaries 时为 true）以便 adapter 观察 SSE 边界，
 * 并按账号模式决定是否保留 responseBody 供业务错误分类。
 */
export function createStreamTextOptions(input: {
  /** Anthropic 专用：写入 metadata.userId；仅 anthropic provider 生效。 */
  anthropicMetadataUserId?: string;
  /** 环境变量快照，保留给 provider 扩展使用。 */
  env?: EnvRecord;
  /** 是否采集请求/响应 body（调试与失败分析用）。 */
  includeModelIO: boolean;
  /** 本次 Core 侧模型请求。 */
  request: AiSdkModelTextRequest;
  /** 已解析的 provider/模型配置（含 model 实例、properties、headers）。 */
  resolved: ResolvedAiSdkModel;
  /** 请求归因上下文（requestId/modelId/providerKind 等）。 */
  statusContext: ModelStatusContext;
}): AiSdkStreamTextOptions {
  const providerOptions = mergeProviderOptions(
    input.resolved.providerOptions,
    input.request.providerOptions,
  );
  const requestProviderOptions = mergeAnthropicRequestMetadata({
    metadataUserId: input.anthropicMetadataUserId,
    providerKind: input.resolved.providerKind,
    providerOptions,
  });
  return removeUndefined({
    model: input.resolved.model,
    messages: toAiSdkMessages(input.request.messages, {
      toolSearchEnabled: input.request.toolSearchEnabled,
      apiFormat: resolveProviderApiFormat(providerOptions),
      providerOptions,
      providerKind: input.resolved.providerKind,
      inputFormat: input.resolved.properties?.inputFormat,
    }),
    tools: toAiSdkTools(input.request.tools, {
      toolSearchEnabled: input.request.toolSearchEnabled,
      providerKind: input.resolved.providerKind,
      modelId: input.resolved.modelId,
      requiresMfjsToolSchema: input.resolved.properties.requiresMfjsToolSchema,
      supportsNativeWebSearch: input.resolved.properties.supportsNativeWebSearch,
    }),
    toolChoice: toAiSdkToolChoice(input.request.toolChoice),
    temperature: input.request.temperature,
    topP: input.request.topP,
    topK: input.request.topK,
    presencePenalty: input.request.presencePenalty,
    frequencyPenalty: input.request.frequencyPenalty,
    stopSequences: input.request.stopSequences,
    seed: input.request.seed,
    providerOptions: requestProviderOptions,
    abortSignal: input.request.abortSignal,
    headers: mergeRequestHeaders(
      toolSearchHeaders(input.resolved.headers, input.request.toolSearchEnabled),
      createModelRequestAttributionHeaders(input.statusContext),
    ),
    // ZCode owns system-message construction in core/context. Keep AI SDK from
    // printing its generic system-message warning to process stderr.
    allowSystemInMessages: true,
    maxRetries: 0,
    // AI SDK 会吞掉 Anthropic message_start 等 metadata 事件；compact 需要
    // 在 adapter 内观察 raw event 才能精确结束 SSE retry，raw chunk 不会上送 Core/UI。
    includeRawChunks: input.request.preserveProviderStreamBoundaries ? true : undefined,
    // zcode-plan 的业务码可能只在流式响应尾部 body 里，需保留 responseBody 供错误分类读取。
    experimental_include: createStreamExperimentalInclude(input),
  }) as AiSdkStreamTextOptions;
}

/**
 * 计算流式请求的 experimental_include。
 * 完整 model IO 采集优先；否则仅在 zcode-plan 场景保留 responseBody。
 */
function createStreamExperimentalInclude(input: {
  includeModelIO: boolean;
  resolved: ResolvedAiSdkModel;
}): ExperimentalIncludeWithResponseBody | undefined {
  if (input.includeModelIO) {
    // 调试模式需要完整请求/响应体，覆盖仅 responseBody 的最小采集。
    return {
      requestBody: true,
      responseBody: true,
    };
  }
  return shouldIncludeStreamResponseBody(input.resolved) ? { responseBody: true } : undefined;
}

/** 把 Core 的 toolChoice 透传给 AI SDK；两者形状一致，仅做类型适配。 */
function toAiSdkToolChoice(
  toolChoice?: ModelToolChoice,
): AiSdkGenerateTextOptions["toolChoice"] | undefined {
  return toolChoice as AiSdkGenerateTextOptions["toolChoice"] | undefined;
}

/**
 * 浅合并 providerOptions。
 * request 侧覆盖 resolved 侧；两边都缺失时返回 undefined 以免生成空对象。
 */
function mergeProviderOptions(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...base,
    ...override,
  };
}

/**
 * 为 Anthropic 结构化输出补 outputFormat 模式。
 * 仅在存在 responseJsonSchema 且 providerKind=anthropic 时生效；
 * 显式指定可避免 Lite 模型不在 AI SDK 静态能力表时退化为 JSON tool。
 */
function withNativeGenerateOutputFormat(input: {
  providerOptions: Record<string, unknown> | undefined;
  resolved: ResolvedAiSdkModel;
  responseJsonSchema: AiSdkModelTextRequest["responseJsonSchema"];
}): Record<string, unknown> | undefined {
  if (!input.responseJsonSchema || input.resolved.providerKind !== "anthropic") {
    return input.providerOptions;
  }

  const anthropicOptions = asPlainRecord(input.providerOptions?.anthropic);
  return {
    ...input.providerOptions,
    // Lite role 的真实模型 ID 可能不在 AI SDK 的静态能力表中；
    // 显式 schema 必须继续生成目标 output_config，而不能退化成 JSON tool。
    anthropic: { ...anthropicOptions, structuredOutputMode: "outputFormat" },
  };
}

/**
 * 把 Anthropic 请求级 metadata.userId 合并进 providerOptions。
 * 非 anthropic 或未提供 userId 时原样返回；已存在的 metadata 字段保留。
 */
function mergeAnthropicRequestMetadata(input: {
  metadataUserId: string | undefined;
  providerKind: ResolvedAiSdkModel["providerKind"];
  providerOptions: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  if (input.providerKind !== "anthropic" || input.metadataUserId === undefined) {
    return input.providerOptions;
  }

  const anthropicOptions = asPlainRecord(input.providerOptions?.anthropic) ?? {};
  const metadata = asPlainRecord(anthropicOptions.metadata) ?? {};
  return {
    ...input.providerOptions,
    anthropic: {
      ...anthropicOptions,
      metadata: {
        ...metadata,
        userId: input.metadataUserId,
      },
    },
  };
}

/** 仅接受普通对象（排除 null 与数组），用于 providerOptions 的嵌套字段。 */
function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** 读取 providerOptions.apiFormat；非字符串视为未设置。 */
function resolveProviderApiFormat(providerOptions?: Record<string, unknown>): string | undefined {
  const apiFormat = providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

/**
 * 删除值为 undefined 的键。
 * AI SDK 用 undefined 表示“未设置”，但部分选项需要键完全缺席才走默认行为，
 * 因此在组装阶段统一过滤。
 */
function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}
