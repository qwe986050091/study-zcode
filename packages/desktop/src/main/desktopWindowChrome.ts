/* eslint-disable max-lines -- 桌面窗口 chrome、webview 安全策略和 popup 路由共享同一 BrowserWindow 生命周期上下文。 */
// desktopWindowChrome.ts —— 主进程桌面窗口 chrome 的唯一装配点：必须创建 BrowserWindow、写视觉与缩放参数、
// 同步窗口状态、硬化 webview guest 并接管 popup/导航路由、构建原生右键菜单与 Dock 图标。
// 不负责：renderer 侧窗口控件布局与主题 token、会话/task 状态、插件 UI 渲染；也不决定 tab 归属，只把 owner 透传出去。
//
// INV 不变量（INV-01 ~ INV-20，任一破坏都会在线上表现为可复现故障）：
// INV-01 断言：每个 webview 的 preload 只能是 codingPlan / rewards / 原生 Dialog 桥三者之一 —— 守住它的位置：will-attach-webview 的 preload 赋值分支 —— 改错故障：官网购买完成信号回传失效，或网页绕过原生 Dialog 拿到任意 IPC。
// INV-02 断言：guest 的 contextIsolation 必须为 true、nodeIntegration 必须为 false、sandbox 必须为 true —— 守住它的位置：will-attach-webview 的偏好覆写段 —— 改错故障：网页脚本可直接触达 Node 内置模块或关闭同源策略。
// INV-03 断言：派生偏好与 attach 参数里的 nodeIntegrationInSubFrames 必须同时为 true —— 守住它的位置：preferences 赋值与 params.nodeintegrationinsubframes 字符串 —— 改错故障：发生真实导航的子 frame 不加载 preload，网页 alert 退回 Chromium 原生弹窗。
// INV-04 断言：allowpopups 只能由宿主重新置为 true，且 setWindowOpenHandler 必须始终返回 deny —— 守住它的位置：params.allowpopups 与 attachEmbeddedBrowserWindowOpenHandler —— 改错故障：点击 target=_blank 无响应，或冒出脱离 ZCode 的裸 BrowserWindow。
// INV-05 断言：new-window 目标必须只放行 http/https，其余协议一律 deny 并 warn —— 守住它的位置：isAllowedEmbeddedBrowserNewWindowUrl 与 setWindowOpenHandler 首段 —— 改错故障：file、data 或自定义协议被系统处理程序执行，本地文件可被诱导打开。
// INV-06 断言：Coding Plan 身份由 will-attach 时的初始 src 粘住，不由当前 URL 反推 —— 守住它的位置：did-attach-webview 传给 isCodingPlanGuest 的 guestKind 字段 —— 改错故障：PayPal 30x 重定向后失去 guest 身份，授权跳转被系统浏览器接管并丢购买上下文。
// INV-07 断言：Rewards guest 离开 isTrustedRewardsUrl 时必须 preventDefault —— 守住它的位置：will-navigate 的 isRewardsGuest 分支 —— 改错故障：第三方页面在已注入凭据的容器里继续执行并可回读敏感数据。
// INV-08 断言：params.src 缺失时按 about:blank 参与协议与 preload 判断 —— 守住它的位置：will-attach-webview 的 targetUrl 归一化 —— 改错故障：继承型空 frame 跳过白名单，之后导航到任意协议都无人拦截。
// INV-09 断言：pendingWebviewGuestKinds 必须 will-attach 入队、did-attach 出队且一一配对 —— 守住它的位置：pendingWebviewGuestKinds 数组的两个读写点 —— 改错故障：插件沙箱 guest 被装上浏览器 popup 策略，蓝牙守卫也挂到错误对象。
// INV-10 断言：插件沙箱 configureGuest 未返回 ok 时必须 preventDefault 且不能入队 —— 守住它的位置：isPluginSandboxSrc 分支的失败返回 —— 改错故障：沙箱 UI 以未加固偏好加载，或后续 guest 与队列错位。
// INV-11 断言：初始缩放档位要在 new BrowserWindow、显式 setZoomFactor、did-finish-load 各落实一次 —— 守住它的位置：createBrowserWindow 三处缩放写入 —— 改错故障：生产包 file 协议加载后 Chromium 回放 origin 级 zoom，把持久化档位改回默认。
// INV-12 断言：clampDesktopZoomLevel 必须先于 resolveDesktopZoomFactorForLevel 调用 —— 守住它的位置：createBrowserWindow 开头的两行 —— 改错故障：越界档位一旦落盘，窗口启动即异常放大或缩小且无法用界面拉回。
// INV-13 断言：Windows 自绘按钮存在时不得再调用 setTitleBarOverlay —— 守住它的位置：applyWindowsTitleBarTheme 的 hasCustomWindowsControls 提前返回 —— 改错故障：同一顶栏出现两套按钮，或 overlay 盖住自绘按钮导致点击区域错位。
// INV-14 断言：所有 webContents.send 前必须判 isDestroyed —— 守住它的位置：syncWindowFullscreenState 与 syncDesktopWindowChromeState —— 改错故障：关窗瞬间的最大化/全屏事件抛 object has been destroyed 并打断主进程日志。
// INV-15 断言：Windows 重绘只能是有界双帧，且不得 reload renderer —— 守住它的位置：attachWindowsWindowRepaint 的 scheduleRepaint —— 改错故障：show 或 resized 时无限重绘烧 GPU，或刷新后丢失当前会话与滚动位置。
// INV-16 断言：pendingRepaintTimer 复用前必须 clearTimeout，窗口销毁后不得再触发 —— 守住它的位置：scheduleRepaint 的定时器收尾 —— 改错故障：拖拽缩放时定时器堆积，回调访问已销毁 webContents 抛异常。
// INV-17 断言：右键菜单模板为空时必须直接返回 —— 守住它的位置：context-menu 的 template.length 判断 —— 改错故障：生产环境在空白处右键弹出空菜单，或把仅开发可见的条目带进正式包。
// INV-18 断言：菜单 label 必须在每次右键时由 currentApplicationLocale 现取 —— 守住它的位置：buildTextContextMenuTemplate 调用点 —— 改错故障：切换语言后菜单仍是旧语言，必须重启窗口才更新。
// INV-19 断言：loadWindow 返回的 Promise 必须 catch 并 warn —— 守住它的位置：createBrowserWindow 末尾 —— 改错故障：loadFile 失败只剩 chrome-error 页面，主进程日志没有原始异常可追。
// INV-20 断言：Linux 的 transparent、frame:false、hasShadow:false 必须同时成立 —— 守住它的位置：buildDesktopWindowVisualOptions 的 linux 分支 —— 改错故障：窗口四角回填黑底，或窗口外缘出现来自窗口管理器的黑线。
//
// 平台分叉总览：darwin 必须走 titleBarStyle:hidden + trafficLight，win32 必须走 frame:false + acrylic + 自绘按钮，
// linux 走 transparent + frame:false + hasShadow:false。三条路径互不共享选项，改动任一分支前先确认另两条的视觉前提。
// guest 策略必须分三类：内置浏览器、Coding Plan 官网、Rewards 邀请页；插件沙箱 guest 完全独立，不进入本文件的白名单判断。
//
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { join } from "node:path";
import type {
  ContextMenuParams,
  Input,
  MenuItemConstructorOptions,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isTrustedCodingPlanWebviewOrigin,
  isTrustedRewardsUrl,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
import { getPluginSandboxHost, isPluginSandboxSrc } from "./pluginSandbox/index.js";
import { installEmbeddedBrowserBluetoothDeviceGuard } from "./embeddedBrowserBluetoothGuard.js";
import { getEmbeddedBrowserDevicePicker } from "./embeddedBrowserPermissionUiBridge.js";
// CDP-on-guest pivot：内置浏览器改回 `<webview>` 渲染，宿主 BrowserWindow 需重新开 webviewTag，
// 并在 will/did-attach-webview 里做 guest 硬化 + URL 白名单 + popup 路由回内部 tab。
// [契约] 白名单只影响 will-attach-webview 的初始 src 判定，不参与后续导航；后续导航由 will-navigate 与 popup 处理器各自把关。
// about: 与 data: 必须在表内：内置浏览器的空白页和插件内联页面都靠它们起步，去掉会让新建 tab 直接 attach 失败。
// zcode-browser-restore: 是会话恢复专用的内部协议，删掉会导致重启后历史 tab 全部被拦。
// 这张表不做「收紧到只剩 https」的优化：一旦收紧，离线页与恢复页立刻白屏，且不会给出任何可读错误。
const ALLOWED_EMBEDDED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "http:",
  "https:",
  "zcode-browser-restore:",
]);
// [权衡] new-window 目标比初始 src 收得更紧，因为这里是网页可控的跳转入口，about: 与 data: 足以被用来伪造同源页面。
// 不要为了让某个下载链接能弹窗而往这里加 blob:；blob 由页面自身持有，交给系统浏览器反而是提权面。
// 白名单只决定「去哪里」，从不决定「是否放行」；是否放行始终由 setWindowOpenHandler 的 deny 决定。
const ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS = new Set(["http:", "https:"]);
// [权衡] 目前只把 background-tab 视为必须外开的意图，foreground-tab 仍留在内部 tab，因为多数站点用它做同站跳转。
// 缺省分支会走内部 Browser tab，不会静默丢弃 URL，所以新增 disposition 只会影响体验，不会造成链接丢失。
// 把 foreground-tab 也加进来会打断站内登录、OAuth 弹窗等双窗口流程，别为了「都外开」而扩大该集合。
const EXTERNAL_BROWSER_DISPOSITIONS = new Set(["background-tab"]);
// [契约] 判定条件是「主机属于这张表且路径以 /api/pay/paypal/ 开头」，两个条件缺一不可，否则整个 z.ai 域都会留在 webview 内。
// 集合里同一主机写了两次属于历史冗余，读取方用的是 has，行为等价；清理时应连同路径前缀判断一起核对。
// 新增中转主机必须同时确认它只做 302、不渲染第三方内容，否则会把网页内容带进持有 zcodeBridge 的容器。
const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);
// [资源] 这个 preload 固定挂在普通内置浏览器 guest 的每个 frame 上，路径写错不会报错，只会让网页 alert 变成 Chromium 原生弹窗。
// 用 import.meta.dirname 拼相对路径，保证打包后 main 目录结构变化时仍然指向同级的 preload 目录。
const embeddedBrowserJavaScriptDialogPreloadPath = join(
  import.meta.dirname,
  "../preload/embeddedBrowserJavaScriptDialog.cjs",
);
// Coding Plan 官网页专用 preload：挂 window.zcodeBridge 供官网回传购买完成信号。
const codingPlanWebviewPreloadPath = join(import.meta.dirname, "../preload/codingPlanWebview.cjs");

