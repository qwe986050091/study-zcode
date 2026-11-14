// Web 端唯一入口：装配主题、鉴权、分享页与远程控制，并把它们挂到同一个 React root 上。
// 这里只做“编排”，不实现业务；任何具体能力都必须下沉到 ui/client/shared 包。
//
// INV-01：启动顺序固定为「主题 → 动效暂停 → 创建 root → 鉴权服务 → streamClientId → 注册卸载钩子」，
//         换序会让首帧用到未初始化的全局状态（守住它的位置：模块顶部的顺序执行块）。
// INV-02：全应用只有一个 root；任何页面切换都走 root.render，禁止重复 createRoot。
//         （守住它的位置：const root = createRoot(...)）。
// INV-03：streamClientId 必须在首次 React 渲染前写入，否则各 hook 会各自生成 ID。
//         （守住它的位置：setStreamClientId(generateMobileDeviceFingerprint())）。
// INV-04：isPageUnloading 只允许由 beforeunload 置 true，其他路径不得改写；
//         它用于区分“页面正在销毁”与“连接真的断了”（守住它的位置：beforeunload 监听）。
// INV-05：远程控制启动失败必须渲染 FailureScreen，禁止白屏或静默重试。
//         （守住它的位置：renderWebRemoteControlFailure 的调用点）。
// INV-06：workspace 身份只能经 resolveWebRemoteControlWorkspaceKey 推导；
//         同路径不同 identity 是两个工作区，禁止用路径字符串互认。
//         （守住它的位置：markCurrentWebRemoteControlBridgeTaskRead）。
// INV-07：写 task 已读前必须校验目标 workspaceKey 等于当前 bridge 的 key，
//         否则会跨连接改写另一个工作区的未读状态。
// INV-08：平台代理方法只做透传与错误归一，不得在 renderer 侧缓存结果或重放请求。
//         （守住它的位置：WebRemoteControlPlatformProxy 的实现）。
// INV-09：远控路由判定统一走 matchesWebRemoteControlRoutePath / resolveWebRemoteControlRoutePath，
//         组件内不得另写路径前缀比较（守住它的位置：isWebRemoteControlRoute）。
// INV-10：连接恢复超时必须有界（WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS），
//         无界等待会让用户停在 loading 页且无法自救。
// INV-11：失败页的主/次动作按 failure.reason 分叉；device-not-owned 只能走切换账号，
//         不能走 reload（reload 仍会用同一账号再失败一次）。
// INV-12：主题初始化只读 localStorage，不在此写回；写回权归 UI 的 useTheme。
// INV-13：分享页在无本地主题配置时默认浅色，其它 Web 页面默认深色；
//         这是一条产品约定，不得用统一默认值覆盖（守住它的位置：resolveWebThemePreference 调用）。
// INV-14：OAuth 回调判定必须同时覆盖远控回调与分享回调两类路径；
//         漏一类会让用户卡在登录页（守住它的位置：isWebOAuthCallback）。
// INV-15：会话分享预览与远控连接互斥：分享路由下不得建立远控连接，
//         否则会在只读页面上拉起源码流并触发鉴权错误。
// INV-16：错误兜底只捕获渲染期异常；异步 rejection 必须就地记录，不能指望 ErrorBoundary。
//         （守住它的位置：AppErrorBoundary 的包裹范围）。
// INV-17：任何全局事件监听都必须在模块生命周期内只注册一次；重复注册会让一次点击
//         触发多份启动逻辑（守住它的位置：模块顶部的 addEventListener 调用）。
import { mobilePluginDiscoveryTelemetrySchema } from "@zcode/shared";
import {
  sessionCreateTelemetrySchema,
  type RendererTelemetryEventPayload,
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  createWebRemoteControlConnectionRecoveryTimeoutFailure,
  resolveWebRemoteControlRelayWsUrl,
  matchesWebRemoteControlRoutePath,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制启动、错误页和 web 平台桥接暂时集中在入口编排。 */
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  ensurePendingTaskDraft,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
  setWebRemoteControlTerminalTransportState,
  type Theme,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "./styles.css";
import {
  connectViaProtocol,
  connectViaWebSocket,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";

import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { WebLoginPage } from "./auth/WebLoginPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import {
  ConversationShareLandingLoader,
  ConversationShareLandingStatus,
} from "./share/ConversationShareLandingPage.js";
import {
  ConversationSharePreviewClient,
  resolveConversationShareRouteLocale,
} from "./share/conversationSharePreviewClient.js";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "./share/conversationShareRoute.js";
import type {
  IPlatformService,
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWorkspaceBridge,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceSwitchOptions,
  WebRemoteControlStatus,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  RemoteTarget,
  ServerRemoteInfo,
} from "@zcode/shared";

import {
  WebRemoteControlEntry,
  isWebRemoteControlOAuthCallback,
  type WebRemoteControlEntryConnection,
  createWebRemoteControlV2TokenClient,
  readKnownDevices,
  createWebRemoteControlDeviceClient,
  createWebRemoteControlBridgeRecoveryRunner,
  getWebRemoteControlBridgeRecoveryRetryDelay,
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlLifecycleRecovery,
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
  resolveWebRemoteControlInitialTheme,
  collectWebRemoteControlMobileDeviceInfo,
  createWebRemoteControlVersionGuard,
  resolveWebRemoteControlRoutePath,
  registerWebRemoteControlWorkspaceBridgeServices,
  connectWebRemoteControlWorkspaceBridgeServices,
  replayWebRemoteControlWorkspaceBridgeFrames,
  createWebRemoteControlTaskViewPublisher,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "#src/web-remote-control/index.js";

import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlLoadingScreen,
  type WebRemoteControlConnectingDevice,
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
  showWebRemoteControlVersionNotice,
} from "#src/web-remote-control/views.js";

type RootServices = Parameters<typeof Root>[0]["services"];
type ServiceMethod = (...args: any[]) => unknown;

// [失败路径] 已读写入失败只记录不抛出：这是后台补偿动作，抛出去会打断
// 用户正在进行的导航或渲染（守住它：logWebRemoteControlTaskReadFailure 的调用点）。
function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

// [并发] 这个函数同时被“打开任务”与“bridge 初始任务”两条路径调用，必须自己
// 校验 workspaceKey：调用方拿到的 task 可能来自另一条连接。
// [事务] unreadAt 非数字表示该任务本就没有未读态，直接返回而不是写 0：
// 写入 0 会把“从未读过”伪造成“读过了”。
// [失败路径] 失败只降级为警告日志，已读是弱一致状态，下次进入会自然重试。
async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // 修复原因：同路径 remote workspace 可能属于不同 identity，禁止误用当前 bridge 写另一条连接。
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  // [事务] expectedUnreadAt 作为乐观锁：只有服务端未读态仍等于它时才写入，
  // 避免把用户在别处新产生的未读消息误标为已读。
  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

// [权衡] 这个包装层只为“bridge 当前任务”服务：它把 bridge 语义收敛成
// markWebRemoteControlBridgeTaskRead 的入参，避免调用方各自拼装 target。
// [失败路径] 失败日志里的 taskId 允许缺省为 unknown，日志不能因为缺字段而抛错。
async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

// [事务] 主题解析只读存储，不回写：回写权归 useTheme，否则首帧会覆盖用户
// 在设置页刚做的选择。
// [权衡] 默认主题由调用方传入：分享页需要浅色默认，其它页面需要深色默认，
// 在这里写死任何一方都会让另一方的首帧闪一下。
function resolveWebThemePreference(defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
// [资源] 这段同步脚本必须在 React 挂载前执行：晚于首帧会出现一次白底闪屏。
// [事务] 先算出 resolved（dark/light）再算 appliedTheme（zai-dark/zai-light），
// 两个类各司其职，不能合并：resolved 控制原生配色，appliedTheme 控制品牌皮肤。
// [失败路径] localStorage 不可用（隐私模式）时 resolveWebThemePreference 会回落默认，
// 此处不得抛错，否则整个入口停摆。
// [并发] 只 toggle class，不写 style，避免与 useTheme 后续接管时产生内联样式残留。
{
  // 分享页没有本地主题配置时使用浅色，已有配置仍然沿用；其他 Web 页面继续默认深色。
  const saved = resolveWebThemePreference(
    isConversationSharePath(window.location.pathname) ? "zai-light" : undefined,
  );
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

// [权衡] feedback 地址来自远端的帮助配置，允许失败为空：入口不应该因为
// 一个可选链接把所有页面卡住（守住它：调用方对 undefined 的处理）。
async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

// 浏览器标签页 / 手机切后台时禁用 CSS 动画，避免 DocumentTimeline 持有已卸载的 DOM 子树。
// [资源] 动效暂停必须在创建 root 之前安装：晚一步会让首屏动画先在后台标签页
// 跑起来，DocumentTimeline 持有已卸载 DOM。
// [事务] root、鉴权服务、卸载标记三者在这里按固定顺序初始化，任何异步初始化
// 都不能插到它们之间（守住 INV-01）。
// [并发] isPageUnloading 是模块级单例：重连逻辑读取它来判断“断线是否由关页引起”。
installDocumentHiddenMotionPause();
// [事务] root 在模块顶层创建，之后所有页面切换都复用同一个实例（守住 INV-02）；
// 任何地方都不得再 createRoot，否则会同时存在两棵 React 树并各自持有监听。
const root = createRoot(document.getElementById("root")!);
// [事务] 鉴权服务必须早于任何页面渲染创建：远控与分享页都会在首帧读取登录态，
// 晚创建会让首屏短暂落到未登录分支。
const webAuthService = createWebAuthService();
let isPageUnloading = false;

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

window.addEventListener("beforeunload", () => {
  isPageUnloading = true;
});

// [权衡] 平台代理是 renderer 与宿主之间唯一的通道：方法集合必须与
// WebRemoteControlPlatformMethod 保持一一对应，新增方法先改 shared 类型。
// [事务] 代理不缓存任何返回值：宿主状态随时可能被另一端改变，缓存会让 UI 读到
// 过期的工作区/设备信息。
// [失败路径] 方法调用失败必须 reject 而不是返回伪造默认值，由调用方决定降级。
interface WebRemoteControlPlatformProxy {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]>;
}

// [事务] bootstrap 结果是一次性握手快照：wsUrl 必填，其余是可选的首屏定位信息；
// 不得把这里的字段当作长期状态回读（长期状态以 snapshot 为准）。
// [并发] initialWorkspaceAbsPath 与 initialWorkspaceIdentity 必须成对使用，
// 只带路径会让同路径不同 identity 的工作区被误认。
interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

// [失败路径] 失败页是远控链路的最终兜底：任何启动阶段失败都必须汇到这里，
// 不允许停留在 loading 页或空白页（守住 INV-05）。
// [事务] 主/次动作按 reason 分叉：device-not-owned 的主动作是切换账号而不是
// reload，reload 会用同一账号再失败一次（守住 INV-11）。
// [并发] 失败页复用同一个 root：直接 render 覆盖当前界面，不另建 React 树。
function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      primaryActionLabel={
        failure.reason === "device-not-owned"
          ? isZhLocale()
            ? "切换账号"
            : "Switch account"
          : undefined
      }
      secondaryAction={
        isWebRemoteControlRoute()
          ? {
              label: isZhLocale() ? "选择其他设备" : "Choose another device",
              onClick: () => {
                void remoteEntry.chooseOtherDevice();
              },
            }
          : undefined
      }
      onReload={() => {
        if (failure.reason === "device-not-owned") void remoteEntry.switchAccount();
        else window.location.reload();
      }}
    />,
  );
}

