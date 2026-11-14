// INV-01 守住位置：isAllowedManagedBrowserUrl 是导航唯一准入闸门，只放行 http/https 与 about:blank。改错故障：放开 file:// 或 data: 后本地文件与内联内容进入托管页面。
// INV-02 守住位置：导航类动作固定使用 NAVIGATION_TIMEOUT_MS，不允许被单次命令覆盖。改错故障：去掉超时后一次慢导航会长期占住页面与调用方。
// INV-03 守住位置：withModifiers 在 finally 中逆序抬起所有修饰键。改错故障：异常路径漏释放会让后续输入全部带着按下的修饰键。
// INV-04 守住位置：elementForRef 解析失败必须抛错并提示重新快照。改错故障：退化成返回空值后命令变成静默空操作，问题无法定位。
// INV-05 守住位置：pointFor 中 ref 优先于显式坐标，缺参数即报错。改错故障：坐标兜底成原点会把点击打到页面左上角。
// INV-06 守住位置：readManagedPageState 的临时 CDP session 必须 detach。改错故障：会话持续累积，最终拖垮该页面的连接。
// INV-07 守住位置：title 与滚动位置读取失败降级为空值。改错故障：任一读取失败都会让状态查询整体失败，上层拿不到 url。
// INV-08 守住位置：前进后退由历史索引与条目数比较推导。改错故障：改用按钮可用性判断会与实际导航行为不一致。
// INV-09 守住位置：pressKeys 只把最后一个键交给 press，其余作为修饰键。改错故障：全部当修饰键按下会导致只按下不触发实际输入。
// INV-10 守住位置：dragPath 的鼠标抬起放在 finally 中。改错故障：中途异常后页面停在拖拽态，后续点击被解释为拖拽延续。
// INV-11 守住位置：executeManagedPageCommand 只做调用翻译，不在此处吞错或改错误形态。改错故障：错误语义被提前扁平化，上层无法按码分类。
// INV-12 守住位置：导航类命令成功后统一附带一次页面状态。改错故障：上层二次查询会引入时序差，读到与命令完成瞬间不同的状态。
// INV-13 守住位置：未识别的 method 落到 default 返回 capability_unsupported。改错故障：改为抛错后未知命令被当作运行时故障而非能力缺失。
// INV-14 守住位置：screenshot 有 ref 时截元素并忽略 fullPage 与 clip。改错故障：参数冲突会产生与调用方预期不符的整页图。
// INV-15 守住位置：evaluate 固定 3s 超时且结果按 string 返回。改错故障：长任务阻塞 turn，复杂对象还可能跨浏览器边界。
// INV-16 守住位置：waitFor 超时上限压到 3s，且 selector/text/textGone 必须给出一个。改错故障：吃光浏览器超时预算或空等一个不存在的条件。
// INV-17 守住位置：elementInfo 每次都取新快照再做命中测试。改错故障：复用旧快照会让坐标与当前页面错位。
// INV-18 守住位置：fill、select、check 一律经由 ref 解析元素，不共享其他分支状态。改错故障：误作用到别的元素会导致表单校验结果错乱。
//
// 模块职责：把 BrowserCommand 翻译成 Playwright 操作，返回去掉 elapsedMs 的结果。
// 状态所有权：页面状态与快照由本模块读取，错误分类与耗时补全由 index 层负责。
// 阅读顺序：先看白名单与按键、坐标辅助函数，再看 readManagedPageState，最后看 executeManagedPageCommand 的分派。
// ============================================================
// 文件定位：托管 CDP 运行时的“页面级命令”实现：导航、快照、截图、输入、滚动、等待等。
// 输入输出：输入 playwright Page + BrowserCommand，输出去掉 elapsedMs 的部分结果。
// 副作用：驱动真实浏览器（鼠标/键盘/导航/JS 求值），可能改变页面状态或触发网络请求。
// 失败语义：不支持的命令返回 capability_unsupported；ref 失效/缺坐标抛错，由上层分类。
// 不变量：导航默认 30s 超时且只允许 http/https/about:blank；输入类操作必须成对按下/释放修饰键。
// ============================================================
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserKeyModifier,
  BrowserPageState,
  BrowserPoint,
} from "@zcode/contracts";
import type { ElementHandle, Page } from "playwright-core";
import { executeManagedPlaywrightAction, evaluatePage } from "./playwright-command.js";
import {
  captureManagedCdpSnapshot,
  resolveSnapshotElement,
  resolveSnapshotRef,
} from "./snapshot.js";

