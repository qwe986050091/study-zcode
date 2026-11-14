// Web 元素上下文的纯数据层：定义浏览器「添加到对话」的事件名、载荷类型与运行时校验。
// 同时负责把载荷序列化成 Markdown 块，以及从历史 prompt 文本里反解析回载荷。
// 不负责：DOM 拾取、样式计算、跨窗口路由、持久化与去重，这些都在调用方完成。
//
// INV-01 断言：两个事件名必须保持 zcode: 前缀与现有拼写不变 —— 守住它的位置：文件顶部两个事件常量 —— 改错故障：已注册的监听全部失配，点击「添加到对话」无任何反应。
// INV-02 断言：身份 key 恒为 workspaceIdentity 去空白后优先、否则回落 workspacePath —— 守住它的位置：getWebElementContextWorkspaceKey —— 改错故障：远程工作区的元素串进本地同路径会话的列表。
// INV-03 断言：载荷校验只认 workspacePath、pageUrl、pageTitle、tagName、capturedAt 五个必填字段 —— 守住它的位置：isWebElementContextPayload —— 改错故障：扩展少传可选字段时整条上下文被误判丢弃。
// INV-04 断言：判型必须先确认是非 null 的对象再读字段 —— 守住它的位置：isWebElementContextPayload 前两个条件 —— 改错故障：null 载荷先抛 TypeError，事件回调整条中断。
// INV-05 断言：空值字段整行省略，不输出空标签 —— 守住它的位置：appendOptionalLine —— 改错故障：解析侧读到空串并回填空字段，界面出现空样式行。
// INV-06 断言：单字段渲染上限 8000 字符且截断要带 [truncated] 标记 —— 守住它的位置：truncateMarkdownValue —— 改错故障：超长 HTML 撑爆上下文预算，模型误读为完整内容。
// INV-07 断言：标题行的 "## Element" 与带序号写法必须与解析正则配对 —— 守住它的位置：buildWebElementContextMarkdown 与 parsePromptWebElementContexts —— 改错故障：历史消息里的元素块重载后消失。
// INV-08 断言：元素切分只按 "## Element" 标题行，不按空行 —— 守住它的位置：parsePromptWebElementContexts 的 split 正则 —— 改错故障：正文含空行时一个元素被拆成多条。
// INV-09 断言：解析失败必须原样返回用户正文且上下文为空 —— 守住它的位置：parsePromptWebElementContexts 的三处早退 —— 改错故障：用户粘贴内容在重载后丢失。
// INV-10 断言：解析出的 id 必须带序号保证同一 prompt 内唯一 —— 守住它的位置：parseElementItem 的 id 字段 —— 改错故障：列表 key 冲突，删除时删掉另一条。
// INV-11 断言：解析出的 capturedAt 固定为 0 —— 守住它的位置：parseElementItem —— 改错故障：历史项显示成解析时刻而非捕获时刻。
// INV-12 断言：占位标题 (untitled) 必须在解析时还原为空串 —— 守住它的位置：parseElementItem 的 pageTitle —— 改错故障：界面出现字面量 (untitled)。
// INV-13 断言：字体摘要解析必须容忍只有字体族没有字号 —— 守住它的位置：parseFontSummary —— 改错故障：font 字段被丢弃，样式摘要空白。
// INV-14 断言：事件 detail 必须是对象，判型只看 type 与 detail —— 守住它的位置：两个 is...Event 与两个 dispatch —— 改错故障：监听到但判型失败，消息静默不入列。
// INV-15 断言：派发不得改写或补全 payload —— 守住它的位置：两个 dispatch 函数 —— 改错故障：调用方后续比对原对象时出现不一致。
// INV-16 断言：序列化与解析的字段标签必须逐字一致 —— 守住它的位置：buildWebElementContextMarkdown 与 readField、readFencedSection —— 改错故障：改名后旧消息字段读不回来。
//
// 编码与解析是同一份协议的两端：改序列化格式时必须同步解析正则，并为旧消息补兼容用例。
//
export const WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT = "zcode:web-element-context-add-to-chat";
export const WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT =
  "zcode:web-element-context-remove-from-chat";