/**
 * 判断 webview 是否加载 Coding Plan 官网购买页（/coding-plan?...&embedded=app）。
 * 用于在 will-attach-webview 里把这种 webview 的 preload 切到 codingPlanWebviewPreloadPath，
 * 其余 webview（如内置浏览器）仍用 embeddedBrowserJavaScriptDialogPreloadPath。
 */
// [契约] 这里的 pathname 必须是精确 /coding-plan，attach 阶段 src 还没经过 locale 重定向，用包含匹配会把外链误判成购买页。
// embedded=app 是硬条件：没有它说明是普通网页打开，不能套用会暴露 zcodeBridge 的 preload。
// 异常一律返回 false，宁可让官方页退回普通 preload，也不能把购买页信号桥接给来源不明的 URL。
function isCodingPlanEmbeddedWebviewSrc(src: string | undefined): boolean {
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
    if (url.pathname !== "/coding-plan") return false;
    const embedded = url.searchParams.get("embedded");
    return embedded === "app";
  } catch {
    return false;
  }
}

/**
 * 宽松判断 webview 当前 URL 是否属于 coding-plan 购买页。
 *
 * setWindowOpenHandler 回调触发时 webview 可能已发生 locale 重定向
 * （/coding-plan → /cn/coding-plan），故 pathname 用 includes 匹配。
 * embedded=app 仍是硬条件，避免误判内置浏览器的外链。
 */
