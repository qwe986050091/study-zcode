/* eslint-disable max-lines, @typescript-eslint/no-explicit-any -- 该函数会序列化后在隔离的浏览器页面上下文执行，不能引用 host 闭包。 */
// Playwright 动作执行器：把 BrowserPlaywrightAction 分发到隔离世界运行时、CDP 求值与 locator 执行器。
// handlePlaywrightAction 只做单次动作的分发、轮询与结果封装；不持有页面状态，不实现重试策略，也不做能力协商与超时策略本身。
// 不负责：截图参数换算、DOM 快照构建、locator 语义解析与超时归一化，这些由同目录专用模块承担。
//
// 不变量清单（每条都对应一处看似可改、实则不能动的边界）：
// INV-01 断言：所有经 CDP 返回的值必须可结构化克隆，运行时函数禁止返回 DOM 节点、函数或含循环引用的对象 —— 守住它的位置：elementInfoRuntime 的 map 结果与 Runtime.evaluate 的 returnByValue —— 改错故障：序列化抛错，elementInfo 整条动作变成 evaluate failed，AI 失去元素探测能力
// INV-02 断言：页面探测必须只运行在 zcode-playwright-helper 隔离世界，不得退回主世界执行 —— 守住它的位置：evaluateInPlaywrightIsolatedWorld 的 Page.createIsolatedWorld —— 改错故障：页面覆写 document 或 CSS 后 elementInfo 结果失真，AI 依据错误 selector 操作
// INV-03 断言：注入页面的运行时函数不得引用模块作用域变量，只能依赖参数与页面全局 —— 守住它的位置：serializeRuntimeCall 的 toString 拼接 —— 改错故障：运行时抛 ReferenceError，且错误信息指向被序列化的字符串，极难定位
// INV-04 断言：overlay 元素必须在 finally 中按同一 id 移除，成功与失败路径都要清 —— 守住它的位置：elementScreenshot 分支的 finally 与 overlayRuntime 的 remove 参数 —— 改错故障：红色选框残留在页面上，后续截图与用户视野都被污染
// INV-05 断言：overlay 根节点必须是 pointer-events:none 且固定最高层级，不能拦截页面事件 —— 守住它的位置：overlayRuntime 的 cssText —— 改错故障：截图后页面点击全部失效，用户以为浏览器卡死
// INV-06 断言：poll 的截止时间只在进入时计算一次，跨阶段必须复用同一 deadline 的剩余量 —— 守住它的位置：poll 的 deadline 与 waitForURL 的 Math.max(1, timeoutMs - 已耗时) —— 改错故障：URL 匹配与 load 状态各拿一份完整超时，总耗时翻倍，上层超时判定失效
// INV-07 断言：轮询间隔取剩余时间与 50ms 的较小值，不能固定等待 50ms —— 守住它的位置：poll 内 setTimeout 的 Math.min —— 改错故障：临近截止时仍多睡一轮，短超时动作系统性偏慢并偶发误报超时
// INV-08 断言：signal 一旦中止立即返回 cancelled，不再执行谓词 —— 守住它的位置：poll 循环首行与 evaluateWithCdp 的入口检查 —— 改错故障：用户已取消的动作继续驱动页面，取消语义被无声吞掉
// INV-09 断言：取消结果必须携带 sideEffect=none，不能与超时或失败混用 —— 守住它的位置：各分支的 cancelled 返回对象 —— 改错故障：上层误判页面已被改动而放弃重试或错误回滚
// INV-10 断言：networkidle 必须显式抛错，不得静默降级成 load —— 守住它的位置：waitForDocumentState 的首个分支 —— 改错故障：AI 以为等到了网络空闲，实际只等到 load，随后读到半加载数据
// INV-11 断言：无通配符的 URL 模式走严格相等，不能退化成前缀或包含匹配 —— 守住它的位置：urlMatches 的首个分支 —— 改错故障：等待 /a 时在 /a/b 上提前返回，后续动作打到错误页面
// INV-12 断言：通配符转正则前必须先转义全部正则元字符 —— 守住它的位置：urlMatches 的两次 replace —— 改错故障：带问号或方括号的 URL 被当成非法正则，抛 SyntaxError
// INV-13 断言：evaluate 的函数式与表达式式包装互不等价，函数式直接以 arg 调用、表达式式注入同名局部变量 —— 守住它的位置：handlePlaywrightAction 中 expressionKind 的三元分支 —— 改错故障：表达式里的 arg 变成未定义，脚本静默返回错误结果
// INV-14 断言：abort 时必须向页面发送 Runtime.terminateExecution 终止在途脚本 —— 守住它的位置：evaluateWithCdp 的 terminate 监听与 finally 移除 —— 改错故障：死循环脚本占满页面主线程，后续所有动作超时
// INV-15 断言：domSnapshot 必须委托 captureBrowserDomSnapshot，不能退回 clone documentElement —— 守住它的位置：domSnapshot 分支的既有 Bugfix 注释 —— 改错故障：返回高噪声 outerHTML，AI 拿不到 ARIA 语义结构
// INV-16 断言：locator 超时文案必须保留「不要重试同一 locator」的指引 —— 守住它的位置：locatorTimeoutResult 的 message 拼接 —— 改错故障：AI 反复重试同一选择器，形成死循环并耗尽预算
// INV-17 断言：无法识别的动作只能返回 capability_unsupported 交给 IAB manager，不得静默成功 —— 守住它的位置：handlePlaywrightAction 末尾的兜底返回 —— 改错故障：能力缺失被伪装成成功，AI 依据空结果继续下一步
//
// 分发顺序即协议：domSnapshot → elementInfo → elementScreenshot → evaluate → waitForURL → waitForLoadState → locator。
// 顺序不能调换，elementScreenshot 与 evaluate 都会改变页面，提前到只读动作之前会让 AI 拿到已变形的快照。
// 每个分支都必须恰好多调用一次 done(...)，重复调用会让上层重复记账，漏调用会让调用方永久等待。
//
// 返回契约：成功走 done({ ok: true })；超时统一 code=timeout；取消统一 code=cancelled 且 sideEffect=none。
// 未知动作返回 capability_unsupported，文案固定为交给 IAB manager 处理，不得改写成成功或通用错误。
//
// 改动本文件前先确认：新增动作是否也要在 IAB manager 侧登记，否则只在桌面端可用，Web 端会行为分叉。
// 任何跨阶段的时间预算都要从同一 startedAt 扣减，不能让每个阶段各自拿完整 timeout。
// 页面注入的运行时函数会先 toString 再序列化，写这些函数时不能引用模块作用域里的任何变量。
import type { BrowserCommandResult, BrowserPlaywrightAction } from "@zcode/shared";
import { buildViewportScreenshotParams } from "./browserCommandPageHandlers.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { captureScreenshotWithCssPixelCorrection } from "./browserScreenshotCapture.js";
import { captureBrowserDomSnapshot } from "./browserPlaywrightDomSnapshot.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";

