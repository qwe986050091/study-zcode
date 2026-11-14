/* oxlint-disable eslint(max-lines) -- Claude 原生日志解析需要集中维护用户轮次、assistant 自愈和 system warning 归因，拆分会让同一日志语义分散。 */
// Claude 原生 jsonl 的完整解析器：负责用户轮次切分、assistant 聚合与 system 诊断归因。
// 输出结构直接对齐导入源模型，调用方无需再做二次清洗。
import { stat } from "node:fs/promises";
import type { JsonLineRecord } from "#src/session/claude-native/jsonLineRecord.js";
import { readJsonLinesFile } from "#src/session/claude-native/sessionHistoryJsonl.js";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import {
  isObjectRecord,
  readTrimmedString,
} from "#src/session/claude-native/jsonLineRecord.js";
import type { ClaudeNativeImportedSessionSource } from "#src/session/claude-native/claudeNativeImportedSessionTypes.js";

// IDE 注入标签在完整解析阶段同样要剔除，否则会话正文会带无关文件提示。
// 正则与头部解析保持一致，两处口径不能分叉。
const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
// COMMAND_TAG_BLOCK_RE 整段删除命令标签块，标签内是斜杠命令输出而非对话正文。
// 兼容 local-command 与 command 两代标签名。
const COMMAND_TAG_BLOCK_RE =
  /<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;
// 诊断场景只剥标签本身，保留标签内文本作为错误说明。
// 与整段删除不同，这里必须保住用户能看到的失败原因。
const COMMAND_DIAGNOSTIC_TAG_RE = /<\/?(?:local-command|command)-[^>]+>/gi;

// 时间归一口径与头部解析保持一致：秒/毫秒/字符串都转成毫秒整数。
function toTimestampMs(value: unknown): number | undefined {
// 仅接受有限数字，NaN/Infinity 视为缺失。
  if (typeof value === "number" && Number.isFinite(value)) {
// 大于 1e12 视为毫秒时间戳。
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
// 1e9~1e12 之间视为秒级时间戳，乘 1000 转毫秒。
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

// 数字与字符串之外的类型一律无法解析。
  if (typeof value !== "string") {
    return undefined;
  }

// 空字符串直接判缺失，避免 Number("") 得到 0。
// 非空字符串先尝试数字，再尝试日期解析。
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

// 数字字符串递归复用同一套阈值判断。
  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toTimestampMs(numericValue);
  }

// 日期字符串解析失败返回 undefined。
  const parsed = Date.parse(normalized);
// 日期字符串解析失败返回 undefined，交给下一个候选字段。
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 多字段时间候选，顺序即优先级。
function readEntryTimestamp(entry: JsonLineRecord): number | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
// 顶层字段优先，其次 message，最后 request。
  const candidates = [
    entry.timestamp,
    entry.createdAt,
    entry.updatedAt,
    entry.created_at,
    entry.updated_at,
    entry.time,
    message?.timestamp,
    message?.createdAt,
    message?.updatedAt,
    request?.timestamp,
  ];

// 返回第一个可解析的时间，不做合并或平均。
  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return undefined;
}

// workspace 同样跨三层读取，trim 后空串视为缺失。
function readEntryWorkspacePath(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
    readTrimmedString(entry.cwd) ??
    readTrimmedString(message?.cwd) ??
    readTrimmedString(request?.cwd)
  );
}

// 模型名只取显式字段。
function readEntryModel(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return readTrimmedString(entry.model) ?? readTrimmedString(message?.model);
}

// sidechain 记录来自子代理，不属于用户主会话。
function isClaudeNativeSidechainEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
// 三处 sidechain 标记任一命中即排除。
  return entry.isSidechain === true || message?.isSidechain === true || request?.isSidechain === true;
}

// 头部任一行带 sidechain 即整体排除。
export function hasClaudeNativeSidechainMarker(entries: readonly JsonLineRecord[]): boolean {
  return entries.some(isClaudeNativeSidechainEntry);
}

// stop_reason 与 stopReason 两种命名在不同 CLI 版本间并存，都要兼容。
function readAssistantStopReason(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return (
// 下划线命名优先，其次驼峰命名，最后回退到顶层字段。
// 顺序固定，避免同一记录出现两个值时结果漂移。
    readTrimmedString(message?.stop_reason) ??
    readTrimmedString(message?.stopReason) ??
    readTrimmedString(entry.stop_reason) ??
    readTrimmedString(entry.stopReason)
  );
}

