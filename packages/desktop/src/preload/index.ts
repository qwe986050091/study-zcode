// ZCode desktop preload 桥接层：在隔离 world 与 main 进程之间只留一条可审计的最小通道。
// 职责边界：读取启动参数与窗口几何、把白名单 IPC 封装成 renderer 可调方法、转发 MessagePort。
// 不属于本层：业务状态、凭据、窗口生命周期决策 —— 这些一律留给 main 或 host process。
//
// INV-01 断言：暴露面是白名单，新增能力必须在 main 侧 handler 与本层显式方法同时登记 —— 守住它的位置：exposeInMainWorld 的 zcode 对象字面量 —— 改错故障：把 ipcRenderer 或通道枚举整体挂上去，renderer 可自行发起任意通道，权限边界立刻失效。
// INV-02 断言：通道名只能引用 PlatformChannels 与 InternalChannels 常量，禁止拼接字符串 —— 守住它的位置：每个 invoke、send、on 的第一个实参 —— 改错故障：main 重命名通道后 preload 静默失联，调用返回空值而不是报错。
// INV-03 断言：每个订阅方法必须返回退订函数，且退订只移除自己注册的 handler —— 守住它的位置：各 on 系列方法尾部的 removeListener 闭包 —— 改错故障：React 重挂载后监听器累加，同一次 main 广播被回调多次。
// INV-04 断言：错误对象跨桥后只剩可序列化字段，stack、name、cause 都会丢 —— 守住它的位置：invoke 的拒绝路径与双向通道的 catch 分支 —— 改错故障：界面只显示一句无上下文的错误文案，排查时拿不到调用栈。
// INV-05 断言：MessagePort 不能穿过 contextBridge，必须走 postMessage 的 transfer 列表 —— 守住它的位置：ServicePort 与 ScopedServicePort 两条转发 —— 改错故障：renderer 拿到被代理的端口，原生方法不存在，RPC 永远建不起来。
// INV-06 断言：载荷必须先过 schema 校验再转发，校验失败要关闭端口 —— 守住它的位置：databaseStartupPortPayloadSchema 与 scopedServicePortPayloadSchema 的 safeParse —— 改错故障：脏数据进入 renderer，或泄漏一个无人持有的端口。
// INV-07 断言：ScopedServicePort 必须整体透传 schema 结果，不得手写字段白名单 —— 守住它的位置：postMessage 前的对象展开 —— 改错故障：main 新增 scope 字段后 renderer 绑定错会话，本文件已经发生过一次。
// INV-08 断言：冷启动的一次性事件在 preload 缓存并回放，订阅晚到也不丢 —— 守住它的位置：pendingOpenWorkspacePaths、pendingShareImports 与三个 latest 变量 —— 改错故障：只打开 App 不打开目录，更新态永远停在初始值。
// INV-09 断言：回放队列在订阅建立时一次排空，且必须先注册再排空 —— 守住它的位置：onOpenWorkspacePath 与 onShareImport 的 while 循环 —— 改错故障：先排空再注册会丢掉注册前一刻到达的事件。
// INV-10 断言：缩放档位与窗口控制区边距以 preload 缓存为准，main 广播只覆盖缓存 —— 守住它的位置：latestDesktopZoomLevel 与 latestWindowControlsOverlayMetrics —— 改错故障：同步读取接口返回旧值，标题栏按钮在缩放后错位。
// INV-11 断言：缩放档位必须夹紧在上下限之间，非有限值一律回落到 0 —— 守住它的位置：clampDesktopZoomLevel 与 resolveDesktopZoomLevelFromFactor —— 改错故障：对数运算得到非数值后，整个标题栏高度也变成非数值。
// INV-12 断言：控制区边距是 CSS 像素，须按 zoomFactor 反算后再下发 —— 守住它的位置：readCurrentWindowControlsOverlayReadyPayload 的两个平台分支 —— 改错故障：高缩放下红绿灯与系统按钮压住正文。
// INV-13 断言：订阅方法内部一律用包装后的 handler，不把 renderer 回调直接交给 ipcRenderer —— 守住它的位置：各 on 系列方法里的局部 handler ── 改错故障：Electron 事件对象被透传进渲染进程，桥接边界泄漏。
// INV-14 断言：需要往返的走 invoke，只播报不需回执的走 send —— 守住它的位置：log、syncWindowTabs、startCuaHelperPermissionDrag 等调用点 —— 改错故障：拖拽起手被 await 打断，或高频同步事件在 main 侧堆成无主 Promise。
// INV-15 断言：需要 main 回调 renderer 的双向通道必须同时落定成功与失败 —— 守住它的位置：onWebRemoteControlReconnectWorkspace 的 try 与 catch —— 改错故障：回调抛错后 main 端永远等不到结果，重连向导卡死。
// INV-16 断言：只有在 E2E 开关打开时才挂测试桥，开关只读环境变量 —— 守住它的位置：shouldEnableE2ETestBridge 包住的 exposeInMainWorld —— 改错故障：生产环境多出一个可清空审计事件的全局对象。
// INV-17 断言：preload 不持有业务状态，新增缓存必须说明回放语义与释放时机 —— 守住它的位置：文件上部那组 Set 与 pending 数组 —— 改错故障：切窗口后旧回调仍在集合里，事件被已卸载的界面消费。
// INV-18 断言：启动控制面先于普通 RPC 建立，且只做镜像转发 —— 守住它的位置：DatabaseStartupState 与 DatabaseStartupControl 两条监听 —— 改错故障：renderer 重启后拿不到启动阶段，或 preload 私自触发迁移。
import { installPluginSandboxHostBridge } from "./pluginSandbox/hostBridge.js";
import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
} from "@zcode/shared";
/* eslint-disable max-lines -- preload bridge 集中暴露桌面平台 IPC，拆散会让 contextBridge 权限边界更难审计。 */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// ARMS frame preload 闭包内的 send 不会随后序 ipcRenderer.send 补丁生效，须同步包装 Bridge.send
// [时序] 必须在任何业务 IPC 注册之前包装 Bridge，闭包里捕获的 send 不会随后续补丁生效。
// [资源] 这里只做一次幂等包装，重复调用由转发模块内部自守，preload 不额外加锁。
// [失败路径] 包装失败不应阻断后续桥接，ARMS 只是旁路观测，业务通道必须照常可用。
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** 从 command-line 参数中解析 --device-id= */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// 在 contextBridge 建立之前就暴露同步值，让 renderer 在 React 渲染前就能读到
// [契约] 设备标识必须在 contextBridge 建立前同步暴露，React 首帧就要读到它。
// [权衡] 只暴露一个字符串而不是函数，避免 renderer 反复过桥取值。
// [失败路径] 参数缺失时返回空串而非抛错，让上层自行决定是否降级。
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

