// INV-01 官网信任判定统一走 isTrustedCodingPlanWebviewOrigin：守住凭证注入入口，改错会让任意域名拿到 token
// INV-02 本地回退同时要求 dev 与 zcodeEnv 为 test：守住生产环境，改错会连到未启动的 localhost:3000
// INV-03 endpointOrigin 非法即降级 DEFAULT_ZCODE_ENDPOINT_ORIGIN：守住返回值可信，改错会返回空串或外域
// INV-04 注入 URL 固定 /coding-plan 路径且先归一化 origin：守住路径拼接，改错会产生双斜杠或错路径
// INV-05 首屏 theme 必须随 URL 下发：守住首帧观感，改错会让官网 SSR 先渲染 dark 再跳变
// INV-06 locale 只映射 cn 或 en：守住语言段合法，改错会出现第三段导致官网无法解析
// INV-07 payment/callback 依赖 returnTo 校验：守住 subscribe 回跳，改错会在回调页丢失注入
// INV-08 returnTo 不得再指向 payment/callback：守住回跳收敛，改错会形成自引用导致循环判定
// INV-09 URL 解析失败必须返回 false：守住异常边界，改错会把异常抛给调用方中断流程
// INV-10 注入脚本是纯 JS 字符串：守住 webview 可执行性，改错写入 TS 语法会运行时报 SyntaxError
// INV-11 zai 分支把 bigmodel token 置 null：守住 provider 隔离，改错会跨站点泄漏凭证
// INV-12 bigmodel 分支仍注入 zcodejwttoken：守住 Start Plan 权益查询，改错会让官网误显示已过期
// INV-13 凭证写入前 trim 且空串落 null：守住存储干净，改错会写入空白 token 被官网当成已登录
// INV-14 上报上下文只保留非空字符串：守住上报语义，改错会让 undefined 或空串污染漏斗数据
// INV-15 purchase_entry_reporter 需 funnelContext 存在：守住归属标记，改错会让官网重复上报入口事件
// INV-16 清凭证同时清报告上下文与 window 字段：守住退出登录边界，改错会残留上一账号漏斗身份
// INV-17 滚动条脚本以固定 styleId 幂等：守住重复注入安全，改错会叠加多个 style 节点
// INV-18 语言切换必须派发 zcode-coding-plan-lang-change：守住官网监听契约，改错会让切换静默失效
//
// 模块职责：为 Coding Plan 嵌入式官网 webview 解析可信 origin、拼装首屏 URL、生成鉴权与语言注入脚本并收敛上报上下文。
// 状态所有权：本模块只做纯函数转换，不持有状态；locale、theme、凭证均由调用方读取后传入。
// 阅读顺序：先看文件头 INV 列表，再依次阅读 origin 解析、URL 拼装、信任校验、注入脚本生成。
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  isTrustedCodingPlanWebviewOrigin,
  isZaiCodingPlanProviderId,
  normalizeZCodeEndpointOrigin,
  type ZCodeEnv,
  ZCODE_ENV,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { CodingPlanWebviewLocale } from "@zcode/shared";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

// 官网只有 zai 与 bigmodel 两个购买站点，类型收窄可让下游分支全部穷尽
// CodingPlanPurchaseAudience 区分个人与团队，决定官网默认落在哪个套餐页
// 取值改错会让 URL 的 provider 与 audience 参数指向错误站点，用户看到错误价格
export type CodingPlanWebsiteProvider = "zai" | "bigmodel";
export type CodingPlanPurchaseAudience = "personal" | "team";

export interface CodingPlanEmbeddedCredentials {
  zaiAccessToken?: string | null;
  zcodeJwtToken?: string | null;
  bigmodelAccessToken?: string | null;
}

// 上报上下文字段全部可选，缺省时官网按自有默认值处理，App 不补空串
// 字段名使用 snake_case 与官网约定对齐，改名等于静默丢数据
// 该结构同时写入 localStorage 与 window，官网刷新后仍能读到同一次进入的漏斗身份
export interface CodingPlanEmbeddedReportContext {
  purchase_funnel_id?: string;
  purchase_entry_reporter?: "app";
  upgrade_source?: string;
  event_region?: string;
  event_text?: string;
  entry_plan_status?: string;
  entry_plan_level?: string;
  entry_plan_list?: string;
  purchase_audience?: string;
  provider_family?: string;
  channel?: string;
  device_mid?: string;
  user_id?: string;
  app_version?: string;
}

export type CodingPlanEmbeddedTheme = "zai-light" | "zai-dark";

/**
 * App locale（zh-CN / en-US）→ 官网 URL lang 段（cn / en）。
 * 用于 webview URL 的 ?lang= hint，让官网首屏就有正确语言，避免注入前的英文闪烁。
 */