// 只有 tool_use 之外的非空 stop_reason 才算终态；tool_use 表示还有后续块。
function isTerminalAssistantStopReason(stopReason: string | undefined): boolean {
// tool_use 不是终态：这一轮还会继续产出工具调用与后续文本。
  return Boolean(stopReason && stopReason !== "tool_use");
}

// 可见文本清洗：去 IDE 标签与命令标签块，统一换行后 trim。
function sanitizeClaudeVisibleText(text: string): string {
  return text
// 用空格替换而不是删除，避免前后单词被粘在一起。
    .replace(IDE_OPENED_FILE_TAG_RE, " ")
// 命令块整段替换为空格，保留段落边界。
    .replace(COMMAND_TAG_BLOCK_RE, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

// 诊断文本只剥命令标签本身，保留标签内的错误说明。
function sanitizeClaudeDiagnosticText(text: string): string {
// 诊断文本只做标签剥离与换行统一，不做其他内容改写。
  return text.replace(COMMAND_DIAGNOSTIC_TAG_RE, " ").replace(/\r\n/g, "\n").trim();
}

// 去掉 SDK 自动追加的 “No response requested.” 结尾占位。
export function stripClaudeNativeSyntheticNoResponsePlaceholderText(text: string): string {
  return text
    .trimEnd()
    .replace(/(?:\n+\s*)?No response requested\.$/u, "")
    .trimEnd();
}

// synthetic 且非 API 错误的记录是控制占位，没有用户可见价值。
function isClaudeNativeSyntheticPlaceholderEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  // Claude Code 会把 SDK 自己生成的控制占位也写成 assistant，
  // 例如 model=<synthetic> 的 "No response requested."。这种占位没有用户可见价值，
  // 但 API Error / 登录错误本身是用户在 Claude 里看到的 assistant 气泡，导入时必须保留。
  return (
// synthetic 模型表示 SDK 自动生成，不是真实模型回复。
    readEntryModel(entry) === "<synthetic>" &&
// API 错误虽然是 synthetic，但属于用户可见气泡，必须保留。
    entry.isApiErrorMessage !== true &&
// message 级错误标记同样参与判定。
    message?.isApiErrorMessage !== true
  );
}

// 内容块统一取字符串、text 或 content 字段。
function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isObjectRecord(value)) {
    return "";
  }

// text 优先于 content，两者都缺失时返回空串。
  return readTrimmedString(value.text) ?? readTrimmedString(value.content) ?? "";
}