// [契约] 与 attach 阶段的判断刻意不同：这里用 includes 匹配 pathname，因为回调触发时 URL 可能已经变成 /cn/coding-plan。
// 两套判断不能合并成一个函数：收紧会导致重定向后的 popup 被送到系统浏览器，放宽会让 attach 阶段误挂桥接 preload。
// embedded=app 仍是硬条件，避免内置浏览器里打开的官网页面被当成本地购买面板。
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
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
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

// [契约] returnTo 只允许回到当前 origin 且必须再次通过 isCodingPlanWebviewUrl，防止回调后跳到外部站点继续持有容器。
// 用 new URL(returnTo, url.origin) 解析相对路径，不要自己拼字符串，否则协议相对地址会被误判为同源。
// 回调页本身未必带 embedded=app，所以先校验 origin 与路径再复用宽松判断；顺序反过来会把合法回调全部拒绝。
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
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

// [权衡] 三个平台返回完全不同的选项集合，不要抽公共字段到共用对象：darwin 需要 vibrancy 才通透，win32 需要 acrylic 才有材质，linux 两者都不支持。
// backgroundColor 在 darwin 与 linux 都是全透明，只有配合各自的透明材质才有意义；单独给 win32 加透明会与 acrylic 打架并出现闪黑。
// linux 的 hasShadow:false 是针对部分窗口管理器额外描边的规避，改动前必须在该平台实际观察窗口外缘，而不是只看截图。
// trafficLightPosition 传的是未缩放的基准值，实际位置由 desktopWindowButtonPosition 在缩放变化时补偿，不要在这里乘 zoom。
function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Windows 窗口操作由 renderer 绘制，禁用原生标题栏，避免出现两套按钮。
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // 不透明 BrowserWindow 会把 renderer 的圆角裁切重新填成直角黑底，
    // Linux 外壳无法与内层 12px 面板形成同心圆弧。透明底只负责露出四角，
    // renderer 根面仍使用不透明 token，避免桌面底色混入侧栏。
    backgroundColor: "#00000000",
    transparent: true,
    // Linux 原生标题栏会和 renderer 自绘顶部菜单重复，隐藏 frame 后统一用自定义窗口控制。
    frame: false,
    // Linux 部分窗口管理器会给 frameless 窗口绘制额外外侧阴影/描边，
    // 用户看到的是窗口外缘黑线。只在 Linux 禁用系统阴影，避免影响 macOS/Windows 的原生材质。
    hasShadow: false,
  };
}

