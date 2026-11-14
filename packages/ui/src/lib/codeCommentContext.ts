// 代码注释上下文模块：定义从编辑器选区生成聊天附件的数据契约、事件名校验，
// 以及注释 markdown 与附件对象之间的双向编解码，供 UI 把代码片段挂到聊天输入。
// 解析与构造函数均为纯函数，不读写 DOM、不依赖窗口，可在渲染进程外直接单测。
// INV 编号是维护者约定：删除或放宽某条之前先确认没有消费者依赖该行为。
// INV-01 工作区 key 优先取 trim 后的 identity；守住位置：getCodeCommentWorkspaceKey；改错故障：远程会话的去重结果串到本地工作区。
// INV-02 移除 key 两段用路径与 id 中都不会出现的空字符分隔；守住位置：getCodeCommentRemovalKey；改错故障：用冒号拼接时 Windows 盘符让不同工作区的 key 相同。
// INV-03 移除标记只存在进程内集合、不落盘；守住位置：removedCodeCommentKeys；改错故障：重载窗口后已移除的注释又回到聊天里。
// INV-04 标记与取消标记必须幂等；守住位置：markCodeCommentRemoved 与 unmarkCodeCommentRemoved；改错故障：重复操作计数漂移导致注释永久消失。
// INV-05 添加事件需同时满足 type 匹配与 detail 为非空对象；守住位置：isCodeCommentAddToChatEvent；改错故障：无关事件被当作注释插入产生空附件。
// INV-06 移除事件沿用同一套三道校验；守住位置：isCodeCommentRemoveFromChatEvent；改错故障：detail 为空时读取 id 抛异常中断事件链。
// INV-07 移除载荷要求 id 与 workspacePath 为非空字符串；守住位置：isCodeCommentRemovePayload；改错故障：空 id 广播会误删同工作区的其他注释。
// INV-08 移除载荷的可选身份字段只接受 undefined 或 string；守住位置：isCodeCommentRemovePayload 末两行；改错故障：数字身份使 key 与会话身份不一致。
// INV-09 完整载荷额外要求 sourcePath 与 sourceTitle 非空；守住位置：isCodeCommentPayload；改错故障：卡片标题为空，气泡里显示未定义。
// INV-10 选区文本与注释允许空串但类型必须是 string；守住位置：isCodeCommentPayload；改错故障：非字符串内容在拼 markdown 时被隐式转换。
// INV-11 行号必须是有限数字而非 NaN；守住位置：isCodeCommentPayload 的有限性判断；改错故障：行号渲染为 NaN 区间，点击跳转定位失败。
// INV-12 起止行相同时只写一个数字；守住位置：buildCodeCommentMarkdown 的行标签分支；改错故障：折叠选区显示成重复区间，用户误以为选了两行。
// INV-13 文件标签优先 sourcePath、缺失时回退 sourceTitle；守住位置：buildCodeCommentMarkdown；改错故障：无路径注释在 prompt 里丢失可定位信息。
// INV-14 附件为空必须返回空串而非标题；守住位置：buildCodeCommentsBlock 的提前返回；改错故障：聊天输入多出孤立的注释块标题。
// INV-15 每个附件标题带 1 起始序号以支持回解析；守住位置：buildCodeCommentsBlock 的 map 索引；改错故障：多附件合并后无法拆分，退化成一条。
// INV-16 拼接正文时保留空行分隔并整体清理首尾空白；守住位置：buildPromptWithCodeComments；改错故障：正文与注释块粘连导致围栏失效。
// INV-17 正文为空时不得留下前导换行；守住位置：buildPromptWithCodeComments 的分隔三元；改错故障：只有注释的消息开头出现空行。
// INV-18 行范围解析去掉前导 L 并兼容单行与区间两种写法；守住位置：parseLineRange；改错故障：从编辑器复制的带前缀行号被整条丢弃。
// INV-19 解析失败一律返回 null 并由上层过滤；守住位置：parseLineRange 与 parseCodeCommentItem；改错故障：单条坏数据使整段历史消息解析崩溃。
export const CODE_COMMENT_ADD_TO_CHAT_EVENT = "zcode:code-comment-add-to-chat";
export const CODE_COMMENT_REMOVE_FROM_CHAT_EVENT = "zcode:code-comment-remove-from-chat";
export const CODE_COMMENT_REMOVE_BROADCAST_CHANNEL = "code-comment:remove-from-chat";
export const CODE_COMMENT_PREVIEW_RESTORE_BROADCAST_CHANNEL = "code-comment:restore-preview";

