// ============================================================
// compact(helpers 聚合入口)—— compact 编排层的公共出口
// ============================================================
//
// 【定位】
//   本文件是 runtime/methods/compact* 与 helpers 内部实现之间的稳定入口:
//   上半部分是 re-export(把切分选择、保留统计、压缩后提醒统一从这里暴露),
//   下半部分是 compact 编排自身需要的少量纯函数。
//   调用方(compact-active / turn-loop)只依赖这一个入口,内部拆分可自由调整。
//
// 【本文件真正实现的三类逻辑】
//   1) trigger → phase / reason 的默认映射(决定 compact 在什么阶段、为何发生);
//   2) compact 完成后历史的组装顺序与防御性拷贝;
//   3) 本地 microcompact 的 runtime 条目级适配(不调模型,只清旧工具结果)。
//
// 【不变量】
//   - compact 后历史顺序固定:[context prefix] → [summary] → [preserved] → [reminders];
//   - microcompact 只做 copy-on-write,绝不原地改 MessageHistory 共享条目;
//   - 被保留的 assistant 条目要失效 token 统计,避免沿用压缩前的旧用量。
// ============================================================
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  countContextPrefixMessages,
  isCoreError,
  maybeLocalMicrocompactMessages,
} from "../deps.js";
import type { LocalMicrocompactPolicyConfig } from "../deps.js";
import {
  cloneModelMessageContent,
  cloneRuntimeMessageEntry,
  invalidateRuntimeTokenUsage,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";

// re-export:切分选择 / 保留统计 / 压缩后提醒的唯一出口。
// 纯转发,不改变任何语义;具体口径见各自文件头。
export { buildPostCompactReadStateReminderEntries } from "./compact-post-reminders.js";
export type { CompactEntrySelection } from "./compact-selection.js";
export { countCompactPreservedRuntimeMessages } from "./compact-preservation.js";
export {
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
} from "./compact-selection.js";

/** 本地 microcompact 的结果:decision 供观测/决策,entries 是可直接替换历史的副本。 */
export interface RuntimeMicrocompactResult {
  /** 裁剪决策(命中/未命中/原因),来自 maybeLocalMicrocompactMessages。 */
  decision: ReturnType<typeof maybeLocalMicrocompactMessages>["decision"];
  /** 应用裁剪后的条目;未命中时是原数组引用(调用方可安全比较身份)。 */
  entries: readonly RuntimeMessageEntry[];
  /** 仅命中时存在:记录被清理的 toolCallId 等,用于事件/日志。 */
  payload?: ReturnType<typeof maybeLocalMicrocompactMessages>["payload"];
}

/**
 * trigger → compact 执行阶段。
 *
 * Auto 是"请求前"触发(PreRequest);Reactive 是 provider 溢出后的补救(Reactive);
 * Manual / Partial / SessionMemory 都需要独立回合承载(StandaloneTurn),
 * 因为它们不依附于某个正在进行的模型请求。switch 覆盖全部枚举值,新增 trigger
 * 时编译器会在此报错,避免静默落到错误阶段。
 */
export function defaultCompactPhaseForTrigger(trigger: CompactTrigger): CompactPhase {
  switch (trigger) {
    case CompactTrigger.Auto:
      return CompactPhase.PreRequest;
    case CompactTrigger.Reactive:
      return CompactPhase.Reactive;
    case CompactTrigger.Manual:
    case CompactTrigger.Partial:
    case CompactTrigger.SessionMemory:
      return CompactPhase.StandaloneTurn;
  }
}

/**
 * trigger → compact 原因(写入 boundary / 遥测,用于解释"为什么压缩")。
 * Auto 与 SessionMemory 都归因 ContextLimit(阈值驱动);Reactive 归因
 * ProviderOverflow(真实报错);Manual / Partial 归因 UserRequested。
 */
export function defaultCompactReasonForTrigger(trigger: CompactTrigger): CompactReason {
  switch (trigger) {
    case CompactTrigger.Auto:
      return CompactReason.ContextLimit;
    case CompactTrigger.Reactive:
      return CompactReason.ProviderOverflow;
    case CompactTrigger.Manual:
    case CompactTrigger.Partial:
      return CompactReason.UserRequested;
    case CompactTrigger.SessionMemory:
      return CompactReason.ContextLimit;
  }
}

/**
 * 把 compact 失败原因归一化成稳定字符串,写入 CompactFailed 事件/遥测。
 * 口径:CoreError 取 error.type(稳定、可聚合);普通 Error 取 message;
 * 非 Error 一律 "unknown"。不让原始对象/堆栈进入 timeline payload。
 */
export function compactFailureReasonFromError(error: unknown): string {
  if (isCoreError(error)) {
    return error.type;
  }
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown";
}

/**
 * 组装 compact 之后的完整运行时历史(顺序即权威)。
 *
 * 输入:压缩前的 activeEntries(只用于取 context prefix)、summaryEntry、
 *       可选的 preservedEntries 与 postCompactReminderEntries。
 * 输出:新的条目数组,顺序为
 *   context prefix → summary → preserved → post-compact reminders。
 * 副作用:无;所有条目都 clone,调用方可整体替换 messageHistory。
 * 语义:prefix 只认 metadata 标记(countContextPrefixMessages),
 *       避免用户的字面 <system-reminder> 文本被规则误留。
 * 不变量:summary 必须紧随 prefix,保留区间不能插到 summary 之前,
 *         否则冷恢复的压缩边界语义会被破坏。
 */
export function buildPostCompactRuntimeEntries(
  activeEntries: readonly RuntimeMessageEntry[],
  summaryEntry: RuntimeMessageEntry,
  options: {
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    preservedEntries?: readonly RuntimeMessageEntry[];
  } = {},
): RuntimeMessageEntry[] {
  // compact 后只保留 metadata 标记的 prefix，避免用户 literal <system-reminder> 被文本规则误留。
  const prefixCount = countContextPrefixMessages(activeEntries);
  return [
    ...activeEntries.slice(0, prefixCount).map(cloneRuntimeEntry),
    cloneRuntimeEntry(summaryEntry),
    ...(options.preservedEntries ?? []).map(cloneCompactPreservedRuntimeEntry),
    ...(options.postCompactReminderEntries ?? []).map(cloneRuntimeEntry),
  ];
}

/**
 * 取历史末尾"连续的 user / attachment 段"(从后往前收集,遇非 user 停止)。
 * 用于保留"压缩时正在等待处理的最新用户输入",避免它被摘要吞掉。
 * 输出为 clone 后的条目;副作用无。
 */
export function getTrailingRuntimeUserEntries(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  const trailingEntries: RuntimeMessageEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (!isRuntimeAttachmentEntry(entry) && entry.message.role !== "user") {
      break;
    }
    trailingEntries.unshift(cloneRuntimeEntry(entry));
  }
  return trailingEntries;
}