// [事务] OAuth 回调必须同时覆盖远控回调与分享回调两类路径（守住 INV-14）：
// 只认一类会让另一类用户停在登录页反复登录。
// [失败路径] 分享回调允许 authCode 存在：BigModel 的授权码要先进入回调页，
// 由 provider 归一化成 code，不能在这里提前判定为非法。
// [并发] 判定只读 URL，不消费 query：真正的消费由回调页完成，提前清理会丢参数。
function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    isWebRemoteControlOAuthCallback(new URL(window.location.href)) ||
    (["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
      params.has("state") &&
      // BigModel 的 authCode 要先进入回调页，才能由 provider 归一化为 code。
      (params.has("code") || params.has("authCode") || params.has("error")))
  );
}

// [事务] 回调页的 app_return_to 必须先过 resolveSafeAppReturnTo：这是防开放跳转的
// 唯一关卡，直接使用 query 参数会把用户送到任意域名。
// [失败路径] state 解析失败时 retry 目标回落 /remote/v4，而不是报错退出：
// 用户至少还有一条可走的重试路径。
// [并发] 成功后用 location.replace 而不是 assign：回调页不应留在历史栈里，
// 否则用户按返回会再次触发一次性 code 的兑换。
function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/remote/v4");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/remote/v4");
      }}
    />,
  );
}

// [事务] 分享页与远控连接互斥（守住 INV-15）：本函数只装配只读预览客户端，
// 绝不能在其中建立远控连接。
// [失败路径] share code 缺失时直接渲染 error 态，不请求后端：无 code 的请求
// 只会得到 404，还会污染服务端指标。
// [权衡] 页面语言与 title 在渲染前同步设置：晚于首帧会让读屏与浏览器翻译
// 用错误语言朗读页面（守住 INV-13 的分享页语义）。
async function renderConversationSharePage(): Promise<void> {
  // 页面语言跟随路径前缀：/cn/share 中文，裸 /share 英文。
  const routeLocale = resolveConversationShareRouteLocale(window.location.pathname);
  // index.html 固定 lang="en"；不同步会让中文分享页对无障碍与浏览器翻译都报错语言。
  document.documentElement.lang = routeLocale;
  // 分享页必须设置 title：否则浏览器标签只显示 index.html 的通用标题。
  // 会话标题要等 preview 加载完，先给一个语言正确的兜底。
  document.title = routeLocale === "zh-CN" ? "ZCode 会话分享" : "ZCode Conversation Share";
  const shareCode = resolveConversationShareCodeFromPath(window.location.pathname);
  if (!shareCode) {
    root.render(
      <ConversationShareLandingStatus
        state={{ kind: "error", error: "invalid_contract" }}
        locale={routeLocale}
      />,
    );
    return;
  }

  // [事务] endpoint 只从构建期变量读取并去掉尾部斜杠，缺失时回落当前 origin：
  // 拼出双斜杠会让 API 网关返回 404 而不是鉴权错误，极难排查。
  // [并发] mock 模式只在 DEV 且显式开关下生效，生产构建不得走 mock 分支。
  const endpointOrigin =
    import.meta.env.VITE_ZCODE_BASE_URL?.trim().replace(/\/+$/u, "") || window.location.origin;
  const mockMode =
    import.meta.env.DEV && import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true";
  // Share 加载失败不能只有通用 network 文案：需要区分 mock、endpoint 配置或跨域 fetch。
  // 这里只记录运行时路由与 endpoint，不记录完整 pathname，避免把 share code 写入日志。
  console.info("[conversation-share-web]", "preview_runtime_initialized", {
    browserOrigin: window.location.origin,
    routeKind: "canonical",
    endpointOrigin,
    transport: mockMode ? "mock" : "fetch",
  });
  // [资源] mock 客户端用动态 import：生产包里不携带 mock 实现，避免把假数据
  // 路径打进线上 bundle。
  const client = mockMode
    ? new (
        await import("./share/mockConversationSharePreviewClient.js")
      ).MockConversationSharePreviewClient()
    : new ConversationSharePreviewClient({ baseUrl: `${endpointOrigin}/api/v1` });
  const getMockToken = () =>
    mockMode && window.sessionStorage.getItem("zcode:share:mock-auth") === "owner"
      ? "mock-owner-token"
      : null;
  // [失败路径] mock 模式的登出只清 sessionStorage 并 reload；真实模式必须走
  // 鉴权服务登出，清本地标记不会让服务端 token 失效。
  const onLogout = () => {
    if (mockMode) {
      window.sessionStorage.removeItem("zcode:share:mock-auth");
      window.location.reload();
      return;
    }
    void webAuthService.logout();
  };
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
      onLogout={onLogout}
      locale={routeLocale}
      theme={resolveWebThemePreference("zai-light")}
    />,
  );
}

// [事务] 登录页只负责把 provider 交给 remoteEntry：登录态与跳转逻辑都在
// WebRemoteControlEntry 内，页面不持有第二份。
// [并发] 用 root.render 覆盖当前树而不是新建 root（守住 INV-02）。
function renderWebLoginPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(<WebLoginPage onLogin={(provider) => remoteEntry.startLogin(provider)} />);
}

// 访问 window.localStorage 本身在部分浏览器会抛错，统一包在方法里交给调用方兜底。
// [失败路径] 刻意不在这里 try/catch：调用方需要区分“读取失败”与“没存过”，
// 在这里吞掉会让 remoteEntry 把异常当成空值。
// [资源] 只暴露 getItem/setItem，不把整个 Storage 交出去，防止远控模块清空整站存储。
const webRemoteControlStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

// [事务] remoteEntry 是远控页面状态的唯一编排者：设备列表、登录、回调、失败页
// 全部经它的 onView 分发，外部不得绕过它直接 render 这些页面。
// [并发] subscribeVisible 只上报“从隐藏回到可见”：后台恢复时才需要刷新设备态，
// 每次可见变化都刷新会造成高频请求。
// [失败路径] replaceHref 用 history.replaceState 而不是 location.replace：
// 设备切换不应产生新的历史记录，否则返回键会在设备间来回跳。
// [资源] 每个订阅都返回解绑函数，remoteEntry 卸载时必须调用，避免 visibilitychange
// 监听泄漏（守住 INV-17）。
const remoteEntry = new WebRemoteControlEntry({
  auth: webAuthService,
  getHref: () => window.location.href,
  replaceHref: (href) => window.history.replaceState(window.history.state, "", href),
  storage: webRemoteControlStorage,
  locale: resolveWebRemoteControlScreenLocale(navigator.language),
  devices: createWebRemoteControlDeviceClient(window.location.origin),
  subscribeVisible: (listener) => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  },
  loginOptions: { devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG) },
  token: createWebRemoteControlV2TokenClient(window.location.origin),
  connect: (connection) => {
    void bootstrapExternalRelayWebRemoteControl(connection);
  },
  onView: (view) => {
    if (view.kind === "callback") renderWebAuthCallbackPage();
    else if (view.kind === "login") renderWebLoginPage();
    else if (view.kind === "devices") {
      document.title = "ZCode - Web Remote Control";
      root.render(
        <WebRemoteControlDeviceListPage
          view={view}
          onSelect={(sid) => remoteEntry.selectDevice(sid)}
          onRefresh={() => {
            void remoteEntry.refreshDevices();
          }}
          onSwitchAccount={() => {
            void remoteEntry.switchAccount();
          }}
          locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        />,
      );
    } else if (view.kind === "failure") renderWebRemoteControlFailure(view.failure);
  },
});

// [权衡] 失败对象只保留 reason 与可选 message：结构化错误在这里被压平，
// 避免把内部异常细节带进 UI 文案。
function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

