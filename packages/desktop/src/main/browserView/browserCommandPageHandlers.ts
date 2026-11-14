// INV-01 所有导航 URL 必须先过 isAllowedBrowserUrl 白名单再交给 loadURL；守住位置：handleNavigate 入口；改错故障：模型被诱导加载 file:// 或内网地址，泄露本地文件。
// INV-02 navigate 必须只把 AbortError 继续上抛，其余错误一律转成 done 失败结果；守住位置：handleNavigate 的 catch 首行；改错故障：取消信号被吞成执行失败，上层自动重发导航。
// INV-03 ERR_ABORTED 只有在新 URL 等价且 document 到达 interactive/complete 时才升级为成功；守住位置：confirmAbortedNavigationCommitted；改错故障：已提交的导航被报成硬失败，模型重复猜 URL 与资源 ID。
// INV-04 中止补确认窗口上限 500ms、轮询 25ms，耗尽即返回 false；守住位置：ABORTED_NAVIGATION 两个常量与 while 循环；改错故障：页面卡死时命令悬挂，长时间占住执行队列。
// INV-05 每个 handle 函数在任意路径上恰好在一次 done 上返回；守住位置：全部 handle 的每个 return 分支；改错故障：结果通道悬挂或重复 resolve，IPC 调用方永久等待。
// INV-06 导航失败必须带 code 与 message，且 sideEffect 为 uncertain；守住位置：handleNavigate 的兜底错误分支；改错故障：调用方把可能已生效的导航当无副作用重试，产生重复提交。
// INV-07 超时映射 timeout，其余异常映射 execution_error，两种码不得互换；守住位置：handleNavigate 的 code 三元表达式；改错故障：模型无法区分可重试超时与真实失败，选错恢复策略。
// INV-08 截图三条路径互斥且优先级为 clip > fullPage > 视口兜底；守住位置：handleScreenshot 的 if/else if 链；改错故障：区域截图被全页覆盖，返回尺寸与请求不符。
// INV-09 所有截图 clip 一律使用 CSS px 且 scale 固定为 1；守住位置：buildViewportScreenshotParams 与 handleScreenshot；改错故障：Retina 下坐标系失配，截到空白或错位区域。
// INV-10 captureBeyondViewport 仅在带 clip 或 fullPage 时为真；守住位置：handleScreenshot 的参数构造；改错故障：普通视口截图触碰视口外合成面，触发 Electron 侧 V8 FATAL。
// INV-11 CSS 视口尺寸非有限数或非正数时解析结果为 null，调用方退回默认参数；守住位置：resolveScreenshotCssViewport；改错故障：clip 宽高为 NaN，CDP 拒绝请求或返回全黑图。
// INV-12 截图为空数据时必须转成 execution_error，绝不回传空 base64；守住位置：handleScreenshot 的两处空值判断；改错故障：调用方收到 0 字节图片，渲染层解码崩溃。
// INV-13 snapshot 原始结果必须经 browserSnapshotSchema 校验后才回传；守住位置：handleSnapshot 的 safeParse 分支；改错故障：畸形 ref 树透传下游，模型点击不存在的元素。
// INV-14 evaluate 必须只允许回传 JSON 可序列化的数据，序列化失败按 execution_error 处理；守住位置：EVALUATE_SCRIPT 与 handleEvaluate 的解析分支；改错故障：函数或 DOM 节点被序列化成空对象，模型误判页面状态。
// INV-15 evaluate 页面侧 JSON.parse 失败时退化为原始字符串，不抛错；守住位置：handleEvaluate 的 json 分支 try/catch；改错故障：合法文本结果被当异常丢弃，模型拿不到页面内容。
// INV-16 getState 的视口补充字段读取失败只降级，不影响整条命令成功；守住位置：handleGetState 的空 catch；改错故障：页面已销毁时连基础 URL 与 title 都拿不到。
// INV-17 所有 CDP 调用必须都走调用方注入的 ControlledView，文件内不缓存 webContents 引用；守住位置：各 handle 的入参与顶层纯函数；改错故障：重挂载后操作已销毁的 guest，命令随机失败。
// INV-18 本模块不持有内部可变状态，命令串行化完全由上层分发器保证；守住位置：模块顶层常量与无状态函数；改错故障：调用方误以为可并发进入，navigate 与 screenshot 交错产出错帧。
// INV-19 成功结果里的 state 必须在 done 之前从当前 webContents 即时读取；守住位置：handleNavigate 与 handleScreenshot 的成功分支；改错故障：返回过期 URL，模型据此点击错误页面的元素。
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import { browserSnapshotSchema } from "@zcode/shared";
import { EVALUATE_SCRIPT, SNAPSHOT_SCRIPT, VIEWPORT_SCRIPT } from "./browserCommandScripts.js";
import {
  DEFAULT_NAVIGATE_SETTLE_MS,
  BrowserNavigationTimeoutError,
  isAllowedBrowserUrl,
  readState,
  settleNavigation,
} from "./browserCommandState.js";
import type { ControlledView } from "./browserCommandTypes.js";
import type { BrowserCommandDone } from "./browserCommandResult.js";
import { executionError } from "./browserCommandResult.js";
import { captureScreenshotWithCssPixelCorrection } from "./browserScreenshotCapture.js";

