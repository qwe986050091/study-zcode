/* oxlint-disable eslint(max-lines) -- 一个端点一个方法 + 统一的鉴权/脱敏/错误归一化 requestData，拆分会让 HTTP 契约失去单一入口。 */
import {
  conversationShareArtifactDescriptorSchema,
  conversationShareArtifactUploadDataSchema,
  conversationShareCapabilitiesWireSchema,
  narrowConversationShareCapabilities,
  conversationShareConfirmDataSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationDataSchema,
  conversationShareContinuationRequestSchema,
  conversationShareErrorEnvelopeSchema,
  classifyConversationShareError,
  conversationSharePreparationDataSchema,
  conversationSharePreparationRequestSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  type ApiClient,
  type ApiRequestInit,
  type ConversationShareErrorKind,
  type ConversationShareRejection,
  type ConversationShareArtifactDescriptor,
  type ConversationShareArtifactUpload,
  type ConversationShareCapabilities,
  type ConversationShareConfirmRequest,
  type ConversationShareContinuation,
  type ConversationShareContinuationRequest,
  type ConversationSharePreparation,
  type ConversationSharePreparationRequest,
  type ConversationSharePreview,
  type ConversationShareRecord,
} from "@zcode/shared";
import { z } from "zod";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { REQUEST_ID_HEADER_NAME, withRequestIdHeader } from "../providers/api/requestIdHeaders.js";
import { verifyConversationShareIntegrity } from "./conversationShareIntegrity.js";

// 分享后端的 HTTP 客户端：六个端点共用一条 requestData 管道，负责鉴权、超时、错误归一化。
// 单一入口是刻意的：脱敏日志、request id 对账、错误分类三件事只要漏一处就会造成线上不可诊断。
// INV-01：任何错误都必须落成 ConversationShareClientError，不允许裸 Error 逃逸（守住它：requestData 的每个 catch）。
// INV-02：日志里不得出现 token、descriptor、文件名、路径、正文；只允许公开 ID、状态码、字节数（守住它：日志字段白名单）。
// INV-03：response.text() 之后的失败仍必须带上 status 与 requestId，否则状态码与对账线索会丢（守住它：body 读取的 catch）。
// INV-04：continuation 的完整性校验必须针对服务端原始 JSON，而不是 zod 解析后的对象（守住它：verifyConversationShareIntegrity 入参）。
// 改错后果：用户看到「未知错误 / HTTP 4xx」而无法自助排查，或日志把本地文件名写进远端可检索的日志系统。
// [权衡] 一个端点一个方法而不是泛化 resource 客户端：每端点的 schema 与鉴权模式不同，
// 泛化会把差异塞进参数表，读代码时反而看不出「这个接口到底要不要登录」。
const log = createServiceLogger("conversation-share-http");

export type ConversationShareClientErrorKind = ConversationShareErrorKind;

