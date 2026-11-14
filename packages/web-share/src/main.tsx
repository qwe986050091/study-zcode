// INV-01 入口先定主题再渲染：守住位置 顶层调用顺序；改错故障 首屏浅色套深色代码块。
// INV-02 无存储值时回退默认主题：守住位置 兜底参数；改错故障 首次访问没有主题。
// INV-03 回调路径分中英两段：守住位置 路径或运算；改错故障 英文站点回调落到落地页。
// INV-04 回调页重试目标可解析：守住位置 安全返回地址；改错故障 重试跳到外部站点。
// INV-05 登录成功优先回跳目标：守住位置 空值合并；改错故障 登录后总回到首页。
// INV-06 分享路径才走分享渲染：守住位置 路径判断；改错故障 任意路径都渲染分享页。
// INV-07 语言写入根元素：守住位置 语言属性；改错故障 读屏按错误语言朗读。
// INV-08 标题随语言切换：守住位置 三元文案；改错故障 中文页显示英文标题。
// INV-09 缺少分享码视为无效：守住位置 空值分支；改错故障 空码也发起请求。
// INV-10 接口地址去掉尾斜杠：守住位置 正则替换；改错故障 出现双斜杠路径。
// INV-11 地址缺失回退当前域：守住位置 空值兜底；改错故障 请求发往错误主机。
// INV-12 模拟模式仅在开发态生效：守住位置 双条件；改错故障 生产环境出现模拟数据。
// INV-13 模拟令牌仅在开关下发放：守住位置 条件判断；改错故障 正式环境接受假令牌。
// INV-14 模拟登录只写会话存储：守住位置 存储位置；改错故障 假身份跨标签页残留。
// INV-15 正式登录带分享回跳地址：守住位置 参数拼接；改错故障 登录后离开分享页。
// INV-16 退出登录后整页重载：守住位置 重载调用；改错故障 界面停留在旧身份。
// INV-17 未知路径落到无效契约提示：守住位置 末尾渲染；改错故障 白屏没有任何说明。
// INV-18 启动函数错误不被吞掉：守住位置 顶层调用；改错故障 初始化失败静默白屏。
//
// 模块职责：会话分享站的独立入口，按路径分派落地页、回调页与分享页。
// 状态所有权：主题与鉴权服务在启动时创建，页面状态交给分享客户端。
// 阅读顺序：先看主题与路径判断，再看回调页，最后看分享页装配。
import { createRoot } from "react-dom/client";
import "../../share-ui/src/styles.css";
import { applyTheme, type Theme } from "../../ui/src/useTheme.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "../../web/src/share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "../../web/src/share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "../../web/src/share/conversationShareRoute.js";
import { resolveWebRemoteControlInitialTheme } from "../../web/src/web-remote-control/adapters/webRemoteControlThemeSeed.js";
import { createWebAuthService } from "../../web/src/auth/webAuthService.js";
import {
  WEB_ZAI_OAUTH_CONFIG,
  resolveWebAuthDevReturnTo,
} from "../../web/src/auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "../../web/src/auth/oauthStateCodec.js";
import { ShareCallbackPage } from "./ShareAuthPages.js";

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// 已存主题优先：localStorage 里有 zcode-theme 时，由它压过默认值。
// 读取只发生在启动这一刻：函数不缓存结果，也不监听 storage 事件。
// 默认值取 zai-light 浅色，具体取舍交给 resolveWebRemoteControlInitialTheme 统一处理。
function resolveThemePreference(): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme: "zai-light" });
}

// Share 是独立入口，不会经过完整 Web 的 bootstrap；必须在渲染前同步根主题 class，
// 否则页面外壳使用默认浅色 token，而 MessageResponse 会按 zai-dark 选择 github-dark，
// 最终产生浅色页面套深色 Markdown 代码块的混合样式。
const INITIAL_THEME = resolveThemePreference();
applyTheme(INITIAL_THEME);

// 回调判定同时认 /cn/share/callback 与 /share/callback 两条路径。
// 比对只取 window.location.pathname，不做前缀或后缀匹配。
// 查询串里的 code 与 state 不参与判断，缺少参数时仍判为回调。
function isOAuthCallback(): boolean {
  return (
    window.location.pathname === "/cn/share/callback" ||
    window.location.pathname === "/share/callback"
  );
}

// 返回地址先经 resolveSafeAppReturnTo 解析，非法或缺失时得到 undefined。
// 解析失败时 retryTarget 回退到分享首页 /share。
// 成功后跳回 onSuccess 给的地址，重试则跳 retryTarget。
function renderCallback(): void {
  const state = parseOAuthState(new URLSearchParams(window.location.search).get("state") ?? "");
  const retryTarget = resolveSafeAppReturnTo(state?.app_return_to) ?? "/share";
  root.render(
    <ShareCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => window.location.replace(appReturnTo ?? "/share")}
      onRetry={() => window.location.replace(retryTarget)}
    />,
  );
}

// locale 同时写入 document.documentElement.lang 与 document.title。
// 路径里取不到分享码时直接渲染 invalid_contract 错误页，不再请求后端。
// 模拟模式需要 DEV 且 VITE_CONVERSATION_SHARE_PREVIEW_MOCK 为 true，生产构建不会启用。
async function renderShare(): Promise<void> {
  const locale = resolveConversationShareRouteLocale(window.location.pathname);
  document.documentElement.lang = locale;
  document.title = locale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";

  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={locale}
      />,
    );
    return;
  }

  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  const client = mockMode
    ? new (
        await import("../../web/src/share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;

  root.render(
    <ConversationShareLandingLoader
      shareCode={shareCode}
      client={client}
      getAccessToken={() => getMockToken() ?? webAuthService.getZCodeJwtToken()}
      onLogin={(provider) => {
        if (mockMode) {
          window.sessionStorage.setItem("zcode:share:mock-auth", "owner");
          window.location.reload();
          return;
        }
        webAuthService.startLogin({
          provider,
          appReturnTo: window.location.href,
          redirectUri: WEB_ZAI_OAUTH_CONFIG.shareRedirectUri,
          devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG, "share"),
        });
      }}
      onLogout={() => {
        if (mockMode) window.sessionStorage.removeItem("zcode:share:mock-auth");
        void webAuthService.logout();
        window.location.reload();
      }}
      locale={locale}
      theme={INITIAL_THEME}
    />,
  );
}

async function main(): Promise<void> {
  if (isOAuthCallback()) {
    renderCallback();
    return;
  }
  if (isConversationSharePath(window.location.pathname)) {
    await renderShare();
    return;
  }
  root.render(
    <ConversationShareLandingStatus state={{ kind: "error", error: "invalid_contract" }} />,
  );
}

void main();
