/* oxlint-disable eslint(max-lines) -- Deep Link 路由必须在同一模块内保持协议校验和投递原子性。 */
// ZCode 桌面端 zcode:// 深链路的唯一分发入口：必须解析 URL、做安全闸门、定位目标窗口并在必要时缓存。
// 只负责协议路由与窗口级 IPC 投递；不负责 OAuth 换码、支付校验、share 落盘与 workspace 实际加载。
// 下方不变量按「外部输入先校验、后探测、再投递」排列，任何缓存字段都不是可并发共享的通用队列。
//
// INV-01 断言：外部工作区路径必须先通过确认弹窗才允许进入文件系统探测 —— 守住它的位置：handleDeepLink 的 isWorkspaceOpenUrl 分支 —— 改错故障：浏览器或 IM 的链接可静默打开带恶意项目配置的目录并影响 agent runtime。
// INV-02 断言：网络路径必须在任何 statSync 之前被拒绝 —— 守住它的位置：isNetworkWorkspacePath 与 isValidLocalWorkspaceDirectory 的短路顺序 —— 改错故障：Windows 会先发起 SMB 认证，向恶意主机泄露 NTLM 哈希。
// INV-03 断言：工作区路径必须同时满足非空、无 NUL、非网络、绝对路径四项 —— 守住它的位置：isValidLocalWorkspaceDirectory —— 改错故障：相对路径被按 cwd 解析，打开错误目录或让 statSync 抛异常。
// INV-04 断言：未就绪窗口的投递必须缓存并在 renderer ready 后重放 —— 守住它的位置：rendererReadyWebContentsIds 与 deliverPendingDeepLink —— 改错故障：冷启动时的 deep link IPC 丢失，用户点击链接后应用毫无反应。
// INV-05 断言：share import 缓存项必须绑定目标 webContents id —— 守住它的位置：enqueuePendingShareImport 与 deliverPendingDeepLink —— 改错故障：多窗口下导入投给先 ready 的窗口，写进错误 workspace 的 .zcode-share。
// INV-06 断言：相同 shareCode 且相同目标窗口的请求只保留一份 —— 守住它的位置：enqueuePendingShareImport 的去重判断 —— 改错故障：重复链接触发重复导入，覆盖用户正在编辑的分享内容。
// INV-07 断言：share 缓存长度不得超过 8，超限丢最旧一条 —— 守住它的位置：MAX_PENDING_SHARE_IMPORTS 与 shift —— 改错故障：无窗口期间外部链接刷爆主进程内存。
// INV-08 断言：OAuth 回调只能投递给注册该 state 的窗口 —— 守住它的位置：oauthStateToWindow 与 routeTarget 查找 —— 改错故障：多窗口登录时凭据送进另一窗口，登录态串号。
// INV-09 断言：OAuth state 只在带授权码的回调成功后删除 —— 守住它的位置：shouldCompleteOAuthRoute 分支 —— 改错故障：用户取消授权就丢失映射，重试回调再也命不中目标窗口。
// INV-10 断言：OAuth state 注册后 5 分钟必须过期 —— 守住它的位置：registerOAuthState 的 setTimeout —— 改错故障：映射常驻泄漏内存，迟到的伪造回调仍可能命中。
// INV-11 断言：暂时没有窗口可达的深链必须缓存而不是丢弃 —— 守住它的位置：pendingDeepLinkUrl 与 pendingPaymentDeepLinkUrl 赋值点 —— 改错故障：启动未完成时点击支付回跳或登录，回调永久丢失。
// INV-12 断言：路由成功后必须显式 restore、show 并 focus 目标窗口 —— 守住它的位置：focusDeepLinkTargetWindow —— 改错故障：macOS 上用户完成登录后仍停留在浏览器，误判失败而重复授权。
// INV-13 断言：defaultApp 模式下 URL 必须被隔在 -- 之后 —— 守住它的位置：registerDeepLinkProtocol 的 win32 参数组装 —— 改错故障：URL 内容被当成 Electron 启动参数，篡改主进程启动选项。
// INV-14 断言：强制升级 gate 必须早于路径校验与缓存拦截 —— 守住它的位置：canOpenWorkspace 分支 —— 改错故障：升级期仍能用外部链接打开工作区，触发版本不兼容的 runtime。
// INV-15 断言：窗口销毁必须同步清理它的全部待投递条目 —— 守住它的位置：clearOAuthRoutesForWindow —— 改错故障：队列条目永不过期，被后续 ready 的窗口消费到错误 workspace。
// INV-16 断言：deliverPendingDeepLink 的返回值只表示是否消费了 OAuth 回调 —— 守住它的位置：函数末尾的 return —— 改错故障：调用方据返回值判断初始化完成，把 share 与支付也算进去会提前收起加载态。
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import {
  type Locale,
  type OAuthProviderId,
  type OAuthStateRegistration,
  PlatformChannels,
} from "@zcode/shared";
import {
  extractWorkspaceOpenPath,
  extractShareImportCode,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
} from "./desktopDeepLinkUrl.js";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** 业务窗口解析器；必须排除 CUA indicator 等 Main 辅助窗口。 */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider?: OAuthProviderId;
}

