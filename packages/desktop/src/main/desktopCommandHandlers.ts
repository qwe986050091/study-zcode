import { getPluginSandboxHost } from "./pluginSandbox/index.js";
/* eslint-disable max-lines -- 桌面命令分发需要共享窗口与平台上下文，集中维护更便于一致性 */
// 做：必须把渲染层与原生菜单发来的 DesktopCommandId 映射成主进程动作（窗口、缩放、外链、数据清理）。
// 不做：不能承载 task/session 业务状态，不能直接操作 Repo 或 Agent 进程，也不定义命令 id（来自 shared 协议）。
// 依赖：electron 的 app/BrowserWindow/dialog/session/shell，以及 shared 的端点与产品身份解析函数。
// 契约：命令分发只允许有这一个入口；新增命令必须同时改 shared 常量、菜单模板与这里的 switch。
// 生命周期：主进程单例，所有动作都在 app ready 之后调用；清理类命令会重启进程，必须最后执行。
// 不变量（INV）：
// INV-01 断言：命令到动作的映射只在 executeDesktopCommand 的 switch 里存在 —— 守住它的位置：各 case 分支 —— 改错故障：菜单与侧边栏各自实现一份后行为分叉，同一命令在两种入口下效果不同。
// INV-02 断言：每个 case 必须 return，不允许贯穿 —— 守住它的位置：switch 的每个分支末尾 —— 改错故障：贯穿会顺带执行关闭窗口、清理数据等破坏性动作。
// INV-03 断言：目标窗口只在入口解析一次并向下传递 —— 守住它的位置：executeDesktopCommand 首行的 resolveTargetWindow —— 改错故障：各 case 内重复解析会拿到不同的聚焦窗口，命令作用到用户没在看的窗口。
// INV-04 断言：senderWindow 使用前必须校验 isDestroyed —— 守住它的位置：resolveTargetWindow —— 改错故障：对正在销毁的窗口发 webContents 消息会抛错并中断整个命令分发。
// INV-05 断言：缩放的唯一事实源是 webContents zoomFactor，档位由它反推 —— 守住它的位置：updateDesktopZoomLevel —— 改错故障：自维护档位会与 DevTools 或其他窗口改动脱节，出现“按一次跳两档”。
// INV-06 断言：updateDesktopZoomLevel 在无窗口时返回 undefined，调用方不得持久化 —— 守住它的位置：三个缩放 case 的返回值判断 —— 改错故障：把 undefined 写进设置，重启后缩放恢复失败。
// INV-07 断言：缩放变更必须同时持久化、通知渲染层并同步窗口按钮位置 —— 守住它的位置：updateDesktopZoomLevel 与 persistDesktopZoomLevel —— 改错故障：只改当前窗口会让重启丢失档位；不同步按钮会让 Windows 标题栏控件错位。
// INV-08 断言：清理全部数据的确认框默认与取消都指向“取消” —— 守住它的位置：clearAllDataAndRelaunch 的 defaultId 与 cancelId —— 改错故障：回车即删除凭据目录，操作不可恢复。
// INV-09 断言：只有 response 严格等于 1 才执行清除 —— 守住它的位置：clearAllDataAndRelaunch —— 改错故障：按钮顺序调整后会把取消当成确认。
// INV-10 断言：Coding Plan 与 Rewards 两个持久分区必须显式清理 —— 守住它的位置：clearCodingPlanWebviewStorage —— 改错故障：默认 session 清不到独立分区，退出登录后官网 webview 仍带着旧 token。
// INV-11 断言：ClearAllData 必须先清独立分区再执行全量清理 —— 守住它的位置：该 case 的两行调用顺序 —— 改错故障：全量清理会重启进程，反序导致分区数据从未被删除。
// INV-12 断言：先 app.relaunch 再 app.exit —— 守住它的位置：clearAllDataAndRelaunch 末尾 —— 改错故障：先退出会让重启请求没有入队，应用直接消失。
// INV-13 断言：打包态配置文件只能从 resourcesPath 解析 —— 守住它的位置：resolveLocalAppConfigPath —— 改错故障：从 app.asar 上两级会读到不存在的目录，帮助菜单外链全部缺失。
// INV-14 断言：远端配置失败不能阻断本地兜底 —— 守住它的位置：resolveRemoteAppConfigValue 的两段独立 try —— 改错故障：断网时反馈与社区入口整体消失。
// INV-15 断言：空字符串不算配置命中，必须继续下一层 —— 守住它的位置：两端 resolveFromConfig 的返回值判断 —— 改错故障：远端返回空值时吞掉本地有效地址。
// INV-16 断言：HTML 属性转义必须先 & 再其余字符 —— 守住它的位置：escapeHtmlAttribute —— 改错故障：后转 & 会把已生成的实体二次转义，用户看到 &amp;quot; 这类字面量。
// INV-17 断言：端点覆盖只能在非生产环境生效 —— 守住它的位置：setZCodeEndpointOverride 的首个判断 —— 改错故障：正式包允许改端点，用户可被引导到任意后端。
// INV-18 断言：自定义端点弹窗以 undefined 表示取消，调用方必须直接返回 —— 守住它的位置：SetZCodeEndpointCustom 分支 —— 改错故障：取消后把空值写入设置，端点被清空。
// INV-19 断言：检查更新按产品身份而不是后端端点放行 —— 守住它的位置：CheckForUpdates 分支 —— 改错故障：Preview 包连生产后端时放出必然失败的手动检查。
import { readZCodeStdioTapDevState, setZCodeStdioTapDevEnabled } from "@zcode/services/node";
import {
  buildZCodeEndpointUrls,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  DesktopCommandIds,
  REWARDS_PARTITION,
  TEST_ZCODE_ENDPOINT_ORIGIN,
  getCommunityUrlFromConfigs,
  getFeedbackUrlFromConfig,
  normalizeZCodeEndpointOrigin,
  PlatformChannels,
  resolveHelpAppConfig,
  resolveZCodeEndpointOrigin,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  type AppSettings,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import type { MessageBoxOptions } from "electron";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { showAboutDialog } from "./about.js";
import { checkForUpdateMenuClick } from "./autoUpdater.js";
import { resolveCuaOsSupport } from "./cuaOsSupport.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import {
  DEFAULT_DESKTOP_WINDOW_HEIGHT,
  DEFAULT_DESKTOP_WINDOW_WIDTH,
} from "./desktopWindowSize.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { exportLogs } from "./exportLogs.js";
import { openResourceManager } from "./resourceManagerWindow.js";

