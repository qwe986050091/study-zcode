// 上下文压缩（/compact）时间线归约（L2）：把压缩事件映射为 role="timeline" 的消息并幂等 upsert。
// 输入为 session event payload；输出为新的 Message[]（全部不可变更新，不修改入参）。
// 不写持久化、不打日志；本地发起的压缩用 local-compact-<seq> 作为 operationId。
import type { Message, TimelineMessage } from "./app-model.js";
import type React from "react";
import { asRecord, numberField, stringField } from "./state.js";

// 本地压缩 operationId 的前缀；服务端事件不会使用该前缀，据此区分"本地占位卡"与真实操作。
const LOCAL_COMPACT_OPERATION_PREFIX = "local-compact";

// 本地压缩序号，仅用于在本次进程内生成唯一 operationId；重启后从 0 重新开始。
let localCompactSequence = 0;

// 正则大小写不敏感（iu），因此 "/COMPACT" 也会被归一化为 "/compact"。
// 新增命令别名时必须同步修改正则与返回的归一化命令名，否则重试入口会拼错命令。
// 把 "/compact" / "/compress"（可带任意参数）归一化为 "/compact[ 参数]"；非压缩命令返回 undefined。
// 参数保留原文（含内部换行），只去掉首尾空白。
export function compactCommandFromText(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/(?:compact|compress)(?:\s+([\s\S]*))?$/iu.exec(trimmed);
  if (!match) return undefined;
  const instructions = match[1]?.trim();
  return instructions ? `/compact ${instructions}` : "/compact";
}

// 仅做语法判定，不校验命令是否被当前会话允许；权限与分发由调用方负责。
// 与 compactCommandFromText 共用正则，二者结论必须一致，改归一化规则时需同步验证。
// 判断文本是否为压缩斜杠命令；等价于 compactCommandFromText(...) !== undefined。
export function isCompactSlashCommand(text: string): boolean {
  return compactCommandFromText(text) !== undefined;
}

// 返回的 Message.id 由 operationId 派生，与 upsert 的匹配口径保持一致。
// 自增序号仅存在于内存，不写 session 存储；结果需由调用方通过 setMessages 落进列表。
// 构造本地发起的压缩时间线消息（trigger=manual）。每次调用分配新的 operationId，
// 因此同一轮多次触发不会被 upsert 合并；调用方需自行决定是否先 fail 掉旧的 running 记录。
export function createLocalCompactTimelineMessage(input: {
  command?: string;
  reason?: string;
  status: TimelineMessage["status"];
}): Message {
  localCompactSequence += 1;
  const operationId = `${LOCAL_COMPACT_OPERATION_PREFIX}-${localCompactSequence}`;
  return compactTimelineMessage({
    command: input.command,
    operationId,
    reason: input.reason,
    status: input.status,
    trigger: "manual",
    type: "context_compaction",
  });
}

// 字段读取全部走宽松解析（stringField/numberField），类型不符按缺失处理，不抛错。
// 返回 null 是"忽略该事件"的唯一信号，调用方不得把它当成失败去提示用户。
// 从事件 payload 解析压缩时间线消息。operationId 与合法 status 缺一不可，否则返回 null（事件被忽略）。
// status 只接受 started/retrying/skipped/completed/failed/interrupted，其余值视为非法。
export function compactTimelineMessageFromPayload(
  payload: Record<string, unknown>,
): Message | null {
  const operationId = stringField(payload, "operationId");
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  return compactTimelineMessage({
    attempt: numberField(payload, "attempt"),
    maxAttempts: numberField(payload, "maxAttempts"),
    messageId: stringField(payload, "messageId"),
    operationId,
    reason: stringField(payload, "reason"),
    status,
    trigger: stringField(payload, "trigger"),
    type: "context_compaction",
  });
}

// 幂等写入压缩时间线：先按 messageId/operationId 查找既有记录再合并，避免 started→completed 产生重复卡片。
// 合并时保留旧 content 与旧 command（新值为空时不覆盖），并整体替换 timeline 字段。
// 找不到既有记录时追加到末尾；nextMessage 无 operationId 时原样返回 current（视为无变化）。
export function upsertCompactTimelineMessage(current: Message[], nextMessage: Message): Message[] {
  const nextTimeline = nextMessage.timeline;
  if (!nextTimeline?.operationId) {
    return current;
  }
  const existingIndex = current.findIndex((message) => {
    const timeline = message.timeline;
    if (!timeline || timeline.type !== "context_compaction") {
      return false;
    }
    return (
      (nextTimeline.messageId && timeline.messageId === nextTimeline.messageId) ||
      timeline.operationId === nextTimeline.operationId ||
      // 本地占位卡（local-compact-*）仍在 running 时，允许被服务端真实 operationId 的事件接管，
      // 否则会出现"本地卡一直转圈 + 服务端卡另起一张"的双卡。
      (timeline.operationId.startsWith(LOCAL_COMPACT_OPERATION_PREFIX) &&
        isRunningCompactTimelineStatus(timeline.status) &&
        !nextTimeline.operationId.startsWith(LOCAL_COMPACT_OPERATION_PREFIX))
    );
  });
  if (existingIndex < 0) {
    return [...current, nextMessage];
  }

  return current.map((message, index) => {
    if (index !== existingIndex || !message.timeline) {
      return message;
    }
    return {
      ...message,
      content: nextMessage.content || message.content,
      id: nextMessage.id ?? message.id,
      timeline: {
        ...message.timeline,
        ...nextTimeline,
        command: nextTimeline.command ?? message.timeline.command,
      },
    };
  });
}

