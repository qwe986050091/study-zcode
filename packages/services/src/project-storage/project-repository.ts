// INV 不变量表（project-repository）：
// INV-01：所有写路径都在 transaction() 内完成，写事务用 BEGIN IMMEDIATE；
//   守住：transaction / saveProject / moveTask / reorderProjects / reserveCreatedTask；
//   破坏后果：并发写入读到相同的 min(position) 或同名项目，去重与排序退化为运行时冲突。
// INV-02：projects.deleted 与 tasks.deleted / cli_deleted 是软删除的唯一事实，
//   列表读取必须同时过滤（readProjects / readTasks）；
//   破坏后果：删除后会话仍出现在列表，或任务无法反查已删项目。
// INV-03：tasks 的键语义必须是（workspace_key, task_id），不是单个 task_id；
//   守住：readTask / moveTask / reserveCreatedTask 的 WHERE 条件；
//   破坏后果：同名任务在不同 workspace 间串行，UPDATE 命中另一条记录。
// INV-04：host_id 一经写入不可更改，跨 Host 一律抛 project.cross-host-move；
//   守住：saveProject / moveTask / initializeProjectRoot / reserveCreatedTask；
//   破坏后果：目录归属与执行 Host 不一致，远端会加载本机路径。
// INV-05：project_roots 的数组顺序即 position，且至多一个 is_primary；
//   守住：saveProject 的先删后插、moveTask 的追加分支；
//   破坏后果：主根不唯一时 cwd 解析随机，任务被挂到错的目录。
// INV-06：execution_directories 以 JSON 存储，读回必经 schema 校验（不超过 256 项）；
//   破坏后果：旧行脏数据把越界目录带进执行环境。
// 本文件是项目与任务归属的唯一写入口，读路径全部经过它落到 SQLite。
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  generateTraceId,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  AutoArchiveInput,
  ProjectDirectories,
  ProjectRepositoryContract,
  ProjectTask,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";
import { ensureHost, OWNERSHIP_DECIDED } from "#src/project-storage/legacy-tasks.js";
import {
  assertRemoteProjectRoots,
  assertRemoteTaskDirectories,
} from "#src/project-storage/remote-policy.js";

// min(1) 与上限 256 挡住两类脏数据：空字符串会让 join 得到根目录，
// 超长数组会让一次执行创建数百个监控句柄。写路径与读回共用同一份 schema，避免两套边界。
const executionDirectoriesSchema = z.array(z.string().min(1)).max(256);