// [契约] 菜单项 id 必须是稳定字符串：菜单模板与点击处理靠它对应，改字符串要同步两侧。
// [契约] 这两个 id 只在开发与排障菜单里使用，不进入跨进程协议，所以不进 shared 常量表。
// [权衡] 放在本文件而不是 shared：它们不参与渲染层通信，放 shared 只会扩大协议面。
export const HELP_TOGGLE_DEV_TOOLS_MENU_ID = "help.toggle-dev-tools";
export const HELP_TOGGLE_ZCODE_STDIO_TAP_MENU_ID = "help.toggle-zcode-stdio-tap";
// [契约] 尺寸与内联 HTML 的布局强耦合：改宽度要同时检查提示文案与按钮是否换行。
// [契约] 高度写死而不是自动测量，是因为 data: URL 页面在创建前无法测量内容高度。
// [权衡] 不用原生消息框的原因只有一条：这里需要文本输入，MessageBox 不提供。
const ZCODE_ENDPOINT_PROMPT_WIDTH = 460;
const ZCODE_ENDPOINT_PROMPT_HEIGHT = 210;
// [契约] 该 partition 名必须与 webview 创建处字面一致：不一致时清理的是一个空 session，
// 旧账号 token 仍留在真正使用的分区里，表现为“退出登录后又自动登录”。
// [契约] persist: 前缀表示落盘，改成内存分区会让登录态在重启后丢失。
const CODING_PLAN_WEBVIEW_PARTITION = "persist:zcode-coding-plan";

// [契约] 优先级固定为发送者、聚焦窗口、任意窗口：菜单命令没有 sender，侧边栏命令有 sender，
// 两种入口必须落到同一个窗口，否则命令会作用到后台窗口。
// [失败路径] sender 可能已销毁（窗口正在关闭），必须先用 isDestroyed 过滤再使用。
// [契约] 返回 null 而不是抛错：无窗口时命令静默跳过，避免主进程因一次菜单点击崩溃。
function resolveTargetWindow(senderWindow?: BrowserWindow | null) {
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }

  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
// [契约] 缩放以 zoomFactor 而不是 zoomLevel 为准：Electron 的 zoomLevel 是 1.2 的幂，
// 这里每档需要统一 1.1，混用会让档位与显示比例对不上。
// [失败路径] 无窗口或窗口已销毁时返回 undefined，调用方据此跳过持久化。
// [契约] 改完必须通知渲染层并同步窗口按钮位置：缩放会改变标题栏高度，
// 不重算会让 Windows 上的最小化、关闭按钮错位。
export function updateDesktopZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  action: "reset" | "in" | "out",
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  // [契约] 从当前 factor 反推档位而不是用内存变量：DevTools 或其他窗口也可能改过缩放，
  // 只有 factor 是唯一事实源。
  // [契约] 反推后仍要 clamp，防止历史配置中的越界值被继续放大。
  const currentLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  const nextLevel =
    action === "reset" ? 0 : clampDesktopZoomLevel(currentLevel + (action === "in" ? 1 : -1));

  // 系统缩放快捷键需要可用，但不能无限放大/缩小导致界面失控。
  // Electron zoomLevel 的真实比例是 1.2^level；这里改用 zoomFactor，保证每档统一为 1.1。
  // [契约] 应用 factor 与同步 overlay 必须在同一个同步块内完成：中间插入渲染会让用户看到一帧错位的按钮。
  // [契约] 用 resolveDesktopZoomFactorForLevel 而不是直接写 1.1，保证夹取与档位定义只有一处实现。
  // [契约] 改完立刻广播 DesktopZoomLevelChanged：其他窗口与菜单勾选状态依赖该事件。
  targetWindow.webContents.setZoomFactor(resolveDesktopZoomFactorForLevel(nextLevel));
  syncWindowControlsOverlayForZoomLevel(targetWindow, nextLevel);
  targetWindow.webContents.send(PlatformChannels.DesktopZoomLevelChanged, { zoomLevel: nextLevel });
  return nextLevel;
}