// 除 elapsedMs 外的完整结果：由 index 层统一补耗时与 meta。
type PartialResult = Omit<BrowserCommandResult, "elapsedMs">;

// 导航类动作的固定超时（30s）：页面可能长期加载，比单次点击宽松得多。
const NAVIGATION_TIMEOUT_MS = 30_000;

// URL 白名单：仅 http/https 与 about:blank，阻断 file://、data:、chrome:// 等本地/特权协议。
// 解析失败（非法 URL）同样拒绝，避免把异常字符串透传给 goto。
// 契约：该函数是导航前唯一准入闸门，只回答能否交给浏览器。
// 只有 http、https 与 about:blank 通过，解析失败的字符串直接判否。
// false 由上层转成 navigation_blocked 结果，这里不抛异常。
// 改错后果：改用前缀匹配会让大小写或拼接 URL 绕过校验。
export function isAllowedManagedBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.href === "about:blank";
  } catch {
    return false;
  }
}

// 把跨平台修饰键 ControlOrMeta 映射为当前平台真实键（macOS=Meta，其余=Control）。
function normalizedModifier(modifier: BrowserKeyModifier): "Alt" | "Control" | "Meta" | "Shift" {
  return modifier === "ControlOrMeta"
    ? process.platform === "darwin"
      ? "Meta"
      : "Control"
    : modifier;
}

// 按住修饰键执行动作，finally 逆序释放，保证异常时也不会留下“按键卡住”的浏览器状态。
// 并发边界：修饰键是页面级共享状态，按下后必须保证释放。
// ControlOrMeta 在 macOS 映射为 Meta，其他平台映射为 Control。
// 释放走 finally 且逆序，异常路径同样执行，不留按键卡住。
// action 抛错直接向上抛，由调用层按 errorCode 分类。
// modifiers 为空时只执行 action，不额外按键。
// 改错后果：去掉 finally 后一次失败点击会让后续输入全部带修饰键。
async function withModifiers(
  page: Page,
  modifiers: BrowserKeyModifier[] | undefined,
  action: () => Promise<void>,
): Promise<void> {
  const keys = (modifiers ?? []).map(normalizedModifier);
  for (const key of keys) await page.keyboard.down(key);
  try {
    await action();
  } finally {
    for (const key of keys.reverse()) await page.keyboard.up(key);
  }
}

// 按 snapshot ref 解析元素句柄；ref 失效时给出“重新快照”的可操作提示，而非裸 null 错误。
// 契约：把 snapshot ref 解析成元素句柄，失败即抛错。
// ref 失效属预期情况，错误文案提示先重新快照再重试。
// 不返回空值让调用方逐处判空，避免漏判后当正常元素使用。
// 改错后果：吞掉失效 ref 会让命令静默变成空操作。
async function elementForRef(page: Page, ref: string): Promise<ElementHandle<Element>> {
  const element = await resolveSnapshotElement(page, ref);
  if (!element) {
    throw new Error(
      `Browser ref '${ref}' is stale or unavailable. Take a fresh snapshot before retrying.`,
    );
  }
  return element;
}

// 解析点击/悬停坐标：ref 优先（可跟随滚动位置），否则用显式 x/y；两者都缺则报错。
// 坐标优先级：ref 高于显式坐标，因为 ref 跟随滚动后的真实位置。
// ref 解析失败与两者都缺失都抛错，由上层统一归类。
// 显式坐标需横纵同时存在，避免半坐标被当成原点。
// 改错后果：兜底成原点会把点击打到页面左上角，产生误操作。
async function pointFor(
  page: Page,
  ref: string | undefined,
  point: BrowserPoint | undefined,
): Promise<{ x: number; y: number }> {
  if (ref) {
    const resolved = await resolveSnapshotRef(page, ref);
    if (!resolved) throw new Error(`Browser ref '${ref}' is stale or unavailable`);
    return resolved;
  }
  if (point) return point;
  throw new Error("Browser action requires a ref or x/y coordinates");
}

