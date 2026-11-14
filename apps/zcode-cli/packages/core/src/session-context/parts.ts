import { type MessagePart } from "@zcode/contracts";
import { safeJson, truncateText } from "./utils.js";

// 系统注入的 <system-reminder> 段落重放时必须剔除：它属于运行时提示而非
// 用户/助手事实，重复注入会占用预算并让模型重复处理同一提醒。
const SYSTEM_REMINDER_PATTERN = /<\/?system-reminder\b/i;
// 工具输入预览上限（字符）：输入是结构化参数，短预览已足够表达调用意图。
const TOOL_INPUT_PREVIEW_CHARS = 900;
// 工具输出预览上限（字符）：输出可能包含大段文件内容，放宽上限但仍需截断。
const TOOL_OUTPUT_PREVIEW_CHARS = 1600;
// 普通文本/子任务提示词的预览上限（字符），是单条消息正文的主要预算来源。
const TEXT_PART_PREVIEW_CHARS = 3000;
// 文件附件正文预览上限（字符）；完整文件内容不进入会话转录。
const FILE_PREVIEW_CHARS = 1600;

// 这些 source 的 synthetic 文本是一次性的运行时通知（后台任务回执、子代理消息、
// 诊断、todo 提醒、记忆更新等），只在当轮有效；重放会把过期运行时状态当成用户事实。
// 未列入的 synthetic 文本仍保留，避免误删有效的合成内容（如压缩摘要）。
const SKIPPED_SYNTHETIC_TEXT_SOURCES = new Set([
  "background_task",
  "subagent_message",
  "diagnostics",
  "goal_state_change",
  "hook_context",
  "memory_update",
  "model_anomaly",
  "queued_system_notification",
  "relevant_memory",
  "runtime_mode",
  "todo_reminder",
]);

// 把一条消息 part 投影为会话上下文里的纯文本片段。
// 输入为契约层 MessagePart；返回 null 表示该 part 不参与重放（被用户忽略、系统提醒、
// 已列入跳过清单的合成文本，以及 reasoning/snapshot/step-start/timeline 等过程性 part）。
// 输出为可含换行的字符串；调用方在 part 之间用 "\n\n" 拼接。
// 纯函数、不抛错、不修改入参：所有长度控制只作用于本地字符串。
// 维护的不变量：同一 part 重复投影结果一致；tool part 只暴露预览，不携带附件二进制。
export function formatPartForContext(part: MessagePart): string | null {
  switch (part.type) {
    case "text":
      // 用户显式忽略的文本不再注入，防止模型把被排除的内容当作事实继续推断。
      if (part.ignored) return null;
      // 运行时 system-reminder 不重放，避免同一提醒在历史中反复出现。
      if (SYSTEM_REMINDER_PATTERN.test(part.text)) return null;
      // 仅跳过清单内的合成来源；判断 source 是否存在且为字符串，其他情况按普通文本保留。
      if (part.synthetic && shouldSkipSyntheticTextPart(part.metadata?.source)) return null;
      return truncateText(part.text, TEXT_PART_PREVIEW_CHARS);
    case "file":
      return formatFilePart(part);
    case "agent":
      return `[Selected agent: ${part.name}]`;
    case "subtask":
      return [
        `[Subtask: ${part.description}]`,
        part.command ? `command: ${part.command}` : undefined,
        `prompt: ${truncateText(part.prompt, TEXT_PART_PREVIEW_CHARS)}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "tool":
      return formatToolPart(part);
    case "patch":
      return `Patch files: ${part.files.join(", ")}`;
    case "compaction":
      // 压缩摘要优先用时间线文本，其次用原因；两者都没有则视为不可读内容。
      return part.timelineText ?? part.reason ?? null;
    case "retry":
      return `Retry ${part.attempt}: ${part.error.name}`;
    case "step-finish":
      return `Step finished: ${part.reason}`;
    case "reasoning":
    case "snapshot":
    case "step-start":
    case "timeline":
      // 过程性/派生状态不重放：模型重读中间态会重复推理，且对最终结论无增益。
      return null;
  }
}

// 按 part.id 去重：同一 id 保留最后一次写入的值（Map 后写覆盖前写），
// 但顺序仍按该 id 首次出现的位置，保证消息内 part 的原始阅读顺序。
// 用于消息冷恢复/流式写入可能产生重复 part 的场景。空数组返回空数组，不修改入参。
export function dedupeParts(parts: MessagePart[]): MessagePart[] {
  return [...new Map(parts.map((part) => [part.id, part])).values()];
}

// 判断合成文本的 source 是否属于"不应重放"的运行时通知来源。
// source 缺失或非字符串时返回 false（宽松降级），宁可保留内容也不误删有效文本。
function shouldSkipSyntheticTextPart(source: unknown): boolean {
  return typeof source === "string" && SKIPPED_SYNTHETIC_TEXT_SOURCES.has(source);
}

// 把文件 part 投影为 "File attachment" 头部行（文件名、mime、来源路径）+ 可选正文预览。
// 预览优先取 metadata.preview.text（冷恢复后的持久化预览），否则回退 source.text.value；
// 两者都缺失时只返回头部行。预览按 FILE_PREVIEW_CHARS 截断，不等于文件真实内容。
function formatFilePart(part: Extract<MessagePart, { type: "file" }>): string {
  const path = fileSourcePath(part);
  const preview = part.metadata?.preview?.text ?? part.source?.text.value;
  const header = [
    "File attachment",
    part.filename ? `filename=${part.filename}` : undefined,
    `mime=${part.mime}`,
    path ? `path=${path}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  // 预览缺失是合法状态（例如二进制附件尚未生成预览），此时仍返回可识别的头部行。
  if (!preview) return header;
  return [header, truncateText(preview, FILE_PREVIEW_CHARS)].join("\n");
}

// 解析文件 part 的来源路径：resource 类型取 uri，其余取 path。
// source 缺失时返回 undefined，调用方据此省略 path= 字段；不抛错。
function fileSourcePath(part: Extract<MessagePart, { type: "file" }>): string | undefined {
  if (!part.source) return undefined;
  if (part.source.type === "resource") return part.source.uri;
  return part.source.path;
}

// 把工具 part 投影为多行文本：首行 "Tool <name> <status>"，随后是输入预览，
// 并按状态二选一追加 completed.output / error.error / pending.raw。
// 只读取 part.state，不触发工具执行；输入输出均截断，避免大结果回灌上下文。
// 失败状态只输出错误文本本身，不带堆栈，保持预览口径。
function formatToolPart(part: Extract<MessagePart, { type: "tool" }>): string {
  const lines = [`Tool ${part.tool} ${part.state.status}`];
  // pending/running 也可能已带 input，因此按字段存在性判断，而不是按状态白名单。
  if ("input" in part.state) {
    lines.push(`input: ${truncateText(safeJson(part.state.input), TOOL_INPUT_PREVIEW_CHARS)}`);
  }
  if (part.state.status === "completed") {
    lines.push(`output: ${truncateText(part.state.output, TOOL_OUTPUT_PREVIEW_CHARS)}`);
  } else if (part.state.status === "error") {
    // 失败时只取 error 文本：堆栈与结构化详情不进入会话转录，避免泄露内部实现。
    lines.push(`error: ${truncateText(part.state.error, TOOL_OUTPUT_PREVIEW_CHARS)}`);
  } else if (part.state.status === "pending") {
    // 未执行完成时还没有解析后的结果，只有原始参数串 raw，按输入预算截断。
    lines.push(`raw: ${truncateText(part.state.raw, TOOL_INPUT_PREVIEW_CHARS)}`);
  }
  return lines.join("\n");
}
