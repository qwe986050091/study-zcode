// 本文件是 ZCode 客户端所有远端端点的唯一解析入口：把 ZCODE_ENV 与各类 BASE_URL 环境变量
// 归一化为 origin，再派生出 API / 远控 / 分享回调 / Coding Plan 计费 / 智谱 OAuth 的完整 URL 集合。
// 边界：不做网络探测、不校验可达性、不决定鉴权方式，也不持有运行态缓存；全部导出按纯函数使用。
//
// 不变量：改动任何解析顺序或常量前，先确认下列断言仍成立。
// INV-01 断言：所有对外 origin 都经 normalizeZCodeEndpointOrigin 收敛为 scheme+host+port —— 守住它的位置：normalizeZCodeEndpointOrigin 与全部 resolve 出口 —— 改错故障：带尾斜杠或子路径的 BASE_URL 会拼出双斜杠或丢前缀，接口整线 404。
// INV-02 断言：协议只允许 http/https，其他协议抛错而非回落默认域 —— 守住它的位置：normalizeZCodeEndpointOrigin 的 protocol 分支 —— 改错故障：误配 file: 等协议时静默走公网默认域，内网网关请求打到 zcode.z.ai。
// INV-03 断言：production 忽略 overrideOrigin，只有非生产才接受覆盖 —— 守住它的位置：resolveZCodeEndpointOrigin 的 env === "production" 提前返回 —— 改错故障：正式包被注入 override 指向测试域，正式用户被导流到测试后端。
// INV-04 断言：ZCODE_ENV 缺省、空串或非法值一律判定为 production —— 守住它的位置：resolveRuntimeZCodeEnv 的三元表达式 —— 改错故障：漏注入变量的 CLI 或服务进程被当成测试环境，连到测试域读到污染数据。
// INV-05 断言：ZCODE_BASE_URL 优先于 ZCODE_ENDPOINT_ORIGIN，后者优先于分环境 BASE_URL —— 守住它的位置：resolveRuntimeZCodeEndpointOrigin 的问号链 —— 改错故障：顺序调整后灰度覆盖失效，桌面端改域不生效且难以定位。
// INV-06 断言：BigModel、ZAI OAuth、ZAI 业务三套域各自独立解析，不共用 ZCode 端点 —— 守住它的位置：resolveBigModelApiOrigin / resolveZaiOAuthOrigin / resolveZaiBusinessBaseUrl —— 改错故障：BigModel 请求发到 zcode 域，Coding Plan 页面与鉴权全部跨域失败。
// INV-07 断言：分环境变量按 zcodeEnv 二选一，测试值不得泄漏到生产解析 —— 守住它的位置：readRuntimeZCodeEnvScopedValue 的 testKey 与 productionKey 分支 —— 改错故障：生产读到测试 OAuth client，授权回调被拒，登录卡在回调页。
// INV-08 断言：ZAI_OAUTH_CLIENT_ID 缺失时才回落到旧的 ZAI_OAUTH_APP_ID —— 守住它的位置：resolveZaiOAuthClientId 的回落顺序 —— 改错故障：旧 APP_ID 覆盖新 client，OAuth 返回 invalid_client，登录直接失败。
// INV-09 断言：远控 v4 门槛按 semver 逐段数值比较，3.4.0 自身预发布版不达标 —— 守住它的位置：isWebRemoteControlV4AppVersion 的比较循环 —— 改错故障：3.4.0-beta 被放进 v4 页面，旧渲染协议握手失败白屏。
// INV-10 断言：无法解析或格式非法的版本号一律判定不满足门槛 —— 守住它的位置：isWebRemoteControlV4AppVersion 的未匹配分支与格式校验分支 —— 改错故障：dev 构建被误判为 v4，本地远控打不开且无报错。
// INV-11 断言：remoteUrl 按版本切换，webRemoteCallbackUrl 恒为 /remote/v4 —— 守住它的位置：buildZCodeEndpointUrls 的返回对象 —— 改错故障：回调也做成版本化后老客户端回调地址不存在，网页远控授权后无法回跳。
// INV-12 断言：relayWsUrl 的 ws/wss 必须跟随 origin 协议，不能写死 —— 守住它的位置：buildZCodeEndpointUrls 与 resolveWebRemoteControlRelayWsUrl 的协议映射 —— 改错故障：http 本地域下用 wss 连接被拒，远控持续重连。
// INV-13 断言：rewriteZCodeEndpointUrl 只改写源域等于默认域的绝对 URL —— 守住它的位置：parsed.origin 与 sourceOrigin 比较后的提前返回 —— 改错故障：第三方链接或已是目标域的链接被二次改写，分享链接指向错误主机。
// INV-14 断言：rewriteZCodeEndpointUrl 未命中改写时原样返回入参，命中时返回新字符串 —— 守住它的位置：函数返回类型与三处 return input —— 改错故障：调用方对返回值直接取 host 拿到字符串，运行期 TypeError。
// INV-15 断言：无法解析的入参原样返回，不抛错也不兜底换域 —— 守住它的位置：new URL 的 catch 分支 —— 改错故障：剪贴板里的畸形链接让整个分享流程抛异常中断。
// INV-16 断言：受信 webview 白名单只含默认域、测试域和 localhost:3000，回环地址还需 e2e 开关 —— 守住它的位置：isTrustedCodingPlanWebviewOrigin 的两段判断 —— 改错故障：任意回环页面被当作受信，e2e 桥接被本地恶意页面利用。
// INV-17 断言：子路径拼接前统一补前导斜杠，不得出现 originapi 或双斜杠 —— 守住它的位置：buildRuntimeZCodeApiUrl / buildBigModelApiUrl / buildZaiOAuthUrl / buildRuntimeZaiBusinessUrl 的 startsWith 判断 —— 改错故障：传入 api/v1 时拼出 originapi/v1，请求落到错误路径。
// INV-18 断言：RuntimeProductEndpointConfig 的七个字段来自同一次 env 快照 —— 守住它的位置：resolveRuntimeProductEndpointConfig 的单一 return —— 改错故障：出现 zcode 用生产、bigmodel 用测试的混合配置，排查成本极高。
//
// 环境变量层次：进程环境传入的 env 对象是唯一来源，未命中时由 DEFAULT_ 与 TEST_ 常量兜底，不叠加其他配置。
// 常量层面 TEST_ 与 DEFAULT_ 当前同值但语义独立：前者代表测试默认值，后者代表生产默认值，不要合并。
// 一旦需要独立测试域，只改 TEST_ 常量即可，生产行为不受影响。
// 本文件会在 Node 加载期被 Vite 配置直接导入，因此不得引入运行时依赖或副作用初始化。
// 全部导出保持无状态：不做记忆化，避免跨请求或跨窗口串味。
// 新增导出前先确认它是「解析」而非「请求」：本文件只产出地址，不发起连接。
import type { ZCodeEnv } from "./env.js";

