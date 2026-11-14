/* eslint-disable max-lines -- Desktop renderer bridge 聚合平台、远端 attachment 与启动编排契约。 */
// Desktop renderer 入口：主题、平台标记、启动准入与 ServicePort 引导的顺序约束集合
// INV-01 renderer 入口必须在任何业务渲染前登记性能时间线清理；守住位置：模块顶层 startPerformanceTimelineCleanup 调用；改错故障：长驻窗口的性能条目无限累积，轨迹面板越用越卡。
// INV-02 T4 起点只取一次模块求值时刻；守住位置：rendererStartedAt 常量；改错故障：分段耗时出现负值或总时长漂移，启动优化无从判断。
// INV-03 T0-T3 由 main 注入 query，renderer 只解析不臆造；守住位置：parseLaunchMarks 之后得到的 launchMarks 常量；改错故障：缺参窗口把虚假标记写进全局，分段统计失真。
// INV-04 启动标记必须挂到 window 供后续阶段读取；守住位置：__ZCODE_RENDERER_START__ 与 __ZCODE_LAUNCH_MARKS__ 的赋值；改错故障：性能采集拿不到 renderer 起点，报告只剩空白段。
// INV-05 主题必须在 React 首次渲染前落到 documentElement；守住位置：模块顶层主题块与三处类名切换；改错故障：首屏先闪白再变暗，出现可感知的闪烁。
// INV-06 平台标记只描述 Desktop chrome，不影响普通 Web；守住位置：platform-mac、platform-windows、platform-linux 三处 toggle 分支；改错故障：浮层命中原生窗控，或 Linux 标题栏点击被遮罩吞掉。
// INV-07 启动参数一律有默认值，缺失即回退；守住位置：readBooleanFlag 与 readStringFlag；改错故障：URL 少参时启动崩溃或恢复出错误窗口。
// INV-08 数据库启动准入是启动状态的唯一所有者；守住位置：databaseStartupAdmission 实例；改错故障：多处写状态互相覆盖，加载页停在错误阶段。
// INV-09 拿到 ServicePort 之前只渲染启动壳，不渲染业务根；守住位置：renderDatabaseStartup 与 initializeBusinessRoot；改错故障：业务组件在服务缺失时渲染，首屏一片报错。
// INV-10 业务根只允许初始化一次；守住位置：appInitialized 的早返回；改错故障：同一 DOM 节点重复挂载，出现双份界面与重复监听。
// INV-11 端口未就位时 remote 注册必须排队而非丢弃；守住位置：pendingRemoteWorkspaceServicePorts 的入队分支；改错故障：SSH 主机仍存活但界面进入断连代理。
// INV-12 排队端口在基础服务就绪后按序冲刷；守住位置：flushPendingRemoteWorkspaceServicePorts；改错故障：远端窗口永远等不到服务，只能重启。
// INV-13 ready 通知必须在 store 注册新 services 之后发出；守住位置：registerRemoteWorkspaceServicePort 末尾；改错故障：调用方拿到旧代 services，操作打到已废弃连接。
// INV-14 错误上报器必须在 createRoot 之前注入；守住位置：setReactErrorArmsReporter 调用；改错故障：Root 首帧崩溃无上报，线上只剩白屏。
// INV-15 启动壳退场需同时满足动画结束与 React commit；守住位置：StartupReadyNotifier 派发的 ready 事件；改错故障：壳先退场露出空白，或首屏被壳长期盖住。
// INV-16 30 秒内没收到启动状态即视为失败可重试；守住位置：firstStartupStateTimer 回调；改错故障：主进程异常时界面无限转圈，用户无从退出。
// INV-17 全局 message 监听只注册一次且先做来源校验；守住位置：handleServicePortMessage 首段判定；改错故障：外部窗口消息被当成服务端口，注入任意端口。
// INV-18 update-status 窗口走独立渲染分支，不参与业务引导；守住位置：windowKind 判定与末尾分支；改错故障：更新窗口抢走主窗口的服务端口，两个窗口都白屏。
// 上述不变量共同保证引导顺序：主题与平台标记先于渲染，服务端口先于业务根，上报器先于 createRoot。
// 改这里先确认破坏的是哪一条，再决定补判定还是调整时序，切勿用延时掩盖同步问题。
//
import { DatabaseStartupAdmission } from "./databaseStartupAdmission.js";
import { initializeDesktopLocalTtft } from "./localTtftBootstrap.js";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import {
  AppErrorBoundary,
  Root,
  GlobalDatabaseStartupLoading,
  UpdateStatusWindowRoot,
  ZCodeIntlProvider,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  createRemoteWorkspaceDisconnectedError,
  installDocumentHiddenMotionPause,
  playTaskNotificationSound,
  setStreamClientId,
  setReactErrorArmsReporter,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaMessagePort, createMessagePortServiceConnection } from "@zcode/client";