type Done = (partial: Omit<BrowserCommandResult, "elapsedMs">) => BrowserCommandResult;

// [权衡] 50ms 是探测精度与 CDP 往返开销的折中：调小会让等待动作打满主线程，调大则让已满足的条件多等一轮。
// 这个常量只能约束单次等待的上限，真正的截止判断在 poll 的 deadline 里，不要把它当成超时时间用。
const POLL_INTERVAL_MS = 50;

// [契约] 这里的函数体会被 toString 后送进页面执行，任何模块作用域引用在运行时都会变成未定义标识符。
// 参数逐个 JSON.stringify，因此只能传可序列化的普通数据；传 undefined 或函数会被静默丢弃成 undefined 实参。
// 新增运行时函数时，请把它写成完全自包含的纯函数，页面全局（document、CSS、globalThis）是唯一可用依赖。
function serializeRuntimeCall(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
}

// [契约] 该函数在隔离世界同步执行，不能使用 await、不能读外部变量，返回值必须是纯数据。
// elementsFromPoint 的顺序就是视觉层级顺序，candidates 依赖它推导主 selector，不要为了去重而重排。
// includeNonInteractable 只影响过滤，不影响返回结构；改变返回字段名会让上层解析与 AI 提示词同时失效。
function elementInfoRuntime(options: { x: number; y: number; includeNonInteractable?: boolean }) {
  const cssEscape = (value: string) =>
    globalThis.CSS?.escape?.(value) ?? value.replace(/[^\w-]/g, "\\$&");
  const candidatesFor = (element: Element) => {
    const values: string[] = [];
    if (element.id) values.push(`#${cssEscape(element.id)}`);
    const testId = element.getAttribute("data-testid");
    if (testId) values.push(`[data-testid=${JSON.stringify(testId)}]`);
    const aria = element.getAttribute("aria-label");
    if (aria) values.push(`[aria-label=${JSON.stringify(aria)}]`);
    values.push(element.tagName.toLowerCase());
    return [...new Set(values)];
  };
  const role = (element: Element) =>
    element.getAttribute("role") ??
    (element.matches("button,input[type=button],input[type=submit]")
      ? "button"
      : element.matches("a[href]")
        ? "link"
        : element.matches("input:not([type]),input[type=text],textarea")
          ? "textbox"
          : null);
  const interactable = (element: Element) =>
    Boolean(role(element) || element.matches("input,select,textarea,[tabindex],[contenteditable]"));
  return document
    .elementsFromPoint(options.x, options.y)
    .filter((element) => options.includeNonInteractable || interactable(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const candidates = candidatesFor(element);
      const visibleText =
        (element as HTMLElement).innerText?.trim() || (element as HTMLInputElement).value || null;
      const ariaName = element.getAttribute("aria-label") || visibleText;
      return {
        tagName: element.tagName.toLowerCase(),
        role: role(element),
        visibleText,
        ariaName,
        testId: element.getAttribute("data-testid"),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        preview: element.outerHTML.slice(0, 300),
        selector: { primary: candidates[0] ?? null, candidates },
      };
    });
}

