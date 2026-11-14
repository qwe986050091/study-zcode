import { getCurrentModelInvocationContext } from "@zcode/contracts";
import type { ConversationCapturePort, ConversationProviderExchangeRecord } from "./contract.js";

/*
 * ============================================================
 * conversation-recording / capture.ts —— provider 请求/响应的旁路采集
 *
 * 定位：把 AI SDK 实际发出的 fetch 包一层，在真实链路旁复制请求与响应并交给
 * ConversationCapturePort；它不决定业务成功与否，只负责“看得见”。
 *
 * 输入输出：输入是 provider 的 fetch 与 model/provider 标识；输出仍是原 fetch 的
 * 返回对象（同一个 Response 实例），调用方拿到的语义完全不变。
 *
 * 副作用：读取 invocation metadata（sessionId/traceId/turnId），异步后台读取响应体
 * 并调用 capture.recordProviderExchange（通常落 capture.jsonl）。
 *
 * 失败语义：网络请求失败时记录 error 后原样 rethrow；响应体读取或记录失败一律吞掉，
 * 不能反过来影响主请求/流。响应体不可得时保持 body 缺失，不伪造空串。
 *
 * 不变量：clone 必须在 Resolve 之前完成；所有记录都只发生在旁路，绝不 await 到
 * 模型调用路径上。
 * ============================================================
 */

type ProviderFetch = typeof globalThis.fetch;

const UNKNOWN_VALUE = "unknown";

/**
 * 构造带采集副作用的 provider fetch。
 *
 * 入参 capture 是唯一写入端口，fetch 是被装饰的原始实现，modelId/providerId 用于回放时
 * 归属到具体 provider 维度。返回值与原始 fetch 签名一致（可直接替换使用）。
 *
 * 每次调用先固定 capturedAt 与本次 invocation 元数据，再尝试记录请求；成功时在返回
 * Response 之前 clone 响应并在后台读取，失败时补记一条带 error 的 exchange 后抛回原错误。
 * 副作用仅限 capture.recordProviderExchange，不改变请求、不重试、不缓存。
 */
export function createConversationCaptureFetch(input: {
  capture: ConversationCapturePort;
  fetch: ProviderFetch;
  modelId: string;
  providerId: string;
}): ProviderFetch {
  return async (request, init) => {
    const capturedAt = Date.now();
    const invocation = readInvocationMetadata();
    const exchangeBase = {
      capturedAt: new Date(capturedAt).toISOString(),
      ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
      ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
      modelId: input.modelId,
      providerId: input.providerId,
    } satisfies Omit<ConversationProviderExchangeRecord, "request" | "type">;

    const requestRecord = await captureRequestRecord(request, init);

    try {
      const response = await input.fetch(request, init);
      // clone 必须在返回给 AI SDK 前创建；读取放到后台，绝不阻塞主请求/流。
      void captureResponseBody({
        capture: input.capture,
        exchangeBase,
        capturedAt,
        request: requestRecord,
        response,
      });
      return response;
    } catch (error) {
      input.capture.recordProviderExchange({
        ...exchangeBase,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - capturedAt,
        error: serializeError(error),
        request: requestRecord,
        type: "provider_exchange",
      });
      throw error;
    }
  };
}

/**
 * 从 request/init 组合出可持久化的请求快照。
 *
 * 返回 method（大写，默认 GET）、url、headers（init 覆盖 request 同名键）、body（可能缺失）。
 * 纯读取，不消费原始 body；任何读取失败都降级为 undefined 而不是抛错。
 */