// 读取页面状态：通过临时 CDP session 取导航历史（判断可前进/后退），再补滚动与视口信息。
// 临时 session 必须 detach；title/滚动读取失败都降级为空值，不能让 getState 整体失败。
// 状态所有权：页面状态只在这里读取，调用方不各自探测前进后退。
// 历史索引来自临时 CDP session，用完必须在 finally 中 detach。
// 标题与滚动位置读取失败降级为空值，不让状态查询整体失败。
// 视口尺寸可能为空，此时不写入对应字段而不是填零。
// 前进后退由索引与条目数比较得出，不依赖界面按钮可用性。
// 改错后果：漏掉 detach 会持续累积会话，最终拖垮页面连接。
export async function readManagedPageState(page: Page): Promise<BrowserPageState> {
  const client = await page.context().newCDPSession(page);
  try {
    const history = (await client.send("Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: unknown[];
    };
    const currentIndex = history.currentIndex ?? 0;
    const entryCount = history.entries?.length ?? 1;
    const viewport = page.viewportSize();
    const scroll = await page
      .evaluate(() => ({
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      }))
      .catch(() => ({ scrollX: 0, scrollY: 0 }));
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      canGoBack: currentIndex > 0,
      canGoForward: currentIndex + 1 < entryCount,
      ...scroll,
      ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
    };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

// 依次按下修饰键再 press 最后一个键，最后逆序释放；空数组视为无操作。
// 组合键语义：keys 除最后一项外都按 modifiers 按下。
// 空数组直接返回，避免对空键名发按键事件。
// 释放同样走 finally 且逆序，保证异常时不留按下状态。
// 最后一个键走 press，让浏览器产生完整的按下与抬起。
// 改错后果：把全部键都当修饰键会只按下而不触发实际输入。
async function pressKeys(page: Page, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const normalized = keys.map((key) =>
    key === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : key,
  );
  const modifiers = normalized.slice(0, -1);
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    await page.keyboard.press(normalized.at(-1) ?? "");
  } finally {
    for (const key of modifiers.reverse()) await page.keyboard.up(key);
  }
}

// 拖拽路径：按下起点后按 4 步插值移动，finally 必定释放鼠标，避免页面停留在拖拽态。
// drag 必须成对 mouse.down/up，否则页面停在拖拽态。
// path 为空抛错，不静默返回成功。
// 中间点按 steps 插值 mouse.move，保证 drag 事件连续触发。
// 抬起的动作放在 finally，中途异常也会结束拖拽。
async function dragPath(page: Page, path: BrowserPoint[]): Promise<void> {
  if (path.length === 0) throw new Error("Browser drag requires a non-empty path");
  const [first, ...rest] = path;
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  try {
    for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 4 });
  } finally {
    await page.mouse.up();
  }
}