// [资源] 这两个常量只约束 ERR_ABORTED 之后的补确认窗口，不参与导航本身的等待；改动它们不会改变正常导航的耗时。
// 500ms 上限的依据：www 到 m 的重定向与 SPA 路由接管通常在首帧后 100ms 内完成新 document 提交，超过 500ms 仍未提交应视为真实失败。
// [权衡] 不按 navigateSettleMs 等比放大：确认成功所需的证据在首个轮询周期内就已出现，放大只会让真实失败更晚返回给模型。
// 25ms 轮询在 500ms 内最多复核 20 次，既能覆盖 document 切换期的短暂不可读窗口，又不会让 executeJavaScript 占满 renderer 主线程。
// [失败路径] 窗口耗尽一律返回 false，由 handleNavigate 走原有错误映射，绝不在超时后勉强认定导航成功。
// 每轮循环都重新检查 signal.aborted，保证取消最多延迟一个轮询周期生效，用户点停止后不必等满 500ms。
// [并发] 循环内不持有跨 await 的可变状态，只读常量与入参，因此多条命令同时进入补确认也不会互相污染。
// 若把超时改成 0 或负数，循环会退化为单次尝试甚至死循环；保持正数是有界性的前提。
const ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS = 500;
const ABORTED_NAVIGATION_POLL_INTERVAL_MS = 25;