// [事务] 写事务用 BEGIN IMMEDIATE 立即取写锁，而不是等第一次写再升级：
// 本文件的位置计算、同名去重都是先查后写，延迟升级会在两条连接间形成读-读-写死锁
// （SQLITE_BUSY 且无法靠重试解决）。读事务用 BEGIN 包住多次 SELECT，
// 保证 readProjects 的两次查询看到同一快照，并发建档时项目与 roots 不会来自不同版本。
// 回滚只在 isTransaction 为真时执行：body 已提交或连接已断开时再 ROLLBACK 会抛二次错误，
// 否则会覆盖真正的业务异常。
function transaction<T>(db: DatabaseSync, body: () => T, write = true): T {
// 写锁在事务第一行就拿到，body 内部的 SELECT 不会被并发写提交打断；
// 这里不加 busy_timeout，锁冲突交由上层按错误码重试，避免长事务把整个连接挂住。
  // BEGIN IMMEDIATE 立即取写锁，body 内的先查后写不会在事务中途被并发提交插入
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = body();
    // body 正常返回才提交，提交前抛出的任何异常都会落到下面的 ROLLBACK 分支
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // 只有事务仍打开时才回滚，连接已断开再执行 ROLLBACK 会抛错并覆盖真实业务异常
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

// 项目与其 roots 分两条查询再在内存拼装：SQLite 没有 JSON 聚合的稳定顺序，
// 用 JOIN 加 GROUP 会把 roots 顺序交给查询计划，直接破坏 position 语义。
// includeDeleted 默认 true，是为了让 requireProject 能找到软删除行并据此报 project.deleted，
// 列表读取则显式传 false。
function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
// roots 一次性全量取出，再按 project_id 分组过滤，避免每个项目一次查询的 N+1；
// roots 行数由项目数量级决定，全量取回的成本远低于往返次数。
  // roots 先全量取出，下面按 project_id 过滤，避免每个项目一次查询造成 N+1
  const roots = db
    .prepare(
      // ORDER BY position 固定根顺序，否则同 position 的两行会随查询计划漂移
      "SELECT project_id,root_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      // includeDeleted 为真时不过滤 deleted，requireProject 才能读到软删除行并报 project.deleted
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      // 数据库列名是 snake_case，出口统一转成协议里的 camelCase 字段
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      // SQLite 没有布尔类型，只有等于 1 才视为置顶
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      // 时间列在 SQLite 里可能以 INTEGER 或文本存储，Number 统一成毫秒数值
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      // 在内存里拼 roots 才能保住 position 顺序，JOIN 加聚合会把顺序交给查询计划
      roots: roots
        // 按 project_id 过滤是两层循环的唯一条件，漏掉它会让每个项目挂上全量 roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

// 找不到即抛 project.not-found，而不是返回空：调用方都是已校验参数的写路径，
// 静默返回会让 UPDATE 命中 0 行却被当作成功，产生操作成功但数据未变的假象。
function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  // 找不到就抛 project.not-found，静默返回会让调用方把未命中的 UPDATE 当成成功
  if (!project) throw new Error("project.not-found");
  return project;
}

// 复合键（workspace_key, task_id）：task_id 在不同 workspace 间会重复，必须两列一起用。
// 只按 task_id 查会拿到别的 workspace 的行，并把项目归属写到错误的会话上。
// workspace_key 由 resolveWorkspaceKey 统一归一（身份优先、路径兜底），此处不重新拼装。
function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    // WHERE 必须同时带 workspace_key 与 task_id，只按 task_id 会命中另一个 workspace 的行
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

// resolveDirectories 必须同时回答三个问题：cwd 用哪个路径、归属哪个项目、还有哪些附加目录。
// [权衡] 行里已有 root_path 时优先用行内值而不是入参 workspacePath：行是创建时的快照，
// 后续 workspace 迁移不应改写历史会话的 cwd；由此产生的行与项目不一致必须显式拦下。
// host_id 与 ownerHostId 不一致一律抛 host-mismatch：目录属于另一台 Host 时，
// 本机即使能读到行也不能加载其路径（远端挂载可能只是同名目录）。
// execution_directories 为空时回落到项目 roots 减去 cwd：旧行没有该列，
// 这样迁移后的会话仍能拿到与项目一致的附加目录。
function resolveDirectories(
  db: DatabaseSync,
  task: ProjectTaskRef,
  ownerHostId = "local",
): ProjectDirectories {
  // 先取 readTask 返回的任务行，后面的路径与归属以及附加目录都以行内快照为准
  const row = readTask(db, task);
  // 旧远端影子行仍可能保留；行与项目一致不代表当前 Host 有权加载其目录。
  if (row && row.host_id !== ownerHostId) throw new Error("project.host-mismatch");
// 没有行时用调用方传入的路径兜底：reserveCreatedTask 之后的首次读取可能还没写入，
// 但调用方必须能立刻拿到一个确定的 cwd，否则 CLI 无法启动。
  // 行存在时用行内 root_path 并忽略入参 workspacePath，否则历史会话的 cwd 会随目录迁移被改写
  const workspacePath = row ? String(row.root_path) : task.workspacePath;
  // 项目已软删除时 requireProject 仍能取到，随后的 host 与目录校验据此判断能否加载
  const project = row?.project_id ? requireProject(db, String(row.project_id)) : null;
  // 任务行与项目的 host_id 不一致一律拒绝，远端挂载可能只是同名目录
  if (project && row?.host_id !== project.hostId) throw new Error("project.host-mismatch");
  assertRemoteTaskDirectories(
    ownerHostId,
    project,
    workspacePath,
    typeof row?.execution_directories === "string"
      ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
      : [],
  );
  return {
    workspacePath,
    projectId: project?.id ?? null,
    // 旧行没有 execution_directories 时回落到项目 roots 减去 cwd，迁移后的会话仍有附加目录
    additionalDirectories:
      typeof row?.execution_directories === "string"
        ? executionDirectoriesSchema.parse(JSON.parse(row.execution_directories))
        : (project?.roots.map((root) => root.rootPath).filter((path) => path !== workspacePath) ??
          []),
  };
}

// 列表只读 provider 匹配且 CLI 有创建时间的行：迁移后的旧后端行也带 CLI 时间，
// 沿用同一 provider 边界可以避免展示 Controller 无法操作的会话。
// meta_json 先展开再覆盖结构化列：结构化列是唯一事实，meta 只是历史字段的载体，
// 顺序反过来会让旧 meta 里的 projectId 覆盖真实归属。
// workspaceIdentity 必须仅在 identity 与 key 相等、或 key 本身是远端标识时采信，
// 其余返回 undefined，让上层回落到 workspacePath。
function readTasks(db: DatabaseSync): ProjectTask[] {
  // 迁移后的旧后端行也有 CLI 时间；沿用列表的 provider 边界，避免展示 Controller 无法操作的会话。
  return db
    .prepare(
      // provider 与两个删除位一起过滤，缺任一条都会让 Controller 无法操作的会话出现在列表
      "SELECT * FROM tasks WHERE provider=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,task_id",
    )
    .all(ZCODE_AGENT_PROVIDER)
    .map((row) => {
      // meta_json 可能是 NULL 或已被删除，先包成对象再展开避免 JSON.parse 对 undefined 抛错
      const meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : {};
      return {
        ...meta,
        taskId: String(row.task_id),
        // 旧行可能没有 traceId，用 task_id 派生保证同一任务每次读到同一个值
        traceId: meta.traceId ?? generateTraceId(String(row.task_id)),
        workspacePath: String(row.root_path),
        workspaceIdentity:
          // 两列相等才说明身份就是 key 本身，其余情况要再看 key 是不是远端标识
          row.workspace_identity === row.workspace_key
            ? String(row.workspace_identity)
            : isRemoteWorkspaceIdentity(String(row.workspace_key))
              ? String(row.workspace_key)
              : undefined,
        // 用户改名优先于 CLI 标题，CLI 标题为空时回落空串而不是 undefined
        title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? "")),
        titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
        createdAt: Number(row.cli_created_at),
        // 更新时间取 CLI 侧时间，排序与归档都以它为准而不是本机写入时间
        updatedAt: Number(row.cli_updated_at),
        status:
          row.cli_last_outcome === "error"
            ? "error"
            : row.cli_last_outcome
              ? "completed"
              : undefined,
        mode: meta.mode ?? "default",
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        // unread_at 用 == null 同时覆盖 NULL 与 undefined，返回 undefined 才能让协议层省略该字段
        unreadAt: row.unread_at == null ? undefined : Number(row.unread_at),
        projectId: row.project_id == null ? null : String(row.project_id),
        // host_id 决定这条任务归哪台 Host 加载，字符串化后直接进入协议对象
        hostId: String(row.host_id),
      };
    });
}

