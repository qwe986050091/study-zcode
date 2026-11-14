// 文件职责：Highspeed draw/healthy 的 HTTP 传输层；对外两个语义方法，对内收敛到 performRequest 与 readHighspeedResponse。
// INV-01：每次请求恰好创建一个 AbortController + setTimeout，且 finally 无条件 clearTimeout。守住位置：performRequest。
//         漏清理会让计时器继续持有回调与 socket，进程无法及时退出。
// INV-02：请求必须以 resolve 或 reject 结束，绝不允许永久 pending。守住位置：deadline → controller.abort。
//         破坏后 HighspeedCardService.inFlightDraw 永不释放，之后每次发送都等 1s 降级，不再发起新 draw。
// INV-03：日志只允许出现 origin+pathname、白名单诊断头与截断后的错误文本。守住位置：sanitizeLogUrl 等。
//         query、Authorization 与 body 一律不得落盘。
// INV-04：业务码非 0 必须抛错，不能把 data 当成功返回。守住位置：readHighspeedResponse 末尾。
//         破坏后调用方会缓存被后端拒绝的卡，share/healthy 也会被误判为成功。
import {
  highspeedDrawResponseSchema,
  highspeedHealthyResponseSchema,
  type HighspeedDrawRequest,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { withRequestIdHeader } from "#src/providers/api/requestIdHeaders.js";
import type { HighspeedServiceTransport } from "./highspeedCardService.js";

// 只允许把这三个链路标识头写进日志：它们是排障必需且不含凭据；其余响应头（set-cookie、authorization 回显）
// 一律不落盘，避免把会话凭据复制到日志系统。
const DIAGNOSTIC_HEADER_NAMES = ["x-request-id", "x-trace-id", "x-span-id"] as const;
// 单条日志文本上限。后端 5xx 可能返回整页 HTML 或超长堆栈，不截断会让一次失败把日志量放大几个数量级；
// 截断后再脱敏，保证即使 token 被切在边界上也不会以完整形态出现。
const MAX_LOG_TEXT_CHARS = 1_000;
/**
 * 后台请求生命期上限。必须明确大于 1s 发送等待预算：慢但合法的 draw 仍能在后台落地供下一轮使用；
 * 同时保证永不返回的连接有界结束并释放 in-flight draw（spec §3 规则 6）。
 */
// 该常量被导出是为了让上层与测试能断言超时边界，而不是各自硬编码 20s；
// 调小会截断慢但合法的 draw，调大会延长 in-flight 占用的时间窗口，两者都会改变降级节奏。
export const HIGHSPEED_REQUEST_TIMEOUT_MS = 20_000;

// 独立错误类型而不是普通 Error：上层可据此区分「后端明确拒绝」与「网络/协议失败」，前者不该重试；
// operation 与 businessCode 保留现场，避免上层只能靠 message 字符串匹配来判断失败类别。
class HighspeedBusinessResponseError extends Error {
  constructor(
    readonly operation: "draw" | "healthy",
    readonly businessCode: number,
  ) {
    super(`highspeed ${operation} failed: business code ${businessCode}`);
    this.name = "HighspeedBusinessResponseError";
  }
}

// 工厂而非模块级单例：fetch/logger/timeout 全部注入，测试可用假 fetch 精确控制超时与响应体形态；
// 生产路径复用全局 fetch，保持与其它 provider 相同的连接池与代理设置。
export function createHighspeedHttpTransport(options: {
  drawUrl: string;
  healthyBaseUrl: string;
  drawHeaders: () => Promise<Record<string, string>>;
  healthyHeaders: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  logger: Pick<ServiceLogger, "warn">;
  /** 单次 draw/healthy 请求的生命期上限；缺省 HIGHSPEED_REQUEST_TIMEOUT_MS。 */
  requestTimeoutMs?: number;
}): HighspeedServiceTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger;
  const requestTimeoutMs = options.requestTimeoutMs ?? HIGHSPEED_REQUEST_TIMEOUT_MS;

// 所有请求的唯一出入口。parse 由调用方注入，是为了让传输与响应结构解耦：
// 同一套超时/日志/错误归一实现同时服务 draw(POST) 与 healthy(GET)，新增接口只需提供 url、method 与 schema。
// [权衡] 多一层泛型包装换来的是一致性：不会有人在新接口上忘记 deadline 或漏记 request id。
  async function performRequest<T>(params: {
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    url: string;
    body?: HighspeedDrawRequest;
    resolveHeaders: () => Promise<Record<string, string>>;
    parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
  }): Promise<T> {
// startedAt 只服务日志的 durationMs（含头准备与 body 读取），与 deadline 的计时无关；
// 两者分开才能区分「请求慢」与「请求到点被中止」。
    const startedAt = Date.now();
    const safeUrl = sanitizeLogUrl(params.url);
// 头准备可能被 await 打断（drawHeaders 需要先取 token），因此单独 try：
// [失败路径] 取凭据失败属于本地前置失败，记录脱敏日志后原样抛出、不进入 fetch，
// 避免把「鉴权准备失败」误报成「网络失败」。
    let headers: Headers;
    try {
      headers = withRequestIdHeader({
        ...(params.body ? { "content-type": "application/json" } : {}),
        ...(await params.resolveHeaders()),
      });
    } catch (error) {
      logger.warn(undefined, "Highspeed 接口请求准备失败", {
        operation: params.operation,
        method: params.method,
        url: safeUrl,
        durationMs: Date.now() - startedAt,
        error: readErrorMessage(error, params.url, safeUrl),
      });
      throw error;
    }

// request id 由 withRequestIdHeader 兜底生成，这里只读取不重写：
// 保证「发出去的头」与「日志里的 id」是同一个值，可用它把 RPC 日志与上游 trace 对上。
    const requestId = headers.get("x-request-id") ?? undefined;
    // Bug 根因：fetch 过去没有任何 deadline。代理/服务端接受连接后永不返回时 Promise 永久 pending，
    // 而 HighspeedCardService.inFlightDraw 只在该 Promise settle 的 finally 里释放——后续所有发送都
    // 复用这个死 Promise、各等 1s 再降级，整个应用生命周期内不再发起新 draw、next_draw_at 也无法更新。
    // 这里给请求一个有界生命期，超时后 abort → reject 让 finally 得以执行；deadline 同时覆盖响应体
    // 读取，服务端在 headers 之后停滞同样会被终止（与 bots/providers/providerRequest.ts 同一做法）。
// [资源] controller 的生命周期被 finally 严格包住：无论 fetch、body 读取还是结构校验抛错都会走到 clearTimeout；
// abort 对响应体读取同样生效，服务端在 headers 之后停滞也会被终止。
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new Error(`highspeed ${params.operation} request timed out after ${requestTimeoutMs}ms`),
      );
    }, requestTimeoutMs);
    try {
      let response: Response;
      try {
// [失败路径] abort 触发后 fetch 以 AbortError reject，会落到下面的 catch：与网络错误共用同一条日志与抛出路径，
// 调用方只看到一个 Error，不需要区分中止原因，统一按「本次 draw 失败」降级。
        response = await fetchImpl(params.url, {
          method: params.method,
          headers,
          signal: controller.signal,
          ...(params.body ? { body: JSON.stringify(params.body) } : {}),
        });
      } catch (error) {
        // Bug 原因：Highspeed 过去只把 fetch 异常透传到 RPC，无法区分失败的接口与请求链路。
        // 这里只记录脱敏路由和 request id，不记录请求头/body，避免 JWT 与任务数据落盘。
        logger.warn(undefined, "Highspeed 接口网络请求失败", {
          operation: params.operation,
          method: params.method,
          url: safeUrl,
          requestId,
          durationMs: Date.now() - startedAt,
          error: readErrorMessage(error, params.url, safeUrl),
        });
        throw error;
      }

// [权衡] 刻意写 return await 而不是 return：直接 return 会让 finally 在 Promise 链上提前执行，
// deadline 可能在响应体还没读完时就被清掉，服务端在 headers 之后停滞将永久 pending。
      return await readHighspeedResponse({
        logger,
        operation: params.operation,
        method: params.method,
        rawUrl: params.url,
        safeUrl,
        requestId,
        startedAt,
        response,
        parse: params.parse,
      });
    } finally {
// [资源] 清理必须无条件执行且先于异常向外传播，
// 否则失败的请求会留下一个 20s 后才触发的 abort 回调。
      clearTimeout(deadline);
    }
  }

  return {
// draw 用 POST + JSON body；content-type 由 performRequest 依据 body 是否存在决定，
// 这里不重复声明，避免出现两份可能不一致的头。
    draw: (request) =>
      performRequest({
        operation: "draw",
        method: "POST",
        url: options.drawUrl,
        body: request,
        resolveHeaders: options.drawHeaders,
        parse: (payload) => highspeedDrawResponseSchema.safeParse(payload),
      }),
// [失败路径] cardId 必须 encodeURIComponent：它来自远端任务数据，若含斜杠或问号，直接拼接会改写路径或注入 query；
// 返回做 snake_case → camelCase 映射，UI 层不感知后端字段命名。
    async healthy(cardId) {
      const parsed = await performRequest({
        operation: "healthy",
        method: "GET",
        url: new URL(`${encodeURIComponent(cardId)}/healthy`, options.healthyBaseUrl).toString(),
        resolveHeaders: options.healthyHeaders,
        parse: (payload) => highspeedHealthyResponseSchema.safeParse(payload),
      });
      return {
        cardId: parsed.data.card_id,
        promptTokens: parsed.data.prompt_tokens,
        completionTokens: parsed.data.completion_tokens,
        durationSeconds: parsed.data.duration_seconds,
      };
    },
  };
}