// [契约] 有父窗口时必须用父窗口重载：模态框挂在正确窗口上，macOS 下不会跑到其他桌面。
// [权衡] 没有父窗口时退回无父调用，否则启动早期（窗口尚未创建）会一直等不到宿主。
function showMessageBoxWithOptionalParent(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}
// [契约] 确认框的默认按钮与取消按钮都指向取消，回车不能触发不可恢复的清除。
// [事务] 逐段清理并分别记录错误：任一段失败仍要继续，最后统一重启，
// 不能因为一次目录删除失败就停在半清状态。
// [契约] 先 relaunch 再 exit：反序会让进程先退出，重启请求没有被排入队列。
async function clearAllDataAndRelaunch(options: {
  credentialsDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  // [契约] 只有 response 严格等于 1 才执行清除：按钮顺序变化时索引也要跟着变，
  // 用“非默认按钮”这类判断会把取消当成确认。
  // [契约] 这是唯一删除 ~/.zcode/v2 的入口，必须留在主进程，不能让渲染层直接触发。
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Clear All"],
    defaultId: 0,
    cancelId: 0,
    title: "Clear All Data",
    message: "确定要清除所有数据吗？",
    detail:
      "将删除 ~/.zcode/v2（配置、凭据、日志）和浏览器缓存（localStorage）。操作不可恢复，清除后应用将自动重启。",
  });
  if (response !== 1) {
    return;
  }

  // [契约] 插件沙箱使用独立 session，必须先清它再清默认窗口：宿主窗口关闭后就拿不到实例了。
  // [失败路径] 宿主不存在时用可选调用跳过，开发环境可能根本没启动沙箱。
  await getPluginSandboxHost()?.clearBrowserData();
  const { rm } = await import("node:fs/promises");
  try {
    await rm(options.credentialsDir, { recursive: true, force: true });
    options.logger.info("[clear-all-data] deleted ~/.zcode/v2");
  } catch (error) {
    options.logger.error("[clear-all-data] failed to delete ~/.zcode/v2:", error);
  }

  // [契约] 逐窗口执行渲染层脚本，单个窗口失败只影响自己（窗口可能已在销毁流程中）。
  // [权衡] 不用 session.clearStorageData 代替：localStorage 属于渲染层域，
  // 部分窗口的自定义 partition 不会被默认 session 覆盖。
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript("localStorage.clear()");
    } catch {
      // 窗口可能已经销毁，忽略
    }
  }

  try {
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (session) {
      await session.clearStorageData();
      options.logger.info("[clear-all-data] cleared session storage data");
    }
  } catch (error) {
    options.logger.error("[clear-all-data] failed to clear session data:", error);
  }

  // [契约] relaunch 与 exit 之间不能插入异步操作：exit 立即结束进程，后续代码不会执行。
  // [契约] 用 exit(0) 而不是 quit：quit 会再走一遍窗口关闭流程，可能被未保存草稿的确认挡住。
  // [失败路径] 此时不再提示保存：数据目录已被删除，继续留在旧进程只会读到缺失的配置。
  app.relaunch();
  app.exit(0);
}

// [契约] 这两个分区都不在默认窗口 session 下，退出登录与清数据时必须显式清理。
// [契约] 两个分区都要清：Coding Plan 与 Rewards 各自持久化，只清一个会残留身份信息。
// [失败路径] 清理失败只 warn 不抛：主流程还要继续重启，但必须留日志，
// 否则用户反馈“退出登录后仍自动登录”时无从定位。
export async function clearCodingPlanWebviewStorage(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}) {
  try {
    // Coding Plan webview 使用独立持久 partition，默认窗口 session.clearStorageData()
    // 不会覆盖它；退出登录/清理数据时必须显式清除，避免旧账号 token 被下一次官网首屏读到。
    // [契约] 用 persist: 分区名直接取 session，不依赖窗口是否存在：
    // 退出登录可能发生在窗口已关闭的时刻，persist: 分区清理仍然必须执行。
    await session.fromPartition(CODING_PLAN_WEBVIEW_PARTITION).clearStorageData();
    await session.fromPartition(REWARDS_PARTITION).clearStorageData();
    options.logger.info("[coding-plan-webview] cleared persistent partition storage");
  } catch (error) {
    options.logger.warn(
      "[coding-plan-webview] failed to clear persistent partition storage:",
      error,
    );
  }
}

// [契约] 缺少读取实现时抛错而不是返回空：上层会把它记成 warn，从而暴露“帮助配置未注入”。
// [权衡] 这里不做超时：超时策略属于注入实现，主进程再包一层会让超时来源难以判断。
// [契约] 返回值保持 unknown：远程配置结构由各解析器自行校验，这里不假设字段。
async function fetchRemoteAppConfig(fetchRemoteConfig?: () => Promise<unknown>): Promise<unknown> {
  if (!fetchRemoteConfig) throw new Error("Help config reader is unavailable");
  return fetchRemoteConfig();
}

