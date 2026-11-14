/* eslint-disable max-lines -- Electron webview 注入脚本需要在单个函数内自包含运行，避免跨文件依赖在页面上下文里失效。 */
// ============================================================================
// 职责边界
// 做：构建注入 Electron webview 页面上下文的 DOM 拾取器脚本（悬停高亮、信息浮窗、点击采集），
//     并在取消或选中时以 Promise 结果回传给宿主。
// 不做：不直接操作 webview（executeJavaScript 由调用方负责），不补 workspacePath（宿主补齐），
//       不在脚本内 import 任何模块，也不引用 webElementPickerScript 之外的任何外层变量。
// 依赖：仅浏览器 Web API（DOM、CSSOM、Node、window）与 webElementContext 的纯类型（编译期擦除）。
// 边界：webElementPickerScript 会被 toString() 序列化后注入页面，函数体必须自包含；
//       本模块顶层的常量、类型、helper 在页面上下文里都不存在，脚本内只能使用参数与字面量。
//       运行期状态挂在 window[stateKey] 上，同一页面只允许一个活跃实例。
// 观测：脚本不写日志（页面上下文没有 logger），失败只通过 resolve 结果与元素文本表达，
//       所以每个「静默返回」的分支都必须有注释说明为什么不报错。
//
// INV 不变量表
// INV-01 断言：同一页面只允许一个拾取器实例，启动前必须 cancel 旧实例 —— 守住它的位置：stateKey 读取与 existing?.cancel?.() —— 改错故障：两个浮窗互相抢占 mousemove，遮罩残留。
// INV-02 断言：stateKey 字面量必须与 buildCancelWebElementPickerScript 完全一致 —— 守住它的位置：stateKey 常量 —— 改错故障：取消脚本找不到实例，Esc 无效且遮罩永久显示。
// INV-03 断言：Promise 必须且只能 resolve 一次（settled 短路） —— 守住它的位置：finish —— 改错故障：cleanup 二次执行，监听器与 window 状态错乱。
// INV-04 断言：cleanup 的 removeEventListener 参数必须与注册时完全一致（含 capture） —— 守住它的位置：cleanup 与 Promise executor —— 改错故障：监听器无法移除，页面持续拦截点击。
// INV-05 断言：点击必须 stopImmediatePropagation，不能只 stopPropagation —— 守住它的位置：handleClick 前两行 —— 改错故障：页面自身的捕获监听仍执行，触发真实导航。
// INV-06 断言：密码输入框文本必须固定返回掩码，绝不读取 value —— 守住它的位置：readElementText 的 password 分支 —— 改错故障：密码明文进入上下文载荷并被写入聊天。
// INV-07 断言：htmlExcerpt 必须 clone 后剥离 script/style 并删除 input 的 value —— 守住它的位置：getHtmlExcerpt —— 改错故障：页面脚本或用户输入值泄漏到模型上下文。
// INV-08 断言：attributes 必须是白名单且显式排除 value —— 守住它的位置：getAttributes —— 改错故障：token 或密码进入 attributes 字段。
// INV-09 断言：selector 必须有层数上限 8 且遇 id 早停 —— 守住它的位置：getSelector 循环 —— 改错故障：深层 DOM 下生成超长选择器，载荷膨胀且易失效。
// INV-10 断言：XPath 必须有层数上限 12 且保证以单个斜杠开头 —— 守住它的位置：getXPath 末尾 replace —— 改错故障：出现双斜杠，查询语义变为全文搜索。
// INV-11 断言：所有文本类字段必须经 truncate 归一空白并截断 —— 守住它的位置：各 collector —— 改错故障：多行文本破坏浮窗布局并放大载荷。
// INV-12 断言：overlay 与 label 必须 pointer-events:none 且 z-index 取最大值 —— 守住它的位置：两处 Object.assign —— 改错故障：拾取器挡住页面交互，或被子元素遮挡。
// INV-13 断言：hoveredElement 只能由 mousemove 更新，click 只读取 —— 守住它的位置：handleMouseMove 与 handleClick —— 改错故障：点击时重新命中会选中遮挡层而非用户看到的目标。
// INV-14 断言：目标是 overlay/label 或 label 的后代时必须隐藏浮窗 —— 守住它的位置：updateOverlay 首行守卫 —— 改错故障：浮窗自遮挡后反复刷新，产生闪烁。
// INV-15 断言：目标 rect 宽或高为 0 时必须隐藏浮窗 —— 守住它的位置：updateOverlay 第二守卫 —— 改错故障：零尺寸元素让浮窗贴到左上角。
// INV-16 断言：浮窗定位必须先试四个外侧候选，全部越界才退化为最大可用空间 —— 守住它的位置：getPopoverPosition —— 改错故障：元素贴边时浮窗盖住目标，用户看不到高亮。
// INV-17 断言：Escape 必须 preventDefault 且只响应 Escape —— 守住它的位置：handleKeyDown —— 改错故障：页面快捷键被吞或 Esc 无法取消。
// INV-18 断言：三个监听器必须全部使用捕获阶段 —— 守住它的位置：addEventListener 的第三个参数 —— 改错故障：页面 stopPropagation 后拾取器失效。
// INV-19 断言：脚本内禁止引用函数外的任何标识符 —— 守住它的位置：整个 webElementPickerScript 函数体 —— 改错故障：注入后 ReferenceError，拾取器完全不出现。
// INV-20 断言：注入串必须用 JSON.stringify 序列化 options，不能模板拼接 —— 守住它的位置：buildWebElementPickerScript 返回表达式 —— 改错故障：标签含引号时脚本语法错误。
// ============================================================================
import type {
  WebElementContextPayload,
  WebElementRect,
  WebElementStyleSummary,
} from "@/lib/webElementContext.js";

