// ============================================================================
// feedbackHttpClient：反馈工单 HTTP 边界
// 职责：把反馈 RPC 的入参翻译成后端 REST 请求，并把返回的 snake_case 报文
// 归一化成 packages/shared 的 FeedbackTicket* 结构，同时承担 OSS 表单直传。
// 本文件是反馈链路上唯一允许直接拼 URL、读原始响应体的位置；上层拿到的
// 一律是已归一化、可展示的数据。
//
// INV-01：写日志或写请求体的字符串必须先经 redactFeedbackText。
//         守住它的位置：create()/comment()/assignDefined()/summarize*()。
//         破坏后果：用户反馈正文、联系方式、主机路径进入本地日志与远端工单。
// INV-02：日志只允许出现脱敏 URL、字段名和长度摘要，禁止完整 query、ticket id、token。
//         守住它的位置：sanitizeFeedbackLogUrl()/summarizeRequestBody()。
//         破坏后果：工单标识与设备 ID 落盘，等同于把用户反馈与设备绑定泄露。
// INV-03：create() 必须在发请求前确认 device_mid 存在。
//         守住它的位置：create() 中的 if (!deviceMid) 分支。
//         破坏后果：后端按空设备建单，工单无法归因，且列表按设备过滤后会丢单。
// INV-04：上传上限由 kind 决定（log 1GB、其它 100MB），且必须同时通过本地 stat
//         与服务端 max_size 两道校验。守住它的位置：uploadFile()。
//         破坏后果：超限附件会卡在 OSS 回调阶段失败，留下孤儿对象。
// INV-05：时间输出统一为 UTC；秒级时间戳必须乘 1000，缺失时沿用上级 fallback。
//         守住它的位置：normalizeFeedbackTime()。
//         破坏后果：时间显示偏移 8 小时，或列表按时间排序错乱。
// INV-06：上传的每个终止路径（成功/失败/取消）只能 settle 一次，且必须销毁
//         文件流与请求。守住它的位置：uploadOssForm() 的 settled 闸门。
//         破坏后果：重复 resolve/reject、句柄泄漏，进程卡住不退出。
// ============================================================================
import { redactFeedbackText } from "@zcode/shared";
/* eslint-disable max-lines -- 反馈 HTTP 客户端集中维护新后端协议、鉴权头合并、OSS 表单直传和响应归一化。 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname } from "node:path";

import type {
  ApiClient,
  ApiRequestInit,
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackCommentAttachment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
  FeedbackTicketEvent,
  FeedbackTicketFramework,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { withRequestIdHeaderRecord } from "#src/providers/api/requestIdHeaders.js";
import {
  getNetworkErrorCodes,
  isRetryableConnectionEstablishmentError,
} from "#src/providers/api/networkErrorClassifier.js";
import { resolveClientConfigPlatform } from "#src/runtime-tools/clientPlatform.js";

interface FeedbackHttpClientOptions {
  baseUrl: string;
  apiClient: ApiClient;
  getAuthHeaders: () => Promise<Record<string, string>>;
  logger?: ServiceLogger;
}

interface FeedbackUploadProgressEvent {
  uploadedBytes: number;
  totalBytes: number;
}

// 上传可选项集中在一个结构里：signal 贯穿凭证请求与 OSS 直传两段，
// 任一段中止都必须让调用方看到同一个 FeedbackUploadCanceledError，
// 否则 UI 无法区分“用户取消”与“网络失败”。
interface FeedbackUploadFileOptions {
  messageId?: string;
  onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
  signal?: AbortSignal;
}

interface FeedbackCreateRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// 后端统一信封 { code, msg, data }：code !== 0 是业务失败而不是 HTTP 失败，
// 因此不能在 request() 的 !response.ok 分支里判断，必须解析后再拆信封。
// data 在 code 为 0 之前不可信，任何字段读取都要放到 unwrap 之后。
interface FeedbackApiEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

// 摘要结构只描述后端真实会回的字段，全部可选：列表接口在不同版本上
// 可能省略 title/status，缺失值由 mapTicketSummary 统一兜底。
// 不要在这里加业务字段——它只做协议镜像。
interface FeedbackTicketSummaryResponse {
  ticket_id: string;
  device_mid?: string;
  title?: string | null;
  status?: string | null;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

// 详情响应在摘要基础上多三段：content 是用户填写的主体，environment 是客户端
// 上报的白名单字段，messages 是补充回复。三者都允许 null，因为后端对老工单
// 不会回填，读取侧必须逐层兜底而不能假设数组/对象存在。
interface FeedbackTicketDetailResponse extends FeedbackTicketSummaryResponse {
  content?: {
    description?: string | null;
    category?: string | null;
    function?: string | null;
    severity?: string | null;
  } | null;
  environment?: Record<string, unknown> | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  messages?: FeedbackMessageResponse[] | null;
}

// 消息的 sender_type 决定气泡方向（staff/admin 视为客服），
// 不依赖昵称或头像 URL，避免后端改文案导致回复左右翻转。
interface FeedbackMessageResponse {
  message_id: string;
  ticket_id?: string;
  sender_type?: string | null;
  content?: { text?: string | null } | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  created_at?: number | string | null;
}

interface FeedbackAttachmentResponse {
  attachment_id?: string | number | null;
  id?: string | number | null;
  file_name?: string | null;
  filename?: string | null;
  size?: number | null;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at?: number | string | null;
}

// 凭证字段保持后端 snake_case 原样，避免多一层映射带来的遗漏；
// oss.* 是 OSS PostObject 表单的必填项，少传一个都会被 OSS 以 403 拒绝，
// 而 OSS 的错误体是 XML，无法直接映射成可读提示。
interface FeedbackUploadCredentialResponse {
  attachment_id: string;
  max_size: number;
  callback: {
    url: string;
    body: string;
    content_type: string;
  };
  oss: {
    host: string;
    path: string;
    policy: string;
    x_oss_signature: string;
    x_oss_signature_version: string;
    x_oss_credential: string;
    x_oss_security_token: string;
    x_oss_date: string;
  };
}

// 单例 logger 兜底：测试或工具脚本可能不注入 logger，此时丢日志可以接受，
// 但请求路径不能因为 logger 缺失而抛错。
// 两个附件上限分开定义：日志包允许 1GB，普通反馈附件保持 100MB。
const defaultLogger = createServiceLogger("feedback-http");
const FEEDBACK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const FEEDBACK_MAX_LOG_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
// 创建工单是用户可见的第一步，上限取 30s：再长不如直接失败让用户重试，
// 否则 UI 会一直停在“正在连接反馈服务”。超时由 ApiClient 实现，
// 这里只表达意图，不自己起定时器，避免两套超时互相竞态。
const FEEDBACK_CREATE_TIMEOUT_MS = 30_000;

// 用独立错误类型而不是 Error("aborted")：上层需要按 instanceof 区分取消与失败，
// 取消不弹错误提示、不计入失败埋点；字符串匹配在打包压缩或文案调整后会失效。
export class FeedbackUploadCanceledError extends Error {
  constructor() {
    super("Feedback upload canceled");
    this.name = "FeedbackUploadCanceledError";
  }
}

// 后端错误体形态不固定（JSON 信封 / {detail} / 纯文本 / 空体），
// 这里按“msg 优先、其次 detail、最后文本或 HTTP 状态码”的顺序降级。
// 该函数自身永不抛错：它运行在已经失败的路径上，再抛会掩盖原始状态码。
async function readResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { msg?: unknown; detail?: unknown };
    if (typeof json.msg === "string" && json.msg.trim()) {
      return json.msg;
    }
    if (typeof json.detail === "string") {
      return json.detail;
    }
  } catch {
    // ignore
  }
  return text || `HTTP ${response.status}`;
}

// [权衡] 采用“鉴权头先铺底、调用方头后覆盖”的顺序：调用方显式设置的头优先，
// 但 x-request-id 最后统一补齐，避免两处各生成一个 id 导致日志无法关联。
// 同名单头大小写不同（content-type 与 Content-Type）会同时保留，
// 这里不做小写归一化，交给 apiClient 按 fetch 语义处理。
function mergeFeedbackRequestHeaders(
  authHeaders: Record<string, string>,
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const next = { ...authHeaders };
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      next[key] = value;
    }
  } else if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      next[key] = String(value);
    });
  }
  return withRequestIdHeaderRecord(next);
}

// Headers 记录不保证大小写一致（鉴权头来自不同 provider），故按大小写不敏感查找；
// 未命中返回 undefined 而不是空串，让调用方能直接用 Boolean(...) 判断是否携带。
function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 上限必须由 kind 推导而不能取全局最大值：把日志包上限套到普通附件上，
// 会让后端在 100MB 处拒绝上传，而前端进度条仍显示“还在上传”。
function getFeedbackMaxAttachmentBytes(kind: FeedbackAttachmentKind): number {
  return kind === "log" ? FEEDBACK_MAX_LOG_ATTACHMENT_BYTES : FEEDBACK_MAX_ATTACHMENT_BYTES;
}

function readEnvelopeCode(value: unknown): number | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const { code } = value;
  return typeof code === "number" ? code : undefined;
}

// 摘要只暴露 present/length，绝不回传原值：标题与描述可能含工单正文，
// 日志需要回答的是“字段有没有传、是否为空”，而不是内容本身。
function summarizeStringField(value: unknown): { present: boolean; length?: number } {
  if (typeof value !== "string") {
    return { present: false };
  }
  return { present: true, length: value.length };
}

function summarizeFileNameField(value: unknown): {
  present: boolean;
  length?: number;
  extension?: string;
} {
  const summary = summarizeStringField(value);
  if (typeof value !== "string") {
    return summary;
  }
  const extension = extname(value);
  return extension ? { ...summary, extension } : summary;
}

// 创建请求是排查 database error 的唯一证据来源，但字段里全是用户内容。
// 因此只保留字段名集合与少量枚举值（category/function/severity），
// 字符串一律降级为长度；environment 只挑与客户端环境相关且非隐私的键。
function summarizeFeedbackCreateBody(body: Record<string, unknown>): Record<string, unknown> {
  const content = isObjectRecord(body.content) ? body.content : {};
  const environment = isObjectRecord(body.environment) ? body.environment : {};
  return {
    fields: Object.keys(body).sort(),
    title: summarizeStringField(body.title),
    hasDeviceMid: typeof body.device_mid === "string" && body.device_mid.length > 0,
    content: {
      fields: Object.keys(content).sort(),
      description: summarizeStringField(content.description),
      category: typeof content.category === "string" ? content.category : undefined,
      function: typeof content.function === "string" ? content.function : undefined,
      severity: typeof content.severity === "string" ? content.severity : undefined,
    },
    contact: summarizeStringField(body.contact),
    environment: {
      fields: Object.keys(environment).sort(),
      appVersion: environment.app_version,
      platform: environment.platform,
      releaseChannel: environment.release_channel,
      osCategory: environment.os_category,
      osVersion: environment.os_version,
      source: environment.source,
    },
  };
}

// 凭证请求只需要回答两件事：是哪个附件（脱敏后的文件名与扩展名）、有多大。
// ticket_id/message_id 只记录是否存在，避免工单标识进入日志。
function summarizeUploadCredentialBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    fields: Object.keys(body).sort(),
    hasTicketId: typeof body.ticket_id === "string" && body.ticket_id.length > 0,
    hasMessageId: typeof body.message_id === "string" && body.message_id.length > 0,
    fileName: summarizeFileNameField(body.file_name),
    size: typeof body.size === "number" ? body.size : undefined,
  };
}

// 只处理字符串 body：FormData 与流式 body 无法安全解析，直接返回 undefined，
// 宁可日志少记，也不要把文件内容或流读出来写进日志。
// 非对象 JSON（数组、字符串字面量）只记类型，避免整段内容落盘。
function summarizeRequestBody(
  path: string,
  method: string,
  body: RequestInit["body"] | null | undefined,
): Record<string, unknown> | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isObjectRecord(parsed)) {
      return { jsonType: typeof parsed };
    }
    // 反馈创建失败时 RPC 日志只记录了 database error，缺少 HTTP 边界证据。
    // 这里仅记录字段和值摘要，避免把用户反馈正文、联系方式、token 或完整设备 ID 写入日志。
    if (method.toUpperCase() === "POST" && path === "/feedback/ticket") {
      return summarizeFeedbackCreateBody(parsed);
    }
    // 日志包超出反馈后端单附件限制时只返回 parameter error；
    // 上传凭证日志需要记录脱敏后的 file_name/size，才能从客户端侧定位是哪个附件被拒绝。
    if (method.toUpperCase() === "POST" && path === "/feedback/attachment/upload-credential") {
      return summarizeUploadCredentialBody(parsed);
    }
    return { fields: Object.keys(parsed).sort() };
  } catch {
    return { unparsable: true, length: body.length };
  }
}

// 完整 URL 含 ticket id 与查询参数，落盘即等于泄露工单标识与分页条件。
// 保留 origin 与路由模板、丢掉 query，足以定位“打了哪个接口”又不含可变标识；
// 解析失败给固定占位串，保证日志字段格式稳定、可被聚合查询。
function sanitizeFeedbackLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // 工单详情和消息路径包含 ticket id，完整 URL 落盘会泄露用户工单标识。
    // 日志只保留目标 origin 和路由模板，并移除查询参数，实际请求仍使用原始 URL。
    const pathname = parsed.pathname.replace(/(\/feedback\/ticket\/)[^/]+(?=\/|$)/, "$1:ticketId");
    return `${parsed.origin}${pathname}`;
  } catch {
    return "<invalid-feedback-url>";
  }
}

// 客户端本身无状态，只持有 options；每次请求都重新取鉴权头，
// 因为 token 会刷新、设备 ID 会随重新登录变化，缓存等于使用过期凭据。
// 对外方法只返回共享包里的归一化类型，错误统一是可直接展示 message 的 Error，
// 调用方不需要也不允许接触后端字段名。
export class FeedbackHttpClient {
  constructor(private readonly options: FeedbackHttpClientOptions) {}

  private get apiBaseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private get logger(): ServiceLogger {
// logger 用 getter 延迟取值：注入方可能在构造后才替换 logger（测试替身），
// 构造时缓存会让后续日志丢失。
    return this.options.logger ?? defaultLogger;
  }

// request 是唯一的 HTTP 出口，负责四件事：
// 1) 合并鉴权头并补齐 request-id，保证一次调用内的日志与请求头同一个 id；
// 2) 建连阶段按可重试判定做最多 3 次短重试（见 requestWithHandshakeRetry）；
// 3) 非 2xx、204、JSON 解析失败、业务 code !== 0 分别走不同日志与抛出路径；
// 4) 日志里的 URL 与 body 一律脱敏。
// 这里不做业务级重试：创建工单重复提交会产生重复工单，必须由调用方决定。
  private async request<T>(
    path: string,
    init?: ApiRequestInit,
    authHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers = mergeFeedbackRequestHeaders(
      authHeaders ?? (await this.options.getAuthHeaders()),
      init?.headers,
    );
// baseUrl 先去掉尾部斜杠再拼接：配置里带不带 "/" 都不该出现双斜杠路径，
// 否则后端路由匹配失败，会返回难以理解的 404 而不是业务错误。
    const url = `${this.apiBaseUrl}${path}`;
    const method = init?.method ?? "GET";
// 先取 request-id 再构造 logContext：重试日志、失败日志与成功日志
// 必须携带同一个 id，否则无法把客户端日志与网关访问日志对上。
    const requestId = getHeaderValue(headers, "x-request-id");
    const logContext = {
      method,
      url: sanitizeFeedbackLogUrl(url),
      requestId,
      hasAuthorization: Boolean(getHeaderValue(headers, "Authorization")),
      hasDeviceMid: Boolean(getHeaderValue(headers, "X-Device-Mid")),
      acceptLanguage: getHeaderValue(headers, "Accept-Language"),
      body: summarizeRequestBody(path, method, init?.body),
    };
    const startedAt = Date.now();
    let requestAttemptCount = 1;
    this.logger.info(undefined, "反馈 HTTP 请求开始", logContext);
// [失败路径] 网络层失败与 HTTP 失败分开记录：前者带 errorCodes 用于判断
// DNS/TLS/建连问题，后者带 status 与 msg；混在一起排障时看不出是哪一层。
    let response: Response;
    try {
      response = await requestWithHandshakeRetry(
        () =>
          this.options.apiClient.request(url, {
            ...init,
            headers,
          }),
        ({ attempt, error, nextAttempt }) => {
          requestAttemptCount = nextAttempt;
          this.logger.warn(undefined, "反馈 HTTP 建连失败，准备重试", {
            ...logContext,
            attempt,
            nextAttempt,
            maxAttempts: 3,
            error: getErrorMessage(error),
            errorCodes: getNetworkErrorCodes(error),
          });
        },
      );
    } catch (error) {
// [失败路径] 重试耗尽后才记 warn，此时 attemptCount 是真实尝试次数；
// 它用于区分“一次就失败”和“重试三次仍失败”，直接影响是否需要提示切换网络。
      this.logger.warn(undefined, "反馈 HTTP 请求网络失败", {
        ...logContext,
        durationMs: Date.now() - startedAt,
        attemptCount: requestAttemptCount,
        error: getErrorMessage(error),
        errorCodes: getNetworkErrorCodes(error),
      });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
// 非 2xx 一律抛错，不把响应体透传给上层：反馈后端 4xx 时返回的 msg
// 已是面向用户的中文提示，直接作为 Error.message 可让 UI 零转换展示。
    if (!response.ok) {
      const message = await readResponseError(response);
      this.logger.warn(undefined, "反馈 HTTP 请求失败", {
        ...logContext,
        durationMs,
        status: response.status,
        statusText: response.statusText,
        msg: message,
      });
      throw new Error(message);
    }
// 204 表示“成功且无内容”（删除类接口）。不能继续走 response.json()，
// 否则会抛 SyntaxError，把一次成功调用变成失败。
    if (response.status === 204) {
      this.logger.info(undefined, "反馈 HTTP 请求成功", {
        ...logContext,
        durationMs,
        status: response.status,
      });
      return undefined as T;
    }
// 响应解析单独 try：解析失败与业务失败的语义不同——前者是协议不兼容
// （网关返回 HTML 错误页、代理截断），后者是后端明确拒绝。
// 分开记日志才能在灰度期快速判断是不是中间层改动导致。
    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      this.logger.warn(undefined, "反馈 HTTP 响应解析失败", {
        ...logContext,
        durationMs,
        status: response.status,
        error: getErrorMessage(error),
      });
      throw error;
    }
    try {
// 拆信封与日志分两个 try：code !== 0 时仍要记录 code 与 msg，
// 否则只看到“请求成功但调用抛错”这种矛盾现象。
// 这里只返回 data，上层拿不到 code，避免业务层误用后端状态码。
      const result = unwrapFeedbackResponse<T>(responseJson);
      this.logger.info(undefined, "反馈 HTTP 请求成功", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
      });
      return result;
    } catch (error) {
      this.logger.warn(undefined, "反馈 HTTP 请求业务失败", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
        msg: getErrorMessage(error),
      });
      throw error;
    }
  }

// create 的业务约束：
// - 请求前必须校验 device_mid，缺失即失败（INV-03）；
// - title/description 先脱敏再入参：服务端也会脱敏，但本地日志与埋点
//   读取的是发送前对象，不能依赖服务端兜底；
// - contact 与 environment 不做自由文本脱敏，只做字段白名单；
// - 成功后不重拉详情，直接用入参拼 Detail，省一次往返。
  async create(
    input: CreateFeedbackTicketInput,
    options: FeedbackCreateRequestOptions = {},
  ): Promise<FeedbackTicketDetail> {
    const authHeaders = await this.options.getAuthHeaders();
    const deviceMid = getHeaderValue(authHeaders, "X-Device-Mid");
// [失败路径] device_mid 来自鉴权头而不是入参：它标识“这台设备”，由 provider 注入。
// 主动抛错而不是留空，是因为后端对空 mid 不报错，会静默建出
// 一张在“我的反馈”里永远查不到的工单。
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    const { locale } = input;
// 超时与取消都交给 ApiClient（options.timeoutMs / signal），这里不再包一层
// Promise.race——两套超时叠加会产生“谁先到算谁”的竞态，错误类型也不稳定。
    const ticket = await this.request<FeedbackTicketSummaryResponse>(
      "/feedback/ticket",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(locale ? { "Accept-Language": locale } : {}),
        },
        // 创建工单是用户可见的第一阶段，不能无限等待网络或后端悬挂。
        // 超时和取消都收敛到统一 ApiClient，避免 UI 停在“正在连接反馈服务”。
        timeoutMs: options.timeoutMs ?? FEEDBACK_CREATE_TIMEOUT_MS,
        signal: options.signal,
        body: JSON.stringify({
          title: redactFeedbackText(input.title),
          device_mid: deviceMid,
          content: {
            description: redactFeedbackText(input.description),
            category: input.type,
            function: input.module,
            severity: input.severity,
          },
          contact: input.contact,
          environment: toFeedbackEnvironment(input),
        }),
      },
      authHeaders,
    );
// 用请求入参加服务端返回的 id/时间拼详情：创建响应只有摘要字段，
// 重新 GET 会多一次往返，且刚建好的工单在读写分离下可能还查不到。
    return mapCreatedTicket(ticket, input);
  }

// [权衡] 服务端已支持 limit/offset（见 buildFeedbackListPath），但 status/type
// 过滤仍在客户端做：老版本后端会忽略未知 query，客户端再过滤一次可以保证
// 新旧后端行为一致；代价是跨页过滤时 total 只是本页过滤后的条数。
  async list(query: FeedbackListQuery = {}): Promise<FeedbackListResult> {
    const result = await this.request<{ items?: FeedbackTicketSummaryResponse[] }>(
      buildFeedbackListPath(query),
    );
// 先逐条归一化再过滤，而不是先过滤原始报文：原始报文的 status 可能是
// submitted/待评估 等旧值，必须映射成共享枚举才能与 query.status 比较。
    const mapped = (result.items ?? []).map((item) => mapTicketSummary(item));
    const filtered = mapped.filter((item) => {
      if (query.status && item.status !== query.status) return false;
      if (query.type && item.type !== query.type) return false;
      return true;
    });
    return {
      items: filtered,
      total: filtered.length,
    };
  }

// id 必须 encodeURIComponent：ticket id 若含 "/" 或 "?"，不编码会打到别的路由。
  async get(id: string): Promise<FeedbackTicketDetail> {
// path 里的 id 已由调用方传入，这里再 encode 一次会双重编码；
// 该接口只读，无并发写风险，因此不加超时覆盖默认值。
    const ticket = await this.request<FeedbackTicketDetailResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}`,
    );
    return mapTicketDetail(ticket);
  }

// 补充消息只允许纯文本，因此入参是 string 而不是对象；正文同样先脱敏，
// 保证“本地日志里看到的”和“服务端存的”是同一个内容。
  async comment(id: string, body: string): Promise<FeedbackComment> {
    const message = await this.request<FeedbackMessageResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { text: redactFeedbackText(body) } }),
      },
    );
    return mapMessageToComment(message, 1);
  }

// 上传分三段，顺序不可交换：
// 1) 本地 stat 加本地上限校验，尽早失败且不产生任何网络请求；
// 2) 换取凭证（含服务端 max_size 与 OSS 表单字段）；
// 3) 直传 OSS。
// 只有第 3 段成功，后端才会通过 callback 落库；第 3 段失败虽无法回滚凭证，
// 但必须保证不向上返回半成品附件对象。
  async uploadFile(
    ticketId: string,
    kind: FeedbackAttachmentKind,
    filePath: string,
    filename: string,
    contentType: string,
    options?: FeedbackUploadFileOptions,
  ): Promise<FeedbackAttachment> {
    if (options?.signal?.aborted) {
      throw new FeedbackUploadCanceledError();
    }
// 进入时先看一次 aborted：AbortSignal 只对“之后”注册的监听生效，
// 已中止的 signal 不会再触发 abort 事件，漏判会让上传在取消后继续跑完。
// 用 stat 而不是读入文件判断大小：日志包可能 1GB，
// 整读既会 OOM，也会让取消无法及时生效。
    const fileStats = await stat(filePath);
// 先取本地上限再 stat 比较，顺序不能反：文件可能在上传过程中被追加，
// stat 之后的大小才是本次真实发送量。
    const maxAttachmentBytes = getFeedbackMaxAttachmentBytes(kind);
    if (fileStats.size > maxAttachmentBytes) {
      // 日志附件允许上传到 1GB；普通反馈附件仍保持较小上限。
      // 客户端先校验可以避免无意义请求，并给 UI 返回稳定错误。
      throw new Error(`Feedback attachment exceeds max size ${maxAttachmentBytes}`);
    }
// 凭证请求走统一 request：同样需要鉴权头、重试与脱敏日志，
// 与普通 JSON 接口没有区别；真正差异只在下一段 OSS 直传。
    const credential = await this.request<FeedbackUploadCredentialResponse>(
      "/feedback/attachment/upload-credential",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket_id: ticketId,
          ...(options?.messageId ? { message_id: options.messageId } : {}),
          file_name: filename,
          size: fileStats.size,
        }),
      },
    );
// 服务端 max_size 可能小于本地上限（灰度期配置不同步），必须再校验一次：
// 否则 OSS 会在接收一半后返回 EntityTooLarge，我们只能拿到 XML 错误体，
// 无法给出可读提示。
    if (fileStats.size > credential.max_size) {
      throw new Error(`Feedback attachment exceeds max size ${credential.max_size}`);
    }
    await uploadOssForm(credential, filePath, filename, contentType, {
      size: fileStats.size,
      onUploadProgress: options?.onUploadProgress,
      signal: options?.signal,
    });
    return {
// 返回对象直接供 UI 立即展示，不重新拉详情：download_url/preview_url 先置 null
// （后端 callback 落库后才可访问），redacted 固定 false（附件内容不做文本脱敏）。
      id: toStableNumericId(credential.attachment_id, 1),
      kind,
      filename,
      size: fileStats.size,
      redacted: false,
      content_type: contentType,
      download_url: null,
      preview_url: null,
      created_at: new Date().toISOString(),
    };
  }
}

// limit/offset 只在非负时下发：负数在 URLSearchParams 里会变成 "-1"，
// 后端可能按 500 处理，直接省略更安全。
function buildFeedbackListPath(query: FeedbackListQuery): string {
// 用 URLSearchParams 而不是手拼字符串：后者忘记 encode 时，
// limit 之外一旦加入文本参数就会出现非法 URL，且错误点很难定位。
  const params = new URLSearchParams();
  // 新反馈列表接口支持服务端 limit/offset；只在客户端 slice 会导致刷新列表总是拉全量。
// 只下发真正传了的参数：undefined 与负数都省略，让后端用自己的默认分页；
// 显式传 0 是合法的（只要一页大小），因此不能用 truthy 判断。
  if (query.limit !== undefined && query.limit >= 0) {
    params.set("limit", String(query.limit));
  }
// offset 与 limit 独立下发：后端允许只给 offset 用默认页大小，
// 客户端不要为了“成对”而补一个 limit，否则会改变后端默认分页语义。
  if (query.offset !== undefined && query.offset >= 0) {
    params.set("offset", String(query.offset));
  }
// 无参数时回裸路径而不是带 "?"：部分网关会拒绝空查询串，
// 也会让日志里的 URL 模板多出一个无意义字符。
  const suffix = params.toString();
  return suffix ? `/feedback/ticket?${suffix}` : "/feedback/ticket";
}

// [权衡] 兼容“有信封”和“裸对象”两种后端返回：老网关直接回 data，
// 新网关回 {code,msg,data}。用 "code" in value 判定而不是看类型，
// 业务对象即使恰好带 code 字段，也会因 code !== 0 而明确报错，而不是静默截断。
function unwrapFeedbackResponse<T>(value: unknown): T {
  if (!isObjectRecord(value) || !("code" in value)) {
    return value as T;
  }
  const envelope = value as unknown as FeedbackApiEnvelope<T>;
  if (envelope.code !== 0) {
    throw new Error(envelope.msg?.trim() || `Feedback API error ${envelope.code}`);
  }
  return envelope.data;
}

// environment 必须是白名单而不是展开 input.device：device 里可能带主机名、
// 用户名等隐私字段，全量透传等于把本机信息送到服务端。
// 每个键优先取 device，缺省才回落到 process.*，保证服务端总能归类。
function toFeedbackEnvironment(input: CreateFeedbackTicketInput): Record<string, unknown> {
  const device = input.device ?? {};
// 空对象起步、逐键写入：undefined 的键必须完全不出现，
// 后端按字段存在与否做聚合，显式的 null 会污染统计口径。
  const environment: Record<string, unknown> = {};
// 逐键 assignDefined 而不是 Object.assign：空串与 null 对后端是脏值，
// 会让按 platform 聚合的看板出现空分组，因此在写入前统一剔除。
  assignDefined(environment, "app_version", device.appVersion);
  // 反馈后端与 client/configs 使用同一套平台键；传 desktop 会让反馈无法按真实系统架构归类。
  assignDefined(
    environment,
    "platform",
    resolveClientConfigPlatform(device.osPlatform, device.osArch),
  );
// release_channel 回落到 stable 而不是留空：服务端按渠道分桶，
// 缺值会被归入 unknown，线上排查时看不出影响面。
// ZCODE_ENV 只表达产品环境，不用于判断本地开发形态。
  assignDefined(environment, "release_channel", process.env.ZCODE_ENV?.trim() || "stable");
  assignDefined(environment, "os_category", device.osPlatform ?? process.platform);
  assignDefined(environment, "os_version", device.osVersion ?? device.osRelease ?? process.version);
  assignDefined(environment, "build_commit_id", device.buildCommitId);
  assignDefined(environment, "build_time", device.buildTime);
  assignDefined(environment, "electron_version", device.electronVersion);
  assignDefined(environment, "node_version", device.nodeVersion);
  assignDefined(environment, "os_type", device.osType);
  assignDefined(environment, "os_platform", device.osPlatform);
  assignDefined(environment, "os_release", device.osRelease);
  assignDefined(environment, "os_arch", device.osArch);
  assignDefined(environment, "agent_provider", device.agentProvider);
  assignDefined(environment, "agent_framework", device.agentFramework ?? input.framework);
  assignDefined(environment, "agent_model", device.agentModel);
  assignDefined(environment, "agent_model_display", device.agentModelDisplay);
  assignDefined(environment, "source", input.source);
  return environment;
}

// 统一在写入点做一次 redact：调用方可能传用户输入（source、agentModel），
// 分散脱敏容易漏；空串同样视为缺失，避免后端存空字符串。
function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  target[key] = typeof value === "string" ? redactFeedbackText(value) : value;
}

// created_at 缺失时用当前时间兜底，updated_at 再沿用 created_at：
// 保证“更新时间不早于创建时间”，否则列表排序会出现倒挂。
function mapCreatedTicket(
  ticket: FeedbackTicketSummaryResponse,
  input: CreateFeedbackTicketInput,
): FeedbackTicketDetail {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  const detail: FeedbackTicketDetail = {
    id: ticket.ticket_id,
    title: input.title,
    type: input.type,
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
    description: input.description,
    attachments: [],
    comments: [],
    events: [],
  };
  assignOptionalTicketFields(detail, {
    severity: input.severity,
    module: input.module,
    framework: input.framework,
    reporter: input.reporter ?? null,
    device: input.device ?? null,
  });
  return detail;
}

// 列表项没有 content，因此 type 恒为 bug（历史契约），真实类型只在详情里读；
// title 缺失时用 ticket_id 兜底，避免列表出现空标题、点击区域不可见。
function mapTicketSummary(ticket: FeedbackTicketSummaryResponse): FeedbackTicketSummary {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  return {
    id: ticket.ticket_id,
    title: readString(ticket.title) ?? ticket.ticket_id,
    type: "bug",
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
  };
}

// 详情等于摘要加 content/environment/messages 三段扩展；
// 先算一次 summary，既复用时间归一化，也保证列表与详情的时间字段完全一致。
function mapTicketDetail(ticket: FeedbackTicketDetailResponse): FeedbackTicketDetail {
  const summary = mapTicketSummary(ticket);
  const type = parseFeedbackTicketType(ticket.content?.category, summary.type);
// 类型与严重级分别解析：category 缺失时回落到列表契约的 bug，
// severity 缺失时保持 undefined，让 assignOptionalTicketFields 决定是否写入。
  const severity = parseFeedbackTicketSeverity(ticket.content?.severity);
  const device = environmentToDeviceInfo(ticket.environment);
// 消息 id 兜底用 index+1：后端漏回 message_id 时仍要保证同一页内 id 唯一，
// 否则 React 列表会复用错误节点，回复内容出现串行。
  const comments = (ticket.messages ?? []).map((message, index) =>
    mapMessageToComment(message, index + 1),
  );
  const detail: FeedbackTicketDetail = {
    ...summary,
    type,
    description: readString(ticket.content?.description) ?? "",
    attachments: (ticket.attachments ?? []).map((attachment, index) =>
      mapAttachment(attachment, index + 1),
    ),
    comments,
    events: buildDetailEvents(summary.created_at, comments),
  };
  assignOptionalTicketFields(detail, { severity, device });
  return detail;
}

// 可选字段用“存在性”而不是“真值”判断（reporter/device 允许 null）：
// 用 truthy 判断会把 null 当成“未提供”，丢失“该工单无反馈人”的语义。
function assignOptionalTicketFields(
  target: FeedbackTicketDetail,
  fields: {
    severity?: FeedbackTicketSeverity;
    module?: FeedbackTicketDetail["module"];
    framework?: FeedbackTicketFramework;
    reporter?: FeedbackTicketDetail["reporter"];
    device?: FeedbackDeviceInfo | null;
  },
): void {
  if (fields.severity) target.severity = fields.severity;
  if (fields.module) target.module = fields.module;
  if (fields.framework) target.framework = fields.framework;
  if (fields.reporter !== undefined) target.reporter = fields.reporter;
  if (fields.device !== undefined) target.device = fields.device;
}

// 事件流由创建事件加每条消息派生，不单独请求事件接口：
// id 用 index+2 保证稳定且不与创建事件（id=1）冲突，前端据此做增量合并
// 与 key；重复或跳号会让列表项闪烁。
function buildDetailEvents(createdAt: string, comments: FeedbackComment[]): FeedbackTicketEvent[] {
// 创建事件固定 id=1 且时间取 created_at：它是事件流的基准点，
// 后续消息事件都排在它之后，前端据此判断是否需要滚动到底部。
  const events: FeedbackTicketEvent[] = [
    {
      id: 1,
      type: "created",
      summary: "已提交",
      created_at: createdAt,
    },
  ];
  comments.forEach((comment, index) => {
    events.push({
      id: index + 2,
      type: comment.is_staff ? "staff_replied" : "user_replied",
      summary: comment.is_staff ? "客服已回复" : "用户补充了反馈",
      payload: { comment_id: comment.id },
      created_at: comment.created_at,
    });
  });
  return events;
}

// 数字 id 面向 UI，message_id 面向写操作，两者都必须保留（见函数内注释）。
function mapMessageToComment(
  message: FeedbackMessageResponse,
  fallbackId: number,
): FeedbackComment {
// sender_type 为空时按用户消息处理：宁可把客服回复显示在左侧，
// 也不要把用户消息误标成官方回复（后者会误导用户认为已有人跟进）。
  const senderType = readString(message.sender_type);
  return {
    id: toStableNumericId(message.message_id, fallbackId),
    // 补充消息附件必须使用原始 message_id 请求上传凭证，数字展示 id 不能反推后端 ID。
    message_id: message.message_id,
    body: readString(message.content?.text) ?? "",
    is_staff: senderType === "staff" || senderType === "admin",
    attachments: (message.attachments ?? []).map((attachment, index) =>
      mapAttachmentToCommentAttachment(attachment, index + 1),
    ),
    created_at: normalizeFeedbackTime(message.created_at),
  };
}

// 文件名与 content_type 都来自后端且可能为空：文件名依次回落到
// file_name、filename、"attachment"；kind 由后缀与 MIME 共同推断。
function mapAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackAttachment {
  const filename =
    readString(attachment.file_name) ?? readString(attachment.filename) ?? "attachment";
// content_type 缺失时保留 null：空串在 UI 上会被当作已知类型，
// 导致图片预览尝试失败后不回落，反而显示破图。
  const contentType = readString(attachment.content_type);
  return {
    id: toStableNumericId(attachment.attachment_id ?? attachment.id, fallbackId),
    kind: inferAttachmentKind(filename, contentType),
    filename,
    size: typeof attachment.size === "number" ? attachment.size : 0,
    redacted: false,
    content_type: contentType ?? null,
    download_url: readString(attachment.download_url) ?? null,
    preview_url: readString(attachment.preview_url) ?? null,
    created_at: normalizeFeedbackTime(attachment.created_at),
  };
}

// 评论附件是附件的子集：去掉 kind/redacted/created_at，
// 因为回复气泡只展示名字、大小与预览链接，多带字段会让缓存比较变复杂。
function mapAttachmentToCommentAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackCommentAttachment {
  const mapped = mapAttachment(attachment, fallbackId);
  return {
    id: mapped.id,
    filename: mapped.filename,
    size: mapped.size,
    content_type: mapped.content_type,
    download_url: mapped.download_url,
    preview_url: mapped.preview_url,
  };
}

// 先看 MIME 再看后缀：后端对 .zip 常回 application/octet-stream，
// 只看 MIME 会把日志包判成 other；只看后缀则会把无扩展名的图片判错。
// 这个顺序决定了 UI 能否预览，属于可见行为，不能随手调换。
function inferAttachmentKind(
  filename: string,
  contentType?: string | null,
): FeedbackAttachmentKind {
// MIME 判定放在最前：同一张图可能没有扩展名或后缀被改写过，
// 只要后端给出 image/* 就应走预览，不必再猜后缀。
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (/\.zip$/i.test(filename)) {
    return "log";
  }
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(filename)) {
    return "image";
  }
  return "other";
}

// [权衡] 状态收敛为“已提交/已归档”两态：后端仍有 submitted/待评估/已提交
// 等中间态，前端只区分“处理中”与“已结束”。新增枚举值会落入 default
// 而不是显示空白，保证老客户端不会因后端加状态而崩。
function mapFeedbackStatus(status: unknown): FeedbackTicketStatus {
  switch (readString(status)) {
    case "closed":
    case "已归档":
      return "已归档";
    case "submitted":
    // 兼容后端或历史缓存里仍返回旧中文状态的工单。
    case "待评估":
    case "已提交":
    default:
      return "已提交";
  }
}

// 类型只接受四个已知值，其余回落到 fallback 而不是原样透传：
// 共享类型的联合类型一旦被未知字符串污染，下游 switch 会漏分支。
function parseFeedbackTicketType(value: unknown, fallback: FeedbackTicketType): FeedbackTicketType {
  switch (readString(value)) {
    case "usage":
      return "usage";
    case "feature":
      return "feature";
    case "performance":
      return "performance";
    case "bug":
      return "bug";
    default:
      return fallback;
  }
}

// 严重级只有三档，未知值返回 undefined（字段不出现），
// 而不是猜测成 P3，避免把线上崩溃级别的工单误降级。
function parseFeedbackTicketSeverity(value: unknown): FeedbackTicketSeverity | undefined {
  switch (readString(value)) {
    case "P1-高":
      return "P1-高";
    case "P2-中":
      return "P2-中";
    case "P3-低":
      return "P3-低";
    default:
      return undefined;
  }
}

// 详情里的 environment 是 Record<string, unknown>，不能直接当 FeedbackDeviceInfo 用；
// 这里逐键收窄：类型不符或空串一律丢弃，最终无有效字段时返回 null。
function environmentToDeviceInfo(
  environment: Record<string, unknown> | null | undefined,
): FeedbackDeviceInfo | null {
  if (!environment) {
    return null;
  }
// 只填非空字符串字段：空对象返回 null，让 UI 能区分“未上报环境”与“环境全空”。
  const device: FeedbackDeviceInfo = {};
  assignDeviceString(device, "appVersion", environment.app_version);
  assignDeviceString(device, "buildCommitId", environment.build_commit_id);
  assignDeviceString(device, "buildTime", environment.build_time);
  assignDeviceString(device, "electronVersion", environment.electron_version);
  assignDeviceString(device, "nodeVersion", environment.node_version);
  assignDeviceString(device, "osType", environment.os_type);
  assignDeviceString(device, "osPlatform", environment.os_platform ?? environment.os_category);
  assignDeviceString(device, "osRelease", environment.os_release);
  assignDeviceString(device, "osVersion", environment.os_version);
  assignDeviceString(device, "osArch", environment.os_arch);
  assignDeviceString(device, "agentProvider", environment.agent_provider);
  assignDeviceString(device, "agentFramework", environment.agent_framework);
  assignDeviceString(device, "agentModel", environment.agent_model);
  assignDeviceString(device, "agentModelDisplay", environment.agent_model_display);
// 数量字段只在 number 时采用：后端有时回字符串数字，
// 这里不做宽松转换，避免把 "abc" 转成 NaN 后污染统计。
  const optionCount = environment.agent_model_option_count;
  if (typeof optionCount === "number") {
    device.agentModelOptionCount = optionCount;
  }
// 模型候选列表是唯一允许的数组字段，且必须逐项过滤成 string：
// 直接透传会让任意 JSON 进入 UI 渲染，既可能报错也可能注入异常内容。
  const preview = environment.agent_model_options_preview;
  if (Array.isArray(preview)) {
    device.agentModelOptionsPreview = preview.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return Object.keys(device).length > 0 ? device : null;
}

// 只在有值时才赋值，避免把 undefined 写进对象后 JSON 序列化丢字段的差异。
function assignDeviceString(
  target: FeedbackDeviceInfo,
  key: keyof FeedbackDeviceInfo,
  value: unknown,
): void {
  const stringValue = readString(value);
  if (stringValue) {
    (target as Record<string, unknown>)[key] = stringValue;
  }
}

// 后端时间有三种形态：秒级 number、秒级数字字符串、ISO 字符串。
// 秒必须乘 1000，否则会被当成 1970 年附近；无时区的 ISO 串补 "Z"，
// 否则前端按本地时区解释，东八区显示会比实际早 8 小时。
// 所有分支都必须返回字符串，不允许抛错：时间脏数据不应让详情整体失败。
function normalizeFeedbackTime(
  value: number | string | null | undefined,
  fallback?: string,
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const stringValue = readString(value);
  if (!stringValue) {
    return fallback ?? new Date().toISOString();
  }
// 纯数字串按秒处理：后端存在把时间戳序列化成字符串的版本，
// 若按 ISO 解析会得到 Invalid Date，最终显示空时间而不是报错。
  if (/^\d+$/.test(stringValue)) {
    return new Date(Number(stringValue) * 1000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(stringValue) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(stringValue)) {
    return `${stringValue}Z`;
  }
  return stringValue;
}

// [权衡] 后端主键是字符串，但共享类型要求 number（key、排序、持久化都按数字）。
// 用 31 乘法哈希压成 uint32，保证同一条消息每次刷新得到同一个 id；
// 若改用自增下标，分页或删除后会错位，导致回复挂到错误的消息上。
// 哈希冲突概率极低但非零，故保留 fallbackId；哈希结果为 0 也要回落。
function toStableNumericId(value: unknown, fallbackId: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = readString(value);
  if (!text) {
    return fallbackId;
  }
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash || fallbackId;
}

// trim 后为空视为不存在：后端常用 "" 表示 null，两种都要归一成 undefined。
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 数组也是 object，必须显式排除：否则 [] 会被当成信封或 environment。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 只重试“建连阶段”失败（DNS/TLS/ECONNREFUSED，见 networkErrorClassifier）。
// 不重试请求已发出后超时的情况：反馈创建与上传都不是幂等接口，
// 重放可能产生重复工单或重复附件。
// 退避 300ms 起线性增长，总时长不到 1s，避免把 UI 加载态拖长。
async function requestWithHandshakeRetry(
  request: () => Promise<Response>,
  onRetry?: (event: { attempt: number; nextAttempt: number; error: unknown }) => void,
): Promise<Response> {
  let lastError: unknown;
// attempt 从 1 开始、上限写死 3：与调用方日志里的 maxAttempts 同源，
// 改这里必须同步改那边的字段，否则排障时数字对不上。
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request();
    } catch (error) {
// 每轮都覆盖 lastError：最终抛出的是“最后一次”错误，
// 它的 errorCodes 才代表当前网络真实状态（可能已从 TLS 失败变成 DNS 失败）。
      lastError = error;
      // Cloudflare/本机代理链路偶发 TLS 握手或 Undici 建连阶段失败。
      // 请求还没稳定到达后端时允许多次短重试；即使请求已收口到 ApiClient，
      // 这里仍保留反馈接口自己的轻量重试，避免“我的反馈”等轻量请求直接显示 fetch failed。
// [失败路径] 不可重试的错误立即 break 而不是继续等退避：
// 证书校验失败、4xx 之类重试也不会成功，早点返回才能让用户看到真实原因。
      if (attempt >= 3 || !isRetryableConnectionEstablishmentError(error)) {
        break;
      }
      onRetry?.({ attempt, nextAttempt: attempt + 1, error });
      await delay(300 * attempt);
    }
  }
  throw lastError;
}

// 独立的 delay 便于测试替换定时器，也避免重试逻辑里散落 setTimeout。
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// OSS PostObject 直传：后端只发凭证，文件不经过业务服务。
// 因此这里用 node:http(s) 原生请求而不是 ApiClient——目标 host 是 OSS 域名，
// 不能带业务鉴权头，也不该走 ApiClient 的基址与拦截器。
// 请求体是 multipart/form-data，必须手算 Content-Length（见 INV-06）。
async function uploadOssForm(
  credential: FeedbackUploadCredentialResponse,
  filePath: string,
  filename: string,
  contentType: string,
  options: {
    size: number;
    onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
// [资源] 手工构造 Promise 是因为需要同时持有 stream、req、signal 三者，
// 并在任一失败路径上统一销毁；async 函数无法在 reject 后阻止 stream 继续读文件。
  return new Promise((resolve, reject) => {
    const uploadUrl = new URL(credential.oss.host);
    const requestImpl = uploadUrl.protocol === "https:" ? httpsRequest : httpRequest;
// boundary 带随机 UUID：同进程并发上传多个附件时，固定 boundary 会让不同
// 请求的表单体按同一分隔符切分，OSS 侧解析出混入的字段。
    const boundary = `----zcode-feedback-${randomUUID()}`;
// 字段与文件头都预编码成 Buffer：Content-Length 需要精确字节数，
// 边写边算会让长度与实际发送量出现偏差。
    const fields = buildOssFormFields(credential);
    const fieldBuffers = fields.map(([name, value]) => createMultipartField(boundary, name, value));
    const fileHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(filename)}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
// [权衡] Content-Length 必须先算后发：OSS 要求精确值，chunked 传输会被拒绝；
// 因此字段头、文件头、closing 都按 byteLength 累加，不能用字符长度。
    const contentLength =
      fieldBuffers.reduce((total, buffer) => total + buffer.byteLength, 0) +
      fileHeader.byteLength +
      options.size +
      closing.byteLength;
// settled 是单次 settle 闸门：成功、失败、取消三条路径都会争用，
// 谁先置 true 谁负责结束 Promise，其余路径直接返回。
    let uploadedBytes = 0;
    let settled = false;
    let stream: ReturnType<typeof createReadStream> | null = null;

    if (options.signal?.aborted) {
      reject(new FeedbackUploadCanceledError());
      return;
    }

// 进入 Promise 后再查一次 aborted：从 uploadFile 走到这里之间可能已经取消，
// 此时不能创建请求，否则取消信号再没有机会触发。
// 按凭证 host 的协议选实现：OSS 可能是 http（内网/测试环境），
// 一律用 https 会在测试环境直接 ECONNRESET，错误信息还很难懂。
    const req = requestImpl(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(contentLength),
        },
      },
      (response) => {
// 响应体只在失败时读取并拼进错误信息：OSS 的错误描述在 XML body 里，
// 只报 "HTTP 403" 无法区分是签名过期还是 policy 不匹配。
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
// 用 end 而不是首个 data 判定完成：响应可能分多个 chunk，
// 提前 resolve 会让上层在 body 还没读完时就认为上传成功。
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const statusCode = response.statusCode ?? 0;
// 严格 2xx 才算成功：OSS 在 policy 校验失败时可能返回 400 但 body 像回调，
// 只看 body 会误判成功，最终附件在服务端缺失。
          if (statusCode < 200 || statusCode >= 300) {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`OSS upload failed: HTTP ${statusCode}${body ? `: ${body}` : ""}`));
            return;
          }
          options.onUploadProgress?.({
            uploadedBytes: options.size,
            totalBytes: options.size,
          });
          resolve();
        });
      },
    );

// [资源] 取消时必须同时 destroy stream 与 req：
// 只 destroy req 会让 createReadStream 继续持有文件句柄直到垃圾回收，
// 在 Windows 上表现为文件无法删除或重命名。
// 先置 settled 再销毁，防止 destroy 触发的 error 事件再次 reject。
    const abortUpload = () => {
      if (settled) return;
      settled = true;
      const error = new FeedbackUploadCanceledError();
      stream?.destroy(error);
      req.destroy(error);
      reject(error);
    };
// once: true 保证监听器自动移除；signal 可能比请求活得久，
// 不移除会让已结束的 Promise 被反复回调，也会拖住 signal 的持有者。
    options.signal?.addEventListener("abort", abortUpload, { once: true });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(options.signal?.aborted ? new FeedbackUploadCanceledError() : error);
    });

// 先写所有表单字段再写文件：OSS 只认 file 之后的收尾 boundary，
// 顺序错乱会让 OSS 把文件内容当成普通字段解析失败。
    for (const buffer of fieldBuffers) {
      req.write(buffer);
    }
    req.write(fileHeader);

// 流式读取而不是 readFile：日志包可达 1GB，整读会 OOM，
// 也无法在传输中做进度上报与背压控制。
    stream = createReadStream(filePath);
// [资源] 背压处理：收到 chunk 先 pause，写完后 resume；
// req.write 返回 false 时等 drain 再继续。
// 不做背压会让 1GB 文件整个堆进 req 的内部缓冲，等于变相整读。
    stream.on("data", (chunk) => {
      stream?.pause();
      uploadedBytes += Buffer.byteLength(chunk);
      // 这里按文件内容进度上报，不把 multipart 表单头尾计入用户可见进度。
      options.onUploadProgress?.({
        uploadedBytes: Math.min(uploadedBytes, options.size),
        totalBytes: options.size,
      });
      const canContinue = req.write(chunk, () => {
        if (stream && !stream.destroyed) {
          stream.resume();
        }
      });
      if (!canContinue) {
        req.once("drain", () => {
          if (stream && !stream.destroyed) {
            stream.resume();
          }
        });
      }
    });
// 文件读到一半出错（被占用、被删除）必须销毁请求：
// 否则 req 永远等不到 end，Promise 不 settle，UI 卡在 99%。
    stream.on("error", (error) => {
      req.destroy(error);
    });
// 只有文件读完才写收尾 boundary 并 end：提前 end 会截断文件，
// OSS 校验长度不符后返回 400，且已在传输的数据全部作废。
    stream.on("end", () => {
      req.write(closing);
      req.end();
    });
  });
}

// callback 字段是 OSS 回调业务服务的“授权书”，必须整体 JSON 后 base64：
// 它决定附件落库时的 ticket_id/message_id，拼错会让附件挂到错误工单。
// 末尾过滤空值字段：OSS 对空字符串字段会报签名不匹配。
function buildOssFormFields(credential: FeedbackUploadCredentialResponse): Array<[string, string]> {
  const encodedCallback = Buffer.from(
    JSON.stringify({
      callbackUrl: credential.callback.url,
      callbackBody: credential.callback.body,
      callbackBodyType: credential.callback.content_type,
    }),
    "utf-8",
  ).toString("base64");
  const fields: Array<[string, string]> = [
    ["key", credential.oss.path],
    ["policy", credential.oss.policy],
    ["x-oss-signature", credential.oss.x_oss_signature],
    ["x-oss-signature-version", credential.oss.x_oss_signature_version],
    ["x-oss-credential", credential.oss.x_oss_credential],
    ["x-oss-security-token", credential.oss.x_oss_security_token],
    ["x-oss-date", credential.oss.x_oss_date],
    ["callback", encodedCallback],
    ["success_action_status", "200"],
  ];
  return fields.filter(([, value]) => value);
}

// 普通字段的 Content-Disposition 必须带 name 且不带 filename：
// 带 filename 会让 OSS 按文件处理，导致 policy 中的字段校验缺失。
function createMultipartField(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n` +
      `${value}\r\n`,
  );
}

// 引号与换行在 multipart 头里是结构字符，必须替换：
// 文件名带 CRLF 可注入额外表单字段，让上传内容脱离预期。
function escapeMultipartValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
