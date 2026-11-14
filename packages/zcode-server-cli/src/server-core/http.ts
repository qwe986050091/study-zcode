// Core HTTP 入口：同一 Hono app 上混布 REST 探活、host capability 签发与两条 WebSocket 升级路径。
// 两条升级路径信任级别不同：/ws 面向 Web 与手机 replayable 客户端，/ws/host 面向受信 Desktop Host relay。
// 本文件只负责协议入口与连接生命周期，业务状态由 ServiceCollection 中的服务经 ChannelServer 暴露。
// 以下 INV 为入口不可回退的不变量，破坏任一条都会让远端连接、鉴权或关停语义错乱。
// INV-01 非 loopback host 必须 fail-closed 拒绝启动；守住位置：createCoreHttpServer 的 host 校验；改错故障：未鉴权的 Core 端口暴露到局域网，任意进程可接管 Agent 会话。
// INV-02 配置 ingressToken 后除只读探活外所有请求必须先过鉴权；守住位置：app.use 通配中间件；改错故障：workspace 列表与 RPC 频道对未认证方开放。
// INV-03 token 比较必须走常量时间比较且长度先行短路；守住位置：authenticated 表达式；改错故障：比较耗时泄漏 token 前缀，可被逐字节爆破。
// INV-04 /ws/host 的 host capability 一次性消费，失败返回 401 且不得继续升级；守住位置：/ws/host 中间件；改错故障：capability 可重放，桌面 relay 通道被第三方复用。
// INV-05 capability 必须带 TTL，不可退化为裸 Set 永久有效；守住位置：createHostCapabilityStore 装配点；改错故障：未消费的 capability 长期累积且永不失效。
// INV-06 Provisioning envelope 只能下发给 desktop-continuous 连接；守住位置：IProviderProvisioningTargetService 覆盖分支；改错故障：Web 与手机客户端可把跨 Environment 凭据写入本机 Source Server。
// INV-07 /ws 固定按 web-remote-replayable 建 scope，/ws/host 固定按 desktop-continuous；守住位置：两处 upgradeWebSocket 的 onOpen；改错故障：恢复链路被当成实时链路，snapshot 与 queue 语义互相污染。
// INV-08 反向资源通道出入参必须双向过 workspaceIdentityMapper；守住位置：resourceChannel 包装；改错故障：同一 attachment 被判成跨工作区请求并被 registry 拒绝。
// INV-09 每条 WebSocket 的释放顺序为 peer、reverseClient、scope、rawServer，且只执行一次；守住位置：socket.onClose 回调；改错故障：重复释放抛错或通道残留，Supervisor 收不到关停确认。
// INV-10 关停先发 close 帧再限时强制终止，总预算不得超过 WEBSOCKET_DRAIN_TIMEOUT_MS；守住位置：closeWebSocketServer；改错故障：活跃 desktop 连接让关闭永不回调，进程卡死。
// INV-11 必须等 HTTP server 关闭完成后才 resolve CoreHttpServer.close；守住位置：返回对象的 close 闭包；改错故障：调用方以为端口已释放，重启时端口占用冲突。
// INV-12 端口必须等 serve 回调读到真实 address 才 resolve；守住位置：resolveListening 与 listening Promise；改错故障：port 为 0 时把 0 当实际端口返回给调用方。
// INV-13 写 WS 前必须校验 readyState 为 OPEN，否则丢弃该帧；守住位置：wrapWebSocket 的 write；改错故障：向已关闭连接发送触发异常并打断整条 RPC 流。
// INV-14 WS 的 close 与 error 都必须转成 onClose 与 onEnd 事件；守住位置：wrapWebSocket 的事件绑定；改错故障：网络异常时 scope 不回收，服务端会话泄漏。
// INV-15 未通过鉴权的请求只返回 401 或脱敏探活信息，不回显 token 与内部错误；守住位置：通配中间件的两个 return 分支；改错故障：错误响应成为枚举探测面。
// INV-16 query token 仅在 Bearer 缺失时回退，Bearer 优先；守住位置：candidate 取值；改错故障：错误的 Bearer 头被合法 query token 静默覆盖，鉴权语义不可预期。
// INV-17 server-info 的 authRequired 必须与实际是否配置 ingressToken 一致；守住位置：info 构造处的布尔取值；改错故障：客户端误判无需鉴权，握手阶段才被 401。
// INV-18 未鉴权的探活只返回 version、protocolVersion、compatibility；守住位置：path 判断分支；改错故障：workspaces、identity、capabilities 等内部信息外泄。
// INV-19 所有频道覆盖必须在 exposeOnChannelServer 之前装配完成；守住位置：exposeWebSocket 尾部；改错故障：覆盖失效，客户端拿到原始服务或抛错 stub。
import { scopeConversationShareServiceForAttachment } from "@zcode/services/node";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  Event,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
  type IChannel,
  type CancellationToken,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IProviderProvisioningTargetService,
  IZCodeAgentService,
  IConversationShareService,
  ServiceCollection,
} from "@zcode/services";
import {
  createServiceLogger,
  type TopicResourcePeers,
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  serverRemoteInfoOutputSchema,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";

// [权衡] 对外只暴露 host、port 与 close，把底层 server 与 wss 封在闭包里，调用方无法绕过既定关停顺序。
// [资源] close 不做幂等保护，二次调用会把 ERR_SERVER_NOT_RUNNING 冒泡给调用方，关停责任归调用方。
// [失败路径] close 任一步 reject 都意味着端口或连接未完全释放，Supervisor 会判定关停失败并重试。
// [并发] 接口本身无状态，多个调用方共享同一实例即共享同一条关停边界与同一份资源。
export interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

// [权衡] 250ms 是排空窗口上限，太长拖延关停预算，太短则正常客户端来不及收到 close 帧。
// [并发] 该预算只约束排空阶段，强制终止与 wss 关闭不计入，最坏关停耗时仍可预期。
// [失败路径] 窗口内未排空的连接不会被继续等待，直接进入强制终止，客户端只能观察到异常断开。
const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

// [资源] 本函数是 WebSocket 资源的唯一释放出口，close 帧广播与 wss 关闭在这里串行完成。
// [失败路径] 先广播再轮询计数，客户端不响应则降级强制终止，保证函数必然返回而不是挂死。
// [并发] 轮询期间仍可能有新连接进入 clients，deadline 到期后统一终止覆盖这部分增量。
// [资源] wss 关闭是异步回调，未等待它完成就让进程退出会留下未释放的监听句柄。
async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  // [失败路径] 排空超时后强制终止，丢弃未发送缓冲区，换取关停时间的确定性。
  // [资源] 强制终止立即释放 socket 句柄且不等待对端 FIN，避免半开连接长期占用文件描述符。
  // [权衡] 宁可打断进行中的 RPC 帧也要守住关停预算，缺失的帧由客户端 replay 链路补偿。
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

// [失败路径] 只认 127.0.0.1、::1、localhost 三个字面量，不做 DNS 解析，避免 0.0.0.0 或主机名被误判为本机。
// [权衡] 采用白名单而非黑名单，新增的回环别名默认被拒，必须显式放行才能监听。
// [失败路径] 先 trim 再小写但不剥离 IPv6 方括号，[::1] 形式会被判为非回环并触发启动失败。
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

// [资源] 每个 ws 连接一组 Emitter，close 与 error 共用同一 onClose 事件，避免上层出现两套收尾路径。
// [失败路径] 二进制帧统一包成 VSBuffer，非 Buffer 的 ArrayBuffer 会被复制，防止与底层共享可变内存。
// [资源] drain 恒立即完成，因为 ws 不暴露背压信号，缓冲压力实际由内核发送队列承担。
// [权衡] end 与 dispose 都映射到 ws 关闭，语义差异留给上层，底层不做额外区分。
function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      // [失败路径] 非 OPEN 状态直接丢帧而不抛错，避免关停竞态把异常冒泡成整条 RPC 流中断。
      // [并发] 状态判断与发送之间仍有竞态，仍可能抛错，最终由 error 事件统一收敛到关闭路径。
      // [权衡] 选择丢弃而非排队，无界发送队列会在慢客户端上耗尽进程内存。
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

// [并发] 每条连接建独立的 SocketProtocol 与 ChannelServer，协议状态不跨连接共享。
// [资源] scope、reverseClient、rawServer 的释放全部挂在 onClose，禁止在其它位置二次释放。
// [失败路径] agentService 缺失时 scope 为 undefined，Agent 频道不注入覆盖，客户端调用得到未注册错误。
// [事务] 频道覆盖在 exposeOnChannelServer 时一次性生效，连接存续期内不再变更，保证视图一致。
function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const loggedServer = new LoggingChannelServer(rawServer, (...args) =>
    log.debug(undefined, ...args),
  );
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const rawResourceChannel = reverseClient?.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL);
  // Source 内部 route 已 canonicalize；反向请求必须还原 Desktop 的 stable identity，
  // 否则同一 attachment 会被 registry 判成跨工作区请求。
  // [事务] 反向调用先映射出参再映射入参，出入参成对转换，缺一半会导致身份视图错位。
  // [失败路径] mapper 缺失时退化为原始通道，不做隐式转换，保证旧调用方行为不变。
  // [资源] 包装层闭包捕获原始通道与 mapper，通道释放统一由 reverseClient 负责。
  const resourceChannel: IChannel | undefined =
    rawResourceChannel && workspaceIdentityMapper
      ? {
          async call<T>(command: string, args?: unknown, token?: CancellationToken) {
            const result = await rawResourceChannel.call<T>(
              command,
              workspaceIdentityMapper.mapOutgoing(args),
              token,
            );
            return workspaceIdentityMapper.mapIncoming(result);
          },
          listen<T>(event: string, args?: unknown) {
            return Event.map(
              rawResourceChannel.listen<T>(event, workspaceIdentityMapper.mapOutgoing(args)),
              (value) => workspaceIdentityMapper.mapIncoming(value),
            );
          },
        }
      : rawResourceChannel;
  const peer = resourceChannel ? resourcePeers?.attach(resourceChannel) : undefined;
  const connectionContext = {
    connectionId: `server-core-ws-${randomUUID()}`,
    clientMode,
    role:
      clientMode === "desktop-continuous"
        ? ("trusted-host-relay" as const)
        : ("terminal-client" as const),
  };
  const scope = agentService
    ? createZCodeAgentConnectionScope(
        peer ? peer.wrapAgent(agentService) : agentService,
        connectionContext,
      )
    : undefined;
  const overrides = new Map<string, unknown>();
  if (scope) {
    overrides.set(IZCodeAgentService.channelName, scope.service);
  }
  const shareService = services.getOptional(IConversationShareService);
  if (shareService) {
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        shareService,
        clientMode,
        scope?.service,
        connectionContext,
      ),
    );
  }
  // Provisioning envelope 携带跨 Environment 的 Personal 配置与凭据，只允许受信 Desktop Host
  // 通过 /ws/host 下发；/ws 上的 Web / 手机 replayable 客户端即使知道频道名，也只能拿到抛错 stub，
  // 不能把凭据写进本 Source Server。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    // [失败路径] 非 desktop-continuous 连接拿到的 apply 是抛错 stub，任何凭据写入都在调用点明确失败。
    // [事务] 写入被拒时不产生部分状态，服务端不会留下半配置的 provider。
    // [权衡] 用频道级 stub 而非路由层拒绝，让错误落在具体调用点，便于客户端定位。
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  // [资源] 释放顺序 peer、reverseClient、scope、rawServer 不可调换，先断反向通道再销毁协议栈。
  // [并发] scope 的释放返回 Promise 但此处不等待，错误不会回灌到关闭回调。
  // [失败路径] 任一释放步骤抛错都会中断后续步骤，rawServer 残留会导致频道监听泄漏。
  // [事务] 该回调是连接内所有资源的统一释放入口，新增资源必须挂到这里而非分散关闭。
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    ingressToken?: string;
    migrationFailedPathCount?: number;
    hostCapabilityStore?: HostCapabilityStore;
    workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
    topicResourcePeers?: TopicResourcePeers;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  // [并发] 必须在注册任何 /ws 路由之前创建，升级处理器依赖同一 wss 实例注入连接。
  // [失败路径] 若顺序颠倒，升级请求拿不到 wss，握手会挂起直到客户端超时。
  // [权衡] 复用既有 Hono app 作为升级载体，避免再起第二个 HTTP server 与第二套生命周期。
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    // R2 当前只有本机/SSH 隧道入口，Core 尚未接入 token middleware；对外监听必须 fail-closed。
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  const ingressToken = options.ingressToken?.trim();
  const info: ServerRemoteInfo = serverRemoteInfoOutputSchema.parse({
    serverId: options.serverId ?? hostname() ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: Boolean(ingressToken),
    workspaces: [],
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: userInfo().username, hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      virtualProjects: true,
      processResourceTelemetry: true,
    },
  });
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  // [并发] 中间件对每个请求独立求值，token 比较无共享可变状态，可安全并发执行。
  // [失败路径] 未配置 ingressToken 时直接放行，回环地址下的信任模式一旦配置即改变全局安全边界。
  // [事务] 只有鉴权通过才调用下一环，后续路由不会看到未认证上下文。
  // [资源] 不缓存解析结果，每请求重建 URL 与 Buffer，用少量分配换取鉴权正确性。
  app.use("*", async (context, next) => {
    if (!ingressToken) {
      await next();
      return;
    }
    const authorization = context.req.header("authorization");
    const bearerToken = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
    const queryToken = new URL(context.req.url).searchParams.get("token")?.trim();
    const candidate = bearerToken || queryToken;
    // [权衡] 长度不等时短路为 false，避免常量时间比较在长度不一致时抛异常。
    // [失败路径] candidate 为空时根本不进入比较分支，未认证请求不会触达比较逻辑。
    // [并发] 每请求新建 Buffer 而不复用可变缓冲，杜绝跨请求的缓冲串扰。
    const authenticated = candidate
      ? (() => {
          const expected = Buffer.from(ingressToken);
          const received = Buffer.from(candidate);
          return expected.length === received.length && timingSafeEqual(expected, received);
        })()
      : false;
    if (authenticated) {
      await next();
      return;
    }
    // [失败路径] 未鉴权只回最少的服务发现字段，供客户端判断是否需要登录。
    // [事务] 该分支在 401 之前返回，是整条鉴权链上唯一的白名单出口。
    // [并发] 白名单按 path 精确匹配而非前缀匹配，防止后缀变体绕过鉴权。
    if (context.req.path === "/api/server-info") {
      return context.json({
        version: info.version,
        protocolVersion: info.protocolVersion,
        authRequired: true,
        compatibility: info.compatibility,
      });
    }
    // [失败路径] 统一 401 且不区分缺失、错误与过期，避免响应差异成为 token 枚举探测面。
    // [事务] 该 return 终止中间件链，后续业务路由不会被执行。
    // [权衡] 不返回认证质询头，鉴权方式由客户端配置决定而非运行时协商。
    return context.json({ error: "Ingress authentication required" }, 401);
  });
  app.get("/api/server-info", (context) => context.json(info));
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(
          socket.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );
  // [失败路径] capability 校验失败直接 401，升级不会发生，避免产生半开 WebSocket。
  // [并发] 先消费后放行，校验与升级之间没有重放窗口。
  // [事务] 消费是一次性语义，同一 capability 的第二次请求必然失败。
  // [资源] 该中间件只作用于 /ws/host，不影响 /ws 与 REST 路由的鉴权路径。
  app.use("/ws/host", async (context, next) => {
    const capability = context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!capabilities.consume(capability)) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(
          socket.raw as WebSocket,
          services,
          "desktop-continuous",
          options.workspaceIdentityMapper,
          options.topicResourcePeers,
        );
      },
    })),
  );
  // [失败路径] 该端点无独立鉴权，安全性完全依赖全局 ingressToken 中间件，新增白名单时必须排除它。
  // [资源] 每次签发产生一条带过期时间的记录，未消费记录由 TTL 机制清理。
  // [权衡] 使用 POST 而非 GET，避免 capability 被中间代理或访问日志缓存。
  app.post("/api/rpc-host-capability", (context) => context.json(capabilities.issue()));
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    // [资源] 先关 WebSocket 再关 HTTP，反序会让升级连接成为无主的孤儿句柄。
    // [失败路径] WebSocket 关闭抛错时 HTTP server 不会被关闭，端口持续被占用。
    // [事务] 两个 await 串行执行而非并发关闭，避免回调与事件在关闭过程中交错。
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