// [失败路径] 只在 darwin 且 app.dock 存在时执行，其余平台直接返回；把空判断挪到最后会让 Linux 启动时报 dock 不存在。
// 图标为空时静默跳过：路径在开发态可能尚未生成，这里抛错会打断主进程启动，而缺图标本身不影响可用性。
export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript 不会因为 process.platform === "darwin" 自动收窄 app.dock。
  // app.dock 的类型在定义上仍然可能是 undefined，直接调用会持续报 ts(18048)。
  // 这里把平台判断和空值判断合并，既符合运行时语义，也让类型系统明确知道 Dock 一定存在。
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

// [契约] 三个提前返回条件互不等价：非 win32 是无此 API，窗口已销毁是防崩，自绘按钮存在是防双套 UI。
// theme 为 system 时才读 nativeTheme，显式 dark/light 必须原样下发，否则用户手选主题会被系统主题覆盖。
// overlay 尺寸随缩放档位变化，必须先从 factor 反解档位再构造，直接按 1.0 构造会在高 DPI 下露出生理边框。
// [权衡] 这里不缓存上一次主题，重复调用是幂等的；加缓存会在系统主题切换时漏掉更新，代价大于一次原生调用。
export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

// [资源] 重绘只在 win32 安装监听，其他平台不会产生任何定时器，避免无意义唤醒。
// [并发] resized 与 show 共用同一个调度器，两次事件在 32ms 内到达会合并成一次补帧，不会叠加。
// [权衡] 这里用 invalidate 而不是 reload 或反复 setSize，前者只让合成器重排，后者会重建 renderer 并丢失会话。
function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  // [资源] 定时器句柄必须先置空再回调，否则回调里再次 scheduleRepaint 会误清一个已经执行完的 id。
  // [失败路径] 两次重绘都各自判 isDestroyed，因为 32ms 内窗口完全可能被关闭，只在入口判一次不够。
  // [并发] 用 clearTimeout 做去抖而非节流：拖拽结束只需要最终一帧，中间帧交给 Chromium 自己处理。
  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // Windows 手动拉伸结束后，Electron/Chromium 偶发只更新窗口 bounds，
    // 但 renderer 最后一帧没有完整 repaint，新扩展区域会留下宿主底色。resized 是低频结束事件，
    // 这里补一次完整窗口重绘，确保内容层按最终 viewport 尺寸重新铺满。
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // Windows Acrylic 窗口 hide 到托盘后再次 show 时可能继续复用失效的合成 surface，
    // renderer 与 host 仍存活但窗口只剩宿主底色；复用 resize 的有界双帧重绘，不 reload renderer 或会话。
    scheduleRepaint();
  });
}

// [失败路径] 解析失败返回 false，与「协议不在表内」同路；不要为了兼容畸形 URL 在这里放行 about: 前缀的字符串。
// 这里必须只判初始 src，不判 guest 之后的导航，导航白名单在 will-navigate 里独立执行。
function isAllowedEmbeddedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAllowedEmbeddedBrowserNewWindowUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

