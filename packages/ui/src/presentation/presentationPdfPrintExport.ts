// 演示文稿打印导出：把 PresentationPreviewDocument 全部页渲染进同文档的隐藏打印容器，供 printToPDF 以 print 媒体输出。
// 同时把屏幕预览依赖的隐式字体回退改写成确定字体栈，避免 Skia 打印管线丢字。
// 不负责幻灯片绘制与分页（由 preview 的 renderPage 承担），也不负责触发打印、写文件、进度上报与重试。
//
// 不变量清单（打印 DOM、字体可用性与渲染生命周期）：
// INV-01 断言：隐藏样式只作用于带宿主属性的元素，绝不隐藏页面其他内容 —— 守住它的位置：buildPrintCss 的 screen 块 —— 改错故障：宿主页面整体不可见或导出空白
// INV-02 断言：屏幕态容器必须真实绘制，只能位移到屏外而不能隐藏 —— 守住它的位置：buildPrintCss 的 transform 声明 —— 改错故障：canvas 与 img 不绘制，PDF 里图表全空
// INV-03 断言：打印态宿主必须铺平且 html 与 body 高度改为自动 —— 守住它的位置：buildPrintCss 的 print 块 —— 改错故障：内容每页重复或尾部多出空白页
// INV-04 断言：每页尺寸等于文稿页尺寸，且除末页外都强制分页 —— 守住它的位置：页属性规则与末子元素覆盖 —— 改错故障：页数与文稿不符、末页夹带空白
// INV-05 断言：字体改写只动内联字体字段，不动任何其他样式 —— 守住它的位置：materializePrintableFontFamilies 赋值处 —— 改错故障：打印版与预览版字号行高不一致
// INV-06 断言：解析字体栈必须尊重引号与转义，逗号只在引号外分隔 —— 守住它的位置：parseFontFamilies 的字符状态机 —— 改错故障：带逗号的 family 被拆断，选中不存在的字体
// INV-07 断言：通用族名永不被判定为缺失 —— 守住它的位置：resolvePrintableFontFamily 的可用性包装 —— 改错故障：本可兜底的字体栈被再次替换成错误候选
// INV-08 断言：已知不可打印的 family 一律视为不可用 —— 守住它的位置：isKnownPrintUnsafeFontFamily 与不安全字体集合 —— 改错故障：macOS 上中文正文在 PDF 中整段消失
// INV-09 断言：macOS 上被系统替换的 Windows 中文字体必须判为不可用 —— 守住它的位置：createCanvasFontAvailability 的替换名单分支 —— 改错故障：量宽通过但打印仍丢字
// INV-10 断言：中文文本探测字体可用性时改用拉丁样本量宽 —— 守住它的位置：detectionScript 的三元选择 —— 改错故障：隐式中文回退被当成已安装，选中缺字字体
// INV-11 断言：首选字体可用时返回空值且不写内联样式 —— 守住它的位置：resolvePrintableFontFamily 的首个提前返回 —— 改错故障：预览与打印字体漂移、无谓的样式污染
// INV-12 断言：重建的字体栈只能取确实可用的连续后缀 —— 守住它的位置：可用下标与切片处 —— 改错故障：失效字体仍排首位，打印再次回到丢字路径
// INV-13 断言：字体栈最终必须带一个通用族名兜底 —— 守住它的位置：appendGenericFallback —— 改错故障：全部候选缺失时文字退化成浏览器默认而非预期字形
// INV-14 断言：可用性结果按 family 与探测脚本缓存，同一轮内不重复量宽 —— 守住它的位置：createCanvasFontAvailability 的缓存表 —— 改错故障：长文稿导出时逐元素量宽导致打印卡死
// INV-15 断言：文本节点按父元素聚合后再判定字体，不逐节点各自改写 —— 守住它的位置：按父元素聚合的映射表 —— 改错故障：同一段文字被不同脚本判定，出现混排字体
// INV-16 断言：必须逐页全量渲染，不能沿用预览的懒渲染 —— 守住它的位置：renderPresentationToPrintHost 的页循环 —— 改错故障：导出的 PDF 只含已滚动过的页
// INV-17 断言：每页就绪必须顺序等待，不能一次性全部摊开 —— 守住它的位置：循环内的就绪等待 —— 改错故障：媒体解码内存峰值翻倍甚至内存耗尽
// INV-18 断言：清理必须幂等，重复调用只清理一次 —— 守住它的位置：已释放标志 —— 改错故障：二次释放渲染句柄抛错并打断打印流程
// INV-19 断言：清理必须倒序释放句柄，并同时移除容器与样式 —— 守住它的位置：清理函数的反向循环 —— 改错故障：残留 DOM 与样式污染后续导出和主界面
// INV-20 断言：导出函数抛出前必须自行清理 —— 守住它的位置：catch 分支 —— 改错故障：失败的半成品容器留在页面上并持续抢占绘制资源
import type {
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";

export interface PresentationPrintHost {
  dispose(): void;
}

// [契约] 三个 data-* 属性是样式与脚本之间的唯一握手：样式只认属性选择器，脚本只负责打属性。
// 改动属性字符串会让 buildPrintCss 的规则整体失效，症状是隐藏容器出现在可见区域或打印样式完全不生效。
// 这里刻意不用 class，因为宿主页面可能有全局 class 样式覆盖，带 zcode 前缀的属性名更可控。
// [权衡] 属性值保持空串即可，不写具体值，避免与其他业务属性值冲突并减少 DOM 差异。
const HOST_ATTRIBUTE = "data-zcode-pptx-print-host";
const PAGE_ATTRIBUTE = "data-zcode-pptx-print-page";
const STYLE_ATTRIBUTE = "data-zcode-pptx-print-style";

/** 单图解码失败不阻塞导出（预览同样会失败），整体解码等待设上限 */
// [资源] 图片解码只做尽量等待，单张损坏图不应阻塞整份导出，故上限设为 10 秒。
// 超时后不抛错，直接继续进入打印，缺图在 PDF 里是空白位，与预览侧的失败表现保持一致。
// 把上限调得很小会让大图文稿截到未解码帧，调得过大则用户感知为导出无响应。
// [失败路径] 这里的超时是明确放弃等待，不是吞错，不要再在调用处补一层重试。
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

export type PrintableFontScript = "latin" | "cjk" | "symbol";
export type PrintableFontAvailability = (family: string, script: PrintableFontScript) => boolean;

const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "emoji",
  "math",
  "fangsong",
]);

