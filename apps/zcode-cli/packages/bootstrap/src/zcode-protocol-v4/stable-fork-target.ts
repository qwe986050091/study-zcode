/**
 * ============================================================================
 * zcode-protocol-v4/stable-fork-target.ts —— 稳定 fork 目标判定
 * ============================================================================
 *
 * 【职责】给定 projection 已证明成功的 product turn 候选，把 fork 点固定成
 * transcript 中一组有序 messageId（user starter → 轮尾 completed assistant），
 * 并解析该点的 goal 版本边界。成功结果惰性写回 message.anchor，后续重试复用同一组 id。
 *
 * 【身份口径】优先读取持久 anchor（productTurnId/orderedMessageIds/boundaryMessageId）；
 * anchor 与候选冲突、顺序不单调、或出现内层真实 user 轮时判为不可判定。
 *
 * 【降级】不可判定统一返回 guard.forkTargetAmbiguous，由调用方拒绝 fork 并提示；
 * 绝不按文本/时间邻近猜测边界。legacy 无 anchor 时才按 parent/user 关系补算，
 * 且必须在同一轮内无嵌套真实用户轮、无持久 goal 冲突时才接受。
 * ============================================================================
 */
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  type MessageId,
  type MessageWithParts,
  type SessionStorePort,
  type StableForkGoalBoundaryMetadata,
} from "@zcode/contracts";
import { isConversationRealUserTurnStarter } from "@zcode/shared";
import type { StableForkTarget } from "@zcode/shared/zcode-protocol-v4";
import type { V4StableForkTargetResolution } from "./commands/types.js";
import type { StableForkCandidate } from "./product-projection.js";

/**
 * 校验 orderedMessageIds：非空、末项等于 boundary、无重复，且在 messages 中索引严格递增。
 * 任一条不满足即说明持久顺序已与 transcript 不一致，不能作为稳定 fork 目标。
 */
function idsAreOrdered(
  messages: readonly MessageWithParts[],
  orderedMessageIds: readonly string[],
  boundaryMessageId: string,
): boolean {
  if (
    orderedMessageIds.length === 0 ||
    orderedMessageIds.at(-1) !== boundaryMessageId ||
    new Set(orderedMessageIds).size !== orderedMessageIds.length
  ) {
    return false;
  }
  const indexById = new Map(messages.map((message, index) => [String(message.info.id), index]));
  let previous = -1;
  for (const messageId of orderedMessageIds) {
    const index = indexById.get(messageId);
    if (index === undefined || index <= previous) return false;
    previous = index;
  }
  return true;
}

/**
 * 读取 boundary message 上的持久 anchor：
 * 无 anchor 返回 null（走 legacy 补算）；anchor 与候选冲突或顺序非法返回 "ambiguous"；
 * 合法则原样还原 target 与 goalBoundary（含显式 none）。
 */
function persistedTarget(
  messages: readonly MessageWithParts[],
  candidate: StableForkCandidate,
):
  | { goalBoundary?: StableForkGoalBoundaryMetadata; target: StableForkTarget }
  | null
  | "ambiguous" {
  const boundary = messages.find(
    (message) => String(message.info.id) === candidate.boundaryMessageId,
  );
  const anchor = boundary?.info.anchor;
  if (!anchor || (!anchor.productTurnId && !anchor.orderedMessageIds && !anchor.boundaryMessageId)) {
    return null;
  }
  if (
    (anchor.productTurnId !== undefined && anchor.productTurnId !== candidate.productTurnId) ||
    anchor.boundaryMessageId !== candidate.boundaryMessageId ||
    !anchor.orderedMessageIds ||
    !idsAreOrdered(messages, anchor.orderedMessageIds, candidate.boundaryMessageId)
  ) {
    return "ambiguous";
  }
  return {
    target: {
      productTurnId: anchor.productTurnId ?? candidate.productTurnId,
      transcriptTurnId: String(anchor.turnId ?? candidate.transcriptTurnId),
      orderedMessageIds: anchor.orderedMessageIds.map(String),
      boundaryMessageId: anchor.boundaryMessageId,
    },
    ...(anchor.goalBoundary ? { goalBoundary: anchor.goalBoundary } : {}),
  };
}

/**
 * 稳定 fork 目标解析入口。
 *
 * 顺序：先尝试持久 anchor；缺失时才按 boundary parent/user 关系补算；
 * 两种情况都必须解析出 goal 边界，否则返回 guard.forkTargetAmbiguous。
 * 已成功解析但 anchor 未完整持久化时，惰性补写 anchor（副作用：一次 saveMessage）；
 * 后续重试直接复用同一组 orderedMessageIds，避免 fork 点漂移。
 * 副作用：仅在补写时写一条 message anchor；失败向上冒泡，不静默降级。
 */
/**
 * projection 已证明 product turn 成功且 row 是轮尾 completed assistant；这里再以
 * transcript 顺序固定 raw user/assistant/tool message 边界。历史数据只有 parent/user
 * 边界唯一时才 fallback，随后把 anchor 惰性补写，后续重试固定使用同一组 id。
 */
