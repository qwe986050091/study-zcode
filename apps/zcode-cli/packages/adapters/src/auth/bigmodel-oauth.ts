import { randomBytes } from "node:crypto";
import type { HttpClientPort, HttpClientRunOptions, TraceContext } from "@zcode/contracts";
import { buildBigModelApiUrl } from "@zcode/shared";

/*
 * ============================================================
 * auth / bigmodel-oauth.ts —— BigModel OAuth 客户端（授权码换 token）
 *
 * 定位：只负责拼授权 URL 与用授权码换 access/refresh token；请求必须经过
 * HttpClientPort（统一超时/代理/trace），本文件不直接 fetch。
 *
 * 输入输出：buildAuthorizeUrl 返回带 appId/redirect/state 的授权页 URL；
 * exchangeCode 返回 {accessToken, refreshToken?}，缺 accessToken 视为失败。
 *
 * 副作用：网络 POST /api/auth/tokenByAuthCode；不落盘、不缓存凭据。
 *
 * 失败语义：缺 appSecret 直接抛 BigmodelOAuthError（不发出请求）；非 2xx 或响应缺
 * accessToken 抛业务错误；HTTP 层错误由 HttpClientPort 抛出并原样冒泡。
 *
 * 不变量：appSecret 只出现在请求体，绝不进入 URL/日志；state 由 CSPRNG 生成。
 * ============================================================
 */

const BIGMODEL_AUTHORIZE_PATH = "/login";
const BIGMODEL_TOKEN_PATH = "/api/auth/tokenByAuthCode";
const BIGMODEL_APP_ID = "zcode";
const OAUTH_STATE_BYTES = 32;
const JSON_CONTENT_TYPE = "application/json";

export interface BigmodelOAuthClientOptions {
  /** OAuth 应用 id，缺省 zcode。 */
  appId?: string;
  /** 应用密钥；为空时 exchangeCode 直接失败。 */
  appSecret?: string;
  /** 授权页地址覆盖（默认按 buildBigModelApiUrl 推导）。 */
  authorizeUrl?: string;
  /** 必须注入的 HTTP 端口，统一承载超时/代理/trace。 */
  httpClient: HttpClientPort;
  /** 换 token 接口地址覆盖。 */
  tokenUrl?: string;
  /** 可选的 trace 上下文，随请求上报。 */
  trace?: TraceContext;
}

export interface BigmodelOAuthTokenSet {
  /** 访问令牌，非空才视为成功。 */
  accessToken: string;
  /** 刷新令牌；服务端未返回时省略。 */
  refreshToken?: string;
}

export interface BigmodelOAuthClient {
  /** 拼授权 URL；state 必须由调用方生成并在回调时校验。 */
  buildAuthorizeUrl(input: { redirectUri: string; state: string }): string;
  /** 用授权码换 token；appSecret 缺失、响应非法或缺 accessToken 都抛错。 */
  exchangeCode(input: { code: string }, options?: HttpClientRunOptions): Promise<BigmodelOAuthTokenSet>;
}

export class BigmodelOAuthError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "BigmodelOAuthError";
  }
}

interface BigmodelTokenEnvelope {
  /** 业务数据体；成功时至少含 accessToken。 */
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
  /** 业务错误信息，缺 accessToken 时作为错误文案。 */
  msg?: string;
}

/**
 * 创建 BigModel OAuth 客户端。
 *
 * 构造时确定 appId/authorizeUrl/tokenUrl（可被 env 推导覆盖），不发起网络。返回的
 * buildAuthorizeUrl 纯字符串拼接；exchangeCode 走 httpClient 并做响应解析。
 *
 * 失败语义：exchangeCode 在 appSecret 为空时本地抛错；HTTP 非 2xx 由 httpClient 抛；
 * 响应 JSON 缺 accessToken 抛 BigmodelOAuthError（优先使用服务端 msg）。
 */
export function createBigmodelOAuthClient(
  options: BigmodelOAuthClientOptions,
): BigmodelOAuthClient {
  const appId = options.appId ?? BIGMODEL_APP_ID;
  const appSecret = options.appSecret?.trim() ?? "";
  const authorizeUrl =
    options.authorizeUrl ?? buildBigModelApiUrl(process.env, BIGMODEL_AUTHORIZE_PATH);
  const tokenUrl = options.tokenUrl ?? buildBigModelApiUrl(process.env, BIGMODEL_TOKEN_PATH);

  return {
    buildAuthorizeUrl(input: { redirectUri: string; state: string }): string {
      const query = new URLSearchParams({
        appId,
        redirect: input.redirectUri,
        state: input.state,
      });
      return `${authorizeUrl}?${query.toString()}`;
    },

    async exchangeCode(
      input: { code: string },
      runOptions?: HttpClientRunOptions,
    ): Promise<BigmodelOAuthTokenSet> {
      // 无 appSecret 时服务端必然拒绝；在本地提前失败，避免把无效请求发出去。
      if (!appSecret) {
        throw new BigmodelOAuthError("BigModel OAuth appSecret is required.");
      }
      const response = await options.httpClient.request(
        {
          body: new TextEncoder().encode(
            JSON.stringify({
              appId,
              appSecret,
              authCode: input.code,
            }),
          ),
          headers: {
            "Content-Type": JSON_CONTENT_TYPE,
          },
          maxResponseBytes: 64 * 1024,
          method: "POST",
          trace: options.trace,
          url: tokenUrl,
        },
        runOptions,
      );
      const payload = JSON.parse(new TextDecoder().decode(response.body)) as BigmodelTokenEnvelope;
      const accessToken = payload.data?.accessToken?.trim() ?? "";
      if (!accessToken) {
        throw new BigmodelOAuthError(payload.msg ?? "BigModel token response is missing accessToken.");
      }
      return {
        accessToken,
        ...(payload.data?.refreshToken ? { refreshToken: payload.data.refreshToken } : {}),
      };
    },
  };
}

/** 生成 32 字节 CSPRNG state（hex），用于 OAuth CSRF 关联，不落盘。 */
export function createBigmodelOAuthState(): string {
  return randomBytes(OAUTH_STATE_BYTES).toString("hex");
}
