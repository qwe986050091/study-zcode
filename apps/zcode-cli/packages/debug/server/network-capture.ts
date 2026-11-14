// INV-01 记录数不得超过上限，且淘汰顺序与事件顺序一致：守住位置 写入函数；改错故障 内存无界增长或事件指向已淘汰记录。
// INV-02 所有新增与更新都走同一写入函数：守住位置 四个代理回调；改错故障 淘汰逻辑被绕过，顺序表与映射不一致。
// INV-03 记录只保留脱敏头与体积统计，不保存正文：守住位置 请求捕获；改错故障 用户正文落进调试存储。
// INV-04 敏感头名单复用共享常量并补充本地名单：守住位置 头部集合构造；改错故障 各端脱敏范围不一致。
// INV-05 启动幂等：已启用、运行中或已有句柄时直接返回：守住位置 启动首行；改错故障 重复启动占用两个端口。
// INV-06 监听失败必须清空句柄并拒绝：守住位置 监听回调的错误分支；改错故障 失败后实例仍显示可用。
// INV-07 停止会先丢弃句柄再关闭：守住位置 停止方法前三行；改错故障 关闭期间仍接受新请求。
// INV-08 对外端口取实际绑定端口，缺失才回落请求端口：守住位置 状态快照；改错故障 端口冲突时展示错误地址。
// INV-09 未启用时状态里不暴露主机、端口与证书路径：守住位置 状态各字段条件；改错故障 关闭态泄漏本地路径。
// INV-10 证书可用性只按文件存在判断，不解析内容：守住位置 证书可用标记；改错故障 损坏证书被误报为可用。
// INV-11 列表按新到旧返回，且返回深拷贝：守住位置 列表方法；改错故障 调用方修改影响内部状态。
// INV-12 跟踪归因优先级固定：专用头、通用头、W3C 头、查询参数：守住位置 归因提取；改错故障 归因结果随请求头顺序漂移。
// INV-13 W3C 跟踪头只取跟踪标识段，格式不符按原值保留：守住位置 归一函数；改错故障 归因键格式不一致。
// INV-14 无跟踪头时返回空对象而不是占位值：守住位置 归因返回；改错故障 记录出现虚假跟踪标识。
// INV-15 绝对地址直接使用，相对地址用协议与主机头拼装：守住位置 请求地址还原；改错故障 相对请求解析失败中断抓包。
// INV-16 主机头缺失时用占位主机，保证解析不抛错：守住位置 主机兜底；改错故障 异常请求让回调抛错。
// INV-17 请求与响应体积按分片累加，完成时计算耗时：守住位置 三个回调；改错故障 耗时恒为 0 或为负。
// INV-18 抓包标识挂到上下文标签，后续回调据此定位：守住位置 请求捕获尾部赋值；改错故障 响应事件写到别的记录。
//
// 模块职责：基于本地代理提供可选的 HTTP 与 HTTPS 抓包服务，维护有上限的记录并推送调试事件。
// 状态所有权：记录、顺序表与监听集合归本实例；监听端口与证书文件由代理库代为持有。
// 阅读顺序：先看常量与状态字段，再读启动、状态与列表，最后看请求捕获与写入淘汰。
/**
 * 本地网络抓包服务：基于 http-mitm-proxy 提供可选的 HTTP(S) 代理。
 *
 * 职责：启停代理、维护有上限的请求记录、向调试台推送事件，并把请求归因到 traceId。
 * 输入口径：host/port/caDir/maxEntries 可构造注入，也可由 `ZCODE_DEBUG_NETWORK_*` 环境变量提供。
 * 输出口径：只记录方法、URL、脱敏后的请求/响应头与体积统计，不保存正文内容。
 * 副作用：监听本地端口、在 CA 目录生成/复用证书；禁用或启动失败不阻塞调试主服务。
 * 失败语义：启动失败写入 `lastError` 并通过 status 事件暴露，由调用方决定如何提示。
 * 不变量：记录数不超过 `maxEntries`，所有写入统一走 `upsertRecord` 以保证淘汰顺序与事件一致。
 */
import { requestSecuritySensitiveHeaders } from "@zcode/shared";
import { existsSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Proxy } from "http-mitm-proxy";
import type { IContext } from "http-mitm-proxy";
import type {
  NetworkCaptureEvent,
  NetworkCaptureStatus,
  NetworkRequestAttribution,
  NetworkRequestRecord,
} from "../src/shared.js";