const WEB_ELEMENT_CONTEXT_BLOCK_TITLE = "# Web page elements:";
// [契约] 8000 字符上限只作用于 Markdown 渲染阶段，原始载荷不做裁剪。
// 若把截断提前到派发处，界面上展开的完整 HTML 会丢失，用户再也看不到原始片段。
// 块标题常量与解析正则里的 "# Web page elements:" 是同一个协议字面量，改一处必须同步另一处。
// [权衡] 上限按字符数而非字节数，中文页面同样字符数下渲染体积更大，但至少不会因编码差异截断半个字。
const MAX_MARKDOWN_FIELD_LENGTH = 8_000;

export interface WebElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebElementStyleSummary {
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  display?: string;
}

// [契约] 除 workspacePath、pageUrl、pageTitle、tagName、capturedAt 外全部可选。
// 扩展版本或页面差异会缺字段，缺省字段必须让整条上下文依然可用，而不是被丢弃或渲染成 undefined。
// 不要为了「类型干净」把可选字段改成必填，那会让旧扩展的载荷全部过不了运行时校验。
export interface WebElementContextPayload {
  id?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  pageUrl: string;
  pageTitle: string;
  tagName: string;
  role?: string;
  accessibleName?: string;
  selector?: string;
  xpath?: string;
  text?: string;
  nearbyText?: string;
  htmlExcerpt?: string;
  attributes?: Record<string, string>;
  rect?: WebElementRect;
  style?: WebElementStyleSummary;
  capturedAt: number;
}

// [契约] 附件在载荷之上只加固 id，这个 id 同时用于删除事件与列表 key。
// 生成侧用随机 UUID，解析侧用序号派生，两套都不能退化成可能重复的值。
// 把 id 挪进父接口会污染外部载荷契约，扩展不一定有能力提供稳定 id。
export interface WebElementContextComposerAttachment extends WebElementContextPayload {
  id: string;
}

interface ParsedWebElementContextPrompt {
  visibleContent: string;
  webElementContexts: WebElementContextComposerAttachment[];
}

type WebElementContextAddToChatEvent = CustomEvent<WebElementContextPayload>;
type WebElementContextRemoveFromChatEvent = CustomEvent<{
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}>;

