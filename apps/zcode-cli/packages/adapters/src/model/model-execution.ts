// 阅读导引：本文件按「binding 冻结 → factory 装配 → fetch 包装链 → 错误识别 → SSE 帧解析」自上而下展开。
// 请求生命周期：bindModel 冻结 Provider 事实；resolveSnapshot 每次重建 factory；resolveProviderTransport 复用无凭据网络层。
// 错误路径：非 2xx 先解析 JSON 业务码；2xx SSE 逐帧扫描 error frame；两类结果共用 ProviderBusinessError 与重试线索。
// 权衡：多包一层 fetch 换取诊断与重试能力，代价是每请求一次链式分配；允许缓存的只有不含凭据的网络层。
// INV-01 binding 冻结 Endpoint/协议/Header/providerOptions；守住位置：bindModel 与 captureModelSnapshot；改错故障：Registry 热更新后已建 Model 静默切端点，出现跨区计费或 401。
// INV-02 每次请求重建 factory，禁止按 providerId 缓存 factory；守住位置：resolveSnapshot；改错故障：配置热更新后串用旧 Endpoint 与旧 Key，请求打到已下线账号。
// INV-03 transport 缓存只允许落在无凭据的网络层；守住位置：resolveProviderTransport；改错故障：动态 Key 落入缓存后切换账号串号，A 用户请求被 B 用户凭据发出。
// INV-04 请求期鉴权只覆盖 apiKey 与 header；守住位置：applyModelRequestAuth；改错故障：覆盖 baseURL 或协议后同一 Model 在请求间漂移，出现间歇性 404。
// INV-05 zhipu-account 动态身份必须先清静态认证头再合并；守住位置：applyModelRequestAuth 的账号分支；改错故障：SDK 优先取旧凭据，鉴权失败或越权访问旧账号数据。
// INV-06 包装顺序不可交换：proxy → 端点路由 → 请求安全 → 业务错误 → 对话捕获 → option map → 兼容层；守住位置：createFactory；改错故障：捕获看到未改写请求体，诊断记录与实际发送不一致。
// INV-07 option map 必须早于对话捕获；守住位置：createFactory 的 fetch 组装；改错故障：记录的是 SDK 原始 body，复现时发现 provider 参数整段缺失。
// INV-08 捕获层必须包在业务错误层之外；守住位置：createFactory 的 conversationCapture 分支；改错故障：4xx/5xx 响应体不再入库，排障缺少上游原文只剩状态码。
// INV-09 2xx 响应内的业务错误必须先于正常返回判定；守住位置：createProviderBusinessErrorFetch；改错故障：错误被当成正常 completion，用户看到空白回答且无任何错误提示。
// INV-10 非 2xx 一律尝试解析业务 JSON，不依赖 Content-Type；守住位置：responseMayContainBusinessJson 与 detectProviderBusinessError；改错故障：403 携带 3007 时被原样透传，流式以空 completion 收尾并被误报为可疑空回复。
// INV-11 已识别的错误体需完整消费但要有 1s 上限；守住位置：consumeBusinessErrorResponseBodyBestEffort；改错故障：只 cancel 分支会耗尽连接槽，不设上限则异常流拖死已解析出的原始错误。
// INV-12 读取响应体必须走 clone 且限 64KB；守住位置：readLimitedResponseText；改错故障：消费原始流会破坏后续转发，不限长则大响应拖爆内存。
// INV-13 reader 锁必须在 finally 释放；守住位置：readLimitedResponseText 的读取循环；改错故障：中途 return 后连接永久挂起，后续请求排队超时。
// INV-14 SSE 只在完整分隔符之后切帧；守住位置：emitCompleteProviderBusinessSseFrames；改错故障：半帧被误判为错误帧或真实错误被漏判，回答中途断流。
// INV-15 命中错误帧后必须阻断后续写出；守住位置：SSE transform 的 transform 与 flush；改错故障：错误之后继续写出使流状态非法，SDK 抛出二次异常掩盖原始错误。
// INV-16 未闭合的尾帧必须在 flush 结算；守住位置：createProviderBusinessErrorSseTransform；改错故障：结尾错误帧丢失，用户看到截断回答却拿不到任何错误。
// INV-17 业务错误必须保留 responseHeaders；守住位置：detectProviderBusinessError 与 emitProviderBusinessSseFrame；改错故障：丢掉 retry-after 后限流退避退化为固定间隔，连发 429。
// INV-18 包装码 PROVIDER_BUSINESS_ERROR 不得覆盖真实上游码；守住位置：toProviderCode；改错故障：重试分类与告警全部落到同一包装码，真实 3007 与 3002 不可见。
// INV-19 业务码只在 100 到 599 之间才映射为 HTTP status；守住位置：providerCodeToStatusCode；改错故障：3007 被当成状态码，触发错误重试策略或无谓长退避。
// INV-20 Anthropic baseURL 必须补齐 /v1；守住位置：normalizeAnthropicBaseURL；改错故障：网关根地址缺前缀导致 404，或重复前缀导致路径拼接错误。
import { withoutRequestVerificationHeaders } from "@zcode/shared";
/* eslint-disable max-lines -- AI SDK 模型执行装配集中维护 provider factory、鉴权和网络错误适配，拆分会让状态同步更脆弱。 */
// ============================================================
// Vercel AI SDK model execution
// ============================================================
// 定位：把 Registry Provider 配置装配成 AI SDK LanguageModel，并组织代理/鉴权/端点路由/业务错误识别的 fetch 链。
// 输入：AiSdkModelExecutionConfig（env/network/capture/routing）与请求期 options/optionMaps/requestAuth。
// 输出：AiSdkBoundModelResolution（冻结基础模型 + 按请求解析的 resolveRequest）。
// 副作用：构造 Provider SDK、读取 env、按 Provider 缓存 transport；本模块不主动发起请求。
// 失败语义：不支持的 api.type 抛 Error；provider 业务错误统一转 ProviderBusinessError（保留 status/headers）。
// 不变量：binding 冻结 Endpoint/协议/Header/option 规格；requestAuth 只覆盖 apiKey/header；fetch 包装顺序不可交换。
// ============================================================

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionValues,
} from "@zcode/model-option-map";
import {
  type Logger,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
  type ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { withOpenRouterAttributionHeaders } from "@zcode/shared";
import { createAnthropicCompatFetch } from "./anthropic-stream-compat.js";
import {
  createConversationCaptureFetch,
  type ConversationCapturePort,
} from "../conversation-recording/index.js";
import { createModelRequestSecurityState } from "./request-security-edition/index.js";
import type { ModelRequestSecurityState, ModelRequestSecurityPort } from "./request-security.js";
import { createOpenAIResponsesJsonCompatFetch } from "./openai-responses-json-compat.js";
import { createModelOptionMapFetch, type RawRequestBodyCapture } from "./model-option-map-fetch.js";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { createProviderEndpointRoutingFetch } from "./provider-endpoint-routing-fetch.js";
import { normalizeModelTlsFailure } from "./failure-tls.js";
import {
  mergeModelRequestHeaders,
  withoutModelAuthHeaders,
  withoutModelQuerySourceHeader,
} from "./model-request-headers.js";

/** AI SDK Provider 适配类别：anthropic / openai responses / openai-compatible chat。 */
export type AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible";

/** 进程环境变量快照；值可为 undefined（表示未设置，与空字符串不同）。 */
export type EnvRecord = Record<string, string | undefined>;

/** Provider 在 Model binding 期冻结下来的静态装配参数。 */
interface AiSdkProviderConfig {
  /** Registry 的鉴权描述（含 zhipu-account 等动态账号模式）。 */
  access: RegistryProviderConfig["access"];
  /** 使用的 AI SDK provider 类别。 */
  kind: AiSdkProviderKind;
  /** 静态 API Key；zhipu-account 等动态凭据模式可能为空。 */
  apiKey?: string;
  /** Provider API 根地址（Anthropic 会在装配时补 /v1）。 */
  baseURL: string;
  /** 合并后的请求头，含来源与归因两类（x-zcode-*）；缺省表示不额外发送。 */
  headers?: Record<string, string>;
  /** 传给 SDK 的 provider options（例如 apiFormat）。 */
  providerOptions?: Record<string, unknown>;
  /** openai-compatible 的 provider 名称；缺省回退 providerId。 */
  name?: string;
}

/** 构造 AiSdkModelExecution 的静态配置；除 env 外均为可选。 */
export interface AiSdkModelExecutionConfig {
  /** 完整对话记录的 provider 原始交换旁路；缺席时不记录。 */
  conversationCapture?: ConversationCapturePort;
  /** 执行环境提供的默认来源信息，不属于 Provider 持久化配置。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  /** provider 端点路由端口；提供时按请求插入路由 fetch。 */
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  /** 环境变量来源；缺省使用 process.env。 */
  env?: EnvRecord;
  /** 网络配置（CA/代理/NO_PROXY）。 */
  network?: AiSdkNetworkConfig;
}

/** 运行时注入项：请求安全状态、日志与基础 transport（测试可替换）。 */
export interface AiSdkModelExecutionOptions {
  /** 请求安全状态（用于保护 transport 与观测）；缺省新建一份。 */
  requestSecurityState?: ModelRequestSecurityState;
  /** 诊断日志端口（Logger）；缺席时调用方不记录请求级事件。 */
  logger?: Logger;
  /** 最底层 fetch；缺省使用 globalThis.fetch。 */
  transport?: ProviderFetch;
}

/** 网络出口配置：所有字段缺省时交给 fetch/系统代理行为决定。 */
export interface AiSdkNetworkConfig {
  /** 自定义 CA 证书文件路径。 */
  caCertFile?: string;
  /** 显式 HTTP(S) 代理地址。 */
  httpProxy?: string;
  /** 代理绕过列表（NO_PROXY 语法）；为空表示所有目标都走 httpProxy。 */
  noProxy?: string;
}

/** 解析完成、可直接交给 AI SDK 调用的模型与请求侧事实快照。 */
export interface AiSdkResolvedModel {
  /** 实际生效的 Provider 根地址（含请求期鉴权后的覆盖）。 */
  baseURL?: string;
  /** headers 为请求期最终生效的请求头：鉴权覆盖已并入，与 resolved 快照一致。 */
  headers?: Record<string, string>;
  /** Provider 标识。 */
  providerId: ModelProviderId;
  /** 模型标识。 */
  modelId: ModelId;
  /** AI SDK LanguageModel 实例。 */
  model: LanguageModel;
  /** Provider 协议类别。 */
  providerKind: AiSdkProviderKind;
  /** binding 冻结的 provider options。 */
  providerOptions?: Record<string, unknown>;
  /** option-map fetch 回填 raw request body 的容器；供 model-io 诊断读取。 */
  rawRequestBodyCapture?: RawRequestBodyCapture;
  /** 请求安全观测端口（失败排障/脱敏使用）。 */
  requestObservations?: ModelRequestSecurityPort;
}

/** bindModel 的返回值：冻结的基础模型 + 每次请求可重新解析的入口。 */
export interface AiSdkBoundModelResolution {
  /** 不携带请求 options 的基础模型，仅用于能力探测/占位。 */
  readonly resolved: AiSdkResolvedModel;
  /** 按本次请求的 option values 与动态鉴权重新解析模型；不得复用旧 binding 的缓存。 */
  resolveRequest(input: {
    readonly options: ModelOptionValues;
    readonly requestAuth?: ModelRequestAuth;
  }): AiSdkResolvedModel;
}

type LanguageModelFactory = (modelId: string) => LanguageModel;
type ProviderFetch = typeof globalThis.fetch;
type ProviderCode = string | number;

/** createProviderBusinessErrorFetch 的参数：网络配置 + provider 身份 + 可选端点路由。 */
export interface ProviderBusinessErrorFetchOptions {
  /** 自定义 CA 证书。 */
  caCertFile?: string;
  /** 提供时在代理 fetch 之上再包一层端点路由。 */
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  /** 环境变量快照，供 proxy 判定与 HTTPS_PROXY 回退读取。 */
  env?: EnvRecord;
  /** Provider 标识，写入 ProviderBusinessError。 */
  providerId: string;
  /** Provider 协议类别，用于归类错误。 */
  providerKind: AiSdkProviderKind;
  /** 底层 fetch；缺省 globalThis.fetch。 */
  fetch?: ProviderFetch;
  /** 显式代理地址；与 env 中的 HTTPS_PROXY 同时存在时优先本字段。 */
  httpProxy?: string;
  /** 代理绕过列表（NO_PROXY 语法）；为空表示所有目标都走 httpProxy。 */
  noProxy?: string;
}

/** 构造 ProviderBusinessError 的字段；providerCode 与 statusCode 用于重试分类。 */
export interface ProviderBusinessErrorOptions {
  /** 上游业务码（数字或字符串），非 HTTP status。 */
  providerCode?: ProviderCode;
  /** Provider 标识。 */
  providerId: string;
  /** Provider 协议类别。 */
  providerKind: AiSdkProviderKind;
  /** 上游错误消息（已归一化并限长）。 */
  providerMessage?: string;
  /** 上游 request id，供日志关联。 */
  providerRequestId?: string;
  /** 响应体摘要（只保留白名单标量字段）。 */
  responseBodySummary?: Record<string, unknown>;
  /** 原始响应头（保留 retry-after 等重试线索）。 */
  responseHeaders?: Record<string, string>;
  /** HTTP 响应状态（transport 层硬证据）。 */
  responseStatus?: number;
  /** 从业务码反推的 HTTP status；可能缺失。 */
  statusCode?: number;
}

/**
 * Provider 业务错误（HTTP 200 也可能出现）：由 fetch 层识别后抛出，绕过 AI SDK 的 APICallError。
 * 保留 responseStatus/responseHeaders，使 retry-after 与 HTTP 状态仍进入重试分类；
 * 标记 isProviderBusinessError，便于 failure-classifier 跨模块识别。
 */
export class ProviderBusinessError extends Error {
  readonly code = "PROVIDER_BUSINESS_ERROR";
  readonly isProviderBusinessError = true;
  readonly providerCode?: ProviderCode;
  readonly providerId: string;
  readonly providerKind: AiSdkProviderKind;
  readonly providerMessage?: string;
  readonly providerRequestId?: string;
  readonly responseBodySummary?: Record<string, unknown>;
  readonly responseHeaders?: Record<string, string>;
  readonly responseStatus?: number;
  readonly statusCode?: number;

  constructor(options: ProviderBusinessErrorOptions) {
    const providerMessage =
      normalizeProviderMessage(options.providerMessage) ?? "Provider returned a business error.";
    super(providerMessage);
    this.name = "ProviderBusinessError";
    this.providerCode = options.providerCode;
    this.providerId = options.providerId;
    this.providerKind = options.providerKind;
    this.providerMessage = providerMessage;
    this.providerRequestId = options.providerRequestId;
    this.responseBodySummary = options.responseBodySummary;
    this.responseHeaders = options.responseHeaders;
    this.responseStatus = options.responseStatus;
    this.statusCode = options.statusCode;
  }
}

/** 判定任意错误是否为 ProviderBusinessError（兼容 instanceof 与跨 realm 的结构标记）。 */
export function isProviderBusinessError(error: unknown): error is ProviderBusinessError {
  if (error instanceof ProviderBusinessError) {
    return true;
  }

  const record = asRecord(error);
  return record?.isProviderBusinessError === true && record.name === "ProviderBusinessError";
}

const MAX_BUSINESS_ERROR_BODY_CHARS = 64_000;
const MAX_PROVIDER_MESSAGE_CHARS = 1_000;
const PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS = 1_000;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";
const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;
const AUTHORIZATION_HEADER_NAME = "Authorization";

/**
 * AI SDK 模型执行装配器：持有 env/网络/请求安全/对话捕获等长期配置。
 * 核心职责是把 Registry Provider 冻结成 binding，并在每次请求时按 option/鉴权重解析模型。
 * 本类不持有单次请求状态；transport 按 Provider 缓存，动态凭据放在请求期 fetch 包装里。
 */
// 生命周期：实例与进程同寿，只持有 env、网络配置、请求安全上下文与 transport 缓存。
// 状态边界：不保存任何单次请求状态，并发请求互不可见，避免流串台与计量混淆。
// 缓存代价：transport 按 providerId 命中，省去每请求重建代理 agent，但必须保证缓存内无动态凭据。
// 构造期约定：不发起网络请求，配置错误延迟到首次发包才暴露，CLI 启动不被网络状况拖累。
export class AiSdkModelExecution {
  private readonly conversationCapture?: ConversationCapturePort;
  private readonly env: EnvRecord;
  private readonly defaultHeaders: Record<string, string>;
  private readonly network: AiSdkNetworkConfig;
  private readonly endpointRoutingPort?: ProviderEndpointRoutingPort;
  private readonly logger?: Logger;
  private readonly baseTransport?: ProviderFetch;
  private readonly providerTransports = new Map<string, ProviderFetch>();
  private readonly requestSecurity: ModelRequestSecurityPort;

  /** 保存装配配置并创建请求安全执行上下文；不做任何网络初始化。 */
  constructor(config: AiSdkModelExecutionConfig = {}, options: AiSdkModelExecutionOptions = {}) {
    this.conversationCapture = config.conversationCapture;
    this.env = config.env ?? process.env;
    this.defaultHeaders = { ...config.defaultHeaders };
    this.network = { ...config.network };
    this.endpointRoutingPort = config.endpointRoutingPort;
    this.logger = options.logger;
    this.baseTransport = options.transport;
    this.requestSecurity = (
      options.requestSecurityState ?? createModelRequestSecurityState()
    ).createExecution({ logger: options.logger });
  }

  /**
   * 固定一个 Model 创建时使用的 Provider 静态事实。
   *
   * 请求期鉴权只覆盖 API Key 与 Header；Registry 后续热更新不会让已经创建的
   * Model 静默切换 Endpoint、协议、Provider Options 或 SDK Factory。
   */
  // 入参契约：providerConfig 是 Registry 快照，读取后即复制，调用方后续修改不影响已绑定模型。
  // 冻结范围：Endpoint、协议类别、静态 Header、providerOptions 与结构化输出能力一次性定稿。
  // 返回契约：resolved 不含请求选项，仅用于能力探测，真实请求必须走 resolveRequest 补齐选项。
  // 并发语义：bindModel 可被多次调用，每次产出独立快照，不共享编译后的 option map。
  // 失败路径：Registry 出现未知 api.type 时在快照阶段抛错，不允许降级到某个默认协议继续跑。
  bindModel(input: {
    /** Provider 标识，binding 后不再变更。 */
    readonly providerId: string;
    /** 模型标识（能力归属按此绑定）。 */
    readonly modelId: string;
    /** Registry 中的 Provider 配置快照；binding 期读取 Endpoint/协议/Header。 */
    readonly providerConfig: RegistryProviderConfig;
    /** Registry 声明的结构化输出能力，冻结后传给 openai-compatible。 */
    readonly supportsJsonSchemaOutput: boolean;
    /** 两个 option 到 provider 字段的映射表规格；编译后用于每次请求 patch body。 */
    readonly optionSpecs: {
      readonly reasoningLevel: { readonly map: string };
      readonly maxOutputTokens: { readonly map: string };
    };
  }): AiSdkBoundModelResolution {
    const snapshot = this.captureModelSnapshot(input);
    const optionMaps = compileModelOptionMaps(input.optionSpecs);
    return {
      // 这里只构造不执行请求的基础 Model；真正请求必须通过 resolveRequest 绑定完整 options。
      resolved: this.resolveSnapshot(snapshot, undefined, undefined, undefined),
      resolveRequest: ({ options, requestAuth }) =>
        this.resolveSnapshot(snapshot, requestAuth, optionMaps, options),
    };
  }

  /** 把 Registry 配置转为内部 Provider 配置，并合并默认来源头、解析静态 API Key。 */
  private captureModelSnapshot(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly supportsJsonSchemaOutput: boolean;
  }): AiSdkModelSnapshot {
    const configuredProvider = toAiSdkProviderConfig(input.providerId, input.providerConfig);
    // 重构后模型 SDK 曾只接到用户 Header，漏掉版本和站点归因；在公共绑定边界恢复，
    // 不依赖签名成功，不给各业务重复补头，也不修改 Provider 或已绑定 Model 的配置。
    configuredProvider.headers = mergeModelRequestHeaders(
      withOpenRouterAttributionHeaders(this.defaultHeaders, configuredProvider.baseURL),
      configuredProvider.headers,
    );
    const apiKey = this.resolveApiKey(configuredProvider);
    return {
      providerConfig: {
        ...configuredProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(configuredProvider.headers ? { headers: { ...configuredProvider.headers } } : {}),
        ...(configuredProvider.providerOptions
          ? { providerOptions: { ...configuredProvider.providerOptions } }
          : {}),
      },
      providerId: input.providerId as ModelProviderId,
      modelId: input.modelId as ModelId,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput,
    };
  }

  /**
   * 按 binding 快照 + 请求期鉴权/options 生成一次可调用的模型。
   * 每次调用都重建 factory，绝不能按 providerId 缓存（否则配置热更新后会串用旧 Endpoint/Key）。
   */
  // 关键约束：每次调用都重建 factory，绝不复用上一次的 SDK 实例，因为 SDK 会缓存 baseURL 与 headers。
  // 鉴权叠加：先应用请求期鉴权再交给 factory，保证 factory 内读到的 Key 与 Header 就是本次要用的。
  // 能力事实：结构化输出能力取自 binding 快照，不回查 Registry，避免同一会话内能力莫名翻转。
  // 诊断容器：每次解析新建 rawRequestBodyCapture，把本次实际发送体交给 model-io 层读取。
  // 账号路由：仅 zhipu-account 模式把 apiKeyId 传入 factory，供端点路由按账号选路。
  // 副作用：不发起网络请求也不写进程级状态，失败只可能来自请求安全层或路由层的装配。
  private resolveSnapshot(
    snapshot: AiSdkModelSnapshot,
    requestAuth: ModelRequestAuth | undefined,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
  ): AiSdkResolvedModel {
    const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);
    // Model 创建时的 Provider 事实必须被冻结在当前 binding 中。若按 providerId 缓存
    // factory，配置更新后创建的新 Model 会错误复用旧 Endpoint / Header / API Key。
    const rawRequestBodyCapture: RawRequestBodyCapture = {};
    const factory = this.createFactory(
      snapshot.providerId,
      snapshot.modelId,
      providerConfig,
      optionMaps,
      optionValues,
      rawRequestBodyCapture,
      snapshot.supportsJsonSchemaOutput,
      snapshot.providerConfig.access?.type === "zhipu-account" ? requestAuth?.apiKeyId : undefined,
    );
    return {
      baseURL: providerConfig.baseURL,
      headers: providerConfig.headers,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      model: factory(snapshot.modelId.toString()),
      providerKind: providerConfig.kind,
      providerOptions: providerConfig.providerOptions,
      rawRequestBodyCapture,
      requestObservations: this.requestSecurity,
    };
  }

  /**
   * 按 Provider 类别创建 AI SDK factory，并组装从网络到业务错误识别的 fetch 包装链。
   * 包装顺序：proxy → 端点路由 → 请求安全 → 业务错误 → 对话捕获 → option map → provider 兼容层。
   * option map 必须在捕获之前（捕获看到的是 provider 实际发送体）。
   */
  // 装配目标：把 provider 配置与请求期选项合成为可直接产出 LanguageModel 的 factory。
  // 通道方向：从网络出口向内逐层包装，每层只依赖内层，顺序交换会让错误归类与诊断一起错位。
  // Header 处理：先剥离查询来源头再交给 SDK 默认合并，否则 SDK 会把来源头补回去造成伪归因。
  // 请求隔离：apiKeyId 只用于本次 attempt 的路由层，不写入 transport 缓存，切换账号不会串路。
  // option map 位置：位于捕获内层、兼容层外层，看到的是 provider 最终发送体。
  // 捕获位置：包住业务错误层，既能拿到改写后的请求，也能拿到尚未转换的原始错误响应。
  // 协议分支：三类 SDK factory 各自补齐鉴权头与 baseURL 归一化，未知类别由上游映射提前拦截。
  // 资源权衡：每请求多一次链式闭包分配，换取重试线索与可观测性，成本远低于一次 HTTP 往返。
  private createFactory(
    providerId: string,
    modelId: string,
    providerConfig: AiSdkProviderConfig,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
    rawRequestBodyCapture: RawRequestBodyCapture,
    supportsJsonSchemaOutput: boolean,
    apiKeyId?: string,
  ): LanguageModelFactory {
    const apiKey = this.resolveApiKey(providerConfig);
    // SDK 会合并 factory 默认 header；必须在这里去掉静态来源，才能保证缺失时真正省略。
    const headers = withoutModelQuerySourceHeader(providerConfig.headers);
    // 复用策略：同一 provider 共享网络层，连接池与代理 agent 才能跨请求复用。
    // 不可缓存项：鉴权、账号路由、请求体改写都属于单次 attempt，必须留在外层包装。
    // 失败路径：代理或 CA 配置错误在首次发包时暴露，缓存不会掩盖该类错误。
    const networkTransport = this.resolveProviderTransport(providerId);
    // ID 属于当前 attempt，不能放入按 Provider 缓存的 transport，避免切换账号后串用。
    const providerTransport = this.endpointRoutingPort
      ? createProviderEndpointRoutingFetch({
          fetch: networkTransport,
          routingPort: this.endpointRoutingPort,
          apiKeyId,
        })
      : networkTransport;
    // 安全层职责：发包前注入或剥离敏感头，并把观测点挂在真实 transport 之外。
    // 顺序约束：安全层必须包在路由层外，否则按账号改写后的请求会绕过脱敏与观测。
    const requestTransport = this.requestSecurity.protectTransport({
      providerId,
      providerConfig,
      transport: providerTransport,
    });
    // 识别层位置：位于安全层之外、捕获层之内，先于 AI SDK 看到响应。
    // 转换理由：SDK 的 APICallError 会丢失上游业务码与 retry-after，因此在此提前转成 ProviderBusinessError。
    const businessErrorFetch = createProviderBusinessErrorFetch({
      fetch: requestTransport,
      providerId,
      providerKind: providerConfig.kind,
    });
    // 捕获必须位于 option map **之后**：optionFetch 看到的是 provider 实际发送体，
    // 而 SDK 调用点在 map 之前。包装 businessErrorFetch 可拿到已 patch 的请求与原始响应，
    // 且仍早于 provider 业务错误转换，4xx/5xx 的响应体也能被记录。
    // 可选旁路：未注入 conversationCapture 时直接沿用业务错误层，不增加任何包装。
    // 记录对象：请求体是 option map 改写后的发送体，响应体是业务错误转换前的原文。
    // 归属信息：包装时带上 providerId 与 modelId，记录可按模型维度归档而不是只能按供应商。
    // 隔离要求：捕获实现不得吞掉或替换响应，主链路的错误必须原样继续上抛。
    const fetch = this.conversationCapture
      ? createConversationCaptureFetch({
          capture: this.conversationCapture,
          fetch: businessErrorFetch,
          modelId,
          providerId,
        })
      : businessErrorFetch;
    // 改写职责：按本次选项把 reasoning 与 maxOutputTokens 映射进请求体，映射表在 binding 期已编译。
    // 缺省语义：未提供映射表或选项值时跳过该层，请求体保持 SDK 原始形态。
    const optionFetch =
      optionMaps && optionValues
        ? createModelOptionMapFetch({
            capture: rawRequestBodyCapture,
            fetch,
            maps: optionMaps,
            values: optionValues,
          })
        : fetch;

    switch (providerConfig.kind) {
      case "openai": {
        const provider = createOpenAI({
          apiKey,
          baseURL: providerConfig.baseURL,
          fetch: createOpenAIResponsesJsonCompatFetch(optionFetch),
          headers,
        });
        return provider.responses as LanguageModelFactory;
      }

      // 路径约束：baseURL 先补 /v1，SDK 再拼 /messages，缺前缀会打到错误路径。
      // 鉴权头：显式 Authorization 优先，缺失时补 Bearer，兼容只读 x-api-key 的网关。
      // 兼容层位置：Anthropic 流式兼容包装位于链的最外层，先接收 SDK 调用再向内交棒。
      case "anthropic": {
        const provider = createAnthropic({
          apiKey,
          baseURL: normalizeAnthropicBaseURL(providerConfig.baseURL),
          fetch: createAnthropicCompatFetch(optionFetch),
          headers: withAnthropicAuthorizationHeader(apiKey, headers),
        });
        return provider as LanguageModelFactory;
      }

      // 用量语义：显式开启 includeUsage，否则流式响应缺少 token 计数，用量统计退化为估算。
      // 结构化输出：能力标志来自 binding，缺省时 SDK 静默降级为 JSON object，调用方等于失去 schema 约束。
      // 名称来源：name 缺省回退 providerId，只影响日志与 SDK 内部命名，不影响请求地址。
      // 协议约束：该分支只服务 openai-chat-completions，混入 responses 语义会导致字段被静默忽略。
      case "openai-compatible": {
        const provider = createOpenAICompatible<string, string, string, string>({
          name: providerConfig.name ?? providerId,
          baseURL: providerConfig.baseURL,
          apiKey,
          fetch: optionFetch,
          headers,
          // OpenAI Compatible 流式 usage 需要显式请求，Usage 是执行结果的一部分。
          includeUsage: true,
          // 缺少这一装配时 SDK 默认 false，会把已声明支持的 Schema 静默降为 JSON object。
          // 使用 binding 冻结的模型事实，不按供应商或实时 Registry 另查一套能力。
          supportsStructuredOutputs: supportsJsonSchemaOutput,
        });
        return provider as LanguageModelFactory;
      }
    }
  }

  /** 返回 Provider 配置中的静态 API Key（动态账号模式由请求期鉴权覆盖）。 */
  private resolveApiKey(providerConfig: AiSdkProviderConfig): string | undefined {
    return providerConfig.apiKey;
  }

  /** 按 Provider 缓存代理感知 fetch；缓存的是网络层，动态鉴权/路由在请求期再包。 */
  // 缓存键：以 providerId 为粒度，同 provider 的多次请求共享同一出口与连接池。
  // 缓存内容：只保存代理感知网络层，动态凭据与路由决策不得下沉到此层。
  // 并发语义：首次并发请求可能各自创建 ProviderFetch 并分别写入，最后一次写入生效。
  // 生命周期：缓存随实例存活且不主动释放，代理配置变更需要重建执行器才生效。
  private resolveProviderTransport(providerId: string): ProviderFetch {
    const current = this.providerTransports.get(providerId);
    if (current) {
      return current;
    }
    const networkTransport = createProviderProxyFetch({
      caCertFile: this.network.caCertFile,
      env: this.env,
      fetch: this.baseTransport,
      httpProxy: this.network.httpProxy,
      noProxy: this.network.noProxy,
    });
    this.providerTransports.set(providerId, networkTransport);
    return networkTransport;
  }
}

