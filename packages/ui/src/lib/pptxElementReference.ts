// INV-01 指纹必须整体满足 SHA256_PATTERN 才被接受；守住位置：isPptxElementReferencePayload 的 sourceFingerprint 与 textFingerprint 校验；改错故障：前缀写成 sha256- 或漏掉冒号的引用被静默丢弃，用户附带的评论从未到达模型。
// INV-02 编码端与解码端必须共用同一组块标题与 directive 常量；守住位置：PPTX_ELEMENT_COMMENT_BLOCK_TITLE 与 PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE；改错故障：只改一侧时自己写出的引用块下次解析不回来，历史消息里的评论整段变成可见正文。
// INV-03 slideIndex 必须是非负整数且 slidePart 必须匹配 ppt/slides/slide<X>.xml；守住位置：isPptxElementReferencePayload；改错故障：缺页或负数页的引用混进列表，打开时定位到错误幻灯片。
// INV-04 table-cell 引用必须同时带非负整数 rowIndex 与 cellIndex；守住位置：isPptxElementReferencePayload 的 hasCellCoordinates 分支；改错故障：缺列号的引用被当作整张表，评论落到表格而不是目标单元格。
// INV-05 nodeType 只允许 shape、picture、chart、table、table-cell 五值；守住位置：isPptxElementReferencePayload 的 nodeTypes 集合；改错故障：新增节点类型只改编码端时旧校验把整批引用判非法，功能整体退回纯文本。
// INV-06 去重键由 sourcePath、sourceFingerprint、slidePart、nodeId 与单元格坐标以 \0 拼接；守住位置：getReferenceDedupeKey；改错故障：换用路径里可出现的分隔符会让不同元素撞键，后加的评论覆盖另一元素。
// INV-07 同一去重键的新引用必须原位替换而非追加；守住位置：addPptxElementReference 的 existingIndex 分支；改错故障：同一元素在提示里出现两条引用，模型重复执行并产生互相冲突的修改。
// INV-08 addPptxElementReference 不得原地修改入参数组；守住位置：该函数返回新数组的两个分支；改错故障：调用方按引用相等判断变化，原地写入后界面不刷新，用户看不到新加的引用。
// INV-09 拼接前必须 trimEnd 正文，且块前统一补两个换行；守住位置：buildPromptWithPptxElementReferences 的 content 变量与拼接表达式；改错故障：正文尾随空行让块前出现三行以上空行，解析正则失配，引用被原样发出去。
// INV-10 引用块必须位于文本行尾并以 json 围栏收尾；守住位置：两条块正则的 \s*$ 锚点；改错故障：用户在块后继续输入时块不再被识别，机器 JSON 直接显示在输入框里。
// INV-11 旧格式块只用于兼容历史回放，且优先级低于新格式；守住位置：parsePromptPptxElementReferences 中 ?? 的左侧先行；改错故障：顺序颠倒时正文里手写的同标题片段抢先截断内容，新格式引用反而丢失。
// INV-12 解析失败一律返回原文加空引用列表，绝不抛错；守住位置：parsePromptPptxElementReferences 的三个早返回与 catch 分支；改错故障：一次抛错让整条消息渲染失败，用户连自己写的正文都看不到且无法重发。
// INV-13 引用列表必须非空且每一项都通过校验才承认整块；守住位置：references.length !== parsed.length 的判断；改错故障：过滤坏项后继续会让不存在的元素进入模型上下文，改稿落到错误位置。
// INV-14 visibleContent 只取块起点之前的部分并 trimEnd；守住位置：parsePromptPptxElementReferences 的 slice 分支；改错故障：围栏 JSON 留在界面里，用户看到大段机器可读数据却找不到自己的正文。
// INV-15 工作区归属以 workspaceIdentity 的 trim 结果为准，缺省回退 workspacePath；守住位置：getPptxElementReferenceWorkspaceKey；改错故障：identity 带首尾空格时同一工作区被判成两个，引用在面板里凭空消失。
// INV-16 作用域比较要求工作区键与会话标识同时相等，undefined 会话按空串归一；守住位置：isPptxElementReferenceInWorkspaceScope；改错故障：本地会话能看到远程会话的引用，评论被发给错误的远端文件。
// INV-17 selectedText 与 comment 必须 trim 后仅保留非空值，且用条件展开而非写空串；守住位置：createPptxElementReference 的对象字面量；改错故障：空串被当作一条真实指令，模型据空评论重写元素却没有任何要求可依。
// INV-18 textFingerprint 只在元素文本 trim 后非空时计算，且哈希对象是 trim 后的文本；守住位置：createPptxElementReference 的 options.element.text 分支；改错故障：只差首尾空白的两次取词得到不同指纹，内容未变却被判为已改动。
// INV-19 sha256Fingerprint 的输出固定是 sha256: 加 64 位小写十六进制；守住位置：sha256Fingerprint 的 padStart 与 join；改错故障：漏补前导 0 得到短摘要，被 SHA256_PATTERN 拒绝，所有引用校验失败并退回纯文本。
// INV-20 派发事件前必须做运行时结构校验并用类型守卫收窄；守住位置：isPptxElementReferenceAddToChatEvent；改错故障：跨窗口或旧版本页面发来的事件形状不符时，消费方读到 undefined 字段并崩在渲染阶段。
import type { PresentationPageElement } from "@/presentation/types.js";