// ownerHostId 缺省为 local：所有查询与写入都把它当作当前 Host 的身份边界，
// 因此同一份 SQLite 被多个 Host 复用时，每个实例只能看到自己的行。
export class ProjectRepository implements ProjectRepositoryContract {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerHostId?: string,
  ) {}

// 归档判据只看 cli_updated_at：置顶、已删除、CLI 已删除、运行中四类必须排除，
// 运行中由调用方传 activeTasks 给出（Host 内存态），不在 SQL 里判断。
// [事务] 候选筛选与逐条 UPDATE 在同一写事务里：否则筛选后被并发 moveTask 改动的行
// 仍会被归档，表现为刚移动的会话突然消失。
// 返回被归档的 ref 而不是 void：上层要据此广播事件，事务提交后再广播保证监听方读到已落盘状态。
  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[] {
    return transaction(this.db, () => {
      const active = new Set(
        // active 集合的键与候选行保持同一序列化方式，键不一致会让运行中会话被误归档
        input.activeTasks.map((task) => JSON.stringify([resolveWorkspaceKey(task), task.taskId])),
      );
      // 2026-09-15 裁决：纯按 CLI 最后活动时间归档，不再看 last_outcome 与未读；
      // 只有置顶和 syncer 观察到的运行中会话除外。旧判据把 error / 无结果的老会话永远留在列表里。
// 先取候选再在内存剔除 active：把 active 拼成 SQL 的 IN 列表在任务多时会撞参数上限，
// 且 activeTasks 只是内存态，没有必要送进 SQLite。
      // 先在 SQL 里筛时间与置顶等硬条件，再把 activeTasks 放到内存里剔除
      const candidates = this.db
        .prepare(`SELECT workspace_key,workspace_path,workspace_identity,task_id FROM tasks
        WHERE archived=0 AND pinned=0 AND deleted=0 AND coalesce(cli_deleted,0)=0
        AND cli_updated_at < ? AND host_id=?`)
        .all(input.cutoff, this.ownerHostId ?? "local");
      const result: ProjectTaskRef[] = [];
      for (const row of candidates) {
        // 命中 active 就跳过，运行中的会话不能被归档哪怕最后活动时间已过 cutoff
        if (active.has(JSON.stringify([row.workspace_key, row.task_id]))) continue;
        this.db
          // UPDATE 必须带复合键，只按 task_id 会归档另一个 workspace 的同名任务
          .prepare("UPDATE tasks SET archived=1 WHERE workspace_key=? AND task_id=?")
          .run(row.workspace_key!, row.task_id!);
        result.push({
          // 返回 ref 用行内 workspace_path，调用方据此广播事件而不必再查一次库
          workspacePath: String(row.workspace_path),
          taskId: String(row.task_id),
          workspaceIdentity:
            row.workspace_identity === row.workspace_key
              ? String(row.workspace_identity)
              : isRemoteWorkspaceIdentity(String(row.workspace_key))
                ? String(row.workspace_key)
                : undefined,
        });
      }
      // 返回被归档的 ref 让上层在提交后广播事件，监听方读到的是已落盘状态
      return result;
    });
  }

