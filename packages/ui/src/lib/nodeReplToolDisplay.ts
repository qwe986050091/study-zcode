// nodeReplToolDisplay —— node_repl（JS REPL 与 MCP 工具）调用的展示模型归一化层
//
// 职责：把 ChatToolCall（实时 tool.updated 与终态 snapshot 两种形态）里的 input、raw、output
// 归一化为 NodeReplDisplayModel，供工具卡片渲染代码、结果、错误、图片、持久化产物与 App 图标。
// 本模块是纯函数集合：不持有状态、不读全局、不做 IO，同一入参必须得到同一模型。
//
// 数据形态差异是所有不变量（INV）的根源：旧 built-in 把图片放在 result.images；真实 MCP 把图片放在
// content 里的 type、data、mimeType；实时事件把 display 塞在 raw.result；终态 snapshot 直接把
// completed part 的 metadata 当 raw。因此解析统一采用递归扫描加深度上限，而不是按固定路径取值。
//
// 不变量清单（任一条被破坏都会造成卡片信息丢失、错位或渲染异常）
// INV-01 纯函数性：同一 toolCall 必须产出同一模型。守卫点是全文件无缓存无全局可变状态；一旦引入缓存，事件重放会拿到过期图片或过期错误。
// INV-02 双形态兼容：实时 raw.result 与终态 metadata 都要扫。守卫在 extractImages、findCuaApp、hasBrowserTurnEndDisplay 的递归；只扫固定层级会让对话结束后的图片与图标消失。
// INV-03 递归深度上限 4：extractText 与 extractError 在入口判 depth。去掉上限后，畸形嵌套 raw 会栈溢出并卡死整条消息的渲染。
// INV-04 环检测：extractImages、findCuaApp、hasBrowserTurnEndDisplay 用 visited 记录对象引用。删除后，自引用的 raw 会无限递归到爆栈。
// INV-05 图片类型白名单：mimeType 必须匹配 image 前缀正则，校验点在 addImage 入口。放松后任意二进制会被塞进 img，产生加载失败与脚本注入面。
// INV-06 图片去重：优先用 src，否则用 mimeType 加长度加前 24 字符作键，由 seen 集合保证。去掉后同一张图重复渲染并成倍放大 base64 内存。
// INV-07 标题可信：命中 js、javascript、node-repl 的实现名必须丢弃，守卫是 IMPLEMENTATION_TITLE_PATTERN 在 readUserTitle 里的拦截。否则卡片标题会显示实现细节而非用户语义。
// INV-08 标题回退顺序：inputs 内的 title 优先于顶层 title，由循环拼接顺序保证。颠倒后 MCP 包装层的通用标题会覆盖用户真实标题。
// INV-09 操作判定必须先试 MCP 全名：resolveOperation 同时匹配 js_reset 与 mcp__node_repl__js_reset。只留旧名会把 reset 误渲染成执行 JavaScript。
// INV-10 未知操作回退 run：resolveOperation 末尾统一兜底。改为抛错会让一个匿名工具调用整卡渲染失败，影响整条会话可用性。
// INV-11 输入容错：input 既可能是对象也可能是 JSON 字符串，parseInputRecord 用 try 兜底。去掉后一个残缺 JSON 会把异常抛到渲染期。
// INV-12 输入去重按对象引用：readInputRecords 用 includes 比较同一引用。改成深比较会在超长 code 字符串上退化为 O(n²)，每帧都卡。
// INV-13 投影标记必须剥离：行首的等于号加右尖括号是内部完成值协议，由 removeProjectedCompletionMarkers 全局替换。泄漏后用户会看到源码级前缀。
// INV-14 图片占位剥离有前置条件：仅 hasImages 为真才剥，判定在 removeProjectedImagePlaceholders 入口。否则纯文本里的 Attached image 占位会连同真实输出一起消失。
// INV-15 剥空归一：剥完仅剩 (no output) 或空串时必须归一为 undefined，判定在该函数末尾。否则卡片会多出一行伪输出。
// INV-16 代码首部只去空行：removeLeadingBlankLines 只匹配空白行，不碰缩进。改成整体 trim 会破坏模板字符串与 Python 片段的相对缩进。
// INV-17 错误摘要不重复前缀：extractError 用 startsWith 判断 name 是否已在 message 里。缺失该判断会出现 TypeError 双层前缀。
// INV-18 错误优先级：显式 error 字段优先于 failed 状态下扫描 output，顺序由 buildNodeReplDisplayModel 里的空值合并保证。颠倒后成功但带警告的输出会被误判为失败。
// INV-19 持久化块必须整体匹配：PERSISTED_OUTPUT_PATTERN 带首尾锚点。去掉锚点后，preview 正文里出现的同名标签会被误当成外层包装。
// INV-20 持久化块字段缺失时退回原文：parsePersistedResult 在 sizeLabel 或 artifactPath 缺失时返回原文本。丢弃字段会让大输出彻底不可见。
//
import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";