// [契约] 打包态必须从 resourcesPath 解析：app.getAppPath() 指向 resources/app.asar，
// 向上两级会读到 Contents/config 这个不存在的位置。
// [契约] 开发态用 appPath 上两级定位仓库根的 config/default.json，两种路径不能合并成一个表达式。
// [权衡] 参数可注入便于单测；不传时回落到 Electron 运行时值。
export function resolveLocalAppConfigPath(options?: {
  appPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    // app.getAppPath() 在正式包中指向 resources/app.asar，向上两级后会误读
    // Contents/config。内置配置由 electron-builder 放在 resources/config，必须从 resourcesPath 解析。
    return join(options?.resourcesPath ?? process.resourcesPath, "config/default.json");
  }
  return join(options?.appPath ?? app.getAppPath(), "../../config/default.json");
}

// [契约] 允许调用方注入读取实现（单测与预览环境），否则按解析出的路径直接读文件并解析 JSON。
// [失败路径] 解析失败向上抛，由调用方决定是否降级；这里不做静默兜底，配置格式错误必须被发现。
async function readLocalAppConfig(readLocalConfig?: () => unknown): Promise<unknown> {
  const localConfigPath = resolveLocalAppConfigPath();
  return readLocalConfig?.() ?? JSON.parse(await readFile(localConfigPath, "utf-8"));
}

// [契约] resolveRemoteAppConfigValue 优先读远端配置、本地配置兜底：远端可随时调整外链，本地是离线与首启的保底。
// [失败路径] 两次读取各自 try/catch：远端超时不能阻止本地兜底，
// 否则断网时帮助菜单里的入口会整体消失。
// [契约] resolveRemoteAppConfigValue 只有解析出非空字符串才算命中，空串继续走下一层。
async function resolveRemoteAppConfigValue(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  resolveFromConfig: (config: unknown) => string | undefined;
  logPrefix: "feedback" | "community";
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  try {
    const remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
    // [契约] 命中即返回，不再读本地文件：远端与本地不一致时以远端为准，同时省掉一次文件 IO。
    // [失败路径] 解析函数自身抛错也落在外层 catch 内，不会因为一个坏字段跳过整份配置。
    const remoteResolvedValue = options.resolveFromConfig(remoteConfig);
    if (remoteResolvedValue) {
      return remoteResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to fetch remote config:`, error);
  }

  try {
    const localConfig = await readLocalAppConfig(options.readLocalConfig);
    // [失败路径] 本地也解析不出时返回 undefined，由调用方决定隐藏入口还是报错，这里不替产品做决策。
    const localResolvedValue = options.resolveFromConfig(localConfig);
    if (localResolvedValue) {
      return localResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to read local config:`, error);
  }

  return undefined;
}

// [契约] resolveFeedbackUrl 只取地址、不打开：调用方可能只想判断入口是否可用。
// [契约] 解析器固定为 getFeedbackUrlFromConfig，不允许调用方覆盖，避免反馈入口读错配置键。
// [权衡] 与 openFeedback 分开，是为了让内嵌对话框路径也能复用同一套地址解析。
export async function resolveFeedbackUrl(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  return resolveRemoteAppConfigValue({
    ...options,
    logPrefix: "feedback",
    resolveFromConfig: getFeedbackUrlFromConfig,
  });
}

// [契约] 两份配置必须独立收集：远端失败仍要读本地，本地失败也要用远端，
// 所以不能套用 resolveRemoteAppConfigValue 的两级短路写法。
// [契约] 语言分支交给 getCommunityUrlFromConfigs，保证与 UI 语言选择共用同一套规则。
export async function resolveCommunityUrl(options: {
  locale: Locale;
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  let remoteConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
  } catch (error) {
    options.logger.warn("[community] failed to fetch remote config:", error);
  }

  let localConfig: unknown;
  try {
    localConfig = await readLocalAppConfig(options.readLocalConfig);
  } catch (error) {
    options.logger.warn("[community] failed to read local config:", error);
  }

  // [契约] 两份配置一起传入而不是先合并：合并会掩盖远端有键但值为空这类差异。
  // [契约] 具体字段与语言回退由该工具函数决定，调用方不要再做 locale 分支。
  return getCommunityUrlFromConfigs(remoteConfig, localConfig, options.locale);
}

// [契约] 两种反馈形态由配置决定：内嵌对话框走 IPC 交给渲染层，外部表单走系统浏览器。
// [契约] 内嵌形态必须发给目标窗口而不是任意窗口：多窗口下反馈框会出现在用户没在看的窗口里。
// [失败路径] 配置缺失时 feedback_url 为空，什么都不做而不是打开空白页。
async function openFeedback(
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  targetWindow?: BrowserWindow | null,
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  let remoteConfig: unknown;
  let localConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(fetchRemoteConfig);
  } catch (error) {
    logger.warn("[feedback] failed to fetch remote config:", error);
  }
  try {
    localConfig = await readLocalAppConfig();
  } catch (error) {
    logger.warn("[feedback] failed to read local config:", error);
  }
  const config = resolveHelpAppConfig(remoteConfig, localConfig);
  // [契约] 这里只发 IPC、不等待回执：反馈框的打开时机由渲染层控制，主进程等待会阻塞命令队列。
  // [失败路径] 目标窗口为 null 时可选调用跳过，不能退回广播到所有窗口。
  if (!config.feedback_use_external_form) {
    resolveTargetWindow(targetWindow)?.webContents.send(PlatformChannels.OpenFeedbackDialog);
    return;
  }
  if (config.feedback_url) await shell.openExternal(config.feedback_url);
}