// [契约] 这些常量是打包后的默认域，属于对外契约，改值等于改线上流量入口，需同步发布说明。
// DEFAULT_ 与 TEST_ 当前同值但语义独立，测试域独立化时只应改 TEST_ 常量。
// 业务代码不要另写字面量域名，全部从这里派生，否则改域必然漏改。
export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";
export const TEST_ZCODE_ENDPOINT_ORIGIN = "https://zcode.z.ai";
export const CODING_PLAN_LOCAL_WEBVIEW_ORIGIN = "http://localhost:3000";
export const DEFAULT_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const TEST_BIGMODEL_API_ORIGIN = "https://bigmodel.cn";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const TEST_ZAI_OAUTH_ORIGIN = "https://chat.z.ai";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const TEST_ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const TEST_ZAI_OAUTH_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL = "wss://zcode.z.ai/api/v1/remote/ws2";
export const WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION = "3.4.0";

export interface BuildZCodeEndpointUrlsOptions {
  appVersion?: string;
}

// [权衡] 远控 v4 的可用性由客户端版本决定，不能用「有版本号即支持」推断：老版本没有 v4 路由。
// 版本号可能来自 package.json、构建注入或服务端下发，格式未必规范，因此先严格校验再比较。
// 判断必须保持纯函数且无缓存：同一进程内会针对不同窗口上报不同版本。
// 未通过校验一律视为不满足，走 v3 保守分支，代价只是部分新特性不可见。
function isWebRemoteControlV4AppVersion(appVersion: string | undefined): boolean {
  if (!appVersion) {
    return false;
  }

  // zcodeEndpoint 会被 Vite 配置在 Node 加载期直接导入，不能依赖源码态 `.js` runtime import。
  // 这里只比较固定的稳定版门槛；高于 3.4.0 的预发布版本仍满足门槛，3.4.0 自身的预发布版本不满足。
  // 先去掉首尾空白和可选的 v 前缀，否则带空格的版本串会直接判为非法。
  // 这里刻意不引入 semver 库：本文件在 Node 加载期被导入，新增运行时依赖会拖慢启动。
  // 正则只接受完整的 x.y.z 及可选预发布、构建段，缺段或四段的版本视为非法。
  const normalizedVersion = appVersion.trim().replace(/^v/i, "");
  const match = normalizedVersion.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([^+]+))?(?:\+(.+))?$/,
  );
  if (!match) {
    return false;
  }

  const prereleaseIdentifiers = match[4]?.split(".");
  const hasValidPrerelease =
    prereleaseIdentifiers === undefined ||
    prereleaseIdentifiers.every(
      (identifier) =>
        /^[0-9A-Za-z-]+$/.test(identifier) &&
        (!/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier)),
    );
  const buildIdentifiers = match[5]?.split(".");
  const hasValidBuild =
    buildIdentifiers === undefined ||
    buildIdentifiers.every((identifier) => /^[0-9A-Za-z-]+$/.test(identifier));
  if (!hasValidPrerelease || !hasValidBuild) {
    return false;
  }

  // [契约] 必须逐段按数值比较，不能比字符串：字符串下 3.10.0 会小于 3.4.0，高版本被降级。
  // 正则已保证三段都是合法整数，因此这里可以安全地按固定下标取值。
  // 门槛来自 WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION，调门槛只改常量，不要在这里写死数字。
  // 遇到首个不等段立即返回，后续段不参与比较。
  const versionParts = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floorParts = WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION.split(".").map(Number);
  for (let index = 0; index < floorParts.length; index += 1) {
    if (versionParts[index]! !== floorParts[index]!) {
      return versionParts[index]! > floorParts[index]!;
    }
  }

  // 走到这里说明三段版本号都等于门槛，即正好 3.4.0。
  // [契约] 3.4.0 的预发布版（如 3.4.0-beta.1）不算达标，只有正式版放行，否则 beta 用户先进入 v4。
  // 高于门槛的预发布版已在循环中返回 true，不会落到这一行。
  return prereleaseIdentifiers === undefined;
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  remoteUrl: string;
  webRemoteCallbackUrl: string;
  webShareCallbackUrl: string;
  relayWsUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZCODE_BASE_URL?: string;
  ZCODE_ENDPOINT_ORIGIN?: string;
  ZCODE_TEST_BASE_URL?: string;
  ZCODE_PRODUCTION_BASE_URL?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
  BIGMODEL_TEST_API_BASE_URL?: string;
  BIGMODEL_PRODUCTION_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_TEST_OAUTH_ORIGIN?: string;
  ZAI_PRODUCTION_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_TEST_BUSINESS_BASE_URL?: string;
  ZAI_PRODUCTION_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_TEST_OAUTH_CLIENT_ID?: string;
  ZAI_PRODUCTION_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readRuntimeZCodeEnvScopedValue(
  env: Record<string, string | undefined>,
  zcodeEnv: ZCodeEnv,
  testKey: string,
  productionKey: string,
): string | undefined {
  return readRuntimeEnvValue(env, zcodeEnv === "production" ? productionKey : testKey);
}

