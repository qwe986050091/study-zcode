// ============================================================
// Node HTTP Client Adapter
// ============================================================
/**
 * ============================================================================
 * http/index.ts —— HttpClientPort 的 Node 实现
 * ============================================================================
 *
 * 【定位】所有模型/工具/网页请求的统一出站入口。优先用原生 fetch；当需要
 * 自定义 CA、代理或 public egress 的 DNS 校验时，降级到 node:http/https
 * 手写请求（因为 fetch 无法注入 agent/lookup）。
 *
 * 【超时与取消】timeoutMs 默认 180s；超时通过 AbortController 触发，并标记
 * timedOut，最终错误码为 timeout 而不是 cancelled。调用方 signal 与内部
 * controller 通过监听器桥接，finally 里必须解绑，避免长生命周期 signal 泄漏。
 *
 * 【安全不变量】egressPolicy="public" 时：代理一律拒绝（代理侧 DNS 无法验证）；
 * 建连前先做 DNS 解析并校验所有解析结果都是公网地址，且实际连接复用同一份
 * lookup 结果，防止 DNS rebinding（校验后二次解析到内网）。
 *
 * 【响应口径】正文最多 maxResponseBytes（默认 10MB），先看 content-length
 * 快速拒绝，再在流式读取中累计字节数兜底；超限统一 too_large。
 * ============================================================================
 */

import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import {
  createHttpClientError,
  isHttpClientPortError,
  type HttpClientEgressInfo,
  type HttpClientPort,
  type HttpClientRequest,
  type HttpClientResponse,
  type HttpClientRunOptions,
} from "@zcode/contracts";
import {
  loadTlsCaCertificates,
  resolveProxyForRequest,
  resolveWebFetchProxyForRequest,
} from "../network/http-config.js";
import {
  assertPublicEgressDestination,
  createPublicEgressLookup,
  defaultPublicDnsLookup,
  type DnsLookup,
} from "./public-egress-policy.js";
import { readIncomingResponse } from "../network/incoming-response.js";
import { readResponseBody, type ResponseLike } from "./response-body.js";

const TRACE_HEADER = "x-zcode-trace-id";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface NodeHttpClientAdapterOptions {
  /** 读取代理/CA 等环境变量的来源；缺省 process.env。 */
  env?: Record<string, string | undefined>;
  /** 单请求默认超时（毫秒），<=0 表示不设超时。 */
  timeoutMs?: number;
  /** 响应正文字节硬上限；同时用于 content-length 预检与流式累计。 */
  maxResponseBytes?: number;
  /** 显式代理地址；优先于 env 中的 HTTP(S)_PROXY。 */
  proxyUrl?: string;
  /** 不走代理的 host 列表（NO_PROXY 语义）。 */
  noProxy?: string;
  /** 自定义 CA 证书文件路径，加载后用于 https 校验。 */
  caCertFile?: string;
  /** 注入 DNS 解析器以便测试；public egress 时默认使用系统 lookup。 */
  dnsLookup?: DnsLookup;
  /** WebFetch 场景：只接受启动时捕获的用户代理环境变量，忽略运行期注入。 */
  capturedUserProxyEnvFallback?: boolean;
}

/**
 * 发起一次 HTTP(S) 请求并读完正文。
 *
 * 返回 status/statusText/headers/body/bytes/durationMs/egress；状态码不设限
 * （包括 999 等非标准码）。失败时统一包装成 HttpClientPortError：超时→timeout，
 * 取消→cancelled，代理失败→proxy_error，其余→network_error；
 * egress 校验失败保持 egress_blocked。
 *
 * 副作用：网络 IO；创建并清理超时定时器与 abort 监听器；CA 证书首次读取后
 * 在实例内缓存（进程内不再重复读盘）。
 */
export class NodeHttpClientAdapter implements HttpClientPort {
  /** 已加载的自定义 CA；undefined 表示不使用自定义 CA。 */
  private tlsCaCertificates: Buffer | undefined;
  /** 保证 CA 文件只读一次（无论成功与否），避免每个请求都打盘。 */
  private tlsCaLoaded = false;

