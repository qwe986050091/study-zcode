/* eslint-disable max-lines -- share 公开页的状态文案、Row allow-list 和登录态需保持同一安全边界。 */
// ============================================================================
// 文件头：职责边界与不变量（INV）
// ============================================================================
//
// 【职责边界】
// - 公开分享落地页：只负责把 ConversationSharePreview 渲染成只读时间线，
//   并给出加载/登录/各类错误的可行动状态；鉴权、拉取、分享权限判定都不在这里。
// - 数据获取统一在 ConversationShareLandingLoader，页面组件只接受 ready 的 preview。
//
// 【不变量 INV】
// INV-01 只有 loader 能调用 client.getPreview；页面组件不得自行发请求，
//   否则会绕过「有 token 先带 token」的往返优化与登出清理。
// INV-02 公开分享必须允许匿名首次请求；无 token 时不得先弹登录，
//   否则所有 public 分享都会多一次无谓登录。
// INV-03 带 token 仍返回 authentication_required 时必须先 onLogout 再展示错误；
//   漏掉会让本地坏 token 一直复用，用户永远进不去。
// INV-04 not_found 与 authentication_required 在匿名态都转 login_required；服务端
//   刻意隐匿无权限分享的存在性，前端不能据此断言「不存在」。
// INV-05 只需 result 变化才重渲染 headerView；测量结果逐字段比较后复用旧对象，
//   否则 ResizeObserver 回调会引发无限渲染。
// INV-06 header 测量必须在 useLayoutEffect 中完成并在首帧同步调用一次；
//   放到 useEffect 会让标题与按钮先闪一帧错误位置。
// INV-07 所有测量节点必须有 aria-hidden/tabIndex=-1，且不得参与可访问性树；
//   否则屏幕阅读器会把测量用的重复标题与按钮读两遍。
// INV-08 结果物数量只统计 rows 中 kind=artifact 的条目；用 artifacts.length 会把
//   userInput 附件 manifest 也算进去，数字偏大。
// INV-09 importLink 仅在 public_importable/private 时生成；其他模式不得渲染
//   「去 ZCode 继续」入口，否则深链必然失效。
// INV-10 深链点击后 1.5s 内页面仍可见才提示「未自动打开」；立即提示会在正常唤起时误报。
// INV-11 只有可能因重试而改变结果的错误才给重试按钮；过期/版本过高/无权限给重试
//   等于给一个必然失败的动作。
// INV-12 登录按钮必须同时提供 z.ai 与 BigModel；private 分享的 owner 身份是
//   provider 特定的，猜错会把用户挡在自己的分享外。
// INV-13 主题切换要同时写 localStorage、setState 与 applyTheme；只做其一会导致
//   刷新后回退或同页其它组件不同步。
// INV-14 站点下载地址是根域名，没有 /download 路径；改成子路径会 404。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { ArrowUpRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ConversationSharePreview } from "@zcode/shared";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import { renderOAuthProviderIcon } from "@zcode/ui/oauth-provider-icon";
import { applyTheme, resolveTheme, type Theme } from "@zcode/ui/useTheme";
import "./conversationShareLandingPage.css";
import type { WebOAuthProviderId } from "../auth/browserOAuthCredentialRepo.js";
import {
  buildShareImportDeepLink,
  type ConversationSharePreviewClientError,
  type ConversationSharePreviewErrorKind,
} from "./conversationSharePreviewClient.js";
import { resolveShareHeaderView, type ShareHeaderView } from "./shareHeaderLayout.js";

/** 登录入口的展示顺序，与桌面端登录卡片一致（z.ai 在上）。 */
// [契约] 顺序即渲染顺序，z.ai 在前与桌面端登录卡片一致；
// 两个 provider 都必须保留，见文件头 INV-12。
// 新增 provider 时要同步 Copy.loginWith/loginRegion 的两个语言版本。
const SHARE_LOGIN_PROVIDERS: readonly WebOAuthProviderId[] = [
  ZAI_PROVIDER_ID,
  BIGMODEL_PROVIDER_ID,
];

export type ConversationShareLandingLocale = "zh-CN" | "en-US";
// [契约] 四态联合是 loader 与页面之间的唯一状态契约：ready 之外都交给状态页渲染。
// error 分支携带 status/code/requestId 供「错误详情」展示，缺失时该区域自动隐藏。
// 新增 kind 必须同时更新状态页的 content 映射，否则会落到 network 兜底文案。
export type ConversationShareLandingState =
  | { kind: "loading" }
  | { kind: "login_required" }
  | { kind: "ready"; preview: ConversationSharePreview }
  | {
      kind: "error";
      error: ConversationSharePreviewErrorKind;
      status?: number;
      code?: number;
      requestId?: string;
    };

// [契约] 埋点只记录 stage/kind/errorName/status/code，不记录 token、分享正文或 URL；
// 公开页日志会进浏览器控制台与采集，任何内容都可能被第三方看到。
// [失败路径] 该函数永不抛错：日志失败不能影响错误态渲染。
// stage 区分 anonymous/authenticated，用于判断是否本地登录态失效。
function logPreviewLoadFailure(
  stage: "anonymous" | "authenticated",
  error: unknown,
  kind: ConversationSharePreviewErrorKind,
): void {
  // [契约] 日志只从结构化字段取 status/code，绝不打印 error 原文：
  // 原始 message 可能带分享 URL 或服务端内部信息。
  // 用 Partial 视图读取可避免在 error 为 null 时崩溃；
  // 错误对象的形状由 preview client 保证，这里不做运行时校验。
  const clientError = error as Partial<ConversationSharePreviewClientError> | null;
  // [契约] 结构化字段固定，便于按 kind/status 聚合；不要拼接自由文本。
  // 只在失败时输出，成功路径保持静默，避免公开页刷屏。
  console.warn("[conversation-share-web]", "preview_load_failed", {
    stage,
    kind,
    errorName: error instanceof Error ? error.name : typeof error,
    status: typeof clientError?.status === "number" ? clientError.status : undefined,
    code: typeof clientError?.code === "number" ? clientError.code : undefined,
  });
}

