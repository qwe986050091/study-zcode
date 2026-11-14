/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
// 文件职责：ZCode Server 的 HTTP/WebSocket 唯一入口，只装配传输层——Hono 应用、路由表、
// 鉴权与能力中间件、静态资源解析、WS→RPC 通道挂载。任务/会话/Bot 等业务状态全部由
// services 层持有，本文件不持有状态，只把一次请求翻译成一次服务调用或一段静态字节。
//
// 职责边界外：RPC 流控与重放归 SocketProtocol/ChannelServer；Provider 载荷解析归
// IBotsService；除 staticRoot 之内，本文件不做任何文件系统读取；鉴权只做 token 等值
// 比较，不实现账号体系、不落盘会话。
//
// INV 表（每条断言只由一处代码守住；改那一处就会产生右侧故障）：
// INV-01 断言：鉴权开启时 /api 与 /ws 前缀必须携带有效 token，Authorization、URL 查询串与 Cookie 均算凭证 —— 守住它的位置：isTokenProtectedPath + hasValidLiteToken + 全量 app.use 中间件 —— 改错故障：未授权客户端可读 server-info 或直接建立 RPC 通道。
// INV-02 断言：未配置 token 时整条鉴权中间件不注册，开放路径集合保持本机默认 —— 守住它的位置：createHttpServer 中的 if (authToken) —— 改错故障：本地开发被 401 拦死，或鉴权被静默降级。
// INV-03 断言：/ws 恒为 web-remote-replayable，任何请求头都不能把连接提升为受信主机 —— 守住它的位置：app.get("/ws") 中硬编码的 clientMode —— 改错故障：浏览器侧获得 provisioning 写入能力。
// INV-04 断言：/ws/host 先消费一次性 capability 再允许升级，消费失败即 401 —— 守住它的位置：app.use("/ws/host") 注册在 app.get("/ws/host") 之前 —— 改错故障：capability 可重放，受信链路被任意客户端建立。
// INV-05 断言：非 desktop-continuous 客户端拿到的 provisioning 服务只会抛错 —— 守住它的位置：setupChannelServer 中的 overrides 覆盖 —— 改错故障：Web 端获得跨 Environment 凭据写入口。
// INV-06 断言：连接关闭时 peer、反向客户端、connectionScope、rawServer 全部释放且各只释放一次 —— 守住它的位置：socket.onClose 回调 —— 改错故障：WS 重连累积泄漏 agent scope 与通道处理器。
// INV-07 断言：静态资源解析结果必须位于 staticRoot 之内，跨盘 relative 为绝对路径同样拒绝 —— 守住它的位置：resolveStaticFile 中两处 isInsideDirectory —— 改错故障：Windows 上可越盘读取任意文件。
// INV-08 断言：盘符限定路径在 path.resolve 之前即拒绝，且不进入 SPA fallback —— 守住它的位置：isPathDriveQualified 调用早于 resolve —— 改错故障：subst 虚拟盘或映射网络盘被解析到静态根之外。
// INV-09 断言：SPA fallback 只服务非 /api、非 /ws 路径 —— 守住它的位置：isStaticFallbackAllowed —— 改错故障：未知 API 路径返回 index.html 而非 404。
// INV-10 断言：错误响应只含稳定短句，不回传异常对象、堆栈或内部路径 —— 守住它的位置：各 handler 内的字面量 c.json —— 改错故障：内部实现细节经 HTTP 泄漏。
// INV-11 断言：Bot 回调的 400/401/503 与服务层 status 一一透传，不得折叠为 200 —— 守住它的位置：handleBotCallback 末尾的分支链 —— 改错故障：provider 误判消息已消费，丢失重试。
// INV-12 断言：静态文件缺失或越界统一 404，异常不外抛到 Hono 默认错误页 —— 守住它的位置：resolveStaticFile 返回 null 与 c.notFound() —— 改错故障：路径或权限信息出现在响应体。
//
// 阅读顺序：createHttpServer 内的注册顺序即中间件执行顺序，自上而下阅读不会跳步。
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import * as nodePath from "node:path";
import { basename, extname, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { TopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IBotsService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  botProviders,
  formatLogPrefix,
  serverRemoteInfoOutputSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_COMPATIBILITY_MANIFEST,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import {
  SourceServerWorkspaceIdentityChannelServer,
  type SourceServerWorkspaceIdentityMapper,
} from "@zcode/services/node";
import { createHostCapabilityStore } from "./hostCapability.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  // [资源] close 与 error 都成对触发 onClose/onEnd：上游 ChannelServer 只在关闭事件里
  // 结算挂起请求，少发一次 onEnd 会让调用方永久等待；宁可重复触发，由订阅方各自幂等。
  // 不在此处调用 ws.close()，关闭语义留给 dispose/end，避免关闭路径重入。
  // 触发器只转发事件，不做日志，保持与 onData 对称。
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    // [失败路径] 发送前必须检查 readyState：已关闭连接上 ws.send 会抛错，而 ISocket.write
    // 契约没有返回值；这里选择静默丢弃，让失败以随后的 onClose/onEnd 呈现，而不是让
    // 一次心跳帧把主循环打断。只发 buffer 本身，编码交由上层 ChannelServer 负责。
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper,
  resourcePeers?: TopicResourcePeers,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  // [契约] 日志中间件包在原生 ChannelServer 之外，只观测调用与耗时，不改变消息顺序，
  // 也不吞异常；因此它必须紧贴 rawServer，identity 包装再套在外层，保证日志记录的是
  // 客户端真实频道名，而不是身份改写后的结果。
  const loggedServer = new LoggingChannelServer(rawServer, log);
  // [契约] 有身份映射时在日志层外再包一层 SourceServerWorkspaceIdentityChannelServer：
  // 所有频道请求先经 identity 归一化再落到业务服务；映射器缺省时直接使用日志层，
  // 不构造空实现，避免两条等价装配路径并存。
  const server = workspaceIdentityMapper
    ? new SourceServerWorkspaceIdentityChannelServer(loggedServer, workspaceIdentityMapper)
    : loggedServer;
  const agentService = services.getOptional(IZCodeAgentService);
  // [权衡] 只有 desktop-continuous 且拿到 resourcePeers 时才建立反向 ChannelClient：这是
  // 桌面 Host 把自身资源变更回灌给 Server 的单向通道。Web 端 replayable 不建该通道，
  // 因为它没有常驻 Host 可代理；误建会让 peer.attach 挂到不存在的对端，并泄漏一个
  // 复用通道处理器。
  const reverseClient =
    clientMode === "desktop-continuous" && resourcePeers ? new ChannelClient(protocol) : undefined;
  const peer = reverseClient
    ? resourcePeers?.attach(reverseClient.getChannel(TOPIC_RESOURCE_RELAY_CHANNEL))
    : undefined;
  // [资源] 每个连接一个 agent connectionScope，用随机 connectionId 标识（server-ws-uuid），
  // role 由 clientMode 决定：trusted-host-relay 与 terminal-client 不可互换。scope 只在
  // socket.onClose 中 dispose 一次，禁止在错误分支提前释放，否则同一连接上的后续请求
  // 会拿到已销毁的服务引用。
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(peer ? peer.wrapAgent(agentService) : agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // [契约] Provisioning 服务携带跨 Environment 凭据，只对 Desktop trusted host 开放。覆盖
  // 发生在 expose 之前，用同名频道注入一个只会抛错的对象，而不是删除频道：客户端得到
  // 明确的拒绝信息，也不必知道该频道在 Web 端是否存在。不要放宽为按请求头判断，请求
  // 头是客户端可伪造的。
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  // [契约] overrides 与服务的装配集中在这一处完成，键为频道名；同名频道以 overrides
  // 为准。不要在别处再 expose 同一频道，否则后注册者会静默覆盖前者。此后 server 不再
  // 变更，生命周期与 rawServer 一致。
  services.exposeOnChannelServer(server, overrides);
  // [资源] 释放顺序：先断 peer（可能持有 agent 包装），再断反向客户端，最后 dispose scope
  // 与 rawServer。先关上游再关下游，避免 dispose 过程中仍向已关闭的 socket 写数据。
  // connectionScope.dispose 为异步，用 void 显式丢弃结果；它不得抛出，否则后续清理会
  // 被中断。
  socket.onClose(() => {
    peer?.dispose();
    reverseClient?.dispose();
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

export interface HttpServerOptions {
  topicResourcePeers?: TopicResourcePeers;
  serverId?: string;
  virtualProjects?: boolean;
  migrationFailedPathCount?: number;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function resolveHttpServerId(options: HttpServerOptions = {}): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

// [契约] server-info 每次请求重新构造并经 zod schema 解析：字段缺失或类型漂移会在
// 此处立即失败，而不是把畸形 JSON 发给客户端。identity 只暴露系统用户名与主机名。
function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return serverRemoteInfoOutputSchema.parse({
    serverId: resolveHttpServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    compatibility: ZCODE_COMPATIBILITY_MANIFEST,
    migration: { failedPathCount: options.migrationFailedPathCount ?? 0 },
    identity: { osUser: userInfo().username, hostname: hostname() },
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      ...(options.virtualProjects ? { virtualProjects: true } : {}),
      processResourceTelemetry: true,
    },
  });
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

// [契约] token 有三个来源且优先级固定：Authorization: Bearer 头、URL 查询参数、Cookie。
// 查询参数命中时种下 HttpOnly + SameSite=Lax 的 Cookie，供后续静态与 WS 请求复用；
// 三者均为等值比较，token 是本地随机串而非用户口令，无需恒定时间比较。
function hasValidLiteToken(c: Context, token: string): boolean {
  const authorization = c.req.header("authorization");
  if (
    authorization?.startsWith("Bearer ") &&
    authorization.slice("Bearer ".length).trim() === token
  ) {
    return true;
  }
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

// [契约] 受保护前缀集中在此一处判定：/ws、/ws/*、/api/*；新增接口只要挂在 /api 下便
// 自动受保护。不要在各 handler 内重复判断 token，那会产生漏保护的分支。
function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

// 盘符路径（"Z:/x"、"Z:\x"、"Z:x"）在 Windows 的 path.resolve 下会被当作绝对/盘符相对
// 路径解析到另一块盘（含 subst 虚拟盘与映射的网络盘），一律拒绝，不做静态资源解析。
const DRIVE_QUALIFIED_PATH_PATTERN = /^[a-zA-Z]:/;

export function isPathDriveQualified(pathname: string): boolean {
  return DRIVE_QUALIFIED_PATH_PATTERN.test(pathname);
}

// pathApi 可注入便于跨平台测试。Windows 跨盘时 path.relative 返回的是绝对路径（如
// "Z:\marker.txt"），不以 ".." 开头，曾因此被误判为「在静态根内」导致越盘读取；
// relative 结果为绝对路径的一律视为越界，posix 语义不受影响。
export function isInsideDirectory(
  root: string,
  candidate: string,
  pathApi: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const diff = pathApi.relative(root, candidate);
  if (pathApi.isAbsolute(diff)) return false;
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${pathApi.sep}`));
}

// [契约] 解析顺序固定：先拒绝盘符限定路径，再 resolve 并做根内检查，再 stat；目录则
// 追加 index.html 并再次做根内检查。SPA fallback 是最后一步，且只对非 /api、非 /ws
// 路径生效。任何一步失败都返回 null，由调用方统一 404。
async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  // 盘符路径必须在 resolve 之前拦截（含 %3A 解码后的形式），否则 Windows 上会解析到
  // 静态根所在盘之外的路径；直接 404，也不进入 SPA fallback。
  if (isPathDriveQualified(relativePath)) {
    return null;
  }
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  // [契约] 鉴权是启动期决策：只有显式 token 才注册中间件，未配置时保持本机开放语义。
  // 不在请求期回读环境变量，避免运行中环境变化造成两套判断；trim 后空串等同未配置。
  // [边界] 布尔变量只决定是否调用 app.get 注册路由；注册与否不改变已有路由的匹配结果。
  const authToken = options.authToken?.trim();
  if (authToken) {
    // [契约] 全量中间件，顺序固定：先解析 pathname，再校验 token，最后才决定是否放行。
    // 保护范围由 isTokenProtectedPath 决定（/ws、/ws/*、/api/*），其余路径（静态资源、
    // SPA 入口）公开。鉴权失败立刻返回 401 且不再 next()，不能让请求继续落到业务路由或
    // 静态 catch-all。
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      // [失败路径] 401 响应只含固定字符串 Unauthorized：不回传期望 token，也不区分“缺 token”
      // 与“token 错误”，避免成为探测接口；不写 WWW-Authenticate，防止浏览器弹出原生登录框
      // 干扰 SPA。
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  // [契约] server-info 是只读探测接口，返回 serverId、版本、能力清单与 workspace 列表，
  // 不返回 token 或文件系统细节；能力位只声明本进程真实支持的特性，客户端据此决定
  // 是否尝试 /ws/host 或虚拟项目。
  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  // [权衡] /api/server-info 与 /api/rpc-host-capability 同处 /api 前缀，因此都受上面的
  // 鉴权保护；后者每次调用签发一次性 capability，不落盘、不缓存。若把它改成 GET 或
  // 允许复用，就等于把受信主机的提升令牌暴露在 URL 与访问日志里。
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // [契约] /ws 的 clientMode 写死为 web-remote-replayable，即便客户端伪造旧的 mode 头
  // 也不会被提升为 trusted host；受信链路只能走 /ws/host 且必须持有效 capability。
  // 此处不读取任何请求头做分支，避免出现两套升级语义。
  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          options.workspaceIdentityMapper,
        );
      },
    })),
  );

  // [契约] 受信主机升级器提前构造一次并复用，onOpen 时才绑定 services 与 topicResourcePeers；
  // 它与 /ws 的差别只在 clientMode 与反向通道，RPC 协议本身完全一致。不要为它另建协议
  // 栈，否则两端行为会分叉。
  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(
        ws.raw as WebSocket,
        services,
        "desktop-continuous",
        options.workspaceIdentityMapper,
        options.topicResourcePeers,
      );
    },
  }));
  // [契约] 顺序即安全边界：capability 的 use 必须先于 get 注册，Hono 按注册顺序执行，
  // consume 成功才 next() 进入升级。capability 一次性，被消费后立即失效，失败返回 401；
  // 不在此处回退为 token 校验，两条凭据不可互相替代。升级失败时连接不被接管，也不产生
  // RPC 会话。
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // [契约] 两个入口（带/不带 botId）共用同一 handler：先做 provider 白名单校验，再确认
  // 该 provider 支持 HTTP 回调，最后才取服务。顺序不能调换，未知 provider 必须先 400，
  // 否则会被 503 掩盖路由错误。
  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    // [资源] 读取前没有字节上限：c.req.text() 会把整个 body 读进内存，这是已知取舍——回调
    // 只经 provider 网关，超限保护依赖前置代理，本层不重复实现。读取失败按空串处理，交给
    // 服务层判断签名，避免把解析异常变成 500。
    // [权衡] JSON 解析失败时降级为 { payload } 而非拒绝，以保留第三方非 JSON 回调能力。
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    // [失败路径] status 逐一显式映射，不做区间或默认透传：400/401/503 各对应服务层的确定
    // 语义，其余一律 200。503 尤其不能折叠成 200，否则 provider 认为消息已消费、不再
    // 重试，效果等同提前提交 offset。
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // Bug 原因：旧 `/api/connect-remote` + `/ws/remote/:id` 会在 Server 内另起临时 stdio
  // runtime，绕过 R3 的 Window Host → Source Server attachment 主链；两个入口必须一起不可达。

  // [契约] 只有配置了 staticRoot 才注册 catch-all：无静态资源时不注册 *，让未知路径走
  // Hono 默认 404，而不是被空实现吞掉。catch-all 注册在最后，确保 /api 与 /ws 优先匹配；
  // 它本身落在鉴权中间件的公开集合内，是否允许 SPA 回退由 resolveStaticFile 自己判断。
  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      // [失败路径] 解析不到文件统一 notFound()，不区分“不存在”“越界”“盘符路径”：三者回
      // 同一个 404，避免用响应码做侧信道探测静态根之外的文件是否存在。也不回退到其他
      // 目录重试，失败即终止本次请求。
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        // [权衡] index.html 用 no-cache，其余带内容哈希的产物用一年 immutable：前者保证发布后
        // 立即拿到新入口，后者让浏览器不再回源。判断依据只有文件名，不读 content hash，
        // 因此未哈希的资源若沿用同名会被浏览器长期缓存，需改名发布。
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  // [契约] 端口以实际监听地址为准回填日志：port 传 0 时由系统分配，不能用入参打印。
  // host 缺省显示 localhost；监听回调只写一行启动日志，不在此处初始化业务。返回值
  // server 交给调用方与 injectWebSocket 共用，不在此处 close。
  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  // [并发] 必须在 serve 返回 server 之后注入 WS 升级处理：Hono 的 fetch 只处理普通请求，
  // 升级事件挂在 Node server 上。注入晚于 listen 也安全，但早于 app 路由装配完成会让
  // 升级回调引用未注册的路径。
  injectWebSocket(server);

  return server;
}
