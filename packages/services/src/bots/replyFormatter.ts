/* eslint-disable max-lines -- Bot bot reply formatter 集中维护第三方消息的文本颗粒度、工具摘要和权限摘要，避免 provider 间文案分叉。 */
// bots/replyFormatter.ts — 第三方消息的文本颗粒度、工具摘要与权限摘要格式化。
//
// INV-01 所有用户可见文本最终都走 splitLongReplyText，单条不超过 3500 字符；
//        切分优先换行、其次空格，找不到才硬切。
// INV-02 工具调用状态单向终结：completed/failed/denied/stopped 之后不再变更；
//        非终态事件只合并字段，不覆盖已有 title/kind/input。
// INV-03 权限编辑标题必须还原成写入/更新/删除/编辑四类，不能直接透传
//        Agent 的 Edit <path>。
// INV-04 路径展示统一转成 workspace 相对路径 + 正斜杠；命令文本用 inline code 转义。
// INV-05 变更摘要只展示最近 10 个文件，超出部分显式计数，不静默截断。
// INV-06 非终态 chunk 不发送，必须等 force flush（tool_call/task_complete）合并后发送。
// [失败路径] 摘要/权限预览拿不到信息时退化为纯标题，不抛错阻断回复。
import type {
  ZCodePermissionRequest,
  ZCodeStreamEvent,
  ZCodeTaskChangeSummary,
  Locale,
} from "@zcode/shared";
import {
  getCompactToolCallSummary,
  getPermissionRequestPreview,
} from "@zcode/shared";
import { normalizeBotMessageLocale } from "./messages.js";

export interface BotReplyToolCallState {
  // 平台工具 id，作为 map 键。
  toolId: string;
  // 子工具调用指回父调用；顶层工具为 null。
  parentToolUseId?: string | null;
  // 展示标题；缺省回落到 kind。
  title?: string;
  // 工具类型，edit 类会改写路径。
  kind?: string;
  // 入参快照；摘要从中提取命令/路径。
  input?: unknown;
  // 输出快照，摘要可能用到。
  output?: unknown;
  // 状态取自流事件；pending 是新建调用的初始值。
  status?: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  // 仅 failed 时展示，其它状态忽略。
  error?: string;
  // provider 原始载荷，仅供摘要启发式使用。
  raw?: unknown;
}

// BotReplyFormatOptions 只影响展示，不改变语义。
interface BotReplyFormatOptions {
  // 用于把绝对路径转成相对路径；缺省时保留原路径。
  workspacePath?: string;
  // 只影响展示文案，不影响内容。
  locale?: Locale;
}

// 一次 assistant 回复由内容、工具调用、变更摘要三类块组成。
export type BotAssistantReplyBlock =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "tool-call";
      toolCall: BotReplyToolCallState;
    }
  | {
      // 变更摘要块由调用方在任务结束时追加。
      type: "change-summary";
      changeSummary: ZCodeTaskChangeSummary;
    };

// 摘要最多列 10 项，超出用“还有 N 个”提示。
const MAX_TOOL_SUMMARY_ITEMS = 10;
// 单字段截断长度（含省略号）。
const MAX_FIELD_LENGTH = 160;
// 命令/路径这类需要保留首尾的字段单独限制。
const MAX_COMMAND_FIELD_LENGTH = 96;
// 单条消息上限，小于平台限制留出余量。
const MAX_REPLY_MESSAGE_LENGTH = 3500;
// 增删标记固定，变更摘要与权限摘要共用。
const DIFF_ADDED_MARKER = "🟢";
const DIFF_REMOVED_MARKER = "🔴";

// 格式化器私有文案；与 messages.ts 的用户文案分开维护。
const formatterMessages = {
  "zh-CN": {
    toolCalls: "工具调用：",
    completed: "完成",
    failed: "失败",
    denied: "已拒绝",
    inProgress: "⏳ 运行中",
    pending: "等待中",
    permissionRequired: "需要权限：",
    editWriting: "写入中",
    editUpdating: "更新中",
    editDeleting: "删除中",
    editEditing: "编辑中",
    changeSummary: "变更摘要",
    // {count} 由调用方替换，文案层不做复数处理。
    moreToolCalls: "还有 {count} 个工具调用",
    moreFiles: "还有 {count} 个文件",
  },
  // 英文键必须与中文一一对应。
  "en-US": {
    toolCalls: "Tool calls:",
    completed: "Completed",
    failed: "Failed",
    denied: "Denied",
    inProgress: "Running",
    pending: "Pending",
    permissionRequired: "Permission required:",
    editWriting: "Writing",
    editUpdating: "Updating",
    editDeleting: "Deleting",
    editEditing: "Editing",
    changeSummary: "Change summary",
    moreToolCalls: "{count} more tool calls",
    moreFiles: "{count} more files",
  },
} as const;