interface ScreenshotViewportMetrics {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

interface ScreenshotContentMetrics {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ScreenshotLayoutMetrics {
  layoutViewport?: ScreenshotViewportMetrics;
  visualViewport?: ScreenshotViewportMetrics;
  contentSize?: ScreenshotContentMetrics;
  cssLayoutViewport?: ScreenshotViewportMetrics;
  cssVisualViewport?: ScreenshotViewportMetrics;
  cssContentSize?: ScreenshotContentMetrics;
}

interface ScreenshotCssViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readScreenshotLayoutMetrics(view: ControlledView): Promise<ScreenshotLayoutMetrics> {
  return (await view.cdp.send("Page.getLayoutMetrics")) as ScreenshotLayoutMetrics;
}

function resolveScreenshotCssViewport(
  metrics: ScreenshotLayoutMetrics,
): ScreenshotCssViewport | null {
  // [权衡] 优先 cssVisualViewport 而非 cssLayoutViewport：页面缩放或移动端模拟时 visual 才是用户真正看到的区域，用 layout 会把缩放外的内容一并裁进来。
  // clientWidth 与 clientHeight 都必须是有限正数；任一缺失即整块判空，因为只按宽度算出的 clip 会在另一轴溢出或截断。
  // [失败路径] 解析失败返回 null 而不是抛错：调用方据此退回无 clip 的默认参数，截图仍能返回整视口图，不因布局指标异常而整条失败。
  // pageX 与 pageY 缺失时必须回落 0，对应多数 guest 的初始滚动位置；这里只做类型收窄，不做取整与 dpr 换算。
  // [权衡] 不在此处乘除 devicePixelRatio：CDP 的 clip 以 CSS px 计价，混入 dpr 会让同一调用在 Retina 与普通屏产出不同尺寸。
  // 只读取三个字段，刻意不读 contentSize，避免视口截图与全页截图的坐标来源混用。
  // 返回对象只包含四个数值，调用方展开后自行补 scale: 1，省掉一次重复校验。
  // 该函数不缓存结果，保证每次截图都反映当前视口（页面可能刚被 resize 或滚动）。
  const cssViewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  const cssWidth = cssViewport?.clientWidth;
  const cssHeight = cssViewport?.clientHeight;
  if (
    typeof cssWidth !== "number" ||
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    typeof cssHeight !== "number" ||
    !Number.isFinite(cssHeight) ||
    cssHeight <= 0
  ) {
    return null;
  }
  return {
    x: typeof cssViewport?.pageX === "number" ? cssViewport.pageX : 0,
    y: typeof cssViewport?.pageY === "number" ? cssViewport.pageY : 0,
    width: cssWidth,
    height: cssHeight,
  };
}

export async function buildViewportScreenshotParams(
  view: ControlledView,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    format: "png",
    captureBeyondViewport: false,
  };
  if (!view.normalizeScreenshotToCssPixels) return params;
  const cssViewport = resolveScreenshotCssViewport(await readScreenshotLayoutMetrics(view));
  if (!cssViewport) return params;
  // legacy layout metrics 在 Retina guest 中可以是 CSS viewport 的 2 倍，
  // 但 capture raster 已经是 CSS 1x。首帧预先套用 0.5 会产生 640×360，并可能让重挂载的
  // guest compositor 停留在左上角。首帧固定使用 CSS 1x，实际 PNG 异常再由共用执行器校正。
  params.clip = { ...cssViewport, scale: 1 };
  return params;
}

// [失败路径] 同一个中止原因在不同层以不同形态出现：新版 Error 带 code ERR_ABORTED，net 层给 errno -3，跨进程包装后只剩 message。三处必须都认。
// 入参不是对象时直接判否，避免在错误不是 Error 实例时因属性访问抛出二次异常。
// message 分支用词边界加 -3 两个条件，防止把 ERR_ABORTED_EXTRA 之类的其它码误判成中止。
// [权衡] 这里必须只做识别，不判断导航是否真的成功；识别与确认必须分成两步，才能在补确认失败时干净地退回原错误。
// 该函数不能读 URL、不能碰 webContents，纯判定，所以可以在 catch 分支内无条件调用。
// 若把 errno 判断写成真值比较，errno 为 0 会被当成命中，所有普通网络错误都会被误认为可确认的中止。
// 返回布尔而不是错误对象：调用方只关心是否进入补确认，不关心原始错误的载荷。
// 不匹配时返回 false，错误会沿原有路径映射成 timeout 或 execution_error，不会被静默吞掉。
function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "ERR_ABORTED" ||
    candidate.errno === -3 ||
    (typeof candidate.message === "string" && /\bERR_ABORTED\b|\(-3\)/u.test(candidate.message))
  );
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:m|www)\./u, "");
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
}

