/* ============================================================
 * MCP 连接池（adapters/src/mcp/pool.ts）
 *
 * 定位：按 connectionKey 复用 McpPort；lease 是引用计数单位，池自己不做协议逻辑。
 * key = serverName + 隔离范围（session=leaseId / workspace=workspaceKey）+ 稳定配置串。
 * 输入：createAdapter 工厂、idleGraceMs、logger、telemetry。
 * 输出：acquireLease() 得到的 McpPort（方法与租约绑定），池级 close/stats。
 * 副作用：创建/关闭 adapter（可能 spawn 子进程）、定时器、遥测上报、日志。
 * 失败语义：acquire 期间 connectServer 的拒绝原样返回给调用方且不缓存为成功；
 * 关闭 adapter 失败只告警；池 close 后 acquireLease 直接抛错。
 * 不变量：entry 上 refs 归零才启动 idle 定时器；定时器触发时若又有新 lease 则取消；
 * 同一 entry 的 revalidate 共享单飞 promise；lease 只能操作自己 leased 的 server，
 * 配置变化会切换 entry 并释放旧引用，旧 entry 归零后按 grace 回收。
 * ============================================================ */

import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zcode/contracts";
import { randomUUID } from "node:crypto";
import type { McpTelemetryTracker } from "./telemetry.js";

// 引用归零后的宽限期：给“短暂中断后同一 session 立刻复用”留窗口，避免反复 spawn。
const DEFAULT_IDLE_GRACE_MS = 30_000;

/** 工厂入参：connectionContext 在 entry 创建时固定，后续共享 lease 共用同一连接 ID。 */
export interface CreateMcpAdapterForPoolInput {
  connectionContext: McpConnectionContext;
  config: McpServerConfig;
  serverName: string;
  workingDirectory?: string;
}

/**
 * 连接身份与隔离口径。
 * mcpConnectionId：entry 级 UUID，日志/遥测关联键；
 * mcpIsolation：session（每个 lease 独享）或 workspace（同 workspace 跨 session 共享）；
 * sessionId 仅 session 隔离时有值；workspaceKey 仅 workspace 隔离时有值。
 */
export interface McpConnectionContext {
  mcpConnectionId: string;
  mcpIsolation: "session" | "workspace";
  sessionId?: string;
  workspaceKey?: string;
}

/** 池选项：idleGraceMs 缺省 30s；telemetry 为可选旁路，任何失败不影响池行为。 */
export interface McpConnectionPoolOptions {
  createAdapter(input: CreateMcpAdapterForPoolInput): McpPort;
  idleGraceMs?: number;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
}

/**
 * 池对外契约。
 * acquireLease：获取一个独立命名空间的 McpPort；池关闭后抛错；
 * close：强制关闭所有 entry（不等 idle grace）；stats：当前 entry 数与待关闭数。
 */
export interface McpConnectionPool {
  acquireLease(options?: { leaseId?: string; sessionId?: string }): McpPort;
  close(): Promise<void>;
  stats(): { activeConnections: number; pendingCloseConnections: number };
}

/**
 * 池条目。
 * refs：持有该连接的 leaseId 集合；connecting：首次连接 promise（所有 lease 共享）；
 * closeTimer：refs 归零后的延迟关闭定时器（unref，不阻止进程退出）；
 * revalidating：同一条目的存活校验单飞 promise，避免并发 ping/重连。
 */
interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
  serverName: string;
}

/**
 * 创建连接池。
 *
 * 所有状态（entries / closed / leaseSequence）封装在闭包里；不启动任何后台任务。
 * 副作用只来自 adapter 工厂、定时器、遥测与日志；失败语义见文件头。
 */
