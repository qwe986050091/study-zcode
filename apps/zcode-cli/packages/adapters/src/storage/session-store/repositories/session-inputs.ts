// INV-01 接纳序号在会话内单调，由子查询取最大值加一：守住位置 接纳插入语句；改错故障 并发接纳拿到相同序号，队列顺序错乱。
// INV-02 同标识重入是幂等的：只修正种类、投递方式与载荷，保留原序号与状态：守住位置 冲突分支；改错故障 预接纳记录被回退成待接纳。
// INV-03 终态只允许从已接纳单向迁移：守住位置 所有状态更新语句的条件；改错故障 已提升的记录被迟到的丢弃覆盖。
// INV-04 提升序号在会话内单调，与接纳序号互不影响：守住位置 提升语句的子查询；改错故障 重启恢复时顺序与接纳顺序不一致。
// INV-05 提升必须与消息、分片写入同事务：守住位置 提升函数的事务包裹；改错故障 队列已消费但对话记录缺失。
// INV-06 任意语句失败都要回滚并原样抛出：守住位置 两个事务的捕获分支；改错故障 半提交让账本与记录永久不一致。
// INV-07 共享上下文引用必须是待用或已预留状态，否则抛错：守住位置 状态校验；改错故障 已附着的上下文被二次附着。
// INV-08 共享上下文条目找不到时抛错而不是跳过：守住位置 条目查找；改错故障 缺少导入时静默提升，消息里留下悬挂引用。
// INV-09 附着时同时更新条目状态与对应消息元数据：守住位置 两处写入；改错故障 条目与消息对上下文状态各说一套。
// INV-10 队列编辑只作用于已接纳记录：守住位置 编辑的读写语句；改错故障 编辑已提升记录，历史被改写。
// INV-11 队列编辑必须整批原子：守住位置 立即写事务包裹；改错故障 部分更新导致队列与意图不一致。
// INV-12 空更新直接返回，不开启事务：守住位置 长度判断；改错故障 空操作也拿写锁。
// INV-13 编辑必须同步持久意图，避免重启后恢复旧载荷：守住位置 意图合并段；改错故障 重启后队列回到编辑前。
// INV-14 载荷解码失败一律回落空文本：守住位置 解码函数的捕获；改错故障 单条坏记录让整队列不可读。
// INV-15 投递方式非法时回落队列：守住位置 行解码；改错故障 未知枚举进入运行时后无处理分支。
// INV-16 状态非法时回落已接纳：守住位置 行解码的状态判断；改错故障 坏记录被当成终态而永久不可消费。
// INV-17 列表恒按接纳序号升序，且可按状态过滤：守住位置 两条查询的排序；改错故障 界面顺序与接纳顺序不一致。
// INV-18 可空列在领域对象中用可选字段表达，不用空串占位：守住位置 行解码的条件展开；改错故障 调用方无法区分「无值」与「空值」。
//
// 模块职责：session_input 账本的读写仓库，负责接纳、编辑、提升、收口与查询。
// 状态所有权：session_input 行是本模块唯一事实源；提升时顺带写消息与条目，必须同事务。
// 阅读顺序：先看行结构与载荷解码，再读接纳与编辑，重点看提升事务，最后看标记、收口与两个查询。
// ============================================================
// session_input ledger repository
// ============================================================
// session_input 账本仓库。
// 语义：admitted（已接受）→ promoted（与 user message/parts 同事务落 transcript）
// / cancelled / discarded / failed。promotion 的原子性是硬要求：杜绝
// 「queue 已消费但 transcript 无 user message」的孤儿窗口（旧 drain 跨 store 无事务）。
// 定位：记录每条被接纳的用户输入的生命周期，供重启恢复、队列编辑与终态收口。
// 输入输出：promote/settle 无返回值；list 按 admitted_sequence 升序返回；单条缺失 null。
// 副作用：insert/update session_input；promote 内还会写 message/part 与 session_entry，
// 全部包在 `begin immediate` 事务里，失败统一 rollback。
// 失败语义：任何一步异常 → rollback 后重新抛出；终态只允许从 admitted 单向迁移。
// 不变量：admitted_sequence / promoted_sequence 均为会话内单调；promoted 后迟到
// 的 discard/cancel 不生效；promotion 与 user message 必须同事务提交。