// 量宽探测的样本必须覆盖目标脚本的代表字形，否则字体是否存在会量出近似宽度而误判。
// 拉丁样本刻意混入窄字符、宽字符和数字，避免等宽或窄体字体在单一字符上量出相同结果。
// SYMBOL_PROBE 只取箭头与星形等常用符号，字体缺失时的回退字形与原字形宽度差异明显。
// [权衡] 样本只求可判、不求全字符覆盖，调整样本前先用真实的缺字案例回归。
const FONT_DETECTION_SAMPLES: Record<PrintableFontScript, string> = {
  latin: "mmmmmmmmmwwwwwwwiiiiiiiii 0123456789 ABCDEFG",
  cjk: "汉字排版测试かなカナ한글漢字",
  symbol: "◆▶▥✦★☻♪—“”",
};

// [契约] PRINT_LOSSY_FONTS 只收屏幕能画却在打印时丢字的字体，普通缺失交由可用性探测处理。
// 注释中的 m146 是实测版本，升级打印管线后必须重新验证再考虑删除条目。
// 判定统一在可用性包装里执行，新增调用点不要绕过它直接查询集合。
// [权衡] 名单硬编码而非做成配置：条目与平台、打包器版本强绑定，暴露成配置只会让线上表现不可复现。
// Skia/PDF m146 在 macOS 上可用 PingFang 做屏幕绘制，但不会把对应 glyph run 写入 PDF。
const PRINT_UNSAFE_FONT_FAMILIES = new Set(["pingfang sc"]);

// 中文字体回退链按 macOS、Windows、开源、通用族的顺序排列，顺序即优先级，不能随意重排。
// 字体名必须是系统真实注册名，两种宋体写法是两个条目，写错等于该候选永远探测失败。
// 末尾的 sans-serif 是最后兜底，即使兜底函数会补，也不要在维护时删掉。
// [权衡] 不回退到 PingFang SC，即便它在 macOS 上量宽可用，因为打印仍会丢字形。
const CJK_SANS_FALLBACKS = [
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Arial Unicode MS",
  "sans-serif",
];
const CJK_SERIF_FALLBACKS = [
  "Songti SC",
  "STSong",
  "SimSun",
  "Noto Serif CJK SC",
  "Source Han Serif SC",
  "serif",
];
const LATIN_SANS_FALLBACKS = ["Arial", "Helvetica", "system-ui", "sans-serif"];
const LATIN_NARROW_FALLBACKS = ["Arial Narrow", "Arial", "Helvetica", "sans-serif"];
const LATIN_SERIF_FALLBACKS = ["Times New Roman", "Times", "Georgia", "serif"];
const MONOSPACE_FALLBACKS = ["Courier New", "Menlo", "Consolas", "monospace"];
const SYMBOL_FALLBACKS = [
  "Apple Symbols",
  "Segoe UI Symbol",
  "Noto Sans Symbols 2",
  "Arial Unicode MS",
  "sans-serif",
];

