// 文件职责：把旧版 settings.json 与历史 tasks 迁移成 projects/project_roots/hosts 等新表。
// INV-01：迁移必须幂等：表由 addProjectSchema 保证存在，host 走 ensureHost 去重，
//         project 只对 project_id IS NULL 的 task 写入，重复执行不产生重复项目或改名。
//         （守住它的位置：ensureHost/tableExists/带 IS NULL 条件的 UPDATE）
// INV-02：主机身份以 host_id 为唯一键；同一远程地址可能同时被地址键与 sourceServerId 指代，
//         必须经 aliases 归一到稳定 id，否则同一主机建出两份 hosts 与两份项目。
//         （守住它的位置：migrateConnectionHosts 的 aliases 与 written）
// INV-03：语句顺序固定：schema → local host → 旧任务身份 → 项目集合 → 行级补全 → 索引。
//         提前建 UNIQUE 索引会在历史 task_id 冲突时抛错，整次迁移失败。
// INV-04：本函数不做部分提交、不吞异常；失败由调用方事务整体回滚，只有可降级情况才 warn。
// 破坏后果：INV-01 破 → 每次启动新增一批重名项目；INV-02 破 → 远程会话历史整体脱钩。
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { buildRemoteWorkspaceIdentity, buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";
import {
  ensureHost,
  hostForWorkspace,
  initializeLegacyTaskIdentity,
  OWNERSHIP_DECIDED,
  uniqueRootProject,
} from "#src/project-storage/legacy-tasks.js";
import { addProjectSchema, tableExists } from "#src/project-storage/schema.js";

// 按路径分隔符选择 win32/posix 语义：迁移的 root 可能来自另一平台的 settings，
// 用 posix.basename 处理 C:\x 会把整段当文件名，项目名直接变成完整路径。
function rootName(path: string): string {
  return (path.includes("\\") ? win32 : posix).basename(path) || path;
}

function createProject(
  db: DatabaseSync,
  hostId: string,
  name: string,
  roots: string[],
  overridden: boolean,
  now: number,
): string {
// [权衡] 重名用 " (n)" 后缀而不是加 host 前缀：前缀会改掉用户已见过的项目名，
// 且判重只看本 host 的未删除项目，跨 host 同名是允许的。
  let uniqueName = name || "新项目";
  for (
    let suffix = 2;
    db
      .prepare("SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0")
      .get(hostId, uniqueName);
    suffix++
  )
    uniqueName = `${name} (${suffix})`;
// position 取同 host 现有项目数，用子查询在单条 SQL 内读取，避免两次迁移并发时拿到同一位置。
// [事务] 项目与 roots 必须成对写入；is_primary 只给第一个 root，下游 uniqueRootProject
// 依赖「每个项目恰有一个主根」找回项目，缺主根会让历史会话归到空项目。
  const id = randomUUID();
  db.prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,created_at,updated_at)
    VALUES(?,?,?,?,(SELECT count(*) FROM projects WHERE host_id=?),?,?)`).run(
    id,
    hostId,
    uniqueName,
    overridden ? 1 : 0,
    hostId,
    now,
    now,
  );
  roots.forEach((root, index) =>
    db
      .prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
      )
      .run(id, root, index, index === 0 ? 1 : 0),
  );
  return id;
}

function migrateConnectionHosts(db: DatabaseSync, settings: ProjectMigrationContext["settings"]) {
// [并发] 先按 preferredProfileId 排序再遍历：同一 sourceServerId 的多个 profile 会映射到
// 同一稳定 id，先写者胜出（written 去重），排序保证胜出的是用户在设置里选定的那份。
  const aliases = new Map<string, string>();
  const preferred = new Set(settings?.sourceServers?.map((source) => source.preferredProfileId));
  const profiles = [...(settings?.connectionProfiles ?? [])]
    .filter((profile) => profile.lifecycleState !== "retired")
    .sort((a, b) => Number(preferred.has(b.profileId)) - Number(preferred.has(a.profileId)));
  const written = new Set<string>();
  for (const profile of profiles) {
    const addressIdentity = buildRemoteWorkspaceIdentity("/", profile.target);
    const addressId = hostForWorkspace(addressIdentity).hostId;
    const stableId = profile.sourceServerId
      ? hostForWorkspace(
          buildServerRemoteWorkspaceIdentity({
            serverId: profile.sourceServerId,
            workspacePath: "/",
          }),
        ).hostId
      : addressId;
// [权衡] 地址身份与稳定身份都注册进 aliases：旧数据里两种 identity 都出现过，
// 只认一种会让历史 task 找不到 host，最终落到一个新建的空项目里。
    aliases.set(addressId, stableId);
    aliases.set(stableId, stableId);
    if (written.has(stableId)) continue;
    written.add(stableId);
    ensureHost(db, addressIdentity, stableId);
    db.prepare(
// [事务] membership_id 每次迁移都重新生成：它是随机的一次性授权标识，
// 复用旧值会让升级前发出的 lease 在校验时继续匹配上，等于跳过重新连接。
      "UPDATE hosts SET kind=?,target_json=?,membership_id=?,last_opened_at=? WHERE host_id=?",
    ).run(
      profile.target.kind,
      JSON.stringify(profile.target),
      randomUUID(),
      profile.lastConnectedAt ?? null,
      stableId,
    );
  }
  return aliases;
}

// [事务] now 只取一次：本批项目的 created_at/updated_at 共用同一时间戳，
// 否则毫秒差会让侧栏排序每次启动都抖动。
export function migrateProjects(db: DatabaseSync, context: ProjectMigrationContext): void {
  const now = (context.now ?? Date.now)();
// addProjectSchema 必须先于任何查询：旧库缺列缺表，先 SELECT 会直接抛错并把迁移断在半途。
  addProjectSchema(db);
  ensureHost(db, "local", context.hostId);
  initializeLegacyTaskIdentity(db, false, context.hostId);
  const settings = context.settings;
  const remoteOwner = (context.hostId ?? "local") !== "local";
// 远端 owner 不迁移本机 connectionProfiles：那属于控制端设置，在 Source Server 上执行
// 会把别人的远程连接写成自己的主机。
  const hostAliases = remoteOwner
    ? new Map<string, string>()
    : migrateConnectionHosts(db, settings);
// [权衡] workspaces 只收本机 owner 的本地工作区；远程条目单独写 remote_project_entries，
// 两边混放会让同一目录建两次项目并抢走 task 归属。
  const workspaces = new Map<string, { path: string; hostId: string }>();
  // Bug 原因：历史任务目录不代表用户仍保留该工作区，扫描 tasks 会复活已移除的项目入口。
  // 首次项目集合与顺序只取旧 settings；其他历史任务保留原目录，按现有规则保持未归类。
  for (const entry of settings?.lastWorkspaceSession ?? []) {
    if (entry.kind === "local" && entry.workspacePurpose !== "conversation")
      workspaces.set(entry.workspacePath, {
        path: entry.workspacePath,
        hostId: context.hostId ?? "local",
      });
    if (entry.kind !== "remote" || (context.hostId ?? "local") !== "local") continue;
// [失败路径] identity 缺失时用 (path, target) 现算：老版本只存 workspacePath，
// 直接读 undefined 会让 hostForWorkspace 抛错并回滚整次迁移。
    const identity =
      entry.workspaceIdentity ?? buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
// [并发] 先经 aliases 把地址键翻成稳定键再 ensureHost：直接传地址键会与连接配置
// 建出的稳定 host 分裂成两条，同一台机器的会话被拆到两个项目。
    const knownHostId = hostAliases.get(hostForWorkspace(identity).hostId);
    const hostId = ensureHost(db, identity, knownHostId);
    db.prepare(
// target_json 用 coalesce 而不是覆盖：连接配置写入的目标比工作区条目的更完整，
// 后者只补空缺，避免迁移把已解析的 target 降级。
      "UPDATE hosts SET target_json=coalesce(target_json,?),last_connection_status=?,last_connection_error=?,last_opened_at=? WHERE host_id=?",
    ).run(
      JSON.stringify(entry.target),
      entry.lastConnectionStatus,
      entry.lastConnectionError ?? null,
      entry.lastOpenedAt,
      hostId,
    );
// [权衡] 缓存名取目录名、roots 只含自身：本机不解析远端目录树，这里只是占位缓存，
// 等远端同步后用真实清单覆盖，因此不写 additional_directories。
    db.prepare(`INSERT INTO remote_project_entries(entry_id,host_id,cached_name,cached_roots_json,legacy_workspace_json)
      VALUES(?,?,?,?,?)`).run(
      randomUUID(),
      hostId,
      rootName(entry.workspacePath),
      JSON.stringify([{ rootPath: entry.workspacePath, position: 0, isPrimary: true }]),
      JSON.stringify(entry),
    );
  }
  // Bug 原因：桌面控制的旧版远程工作区清单只存在控制端 setting.json（kind=remote），
  // 远端 Source Server 自己的 lastWorkspaceSession 为空；只按 settings 建项目会让远端建出 0 个项目，
  // 旧会话全部定为未归类，而远端未归类会话不进侧栏，升级后选原目录只能新建空项目。
  // 远端项目只经本机入口进入桌面侧栏，按历史任务目录建项目不会复活已移除入口；
  // 系统对话目录（含 settings 标为 conversation 的目录）与仅剩已删任务的目录除外。
// [失败路径] tableExists 守卫是给「从未跑过 agent 的旧库」用的：没有 tasks 表时
// 下面的 SELECT 会抛 no such table，但这类库仍需完成 hosts/projects 迁移。
  if (remoteOwner && tableExists(db, "tasks")) {
    const conversations = new Set(
      (settings?.lastWorkspaceSession ?? []).flatMap((entry) =>
        entry.workspacePurpose === "conversation" ? [entry.workspacePath] : [],
      ),
    );
    for (const row of db
      .prepare(
        `SELECT root_path FROM tasks WHERE host_id=? AND project_id IS NULL AND deleted=0
          AND replace(root_path, char(92), '/') NOT GLOB '*/.zcode/workspace/*'
          GROUP BY root_path ORDER BY max(updated_at) DESC, root_path`,
      )
      .all(context.hostId!) as { root_path: string }[]) {
// [权衡] 按 root_path 聚合而非逐 task 建项目：同目录多个会话必须落到同一项目，
// 排序用 max(updated_at) 给出稳定顺序，避免项目顺序随 task 插入顺序漂移。
      if (!workspaces.has(row.root_path) && !conversations.has(row.root_path))
        workspaces.set(row.root_path, { path: row.root_path, hostId: context.hostId! });
    }
  }
  for (const row of db
// [事务] target_json 有值但 membership_id 为空的行是「地址身份」遗留，补发随机
// membership 后，所有远程 host 才满足 Bot runtime 的 lease 校验前提。
    .prepare("SELECT host_id FROM hosts WHERE target_json IS NOT NULL AND membership_id IS NULL")
    .all()) {
    db.prepare("UPDATE hosts SET membership_id=? WHERE host_id=?").run(
      randomUUID(),
      String(row.host_id),
    );
  }
  for (const [key, workspace] of workspaces) {
// [事务] 建项目与回填 tasks.project_id 必须成对：只建不回填，会话同时出现在新项目
// 与未归类；只回填不建项目，project_id 指向不存在的行。
    const projectId = createProject(
      db,
      workspace.hostId,
      rootName(workspace.path),
      [workspace.path],
      false,
      now,
    );
    if (tableExists(db, "tasks"))
// [并发] 按 workspace_key（而非 root_path）匹配 task：远端 key 是身份串，
// 用真实目录匹配会漏掉全部远程会话。
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=?").run(projectId, key);
  }
  // 分组与项目独立；升级只按 workspace 建项目，不能再改写分组成员的项目归属。
  if (tableExists(db, "tasks")) {
    for (const row of db
// [失败路径] 二次补齐只处理 project_id IS NULL：前面已归属的 task 不能重算，
// 否则手工调整过的项目归属会在每次升级时被 root 规则覆盖。
      .prepare("SELECT workspace_key,task_id,host_id,root_path FROM tasks WHERE project_id IS NULL")
      .all() as { workspace_key: string; task_id: string; host_id: string; root_path: string }[]) {
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=? AND task_id=?").run(
        uniqueRootProject(db, row.host_id, row.root_path),
        row.workspace_key,
        row.task_id,
      );
    }
    db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${OWNERSHIP_DECIDED}`);