// [契约] 所有用户可见文案必须走 Copy，不允许在 JSX 里写死；
// 两个 locale 缺一字段会在编译期报错，这是刻意的完整性约束。
// 新增文案同时补 zh-CN 与 en-US，英文注意单复数占位。
interface Copy {
  brand: string;
  loading: string;
  loadingDescription: string;
  loginTitle: string;
  loginDescription: string;
  login: string;
  /** 每个 provider 的登录按钮文案与区域徽标，对齐桌面端 login.oauth.* 口径。 */
  loginWith: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  expiredTitle: string;
  expiredDescription: string;
  notFoundTitle: string;
  notFoundDescription: string;
  notFoundAccountHint: string;
  backToHome: string;
  rateLimitedTitle: string;
  rateLimitedDescription: string;
  serviceUnavailableTitle: string;
  serviceUnavailableDescription: string;
  featureDisabledTitle: string;
  featureDisabledDescription: string;
  errorDetails: string;
  requestId: string;
  errorCode: string;
  networkTitle: string;
  networkDescription: string;
  invalidTitle: string;
  invalidDescription: string;
  outdatedTitle: string;
  outdatedDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  retry: string;
  continueInZCode: string;
  switchToDarkTheme: string;
  switchToLightTheme: string;
  continueHelp: string;
  downloadZCode: string;
  retryOpen: string;
  /** 结果物计数；{count} 占位。中文无复数，英文分单复数。 */
  artifactCountOne: string;
  artifactCountOther: string;
}

// 站点首页本身就是下载入口，没有 /download 这个 path（单独的下载链接会 404）。
// [契约] 站点根域名就是下载入口；仓库内没有 /download 路由，拼子路径会 404。
// 该常量同时用于「找不到分享」的回到首页按钮与未唤起提示里的下载链接。
const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai";

// [契约] 文案表按 locale 穷举，Record 保证不会漏语言；
// artifact 计数中英文都保留 One/Other，中文复用同一文案。
// 文案里只允许 {count} 占位，替换点固定在下方的 artifactCountLabel。
const COPY: Record<ConversationShareLandingLocale, Copy> = {
  "zh-CN": {
    brand: "ZCode 会话分享",
    loading: "正在加载分享内容",
    loadingDescription: "请稍候，我们正在验证分享链接。",
    loginTitle: "登录后查看分享",
    loginDescription: "请登录后确认你是否有权限查看这个分享。",
    login: "登录",
    loginWith: {
      zai: "连接 Z.ai 继续使用",
      bigmodel: "连接 BigModel 继续使用",
    },
    loginRegion: { zai: "全球", bigmodel: "中国" },
    expiredTitle: "分享已过期",
    expiredDescription: "这个分享链接已经过期，请让分享者重新生成链接。",
    notFoundTitle: "找不到分享内容",
    notFoundDescription: "链接可能无效、分享已被移除，或当前登录账号无法访问。",
    notFoundAccountHint:
      "Z.ai 与 BigModel 的账号数据不互通。请检查是否选错了登录平台或使用了其他账号。",
    backToHome: "回到首页",
    rateLimitedTitle: "访问过于频繁",
    rateLimitedDescription: "请稍后重试。",
    serviceUnavailableTitle: "分享服务暂时异常",
    serviceUnavailableDescription: "请稍后重试；若仍失败，请提供错误详情。",
    featureDisabledTitle: "分享服务暂未开放",
    featureDisabledDescription: "请稍后再试。",
    errorDetails: "错误详情",
    requestId: "服务端请求 ID",
    errorCode: "错误码",
    networkTitle: "暂时无法加载分享",
    networkDescription: "请检查网络后重试。",
    invalidTitle: "无法读取分享内容",
    invalidDescription: "分享服务返回了无法识别的数据，请提供错误详情。",
    outdatedTitle: "需要更新 ZCode",
    outdatedDescription: "这个分享由更新版本的 ZCode 创建，请升级后再查看。",
    unavailableTitle: "分享不可访问",
    unavailableDescription: "当前账号没有权限，或者分享内容已不存在。",
    retry: "重试",
    continueInZCode: "去 ZCode 继续",
    switchToDarkTheme: "切换到深色主题",
    switchToLightTheme: "切换到浅色主题",
    continueHelp: "如果没有自动打开 ZCode，请先下载客户端，或再次尝试打开。",
    downloadZCode: "下载 ZCode",
    artifactCountOne: "{count} 个结果物",
    artifactCountOther: "{count} 个结果物",
    retryOpen: "再次打开",
  },
  "en-US": {
    brand: "ZCode Conversation Share",
    loading: "Loading shared conversation",
    loadingDescription: "Please wait while we verify this share link.",
    loginTitle: "Sign in to view this share",
    loginDescription: "Sign in to check whether you can view this shared conversation.",
    login: "Sign in",
    loginWith: {
      zai: "Connect to Z.ai",
      bigmodel: "Connect to BigModel",
    },
    loginRegion: { zai: "Global", bigmodel: "CN" },
    expiredTitle: "Share expired",
    expiredDescription: "This share link has expired. Ask the author to create a new one.",
    notFoundTitle: "Share not found",
    notFoundDescription:
      "The link may be invalid, the share may have been removed, or your current account may not have access.",
    notFoundAccountHint:
      "Z.ai and BigModel do not share account data. Check whether you selected the wrong sign-in platform or used a different account.",
    backToHome: "Back to home",
    rateLimitedTitle: "Too many requests",
    rateLimitedDescription: "Try again later.",
    serviceUnavailableTitle: "Sharing service unavailable",
    serviceUnavailableDescription: "Try again later. If this persists, provide the error details.",
    featureDisabledTitle: "Sharing is currently unavailable",
    featureDisabledDescription: "Try again later.",
    errorDetails: "Error details",
    requestId: "Server request ID",
    errorCode: "Error code",
    networkTitle: "Unable to load share",
    networkDescription: "Check your network connection and try again.",
    invalidTitle: "Unable to read shared content",
    invalidDescription:
      "The sharing service returned unrecognized data. Provide the error details.",
    outdatedTitle: "Update ZCode to continue",
    outdatedDescription:
      "This share was created by a newer version of ZCode. Please update to view it.",
    unavailableTitle: "Share unavailable",
    unavailableDescription:
      "This account is not allowed to view the share, or it no longer exists.",
    retry: "Try again",
    continueInZCode: "Continue in ZCode",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
    continueHelp: "If ZCode did not open, download the app or try opening it again.",
    downloadZCode: "Download ZCode",
    artifactCountOne: "{count} artifact",
    artifactCountOther: "{count} artifacts",
    retryOpen: "Try again",
  },
};

