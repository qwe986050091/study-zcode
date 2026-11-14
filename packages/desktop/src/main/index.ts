// ── 文件职责（Electron main 入口装配） ──
// Electron 主进程入口：应用级单例、协议/权限注册、窗口与 Host 进程生命周期都由 main 装配，
// 自动更新、托盘/菜单、遥测与退出屏障也归它编排，而 main 不承载业务逻辑。
// 业务能力在 Host（utility process）与 renderer 中，main 只做授权、路由与生命周期裁决。
//
// ── 启动顺序（不可随意调换） ──
// 1. 模块顶层：注册自定义协议 scheme（必须在 app ready 前）→ 运行时路径/名称 →
//    unhandledRejection → 图标路径 → 关闭驻留能力 monitor；
// 2. 同步注册 IPC（dialog、ttft、browser 相关）与单例管理器；必须早于 app.whenReady 完成。
// 3. requestSingleInstanceLock：失败立即 quit，绝不能再创建窗口；
// 4. app.whenReady：安全诊断 → 插件沙箱 → bootstrap 设置（含数据目录）→
//    数据库启动门 → 平台集成 → 网络/权限策略 → 自动更新 → IPC 注册 → 遥测 →
//    强制升级 gate → 创建主窗口。
//
// ── 不变量表 ──
// INV-01：requestSingleInstanceLock 之前不得创建任何窗口/Host；锁失败分支只允许 quit。
//         （gotTheLock 分支）
// INV-02：单实例的 additionalData 决定第二个进程如何处理 deep link / workspace 打开；
//         不带 it 时新进程无法把请求转交给首实例。（createDeepLinkSingleInstanceData）
// INV-03：一个窗口最多一个 Host；host 生命周期必须与窗口 id 绑定，
//         窗口 closed 后必须从 windowHostProcessMap 移除并释放关联资源。
// INV-04：before-quit 第一次必须 preventDefault，等 prepareAppQuit 完成后才真正退出；
//         否则 host/agent 进程树会被 init 接管成残留进程。（hasPreparedAppQuit）
// INV-05：prepareAppQuit 幂等：并发调用共享 appQuitPreparationInFlight，
//         不允许出现第二轮超时预算叠加。（selection.upgraded 分支 + in-flight）
// INV-06：退出顺序固定为：停止采样 → 停调度器 → flush 遥测 → 回收 Host → 放行退出；
//         反过来会在 flush 前杀掉 host，丢失最后一次 /event/report。
// INV-07：forceQuit 一旦置真不可回退；它决定 before-quit 是否还需要用户确认。
// INV-08：shortcutRecordingActive 是跨进程临时态，必须由窗口 closed / render-process-gone
//         按 owner webContents 复位，不能依赖 renderer 的复位 IPC。
// INV-09：closeToTray 可用性 = 平台能力 ∧ Tray 实例创建成功；只信 DBus 探测会让
//         隐藏后的窗口在 GNOME 上永久失联。（desktopTrayReady）
// INV-10：bootstrap 设置必须在任何 Host 创建前应用；dataBaseDir 尤其如此，
//         它决定 Host 读取哪份数据库。（whenReady 的 bootstrap 段）
// INV-11：协议版本/端点协商只在 main 完成：renderer 不得自行拼 endpoint；
//         resolveCurrentZCodeEndpointOrigin 是唯一来源。
// INV-12：强制升级 gate 命中后禁止创建主窗口，但必须保留一个可聚焦的 gate 窗口，
//         否则用户会看到应用“启动即消失”。（forceUpdateMainWindowCreationBlocked）
// INV-13：自动更新安装前必须先走完 prepareAppQuit，再执行 Windows 资源锁清理；
//         顺序反转会让 NSIS 在文件仍被占用时覆盖失败。
// INV-14：自定义协议与权限策略必须在 app ready 前/首个 guest attach 前注册完成；
//         迟到的注册会被 Electron 忽略且不报错。
// INV-15：任何窗口级回调都必须先判 isDestroyed；closed 阶段 webContents 可能已销毁。
// INV-16：telemetry 上报一律 fire-and-forget（catch 后不抛），不得阻塞启动与退出。
// INV-17：退出/关闭对话框只在 production 且存在运行中会话时出现，避免开发态被反复打断。
// INV-18：所有单例式资源（tray/update window/cron scheduler）在重复调用时必须复用或幂等。
import { installRequestSecurityDiagnostics } from "./request-security-edition/index.js";
import { createLocalTtftExporter } from "./localTtftExporter.js";
/* eslint-disable max-lines */
import "./desktopEarlyDataBaseDirBootstrap.js";
import "./desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { powerMonitor, powerSaveBlocker } from "electron";
import { crashCapturePaths } from "./appCrashCaptureBootstrap.js";
import { armsInitPromise } from "./appARMSBootstrap.js";
import {
  onLocalDatabaseStartupReady,
  configureDatabaseStartupQuit,
} from "./databaseStartupRelay.js";
import armsRum from "@arms/rum-electron";
import { createArmsUserIdentitySync } from "./armsUserIdentity.js";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import {
  createDesktopContextPromptRollout,
  createElectronDesktopContextPromptConfigFetcher,
} from "./desktopContextPromptRollout.js";
import { buildBrowserViewCloseTabNotification } from "./browserView/browserCloseTabNotification.js";
import { BrowserGuestManager } from "./browserView/browserGuestManager.js";
import { createElectronBrowserWebmRecorder } from "./browserView/electronBrowserWebmRecorder.js";
import { installBrowserRestoreBootstrapProtocol } from "./browserView/browserRestoreBootstrapProtocol.js";
import {
  createLocalMediaPreviewPathRegistry,
  installLocalMediaPreviewProtocol,
  registerLocalMediaPreviewScheme,
} from "./localMediaPreviewProtocol.js";
import { createDesktopBrowserScreenshotSurfaceCoordinator } from "./browserView/browserScreenshotSurfaceCoordinatorWiring.js";
import { EMBEDDED_BROWSER_PARTITION } from "./browserDataManager.js";
import { EmbeddedBrowserJavaScriptDialogController } from "./embeddedBrowserJavaScriptDialog.js";
import {
  browserOperationResetsResizeBaseline,
  resolveBrowserOperationTabId,
} from "./browserView/browserOperationIndicator.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeImage,
  net,
  protocol,
  session,
  shell,
  webContents,
} from "electron";
import { randomUUID } from "node:crypto";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import {
  createCredentialService,
  createSettingService,
  createTelemetryCore,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  createTelemetryAuthorizationLoader,
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  getConversationWorkspaceDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  normalizeRuntimeProcessEnv,
  setDataBaseDir,
  migrateApplicationStorage,
  resolveDefaultZCodeAgentCommand,
  startupStorage,
} from "@zcode/services/node";
import {
  desktopMenuMessageIds,
  type Locale,
  type AppSettings,
  type appSettingsPatchSchema,
  PlatformChannels,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_AUTO_UPDATE_ENABLED,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DEFAULT_LOCALE,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  ZCODE_VERSION,
  buildZCodeEndpointUrls,
  resolveWebRemoteControlRelayWsUrl,
  resolveZCodeEndpointOrigin,
  shouldEnableE2ETestBridge,
  type UpdateStatePayload,
  type TelemetryEventPayload,
  HostMessageTypes,
  InternalChannels,
} from "@zcode/shared";
import { logger, webRemoteControlRelayLogger } from "./logger.js";
import { markMainLaunchAppReady } from "./desktopLaunchMarks.js";
import { createCuaPipFocusRouter, resolveCuaPipWindowKey } from "./cuaPipFocusRouter.js";
import { createDesktopTelemetryFetch } from "./desktopTelemetryFetch.js";
import {
  acknowledgePostUpdateReleaseNotes,
  getAutoUpdaterState,
  hydratePendingPostUpdateReleaseNotes,
  initAutoUpdater,
  onAutoUpdaterStateChanged,
  refreshAutoUpdaterReleaseChannel,
  resolveUpdateFeedSourceFromStartupConfig,
  syncAutoUpdaterStateToWindow,
  syncPostUpdateReleaseNotesToWindow,
  syncReadyUpdateToWindow,
} from "./autoUpdater.js";
import { BroadcastHub } from "./broadcastHub.js";
import { TaskRealtimeBus } from "./taskRealtimeBus.js";
import { createAppLaunchGate } from "./appLaunchGate.js";
import { createAppLaunchCoordinator } from "./appLaunchCoordinator.js";
import { createAppTelemetryRuntime } from "./appTelemetryRuntime.js";
import { createRendererActionTraceBroker } from "./rendererActionTraceBroker.js";
import { createRendererActionTraceExporter } from "./rendererActionTraceExporter.js";
import { registerRendererActionTraceIpc } from "./rendererActionTraceIpc.js";
import { createRendererActionTraceRollout } from "./rendererActionTraceRollout.js";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  type AppShutdownKind,
} from "./appShutdownPolicy.js";
import { createPrimaryWindowCoordinator } from "./primaryWindowCoordinator.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { flushMainE2ECoverage } from "./e2eCoverage.js";
import { resolveStartupWindowBootstrap, type StartupWindowBootstrap } from "./startupWorkspace.js";
import {
  createStartupDeepLinkConsumptionGate,
  type ExplicitStartupWorkspaceRequest,
  resolveExplicitStartupWorkspaceBootstrap,
} from "./startupWorkspaceDeepLinkGate.js";
import { createWebRemoteControlManager } from "./webRemoteControlManager.js";
import { createWebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/index.js";
import { createWebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";
import { reconnectWebRemoteControlWorkspaceInRenderer } from "./webRemoteControlRendererReconnect.js";
import { sendWebRemoteControlStatusChangedToWindow } from "./webRemoteControlStatusEvents.js";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";
import { clampDesktopZoomLevel, resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import {
  getDesktopMenuLabel as getDesktopMenuLabelByLocale,
  rebuildApplicationMenu,
  resolveSystemApplicationLocale,
  updateZCodeStdioTapDevMenuState,
} from "./desktopApplicationMenu.js";
import { applyAppIcon } from "./desktopWindowChrome.js";
import { resolveWindowsAppUserModelIdForFlavor } from "../../scripts/desktop-product-identity.mjs";
import type { DesktopWindowSize } from "./desktopWindowSize.js";
import { maybeWarnArchitectureMismatch } from "./desktopArchitectureGuard.js";
import { maybeBlockStartupForForceUpdate } from "./forceUpdateGuard.js";
import { createDesktopTray, updateWindowsDesktopTrayMenu } from "./desktopTray.js";
import {
  createCloseToTrayCapabilityMonitor,
  resolveCloseToTrayBootstrapValue,
  resolveCloseToTrayRuntimeValue,
  resolveCloseToTraySupported,
} from "./desktopTraySupport.js";
import { createWindowsCuaOperationIndicator } from "./windowsCuaOperationIndicator.js";
import {
  configureDockMenu,
  createWindow,
  focusWorkspaceInExistingWindow,
  showCurrentWindowFromDock,
  syncApplicationUnreadBadge,
  handleDesktopWindowCloseRequest,
} from "./desktopWindowLifecycle.js";
import { resolveZCodeBuiltinProviderConfigFilePath } from "./desktopProviderConfig.js";
import {
  getCredentialsDir,
  isDockerDaemonAvailable,
  listSSHConfigAliases,
  listAvailableDockerContainers,
  listAvailableWSLDistros,
  loadHostProcessEnvFromLocalFiles,
  resolveBundledGlmBinaryPath,
  resolveRemoteAssetDirs,
  resolveZCodeEndpointEnvBaseOrigin,
  desktopRuntimeEnv,
  runtimeApplicationName,
  runtimeHomePath,
  runtimeSessionDataPath,
  runtimeUserDataPath,
  shouldUseElectronDefaultUserDataPath,
} from "./desktopRuntimeEnv.js";
import {
  disposeHostProcess,
  disposeHostProcessAndWait,
  listDisposingHostProcesses,
  loadWindow,
  spawnHostProcess,
} from "./desktopHostProcess.js";
import { spawnCronScheduler, type CronSchedulerHandle } from "./desktopCronScheduler.js";
import {
  clearOAuthRoutesForWindow,
  handleDeepLink,
  handleOpenWorkspacePath,
  registerDeepLinkProtocol,
  resolveExternalWorkspaceOpenDialogCopy,
} from "./desktopOAuthDeepLink.js";
import { handleSecondInstanceWorkspaceRequest } from "./desktopSecondInstanceDeepLink.js";
import { installFinderOpenFolderWorkflow } from "./desktopFinderOpenFolderWorkflow.js";
import { installWindowsOpenFolderContextMenu } from "./desktopWindowsOpenFolderContextMenu.js";
import {
  createDeepLinkSingleInstanceData,
  extractWorkspaceOpenPath,
  extractDeepLinkUrlFromArgs,
  extractOpenWorkspacePathFromArgs,
  isWorkspaceOpenUrl,
} from "./desktopDeepLinkUrl.js";
import { createRemoteWorkspaceSessionManager } from "./desktopRemoteSessions.js";
import {
  reportRemoteConnectionStateChangedToArms,
  reportRemoteDisconnectToArms,
  stopRemoteUsageArmsPeriodicSampling,
} from "./desktopRemoteUsageArmsTelemetry.js";
import { resolveCanonicalWslTarget } from "./desktopWslTargetResolver.js";
import {
  listRegisteredHostAgentProcessIds,
  setBrowserUseGuestWebContentsIdsProvider,
} from "./resourceManagerWindow.js";
import { createWebRemoteControlSharedHostAttachments } from "./webRemoteControlSharedHostAttachments.js";
import { createDesktopHelpConfigReader } from "./desktopHelpConfig.js";
import { registerPlatformIpcHandlers } from "./desktopMainIpcPlatform.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { registerRemoteIpcHandlers } from "./desktopMainIpcRemote.js";
import {
  configureDesktopStabilityTelemetry,
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessStartToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessExceptionToArms,
  registerDesktopStabilityMonitors,
  registerStabilityMainWindow,
  scheduleReportPerfAppStartAfterMainViewReady,
} from "./desktopStabilityTelemetry.js";
import {
  configureDesktopResourceTelemetry,
  registerDesktopResourceTelemetry,
  resolveResourceUsageScene,
  stopDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.js";
import { registerRendererHeapSampleIpc } from "./processResourceRendererHeapSource.js";
import {
  registerDesktopZCodeDataSizeTelemetry,
  stopDesktopZCodeDataSizeTelemetry,
} from "./desktopZCodeDataSizeTelemetry.js";
import { configureDesktopMcpTelemetry, reportMcpTelemetryToArms } from "./desktopMcpTelemetry.js";
import {
  configureDesktopNetworkTelemetry,
  registerDesktopNetworkTelemetry,
  stopDesktopNetworkTelemetry,
} from "./desktopNetworkTelemetry.js";
import { applyDesktopChromiumNetworkPolicies } from "./desktopNetworkPolicy.js";
import { applyEmbeddedBrowserPermissionPolicy } from "./embeddedBrowserPermissionPolicy.js";
import { createEmbeddedBrowserSitePermissionStore } from "./embeddedBrowserSitePermissionStore.js";
import {
  createEmbeddedBrowserPermissionUiBridge,
  setActiveEmbeddedBrowserPermissionUiBridge,
} from "./embeddedBrowserPermissionUiBridge.js";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import {
  findWindowsProcessesReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "./windowsInstallResourceLocks.js";
import { mainMemoryDiagnosticsRegistry } from "./mainMemoryDiagnostics.js";
import {
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
  getPluginSandboxHost,
  installPluginSandboxHost,
} from "./pluginSandbox/index.js";

// 自定义 scheme 必须在 app ready 之前注册：ready 之后调用 registerSchemesAsPrivileged 无效。
// 这里一次性声明本地媒体与插件沙箱两个 scheme，因为二者的特权属性必须同批生效。
// 后续在 ready 时只做 handler/protocol 的安装，不再改特权配置。
// 若把注册挪到 whenReady 内，媒体预览会以普通 scheme 运行，fetch/CSP 行为全部改变。
// 同时把插件沙箱特权 scheme 一并声明，避免两处各自注册导致顺序不确定。
registerLocalMediaPreviewScheme(protocol, [PLUGIN_SANDBOX_PRIVILEGED_SCHEME]);
// localMediaPreviewPathRegistry 由 createLocalMediaPreviewPathRegistry 建。
const localMediaPreviewPathRegistry = createLocalMediaPreviewPathRegistry();

// e2e 由 Chromedriver 管理远程调试端口；如果这里继续固定到 9229，
// 会和开发态已打开的 ZCode Dev 抢端口，导致 WebDriver session 创建前白屏超时。
// 仅本地开发运行默认开启远程调试端口，并允许 e2e 通过环境变量交给 Chromedriver 接管。
// 固定调试端口只在非打包态开启；打包态由用户/诊断参数决定，避免生产环境暴露调试面。
// 关闭开关用单独环境变量而不是通用 DEBUG，防止误关其它调试能力。
if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1") {
  // appendSwitch 把 remote-debugging-port 固定到 9229。
  app.commandLine.appendSwitch("remote-debugging-port", "9229");
}

// 应用名与 home/userData 路径必须在任何服务创建前设定：settings/credential 的默认位置由此决定。
// 该调用同时影响 userData、sessionData、logs 与崩溃目录，改动会让旧用户“看起来丢配置”。
// 因此只在明确的产品/环境变量下改写，不能按平台随意猜测。
app.setName(runtimeApplicationName);
// runtimeHomePath 让便携版/测试环境把 home 重定向到隔离目录，避免污染真实用户目录。
if (runtimeHomePath) {
  // setPath home 重定向到 runtimeHomePath。
  app.setPath("home", runtimeHomePath);
}
// 只有显式要求时才覆盖 Electron 默认 userData/sessionData；两者缺一直接抛错，
// 因为半覆盖会让缓存与配置分属不同根目录，产生极难排查的“设置不生效”。
if (!shouldUseElectronDefaultUserDataPath) {
  // runtimeUserDataPath 与 runtimeSessionDataPath 缺一即抛错。
  if (!runtimeUserDataPath || !runtimeSessionDataPath) {
    // throw new Error 阻止半覆盖启动。
    throw new Error(
      "Desktop runtime data paths are required when Electron default userData is disabled",
    );
  }
  // 设 userData 到 runtimeUserDataPath。
  app.setPath("userData", runtimeUserDataPath);
  // sessionData 同步切换，避免缓存错根。
  app.setPath("sessionData", runtimeSessionDataPath);
}
// 进程标题用于任务管理器/系统监视器识别；必须在 ready 前设置，否则部分平台忽略。
// 它与窗口标题无关，后者由各窗口的 loadWindow 决定。
// 英文标题固定，避免在系统监视器里出现随语言变化的进程名。
process.title = runtimeApplicationName;

// 未捕获的 Promise 拒绝只记录不退出：Electron 主进程崩溃会带走所有 Host，
// 让用户在无提示的情况下丢失会话。记录后继续运行是更安全的默认。
// 真正的致命错误由 Host 侧与稳定性监控上报，不由这里做退出裁决。
// 也不要在这里弹框：拒绝可能来自高频遥测，弹框会瞬间淹没界面。
process.on("unhandledRejection", (reason) => {
  // logger.error 记录 reason，不退出进程。
  logger.error("unhandledRejection:", reason);
});

// 图标路径按“平台 × 是否打包”四象限展开：打包态读 resources，开发态读构建目录。
// 开发态路径基于 import.meta.dirname，因此 out/main 与源码目录的相对层级必须保持稳定。
// 任何一处路径变更都会让窗口/托盘/通知同时失去图标，属于容易被忽视的全局回归。
// Linux 额外维护 512px 图标用于桌面集成，未打包时回退到通用 iconPath。
const iconPath =
  process.platform === "win32"
    // win32 打包态读资源目录。
    ? app.isPackaged
      // 打包态 icon_windows.png 在 resources。
      ? join(process.resourcesPath, "icon_windows.png")
      // 开发态走 build/icon_windows.png。
      : join(import.meta.dirname, "../../build/icon_windows.png")
    // 非 win32 再按 isPackaged 分支。
    : app.isPackaged
      // 打包态用 resources 下的 icon.png。
      ? join(process.resourcesPath, "icon.png")
      // 开发态回退 build/icon.png。
      : join(import.meta.dirname, "../../build/icon.png");
// linuxDesktopIntegrationIconPath 单独用于桌面集成。
const linuxDesktopIntegrationIconPath =
  process.platform === "linux"
    // Linux 打包态读 512px 图标。
    ? app.isPackaged
      // resources 下的 icon_512x512.png。
      ? join(process.resourcesPath, "icon_512x512.png")
      // 未打包读 build/icons/512x512.png。
      : join(import.meta.dirname, "../../build/icons/512x512.png")
    // 非 Linux 直接复用 iconPath。
    : iconPath;
// currentApplicationLocale 与 closeToTrayOnWindows 都是“启动期可变、运行期被设置同步”的模块级状态。
// 用 let 而不是集中 store：它们被大量同步回调读取，异步化会引入竞态。
// 读取方（菜单、窗口、IPC）必须每次现取，不能缓存成常量。
let currentApplicationLocale: Locale = DEFAULT_LOCALE;
// closeToTrayOnWindows 默认 true，由设置同步覆盖。
let closeToTrayOnWindows = true;
// CR-01：托盘实例创建结果（模块级，关窗分支读取）。DBus 能力探测通过不等于 Electron
// Tray 创建成功；隐藏窗口前必须确认最终用户入口真实存在，否则隐藏即失联。
// 托盘实例创建结果必须独立于能力探测：DBus 有 watcher 不代表 new Tray 成功。
// 它是关窗分支唯一能读到的“最终用户入口是否存在”的事实，因此必须同步可读。
// 置真只能发生在 createDesktopTray 返回非 null 之后，不能由设置开关推断。
let desktopTrayReady = false;
// 关闭驻留托盘能力 monitor（spec：docs/desktop/linux-close-to-tray.md）。
// Linux 关窗分支是同步回调，只能读缓存；启动后首次探测完成前按"不可用"安全默认。
// 能力 monitor 缓存探测结果；关窗回调是同步的，只能读 getSync() 的缓存。
// closeToTrayCapabilityMonitor 首次探测完成前按“不可用”处理，这是安全默认：宁可弹确认也不隐藏到不存在的托盘。
const closeToTrayCapabilityMonitor = createCloseToTrayCapabilityMonitor({
  // monitor 按 process.platform 选择探测方式。
  platform: process.platform,
});
// keep-awake：全局开关 keepAwakeWhileRunning。打开后主进程持有
// powerSaveBlocker("prevent-app-suspension")，阻止系统闲置休眠（防不了合盖/手动睡眠）。
// 不再绑定闲时任务活跃计数——设置页「常规」与 Automations 入口镜像同一配置。
let keepAwakeWhileRunning = false;
// powerSaveBlockerId 初始 null 表示未持有。
let powerSaveBlockerId: number | null = null;
// keep-awake 收敛函数只有两种动作：设置开且尚无 blocker 时 start，设置关且已有 blocker 时 stop。
// 它被设置变更、启动 bootstrap、设置页同步多个入口重复调用，因此必须幂等：不重复 start/stop。
function reconcileKeepAwakeBlocker(): void {
  // reconcileKeepAwakeBlocker 纯设置驱动：只看 keepAwakeWhileRunning，避免“任务结束却仍阻止休眠”的陈旧状态。
  const shouldBlock = keepAwakeWhileRunning;
  // 只在缺失时创建：powerSaveBlocker.start 每次都会返回新 id，重复调用会泄漏。
  if (shouldBlock && powerSaveBlockerId === null) {
    // powerSaveBlocker.start 返回新 id 并存下。
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    // 记录 powerSaveBlocker 的 id 便于核对。
    logger.info(`[keep-awake] powerSaveBlocker started id=${powerSaveBlockerId}`);
  // 关闭路径必须容忍 id 失效：系统休眠/唤醒后 blocker 可能已被回收。
  // 因此 stop 包在 try 里，且无论成功与否都清空本地 id，保证下次能重新创建。
  } else if (!shouldBlock && powerSaveBlockerId !== null) {
    try {
      // powerSaveBlocker.stop 释放 blocker。
      powerSaveBlocker.stop(powerSaveBlockerId);
    } catch {
      // 忽略：id 可能已失效。
    }
    // 记录已 stop 的 id。
    logger.info(`[keep-awake] powerSaveBlocker stopped id=${powerSaveBlockerId}`);
    // 无论 stop 是否成功都清空 id。
    powerSaveBlockerId = null;
  }
}

// 内嵌浏览器 JS 对话框控制器：把 guest 的 alert/confirm 请求路由到主窗口 UI。
// 它按 owner 窗口找回主窗口 webContents；找不到时返回默认值，保证页面脚本不挂起。
// EmbeddedBrowserJavaScriptDialogController 的提示文案语言在 handleDialogRequest 调用时读取，不在构造时快照。
// 它需要实时语言（按钮文案）与图标，因此用 getter 而不是快照。
const embeddedBrowserDialogController = new EmbeddedBrowserJavaScriptDialogController({
  // iconPath 供对话框显示应用图标。
  iconPath,
  // getLocale 实时取 currentApplicationLocale。
  getLocale: () => currentApplicationLocale,
  logger,
});
// 同步 IPC（sendSync 语义）：renderer 需要立即拿到用户选择，异步会让页面脚本挂起。
// 因此回调内部不能做任何 await；需要异步的只有图标解码，且失败直接回退默认结果。
// senderFrame 可能为空（跨进程销毁边缘），展示来源用空串兜底。
// senderFrame?.url 用于展示来源，缺失时给空串而不是抛错。
ipcMain.on(PlatformChannels.EmbeddedBrowserJavaScriptDialog, (event, payload: unknown) => {
  // 同步写 event.returnValue 返回用户选择。
  event.returnValue = embeddedBrowserDialogController.handleDialogRequest(
    event.sender.id,
    event.senderFrame?.url ?? "",
    payload,
  );
});
// browser-use CDP-on-guest pivot：main 进程按 key 管理 `<webview>` guest 的
// webContents + CDP，为 executor 提供 ControlledView。所有 execute/attach 出口都走这里。
// BrowserGuestManager 虽是 main singleton，但 tab owner 带 window/workspace/session/generation；
// create/close 只投递到 owner window，禁止旧的全窗口广播造成跨窗口 attach。
// 截图表面协调器负责“renderer 准备好截图表面”与“main 发起 capture”的配对；
// 两个 fromId 解析器让它与 Electron 解耦，便于测试注入；生产分别返回窗口与 guest 的 id。
// 配对失败（超时/窗口关闭）由协调器裁决，main 不做重试。
const browserScreenshotSurfaceCoordinator = createDesktopBrowserScreenshotSurfaceCoordinator({
  // fromId 用 BrowserWindow.fromId 解窗口。
  fromId: (windowId) => BrowserWindow.fromId(windowId),
  // fromWebContentsId 用 webContents.fromId，缺省 null。
  fromWebContentsId: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  // log 走 logger.debug，不刷屏。
  log: (message) => logger.debug(message),
  // warn 走 logger.warn。
  warn: (message) => logger.warn(message),
});
// [资源] BrowserGuestManager 是所有 guest webContents 的唯一所有者：
// 它同时维护 guest ↔ tab ↔ owner window 的映射，main 侧不再保存第二份。
// 任何需要在 guest 上执行的动作都必须经它，否则会绕过 attach 状态与生命周期检查。
// 关闭窗口时先 closeWindow 再清其它映射，保证 guest 先于窗口引用释放。
// 创建/关闭/可见性/视口变化只投递给 owner 窗口，不做全窗口广播：否则多窗口下会跨窗口 attach 或重复关闭。
const browserGuestManager = new BrowserGuestManager(
  (msg) => logger.debug(msg),
  undefined,
  // 关闭标签回调：owner 窗口可能已销毁，必须先判 isDestroyed 再 send。
  (tabId, owner) => {
    // owner 为空时 win 置 null。
    const win = owner ? BrowserWindow.fromId(owner.windowId) : null;
    // win 存在且未销毁才 send。
    if (win && !win.isDestroyed()) {
      // send BrowserViewCloseTab 通知关闭标签。
      win.webContents.send(
        PlatformChannels.BrowserViewCloseTab,
        buildBrowserViewCloseTabNotification(tabId, owner),
      );
    }
  },
  // ready 回调携带完整 owner 身份（workspace/session/browser generation），
  // renderer 用它判断这条通知是否属于自己。
  (tabId, owner) => {
    // ready 回调按 owner.windowId 解窗口。
    const win = BrowserWindow.fromId(owner.windowId);
    // 同样先判 isDestroyed。
    if (win && !win.isDestroyed()) {
      // 发 PlatformChannels.BrowserViewReady。
      win.webContents.send(PlatformChannels.BrowserViewReady, {
        // workspaceKey 取自 owner。
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        // sessionId 同上。
        sessionId: owner.sessionId,
        tabId,
        // browserId 原样带上。
        browserId: owner.browserId,
        // browserGeneration 让 renderer 判断是否为同一代。
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  // 可见性回调用可选展开传 remoteSessionId/tabId：缺省字段不出现，避免 undefined 覆盖。
  (visible, owner, tabId) => {
    // 可见性回调同样解 owner 窗口。
    const win = BrowserWindow.fromId(owner.windowId);
    // 判 isDestroyed 后再发。
    if (win && !win.isDestroyed()) {
      // 发 PlatformChannels.BrowserViewVisibility。
      win.webContents.send(PlatformChannels.BrowserViewVisibility, {
        // visible 是本次可见性。
        visible,
        // workspaceKey 用于 renderer 归属判断。
        workspaceKey: owner.workspaceKey,
        // remoteSessionId 直接给，可 undefined。
        remoteSessionId: owner.remoteSessionId,
        // sessionId 透传。
        sessionId: owner.sessionId,
        ...(tabId ? { tabId } : {}),
        // browserId 透传。
        browserId: owner.browserId,
        // browserGeneration 防迟到事件错配。
        browserGeneration: owner.browserGeneration,
      });
    }
  },
  // 视口变化必须带 browserGeneration：旧 generation 的迟到视口不应影响新标签。
  (viewport, owner, tabId) => {
    // 视口回调解 owner 窗口。
    const win = BrowserWindow.fromId(owner.windowId);
    // 判 isDestroyed 后发送。
    if (win && !win.isDestroyed()) {
      // 发 PlatformChannels.BrowserViewViewportChanged。
      win.webContents.send(PlatformChannels.BrowserViewViewportChanged, {
        // workspaceKey 供 renderer 定位。
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        // sessionId 透传。
        sessionId: owner.sessionId,
        tabId,
        // browserId 透传。
        browserId: owner.browserId,
        // browserGeneration 必带，挡住旧代视口。
        browserGeneration: owner.browserGeneration,
        viewport,
      });
    }
  },
  // 截图缩放回调：解码 → 校验 → resize → 再编码；任一步得到空图都返回 undefined，
  // nativeImage 对损坏/超大输入可能返回空对象而不是抛错，因此必须显式判 isEmpty。
  // 编码结果以 base64 回给 renderer，避免在主进程与 IPC 之间传 Buffer 的序列化开销。
  // 由协调器按失败处理，而不是把空 PNG 传回 renderer。
  (base64Png, target) => {
    // source 由 nativeImage.createFromBuffer 解码 base64。
    const source = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
    // source.isEmpty 为真返回 undefined。
    if (source.isEmpty()) return undefined;
    // resized 走 source.resize 缩放到目标尺寸。
    const resized = source.resize({
      // width 取 target.width。
      width: target.width,
      // height 取 target.height。
      height: target.height,
      // quality 用 best，截图清晰度优先。
      quality: "best",
    });
    // resized.isEmpty 同样返回 undefined。
    if (resized.isEmpty()) return undefined;
    // toPNG 后转 base64 回给 renderer。
    return resized.toPNG().toString("base64");
  },
  browserScreenshotSurfaceCoordinator,
  // residency 选项不注入 recoveryStore：Browser shell 不跨进程恢复，
  // “完整退出即清空”是产品语义，恢复会与新 webview 重复 attach。
  // 因此这里只提供内存级的 residency 策略与日志器。
  {
    // Browser shell/pageState 不跨进程恢复，以保持“完整退出即清空”的语义，
    // 并避免恢复的 shell 与新 webview 重复 attach。因此不注入 recoveryStore；
    // 进程内 residency 事件仍保留给现有 IPC 兼容层。
    // 挂起/恢复/驻留三类事件按 tabId 反查 owner；找不到 owner 时静默丢弃，因为标签可能刚被别的路径关闭。
    onSuspendTabRequested: (payload) => {
      // tabOwner 由 getTabOwner 反查。
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      // 找不到 owner 时 win 为 null。
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      // 判 isDestroyed 后再发。
      if (win && !win.isDestroyed()) {
        // 发 PlatformChannels.BrowserViewSuspend。
        win.webContents.send(PlatformChannels.BrowserViewSuspend, payload);
      }
    },
    // onRestoreTabRequested 处理恢复请求。
    onRestoreTabRequested: (payload) => {
      // 同样用 getTabOwner 找属主。
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      // owner 缺失则 win 为 null。
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      // 判 isDestroyed。
      if (win && !win.isDestroyed()) {
        // 发 PlatformChannels.BrowserViewRestore。
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    // onResidencyChanged 复用 restore 通道。
    onResidencyChanged: (payload) => {
      // 按 payload.tabId 反查 owner。
      const tabOwner = browserGuestManager.getTabOwner(payload.tabId);
      // owner 缺失时置 null。
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      // 判 isDestroyed。
      if (win && !win.isDestroyed()) {
        // 仍发 PlatformChannels.BrowserViewRestore。
        win.webContents.send(PlatformChannels.BrowserViewRestore, payload);
      }
    },
    // 孤儿关闭按 tabId 与 reason 处理。
    onRecoveryOrphanCloseRequested: ({ tabId, reason }) => {
      // getTabOwner 取属主窗口。
      const tabOwner = browserGuestManager.getTabOwner(tabId);
      // 无属主则 win 为 null。
      const win = tabOwner ? BrowserWindow.fromId(tabOwner.windowId) : null;
      // 判 isDestroyed。
      if (win && !win.isDestroyed()) {
        // 发 PlatformChannels.BrowserViewCloseTab。
        win.webContents.send(PlatformChannels.BrowserViewCloseTab, {
          // tabId 指明要关的标签。
          tabId,
          reason,
        });
      }
    },
    // residency 的 warn 也走 logger.warn。
    warn: (message) => logger.warn(message),
    // 录屏能力注入：把 Electron 的 webm 录制器适配成 manager 需要的接口，
    // 日志走 debug，避免长时间录制刷屏；录制文件路径由 manager 决定。
    // 适配层不处理权限：录制授权在 renderer 侧由用户手势触发。
    // 日志走 debug，避免长时间录制刷屏。
    recording: {
      // createRecorder 适配 manager 需要的录制接口。
      createRecorder: (input) =>
        // createElectronBrowserWebmRecorder 接 debug 日志回调。
        createElectronBrowserWebmRecorder(input, (message) => logger.debug(message)),
    },
  },
  // 截图透明呈现的窗口解析器：只按 windowId 查，不缓存，避免窗口重建后指向旧对象。
  // 隐藏窗口截图的透明 presentation：capture 期间 showInactive + opacity 0 主动要帧。
  (windowId) => BrowserWindow.fromId(windowId),
);
// 把 guest webContents 集合暴露给资源管理器：用于退出时统计与强杀前的识别。
// 用 provider 函数而不是快照，保证读到的是实时集合。
setBrowserUseGuestWebContentsIdsProvider(() => browserGuestManager.listGuestWebContentsIds());

// browser-use：带诊断日志地执行 browser 命令（两处 spawnHostProcess wiring 共用）。
// 打入口/出口便于定位卡点（如 navigate loadURL 挂起、CDP 报错等）。
// CDP-on-guest pivot：execute 走 browserGuestManager（不再传 win —— guest 已由 attachGuest 关联）。
// browser 命令执行包装：入口/出口各一条 debug 日志，用于定位 loadURL 挂起这类卡点。
// 日志字段刻意包含 method 与 sessionId：排查时能直接对齐到具体标签与会话。
// runBrowserCommandOnView 不记录 command 正文：其中可能包含用户输入或凭据，属于敏感数据。
// execute 走 guest manager；win 只用于发操作指示与日志，不再参与 attach。
async function runBrowserCommandOnView(params: {
  // win 只用于窗口 id 与操作指示。
  win: BrowserWindow;
  // requestId 贯穿整个命令生命周期。
  requestId: string;
  // browserId 缺省回落 legacy-iab。
  browserId?: string;
  // browserGeneration 用于识别重建后的新实例。
  browserGeneration?: number;
  // sessionId 用于日志对齐与会话归属。
  sessionId: string;
  // turnId 只在有轮次时透传。
  turnId?: string;
  // workspaceKey 可由调用方直接给。
  workspaceKey?: string;
  // workspacePath 作为 workspaceKey 的次选来源。
  workspacePath?: string;
  // workspaceIdentity 优先级最高。
  workspaceIdentity?: string;
  // remoteSessionId 有值才写进消息。
  remoteSessionId?: string;
  // clientMode 区分桌面连续与远端可重放。
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  // sessionContext 标明 live 还是 cached。
  sessionContext?: "live" | "cached";
  // command 是 unknown，执行前必须收窄。
  command: unknown;
}): Promise<{ ok: boolean; [k: string]: unknown }> {
  // 自动化期间抑制 JS 对话框：否则页面 alert 会阻塞 CDP 命令直到超时。
  const endDialogAutomation = embeddedBrowserDialogController.beginAutomation(params.win.id);
  // command 形状不可信：renderer 可能传任意 IPC 负载，这里只取需要的两个字段。
  const command = params.command as { method?: string; tabId?: unknown } | null;
  // method 缺省为问号，保证日志字段不缺。
  const method = command?.method ?? "?";
  // workspaceKey 的优先级：identity > key > path > sessionId，
  // 保证远端同名路径仍能区分到具体会话。
  const workspaceKey =
    params.workspaceIdentity?.trim() ||
    params.workspaceKey ||
    params.workspacePath ||
    params.sessionId;
  // 操作指示的 tabId 可能来自入参，也可能要等执行结果才知道（newTab）。
  const requestedTabId = resolveBrowserOperationTabId(command);
  // resetsResizeBaseline 由 browserOperationResetsResizeBaseline 判定。
  const resetsResizeBaseline = browserOperationResetsResizeBaseline(command);
  // sendOperation 每次都重新判 isDestroyed：命令执行期间窗口可能被关闭。
  const sendOperation = (tabId: string) => {
    // isDestroyed 就 return，禁止向死窗口 send。
    if (params.win.isDestroyed()) return;
    // 发 PlatformChannels.BrowserViewOperation 亮起操作指示。
    params.win.webContents.send(PlatformChannels.BrowserViewOperation, {
      // workspaceKey 让 renderer 定位到对应工作区。
      workspaceKey,
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      // sessionId 透传，便于指示与日志对齐。
      sessionId: params.sessionId,
      tabId,
      // browserId 缺省 legacy-iab。
      browserId: params.browserId ?? "legacy-iab",
      // browserGeneration 缺省 0。
      browserGeneration: params.browserGeneration ?? 0,
      resetsResizeBaseline,
    });
  };
  // 交互说明：绝大多数 Tab API 都显式携带 tabId，可在命令真正执行前亮起操作图标；
  // newTab / default-tab 兼容调用要等 manager 返回真实 meta.tabId 后再补发，避免猜 tab identity。
  // 已知 tabId 时先亮操作图标再执行，让长命令有即时反馈。
  if (requestedTabId) sendOperation(requestedTabId);
  // 入口打 debug 日志，含 browserId 与 method。
  logger.debug(
    `[browser-use] execute start browserId=${params.browserId ?? "legacy-iab"} sessionId=${params.sessionId} method=${method}`,
  );
  try {
    // 执行结果可能是 ok=false，也算“完成”：只有抛错才走 catch。
    const result = await browserGuestManager.execute(
      {
        // requestId 原样传给 execute。
        requestId: params.requestId,
        // 同样补 legacy-iab 默认值。
        browserId: params.browserId ?? "legacy-iab",
        // browserGeneration 同样补 0。
        browserGeneration: params.browserGeneration ?? 0,
        // windowId 取自 params.win.id。
        windowId: params.win.id,
        workspaceKey,
        // sessionId 透传给 browserGuestManager。
        sessionId: params.sessionId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
        // clientMode 缺省 desktop-continuous。
        clientMode: params.clientMode ?? "desktop-continuous",
      },
      params.command as Parameters<typeof browserGuestManager.execute>[1],
    );
    // 出口 debug 日志带 ok 与 elapsedMs。
    logger.debug(
      `[browser-use] execute done sessionId=${params.sessionId} method=${method} ok=${result.ok} elapsedMs=${(result as { elapsedMs?: number }).elapsedMs ?? "?"}`,
    );
    // 执行后才拿到 tabId（newTab/default-tab）：补发一次操作指示，避免猜 identity。
    if (!requestedTabId) {
      // 用 resolveBrowserOperationTabId 从结果里取 tabId。
      const resolvedTabId = resolveBrowserOperationTabId(command, result);
      // 拿到 resolvedTabId 才补发操作指示。
      if (resolvedTabId) sendOperation(resolvedTabId);
    }
    // 原样 return result 给 IPC 回包。
    return result;
  } catch (error) {
    // [失败路径] 抛错先记录带 method 的上下文再原样抛出：调用方需要错误本身做 IPC 回包。
    logger.error(
      `[browser-use] execute threw sessionId=${params.sessionId} method=${method}:`,
      error,
    );
    // throw error 保留原始错误给调用方。
    throw error;
  // finally 释放对话框抑制：无论成功/失败都必须恢复，否则后续页面弹窗会被吞。
  } finally {
    // finally 里 endDialogAutomation 必执行。
    endDialogAutomation();
  }
}
// 缩放与窗口尺寸是“内存态 + 设置持久化”的组合：currentDesktopZoomLevel 这份内存值就是真值。
// 读取方（菜单、新建窗口）直接读它，不必每次渲染都 await 设置服务。
// 持久化失败不回滚内存值：界面已按新值渲染，回滚会造成视觉跳变。
// 持久化在 createWindow 的 persistWindowSize 回调里完成。
let currentDesktopZoomLevel = 0;
// currentDesktopWindowSize 未建窗前为 undefined。
let currentDesktopWindowSize: DesktopWindowSize | undefined;
// preload 路径与设置文件路径在模块加载时固定；运行期不再变化，便于各处直接引用。
const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
// settingsFile 固定在 ~/.zcode/v2/setting.json。
const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
// 退出策略与退出类型分开存：策略决定超时预算，类型用于日志与稳定性上报。
let activeAppShutdownPolicy = resolveAppShutdownPolicy("normal", process.platform);
// activeAppShutdownKind 初值 null，退出时才定。
let activeAppShutdownKind: AppShutdownKind | null = null;
// Windows 强杀 agent 的超时独立于退出策略：它只覆盖单次 taskkill，不参与总预算。
const WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS = 2_000;

// 广播与任务实时总线是 main 侧的扇出设施，必须在 Host 创建前可用，因此在这里同步实例化。
const broadcastHub = new BroadcastHub();
// taskRealtimeBus 注入同一个 logger。
const taskRealtimeBus = new TaskRealtimeBus({ logger });
// 内存诊断计数器：desktopResourceTelemetry 每 60s collect
// 一次写主日志。will-download 监听数用于观察关窗后 defaultSession 是否残留监听。
mainMemoryDiagnosticsRegistry.register("taskBus", () => taskRealtimeBus.collectMemoryDiagnostics());
// 注册 broadcast 的 collectMemoryDiagnostics。
mainMemoryDiagnosticsRegistry.register("broadcast", () => broadcastHub.collectMemoryDiagnostics());
// 内存诊断注册用惰性回调：只有采样时才遍历窗口/Host，避免常驻开销。
// 回调依赖的 getter 都是实时的，因此注册一次即可覆盖整个生命周期。
// 诊断失败在回调内部吞掉，不影响稳定性上报主链路。
mainMemoryDiagnosticsRegistry.register("guest", () =>
  // guest 诊断走 browserGuestManager.collectMemoryDiagnostics。
  browserGuestManager.collectMemoryDiagnostics(),
);
// app 组诊断统计窗口数与 will-download 监听。
mainMemoryDiagnosticsRegistry.register("app", () => ({
  // windows 只数未销毁的 BrowserWindow。
  windows: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
  // willDownloadListeners 反映 defaultSession 是否残留监听。
  willDownloadListeners: session.defaultSession.listenerCount("will-download"),
}));
// 本机环境文件只在启动时读一次：后续 shell 环境变化由每个窗口的准备流程重新采集。
const hostProcessLocalEnv = loadHostProcessEnvFromLocalFiles();
// RuntimeProcessEnvPreparation 同步 fallback 加异步 patch。
interface RuntimeProcessEnvPreparation {
  // patchPromise 永不 reject，失败即 resolve fallback。
  patchPromise: Promise<Record<string, string>>;
  // fallbackPatch 立即可用，不含登录 shell。
  fallbackPatch: Record<string, string>;
}

// runtimeProcessEnvPrewarmSequence 只用于日志关联：并发准备多个窗口时，能从日志区分是哪一次预暖。
// 它不是请求 id，不参与任何状态判定；失败与成功日志都带同一个序号。
// runtimeProcessEnvPrewarmSequence 只增不减，因此日志按 prewarmId 升序即按时间排序。
let runtimeProcessEnvPrewarmSequence = 0;
// [并发] 环境准备分两段：同步算出 fallback，异步采集登录 shell 后产出最终 patch。
// 这样首窗创建不必等待 shell（可能耗时数百毫秒甚至超时），又能在成功时拿到完整 PATH。
// 两段结果通过同一个结构返回，调用方无需区分“已就绪”与“仍在采集”。
// patchPromise 永不 reject：失败时 resolve 为 fallback，Host 启动路径无需 try/catch。
// 调用方拿到的是 promise + 立即可用的 fallback，因此首窗不必等待 shell。
function createRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  // prewarmId 自增，仅用于日志关联。
  const prewarmId = ++runtimeProcessEnvPrewarmSequence;
  // startedAt 记录起点算耗时。
  const startedAt = Date.now();
  // Windows process.env 保留 Path 的原始大小写，展开到普通对象后不再大小写不敏感。
  // dotenv 先合并、真实进程环境后合并，再统一成唯一 PATH，保持旧 Host 继承的优先级语义。
  // 合并顺序：本地环境文件在前、真实进程环境在后；后者覆盖前者，
  // 与旧 Host 继承语义一致。normalize 负责 PATH 键的大小写归一。
  const baseEnv = normalizeRuntimeProcessEnv(
    {
      ...hostProcessLocalEnv,
      ...process.env,
    },
    process.platform,
  );
  // fallback 不含登录 shell：即使采集失败或超时，Host 也能用一份合法环境启动。
  const fallbackPatch = buildRuntimeProcessEnvPatch(baseEnv, null, {
    // platform 传给 buildRuntimeProcessEnvPatch。
    platform: process.platform,
  });
  // 采集成功时再合并一次；失败分支返回 fallback，promise 永不 reject。
  const patchPromise = captureLoginShellEnvSnapshot({
    // patchPromise 由 captureLoginShellEnvSnapshot 产出。
    baseEnv,
    // baseEnv 是已归一化 PATH 的环境。
    platform: process.platform,
  }).then(
    // 非 Windows 且无 snapshot 时降级并告警：Linux 上缺失登录 shell 常意味着用户配置异常。
    (snapshot) => {
      // 有 snapshot 时用它构建 patch。
      const patch = buildRuntimeProcessEnvPatch(baseEnv, snapshot, {
        // 同样带 platform 参数。
        platform: process.platform,
      });
      // 该日志带耗时，用于判断“首窗变慢”是否由 shell 采集引起。
      if (process.platform !== "win32" && !snapshot) {
        // 非 win32 无 snapshot 时 logger.warn 降级。
        logger.warn(
          `[startup] login shell env unavailable id=${prewarmId}; using shell-free fallback after ${Date.now() - startedAt}ms`,
        );
        // 返回 shell-free 的 patch。
        return patch;
      }
      // 成功路径 logger.info 记耗时。
      logger.info(
        `[startup] runtime process env prepared asynchronously id=${prewarmId} in ${Date.now() - startedAt}ms`,
      );
      // 返回采集后的 patch。
      return patch;
    },
    // [失败路径] 采集抛错只降级不阻断启动：Host 用 fallback 仍可运行，只是 PATH 可能偏窄。
    (error) => {
      // 采集抛错时 logger.warn 并降级。
      logger.warn(
        `[startup] runtime process env prewarm failed id=${prewarmId}; using shell-free fallback`,
        error,
      );
      // 失败返回 fallbackPatch，保证 promise 不 reject。
      return fallbackPatch;
    },
  );
  // 同时返回 patchPromise 与 fallbackPatch。
  return { patchPromise, fallbackPatch };
}

// 首窗在 Main import 时就开始采集；后续窗口各自刷新，避免永久复用进程启动时的 shell snapshot。
let initialRuntimeProcessEnvPreparation: RuntimeProcessEnvPreparation | null =
  createRuntimeProcessEnvPreparation();
// 预暖结果按 take 语义交付：取走即置空，保证只被消费一次；后续窗口各自新建。
// 若多个窗口共享同一 promise，第二个会拿到与它启动时刻不匹配的 shell 快照（用户可能已改 PATH）。
function takeRuntimeProcessEnvPreparation(): RuntimeProcessEnvPreparation {
  // 先存到 initialPreparation 便于判空。
  const initialPreparation = initialRuntimeProcessEnvPreparation;
  // initialPreparation 非空就交付。
  if (initialPreparation) {
    // 取走即置 null，保证只消费一次。
    initialRuntimeProcessEnvPreparation = null;
    // return initialPreparation 给首个窗口。
    return initialPreparation;
  }
  // 后续窗口各自 createRuntimeProcessEnvPreparation。
  return createRuntimeProcessEnvPreparation();
}
// 三个退出相关标志位：forceQuit 表示“不再询问直接退”，explicitQuit 表示“来自菜单/托盘”，
// hasPreparedAppQuit 表示异步屏障已完成。前两者影响 close 行为，第三者影响 before-quit。
// 把 explicitQuit 与 forceQuit 合并，会让“托盘退出被取消”后仍按强制退出处理。
// hasPreparedAppQuit 表示屏障已完成。三者语义不同，不能合并。
const forceQuitRef = { current: false };
// explicitQuitRef 标记菜单/托盘显式退出。
const explicitQuitRef = { current: false };
// 并发的 prepareAppQuit 共享同一个 promise：屏障只允许跑一次。
let appQuitPreparationInFlight: Promise<void> | null = null;
// hasPreparedAppQuit 表示退出屏障已完成。
let hasPreparedAppQuit = false;
// 窗口 → workspace 集合：用于任务实时总线的订阅范围与窗口关闭清理。
// 集合内容由 renderer 同步，main 只做去重与转发，不推断当前激活项。
// 关窗时必须 delete，否则总线下游会继续向已销毁窗口推送。
const windowWorkspaceMap = new Map<number, Set<string>>();
// 窗口 → Host 实时会话 id：Host 重启后由 onHostId 回调更新，关窗时删除。
const windowTaskRealtimeHostIdMap = new Map<number, string>();
// 未读数按窗口存：托盘红点取总和，窗口关闭时同步扣减。
// windowUnreadCountMap 用整数累加而不是集合，是因为托盘红点只关心数量；窗口维度用于关窗时精确回退。
// 若只存全局总数，窗口异常关闭会导致红点永久减不掉。
const windowUnreadCountMap = new Map<number, number>();
// 窗口唯一的 Host 进程：这是 INV-03 的落点，所有生命周期操作都围绕它。
const windowHostProcessMap = new Map<number, ElectronUtilityProcess>();
// CUA PiP 焦点路由：把“哪个窗口在前台”翻译成 Host 消息；send 目标可能已不存在。
const cuaPipFocusRouter = createCuaPipFocusRouter({
  // send 按 windowId 找 Host 再投递。
  send: (windowId, event) => {
    // 从 windowHostProcessMap 取进程，可能已回收。
    windowHostProcessMap.get(windowId)?.postMessage({
      // 消息类型用 HostMessageTypes.CuaPipFocusChanged。
      type: HostMessageTypes.CuaPipFocusChanged,
      event,
    });
  },
});
// Host → 运行中任务数：只用于退出确认文案与“是否忙碌”遥测，不参与是否允许退出。
// 该值由 Host 主动上报、main 只做累加缓存并在退出时删除，允许短暂为 0。
const hostRunningTaskCountMap = new Map<ElectronUtilityProcess, number>();
// Windows CUA 操作指示器独立成窗：它不算“应用窗口”，所有窗口枚举都要排除它。
const windowsCuaOperationIndicator = createWindowsCuaOperationIndicator({
  // platform 决定指示窗的创建方式。
  platform: process.platform,
  // getLocale 用 getter 跟随语言切换。
  getLocale: () => currentApplicationLocale,
  logger,
});

// 常驻 cron scheduler 进程句柄；app ready 后拉起，退出前销毁。
// 所有转发函数都用可选链：scheduler 未启动时静默丢弃结果，属于正常的启动竞态。
// 销毁时先摘引用再 await dispose，防止销毁过程中新的派发请求写入半死句柄。
let cronScheduler: CronSchedulerHandle | null = null;
// host → main 的定时任务派发结果，转交给 scheduler 结算。经模块变量转发以避免 spawn 顺序耦合。
function forwardCronRunResult(
  // result 类型取自 handleCronRunResult 的首参。
  result: Parameters<CronSchedulerHandle["handleCronRunResult"]>[0],
): void {
  // 可选链调用 handleCronRunResult，未启动则丢弃。
  cronScheduler?.handleCronRunResult(result);
}
// forwardOffPeakRunResult 转发错峰任务结果。
function forwardOffPeakRunResult(
  // 类型取自 handleOffPeakRunResult 首参。
  result: Parameters<CronSchedulerHandle["handleOffPeakRunResult"]>[0],
): void {
  // 同样可选链转发 handleOffPeakRunResult。
  cronScheduler?.handleOffPeakRunResult(result);
}
// wake 只唤醒调度循环，不直接执行任务；具体派发由 scheduler 通过 resolveDispatchHost 完成。
function wakeCronScheduler(automationId: string): void {
  // wake 只唤醒 automationId 对应的调度循环。
  cronScheduler?.wake(automationId);
}
// wakeOffPeakScheduler 复用同一 wake 通道。
function wakeOffPeakScheduler(offPeakTaskId?: string): void {
  // 复用同一条 scheduler-wake 通道（tick 同时覆盖 cron 与 off-peak 分支），仅日志标签区分。
  cronScheduler?.wake(`offpeak:${offPeakTaskId ?? "sync"}`);
}
// 选一个本地 host 执行派发：本期本地 workspace 由任一本地窗口 host 的 createTask 按 path 拉起/复用 agent。
// 因此选哪个窗口都不影响 createTask 的正确性，只影响资源归属。
function resolveCronDispatchHost(): ElectronUtilityProcess | null {
  // first 取 windowHostProcessMap 的第一个迭代值。
  const first = windowHostProcessMap.values().next();
  // first.done 为真则返回 null。
  return first.done ? null : first.value;
}
// 记录仍在销毁中的 Host 的兜底定时器；用 WeakMap 避免影响进程对象回收。
// 同一个 Host 可能被窗口关闭与退出屏障两条路径同时要求销毁，定时器必须可复用。
// 它是 disposeHostProcessAndWait 的内部记账表，不属于业务状态。
const disposingHostProcessTimers = new WeakMap<
  // WeakMap 键是 ElectronUtilityProcess。
  ElectronUtilityProcess,
  ReturnType<typeof setTimeout>
// WeakMap 值是该 Host 的兜底定时器。
>();
// webRemoteControlManager 需要在 IPC 注册前被回调引用，故用 ref 打破初始化顺序依赖。
const webRemoteControlManagerRef = {
  // current 初值 null，类型取自 createWebRemoteControlManager。
  current: null as ReturnType<typeof createWebRemoteControlManager> | null,
};
// updateStatusWindow 是单例；高度按 download-progress / update-downloaded / 普通三档收敛，宽度固定，macOS 红绿灯位置由 UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION 单独常量化。
let updateStatusWindow: BrowserWindow | null = null;
// UPDATE_STATUS_WINDOW_WIDTH 固定 512。
const UPDATE_STATUS_WINDOW_WIDTH = 512;
// UPDATE_STATUS_WINDOW_COMPACT_HEIGHT 是普通态高度。
const UPDATE_STATUS_WINDOW_COMPACT_HEIGHT = 205;
// UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT 容纳进度条。
const UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT = 224;
// 54 是“已下载态去掉进度条”后的固定收窄量，与 renderer 的进度条布局耦合；
// 它由 PROGRESS 派生而不是写死绝对值，改 PROGRESS_HEIGHT 时差值仍要一起核对。
const UPDATE_STATUS_WINDOW_READY_HEIGHT = UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT - 54;
// UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION 锁死红绿灯坐标。
const UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION = { x: 10, y: 10 } as const;
// 设置/凭据服务在模块级创建：它们的路径依赖已设定好的 userData，不能延迟到 ready。
// 两个服务实例各自持有独立的文件句柄与缓存，不能互相替代。
// 它们被多处闭包捕获，因此必须在任何回调注册前存在。
const mainSettingService = createSettingService();
// webRemoteControlCredentialService 单独实例，与设置服务隔离。
const webRemoteControlCredentialService = createCredentialService();
// 启动门与协调器分离：gate 负责“是否允许启动”，coordinator 负责“只创建一个主窗口”。
const appLaunchGate = createAppLaunchGate();
// appLaunchCoordinator 绑定 appLaunchGate 保证只建一个主窗。
const appLaunchCoordinator = createAppLaunchCoordinator(appLaunchGate);
// appTelemetryCredentialService 供遥测独立读凭据。
const appTelemetryCredentialService = createCredentialService();
// [协议] 端点解析的唯一入口：非 production 下设置项 > 环境变量链（process.env 覆盖 > 本地 env 快照）；production 忽略设置项，否则正式包可被外部注入改域。
// 所有需要 endpoint 的子系统都必须调用它，不能各自读设置，否则会出现半切换状态。
// 它是 async 的，因为设置读取是异步的；调用点应缓存结果而不是在渲染路径反复 await。
async function resolveCurrentZCodeEndpointOrigin() {
  // 交给 resolveZCodeEndpointOrigin 统一裁决。
  return resolveZCodeEndpointOrigin({
    // env 用 ZCODE_ENV 区分生产与其它环境。
    env: ZCODE_ENV,
    // envBaseOrigin 取自 hostProcessLocalEnv 快照。
    envBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    // overrideOrigin 来自设置的 zcodeEndpointOrigin。
    overrideOrigin: (await mainSettingService.get()).zcodeEndpointOrigin,
  });
}
// 灰度 rollout 在首个 Host 创建前完成初始化；未初始化时按关闭处理（fail-open 的反面）。
let desktopContextPromptRollout: ReturnType<typeof createDesktopContextPromptRollout> | undefined;
// Host 侧读取的是 live 快照；refresh 是旁路网络请求，不阻塞 Host 创建。
function resolveDesktopContextPromptEnabledForHost(): boolean {
  // rollout 先取当前引用，避免中途被置空。
  const rollout = desktopContextPromptRollout;
  // rollout 未初始化时按关闭处理。
  if (!rollout) {
    // return false 表示 context prompt 不启用。
    return false;
  }
  // Host 创建时顺便触发过期刷新，但只读取当前快照；网络请求不能阻塞 Local/Remote Host。
  void rollout.refresh();
  // 读 rollout.getSnapshot().enabled 返回。
  return rollout.getSnapshot().enabled;
}

// 首个 Host 创建前的有界灰度裁决门。Host/Agent 的 presentation surface 在进程启动时
// 冻结（services/node.ts 顶层 const + CLI --surface），而灰度请求是旁路、不阻塞 Host。若首个
// Host fork 早于请求 resolve，成功结果（enabled:true）对已冻结的 Host/Agent 无可达生效路径。
// 这里给"成功结果"一条有界的生效路径：首 Host fork 前 await 一次裁决（≤2s），失败/超时仍按当前
// 快照继续（desktopContextPrompt fail-open）。first-only 永久
// latch——后续 Host fork await 已 resolve 的 promise（近乎 0ms），且各 resolve*ForHost()
// 同步读取已被刷新的 live 快照。
const DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS = 2_000;
// first-only latch：只有第一次 fork 会等待，后续 Host 直接复用已 resolve 的 promise。
let firstHostSpawnDecisionPromise: Promise<void> | null = null;
// 裁决失败只记录并放行：灰度是增强能力，不能成为启动的单点故障。
function awaitFirstHostSpawnDecision(): Promise<void> {
  // 已有 firstHostSpawnDecisionPromise 就复用。
  if (firstHostSpawnDecisionPromise) {
    // 直接 return，不重复发请求。
    return firstHostSpawnDecisionPromise;
  }
  // 自执行闭包保证并发调用只创建一条请求链。
  firstHostSpawnDecisionPromise = (async () => {
    // 进闭包再取一次 rollout 引用。
    const rollout = desktopContextPromptRollout;
    // rollout 缺失时走空返回分支。
    if (!rollout) {
      // rollout 为 undefined 就 return。
      return;
    }
    // rollout 缺失时立即返回：没有灰度能力就没有可等待的决策。
    try {
      // awaitFirstDecision 带 2s 上限。
      const decision = await rollout.awaitFirstDecision(
        DESKTOP_FIRST_HOST_SPAWN_DECISION_TIMEOUT_MS,
      );
      // 日志带 enabled 与 configVersion，便于排查“首窗表现与灰度结果不一致”。
      logger.info("[desktop-context-prompt] first host spawn decision resolved", {
        // 记录 first host spawn decision resolved。
        enabled: decision.enabled,
        // 带上 decision.enabled 便于比对。
        configVersion: decision.configVersion,
      });
    } catch (error) {
      // awaitFirstDecision 永不 reject（refresh 内部已 catch + timeout 回退快照），此处仅兜底。
      logger.warn("[desktop-context-prompt] first host spawn decision failed, fail-open", {
        // 异常只作为 error 字段记录。
        error,
      });
    }
  })();
  // 返回同一个 firstHostSpawnDecisionPromise。
  return firstHostSpawnDecisionPromise;
}
// 遥测核心的依赖全部用 loader 注入：凭据读取失败时由 core 统一降级，不在这里判空。
// fetchImpl 走 Electron net，确保代理与证书策略与浏览器一致，而不是 Node 原生 fetch。
// 端点解析函数注入的是同一份 resolveCurrentZCodeEndpointOrigin，避免遥测发往旧环境。
const appTelemetryCore = createTelemetryCore({
  // loadUserId 由 createTelemetryUserIdLoader 构造。
  loadUserId: createTelemetryUserIdLoader(appTelemetryCredentialService),
  // loadAuthorization 同理注入凭据服务。
  loadAuthorization: createTelemetryAuthorizationLoader(appTelemetryCredentialService),
  // loadMarketingParams 取营销参数。
  loadMarketingParams: createTelemetryMarketingParamsLoader(appTelemetryCredentialService),
  // 注入 resolveCurrentZCodeEndpointOrigin 保证端点同源。
  resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  // fetchImpl 用 createDesktopTelemetryFetch 包一层。
  fetchImpl: createDesktopTelemetryFetch({
    // net.fetch 复用 Electron 代理与证书策略。
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  }),
});
// 运行时包装负责“应用是否在前台”的状态，core 只关心事件上报。
const appTelemetryRuntime = createAppTelemetryRuntime({
  // telemetryCore 指向已建好的 appTelemetryCore。
  telemetryCore: appTelemetryCore,
  appLaunchCoordinator,
});

// renderer 上下文缺失时记 warn 并丢弃：没有 context 的事件无法归属，
// 强行上报会污染统计。优先用精确 id，未命中再退回最近一次上下文。
function reportRemoteUsageEventForRenderer(rendererId: number, event: TelemetryEventPayload): void {
  // context 先按精确 rendererId 查。
  const context =
    appTelemetryRuntime.getRendererContext(rendererId) ??
    // 未命中再退 getLatestRendererContext。
    appTelemetryRuntime.getLatestRendererContext();
  // context 缺失时走告警分支。
  if (!context) {
    // logger.warn 带上 renderer context unavailable。
    logger.warn("[remote-usage-telemetry] renderer context unavailable", {
      // 附带 elementName 便于定位元素。
      elementName: event.elementName,
      rendererId,
    });
    // 直接 return，不污染统计。
    return;
  }
  // 最终失败由 TelemetryCore 统一记录一条脱敏告警；这里仅隔离远程连接主链路。
  // 上报失败由 core 统一脱敏记录；这里 catch 空实现只为隔离主链路。
  void appTelemetryCore.reportEvent({ context, ...event }).catch(() => {});
}

// 前台状态以“存在可见且聚焦的应用窗口”为准；CUA 指示窗必须排除，
// 否则它会永远把应用标成前台。
function syncAppTelemetryInteractiveState(): void {
  // setInteractive 由窗口可见且聚焦决定。
  appTelemetryRuntime.setInteractive(
    getApplicationWindowsExcludingCuaIndicator().some(
      (win) => !win.isDestroyed() && win.isVisible() && win.isFocused(),
    ),
  );
  // 登出/切号发生在 host 子进程，主进程无即时信号；窗口聚焦时兜底刷新 ARMS user.name
  // 窗口聚焦时顺带刷新 ARMS 用户名：登出/切号发生在 Host，main 没有即时信号。
  void armsUserIdentitySync.refresh();
}

// 聚焦/失焦同时驱动三件事：遥测前台态、菜单（启用态可能依赖焦点）、CUA 焦点路由。
// 三者都必须在同一事件里完成，否则会出现“窗口已在前台但 CUA 仍认为后台”的错位。
// rebuildMenu 只在 browser-window-focus 执行，失焦不重建，所以省掉一次全量构建。
app.on("browser-window-focus", (_event, win) => {
  // 聚焦先 syncAppTelemetryInteractiveState。
  syncAppTelemetryInteractiveState();
  // 聚焦才 rebuildMenu，失焦不重建。
  rebuildMenu();
  // 设置/更新等无 Host 的 ZCode 窗口也算前台：router 会先把旧 workspace Host 清成 null，
  // 再把无 Host 的新窗口事实静默丢弃，避免旧会话 PiP 继续显示。
  cuaPipFocusRouter.focusWindow(resolveCuaPipWindowKey(win));
});
// 失焦不重建菜单：菜单项启用态不依赖焦点，省一次全量重建。
app.on("browser-window-blur", (_event, win) => {
  // blur 同样调用 syncAppTelemetryInteractiveState。
  syncAppTelemetryInteractiveState();
  // cuaPipFocusRouter.blurWindow 同步 CUA 焦点。
  cuaPipFocusRouter.blurWindow(resolveCuaPipWindowKey(win));
});
// 新窗口创建即登记 CUA 窗口键，closed 时移除；用 once 避免重复清理。
app.on("browser-window-created", (_event, win) => {
  // windowKey 在创建时算一次并捕获。
  const windowKey = resolveCuaPipWindowKey(win);
  // 移除必须按创建时计算的 key，重新计算可能因窗口已销毁而得到不同结果。
  win.once("closed", () => cuaPipFocusRouter.removeWindow(windowKey));
});

// 远程会话管理器持有主进程侧的连接状态；它需要窗口 Host 表来完成 reattach 与回收。
// 它与 webRemoteControlManager 分工：前者管 SSH/WSL/容器会话，后者管移动端远控中继。
// 两者共享同一 workspace 时通过 sharedHostAttachments 做引用计数，避免 Host 被提前回收。
const remoteSessionManager = createRemoteWorkspaceSessionManager({
  // logger 与 windowHostProcessMap 一并注入。
  logger,
  windowHostProcessMap,
  // resolveRemoteAssetDirs 带上当前 locale。
  resolveRemoteAssetDirs: () =>
    // 注入 hostProcessLocalEnv 给资源解析。
    resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
  // resolveWslTarget 指向 resolveCanonicalWslTarget。
  resolveWslTarget: resolveCanonicalWslTarget,
  // 连接态变化上报 ARMS，指向上报函数。
  reportRemoteConnectionStateChanged: reportRemoteConnectionStateChangedToArms,
  // 断开同样走 reportRemoteDisconnectToArms。
  reportRemoteDisconnect: reportRemoteDisconnectToArms,
  webRemoteControlManagerRef,
});

// 复用既有只读账号入口；HTTP 由 main 的 Node fetch 执行，不触发 host OAuth 登出。
const loadRemoteControlUserId = createTelemetryUserIdLoader(webRemoteControlCredentialService);
// authorization loader 用 createTelemetryAuthorizationLoader。
const loadRemoteControlAuthorization = createTelemetryAuthorizationLoader(
  webRemoteControlCredentialService,
);
// Web 远控与本地窗口共享 Host 附件：同一 workspace 的 Host 可被多个消费者复用，
// 因此 attach/release 必须走引用计数式的共享管理器。
const webRemoteControlSharedHostAttachments = createWebRemoteControlSharedHostAttachments({
  // windowHostProcessMap 是共享 Host 的唯一来源。
  windowHostProcessMap,
  // attach 走 remoteSessionManager 的同名方法。
  attachRemoteWorkspaceSessionHost: remoteSessionManager.attachRemoteWorkspaceSessionHost,
  logger,
});
// deviceMid 是设备身份，同步生成：后续所有遥测/灰度/远控都用同一个值。
const deviceMid = ensureDesktopDeviceMidSync();
// 帮助配置是公开读取，不能复用下面附带账号鉴权的灰度响应缓存。
// 帮助配置是公开只读接口，不复用带鉴权的客户端配置 fetcher；
// 语言与端点都用 getter，保证切换后立即生效，而不是打开页面时的快照。
// 失败直接上抛给 IPC 调用方，由 renderer 显示可重试的错误态。
const readHelpConfig = createDesktopHelpConfigReader({
  // appVersion 优先 ZCODE_VERSION，回退 app.getVersion。
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  // getClientLanguage 用 getter，切语言立即生效。
  getClientLanguage: () => currentApplicationLocale,
  // 端点由 resolveCurrentZCodeEndpointOrigin 动态解析。
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
// 同一个 /api/v1/client/configs fetcher 供两个灰度 rollout 共用（请求参数与鉴权完全一致，
// 各自独立缓存/去重，服务端按 data.configs.<key> 区分功能）。
// 同一个 configs fetcher 供多个 rollout 共用：请求参数一致，服务端按 key 区分功能；
// 各 rollout 仍独立缓存与去重。
const electronClientConfigsFetcher = createElectronDesktopContextPromptConfigFetcher({
  // fetcher 同样取 ZCODE_VERSION 或 app.getVersion。
  appVersion: ZCODE_VERSION || app.getVersion(),
  deviceMid,
  // 语言同样用 getter，避免快照过期。
  getClientLanguage: () => currentApplicationLocale,
  // 端点解析复用 resolveCurrentZCodeEndpointOrigin。
  resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
});
// 首个 Host 创建前刷新一次，让 Host 的冻结快照尽量接近最新灰度结果。
desktopContextPromptRollout = createDesktopContextPromptRollout({
  // fetchConfig 用共享的 electronClientConfigsFetcher。
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
// 渲染动作追踪有自己的 rollout，与 context prompt 共用 fetcher 但独立开关。
const rendererActionTraceRollout = createRendererActionTraceRollout({
  // 追踪 rollout 复用同一 fetcher，独立缓存。
  fetchConfig: electronClientConfigsFetcher,
  logger,
});
// 本地 TTFT 导出器只在本机落盘，环境取进程环境与本地文件的并集。
// 批次由 renderer 异步推送，这里只入队；真正的写盘与轮转由 exporter 自己负责。
// localTtftExporter 不参与远端遥测，因此可以在离线环境独立工作。
const localTtftExporter = createLocalTtftExporter({
  // env 取 hostProcessLocalEnv 与 process.env 并集。
  env: { ...hostProcessLocalEnv, ...process.env },
  // version 与其它遥测同源。
  version: ZCODE_VERSION || app.getVersion(),
  logger,
});
// TTFT 批次由 renderer 异步推送，这里只入队，不做校验与阻塞。
ipcMain.on(PlatformChannels.ReportLocalTtftBatch, (_event, batch: unknown) =>
  // enqueue 只入队，校验与写盘交给 exporter。
  localTtftExporter.enqueue(batch),
);
// 追踪 broker 负责聚合 renderer 上报；exporter 的环境与 TTFT 保持一致，便于关联。
const rendererActionTraceBroker = createRendererActionTraceBroker({
  // exporter 由 createRendererActionTraceExporter 构造。
  exporter: createRendererActionTraceExporter({
    ...hostProcessLocalEnv,
    ...process.env,
  }),
  logger,
});
// disposeRendererActionTraceIpc 初值 undefined，注册后才有。
let disposeRendererActionTraceIpc: (() => void) | undefined;
// ARMS 用户身份同步依赖 deviceMid 与 SDK 的 setConfig；SDK 未初始化时调用会被缓冲。
const armsUserIdentitySync = createArmsUserIdentitySync({
  // deviceMid 已同步生成，直接注入。
  deviceMid,
  // setUser 走 armsRum.setConfig 写 user。
  setUser: (user) => armsRum.setConfig("user", user),
});
// 远控默认 URL 在模块加载时算一次：只是兜底，实际值由 getEndpointUrls 动态解析。
const webRemoteControlAppVersion = ZCODE_VERSION || app.getVersion();
// 默认 URL 由 buildZCodeEndpointUrls 按 DEFAULT_ZCODE_ENDPOINT_ORIGIN 算。
const defaultZCodeEndpointUrls = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN, {
  // appVersion 复用 webRemoteControlAppVersion。
  appVersion: webRemoteControlAppVersion,
});
// 两个环境变量覆盖分别对应 relay WebSocket 与远端页面 URL，允许自建/联调环境指向别处。
// 默认 URL 在模块加载时算一次，仅作为兜底；实际值仍由动态端点解析提供。
// 覆盖值只影响远控，不影响本地会话与模型请求。
const webRemoteControlRelayWsEnvOverride =
  process.env["ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL"]?.trim();
// ZCODE_WEB_REMOTE_CONTROL_URL 覆盖远端页面地址。
const webRemoteControlUrlEnvOverride = process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim();

// 深层链接里的 workspace 路径解析：任何非法 URL 都返回 null，绝不抛错影响启动。
// 同时校验 scheme 与 host，避免把任意 URL 当成 deep link 处理。
// 路径解码失败同样返回 null，由调用方按“无路径”分支处理。
function extractOpenWorkspacePathFromDeepLinkUrl(url: string): string | null {
  try {
    // parsedUrl 用 new URL 解析，失败走 catch。
    const parsedUrl = new URL(url);
    // isWorkspaceOpenUrl 校验后交给 extractWorkspaceOpenPath。
    return isWorkspaceOpenUrl(parsedUrl) ? extractWorkspaceOpenPath(parsedUrl) : null;
  } catch {
    // 非法 URL 一律 return null，不抛错。
    return null;
  }
}

// 启动参数与协议 URL 的优先级：命令行显式路径优先于 deep link 中的路径。
// 二者都存在时只取其一，避免首窗打开两个 workspace。
// 解析出的路径只作为“请求”保存，最终是否打开仍由确认 gate 决定。
const startupOpenWorkspaceArgPath = extractOpenWorkspacePathFromArgs(process.argv);
// startupProtocolUrl 由 extractDeepLinkUrlFromArgs 取出。
const startupProtocolUrl = extractDeepLinkUrlFromArgs(process.argv);
// 命令行路径存在时不再解析 deep link 路径。
const startupDeepLinkWorkspacePath = startupOpenWorkspaceArgPath
  // 有 argPath 就置 null，保证只取一个。
  ? null
  // 否则从 startupProtocolUrl 提取 workspace 路径。
  : extractOpenWorkspacePathFromDeepLinkUrl(startupProtocolUrl ?? "");
// 启动消费门防止同一个 URL 在 ready 前后被处理两次（open-url 一次、ready 参数一次）。
const startupDeepLinkConsumptionGate = createStartupDeepLinkConsumptionGate(startupProtocolUrl);
// startupOpenWorkspaceRequest 是待消费的启动请求。
let startupOpenWorkspaceRequest: ExplicitStartupWorkspaceRequest | null =
  startupOpenWorkspaceArgPath
    // 来源标 open-workspace-arg，便于日志区分。
    ? { path: startupOpenWorkspaceArgPath, source: "open-workspace-arg" }
    // 其次看 deep link 路径。
    : startupDeepLinkWorkspacePath
      // 来源标 deep-link。
      ? { path: startupDeepLinkWorkspacePath, source: "deep-link" }
      // 都没有则 null，走默认工作区。
      : null;

// [资源] Web 远控管理器：负责中继连接、设备注册、workspace 同步与恢复。
// 所有存储都注入 settingService/deviceStorage，避免它自己读写文件而产生第二份真相。
// getLogin 每次现取凭据：用户可能在运行中切换账号，缓存会导致用旧身份重连。
// platformHandlers 只暴露只读探测与用户目录 MCP 读写，不暴露任意命令执行。
const webRemoteControlManager = createWebRemoteControlManager({
  // getEndpointUrls 每次现算，跟随切换。
  getEndpointUrls: async () => {
    // derived 用 resolveCurrentZCodeEndpointOrigin 的结果构建。
    const derived = buildZCodeEndpointUrls(await resolveCurrentZCodeEndpointOrigin(), {
      // 构建时带上 webRemoteControlAppVersion。
      appVersion: webRemoteControlAppVersion,
    });
    // 返回值在 derived 上补 relay 与 remoteUrl。
    return {
      ...derived,
      // relayWsUrl 由 resolveWebRemoteControlRelayWsUrl 生成。
      relayWsUrl: resolveWebRemoteControlRelayWsUrl({
        // endpointOrigin 用刚解析出的 derived.origin。
        endpointOrigin: derived.origin,
        // overrideUrl 取环境变量覆盖值。
        overrideUrl: webRemoteControlRelayWsEnvOverride,
      }),
      // remoteUrl 优先环境变量覆盖。
      remoteUrl: webRemoteControlUrlEnvOverride || derived.remoteUrl,
    };
  },
  // 模块级 relayWsUrl 只是兜底。
  relayWsUrl: resolveWebRemoteControlRelayWsUrl({
    // 兜底用 DEFAULT_ZCODE_ENDPOINT_ORIGIN。
    endpointOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    // 同样允许 overrideUrl 覆盖。
    overrideUrl: webRemoteControlRelayWsEnvOverride,
  }),
  // mobileRemoteControlUrl 优先覆盖，回退 defaultZCodeEndpointUrls。
  mobileRemoteControlUrl: webRemoteControlUrlEnvOverride || defaultZCodeEndpointUrls.remoteUrl,
  deviceMid,
  // deviceName 取 hostname 作为设备名。
  deviceName: hostname(),
  // appVersion 用于 relay 侧识别客户端版本。
  appVersion: webRemoteControlAppVersion,
  // getLogin 异步取 userId 与 authorization。
  getLogin: async () => {
    // userId 由 loadRemoteControlUserId 读取。
    const userId = await loadRemoteControlUserId();
    // authorization 再按 userId 取，二者有依赖。
    const authorization = await loadRemoteControlAuthorization(userId);
    // jwt 去掉 Bearer 前缀；无授权返回 undefined。
    return authorization ? { userId, jwt: authorization.slice("Bearer ".length) } : undefined;
  },
  // deviceStorage 由 createWebRemoteControlDeviceStorage 构造。
  deviceStorage: createWebRemoteControlDeviceStorage({
    // deleteLegacyCredential 清掉旧 pass_hash 凭据。
    deleteLegacyCredential: () =>
      // 键名固定 web-remote-control:external-relay:pass_hash。
      webRemoteControlCredentialService.delete("web-remote-control:external-relay:pass_hash"),
    // loadSettings 直连 mainSettingService，不另建缓存。
    loadSettings: () => mainSettingService.get(),
    // patchSettings 走 mainSettingService.update 落盘。
    patchSettings: (patch) => mainSettingService.update(patch),
  }),
  // startupRestoreStorageProvider 存最近一次启用的上下文。
  startupRestoreStorageProvider: {
    // load 读 webRemoteControlLastEnabledContext。
    load: async () => (await mainSettingService.get()).webRemoteControlLastEnabledContext,
    // save 把 context 的三个字段写回设置。
    save: async (context) => {
      // 先 await update 再返回，保证下次启动能读到。
      await mainSettingService.update({
        // 只存 workspacePath 与恢复所需字段。
        webRemoteControlLastEnabledContext: {
          // workspacePath 原样保留。
          workspacePath: context.workspacePath,
          // workspaceIdentity 与路径分开存，远程链路要用。
          workspaceIdentity: context.workspaceIdentity,
          // initialTaskId 用于恢复时重开同一任务。
          initialTaskId: context.initialTaskId,
        },
      });
    },
    // clear 用 undefined 覆盖，等价删除该键。
    clear: async () => {
      // 同样 await mainSettingService.update 落盘。
      await mainSettingService.update({
        // 置 undefined 清空 webRemoteControlLastEnabledContext。
        webRemoteControlLastEnabledContext: undefined,
      });
    },
  },
  // featureGate 由 createWebRemoteControlFeatureGate 判定灰度。
  featureGate: createWebRemoteControlFeatureGate(),
  logger,
  // relayMessageLogger 单独走 webRemoteControlRelayLogger。
  relayMessageLogger: webRemoteControlRelayLogger,
  // platformHandlers 汇总远端需要的平台能力。
  platformHandlers: {
    // isDockerAvailable 探测 Docker daemon。
    isDockerAvailable: () => isDockerDaemonAvailable(),
    // listWSLDistros 枚举 WSL 发行版。
    listWSLDistros: () => listAvailableWSLDistros(),
    // listDockerContainers 枚举可用容器。
    listDockerContainers: () => listAvailableDockerContainers(),
    // listSSHConfigAliases 读 ssh config 的别名。
    listSSHConfigAliases: () => listSSHConfigAliases(),
    // createTempTextAttachment 透传给同名工具函数。
    createTempTextAttachment: (payload) => createTempTextAttachment(payload),
    // loadMcpFromUserDirectory 读用户目录里的 MCP 配置。
    loadMcpFromUserDirectory: (payload) => loadCliMcpFromUserDirectory(payload),
    // saveMcpToUserDirectory 失败要转成结构化结果。
    saveMcpToUserDirectory: async (payload) => {
      try {
        // 先 await saveCliMcpToUserDirectory 写盘。
        await saveCliMcpToUserDirectory(payload);
        // 成功返回 success 标志。
        return { success: true };
      } catch (error) {
        // 非 Error 对象用 String 兜底成 message。
        const message = error instanceof Error ? error.message : String(error);
        // 失败只 logger.warn，不中断远控连接。
        logger.warn("[web-remote-control] MCP save failed", message);
        // 返回 success:false 与 error 文案。
        return { success: false, error: message };
      }
    },
    // migrateLegacyCommonMcp 迁移旧版公共 MCP 配置。
    migrateLegacyCommonMcp: (payload) => migrateLegacyCommonMcp(payload),
  },
  // reconnectWorkspace 指向 renderer 侧重连实现。
  reconnectWorkspace: reconnectWebRemoteControlWorkspaceInRenderer,
  // prepareProjectWorkspace 按 windowId 找窗口再转发。
  prepareProjectWorkspace: async (windowId, project, requestId) => {
    // win 由 BrowserWindow.fromId 解析。
    const win = BrowserWindow.fromId(windowId);
    // 窗口可能在导航请求排队期间关闭：此时无法再让 renderer 承接项目，直接失败让上层结束这次导航。
    if (!win || win.isDestroyed()) throw new Error("项目导航窗口已关闭");
    // 交给 remoteSessionManager.prepareProjectWorkspace。
    return remoteSessionManager.prepareProjectWorkspace(win, project, requestId);
  },
  // cancelProjectPreparation 只处理未销毁窗口。
  cancelProjectPreparation: (windowId, requestId) => {
    // 同样用 BrowserWindow.fromId 取窗口。
    const win = BrowserWindow.fromId(windowId);
    // 取消失败无需上报：窗口已销毁时，挂起的准备会话会随窗口一起回收。
    if (win && !win.isDestroyed())
      // 取消挂起会话，按 webContents.id 定位。
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow(
        win.webContents.id,
        "mobile-navigation-superseded",
        requestId,
      );
  },
  // reportRendererTelemetryEvent 一律 fire-and-forget。
  reportRendererTelemetryEvent: (event) => {
    // reportEvent 的 catch 吞掉错误，不阻塞调用方。
    void appTelemetryCore.reportEvent(event).catch(() => {});
  },
  // reportRemoteUsageEvent 先按 windowId 解窗口。
  reportRemoteUsageEvent: (windowId, event) => {
    // win 来自 BrowserWindow.fromId。
    const win = BrowserWindow.fromId(windowId);
    // 窗口已销毁时直接丢弃：用量上报是旁路，不能因为窗口关闭而抛错。
    if (!win || win.webContents.isDestroyed()) {
      // 窗口不在就 return，用量上报是旁路。
      return;
    }
    // 按 webContents.id 上报，renderer 侧再关联。
    reportRemoteUsageEventForRenderer(win.webContents.id, event);
  },
  // onStatusChanged 把状态推回指定窗口。
  onStatusChanged: (windowId, status) => {
    // 用 sendWebRemoteControlStatusChangedToWindow 发送。
    sendWebRemoteControlStatusChangedToWindow(BrowserWindow.fromId(windowId), status);
  },
  // attachWorkspaceHost 复用共享 Host attachment。
  attachWorkspaceHost: webRemoteControlSharedHostAttachments.attachWorkspaceHost,
  // releaseWorkspaceHostAttachment 释放 attachment。
  releaseWorkspaceHostAttachment: webRemoteControlSharedHostAttachments.releaseAttachment,
  // 按 windowId 回收该窗口的 attachment。
  disposeWorkspaceHostAttachmentsForWindow: (windowId) =>
    // disposeWindow 是共享 attachments 的方法。
    webRemoteControlSharedHostAttachments.disposeWindow(windowId),
  // 按 remoteSessionId 回收远程会话的 attachment。
  disposeWorkspaceHostAttachmentsForRemoteSession: (remoteSessionId) =>
    // disposeRemoteSession 收口远程会话。
    webRemoteControlSharedHostAttachments.disposeRemoteSession(remoteSessionId),
});
// 回填 ref：IPC 与设置同步回调可能在管理器创建后立刻触发，必须先有值。
webRemoteControlManagerRef.current = webRemoteControlManager;

// 强制升级拦截标志：一旦置真，所有创建窗口的入口都要被挡住，而不只是 app-ready 那一次。
// Dock 点击、托盘、activate、deep link、second-instance 都会经过 canCreateWindow。
// forceUpdateMainWindowCreationBlocked 置真后仍保留既有窗口：用户至少能看到升级提示与退出入口。
let forceUpdateMainWindowCreationBlocked = false;

// 外部 workspace 确认文案的语言：已 ready 且仍是默认语言时才去问系统，
// 否则使用用户显式选择的语言。
function resolveExternalWorkspaceConfirmationCopy() {
  // effectiveLocale 先定语言再取文案。
  const effectiveLocale =
    currentApplicationLocale === DEFAULT_LOCALE && app.isReady()
      // ready 且默认语言才 resolveSystemApplicationLocale。
      ? resolveSystemApplicationLocale()
      // 否则沿用 currentApplicationLocale。
      : currentApplicationLocale;
  // 交给 resolveExternalWorkspaceOpenDialogCopy 出文案。
  return resolveExternalWorkspaceOpenDialogCopy(effectiveLocale);
}

// 强制升级期间把已有窗口拉到前台：这是用户唯一能看到的“为什么没启动”的出口。
function focusForceUpdateGateWindow() {
  // gateWindow 取应用窗口集合的首个。
  const gateWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  // 没有窗口可聚焦时直接返回：拦截仍然生效，只是没有可提示的界面。
  if (!gateWindow) {
    // 没有窗口就 return，拦截仍然生效。
    return;
  }

  // 最小化时先还原，否则 focus 在部分平台上不会把窗口带回前台。
  if (gateWindow.isMinimized()) {
    // isMinimized 时先 restore。
    gateWindow.restore();
  }
  // 隐藏窗口（例如已关到托盘）必须先 show；只调用 focus 不会改变可见性。
  if (!gateWindow.isVisible()) {
    // isVisible 为假时先 show。
    gateWindow.show();
  }
  // 最后 focus 抢前台。
  gateWindow.focus();
}

// 主窗口协调器：保证“最多一个主窗口”。所有入口（activate/tray/open-url/deep link）
// 都通过它，而不是各自 new BrowserWindow，从而共享同一套启动 bootstrap 消费逻辑。
// primaryWindowCoordinator 同时负责把一次性启动请求消费掉，避免重复打开或重复确认。
// 协调器不持有窗口引用，只通过 listWindows 查询，避免与窗口生命周期耦合。
const primaryWindowCoordinator = createPrimaryWindowCoordinator({
  // listWindows 注入 getApplicationWindowsExcludingCuaIndicator。
  listWindows: getApplicationWindowsExcludingCuaIndicator,
  // resolveStartupWindowBootstrap 消费一次性启动请求。
  resolveStartupWindowBootstrap: () => {
    // startupOpenWorkspaceRequest 是一次性的：取走即置 null 并调 markStartupRequestConsumed，避免重连/激活时重复打开。
    if (startupOpenWorkspaceRequest) {
      // startupOpenWorkspaceRequest 非空才走显式分支。
      const request = startupOpenWorkspaceRequest;
      // 置 null 保证只消费一次。
      startupOpenWorkspaceRequest = null;
      // markStartupRequestConsumed 通知 gate 已消费。
      startupDeepLinkConsumptionGate.markStartupRequestConsumed(request);
      // explicitBootstrap 由 resolveExplicitStartupWorkspaceBootstrap 解析。
      const explicitBootstrap = resolveExplicitStartupWorkspaceBootstrap(request, {
        // confirmationCopy 来自 resolveExternalWorkspaceConfirmationCopy。
        confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
        logger,
      });
      // explicitBootstrap 有值就直接返回，不再走常规路径。
      if (explicitBootstrap) {
        // Promise.resolve 包一层，保持返回类型一致。
        return Promise.resolve(explicitBootstrap);
      }
    }

    // 常规启动：设置文件 + 会话目录都延迟取值，因为 dataBaseDir 可能在 bootstrap 中被改写。
    return resolveStartupWindowBootstrap({
      // settingsFile 延迟到真正解析时才读。
      settingsFile,
      // dataBaseDir 可能在 bootstrap 设置阶段被覆盖，必须在真正解析启动工作区时再取值。
      conversationWorkspaceDir: getConversationWorkspaceDir(),
      logger,
    });
  },
  // 创建窗口回调只做转交：真实构造在 createWindowInstance，便于单测替换协调器。
  createWindow: (startupBootstrap) => {
    // 真实构造在 createWindowInstance。
    createWindowInstance(startupBootstrap);
  },
  // 强制升级命中后，Dock/托盘/activate/deep link 都不能绕过 gate 创建旧版主界面。
  // 拦截时统一聚焦 gate 窗口，让用户看到“为什么没有打开”而不是无反应。
  // 日志里带 reason，便于区分是哪个入口触发了被拦截的创建请求。
  // 这里统一拦截并聚焦 gate 窗口，保证用户看到的是升级提示而不是闪退。
  canCreateWindow: (reason) => {
    // 未置位时放行是热路径：每个打开窗口的入口都会走到这里，保持一次布尔读。
    if (!forceUpdateMainWindowCreationBlocked) {
      // forceUpdateMainWindowCreationBlocked 未置位即放行。
      return true;
    }

    // 强制升级命中后，Dock/托盘/activate/deep link 不能绕过 app-ready gate 创建旧版主界面。
    logger.warn(`[force-update] 已阻止主窗口创建入口：${reason}`);
    // 再 focusForceUpdateGateWindow 拉出升级提示。
    focusForceUpdateGateWindow();
    // 返回 false 拒绝创建。
    return false;
  },
  logger,
});

// forceQuit 一旦置真不再回退：它表示“已确认退出或无窗口可确认”，任何路径都不应再弹出退出确认。
function markForceQuit(reason: string) {
  // 已置真时直接返回：避免重复写日志，也保证 reason 只反映首次触发来源。
  if (forceQuitRef.current) {
    // forceQuitRef.current 已真就 return，不重复写日志。
    return;
  }

  // 置 forceQuitRef.current 为 true，不可回退。
  forceQuitRef.current = true;
  // 记录首次触发 forceQuit 的 reason。
  logger.info(`[app-quit] forceQuit enabled (${reason})`);
}

// explicitQuit 单独记录“用户显式要求退出”（菜单/托盘），用于区分关窗按钮路径。
function markExplicitQuit(reason: string) {
  // 置 explicitQuitRef.current 标记用户显式退出。
  explicitQuitRef.current = true;
  // 日志带 reason 区分菜单与托盘路径。
  logger.info(`[app-quit] explicit quit requested (${reason})`);
}

// 设置同步只接受布尔值：非法类型直接忽略，避免坏设置把能力状态改成 undefined。
function syncCloseToTrayOnWindows(value: unknown) {
  // 非布尔值直接丢弃：renderer 传入 null 或字符串时，保持上一次的关闭驻留行为。
  if (typeof value !== "boolean") {
    // 非布尔值直接 return，保持上次行为。
    return;
  }

  // 校验通过才写 closeToTrayOnWindows。
  closeToTrayOnWindows = value;
  // 记录 closeToTrayOnWindows 的新值。
  logger.info(`[settings] closeToTrayOnWindows=${value}`);
}

// 设置即时同步通道：文件已由 renderer 的 update 落盘，这里只做 main 侧副作用。
// syncImmediateAppSettings 对每个字段独立判 typeof，避免一个字段的坏值阻断其它字段。
function syncImmediateAppSettings(patch: ReturnType<typeof appSettingsPatchSchema.parse>) {
  // 先同步 closeToTrayOnWindows，它自带 typeof 守卫。
  syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);

  // keep-awake 走 reconciler，重复设置同一值不会产生新的 blocker。
  if (typeof patch.keepAwakeWhileRunning === "boolean") {
    // 写 keepAwakeWhileRunning 后交给 reconciler。
    keepAwakeWhileRunning = patch.keepAwakeWhileRunning;
    // reconcileKeepAwakeBlocker 按引用计数增删 blocker。
    reconcileKeepAwakeBlocker();
  }

  // receivePreviewUpdates 只认布尔值。
  if (typeof patch.receivePreviewUpdates === "boolean") {
    // receivePreviewUpdates 由 renderer host 写入 setting.json。
    // main 进程的自动更新器不会订阅 host 设置变化，必须借 syncAppSettings 这条即时通道刷新 manifest channel。
    refreshAutoUpdaterReleaseChannel(
      patch.receivePreviewUpdates,
      "settings receivePreviewUpdates changed",
    );
  }

  // shortcutBindings 变更需要 rebuildMenu 并广播 SettingsChanged：其它窗口的键盘映射与设置页都要跟随。
  if (patch.shortcutBindings !== undefined) {
    // 快捷键改绑：
    // 落盘已完成（useSettings.update 先 await settingService.update 再走本通道），
    // 这里重建应用菜单 accelerator，并通知所有窗口刷新设置快照 —— 其他窗口的
    // useAppKeyboard 生效表与设置页跟随更新。先例：setAutoDownloadAndInstallUpdates 的全窗口广播。
    rebuildMenu();
    // 广播给全部应用窗口，getApplicationWindowsExcludingCuaIndicator 排除指示窗。
    for (const win of getApplicationWindowsExcludingCuaIndicator()) {
      // 发送前判 isDestroyed，关闭阶段 webContents 可能已销毁。
      if (!win.isDestroyed()) {
        // send PlatformChannels.SettingsChanged 触发各窗口刷新设置。
        win.webContents.send(PlatformChannels.SettingsChanged);
      }
    }
  }
}

// 自动更新偏好是 main 侧读取的最小投影：只返回一个布尔，避免把整个设置暴露给更新器。
async function getAutoUpdatePreferences() {
  // settings 取自 mainSettingService，不缓存。
  const settings = await mainSettingService.get();
  // return 只投影一个布尔，不暴露整个设置对象。
  return {
    // autoDownloadAndInstallUpdates 缺省按 false。
    autoDownloadAndInstallUpdates: settings.autoDownloadAndInstallUpdates ?? false,
  };
}

// 写入后立即走即时通道并广播，理由同快捷键：更新器不订阅 renderer 的设置变化。
async function setAutoDownloadAndInstallUpdates(enabled: boolean) {
  // 先 await mainSettingService.update 落盘。
  await mainSettingService.update({
    // 写入 autoDownloadAndInstallUpdates 的新值。
    autoDownloadAndInstallUpdates: enabled,
  });
  // 再走 syncImmediateAppSettings 即时通道。
  syncImmediateAppSettings({
    // 透传 enabled，保持与落盘值一致。
    autoDownloadAndInstallUpdates: enabled,
  });
  // 逐个应用窗口广播 SettingsChanged。
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    // 判 isDestroyed 后再 send。
    if (!win.isDestroyed()) {
      // 发送 PlatformChannels.SettingsChanged，设置页跟随刷新。
      win.webContents.send(PlatformChannels.SettingsChanged);
    }
  }
}

// [事务] 退出屏障：先选策略（normal vs update-install），再保证只执行一次。
// 策略只影响超时预算，不改变清理顺序；预算在屏障开始时固化，之后不再调整。
// update 请求晚于普通退出时，prepareAppQuit 只记录 selection.upgraded 而不重建定时器，避免退出时间被无限推迟。
// 并发调用共享同一个 in-flight promise，第二个调用者不会启动第二轮清理。
// update 请求可能晚于普通退出：此时不能延长已创建的定时器，只能记录并继续。
async function prepareAppQuit(reason: string, kind: AppShutdownKind = "normal"): Promise<void> {
  // selectAppShutdownPolicy 决定 normal 还是 update-install。
  const selection = selectAppShutdownPolicy(activeAppShutdownKind, kind, process.platform);
  // 固化 activeAppShutdownKind，后续不再改。
  activeAppShutdownKind = selection.kind;
  // 同时固化 activeAppShutdownPolicy 的超时预算。
  activeAppShutdownPolicy = selection.policy;
  // 已开始或已完成时只告警不改预算：改预算需要重建定时器，会让退出时间不可预测。
  // 已在清理中或已完成时，更新请求只能沿用既有预算：此时重建定时器会让退出时间不可预测。
  if (selection.upgraded && (hasPreparedAppQuit || appQuitPreparationInFlight)) {
    // 更新请求可能晚于普通退出屏障。已创建的 4s timer 无法靠修改全局策略延长；
    // 明确保留既有预算，并允许更新继续进入 fail-open 资源扫描和安装器。
    logger.warn(
      `[app-quit] update install joined an existing normal shutdown barrier (${reason}); existing timers keep their original budget`,
    );
  }
  // 已完成直接返回：第二次调用只等待同一结果。
  if (hasPreparedAppQuit) {
    // hasPreparedAppQuit 为真直接 return。
    return;
  }
  // 并发调用共享同一个 in-flight promise：第二个调用者只等待，不再启动第二轮清理。
  if (appQuitPreparationInFlight) {
    // 已有 in-flight 就只 await，不启动第二轮清理。
    await appQuitPreparationInFlight;
    // await 完 return，共享同一结果。
    return;
  }

  // 置 forceQuit 后，后续所有 close 事件都不再弹确认；这是“批量退出”的前提。
  markForceQuit(reason);
  // 先 dispose windowsCuaOperationIndicator。
  windowsCuaOperationIndicator.dispose();
  // 再 dispose browserScreenshotSurfaceCoordinator。
  browserScreenshotSurfaceCoordinator.dispose();
  // Bug 根因：资源样本改为 5 分钟窗口后，退出仍直接 stop 会清空未满窗口的数据。
  // 退出时只排空已存在的角色 / Agent 内存窗口，不启动新采样、目录扫描或外部探针。
  // 资源/尺寸/网络三类采样先停且 flush：退出后没有机会再补采。
  stopDesktopResourceTelemetry({ flushPendingWindows: true });
  // 停 stopDesktopZCodeDataSizeTelemetry 的数据量采样。
  stopDesktopZCodeDataSizeTelemetry();
  // 停 stopDesktopNetworkTelemetry 的网络采样。
  stopDesktopNetworkTelemetry();
  // 停 stopRemoteUsageArmsPeriodicSampling 的周期上报。
  stopRemoteUsageArmsPeriodicSampling();
  // disposeRendererActionTraceIpc 可能未注册，用可选调用。
  disposeRendererActionTraceIpc?.();
  // 置 undefined 防止重复 dispose。
  disposeRendererActionTraceIpc = undefined;
  // 稳定性上报用 update_install 或 app_quit 区分退出场景；exitCode 恒为 0。
  notifyStabilityAppExit(
    getStabilityLifecycleScene() === "update_install" ? "update_install" : "app_quit",
    logger,
    { exitCode: 0, exitKind: "normal" },
  );

  // 先摘掉全局引用再销毁：销毁过程中若有新任务请求派发，不会拿到半死的 scheduler。
  const cronSchedulerToDispose = cronScheduler;
  // cronScheduler 置 null，避免派发拿到半死调度器。
  cronScheduler = null;

  // Host 集合 = 活窗口的 Host + 正在销毁的 Host，去重后逐个等待。
  // 只等活窗口会漏掉刚被关窗流程摘掉但尚未退出的进程。
  const hostProcesses = [
    ...new Set([...windowHostProcessMap.values(), ...listDisposingHostProcesses()]),
  ];
  // 记录 hosts 数量与 forceKillDelayMs、waitTimeoutMs。
  logger.info(
    `[app-quit] waiting for host process cleanup (${reason}), kind=${activeAppShutdownKind}, hosts=${hostProcesses.length}, forceKillDelayMs=${activeAppShutdownPolicy.forceKillDelayMs}, waitTimeoutMs=${activeAppShutdownPolicy.waitTimeoutMs}`,
  );

  // 所有 owner 并行进入同一屏障：它们之间没有关闭依赖，串行会放大退出预算。
  // Host 回收是其中最慢的一段，因此每个 Host 单独限时并带强制 kill 兜底。
  // 任一 owner 失败都只记录，不中断其余回收——退出必须保证最终能完成。
  // telemetry flush 单独限时 2s，避免网络问题拖住整个退出。
  appQuitPreparationInFlight = Promise.all([
    // 退出屏障结束后再启动窗口尺寸写入，可能在 app.exit 前留下 setting.json.lock。
    // 尺寸已在 resize 防抖或最大化状态变化时保存，退出屏障不再创建新的尺寸写入。
    // 修复原因：Main 过去不会等待仍在发送的 /event/report，正常退出也会直接丢事件。
    // 与其它 owner 并行进入既有屏障，最多等待 2 秒，避免 telemetry 串行放大退出预算。
    appTelemetryCore.flushPendingReports({ timeoutMs: 2_000 }),
    localTtftExporter.shutdown(),
    rendererActionTraceBroker.shutdown().catch((error) => {
      // rendererActionTraceBroker shutdown 失败只 warn。
      logger.warn(`[app-quit] renderer action trace shutdown failed (${reason}):`, error);
    }),
    // 旧流程先等待 Cron 的 1.5s deadline，再启动 Host timer，导致声明的
    // 4.5s/9s 退出总预算被串行放大。两类 owner 无关闭依赖，统一并行进入同一屏障。
    // cron dispose 包 catch：调度器已崩溃时不能用它的异常中断 Host 回收。
    (async () => {
      try {
        // cronSchedulerToDispose 可能为 null，用可选调用。
        await cronSchedulerToDispose?.dispose();
      } catch (error) {
        // dispose 抛错只 warn，不中断 Host 回收。
        logger.warn(`[app-quit] cron scheduler dispose failed (${reason}):`, error);
      }
    })(),
    // remote session、attachment 和 transport 都由窗口 Host 持有；这里先清理
    // Main 的请求关联，再由下方每窗口唯一 Host 的 shutdown barrier 释放真实连接与 Agent。
    remoteSessionManager.disposeAllAndWaitForAppShutdown(reason),
    // 每个 Host 用 reason-index 作为日志标签，便于从退出日志对齐到具体窗口。
    ...hostProcesses.map((child, index) =>
      // disposeHostProcessAndWait 逐个回收，各自限时。
      disposeHostProcessAndWait(
        child,
        `${reason}-${index + 1}`,
        disposingHostProcessTimers,
        logger,
        {
          // forceKillDelayMs 取自固化的 activeAppShutdownPolicy。
          forceKillDelayMs: activeAppShutdownPolicy.forceKillDelayMs,
          // waitTimeoutMs 同样取固化的策略值。
          waitTimeoutMs: activeAppShutdownPolicy.waitTimeoutMs,
        },
      ),
    ),
  ])
    // 成功/失败都只记录：退出流程不能因为某个 owner 失败而中止其余回收。
    .then(() => {
      // 全部成功才打 completed 日志。
      logger.info(`[app-quit] host process cleanup completed (${reason})`);
    })
    .catch((error) => {
      // 失败记 logger.error，但 finally 仍会收口。
      logger.error(`[app-quit] host process cleanup failed (${reason}):`, error);
    })
    .finally(() => {
      // before-quit 是同步事件。只发 Dispose 就继续退出 main 的话，
      // host 还没等到 agent 进程树的 SIGTERM/SIGKILL 兜底完成就被带走，zcode-cli 会被 init 接管成残留进程。
      // 这里先拦截第一次退出，等待 host 清理完成后再放行第二次 app.quit。
      // finally 才置 hasPreparedAppQuit：提前置真会让第二次 before-quit 在清理未完成时放行。
      hasPreparedAppQuit = true;
      // 清 appQuitPreparationInFlight，第二次调用走 hasPreparedAppQuit 分支。
      appQuitPreparationInFlight = null;
    });

  // await appQuitPreparationInFlight 等所有 owner 收尾。
  await appQuitPreparationInFlight;
}

// 已准备完成后的退出：E2E 与生产走两条路，前者需要确保进程真的结束。
// E2E 下 ChromeDriver 可能在 deleteSession 期间吞掉 app.exit，因此用独立系统命令终止 PID。
// 该分支只在 run id 明确且 Host/agent 已回收后执行，不会影响产品退出。
// spawn 用 detached + unref，确保 killer 进程不阻止当前进程结束。
function exitPreparedApp(reason: string): never | void {
  // 打出 exiting prepared app 与 reason。
  logger.info(`[app-quit] exiting prepared app (${reason})`);
  // E2E 下先 flush 覆盖率；失败只告警，不能阻止退出。
  if (process.env.ZCODE_E2E_RUN_ID?.trim()) {
    // flushMainE2ECoverage 回调里只记错误。
    flushMainE2ECoverage((error) => {
      // 覆盖率 flush 失败只 logger.warn，不阻止退出。
      logger.warn("[e2e-coverage] main coverage flush failed", error);
    });
    // ChromeDriver 正在执行 deleteSession 时，Electron app.exit(0)
    // 和进程内的 process.kill 都可能被 Electron 生命周期吞掉。这里只在 E2E
    // run 身份明确、且 prepareAppQuit 已完成 host/agent 回收之后，启动独立系统
    // 命令终止当前 PID；不按名称扫描，也不会影响产品退出或下一轮 session。
    const killer =
      process.platform === "win32"
        // win32 走 spawn taskkill 强杀当前 PID。
        ? spawn("taskkill", ["/PID", String(process.pid), "/F"], {
            // detached 让 killer 脱离父进程组。
            detached: true,
            // stdio 忽略，避免占住当前终端的管道。
            stdio: "ignore",
            // windowsHide 避免弹出黑色控制台窗。
            windowsHide: true,
          })
        // 非 win32 用 spawn kill -9 结束自身。
        : spawn("kill", ["-9", String(process.pid)], {
            // detached 同 win32，脱离会话。
            detached: true,
            // stdio 同样忽略输出。
            stdio: "ignore",
          });
    // killer.unref 让 killer 不再阻止进程退出。
    killer.unref();
    // return 跳过 app.exit，交给外部命令收尾。
    return;
  }
  // 非 E2E 直接 app.exit(0) 同步退出。
  app.exit(0);
}

// 运行中会话数取所有 Host 的计数之和；它决定退出确认文案与“是否忙碌”判定。
function getRunningAgentSessionCount() {
  // 对 hostRunningTaskCountMap 求和得到总会话数。
  return [...hostRunningTaskCountMap.values()].reduce((total, count) => total + count, 0);
}

// delay 的定时器 unref：等待类延时不应阻止进程自然退出。
function delay(ms: number): Promise<void> {
  // delay 返回 Promise，超时后 resolve。
  return new Promise((resolve) => {
    // Math.max 兜住负数，setTimeout 不接受负延时。
    const timer = setTimeout(resolve, Math.max(ms, 0));
    // timer.unref 避免延时拖住进程退出。
    timer.unref?.();
  });
}

// execWithTimeout：带强杀的同步命令包装。settled 标志保证 close/error 只结算一次，
// 因为 taskkill 在超时被杀后仍可能触发 close，重复 resolve 会让调用方看到两份结果。
// 返回结构包含 timedOut，调用方可区分“失败”与“超时后被杀”。
// 不抛出异常：批量清理需要收集每个 pid 的结果，而不是第一个失败就中断。
async function execWithTimeout(
  // file 是 execFile 的命令路径。
  file: string,
  // args 透传给 execFile 的参数数组。
  args: string[],
  // timeoutMs 到点就 SIGKILL，不无限等待。
  timeoutMs: number,
  // spawnOptions 只透出 windowsHide 与 encoding 两项。
  spawnOptions: { windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{
  // timedOut 让调用方区分失败与超时。
  timedOut: boolean;
  // code 是子进程退出码。
  code?: number | null;
  // signal 仅在被信号杀死时给出。
  signal?: NodeJS.Signals | null;
  // error 存 spawn 失败的消息。
  error?: string;
}> {
  // 动态 import execFile，避免顶层引入影响启动。
  const { execFile } = await import("node:child_process");
  // 超时只置标志并发 SIGKILL：不在这里 resolve，等 close 事件统一结算。
  return new Promise((resolve) => {
    // settled 保证 close 与 error 只结算一次。
    let settled = false;
    // timedOut 由定时器置真，结果里带走。
    let timedOut = false;
    // child 是 execFile 返回的子进程句柄。
    const child = execFile(file, args, {
      // windowsHide 透传，打包态不弹控制台。
      windowsHide: spawnOptions.windowsHide,
      // encoding 决定 stdout 解码方式。
      encoding: spawnOptions.encoding,
    });
    // 强杀失败（进程已退出）直接忽略；真正的结果仍由 close 决定。
    const timer = setTimeout(() => {
      // 超时先置 timedOut 标志。
      timedOut = true;
      try {
        // 用 process.kill 发 SIGKILL 强杀。
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // 进程可能已自行退出，忽略
      }
    }, timeoutMs);
    // 先判 settled 再清定时器：重复事件不应重复 resolve（Promise 虽幂等，日志会重复）。
    // 已结算则丢弃：SIGKILL 之后 close 与 error 可能都到达，重复 resolve 没有意义。
    child.on("close", (code, signal) => {
      // close 前先看 settled 是否已结算。
      if (settled) {
        // 已结算就 return，丢弃重复事件。
        return;
      }
      // 置 settled 锁住后续结算。
      settled = true;
      // clearTimeout 取消未触发的强杀定时器。
      clearTimeout(timer);
      // resolve 带上 timedOut 与 code、signal。
      resolve({ timedOut, code, signal });
    });
    // error 事件处理 spawn 失败路径。
    child.on("error", (error) => {
      // error 前同样检查 settled。
      if (settled) {
        // 已结算则忽略第二次 error 回调。
        return;
      }
      // 锁住 settled 防止重复 resolve。
      settled = true;
      // 清掉 timer，避免超时再触发。
      clearTimeout(timer);
      // 把 error.message 带回调用方。
      resolve({ timedOut, error: error.message });
    });
  });
}

// 批量强杀前先过滤非法 pid 并去重：重复 pid 会得到两份结果，干扰后续判定。
async function forceTerminateWindowsAgentProcesses(pids: number[]): Promise<
  // 返回数组逐项带 pid 与结算状态。
  Array<{
    // pid 与输入一一对应。
    pid: number;
    // timedOut 透传自 execWithTimeout。
    timedOut: boolean;
    // code 是 taskkill 退出码。
    code?: number | null;
    // signal 用于判断是否被强杀。
    signal?: NodeJS.Signals | null;
    // error 记录 spawn 层失败。
    error?: string;
  }>
// 函数体：先 Set 去重再 Promise.all 并发。
> {
  // 用 /T 连子进程一起杀：agent 常派生 shell/工具子进程，只杀父进程会留下孤儿。
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  // Promise.all 并发跑，批量杀更快。
  return Promise.all(
    uniquePids.map((pid) =>
      // 每个 pid 调 execWithTimeout 带超时。
      execWithTimeout(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS,
        {
          // windowsHide 为真，taskkill 不弹窗。
          windowsHide: true,
        },
      ).then((result) => ({ pid, ...result })),
    ),
  );
}

// 资源快照/可写探测只用于诊断：打包资源目录不可写是更新失败的常见根因。
function logWindowsPackagedResourceSnapshot(stage: string) {
  // logger.info 输出快照，便于比对前后。
  logger.info(
    `[auto-update] Windows packaged resources snapshot (${stage}): ${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

// 只告警“存在但不可写”的目录：不存在可能是可选资源，不构成失败。
function logWindowsPackagedResourceWritableProbe(stage: string) {
  // probes 取自 probeWindowsPackagedResourceWritable。
  const probes = probeWindowsPackagedResourceWritable(process.resourcesPath);
  // failed 只留 exists 且不可写的目录。
  const failed = probes.filter((probe) => probe.exists && !probe.writable);
  // 无论成败都记录 probes，作为诊断证据。
  logger.info(
    `[auto-update] Windows packaged resources writable probe (${stage}): ${JSON.stringify(probes)}`,
  );
  // 只对“存在但不可写”的目录告警：目录不存在多半是可选资源，告警会变成噪声。
  if (failed.length > 0) {
    // 不可写时 logger.warn，但不中断安装。
    logger.warn(
      `[auto-update] Windows packaged resource dirs are not writable (${stage}): ${JSON.stringify(
        failed,
      )}`,
    );
  }
}

// bundled runtime 完整性检查只在 Windows 打包态执行；缺失只记日志，
// 因为用户可能根本不用该 provider，不能因此阻断启动。
function logWindowsBundledRuntimeIntegrityDiagnostic() {
  // 仅 Windows 打包态检查：开发态与其它平台的资源布局不同，扫出来的缺失没有诊断意义。
  if (process.platform !== "win32" || !app.isPackaged) {
    // 非 Windows 或非打包态直接 return。
    return;
  }

  // binaryPaths 汇总需要校验的 bundled 二进制。
  const binaryPaths = {
    // glm 路径由 resolveBundledGlmBinaryPath 解析。
    glm: resolveBundledGlmBinaryPath(),
  };
  // missingProviders 收集解析失败的 provider。
  const missingProviders = Object.entries(binaryPaths)
    .filter(([, binaryPath]) => !binaryPath)
    .map(([provider]) => provider);
  // 全部存在时静默返回：这条路径每次启动都会走，正常情况不写日志。
  if (missingProviders.length === 0) {
    // 全部存在就 return，不写日志。
    return;
  }

  // bundled runtime 缺失不一定影响用户当前 provider，启动阶段只静默落日志。
  // 这样既能在下次用户日志里确认安装资源是否已损坏，也不会因为未使用的 provider 缺失打断启动。
  logger.warn(
    `[startup] Windows bundled runtime missing providers: ${missingProviders.join(", ")} resources=${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

// [事务] Windows 更新安装前的专项清理：只处理“仍引用随包资源”的实时进程，
// 不使用退出前记录的 PID（可能已被复用），也不追加第二轮 Host 等待。
// 清理后重新探测可写性（after-taskkill），作为 NSIS 安装器能否覆盖文件的最后证据。
// cleanup.remainingLockProcesses 仍存活时只告警：此时继续安装比中止更符合用户预期（至少能尝试替换）。
async function prepareWindowsProcessesForUpdateInstall() {
  // trackedAgentCount 取自 listRegisteredHostAgentProcessIds。
  const trackedAgentCount = listRegisteredHostAgentProcessIds().length;

  // 记录 trackedAgent 数量作为清理起点。
  logger.info(`[auto-update] preparing Windows update install: trackedAgent=${trackedAgentCount}`);
  // 释放句柄前先拍 before-dispose 快照。
  logWindowsPackagedResourceSnapshot("before-dispose");

  // 资源锁标记来自随包资源路径；扫描按命令行匹配，能覆盖未登记的派生进程。
  const resourceLockMarkers = resolveWindowsPackagedResourceLockMarkers(process.resourcesPath);
  // prepareAppQuit 已经用同一屏障回收每窗口唯一 Host，并在 7.5 秒强杀、
  // 9 秒收口；Windows 专项阶段不能再追加一轮等待，也不能用退出前记录的 Host/Agent PID
  // 强杀，因为 PID 可能已经复用。这里只清理实时扫描仍引用随包资源的 runtime 进程，
  // 当前 main/renderer 的最终退出交给 updater 与 NSIS。
  // 清理失败以降级列表返回而不是抛出：安装器仍应继续，最坏情况是部分文件未替换。
  const cleanup = await runWindowsUpdateProcessCleanup({
    // resourceLockMarkers 来自随包资源路径。
    resourceLockMarkers,
    // 宽限期用 WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS。
    lockReleaseGraceMs: WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
    // scan 注入 findWindowsProcessesReferencingResourceMarkers。
    scan: findWindowsProcessesReferencingResourceMarkers,
    // terminate 注入 forceTerminateWindowsAgentProcesses。
    terminate: forceTerminateWindowsAgentProcesses,
    delay,
  });

  // 记录 initialLockProcesses 与 trackedAgent 计数。
  logger.info(
    `[auto-update] Windows resource lock scan: matches=${cleanup.initialLockProcesses.length} trackedAgent=${trackedAgentCount} details=${JSON.stringify(
      cleanup.initialLockProcesses,
    )}`,
  );
  // 降级错误逐条告警而不是聚合抛出：安装器仍应继续，最坏情况是部分文件未替换。
  for (const error of cleanup.errors) {
    // cleanup.errors 逐条 logger.warn，不聚合抛出。
    logger.warn(`[auto-update] Windows process cleanup degraded: ${error}`);
  }

  // cleanup.terminationPids 为空时只做可写探测（no-lock-processes）：这是“更新后文件缺失”排查的关键证据。
  // 没有锁进程就不必谈“释放句柄”，只做可写探测留下可诊断的证据后直接返回，不再追加等待。
  if (cleanup.terminationPids.length === 0) {
    // 没有锁进程时只跑 logWindowsPackagedResourceWritableProbe 留证。
    logWindowsPackagedResourceWritableProbe("no-lock-processes");
    // 直接 return，不再等待句柄释放。
    return;
  }

  // 少量 Windows 用户更新后安装目录里的 bundled agent 文件会缺失。
  // 根因通常是 NSIS 覆盖 resources/glm 等目录时，旧 agent/helper 进程或杀软触发的残留进程仍持有句柄；
  // 只杀 host 上报过的 agent pid 会漏掉未登记或已经脱离登记的后代。这里在更新前按命令行再扫描一次安装资源路径，
  // 对仍引用随包资源的进程树做强制清理，降低半更新导致环境损坏的概率。
  logger.info(
    `[auto-update] Windows taskkill results: ${JSON.stringify(cleanup.terminationResults)}`,
  );
  // 打印 WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS 实际等待时长。
  logger.info(
    `[auto-update] Windows resource lock release grace elapsed: ${WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS}ms`,
  );

  // remainingLockProcesses 仍非空说明 taskkill 没清干净。
  if (cleanup.remainingLockProcesses.length > 0) {
    // 只 warn 不中断，安装器仍要尝试覆盖。
    logger.warn(
      `[auto-update] Windows resource lock processes still alive after taskkill: ${JSON.stringify(
        cleanup.remainingLockProcesses,
      )}`,
    );
  }
  // 清理后再探一次可写性，覆盖 after-taskkill 场景。
  logWindowsPackagedResourceWritableProbe("after-taskkill");
}

// 退出确认只在 production 且确有运行中会话时出现；开发态需要频繁重启，不能打断。
// 判定使用 Host 上报的运行中任务数，而不是窗口数或连接数。
// confirmAppQuit 的确认框语言直接读 currentApplicationLocale，不引入渲染层 i18n，所以主进程不必加载前端资源。
function shouldConfirmAppQuit() {
  // 开发环境里的普通会话经常需要重启 Electron，只在 production 下拦截，避免打断调试。
  return ZCODE_ENV === "production" && getRunningAgentSessionCount() > 0;
}

// 确认框是同步的：before-quit 是同步事件，异步确认会让 Electron 先退出。
// 语言直接读当前 locale，不使用 i18n 框架，避免在主进程引入渲染依赖。
function confirmAppQuit(originWindow?: BrowserWindow | null) {
  // shouldConfirmAppQuit 为假时静默放行。
  if (!shouldConfirmAppQuit()) {
    // 记录 skipped 原因，便于确认非生产环境无弹窗。
    logger.info(`[app-quit] quit confirmation skipped in ${ZCODE_ENV}`);
    // return true 放行退出，不弹确认框。
    return true;
  }

  // 文案语言取自 currentApplicationLocale 是否 zh-CN。
  const isZh = currentApplicationLocale === "zh-CN";
  // 运行中会话数由 Host 上报，getRunningAgentSessionCount 汇总。
  const runningAgentSessionCount = getRunningAgentSessionCount();
  // detailLines 只放与退出后果相关的信息。
  const detailLines = [
    runningAgentSessionCount > 0
      // 中文分支给 isZh 的会话中断提示。
      ? isZh
        // 插入 runningAgentSessionCount 的条数，让用户知道损失。
        ? `正在进行的会话：${runningAgentSessionCount} 个，退出后会被中断。`
        // 英文分支同义，保留 sessions 复数形式。
        : `In-progress sessions: ${runningAgentSessionCount}. They will be interrupted after quitting.`
      // 无运行中会话时置 null，后续过滤掉。
      : null,
  ].filter((line): line is string => line !== null);
  // targetWindow 决定弹框挂在哪个窗口上。
  const targetWindow =
    originWindow && !originWindow.isDestroyed()
      // originWindow 未销毁就作为父窗。
      ? originWindow
      // 否则退到 getFocusedWindow。
      : (BrowserWindow.getFocusedWindow() ??
        // 再退到 getApplicationWindowsExcludingCuaIndicator 的首个窗口。
        getApplicationWindowsExcludingCuaIndicator()[0] ??
        // 都没有则 null，弹独立对话框。
        null);
  // dialogOptions 一次构造，避免两处文案漂移。
  const dialogOptions = {
    // type 固定 question，带问号图标。
    type: "question" as const,
    // buttons 退出在前取消在后，默认不误退。
    buttons: isZh ? ["退出", "取消"] : ["Quit", "Cancel"],
    // defaultId 设为 1 即取消，回车不会误退出。
    defaultId: 1,
    // cancelId 同样 1，Esc 走取消。
    cancelId: 1,
    // title 按 isZh 切换退出确认。
    title: isZh ? "退出确认" : "Confirm Quit",
    // message 是主问句，与 title 分开渲染。
    message: isZh ? "确认退出 Z Code?" : "Quit Z Code?",
    // detail 拼接多行，空数组时为空串。
    detail: detailLines.join("\n"),
    // icon 复用 iconPath，nativeImage 建一次。
    icon: nativeImage.createFromPath(iconPath),
  };

  // targetWindow 优先用 originWindow；它已销毁时退回 BrowserWindow.getFocusedWindow()，再退回首个应用窗口。
  const result = targetWindow
    // 有父窗时传 targetWindow，模态归属明确。
    ? dialog.showMessageBoxSync(targetWindow, dialogOptions)
    // 无父窗用 showMessageBoxSync 单参重载。
    : dialog.showMessageBoxSync(dialogOptions);
  // result 0 即按下退出按钮。
  return result === 0;
}

// executeDesktopCommandForApp 是桌面命令的统一入口：设置、缩放、端点切换与重启能力都经这里注入 executeDesktopCommand，所以处理器本身不持有服务引用。
// 命令处理器本身不持有任何服务引用，所有依赖由这里注入，便于测试替换。
// 重启路径复用 prepareAppQuit，确保与普通退出共享同一套资源回收。
async function executeDesktopCommandForApp(
  // command 类型直接取自 executeDesktopCommand 首参。
  command: Parameters<typeof executeDesktopCommand>[0]["command"],
  // senderWindow 透传，命令可回投发起窗口。
  senderWindow?: BrowserWindow | null,
) {
  // 依赖全部在此注入，executeDesktopCommand 本身无状态。
  return executeDesktopCommand({
    // fetchHelpConfig 走 readHelpConfig，不直连网络。
    fetchHelpConfig: readHelpConfig,
    command,
    senderWindow,
    logger,
    updateZCodeStdioTapDevMenuState,
    // onDesktopZoomChanged 先经 clampDesktopZoomLevel 夹取再 rebuildMenu：菜单里的缩放项要显示当前值。
    onDesktopZoomChanged: (zoomLevel) => {
      // 先经 clampDesktopZoomLevel 夹取再写 currentDesktopZoomLevel。
      currentDesktopZoomLevel = clampDesktopZoomLevel(zoomLevel);
      // 改缩放后 rebuildMenu 刷新菜单勾选态。
      rebuildMenu();
    },
    // settingService 用主进程单例 mainSettingService。
    settingService: mainSettingService,
    // 端点变更回调指向 handleZCodeEndpointChanged。
    onZCodeEndpointChanged: handleZCodeEndpointChanged,
    // 基准 origin 由 resolveZCodeEndpointEnvBaseOrigin 解析。
    zcodeEndpointEnvBaseOrigin: resolveZCodeEndpointEnvBaseOrigin(hostProcessLocalEnv),
    // 重启前必须走完整退出屏障：否则旧 Host 未回收，新实例会与本实例抢同一份数据。
    onRelaunchApp: async () => {
      // 重启前先 await prepareAppQuit，回收 Host 与遥测。
      await prepareAppQuit("desktop-command-relaunch");
      // 先 app.relaunch 排入重启，随后 app.quit 才生效。
      app.relaunch();
      // app.quit 触发退出流程，与 relaunch 配对。
      app.quit();
    },
    // credentialsDir 由 getCredentialsDir 给出，命令层不拼路径。
    credentialsDir: getCredentialsDir(),
    currentApplicationLocale,
  });
}

// 端点选择用于菜单勾选态：production 环境不看设置，直接认定为 production。
async function resolveZCodeEndpointSelection(): Promise<"production" | "test" | "custom"> {
  // production 环境直接认定，不读设置。
  if (ZCODE_ENV === "production") {
    // 返回 production 供菜单打勾。
    return "production";
  }
  // 非生产才调 resolveCurrentZCodeEndpointOrigin 现取。
  const origin = await resolveCurrentZCodeEndpointOrigin();
  // 命中 DEFAULT_ZCODE_ENDPOINT_ORIGIN 仍算 production。
  if (origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    // 归为 production 勾选。
    return "production";
  }
  // 命中 TEST_ZCODE_ENDPOINT_ORIGIN 归为 test。
  if (origin === TEST_ZCODE_ENDPOINT_ORIGIN) {
    // 返回 test 勾选项。
    return "test";
  }
  // 其余 origin 一律 custom。
  return "custom";
}

// 端点切换后挂起所有远控连接：它们持有旧端点派生的 relay URL，继续使用会连错环境。
async function handleZCodeEndpointChanged() {
  // 端点切换后先 rebuildMenu，勾选态立刻更新。
  rebuildMenu();
  // 逐个应用窗口挂起远控，getApplicationWindowsExcludingCuaIndicator 不给指示窗。
  for (const win of getApplicationWindowsExcludingCuaIndicator()) {
    // suspend 带 endpoint-changed 原因，便于连接侧排查。
    await webRemoteControlManagerRef.current?.suspend(win.id, "endpoint-changed");
  }
}

/** 快捷键设置页录制态（renderer 经 SetShortcutRecordingActive 同步）；true 时菜单摘除可配置 accelerator。 */
let shortcutRecordingActive = false;
/** 发起录制的 webContents id；窗口关闭/崩溃时 renderer 不会发复位 IPC，main 侧据此收口。 */
let shortcutRecordingOwnerWebContentsId: number | null = null;

// 录制态切换必须重建菜单：accelerator 的摘除/恢复只能在菜单层完成（macOS 系统菜单先吃键）。
// renderer 的 preventDefault 拦不住系统菜单，因此必须由 main 主动摘除 accelerator。
// owner 只在进入录制时记录：退出时清空，避免误复位其它窗口的录制态。
// owner 只在 active 时记录，退出录制时一并清空。
function setShortcutRecordingActive(active: boolean, ownerWebContentsId: number | null = null) {
  // 进入录制才记录 owner，退出时不覆盖。
  if (active) {
    // 写入 shortcutRecordingOwnerWebContentsId 作为收口依据。
    shortcutRecordingOwnerWebContentsId = ownerWebContentsId;
  }
  // 状态未变直接返回，避免重复 rebuildMenu。
  if (shortcutRecordingActive === active) {
    // 幂等，return 不重建菜单。
    return;
  }
  // 落到 shortcutRecordingActive 全局标志。
  shortcutRecordingActive = active;
  // 退出录制时清 owner。
  if (!active) {
    // owner 置 null，下一个录制窗口重新登记。
    shortcutRecordingOwnerWebContentsId = null;
  }
  // 无论进出都 rebuildMenu，摘除或恢复 accelerator。
  rebuildMenu();
}

/**
 * 录制态是跨进程的临时全局状态，收口不能依赖 renderer 合作——录制中关窗
 * 或渲染进程崩溃时 React cleanup 与复位 IPC 都不会执行，标志会永久为 true，之后所有
 * rebuildMenu（切语言/zoom/设置同步）都建出无 accelerator 的菜单且波及全部窗口。
 * 在既有窗口销毁清理里按发起 webContents 复位。
 */
// 按 owner 复位录制态：窗口关闭或渲染进程崩溃时 renderer 不会发复位 IPC，
// 不收口会让菜单永久缺失 accelerator，并波及所有窗口。
function resetShortcutRecordingForWebContents(webContentsId: number) {
  // 非录制态或 owner 不匹配就跳过，避免误复位别的窗口。
  if (!shortcutRecordingActive || shortcutRecordingOwnerWebContentsId !== webContentsId) {
    // 直接 return，不动全局标志。
    return;
  }
  // 命中 owner 才清 shortcutRecordingOwnerWebContentsId。
  shortcutRecordingOwnerWebContentsId = null;
  // 同时把 shortcutRecordingActive 复位为 false。
  shortcutRecordingActive = false;
  // 复位后 rebuildMenu 恢复 accelerator。
  rebuildMenu();
}

// rebuildMenu 的应用菜单是异步的（要 await 设置与 zcodeEndpointSelection），但托盘菜单在 updateWindowsDesktopTrayMenu 里同步更新。
// 两次快速 rebuildMenu 的 Promise 可能乱序，最终以最后一次读到的 settings 为准。
function rebuildMenu() {
  // 并行取 resolveZCodeEndpointSelection 与 settings，避免串行等待。
  void Promise.all([resolveZCodeEndpointSelection(), mainSettingService.get()]).then(
    ([zcodeEndpointSelection, settings]) => {
      // rebuildApplicationMenu 是真正的菜单构建入口。
      rebuildApplicationMenu({
        // 语言用 currentApplicationLocale，与确认框口径一致。
        currentApplicationLocale,
        zcodeEndpointSelection,
        // 命令回调指向 executeDesktopCommandForApp。
        executeDesktopCommand: executeDesktopCommandForApp,
        // 缩放值由 resolveFocusedDesktopZoomLevel 现取。
        currentZoomLevel: resolveFocusedDesktopZoomLevel(),
        // 菜单 accelerator 跟随用户快捷键设置（shortcutBindings 用户覆盖）
        shortcutBindings: settings.shortcutBindings,
        // 快捷键录制态：摘掉可配置 accelerator，防止录制 menu 通道命令时按键直接触发原命令
        // （macOS 系统菜单先于 renderer 吃掉按键，renderer 侧 preventDefault 拦不住）。
        disableShortcutAccelerators: shortcutRecordingActive,
      });
    },
  );
  // 托盘菜单不依赖应用菜单构建结果，独立刷新。
  updateWindowsDesktopTrayMenu();
}

// resolveFocusedDesktopZoomLevel 按 BrowserWindow.getFocusedWindow() 读取；没有聚焦窗口时返回 0，菜单显示默认值。
function resolveFocusedDesktopZoomLevel(): number {
  // focusedWindow 取自 BrowserWindow.getFocusedWindow。
  const focusedWindow = BrowserWindow.getFocusedWindow();
  // 没有 focusedWindow 或已销毁时按默认缩放处理。
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    // return 0，菜单显示默认值。
    return 0;
  }
  // 由 resolveDesktopZoomLevelFromFactor 把 factor 转成档位。
  return resolveDesktopZoomLevelFromFactor(focusedWindow.webContents.getZoomFactor());
}

// “应用窗口”必须排除 CUA 指示窗：它不是用户会话窗口，参与枚举会污染关闭判定。
// getApplicationWindowsExcludingCuaIndicator 是所有窗口枚举的唯一入口，关闭确认、菜单与语言广播都基于它，所以新增枚举不要再直接调 BrowserWindow.getAllWindows()。
// 直接使用 BrowserWindow.getAllWindows() 会把指示窗算成最后一个窗口，导致永不退出。
function getApplicationWindowsExcludingCuaIndicator(): BrowserWindow[] {
  // 起点是 BrowserWindow.getAllWindows，再过滤掉已销毁与 CUA 指示窗。
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !windowsCuaOperationIndicator.ownsWindow(win),
  );
}

// getMainApplicationWindows 在应用窗口集合上再排除 updateStatusWindow：后者是附属窗口，不算“主界面”。
function getMainApplicationWindows(): BrowserWindow[] {
  // 在应用窗口集合上再排除 updateStatusWindow，它不算主界面。
  return getApplicationWindowsExcludingCuaIndicator().filter((win) => win !== updateStatusWindow);
}

// isUpdateStatusWindowCloseLocked 只在 kind 为 download-progress 或 update-downloaded 时禁止关闭更新窗口：此时它承担安装进度反馈。
function isUpdateStatusWindowCloseLocked(state: UpdateStatePayload) {
  // 只有这两个 kind 承担安装进度反馈，此时禁止关闭。
  return state.kind === "download-progress" || state.kind === "update-downloaded";
}

// 关闭策略同时设置 closable 与 minimizable：用户仍可最小化，但不能误关。
// forceQuit 时放开限制，否则退出流程会被自己的窗口拦住。
function syncUpdateStatusWindowClosePolicy(win: BrowserWindow) {
  // 已销毁窗口不能再调 setClosable。
  if (win.isDestroyed()) {
    // 直接 return，跳过后续窗口 API 调用。
    return;
  }
  // 锁状态每次都从 getAutoUpdaterState 现取，不缓存。
  const closeLocked = isUpdateStatusWindowCloseLocked(getAutoUpdaterState());
  // forceQuit 时放开 closable，否则退出会被自己的窗口拦住。
  win.setClosable(!closeLocked || forceQuitRef.current);
  // 始终允许 setMinimizable，用户仍可收起窗口。
  win.setMinimizable(true);
}

// macOS 红绿灯位置需要在每次布局后重写：hidden titlebar 会沿用默认坐标。
function syncUpdateStatusWindowChrome(win: BrowserWindow) {
  // 红绿灯只在 darwin 存在，其它平台直接跳过。
  if (win.isDestroyed() || process.platform !== "darwin") {
    // 早退 return，避免调用仅 darwin 支持的 API。
    return;
  }
  // 独立更新窗口的红绿灯位置不能只依赖 BrowserWindow 构造参数。
  // macOS 在窗口 show / resize 后可能继续沿用 hidden titlebar 的默认坐标，
  // 因此每次同步布局时都显式写入更靠上的按钮位置。
  win.setWindowButtonPosition(UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION);
}

// 三档高度按状态收敛：download-progress 用 PROGRESS_HEIGHT（含进度条），
// update-downloaded 用 READY_HEIGHT（去掉进度条），其余状态用 COMPACT_HEIGHT。
// 实际顺序是 PROGRESS > COMPACT > READY，不要按“下载中 > 已下载 > 普通”的直觉去改。
function resolveUpdateStatusWindowHeight(state: UpdateStatePayload) {
  // downloading 下载态最高，要容纳进度条。
  if (state.kind === "download-progress") {
    // PROGRESS_HEIGHT 是三者中的最大值。
    return UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT;
  }
  // downloaded 已下载态最矮，进度条已经消失。
  if (state.kind === "update-downloaded") {
    // READY_HEIGHT 小于 COMPACT_HEIGHT，不要按直觉排。
    return UPDATE_STATUS_WINDOW_READY_HEIGHT;
  }
  // 其余状态用紧凑高度 COMPACT_HEIGHT。
  return UPDATE_STATUS_WINDOW_COMPACT_HEIGHT;
}

// Linux 用 contentSize（系统标题栏占外框），其它平台用外框尺寸。
function shouldUseUpdateStatusWindowContentSize(): boolean {
  // 只有 linux 需要 contentSize，系统标题栏占外框。
  return process.platform === "linux";
}

// 先夹 min/max 再 setSize：非 resizable 窗口在 macOS 上会忽略单纯的 setSize。
function syncUpdateStatusWindowLayout(win: BrowserWindow) {
  // 销毁后所有 setSize 都会抛错。
  if (win.isDestroyed()) {
    // 早退 return。
    return;
  }
  // 同一轮 syncUpdateStatusWindowLayout 只取一次 state，避免条件与高度不一致。
  const state = getAutoUpdaterState();
  // 高度由 resolveUpdateStatusWindowHeight 按 kind 收敛。
  const height = resolveUpdateStatusWindowHeight(state);
  // 取尺寸前先判断口径：contentSize 还是外框。
  const bounds = shouldUseUpdateStatusWindowContentSize()
    // Linux 用 getContentBounds 比对。
    ? win.getContentBounds()
    // 其它平台用 getBounds 比对。
    : win.getBounds();
  // 只有非 Linux 才夹 min/max，Linux 不设这两项。
  if (!shouldUseUpdateStatusWindowContentSize()) {
    // 下限锁到当前 height，防止窗口管理器压矮。
    win.setMinimumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    // 上限同样锁死，非 resizable 下两者必须一致。
    win.setMaximumSize(UPDATE_STATUS_WINDOW_WIDTH, height);
  }
  // 尺寸已一致就不重复 setSize，省一次窗口管理器往返。
  if (bounds.width !== UPDATE_STATUS_WINDOW_WIDTH || bounds.height !== height) {
    // 独立更新窗口复用页内 Dialog 的 240px 高度后，普通状态只有两行内容，
    // footer 会吃掉剩余网格行形成大块空白；按状态收紧窗口高度，让内容贴合实际密度。
    // 取消下载会从 download-progress 回到 update-available；这里同步 min/max 再 setSize，
    // 避免 macOS 在非 resizable BrowserWindow 上沿用下载态高度，导致弹窗没有收回。
    if (shouldUseUpdateStatusWindowContentSize()) {
      // Linux 的系统标题栏会占用 BrowserWindow 外框高度。
      // 如果继续用 setSize 锁外框，WebContents 实际高度会少一截，底部按钮被裁掉。
      win.setContentSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    } else {
      // Windows 与 macOS 用外框尺寸 setSize。
      win.setSize(UPDATE_STATUS_WINDOW_WIDTH, height);
    }
  }
  // bounds 变化后调 syncUpdateStatusWindowChrome 重写红绿灯。
  syncUpdateStatusWindowChrome(win);
}

// openUpdateStatusWindow 维护 updateStatusWindow 单例：已存在时只 restore/show/focus 并重新同步状态，不重复创建监听器。
// 重复创建会叠加 onAutoUpdaterStateChanged 监听，状态变化时触发多次布局同步。
// closed 时解绑并置空，保证下一次打开拿到干净实例。
function openUpdateStatusWindow() {
  // updateStatusWindow 已存在就复用，不重复建窗口与监听。
  if (updateStatusWindow && !updateStatusWindow.isDestroyed()) {
    // isMinimized 为真先 restore 再显示。
    if (updateStatusWindow.isMinimized()) {
      // restore 恢复窗口状态。
      updateStatusWindow.restore();
    }
    // show 让窗口重新可见。
    updateStatusWindow.show();
    // focus 抢占前台。
    updateStatusWindow.focus();
    // 复用路径也要调 syncAutoUpdaterStateToWindow，窗口可能停在旧内容。
    syncAutoUpdaterStateToWindow(updateStatusWindow);
    // 同步 ready update，决定安装按钮可见性。
    syncReadyUpdateToWindow(updateStatusWindow);
    // 同步 release notes，依赖前一步拿到的版本号。
    syncPostUpdateReleaseNotesToWindow(updateStatusWindow);
    // 关闭策略按最新 kind 重算。
    syncUpdateStatusWindowClosePolicy(updateStatusWindow);
    // 布局按 resolveUpdateStatusWindowHeight 的新高度重算。
    syncUpdateStatusWindowLayout(updateStatusWindow);
    // 复用完成即 return，不走下面的创建分支。
    return;
  }

  // 父窗口只用于初始定位：不设 modal，更新窗口不应阻塞主界面操作。
  const parentWindow =
    getMainApplicationWindows().find((candidate) => candidate.isFocused()) ??
    // 没有 getFocusedWindow 时退到第一个主窗口。
    getMainApplicationWindows()[0] ??
    // 一个窗口都没有则传 undefined，走无父窗定位。
    undefined;
  // 构造参数与后续 setResizable 双保险：不同平台对标题栏控件默认能力不一致。
  // Linux 使用 contentSize，Windows/macOS 使用外框尺寸；这会影响高度计算的分支。
  // syncUpdateStatusWindowClosePolicy 的锁定只约束 download-progress 与 update-downloaded，普通状态允许用户关闭。
  const win = new BrowserWindow({
    // WINDOW_WIDTH 固定，不随 kind 变化。
    width: UPDATE_STATUS_WINDOW_WIDTH,
    // 初始高度按当前状态算，构造后还会再 sync 一次。
    height: resolveUpdateStatusWindowHeight(getAutoUpdaterState()),
    // Linux 上 useContentSize 为真，高度语义是内容高。
    useContentSize: shouldUseUpdateStatusWindowContentSize(),
    // 非 Linux 用 min/max 把高度夹在 READY..PROGRESS 区间：上限必须留到下载态，
    // 否则 setSize 切到 PROGRESS 会被窗口管理器截断；Linux 走 contentSize，不设这两项。
    ...(shouldUseUpdateStatusWindowContentSize()
      // Linux 分支不传 min/max，交给 contentSize 约束。
      ? {}
      // 非 Linux 分支显式给 min/max。
      : {
          // minWidth 等于固定 WINDOW_WIDTH。
          minWidth: UPDATE_STATUS_WINDOW_WIDTH,
          // 下限取 READY_HEIGHT，它是三者最小。
          minHeight: UPDATE_STATUS_WINDOW_READY_HEIGHT,
          // maxWidth 同样锁到 WINDOW_WIDTH。
          maxWidth: UPDATE_STATUS_WINDOW_WIDTH,
          // 上限必须留到 PROGRESS_HEIGHT，否则下载态被截断。
          maxHeight: UPDATE_STATUS_WINDOW_PROGRESS_HEIGHT,
        }),
    // resizable 关掉，用户不能拖拽改尺寸。
    resizable: false,
    // minimizable 开，与 setMinimizable 双保险。
    minimizable: true,
    // maximizable 关，宽度是固定的。
    maximizable: false,
    // fullscreenable 关，状态页没有全屏语义。
    fullscreenable: false,
    // 构造时先隐藏，等 dom-ready 再显示。
    show: false,
    // 更新状态已经从页内 Dialog 改成独立 BrowserWindow。
    // 独立窗口应保留系统窗口控件，不能沿用页内弹窗时期的无边框透明窗口配置。
    frame: true,
    // 平台标题栏差异必须显式声明：macOS 隐藏标题栏但保留红绿灯坐标，
    // Windows 用 titleBarOverlay 交给系统绘制窗口按钮；Linux 不加覆盖项，沿用系统默认边框。
    ...(process.platform === "darwin"
      // darwin 分支：隐藏标题栏但保留红绿灯坐标。
      ? {
          // hidden 让内容顶到窗口边。
          titleBarStyle: "hidden" as const,
          // 显式给红绿灯坐标，只靠构造参数在 show 后会被重置。
          trafficLightPosition: UPDATE_STATUS_WINDOW_TRAFFIC_LIGHT_POSITION,
        }
      // win32 分支走 titleBarOverlay。
      : process.platform === "win32"
        // Windows 覆盖层分支。
        ? {
            // titleBarStyle 同样设为 hidden，隐藏原生标题栏。
            titleBarStyle: "hidden" as const,
            // 覆盖层交给系统绘制 minimize 与 close 按钮。
            titleBarOverlay: true,
          }
        // Linux 不传覆盖项，沿用系统默认边框。
        : {}),
    // transparent 关掉：独立窗口不再复用页内弹窗时期的透明配置。
    transparent: false,
    // backgroundColor 用白底，避免加载期闪黑。
    backgroundColor: "#ffffff",
    // title 留空，由 renderer 侧文案决定。
    title: "",
    // icon 与主窗口同源。
    icon: iconPath,
    // parent 只影响初始定位，不建立模态关系。
    parent: parentWindow,
    // 不设 modal，更新窗口不阻塞主界面。
    modal: false,
    // autoHideMenuBar 为真，状态页没有菜单项。
    autoHideMenuBar: true,
    // 更新窗口按最小权限面配置：contextIsolation:true 与 nodeIntegration:false 保证渲染代码
    // 拿不到 require/process，webviewTag:false 阻止它再嵌一层 webview 绕过 GuestManager。
    // preload 与主窗口共用同一入口，因此这三项必须显式钉死，不能依赖 BrowserWindow 默认值。
    // additionalArguments 只透出 deviceMid 供遥测关联，凭据与端点仍留在 main 进程。
    webPreferences: {
      // preload 与主窗口共用同一入口。
      preload: preloadPath,
      // contextIsolation 必须为真，渲染代码才拿不到 require。
      contextIsolation: true,
      // nodeIntegration 关掉，渲染层没有 process。
      nodeIntegration: false,
      // webviewTag 关掉，禁止绕过 GuestManager 再嵌一层。
      webviewTag: false,
      // 只透出 deviceMid 供遥测关联，凭据仍留在 main。
      additionalArguments: [`--device-id=${deviceMid}`],
    },
  });
  // 更新窗口要保留系统窗口控件，但不能允许缩放或全屏。
  // 构造参数之外再显式锁定一次，避免不同平台对标题栏控件能力的默认处理不一致。
  win.setResizable(false);
  // 构造后再锁一次 minimizable，各平台默认不一致。
  win.setMinimizable(true);
  // 再锁 maximizable 为 false。
  win.setMaximizable(false);
  // 再锁 fullscreenable 为 false。
  win.setFullScreenable(false);
  // darwin 需要构造后立刻写红绿灯坐标。
  if (process.platform === "darwin") {
    // 首次同步 chrome，后续布局时还会再调。
    syncUpdateStatusWindowChrome(win);
  }
  // 建窗即调 syncUpdateStatusWindowClosePolicy，按当前 kind 设策略。
  syncUpdateStatusWindowClosePolicy(win);
  // 建窗即调 syncUpdateStatusWindowLayout，避免首帧高度跳变。
  syncUpdateStatusWindowLayout(win);

  // 先赋全局引用再挂监听：监听回调里会读 updateStatusWindow === win 做自校验。
  updateStatusWindow = win;
  // 状态变化只同步关闭策略与布局，不做内容渲染（内容由 renderer 订阅）。
  const disposeAutoUpdaterStateListener = onAutoUpdaterStateChanged(() => {
    // kind 变化时只调 syncUpdateStatusWindowClosePolicy。
    syncUpdateStatusWindowClosePolicy(win);
    // 同时同步布局，二者都依赖 kind。
    syncUpdateStatusWindowLayout(win);
  });
  // 显示流程：居中 → 重写红绿灯 → show → moveTop/focus；
  // showUpdateStatusWindow 先 setAlwaysOnTop(true, "floating") 250ms 再复位，所以能压过其它窗口的抢焦点。
  const showUpdateStatusWindow = () => {
    // show 前判活，定时器可能晚于关闭。
    if (win.isDestroyed()) {
      // 早退 return。
      return;
    }
    // 已可见就跳过 center 与 show，避免重复动画。
    if (!win.isVisible()) {
      // 先 center 再 show，顺序不能反。
      win.center();
      // show 前重写红绿灯坐标。
      syncUpdateStatusWindowChrome(win);
      // show 触发可见性变化。
      win.show();
      // show 后再写一次，macOS 会重置坐标。
      syncUpdateStatusWindowChrome(win);
    }
    // moveTop 只调层级不抢焦点，放在 focus 前避免被系统压回。
    win.moveTop();
    // 随后 focus，更新窗口必须抢占前台让用户看到进度。
    win.focus();
    // 临时置顶：floating 层级不盖系统弹窗，只压普通窗口。
    win.setAlwaysOnTop(true, "floating");
    // setTimeout 250ms 后撤销置顶，避免长期悬浮挡住用户操作。
    setTimeout(() => {
      // setTimeout 回调前窗口可能已关闭，必须先 isDestroyed 判活。
      if (!win.isDestroyed()) {
        // 撤销 alwaysOnTop，恢复普通窗口层级。
        win.setAlwaysOnTop(false);
      }
    }, 250);
    // 打印 visible 与 focused 状态，更新窗口显示异常时靠这行复现。
    logger.info(
      `[auto-update] update status window shown visible=${win.isVisible()} focused=${win.isFocused()} bounds=${JSON.stringify(win.getBounds())}`,
    );
  };
  // dom-ready 与 ready-to-show 双通道显示：开发态/部分 macOS 路径可能不触发后者。
  win.webContents.on("dom-ready", () => {
    // dom-ready 是显示时机的地面真值，出现即说明 loading 已过。
    logger.info("[auto-update] update status window dom-ready");
    // 先 syncAutoUpdaterStateToWindow，窗口首帧就带着真实进度。
    syncAutoUpdaterStateToWindow(win);
    // 再 syncReadyUpdateToWindow，决定是否显示立即安装按钮。
    syncReadyUpdateToWindow(win);
    // 最后 syncPostUpdateReleaseNotesToWindow，它依赖前两者确定的版本号。
    syncPostUpdateReleaseNotesToWindow(win);
    // 更新窗口在开发态或部分 macOS 渲染路径下不一定稳定触发 ready-to-show。
    // 加载完成后也尝试显示，避免窗口已加载却保持隐藏，让更新入口看起来无响应。
    setTimeout(showUpdateStatusWindow, 0);
  });
  // ready-to-show 只触发一次，用 once 避免重复 show。
  win.once("ready-to-show", () => {
    // ready-to-show 与 dom-ready 双通道，谁先到谁显示，重复 show 无害。
    showUpdateStatusWindow();
  });
  // close 事件兜底拦截：setClosable(false) 只影响系统控件，快捷键/程序化 close 仍会到这里。
  win.on("close", (event) => {
    // forceQuit 为假且未锁定时放行，交给默认关闭逻辑。
    if (forceQuitRef.current || !isUpdateStatusWindowCloseLocked(getAutoUpdaterState())) {
      // 直接 return，不 preventDefault 让窗口正常关闭。
      return;
    }
    // 下载开始后更新窗口承担安装状态反馈，用户仍可最小化，但不能误关闭窗口。
    // close 事件兜底拦截 native close / 快捷键路径，setClosable(false) 只负责系统控件状态。
    event.preventDefault();
    // isMinimized 时先 restore，否则提示不可见。
    if (win.isMinimized()) {
      // restore 恢复窗口，再由 show 保证可见。
      win.restore();
    }
    // show 确保窗口在前台可见。
    win.show();
    // focus 让用户立刻看到正在安装状态。
    win.focus();
  });
  // closed 必须解绑监听并清空全局引用，否则下次打开会叠加监听。
  win.on("closed", () => {
    // 解绑 updater 状态监听，避免下次打开叠加回调。
    disposeAutoUpdaterStateListener();
    // 只有 updateStatusWindow 仍是这个 win 才清零，防止误清后续新窗口。
    if (updateStatusWindow === win) {
      // 清引用后 isUpdateStatusWindowOpen 才能返回 false。
      updateStatusWindow = null;
    }
  });

  // 更新窗口不恢复会话、不支持设置：它是一个专用状态页。
  loadWindow(win, "index", {
    // restoreSession 置 false：更新窗口是专用状态页。
    restoreSession: false,
    // supportsSettings 置 false，避免用户在这里改到与更新相关的配置。
    supportsSettings: false,
    // windowKind 决定 renderer 路由到更新页面。
    windowKind: "update-status",
    // locale 取当前快照，更新说明按同一语言渲染。
    locale: currentApplicationLocale,
  });
}

// [资源] 创建一个完整窗口实例：取一份运行时环境准备 → 构造 BrowserWindow → 注入所有能力。
// 这里是窗口与 Host 生命周期绑定的起点：spawnHostProcess/disposeHostProcess 成对注入。
// 所有回调都接收 win，避免闭包捕获到错误的窗口。
// 任何新增的窗口级资源都必须同时提供 disposed 路径，且挂到 window closed 上。
function createWindowInstance(startupBootstrap: StartupWindowBootstrap = {}) {
  // createWindowInstance 每窗口取一份 takeRuntimeProcessEnvPreparation()：首窗复用进程启动时的预暖，后续窗口各自采集。
  const runtimeProcessEnvPreparation = takeRuntimeProcessEnvPreparation();
  // 关闭请求交给 lifecycle：它统一处理“隐藏到托盘 / 确认退出 / 真关闭”三种结果。
  const win = createWindow({
    // iconPath 与主窗口同源，任务栏图标保持一致。
    iconPath,
    preloadPath,
    logger,
    forceQuitRef,
    // closeToTraySupported 同时要求平台能力与托盘实例，缺一按不可用处理。
    handleBeforeClose: (win, label) =>
      // 关窗决策交给 lifecycle，main 不在此处判断托盘或确认。
      handleDesktopWindowCloseRequest({
        // platform 决定隐藏到托盘还是走确认退出。
        platform: process.platform,
        // forceQuit 为真时跳过一切拦截直接关闭。
        forceQuit: forceQuitRef.current,
        // explicitQuitRequested 为真时不再弹确认，避免二次打扰。
        explicitQuitRequested: explicitQuitRef.current,
        // 用户设置项直接传入，lifecycle 不读全局变量。
        closeToTray: closeToTrayOnWindows,
        // 空缓存按不可用处理：隐藏前兜底确认托盘真的可渲染，防 GNOME 静默失败失联。
        // CR-01：DBus 探测 ∧ Tray 实例创建成功才可隐藏；任一不满足按不可用走确认退出。
        closeToTraySupported: resolveCloseToTraySupported({
          // 能力判定同样按 platform 分支。
          platform: process.platform,
          desktopTrayReady,
          // DBus 探测结果按同步缓存读，close 路径不能 await。
          capabilitySupported: closeToTrayCapabilityMonitor.getSync()?.supported,
        }),
        // getMainApplicationWindows 只统计主窗口，更新窗口不影响该判断。
        isLastWindow: getMainApplicationWindows().length === 1,
        label,
        logger,
        // 是否弹确认由 shouldConfirmAppQuit 决定，窗口层不自行判断。
        shouldConfirmQuit: shouldConfirmAppQuit(),
        // 传入 win 作父窗口，确认框才会挂在这个窗口上。
        confirmQuit: () => confirmAppQuit(win),
        // 关闭即退出：先标记强制退出再 quit，避免再入确认。
        requestQuit: () => {
          // label 带上来源，退出原因在日志里可区分关窗与其他路径。
          markForceQuit(`last-window-close:${label}`);
          // 标记后 quit，before-quit 会读到 forceQuit 直接放行。
          app.quit();
        },
        // 隐藏到托盘：窗口不销毁，Host 与会话都保留。
        hideWindow: () => win.hide(),
      }),
    // 传入共享 map：Host 的创建/销毁由 spawnHostProcess 维护，窗口只读引用。
    windowHostProcessMap,
    // Host 就绪后刷新 PiP 焦点路由，窗口身份此时才确定。
    onHostProcessReady: (windowKey) => cuaPipFocusRouter.refreshWindow(windowKey),
    awaitFirstHostSpawnDecision,
    // 首个 Host fork 前等待灰度裁决（有界）；这是唯一会让窗口创建变慢的旁路。
    spawnHostProcess: (win, label, initMessage) =>
      // 注入 spawnHostProcess 而非直接 fork，窗口不关心 Host 启动细节。
      spawnHostProcess(
        win,
        label,
        {
          ...initMessage,
          // 内置 provider 配置路径由 main 解析：打包态取 process.resourcesPath、开发态取 appPath 相对路径，
          // Host 拿不到这套布局，自行拼路径会在打包后指向不存在的文件。
          zcodeBuiltinProviderConfigFilePath: resolveZCodeBuiltinProviderConfigFilePath(),
        },
        {
          // Host 环境变量与本进程共用一份，PATH 与代理配置才能一致。
          hostProcessLocalEnv,
          // 传函数而非布尔：设置变更后 Host 侧的取值要跟着变。
          desktopContextPromptEnabled: resolveDesktopContextPromptEnabledForHost,
          logger,
          broadcastHub,
          taskRealtimeBus,
          windowHostProcessMap,
          hostRunningTaskCountMap,
          // CUA 指示窗状态由 Host 上报，main 只做转发；source 退出时同步清除，避免指示器常驻。
          onCuaOperationStateChanged: (source, event) =>
            // CUA 状态按 source 分发，多窗口并发时互不覆盖。
            windowsCuaOperationIndicator.handleState(source, event),
          // source 退出要主动清理，否则指示器常驻。
          onCuaOperationStateSourceExited: (source) =>
            // clearSource 只清该来源的状态，不影响其它 source。
            windowsCuaOperationIndicator.clearSource(source),
          // agent 进程的五个生命周期事件各自上报 ARMS：失败在包装函数内部吞掉，不阻塞 Host 消息循环。
          onAgentProcessExited: (event) => reportAgentProcessExitToArms(event, logger),
          // onAgentProcessError 单独上报：拉起失败和异常退出的归因不同。
          onAgentProcessError: (event) => reportAgentProcessSpawnErrorToArms(event, logger),
          // 运行期异常走 exception 通道，带堆栈。
          onAgentProcessException: (event) => reportAgentProcessExceptionToArms(event, logger),
          // ready 是启动耗时统计的终点。
          onAgentProcessReady: (event) => reportAgentProcessReadyToArms(event, logger),
          // spawned 是启动耗时统计的起点。
          onAgentProcessSpawned: (event) => reportAgentProcessStartToArms(event, logger),
          // MCP 遥测带 runtimeSurface，主进程与会话的指标要分开看。
          onMcpTelemetry: (message) =>
            // 两个字段必须一起传，缺 runtimeSurface 会落进默认桶。
            reportMcpTelemetryToArms(message.event, message.runtimeSurface),
          // 插件与会话遥测走 appTelemetryCore 的上下文通道；catch 空实现保证上报异常不打断 Host 派发。
          onPluginTelemetry: (message) => {
            // 插件遥测吞掉异常：上报失败不能打断 Host 消息派发。
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          // onSessionCreateTelemetry 与会话本身解耦，创建失败也照样上报。
          onSessionCreateTelemetry: (message) => {
            // 同上，catch 空实现只为不断链。
            void appTelemetryCore.reportEvent(message.event).catch(() => {});
          },
          // 定时任务结果转发给 renderer，main 不汇总。
          onCronRunResult: forwardCronRunResult,
          // forwardOffPeakRunResult 同样直转，口径与定时任务一致。
          onOffPeakRunResult: forwardOffPeakRunResult,
          // Host 请求唤醒调度器，走 utility process 的消息通道。
          onCronSchedulerWakeRequested: wakeCronScheduler,
          // wakeOffPeakScheduler 独立唤醒，与 cron 调度器互不阻塞。
          onOffPeakSchedulerWakeRequested: wakeOffPeakScheduler,
          // 媒体预览授权只有这一条写入口：路径必须由 Host 显式申请，renderer 无法自行扩权。
          authorizeLocalMediaPreviewPath: localMediaPreviewPathRegistry.authorize,
          // 沙箱 host 未安装时直接抛错（fail-closed）：静默成功会让插件页面以为已注册。
          // requestId 属于 IPC 传输层，不写入注册表：把它当插件身份会污染注册表。
          registerPluginSandbox: (input) => {
            // 取一次 host 引用，后续判断与调用用同一实例。
            const host = getPluginSandboxHost();
            // fail-closed：静默成功会让插件页面以为已注册。
            if (!host) throw new Error("Plugin UI sandbox host is not installed.");
            // requestId 属于 IPC 传输层，不写进注册表。
            const { requestId: _requestId, ...registerInput } = input;
            // 注册走 host 自有入口，main 不直接改注册表。
            return host.registerFromHost(registerInput);
          },
          // browser-use：main 用 WebContentsView+CDP 执行命令（替换 T4 占位）。
          handleBrowserExecuteRequest: ({ win: browserWin, ...request }) =>
            // browser-use 命令落到 WebContentsView 上执行，main 不持有 CDP 连接。
            runBrowserCommandOnView({ win: browserWin, ...request }),
        },
        {
          // taskRealtime 段告诉窗口哪些 workspace 参与实时订阅。
          taskRealtime: {
            // 窗口的 workspace 集合取自 windowWorkspaceMap，未登记时为空数组。
            workspaceKeys: windowWorkspaceMap.get(win.id) ?? [],
            // Host 上报 id 后回写，供实时订阅按 Host 粒度更新。
            onHostId: (hostId) => {
              // 以 windowId 为键存 Host id，窗口与 Host 一一对应。
              windowTaskRealtimeHostIdMap.set(win.id, hostId);
            },
          },
        },
      ),
    // dispose 时按 label 判断是否来自关窗：关窗路径使用全局退出策略的强杀预算。
    // 非关窗调用（窗口替换、崩溃回收）必须沿用调用方传入的 forceKillDelayMs，否则所有路径的强杀延迟都会被拉长。
    disposeHostProcess: (child, label, forceKillDelayMs) =>
      // 销毁 Host 的预算由调用方决定，窗口层只透传。
      disposeHostProcess(
        child,
        label,
        disposingHostProcessTimers,
        logger,
        label.includes("window-closed")
          // 关窗路径用 activeAppShutdownPolicy 的强杀预算。
          ? activeAppShutdownPolicy.forceKillDelayMs
          // 其它路径沿用调用方 forceKillDelayMs，不拉长强杀延迟。
          : forceKillDelayMs,
      ),
    syncAutoUpdaterStateToWindow,
    syncReadyUpdateToWindow,
    syncPostUpdateReleaseNotesToWindow,
    webRemoteControlManager,
    // 销毁窗口时一并回收远程会话，避免 connection 泄漏。
    disposeRemoteWorkspaceSessionsForWindow:
      // 回收逻辑归 remoteSessionManager，main 只做绑定。
      remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow,
    // reattachRemoteWorkspaceSessionsForWindow 把原远程会话重新挂回去。
    reattachRemoteWorkspaceSessionsForWindow:
      // 挂回同样由 manager 实现，保证 attachment 一致。
      remoteSessionManager.reattachRemoteWorkspaceSessionsForWindow,
    // bootstrap 只透传字段，不做默认值合并：默认值属于协调器/启动解析。
    bootstrap: {
      // bootstrap 只透传字段，默认值由协调器合并。
      restoreSession: startupBootstrap.restoreSession,
      // 首窗目录来自 startupBootstrap，窗口不自行推导。
      initialWorkspacePath: startupBootstrap.initialWorkspacePath,
      // purpose 区分 deep link 与普通启动，影响确认文案。
      initialWorkspacePurpose: startupBootstrap.initialWorkspacePurpose,
      // 不可用目录要显式传下去，renderer 才能提示而不是白屏。
      unavailableWorkspacePath: startupBootstrap.unavailableWorkspacePath,
    },
    // agentWarmupTargets 只透传，是否预热由 Host 决定。
    agentWarmupTargets: startupBootstrap.agentWarmupTargets,
    // startupBootstrap 只标记 active workspace 是否不可用，但 local Host 会为所有
    // 已恢复 workspace 建立后台索引。始终注入 canonical fallback，才能覆盖非 active 历史目录已删除的情况。
    agentSpawnFallbackCwd: getConversationWorkspaceDir(),
    deviceMid,
    // 远端资源目录按 locale 解析：不同语言加载不同资源包。
    remoteAssets: resolveRemoteAssetDirs({ locale: currentApplicationLocale }, hostProcessLocalEnv),
    // patchPromise 让 Host 等到环境补齐后再启动 agent。
    runtimeProcessEnvPatchPromise: runtimeProcessEnvPreparation.patchPromise,
    // fallbackPatch 是 patch 失败时的兜底环境，Host 侧总能拿到一份可用快照。
    runtimeProcessEnvFallbackPatch: runtimeProcessEnvPreparation.fallbackPatch,
    // 初始缩放/窗口尺寸取 bootstrap 后的内存快照：窗口构造是同步的，不能再 await 设置服务。
    initialDesktopZoomLevel: currentDesktopZoomLevel,
    // 窗口尺寸同步取自 bootstrap 快照，窗口构造期间不能再 await 设置服务。
    initialWindowSize: currentDesktopWindowSize,
    // getter 而非值：locale 可在运行期切换，窗口要能读到最新值。
    currentApplicationLocale: () => currentApplicationLocale,
    // 按 webContents 反查 guest owner 只走 browserGuestManager 索引，main 不保存第二份 tab 映射。
    resolveBrowserViewOwner: (webContentsId) =>
      // 反查只走 manager 索引，main 不保存第二份 tab 到 webContents 的映射。
      browserGuestManager.getTabOwnerByWebContentsId(webContentsId) ?? undefined,
    // 窗口尺寸先写内存再落盘：resize 防抖期间读取到的是内存值。
    persistWindowSize: async (state) => {
      // 先写内存再落盘：resize 防抖期间读到的必须是新尺寸。
      currentDesktopWindowSize = state;
      // 落盘走 mainSettingService，main 不直接写 setting.json。
      await mainSettingService.update({ desktopWindowSize: state });
    },
  });
  // 登记进 mainWindowIds：稳定性/资源遥测据此把窗口归为 main，未登记的（如更新窗口）算 other；
  // closed 时自动移除，重复调用幂等。
  registerStabilityMainWindow(win);
  // 返回 registerStabilityMainWindow 已登记的主窗口，供调用方绑定首窗采样。
  return win;
}

// 协议注册必须在 ready 前完成；Linux 额外需要桌面集成图标。
// 注册一次即可，重复注册会被 Electron 忽略，但 Linux 的图标路径仍会被后续调用覆盖。
// 该调用不抛错：协议不可用时应用仍应启动，只是 deep link 失效。
registerDeepLinkProtocol(logger, { iconPath: linuxDesktopIntegrationIconPath });
// macOS 协议入口：必须 preventDefault，否则系统会重复投递同一条 URL。
app.on("open-url", (event, url) => {
  // 拦掉系统默认处理，否则 Electron 会再把 URL 交给其它 handler。
  event.preventDefault();
  // 先解析出 workspace 路径：非 workspace 类 deep link 不做建窗判断。
  const workspacePath = extractOpenWorkspacePathFromDeepLinkUrl(url);
  // 强制升级期间一律拒绝打开 workspace，避免绕过版本门。
  if (workspacePath && forceUpdateMainWindowCreationBlocked) {
    // 记 warn 便于事后确认这不是 deep link 丢失。
    logger.warn("[force-update] 已忽略强制升级期间的 open-url workspace 请求");
    // focusForceUpdateGateWindow 把注意力拉回提示窗，而不是静默忽略。
    focusForceUpdateGateWindow();
    // 早退 return，不再走后续建窗分支。
    return;
  }
  // macOS 冷启动 Finder Service 会先 open-url 再建首窗：记录为目标目录，
  // 首窗仍走确认 gate，不能直接创建窗口绕过确认。
  if (workspacePath && getApplicationWindowsExcludingCuaIndicator().length === 0) {
    // macOS 冷启动 Finder Service 会先触发 open-url，再创建首窗。
    // 把目标目录按 deep link 来源记录，首窗 bootstrap 前仍要走确认 gate。
    startupOpenWorkspaceRequest = { path: workspacePath, source: "deep-link" };
    // 尚未 ready 时只记录请求，首窗由 whenReady 链路创建。
    if (app.isReady()) {
      // ready 后补建主窗口，来源标记为 open-url-workspace。
      void primaryWindowCoordinator.ensurePrimaryWindow("open-url-workspace");
    }
    // 交给启动链路处理，不走下面的 deep link 直通分支。
    return;
  }
  // 已有窗口时直接交给 deep link 处理器：它负责确认、切换 workspace 与聚焦。
  handleDeepLink(url, logger, {
    // 外部目录确认文案按 locale 现取。
    confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    // resolveApplicationWindow 现取目标窗口，处理期间窗口集合可能变化。
    resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
  });
});
// 单实例锁是“只允许一个 main 进程”的唯一保证；数据目录/数据库都不支持多实例并发。
// 失败分支只允许 quit：继续初始化会与首实例争抢数据库与端口。
// additionalData 必须在加锁时传入，第二个进程才能在退出前把请求交给首实例。
// 该调用必须早于任何窗口创建与 Host fork。
// 附加数据携带 argv 中的 deep link，供次实例把请求转交给首实例。
const gotTheLock = app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv));
// 没抢到单实例锁说明已有 main 进程在跑。
if (!gotTheLock) {
  // 只允许退出：继续初始化会与首实例争抢数据库与端口。
  app.quit();
}
// 次实例请求处理：先尝试 workspace/deep link 转交；处理成功则不再聚焦旧窗口。
app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
  // 交给 secondary 处理函数：它决定转交 workspace 还是聚焦旧窗口。
  if (
    handleSecondInstanceWorkspaceRequest({
      // additionalData 携带次实例 argv 里的 deep link。
      additionalData,
      argv,
      focusForceUpdateGateWindow,
      // 把升级拦截标记传下去，次实例也不能绕开版本门。
      forceUpdateBlocked: forceUpdateMainWindowCreationBlocked,
      // 注入 logger：deep link 处理在本文件外，但日志要同一流。
      handleDeepLink: (url, options) => handleDeepLink(url, logger, options),
      // 打开目录走统一入口，main 不自己拼 BrowserWindow 调用。
      handleOpenWorkspacePath: (path, options) =>
        // 传 logger 与选项，确认文案由下游按 locale 决定。
        handleOpenWorkspacePath(path, logger, {
          // allowWithoutReadyWindow 覆盖首窗未建的情况，先记录后建。
          allowWithoutReadyWindow: true,
          ...options,
          // resolveApplicationWindow 优先用调用方给的实现。
          resolveApplicationWindow:
            // 调用方未指定时回落到默认解析。
            options?.resolveApplicationWindow ??
            // 默认取第一个非 CUA 窗口，没有则 null。
            (() => getApplicationWindowsExcludingCuaIndicator()[0] ?? null),
        }),
      // 聚焦路径同样调 getApplicationWindowsExcludingCuaIndicator 现取。
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
      logger,
      // 聚焦前若需确认，文案同样按 locale 现取。
      workspaceConfirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
    })
  ) {
    // 转交成功后直接 return，不再聚焦旧窗口抢走焦点。
    return;
  }

  // 未携带可处理请求时，仅把已有窗口拉到前台——这是双击图标的默认预期。
  const win = getApplicationWindowsExcludingCuaIndicator()[0];
  // 没有窗口就不处理，交给 whenReady 链路建首窗。
  if (win) {
    // 最小化状态先还原，否则 focus 不会把窗口带到前台。
    if (win.isMinimized()) {
      // restore 之后再 show，避免 macOS 上残留最小化动画。
      win.restore();
    }
    // 隐藏到托盘的窗口要显式 show。
    if (!win.isVisible()) {
      // show 会触发一次可见性变化，托盘状态随之同步。
      win.show();
    }
    // 最后 focus，保证窗口进入前台并获得键盘焦点。
    win.focus();
  }
});

// [生命周期] ready 之后按固定顺序初始化：安全 → 沙箱 → 数据目录 → 平台集成 →
// 策略 → 更新 → IPC → 遥测 → 升级 gate → 主窗口。任何一步失败都必须降级而非崩溃。
// 顺序不能随意调换：数据目录必须先于数据库，权限策略必须先于首个 guest attach。
// 遥测注册放在主窗口前，才能覆盖首窗启动性能；升级 gate 放在最后，避免白等网络。
app.whenReady().then(async () => {
  // 标记 launch 就绪，性能采样以这一刻为终点。
  markMainLaunchAppReady();
  // 请求安全诊断只在 main 侧安装：它需要看到所有 webRequest。
  installRequestSecurityDiagnostics(session.defaultSession.webRequest, logger);
  // 本地媒体协议依赖 ready 后的 session；授权表决定哪些路径可被 renderer 读取。
  installLocalMediaPreviewProtocol(session.defaultSession.protocol, {
    // 媒体预览白名单由 registry 判定，Host 侧不缓存授权结果。
    isPathAuthorized: localMediaPreviewPathRegistry.isAuthorized,
  });
  // 插件 UI 沙箱：注册表 + renderer 可调 IPC；scheme 的 privileged 注册已随 zcode-media 在 ready 前完成。
  installPluginSandboxHost({
    // 沙箱 preload 用相对打包目录解析，开发态与打包态路径一致。
    preloadPath: join(import.meta.dirname, "../preload/pluginSandbox.cjs"),
    // renderer 目录同上，不依赖 app.getAppPath。
    rendererDir: join(import.meta.dirname, "../renderer"),
    // aliasDir 用于把插件导入重写到宿主包。
    aliasDir: join(import.meta.dirname, "../plugin-sandbox"),
    // 开发模式 out/renderer 没有 shell 产物，从 renderer dev server 代理（同 cua-permission-panel 的做法）。
    ...(!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]
      // dev 下走 vite server，省掉每次构建。
      ? { devServerUrl: process.env["ELECTRON_RENDERER_URL"] }
      // 生产不传 devServerUrl，直接读 rendererDir。
      : {}),
    // 插件沙箱早期无 logger，用 console 兜底。
    logger: console,
    // e2e L05（配额）：只在 e2e run 里允许缩小注册表容量。
    ...(process.env.ZCODE_E2E_RUN_ID?.trim() &&
    Number.isInteger(Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES)) &&
    Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) > 0
      // E2E 下限制注册表条数，防止长跑用例把内存打满。
      ? { registryMaxEntries: Number(process.env.ZCODE_E2E_PLUGIN_SANDBOX_MAX_ENTRIES) }
      // 非 E2E 不设上限，走默认值。
      : {}),
  });
  // 内嵌浏览器的恢复引导协议装在其独立 partition 上，与默认 session 隔离。
  installBrowserRestoreBootstrapProtocol(
    session.fromPartition(EMBEDDED_BROWSER_PARTITION).protocol,
  );
  // Bootstrap: 从设置文件读取自定义数据目录，在所有 host 进程启动前生效
  // bootstrap 设置必须在任何 Host 创建前生效：dataBaseDir/locale/托盘/缩放都从这里来。
  // 读取失败只降级为默认值，绝不能让启动中断——设置文件损坏时用户仍应能打开应用。
  // 托盘迁移的写盘要先 await，保证设置页读到的是迁移后的值。
  // 语言只有在用户未显式设置时才跟随系统，避免覆盖用户选择。
  let loadedBootstrapLocale = false;
  // bootstrapSettings 先置空：读盘失败时要能区分没读到与读到空。
  let bootstrapSettings: AppSettings | undefined;
  // 读取失败不阻断启动：使用默认路径与默认语言，后续设置页仍可修正。
  try {
    // 启动配置是后续所有默认值的来源，必须最先读。
    bootstrapSettings = await mainSettingService.get();
    // 只有 dataBaseDir 显式配置过才覆盖默认根。
    if (bootstrapSettings.dataBaseDir) {
      // 覆盖必须在打开数据库前生效，否则会建到默认目录。
      setDataBaseDir(bootstrapSettings.dataBaseDir);
    }
    // 有显式 locale 就不再回落到系统语言。
    if (bootstrapSettings.locale) {
      // 置 loadedBootstrapLocale，供后面判断是否再取系统语言。
      loadedBootstrapLocale = true;
      // 写入 currentApplicationLocale 快照，后续同步读取立即生效。
      currentApplicationLocale = bootstrapSettings.locale;
    }
    // Linux 默认值归位迁移（spec：docs/desktop/linux-close-to-tray.md）：shared 迁移无平台
    // 概念、曾把存量 Linux 用户归为 true，但 Linux 此前无设置入口，存量 true 非用户显式
    // 选择；首次启动强制归位为默认关并落标记，之后尊重用户选择。
    // Linux 托盘默认值迁移只做一次：迁移标记落盘后不再覆盖用户选择。
    const closeToTrayBootstrap = resolveCloseToTrayBootstrapValue({
      // 关窗行为按平台分支：Windows 可隐藏到托盘，Linux 需探测桌面环境。
      platform: process.platform,
      // stored 是用户上次的选择，未设置时为 undefined。
      stored: bootstrapSettings.closeToTrayOnWindows,
      // closeToTrayLinuxMigrationInitialized 只生效一次，避免每次启动改写默认值。
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
    });
    // CR-02：必须 await 持久化完成再继续启动，renderer 设置页才不会读到文件旧值。
    // 写失败时不阻断启动，但内存值回退为文件当前值（resolveCloseToTrayRuntimeValue）：
    // 持久层不可写时维持"文件是唯一可信来源"，避免 main 按 false、设置页显示 true 的
    // 双数据源；迁移在下次启动重试，失败期间保持迁移未完成的旧行为。
    // 迁移写盘失败时内存值回退为文件值：避免 main 与设置页出现两个数据源。
    let closeToTrayMigrationPersisted = true;
    // 只有首次在 Linux 上启动才需要落默认值。
    if (closeToTrayBootstrap.needsLinuxMigration) {
      try {
        // 用 mainSettingService.update 持久化迁移结果，下次启动不再重复。
        await mainSettingService.update({
          // Linux 默认不隐藏到托盘，避免窗口消失后无处找回。
          closeToTrayOnWindows: false,
          // 置 closeToTrayLinuxMigrationInitialized 完成标记。
          closeToTrayLinuxMigrationInitialized: true,
        });
      } catch (error) {
        // 落盘失败要回落为未持久化，让下次启动重试。
        closeToTrayMigrationPersisted = false;
        // 失败只 warn，迁移不是启动的必要条件。
        logger.warn("[settings] failed to persist linux close-to-tray default migration", error);
      }
    }
    // 运行时值与迁移结果共同决定内存态；迁移未持久化时保持旧行为，下次启动重试。
    closeToTrayOnWindows = resolveCloseToTrayRuntimeValue({
      // 同一份输入再调 resolveCloseToTraySupported 算最终能力，供托盘初始化用。
      platform: process.platform,
      // 仍读原始 stored，不复用迁移后的内存值。
      stored: bootstrapSettings.closeToTrayOnWindows,
      // 传入持久化前的标记，让解析函数自行判断是否已迁移。
      linuxMigrationInitialized: bootstrapSettings.closeToTrayLinuxMigrationInitialized,
      // persisted 决定解析结果是否可信。
      migrationPersisted: closeToTrayMigrationPersisted,
    });
    // currentDesktopZoomLevel 与 currentDesktopWindowSize 只做 clamp/snapshot，真正应用在 createWindowInstance 创建窗口时。
    keepAwakeWhileRunning = bootstrapSettings.keepAwakeWhileRunning ?? false;
    // 缩放级别必须 clamp，越界值会让窗口无法操作。
    currentDesktopZoomLevel = clampDesktopZoomLevel(bootstrapSettings.desktopZoomLevel ?? 0);
    // desktopWindowSize 取持久化值，首窗构造直接用。
    currentDesktopWindowSize = bootstrapSettings.desktopWindowSize;
    // 全局 keep-awake：启动时若设置已开，立刻持有 powerSaveBlocker，不必等设置变更事件。
    reconcileKeepAwakeBlocker();
  } catch {
    // 读取失败不影响启动，使用默认 homedir
  }

  // scheduler 也会打开 tasks-index；等 Host 完成统一准备，避免在启动页出现前抢先迁移。
  // 数据库启动失败时走显式退出：此时没有窗口可提示，只能记录并退出。
  configureDatabaseStartupQuit(() => {
    // 数据库起不来走 markExplicitQuit，避免再弹关窗确认。
    markExplicitQuit("database-startup-exit");
    // markExplicitQuit 之后再 quit，不进入正常启动链路。
    app.quit();
  });
  // 数据库就绪后再拉起调度器：它也会打开 tasks-index，提前启动会与迁移竞争。
  onLocalDatabaseStartupReady(() => {
    try {
      // 调度器是独立 utility process，崩溃不影响主进程。
      cronScheduler = spawnCronScheduler({
        // 复用 Host 的本地环境变量，调度器的 PATH 才能找到同一套工具。
        hostProcessLocalEnv,
        logger,
        // resolveDispatchHost 由主进程注入：调度器子进程不自己解析本机远端配置。
        resolveDispatchHost: resolveCronDispatchHost,
        // keep-awake 已改为纯设置驱动；计数上报保留给后续诊断/配额用途，不再联动 blocker。
        onOffPeakActiveCountChanged: () => {},
      });
    } catch (error) {
      // 拉起失败只记 error 不重试，调度器是可选能力，重试会掩盖二进制缺失。
      logger.error("[cron-scheduler] failed to spawn scheduler process:", error);
    }
  });

  // Windows AUMID 必须与 NSIS 快捷方式一致，否则任务栏/通知会把它们当成两个应用。
  // resolveWindowsAppUserModelIdForFlavor 在开发态返回独立 AUMID，避免与已安装版本互相干扰。
  if (process.platform === "win32") {
    // 打包态必须与 NSIS 快捷方式使用同一 AUMID，否则 Shell 把它们当成不同应用。
    // 使用构建期产品身份，不依赖用户机器环境；开发态继续保持独立身份。
    app.setAppUserModelId(
      resolveWindowsAppUserModelIdForFlavor(ZCODE_PRODUCT_FLAVOR, { isPackaged: app.isPackaged }),
    );
  }

  // applyAppIcon 只在 macOS 生效（app.dock.setIcon），且 app.dock 要 ready 后才可用；
  // Windows/Linux 的图标来自打包资源，这里调用不会改写任务栏图标。
  applyAppIcon(iconPath);
  // 用户未显式设置语言时才跟随系统；已设置则尊重设置。
  if (!loadedBootstrapLocale) {
    // 只有设置里没有 locale 时才回落到系统语言，已有选择不被覆盖。
    currentApplicationLocale = resolveSystemApplicationLocale();
  }
  // Electron 的 net.request 只能在 app ready 后使用；灰度请求仍是旁路预热，不阻塞首个 Host。
  // 预热曾在读取持久化语言之前启动，X-Client-Language 会带默认语言并进入 1 小时缓存；
  // 必须在 currentApplicationLocale 确定之后再启动。
  void desktopContextPromptRollout?.refresh();
  // Finder Service 与 Windows 右键菜单都是系统级持久项，需要随语言重装。
  installFinderOpenFolderWorkflow({
    // Finder 只在 darwin 安装，其余平台由 installFinderOpenFolderWorkflow 直接返回。
    platform: process.platform,
    // 使用刚确定下来的 locale，避免装出与界面不一致的菜单文案。
    locale: currentApplicationLocale,
    // homeDir 取 app.getPath，打包后 process.env.HOME 可能为空。
    homeDir: app.getPath("home"),
    logger,
  });
  // 右键菜单安装失败不影响启动：它是可选集成，失败只记日志。
  await installWindowsOpenFolderContextMenu({
    // 注册表写入按平台分支，非 Windows 直接跳过。
    platform: process.platform,
    // 菜单命令写死 execPath：dev 与打包版的启动方式不同。
    executablePath: process.execPath,
    // argv 原样带上，dev 构建需要入口脚本参数才能正确拉窗。
    argv: process.argv,
    // process.defaultApp 为真说明是 electron . 启动，路径需要转义。
    isDefaultApp: Boolean(process.defaultApp),
    // 与 Finder Service 用同一份 locale，两处菜单不能出现语言不一致。
    locale: currentApplicationLocale,
    logger,
  });
  // 网络策略失败只告警：安全加固不应让应用无法启动。
  try {
    // 传 bootstrapSettings 而非空对象：启动配置里的代理与证书策略要在首窗前生效。
    await applyDesktopChromiumNetworkPolicies(session, bootstrapSettings ?? {}, logger);
  } catch (error) {
    // 加固失败降级为 warn：策略缺失不该阻断启动。
    logger.warn("[desktop-network] Chromium network policy bootstrap failed:", error);
  }

  // 内置浏览器权限闸门（CNVD 未授权访问修复）：必须在任何 guest attach 前完成注册。
  // 弹窗桥把策略决策点接到主窗口 UI；store 落盘「访问此网站时允许/阻止」的站点同意记录。
  // 权限闸门必须在任何 guest attach 之前注册；弹窗桥负责把决策接到主窗口 UI。
  const embeddedBrowserPermissionUiBridge = createEmbeddedBrowserPermissionUiBridge({ logger });
  // resolve 监听必须在注册策略前挂上，否则首个弹窗没有消费方。
  embeddedBrowserPermissionUiBridge.registerResolveListener();
  // 注册为进程内活动桥，guest 侧权限请求按这个实例找 UI。
  setActiveEmbeddedBrowserPermissionUiBridge(embeddedBrowserPermissionUiBridge);
  // 策略安装失败只告警：最坏情况是退回 Electron 默认权限行为。
  try {
    // 只对内置浏览器的独立 partition 生效，不污染主窗口 session 的权限。
    await applyEmbeddedBrowserPermissionPolicy(session.fromPartition(EMBEDDED_BROWSER_PARTITION), {
      // logger 与主进程同流，便于把策略日志和弹窗决策对照起来看。
      logger,
      // prompt 接到主窗口弹窗桥，权限决策必须有人看见。
      prompt: embeddedBrowserPermissionUiBridge.promptPermission,
      // devicePicker 同样走弹窗桥，不能退回 Chromium 默认选择器。
      devicePicker: embeddedBrowserPermissionUiBridge.devicePicker,
      // onDisplayMediaRequest 必须经过桥，才能在 UI 侧区分窗口与整屏。
      onDisplayMediaRequest: embeddedBrowserPermissionUiBridge.onDisplayMediaRequest,
      // 站点同意记录落 userData，随应用卸载一起清理。
      store: createEmbeddedBrowserSitePermissionStore(
        join(app.getPath("userData"), "embedded-browser-site-permissions.json"),
      ),
    });
  } catch (error) {
    // 安装失败退回 Electron 默认权限：可用性优先，风险已在 CNVD 记录中标注。
    logger.warn("[embedded-browser-permission] policy bootstrap failed:", error);
  }

  // 更新后发布说明的水合必须在创建窗口前完成：窗口首帧会读取它。
  await hydratePendingPostUpdateReleaseNotes(mainSettingService);
  // 只在 Windows 打完整性诊断：它读打包产物签名，其它平台无意义。
  logWindowsBundledRuntimeIntegrityDiagnostic();

  // 启动自动更新检查（后台执行，不阻塞主界面）
  // Preview 身份无论连接哪个后端都不自动更新：stable feed 上只分发正式 ZCode 安装包，
  // 不向 Preview 渠道提供更新。构建期未启用自动更新时同样不更新
  // （见 docs/desktop/build-time-optional-capabilities.md）。
  // 自动更新只在正式版且构建期启用时初始化；Preview 不接收 stable feed。
  void initAutoUpdater({
    // 两个条件都成立才启用更新：Preview 不接收 stable feed。
    enabled: ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED,
    // 安装前先通知稳定性系统，再走退出屏障；Windows 还要额外清理资源锁。
    onBeforeQuitAndInstall: async () => {
      // 安装前先给稳定性系统打点，崩溃时才能归因到更新流程。
      notifyStabilityLifecycle("update_install");
      // 先走退出屏障回收 Host，再交给安装器覆盖文件。
      await prepareAppQuit("auto-update quitAndInstall", "update-install");
      // 顺序不可换：Host 未回收就清理文件会失败，安装器随后会覆盖失败。
      if (process.platform === "win32") {
        // Windows 释放文件锁：Host 进程未退时安装器会覆盖失败。
        await prepareWindowsProcessesForUpdateInstall();
      }
    },
    // 更新偏好从 mainSettingService 读，updater 不自己读盘。
    settingService: mainSettingService,
    // 更新提示文案跟随当前 locale，不额外再取系统语言。
    locale: currentApplicationLocale,
    deviceMid,
    // resolveEndpointOrigin 延迟解析：自定义后端要在运行时才确定。
    resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    // feed 源由启动配置决定，不能写死 stable 地址。
    updateFeedSource: resolveUpdateFeedSourceFromStartupConfig({
      // argv 可能带 --update-feed 覆盖，必须在启动时读。
      argv: process.argv,
      // 环境变量同样可以覆盖 feed，便于预发验证。
      env: process.env,
    }),
  });

  // clearRecentDocuments 清掉系统最近列表：main 不维护自己的最近文档，避免与系统菜单重复。
  if (process.platform === "darwin" || process.platform === "win32") {
    // 清系统最近列表：main 不维护自己的最近文档，避免与系统菜单重复。
    app.clearRecentDocuments();
  }

  // 菜单与 Dock 菜单在窗口创建前先建好：Dock 在 macOS 上可能先于窗口可见。
  rebuildMenu();
  // Dock 菜单在窗口创建前建好，macOS 上它可能先于窗口可见。
  configureDockMenu(
    () =>
      // 标签延迟求值，语言切换后再打开 Dock 菜单要显示新文案。
      getDesktopMenuLabelByLocale(
        currentApplicationLocale,
        desktopMenuMessageIds.dockShowCurrentWindow,
      ),
    () => showCurrentWindowFromDock(primaryWindowCoordinator),
  );
  // 托盘选项全部用 getter/回调：语言与窗口状态会变化，不能传快照。
  const desktopTrayOptions = {
    // getter 而非快照：托盘菜单会常驻，locale 变化后要重新取。
    getLocale: () => currentApplicationLocale,
    // 点托盘图标复用主窗口，走 ensurePrimaryWindow 而不新建。
    showCurrentWindow: () =>
      // 走协调器而非直接 show：它负责在窗口已销毁时重建。
      primaryWindowCoordinator.ensurePrimaryWindow("tray-show-current-window"),
    // 托盘菜单的命令与 renderer 共用同一派发实现。
    executeDesktopCommand: executeDesktopCommandForApp,
    // 托盘退出是显式退出，必须先标记再调用 app.quit。
    quitApp: () => {
      // markExplicitQuit 让关窗逻辑知道这是用户主动退出，不再弹确认。
      markExplicitQuit("tray-quit");
      // 标记完成后再 quit，保证 before-quit 读到的是显式退出。
      app.quit();
    },
    logger,
  };
  // CR-01：托盘实例是否创建成功必须成为可隐藏能力的一部分。DBus watcher 只能证明桌面
  // 可能有 host，new Tray() 仍可能因图标缺失/会话未就绪抛错；此时隐藏窗口会让用户失去
  // 唯一入口（失联）。trayReady 由创建结果置位，关窗与设置页能力查询都读它。
  // 只有 Windows 在此处同步创建托盘；Linux 需要先探测能力，macOS 由系统菜单承担。
  if (process.platform === "win32") {
    // 以创建结果置位 trayReady：new Tray 抛错时能力必须报告为不可用。
    desktopTrayReady = createDesktopTray(desktopTrayOptions) !== null;
  }

  // Linux 托盘延迟创建：无 StatusNotifierWatcher 时 new Tray 会静默失败。
  // 能力探测通过后再建，并在成功时回放未读数。
  const ensureLinuxDesktopTray = async (): Promise<void> => {
    // 非 Linux 或托盘已就绪时直接返回，避免重复建实例。
    if (process.platform !== "linux" || desktopTrayReady) {
      // 早退不报错：macOS 用系统菜单，Windows 已在上面建过。
      return;
    }
    // Linux 托盘创建跟随能力而非设置开关（spec：docs/desktop/linux-close-to-tray.md）：
    // 无 StatusNotifierWatcher 的桌面（GNOME 默认）上 new Tray() 静默失败，注册无人渲染的
    // DBus name 没有意义；能力探测通过后再创建。用户装扩展后经设置页查询也会走到这里补建。
    // 每次调用都重新探测：用户可能刚安装扩展；desktopTrayReady 保证失败后仍可重试。
    const capability = await closeToTrayCapabilityMonitor.refresh();
    // 只有探测到 StatusNotifierWatcher 才建托盘，否则 new Tray 静默失败。
    if (capability.supported) {
      // 显式传 platform linux：托盘选项要按平台分支选图标。
      desktopTrayReady = createDesktopTray({ ...desktopTrayOptions, platform: "linux" }) !== null;
      // 托盘补建成功时回放当前未读数：创建前已有的未读不能等到下一次计数变化才出现在红点上。
      if (desktopTrayReady) {
        // 补建成功后立即 syncApplicationUnreadBadge，否则要等计数变化才出现红点。
        syncApplicationUnreadBadge(windowUnreadCountMap);
      }
    }
  };
  // 启动阶段的补建失败只记日志：托盘是增强入口，不能阻断启动。
  if (process.platform === "linux") {
    // 启动期补建不 await：托盘是增强入口，失败不能阻断启动。
    void ensureLinuxDesktopTray().catch((error: unknown) => {
      // 探测失败只 warn，用户装完扩展后设置页查询会再次触发补建。
      logger.warn("[desktop-tray] linux tray capability probe failed", error);
    });
  }

  // 平台 IPC 注册：把窗口/Host/托盘/更新等能力暴露给 renderer，全部经参数注入。
  registerPlatformIpcHandlers({
    // 帮助配置直连 readHelpConfig，IPC 层不缓存。
    fetchHelpConfig: readHelpConfig,
    logger,
    // CDP-on-guest pivot：renderer `<webview>` dom-ready 上报 guest webContentsId → attach。
    // attach guest 成功后绑定对话框控制器：绑定失败不应影响 attach 结果。
    attachBrowserGuest: (key, webContentsId, options) => {
      // attach 由 manager 执行，结果原样返回给 renderer。
      const result = browserGuestManager.attachGuest(key, webContentsId, options);
      // 只有 attach 成功且带 windowId 才绑定对话框，失败时绑定无意义。
      if (result.ok && options?.windowId !== undefined) {
        // 绑定失败不影响 attach 结果：对话框是附加能力。
        embeddedBrowserDialogController.bindGuest(key, webContentsId, options.windowId);
      }
      // 回传 manager 的原始结果，IPC 层不改写 ok 或错误码。
      return result;
    },
    // 视口更新按 tabId 定位，windowId 用于校验归属。
    updateBrowserGuestViewport: (tabId, viewport, windowId) =>
      // 真正的 setBounds 在 manager 内做，main 不持有 guest 引用。
      browserGuestManager.updateViewportFromRenderer(tabId, viewport, windowId),
    // 截图表面 ready 需要同时校验发送者与 payload；协调器负责配对，main 只做转发。
    reportBrowserScreenshotSurfaceReady: (windowId, senderWebContentsId, payload) => {
      // debug 级：截图 ready 是高频事件，只在排查时打开。
      logger.debug("[browser-screenshot-surface] renderer ready", {
        // windowId 与发送者一起用于配对，防止跨窗口串台。
        windowId,
        senderWebContentsId,
        // requestId 用来和 renderer 侧的发起记录对齐。
        requestId: payload.requestId,
        // tabId 标明是哪个标签的截图表面。
        tabId: payload.tabId,
        // webContentsId 参与发送者校验，不能只信 payload。
        webContentsId: payload.webContentsId,
        // viewport 是后续 Surface 尺寸的依据。
        viewport: payload.viewport,
        // surfaceScale 影响截图清晰度，HiDPI 下不等于 1。
        surfaceScale: payload.surfaceScale,
      });
      // 配对交给协调器，main 只透传参数。
      browserScreenshotSurfaceCoordinator.handleReady({
        // 协调器按 windowId 与 senderWebContentsId 找等待中的请求。
        windowId,
        senderWebContentsId,
        payload,
      });
    },
    // 驻留相关 IPC 全部转交 manager：main 不保存标签状态，避免与 guest 侧双写。
    browserViewResidencyHandlers: {
      // detachBrowserGuest 只做换人前的解绑：key 是标签句柄，新 guest 会立刻重新 attach。
      detachBrowserGuest: (key, webContentsId, windowId) =>
        // 先解绑旧 webContents 再挂新的，否则同一 key 上残留旧监听，事件会重复投递。
        browserGuestManager.detachGuestBeforeReplacement(key, webContentsId, windowId),
      // 关标签由 renderer 发起，main 只转发 payload，标签账本仍归 manager。
      closeBrowserTab: (payload) => browserGuestManager.closeTabFromRenderer(payload),
      // 驻留状态由 guest 侧上报，main 不做推断：推断会在崩溃重启后与真实状态错位。
      reportBrowserTabResidency: (payload) => browserGuestManager.reportResidency(payload),
      // 挂起确认必须回传，manager 等这个 ack 才把标签从驻留表摘除。
      acknowledgeBrowserTabSuspend: (payload) => browserGuestManager.acknowledgeSuspend(payload),
      // ensureResident 是幂等入口：切回标签和崩溃恢复都会调用，重复请求安全。
      ensureBrowserTabResident: (payload) =>
        // 驻留判定必须落在 manager 内；main 只转发，不另立一套去重逻辑。
        browserGuestManager.ensureResidentFromRenderer(payload),
      // 会话恢复整批重建标签，顺序由 payload 携带，main 不重排。
      restoreBrowserTabs: (payload) => browserGuestManager.restoreTabs(payload),
    },
    // 语言切换要广播到 Host 与所有窗口，并重装系统集成；这是一次“准重启”级别的操作。
    // Host 侧以消息为准，不以 setting.json 为准，因为写盘可能滞后或失败。
    applyApplicationLocale: async (locale) => {
      // 先更新进程内语言快照，后续同步读取 locale 的调用方立即生效。
      currentApplicationLocale = locale;
      // Host 的 ZCode endpoint 请求以此为实时语言；setting.json 写入可能滞后或失败，不能作为来源。
      // 每个 Host 都持有自己的语言快照，必须逐个通知，不能只发广播给窗口。
      for (const child of windowHostProcessMap.values()) {
        // 逐个 Host 推送 ApplicationLocaleChanged：每个 Host 各持一份自己的语言快照。
        child.postMessage({ type: HostMessageTypes.ApplicationLocaleChanged, locale });
      }
      // CUA 指示窗口不随语言事件重载，只能主动 refreshContent 重绘文案。
      windowsCuaOperationIndicator.refreshContent();
      // 菜单标签在构建期读取 locale，必须整体 rebuildMenu 而不是局部改文本。
      rebuildMenu();
      // 排除 CUA 指示窗：它是无边框浮层，不参与应用级语言广播。
      for (const win of getApplicationWindowsExcludingCuaIndicator()) {
        // 广播前判活：语言切换可能撞上正在关闭的窗口，向已销毁对象 send 会抛错。
        if (!win.isDestroyed()) {
          // 用当前快照而非入参 locale，保证窗口收到的与主进程一致。
          win.webContents.send(PlatformChannels.ApplicationLocaleChanged, currentApplicationLocale);
        }
      }
      // Finder/右键菜单在语言变化后重装，避免继续显示旧语言。
      installFinderOpenFolderWorkflow({
        // Finder 工作流只在 darwin 生效，其余平台传平台名由实现自行跳过。
        platform: process.platform,
        // 右键菜单文案按当前 locale 重写，避免切换后仍显示旧语言。
        locale: currentApplicationLocale,
        // homeDir 取 app.getPath 而非 process.env.HOME：打包后环境变量可能被清空。
        homeDir: app.getPath("home"),
        logger,
      });
      // Windows Explorer 右键菜单是注册表持久项，renderer 切换语言不会自动刷新。
      // 这里跟 macOS Finder Service 一样在 locale 变化时重写菜单文案，避免继续显示旧语言。
      await installWindowsOpenFolderContextMenu({
        // 注册表项按平台分支，Windows 之外由实现直接返回。
        platform: process.platform,
        // 菜单命令写死当前 execPath：打包版与 dev 的可执行路径不同。
        executablePath: process.execPath,
        // argv 原样传出，dev 构建需要带上入口脚本参数才能正确拉起窗口。
        argv: process.argv,
        // process.defaultApp 只在以 electron . 方式启动时为真，决定是否转义路径。
        isDefaultApp: Boolean(process.defaultApp),
        // 同一次切换里菜单语言与 Finder 保持一致，都取当前快照。
        locale: currentApplicationLocale,
        logger,
      });
      // Dock 菜单项由两个回调组成：标签按 locale 现取，点击回到主窗口。
      configureDockMenu(
        () =>
          // 标签延迟求值，Dock 菜单常驻，语言切换后再次打开要拿到新文案。
          getDesktopMenuLabelByLocale(
            currentApplicationLocale,
            desktopMenuMessageIds.dockShowCurrentWindow,
          ),
        () => showCurrentWindowFromDock(primaryWindowCoordinator),
      );
    },
    // 在已有窗口中切换 workspace：复用窗口而不是新建，保持“一窗口一项目”的体验。
    focusWorkspaceInExistingWindow: (path, extra) =>
      // 传入 windowWorkspaceMap 复用同一张表，新建窗口会破坏一窗口一项目的约定。
      focusWorkspaceInExistingWindow(path, windowWorkspaceMap, extra),
    windowWorkspaceMap,
    windowUnreadCountMap,
    // locale 区分系统语言与用户显式选择，设置页要能显示“跟随系统”的真实取值。
    resolveSystemLocale: resolveSystemApplicationLocale,
    // 用 getter 而非值快照：locale 可在运行期变化，快照会读到过期数据。
    currentApplicationLocale: () => currentApplicationLocale,
    // 命令执行统一走 executeDesktopCommandForApp，避免 IPC 侧自建派发路径。
    executeDesktopCommand: executeDesktopCommandForApp,
    // 更新说明已读回执带 version：同一版本只记一次，跨版本要重新提示。
    acknowledgePostUpdateReleaseNotes: (version) =>
      // 落盘交给 mainSettingService，main 不直接写 setting.json。
      acknowledgePostUpdateReleaseNotes(version, mainSettingService),
    // 活动会话同步到 PiP 路由器，它据此决定哪个窗口浮层跟随。
    syncActiveTaskSession: (windowId, sessionId) =>
      // windowId 与 sessionId 必须成对更新，单改任一侧会让 PiP 跟随错窗口。
      cuaPipFocusRouter.updateActiveSession(windowId, sessionId),
    // 任务实时订阅范围跟随窗口的 workspace 集合；Host id 未知时无法登记，直接跳过。
    syncTaskRealtimeWorkspaceKeys: (windowId, workspaceKeys) => {
      // Host id 可能尚未登记：窗口刚创建、Host 还没上报时查不到。
      const hostId = windowTaskRealtimeHostIdMap.get(windowId);
      // 查不到就跳过、不缓存待补：Host id 随窗口重建变化，缓存即脏数据。
      if (hostId) {
        // 只更新该 Host 的 workspace 集合，实时订阅按 Host 粒度重建。
        taskRealtimeBus.updateHostWorkspaceKeys(hostId, workspaceKeys);
      }
    },
    // 更新状态取自 autoUpdater 单例，renderer 不自己拼状态。
    getUpdateState: getAutoUpdaterState,
    openUpdateStatusWindow,
    getAutoUpdatePreferences,
    setAutoDownloadAndInstallUpdates,
    // getDesktopSessionActivity 用于空闲判定，必须在调用时现算，不能缓存。
    getDesktopSessionActivity: () => ({
      // 运行中的 agent 会话数直接来自 Host 汇总，main 不重复计数。
      runningAgentSessionCount: getRunningAgentSessionCount(),
    }),
    // 远控可用 workspace 同步后立即尝试恢复上次启用状态：恢复逻辑幂等，重复调用安全。
    syncWebRemoteControlWorkspaces: (windowId, workspaces) => {
      // 先同步可用 workspace，再尝试恢复上次启用状态。
      webRemoteControlManager.syncAvailableWorkspaces(windowId, workspaces);
      // restorePreviouslyEnabled 幂等且不阻塞：失败只影响远控默认开关，不该卡住设置页。
      void webRemoteControlManager.restorePreviouslyEnabled(windowId, workspaces);
    },
    // 设置变更走 syncImmediateAppSettings 立即通道，避免节流窗口内读到旧值。
    syncAppSettings: syncImmediateAppSettings,
    // 设置页置灰查询：monitor 带 stale 缓存，装完 AppIndicator 扩展重开设置页即可刷新。
    // 设置页置灰查询：先确保托盘实例就绪（用户装扩展后首次查询会补建），再返回合并了
    // trayReady 的最终能力，避免设置页显示可开启但关窗实际走确认退出的不一致（CR-01）。
    // 能力查询前先补建 Linux 托盘：设置页显示“可开启”必须与关窗实际行为一致。
    refreshCloseToTrayCapability: async () => {
      // 先补建 Linux 托盘：用户装完扩展后首次查询才拿得到真实能力。
      await ensureLinuxDesktopTray();
      // refresh 会重探桌面环境，带 stale 缓存，不能读上一次的结果。
      const capability = await closeToTrayCapabilityMonitor.refresh();
      // 返回值合并两处事实：resolveCloseToTraySupported 的平台判定与托盘是否就绪。
      return {
        // supported 必须与关窗实际行为同源，否则设置页显示可开启但关窗走确认退出。
        supported: resolveCloseToTraySupported({
          // Linux 之外由 resolveCloseToTraySupported 直接判定，不再看托盘。
          platform: process.platform,
          desktopTrayReady,
          // 桌面环境能力来自 capability，不能由平台名推断。
          capabilitySupported: capability.supported,
        }),
        // 单独暴露 gnome 系缺托盘标记，设置页要提示装扩展而不是简单置灰。
        gnomeLikeWithoutTray: capability.gnomeLikeWithoutTray,
      };
    },
    setShortcutRecordingActive,
    deviceMid,
  });

  // 渲染动作追踪 IPC 在 rollout 初始化后才注册；dispose 句柄在退出时调用。
  disposeRendererActionTraceIpc = registerRendererActionTraceIpc({
    // 追踪上报复用同一 rollout 实例，采样率与其它通道对齐。
    rollout: rendererActionTraceRollout,
    // broker 负责跨进程转发，IPC 层不直连上报端。
    broker: rendererActionTraceBroker,
    // env 传入用于读 E2E 开关，不在本文件缓存。
    env: process.env,
    logger,
  });

  // 远程 IPC：OAuth、会话创建/销毁、ARM 上下文与 source-settings 端口附加都在这里。
  registerRemoteIpcHandlers({
    // 使用进程级 logger，远端 IPC 的日志与主进程同一条流。
    logger,
    appTelemetryRuntime,
    // OAuth 回调成功后刷新用户身份，回调本身不等它完成。
    onOAuthCallbackHandledSideEffect: () => {
      // 不 await：身份刷新失败不应让 deep link 回调返回错误。
      void armsUserIdentitySync.refresh();
    },
    appTelemetryCore,
    // 用量事件由 renderer 触发，这里只做转发，不改任何字段。
    reportRemoteUsageEvent: reportRemoteUsageEventForRenderer,
    // ARMS 自定义上下文使用构建期版本与运行时环境；E2E 桥开关单独传入。
    armsCustomContext: {
      // deviceMid 与主进程共用同一值，ARMS 侧才能把事件归到一台设备。
      deviceMid,
      // platform 维度用于区分远控链路的实现分支。
      platform: process.platform,
      // 版本取构建期常量 ZCODE_VERSION，运行期不可变。
      appVersion: ZCODE_VERSION,
      // 环境名必须映射成 ARMS 认识的枚举，直接传原值会被丢弃。
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
    },
    // shouldEnableE2ETestBridge 只在测试环境返回 true，生产恒为 false。
    finalArmsCustomEventE2EEnabled: shouldEnableE2ETestBridge(process.env),
    webRemoteControlManager,
    // 远程会话创建入口统一从 remoteSessionManager 取，IPC 不自行 new。
    createRemoteWorkspaceSession: remoteSessionManager.createRemoteWorkspaceSession,
    // 连接统计是只读快照，供设置页展示当前链路状态。
    getRemoteConnectionStats: remoteSessionManager.getRemoteConnectionStats,
    // 销毁必须走 manager，它同时回收 attachment 与订阅。
    disposeRemoteWorkspaceSession: remoteSessionManager.disposeRemoteWorkspaceSession,
    // 关窗时取消该窗口所有未完成的远程会话，避免泄漏 pending 连接。
    cancelPendingRemoteWorkspaceSessionsForWindow:
      // 按 windowId 取消是 manager 的职责，main 不遍历会话表。
      remoteSessionManager.cancelPendingRemoteWorkspaceSessionsForWindow,
    // 上下文绑定把 workspaceIdentity 与 remoteSessionId 写进会话。
    bindRemoteWorkspaceSessionContext: remoteSessionManager.bindRemoteWorkspaceSessionContext,
    // renderer 侧 attachment 就绪后才允许开始推流。
    confirmRendererAttachmentReady: remoteSessionManager.confirmRendererAttachmentReady,
    // source-settings 端口：为指定来源服务器创建一个独立 service 通道。
    // MessageChannelMain 的 port1/port2 分别交给 Host 与 renderer，main 只做配对，所以不解读消息。
    attachSourceSettings: (sender, sourceServerId) => {
      // 按发起方 webContents id 找对应 Host：一个窗口一个 Local Host。
      const child = windowHostProcessMap.get(sender.id);
      // 没有 Host 说明窗口正在销毁，直接抛错让 renderer 感知，不静默丢端口。
      if (!child) throw new Error("Desktop Window Host is unavailable");
      // MessageChannelMain 造直连管道，main 只配对两端而不解析消息。
      const { port1, port2 } = new MessageChannelMain();
      // attachmentId 用随机 uuid：同一窗口可多次附加，不能按来源名去重。
      const attachmentId = `source-settings-${randomUUID()}`;
      // port2 交给 Host，port1 随后交给 renderer。
      child.postMessage(
        {
          // 消息类型固定为 AttachServicePort，Host 据此走端口附加分支。
          type: HostMessageTypes.AttachServicePort,
          // requestId 仅用于 Host 侧日志关联，不需要回执。
          requestId: randomUUID(),
          attachmentId,
          // 附加模式固定 desktop-continuous，该通道没有 replay 语义。
          clientMode: "desktop-continuous",
          // scope 决定 Host 侧挂哪个 service，source-settings 按来源服务器隔离。
          scope: { kind: "source-settings", sourceServerId },
        },
        [port2],
      );
      // 回给 renderer 的 port1 与 Host 侧 port2 配对，另一端由 Attachment 持有。
      sender.postMessage(
        InternalChannels.SourceSettingsServicePort,
        { attachmentId, sourceServerId },
        [port1],
      );
      // 只回 attachmentId：端口本身通过 postMessage 转移，不进返回值。
      return { attachmentId };
    },
    isDockerDaemonAvailable,
    listAvailableWSLDistros,
    listAvailableDockerContainers,
    listSSHConfigAliases,
  });

  // 等待 ARMS 初始化完成再创建首窗：否则首窗 dom-ready 早于 SDK 注册，事件会丢。
  // 等待 ARMS 完成 init（含渲染进程注入监听），避免首窗 dom-ready 早于 SDK 注册导致无上报
  await armsInitPromise;

  // 初始化完成后写入一次 user.name（含 device_mid），后续由聚焦事件刷新。
  // ARMS init 完成后首次写入 user.name（落 device_mid）
  void armsUserIdentitySync.refresh();

  // 四条遥测通道共享 deviceMid/armsEnv，但采样与上报各自独立，必须逐条 configure：
  // 少配一条，对应维度在 ARMS 上整段缺失，而不是回落到默认值。
  configureDesktopStabilityTelemetry({
    // deviceMid 同一台设备一个值，跨通道复用才能把崩溃和资源曲线对齐。
    deviceMid,
    // platform 决定稳定性看板的平台分组，不能按 UA 推断。
    platform: process.platform,
    // appVersion 取构建期常量，回滚判据依赖它而不是运行期上报。
    appVersion: ZCODE_VERSION,
    // armsEnv 区分生产与预发，混发会把错误率稀释。
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  // 资源通道：CPU 与内存采样走独立开关，与稳定性通道互不依赖。
  configureDesktopResourceTelemetry({
    // 资源曲线同样按 deviceMid 归属，缺它只能落到未知设备桶。
    deviceMid,
    // 资源阈值按平台不同，Windows 与 macOS 不能共用一条基线。
    platform: process.platform,
    // appVersion 用于判断资源回退是否与某次发布对齐。
    appVersion: ZCODE_VERSION,
    // 环境枚举与稳定性通道保持同一套映射，避免两条流对不上。
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  // MCP 通道单独 configure：它没有 platform 维度，不要照抄其它三条。
  configureDesktopMcpTelemetry({
    // deviceMid 必填，MCP 调用量按设备去重统计。
    deviceMid,
    // MCP 工具版本与 app 版本绑定，单独上报会失去对应关系。
    appVersion: ZCODE_VERSION,
    // 环境枚举同上，MCP 指标不能跨环境合并。
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  // 网络通道：请求失败率与重试次数在这里配置。
  configureDesktopNetworkTelemetry({
    // deviceMid 让网络指标按设备聚合，代理配置差异才看得见。
    deviceMid,
    // 平台决定证书与代理策略分支，必须带上。
    platform: process.platform,
    // appVersion 用于定位某一版的网络策略改动。
    appVersion: ZCODE_VERSION,
    // 四条通道用同一个 armsEnv 映射结果，不各自转换。
    armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
  });
  // 稳定性与资源监控注册顺序无关，但都必须在创建窗口前完成，才能覆盖首窗启动性能。
  registerDesktopStabilityMonitors(logger, crashCapturePaths);
  // 注册采样器本体；configure 只设定上下文，不启动采样。
  registerDesktopResourceTelemetry(logger);
  // 主窗口 renderer 的 60 秒 heap 样本入口；随 App 生命周期常驻，只注册一次。
  registerRendererHeapSampleIpc();
  // 数据目录统计需要区分默认/自定义根目录：这决定遥测里的 dataRootKind。
  const defaultDataBaseDir = process.env.HOME?.trim() || homedir();
  // 数据目录体积统计：只读目录大小，不删除也不迁移。
  registerDesktopZCodeDataSizeTelemetry({
    // context 是上报维度集合，字段缺一个整条记录会被丢弃。
    context: {
      // appVersion 用于观察升级后目录膨胀。
      appVersion: ZCODE_VERSION,
      // armsEnv 与其它遥测走同一映射。
      armsEnv: mapZCodeEnvToArmsRumEnv(desktopRuntimeEnv),
      // 先归一再比较：末尾斜杠或 .. 会让同一目录得到不同字符串，误判 custom 会污染维度。
      dataRootKind:
        // resolve 后再比：末尾斜杠与 .. 会让同一目录得到不同字符串。
        resolve(getDataBaseDir()) === resolve(defaultDataBaseDir) ? "default" : "custom",
      deviceMid,
      // 平台影响默认数据根位置，必须作为维度。
      platform: process.platform,
    },
    // 三个谓词决定采样场景：空闲时长来自 powerMonitor，后台态由 resolveResourceUsageScene 判定，
    // 忙碌态复用 Host 上报的 agent 会话数；任一取错都会把目录增长归因到错误场景。
    getSystemIdleTimeSeconds: () => powerMonitor.getSystemIdleTime(),
    // 后台态由 resolveResourceUsageScene 判定，不读窗口可见性。
    isAppBackground: () => resolveResourceUsageScene() === "background",
    // 忙碌态复用 Host 上报的 agent 会话数，main 不另立判据。
    isZCodeBusy: () => getRunningAgentSessionCount() > 0,
    logger,
    // 统计根取 getZCodeDataRootDir，与真实写入路径同源。
    rootPath: getZCodeDataRootDir(),
    // 状态文件放 userData，上次采样值要跨重启保留。
    stateFile: join(app.getPath("userData"), "zcode-data-size-telemetry.json"),
  });
  // 网络遥测注册放在数据目录统计之后，保证首窗前的请求也能被计入。
  registerDesktopNetworkTelemetry(logger);

  // 本地未打包 dev 构建（app.isPackaged === false）必须跳过远端强制升级 gate。
  // 原因：force-update gate 只看 ZCODE_ENV === "production"，但 dev 构建（如 dev:desktop:cua
  // 连真实后端测 computer use）虽指向 production 后端，版本号却滞后于线上 release（feature
  // 分支不 bump 版本），会被 release minimalVersion 误判为"需强制升级"而启动秒退。force-update
  // 是面向打包发布客户端的安全门，对未打包 dev 运行时无意义。打包版 app.isPackaged === true，
  // gate 照常生效，对真实用户零影响。
  const skipForceUpdateForLocalDevRuntime = !app.isPackaged;
  // gate 命中后 return：后续不创建主窗口，只保留已聚焦的提示窗口。
  const forceUpdateGuardResult =
    ZCODE_PRODUCT_FLAVOR === "production" && !skipForceUpdateForLocalDevRuntime
      // 只有生产渠道且非本地 dev 才走远端强制升级检查。
      ? await maybeBlockStartupForForceUpdate({
          // 提示窗口文案按当前 locale 渲染。
          locale: currentApplicationLocale,
          logger,
          // resolveCurrentZCodeEndpointOrigin 现取：自定义后端下最小版本可能不同。
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          // onBlocked 置位，后续不再创建主窗口。
          onBlocked: () => {
            // forceUpdateMainWindowCreationBlocked 供窗口创建路径读取，避免提示窗口旁再冒出空主窗口。
            forceUpdateMainWindowCreationBlocked = true;
          },
        })
      // 非生产渠道直接返回 { blocked: false }，不构造提示窗口。
      : { blocked: false };
  // ZCODE_PRODUCT_FLAVOR 分支只为打日志，说明这次为什么没检查。
  if (ZCODE_PRODUCT_FLAVOR !== "production") {
    // Preview 不接收 stable feed，强制升级对它无意义。
    logger.info("[force-update] Preview 跳过远端强制升级检查");
  } else if (skipForceUpdateForLocalDevRuntime) {
    // dev 构建版本号滞后于线上 release，会被 minimalVersion 误判。
    logger.info("[force-update] 本地 dev 构建（未打包）跳过远端强制升级检查");
  }
  // 命中强制升级就停在 ready 阶段，不再创建主窗口。
  if (forceUpdateGuardResult.blocked) {
    // 直接 return，保留已聚焦的提示窗口。
    return;
  }

  // 主窗口创建是启动的最后一个阻塞步骤；此后所有失败都只能降级提示，不能回滚。
  // 因此在此之前的所有初始化都必须可恢复，而此后只允许“记录并继续”。
  // 首窗创建失败会让应用停留在无窗口状态，必须由协调器/崩溃上报捕获。
  logger.info("[startup] 创建主窗口");
  // 主窗口创建是启动最后一个阻塞步骤，此后失败只能降级提示。
  await primaryWindowCoordinator.ensurePrimaryWindow("app-ready");

  // 首窗性能上报绑定 webContents：只对真正的主窗口采样一次。
  const primaryWindow = getApplicationWindowsExcludingCuaIndicator()[0];
  // 取排除 CUA 指示窗后的第一个窗口，可能为空。
  if (primaryWindow) {
    // 首窗性能只采样一次，绑定该窗口的 webContents。
    scheduleReportPerfAppStartAfterMainViewReady(primaryWindow.webContents, logger);
  }

  // 启动后检测 CPU 架构是否匹配（如 Apple 芯片误装 x64 版本经 Rosetta 转译运行），
  // 命中后异步弹框提示安装原生架构版本，不阻塞主界面。
  // 架构不匹配提示异步弹出：它不影响主界面可用性，失败只记日志。
  void maybeWarnArchitectureMismatch({
    // 架构提示文案跟随当前 locale。
    locale: currentApplicationLocale,
    logger,
    // 挂在主窗口上，没有窗口时传 null 走无父窗弹框。
    parentWindow: getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    // icon 复用应用图标，避免弹框出现空白图标。
    icon: nativeImage.createFromPath(iconPath),
  }).catch((error) => {
    // 弹框失败只 warn，不影响主界面可用性。
    logger.warn("[architecture] 架构检测弹框失败:", error);
  });

  // ready 阶段的协议 URL 仍要通过消费门：open-url 可能已经处理过同一 URL。
  const protocolUrl = extractDeepLinkUrlFromArgs(process.argv);
  // ready 阶段的协议 URL 仍要过消费门，open-url 可能已处理过同一条。
  if (protocolUrl && startupDeepLinkConsumptionGate.shouldHandleReadyProtocolUrl(protocolUrl)) {
    // 走与运行时同一套 deep link 处理，不另开分支。
    handleDeepLink(protocolUrl, logger, {
      // 外部 workspace 确认文案按 locale 现取。
      confirmationCopy: resolveExternalWorkspaceConfirmationCopy(),
      // 目标窗口现取，deep link 处理期间窗口可能已变化。
      resolveApplicationWindow: () => getApplicationWindowsExcludingCuaIndicator()[0] ?? null,
    });
  }
});

// 全局窗口清理：无论窗口由谁创建，closed 都必须释放 guest/路由/未读/快捷键录制态。
// 因此监听注册在 app 级，而不是每个 createWindow 调用点，避免遗漏。
// 清理顺序：先释放宿主资源，再删映射，最后处理需要读取窗口 id 的收尾。
// render-process-gone 单独处理，因为窗口存活时 closed 不会触发。
app.on("browser-window-created", (_, win) => {
  // 缓存 webContents id：closed 阶段再取 win.webContents.id 会命中已销毁对象。
  const windowWebContentsId = win.webContents.id;
  // 先销毁 guest 与截图表面，再清 map：顺序保证清理过程仍能按 windowId 查到关联资源。
  win.on("closed", () => {
    // 截图表面按 windowId 释放：它持有 Surface，不释放会持续占用 GPU 资源。
    browserScreenshotSurfaceCoordinator.handleWindowDestroyed(win.id);
    // guest 同步关闭：webContents 已销毁，这里只做登记簿与 Host 侧解绑。
    browserGuestManager.closeWindow(win.id);
    // 删窗口到 workspace 的映射，避免后续按 windowId 查到已关闭窗口的工作区。
    windowWorkspaceMap.delete(win.id);
    // 删窗口到 Host id 的映射：Host 随窗口销毁，残留 id 会让实时订阅打到失效连接。
    windowTaskRealtimeHostIdMap.delete(win.id);
    // 只有确实删掉了未读项才重算角标，否则白跑一次 badge 同步。
    if (windowUnreadCountMap.delete(win.id)) {
      // 用剩余未读表重算应用角标：windowUnreadCountMap 是唯一事实源，不能按差值增量扣。
      syncApplicationUnreadBadge(windowUnreadCountMap);
    }
    // Electron 进入 closed 回调时，win.webContents 可能已经被销毁。
    // 之前这里现取 win.webContents.id，会在关窗收尾阶段抛出 "Object has been destroyed"。
    // 改为在窗口创建时缓存 webContents id，确保清理 OAuth 路由时不再访问已销毁对象。
    clearOAuthRoutesForWindow(windowWebContentsId);
    // 录制中关窗/崩溃时 renderer 不会发复位 IPC，这里按发起 webContents 复位录制态，
    // 防止菜单 accelerator 被永久摘除。
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
  // 渲染进程崩溃但窗口存活时 closed 不会触发，崩溃路径同样按 owner 复位
  // （owner 不匹配时天然幂等）。
  // 渲染进程崩溃但窗口存活：closed 不会触发，需要单独复位录制态（owner 不匹配时幂等）。
  win.webContents.on("render-process-gone", () => {
    // 崩溃路径同样按发起方复位录制态：窗口仍存活，closed 不会补这一刀。
    resetShortcutRecordingForWebContents(windowWebContentsId);
  });
});
// 非 macOS 关闭全部窗口即退出；macOS 保持应用常驻，等待 activate 重建窗口。
app.on("window-all-closed", () => {
  // darwin 下窗口全关不等于退出：Dock 点击要能重建主窗口。
  if (process.platform === "darwin") {
    // macOS: keep app running when all windows are closed
    return;
  }

  // 非 darwin 直接退出：没有常驻托盘语义，留着进程只会变成后台僵尸。
  app.quit();
});
// [事务] before-quit 是同步事件：先做应用级退出确认，再拦截第一次退出启动异步屏障。
// 第二次 before-quit 时 hasPreparedAppQuit 为真，直接放行。
// 确认被取消时必须清 explicitQuit：否则下一次关窗会绕过“隐藏到托盘”。
// 拦截前清空媒体授权表，防止清理期间仍有 renderer 读取本地文件。
app.on("before-quit", (event) => {
  // Windows 最后窗口关闭会在 close 阶段提前确认并标记 forceQuit；
  // macOS 的 Cmd+Q / 菜单退出不会走该窗口关闭确认，必须在 before-quit 保留应用级确认兜底。
  if (!forceQuitRef.current && shouldConfirmAppQuit() && !confirmAppQuit()) {
    // preventDefault 撤销本次 quit：确认框没给结果前不能继续销毁窗口。
    event.preventDefault();
    // 托盘退出等显式退出如果被确认框取消，不能继续保留 explicitQuit。
    // 否则用户下一次点 Windows 关闭按钮会绕过“隐藏到托盘”设置，误触发完整退出路径。
    explicitQuitRef.current = false;
    // 取消态立刻 return，保持 hasPreparedAppQuit 为 false，下次退出重走确认。
    return;
  }

  // 第一次拦截：清空本地媒体授权表，启动 prepareAppQuit，并在完成后恢复退出。
  if (!hasPreparedAppQuit) {
    // 先清 media 白名单：退出准备期间 renderer 仍可能请求本地预览。
    localMediaPreviewPathRegistry.clear();
    // 拦住本次退出，等 prepareAppQuit 的 Promise 落地后再放行。
    event.preventDefault();
    // prepareAppQuit 串行清理 Host 与 guest，finally 才恢复退出，不依赖超时猜测。
    void prepareAppQuit("app-before-quit").finally(() => {
      // 再调一次 getApplicationWindowsExcludingCuaIndicator：准备期间可能插入关窗事件，早先快照已过期。
      const remainingWindows = getApplicationWindowsExcludingCuaIndicator();
      // 记录剩余窗口数，ChromeDriver 退出卡 70 秒的现场要靠这行对数。
      logger.info(
        `[app-quit] preparation finished, resuming quit with windows=${remainingWindows.length}`,
      );
      // ChromeDriver 关闭最后一个 renderer 后才触发 app.quit 时，
      // 第一次 before-quit 会被异步 host 清理拦截；清理完成时窗口可能仍处于
      // closing 状态，此时重入 app.quit 会被 Electron 忽略，ChromeDriver 会等待
      // 约 70 秒。这里把最后一次退出绑定到真实 closed 事件，不依赖超时猜测。
      if (remainingWindows.length === 0) {
        // 没有窗口就立即退出：再走 app.quit 会重入 before-quit，白等一轮清理。
        exitPreparedApp("no-windows-after-preparation");
        // 提前 return，避免给空数组注册 closed 监听后永不移交退出。
        return;
      }

      // 清理完成时若仍有窗口在 closing，绑定 closed 事件再退出：
      // 直接重复 app.quit 会被 Electron 忽略，ChromeDriver 会等约 70 秒。
      let exitRequested = false;
      // 幂等退出钩子：多个 closed 只允许触发一次 exitPreparedApp。
      const exitAfterLastWindowClosed = () => {
        // 双条件防重：exitRequested 已置位，或还有窗口没关完，都直接跳过。
        if (exitRequested || getApplicationWindowsExcludingCuaIndicator().length > 0) {
          // 还有窗口存活就等下一次 closed，不在这里抢跑退出。
          return;
        }
        // 先置标记再上报：即便 logger 抛错也不会重复执行退出。
        exitRequested = true;
        // 记录实际退出口径，便于和 before-quit 的日志对齐同一条时间线。
        logger.info("[app-quit] all windows closed after preparation, exiting app");
        // 走统一退出通道，保证 flush 与 telemetry 收尾和其余退出路径一致。
        exitPreparedApp("all-windows-closed-after-preparation");
      };
      // 每个窗口各挂一次：任意一个最后关闭都能触发，不依赖遍历顺序。
      for (const win of remainingWindows) {
        // once 而非 on：退出钩子只该生效一次。
        win.once("closed", exitAfterLastWindowClosed);
      }
      // hasPreparedAppQuit 已为真，再次 quit 会直接放行到关闭窗口阶段。
      app.quit();
    });
  }
});
// Dock 点击/activate 时确保主窗口存在；协调器会复用已有窗口而不是新建。
app.on("activate", () => {
  // activate 不复用旧窗口：协调器负责在全部关闭后重建主窗口。
  void primaryWindowCoordinator.ensurePrimaryWindow("app-activate");
});