// [权衡] 主机名先去掉 m 与 www 前缀再比较：站点从 www 跳到 m 时新 document 已提交，按全等判定会把成功导航当失败。
// 路径必须只裁掉尾部斜杠，不能做大小写折叠与百分号解码，避免把两个真实不同的资源误判为同一页。
// about: 协议没有 host 与 path 语义，退化成 href 全等，防止把 about:blank 与任意页面认成等价。
// 端口与 query 必须完全一致；query 不同很可能就是另一个页面，误判成功会让模型基于错误 URL 推理。
// [失败路径] 任一 URL 解析失败返回 false，宁可不确认也不误确认。
// 该判定只服务于 ERR_ABORTED 补确认，不能当导航白名单使用：它主动认可 m 域名改写。
// 忽略 hash 是刻意的：SPA 只改 hash 时 document 不重新加载，location.href 的差异不应否决确认。
function isEquivalentNavigationUrl(requestedUrl: string, currentUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const current = new URL(currentUrl);
    if (requested.protocol === "about:" || current.protocol === "about:") {
      return requested.href === current.href;
    }
    return (
      requested.protocol === current.protocol &&
      normalizedHost(requested.hostname) === normalizedHost(current.hostname) &&
      requested.port === current.port &&
      normalizedPath(requested.pathname) === normalizedPath(current.pathname) &&
      requested.search === current.search
    );
  } catch {
    return false;
  }
}

async function confirmAbortedNavigationCommitted(
  view: ControlledView,
  requestedUrl: string,
  previousUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // [资源] 循环有界：deadline 在进入时就固定，不会被内部 await 推后，因此最多阻塞一个确认窗口。
  // [失败路径] 已中止就直接抛 AbortError，让取消语义穿过本函数，而不是降级成一次普通的确认失败。
  // 同时读页面侧 href 与主进程侧 getURL，只有两者一致才排除 about:blank 等中间 document。
  // readyState 只接受 interactive 与 complete：loading 阶段的 document 仍可能被替换，此时确认成功会指向旧页面。
  // [并发] guest 切换 document 时 executeJavaScript 可能 reject 或返回 null，catch 留空是刻意的，下一轮重新复核。
  // 请求 URL 与当前 URL 必须等价，否则说明这是站点自己的跳转，不能算本次导航已提交。
  // 每轮结束固定等待一个轮询间隔，不因失败立即重试，避免 renderer 在 document 切换期被高频求值拖慢。
  // 返回 false 时调用方按原始错误处理，本函数从不自行构造成功结果。
  const deadline = Date.now() + ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const documentState = (await view.webContents.executeJavaScript(`(() => ({
        href: globalThis.location?.href ?? "",
        readyState: document.readyState
      }))()`)) as { href?: unknown; readyState?: unknown } | null;
      const currentUrl = view.webContents.getURL();
      const href = typeof documentState?.href === "string" ? documentState.href : "";
      const readyState = documentState?.readyState;
      if (
        currentUrl !== previousUrl &&
        href === currentUrl &&
        (readyState === "interactive" || readyState === "complete") &&
        isEquivalentNavigationUrl(requestedUrl, currentUrl)
      ) {
        return true;
      }
    } catch {
      // guest 正在切换 document 时 executeJavaScript 可能短暂失败；在有界窗口内继续复核。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ABORTED_NAVIGATION_POLL_INTERVAL_MS));
  }
  return false;
}

