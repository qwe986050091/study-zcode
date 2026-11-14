// ============================================================
// compact-preservation —— 把"保留最近轮次"翻译成 durable 侧的消息区间
// ============================================================
//
// 【职责】
//   compact 的切分选择(compact-selection)是在 runtime 条目上做的,
//   但 boundary 需要落一份基于 SessionStore 真实消息 id 的保留区间指针
//   (CompactPreservedSegment:anchor / head / tail),供冷恢复、rewind、
//   编辑重判等场景精确复原"压缩后仍保留的原文"。
//   本文件负责这层"runtime 选择 → durable 指针"的换算。
//
// 【为什么必须回查 SessionStore(不变量 8)】
//   runtime 条目里的 user/attachment 数量与数据库消息并非一一对应
//   (synthetic 来源、prefix、附件投影都会改变条数)。直接用 runtime 计数
//   切分数据库消息会错位,导致保留区间指向错误的消息。
//   因此这里复用同一套 assistant 分组规则,只统计"选定结果"。
//
// 【副作用】
//   只读 SessionStore(messages / getSession),不写库、不发事件。
//
// 【失败/降级】
//   - groupsPreserved <= 0:直接返回 { keptMessageCount: 0 },不产生指针;
//   - revert(branch cut / rewind)后没有存活消息:同样不产生指针;
//   - 无 SessionStore 的纯内存模式:调用方改用 countCompactPreservedRuntimeMessages
//     只统计数量,绝不伪造指针(伪造会在恢复时指向不存在的消息)。
// ============================================================
import type {
  CompactPreservedSegment,
  MessageId,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import { isCompactPreservableSessionMessage } from "../../agent/compact-session.js";
import { activeSessionMessages } from "../../agent/session-history-hydrator.js";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { SYSTEM_REMINDER_PERSISTED_SOURCES } from "../../system-reminder/source.js";

/**
 * 依据 SessionStore 中的真实消息,计算 compact 保留区间的首尾指针。
 *
 * 输入:sessionStore、sessionId、本次摘要消息 id(anchor)、
 *       切分阶段选定的保留组数(groupsPreserved)。
 * 输出:{ preservedSegment?, keptMessageCount }。
 *   - preservedSegment.anchorMessageId = 摘要消息 id(插入点);
 *     headMessageId / tailMessageId = 保留区间在库中的首/末消息 id;
 *   - keptMessageCount 仅用于 boundary 展示统计,不参与选取。
 * 语义:先按 revert(branch cut / rewind)还原"当前活动历史",
 *       再过滤掉不可保留的消息(compaction boundary 等),
 *       最后取末尾 N 个 assistant 轮次作为保留区间。
 * 副作用:只读 SessionStore,不写库。
 * 失败/降级:组数为 0、活动历史为空或过滤后为空时返回无指针结果;
 *            不抛业务错误,由调用方决定是否记录 keptMessageCount。
 * 不变量:指针只指向 SessionStore 中真实存在且属于当前活动分支的消息;
 *         首尾顺序由库中顺序决定,不使用 runtime 下标。
 */
export async function selectPersistedCompactTail(input: {
  sessionStore: SessionStorePort;
  sessionId: SessionId;
  summaryMessageId: MessageId;
  groupsPreserved: number;
}): Promise<{ preservedSegment?: CompactPreservedSegment; keptMessageCount: number }> {
  if (input.groupsPreserved <= 0) return { keptMessageCount: 0 };
  // messages 与 getSession 并行读取:保留区间既依赖消息顺序,也依赖 revert 元数据,
  // 两者必须来自同一时刻的库快照,不能串行读取而引入新的写入窗口。
  const [messages, session] = await Promise.all([
    input.sessionStore.messages({ sessionID: input.sessionId }),
    input.sessionStore.getSession(input.sessionId),
  ]);
  const revert = session?.revert;
  const active = activeSessionMessages(messages, {
    branchCutAfterMessageId: revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: revert?.createdMessageID,
    rewindKeptMessageIds: revert?.keptMessageIDs,
    rewindTargetMessageId: revert?.targetMessageID,
  }).filter(isCompactPreservableSessionMessage);
  // 原因：runtime 与数据库的 user/attachment 数量不是一一对应，尤其 synthetic
  // 来源改变后会错位。复用 compact 的 assistant 分组，数量只统计选定结果。
  const kept = groupByAssistantStartedRounds(active, (message) => message.info.role)
    .slice(-input.groupsPreserved)
    .flat();
  if (kept.length === 0) return { keptMessageCount: 0 };
  return {
    keptMessageCount: kept.length,
    preservedSegment: {
      anchorMessageId: input.summaryMessageId,
      headMessageId: kept[0]!.info.id,
      tailMessageId: kept.at(-1)!.info.id,
    },
  };
}

// 纯内存模式的统计替代:只输出保留条目数,不产出 preservedSegment 指针。
// 统计口径:attachment 只计 SYSTEM_REMINDER_PERSISTED_SOURCES 中的来源;
// 普通消息只计真实 user/assistant,并排除 queryScope=output_token_continuation
// 的续写提示(不变量 9:续写提示是 query-local,不能进持久化历史)。
// 副作用:无。
/** 无 SessionStore 时仅用于统计，不能用此数量选择持久化区间。 */
export function countCompactPreservedRuntimeMessages(
  entries: readonly RuntimeMessageEntry[],
): number {
  return entries.filter((entry) => {
    if (isRuntimeAttachmentEntry(entry)) {
      return SYSTEM_REMINDER_PERSISTED_SOURCES.some((source) => source === entry.metadata.source);
    }
    return (
      !entry.queryScope && (entry.message.role === "assistant" || entry.message.role === "user")
    );
  }).length;
}