export type WebElementPickerScriptResult =
  | { status: "cancelled" }
  | { status: "selected"; element: Omit<WebElementContextPayload, "workspacePath"> };

interface WebElementPickerScriptOptions {
  maxTextChars: number;
  maxHtmlChars: number;
  maxAttributeChars: number;
  labels: WebElementPickerScriptLabels;
}

export interface WebElementPickerScriptLabels {
  background: string;
  color: string;
  font: string;
}

type WebElementPickerScriptBuildOptions = Partial<Omit<WebElementPickerScriptOptions, "labels">> & {
  labels?: Partial<WebElementPickerScriptLabels>;
};

const DEFAULT_OPTIONS: WebElementPickerScriptOptions = {
  maxTextChars: 4_000,
  maxHtmlChars: 6_000,
  maxAttributeChars: 500,
  labels: {
    background: "Background",
    color: "Color",
    font: "Font",
  },
};

function webElementPickerScript(options: WebElementPickerScriptOptions) {
  // [契约] stateKey 必须与 buildCancelWebElementPickerScript 里的字面量逐字一致：
  // 取消脚本是独立字符串，不共享常量，改一处不改另一处会让取消失效、遮罩常驻。
  //
  // [并发] 启动前 existing?.cancel?.() 是「单实例」保证：
  // 旧实例的 finish 会走 cleanup 并 resolve，随后新实例覆盖 window[key]。
  //
  // [资源] cancel 是唯一暴露给宿主的控制面，其他内部状态一律不出 window。
  // [边界] 这里用可选链而不是 if：页面可能残留第三方同名对象，不能假设其结构。
  const stateKey = "__zcodeWebElementPicker";
  const existing = (window as unknown as Record<string, { cancel?: () => void }>)[stateKey];
  existing?.cancel?.();

  // [契约] truncate 是所有进入载荷的字符串的唯一归一化入口：先压空白、再 trim、再截断。
  // 跳过它会引入换行与连续空格，浮窗布局被打散，模型上下文也被污染。
  //
  // [权衡] 超长时追加三点而不是省略号字符：载荷会进 JSON，ASCII 更稳；长度包含后缀。
  // [边界] 空值统一归一为空串，由调用方用 || undefined 决定是否写字段；
  // 这里不要返回 undefined，否则每个调用点都要各自判空。
  //
  // [失败路径] 正则中的 \s+ 不处理零宽字符，若页面出现零宽文本，选择器仍可能含不可见字符。
  const truncate = (value: string | null | undefined, maxLength: number) => {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  const clampColorChannel = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

  const toHexColor = (red: number, green: number, blue: number) =>
    `#${[red, green, blue]
      .map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;

  const parseAlpha = (value: string | undefined) => {
    if (!value) {
      return 1;
    }
    if (value.endsWith("%")) {
      return Number(value.slice(0, -1)) / 100;
    }
    return Number(value);
  };

  // [契约] 输出只允许 #RRGGBB、transparent、原样字符串三种形态，便于浮窗与模型消费。
  // parseAlpha 支持 0~1 与百分比两种 alpha，统一转 0~1 后再判定透明。
  //
  // [失败路径] 解析失败必须原样返回 normalized，不能返回空串：空串会让 readStyleSummary 误判为无色。
  // rgba 的三个通道任一缺失也走原样返回，避免把不完整颜色写进载荷。
  //
  // [权衡] alpha 为 0 返回 transparent 而不是 #RRGGBB：
  // 否则 hasVisibleBackground 会认为有背景色，浮窗多出一行噪声。
  // [边界] 只处理 rgb/rgba；lab() 等新语法原样透传，不做近似换算。
  // [资源] toHexColor 内做 0~255 夹取与两位补零，缺少补零会得到非法短格式。
  const formatComputedColor = (value: string) => {
    const normalized = value.trim();
    const match =
      /^rgba?\(\s*([0-9.]+)(?:,|\s)+([0-9.]+)(?:,|\s)+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/iu.exec(
        normalized,
      );
    if (!match) {
      return normalized;
    }

    const redValue = match[1];
    const greenValue = match[2];
    const blueValue = match[3];
    if (!redValue || !greenValue || !blueValue) {
      return normalized;
    }

    const red = Number(redValue);
    const green = Number(greenValue);
    const blue = Number(blueValue);
    const alpha = parseAlpha(match[4]);
    if ([red, green, blue, alpha].some((channel) => Number.isNaN(channel))) {
      return normalized;
    }
    if (alpha <= 0) {
      return "transparent";
    }

    return toHexColor(red, green, blue);
  };

  // [契约] 返回对象的字段集合是载荷契约：新增字段要同步 WebElementStyleSummary 类型。
  // backgroundColor 在透明时整个键省略，而不是写 transparent：
  // 下游用键是否存在判断是否展示背景行，写空值会让浮窗出现空白行。
  //
  // [权衡] fontFamily 截断到 160、formatFont 再截断到 96：两级截断分别服务于载荷与浮窗，
  // 不要合并成一个上限，浮窗需要更短的文本。
  //
  // [资源] getComputedStyle 每次调用都会触发样式解析，只在该元素被悬停时调用一次。
  const readStyleSummary = (element: Element): WebElementStyleSummary => {
    const style = window.getComputedStyle(element);
    const backgroundColor = formatComputedColor(style.backgroundColor);
    return {
      ...(backgroundColor !== "transparent" ? { backgroundColor } : {}),
      color: formatComputedColor(style.color),
      display: style.display,
      fontFamily: truncate(style.fontFamily, 160),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
    };
  };

  const formatFont = (style: WebElementStyleSummary) =>
    truncate([style.fontSize, style.fontFamily].filter(Boolean).join(" "), 96);

  const formatElementSize = (rect: DOMRect) =>
    `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  const hasVisibleBackground = (style: WebElementStyleSummary) =>
    Boolean(
      style.backgroundColor &&
      style.backgroundColor !== "transparent" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)",
    );

  const cssEscape = (value: string) => {
    const escape = (window.CSS as { escape?: (input: string) => string } | undefined)?.escape;
    if (escape) {
      return escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  // [契约] 密码输入框必须固定返回掩码文本，绝不读取 value：
  // 输入框的 innerText 为空，一旦为了更好识别去读 value，密码就会进入聊天上下文。
  //
  // [并发] input 优先取 aria-label、placeholder、name、type 四级回退，
  // 顺序不能改：placeholder 常变而 name 稳定，调换会让同一元素每次拾取得到不同文本。
  //
  // [失败路径] textarea 用同样四级回退并以 textarea 兜底，保证返回值永不为空。
  // [权衡] 普通元素优先 innerText 再 textContent：innerText 反映可见文本，
  // 但隐藏元素 innerText 为空，textContent 作为兜底避免载荷缺字段。
  //
  // [边界] 所有分支最终都经 truncate，长度上限来自 options.maxTextChars。
  // [资源] 这是唯一会读取用户输入相关 DOM 的函数，任何扩展都必须先过安全评审。
  const readElementText = (element: Element) => {
    if (element instanceof HTMLInputElement) {
      if (element.type.toLowerCase() === "password") {
        return "[masked password input]";
      }
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          element.type,
        options.maxTextChars,
      );
    }

    if (element instanceof HTMLTextAreaElement) {
      return truncate(
        element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.name ||
          "textarea",
        options.maxTextChars,
      );
    }

    return truncate(
      (element as HTMLElement).innerText || element.textContent,
      options.maxTextChars,
    );
  };

  const getImplicitRole = (element: Element) => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "img") return "img";
    if (tagName === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      return "textbox";
    }
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") return "combobox";
    if (tagName === "nav") return "navigation";
    if (tagName === "main") return "main";
    if (tagName === "form") return "form";
    if (/^h[1-6]$/u.test(tagName)) return "heading";
    return "";
  };

  // [契约] aria-labelledby 优先于 aria-label：前者是显式关联的可见标签，语义更强。
  // 多个 id 用空格分隔，逐个 getElementById 后拼接，缺失 id 贡献空串而不是中断。
  //
  // [失败路径] labelledby 解析结果为空时必须回退到 aria-label/alt/title/placeholder/文本，
  // 不能直接返回空串，否则载荷里 accessibleName 永远缺失。
  //
  // [边界] 结果同样经 truncate 归一；这里不递归计算子元素名称，避免无限深度与性能问题。
  const getAccessibleName = (element: Element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const normalizedLabel = truncate(label, options.maxTextChars);
      if (normalizedLabel) return normalizedLabel;
    }

    return truncate(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        readElementText(element),
      options.maxTextChars,
    );
  };

  // [契约] 属性是白名单：id/class/href/src/alt/title/name/type/placeholder 与 aria-*，
  // 不在名单内的属性一律丢弃，新增名单项需要评估是否可能携带凭据。
  //
  // [失败路径] 显式排除 value：input 的 value 可能是一次性 token 或密码，
  // 即使 type 不是 password 也不能进载荷。
  //
  // [权衡] aria-* 用前缀匹配而不是枚举：ARIA 规范持续扩展，枚举会静默漏字段；
  // 但 aria-* 的值同样经过 maxAttributeChars 截断。
  // [边界] name 统一小写，同一元素的大小写异构属性会合并成同一个键，这是刻意的归一。
  // [资源] 遍历 element.attributes 而不是 outerHTML 正则，避免吃进动态生成的伪属性。
  const getAttributes = (element: Element) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const allowed =
        name === "id" ||
        name === "class" ||
        name === "href" ||
        name === "src" ||
        name === "alt" ||
        name === "title" ||
        name === "name" ||
        name === "type" ||
        name === "placeholder" ||
        name.startsWith("aria-");
      if (!allowed || name === "value") {
        continue;
      }
      attributes[name] = truncate(attribute.value, options.maxAttributeChars);
    }
    return attributes;
  };

  // [契约] 有 id 时直接返回 #id 并早停：id 是最短且最稳定的定位方式。
  // [并发] 逐级向上最多 8 层，遇 id 立即终止：无上限会让深层 DOM 生成超长选择器，
  // 载荷膨胀且极易失效；8 层是「足够唯一」与「足够短」的折中。
  //
  // [权衡] 每层只取前 2 个 class：全量 class 会包含状态类（hover/active），
  // 拾取后立刻失效；取前两个在多数组件库中已能唯一定位。
  //
  // [失败路径] 同标签兄弟多于 1 时才追加 :nth-of-type，
  // 无条件追加会让选择器变得脆弱（插入兄弟节点即失效）。
  // [边界] getXPath 是同族实现但上限 12 层、不取 class；两者都不要引入 querySelector 校验，
  // 校验会在带副作用的页面上抛错或造成性能抖动。
  // [资源] cssEscape 优先用 CSS.escape，缺失时退化为正则转义，保证注入上下文可用。
  const getSelector = (element: Element) => {
    if (element.id) {
      return `#${cssEscape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      const tagName = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${tagName}#${cssEscape(current.id)}`);
        break;
      }

      const currentTagName = current.tagName;
      const classNames = Array.from(current.classList)
        .filter(Boolean)
        .slice(0, 2)
        .map((className) => `.${cssEscape(className)}`)
        .join("");
      let part = `${tagName}${classNames}`;
      const parentElement: Element | null = current.parentElement;
      if (parentElement) {
        const sameTagSiblings = Array.from(parentElement.children).filter(
          (sibling): sibling is Element =>
            sibling instanceof Element && sibling.tagName === currentTagName,
        );
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = parentElement;
    }

    return parts.join(" > ");
  };

  const getXPath = (element: Element) => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 12) {
      const tagName = current.tagName.toLowerCase();
      const currentTagName = current.tagName;
      const parentElement: Element | null = current.parentElement;
      if (!parentElement) {
        parts.unshift(`/${tagName}`);
        break;
      }
      const sameTagSiblings = Array.from(parentElement.children).filter(
        (sibling): sibling is Element =>
          sibling instanceof Element && sibling.tagName === currentTagName,
      );
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(`${tagName}[${index}]`);
      current = parentElement;
    }
    return `/${parts.join("/")}`.replace(/^\/\//u, "/");
  };

  const getNearbyText = (element: Element) => {
    const container =
      element.closest("article, section, main, form, li, tr, dialog") ||
      element.parentElement ||
      element;
    return truncate(
      (container as HTMLElement).innerText || container.textContent,
      options.maxTextChars,
    );
  };

  // [契约] 必须先 cloneNode 再剥离，绝不改原页面节点：
  // 直接操作真实 DOM 会触发页面自身的 MutationObserver 与框架重渲染。
  //
  // [失败路径] 剥离 script/style/noscript/template：这些节点的内容会随 outerHTML 一起被带出，
  // 既不安全也没有识别价值。
  // [并发] input 必须 removeAttribute value，password 类型保留 type 但清空值：
  // 任何情况下都不能把用户输入值写进 htmlExcerpt。
  //
  // [边界] textarea 的 textContent 也要清空，否则同样泄漏输入内容。
  // [资源] 最后一步才截断到 maxHtmlChars：先截断再剥离会切出半截标签。
  const getHtmlExcerpt = (element: Element) => {
    const clone = element.cloneNode(true);
    if (!(clone instanceof Element)) {
      return "";
    }
    clone.querySelectorAll("script, style, noscript, template").forEach((node) => {
      node.remove();
    });
    clone.querySelectorAll("input, textarea").forEach((node) => {
      if (node instanceof HTMLInputElement) {
        node.removeAttribute("value");
        if (node.type.toLowerCase() === "password") {
          node.setAttribute("type", "password");
        }
      }
      if (node instanceof HTMLTextAreaElement) {
        node.textContent = "";
      }
    });
    return truncate(clone.outerHTML, options.maxHtmlChars);
  };

  const rectToPlainObject = (rect: DOMRect): WebElementRect => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });

  // [契约] overlay 与 label 的样式必须成对维护：共享 z-index 2147483647 与 pointer-events:none。
  // pointer-events 一旦改成 auto，拾取器会挡住页面自身交互，且移出后不再触发 mousemove。
  //
  // [边界] boxShadow 的 9999px 扩散就是遮罩实现，不要换成独立遮罩节点——那会多一层需要清理的 DOM。
  // [资源] 两个节点在 cleanup 中都要 remove，缺一个会在页面上留下不可见但可命中的元素。
  const overlay = document.createElement("div");
  overlay.setAttribute("data-zcode-web-element-picker", "overlay");
  Object.assign(overlay.style, {
    background: "rgba(37, 99, 235, 0.12)",
    border: "2px solid #2563eb",
    borderRadius: "4px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
    boxSizing: "border-box",
    display: "none",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement("div");
  Object.assign(label.style, {
    backdropFilter: "blur(10px)",
    background: "rgba(17, 24, 39, 0.92)",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    borderRadius: "18px",
    boxShadow: "0 18px 38px rgba(15, 23, 42, 0.28)",
    boxSizing: "border-box",
    color: "#f9fafb",
    display: "none",
    font: "12px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    left: "0",
    maxWidth: "calc(100vw - 16px)",
    minWidth: "214px",
    padding: "12px 18px 14px",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "min(320px, calc(100vw - 16px))",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);

  document.documentElement.append(overlay, label);

  // [事务] settled 保证 finish 只执行一次：重复 resolve 本身无害，但 cleanup 会二次执行，
  // 监听器移除与 delete window[key] 的顺序会被打乱。
  // [并发] hoveredElement 只在 mousemove 更新，click 只读取：点击瞬间重新命中可能拿到遮挡节点，
  // 与用户看到的高亮框不一致。
  //
  // [资源] cleanup 的三次 removeEventListener 必须与注册时的 capture=true 完全一致，
  // 少传第三个参数会移除失败，页面持续拦截所有点击。
  //
  // [失败路径] cleanup 里先移除监听再移除节点，最后才 delete window[key]：
  // 顺序反了会让残留监听拿到已删除的实例。
  // [边界] cursor 恢复为空串而不是 default，避免覆盖页面自身的 cursor 样式。
  // [契约] cleanup 必须可从 cancel（宿主主动取消）与 finish 两条路径安全重入。
  let hoveredElement: Element | null = null;
  let settled = false;
  let finishPicker: ((result: WebElementPickerScriptResult) => void) | null = null;

  const cleanup = () => {
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    overlay.remove();
    label.remove();
    delete (window as unknown as Record<string, unknown>)[stateKey];
    document.documentElement.style.cursor = "";
  };

  const appendPopoverRow = (name: string, value: string | undefined) => {
    if (!value) {
      return;
    }

    const row = document.createElement("div");
    Object.assign(row.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr)",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const nameNode = document.createElement("span");
    nameNode.textContent = name;
    Object.assign(nameNode.style, {
      color: "rgba(255, 255, 255, 0.62)",
      fontSize: "15px",
      fontWeight: "600",
      minWidth: "0",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const valueNode = document.createElement("span");
    valueNode.textContent = value;
    Object.assign(valueNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "700",
      minWidth: "0",
      overflow: "hidden",
      textAlign: "right",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    row.append(nameNode, valueNode);
    label.append(row);
  };

  const renderPopover = (target: Element, rect: DOMRect) => {
    const style = readStyleSummary(target);
    label.replaceChildren();

    const header = document.createElement("div");
    Object.assign(header.style, {
      alignItems: "baseline",
      columnGap: "16px",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      minWidth: "0",
    } satisfies Partial<CSSStyleDeclaration>);

    const tagNode = document.createElement("span");
    tagNode.textContent = target.tagName.toLowerCase();
    Object.assign(tagNode.style, {
      color: "#ffffff",
      fontSize: "16px",
      fontWeight: "800",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    const sizeNode = document.createElement("span");
    sizeNode.textContent = formatElementSize(rect);
    Object.assign(sizeNode.style, {
      color: "#ffffff",
      fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
      fontSize: "15px",
      fontWeight: "800",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);

    header.append(tagNode, sizeNode);
    label.append(header);
    appendPopoverRow(options.labels.color, style.color);
    if (hasVisibleBackground(style)) {
      appendPopoverRow(options.labels.background, style.backgroundColor);
    }
    appendPopoverRow(options.labels.font, formatFont(style));
  };

  const clampPosition = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  // [权衡] 先尝试四方向外侧候选（下、上、右、左），全部越界才退化为可用空间最大：
  // 外侧候选能保证不遮挡目标，这是默认体验。
  //
  // [并发] clampPosition 对每个坐标单独夹取，保证浮窗永不超出视口；
  // labelWidth/labelHeight 用 offsetWidth 实测值，缺省 240/90 只用于首次布局尚未完成时。
  //
  // [失败路径] availableSpaces 排序后取第一个，数组为空时回退到左上 padding，
  // 不能返回 undefined——调用方会直接写 style。
  // [边界] padding 8 与 gap 12 是视觉常量，与 Tailwind 侧边距无关，不要合并。
  // [资源] 这里只计算坐标，不写 style：写入由 updateOverlay 统一完成，避免两次布局抖动。
  const getPopoverPosition = (rect: DOMRect, labelWidth: number, labelHeight: number) => {
    const padding = 8;
    const gap = 12;
    const maxLeft = Math.max(padding, window.innerWidth - labelWidth - padding);
    const maxTop = Math.max(padding, window.innerHeight - labelHeight - padding);
    const centeredLeft = rect.left + rect.width / 2 - labelWidth / 2;
    const centeredTop = rect.top + rect.height / 2 - labelHeight / 2;
    const candidates = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.bottom + gap,
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        top: rect.top - labelHeight - gap,
      },
      {
        left: rect.right + gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: rect.left - labelWidth - gap,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ];
    const viewportSafeCandidate = candidates.find(
      (candidate) =>
        candidate.left >= padding &&
        candidate.top >= padding &&
        candidate.left + labelWidth <= window.innerWidth - padding &&
        candidate.top + labelHeight <= window.innerHeight - padding,
    );

    if (viewportSafeCandidate) {
      return viewportSafeCandidate;
    }

    const availableSpaces = [
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: window.innerHeight - rect.bottom - padding,
        top: clampPosition(rect.bottom + gap, padding, maxTop),
      },
      {
        left: clampPosition(centeredLeft, padding, maxLeft),
        size: rect.top - padding,
        top: clampPosition(rect.top - labelHeight - gap, padding, maxTop),
      },
      {
        left: clampPosition(rect.right + gap, padding, maxLeft),
        size: window.innerWidth - rect.right - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
      {
        left: clampPosition(rect.left - labelWidth - gap, padding, maxLeft),
        size: rect.left - padding,
        top: clampPosition(centeredTop, padding, maxTop),
      },
    ].sort((a, b) => b.size - a.size);

    // 交互修正：目标元素靠近边缘或几乎铺满视口时，浮窗无法完全放到元素外侧。
    // 这时选择可用空间最大的方向，并继续夹在视口内，尽量减少对当前选区的遮挡。
    return availableSpaces[0] ?? { left: padding, top: padding };
  };

  // [契约] 首行守卫排除 overlay、label 以及 label 的后代：
  // 浮窗自身在鼠标下时会被当作目标，导致尺寸与位置反复跳动。
  //
  // [失败路径] rect 宽或高为 0 时隐藏而不是显示零尺寸框：
  // 零尺寸元素会让浮窗贴到视口左上角，用户以为拾取器卡死。
  //
  // [事务] 先设 display:block 再 renderPopover，最后才读 offsetWidth/offsetHeight：
  // display:none 时读到的都是 0，定位会退化成默认值。
  //
  // [边界] 这里只做样式同步，不触发任何采集逻辑，采集由 click 独占。
  const updateOverlay = (target: Element | null) => {
    if (!target || target === overlay || target === label || label.contains(target)) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      label.style.display = "none";
      return;
    }

    overlay.style.display = "block";
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    label.style.display = "block";
    renderPopover(target, rect);

    const labelWidth = label.offsetWidth || 240;
    const labelHeight = label.offsetHeight || 90;
    const position = getPopoverPosition(rect, labelWidth, labelHeight);
    label.style.left = `${position.left}px`;
    label.style.top = `${position.top}px`;
  };

  function handleMouseMove(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    hoveredElement = target;
    updateOverlay(target);
  }

  function collectElement(element: Element): Omit<WebElementContextPayload, "workspacePath"> {
    const rect = element.getBoundingClientRect();
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || getImplicitRole(element) || undefined,
      accessibleName: getAccessibleName(element) || undefined,
      selector: getSelector(element),
      xpath: getXPath(element),
      text: readElementText(element) || undefined,
      nearbyText: getNearbyText(element) || undefined,
      htmlExcerpt: getHtmlExcerpt(element) || undefined,
      attributes: getAttributes(element),
      rect: rectToPlainObject(rect),
      style: readStyleSummary(element),
      capturedAt: Date.now(),
    };
  }

  // [契约] 三个阻断必须按 preventDefault → stopPropagation → stopImmediatePropagation 顺序，
  // 最后一个才能阻止同一元素上其他捕获监听，少了它页面自身的点击处理仍会执行。
  // [失败路径] hoveredElement 为空时 resolve cancelled 而不是 selected：
  // 点击空白等价于取消：`resolvePickedElement` 返回 null，而不是产出空元素载荷。
  //
  // [事务] collectElement 必须在 finish 之前同步完成：finish 会 cleanup 并移除 DOM，
  // 之后再读 rect 只能拿到 0。
  // [边界] 这里不判断 rect 尺寸，零尺寸元素由 updateOverlay 负责不显示，点击仍可采集。
  function handleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!hoveredElement) {
      finishPicker?.({ status: "cancelled" });
      return;
    }
    finishPicker?.({
      status: "selected",
      element: collectElement(hoveredElement),
    });
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    finishPicker?.({ status: "cancelled" });
  }

  // [契约] executor 内先定义 finish，再赋值 finishPicker，最后才挂监听：
  // 顺序反了会让 handleClick 在 finishPicker 就绪前读到 null，点击被静默吞掉。
  //
  // [并发] finish 的 settled 短路在 cleanup 之前：cleanup 不可重入，重复执行会二次 remove 并 delete。
  // [失败路径] cancel 只暴露给宿主用于「关闭 webview / 切换页面」，
  // 它与 Esc、空白点击走同一条 finish 路径，不能有独立清理逻辑。
  //
  // [资源] 三个监听全部用 capture=true：页面 stopPropagation 后仍能收到事件，
  // 这是拾取器在任意站点可用的前提。
  // [边界] 光标在注册监听前设置，保证用户立刻看到 crosshair 反馈。
  return new Promise<WebElementPickerScriptResult>((resolve) => {
    const finish = (result: WebElementPickerScriptResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    finishPicker = finish;

    function cancel() {
      finish({ status: "cancelled" });
    }

    (window as unknown as Record<string, { cancel: () => void }>)[stateKey] = {
      cancel,
    };

    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
  });
}

// [契约] 注入串必须是「函数 toString 结果」加 JSON.stringify(options) 的形式：
// toString 保留函数体与注释，但会丢掉外层作用域，任何外部引用都会变成 ReferenceError。
// [失败路径] options 必须走 JSON.stringify：模板拼接在标签含引号或反斜杠时会产生语法错误，
// 且无法转义行分隔符。
//
// [权衡] 每次调用都重新 toString 并拼串，不做缓存：options 可能随语言切换变化，
// 缓存会让浮窗标签停留在旧语言。
// [边界] 函数体内不要依赖任何构建期降级假设，注入环境是 Electron 的 Chromium。
export function buildWebElementPickerScript(options: WebElementPickerScriptBuildOptions = {}) {
  const resolvedOptions = {
    ...DEFAULT_OPTIONS,
    ...options,
    labels: {
      ...DEFAULT_OPTIONS.labels,
      ...options.labels,
    },
  };
  return `(${webElementPickerScript.toString()})(${JSON.stringify(resolvedOptions)})`;
}

export function buildCancelWebElementPickerScript() {
  return [
    "(() => {",
    "const picker = window.__zcodeWebElementPicker;",
    "if (picker && typeof picker.cancel === 'function') picker.cancel();",
    "})()",
  ].join("\n");
}