interface NetworkCaptureServiceOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  caDir?: string;
  maxEntries?: number;
}

interface NetworkRequestListOptions {
  traceId?: string;
  limit?: number;
}

type NetworkCaptureListener = (event: NetworkCaptureEvent) => void;

// 默认只监听回环地址，避免把代理暴露到局域网。
// DEFAULT_PORT 与 DEFAULT_MAX_ENTRIES 取保守值，够调试又不拖慢主服务。
// 脱敏占位值固定，便于前端按值识别。
// 跟踪头名单顺序即归因优先级，改动等同改变归因口径。
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4184;
const DEFAULT_MAX_ENTRIES = 300;
const HEADER_REDACTION_VALUE = "[redacted]";
const traceHeaderNames = ["x-zcode-trace-id", "x-trace-id", "traceparent"];
const redactedHeaderNames = new Set([
  ...requestSecuritySensitiveHeaders,
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
]);

/**
 * NetworkCaptureService 持有一个代理、一份记录表与一组监听器，启停不重建实例。
 * 生命周期：`start` 幂等（已启用/运行中/代理已存在时直接返回），`stop` 后可在同一实例上重新启动。
 * 状态口径：`running` 仅在代理 listen 成功时为 true；对外端口以实际绑定端口为准。
 */
// 实例状态分两层：配置在构造期固化，运行态随启停变化。
// 记录映射与顺序表必须同步维护，顺序表只存标识。
// 监听集合用集合而非数组，退订是常数时间。
// 句柄、运行标记、实际端口与最后错误构成全部运行态。
export class NetworkCaptureService {
  readonly enabled: boolean;

  private readonly host: string;
  private readonly requestedPort: number;
  private readonly caDir: string;
  private readonly maxEntries: number;
  private readonly records = new Map<string, NetworkRequestRecord>();
  private readonly order: string[] = [];
  private readonly listeners = new Set<NetworkCaptureListener>();
  private proxy: Proxy | undefined;
  private running = false;
  private actualPort: number | undefined;
  private lastError: string | undefined;