// [契约] 本函数是全部 origin 的唯一收口：入参可以是完整 URL，返回一定是 scheme 加 host 加 port。
// 空串或纯空白直接抛错，不静默回落默认域：配置错误必须在启动期暴露，而不是运行期打到错误主机。
// [失败路径] 非 http/https 协议抛错，阻止 file: 等协议被当成合法后端。
// 解析器抛出的异常原样向上抛，由调用方决定是否兜底，本函数不吞错。
export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

// 回环判定只认这三种写法：0.0.0.0 与 IPv4 映射地址不视为回环，避免扩大 e2e 信任面。
// 主机名比较区分大小写，URL 解析阶段已做小写规范化，这里不再重复处理。
// [权衡] 该判定只服务 e2e 联调，不得用于生产安全判断。
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// 用于决定 webview 能否加载 Coding Plan 页面；返回 false 表示拒绝，不抛错干扰调用方。
// 白名单是硬编码的：默认域、测试域、本地 webview 域；新增来源必须改代码而不是加环境变量。
// [失败路径] 解析异常一律吞掉并返回 false，畸形字符串不会被当成受信来源。
export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    if (
      origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN ||
      origin === TEST_ZCODE_ENDPOINT_ORIGIN ||
      origin === CODING_PLAN_LOCAL_WEBVIEW_ORIGIN
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

// 三路输入：production 只看 envBaseOrigin；其他环境 overrideOrigin 优先，其次 envBaseOrigin。
// [契约] env 缺省为 test 属于历史行为：桌面调试不传 env 时默认连测试域。
// production 分支故意忽略 overrideOrigin，正式包不允许被外部注入改域。
// 两个分支最终都走 normalizeZCodeEndpointOrigin，保证返回格式一致。
export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const env = options?.env ?? "test";
  const envBaseOrigin = options?.envBaseOrigin?.trim();
  // [事务] production 判定必须发生在 override 之前，顺序颠倒等于给正式包开了改域后门。
  // envBaseOrigin 经 trim 后为空串时按未配置处理，回落生产默认域。
  // 不要在此处补 override 支持：override 只用于测试与本地联调。
  if (env === "production") {
    return envBaseOrigin
      ? normalizeZCodeEndpointOrigin(envBaseOrigin)
      : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  }

  const overrideOrigin = options?.overrideOrigin?.trim();
  if (overrideOrigin) {
    return normalizeZCodeEndpointOrigin(overrideOrigin);
  }

  return envBaseOrigin ? normalizeZCodeEndpointOrigin(envBaseOrigin) : TEST_ZCODE_ENDPOINT_ORIGIN;
}