// 用户可见文本提取：排除 meta、tool_result 与 IDE 注入内容。
// 多段文本用空行拼接，保留用户原始分段。
// 返回 null 表示这条记录不是有效用户消息。
function extractClaudeUserText(entry: JsonLineRecord): string | null {
// 非 user 类型直接跳过。
  if (entry.type !== "user") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
// meta 记录是内部注入，不是用户输入。
  if (entry.isMeta === true || message?.isMeta === true) {
    return null;
  }

  // 关键业务逻辑：这里只提取“用户真正可见的问题文本”。
  // tool_result / local-command / ide_opened_file 这些内容虽然也会混在 Claude 原生日志里，
  // 但它们属于协议噪音或 IDE 注入信息，直接写进 zcode task 会让导入后的聊天记录失真。
// 正文优先取 message.content，缺失时回退 request.prompt（旧版日志形态）。
  const content =
    message?.content ?? (isObjectRecord(entry.request) ? entry.request.prompt : undefined);
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
// 工具结果块是协议噪音，不能作为用户可见输入。
      if (!isObjectRecord(item) || item.type === "tool_result") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

// 空段落全部过滤后仍为空，返回 null 而不是空字符串。
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// assistant 可见文本：只保留 text 块，丢弃工具调用与占位内容。
// 末尾的 synthetic 占位文案在拼接完成后统一剥离。
function extractClaudeAssistantText(entry: JsonLineRecord): string | null {
// 非 assistant 类型不处理。
  if (entry.type !== "assistant") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (isClaudeNativeSyntheticPlaceholderEntry(entry)) {
    return null;
  }

// 只读 message.content；request 是请求侧内容。
  const content = message?.content;
  if (typeof content === "string") {
    const normalized = sanitizeClaudeVisibleText(content);
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .flatMap((item) => {
      if (typeof item === "string") {
        const normalized = sanitizeClaudeVisibleText(item);
        return normalized.length > 0 ? [normalized] : [];
      }
// assistant 只保留 text 块，工具调用与思考块一律丢弃。
      if (!isObjectRecord(item) || item.type !== "text") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

// 文本块直接拼接，不插分隔符。
  const text = parts.length > 0 ? parts.join("") : "";
  if (!text) {
    return null;
  }
// 剥离占位后仍为空，说明这一轮没有实质回复。
  const visibleText = stripClaudeNativeSyntheticNoResponsePlaceholderText(text);
// visibleText 为空即返回 null，表示本轮没有实质回复。
  return visibleText.length > 0 ? visibleText : null;
}

// 头部摘要：workspace 必须来自首条可见业务消息所在记录。
// 预览标题取首条用户文本，创建时间取该条记录时间。
// 无用户消息时只返回 workspace。
export function extractClaudeNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
// workspacePath 只在首次命中时赋值，之后不再覆盖。
  let workspacePath: string | undefined;

  for (const entry of entries) {
    const userText = extractClaudeUserText(entry);
    const assistantText = extractClaudeAssistantText(entry);
    // 扫描阶段不能用任意头部事件的 cwd 判定 workspace，
    // 因为 queue/progress 等前置记录可能带着更深层的临时 cwd。
    // 这里必须等到第一条“真正可见的业务消息”出现后，才把它的 cwd 视为 session 归属。
// workspace 只在首条可见业务消息处确定。
// 前置控制记录的 cwd 不可信。
    if (!workspacePath && (userText || assistantText)) {
      workspacePath = readEntryWorkspacePath(entry);
    }
// 没有用户文本继续向后找，assistant 先行不产生预览标题。
    if (!userText) {
      continue;
    }

    return {
      workspacePath,
      previewTitle: deriveSessionTitle(userText, []),
      createdAt: readEntryTimestamp(entry),
    };
  }

  return { workspacePath };
}

// 完整解析入口：把日志记录折叠成 user/assistant 交替的导入消息序列。
// assistant 会被聚合成每轮一条，轮次编号从 0 递增。
// 没有任何可见消息时抛错，导入层据此判定该 session 不可用。
export function parseClaudeNativeSessionRecords(params: {
  records: readonly JsonLineRecord[];
  workspacePath: string;
  sessionId: string;
  sourcePath: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): ClaudeNativeImportedSessionSource {
// 累加器全部在函数内初始化，保证同一 records 多次解析结果一致。
  const messages: ClaudeNativeImportedSessionSource["messages"] = [];
// 检测到的 workspace 优先于调用方传值。
  let detectedWorkspacePath: string | undefined;
// 首条可见用户消息的时间作为导入会话的创建时间。
  let firstVisibleUserTimestamp: number | undefined;
// 更新时间从兜底值起步，随后被每条可见消息刷新。
  let updatedAt = params.fallbackUpdatedAt;
  let currentTurnIndex = -1;
// 模型只记录第一个可见 assistant 的模型名。
  let model: string | undefined;
  let pendingAssistantContent = "";
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTimestamp = undefined;
      return;
    }

// 聚合发生在遇到下一条可见用户消息或文件结束时，保证输出仍是“一问一答”。
    // 关键业务逻辑：Claude 原生日志里 assistant 一轮回答可能被拆成多条事件。
    // 这里在遇到下一条可见 user turn 或文件结束时统一聚合，保证导入后的 history
    // 仍然是“用户一轮 + assistant 一轮”的最小可渲染结构。
    messages.push({
// 聚合后的 assistant 消息带当前轮次编号与模型。
      role: "assistant",
      content: pendingAssistantContent,
      timestamp: pendingAssistantTimestamp ?? updatedAt ?? Date.now(),
      ...(model ? { model } : {}),
      turnIndex: currentTurnIndex,
    });
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
    pendingAssistantContent = "";
    pendingAssistantTimestamp = undefined;
  };

// 单遍扫描：遇到用户消息即切轮，assistant 片段累积到下一次切轮。
  for (const entry of params.records) {
    const userText = extractClaudeUserText(entry);
// 首条用户文本所在记录的 cwd 可作为 workspace 归属。
    if (!detectedWorkspacePath && userText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
// 时间优先级：记录时间 > 已累积更新时间 > 当前时间。
      const timestamp = readEntryTimestamp(entry) ?? updatedAt ?? Date.now();
      // createdAt 必须优先取首条可见 user 消息，而不是文件 birthtime。
      // 原生 jsonl 的创建时间可能只是文件落盘时间，不能稳定代表用户真正发起会话的时刻。
// 只有第一次赋值生效，后续用户消息不覆盖创建时间。
      firstVisibleUserTimestamp ??= timestamp;
      updatedAt = timestamp;
      messages.push({
// 用户消息逐条保留，不做聚合。
        role: "user",
        content: userText,
        timestamp,
        turnIndex: currentTurnIndex,
      });
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
// assistant 先行的日志同样要能确定 workspace。
    if (!detectedWorkspacePath && assistantText) {
      detectedWorkspacePath = readEntryWorkspacePath(entry);
    }
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    // synthetic/API error assistant 会被正文过滤，但它也可能带
    // model=<synthetic>。导入 snapshot 的模型只能来自可见模型回复，否则续聊时会把
    // SDK 占位模型当成真实模型参与 session/load 和 set_model 决策。
// 只取第一个可见模型；占位模型已在文本提取阶段被过滤。
    model ??= readEntryModel(entry);
    pendingAssistantContent += assistantText;
// 保留最早可用的 assistant 时间，避免被后续分片覆盖成更晚时间。
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp ?? updatedAt;
    updatedAt = pendingAssistantTimestamp ?? updatedAt;
  }

  flushPendingAssistant();

// 没有任何可见消息时抛错，导入层将其归入 failed。
  if (messages.length === 0) {
    throw new Error(
      `[claude-native] Claude 原生 session ${params.sessionId} 没有可导入的可见消息`,
    );
  }

  return {
// 输出结构固定 provider=claude 并显式写入 migrationSource。
    provider: "claude",
    sessionId: params.sessionId,
// 优先使用日志中检测到的 workspace，缺失时回退调用方传入值。
    workspacePath: detectedWorkspacePath ?? params.workspacePath,
    sourcePath: params.sourcePath,
// createdAt 以首条可见用户消息为准，其次文件时间，最后当前时间。
    createdAt: firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? updatedAt ?? Date.now(),
    updatedAt: updatedAt ?? firstVisibleUserTimestamp ?? params.fallbackCreatedAt ?? Date.now(),
// 标题取第一条用户消息，保证与列表中展示的内容一致。
    title: deriveSessionTitle(messages.find((item) => item.role === "user")?.content ?? "", []),
// 迁移来源与 provider 是两个维度，必须分别记录。
    // 关键业务逻辑：provider=claude 只能说明任务最终由 Claude 续接，
    // 不能区分它是 zcode 内新建的 Claude 任务，还是从 Claude Code 原生历史迁移来的任务。
    // 这里单独写 migrationSource，后续任务列表/统计才能稳定识别迁移来源。
    migrationSource: "claudeCode",
    ...(model ? { model } : {}),
    messages,
  };
}

// 可见 assistant 轮次：用于 prompt 收尾时回填正文，terminal 表示已到终态。
export interface ClaudeNativeVisibleAssistantTurn {
  turnIndex: number;
  content: string;
  terminal: boolean;
  userTimestamp?: number;
  timestamp?: number;
}

// 未知命令告警：命令名与参数分两条 system 记录写入，读取时需要合并。
export interface ClaudeNativeUnknownCommandWarning {
  command: string;
  args?: string;
  timestamp?: number;
}

// prompt 匹配容忍窗口 1 秒：原生日志的 user 时间可能被截断到秒级。
// 参数合并窗口 5 秒：同一次未知命令的两条告警通常紧邻写入。
const CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS = 1_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS = 5_000;
const CLAUDE_NATIVE_UNKNOWN_COMMAND_RE = /^Unknown command:\s*(\S+)/iu;
const CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE = /^Args from unknown skill:\s*(.+)$/iu;

// 轮次匹配时间优先用 userTimestamp，其次 assistant 时间。
function readClaudeNativeTurnMatchTimestamp(
  turn: ClaudeNativeVisibleAssistantTurn,
): number | undefined {
  return turn.userTimestamp ?? turn.timestamp;
}

// 从可见轮次中挑选下界之后的回复：先严格匹配，再回退到容忍窗口。
// 容忍窗口内取日志顺序最后一条，最接近当前 prompt。
// 不向后寻找 terminal，避免当前轮未写完时跳到下一轮正文。
export function selectClaudeNativeVisibleAssistantTurnAfter(
  turns: readonly ClaudeNativeVisibleAssistantTurn[],
  lowerBoundMs: number,
): ClaudeNativeVisibleAssistantTurn | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
// 候选必须带时间且正文非空；无时间的轮次不参与严格匹配。
  const candidates = turns.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= minTimestamp && turn.content.trim().length > 0;
  });
// 严格候选：时间为下界之后，优先命中。
  const strictCandidates = candidates.filter((turn) => {
    const timestamp = readClaudeNativeTurnMatchTimestamp(turn);
    return timestamp !== undefined && timestamp >= lowerBoundMs;
  });
// 严格候选存在时取最早一条，避免把后续轮次误认成本轮回复。
  if (strictCandidates.length > 0) {
    return strictCandidates[0] ?? null;
  }

// 回退候选：assistant 时间缺失或仍在下界之后，排除早于本轮发送的旧轮次。
  const truncatedTimestampCandidates = candidates.filter(
    (turn) => turn.timestamp === undefined || turn.timestamp >= lowerBoundMs,
  );

  // Bugfix: Claude 原生日志 turnIndex 与 ZCode turnIndex 在 session/load、旧错误合成消息、
  // 跨 provider 续接后可能发生漂移。恢复正文时必须优先用 userTimestamp 判断 assistant
  // 归属的用户轮次，否则 session/load 追加的临近 assistant（如 No response requested）
  // 会凭较新的 assistant timestamp 混入本轮，把旧轮次 API Error 当成当前成功回复覆盖掉。
  // Bugfix: 但 Claude 原生日志的 user timestamp 可能被截断到秒级。快速连续 prompt 时，
  // 上一轮 user 也会落进 1s 容忍窗口；这时必须排除 assistant 写入时间早于本轮发送的旧轮次，
  // 并在剩余候选中取日志顺序最后一条，才是最接近当前 prompt 的可见 assistant。
  // 不向后寻找 terminal，避免当前轮还未写终态时误跳到更晚一轮的正文。
// 取日志顺序最后一条最接近当前 prompt；没有候选返回 null。
  return truncatedTimestampCandidates.at(-1) ?? null;
}

