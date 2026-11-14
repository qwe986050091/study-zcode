// INV-01 超时有界：守住位置 默认值与上下界；改错故障：单动作长期占住回合。
// INV-02 非法值不归零：守住位置 下限夹紧；改错故障：零或负超时造成立即失败。
// INV-03 会话必断：守住位置 求值的收尾；改错故障：每次求值泄漏一个调试会话。
// INV-04 断开会吞：守住位置 断开异常的捕获；改错故障：清理失败覆盖真实求值结果。
// INV-05 异常取原描述：守住位置 描述优先级；改错故障：错误信息退化成泛化文案。
// INV-06 修饰键归一：守住位置 跨平台映射；改错故障：同一组合键在另一平台失效。
// INV-07 写操作无值：守住位置 写分支返回空；改错故障：调用方拿到无意义的旧值。
// INV-08 逐字符可配：守住位置 替换开关；改错故障：需要输入事件的场景拿不到事件。
// INV-09 未支持即抛：守住位置 独立工具分支；改错故障：落入未知方法，错误被误判成页面问题。
// INV-10 命中测试过滤：守住位置 交互元素选择器；改错故障：返回大段布局容器。
// INV-11 标记不改命中：守住位置 标记样式；改错故障：覆盖层拦截事件，后续操作失效。
// INV-12 截图必清标记：守住位置 收尾清理；改错故障：标记节点残留在页面里。
// INV-13 零命中即错：守住位置 命中数判断；改错故障：截出一张没有标记的图。
// INV-14 空态拒绝：守住位置 空闲等待判断；改错故障：调用方等满超时拿到模糊错误。
// INV-15 默认装载态：守住位置 状态默认值；改错故障：未指定状态时等待行为不确定。
// INV-16 结果同构：守住位置 部分结果结构；改错故障：补时长时字段错位。
// INV-17 分支单一：守住位置 动作分派；改错故障：一个分支做多步副作用，失败难以归因。
// INV-18 无全局状态：守住位置 模块体；改错故障：并发动作共享可变会话。
//
// 模块职责：执行 Playwright 原生动作，覆盖定位器、求值、等待与元素截图。
// 状态所有权：页面归调用方；本模块只持有动作级临时资源。
// 阅读顺序：常量 → 超时与定位辅助 → 求值 → 定位器分派 → 动作分派 → 不支持动作。
// ============================================================
// 文件定位：Playwright 原生动作（playwright_*）的执行层：locator 系列、evaluate、等待、元素截图。
// 输入输出：输入 Page + BrowserPlaywrightAction，输出去掉 elapsedMs 的部分结果。
// 副作用：驱动页面（点击/填表/导航等待）、执行 JS、临时注入并清理截图标记节点。
// 失败语义：不支持的操作/networkidle 直接抛错；evaluate 异常转为带原文的 Error。
// 不变量：所有动作超时被压到 1..3000ms；CDP 会话在 finally detach；截图标记在 finally 清除。
// ============================================================
import type {
  BrowserCommandResult,
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@zcode/contracts";
import type { Locator, Page } from "playwright-core";

// 统一默认与上限 3s：单个浏览器动作不应长占 turn，慢页面应显式重试而非放大超时。
const DEFAULT_TIMEOUT_MS = 3_000;
// PartialResult 与 page-command 同构，由 index 统一补 elapsedMs。
type PartialResult = Omit<BrowserCommandResult, "elapsedMs">;

// 归一化超时：缺省 3s，范围 [1, 3000]，小数截断；非法值不会造成 0/neg 的立即超时。
// 缺省值即 DEFAULT_TIMEOUT_MS；显式传入时夹在 1 到 3000 之间。
// 小数向下取整，非法值也不会立即超时。
//
function timeoutMs(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

// locator 只是 selectors 的薄封装；保留函数便于未来替换定位实现而不改所有调用点。
// locatorFor 只是 page.locator 的薄封装，不额外解析或等待元素。
// 集中一处便于替换实现而不改调用点。
//
function locatorFor(page: Page, selector: string): Locator {
  return page.locator(selector);
}

// ControlOrMeta 归一化：macOS 用 Meta(Command)，其余平台用 Control，保证同一命令跨平台可用。
// ControlOrMeta 统一归一成具体修饰键，调用方不必按平台分支。
// darwin 上映射为 Meta（Command），其余平台映射为 Control。
//
function modifiers(
  values?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (values ?? []).map((value) =>
    value === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : value,
  );
}

// 通过临时 CDP session 执行表达式：支持 awaitPromise + returnByValue，能拿到可 JSON 化的结果。
// function 形态会 JSON.stringify 参数再拼成 `(fn)(arg)`；异常信息优先取 exception.description。
// 无论成败都 detach，避免每次求值泄漏一个 CDP session。
// 临时 CDP session 隔离求值上下文：表达式在页面里执行，结果经 returnByValue 序列化回来。
// function 形态的参数先 JSON.stringify 再拼成 (fn)(arg)，闭包变量因此无法跨 CDP 边界传递。
// 异常信息优先取 exception.description，缺失时退回 exception.text。
// detach 放在 finally 里，成功与异常路径都不会遗留 session。
//
export async function evaluatePage(
  page: Page,
  expression: string,
  expressionKind: "string" | "function",
  arg: unknown,
  budgetMs: number,
): Promise<unknown> {
  const client = await page.context().newCDPSession(page);
  try {
    const source =
      expressionKind === "function" ? `(${expression})(${JSON.stringify(arg)})` : expression;
    const raw = (await client.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      timeout: budgetMs,
    })) as {
      exceptionDetails?: { exception?: { description?: string }; text?: string };
      result?: { value?: unknown };
    };
    if (raw.exceptionDetails) {
      const message =
        raw.exceptionDetails.exception?.description ??
        raw.exceptionDetails.text ??
        "Playwright evaluate failed";
      throw new Error(`playwright.evaluate failed: ${message}`);
    }
    return raw.result?.value;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

// locator 操作分派：读操作返回原始值，写操作返回 undefined（调用方据此决定是否带 value）。
// replace=false 时用 pressSequentially 逐字符输入（贴近真人输入、能触发 input 事件），否则直接 fill。
// 读操作返回原始值，写操作返回空。
// 替换为否时逐字符输入，能触发输入事件。
//
async function runLocatorAction(
  page: Page,
  action: Extract<BrowserPlaywrightAction, { name: "locator" }>,
): Promise<unknown> {
  const locator = locatorFor(page, action.selector);
  const timeout = timeoutMs(action.timeoutMs);
  switch (action.operation) {
    case "allTextContents":
      return await locator.allTextContents();
    case "count":
      return await locator.count();
    case "getAttribute":
      return await locator.getAttribute(action.attribute ?? "", { timeout });
    case "innerText":
      return await locator.innerText({ timeout });
    case "isEnabled":
      return await locator.isEnabled({ timeout });
    case "isVisible":
      return await locator.isVisible();
    case "textContent":
      return await locator.textContent({ timeout });
    case "click":
      await locator.click({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "dblclick":
      await locator.dblclick({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "fill":
      if (action.replace === false)
        await locator.pressSequentially(String(action.value ?? ""), { timeout });
      else await locator.fill(String(action.value ?? ""), { timeout });
      return undefined;
    case "press":
      await locator.press(String(action.value ?? ""), { timeout });
      return undefined;
    case "selectOption": {
      const selections = (action.selections ?? []).map((selection) =>
        selection.index !== undefined
          ? { index: selection.index }
          : selection.label !== undefined
            ? { label: selection.label }
            : { value: selection.value ?? "" },
      );
      await locator.selectOption(selections, { timeout });
      return undefined;
    }
    case "setChecked":
      await locator.setChecked(action.checked ?? true, { force: action.force, timeout });
      return undefined;
    case "waitFor":
      await locator.waitFor({ state: action.state ?? "visible", timeout });
      return undefined;
    // evaluate/downloadMedia 由独立工具承担（页面级求值与下载落盘不在此处），
    // 这里必须显式抛错，避免落进 Playwright 的“未知方法”而被误判为页面问题。
    // 两个动作在 locator 层没有对应 API，抛错让调用方改用页面级工具。
    // 这里显式抛错，避免落入未知方法被误判成页面问题。
    //
    case "downloadMedia":
    case "evaluate":
      throw new Error(`Playwright locator operation '${action.operation}' is unavailable`);
  }
}

// 动作分派：每个 case 只做一次 Playwright 调用并包成结果；异常统一向上抛。
// ariaSnapshot 提供低成本 DOM 语义快照；elementInfo 走 elementsFromPoint 做命中测试。
// 每个 case 只做一次 Playwright 调用，结果由外层统一补 elapsedMs。
// case 内部不捕获异常，统一向上抛给调用方结算。
//
export async function executeManagedPlaywrightAction(
  page: Page,
  action: BrowserPlaywrightAction,
): Promise<PartialResult> {
  switch (action.name) {
    case "domSnapshot":
      return {
        ok: true,
        value: await page.locator("html").ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }),
      };
    case "elementInfo":
      // 在页面里按坐标从顶层往下枚举命中元素；默认只看可交互元素，避免返回大段布局容器。
      return {
        ok: true,
        value: await page.evaluate(
          ({ x, y, includeNonInteractable }) =>
            document
              .elementsFromPoint(x, y)
              .filter(
                (element) =>
                  includeNonInteractable ||
                  element.matches("a,button,input,select,textarea,[role],[tabindex]"),
              )
              .map((element) => {
                const rect = element.getBoundingClientRect();
                const text = (
                  (element as HTMLElement).innerText ||
                  element.textContent ||
                  ""
                ).trim();
                return {
                  tagName: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  visibleText: text || null,
                  ariaName: element.getAttribute("aria-label") || text || null,
                  testId: element.getAttribute("data-testid"),
                  boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  preview: element.outerHTML.slice(0, 300),
                  selector: {
                    primary: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
                    candidates: [],
                  },
                };
              }),
          action,
        ),
      };
    // 先按坐标标记命中元素，再截图。
    // 标记不改命中，截完必须清除。
    //
    case "elementScreenshot": {
      // 用临时覆盖层标出命中元素（红色边框、pointer-events:none 以免改变命中），截图后必须清除。
      const markerAttribute = "data-zcode-element-screenshot";
      const count = await page.evaluate(
        ({ x, y, includeNonInteractable, markerAttribute }) => {
          const elements = document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                includeNonInteractable ||
                element.matches("a,button,input,select,textarea,[role],[tabindex]"),
            );
          let marked = 0;
          for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const marker = document.createElement("div");
            marker.setAttribute(markerAttribute, "");
            Object.assign(marker.style, {
              border: "2px solid #ff2d55",
              boxSizing: "border-box",
              height: `${rect.height}px`,
              left: `${rect.left}px`,
              pointerEvents: "none",
              position: "fixed",
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              zIndex: "2147483647",
            });
            document.documentElement.append(marker);
            marked += 1;
          }
          return marked;
        },
        { ...action, markerAttribute },
      );
      // 一个都没命中说明坐标处没有可交互元素，直接报错而不是截一张没有标记的图。
      if (count === 0) throw new Error("No matching element was found at the requested point");
      try {
        const image = await page.screenshot({ type: "png" });
        return { ok: true, image: { base64: image.toString("base64"), mimeType: "image/png" } };
      } finally {
        await page
          .evaluate(
            (attribute) =>
              document.querySelectorAll(`[${attribute}]`).forEach((element) => element.remove()),
            markerAttribute,
          )
          .catch(() => undefined);
      }
    }
    case "evaluate":
      return {
        ok: true,
        value: await evaluatePage(
          page,
          action.expression,
          action.expressionKind,
          action.arg,
          timeoutMs(action.timeoutMs),
        ),
      };
    // 长连接页面几乎不会进入空闲态。
    // 明确拒绝，避免调用方等满超时拿到模糊结果。
    //
    case "waitForLoadState":
      // networkidle 在长连接页面上几乎永不触发，明确拒绝而不是让调用方等 3s 后拿到模糊超时。
      if ((action.state ?? "load") === "networkidle") {
        throw new Error("playwright_wait_for_load_state does not support networkidle");
      }
      await page.waitForLoadState(action.state ?? "load", { timeout: timeoutMs(action.timeoutMs) });
      return { ok: true };
    case "waitForURL":
      // 同理拒绝 networkidle 的 URL 等待；默认 load 已能满足“导航完成”的语义。
      if (action.waitUntil === "networkidle") {
        throw new Error("playwright_wait_for_url does not support networkidle");
      }
      await page.waitForURL(action.url, {
        timeout: timeoutMs(action.timeoutMs),
        waitUntil: action.waitUntil ?? "load",
      });
      return { ok: true };
    case "locator": {
      // 写操作没有返回值：统一转成 { ok: true }，避免把 undefined 放进 value 字段。
      const value = await runLocatorAction(page, action);
      return value === undefined ? { ok: true } : { ok: true, value };
    }
    // 依赖原生事件/文件系统的动作在托管无头模式下不可用（下载路径、文件选择器、事件等待）。
    case "waitForEvent":
    case "downloadPath":
    case "fileChooserSetFiles":
      throw new Error(`Playwright action '${action.name}' is unavailable`);
  }
}
