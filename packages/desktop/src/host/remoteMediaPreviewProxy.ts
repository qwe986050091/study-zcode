// INV-01 token 是唯一访问凭据，取自 randomBytes(32) 的十六进制串，URL 不依赖登录态；守住位置：prepare 内 lease 构造与 leasesByToken 写入；改错故障：无凭据也能取流，或 token 可预测被同机进程猜中。
// INV-02 scopeKey 固化 workspaceIdentity 与 remoteSessionId，任一维度变化即视为 attachment 换代；守住位置：工厂内 scopeKey 常量与 isLeaseAlive 的比对；改错故障：摘除重挂后旧 URL 仍能播放，跨会话串流。
// INV-03 lease 存活必须同时满足未销毁、scopeKey 相同、未过绝对过期、未超空闲期；守住位置：isLeaseAlive 的早退条件与末行空闲判断；改错故障：过期或已销毁的 lease 继续发流，端口与读取配额长占。
// INV-04 路径先 resolvePath 再判 workspace 归属，不能只做字面前缀比较；守住位置：resolveMediaPath 中 isPathWithinWorkspace 的调用；改错故障：符号链接把 workspace 外文件暴露成可播放地址。
// INV-05 只接受 getMediaPreviewFormat 识别且 kind 与 expectedKind 一致的格式；守住位置：resolveMediaPath 的首个格式判断与 prepare 的第二道核对；改错故障：任意文件被当媒体读取，或视频请求拿到音频内容。
// INV-06 单文件上限在 prepare 阶段固化，请求期只用 lease.size 对账；守住位置：resolveMediaPath 的 maxFileBytes 比较与请求首尾两次 stat；改错故障：超大文件吃满内存，或文件变长后按旧长度截断。
// INV-07 chunkBytes 被钳到 DEFAULT_CHUNK_BYTES 以内，调用方不能放大；守住位置：工厂内 chunkBytes 的取值表达式；改错故障：单次缓冲膨胀、背压粒度失效，慢客户端拖垮宿主内存。
// INV-08 per-lease 上限检查与自增之间不得出现 await；守住位置：acquireRequestSlot 的同步段；改错故障：并发请求同时越过上限，远端读取与内存被成倍放大。
// INV-09 全局限流器获取失败必须回滚本 lease 计数；守住位置：acquireRequestSlot 的 tryAcquire 失败分支；改错故障：计数只增不减，该 lease 后续请求被永久判忙。
// INV-10 槽位释放必须幂等，重复调用只生效一次；守住位置：MediaRequestSlot 的 release 与 released 标志；改错故障：异常路径与 finally 双重归还，宿主配额被多还。
// INV-11 只有 GET 且响应体长度大于零才占用并发槽，HEAD 与空文件不占；守住位置：handleRequest 中 requestSlot 的取值条件；改错故障：HEAD 探测耗尽配额，正常播放被 429 拒掉。
// INV-12 限流命中先写 Retry-After 再回 429，且不排队等待；守住位置：requestSlot 为空的分支；改错故障：客户端无退避提示反复重试，或请求悬挂占住连接。
// INV-13 写响应头之前必须 stat 对账，文件变化即 409 并摘除 lease；守住位置：try 段首个 stat 分支；改错故障：headersSent 之后只能断连，前端收到半截 200 无法重试。
// INV-14 每块读取长度必须等于请求长度，否则判 stale 并抛错；守住位置：分块循环内 chunk.length 的比较；改错故障：偏移错位后越界读取，或在末端死循环。
// INV-15 背压未接受时等 drain 或断连，收到 closed 立即终止循环；守住位置：waitForDrainOrDisconnect 的返回分支；改错故障：客户端断开后仍持续读远端，带宽与 CPU 空转。
// INV-16 aborted 一旦置位，尾部 stat 与收尾结束都不再执行；守住位置：循环后的条件块与 response 的 close 监听；改错故障：向已关闭响应写数据抛错，掩盖真实断因。
// INV-17 失败分支一律先回写错误响应，已写 body 后只允许 destroy；守住位置：request 事件的 catch 与 handleRequest 的 catch；改错故障：二次写头抛错，连接悬挂到超时。
// INV-18 dispose 幂等，先清空两张 lease 表再关监听与全部 socket；守住位置：返回对象里的 dispose 实现；改错故障：keep-alive 连接残留，端口泄漏到下一代 attachment。
//
// 模块职责：为每个 remote attachment 提供本机回环媒体代理，prepare 发放一次性 token URL，请求按 Range 分块回传。
// 状态所有权：lease 双表、disposed、listeningPromise 与 socket 集合都归工厂闭包，server 只负责传输。
// 阅读顺序：先看默认常量与 MediaLease，再看工厂与 scopeKey，随后槽位与存活判断，最后请求管线与 dispose。
// 远端媒体预览的 Host 侧代理：把远端 workspace 中的视频/音频通过本机回环 HTTP 提供给
// Electron 渲染进程播放（渲染进程无法直接读远端文件，也无法稳定使用自定义协议传输大文件）。
//
// 运行模型：
// - 每个 remote attachment（workspaceIdentity + remoteSessionId）对应一个独立代理实例，
//   服务面只在本机 127.0.0.1 的随机端口上，不对外暴露；
// - prepare 生成一次性 lease（previewId + 随机 token + 绝对路径 + 大小 + 过期时间），
//   播放 URL 携带 token，token 是唯一的访问凭据，不依赖登录态；
// - 每次请求都重新 stat 与分块读取，文件在预览期间变化即视为 stale 并删除 lease。
//
// 大纲不变量 #18 相关：instance 的 scope 在创建时固化（scopeKey 拼接 workspaceIdentity 与
// remoteSessionId），attachment 被摘除/dispose 时本实例的 lease 全部失效且端口关闭；
// 旧 attachment 遗留的 token 即使被复用也不会命中新实例（lease 表按实例隔离）。
//
// 失败语义：越界路径、不支持格式、超大文件、非法 Range、文件变化均以明确错误码回写；
// 限流（per-lease 与全局）返回 429，不排队。

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IFileService, IMediaPreviewService, MediaPreviewPreparation } from "@zcode/services";
import { getMediaPreviewFormat, type WindowHostAttachmentScope } from "@zcode/shared";
import {
  isPathWithinWorkspace,
  listen,
  parseRange,
  waitForDrainOrDisconnect,
  writeError,
} from "./remoteMediaPreviewProxyHelpers.js";