// 客户端错误类型：kind 决定 UI 分支，details 决定 Renderer 能看到哪些诊断。
// retryAfterMs 用 declare 而非字段初始化，是为了让它不出现在类字段枚举里（避免被序列化进 RPC）。
// [失败路径] 早期实现把 rejection 原样挂到实例上，导致未脱敏的服务端消息直接进 UI；
// 现在只通过 details 暴露，且 details 只装结构化字段。
export class ConversationShareClientError extends Error {
// kind 与 status/code 一起构成「可判定的失败原因」；UI 只读 kind 决定文案与是否可重试。
  readonly kind: ConversationShareClientErrorKind;
  readonly status?: number;
  readonly code?: number;
  /** 服务端响应的请求 ID，用于和后端日志对账。 */
  readonly requestId?: string;
  /** 复用现有 RPC details 字段，把安全诊断信息传到 Renderer。 */
  readonly details?: {
    requestId?: string;
    clientRequestId?: string;
    status?: number;
    code?: number;
    rejection?: ConversationShareRejection;
  };
  declare readonly retryAfterMs?: number;

// 构造函数里做两件校验：requestId 必须匹配安全字符集，clientRequestId 走同一套规范化。
// 只要有一项诊断信息存在就构造 details，否则保持 undefined，避免上游误以为「有诊断」。
// [权衡] status/code 用展开而非直接赋值：undefined 会被展开成 key，
// 在此用条件展开把「未提供」和「值为 0」区分开。
  constructor(options: {
    kind: ConversationShareClientErrorKind;
    message: string;
    status?: number;
    code?: number;
    rejection?: ConversationShareRejection;
    retryAfterMs?: number;
    requestId?: string;
    clientRequestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationShareClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
// 长度上限 128 与字符白名单是防御性的：requestId 会进日志和 UI，
// 放任任意字符串等于允许注入日志行或撑爆展示。
    const requestId = options.requestId?.trim();
// 不合法就静默丢弃而不是抛错：诊断字段缺失不应让一次业务失败变成「构造错误时崩了」。
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
// 客户端 id 来自请求头，可能被中间层改写，因此同样走规范化，保证与服务端回显可比。
    const clientRequestId = normalizeRequestId(options.clientRequestId);
    if (
      this.requestId ||
      clientRequestId ||
      options.status !== undefined ||
      options.code !== undefined
    ) {
// details 只在确有诊断信息时创建：空对象会让上层误判「本次失败带诊断」，进而在 UI 上展示空面板。
      this.details = {
        ...(this.requestId ? { requestId: this.requestId } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.code === undefined ? {} : { code: options.code }),
        ...(options.rejection ? { rejection: options.rejection } : {}),
      };
    }
// 只有显式给出才赋值；retryAfterMs 为 0 是合法的「立即可重试」，不能被 falsy 判断吃掉。
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

// 三种 HTTP-date 格式的分词级正则：只用来「形状预筛」，真正的合法性由回格式化比对确认，
// 因为 Date.parse 会宽松接受 31 Feb 这类不存在的日期并静默归一化到 3 月。
// 预筛先挡掉明显不是日期的值，避免每个响应都做一次 Date.parse。
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const RFC_850_DATE_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/u;
// 回格式化需要完整的英文星期/月份表：Intl 输出受 locale 影响，不能用于协议级比较。
const HTTP_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const HTTP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

// 固定用 UTC 并两位补零：HTTP-date 规范要求 GMT，本地时区参与会直接比不相等。
function formatHttpTime(date: Date): string {
// 手工补零而不是 toISOString 切片：后者带毫秒与时区后缀，与 HTTP-date 的形状不一致。
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

// [失败路径] 校验方式是「解析后再格式化回原串并比较」，而不是信任 Date.parse：
// 解析成功但回格式化不同，说明原串不是规范日期（多余空格、错误星期、非法日），一律拒绝。
// IMF-fixdate 用 toUTCString 精确比对；另两种格式的标准表示法不同，需要手工拼装。
function parseHttpDate(value: string): number | undefined {
  if (IMF_FIXDATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value
      ? timestamp
      : undefined;
  }
// RFC 850 的两位年份由 Date.parse 按 50 年窗口推断，回格式化时取回同一位数才能比对。
  if (RFC_850_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${HTTP_WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")}-${HTTP_MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)} ${formatHttpTime(date)} GMT`;
    return canonical === value ? timestamp : undefined;
  }
// asctime 没有时区标记，补 GMT 再解析；日期位用空格而不是零填充，回格式化必须照做。
  if (ASCTIME_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(`${value} GMT`);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${date.toUTCString().slice(0, 3)} ${HTTP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${formatHttpTime(date)} ${date.getUTCFullYear()}`;
    return canonical === value ? timestamp : undefined;
  }
  return undefined;
}

// Retry-After 有两种语义：秒数（相对）与 HTTP-date（绝对），这里统一折算成相对毫秒。
// 过去时间与 0 都返回 undefined：调用方据此走默认退避，而不是「立即重试」。
// Number.isSafeInteger 防止超大秒数乘 1000 后溢出成 Infinity。
function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : undefined;
  }
  // Date.parse 会接受 ISO/本地化日期并归一化不存在的日期；先按 HTTP-date 语法严格校验。
// 非纯数字一律当 HTTP-date 处理；解析失败返回 undefined，让调用方走默认退避。
  const retryAt = parseHttpDate(normalized);
  if (retryAt === undefined) return undefined;
  const delayMs = retryAt - now;
  return delayMs > 0 ? delayMs : undefined;
}

// 全局默认超时只用于轻量端点；两个例外（confirm / upload）各自有理由，见下面常量注释。
const DEFAULT_TIMEOUT_MS = 30_000;
// confirm 期间服务端同步跑安全检查，单次请求会被挂住远超 30s（实测 50s+ 被 abort）。只放宽这一个
// 端点：全局抬到 2min 会让断网时的能力发现也僵 2min。与 confirmUntilReady 的轮询超时无关——
// 后者管的是服务端已返回 pending 之后的重试窗口，救不了请求本身。
const CONFIRM_TIMEOUT_MS = 120_000;
// uploadArtifact 不能沿用 30s 默认超时——confirm 单请求会被挂 50s+，更大的
// artifact 在慢速上行上必然超时，且上传无自动重试，超时即整个发布失败。按体积动态放宽：
// 30s 建连/服务端处理余量 + 保底 128KB/s 上行带宽，下限仍是全局默认超时（小文件不被缩短）。
// 上传超时按体积线性放宽：保底 128KB/s 的上行假设下，文件越大给的时间越长。
// 下限用传入的全局超时而不是 0，保证小文件不会因为公式过小而比其它接口更早失败。
const UPLOAD_TIMEOUT_BASE_MS = 30_000;
const UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC = 128 * 1024;

// 用 ceil 而不是 floor：不足 1 秒的传输余量也要给满，否则临界大小会随机超时。
// 结果单位是毫秒，所以带宽部分的秒数要乘 1000。
function computeUploadTimeoutMs(fileSizeBytes: number, floorMs: number): number {
  return Math.max(
    floorMs,
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(fileSizeBytes / UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC) * 1_000,
  );
}

// 同一个规范化函数同时用于「自己生成的 id」和「服务端返回的 id」，
// 保证两侧比较时不会因为大小写空白差异判定为不同请求。
function normalizeRequestId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

// tokenProvider 是函数而不是字符串：桌面端 token 会刷新，签名时必须每次取最新值。
export interface ConversationShareHttpClientOptions {
  apiClient: ApiClient;
  baseUrl: string;
  tokenProvider: () => Promise<string | null>;
  timeoutMs?: number;
  /** confirm 单次请求超时；缺省 2min。 */
  confirmTimeoutMs?: number;
}

// 两侧都去掉多余斜杠，避免 baseUrl 以 / 结尾或 path 以 / 开头时拼出双斜杠。
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

// 单独抽出是为了让调用点的 try 范围精确到「解析」这一步，不把后续 schema 校验混进去。
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

// 依赖全部由构造注入：apiClient 由宿主提供，baseUrl 与 tokenProvider 决定请求去向，
// 因此在测试与远端 Host facade 下可以完全不改业务代码地替换传输层。
export class ConversationShareHttpClient {
// 字段是 readonly 的：客户端实例可能在多轮发布间复用，运行期换 apiClient 会让连接身份错乱。
  private readonly apiClient: ApiClient;
// baseUrl 与 tokenProvider 来自宿主配置，本层不读全局配置：同一进程可能存在多个后端环境。
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly timeoutMs: number;
  private readonly confirmTimeoutMs: number;

// 超时在构造时定死，运行期不可变：中途改超时会让同一 operation 的多次请求行为不一致。
  constructor(options: ConversationShareHttpClientOptions) {
    this.apiClient = options.apiClient;
    this.baseUrl = options.baseUrl;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  }

// 能力发现必须登录，因为它反映「当前账号能分享什么」。
// 返回值经过 narrow 裁剪：服务端新增的类型在这里被去掉并记日志，而不是抛错，
// 这样老客户端在服务端升级后仍能继续分享已支持的类型。
  async getCapabilities(): Promise<ConversationShareCapabilities> {
    const wire = await this.requestData(
// 能力接口用 required 鉴权：它回答「你能分享什么」，匿名调用没有意义。
      "/shares/capabilities",
      { method: "GET" },
      conversationShareCapabilitiesWireSchema,
      "required",
    );
// 分开记录 `unsupportedArtifactTypes` 与 `unsupportedAccessModes`：前者决定哪些卡片能分享，后者决定谁能打开。
// 合并成单条 `log.info` 会让日志无法回答「缺哪一项能力」。
    const { capabilities, unsupportedArtifactTypes, unsupportedAccessModes } =
      narrowConversationShareCapabilities(wire);
    if (unsupportedArtifactTypes.length > 0 || unsupportedAccessModes.length > 0) {
      // 后端新增结果物类型/访问模式时留一条可检索的记录：能力发现不再被打死，
      // 但需要知道该补哪一种。
// 记 supportedCount 而不是完整能力：让日志能一眼看出「丢了几项」与「还剩几项」。
      log.info(undefined, "conversation share capabilities dropped unsupported values", {
        types: unsupportedArtifactTypes,
        accessModes: unsupportedAccessModes,
        supportedCount: capabilities.allowed_artifacts.length,
      });
    }
    return capabilities;
  }

// 准备阶段先落一条服务端草稿：返回 id 与过期时间，后续上传与 confirm 都以它为主键。
  createPreparation(
    input: ConversationSharePreparationRequest,
  ): Promise<ConversationSharePreparation> {
// 出站前先本地 parse：把「调用方传错」挡在发请求之前，错误信息也能指到具体字段。
    const body = conversationSharePreparationRequestSchema.parse(input);
    return this.requestData(
// 准备接口返回 preparationId：后续 upload/confirm 都以它拼路径，服务端据此串起一次发布。
      "/shares/preparations",
      this.jsonRequest("POST", body),
      conversationSharePreparationDataSchema,
      "required",
    );
  }

// 产物上传走 multipart：descriptor 作为 JSON 表单字段，file 作为文件字段，
// 这样服务端可以流式接收文件而不必先解析 base64。
  uploadArtifact(
    preparationId: string,
    descriptor: ConversationShareArtifactDescriptor,
    file: Blob,
  ): Promise<ConversationShareArtifactUpload> {
// parse 之后再序列化：既校验必填字段，也剥离调用方可能带上的多余键。
    const parsedDescriptor = conversationShareArtifactDescriptorSchema.parse(descriptor);
    // 安全边界：只记录公开 ID、类型与字节数，不记录 descriptor、文件名、路径、正文或鉴权头。
// debug 级别而不是 info：上传是高频事件，info 会在正常分享时刷屏；
// 但字段仍严守安全边界，避免有人为了排障临时调高级别导致泄漏。
    log.debug(undefined, "conversation share artifact upload prepared", {
      preparationId,
      artifactId: parsedDescriptor.artifact_id,
      artifactType: parsedDescriptor.artifact_type,
      fileSizeBytes: file.size,
    });
// 文件名用 display_name：服务端会据此推导扩展名，这是唯一可信的类型线索。
// Blob 直接 append，不读进内存：大文件由底层流式发送。
    const form = new FormData();
// descriptor 必须是 JSON 字符串而不是逐字段 append：字段结构会随能力演进，
// 展开成多个表单项会让服务端表单 schema 与协议版本强耦合。
    form.append("descriptor", JSON.stringify(parsedDescriptor));
// 显式传文件名：不传时浏览器/Node 会生成 blob 之类的默认名，服务端就无法推断扩展名。
    form.append("file", file, parsedDescriptor.display_name);
    return this.requestData(
// 路径段必须 encode：preparationId 由服务端生成，但契约上仍是不可信输入，
// 未编码时含 / 或 .. 的 id 会改变实际请求路径。
      `/shares/preparations/${encodeURIComponent(preparationId)}/artifacts`,
      { method: "POST", body: form },
      conversationShareArtifactUploadDataSchema,
      "required",
      computeUploadTimeoutMs(file.size, this.timeoutMs),
    );
  }

// confirm 携带三个摘要与投影：一旦返回就代表内容定稿，服务端据此生成分享页。
  confirm(
    preparationId: string,
    input: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    const body = conversationShareConfirmRequestSchema.parse(input);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/confirm`,
      this.jsonRequest("POST", body),
      conversationShareConfirmDataSchema,
      "required",
      this.confirmTimeoutMs,
    );
  }

// 预览以 shareCode 为唯一凭据，因此鉴权用 optional：公开预览链接在未登录时也应能看。
// 先校验 schema_version 再解码行：版本过新时逐行降级会掩盖「整体结构已变」这个事实。
  async getPreview(shareCode: string): Promise<ConversationSharePreview> {
    const wire = await this.requestData(
// shareCode 直接来自 URL，属于典型不可信输入，必须编码后再拼路径。
      `/shares/${encodeURIComponent(shareCode)}/preview`,
      { method: "GET" },
      conversationSharePreviewDataSchema,
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "preview");
// unsupportedRowCount 单独回传，让预览页可以显示「有 N 条内容需要更新客户端才能查看」。
    const decoded = this.decodeRows(wire.rows, "preview");
    return { ...wire, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }

// continuation 返回的是「完整可导入内容」，比 preview 多原样 rows 与 artifacts，
// 因此它是完整性校验的唯一入口。
  async getContinuation(
    shareCode: string,
    input: ConversationShareContinuationRequest,
  ): Promise<ConversationShareContinuation> {
    const body = conversationShareContinuationRequestSchema.parse(input);
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/continuation`,
      this.jsonRequest("POST", body),
      conversationShareContinuationDataSchema,
      // public_importable 分享的 continuation 由 share code + client request id 授权，
      // 不应因为 ZCode 本地没有登录态而在请求发出前被客户端拦截。
      "optional",
    );
// 版本检查放在完整性校验之前：新版结构可能改动了摘要算法，先报「请升级」比报「被篡改」准确。
    this.assertSupportedSchemaVersion(wire.schema_version, "continuation");
    // 完整性对服务端原样发来的值校验，不对解析产物——否则发布端加一个 optional 字段就会
    // 让所有老客户端算出不同的哈希（详见 verifyConversationShareIntegrity 的注释）。
    if (
      !verifyConversationShareIntegrity({
        rawRows: wire.rows,
        rawContentBlocks: wire.content_blocks,
        rawArtifacts: wire.artifacts,
        integrity: wire.integrity,
      })
    ) {
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share integrity check failed",
      });
    }
// 返回值同时保留 rawRows：导入侧要用原始 JSON 复算摘要，而不能用解码后的行。
    const decoded = this.decodeRows(wire.rows, "continuation");
    return {
      ...wire,
      rows: decoded.rows,
      rawRows: wire.rows,
// rawRows 与 rows 并存是有意为之：rows 给 UI 渲染，rawRows 给完整性/重放；
// unsupportedRowCount 让导入侧知道「有内容没被渲染」，避免把缺内容误判成完整导入。
      unsupportedRowCount: decoded.unsupportedCount,
    };
  }

  /**
   * 版本高于本端认知时不猜语义，也不混进 invalid_contract：用户该看到「请升级 ZCode」，
   * 不是「分享格式无效」。低于或等于本端版本一律继续——新增 kind/enum 由逐行降级消化。
   */
// 只拦截「高于本端」的版本：低版本由逐行解码降级处理，因为新客户端必须能读旧分享。
  private assertSupportedSchemaVersion(version: number, endpoint: string): void {
// 支持判定只看版本号，不看具体结构：这样才能在服务端新增可选字段时保持向前兼容。
    if (isConversationShareSchemaVersionSupported(version)) return;
    log.warn(undefined, "conversation share payload schema version is newer than this client", {
      endpoint,
      version,
    });
    throw new ConversationShareClientError({
      kind: "unsupported_schema_version",
      message: "Conversation share payload requires a newer ZCode version",
    });
  }

// 解码失败的行走降级并计数，而不是整体失败：一条未知 kind 不该让整份分享打不开。
// 必须留日志，否则用户只看到「内容变少了」而运维无从得知是新 kind。
  private decodeRows(
    rows: readonly unknown[],
    endpoint: string,
  ): ReturnType<typeof decodeConversationShareRows> {
// 解码器按 kind 逐行解析，单行失败不会连带整份失败；这里只负责把降级结果抛成日志。
    const decoded = decodeConversationShareRows(rows);
// 只有确实丢了行才记日志：每次预览都打一条 info 会把有用信息淹没。
    if (decoded.unsupportedCount > 0) {
      // 不静默：认不出的行会从展示里消失，必须留一条可检索的记录说明该补哪种 row。
      log.info(undefined, "conversation share dropped rows this client cannot render", {
        endpoint,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return decoded;
  }

// 只支持 POST：所有写端点都是 POST，GET 端点直接传 { method }，无需这个辅助。
  private jsonRequest(method: "POST", body: unknown): ApiRequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

// 全链路唯一出口：鉴权 → 注入 request id → 发请求 → 读体 → 错误分类 → schema 解析。
// timeoutMsOverride 只给两个大端点用，其余走全局超时，避免个别端点拖住整条链路。
  private async requestData<T>(
    path: string,
    init: ApiRequestInit,
    dataSchema: z.ZodType<T>,
    auth: "required" | "optional",
    timeoutMsOverride?: number,
  ): Promise<T> {
// 空串归一为 null：某些平台返回 "" 表示未登录，若按 truthy 判断会带上空 Bearer 头。
// required 但无 token 时在本地就返回 401，不发请求——省一次往返，也让错误原因明确。
    const token = (await this.tokenProvider())?.trim() || null;
// 本地先抛 401 而不是发一个必然被拒的请求：省往返，也让错误归因明确（不是网络问题）。
    if (auth === "required" && !token) {
      throw new ConversationShareClientError({
        kind: "authentication_required",
        message: "Conversation share authentication required",
        status: 401,
      });
    }

    // ApiClient 会兜底注入 request id；在这里先生成并保留同一个值，确保非标准 ApiClient
    //（例如远端 Host facade 或测试替身）也能把请求 ID 和服务端响应关联起来。
// 先取回 request id 再发请求：这样即使传输层在拿到响应前抛错，也能把客户端 id 写进错误，
// 服务端日志若收到了这个头就能对上号。
    const headers = withRequestIdHeader(init.headers);
// optional 端点在未登录时不带鉴权头，而不是带空 Bearer：后者会被网关判成无效凭证。
    if (token) headers.set("Authorization", `Bearer ${token}`);
// baseUrl 在构造时确定，这里只做拼接，避免每个端点各自处理斜杠差异。
    const url = joinUrl(this.baseUrl, path);
    const clientRequestId = normalizeRequestId(headers.get(REQUEST_ID_HEADER_NAME));
// 请求阶段的异常统一归为 network：这里还没拿到任何服务端语义，不能猜成契约错误。
    let response: Response;
    try {
      response = await this.apiClient.request(url, {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        timeoutMs: timeoutMsOverride ?? this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "network",
        message: error instanceof Error ? error.message : "Conversation share network error",
        cause: error,
      });
    }

// 优先用响应头里的 id（服务端可能改写），没有才回落到自己生成的 clientRequestId。
    const responseRequestId = normalizeRequestId(response.headers.get(REQUEST_ID_HEADER_NAME));
// [失败路径] 拿到响应头后读体失败仍是网络错误：此时连接已建立，不能落进 unknown。
// 错误里保留 status 与两侧 requestId，否则这类「半成功」请求无法与后端日志对上。
    let text: string;
    try {
// 统一先读成文本再解析：错误信封可能是 JSON，也可能是网关 HTML，两者都要能诊断。
      text = await response.text();
    } catch (cause) {
      // 响应头已经收到，读取中断仍是网络错误；不能丢失状态和请求 ID 后落进 unknown。
      log.warn(undefined, "conversation share response body interrupted", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
        clientRequestId,
      });
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "network",
        message: "Conversation share response body interrupted",
        status: response.status,
        requestId: responseRequestId,
        cause,
      });
    }
// 非 2xx 先记一条结构化诊断：状态、请求 id、响应字节数、媒体类型、是否被重定向。
// 这些字段都不含业务内容，却能区分「网关 HTML」「服务端 JSON 错误」「空响应」三类故障。
    if (!response.ok) {
// 媒体类型只取主类型并用白名单正则过一遍：异常头可能包含引号或换行，直接进日志会污染格式。
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      log.warn(undefined, "conversation share HTTP response diagnostics", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
        clientRequestId,
        responseBytes: new TextEncoder().encode(text).byteLength,
        mediaType:
          mediaType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(mediaType) ? mediaType : "unknown",
        responseFormat: /^\s*</u.test(text) ? "html" : "other",
        redirected: response.redirected,
      });
// 只有非空响应才尝试解析；HTML 错误页进 JSON.parse 会抛，已被内部 catch 吃掉。
      let parsedError: ReturnType<typeof conversationShareErrorEnvelopeSchema.safeParse> | null =
        null;
// 空体直接跳过解析：某些 502 由代理返回空响应，强行 JSON.parse 只会抛 SyntaxError。
      if (text.trim()) {
        try {
          parsedError = conversationShareErrorEnvelopeSchema.safeParse(parseJson(text));
        } catch {
          // 网关 HTML/纯文本错误仍按 HTTP 分类，不把限流、鉴权或服务故障误报为内容问题。
          parsedError = null;
        }
      }
// 信封解析成功后以服务端 code 为准分类；未知 code 交给 classifyConversationShareError
// 回落成 HTTP 分类，这样新业务码不会把「服务故障」误报成「内容问题」。
// requestId 优先取响应头，其次取信封里的 logid：后者是后端日志 id，可用于人工对账。
      if (parsedError?.success) {
        // 未知业务码不再让整条信封解析失败（那样会丢掉服务端 msg，退化成没有上下文的
        // "HTTP 4xx"）。保留原始数字码，未知码按 HTTP 分类以区分服务故障。
// rejection 保留原始结构（已由服务端 schema 约束），供 UI 展示具体拒绝原因。
        const { code, data: rejection, logid } = parsedError.data;
        const kind = classifyConversationShareError(response.status, code);
// 只有限流码 3215 才解析 Retry-After：其它错误的该头无意义，误用会让 UI 无故延时重试。
// 优先毫秒头，缺失再退回标准 Retry-After（可能是秒数或 HTTP-date）。
        const millisecondHeader = response.headers.get("retry-after-ms")?.trim();
        const milliseconds =
          millisecondHeader && /^\d+$/u.test(millisecondHeader) ? Number(millisecondHeader) : NaN;
// 限流码同时接受毫秒头与标准头；两者都无效时保持 undefined，由上层用默认退避。
        const retryAfterMs =
          code === 3215
            ? Number.isSafeInteger(milliseconds) && milliseconds > 0
              ? milliseconds
              : parseRetryAfterMs(response.headers.get("retry-after"))
            : undefined;
// 两类 id 合并成一个展示字段：用户只需要一个能报给客服的编号。
        const requestId = responseRequestId ?? logid;
        log.warn(undefined, "conversation share API request rejected", {
          path,
          method: init.method ?? "GET",
          status: response.status,
          kind,
          code,
          requestId,
          rejection,
        });
        throw new ConversationShareClientError({
          clientRequestId,
          kind,
          message: parsedError.data.msg,
          status: response.status,
          code,
          requestId,
          rejection,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      log.warn(undefined, "conversation share API request rejected", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
      });
      throw new ConversationShareClientError({
        clientRequestId,
        kind: classifyConversationShareError(response.status),
        message: `Conversation share API failed with HTTP ${response.status}`,
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }

    try {
// 成功响应也要过信封校验：服务端可能返回 200 但 body 是错误结构，
// 直接当成功会让上层拿到 undefined 字段并在更远处崩，错误归因变得困难。
      const envelope = createConversationShareSuccessEnvelopeSchema(dataSchema).parse(
        parseJson(text),
      );
// 只返回 data：外层信封（code/msg/trace）不进入业务层，避免调用方误用服务端文案。
      return envelope.data;
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      // 校验器消息可能包含响应值；只记录固定字段名和类型，动态键名也不能进入日志。
// 白名单字段名：zod 的 issue.path 会带上出错字段名，若字段名本身来自数据（如动态 key），
// 就可能把用户内容写进日志。非白名单一律替换成 <field>。
// 数字下标保留，因为数组位置不携带业务含义，却能定位到第几条。
      const diagnosticFields = new Set([
        "code",
        "msg",
        "data",
        "preparation_id",
        "status",
        "access_mode",
        "expires_at",
        "share",
        "share_code",
        "share_url",
        "schema_version",
        "artifact_id",
        "size_bytes",
        "sha256",
        "safety_status",
        "projection",
        "rows",
        "artifacts",
        "integrity",
      ]);
// 区分 schema_mismatch 与 invalid_json：前者是契约漂移（需升级或修服务端），
// 后者通常是网关插入了非 JSON 内容（需查链路），处置方式完全不同。
      log.warn(undefined, "conversation share success response parsing failed", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
        clientRequestId,
        responseBytes: new TextEncoder().encode(text).byteLength,
        responseFormat: error instanceof z.ZodError ? "schema_mismatch" : "invalid_json",
        ...(error instanceof z.ZodError
          ? {
              issueCount: error.issues.length,
              issues: error.issues.slice(0, 10).map((issue) => ({
                path: issue.path.map((part) =>
                  typeof part === "number" || diagnosticFields.has(String(part)) ? part : "<field>",
                ),
                code: issue.code,
              })),
            }
          : {}),
      });
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "invalid_contract",
        message: "Conversation share API response does not match the client contract",
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }
  }
}