// [契约] 协议必须 https，PayPal 与其中转都没有明文入口；放宽到 http 会让授权页被降级劫持。
// 中转判断同时要求主机精确命中与路径前缀命中，只判主机等于把整个 z.ai API 都留在 webview 内。
function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    // 后端下发的 PayPal approveUrl 可能先指向 Z.AI 支付 API 中转地址，
    // 由该地址再 302 到 PayPal。中转 URL 也必须留在当前 webview，否则会被系统浏览器接管。
    return (
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

// [契约] 同时读布尔字段与 modifiers 集合，是因为不同平台与 Electron 版本给出的字段不一致，任一命中即视为按住。
// command 与 cmd 都要认，macOS 上报 meta、Windows 上报 control，漏一个就会出现「按住没反应」。
function hasExternalBrowserModifier(input: Input): boolean {
  const modifiers = new Set(input.modifiers ?? []);
  return (
    input.meta === true ||
    input.control === true ||
    modifiers.has("meta") ||
    modifiers.has("command") ||
    modifiers.has("cmd") ||
    modifiers.has("control") ||
    modifiers.has("ctrl")
  );
}

function isExternalBrowserModifierKey(input: Input): boolean {
  const key = input.key.toLowerCase();
  const code = input.code.toLowerCase();
  return (
    key === "meta" ||
    key === "control" ||
    code === "metaleft" ||
    code === "metaright" ||
    code === "controlleft" ||
    code === "controlright"
  );
}

function shouldOpenEmbeddedBrowserRequestExternally(input: {
  disposition: string;
  externalBrowserModifierActive: boolean;
}): boolean {
  return (
    input.externalBrowserModifierActive || EXTERNAL_BROWSER_DISPOSITIONS.has(input.disposition)
  );
}

// [契约] externalBrowserModifierActive 是每个 guest 私有的状态，不能提到模块作用域，否则多个 tab 会互相污染。
// [并发] before-input-event 与 setWindowOpenHandler 跑在同一条 IPC 序列上，读到的就是点击发生时的 modifier 状态。
// isCodingPlanGuest 由调用方按 attach 时的 src 传入并保持粘性，本函数不再根据当前 URL 重新推断。
function attachEmbeddedBrowserWindowOpenHandler(options: {
  hostWebContents: WebContents;
  guestWebContents: WebContents;
  isCodingPlanGuest: boolean;
  isRewardsGuest: boolean;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
  logger: { warn: (...args: unknown[]) => void };
}) {
  let externalBrowserModifierActive = false;

  options.guestWebContents.on("before-input-event", (_event, input) => {
    // 某些平台的 keyUp 仍可能带 modifier 标记，直接记最近一次 modifiers
    // 会让"用系统浏览器打开"的状态粘住，导致后续普通点击也被外部打开。
    if (input.type === "keyUp" && isExternalBrowserModifierKey(input)) {
      externalBrowserModifierActive = false;
      return;
    }

    externalBrowserModifierActive = hasExternalBrowserModifier(input);
  });

  // [契约] 所有路径最终都返回 deny：允许窗口只会产出脱离宿主的新窗口，URL 的处置由 loadURL、openExternal 或内部 tab 承担。
  // [失败路径] loadURL 与 openExternal 都返回 Promise，必须挂 catch 并带 url 打日志，否则被拒绝的导航在主进程完全静默。
  // [权衡] Coding Plan 的 popup 形态改用当前 guest 导航，是为了让 PayPal 授权回跳留在同一容器；打开新 webview 会丢购买上下文。
  options.guestWebContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const { url, disposition } = details;
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`);
      return { action: "deny" };
    }

    // Coding Plan webview 的外链（条款/管理等 target=_blank）直接拉起系统默认浏览器，
    // 不路由到内部 Browser tab（对齐原生购买面板行为）。回调触发时 webview URL 已
    // 加载完成，可能因 locale 重定向变成 /cn/coding-plan，用宽松判断。
    // 支付链接走 location.href（不触发 setWindowOpenHandler），不受影响。
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldRouteCodingPlanPopup =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (shouldRouteCodingPlanPopup) {
      if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
        // PayPal 授权/回调是 Coding Plan 购买流程的一部分，不能走系统浏览器，
        // 否则授权回跳会脱离当前 webview 并丢失购买上下文。popup 形态改为当前 guest 导航。
        void options.guestWebContents.loadURL(url).catch((error: unknown) => {
          options.logger.warn(
            "[browser-pane] failed to load coding-plan embedded popup in webview",
            {
              error: error instanceof Error ? error.message : String(error),
              url,
            },
          );
        });
        return { action: "deny" };
      }
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open coding-plan popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    if (
      shouldOpenEmbeddedBrowserRequestExternally({
        disposition,
        externalBrowserModifierActive,
      })
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open webview popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    // [契约] owner 查不到时仍然发送 OpenBrowserUrl，只是不带归属字段；缺字段时 renderer 会退化为默认 workspace，而不是丢链接。
    // remoteSessionId 用条件展开，避免把 undefined 显式写进 IPC 负载造成序列化差异。
    // sourceTabId 取的是 owner.tabId，用于 renderer 把新 tab 排到源 tab 旁边；改成 guest 的 id 会让排序失去依据。
    const owner = options.resolveBrowserViewOwner?.(options.guestWebContents.id);
    options.hostWebContents.send(PlatformChannels.OpenBrowserUrl, {
      disposition,
      url,
      ...(owner
        ? {
            workspaceKey: owner.workspaceKey,
            ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
            sessionId: owner.sessionId,
            browserId: owner.browserId,
            browserGeneration: owner.browserGeneration,
            sourceTabId: owner.tabId,
          }
        : {}),
    });
    return { action: "deny" };
  });

  // [契约] Rewards 分支必须先判身份再判目标：邀请页容器里注入了凭据，任何未受信任的跳转都要先被拦下再外开。
  // [权衡] Coding Plan 分支放行 isCodingPlanWebviewUrl 时不 preventDefault，是为了让 locale 重定向正常完成，只拦住离开可信域的导航。
  // [失败路径] 被拦下的 URL 必须在协议允许时才交给系统浏览器，其他协议连外开都不做，避免 file 等被系统处理程序接管。
  options.guestWebContents.on("will-navigate", (event, url) => {
    if (options.isRewardsGuest) {
      if (
        isTrustedRewardsUrl(url, {
          dev: !app.isPackaged,
          e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
        })
      )
        return;
      // 邀请页离开受信任路径必须外开，不能让第三方页面使用已注入凭据的容器。
      event.preventDefault();
      if (isAllowedEmbeddedBrowserNewWindowUrl(url))
        void shell
          .openExternal(url)
          .catch(() => options.logger.warn("[rewards] external navigation failed"));
      return;
    }
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldGuardCodingPlanNavigation =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (!shouldGuardCodingPlanNavigation || isCodingPlanWebviewUrl(url)) {
      return;
    }
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported coding-plan navigation url: ${url}`);
      event.preventDefault();
      return;
    }
    if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
      // 官网用 location.href 发起 PayPal 授权时会触发主 frame 导航。
      // PayPal/中转/可信官网回跳需要留在当前 webview，后续 callback 才能继续订阅。
      return;
    }

    // Coding Plan 专用 preload 会在后续主 frame 导航中继续存在。
    // 离开可信购买页时必须阻断 guest 导航并交给系统浏览器，避免第三方页面继承 zcodeBridge。
    event.preventDefault();
    void shell.openExternal(url).catch((error: unknown) => {
      options.logger.warn("[browser-pane] failed to open coding-plan navigation externally", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
    });
  });
}

