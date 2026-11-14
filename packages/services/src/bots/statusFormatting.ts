// bots/statusFormatting.ts — /status 的时长、进度与工具摘要格式化。
//
// INV-01 时长一律按秒级展示；纯函数不读时钟，running 的“已工作”在
//        readTaskWorkedDurationMs 里单独计算。
// INV-02 运行中时长从最后一条 assistant 消息时间戳起算，没有则回落到 user，
//        最后才用 task 时间；顺序不能颠倒，否则会把排队时间算进工作时长。
// INV-03 进度只从 assistant 消息取；用户 prompt 不是进展（历史 Bug）。
// INV-04 进度单行化并截断：普通状态 180 字符，live 状态保留末尾 1000 字符，
//        因为 live 输出更关心最新内容。
// [边界] 负数时长钳到 0；空 parts 至少输出 0s。
import {
  type ZCodePersistedToolCall,
  type ZCodeSessionFile,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { buildPerTurnChangeSummaries } from "../session/taskChangeSummary.js";

const MS_IN_SECOND = 1_000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const MS_IN_HOUR = 60 * MS_IN_MINUTE;
const MS_IN_DAY = 24 * MS_IN_HOUR;

// 缺省视为 running；未知状态交给上层展示原文。
export function taskStatus(task: ZCodeTaskMeta): string {
  return task.status ?? "running";
}

// 固定 d/h/m/s 顺序，0 单位省略，全 0 时输出 0s。
export function formatTaskRunningDuration(durationMs: number): string {
  // 时钟回拨可能产生负值，统一钳到 0。
  const safeDurationMs = Math.max(durationMs, 0);
  const days = Math.floor(safeDurationMs / MS_IN_DAY);
  const hours = Math.floor((safeDurationMs % MS_IN_DAY) / MS_IN_HOUR);
  const minutes = Math.floor((safeDurationMs % MS_IN_HOUR) / MS_IN_MINUTE);
  const seconds = Math.floor((safeDurationMs % MS_IN_MINUTE) / MS_IN_SECOND);
  const parts: string[] = [];

  // 只有非 0 单位才输出。
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  // 秒始终兜底，保证至少一个单位。
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

// 起算点优先级：assistant → user → task 时间（见 INV-02）。
function readRunningTaskStartedAt(snapshot: ZCodeSessionFile | null, task: ZCodeTaskMeta): number | null {
  const messages = snapshot?.messages ?? [];
  // 优先最后一条 assistant，表示模型真正开始产出的时刻。
  const assistantStartedAt = messages.findLast((message) => message.role === "assistant")?.timestamp;
  if (assistantStartedAt !== undefined) {
    return assistantStartedAt;
  }
  const userStartedAt = messages.findLast((message) => message.role === "user")?.timestamp;
  if (userStartedAt !== undefined) {
    return userStartedAt;
  }
  // 都缺失时返回 null，由调用方决定不展示时长。
  return task.createdAt ?? task.updatedAt ?? null;
}

// Task 行只含标题与 id；时长由 Worked 行独立展示。
export function formatStatusTaskLine(task: ZCodeTaskMeta, label = "Task"): string {
  return `${label}: ${task.title} (${task.taskId})`;
}

// running 用当前时刻差；completed 用落盘的 durationMs。
export function readTaskWorkedDurationMs(snapshot: ZCodeSessionFile | null, task: ZCodeTaskMeta): number | null {
  const status = taskStatus(task);
  if (status === "running") {
    // 快照可能为空；此时只能依赖 task 自身时间。
    const startedAt = readRunningTaskStartedAt(snapshot, task);
    if (startedAt === null) {
      return null;
    }
    // Bugfix: 第三方 /status 之前把运行时长塞进 Task 行；这里按 UI 的已工作时长语义单独输出 Worked。
    // 同样钳到 0，容忍时钟回拨。
    return Math.max(Date.now() - startedAt, 0);
  }
  // 完成态优先取 snapshot 上报的 actualDurationMs，缺失时才回退墙钟差值。
  const completedDurationMs = snapshot?.messages.findLast((message) => message.role === "assistant")?.durationMs;
  if (completedDurationMs !== undefined) {
    return completedDurationMs;
  }
  // 没有 durationMs 时退化为创建到更新的时间差。
  if (task.updatedAt !== undefined && task.createdAt !== undefined && task.updatedAt >= task.createdAt) {
    return task.updatedAt - task.createdAt;
  }
  return null;
}

// 只取最后一条带 turnIndex 的 assistant 对应轮次（见 INV-03）。
export function readLatestAssistantTurnChangeSummary(snapshot: ZCodeSessionFile | null): ZCodeTaskMeta["changeSummary"] | null {
  // 无文件变更直接返回 null，避免空摘要。
  if (!snapshot?.fileChanges || snapshot.fileChanges.length === 0) {
    return null;
  }
  // turnIndex 缺失的消息无法归属轮次，跳过。
  const latestAssistantTurnIndex = snapshot.messages.findLast(
    (message) => message.role === "assistant" && message.turnIndex !== undefined,
  )?.turnIndex;
  if (latestAssistantTurnIndex === undefined) {
    return null;
  }

  // Bugfix: meta.changeSummary 是任务级聚合摘要，会把历史轮次合并进第三方消息。
  // 第三方完成回复只应该展示本轮 assistant 对应 turnIndex 的文件变更。
  // 按轮次重建摘要，而不是用任务级聚合。
  const summary = buildPerTurnChangeSummaries(snapshot.fileChanges).get(latestAssistantTurnIndex) ?? null;
  // 空摘要按无变更处理。
  return summary && summary.fileCount > 0 && summary.files.length > 0 ? summary : null;
}

// 单行化：折叠所有空白，便于嵌入一行状态。
export function normalizeStatusProgressText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// 保留开头，省略号占 3 字符。
function truncateStatusProgressText(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

// live 状态保留末尾，因为最新内容在尾部（见 INV-04）。
export function truncateLiveStatusProgressText(value: string, maxLength = 1000): string {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

// 字符串或对象中按优先键取值；对象形态来自不同 provider。
function readStatusStringField(value: unknown, keys: readonly string[]): string | null {
  if (typeof value === "string") {
    const text = normalizeStatusProgressText(value);
    return text || null;
  }
  // 数组不参与取键，避免把元素误当字段。
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const text = normalizeStatusProgressText(candidate);
      if (text) {
        return text;
      }
    }
  }
  return null;
}

// 工具进度：标题 + 状态 + 关键入参/输出。
function formatStatusToolProgress(tool: ZCodePersistedToolCall | undefined): string | null {
  if (!tool) {
    return null;
  }
  // 标题兜底顺序：title → toolName → kind → tool。
  const title = normalizeStatusProgressText(tool.title ?? tool.toolName ?? tool.kind ?? "tool");
  const detail =
  // 详情优先看输入，其次输出，最后 raw。
    readStatusStringField(tool.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.output, ["command", "path", "file_path", "filePath", "prompt"]) ??
    readStatusStringField(tool.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = tool.status ? ` [${tool.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

// 流式事件版本：content 是增量字段，需单独探测。
export function formatStatusStreamToolProgress(event: Extract<ZCodeStreamEvent, { type: "tool_call" | "tool_call_update" }>): string | null {
  const title = normalizeStatusProgressText(event.title ?? event.kind ?? "tool");
  const detail =
    readStatusStringField(event.input, ["command", "path", "file_path", "filePath", "prompt"]) ??
  // 只有存在 content 字段的事件才读增量。
    ("content" in event ? readStatusStringField(event.content, ["command", "path", "file_path", "filePath", "prompt"]) : null) ??
    readStatusStringField(event.raw, ["command", "path", "file_path", "filePath", "prompt"]);
  const status = "status" in event && event.status ? ` [${event.status}]` : "";
  return detail ? `${title}${status}: ${detail}` : `${title}${status}`;
}

// 从最近的 assistant 消息向前找第一个可展示内容。
export function readLatestTaskProgress(snapshot: ZCodeSessionFile | null): string | null {
  const messages = snapshot?.messages ?? [];
  for (const latestMessage of [...messages].reverse()) {
    // 跳过用户/系统消息（见 INV-03）。
    if (latestMessage.role !== "assistant") {
      continue;
    }
    // Bugfix: /status 的 Progress 之前直接读最后一条 message，最后落盘如果是用户 prompt，
    // 第三方客户端看到的就会是“用户刚问了什么”，不是 task 的真实执行进展。
    // 这里只从最近的 assistant 消息读取 content/thought/tool-call，避免把用户输入误报为进度。
    // parts 逆序：同一消息内也优先最新片段。
    for (const part of [...(latestMessage.parts ?? [])].reverse()) {
      // content 与 thought 同级，逆序遍历取最新非空片段作为正文。
      if ((part.type === "content" || part.type === "thought") && part.content.trim()) {
        return truncateStatusProgressText(normalizeStatusProgressText(part.content));
      }
      // 没有正文时用 tool-call 片段作兜底进度，返回工具名而不是空串。
      if (part.type === "tool-call") {
        const toolProgress = formatStatusToolProgress(latestMessage.tools?.[part.toolIndex]);
        if (toolProgress) {
          return truncateStatusProgressText(toolProgress);
        }
      }
    }
    // 旧结构没有 parts 时，回落到 message 级字段。
    const text =
      readStatusStringField(latestMessage.content, []) ??
      readStatusStringField(latestMessage.thought, []) ??
      formatStatusToolProgress(latestMessage.tools?.at(-1));
    if (text) {
    // 最终截断到 180 字符。
      return truncateStatusProgressText(text);
    }
  }
  return null;
}
