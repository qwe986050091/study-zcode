// INV-01 ref 只在最近一次快照内有效：守住位置 句柄替换；改错故障 旧 ref 操作到新页面元素。
// INV-02 句柄表只存 adapter 侧：守住位置 WeakMap；改错故障 不可信页面脚本篡改 ref 映射。
// INV-03 新表就位后释放旧表：守住位置 替换顺序；改错故障 ElementHandle 持续累积。
// INV-04 三个临时句柄必释放：守住位置 末尾 Promise.all；改错故障 每次快照泄漏句柄。
// INV-05 非数字属性立即释放：守住位置 过滤分支；改错故障 无关属性句柄随快照泄漏。
// INV-06 元素数量有上限：守住位置 截断；改错故障 超大页面快照撑爆上下文。
// INV-07 语义节点单列上限：守住位置 独立常量；改错故障 两处上限互相牵连。
// INV-08 截断要显式标记：守住位置 布尔字段；改错故障 模型误以为看到完整页面。
// INV-09 隐藏过滤可关闭：守住位置 参数；改错故障 调试时无法看到零尺寸元素。
// INV-10 可见性为近似判定：守住位置 判定函数；改错故障 遮挡与离屏元素被误判为隐藏。
// INV-11 文本折叠并截断：守住位置 归一化；改错故障 长文本撑爆快照体积。
// INV-12 属性走白名单：守住位置 键列表；改错故障 任意属性被带出页面。
// INV-13 选择器优先安全 id：守住位置 早退；改错故障 特殊字符 id 生成非法选择器。
// INV-14 选择器深度有上限：守住位置 循环条件；改错故障 超深 DOM 生成巨长选择器。
// INV-15 XPath 不截断深度：守住位置 循环；改错故障 精确复用定位失效。
// INV-16 ref 编号按文档顺序：守住位置 映射下标；改错故障 ref 与实际元素错位。
// INV-17 父引用取最近已编号祖先：守住位置 上溯循环；改错故障 层级归属错误。
// INV-18 脱离文档即视为失效：守住位置 isConnected 判定；改错故障 向幽灵元素发命令。
//
// 模块职责：在页面内采集可交互元素与语义 DOM，并维护 ref 到句柄的映射。
// 状态所有权：句柄表按 Page 隔离放在 adapter 侧 WeakMap。
// 阅读顺序：先看采集函数，再看句柄接管，最后看两个解析入口。
// ============================================================
// 文件定位：页面快照采集（可交互元素 + 语义 DOM）与 ref→ElementHandle 解析。
// 输入输出：capture 返回 BrowserSnapshot；resolve* 把 "e1" 解析成元素或视口中心坐标。
// 副作用：在页面内执行查询/求值，持有 ElementHandle；每次新快照会释放上一代句柄。
// 失败语义：元素已脱离文档返回 undefined；jsonValue 失败向上抛由 index 分类。
// 不变量：ref 只在“最后一次快照”内有效；ref 映射只存 adapter 侧 WeakMap，不写入页面全局。
// ============================================================
import type { BrowserSnapshot } from "@zcode/contracts";
import type { ElementHandle, Page } from "playwright-core";

// 默认上限：200 个可交互元素、300 个语义 DOM 节点，超出即标 truncated。
const DEFAULT_MAX_ELEMENTS = 200;
const DEFAULT_MAX_DOM_NODES = 300;

// 页面内采集参数：includeHidden 决定是否过滤 display:none/0 尺寸元素。
type SnapshotOptions = { includeHidden: boolean; maxDomNodes: number; maxElements: number };
type SnapshotCollection = { refElements: Element[]; snapshot: BrowserSnapshot };

// 每个 Page 只保留最近一次快照的句柄；WeakMap 保证页面关闭后可回收。
const pageRefs = new WeakMap<Page, Map<string, ElementHandle<Element>>>();

/**
 * 这段函数由 Playwright 序列化到页面执行，不能引用模块闭包。Element ref 不写入页面
 * globalThis，而由 adapter 从返回的 handle collection 接管，避免不可信页面脚本替换 ref map。
 */
