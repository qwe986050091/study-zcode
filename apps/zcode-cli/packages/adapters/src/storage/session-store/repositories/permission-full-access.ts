// ============================================================
// Permission full-access commit
// ============================================================
// 定位：用户授予 full access（yolo）时的一次性事务：把队列中 pending 输入的
// intent.mode 改成 yolo，并写入 execution + receipt 两条 session entry，
// 保证“授权生效”与“授权凭证”原子落库。
// 输入输出：无返回值；receipt.id 已存在即视为重复提交，直接 commit 空事务返回。
// 副作用：update session_input payload、insert/update session_entry（同事务）。
// 失败语义：session 不一致、队列项已非 admitted、payload 非 JSON 字符串 → throw
// 并 rollback；signal 已中止时在开事务前 throwIfAborted。
// 不变量：execution/receipt 必须同 session；receipt 幂等（按 id 先查先返回）；
// 只有 status='admitted' 的队列项会被改，不会污染已 promoted/cancelled 的输入。

import type { DatabaseSync } from "node:sqlite";
import type { SessionStorePort } from "@zcode/contracts";
import { saveSessionEntry } from "./session-entries.js";

/** SQLite adapter 的同步事务中不 await，取消检查和提交之间没有异步重入窗口。 */
/**
 * 原子提交 full access：先做 session 一致性校验与取消检查，再 begin immediate。
 * 内层按 receipt id 去重（已存在则视为已提交，直接 commit 返回，不重复改队列）；
 * 随后逐条改写 admitted 队列项的 intent.mode=yolo，最后写两条 entry 并 commit。
 * 任意异常 → rollback 后抛出，队列与 entry 都不会留下半份授权。
 */
export async function commitPermissionFullAccess(
  db: DatabaseSync,
  input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
): Promise<void> {
  input.signal?.throwIfAborted();
  if (
    input.execution.sessionID !== input.sessionID ||
    input.receipt.sessionID !== input.sessionID
  ) {
    throw new Error("Permission commit session mismatch");
  }
  db.exec("begin immediate");
  try {
    const existing = db
      .prepare("select session_id from session_entry where id = ?")
      .get(input.receipt.id);
    if (existing) {
      if (existing.session_id !== input.sessionID)
        throw new Error("Permission receipt session mismatch");
      db.exec("commit");
      return;
    }
    const read = db.prepare(
      "select payload from session_input where id = ? and session_id = ? and status = 'admitted'",
    );
    const write = db.prepare(
      "update session_input set payload = ?, time_updated = ? where id = ? and session_id = ? and status = 'admitted'",
    );
    for (const id of input.queueItemIds) {
      const row = read.get(id, input.sessionID);
      if (!row || typeof row.payload !== "string")
        throw new Error(`Pending input unavailable: ${id}`);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      // 同时兼容新旧两个 intent 键；非对象（数组/标量）不强行改写，避免破坏 payload 结构。
      for (const key of ["intent", "conversationInputIntent"]) {
        const intent = payload[key];
        if (intent && typeof intent === "object" && !Array.isArray(intent)) {
          payload[key] = { ...intent, mode: "yolo" };
        }
      }
      write.run(JSON.stringify(payload), Date.now(), id, input.sessionID);
    }
    saveSessionEntry(db, input.execution);
    saveSessionEntry(db, input.receipt);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