import type {
  AppSettings,
  ApplicationIconRequest,
  BindRemoteWorkspaceSessionContextResult,
  BindRemoteWorkspaceSessionContextIpcResult,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  Locale,
  OAuthStateRegistration,
  WebRemoteControlAuthStateChange,
  OpenInEditorOptions,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  ZCodeStdioTapDevState,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  SSHConfigAliasOption,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
  RemoteConnectionRuntimeLog,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
  CreateTempTextAttachmentRequest,
  MaterializeWorkflowArtifactFileRequest,
  OpenCuaPermissionOnboardingOptions,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import { unwrapRemoteWorkspaceBindResult } from "./remoteWorkspaceBindBridge.js";
import {
  InternalChannels,
  PlatformChannels,
  formatZCodeRendererProcessName,
  scopedServicePortPayloadSchema,
  shouldEnableE2ETestBridge,
} from "@zcode/shared";
import { createOAuthCallbackHandler } from "./oauthCallbackBridge.js";

// [契约] 测试桥只在显式开关下出现，生产包里这个全局名字必须不存在。
// [契约] 暴露面只有读取、清空、配置三个动作，且全部落到固定通道常量。
// [资源] 该对象不注册任何监听器，也就不需要退订函数，随页面卸载自然消失。
// [权衡] 开关判断放在 preload 而不是 main，是为了让 renderer 连探测都探测不到。
if (shouldEnableE2ETestBridge(process.env)) {
  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}

// [契约] 这组集合与 latest 变量共同构成「事件先到、订阅后到」的回放层。
// [并发] 集合只在 renderer 线程的订阅与退订路径上增删，不做跨线程假设。
// [资源] 退订必须删除同一个回调引用，包一层匿名函数会让集合无法收缩。
const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];
const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

// [契约] 档位是离散整数，所有入口都必须经过同一个夹紧函数。
// [并发] 该函数是纯计算，不做缓存，避免多窗口共享出错误档位。
function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

// [时序] 初始几何要在 React 挂载前算好并立即上报 main，否则标题栏先闪一帧旧位置。
// [契约] 上报值同时写入本地缓存，后续同步读取接口直接复用这一份。
// [失败路径] 平台不是 macOS 或 Windows 时返回空对象，调用方按「无自定义控制区」处理。
const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
// RootStartupLoading 渲染前 main 进程就需要拿到当前 zoom 对应的红绿灯位置。
// preload 比 React 页面更早运行，这里主动通知 main，避免等进入 App 页面后才调整。
ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

ipcRenderer.on(
  PlatformChannels.WindowControlsOverlayChanged,
  (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
    latestWindowControlsOverlayMetrics = metrics;
  },
);

