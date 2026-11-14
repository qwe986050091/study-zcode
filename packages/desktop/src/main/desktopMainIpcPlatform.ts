// 桌面平台 IPC 集中装配层：必须把 dialog、shell、窗口外观、MCP 用户目录、更新状态、
// 资源管理器与浏览器视图等原生能力统一挂到 PlatformChannels，renderer 只经 IPlatformService 调用。
// 不负责：权限判定与业务状态（由 host、services 持有）、通道名单定义与协议类型（在 @zcode/shared）、
// 各子能力的实现细节（在 desktopSaveFile、resourceManagerWindow 等模块）；本文件必须只做装配、校验、转调与错误收敛。
//
// INV-01 断言：每个 PlatformChannels 通道在此只注册一次，重复 handle 会抛错并中断其后的全部注册 —— 守住它的位置：函数体内全部 ipcMain.handle 与 ipcMain.on 调用 —— 改错故障：启动即报 second handler 错误，桌面窗口白屏。
// INV-02 断言：来自 renderer 的入参必须先经 zod 或 typeof 判定再下发 —— 守住它的位置：SetApplicationLocale、SyncWindowTabs、SyncAppSettings、Log、SetTitleBarTheme 分支 —— 改错故障：畸形 payload 直接进入 main，触发未捕获异常或把非法值写入持久化。
// INV-03 断言：路径类通道必须只做校验与转调，不在本层解释业务含义 —— 守住它的位置：ActivateOrSetWorkspace 与 OpenInFileManager —— 改错故障：多窗口路径归属出现两份实现，工作区集合与远控快照长期不一致。
// INV-04 断言：单选对话框取消返回 null、多选取消返回空数组，两种空值形态不可互换 —— 守住它的位置：SelectDirectory、SelectDirectories、SelectFile、SelectFiles 的 canceled 分支 —— 改错故障：renderer 拿到 undefined 后拼出 null 字样路径或误判为已选。
// INV-05 断言：保存类通道用成功位信封返回，不把写入异常抛回 renderer —— 守住它的位置：SaveMcpToUserDirectory 的 catch 分支 —— 改错故障：用户目录不可写时设置页抛未处理拒绝，整个 MCP 面板无法操作。
// INV-06 断言：主题与语言这类进程级全局状态只在此处写入 —— 守住它的位置：SetTitleBarTheme 的 nativeTheme.themeSource 与 SetApplicationLocale 的 applyApplicationLocale —— 改错故障：多窗口各自写全局状态，最后关闭的窗口决定所有窗口主题。
// INV-07 断言：窗口相关副作用一律以 event.sender 反查窗口，查不到就静默返回 —— 守住它的位置：SetTitleBarTheme、SyncWindowTabs、SyncWebRemoteControlWorkspaces、WindowControlsOverlayReady —— 改错故障：窗口销毁竞态下对空引用取 webContents 抛错，main 出现未捕获异常。
// INV-08 断言：windowWorkspaceMap 的条目必须随发起窗口 closed 事件释放 —— 守住它的位置：ActivateOrSetWorkspace 内首次建 Set 时挂的关闭监听 —— 改错故障：反复开关窗口后集合无界增长，远控与实时键同步带上已关闭窗口的数据。
// INV-09 断言：SyncWindowTabs 只维护本地工作区集合，不驱动远控恢复 —— 守住它的位置：SyncWindowTabs 分支末尾的注释与调用面 —— 改错故障：两条路径同时写远控状态形成回环，恢复时工作区来回跳变。
// INV-10 断言：远控工作区以完整快照覆盖，不做增量合并 —— 守住它的位置：SyncWebRemoteControlWorkspaces 的整包下发 —— 改错故障：已移除的远控工作区在桌面侧残留，手机端仍能连到失效入口。
// INV-11 断言：未读数为 0 时删除 map 条目而不是写 0 —— 守住它的位置：SyncWindowUnreadCount 委派的 handleWindowUnreadCountSync —— 改错故障：应用角标常驻，用户清空消息后 Dock 与托盘仍显示红点。
// INV-12 断言：zoom 档位必须由缩放因子反解，不能透传因子 —— 守住它的位置：GetDesktopZoomLevel 与 WindowControlsOverlayReady —— 改错故障：量纲错误导致标题栏按钮错位，高 DPI 下露出生理边框。
// INV-13 断言：窗口缺失或已销毁时读取类通道返回中性值而不抛错 —— 守住它的位置：GetDesktopZoomLevel 的 0 档位、GetDesktopWindowChromeState 的非最大化、CaptureWindowScreenshot 的空值 —— 改错故障：窗口关闭瞬间的迟到请求让 renderer 出现错误边界。
// INV-14 断言：设备标识由启动时注入的 deviceMid 提供，本层不生成也不重算 —— 守住它的位置：GetDeviceId 直接返回 options.deviceMid —— 改错故障：同一台机器出现两个设备 id，远端配对与统计被拆成两台设备。
// INV-15 断言：renderer 日志必须补上发送方身份后再交给主日志器 —— 守住它的位置：Log 分支调用 decorateRequestSecurityLogArgs 的位置 —— 改错故障：多窗口日志无法溯源，安全日志缺少窗口归属。
// INV-16 断言：可选 handler 缺失时通道照常注册、调用处静默跳过 —— 守住它的位置：setShortcutRecordingActive 的可选调用与浏览器视图三组可选回调 —— 改错故障：关闭某个子能力后整体装配失败，桌面无法启动。
//
// 改动风险会集中在两处：多注册一次（启动即崩）与少校验一次（静默越权）。
// 新增通道必须优先落在对应子模块注册器里，只有跨模块编排的原生能力才放进本文件。
import { decorateRequestSecurityLogArgs } from "./request-security-edition/index.js";
/* eslint-disable max-lines -- 桌面平台 IPC 集中装配，拆散会让权限边界更难审计；行数随平台能力增长。 */
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import {
  DesktopCommandIds,
  appSettingsPatchSchema,
  formatZodError,
  localeSchema,
  nonEmptyStringSchema,
  PlatformChannels,
  rendererLogPayloadSchema,
  stringArraySchema,
  webRemoteControlWorkspaceTargetsSchema,
  type DesktopCommandId,
  type ApplicationIconRequest,
  type Locale,
  type LoadCliMcpFromUserDirectoryRequest,
  type MigrateLegacyCommonMcpRequest,
  type OpenInEditorOptions,
  type SaveCliMcpToUserDirectoryRequest,
  type CreateTempTextAttachmentRequest,
  type MaterializeWorkflowArtifactFileRequest,
  type UpdateStatePayload,
  type WebRemoteControlWorkspaceTarget,
  type WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { getInstalledEditors } from "./editors.js";
import { getApplicationIcon } from "./applicationIcons.js";
import { exportLogs } from "./exportLogs.js";
import { resolveCommunityUrl } from "./desktopCommandHandlers.js";
import { openInEditor } from "./openInEditor.js";
import {
  openResourceManager,
  getResourceUsageSnapshot,
  setResourceUsageSamplingActive,
} from "./resourceManagerWindow.js";
import { registerResourceManagerStorageIpc } from "./resourceManagerStorage.js";
import { registerResourceManagerNetworkIpc } from "./resourceManagerNetwork.js";
import { applyWindowsTitleBarTheme, getWindowOverlayTheme } from "./desktopWindowChrome.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import { resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import { handleWindowUnreadCountSync } from "./desktopWindowLifecycle.js";
import { captureWindowScreenshot, openPathInFileManager } from "./desktopMainIpcHelpers.js";
import { registerCuaPermissionIpcHandlers } from "./desktopCuaPermissionIpc.js";
import {
  registerDesktopBrowserIpcHandlers,
  type AttachBrowserGuest,
  type ReportBrowserScreenshotSurfaceReady,
  type UpdateBrowserGuestViewport,
  type BrowserViewResidencyIpcHandlers,
} from "./desktopBrowserViewIpc.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { materializeWorkflowArtifactFile } from "./workflowArtifactFile.js";
import { registerDesktopSaveFileIpcHandler } from "./desktopSaveFile.js";
import { registerDesktopPrintToPdfIpcHandler } from "./desktopPrintToPdf.js";
import { registerDesktopCommandIpcHandler } from "./desktopCommandIpc.js";
import { registerCuaPipActiveSessionIpc } from "./desktopCuaPipIpc.js";

// [契约] options 全部依赖注入：本函数不 import 任何持有业务状态的单例，保证 IPC 装配可在测试中替换实现。
// [契约] 增删字段必须同步 index.ts 调用点；该签名是 main 侧唯一装配入口，缺失应在编译期暴露而不是运行时兜底。
// [权衡] 可选 handler 缺失时通道仍然注册、调用处静默跳过，避免单个子能力关闭导致整个桌面启动失败。
export function registerPlatformIpcHandlers(options: {
  fetchHelpConfig?: () => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  applyApplicationLocale: (locale: Locale) => Promise<void>;
  resolveSystemLocale: () => Locale;
  focusWorkspaceInExistingWindow: (
    path: string,
    extra?: { skipWindowId?: number },
  ) => { activated: boolean; winId?: number };
  windowWorkspaceMap: Map<number, Set<string>>;
  windowUnreadCountMap: Map<number, number>;
  currentApplicationLocale: () => Locale;
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  acknowledgePostUpdateReleaseNotes: (version: string) => Promise<void>;
  syncActiveTaskSession: (windowId: number, sessionId: string | null) => void;
  syncTaskRealtimeWorkspaceKeys: (windowId: number, workspaceKeys: Iterable<string>) => void;
  getUpdateState: () => UpdateStatePayload;
  openUpdateStatusWindow: () => void;
  syncWebRemoteControlWorkspaces: (
    windowId: number,
    workspaces: WebRemoteControlWorkspaceTarget[],
  ) => void;
  getDesktopSessionActivity: () => {
    runningAgentSessionCount: number;
  };
  getAutoUpdatePreferences: () => Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  syncAppSettings: (patch: ReturnType<typeof appSettingsPatchSchema.parse>) => void;
  /** 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）；传入 monitor 的 refresh */
  refreshCloseToTrayCapability: () => Promise<import("@zcode/shared").DesktopCloseToTrayCapability>;
  /** 快捷键设置页录制态开关：true 时 main 重建菜单摘除可配置 accelerator（见 shortcut-settings-spec §7） */
  setShortcutRecordingActive?: (active: boolean, ownerWebContentsId?: number | null) => void;
  /** 桌面端设备标识符（基于 userData 路径的 SHA-256） */
  deviceMid: string;
  /** CDP-on-guest pivot：renderer `<webview>` 上报 guest webContentsId → main attach。 */
  attachBrowserGuest?: AttachBrowserGuest;
  /** renderer 自由尺寸变化 → 当前窗口所属的受控 tab。 */
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport;
  /** 可信 owner renderer 上报的后台截图表面 ready。 */
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady;
  /** Browser tab 关闭、挂起、恢复与跨重启 shell IPC。 */
  browserViewResidencyHandlers?: BrowserViewResidencyIpcHandlers;
}) {
  // [契约] 四个对话框通道都不传父窗口：统一弹系统级窗口，不把模态绑定到发起窗口，多窗口下不会互相阻塞。
  // [契约] 取消语义按单选、多选分开返回 null 与空数组，调用方按数组长度判断，不要用 falsy 判断。
  // [失败路径] 这里不 catch showOpenDialog 的异常，失败会变成 renderer 侧 Promise 拒绝，而不是被当成空选择。
  ipcMain.handle(PlatformChannels.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectDirectories, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle(PlatformChannels.SelectFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return result.filePaths;
  });

  // [契约] 保存文件与打印到 PDF 由子模块注册，它们要自己处理临时文件与失败回收；本文件只负责传 logger 并触发装配。
  // [权衡] 这两个注册器内部各自占用若干通道，因此不能在本文件再次 handle 同名通道，否则启动时直接崩溃。
  registerDesktopSaveFileIpcHandler(options.logger);
  registerDesktopPrintToPdfIpcHandler(options.logger);

  ipcMain.handle(
    PlatformChannels.CreateTempTextAttachment,
    async (_event, payload: CreateTempTextAttachmentRequest) => {
      return createTempTextAttachment(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.MaterializeWorkflowArtifactFile,
    async (_event, payload: MaterializeWorkflowArtifactFileRequest) => {
      return materializeWorkflowArtifactFile(payload);
    },
  );

  // [契约] 浏览器视图相关回调全部可选：功能开关关闭时传 undefined，子模块内部按 undefined 跳过注册。
  // [资源] attach、viewport、截图表面三组回调绑定同一窗口生命周期，不能在这里做跨窗口复用或缓存。
  // [失败路径] payload 校验必须留给子模块，这里不预校验，避免两套口径漂移后互相放行。
  registerDesktopBrowserIpcHandlers(
    options.attachBrowserGuest,
    options.updateBrowserGuestViewport,
    options.logger,
    options.reportBrowserScreenshotSurfaceReady,
    options.browserViewResidencyHandlers,
  );

  // [契约] path 先经 nonEmptyStringSchema.parse：非法值直接抛回 renderer，而不是静默落到默认工作区。
  // [并发] activated 为 true 表示已切到别的窗口，此时不再写发起窗口的集合，避免同一工作区被两个窗口同时持有。
  // [资源] 首次为该窗口建 Set 时顺手挂 closed 监听删除 map 条目；漏掉这行会让集合随开关窗口无界增长。
  // [契约] 只登记到 windowWorkspaceMap 并同步实时键，不在这里改远控快照，远控由 SyncWebRemoteControlWorkspaces 全量覆盖。
  // [失败路径] skipWindowId 传发起窗口 id：不跳过后当前窗口会把自己判成已存在，激活恒为 false 且路径不再登记。
  ipcMain.handle(PlatformChannels.ActivateOrSetWorkspace, (event, path: string) => {
    const validatedPath = nonEmptyStringSchema.parse(path);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const activated = options.focusWorkspaceInExistingWindow(validatedPath, {
      skipWindowId: senderWin?.id,
    });
    if (activated.activated) {
      return { activated: true };
    }

    if (senderWin) {
      let pathSet = options.windowWorkspaceMap.get(senderWin.id);
      if (!pathSet) {
        pathSet = new Set();
        options.windowWorkspaceMap.set(senderWin.id, pathSet);
        senderWin.on("closed", () => options.windowWorkspaceMap.delete(senderWin.id));
      }
      pathSet.add(validatedPath);
      options.syncTaskRealtimeWorkspaceKeys(senderWin.id, pathSet);
    }
    return { activated: false };
  });

  // [契约] 资源采样按 event.sender.id 分桶，每个窗口只能读到自己的用量快照。
  // [并发] 该通道只读快照，不触发采样启动；启动与停止由 SetResourceUsageSamplingActive 控制。
  ipcMain.handle(PlatformChannels.GetResourceUsageSnapshot, (event) =>
    getResourceUsageSnapshot(event.sender.id),
  );
  // 设置页 Linux 置灰判断入口；monitor 带 stale 缓存，用户装完扩展重开设置页即可解除置灰。
  ipcMain.handle(PlatformChannels.GetCloseToTrayCapability, () =>
    options.refreshCloseToTrayCapability(),
  );
  // [失败路径] 非 boolean 的 payload 直接忽略而不是抛错：这是 on 单向通道，抛错不会回到 renderer，只会变成 main 未捕获异常。
  // [资源] 开关按发送方 webContents id 记账，窗口关闭后的清理由资源管理器侧负责，不要在这里补 delete。
  ipcMain.on(PlatformChannels.SetResourceUsageSamplingActive, (event, active: unknown) => {
    if (typeof active === "boolean") setResourceUsageSamplingActive(event.sender.id, active);
  });
  // [契约] 资源管理器的存储快照通道必须由子模块注册，本文件不出现具体磁盘路径与采样周期。
  // [契约] 存储与网络注册器相邻调用，分别负责持久化数据与实时网络数据，命名与导出保持在 resourceManager 目录内一致。
  registerResourceManagerStorageIpc();
  registerResourceManagerNetworkIpc();
  // [契约] stdio tap 状态是开发诊断能力，直接读服务层内存状态而不缓存，保证设置页每次打开都拿到最新值。
  // [权衡] 返回值原样透传，不在 main 做裁剪或脱敏；该能力只出现在诊断路径，不承载普通用户流程。
  ipcMain.handle(PlatformChannels.GetZCodeStdioTapDevState, () => readZCodeStdioTapDevState());
  // [契约] 资源管理器是单例窗口，openResourceManager 内部会查找已有实例并聚焦；本层不缓存窗口引用。
  // [契约] 该通道是 on 单向：打开失败没有回执，renderer 不等待返回结果。
  // [权衡] 不在这里判断是否已有窗口，否则本层缓存会和窗口真实销毁状态不一致，出现聚焦到死窗口。
  ipcMain.on(PlatformChannels.OpenResourceManager, () => {
    openResourceManager();
  });

  ipcMain.handle(
    PlatformChannels.LoadMcpFromUserDirectory,
    async (_event, payload?: LoadCliMcpFromUserDirectoryRequest) => {
      return loadCliMcpFromUserDirectory(payload);
    },
  );

  // [契约] 保存 MCP 到用户目录用成功位信封返回，不把异常抛给 renderer：写入失败属于可恢复操作，UI 需要就地提示。
  // [失败路径] 只回传 error.message，非 Error 值统一字符串化兜底，保证信封里始终是可展示的文本。
  // [契约] 成功时只返回 success: true，不带 error 字段；调用方以成功位判断，不要靠 error 是否存在反推。
  ipcMain.handle(
    PlatformChannels.SaveMcpToUserDirectory,
    async (_event, payload: SaveCliMcpToUserDirectoryRequest) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[mcp-user-directory] save failed", message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.MigrateLegacyCommonMcp,
    async (_event, payload?: MigrateLegacyCommonMcpRequest) => {
      return migrateLegacyCommonMcp(payload);
    },
  );

  // [契约] theme 只接受 light、dark、system 三个字面量，非法值只告警不抛错：外观通道出错不能把设置页卡死。
  // [契约] nativeTheme.themeSource 是进程级状态，先写它再按窗口应用 overlay，保证之后新建的窗口继承同一主题。
  // [契约] system 要先用 getWindowOverlayTheme 解析成具体明暗再交给 applyWindowsTitleBarTheme，直接透传会画出透明 overlay。
  // [失败路径] 找不到发起窗口就直接返回：此时也不该改 nativeTheme，否则其它窗口主题会被这次失效调用带偏。
  ipcMain.handle(PlatformChannels.SetTitleBarTheme, (event, theme: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }

    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      options.logger.warn("[title-bar-theme] invalid theme:", theme);
      return;
    }

    nativeTheme.themeSource = theme;
    applyWindowsTitleBarTheme(senderWindow, theme === "system" ? getWindowOverlayTheme() : theme);
  });

  // [契约] locale 用 safeParse 而非 parse：非法语言包只记录并返回 undefined，不能让主进程抛错使整块设置失效。
  // [契约] 返回 applyApplicationLocale 的 Promise，renderer 需要等菜单与标题真正切换完成，不能乐观更新。
  // [并发] 连续切换语言时的串行由 applyApplicationLocale 自己保证；本层不排队也不缓存上一次语言值。
  ipcMain.handle(PlatformChannels.SetApplicationLocale, (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[application-locale] invalid locale:", formatZodError(result.error));
      return;
    }

    return options.applyApplicationLocale(result.data);
  });

  // [契约] 系统语言每次必须现取，不缓存；用户改系统语言后无需重启即可读到新值。
  // [契约] 与 SetApplicationLocale 区分：这里只读系统偏好，不写应用语言设置。
  ipcMain.handle(PlatformChannels.GetSystemLocale, () => options.resolveSystemLocale());

  // [契约] 整窗 tab 列表是覆盖式写入，用新 Set 替换旧值，保证已关闭的 tab 立刻从集合中消失。
  // [契约] 这里只同步本地工作区键，远控恢复由 SyncWebRemoteControlWorkspaces 的完整快照驱动，两边都写会形成回环。
  // [失败路径] 找不到发起窗口时静默丢弃：窗口正在销毁的竞态下没有可写的 map 键。
  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, paths: string[]) => {
    const result = stringArraySchema.safeParse(paths);
    if (!result.success) {
      options.logger.warn("[sync-window-tabs] invalid payload:", formatZodError(result.error));
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      options.windowWorkspaceMap.set(win.id, new Set(result.data));
      options.syncTaskRealtimeWorkspaceKeys(win.id, result.data);
      // 远控恢复统一由 SyncWebRemoteControlWorkspaces 的完整快照驱动。
    }
  });

  // [契约] payload 必须是完整工作区快照，本层不做增量合并；合并会让已移除的远控工作区在桌面侧残留。
  // [失败路径] 校验失败或窗口缺失都直接返回，不保留上一份旧快照，防止用过期数据继续对外提供远控入口。
  ipcMain.on(PlatformChannels.SyncWebRemoteControlWorkspaces, (event, payload: unknown) => {
    const result = webRemoteControlWorkspaceTargetsSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[sync-web-remote-control-workspaces] invalid payload:",
        formatZodError(result.error),
      );
      return;
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    options.syncWebRemoteControlWorkspaces(win.id, result.data);
  });

  // [契约] 未读数由 handleWindowUnreadCountSync 统一落 map 并刷新应用角标；为 0 时删除条目而不是写 0。
  // [契约] 通道用 on 单向：角标同步没有回执，renderer 不能依赖返回值判断是否生效。
  ipcMain.on(PlatformChannels.SyncWindowUnreadCount, (event, payload: unknown) => {
    handleWindowUnreadCountSync(
      BrowserWindow.fromWebContents(event.sender),
      payload,
      options.windowUnreadCountMap,
      options.logger,
    );
  });
  // [契约] CUA 画中画通道由子模块注册，这里只注入活动会话同步与告警适配器，main 不直接依赖 CUA 实现。
  // [权衡] 告警包一层箭头函数，是为了把 logger 的可变参数签名收窄成子模块需要的单参数形态。
  registerCuaPipActiveSessionIpc({
    syncActiveTaskSession: options.syncActiveTaskSession,
    warn: (message) => options.logger.warn(message),
  });
  // [契约] zoomLevel 必须是有限值：preload 上报的是读到的档位，NaN 与 Infinity 直接丢弃，否则按钮位置会被算成无限偏移。
  // [契约] 该通道在 preload 阶段就触发，早于 React 挂载；只调整窗口按钮位置，不做任何需要页面就绪的副作用。
  // [失败路径] 找不到发起窗口或档位非法时返回：窗口销毁后的迟到消息不能再去取 webContents。
  ipcMain.on(
    PlatformChannels.WindowControlsOverlayReady,
    (event, payload: WindowControlsOverlayReadyPayload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !Number.isFinite(payload.zoomLevel)) {
        return;
      }

      // preload 早于 React 页面运行，用它同步到的 zoom 档位先调整 macOS 红绿灯，
      // 避免等 RootStartupLoading 切到 App 页面后才重置位置。
      syncWindowControlsOverlayForZoomLevel(senderWindow, payload.zoomLevel);
    },
  );

  // [契约] appSettingsPatchSchema 描述的是局部补丁而非全量偏好；本层只校验，合并与持久化交给 syncAppSettings。
  // [失败路径] 非法补丁只告警并丢弃整条消息，不做字段级部分应用，避免半套设置被写进磁盘。
  ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload: unknown) => {
    const result = appSettingsPatchSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[settings] invalid app settings sync payload:",
        formatZodError(result.error),
      );
      return;
    }

    options.syncAppSettings(result.data);
  });

  // 快捷键录制态：renderer 设置页进入/退出录制时通知。macOS 系统菜单会先于 renderer
  // 吃掉按键，录制 menu 通道命令必须先摘掉可配置 accelerator，否则按键直接触发原命令。
  // 附带发起方 webContents id：录制中窗口销毁时 main 侧据此复位（见 index.ts）。
  ipcMain.on(PlatformChannels.SetShortcutRecordingActive, (event, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[shortcuts] invalid recording-active payload:", payload);
      return;
    }
    options.setShortcutRecordingActive?.(payload, event.sender.id);
  });

  // [契约] renderer 日志先过 rendererLogPayloadSchema，形状不对就丢弃，不把任意对象字符串化后写进主进程日志。
  // [契约] 交给 fromRenderer 之前用 decorateRequestSecurityLogArgs 补上发送方身份，否则无法区分日志来自哪个窗口。
  // [失败路径] fromRenderer 通过类型断言可选调用：旧日志实现没有该能力时不会崩，但这条日志会静默丢失。
  ipcMain.on(PlatformChannels.Log, (event, payload: unknown) => {
    const result = rendererLogPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn("[renderer-log] invalid payload:", formatZodError(result.error));
      return;
    }
    (
      options.logger as unknown as { fromRenderer(level: string, args: unknown[]): void }
    ).fromRenderer?.(
      result.data.level,
      decorateRequestSecurityLogArgs(result.data.args, event.sender.id),
    );
  });

  // [契约] 裁剪、realpath 与 shell.openPath 都在 helper 内完成，本层保持一行转调；在 IPC 层重复规范化会出现两套路径口径。
  // [失败路径] helper 始终 resolve 成功位信封，所以这里不加 try 语句，renderer 依据成功位提示用户。
  ipcMain.handle(PlatformChannels.OpenInFileManager, async (_event, rawPath: string) =>
    openPathInFileManager(rawPath, options.logger),
  );

  // [契约] CUA 权限通道单独注册，只注入 logger 与当前语言读取函数，权限判定与记忆状态留在 CUA 侧。
  // [契约] 语言传函数而不是快照值，保证用户切换语言后权限提示文案能跟着变。
  registerCuaPermissionIpcHandlers({
    logger: options.logger,
    currentApplicationLocale: options.currentApplicationLocale,
  });

  // [契约] 这是探测通道而不是打开通道：只回答社区入口是否可用，内部会读远端与本地配置，因此可能较慢。
  // [失败路径] 非法 locale 返回 false 而不是抛错：入口按钮应保持不可用，设置页不能因语言值异常而崩溃。
  // [权衡] 判定条件是字符串且非空，空白 URL 等价于不可用；不要改成真值判断，否则会把空白串当成可用入口。
  ipcMain.handle(PlatformChannels.CanOpenCommunity, async (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[community] invalid locale:", formatZodError(result.error));
      return false;
    }

    const communityUrl = await resolveCommunityUrl({
      locale: result.data,
      fetchRemoteConfig: options.fetchHelpConfig,
      logger: options.logger,
    });

    return typeof communityUrl === "string" && communityUrl.length > 0;
  });

  // [契约] version 用 nonEmptyStringSchema.parse 强校验：它会写进已读更新说明的持久化键，空值会让所有版本被误判已读。
  // [契约] 处理函数是 await 调用，renderer 要等到确认落盘后才能关闭更新说明面板。
  // [失败路径] 校验失败直接抛回 renderer；这里不吞异常，否则面板显示已确认但记录并没有写入。
  ipcMain.handle(
    PlatformChannels.AcknowledgePostUpdateReleaseNotes,
    async (_event, version: string) => {
      const validatedVersion = nonEmptyStringSchema.parse(version);
      await options.acknowledgePostUpdateReleaseNotes(validatedVersion);
    },
  );

  // [契约] 更新状态由调用方注入的 getUpdateState 提供，本层只透传；状态机与下载进度都在更新模块内。
  // [并发] 渲染层会轮询该通道，返回值必须是完整快照而不是部分字段，避免 UI 在两次轮询之间抖动。
  ipcMain.handle(PlatformChannels.GetUpdateState, () => options.getUpdateState());
  ipcMain.handle(PlatformChannels.OpenUpdateStatusWindow, () => {
    options.openUpdateStatusWindow();
  });
  // [契约] 自动更新偏好是异步读取，可能触发磁盘访问，renderer 必须 await；本层不在内存里缓存。
  // [契约] 读取与 SetAutoDownloadAndInstallUpdates 配对使用，写侧只接受 boolean，其它类型静默忽略。
  ipcMain.handle(PlatformChannels.GetAutoUpdatePreferences, () =>
    options.getAutoUpdatePreferences(),
  );
  ipcMain.handle(
    PlatformChannels.SetAutoDownloadAndInstallUpdates,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return;
      }
      await options.setAutoDownloadAndInstallUpdates(enabled);
    },
  );
  ipcMain.handle(PlatformChannels.GetDesktopSessionActivity, () =>
    options.getDesktopSessionActivity(),
  );
  // [契约] zoom 档位由缩放因子反解（对数换算加夹取），不能把因子直接透传；两者量纲不同，renderer 会因此算出错误缩放。
  // [失败路径] 窗口缺失或已销毁时返回 0 档位：对销毁中的窗口取缩放因子会抛错。
  // [契约] 返回值固定带 zoomLevel 字段，renderer 不再做 undefined 兜底。
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { zoomLevel: 0 };
    }

    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  // [契约] 窗口缺失按未最大化处理，但仍返回完整的 chrome 状态（macOS 主版本与 Win11 圆角能力），首帧即可决定标题栏样式。
  // [契约] 系统版本判定在 helper 内按 process.platform 计算，本层只负责提供 isMaximized。
  ipcMain.handle(PlatformChannels.GetDesktopWindowChromeState, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return resolveDesktopWindowChromeState(senderWindow?.isMaximized() ?? false);
  });
  // [契约] 只有字符串 filePath 才下发，其余形态统一传 undefined，让编辑器探测回退到全量列表。
  // [权衡] 探测结果不在此缓存，由渲染层按需重取；main 缓存会让用户新装编辑器后必须重启才可见。
  ipcMain.handle(PlatformChannels.GetInstalledEditors, (_event, filePath?: string) =>
    getInstalledEditors(typeof filePath === "string" ? filePath : undefined),
  );
  // [契约] request 必须支持字符串与结构化对象两种形态，归一化在 getApplicationIcon 内完成，本层不做形态判断。
  // [失败路径] 无法识别的请求返回 null，renderer 需按无图标处理并回退内置图标，不能假设一定有值。
  ipcMain.handle(
    PlatformChannels.GetApplicationIcon,
    (_event, request: string | ApplicationIconRequest) => getApplicationIcon(request),
  );
  // [契约] 设备标识由启动时注入的 deviceMid 提供，本层不读 userData 也不做哈希；重算会让同一台机器出现两个设备 id。
  // [契约] 同步返回值，renderer 首帧即可拿到，不需要等待异步初始化。
  ipcMain.handle(PlatformChannels.GetDeviceId, () => options.deviceMid);
  ipcMain.handle(PlatformChannels.ExportLogs, () => exportLogs());
  // [契约] 截图目标只能是发起窗口自身，不接受 renderer 指定窗口 id，避免跨窗口截取其它用户内容。
  // [失败路径] 窗口为空或已销毁时 helper 返回 null，renderer 要按无截图处理反馈附件。
  ipcMain.handle(PlatformChannels.CaptureWindowScreenshot, async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return captureWindowScreenshot(senderWindow);
  });
  // [契约] editorId、path、options 整体交给 openInEditor，本层不预判编辑器是否已安装：探测与启动失败由 helper 返回可展示错误。
  // [契约] 三个字段由 shared 的 OpenInEditorOptions 约束；在本层增删参数会与渲染层调用点脱节。
  ipcMain.handle(
    PlatformChannels.OpenInEditor,
    (_event, payload: { editorId: string; path: string; options?: OpenInEditorOptions }) =>
      openInEditor(payload.editorId, payload.path, payload.options),
  );

  // [契约] command 通道最后注册：它依赖 executeDesktopCommand 的命令白名单，白名单之外的 id 在分发器内被拒绝。
  // [契约] senderWindow 由分发器按 event.sender 解析，本层不传窗口，避免命令绑定到错误的窗口上下文。
  // [资源] 至此 platform 通道装配结束；函数返回后不应再有 ipcMain 注册，否则热重载会触发重复注册。
  registerDesktopCommandIpcHandler({
    executeDesktopCommand: options.executeDesktopCommand,
    logger: options.logger,
  });
}