/** binding 期冻结的模型事实；请求期解析只能在此基础上叠加鉴权/options，不能回查 Registry。 */
interface AiSdkModelSnapshot {
  /** 结构化输出能力（来自 Registry 声明）。 */
  readonly supportsJsonSchemaOutput: boolean;
  /** 已合并默认头与静态 Key 的 Provider 配置。 */
  readonly providerConfig: AiSdkProviderConfig;
  /** Provider 标识。 */
  readonly providerId: ModelProviderId;
  /** 模型标识。 */
  readonly modelId: ModelId;
}

/**
 * Registry 配置 → 内部 Provider 配置：映射 api.type 到 SDK 类别并复制鉴权/Header。
 * 静态 apiKey 仅在非 zhipu-account 模式复制；未知 api.type 直接抛错（不允许静默降级）。
 */
function toAiSdkProviderConfig(
  providerId: string,
  config: RegistryProviderConfig,
): AiSdkProviderConfig {
  const common = {
    ...(config.access.type !== "zhipu-account" && config.access.apiKey
      ? { apiKey: config.access.apiKey }
      : {}),
    baseURL: config.api.baseUrl,
    ...(config.api.headers ? { headers: { ...config.api.headers } } : {}),
    providerOptions: { apiFormat: config.api.type },
    access: config.access,
  };
  switch (config.api.type) {
    case "anthropic-messages":
      return { kind: "anthropic", ...common };
    case "openai-responses":
      return { kind: "openai", ...common };
    case "openai-chat-completions":
      return { kind: "openai-compatible", name: providerId, ...common };
  }
  throw new Error(`Unsupported Provider API type: ${String(config.api.type)}`);
}