// [契约] 显式 locale 优先，缺省才看 navigator.language；
// 服务端注入的 locale 不应被浏览器语言覆盖，否则同一链接分享给不同地区会变语言。
function localeOf(locale?: ConversationShareLandingLocale): ConversationShareLandingLocale {
  if (locale) return locale;
  // [契约] 只区分中文与非中文两类，未知语言一律 en-US；
  // 用 globalThis.navigator 以兼容无 window 的预渲染环境，直接访问 navigator 会抛错。
  // 正则锚定 zh- 或结尾，避免把 zh-Hant 之外的词误判。
  return /^zh(?:-|$)/iu.test(globalThis.navigator?.language ?? "") ? "zh-CN" : "en-US";
}

// [契约] 时间格式化跟随页面 locale，而不是浏览器默认；
// 参数固定 dateStyle=medium + timeStyle=short，保证中英文行高一致。
// 只接受毫秒时间戳，秒级输入会显示到 1970 年。
function formatDate(timestamp: number, locale: ConversationShareLandingLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

// [契约] 内容栏宽度与内边距集中在这里，header、正文、页脚三处共用；
// 分散写死会出现「时间行比正文窄一截」的对齐问题。
// @container/conversation 是子组件响应式断点的容器名，不能改名。
const SHARE_CONTENT_RAIL_CLASS =
  "@container/conversation mx-auto w-full max-w-4xl px-4 sm:px-8 xl:max-w-6xl";
// [契约] 三套 continue 样式分别对应：完整按钮、纯测量用（max-w-none）、
// 窄屏图标按钮；测量节点与服务端渲染必须用同一套类名才能量到真实宽度。
// 改成按条件拼接类名会让测量值与实际值不再一一对应，布局判定失效。
// 焦点环统一用 focus-visible:ring，公开页需要键盘可达。
const SHARE_CONTINUE_LINK_CLASS =
  "inline-flex max-w-full items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused sm:gap-3 sm:px-5 sm:py-2.5";
// [契约] 这是「完整按钮」的宽度测量镜像：max-w-none 让它不被容器截断，
// 量到的才是按钮自然宽度；与真实按钮类名不一致会让阈值判定失真。
// 测量节点必须 aria-hidden 且不可聚焦，否则会产生重复可访问名称与焦点停靠点。
// 它只出现在隐藏的测量容器里，任何样式改动都要与 SHARE_CONTINUE_LINK_CLASS 同步。
// 不需要 shadow/hover 等交互态：宽度只由 padding、字号、gap 决定。
// 如果给测量节点加了过渡动画，量到的会是动画中间值，必须保持无 transition。
const SHARE_CONTINUE_MEASURE_CLASS =
  "inline-flex max-w-none items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground sm:gap-3 sm:px-5 sm:py-2.5";
// [契约] 窄屏图标按钮样式，size-9 是固定方形，测量时必须用同一尺寸；
// 它不参与文字宽度竞争，只用于判定「是否退化为纯图标」。
// 与完整按钮共用 primary 配色，但去掉了 max-w-full/px-4，
// 所以两套类名不能合并，否则测量宽度会互相污染。
// 图标本身用 shrink-0，避免在极窄容器里被压扁。
// 该按钮始终带 aria-label，纯图标不能依赖可见文案。
const SHARE_CONTINUE_COMPACT_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused";
// [契约] 主题切换按钮在真实位置与两个测量容器里复用同一类名，
// 保证量到的占位宽度与渲染一致。
// 尺寸固定 size-8，不随断点变化，因此无需额外断点类。
// 测量容器里用的是静态 MoonIcon 占位，宽度与真实图标一致。
// focus-visible 环必须保留：公开页同样需要键盘可达。
// 不要在这里加 aria 相关属性，语义由使用处的 button 与 label 提供。
const SHARE_THEME_TOGGLE_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused";

// [契约] 主题切换是受控组件：状态由 loader 持有，这里只发意图；
// 缺少 onThemeChange 时点击为空操作，不自行 fallback 写主题。
// 按钮必须带 aria-label 与 title，纯图标否则无可读名称。
function ShareThemeToggle({
  theme,
  copy,
  onThemeChange,
}: {
  theme: Theme;
  copy: Pick<Copy, "switchToDarkTheme" | "switchToLightTheme">;
  onThemeChange?: (theme: Theme) => void;
}) {
  // [契约] 先解析实际明暗再决定图标与文案；对 system 主题直接读 raw 值会误判。
  // resolveTheme 是 ui 包导出的唯一解析入口，页面内不要再写 matchMedia 判断。
  const resolvedTheme = resolveTheme(theme);
  // [契约] 切换目标是具体主题名而非 "system"：用户显式点击后应锁定，
  // 不应再跟随系统变化。
  // 用 resolvedTheme 判断当前实际明暗，raw theme 为 system 时也能给出正确目标。
  const nextTheme = resolvedTheme === "dark" ? "zai-light" : "zai-dark";
  const label = resolvedTheme === "dark" ? copy.switchToLightTheme : copy.switchToDarkTheme;
  const Icon = resolvedTheme === "dark" ? SunIcon : MoonIcon;

  return (
    <button
      type="button"
      data-share-theme-toggle="true"
      className={SHARE_THEME_TOGGLE_CLASS}
      aria-label={label}
      title={label}
      onClick={() => onThemeChange?.(nextTheme)}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function ShareContentRail({
  children,
  className = "",
  body = false,
}: {
  children: React.ReactNode;
  className?: string;
  body?: boolean;
}) {
  return (
    <div
      data-share-content-rail="true"
      data-share-body-rail={body ? "true" : undefined}
      className={`${SHARE_CONTENT_RAIL_CLASS} ${className}`}
    >
      {children}
    </div>
  );
}

function ShareContentInset({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-share-content-inset="true"
      className={`w-full px-4 @md/conversation:px-6 ${className}`}
    >
      {children}
    </div>
  );
}

// [契约] 该组件要求 preview 已就绪；loader 之外的调用方必须自行保证，
// 组件内不做 loading/错误兜底。
// theme 可选：未传时用 zai-light，与服务端首屏一致，避免水合闪烁。
export function ConversationShareLandingPage({
  shareCode,
  preview,
  locale,
  theme,
  onThemeChange,
}: {
  shareCode: string;
  preview: ConversationSharePreview;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
}) {
  const resolvedLocale = localeOf(locale);
  // [契约] 文案取自已穷举的 COPY，不做缺省合并；缺 key 属于编译期问题，
  // 运行时兜底只会掩盖漏翻译。
  // locale 归一在 localeOf 完成，这里不再判断。
  const copy = COPY[resolvedLocale];
  // [契约] 缺省主题是 zai-light（浅色）而不是 system：公开页首屏需要确定性外观。
  // 该值只用于图标方向，真正应用主题由 loader 的 handleThemeChange 负责。
  const activeTheme = theme ?? "zai-light";
  // preview 到手后把会话标题写进浏览器标签；main.tsx 只能先给一个语言正确的兜底标题。
  // [契约] 标题直接取 preview，不做截断或空值兜底：空标题是分享端的数据问题，
  // 页面不应编造文案。
  // 同一标题同时用于 document.title、h1 与测量节点，三处必须同源。
  const shareTitle = preview.share.title;
  useEffect(() => {
    // [契约] 文档标题依赖 preview，因此只能在 ready 后设置；main.tsx 只能给语言兜底标题。
    // [资源] effect 依赖 copy.brand 与 shareTitle，切换语言时标题同步更新。
    document.title = `${shareTitle} · ${copy.brand}`;
  }, [copy.brand, shareTitle]);
  // [契约] 未唤起提示默认不显示，只在本页常驻期间有效；
  // 离开页面（真正唤起成功）后自然消失：`pendingShareOpen` 不持久化。
  const [showContinueHelp, setShowContinueHelp] = useState(false);
  // [契约] 只有 public_importable 与 private 生成导入深链；其他 access_mode 下
  // 没有可导入内容，渲染入口只会给用户一个失败链接。
  // importLink 同时控制 header 按钮、提示横幅与页脚按钮三处可见性。
  // 它是 header 测量的 hasContinueAction 输入，改变语义会连带布局判定。
  const importLink =
    preview.share.access_mode === "public_importable" || preview.share.access_mode === "private"
      ? buildShareImportDeepLink(shareCode)
      : null;
  // 结果物数量只统计时间线实际展示的 artifact Row；preview.artifacts 还包含 userInput
  // 附件的下载 manifest，不能直接拿 manifest 数量当作结果物数量。
  // [契约] 结果物数量必须按时间线 rows 统计，不能用 preview.artifacts.length：
  // 后者还包含 userInput 附件的下载 manifest，数字会偏大。
  // 过滤条件只有 kind === "artifact"，不要加入下载可用性判断，否则计数随网络状态抖动。
  // 该值是 0 时整段计数文案不渲染。
  const artifactCount = preview.rows.filter((row) => row.kind === "artifact").length;
  // [契约] 单复数选择只看是否等于 1；0 走 Other，符合英文习惯。
  // 占位符固定为 {count}，与 COPY 中两个语言的文案约定一致。
  // 替换用 replace 而非格式化库，避免公开页引入额外依赖。
  const artifactCountLabel = (
    artifactCount === 1 ? copy.artifactCountOne : copy.artifactCountOther
  ).replace("{count}", String(artifactCount));
  // [契约] 时间线只拿到 id→url / id→name 两个索引，不接触完整 artifacts 列表；
  // 这样渲染层无法误把 manifest 当作可见内容。
  // 索引只在 preview 变化时重建，effect 里不要重复构造。
  const artifactUrls = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.url]),
  );
  const artifactNames = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.display_name]),
  );
  // [契约] 一组 ref 对应一组测量节点：row/shell/brand/title/titleMeasure/continueMeasure；
  // 少挂一个会让对应宽度退化为兜底值，布局在窄屏下错位。
  // 测量节点与真实节点必须成对渲染，不能复用同一个 ref。
  const headerRowRef = useRef<HTMLDivElement>(null);
  const headerShellRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleMeasureRef = useRef<HTMLSpanElement>(null);
  const continueMeasureRef = useRef<HTMLSpanElement>(null);
  const compactContinueMeasureRef = useRef<HTMLSpanElement>(null);
  // [契约] headerMeasured 只用于 data 属性，让 CSS 在测量完成前隐藏/降级布局；
  // 它不参与几何计算，置 true 后不再回退。
  // 不要在测量失败时保持 false 并阻塞渲染，首帧必须可见。
  const [headerMeasured, setHeaderMeasured] = useState(false);
  // [契约] 初值是「未测量」的保守几何：continueVisible 仅取决于是否有深链，
  // 其余为 0，保证首帧不会把标题推到容器外。
  // [权衡] 初值故意与测量结果不同，使 setHeaderView 的比较能识别首次测量。
  // 字段必须与 ShareHeaderView 完全一致，缺字段会导致比较逻辑永远不等。
  const [headerView, setHeaderView] = useState<ShareHeaderView>({
    progress: 0,
    brandLeft: 0,
    titleLeft: 0,
    titleWidth: 0,
    continueRight: 0,
    titleTruncated: false,
    continueVisible: Boolean(importLink),
    continueCompact: false,
  });

  // [契约] 必须在 layout 阶段同步测量并应用，避免标题/按钮先渲染在错误位置再跳动。
  // 依赖只有 locale 与 importLink：字体加载导致的尺寸变化由 ResizeObserver 兜底。
  // [资源] 卸载时 disconnect，防止观察器持有已卸载节点。
  useLayoutEffect(() => {
    const row = headerRowRef.current;
    if (!row) return;
    // [契约] 每次测量都重新读 getBoundingClientRect，不做缓存：字体换行、语言切换
    // 都会改变宽度，缓存值会让布局停在旧状态。
    // shellRect 缺失时直接返回，此时尚无可信坐标，写入会污染 headerView。
    // 所有宽度都有兜底值（brand 50、其余 0），保证首次渲染也能算出一个可用布局。
    const updateLayout = () => {
      const rowRect = row.getBoundingClientRect();
      const shellRect = headerShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;
      // [契约] 布局判定全部收敛到纯函数 resolveShareHeaderView，组件只提供测量输入；
      // 把阈值写回组件会让 SSR 与客户端判定不一致。
      // railContentLeft/Right 用相对 shell 的偏移，而不是绝对坐标，滚动时才稳定。
      // hasContinueAction 决定按钮是否参与空间竞争，必须与 importLink 同源。
      const nextView = resolveShareHeaderView({
        shellWidth: shellRect.width,
        railContentLeft: rowRect.left - shellRect.left,
        railContentRight: shellRect.right - rowRect.right,
        brandWidth: brandRef.current?.getBoundingClientRect().width ?? 50,
        titleContentWidth: titleMeasureRef.current?.getBoundingClientRect().width ?? 0,
        continueWidth: continueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        compactContinueWidth: compactContinueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        hasContinueAction: Boolean(importLink),
      });
      setHeaderMeasured(true);
      // [并发] 逐字段比较后返回原对象，避免 ResizeObserver 高频回调触发无意义渲染；
      // 返回新对象会让「观察→渲染→再观察」形成抖动。
      // 比较必须覆盖全部字段，漏一个就会出现「某字段更新了但界面没变」。
      // setHeaderMeasured 在比较之前调用，保证 ready 标记只置一次。
      // 这里不做节流：测量本身很轻，节流反而会让恢复后的布局延迟一帧。
      setHeaderView((current) =>
        current.progress === nextView.progress &&
        current.brandLeft === nextView.brandLeft &&
        current.titleLeft === nextView.titleLeft &&
        current.titleWidth === nextView.titleWidth &&
        current.continueRight === nextView.continueRight &&
        current.titleTruncated === nextView.titleTruncated &&
        current.continueVisible === nextView.continueVisible &&
        current.continueCompact === nextView.continueCompact
          ? current
          : nextView,
      );
    };
    updateLayout();
    // [失败路径] 缺少 ResizeObserver 时只做一次同步测量就退出，不抛错也不降级轮询；
    // 老浏览器下布局仍可用，只是不会跟随窗口变化。
    // 该判断必须在首次 updateLayout 之后，保证至少有初值。
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(row);
    if (headerShellRef.current) observer.observe(headerShellRef.current);
    if (brandRef.current) observer.observe(brandRef.current);
    if (titleRef.current) observer.observe(titleRef.current);
    if (titleMeasureRef.current) observer.observe(titleMeasureRef.current);
    if (continueMeasureRef.current) observer.observe(continueMeasureRef.current);
    if (compactContinueMeasureRef.current) observer.observe(compactContinueMeasureRef.current);
    // [资源] 清理函数必须 disconnect 而非 unobserve 单个节点：观察目标有七个，
    // 漏掉任何一个都会在切换语言后累积观察器。
    return () => observer.disconnect();
  }, [resolvedLocale, importLink]);

  // [契约] 几何通过 CSS 变量下发，样式表只消费变量；这样固定头部在滚动时
  // 不需要 React 逐帧重算。
  // 变量名与 css 文件里的 --share-* 一一对应，改名必须同步样式。
  // 值统一加 px 后缀，CSS 侧直接使用，不做二次单位换算。
  const headerGeometryStyle = {
    "--share-brand-left": `${headerView.brandLeft}px`,
    "--share-title-left": `${headerView.titleLeft}px`,
    "--share-title-width": `${headerView.titleWidth}px`,
    "--share-continue-right": `${headerView.continueRight}px`,
  } as CSSProperties;

  const handleContinue = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // [契约] 点击深链先阻止默认跳转，再手动赋值 location，目的是能在同一页面
      // 检测「是否真的唤起了客户端」。
      // 不 preventDefault 就无法在唤起失败时给出提示。
      event.preventDefault();
      setShowContinueHelp(false);
      // [契约] 使用非空断言是因为渲染入口已由 importLink 控制；新增调用点时
      // 必须自行保证非空，不要改成宽松的 href 拼接。
      // 该赋值是页面唯一的「离开当前文档」副作用。
      window.location.href = importLink!;
      window.setTimeout(() => {
        // [失败路径] 1.5s 后仍可见说明没有切到客户端，才提示下载/重试；
        // 页面被切到后台即视为唤起成功，`visibilityState` 判据不打扰用户。
        // 延迟值 1500ms 是权衡：太短会误报，太长用户已自行处理。
        if (document.visibilityState === "visible") {
          setShowContinueHelp(true);
        }
      }, 1500);
    },
    [importLink],
  );

  return (
    <main
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-background text-foreground [scrollbar-gutter:stable]"
      data-markdown-table-layout-root="true"
      data-share-scroll-viewport="true"
    >
      <header
        data-share-header="true"
        className="sticky top-0 z-20 border-b border-border bg-background backdrop-blur"
      >
        <div
          ref={headerShellRef}
          data-share-header-shell="true"
          data-share-header-layout="continuous"
          data-share-header-ready={headerMeasured ? "true" : "false"}
          className="w-full"
          style={headerGeometryStyle}
        >
          <ShareContentRail className="flex h-16 items-center">
            <ShareContentInset>
              <div
                ref={headerRowRef}
                data-share-header-row="true"
                className="h-full w-full min-w-0"
              >
                <div
                  ref={brandRef}
                  data-share-brand="true"
                  className="shrink-0 text-ui-lg font-semibold text-foreground"
                  aria-label="ZCode"
                >
                  ZCode
                </div>
                <h1
                  ref={titleRef}
                  data-share-title="true"
                  data-share-title-truncated={headerView.titleTruncated ? "true" : "false"}
                  className="truncate text-left text-ui-lg font-medium"
                  title={preview.share.title}
                >
                  {preview.share.title}
                </h1>
                <span
                  ref={titleMeasureRef}
                  data-share-title-measure="true"
                  className="text-ui-lg font-medium"
                  aria-hidden="true"
                >
                  {preview.share.title}
                </span>
                <div
                  data-share-continue-slot="true"
                  data-share-continue-visible={
                    importLink && headerView.continueVisible ? "true" : "false"
                  }
                >
                  <div className="flex items-center gap-2">
                    <ShareThemeToggle
                      theme={activeTheme}
                      copy={copy}
                      onThemeChange={onThemeChange}
                    />
                    {importLink && headerView.continueVisible ? (
                      <a
                        data-share-continue-link="true"
                        data-share-continue-compact={headerView.continueCompact ? "true" : "false"}
                        className={
                          headerView.continueCompact
                            ? SHARE_CONTINUE_COMPACT_CLASS
                            : SHARE_CONTINUE_LINK_CLASS
                        }
                        href={importLink}
                        aria-label={copy.continueInZCode}
                        title={copy.continueInZCode}
                        onClick={handleContinue}
                      >
                        <span className={headerView.continueCompact ? "sr-only" : "truncate"}>
                          {copy.continueInZCode}
                        </span>
                        <ArrowUpRightIcon
                          className={
                            headerView.continueCompact
                              ? "size-4 shrink-0"
                              : "size-4 shrink-0 sm:size-5"
                          }
                          aria-hidden="true"
                        />
                      </a>
                    ) : null}
                  </div>
                  <span
                    ref={continueMeasureRef}
                    data-share-continue-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_MEASURE_CLASS}>
                        <span>{copy.continueInZCode}</span>
                        <ArrowUpRightIcon
                          className="size-4 shrink-0 sm:size-5"
                          aria-hidden="true"
                        />
                      </span>
                    ) : null}
                  </span>
                  <span
                    ref={compactContinueMeasureRef}
                    data-share-continue-compact-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_COMPACT_CLASS}>
                        <ArrowUpRightIcon className="size-4" aria-hidden="true" />
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </ShareContentInset>
          </ShareContentRail>
        </div>
      </header>

      <ShareContentRail body className="py-6 sm:py-10">
        <ShareContentInset>
          <div
            data-share-metadata="true"
            className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          >
            <span>{formatDate(preview.share.created_at, resolvedLocale)}</span>
            {artifactCount ? (
              // 这里原本硬编码英文 artifact/artifacts 且手写复数，中文页会渲染成
              // 「2026年9月3日 11:55 · 1 artifact」这种中英混排。
              <span aria-label={artifactCountLabel}>· {artifactCountLabel}</span>
            ) : null}
          </div>
        </ShareContentInset>
        {importLink && showContinueHelp ? (
          // 这块原本是 ShareContentRail 的直接子元素，没套 ShareContentInset，
          // 因此缺了 inset 的 px-4 / @md:px-6，横幅比上方时间行和下方正文都宽出一截。
          <ShareContentInset>
            <div
              className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
              role="status"
            >
              <span>{copy.continueHelp}</span>
              <a
                className="text-brand underline underline-offset-2"
                href={importLink}
                onClick={handleContinue}
              >
                {copy.retryOpen}
              </a>
              <a className="text-brand underline underline-offset-2" href={ZCODE_DOWNLOAD_URL}>
                {copy.downloadZCode}
              </a>
            </div>
          </ShareContentInset>
        ) : null}
        <ConversationShareReadonlyTimeline
          rows={preview.rows}
          contentBlocks={preview.content_blocks}
          unsupportedRowCount={preview.unsupportedRowCount}
          locale={resolvedLocale}
          theme={theme}
          artifactUrls={artifactUrls}
          artifactNames={artifactNames}
        />
        {importLink ? (
          <ShareContentInset>
            <div
              data-share-continue-footer="true"
              className="flex justify-center pb-2 pt-8 sm:pt-10"
            >
              <a
                data-share-continue-link="true"
                className={SHARE_CONTINUE_LINK_CLASS}
                href={importLink}
                onClick={handleContinue}
              >
                <span className="truncate">{copy.continueInZCode}</span>
                <ArrowUpRightIcon className="size-4 shrink-0 sm:size-5" aria-hidden="true" />
              </a>
            </div>
          </ShareContentInset>
        ) : null}
      </ShareContentRail>
    </main>
  );
}