// [资源] 同一个 id 先删后建，保证重复调用幂等；remove 为真时只清理不绘制，供 finally 复用。
// 叠加框按 elementsFromPoint 逐层绘制，少画或多画一层都会让截图里的选框与实际命中元素错位。
// 根节点用 inset:0 覆盖全屏但禁用指针事件，不要改成绝对定位，否则滚动后选框位置漂移。
function overlayRuntime(options: { x: number; y: number; remove?: boolean }): void {
  const id = "__zcode-playwright-element-screenshot-overlay";
  document.getElementById(id)?.remove();
  if (options.remove) return;
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  for (const element of document.elementsFromPoint(options.x, options.y)) {
    const rect = element.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff2d55;box-sizing:border-box`;
    root.append(box);
  }
  const point = document.createElement("div");
  point.style.cssText = `position:absolute;left:${options.x - 4}px;top:${options.y - 4}px;width:8px;height:8px;border-radius:50%;background:#ff2d55`;
  root.append(point);
  document.documentElement.append(root);
}

// [契约] 世界名固定为 zcode-playwright-helper：换名字等于换上下文，同一页面会出现两套互不可见的运行时。
// grantUniveralAccess 保持 false，禁用跨源访问是为了让探测行为与真实页面脚本一致，不要为省事打开。
// frameId 取主 frame；缺失时直接抛错，不要退化成取第一个 frame 或传 0，那会把探测定到 iframe 里。
// exceptionDetails 必须转成 Error 抛出，吞掉它会让上层拿到 undefined 并当成探测成功。
async function evaluateInPlaywrightIsolatedWorld(
  view: ControlledView,
  expression: string,
): Promise<unknown> {
  const tree = (await view.cdp.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error("Playwright isolated world requires a main frame id");
  const world = (await view.cdp.send("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "zcode-playwright-helper",
  })) as { executionContextId?: number };
  if (typeof world.executionContextId !== "number") {
    throw new Error("Playwright isolated world was not created");
  }
  const result = (await view.cdp.send("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Playwright isolated-world evaluation failed",
    );
  }
  return result.result?.value;
}

// [并发] 谓词是异步的，每轮只允许一个在途调用；这里串行 await，不会出现两次谓词重叠执行。
// deadline 在进入时算一次，循环内只做减法；把它挪进循环会让超时永远不触发。
// 取消优先于匹配：先查 signal 再执行谓词，返回顺序固定为 cancelled、matched、timeout。
// 等待必须用 Math.min(POLL_INTERVAL_MS, remaining)，接近截止时自然收敛到剩余毫秒，避免多睡一整轮。
async function poll(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    if (await predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }
}

// 超时统一走这里，保证 code 与文案格式一致；上层按 code 判定，不要在某处写自定义超时错误。
// message 里只拼描述，不能拼已耗时等动态值，避免快照测试与提示词抖动。
function timeoutResult(done: Done, description: string): BrowserCommandResult {
  return done({
    ok: false,
    error: { code: "timeout", message: `Timeout waiting for ${description}` },
  });
}

// [契约] 这段文案是给模型看的操作指引，不是给人看的日志；删掉后半句会直接催生重试死循环。
// 因此不要把它合并进 timeoutResult，两者的 message 语义不同，合并会丢掉 locator 专属的恢复步骤。
function locatorTimeoutResult(done: Done, description: string): BrowserCommandResult {
  return done({
    ok: false,
    error: {
      code: "timeout",
      message:
        `Timeout waiting for ${description}. ` +
        "Do not retry the same locator. Take a fresh domSnapshot(), rebuild from snapshot-proven facts, " +
        "and check count()/isVisible() before the next action.",
    },
  });
}

// 无通配符时用严格相等，这是唯一不会把 /a 误判成 /a/b 的判定方式，不要改成 includes 或 startsWith。
// 转义顺序不能反：先把正则元字符整体转义，再把星号换成点星，否则星号会被前一步吃掉。
// urlMatches 的模式两端锚定，避免子串命中；但星号按需展开，所以 * 在这里等价于任意字符序列而非路径段。
function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes("*")) return url === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