export interface CodeCommentRange {
  startLine: number;
  endLine: number;
}

export interface CodeCommentPayload extends CodeCommentRange {
  id?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sourcePath?: string;
  sourceTitle: string;
  selectedText: string;
  comment: string;
  contextLabel?: string;
  commentLabel?: string;
}

export interface CodeCommentComposerAttachment extends CodeCommentPayload {
  id: string;
}

export interface CodeCommentRemovePayload {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface CodeCommentPreview extends CodeCommentRange {
  id: string;
  sourcePath?: string;
  sourceTitle: string;
  selectedText: string;
  comment: string;
}

interface ParsedCodeCommentPrompt {
  visibleContent: string;
  codeCommentAttachments: CodeCommentComposerAttachment[];
}

type CodeCommentAddToChatEvent = CustomEvent<CodeCommentPayload>;
type CodeCommentRemoveFromChatEvent = CustomEvent<CodeCommentRemovePayload>;

const removedCodeCommentKeys = new Set<string>();

// 不变量：身份字段去空白后非空才覆盖路径，否则回退本地路径。
// 故障路径：纯空格身份若被直接采用，远程与本地会话会共用同一个 key 而串注释。
// 权衡：不做归一化或路径解析，避免破坏大小写敏感的类 Unix 路径语义。
export function getCodeCommentWorkspaceKey(workspacePath: string, workspaceIdentity?: string) {
  return workspaceIdentity?.trim() || workspacePath;
}

// 分隔符选择不可见字符，真实文件名与注释 id 中都不会出现，天然避免拼接歧义。
// 故障路径：换成斜杠或冒号时，路径片段与 id 边界可能撞出相同 key，导致误判已移除。
// 纯函数：同一载荷反复调用返回值完全一致，可直接用于集合命中判断。
function getCodeCommentRemovalKey(payload: CodeCommentRemovePayload) {
  return `${getCodeCommentWorkspaceKey(payload.workspacePath, payload.workspaceIdentity)}\0${payload.id}`;
}

// 只读查询：不修改集合，渲染期间可安全重复调用。
// 故障路径：若在这里顺手清理过期标记，取消删除的时序会丢失已移除这一事实。
export function isCodeCommentMarkedRemoved(payload: CodeCommentRemovePayload) {
  return removedCodeCommentKeys.has(getCodeCommentRemovalKey(payload));
}

export function markCodeCommentRemoved(payload: CodeCommentRemovePayload) {
  removedCodeCommentKeys.add(getCodeCommentRemovalKey(payload));
}

export function unmarkCodeCommentRemoved(payload: CodeCommentRemovePayload) {
  removedCodeCommentKeys.delete(getCodeCommentRemovalKey(payload));
}

// 类型守卫只做结构判断，不深校验 detail 内部字段，派发方已按载荷类型构造。
// 故障路径：漏掉 detail 非空的判断会在读取属性时抛类型错误。
// 先比对事件名再探测 detail，热路径上省掉无谓的属性读取。
export function isCodeCommentAddToChatEvent(event: Event): event is CodeCommentAddToChatEvent {
  return (
    event.type === CODE_COMMENT_ADD_TO_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

export function isCodeCommentRemoveFromChatEvent(
  event: Event,
): event is CodeCommentRemoveFromChatEvent {
  return (
    event.type === CODE_COMMENT_REMOVE_FROM_CHAT_EVENT &&
    "detail" in event &&
    typeof (event as CustomEvent<unknown>).detail === "object" &&
    (event as CustomEvent<unknown>).detail !== null
  );
}

// 收窄顺序：先判对象与空值，再逐字段判类型，避免直接访问未知形状。
// 不变量：id 与工作区路径都要求非空，空串会污染移除标记集合。
// 可选字段只接受 undefined 或字符串，显式 null 视为非法而非未提供。
export function isCodeCommentRemovePayload(payload: unknown): payload is CodeCommentRemovePayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as CodeCommentRemovePayload).id === "string" &&
    (payload as CodeCommentRemovePayload).id.length > 0 &&
    typeof (payload as CodeCommentRemovePayload).workspacePath === "string" &&
    (payload as CodeCommentRemovePayload).workspacePath.length > 0 &&
    ((payload as CodeCommentRemovePayload).workspaceIdentity === undefined ||
      typeof (payload as CodeCommentRemovePayload).workspaceIdentity === "string")
  );
}