export const PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT =
  "zcode:pptx-element-reference-add-to-chat";
const PPTX_ELEMENT_COMMENT_BLOCK_TITLE = "# Presentation element comments:";
const PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE =
  "Each item below is an independent comment on one presentation element. Treat every non-empty `comment` as the user's instruction for that element, process all of them, and never apply one item's comment to another reference.";
// [权衡] 指纹是判断引用所指源文件是否仍为同一份的唯一凭据，所以校验用完整白名单
// 正则而不是只查前缀：前缀正确但长度不足的摘要意味着生成侧被截断，若放行，
// 内容不同的两个版本会被当成同一来源，评论会贴到已经改动的元素上。
// [失败路径] 只接受小写十六进制；sha256Fingerprint 自身产出小写，外部粘贴或
// 旧版本产生的摘要会在这里被挡下，parsePromptPptxElementReferences 随后把整块
// 判为非法并退回原文，用户至少还能读到自己的输入，不会看到白屏。
// 正则带 u 标志与 escapeRegExp 保持一致，避免含代理对的路径在切分上产生歧义。
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// 标题与 JSON 围栏之间若用通配匹配 directive，正文里出现的同名标题也会命中，
// 并把它之后的用户正文整段吞进尾块。这里改成按 directive 常量精确匹配。
const PPTX_ELEMENT_COMMENT_BLOCK_PATTERN = new RegExp(
  `(?:^|\\n\\n)${escapeRegExp(
    PPTX_ELEMENT_COMMENT_BLOCK_TITLE,
  )}\\s*\\n\\n${escapeRegExp(
    PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE,
  )}\\s*\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`\\s*$`,
  "u",
);
// [权衡] 兼容块只认旧标题「# Presentation elements:」，且必须落在文本末尾；
// 放宽为任意位置出现会把用户手动粘贴的示例 JSON 一并当成引用块吞掉。
// [失败路径] 旧块没有 directive 段落，无法校验注释语义，只能按 payload 结构判断；
// 结构不符时解析整体退回原文，宁可让用户看到多余 JSON，也不丢掉正文。
// 新旧两块靠 ?? 的左侧先行匹配，新格式优先，保证同一提示不会同时命中两种解析。
// 该回退只服务历史会话回放：新一轮写入永远走新格式，避免再产生无 directive 的块。
// 两条正则都锚定 \s*$，任何尾部追加（比如签名）都会让它们同时失效。
const PPTX_ELEMENT_LEGACY_BLOCK_PATTERN =
  /(?:^|\n\n)# Presentation elements:\s*\n\n```json\n([\s\S]*?)\n```\s*$/u;

export interface PptxElementReference extends PresentationPageElement {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
  sourceFingerprint: string;
  selectedText?: string;
  comment?: string;
  textFingerprint?: string;
  capturedAt: number;
}

export interface PptxElementReferenceSource {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
}

interface ParsedPptxElementReferencePrompt {
  visibleContent: string;
  pptxElementReferences: PptxElementReference[];
}

type PptxElementReferenceAddToChatEvent = CustomEvent<PptxElementReference>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function getPptxElementReferenceWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return workspaceIdentity?.trim() || workspacePath;
}

// [权衡] 归属比较用 identity 优先、路径兜底的双键形式，而不是直接比 workspacePath：
// 同一工作区在不同会话里可能挂到不同绝对路径，只比路径会让引用凭空消失。
// 会话维度单独比较并把 undefined 归一成空串，于是本地会话自成一档，
// 远程会话之间互不可见，避免把评论发给错误的远端目标。
// [失败路径] 两侧都缺 identity 时回退到未归一的路径，大小写与分隔符差异会让
// 比较失败；因此该路径只用于缺 identity 的旧引用，不能扩展成通用比较。
export function isPptxElementReferenceInWorkspaceScope(
  reference: Pick<
    PptxElementReference,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId"
  >,
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  },
) {
  return (
    getPptxElementReferenceWorkspaceKey(
      reference.workspacePath,
      reference.workspaceIdentity,
    ) ===
      getPptxElementReferenceWorkspaceKey(
        scope.workspacePath,
        scope.workspaceIdentity,
      ) && (reference.remoteSessionId ?? "") === (scope.remoteSessionId ?? "")
  );
}

// [权衡] 这里是引用进入系统的唯一闸门：逐字段用运行时守卫检查而不是先 cast 后信任，
// 因为 payload 可能来自跨窗口事件、历史消息回放或人工构造的 JSON。
// [失败路径] 校验全有或全无，任一项不满足就返回 false，由调用方决定退回纯文本；
// 这里刻意不抛错，一条坏引用不该让整条消息无法渲染。
// 拒绝空字符串 id 与空 sourcePath：它们会让去重键退化成只剩分隔符，
// getReferenceDedupeKey 撞键后，后写入的 comment 会覆盖前一个元素。
// slideIndex 允许 0 是因为部分生成器把封面页记为 0 号；nodeId 只要求非空串，
// 因为 shape 编号在 XML 里并不连续，存在性无法用区间校验代替。
export function isPptxElementReferencePayload(
  payload: unknown,
): payload is PptxElementReference {
  if (!isRecord(payload) || !isRecord(payload.bounds)) {
    return false;
  }
  const nodeTypes = new Set([
    "shape",
    "picture",
    "chart",
    "table",
    "table-cell",
  ]);
  const hasCellCoordinates =
    Number.isInteger(payload.rowIndex) &&
    (payload.rowIndex as number) >= 0 &&
    Number.isInteger(payload.cellIndex) &&
    (payload.cellIndex as number) >= 0;
  return (
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    typeof payload.workspacePath === "string" &&
    payload.workspacePath.length > 0 &&
    isOptionalString(payload.workspaceIdentity) &&
    isOptionalString(payload.remoteSessionId) &&
    typeof payload.sourcePath === "string" &&
    payload.sourcePath.length > 0 &&
    typeof payload.sourceTitle === "string" &&
    typeof payload.sourceFingerprint === "string" &&
    SHA256_PATTERN.test(payload.sourceFingerprint) &&
    (payload.textFingerprint === undefined ||
      (typeof payload.textFingerprint === "string" &&
        SHA256_PATTERN.test(payload.textFingerprint))) &&
    Number.isInteger(payload.slideIndex) &&
    (payload.slideIndex as number) >= 0 &&
    typeof payload.slidePart === "string" &&
    /^ppt\/slides\/slide[^/]+\.xml$/u.test(payload.slidePart) &&
    typeof payload.nodeId === "string" &&
    payload.nodeId.length > 0 &&
    isOptionalString(payload.nodePath) &&
    typeof payload.nodeName === "string" &&
    typeof payload.nodeType === "string" &&
    nodeTypes.has(payload.nodeType) &&
    isOptionalString(payload.text) &&
    isOptionalString(payload.selectedText) &&
    isOptionalString(payload.comment) &&
    isFiniteNumber(payload.bounds.x) &&
    isFiniteNumber(payload.bounds.y) &&
    isFiniteNumber(payload.bounds.width) &&
    payload.bounds.width >= 0 &&
    isFiniteNumber(payload.bounds.height) &&
    payload.bounds.height >= 0 &&
    Number.isInteger(payload.zIndex) &&
    isFiniteNumber(payload.capturedAt) &&
    (payload.nodeType === "table-cell" ? hasCellCoordinates : true)
  );
}

export function createPptxElementReferenceId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pptx-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// [权衡] 统一接受字符串与 ArrayBuffer 两种输入，字符串先经 TextEncoder 转 UTF-8，
// textFingerprint 与文件字节指纹共用同一套十六进制输出，比较端无需区分来源。
// [资源] subtle.digest 返回 ArrayBuffer，这里立刻复制成 Uint8Array 再展开，
// digest 之后不再持有原 ArrayBuffer，避免调用方复用内存时读到被改写的数据。
// 每个字节 padStart 补齐两位是必需的：直接取十六进制会丢掉前导 0，
// 摘要长度随内容波动，SHA256_PATTERN 会随机拒绝合法指纹。
// 该函数必须异步，因为 WebCrypto 只提供异步接口，不能改成同步实现。
export async function sha256Fingerprint(
  value: ArrayBuffer | string,
): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export async function createPptxElementReference(options: {
  element: PresentationPageElement;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sourcePath: string;
  sourceTitle: string;
  sourceFingerprint: string;
  selectedText?: string;
  comment?: string;
}): Promise<PptxElementReference> {
  // [权衡] selectedText 与 comment 先 trim 再判空，只有空白的选择被视为未选择；
  // 用条件展开省略字段而不是写入空串，空串会被下游当成一条真实的空指令。
  // element 展开在首位，之后的显式字段覆盖它，保证 PresentationPageElement 里
  // 同名的 id 与 bounds 不会被元素自带的旧值盖掉。
  // [失败路径] textFingerprint 只在元素文本 trim 后非空时计算，否则整条引用不带
  // 该字段；带空串哈希会让无文本的形状与文本被清空的形状被判为同一内容。
  // capturedAt 取 Date.now 作为唯一时序信息，只用于展示与排序而不参与去重。
  // createPptxElementReference 只做对象拼装与一次哈希而不读写存储，因此可在渲染进程任意调用。
  const selectedText = options.selectedText?.trim();
  const comment = options.comment?.trim();
  return {
    ...options.element,
    id: createPptxElementReferenceId(),
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity
      ? { workspaceIdentity: options.workspaceIdentity }
      : {}),
    ...(options.remoteSessionId
      ? { remoteSessionId: options.remoteSessionId }
      : {}),
    sourcePath: options.sourcePath,
    sourceTitle: options.sourceTitle,
    sourceFingerprint: options.sourceFingerprint,
    ...(selectedText ? { selectedText } : {}),
    ...(comment ? { comment } : {}),
    ...(options.element.text
      ? {
          textFingerprint: await sha256Fingerprint(options.element.text.trim()),
        }
      : {}),
    capturedAt: Date.now(),
  };
}

// getReferenceDedupeKey 用 \0 拼接而不是冒号或斜杠：路径与标题里都可能出现这些字符，
// 一旦分隔符可被内容携带，不同元素就能构造出相同键并互相覆盖评论。
// 表格单元格必须把 rowIndex 与 cellIndex 纳入键；只靠 nodeId 会让同一张表的
// 同一张表的单元格共用 nodeId 一个键，用户对两个单元格的 comment 只剩最后一条。
// [权衡] 非单元格节点在对应位置填空串，保持键的字段数恒定；
// 否则字段数随类型变化，前缀相同的两类节点可能拼出同一串。
// sourceFingerprint 参与键是刻意的：源文件改版后同一 nodeId 视为新引用。
function getReferenceDedupeKey(reference: PptxElementReference) {
  return [
    reference.sourcePath,
    reference.sourceFingerprint,
    reference.slidePart,
    reference.nodeId,
    reference.nodeType === "table-cell" ? reference.rowIndex : "",
    reference.nodeType === "table-cell" ? reference.cellIndex : "",
  ].join("\0");
}

export function addPptxElementReference(
  references: readonly PptxElementReference[],
  reference: PptxElementReference,
): readonly PptxElementReference[] {
  const key = getReferenceDedupeKey(reference);
  const existingIndex = references.findIndex(
    (item) => getReferenceDedupeKey(item) === key,
  );
  if (existingIndex < 0) {
    return [...references, reference];
  }
  return references.map((item, index) =>
    index === existingIndex ? reference : item,
  );
}

// [权衡] 引用块固定追加在正文末尾而自带标题、directive 与 json 围栏，
// 是为了让 PPTX_ELEMENT_COMMENT_BLOCK_PATTERN 这一条锚定行尾的正则整块取回，不必扫描全文。
// 正文先 trimEnd 再判空：只有空白时不留前导空行，直接以标题开头；
// 非空时在 content 后补两个换行，正好匹配解析正则要求的块前分隔。
// [失败路径] references 为空时必须提前返回正文，不能输出空数组的块；
// 空块会让解析端整体退回原文，围栏反而成为噪声留在界面上。
// JSON.stringify 用两空格缩进并保留字段顺序，输出稳定而便于比对与快照测试。
// buildPromptWithPptxElementReferences 纯拼接且不读时钟也不读状态，同样入参得到同样字符串。
export function buildPromptWithPptxElementReferences(
  text: string,
  references: readonly PptxElementReference[],
) {
  const content = text.trimEnd();
  if (references.length === 0) {
    return content.trim();
  }
  const block = `${PPTX_ELEMENT_COMMENT_BLOCK_TITLE}\n\n${PPTX_ELEMENT_COMMENT_BLOCK_DIRECTIVE}\n\n\`\`\`json\n${JSON.stringify(
    references,
    null,
    2,
  )}\n\`\`\``;
  return `${content}${content ? "\n\n" : ""}${block}`.trim();
}

