// INV-01 nonce 先行：守住位置 startLogin 保存顺序；改错故障：回调时找不到待决登录，登录必失败。
// INV-02 单次消费：守住位置 takePendingLogin；改错故障：同一 nonce 可重放，形成 CSRF 面。
// INV-03 state 必解：守住位置 parseOAuthState 失败分支；改错故障：篡改 state 仍进入 token 交换。
// INV-04 回跳受限：守住位置 跨源 return_to 判断；改错故障：任意域名可劫持登录结果。
// INV-05 受信开发域名：守住位置 isTrustedDevReturnTo；改错故障：开发回跳在线上生效。
// INV-06 透传最小：守住位置 二次跳转参数；改错故障：token 经 URL 泄漏到第三方源。
// INV-07 错误优先：守住位置 callback.error 分支；改错故障：provider 错误被缺 code 覆盖。
// INV-08 缺码拒绝：守住位置 code 判空；改错故障：用空 code 请求 token，得到误导性失败。
// INV-09 授权参数复取：守住位置 pendingLogin 解构；改错故障：用默认 provider 交换他方 token。
// INV-10 回调地址复取：守住位置 redirectUri 复用；改错故障：token 请求地址与授权时不一致。
// INV-11 落盘有序：守住位置 token 与用户信息写入；改错故障：只有 token 无用户，界面空白。
// INV-12 活跃 provider：守住位置 setActiveProvider；改错故障：多账号切换后仍读旧 provider。
// INV-13 回跳白名单化：守住位置 resolveSafeAppReturnTo；改错故障：登录后跳到未授权页面。
// INV-14 弱随机拒绝：守住位置 createBrowserNonce；改错故障：nonce 可预测，state 失去防伪作用。
// INV-15 注入不改语义：守住位置 runtime 依赖；改错故障：测试替身改变生产分支行为。
// INV-16 只读恢复：守住位置 restoreCachedSession；改错故障：启动阶段触发刷新或写盘。
// INV-17 展示不鉴权：守住位置 getActiveAccount；改错故障：空展示名被当成未登录。
// INV-18 登出彻底：守住位置 clearAll；改错故障：残留 token 让下一次请求仍带旧身份。
//
// 模块职责：编排 Web 端 OAuth 登录、回调兑换、会话恢复与登出。
// 状态所有权：凭证与待决登录归 credential repo；本服务只持不可变依赖。
// 阅读顺序：随机与运行时 → 服务骨架 → 登录发起 → 回调处理 → 只读访问器。
import { ZAI_PROVIDER_ID, type UserInfo } from "@zcode/shared";
import {
  BrowserOAuthCredentialRepo,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  buildWebRemoteOAuthRedirectUri,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  config?: WebZaiOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
}

interface WebAuthLoginOptions {
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

// 优先用 crypto.randomUUID，浏览器支持时路径最短。
// 退化到 getRandomValues，仍然拒绝弱随机源。
// [失败路径] crypto 两条路径都不可用时 `createBrowserNonce` 抛错而不退回 Math.random：nonce 参与 CSRF 比对，弱随机等于没有防护。
//
function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 默认运行时直接操作 window.location。
// 测试可注入替身，避免真实跳转。
//
function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

// 登录状态由 credential repo 持有，服务本身不缓存用户。
// provider 与 config 在构造时固定，运行期不再变更。
//
export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;

  // 依赖全部可选，缺省走真实浏览器实现。
  // [契约] 四个依赖全部可选，缺省常量走真实浏览器实现；注入只替换 runtime / config / provider / repo 而不改变分支。
  //
  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.provider = dependencies.provider ?? new ZaiWebOAuthProvider(this.config);
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
  }

  // 先落 nonce 再跳转，回调时才能做 CSRF 比对。
  // appReturnTo 缺省取当前地址，登录后回到原页面。
  // 回调地址由 appReturnTo 推导，保证回到同一入口。
  // provider 缺省 zai，保持既有入口行为不变。
  // devReturnTo 只用于本地开发回跳，编码后塞进 state。
  //
  startLogin(options: WebAuthLoginOptions = {}): void {
    const nonce = this.runtime.createNonce();
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const returnToOptions = { currentOrigin: this.runtime.getCurrentOrigin() };
    const redirectUri = buildWebRemoteOAuthRedirectUri(
      options.redirectUri ?? this.config.redirectUri,
      appReturnTo,
      returnToOptions,
    );
    this.repo.savePendingLogin({ nonce, provider, redirectUri });

    const state = buildOAuthState({
      nonce,
      app_return_to: appReturnTo,
      ...(options.devReturnTo
        ? {
            return_to: buildWebRemoteOAuthRedirectUri(
              options.devReturnTo,
              appReturnTo,
              returnToOptions,
            ),
          }
        : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri,
      }),
    );
  }

  // state 解析失败立即抛错，不进入 token 交换。
  // 跨源 return_to 只在受信开发域名下才二次跳转。
  // 二次跳转只透传 code 与 error，不携带 token。
  // 显式 error 优先于缺失 code，保留 provider 原文案。
  // pending login 取出即删，同一 nonce 不能重放。
  //
  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    // provider 与回调地址必须取跳转前记下的那条：authorize 参数名和 token 响应里 access_token
    // 的位置都是 provider 特定的，token 请求也要用授权时的完整回调地址。
    const pendingLogin = this.repo.takePendingLogin(statePayload.nonce);
    if (!pendingLogin) {
      throw new Error("OAuth CSRF 检测失败");
    }
    const { provider, redirectUri } = pendingLogin;
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri,
    });

    this.repo.saveTokenSet(exchange.tokenSet, provider);
    this.repo.saveUserInfo(exchange.rawUserInfo, provider);
    this.repo.setActiveProvider(provider);

    return {
      userInfo: exchange.userInfo,
      appReturnTo: resolveSafeAppReturnTo(statePayload.app_return_to, {
        currentOrigin: this.runtime.getCurrentOrigin(),
      }),
    };
  }

  // 缓存会话只读取，不在启动阶段发起网络。
  // 返回 null 表示没有可恢复的登录态。
  //
  async restoreCachedSession(): Promise<UserInfo | null> {
    return this.repo.loadCachedSession();
  }

  restoreCachedSessionState() {
    return this.repo.loadCachedSessionState();
  }

  getZCodeJwtToken(): string | null {
    return this.repo.loadZCodeJwtToken();
  }

  /** 设备页账号行的展示资料；只读，不参与登录判断。 */
  // 展示名优先取 displayName，缺失时回退用户名。
  // 该结果只用于界面展示，不参与鉴权判断。
  //
  getActiveAccount(): {
    displayName: string;
    avatarUrl?: string;
    provider: WebOAuthProviderId;
  } | null {
    const account = this.repo.loadActiveAccount();
    if (!account) return null;
    const { userInfo, provider } = account;
    return {
      displayName: userInfo.displayName.trim() || userInfo.username,
      ...(userInfo.avatarUrl ? { avatarUrl: userInfo.avatarUrl } : {}),
      provider,
    };
  }

  async logout(): Promise<void> {
    this.repo.clearAll();
  }
}

export function createWebAuthService(): WebAuthService {
  return new WebAuthService();
}