// 响应归一的固定顺序：读 body → JSON.parse → HTTP 状态 → schema → 业务码。顺序不可交换：
// 先判状态才能把 502 的 HTML 报成 HTTP 失败而非结构失败；先 schema 再业务码，才能保证 readBusinessCode 拿到已校验对象。
// 每个分支都经过 logResponseFailure，保证日志字段（status/requestId/duration）齐全。
async function readHighspeedResponse<T>(params: {
  logger: Pick<ServiceLogger, "warn">;
  operation: "draw" | "healthy";
  method: "GET" | "POST";
  rawUrl: string;
  safeUrl: string;
  requestId: string | undefined;
  startedAt: number;
  response: Response;
  parse: (payload: unknown) => { success: true; data: T } | { success: false; error: Error };
}): Promise<T> {
// 诊断头在读取 body 之前抓取：提前快照后，body 读取失败的分支也能带上上游 trace id。
  const responseHeaders = readDiagnosticHeaders(params.response.headers);
  let responseText: string;
  try {
// [失败路径] body 读取失败（连接被 reset、gzip 损坏）单独记日志后抛出：此时还拿不到 payload，日志只能依赖已抓好的诊断头。
    responseText = await params.response.text();
  } catch (error) {
    logResponseFailure(params, "Highspeed 接口响应读取失败", {
      responseHeaders,
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

  let payload: unknown;
  try {
// [失败路径] 非 2xx 且 body 非 JSON（网关 HTML 错误页）时，用 HTTP 状态构造错误并保留 cause；
// 2xx 却无法解析才是真正的协议错误。两条分支的日志文案必须区分，否则排障会把网关故障看成实现 bug。
// 保留 cause 便于 dev 日志看到 SyntaxError 位置，message 只给稳定前缀。
    payload = JSON.parse(responseText) as unknown;
  } catch (error) {
    if (!params.response.ok) {
      logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
        responseHeaders,
        response: summarizeResponse(responseText),
      });
// 这里不拼 body 内容：状态码已足以定位，把网关 HTML 塞进 message 会顺着日志与 UI 外泄。
      throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`, {
        cause: error,
      });
    }
    logResponseFailure(params, "Highspeed 接口响应 JSON 解析失败", {
      responseHeaders,
      response: summarizeResponse(responseText),
      error: readErrorMessage(error, params.rawUrl, params.safeUrl),
    });
    throw error;
  }

// 先做摘要再判断状态：HTTP 失败与结构失败共用同一份摘要逻辑，保证日志里不会出现原始 body。
  const responseSummary = summarizeResponse(payload);
  if (!params.response.ok) {
    logResponseFailure(params, "Highspeed 接口 HTTP 请求失败", {
      responseHeaders,
      response: responseSummary,
    });
    throw new Error(`highspeed ${params.operation} failed: ${params.response.status}`);
  }

// schema 校验放在业务码之前：结构不合法时 code 字段本身不可信，
// 先校验能避免把畸形响应里的数字当成业务码做判断。
  const parsed = params.parse(payload);
  if (!parsed.success) {
    logResponseFailure(params, "Highspeed 接口响应结构校验失败", {
      responseHeaders,
      response: responseSummary,
      error: truncateLogText(parsed.error.message),
    });
    throw parsed.error;
  }
// 业务码是后端在 200 里表达的软失败，必须与 HTTP 状态分开判断；
// 只有 number 才是有效业务码，缺失或字符串形态都按「无业务码」处理。
  const businessCode = readBusinessCode(parsed.data);
  if (businessCode !== undefined && businessCode !== 0) {
    logResponseFailure(params, "Highspeed 接口业务失败", {
      responseHeaders,
      response: responseSummary,
    });
    // Bug 根因：旧实现只记录非零业务码却继续返回 data，会让调用方缓存
    // 被后端拒绝的卡或把 share/healthy 误判为成功。业务失败必须在 I/O 边界向上传播。
    throw new HighspeedBusinessResponseError(params.operation, businessCode);
  }
// 走到这里表示 HTTP 成功、结构合法、业务码为 0；本函数没有「部分成功」的返回形态。
  return parsed.data;
}

// 失败日志的唯一出口：集中补齐 status/statusText/duration/requestId，
// 各分支只传差异字段，避免新增分支漏记 requestId 导致无法串联。
function logResponseFailure(
  params: {
    logger: Pick<ServiceLogger, "warn">;
    operation: "draw" | "healthy";
    method: "GET" | "POST";
    safeUrl: string;
    requestId: string | undefined;
    startedAt: number;
    response: Response;
  },
  message: string,
  context: Record<string, unknown>,
): void {
  params.logger.warn(undefined, message, {
    operation: params.operation,
    method: params.method,
    url: params.safeUrl,
    requestId: params.requestId,
    durationMs: Date.now() - params.startedAt,
    status: params.response.status,
    statusText: params.response.statusText,
    ...context,
  });
}

// [权衡] 只保留 origin + pathname：query 里可能带 token 或卡片参数，pathname 足以定位接口；解析失败时返回固定占位而非原串。
// 该函数同时供 readErrorMessage 替换，保证异常文本里的 URL 也不泄露 query。
function sanitizeLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-highspeed-url>";
  }
}

// 白名单读取：Headers.get 本身大小写不敏感，常量用小写即可；
// 空值不写入结果，避免日志出现「x-request-id: 空串」这种误导性字段。
function readDiagnosticHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) result[name] = value;
  }
  return result;
}

// 日志文本的三道处理：截断 → 去 Bearer/JWT → 去 key=value 形态的凭据。
// [权衡] 先截断再脱敏是为了让超长 HTML 不进入正则；代价是恰被截断的 token 只暴露前缀，因此正则按整段形态匹配。
function truncateLogText(value: string): string {
  const trimmed = value.trim();
  const truncated =
    trimmed.length > MAX_LOG_TEXT_CHARS ? `${trimmed.slice(0, MAX_LOG_TEXT_CHARS)}…` : trimmed;
  return truncated
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>")
    .replace(
      /(["']?(?:token|authorization|api[_-]?key|secret)["']?\s*[:=]\s*["'])[^"']+/gi,
      "$1<redacted>",
    );
}

// 异常 message 可能内嵌完整请求 URL（fetch 的 TypeError 就常这样），
// 这里先替换成脱敏 URL 再过脱敏，避免 query 里的 token 随错误文本落盘。
function readErrorMessage(error: unknown, rawUrl: string, safeUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateLogText(message.replaceAll(rawUrl, safeUrl));
}

// 摘要只保留 code、message 与字段名：message 截断脱敏，字段名排序后输出，让同一接口的两次失败日志可以直接 diff；
// 非对象 body 只给截断预览，不回显完整 HTML 或用户数据。
function summarizeResponse(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { bodyPreview: truncateLogText(String(payload ?? "")) };
  }
  const record = payload as Record<string, unknown>;
  const message = [record.msg, record.message, record.error, record.detail].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    ...(typeof record.code === "number" || typeof record.code === "string"
      ? { code: record.code }
      : {}),
    ...(message ? { message: truncateLogText(message) } : {}),
    fields: Object.keys(record).sort(),
  };
}

// 返回 undefined 表示「该响应没有业务码语义」，与 code=0 的成功区分开；
// 只接受 number：网关常把 code 序列化成字符串，那种情况既不能当成功也不能当失败。
function readBusinessCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