// [事务] state 到窗口的映射是 OAuth 回调唯一的路由依据，不能退化成「取当前焦点窗口」。
// 多窗口同时登录时焦点窗口与被授权窗口必然不一致，按焦点投递会把凭据送进错误的 renderer。
// 映射只在 registerOAuthState 写入、在带 code 的成功回调与窗口销毁时删除，其余路径不得清理。
// 这是进程内单例，窗口重建不会自动继承，重建后必须由 renderer 重新注册 state。
const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
// [契约] 只有 renderer 主动上报 ready 后 id 才进集合，这是「能否直接 send」的唯一开关。
// 窗口 id 会被复用，关闭时必须在 clearOAuthRoutesForWindow 同步删除，否则新窗口被误判为已就绪。
// 不能改成按 BrowserWindow 实例判断：实例销毁后 webContents.id 仍可能被重新分配。
const rendererReadyWebContentsIds = new Set<number>();
let pendingDeepLinkUrl: string | null = null;
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
// 队列元素必须区分「已绑定目标窗口」与「冷启动时无窗口可绑」两种形态，后者用字段缺失表示。
// 无绑定条目会被第一个 ready 的窗口消费，只能用于应用启动早期、窗口必然唯一的场景。
// 队列跨窗口共享，读取时必须整表 splice 后再按 id 回填，不能边遍历边删。
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
// 上限只为防止无窗口期间外部链接无限堆积；调大不提升正确性，只会延长内存驻留与误投递窗口。
// 超限采用 shift 丢最旧而不是丢最新：最新一次点击才代表用户当下意图。
const MAX_PENDING_SHARE_IMPORTS = 8;

// 去重键是 shareCode 加目标窗口 id，二者任一不同都算独立请求；少了窗口维度会吞掉另一窗口的有效导入。
// 写入时按 targetWebContentsId 是否存在决定是否落该字段，避免显式 undefined 与缺失两种等价形态。
// 去重发生在写入前，所以重复点击不会刷新顺序，被去重的那次也不会把旧条目挪到队尾。
function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

// [契约] 入参来自 renderer IPC，必须是 unknown 并逐字段校验，不能假定调用方已做类型收窄。
// 返回 trim 后的 state，注册与回调查找都用 trim 值，否则首尾空格会让映射永远命中不到。
// provider 只在确为字符串时才写入对象，显式 undefined 会破坏下游对字段存在性的判断。
export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
  };

  if (typeof candidate.state !== "string" || candidate.state.trim() === "") {
    return null;
  }

  if (candidate.provider != null && typeof candidate.provider !== "string") {
    return null;
  }

  return {
    state: candidate.state.trim(),
    ...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
  };
}

// [契约] 三平台行为必须不同：restore 只对最小化有效，show 只对隐藏有效，macOS 还要 app.show 拉回应用。
// 必须先按 isMinimized 与 isVisible 判断再调用，重复 restore 会触发一次多余的窗口动画。
// focus 放在最后：先 show 再 focus，在 macOS 上才能真正把窗口提到前台。
function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // macOS 的 open-url 回调只会把 URL 投递给当前实例，不会自动把窗口带回前台。
  // 之前这里只做了 IPC 转发，用户完成 OAuth 或从系统服务打开目录后仍停留在外部应用。
  // 这里在路由成功后显式激活并聚焦目标窗口，统一多平台回跳体验。
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