export { waitForDrainOrDisconnect } from "./remoteMediaPreviewProxyHelpers.js";

// [权衡] 路由前缀固定为 /__zcode_media/，与其它本机服务路径不重叠，改前缀等于让所有在途 URL 立刻 404。
// [资源] 512MB 上限只为一次完整 Range 预览留余量，超过即在 prepare 阶段拒绝，不进入传输。
// [资源] 单 lease 默认 2 路并发，是远端 RPC 通道吞吐与单进程内存占用的折中点。
// [资源] 分块默认 1MB，与钳制上限同值，兼顾往返次数与背压响应速度。
// [权衡] 空闲 10 分钟、绝对 2 小时两档过期，短档挡住挂起页签，长档覆盖一次完整观影。
// [事务] 这些常量只是缺省值，调用方可覆盖，唯独 chunkBytes 会在工厂内被再次收紧。
const MEDIA_ROUTE_PREFIX = "/__zcode_media/";
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

type RemoteScope = Extract<WindowHostAttachmentScope, { kind: "remote" }>;

// [事务] MediaLease 是一次性播放凭据的唯一记录，token 与 previewId 是它的两个索引键。
// [事务] size 在 prepare 时固化，之后每次读取都拿它与远端 stat 对账，是 stale 判定的基准。
// [资源] activeRequests 是本 lease 的在途计数，只允许槽位获取与释放两条路径改写。
// [失败路径] staleLogged 让同一 lease 的 stale 告警只落一次，避免逐块刷屏。
// [权衡] 两张 Map 指向同一条记录，任何摘除动作都必须成对删除，否则留下单向孤儿。
interface MediaLease {
  previewId: string;
  token: string;
  path: string;
  mediaType: string;
  size: number;
  scopeKey: string;
  expiresAt: number;
  lastAccessAt: number;
  activeRequests: number;
  staleLogged: boolean;
}

