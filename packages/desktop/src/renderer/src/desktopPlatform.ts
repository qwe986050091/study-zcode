// INV-01 适配器只构造一次且不持有业务状态：守住位置是 createDesktopPlatform 的函数体整体；改错故障是每次渲染重建对象，订阅 disposer 失配导致监听器越积越多。
// INV-02 能力布尔值必须是字面量常量而非运行时探测：守住位置是对象开头的 canSelectFilePath 与 canOpenLocalFiles；改错故障是探测异步化后 UI 首帧误判为不可选路径，入口闪烁或永久隐藏。
// INV-03 每个事件订阅都必须把 preload 返回的 disposer 原样交还调用方：守住位置是各 on 系列箭头函数的返回；改错故障是包一层空函数吞掉 disposer，组件卸载后监听器仍存活并触发已卸载状态更新。
// INV-04 订阅型桥缺失时只能退化成空 disposer，不能抛错：守住位置是各 on 系列的可选链兜底；改错故障是旧 preload 下启动即抛异常，整个 renderer 白屏。
// INV-05 会改变主进程状态的写操作缺失时必须显式 reject：守住位置是 requestSourceSettingsAttachment 与 bindRemoteWorkspaceSessionContext 的兜底；改错故障是静默成功让调用方以为已绑定，后续请求打到错误 workspace。
// INV-06 只读查询型桥缺失时按安全默认值兜底：守住位置是 getUpdateState 与 getAutoUpdatePreferences 等 Promise 兜底；改错故障是返回 undefined 让调用方解构崩溃，或默认值取成自动安装导致静默升级。
// INV-07 能力门控入口必须在桥缺失时保持 undefined 而不是兜底实现：守住位置是 openCuaPermissionOnboarding 等以桥存在为条件的定义；改错故障是 UI 依据方法存在性判断能力，兜底后永远展示点了没反应的入口。
// INV-08 浏览器桥必须整体展开进同一对象且位置固定在尾部之前：守住位置是 desktopBrowserPlatformBridge 的展开那一行；改错故障是后写同名键覆盖浏览器桥，或漏展开导致内置浏览器全部能力消失。
// INV-09 展开的浏览器桥同样保留值为 undefined 的键：守住位置是桥对象里按条件定义的可选方法；改错故障是过滤掉 undefined 后存在性探测恒为真，UI 误判能力可用。
// INV-10 isLocalDevelopmentRuntime 必须原样透传调用方入参：守住位置是 options 到对象属性的一对一赋值；改错故障是硬编码为真，生产环境走宽松校验路径并泄露调试能力。
// INV-11 pluginSandbox 只在桌面端创建且随平台对象一同存活：守住位置是 createDesktopPluginSandboxPlatform 的即时调用；改错故障是 web 端也注入该端口，插件 UI 误走沙箱渲染并在缺宿主时崩溃。
// INV-12 选择文件类的取消与不支持都必须收敛成空结果：守住位置是 selectFiles 等返回空数组的兜底；改错故障是取消被当成异常弹错，或把 undefined 传给调用方导致遍历崩溃。
// INV-13 系统语言兜底不得依赖主进程 IPC：守住位置是 getSystemLocale 的 navigator 分支；改错故障是桥缺失时语言为空串，界面文案与日期格式回退到英文。
// INV-14 设备标识从 preload 注入的全局读取而非 IPC：守住位置是 getDeviceId 的全局属性兜底；改错故障是改为同步 IPC 取值，首帧拿不到标识造成埋点缺字段。
// INV-15 ARMS 事件先写本地 E2E 记录再转发主进程：守住位置是 reportArmsCustomEvent 函数体的语句顺序；改错故障是先转发后记录，主进程抛错时 E2E 断言丢事件。
// INV-16 反馈与社群入口必须复用桌面命令标识分发：守住位置是 openFeedback 与 openCommunity 的 executeDesktopCommand 调用；改错故障是各自硬编码地址，菜单与界面入口行为分叉。
// INV-17 所有方法都必须保持委托语义，不得在渲染进程缓存结果：守住位置是每个箭头函数的直接返回；改错故障是缓存了远控状态或会话活动数，主进程变化后界面长期显示过期值。
// INV-18 渲染进程只经由预加载脚本暴露的桥访问主进程：守住位置是整个对象里对外部全局的引用；改错故障是直接引入 electron 模块，开启上下文隔离后运行时报未定义。
//
// 模块职责：把预加载脚本暴露的桥适配成统一的平台服务对象，供 renderer 与插件沙箱消费，自身不做任何业务编排。
// 状态所有权：本文件不创建也不释放平台状态，订阅 disposer、会话与窗口状态都归预加载脚本和主进程；插件沙箱端口随平台对象存活。
// 阅读顺序：先看工厂签名与两个能力常量，再看订阅组与失败兜底策略，最后看浏览器桥展开和末尾的窗口、更新相关委托。
import { recordArmsCustomEventForE2E } from "@zcode/ui";
import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@zcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