// 按 locale 取文案；键类型由中文表推导。
function t(locale: Locale | undefined, key: keyof (typeof formatterMessages)["zh-CN"]): string {
  return formatterMessages[normalizeBotMessageLocale(locale)][key];
}

// 宽松对象判定：数组与 null 都不算 record。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 折叠空白为单空格，供单行摘要使用。
function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// truncateText() 保留开头，超长时截断后加 "..."。
function truncateText(value: string, maxLength = MAX_FIELD_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

// 同时保留首尾：首部占 65%，尾部占剩余，中间用 ... 连接。
function truncateMiddleText(value: string, maxLength = MAX_COMMAND_FIELD_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  // 减 5 是给 “ ... ” 预留位置。
  const headLength = Math.ceil((maxLength - 5) * 0.65);
  const tailLength = Math.max(0, maxLength - 5 - headLength);
  return `${value.slice(0, headLength)} ... ${value.slice(value.length - tailLength)}`;
}

// 反斜杠与反引号双重转义；顺序不能反。
function formatMarkdownInlineCode(value: string): string {
  // Telegram Markdown 的 inline code 需要转义反斜杠和反引号，否则路径/命令里的特殊字符会导致文本退回裸显示。
  return `\`${value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`")}\``;
}

// 统一成正斜杠，便于相对路径比较与展示。
function normalizePathSeparators(value: string): string {
  return value.replace(/\\/gu, "/");
}

// 根路径保持原样，其余去掉末尾斜杠。
function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

// 绝对路径 → workspace 相对路径；大小写不敏感比较（Windows 口径）。
function toWorkspaceRelativePath(pathValue: string, workspacePath?: string): string {
  const normalizedPath = stripTrailingSlash(normalizePathSeparators(pathValue.trim()));
  if (!workspacePath?.trim()) {
    return normalizedPath;
  }
  const normalizedWorkspace = stripTrailingSlash(normalizePathSeparators(workspacePath.trim()));
  // 小写比较，兼容 Windows 大小写不敏感。
  const comparablePath = normalizedPath.toLowerCase();
  const comparableWorkspace = normalizedWorkspace.toLowerCase();
  // 工作区根自身返回 "."。
  if (comparablePath === comparableWorkspace) {
    return ".";
  }
  // 前缀匹配必须带分隔符，避免 /a/bc 命中 /a/b。
  if (comparablePath.startsWith(`${comparableWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  return normalizedPath;
}

// 只对 edit 类调用改写路径字段，其它调用原样透传。
function normalizeToolCallSummaryInput(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): unknown {
  if (!isRecord(toolCall.input) || toolCall.kind !== "edit") {
    return toolCall.input;
  }

  // 复制后再改，避免污染调用方状态。
  const nextInput = { ...toolCall.input };
  // 三种 provider 路径字段都要归一。
  for (const key of ["path", "file_path", "filePath"] as const) {
    const value = nextInput[key];
    if (typeof value === "string") {
      nextInput[key] = toWorkspaceRelativePath(value, options?.workspacePath);
    }
  }
  return nextInput;
}

// 摘要详情 = 次要文本 + 变更统计，用 · 连接。
function formatCompactSummaryDetail(
  summary: ReturnType<typeof getCompactToolCallSummary>,
): string | undefined {
  const parts: string[] = [];
  // 次要文本可能是命令/路径，按 inline code 展示。
  if (summary.secondaryText) {
    parts.push(formatMarkdownInlineCode(truncateMiddleText(normalizeInlineText(summary.secondaryText))));
  }
  // summary.changeStat 存在时追加 formatBotDiffCount() 的结果。
  if (summary.changeStat) {
    const stat = formatBotDiffCount(summary.changeStat);
    if (stat) {
      parts.push(stat);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// 只输出非 0 的增删计数，避免 +0/-0 噪声。
function formatBotDiffCount(changeStat: { added: number; removed: number }): string {
  const parts: string[] = [];
  // 增加与删除分别带标记。
  if (changeStat.added > 0) {
    parts.push(`${DIFF_ADDED_MARKER} ${formatMarkdownInlineCode(`+${changeStat.added}`)}`);
  }
  if (changeStat.removed > 0) {
    parts.push(`${DIFF_REMOVED_MARKER} ${formatMarkdownInlineCode(`-${changeStat.removed}`)}`);
  }
  // parts 之间用空格连接，不加额外分隔符。
  return parts.join(" ");
}

// 权限块标题 = “需要权限：” + 具体标题。
function formatPermissionRequestHeader(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  options?: BotReplyFormatOptions,
): string {
  const preview = getPermissionRequestPreview(request);
  // 标题行：固定前缀 + 权限标题。
  return `${t(options?.locale, "permissionRequired")}\n${formatPermissionRequestTitle(request, preview, options)}`;
}

// 非 edit 权限直接用预览标题；edit 权限补充操作类型与目标。
function formatPermissionRequestTitle(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  preview: ReturnType<typeof getPermissionRequestPreview>,
  options?: BotReplyFormatOptions,
): string {
  // 非编辑权限无需补充操作类型。
  if (request.kind !== "edit" || (preview.scope !== "file" && preview.fileChanges.length === 0)) {
    return preview.title;
  }
  // 先由 formatEditPermissionKindLabel() 确定动作类型，再拼目标。
  const label = formatEditPermissionKindLabel(request, preview, options?.locale);
  // 去掉 Agent 的通用 Edit 前缀，保留其后的目标文本。
  const titleWithoutEdit = preview.title.replace(/^edit\b[:：]?\s*/iu, "").trim();
  // 目标优先级：标题剩余文本 → 单文件路径 → 无目标。
  const targetText =
    titleWithoutEdit && titleWithoutEdit !== preview.title
      ? titleWithoutEdit
      : preview.filePaths.length === 1 || preview.fileChanges.length === 1
        ? toWorkspaceRelativePath((preview.filePaths[0] ?? preview.fileChanges[0]?.path)!, options?.workspacePath)
        : "";
  return targetText ? `${label} ${targetText}` : label;
}

// 从标题/描述/raw 推断编辑动作类型（见 INV-03）。
function formatEditPermissionKindLabel(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  preview: ReturnType<typeof getPermissionRequestPreview>,
  locale?: Locale,
): string {
  // 汇总所有可用文本源，逐项过滤非字符串。
  const rawText = [
    request.title,
    request.description,
    isRecord(request.raw) && typeof request.raw.kind === "string" ? request.raw.kind : undefined,
    isRecord(request.raw) && typeof request.raw.title === "string" ? request.raw.title : undefined,
  ].filter((value): value is string => typeof value === "string").join(" ");
  // rawText 统一 trim().toLowerCase() 后做关键词匹配。
  const normalizedText = rawText.trim().toLowerCase();
  // fileChange 的 type 是比文本更可靠的信号。
  const fileChangeType = preview.fileChange?.type;

  // 删除优先判断，避免 delete then create 被误判为写入。
  if (/\b(delete|deleted|remove|removed|erase|erased|unlink|rm)\b/u.test(normalizedText)) {
    return t(locale, "editDeleting");
  }
  // add/write/create 归为写入。
  if (fileChangeType === "add" || /\b(write|wrote|create|created|add|added|save|saved|new)\b/u.test(normalizedText)) {
    return t(locale, "editWriting");
  }
  // update 单独归为更新。
  if (/\b(update|updating|updated)\b/u.test(normalizedText)) {
    return t(locale, "editUpdating");
  }
  // 兜底为“编辑中”，不把原始 Edit 透传给用户。
  // Bugfix: edit 权限标题直接透传 ZCode Agent 的 "Edit <path>" 时，第三方消息无法像 UI kindLabel 一样区分写入/更新/删除。
  // 这里至少把泛化的 Edit 换成 edit kind label，具体操作能从 raw/fileChange 推断时再细分。
  return t(locale, "editEditing");
}

// 单行摘要：状态 · 主文本 · 详情，前缀 “- ” 供列表展示。
export function formatBotToolCallSummaryLine(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): string {
  // 摘要前先把路径归一，保证展示一致。
  const summary = getCompactToolCallSummary({
    title: toolCall.title,
    kind: toolCall.kind ?? "tool",
    input: normalizeToolCallSummaryInput(toolCall, options),
    output: toolCall.output,
    raw: toolCall.raw,
  });
  // failed 状态会附带错误摘要。
  const status = formatToolStatus(toolCall.status, toolCall.error, options?.locale);
  // detail 为 undefined 时不追加分隔符。
  const detail = formatCompactSummaryDetail(summary);
  return `- ${status} · ${summary.primaryText}${detail ? ` · ${detail}` : ""}`;
}

// 五态映射；未知状态按 pending 处理。
function formatToolStatus(
  status?: BotReplyToolCallState["status"],
  error?: string,
  locale?: Locale,
): string {
  // 终态优先匹配，顺序不影响结果。
  if (status === "completed") return t(locale, "completed");
  // 失败附带截断后的错误文本。
  if (status === "failed") return `${t(locale, "failed")}${error ? `: ${truncateText(normalizeInlineText(error))}` : ""}`;
  if (status === "denied") return t(locale, "denied");
  if (status === "in_progress") return t(locale, "inProgress");
  return t(locale, "pending");
}

// 按上限切分，优先换行、其次空格、最后硬切。
function splitLongReplyText(text: string): string[] {
  // 返回值不含空段。
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_REPLY_MESSAGE_LENGTH) {
    // 取最后一个换行或空格作为自然断点。
    const breakpoint = Math.max(
      remaining.lastIndexOf("\n", MAX_REPLY_MESSAGE_LENGTH),
      remaining.lastIndexOf(" ", MAX_REPLY_MESSAGE_LENGTH),
    );
    // 找不到自然断点才硬切。
    const end = breakpoint > 0 ? breakpoint : MAX_REPLY_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  // remaining 不足上限时作为最后一段 push。
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

// 只有 force flush 才产出消息；普通 chunk 只更新缓冲区。
export function extractBotAssistantResponseMessages(
  buffer: string,
  force = false,
): { messages: string[]; rest: string } {
  // 统一换行，避免切分把 CRLF 拆开。
  const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
  // force 为 false 时一律不发送。
  if (!force) {
    // 非终态时原样保留 normalizedBuffer，等待下一次合并。
    return { messages: [], rest: normalizedBuffer };
  }

  // force 时把缓冲区整体切分并清空。
  // Bugfix: Bot channel 的 provider chunk 常按词或子词到达，非终态时必须继续留在
  // assistantReplyBuffer 里合并；真正的发送边界由 tool_call / task_complete 等 force flush 决定。
  return {
    messages: splitLongReplyText(normalizedBuffer),
    rest: "",
  };
}

// “工具调用：” 标题 + 单行摘要。
export function formatBotToolCallReply(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): string {
  return `${t(options?.locale, "toolCalls")}\n${formatBotToolCallSummaryLine(toolCall, options)}`;
}

// 权限块正文：命令优先，其次最多 3 个文件路径。
export function formatBotPermissionRequestSummary(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  options?: BotReplyFormatOptions,
): string {
  const preview = getPermissionRequestPreview(request);
  // header 始终展示，正文按 preview 的可用信息追加。
  const header = formatPermissionRequestHeader(request, options);
  // 命令类权限只展示命令本身。
  if (preview.command) {
    return `${header}\n${formatMarkdownInlineCode(truncateMiddleText(preview.command))}`;
  }
  // 文件路径优先用预览的 filePaths，缺失再从 fileChanges 取。
  const previewFilePaths = preview.filePaths.length > 0
    ? preview.filePaths
    : preview.fileChanges.map((change) => change.path);
  // 最多 3 个路径，整体再截断。
  if (previewFilePaths.length > 0) {
    const paths = previewFilePaths
      .slice(0, 3)
      .map((path) => toWorkspaceRelativePath(path, options?.workspacePath))
      .map((path) => formatMarkdownInlineCode(path))
      .join(", ");
    return `${header}\n${truncateText(paths)}`;
  }
  return header;
}

// 终态判定；stopped 与 denied 同样不再更新。
export function isBotToolCallReplyTerminal(
  status?: BotReplyToolCallState["status"],
): boolean {
  // completed / failed / denied / stopped 四个终态之外都允许更新。
  return status === "completed" ||
    status === "failed" ||
    status === "denied" ||
    status === "stopped";
}

// 变更摘要：总数行 + 最多 10 个文件明细。
function formatBotChangeSummary(
  changeSummary?: ZCodeTaskChangeSummary | null,
  options?: Pick<BotReplyFormatOptions, "locale">,
): string {
  // fileCount 与 files 都必须非空，避免发送空摘要。
  if (!changeSummary || changeSummary.fileCount <= 0 || changeSummary.files.length === 0) {
    return "";
  }
  // 中文用“个文件”，英文用 files，格式不能互串。
  const lines = [
    options?.locale === "en-US"
      ? `${t(options.locale, "changeSummary")}: ${changeSummary.fileCount} files, ${formatBotDiffCount(changeSummary)}`
      : `${t(options?.locale, "changeSummary")}：${changeSummary.fileCount} 个文件，${formatBotDiffCount(changeSummary)}`,
  ];
  // 明细按原顺序截取前 10 个。
  for (const file of changeSummary.files.slice(0, MAX_TOOL_SUMMARY_ITEMS)) {
    lines.push(`- ${formatMarkdownInlineCode(file.path)} (${formatBotDiffCount(file)})`);
  }
  // 超出部分只给数量，避免消息过长。
  if (changeSummary.files.length > MAX_TOOL_SUMMARY_ITEMS) {
    lines.push(`- ${t(options?.locale, "moreFiles").replace("{count}", String(changeSummary.files.length - MAX_TOOL_SUMMARY_ITEMS))}`);
  }
  return lines.join("\n");
}

// 流事件 → 工具状态表；tool_call 新建，update 合并。
export function updateBotReplyToolCalls(
  toolCalls: Map<string, BotReplyToolCallState>,
  event: ZCodeStreamEvent,
): void {
  // 新建调用初始状态固定 pending。
  if (event.type === "tool_call") {
    toolCalls.set(event.toolId, {
      toolId: event.toolId,
      parentToolUseId: event.parentToolUseId ?? null,
      title: event.title,
      kind: event.kind,
      input: event.input,
      raw: event.raw,
      status: "pending",
    });
    return;
  }
  // 其它事件与工具状态无关。
  if (event.type !== "tool_call_update") {
    return;
  }
  // 未见过的 update 也允许创建，兼容事件乱序。
  const existing = toolCalls.get(event.toolId) ?? { toolId: event.toolId };
  toolCalls.set(event.toolId, {
    ...existing,
    // update 缺字段时保留旧值。
    parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId ?? null,
    title: event.title ?? existing.title,
    kind: event.kind ?? existing.kind,
    input: event.input ?? existing.input,
    output: event.content ?? existing.output,
    status: event.status,
    error: event.error ?? existing.error,
    raw: event.raw ?? existing.raw,
  });
}

// 按块顺序拼装消息；每种块都经过长文本切分。
export function formatBotAssistantReplyBlocks(
  blocks: readonly BotAssistantReplyBlock[],
  options?: BotReplyFormatOptions,
): string[] {
  // 输出顺序严格等于块顺序。
  const messages: string[] = [];
  for (const block of blocks) {
    if (block.type === "content") {
      // 正文中的 CRLF 先归一。
      messages.push(...splitLongReplyText(block.content.replace(/\r\n/g, "\n")));
      continue;
    }
      // 工具块格式化成一行摘要后再切分。
    if (block.type === "tool-call") {
      const text = formatBotToolCallReply(block.toolCall, options);
      messages.push(...splitLongReplyText(text));
      continue;
    }
      // 摘要为空时不产生空消息。
    const text = formatBotChangeSummary(block.changeSummary, {
      locale: options?.locale,
    });
    if (text) {
      messages.push(...splitLongReplyText(text));
    }
  }
  return messages;
}
