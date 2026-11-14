import { randomBytes } from "node:crypto";
import type { HttpClientPort, HttpClientRunOptions, TraceContext } from "@zcode/contracts";

/*
 * ============================================================
 * auth / cli-oauth.ts —— CLI 设备码式 OAuth（init + poll）
 *
 * 定位：向 ZCode 授权服务发起 init 拿到授权 URL/flowId，再按 poll_interval 轮询
 * ready/pending/failed；不打开浏览器、不落盘凭据（由调用方决定如何持久化）。
 *
 * 输入输出：init 入参 pollToken，返回 authorize_url/expires_at/flow_id/poll_interval_sec；
 * poll 返回三态联合（ready 时带 token、user、accessToken、可选 refreshToken）。
 *
 * 副作用：两次 HTTP 调用（POST /oauth/cli/init、GET /oauth/cli/poll/<flowId>），
 * 均经 HttpClientPort 并带 trace；无文件/进程副作用。
 *
 * 失败语义：HTTP 非 2xx、信封 code≠0、JSON 非法、init/poll 字段校验失败都抛
 * CliOAuthError（保留 httpStatus/businessCode 结构化字段）；授权 URL 必须是 https。
 *
 * 不变量：pollToken 只作为 Bearer 头使用，不进入 URL；flowId 必须 encodeURIComponent。
 * ============================================================
 */

const DEFAULT_ZCODE_OAUTH_BASE_URL = "https://zcode.z.ai/api/v1";
export type CliOAuthProviderId = "zai" | "bigmodel";
const POLL_TOKEN_BYTES = 32;
const JSON_CONTENT_TYPE = "application/json";

export interface CliOAuthClientOptions {
  /** 服务基址，默认 https://zcode.z.ai/api/v1；末尾斜杠会被去掉。 */
  baseUrl?: string;
  /** provider 维度，决定 ready 数据从哪个子对象取 token。 */
  providerId: CliOAuthProviderId;
  /** 必须注入的 HTTP 端口。 */
  httpClient: HttpClientPort;
  /** 可选 trace，随请求上报。 */
  trace?: TraceContext;
}

export interface CliOAuthInitInput {
  /** 本次发起方的随机令牌，作为 Bearer 凭据；不进入 URL。 */
  pollToken: string;
}

export interface CliOAuthInitData {
  /** 用户在浏览器中打开的授权页地址，必须是 https。 */
  authorize_url: string;
  /** 授权流程过期时间戳（秒），用于超时判断。 */
  expires_at: number;
  /** 轮询流程 id。 */
  flow_id: string;
  /** 建议轮询间隔，单位秒，必须 ≥1。 */
  poll_interval_sec: number;
}

export interface CliOAuthPollInput {
  /** init 返回的流程 id。 */
  flowId: string;
  /** 与 init 相同的 pollToken，服务端据此绑定流程归属。 */
  pollToken: string;
}

export interface CliOAuthUser {
  /** 头像地址，可选。 */
  avatar?: string;
  /** 邮箱，可选。 */
  email?: string;
  /** 显示名，可选。 */
  name?: string;
  /** 服务端用户 id，必填。 */
  user_id: string;
}

export interface CliOAuthReadyData {
  /** 终态：授权完成。 */
  status: "ready";
  /** 一次性登录 token（系统级），非 provider 的 accessToken。 */
  token: string;
  /** 授权用户信息。 */
  user: CliOAuthUser;
  /** 该 token 属于哪个 provider。 */
  providerId: CliOAuthProviderId;
  /** provider 访问令牌，必填。 */
  accessToken: string;
  /** provider 刷新令牌；服务端未返回时省略。 */
  refreshToken?: string;
}

export interface CliOAuthPendingData {
  /** 中间态：用户尚未完成授权，调用方应继续按间隔轮询。 */
  status: "pending";
}

export interface CliOAuthFailedData {
  /** 终态：授权失败（拒绝/过期等），调用方应停止轮询并要求重新发起。 */
  status: "failed";
}

export type CliOAuthPollData = CliOAuthFailedData | CliOAuthPendingData | CliOAuthReadyData;