// 解析可见轮次：按 user 消息切分，assistant 文本按轮聚合。
// terminal 一旦为真即保持，表示本轮已经出现终态 stop_reason。
export function parseClaudeNativeVisibleAssistantTurns(
  records: readonly JsonLineRecord[],
): ClaudeNativeVisibleAssistantTurn[] {
// 输出只含至少有一段 assistant 文本的轮次。
  const turns: ClaudeNativeVisibleAssistantTurn[] = [];
  let currentTurnIndex = -1;
// 记录当前轮的 user 时间，供 assistant 归属匹配。
  let currentUserTimestamp: number | undefined;
  let pendingAssistantContent = "";
// terminal 与正文一起在 flush 时落盘，避免中途状态泄漏。
  let pendingAssistantTerminal = false;
  let pendingAssistantTimestamp: number | undefined;

  const flushPendingAssistant = () => {
    if (!pendingAssistantContent || currentTurnIndex < 0) {
      pendingAssistantContent = "";
      pendingAssistantTerminal = false;
      pendingAssistantTimestamp = undefined;
      return;
    }

    // 关键业务逻辑：prompt 收尾兜底不能只知道“有正文”，还要知道这一轮
    // Claude 原生日志是否已经写到 end_turn/max_tokens 等终态。否则会把 tool_use
    // 阶段的开场白误当最终回复。
// 只把 pendingAssistantContent 非空且轮次有效的聚合结果 push 进 turns。
    turns.push({
      turnIndex: currentTurnIndex,
      content: pendingAssistantContent,
      terminal: pendingAssistantTerminal,
      ...(currentUserTimestamp !== undefined ? { userTimestamp: currentUserTimestamp } : {}),
      ...(pendingAssistantTimestamp !== undefined ? { timestamp: pendingAssistantTimestamp } : {}),
    });
    pendingAssistantContent = "";
    pendingAssistantTerminal = false;
    pendingAssistantTimestamp = undefined;
  };

  for (const entry of records) {
    const userText = extractClaudeUserText(entry);
    if (userText) {
      flushPendingAssistant();
      currentTurnIndex += 1;
// 记录本轮 user 时间，供后续 assistant 归属判断使用。
      currentUserTimestamp = readEntryTimestamp(entry);
      continue;
    }

    const assistantText = extractClaudeAssistantText(entry);
    if (!assistantText || currentTurnIndex < 0) {
      continue;
    }

    pendingAssistantContent += assistantText;
// 任一分片出现终态即视为终态，后续分片不会撤销。
    pendingAssistantTerminal =
      pendingAssistantTerminal || isTerminalAssistantStopReason(readAssistantStopReason(entry));
// pendingAssistantTimestamp 只取首个分片时间，后续分片不覆盖。
    pendingAssistantTimestamp = readEntryTimestamp(entry) ?? pendingAssistantTimestamp;
  }

  flushPendingAssistant();
// 返回按日志顺序排列的可见轮次。
  return turns;
}

