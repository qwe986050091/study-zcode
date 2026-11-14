import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * ============================================================
 * auth / localhost-callback.ts —— OAuth 本地回调接收器
 *
 * 定位：在 127.0.0.1 的随机端口上起一次性 HTTP server，等待授权服务器把
 * code/state 回传到本地 redirect URI；把“用户拒绝”“非法响应”“成功”分成三种确定结果。
 *
 * 输入输出：输入 callbackPath 与本次事务 state；输出 server 句柄（callbackUrl、close、
 * waitForCallback）。waitForCallback resolve {code,url}，失败 reject 结构化错误。
 *
 * 副作用：占用一个 loopback 端口（listen 0 自动分配），close 关闭 server；不写文件。
 *
 * 失败语义：端口监听失败 reject；state 不匹配只回 400 并继续等待（不能让陌生请求
 * 污染本事务）；state 匹配但带 error 时立即 reject 且 code=MCP_OAUTH_CALLBACK_DENIED；
 * 缺 code 时立即 reject。
 *
 * 不变量：一个 listener 只服务一个 state/一次事务，settle 后不再 resolve/reject。
 * ============================================================
 */

const LOCALHOST = "127.0.0.1";
const SUCCESS_TEXT = "Authorization successful! You may close this window and return to the CLI.";
const FAILURE_TEXT = "Authorization failed. You may close this window and return to the CLI.";

/** 授权服务器按 RFC 6749 §4.1.2.1 回传 `error` 时使用的稳定错误码。 */
export const MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE = "MCP_OAUTH_CALLBACK_DENIED";

export interface McpOAuthCallbackDeniedError extends Error {
  /** 稳定错误码，调用方按它区分“用户拒绝”与其他失败。 */
  code: typeof MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  /** 授权服务器回传的 error 值（如 access_denied）。 */
  oauthError: string;
  /** 可选的 error_description 原文，仅用于提示。 */
  oauthErrorDescription?: string;
}

/** 构造“授权被拒”结构化错误：挂 code 与 oauthError 字段，避免调用方解析文案。 */
function createCallbackDeniedError(
  oauthError: string,
  oauthErrorDescription: string | null,
): McpOAuthCallbackDeniedError {
  // 不依赖错误文本做流程判断：调用方按 code/oauthError 结构化字段区分「用户拒绝」与超时。
  const error = new Error(
    `OAuth authorization was rejected by the authorization server: ${oauthError}`,
  ) as McpOAuthCallbackDeniedError;
  error.code = MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  error.oauthError = oauthError;
  if (oauthErrorDescription) error.oauthErrorDescription = oauthErrorDescription;
  return error;
}

export interface LocalhostOAuthCallback {
  /** 授权码；已校验非空。 */
  code: string;
  /** 完整回调 URL，供审计/日志使用（可能含 state，调用方需注意脱敏）。 */
  url: string;
}

export interface LocalhostOAuthCallbackServer {
  /** 注册的回调路径（与 redirect URI 的 path 一致）。 */
  callbackPath: string;
  /** 实际监听端口拼出的完整回调 URL，需回填给授权服务器。 */
  callbackUrl: string;
  /** 关闭 listener；可重复调用。 */
  close(): Promise<void>;
  /** 等待一次合法回调；成功后 listener 不会自动关闭，由调用方 close。 */
  waitForCallback(): Promise<LocalhostOAuthCallback>;
}

/**
 * 创建并启动一次性 localhost OAuth 回调服务器。
 *
 * 绑定 127.0.0.1:0（随机端口），用传入 state 做 CSRF 校验。副作用是占用 loopback 端口；
 * 端口/地址解析失败会先关 server 再抛错，避免泄漏监听句柄。
 *
 * 失败语义见文件头：陌生 state 继续等待，匹配 state 的 error/缺 code 立即 reject；
 * 请求处理异常回 500 并 reject。返回前不做其他网络操作。
 */
export async function createLocalhostOAuthCallbackServer(input: {
  callbackPath: string;
  state: string;
}): Promise<LocalhostOAuthCallbackServer> {
  let resolveCallback: (value: LocalhostOAuthCallback) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  let settled = false;
  const callbackPromise = new Promise<LocalhostOAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${LOCALHOST}`);
      if (requestUrl.pathname !== input.callbackPath) {
        writeText(response, 404, FAILURE_TEXT);
        return;
      }

      // state 不匹配过去会 reject 本事务的 callback promise。并发授权事务、
      // 浏览器里残留的旧授权 URL 或预取请求都会打到本 listener；一个陌生 state 就能让
      // 随后到达的正确回调再也无法成功。现在只回 400 并继续等待本 state 的回调。
      const state = requestUrl.searchParams.get("state") ?? "";
      if (state !== input.state) {
        writeText(response, 400, FAILURE_TEXT);
        return;
      }

      // state 匹配说明这确实是本事务的授权响应。用户点「拒绝」时授权服务器回
      // error=access_denied，过去要一直等到 caller 超时才失败；现在立即 settle。
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(
            createCallbackDeniedError(
              oauthError,
              requestUrl.searchParams.get("error_description"),
            ),
          );
        }
        return;
      }

      const code =
        requestUrl.searchParams.get("authCode") ?? requestUrl.searchParams.get("code") ?? "";
      if (!code) {
        // state 匹配但既无 code 也无 error：授权响应不合法，本事务不可能成功，直接失败，
        // 不消耗剩余授权窗口。
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth callback is missing an authorization code."));
        }
        return;
      }

      writeText(response, 200, SUCCESS_TEXT);
      if (!settled) {
        settled = true;
        resolveCallback({
          code,
          url: requestUrl.toString(),
        });
      }
    } catch (error) {
      writeText(response, 500, FAILURE_TEXT);
      if (!settled) {
        settled = true;
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    // 地址解析失败说明端口/句柄状态不可用；先关闭 listener 再抛错。
    await closeServer(server);
    throw new Error("Unable to resolve localhost callback server address.");
  }

  const callbackUrl = `http://${LOCALHOST}:${address.port}${input.callbackPath}`;
  return {
    callbackPath: input.callbackPath,
    callbackUrl,
    close: async () => {
      await closeServer(server);
    },
    waitForCallback: () => callbackPromise,
  };
}

/** 统一写纯文本响应，避免授权页面被浏览器当作 HTML 执行。 */
function writeText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

/** 幂等关闭：未监听直接返回；关闭出错向上抛，由调用方决定是否吞掉。 */
function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** 类型守卫：只认带 port 字段的对象，用于确认 server.address() 是 TCP 地址。 */
function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}