export interface CliOAuthClient {
  /** 发起授权流程；返回授权 URL 与轮询参数。 */
  init(input: CliOAuthInitInput, options?: HttpClientRunOptions): Promise<CliOAuthInitData>;
  /** 轮询一次流程状态；ready/failed 为终态，pending 需继续。 */
  poll(input: CliOAuthPollInput, options?: HttpClientRunOptions): Promise<CliOAuthPollData>;
}

export class CliOAuthError extends Error {
  /** 业务信封 code（HTTP 200 但 code≠0 时），供调用方区分失败类别。 */
  readonly businessCode?: number;
  /** HTTP 状态码；网络层错误时可能缺失。 */
  readonly httpStatus?: number;

  constructor(message: string, details: { businessCode?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = "CliOAuthError";
    this.businessCode = details.businessCode;
    this.httpStatus = details.httpStatus;
  }
}

/**
 * 创建 CLI OAuth 客户端（init + poll）。
 *
 * baseUrl 归一化后固定，两个方法都走 requestJsonEnvelope：校验 HTTP 状态、JSON 形状、
 * 业务 code，再做领域字段校验。无缓存、无重试；重试节奏由调用方按 poll_interval 控制。
 *
 * 失败语义：所有非正常响应都抛 CliOAuthError（含 httpStatus/businessCode）；
 * 响应字段缺失/类型不符同样抛错，绝不返回半成品数据。
 */
export function createCliOAuthClient(options: CliOAuthClientOptions): CliOAuthClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ZCODE_OAUTH_BASE_URL);
  const encoder = new TextEncoder();

  return {
    async init(
      input: CliOAuthInitInput,
      runOptions?: HttpClientRunOptions,
    ): Promise<CliOAuthInitData> {
      const envelope = await requestJsonEnvelope(
        options.httpClient,
        {
          body: encoder.encode(JSON.stringify({ provider: options.providerId })),
          headers: {
            Authorization: `Bearer ${input.pollToken}`,
            "Content-Type": JSON_CONTENT_TYPE,
          },
          method: "POST",
          trace: options.trace,
          url: `${baseUrl}/oauth/cli/init`,
        },
        runOptions,
      );
      return parseInitData(envelope.data);
    },

    async poll(
      input: CliOAuthPollInput,
      runOptions?: HttpClientRunOptions,
    ): Promise<CliOAuthPollData> {
      // flowId 进路径段，必须转义，防止构造出其他 endpoint。
      const flowId = encodeURIComponent(input.flowId);
      const envelope = await requestJsonEnvelope(
        options.httpClient,
        {
          headers: {
            Authorization: `Bearer ${input.pollToken}`,
          },
          method: "GET",
          trace: options.trace,
          url: `${baseUrl}/oauth/cli/poll/${flowId}`,
        },
        runOptions,
      );
      return parsePollData(envelope.data, options.providerId);
    },
  };
}

/** 生成 32 字节 CSPRNG pollToken（hex），一次授权流程内复用。 */
export function createCliOAuthPollToken(): string {
  return randomBytes(POLL_TOKEN_BYTES).toString("hex");
}

/** 去掉 baseUrl 末尾所有斜杠，避免拼出 `//oauth` 这类路径。 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

/**
 * 发请求并解出 {code,data,msg} 信封。
 *
 * 先校验 HTTP 2xx，再解析 JSON 与信封形状，最后要求 code===0；任何一步不满足都抛
 * CliOAuthError，并尽量带上 httpStatus/businessCode。响应体上限 64KB。
 */
