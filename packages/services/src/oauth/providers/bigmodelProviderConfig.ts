// 职责：BigModel OAuth 的静态 provider 配置，以及由环境变量派生的运行时配置。
// 边界：只做 URL / appId / redirectUri 的取值与兜底，不发起网络请求，也不缓存凭证。
// 不变量（INV）：所有 *Url 都必须经 buildBigModelApiUrl / buildZCodeApiUrlFromEnv 生成，
// 由环境决定 host；硬编码域名会让测试环境误连生产。
import { BIGMODEL_PROVIDER_ID, buildBigModelApiUrl } from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

// 只固化路径、不固化 host：host 由 buildBigModelApiUrl 按 env 选择（生产/测试/自建），
// 拆开才能让同一份路径在不同环境复用，也避免在常量里写死域名。
// 路径变更属于服务端契约变更，改这里等于改协议，需同步 userinfo 的读取方。
const BIGMODEL_USERINFO_PATH = "/api/biz/customer/getCustomerInfo";
const BIGMODEL_AUTHORIZE_PATH = "/login";

// Omit<..., "appSecret"> 是刻意的类型约束：内置配置里不允许出现密钥，只有运行时配置
// 才可能经环境变量注入，静态字面量因此无法意外把密钥带进打包产物。
export const BIGMODEL_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: BIGMODEL_PROVIDER_ID,
  displayName: "BigModel",
  enabled: true,
  order: 0,
  authorizeUrl: "https://bigmodel.cn/login",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: buildBigModelApiUrl({ ZCODE_ENV: "production" }, BIGMODEL_USERINFO_PATH),
  appId: "zcode",
  redirectUri: "zcode://oauth/callback",
};

export function createBigModelProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OAuthProviderRuntimeConfig {
  return {
    ...BIGMODEL_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "BIGMODEL_OAUTH_ENABLED", BIGMODEL_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "BIGMODEL_OAUTH_AUTHORIZE_URL") ??
      buildBigModelApiUrl(env, BIGMODEL_AUTHORIZE_PATH),
    tokenUrl:
      readEnv(env, "BIGMODEL_OAUTH_TOKEN_URL") ??
      buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
    userinfoUrl: resolveBigModelUserinfoUrl(env),
    appId: readEnv(env, "BIGMODEL_OAUTH_APP_ID") ?? BIGMODEL_OAUTH_PROVIDER_CONFIG.appId,
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
    // 历史 fallback secret 已废弃，不能再把内置密钥打进运行时配置。
    // 当前 BigModel callback 只消费 zcode OAuth token 路由，显式 appSecret 仅保留给
    // 旧接口兼容场景，缺失时必须保持 undefined。
    appSecret: readEnv(env, "BIGMODEL_OAUTH_APP_SECRET"),
  };
}

// userinfo 与 authorize 的 host 来源不同（前者走 BigModel API、后者走登录页），
// 单独抽函数是为了让运行时配置与外部读取方共用同一份派生规则。
export function resolveBigModelUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "BIGMODEL_OAUTH_USERINFO_URL") ?? buildBigModelApiUrl(env, BIGMODEL_USERINFO_PATH)
  );
}