export function resolveRuntimeZCodeEnv(env: RuntimeZCodeEndpointEnv = {}): ZCodeEnv {
  // 独立 CLI / 服务测试未注入 ZCODE_ENV 时默认生产域；桌面测试包会显式下发 ZCODE_ENV=test。
  // [契约] 只有显式 test 才进入测试环境，其余任何值（含空串、拼写错误）都按 production 处理。
  // `ZCODE_ENV` 漏注入时回落 `production` 是安全默认：宁可连生产域，也不让正式用户落到测试后端。
  // trim 与 toLowerCase 让带空格或大写的 TEST 也被识别，避免部署脚本写错导致环境错乱。
  // 桌面测试包会显式下发 ZCODE_ENV=test，其他进程不要依赖这里的猜测。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

// 把「环境选择、变量优先级、归一化」合成一次调用，返回值可直接拼路径。
// [契约] 优先级固定为 ZCODE_BASE_URL、ZCODE_ENDPOINT_ORIGIN、分环境 BASE_URL，顺序即灰度覆盖语义，不可调换。
// 分环境变量由 resolveRuntimeZCodeEnv 的结果决定，测试环境不会读取 PRODUCTION 变量。
// overrideOrigin 只在非生产生效，最终仍由 resolveZCodeEndpointOrigin 统一裁决。
export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = {},
  options?: { overrideOrigin?: string | null },
): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "ZCODE_PRODUCTION_BASE_URL")
      : readRuntimeEnvValue(env, "ZCODE_TEST_BASE_URL");

  return resolveZCodeEndpointOrigin({
    env: zcodeEnv,
    envBaseOrigin:
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN") ??
      scopedBaseOrigin,
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = {},
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

// 只在必要时补前导斜杠，规避 originapi 与双斜杠两种典型拼接错误。
// [契约] 每次调用都重新解析 origin，不做缓存，env 变更后下一次调用立即生效。
// path 不做 URL 编码：入参已是路径片段，编码责任在上游。
export function buildRuntimeZCodeApiUrl(env: RuntimeZCodeEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveRuntimeZCodeEndpointOrigin(env)}${normalizedPath}`;
}

// overrideUrl 原样返回且不做协议校验：它来自用户显式配置的中继，信任边界在配置层。
// 未给 override 时以 endpointOrigin 或默认域为基准，把 http/https 映射为 ws/wss。
// [契约] 路径固定为 /api/v1/remote/ws2，必须与 buildZCodeEndpointUrls 的 relayWsUrl 保持一致。
// [失败路径] endpointOrigin 非法会抛错而不是静默回落，避免连到错误中继后无限重连。
export function resolveWebRemoteControlRelayWsUrl(options?: {
  endpointOrigin?: string | null | undefined;
  overrideUrl?: string | null | undefined;
}): string {
  const overrideUrl = options?.overrideUrl?.trim();
  if (overrideUrl) {
    return overrideUrl;
  }

  const origin = new URL(
    normalizeZCodeEndpointOrigin(options?.endpointOrigin?.trim() || DEFAULT_ZCODE_ENDPOINT_ORIGIN),
  );
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  // [契约] 直接覆写 pathname，中继路径只能由这里决定，调用方传入的子路径会被丢弃。
  // 协议已按 origin 映射，主机名与端口沿用端点域，保证中继与 API 同域。
  // 改这条路径必须与后端中继路由同步，否则握手 404、远控持续重连。
  origin.pathname = "/api/v1/remote/ws2";
  return origin.toString();
}

// BigModel 与 ZCode 是两个独立后端，解析链路刻意不复用，变量名与默认域都不同。
// 返回顺序：BIGMODEL_API_BASE_URL、分环境 BASE_URL、按环境选择的默认域。
// [契约] 结果必须经过归一化，非法值抛错而不是回落，防止坏配置被带到 Coding Plan 页面。
// 该值直接决定 Coding Plan 管理页地址，测试环境写死生产域会把测试账号带到生产套餐页。
export function resolveBigModelApiOrigin(env: RuntimeBigModelApiEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedBaseOrigin =
    zcodeEnv === "production"
      ? readRuntimeEnvValue(env, "BIGMODEL_PRODUCTION_API_BASE_URL")
      : readRuntimeEnvValue(env, "BIGMODEL_TEST_API_BASE_URL");
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_BIGMODEL_API_ORIGIN : TEST_BIGMODEL_API_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL") ?? scopedBaseOrigin ?? fallbackOrigin,
  );
}

export function buildBigModelApiUrl(env: RuntimeBigModelApiEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveBigModelApiOrigin(env)}${normalizedPath}`;
}

export function buildBigModelCodingPlanPersonalManageUrl(env: RuntimeBigModelApiEnv = {}): string {
  // 修复原因：BigModel Coding Plan 管理页要跟随 ZCODE_ENV；
  // 测试环境如果继续写死 bigmodel.cn，会把测试账号带到生产套餐页。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(env: RuntimeBigModelApiEnv = {}): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_ORIGIN",
    "ZAI_PRODUCTION_OAUTH_ORIGIN",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_ORIGIN : TEST_ZAI_OAUTH_ORIGIN;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN") ?? scopedOrigin ?? fallbackOrigin,
  );
}

