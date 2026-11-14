/**
 * ============================================================================
 * runtime/methods/stable-fork-boundary.ts —— TurnComplete 前的稳定 fork 边界锚点
 * ============================================================================
 * 【定位】链路 5/6：在 TurnComplete 对订阅者可见前，把 fork 所需的权威 message
 *   segment（本回合起止）与 goal 快照写进 boundary assistant 的 anchor。
 * 【输入/输出】boundaryMessageId + startMessageId + historyRoundCount → saveMessage 的 anchor。
 * 【关键不变量】#7：anchor 与 message 同记录落库；写不成就整体跳过，不发布伪边界。
 * ============================================================================
 */
import { SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION } from "../deps.js";
import type {
  MessageId,
  MessageProjectionAnchor,
  SessionEntryInfo,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface VerificationEntryPayload {
  anchorAssistantMessageId?: string;
  targetId?: string;
}

/**
 * 在 TurnComplete 对订阅者可见前，把 fork 所需的历史事实固定到最终 assistant。
 * productTurnId 属于 bootstrap 投影域，这里只固定 core 权威的 raw message segment；
 * resolver 会用 projection candidate 补 productTurnId，禁止 core 复制 `~qN` 算法。
 */
export async function persistStableForkCompletionBoundary(
  runtime: AgentRuntimeInternal,
  input: {
    boundaryMessageId: MessageId;
    startMessageId: MessageId;
    historyRoundCount: number;
    traceContext: TraceContext;
  },
): Promise<void> {
  const store = runtime.sessionStore;
  // 无 store 就无法固定事实；不兜造 anchor，留给 resolver 按 legacy 规则裁决。
  if (!store) return;

  const messages = await store.messages({ sessionID: runtime.sessionId });
  // 同一 id 可能因重试/重建出现多份，取最后一份“成功且 completed”的 assistant，
  // 否则 anchor 会挂在 error 或被中断的记录上，fork 的历史边界随之漂移。
  const boundaryIndex = messages.findLastIndex(
    (message) =>
      message.info.id === input.boundaryMessageId &&
      message.info.role === "assistant" &&
      !message.info.error &&
      message.info.time.completed !== undefined,
  );
  // 上限锁在 boundaryIndex：start 必须落在 boundary 之前，否则后面的 slice 会得到空/反向区间。
  const startIndex = messages.findLastIndex(
    (message, index) =>
      index <= boundaryIndex && message.info.id === input.startMessageId,
  );
  const boundary = messages[boundaryIndex];
  if (
    startIndex < 0 ||
    boundaryIndex < startIndex ||
    boundary?.info.role !== "assistant" ||
    boundary.info.error ||
    boundary.info.time.completed === undefined
  ) {
    // 兼容只实现部分 SessionStorePort 的旧 adapter/test double，以及 turn 收口前被
    // edit/rewind 改写的 transcript。没有 exact segment 就不写伪 anchor，resolver
    // 仍按 legacy 无歧义规则裁决。
    return;
  }

  // [start, boundary] 闭区间就是本回合的权威消息段；fork 复制只认这份顺序，不重算边界。
  const orderedMessageIds = messages
    .slice(startIndex, boundaryIndex + 1)
    .map((message) => message.info.id);
  // 用 boundary 及之前的所有 id 判断 verifier 是否在 fork 点之内，避免把后续回合的验证带进 child。
  const prefixMessageIds = new Set(
    messages
      .slice(0, boundaryIndex + 1)
      .map((message) => String(message.info.id)),
  );
  // readTarget 是可选能力：旧 adapter 不提供时退化为“无 goal 边界”，不阻断收口。
  const target =
    typeof store.readTarget === "function"
      ? await store.readTarget({ sessionID: runtime.sessionId })
      : null;
  const goalBoundary = target
    ? {
        kind: "snapshot" as const,
        target: stableGoalSnapshot(target),
        verificationEntryIds: await verificationEntryIdsAtBoundary(
          runtime,
          target,
          prefixMessageIds,
        ),
      }
    : { kind: "none" as const };

  // 保留 boundary 原有 anchor 字段（bootstrap 侧可能已写入），只覆盖本函数负责的段落事实。
  const anchor: MessageProjectionAnchor = {
    ...boundary.info.anchor,
    ...(input.traceContext.turnId ? { turnId: input.traceContext.turnId } : {}),
    historyRoundCount: input.historyRoundCount,
    orderedMessageIds,
    boundaryMessageId: input.boundaryMessageId,
    goalBoundary,
  };
  // 整条 message 重存，让 anchor 与 message 同一次落库；单独写 anchor 会多出第二条写入路径。
  await store.saveMessage({ ...boundary.info, anchor });
}

function stableGoalSnapshot(target: SessionGoal): SessionGoal {
  // active run 字段属于 parent 的瞬时执行权，不是 child 可继承状态。生产 adapter 的
  // cloneTargetForFork 也会清空；anchor 同样先清空，避免查询/诊断误读为历史运行中。
  return {
    ...target,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { ...target.time },
  };
}

async function verificationEntryIdsAtBoundary(
  runtime: AgentRuntimeInternal,
  target: SessionGoal,
  prefixMessageIds: ReadonlySet<string>,
): Promise<string[]> {
  const store = runtime.sessionStore;
  if (!store?.sessionEntries) {
    // 有 goal 却无法读取 verifier ledger 时不能伪造空边界，否则 child 可能静默丢失
    // fork 点前 verifier。显式失败会阻止 TurnComplete/canFork 先于权威 anchor 发布。
    return [];
  }
  // 读取失败不在此吞掉：anchor 是 fork 的权威输入，不允许空 ledger 静默通过。
  const entries = await store.sessionEntries({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  // 只保留“同一 target 且落在 boundary 之前”的 verifier；其余不是 child 可继承的验证事实。
  return entries.flatMap((entry) => {
    const payload = verificationEntryPayload(entry);
    if (payload?.targetId !== target.targetID) return [];
    // 没写 anchor 的历史 verifier 视为全局有效；写了 anchor 的必须在前缀内，否则属于后续回合。
    if (
      payload.anchorAssistantMessageId &&
      !prefixMessageIds.has(payload.anchorAssistantMessageId)
    ) {
      return [];
    }
    return [entry.id];
  });
}

function verificationEntryPayload(
  entry: SessionEntryInfo,
): VerificationEntryPayload | null {
  // entry.data / payload 来自持久库，可能被老 schema 或手工改动污染；逐层窄化后再取字段。
  if (
    !entry.data ||
    typeof entry.data !== "object" ||
    Array.isArray(entry.data)
  )
    return null;
  const payload = (entry.data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.targetId === "string"
      ? { targetId: record.targetId }
      : {}),
    ...(typeof record.anchorAssistantMessageId === "string"
      ? { anchorAssistantMessageId: record.anchorAssistantMessageId }
      : {}),
  };
}