ipcRenderer.on(
  PlatformChannels.DesktopZoomLevelChanged,
  (_event: unknown, state: DesktopZoomState) => {
    if (Number.isFinite(state.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
  },
);

// [契约] 无订阅者时先把路径压进队列，不能让 main 的一次性投递白白丢掉。
// [并发] 投递与订阅可能落在同一事件循环的不同轮次，队列是唯一交接点。
// [权衡] 队列不设上限，因为同一次冷启动里 deep link 不会无界增长。
ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
  if (openWorkspacePathCallbacks.size === 0) {
    // 冷启动 open-workspace 会在 renderer ready 后立刻从 main 进程投递，
    // 但 React 的 platform effect 可能尚未注册 onOpenWorkspacePath。preload 先接住
    // 这条 IPC，等 UI 订阅建立后再回放，避免只打开 App 而不打开目录。
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

// [契约] 分享码与工作区路径同构：先缓存再回放，保证订阅者一定能看到。
// [并发] 回放发生在订阅方法内，广播路径只负责分发给已注册回调。
// [失败路径] 单个回调抛错会中断本轮分发，队列已清空，重试由上层负责。
ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

// [契约] 进程标题只由 document.title 派生，不缓存第二份状态。
// [失败路径] 文档尚未就绪时标题可能为空，DOMContentLoaded 会再纠正一次。
function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

// [契约] 每次广播都先刷新缓存再分发，订阅者读到的缓存与回调入参一致。
// [时序] 只有下载完成状态才保留 ready 版本，其余状态必须把旧值清空。
// [并发] 广播是同步遍历，回调里不要做重活，否则会拖慢后续订阅者。
function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady 是兼容旧交互的一次性缓存，但 update-downloaded
  // 之后 Squirrel.Mac 可能再上报 staging error。此时 main 会广播 idle/error，
  // preload 必须同步清掉旧 ready，否则 React 重新订阅时会把已失效版本回放出来。
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// 进程检索体验优化：renderer 在系统里通常只会显示成通用 helper 名称，
// 这里在 preload 阶段补上 zcode-* title，便于按窗口角色筛选。
// [时序] 立即执行一次覆盖冷启动窗口，DOMContentLoaded 只作为二次兜底。
// [资源] 监听器带一次性标记，标题更新后自动摘除，不产生常驻监听。
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

// [契约] 下面是 renderer 唯一可见的平台能力面，任何新增都必须显式写进这个对象。
// [契约] 禁止把 ipcRenderer 本体或通道枚举挂进来，否则白名单形同虚设。
// [权衡] 方法名按业务语义命名而非通道名，main 侧重命名通道时 renderer 无需跟改。
// [资源] 订阅类方法一律返回退订函数，React 的清理逻辑直接使用返回值即可。
/**
 * Preload bridge —— 仅暴露需要 main 进程参与的平台操作
 *
 * 凭据管理已迁移到 host process 的 ICredentialService，
 * 通过 MessagePort RPC 访问，不再经过此 bridge。
 */
contextBridge.exposeInMainWorld("zcode", {
  // [契约] 连接参数在这里完整透传，不做校验，校验责任在 main 侧 handler。
  // [失败路径] invoke 被拒绝时错误已跨桥降级，调用方只能拿到可序列化字段。
  // [权衡] 可选的请求号由 renderer 生成，用于把并发连接请求与结果配对。
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      confirmSourceServerInstall?: boolean;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  requestSourceSettingsAttachment: (sourceServerId: string) =>
    ipcRenderer.invoke(PlatformChannels.RequestSourceSettingsAttachment, {
      sourceServerId,
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }): Promise<BindRemoteWorkspaceSessionContextResult> =>
    ipcRenderer
      .invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context)
      .then((result: BindRemoteWorkspaceSessionContextIpcResult) =>
        unwrapRemoteWorkspaceBindResult(result),
      ),
  startWebRemoteControl: (context: WebRemoteControlContext) =>
    ipcRenderer.invoke(PlatformChannels.StartWebRemoteControl, context),
  stopWebRemoteControl: (): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StopWebRemoteControl),
  getWebRemoteControlStatus: () => ipcRenderer.invoke(PlatformChannels.GetWebRemoteControlStatus),
  // [契约] 订阅返回的闭包必须原样移除本方法注册的那一个 handler。
  // [资源] handler 每次订阅独立创建，不能提到模块作用域复用，否则退订会误删他人监听。
  // [并发] main 侧状态可能高频变化，分发只做透传，不在 preload 合并。
  onWebRemoteControlStatusChanged: (
    callback: (status: WebRemoteControlStatus) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: WebRemoteControlStatus) => callback(payload);
    ipcRenderer.on(PlatformChannels.WebRemoteControlStatusChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlStatusChanged, handler);
  },
  disposeRemoteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.DisposeRemoteSession, sessionId),
  isDockerAvailable: (): Promise<boolean> => ipcRenderer.invoke(PlatformChannels.IsDockerAvailable),
  listWSLDistros: () => ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
  listDockerContainers: () => ipcRenderer.invoke(PlatformChannels.ListDockerContainers),
  listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
    ipcRenderer.invoke(PlatformChannels.ListSSHConfigAliases),
  loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.LoadMcpFromUserDirectory, payload ?? {}),
  saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.SaveMcpToUserDirectory, payload),
  migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
    ipcRenderer.invoke(PlatformChannels.MigrateLegacyCommonMcp, payload ?? {}),
  /** renderer 日志通过 IPC 传到 main 进程统一存储 */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** 打开系统目录选择框，返回选中路径或 null */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** 打开系统多目录选择框；取消时返回空数组 */
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectories),
  /** 打开系统文件选择框，返回选中文件路径或 null */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** 打开系统多文件选择框，返回选中文件路径；取消时返回空数组 */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** 通过 main process 的原生另存为对话框明确落盘 */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** 将当前页面的 print 媒体版面导出为 PDF（Chromium 打印引擎，矢量文本） */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** 从系统拖拽/文件输入得到的 Web File 解析真实本地路径 */
  // [契约] 文件工具只能在 preload 调用，renderer 拿不到拖拽文件的真实路径。
  // [失败路径] 空路径统一归一为 null，调用方据此走内联附件兜底。
  getPathForFile: (file: File): string | null => {
    // Electron 32 起移除了非标准 File.path，renderer 不能再直接从拖拽 File 上取路径。
    // webUtils 只能在 preload 安全使用；取不到路径时返回 null，让 Web/内联附件逻辑继续兜底。
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** 长文本粘贴落盘为真正的本地附件，避免正文和 prompt payload 被撑大 */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** dwf 产物「作为文件打开」：把某一版的字节落成本机副本 */
  materializeWorkflowArtifactFile: (payload: MaterializeWorkflowArtifactFileRequest) =>
    ipcRenderer.invoke(PlatformChannels.MaterializeWorkflowArtifactFile, payload),
  /** 订阅当前窗口内远程连接过程日志，返回 disposer */
  // [契约] 日志条目按 main 的到达顺序单向下发，preload 不排序也不去重。
  // [资源] 订阅方通常是临时面板，退订后不得再持有日志对象引用。
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** 订阅当前窗口内远程 session 关闭事件，返回 disposer */
  // [契约] 会话关闭是一次性事实，订阅晚到不会再补发。
  // [失败路径] 关闭事件里若带远端原因，跨桥只保留字符串字段。
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** 订阅 Source 自动重连后的 logical session 换代事件。 */
  onRemoteSessionReconnected: (callback: (event: RemoteSessionReconnectedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionReconnectedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionReconnected, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionReconnected, handler);
  },
  /** 检查目录是否已在其他窗口打开 */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** 同步当前窗口所有 tab 的 workspace 路径到 main 进程 */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** 同步当前窗口里 Web 远程控制允许切换的 workspace */
  syncWebRemoteControlWorkspaces: (workspaces: WebRemoteControlWorkspaceTarget[]) =>
    ipcRenderer.send(PlatformChannels.SyncWebRemoteControlWorkspaces, workspaces),
  // [契约] 这是本文件唯一的双向通道：renderer 处理完请求后必须回发同一个请求号。
  // [失败路径] 回调抛错时仍要回发失败结果，否则手机端会一直等这次重连。
  // [资源] 回发用事件自带的 sender，不经过全局 ipcRenderer，避免把结果发错窗口。
  onWebRemoteControlReconnectWorkspace: (
    callback: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ) => {
    const handler = async (event: Electron.IpcRendererEvent, payload: unknown) => {
      const request = payload as WebRemoteControlReconnectWorkspaceRequest;
      try {
        const result = await callback(request);
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, result);
      } catch (error) {
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WebRemoteControlReconnectWorkspaceResult);
      }
    };
    ipcRenderer.on(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
  },
  /** 同步当前窗口的未读 task 数到 main 进程 */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** 同步需要 main 进程即时感知的应用设置 */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** 查询关闭驻留托盘能力（Linux 置灰判断；spec：docs/desktop/linux-close-to-tray.md） */
  getCloseToTrayCapability: () => ipcRenderer.invoke(PlatformChannels.GetCloseToTrayCapability),
  /** 快捷键设置页录制态开关：main 暂时摘除可配置菜单 accelerator，防止录制按键触发原命令 */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** 注册 main 进程要求聚焦指定 workspace tab 的回调，返回 disposer */
  // [契约] main 只要求聚焦，切换标签的具体行为仍由 renderer 决定。
  // [资源] 退订闭包捕获的是本次注册的 handler，不是回调本身。
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** 注册 main 进程触发新建 tab 的回调，返回 disposer */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** 注册 main 进程请求关闭当前上下文的回调，返回 disposer */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** 注册内置 webview 的受控新页面请求，返回 disposer */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** 注册内置浏览器网页权限/源选择/设备选择弹窗请求，返回 disposer */
  // [契约] 网页权限的判定必须在界面呈现、由用户决定，preload 只做搬运。
  // [时序] 弹窗请求与用户决策是配对事件，请求号由 main 生成，preload 不参与。
  // [失败路径] 若界面尚未订阅，请求不会被缓存，也就不会有人回应，main 侧需要自己的超时兜底。
  onEmbeddedBrowserPermissionPrompt: (
    callback: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: EmbeddedBrowserPermissionPromptEvent) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
  },
  /** 回传用户对内置浏览器权限弹窗的决策 */
  // [契约] 决策走单向下发，不需要回执，也不阻塞弹窗关闭。
  // [失败路径] 重复提交同一决策由 main 侧幂等处理，preload 不做去重。
  resolveEmbeddedBrowserPermissionPrompt: (
    request: EmbeddedBrowserPermissionResolveRequest,
  ): void => {
    ipcRenderer.send(PlatformChannels.EmbeddedBrowserPermissionResolve, request);
  },
  /** 读取内置浏览器站点权限记录（设置页「网站权限」） */
  getEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetEmbeddedBrowserSitePermissions),
  /** 修改/删除单条站点权限 */
  setEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.SetEmbeddedBrowserSitePermission, request),
  /** 清空全部站点权限记录 */
  clearEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserSitePermissions),
  /** 重置单个站点的全部权限记录 */
  resetEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, request),
  /** 注册 agent 首次 browser 命令建好受控 view 的回调（自动开 browser-use tab），返回 disposer */
  // [契约] view 就绪事件携带浏览器代次，调用方必须用它过滤过期标签。
  // [资源] 每次订阅独立注册，退订后不再收到后续 view 事件。
  onBrowserViewReady: (
    callback: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        tabId: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewReady, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewReady, handler);
  },
  /** 注册 agent browser-use 命中真实 tab 的操作状态回调，返回 disposer。 */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** 注册当前受控 tab viewport 变化回调，Agent 设置时用于同步自由尺寸模式。 */
  onBrowserViewViewportChanged: (
    callback: (payload: BrowserViewViewportChangedPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewViewportChangedPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewViewportChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewViewportChanged, handler);
  },
  onBrowserViewScreenshotSurfacePrepare: (
    callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  },
  onBrowserViewScreenshotSurfaceRelease: (
    callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  },
  // [契约] 截图表面就绪是单向播报，main 收到后才开始抓帧。
  // [时序] 该消息必须在准备回调之后发出，提前发会让 main 抓到空白表面。
  browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
    ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
  },
  onBrowserViewVisibility: (
    callback: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        visible: boolean;
        workspaceKey: string;
        remoteSessionId: string | undefined;
        sessionId: string;
        tabId?: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewVisibility, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewVisibility, handler);
  },
  /** 注册 agent close 命令要求卸载受控 tab 的回调，返回 disposer */
  onBrowserViewCloseTab: (
    callback: (payload: BrowserViewCloseTabNotification) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewCloseTabNotification) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewCloseTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewCloseTab, handler);
  },
  // [契约] 挂起与恢复共用同一份驻留状态载荷，两边字段必须对称处理。
  // [资源] 挂起期间 renderer 不应再持有 view 句柄，退订只影响通知不影响驻留。
  onBrowserViewSuspend: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewSuspend, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewSuspend, handler);
  },
  onBrowserViewRestore: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewRestore, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewRestore, handler);
  },
  /** 注册 main 进程触发新建任务的回调，返回 disposer */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** 注册 main 进程触发打开工作区的回调，返回 disposer */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** 注册 deep link 直接打开本地工作区目录回调，返回 disposer */
  // [契约] 订阅时先把队列排空再返回退订函数，保证回放窗口没有空档。
  // [并发] 排空用逐个消费的方式，回调里若同步取消订阅，剩余队列仍会被本轮处理。
  // [资源] 退订只从集合删除，不清理已被消费的路径，队列随消费自然缩短。
  onOpenWorkspacePath: (callback: (path: string) => void): (() => void) => {
    openWorkspacePathCallbacks.add(callback);
    while (pendingOpenWorkspacePaths.length > 0) {
      const path = pendingOpenWorkspacePaths.shift();
      if (path) {
        callback(path);
      }
    }
    return () => openWorkspacePathCallbacks.delete(callback);
  },
  onOpenFeedbackDialog: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenFeedbackDialog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFeedbackDialog, handler);
  },
  onOpenTicketsPanel: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenTicketsPanel, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenTicketsPanel, handler);
  },
  /** 注册窗口全屏状态变化回调，返回 disposer */
  // [契约] 全屏状态只影响布局，preload 不缓存，订阅即读 main 的最新广播。
  // [失败路径] 非布尔值不应到达这里，main 侧发出前已经归一。
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** 读取窗口最大化状态与系统原生圆角能力 */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** 注册窗口最大化状态与系统原生圆角能力变化回调 */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** 同步读取当前原生窗口控制区安全边距 */
  // [契约] 这是同步读取接口，优先返回缓存，缓存为空才现算一次。
  // [时序] 缓存由变更广播与启动上报共同维护，读到的值与最近一次广播一致。
  // [权衡] 现算要读 webFrame 的缩放，只作为首帧兜底，不应成为常态路径。
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** 注册原生窗口控制区安全边距变化回调，返回 disposer */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** 同步读取当前桌面窗口页面缩放档位 */
  // [契约] 查询结果先夹紧再写回缓存，返回的档位与后续广播同源。
  // [失败路径] main 返回缺字段时保留本地缓存，不把空值传给界面。
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** 注册当前桌面窗口页面缩放档位变化回调，返回 disposer */
  // [契约] 订阅时立即回调一次当前档位，让界面不必再单独查询。
  // [失败路径] 非法档位广播会被丢弃，既不写缓存也不通知订阅者。
  onDesktopZoomLevelChanged: (callback: (state: DesktopZoomState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopZoomState) => {
      if (!Number.isFinite(state.zoomLevel)) {
        return;
      }
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      callback({ zoomLevel: latestDesktopZoomLevel });
    };
    callback({ zoomLevel: latestDesktopZoomLevel });
    ipcRenderer.on(PlatformChannels.DesktopZoomLevelChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopZoomLevelChanged, handler);
  },
  /** 注册用户点击系统通知后跳转到对应任务的回调，返回 disposer */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  /** 打开外部 URL（用于 OAuth 跳转浏览器） */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** 查询当前语言下是否存在可用的用户社群入口 */
  canOpenCommunity: (locale: Locale): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.CanOpenCommunity, locale),
  /** 在系统文件管理器中打开指定路径 */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** 使用系统默认应用打开本地文件 */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** 打开 ZCode Computer Use 完整权限引导 */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** 只取消当前 renderer 以 operationId 发起的 onboarding participant。 */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** 预热并缓存已验证的 Helper 路径，使 dragstart 能同步 startDrag（避免异步 I/O 错过手势） */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** 从权限浮窗拖拽 Helper.app 到 macOS 权限列表。必须是 send —— invoke 的往返会错过手势。 */
  // [契约] 起手拖拽必须用 send，invoke 的往返会让系统错过手势起点。
  // [权衡] 因此这里没有返回值，失败只能在 main 侧日志里看到。
  // [时序] 调用前要求预热已完成 Helper 路径，否则拖拽会拿到空文件。
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  notifyWebRemoteControlAuthStateChanged: (change: WebRemoteControlAuthStateChange) =>
    ipcRenderer.send(PlatformChannels.WebRemoteControlAuthStateChanged, change),
  /** 上报 OAuth state 用于 deep link 路由 */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** 注册 OAuth deep link 回调，返回 disposer */
  // [契约] 授权回调只认 main 转发的 deep link，preload 不解析参数。
  // [资源] 退订只移除本窗口的监听，已发出的回执不影响其他窗口。
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** 注册支付 deep link 回调，返回 disposer */
  onPaymentCallback: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on(PlatformChannels.PaymentCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.PaymentCallback, handler);
  },
  // [契约] 与工作区路径同构：先注册再排空，排空期间不丢事件。
  // [资源] 退订不清理队列，未消费的分享码留给后续订阅者。
  onShareImport: (callback: (payload: { shareCode: string }) => void): (() => void) => {
    shareImportCallbacks.add(callback);
    while (pendingShareImports.length > 0) {
      const payload = pendingShareImports.shift();
      if (payload) callback(payload);
    }
    return () => shareImportCallbacks.delete(callback);
  },
  /** 通知 main process renderer 已就绪 */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** 同步 renderer telemetry 上下文到 main process */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** 通过 main process 统一上报业务 telemetry 事件 */
  reportTelemetryEvent: (payload: {
    context: TelemetryRendererContext;
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke(PlatformChannels.ReportTelemetryEvent, payload),
  /** 通过 main process 统一上报 ARMS 自定义事件 */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** 读取 Renderer 用户操作 Trace 灰度配置。 */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** 订阅 Main 推送的 Renderer 用户操作 Trace 配置变化。 */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** 发送已结束 Span；使用 send 避免遥测往返阻塞业务。 */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * 主窗口 renderer 的 60 秒 heap 读数。
   * 只提供单向 send：main 不回执，renderer 也不能靠它反查 main 的进程事实。
   */
  // [契约] heap 采样只上行不回落，main 不会回执，renderer 也不能借此反查 main。
  // [资源] 采样对象必须是纯数据，跨桥后不保留任何活引用。
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** 通过 main process 触发原生任务通知 */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  /** 导出日志：打包 ~/.zcode/v2 及外部 agent 日志为 zip 并在 Finder 中显示 */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** 截取当前窗口，用于错误反馈携带现场画面 */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot：`<webview>` guest dom-ready 后上报 webContentsId 给 main attach。
  // [契约] guest 的 webContentsId 由 renderer 在 dom-ready 后上报，main 据此建立调试会话。
  // [时序] attach 必须早于任何操作指令，否则 main 找不到可调试的目标。
  browserViewAttachGuest: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewAttachGuest, payload),
  /** React 卸载旧 `<webview>` 前同步等待 main 断开 native CDP session。 */
  browserViewDetachGuest: (payload: { key: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewDetachGuest, payload),
  browserViewCloseTab: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewCloseTabFromRenderer, payload),
  browserViewReportResidency: (payload: BrowserViewResidencyReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReportResidency, payload),
  browserViewSuspendReady: (payload: { tabId: string; generation: number }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewSuspendReady, payload),
  browserViewEnsureResident: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewEnsureResident, payload),
  browserViewRestoreTabs: (
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewRestoreTabs, payload),
  /** 将 UI 自由尺寸同步为当前受控 tab 的真实 viewport。 */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** 从自动发现的 Chrome Profile 一次性导入内置浏览器数据。 */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** 清理内置浏览器缓存或全部站点数据。 */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** 读取开发态 stdio tap proxy 开关状态 */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** 注册 main 进程修改 settings 后的通知，返回 disposer */
  // [契约] 设置变更只通知，不携带差异，订阅方自行重新读取需要的字段。
  // [资源] 监听挂在 ipcRenderer 上，窗口销毁前必须退订，否则回调会打到已卸载组件。
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** 注册应用语言变化，返回 disposer */
  onApplicationLocaleChanged: (callback: (locale: Locale) => void): (() => void) => {
    const handler = (_event: unknown, locale: Locale) => callback(locale);
    ipcRenderer.on(PlatformChannels.ApplicationLocaleChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ApplicationLocaleChanged, handler);
  },
  /** 注册"手动检查更新"结果的回调，返回 disposer */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** 开始下载当前已发现的更新 */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** 取消当前正在下载的更新 */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** 打开独立更新窗口 */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** 读取自动更新偏好 */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** 写入“自动下载并安装更新”偏好 */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** 注册自动更新持续状态变化，返回 disposer */
  // [契约] 订阅时若已有缓存状态，立即回放一次，界面不会停在初始空态。
  // [并发] 回放发生在注册之后，回放期间到达的新广播按正常分发处理。
  // [资源] 退订只删除回调，缓存继续为后续订阅者服务。
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** 注册新版本已下载完毕的回调，返回 disposer */
  // [契约] 下载完成是一次性事实，preload 缓存最新版本并在订阅时回放。
  // [时序] 版本号只在下载完成时写入，其他状态会把它清空。
  // [资源] 回放后仍保留缓存，晚挂载的第二个订阅者同样能拿到。
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // 主进程的 update-ready 是一次性事件，常常早于 React effect 注册。
    // 这里在 preload 层先缓存最新版本，并在订阅时立即回放，
    // 这样 UI 即使晚挂载，也能拿到“更新已下载完毕”的稳定状态。
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** 注册更新安装后的版本说明，返回 disposer */
  onPostUpdateReleaseNotes: (
    callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): (() => void) => {
    postUpdateReleaseNotesCallbacks.add(callback);
    if (latestPostUpdateReleaseNotes) {
      callback(latestPostUpdateReleaseNotes);
    }
    return () => {
      postUpdateReleaseNotesCallbacks.delete(callback);
    };
  },
  /** 标记当前版本说明已读 */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** 跳过当前已发现的更新版本 */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** 用户确认重启安装更新 */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** 获取已安装的编辑器/终端列表（含图标） */
  getInstalledEditors: (filePath?: string) =>
    ipcRenderer.invoke(PlatformChannels.GetInstalledEditors, filePath),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** 用指定编辑器打开路径 */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** 执行桌面窗口级命令 */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** 同步应用菜单语言 */
  setApplicationLocale: (locale: Locale) =>
    ipcRenderer.invoke(PlatformChannels.SetApplicationLocale, locale),
  /** 读取宿主系统语言 */
  getSystemLocale: (): Promise<Locale> => ipcRenderer.invoke(PlatformChannels.GetSystemLocale),
  /** 同步标题栏亮暗色 */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** 获取桌面端设备标识符（deviceMid） */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