// 与移除载荷的差异：这里额外要求来源路径与标题非空，
// 因为附件卡片必须能显示可点击的文件名，缺路径的注释无法定位。
// 行号只校验有限性，不校验正负与先后，跨行选区合法性由编辑器保证。
// 故障路径：放宽选区文本类型，会让非字符串内容在拼 markdown 时被隐式转换。
export function isCodeCommentPayload(payload: unknown): payload is CodeCommentPayload {
  const candidate = payload as CodeCommentPayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined ||
      typeof candidate.workspaceIdentity === "string") &&
    typeof candidate.sourcePath === "string" &&
    candidate.sourcePath.length > 0 &&
    typeof candidate.sourceTitle === "string" &&
    candidate.sourceTitle.length > 0 &&
    typeof candidate.selectedText === "string" &&
    typeof candidate.comment === "string" &&
    Number.isFinite(candidate.startLine) &&
    Number.isFinite(candidate.endLine)
  );
}

// 输出是单条注释片段，字段顺序即解析契约：文件、行号、选区文本、注释。
// 不变量：起止行号相同时只写单个数字，避免冗余的重复区间表达。
// 故障路径：选区文本不清理首尾空白就插入，会破坏下方三重反引号围栏的闭合。
// 注释体也过 `trim()`，粘贴内容带进来的首尾空行不会写进围栏。
// 不读取任何外部状态，相同载荷永远产出相同 markdown。
function buildCodeCommentMarkdown(payload: CodeCommentPayload) {
  const lineLabel =
    payload.startLine === payload.endLine
      ? String(payload.startLine)
      : `${payload.startLine}-${payload.endLine}`;

  return `## Comment\nFile: ${payload.sourcePath ?? payload.sourceTitle}\nSide: R\nLines: ${lineLabel}\nSelected text:\n\`\`\`\n${payload.selectedText.trim()}\n\`\`\`\nComment:\n${payload.comment.trim()}\n`;
}