import {
  InternalChannels,
  databaseStartupStateSchema,
  type DatabaseStartupControl,
  collectTelemetryRendererContext,
  parseLaunchMarks,
  LAUNCH_MARKS_QUERY_KEY,
  type LaunchMarks,
  DEFAULT_LOCALE,
} from "@zcode/shared";
import type { Locale } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { syncAppTelemetryContext } from "../appTelemetryBridge.js";
import { createDesktopPlatform } from "./desktopPlatform.js";
import { startPerformanceTimelineCleanup } from "./performanceTimelineCleanup.js";
import { initializeDesktopUserActionTrace } from "./userActionTraceBootstrap.js";
import { buildRemoteWorkspaceSessionServicesForRegistration } from "./remoteWorkspaceSessionServices.js";
import { handleSourceSettingsServicePortMessage } from "./sourceSettingsServicePortBridge.js";
import {
  notifyRemoteWorkspaceServicePortReady,
  parseRemoteWorkspaceServicePortMessage,
  type RemoteWorkspaceServicePortRegistration,
} from "./remoteWorkspaceServicePortBridge.js";

type DesktopRendererImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

// [资源] 先注册清理再进入任何渲染路径，保证长会话的性能条目始终有回收者
// 顺序换到 createRoot 之后会让早期时间线无人接管
startPerformanceTimelineCleanup();

// T4:renderer bundle 开始执行。同时从 loadURL query 解析 main 注入的 T0-T3。
// T4 只在模块求值时取一次，后续阶段都以它为基准算差值
// 重复取值会把启动耗时分段算成零甚至负数
const rendererStartedAt = Date.now();
const launchMarks: LaunchMarks | null = parseLaunchMarks(
  new URLSearchParams(window.location.search).get(LAUNCH_MARKS_QUERY_KEY),
);
(
  window as Window & {
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
  }
).__ZCODE_RENDERER_START__ = rendererStartedAt;
(window as Window & { __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null }).__ZCODE_LAUNCH_MARKS__ =
  launchMarks;
// E2E store 桥只按构建期环境变量开启，生产构建里这次调用立刻返回
// 调用点在启动标记之后、主题与平台标记之前，保证测试注入早于首屏
registerE2EStoreBridgesIfEnabled();

function registerE2EStoreBridgesIfEnabled() {
  const env = ((import.meta as ImportMeta & { env?: DesktopRendererImportMetaEnv }).env ??
    {}) as DesktopRendererImportMetaEnv;
  // [权衡] 默认关闭，只有显式写入 1 才动态加载桥接模块
  // 放宽成非空即开会让生产包也带上测试入口
  if (env.VITE_ZCODE_E2E_STORE_BRIDGE !== "1") {
    return;
  }

  void import("@zcode/ui/e2e-store-bridge").then(({ registerE2EStoreBridges }) => {
    registerE2EStoreBridges();
  });
}

// 主题在 React 之前用同步 localStorage 读取落盘值，避免首帧等待异步结果
// [权衡] 这里先手写一份解析，useTheme 接管后会再覆盖一次，换来无闪烁的首帧
// system 偏好走 matchMedia，未知值回落到 zai-light，三态类名互斥不共存
// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
{
  const saved = localStorage.getItem("zcode-theme") || "zai-dark";
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
  if (resolved === "dark") document.documentElement.classList.add("dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

// 平台判定只看 UA，renderer 侧不假设 preload 已先注入能力
// mac 与 windows 都不匹配时一律按 Linux 处理，三态互斥无第四种
const isMacDesktop = navigator.userAgent.includes("Mac");
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const isLinuxDesktop = !isMacDesktop && !isWindowsDesktop;
// macOS hidden 原生标题栏仍参与鼠标拖拽命中，深层浮层需要平台标记避开其高度。
document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop);
// Windows 的原生 titleBarOverlay 与 renderer 共用右上角，深层浮层拿不到
// Root 的 isWindowsDesktop prop 时会把关闭按钮放进原生窗控命中区。根节点平台标记只描述
// Desktop chrome，不会让普通 Windows Web 误用标题栏安全区。
document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop);
// Linux 的窗口标题栏由 renderer 自绘，应用内 Dialog overlay 如果覆盖整个 webContents，
// 会把标题栏点击区一起拦截。给桌面 Linux 根节点打平台标记，让 UI overlay 能只在 Linux 避开标题栏。
document.documentElement.classList.toggle("platform-linux-desktop", isLinuxDesktop);
const isLocalDevelopmentRuntime =
  (
    globalThis as typeof globalThis & {
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__?: boolean;
    }
  ).__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ === true;

