// ============================================================
// Hidden session store debug helpers
// ============================================================
// 定位：隐藏调试命令/测试用的只读统计，不属于公开 SessionStorePort。
// 输入输出：debugMigrationIds 返回已应用迁移 id（升序）；debugCounts 返回各表
// 行数，传 sessionID 时按会话过滤（sessions 用 id、其余用 session_id）。
// 副作用：只读 select，无写入。
// 失败语义：SQL 异常直接抛出；表不存在说明迁移未完成，由调用方处理。
// 不变量：permissions/localSettings/schemaMigrations 始终全局计数，不随 sessionID 过滤。

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionId } from "@zcode/contracts";
import type { SessionStoreDebugCounts } from "../options.js";

// 已应用迁移的 id 列表，按字典序；用于诊断库版本落后/跳号问题。
export function debugMigrationIds(db: DatabaseSync): string[] {
  return (
    db.prepare("select id from schema_migration order by id").all() as Array<{ id: string }>
  ).map((row) => row.id);
}

// 汇总各表行数；sessionID 为空时全库统计，非空时只统计该会话拥有的数据。
export function debugCounts(db: DatabaseSync, sessionID?: SessionId): SessionStoreDebugCounts {
  const scoped = sessionID ? " where session_id = ?" : "";
  const values = sessionID ? [sessionID] : [];
  return {
    sessions: count(db, "session", sessionID ? " where id = ?" : "", values),
    messages: count(db, "message", scoped, values),
    parts: count(db, "part", scoped, values),
    todos: count(db, "todo", scoped, values),
    targets: count(db, "session_target", scoped, values),
    sessionEntries: count(db, "session_entry", scoped, values),
    permissions: count(db, "permission", "", []),
    localSettings: count(db, "local_setting", "", []),
    schemaMigrations: count(db, "schema_migration", "", []),
    inputHistory: count(db, "input_history", scoped, values),
    modelUsage: count(db, "model_usage", scoped, values),
    toolUsage: count(db, "tool_usage", scoped, values),
    turnUsage: count(db, "turn_usage", scoped, values),
  };
}

// 通用计数：表名来自内部常量（非用户输入），where 由调用方拼装。
function count(db: DatabaseSync, table: string, where: string, values: SQLInputValue[]): number {
  const row = db.prepare(`select count(*) as count from ${table}${where}`).get(...values) as {
    count: number;
  };
  return row.count;
}