// 空列表直接返回空串，上层用一个假值判断即可覆盖无附件场景。
// 序号从 1 开始，与解析时按注释标题切分保持一一对应。
// 故障路径：漏掉序号会生成重复标题，切分后只剩最后一条。
// 条目之间用单换行拼接而非双换行，防止解析器把条目误判为独立段落。
function buildCodeCommentsBlock(attachments: readonly CodeCommentComposerAttachment[]) {
  if (attachments.length === 0) {
    return "";
  }

  return `# Code comments:\n\n${attachments
    .map((attachment, index) =>
      buildCodeCommentMarkdown(attachment).replace("## Comment", `## Comment ${index + 1}`),
    )
    .join("\n")}`;
}

// 不变量：返回值首尾空白一定被清理，调用方可直接写入消息输入框。
// 正文为空时省略分隔空行，否则消息以空行开头影响气泡排版。
// 故障路径：先清理再加块会吃掉块前换行，解析器匹配不到块起始锚点。
// 纯函数：不依赖窗口或存储，任意正文与附件组合都可直接断言。
export function buildPromptWithCodeComments(
  text: string,
  attachments: readonly CodeCommentComposerAttachment[],
) {
  const content = text.trimEnd();
  const commentsBlock = buildCodeCommentsBlock(attachments);
  if (!commentsBlock) {
    return content.trim();
  }

  return `${content}${content ? "\n\n" : ""}${commentsBlock}`.trim();
}

// 同时按正斜杠与反斜杠切分以兼容 Windows 与类 Unix 路径，末尾多余斜杠会被过滤。
// 故障路径：只按正斜杠切分时 Windows 路径整串成为标题，气泡里显示完整长路径。
function getSourceTitle(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// `parseLineRange` 覆盖纯数字 / 区间 / 带 `L` 前缀 / 前缀区间四种复制格式。
// 先统一去掉行首前缀，再交给单一正则解析，避免分支爆炸。
// 单行写法复用起始行作为结束行，保证返回区间总是闭合。
// 解析失败返回空值而不抛错，坏数据由调用方按条目丢弃。
function parseLineRange(value: string): CodeCommentRange | null {
  const normalized = value.trim().replace(/^L/i, "");
  const match = /^(\d+)(?:\s*-\s*L?(\d+))?$/.exec(normalized);
  if (!match) {
    return null;
  }

  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  return {
    startLine,
    endLine,
  };
}

// 逐字段用正则抽取，任一必填项缺失即返回空值，绝不构造半成品附件。
// 不变量：id 由序号与行区间拼成，同一 prompt 内稳定可复现，便于去重与取消删除。
// 故障路径：身份为空串时若展开该字段，会生成显式空值而非省略，key 随之变化。
// 选区文本与注释都清理首尾空白，抵掉围栏带来的换行差异。
// 不做文件存在性校验，文件是否仍在磁盘由使用者决定。
function parseCodeCommentItem(
  rawItem: string,
  index: number,
  workspacePath: string,
  workspaceIdentity?: string,
): CodeCommentComposerAttachment | null {
  const fileMatch = /^File:\s*(.+)$/m.exec(rawItem);
  const linesMatch = /^Lines:\s*(.+)$/m.exec(rawItem);
  const selectedTextMatch =
    /Selected text:\s*\n```(?:[^\n`]*)?\n([\s\S]*?)\n```\s*\nComment:\s*\n?([\s\S]*)$/m.exec(
      rawItem,
    );
  if (!fileMatch || !linesMatch || !selectedTextMatch) {
    return null;
  }

  const filePath = fileMatch[1];
  const lines = linesMatch[1];
  const selectedText = selectedTextMatch[1];
  const rawComment = selectedTextMatch[2];
  if (!filePath || !lines || selectedText === undefined || rawComment === undefined) {
    return null;
  }

  const range = parseLineRange(lines);
  if (!range) {
    return null;
  }

  const sourcePath = filePath.trim();
  const comment = rawComment.trim();

  return {
    id: `parsed-code-comment-${index + 1}-${range.startLine}-${range.endLine}`,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    sourcePath,
    sourceTitle: getSourceTitle(sourcePath),
    startLine: range.startLine,
    endLine: range.endLine,
    selectedText: selectedText.trim(),
    comment,
  };
}

// 入口契约：内容中没有注释块时原样返回正文并给出空附件列表。
// 块起始锚点要求行首或两个换行，避免把正文中同名普通文本误识别为注释块。
// 故障路径：末端锚点若开启多行模式，非贪婪匹配会在首个条目后提前截断。
// 切分使用标题前换行做前瞻，保持条目顺序与写入顺序一致。
// 可见正文取块起始位置之前的切片，注释文本不会重复出现在气泡里。
export function parsePromptCodeComments(
  content: string,
  options: {
    workspacePath: string;
    workspaceIdentity?: string;
  },
): ParsedCodeCommentPrompt {
  // 这里不能使用 multiline 的 `$`，否则非贪婪匹配会在第一行 `## Comment 1` 后提前停止，
  // 导致持久化消息无法解析回 comment 附件，只能把原始 markdown 暴露在聊天气泡里。
  const blockMatch = /(?:^|\n\n)# Code comments:\s*\n\n([\s\S]*?)\s*$/.exec(content);
  if (!blockMatch || blockMatch.index < 0) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }

  const rawBlock = blockMatch[1];
  if (rawBlock === undefined) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }
  const rawItems = rawBlock
    .split(/\n(?=## Comment(?:\s+\d+)?\n)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const codeCommentAttachments = rawItems
    .map((item, index) =>
      parseCodeCommentItem(item, index, options.workspacePath, options.workspaceIdentity),
    )
    .filter((item): item is CodeCommentComposerAttachment => item !== null);

  if (codeCommentAttachments.length === 0) {
    return {
      visibleContent: content,
      codeCommentAttachments: [],
    };
  }

  return {
    visibleContent: content.slice(0, blockMatch.index).trimEnd(),
    codeCommentAttachments,
  };
}

// 返回值是被取消语义：派发返回假值说明监听方已接管该注释。
// 故障路径：事件不可取消时监听方的阻止动作失效，注释被重复插入两次。
// `dispatchCodeCommentAddToChat` 返回 true 表示监听方已接管，调用方不再执行默认插入。
export function dispatchCodeCommentAddToChat(payload: CodeCommentPayload) {
  const event = new CustomEvent(CODE_COMMENT_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

// 先本地记账再派发，监听方即使同步抛错，移除事实也已写入标记集合。
// 故障路径：顺序反过来时渲染异常会让注释在下次重绘后重新出现。
// 派发不等待，事件处理是同步的，调用方无需感知异步边界。
export function dispatchCodeCommentRemoveFromChat(payload: CodeCommentRemovePayload) {
  markCodeCommentRemoved(payload);
  window.dispatchEvent(
    new CustomEvent(CODE_COMMENT_REMOVE_FROM_CHAT_EVENT, {
      detail: payload,
    }),
  );
}