// [失败路径] 四个返回点都给出原文加空列表且绝不抛错：解析跑在消息渲染路径上，
// 一次抛错就会让整条气泡崩溃，用户连自己写的正文都看不到。
// PPTX_ELEMENT_COMMENT_BLOCK_PATTERN 优先、旧格式兜底，两块正则都要求块位于行尾，正文中间的标题不参与匹配。
// references.length !== parsed.length 时整块判废，而不是过滤坏项后继续：
// 部分接受会让模型看到不存在于文档的元素引用，据此改稿会产生错位修改。
// visibleContent 只取块起点之前的部分并 trimEnd，围栏 JSON 永远不进界面。
// parsePromptPptxElementReferences 是纯函数：不改入参、不做 I/O，可重用于草稿恢复与历史回放。
export function parsePromptPptxElementReferences(
  content: string,
): ParsedPptxElementReferencePrompt {
  const blockMatch =
    PPTX_ELEMENT_COMMENT_BLOCK_PATTERN.exec(content) ??
    PPTX_ELEMENT_LEGACY_BLOCK_PATTERN.exec(content);
  if (!blockMatch || blockMatch.index < 0 || blockMatch[1] === undefined) {
    return { visibleContent: content, pptxElementReferences: [] };
  }
  try {
    const parsed: unknown = JSON.parse(blockMatch[1]);
    if (!Array.isArray(parsed)) {
      return { visibleContent: content, pptxElementReferences: [] };
    }
    const references = parsed.filter(isPptxElementReferencePayload);
    if (references.length !== parsed.length || references.length === 0) {
      return { visibleContent: content, pptxElementReferences: [] };
    }
    return {
      visibleContent: content.slice(0, blockMatch.index).trimEnd(),
      pptxElementReferences: references,
    };
  } catch {
    return { visibleContent: content, pptxElementReferences: [] };
  }
}

export function isPptxElementReferenceAddToChatEvent(
  event: Event,
): event is PptxElementReferenceAddToChatEvent {
  return (
    event.type === PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    isPptxElementReferencePayload((event as CustomEvent<unknown>).detail)
  );
}

export function dispatchPptxElementReferenceAddToChat(
  reference: PptxElementReference,
) {
  window.dispatchEvent(
    new CustomEvent(PPTX_ELEMENT_REFERENCE_ADD_TO_CHAT_EVENT, {
      detail: reference,
    }),
  );
}