export async function resolveStableForkTargetFromTranscript(options: {
  candidate: StableForkCandidate;
  messages: readonly MessageWithParts[];
  store: SessionStorePort;
}): Promise<V4StableForkTargetResolution> {
  const persisted = persistedTarget(options.messages, options.candidate);
  if (persisted === "ambiguous") {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  if (persisted) {
    const goalBoundary =
      persisted.goalBoundary ??
      (await legacyGoalBoundary(options.store, options.messages, persisted.target.boundaryMessageId));
    if (!goalBoundary) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
    const boundary = options.messages.find(
      (message) => String(message.info.id) === persisted.target.boundaryMessageId,
    );
    if (!persisted.goalBoundary || boundary?.info.anchor?.productTurnId === undefined) {
      await persistResolvedAnchor(options, persisted.target, goalBoundary);
    }
    return { ok: true, target: persisted.target, goalBoundary };
  }

  const boundaryIndex = options.messages.findIndex(
    (message) => String(message.info.id) === options.candidate.boundaryMessageId,
  );
  const boundary = options.messages[boundaryIndex];
  if (boundaryIndex < 0 || boundary?.info.role !== "assistant" || boundary.info.error) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const boundaryParentId = boundary.info.parentID;

  let startIndex = options.candidate.startMessageId
    ? options.messages.findIndex(
        (message) => String(message.info.id) === options.candidate.startMessageId,
      )
    : -1;
  if (startIndex < 0) {
    startIndex = options.messages.findIndex(
      (message) => String(message.info.id) === String(boundaryParentId),
    );
  }
  if (startIndex < 0 || startIndex > boundaryIndex) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const start = options.messages[startIndex];
  if (!start || start.info.role !== "user") {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  // 内层出现真实 user 轮说明一轮内包含多次真实提交，边界不再唯一，必须拒绝。
  const nestedRealUser = options.messages
    .slice(startIndex + 1, boundaryIndex + 1)
    .some((message) => isConversationRealUserTurnStarter(message));
  if (nestedRealUser) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }

  const orderedMessageIds = options.messages
    .slice(startIndex, boundaryIndex + 1)
    .map((message) => String(message.info.id));
  const target: StableForkTarget = {
    productTurnId: options.candidate.productTurnId,
    transcriptTurnId: String(boundary.info.anchor?.turnId ?? options.candidate.transcriptTurnId),
    orderedMessageIds,
    boundaryMessageId: options.candidate.boundaryMessageId,
  };
  const goalBoundary = await legacyGoalBoundary(
    options.store,
    options.messages,
    target.boundaryMessageId,
  );
  if (!goalBoundary) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  await persistResolvedAnchor(options, target, goalBoundary);
  return { ok: true, target, goalBoundary };
}

/**
 * legacy goal 边界降级：
 * 若 parent 当前仍有 target，不能把"未来状态"冒充历史，返回 null；
 * 无 current target 且无 verifier ledger 时才无歧义地返回显式 none；
 * 其余情况（有 ledger 无 target）无法判定，返回 null 让调用方拒绝 fork。
 */
async function legacyGoalBoundary(
  store: SessionStorePort,
  messages: readonly MessageWithParts[],
  boundaryMessageId: string,
): Promise<StableForkGoalBoundaryMetadata | null> {
  const boundary = messages.find((message) => String(message.info.id) === boundaryMessageId);
  if (!boundary) return null;
  // Legacy transcript 没有 fork 点 goal 版本；parent 当前仍有 target 时不能把未来状态
  // 冒充历史。无 current target 且无 verifier ledger 才可无歧义降级为 explicit none。
  if (await store.readTarget({ sessionID: boundary.info.sessionID })) return null;
  if (!store.sessionEntries) return { kind: "none" };
  const entries = await store.sessionEntries({
    sessionID: boundary.info.sessionID,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  return entries.length === 0 ? { kind: "none" } : null;
}

/**
 * 惰性固化 boundary message 的 anchor（productTurnId/orderedMessageIds/
 * boundaryMessageId/goalBoundary）。只写这一条消息，不触碰其他状态；
 * boundary 已不在 transcript 时直接返回，不制造悬空 anchor。
 */
async function persistResolvedAnchor(
  options: {
    candidate: StableForkCandidate;
    messages: readonly MessageWithParts[];
    store: SessionStorePort;
  },
  target: StableForkTarget,
  goalBoundary: StableForkGoalBoundaryMetadata,
): Promise<void> {
  const boundary = options.messages.find(
    (message) => String(message.info.id) === target.boundaryMessageId,
  );
  if (!boundary) return;
  await options.store.saveMessage({
    ...boundary.info,
    anchor: {
      ...boundary.info.anchor,
      productTurnId: target.productTurnId,
      orderedMessageIds: target.orderedMessageIds as MessageId[],
      boundaryMessageId: target.boundaryMessageId as MessageId,
      goalBoundary,
    },
  });
}