/**
 * 应用请求期鉴权：覆盖 API Key/Headers，但不改动 binding 冻结的 Endpoint/协议/options。
 * zhipu-account 动态身份头会先清掉静态认证头，避免 SDK 优先使用旧凭据。
 */
function applyModelRequestAuth(
  providerConfig: AiSdkProviderConfig,
  requestAuth: ModelRequestAuth | undefined,
): AiSdkProviderConfig {
  if (!requestAuth) return providerConfig;
  const staticHeaders = withoutRequestVerificationHeaders(providerConfig.headers);
  // 账号动态身份头必须先清理静态认证头，避免 SDK 优先使用旧凭据。
  const headers =
    providerConfig.access.type === "zhipu-account"
      ? withoutModelAuthHeaders(staticHeaders)
      : staticHeaders;
  return {
    ...providerConfig,
    ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
    headers: mergeModelRequestHeaders(headers, requestAuth.headers),
  };
}

/**
 * 为 Anthropic 兼容网关补 Bearer Authorization（若未显式配置）。
 * 显式 Authorization 优先；无 apiKey 或已有该头时原样返回。
 */
function withAnthropicAuthorizationHeader(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!apiKey || hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    return headers;
  }

  // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的 Authorization 保持优先。
  return {
    [AUTHORIZATION_HEADER_NAME]: `Bearer ${apiKey}`,
    ...headers,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

/**
 * 归一化 Anthropic baseURL：确保根地址以 /v1 结尾（SDK 会再拼 /messages）。
 * URL 解析失败时退化为字符串处理；空值返回 undefined 让 SDK 使用默认地址。
 */
function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    // Anthropic's AI SDK provider appends /messages to baseURL, so explicit
    // gateway roots must include the /v1 API prefix at the adapter boundary.
    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}