export function resolveZaiBusinessBaseUrl(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedOrigin = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_BUSINESS_BASE_URL",
    "ZAI_PRODUCTION_BUSINESS_BASE_URL",
  );
  const fallbackOrigin =
    zcodeEnv === "production" ? DEFAULT_ZAI_BUSINESS_BASE_URL : TEST_ZAI_BUSINESS_BASE_URL;

  return normalizeZCodeEndpointOrigin(
    readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL") ?? scopedOrigin ?? fallbackOrigin,
  );
}

// 取值顺序：显式 ZAI_OAUTH_CLIENT_ID、分环境 CLIENT_ID、旧版 ZAI_OAUTH_APP_ID、内置默认值。
// [契约] 旧 APP_ID 只是兼容历史部署的后备项，必须排在 CLIENT_ID 之后，否则新配置永不生效。
// client id 不做归一化，空串由 readRuntimeEnvValue 统一视为未设置后继续回落。
// 生产与测试当前取同一字面量，但分别由 DEFAULT_ 与 TEST_ 承载，独立化时不要合并。
export function resolveZaiOAuthClientId(env: RuntimeZaiEndpointEnv = {}): string {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const scopedClientId = readRuntimeZCodeEnvScopedValue(
    env,
    zcodeEnv,
    "ZAI_TEST_OAUTH_CLIENT_ID",
    "ZAI_PRODUCTION_OAUTH_CLIENT_ID",
  );
  const fallbackClientId =
    zcodeEnv === "production" ? DEFAULT_ZAI_OAUTH_CLIENT_ID : TEST_ZAI_OAUTH_CLIENT_ID;

  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    scopedClientId ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    fallbackClientId
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeZCodeEndpointOrigin(origin)}${normalizedPath}`;
}

export function buildRuntimeZaiOAuthUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(env: RuntimeZaiEndpointEnv = {}, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${resolveZaiBusinessBaseUrl(env)}${normalizedPath}`;
}