import type { DatabaseSync } from "node:sqlite";
import type {
  MessageInfo,
  MessagePart,
  SessionId,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { encodeJson } from "../json.js";
import { messages as readMessages, saveMessage, savePart } from "./messages.js";
import * as sessionEntryRepository from "./session-entries.js";

interface SessionInputRow {
  id: string;
  session_id: string;
  /** 输入种类（prompt/command 等），由 runtime 决定，仅校验非空。 */
  kind: string;
  /** 投递方式：startNow / guide / queue，非法值解码时回落 queue。 */
  delivery: string;
  /** 输入载荷 JSON（text + 可选 intent/order 等）。 */
  payload: string;
  /** 接纳顺序，会话内单调，从 0 开始。 */
  admitted_sequence: number;
  /** 提升为 user message 时的会话内序号；null 表示尚未 promoted。 */
  promoted_sequence: number | null;
  /** 提升后对应的 message id；null 表示尚未 promoted。 */
  promoted_message_id: string | null;
  /** 生命周期状态：admitted/promoted/cancelled/discarded/failed。 */
  status: string;
  /** 终态原因（如 cancel 原因）；null 表示无原因。 */
  status_reason: string | null;
  time_created: number;
  time_updated: number;
}

/**
 * 预接纳/修正一条输入（幂等 upsert）：新行 status=admitted、admitted_sequence 取
 * 会话内 max+1；同 id 重入只更新 kind/delivery/payload 与 time_updated，
 * 保留原 sequence 与状态（执行前预 admission 可被 runtime 真实值修正）。
 * payload 序列化失败/为空时兜底 "{}"，保证 text 解码不崩。
 */
// saveSessionInput 被预接纳与 runtime 修正共用，同 id 重入必须幂等。
// now 只取一次，insert 与 on conflict 分支共用同一个值。
// encodeJson 返回空时写入 "{}"，decodePayload 才不会崩。
// 不开事务：单条 insert ... on conflict 语句自身原子。
export async function saveSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  },
): Promise<void> {
  const now = Date.now();
  // admitted_sequence 按 session 内账本单调分配；同 id 重入会用 runtime 的实际
  // kind/delivery/payload 修正执行前预 admission，同时保留原序与状态（幂等）。
  db.prepare(
    `
      insert into session_input (
        id, session_id, kind, delivery, payload,
        admitted_sequence, status, time_created, time_updated
      )
      values (
        ?, ?, ?, ?, ?,
        (
          select coalesce(max(admitted_sequence), -1) + 1
          from session_input
          where session_id = ?
        ),
        'admitted', ?, ?
      )
      on conflict(id) do update set
        kind = excluded.kind,
        delivery = excluded.delivery,
        payload = excluded.payload,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.id,
    input.sessionID,
    input.kind,
    input.delivery,
    encodeJson(input.payload) ?? "{}",
    input.sessionID,
    now,
    now,
  );
}

// 容错解码 payload：坏 JSON 或非对象一律回落 { text: "" }，
// 因为账本记录损坏不应让整个队列/恢复流程不可用。
// parsed 必须是非数组对象，否则 decodePayload 回落到空载荷。
// 返回值补上 text 字段，调用方可直接读 payload.text。
// JSON.parse 抛错时 catch 回落到空载荷，不阻塞队列恢复。
// 展开成新对象，不与数据库行或 parsed 共享引用。
function decodePayload(raw: string): { text: string; [key: string]: unknown } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ({ text: "", ...(parsed as Record<string, unknown>) } as {
          text: string;
          [key: string]: unknown;
        })
      : { text: "" };
  } catch {
    return { text: "" };
  }
}

// 只对已接纳记录做浅层 patch：重写 text、order.queuePosition 与 intent/delivery，
// 其余字段原样保留；未知标量/数组形状的 payload 不改动。
interface SessionInputPatch {
  delivery?: SessionInputDelivery;
  id: string;
  intent?: TurnInputIntentMetadata;
  text?: string;
  queuePosition?: number;
}

// 合并 patch 到 conversationInputIntent（或 intent）：queuePosition 优先取显式
// patch，其次 intent；fallbackReason 会同时写 steer.state=fellBack。
function patchObject(value: unknown, patch: SessionInputPatch): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const current = value as Record<string, unknown>;
  const order = current.order;
  const intent = patch.intent;
  return {
    ...current,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.queuePosition !== undefined || intent?.queuePosition !== undefined
      ? {
          order:
            order && typeof order === "object" && !Array.isArray(order)
              ? {
                  ...(order as Record<string, unknown>),
                  queuePosition: patch.queuePosition ?? intent?.queuePosition,
                }
              : { queuePosition: patch.queuePosition ?? intent?.queuePosition },
        }
      : {}),
    ...(intent
      ? {
          delivery: {
            requested: intent.requestedDelivery,
            admitted: intent.admittedDelivery,
            ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
          },
          steer: intent.fallbackReasonCode
            ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
            : current.steer,
        }
      : {}),
  };
}

/**
 * 批量更新仍处于 admitted 的输入（队列编辑/重排/改投递方式）。使用
 * `begin immediate` 串行化，保证整批 patch 要么全写要么全不写；单条未命中
 * （已 promoted/已终态/不存在）则跳过。空 updates 直接返回，不开启事务。
 * 必须同步更新 durable intent，否则 CLI restart 后会按旧 payload 恢复队列。
 * 副作用：update session_input；失败 rollback 并重新抛出。
 */
/** queue edit/reorder 必须同步更新 durable intent，避免 CLI restart 后恢复旧 payload。 */
// updates.length 为 0 时直接 return，不开事务也不持写锁。
// read 与 write 两条 prepared statement 在事务外预编译复用。
// begin immediate 包住整批，保证全写或全不写。
// 单条未命中说明已 promoted 或终态，continue 跳过而不抛错。
export async function updateSessionInputs(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    updates: SessionInputPatch[];
  },
): Promise<void> {
  if (input.updates.length === 0) return;
  const read = db.prepare(
    "select delivery, payload from session_input where id = ? and session_id = ? and status = 'admitted'",
  );
  const write = db.prepare(
    "update session_input set delivery = ?, payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
  );
  db.exec("begin immediate");
  try {
    const now = Date.now();
    for (const update of input.updates) {
      const row = read.get(update.id, input.sessionID) as
        | { delivery: SessionInputDelivery; payload: string }
        | undefined;
      if (!row) continue;
      const payload = decodePayload(row.payload);
      if (update.text !== undefined) payload.text = update.text;
      if ("conversationInputIntent" in payload) {
        payload.conversationInputIntent = patchObject(payload.conversationInputIntent, update);
      }
      // 兼容当前 runtime metadata；新写入权威格式仍是 conversationInputIntent。
      if (update.intent) {
        payload.intent = update.intent;
      } else if ("intent" in payload && update.queuePosition !== undefined) {
        const intent = payload.intent;
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          payload.intent = {
            ...(intent as Record<string, unknown>),
            queuePosition: update.queuePosition,
          };
        }
      }
      write.run(
        update.delivery ?? row.delivery,
        encodeJson(payload) ?? "{}",
        now,
        update.id,
        input.sessionID,
      );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * 把一条 admitted 输入提升为 transcript：写 user message 与其 parts、处理
 * shared_context_import 引用，最后把账本置 promoted 并分配 promoted_sequence。
 * 整个过程在单个 `begin immediate` 事务内——这是硬要求：promotion 与 user
 * message 必须原子，否则会出现“队列已消费但 transcript 没有 user message”。
 * 失败语义：任意语句异常 → rollback 后抛出，账本仍保持 admitted，可重试。
 * 注意：shared context 状态不是 pending/reserved，或找不到导入 entry → throw。
 */
// 事务是硬要求：消息、分片、上下文条目与账本必须一体提交。
// 先写消息与分片，再处理共享上下文引用，最后收口账本。
// 共享上下文引用只处理 import 类型，其余引用直接忽略。
// 条目状态不符或缺失都抛错，由回滚保证账本仍可重试。
// 最后一步分配提升序号，与接纳序号各自独立单调。
export async function promoteSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  },
): Promise<void> {
  const now = Date.now();
  db.exec("begin immediate");
  try {
    await saveMessage(db, input.message);
    for (const part of input.parts) {
      await savePart(db, part);
    }
    const refs =
      input.message.metadata && typeof input.message.metadata === "object"
        ? (input.message.metadata as Record<string, unknown>).inputIntent &&
          typeof (input.message.metadata as Record<string, unknown>).inputIntent === "object"
          ? (
              (input.message.metadata as Record<string, unknown>).inputIntent as Record<
                string,
                unknown
              >
            ).sharedContextRefs
          : undefined
        : undefined;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (
          !ref ||
          typeof ref !== "object" ||
          (ref as Record<string, unknown>).kind !== "shared_context_import"
        )
          continue;
        const contextId = (ref as Record<string, unknown>).context_id;
        if (typeof contextId !== "string") continue;
        const entry = sessionEntryRepository
          .sessionEntries(db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
          .find((candidate) => {
            const data = candidate.data;
            return Boolean(
              data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              (data as Record<string, unknown>).contextId === contextId,
            );
          });
        if (!entry) throw new Error("shared context import is missing");
        const data = entry.data as Record<string, unknown>;
        if (!["pending", "reserved"].includes(String(data.status))) {
          throw new Error("shared context import is no longer attachable");
        }
        sessionEntryRepository.saveSessionEntry(db, {
          ...entry,
          time: { ...entry.time, updated: now },
          data: { ...data, status: "attached", attachedMessageId: String(input.message.id) },
        });
        const contextMessage = (
          await readMessages(db, {
            sessionID: input.sessionID,
          })
        ).find((candidate) => {
          const metadata = candidate.info.metadata;
          return Boolean(
            metadata &&
            typeof metadata === "object" &&
            (metadata as Record<string, unknown>).contextId === contextId,
          );
        });
        if (contextMessage) {
          await saveMessage(db, {
            ...contextMessage.info,
            metadata: {
              ...(contextMessage.info.metadata ?? {}),
              sharedContextStatus: "attached",
            },
          });
        }
      }
    }
    db.prepare(
      `
        update session_input
        set status = 'promoted',
            promoted_message_id = ?,
            promoted_sequence = (
              select coalesce(max(promoted_sequence), -1) + 1
              from session_input
              where session_id = ?
            ),
            time_updated = ?
        where id = ? and session_id = ?
        `,
    ).run(String(input.message.id), input.sessionID, now, input.id, input.sessionID);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * 仅账本层面的 promoted 标记（不写 message）：用于 message 已在别的事务落库的
 * 场景。where 限定 status='admitted'，已 promoted/终态的行不会被第二次改写。
 */
// 用于消息已在别的事务落库的场景，这里只改账本。
// 条件限定已接纳，已提升或已终态的行不会被二次改写。
// 提升序号同样取会话内最大值加一。
// 时间戳在语句参数处取当前时刻，不加额外读。
export async function markSessionInputPromoted(
  db: DatabaseSync,
  input: { id: string; sessionID: SessionId; promotedMessageID: string },
): Promise<void> {
  db.prepare(
    `
      update session_input
      set status = 'promoted',
          promoted_message_id = ?,
          promoted_sequence = (
            select coalesce(max(promoted_sequence), -1) + 1
            from session_input
            where session_id = ?
          ),
          time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.promotedMessageID, input.sessionID, Date.now(), input.id, input.sessionID);
}