// 采集流程：按选择器收集可交互元素（编号 e1..eN）→ 生成 selector/xpath/rect/parentRef
// → 再收集语义 DOM（记录 depth 与对应 ref）→ 返回纯数据 + 元素数组供 adapter 转句柄。
// collectSnapshot 会被 page.evaluateHandle 序列化进页面，不能引用模块闭包。
// 页面内只能用 options 与 DOM API，外部变量一律不可见。
// 先按 actionSelector 收集可交互元素，编号为 e1..eN。
// 再按 domSelector 采集语义节点并记录 depth 与 parentRef。
// 返回 { refElements, snapshot } 纯数据，句柄由 adapter 侧接管。
function collectSnapshot(options: SnapshotOptions): SnapshotCollection {
  // actionSelector 覆盖 a[href]/button/input/textarea/select/[role]/[onclick] 等语义。
  const actionSelector =
    "a[href],button,input,textarea,select,[role],[onclick],[tabindex],summary,label,[contenteditable]";
  // 语义 DOM 选择器：在可交互元素之外补标题/段落/列表/表格/媒体等结构节点。
  const domSelector =
    "body,main,nav,header,footer,aside,section,article,h1,h2,h3,h4,h5,h6,p,ul,ol,li,dl,dt,dd,blockquote,pre,code,table,caption,thead,tbody,tfoot,tr,th,td,form,fieldset,legend,figure,figcaption,img,canvas,svg,a[href],button,input,textarea,select,option,summary,label,[role],[aria-label],[contenteditable]";
  const refElements: Element[] = [];
  const reverseRefs = new WeakMap<Element, string>();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  // 隐藏判定：display:none / visibility:hidden / opacity:0 / 宽高皆 0 都算不可见。
  // 只做近似判定（不含遮挡与离屏），默认采集会过滤这些元素。
  const hidden = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      (rect.width <= 0 && rect.height <= 0)
    );
  };
  // 文本归一化：折叠空白并截断到 max，避免长文本撑爆快照体积。
  const text = (value: string | null | undefined, max: number): string =>
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, max);
  // 隐式 role 推断：显式 role 缺失时按标签/input type 补一个可读角色，便于模型理解语义。
  const implicitRole = (element: Element, tag: string): string => {
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return "";
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "search") return "searchbox";
    return "textbox";
  };
  // 可访问名：aria-label > alt > title > placeholder > innerText > textContent，最长 120。
  const accessibleName = (element: Element): string =>
    text(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        (element as HTMLElement).innerText ||
        element.textContent,
      120,
    );
  // 只保留白名单属性（id/href/name/type/role/aria/data-testid 等），单值最长 240。
  const attributes = (element: Element): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const key of [
      "id",
      "href",
      "name",
      "type",
      "placeholder",
      "title",
      "alt",
      "role",
      "aria-label",
      "data-testid",
      "data-test",
      "data-qa",
    ]) {
      const value = text(element.getAttribute(key), 240);
      if (value) result[key] = value;
    }
    return result;
  };
  // 选择器优先级：安全 id（以字母开头）直接用 #id，否则向上最多 6 层生成 nth-of-type 链。
  // 限制深度是为了控制快照体积，同时避免超深 DOM 生成巨长选择器。
  const selector = (element: Element): string => {
    if (element.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(element.id)) return `#${element.id}`;
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
        : [];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  // 绝对 XPath（不截断深度）：作为 selector 之外的第二定位手段，适合自动化脚本精确复用。
  const xpath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
        : [];
      parts.unshift(`${tag}[${siblings.indexOf(current) + 1}]`);
      current = current.parentElement;
    }
    return `/${parts.join("/")}`;
  };
  // 视口判定：元素矩形与 (0,0,viewportW,viewportH) 相交即算在视口内（部分可见也算）。
  const inViewport = (rect: DOMRect): boolean =>
    rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0;

  // ref 按“文档顺序 + 1”编号且只分配给可交互元素；被截断的元素没有 ref，无法通过 ref 操作。
  const actionNodes = [...document.querySelectorAll(actionSelector)].filter(
    (element) => options.includeHidden || !hidden(element),
  );
  const elements = actionNodes.slice(0, options.maxElements).map((element, index) => {
    const ref = `e${index + 1}`;
    refElements.push(element);
    reverseRefs.set(element, ref);
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element, tag);
    const name = accessibleName(element);
    const elementText = text((element as HTMLElement).innerText, 100);
    const attrs = attributes(element);
    const value = "value" in element ? text(String((element as HTMLInputElement).value), 240) : "";
    let parent = element.parentElement;
    // parentRef 取最近的“已编号祖先”，用于还原交互元素的层级归属。
    let parentRef: string | undefined;
    while (parent && !parentRef) {
      parentRef = reverseRefs.get(parent);
      parent = parent.parentElement;
    }
    return {
      ref,
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(elementText ? { text: elementText } : {}),
      ...(value ? { value } : {}),
      ...("disabled" in element && (element as HTMLInputElement).disabled
        ? { disabled: true }
        : {}),
      ...("checked" in element ? { checked: Boolean((element as HTMLInputElement).checked) } : {}),
      selector: selector(element),
      xpath: xpath(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      inViewport: inViewport(rect),
      ...(parentRef ? { parentRef } : {}),
      ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    };
  });

  const domNodes = [...document.querySelectorAll(domSelector)].filter(
    (element) => options.includeHidden || !hidden(element),
  );
  const dom = domNodes.slice(0, options.maxDomNodes).map((element) => {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element, tag);
    const name = accessibleName(element);
    const semanticText =
      /^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(
        tag,
      )
        ? text((element as HTMLElement).innerText || element.textContent, 300)
        : "";
    // depth 只数到 body 之前，表示语义 DOM 的嵌套深度；body 自身 depth=0。
    let depth = 0;
    for (
      let parent = element.parentElement;
      parent && parent !== document.body;
      parent = parent.parentElement
    )
      depth += 1;
    const ref = reverseRefs.get(element);
    const attrs = attributes(element);
    return {
      tag,
      depth,
      inViewport: inViewport(rect),
      ...(ref ? { ref } : {}),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(semanticText ? { text: semanticText } : {}),
      ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    };
  });

  return {
    refElements,
    snapshot: {
      url: location.href,
      title: document.title,
      elements,
      truncated: actionNodes.length > options.maxElements,
      dom,
      domTruncated: domNodes.length > options.maxDomNodes,
    },
  };
}

