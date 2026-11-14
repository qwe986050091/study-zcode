// ============================================================
// 文件定位：带代理与自定义 CA 的 fetch 实现；无策略时直接用全局 fetch。
// 输入输出：输入 fetch(input, init)，输出标准的 Response；非 http(s) 或无需策略时直连。
// 副作用：可能起一次 http/https 请求、创建 Agent/ProxyAgent、懒加载一次 CA 证书文件。
// 失败语义：网络失败/abort 以 reject 返回；状态码超出 200–599 抛 UnsupportedHttpStatusError。
// 不变量：每个请求独立 Agent；监听器在 settle 时统一解绑，避免悬挂与重复 reject。
// ============================================================
import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import {
  loadTlsCaCertificates,
  resolveProxyUrlForRequest,
  resolveTlsCaCertFile,
} from "./http-config.js";
import { readIncomingResponse, toWebResponse } from "./incoming-response.js";

// 兼容标准 fetch 的签名；测试可注入替身。
export type NetworkFetch = typeof globalThis.fetch;

// 代理 fetch 配置：任一项存在才启用自定义实现，否则完全等价于全局 fetch。
interface NetworkProxyFetchOptions {
  // 自定义 CA 证书文件路径（PEM）。
  caCertFile?: string;
  // 环境变量来源；用于解析 ZCODE_HTTP_PROXY / NO_PROXY 等。
  env?: Record<string, string | undefined>;
  // 直连/回退用的 fetch 实现，默认 globalThis.fetch。
  fetch?: NetworkFetch;
  // 显式代理地址，优先于环境变量。
  httpProxy?: string;
  // 显式 NO_PROXY 列表。
  noProxy?: string;
}

// 归一化后的请求：body 已读成 Buffer，保证 http.request 能一次写完并支持重试/代理。
interface NormalizedFetchRequest {
  // 请求体；GET/HEAD 或空体时为 undefined。
  body?: Buffer;
  // 原始请求头（Headers 已在构造时规范化键名）。
  headers: Headers;
  // 大写 HTTP 方法。
  method: string;
  // 取消信号；外部 abort 会销毁请求与响应流。
  signal?: AbortSignal | null;
  // 解析后的绝对 URL（含 query）。
  url: URL;
}

/**
 * 工厂：按配置返回一个 fetch 兼容函数。
 * 没有任何代理/CA 策略时原样返回 directFetch（零开销）；CA 证书内容按实例懒加载并缓存。
 */
export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): NetworkFetch {
  const directFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!hasNetworkFetchPolicy(options)) {
    return directFetch;
  }

  let tlsCaCertificates: Buffer | undefined;
  let tlsCaCertificatesLoaded = false;

  const getTlsCaCertificates = (): Buffer | undefined => {
    // 只读一次文件：证书在进程生命周期内不变，重复读盘会成为高频请求的额外延迟。
    if (!tlsCaCertificatesLoaded) {
      tlsCaCertificates = loadTlsCaCertificates(options);
      tlsCaCertificatesLoaded = true;
    }
    return tlsCaCertificates;
  };

  return async (input, init) => {
    const requestUrl = readFetchInputUrl(input);
    // 非 http(s) 请求没有代理/CA 语义，交给原生 fetch（如 data: URL）。
    if (!requestUrl || (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:")) {
      return directFetch(input, init);
    }

    const proxyUrl = resolveProxyUrlForRequest(requestUrl, options);
    const caCertFile = resolveTlsCaCertFile(options);
    // 既无代理也无自定义 CA：没必要走自研链路，直连性能更好。
    if (!proxyUrl && !caCertFile) {
      return directFetch(input, init);
    }

    const request = await normalizeFetchRequest(input, init);
    return fetchWithAgent(request, {
      ca: caCertFile ? getTlsCaCertificates() : undefined,
      proxyUrl,
    });
  };
}

// 仅当显式给出代理/CA/环境配置时才启用自研链路；空对象等价于“无策略”。
function hasNetworkFetchPolicy(options: NetworkProxyFetchOptions): boolean {
  return Boolean(
    options.caCertFile ||
      options.env ||
      options.httpProxy ||
      options.noProxy,
  );
}