export function ConversationShareLandingStatus({
  state,
  locale,
  onLogin,
  onRetry,
}: {
  state: Exclude<ConversationShareLandingState, { kind: "ready" }>;
  locale?: ConversationShareLandingLocale;
  onLogin?: (provider: WebOAuthProviderId) => void;
  onRetry?: () => void;
}) {
  const copy = COPY[localeOf(locale)];
  // [契约] 错误种类到文案的映射采用穷举三元链，最后落到 network 兜底；
  // 新增错误种类必须在此显式登记，否则会被当成网络问题误导用户。
  // service_unavailable 与 unknown 共用一组文案，二者对用户而言都是「服务端问题」。
  // authentication_required 复用登录文案，因为该状态下页面表现就是要求登录。
  // 映射只决定标题/描述，不影响 showLogin/canRetry 的行为判定。
  const content =
    state.kind === "loading"
      ? { title: copy.loading, description: copy.loadingDescription }
      : state.kind === "login_required"
        ? { title: copy.loginTitle, description: copy.loginDescription }
        : state.error === "rate_limited"
          ? { title: copy.rateLimitedTitle, description: copy.rateLimitedDescription }
          : state.error === "feature_disabled"
            ? { title: copy.featureDisabledTitle, description: copy.featureDisabledDescription }
            : state.error === "service_unavailable" || state.error === "unknown"
              ? {
                  title: copy.serviceUnavailableTitle,
                  description: copy.serviceUnavailableDescription,
                }
              : state.error === "expired"
                ? { title: copy.expiredTitle, description: copy.expiredDescription }
                : state.error === "not_found"
                  ? { title: copy.notFoundTitle, description: copy.notFoundDescription }
                  : state.error === "unsupported_schema_version"
                    ? { title: copy.outdatedTitle, description: copy.outdatedDescription }
                    : state.error === "invalid_contract"
                      ? { title: copy.invalidTitle, description: copy.invalidDescription }
                      : state.error === "authentication_required"
                        ? { title: copy.loginTitle, description: copy.loginDescription }
                        : { title: copy.networkTitle, description: copy.networkDescription };
  // [契约] 只有 login_required 与 authentication_required 显示登录按钮；
  // 其他错误即使可能通过登录解决也不展示，避免把用户导向错误动作。
  const showLogin =
    state.kind === "login_required" ||
    (state.kind === "error" && state.error === "authentication_required");
  // [契约] not_found 才展示账号提示与「回到首页」，因为服务端隐匿了「无权限」与
  // 「不存在」的区别，这是唯一温和的排查建议。
  // 不要把它扩展成 authentication_required 的展示条件，两者动作不同。
  const isNotFound = state.kind === "error" && state.error === "not_found";
  /**
   * 只在「重发同一个请求有可能得到不同结果」时给重试。
   *
   * 需要登录时该做的是登录，重发未授权请求结果不变；已过期不会自己变回未过期；载荷版本
   * 高于本 build 得升级客户端。这几种给重试等于给一个必然无效的动作。
   */
  // [契约] 重试只对「重发可能得到不同结果」的错误开放：网络/限流/服务异常/未知；
  // 登录、过期、版本过高、无权限、契约非法都不给。
  // state.kind !== loading 防止加载中重复触发；showLogin 优先于重试。
  // onRetry 必须存在，否则按钮点击无效果。
  // 该判定与 content 映射分离：文案相同的错误可以有不同可重试性。
  const canRetry =
    Boolean(onRetry) &&
    state.kind !== "loading" &&
    !showLogin &&
    !(
      state.kind === "error" &&
      (state.error === "expired" ||
        state.error === "unsupported_schema_version" ||
        state.error === "feature_disabled" ||
        state.error === "not_found" ||
        state.error === "invalid_contract")
    );
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-card-border bg-card p-6 shadow-sm">
        <div className="mb-4 text-ui-sm font-medium text-brand">{copy.brand}</div>
        <h1 className="text-ui-xl font-semibold">{content.title}</h1>
        <p className="mt-3 text-ui-base leading-6 text-foreground-subtle">{content.description}</p>
        {state.kind === "error" &&
        (state.status !== undefined || state.code !== undefined || state.requestId) ? (
          <details className="mt-4 text-ui-xs text-foreground-subtle">
            <summary className="cursor-pointer">{copy.errorDetails}</summary>
            {[
              ["HTTP", state.status],
              [copy.errorCode, state.code],
              [copy.requestId, state.requestId],
            ].map(([label, value]) =>
              value === undefined ? null : (
                <p key={label} className="mt-1 break-all select-text">
                  {label}: {value}
                </p>
              ),
            )}
          </details>
        ) : null}
        {/* 服务端会隐匿无权限分享的存在性，账号提示仅作排查建议，不能断言用户登录错了。 */}
        {isNotFound ? (
          <p className="mt-4 text-ui-base leading-6 text-foreground-subtle">
            {copy.notFoundAccountHint}
          </p>
        ) : null}
        {/*
          两个 provider 竖排全宽，对齐桌面端登录卡片（图标 + 文案 + 区域徽标）。
          必须两个都给：private 分享的 owner 身份是 provider 特定的，页面无法预先知道
          这份分享属于哪一边——猜错就等于把用户挡在自己的分享外面。
        */}
        {showLogin && onLogin ? (
          <div className="mt-5 space-y-2">
            {SHARE_LOGIN_PROVIDERS.map((provider) => (
              <button
                key={provider}
                type="button"
                data-share-login-provider={provider}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-ui-base text-primary-foreground"
                onClick={() => onLogin(provider)}
              >
                {renderOAuthProviderIcon(provider, "size-4")}
                <span className="min-w-0 truncate">{copy.loginWith[provider]}</span>
                <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
                  {copy.loginRegion[provider]}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {canRetry || isNotFound ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {canRetry ? (
              <button
                type="button"
                className="rounded-md border border-border px-4 py-2 text-ui-base text-foreground"
                onClick={onRetry}
              >
                {copy.retry}
              </button>
            ) : null}
            {isNotFound ? (
              <a
                className="rounded-md bg-primary px-4 py-2 text-ui-base text-primary-foreground"
                href={ZCODE_DOWNLOAD_URL}
              >
                {copy.backToHome}
              </a>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function ConversationShareLandingLoader({
  shareCode,
  client,
  getAccessToken,
  onLogin,
  onLogout,
  locale,
  theme,
}: {
  shareCode: string;
  client: {
    getPreview: (shareCode: string, accessToken?: string) => Promise<ConversationSharePreview>;
  };
  getAccessToken?: () => string | null;
  onLogin?: (provider: WebOAuthProviderId) => void;
  onLogout?: () => void;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
}) {
  // [契约] loader 持有唯一状态源，页面/状态页都是它的投影；
  // 错误态只存一份：`shareError` 由父级持有，子组件不再复制。
  const [state, setState] = useState<ConversationShareLandingState>({ kind: "loading" });
  // [契约] 初始主题来自 props，之后完全由本地切换控制；
  // 不监听 props 变化，避免父级重渲染覆盖用户刚做的选择。
  // localStorage 只在切换时写入，首屏不读取，保证服务端与客户端初始一致。
  const [activeTheme, setActiveTheme] = useState<Theme>(theme ?? "zai-light");
  // [契约] 三处写入必须一起做：localStorage 供下次加载、state 供本次渲染、
  // applyTheme 供 CSS 变量立即生效。
  // 顺序固定为先存储后应用，避免应用失败时状态与存储不一致。
  const handleThemeChange = useCallback((nextTheme: Theme) => {
    localStorage.setItem("zcode-theme", nextTheme);
    setActiveTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);
  useEffect(() => {
    // [契约] 只有 system 主题才监听系统明暗变化；显式主题下监听会让用户选择被系统覆盖。
    // [资源] 清理时移除同一回调引用，必须复用 handleSystemThemeChange 变量。
    if (activeTheme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyTheme("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [activeTheme]);
  // [契约] 拉取流程：先置 loading，再带当前 token 请求一次；不先弹登录。
  // [失败路径] error.kind 缺失时按 network 处理（未知属于可重试类），
  // 同时把 status/code/requestId 原样带进错误态供详情展示。
  // 依赖包含 client/getAccessToken/onLogout/shareCode，任一变化都会重建 loader。
  // 该函数不抛错：所有失败都转成 state，避免未处理 rejection。
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    // 有登录态就第一次直接带上：private 分享匿名请求必然被服务端按存在性隐匿判 404，
    // 先发一次注定失败的匿名请求只是白跑一个往返。没有登录态时仍然匿名试——公开分享
    // 不需要登录，不能因为没 token 就先弹登录。
    // [契约] 有登录态就第一次直接带上：private 分享的匿名请求必然被服务端按存在性
    // 隐匿判 404，先发匿名请求只是白跑一个往返。
    // 没有 token 时仍要匿名试：public 分享不需要登录，不能因为缺 token 就先弹登录。
    // 该值同时决定日志 stage 与失败后的分支走向。
    // [契约] 只在本次 load 内读取一次，避免请求过程中 token 变化导致分支与请求不一致。
    const initialToken = getAccessToken?.() ?? null;
    try {
      // [契约] token 以 undefined 表示匿名，不传 null：client 内部按 undefined 判定无凭据。
      // 成功后直接进入 ready，不再二次校验访问权限，权限已由服务端决定。
      // [并发] 该请求没有取消信号；组件卸载后 setState 由 React 忽略，
      // 但不要据此在卸载后继续链式请求。
      const preview = await client.getPreview(shareCode, initialToken ?? undefined);
      setState({ kind: "ready", preview });
    } catch (error) {
      // [契约] 只信任 client 归一后的 kind；结构不匹配时回退 network，
      // 避免把未知异常显示成「分享不存在」误导用户。
      // kind 是后续分支与日志的唯一判据，不要改用 message 文本匹配。
      const kind =
        error && typeof error === "object" && "kind" in error
          ? (error as ConversationSharePreviewClientError).kind
          : "network";
      const failure = error as Partial<ConversationSharePreviewClientError> | null;
      const diagnostics = {
        status: failure?.status,
        code: failure?.code,
        requestId: failure?.requestId,
      };
      logPreviewLoadFailure(initialToken ? "authenticated" : "anonymous", error, kind);
      // [失败路径] 匿名态下这两种错误一律转 login_required：服务端刻意隐匿
      // 无权限分享的存在性，前端不能断言「不存在」。
      // 带 token 仍失败说明本地登录态失效或确实无权限：直接进错误态，不再给登录循环。
      // authentication_required 时额外调用 onLogout 清理宿主里的坏 token。
      // 处理完必须 return，避免继续落到通用错误分支。
      // 该分支不传 diagnostics 到 login_required，因为登录页不展示请求详情。
      if (kind === "authentication_required" || kind === "not_found") {
        // 带过 token 还失败就没有第二次机会了：要么本地登录态已失效（让宿主清理并重新登录），
        // 要么服务端确实不认这个访问者。
        if (initialToken) {
          setState({ kind: "error", error: kind, ...diagnostics });
          if (kind === "authentication_required") onLogout?.();
          return;
        }
        // [契约] 匿名态遇到认证/未找到都进入登录态，页面据此同时展示两个 provider 入口；
        // 不携带 diagnostics，登录页不暴露服务端错误细节。
        // 登录成功后由宿主重新挂载 loader 触发新一轮 load。
        setState({ kind: "login_required" });
        return;
      }
      setState({ kind: "error", error: kind, ...diagnostics });
    }
  }, [client, getAccessToken, onLogout, shareCode]);
  useEffect(() => {
    void load();
  }, [load]);
  if (state.kind === "ready")
    return (
      <ConversationShareLandingPage
        shareCode={shareCode}
        preview={state.preview}
        locale={locale}
        theme={activeTheme}
        onThemeChange={handleThemeChange}
      />
    );
  return (
    <ConversationShareLandingStatus
      state={state}
      locale={locale}
      onLogin={onLogin}
      onRetry={() => void load()}
    />
  );
}