// 去首尾空白与剥离成对引号，是后续集合查表与缓存的共同前提，所有比较都走这一个入口。
// 正则只剥最外层成对引号，不做反斜杠反转义，嵌套引号的 family 名本就非法，无需兼容。
// 这里不调 toLowerCase，写回样式时需要保留原始大小写，归一由各自比较处负责。
function normalizeFontFamily(family: string): string {
  return family
    .trim()
    .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")
    .trim();
}

// [契约] 字体栈必须自己走状态机，不能按逗号直接切分：family 名内部合法地包含逗号。
// 引号与转义两个状态位缺一不可，反斜杠转义在引号内外都要生效。
// 空片段由收尾函数过滤，不要返回空字符串占位，否则后续会拿空字体名去探测。
// [权衡] 这里只解析不校验，非法 family 由可用性探测判负，避免解析与探测两处规则不一致。
function parseFontFamilies(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const pushCurrent = () => {
    const family = normalizeFontFamily(current);
    if (family) {
      families.push(family);
    }
    current = "";
  };

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    // 处于引号内时逗号与空白都只是字面内容，继续累积直到遇到同种引号才退出。
    // 引号状态用单个变量保存，遇到另一种引号不切换，这是字体栈语法要求而非实现疏漏。
    // 在该分支内做去空白或去引号会破坏原始字符串，剥引号只在归一化函数里做。
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      pushCurrent();
      continue;
    }
    current += character;
  }
  pushCurrent();
  return families;
}