// 从 fetch 的三种入参形态（URL / Request / string）提取 URL；非法输入返回 undefined 走直连。
function readFetchInputUrl(input: Parameters<NetworkFetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

/**
 * 把任意 fetch 入参固化成可发起的请求：构造 Request 后读出 method/headers/signal/url。
 * 非 GET/HEAD 才读 body，且空体归为 undefined，避免给 http.request 传零长度流。
 */
async function normalizeFetchRequest(
  input: Parameters<NetworkFetch>[0],
  init: Parameters<NetworkFetch>[1],
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const arrayBuffer =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = arrayBuffer && arrayBuffer.byteLength > 0 ? Buffer.from(arrayBuffer) : undefined;

  return {
    body,
    headers: request.headers,
    method,
    signal: request.signal,
    url: new URL(request.url),
  };
}

/**
 * 真正发请求：按协议选 http/https，每次新建 Agent（代理时用 ProxyAgent）。
 * 用 settled 保证 Promise 只结算一次；abort 会销毁请求与响应流并按 AbortError reject。
 */
function fetchWithAgent(
  request: NormalizedFetchRequest,
  options: { ca?: Buffer; proxyUrl?: string },
): Promise<Response> {
  const transport = request.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = request.signal ?? undefined;
    // 入口即检查：信号已 abort 时不再发起连接，直接以原始 reason 失败。
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let settled = false;
    let responseMessage: http.IncomingMessage | undefined;
    let clientRequest: http.ClientRequest | undefined;

    // 统一解绑所有监听器：成功、失败、abort 三条路径都必须走到这里，防止监听器累积。
    const cleanupAll = (): void => {
      signal?.removeEventListener("abort", onAbort);
      clientRequest?.off("error", onRequestError);
      clientRequest?.off("close", onRequestClose);
      responseMessage?.off("close", cleanupAll);
      responseMessage?.off("error", onResponseError);
    };
    // 幂等 reject：settled 之后到达的错误（如 close 与 error 同时触发）直接忽略。
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error);
    };
    const onRequestClose = (): void => {
      if (!responseMessage && settled) cleanupAll();
    };
    const onResponseError = (): void => {
      // The web Response body receives the stream error through Readable.toWeb;
      // this listener only prevents Node from treating abort destroy as unhandled.
    };
    // abort 处理：先销毁两条流（让上层 body 读取立即失败），再按原始 reason 失败 Promise。
    const onAbort = (): void => {
      const error = abortReason(signal);
      responseMessage?.destroy(error);
      clientRequest?.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    clientRequest = transport.request(
      {
        agent: createRequestAgent(request.url, options),
        headers: headersToOutgoing(request.headers),
        hostname: request.url.hostname,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || undefined,
        protocol: request.url.protocol,
      },
      (message) => {
        responseMessage = message;
        responseMessage.once("close", cleanupAll);
        responseMessage.once("error", onResponseError);
        // 回调里抛出的东西没人接得住、会打死整个 agent 进程（network/incoming-response.ts）：
        // 表示不了的状态码只让这一次请求失败。
        let response: Response;
        try {
          response = toWebResponse(readIncomingResponse(message));
        } catch (error) {
          message.destroy();
          rejectOnce(error);
          return;
        }
        settled = true;
        resolve(response);
      },
    );

    clientRequest.once("error", onRequestError);
    clientRequest.once("close", onRequestClose);
    clientRequest.end(request.body);
  });
}

// 把 AbortSignal.reason 归一成 Error；无 reason 时构造 name=AbortError 的等价错误。
function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * 按请求创建 Agent：有代理时用 ProxyAgent（强制该 URL 走代理，并把 CA 传给内层 https Agent）；
 * 否则 https 直接用带 CA 的 Agent，http 用默认 Agent。
 */
function createRequestAgent(
  url: URL,
  options: { ca?: Buffer; proxyUrl?: string },
): http.Agent | https.Agent | ProxyAgent {
  if (options.proxyUrl) {
    return new ProxyAgent({
      ca: options.ca,
      getProxyForUrl: () => options.proxyUrl ?? "",
      httpsAgent: options.ca ? new https.Agent({ ca: options.ca }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:") {
    return new https.Agent({ ca: options.ca });
  }
  return new http.Agent();
}

// Headers → Node 出站头：Headers 已做键名规范化，这里直接平铺成对象。
function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}