// [契约] 插件沙箱桥在主桥之后安装，避免它覆盖同名方法。
// [资源] 它自行管理监听生命周期，本文件不重复注册也不重复退订。
// [权衡] 放在暴露之后是为了让安装失败时主桥已经可用。
installPluginSandboxHostBridge();

/**
 * MessagePort 不能通过 contextBridge 传递（contextBridge 会把它包成 Proxy，
 * 丢失 addEventListener 等原生方法）。改用 window.postMessage 的 transfer
 * 机制将 MessagePort 原样传递到 renderer 的 window context 中。
 */
// [契约] MessagePort 不能穿过 contextBridge，只能用 postMessage 的转移列表搬运。
// [失败路径] 端口存在但载荷校验失败时必须关闭，否则端口泄漏且无人认领。
// [并发] 每次投递都新建端口，preload 不缓存也不复用，避免两个窗口抢同一通道。
// [权衡] 目标源用通配符，因为这里是同窗口自投递，没有第三方可泄。
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

// [契约] 校验失败时静默丢弃并关闭端口，不向 renderer 回错误。
// [契约] 转发必须整体展开校验结果，手写字段白名单曾导致会话绑定错位。
// [并发] 端口随消息一次性转移，preload 侧不再持有，避免二次投递。
// [资源] 这里的关闭是唯一释放点，漏掉就会留下悬挂端口。
ipcRenderer.on(InternalChannels.ScopedServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = scopedServicePortPayloadSchema.safeParse(payload);
  if (!port || !parsed.success) return;
  // Bug 根因：这里曾用手工字段白名单重建 payload；Main 新增 workspace scope 后
  // Preload 未同步白名单，Renderer 因而把 project logical session 原地绑定成 conversation。
  window.postMessage(
    {
      type: InternalChannels.ScopedServicePort,
      ...parsed.data,
    },
    "*",
    [port],
  );
});