  constructor(private readonly options: NodeHttpClientAdapterOptions = {}) {}

  /**
   * 请求主流程。
   *
   * 输入 request.url 必须是 http/https 绝对地址；options.signal 控制取消。
   * 输出 body 已完整读入内存（非流式），bytes 为实际字节数。
   * 见类头注释：public egress 的 DNS 校验与连接复用是安全关键路径。
   */
  async request(
    request: HttpClientRequest,
    options: HttpClientRunOptions = {},
  ): Promise<HttpClientResponse> {
    const startedAt = Date.now();
    const url = normalizeUrl(request.url);
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      request.maxResponseBytes ?? this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const proxyResolver = this.options.capturedUserProxyEnvFallback
      ? resolveWebFetchProxyForRequest
      : resolveProxyForRequest;
    const proxy = proxyResolver(url, {
      env: this.options.env,
      httpProxy: this.options.proxyUrl,
      noProxy: this.options.noProxy,
    });
    const publicDnsLookup =
      request.egressPolicy === "public"
        ? (this.options.dnsLookup ?? defaultPublicDnsLookup())
        : undefined;
    const tlsCaCertificates = this.resolveTlsCaCertificates();
    const egress = buildEgressInfo(proxy, tlsCaCertificates);
    const abortController = new AbortController();
    const abortState = linkAbortSignals(options.signal, abortController);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      // 超时与用户取消走同一个 AbortController，但用 timedOut 标记区分错误码；
      // 否则调用方无法判断该重试（超时）还是该停（取消）。
      timeout = setTimeout(() => {
        abortState.timedOut = true;
        abortController.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    try {
      if (publicDnsLookup) {
        // 先校验再建连；且下方 createPublicEgressLookup 会把这份已校验的结果
        // 直接交给 socket，避免校验后再次 DNS 解析造成 rebinding 窗口。
        assertPublicEgressProxyBoundary(url, proxy.proxyUrl);
        await assertPublicEgressDestination(url, publicDnsLookup, {
          signal: abortController.signal,
        });
      }
      const response = await fetchHttpResponse(
        url,
        request,
        abortController.signal,
        proxy.proxyUrl,
        tlsCaCertificates,
        publicDnsLookup,
      );
      const responseUrl = response.url || url.toString();
      const body = await readResponseBody(
        response,
        maxResponseBytes,
        abortController.signal,
        responseUrl,
      );

      return {
        url: responseUrl,
        status: response.status,
        statusText: response.statusText,
        headers: headersToRecord(response.headers),
        body,
        bytes: body.byteLength,
        durationMs: Math.max(0, Date.now() - startedAt),
        egress,
      };
    } catch (error) {
      throw toHttpClientError(error, {
        cancelled: abortController.signal.aborted && !abortState.timedOut,
        proxied: Boolean(proxy.proxyUrl),
        timedOut: abortState.timedOut,
        url: url.toString(),
      });
    } finally {
      // 必须解除父 signal 监听：长生命周期 signal（会话级）会持有 controller 引用。
      if (timeout) clearTimeout(timeout);
      abortState.unlink();
    }
  }

  private resolveTlsCaCertificates(): Buffer | undefined {
    if (!this.tlsCaLoaded) {
      this.tlsCaCertificates = loadTlsCaCertificates({
        caCertFile: this.options.caCertFile,
        env: this.options.env,
      });
      this.tlsCaLoaded = true;
    }
    return this.tlsCaCertificates;
  }
}

/** 创建标准出站 HTTP 客户端（代理环境变量在每次请求时解析）。 */
export function createNodeHttpClientAdapter(
  options: NodeHttpClientAdapterOptions = {},
): HttpClientPort {
  return new NodeHttpClientAdapter(options);
}

/**
 * 创建 WebFetch 专用客户端：启用 capturedUserProxyEnvFallback。
 *
 * 网页抓取只信任 CLI 启动时捕获的用户代理配置，不接受请求级注入的代理，
 * 防止通过参数把抓取流量导向攻击者代理。
 */
export function createNodeWebFetchHttpClientAdapter(
  options: NodeHttpClientAdapterOptions = {},
): HttpClientPort {
  return new NodeHttpClientAdapter({
    ...options,
    capturedUserProxyEnvFallback: true,
  });
}

/**
 * 按需选择 fetch 或 node:http(s)。
 *
 * 只有"无代理、无自定义 CA、无 public egress lookup"这三个条件全满足时才用
 * 原生 fetch；任一需要注入 agent/lookup 就手写请求，因为 fetch 不暴露这些钩子。
 */
function fetchHttpResponse(
  url: URL,
  request: HttpClientRequest,
  signal: AbortSignal,
  proxyUrl: string | undefined,
  tlsCaCertificates: Buffer | undefined,
  publicDnsLookup: DnsLookup | undefined,
): Promise<ResponseLike & { statusText: string; url?: string }> {
  const useCustomTlsAgent = url.protocol === "https:" && tlsCaCertificates !== undefined;
  if (!proxyUrl && !useCustomTlsAgent && !publicDnsLookup) {
    return fetch(url.toString(), {
      body: request.body ? Buffer.from(request.body) : undefined,
      method: request.method ?? "GET",
      headers: buildHeaders(request),
      redirect: request.redirect ?? "manual",
      signal,
    });
  }

  const headers = buildHeaders(request);
  const transport = url.protocol === "https:" ? https : http;
  const agent = createRequestAgent(url, proxyUrl, tlsCaCertificates);
  const lookup = publicDnsLookup
    ? createPublicEgressLookup(url.toString(), publicDnsLookup, { signal })
    : undefined;

  return new Promise((resolve, reject) => {
    const requestOptions: http.RequestOptions = {
      agent,
      headers: headersToOutgoing(headers),
      hostname: url.hostname,
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      port: url.port || undefined,
      protocol: url.protocol,
      signal,
    };
    const clientRequest = transport.request(
      {
        ...requestOptions,
        lookup: proxyUrl ? undefined : lookup,
      },
      (message) => {
        // 不包成 `Response`：它表示不了 999 之类的状态码，而这里只要状态、头与正文（与原生 fetch 一样原样带回）。
        // 回调里抛出的东西没人接得住、会打死整个 agent 进程，所以一律转成这一次请求的 reject。
        try {
          resolve(readIncomingResponse(message));
        } catch (error) {
          message.destroy();
          reject(error);
        }
      },
    );

    clientRequest.once("error", reject);
    clientRequest.end(request.body ? Buffer.from(request.body) : undefined);
  });
}

/**
 * 解析并校验 URL。
 *
 * 只允许 http/https；非法 URL 或协议统一抛 HttpClientPortError，避免把
 * file:// 等协议误送进请求层。
 */
function normalizeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw createHttpClientError({
      code: "invalid_url",
      url: value,
      message: `Invalid URL: ${value}`,
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw createHttpClientError({
      code: "unsupported_protocol",
      url: value,
      message: `Unsupported URL protocol for HTTP request: ${url.protocol}`,
    });
  }

  return url;
}

/**
 * 构造请求 agent。
 *
 * 代理优先（ProxyAgent 内部处理 http/https 目标）；否则仅 https + 自定义 CA
 * 时用 https.Agent；其余返回 undefined 交给 Node 默认 agent。
 */
function createRequestAgent(
  url: URL,
  proxyUrl: string | undefined,
  tlsCaCertificates: Buffer | undefined,
): http.Agent | undefined {
  if (proxyUrl) {
    return new ProxyAgent({
      ca: tlsCaCertificates,
      getProxyForUrl: () => proxyUrl,
      httpsAgent: tlsCaCertificates ? new https.Agent({ ca: tlsCaCertificates }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:" && tlsCaCertificates) {
    return new https.Agent({ ca: tlsCaCertificates });
  }

  return undefined;
}

/**
 * public egress 下禁止使用代理。
 *
 * 原因：代理在代理侧解析目标域名，本地 DNS 校验无法证明最终连接的公网属性，
 * 也无法阻止代理把流量导回内网；因此只能 fail closed。
 */
function assertPublicEgressProxyBoundary(url: URL, proxyUrl: string | undefined): void {
  if (!proxyUrl) return;
  // 普通代理会在代理侧解析目标域名，本地 DNS 校验无法证明最终 IP 仍是公网地址。
  throw createHttpClientError({
    code: "egress_blocked",
    url: url.toString(),
    message:
      "HTTP public egress cannot use a proxy because proxy-side DNS resolution cannot be verified",
  });
}

/** 汇总本次请求的出口信息，供上层审计/日志（不包含代理凭据）。 */
function buildEgressInfo(
  proxy: ReturnType<typeof resolveProxyForRequest>,
  tlsCaCertificates: Buffer | undefined,
): HttpClientEgressInfo {
  return {
    customCa: tlsCaCertificates !== undefined,
    noProxyMatched: proxy.noProxyMatched || undefined,
    proxied: proxy.proxyUrl !== undefined,
    proxyHost: proxy.proxyUrl ? safeProxyHost(proxy.proxyUrl) : undefined,
    proxySource: proxy.proxySource,
  };
}

function safeProxyHost(proxyUrl: string): string | undefined {
  try {
    const url = new URL(proxyUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return undefined;
  }
}

function buildHeaders(request: HttpClientRequest): Headers {
  const headers = new Headers(request.headers);
  if (request.trace?.traceId && !headers.has(TRACE_HEADER)) {
    headers.set(TRACE_HEADER, request.trace.traceId);
  }
  return headers;
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * 把调用方 signal 桥接到内部 controller，并返回解绑函数。
 *
 * 若父 signal 已中止，立即用其 reason 中止；否则注册一次性监听。timedOut 由
 * 超时定时器单独置位，保证 finally 解绑不会影响错误分类。
 */
function linkAbortSignals(
  parent: AbortSignal | undefined,
  controller: AbortController,
): { timedOut: boolean; unlink: () => void } {
  const state: { timedOut: boolean; unlink: () => void } = {
    timedOut: false,
    unlink: () => undefined,
  };

  if (!parent) return state;

  if (parent.aborted) {
    controller.abort(parent.reason);
    return state;
  }

  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  state.unlink = () => parent.removeEventListener("abort", onAbort);
  return state;
}

/**
 * 把任意异常归一成 HttpClientPortError。
 *
 * 已是 port error 的原样返回；优先级：timeout > cancelled > AbortError >
 * proxy_error/network_error。顺序很关键：超时也会让 signal.aborted=true，
 * 必须先判 timedOut，否则会被误分类为取消。
 */
function toHttpClientError(
  error: unknown,
  context: { cancelled: boolean; proxied: boolean; timedOut: boolean; url: string },
): Error {
  if (isHttpClientPortError(error)) {
    return error;
  }

  if (context.timedOut) {
    return createHttpClientError({
      code: "timeout",
      url: context.url,
      message: error instanceof Error ? error.message : "HTTP request timed out",
      cause: error,
    });
  }

  if (context.cancelled) {
    return createHttpClientError({
      code: "cancelled",
      url: context.url,
      message: error instanceof Error ? error.message : "HTTP request was cancelled",
      cause: error,
    });
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return createHttpClientError({
      code: "cancelled",
      url: context.url,
      message: "HTTP request was cancelled",
      cause: error,
    });
  }

  return createHttpClientError({
    code: context.proxied ? "proxy_error" : "network_error",
    url: context.url,
    message: error instanceof Error ? error.message : "HTTP request failed",
    cause: error,
  });
}