/**
 * 创建业务错误感知 fetch：在代理/路由之上统一识别 provider 业务错误。
 * 非 2xx 先尝试解析 JSON 业务码；2xx SSE 则包一层 transform，遇到 error frame 时 controller.error。
 * 网络异常统一经 normalizeModelTlsFailure 归一化；识别出的业务错误会先 best-effort 消费 body 再抛出。
 */
export function createProviderBusinessErrorFetch(
  options: ProviderBusinessErrorFetchOptions,
): ProviderFetch {
  const networkFetch = createProviderProxyFetch(options);
  const baseFetch = options.endpointRoutingPort
    ? createProviderEndpointRoutingFetch({
        fetch: networkFetch,
        routingPort: options.endpointRoutingPort,
      })
    : networkFetch;

  return async (input, init) => {
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      throw normalizeModelTlsFailure(error);
    }

    // zcode-plan 安全校验拒绝（3007）等场景返回 HTTP 403 + JSON，但未必带
    // Content-Type: application/json。若只在启发式命中时才读 body，fetch 会把 403 原样交给
    // AI SDK，流式请求可能以空 completion 结束，core 最终误报 suspicious empty。
    if (!response.ok) {
      const nonOkBusinessError = await detectProviderBusinessError(response, options);
      if (nonOkBusinessError) {
        await consumeBusinessErrorResponseBodyBestEffort(response);
        throw nonOkBusinessError;
      }
    }

    if (responseMayContainSseBusinessError(response)) {
      return createProviderBusinessErrorSseResponse(response, options);
    }

    const businessError = await detectProviderBusinessError(response, options);
    if (businessError) {
      await consumeBusinessErrorResponseBodyBestEffort(response);
      throw businessError;
    }
    return response;
  };
}