// 输出侧统一格式化：通用族名强制小写，其余按是否含空格或引号决定是否加双引号。
// 转义顺序必须是先反斜杠后双引号，顺序反了会把字体名里的反斜杠整个吃掉。
// 不要在这里做可用性判断，该函数也被量宽探测复用，混入判断会形成递归依赖。
function formatFontFamily(family: string): string {
  const normalized = normalizeFontFamily(family);
  if (GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())) {
    return normalized.toLowerCase();
  }
  return /[\s,"']/.test(normalized)
    ? `"${normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    : normalized;
}

// 判定粒度是元素内聚合后的全部文本：先看是否含中文等方块字，再看是否有字母数字，否则算符号。
// 中文判定使用 Unicode 脚本属性而非码点区间，避免漏掉假名与谚文。
// isChineseLike 对混少量英文的文本仍判为中文，因为决定覆盖范围的是中文字形。
// 纯标点与表情走 symbol 分支，这条结果直接决定后面选哪条回退链。
function detectFontScript(text: string): PrintableFontScript {
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)) {
    return "cjk";
  }
  return /[\p{L}\p{N}]/u.test(text) ? "latin" : "symbol";
}

function isGenericFontFamily(family: string): boolean {
  return GENERIC_FONT_FAMILIES.has(normalizeFontFamily(family).toLowerCase());
}

function isKnownPrintUnsafeFontFamily(family: string): boolean {
  return PRINT_UNSAFE_FONT_FAMILIES.has(normalizeFontFamily(family).toLowerCase());
}

// 分类只看 family 名称里的关键词，不加载字体，属于启发式判断而非精确匹配。
// 等宽先于窄体与衬线判定：等宽字体名里常同时出现衬线字样，顺序反了会归错类。
// 衬线分支额外排除含无衬线字样的名称，否则 Noto Sans 之类会被误判成衬线。
// 未命中的一律归为无衬线，宁可回退到无衬线链，也不落到字形差异更大的衬线链。
function classifyFontFamily(families: readonly string[]): "sans" | "narrow" | "serif" | "mono" {
  const joined = families.join(" ").toLowerCase();
  if (/mono|courier|consolas|menlo/.test(joined)) {
    return "mono";
  }
  if (/narrow|condensed|oswald|bebas/.test(joined)) {
    return "narrow";
  }
  if (
    !/sans/.test(joined) &&
    /serif|times|georgia|song|simsun|宋体|ming|mincho|playfair/.test(joined)
  ) {
    return "serif";
  }
  return "sans";
}

// 回退链由脚本与字族分类两个维度决定，符号脚本优先级最高，不看字族。
// fontFamilyForChinese 只区分 serif 与 sans-serif，窄体与等宽直接并入无衬线链。
// 拉丁文本才细分等宽、衬线、窄体，改这张映射前先确认目标平台确有对应字体。
function getFallbackFamilies(
  script: PrintableFontScript,
  category: ReturnType<typeof classifyFontFamily>,
): readonly string[] {
  if (script === "symbol") {
    return SYMBOL_FALLBACKS;
  }
  if (script === "cjk") {
    return category === "serif" ? CJK_SERIF_FALLBACKS : CJK_SANS_FALLBACKS;
  }
  if (category === "mono") {
    return MONOSPACE_FALLBACKS;
  }
  if (category === "serif") {
    return LATIN_SERIF_FALLBACKS;
  }
  return category === "narrow" ? LATIN_NARROW_FALLBACKS : LATIN_SANS_FALLBACKS;
}

function appendGenericFallback(
  families: readonly string[],
  category: ReturnType<typeof classifyFontFamily>,
): string[] {
  if (families.some(isGenericFontFamily)) {
    return [...families];
  }
  return [
    ...families,
    category === "mono" ? "monospace" : category === "serif" ? "serif" : "sans-serif",
  ];
}

/**
 * 返回需要写入打印 DOM 的确定性字体栈；null 表示原首选字体已经可用，无需改动。
 */
// [契约] 返回值语义二选一：空值表示无需改动，字符串表示要写回的完整字体栈，绝不返回空串。
// 首个候选可用就直接放弃改写，这是不打扰预览的核心，该判断必须在构造新栈之前。
// 首选失效时才重建栈，且新栈从第一个可用候选开始，前面已失效的 family 必须丢弃。
// [失败路径] 回退链全部不可用时取最后一项，保证至少输出一个通用族名而不是空栈。
export function resolvePrintableFontFamily(
  fontFamily: string,
  text: string,
  isFontAvailable: PrintableFontAvailability,
): string | null {
  const families = parseFontFamilies(fontFamily);
  if (families.length === 0) {
    return null;
  }
  const script = detectFontScript(text);
  const category = classifyFontFamily(families);
  // 局部包装 isFontAvailableForPrint 把通用族名视为可用，把丢字字体视为不可用。
  // 通用族名不参与 measureText 量宽，因为它由浏览器决定具体字体，探测结果没有意义。
  // 丢字黑名单必须在这里短路，否则 macOS 上 PingFang 会因量宽通过而被原样保留。
  const isAvailable = (family: string) =>
    isGenericFontFamily(family) ||
    (!isKnownPrintUnsafeFontFamily(family) && isFontAvailable(family, script));

  if (isAvailable(families[0]!)) {
    return null;
  }
  const availableIndex = families.findIndex(isAvailable);
  if (availableIndex >= 0) {
    return appendGenericFallback(families.slice(availableIndex), category)
      .map(formatFontFamily)
      .join(", ");
  }

  const fallbacks = getFallbackFamilies(script, category);
  const fallbackIndex = fallbacks.findIndex(isAvailable);
  const selected = fallbackIndex >= 0 ? fallbacks.slice(fallbackIndex) : fallbacks.slice(-1);
  return selected.map(formatFontFamily).join(", ");
}

// 每次导出新建一个离屏 canvas 与二维上下文，量宽不依赖布局，不插入 DOM 也能测。
// 拿不到默认视图或二维上下文时统一返回全部不可用，让导出走回退链而不是抛错。
// [资源] canvas 不插入文档，导出结束由垃圾回收处理，这里不做显式释放。
function createCanvasFontAvailability(hostDocument: Document): PrintableFontAvailability {
  if (typeof hostDocument.defaultView?.CanvasRenderingContext2D !== "function") {
    return () => false;
  }
  const canvas = hostDocument.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return () => false;
  }
  const isMacOS = /Mac/i.test(hostDocument.defaultView?.navigator.platform ?? "");
  const macOSSubstitutedWindowsFonts = new Set([
    "microsoft yahei",
    "microsoft yahei ui",
    "微软雅黑",
    "dengxian",
    "等线",
    "simhei",
    "黑体",
    "heiti sc",
  ]);
  const cache = new Map<string, boolean>();
  // 返回的闭包持有 canvas 上下文与缓存，同一次导出内的多次调用共享测量结果。
  // 闭包内不得异步：量宽必须同步完成，否则字体改写在等待边界之后才生效，被打印管线抢先。
  // 该函数只回答这个 family 能否打印，不负责挑选替代字体，选链交给上层。
  return (family, script) => {
    // CoreText 会把未安装的 Windows CJK family 别名替换成 macOS 字体，Canvas 量宽无法区分；
    // 继续保留原 family 会让 Skia 打印再次丢字，因此 macOS 直接交给可打印 CJK fallback。
    if (isMacOS && macOSSubstitutedWindowsFonts.has(normalizeFontFamily(family).toLowerCase())) {
      return false;
    }
    // CJK 字体缺失时浏览器会继续落到另一个 CJK 系统字体；用 CJK 样本文字量宽会把这次隐式回退
    // 误判为候选字体已安装。常见 CJK 字体都包含 Latin glyph，用 Latin 样本才能识别具体 family。
    const detectionScript = script === "cjk" ? "latin" : script;
    const key = `${family}\u0000${detectionScript}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const sample = FONT_DETECTION_SAMPLES[detectionScript];
    const candidate = formatFontFamily(family);
    const available = ["monospace", "serif", "sans-serif"].some((baseline) => {
      context.font = `72px ${baseline}`;
      const baselineWidth = context.measureText(sample).width;
      context.font = `72px ${candidate}, ${baseline}`;
      return Math.abs(context.measureText(sample).width - baselineWidth) > 0.01;
    });
    cache.set(key, available);
    return available;
  };
}