ipcRenderer.on(
  // [契约] 源设置端口同样走转移列表，载荷只带附件与源服务两个标识。
  // [失败路径] 没有端口直接返回，不构造空消息，避免 renderer 拿到无效附件。
  // [时序] 该端口在设置面板打开期间有效，面板关闭后由 renderer 自行释放。
  InternalChannels.SourceSettingsServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sourceServerId?: string;
    },
  ) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage(
      {
        type: InternalChannels.SourceSettingsServicePort,
        attachmentId: payload.attachmentId,
        sourceServerId: payload.sourceServerId,
      },
      "*",
      [port],
    );
  },
);

// [契约] 只接受本窗口自投递的消息，来源不是当前窗口一律丢弃。
// [契约] 就绪回执必须同时带附件号与会话号，两者缺一不可。
// [时序] 这是 renderer 侧确认端口可用的唯一信号，main 不能把投递当成可用。
window.addEventListener("message", (event) => {
  if (event.source !== window || typeof event.data !== "object" || event.data === null) {
    return;
  }
  const payload = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type !== InternalChannels.ScopedServicePortReady ||
    typeof payload.attachmentId !== "string" ||
    !payload.attachmentId ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId
  ) {
    return;
  }
  // MessagePort 注册发生在隔离的 renderer world，Main 不能把“已投递”误当作“已可用”。
  // preload 只把 renderer 的 ready ACK 薄转发给 Main，业务 attachment 状态仍由窗口 session manager 管理。
  ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
    attachmentId: payload.attachmentId,
    sessionId: payload.sessionId,
  });
});