// 扫描方向从新到旧，命中第一条即返回，保证重试入口总是最近一次失败。
// command 缺失时返回 "/compact" 而非 undefined，避免重试按钮拿到空命令。
// 从后向前找最近一次失败/中断的压缩记录，返回其原始命令用于"重试"入口；没找到返回 undefined。
export function latestRetryableCompactCommand(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timeline = messages[index]?.timeline;
    if (
      timeline?.type === "context_compaction" &&
      (timeline.status === "failed" || timeline.status === "interrupted")
    ) {
      return timeline.command ?? "/compact";
    }
  }
  return undefined;
}

// 只终结"最近一条"running 记录；更早的 running 卡保持原状，避免一次错误连带清空多条。
// 补建的失败卡使用本地 operationId，后续服务端事件仍可通过 running 接管规则合并。
// 把最近一条 running 的压缩记录标记为 failed 并写入原因；没有 running 记录时补建一条失败卡。
// 用于 turn 级错误兜底，保证 UI 不会停在"压缩中"。返回新数组，不修改入参。
export function failLatestStartedCompactTimeline(current: Message[], reason: string): Message[] {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const message = current[index];
    const timeline = message?.timeline;
    if (
      timeline?.type === "context_compaction" &&
      isRunningCompactTimelineStatus(timeline.status)
    ) {
      return current.map((item, itemIndex) =>
        itemIndex === index && item.timeline
          ? {
              ...item,
              timeline: {
                ...item.timeline,
                reason,
                status: "failed",
              },
            }
          : item,
      );
    }
  }
  return upsertCompactTimelineMessage(
    current,
    createLocalCompactTimelineMessage({ reason, status: "failed" }),
  );
}

// 由 TimelineMessage 构造 role="timeline" 的消息壳；content 恒为空，正文由 timeline 字段承载。
// id 优先用事件自带 messageId，否则由 operationId 派生，保证同一操作重复构造时 id 稳定。
function compactTimelineMessage(timeline: TimelineMessage): Message {
  return {
    content: "",
    id: timeline.messageId ?? `compact-${timeline.operationId}`,
    role: "timeline",
    timeline,
  };
}

// 校验并收敛 payload 里的 status 字符串；未知值返回 undefined，由调用方丢弃整个事件。
function timelineStatusValue(value: unknown): TimelineMessage["status"] | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

// running 语义：started/retrying 两种状态都可能被后续事件终结（成功或失败）。
function isRunningCompactTimelineStatus(status: TimelineMessage["status"]): boolean {
  return status === "started" || status === "retrying";
}

// 入参可为任意事件 payload（含非对象），asRecord 会把非对象降级为空对象再取字段。
// 空串 message 同样视为缺失并继续回退，保证返回值始终非空。
// 从错误 payload 取可读文案：优先 error.message，其次顶层 message，最后回退固定文案。
// 只取 message 文本，不拼接堆栈。
export function compactErrorMessage(errorPayload: unknown): string {
  const payload = asRecord(errorPayload);
  const nestedError = asRecord(payload.error);
  return (
    stringField(nestedError, "message") ??
    stringField(payload, "message") ??
    "Context compression failed."
  );
}

// 副作用仅为 setMessages 的函数式更新，不写 lastError、不改状态栏。
// 事件重复到达时由 upsert 幂等合并，调用方无需自行去重。
// session 事件入口：把 payload 转为压缩时间线并 upsert 进消息列表；解析失败（缺字段）时静默忽略。
export function applyCompactTimelineEvent(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = compactTimelineMessageFromPayload(payload);
  if (!message) return;
  setMessages((current) => upsertCompactTimelineMessage(current, message));
}

// 错误文案必定非空，仅影响展示，不向调用方抛错。
// 不新建 turn、不改动其他消息，只把 running 压缩卡收敛为 failed。
// turn 级错误入口：同时写全局错误文案，并把仍在 running 的压缩卡标记为失败。
// 两个 setter 均使用 React 函数式更新，避免与并发事件产生竞态。
export function applyCompactTurnErrorEvent(
  payload: Record<string, unknown>,
  setLastError: (message: string | undefined) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = compactErrorMessage(payload);
  setLastError(message);
  setMessages((current) => failLatestStartedCompactTimeline(current, message));
}