// [权衡] 优先 crypto.randomUUID，仅在 crypto 缺失或不支持时退化为时间戳加随机后缀。
// 不要改成自增计数：同一页面可能被多个窗口同时拾取，自增会在窗口之间撞号。
// 退化分支里保留随机后缀，是为了同一毫秒内连点两次也不重复。
export function createWebElementContextId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `web-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// [契约] 身份 key 统一为 workspaceIdentity 去空白后优先，否则回落 workspacePath。
// 去重、绑定、队列与持久化都复用这一条口径，调用方不应再自己手写拼接。
// [失败路径] 若改成直接返回 workspacePath，远程工作区的元素会串进本地同路径会话的列表。
// 空白字符串的 identity 必须视为缺失，只判真值会留下一个纯空格的 key。
export function getWebElementContextWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return workspaceIdentity?.trim() || workspacePath;
}

// [契约] 判型只看事件类型与 detail 是否为非空对象，不深入校验 detail 内部字段。
// 字段校验交给调用方的 isWebElementContextPayload，避免事件判型与载荷演进耦合。
// 改动这里前先想清楚：加严判型会让扩展先发事件、后补字段的时序下漏掉一次添加。
export function isWebElementContextAddToChatEvent(
  event: Event,
): event is WebElementContextAddToChatEvent {
  return (
    event.type === WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

// 删除事件只需要 id 与 workspace 归属，判型同样不深入 detail。
// [失败路径] 若在这里强制校验 id，扩展改配字段名后会静默丢弃删除请求，界面上的标签点不掉。
// `isWebElementContextRemoveFromChatEvent` 与添加判型刻意对称：便于对照排查「加有反应、删没反应」。
// 不要合并成一个泛型判型函数：事件类型不同，语义也不可互换。
export function isWebElementContextRemoveFromChatEvent(
  event: Event,
): event is WebElementContextRemoveFromChatEvent {
  return (
    event.type === WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

// [契约] 先确认 typeof 为 object 且非 null，再读字段，顺序颠倒时 null 载荷会先抛 TypeError。
// 校验刻意只覆盖最小必填集合：远程场景 workspaceIdentity 可缺省，页面也可能没有标题。
// [权衡] 这里不做 URL 合法性检查，about:blank 与 file 页面同样允许被拾取，由下游决定是否发送。
// tagName 与 workspacePath 用长度大于 0 判空而不是只判类型，空串会让后续选择器与归属计算失真。
// capturedAt 只校验类型不校验范围，跨机器时钟偏差属正常，不能因此拒收。
export function isWebElementContextPayload(payload: unknown): payload is WebElementContextPayload {
  const candidate = payload as WebElementContextPayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined ||
      typeof candidate.workspaceIdentity === "string") &&
    typeof candidate.pageUrl === "string" &&
    candidate.pageUrl.length > 0 &&
    typeof candidate.pageTitle === "string" &&
    typeof candidate.tagName === "string" &&
    candidate.tagName.length > 0 &&
    typeof candidate.capturedAt === "number"
  );
}

// [契约] `truncateMarkdownValue` 把空白值归一为空串，调用方按空串决定整行省略。
// 截断后追加 [truncated] 是给模型看的信号，去掉后模型会误以为正文被完整包含。
// 先 trim 再判断长度，避免纯空白输入被当成有内容而多出一段空围栏。
// 截断落在字符边界上而不处理代理对，这是已知取舍；改成按码点切会改变既有输出长度。
function truncateMarkdownValue(value: string | undefined) {
  if (!value) {
    return "";
  }

  const normalized = value.trim();
  return normalized.length > MAX_MARKDOWN_FIELD_LENGTH
    ? `${normalized.slice(0, MAX_MARKDOWN_FIELD_LENGTH)}\n\n[truncated]`
    : normalized;
}

// 只在有值时追加，避免输出 "Role: " 这类空标签行。
// 解析侧 readField 对空捕获返回空串再回填 undefined，两边口径正好对齐。
function appendOptionalLine(lines: string[], label: string, value: string | undefined) {
  const normalized = truncateMarkdownValue(value);
  if (normalized) {
    lines.push(`${label}: ${normalized}`);
  }
}

// [契约] 属性值用 JSON.stringify 加引号，含空格或引号的值在单行里仍可区分。
// 不要换成裸拼接：解析侧只按行取 Attributes 整段字符串，不负责再切分键值对。
// 空对象与 undefined 都返回空串，保证调用方走整行省略而不是输出一对空括号。
// 键顺序沿用对象自身顺序不排序，避免同一元素两次渲染出现差异，给历史对比制造噪音。
function formatAttributes(attributes: Record<string, string> | undefined) {
  if (!attributes || Object.keys(attributes).length === 0) {
    return "";
  }

  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}

// 字体摘要固定为「字号 字体族」的单行格式，这是 parseFontSummary 的输入契约。
// [契约] 只有字体族时也照样输出，解析侧正则匹配不到字号会把整串当作字体族回填。
// 字号与字体族都可能为空，filter 不能省，否则会出现前导空格。
// 不要在这里补默认字号，补了之后解析侧就分不清页面真实字号与编出来的默认值。
function formatFont(style: WebElementStyleSummary | undefined) {
  if (!style?.fontSize && !style?.fontFamily) {
    return "";
  }
  return [style.fontSize, style.fontFamily].filter(Boolean).join(" ");
}

// [契约] 输出结构即协议：首行 "## Element" 由外层替换成带序号的 "## Element N"。
// URL、Title、Tag 三行固定存在，其余字段按有值才出现。
// 新增字段必须用 appendOptionalLine 追加，保持一行一字段的可解析性。
// Text、Nearby context、HTML excerpt 三段走围栏，正文里的冒号与井号才不会破坏字段匹配。
// [失败路径] 把字段拼成多行会让 readField 只读到第一行，其余内容在重载时静默丢失。
function buildWebElementContextMarkdown(payload: WebElementContextPayload) {
  const lines = [
    "## Element",
    `URL: ${payload.pageUrl}`,
    `Title: ${payload.pageTitle || "(untitled)"}`,
    `Tag: ${payload.tagName.toLowerCase()}`,
  ];

  appendOptionalLine(lines, "Role", payload.role);
  appendOptionalLine(lines, "Accessible name", payload.accessibleName);
  appendOptionalLine(lines, "Selector", payload.selector);
  appendOptionalLine(lines, "XPath", payload.xpath);
  appendOptionalLine(lines, "Attributes", formatAttributes(payload.attributes));
  appendOptionalLine(lines, "Color", payload.style?.color);
  appendOptionalLine(lines, "Background", payload.style?.backgroundColor);
  appendOptionalLine(lines, "Font", formatFont(payload.style));
  appendOptionalLine(lines, "Font weight", payload.style?.fontWeight);
  appendOptionalLine(lines, "Display", payload.style?.display);

  if (payload.rect) {
    lines.push(
      `Rect: x=${Math.round(payload.rect.x)}, y=${Math.round(payload.rect.y)}, width=${Math.round(payload.rect.width)}, height=${Math.round(payload.rect.height)}`,
    );
  }

  const text = truncateMarkdownValue(payload.text);
  if (text) {
    lines.push("", "Text:", "```", text, "```");
  }

  const nearbyText = truncateMarkdownValue(payload.nearbyText);
  if (nearbyText) {
    lines.push("", "Nearby context:", "```", nearbyText, "```");
  }

  const htmlExcerpt = truncateMarkdownValue(payload.htmlExcerpt);
  if (htmlExcerpt) {
    lines.push("", "HTML excerpt:", "```html", htmlExcerpt, "```");
  }

  return lines.join("\n");
}

export function buildPromptWithWebElementContexts(
  text: string,
  contexts: readonly WebElementContextComposerAttachment[],
) {
  const content = text.trimEnd();
  if (contexts.length === 0) {
    return content.trim();
  }

  const contextBlock = `${WEB_ELEMENT_CONTEXT_BLOCK_TITLE}\n\n${contexts
    .map((context, index) =>
      buildWebElementContextMarkdown(context).replace("## Element", `## Element ${index + 1}`),
    )
    .join("\n\n")}`;

  return `${content}${content ? "\n\n" : ""}${contextBlock}`.trim();
}

// [失败路径] label 会直接拼进正则，调用方必须传固定字面量，传用户输入等于引入正则注入。
// 用多行标志逐行匹配，因此字段值不能跨行，跨行内容一律走围栏段落。
function readField(rawItem: string, label: string) {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "m").exec(rawItem);
  return match?.[1]?.trim() ?? "";
}

// [契约] 围栏允许三个反引号与带 html 标记两种开头，正文取到第一个闭合围栏为止。
// 标签先做正则转义，否则含特殊字符的标签会构造出错误模式。
// [失败路径] 正文里若出现闭合围栏会提前截断，这是已知限制，序列化侧不保证转义。
// 匹配不到时返回空串而不是抛错，缺段落的旧消息仍然要能正常打开。
function readFencedSection(rawItem: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `${escapedLabel}:\\s*\\n\`\`\`(?:html)?\\n([\\s\\S]*?)\\n\`\`\``,
    "m",
  ).exec(rawItem);
  return match?.[1]?.trim() ?? "";
}

