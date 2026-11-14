// Claude 原生会话“头部”解析：只读前若干行，够判断 workspace、标题与创建时间即可。
// 扫描阶段用轻量解析，不加载完整历史，避免大目录遍历时把每份 jsonl 全读一遍。
import { deriveSessionTitle } from "#src/session/sessionTitle.js";
import {
  isObjectRecord,
  readTrimmedString,
  type JsonLineRecord,
} from "#src/session/claude-native/jsonLineRecord.js";

// IDE 注入标签：记录当前打开文件，不属于用户输入，必须在可见文本中剔除。
// 正则使用非贪婪匹配，避免跨多个标签一次性吞掉中间的真实正文。
// 标签清理只影响“可见性判断”，不改变原始文件内容。
const IDE_OPENED_FILE_TAG_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi;
// 本地命令标签块：Claude 会把斜杠命令的输出包在标签里，属于协议噪音。
// 同时匹配 local-command 与 command 两代标签名，兼容不同 CLI 版本。
const COMMAND_TAG_BLOCK_RE =
  /<(?:local-command|command)-[^>]+>[\s\S]*?<\/(?:local-command|command)-[^>]+>/gi;

// 时间戳归一：把秒/毫秒/ISO 字符串统一成毫秒整数。
// 无法识别的时间返回 undefined，调用方继续尝试下一个候选字段。
// 纪元判断以 1e12 为界：小于该值的数字视为秒级时间戳。
function toTimestampMs(value: unknown): number | undefined {
// 数字必须是有限值；NaN/Infinity 视为缺失而不是 0。
  if (typeof value === "number" && Number.isFinite(value)) {
// 大于 1e12 已可直接视为毫秒，直接截断小数部分。
    if (value > 1_000_000_000_000) {
      return Math.trunc(value);
    }
// 秒级时间戳乘 1000 转毫秒；更小的值视为无效（不是合理的历史时间）。
    if (value > 1_000_000_000) {
      return Math.trunc(value * 1000);
    }
    return undefined;
  }

// 非数字、非字符串直接放弃，避免把对象隐式转换成时间。
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
// 空白串统一归为缺失，调用方无需再对 `normalized` 判空。
  if (!normalized) {
    return undefined;
  }

// 字符串优先按数字解析，兼容被序列化成字符串的时间戳。
  const numericValue = Number(normalized);
  if (Number.isFinite(numericValue)) {
    return toTimestampMs(numericValue);
  }

// 数字解析失败再走日期字符串解析；仍失败则返回 undefined。
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 一条日志可能把时间放在顶层、message 或 request 里，按固定顺序取第一个可用值。
// 顺序体现优先级：越靠前越接近“事件真实发生时间”。
function readEntryTimestamp(entry: JsonLineRecord): number | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
// 候选字段全部做类型归一，缺失字段贡献 undefined 并被跳过。
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

// 找到第一个可解析时间即返回，不做多字段合并。
  for (const candidate of candidates) {
    const timestamp = toTimestampMs(candidate);
// 候选时间为 0 也算有效，不能用真值判断。
    if (timestamp !== undefined) {
      return timestamp;
    }
  }

  return undefined;
}

// workspace 判定同样跨三层读取；trim 后为空串视为缺失。
function readEntryWorkspacePath(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
// 顶层 cwd 优先，其次 message.cwd，最后 request.cwd。
    readTrimmedString(entry.cwd) ??
    readTrimmedString(message?.cwd) ??
    readTrimmedString(request?.cwd)
  );
}

// 模型名只取显式字段，message 内的 model 优先于顶层。
function readEntryModel(entry: JsonLineRecord): string | undefined {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return readTrimmedString(entry.model) ?? readTrimmedString(message?.model);
}

// sidechain 表示子代理/派生会话的记录，导入时应排除，避免把内部推理当成用户会话。
function isClaudeNativeSidechainEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  const request = isObjectRecord(entry.request) ? entry.request : undefined;
  return (
// 三处标记任一为 true 即视为 sidechain。
    entry.isSidechain === true || message?.isSidechain === true || request?.isSidechain === true
  );
}

// 只要头部任意一行带 sidechain 标记就整体排除；宁可漏导也不污染主会话。
export function hasClaudeNativeSidechainMarker(entries: readonly JsonLineRecord[]): boolean {
  return entries.some(isClaudeNativeSidechainEntry);
}