// [权衡] 先探测重复再决定索引唯一性：历史库可能因旧 bug 存在同 host/task 重复行，
// 直接建 UNIQUE 会让整次迁移失败；降级为非唯一索引并告警，保证升级可继续。
    const duplicate = db
      .prepare(
        "SELECT host_id,task_id,count(*) AS count FROM tasks GROUP BY host_id,task_id HAVING count(*)>1 LIMIT 1",
      )
      .get();
    db.exec(
      `CREATE ${duplicate ? "" : "UNIQUE "}INDEX IF NOT EXISTS idx_tasks_host_task ON tasks(host_id,task_id)`,
    );
    if (duplicate) context.warn?.("历史 task ID 存在冲突，host/task 索引暂用非唯一索引", duplicate);
  }
// 调度定义的 workspace_key 也可能是身份串，仍按 host 的 root 归入已保存项目；
// additional_directories 清空是旧字段，留着会与 project_roots 的根集合不一致。
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    for (const row of db
      .prepare(`SELECT DISTINCT workspace_key,workspace_path FROM ${table}`)
      .all() as {
      workspace_key: string;
      workspace_path: string;
    }[]) {
      const hostId = context.hostId ?? hostForWorkspace(row.workspace_key).hostId;
      // 远端身份 key 与 settings 的真实目录不同；调度定义也按同 Host 的 root 归入已保存项目。
      db.prepare(
        `UPDATE ${table} SET host_id=?,project_id=?,additional_directories='[]' WHERE workspace_key=?`,
      ).run(hostId, uniqueRootProject(db, hostId, row.workspace_path), row.workspace_key);
    }
  }
}