function buildTextContextMenuTemplate(
  params: ContextMenuParams,
  locale: Locale,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(locale, id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  // [契约] 只读选区只给 copy 一个条目；给只读文本挂粘贴或删除会呈现可点但无效的菜单项。
  // isEditable 分支用 editFlags 逐项控制 enabled，不根据选中内容自行推断，否则会出现「看起来能点但没反应」。
  // 两者都不满足时返回空数组，由调用方决定是否弹菜单；这里不返回默认模板，避免空白处右键出现无意义项。
  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

// [契约] 所有可选项都带默认值，main 侧可以不传；resolveBrowserViewOwner 缺失时 popup 仍会路由，只是没有归属信息。
// currentApplicationLocale 是函数而不是值，专为切换语言后无需重建窗口服务，改成字符串会退回启动时语言。
// logger 由调用方注入，本文件不直接使用 console，保证主进程日志口径统一且可被测试捕获。
export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /** 桌面端设备标识符（基于 userData 路径的 SHA-256），用于 renderer 同步读取 */
  deviceMid?: string;
  /** 桌面端持久化页面缩放档位；窗口创建时先应用，避免首屏回到默认大小。 */
  initialDesktopZoomLevel?: number;
  /** 主进程设置服务读取的最近一次普通窗口尺寸与最大化状态。 */
  initialWindowSize?: DesktopWindowSize;
  /** 每次弹出原生菜单时读取，确保应用切换语言后无需重建窗口。 */
  currentApplicationLocale?: () => Locale;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
}): BrowserWindow {
  // [契约] 先 clamp 再解析 factor，顺序反了会出现「档位越界但 factor 已被算成合法」的假象，后续无处纠正。
  // initialWindowSize 必须用主屏工作区作为兜底基准，多显示器下以主屏为准，避免窗口开在不可见区域。
  // 这里不读 setting 服务，持久化值由调用方传入，保持窗口创建与配置读取解耦。
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // 1280x720 桌面环境的可用高度通常低于 768，过高的最小高度会导致用户无法继续缩小窗口。
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // Linux frameless 后部分桌面环境仍可能显示 Electron 原生菜单栏，自动隐藏避免顶部出现两套菜单。
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CDP-on-guest pivot：内置浏览器改回 `<webview>` 渲染，宿主需开 webviewTag。
      webviewTag: true,
      // 永久 backgroundThrottling=false 会唤醒整窗 renderer、所有 webview guest
      // 和 GPU。窗口保持默认节流；截图期只临时唤醒 owner renderer 与当前目标 guest。
      zoomFactor: initialDesktopZoomFactor,
      // 将 deviceMid 透传给 preload，供 renderer 在 React 渲染前同步读取
      additionalArguments: [`--device-id=${options.deviceMid ?? ""}`],
    },
  });

  // 缩放命令原本只改当前运行窗口，没有在重启后恢复。
  // 创建窗口时由 main 进程先应用 setting.json 中的桌面缩放档位，同时覆盖 Chromium 可能残留的 per-host zoom。
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);
  // will-attach 与 did-attach 按顺序配对；队列元素记录 guest 种类，did-attach 据此分派策略。
  const pendingWebviewGuestKinds: Array<
    | { kind: "browser" | "codingPlan"; isRewards: boolean }
    | { kind: "pluginSandbox"; sandboxId: string }
  > = [];

  win.webContents.once("did-finish-load", () => {
    // 生产包使用 loadFile(file://...) 导航时，Chromium 可能在页面加载完成后重放
    // origin 级 zoom 状态，把窗口创建阶段设置的持久化缩放覆盖回默认值。
    // did-finish-load 后再按 setting.json 的档位重放一次，确保生产包和开发态 localhost 行为一致。
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // 导航失败时 CDP target 元数据可能仍保留原 file:// URL，而 renderer
      // 实际 document 已经进入 chrome-error://；记录主 frame 失败才能定位真实导航根因。
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  // [契约] 这是唯一能改写 guest 偏好的时机，did-attach 之后 preferences 已经生效，再改只能重建 guest。
  // 插件沙箱分支必须最先返回：它自带 configureGuest 与独立协议，落进后面的 preload 赋值会把浏览器桥接脚本注入沙箱。
  // 删除 params 上的 preload、nodeintegration、disablewebsecurity、allowpopups 是防御性清理：网页可通过 webview 属性尝试同名覆盖。
  // [权衡] 先删 allowpopups 再由宿主置 true，是为了让 popup 一定经过 setWindowOpenHandler，而不是让网页直接指定。
  // [失败路径] 协议不在白名单时 preventDefault 并 warn，且不能入队；入队会让下一次 did-attach 消费到错误的 guest 种类。
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // CDP 在原生 Dialog 已创建后再替换 UI，macOS 仍可能显示已经排队的
    // Chromium NSAlert。固定 preload 在每个 frame 调用原生 API 前拦截，且隔离世界只
    // 暴露 alert/confirm 同步桥；网页主世界仍没有 Node 或任意 IPC 能力。
    //
    // Coding Plan 官网页例外：它需要 window.zcodeBridge 回传购买完成信号，
    // 改用专用 preload（codingPlanWebview.ts），其余 webview 保持原生 Dialog 桥。
    const targetUrl = params.src ?? "about:blank";
    // 插件 UI 沙箱 guest：独立分支，不走内置浏览器的 preload / allowpopups / 协议白名单。
    if (isPluginSandboxSrc(targetUrl)) {
      const host = getPluginSandboxHost();
      const decision = host?.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!decision?.ok) {
        options.logger.warn(
          `[plugin-sandbox] blocked webview attach: ${decision ? decision.reason : "host-not-installed"}`,
        );
        event.preventDefault();
        return;
      }
      pendingWebviewGuestKinds.push({ kind: "pluginSandbox", sandboxId: decision.sandboxId });
      return;
    }
    const isCodingPlanWebview = isCodingPlanEmbeddedWebviewSrc(targetUrl);
    webPreferences.preload = isCodingPlanWebview
      ? codingPlanWebviewPreloadPath
      : embeddedBrowserJavaScriptDialogPreloadPath;
    const isRewardsWebview = isTrustedRewardsUrl(targetUrl, {
      dev: !app.isPackaged,
      e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
    });
    if (isRewardsWebview) {
      webPreferences.preload = join(import.meta.dirname, "../preload/rewardsWebview.cjs");
      if (!app.isPackaged)
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          "--zcode-rewards-dev",
        ];
    }
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    // [契约] 派生偏好与 attach 参数必须同时为 true，只改一边会造成主 frame 有 preload、子 frame 没有的隐蔽差异。
    // params 上是字符串 "true" 而不是布尔值，Electron 对 attach 参数按字符串解析，写成布尔会被忽略。
    // 无 src 的继承型空 frame 不触发 preload，由 preload 内的同源 frame 观察器接管，所以这里不需要为空 frame 特判。
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;

    // [契约] 三个 delete 各自对应一条提权路径，漏掉任何一条都会让网页侧属性覆盖宿主决定。
    // 顺序无关但位置有关：必须排在 preload 与偏好赋值之后，否则会被后续赋值重新写回。
    delete params.preload;
    delete params.nodeintegration;
    // nodeIntegrationInSubFrames 是 guest 创建期偏好；派生 WebPreferences 与原始 attach
    // 参数都固定为 true，确保发生真实导航的子 frame 在网页脚本前加载同一 preload。
    // 无 src 的继承型空 frame 不触发 preload，由 preload 内的同源 frame 观察器接管。
    params.nodeintegrationinsubframes = "true";
    delete params.disablewebsecurity;
    delete params.allowpopups;

    // webview 内 target=_blank/window.open 如果完全禁用 popup 会表现为点击无响应；
    // 如果放任 Electron 默认处理，又会创建脱离 ZCode 的 BrowserWindow。这里由宿主重新打开
    // allowpopups，并在 did-attach-webview 中用 setWindowOpenHandler 统一 deny 默认窗口创建，
    // 再把合法 URL 路由到内部 Browser tab 或系统浏览器。
    params.allowpopups = "true";

    if (!isAllowedEmbeddedBrowserUrl(targetUrl)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview url: ${targetUrl}`);
      event.preventDefault();
      return;
    }

    pendingWebviewGuestKinds.push({
      kind: isCodingPlanWebview ? "codingPlan" : "browser",
      isRewards: isRewardsWebview,
    });
  });

  // [并发] shift 出队的默认值只在极端情况下兜底：正常 attach 一定先经过 will-attach 入队，错位说明有事件被吞。
  // [失败路径] 兜底成 browser 而不是 pluginSandbox，避免给未知 guest 套上沙箱 attach 与沙箱 IPC。
  // 插件沙箱 guest 在这里直接返回，不安装 popup 处理器与蓝牙守卫，它的策略由 sandbox host 全权负责。
  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const guestKind = pendingWebviewGuestKinds.shift() ?? {
      kind: "browser" as const,
      isRewards: false,
    };
    // [契约] attachGuest 必须传真实 hostWebContents，沙箱用它做归属校验与消息回传，传错窗口会让沙箱 IPC 发到别的 renderer。
    // host 未安装时用可选链静默跳过：插件系统可能尚未初始化，这里抛错会让窗口创建失败。
    // 这里返回后不再往下走，确保沙箱 guest 不进入浏览器 tab 路由分支。
    if (guestKind.kind === "pluginSandbox") {
      getPluginSandboxHost()?.attachGuest({
        guest: guestWebContents,
        hostWebContents: win.webContents,
        sandboxId: guestKind.sandboxId,
      });
      return;
    }
    attachEmbeddedBrowserWindowOpenHandler({
      guestWebContents,
      hostWebContents: win.webContents,
      resolveBrowserViewOwner: options.resolveBrowserViewOwner,
      // PayPal/relay 的 30x 重定向不保证逐跳触发 will-navigate。
      // Coding Plan guest 身份必须按初始 src 粘住，不能由当前 URL 解防护。
      isCodingPlanGuest: guestKind.kind === "codingPlan",
      isRewardsGuest: guestKind.isRewards,
      logger: options.logger,
    });
    // 蓝牙设备选择事件挂在 guest WebContents 上（Session 只覆盖 hid/usb/serial）；
    // 仅内置浏览器 guest 安装守卫，阻断 Electron 未监听时静默授权第一个设备的默认行为。
    if (guestKind.kind === "browser") {
      installEmbeddedBrowserBluetoothDeviceGuard(guestWebContents, options.logger.warn, {
        devicePicker: getEmbeddedBrowserDevicePicker(),
        hostWebContentsId: win.webContents.id,
      });
    }
  });

  // [契约] 模板为空直接返回，避免在空白处弹出空菜单；dev 分支已经先塞了 Inspect Element，所以该判断只影响正式包。
  // [权衡] 只在文本编辑语义下补原生菜单，是为了不覆盖终端等已有 DOM 右键菜单，双弹会让用户点错。
  // popup 必须绑定 window，否则菜单无法随窗口销毁，残留菜单在窗口关闭后仍可能响应。
  win.webContents.on("context-menu", (_event, params) => {
    // 只设置 Electron role 时，菜单文案跟随系统/Electron 语言，可能与应用语言不一致。
    // 每次右键时读取当前 locale 并显式设置 label，切换语言后下一次打开即可生效。
    const template = buildTextContextMenuTemplate(
      params,
      options.currentApplicationLocale?.() ?? DEFAULT_LOCALE,
    );

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // 之前为避免和终端等 DOM 右键菜单双弹，生产环境完全不弹 Electron 原生菜单；
    // 但普通文本选区和输入框没有 DOM 菜单，导致右键复制/粘贴像被禁用。这里仅在文本编辑语义下补原生菜单。
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // [失败路径] 用 Promise.resolve 包一层，兼容 loadWindow 返回非 Promise 的实现，同时不改变原有的调用顺序。
  // 捕获后不重新抛出：导航失败不应阻断窗口创建，窗口仍需保持可交互以便用户重试或查看错误页。
  // 日志带原始 error 对象而不是 message，保留栈信息，便于区分 preload 异常与网络失败。
  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // loadFile/loadURL 返回的导航 Promise 过去被丢弃，长跑中的导航失败
    // 只会表现为 chrome-error 页面，主进程日志没有原始异常可供追踪。
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}
