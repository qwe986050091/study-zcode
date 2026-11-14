// ============================================================================
// desktop/main/desktopMainIpcRemote.ts —— 主进程远程连接与平台 IPC 注册
// ============================================================================
//
// 职责边界：本文件只注册主进程 IPC handler，覆盖远程连接、OAuth 回调、遥测与通知，把渲染进程请求转成窗口级 Host 调用；连接状态机由 window host 与 connection registry 负责，本文件不持有会话事实，也不渲染 UI。
//
// 不变量（INV）表：断言 —— 守住它的位置 —— 改错后的故障
// INV-01 所有通道只在 registerRemoteIpcHandlers 一处注册 —— 该函数体 —— 改错：重复注册导致同一请求被处理两次。
// INV-02 openExternal 必须先过协议白名单再交给 shell —— isAllowedExternalOpenUrl —— 改错：任意协议（含自定义 scheme）被系统处理器执行。
// INV-03 内嵌导航的信任集是「受信 origin + coding-plan 路径 + embedded=app」三者同时成立 —— isCodingPlanWebviewUrl —— 改错：缺一项即可被外部页面套壳。
// INV-04 PayPal 只允许 https 且 host 在受信集合内 —— isCodingPlanPaypalNavigationUrl —— 改错：明文支付上下文或仿冒域名被当作内嵌页。
// INV-05 支付回调必须同源且 returnTo 仍解析为合法 webview —— isCodingPlanPaymentCallbackUrl —— 改错：开放重定向把回调引到任意外站。
// INV-06 非内嵌目标一律走系统浏览器 —— shouldKeepCodingPlanOpenExternalInWebview —— 改错：普通外链被困在应用内，用户无法回到原页面。
// INV-07 file: 协议走默认应用而不是 loadURL —— OpenExternal 分支 —— 改错：本地文件被 webview 加载并执行。
// INV-08 IPC 返回值必须可结构化克隆，失败也返回普通对象 —— toBindIpcFailure —— 改错：抛出后渲染层只拿到泛化错误，拿不到 reasonCode。
// INV-09 只透出公开错误码，retryable 必须仅在存在公开码时才带 —— isPublicZCodeErrorCode / readRetryable —— 改错：内部错误语义泄露，前端按错码提示。
// INV-10 入站 payload 必须经 schema safeParse，失败不抛到渲染层 —— 各 ipcMain.on/handle 入口 —— 改错：畸形输入打断主进程事件循环。
// INV-11 connect-remote 必须绑定当前 BrowserWindow —— BrowserWindow.fromWebContents 校验 —— 改错：找不到窗口仍继续建 session，泄漏无主连接。
// INV-12 连接失败路径必须先取消窗口内 pending session —— connect-remote catch —— 改错：失败后残留 pending，重试命中死 flight。
// INV-13 bind workspace context 必须校验 remoteSessionId 与非空路径 —— BindRemoteWorkspaceSessionContext —— 改错：空身份绑定到错误 workspace。
// INV-14 dispose 必须带 grace，且与创建使用同一个 sessionId —— DisposeRemoteSession —— 改错：立即销毁正在收尾的会话，产物写一半。
// INV-15 OAuth state 的登记与回调清理必须成对 —— OAuthRegisterState / OAuthCallbackHandled —— 改错：窗口复用后旧 state 仍可被兑换。
// INV-16 窗口 closed 时必须清理该窗口的 OAuth 路由与远程会话 —— browser-window-created 的 closed 监听 —— 改错：关窗后 handler 仍持有已销毁 webContents。
// INV-17 遥测上报失败不得影响主流程 —— reportRemoteUsageEvent / ARMS 上报的 catch —— 改错：遥测异常把成功的连接变成失败。
// INV-18 E2E 遥测桥只在显式开关下生效 —— ConfigureFinalArmsCustomEventsE2E —— 改错：生产环境暴露事件读写通道。
import { normalizeRemoteConnectionError } from "@zcode/shared";
/* eslint-disable max-lines -- 远程连接、OAuth 回调、遥测和通知 IPC 共用窗口级上下文，集中注册避免跨文件状态漂移。 */
import { app, BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import armsRum from "@arms/rum-electron";
import {
  armsCustomEventPayloadSchema,
  buildRemoteWorkspaceConnectResultTelemetry,
  classifyRemoteUsageError,
  formatZodError,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  normalizeUnknownError,
  InternalChannels,
  isPublicZCodeErrorCode,
  isTrustedCodingPlanWebviewOrigin,
  PlatformChannels,
  remoteTargetSchema,
  rendererTelemetryEventPayloadSchema,
  type ArmsRumEnv,
  type BindRemoteWorkspaceSessionContextIpcResult,
  type RemoteTarget,
  type WindowHostRemoteWorkspaceDescriptor,
  type BindRemoteWorkspaceSessionContextResult,
  type TelemetryEventPayload,
} from "@zcode/shared";
import { dispatchTaskNotification } from "./desktopNotifications.js";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  parseOAuthStateRegistration,
  registerOAuthState,
} from "./desktopOAuthDeepLink.js";
import {
  dispatchFinalArmsCustomEvent,
  enableSharedFinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";
import {
  configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms,
  type RemoteConnectionStats,
} from "./desktopRemoteUsageArmsTelemetry.js";
import {
  registerWebRemoteControlIpcHandlers,
  type WebRemoteControlIpcManager,
} from "./desktopWebRemoteControlIpc.js";
import { openFileUrlInDefaultApp, openPathInDefaultApp } from "./desktopMainIpcHelpers.js";

function isPublicRemoteReasonCode(code: string | undefined): code is string {
  // Bug 原因：前缀 OR 形成第二份公开码真源，任何内部 source-server-* 字符串都会穿透
  // Main 暴露给 Renderer。公开边界只消费 shared 登记表，新增码必须先进入统一合同。
  // 唯一的公开码判定；不要在此叠加前缀或白名单，否则会出现第二份真源。
  return isPublicZCodeErrorCode(code);
}

// 只读取显式 boolean；非对象、缺字段、非布尔一律返回 undefined，让前端自己决定默认值。
function readRetryable(error: unknown): boolean | undefined {
  // 只有显式声明 retryable 的对象才可重试；字符串与 null 一律视为未知，交给前端默认策略。
  if (!error || typeof error !== "object" || !("retryable" in error)) return undefined;
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

// Bind 的失败结果必须可跨进程序列化，因此这里只返回普通对象，绝不重新抛出。
// reasonCode 与 retryable 都是条件展开：没有公开码时不带 retryable，避免泄露内部重试语义。
function toBindIpcFailure(error: unknown): BindRemoteWorkspaceSessionContextIpcResult {
  const normalized = normalizeUnknownError(error);
  // 先判公开码再决定是否透出；非公开码保持 undefined，不能被前端看到。
  const reasonCode = isPublicRemoteReasonCode(normalized.code) ? normalized.code : undefined;
  const retryable = reasonCode ? readRetryable(error) : undefined;
  return {
    success: false,
    error: normalized.message,
    ...(reasonCode ? { reasonCode } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

// [安全] 这是 openExternal 的第一道协议闸；新增协议前必须确认系统处理器的安全性。
// URL 解析失败直接 false：畸形字符串不应该交给 shell。
export function isAllowedExternalOpenUrl(value: string): boolean {
  try {
    // 以 URL 解析结果而不是字符串前缀判断协议，避免 "http:evil" 之类伪装。
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

// sourceUrl 由调用方补充，用于判断是否处于 Coding Plan webview；url 才是实际打开目标。
interface OpenExternalRequest {
  sourceUrl?: string;
  url: string;
}

// parseOpenExternalRequest 同时接受纯字符串与对象两种历史形态；兼容期结束后才能收紧。
// 对象形态缺 url 就返回 null，调用方统一按「不支持」拒绝。
function parseOpenExternalRequest(payload: unknown): OpenExternalRequest | null {
  // 字符串形态仅构造 url；sourceUrl 留空，无法参与 webview 来源判定。
  if (typeof payload === "string") {
    return { url: payload };
  }
  // 非对象 payload 直接拒绝；不尝试做字符串到对象的兼容转换。
  if (!payload || typeof payload !== "object") {
    return null;
  }
  // 先窄化为 unknown 记录再逐字段取，避免把任意对象字段直接当字符串使用。
  const record = payload as Record<string, unknown>;
  // url 必须是非字符串以外的任何值都拒绝，包括数字与对象，避免隐式 toString。
  if (typeof record.url !== "string") {
    return null;
  }
  return {
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    url: record.url,
  };
}

// relay 主机集合用 Set 去重，重复项不会改变行为，但新增主机必须走评审。
// CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS 只登记受信中转域名；不要为了兼容测试环境加入通配。
const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);

function isPaypalHostname(hostname: string): boolean {
  // 必须匹配完整主域或子域后缀，不能用 includes，否则 evilpaypal.com 会被放行。
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

// [安全] PayPal 导航只允许 https；http 会暴露支付上下文。
// PayPal 主域与受信 relay 的路径前缀共同构成白名单，二者缺一不可。
function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // PayPal 主域授权页不要求路径前缀；这是唯一放宽路径条件的受信主机。
    if (isPaypalHostname(parsed.hostname)) return true;
    return (
      // relay 主机必须与路径前缀同时成立；只匹配域名会把同域其他接口当成支付页。
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

// 内嵌应用必须同时满足：受信 origin、coding-plan 路径、embedded=app 参数；三个条件构成最小信任集。
// E2E store bridge 开关只影响 origin 判定，不放开其余条件。
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  // 缺 src 视为不可信；空字符串不能默认成当前页面。
  if (!src) return false;
  try {
    const url = new URL(src);
    // webview 判定只接受 http/https，file: 与自定义协议一律拒绝。
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      // origin 校验是信任的第一层；E2E 开关只调整允许的 origin 集合，不改变后续路径条件。
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    // 路径判断在前、参数判断在后：先收窄页面范围，再确认嵌入形态，顺序影响拒绝成本。
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

// [安全] 回调必须同源且 returnTo 仍是合法 webview，防止开放重定向。
// returnTo 必须用 new URL(returnTo, url.origin) 解析，相对路径也按同源处理。
function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    // 回调路径必须精确以该后缀结尾；前缀匹配会被 /x/coding-plan/... 绕过。
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    // returnTo 缺失即拒绝，不允许默认跳回首页，否则会掩盖支付链路异常。
    const returnTo = url.searchParams.get("returnTo");
    // 空 returnTo 不构成合法回调；这里提前失败，避免后续 new URL 抛错。
    if (!returnTo) return false;
    // 相对 returnTo 必须以当前 origin 为基准；直接用全局 URL 会抛错或跳到外部。
    const target = new URL(returnTo, url.origin);
    // returnTo 必须同源且仍然是合法 webview 页面；任一不满足都按开放重定向拒绝。
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

// isAllowedCodingPlanEmbeddedNavigationUrl 只接受三类目标：应用页、PayPal 授权页、支付回调页；其余一律由系统浏览器打开。
function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

// shouldKeepCodingPlanOpenExternalInWebview 只在当前页处于可信支付链路、且目标是允许的内嵌 URL 时返回 true；任一条件不满足必须返回 false，改由系统浏览器打开，避免把普通外链困在应用内。
function shouldKeepCodingPlanOpenExternalInWebview(currentUrl: string, targetUrl: string): boolean {
  return (
    // 当前页必须是应用页或 PayPal 授权页；从普通外链发起不享受内嵌保留。
    (isCodingPlanWebviewUrl(currentUrl) || isCodingPlanPaypalNavigationUrl(currentUrl)) &&
    isAllowedCodingPlanEmbeddedNavigationUrl(targetUrl)
  );
}

// [并发] 所有 handler 必须共享同一份 options，注册一次、窗口级生效；不要在 handler 内保存窗口引用。
// 依赖以函数注入而不是直接 import，便于测试替换与生命周期解耦。
// 该函数只注册通道，不主动发起任何会话；调用方负责时机。
export function registerRemoteIpcHandlers(options: {
  // logger 由调用方注入，Main 不直接依赖全局 console，便于测试断言与统一格式。
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  // telemetry runtime 是「窗口生命周期事件」的接收方，与 appTelemetryCore 的「事件上报」职责分开。
  appTelemetryRuntime: {
    onRendererReady(payload: { hasPendingOAuthCallback: boolean; rendererId: number }): void;
    syncRendererContext(payload: { rendererId: number; context: unknown }): void;
    onOAuthCallbackHandled(payload: { rendererId: number }): void;
  };
  /** OAuth 回调处理完成后的额外副作用（如刷新 ARMS user.id）；不影响既有 runtime 流程 */
  // 副作用是可选的，且只能同步执行；异步逻辑应由调用方自行排队，不能阻塞回调通知。
  onOAuthCallbackHandledSideEffect?: () => void;
  appTelemetryCore: {
    // core 只承诺接受已校验的 payload；handler 必须先过 schema 再调用。
    reportEvent(payload: unknown): Promise<void>;
  };
  reportRemoteUsageEvent: (rendererId: number, event: TelemetryEventPayload) => void;
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  /** 仅由 VITE_ZCODE_E2E_STORE_BRIDGE + test runner 双门禁打开。 */
  // 该开关必须与 test runner 的环境变量同时成立才生效，单独设置不会打开 E2E 通道。
  finalArmsCustomEventE2EEnabled?: boolean;
  webRemoteControlManager: WebRemoteControlIpcManager;
  // [并发] 该函数返回 Promise<sessionId>；调用方在 await 期间不能假设窗口仍存在。
  // context 与 lifecycle 都是可选参数，缺省时保持旧连接语义。
  // onConnected 只用于回传复用目标，不允许改变连接结果。
  createRemoteWorkspaceSession: (
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      confirmSourceServerInstall?: boolean;
    },
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ) => Promise<string>;
  // 统计是同步快照，供 ARMS 每次上报时读取；不要在内部做大范围扫描。
  getRemoteConnectionStats: () => RemoteConnectionStats;
  // 释放接口带 reason 与可选 grace，便于按调用来源区分日志与等待策略。
  disposeRemoteWorkspaceSession: (
    sessionId: string,
    reason: string,
    signalGracePeriodMs?: number,
  ) => void;
  cancelPendingRemoteWorkspaceSessionsForWindow: (
    wcId: number,
    reason: string,
    requestId?: string,
  ) => void;
  bindRemoteWorkspaceSessionContext: (
    sessionId: string,
    context: {
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
    expectedWebContentsId?: number,
  ) => Promise<BindRemoteWorkspaceSessionContextResult>;
  // attachment 就绪确认必须带 sender 的 webContents id，底层据此校验会话归属。
  confirmRendererAttachmentReady: (
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ) => void;
  attachSourceSettings?: (sender: WebContents, sourceServerId: string) => { attachmentId: string };
  isDockerDaemonAvailable: () => Promise<boolean>;
  // 探测类接口统一返回 unknown[]，由 UI 做窄化；Main 不假定具体发行版字段。
  listAvailableWSLDistros: () => Promise<unknown[]>;
  listAvailableDockerContainers: () => Promise<unknown[]>;
  listSSHConfigAliases: () => Promise<unknown[]>;
}) {
  // [失败路径] 埋点是旁路：捕获所有异常并降级为 warn，绝不影响远程连接结果。
  // 包装函数必须与 options 同名但不同层，命名冲突是有意为之，表示「安全版本」。
  function reportRemoteUsageEvent(rendererId: number, event: TelemetryEventPayload): void {
    try {
      options.reportRemoteUsageEvent(rendererId, event);
    } catch (error) {
      // 埋点是旁路能力，不能把已成功的远程连接改写成业务失败。
      // 只记录事件名与错误，不记录完整 payload；usage payload 可能含用户输入。
      options.logger.warn("[remote-usage-telemetry] dispatch failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  // E2E 控制器只在显式开关下创建；生产恒为 null，所有分支必须容忍 null。
  const finalArmsCustomEventE2E = options.finalArmsCustomEventE2EEnabled
    ? enableSharedFinalArmsCustomEventE2EController()
    : null;

  // 遥测配置必须在注册阶段完成一次，后续连接复用同一份上下文，避免每次建连重建 SDK 状态。
  // sendCustom 做类型收窄是 SDK 的签名要求，不改变运行时行为。
  configureRemoteUsageArmsTelemetry({
    armsCustomContext: options.armsCustomContext,
    getRemoteConnectionStats: options.getRemoteConnectionStats,
    sendCustom: (payload) =>
      armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
    e2eController: finalArmsCustomEventE2E,
    logger: options.logger,
  });

  // ARMS 建连结果上报同样必须吞异常；它不能改变 IPC 返回值。
  // 参数直接透传 reporter，避免在这里重塑字段导致两套口径。
  function reportRemoteConnectResultToArmsSafely(
    params: Parameters<typeof reportRemoteConnectResultToArms>[0],
  ): void {
    try {
      reportRemoteConnectResultToArms(params);
    } catch (error) {
      // ARMS reporter 失败是旁路故障；包装函数保证它不会冒泡到建连结果。
      options.logger.warn("[remote-usage-arms] connect result reporter failed", { error });
    }
  }

  // 这是通知型通道，没有返回值；调用方不应 await。
  // payload 必须逐字段校验类型与 trim，空串视为未就绪，直接丢弃。
  ipcMain.on(InternalChannels.ScopedServicePortReady, (event, rawPayload: unknown) => {
    // 就绪信号缺 payload 时静默丢弃：这是渲染层的乐观通知，没有可返回的错误通道。
    if (!rawPayload || typeof rawPayload !== "object") return;
    // 只声明实际读取的 sessionId 与 attachmentId 两个字段；多余字段不参与校验，也不透传。
    const payload = rawPayload as {
      sessionId?: unknown;
      attachmentId?: unknown;
    };
    // sessionId 必须 trim 后使用；带空白的 id 无法命中会话表。
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
    // attachmentId 同样 trim 后使用；空串会被下游当作无效确认并静默丢弃。
    const attachmentId =
      typeof payload.attachmentId === "string" ? payload.attachmentId.trim() : "";
    // 缺任一 id 都无法定位 attachment，静默返回比抛错更安全：这是渲染层的就绪信号。
    if (!sessionId || !attachmentId) return;
    // 把 sender id 与会话/附件一起回传，底层据此拒绝跨窗口伪造的就绪信号。
    options.confirmRendererAttachmentReady(event.sender.id, {
      sessionId,
      attachmentId,
    });
  });
  // E2E 专用通道只在双门禁开启时注册；生产环境根本不存在这些 handler。
  if (finalArmsCustomEventE2E) {
    // E2E 读取通道返回当前缓冲区，不清空；清空由独立通道控制，避免读写耦合。
    ipcMain.handle(PlatformChannels.ReadFinalArmsCustomEventsE2E, () =>
      finalArmsCustomEventE2E.read(),
    );
    // 清空是幂等操作，重复调用返回 undefined 即可，不需要确认。
    ipcMain.handle(PlatformChannels.ClearFinalArmsCustomEventsE2E, () => {
      finalArmsCustomEventE2E.clear();
    });
    ipcMain.handle(
      // 配置通道只在 E2E 开启时注册；生产不存在该通道，调用会直接失败。
      PlatformChannels.ConfigureFinalArmsCustomEventsE2E,
      (_event, request: unknown) => {
        // finalArmsCustomEventE2E.configure 的配置对象直接来自测试通道，类型断言只用于收窄，不能做运行时字段补全。
        finalArmsCustomEventE2E.configure(
          request as Parameters<typeof finalArmsCustomEventE2E.configure>[0],
        );
      },
    );
  }

  // Web 远程控制通道单独注册，但必须共享同一份安全版 reportRemoteUsageEvent，避免两套埋点入口。
  registerWebRemoteControlIpcHandlers({
    reportRemoteUsageEvent,
    webRemoteControlManager: options.webRemoteControlManager,
  });

  // OAuth state 注册按 sender webContents id 绑定窗口；跨窗口复用会让回调投递到错误窗口。
  ipcMain.on(PlatformChannels.OAuthRegisterState, (event, payload: unknown) => {
    const registration = parseOAuthStateRegistration(payload);
    if (!registration) {
      options.logger.warn("[oauth-register-state] invalid payload", payload);
      return;
    }

    // state 与 sender 绑定；不要改成全局注册，否则多窗口会互相覆盖。
    registerOAuthState(event.sender.id, registration);
  });

  // [安全] 这是 external URL 的唯一入口：先解析形态，再校验协议，最后才决定 webview 或系统打开。
  // 每个拒绝分支都带 logger.warn 并 return，不能继续落到后续打开逻辑。
  ipcMain.on(PlatformChannels.OpenExternal, (event, payload: unknown) => {
    const request = parseOpenExternalRequest(payload);
    if (!request) {
      // 记录的是原始 payload 形态，不记录可能存在的敏感 query。
      options.logger.warn("[open-external] blocked unsupported request", payload);
      return;
    }
    const { url } = request;
    // 协议白名单失败立即终止；不要尝试「修复」URL 后再打开。
    if (!isAllowedExternalOpenUrl(url)) {
      options.logger.warn("[open-external] blocked unsupported url", url);
      return;
    }
    // file: 只允许系统默认应用打开；即使目标在应用内可渲染也不能 loadURL。
    if (new URL(url).protocol === "file:") {
      // file: 分支立刻返回，不进入 webview 判定；否则会尝试 loadURL 本地文件。
      void openFileUrlInDefaultApp(url, options.logger);
      return;
    }
    const sender = event.sender;
    // sender 可能已销毁，调用前必须做能力检测；空串表示来源未知。
    const senderUrl = typeof sender?.getURL === "function" ? sender.getURL() : "";
    const senderFrameUrl =
      typeof event.senderFrame?.url === "string" ? event.senderFrame.url : undefined;
    // 来源优先级：senderFrame 最可信，其次调用方声明，最后 sender 自身 URL。
    // 顺序不能反：先信调用方声明会允许伪造 sourceUrl 绕过硬编码信任判断。
    const sourceUrl = senderFrameUrl ?? request.sourceUrl ?? senderUrl;
    if (
      // 能力检测与来源判定必须同时成立才走 webview；缺一不可。
      typeof sender?.loadURL === "function" &&
      shouldKeepCodingPlanOpenExternalInWebview(sourceUrl, url)
    ) {
      // 官网 embedded bridge 的 openExternal 会绕过 webview 导航守卫；
      // PayPal 授权完成后的可信回调仍需回到当前 webview，不能拉起系统默认浏览器。
      // [失败路径] 在 webview 内加载失败只记录 warn，不回退到外部浏览器：回退会让支付上下文离开应用。
      // void 表示有意不等待，避免阻塞 IPC 事件。
      void sender.loadURL(url).catch((error: unknown) => {
        // 加载失败只记录，不回退外部浏览器；回退会丢失当前登录上下文。
        options.logger.warn("[open-external] failed to load coding-plan callback in webview", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return;
    }
    // shell.openExternal 在部分平台返回同步布尔，Promise.resolve 统一成可 catch 的形态。
    // 失败只记录，不影响调用方；打开外链没有可回滚的业务状态。
    void Promise.resolve(shell.openExternal(url)).catch((error: unknown) => {
      options.logger.warn("[open-external] 外部 URL 打开失败", {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  // 文件打开走 helper 统一做路径校验与日志，不在 handler 内直接 shell.openPath。
  ipcMain.handle(PlatformChannels.OpenExternalFile, async (_event, rawPath: string) =>
    // handler 直接返回 helper 的 Promise，让它统一做路径校验与错误归一。
    openPathInDefaultApp(rawPath, options.logger),
  );

  // Renderer 就绪是通知：先把待投递深链交给窗口，再同步 telemetry runtime，顺序影响首屏回调。
  ipcMain.on(PlatformChannels.RendererReady, (event) => {
    const hasPendingOAuthCallback = deliverPendingDeepLink(event.sender);
    // 先投递待处理深链，再通知 telemetry 就绪；顺序保证首屏能看到 OAuth 回调结果。
    options.appTelemetryRuntime.onRendererReady({
      hasPendingOAuthCallback,
      rendererId: event.sender.id,
    });
  });

  // 上下文同步只绑定 sender，不做广播；每个窗口维护自己的 telemetry 身份。
  ipcMain.on(PlatformChannels.SyncTelemetryContext, (event, context) => {
    // context 由渲染层提供，Main 不做字段级校验；这是内部信任边界内的数据。
    options.appTelemetryRuntime.syncRendererContext({
      rendererId: event.sender.id,
      context,
    });
  });

  // 上报型通道必须 handle，调用方需要知道是否已接受；解析失败静默返回表示「已忽略」。
  ipcMain.handle(PlatformChannels.ReportTelemetryEvent, async (_event, payload: unknown) => {
    const result = rendererTelemetryEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-telemetry-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    // 只有 schema 通过的数据才进入 core；不要在校验失败时传原始 payload。
    await options.appTelemetryCore.reportEvent(result.data);
  });

  // 自定义事件带 rendererId 作为上下文；这既是归因信息，也是隔离边界。
  ipcMain.handle(PlatformChannels.ReportArmsCustomEvent, async (event, payload: unknown) => {
    // 自定义事件同样走 schema，不允许未登记字段进入 SDK。
    const result = armsCustomEventPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[report-arms-custom-event] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    try {
      // 分发逻辑集中在 desktopArmsCustomEvent，handler 只负责把上下文拼好。
      dispatchFinalArmsCustomEvent({
        payload: result.data,
        context: {
          ...options.armsCustomContext,
          rendererId: event.sender.id,
        },
        // E2E 控制器为 null 时必须正常走 SDK；不要把 null 当成「跳过上报」。
        e2eController: finalArmsCustomEventE2E,
        // FinalArmsCustomEventPayload 是 SDK RumCustomEvent 的收窄子集；SDK 额外要求
        // BaseObject 索引签名，但这里不会动态追加未声明字段。
        sendCustom: (payload) =>
          armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]),
      });
    } catch (error) {
      options.logger.warn(
        "[report-arms-custom-event] sendCustom failed:",
        normalizeUnknownError(error).message,
      );
    }
  });

  // 回调处理完成是通知语义；随后执行可选副作用（如刷新 ARMS user.id）。
  ipcMain.on(PlatformChannels.OAuthCallbackHandled, (event) => {
    options.appTelemetryRuntime.onOAuthCallbackHandled({
      rendererId: event.sender.id,
    });
    options.onOAuthCallbackHandledSideEffect?.();
  });

  // 同时注册通知与请求两种形态：历史调用方用 send，新调用方用 invoke；保留双形态避免破坏兼容。
  ipcMain.on(PlatformChannels.ShowTaskNotification, (event, payload: unknown) => {
    // 通知分发只依赖 event 的 sender 与 payload；不要在 handler 里读取窗口状态。
    dispatchTaskNotification({ event, payload, logger: options.logger });
  });
  ipcMain.handle(PlatformChannels.ShowTaskNotification, (event, payload: unknown) =>
    dispatchTaskNotification({ event, payload, logger: options.logger }),
  );

  // 在窗口创建时挂 closed 清理，保证 OAuth 路由不会跨窗口泄漏。
  app.on("browser-window-created", (_, win) => {
    // [资源] 必须在 closed 之前缓存 id：closed 阶段 webContents 可能已销毁。
    // 缓存的是 id 而不是对象引用，清理函数只依赖这个数字。
    const windowWebContentsId = win.webContents.id;
    // closed 是清理 OAuth 路由的唯一时机；不要改到 beforeunload，那里窗口仍可用但可能被复用。
    win.on("closed", () => {
      // BrowserWindow 的 closed 阶段里 webContents 可能已被 Electron 释放。
      // 之前这里直接读取 win.webContents.id，会把正常关窗流程变成主进程未捕获异常。
      // 提前缓存 id 后再做清理，避免访问已经销毁的对象。
      // 按 webContents id 清理，而不是按窗口对象；id 在窗口销毁后仍然可安全比较。
      clearOAuthRoutesForWindow(windowWebContentsId);
    });
  });

  // [契约] 这是远程建连的唯一入口，返回结构同时承载成功 sessionId 与失败 reasonCode/retryable。
  // payload 兼容裸 target 与包装对象两种历史形态；包装形态才带 requestId 与 workspace 上下文。
  // 任何分支都必须返回可序列化对象，不能 throw 到 Electron 层。
  ipcMain.handle(PlatformChannels.ConnectRemote, async (event, rawPayload: unknown) => {
    // wrappedPayload 同时保留原始 target 与可选上下文；后续一律从这里取值。
    // 类型里故意用 unknown 而不是先断言，迫使每个字段单独校验。
    const wrappedPayload: {
      target: unknown;
      requestId?: unknown;
      workspacePath?: unknown;
      workspaceIdentity?: unknown;
      connectTrigger?: unknown;
      confirmSourceServerInstall?: unknown;
    } =
      // 用 "target" in rawPayload 判定包装形态，而不是看字段数量；裸对象也可能有其他键。
      rawPayload && typeof rawPayload === "object" && "target" in rawPayload
        ? (rawPayload as {
            target: unknown;
            requestId?: unknown;
            workspacePath?: unknown;
            workspaceIdentity?: unknown;
            connectTrigger?: unknown;
            confirmSourceServerInstall?: unknown;
          })
        // 裸 target 兼容分支只补 requestId，不补 workspace 上下文；旧调用端无法提供这些信息。
        : { target: rawPayload, requestId: undefined };
    // target 校验失败立即返回失败对象；注意后续分支只能使用 result.data，不能回读 wrappedPayload。
    // 错误信息带 Zod 详情，便于前端定位字段，但绝不能暴露内部堆栈。
    const result = remoteTargetSchema.safeParse(wrappedPayload.target);
    if (!result.success) {
      // 错误文案只能包含 zod 字段路径，便于前端提示；不包含原始 payload，避免泄露凭据。
      const error = `Invalid connect-remote payload: ${formatZodError(result.error)}`;
      options.logger.warn("[connect-remote]", error);
      return { success: false, error };
    }
    // requestId 是连接级去重与取消的键；空串归一为 undefined，避免与「无请求 id」混淆。
    const requestId =
      typeof wrappedPayload.requestId === "string" && wrappedPayload.requestId.trim().length > 0
        ? wrappedPayload.requestId.trim()
        : undefined;
    // workspacePath 保留原值（不 trim 后写回），只用 trim 判断是否为空；路径空白可能具有意义。
    const workspacePath =
      typeof wrappedPayload.workspacePath === "string" &&
      wrappedPayload.workspacePath.trim().length > 0
        ? wrappedPayload.workspacePath
        : undefined;
    // identity 为空串时归一为 undefined；随后只在有值时才写入 context，保持最小 payload。
    const workspaceIdentity =
      typeof wrappedPayload.workspaceIdentity === "string" &&
      wrappedPayload.workspaceIdentity.trim().length > 0
        ? wrappedPayload.workspaceIdentity
        : undefined;
    // connectTrigger 归一后只能是 reconnect、restore、new 三个值；先取值再判定，避免多次读取对象字段。
    const connectTriggerValue = wrappedPayload.connectTrigger;
    // 未知触发来源统一归为 new，保证遥测维度闭合；不要透传任意字符串。
    const connectTrigger =
      connectTriggerValue === "reconnect" || connectTriggerValue === "restore"
        ? connectTriggerValue
        : "new";
    // 严格等于 true：字符串 "true"、1 都不构成用户确认，防止绕过安装提示。
    const confirmSourceServerInstall = wrappedPayload.confirmSourceServerInstall === true;

    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        // 进入 catch 后会被归一成统一失败结构；这里抛错是为了让错误分类逻辑复用。
        throw new Error("未找到当前窗口，无法创建远程 session");
      }

      // 复用目标只能由 onConnected 回调写入；在调用前读取只会得到 undefined。
      let reusedConnectionTarget: RemoteTarget | undefined;
      // 只有存在 workspacePath 或明确的安装确认时才构造 context；否则传 undefined，保持旧行为。
      // remoteUsageTelemetryEligible 固定 true：建连成功/失败都要计入远程用量。
      // await 期间窗口可能关闭，后续上报仍使用 event.sender.id，不重新读取窗口。
      const sessionId = await options.createRemoteWorkspaceSession(
        win,
        result.data,
        requestId,
        workspacePath || confirmSourceServerInstall
          ? {
              workspacePath,
              workspaceIdentity,
              ...(confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
            }
          : undefined,
        {
          remoteUsageTelemetryEligible: true,
          // 回调是同步的，只做赋值；任何 await 或 IO 都会拖慢连接完成。
          onConnected: (descriptor) => {
            // reusedConnectionTarget 由底层在连接建立时回传；这里只保存引用，不判断是否复用。
            reusedConnectionTarget = descriptor.reusedConnectionTarget;
          },
        },
      );
      // 成功上报放在 return 之前，确保返回给前端时埋点已入队；上报本身失败不影响结果。
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "success",
          remoteKind: result.data.kind,
          connectTrigger,
        }),
      );
      // ARMS 与 usage 是两条独立旁路，任意一条失败都不能影响另一条或返回值。
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "success",
        remoteKind: result.data.kind,
        connectTrigger,
      });
      return {
        success: true,
        sessionId,
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
      };
    } catch (error) {
      // 先归一错误再分类：normalize 负责提取 message/code，classify 负责遥测类别，两者不可合并。
      const normalizedError = normalizeRemoteConnectionError(error);
      // 分类基于原始 error 而不是 normalizedError，保留底层错误类型信息。
      const errorCategory = classifyRemoteUsageError(error);
      // 这里之前直接把 Error 对象交给 logger，落盘时会被 JSON.stringify 压成 `{}`。
      // 改成显式展开 message/code/stack，保证远程建连失败时主进程日志里能看到真实上下文。
      // 显式展开 message/code/stack，避免 JSON.stringify(Error) 得到空对象。
      // 日志只记录请求元数据，不记录 target 凭据或密码。
      options.logger.error("[connect-remote] caught error:", {
        requestId,
        confirmSourceServerInstall,
        message: normalizedError.message,
        code: normalizedError.code,
        stack: error instanceof Error ? error.stack : undefined,
      });
      reportRemoteUsageEvent(
        event.sender.id,
        buildRemoteWorkspaceConnectResultTelemetry({
          result: "failure",
          remoteKind: result.data.kind,
          connectTrigger,
          errorCategory,
        }),
      );
      reportRemoteConnectResultToArmsSafely({
        rendererId: event.sender.id,
        result: "failure",
        remoteKind: result.data.kind,
        connectTrigger,
        errorCategory,
      });
      // 公开码判定在 catch 里再做一次：normalize 后的 code 才是最终对外的 code。
      // retryable 依赖 reasonCode，顺序不能反。
      const reasonCode = isPublicRemoteReasonCode(normalizedError.code)
        ? normalizedError.code
        : undefined;
      // 失败路径同样要求 reasonCode 先行；没有公开码时即使底层标记可重试也不透出。
      const retryable = reasonCode ? readRetryable(error) : undefined;
      // 只有安装/升级类错误才携带 profileId；其它错误解析 undefined 会得到失败结果并被省略。
      // 使用 schema.shape 复用同一份字段校验，避免手写类型判断。
      const profileId = hostRemoteWorkspaceConnectFailedResponseSchema.shape.profileId.safeParse(
        (reasonCode === "source-server-upgrade-required" ||
          reasonCode === "source-server-install-required") &&
          error &&
          typeof error === "object" &&
          "profileId" in error
          ? error.profileId
          : undefined,
      );
      // 解析出的 WSL 目标只在安装/升级失败时向前端回传，用于引导用户确认目标环境。
      const resolvedWslTarget =
        hostRemoteWorkspaceConnectFailedResponseSchema.shape.resolvedWslTarget.safeParse(
          (reasonCode === "source-server-install-required" ||
            reasonCode === "source-server-upgrade-required") &&
            error &&
            typeof error === "object" &&
            "resolvedWslTarget" in error
            ? error.resolvedWslTarget
            : undefined,
        );
      return {
        success: false,
        error: normalizedError.message,
        // 没有公开码时完全不出现该字段；前端据此区分「未知错误」与「空码」。
        ...(reasonCode ? { reasonCode } : {}),
        // 只有底层显式给出布尔值才透出 retryable；false 也要保留，表示明确不可重试。
        ...(retryable !== undefined ? { retryable } : {}),
        // profileId 只有在 schema 校验成功且非空时才回传；空值不构造字段。
        ...(profileId.success && profileId.data ? { profileId: profileId.data } : {}),
        ...(resolvedWslTarget.success && resolvedWslTarget.data
          ? { resolvedWslTarget: resolvedWslTarget.data }
          : {}),
      };
    }
  });

  // 这是请求型通道：成功直接返回 attachmentId，失败通过 throw 交给 invoke 的 reject。
  // sourceServerId 必须 trim 后非空，否则无法定位要附加的设置来源。
  ipcMain.handle(PlatformChannels.RequestSourceSettingsAttachment, (event, rawPayload: unknown) => {
    const sourceServerId =
      rawPayload &&
      typeof rawPayload === "object" &&
      "sourceServerId" in rawPayload &&
      typeof rawPayload.sourceServerId === "string"
        ? rawPayload.sourceServerId.trim()
        : "";
    if (!sourceServerId) throw new Error("sourceServerId is required");
    // 能力缺失时抛错而不是返回空 attachment：调用方需要明确知道「不支持」，而不是拿到假成功。
    if (!options.attachSourceSettings) {
      throw new Error("Source settings attachment is unavailable");
    }
    // 附加动作直接返回 attachmentId；异常会以 invoke reject 形式交给调用方。
    return options.attachSourceSettings(event.sender, sourceServerId);
  });

  ipcMain.handle(
    PlatformChannels.CancelPendingRemoteConnection,
    async (event, rawPayload: unknown) => {
      const payload =
        rawPayload && typeof rawPayload === "object" ? (rawPayload as { requestId?: unknown }) : {};
      const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim().length > 0
          ? payload.requestId.trim()
          : undefined;
      // 连接建立前没有 sessionId，renderer 之前无法精准通知 main 取消正在进行的连接。
      // 现在优先按 requestId 精确取消当前弹窗发起的连接，避免误伤同窗口其他并发连接。
      // 若 requestId 缺失则回退到按窗口取消，兼容旧调用端。
      // [并发] 先按 requestId 精确取消当前弹窗发起的连接，缺失时才回退到窗口级；避免误伤并发连接。
      // reason 字符串包含 sender id，便于在主进程日志里归因。
      options.cancelPendingRemoteWorkspaceSessionsForWindow(
        event.sender.id,
        `cancel-pending-remote-connection:${event.sender.id}`,
        requestId,
      );
    },
  );

  ipcMain.handle(
    PlatformChannels.BindRemoteWorkspaceSessionContext,
    // Bind 永远 resolve 一个结果对象，不 reject；错误统一走 toBindIpcFailure。
    async (event, rawPayload: unknown): Promise<BindRemoteWorkspaceSessionContextIpcResult> => {
      try {
        if (!rawPayload || typeof rawPayload !== "object") {
          throw new Error("远程 workspace context payload 无效");
        }
        const payload = rawPayload as {
          remoteSessionId?: unknown;
          workspacePath?: unknown;
          workspaceIdentity?: unknown;
          workspacePurpose?: unknown;
        };
        const remoteSessionId =
          typeof payload.remoteSessionId === "string" ? payload.remoteSessionId.trim() : "";
        const workspacePath =
          typeof payload.workspacePath === "string" ? payload.workspacePath : "";
        const workspaceIdentity =
          typeof payload.workspaceIdentity === "string" ? payload.workspaceIdentity.trim() : "";
        const workspacePurpose =
          payload.workspacePurpose === "project" || payload.workspacePurpose === "conversation"
            ? payload.workspacePurpose
            : undefined;
        // 缺少 sessionId 或空白路径都无法绑定；workspacePath 保留原值，只用 trim 判断。
        if (!remoteSessionId || !workspacePath.trim()) {
          throw new Error("远程 workspace context 缺少 sessionId 或 workspacePath");
        }
        // expectedWebContentsId 传 sender.id，底层据此校验会话归属，防止跨窗口绑定。
        const result = await options.bindRemoteWorkspaceSessionContext(
          remoteSessionId,
          {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspacePurpose ? { workspacePurpose } : {}),
          },
          event.sender.id,
        );
        return { success: true, result };
      } catch (error) {
        // Bind 的所有异常在这里收敛成统一失败结构，handler 永不 reject。
        return toBindIpcFailure(error);
      }
    },
  );

  // 释放是幂等请求：重复调用不应抛错，底层按 sessionId 去重。
  ipcMain.handle(PlatformChannels.DisposeRemoteSession, async (_event, sessionId: string) => {
    // [资源] 150ms grace 给最后一个事件留落盘窗口；归零会让尾部事件丢失。
    // reason 带 sessionId，便于在日志中把释放与建连对上。
    options.disposeRemoteWorkspaceSession(sessionId, `dispose-remote-session:${sessionId}`, 150);
  });

  // [失败路径] 探测失败返回 false 而不是抛错，设置页据此禁用容器选项而不是整页报错。
  ipcMain.handle(PlatformChannels.IsDockerAvailable, async () => {
    try {
      // 探测函数本身可能 reject；外层 try 已兜底，所以这里可以安全 await。
      // 返回 boolean 而不是容器列表，UI 只需知道功能是否可用。
      return await options.isDockerDaemonAvailable();
    } catch (error) {
      options.logger.warn("[is-docker-available] detect failed:", error);
      return false;
    }
  });

  ipcMain.handle(PlatformChannels.ListWSLDistros, async () => {
    try {
      return await options.listAvailableWSLDistros();
    } catch (error) {
      options.logger.warn("[list-wsl-distros] detect failed:", error);
      return [];
    }
  });

  ipcMain.handle(PlatformChannels.ListDockerContainers, async () => {
    try {
      return await options.listAvailableDockerContainers();
    } catch (error) {
      options.logger.warn("[list-docker-containers] detect failed:", error);
      return [];
    }
  });

  // SSH alias 探测失败返回空数组，保持 UI 的「无可用主机」空态。
  ipcMain.handle(PlatformChannels.ListSSHConfigAliases, async () => {
    try {
      return await options.listSSHConfigAliases();
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      // Error 对象直接落盘会被序列化成 `{}`，SSH config 解析失败时无法定位具体 pattern。
      // 显式展开错误字段，保留 UI 返回空列表的兼容行为，同时让日志能看到根因。
      // 展开 name/stack 是为了定位解析失败的 config 段落；Error 直接落盘会丢字段。
      options.logger.warn("[list-ssh-config-aliases] detect failed:", {
        message: normalizedError.message,
        code: normalizedError.code,
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return [];
    }
  });
}
