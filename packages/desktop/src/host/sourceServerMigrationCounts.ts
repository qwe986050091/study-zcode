// Source Server 迁移统计（失败路径数/废弃路径数）的异步读取投影。
//
// 数据流：目录快照是同步事实源（有哪些 server），迁移统计是异步补充项——每个在线 server
// 对应一条 MigrationRead，先发 loading，再异步补 available/unavailable，最后通过 onDidChange
// 通知上层重算快照。这样「本机设备目录」与「手动断开」永远不依赖远端统计是否完成。
//
// 失败语义：远端两项统计任一失败即整条标 unavailable（不发布半份数字）；
// 读取抛错被吞成 unavailable，不向调用方抛异常。
// 不变量：统计结果绑定「当前物理连接实例」——连接换代、目录移除、invalidate 或 dispose 后
// 迟到的结果一律丢弃，避免旧连接的统计覆盖新连接（与 #18 的 generation 语义同构：
// 这里用对象身份 entry.connection 做代际判定，而不是复用 generation 数字）。
// 并发口径：在途读取期间再次失效只置 refreshRequested（合并刷新），
// 防止网络停滞时目录事件堆积出大量远端请求。

import {
  sourceServerManagementSnapshotSchema,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import type { ManagedSourceServerConnection } from "./sourceServerConnectionManager.js";
import type { SourceServerDirectorySnapshot } from "./sourceServerDirectory.js";

/** Host 管理服务持有的统计投影；远端读取不阻塞本机目录，连接换代后旧结果失效。 */
// 输入：getOnlineConnection 提供「当前该 server 的物理连接」（缺省即 requires-connection），
//   onDidChange 在异步统计落定时通知上层重算快照。
// 输出：read / invalidate / dispose；read 是同步纯投影，绝不等待远端。
// 副作用：read 会按需发起远端统计请求；成功/失败落地后回调 onDidChange。
// 失败语义：读取失败仅降级为 status="unavailable"，不抛出；dispose 后不再回调。
// 维护的不变量：同一 sourceServerId 至多一条 MigrationRead，且按连接对象身份判定是否过期。
export function createSourceServerMigrationCounts(options: {
  getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined;
  onDidChange(): void;
}) {
  let disposed = false;
  type MigrationCount = SourceServerManagementSnapshot["migrationCounts"][number];
  interface MigrationRead {
    connection: ManagedSourceServerConnection;
    value: MigrationCount;
    refreshRequested: boolean;
  }
  const migrationReads = new Map<string, MigrationRead>();
  function invalidateMigrationCounts(sourceServerId?: string) {
    for (const [id, entry] of migrationReads) {
      if (sourceServerId !== undefined && id !== sourceServerId) continue;
      // 在途只标记一次刷新，避免目录事件在网络停滞时积累远端请求。
      if (entry.value.status === "loading") entry.refreshRequested = true;
      else migrationReads.delete(id);
    }
  }
  function startMigrationRead(sourceServerId: string, entry: MigrationRead) {
    void (async () => {
      let value: MigrationCount;
      try {
        const service = entry.connection.services.sourceServerWorkspaceService;
        const [failed, abandoned] = await Promise.allSettled([
          Promise.resolve().then(() => service.getFailedPathCount()),
          Promise.resolve().then(() => service.getAbandonedPathCount()),
        ]);
        // 一项失败也要等该组另一项收口，避免反复失效时堆积仍在途的请求。
        if (failed.status !== "fulfilled" || abandoned.status !== "fulfilled") {
          throw new Error("Migration counts unavailable");
        }
        value = sourceServerManagementSnapshotSchema.shape.migrationCounts.element.parse({
          sourceServerId,
          status: "available",
          failedPathCount: failed.value,
          abandonedPathCount: abandoned.value,
        });
      } catch {
        value = { sourceServerId, status: "unavailable" };
      }
      // 统计属于当前物理连接；断开、换代、目录移除或释放后的迟到结果不能发布。
      if (
        disposed ||
        migrationReads.get(sourceServerId) !== entry ||
        options.getOnlineConnection(sourceServerId) !== entry.connection
      )
        return;
      if (entry.refreshRequested) {
        entry.refreshRequested = false;
        startMigrationRead(sourceServerId, entry);
        return;
      }
      entry.value = value;
      options.onDidChange();
    })();
  }

  function readMigrationCounts(directory: SourceServerDirectorySnapshot): {
    failedPathCount: number;
    abandonedPathCount: number;
    migrationCounts: SourceServerManagementSnapshot["migrationCounts"];
  } {
    const activeSources = new Set(directory.servers.map((server) => server.sourceServerId));
    for (const id of migrationReads.keys()) {
      if (!activeSources.has(id)) migrationReads.delete(id);
    }
    // 本机设备目录与手动断开不能依赖远端迁移统计完成；统计仅异步补全快照。
    const migrationCounts = directory.servers.map((server): MigrationCount => {
      const connection = options.getOnlineConnection(server.sourceServerId);
      if (!connection) {
        migrationReads.delete(server.sourceServerId);
        return {
          sourceServerId: server.sourceServerId,
          status: "requires-connection" as const,
        };
      }
      let entry = migrationReads.get(server.sourceServerId);
      if (!entry || entry.connection !== connection) {
        entry = {
          connection,
          value: { sourceServerId: server.sourceServerId, status: "loading" },
          refreshRequested: false,
        };
        migrationReads.set(server.sourceServerId, entry);
        startMigrationRead(server.sourceServerId, entry);
      }
      return entry.value;
    });
    const totals = migrationCounts.reduce(
      (total, count) => ({
        failedPathCount:
          total.failedPathCount + (count.status === "available" ? count.failedPathCount : 0),
        abandonedPathCount:
          total.abandonedPathCount + (count.status === "available" ? count.abandonedPathCount : 0),
      }),
      { failedPathCount: 0, abandonedPathCount: 0 },
    );
    return { ...totals, migrationCounts };
  }

  return {
    read: readMigrationCounts,
    invalidate: invalidateMigrationCounts,
    dispose() {
      disposed = true;
      migrationReads.clear();
    },
  };
}