// code 与 authCode 是两套 provider 的历史命名，二者都要认，删掉任一个都会让某家回调被判为未完成。
// 返回 false 不代表失败：用户取消授权时回调同样带 state 却没有 code，此时必须保留映射以便重试。
// 不能改用 error 参数判断完成度，provider 在成功回调里也可能附带 warning 字段。
function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  // [失败路径] 短路顺序是安全边界：网络路径判断必须排在 statSync 之前，否则 Windows 会先发起 SMB 认证。
  // NUL 字符会让底层 stat 抛错甚至截断路径，必须在拼接与探测前拒绝。
  // 非绝对路径一律拒绝，不能按 cwd 补全：外部链接里的相对路径没有可信基准目录。
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// 这里判断的是规范化之后的网络前缀，所以必须先把正斜杠统一为反斜杠，单 / 的 Unix 绝对路径不会命中。
// 同时匹配 \\?\UNC\ 长路径前缀，漏掉它时超长 UNC 路径会绕过全部网络路径拦截。
export function isNetworkWorkspacePath(path: string): boolean {
  // 仅当原路径以 // 或 \\ 开头时规范化后才会以 \\ 开头；
  // 单 / 的 Unix 绝对路径不会被误判为 UNC 网络路径。
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

export function resolveExternalWorkspaceOpenDialogCopy(
  locale: Locale,
): ExternalWorkspaceOpenDialogCopy {
  // TODO(i18n): 新增 Locale 时把这里收敛成完整 Record<Locale, ...>，
  // 避免未覆盖语言静默回退英文。
  // [权衡] 目前只有中文与英文两套文案，其它 Locale 静默落到英文；新增语言必须在此补分支而不是改默认值。
  // 按钮数组顺序被 confirmExternalWorkspaceOpen 用下标 0 与 1 解释，调整顺序等于改变确认语义。
  if (locale === "zh-CN") {
    return {
      buttons: ["打开文件夹", "取消"],
      title: "打开外部 ZCode 链接？",
      message: "是否在 ZCode 中打开此文件夹？",
      detail: (path) => `${path}\n\n只打开你信任来源的文件夹。项目设置可能影响 agent runtime。`,
    };
  }

  return {
    buttons: ["Open folder", "Cancel"],
    title: "Open external ZCode link?",
    message: "Open this folder in ZCode?",
    detail: (path) =>
      `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
  };
}

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = resolveExternalWorkspaceOpenDialogCopy("en-US"),
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  // defaultId 与 cancelId 都是 1，因此只有 0 号按钮算确认；改按钮顺序或默认下标会造成回车即放行。
  // noLink 必须保持开启，否则 macOS 会把路径渲染成可点击链接，用户可借此探测本地文件系统。
  // 同步弹窗会阻塞主进程，这正是期望：确认未完成前不得进入后续 statSync 与投递。
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] 用户取消打开外部链接工作区", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  // 这里必须同时承担「已确认但仍不可用」的兜底：确认框通过后目录仍可能被删除或变成普通文件。
  // 返回 false 让调用方区分「拒绝」与「缓存待投递」，不要把两种结果都当成成功。
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] 打开工作区路径无效，已忽略", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    // [并发] 命中未就绪窗口时只能覆盖 pendingOpenWorkspaceRequest，不能排队：同一时刻只保留最后一次打开意图。
    // 覆盖而不追加是有意的：连续点击多个目录时，最后一次必须是用户当下想打开的。
    // 返回 true 表示「已接管」，调用方不能据此认为已经投递成功。
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      // 缓存时必须记录目标窗口 id，deliverPendingDeepLink 才能只投递给这一个窗口。
      // 覆盖赋值而非追加：同一时刻只允许一个待打开目录，多个目录的意图无法安全合并。
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // 冷启动 argv deep link 会在主窗口创建后、renderer 注册
      // onOpenWorkspacePath 之前到达。此时直接 webContents.send 会丢 IPC，
      // 必须等 renderer 主动上报 ready 后再投递目录路径。
      logger.warn("[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready", {
        windowId: targetWebContentsId,
        path,
      });
      return true;
    }

    // [契约] 执行到这里时 id 已在 ready 集合中，不能再补 try/catch 兜底：抛异常说明状态机已被破坏。
    // 通道只传路径字符串，工作区加载由 renderer 发起，Main 不在这里触碰文件系统。
    // send 之后才聚焦，顺序不能颠倒，否则用户看到的是尚未开始加载的空壳窗口。
    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] 工作区打开请求路由成功", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  // 协议注册早于窗口创建时走这里，此时没有窗口可缓存，直接返回 false。
  // 只有冷启动 argv 路径允许无窗口缓存，否则外部链接会在应用空闲时留下永不消费的条目。
  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] 工作区打开请求暂未命中窗口，已忽略", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn("[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready", { path });
  return false;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 URL:", url);
    return false;
  }

  // [事务] workspace 分支必须排在支付、share、OAuth 之前，协议前缀重叠时先命中者决定语义。
  // 该分支包含确认弹窗，是唯一会阻塞主进程的用户交互路径，不能挪进任何异步回调。
  // 路径缺失、网络路径、gate 阻止三种失败返回的布尔值不同，调用方依赖它区分是否已消费。
  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] 工作区打开请求缺少 path，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    // [失败路径] 与 isValidLocalWorkspaceDirectory 内的判断重复是有意的双保险：确认框之前就要拒绝。
    // 不能因为「后面还会校验」而删掉，确认弹窗本身会展示 UNC 路径并诱导用户点击打开。
    if (isNetworkWorkspacePath(workspacePath)) {
      // Windows UNC 路径在 statSync 校验阶段就会触发 SMB 认证。
      // deep link 是外部输入，必须在任何文件系统探测前拒绝网络路径。
      logger.warn("[deep-link] 网络工作区路径已拒绝", { path: workspacePath });
      return false;
    }

    // 强制升级 gate 是进程级状态，被阻止时返回 true：链接已被处理，只是以拒绝告终，避免调用方重试。
    // onWorkspaceOpenBlocked 用于把拒绝反馈给 UI，不能改成抛异常，主进程异常会中断后续 deep link。
    // gate 判断必须在确认弹窗之前，否则升级期用户仍会被引导去确认一个注定失败的打开操作。
    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // 强制升级是进程级 gate，workspace deep link 不能先进入缓存/投递路径。
      logger.warn("[deep-link] 工作区打开请求被当前启动 gate 阻止", { path: workspacePath });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open 来自浏览器/IM 等外部应用，不能等同于用户在
    // ZCode 内部选择目录；确认必须发生在 statSync 之前，避免项目配置被静默信任。
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  // 支付回调原样透传 URL 而不解析订单字段：校验与幂等由 renderer 与服务端负责，Main 不持有业务状态。
  // 无窗口时缓存的是完整 URL 而非解析结果，保证重放与实时投递完全等价。
  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 支付回调路由成功", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn("[deep-link] 支付回调暂未命中窗口，先缓存等待 renderer ready", {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] share import code 无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // share 分支也必须走 resolveApplicationWindow——聚焦兜底
    // getAllWindows()[0] 会命中 CUA indicator 等辅助窗口；且 pending 队列必须绑定目标窗口，
    // 否则多窗口时导入会投递给先 ready 的 renderer，写入错误 workspace 的 .zcode-share。
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import 等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import 路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import 等待主窗口");
    return false;
  }

  // 走到这里仍不是 OAuth 回调说明是未知协议形态，静默返回 false 由上层决定是否记日志。
  // 不能在此统一打 warn：未知链接可能来自其他厂商对 zcode 前缀的探测，会产生噪声。
  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  // [失败路径] state 缺失时无法定位窗口，宁可丢弃也不投给焦点窗口，避免凭据串号。
  // get 只取第一个同名参数，重复 state 属于可疑输入，不做合并或猜测。
  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] OAuth 回调缺少 state，忽略此次回调", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  // 窗口 id 会复用，找到的窗口未必是当初注册的那一个，这是已知局限，不做指纹校验。
  // routeTarget 存在但窗口已销毁时不要清理映射：用户可能重新打开窗口后继续这次授权。
  // 查找只按 state、不看 provider：state 已由 provider 生成且足够唯一，混入 provider 会让查找更脆。
  const routeTarget = oauthStateToWindow.get(state);
  const targetWindow = routeTarget
    ? BrowserWindow.getAllWindows().find((window) => window.webContents.id === routeTarget.windowId)
    : null;
  // [事务] 只有带授权码才算流程完成；无 code 的回调（用户取消、provider 报错）必须保留映射。
  // 提前删除映射会让重试命不中目标窗口，只能落到 pendingDeepLinkUrl 并由下一个 ready 窗口消费。
  // 删除与投递在同一同步块内完成，中间不能插入 await，否则并发的第二个回调会看到半完成状态。
  const shouldCompleteOAuthRoute = hasOAuthAuthorizationCode(parsedUrl);

  if (targetWindow) {
    // 透传原始 URL 而不是拆好的 code：provider 差异（code 与 authCode、额外参数）交由上层解析。
    // 这次 send 与 state 删除属于同一次同步事务，中间插入其它操作会放大并发回调的竞态窗口。
    targetWindow.webContents.send(PlatformChannels.OAuthCallback, url);
    if (shouldCompleteOAuthRoute) {
      oauthStateToWindow.delete(state);
    }
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] OAuth 回调路由成功", {
      state,
      windowId: targetWindow.webContents.id,
      provider: routeTarget?.provider,
      completed: shouldCompleteOAuthRoute,
    });
    return true;
  }

  // [资源] 该字段只保存一条，后到的回调覆盖先到的；OAuth 回调串行到达，覆盖是最小安全实现。
  // 写入后必须等 deliverPendingDeepLink 消费，重复调用会重复投递同一个 URL。
  pendingDeepLinkUrl = url;
  logger.warn("[deep-link] OAuth 回调未命中目标窗口，先缓存等待 renderer ready", {
    state,
    hasRouteTarget: Boolean(routeTarget),
  });
  return false;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  const scheme = "zcode";

  // 外部 URL 必须位于 -- 后；否则 Windows 引号拆分可把 URL 内容变成 Electron 启动参数。
  // Inspector 早于应用 JS 和单实例锁启动，不能依赖后续 handleDeepLink 校验拦截。
  // [权衡] 开发态必须把入口脚本作为参数交给系统注册，否则协议唤起的是 Electron 二进制而不是本项目。
  // argv.length 的判断防止 process.argv[1] 不存在时对 undefined 求 resolve。
  // 此分支 return 后不再走 Linux 注册：defaultApp 只存在于开发环境，包装后的注册没有意义。
  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const args = process.platform === "win32" ? [entry, "--"] : [entry];
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, args);
    if (!ok) {
      logger.warn("[deep-link] 注册协议失败（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] 注册协议成功（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return;
  }

  // 打包态的 Windows 也必须补 --：缺少它时系统传入的 URL 会与 Electron 自身开关混在同一参数序列里。
  // 非 Windows 平台不能带额外参数，macOS 的协议注册不接受 argv 形式。
  const ok =
    process.platform === "win32"
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, ["--"])
      : app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] 注册协议失败", { scheme });
  } else {
    logger.info("[deep-link] 注册协议成功", { scheme });
  }

  // Linux 需要额外的 desktop entry 注册，Electron 自带注册在部分发行版不生效，故必须交给独立模块。
  // 只在打包态执行：开发态的 desktop 文件指向临时 electron 路径，重启后失效并残留。
  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      productName: app.name,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  oauthStateToWindow.set(registration.state, {
    windowId,
    provider: registration.provider,
  });

  // [资源] 定时器不保存句柄也不 unref，进程退出时由运行时统一回收，无需手动清理。
  // 到期只删映射、不通知 renderer：用户回到登录页重试会重新注册新的 state。
  // 同一 state 重复注册会叠加多个定时器，旧定时器删除时可能误删新注册的条目，这是概率极低的已知窗口。
  setTimeout(() => oauthStateToWindow.delete(registration.state), 5 * 60 * 1000);
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  const hasPendingOAuthCallback = pendingDeepLinkUrl != null;
  // pending share import 绑定目标窗口后，只投递给目标窗口（或冷启动时未绑定目标的
  // 条目）；非目标窗口 ready 时保留条目，否则导入会写进错误窗口的 workspace。
  // [并发] 先整表 splice 再按目标窗口回填，保证遍历期间新入队的条目不会被本轮消费。
  // 不能用 filter 后整体替换：splice 返回的快照才是消费边界，替换会丢掉遍历期间新增的条目。
  // 回填必须保持原有相对顺序，否则同一窗口的多个导入会乱序写入。
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      // 重放时只传 shareCode，丢弃绑定字段，renderer 无需感知路由信息以免被误用。
      // 该条目不在这里出队，出队已由外层 splice 完成，重复 push 会让一次导入被投递两次。
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  // 回填发生在所有 send 之后，避免 send 抛异常时条目既没投递也没留在队列。
  // 回填到队尾而非队首：这些条目必须等更晚的窗口才能投递，应排在新增条目之后处理。
  pendingShareImports.push(...undeliveredShareImports);
  if (hasPendingOAuthCallback) {
    webContents.send(PlatformChannels.OAuthCallback, pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  // 窗口销毁必须先摘掉 ready 标记，否则同 id 复用的新窗口会被判定为可直接 send。
  // 这是清理入口的第一行，后续 pending 清理都依赖该窗口已不再被视为可投递。
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  // pending share import 绑定目标窗口后，目标窗口关闭必须同步清理，
  // 否则队列条目永不过期，可能投递给后续 ready 的其他窗口（错误 workspace）。
  // 倒序遍历才能安全 splice；正序删除会跳过紧邻的下一个元素。
  // 只删绑定当前窗口的条目，未绑定目标的冷启动条目要留给后续窗口消费。
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
    }
  }
}