  /** 归一化构造参数：启用缺省 true，端口/上限/CA 目录均有默认值，不在此校验目录是否存在。 */
  constructor(options: NetworkCaptureServiceOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.caDir = resolve(options.caDir ?? defaultCertificateContainerDir());
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * start 创建并监听 http-mitm-proxy 实例，成功后置 running 并广播 status。
   * 输入：构造时注入的 host/port/caDir；CA 证书由代理库按目录按需生成。
   * 输出：无返回值；成功后置 running 并广播 status，失败时清空代理句柄并 reject。
   * 副作用：监听本地端口、写证书文件、注册请求/错误回调。
   * 失败语义：监听失败只记录 lastError 后向上拒绝，是否降级由 startDebugServer 决定。
   */
  // 幂等起点：关闭态、未运行、无句柄三者任一不满足即返回。
  // 先挂 proxy.onError，监听阶段的异常也能落进 lastError。
  // 请求回调只做同步捕获，转发仍由 proxy 继续。
  // 监听成功才置 running 与 actualPort，失败必须清空 proxy。
  // 成功与失败都通过 emit status 外抛，调用方无需轮询。
  async start(): Promise<void> {
    if (!this.enabled || this.running || this.proxy) return;

    const proxy = new Proxy();
    this.proxy = proxy;
    proxy.onError((ctx, error, errorKind) => {
      const message = [errorKind, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join(": ");
      this.lastError = message || "network proxy error";
      this.markContextError(ctx, this.lastError);
      this.emit({ type: "status", status: this.getStatus() });
    });

    proxy.onRequest((ctx, callback) => {
      this.captureRequest(ctx);
      callback();
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      proxy.listen(
        {
          host: this.host,
          port: this.requestedPort,
          sslCaDir: this.caDir,
          keepAlive: true,
        },
        (error?: Error | null) => {
          if (error) {
            this.lastError = error.message;
            this.proxy = undefined;
            rejectStart(error);
            return;
          }
          this.running = true;
          this.actualPort = proxy.httpPort;
          this.emit({ type: "status", status: this.getStatus() });
          resolveStart();
        },
      );
    });
  }

  /**
   * 停止代理并广播 running=false 状态。
   * 副作用：释放监听端口；重复调用安全（代理句柄已置空时只广播状态）。
   * 注意：底层 close 不保证回调时序，这里只保证句柄被丢弃，不再接受新请求。
   */
  async stop(): Promise<void> {
    const proxy = this.proxy;
    this.proxy = undefined;
    this.running = false;
    if (proxy) {
      await new Promise<void>((resolveStop) => {
        proxy.close();
        resolveStop();
      });
    }
    this.emit({ type: "status", status: this.getStatus() });
  }

  /**
   * 生成对外状态快照，供 HTTP 与 SSE 直接序列化。
   * 口径：端口优先实际绑定端口；`env` 只在启用时给出代理地址与 CA 路径；
   * `caCertAvailable` 仅按文件存在性判断，不校验证书内容。
   */
  // port 优先取 actualPort，未启动时用 requestedPort。
  // url 只在 enabled 为真时给出，关闭态为 undefined。
  // 四个证书路径都按 caDir 推导，可用性只看 ca.pem。
  // env 对象为空时省略该字段，避免前端渲染空块。
  getStatus(): NetworkCaptureStatus {
    const port = this.actualPort ?? this.requestedPort;
    const url = this.enabled ? buildProxyUrl(this.host, port) : undefined;
    const caCertPath = join(this.caDir, "certs", "ca.pem");
    const env: Record<string, string> = url
      ? {
          ZCODE_HTTP_PROXY: url,
          ZCODE_AGENT_CA_CERT: caCertPath,
        }
      : {};

    return {
      enabled: this.enabled,
      running: this.running,
      host: this.enabled ? this.host : undefined,
      port: this.enabled ? port : undefined,
      proxyUrl: url,
      library: "http-mitm-proxy",
      maxEntries: this.maxEntries,
      certificate: {
        caDir: this.enabled ? this.caDir : undefined,
        caCertPath: this.enabled ? caCertPath : undefined,
        caPrivateKeyPath: this.enabled ? join(this.caDir, "keys", "ca.private.key") : undefined,
        caPublicKeyPath: this.enabled ? join(this.caDir, "keys", "ca.public.key") : undefined,
        caCertAvailable: existsSync(caCertPath),
      },
      env,
      lastError: this.lastError,
    };
  }

  /**
   * 按新→旧返回记录副本。
   * 输入：`traceId` 可选过滤；`limit` 缺省为 maxEntries，超出即截断。
   * 输出：深拷贝头部后的数组，调用方修改不会影响内部状态。
   */
  listRequests(options: NetworkRequestListOptions = {}): NetworkRequestRecord[] {
    const limit = options.limit ?? this.maxEntries;
    const records: NetworkRequestRecord[] = [];
    for (const id of this.order.toReversed()) {
      const record = this.records.get(id);
      if (!record) continue;
      if (options.traceId && record.traceId !== options.traceId) continue;
      records.push(cloneRecord(record));
      if (records.length >= limit) break;
    }
    return records;
  }

  /** 注册事件监听，返回取消函数；取消后不再收到 status/request/reset 事件。 */
  subscribe(listener: NetworkCaptureListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 清空记录与顺序列表，并广播 reset；两处同时清空避免残留 id 指向已删除记录。 */
  clear(): void {
    this.records.clear();
    this.order.length = 0;
    this.emit({ type: "reset" });
  }

  // 记录标识取代理上下文标识，保证同一请求全链路一致。
  // 头部在 captureRequest 入口完成脱敏，后续回调不重复处理。
  // record.size 从 0 开始累加，状态先置为进行中。
  // 把 id 挂到 ctx.tags.zcodeCaptureId，数据与结束回调据此回写。
  private captureRequest(ctx: IContext): void {
    const id = ctx.uuid;
    const requestUrl = buildRequestUrl(ctx);
    const attribution = extractAttribution(ctx.clientToProxyRequest.headers, requestUrl);
    const record: NetworkRequestRecord = {
      id,
      startedAt: new Date().toISOString(),
      protocol: ctx.isSSL ? "https" : "http",
      method: ctx.clientToProxyRequest.method ?? "GET",
      host: requestUrl.host,
      path: requestUrl.pathname + requestUrl.search,
      url: requestUrl.toString(),
      status: "pending",
      requestHeaders: sanitizeHeaders(ctx.clientToProxyRequest.headers),
      responseHeaders: {},
      requestHeaderCount: Object.keys(ctx.clientToProxyRequest.headers).length,
      responseHeaderCount: 0,
      requestBodyBytes: 0,
      responseBodyBytes: 0,
      ...attribution,
    };
    this.upsertRecord(record);
    if (ctx.tags) {
      // 把内部记录 id 挂到 ctx.tags，后续 data/response 回调据此定位同一条记录。
      ctx.tags.zcodeCaptureId = id;
    }

    ctx.onRequestData((requestCtx, chunk, callback) => {
      this.addRequestBytes(requestCtx, chunk.length);
      callback(null, chunk);
    });

    ctx.onResponse((responseCtx, callback) => {
      this.applyResponseHeaders(responseCtx);
      callback();
    });

    ctx.onResponseData((responseCtx, chunk, callback) => {
      this.addResponseBytes(responseCtx, chunk.length);
      callback(null, chunk);
    });

    ctx.onResponseEnd((responseCtx, callback) => {
      this.completeRecord(responseCtx);
      callback();
    });
  }

  private addRequestBytes(ctx: IContext, size: number): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    record.requestBodyBytes += size;
  }

  private addResponseBytes(ctx: IContext, size: number): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    record.responseBodyBytes += size;
  }

  private applyResponseHeaders(ctx: IContext): void {
    const record = this.recordForContext(ctx);
    if (!record || !ctx.serverToProxyResponse) return;
    record.statusCode = ctx.serverToProxyResponse.statusCode;
    record.responseHeaders = sanitizeHeaders(ctx.serverToProxyResponse.headers);
    record.responseHeaderCount = Object.keys(ctx.serverToProxyResponse.headers).length;
  }

  private completeRecord(ctx: IContext): void {
    const record = this.recordForContext(ctx);
    if (!record) return;
    this.applyResponseHeaders(ctx);
    record.status = "complete";
    record.completedAt = new Date().toISOString();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    this.upsertRecord(record);
  }

  private markContextError(ctx: IContext | null, message: string): void {
    const record = ctx ? this.recordForContext(ctx) : undefined;
    if (!record) return;
    record.status = "error";
    record.error = message;
    record.completedAt = new Date().toISOString();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    this.upsertRecord(record);
  }

  private recordForContext(ctx: IContext): NetworkRequestRecord | undefined {
    const id = stringValue(ctx.tags?.zcodeCaptureId) ?? ctx.uuid;
    return this.records.get(id);
  }

  // records.has 为假时把 id 追加到 order 尾部。
  // 已有记录用 records.set 原地替换，order 不变。
  // order 超过 maxEntries 时 shift 最旧 id 并同步 records.delete。
  // 每次 upsertRecord 都 emit 一次 request，事件携带 cloneRecord 深拷贝。
  private upsertRecord(record: NetworkRequestRecord): void {
    if (!this.records.has(record.id)) {
      this.order.push(record.id);
    }
    this.records.set(record.id, record);
    // 环形淘汰：超过上限按插入顺序移除最旧记录，保证内存占用有界。
    while (this.order.length > this.maxEntries) {
      const oldestId = this.order.shift();
      if (oldestId) this.records.delete(oldestId);
    }
    this.emit({ type: "request", request: cloneRecord(record) });
  }

  private emit(event: NetworkCaptureEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** 未启用抓包时的占位状态：全部为关闭态，前端可统一渲染而无需判空。 */
export function disabledNetworkCaptureStatus(): NetworkCaptureStatus {
  return {
    enabled: false,
    running: false,
    library: "http-mitm-proxy",
    maxEntries: 0,
    certificate: {
      caCertAvailable: false,
    },
    env: {},
  };
}

/**
 * createNetworkCaptureServiceFromEnv 读取 ZCODE_DEBUG_NETWORK_CAPTURE 等变量构造实例。
 * 输入：`ZCODE_DEBUG_NETWORK_CAPTURE` 取 0/false/off/no 时视为禁用并返回 undefined；
 * 其余变量覆盖 host/port/CA 目录/记录上限，非法数字回落到默认值。
 * 输出：未禁用时返回尚未启动的新实例。
 * 副作用：只读 env，不监听端口也不写证书。
 */
export function createNetworkCaptureServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NetworkCaptureService | undefined {
  if (isDisabled(env.ZCODE_DEBUG_NETWORK_CAPTURE)) return undefined;
  return new NetworkCaptureService({
    host: env.ZCODE_DEBUG_NETWORK_HOST || undefined,
    port: parsePositiveInteger(env.ZCODE_DEBUG_NETWORK_PORT) ?? DEFAULT_PORT,
    caDir: env.ZCODE_DEBUG_NETWORK_CA_DIR || undefined,
    maxEntries: parsePositiveInteger(env.ZCODE_DEBUG_NETWORK_MAX_ENTRIES) ?? DEFAULT_MAX_ENTRIES,
  });
}

/** 推断 CA 目录：源码运行取包根；打包到 dist-server 时上退一级，保证两种布局都能命中 certs 目录。 */
function defaultCertificateContainerDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const parentDir = dirname(moduleDir);
  const debugRoot = basename(parentDir) === "dist-server" ? dirname(parentDir) : parentDir;
  return join(debugRoot, "certs", "network-ca");
}

/**
 * 提取请求的 trace 归因。
 * 优先级：x-zcode-trace-id → x-trace-id → traceparent → query 的 traceId/trace_id。
 * 输出：仅 traceId（W3C traceparent 会取其中 trace-id 段）；无归因时返回空对象。
 * 副作用：无；纯函数，便于单测覆盖各种头部组合。
 */
// 依次尝试专用头与通用头，命中即返回。
// 头部缺失时回落到查询参数，兼容手工调试。
// W3C 头会归一为跟踪标识段，其余格式原样保留。
export function extractAttribution(
  headers: IncomingHttpHeaders,
  url: URL,
): NetworkRequestAttribution {
  const traceId =
    firstHeader(headers, traceHeaderNames) ?? queryValue(url, ["traceId", "trace_id"]);
  return {
    traceId: normalizeTraceparent(traceId),
  };
}

/**
 * sanitizeHeaders 把命中敏感名单的头值替换为 [redacted]，键名统一转小写。
 * 输入：原始头部（值可能是数组）；键名统一小写后再匹配敏感名单。
 * 输出：命中敏感名单的值替换为 `[redacted]`，其余按逗号拼接为字符串。
 * 不变量：名单复用共享的 `requestSecuritySensitiveHeaders`，避免各端维护多份。
 */
export function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = redactedHeaderNames.has(normalizedName)
      ? HEADER_REDACTION_VALUE
      : headerToString(value);
  }
  return sanitized;
}

