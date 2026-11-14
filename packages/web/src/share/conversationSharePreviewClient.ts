// INV-01 分享码唯一语法校验入口是 SHARE_CODE_PATTERN（守住位置：parseConversationShareRoute 与 buildShareImportDeepLink 之前收敛输入）；改错故障：非法字符进入 URL 路径，请求落到非预期 endpoint。
// INV-02 校验对象必须是解码后的明文（守住位置：decodeURIComponent 之后复查）；改错故障：编码过的分隔符绕过白名单，形成路径注入。
// INV-03 长度上限 512 是协议约束（守住位置：正则量词，勿在别处再截断）；改错故障：超长输入撑爆 URL 与日志，或两端截断位置不一致导致查不到分享。
// INV-04 路由解析失败一律返回 null（守住位置：parseConversationShareRoute 的早返回）；改错故障：异常穿透到渲染层，整页白屏而非展示链接无效。
// INV-05 错误类型是枚举化契约（守住位置：ConversationSharePreviewErrorKind 复用 shared 定义）；改错故障：UI 文案分支漏配，用户看到泛化报错且无法判断可否重试。
// INV-06 错误对象保留 status、code、requestId（守住位置：构造函数一次性赋值）；改错故障：线上排障无法把页面报错关联到服务端日志。
// INV-07 requestId 需先过 schema 再写入（守住位置：构造函数内的 safeParse）；改错故障：异常响应头污染错误对象，日志关联到错误请求。
// INV-08 网络层错误统一归为 network 且保留 cause（守住位置：getPreview 的 fetch 异常分支）；改错故障：把 CORS 失败与 404 混为一谈，排障方向完全偏离。
// INV-09 诊断日志只记脱敏元数据（守住位置：DEFAULT_DIAGNOSTICS 及各调用点）；改错故障：分享凭据、JWT、响应正文落盘并被长期留存。
// INV-10 baseUrl 构造时去空白并裁尾部斜杠（守住位置：构造函数，唯一前缀来源）；改错故障：出现双斜杠或空串前缀，请求路径与网关规则不匹配。
// INV-11 fetch 必须包一层再保存（守住位置：构造函数里的箭头函数）；改错故障：浏览器抛 Illegal invocation，而 Node 测试仍然全绿。
// INV-12 匿名访问不发送空 Bearer 头（守住位置：getPreview 的 accessToken 分支）；改错故障：服务端把空凭证当失败鉴权，返回 401 而非 404。
// INV-13 响应先取 text 再判状态（守住位置：getPreview 的响应读取顺序）；改错故障：空体响应进入 JSON 解析，用户看到解析失败而非链接失效。
// INV-14 4xx 与 5xx 优先解析错误信封（守住位置：!response.ok 分支）；改错故障：丢弃服务端 msg 与 logid，客服无法定位。
// INV-15 成功响应必须过信封 schema（守住位置：successEnvelopeSchema 校验）；改错故障：契约漂移被当作空数据渲染，脏字段流入 UI。
// INV-16 版本校验先于行解码（守住位置：isConversationShareSchemaVersionSupported 判断）；改错故障：旧客户端尝试解析未来格式，报错语义错误。
// INV-17 行解码是逐行降级（守住位置：decodeConversationShareRows 与 unsupportedCount 回填）；改错故障：服务端新增行类型即让旧客户端整页打不开。
// INV-18 返回值是已解码的 Preview（守住位置：getPreview 的唯一出口）；改错故障：调用方继续使用原始 rows，绕过降级统计。
//
// 模块职责：Web 落地页分享预览的 HTTP 客户端，负责路由与分享码校验、请求构造、错误分类、诊断上报与行级降级。
// 状态所有权：本模块无持久状态，只持有 baseUrl、fetch 实现与诊断 sink，均在构造时注入后只读。
// 阅读顺序：先看 SHARE_CODE_PATTERN 与错误类型，再看构造函数，最后沿 getPreview 顺序阅读请求、错误分支与降级。
import {
  conversationShareErrorEnvelopeSchema,
  classifyConversationShareError,
  conversationShareRequestIdSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  parseConversationSharePathname,
  type ConversationShareErrorKind,
  type ConversationSharePreview,
  type Locale,
} from "@zcode/shared";

// 分享码是唯一外部输入，正则同时限定字符集与长度上限
// 白名单只放行 URL 安全字符，斜杠问号井号百分号一律拒绝
// 放宽字符集会改变请求路径结构，必须保持最小集合
// 上限 512 与协议字段一致，防止超长值撑爆 URL 与日志
// 这里只做语法判断，是否可访问由服务端裁决，不要加业务白名单
const SHARE_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/u;

