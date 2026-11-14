// INV-01 诊断绝不阻断模型请求：守住位置 所有出口的捕获；改错故障 排障代码把主流程带崩。
// INV-02 写盘前必须脱敏：守住位置 统一落盘边界的清洗；改错故障 密钥随请求头落盘。
// INV-03 测试态不写盘：守住位置 环境判定；改错故障 单测在开发机留下垃圾文件。
// INV-04 目录按环境分离：守住位置 基础目录选择；改错故障 开发日志混入生产轮转。
// INV-05 会话文件数有上限：守住位置 轮转调用；改错故障 目录无限增长。
// INV-06 轮转按修改时间排序：守住位置 排序键；改错故障 删掉最新会话。
// INV-07 轮转失败不阻断写入：守住位置 删除捕获；改错故障 单文件占用导致整条链路失效。
// INV-08 单文件有硬上限：守住位置 大小比较；改错故障 长会话滚成巨量文件。
// INV-09 超限整文件重置：守住位置 重写分支；改错故障 读取历史导致原生崩溃。
// INV-10 重置记录带自证字段：守住位置 重置元信息；改错故障 离线分析误判为数据丢失。
// INV-11 增量只在指纹连续时成立：守住位置 首尾与采样比较；改错故障 被改写的历史被漏记。
// INV-12 缩短即判非增量：守住位置 长度比较；改错故障 删减后的上下文无法还原。
// INV-13 指纹深度有上限：守住位置 递归深度判断；改错故障 深层对象拖慢每次写入。
// INV-14 字符串指纹只看首尾：守住位置 切片长度；改错故障 巨型消息产生巨型指纹。
// INV-15 生产裁剪去掉重复集合：守住位置 删除字段；改错故障 单条记录放大数倍。
// INV-16 失败记录保留完整请求体：守住位置 错误标志分支；改错故障 报错排障缺最关键载荷。
// INV-17 失败流等待有界：守住位置 一秒超时；改错故障 中止后收尾永久挂起。
// INV-18 定时器不挂住事件循环：守住位置 解引用与清理；改错故障 进程延迟退出。
//
// 模块职责：在 generate 与 stream 两条模型链路外侧落盘请求/响应快照（debug / rollout JSONL），供离线排障；
//   单 session 的 JSONL 压成 delta/tail 基线以避免历史消息梯度重复；模块级状态只有压缩基线 Map，其失效由文件重建触发。
// 副作用：mkdir/appendFile/writeFile/rm 与进程内 Map；不碰网络与模型主流程。
// 失败语义：全部吞错（诊断失败绝不影响模型请求）；流失败聚合限时 1s，已 abort 直接跳过。
// 不变量：每目录最多 3 个 session 文件，单文件上限 64MB；超限时一律整文件重置。
//   delta 仅在首/尾/采样指纹连续时成立，写盘前必经 sanitizeModelIODebugRecord 脱敏。
// 阅读顺序：generate/stream 记录入口 → 聚合解析 → writeModelIODebugRecord 落盘/轮转/压缩。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelTextResult } from "@zcode/contracts";
import { ZCODE_RUNTIME_ENV_KEY, normalizeZCodeRuntimeEnv } from "@zcode/shared";
import { redactAnthropicRequestMetadata } from "./anthropic-request-metadata.js";
import type { EnvRecord } from "./model-execution.js";
import { sanitizeModelIODebugRecord } from "./runner-debug-redaction.js";
import { getGenerateTextResultMetadata } from "./runner-diagnostics.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { stringMetadata } from "./runner-record.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

// 生产环境 rollout 目录最多保留的 model-io 会话文件数。超出删最旧。
const MAX_ROLLOUT_FILES = 3;
// 生产环境单个 session 的 model-io 文件硬上限。诊断日志不能因为无限增长影响 agent 主流程。
const MAX_ROLLOUT_SESSION_BYTES = 64 * 1024 * 1024;
// 开发态保留更多上下文，但仍避免单个 debug 文件无限膨胀。
const MAX_DEBUG_SESSION_BYTES = 256 * 1024 * 1024;
// 缓存缺失或文件超限后写 baseline 时，仅保留最近上下文，避免长 session 重启后再次写出巨型记录。
const MAX_ROLLOUT_BASELINE_MESSAGES = 64;
const MAX_DEBUG_BASELINE_MESSAGES = 256;
const FINGERPRINT_STRING_LIMIT = 512;

/**
 * 单个消息集合（messages / sdkMessages / body.messages）上次写入时的指纹快照。
 * 用于判断下一次请求是否只是“在尾部新增消息”，从而只写 delta。
 */