// 页面命令大分派：每个 case 只做“调用 Playwright + 返回结果”，错误统一向上抛由 index 分类。
// 导航类命令成功后都会附带一次页面状态（url/title/前进后退），减少上层二次查询。
// 大分派只做参数到 Playwright 调用的翻译，不在此处分类错误。
// 导航类命令成功后统一附带一次页面状态，避免上层再查一次。
// 未知 method 由 default 兜底成 capability_unsupported，不抛异常。
// 截图有 ref 时按元素截取并忽略整页与裁剪参数。
// 求值与等待的超时都压到 3s，避免单个命令吃光浏览器预算。
export async function executeManagedPageCommand(
  page: Page,
  command: BrowserCommand,
): Promise<PartialResult> {
  switch (command.method) {
    case "navigate":
      // 非白名单协议直接拒绝并返回 navigation_blocked，绝不把 URL 交给 goto。
      if (!isAllowedManagedBrowserUrl(command.url)) {
        return {
          ok: false,
          error: {
            code: "navigation_blocked",
            message: `Navigation URL is not allowed: ${command.url}`,
          },
        };
      }
      await page.goto(command.url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "back":
      await page.goBack({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "forward":
      await page.goForward({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "reload":
      await page.reload({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "getState":
      return { ok: true, state: await readManagedPageState(page) };
    case "snapshot":
      return {
        ok: true,
        snapshot: await captureManagedCdpSnapshot(page, command.maxElements, command.includeHidden),
      };
    case "screenshot": {
      // 有 ref 就截元素（忽略 fullPage/clip），否则整页截图；结果统一转 base64 PNG。
      const image = command.ref
        ? await (await elementForRef(page, command.ref)).screenshot({ type: "png" })
        : await page.screenshot({
            type: "png",
            fullPage: command.fullPage,
            clip: command.clip,
          });
      return { ok: true, image: { base64: image.toString("base64"), mimeType: "image/png" } };
    }
    case "click": {
      const point = await pointFor(
        page,
        command.ref,
        command.x !== undefined && command.y !== undefined
          ? { x: command.x, y: command.y }
          : undefined,
      );
      await withModifiers(page, command.modifiers, async () => {
        await page.mouse.click(point.x, point.y, {
          button: command.button,
          clickCount: command.doubleClick ? 2 : 1,
        });
      });
      return { ok: true };
    }
    case "fill": {
      const element = await elementForRef(page, command.ref);
      await element.fill(command.value);
      return { ok: true };
    }
    case "type":
      if (command.ref) {
        await (await elementForRef(page, command.ref)).focus();
      }
      await page.keyboard.type(command.text);
      return { ok: true };
    case "press":
      // 有 ref 时把按键发给元素（可触发元素级快捷键），否则发给页面并套修饰键。
      if (command.ref) await (await elementForRef(page, command.ref)).press(command.key);
      else
        await withModifiers(page, command.modifiers, async () => page.keyboard.press(command.key));
      return { ok: true };
    case "cuaKeypress":
      await pressKeys(page, command.keys);
      return { ok: true };
    case "scroll":
      if (command.ref)
        await (
          await elementForRef(page, command.ref)
        ).evaluate((element) => element.scrollIntoView());
      await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
        x: command.x ?? 0,
        y: command.y ?? 0,
      });
      return { ok: true };
    case "cuaScroll":
      await withModifiers(page, command.modifiers, async () => {
        await page.mouse.move(command.x, command.y);
        await page.mouse.wheel(command.scrollX, command.scrollY);
      });
      return { ok: true };
    case "domCuaScroll": {
      const anchor = command.nodeId
        ? await pointFor(page, command.nodeId, undefined)
        : await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
      await page.mouse.move(anchor.x, anchor.y);
      await page.mouse.wheel(command.scrollX, command.scrollY);
      return { ok: true };
    }
    case "hover": {
      const point = await pointFor(
        page,
        command.ref,
        command.x !== undefined && command.y !== undefined
          ? { x: command.x, y: command.y }
          : undefined,
      );
      await withModifiers(page, command.modifiers, async () => page.mouse.move(point.x, point.y));
      return { ok: true };
    }
    case "select":
      await (await elementForRef(page, command.ref)).selectOption(command.values);
      return { ok: true };
    case "check":
      await (await elementForRef(page, command.ref)).setChecked(command.checked ?? true);
      return { ok: true };
    case "drag": {
      const from = await pointFor(page, command.fromRef, command.from);
      const to = await pointFor(page, command.toRef, command.to);
      await withModifiers(page, command.modifiers, async () => dragPath(page, [from, to]));
      return { ok: true };
    }
    case "cuaDrag":
      await withModifiers(page, command.modifiers, async () => dragPath(page, command.path));
      return { ok: true };
    case "elementInfo": {
      // 先用一次新快照取得元素矩形，再用命中测试挑出包含 (x,y) 的元素；无命中时 element 为 undefined。
      const snapshot = await captureManagedCdpSnapshot(page);
      return {
        ok: true,
        element: snapshot.elements.find(
          (element) =>
            command.x >= element.rect.x &&
            command.x <= element.rect.x + element.rect.width &&
            command.y >= element.rect.y &&
            command.y <= element.rect.y + element.rect.height,
        ),
      };
    }
    case "evaluate":
      // 页面求值固定 3s 且返回 string：避免长任务阻塞 turn，也避免把复杂对象带出浏览器。
      return {
        ok: true,
        value: await evaluatePage(page, command.expression, "string", undefined, 3_000),
      };
    case "waitFor": {
      // 等待上限压到 3s：等待是“确认某元素出现”，不应消耗整个浏览器超时预算。
      const timeout = Math.min(3_000, Math.max(1, command.timeoutMs ?? 3_000));
      if (command.selector)
        await page.locator(command.selector).waitFor({ timeout, state: "visible" });
      else if (command.text)
        await page.getByText(command.text).waitFor({ timeout, state: "visible" });
      else if (command.textGone)
        await page.getByText(command.textGone).waitFor({ timeout, state: "hidden" });
      else throw new Error("waitFor requires selector, text, or textGone");
      return { ok: true };
    }
    case "playwright":
      return await executeManagedPlaywrightAction(page, command.action);
    case "playwrightWaitForTimeout":
      await new Promise<void>((resolve) => setTimeout(resolve, command.timeoutMs));
      return { ok: true };
    // 兜底分支是能力的显式声明：未实现的方法返回结构化错误而非异常。
    // 错误码固定为 capability_unsupported，供上层与协议层识别。
    // 错误信息带上方法名，便于定位调用方能力假设。
    // 改错后果：改成抛错会让未知命令被当作运行时故障而非能力缺失。
    default:
      return {
        ok: false,
        error: {
          code: "capability_unsupported",
          message: `Browser command '${command.method}' is unavailable in the managed CDP page runtime`,
        },
      };
  }
}
