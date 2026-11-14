// ============================================================
// Input history repository
// ============================================================
// 定位：用户输入历史（上/下键回捞、去重、容量裁剪），按 project 维度保存，
// 每项目仅保留最近 100 条。
// 输入输出：record 返回新 entry；空文本或与最近一条完全相同（文本+附件）时
// 返回 null（表示“未记录”，不是失败）；recall 返回第 skip+1 近的一条或 null。
// 副作用：insert + 删除超出上限的旧行（同一事务）；解码只读。
// 失败语义：事务内异常 rollback 后抛出；附件中的 data: 内联内容被主动丢弃，
// 避免把大 payload 写进历史表。
// 不变量：项目内按 (time_created desc, id desc) 排序；附件序列稳定用于去重比较；
// 空/非法附件归一为 undefined（读方看到“无附件”而非空数组）。

import type { DatabaseSync } from "node:sqlite";
import type {
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  ProjectId,
  SessionId,
} from "@zcode/contracts";
import { decodeJson, encodeJson } from "../json.js";
import type { InputHistoryRow } from "../rows.js";

// 每项目保留条数上限；插入后按时间倒序裁剪，超出部分删除。
const INPUT_HISTORY_LIMIT = 100;

/**
 * 记录一条输入历史：trim 后为空则跳过；与最近一条文本+规范化附件完全一致则
 * 视为重复、返回 null（避免连按回车刷屏）。成功时在事务内插入并裁剪到
 * INPUT_HISTORY_LIMIT 条，返回新建的 entry。
 */
export async function recordInputHistory(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  },
): Promise<InputHistoryEntry | null> {
  const text = input.text.trim();
  if (text.length === 0) return null;
  const attachments = normalizedInputHistoryAttachments(input.attachments);

  const latest = await recallPreviousInputHistory(db, { projectID: input.projectID });
  if (
    latest?.text === text &&
    stableInputHistoryAttachments(latest.attachments) === stableInputHistoryAttachments(attachments)
  ) {
    return null;
  }

  const id = createStorageInputHistoryId();
  const timeCreated = input.time?.created ?? Date.now();

  db.exec("begin immediate");
  try {
    db
      .prepare(
        `
        insert into input_history (id, project_id, session_id, text, attachments, kind, time_created)
        values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.projectID,
        input.sessionID ?? null,
        text,
        encodeJson(attachments),
        input.kind,
        timeCreated,
      );
    db
      .prepare(
        `
        delete from input_history
        where id not in (
          select id from input_history
          order by time_created desc, id desc
          limit ?
        )
        `,
      )
      .run(INPUT_HISTORY_LIMIT);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }

  return {
    id,
    projectID: input.projectID,
    sessionID: input.sessionID,
    text,
    ...(attachments ? { attachments } : {}),
    kind: input.kind,
    time: {
      created: timeCreated,
    },
  };
}

/**
 * 回捞第 skip+1 近的一条历史（skip=0 即最近一条）。skip 为负数时 SQL offset
 * 会报错，调用方应传非负整数；无记录返回 null。
 */
export async function recallPreviousInputHistory(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    skip?: number;
  },
): Promise<InputHistoryEntry | null> {
  const skipCount = input.skip ?? 0;
  const row = db
    .prepare(
      `
      select * from input_history
      where project_id = ?
      order by time_created desc, id desc
      limit 1 offset ?
      `,
    )
    .get(input.projectID, skipCount) as InputHistoryRow | undefined;
  return row ? decodeInputHistoryRow(row) : null;
}

// 行 → entry：session_id 为空时省略该字段；无附件时省略 attachments。
function decodeInputHistoryRow(row: InputHistoryRow): InputHistoryEntry {
  const attachments = normalizedInputHistoryAttachments(
    decodeJson<InputHistoryAttachment[]>(row.attachments),
  );
  return {
    id: row.id as InputHistoryEntry["id"],
    projectID: row.project_id as ProjectId,
    sessionID: row.session_id ? (row.session_id as SessionId) : undefined,
    text: row.text,
    ...(attachments ? { attachments } : {}),
    kind: row.kind as InputHistoryKind,
    time: {
      created: row.time_created,
    },
  };
}

// 附件规范化：只接受 file/image/pdf/url；path 与 content 至少一个非空才保留；
// 全部无效时返回 undefined，避免把空数组写进 JSON 并影响去重。
function normalizedInputHistoryAttachments(
  attachments: InputHistoryAttachment[] | undefined,
): InputHistoryAttachment[] | undefined {
  const normalized = (attachments ?? [])
    .map((attachment): InputHistoryAttachment | undefined => {
      if (
        attachment.type !== "file" &&
        attachment.type !== "image" &&
        attachment.type !== "pdf" &&
        attachment.type !== "url"
      ) {
        return undefined;
      }
      const path = normalizedOptionalString(attachment.path);
      const content = normalizedAttachmentContent(attachment.content);
      if (!path && !content) return undefined;
      return {
        type: attachment.type,
        ...(path ? { path } : {}),
        ...(content ? { content } : {}),
      };
    })
    .filter((attachment): attachment is InputHistoryAttachment => attachment !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

// 去掉首尾空白；空串视为未提供。
function normalizedOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// 历史表只存引用，不存内联 data URL：大对象会让历史和去重比较失去意义。
function normalizedAttachmentContent(value: string | undefined): string | undefined {
  const normalized = normalizedOptionalString(value);
  if (!normalized) return undefined;
  return normalized.startsWith("data:") ? undefined : normalized;
}

// 去重比较用的稳定序列化：先规范化再 JSON.stringify，保证键顺序与空值一致。
function stableInputHistoryAttachments(attachments: InputHistoryAttachment[] | undefined): string {
  return JSON.stringify(normalizedInputHistoryAttachments(attachments) ?? []);
}

// 时间前缀 + 随机 UUID，兼顾排序可读性与唯一性。
function createStorageInputHistoryId(): InputHistoryEntry["id"] {
  return `input_${Date.now().toString(36)}_${crypto.randomUUID()}` as InputHistoryEntry["id"];
}