/**
 * 屏幕预览允许未安装字体走隐式 fallback，但 Chromium/Skia 打印不会稳定保留这层回退，
 * 导致对应文字没有写入 PDF。这里只改一次性打印 DOM，把真实可用字体提升到字体栈首位。
 */
// 处理顺序是先聚合文本再按元素改写，保证同一元素的多个文本节点用同一套字体判定。
// 只读计算样式的字体字段，其他排版属性一律不碰，避免打印版与预览版布局分叉。
// 元素若只有内联字体而无计算样式，回落到内联值，覆盖离线渲染等拿不到样式的场景。
// [权衡] 直接写内联字体覆盖样式表，但该 DOM 一次导出后即销毁，不会污染预览。
export function materializePrintableFontFamilies(
  hostDocument: Document,
  host: HTMLElement,
  isFontAvailable: PrintableFontAvailability = createCanvasFontAvailability(hostDocument),
): void {
  const showText = hostDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = hostDocument.createTreeWalker(host, showText);
  const textByParent = new Map<HTMLElement, string>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const parent = node.parentElement;
    if (!text || !parent) {
      continue;
    }
    textByParent.set(parent, `${textByParent.get(parent) ?? ""}${text}`);
  }

  const view = hostDocument.defaultView;
  for (const [element, text] of textByParent) {
    const fontFamily = view?.getComputedStyle(element).fontFamily || element.style.fontFamily;
    if (!fontFamily) {
      continue;
    }
    const printableFontFamily = resolvePrintableFontFamily(fontFamily, text, isFontAvailable);
    if (printableFontFamily) {
      element.style.fontFamily = printableFontFamily;
    }
  }
}

function formatCssPx(value: number): string {
  return `${Number(value.toFixed(2))}px`;
}

