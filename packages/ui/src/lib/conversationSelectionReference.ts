// 会话选区引用模块：把用户在对话与 Markdown 中的选区转成可传输、可去重、可限流的引用记录。
// 状态所有权：模块级 Map 只保存当前渲染进程内存中的 scope 快照，不写盘、不跨窗口同步。
// 纯函数边界：键生成、去重键、追加判定与块解析均为纯函数，同输入必同输出，便于单测与重放。
// 对外导出分三类：状态读写、引用构造与容量判定、提示词文本块解析与事件契约。
// 【不变量】INV-01 scope 键必须由 workspaceKey 与会话身份共同决定；守住位置：referenceScopeKey；改错故障：不同工作区的选区互相覆盖。
// 【不变量】INV-02 无会话时必须区分草稿与匿名；守住位置：referenceScopeKey 的三元拼接；改错故障：草稿选区串到非草稿会话。
// 【不变量】INV-03 键内字段以 NUL 分隔；守住位置：referenceScopeKey 拼接；改错故障：含分隔符的标题或路径造成键碰撞。
// 【不变量】INV-04 空引用数组等价于不存在；守住位置：setConversationSelectionReferenceScope；改错故障：清空后仍读到旧快照。
// 【不变量】INV-05 写入新引用必须清除旧限流原因；守住位置：setConversationSelectionReferenceScope；改错故障：容量恢复后仍显示上一次的提示条。
// 【不变量】INV-06 限流原因按 scope 独立存放；守住位置：limitReasonByScope；改错故障：一个会话的失败提示污染其他会话。
// 【失败路径】INV-07 单条文本超长时优先返回 single；守住位置：appendConversationSelectionReference 首检；改错故障：用户看到错误的“数量已满”。
// 【不变量】INV-08 重复引用必须幂等返回原数组；守住位置：appendConversationSelectionReference 去重分支；改错故障：重复点选让列表无意义增长。
// 【不变量】INV-09 去重键字段顺序固定且不可重排；守住位置：getConversationSelectionDedupeKey；改错故障：同一条选区被判定为不同引用。
// 【不变量】INV-10 Markdown 与消息引用使用互斥的去重键前缀；守住位置：去重键的 markdown 分支；改错故障：同名文档选区与对话选区互相吞并。
// 【不变量】INV-11 追加失败不得修改入参数组；守住位置：appendConversationSelectionReference 各提前返回；改错故障：调用方在失败后看到半更新的列表。
// 【设计权衡】INV-12 容量判定顺序为单条、重复、数量、总量；守住位置：追加函数的分支次序；改错故障：提示原因与实际阻塞条件不一致。
// 【不变量】INV-13 总量按文本长度累加而非引用条数；守住位置：appendConversationSelectionReference 的求和；改错故障：长文档绕过上下文预算。
// 【不变量】INV-14 解析优先匹配 userselect 块，其次才是历史块；守住位置：parsePromptConversationSelections；改错故障：新格式被旧正则截断。
// 【失败路径】INV-15 块内任一条目非法则整块回退为可见文本；守住位置：parseConversationSelectionBlock 的 catch；改错故障：残缺引用被静默丢掉一半。
// 【失败路径】INV-16 无块可匹配时原文即可见内容；守住位置：parsePromptConversationSelections 的早退；改错故障：普通消息被删掉尾部。
// 【确定性】INV-17 解析成功时可见内容为块前缀去尾空白；守住位置：parseConversationSelectionBlock 的切片；改错故障：历史消息尾部残留空行。
// 【不变量】INV-18 派发事件前必须先写快照再广播；守住位置：dispatchConversationSelectionAdd；改错故障：订阅方读到旧快照而回滚。
import {
  createUuid,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  type ConversationSelectionText,
} from "@zcode/shared";

export {
  buildPromptWithConversationSelections,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  type ConversationSelectionText,
} from "@zcode/shared";

export type ConversationSelectionContentType = "user" | "assistant" | "reasoning" | "tool";

export interface MessageSelectionReference extends ConversationSelectionText {
  id: string;
  sourceSessionId: string;
  sourceRowId: number;
  contentType: ConversationSelectionContentType;
}