// [契约] 提示音由 renderer 播放，main 只负责告知时机。
// [权衡] 用窗口消息而非再开一条 IPC，音频逻辑属于页面层。
ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
  window.postMessage(InternalChannels.TaskNotificationSound, "*");
});

// [契约] main 的一次性事件在这里转成可回放的订阅语义。
// [资源] 监听常驻整个 preload 生命周期，无需退订。
ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
  notifyUpdateReadyCallbacks(version);
});

ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
  notifyUpdateStateCallbacks(payload);
});

ipcRenderer.on(
  PlatformChannels.PostUpdateReleaseNotes,
  (_event, payload: PostUpdateReleaseNotesPayload) => {
    notifyPostUpdateReleaseNotesCallbacks(payload);
  },
);

// dom-ready autoInject 之后 Bridge 若被重置，再尝试一次包装
scheduleArmsEventBridgePatch();

// [契约] 启动状态只做镜像转发，preload 不推断也不补全字段。
// [失败路径] 校验不通过就丢弃，renderer 宁可停在加载态也不该读到半截状态。
// [时序] 该监听必须在 renderer 提出控制指令之前就位，否则首条指令会没有回音。
// 启动控制面先于普通 RPC；reload 从 Main 的通知镜像补齐，不触发新迁移。
ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
  const parsed = databaseStartupStateSchema.safeParse(raw);
  if (parsed.success)
    window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
});
// [契约] 控制指令只接受本窗口消息，且必须通过校验才上送。
// [失败路径] 校验失败静默丢弃，不回错误，避免 renderer 反复重试。
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
    return;
  const parsed = databaseStartupControlSchema.safeParse(event.data.control);
  if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
});