export function createMcpConnectionPool(options: McpConnectionPoolOptions): McpConnectionPool {
  const entries = new Map<string, PoolEntry>();
  const idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const logger = options.logger?.child({ module: "adapters.mcp.pool" });
  let closed = false;
  let leaseSequence = 0;

  /**
   * 关闭并移除 entry。
   * 先摘除 entries 映射（防止新 lease 再命中正在关闭的连接），再关闭 adapter；
   * 关闭失败只告警；无论成败都注销遥测连接（终态）。
   */
  const closeEntry = async (entry: PoolEntry): Promise<void> => {
    const startedAt = Date.now();
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    try {
      await entry.adapter.close();
      logger?.info("MCP pooled connection closed", {
        ...entry.connectionContext,
        durationMs: Date.now() - startedAt,
        event: "mcp.pool.connection.closed",
        mcpServerName: entry.serverName,
        status: "completed",
      });
    } catch (error) {
      logger?.warn("MCP pooled connection close failed", {
        ...entry.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.pool.connection.close.failed",
        mcpServerName: entry.serverName,
      });
    } finally {
      options.telemetry?.unregisterConnection({
        connectionId: entry.connectionContext.mcpConnectionId,
      });
    }
  };

  /**
   * 引用归零后安排在 idleGraceMs 后关闭；已有定时器则幂等。
   * grace<=0 立即关闭；定时器触发时若已有新 lease（refs 非空）则放弃关闭。
   * 定时器 unref，避免连接池单独阻止 Agent 退出。
   */
  const scheduleClose = (entry: PoolEntry): void => {
    if (entry.closeTimer) return;
    if (idleGraceMs <= 0) {
      void closeEntry(entry);
      return;
    }
    entry.closeTimer = setTimeout(() => {
      entry.closeTimer = undefined;
      if (entry.refs.size === 0) void closeEntry(entry);
    }, idleGraceMs);
    entry.closeTimer.unref?.();
  };

  // 设置页的 mcpPort 是进程级的 `protocol-settings` lease，connectionKey 只由
  // serverName + leaseId + config 组成，配置没变时每次 mcp/list 都命中同一个 entry 并直接返回
  // 首次连接那个早已 resolve 的 promise——不重连、不探测、不打日志。HTTP/SSE MCP 被停掉又不会
  // 派发 onclose，于是设置页永远显示"已连接并可用"，点多少次刷新都不变。
  // 这里在显式要求 revalidate 时先确认连接仍然存活，已死则在同一个 entry 上原地重连
  // （保持 entry 身份，其他共享该连接的 lease 不会被打断成 "not leased"）。
  /**
   * 显式 revalidate 时探测连接是否仍存活；已死则原地重连，保持 entry 身份。
   * connecting/disabled/untrusted 一律不打扰（重连会作废进行中的 OAuth URL 与 PKCE/state）；
   * connected 状态用 pingServer 判定，无该方法则视为存活。
   * 同一 entry 的并发调用共享一次探测；重连失败由 status()/调用方表达，不在此重复冒泡。
   */
  const revalidateEntry = async (
    entry: PoolEntry,
    config: McpServerConfig,
    connectOptions: McpConnectOptions,
  ): Promise<void> => {
    if (entry.revalidating) {
      await entry.revalidating;
      return;
    }
    const run = (async () => {
      const connected = await entry.connecting.then(
        () => true,
        () => false,
      );
      const state = connected
        ? (await entry.adapter.status())[entry.serverName]?.status
        : undefined;
      // 进行中的握手（含 OAuth 待授权）和显式停用/待信任状态不打扰：
      // 重连会作废浏览器里已打开的授权 URL 和 PKCE/state。
      if (state === "connecting" || state === "disabled" || state === "untrusted") {
        return;
      }
      if (state === "connected") {
        const alive = (await entry.adapter.pingServer?.(entry.serverName)) ?? true;
        if (alive) {
          logger?.debug("MCP pooled connection revalidated", {
            ...entry.connectionContext,
            event: "mcp.pool.connection.revalidated",
            mcpServerName: entry.serverName,
            status: "completed",
          });
          return;
        }
      }
      logger?.warn("MCP pooled connection is stale; reconnecting", {
        ...entry.connectionContext,
        event: "mcp.pool.connection.stale",
        mcpConnectionState: state ?? "unknown",
        mcpServerName: entry.serverName,
        status: "started",
      });
      entry.connecting = entry.adapter.connectServer(entry.serverName, config, connectOptions);
      // 失败由 status()/调用方 await entry.connecting 表达，这里不重复冒泡。
      await entry.connecting.catch(() => undefined);
    })();
    entry.revalidating = run.finally(() => {
      entry.revalidating = undefined;
    });
    await entry.revalidating;
  };

  /**
   * 创建一个租约视图（租约之间互相隔离，只能操作自己 leased 的 server）。
   * leaseId 含单调序号 + 调用方 id，保证同 session 的多次 acquire 也唯一；
   * appListeners 存在本租约内，release/换源时统一 off 并通知，避免监听器泄漏。
   */
  const acquireLease = (leaseOptions: { leaseId?: string; sessionId?: string } = {}): McpPort => {
    if (closed) throw new Error("MCP connection pool is closed");
    const leaseId = `${++leaseSequence}:${leaseOptions.leaseId ?? "lease"}`;
    const sessionId = leaseOptions.sessionId?.trim() || undefined;
    const leased = new Map<string, string>();
    const configuredServers = new Map<string, McpServerConfig>();
    const appListeners = new Map<string, Set<{ listener: () => void; off: () => void }>>();
    /**
     * 应用连接失效通知：先移除监听集合再逐个 off + 回调。
     * 先删后通知，保证回调中再次注册不会与旧集合混淆；重复调用幂等。
     */
    const invalidateApps = (serverName: string) => {
      const watchers = appListeners.get(serverName);
      appListeners.delete(serverName);
      for (const watcher of watchers ?? []) {
        watcher.off();
        watcher.listener();
      }
    };
    let leaseClosed = false;
    let sessionStartupReported = false;

    /** 取本租约已绑定的 entry；未租用（或 entry 已回收）时抛错，绝不隐式连接。 */
    const requireEntry = (serverName: string): PoolEntry => {
      const key = leased.get(serverName);
      const entry = key ? entries.get(key) : undefined;
      if (!entry) throw new Error(`MCP server is not leased by this session: ${serverName}`);
      return entry;
    };

    /**
     * 释放某 server 的本租约引用：先标记未租用并清监听，再减 refs。
     * refs 删除失败（已被并发释放）直接返回；归零时进入 idle grace，不立即杀进程。
     */
    const release = (serverName: string): void => {
      const key = leased.get(serverName);
      if (!key) return;
      leased.delete(serverName);
      invalidateApps(serverName);
      const entry = entries.get(key);
      if (!entry) return;
      if (!entry.refs.delete(leaseId)) return;
      options.telemetry?.releaseOwner({
        connectionId: entry.connectionContext.mcpConnectionId,
        ownerId: leaseId,
      });
      logger?.info("MCP connection lease released", {
        ...entry.connectionContext,
        event: "mcp.pool.lease.released",
        mcpLeaseId: leaseId,
        mcpServerName: serverName,
        refCount: entry.refs.size,
        ...(sessionId ? { sessionId } : {}),
      });
      if (entry.refs.size === 0) scheduleClose(entry);
    };

    /**
     * 连接并绑定到本租约。
     *
     * 命中现有 entry：取消关闭定时器、增加引用、按需 revalidate，并 await 首次 connecting；
     * 未命中：创建 connectionContext、注册遥测、创建 adapter 并立即启动连接（promise 入池）。
     * 若 key 因配置/隔离变化而改变：从旧 entry 移除本 lease 引用并调度关闭，避免双份连接。
     * 失败语义：connectServer 的 reject 原样返回；entry 仍留在池中由后续 lease 决定命运。
     */
    const acquire = async (
      serverName: string,
      config: McpServerConfig,
      connectOptions: McpConnectOptions = {},
    ): Promise<McpServerStatus> => {
      const key = connectionKey({
        config,
        connectOptions,
        leaseId,
        serverName,
      });
      const previousKey = leased.get(serverName);
      let entry = entries.get(key);
      let ownerAdded = false;
      if (entry) {
        // 命中仍存活的 entry：取消待关闭定时器，避免“刚拿到连接就被 grace 回收”。
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.closeTimer = undefined;
        const previousRefCount = entry.refs.size;
        entry.refs.add(leaseId);
        ownerAdded = entry.refs.size !== previousRefCount;
        if (connectOptions.revalidate) {
          await revalidateEntry(entry, config, connectOptions);
        }
      } else {
        // 过去 pool、adapter 和 stdio PID 的日志彼此没有稳定关联键，无法从一个
        // session 追到实际 MCP 子进程。连接上下文在 entry 创建时固定，后续 lease 共用同一 ID。
        const connectionContext = createConnectionContext({
          config,
          connectOptions,
          sessionId,
        });
        options.telemetry?.registerConnection({
          connectionId: connectionContext.mcpConnectionId,
          isolation: connectionContext.mcpIsolation,
          serverName,
          ...(config.source ? { source: config.source.kind } : {}),
        });
        const adapter = options.createAdapter({
          connectionContext,
          config,
          serverName,
          workingDirectory: connectOptions.workingDirectory,
        });
        entry = {
          adapter,
          connectionContext,
          connecting: adapter.connectServer(serverName, config, connectOptions),
          key,
          refs: new Set([leaseId]),
          serverName,
        };
        entries.set(key, entry);
        ownerAdded = true;
        logger?.info("MCP pooled connection created", {
          ...connectionContext,
          event: "mcp.pool.connection.created",
          mcpServerName: serverName,
          transport: config.type,
        });
      }
      if (previousKey && previousKey !== key) {
        // 配置/隔离变化导致换 entry：先解除旧引用，旧连接归零后按 grace 回收，避免双份进程。
        invalidateApps(serverName);
        const previous = entries.get(previousKey);
        if (previous) {
          if (previous.refs.delete(leaseId)) {
            options.telemetry?.releaseOwner({
              connectionId: previous.connectionContext.mcpConnectionId,
              ownerId: leaseId,
            });
            logger?.info("MCP connection lease released", {
              ...previous.connectionContext,
              event: "mcp.pool.lease.released",
              mcpLeaseId: leaseId,
              mcpServerName: serverName,
              refCount: previous.refs.size,
              ...(sessionId ? { sessionId } : {}),
            });
            if (previous.refs.size === 0) scheduleClose(previous);
          }
        }
      }
      leased.set(serverName, key);
      if (ownerAdded) {
        // 只有新增引用才 acquireOwner，避免同一 lease 重复 acquire 时把遥测计数抬高。
        options.telemetry?.acquireOwner({
          connectionId: entry.connectionContext.mcpConnectionId,
          ownerId: leaseId,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      if (previousKey !== key) {
        // workspace 隔离连接会被多个 session 共享，不能把首个 session 记成唯一 owner；
        // 单独记录 lease 生命周期才能准确表达多对一关系。
        logger?.info("MCP connection lease acquired", {
          ...entry.connectionContext,
          event: "mcp.pool.lease.acquired",
          mcpLeaseId: leaseId,
          mcpServerName: serverName,
          refCount: entry.refs.size,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      return await entry.connecting;
    };

    /**
     * 汇总本租约所有 server 的 status 与 tools。
     * 同一 entry 多 server 时重复调用 adapter；首次 snapshot 且带 sessionId 时上报
     * 会话启动汇总（只计一次），计数口径为 configured/connected/failed/stdio 进程数。
     */
    const snapshot = async (): Promise<McpConnectionSnapshot> => {
      const statuses: Record<string, McpServerStatus> = {};
      const tools: McpToolDescriptor[] = [];
      for (const [serverName, key] of leased) {
        const entry = entries.get(key);
        if (!entry) continue;
        const status = (await entry.adapter.status())[serverName];
        if (status) statuses[serverName] = status;
        tools.push(...(await entry.adapter.listTools()));
      }
      if (sessionId && !sessionStartupReported) {
        sessionStartupReported = true;
        const enabledServers = [...configuredServers].filter(
          ([, config]) => config.enabled !== false,
        );
        const connectedCount = enabledServers.filter(
          ([serverName]) => statuses[serverName]?.status === "connected",
        ).length;
        options.telemetry?.recordSessionStartup({
          configuredCount: enabledServers.length,
          connectedCount,
          failedCount: enabledServers.length - connectedCount,
          processCount: enabledServers.filter(
            ([serverName, config]) =>
              config.type === "stdio" && statuses[serverName]?.status === "connected",
          ).length,
          sessionId,
        });
      }
      return { statuses, tools };
    };

    return {
      /**
       * 等待 app 连接就绪。
       * 共享 entry 的 connecting 可能被其他 lease 持有：这里按“key/entry/connecting 仍是
       * 本租约看到的那份”做身份校验，等待结束若 lease 已释放或换源则返回 null，
       * 防止把过期连接交给调用方（迟到结果必须丢弃）。
       */
      async waitForAppConnection(serverName) {
        const key = leased.get(serverName);
        if (!key) return null;
        const entry = entries.get(key);
        if (!entry) return null;
        const connecting = entry.connecting;
        await connecting;
        const source = entry.adapter.waitForAppConnection
          ? await entry.adapter.waitForAppConnection(serverName)
          : (entry.adapter.appConnectionSnapshot?.(serverName) ?? null);
        // 共享连接可能仍被其它会话持有；等待结束不能复活已释放或换源的本会话 lease。
        return !leaseClosed &&
          leased.get(serverName) === key &&
          entries.get(key) === entry &&
          entry.connecting === connecting
          ? source
          : null;
      },
      /** 同步读取 app 连接快照；未租用或 adapter 不支持时返回 null。 */
      appConnectionSnapshot(serverName) {
        const key = leased.get(serverName);
        return key ? (entries.get(key)?.adapter.appConnectionSnapshot?.(serverName) ?? null) : null;
      },
      /**
       * 注册 app 连接失效监听，返回取消函数。
       * 同时挂到租约的 appListeners（release 时统一清理）与 adapter（实际事件源）；
       * 取消函数只删自己，最后一项删除时清理 server 集合。
       */
      onAppConnectionInvalidated(serverName, listener) {
        const entry = requireEntry(serverName);
        const watchers = appListeners.get(serverName) ?? new Set();
        const watcher = {
          listener,
          off: entry.adapter.onAppConnectionInvalidated?.(serverName, listener) ?? (() => {}),
        };
        watchers.add(watcher);
        appListeners.set(serverName, watchers);
        return () => {
          watcher.off();
          watchers.delete(watcher);
          if (!watchers.size) appListeners.delete(serverName);
        };
      },
      /** 调用工具：必须已租用该 server，否则 requireEntry 抛错；异常原样返回。 */
      async callTool(
        request: McpCallToolRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpToolCallResult> {
        return await requireEntry(request.serverName).adapter.callTool(request, callOptions);
      },
      /** 读取资源；adapter 未实现资源能力时抛明确错误，而不是静默返回空。 */
      async readResource(
        request: McpReadResourceRequest,
        callOptions?: McpCallToolOptions,
      ): Promise<McpReadResourceResult> {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.readResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.readResource(request, callOptions);
      },
      // 资源列表与订阅经同一 entry 的 adapter；登记表在 adapter（连接层）里，多 session 共享。
      /** 列出资源；要求本租约已持有该 server 且 adapter 支持 resources。 */
      async listResources(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResources) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResources(request, callOptions);
      },
      /** 列出资源模板；未实现则抛错，口径同 readResource。 */
      async listResourceTemplates(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.listResourceTemplates) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        return await adapter.listResourceTemplates(request, callOptions);
      },
      /** 订阅资源；失败向上冒泡，登记计数由 adapter 维护。 */
      async subscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.subscribeResource) {
          throw new Error(`MCP adapter does not support resources: ${request.serverName}`);
        }
        await adapter.subscribeResource(request, callOptions);
      },
      /** 退订资源；adapter 不支持时静默空操作（退订无需失败）。 */
      async unsubscribeResource(request, callOptions) {
        const adapter = requireEntry(request.serverName).adapter;
        if (!adapter.unsubscribeResource) return;
        await adapter.unsubscribeResource(request, callOptions);
      },
      /**
       * 按 subscriber 前缀清理本租约涉及的所有连接；同一 entry 只处理一次（seen 去重）。
       * 返回累计退订数；adapter 不支持时跳过。
       */
      async unsubscribeResourcesBySubscriber(prefix) {
        let released = 0;
        const seen = new Set<string>();
        for (const key of leased.values()) {
          if (seen.has(key)) continue;
          seen.add(key);
          const adapter = entries.get(key)?.adapter;
          if (adapter?.unsubscribeResourcesBySubscriber) {
            released += await adapter.unsubscribeResourcesBySubscriber(prefix);
          }
        }
        return released;
      },
      /** 关闭租约：幂等；逐个释放所有 server，只减引用，不直接关闭共享连接。 */
      async close(): Promise<void> {
        if (leaseClosed) return;
        leaseClosed = true;
        for (const serverName of [...leased.keys()]) release(serverName);
      },
      /**
       * 连接全量配置：记录 configuredServers（供启动遥测），先释放已移除的 server，
       * 再并发 acquire 所有 server，最后返回快照。
       * 并发连接意味着任一失败会 reject 整个 Promise.all；已成功的 entry 仍保留在池中。
       */
      async connectConfiguredServers(
        servers: Record<string, McpServerConfig>,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpConnectionSnapshot> {
        configuredServers.clear();
        for (const [serverName, config] of Object.entries(servers)) {
          configuredServers.set(serverName, config);
        }
        const configuredNames = new Set(Object.keys(servers));
        for (const serverName of [...leased.keys()]) {
          if (!configuredNames.has(serverName)) release(serverName);
        }
        await Promise.all(
          Object.entries(servers).map(([serverName, config]) =>
            acquire(serverName, config, connectOptions),
          ),
        );
        return await snapshot();
      },
      /** 连接单个 server（走 acquire 复用规则），返回连接后的状态；失败原样抛给调用方。 */
      async connectServer(
        serverName: string,
        config: McpServerConfig,
        connectOptions: McpConnectOptions = {},
      ): Promise<McpServerStatus> {
        return await acquire(serverName, config, connectOptions);
      },
      /**
       * 断开单个 server：读取当前状态后释放本租约。
       * 返回合成状态（disconnected、toolCount=0、updatedAt=now）；未租用时 undefined。
       * 注意：只影响本 lease 引用，共享连接会按 refs 决定是否进入 idle grace。
       */
      async disconnectServer(serverName: string): Promise<McpServerStatus | undefined> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        const status = entry ? (await entry.adapter.status())[serverName] : undefined;
        release(serverName);
        return status
          ? {
              ...status,
              status: "disconnected",
              toolCount: 0,
              updatedAt: new Date().toISOString(),
            }
          : undefined;
      },
      /** 工具列表：走 snapshot，副作用为读取各 adapter 状态与工具。 */
      async listTools(): Promise<McpToolDescriptor[]> {
        return (await snapshot()).tools;
      },
      /**
       * 工具列表修订号：各 entry 的修订号求和（同一 entry 只算一次）。
       * 纯同步、无 IO；用于上层缓存失效判断。
       */
      toolListRevision(): number {
        let revision = 0;
        for (const key of new Set(leased.values())) {
          revision += entries.get(key)?.adapter.toolListRevision?.() ?? 0;
        }
        return revision;
      },
      /** 探测 server 存活：未租用返回 false；adapter 无 pingServer 时乐观返回 true。 */
      async pingServer(serverName: string, pingOptions?: { timeoutMs?: number }): Promise<boolean> {
        const key = leased.get(serverName);
        const entry = key ? entries.get(key) : undefined;
        if (!entry) return false;
        return (await entry.adapter.pingServer?.(serverName, pingOptions)) ?? true;
      },
      /** 全部状态：走 snapshot（含首次启动遥测上报）。 */
      async status(): Promise<Record<string, McpServerStatus>> {
        return (await snapshot()).statuses;
      },
    };
  };

  return {
    acquireLease,
    /**
     * 池级关闭：先置 closed 拒绝新租约，再清空映射并并发关闭全部 entry。
     * 关闭失败在 closeEntry 内吞掉，Promise.all 不会因此 reject。
     */
    async close(): Promise<void> {
      closed = true;
      const pending = [...entries.values()];
      entries.clear();
      await Promise.all(pending.map(closeEntry));
    },
    /** 池快照：active 为 entries 数；pendingClose 为 refs 归零（正等待 grace）的 entry 数。 */
    stats() {
      return {
        activeConnections: entries.size,
        pendingCloseConnections: [...entries.values()].filter((entry) => entry.refs.size === 0)
          .length,
      };
    },
  };
}

/**
 * 生成 entry 级连接上下文（UUID 一次固定）。
 *
 * isolation 只有显式 "workspace" 才跨 session；session 隔离时记录 sessionId。
 * workspaceKey 优先 workspaceIdentity，其次 workingDirectory；两者皆空则缺省。
 */
function createConnectionContext(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  sessionId?: string;
}): McpConnectionContext {
  const mcpIsolation = input.config.isolation === "workspace" ? "workspace" : "session";
  const workspaceKey = resolveWorkspaceKey(input.connectOptions);
  return {
    mcpConnectionId: randomUUID(),
    mcpIsolation,
    ...(workspaceKey ? { workspaceKey } : {}),
    ...(mcpIsolation === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

/** 解析 workspace 作用域键：workspaceIdentity 优先（同仓库多目录），否则 workingDirectory。 */
function resolveWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

/**
 * 计算连接复用键：`serverName \0 scope \0 stableConfig`。
 *
 * workspace 隔离用 workspaceKey（空串表示未指定，仍可能被复用，需由上层保证语义）；
 * 否则用 leaseId，即每个租约独享连接。配置用稳定序列化，字段顺序不影响命中。
 */
function connectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  // 默认 session isolation；只有明确声明 workspace 的无状态 server 才允许跨 session 复用。
  const scope =
    input.config.isolation === "workspace"
      ? (resolveWorkspaceKey(input.connectOptions) ?? "")
      : input.leaseId;
  return [input.serverName, scope, stableStringify(input.config)].join("\u0000");
}

/**
 * 确定性 JSON 序列化：对象键排序、跳过 undefined 值、数组保序。
 * 用于 connectionKey，保证同一配置不同键序得到相同键；循环引用会栈溢出（配置不应循环）。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
