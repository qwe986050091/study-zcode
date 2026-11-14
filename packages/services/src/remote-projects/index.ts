// 远端项目索引的持久化边界：hosts 是连接身份，remote_project_entries 是可打开入口缓存。
// 本文件同时负责 URL/别名归一、去重合并与容量上限，任何一处放宽都会让 UI 出现重复或幽灵项目。
//
// INV-01：每个物理 Source 在 hosts 里最多一行；alias 与解析后的 server id 必须合并（守住：bindHost 的 distinctSource 分支）。
//   破坏后果：同一设备出现两个入口，连接池与 lease 各自建链，注销只清掉其中一个。
// INV-02：membership_id 跨重启稳定；同 host 覆盖保存不得换 membership（守住：saveHost 的 existing?.membership_id 分支）。
//   破坏后果：在途向导持有的 expectedMembershipId 全部失配，登记入口被误判为 host-removed。
// INV-03：hosts 非 local 且已配置 target 的行数不超过 20（守住：assertHostCapacity，仅在新增路径调用）。
//   破坏后果：越过上限后 UI 分页/重连风暴，且没有回收路径。
// INV-04：刷新入口用 (entry_id,last_synced_at) 做 CAS；版本只由 nextVersion 单调推进（守住：refreshEntry）。
//   破坏后果：迟到的旧响应覆盖新缓存，项目名与根路径回退。
// INV-05：写操作全部在 BEGIN IMMEDIATE 内完成，先写后读同一事务，避免读到半合并状态（守住：write）。
//   破坏后果：合并中途崩溃会留下 alias 已删、目标未插入的孤儿入口。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  type RemoteTargetSnapshot,
  parseRemoteWorkspaceIdentity,
  buildRemoteHostWorkspaceIdentity,
} from "@zcode/shared";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project-storage/contract.js";
import type {
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  RemoteProjectHost,
} from "#src/remote-projects/contract.js";
export { IRemoteProjectService } from "#src/remote-projects/contract.js";
export { projectWorkspaceSettings } from "#src/remote-projects/workspace-settings.js";
export {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/connection-membership.js";

import { text, targetSchema, rootSchema, cacheSchema } from "#src/remote-projects/validation.js";

// [事务] 统一写入口：IMMEDIATE 先取写锁，避免两个窗口并发保存 host 时升级锁死。
// body 内允许 await 之外的同步 SQL；调用方不得在 body 里发起网络请求，否则长事务阻塞其他窗口的读。
function write<T>(db: DatabaseSync, body: () => T): T {
// [事务] 从这里到 COMMIT 之间是唯一可见的原子区间：容量检查与 INSERT 必须同事务，
// 否则两个并发 saveHost 都能通过上限检查，写出第 21 条 host。
  db.exec("BEGIN IMMEDIATE");
  try {
// [失败路径] body 抛出时由 catch 分支只回滚本函数开启的事务：isTransaction 判断防止把
// 外层调用方的事务一起回滚，那样会静默丢弃外层尚未提交的变更。
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
// [权衡] 上限只统计 target_json 非空的行：local 与迁移残留行不占用户可见配额。
// 只应在确认是新增时调用；覆盖保存若也走这里，重连已满配额的机器会被误拒。
function assertHostCapacity(db: DatabaseSync): void {
  if (
    Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM hosts WHERE host_id<>'local' AND target_json IS NOT NULL",
        )
        .get()?.n,
    ) >= 20
  )
// [失败路径] 抛错而非静默丢弃：调用方需要把错误码回传给设置页，让用户先删旧连接。
    throw new Error("remote-project.host-limit");
}
// 行到入口模型的唯一映射点：cached_roots_json 是外部 JSON，必须过 zod 校验后再交给 UI。
// 若直接把 JSON.parse 结果透传，损坏的缓存会让渲染层在 map 里抛异常，整个项目列表空白。
function entry(row: Record<string, unknown>): RemoteProjectEntry {
  return {
    id: String(row.entry_id),
    hostId: String(row.host_id),
    projectId: row.remote_project_id == null ? null : String(row.remote_project_id),
    name: String(row.cached_name),
// [失败路径] 这里不做 try/catch：缓存损坏属于持久化事实被破坏，应显式失败并暴露给上层诊断。
    roots: z.array(rootSchema).parse(JSON.parse(String(row.cached_roots_json))),
    legacyWorkspace:
      row.legacy_workspace_json == null ? null : JSON.parse(String(row.legacy_workspace_json)),
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
    ...(row.initial_position == null ? {} : { initialPosition: Number(row.initial_position) }),
  };
}
/** 不含连接运行态的本机目录；调用方负责 SQLite 读事务。 */
// 只读快照；调用方负责事务，本函数不加锁也不做连接状态合并，保证可在写事务内部复用。
export function readRemoteProjectDirectory(db: DatabaseSync): RemoteProjectDirectory {
  return {
    hosts: db
      .prepare(
// position 是用户拖动顺序的唯一来源；host_id 作为次级键保证 position 相同或为空时排序仍是确定的。
        "SELECT * FROM hosts WHERE host_id<>'local' AND target_json IS NOT NULL ORDER BY position,host_id",
      )
      .all()
      .map((row) => ({
        id: String(row.host_id),
        membershipId: text.parse(row.membership_id),
        kind: row.kind as RemoteTargetSnapshot["kind"],
        target:
          row.target_json == null
            ? null
            : (targetSchema.parse(JSON.parse(String(row.target_json))) as RemoteTargetSnapshot),
        position: Number(row.position),
        ...(row.last_connection_status == null
          ? {}
          : { lastConnectionStatus: String(row.last_connection_status) }),
        ...(row.last_connection_error == null
          ? {}
          : { lastConnectionError: String(row.last_connection_error) }),
        ...(row.last_opened_at == null ? {} : { lastOpenedAt: Number(row.last_opened_at) }),
      })),
// 入口按 rowid 返回而不是按名称：插入顺序即最近使用顺序，UI 侧不允许再二次排序。
    entries: db.prepare("SELECT * FROM remote_project_entries ORDER BY rowid").all().map(entry),
  };
}

/** 复用已完成启动迁移的 SQLite 连接，不创建网络/会话运行实例。 */
export function createRemoteProjectService(options: {
  database(): Promise<DatabaseSync>;
  controller?: boolean;
  connectHost?(host: RemoteProjectHost): Promise<string>;
  readConnectionStates?(): Promise<
    ReadonlyMap<
      string,
      Pick<
        RemoteProjectHost,
        "connectionStatus" | "lastConnectionError" | "lastConnectionStatus" | "upgradeTarget"
      >
    >
  >;
  afterChange?(): Promise<void> | void;
  now?: () => number;
}): IRemoteProjectService {
// 注入时钟而非直接读 Date.now：测试需要构造「同一毫秒内两次写」来验证版本单调与 CAS 边界。
  const now = options.now ?? Date.now;
// [权衡] 版本取 max(now, previous+1)：时钟回拨时仍保证严格单调，CAS 不会因同一毫秒而糊掉。
// 若直接写 now()，同毫秒内的两次刷新会互相覆盖，旧响应可能盖掉新根路径。
  const nextVersion = (previous: unknown) => Math.max(now(), Number(previous ?? 0) + 1);
// 写操作只允许 controller 执行：渲染窗口拿到的是同一份 SQLite，若不设界会出现双写同一 host 的竞态。
  const requireController = () => {
    if (options.controller === false) throw new Error("remote-project.controller-only");
  };
// local 不是远端 Source：任何写入都必须拒绝，否则会与本机项目表产生两套事实源。
  const requireRemote = (id: string) => {
    requireController();
    text.parse(id);
    if (id === "local") throw new Error("remote-project.local-host");
  };
// 变更通知统一出口：只在事务提交后调用，避免订阅者读到未提交状态并触发二次刷新。
  const changed = async () => {
    await options.afterChange?.();
  };
// service 是闭包实现：所有方法共享同一个 database() 惰性连接与 now，因此版本推进在同一进程内可比。
// 不要把 database() 提到外部缓存连接，热更新后旧连接会继续服务已迁移的表。
  const service: IRemoteProjectService = {
// 非 controller 返回空目录而不是抛错：渲染进程只做展示，无权也不应知道主进程连接表。
    async readDirectory() {
// [权衡] 返回空目录而不是抛错：非 controller 的窗口只做展示，空态比错误态更接近真实（它确实不持有连接表）。
      if (options.controller === false) return { hosts: [], entries: [] };
      const db = await options.database();
// [事务] 读目录用普通 BEGIN（延迟写锁）：这条路径只读，不抢占写锁，避免与 refreshEntry 的写事务互斥排队。
      db.exec("BEGIN");
      try {
        const result = readRemoteProjectDirectory(db);
        db.exec("COMMIT");
// [并发] 连接状态在事务提交后读取：运行态来自连接管理器，不能与持久化快照混在同一读事务里，
// 否则提交前的旧状态会被当作本快照的一部分返回。
        const states = await options.readConnectionStates?.();
        return states
          ? {
              ...result,
              hosts: result.hosts.map((host) => ({
                ...host,
                connectionStatus: states.get(host.id)?.connectionStatus ?? "offline",
                // 连接管理器是当前错误的唯一来源；恢复后不能显示旧持久错误。
                lastConnectionError: states.get(host.id)?.lastConnectionError,
                lastConnectionStatus: states.get(host.id)?.lastConnectionStatus,
                upgradeTarget: states.get(host.id)?.upgradeTarget,
              })),
            }
          : result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
// 连接后重新读目录校验身份：连接器可能把 URL 别名解析成新 server id，旧 id 已不存在时必须报 host-removed，
// 不能把解析结果当作同一个 host 继续用，否则后续保存会写到错误的 membership。
    async connectHost(id) {
      requireRemote(id);
      const host = (await service.readDirectory()).hosts.find((item) => item.id === id);
// 先按 id 找 host 再握手：直接连一个不存在的 id 会把连接器日志污染成真实故障，问题定位成本更高。
      if (!host) throw new Error("remote-project.host-not-found");
// [失败路径] 连接器缺失是装配错误而非用户错误：显式抛出而未静默返回 host，避免 UI 显示已连接。
      if (!options.connectHost) throw new Error("remote-project.connector-unavailable");
      const resolvedId = await options.connectHost(host);
// 二次读取用 resolvedId 而不是原 id：连接成功本身可能触发了 bindHost 的别名合并，旧行已经不存在。
      const connected = (await service.readDirectory()).hosts.find(
        (item) => item.id === resolvedId,
      );
// [失败路径] 同 id 但 membership 变了意味着设备被移除后重登：明确失败，交由上层重新走绑定向导。
      if (!connected || (connected.id === host.id && connected.membershipId !== host.membershipId))
        throw new Error("remote-project.host-removed");
      return connected;
    },
// 幂等覆盖保存：存在则更新 target，不改变 position 与 membership，保证用户排序不因重连被打乱。
    async saveHost(input) {
      requireRemote(input.id);
// 落盘前先校验 target：库内 JSON 会被跨进程/跨版本读取，写坏一次会让所有读取方的 parse 失败。
      const target = targetSchema.parse(input.target);
      const db = await options.database();
      const result = write(db, () => {
// 先查现有行决定是否走配额检查：这条查询本身在写事务内，看到的一定是其它写者提交后的最新状态。
        const existing = db
          .prepare("SELECT membership_id FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
          .get(input.id);
// [权衡] 只有新增才校验配额：覆盖现有 host 不应因为配额已满而失败，否则用户无法修复已满列表里的连接。
// 注意 target_json 为空的迁移行在 existing 查询里不可见，会被当作新增并占用配额。
        if (!existing) assertHostCapacity(db);
        db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position) VALUES(?,?,?,?,(SELECT coalesce(max(position),-1)+1 FROM hosts))
          ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
          input.id,
          target.kind,
          JSON.stringify(target),
// INV-02 的落点：覆盖保存沿用旧 membership，新建才生成。若这里无条件 randomUUID()，
// 所有在途向导的 expectedMembershipId 会失效，入口登记被拒。
          existing?.membership_id ?? randomUUID(),
        );
        return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.id)!;
      });
      await changed();
      return result;
    },
// bindHost 承担别名归一与去重：先证明调用方看到的 Source 身份没变，再决定是原位改名还是新建 host。
// 三种去向：urlAlias 原位固化 serverId；distinctSource 新建独立设备；其余按 alias 合并到 resolvedId。
// [事务] 合并步骤必须先搬入口再删旧 host，顺序反过来会触发外键/孤儿入口。
    async bindHost(input) {
      requireRemote(input.id);
      text.parse(input.membershipId);
      if (!input.resolvedId.startsWith("remote:server:"))
        throw new Error("remote-project.invalid-source");
      const db = await options.database();
      const result = write(db, () => {
        const source = db
          .prepare(
            "SELECT * FROM hosts WHERE host_id=? AND membership_id=? AND target_json IS NOT NULL",
          )
          .get(input.id, input.membershipId);
// [失败路径] 找不到 (id,membership) 组合说明来源已被删除或换过身份：返回 null 而非抛错，调用方据此走重连。
        if (!source) return null;
// 重新校验库内 target：它是跨版本写下的 JSON，形状可能落后于当前 schema。
        const sourceTarget = targetSchema.parse(JSON.parse(String(source.target_json)));
        // URL 在首次握手前也使用 server 前缀，只有固化 serverId 后才是稳定 Source。
// [权衡] 未固化 serverId 的 server 目标视为别名：它可能就是本机，不能据此判定换了设备，
// 否则首次握手完成前每次绑定都会被要求 createDistinctHost。
        const urlAlias = sourceTarget.kind === "server" && !sourceTarget.serverId;
        const distinctSource =
// 只有双方都是已固化的 server 前缀且 id 不同才算换了设备；urlAlias 为真时说明尚未固化，不能据此判定。
// [权衡] 这里刻意不复用 parseRemoteWorkspaceIdentity：判定条件是前缀与别名状态，解析失败不应中断绑定。
          input.id.startsWith("remote:server:") && input.id !== input.resolvedId && !urlAlias;
// [失败路径] 身份已变且调用方未确认时拒绝：不能让重装后的设备静默接管旧入口的项目缓存。
        if (distinctSource && !input.createDistinctHost)
          throw new Error("remote-project.source-identity-changed");
        const targetJson =
          sourceTarget.kind === "server"
            ? JSON.stringify({
                ...sourceTarget,
                serverId: parseRemoteWorkspaceIdentity(
                  buildRemoteHostWorkspaceIdentity(input.resolvedId, "/"),
                )?.sourceServerId,
              })
            : source.target_json;
// 独立设备分支与别名合并分支互斥：这里新增 host，下面才是搬移入口，两者绝不能同时执行。
        if (distinctSource) {
          const retained = readRemoteProjectDirectory(db).hosts.find(
            (host) => host.id === input.resolvedId,
          );
// [并发] 目标 id 已存在则直接复用：两个窗口同时完成握手时，后到者不应重复建行或重置位置。
          if (retained) return retained;
          assertHostCapacity(db);
          // 重装后的 Source 属于新设备身份，确认只新增连接，不搬旧入口。
          db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position)
            VALUES(?,?,?,?,(SELECT coalesce(max(position),-1)+1 FROM hosts))
            ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
            input.resolvedId,
            source.kind!,
            targetJson!,
// 新设备身份必须新 membership：旧 membership 代表已下线的安装，复用它会让后续 expectedMembershipId 校验通过。
            randomUUID(),
          );
          return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.resolvedId)!;
        }
// 别名合并分支：把 id 上的入口与状态整体迁到 authoritative 的 resolvedId，然后删除别名行。
// [事务] 全部分支都在同一写事务内，任何一步失败都不会留下「两边都有入口」的中间态。
        if (input.id !== input.resolvedId) {
          if (
            db
// [失败路径] 任一 host 已有权威项目就拒绝合并：项目表的外键语义比入口缓存更硬，先让用户显式解绑。
              .prepare("SELECT 1 FROM projects WHERE host_id IN (?,?) LIMIT 1")
              .get(input.id, input.resolvedId)
          )
            throw new Error("remote-project.authoritative-host");
          const retained = db
            .prepare("SELECT 1 FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
            .get(input.resolvedId);
// 复制 host 行而不是插入空壳：last_connection_status 等运行态由旧行继承，避免别名期间短暂显示 offline。
          if (!retained)
            db.prepare(`INSERT INTO hosts(host_id,kind,target_json,membership_id,position,last_connection_status,last_connection_error,last_opened_at)
            SELECT ?,kind,target_json,membership_id,position,last_connection_status,last_connection_error,last_opened_at FROM hosts WHERE host_id=?
            ON CONFLICT(host_id) DO UPDATE SET kind=excluded.kind,target_json=excluded.target_json,membership_id=excluded.membership_id`).run(
              input.resolvedId,
              input.id,
            );
          // 同一物理 Source 的重复入口保留目标 entry ID，旧响应随旧 ID 一起失效。
// [权衡] 先删重复的已解析入口再搬移：同一个 remote_project_id 在新旧 host 下都存在时，
// 保留 resolvedId 上的那条，否则入口表会出现同项目两条缓存，UI 显示两遍。
// 未解析（remote_project_id 为空）的旧入口保留，它们携带的是待刷新的事实。
          db.prepare(`DELETE FROM remote_project_entries WHERE host_id=? AND remote_project_id IS NOT NULL
            AND remote_project_id IN (SELECT remote_project_id FROM remote_project_entries WHERE host_id=?)`).run(
            input.id,
            input.resolvedId,
          );
// [事务] 搬移必须先于删除旧 host：反序会让入口短暂指向不存在的 host，读目录时整行消失。
          db.prepare("UPDATE remote_project_entries SET host_id=? WHERE host_id=?").run(
            input.resolvedId,
            input.id,
          );
// 别名行到这里使命结束；此后任何仍在用旧 id 的调用方都应得到 host-not-found 而不是复用新行。
          db.prepare("DELETE FROM hosts WHERE host_id=?").run(input.id);
        }
// 只有 server 目标需要固化 serverId：其它 kind 没有可解析的 workspace identity，改写会被后端当成新设备。
        if (sourceTarget.kind === "server")
          db.prepare("UPDATE hosts SET target_json=? WHERE host_id=? AND membership_id=?").run(
            targetJson!,
            input.resolvedId,
            source.membership_id!,
          );
        return readRemoteProjectDirectory(db).hosts.find((host) => host.id === input.resolvedId)!;
      });
// 仅在真正发生合并时广播：bindHost 被重复调用（幂等返回同一行）不应再触发一次全量刷新。
      if (result && input.id !== input.resolvedId) await changed();
      return result;
    },
// 删除顺序由外到内：先清入口再删 host，且必须在同一事务里，否则中途失败会留下无主入口。
    async removeHost(id) {
      requireRemote(id);
      const db = await options.database();
      const affected = write(db, () => {
        // 本机移除连接不能把权威项目级联删除；迁移后的本机表不应含远端权威项目。
// [权衡] 用存在性检查而不是外键级联：项目表由项目服务拥有，级联删除会把远端设备卸载变成批量删项目。
        if (db.prepare("SELECT 1 FROM projects WHERE host_id=? LIMIT 1").get(id))
          throw new Error("remote-project.authoritative-host");
// 入口先删、host 后删：反序会让入口成为孤儿行，读目录时按 host_id 关联不到却仍占行号。
        db.prepare("DELETE FROM remote_project_entries WHERE host_id=?").run(id);
        return db.prepare("DELETE FROM hosts WHERE host_id=?").run(id).changes;
      });
      if (affected) await changed();
    },
// 入口登记按 (host_id,remote_project_id) 去重：重复「添加项目」应更新缓存而不是新增一行。
    async addEntry(input) {
      requireRemote(input.hostId);
      const project = cacheSchema.parse(input.project);
      const db = await options.database();
      const result = write(db, () => {
        if (
          !db
            .prepare("SELECT 1 FROM hosts WHERE host_id=? AND target_json IS NOT NULL")
            .get(input.hostId)
        )
          throw new Error("remote-project.host-not-found");
        // 连接期间删除并重新添加同一设备后，旧向导不得给新 membership 登记入口。
        if (
// [并发] 用向导捕获的 membership 版本做前置条件：同一 host 在连接期间被删后重加会换 membership，
// 此时登记必须失败，否则会把旧向导选中的项目写进新设备。
          input.expectedMembershipId &&
          db.prepare("SELECT membership_id FROM hosts WHERE host_id=?").get(input.hostId)
            ?.membership_id !== input.expectedMembershipId
        )
          throw new Error("remote-project.host-removed");
        const old = db
          .prepare("SELECT * FROM remote_project_entries WHERE host_id=? AND remote_project_id=?")
          .get(input.hostId, project.projectId);
// [权衡] 命中同项目时复用旧 entry_id：打开状态的会话与订阅都以 entry_id 为键，换 id 会让它们全部失效。
// 只更新名称/根/同步时间，不触碰 initial_position，保持用户已有排序位置。
        const id = old ? String(old.entry_id) : randomUUID();
        db.prepare(`INSERT INTO remote_project_entries(entry_id,host_id,remote_project_id,cached_name,cached_roots_json,last_synced_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(entry_id) DO UPDATE SET cached_name=excluded.cached_name,cached_roots_json=excluded.cached_roots_json,last_synced_at=excluded.last_synced_at`).run(
          id,
          input.hostId,
          project.projectId,
          project.name,
          JSON.stringify(project.roots),
// 以旧版本推进：即使时钟不变，重复登记也会得到更大的版本号，避免与在途刷新撞成同一版本。
          nextVersion(old?.last_synced_at),
        );
        return entry(db.prepare("SELECT * FROM remote_project_entries WHERE entry_id=?").get(id)!);
      });
      await changed();
      return result;
    },
// 刷新是并发最高频的写路径：CAS 失败必须返回 applied=false 而不是抛错，让调用方静默丢弃过期响应。
// expectedLastSyncedAt 允许为 null，表示「从未同步」，用于首次解析 legacy 单根入口。
    async refreshEntry(input) {
      requireController();
      text.parse(input.entryId);
      z.number().int().nonnegative().nullable().parse(input.expectedLastSyncedAt);
      const project = cacheSchema.parse(input.project);
      const db = await options.database();
// 刷新整体放在一个写事务里：CAS 查询与 UPDATE 之间不能被其它写入插入，否则版本比较失去意义。
      const outcome = write(db, () => {
        // 删除及重新添加改变 entry ID；版本比较阻止迟到响应覆盖新缓存。
        const previous = db
          .prepare(`SELECT * FROM remote_project_entries
          WHERE entry_id=? AND last_synced_at IS ? AND (remote_project_id IS NULL OR remote_project_id=? OR remote_project_id LIKE ?)`)
          .get(
            input.entryId,
            input.expectedLastSyncedAt,
            project.projectId,
            LEGACY_SINGLE_ROOT_PROJECT_PREFIX + "%",
          );
// [失败路径] CAS 未命中即视为这条响应已过期：不重试、不覆盖，changed=false 保证不触发广播回环。
        if (!previous) return { applied: false, changed: false };
        if (
          (previous.remote_project_id == null ||
            String(previous.remote_project_id).startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX)) &&
          db
            .prepare(
              "SELECT 1 FROM remote_project_entries WHERE host_id=? AND remote_project_id=? AND entry_id<>?",
            )
            .get(previous.host_id!, project.projectId, input.entryId)
        ) {
          // 多个旧 cwd 可解析到同一项目；保留已解析 entry ID，删除当前通过 CAS 的旧入口。
// [权衡] 旧 cwd 入口解析到已有项目时删除自身而不是保留：保留会让同一项目两个 id 都能打开，
// 之后两侧缓存各自刷新、互相覆盖。删除后返回 applied=true，让调用方知道本地 id 已失效。
          db.prepare("DELETE FROM remote_project_entries WHERE entry_id=?").run(input.entryId);
// 删除旧入口也算一次已应用的结果：调用方需要知道 CAS 已消费，不能再拿旧 entryId 重试。
          return { applied: true, changed: true };
        }
// 序列化一次供比较与写入共用：分别序列化会因属性顺序不同产生假变更，触发无意义的广播。
        const roots = JSON.stringify(project.roots);
        db.prepare(
          `UPDATE remote_project_entries SET remote_project_id=?,cached_name=?,cached_roots_json=?,last_synced_at=? WHERE entry_id=?`,
        ).run(
          project.projectId,
          project.name,
          roots,
// 版本从 CAS 的期望值推进：这样写入的版本必然大于任何并发读取者手里的版本，其后续 CAS 会失败。
          nextVersion(input.expectedLastSyncedAt),
          input.entryId,
        );
        return {
          applied: true,
          changed:
            previous.remote_project_id !== project.projectId ||
            previous.cached_name !== project.name ||
// 只比较落库字段：last_synced_at 变化本身不算内容变更，否则每次刷新都会广播一次无用事件。
            previous.cached_roots_json !== roots,
        };
      });
      // 不变内容仍消费版本，但不广播，避免刷新回读形成反馈循环。
// 事务外通知：afterChange 可能触发 IPC 广播，放在事务内会延长写锁持有时间。
// [失败路径] 广播失败不回滚已提交数据，缓存与持久化以库为准。
      if (outcome.changed) await changed();
// 只回传 applied 而不回传 changed：changed 属于内部广播决策，暴露出去会诱导调用方自行判断是否刷新。
      return outcome.applied;
    },
// 删除入口不需要事务包装：单条 DELETE 自带原子性，且无关联行需要同步清理。
    async removeEntry(id) {
      requireController();
      text.parse(id);
// [权衡] 删除入口不包事务：单语句原子；若后续需要在删除时联动清理会话，必须改成 write()。
      const affected = (await options.database())
        .prepare("DELETE FROM remote_project_entries WHERE entry_id=?")
        .run(id).changes;
      if (affected) await changed();
    },
  };
// 返回冻结前的普通对象：调用方通过接口类型访问，实现细节（如 write 的事务包装）不外泄。
  return service;
}
