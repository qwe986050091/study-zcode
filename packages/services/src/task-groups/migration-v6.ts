// 职责边界：本文件只提供 task_group_admissions 的建表语句文本，执行顺序与版本推进由迁移器负责。
// INV：语句必须保持幂等（IF NOT EXISTS）且不含破坏性操作；误加 DROP/ALTER 会在重放时擦除已有准入记录。
// 冻结 0006 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
export const TASK_GROUP_ADMISSIONS_SQL = `
CREATE TABLE IF NOT EXISTS task_group_admissions (
  workspace_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  system_kind TEXT,
  user_organized INTEGER NOT NULL DEFAULT 0,
  creation_id TEXT,
  PRIMARY KEY (workspace_key, task_id)
);`;
