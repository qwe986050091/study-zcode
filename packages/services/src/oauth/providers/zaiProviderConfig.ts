import {
  ZAI_PROVIDER_ID,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  resolveZaiOAuthClientId,
} from "@zcode/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
  readBoolean,
  readEnv,
} from "./configUtils.js";

// ZAI provider 的 OAuth 运行时配置：静态默认值加按 env 覆盖。
// INV：默认值必须保持可用的生产入口；覆盖只是灰度与测试手段，不能成为唯一配置来源。
// client_id 不是 secret，可以内置；appSecret 不在此文件，由凭证层单独提供。
// 所有 URL 都可能随环境变化（测试/预发），因此统一走 buildRuntime 工具。
// 静态基线：enabled/order 决定设置页展示顺序，order=1 表示默认首选。
// authorizeUrl 使用 /api/oauth 前缀；切回 /auth/oauth 会打开已废弃的旧入口。
export const ZAI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: ZAI_PROVIDER_ID,
  displayName: "Z.ai",
  enabled: true,
  order: 1,
  // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  userinfoUrl: "https://chat.z.ai/api/oauth/userinfo",
  businessLoginUrl: "https://api.z.ai/api/auth/z/login",
  // 生产 client_id 不是 secret，但保留 fallback 可以避免未配置 env 的旧构建直接无法登录。
  appId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  redirectUri: "zcode://oauth/callback",
};

// 运行时配置等于基线加 env 覆盖；每项都给出回落到基线或运行时 URL 的路径。
// enabled 用 readBoolean 解析，保证 false 与 0 等写法一致。
export function createZaiProviderRuntimeConfig(env: NodeJS.ProcessEnv): OAuthProviderRuntimeConfig {
  return {
    ...ZAI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "ZAI_OAUTH_ENABLED", ZAI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "ZAI_OAUTH_AUTHORIZE_URL") ??
      buildRuntimeZaiOAuthUrl(env, "/api/oauth/authorize"),
    tokenUrl:
      readEnv(env, "ZAI_OAUTH_TOKEN_URL") ?? buildZCodeApiUrlFromEnv(env, "/api/v1/oauth/token"),
// userinfo 单独抽函数：登录后需要按同一规则二次解析，避免两处不一致。
    userinfoUrl: resolveZaiUserinfoUrl(env),
    businessLoginUrl:
      readEnv(env, "ZAI_BUSINESS_LOGIN_URL") ??
      buildRuntimeZaiBusinessUrl(env, "/api/auth/z/login"),
    appId:
      // client_id 是公开 OAuth app 标识，按环境覆盖，避免测试/生产 OAuth 应用混用。
      resolveZaiOAuthClientId(env),
// 桌面端回调协议固定为 zcode 自定义协议，测试环境可整体替换。
    redirectUri: buildDesktopOAuthRedirectUriFromEnv(env),
  };
}

// 供本文件与外部调用共用；缺省回落到运行时 OAuth 基址下的 userinfo。
// 不在这里做 URL 合法性校验，交给使用方。
export function resolveZaiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return (
    readEnv(env, "ZAI_OAUTH_USERINFO_URL") ?? buildRuntimeZaiOAuthUrl(env, "/api/oauth/userinfo")
  );
}