// [事务] Web 平台服务的能力位必须如实声明：canSelectFilePath/本机文件相关能力
// 一律为 false，宿主据此隐藏入口而不是点了才失败。
// [并发] 平台代理是可选的：只有远控场景才有宿主代劳，普通 Web 打开时
// 相关方法必须显式 reject（守住 INV-03 的“不伪造成功”）。
// [失败路径] 不支持的能力返回空值而非抛错：例如 selectDirectory 返回 null，
// 让上层走“用户取消”分支，而不是冒泡成未捕获异常。
function createWebPlatform(options?: {
  externalWebRemoteControlProxy?: WebRemoteControlPlatformProxy;
}): IPlatformService {
  const platformProxy = options?.externalWebRemoteControlProxy;

  return {
    canSelectFilePath: false,
    canOpenLocalFiles: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    // [失败路径] 临时文本附件必须由桌面宿主创建：Web 端没有真实临时目录，
    // 无代理时显式 reject，避免返回一个指向不存在路径的假引用。
    createTempTextAttachment: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("createTempTextAttachment", payload)
        : Promise.reject(new Error("Temporary text attachments require a desktop host")),
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // Bugfix: Web 远程控制模式虽然复用了 web UI，但它背后其实挂着 desktop。
    // 之前这里仍然走普通 web 的 `/api/connect-remote`，既不能命中 desktop main，
    // 也拿不到 remote session 的 MessagePort，结果看起来像“支持”，实际必然失败。
    // 先显式拒绝，避免用户沿着错误链路继续排查；后续如果要支持，需要单独补 remote session 注入协议。
    // [失败路径] 即使挂着宿主代理也返回失败：远控模式下 connectRemote 需要
    // remote session 注入协议，当前链路必然走不通，假装成功只会让用户卡在首屏。
    // [事务] 两条分支的错误文案要可区分（remote-control 与 web），便于定位
    // 是“远控未支持”还是“普通 Web 未支持”。
    // [权衡] 保留 options.kind 拼进错误：不同 target 的失败原因不同，
    // 统一文案会让日志丢掉关键区分度。
    async connectRemote(
      options: RemoteTarget,
      _requestId?: string,
      _context?: {
        workspacePath: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      },
    ) {
      if (platformProxy) {
        return {
          success: false,
          error: `Remote connect is not supported in Web remote control mode yet: ${options.kind}`,
        };
      }

      // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
      // 之前这里虽然能打开 ?remote=<id> 新标签页，但远程 WebSocket 只暴露部分 service，
      // 与 Root/RemoteServiceAccess 需要的完整 accessor 不匹配，最终会在项目向导或首屏卡住。
      return {
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      };
    },
    // [事务] 取消连接在 Web 端没有可取消的对象，返回 resolved 而不是 reject：
    // 调用方在清理阶段统一 await 它，reject 会打断清理。
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    // Web 端不作为 Web 远程控制的发起端，保留空实现以兼容统一接口。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () =>
      Promise.resolve<WebRemoteControlStatus>({
        status: "idle",
      }),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("isDockerAvailable")
        : Promise.resolve(false),
    listWSLDistros: () =>
      platformProxy ? platformProxy.requestPlatformMethod("listWSLDistros") : Promise.resolve([]),
    listDockerContainers: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listDockerContainers")
        : Promise.resolve([]),
    listSSHConfigAliases: () =>
      platformProxy
        ? platformProxy.requestPlatformMethod("listSSHConfigAliases")
        : Promise.resolve([]),
    loadMcpFromUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("loadMcpFromUserDirectory", payload)
        : Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("saveMcpToUserDirectory", payload)
        : Promise.resolve({
            success: false,
            error: "MCP native directory management requires a desktop attachment",
          }),
    migrateLegacyCommonMcp: (payload) =>
      platformProxy
        ? platformProxy.requestPlatformMethod("migrateLegacyCommonMcp", payload)
        : Promise.resolve({
            servers: {},
            totalCount: 0,
            importedCount: 0,
            skippedCount: 0,
          }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      const locale = document.documentElement.lang === "en-US" ? "en-US" : "zh-CN";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    // [事务] 手机端只允许上报两类白名单事件：session_create 与插件发现；
    // 其他事件由 Desktop Host 唯一上报，避免同一事件在两端各记一次。
    // [失败路径] schema 不匹配时静默丢弃而不是透传：宁可少一条指标，
    // 也不能把未校验的 payload 送进宿主。
    reportTelemetryEvent: async (event) => {
      // 手机只开放 session_create 和插件发现事件；管理结果仍由 Desktop Host 唯一上报。
      const parsed = sessionCreateTelemetrySchema
        .or(mobilePluginDiscoveryTelemetrySchema)
        .safeParse(event);
      if (parsed.success) platformProxy?.reportTelemetryEvent?.(parsed.data);
    },
    reportArmsCustomEvent: () => Promise.resolve(),
    // [并发] document.hasFocus() 为真时 showTaskNotification 直接返回：用户已在页面内看到结果，再弹系统通知是噪声。
    // [失败路径] 权限未授予或 API 不存在时直接返回，不申请权限：申请必须由
    // 用户手势触发，在这里申请会被浏览器忽略并留下拒绝记录。
    // [失败路径] 通知与提示音任一失败都静默忽略，通知属于旁路能力，
    // 不能影响任务主流程（守住它：try/catch 的注释）。
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    // [权衡] Web 端没有稳定设备指纹，只能用 platform + 屏幕参数拼一个近似值；
    // 它只用于会话归因，不参与鉴权，因此可以接受碰撞。
    // [失败路径] 逐个字段判 undefined 后再 join，缺字段时降级而不是产出
    // “undefined|undefined”这种污染分组的字符串。
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

// [事务] ws 协议由页面协议推导：https 页面必须用 wss，混用会被浏览器按
// 混合内容拦截（守住它：同源 wsUrl 的拼装）。
function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

// [事务] bootstrap 有两条路径：带 ?remote= 时直接连指定远控会话并立即返回，
// 不带时才向 /api/server-info 询问可用工作区。
// [并发] 直接返回而不等待 server-info：远控会话信息在 URL 里已经完整，
// 多等一次请求只会推迟首屏。
// [失败路径] server-info 请求失败一律回落“仅 wsUrl”，不阻断启动：
// 工作区选择会让用户在页面内重新完成。
// [资源] fetch 使用 no-store：启动信息必须反映当前宿主状态，缓存会连到已关闭的实例。
async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws`;

  if (remoteId) {
    return { wsUrl };
  }

  // [失败路径] 非 2xx 不解析 body，直接返回仅含 wsUrl 的结果：
  // 错误页 HTML 被当成 JSON 解析会抛 SyntaxError，把启动流程带崩。
  try {
    const response = await fetch("/api/server-info", {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl };
  }
}

// [事务] 初始工作区必须由 shared 的纯函数裁决：URL 指定 > 上次记忆 > 首个可用，
// 在这里重写优先级会让 Web 与桌面端选择结果不同。
function selectInitialWebRemoteControlWorkspace(
  snapshot: WebRemoteControlWindowBootstrapResult,
): ReturnType<typeof resolveWebRemoteControlInitialWorkspaceSelection> {
  return resolveWebRemoteControlInitialWorkspaceSelection(snapshot);
}

// [事务] 路由判定同时接受固定前缀与构建期注入的路径（守住 INV-09）：
// 自托管部署会改写前缀，只认 /remote/v4 会让这些实例进不了远控页。
// [并发] 只读 location.pathname，不读 hash：hash 由应用内路由使用。
function isWebRemoteControlRoute(): boolean {
  return (
    matchesWebRemoteControlRoutePath(window.location.pathname, "/remote/v4") ||
    matchesWebRemoteControlRoutePath(
      window.location.pathname,
      resolveWebRemoteControlRoutePath(import.meta.env),
    )
  );
}

// [并发] 每次请求都要新 id：重试必须能与上一次区分，复用 id 会让后端把重试
// 当作幂等重复而丢弃。
// [失败路径] crypto.randomUUID 不可用时退回时间戳 + random，允许极低概率碰撞，
// 但绝不返回空字符串（空 id 会被当成“无请求”）。
function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

// [事务] 稳定 clientId 按 deviceSid 分桶持久化：同一设备刷新页面后必须沿用
// 同一个 id，否则服务端会看到一条新连接而不是重连。
// [并发] 先读后写同一把 key，只在职责链首帧执行一次；并发调用时后写者覆盖
// 前写者，但由于写入值对同一 deviceSid 是稳定的，不会产生漂移。
// [失败路径] localStorage 不可用（iOS 隐私模式）时回落到物理指纹：
// 回落后 clientId 只能由物理指纹派生，刷新或换容器都会变，取舍是先保住首屏可用再谈标识稳定。
function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

// [权衡] Web 端不需要桌面 Host 的那些服务，用具名 stub 代替而不是删掉依赖：
// 让 Root 的入参形状与桌面端保持一致，避免每个调用点判空。
// [失败路径] stub 上的方法统一返回空对象/空数组，不抛错：这些能力在 Web 上
// 属于“未实现”而不是“失败”，抛错会打断无关的渲染。
function createUnsupportedHomeOnlyService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new Error(
          `${serviceName}.${String(property)} is not available before a Web remote control workspace bridge is connected.`,
        );
      },
    },
  ) as T;
}

// [资源] 所有订阅桩共享同一个空 Event 工厂：每次返回新对象会让 Root 每次渲染
// 都认为订阅变化，触发无意义的重订阅。
const emptyHomeOnlyEvent = () => ({ dispose() {} });

// [事务] 这个 Proxy 不是万能桩：已列出的成员走显式实现，未列出的按命名契约分流，
// 三类返回（同步 Event / 异步方法 / undefined）不能混。
// [失败路径] 未列出的方法返回 `async () => undefined` 而不是抛错：
// 首页会顺手调用大量可选 RPC，抛错会让一个未实现的旁路能力炸掉整屏。
// [并发] 返回的 Event 是永不触发的常量，订阅它不会持有任何真实资源。
function createEmptyHomeOnlyService<T extends object>(handlers: Record<string, ServiceMethod>): T {
  return new Proxy(handlers, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }
      if (target[property]) return target[property];
      // Bug 原因：bridge 服务由 ProxyChannel 生成，onDynamicXxx(arg) 同步返回 Event，onXxx 本身是 Event；
      // 这里曾把所有未列出成员都当 RPC 方法返回 Promise，手机 home 侧栏订阅任务事件时直接崩溃。
      // 按同一命名契约返回永不触发的空 Event，不再逐个补订阅兜底。
      if (/^onDynamic[A-Z]/.test(property)) return () => emptyHomeOnlyEvent;
      if (/^on[A-Z]/.test(property)) return emptyHomeOnlyEvent;
      return async () => undefined;
    },
  }) as T;
}

// [事务] 断连状态下的服务集合分两层：能返回“空但合法”结果的能力用具名桩，
// 真正需要 Host 的能力用 unsupported 抛错；两者不可互换。
// [失败路径] unsupported 的错误信息必须带 channel 名：用户看到的通用错误
// 与日志里的具体通道共同定位“哪个能力还没接上”。
// [并发] 所有桩都是无状态闭包，可被多个 Root 实例共享，不需要按会话重建。
// [权衡] 这里刻意不返回 null：Root 的初始化链对 null 没有统一处理，
// 返回空结构比返回 null 更安全。
export function createHomeOnlyWebRemoteControlServices(): RootServices {
  const unsupported = (channel: string) => async () => {
    throw new Error(
      `${channel} is not available before a Web remote control workspace bridge is connected.`,
    );
  };
  const settingService: RootServices["settingService"] = {
    get: async () => ({
      recentProjects: [],
      locale: resolveWebRemoteControlScreenLocale(navigator.language),
    }),
    update: async () => {},
    updateDataBaseDir: async () => {},
  };

  // [事务] Git 摘要必须回填入参的可写路径：上游用它判断“这是哪个工作区的结果”，
  // 返回空字符串会让所有断连工作区看起来是同一个。
  // [失败路径] isGitAvailable/isRepository 恒为 false，UI 据此隐藏 Git 入口，
  // 而不是显示一个永远报错的按钮。
  const emptyGitSummary = (workspacePath: string) => ({
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  });
  // Bugfix: 手机端只有断开的远程 workspace 时，不能为了进入任务首页强行创建 bridge。
  // 这里提供只读/空结果服务，吸收 Root 首屏 OAuth、模型供应商、Git、技能等后台初始化，
  // 避免断连这种预期状态被误报成未处理异常；真正聊天能力仍需重连成功后切到 bridge services。
  // [事务] 任务列表类接口一律返回空集合而不是 null：首页会用 `items.length`
  // 直接取值，null 会抛错并触发错误边界。
  // [失败路径] initialize 返回 available:false 而不是抛错：这是“未连接”的
  // 正常业务态，抛错会被上报成故障。
  // [并发] token usage 用入参 taskId 作为 sessionId 回填，保证调用方
  // 能把结果对回自己请求的那条任务。
  const homeOnlyZCodeTaskService = createEmptyHomeOnlyService<RootServices["zcodeTaskService"]>({
    initialize: async () => ({ available: false }),
    releaseWorkspacePreparation: async () => {},
    checkCodexConnectivity: async () => ({ ok: true }),
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskTokenUsage: async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    listArchivedTasks: async () => [],
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
    getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async () => null,
  });
  return {
    fileService: {
      readdir: unsupported("fileService.readdir"),
      stat: unsupported("fileService.stat"),
      checkFilesExist: unsupported("fileService.checkFilesExist"),
      resolvePath: unsupported("fileService.resolvePath"),
      createDefaultWorkspace: unsupported("fileService.createDefaultWorkspace"),
      ensureConversationWorkspace: unsupported("fileService.ensureConversationWorkspace"),
      createScratchWorkspace: unsupported("fileService.createScratchWorkspace"),
      readTextFile: unsupported("fileService.readTextFile"),
      readMediaPreview: unsupported("fileService.readMediaPreview"),
      readFileRange: unsupported("fileService.readFileRange"),
      readBinaryPreview: unsupported("fileService.readBinaryPreview"),
      searchWorkspaceFiles: unsupported("fileService.searchWorkspaceFiles"),
      listWorkspaceFilesLength: unsupported("fileService.listWorkspaceFilesLength"),
      listWorkspaceFilesRange: unsupported("fileService.listWorkspaceFilesRange"),
      readWorkspaceFileSearchIgnore: unsupported("fileService.readWorkspaceFileSearchIgnore"),
      applyWorkspaceFileSearchIgnoreTransform: unsupported(
        "fileService.applyWorkspaceFileSearchIgnoreTransform",
      ),
      writeWorkspaceFileSearchIgnore: unsupported("fileService.writeWorkspaceFileSearchIgnore"),
    },
    mediaPreviewService:
      createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>(
        "mediaPreviewService",
      ),
    gitService: createEmptyHomeOnlyService<RootServices["gitService"]>({
      getRepositorySummary: async (params: { workspacePath: string }) =>
        emptyGitSummary(params.workspacePath),
      getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
      getLocalBranches: async () => ({ branches: [], currentBranch: null }),
      getChanges: async () => [],
      getIgnoredPaths: async () => [],
      getDiff: async () => ({ sections: [], files: [] }),
      getBranchComparison: async () => ({
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      }),
      getIdentity: async () => ({
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      }),
      refresh: async () => ({ ok: true }),
    }),
    gitCheckpointService:
      createUnsupportedHomeOnlyService<RootServices["gitCheckpointService"]>(
        "gitCheckpointService",
      ),
    systemService: createUnsupportedHomeOnlyService<RootServices["systemService"]>("systemService"),
    terminalService:
      createUnsupportedHomeOnlyService<RootServices["terminalService"]>("terminalService"),
    settingService,
    credentialService: createEmptyHomeOnlyService<RootServices["credentialService"]>({
      load: async () => null,
    }),
    broadcastService: createEmptyHomeOnlyService<RootServices["broadcastService"]>({
      send: async () => {},
    }),
    zcodeTaskService: homeOnlyZCodeTaskService,
    zcodeAgentService: createEmptyHomeOnlyService<RootServices["zcodeAgentService"]>({
      initialize: async (params: { workspacePath: string; workspaceIdentity?: string }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode agent service is not available before workspace bridge is connected.",
      }),
      disposeAll: () => {},
    }),
    zcodeSessionService: createEmptyHomeOnlyService<RootServices["zcodeSessionService"]>({
      initializeWorkspace: async (params: {
        workspacePath: string;
        workspaceIdentity?: string;
      }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode session service is not available before workspace bridge is connected.",
      }),
    }),
    // 分享发布首期只属于 desktop local host；Web 首页和 /remote 不建立独立发布权威。
    conversationShareService: createUnsupportedHomeOnlyService<
      RootServices["conversationShareService"]
    >("conversationShareService"),
    promptAttachmentTransferService: createEmptyHomeOnlyService<
      RootServices["promptAttachmentTransferService"]
    >({
      stage: unsupported("promptAttachmentTransferService.stage"),
      adopt: async () => {},
      cancel: async () => {},
      cleanup: async () => {},
    }),
    botsService: createUnsupportedHomeOnlyService<RootServices["botsService"]>("botsService"),
    fileWatcherService: createEmptyHomeOnlyService<RootServices["fileWatcherService"]>({
      watch: async () => ({ dispose: () => {} }),
    }),
    oauthService: createEmptyHomeOnlyService<RootServices["oauthService"]>({
      getProviders: async () => [],
      getActiveProvider: async () => null,
      restoreCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      restoreSession: async () => null,
      refreshToken: async () => {},
      logout: async () => {},
      logoutAll: async () => {},
      cancelPending: async () => {},
    }),
    providerSettingsService: createEmptyHomeOnlyService<RootServices["providerSettingsService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      refresh: async () => ({ revision: 0, providers: [] }),
      testModelConnectivity: async () => ({ results: [] }),
    }),
    modelSelectionService: createEmptyHomeOnlyService<RootServices["modelSelectionService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
    }),
    sourceServerWorkspaceService: createUnsupportedHomeOnlyService<
      RootServices["sourceServerWorkspaceService"]
    >("sourceServerWorkspaceService"),
    usageStatsService:
      createUnsupportedHomeOnlyService<RootServices["usageStatsService"]>("usageStatsService"),
    codingPlanSubscriptionService: createUnsupportedHomeOnlyService<
      RootServices["codingPlanSubscriptionService"]
    >("codingPlanSubscriptionService"),
    clientConfigService: createEmptyHomeOnlyService<RootServices["clientConfigService"]>({
      getSnapshot: async () => ({
        pluginStoreOrder: null,
        zsrcUrl: null,
        uiPluginRecommendations: [],
      }),
    }),
    // 手机 Web 未连接 shared-host attachment 时禁止直连 scenes HTTP；返回空配置保持首页可用。
    clientScenesService: createEmptyHomeOnlyService<RootServices["clientScenesService"]>({
      list: async () => ({ code: 0, msg: "", data: [] }),
    }),
    // 闲时任务仅桌面本地（D13）；web home-only 环境按不支持处理。
    offPeakTaskService:
      createUnsupportedHomeOnlyService<RootServices["offPeakTaskService"]>("offPeakTaskService"),
    highspeedCardService:
      createUnsupportedHomeOnlyService<RootServices["highspeedCardService"]>(
        "highspeedCardService",
      ),
    skillsService: createEmptyHomeOnlyService<RootServices["skillsService"]>({
      list: async () => ({
        skills: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
        diagnostics: [],
      }),
      buildPromptContext: async ({ prompt }: { prompt: string }) => ({
        prompt,
        activatedSkillNames: [],
      }),
    }),
    skillSyncService:
      createUnsupportedHomeOnlyService<RootServices["skillSyncService"]>("skillSyncService"),
    mcpSyncService:
      createUnsupportedHomeOnlyService<RootServices["mcpSyncService"]>("mcpSyncService"),
    pluginSyncService:
      createUnsupportedHomeOnlyService<RootServices["pluginSyncService"]>("pluginSyncService"),
    pluginsService: createEmptyHomeOnlyService<RootServices["pluginsService"]>({
      list: async () => [],
    }),
    // M5 ③-3：设置页插件管理仅桌面/远控 bridge 可用，Web 首页 fallback 明确报不可用。
    pluginManagementService:
      createUnsupportedHomeOnlyService<RootServices["pluginManagementService"]>(
        "pluginManagementService",
      ),
    subagentsService: createEmptyHomeOnlyService<RootServices["subagentsService"]>({
      list: async () => ({ agents: [], capability: { supported: false } }),
    }),
    commandsService: createEmptyHomeOnlyService<RootServices["commandsService"]>({
      list: async () => ({
        commands: [],
        userCommands: [],
        pluginCommands: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      }),
      setCommandEnabled: async () => undefined,
    }),
    hooksService: createEmptyHomeOnlyService<RootServices["hooksService"]>({
      loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
      saveHooks: async () => undefined,
    }),
    memoryService: createEmptyHomeOnlyService<RootServices["memoryService"]>({
      loadMemory: async () => ({ memory: null }),
      listProjectMemories: async () => [],
    }),
    outputStyleService: createEmptyHomeOnlyService<RootServices["outputStyleService"]>({
      listStyles: async () => ({ styles: [] }),
      getUserStylesDirectory: async () => ({ path: "" }),
    }),
    // Bugfix: feedbackService 成为统一服务接口后，Web 远控首页 fallback 也必须补齐。
    // 断开 bridge 时这里明确报不可用，避免类型通过但运行时误以为空反馈数据。
    feedbackService:
      createUnsupportedHomeOnlyService<RootServices["feedbackService"]>("feedbackService"),
    settingsSyncService:
      createUnsupportedHomeOnlyService<RootServices["settingsSyncService"]>("settingsSyncService"),
  };
}

// [事务] relay 地址由 shared 的解析器统一生成，含 endpoint 前缀与查询参数拼装；
// 在入口手拼字符串会在自托管前缀下连错地址。
function resolveExternalRelayWsUrl(): string {
  return resolveWebRemoteControlRelayWsUrl({ endpointOrigin: window.location.origin });
}

// [权衡] 只用 navigator.language 的前缀判中文：产品暂时只有中英两套文案，
// 引入完整 locale 匹配会让 zh-Hant 等变体落到英文。
function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

// [事务] loading 页与失败页共用同一 root（守住 INV-02），切换时只换 render 的子树。
// [并发] title 在 render 前设置：移动端会把标题作为“正在连接”的唯一可见反馈，
// 晚一帧会让用户先看到上一个页面的标题。
function renderWebRemoteControlLoading(
  state: WebRemoteControlTerminalTransportState,
  device: WebRemoteControlConnectingDevice,
): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebRemoteControlLoadingScreen
      state={state}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      device={device}
    />,
  );
}

// [事务] 远控 bootstrap 是长生命周期的连接编排：先固定 clientId，再建 protocol、
// 申请 bootstrap、注册 bridge、恢复 terminal 传输，最后才渲染 Root。
// [并发] 所有异步步骤都接收 connection.signal：用户切换设备后旧链路必须能被打断，
// 否则两条连接会同时向同一页面 render。
// [失败路径] 任一步失败都收敛到 terminated + renderWebRemoteControlFailure，
// 不允许半初始化状态下继续渲染聊天界面。
// [资源] 函数尾部必须返回清理闭包，解绑 window 监听与 bridge 服务；
// 调用方在切换设备时会执行它（守住 INV-17）。
async function bootstrapExternalRelayWebRemoteControl(
  connection: WebRemoteControlEntryConnection,
): Promise<void> {
  if (connection.signal.aborted) return;
  const { params: relayParams, getToken } = connection;
  seedStableWebRemoteControlClientId(relayParams.deviceSid);
  // 平台只是展示偏好：取本机按 MID 记住的记录，扫码直连的陌生设备显示通用电脑图标。
  const connectingDevice: WebRemoteControlConnectingDevice = {
    name: relayParams.deviceName,
    platform: relayParams.deviceMid
      ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)?.platform
      : undefined,
  };
  // 只由入口 owner 负责取消连接并选设备；不能重启 start()，否则会自动连回最近设备。
  const deviceNavigation = {
    deviceName: relayParams.deviceName,
    devicePlatform: connectingDevice.platform,
    chooseOtherDevice: () => {
      if (!connection.signal.aborted) void remoteEntry.chooseOtherDevice();
    },
  };

  // [事务] bootstrapping / ready / terminated 是三个不同阶段，不能合并：
  // bootstrapping 防重入请求，ready 表示首帧已渲染，terminated 表示链路已死。
  // [并发] terminated 一旦置位，所有回调都必须早退；否则迟到的 relay 帧会继续
  // 写入已经 render 了失败页的 root。
  // [资源] nextBridgeGeneration 单调递增，用来丢弃旧 bridge 的迟到帧（世代号）。
  let bootstrapping = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let bridgeRecoveryRetryAttempt = 0;
  let bridgeRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextBridgeGeneration = 0;
  // [权衡] 只有规范化后的 /remote/v4 才做版本校验：自托管前缀下版本接口可能
  // 根本不存在，强行校验会把正常用户挡在门外。
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  // [事务] 版本守卫先于首帧注册：bootstrap 被拒时必须在渲染任何聊天 UI 之前
  // 就进入“不可用”状态，否则用户会看到一个功能残缺的界面。
  // [并发] navigate 用 location.replace 而不是 assign：版本不匹配是一次性跳转，
  // 留在历史栈里会让返回键反复触发。
  // [失败路径] onMismatch 只展示提示并等待用户确认，不自动刷新：
  // 自动刷新会在用户正在输入时丢失草稿。
  // [资源] disposeVersionNotice 保存通知句柄，链路结束时统一销毁。
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    onAccepted: (result) => {
      if (terminalTransportState === "paired") taskViewPublisher.seed(result.mobileTaskViewEpoch);
    },
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  // [并发] 必须在捕获阶段注册并 stopImmediatePropagation：Root 的全局快捷键
  // 也在 window 上，冒泡阶段拦不住它（守住它：addEventListener 的第三个参数）。
  // [资源] 配套的 removeEventListener 必须带同样的 capture=true，否则解绑无效。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  // [事务] pending* 与 active* 分离是“先准备好再原子切换”：新 protocol/bridge
  // 在 pending 里完成握手，确认后才赋给 active，避免半连接状态被读取。
  // [并发] abort 旧 bridge 必须在切换 active 之前完成，否则新旧两条 bridge
  // 会同时向 Root 推送帧。
  // [资源] 所有可释放对象的句柄都集中在这一段声明，清理闭包按声明逆序释放。
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let pendingRelayProtocol: typeof activeRelayProtocol;
  let pendingBridgeAbort: AbortController | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  // [资源] 监听集合用 Set 而不是数组：同一监听重复订阅必须只保留一份，
  // 否则一次工作区更新会触发多次 render。
  // [并发] 广播前先复制快照，允许监听在回调中退订而不影响本轮遍历。
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();

  // [资源] 返回解绑函数而不是让调用方持有 Set：解绑必须成对且幂等。
  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  // [事务] 宿主回包可能省略 activeWorkspaceKey/activeTaskId，这里用当前值补齐，
  // 避免 UI 因为一次“无变化”的列表刷新而把选中项清空。
  // [并发] 覆盖方向只有 宿主 → 本地 一个方向（activeWorkspaceKey / activeTaskId 同理），禁止本地反向覆盖：反了会让一次列表刷新把选中项写回错误会话。
  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  // [并发] 广播前统一 normalize：所有监听看到的是同一份补齐后的结果，
  // 否则各监听会用自己的 currentWorkspaceKey 补出不同值。
  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  // [权衡] socket-extensions 诊断被显式丢弃：它的载荷是二进制扩展头，
  // 既无诊断价值又会放大帧体积。
  // [失败路径] sendMobileDiagnosticPayload 未就绪时静默跳过：诊断是旁路，
  // 不能因为通道未建立而影响连接状态机。
  // [事务] 所有可选字段用 in 判断后取值，保证 undefined 不会被序列化成字符串。
  const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  // [事务] 失败诊断在 disposeConnection 之前发送：通道一旦释放，这条
  // “最后一帧”就再也发不出去，定位断连原因会失去唯一证据。
  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  // [事务] 错误归一有三层：已是 WebRemoteControlFailure 的直接透传，
  // recover 超时映射为 desktop-disconnected，其余归为 unexpected-error。
  // [失败路径] 必须特判 recover 超时：否则会先落 unknown、再被 waiting timer
  // 判成 invalid-mobile，用户看到前后冲突的两张错误页。
  // [并发] 映射只读错误对象，不修改它；同一 error 可能被多处捕获复用。
  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message === "Web remote control relay did not recover before timeout."
    ) {
      // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
      // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
      // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
      // 保证错误语义单一且稳定。
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  // [事务] dispose 必须幂等且有固定顺序：先停重试定时器，再解绑监听，最后释放
  // protocol/transport/lifecycle；反序会让已释放对象继续回调。
  // [并发] terminated 先置位再释放：释放过程中触发的回调看到 terminated 会直接早退，
  // 避免对半销毁对象再次操作。
  // [资源] 每个句柄释放后立刻置 undefined，防止重复 dispose 或悬空引用。
  // [失败路径] 这里不做 try/catch：dispose 内部实现都要求不抛错，
  // 若真抛错应暴露出来而不是被静默吞掉。
  const disposeConnection = () => {
    if (terminated) return;
    terminated = true;
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    versionGuard.dispose();
    disposeVersionInputGuard();
    disposeVersionNotice?.();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    pendingBridgeAbort?.abort();
    pendingBridgeAbort = undefined;
    pendingRelayProtocol?.dispose();
    pendingRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    lifecycle.dispose();
    window.removeEventListener("beforeunload", disposeConnection);
    connection.signal.removeEventListener("abort", disposeConnection);
  };

  // [事务] 失败渲染走 connection.onFailure 而不是直接 root.render：入口 owner
  // 需要在渲染前完成设备态清理与错误上报。
  // [并发] terminated 或版本不匹配时直接返回：失败页不应覆盖版本提示。
  // [资源] 先 disposeConnection 再回调，保证失败页出现时旧连接已完全释放。
  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) return;
    sendMobileFailureDiagnostic(failure);
    disposeConnection();
    connection.onFailure(failure);
  };

  // [失败路径] 未知异常也必须先归一成结构化 failure，再走同一条失败渲染路径；
  // 绕过它直接 throw 会在移动端留下一个没有错误页的空白屏。
  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  // [并发] bootstrapPairedSession 用 let 而非 const：真正的实现要等协议与 bridge
  // 都就绪后才赋值，早期调用方拿到 undefined 时必须能感知“还没准备好”。
  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  // [事务] 只有这四种原因为“生命周期轻恢复”：其余（frame-gap、bridge-degraded 等）
  // 都视为需要重建 bridge，否则会漏掉真正的桥损坏。
  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  // [事务] 重试计数与定时器必须一起清零：只清定时器会让“预算耗尽”判断
  // 带着上一轮的 attempt 继续累积，提前进入终态。
  const clearBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    bridgeRecoveryRetryAttempt = 0;
  };

  // [并发] 已有定时器、已终止、页面正在卸载、版本被拦四种情况都必须直接返回：
  // 缺一项都会在错误状态下继续排重试。
  // [失败路径] 重试预算耗尽（delay 为 null）不能静默停止：必须进入统一终态，
  // 释放 degraded protocol 与旧 Root，并给用户手动重试入口。
  // [资源] 定时器触发前先清句柄，保证回调内可以重新调度而不被自己挡住。
  const scheduleBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer || terminated || isPageUnloading || versionGuard.isBlocked())
      return;
    const delay = getWebRemoteControlBridgeRecoveryRetryDelay(bridgeRecoveryRetryAttempt);
    if (delay === null) {
      // Bug 原因：旧逻辑把有界重试的 null 当成静默停止，导致已 degraded 的 protocol
      // 和旧 React Root 永久残留。预算耗尽必须进入既有终态边界，统一释放 bridge 资源并提供手动重试。
      renderBootstrapFailure(
        createWebRemoteControlConnectionRecoveryTimeoutFailure(
          "Mobile connection did not rebuild the workspace bridge within the retry budget.",
        ),
      );
      return;
    }
    bridgeRecoveryRetryAttempt += 1;
    bridgeRecoveryRetryTimer = setTimeout(() => {
      bridgeRecoveryRetryTimer = undefined;
      void recoverVisibleSession("bridge-rebuild-retry");
    }, delay);
  };

  // [事务] 恢复分“轻恢复”（只重连 transport）与“重恢复”（重建 bridge）两条路：
  // 只有非生命周期原因或 bridge 已降级时才重建，避免切后台就整树重建。
  // [并发] recoveryId 在非重试路径重新生成，重试路径保持同一 id，
  // 让迟到 response 仍能按 recovery 边界被拒绝。
  // [失败路径] 版本校验期间 bridge 若已降级，错误必须继续向上抛，交给下方
  // bootstrap 重新校验；只有仍健康时才吞掉这次校验失败。
  // [资源] 进入前先置 bootstrapping，防止并发的 lifecycle 事件重复进入恢复。
  const recoverVisibleSession = createWebRemoteControlBridgeRecoveryRunner(async (reason) => {
    if (isPageUnloading || terminated || versionGuard.isBlocked()) {
      return;
    }
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    const isBridgeRebuildRetry = reason === "bridge-rebuild-retry";
    if (!isBridgeRebuildRetry) {
      bridgeRecoveryRetryAttempt = 0;
      currentRecoveryId = createWebRemoteControlRequestId("recovery");
    } else {
      // 同一 degraded recovery flight 的 bridge open 每次换 bridge generation，但 recoveryId
      // 保持不变；这样迟到 response 仍能按 recovery 边界拒绝。
      currentRecoveryId ??= createWebRemoteControlRequestId("recovery");
    }
    const requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    // [并发] bootstrapping 必须在 await 之前置位，否则同一帧的第二次恢复
    // 仍会看到 false 并进入。
    bootstrapping = true;
    // [失败路径] transportRecovered 记录“恢复是否已生效”，失败分支据此决定
    // 是否需要把 terminal 状态重置为 idle。
    let transportRecovered = false;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      transportRecovered = true;
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          // [事务] 恢复成功的轻路径也要清 recoveryId：这里表示“bridge 仍健康、
          // 本轮恢复结束”，与重建路径的清理语义一致。
          currentRecoveryId = undefined;
          return;
        }
      }
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
      clearBridgeRecoveryRetry();
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading && transportRecovered && requiresBridgeRebuild) {
        // Bug 原因：transport 已恢复但单次 bridge-open 失败时，旧逻辑只调用 transport
        // background recovery；旧 bridge 已 degraded，之后没有事件会再次发起 open。
        scheduleBridgeRecoveryRetry();
      } else if (!terminated && !isPageUnloading) {
        // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
        // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
        // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
        transport.recoverInBackground();
      }
    } finally {
      bootstrapping = false;
    }
  });

  // [事务] 先渲染“连接中”再构造 transport：transport 构造函数里就会发起 WS，
  // 若等构造完成再渲染，弱网下用户会先看到上一页面的残留。
  // [失败路径] 这里不 await 任何东西：loading 只是兜底视觉，真正的失败由 transport
  // 的 onFailure 统一收敛。
  renderWebRemoteControlLoading("connecting", connectingDevice);

  // [事务] 任务视图发布器把“是否已连接、是否被版本拦截”封装进发送回调：
  // 调用方只管 publish，不再各自判断连接状态。
  // [并发] 发送前检查 terminated 与版本拦截，避免向已失效的 transport 写入。
  // [资源] 发布器内部持有最新 epoch，sendReady 时统一 flush，防止首帧丢失。
  const taskViewPublisher = createWebRemoteControlTaskViewPublisher(
    (payload) => !terminated && !versionGuard.isBlocked() && transport.sendPayload(payload),
  );
  // [事务] transport 是全链路唯一的收发点：relay WS 地址来自 shared 解析器，
  // 设备身份三件套（sid/mid/version）一次性传入，后续不再修改。
  // [并发] 原始帧先给 pending 再给 active：新 bridge 在握手期间必须优先消费，
  // 否则握手帧会被旧 bridge 吃掉。
  // [失败路径] onRawTransportFault 对两条 protocol 都 markDegraded：无法判断
  // 故障属于哪条连接时，宁可两条都标记，也不能漏掉正在使用的那条。
  // [资源] transport 的 dispose 由 disposeConnection 负责，这里不额外持有清理路径。
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    getToken,
    // [并发] 返回 false 表示“没人认领这一帧”，transport 据此决定是否上报未知帧；
    // 因此两条 protocol 都必须尝试，不能短路成 || 之外的分支。
    onRawTransportPayload: (payload) =>
      pendingRelayProtocol?.acceptPayload(payload) ||
      activeRelayProtocol?.acceptPayload(payload) ||
      false,
    onRawTransportFault: (reasonCode) => {
      pendingRelayProtocol?.markDegraded(reasonCode);
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    // [事务] onPayload 是应用层路由表，顺序即优先级：任务视图请求 → relay RPC →
    // requester 应答 → 工作区列表 → bridge 降级/错误 → app 错误。
    // [并发] rpc-frame 先给 pending：新一轮 bridge 正在建立时，迟到帧属于新连接。
    // [失败路径] bridge-degraded 与 workspace-bridge-error 的区别是：后者还要
    // 立刻 dispose 旧 services，先关 RPC 门禁以保留草稿并显示断线横幅。
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "mobile-task-view-request") {
        taskViewPublisher.request(payload.epoch);
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        if (!pendingRelayProtocol?.acceptPayload(payload))
          activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // 失效通知不对应 pending request；先关闭 workspace RPC 门禁，让既有会话
          // 显示断线横幅并保留草稿，不能让旧 services 继续被当作 ready。
          activeBridgeServiceRegistration?.dispose();
          activeBridgeServiceRegistration = undefined;
          activeRelayProtocol?.markDegraded();
          void recoverVisibleSession(payload.reason);
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    // [事务] 状态机推进顺序固定：先让 publisher 感知迁移（它需要 prev/next），
    // 再更新本地 state，最后才刷新 UI；顺序反了 publisher 会少一次迁移事件。
    // [并发] 非 paired 状态一律 versionGuard.invalidate()：旧版本校验结果
    // 不能跨一次断连继续有效。
    // [并发] ready 之后不再渲染 loading：否则一次短暂重连会把已渲染的聊天页
    // 换回加载页，用户会看到闪烁并丢失滚动位置。
    // [失败路径] 配对事件不代表可以新开 bootstrap：已有健康 bridge 或在途初始化时，
    // 只做版本校验，不并发新建第二条 bridge。
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      taskViewPublisher.transportStateChanged(state, terminalTransportState);
      terminalTransportState = state;
      // [事务] 一旦掉出 paired，之前的版本校验结果立即作废：重连后桌面端可能已升级。
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state, connectingDevice);
      }
      if (state !== "paired") {
        return;
      }
      // [事务] 先通知入口“已配对”（它负责停止 loading 动画与记录设备态），
      // 再决定是否需要新建 bridge；顺序反了会让首屏多停留一拍。
      connection.onPaired();
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && pendingVersionCheck) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      // [并发] bootstrapPairedSession 由下方赋值，理论上在首次配对前一定已就绪；
      // 仍保留判空是为了兜住“transport 在赋值前就完成配对”的极端时序。
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    // [事务] sendReady 表示底层通道可写：先 flush 任务视图，再重放 bridge 帧；
    // 两件事都必须在同一拍完成，否则首帧会丢在“已连接但还没 flush”的窗口里。
    // [并发] 版本被拦时直接返回：此时重放只会把失效数据写进被冻结的页面。
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      taskViewPublisher.flush();
      replayWebRemoteControlWorkspaceBridgeFrames({ activeRelayProtocol, pendingRelayProtocol });
    },
    // [失败路径] reload 是 transport 判定无法自愈时的最后手段；
    // 它由底层显式调用，入口不主动触发，避免与恢复流程互相打断。
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  // [事务] requester 用“谓词 + requestId”匹配响应，避免不同请求的应答串台；
  // 它只负责应用层 payload，不处理 relay RPC。
  // [并发] 发送回调先查版本拦截：被拦时不发请求，调用方会收到超时并走统一失败路径。
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  // [事务] requestAppPayload 与 requestWithRelayRecovery 分层：前者只做“发一帧等一帧”，
  // 后者在其上叠加“断线先重连”的策略。调用方按语义选择，不混用。
  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  // [事务] 每次 bootstrap 请求都生成新 requestId，响应必须严格匹配；
  // 返回 result 而不是整帧，调用方只关心窗口引导数据。
  // [失败路径] 不在这里 catch：超时/断连由 requester 抛出，上层统一归一成 failure。
  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  // [并发] pendingVersionCheck 是单飞（single-flight）：并发调用复用同一个 Promise，
  // 避免每次配对都发一轮版本请求。
  // [失败路径] 循环重读只针对“旧 bootstrap 响应失效”这一种情况：条件里同时要求
  // 未终止、未被拦、仍处于 paired，任一不满足就退出，防止无限循环。
  // [资源] finally 里只在句柄仍是自己时才清空，避免清掉后来者的 Promise。
  // [事务] recoverTimeout 让版本读取也能触发 relay 重连，而不是直接失败。
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
    pendingVersionCheck = request;
    return request;
  };

  // [事务] 平台方法统一走 requestWithRelayRecovery 包装：断线时先重连再重发，
  // 调用方不需要自己处理 relay 恢复。
  // [并发] 每次调用都新建 requestId，重试必须能与原请求区分开。
  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    // [失败路径] 平台方法失败必须抛错而不是返回 undefined：
    // 调用方依赖异常来决定是否提示用户，静默返回会让按钮“点了没反应”。
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  // [事务] 工作区列表是幂等请求，允许在 relay 恢复后重试一次；
  // 直接展示 0 个任务会让用户误以为工作区被清空。
  // [并发] 每次重试都重新生成 requestId：复用 id 会让迟到的旧响应被当成新结果。
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
      // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  // [事务] 先更新本地 current*，再发 view-state：发送失败时本地仍记录用户看到的
  // 位置，下一次成功发送会补上最终值。
  // [并发] updatedAt 用 Date.now() 让桌面端能丢弃乱序到达的旧状态。
  // [失败路径] sendPayload 的返回值被忽略：视图同步是尽力而为，不能阻断导航。
  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: relayParams.appVersion,
      }),
    });
  };

  // [事务] 重连响应必须同时匹配 requestId 与 workspaceKey：只匹配 requestId 时，
  // 用户在等待期间切换工作区会把另一个工作区的成功结果当成本次的。
  // [并发] 超时放宽到 WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS：
  // 远端可能正在启动容器/建立 SSH，默认 10s 会先于宿主成功而误报超时。
  // [失败路径] 重连成功但 bridge 仍 degraded 时，再触发一次轻恢复，
  // 让“工作区已回来”尽快反映到 UI。
  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
    if (workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded()) {
      await recoverVisibleSession(
        "workspace-reconnected",
        () => workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded() === true,
      );
    }
  };

  // [事务] 打开 bridge 是全链路最关键的事务：先分配世代号与 sessionId，
  // 再 abort 旧 bridge，最后才发 open 请求；顺序反了会让旧连接在等待期间继续收帧。
  // [并发] bridgeGeneration 单调递增，isCurrent() 用它判断“响应是否属于最新一次尝试”，
  // 用户快速切换工作区时旧响应会被明确丢弃。
  // [失败路径] 若在等待期间版本被拦或已有更新的 bridge，必须 throw 而不是静默返回，
  // 让上层停下后续的 Root 渲染。
  // [资源] pendingBridgeAbort 只保留最新一个 AbortController，旧的一定要先 abort。
  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions & {
      project?: Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "workspace-bridge-open" }
      >["project"];
    },
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    // [并发] bridgeSessionId 与 bridgeGeneration 成对使用：sessionId 用于协议层
    // 归属校验，generation 用于本地“是否最新”判断，缺一不可。
    const bridgeSessionId = createWebRemoteControlRequestId("bridge");
    const bridgeGeneration = ++nextBridgeGeneration;
    pendingBridgeAbort?.abort();
    const bridgeAbort = new AbortController();
    pendingBridgeAbort = bridgeAbort;
    // [并发] isCurrent 把三个条件合并成一个判据：未终止、未被版本拦截、
    // 世代号仍是最新；任何后续写入前都要重新调用它。
    const isCurrent = () =>
      !terminated && !versionGuard.isBlocked() && bridgeGeneration === nextBridgeGeneration;
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-bridge-open",
          requestId: createWebRemoteControlRequestId("workspace-bridge"),
          bridgeSessionId,
          bridgeGeneration,
          ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
          workspaceKey,
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          ...(options?.taskHostId ? { taskHostId: options.taskHostId } : {}),
          ...(options?.fileTreeTaskId ? { fileTreeTaskId: options.fileTreeTaskId } : {}),
          ...(options?.project ? { project: options.project } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-ready" }
        > =>
          payload.zcode_type === "workspace-bridge-ready" &&
          payload.bridgeSessionId === bridgeSessionId,
      ),
    );
    // [失败路径] 这里必须抛错而不是 return：调用方会据此跳过 Root 渲染，
    // 静默返回会让页面用一份过期的 bridge 继续启动。
    if (!isCurrent() || bridgeAbort.signal.aborted) {
      throw new Error("Web remote control version changed before the workspace bridge was ready.");
    }
    // [事务] bridge 就绪后清空 recoveryId：本次恢复事务到此结束，
    // 下一次恢复必须用新的 id，否则迟到帧会被误认为属于本轮。
    currentRecoveryId = undefined;
    // [事务] 响应里的 bridgeSessionId/generation/recoveryId 必须原样回填到
    // protocol：三者由桌面端分配，本地重算会让 ACK 匹配不上。
    // [失败路径] oversize 帧直接抛错而不是截断：截断的 RPC 帧会在对端解析失败，
    // 表现为难以定位的“随机掉线”。
    // [并发] sendFrame 先查版本拦截，被拦时返回 false 让 protocol 走降级。
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        if (versionGuard.isBlocked()) return false;
        const result = transport.sendPayloadResult(frame);
        if (result.kind === "oversize") {
          throw new Error("remote.rpcFrame.envelopeTooLarge");
        }
        return result.kind === "sent";
      },
    });
    // [并发] 降级回调只对“当前 active 的这条 protocol”生效：旧 bridge 的迟到降级
    // 不能触发新一轮恢复，否则会形成恢复风暴。
    // [失败路径] 降级一律走 recoverVisibleSession，而不是就地重建：
    // 恢复器内部有重试预算与去重，能避免多个降级事件各自拉起一条新链路。
    relayProtocol.onDegraded((fault) => {
      if (activeRelayProtocol !== relayProtocol) return;
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] raw relay bridge degraded", {
          bridgeSessionId: relayProtocol.getBridgeSessionId(),
          reasonCode: fault.reasonCode,
        });
      }
      void recoverVisibleSession(fault.reasonCode);
    });
    // [事务] 服务连接与 transport 激活分两步：先让 protocol 成为收帧目标，
    // 能力 RPC 才有回包；但 Root 必须等服务就绪后才切换，避免半初始化的服务被消费。
    // [并发] activateTransport 返回的是“撤销激活”函数，必须交给服务注册表保管，
    // 由它在新 bridge 接管时调用，防止两条 protocol 同时消费帧。
    const services = await connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol,
      windowProjectDirectory:
        response.bridge.kind === "remote" &&
        response.bridge.capabilities?.windowProjectDirectory === true,
      activateTransport: () => {
        // 能力 RPC 必须先有收帧目标；服务与 Root 仍等就绪后才切换。
        pendingRelayProtocol = relayProtocol;
        return () => {
          if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
        };
      },
      isCurrent,
      signal: bridgeAbort.signal,
    });
    // [事务] 服务注册必须在 protocol 激活之后、旧服务释放之前完成：
    // 否则中间存在一个“新协议可用但服务表仍指向旧连接”的窗口。
    const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: response.bridge,
      services,
    });
    // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
    // [失败路径] 这里刻意不 await：已读失败只影响未读小红点，等待它会延迟首屏。
    void markOpenedWebRemoteControlBridgeTaskRead({
      bridge: response.bridge,
      expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
      services,
    });
    // [事务] 切换顺序固定：先保存旧引用 → 赋新 active → 清理 pending → 释放旧资源。
    // 先释放旧资源再赋新值，会让释放期间的帧落到 undefined 上被静默丢弃。
    // [并发] previous* 先取出再覆盖：直接 dispose(activeRelayProtocol) 会误释放新的那条。
    // [资源] pendingBridgeAbort 只在仍指向本次 bridge 时清空，避免清掉后来者的句柄。
    const previousRelayProtocol = activeRelayProtocol;
    const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
    activeRelayProtocol = relayProtocol;
    taskViewPublisher.setBridge(response.bridge);
    if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
    if (pendingBridgeAbort === bridgeAbort) pendingBridgeAbort = undefined;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    previousRelayProtocol?.dispose();
    previousBridgeServiceRegistration?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
    if (!isCurrent()) throw new Error("Workspace bridge request was superseded.");
    return { bridge: response.bridge, services, relayProtocol };
  };

  // [事务] Root 渲染是“接管页面”的唯一入口：两处 render（bridge / home-only）都会
  // 设置 ready 并替换整棵树，禁止在别处零散 render 子页面。
  // [并发] AppErrorBoundary 以 bridgeSessionId 作 key：换 bridge 时强制重挂错误边界，
  // 否则旧 bridge 的错误状态会沿用，新页面一进来就显示错误页。
  // [失败路径] terminated 或版本被拦时直接返回，避免把已经失效的 bridge 渲染出来。
  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
    initialTaskDraft?: ComponentProps<typeof Root>["initialTaskDraft"],
    initialSidebarFileTreeOpen = false,
  ) => {
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema
                    .or(mobilePluginDiscoveryTelemetrySchema)
                    .safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            // [权衡] 该能力开关只在渲染层生效，不得写回 Host 状态：
            // 反例：若把 assistantCodeCommentCardsEnabled 写回 Host 状态，手机端的投影开关会污染桌面端 replay。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialTaskDraft={initialTaskDraft}
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
              updateMobileTaskView: async (view) => {
                taskViewPublisher.update(bridge, view);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  // [事务] 打开“项目草稿”要区分两种源：有 projectId 的是宿主已有项目，
  // 没有的是本机临时草稿，后者才需要 ensurePendingTaskDraft 预留 draftId。
  // [并发] draftId 必须在 open 请求里就带上，供宿主复用已创建的 workspace；
  // 等到渲染后再生效会让宿主先建一个空工作区。
  // [失败路径] hostId 只透传非空值，传 undefined 会被宿主当成“本机”，
  // 从而把远程项目错建到桌面本地。
  const openProjectDraft = async (
    request: NonNullable<ComponentProps<typeof Root>["initialTaskDraft"]>,
  ) => {
    const projectId = request.projectId ?? null;
    const pendingDraft =
      !projectId && (!request.hostId || request.hostId === "local")
        ? ensurePendingTaskDraft({
            clientNamespace: `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
            hostId: "local",
            projectId: null,
          })
        : null;
    const result = await openWorkspaceBridge(currentWorkspaceKey ?? "project-navigation", {
      project: {
        projectId,
        ...(request.hostId ? { hostId: request.hostId } : {}),
        ...(pendingDraft
          ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
          : {}),
      },
    });
    renderExternalRelayRoot(result.services, result.bridge, "chat", {
      ...request,
      projectId,
      ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
    });
  };

  // [事务] home-only 页是“未连上 bridge 但需要进入首页”的降级形态：
  // 它必须渲染完整 Root（只读服务桩），而不是停留在失败页。
  // [并发] ready 同样要在 render 前置位，并且要在 await 之后重新检查 terminated：
  // await 期间用户可能已切设备，因此恢复后必须重查 terminated 与版本守卫，不能直接复用旧 ready。
  // [失败路径] 这里的服务都是空结果桩，任何需要真实数据的能力由 UI 显示为空，
  // 不允许抛错把首页打回失败页。
  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    if (terminated || versionGuard.isBlocked()) return;
    // Bug 原因：staging 合并 a861a83cbc 丢了这里的 ready 标记，home-only 挂载后每次配对状态抖动
    // 都会被 onStateChange 当成首屏重渲染加载页，配对恢复后再整页重挂，引导与本地状态全部丢失。
    // 与 bridge Root 一致：Root 挂载后由其自身横幅展示断线状态。
    ready = true;
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema
                    .or(mobilePluginDiscoveryTelemetrySchema)
                    .safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  // [事务] 配对后的首屏引导分三步：先校验版本拿到工作区快照，再选定目标工作区，
  // 最后按 canBridge 分流到 bridge Root 或 home-only Root。
  // [并发] 每一步 await 之后都要重新检查 terminated / 版本拦截：等待期间用户可能
  // 已切换设备或关闭页面。
  // [失败路径] 没有任何可用工作区时抛 workspace-closed，而不是渲染空首页：
  // 空首页会让用户以为“工作区丢了”。
  // [失败路径] Source 断开且当前已有同工作区 bridge 时，只释放服务注册并返回，
  // 保留原 Root 与草稿，不把用户踢回首页。
  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const preferredWorkspace = options?.preferredWorkspaceKey
      ? bootstrapResult.workspaces.find(
          (workspace) =>
            resolveWebRemoteControlWorkspaceKey(workspace) === options.preferredWorkspaceKey,
        )
      : undefined;
    // [事务] 首选工作区必须按 workspaceKey 精确匹配（含 identity），
    // 只按路径匹配会把同路径不同 identity 的两个工作区混为一谈。
    // [并发] canBridge 额外要求 remote 工作区同时具备 identity 与 remoteSessionId：
    // 缺任一项时远端无法定位会话，只能降级为 home-only。
    const selectedWorkspace = preferredWorkspace
      ? {
          workspaceKey: resolveWebRemoteControlWorkspaceKey(preferredWorkspace),
          taskId: options?.preferredTaskId,
          canBridge:
            preferredWorkspace.kind !== "remote" ||
            Boolean(preferredWorkspace.workspaceIdentity && preferredWorkspace.remoteSessionId),
        }
      : selectInitialWebRemoteControlWorkspace(bootstrapResult);
    // [失败路径] 没有可选工作区是明确的终态，抛结构化 failure 交给统一失败路径，
    // 不要在这里 root.render 失败页（会绕过设备态清理）。
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      // Source 断开后的 bootstrap 只确认离线，不替换当前 Root；内容与草稿仍由
      // 原会话 owner 持有。冷启动没有已加载 bridge，继续使用原 home-only 边界。
      // [事务] 这里只释放服务注册而不 abort protocol：协议还可能在恢复中，
      // 提前 abort 会让一次可恢复的断线变成永久失败。
      // [并发] 只有“同工作区已有 bridge”才走保留分支，否则必须渲染 home-only，
      // 不然用户会停在一个再也连不上的旧工作区。
      if (activeRelayProtocol && selectedWorkspace.workspaceKey === currentWorkspaceKey) {
        activeBridgeServiceRegistration?.dispose();
        activeBridgeServiceRegistration = undefined;
        return;
      }
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  // [事务] 生命周期恢复只做两件事：suspend 时收帧并关发送门，recover 时统一交给
  // recoverVisibleSession 裁决是否需要重建 bridge。
  // [并发] onSuspend 不 dispose 任何对象：后台只是暂停，销毁会让“回到前台”
  // 变成一次全新的冷启动。
  // [失败路径] onRecover 不 await：生命周期事件同步触发，阻塞它会影响浏览器的
  // bfcache 判定。
  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // hidden/pagehide/freeze 后 JS 与 WebSocket 都可能暂停；先撤销查看，再关闭发送门。
      // 导航恢复位置保留，是否重建 bridge 仍由既有恢复流程决定。
      taskViewPublisher.suspend();
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  // [资源] 两个卸载监听都用 once:true 且指向同一个 disposeConnection：
  // 函数内部幂等，重复触发不会重复释放。
  window.addEventListener("beforeunload", disposeConnection, { once: true });
  connection.signal.addEventListener("abort", disposeConnection, { once: true });
  // [资源] beforeunload 与 abort 都绑定到同一 disposeConnection 之后才 start：
  // 先注册清理再启动连接，保证启动过程中崩溃也能释放资源。
  // [并发] start 只调用一次，重复调用会让 transport 内部建立第二条 socket。
  transport.start();
}