export type NodeReplOperation = "run" | "reset" | "add-module-dir";

export interface NodeReplDisplayImage {
  base64: string;
  src?: string;
  mimeType: string;
}

export interface NodeReplDisplayError {
  summary: string;
  stack?: string;
}

export interface NodeReplPersistedResult {
  artifactPath: string;
  sizeLabel: string;
}

/** 本次 cell 操作的目标应用（Computer Use）；由 CLI 的 node_repl display 携带。 */
export interface NodeReplCuaApp {
  appKey: string;
  displayName?: string;
}

export interface NodeReplDisplayModel {
  operation: NodeReplOperation;
  userTitle?: string;
  code?: string;
  moduleDirectory?: string;
  resultText?: string;
  error?: NodeReplDisplayError;
  images: NodeReplDisplayImage[];
  persistedResult?: NodeReplPersistedResult;
  displaySource?: "browser_turn_end";
  app?: NodeReplCuaApp;
}

// [权衡] 全部结构判定都依赖这些模块级正则常量：在模块加载时编译一次，避免渲染热路径反复 new RegExp。
// 模式串恒定，因此不做动态缓存；新增模式时必须确认它不依赖运行时输入，否则会退化为每次渲染重建。
// PERSISTED_OUTPUT_PATTERN 用字符类加反斜杠转义覆盖换行，而不是开 s 标志，保证任意运行时下 preview 都不被提前截断。
const IMPLEMENTATION_TITLE_PATTERN = /(?:\bjs\b|\bjavascript\b|node[\s_-]*repl)/i;
const LEADING_BLANK_LINES_PATTERN = /^(?:[ \t]*\r?\n)+/;
const PROJECTED_COMPLETION_MARKER_PATTERN = /(^|\n)=> /g;
const PROJECTED_IMAGE_PLACEHOLDER_PATTERN = /^\[Attached image\/[^\]]+\]$/u;
const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/iu;
const PERSISTED_OUTPUT_PATTERN =
  /^<persisted-output>\s*\nOutput too large \(([^)]+)\)\. Full output saved to: ([^\n]+)\n\nPreview \([^)]+\):\n([\s\S]*?)\n<\/persisted-output>\s*$/;

// 类型守卫是后续所有 unknown 解析的唯一收口点，数组被显式排除。
// 因为 Array.isArray 同样满足 typeof 为 object，漏掉这一条会把图片数组当成字段字典读取，取到 undefined。
// [失败路径] null 与原始值直接返回 false，调用方一律按“无数据”处理，不抛错、不中断渲染。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 判空看 trim 后的长度，返回值却保留未 trim 的原始字符串，两者刻意分离。
// 调用方各自 trim 是为了保住 code 字段的缩进；在此统一 trim 会吃掉首个有效行的行首缩进。
// [权衡] 这套“判空用 trim、返回用原值”的约定被本文件多处依赖，改动其一都会让代码块显示错位。
function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

// 按 keys 顺序取第一个非空字符串，顺序本身就是优先级，调换 keys 会改变字段语义。
// 典型场景是 message 与 errorText、dir 与 path 这类历史别名并存。
// 只取首个命中而不是拼接：同一语义在两个字段各有一份时，拼接会造成重复展示。
function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readNonEmptyString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

// raw 内的入参有两代命名：新事件用 rawInput，旧事件用 input，二者都可能缺失。
// [兼容] 用空值合并而非逻辑或，让空字符串这类“显式存在但无效”的值仍进入 readNonEmptyString 判空。
// 只读不改：raw 对象由上层事件流持有，写入会污染实时候选数据，导致同一份事件被渲染两次时结果不一致。
function readRawInput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawInput ?? raw.input;
}

// 输出侧字段更多，rawOutput、output、result 三代并存，优先级从新到旧。
// result 是实时 tool.updated 的落点，output 是终态快照的落点，中间包装层可能同时携带两者。
// [失败路径] raw 不是记录时返回 undefined，由调用方统一过滤，不参与后续文本与错误提取。
function readRawOutput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawOutput ?? raw.output ?? raw.result;
}

