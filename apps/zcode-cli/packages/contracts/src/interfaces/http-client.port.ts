// ============================================================
// HTTP Client Port - network I/O boundary
// ============================================================
// 定位：CLI 内所有非 provider 网络请求的统一出口（WebFetch、登录轮询、更新检查、插件下载等）。
// 统一收口超时、响应体上限、重定向策略、代理、自定义 CA 与 egress 策略，并回报实际出口信息
// 供审计。provider 的模型请求走各自 SDK，不经过本端口。
// 本端口刻意不做重试：不同接口的幂等性与退避不同，重试属于调用方；adapter 只保证单次请求的
// 错误分类、取消与体积上限正确。

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

// 仅支持 GET/HEAD/POST：这是"取数据 / 提交最小载荷"的出口，PUT/PATCH/DELETE 不开放，
// 以免业务层借它实现任意写语义。
export type HttpClientMethod = "GET" | "HEAD" | "POST";
// manual 表示不跟随、3xx 原样返回；follow 由 adapter 跟随，且每一跳都要重新经过
// egress 校验，不能只在首跳校验。
export type HttpClientRedirectPolicy = "manual" | "follow";
// 目前只有 public：解析目标 IP 并拒绝私有/回环/保留地址，防 SSRF。
// 使用代理时本地 DNS 无法证明最终出口 IP，因此直接 egress_blocked（不是放行）。
export type HttpClientEgressPolicy = "public";

// 稳定错误码。egress_blocked 是策略拒绝，proxy_error 是代理链路失败，
// network_error 是其余传输错误，too_large 是响应体超上限；调用方按 code 分支，不解析 message。
export type HttpClientErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "timeout"
  | "cancelled"
  | "too_large"
  | "egress_blocked"
  | "network_error"
  | "proxy_error";

// 错误明细：url 是出错的目标（跟随重定向后为那一跳的地址），status 在收到响应头后才有，
// cause 保留底层错误供日志展开。
export interface HttpClientErrorDetails {
  code: HttpClientErrorCode;
  url?: string;
  status?: number;
  message: string;
  cause?: unknown;
}

// 端口错误类型。所有 adapter 抛出的网络失败都必须归一化成该类型，name 固定，
// 便于跨包/多副本打包时与 instanceof 互补判定。
export class HttpClientPortError extends Error {
  readonly code: HttpClientErrorCode;
  readonly url?: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(details: HttpClientErrorDetails) {
    super(details.message);
    this.name = "HttpClientPortError";
    this.code = details.code;
    this.url = details.url;
    this.status = details.status;
    this.cause = details.cause;
  }
}

// 工厂：adapter 内部一律经它抛错，保证 code 与 name 一致。
export function createHttpClientError(details: HttpClientErrorDetails): HttpClientPortError {
  return new HttpClientPortError(details);
}

// 类型守卫。非端口错误应继续冒泡，只在需要按码分支时使用。
export function isHttpClientPortError(error: unknown): error is HttpClientPortError {
  return error instanceof HttpClientPortError;
}

// 请求。url 必须是 http(s) 绝对地址；timeoutMs 缺省取 adapter 默认值；
// maxResponseBytes 是响应体硬上限（超过抛 too_large，不截断）；body 以字节传入、不做隐式编码；
// redirect 缺省 manual；egressPolicy 缺省同样按 public 处理。
export interface HttpClientRequest {
  url: string;
  method?: HttpClientMethod;
  headers?: Record<string, string>;
  body?: Uint8Array;
  timeoutMs?: number;
  maxResponseBytes?: number;
  redirect?: HttpClientRedirectPolicy;
  egressPolicy?: HttpClientEgressPolicy;
  trace?: TraceContext;
}

// 实际生效的出口信息：proxied 与 proxySource/proxyHost 说明走了哪个代理，
// noProxyMatched 表示命中 NO_PROXY，customCa 表示使用了自签名 CA。
// 仅用于展示与审计，不参与后续请求决策；可缺省表示 adapter 未实现采集。
export interface HttpClientEgressInfo {
  proxied: boolean;
  proxySource?: string;
  proxyHost?: string;
  noProxyMatched?: boolean;
  customCa?: boolean;
}

// 响应。headers 已按小写归一；body 是完整字节（受 maxResponseBytes 约束）；bytes 等于 body 长度；
// durationMs 是墙钟耗时；egress 反映本次实际策略而不是配置声明。
export interface HttpClientResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  bytes: number;
  durationMs: number;
  egress?: HttpClientEgressInfo;
}

// 取消与上下文。signal 取消产生 cancelled 错误码；context 提供 trace 之外的执行上下文。
export interface HttpClientRunOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

// 单一入口 request：所有 HTTP 访问都必须经过它，便于集中管理超时、代理、证书、审计与错误归一。
// 实现不得跳过 egress 校验，也不得在内部静默重试（重试会改变调用方对幂等的假设）。
export interface HttpClientPort {
  request(
    request: HttpClientRequest,
    options?: HttpClientRunOptions,
  ): Promise<HttpClientResponse>;
}
