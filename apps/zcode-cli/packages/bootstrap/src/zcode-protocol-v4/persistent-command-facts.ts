// commands/query 的 durable 事实装载与写入（进程重启后唯一的幂等来源）。
//
// 读取：一份 session 的 message/part（transcript + timeline）、sessionEntries
// （child/timeline 的真实 ACK）与 session_input 账本（discarded/cancelled）三处，
// 归一成四组按 commandId 精确索引的 ACK。
// 写入：只有 timeline/child 需要额外落 session entry；其余来源本就是业务写入的副产物。
// 不变量：这里只回放“已发生的终态”，绝不重放命令；查不到的事实不伪造 accepted。
import type {
  MessageWithParts,
  SessionId,
  SessionInputRecord,
  SessionStorePort,
} from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { PersistentCommandFactSource } from "./persistent-command-index.js";

// session entry 的类型标签；id 约定为 v4_command_fact:{source}:{commandId}，
// 使同一命令重复 settle 时是覆盖写而不是追加第二条事实。
export const V4_COMMAND_FACT_SESSION_ENTRY = "v4/command_fact";

// 只接受可回放的终态 ACK（accepted/rejected/failed）；stale/duplicate/noop 属于决策期
// 结果，不进入持久事实，避免重启后把临时裁决当成已执行。revisionAtDecision 必须存在。
function commandAck(value: unknown): CommandAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ack = value as Partial<CommandAck>;
  if (typeof ack.commandId !== "string" || ack.commandId.length === 0) return null;
  if (ack.status !== "accepted" && ack.status !== "rejected" && ack.status !== "failed") {
    return null;
  }
  if (typeof ack.revisionAtDecision !== "number") return null;
  return ack as CommandAck;
}

// 从 session_input 记录里取发起它的客户端命令 id；两种 intent 位置都兼容历史数据。
// 取不到表示这条输入不是 v4 命令发起（或已丢失关联），不进入 discarded 事实集。
function discardedSourceCommandId(record: SessionInputRecord): string | undefined {
  for (const candidate of [record.payload.conversationInputIntent, record.payload.intent]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const sourceCommandId = (candidate as Record<string, unknown>).sourceCommandId;
    if (typeof sourceCommandId === "string" && sourceCommandId.length > 0) {
      return sourceCommandId;
    }
  }
  return undefined;
}

/**
 * 装载一个 session 的全部持久命令事实，返回按来源分组的 ACK 数组。
 *
 * 输入：session store + sessionId；可选 discardAdmittedOnLoad 表示“CLI 刚重启”，
 * 需要把仍停留在 admitted 的输入显式结转为 discarded(session_resumed) 再作为失败事实。
 * 输出：仅含实际命中的 commandId，各来源互不合并；上层按 transcript → timeline →
 * child → discarded 的优先级依次查询。
 * 副作用：启用 discardAdmittedOnLoad 时会 durable 结算 admitted 记录；其余只读。
 * 失败：任一 store 读取抛错直接向上传播（不返回部分事实，避免半套索引误导幂等判断）。
 * 时序：transcript/timeline 先入 Map，session entry 的真实 ACK 随后覆盖，保证
 * 带 revision/失败原因的终态优先于合成的 accepted。
 */