export async function handleNavigate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "navigate" }>,
  done: BrowserCommandDone,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal },
): Promise<BrowserCommandResult> {
  // [失败路径] 白名单判定必须先于 loadURL，被拒时没有任何副作用，所以错误对象可以安全地不带 sideEffect。
  // 错误码用 navigation_blocked 而非 execution_error：模型据此知道是策略拒绝，不该换个说法重试同一 URL。
  // message 原样回显被拒 URL，便于模型自行纠正协议或主机，而不是反复猜测。
  // [权衡] 不做 URL 规范化后再判定：规范化会掩盖 file: 与 javascript: 之类的伪装写法，白名单必须看原始入参。
  // 该分支在读取 previousUrl 之前返回，避免对可能已销毁的 webContents 取 URL。
  // done 在此只调用一次，后续成功与失败分支互斥，保证结果通道恰好收到一个终态。
  // 被拒是确定的无副作用结果，所以省略 sideEffect 字段，与导航失败的 uncertain 形成明确区分。
  // [并发] 从校验到 loadURL 之间没有 await，同一 tick 内不会被其它命令插入改写目标 URL。
  if (!isAllowedBrowserUrl(command.url)) {
    return done({
      ok: false,
      error: { code: "navigation_blocked", message: `Blocked URL: ${command.url}` },
    });
  }
  const previousUrl = view.webContents.getURL();
  try {
    await settleNavigation(
      view.webContents.loadURL(command.url),
      opts?.navigateSettleMs ?? DEFAULT_NAVIGATE_SETTLE_MS,
      opts?.signal,
    );
  } catch (error) {
    // [失败路径] 取消必须与失败分开：settleNavigation 在 signal 中止时抛 AbortError，这里是唯一继续上抛的位置。
    // [权衡] 此分支不调用 done：取消意味着调用方已不关心结果，再写终态会与上层取消处理竞争同一个结果通道。
    // [并发] 抛出后不再触碰 webContents，已发起的导航可能仍在进行，后续状态由下一条命令重新读取。
    // 判断用 name 而非 instanceof，跨进程边界还原出来的错误对象可能丢失原型链。
    // 若改成 done 失败结果，上层会把用户主动取消当成可重试失败并自动重发导航。
    // 非 AbortError 才进入下面的中止补确认与错误映射，两条路径不重叠。
    // loadURL 此时已经发出，取消本身不会撤回已发生的请求，这属于可接受的副作用。
    // 保持 throw 而不是返回 rejected promise，保证调用栈中的 finally 清理仍然执行。
    if (error instanceof Error && error.name === "AbortError") throw error;
    // 站点的 www→m 重定向或 SPA 路由接管会让 Electron loadURL 以
    // ERR_ABORTED reject，但新 document 已经提交。只在 URL 等价且 document ready 时认定成功；
    // 不能把已成功导航的页面回报成硬失败，诱导模型继续猜 URL/资源 ID。
    if (
      isElectronNavigationAborted(error) &&
      (await confirmAbortedNavigationCommitted(view, command.url, previousUrl, opts?.signal))
    ) {
      return done({ ok: true, state: readState(view.webContents) });
    }
    return done({
      ok: false,
      error: {
        code: error instanceof BrowserNavigationTimeoutError ? "timeout" : "execution_error",
        message: error instanceof Error ? error.message : String(error),
        sideEffect: "uncertain",
      },
    });
  }
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleGetState(
  view: ControlledView,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  const state = readState(view.webContents);
  // 补 scrollX/scrollY/viewportWidth/viewportHeight（读取失败不致命，返回基础 state）。
  try {
    const raw = (await view.webContents.executeJavaScript(VIEWPORT_SCRIPT)) as {
      scrollX?: unknown;
      scrollY?: unknown;
      innerWidth?: unknown;
      innerHeight?: unknown;
    } | null;
    if (raw && typeof raw === "object") {
      if (typeof raw.scrollX === "number") state.scrollX = raw.scrollX;
      if (typeof raw.scrollY === "number") state.scrollY = raw.scrollY;
      if (typeof raw.innerWidth === "number") state.viewportWidth = raw.innerWidth;
      if (typeof raw.innerHeight === "number") state.viewportHeight = raw.innerHeight;
    }
  } catch {
    /* 读取视口信息失败时保留基础 state。 */
  }
  return done({ ok: true, state });
}

export async function handleScreenshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "screenshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  if (command.clip === undefined && command.fullPage !== true && view.captureViewportScreenshot) {
    const data = await view.captureViewportScreenshot();
    if (!data) {
      return done({
        ok: false,
        error: { code: "execution_error", message: "screenshot returned empty data" },
      });
    }
    return done({
      ok: true,
      image: { base64: data, mimeType: "image/png" },
      state: readState(view.webContents),
    });
  }

  // 走 CDP Page.captureScreenshot（规避 renderer webContents.capturePage 的 V8 FATAL，且拿全页）。
  const metrics =
    command.fullPage === true || view.normalizeScreenshotToCssPixels
      ? await readScreenshotLayoutMetrics(view)
      : null;
  const cssViewport =
    view.normalizeScreenshotToCssPixels && metrics ? resolveScreenshotCssViewport(metrics) : null;
  const params: Record<string, unknown> = {
    format: "png",
    // 普通 viewport 截图不应走 viewport 外的 compositor surface；clip/fullPage 才显式允许。
    captureBeyondViewport: command.clip !== undefined || command.fullPage === true,
  };
  if (command.clip) {
    // 区域截图：clip 用视口 CSS px，scale:1 保证与坐标同系。
    params.clip = {
      x: command.clip.x,
      y: command.clip.y,
      width: command.clip.width,
      height: command.clip.height,
      scale: 1,
    };
  } else if (command.fullPage === true) {
    // 全页截图：取 contentSize（优先 CSS 尺寸），用 clip 覆盖整页。
    const cs = metrics?.cssContentSize ?? metrics?.contentSize;
    if (cs && typeof cs.width === "number" && typeof cs.height === "number") {
      params.clip = {
        x: typeof cs.x === "number" ? cs.x : 0,
        y: typeof cs.y === "number" ? cs.y : 0,
        width: cs.width,
        height: cs.height,
        scale: 1,
      };
    }
  } else if (cssViewport) {
    params.clip = { ...cssViewport, scale: 1 };
  }

  const res = await captureScreenshotWithCssPixelCorrection(view, params);
  if (!res?.data) {
    return done({
      ok: false,
      error: { code: "execution_error", message: "screenshot returned empty data" },
    });
  }
  return done({
    ok: true,
    image: { base64: res.data, mimeType: "image/png" },
    state: readState(view.webContents),
  });
}