// [失败路径] networkidle 不受支持，必须显式抛错；这是协议层的能力缺口，不能在本层兜底成 load。
// domcontentloaded 判 readyState 不等于 loading，load 判 complete，两个条件不要互换，否则会过早返回。
// 超时预算由调用方传入，这里不再归一化，重复归一化会让嵌套调用的超时被二次放大。
async function waitForDocumentState(
  view: ControlledView,
  state: "load" | "domcontentloaded" | "networkidle",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  if (state === "networkidle") {
    throw new Error("playwright_wait_for_load_state does not support networkidle");
  }
  return poll(
    async () => {
      const pageState = (await view.webContents.executeJavaScript(`(() => ({
        readyState: document.readyState,
        resourceCount: 0
      }))()`)) as { readyState?: string; resourceCount?: number };
      const ready =
        state === "domcontentloaded"
          ? pageState.readyState !== "loading"
          : pageState.readyState === "complete";
      return ready;
    },
    timeoutMs,
    signal,
  );
}

// [资源] abort 监听必须在 finally 中移除，否则同一次请求累积监听器，取消时重复终止执行。
// terminate 用 catch 吞掉失败是刻意的：页面可能已销毁，此时终止命令失败不应掩盖原始错误。
// [并发] Runtime.evaluate 自带 timeout，但它只管 CDP 侧；真正的取消仍要靠 signal 触发 terminateExecution。
// returnByValue 固定为 true，页面里的对象会被结构化克隆回来，返回 Promise 时由 awaitPromise 展开。
async function evaluateWithCdp(
  view: ControlledView,
  expression: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const terminate = () => {
    void view.cdp.send("Runtime.terminateExecution").catch(() => undefined);
  };
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const raw = (await view.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (raw.exceptionDetails) {
      throw new Error(
        `playwright.evaluate failed: ${
          raw.exceptionDetails.exception?.description ??
          raw.exceptionDetails.text ??
          "Playwright evaluate failed"
        }`,
      );
    }
    return raw.result?.value;
  } finally {
    signal?.removeEventListener("abort", terminate);
  }
}

