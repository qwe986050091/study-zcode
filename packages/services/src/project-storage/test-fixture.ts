// 项目迁移测试夹具：为 project-storage 的迁移用例提供真实的 node:sqlite 内存库与临时目录。
// 该文件仅被 Vitest 用例导入，不进入生产构建图；导出 port 供用例断言契约一致性。
// 所有资源（数据库句柄、临时目录）在 afterEach 中统一关闭并递归删除，避免跨用例残留。
// INV：本文件不注册任何业务逻辑，仅构造初始 schema 与最小插入辅助函数。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import type { ProjectStorageContract } from "#src/project-storage/contract.js";
import { projectStorage } from "#src/project-storage/index.js";
// 契约实例透传：让用例以同一 ProjectStorageContract 类型验证实现，避免夹具自造桩。
// 若未来实现签名变更，此处会在类型层面直接报错，起到契约守门作用。
export const port: ProjectStorageContract = projectStorage;
// 模块级资源栈：记录每个 fixture 实例创建的数据库与临时目录，供 afterEach 统一回收。
// 之所以放在模块级，是因为 Vitest 的 afterEach 无法直接持有 fixture 内部作用域。
const resources: Array<{ db: DatabaseSync; directory: string }> = [];
// 用 splice(0) 一次性取走并清空队列，保证重复调用（如嵌套用例）不会重复关闭同一句柄。
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
// 构造一个隔离的测试上下文：临时 workspace 目录 + 内存 sqlite 库 + 只读 settings 快照。
// savedWorkspaces 决定 lastWorkspaceSession 的内容，用于覆盖多工作区迁移场景。
export async function fixture(savedWorkspaces: readonly string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-migration-"));
  const db = new DatabaseSync(":memory:");
  resources.push({ db, directory });
// 一次性建立迁移所依赖的全部表结构与一条哨兵数据，确保用例可断言「未触碰表保持不变」。
// 注意此段为多语句 exec，模板字符串内容属于被测语义，任何改动都应通过用例回归验证。
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT, workspace_path TEXT, workspace_identity TEXT, task_id TEXT,
    title TEXT DEFAULT '', provider TEXT DEFAULT 'glm', title_overridden INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, unread_at INTEGER,
    task_status TEXT DEFAULT 'completed', created_at INTEGER DEFAULT 1, updated_at INTEGER DEFAULT 2,
    PRIMARY KEY(workspace_key,task_id));
    CREATE TABLE task_groups(group_id TEXT PRIMARY KEY,title TEXT,color TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE task_group_members(group_id TEXT,workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,sort_order INTEGER);
    CREATE TABLE task_group_workspace_bootstraps(workspace_key TEXT PRIMARY KEY,group_id TEXT);
    CREATE TABLE task_group_view_node_orders(node_type TEXT,node_key TEXT,sort_order INTEGER);
    CREATE TABLE automations(automation_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE off_peak_tasks(off_peak_task_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE untouched(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO untouched VALUES ('keep','unchanged');`);
// 最小插入辅助：按 id 写入一条 tasks 记录，identity 缺省时退化为 path，覆盖旧库兼容路径。
// 返回 sqlite 的 run 结果，便于用例断言变更行数。
  const add = (id: string, path: string, identity?: string) =>
    db
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title) VALUES(?,?,?,?,?)",
      )
      .run(identity ?? path, path, identity ?? null, id, `title ${id}`);
// 对外暴露 db、add 与最小 context 三件套，够迁移用例读写即可，不模拟完整宿主环境。
// context.now 固定为 10，保证时间相关断言稳定可重复。
  return {
    db,
    add,
    context: {
      backupDirectories: [directory],
      now: () => 10,
      settings: {
        recentProjects: [],
        lastWorkspaceSession: savedWorkspaces.map((workspacePath) => ({
          kind: "local" as const,
          workspacePath,
        })),
      },
    },
  };
}