export interface MarkdownSelectionReference extends ConversationSelectionText {
  id: string;
  contentType: "markdown";
  sourceKey: string;
  sourceTitle: string;
}

export type ConversationSelectionReference = MessageSelectionReference | MarkdownSelectionReference;

export interface MarkdownSelectionTarget {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
}

export type ConversationSelectionDisplayReference =
  | ConversationSelectionText
  | ConversationSelectionReference;

interface ConversationSelectionAddEventDetail {
  targetSessionId: string | null;
  draftScopeKey?: string;
  workspaceKey: string;
  reference: ConversationSelectionReference;
  result?: ConversationSelectionAppendResult;
}

export type ConversationSelectionLimitReason = "count" | "single" | "total";
export type ConversationSelectionAppendResult =
  | {
      ok: true;
      references: readonly ConversationSelectionReference[];
      duplicate: boolean;
    }
  | { ok: false; reason: ConversationSelectionLimitReason };

const ADD_EVENT = "zcode:conversation-selection-add";
const USER_SELECT_BLOCK_PATTERN = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/;
const LEGACY_BLOCK_PATTERN =
  /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/;
const referencesByScope = new Map<string, readonly ConversationSelectionReference[]>();
const limitReasonByScope = new Map<string, ConversationSelectionLimitReason>();

// 【确定性】scope 键只由三个入参决定，与存储内容无关，可安全用于缓存与断言。
// 【不变量】sessionId 为空时才走草稿分支，草稿键再拼 draftScopeKey，避免匿名草稿共享。
// 【失败路径】draftScopeKey 为空串视作缺省，落到 "__draft__"，不产生两个条目。
// `referenceScopeKey` 的键只供整体比较：调用方解析内部格式后，分隔符变更会静默错配。
function referenceScopeKey(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): string {
  return `${workspaceKey}\0${sessionId ?? (draftScopeKey ? `__draft__:${draftScopeKey}` : "__draft__")}`;
}

// 【确定性】未登记的 scope 一律返回同一空数组，调用方无需区分缺省与空。
// 【不变量】只读返回，不复制数组，写路径必须整体替换而非原地改。
export function getConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): readonly ConversationSelectionReference[] {
  return referencesByScope.get(referenceScopeKey(sessionId, workspaceKey, draftScopeKey)) ?? [];
}

// 【不变量】以空数组写入即删除 scope，存储层不保留空条目。
// 【不变量】任何写入都清掉限流原因，使容量提示跟随最新快照。
// 【失败路径】键计算复用同一函数，避免读写两侧出现不同拼接。
// 【权衡】不做深拷贝，信任调用方传入已冻结的引用数组。
export function setConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
  references: readonly ConversationSelectionReference[],
  draftScopeKey?: string,
): void {
  const key = referenceScopeKey(sessionId, workspaceKey, draftScopeKey);
  if (references.length > 0) referencesByScope.set(key, references);
  else referencesByScope.delete(key);
  limitReasonByScope.delete(key);
}

export function getConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): ConversationSelectionLimitReason | null {
  return limitReasonByScope.get(referenceScopeKey(sessionId, workspaceKey, draftScopeKey)) ?? null;
}

// 【不变量】只清理无草稿的会话 scope，草稿快照需调用方显式覆盖。
// 【失败路径】sessionId 为必填，堵住“清空全部”的过宽调用。
export function clearConversationSelectionReferenceScope(
  sessionId: string,
  workspaceKey: string,
): void {
  referencesByScope.delete(referenceScopeKey(sessionId, workspaceKey));
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey));
}

export function clearConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
  draftScopeKey?: string,
): void {
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey, draftScopeKey));
}

// 【确定性】id 由 createUuid 生成，其余字段原样透传，不参与校验。
// 【权衡】构造不做容量检查，限流只在追加阶段生效，避免重复判定。
export function createConversationSelectionReference(
  input: Omit<MessageSelectionReference, "id"> | Omit<MarkdownSelectionReference, "id">,
): ConversationSelectionReference {
  return { ...input, id: createUuid() };
}