/**
 * 还原请求绝对 URL。
 * 行为：代理可能给出绝对 URL，也可能只给路径，此时用协议 + Host 头拼装；缺少 Host 用 unknown.local 占位，
 * 保证 URL 解析不抛错（仅影响展示，不影响抓包链路）。
 */
function buildRequestUrl(ctx: IContext): URL {
  const request = ctx.clientToProxyRequest;
  const rawUrl = request.url ?? "/";
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }

  const protocol = ctx.isSSL ? "https" : "http";
  const host = stringValue(request.headers.host) ?? "unknown.local";
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(`${protocol}://${host}${path}`);
}

function firstHeader(headers: IncomingHttpHeaders, names: string[]): string | undefined {
  for (const name of names) {
    const value = stringValue(headers[name]);
    if (value) return value;
  }
  return undefined;
}

function queryValue(url: URL, names: string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return undefined;
}

/** 识别 W3C traceparent（version-traceid-spanid-flags）并取 trace-id；不符合格式时按原值返回，兼容自定义格式。 */
function normalizeTraceparent(value?: string): string | undefined {
  if (!value) return undefined;
  const parts = value.split("-");
  if (
    parts.length === 4 &&
    /^[\da-f]{2}$/i.test(parts[0] ?? "") &&
    /^[\da-f]{32}$/i.test(parts[1] ?? "") &&
    /^[\da-f]{16}$/i.test(parts[2] ?? "") &&
    /^[\da-f]{2}$/i.test(parts[3] ?? "")
  ) {
    return parts[1];
  }
  return value;
}

function headerToString(value: IncomingHttpHeaders[string]): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === undefined ? "" : String(value);
}

function stringValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringValue(value[0]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function durationMs(start: string, end: string): number {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isDisabled(value?: string): boolean {
  if (!value) return false;
  return ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function buildProxyUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function cloneRecord(record: NetworkRequestRecord): NetworkRequestRecord {
  return {
    ...record,
    requestHeaders: { ...record.requestHeaders },
    responseHeaders: { ...record.responseHeaders },
  };
}
