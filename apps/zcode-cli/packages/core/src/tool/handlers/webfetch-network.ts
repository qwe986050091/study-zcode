// WebFetch 的网络层：唯一真正出网的实现，也是「重定向策略 + 审计事件 + 错误归一化」的落点。
//
// 调用链位置：webfetch.ts（工具 handler）→ 本文件 → context.httpClientPort（统一网络 adapter）。
// 这里绝不直接调用 fetch/http：超时、代理、证书、DNS 后的 public egress 检查都由 adapter 承担，
// 本层只声明意图（GET、manual redirect、响应字节上限、trace、abort signal）。
//
// 维护的不变量：
// 1. 每次真实 GET（含重定向的每一跳）前都重新做字面量 egress 检查，且请求一律 redirect:manual
//    ——跳转能不能跟由 isPermittedRedirect 决定，adapter 不得替我们自动跟。
// 2. 每一次请求尝试都成对发 pending/complete 或 pending/error 事件，失败也要发，否则审计
//    会留下「只有开始没有结束」的悬挂请求。
// 3. 网络层只把「响应类别」收口成三种结果（成功正文 / 重定向终态 / HTTP 错误终态）；
//    正文抽取失败、响应过大、egress 阻断都抛结构化错误，不伪装成 HTTP 错误。
import {
  CoreErrorType,
  createCoreError,
  isHttpClientPortError,
  type HttpClientResponse,
  type WebFetchRedirect,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import {
  DEFAULT_WEBFETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_WEBFETCH_RESPONSE_BYTES,
  WEBFETCH_TOOL_NAME,
  WEBFETCH_USER_AGENT,
} from "./webfetch-constants.js";
import { extractReadableContent, maybePersistRawContent } from "./webfetch-content.js";
import { assertWebFetchLiteralEgress } from "./webfetch-egress-guard.js";
import { webFetchError } from "./webfetch-errors.js";
import { emitNetworkRequestStatus, traceFromContext } from "./webfetch-trace.js";
import type {
  FetchAndExtractContentResult,
  HttpErrorFetchContent,
  RedirectFetchContent,
} from "./webfetch-types.js";
import { isPermittedRedirect, redactUrlCredentials, resolveRedirectUrl } from "./webfetch-url.js";

/**
 * 抓取一个 URL 的正文，并在网络边界内把结果收口成可展示的形态。
 *
 * 输入：context（提供 httpClientPort、abortSignal、artifactStore、trace 字段）、originalUrl
 * （用户原始入参，仅用于输出 url 字段与错误上下文）、url（已由 normalizeWebFetchUrl 规范化）。
 * 输出：CachedFetchContent（2xx 且正文可抽取）或 RedirectFetchContent / HttpErrorFetchContent
 * 两个终态。副作用：真实网络 GET（每跳一次）、成对的 NetworkRequestStatus 事件、正文过大时
 * 写 artifact。不写 WebFetch 缓存——缓存由 handler 决定（终态结果不该被缓存）。
 *
 * 失败语义：
 * - 未注入 httpClientPort → ConfigurationError（recoverable=false）：这是装配错误，重试无意义。
 * - 重定向超过 MAX_REDIRECTS → TooManyRedirects；adapter 报 too_large → ResponseTooLarge；
 *   命中出站策略 → EgressBlocked；其余网络异常 → FetchFailed（保留最底层 cause 供人诊断）。
 * - 正文不是文本类 MIME → extractReadableContent 抛 FetchFailed，不把二进制塞给模型。
 * - 取消通过 context.abortSignal 传到底层，表现为 FetchFailed，由 executor 统一收口。
 */
export async function fetchAndExtractContent(options: {
  context: ToolExecutionContext;
  originalUrl: string;
  url: URL;
}): Promise<FetchAndExtractContentResult> {
  const httpClientPort = options.context.httpClientPort;
  if (!httpClientPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "HttpClientPort is not configured for WebFetch tool",
      {
        context: {
          toolCallId: options.context.toolCallId,
          toolName: WEBFETCH_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const redirects: WebFetchRedirect[] = [];
  let currentUrl = options.url;
  let response: HttpClientResponse | undefined;

  // 循环上界用 `<=`：redirectCount=MAX_REDIRECTS 时仍会发出最后一跳，因此实际最多
  // MAX_REDIRECTS+1 次 GET；越过上界后重新判定，仍为重定向就报 TooManyRedirects。
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    // ZCode WebFetch 从 agent runtime 所在机器出网；移除 DNS preflight 后，
    // 每个真实 GET 前仍要阻断 URL 字面量本地/私网目标，避免 NO_PROXY 绕过安全边界。
    await assertWebFetchLiteralEgress(currentUrl);

    const requestId = `net_${crypto.randomUUID()}`;
    const requestStartedAt = new Date();
    await emitNetworkRequestStatus(options.context, {
      method: "GET",
      requestId,
      source: "http_client",
      startedAt: requestStartedAt.toISOString(),
      status: "pending",
      toolCallId: options.context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
      url: currentUrl.toString(),
    });

    try {
      response = await httpClientPort.request(
        {
          url: currentUrl.toString(),
          method: "GET",
          headers: webFetchHeaders(),
          timeoutMs: DEFAULT_WEBFETCH_TIMEOUT_MS,
          maxResponseBytes: MAX_WEBFETCH_RESPONSE_BYTES,
          redirect: "manual",
          trace: traceFromContext(options.context),
        },
        { signal: options.context.abortSignal },
      );
      await emitNetworkRequestStatus(options.context, {
        completedAt: new Date().toISOString(),
        durationMs: response.durationMs,
        egress: response.egress,
        method: "GET",
        requestId,
        source: "http_client",
        startedAt: requestStartedAt.toISOString(),
        status: "complete",
        statusCode: response.status,
        toolCallId: options.context.toolCallId,
        toolName: WEBFETCH_TOOL_NAME,
        url: response.url,
      });
    } catch (error) {
      // Node/undici 的顶层网络错误常只有 "fetch failed"，需要把最底层 cause
      // 和 code 暴露给用户，否则连接重置、DNS、代理等不同问题在工具结果里完全不可区分。
      const errorMessage = formatWebFetchRequestError(error, currentUrl);
      await emitNetworkRequestStatus(options.context, {
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - requestStartedAt.getTime()),
        error: errorMessage,
        method: "GET",
        requestId,
        source: "http_client",
        startedAt: requestStartedAt.toISOString(),
        status: "error",
        statusCode: isHttpClientPortError(error) ? error.status : undefined,
        toolCallId: options.context.toolCallId,
        toolName: WEBFETCH_TOOL_NAME,
        url: currentUrl.toString(),
      });
      // 错误码翻译必须在重新抛之前做：adapter 的结构化 code 比 message 更可靠，
      // 一旦被通用 FetchFailed 包掉，上层就无法区分「太大」和「被策略阻断」。
      if (isHttpClientPortError(error) && error.code === "too_large") {
        throw webFetchError("ResponseTooLarge", error.message, { url: error.url }, error);
      }
      if (isHttpClientPortError(error) && error.code === "egress_blocked") {
        const domain = currentUrl.hostname;
        throw webFetchError(
          "EgressBlocked",
          errorMessage,
          {
            domain,
            error_type: "EGRESS_BLOCKED",
            url: currentUrl.toString(),
          },
          error,
        );
      }
      throw webFetchError(
        "FetchFailed",
        errorMessage,
        { url: currentUrl.toString() },
        error,
      );
    }

    // 网络层按响应类别收口，避免重定向/HTTP 错误误进入正文抽取和模型处理。
    if (!isRedirectStatus(response.status)) break;
    const redirect = classifyRedirect(response, currentUrl, redirects, options.originalUrl);
    if (isFetchTerminalResult(redirect)) return redirect;
    currentUrl = redirect;
  }

  // 循环至少执行一次且只有抛错才会不赋值，这里仅用于类型收窄；真到这一步说明实现了
  // 不可达分支（例如把循环改成可能零次执行），按 FetchFailed 处理而不是返回空正文。
  if (!response) {
    throw webFetchError("FetchFailed", "WebFetch did not receive a response", {
      url: options.originalUrl,
    });
  }

  // 走到这里仍是 3xx，意味着已用尽 MAX_REDIRECTS 仍未到终态；单独成码便于区分
  // 「循环导致的重定向环」与「HTTP 错误」。
  if (isRedirectStatus(response.status)) {
    throw webFetchError("TooManyRedirects", "WebFetch exceeded the safe redirect limit", {
      maxRedirects: MAX_REDIRECTS,
      url: currentUrl.toString(),
    });
  }

  // 代理拦截必须在 2xx 判定之前检查：代理常用 403 表达拦截，先翻成 EgressBlocked
  // 才能给模型「这是策略阻断，不是目标站点拒绝」的正确归因。
  throwIfProxyBlocked(response, currentUrl);

  if (!isSuccessfulStatus(response.status)) {
    return toHttpErrorFetchContent(response, currentUrl, redirects, options.originalUrl);
  }

  const contentType = readHeader(response.headers, "content-type") ?? "";
  const content = extractReadableContent(response.body, contentType);
  const artifact = await maybePersistRawContent(content, contentType, options.context);

  return {
    artifactPath: artifact?.path,
    artifactUri: artifact?.uri,
    bytes: response.bytes,
    content,
    contentType,
    finalUrl: currentUrl.toString(),
    redirects,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    status: response.status,
    statusText: response.statusText,
  };
}

/**
 * 解释一个 3xx 响应：返回「可继续跟随的新 URL」或「两种终态结果」。
 *
 * 缺 Location（或空串）不当作可跟随，直接落 HTTP 错误终态——没有目标就没法做同源/egress
 * 判定，更不能猜。目标 URL 始终经 redactUrlCredentials 展示，避免把凭据写进模型上下文。
 * 不允许跟随时用副本 `[...redirects, redirect]` 返回终态：既不丢这一跳，也不改写共享链；
 * 允许跟随时才 push 到共享数组，后续失败返回时链仍然完整。
 */
function classifyRedirect(
  response: HttpClientResponse,
  currentUrl: URL,
  redirects: WebFetchRedirect[],
  originalUrl: string,
): HttpErrorFetchContent | RedirectFetchContent | URL {
  const location = readHeader(response.headers, "location");
  if (typeof location !== "string" || location.trim() === "") {
    return toHttpErrorFetchContent(response, currentUrl, redirects, originalUrl);
  }

  const nextUrl = resolveRedirectUrl(location, currentUrl);
  const displayNextUrl = redactUrlCredentials(nextUrl);
  const redirect = {
    from: currentUrl.toString(),
    to: displayNextUrl,
    status: response.status,
  };
  if (!isPermittedRedirect(currentUrl, nextUrl)) {
    return {
      type: "redirect",
      originalUrl: currentUrl.toString(),
      redirectUrl: displayNextUrl,
      redirects: [...redirects, redirect],
      status: response.status,
      statusText: response.statusText,
    };
  }
  redirects.push(redirect);
  return nextUrl;
}

/**
 * 把非 2xx 响应收口成 HTTP 错误终态（不读 body，也不缓存）。
 *
 * Retry-After 只接受纯数字（1~6 位）的秒数形态：HTTP-date 形态无法直接给模型用，
 * 且任意日期串会把上游自由文本带进结果；超长数字也丢弃，避免异常头撑大上下文。
 */
function toHttpErrorFetchContent(
  response: HttpClientResponse,
  currentUrl: URL,
  redirects: WebFetchRedirect[],
  originalUrl: string,
): HttpErrorFetchContent {
  const retryAfter = readHeader(response.headers, "retry-after");
  return {
    type: "http_error",
    finalUrl: currentUrl.toString(),
    originalUrl,
    redirects,
    retryAfter:
      typeof retryAfter === "string" && /^[0-9]{1,6}$/u.test(retryAfter) ? retryAfter : undefined,
    status: response.status,
    statusText: response.statusText,
  };
}

/**
 * 识别 egress 代理的拒绝标记并抛 EgressBlocked。
 *
 * 只认 `x-proxy-error: blocked-by-allowlist` 这个约定值：代理对「目标不在白名单」的响应
 * 可能仍是 2xx/403，靠状态码无法区分；用显式头避免把普通站点错误误报成策略阻断。
 * 消息里只带域名，不带解析出的 IP，防止把内网地址当作探测结果泄露给模型。
 */
function throwIfProxyBlocked(response: HttpClientResponse, currentUrl: URL): void {
  if (readHeader(response.headers, "x-proxy-error") !== "blocked-by-allowlist") return;

  const domain = currentUrl.hostname;
  throw webFetchError(
    "EgressBlocked",
    JSON.stringify({
      error_type: "EGRESS_BLOCKED",
      domain,
      message: `Access to ${domain} is blocked by the network egress proxy.`,
    }),
    {
      domain,
      error_type: "EGRESS_BLOCKED",
      url: currentUrl.toString(),
    },
  );
}

/**
 * 改写底层 egress 阻断消息：把「resolved to <IP>」替换成不含地址的描述。
 * 原因见下方内联注释——错误文本会进入模型上下文，不能泄露内网/metadata 解析结果。
 */
function formatEgressBlockedMessage(message: string, domain: string): string {
  // 底层 public egress 会看到 DNS 解析结果，但 WebFetch 错误会进入模型上下文，
  // 不能把被阻断域名解析出的内网/metadata IP 当作探测结果暴露给模型。
  if (message.includes("resolved to")) {
    return `HTTP public egress blocked ${domain} because it resolved to a non-public address`;
  }
  return message;
}

/**
 * egress 阻断走脱敏改写，其余错误走通用 cause 链展开。
 * 两者的共同目标是：让人能区分连接重置/DNS/代理/超时，同时不把内部地址带出去。
 */
function formatWebFetchRequestError(error: unknown, currentUrl: URL): string {
  if (isHttpClientPortError(error) && error.code === "egress_blocked") {
    return formatEgressBlockedMessage(error.message, currentUrl.hostname);
  }
  return formatRequestError(error);
}

/** 类型守卫：URL 表示「还能继续跟随」，其余两个带 type 字段的对象是终态。 */
function isFetchTerminalResult(
  value: HttpErrorFetchContent | RedirectFetchContent | URL,
): value is HttpErrorFetchContent | RedirectFetchContent {
  return !(value instanceof URL);
}

/**
 * 出站请求头：固定 UA 与 Accept。
 */
// Accept 显式偏好 markdown——部分站点会按它返回更适合抽取的版本；`*/*` 兜底避免 406。
function webFetchHeaders(): Record<string, string> {
  return {
    "User-Agent": WEBFETCH_USER_AGENT,
    Accept: "text/markdown, text/html, */*",
  };
}

/**
 * 把网络异常压成一条可读消息：优先使用已知形态的紧凑描述，否则拼接 fallback 与
 * 最深 cause（附错误码），让模型/用户能区分「连不上」「超时」「TLS/代理」。
 * 不在这里抛错或吞错，调用方负责包装成 CoreError。
 */
function formatRequestError(error: unknown): string {
  const fallback = error instanceof Error ? error.message : "WebFetch request failed";
  const concreteCause = deepestCauseDetails(error);
  const compactCause = compactKnownNetworkCauseMessage(concreteCause);
  if (compactCause) return compactCause;
  const concreteCauseMessage = concreteCause?.message;
  const fallbackWithCode = appendErrorCode(fallback, concreteCause?.code);
  if (!concreteCauseMessage || concreteCauseMessage === fallback) return fallbackWithCode;
  return `${fallback}: ${appendErrorCode(concreteCauseMessage, concreteCause.code)}`;
}

/**
 * 识别 undici 的连接超时文案并只保留端口与超时值：
 * 原始消息带 attempted address，可能是解析后的内网 IP，不应进入模型上下文。
 */
function compactKnownNetworkCauseMessage(
  cause: { message?: string; code?: string } | undefined,
): string | undefined {
  if (!cause?.message) return undefined;
  const connectTimeoutMatch = cause.message.match(
    /^Connect Timeout Error \(attempted address: .+:(\d+), timeout: ([^)]+)\)$/u,
  );
  if (connectTimeoutMatch?.[1] && connectTimeoutMatch[2]) {
    return `Connect Timeout Error (${connectTimeoutMatch[1]}, timeout ${connectTimeoutMatch[2]})`;
  }
  return undefined;
}

/**
 * 沿 `cause` 链走到最深处，收集「最深非空 message」与「最深非空 code」。
 *
 * 用 seen 集合防 cause 环（错误链被复用/自引用时不会死循环）。每层都用更深的非空值覆盖，
 * 因此最终得到的是最靠近系统层（errno）的诊断；字符串形式的 cause 视为链路终点
 * （有些库直接 throw 字符串），保留它作为 message。
 */
function deepestCauseDetails(error: unknown): { message?: string; code?: string } | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message: string | undefined;
  let code: string | undefined;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string" && current.trim()) {
      message = current.trim();
      break;
    }
    if (!(current instanceof Error)) break;

    if (current.message.trim()) {
      message = current.message.trim();
    }
    code = readErrorCode(current) ?? code;
    current = current.cause;
  }

  if (!message && !code) return undefined;
  return { code, message };
}

function readErrorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

/** 仅当消息里还没出现该码时才追加，避免 adapter 已拼好的 `(ECONNRESET)` 被重复两次。 */
function appendErrorCode(message: string, code: string | undefined): string {
  if (!code || message.includes(code)) return message;
  return `${message} (${code})`;
}

/**
 * 大小写不敏感地读取响应头：先试已小写的 key，再线性扫描实际键名。
 * adapter 是否规范化头部大小写并无强制约定，只按小写查会在部分实现下漏读
 * content-type/location，进而把 HTML 当纯文本或漏掉重定向。
 */
function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return (
    headers[normalizedName] ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1]
  );
}

/** 只把可携带新 Location 的 3xx 视为重定向；304 是缓存校验，没有新目标，不跟随。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