// 操作类型决定卡片文案与可折叠区域，判定只看工具名，不看入参形状。
// [兼容] 先 trim 再小写以兼容服务端大小写不一致；toolName 缺失时回退 kind，最后兜底 run。
// [失败路径] 未知名字一律越界成 run 是刻意设计：宁可多渲染一段代码，也不让卡片空白。
function resolveOperation(toolCall: ChatToolCall): NodeReplOperation {
  const toolName = (toolCall.toolName?.trim() || toolCall.kind).toLowerCase();
  // 真实 MCP 工具会带 mcp__node_repl__ 前缀；仅匹配旧 built-in 名称
  // 会把 reset/configure 错误展示成执行 JavaScript。
  if (toolName === "js_reset" || toolName === "mcp__node_repl__js_reset") {
    return "reset";
  }
  if (
    toolName === "js_add_node_module_dir" ||
    toolName === "mcp__node_repl__js_add_node_module_dir"
  ) {
    return "add-module-dir";
  }
  return "run";
}

// 入参既可能是已解析对象，也可能是 JSON 字符串，两种形态都要接受。
// [失败路径] parse 失败返回 undefined 而不是抛错，损坏的入参不应让整条消息渲染崩溃。
// 解析结果再过一道 isRecord：数组或标量能 parse 成功，但语义上不是入参字典。
function parseInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// 两份候选按“顶层 input 优先、raw 内次之”排列，数组顺序即取值优先级。
// [权衡] 去重用 includes 的引用相等，而不是深比较：入参可能含超长 code 字符串，
// 深比较会让每次渲染退化成 O(n²)；代价是内容相同但引用不同的对象会重复，由调用方取首个来规避。
function readInputRecords(toolCall: ChatToolCall): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const candidate of [toolCall.input, readRawInput(toolCall.raw)]) {
    const record = parseInputRecord(candidate);
    if (record && !records.includes(record)) {
      records.push(record);
    }
  }

  return records;
}

// 用户标题是多源竞争的结果：先 inputs 内的 title，再顶层 title，先到先得。
// 实现名过滤是硬性要求：模型常把工具名塞进 title，直接展示等于向用户暴露内部实现。
// [失败路径] 候选全被过滤后退回 undefined，卡片回退到按操作类型生成的默认标题，而不是空标题。
function readUserTitle(
  toolCall: ChatToolCall,
  inputs: readonly Record<string, unknown>[],
): string | undefined {
  // 完成态快照可能只在 raw input 或顶层 title 保留用户标题，不能因主 input 只有 code 就丢失。
  for (const candidate of [...inputs.map((input) => input.title), toolCall.title]) {
    const title = readNonEmptyString(candidate)?.trim();
    if (title && !IMPLEMENTATION_TITLE_PATTERN.test(title)) {
      return title;
    }
  }

  return undefined;
}

function readInputString(
  inputs: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const input of inputs) {
    const value = readFirstStringField(input, keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

// [资源] 深度上限 4 是本文件唯一的栈保护，raw 由服务端生成，深度不可信。
// 数组按换行拼接；日志与 result 同时存在时也按“日志在前、结果在后”拼接，顺序影响用户阅读。
// 消息的 type 为 text 时，先读 value、text、content 这三个键，再退化到通用键表，避免整体字符串化。
function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }

  const directString = readNonEmptyString(value);
  if (directString) {
    return directString;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "text") {
    const textValue = readFirstStringField(value, ["value", "text", "content"]);
    if (textValue) {
      return textValue;
    }
  }

  const logs = readNonEmptyString(value.logs);
  const result = extractText(value.result, depth + 1);
  if (logs || result) {
    return [logs, result].filter((item): item is string => item !== undefined).join("\n");
  }

  for (const key of ["value", "output", "text", "content", "stdout", "message"] as const) {
    const text = extractText(value[key], depth + 1);
    if (text) {
      return text;
    }
  }

  return undefined;
}

// 结果投影用行首完成值标记区分完成值与日志，这是 Agent 协议标记而非用户可见内容。
// 正则带起始锚点与捕获组，替换时保留组 1 的换行，避免把相邻两行粘连成一行。
// [权衡] 只剥离行首出现的标记：正文中间同款字符视为用户输出，不做处理。
function removeProjectedCompletionMarkers(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }

  // 结果投影会用“=> ”区分完成值与日志，但这是内部协议标记，不应展示给用户。
  return text.replace(PROJECTED_COMPLETION_MARKER_PATTERN, "$1");
}

