// 一次性的「修复前」重建：把 6 行 `//` 放回 SQL 模板字符串内部，用于 prepare 对照。
import fs from 'node:fs';
const src = 'D:/code/ZCode/packages/services/src/session/tasksDatabase/source-server-schema-v5.ts';
const dst = 'D:/code/_annot_baseline/ZC-fix-sql-literal/before/source-server-schema-v5.ts';
let text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const pairs = [
  [
    '    db.exec(`\n        INSERT INTO workspace_migration_ledger_v2 (',
    '    db.exec(`\n// 数据搬运显式列名，缺失列以 NULL 或推导值补齐。\n// session_db_generation 必须尽量保留，活动计划依赖它定位会话库代次。\n        INSERT INTO workspace_migration_ledger_v2 (',
  ],
  [
    '    db.exec(`\n        INSERT INTO workspace_migration_conflicts_v2 (',
    '    db.exec(`\n// 旧版没有 conflict_kind 时统一按 task-identity 解释。\n// 旧版没有 relative_path 时写 NULL，不伪造配置路径。\n        INSERT INTO workspace_migration_conflicts_v2 (',
  ],
  [
    "      VALUES ('workspace-migration', 3, ?)\n      ON CONFLICT(schema_name)",
    "      VALUES ('workspace-migration', 3, ?)\n// 版本记账使用 upsert：首次接管插入，重复执行更新。\n// 只有结构发布完成后才写 version=3，保证版本号代表真实状态。\n      ON CONFLICT(schema_name)",
  ],
];
for (const [from, to] of pairs) {
  if (!text.includes(from)) throw new Error('anchor not found: ' + from.slice(0, 40));
  text = text.replace(from, to);
}
fs.mkdirSync('D:/code/_annot_baseline/ZC-fix-sql-literal/before', { recursive: true });
fs.writeFileSync(dst, text);
console.log('written ' + dst);