// [契约] 社区链接缺失只 warn 不弹错：菜单项点了没反应可以接受，弹一个错误框不行。
// [契约] 用 shell.openExternal 交给系统浏览器：社区页需要用户自己的登录态。
async function openCommunity(
  locale: Locale,
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  },
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  const communityUrl = await resolveCommunityUrl({ locale, logger, fetchRemoteConfig });
  if (!communityUrl) {
    logger.warn("[community] community_urls is missing from both remote and local config");
    return;
  }
  await shell.openExternal(communityUrl);
}

// [契约] 父窗口已销毁时降级为无父弹窗，而不是直接失败：菜单命令可能在窗口关闭动画期间触发。
// [契约] 返回 undefined 同时表示取消与失败，调用方只需区分有没有值。
// [契约] 这里不校验地址格式：校验在 setZCodeEndpointOverride 内统一完成，避免两处规则不一致。
async function promptCustomZCodeEndpoint(
  targetWindow: BrowserWindow | null | undefined,
  currentValue: string,
): Promise<string | undefined> {
  return showZCodeEndpointPromptWindow({
    currentValue,
    parentWindow: targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined,
  });
}

// [契约] 转义顺序不可调换：必须先转 &，否则后面生成的实体中的 & 会被再次转义。
// [契约] 该转义只用于 HTML 属性值，不能用于 script 内容：那里需要 JS 转义，HTML 实体不生效。
// [权衡] 不引入完整转义库：这是主进程内联模板，依赖越少启动越稳。
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// [契约] 提交与取消通过 document.title 回传，而不是 preload 或 IPC：
// 该窗口 sandbox 且无 nodeIntegration，title 是唯一不需要额外权限的通道。
// [契约] 前缀与主进程解析处必须字面一致，任何一侧改动都会让用户输入被丢弃。
// [契约] 输入值必须转义后再放进 value 属性，否则地址里带引号就能跳出属性注入脚本。
function buildZCodeEndpointPromptHtml(currentValue: string): string {
  const value = escapeHtmlAttribute(currentValue);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>ZCode Endpoint</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; height: 34px; padding: 6px 8px; font: inherit; }
      .hint { margin-top: 8px; color: #6b7280; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
      button { min-width: 78px; height: 30px; font: inherit; }
    </style>
  </head>
  <body>
    <form id="form">
      <label for="endpoint">ZCode endpoint origin</label>
      <input id="endpoint" value="${value}" placeholder="https://zcode.z.ai" spellcheck="false" />
      <div class="hint">Use an http or https origin, for example https://zcode.z.ai.</div>
      <div class="actions">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
    <script>
      const input = document.getElementById("endpoint");
      const submit = (value) => { document.title = "zcode-endpoint-submit:" + encodeURIComponent(value); };
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        submit(input.value);
      });
      document.getElementById("cancel").addEventListener("click", () => {
        document.title = "zcode-endpoint-cancel";
      });
      input.focus();
      input.select();
    </script>
  </body>
</html>`;
}

// [契约] 返回 Promise 而不是回调：调用方需要拿到字符串做校验与持久化，取消路径也必须可表达。
// [契约] modal 只在存在父窗口时开启：无父窗口的 modal 子窗口在 Linux 下可能拿不到焦点。
// [失败路径] closed 事件同样要 finish(undefined)：点系统关闭时没有 title 变化，只能靠它兜底。
function showZCodeEndpointPromptWindow(options: {
  currentValue: string;
  parentWindow?: BrowserWindow;
}): Promise<string | undefined> {
  // [契约] settled 标志保证只结算一次：title 变化与 closed 可能连发两次，
  // 重复结算虽无害，但会让“先取消后提交”的竞态难以排查。
  // [资源] finish 内先 resolve 再关窗：关窗触发的 closed 回调会被 settled 挡掉，不会递归。
  return new Promise((resolve) => {
    let settled = false;
    const promptWindow = new BrowserWindow({
      width: ZCODE_ENDPOINT_PROMPT_WIDTH,
      height: ZCODE_ENDPOINT_PROMPT_HEIGHT,
      parent: options.parentWindow,
      modal: Boolean(options.parentWindow),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "ZCode Endpoint",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // [契约] 关闭一律按取消处理：没有提交前缀就等于用户放弃修改，不能沿用旧值。
    // [资源] 关窗前判 isDestroyed，避免对已在销毁流程的窗口调用 close 触发异常。
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
    };

    // [契约] page-title-updated 只认两个前缀，其余标题变化一律放行：
    // 页面本身没有动态标题，但 Chromium 可能改写空标题。
    // [契约] 命中时必须 preventDefault，否则标题真的被改掉，标题栏出现协议字符串。
    promptWindow.on("closed", () => finish(undefined));
    promptWindow.on("page-title-updated", (event, title) => {
      if (title === "zcode-endpoint-cancel") {
        event.preventDefault();
        finish(undefined);
        return;
      }
      if (!title.startsWith("zcode-endpoint-submit:")) {
        return;
      }
      event.preventDefault();
      finish(decodeURIComponent(title.slice("zcode-endpoint-submit:".length)));
    });

    // Electron 菜单命令在主进程触发，调用 renderer 的 window.prompt 可能被禁用或没有焦点，表现为点击无反应。
    // 这里改为主进程创建受控 modal 输入窗，确保 Custom... 始终有可见交互入口。
    // [契约] 用 data: URL 加载内联页面：不落盘、不依赖 renderer 包，启动早期也能用。
    // [权衡] 不 await 加载结果：失败由窗口 closed 兜底为取消，在这里 await 反而无法区分失败态。
    void promptWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildZCodeEndpointPromptHtml(options.currentValue),
      )}`,
    );
  });
}