// [契约] 这是唯一的分发入口，每个分支都必须以 done 收尾；新增动作要同时考虑 IAB manager 侧的实现。
// 只读动作（domSnapshot、elementInfo）必须排在会改动页面的动作之前，顺序变化会改变 AI 看到的页面。
// 所有超时都必须经过 normalizePlaywrightTimeout，不要直接用 action.timeoutMs，缺省值语义只在该函数里定义。
// [事务] 单个动作要么成功要么给出明确失败码，禁止先返回成功再异步补错，上层不会等待第二次结果。
export async function handlePlaywrightAction(
  view: ControlledView,
  action: BrowserPlaywrightAction,
  done: Done,
  signal?: AbortSignal,
): Promise<BrowserCommandResult> {
  // 快照走专用实现，包含 iframe 展开与 ARIA 后处理；在此处二次加工会与既有后处理叠加导致结构重复。
  // signal 一路透传，取消时快照内部自行中断，本层不要再包一层超时。
  if (action.name === "domSnapshot") {
    // Bugfix：此前这里只 clone documentElement，返回的是高噪声 outerHTML，不是
    // Playwright AI/ARIA snapshot。统一走 isolated-world runtime + iframe 展开和相同后处理。
    const value = await captureBrowserDomSnapshot(view, signal);
    return done({ ok: true, value });
  }
  if (action.name === "elementInfo") {
    // 参数必须直接透传 action，字段名与 schema 一一对应，中间不能做重命名映射。
    // 返回值原样交给 done，不在主进程做裁剪或排序，前端与模型看到的字段顺序应保持一致。
    // DOM 探测必须在 isolated world 执行，避免页面覆写全局对象或 getter 改变结果。
    const value = await evaluateInPlaywrightIsolatedWorld(
      view,
      serializeRuntimeCall(elementInfoRuntime, action),
    );
    return done({ ok: true, value });
  }
  // [资源] 绘制与清理成对出现，清理在 finally 里执行，即使截图抛错也必须把选框摘掉。
  // 截图参数经 buildViewportScreenshotParams 与 CSS 像素校正，不要在该分支里自行拼截图参数。
  if (action.name === "elementScreenshot") {
    // 这里传的是整个 action，运行时只读取 x、y，多余字段会被忽略；不要为此构造新对象，会破坏序列化一致性。
    // 绘制失败意味着隔离世界不可用，此时不应继续截图，异常向上抛出即可。
    await evaluateInPlaywrightIsolatedWorld(view, serializeRuntimeCall(overlayRuntime, action));
    try {
      const raw = await captureScreenshotWithCssPixelCorrection(
        view,
        await buildViewportScreenshotParams(view),
      );
      if (!raw.data) throw new Error("CDP Page.captureScreenshot returned no data");
      return done({ ok: true, image: { base64: raw.data, mimeType: "image/png" } });
    } finally {
      await evaluateInPlaywrightIsolatedWorld(
        view,
        serializeRuntimeCall(overlayRuntime, { x: action.x, y: action.y, remove: true }),
      );
    }
  }
  // 函数式直接调用用户函数并传入 arg；表达式式把 arg 注入成同名局部变量，两种包装的 this 绑定不同。
  // 表达式被包在立即执行函数里，因此不能写顶层 return 之外的语句序列，也不能依赖页面全局的 this。
  // timeoutMs 在此归一化后同时作为 CDP 超时与取消预算，两处不一致会让取消晚于超时生效。
  if (action.name === "evaluate") {
    const arg = JSON.stringify(action.arg);
    // 拼接结果是纯字符串，任何动态内容都来自 JSON.stringify，不要用模板直接插入原始表达式，否则会被注入。
    // 函数式分支的 arg 只有一个，多参数能力不在此处，扩展前先确认协议字段是否已定义。
    // 表达式式分支里的 arg 变量名与用户代码可能冲突，这是已知取舍，改名会破坏依赖该名字的既有脚本。
    // 两种分支都必须返回可序列化值，返回 DOM 时会在 returnByValue 阶段抛错。
    const expression =
      action.expressionKind === "function"
        ? `(${action.expression})(${arg})`
        : `(() => { const arg = ${arg}; return (${action.expression}); })()`;
    const value = await evaluateWithCdp(
      view,
      expression,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    return done({ ok: true, value });
  }
  // [并发] 先用轮询等 URL 命中，再按 waitUntil 等文档状态，两阶段共享同一 startedAt，剩余预算逐段扣减。
  // commit 表示不等文档状态，直接返回当前 URL；把它当成 load 会让期望快速返回的调用多等一整个加载周期。
  // URL 命中后返回的是实时读取的地址，不是 pattern，重定向场景下两者可能不同。
  if (action.name === "waitForURL") {
    const pattern = action.url;
    const timeoutMs = normalizePlaywrightTimeout(action.timeoutMs);
    const startedAt = Date.now();
    const status = await poll(
      async () => urlMatches(pattern, view.webContents.getURL()),
      timeoutMs,
      signal,
    );
    if (status === "cancelled")
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    if (status !== "matched") return timeoutResult(done, `URL ${pattern}`);
    // 缺省值是 load 而不是 domcontentloaded，改动默认值会让所有未显式声明的调用方提前拿到页面。
    // 这里的兜底只是协议缺省，不要把不支持的取值静默映射成 load，未知值应由状态等待函数报错。
    const waitUntil = action.waitUntil ?? "load";
    if (waitUntil !== "commit") {
      const loadStatus = await waitForDocumentState(
        view,
        waitUntil,
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        signal,
      );
      if (loadStatus === "cancelled") {
        return done({
          ok: false,
          error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
        });
      }
      if (loadStatus === "timeout")
        return timeoutResult(done, `URL ${pattern} to reach ${waitUntil}`);
    }
    return done({ ok: true, value: view.webContents.getURL() });
  }
  // 状态名缺省为 load，与 waitForURL 的第二阶段保持同一默认，两处必须同步修改。
  // 结果只有 matched 与 timeout 两种有效走向，取消已在前面单独处理，不要合并进三元表达式。
  if (action.name === "waitForLoadState") {
    const state = action.state ?? "load";
    const status = await waitForDocumentState(
      view,
      state,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    if (status === "cancelled")
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    return status === "matched" ? done({ ok: true }) : timeoutResult(done, `load state ${state}`);
  }
  // locator 的解析、等待与执行都在专用执行器里，本层只做结果映射，不要在此重试或补等待。
  // 执行器返回 kind 判别式而非抛错，因为超时与取消要携带不同的恢复指引，异常会丢掉这些信息。
  if (action.name === "locator") {
    // timeoutMs 必须归一化后传入，执行器内部按同一预算分配等待与动作时间。
    // signal 透传保证取消能穿透到执行器内部的轮询，本层不再额外包一层 AbortController。
    const execution = await executeIabPlaywrightLocator(
      view,
      action,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    if (execution.kind === "cancelled") {
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    }
    if (execution.kind === "timeout") return locatorTimeoutResult(done, execution.reason);
    return done({ ok: true, value: execution.value });
  }
  return done({
    ok: false,
    error: {
      // [失败路径] 走到这里说明动作名不在本层白名单内，通常是需要在 IAB manager 侧实现的浏览器动作。
      // 不要把它改成 ok:true 或通用 error：前者让缺失能力看起来可用，后者让上层无法区分能力缺口与运行故障。
      // 新增动作时若只在本文件加分派、忘记同步 manager，会出现桌面可用而 Web 端直接报该错误的分叉。
      code: "capability_unsupported",
      message: `playwright.${action.name} is handled by the IAB manager`,
    },
  });
}