// 代理实例的外部契约：service 挂到 Host 的 remote attachment 服务面，dispose 用于摘除。
// dispose 语义（#18）：幂等；先清空 lease 表（后续请求一律 404/EXPIRED），再关闭监听与所有
// 已建立 socket，保证端口不会因为 keep-alive 连接残留而泄漏到下一个代际。
export interface RemoteMediaPreviewProxy {
  service: IMediaPreviewService;
  dispose(): Promise<void>;
}

interface MediaRequestSlot {
  release(): void;
}

// 创建一个 remote attachment 专属的媒体预览代理。
//
// 输入：fileService（远端文件访问，已绑定该 workspace 的 RPC channel）、scope（必须是
// kind="remote"，提供 workspaceIdentity / remoteSessionId / workspacePath 用于 scopeKey 与越界校验）、
// 可选上限（单文件大小、单 lease 并发、分块大小、空闲/绝对 TTL）与外部限流器。
// 输出：{ service, dispose }；service.prepare 返回 kind="host-range-url" 的播放描述，
//   其中 url 只在 lease 有效期内可用。
// 副作用：懒启动本机 HTTP 监听（首个 prepare 才 listen）；对每个 connection 记账 socket；
//   dispose 关闭端口并清理所有 lease。
// 失败语义：参数校验与 scope 校验都在 prepare 阶段失败（抛错），不会创建半初始化的 lease；
//   HTTP 侧错误以 4xx/5xx 回写，不影响实例继续服务其它 lease。
// 不变量（#18）：scopeKey 固化 workspaceIdentity 与 remoteSessionId，跨 attachment 的旧
//   token/previewId 不会误命中；disposed 置位后 isLeaseAlive 恒为 false，停止发放新 URL。
// 维护约束：chunkBytes 不允许超过 DEFAULT_CHUNK_BYTES（内存与背压的可预测性）。
// [事务] 工厂是唯一入口：fileService 已绑定该 workspace 的 RPC 通道，代理自身不持有连接。
// [资源] server 由 serverFactory 注入，缺省走 createServer，测试可替换而不改端口策略。
// [并发] 监听是懒启动的，首个 prepare 才真正 listen，空 attachment 不占端口。
// [失败路径] 参数与 scope 校验都在 prepare 内完成，失败时不留半初始化实例。
// [事务] 返回的 service 只暴露 prepare、refreshPlaybackUrl 与 release 三个动作。
// [资源] dispose 与 service 同层返回，摘除 attachment 时必须成对调用。
// [权衡] 日志与全局配额由宿主注入，代理不自建 logger，也不维护跨实例计数。
export function createRemoteMediaPreviewProxy(options: {
  fileService: IFileService;
  scope: RemoteScope;
  maxFileBytes?: number;
  maxConcurrentRequests?: number;
  chunkBytes?: number;
  idleTtlMs?: number;
  ttlMs?: number;
  serverFactory?: () => Server;
  requestLimiter?: {
    tryAcquire(): boolean;
    release(): void;
    getState?(): { active: number; limit: number };
  };
  logger?: {
    debug(message: string, metadata?: unknown): void;
    warn(message: string, metadata?: unknown): void;
  };
  writeChunk?: (response: ServerResponse, chunk: Buffer) => boolean;
}): RemoteMediaPreviewProxy {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  const chunkBytes = Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES);
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  // scopeKey 固化「哪个 workspace 的哪个远端会话」；任一维度变化都代表 attachment 换代。
  // [并发] scopeKey 由两个维度拼接，分隔符不可出现在任一维度中，否则不同 scope 会撞键。
  // [事务] workspaceIdentity 先 trim 再参与拼接，纯空白差异不算换代。
  // [事务] scopeKey 在工厂创建时求值一次，此后不再重算，实例身份因此不可变。
  // [失败路径] isLeaseAlive 再次比对 scopeKey，是实例被错误复用时的最后一道保险。
  // [权衡] 宁可每次多一次字符串比较，也不按 workspace 分片存 lease，换取删除逻辑简单。
  const scopeKey = `${options.scope.workspaceIdentity.trim()}\0${options.scope.remoteSessionId}`;
  const leasesByToken = new Map<string, MediaLease>();
  const leasesByPreviewId = new Map<string, MediaLease>();
  const sockets = new Set<import("node:net").Socket>();
  const server = (options.serverFactory ?? (() => createServer()))();
  let disposed = false;
  let listeningPromise: Promise<void> | undefined;
  let lastBusyLogAt = 0;
  let lastExpiredLogAt = 0;

  function logBusy(lease: MediaLease, owner: "lease" | "host"): void {
    const now = Date.now();
    if (now - lastBusyLogAt < 10_000) return;
    lastBusyLogAt = now;
    const hostState = options.requestLimiter?.getState?.();
    options.logger?.warn("media-preview.range BUSY", {
      scopeKey,
      owner,
      active: owner === "lease" ? lease.activeRequests : hostState?.active,
      limit: owner === "lease" ? maxConcurrentRequests : hostState?.limit,
    });
  }

  function logStale(lease: MediaLease): void {
    if (lease.staleLogged) return;
    lease.staleLogged = true;
    options.logger?.warn("media-preview.range STALE", { scopeKey, previewId: lease.previewId });
  }

  function logExpired(): void {
    const now = Date.now();
    if (now - lastExpiredLogAt < 10_000) return;
    lastExpiredLogAt = now;
    options.logger?.debug("media-preview.lease EXPIRED", { scopeKey });
  }

  // [并发] 上限检查与自增在同一同步段内完成，中间不插入 await，多请求才不会同时越过上限。
  // [失败路径] lease 侧已满时直接返回空，由调用方回 429，不进入远端读取。
  // [资源] 全局限流器失败要回滚本 lease 计数，两处配额必须同增同减。
  // [事务] 释放用 released 标志保证幂等，重复调用不会多还配额。
  // [权衡] 用增减计数而非信号量对象，省一次分配，代价是释放顺序必须由 finally 保证。
  function acquireRequestSlot(lease: MediaLease): MediaRequestSlot | null {
    // 并发检查与递增之间一旦出现远端 await，多请求会同时越过 per-lease 上限。
    if (lease.activeRequests >= maxConcurrentRequests) {
      logBusy(lease, "lease");
      return null;
    }
    lease.activeRequests += 1;
    if (options.requestLimiter && !options.requestLimiter.tryAcquire()) {
      lease.activeRequests -= 1;
      logBusy(lease, "host");
      return null;
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        lease.activeRequests = Math.max(0, lease.activeRequests - 1);
        options.requestLimiter?.release();
      },
    };
  }

  // lease 存活 = 实例未销毁 + scope 未换代 + 未过绝对过期 + 未超空闲期。
  // scopeKey 比对是刻意的冗余保险：即使调用方错误复用了实例，换 workspace/会话后旧 URL 也必须失效。
  function isLeaseAlive(lease: MediaLease, now = Date.now()): boolean {
    if (disposed || lease.scopeKey !== scopeKey || lease.expiresAt <= now) {
      return false;
    }
    return lease.lastAccessAt + idleTtlMs > now;
  }

  function removeLease(lease: MediaLease): void {
    leasesByToken.delete(lease.token);
    leasesByPreviewId.delete(lease.previewId);
  }

  function buildUrl(token: string): string {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Remote media preview proxy is not listening");
    }
    return `http://127.0.0.1:${address.port}${MEDIA_ROUTE_PREFIX}${token}`;
  }

  // 解析并校验真实路径：先 realpath 消解符号链接，再做 workspace 归属判断，
  // 避免「字面在 workspace 内、实际指向外部」的逃逸。
  // [失败路径] 先 resolvePath 消解符号链接，再判 workspace 归属，两步顺序不可交换。
  // [失败路径] 越界、格式不支持、非普通文件、超限四类拒绝都在写入 lease 之前抛出。
  // [事务] 返回的是解析后的真实路径，lease 与后续每次 stat 都沿用它。
  // [资源] 一次预览只在这里 stat 一次，请求期再从 lease.path 各自对账。
  // [权衡] 格式只在 prepare 判一次，请求期不再重复，靠 size 与 stat 兜住文件变化。
  async function resolveMediaPath(path: string): Promise<{
    path: string;
    mediaType: string;
    size: number;
  }> {
    const resolvedPath = await options.fileService.resolvePath({ path });
    if (!isPathWithinWorkspace(resolvedPath, options.scope.workspacePath)) {
      throw new Error("Media preview path is outside remote workspace");
    }
    const format = getMediaPreviewFormat(resolvedPath);
    if (!format) {
      throw new Error(`Unsupported media preview format: ${path}`);
    }
    const fileStat = await options.fileService.stat({ path: resolvedPath });
    if (fileStat.type !== "file" || typeof fileStat.size !== "number") {
      throw new Error(`Path is not a media file: ${path}`);
    }
    if (fileStat.size > maxFileBytes) {
      throw new Error(`Media file is too large for remote preview: ${path}`);
    }
    return { path: resolvedPath, mediaType: format.mediaType, size: fileStat.size };
  }

  // 生成一份新 lease 并返回播放描述；size 在此刻固化，后续请求都用它做一致性校验。
  // 失败语义：路径/格式/大小校验抛错时不写入任何 lease 表，调用方只会看到一次失败。
  async function prepare(params: {
    path: string;
    expectedKind: "video" | "audio";
  }): Promise<MediaPreviewPreparation> {
    const resolved = await resolveMediaPath(params.path);
    const format = getMediaPreviewFormat(resolved.path);
    if (!format || format.kind !== params.expectedKind) {
      throw new Error(`Unsupported media preview format: ${params.path}`);
    }
    await ensureListening();
    const now = Date.now();
    const lease: MediaLease = {
      previewId: randomUUID(),
      token: randomBytes(32).toString("hex"),
      path: resolved.path,
      mediaType: resolved.mediaType,
      size: resolved.size,
      scopeKey,
      expiresAt: now + ttlMs,
      lastAccessAt: now,
      activeRequests: 0,
      staleLogged: false,
    };
    leasesByToken.set(lease.token, lease);
    leasesByPreviewId.set(lease.previewId, lease);
    return {
      kind: "host-range-url",
      previewId: lease.previewId,
      mediaType: lease.mediaType,
      path: lease.path,
      size: lease.size,
      url: buildUrl(lease.token),
      urlExpiresAt: lease.expiresAt,
    };
  }

  // [事务] service 的 prepare 直接复用闭包内的同名函数，不另开一条发放路径。
  // [并发] 刷新先删旧 token 再写新 token，两步同属一次同步改写，中间没有可观测窗口。
  // [失败路径] 刷新时 lease 不存在或已失效，一律摘除并按过期报错，不复活旧凭据。
  // [事务] 刷新同时按 ttlMs 重置绝对过期，计时从刷新点重新开始。
  // [资源] release 只摘除记录，不关端口，端口生命周期由 dispose 独占管理。
  const service: IMediaPreviewService = {
    prepare,
    // 刷新即换 token：旧 URL 立即失效，避免长期有效的可播放地址被转发后无限期可用。
    async refreshPlaybackUrl({ previewId }) {
      const lease = leasesByPreviewId.get(previewId);
      if (!lease || !isLeaseAlive(lease)) {
        if (lease) removeLease(lease);
        throw new Error("Remote media preview lease expired");
      }
      const now = Date.now();
      leasesByToken.delete(lease.token);
      lease.token = randomBytes(32).toString("hex");
      leasesByToken.set(lease.token, lease);
      lease.lastAccessAt = now;
      lease.expiresAt = now + ttlMs;
      return { url: buildUrl(lease.token), expiresAt: lease.expiresAt };
    },
    async release({ previewId }) {
      const lease = leasesByPreviewId.get(previewId);
      if (lease) removeLease(lease);
    },
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeError(response, error instanceof Error ? error.message : String(error), 500);
    });
  });

  return {
    service,
    async dispose() {
      if (disposed) return;
      disposed = true;
      leasesByToken.clear();
      leasesByPreviewId.clear();
      if (!listeningPromise) return;
      await listeningPromise.catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  async function ensureListening(): Promise<void> {
    if (!listeningPromise) {
      listeningPromise = listen(server);
    }
    await listeningPromise;
  }

  // 请求入口：token 校验 -> Range 解析 -> 限流 -> 一致性校验 -> 分块输出。
  // 所有失败分支都通过 writeError 结束响应；一旦开始写 body，后续异常只能 destroy。
  // [事务] 管线顺序固定：路由前缀、方法、token 与存活、Range、限流、一致性、分块输出。
  // [失败路径] 非前缀路径回 404，非 GET 或 HEAD 回 405 并带 Allow，都在取 token 之前。
  // [事务] token 取自路径剩余段，查表即鉴权，不做宽松匹配也不回退到登录态。
  // [失败路径] 非法 Range 回 416 并带总长，客户端可据此重取正确区间。
  // [事务] 缺省 Range 补成整段，空文件长度归零，HEAD 与空体在写头后立即结束。
  // [资源] finally 移除 aborted 监听并释放槽位，异常路径也不留配额。
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!requestUrl.pathname.startsWith(MEDIA_ROUTE_PREFIX)) {
      writeError(response, "Not found", 404);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      writeError(response, "Method not allowed", 405);
      return;
    }
    const token = requestUrl.pathname.slice(MEDIA_ROUTE_PREFIX.length);
    const lease = leasesByToken.get(token);
    if (!lease || !isLeaseAlive(lease)) {
      if (lease) removeLease(lease);
      logExpired();
      writeError(response, "Media preview lease expired", 404);
      return;
    }
    const range = parseRange(request.headers.range, lease.size);
    if (range === "invalid") {
      response.setHeader("Content-Range", `bytes */${lease.size}`);
      writeError(response, "Invalid media range", 416);
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, lease.size - 1);
    const length = lease.size === 0 ? 0 : end - start + 1;
    const requestSlot =
      request.method === "GET" && length > 0 ? acquireRequestSlot(lease) : undefined;
    if (request.method === "GET" && length > 0 && !requestSlot) {
      response.setHeader("Retry-After", "1");
      writeError(response, "Too many media range requests", 429);
      return;
    }
    let aborted = false;
    const markAborted = () => {
      aborted = true;
    };
    request.once("aborted", markAborted);
    response.once("close", () => {
      if (!response.writableFinished) markAborted();
    });
    try {
      // 写头之前先校验文件未变化：一旦 headersSent 就无法再回 409，只能截断连接。
      const currentStat = await options.fileService.stat({ path: lease.path });
      if (currentStat.type !== "file" || currentStat.size !== lease.size) {
        removeLease(lease);
        logStale(lease);
        writeError(response, "Remote media file changed during preview", 409);
        return;
      }
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": "inline",
        "Content-Length": String(length),
        "Content-Type": lease.mediaType,
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${lease.size}`;
      response.writeHead(range ? 206 : 200, headers);
      lease.lastAccessAt = Date.now();
      if (request.method === "HEAD" || length === 0) {
        response.end();
        return;
      }

      let offset = start;
      while (!aborted && offset <= end) {
        const requestedLength = Math.min(chunkBytes, end - offset + 1);
        const chunk = await options.fileService.readFileRange({
          path: lease.path,
          offset,
          length: requestedLength,
        });
        if (chunk.length !== requestedLength) {
          removeLease(lease);
          logStale(lease);
          throw new Error("Remote media source changed during requested range");
        }
        offset += chunk.length;
        const buffer = Buffer.from(chunk);
        const accepted = options.writeChunk
          ? options.writeChunk(response, buffer)
          : response.write(buffer);
        if (!accepted) {
          const drainState = await waitForDrainOrDisconnect(request, response);
          if (drainState === "closed") {
            aborted = true;
            options.logger?.debug("media-preview.range CLOSED", { scopeKey });
            break;
          }
        }
      }
      if (!aborted) {
        const completedStat = await options.fileService.stat({ path: lease.path });
        if (completedStat.type !== "file" || completedStat.size !== lease.size) {
          removeLease(lease);
          logStale(lease);
          throw new Error("Remote media file changed during preview");
        }
        response.end();
      }
    } catch (error) {
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    } finally {
      request.removeListener("aborted", markAborted);
      requestSlot?.release();
    }
  }
}