function readBooleanFlag(name: string, defaultValue: boolean): boolean {
  const value = new URLSearchParams(window.location.search).get(name);
  if (value == null) return defaultValue;
  return value !== "false" && value !== "0";
}

function readStringFlag(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value == null || value.trim() === "" ? undefined : value;
}

// 启动开关全部来自 URL query，由 main 拼地址时决定窗口行为
// 缺省为真，保证脱离 main 直接打开页面仍能进入正常工作区
const restoreSession = readBooleanFlag("restoreSession", true);
const supportsSettings = readBooleanFlag("supportsSettings", true);
const initialWorkspaceAbsPath = readStringFlag("initialWorkspacePath");
const initialWorkspacePurpose = readStringFlag("initialWorkspacePurpose");
const unavailableWorkspacePath = readStringFlag("unavailableWorkspacePath");
const windowKind = readStringFlag("windowKind");
const initialLocaleFlag = readStringFlag("locale");
const initialLocale: Locale =
  initialLocaleFlag === "zh-CN" || initialLocaleFlag === "en-US"
    ? initialLocaleFlag
    : DEFAULT_LOCALE;
// [并发] 这是远端端口注册的前置条件，为 null 时所有 remote port 只能排队
// 赋值发生在本地 ServicePort 就绪之后，早于它没有任何业务服务可用
let baseServicesForRemoteSessions: IServiceAccessor | null = null;
const pendingRemoteWorkspaceServicePorts: RemoteWorkspaceServicePortRegistration[] = [];

// 平台能力在模块顶层构造一次，后续提示音、设备 ID 与系统语言都从这里取
// 本地开发运行时标记决定是否走校验宽松的实现分支
const desktopPlatform = createDesktopPlatform({ isLocalDevelopmentRuntime });
initializeDesktopLocalTtft(desktopPlatform);
initializeDesktopUserActionTrace({
  platform: desktopPlatform,
  isLocalDevelopmentRuntime,
});

/**
 * 等待 preload 通过 window.postMessage 转发 MessagePort。
 *
 * MessagePort 不能经过 contextBridge（会丢失原生方法），
 * 所以 preload 用 window.postMessage + transfer 把 port 原样传递到 renderer。
 * 本地窗口的 port 来自 utilityProcess，远程窗口也一样，renderer 无需区分。
 */
// 之前用匿名函数注册 addEventListener("message")，reload/HMR 时会重复注册，
// 导致多次 createRoot 在同一 DOM 节点上挂载。用 flag 防止重复初始化。
// 窗口 hidden 时禁用 CSS 动画，避免 DocumentTimeline 持有已卸载的 DOM 子树。
// [资源] installDocumentHiddenMotionPause 在 createRoot 前注册，首帧前生效；窗口隐藏即停动画；DocumentTimeline 不再持有已卸载子树。
// 注册点在 createRoot 之前，隐藏事件在首帧前就已生效
installDocumentHiddenMotionPause();
// 重复挂载的唯一闸门：置位后所有业务引导分支直接返回
// [并发] 状态消息与端口消息可能同时到达，置位放在 initializeBusinessRoot 首行，先占位再建连
// 换成布尔以外的标记会丢失幂等性，reload 或 HMR 时会出现双份根节点
let appInitialized = false;
// [事务] 状态与端口由准入器统一收口，acceptState 与 acceptPort 分两次推进
// 任何绕过它直接渲染业务根的做法都会让加载页状态错位
const databaseStartupAdmission = new DatabaseStartupAdmission();
const appRoot =
  windowKind === "update-status" ? null : createRoot(document.getElementById("root")!);
const sendStartupControl = (control: DatabaseStartupControl) =>
  window.postMessage({ type: InternalChannels.DatabaseStartupControl, control }, "*");