/**
 * 已判定为业务错误时，尽力完整消费原始响应体以便连接复用；最多等待 1s。
 * 消费失败/超时只吞掉，不能覆盖已经解析出的 provider 原始错误。
 */
// 目标：把已判定错误的响应体读完，让 undici 归还连接槽，避免连续限流时连接耗尽。
// 上限：与 1s 定时器竞速，异常流不收敛时也不会阻塞已经解析出的原始错误。
// 吞错语义：读取失败一律忽略，清理动作绝不允许覆盖 provider 的原始错误。
// 资源释放：定时器必须在 finally 清除，否则悬挂句柄会拖住进程退出。
async function consumeBusinessErrorResponseBodyBestEffort(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // 业务错误检测消费的是 response.clone()；只 cancel 原始 tee 分支时，
    // Undici 的 cancel Promise 完成也不保证连接已可复用，连续 429 仍会耗尽连接槽。
    // 已识别的业务错误体受 64KB 上限保护，完整消费原始分支后连接才能稳定复用；
    // 异常 stream 永不收敛时则由清理上限兜底，不能阻塞已经解析出的原始错误。
    await Promise.race([
      response.arrayBuffer().then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PROVIDER_BUSINESS_ERROR_BODY_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // 清理失败不能覆盖已经解析出的 provider 原始错误。
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** createProviderProxyFetch 的参数：代理/CA 配置 + 底层 fetch。 */
interface ProviderProxyFetchOptions {
  /** 自定义 CA 证书。 */
  caCertFile?: string;
  /** 环境变量（HTTP_PROXY 等）。 */
  env?: EnvRecord;
  /** 底层 fetch；缺省 globalThis.fetch。 */
  fetch?: ProviderFetch;
  /** 显式代理地址；与 env 中的 HTTPS_PROXY 同时存在时优先本字段。 */
  httpProxy?: string;
  /** 代理绕过列表（NO_PROXY 语法）；为空表示所有目标都走 httpProxy。 */
  noProxy?: string;
}

/** 代理感知 fetch 的统一入口：模型 provider 与 MCP HTTP transport 共用同一套出口规则。 */
function createProviderProxyFetch(options: ProviderProxyFetchOptions): ProviderFetch {
  // Node 的 global fetch 不会自动读取 HTTP_PROXY/http_proxy。
  // 模型 provider 和 MCP HTTP transport 都复用同一层 proxy-aware fetch，避免多套出口规则漂移。
  return createNetworkProxyFetch(options);
}

/**
 * 从响应中识别 provider 业务错误：仅在可能含 JSON 时读取（限 64KB），解析失败即视为无业务错误。
 * 返回的 ProviderBusinessError 带上 HTTP 状态与响应头，保证重试退避仍可读取 retry-after。
 */
// 判定顺序：先过类型闸门，再限长读取，再解析 JSON，任一步失败都退化为无业务错误。
// 字段保留：HTTP 状态与响应头必须随错误带出，重试退避依赖 retry-after 而非固定间隔。
// 构造语义：providerCode 与 statusCode 分开记录，前者是上游业务码，后者只在可映射时存在。
async function detectProviderBusinessError(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Promise<ProviderBusinessError | undefined> {
  if (!responseMayContainBusinessJson(response)) {
    return undefined;
  }

  let body: unknown;
  try {
    const text = await readLimitedResponseText(response);
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  const failure = readProviderBusinessFailureFromBody(body);
  if (!failure) {
    return undefined;
  }

  return new ProviderBusinessError({
    providerCode: failure.providerCode,
    providerId: options.providerId,
    providerKind: options.providerKind,
    providerMessage: failure.providerMessage,
    providerRequestId: failure.providerRequestId,
    responseBodySummary: failure.responseBodySummary,
    // fetch 层的 ProviderBusinessError 会绕过 APICallError；
    // 不保留响应头会导致 retry-after/retry-after-ms 在重试计算前丢失。
    responseHeaders: responseHeadersToRecord(response.headers),
    responseStatus: response.status,
    statusCode: failure.statusCode,
  });
}

/** 从 HTTP JSON body 解析 zcode-plan 等业务错误（供 failure-classifier 在 APICallError 路径复用）。 */
export function readProviderBusinessFailureFromBody(body: unknown):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const record = asRecord(body);
  if (!record) {
    return undefined;
  }

  const errorRecord = asRecord(record.error);
  const providerCode =
    toProviderCode(record.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(record.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 二次包装后的外层 code 是 ZCode 自己的 PROVIDER_BUSINESS_ERROR，
    // 真实上游码在 providerCode；只有没有 providerCode 时才退回读取 code。
    toProviderCode(record.code) ??
    toProviderCode(errorRecord?.code);
  const providerMessage = readProviderMessage(record);
  const failedBySuccess = record.success === false;
  const failedByCode = isNonZeroProviderCode(providerCode);

  if (!failedBySuccess && !failedByCode) {
    return undefined;
  }

  return {
    providerCode,
    providerMessage,
    providerRequestId: readProviderRequestId(record),
    responseBodySummary: summarizeProviderBusinessBody(record),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

/**
 * 判断响应是否值得尝试解析业务 JSON：非 2xx 一律尝试（不依赖 Content-Type）；
 * 2xx 时 event-stream 跳过，json 读取，其他类型仅在 content-length 不超限时读取。
 */
function responseMayContainBusinessJson(response: Response): boolean {
  // 非 2xx 一律尝试读 body 解析业务码（403/3007、429/3002 等），不依赖 Content-Type 猜测。
  if (!response.ok) {
    return true;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("event-stream")) {
    return false;
  }
  if (contentType.includes("json")) {
    return true;
  }

  const contentLength = parseContentLength(response.headers.get("content-length"));
  return contentLength !== undefined && contentLength <= MAX_BUSINESS_ERROR_BODY_CHARS;
}

/**
 * 以流式方式读取响应文本，并把长度硬限制在 64KB 内（超限立即 cancel 并返回 undefined）。
 * 读取 clone 分支，避免消费原始 response；reader 在 finally 中释放锁。
 */
// 三态返回：undefined 表示超限或不可读，空串表示确实为空，调用方需区分两者。
// 读取源：只消费 clone 分支，原始 response 留给后续转发或错误包装。
// 上限依据：64KB 足以容纳业务错误体，超出即判为不可解析，避免把大响应读进内存。
async function readLimitedResponseText(response: Response): Promise<string | undefined> {
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_BUSINESS_ERROR_BODY_CHARS) {
    return undefined;
  }

  const clone = response.clone();
  if (!clone.body) {
    const text = await clone.text();
    return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
  }

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        return text.length > MAX_BUSINESS_ERROR_BODY_CHARS ? undefined : text;
      }

      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_BUSINESS_ERROR_BODY_CHARS) {
        await reader.cancel();
        return undefined;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 仅当响应带 body 且 Content-Type 为 event-stream 时，才需要 SSE 业务错误 transform。 */
function responseMayContainSseBusinessError(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true
  );
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * 把 2xx SSE 响应包装为业务错误感知 Response：复用原 body 管道与状态码。
 * 删除 content-length/content-encoding（transform 后长度不再可信），其余头原样保留。
 */
function createProviderBusinessErrorSseResponse(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const responseHeaders = responseHeadersToRecord(response.headers);

  return new Response(
    body.pipeThrough(
      createProviderBusinessErrorSseTransform(options, response.status, responseHeaders),
    ),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

/**
 * SSE 字节流 transform：按完整帧切分后逐帧检查是否携带 business error。
 * 一旦识别到错误，controller.error 终止流并用 streamFailed 阻止后续帧继续写出。
 */
// 缓冲语义：按字节解码后累积到 pending，只有遇到完整分隔符才切帧，避免半帧误判。
// 终止语义：命中错误后立即终止流，把 ProviderBusinessError 交给下游而不是继续写出。
// 尾帧处理：flush 时结算残留缓冲，未闭合的最后一帧也要尝试识别错误。
function createProviderBusinessErrorSseTransform(
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let streamFailed = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
    },
    flush(controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode();
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
      if (!streamFailed && pending.length > 0) {
        emitProviderBusinessSseFrame(
          pending,
          "",
          controller,
          encoder,
          options,
          responseStatus,
          responseHeaders,
          () => {
            streamFailed = true;
          },
        );
      }
    },
  });
}

/**
 * 从 pending 缓冲中切出所有完整 SSE 帧并逐帧写出；返回尚未闭合的尾部。
 * 识别到业务错误时返回空串，表示后续帧不再处理。
 */
function emitCompleteProviderBusinessSseFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    const emitted = emitProviderBusinessSseFrame(
      frame,
      separator,
      controller,
      encoder,
      options,
      responseStatus,
      responseHeaders,
      markFailed,
    );
    if (!emitted) {
      return "";
    }
  }
}

/**
 * 处理单个 SSE 帧：命中业务错误则 controller.error(ProviderBusinessError) 并返回 false；
 * 否则原样 enqueue（连同原始分隔符）并返回 true。
 */
// 成功路径：未命中错误时连同原始分隔符一起写出，保证字节流对下游保持等价。
// 错误路径：命中后保留响应状态与响应头，让限流场景的 retry-after 仍能进入退避计算。
// 返回契约：布尔返回值表示是否继续，false 让上层清空缓冲并停止后续处理。
function emitProviderBusinessSseFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): boolean {
  const failure = detectProviderBusinessSseFrameFailure(frame);
  if (failure) {
    // 部分 OpenAI-compatible provider 只在 HTTP 200 SSE error frame 中报告业务错误；
    // 同时保留原始响应头，保证限流场景的 retry-after 能进入后续重试退避。
    controller.error(
      new ProviderBusinessError({
        providerCode: failure.providerCode,
        providerId: options.providerId,
        providerKind: options.providerKind,
        providerMessage: failure.providerMessage,
        providerRequestId: failure.providerRequestId,
        responseBodySummary: failure.responseBodySummary,
        responseHeaders,
        responseStatus,
        statusCode: failure.statusCode,
      }),
    );
    markFailed();
    return false;
  }

  controller.enqueue(encoder.encode(`${frame}${separator}`));
  return true;
}

/**
 * 解析单帧 SSE 是否携带业务错误：优先按通用业务 body 结构识别；
 * 否则仅在 event=error 时按 error frame 解析（data=[DONE]/非 JSON 一律跳过）。
 */
function detectProviderBusinessSseFrameFailure(frame: string):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const sse = readSseFrame(frame);
  const data = sse.data?.trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  const body = safeParseRecord(data);
  if (!body) {
    return undefined;
  }

  const businessFailure = readProviderBusinessFailureFromBody(body);
  if (businessFailure) {
    return {
      ...businessFailure,
      providerRequestId: readProviderRequestId(body),
    };
  }

  if (sse.event?.toLowerCase() !== "error") {
    return undefined;
  }

  const errorRecord = asRecord(body.error);
  const providerCode =
    toProviderCode(body.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(body.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 包装码不能覆盖真实 providerCode。
    toProviderCode(body.code) ??
    toProviderCode(errorRecord?.code);

  return {
    providerCode,
    providerMessage: readProviderMessage(body),
    providerRequestId: readProviderRequestId(body),
    responseBodySummary: summarizeProviderBusinessBody(body),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

/** 解析 SSE 帧的 event 与多行 data 字段；没有 data 行时 data 为 undefined。 */
function readSseFrame(frame: string): { data?: string; event?: string } {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine.startsWith("event:")) {
      event = trimSseFieldValue(rawLine.slice("event:".length));
      continue;
    }
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    dataLines.push(trimSseFieldValue(rawLine.slice("data:".length)));
  }

  return {
    data: dataLines.length === 0 ? undefined : dataLines.join("\n"),
    event,
  };
}

function trimSseFieldValue(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function safeParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** 业务码是否为“非零”：数字/数字字符串非 0 为真，非数字字符串一律视为错误码。 */
function isNonZeroProviderCode(value: ProviderCode | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/** 仅当业务码本身落在合法 HTTP 状态区间（100~599）时才映射为 statusCode。 */
function providerCodeToStatusCode(value: ProviderCode | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const statusCode = Math.trunc(value);
    return isHttpStatusCode(statusCode) ? statusCode : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const statusCode = Number(normalized);
  return isHttpStatusCode(statusCode) ? statusCode : undefined;
}

function isHttpStatusCode(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

/** 归一化业务码：忽略 ZCode 自身的包装码 PROVIDER_BUSINESS_ERROR，保留真实上游码。 */
function toProviderCode(value: unknown): ProviderCode | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = value.trim();
    return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
      ? undefined
      : normalized;
  }
  return undefined;
}

/** 按 msg/message（含 error 对象）顺序读取并归一化 provider 错误消息。 */
function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderMessage(record.msg) ??
    normalizeProviderMessage(record.message) ??
    normalizeProviderMessage(errorRecord?.msg) ??
    normalizeProviderMessage(errorRecord?.message) ??
    normalizeProviderMessage(record.error)
  );
}

/** 按 request_id/requestId/id（含 error 对象）顺序读取上游 request id。 */
function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeProviderId(record.request_id) ??
    normalizeProviderId(record.requestId) ??
    normalizeProviderId(record.id) ??
    normalizeProviderId(errorRecord?.request_id) ??
    normalizeProviderId(errorRecord?.requestId) ??
    normalizeProviderId(errorRecord?.id)
  );
}

function normalizeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length > MAX_PROVIDER_MESSAGE_CHARS
    ? `${normalized.slice(0, MAX_PROVIDER_MESSAGE_CHARS)}...`
    : normalized;
}