// [契约] PRINT_STYLE 固定打印管线的全部约定，每页按固定尺寸铺平且末页不分页。
// 所有选择器都挂在 data 属性上，绝不使用标签或类选择器，防止影响宿主页面。
// 页码尺寸同时写进页面规则与页块尺寸，两者不一致会出现缩放或页边空白。
function buildPrintCss(pageSize: { width: number; height: number }): string {
  const width = formatCssPx(pageSize.width);
  const height = formatCssPx(pageSize.height);
  // screen 下不能用 display:none / visibility:hidden——canvas、img 需要真实绘制才能进入打印输出。
  // print 下 fixed 元素会在每一页重复，必须反转为 static；html/body 的 height:100% 会撑出尾部空白页。
  // 幻灯片内部元素的轻微溢出会露出原生滚动条并被画进 PDF，整体隐藏。
  return `
[${HOST_ATTRIBUTE}] * {
  scrollbar-width: none;
}
[${HOST_ATTRIBUTE}] *::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
@media screen {
  [${HOST_ATTRIBUTE}] {
    position: fixed;
    top: 0;
    left: 0;
    z-index: -1;
    transform: translateX(-200vw);
    pointer-events: none;
  }
}
@media print {
  body > :not([${HOST_ATTRIBUTE}]) {
    display: none !important;
  }
  [${HOST_ATTRIBUTE}] {
    position: static !important;
    transform: none !important;
  }
  html,
  body {
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  @page {
    size: ${width} ${height};
    margin: 0;
  }
  [${PAGE_ATTRIBUTE}] {
    width: ${width};
    height: ${height};
    position: relative;
    overflow: hidden;
    break-after: page;
  }
  [${PAGE_ATTRIBUTE}]:last-child {
    break-after: auto;
  }
}
`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// 等待顺序固定：字体就绪、改写字体、再次等字体、等图片解码、再等两帧，不能并行合并。
// 字体改写可能命中 document.fonts 新注册的网络字体，第二次就绪等待不可省略。
// 两帧等待是给 canvas 与图表留首帧绘制窗口，少等一帧就会截到未绘制状态。
async function waitForPrintReady(hostDocument: Document, host: HTMLElement): Promise<void> {
  // 全部页渲染完成后再等字体，保证渲染过程中新触发的字体加载都计入
  await hostDocument.fonts?.ready;
  materializePrintableFontFamilies(hostDocument, host);
  // 字体替换可能命中新注册的 web font；再次等待后才能交给打印管线。
  await hostDocument.fonts?.ready;
  const decodes = Array.from(host.querySelectorAll("img"), (image) =>
    typeof image.decode === "function" ? image.decode().catch(() => undefined) : undefined,
  ).filter((pending): pending is Promise<void> => pending !== undefined);
  if (decodes.length > 0) {
    await Promise.race([
      Promise.all(decodes),
      new Promise((resolve) => setTimeout(resolve, IMAGE_DECODE_TIMEOUT_MS)),
    ]);
  }
  // 给 canvas/图表首帧绘制留渲染窗口
  await nextFrame();
  await nextFrame();
}

/**
 * 把演示文稿的全部页面渲染进同页面的隐藏打印容器，供 printToPDF 以 print 媒体输出。
 * 预览是 lazySlides 懒渲染，这里必须全量逐页渲染，导出的 PDF 才包含所有页。
 */
// [契约] 返回句柄只暴露清理方法，调用方必须在打印结束后主动调用，函数自身不自动清理。
// 样式先于容器插入，保证容器第一次绘制就带隐藏规则，避免闪出可见的幻灯片。
// 宿主元素设置无障碍隐藏与 inert，既避免读屏读到导出内容，也阻止其获得焦点。
export async function renderPresentationToPrintHost(
  doc: PresentationPreviewDocument,
  hostDocument: Document,
): Promise<PresentationPrintHost> {
  const style = hostDocument.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = buildPrintCss(doc.pageSize);

  const host = hostDocument.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");

  const handles: PresentationRenderHandle[] = [];
  let disposed = false;
  // [资源] 释放顺序固定：先释放渲染句柄再移除 DOM，反过来会让句柄在已脱离的节点上收尾。
  // 句柄数组倒序释放，对齐创建顺序，后创建的媒体先释放。
  // 重复调用只生效一次，正常路径与失败路径都会调用它。
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (let index = handles.length - 1; index >= 0; index -= 1) {
      handles[index]?.dispose();
    }
    host.remove();
    style.remove();
  };

  try {
    hostDocument.head.append(style);
    hostDocument.body.append(host);
    for (let pageIndex = 0; pageIndex < doc.pageCount; pageIndex += 1) {
      const page = hostDocument.createElement("div");
      page.setAttribute(PAGE_ATTRIBUTE, "");
      host.append(page);
      const handle = doc.renderPage(pageIndex, page);
      handles.push(handle);
      // 顺序 await：摊平媒体解码内存峰值；document 中途被 dispose 时尽快抛错终止
      await handle.ready;
    }
    await waitForPrintReady(hostDocument, host);
    return { dispose };
  // [失败路径] 任一页渲染或就绪等待抛错都必须先清场再抛出，否则半成品容器会留在宿主页面。
  // 这里不吞错也不包装错误，调用方需要原始异常区分渲染失败与打印管线失败。
  // 清理函数已在 try 之前定义，直接调用即可，不要在 catch 里另写一套清理逻辑。
  } catch (error) {
    dispose();
    throw error;
  }
}