function removeProjectedImagePlaceholders(
  text: string | undefined,
  hasImages: boolean,
): string | undefined {
  if (!text || !hasImages) return text;

  // Agent/Provider 需要图片的文本占位，但工具卡片已持有真实 display 图片；
  // 若继续渲染投影文本，用户会同时看到图片和“Attached MCP image”内部协议描述。
  const visibleLines = text
    .split("\n")
    .filter((line) => !PROJECTED_IMAGE_PLACEHOLDER_PATTERN.test(line.trim()));
  const withoutPlaceholder = visibleLines.join("\n").trim();
  return withoutPlaceholder === "(no output)" || withoutPlaceholder.length === 0
    ? undefined
    : withoutPlaceholder;
}

// [权衡] `removeLeadingBlankLines` 只删开头空白行：缩进本身是代码语义。
// 模型常在首个有效行前补换行，不删除会让卡片顶部出现一段固定空白，显得内容从第二屏开始。
function removeLeadingBlankLines(code: string | undefined): string | undefined {
  if (!code) {
    return code;
  }

  // 模型生成的执行内容经常在首个有效行前带换行；只移除空白行，避免破坏代码缩进。
  return code.replace(LEADING_BLANK_LINES_PATTERN, "");
}

// 错误对象可能是字符串、序列化后的记录，或 error 字段再套一层记录的多层包装。
// [失败路径] 嵌套提取失败后继续读同层字段，不会因为一层包装缺失就整体放弃。
// 拼接 name 与 message 前先判重，stack 只在存在时才写入，避免结果对象里出现空字符串字段。
function extractError(value: unknown, depth = 0): NodeReplDisplayError | undefined {
  if (depth > 4) {
    return undefined;
  }

  if (typeof value === "string") {
    const summary = value.trim();
    return summary.length > 0 ? { summary } : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if ("error" in value) {
    const nested = extractError(value.error, depth + 1);
    if (nested) {
      return nested;
    }
  }

  const message = readFirstStringField(value, ["message", "errorText"]);
  const name = readNonEmptyString(value.name)?.trim();
  const stack = readNonEmptyString(value.stack);
  if (message) {
    const normalizedMessage = message.trim();
    return {
      summary:
        name && !normalizedMessage.startsWith(`${name}:`)
          ? `${name}: ${normalizedMessage}`
          : normalizedMessage,
      ...(stack ? { stack } : {}),
    };
  }

  return undefined;
}

// 两种历史图片形态并存：旧 built-in 的 base64 字段与 MCP 的 data 字段。
// [资源] visited 记对象引用防环，seen 记内容键防重复，两个集合职责不同，不可合并成一个。
// 只接受 image 前缀的 MIME，非图片 data 一律丢弃，避免把任意二进制塞进 img 元素。
function extractImages(values: unknown[]): NodeReplDisplayImage[] {
  const images: NodeReplDisplayImage[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();
  const addImage = (value: Record<string, unknown>) => {
    // 旧 built-in result 使用 {images:[{base64,mimeType}]}，真实 MCP
    // 使用 content 里的 {type:"image",data,mimeType}。专用 renderer 必须兼容两种历史形态。
    const base64 = readNonEmptyString(value.base64) ?? readNonEmptyString(value.data);
    const mimeType = readNonEmptyString(value.mimeType)?.trim();
    const src = readNonEmptyString(value.src);
    if ((!base64 && !src) || !mimeType || !IMAGE_MIME_TYPE_PATTERN.test(mimeType)) {
      return;
    }
    const key = src ?? `${mimeType}:${base64!.length}:${base64!.slice(0, 24)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    images.push({ base64: base64 ?? "", mimeType, ...(src ? { src } : {}) });
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "image" || "base64" in value || "src" in value) addImage(value);
    for (const child of Object.values(value)) visit(child);
  };

  for (const value of values) {
    visit(value);
  }

  return images;
}

/**
 * 从 raw 里找 node_repl display 携带的 App 身份。
 *
 * 与 `extractImages` / `hasBrowserTurnEndDisplay` 同款递归：实时 tool.updated 把 display 放在
 * raw.result 内，终态 snapshot 则把 completed part 的 metadata 直接当作 raw，只扫一个固定位置
 * 会让对话结束后图标消失。
 */
// App 身份只挂在 kind 为 node_repl_images 的节点上，其余节点仅作为递归容器。
// [失败路径] 返回首个命中即停止；多个节点携带不同 App 时以遍历顺序为准，不做仲裁。
// appKey 为空视为未携带，避免渲染出既无图标又无文案的空徽标。
function findCuaApp(value: unknown, visited = new Set<object>()): NodeReplCuaApp | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCuaApp(item, visited);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.kind === "node_repl_images" && isRecord(value.app)) {
    const appKey = readNonEmptyString(value.app.appKey)?.trim();
    if (appKey) {
      const displayName = readNonEmptyString(value.app.displayName)?.trim();
      return { appKey, ...(displayName ? { displayName } : {}) };
    }
  }
  for (const item of Object.values(value)) {
    const found = findCuaApp(item, visited);
    if (found) return found;
  }
  return undefined;
}

// 该函数只回答“是否存在浏览器回合结束来源”，不返回节点本身，因此用布尔短路遍历。
// kind 与 source 必须同时成立；只判 source 会让其他工具上的同名字段误报为浏览器来源。
// [权衡] 用 some 而非收集全部命中，命中即返回，长列表上避免无谓遍历。
function hasBrowserTurnEndDisplay(value: unknown, visited = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBrowserTurnEndDisplay(item, visited));
  }
  if (!isRecord(value)) return false;
  if (value.kind === "node_repl_images" && value.source === "browser_turn_end") return true;
  return Object.values(value).some((item) => hasBrowserTurnEndDisplay(item, visited));
}

// 大输出会被服务端包装成持久化块；正则带首尾锚点，防止 preview 正文里的同名标签被误认成外层包装。
// [失败路径] 匹配失败或关键字段缺失都退回原文，宁可展示冗长文本，也不丢结果。
// [事务] 返回值要么是纯 resultText，要么是 preview 加产物描述，不会同时为空把卡片留成白板。
function parsePersistedResult(text: string | undefined): {
  resultText?: string;
  persistedResult?: NodeReplPersistedResult;
} {
  if (!text) {
    return {};
  }

  const match = PERSISTED_OUTPUT_PATTERN.exec(text);
  if (!match) {
    return { resultText: text };
  }

  const [, sizeLabel, artifactPath, preview] = match;
  if (!sizeLabel || !artifactPath) {
    return { resultText: text };
  }

  return {
    ...(preview?.trim() ? { resultText: preview } : {}),
    persistedResult: {
      artifactPath: artifactPath.trim(),
      sizeLabel: sizeLabel.trim(),
    },
  };
}

// 编排顺序即语义：先取入参，再取输出候选，再提图片，最后按图片数量决定是否剥离占位。
// [并发] `buildNodeReplDisplayModel` 无副作用且不读时间，渲染期可反复重入。
// outputCandidates 按“顶层 output 优先、raw 输出次之”排列，投影文本取首个非空候选。
// [失败路径] 返回对象的可选字段要么有值要么省略，不出现显式 undefined 键，避免下游判空歧义。
export function buildNodeReplDisplayModel(toolCall: ChatToolCall): NodeReplDisplayModel {
  const inputs = readInputRecords(toolCall);
  const outputCandidates = [toolCall.output, readRawOutput(toolCall.raw)].filter(
    (value) => value !== undefined,
  );
  const projectedText = outputCandidates
    .map((candidate) => extractText(candidate))
    .find((candidate) => candidate !== undefined);
  // 实时 tool.updated 把 display 放在 raw.result 内，终态 snapshot 则把
  // completed part 的 metadata 直接作为 raw。只扫描 raw.result 会让对话结束后的图片消失。
  const images = extractImages([...outputCandidates, toolCall.raw]);
  const app = findCuaApp(toolCall.raw);
  const persisted = parsePersistedResult(
    removeProjectedImagePlaceholders(
      removeProjectedCompletionMarkers(projectedText),
      images.length > 0,
    ),
  );

  return {
    operation: resolveOperation(toolCall),
    userTitle: readUserTitle(toolCall, inputs),
    code: removeLeadingBlankLines(readInputString(inputs, ["code"])),
    moduleDirectory: readInputString(inputs, ["dir", "path"])?.trim(),
    ...persisted,
    ...(hasBrowserTurnEndDisplay(toolCall.raw)
      ? { displaySource: "browser_turn_end" as const }
      : {}),
    ...(app ? { app } : {}),
    // [失败路径] 错误有两个来源：显式 error 字段，以及 failed 状态下从输出候选里扫描出的错误。
    // 显式字段优先，因为它是服务端归一后的结论；扫描输出只是兜底，成功但带警告的输出不应被误判为失败。
    // find(Boolean) 只取首个可用结果，避免多份候选出错时把不同错误拼成一条无法定位的摘要。
    error:
      extractError(toolCall.error) ??
      (toolCall.status === "failed"
        ? outputCandidates.map((candidate) => extractError(candidate)).find(Boolean)
        : undefined),
    images,
  };
}