export type ConversationSharePreviewErrorKind = ConversationShareErrorKind;

// 对外错误契约：kind 决定 UI 文案与是否可重试
// status 与 code 原样保留，供页面细分支与客服关联服务端日志
// requestId 先过 schema 再赋值，坏响应头不会污染错误对象
// cause 仅在显式传入时透传，保留底层异常链便于定位
// 继承 Error 需手写 name，否则日志里只能看到通用 Error
export class ConversationSharePreviewClientError extends Error {
  readonly kind: ConversationSharePreviewErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly requestId?: string;

  constructor(options: {
    kind: ConversationSharePreviewErrorKind;
    message: string;
    status?: number;
    code?: number;
    requestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationSharePreviewClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = conversationShareRequestIdSchema.safeParse(options.requestId);
    if (requestId.success) this.requestId = requestId.data;
  }
}

export function isSafeConversationShareCode(value: string): boolean {
  return SHARE_CODE_PATTERN.test(value);
}

// 先解析结构再解码，畸形百分号转义会让 decodeURIComponent 抛错
// 解码异常直接返回 null，不向上抛，路由层据此渲染链接无效
// 解码后必须二次校验，否则编码过的分隔符可绕过字符白名单
// 返回 null 表示不是合法分享路由，调用方不得回退到其他页面路径
// 通过校验才返回明文 code，后续请求不得再拼接原始 rawCode
export function parseConversationShareRoute(pathname: string): string | null {
  const parsed = parseConversationSharePathname(pathname);
  if (!parsed) return null;
  let code: string;
  try {
    code = decodeURIComponent(parsed.rawCode);
  } catch {
    return null;
  }
  return isSafeConversationShareCode(code) ? code : null;
}

/** 页面语言由路径前缀决定：/cn/share 中文，裸 /share 英文；非分享路径回退到浏览器语言。 */
export function resolveConversationShareRouteLocale(pathname: string): Locale {
  const parsed = parseConversationSharePathname(pathname);
  if (parsed) return parsed.locale;
  return /^zh(?:-|$)/iu.test(navigator.language) ? "zh-CN" : "en-US";
}

// deeplink 跨进程传给桌面端，生成前必须复验分享码
// 查询参数用 encodeURIComponent 编码，防止与号与井号截断或追加参数
// 非法输入抛 TypeError 而非客户端错误，属于调用方编程错误
// 分享码已是白名单字符，编码仍需保留，避免协议层再产生解码歧义
export function buildShareImportDeepLink(shareCode: string): string {
  if (!isSafeConversationShareCode(shareCode)) {
    throw new TypeError("Invalid conversation share code");
  }
  return `zcode://share/import?code=${encodeURIComponent(shareCode)}`;
}

export interface ConversationSharePreviewClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  diagnostics?: ConversationSharePreviewDiagnostics;
}

export interface ConversationSharePreviewDiagnostics {
  info(event: string, details: Record<string, unknown>): void;
  warn(event: string, details: Record<string, unknown>): void;
}

// fetch/CORS/DNS 异常不能统一折叠为 network：需要看到请求是否发起以及实际 endpoint。
// 日志只保留脱敏目标和传输元数据，禁止记录 share code、JWT、响应正文或 Signed URL。
const DEFAULT_DIAGNOSTICS: ConversationSharePreviewDiagnostics = {
  info(event, details) {
    console.info("[conversation-share-web]", event, details);
  },
  warn(event, details) {
    console.warn("[conversation-share-web]", event, details);
  },
};

const successEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationSharePreviewDataSchema,
);