// 正则要求带单位的字号加字体族，匹配失败时整体当字体族，绝不清空样式。
// [权衡] 字号单位白名单是 px、rem、em、pt 与百分号，新增单位要序列化与解析两边同步。
// 字号或字体族捕获为空时同样回退整串，避免产生半个字段。
// 返回类型只挑两个字段，不要把 font 里的其它信息塞进来，那会绕过 style 的可选语义。
function parseFontSummary(font: string): Pick<WebElementStyleSummary, "fontFamily" | "fontSize"> {
  const match = /^([0-9.]+(?:px|rem|em|pt|%))\s+(.+)$/iu.exec(font);
  if (!match) {
    return {
      fontFamily: font,
    };
  }
  const fontSize = match[1];
  const fontFamily = match[2];
  if (!fontSize || !fontFamily) {
    return {
      fontFamily: font,
    };
  }

  return {
    fontSize,
    fontFamily,
  };
}

// [契约] 只回填读到的字段，全空时返回 undefined 而不是空对象。
// 空对象会让下游误以为样式已设置，渲染出一个没有内容的样式块。
// 条件展开写法保证未读到的键根本不存在，而不是被赋成空串。
// 新增样式字段时三处要一起改：序列化、readField 读取、这里的条件展开。
function readStyleSummary(rawItem: string): WebElementStyleSummary | undefined {
  const color = readField(rawItem, "Color");
  const backgroundColor = readField(rawItem, "Background");
  const font = readField(rawItem, "Font");
  const fontWeight = readField(rawItem, "Font weight");
  const display = readField(rawItem, "Display");
  const style: WebElementStyleSummary = {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(font ? parseFontSummary(font) : {}),
    ...(fontWeight ? { fontWeight } : {}),
    ...(display ? { display } : {}),
  };

  return Object.keys(style).length > 0 ? style : undefined;
}