// [事务] 入口分流顺序固定：OAuth 回调 → 会话分享 → 远控路由 → 普通 Web 应用。
// 顺序反了会让回调页被远控连接抢走，或让分享页误建 bridge。
// [并发] 每个分支都是“处理并 return”，不允许 fallthrough：
// 两个分支同时执行会向同一 root render 两棵不同的树。
// [失败路径] 分享页与远控启动都 await：未处理的 rejection 会被浏览器当成
// 未捕获异常，页面停在白屏。
// [权衡] lang 只在远控/回调路径预设：普通 Web 由 Root 内的 IntlProvider 接管，
// 这里提前设置会被随后覆盖。
async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebRemoteControlRoute() || isWebRemoteControlOAuthCallback(new URL(window.location.href))) {
    document.documentElement.lang = resolveWebRemoteControlScreenLocale(navigator.language);
  }
  // [事务] 回调页必须先于分享与远控判定：它携带一次性 code，
  // 若先进入远控启动会被当成未登录用户。
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  // [事务] 分享页只读，必须早于远控分支（守住 INV-15）：分享链接不应触发
  // 任何远控握手或设备选择。
  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  // [事务] 远控路由必须早于普通 Web bootstrap：后者会向 /api/server-info 询问本机
  // 工作区，在纯前端部署下必然失败并渲染错误页（守住 INV-09 的分流顺序）。
  if (isWebRemoteControlRoute()) {
    await remoteEntry.start();
    return;
  }

  // [失败路径] bootstrap 解析失败也要渲染失败页而不是白屏：普通 Web 与远控共用
  // 同一套失败视觉，用户能据此判断是配置问题还是网络问题。
  let bootstrap: WebBootstrapResult;
  // [事务] 只有 resolveWebBootstrap 被单独 try 包住：它的失败意味着“连地址都拿不到”，
  // 与后面的连接失败需要区分处理。
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  // [事务] 普通 Web 直接连 wsUrl，不经过 relay/bridge：这是自托管单机形态，
  // 没有桌面宿主参与。
  // [失败路径] onClose 刻意留空：重连由 client 内部处理，这里再触发一次会双重重连。
  try {
    const services = await connectViaWebSocket(bootstrap.wsUrl, {
      onClose: () => {},
    });
    // [权衡] 普通 Web 不传 externalWebRemoteControlProxy：远端控制能力只属于
    // 远控页面，普通页面暴露代理会让宿主误以为存在设备通道。
    const platform = createWebPlatform();
    // [事务] 标题在 render 前设置，与远控页保持同一时机约定，避免首帧闪烁旧标题。
    document.title = "ZCode - Web + Server";

    // [事务] 首屏工作区与任务都由 bootstrap 结果注入，Root 不再自行恢复会话；
    // restoreSession/allowOpenWorkspace 由宿主配置决定，入口不得覆盖。
    // [并发] settings/broadcast 服务必须与 services 同源传入 IntlProvider，
    // 否则语言与广播会走两条不同的连接。
    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            initialTaskId={bootstrap.initialTaskId}
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    // [失败路径] 连接阶段的任何异常都收敛到失败页；这里不复用远控的
    // disposeConnection，因为普通 Web 没有 bridge 资源需要释放。
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
  }
}

// [失败路径] 顶层不 catch：bootstrapWebApp 内部已把已知失败渲染成页面，
// 这里若再 catch 会掩盖真正的编程错误。
// [并发] 入口只执行一次；模块顶层副作用（root/监听）已在此前完成，
// 这里不再重复初始化（守住 INV-01、INV-17）。
void bootstrapWebApp();