// readTree 是面板的聚合读：项目、可选任务、可选已删任务必须在同一次读事务里取。
// 已在事务中时直接读（isTransaction），避免嵌套 BEGIN 报错；
// 由外层事务持有快照也保证调用方看到的是同一时刻的树。
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree {
// 树内容包在闭包里延迟到事务内构造：includeTasks 为 false 时要完全跳过 readTasks 的全表解析。
    // [顺序] read 闭包在事务内才构造树：includeTasks 为 false 时完全不调用 readTasks，省掉全表解析。
    const read = () => ({
      // 列表读取显式传 includeDeleted=false，软删除项目不应出现在面板树里
      projects: readProjects(this.db, options?.includeDeleted ?? false).filter(
        // 结果按当前 Host 过滤，同一份 SQLite 被多个 Host 复用时各自只看到自己的项目
        (project) => project.hostId === (this.ownerHostId ?? "local"),
      ),
      ...(options?.includeDeletedTasks
        ? {
            deletedTasks: this.db
              // 已删任务用 deleted 与 cli_deleted 两个位共同判定，只看一个会漏掉另一端发起的删除
              .prepare(`
        SELECT task_id AS taskId,workspace_path AS workspacePath,workspace_identity AS workspaceIdentity,host_id AS hostId
        FROM tasks WHERE host_id=? AND (deleted=1 OR coalesce(cli_deleted,0)=1)`)
              .all(this.ownerHostId ?? "local")
              .map((row) => ({
                taskId: String(row.taskId),
                workspacePath: String(row.workspacePath),
                hostId: String(row.hostId),
                // workspace_identity 缺失时不带该键，协议层据此回落到 workspacePath
                ...(typeof row.workspaceIdentity === "string"
                  ? { workspaceIdentity: row.workspaceIdentity }
                  : {}),
              })),
          }
        : {}),
      // includeTasks 为 false 时返回空数组而不是缺字段，前端无需分支判断
      tasks:
        options?.includeTasks === false
          ? []
          : readTasks(this.db).filter((task) => task.hostId === (this.ownerHostId ?? "local")),
    });
    // 已在事务里就直接读，嵌套 BEGIN 会抛错；否则用只读事务拿一致快照
    return this.db.isTransaction ? read() : transaction(this.db, read, false);
  }