/**
 * 收口为 cancelled / discarded / failed（带可选原因）。只更新仍为 admitted 的行，
 * 因此 promoted 之后迟到的 discard 不会把状态回退；重复收口是幂等的。
 */
// update 带 status = 'admitted' 条件，迟到的收口不会回退状态。
// 重复收口幂等：第二次 update 自然未命中 0 行。
// input.reason 缺省时写 null 进 status_reason，不省略列。
// status 终态集合由调用方保证，settleSessionInput 不再校验。
export async function settleSessionInput(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  },
): Promise<void> {
  // 只收口未终态的记录：promoted 后到达的迟到 discard 不得回退状态。
  db.prepare(
    `
      update session_input
      set status = ?, status_reason = ?, time_updated = ?
      where id = ? and session_id = ? and status = 'admitted'
      `,
  ).run(input.status, input.reason ?? null, Date.now(), input.id, input.sessionID);
}

// 列账本：可按 status 过滤；恒按 admitted_sequence 升序，保证与接纳顺序一致。
export async function listSessionInputs(
  db: DatabaseSync,
  input: { sessionID: SessionId; status?: SessionInputStatus },
): Promise<SessionInputRecord[]> {
  const rows = (input.status
    ? db
        .prepare(
          `
            select * from session_input
            where session_id = ? and status = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID, input.status)
    : db
        .prepare(
          `
            select * from session_input
            where session_id = ?
            order by admitted_sequence
            `,
        )
        .all(input.sessionID)) as unknown as SessionInputRow[];
  return rows.map(decodeSessionInputRow);
}

// 按 id 读取单条账本记录；跨会话不额外校验（id 全局唯一），不存在返回 null。
export async function getSessionInputById(
  db: DatabaseSync,
  id: string,
): Promise<SessionInputRecord | null> {
  const row = db.prepare("select * from session_input where id = ?").get(id) as
    | SessionInputRow
    | undefined;
  return row ? decodeSessionInputRow(row) : null;
}

// 行 → 领域对象：可空列用“存在才展开”输出 undefined，枚举非法时回落
// delivery=queue / status=admitted，坏记录仍可被队列安全消费。
// 可空列用条件展开表达，缺省即不出现该字段。
// 枚举非法时回落到安全的可消费取值。
// 载荷解码与状态归一都在这一个出口完成，保证读路径一致。
function decodeSessionInputRow(row: SessionInputRow): SessionInputRecord {
  const payload = decodePayload(row.payload);
  return {
    id: row.id,
    sessionID: row.session_id as SessionId,
    kind: row.kind,
    delivery:
      row.delivery === "startNow" || row.delivery === "guide" || row.delivery === "queue"
        ? row.delivery
        : "queue",
    payload,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence !== null ? { promotedSequence: row.promoted_sequence } : {}),
    ...(row.promoted_message_id !== null
      ? { promotedMessageID: row.promoted_message_id as SessionInputRecord["promotedMessageID"] }
      : {}),
    status: (["admitted", "promoted", "cancelled", "discarded", "failed"].includes(row.status)
      ? row.status
      : "admitted") as SessionInputStatus,
    ...(row.status_reason !== null ? { statusReason: row.status_reason } : {}),
    time: { created: row.time_created, updated: row.time_updated },
  };
}