interface ModelIOCollectionState {
  /** 集合元素数量；<=0 时不能作为 delta 基线。 */
  count: number;
  /** 首元素指纹；与 lastFingerprint 一起确认前缀未被改写。 */
  firstFingerprint?: string;
  /** 第 count-1 个元素指纹；用于确认新增边界而非整体替换。 */
  lastFingerprint?: string;
  /** 首/中/尾等固定位置采样，降低中间历史被改动却被误判为 delta 的概率。 */
  sampleFingerprints?: string[];
}

/** 一个 model-io 记录中三份消息集合各自的压缩基线。 */
interface ModelIORequestCompactionState {
  /** provider 实际发送体里的 body.messages 基线。 */
  bodyMessages?: ModelIOCollectionState;
  /** canonical request.messages 基线。 */
  messages?: ModelIOCollectionState;
  /** AI SDK options.messages 基线。 */
  sdkMessages?: ModelIOCollectionState;
}

/** 按 session 文件维度的压缩状态；键为文件绝对路径。 */
interface ModelIOCompactionState {
  /** request 侧各集合的上次写入快照。 */
  request?: ModelIORequestCompactionState;
}

// 进程内压缩基线缓存：避免每次 append 都同步读取并 expand 整个历史 JSONL；
// 进程重启或文件被轮转/重置后自然失效，退化为 full/tail 写法。
const modelIOCompactionStates = new Map<string, ModelIOCompactionState>();

/**
 * 判定本次模型调用是否需要记录 model I/O。
 * 仅测试态（ZCODE_RUNTIME_ENV=test）返回 false，避免单测产生磁盘副作用；
 * 未设置时按生产处理（写入 rollout 目录并启用条数/容量上限）。
 */
export function shouldRecordModelIO(env: EnvRecord): boolean {
  // 开发态与生产态都记录(分别落到 debug / rollout 目录);仅测试态(ZCODE_RUNTIME_ENV=test)不写,
  // 避免单测产生磁盘副作用。未设时按生产处理(记录到 rollout,带条数上限)。
  return normalizeRuntimeEnv(env) !== "test";
}

// 判定当前是否开发态,用于选择落盘目录(debug vs rollout)。
// 直接看 ZCODE_RUNTIME_ENV === "development";dev 桌面/CLI 启动时已注入该变量。
/** 开发态返回 true（写 debug 目录、放宽容量）；其余情况按生产处理（写 rollout 目录）。 */
export function isDevelopmentModelIOEnv(env: EnvRecord): boolean {
  return normalizeRuntimeEnv(env) === "development";
}

/**
 * 非流式 generate 路径的 model I/O 记录入口。
 * 输入为一次 attempt 的 request/options/result/error；result 与 error 都缺席时响应部分留空。
 * 同步 appendFileSync 写盘；异常在内部吞掉，绝不向上影响模型请求。
 * request body 依次取 adapter raw 捕获、SDK 元数据、options 兜底快照；写盘前统一脱敏。
 */
export function recordGenerateTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkGenerateTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkGenerateTextResult;
  startedAt: number;
}): void {
  if (!input.recordModelIO) {
    return;
  }

  const completedAt = Date.now();
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  const metadata = input.request.metadata ?? {};
  // body 优先取 adapter 侧的 raw 捕获（最接近线上真实 payload）；
  // 失败或未捕获时才退回 SDK 元数据 / options 快照，保证 400 排障仍有结构可查。
  const requestBody =
    input.resolved.rawRequestBodyCapture?.body ??
    resultWithMetadata?.request?.body ??
    (input.error
      ? buildFallbackRequestBodyFromOptions({
          options: input.options,
          resolved: input.resolved,
          stream: false,
        })
      : undefined);

  writeModelIODebugRecord(
    {
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - input.startedAt,
      error: input.error ? serializeError(input.error) : undefined,
      requestId: input.requestId,
      attempt: input.attempt,
      model: {
        modelId: input.resolved.modelId,
        providerId: input.resolved.providerId,
      },
      request: {
        body: redactAnthropicRequestMetadata(requestBody),
        headers: input.options.headers,
        maxOutputTokens: input.options.maxOutputTokens,
        messages: input.request.messages,
        providerOptions: input.request.providerOptions,
        sdkMessages: input.options.messages,
        temperature: input.request.temperature,
        toolChoice: input.request.toolChoice,
        toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
      },
      response: input.result
        ? {
            body: resultWithMetadata?.response?.body,
            finishReason: input.result.finishReason,
            headers: resultWithMetadata?.response?.headers,
            modelId: resultWithMetadata?.response?.modelId,
            providerMetadata: input.result.providerMetadata,
            // 运行结果已有 reasoning，但 model-io 过去只记录 text，
            // 导致调用轨迹无法得到 response.reasoningText，始终不显示思考过程。
            reasoningText: modelIOReasoningText(input.result.reasoning),
            responseId: resultWithMetadata?.response?.id,
            text: input.result.text,
            toolCalls: input.normalizedToolCalls,
            toolResults: normalizeToolResults(input.result, input.normalizedToolCalls),
            sources: normalizeSources(input.result),
            usage: normalizeUsage(input.result.totalUsage ?? input.result.usage),
          }
        : undefined,
      sessionId: stringMetadata(metadata.sessionId),
      querySource: stringMetadata(metadata.querySource),
      startedAt: new Date(input.startedAt).toISOString(),
      traceId: stringMetadata(metadata.traceId),
      turnId: stringMetadata(metadata.turnId),
      type: "model_io",
    },
    input.debugDir,
    input.isDev,
    input.modelIoFullRetentionEnabled,
  );
}