export async function handleSnapshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "snapshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 注入脚本遍历可见 DOM，产出带 ref 的结构化快照（严格对齐 browserSnapshotSchema）。
  const raw = await view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT(command.maxElements, command.includeHidden),
  );
  // 防御式校验：脚本受控但异形页面可能覆写 getter/返回残缺结构。safeParse 失败时
  // 转成明确的 execution_error（而非把畸形对象透传到下游让 strict zod 报笼统失败）。
  const parsed = browserSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return done({
      ok: false,
      error: {
        code: "execution_error",
        message: `invalid snapshot result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      },
    });
  }
  return done({ ok: true, snapshot: parsed.data });
}

export async function handleEvaluate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "evaluate" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 执行页面表达式并 JSON 安全序列化；异常 → execution_error。
  const raw = (await view.webContents.executeJavaScript(EVALUATE_SCRIPT(command.expression))) as {
    ok?: boolean;
    kind?: string;
    data?: string;
    message?: string;
  } | null;
  if (!raw || typeof raw !== "object")
    return done(executionError("evaluate returned invalid result"));
  // [失败路径] 页面侧必须用 try/catch 包住求值，异常以 ok:false 与 message 回传，主进程必须只做错误码归一。
  // message 缺失时给固定文案，避免把 undefined 塞进错误结构破坏下游 schema。
  // 统一映射成 execution_error，不暴露页面侧堆栈：堆栈是页面实现细节，模型无法据此恢复。
  // [权衡] 不复用 executeJavaScript 的 reject 通道：CDP 会把页面异常与序列化异常混在同一个错误里，无法区分。
  // 与上面的非对象分支必须同构，两个校验通向同一个错误码，调用方只需处理一种失败形态。
  // 该分支在解析 data 之前返回，保证畸形结果不会被 JSON.parse 二次抛错。
  // 表达式可能已产生页面副作用，但这里不带 sideEffect: uncertain，副作用由调用方按业务语义承担。
  // done 只在此处调用一次，成功路径在函数末尾返回，两者互斥。
  if (raw.ok === false) return done(executionError(raw.message ?? "evaluate error"));

  let value: unknown;
  if (raw.kind === "json" && typeof raw.data === "string") {
    try {
      value = JSON.parse(raw.data);
    } catch {
      // 理论不达（页面侧已 JSON.stringify 成功）；兜底透传原字符串。
      value = raw.data;
    }
  } else {
    value = raw.data;
  }
  return done({ ok: true, value });
}