// [失败路径] 缺 URL 或 Tag 直接返回 null，由外层 filter 剔除；这是唯一允许静默丢弃元素的位置。
// id 由序号加标签名派生，保证同一 prompt 内唯一，重载后仍可稳定复现。
// capturedAt 固定为 0，历史记录不伪造捕获时间；真实时间在原始载荷里，解析阶段无从得知。
// 占位标题 (untitled) 还原成空串，界面才不会显示这个内部占位符。
// 可选字段一律用或 undefined 收敛，空串不能混进载荷，否则下游判空会失效。
function parseElementItem(
  rawItem: string,
  index: number,
  workspacePath: string,
  workspaceIdentity?: string,
): WebElementContextComposerAttachment | null {
  const pageUrl = readField(rawItem, "URL");
  const pageTitle = readField(rawItem, "Title");
  const tagName = readField(rawItem, "Tag");

  if (!pageUrl || !tagName) {
    return null;
  }

  return {
    id: `parsed-web-element-${index + 1}-${tagName}`,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    pageUrl,
    pageTitle: pageTitle === "(untitled)" ? "" : pageTitle,
    tagName,
    role: readField(rawItem, "Role") || undefined,
    accessibleName: readField(rawItem, "Accessible name") || undefined,
    selector: readField(rawItem, "Selector") || undefined,
    xpath: readField(rawItem, "XPath") || undefined,
    text: readFencedSection(rawItem, "Text") || undefined,
    nearbyText: readFencedSection(rawItem, "Nearby context") || undefined,
    htmlExcerpt: readFencedSection(rawItem, "HTML excerpt") || undefined,
    style: readStyleSummary(rawItem),
    capturedAt: 0,
  };
}

// [契约] 块头正则锚定在文本末尾，只解析最后追加的上下文块。
// 正文里手写同样标题不会被误拆，因为必须换行后紧跟空行与块头才算命中。
// [失败路径] 三处提前返回都必须原样吐出 content：解析失败等于没有上下文，不能吞用户正文。
// [契约] 元素切分只按 "## Element" 标题行，不按空行，否则多段文本里的空行会把一个元素拆成多个。
// 返回的 visibleContent 只保留块头之前的正文并去掉尾部空白，块本身不重复展示。
export function parsePromptWebElementContexts(
  content: string,
  options: {
    workspacePath: string;
    workspaceIdentity?: string;
  },
): ParsedWebElementContextPrompt {
  const blockMatch = /(?:^|\n\n)# Web page elements:\s*\n\n([\s\S]*?)\s*$/.exec(content);
  if (!blockMatch || blockMatch.index < 0) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  const rawBlock = blockMatch[1];
  if (rawBlock === undefined) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  const rawItems = rawBlock
    .split(/\n(?=## Element(?:\s+\d+)?\n)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const webElementContexts = rawItems
    .map((item, index) =>
      parseElementItem(item, index, options.workspacePath, options.workspaceIdentity),
    )
    .filter((item): item is WebElementContextComposerAttachment => item !== null);

  if (webElementContexts.length === 0) {
    return {
      visibleContent: content,
      webElementContexts: [],
    };
  }

  return {
    visibleContent: content.slice(0, blockMatch.index).trimEnd(),
    webElementContexts,
  };
}

// [资源] 直接派发到 window，不持有监听引用，因此没有需要清理的订阅。
// [契约] detail 必须是对象，否则判型失败，监听端会静默丢弃这次添加。
export function dispatchWebElementContextAddToChat(payload: WebElementContextPayload) {
  window.dispatchEvent(
    new CustomEvent(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, {
      detail: payload,
    }),
  );
}

// 删除事件只需要 id 与 workspace 归属，不要求完整载荷。
// [契约] 不要在这里补 workspaceIdentity 默认值，身份 key 由消费方按统一口径推导。
export function dispatchWebElementContextRemoveFromChat(payload: {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  window.dispatchEvent(
    new CustomEvent(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, {
      detail: payload,
    }),
  );
}
