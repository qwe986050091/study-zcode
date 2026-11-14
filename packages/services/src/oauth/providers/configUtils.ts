// OAuth provider 的环境配置读取与 URL 拼装工具：只做纯函数转换，不持有状态、不发请求。
// 边界：env 必须由调用方注入，禁止在此读取 process.env，保证测试与多环境可复现。
// 改错风险：回调 URI 与 App 注册的协议不一致会让 deep link 静默失败，登录卡在浏览器。
import {
  ZCODE_VERSION,
  buildRuntimeZCodeApiUrl,
  buildRuntimeZCodeEndpointUrls,
} from "@zcode/shared";

// INV：该 scheme 必须与桌面端打包注册的协议一致；改动需同步安装包配置，否则回跳直接丢失。
const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

// 空串与纯空白一律视为未配置，避免 .env 里 `KEY=` 被当成有效值而绕过下游默认逻辑。
export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// 只有 "0"/"false"（忽略大小写）判为假，其余非空值都为真，兼容 "1"/"yes" 等历史写法。
export function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw == null) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function buildZCodeApiUrlFromEnv(env: NodeJS.ProcessEnv, path: string): string {
  // OAuth provider 是运行时配置，必须跟随传入 env.ZCODE_ENV；
  // 地址来自 .env 的通用变量，默认线上；登录与 token 交换必须使用同一配置来源。
  return buildRuntimeZCodeApiUrl(env, path);
}

// 回跳先走网站 /app/oauth/login 再转 deep link：统一入口才能在拿到版本信息后决定是否自动拉起客户端。
export function buildDesktopOAuthRedirectUriFromEnv(env: NodeJS.ProcessEnv): string {
  const url = new URL("/app/oauth/login", buildRuntimeZCodeEndpointUrls(env).origin);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  // Website 需要按 App 版本决定是否关闭自动 deep link；缺少版本时必须兼容旧客户端行为。
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}