// 建档是读旧值、计算、upsert 的复合写，必须全部在同一个 IMMEDIATE 事务内完成。
// 恢复语义（restoreProjectId）要求 roots 与删除前完全一致：否则会用残缺的根集合复活项目，
// 任务指向的目录随之消失。roots 先去重再比较，顺序不影响判定。
// 名称去重按 (host_id, name) 在未删除行里找，冲突时必须从后缀 (2) 递增：这是展示层契约
// （用户要能区分同名项目），不能交给 UNIQUE 索引，因为删除后必须允许同名重建。
// 位置用 coalesce(min(position),1)-1：新项目必须排最前，且不需要额外的重排写。
// [事务] upsert 同时承担复活（deleted=0、deleted_at=NULL），软删除与新建共用一条写入路径，
// 恢复时 roots 会被整体替换。
  saveProject(input: SaveProjectInput): VirtualProject {
    return transaction(this.db, () => {
      // 先读 old 行再计算，后面的名称去重与主根选择以及恢复校验都依赖它
      const old =
        input.id || input.restoreProjectId
          ? requireProject(this.db, input.id ?? input.restoreProjectId!)
          : undefined;
// 已软删除的项目不允许通过 id 直接覆盖：只能走 restoreProjectId 的根集合一致性校验，
// 否则一次普通保存就能把删除的项目连同任意新路径复活。
      // 带 id 直接保存已删除项目必须拒绝，否则一次普通保存就能把它连同任意新路径复活
      if (input.id && old?.deleted) throw new Error("project.deleted");
      const hostId = this.ownerHostId ?? "local";
      // 旧行归属另一台 Host 时禁止改写，host_id 一旦写入就不可变
      if (old && old.hostId !== hostId) throw new Error("project.cross-host-move");
      if (input.hostId && input.hostId !== hostId) throw new Error("project.host-immutable");
// 未显式传 roots 时沿用旧集合；Set 去重防止同一路径写两次（project_roots 没有唯一约束，
// 重复项会让主根判定与 cwd 是否在 roots 内的检查出现歧义）。
      // Set 去重是必须的，project_roots 没有唯一约束而重复路径会让主根判定出现歧义
      const roots = [...new Set(input.roots ?? old?.roots.map((root) => root.rootPath) ?? [])];
      // 远端根目录策略在写库前校验，越界路径必须在这里拦下而不是落盘后才发现
      assertRemoteProjectRoots(this.ownerHostId, roots, old);
      if (
        input.restoreProjectId &&
        (!old?.deleted ||
          roots.length !== old.roots.length ||
          roots.some((root) => !old.roots.some((entry) => entry.rootPath === root)))
      )
        // 恢复时根集合必须与删除前完全一致，否则任务指向的目录会随残缺 roots 消失
        throw new Error("project.restore-roots-mismatch");
// 主根优先级：显式入参、旧主根（且仍在 roots 内）、第一个根。
// 特意保留旧主根但要求它仍在集合内，否则会写入一行指向已移除路径的 is_primary=1。
      // 主根按显式入参与旧主根以及第一个根的顺序择一，保证结果确定
      const primary =
        input.primaryRoot ??
        old?.roots.find((root) => root.isPrimary && roots.includes(root.rootPath))?.rootPath ??
        roots[0];
      // 主根不在 roots 内必须拒绝，否则会写入一行指向已移除路径的 is_primary=1
      if (primary !== undefined && !roots.includes(primary))
        throw new Error("project.invalid-primary-root");
// 复用旧 id 而不是重新生成：任务通过 project_id 引用项目，换 id 等于把所有任务变成孤儿。
      const id = old?.id ?? randomUUID();
      const overridden =
        input.name !== undefined ? input.name.trim().length > 0 : (old?.nameOverridden ?? false);
      const baseName =
        input.name?.trim() ||
        (overridden ? old?.name : undefined) ||
        (roots[0] ? basename(roots[0]) : input.defaultName?.trim() || old?.name || "New project");
// 后缀循环在事务持有的写锁下运行，读到的冲突集合不会被并发插入改变；
// 若移到事务外，两个并发建档会算出相同后缀并同时通过检查。
      // 名称去重循环在写锁内执行，事务外并发建档会算出相同后缀并同时通过检查
      let name = baseName;
      for (
        let suffix = 2;
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0 AND project_id<>?",
          )
          .get(hostId, name, id);
        suffix++
      )
        name = `${baseName} (${suffix})`;
// 时间戳在事务内取一次并复用给 created_at/updated_at/pinned_at：多次取会使同一行的
// 两个时间列相差毫秒，排序与增量同步的边界判断会因此抖动。
      // 时间戳只取一次，created_at 与 updated_at 相差毫秒会让排序与增量同步的边界抖动
      const now = Date.now();
      // 原先用 max(position)+1 导致新建项目落在末尾；同一 Host 写事务内取最小值减一，保留已有顺序。
      this.db
        // ON CONFLICT 同时承担复活，deleted 与 deleted_at 在这里被清空
        .prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,pinned,pinned_at,created_at,updated_at)
        VALUES(?,?,?,?,(SELECT coalesce(min(position),1)-1 FROM projects WHERE host_id=?),?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,name_overridden=excluded.name_overridden,
        pinned=excluded.pinned,pinned_at=excluded.pinned_at,deleted=0,deleted_at=NULL,updated_at=excluded.updated_at`)
        .run(
          id,
          hostId,
          name,
          overridden ? 1 : 0,
          hostId,
          // 未显式传 pinned 时沿用旧值，避免保存名称时意外取消置顶
          (input.pinned ?? old?.pinned) ? 1 : 0,
          (input.pinned ?? old?.pinned) ? now : null,
          now,
          now,
        );
// roots 走整表替换而不是 diff：根集合很小，替换能保证 position 与 is_primary 与入参一致，
// 增量更新会留下孤立行。引用方是任务而不是 roots，因此替换不会破坏外键关系。
      // roots 整表替换而不是增量 diff，替换后 position 与 is_primary 必然与入参一致
      this.db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
      roots.forEach((root, position) =>
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          // 只有选中的主根置 1 而其余置 0，多行为 1 会让 cwd 解析随机
          .run(id, root, position, root === primary ? 1 : 0),
      );
      return requireProject(this.db, id);
    });
  }

// 只为还没有任何根的项目补一个主根：已有根时不做写入，重复调用因此幂等，
// 也不会覆盖用户后来选定的主根。补根后更新 updated_at，列表按更新时间排序时依赖它。
  initializeProjectRoot(id: string, path: string): VirtualProject {
    return transaction(this.db, () => {
      // 先取项目再校验，后面的 host 与删除状态判断都以这次读到的行为准
      const project = requireProject(this.db, id);
      if (project.hostId !== (this.ownerHostId ?? "local"))
        throw new Error("project.cross-host-move");
      // 软删除项目不能再补根，否则会得到一个已删除却没有根的半成品
      if (project.deleted) throw new Error("project.deleted");
      assertRemoteProjectRoots(this.ownerHostId, [path], project);
      // 已有根就完全跳过写入，重复调用因此幂等且不会覆盖用户选定的主根
      if (!project.roots.length) {
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
          )
          .run(id, path);
        // 补根后刷新 updated_at，列表按更新时间排序时依赖这个值
        this.db.prepare("UPDATE projects SET updated_at=? WHERE project_id=?").run(Date.now(), id);
      }
      return requireProject(this.db, id);
    });
  }

// 软删除：置 deleted=1 并记录 deleted_at，不动物理行，任务行必须保留 project_id 引用。
// 物理删除会留下悬空引用。WHERE 带 deleted=0 让重复删除成为空操作，
// host_id 条件防止跨 Host 误删。
  deleteProject(id: string): void {
    this.db
      .prepare(
        // WHERE 带 deleted=0 让重复删除成为空操作，host_id 条件防止跨 Host 误删
        "UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=? AND deleted=0 AND host_id=?",
      )
      // 两次 Date.now() 分别填 deleted_at 与 updated_at，软删除不动物理行以免任务引用悬空
      .run(Date.now(), Date.now(), id, this.ownerHostId ?? "local");
  }

// 把任务挂到项目上必须通过三重校验：项目未删、两端 Host 相同、cwd 在项目 roots 内。
// 第三条不可省：cwd 不在根集合里意味着项目视图无法解释该会话的目录；
// 未带 addMissingRoot 时直接拒绝，要求 UI 显式确认把新目录加入项目。
// handoff_pending 用位或写入 OWNERSHIP_DECIDED：不能整体覆盖，否则会清掉其他流程
// 已登记的交接位，让尚未完成的 ownership 判定被误认为已完成。
  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void {
    transaction(this.db, () => {
      // 先确认目标项目可写，requireProject 找不到会抛 project.not-found
      const project = requireProject(this.db, input.projectId);
      if (project.deleted) throw new Error("project.deleted");
// 任务必须已存在：moveTask 只处理已创建的会话，缺行说明调用方 key 拼错，
// 静默继续会让下面的 UPDATE 命中 0 行却返回成功。
      // 任务必须已存在，缺行说明调用方 key 拼错而继续执行只会 UPDATE 命中 0 行
      const task = readTask(this.db, input.task);
      if (!task) throw new Error("project.task-not-found");
      // 两端 Host 必须与当前实例一致，否则远端会加载本机路径
      if (project.hostId !== (this.ownerHostId ?? "local") || task.host_id !== project.hostId)
        throw new Error("project.cross-host-move");
      assertRemoteTaskDirectories(this.ownerHostId, project, String(task.root_path));
      // cwd 不在项目 roots 内时要求 UI 显式确认，静默追加会让项目视图解释不了该目录
      if (!project.roots.some((root) => root.rootPath === task.root_path)) {
        if (!input.addMissingRoot) throw new Error("project.root-confirmation-required");
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(
            project.id,
            String(task.root_path),
            project.roots.length,
            // 项目原本没有根时新追加的这条同时成为主根，否则保持 0
            project.roots.length === 0 ? 1 : 0,
          );
      }
      this.db
        .prepare(
          // handoff_pending 用位或写入 OWNERSHIP_DECIDED，整体覆盖会清掉其他流程登记的交接位
          "UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=?",
        )
        .run(project.id, OWNERSHIP_DECIDED, resolveWorkspaceKey(input.task), input.task.taskId);
    });
  }

// 先查重再逐条校验 Host：重复 id 会让两行拿到相同 position，排序退化为不稳定；
// 校验全部在写之前，任何一条越界都会让事务整体回滚，不留下部分重排。
// position 直接取数组下标：前端提交的就是完整顺序，服务端不做只移动一项的增量合并。
  reorderProjects(ids: string[]): void {
    transaction(this.db, () => {
      // 重复 id 会让两行拿到相同 position 并让排序退化为不稳定；必须写库前拦下
      if (new Set(ids).size !== ids.length) throw new Error("project.duplicate-order");
      ids.forEach((id, position) => {
        if (requireProject(this.db, id).hostId !== (this.ownerHostId ?? "local"))
          throw new Error("project.cross-host-move");
        // position 直接取数组下标，前端提交的是完整顺序而服务端不做增量合并
        this.db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(position, id);
      });
    });
  }

// 读路径也用事务（write=false）包住：resolveDirectories 内部有多次查询，
// 只有读事务能保证任务行与项目行来自同一快照。
  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories {
    return transaction(this.db, () => resolveDirectories(this.db, task, this.ownerHostId), false);
  }

// 创建前占位：CLI 首发之前就要写好归属，否则首个事件到达时列表还没有这一行，
// 会话会以无项目的孤儿出现一瞬。
// 已有行时只回读目录、不重新插入：重复占位（重试、并发）必须幂等，
// 否则 INSERT 撞主键会让首条消息直接失败。
// [事务] ensureHost 与 INSERT 同事务：Host 推断失败时不能留下半条任务行。
// 未显式给附加目录时才校验 cwd 在 roots 内并要求项目未删；显式给出目录说明调用方
// 已确认目标位置，放宽是为了让先建会话后归位可用。
  reserveCreatedTask(input: {
    task: ProjectTaskRef;
    projectId: string | null;
    additionalDirectories?: string[];
  }): ProjectDirectories {
    return transaction(this.db, () => {
// 事务内第一件事就归一 workspace_key：后续 ensureHost、readTask、INSERT 必须用同一个 key，
// 否则远端身份与本地路径会写成两行。
      // 事务内第一件事就归一 workspace_key，后续 ensureHost 与 readTask 以及 INSERT 必须共用它
      const key = resolveWorkspaceKey(input.task);
      // ensureHost 会为远端 key 推断宿主，推断结果决定这次写入是否属于当前实例
      const host = ensureHost(this.db, key, this.ownerHostId);
// ensureHost 会为远端 key 推断宿主；推断结果与当前实例不一致说明该 workspace 属于别的 Host，
// 继续写入会让两边都认为自己拥有这条任务。
      // 推断出的宿主与当前实例不一致时拒绝写入，否则两边都会认为自己拥有这条任务
      if (host !== (this.ownerHostId ?? "local")) throw new Error("project.cross-host-move");
      // 已有行时只回读不重插，重复占位必须幂等否则 INSERT 撞主键会让首条消息失败
      if (!readTask(this.db, input.task)) {
        assertRemoteTaskDirectories(
          this.ownerHostId,
          input.projectId ? requireProject(this.db, input.projectId) : null,
          input.task.workspacePath,
          input.additionalDirectories,
        );
        if (input.projectId) {
          const project = requireProject(this.db, input.projectId);
          // 未显式给目录时才要求项目未删，显式目录说明调用方已确认目标位置
          if (project.deleted && input.additionalDirectories === undefined)
            throw new Error("project.deleted");
          if (project.hostId !== host) throw new Error("project.cross-host-move");
          if (
            input.additionalDirectories === undefined &&
            !project.roots.some((root) => root.rootPath === input.task.workspacePath)
          )
            // cwd 不在项目 roots 内时拒绝占位，否则会话的目录无法由项目解释
            throw new Error("project.cwd-not-in-roots");
        }
        // 创建归属必须先于 CLI 首发；空事实不是假会话，列表只读取已有 CLI 事实的行。
// [失败路径] INSERT 把 created_at/updated_at 写 0，也不带 CLI 标题：readTasks 以
// cli_created_at IS NOT NULL 过滤，因此占位行不会出现在列表里，直到 CLI 首次上报才出现，
// 避免空项目下冒出一堆无内容的会话。
        this.db
          // created_at 与 updated_at 写 0，readTasks 以 cli_created_at 过滤因此占位行不会出现在列表
          .prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
          VALUES(?,?,?,?,0,0,?,?,?,?,?)`)
          .run(
            key,
            input.task.workspacePath,
            input.task.workspaceIdentity ?? null,
            input.task.taskId,
            host,
            input.task.workspacePath,
            input.projectId,
            OWNERSHIP_DECIDED,
            // 未给附加目录就写 NULL，让读取时回落到项目 roots 减去 cwd 的旧行逻辑
            input.additionalDirectories === undefined
              ? null
              : JSON.stringify(executionDirectoriesSchema.parse(input.additionalDirectories)),
          );
      }
// 回读用行内事实而不是入参：占位可能由并发请求先完成，行里的 root_path 与
// execution_directories 才是最终生效值，直接回传入参会让两个并发调用看到不同结果。
      return resolveDirectories(this.db, input.task, this.ownerHostId);
    });
  }
}
