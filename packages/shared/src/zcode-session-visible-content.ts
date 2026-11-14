// INV-01 续跑提醒有两种前缀形态：守住位置 isZCodeGoalContinuationReminderText；改错故障 旧快照提醒被当用户输入。
// INV-02 新版按 source 属性识别：守住位置 消息级判定首支；改错故障 仅靠文案导致漏判。
// INV-03 旧版只认固定文案：守住位置 文案常量；改错故障 任意系统提醒被误判为续跑。
// INV-04 比较先去前导空白：守住位置 trimStart；改错故障 缩进提醒逃过过滤。
// INV-05 状态提示不计入续跑：守住位置 isZCodeGoalStateReminderText；改错故障 每轮状态注入都推进迭代。
// INV-06 模型专用提醒含续跑与状态：守住位置 isZCodeGoalModelOnlyReminderMessage；改错故障 状态提示进入可见气泡。
// INV-07 子 agent 消息按来源识别：守住位置 SUBAGENT_MESSAGE_SOURCE；改错故障 后台消息被当用户提问。
// INV-08 来源可落在消息或分段：守住位置 三处来源读取；改错故障 只在消息级判断导致漏网。
// INV-09 投影策略再兜底：守住位置 getConversationMessageProjectionPolicy；改错故障 隐藏合成消息显示出来。
// INV-10 压缩摘要按 timelineStatus 区分：守住位置 isZCodeCompactSummaryMessage；改错故障 压缩上下文被渲染成用户输入。
// INV-11 可见投影不回写原数组：守住位置 新建数组；改错故障 调用方数据被就地修改。
// INV-12 过滤保持原相对顺序：守住位置 单次遍历；改错故障 消息顺序错乱。
// INV-13 迭代统计先稳定排序：守住位置 compareZCodeMessagesByCreatedTime；改错故障 同毫秒消息抖动。
// INV-14 续跑边界才推进迭代：守住位置 续跑分支；改错故障 状态提示被算成新一轮。
// INV-15 可见 goal 输入只补首段：守住位置 pending 标志；改错故障 同一轮被计两次。
// INV-16 目标失效后的回复不继承：守住位置 inactiveAt 比较；改错故障 追问被折叠进旧轮次。
// INV-17 旧会话首条回复归第一轮：守住位置 零轮次回填；改错故障 历史区退回普通状态。
// INV-18 迭代上限由 verifier 收敛：守住位置 maxGoalIteration；改错故障 未确认轮次提前展示。
//
// 模块职责：旧协议兼容面上的 goal 与可见消息投影函数。
// 状态所有权：无状态；全部为纯函数，输入数组不被修改。
// 阅读顺序：先看提醒与可见性判定，再读投影，最后看迭代统计。
// ── 旧协议兼容面（过渡期）──────────────────────────────
// 剩余 11 个导出：goal 迭代/可见消息投影函数。
// 消费者：zcodeTaskServiceAdapter/zcodeSessionProjection/zcodeTaskIndexSyncer、
// CLI bootstrap session-mapper。textFromZCodeMessageParts 已迁
// zcode-protocol-legacy-types.ts（幸存面）。本文件与旧投影栈同生命周期。
import type { ZCodeSessionGoal } from "./zcode-protocol/index.js";
import { getConversationMessageProjectionPolicy } from "./conversation-message-projection-policy.js";
import {
  type ZCodeMessageWithParts,
  textFromZCodeMessageParts,
} from "./zcode-protocol-legacy-types.js";

const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const SUBAGENT_MESSAGE_SOURCE = "subagent_message";

// isZCodeGoalContinuationReminderText 覆盖带 source 属性的新协议与固定文案的旧协议两种前缀。
// 新协议带 source 属性。
// 旧协议分支要求 <system-reminder> 与 GOAL_CONTINUATION_TEXT_MARKER 同时命中。
// 先经 trimStart 归一，缩进提醒不会逃过判定。
// GOAL_STATE_TEXT_MARKER 单独判定，状态提示不算续跑边界。
// isZCodeGoalContinuationReminderMessage 的消息级判定复用本函数。
export function isZCodeGoalContinuationReminderText(text: string): boolean {
  const normalized = text.trimStart();
  if (normalized.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX)) {
    return true;
  }
  return (
    normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_CONTINUATION_TEXT_MARKER)
  );
}

export function isZCodeGoalContinuationReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (message.info.source === "goal-continuation" ||
      String(message.info.metadata?.["source"] ?? "") === "goal-continuation" ||
      isZCodeGoalContinuationReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeGoalStateReminderText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_STATE_TEXT_MARKER);
}

export function isZCodeGoalModelOnlyReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (isZCodeGoalContinuationReminderMessage(message) ||
      isZCodeGoalStateReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

// 子 agent 注入按来源识别。
// source 可落在 message.info 或 part.metadata，两处都要读。
// getConversationMessageProjectionPolicy 再兜底判定 hiddenSynthetic 与 providerContextOnly。
// policy 为 hiddenSynthetic 或 providerContextOnly 都算模型专用。
// policy 为 realUserInput 时返回 false，真实用户输入不在此列。
// isZCodeModelOnlySyntheticUserMessage 是可见性总闸，供后续过滤器调用。
export function isZCodeModelOnlySyntheticUserMessage(message: ZCodeMessageWithParts): boolean {
  if (
    message.info.role === "user" &&
    (String(message.info.source ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      String(message.info.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      message.parts.some(
        (part) =>
          part.type === "text" &&
          String(part.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE,
      ))
  ) {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "providerContextOnly" || policy === "hiddenSynthetic";
}

export function isZCodeCompactSummaryMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => {
      if (part.type !== "compaction") {
        return false;
      }
      const timelineStatus = part.metadata?.["timelineStatus"];
      // compact summary user message 是压缩后的模型上下文，不是用户可见输入。
      // 真正要渲染成 timeline 的 lifecycle part 会带 timelineStatus，并且由 assistant message 承载。
      return typeof timelineStatus !== "string";
    })
  );
}

// getZCodeUserVisibleMessages 逐条过滤模型专用消息。
// isZCodeCompactSummaryMessage 命中的压缩摘要一并隐藏。
// visibleMessages 单次遍历追加，剩余消息保持原相对顺序。
// 本函数只挑选引用，不改写任何 message 内容。
// _options.target 当前不参与过滤，仅保留签名兼容。
// 返回新建的 visibleMessages 数组，不修改入参。
export function getZCodeUserVisibleMessages(
  messages: readonly ZCodeMessageWithParts[],
  _options: { target?: ZCodeSessionGoal | null } = {},
): ZCodeMessageWithParts[] {
  const visibleMessages: ZCodeMessageWithParts[] = [];
  for (const message of messages) {
    if (isZCodeModelOnlySyntheticUserMessage(message) || isZCodeCompactSummaryMessage(message)) {
      // /goal 续跑、后台任务、子 agent、rewind 通知和 compact summary
      // 都是 runtime 注入给模型继续推理的上下文，不是用户真实 query；可见投影必须过滤，
      // 避免快照/远控恢复时渲染成右侧用户气泡或挤占 timeline 位置。
      continue;
    }
    visibleMessages.push(message);
  }
  return visibleMessages;
}

// 先按创建时间稳定排序。
// 续跑边界推进迭代号。
// 可见 goal 输入只补首段。
// 状态提示不推进轮次。
// inactiveAt 之后创建的 assistant 消息不继承旧 goal 轮次。
// 上限由 verifier 收敛。
export function getZCodeGoalIterationByAssistantMessageId(
  messages: readonly ZCodeMessageWithParts[],
  options: { maxGoalIteration?: number; target?: ZCodeSessionGoal | null } = {},
): Map<string, number> {
  const target = options.target ?? null;
  if (!target) {
    return new Map();
  }

  const iterationByAssistantId = new Map<string, number>();
  const sortedMessages = [...messages].sort(compareZCodeMessagesByCreatedTime);
  const inactiveAt = target.status === "active" ? null : target.updatedAt;
  let currentIteration = 0;
  let pendingVisibleGoalUserIteration = false;

  for (const message of sortedMessages) {
    if (message.info.role === "user") {
      if (isZCodeGoalContinuationReminderMessage(message)) {
        // goal 续跑边界只来自 Continue/source=goal-continuation；
        // Current session goal state 是同一轮内反复注入的状态提示，不能在这里推进迭代号。
        currentIteration += 1;
        pendingVisibleGoalUserIteration = false;
        continue;
      }
      if (isVisibleRealGoalUserMessage(message, target)) {
        // 新协议会同时持久化可见的 /goal 输入和 model-only continuation。
        // 可见输入只用于旧快照缺少 continuation 时补第一段边界，不能和 continuation 叠加算两轮。
        pendingVisibleGoalUserIteration = true;
      }
      continue;
    }

    if (message.info.role !== "assistant") {
      continue;
    }
    if (inactiveAt !== null && message.info.time.created > inactiveAt) {
      // 目标停止/完成后的普通追问仍在同一个 session 内，不能继续继承旧 goal 轮次。
      // 否则恢复快照时追问回复会被历史区当成“第 N 次迭代”处理，看起来像被旧完成横线折叠。
      continue;
    }
    if (pendingVisibleGoalUserIteration) {
      currentIteration += 1;
      pendingVisibleGoalUserIteration = false;
    }
    if (currentIteration === 0 && message.info.time.created >= target.createdAt) {
      // 旧会话里 goal 创建输入可能没有 `/goal` 可见气泡或时间早于 target.createdAt。
      // 第一条 goal 之后的 assistant 仍要归入第 1 次迭代，否则历史区会退回普通“已工作”。
      currentIteration = 1;
    }
    if (currentIteration > 0) {
      // assistant 消息桶只用于历史状态展示，不能把 goal 轮次推进到
      // verifier timeline 尚未确认的下一轮；新会话传入 maxGoalIteration 后按 verifier 上限收敛。
      const boundedIteration =
        options.maxGoalIteration && options.maxGoalIteration > 0
          ? Math.min(currentIteration, options.maxGoalIteration)
          : currentIteration;
      iterationByAssistantId.set(message.info.messageId, boundedIteration);
    }
  }

  return iterationByAssistantId;
}

export interface ZCodeGoalIterationCountTimelineItem {
  goalIteration?: number;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verification?: { passed?: boolean | null } | null;
}

export function getZCodeGoalActiveIterationCount(input: {
  targetStatus?: string | null;
  timeline?: readonly ZCodeGoalIterationCountTimelineItem[] | null;
}): number {
  if (!input.targetStatus) {
    return 0;
  }
  const timeline = input.timeline ?? [];
  if (timeline.length === 0) {
    return 1;
  }
  const latest = timeline[timeline.length - 1];
  if (!latest) {
    return 1;
  }
  const latestIteration = latest.goalIteration ?? timeline.length;
  if (latest.status === "started") {
    return latestIteration;
  }
  if (
    (latest.status === "completed" && latest.verification?.passed === true) ||
    input.targetStatus === "complete"
  ) {
    return latestIteration;
  }
  if (input.targetStatus !== "active") {
    // stop 会先把 target 改成 paused，再把正在跑的 verifier 收口成 cancelled。
    // 非 active 目标不会自动续跑，不能把 cancelled/failed verifier 预投影成下一轮。
    return latestIteration;
  }
  return latestIteration + 1;
}

function compareZCodeMessagesByCreatedTime(
  left: ZCodeMessageWithParts,
  right: ZCodeMessageWithParts,
) {
  const diff = left.info.time.created - right.info.time.created;
  if (diff !== 0) {
    return diff;
  }
  return left.info.messageId.localeCompare(right.info.messageId);
}

function isVisibleRealGoalUserMessage(message: ZCodeMessageWithParts, target: ZCodeSessionGoal) {
  if (
    message.info.role !== "user" ||
    getConversationMessageProjectionPolicy(message) !== "realUserInput"
  ) {
    return false;
  }

  const createdAt = message.info.time.created;
  const nearGoalStart = createdAt >= target.createdAt - 30_000;
  if (!nearGoalStart) {
    return false;
  }

  return true;
}

export function resolveZCodeVisibleSessionTitle(input: {
  title?: string;
  messages: readonly ZCodeMessageWithParts[];
  target?: ZCodeSessionGoal | null;
  fallback?: string;
}): string {
  const normalizedTitle = input.title?.trim() ?? "";
  if (
    normalizedTitle &&
    !isZCodeGoalContinuationReminderText(normalizedTitle) &&
    !isZCodeGoalStateReminderText(normalizedTitle)
  ) {
    return normalizedTitle;
  }

  const firstUser = input.messages.find(
    (message) =>
      message.info.role === "user" &&
      getConversationMessageProjectionPolicy(message) === "realUserInput" &&
      !isZCodeGoalModelOnlyReminderMessage(message),
  );
  const firstUserText = textFromZCodeMessageParts(firstUser?.parts ?? []).trim();
  if (firstUserText) {
    return firstUserText.slice(0, 80);
  }

  const objective = input.target?.objective.trim() ?? "";
  if (objective) {
    return objective.slice(0, 80);
  }

  return input.fallback ?? "New session";
}