// locale 是唯一输入，映射只产出 cn 或 en，防止 URL 出现第三种 lang 段
// 仅 zh-CN 精确匹配返回 cn，其余（含 null 与 undefined 与 en-US）统一 en
// 默认分支写错会让未识别 locale 落空，官网首屏回退到服务端猜测语言
export function codingPlanLocaleToWebsiteLang(
  locale: CodingPlanWebviewLocale | null | undefined,
): "cn" | "en" {
  return locale === "zh-CN" ? "cn" : "en";
}

export interface ResolveCodingPlanEmbeddedOriginOptions {
  dev: boolean;
  endpointOrigin: string;
  e2eStoreBridgeEnabled?: boolean;
  overrideOrigin?: string | null;
  zcodeEnv?: ZCodeEnv;
}

export const CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY = "VITE_CODING_PLAN_WEBVIEW_ORIGIN";
const CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS = [
  "oauth:zai:access_token",
  "zcodejwttoken",
  "oauth:bigmodel:access_token",
] as const;
const CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY = "zcode:coding-plan:report-context";

export function resolveCodingPlanWebsiteProvider(
  providerId: CodingPlanProviderId,
): CodingPlanWebsiteProvider {
  return isZaiCodingPlanProviderId(providerId) ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "zai"
    : "bigmodel";
}

// 优先级依次为显式 override、本地 test 环境、endpointOrigin、官方默认域
// override 必须先过 isTrustedCodingPlanWebviewOrigin，否则等于把注入能力交给任意域名
// 本地回退要求 dev 与 zcodeEnv 为 test 同时成立，只满足其一会连到未启动的官网本地页
// endpointOrigin 非法时降级 DEFAULT_ZCODE_ENDPOINT_ORIGIN，保证返回值始终可信
export function resolveCodingPlanEmbeddedOrigin({
  dev,
  endpointOrigin,
  e2eStoreBridgeEnabled,
  overrideOrigin,
  zcodeEnv = ZCODE_ENV,
}: ResolveCodingPlanEmbeddedOriginOptions): string {
  const normalizedOverride = overrideOrigin?.trim();
  if (
    normalizedOverride &&
    isTrustedCodingPlanWebviewOrigin(normalizedOverride, { e2eStoreBridgeEnabled })
  ) {
    return normalizeZCodeEndpointOrigin(normalizedOverride);
  }
  // Bug 原因：本地开发默认注入 ZCODE_ENV=production，不能仅凭 Vite DEV 就打开未启动的官网本地页。
  if (dev && zcodeEnv === "test") {
    return "http://localhost:3000";
  }
  const normalizedEndpointOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  return isTrustedCodingPlanWebviewOrigin(normalizedEndpointOrigin, { e2eStoreBridgeEnabled })
    ? normalizedEndpointOrigin
    : DEFAULT_ZCODE_ENDPOINT_ORIGIN;
}

// URL 基于归一化 origin 拼 /coding-plan，origin 末尾斜杠不会产生双斜杠路径
// embedded=app 是官网识别 App 内嵌态的唯一开关，缺失会退化成外链式导航
// theme 只在传入时写入，官网 head 脚本可据此在首帧 paint 前应用深浅色
// teamPlanKey 仅在 trim 后非空时拼入，避免空参覆盖官网的默认套餐选择
export function buildCodingPlanEmbeddedWebviewUrl({
  origin,
  provider,
  locale,
  theme,
  audience,
  teamPlanKey,
}: {
  origin: string;
  provider: CodingPlanWebsiteProvider;
  // 传入 App 当前 locale，作为官网首屏语言 hint（?lang=cn|en），避免注入前的英文闪烁。
  locale?: CodingPlanWebviewLocale | null;
  // 官网 SSR 默认 dark；首次打开 WebView 时 localStorage 还没有主题，
  // 必须把 App 当前主题同步放进 URL，让官网 head 脚本在首帧 paint 前读到。
  theme?: CodingPlanEmbeddedTheme | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
}): string {
  const url = new URL("/coding-plan", normalizeZCodeEndpointOrigin(origin));
  url.searchParams.set("provider", provider);
  url.searchParams.set("embedded", "app");
  url.searchParams.set("lang", codingPlanLocaleToWebsiteLang(locale));
  if (audience) {
    url.searchParams.set("audience", audience);
  }
  if (teamPlanKey?.trim()) {
    url.searchParams.set("teamPlanKey", teamPlanKey.trim());
  }
  if (theme) {
    url.searchParams.set("theme", theme);
  }
  return url.toString();
}