export async function loadPersistentCommandFacts(
  store: SessionStorePort,
  sessionId: SessionId,
  options: { discardAdmittedOnLoad?: boolean } = {},
): Promise<Partial<Record<PersistentCommandFactSource, CommandAck[]>>> {
  const [messages, entries, discardedInputs] = await Promise.all([
    store.messages({ sessionID: sessionId }),
    store.sessionEntries?.({ sessionID: sessionId, type: V4_COMMAND_FACT_SESSION_ENTRY }) ?? [],
    options.discardAdmittedOnLoad
      ? (store.listSessionInputs?.({ sessionID: sessionId }) ?? [])
      : Promise.all([
          store.listSessionInputs?.({ sessionID: sessionId, status: "discarded" }) ?? [],
          // cancelled 也是 durable terminal input fact：若这里只读 discarded，用户主动删除
          // 的 queue item 在 512 LRU 淘汰后会退成 unknown，并可能以同 commandId 再执行。
          store.listSessionInputs?.({ sessionID: sessionId, status: "cancelled" }) ?? [],
        ]).then(([discarded, cancelled]) => [...discarded, ...cancelled]),
  ]);
  const facts: Record<PersistentCommandFactSource, Map<string, CommandAck>> = {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };

  for (const message of messages as MessageWithParts[]) {
    // timeline part 只证明“命令已落到 timeline”，此处先给最小 accepted；
    // 若 session entry 里有完整 ACK，会在后面的循环里覆盖。
    for (const part of message.parts) {
      if (part.type !== "timeline" || !part.sourceCommandId) continue;
      facts.timeline.set(part.sourceCommandId, {
        commandId: part.sourceCommandId,
        status: "accepted",
        revisionAtDecision: 0,
      });
    }
    // 同一命令可能对应多条 message（分段），首条 anchor 已足以证明落盘，无需重复写。
    const sourceCommandId = message.info.anchor?.sourceCommandId;
    if (!sourceCommandId || facts.transcript.has(sourceCommandId)) continue;
    facts.transcript.set(sourceCommandId, {
      commandId: sourceCommandId,
      status: "accepted",
      revisionAtDecision: 0,
    });
  }

  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    // 只认 timeline/child 两类 entry：其它来源（transcript/discarded）已有各自的
    // 业务表，不再需要额外事实，避免把两类记录混成同一来源。
    const source = data?.source;
    const ack = commandAck(data?.ack);
    if ((source === "timeline" || source === "child") && ack) {
      facts[source].set(ack.commandId, ack);
    }
  }

  for (const record of discardedInputs) {
    let terminalStatus = record.status;
    let terminalReason = record.statusReason;
    // 重启后仍 admitted 的输入必须显式终结：既不静默蒸发，也不被自动重放。
    if (record.status === "admitted" && options.discardAdmittedOnLoad) {
      await store.settleSessionInput?.({
        id: record.id,
        sessionID: sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
      terminalStatus = "discarded";
      terminalReason = "session_resumed";
    }
    if (terminalStatus !== "discarded" && terminalStatus !== "cancelled") {
      continue;
    }
    // 没有 sourceCommandId 的记录无法与客户端 commandId 对齐，跳过而非猜测。
    const sourceCommandId = discardedSourceCommandId(record);
    if (!sourceCommandId) continue;
    // 区分“重启丢弃”与“用户主动取消”：前者可提示确认重发，后者是明确失败。
    const discardedOnRestart =
      terminalStatus === "discarded" && terminalReason === "session_resumed";
    const cancelledReasonCode =
      terminalReason?.startsWith("fault.") ||
      terminalReason?.startsWith("proto.") ||
      terminalReason?.startsWith("guard.")
        ? terminalReason
        : "fault.command.inputCancelled";
    facts.discarded.set(sourceCommandId, {
      commandId: sourceCommandId,
      status: "failed",
      reasonCode: discardedOnRestart
        ? "fault.command.inputDiscardedOnRestart"
        : cancelledReasonCode,
      message: discardedOnRestart
        ? "Input was discarded when the CLI restarted; confirm before resending."
        : "Input was cancelled before it entered the transcript.",
      revisionAtDecision: 0,
      ...(discardedOnRestart
        ? {
            // 旧 query 丢掉了 session_input.delivery，renderer 只能把所有
            // restart discard 当成可重发丢失；queue/guide 实际只属于旧 runtime。
            result: { type: "inputDisposition" as const, delivery: record.delivery },
          }
        : {}),
    });
  }

  return Object.fromEntries(
    Object.entries(facts).map(([source, values]) => [source, [...values.values()]]),
  ) as Partial<Record<PersistentCommandFactSource, CommandAck[]>>;
}

/**
 * 写入一条 timeline/child 命令事实（durable session entry）。
 *
 * 输入：store、sessionId、来源（仅允许这两类）、真实 ACK 与可选 metadata。
 * 幂等：entry id 由 source+commandId 决定，重复调用是覆盖写，不会累积多条。
 * 失败：store 不支持 saveSessionEntry 时抛 persistentFactStoreUnavailable，调用方必须
 * 显式失败而不是静默跳过——否则重启后该命令会退化成 unknown。
 * 返回值无；成功即代表重启后可按 commandId 精确查到该 ACK。
 */
export async function savePersistentCommandFact(
  store: SessionStorePort,
  sessionId: SessionId,
  source: Extract<PersistentCommandFactSource, "timeline" | "child">,
  ack: CommandAck,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!store.saveSessionEntry) throw new Error("fault.command.persistentFactStoreUnavailable");
  const now = Date.now();
  await store.saveSessionEntry({
    id: `v4_command_fact:${source}:${ack.commandId}`,
    sessionID: sessionId,
    type: V4_COMMAND_FACT_SESSION_ENTRY,
    time: { created: now, updated: now },
    data: { source, ack, ...(metadata ? { metadata } : {}) },
  });
}