// 启动壳渲染不依赖业务服务，只读准入器当前状态
// [失败路径] 重试与退出通过 sendStartupControl 回到 main，不在 renderer 内自行恢复
// 这里的平台布尔决定壳内浮层是否避开原生窗控命中区
function renderDatabaseStartup(): void {
  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        initialLocale={initialLocaleFlag ? initialLocale : undefined}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <GlobalDatabaseStartupLoading
          state={databaseStartupAdmission.state}
          onRetry={() => {
            if (databaseStartupAdmission.state)
              sendStartupControl({
                action: "retry",
                attemptId: databaseStartupAdmission.state.attemptId,
              });
          }}
          onCopy={(details) => navigator.clipboard.writeText(details)}
          onExit={() => sendStartupControl({ action: "exit" })}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
// 两个条件都满足才进入业务根：已置位过直接返回，没有待取端口就等下一次消息
// 它被状态消息与端口消息共同调用，是引导流程的唯一汇合点
function enterAppIfPrepared(): void {
  if (appInitialized) return;
  const port = databaseStartupAdmission.takeReadyPort();
  if (port) initializeBusinessRoot(port);
}
const firstStartupStateTimer =
  windowKind === "update-status"
    ? undefined
    : setTimeout(() => {
        if (databaseStartupAdmission.state) return;
        const now = Date.now();
        databaseStartupAdmission.state = {
          schemaVersion: 1,
          startupId: "unavailable",
          attemptId: "startup-channel-unavailable",
          sequence: 0,
          startedAt: rendererStartedAt,
          updatedAt: now,
          phase: "failed",
          errorCode: "startup_status_timeout",
          disk: [],
        };
        renderDatabaseStartup();
      // [失败路径] 30 秒兜底只为覆盖主进程未投递状态的情况，不是常规路径
      // 状态一旦先到就清掉计时器，避免失败页盖住正常首屏
      }, 30_000);

// 远端端口注册要等基础服务就绪，并把它包装成会话级服务集合
// [并发] 同一窗口可有多个远端会话，各自持独立连接与 dispose
function registerRemoteWorkspaceServicePort(params: RemoteWorkspaceServicePortRegistration) {
  if (!baseServicesForRemoteSessions) {
    return;
  }

  const remoteConnection = createMessagePortServiceConnection(params.port);
  const remoteServices = remoteConnection.services;
  const services = buildRemoteWorkspaceSessionServicesForRegistration({
    baseServices: baseServicesForRemoteSessions,
    remoteServices,
    targetKind: params.target.kind,
    sourceServerId: params.sourceServerId,
  });
  registerRemoteWorkspaceSession({
    sessionId: params.sessionId,
    ...(params.sourceServerId ? { sourceServerId: params.sourceServerId } : {}),
    ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
    target: params.target,
    services,
    dispose: (reason) =>
      remoteConnection.dispose(reason ?? createRemoteWorkspaceDisconnectedError()),
  });
  // canonical workspace bind 会换代 remote-scoped port。
  // 只有 store 已注册新 services 后才能确认 ready，bind IPC 返回后的调用方才可重新读取并使用新代 services。
  notifyRemoteWorkspaceServicePortReady(params);
}

// 队列先整体取走再逐个注册，避免注册过程中新消息再次触发遍历
// [并发] 只冲刷一次，之后到位的端口直接走注册路径
function flushPendingRemoteWorkspaceServicePorts(): void {
  if (!baseServicesForRemoteSessions || pendingRemoteWorkspaceServicePorts.length === 0) {
    return;
  }

  const pending = pendingRemoteWorkspaceServicePorts.splice(0);
  for (const entry of pending) {
    registerRemoteWorkspaceServicePort(entry);
  }
}

function StartupReadyNotifier() {
  useEffect(() => {
    // T5:React 首次 commit。供启动分阶段耗时计算 react_commit 段。
    (window as Window & { __ZCODE_REACT_COMMIT_AT__?: number }).__ZCODE_REACT_COMMIT_AT__ =
      Date.now();
    // HTML 启动壳的弹出动画结束时，React 首屏可能还没 commit，直接移除壳会露出空白。
    // 这里在 React commit 后通知 index.html，再由启动壳统一判断动画和 React ready 两个条件后退场。
    // 壳的退场条件之一是 React 已 commit，这个事件只做通知不做判定
    // 改为直接移除壳会让动画未结束时露出白底
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);

  return null;
}

// 全局 message 的总分发：启动状态、提示音、设置端口、远端端口、本地 ServicePort 依次判定
// 每条分支命中即返回，顺序即优先级，新增通道只能插在明确位置
// [失败路径] 来源不是当前 window 的数据一律不认，避免被其他 frame 伪造
function handleServicePortMessage(event: MessageEvent): void {
  if (event.source === window && event.data?.type === InternalChannels.DatabaseStartupState) {
    const result = databaseStartupStateSchema.safeParse(event.data.state);
    if (!result.success || appInitialized) return;
    const next = result.data;
    if (!databaseStartupAdmission.acceptState(next)) return;
    if (firstStartupStateTimer) clearTimeout(firstStartupStateTimer);
    renderDatabaseStartup();
    enterAppIfPrepared();
    return;
  }

  if (event.data === InternalChannels.TaskNotificationSound) {
    void playTaskNotificationSound();
    return;
  }

  if (handleSourceSettingsServicePortMessage(event)) return;

  const remoteWorkspacePort = parseRemoteWorkspaceServicePortMessage(event);
  if (remoteWorkspacePort) {
    if (!baseServicesForRemoteSessions) {
      // renderer reload 时 main 可能先补投 remote port，再投本地 ServicePort。
      // 早到的 remote port 不能直接丢弃，否则 SSH host 仍存活但 UI 会进入断连代理。
      // [并发] renderer reload 时 main 可能先补投 remote port，此时基础服务尚未建立
      // 直接丢弃会让 SSH 主机仍存活而界面进入断连代理，只能重启窗口
      pendingRemoteWorkspaceServicePorts.push(remoteWorkspacePort);
      return;
    }

    registerRemoteWorkspaceServicePort(remoteWorkspacePort);
    return;
  }

  if (
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    appInitialized
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  databaseStartupAdmission.acceptPort({ databaseStartupId: event.data.databaseStartupId }, port);
  enterAppIfPrepared();
}

function initializeBusinessRoot(port: MessagePort): void {
  appInitialized = true;
  const services = connectViaMessagePort(port, {
    sourceServerManagementService: true,
  });
  baseServicesForRemoteSessions = services;
  registerBaseWorkspaceServices(services);
  flushPendingRemoteWorkspaceServicePorts();
  const settingService = supportsSettings ? services.settingService : undefined;

  syncAppTelemetryContext({
    bridge: {
      syncTelemetryContext: (context) => window.zcode.syncTelemetryContext(context),
    },
    createRendererContext: collectTelemetryRendererContext,
  });

  // 初始化稳定的设备 ID，确保所有 hook 在首次渲染前就使用正确的值
  setStreamClientId(desktopPlatform.getDeviceId());

  // React 错误边界捕获的异常不会冒泡到 window.onerror，RUM Browser SDK 默认收不到。
  // 必须在 createRoot 之前注入 reporter：根级 AppErrorBoundary 的职责正是兜住 Root 自身
  // 渲染崩溃，若依赖 Root 的 effect 注入，则 Root 首帧就崩时上报会丢失。
  // [失败路径] React 边界吞下的异常不会冒泡到 window.onerror，必须在 createRoot 前注册上报器
  // 根级 AppErrorBoundary 要兜住 Root 自身崩溃，改到 Root 的 effect 里注入会丢掉首帧崩溃
  // [权衡] 上报器绑定平台服务而非全局单例，便于 e2e 与本地开发替换实现
  setReactErrorArmsReporter(desktopPlatform);

  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        settingService={settingService}
        broadcastService={services.broadcastService}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <Root
          services={services}
          platform={desktopPlatform}
          isDesktop
          assistantCodeCommentCardsEnabled
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          restoreSession={restoreSession}
          supportsSettings={supportsSettings}
          initialWorkspaceAbsPath={initialWorkspaceAbsPath}
          initialWorkspacePurpose={
            initialWorkspacePurpose === "conversation" ? "conversation" : "project"
          }
          unavailableWorkspacePath={unavailableWorkspacePath}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}

// 全局监听在模块顶层注册一次，reload 时整段模块重新求值不会叠加
// 注册后立刻请求启动快照，避免干等下一次状态推送
window.addEventListener("message", handleServicePortMessage);
if (windowKind !== "update-status") {
  renderDatabaseStartup();
  sendStartupControl({ action: "snapshot" });
}

// 更新窗口只渲染独立根，不参与数据库准入与业务服务引导
// 两个分支互斥，同一窗口不会同时渲染更新页与主界面
if (windowKind === "update-status") {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <StartupReadyNotifier />
      <UpdateStatusWindowRoot
        platform={desktopPlatform}
        initialLocale={initialLocale}
        onRequestClose={() => window.close()}
      />
    </AppErrorBoundary>,
  );
}
