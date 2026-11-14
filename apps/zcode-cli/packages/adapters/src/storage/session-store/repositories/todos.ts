// ============================================================
// Todos repository
// ============================================================
// 定位：会话级 todo 列表的全量读写。todo 表没有独立 id，以 (session_id, position)
// 表达顺序，读取按 position 升序。
// 输入输出：readTodos 返回 TodoItem[]（空数组 = 无待办）；updateTodos 用传入
// 数组整体替换，元素顺序即 position，无返回值。
// 副作用：updateTodos 在 `begin immediate` 事务内 delete + 批量 insert + touchSession。
// 失败语义：任一步异常 → rollback 后重新抛出，旧 todo 列表完整保留。
// 不变量：同一会话的 position 从 0 连续递增；替换是全量语义，不做增量合并。

import type { DatabaseSync } from "node:sqlite";
import type { SessionId, TodoItem } from "@zcode/contracts";
import { decodeTodoRow } from "../codecs.js";
import type { TodoRow } from "../rows.js";
import { touchSession } from "./sessions.js";

// 读取会话全部 todo，按 position 升序；不存在的会话自然返回 []。
export async function readTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): Promise<TodoItem[]> {
  const rows = db
    .prepare(
      `
      select * from todo
      where session_id = ?
      order by position asc
      `,
    )
    .all(input.sessionID) as unknown as TodoRow[];

  return rows.map(decodeTodoRow);
}

/**
 * 全量替换会话 todo：先删后插（同一事务，避免读到“删而未插”的空列表）。
 * 空数组是合法输入，表示清空全部待办；time_created/time_updated 统一取同一次 now。
 */
export async function updateTodos(
  db: DatabaseSync,
  input: { sessionID: SessionId; todos: TodoItem[] },
): Promise<void> {
  const now = Date.now();

  db.exec("begin immediate");
  try {
    db.prepare("delete from todo where session_id = ?").run(input.sessionID);
    if (input.todos.length > 0) {
      const insert = db.prepare(
        `
        insert into todo (
          session_id, content, status, priority, position, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?)
        `,
      );

      for (const [position, todo] of input.todos.entries()) {
        insert.run(input.sessionID, todo.content, todo.status, todo.priority, position, now, now);
      }
    }
    touchSession(db, input.sessionID, now);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