// 从文件读取并解析可见轮次；读文件与解析分两步便于测试注入。
export async function readClaudeNativeVisibleAssistantTurnsFile(
  filePath: string,
): Promise<ClaudeNativeVisibleAssistantTurn[]> {
  const records = await readJsonLinesFile(filePath);
// 文件读取与解析分离，便于对纯函数单独测试。
  return parseClaudeNativeVisibleAssistantTurns(records);
}

// system 诊断文本只接受 warning 级别或 local_command 子类型。
function extractClaudeSystemDiagnosticText(entry: JsonLineRecord): string | null {
// 只有 system 记录可能承载命令诊断。
  if (entry.type !== "system") {
    return null;
  }

// level 与 subtype 都先 trim，缺失或空串不参与判断。
  const level = readTrimmedString(entry.level);
// local_command 子类型即使没有 warning 级别也要纳入。
  const subtype = readTrimmedString(entry.subtype);
// 其他 system 记录属于运行日志，不是用户可见诊断。
  if (level !== "warning" && subtype !== "local_command") {
    return null;
  }

// 正文优先取顶层 content，缺失再取 message.content。
  const content = readTrimmedString(entry.content);
  if (content) {
    // Bugfix: Claude Code 2.1.148 会把未知 slash command 写成
    // system/local_command/info，并将错误包在 local-command-stdout 标签内。
    // 这里只剥标签保留诊断文本，避免继续落到泛化“Agent 未产生任何回复”。
// 只剥命令标签，保留标签内的错误文本。
    return sanitizeClaudeDiagnosticText(content);
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
// message 级 content 同样需要清洗后返回。
  const messageContent = readTrimmedString(message?.content);
  return messageContent ? sanitizeClaudeDiagnosticText(messageContent) : null;
}

// 未知命令告警解析：命令名与参数可能分两条记录写入，需要合并。
// 合并只在时间邻近且上一条尚无参数时进行。
export function parseClaudeNativeUnknownCommandWarnings(
  records: readonly JsonLineRecord[],
): ClaudeNativeUnknownCommandWarning[] {
// 输出按出现顺序累积，参数合并回填到最近一条。
  const warnings: ClaudeNativeUnknownCommandWarning[] = [];

  for (const entry of records) {
    const text = extractClaudeSystemDiagnosticText(entry);
    if (!text) {
      continue;
    }

// readEntryTimestamp 缺失时仍参与合并，但只与同样缺失的记录合并。
    const timestamp = readEntryTimestamp(entry);
// 先用 CLAUDE_NATIVE_UNKNOWN_COMMAND_RE 匹配命令名，命中即新开一条告警。
    const unknownCommandMatch = text.match(CLAUDE_NATIVE_UNKNOWN_COMMAND_RE);
    if (unknownCommandMatch?.[1]) {
// 新命令名先落一条只有 command 的告警。
      warnings.push({
// command 存原始大小写，展示层不做改写。
// 参数留待下一条 Args from unknown skill 记录回填。
        command: unknownCommandMatch[1],
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
      continue;
    }

// 再匹配参数行；只有最近一条尚无参数时才回填。
    const argsMatch = text.match(CLAUDE_NATIVE_UNKNOWN_SKILL_ARGS_RE);
    const latest = warnings.at(-1);
// 没有参数、没有上一条告警或参数已存在时跳过。
    if (!argsMatch?.[1] || !latest || latest.args) {
      continue;
    }

// 用 warnings.at(-1).timestamp 判断本条是否与最近一条同组。
    const latestTimestamp = latest.timestamp;
// 任一时间为空都视为同组，避免因时间缺失而拆散命令与参数。
    const isSameWarningGroup =
      timestamp === undefined ||
      latestTimestamp === undefined ||
      Math.abs(timestamp - latestTimestamp) <= CLAUDE_NATIVE_UNKNOWN_COMMAND_ARGS_MAX_GAP_MS;
// 同组时把参数 trim 后写回最近一条告警。
    if (isSameWarningGroup) {
      // Bugfix: Claude Code 对未知 slash command 会拆成两条 system warning：
      // 一条写命令名，一条写参数。这里合并后才能给 ZCode 用户展示可操作的失败原因。
// 参数只回填一次，重复记录不会覆盖首个值。
      latest.args = argsMatch[1].trim();
    }
  }

  return warnings;
}

// 挑选下界之后的告警：优先严格命中，否则回退到最后一条容忍窗口内的记录。
export function selectClaudeNativeUnknownCommandWarningAfter(
  warnings: readonly ClaudeNativeUnknownCommandWarning[],
  lowerBoundMs: number,
): ClaudeNativeUnknownCommandWarning | null {
  const minTimestamp = lowerBoundMs - CLAUDE_NATIVE_PROMPT_MATCH_TOLERANCE_MS;
// timestamp 缺失的告警始终进 candidates，兼容旧日志。
  const candidates = warnings.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= minTimestamp;
  });
// strictCandidates 要求 timestamp 不早于 lowerBoundMs。
  const strictCandidates = candidates.filter((warning) => {
    return warning.timestamp === undefined || warning.timestamp >= lowerBoundMs;
  });
// 严格命中取最早一条；否则取候选最后一条。
// 优先取 strictCandidates[0]，否则退回 candidates.at(-1)。
  return strictCandidates[0] ?? candidates.at(-1) ?? null;
}

// 文件级入口：读取全部记录后交给纯函数解析。
export async function readClaudeNativeUnknownCommandWarningsFile(
  filePath: string,
): Promise<ClaudeNativeUnknownCommandWarning[]> {
  const records = await readJsonLinesFile(filePath);
// 文件级入口只负责读取，解析逻辑保持纯函数。
  return parseClaudeNativeUnknownCommandWarnings(records);
}

// 文件级解析入口：并发读取记录与 stat，再调用记录级解析。
// 文件时间只作为兜底，优先使用日志内的可见消息时间。
export async function parseClaudeNativeSessionFile(params: {
  filePath: string;
  workspacePath: string;
  sessionId: string;
  sourcePath?: string;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
}): Promise<ClaudeNativeImportedSessionSource> {
// 读文件与 stat 互不依赖，并发执行减少一次串行等待。
  const [records, sourceStat] = await Promise.all([
// 读取全部记录：完整导入需要看到文件末尾的终态。
    readJsonLinesFile(params.filePath),
// stat 只用于兜底时间，不参与内容判断。
    stat(params.filePath),
  ]);

// 文件级解析把 stat 兜底时间一并传入记录级函数。
  return parseClaudeNativeSessionRecords({
    records,
    workspacePath: params.workspacePath,
    sessionId: params.sessionId,
    sourcePath: params.sourcePath ?? params.filePath,
// 兜底创建时间取文件 birthtime，更新取 mtime，均截断为整数毫秒。
    fallbackCreatedAt: params.fallbackCreatedAt ?? Math.trunc(sourceStat.birthtimeMs),
    fallbackUpdatedAt: params.fallbackUpdatedAt ?? Math.trunc(sourceStat.mtimeMs),
  });
}