// [契约] 生产构建直接返回：正式包不允许改写后端端点，这是环境隔离边界而不是功能开关。
// [失败路径] 静默返回而不是抛错：菜单项在生产环境仍可见，点一下无害退出是预期行为。
// [事务] 先写设置再通知上层刷新：反序会让上层读到旧端点，重建的连接仍指向旧 host。
async function setZCodeEndpointOverride(options: {
  value: string | undefined;
  settingService: { update(patch: { zcodeEndpointOrigin?: string | undefined }): Promise<void> };
  onZCodeEndpointChanged: () => Promise<void> | void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  // [契约] 该判断必须在 normalize 之前：生产环境连校验都不做，避免任何副作用。
  // [契约] 返回值保持 void，调用方不应依赖“是否真的写入”。
  if (ZCODE_ENV === "production") {
    return;
  }
  const normalized = options.value ? normalizeZCodeEndpointOrigin(options.value) : undefined;
  await options.settingService.update({ zcodeEndpointOrigin: normalized });
  await options.onZCodeEndpointChanged();
}

// [契约] 持久化失败必须只 warn，不阻断缩放：缩放已经生效，回滚用户可见行为更糟。
// [契约] 写入夹取后的档位而不是原始动作，保证重启恢复时不会越界。
async function persistDesktopZoomLevel(options: {
  zoomLevel: number;
  logger: { warn: (...args: unknown[]) => void };
  settingService: { update(patch: Pick<AppSettings, "desktopZoomLevel">): Promise<void> };
}) {
  try {
    // 桌面缩放命令原本只改当前 BrowserWindow，重启后没有任何恢复来源。
    // 这里在命令成功后把夹取后的档位写入 setting.json，让快捷键、View 菜单和侧边栏菜单共享同一持久化事实源。
    await options.settingService.update({ desktopZoomLevel: options.zoomLevel });
  } catch (error) {
    options.logger.warn("[desktop-zoom] persist zoom level failed:", error);
  }
}

function toggleZCodeStdioTapDevProxy(options: {
  logger: { info: (...args: unknown[]) => void };
  updateZCodeStdioTapDevMenuState: () => void;
}) {
  const current = readZCodeStdioTapDevState();
  const next = setZCodeStdioTapDevEnabled(!current.enabled);
  options.updateZCodeStdioTapDevMenuState();
  options.logger.info("[stdio-tap] dev proxy toggled", {
    enabled: next.enabled,
    visible: next.visible,
    logDir: next.logDir,
  });
}

// [契约] 语言只影响路径段，origin 来自当前端点配置：写死英文地址会让中文界面跳到英文 changelog。
// [契约] 用 buildZCodeEndpointUrls 拼 origin，不手写字符串：端点可能带路径前缀。
function resolveChangelogUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
): string {
  // 帮助菜单里的外链以前只有固定英文地址，切到中文界面后仍会落到英文 changelog。
  // 这里统一收口到主进程按当前应用语言分流，避免菜单模板里手写分支后续再出现多处不一致。
  const origin = buildZCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn/changelog` : `${origin}/en/changelog`;
}

export async function openChangelog(
  locale: Locale,
  endpointOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN,
) {
  await shell.openExternal(resolveChangelogUrl(locale, endpointOrigin));
}

// [契约] override 优先于环境变量与默认值，优先级由 resolveZCodeEndpointOrigin 统一实现，
// resolveCurrentZCodeEndpointOrigin 不重复判断，避免两处规则漂移。
async function resolveCurrentZCodeEndpointOrigin(settingService: {
  get(): Promise<{ zcodeEndpointOrigin?: string }>;
  envBaseOrigin?: string | null;
}): Promise<string> {
  const settings = await settingService.get();
  return resolveZCodeEndpointOrigin({
    env: ZCODE_ENV,
    envBaseOrigin: settingService.envBaseOrigin,
    overrideOrigin: settings.zcodeEndpointOrigin,
  });
}

// [契约] 这是渲染层与原生菜单共用的唯一命令入口：各处菜单模板只发 id，不各自实现动作。
// [契约] 入口先解析目标窗口并记录 windowId：日志能区分“没有窗口”与“命令未实现”。
// [契约] 只有需要持久化或弹窗的命令才 await，其余 fire-and-forget：菜单点击不应被磁盘 IO 卡住。
export async function executeDesktopCommand(options: {
  command: DesktopCommandId;
  fetchHelpConfig?: () => Promise<unknown>;
  senderWindow?: BrowserWindow | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  updateZCodeStdioTapDevMenuState: () => void;
  onDesktopZoomChanged?: (zoomLevel: number) => Promise<void> | void;
  onZCodeEndpointChanged: () => Promise<void> | void;
  onRelaunchApp: () => Promise<void>;
  settingService: {
    get(): Promise<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>;
    update(
      patch: Partial<Pick<AppSettings, "zcodeEndpointOrigin" | "desktopZoomLevel">>,
    ): Promise<void>;
  };
  zcodeEndpointEnvBaseOrigin?: string | null;
  credentialsDir: string;
  currentApplicationLocale: Locale;
}) {
  // [契约] 只解析一次并向下传递：各 case 内部再取窗口会拿到不同的聚焦窗口，
  // 用户在点击后切换窗口会让命令作用到另一个窗口。
  // [契约] 日志必须带 windowId：多窗口下排查“命令没反应”，第一件事是确认发给了谁。
  // [失败路径] targetWindow 可能为 null，所有 case 都必须能容忍。
  const targetWindow = resolveTargetWindow(options.senderWindow);
  options.logger.info(
    `[desktop-command] execute ${options.command} windowId=${targetWindow?.id ?? "<none>"}`,
  );

  // [契约] 用 DesktopCommandIds 常量而不是字符串字面量：id 是跨进程协议的一部分，
  // 手写字符串在重命名后不会编译报错。
  // [契约] 每个 case 都必须 return，不允许贯穿：命令副作用差异极大，贯穿会误触发关闭窗口。
  // [契约] 未匹配的命令不报错：新旧版本混跑时，未知命令应当静默忽略。
  switch (options.command) {
    // [契约] 新建任务只转发事件、不在这里创建会话：会话归属与草稿都在渲染层，
    // 主进程提前建会话会产生一条没有 UI 的孤儿任务。
    // [失败路径] 无窗口时事件被丢弃，这是有意为之，不排队等窗口出现。
    case DesktopCommandIds.NewTask:
      targetWindow?.webContents.send(PlatformChannels.NewTask);
      return;
    case DesktopCommandIds.OpenWorkspace:
      targetWindow?.webContents.send(PlatformChannels.OpenWorkspace);
      return;
    case DesktopCommandIds.CloseActiveContext:
      targetWindow?.webContents.send(PlatformChannels.CloseActiveContextRequest);
      return;
    // [契约] 走 close 而不是 destroy：close 会经过未保存草稿的确认与窗口关闭钩子。
    // [契约] 不等待窗口真正关闭，命令立即返回，避免调用方挂起。
    case DesktopCommandIds.CloseWindow:
      targetWindow?.close();
      return;
    case DesktopCommandIds.MinimizeWindow:
      targetWindow?.minimize();
      return;
    // [契约] 必须用 isMaximized 现场取反，不维护自己的布尔：用户可能通过系统手势改变窗口状态，
    // 自维护状态会与实际不同步。
    // [失败路径] 无窗口时什么都不做，避免对 null 调用。
    case DesktopCommandIds.ToggleMaximizeWindow:
      if (targetWindow?.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow?.maximize();
      }
      return;
    case DesktopCommandIds.ToggleFullScreen:
      if (targetWindow) {
        targetWindow.setFullScreen(!targetWindow.isFullScreen());
      }
      return;
    // [契约] 顺序固定：先退全屏、再取消最大化、最后 setSize。
    // macOS 全屏下 setSize 会被忽略，最大化状态下尺寸也会被系统改回去。
    // [契约] 最后一个参数 true 表示带动画，与用户从菜单触发的预期一致。
    case DesktopCommandIds.ResetWindowSize:
      if (targetWindow) {
        if (targetWindow.isFullScreen()) targetWindow.setFullScreen(false);
        if (targetWindow.isMaximized()) targetWindow.unmaximize();
        targetWindow.setSize(DEFAULT_DESKTOP_WINDOW_WIDTH, DEFAULT_DESKTOP_WINDOW_HEIGHT, true);
      }
      return;
    // [契约] 只有拿到有效 nextLevel 才持久化并通知：无窗口时 update 返回 undefined，
    // 照常写入会把设置改成 undefined。
    // [契约] 通知上层放在持久化之后：上层重渲染时读到的必须是已落盘的值。
    case DesktopCommandIds.ResetZoom:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "reset");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomIn:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "in");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomOut:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "out");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    // [契约] 关于对话框是原生窗口、不经过渲染层，语言必须用当前应用语言，
    // 不能从系统 locale 推断，否则与界面语言不一致。
    case DesktopCommandIds.ShowAbout:
      await showAboutDialog(targetWindow ?? undefined, options.currentApplicationLocale);
      return;
    // [契约] 先解析当前端点再拼地址：自定义端点下 changelog 也应在同一 host，
    // 否则内网部署会跳到公网域名。
    // [契约] 语言来自应用状态而非 navigator，理由同关于对话框。
    case DesktopCommandIds.OpenChangelog:
      await openChangelog(
        options.currentApplicationLocale,
        await resolveCurrentZCodeEndpointOrigin({
          ...options.settingService,
          envBaseOrigin: options.zcodeEndpointEnvBaseOrigin,
        }),
      );
      return;
    // [契约] 按产品身份而不是后端端点判断：Preview 包即使连生产后端也没有更新器，
    // 按端点放行会给出必然失败的手动检查。
    // [失败路径] 非生产身份只记 info、不弹错误框：这是预期限制，不是故障。
    case DesktopCommandIds.CheckForUpdates:
      // 按产品身份而不是后端环境放行：生产后端的 Preview 同样没有更新器。
      if (ZCODE_PRODUCT_FLAVOR === "production") {
        checkForUpdateMenuClick(targetWindow);
      } else {
        options.logger.info("[auto-update] Preview 已禁用手动更新检查");
      }
      return;
    // [契约] 重启交给上层注入：主进程要先 flush 日志并清理子进程，
    // 在这里直接调用 app.relaunch 会跳过这些步骤。
    case DesktopCommandIds.RelaunchApp:
      await options.onRelaunchApp();
      return;
    case DesktopCommandIds.OpenFeedback:
      await openFeedback(options.logger, targetWindow, options.fetchHelpConfig);
      return;
    case DesktopCommandIds.OpenCommunity:
      await openCommunity(
        options.currentApplicationLocale,
        options.logger,
        options.fetchHelpConfig,
      );
      return;
    // [契约] 必须 await：用户导出后会立刻打开目录，fire-and-forget 会让目录还是空的。
    case DesktopCommandIds.ExportLogs:
      await exportLogs();
      return;
    case DesktopCommandIds.ToggleDevTools:
      targetWindow?.webContents.toggleDevTools();
      return;
    case DesktopCommandIds.OpenResourceManager:
      openResourceManager();
      return;
    case DesktopCommandIds.ToggleZCodeStdioTapDevProxy:
      toggleZCodeStdioTapDevProxy({
        logger: options.logger,
        updateZCodeStdioTapDevMenuState: options.updateZCodeStdioTapDevMenuState,
      });
      return;
    // [契约] 写回默认端点而不是清空 override：清空会回落到环境变量，
    // 而“切回生产”的语义必须由显式指定生产地址表达。
    // [契约] 三个端点命令共用 setZCodeEndpointOverride，生产构建下全部静默无效。
    case DesktopCommandIds.SetZCodeEndpointProduction:
      await setZCodeEndpointOverride({
        value: DEFAULT_ZCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetZCodeEndpointTest:
      await setZCodeEndpointOverride({
        value: TEST_ZCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    // [契约] 当前值优先取 override，其次默认生产端点：输入框要显示“当前生效值”，
    // 显示环境变量值会让用户误以为 override 已存在。
    // [失败路径] 弹窗返回 undefined 表示取消，直接 return，绝不能把空值写进设置。
    // [失败路径] 校验失败要弹原生错误框：地址格式错误必须让用户立刻看到原因，而不是静默回滚。
    case DesktopCommandIds.SetZCodeEndpointCustom: {
      const current =
        (await options.settingService.get()).zcodeEndpointOrigin ?? DEFAULT_ZCODE_ENDPOINT_ORIGIN;
      const value = await promptCustomZCodeEndpoint(targetWindow, current);
      if (!value) {
        return;
      }
      try {
        await setZCodeEndpointOverride({
          value,
          settingService: options.settingService,
          onZCodeEndpointChanged: options.onZCodeEndpointChanged,
          logger: options.logger,
        });
      } catch (error) {
        await showMessageBoxWithOptionalParent(targetWindow, {
          type: "error",
          title: "ZCode Endpoint",
          message: "Endpoint 无效",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case DesktopCommandIds.ResetZCodeEndpoint:
      await setZCodeEndpointOverride({
        value: undefined,
        settingService: options.settingService,
        onZCodeEndpointChanged: options.onZCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    // [事务] 先清 Coding Plan 分区再清全量数据：后者会重启进程，
    // 反序会让独立分区在重启前根本没被清掉。
    // [契约] 该命令会删除凭据目录与 localStorage，二次确认在 clearAllDataAndRelaunch 内完成。
    case DesktopCommandIds.ClearAllData:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      await clearAllDataAndRelaunch({
        credentialsDir: options.credentialsDir,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearCodingPlanWebviewStorage:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      return;
    // [契约] 这是唯一用返回值而不是发事件的命令：调用方需要同步拿到能力位，
    // 复用 IPC 返回值，避免再设计一条反向查询通道。
    case DesktopCommandIds.GetCuaOsSupport:
      return resolveCuaOsSupport();
  }
}