async function captureRequestRecord(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<ConversationProviderExchangeRecord["request"]> {
  return {
    body: await readRequestBody(request, init),
    headers: readRequestHeaders(request, init),
    method: readRequestMethod(request, init),
    url: readRequestUrl(request),
  };
}

/**
 * 后台读取响应 clone 的正文并写入一条 provider_exchange。
 *
 * 除 body 外始终保留 status 与 headers；body 读取失败时把错误一并记录（说明“不可得”而
 * 不是“为空”）。写入失败被吞掉——此时响应已经返回调用方，记录异常不能反向冒泡。
 */
async function captureResponseBody(input: {
  capture: ConversationCapturePort;
  capturedAt: number;
  exchangeBase: Omit<ConversationProviderExchangeRecord, "request" | "type">;
  request: ConversationProviderExchangeRecord["request"];
  response: Response;
}): Promise<void> {
  const responseHeaders = readHeaders(input.response.headers);
  const responseStatus = input.response.status;
  let body: string | undefined;
  let error: ConversationProviderExchangeRecord["error"];
  try {
    body = await input.response.clone().text();
  } catch (cause) {
    // 流被 abort / 连接中断时仍保留 status 与 headers；body 不可得不能被伪造成空串。
    error = serializeError(cause);
  }
  try {
    input.capture.recordProviderExchange({
      ...input.exchangeBase,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - input.capturedAt,
      ...(error ? { error } : {}),
      request: input.request,
      response: {
        ...(body === undefined ? {} : { body }),
        headers: responseHeaders,
        status: responseStatus,
      },
      type: "provider_exchange",
    });
  } catch {
    // 记录失败不得影响已经返回给调用方的响应流。
  }
}

/**
 * 读取 AsyncLocalStorage 中的模型调用上下文，只透传非空字符串标识。
 *
 * 缺失或类型不符的字段直接省略，保证落盘记录里不会出现空串/undefined 噪音。
 * 无 sessionId 时由 recorder 归入 no-session 目录。
 */
function readInvocationMetadata(): { sessionId?: string; traceId?: string; turnId?: string } {
  const metadata = getCurrentModelInvocationContext()?.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  return {
    ...(typeof metadata.sessionId === "string" && metadata.sessionId.length > 0
      ? { sessionId: metadata.sessionId }
      : {}),
    ...(typeof metadata.traceId === "string" && metadata.traceId.length > 0
      ? { traceId: metadata.traceId }
      : {}),
    ...(typeof metadata.turnId === "string" && metadata.turnId.length > 0
      ? { turnId: metadata.turnId }
      : {}),
  };
}

/**
 * 尽力提取请求体文本：优先 init.body（字符串直接返回，其它形态用 Response 转文本），
 * 其次 request.clone().text()；流式/不可读 body 返回 undefined。
 *
 * 该函数只服务记录，绝不阻断请求；因此所有异常都被吞成 undefined。
 */
async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body !== undefined && init.body !== null) {
    // 非文本 body 仍要尽量保留原文；失败时留空而不是阻断请求。
    try {
      return await new Response(init.body).text();
    } catch {
      return undefined;
    }
  }
  if (request instanceof Request) {
    try {
      return await request.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 解析请求方法：init.method 优先（统一大写），其次 Request 自带方法，最后按 GET。 */
function readRequestMethod(request: RequestInfo | URL, init: RequestInit | undefined): string {
  if (typeof init?.method === "string") return init.method.toUpperCase();
  if (request instanceof Request) return request.method.toUpperCase();
  return "GET";
}

/** 解析请求 URL：字符串原样、URL 转字符串、Request 取 url；无法识别时用 unknown 占位。 */
function readRequestUrl(request: RequestInfo | URL): string {
  if (typeof request === "string") return request;
  if (request instanceof URL) return request.toString();
  if (request instanceof Request) return request.url;
  return UNKNOWN_VALUE;
}

/**
 * 合并 request 与 init 的 headers（init 覆盖同名键），转成可 JSON 序列化的普通对象。
 * 这与 fetch 自身的合并规则一致，保证记录的就是实际发送的那份 header。
 */
function readRequestHeaders(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Record<string, string> {
  const headers = new Headers(request instanceof Request ? request.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return readHeaders(headers);
}

function readHeaders(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * 把任意异常归一化成 { name?, message, stack? }。
 *
 * 非 Error 值退化为字符串 message，保证错误记录永远可 JSON 序列化；空 name/stack 省略。
 */
function serializeError(error: unknown): NonNullable<ConversationProviderExchangeRecord["error"]> {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