// 采集一次快照并把页面内元素数组转成 adapter 侧句柄表。
// 新表替换旧表后立即释放上一代句柄（防止 ElementHandle 累积）；三个临时句柄无论成败都 dispose。
// 采集参数先做下限保护。
// 结果拆成快照与元素数组。
// 只有数字键才转成 ref。
// pageRefs.set(page, nextRefs) 用新表替换旧表。
// 旧句柄在替换后统一释放。
export async function captureManagedCdpSnapshot(
  page: Page,
  maxElements = DEFAULT_MAX_ELEMENTS,
  includeHidden = false,
): Promise<BrowserSnapshot> {
  const collection = await page.evaluateHandle(collectSnapshot, {
    includeHidden,
    maxDomNodes: DEFAULT_MAX_DOM_NODES,
    maxElements: Math.max(1, Math.floor(maxElements)),
  });
  const snapshotHandle = await collection.getProperty("snapshot");
  const refElementsHandle = await collection.getProperty("refElements");
  const snapshot = (await snapshotHandle.jsonValue()) as BrowserSnapshot;
  const nextRefs = new Map<string, ElementHandle<Element>>();
  for (const [index, handle] of await refElementsHandle.getProperties()) {
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element || !/^\d+$/u.test(index)) {
      await handle.dispose();
      continue;
    }
    nextRefs.set(`e${Number(index) + 1}`, element);
  }
  const previousRefs = pageRefs.get(page);
  pageRefs.set(page, nextRefs);
  await Promise.all([...(previousRefs?.values() ?? [])].map(async (handle) => handle.dispose()));
  await Promise.all([snapshotHandle.dispose(), refElementsHandle.dispose(), collection.dispose()]);
  return snapshot;
}

// 按 ref 取最近一次快照的句柄；元素已脱离文档（被移除/重渲染）时返回 undefined。
// isConnected 求值失败也按失效处理，宁可让调用方重拍快照，也不对幽灵元素发命令。
// resolveSnapshotElement 只查 pageRefs 中最近一次快照的 Map。
// ref 未命中时直接返回 undefined，调用方按失效处理。
// element.evaluate 求 isConnected 失败时 catch 返回 false。
// isConnected 求值失败按失效处理，宁可让调用方重拍快照，也不对幽灵元素发命令。
// 命中时原样返回调用方的 ElementHandle，本函数不 dispose。
export async function resolveSnapshotElement(
  page: Page,
  ref: string,
): Promise<ElementHandle<Element> | undefined> {
  const element = pageRefs.get(page)?.get(ref);
  if (!element) return undefined;
  const connected = await element.evaluate((node) => node.isConnected).catch(() => false);
  return connected ? element : undefined;
}

// 把 ref 解析成视口中心坐标：先滚动到可见区再取 boundingBox（相对视口，滚动后才有意义）。
// 元素不可见/无布局时 boundingBox 为 null，返回 undefined 由上层决定如何报错。
// resolveSnapshotRef 先调 resolveSnapshotElement 拿句柄。
// scrollIntoViewIfNeeded 之后 boundingBox 才是视口坐标。
// boundingBox 为 null 时返回 undefined，由上层决定报错方式。
// 坐标取 rect 中心并用 Math.round 取整。
export async function resolveSnapshotRef(
  page: Page,
  ref: string,
): Promise<{ x: number; y: number } | undefined> {
  const element = await resolveSnapshotElement(page, ref);
  if (!element) return undefined;
  await element.scrollIntoViewIfNeeded();
  const rect = await element.boundingBox();
  return rect
    ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    : undefined;
}