// 【确定性】去重键是字段拼接结果，同内容必得同键，可直接比较。
// 【不变量】markdown 分支取 sourceKey 与正文，忽略标题变化。
// 【不变量】消息分支固定为会话、行号、内容类型、正文四段。
// 【失败路径】漏掉 contentType 会让同段文本的提问与回答互相去重。
// 【权衡】键不持久化，仅进程内比较，因此可随字段演进调整。
export function getConversationSelectionDedupeKey(
  reference: ConversationSelectionReference,
): string {
  if (reference.contentType === "markdown") {
    return ["markdown", reference.sourceKey, reference.text].join("\0");
  }
  return [
    reference.sourceSessionId,
    reference.sourceRowId,
    reference.contentType,
    reference.text,
  ].join("\0");
}

// 【确定性】纯函数，不读全局 Map，不修改 current，结果完全由入参决定。
// 【失败路径】单条超长返回 single，先于数量与总量判定。
// 【不变量】命中重复时返回 duplicate 与同一个数组引用，调用方无需合并。
// 【失败路径】达到条数上限返回 count，不再计算总长度。
// 【失败路径】总量超限返回 total，界面据此展示不同文案。
// 【不变量】成功时返回新数组，顺序为旧项在前、追加项在后。
// 【权衡】不做排序，顺序即用户选择顺序，保证展示稳定。
export function appendConversationSelectionReference(
  current: readonly ConversationSelectionReference[],
  reference: ConversationSelectionReference,
): ConversationSelectionAppendResult {
  if (reference.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
    return { ok: false, reason: "single" };
  }
  const key = getConversationSelectionDedupeKey(reference);
  if (current.some((item) => getConversationSelectionDedupeKey(item) === key)) {
    return { ok: true, references: current, duplicate: true };
  }
  if (current.length >= CONVERSATION_SELECTION_MAX_COUNT) {
    return { ok: false, reason: "count" };
  }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0);
  if (totalLength + reference.text.length > CONVERSATION_SELECTION_MAX_TOTAL_LENGTH) {
    return { ok: false, reason: "total" };
  }
  return { ok: true, references: [...current, reference], duplicate: false };
}

// 【不变量】先试 userselect 块，再试历史块，两级匹配互不重叠。
// 【确定性】同一文本重复解析得到同一可见内容与同一引用序列。
// 【失败路径】两段都没有匹配时原样返回文本并给空引用。
// 【设计权衡】userselect 只保留 path 与正文，丢弃其余历史字段。
// 【不变量】历史块走严格校验，非合法引用对象即视为整块损坏。
// 【失败路径】块标记必须位于文本末尾，尾部解释文字不会被吞。
export function parsePromptConversationSelections(text: string): {
  visibleContent: string;
  references: readonly ConversationSelectionDisplayReference[];
} {
  const userSelectMatch = text.match(USER_SELECT_BLOCK_PATTERN);
  if (userSelectMatch) {
    return parseConversationSelectionBlock(text, userSelectMatch, (value) => {
      if (!isConversationSelectionText(value)) return null;
      // 与发送合同一致，历史保留文件路径，普通对话继续只恢复正文。
      return value.path ? { path: value.path, text: value.text } : { text: value.text };
    });
  }
  const legacyMatch = text.match(LEGACY_BLOCK_PATTERN);
  if (!legacyMatch) return { visibleContent: text, references: [] };
  return parseConversationSelectionBlock(text, legacyMatch, (value) =>
    isConversationSelectionReference(value) ? value : null,
  );
}

// 【失败路径】JSON 解析或形状不对时整体回退，绝不返回半截引用。
// 【不变量】数组元素逐个校验，遇第一个非法项即抛错进入回退。
// 【确定性】可见内容固定为块起始位置之前的文本并去右空白。
// 【不变量】空数组块合法，等价于无引用但仍剥掉块。
// 【权衡】吞掉异常而不上报，历史文本优先保证可读。
function parseConversationSelectionBlock<T extends ConversationSelectionDisplayReference>(
  text: string,
  match: RegExpMatchArray,
  parseItem: (value: unknown) => T | null,
): { visibleContent: string; references: readonly T[] } {
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("selection block is not an array");
    const references: T[] = [];
    for (const value of parsed) {
      const reference = parseItem(value);
      if (!reference) throw new Error("invalid selection reference");
      references.push(reference);
    }
    return {
      visibleContent: text.slice(0, match.index).trimEnd(),
      references,
    };
  } catch {
    return { visibleContent: text, references: [] };
  }
}

