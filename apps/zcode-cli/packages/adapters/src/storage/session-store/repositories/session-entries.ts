// ============================================================
// Session entries repository
// ============================================================
// 定位：session_entry 表（会话内事件流：模型选择、运行时快照等）的写入与读取。
// 每条 entry 以 id 唯一，冲突时按“同 type + 同 session + 旧 data 为对象”做局部
// merge（仅 modelSelection），否则整条替换。
// 输入输出：save 无返回值；data 必须可 JSON 序列化，否则 throw；查询按
// time_created, rowid 升序，返回 [] 表示无 entry。
// 副作用：insert/update session_entry，可选 touchSession 推进会话活动时间。
// 失败语义：data 序列化失败 → throw 且不写库；不做事务（单条语句原子）。
// 不变量：model_selection 的 data 始终包成 { modelSelection }，undefined 写成
// 显式 null，防止重启后旧字段被重新导入；同 entry 重写保留原 modelSelection 以外的字段。

import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionEntryInfo,
  type SessionEntryType,
  type SessionId,
} from "@zcode/contracts";
import { decodeSessionEntryRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionEntryRow } from "../rows.js";
import { touchSession } from "./sessions.js";

/**
 * 写入/更新一条 session entry。on conflict(id) 时：若是 model_selection 且
 * type/session 未变、旧 data 是对象，则只 json_set 覆盖 $.modelSelection，
 * 保留其它已有字段；否则用新 data 整体替换（类型变更时不残留旧结构）。
 * 默认顺带 touchSession；调用方可在 fork 等批量场景传 touchSession=false。
 */
export function saveSessionEntry(db: DatabaseSync, input: SessionEntryInfo): void {
  const isModelSelection = input.type === SESSION_ENTRY_MODEL_SELECTION;
  // 旧版读取 data 的平铺身份；新版 port 仍传逻辑 Selection，包装只属于存储 adapter。
  // undefined 与既有 fork 的 null 都写成明确空值，防止重启重新导入旧字段。
  const encoded = encodeJson(
    isModelSelection ? { modelSelection: input.data ?? null } : input.data,
  );
  if (!encoded) {
    throw new Error("Session entry data must be JSON-serializable");
  }

  db.prepare(
    `
      insert into session_entry (id, session_id, type, time_created, time_updated, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        session_id = excluded.session_id,
        type = excluded.type,
        time_updated = excluded.time_updated,
        data = case
          when ? and session_entry.type = excluded.type
            and session_entry.session_id = excluded.session_id
            and json_type(session_entry.data) = 'object'
          then json_set(session_entry.data, '$.modelSelection', json_extract(excluded.data, '$.modelSelection'))
          else excluded.data
        end
      `,
  ).run(
    input.id,
    input.sessionID,
    input.type,
    input.time.created,
    input.time.updated,
    encoded,
    Number(isModelSelection),
  );
  if (input.touchSession !== false) {
    touchSession(db, input.sessionID, input.time.updated);
  }
}

// 列 entry：type 缺省时返回该会话全部类型；稳定排序保证同毫秒写入的顺序
// 与真实插入顺序（rowid）一致。
export function sessionEntries(
  db: DatabaseSync,
  input: { sessionID: SessionId; type?: SessionEntryType | string },
): SessionEntryInfo[] {
  const rows = input.type
    ? db
        .prepare(
          `
          select * from session_entry
          where session_id = ? and type = ?
          order by time_created, rowid
          `,
        )
        .all(input.sessionID, input.type)
    : db
        .prepare(
          `
          select * from session_entry
          where session_id = ?
          order by time_created, rowid
          `,
        )
        .all(input.sessionID);

  return (rows as unknown as SessionEntryRow[]).map(decodeSessionEntryRow);
}