/**
 * 生成业务错误响应体摘要：仅保留白名单标量字段与键名列表，避免把大 body 写进日志。
 * 嵌套 error 对象同样只取 code/msg/message/request_id/type 等标量。
 */
function summarizeProviderBusinessBody(record: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    keys: Object.keys(record).slice(0, 20),
  };

  copyScalar(record, summary, "success");
  copyScalar(record, summary, "code");
  copyScalar(record, summary, "error_code");
  copyScalar(record, summary, "msg");
  copyScalar(record, summary, "message");
  copyScalar(record, summary, "request_id");
  copyScalar(record, summary, "requestId");

  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    const errorSummary: Record<string, unknown> = {
      keys: Object.keys(errorRecord).slice(0, 20),
    };
    copyScalar(errorRecord, errorSummary, "code");
    copyScalar(errorRecord, errorSummary, "error_code");
    copyScalar(errorRecord, errorSummary, "msg");
    copyScalar(errorRecord, errorSummary, "message");
    copyScalar(errorRecord, errorSummary, "request_id");
    copyScalar(errorRecord, errorSummary, "requestId");
    copyScalar(errorRecord, errorSummary, "type");
    summary.error = errorSummary;
  }

  return summary;
}

/** 仅复制标量（string/number/boolean/null/undefined）字段到摘要，对象/数组一律跳过。 */
function copyScalar(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    target[key] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