async function requestJsonEnvelope(
  httpClient: HttpClientPort,
  request: Parameters<HttpClientPort["request"]>[0],
  options?: HttpClientRunOptions,
): Promise<{ code: number; data?: unknown; msg?: string }> {
  const response = await httpClient.request(
    {
      maxResponseBytes: 64 * 1024,
      ...request,
    },
    options,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new CliOAuthError(`OAuth HTTP error ${response.status}`, {
      httpStatus: response.status,
    });
  }
  const bodyText = new TextDecoder().decode(response.body);
  const parsed = parseJson(bodyText);
  const envelope = asRecord(parsed);
  if (!envelope || typeof envelope.code !== "number") {
    throw new CliOAuthError("Invalid OAuth response envelope", {
      httpStatus: response.status,
    });
  }

  const responseMessage = typeof envelope.msg === "string" ? envelope.msg : undefined;
  if (envelope.code !== 0) {
    throw new CliOAuthError(responseMessage ?? `OAuth business error ${envelope.code}`, {
      businessCode: envelope.code,
      httpStatus: response.status,
    });
  }

  return {
    code: envelope.code,
    data: envelope.data,
    msg: responseMessage,
  };
}

/**
 * 校验 init data：flow_id/authorize_url 非空字符串、expires_at 有限数、
 * poll_interval_sec ≥1，且 authorize_url 必须是 https。
 *
 * 任一不满足抛 CliOAuthError，避免把不可用 URL 交给浏览器或把非法间隔用于轮询。
 */
function parseInitData(value: unknown): CliOAuthInitData {
  const data = asRecord(value);
  if (
    !data ||
    !readString(data.flow_id) ||
    !readString(data.authorize_url) ||
    typeof data.expires_at !== "number" ||
    !Number.isFinite(data.expires_at) ||
    typeof data.poll_interval_sec !== "number" ||
    !Number.isFinite(data.poll_interval_sec) ||
    data.poll_interval_sec < 1
  ) {
    throw new CliOAuthError("Invalid OAuth init response data");
  }
  try {
    if (new URL(readString(data.authorize_url)!).protocol !== "https:") throw new Error();
  } catch {
    // 非 https 或无法解析都视为不可信授权地址，直接拒绝而不是自动降级到 http。
    throw new CliOAuthError("Invalid OAuth authorization URL");
  }

  return {
    authorize_url: readString(data.authorize_url)!,
    expires_at: data.expires_at,
    flow_id: readString(data.flow_id)!,
    poll_interval_sec: data.poll_interval_sec,
  };
}

/** 把 poll data 收敛到三态：pending/failed 直接返回，ready 走更严格字段校验，其余抛错。 */
function parsePollData(value: unknown, providerId: CliOAuthProviderId): CliOAuthPollData {
  const data = asRecord(value);
  const status = data?.status;
  if (status === "pending" || status === "failed") {
    return { status };
  }

  if (status === "ready" && data) {
    return parseReadyData(data, providerId);
  }

  throw new CliOAuthError("Invalid OAuth poll response data");
}

/**
 * 校验 ready 数据：token/user.user_id/accessToken 必填，provider 子对象兼容
 * snake_case 与 camelCase 两种命名。
 *
 * 缺任一必填字段抛错；avatar/email/name 只在字符串时透传，refreshToken 空则省略。
 */
function parseReadyData(
  data: Record<string, unknown>,
  providerId: CliOAuthProviderId,
): CliOAuthReadyData {
  const user = asRecord(data.user);
  const provider = asRecord(data[providerId]);
  const accessToken = readString(provider?.access_token) ?? readString(provider?.accessToken);
  const refreshToken = readString(provider?.refresh_token) ?? readString(provider?.refreshToken);
  if (!readString(data.token) || !user || !readString(user.user_id) || !accessToken) {
    throw new CliOAuthError("Invalid OAuth ready response data");
  }

  return {
    status: "ready",
    token: readString(data.token)!,
    user: {
      ...(typeof user.avatar === "string" ? { avatar: user.avatar } : {}),
      ...(typeof user.email === "string" ? { email: user.email } : {}),
      ...(typeof user.name === "string" ? { name: user.name } : {}),
      user_id: readString(user.user_id)!,
    },
    providerId,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

/** JSON 解析失败转成 CliOAuthError，保持错误类型稳定，不把 SyntaxError 泄漏给上层。 */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CliOAuthError("OAuth response is not valid JSON", {
      httpStatus: undefined,
    });
  }
}

/** 类型守卫：只接受非数组对象，用于安全读取信封/数据体字段。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 读取非空字符串并 trim；空白串按缺失处理。 */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