// 可见文本清洗：去 IDE 标签、去命令标签块、统一换行并 trim。
// `sanitizeClaudeVisibleText` 清洗后为空表示这条记录没有用户可见内容。
function sanitizeClaudeVisibleText(text: string): string {
  return text
    .replace(IDE_OPENED_FILE_TAG_RE, " ")
    .replace(COMMAND_TAG_BLOCK_RE, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

// API 错误消息与 <synthetic> 占位模型生成的 assistant 不属于用户可见回复。
function isClaudeNativeNonVisibleAssistantEntry(entry: JsonLineRecord): boolean {
  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  return (
    entry.isApiErrorMessage === true ||
    message?.isApiErrorMessage === true ||
    readEntryModel(entry) === "<synthetic>"
  );
}

// 内容块可能是字符串或 {text}/{content} 对象，两种形态都归一成字符串。
function extractTextField(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

// 非对象内容块没有可读取的文本字段。
  if (!isObjectRecord(value)) {
    return "";
  }

// text 与 content 两种字段名在不同内容块类型中都出现过。
  return readTrimmedString(value.text) ?? readTrimmedString(value.content) ?? "";
}

// 提取“用户真正输入的文本”：排除 meta 记录、tool_result 与 IDE 注入内容。
// 数组内容逐块清洗后以空行拼接；整体为空则返回 null。
// 返回 null 与返回空串语义不同：前者表示这条记录不是用户消息。
function extractClaudeUserText(entry: JsonLineRecord): string | null {
// 只处理 user 类型事件，其余类型由对应提取函数负责。
  if (entry.type !== "user") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
// meta 记录是 CLI 内部注入，不是用户输入。
  if (entry.isMeta === true || message?.isMeta === true) {
    return null;
  }

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
      if (!isObjectRecord(item) || item.type === "tool_result") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

// 多段用户输入用空行分隔，保留原始分段语义。
// 全部段落为空时返回 null，避免产生空消息。
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// 提取 assistant 可见文本：只保留 text 类型内容块，忽略工具调用块。
// 多个文本块直接拼接而不插空行，还原模型连续输出的观感。
// 非可见 assistant（API 错误占位）在此直接丢弃。
function extractClaudeAssistantText(entry: JsonLineRecord): string | null {
// 只处理 assistant 类型事件。
  if (entry.type !== "assistant") {
    return null;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (isClaudeNativeNonVisibleAssistantEntry(entry)) {
    return null;
  }

// 只读 message.content；request 中的内容属于请求侧，不是回复。
// 内容既可能是字符串，也可能是内容块数组。
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
      if (!isObjectRecord(item) || item.type !== "text") {
        return [];
      }
      const normalized = sanitizeClaudeVisibleText(extractTextField(item));
      return normalized.length > 0 ? [normalized] : [];
    })
    .filter((part) => part.length > 0);

// 文本块拼成一个整体后再判断是否为空，避免单块空白导致误判。
  const text = parts.length > 0 ? parts.join("") : "";
  return text.length > 0 ? text : null;
}

// 头部摘要：返回 workspace、预览标题与创建时间，供导入列表展示。
// workspace 只从“第一条可见业务消息”所在记录读取，避免队列/进度记录里的临时 cwd 干扰。
// 找不到任何用户消息时只返回 workspace，由调用方决定是否展示该会话。
export function extractClaudeNativeSessionHeadInfo(entries: readonly JsonLineRecord[]): {
  workspacePath?: string;
  previewTitle?: string;
  createdAt?: number;
} {
// workspace 一旦确定就不再覆盖，保证整份头部只认第一个有效归属。
  let workspacePath: string | undefined;

  for (const entry of entries) {
    const userText = extractClaudeUserText(entry);
    const assistantText = extractClaudeAssistantText(entry);
// 只有出现可见业务消息后，才把该记录的 cwd 视为会话归属。
// 前置的 queue/progress 记录可能带临时 cwd，不能用于判定。
    if (!workspacePath && (userText || assistantText)) {
      workspacePath = readEntryWorkspacePath(entry);
    }
// 没有用户文本就继续找下一条，assistant 先行的情况不产生预览标题。
    if (!userText) {
      continue;
    }

// 首条用户消息同时决定预览标题与创建时间。
// 命中的记录之后不再继续扫描，头部读取到此为止。
    return {
      workspacePath,
// 预览标题复用统一的 session 标题派生规则，与真正导入后的标题保持一致。
// createdAt 取这条首条用户消息的时间，而不是文件时间。
      previewTitle: deriveSessionTitle(userText, []),
      createdAt: readEntryTimestamp(entry),
    };
  }

  return { workspacePath };
}