/**
 * 本地 microcompact 的 runtime 条目适配层(不调模型、不落盘)。
 *
 * 输入:条目、microcompact 策略配置、时间基准;输出 decision + entries。
 * 语义:先把条目投影成 provider 消息(applyCacheControl=false,仅为计数/分类),
 *       交给 maybeLocalMicrocompactMessages 决定清理哪些旧 tool result;
 *       再把清理结果映射回 runtime 条目,copy-on-write 只改被清理的那几条。
 * 为什么用 projection.sourceEntries 解析工具名:候选分类需要权威的
 *   目标工具身份(而非 provider 包装后的名字),token 估算仍用真实 provider 包装。
 * 失败/降级:未命中(payload 为空)时原样返回输入数组,不产生任何改动。
 * 副作用:无持久化;调用方负责把 entries 提交到历史。
 * 不变量:只有 payload 明确列出的 toolCallId 会被替换,其余条目保持身份不变。
 */
export function maybeLocalMicrocompactRuntimeEntries(input: {
  config?: LocalMicrocompactPolicyConfig;
  entries: readonly RuntimeMessageEntry[];
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
  useMidConversationSystem?: boolean;
}): RuntimeMicrocompactResult {
  const projection = buildProviderRequestMessages({
    entries: input.entries,
    applyCacheControl: false,
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const result = maybeLocalMicrocompactMessages({
    config: input.config,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    messages: projection.messages,
    // 候选分类读取权威目标身份，token 估算继续使用真实 provider 包装。
    resolveToolResultName: (message, index) => {
      const source = projection.sourceEntries[index];
      return source && !isRuntimeAttachmentEntry(source)
        ? source.message.toolName
        : message.toolName;
    },
    nowMs: input.nowMs,
  });

  if (!result.payload) {
    return {
      decision: result.decision,
      entries: input.entries,
    };
  }

  const entries = [...input.entries];
  const clearedToolCallIds = new Set<string>(result.payload.clearedToolCallIds);
  const clearedContentByToolCallId = new Map(
    result.messages
      .filter(
        (message) =>
          message.role === "tool" &&
          message.toolCallId &&
          clearedToolCallIds.has(message.toolCallId),
      )
      .map((message) => [message.toolCallId!, cloneModelMessageContent(message.content)]),
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "tool" || !entry.message.toolCallId) continue;
    const clearedContent = clearedContentByToolCallId.get(entry.message.toolCallId);
    if (!clearedContent) continue;
    // microcompact 只改被清理的 tool result；对该 entry 做 copy-on-write，
    // 避免为了保护 MessageHistory 的只读借用而深拷贝整段历史。
    entries[index] = {
      ...entry,
      message: {
        ...entry.message,
        content: clearedContent,
      },
    };
  }

  return {
    decision: result.decision,
    entries,
    payload: result.payload,
  };
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

/**
 * 保留区间的 clone:assistant 条目要额外失效 tokens 统计。
 * 原因:压缩后这些消息的"历史用量"不再是它们真实贡献给当前上下文的部分,
 *       沿用旧 tokens 会让上下文占用统计虚高;attachment 与非 assistant 不动。
 */
function cloneCompactPreservedRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  const cloned = cloneRuntimeEntry(entry);
  if (cloned.kind === "attachment" || cloned.message.role !== "assistant" || !cloned.tokens) {
    return cloned;
  }
  return {
    ...cloned,
    tokens: invalidateRuntimeTokenUsage(cloned.tokens),
  };
}