// 【不变量】成功时先写 scope 再派发事件，订阅方看到的是新快照。
// 【失败路径】失败时只记录原因，不改引用列表，避免丢已有选区。
// 【不变量】事件 detail 合并 result，订阅方可区分新增与重复。
// 【确定性】读取当前快照走统一入口，避免绕过 scope 键。
// 【失败路径】派发依赖浏览器 window，非渲染进程环境会直接抛错。
// 【权衡】事件名为模块常量，外部只能通过导出的取值函数获得。
export function dispatchConversationSelectionAdd(
  detail: Omit<ConversationSelectionAddEventDetail, "result">,
): ConversationSelectionAppendResult {
  const current = getConversationSelectionReferenceScope(
    detail.targetSessionId,
    detail.workspaceKey,
    detail.draftScopeKey,
  );
  const result = appendConversationSelectionReference(current, detail.reference);
  if (result.ok) {
    setConversationSelectionReferenceScope(
      detail.targetSessionId,
      detail.workspaceKey,
      result.references,
      detail.draftScopeKey,
    );
  } else {
    limitReasonByScope.set(
      referenceScopeKey(detail.targetSessionId, detail.workspaceKey, detail.draftScopeKey),
      result.reason,
    );
  }
  window.dispatchEvent(new CustomEvent(ADD_EVENT, { detail: { ...detail, result } }));
  return result;
}

// 【不变量】同时校验事件类型与 CustomEvent 实例，防止同名普通事件误判。
// 【确定性】谓词无副作用，可在任意事件监听中重复调用。
export function isConversationSelectionAddEvent(
  event: Event,
): event is CustomEvent<ConversationSelectionAddEventDetail> {
  return event.type === ADD_EVENT && event instanceof CustomEvent;
}

export function getConversationSelectionAddEventName(): string {
  return ADD_EVENT;
}

// 【失败路径】非对象、数组与空值一律判假，不做隐式转换。
// 【不变量】text 必须是字符串，path 若存在则必须是非空字符串。
// 【不变量】未知字段即判假，防止携带旧版字段的块被接受。
// 【确定性】只读取属性，不修改入参，可用于解析前的守卫。
function isConversationSelectionText(value: unknown): value is ConversationSelectionText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConversationSelectionText>;
  return (
    typeof candidate.text === "string" &&
    (!("path" in value) ||
      (typeof candidate.path === "string" && candidate.path.trim().length > 0)) &&
    Object.keys(value).every((key) => key === "text" || key === "path")
  );
}

// 【失败路径】markdown 引用要求四个字符串字段齐全，缺一即判假。
// 【不变量】消息引用要求行号为数字、内容类型属于固定枚举。
// 【失败路径】sourceSessionId 与 sourceRowId 必须显式存在，不能靠默认值。
// 【确定性】类型守卫不改变入参，同一对象反复校验结果一致。
// 【权衡】不做深度校验，正文长度在追加阶段才拦截。
export function isConversationSelectionReference(
  value: unknown,
): value is ConversationSelectionReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConversationSelectionReference>;
  if (candidate.contentType === "markdown") {
    return (
      typeof candidate.id === "string" &&
      typeof candidate.text === "string" &&
      typeof candidate.sourceKey === "string" &&
      typeof candidate.sourceTitle === "string"
    );
  }
  return (
    typeof candidate.id === "string" &&
    "sourceSessionId" in candidate &&
    typeof candidate.sourceSessionId === "string" &&
    "sourceRowId" in candidate &&
    typeof candidate.sourceRowId === "number" &&
    typeof candidate.text === "string" &&
    ["user", "assistant", "reasoning", "tool"].includes(candidate.contentType ?? "")
  );
}