export class ConversationSharePreviewClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly diagnostics: ConversationSharePreviewDiagnostics;

  // baseUrl 去空白并裁掉尾部斜杠，保证拼接只出现一个分隔符
  // 空串前缀会让请求落到相对路径，必须在此收口
  // baseUrl 构造后只读，运行期不得再改，避免请求目标漂移
  // 注入的 fetch 与诊断 sink 只在构造时决定，测试替换点唯一
  constructor(options: ConversationSharePreviewClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    // 直接保存 window.fetch 后以实例方法调用会把 this 绑定到 Client，Chromium 因此抛 Illegal invocation。
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.diagnostics = options.diagnostics ?? DEFAULT_DIAGNOSTICS;
  }

  // 网络调用前先校验分享码，非法输入不消耗配额也不产生服务端日志
  // accessToken 为空或纯空白视为匿名，不发送空 Bearer 头
  // 鉴权与否会影响 404 与 401 的语义，因此要随诊断一起上报
  // 错误分支必须携带请求目标元数据，否则无法区分未发出与被拦截
  // 返回值是已解码行与降级计数的 Preview，调用方不再接触原始 rows
  // 本方法不缓存结果，重复调用即重复请求，缓存责任在调用方
  async getPreview(shareCode: string, accessToken?: string): Promise<ConversationSharePreview> {
    if (!isSafeConversationShareCode(shareCode)) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Invalid conversation share code",
      });
    }

    const headers = accessToken?.trim()
      ? { Authorization: `Bearer ${accessToken.trim()}` }
      : undefined;
    const authenticated = headers !== undefined;
    const requestTarget = `${this.baseUrl}/shares/<redacted>/preview`;
    this.diagnostics.info("preview_request_started", {
      requestTarget,
      pageOrigin: globalThis.location?.origin ?? "unavailable",
      authenticated,
      shareCodeLength: shareCode.length,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/shares/${encodeURIComponent(shareCode)}/preview`,
        { method: "GET", ...(headers ? { headers } : {}) },
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      // fetch 拒绝覆盖断网、CORS、DNS 与取消，统一归为 network 并保留 cause
      // 原始错误信息可能回显完整 URL，记录前先替换明文分享码
      // 编码形态也要替换，否则百分号形式仍会把凭据写进日志
      // 失败路径同样上报 requestTarget 与 authenticated，便于还原上下文
      // 对外文案固定且不含底层细节，避免泄露内部地址与实现
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = rawErrorMessage
        .replaceAll(shareCode, "<redacted>")
        .replaceAll(encodeURIComponent(shareCode), "<redacted>");
      this.diagnostics.warn("preview_request_failed", {
        requestTarget,
        authenticated,
        errorName,
        errorMessage,
      });
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Unable to load this conversation share",
        cause: error,
      });
    }

    this.diagnostics.info("preview_response_received", {
      requestTarget,
      authenticated,
      status: response.status,
      ok: response.ok,
      redirected: response.redirected,
      contentType: response.headers.get("content-type"),
    });

    const headerId = conversationShareRequestIdSchema.safeParse(
      response.headers.get("x-request-id"),
    );
    const requestId = headerId.success ? headerId.data : undefined;
    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Share response interrupted",
        status: response.status,
        requestId,
        cause,
      });
    }
    // 必须先取 text 再判断状态，空响应体无法进入 JSON 解析
    // 非 2xx 且空体多来自网关或代理，按状态码分类而不是契约错误
    // 空体但状态成功同样属于契约破坏，不能当空数据继续渲染
    // 顺序颠倒会让用户看到解析失败，而不是可行动的链接失效提示
    if (!response.ok && !body.trim()) {
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ConversationSharePreviewClientError({
        kind: response.ok ? "invalid_contract" : classifyConversationShareError(response.status),
        message: "Conversation share API returned invalid JSON",
        status: response.status,
        requestId,
        cause: error,
      });
    }

    // 非 2xx 时优先按错误信封解析，保留服务端 msg 与 logid
    // requestId 缺失时回退到 logid，保证关联线索不断
    // 信封解析失败才降级为按状态码分类的通用错误
    // code 原样透传，便于 UI 区分限流、失效与需要登录等场景
    if (!response.ok) {
      const parsedError = conversationShareErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        // 未知业务码保留 code 和请求 ID，方便关联服务端日志。
        throw new ConversationSharePreviewClientError({
          kind: classifyConversationShareError(response.status, parsedError.data.code),
          message: parsedError.data.msg,
          status: response.status,
          requestId: requestId ?? parsedError.data.logid,
          code: parsedError.data.code,
        });
      }
      throw new ConversationSharePreviewClientError({
        kind: classifyConversationShareError(response.status),
        message: "Conversation share API failed",
        status: response.status,
        requestId,
      });
    }

    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share preview does not match the public contract",
        status: response.status,
        requestId,
        cause: parsed.error,
      });
    }
    const data = parsed.data.data;
    // 落地页镜像是独立部署、独立回滚的，所以它随时可能比发布分享的客户端旧。版本高于本
    // build 认知时要说「请升级」，不能混进「分享格式无效」。
    if (!isConversationShareSchemaVersionSupported(data.schema_version)) {
      this.diagnostics.warn("preview_schema_version_unsupported", {
        requestTarget,
        version: data.schema_version,
      });
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Conversation share requires a newer ZCode version",
        status: response.status,
        requestId,
      });
    }
    // 逐行降级：认不出的行跳过并计数，不让整页打不开。
    const decoded = decodeConversationShareRows(data.rows);
    if (decoded.unsupportedCount > 0) {
      this.diagnostics.info("preview_dropped_unsupported_rows", {
        requestTarget,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return { ...data, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }
}