// 只接受 http 与 https，其它协议一律判不可信，避免 file 或自定义 scheme 混入
// embedded=app 的 coding-plan 页直接放行，这是 App 正常注入的主路径
// payment/callback 需 returnTo 指向同源 coding-plan 且带 embedded=app，才允许注入完成 subscribe
// 解析异常统一吞掉返回 false，信任判定绝不能把异常抛给调用方
export function isTrustedCodingPlanEmbeddedWebviewUrl(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: options?.e2eStoreBridgeEnabled,
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    if (url.searchParams.get("embedded") === "app") return true;
    // PayPal 成功后先回到 /coding-plan/payment/callback，embedded=app
    // 在 returnTo 里。该页仍需要 App 注入 OAuth token 完成 subscribe，不能被当作外站清理凭据。
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return (
      target.origin === url.origin &&
      target.pathname.includes("coding-plan") &&
      target.searchParams.get("embedded") === "app" &&
      !target.pathname.endsWith("/coding-plan/payment/callback")
    );
  } catch {
    return false;
  }
}

// 按 provider 二选一写入凭证，zai 分支把 bigmodel token 置 null，隔离两套 OAuth 域
// bigmodel 分支仍需注入 zcodejwttoken，官网靠它查 billing 判定 Start Plan 是否在用
// 凭证先 trim 再落库，空串走 removeItem，避免官网读到空白 token 误判已登录
// 脚本是注入 webview 执行的原始 JS，任何 TS 语法都会在运行时报 SyntaxError
export function createCodingPlanAuthInjectionScript({
  provider,
  credentials,
  theme,
  locale,
  reportContext,
}: {
  provider: CodingPlanWebsiteProvider;
  credentials: CodingPlanEmbeddedCredentials;
  theme: CodingPlanEmbeddedTheme;
  // App 当前 locale，写入 window.__zcodeLang__ 供 zcodeBridge.getLang() 读取，
  // 并附带在 auth-ready 事件 detail 里让官网一次性同步初始语言。
  locale: CodingPlanWebviewLocale | null;
  reportContext?: CodingPlanEmbeddedReportContext | null;
}): string {
  const values: Record<string, string | null> =
    provider === "zai"
      ? {
          "oauth:zai:access_token": credentials.zaiAccessToken?.trim() || null,
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": null,
        }
      : {
          "oauth:zai:access_token": null,
          // zcodejwttoken 是 zcode-plan 域通用凭证（BigModel OAuth callback 同样落盘），
          // 官网用它查 billing/balance 判定 Start Plan 是否使用中；BigModel 分支缺失注入
          // 会导致官网 Start Plan 卡因查不到权益而误显示「已过期」。业务接口仍走
          // oauth:bigmodel:access_token，互不污染。
          zcodejwttoken: credentials.zcodeJwtToken?.trim() || null,
          "oauth:bigmodel:access_token": credentials.bigmodelAccessToken?.trim() || null,
        };
  const storageUpdates = Object.entries(values)
    .map(([key, value]) =>
      value
        ? `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
        : `localStorage.removeItem(${JSON.stringify(key)});`,
    )
    .join("\n  ");
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  const normalizedReportContext = normalizeCodingPlanEmbeddedReportContext(reportContext);

  return `(() => {
  ${storageUpdates}
  const zcodeTheme = ${JSON.stringify(theme)};
  document.documentElement.classList.toggle("dark", zcodeTheme === "zai-dark");
  document.documentElement.classList.toggle("theme-zai-light", zcodeTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", zcodeTheme === "zai-dark");
  localStorage.setItem("zcode-theme", zcodeTheme);
  localStorage.setItem("zcode:coding-plan:embedded", "app");
  // 写入当前 App locale，供官网 zcodeBridge.getLang() 读取。
  // 注意：这是注入 webview 执行的原始 JS，不能用 TS 语法（如 as any）。
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  const zcodeReportContext = ${JSON.stringify(normalizedReportContext)};
  window.__zcodeReportContext__ = zcodeReportContext;
  localStorage.setItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)}, JSON.stringify(zcodeReportContext));
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-auth-ready", {
    detail: { ...${JSON.stringify({ provider, locale: resolvedLocale })}, reportContext: zcodeReportContext },
  }));
})()`;
}

// funnelContext 存在才标记 purchase_entry_reporter 为 app，否则官网会以为是兼容上报入口
// device_mid 与 user_id 与 app_version 由调用方注入，缺失时保持 undefined 而非空串
// 最终统一过 normalize，保证写入官网的上下文无空值、无首尾空格
export function buildCodingPlanEmbeddedReportContext({
  funnelContext,
  deviceMid,
  userId,
  appVersion,
}: {
  funnelContext?: CodingPlanFunnelContext | null;
  deviceMid?: string | null;
  userId?: string | null;
  appVersion?: string | null;
}): CodingPlanEmbeddedReportContext {
  return normalizeCodingPlanEmbeddedReportContext({
    purchase_funnel_id: funnelContext?.purchaseFunnelId,
    // 缺少归属标记会让兼容官网重复上报入口；无漏斗时不能声明 App 已接管。
    purchase_entry_reporter: funnelContext ? "app" : undefined,
    upgrade_source: funnelContext?.upgradeSource,
    event_region: funnelContext?.eventRegion,
    event_text: funnelContext?.eventText,
    entry_plan_status: funnelContext?.entryPlanStatus,
    entry_plan_level: funnelContext?.entryPlanLevel,
    entry_plan_list: funnelContext?.entryPlanList,
    purchase_audience: funnelContext?.purchaseAudience,
    provider_family: funnelContext?.providerFamily,
    channel: funnelContext?.channel,
    device_mid: deviceMid ?? undefined,
    user_id: userId ?? undefined,
    app_version: appVersion ?? undefined,
  });
}

function normalizeCodingPlanEmbeddedReportContext(
  context: CodingPlanEmbeddedReportContext | null | undefined,
): CodingPlanEmbeddedReportContext {
  if (!context) return {};
  return Object.fromEntries(
    Object.entries(context).flatMap(([key, value]) => {
      if (typeof value !== "string") return [];
      const normalized = value.trim();
      return normalized ? [[key, normalized]] : [];
    }),
  ) as CodingPlanEmbeddedReportContext;
}

// 清理范围与注入范围对称：三个凭证键加报告上下文键，缺一都会残留跨账号数据
// 同时 delete window.__zcodeReportContext__，避免官网刷新前继续读到旧漏斗身份
// 清理不区分 provider 全部清除，退出登录时不能留下另一站点的 token
export function createCodingPlanCredentialClearScript(): string {
  const keys = [...CODING_PLAN_WEBVIEW_CREDENTIAL_LOCAL_STORAGE_KEYS];
  return `(() => {
  for (const key of ${JSON.stringify(keys)}) {
    localStorage.removeItem(key);
  }
  localStorage.removeItem(${JSON.stringify(CODING_PLAN_REPORT_CONTEXT_STORAGE_KEY)});
  delete window.__zcodeReportContext__;
})()`;
}

// 通过固定 styleId 判断是否已注入，重复执行不会叠加多个 style 节点
// 选择器同时覆盖标准 scrollbar-width 与 webkit 伪元素，跨平台行为一致
// 样式只在 head 追加，不做 DOM 清理，webview 重载后自然失效无需撤销
export function createCodingPlanScrollbarHideScript(): string {
  return `(() => {
  const styleId = "zcode-coding-plan-hide-scrollbar";
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = \`
html,
body,
* {
  scrollbar-width: none !important;
}

html::-webkit-scrollbar,
body::-webkit-scrollbar,
*::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
\`;
  document.head.appendChild(style);
})()`;
}

/**
 * 生成「更新 webview 当前 locale」的注入脚本。
 * App locale 运行时变化时对 webview executeJavaScript 此脚本：
 * 重写 window.__zcodeLang__ 并派发 zcode-coding-plan-lang-change 事件，
 * 官网侧（zcodeBridge.onLangChange 或 window 监听）据此无感切换语言。
 */
// 运行时切语言只重写 window.__zcodeLang__ 并派发事件，不重载页面
// 事件名 zcode-coding-plan-lang-change 是官网监听契约，改名会让切换静默失效
// locale 归一化与首屏注入一致，非 zh-CN 一律 en-US，避免两处语言态不一致
export function createCodingPlanLangInjectionScript(locale: CodingPlanWebviewLocale): string {
  const resolvedLocale: CodingPlanWebviewLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return `(() => {
  // 注意：注入 webview 执行的原始 JS，不能用 TS 语法（如 as any）。
  window.__zcodeLang__ = ${JSON.stringify(resolvedLocale)};
  window.dispatchEvent(new CustomEvent("zcode-coding-plan-lang-change", {
    detail: ${JSON.stringify({ locale: resolvedLocale })},
  }));
})()`;
}

// 返回键名而非值，调用方按需读取，避免本模块接触存储层
// zcodejwttoken 对两个 provider 都返回，它是 zcode-plan 域通用凭证
// 键名拼接复用 ZAI_PROVIDER_ID 与 BIGMODEL_PROVIDER_ID，硬编码字符串会与落盘键漂移
export function getCodingPlanCredentialKeys(provider: CodingPlanWebsiteProvider): string[] {
  // zcodejwttoken 对两个 provider 都加载：它是 zcode-plan 域通用凭证，
  // BigModel OAuth callback 同样落盘（见 resolveBigModelStartPlanZcodeJwt）。
  return provider === "zai"
    ? [`oauth:${ZAI_PROVIDER_ID}:access_token`, "zcodejwttoken"]
    : [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`, "zcodejwttoken"];
}