// 一次调用产出全部端点事实，供启动期注入与配置快照使用，避免各处重复解析产生分歧。
// [事务] 七个字段必须来自同一次 env 读取：中途 env 变化不应让 zcode 与 bigmodel 落在不同环境。
// zcodeEnv 只解析一次并向下传递，子解析函数读取同一个 env 对象，结果天然一致。
// [契约] 返回对象是快照而非视图：调用方修改它不影响后续解析，反之亦然。
// 这里不缓存也不订阅 env 变化，需要热更新时由上层重新调用。
export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = {},
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

// 本函数把 origin 展开成客户端需要的全部 URL，是「域到路由表」的唯一映射点。
// [契约] 所有路径以 /api/v1 或 /remote 开头，禁止尾随斜杠，否则回调地址会多一层。
// [权衡] remoteUrl 按版本在 v3 与 v4 间切换，webRemoteCallbackUrl 恒为 /remote/v4：网页回调由服务端固定路由承接。
// relayWsUrl 用 ws/wss 前缀加 host，不带协议路径前缀，保证与 WebSocket 服务端一致。
// 新增字段要先加进 ZCodeEndpointUrls 接口并同步所有构造点，否则消费方取到 undefined。
export function buildZCodeEndpointUrls(
  origin: string,
  options: BuildZCodeEndpointUrlsOptions = {},
): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeZCodeEndpointOrigin(origin);
  const parsed = new URL(normalizedOrigin);
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const wsOrigin = `${wsProtocol}//${parsed.host}`;
  // 无法解析或低于分界版本时保守使用 v3，避免开发版本和旧客户端进入未兼容的 v4 页面。
  const remoteVersion = isWebRemoteControlV4AppVersion(options.appVersion) ? "v4" : "v3";

  return {
    origin: normalizedOrigin,
    apiBaseUrl: `${normalizedOrigin}/api/v1`,
    remoteUrl: `${normalizedOrigin}/remote/${remoteVersion}`,
    webRemoteCallbackUrl: `${normalizedOrigin}/remote/v4`,
    webShareCallbackUrl: `${normalizedOrigin}/cn/share/callback`,
    relayWsUrl: `${wsOrigin}/api/v1/remote/ws2`,
    zcodePlanOpenAiBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan`,
    zcodePlanAnthropicBaseUrl: `${normalizedOrigin}/api/v1/zcode-plan/anthropic`,
    zcodePlanBillingCurrentUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/current`,
    zcodePlanBillingBalanceUrl: `${normalizedOrigin}/api/v1/zcode-plan/billing/balance`,
  };
}

// 用于把硬编码默认域的链接改写到当前端点域，典型场景是分享链接与历史消息里的绝对 URL。
// [契约] 源域固定为 DEFAULT_ZCODE_ENDPOINT_ORIGIN：只改写官方默认域的链接，不碰第三方域。
// 目标域与源域相同时直接返回入参，避免无意义的重新序列化改变字符串形态。
// [契约] 入参为 URL 且发生改写时返回新字符串，未改写时原样返回原对象，调用方勿假定类型。
// [失败路径] 无法解析的字符串原样返回且不抛错，调用方可能正在处理用户输入的畸形链接。
export function rewriteZCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  const sourceOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
  if (parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