/**
 * 流式请求的 model I/O 记录。
 *
 * 背景（bug：开发态桌面 agent 始终走流式，model-io 一直为空）：
 * 只在非流式 `runGenerateText` 里写 model-io 会让桌面/协议端默认 `modelStreaming: "on"` 的
 * 每个 turn（`streamText`）即便 ZCODE_RUNTIME_ENV=development 也从不落盘。流式路径同样要记录。
 *
 * 与 generate 路径的关键差异：StreamTextResult 的 text/toolResults/sources/response 等聚合字段是 **promise**，
 * 必须等 fullStream 读完后再 await；toolResults/sources 的归一化期望数组，
 * 所以先解析聚合 promise，再用合成对象处理。toolCalls 则直接复用 assembler 的归一化快照。
 * 任何失败都不得影响模型请求路径。
 */
export async function recordStreamTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkStreamTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkStreamTextResult;
  startedAt: number;
}): Promise<void> {
  if (!input.recordModelIO) {
    return;
  }

  try {
    // 成功路径下解析完整聚合结果；失败路径只读取 request/response 元数据，且必须限时——
    // 流中途被 abort（用户 Stop / idle timeout）后 AI SDK 的聚合 promise 永不 settle。
    const aggregate = input.result
      ? input.error
        ? await resolveFailedStreamModelIOAggregate(input.result, input.request.abortSignal)
        : await resolveStreamModelIOAggregate(input.result)
      : undefined;
    const completedAt = Date.now();
    const metadata = input.request.metadata ?? {};
    const requestBody =
      input.resolved.rawRequestBodyCapture?.body ??
      aggregate?.requestBody ??
      (input.error
        ? buildFallbackRequestBodyFromOptions({
            options: input.options,
            resolved: input.resolved,
            stream: true,
          })
        : undefined);
    // normalizeToolResults / normalizeSources 期望聚合后的数组；
    // 用只含这两个字段的合成对象复用 generate 路径的归一化逻辑，避免流式分支另写一套。
    const syntheticResult = {
      toolResults: aggregate?.toolResults,
      sources: aggregate?.sources,
    } as unknown as AiSdkGenerateTextResult;

    writeModelIODebugRecord(
      {
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - input.startedAt,
        error: input.error ? serializeError(input.error) : undefined,
        requestId: input.requestId,
        attempt: input.attempt,
        model: {
          modelId: input.resolved.modelId,
          providerId: input.resolved.providerId,
        },
        request: {
          body: redactAnthropicRequestMetadata(requestBody),
          headers: input.options.headers,
          maxOutputTokens: input.options.maxOutputTokens,
          messages: input.request.messages,
          providerOptions: input.request.providerOptions,
          sdkMessages: input.options.messages,
          temperature: input.request.temperature,
          toolChoice: input.request.toolChoice,
          toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
        },
        response: aggregate
          ? {
              body: aggregate.responseBody,
              finishReason: aggregate.finishReason,
              headers: aggregate.responseHeaders,
              modelId: aggregate.responseModelId,
              providerMetadata: aggregate.providerMetadata,
              reasoningText: modelIOReasoningText(aggregate.reasoning),
              responseId: aggregate.responseId,
              text: aggregate.text,
              // assembler 是流式参数归一化的唯一所有者；
              // model-io 复用其快照，避免二次解析、重复 warn 和诊断结果漂移。
              toolCalls: input.normalizedToolCalls,
              toolResults: normalizeToolResults(syntheticResult, input.normalizedToolCalls),
              sources: normalizeSources(syntheticResult),
              usage: normalizeUsage(aggregate.usage),
            }
          : undefined,
        sessionId: stringMetadata(metadata.sessionId),
        querySource: stringMetadata(metadata.querySource),
        startedAt: new Date(input.startedAt).toISOString(),
        traceId: stringMetadata(metadata.traceId),
        turnId: stringMetadata(metadata.turnId),
        type: "model_io",
      },
      input.debugDir,
      input.isDev,
      input.modelIoFullRetentionEnabled,
    );
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

/**
 * 失败路径的 request body 兜底快照：直接记录送入 AI SDK 的 options。
 * 仅用于排障（尤其是 provider 400 的 messages/tools 结构），字段名 bodySource 标明来源。
 */
function buildFallbackRequestBodyFromOptions(input: {
  options: AiSdkGenerateTextOptions | AiSdkStreamTextOptions;
  resolved: ResolvedAiSdkModel;
  stream: boolean;
}): Record<string, unknown> {
  const options = input.options as Record<string, unknown>;
  return removeUndefined({
    // 失败路径经常拿不到 AI SDK 暴露的 raw request.body。此处记录送入
    // AI SDK 的完整 payload 快照，方便排查 provider 400 的 messages/tools 结构。
    bodySource: "ai_sdk_options",
    experimental_include: options.experimental_include,
    frequencyPenalty: options.frequencyPenalty,
    maxOutputTokens: options.maxOutputTokens,
    messages: options.messages,
    model: input.resolved.modelId,
    presencePenalty: options.presencePenalty,
    providerOptions: options.providerOptions,
    seed: options.seed,
    stopSequences: options.stopSequences,
    stream: input.stream,
    temperature: options.temperature,
    toolChoice: options.toolChoice,
    tools: options.tools,
    topK: options.topK,
    topP: options.topP,
  });
}

/** 从 StreamTextResult 的各聚合 promise 解析出的快照；任一项失败都回退 undefined。 */
interface StreamModelIOAggregate {
  /** 最终 finishReason（SDK 归一化值）。 */
  finishReason?: unknown;
  /** provider 元数据（可能含 rawFinishReason 等业务线索）。 */
  providerMetadata?: unknown;
  /** 推理部分（数组，供 modelIOReasoningText 归一化）。 */
  reasoning?: unknown;
  /** 原始请求体；失败路径通常拿不到。 */
  requestBody?: unknown;
  /** 上游原始响应体，未脱敏；落盘前统一经 sanitizeModelIODebugRecord。 */
  responseBody?: unknown;
  /** 原始响应头（用于 retry-after 等溯源）。 */
  responseHeaders?: unknown;
  /** provider 响应 id。 */
  responseId?: unknown;
  /** provider 实际使用的模型 id。 */
  responseModelId?: unknown;
  /** 来源引用（需 normalizeSources 归一化）。 */
  sources?: unknown;
  /** 聚合文本。 */
  text?: unknown;
  /** 聚合工具结果（需 normalizeToolResults 归一化）。 */
  toolResults?: unknown;
  /** token 用量；优先 totalUsage，其次 usage。 */
  usage?: Parameters<typeof normalizeUsage>[0];
}

// StreamTextResult 的聚合字段都是 promise，逐个 best-effort 解析(失败回退 undefined)。
/**
 * 成功路径：并行解析 text/reasoning/toolResults/sources/usage 以及 request/response 元数据。
 * 各 promise 单独兜 catch，任何一项 reject 都不会让整条诊断记录失败。
 */
async function resolveStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
): Promise<StreamModelIOAggregate> {
  const streamResult = result as unknown as {
    text?: Promise<unknown>;
    reasoning?: Promise<unknown>;
    finishReason?: Promise<unknown>;
    totalUsage?: Promise<unknown>;
    usage?: Promise<unknown>;
    toolResults?: Promise<unknown>;
    sources?: Promise<unknown>;
    providerMetadata?: Promise<unknown>;
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };

  const [
    text,
    reasoning,
    finishReason,
    totalUsage,
    usage,
    toolResults,
    sources,
    providerMetadata,
    request,
    response,
  ] = await Promise.all([
    settleModelIOValue(streamResult.text),
    settleModelIOValue(streamResult.reasoning),
    settleModelIOValue(streamResult.finishReason),
    settleModelIOValue(streamResult.totalUsage),
    settleModelIOValue(streamResult.usage),
    settleModelIOValue(streamResult.toolResults),
    settleModelIOValue(streamResult.sources),
    settleModelIOValue(streamResult.providerMetadata),
    settleModelIOValue(streamResult.request),
    settleModelIOValue(streamResult.response),
  ]);

  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    text,
    reasoning,
    finishReason,
    usage: (totalUsage ?? usage) as StreamModelIOAggregate["usage"],
    toolResults,
    sources,
    providerMetadata,
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

/**
 * 把 reasoning 数组归一化为纯文本，供 model-io 记录思考过程。
 * 空数组或全空白时返回 undefined；各段之间用空行分隔。
 */
function modelIOReasoningText(reasoning: unknown): string | undefined {
  if (!Array.isArray(reasoning)) {
    return undefined;
  }

  const text = normalizeReasoning(reasoning)
    ?.map((part) => part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return text && text.length > 0 ? text : undefined;
}

// 流中途被 abort 后，AI SDK 的 request/response 聚合 promise 既不 resolve 也不 reject
// （只有流正常读完或流级报错才会 settle），无限 await 会把 runner-stream 的 catch 挂死，
// turn 永不结束、activeAbortController 永不释放，session 从此拒绝一切新 prompt。
// 诊断记录是 best-effort：调用方已 abort 时直接跳过聚合，其余失败限时等待。
const FAILED_STREAM_AGGREGATE_TIMEOUT_MS = 1_000;

/**
 * 失败路径：只读取 request/response 元数据，不等待 text/toolResults 等聚合。
 * 调用方已 abort 时立即返回空快照；其余情况每项最多等待 1s 后按“值不可得”处理。
 */
async function resolveFailedStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
  abortSignal?: AbortSignal,
): Promise<StreamModelIOAggregate> {
  if (abortSignal?.aborted) {
    // 用户 Stop：让失败路径立即走完，request body 由 fallback 快照兜底。
    return {};
  }
  const streamResult = result as unknown as {
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };
  const [request, response] = await Promise.all([
    settleModelIOValueWithTimeout(streamResult.request, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
    settleModelIOValueWithTimeout(streamResult.response, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
  ]);
  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

/** 等待单个聚合值；reject 时降级为 undefined（诊断不追求完整性）。 */
async function settleModelIOValue<T>(value: Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

// 用户 stop / v4 sendQueuedNow 抢占会 abort 当前流式请求；此时
// AI SDK StreamTextResult 的 request/response 聚合 promise 永不 settle——流被中途放弃，
// 聚合要等 fullStream 关闭才 resolve，而关闭 iterator 的 finally（runner-stream.ts）
// 又排在本 await 之后，形成循环等待。settleModelIOValue 只兜 reject 不兜「不 settle」，
// 导致 runStreamText 的 catch 永远不结束：TurnCancelled 无法上抛、turn 永不收口、
// record.activeAbortController 不释放、UI 的 stop（canStop）永久失效
// （e2e 复现：conversation-session-v4-vertical-slice / v4-sendnow）。
// 失败路径的 model-io 记录必须有界等待：超时按「值不可得」处理，绝不阻塞错误传播。
/**
 * 限时等待聚合值：超时、reject 均返回 undefined。
 * 关键不变量：定时器 unref 且 finally 清理，绝不因诊断挂住事件循环或推迟错误上抛。
 */
async function settleModelIOValueWithTimeout<T>(
  value: Promise<T> | T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
    return await Promise.race([settleModelIOValue(value), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// 归一化 ZCODE_RUNTIME_ENV；未设置时返回 undefined,由调用方按生产处理。
function normalizeRuntimeEnv(env: EnvRecord): string | undefined {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
}

/**
 * model-io 的统一落盘边界：脱敏 → 选择目录/文件名 → 容量控制 → 压缩 → append/重置。
 * 全量保留模式跳过轮转与裁剪，但仍强制脱敏，并刷新压缩状态以便后续 bounded 写入续接。
 * 生产态按 session 文件计容量；文件超限时整文件重写为 bounded baseline，避免 expand 巨型历史。
 * 所有异常吞掉；model I/O 诊断永远不得影响模型请求路径。
 */
function writeModelIODebugRecord(
  record: Record<string, unknown>,
  debugDir?: string,
  isDev?: boolean,
  modelIoFullRetentionEnabled = false,
): void {
  try {
    // model-I/O 诊断直接持久化 AI SDK 的 request/response headers，
    // 闲时 Provider 的 JWT、Coding Plan Key 与 ticket 因此会写入按 session 命名的文件。
    // 在统一落盘边界复用网络遥测脱敏，保证 generate/stream 及后续调用方都不会漏掉。
    const sanitizedRecord = sanitizeModelIODebugRecord(record);
    const development = isDev ?? false;
    const dir = debugDir ?? getModelIOBaseDir(isDev ?? false);
    mkdirSync(dir, { recursive: true });
    const sessionSegment =
      sanitizeFileSegment(stringMetadata(sanitizedRecord.sessionId)) || "no-session";
    const fileName = `model-io-${sessionSegment}.jsonl`;
    const filePath = join(dir, fileName);
    const fileExists = existsSync(filePath);
    if (modelIoFullRetentionEnabled) {
      // 全量保留仍经过统一脱敏边界，但跳过轮转、限额重置、生产裁剪和上下文压缩。
      // 这是用户显式选择的诊断模式；更新 compaction state 使关闭后下一次 bounded 写入可平滑续接。
      appendFileSync(filePath, `${stringifyDebugRecord(sanitizedRecord)}\n`, "utf8");
      modelIOCompactionStates.set(filePath, buildModelIOCompactionState(sanitizedRecord));
      return;
    }
    // 生产态(rollout)做容量上限,避免长期运行把磁盘刷爆;开发态(debug)也保留更高的单文件上限。
    // 同一 session 之前每次模型请求都会新建一个完整上下文文件，形成三角形重复；
    // 现在改为一个 session 一个 JSONL 文件，新请求 append 到同文件，只有新 session 才参与淘汰。
    if (!development && !fileExists) {
      rotateModelIOFiles(dir, MAX_ROLLOUT_FILES - 1);
    }
    const existingBytes = fileExists ? readFileSize(filePath) : 0;
    const maxSessionBytes = development ? MAX_DEBUG_SESSION_BYTES : MAX_ROLLOUT_SESSION_BYTES;
    const resetForSizeLimit = existingBytes >= maxSessionBytes;
    const preparedRecord = prepareModelIORecordForWrite(sanitizedRecord, development);
    const previousState =
      fileExists && !resetForSizeLimit ? modelIOCompactionStates.get(filePath) : undefined;
    const compacted = compactModelIORecord(preparedRecord, previousState, {
      maxBaselineMessages: development
        ? MAX_DEBUG_BASELINE_MESSAGES
        : MAX_ROLLOUT_BASELINE_MESSAGES,
      preserveFullBodyMessages: Boolean(preparedRecord.error),
    });
    const recordToWrite = resetForSizeLimit
      ? {
          ...compacted,
          modelIOReset: {
            maxFileBytes: maxSessionBytes,
            previousFileBytes: existingBytes,
            reason: "session_file_size_limit",
          },
        }
      : compacted;
    const line = `${stringifyDebugRecord(recordToWrite)}\n`;
    if (resetForSizeLimit) {
      // 每次 append 前同步读取并 expand 整个历史 JSONL 的话，长 session 的 rollout
      // 文件达到 GB 级时会在 UTF-8 转换/V8 字符串分配阶段 native crash。超限时直接重置为
      // 当前 bounded baseline，保证诊断日志不会威胁 agent 主流程。
      writeFileSync(filePath, line, "utf8");
    } else {
      appendFileSync(filePath, line, "utf8");
    }
    modelIOCompactionStates.set(filePath, buildModelIOCompactionState(preparedRecord));
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

// 保证目录下 model-io-*.jsonl 文件数不超过 maxFiles(为本次新 session 文件留位时传 maxFiles-1)。
/**
 * 按 mtime 从旧到新删除多余 session 文件，并同步清理进程内压缩基线。
 * 目录读取失败或无需淘汰时直接返回；单个文件删除失败不阻断后续写入。
 */
function rotateModelIOFiles(dir: string, maxFiles: number): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
    );
  } catch {
    return; // 目录刚创建/读取失败,无需淘汰
  }

  let removeCount = files.length - maxFiles;
  if (removeCount <= 0) {
    return;
  }

  const oldestFirst = files
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .map((entry) => entry.name);
  for (const name of oldestFirst) {
    if (removeCount <= 0) break;
    const filePath = join(dir, name);
    try {
      rmSync(filePath, { force: true });
      modelIOCompactionStates.delete(filePath);
      removeCount -= 1;
    } catch {
      // 单个文件删除失败不阻断写入
    }
  }
}

// 仅保留文件名安全字符,其余折叠为 -,并限长避免触达 Windows 路径长度上限。
/** sessionId 转文件名片段：非法字符折叠为 -，去首尾 -，截断到 80 字符。 */
function sanitizeFileSegment(value?: string): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// storage profile 回滚删除了自定义 CLI 根模块，遗留 import 会让 adapters 无法构建。
// 这里保持历史语义：开发态写 ~/.zcode/cli/debug，生产态写 ~/.zcode/cli/rollout。
/** 返回 model-io 根目录：~/.zcode/cli/{debug|rollout}。 */
function getModelIOBaseDir(isDev: boolean): string {
  return join(homedir(), ".zcode", "cli", isDev ? "debug" : "rollout");
}

function stringifyDebugRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function readFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * 生产态裁剪：去掉与 canonical 上下文重复的 sdkMessages / body.messages，
 * 以及价值较低且可能很大的 response.body；失败记录保留完整 body.messages 供 400 排障。
 * 开发态原样返回，不做裁剪。
 */
function prepareModelIORecordForWrite(
  record: Record<string, unknown>,
  isDev: boolean,
): Record<string, unknown> {
  if (isDev) {
    return record;
  }

  const request = asRecord(record.request);
  const response = asRecord(record.response);
  return {
    ...record,
    request: request ? prepareProductionRequestRecord(request, Boolean(record.error)) : request,
    response: response ? prepareProductionResponseRecord(response) : response,
  };
}

/**
 * 生产 request 裁剪：默认删除 sdkMessages 与 body.messages（与 canonical messages 重复）。
 * 仅成功记录删除 body.messages；失败记录保留 exact payload，避免丢掉 provider 报错的上下文。
 */
function prepareProductionRequestRecord(
  request: Record<string, unknown>,
  hasError: boolean,
): Record<string, unknown> {
  const next = { ...request };
  // 生产 rollout 只保留 canonical request.messages。sdkMessages 与 provider body.messages
  // 通常是同一上下文的重复拷贝，长会话下会把诊断文件和单次 stringify 放大数倍。
  delete next.sdkMessages;
  const body = asRecord(next.body);
  if (body && !hasError) {
    const nextBody = { ...body };
    delete nextBody.messages;
    next.body = nextBody;
  }
  return next;
}

/** 生产 response 裁剪：删除原始 response.body，仅保留 text/toolCalls/usage 等归一化字段。 */
function prepareProductionResponseRecord(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...response };
  // response.body 在生产排障里价值低于 text/toolCalls/usage/finishReason，且可能包含 provider 原始大包。
  delete next.body;
  return next;
}

/**
 * 记录级压缩入口：只处理 request 下的三类消息集合，其他字段原样透传。
 * previousState 为进程内缓存的上次写入快照；缺失时退化为 tail/full 写法。
 */
function compactModelIORecord(
  record: Record<string, unknown>,
  previousState: ModelIOCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const request = asRecord(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: compactModelIORequest(request, previousState?.request, options),
  };
}

/**
 * request 级压缩：对 messages / sdkMessages / body.messages 三份集合分别计算
 * delta（相对上次）、tail（超基线取尾部）或 full，并写入对应 count/kind/offset 元数据。
 * 失败且需保留 exact payload 时，body.messages 强制按 full 记录。
 */
function compactModelIORequest(
  request: Record<string, unknown>,
  previousState: ModelIORequestCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const next = { ...request };
  compactMessageCollection(
    next,
    previousState?.messages,
    {
      collectionKey: "messages",
      countKey: "messageCount",
      kindKey: "messagesKind",
      offsetKey: "messageOffset",
    },
    options,
  );
  compactMessageCollection(
    next,
    previousState?.sdkMessages,
    {
      collectionKey: "sdkMessages",
      countKey: "sdkMessageCount",
      kindKey: "sdkMessagesKind",
      offsetKey: "sdkMessageOffset",
    },
    options,
  );

  const body = asRecord(next.body);
  if (body) {
    const nextBody = { ...body };
    const bodyMessageKeys = {
      collectionKey: "messages",
      countKey: "bodyMessageCount",
      kindKey: "bodyMessagesKind",
      offsetKey: "bodyMessageOffset",
    };
    if (options.preserveFullBodyMessages && Array.isArray(nextBody.messages)) {
      // provider 400 等失败排障需要 exact request payload；失败记录若继续
      // 按上一条 model-io 做 delta，会把最关键的完整 messages 丢在导出包之外。
      next[bodyMessageKeys.countKey] = nextBody.messages.length;
      next[bodyMessageKeys.kindKey] = "full";
      next[bodyMessageKeys.offsetKey] = 0;
    } else {
      compactMessageCollection(
        nextBody,
        previousState?.bodyMessages,
        bodyMessageKeys,
        options,
        next,
      );
    }
    next.body = nextBody;
  }

  return next;
}

/**
 * 单集合压缩：能证明“只在尾部新增”时写 delta；否则超过基线长度写 tail；
 * 小集合或无法压缩时写 full。同时把 count/kind/offset 写入 metadataTarget。
 * 形如 <key>Kind=delta 的记录必须配合 <key>Offset 才能还原完整历史。
 */
function compactMessageCollection(
  target: Record<string, unknown>,
  previousState: ModelIOCollectionState | undefined,
  keys: {
    collectionKey: string;
    countKey: string;
    kindKey: string;
    offsetKey: string;
  },
  options: { maxBaselineMessages: number },
  metadataTarget: Record<string, unknown> = target,
): void {
  const currentMessages = target[keys.collectionKey];
  if (!Array.isArray(currentMessages)) {
    return;
  }

  metadataTarget[keys.countKey] = currentMessages.length;
  if (canStoreDeltaFromState(currentMessages, previousState)) {
    // 后续 model-io 只记录相对上一请求新增的消息，避免完整历史在同一 session 内梯度重复。
    // previousState 来自进程内缓存，不再为 append 同步读取并 expand 整个历史 JSONL。
    target[keys.collectionKey] = currentMessages.slice(previousState.count);
    metadataTarget[keys.kindKey] = "delta";
    metadataTarget[keys.offsetKey] = previousState.count;
    return;
  }

  const maxBaselineMessages = Math.max(1, options.maxBaselineMessages);
  if (currentMessages.length > maxBaselineMessages) {
    const offset = currentMessages.length - maxBaselineMessages;
    target[keys.collectionKey] = currentMessages.slice(offset);
    metadataTarget[keys.kindKey] = "tail";
    metadataTarget[keys.offsetKey] = offset;
    return;
  }

  metadataTarget[keys.kindKey] = "full";
  metadataTarget[keys.offsetKey] = 0;
}

/**
 * 判断当前集合能否安全地相对 previousState 写 delta。
 * 条件：上次计数 > 0、当前长度未缩短、首元素与上次尾部元素指纹一致、采样指纹一致。
 * 任一不满足都返回 false，宁可多写也不能漏掉被改写的历史。
 */
function canStoreDeltaFromState(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState | undefined,
): previousState is ModelIOCollectionState {
  if (!previousState || previousState.count <= 0 || currentMessages.length < previousState.count) {
    return false;
  }
  const firstFingerprint = fingerprintValue(currentMessages[0]);
  const lastFingerprint = fingerprintValue(currentMessages[previousState.count - 1]);
  return (
    firstFingerprint === previousState.firstFingerprint &&
    lastFingerprint === previousState.lastFingerprint &&
    hasSameSampleFingerprints(currentMessages, previousState)
  );
}

/** 从已写入的记录重建压缩状态（供全量保留模式与正常 append 后缓存使用）。 */
function buildModelIOCompactionState(record: Record<string, unknown>): ModelIOCompactionState {
  const request = asRecord(record.request);
  if (!request) {
    return {};
  }

  return {
    request: buildRequestCompactionState(request),
  };
}

/** 分别从 request.body.messages、request.messages、request.sdkMessages 建立集合基线。 */
function buildRequestCompactionState(
  request: Record<string, unknown>,
): ModelIORequestCompactionState {
  const body = asRecord(request.body);
  return {
    bodyMessages: buildCollectionState(body?.messages),
    messages: buildCollectionState(request.messages),
    sdkMessages: buildCollectionState(request.sdkMessages),
  };
}

/** 数组值建立 count/首尾/采样指纹；非数组返回 undefined（无法作为基线）。 */
function buildCollectionState(value: unknown): ModelIOCollectionState | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return {
    count: value.length,
    firstFingerprint: fingerprintValue(value[0]),
    lastFingerprint: fingerprintValue(value[value.length - 1]),
    sampleFingerprints: fingerprintCollectionSamples(value),
  };
}

/** 比较上次基线位置上的采样指纹与当前集合是否一致；无采样信息时视为一致。 */
function hasSameSampleFingerprints(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState,
): boolean {
  const previousSamples = previousState.sampleFingerprints;
  if (!previousSamples) {
    return true;
  }
  const currentSamples = fingerprintCollectionSamples(currentMessages, previousState.count);
  return (
    currentSamples.length === previousSamples.length &&
    currentSamples.every((fingerprint, index) => fingerprint === previousSamples[index])
  );
}

/**
 * 取 0/25%/50%/75%/100% 五个位置的指纹，作为“历史前缀未变”的廉价证据。
 * count 指定要采样的前缀长度（对比上次基线时传入上次 count）。
 */
function fingerprintCollectionSamples(value: unknown[], count = value.length): string[] {
  if (count <= 0) {
    return [];
  }
  // 常数级采样首/中/尾位置，避免把整段历史 stringify 成巨型字符串，同时降低中间历史变更被误判为 delta 的概率。
  const lastIndex = count - 1;
  const indexes = new Set([
    0,
    Math.floor(lastIndex * 0.25),
    Math.floor(lastIndex * 0.5),
    Math.floor(lastIndex * 0.75),
    lastIndex,
  ]);
  return [...indexes].map((index) => fingerprintValue(value[index]));
}

/**
 * 生成值的稳定指纹：字符串取长度+首尾片段，对象取键数与最多 12 个键值（递归深度 ≤3）。
 * 目标是低成本检测“是否同一段历史”，不要求密码学强度，也不应因大对象产生巨型字符串。
 */
function fingerprintValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return [
      "string",
      String(value.length),
      value.slice(0, FINGERPRINT_STRING_LIMIT),
      value.slice(-FINGERPRINT_STRING_LIMIT),
    ].join(":");
  }
  if (typeof value !== "object") {
    return `${typeof value}:${String(value)}`;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? `array:${value.length}` : "object";
  }
  if (Array.isArray(value)) {
    return [
      "array",
      String(value.length),
      fingerprintValue(value[0], depth + 1),
      fingerprintValue(value[value.length - 1], depth + 1),
    ].join(":");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const sampledKeys = keys.slice(0, 12);
  return [
    "object",
    String(keys.length),
    ...sampledKeys.map((key) => `${key}=${fingerprintValue(record[key], depth + 1)}`),
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

/** 把任意错误序列化为 {name,message,stack}；非 Error 统一标记为 UnknownError。 */
function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
