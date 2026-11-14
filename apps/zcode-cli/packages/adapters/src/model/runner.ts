import type { ModelRequestSecurityState } from "./request-security.js";
// ============================================================
// Vercel AI SDK model runner
// 定位：适配器门面层，把 Registry 配置绑定成 contracts 的 Model，并投影为 runner-runtime 请求口径。
// 输入：AiSdkModelAdapterOptions（鉴权/端点路由/网络/debugDir/retry/statusSink）+ createModel 配置。
// 输出：generateText→ModelTextResult；streamText→AsyncGenerator<ModelStreamEvent>。
// 副作用：网络请求、debugDir 落盘、statusSink 事件发布、日志。
// 失败语义：协议错误抛 ModelProtocolError；鉴权缺失在请求前失败；生成/流失败交下层分类并重试，不吞错不回滚。
// 不变量：请求内绑定身份不可被 header 刷新改写；reasoning history 只在逻辑入口投影一次，各 attempt 复用。
// ============================================================

import {
  ModelErrorCode,
  ModelProtocolError,
  getCurrentModelInvocationContext,
} from "@zcode/contracts";
import type {
  Logger,
  Model,
  ModelOptions,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelRequestAuthSourceInput,
  ModelStatusSink,
  ModelStreamEvent,
  ModelTextResult,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import {
  AiSdkModelExecution,
  type AiSdkResolvedModel,
  type AiSdkNetworkConfig,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "./model-execution.js";
import type { ConversationCapturePort } from "../conversation-recording/index.js";
import {
  resolveAiSdkModelRetryOptions,
  type AiSdkModelRetryOptions,
  type ResolvedAiSdkModelRetryOptions,
} from "./retry-policy.js";
import { resolveRetryOptionsForBudget } from "./retry-budget.js";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-timeout.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";
import {
  defaultRuntime,
  type AiSdkModelRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { resolveToolSearchCapability } from "./tool-search.js";
import { createModel, type ModelExecutionRequest } from "./model.js";
import { refreshOffPeakRequestAuth } from "./off-peak-request-auth.js";

export type { AiSdkModelRetryOptions } from "./retry-policy.js";
export type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
} from "./runner-runtime.js";
export { normalizeUsage, toModelStreamEvent } from "./runner-normalization.js";

export interface AiSdkModelAdapterOptions {
  /** 会话录制端口：存在时把请求/响应原始载体交给会话留档。 */
  conversationCapture?: ConversationCapturePort;
  /** 默认出站请求头；由 model-execution 合并到每次物理请求。 */
  defaultHeaders?: AiSdkModelExecutionConfig["defaultHeaders"];
  /** 请求安全状态（脱敏/校验策略），透传给执行层。 */
  requestSecurityState?: ModelRequestSecurityState;
  /** 端点路由 Port：按 provider/model 选择实际 endpoint。 */
  endpointRoutingPort?: import("@zcode/contracts").ProviderEndpointRoutingPort;
  /** 网络配置（代理/超时等），仅在需要时注入。 */
  network?: AiSdkNetworkConfig;
  /** 文本运行时实现，缺省用 defaultRuntime（便于测试替换）。 */
  runtime?: AiSdkModelRuntime;
  /** 环境变量快照，缺省 process.env；离线/测试可注入固定值。 */
  env?: EnvRecord;
  /** debug 落盘目录；缺省不落盘。 */
  debugDir?: string;
  /** 日志输出端口；缺省静默。 */
  logger?: Logger;
  /** 重试配置覆盖项，最终与 env 合并成 ResolvedAiSdkModelRetryOptions。 */
  retry?: AiSdkModelRetryOptions;
  /** 模型状态事件汇聚点（流式生命周期事件）。 */
  statusSink?: ModelStatusSink;
  /** 流空闲超时毫秒数，缺省 DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS。 */
  streamIdleTimeoutMs?: number;
  /** 是否全量保留模型 IO（用于排障），缺省 false。 */
  modelIoFullRetentionEnabled?: boolean;
}

export interface CreateAiSdkModelOptions {
  /** 提供方标识，用于绑定端点/鉴权策略。 */
  providerId: string;
  /** 模型标识，与 providerId 共同构成绑定身份。 */
  modelId: string;
  /** Registry 提供方配置（api/access/端点等），决定鉴权与请求模式。 */
  providerConfig: RegistryProviderConfig;
  /** Registry 模型配置（properties/optionSpecs），决定能力与参数规格。 */
  modelConfig: RegistryModelConfig;
  /** 展示名，仅用于 UI/日志，不参与身份判断。 */
  displayName?: string;
  /** 调用级初始参数（如 maxOutputTokens/reasoningLevel）。 */
  options?: ModelOptions;
  /** 请求级依赖（requestAuth 等），供派生模式重试前刷新鉴权。 */
  requestDependencies?: ModelRequestDependencies;
}

/**
 * 适配器门面：持有执行层（端点/鉴权/网络）与文本运行时，把配置绑定成 contracts Model。
 * 构造时一次性解析 retry/env/stream idle timeout，避免每次请求重复读取环境；
 * addStatusSink 支持多播，任一 sink 抛错不影响其他 sink 且不阻断调用链外抛。
 * 不持有请求级可变状态：并发请求共享同一实例是安全的（除 modelIoFullRetentionEnabled 开关）。
 */
export class AiSdkModelAdapter {
  /** 绑定与端点解析的执行层，负责真实网络请求与鉴权票据。 */
  private readonly execution: AiSdkModelExecution;
  /** 文本运行时（generate/stream 的具体 SDK 调用），可注入替换。 */
  private readonly runtime: AiSdkModelRuntime;
  /** 构造期固定的环境快照，用于 retry 解析与子 runner 默认值。 */
  private readonly env: EnvRecord;
  /** debug 落盘目录；undefined 表示不落盘。 */
  private readonly debugDir?: string;
  /** 日志端口；undefined 表示静默。 */
  private readonly logger?: Logger;
  /** 已解析的重试参数（含尝试次数/退避），逐请求再按 budget 收敛。 */
  private readonly retry: ResolvedAiSdkModelRetryOptions;
  /** 状态事件汇聚点；可被 addStatusSink 替换为多播包装。 */
  private statusSink?: ModelStatusSink;
  /** 流空闲超时毫秒数，超时按失败处理。 */
  private readonly streamIdleTimeoutMs: number;
  /** 是否全量保留模型 IO；运行期可由 setModelIoFullRetentionEnabled 切换。 */
  private modelIoFullRetentionEnabled: boolean;

  /**
   * 组装执行层与运行时；仅在有值时透传可选依赖，避免 undefined 覆盖下层默认。
   * 重试与环境变量在此定型，后续请求不再读取 process.env。
   */
  constructor(options: AiSdkModelAdapterOptions) {
    this.execution = new AiSdkModelExecution(
      {
        ...(options.conversationCapture
          ? { conversationCapture: options.conversationCapture }
          : {}),
        defaultHeaders: options.defaultHeaders,
        ...(options.endpointRoutingPort
          ? { endpointRoutingPort: options.endpointRoutingPort }
          : {}),
        ...(options.network ? { network: options.network } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      {
        ...(options.requestSecurityState
          ? { requestSecurityState: options.requestSecurityState }
          : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.env = options.env ?? process.env;
    this.debugDir = options.debugDir;
    this.logger = options.logger;
    this.retry = resolveAiSdkModelRetryOptions(options.retry, this.env);
    this.statusSink = options.statusSink;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    this.modelIoFullRetentionEnabled = options.modelIoFullRetentionEnabled ?? false;
  }

  /**
   * 运行期切换模型 IO 全量保留；只影响后续请求的落盘/日志粒度，不改变请求内容。
   */
  setModelIoFullRetentionEnabled(enabled: boolean): void {
    this.modelIoFullRetentionEnabled = enabled;
  }

  /**
   * 追加一个状态 sink；已有 sink 时改为多播包装，二者独立执行互不连坐。
   * 无原 sink 或与传入相同则直接赋值（幂等）；多播时任一拒绝会在两者都完成后重抛首个错误。
   */
  addStatusSink(sink: ModelStatusSink): void {
    const current = this.statusSink;
    if (!current || current === sink) {
      this.statusSink = sink;
      return;
    }
    this.statusSink = {
      async publish(event) {
        // 多个 sink 必须独立执行：任一 sink 失败不得连带影响其他 sink，
        // 也不能阻塞原有调用链。
        const results = await Promise.allSettled([
          Promise.resolve().then(() => current.publish(event)),
          Promise.resolve().then(() => sink.publish(event)),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    };
  }

  /**
   * 绑定 provider/model 并产出 contracts Model；一次 createModel 对应一条逻辑请求链。
   * 副作用无：仅做配置解析与闭包装配，真实网络发生在 generateText/streamText。
   * 失败：配置不合法时由下层 bindModel/resolveRequest 抛 ModelProtocolError；
   *       maxOutputTokens 缺失在 resolveForRequest 阶段抛 InvalidModelRequest（请求前失败）。
   * 不变量：闭包内 resolved 的 providerId/modelId 固定，runtime header 刷新只能换票据不能换身份。
   */
  createModel(options: CreateAiSdkModelOptions): Model {
    const boundResolution = this.execution.bindModel({
      providerId: options.providerId,
      modelId: options.modelId,
      providerConfig: options.providerConfig,
      supportsJsonSchemaOutput: options.modelConfig.properties.supportsJsonSchemaOutput,
      optionSpecs: options.modelConfig.optionSpecs,
    });
    const properties = options.modelConfig.properties;
    const resolved = {
      ...boundResolution.resolved,
      properties,
      ...(options.providerConfig.access.type === "zhipu-account"
        ? { accountAccess: options.providerConfig.access }
        : {}),
    };
    const optionSpecs = options.modelConfig.optionSpecs;
    // 把 contracts 的 ModelExecutionRequest 投影为 runtime 请求口径：补齐调用上下文、
    // reasoning telemetry 与按 access 模式选择的鉴权刷新闭包（见下分支注释）。
    const toLegacyRequest = (request: ModelExecutionRequest): AiSdkModelTextRequest => {
      const context = getCurrentModelInvocationContext();
      const {
        refreshRuntimeHeadersBeforeAttempt: contextRefreshRuntimeHeadersBeforeAttempt,
        ...invocationContext
      } = context ?? {};
      const shouldAttachReasoningTelemetry = request.options.reasoningLevel !== undefined;
      const selectedReasoningLevel = request.options.reasoningLevel;
      const requestAuthDependency = options.requestDependencies?.requestAuth;
      // Bug 根因：加速卡（highspeed）与 Off-Peak 同为 Coding Plan 派生模式，本轮动态鉴权
      // （zcode JWT + Coding Plan 双 JWT + X-Highspeed-Card-ID，见 docs/highspeed/highspeed-card-spec.md
      // §2.2）经 modelExecution.requestAuth 下发到执行作用域 Source。若门禁只认 off-peak，highspeed
      // 会落到下面的账号 runtime-header 刷新分支，把整包 requestAuth（含卡 ID）丢弃，加速请求因缺卡 ID/
      // 错误鉴权被 /api/v1/highspeed 网关判 401。两种派生免签模式必须同样消费执行作用域 Source。
      const requestAuthRequired =
        options.providerConfig.access.type === "zhipu-account" &&
        (options.providerConfig.access.mode === "off-peak" ||
          options.providerConfig.access.mode === "highspeed");
      // 调用级 runtime header Port 只服务绑定完整 Account Access 的账号型 Model；
      // 普通 API-key Model 若也消费该 Port，会把静态鉴权误送到 Host 刷新并在请求前失败。
      // 派生模式保留执行作用域票据/卡身份；Off-Peak 的 PAT 仍逐请求向原账号 owner 刷新。
      const refreshRuntimeHeadersBeforeAttempt = requestAuthRequired
        ? async (input: ModelRequestAuthSourceInput) => {
            const requestAuth = await requestAuthDependency?.source?.resolve(input);
            if (!hasRequestAuth(requestAuth)) {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }
            const refreshedAuth =
              options.providerConfig.access.type === "zhipu-account" &&
              options.providerConfig.access.mode === "off-peak"
                ? await refreshOffPeakRequestAuth({
                    auth: requestAuth,
                    input,
                    accountAccess: options.providerConfig.access,
                    refresh: contextRefreshRuntimeHeadersBeforeAttempt,
                  })
                : requestAuth;
            return { headersApplied: true, requestAuth: refreshedAuth };
          }
        : options.providerConfig.access.type === "zhipu-account"
          ? (contextRefreshRuntimeHeadersBeforeAttempt ??
            (async () => {
              throw new ModelProtocolError(
                ModelErrorCode.ModelRequestAuthMissing,
                `Account model request auth is unavailable: ${resolved.providerId}/${resolved.modelId}`,
              );
            }))
          : undefined;
      return {
        toolSearchEnabled: request.toolSearchEnabled,
        messages: request.messages,
        tools: request.tools,
        responseJsonSchema: request.responseJsonSchema,
        abortSignal: request.abortSignal,
        maxOutputTokens: request.options.maxOutputTokens,
        ...invocationContext,
        ...(shouldAttachReasoningTelemetry
          ? {
              modelCall: {
                ...invocationContext.modelCall,
                reasoning: {
                  ...invocationContext.modelCall?.reasoning,
                  // 过去按 none/off 等档位名称猜测 enabled/disabled，导致 Telemetry
                  // 把 Provider 方言当成统一语义。这里只记录请求实际选择的公开档位。
                  ...(selectedReasoningLevel ? { requestedLevel: selectedReasoningLevel } : {}),
                },
              },
            }
          : {}),
        ...(refreshRuntimeHeadersBeforeAttempt
          ? {
              refreshRuntimeHeadersBeforeAttempt: (input) =>
                refreshRuntimeHeadersBeforeAttempt({
                  ...input,
                  ...(options.providerConfig.access.type === "zhipu-account"
                    ? { accountAccess: options.providerConfig.access }
                    : {}),
                }),
            }
          : {}),
      };
    };
    // 解析每次请求的 model 句柄：带 runtime 刷新时按 attempt 传入新 requestAuth，否则复用绑定。
    const resolveForRequest = (
      request: AiSdkModelTextRequest,
      optionValues: Required<ModelOptions>,
    ): ((requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel) => {
      const maxOutputTokens = requireMaxOutputTokens(optionValues);
      return request.refreshRuntimeHeadersBeforeAttempt
        ? (requestAuth) => ({
            ...assertSameBoundModel(
              resolved,
              boundResolution.resolveRequest({
                options: {
                  maxOutputTokens,
                  reasoningLevel: optionValues.reasoningLevel,
                },
                requestAuth,
              }),
            ),
            properties,
            ...(options.providerConfig.access.type === "zhipu-account"
              ? { accountAccess: options.providerConfig.access }
              : {}),
          })
        : () => ({
            ...boundResolution.resolveRequest({
              options: {
                maxOutputTokens,
                reasoningLevel: optionValues.reasoningLevel,
              },
            }),
            properties,
            ...(options.providerConfig.access.type === "zhipu-account"
              ? { accountAccess: options.providerConfig.access }
              : {}),
          });
    };
    return createModel({
      requestCapabilities: {
        toolSearch: resolveToolSearchCapability(
          options.providerConfig.api.type,
          options.providerConfig.access,
        ),
      },
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      displayName: options.displayName,
      properties,
      optionSpecs: {
        maxOutputTokens: optionSpecs.maxOutputTokens,
        reasoningLevel: optionSpecs.reasoningLevel,
      },
      options: options.options,
      executor: {
        generateText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.generateTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
        streamText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.streamTextWithResolved(
            legacyRequest,
            resolved,
            resolveForRequest(legacyRequest, request.options),
          );
        },
      },
    });
  }

  /**
   * generateText 最终调用：先做一次 reasoning history 投影，再交给 runGenerateText。
   * 输入 request 已投影；resolveModel 每次 attempt 调用，用于携带刷新后的 requestAuth。
   * 输出 ModelTextResult；成功终态才会返回，失败按分类抛错。
   * 副作用：网络请求、debug 落盘、status/日志；不写数据库、无事务。
   * 重试预算按 projectedRequest.modelRetryBudget 收敛（单次尝试可压到 maxAttempts=1）。
   */
  private generateTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): Promise<ModelTextResult> {
    const projectedRequest = projectRequestHistory(request, resolved);
    return runGenerateText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }

  /**
   * streamText 最终调用：与 generateText 同源投影，额外传入 streamIdleTimeoutMs 控制空闲超时。
   * 输出 AsyncGenerator：事件按序产出，错误以事件或抛出形式由下层 runner 语义决定。
   * 副作用：流式网络连接、debug 落盘、status 事件；生成器被提前消费时依赖下层清理连接。
   */
  private async *streamTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: () => ResolvedAiSdkModel,
  ): AsyncGenerator<ModelStreamEvent> {
    const projectedRequest = projectRequestHistory(request, resolved);
    yield* runStreamText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      // single-attempt 预算（带 selectionFallback 的执行作用域句柄）把 maxAttempts 收敛为 1。
      retry: resolveRetryOptionsForBudget(this.retry, projectedRequest.modelRetryBudget),
      runtime: this.runtime,
      statusSink: this.statusSink,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }
}

function requireMaxOutputTokens(options: ModelOptions): number {
  // 显式要求 maxOutputTokens：上层必须给出预算，禁止由本层猜测默认值导致截断或超发。
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

/**
 * 判定请求鉴权是否“实际可用”：非空 apiKey 或任一非空 header 即算可用。
 * 空字符串/纯空白视同缺失，用于在发请求前触发 ModelRequestAuthMissing。
 */
function hasRequestAuth(
  requestAuth: ModelRequestAuth | undefined,
): requestAuth is ModelRequestAuth {
  if (requestAuth?.apiKey?.trim()) return true;
  return Object.values(requestAuth?.headers ?? {}).some((value) => value.trim().length > 0);
}

/**
 * 校验 runtime header 刷新没有把请求打到另一个模型上。
 * 返回刷新后的 resolved；身份不一致直接抛错（此处是编程错误，不并入可重试失败）。
 */
function assertSameBoundModel(
  bound: ResolvedAiSdkModel,
  refreshed: AiSdkResolvedModel,
): AiSdkResolvedModel {
  if (bound.providerId !== refreshed.providerId || bound.modelId !== refreshed.modelId) {
    throw new Error("Runtime header refresh changed the bound model identity.");
  }
  return refreshed;
}

/**
 * 逻辑请求入口的历史投影：仅 anthropic 需要 reasoning 结构归一化，其余原样返回。
 * 幂等且不原地改：未变化时返回同一引用，便于下层保持 request 对象身份复用。
 * 之所以只在这里做一次：重试若再次归一化会删掉上一轮补出的 assistant 占位并合并 user。
 */
function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  if (resolved.providerKind !== "anthropic") return request;

  // 结构归一化过去位于每次物理请求都会经过的 serializer，签名修复重试
  // 因而会再次删除上一轮刚补出的 assistant 占位并合并 user。逻辑请求入口只投影一次，
  // 后续 attempt 只能复用或从这份 request-local history 派生。
  const messages = normalizeReasoningHistory(request.messages, {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
  });
  return messages === request.messages ? request : { ...request, messages };
}