// 工厂在渲染入口的模块顶层只执行一次，早于 React 挂载，因此这里不能依赖任何 hook 或组件生命周期。
// [权衡] 做成纯函数返回新对象而非单例，便于测试注入；代价是调用方必须保证只调用一次，否则订阅会重复注册。
// 返回类型被标注为平台服务接口，编译器据此约束键名与签名，漏写必填项会直接报错而不是运行期才发现。
// 开发态标记是唯一入参，只影响下游对校验严格度的选择，适配层自身不读取任何环境变量。
// 对象里的方法都是无状态的委托，不缓存返回值，主进程状态变化能立即反映到下一次调用。
export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    // 这两个能力位声明桌面端能返回 agent 可访问的本地绝对路径，属于宿主契约而非运行时探测结果。
    // 必须同步给出确定值，UI 在首帧就据此决定是否展示本地文件入口，异步探测会让入口闪烁。
    // [权衡] 桌面端恒为真而不是按平台细分，是因为三端原生对话框都返回绝对路径；若某平台返回虚拟路径，应改能力位而非调用处判断。
    // Web 与手机远控不实现本文件，对应平台给出假值，UI 依此隐藏入口，避免弹出永远拿不到路径的对话框。
    // 写错成运行期查询会让类型从布尔退化为异步结果，所有同步判断点都得改写，波及面远超本文件。
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    // 插件沙箱端口在平台对象构造时就实例化，随后随着该对象存活到窗口销毁，没有单独的释放入口。
    // [资源] 端口内部持有的运行时由桌面宿主管理，渲染进程只做转发；这里若改成惰性创建，首个插件卡片会多一次冷启动等待。
    // web 与手机端不提供该字段，插件 UI 依靠字段缺失回退到普通 MCP 工具卡片。
    // 写错成可选链兜底为空对象，UI 会误判沙箱可用并把插件渲染进一个没有实现的宿主。
    // 端口实例与工厂返回对象同生命周期，不要在组件里重复创建，否则每个组件各持一份运行时。
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.zcode.selectDirectory(),
    selectDirectories: () => window.zcode.selectDirectories(),
    selectFile: () => window.zcode.selectFile(),
    selectFiles: () => window.zcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.zcode.createTempTextAttachment(payload),
    materializeWorkflowArtifactFile: (payload) =>
      window.zcode.materializeWorkflowArtifactFile(payload),
    // 从这里开始是事件订阅组，统一约定：入参是回调，返回值是调用方负责调用的取消订阅函数。
    // [资源] 取消函数必须原样返回，不能在适配层包一层空函数，否则组件卸载后预加载侧的监听仍然挂着。
    // 订阅应在挂载后的副作用里注册，并把返回的取消函数作为清理函数，重复注册会让同一条日志被打印两次。
    // 回调会在渲染进程的事件循环里同步触发，回调内不要做重活，否则会阻塞后续消息处理。
    // 各订阅通道相互独立，漏订阅只表现为对应 UI 不更新，不会影响其他通道的事件的投递。
    onRemoteConnectionLog: (handler) => window.zcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.zcode.onRemoteSessionClosed(handler),
    // Source 自动重连会替换 logical session；统一由 preload bridge 转发换代事件。
    onRemoteSessionReconnected: (handler) =>
      window.zcode.onRemoteSessionReconnected?.(handler) ?? (() => {}),
    activateOrSetWorkspace: (path) =>
      window.zcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.zcode.connectRemote(remoteOptions, requestId, context),
    // [失败路径] 这是少数在桥缺失时显式拒绝的入口，与订阅组的静默兜底形成对照。
    // 原因在于它是写路径的前置动作：拿不到附件就必须让调用方看见错误，而不是继续用空配置建立连接。
    // 错误文案固定为桥不可用，调用方据此提示升级或重启，不要吞掉异常改成返回空对象。
    // 同组的 bindRemoteWorkspaceSessionContext 采用相同策略，保证远程会话的身份绑定失败不会被误认为成功。
    // 如果改成永远成功的兜底，后续请求会带着错误的 workspace 身份发到主进程，排查成本极高。
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.zcode.requestSourceSettingsAttachment?.(sourceServerId) ??
      Promise.reject(new Error("Source settings attachment bridge unavailable")),
    cancelPendingRemoteConnection: (requestId) =>
      window.zcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.zcode.bindRemoteWorkspaceSessionContext?.(context) ??
      Promise.reject(new Error("Desktop bindRemoteWorkspaceSessionContext bridge unavailable")),
    startWebRemoteControl: (context) => window.zcode.startWebRemoteControl(context),
    stopWebRemoteControl: () => window.zcode.stopWebRemoteControl(),
    getWebRemoteControlStatus: () => window.zcode.getWebRemoteControlStatus(),
    onWebRemoteControlStatusChanged: (handler) =>
      window.zcode.onWebRemoteControlStatusChanged?.(handler) ?? (() => {}),
    disposeRemoteSession: (sessionId) => window.zcode.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.zcode.isDockerAvailable(),
    listWSLDistros: () => window.zcode.listWSLDistros(),
    listDockerContainers: () => window.zcode.listDockerContainers(),
    listSSHConfigAliases: () => window.zcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.zcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.zcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.zcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.zcode.openExternal(url),
    openFeedback: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.zcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.zcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.zcode.openInFileManager(path),
    openExternalFile: (path) => window.zcode.openExternalFile(path),
    // [权衡] openCuaPermissionOnboarding 用条件表达式而非可选链兜底：上层靠方法是否存在判断系统能力。
    // 旧预加载脚本没有该桥时字段保持为空值，UI 据此隐藏授权引导；若兜底成必然失败的实现，入口会一直显示但点了必然失败。
    // 同组的准备拖拽与启动拖拽遵循同一模式，三者必须同时存在或同时缺席。
    // 注意条件判断读的是桥对象上的属性本身，不是调用结果，因此不会在构造阶段触发任何进程间通信。
    // 写错成无条件定义会让新 UI 在旧客户端上暴露半套权限流程，用户卡在拖拽引导里无法完成授权。
    openCuaPermissionOnboarding: window.zcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.zcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.zcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.zcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.zcode.startCuaHelperPermissionDrag
      ? () => window.zcode.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyWebRemoteControlAuthStateChanged: (change) =>
      window.zcode.notifyWebRemoteControlAuthStateChanged(change),
    registerOAuthState: (payload) => window.zcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.zcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.zcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.zcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.zcode.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.zcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.zcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.zcode.getRendererActionTraceConfig
      ? () => window.zcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.zcode.onRendererActionTraceConfigChanged
      ? (callback) => window.zcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.zcode.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.zcode.reportRendererActionTraceBatch
      ? (batch) => window.zcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.zcode.reportRendererHeapSample
      ? (sample) => window.zcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.zcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.zcode.syncWindowTabs(paths),
    syncWebRemoteControlWorkspaces: (workspaces) =>
      window.zcode.syncWebRemoteControlWorkspaces?.(workspaces),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.zcode.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.zcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.zcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.zcode.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.zcode.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.zcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.zcode.onFocusTab(handler),
    onNewTab: (handler) => window.zcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.zcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.zcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.zcode.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.zcode.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.zcode.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.zcode.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.zcode.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.zcode.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.zcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.zcode.browserViewScreenshotSurfaceReady?.(payload),
    // 浏览器能力单独抽成对象后在这里整体展开，与本文件的其他委托合并成同一个平台服务实例。
    // [权衡] 展开位置放在中间而非末尾，是为了让后面少数同名键可以覆盖浏览器桥，同时不改变其余键的语义。
    // 桥对象里按条件定义的可选方法会以空值一起展开，这一点是刻意的：键存在性本身就是能力信号。
    // 若在这里过滤掉空值，上层的能力探测会全部为真，内置浏览器的部分入口会变成点了没反应。
    // 浏览器标签、视口等状态全部留在桥对象和主进程，本文件只做方法级转发，不持有任何浏览器状态。
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.zcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.zcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.zcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.zcode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.zcode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.zcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.zcode.getDesktopWindowChromeState
      ? () => window.zcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.zcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.zcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.zcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.zcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.zcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.zcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.zcode.onTaskNotificationClick(handler),
    exportLogs: () => window.zcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.zcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.zcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.zcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.zcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.zcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.zcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.zcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.zcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.zcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.zcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.zcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.zcode.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.zcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.zcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.zcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.zcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.zcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.zcode.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.zcode.getInstalledEditors(filePath),
    getApplicationIcon: (bundleId) =>
      window.zcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.zcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.zcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.zcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.zcode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.zcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ZCODE_DEVICE_ID__?: string }).__ZCODE_DEVICE_ID__ ?? "",
  };
}
