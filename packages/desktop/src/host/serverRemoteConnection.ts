// INV-01 [事务] 端点归一固定在 resolveServerRemoteEndpoints：先由 stripWebSocketEndpointPath 剥掉结尾的 /ws 与 /ws/host，再拼固定路径；删掉剥离会出现 /ws/ws 与 /ws/host/ws/host，握手阶段直接 404。
// INV-02 [失败路径] 协议分支只接受 http(s) 与 ws(s)，其余落到 switch 的 default 抛错；放宽成原样透传会让后续拼出非法端点，错误延后到探测阶段并丢失原始原因。
// INV-03 [事务] http 到 ws、https 到 wss 的换算只在 protocol 分支执行一次，并且同步回写 hostWsUrl 的协议；漏掉这次回写，Host 通道仍用 http 协议，WebSocket 构造时立刻抛协议错。
// INV-04 [事务] 两条 HTTP 探测都必须经过 authenticatedUrl：query 的 token 与 Authorization 头双写是兼容旧 server 的约定，只留一种会让另一类 server 返回 401。
// INV-05 [失败路径] fetchServerInfo 用 serverRemoteInfoSchema 的 safeParse 判定结构，失败抛「Server info response is invalid」；改成直接断言会把字段残缺的 serverInfo 带进 attachment 阶段才炸。
// INV-06 [失败路径] fetchHostCapability 同时要求 2xx 与 schema 合法，产出的 capability 是 /ws/host 的唯一准入凭据；用「URL 可达」替代校验会被 server 拒绝或降级到无 Host 能力。
// INV-07 [资源] abort 监听在 connectNodeWebSocket 内注册，并在 error、close、open 三处统一 releaseAbort 移除；删掉任一处，长命 signal 会累积监听并泄漏已 settle 的 promise。
// INV-08 [并发] settled 标志保证 resolve 与 reject 只生效一次；去掉后 abort 与 open 的竞态会二次结算，terminate 仍会打断一条本可用的连接。
// INV-09 [失败路径] 握手前的 error 与 close 分别 reject 且带上 code 与 reason 文本；只 reject 不 terminate 会留下半开 socket，调用方拿到异常却仍占着端口与远端会话。
// INV-10 [资源] wrapNodeWebSocket 把 ws 的 message、close、error 翻成三个 Emitter；error 分支只发关闭事件、不调用 onClose，改错会让上层误以为对端正常关闭并触发重连风暴。
// INV-11 [失败路径] write 只在 readyState 为 OPEN 时发送，非 OPEN 静默丢弃；改成抛错会把关闭期的正常写路径变成未捕获异常。
// INV-12 [资源] createNodeWebSocketServiceConnection 的 dispose 顺序固定为 reverseServer、client、protocol，最后解绑 close 与 error；反序会让反向通道引用已释放的协议。
// INV-13 [资源] dispose 的幂等依赖 socket.off 解绑加各层自身幂等；删掉 off 后对端关闭会重复进入 dispose，二次释放产生多余 reject 与日志噪声。
// INV-14 [事务] reverseServer 仅在传入 topicResourceChannel 时创建，并复用同一个 protocol；另起连接会让反向资源请求绕过本条物理连接的生命周期，dispose 后成为孤儿。
// INV-15 [失败路径] connectServerRemote 的 try 块在 commitMembership 前后各查一次 readyState；删掉第二次检查会返回一个成员提交失败、socket 已断却看似可用的连接。
// INV-16 [资源] catch 分支必须同时 rpc.dispose 与 socket.terminate 后原样抛出；漏掉任一回收，失败路径把 socket 留给 GC，远端会继续持有该会话直到超时。
// INV-17 [权衡] connectServerRemoteOverDuplex 用固定主机名 source-server.invalid 只为复用端点路径，真实地址由 createConnection 决定；真去解析该主机名只会得到必然失败的 DNS 查询。
// INV-18 [资源] duplex 路径的 dispose 与 catch 都必须 agent.destroy；漏掉会让复用的 HTTP 连接留在上层，后续 ingress 请求复用一条已失效的通道。
//
// 模块职责：封装一条到远端 Server 的物理连接，负责端点归一、server-info 与 host capability 探测、WebSocket 或 duplex 握手、用 ChannelClient 包装成 IServiceAccessor，以及失败时的回收。
// 状态所有权：socket、SocketProtocol、ChannelClient、可选 ChannelServer 与 duplex agent 都归本次调用所有，serverInfo 只是只读快照，session 与 attachment 由 sourceServerConnectionManager 与 windowRemoteConnectionRegistry 持有。
// 阅读顺序：resolveServerRemoteEndpoints、两个 fetch 探测、connectNodeWebSocket 与 wrapNodeWebSocket、connectServerRemote 的所有权交接，最后是文件末尾的 duplex 变体。
// 「Desktop 直连远端 Server」的物理连接层：解析端点、拉取 server-info 与 host capability、
// 建立 WebSocket（或经 duplex 复用通道）并用 ChannelClient 包装成 IServiceAccessor。
//
// 与上层的关系：本文件只负责一条物理连接的建立/释放；session（远端会话）与 attachment
// （窗口可见的服务面）由 sourceServerConnectionManager / windowRemoteConnectionRegistry 管理。
// 因此这里的 dispose 语义是「这条物理连接的所有请求一起失败」而不是「某个窗口解绑」。
//
// 失败语义：端点解析、HTTP 探测、schema 校验、握手期间的 socket 提前关闭都直接抛错；
// 失败时由调用方负责回收（connectServerRemote 内部已回收 socket 与协议，见 catch 分支）。
// 认证口径：token 同时以 Authorization 头与 query 参数下发（兼容旧 server 的两种读取方式），
// host capability 头单独透传，用于让 server 判定是否允许 Host 级通道。
// 不变量：一旦 resolve 成功，socket 与 rpc 的所有权转移给返回值，调用方只允许 dispose 一次；
// 握手阶段（成员提交/能力校验）失败则所有权仍在本函数，必须在 catch 中自行 terminate。

import { WebSocket, type RawData } from "ws";
import { RemoteServiceAccess } from "@zcode/client";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type IServerChannel,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  type ServerConnectOptions,
  type ServerRemoteInfo,
} from "@zcode/shared";
import {
  connectWebSocketOverDuplex,
  createReusableDuplexHttpAgent,
  requestJsonOverDuplex,
  type ServerRemoteDuplexFactory,
} from "./serverRemoteDuplexTransport.js";

// 同一 server 的四个端点：信息探测、数据 RPC、Host 能力探测、Host 级 RPC。
// 拆分是为了让 Host 级通道（/ws/host）与普通数据通道（/ws）走不同的能力校验。
export interface ServerRemoteEndpoints {
  infoUrl: string;
  wsUrl: string;
  hostCapabilityUrl: string;
  hostWsUrl: string;
}

// 一条已建立的 server remote 连接：serverInfo 是握手时校验过的元数据，
// services 是绑定到该物理连接的 RPC 访问面，dispose 释放这条连接上的所有通道。
// dispose 必须幂等：socket 可能已经因为对端关闭而触发过内部 dispose。
export interface ServerRemoteConnection {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  dispose(): void;
}

// 直连（WebSocket）路径的可选项：signal 控制取消，commitMembership 在握手窗口内提交成员关系，
// topicResourceChannel 注册反向资源通道，onClose 用于把意外断开上报给上层做重连决策。
export interface ServerRemoteConnectionOptions {
  signal?: AbortSignal;
  commitMembership?(sourceServerId: string): Promise<void>;
  topicResourceChannel?: IServerChannel;
  fetchImpl?: typeof fetch;
  onClose?: (event: { code: number; reason: string }) => void;
}

// duplex 路径的可选项：ingressToken 是 Source Server 的入站凭据（不走 query/Authorization 双写），
// createConnection 由上层提供（复用已认证的传输），onClose 语义与直连路径一致。
export interface ServerRemoteDuplexConnectionOptions {
  topicResourceChannel?: IServerChannel;
  ingressToken: string;
  createConnection: ServerRemoteDuplexFactory;
  onClose?: (event: { code: number; reason: string }) => void;
}

function appendEndpointPath(basePath: string, endpointPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/g, "");
  return normalizedBase ? `${normalizedBase}${endpointPath}` : endpointPath;
}

function stripWebSocketEndpointPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/g, "");
  if (normalizedPath.endsWith("/ws/host")) {
    return normalizedPath.slice(0, -"/ws/host".length);
  }
  if (normalizedPath.endsWith("/ws")) {
    return normalizedPath.slice(0, -"/ws".length);
  }
  return normalizedPath;
}

// 把用户输入的 server URL 归一成四个端点。
// 输入：任意 http(s)/ws(s) URL（可带路径、query、hash）；输出：四个绝对 URL，query/hash 清空。
// 规则：http→ws / https→wss（反向同理），并把 base path 保留（支持部署在子路径）；
//   若输入本身已带 /ws 或 /ws/host 后缀，先剥离再拼接固定端点，避免出现 /ws/ws。
// 失败语义：空 URL 或非 http(s)/ws(s) 协议直接抛错；不发起任何网络请求。
// 副作用：无（纯字符串/URL 运算）；不修改入参对象。
// 四条端点都由同一个输入 URL 派生：infoUrl、wsUrl、hostCapabilityUrl、hostWsUrl，路径拼接统一走 appendEndpointPath。
// [事务] 四个 URL 对象在改协议之前各自独立复制，互不共享引用；改成复用同一实例，http 到 ws 的换算会连带改掉探测端点协议。
// stripWebSocketEndpointPath 只识别结尾的 /ws/host 与 /ws，且先判 host 再判普通，避免 /ws/host 被截成 /host。
// [失败路径] 空串在第一步就抛 Server URL is required，非 http(s)/ws(s) 落到 switch 的 default，这两条是唯一不发起网络请求的失败点。
// 拼接完成后统一清空 search 与 hash：token 由 authenticatedUrl 单独注入，残留 query 会被 server 当成未知参数或覆盖 token。
// [权衡] 子路径部署靠保留 base path 支持，因此这里不做根路径归一；把 pathname 强制改成 / 会让反代下的部署全部 404。
export function resolveServerRemoteEndpoints(serverUrl: string): ServerRemoteEndpoints {
  const trimmedUrl = serverUrl.trim();
  if (!trimmedUrl) {
    throw new Error("Server URL is required");
  }

  const infoUrl = new URL(trimmedUrl);
  const wsUrl = new URL(trimmedUrl);
  const hostCapabilityUrl = new URL(trimmedUrl);
  const hostWsUrl = new URL(trimmedUrl);
  const infoBasePath = stripWebSocketEndpointPath(infoUrl.pathname);
  const wsBasePath = stripWebSocketEndpointPath(wsUrl.pathname);
  const hostCapabilityBasePath = stripWebSocketEndpointPath(hostCapabilityUrl.pathname);
  const hostWsBasePath = stripWebSocketEndpointPath(hostWsUrl.pathname);

  switch (infoUrl.protocol) {
    case "http:":
    case "https:":
      wsUrl.protocol = infoUrl.protocol === "https:" ? "wss:" : "ws:";
      hostWsUrl.protocol = wsUrl.protocol;
      break;
    case "ws:":
    case "wss:":
      infoUrl.protocol = infoUrl.protocol === "wss:" ? "https:" : "http:";
      hostCapabilityUrl.protocol = infoUrl.protocol;
      break;
    default:
      throw new Error(`Unsupported server URL protocol: ${infoUrl.protocol}`);
  }

  infoUrl.pathname = appendEndpointPath(infoBasePath, "/api/server-info");
  wsUrl.pathname = appendEndpointPath(wsBasePath, "/ws");
  hostCapabilityUrl.pathname = appendEndpointPath(
    hostCapabilityBasePath,
    "/api/rpc-host-capability",
  );
  hostWsUrl.pathname = appendEndpointPath(hostWsBasePath, "/ws/host");
  infoUrl.search = "";
  wsUrl.search = "";
  hostCapabilityUrl.search = "";
  hostWsUrl.search = "";
  infoUrl.hash = "";
  wsUrl.hash = "";
  hostCapabilityUrl.hash = "";
  hostWsUrl.hash = "";

  return {
    infoUrl: infoUrl.toString(),
    wsUrl: wsUrl.toString(),
    hostCapabilityUrl: hostCapabilityUrl.toString(),
    hostWsUrl: hostWsUrl.toString(),
  };
}

function authenticatedUrl(url: string, target: ServerConnectOptions): string {
  const token = target.token?.trim();
  if (!token) return url;
  const authenticated = new URL(url);
  authenticated.searchParams.set("token", token);
  return authenticated.toString();
}

// wrapNodeWebSocket 只做一件事：把 ws 的事件与写接口翻译成 ISocket，不掺任何业务判断。
// [资源] onData、onSocketClose、onEnd 三个 Emitter 由本函数创建并随连接存活；提到模块级会让多连接共享监听器，一条断开能触发全部。
// fireClosed 的顺序固定为：先回调 onClose 上报 code 与 reason，再触发两个 Emitter；调换会让上层先看到关闭事件、后拿到诊断原因。
// [失败路径] error 分支只触发关闭事件、不调用 onClose，因为 error 没有稳定的 code 与 reason；伪造一个 code 会污染上层重连决策。
// [权衡] write 在非 OPEN 状态静默丢弃、drain 恒 resolve，这是「关闭期写入不致命」的选择；改成抛错需要每个写入点补 try。
function wrapNodeWebSocket(
  ws: WebSocket,
  onClose?: (event: { code: number; reason: string }) => void,
): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onSocketClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  const fireClosed = (code: number, reason: Buffer) => {
    onClose?.({ code, reason: reason.toString("utf8") });
    onSocketClose.fire();
    onEnd.fire();
  };

  ws.on("message", (raw: RawData) => {
    const data = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  ws.on("close", fireClosed);
  ws.on("error", () => {
    onSocketClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onSocketClose.event,
    onEnd: onEnd.event,
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

// 这里是所有权转移点：入参是裸 WebSocket，出参是 services 与 dispose，调用方不再直接碰协议层。
// SocketProtocol 包住 ISocket，ChannelClient 在其上建客户端，反向 ChannelServer 复用同一 protocol，三者共享一条物理连接。
// [并发] 反向通道注册在同一个 protocol 上，Host 侧才能收到 desktop 发起的资源反向请求；另建 protocol 会让两边帧序号与生命周期脱节。
// [资源] dispose 的内部顺序是 reverseServer、client、protocol，最后解绑 close 与 error；反序会让 protocol 在仍有引用时被释放。
// [并发] socket.once 负责在对端关闭时进入 dispose，dispose 内的 socket.off 负责解绑自身，缺一会在重复关闭时重入。
// [失败路径] 任何一层释放抛错都会中断后续释放，所以这里不包 try 而依赖各层幂等；新增释放步骤必须放在最外层。
function createNodeWebSocketServiceConnection(
  socket: WebSocket,
  onClose?: ServerRemoteConnectionOptions["onClose"],
  topicResourceChannel?: IServerChannel,
): { services: IServiceAccessor; dispose(): void } {
  const protocol = new SocketProtocol(wrapNodeWebSocket(socket, onClose));
  const client = new ChannelClient(protocol);
  // 反向通道挂在同一协议上：Host 作为 ChannelServer 接受 desktop 侧的资源反向请求，
  // 不是新建连接，因此它的生命周期必须与物理 socket 绑定（由 dispose 统一释放）。
  const reverseServer = topicResourceChannel
    ? new ChannelServer(protocol, "desktop-resource")
    : undefined;
  if (reverseServer && topicResourceChannel)
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, topicResourceChannel);
  const dispose = () => {
    // Bug 根因：仅关闭 socket 会让未完成的 RPC 永久 pending，旧 Provisioning 请求
    // 因而占住 Environment lane，新连接始终无法发布 attachment。由物理连接统一
    // 释放客户端与协议，让旧请求拒绝并沿现有同步失败路径收口；重复释放保持幂等。
    reverseServer?.dispose();
    client.dispose();
    protocol.dispose();
    socket.off("close", dispose);
    socket.off("error", dispose);
  };
  socket.once("close", dispose);
  socket.once("error", dispose);
  return { services: new RemoteServiceAccess(client), dispose };
}

// 握手前探测：server-info 必须能通过 schema 校验才继续。
// 用 safeParse 而不是直接断言，是为了把「版本不兼容/端点被代理改写」挡在建连之前，
// 避免拿到一个字段残缺的 serverInfo 后在 attachment 阶段才炸。
// 两个探测共用同一套口径：先经 authenticatedUrl 注入 token，再要求 HTTP 2xx，最后用 zod schema 的 safeParse 判定结构。
// [失败路径] 探测失败一律抛错且不降级，server-info 不合法意味着版本或反代不兼容，继续建连只会在 attachment 阶段以更难定位的方式失败。
// server-info 同时下发 Authorization 头与 query token，这是兼容旧 server 的双写口径；capability 探测只发 POST，不自带 Host 能力头。
// capability 返回的字符串会被原样写进握手头 ZCODE_RPC_HOST_CAPABILITY_HEADER，探测与握手必须共用同一次结果，不能各自重新请求。
// [资源] 两个探测共用同一个 signal，取消由 fetch 自身 reject，这里不做 try 包裹，异常直接冒泡到 connectServerRemote 的统一失败路径。
async function fetchServerInfo(
  infoUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ServerRemoteInfo> {
  const token = target.token?.trim();
  const response = await fetchImpl(authenticatedUrl(infoUrl, target), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Server info request failed: ${response.status}`);
  }
  const rawBody = await response.json();
  const parsed = serverRemoteInfoSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new Error("Server info response is invalid");
  }
  return parsed.data;
}

// Host 能力探测：只有 server 返回合法 capability 才允许连 /ws/host。
// 这是 Host 级通道的准入条件，不能用「URL 可达」替代，否则会被 server 侧拒绝或降级。
async function fetchHostCapability(
  capabilityUrl: string,
  target: ServerConnectOptions,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(authenticatedUrl(capabilityUrl, target), {
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Host capability request failed: ${response.status}`);
  }
  const parsed = serverRemoteHostCapabilitySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Host capability response is invalid");
  }
  return parsed.data.capability;
}

// 建立 WebSocket 并等待 open；只有 open 之后才创建 RPC 协议层。
// 失败语义：error/close 在前都 reject（带 reason 便于诊断）；abort 直接 terminate 并 reject，
//   保证取消不会留下半开的 socket。
// 副作用：把 abort 监听挂到 signal 上，settle 前必须移除，避免长时间存活导致监听泄漏。
// 本函数只承诺 open 之后的 socket，open 之前一律 reject，因此 RPC 协议层永远不会建在半开连接上。
// [资源] abort 监听用 addEventListener 注册，并在 error、close、open 三处 releaseAbort 移除，漏掉任一处，复用的 signal 会不断累积监听。
// [并发] settled 与 abort 的竞态由 settled 收口：abort 先到则 terminate 并 reject，open 先到则置真、后续 abort 不再提交结果。
// [失败路径] close 的 reject 文案区分有 reason 与仅有 code 两种情况，这是排查提前关闭的唯一线索，不要把 reason 丢掉。
// 握手头一次性带齐 Authorization 与 Host capability，token 缺失时只留 capability 头，不要发空 Bearer。
// [权衡] abort 分支直接 terminate 而不走优雅 close，是为了让取消立即生效，代价是对端只能按超时感知断开。
function connectNodeWebSocket(
  wsUrl: string,
  target: ServerConnectOptions,
  capability: string,
  options: ServerRemoteConnectionOptions,
): Promise<{
  socket: WebSocket;
  rpc: ReturnType<typeof createNodeWebSocketServiceConnection>;
}> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const token = target.token?.trim();
    const socket = new WebSocket(authenticatedUrl(wsUrl, target), {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability,
      },
    });
    let settled = false;
    const abort = () => {
      socket.terminate();
      reject(options.signal?.reason ?? new Error("远程连接已取消"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const releaseAbort = () => options.signal?.removeEventListener("abort", abort);

    socket.once("error", (error) => {
      releaseAbort();
      if (!settled) {
        reject(error);
      }
    });
    socket.once("close", (code, reason) => {
      releaseAbort();
      if (!settled) {
        reject(
          new Error(
            reason.length > 0
              ? `WebSocket closed before ready: ${reason.toString("utf8")}`
              : `WebSocket closed before ready (${code})`,
          ),
        );
      }
    });
    socket.once("open", () => {
      releaseAbort();
      settled = true;
      resolve({
        socket,
        rpc: createNodeWebSocketServiceConnection(
          socket,
          options.onClose,
          options.topicResourceChannel,
        ),
      });
    });
  });
}

// 直连远端 Server（WebSocket）的完整入口：端点解析 -> 两次探测 -> WS 握手 -> 成员提交。
//
// 输入：target（url/token 等用户连接参数）与可选项；输出：已校验 serverInfo + services 的连接。
// 副作用：发起 2 个 HTTP 请求与 1 个 WebSocket；commitMembership 可能写远端成员关系。
// 失败语义：任一步失败都抛错；握手成功前的失败由本函数回收（rpc.dispose + terminate），
//   握手成功后的失败（成员提交/取消）也走同一 catch，避免 socket 泄漏。
// 不变量：socket 必须仍处于 OPEN 才能提交成员并返回，防止「连接已断但返回值看似可用」。
// 入口的固定流水线是：throwIfAborted、解析端点、server-info 探测、capability 探测、WebSocket 握手、成员提交、返回连接。
// [并发] 进入时先查一次 signal，探测与握手各自再查，因为 HTTP 与握手都可能长时间挂起，只在入口查会漏掉中途取消。
// [事务] 第一次 readyState 检查在 commitMembership 之前，第二次在其之后，前者防止对已断连接写成员，后者防止返回已失效连接。
// [资源] 返回值里的 dispose 同时释放 rpc 与 socket，且 rpc.dispose 已解绑 close 与 error，因此重复 dispose 不会再触发 terminate。
// [失败路径] catch 不区分阶段，统一 rpc.dispose 加 socket.terminate 后原样抛出，这里必须保留原始 error，替换成包装错误会丢掉 server 的 reason。
// [事务] 所有权在 return 处转移，一旦 resolve 回收责任就交给调用方；把 catch 写成只释放 rpc 会让 socket 泄漏到 GC。
// [权衡] 这里不做自动重连，断线只通过 onClose 上报，由上层注册表决定是否重建，本层无法区分窗口解绑与网络抖动。
// [失败路径] 成员提交的 error 原样上抛且不回滚远端成员关系，需要补偿的调用方必须在自己的 catch 里处理，本层不做猜测。
export async function connectServerRemote(
  target: ServerConnectOptions,
  options: ServerRemoteConnectionOptions = {},
): Promise<ServerRemoteConnection> {
  options.signal?.throwIfAborted();
  const endpoints = resolveServerRemoteEndpoints(target.url);
  const serverInfo = await fetchServerInfo(
    endpoints.infoUrl,
    target,
    options.fetchImpl ?? fetch,
    options.signal,
  );
  const capability = await fetchHostCapability(
    endpoints.hostCapabilityUrl,
    target,
    options.fetchImpl ?? fetch,
    options.signal,
  );
  const { socket, rpc } = await connectNodeWebSocket(
    endpoints.hostWsUrl,
    target,
    capability,
    options,
  );

  try {
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Server closed during handshake");
    await options.commitMembership?.(serverInfo.serverId);
    options.signal?.throwIfAborted();
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Server closed during membership commit");
    return {
      serverInfo,
      services: rpc.services,
      dispose() {
        rpc.dispose();
        socket.close();
      },
    };
  } catch (error) {
    // 成员提交失败/连接取消时尚未向 Registry 转移所有权，当前调用必须回收 socket。
    rpc.dispose();
    socket.terminate();
    throw error;
  }
}

// 经已认证的 duplex 传输连远端 Server（Source Server 场景，不直接暴露 http 端口）。
//
// 输入：ingressToken + createConnection（上层复用物理通道）；输出：同直连路径的连接对象。
// 与直连的差异：探测与 WS 都复用同一个 duplex agent，因此凭据只走 Authorization 头；
//   dispose 需要同时销毁 agent，否则复用连接会残留在上层。
// 失败语义：token 为空、探测状态非 2xx、schema 不合法、WS 未初始化都抛错；
//   catch 中回收 rpc 与 agent，保证失败不占用 ingress 通道。
// 不变量：必须等 onSocketCreated 回调真正创建 rpc 后才允许返回，禁止返回未初始化的 services。
// duplex 变体与直连共用同一套端点路径与 schema，但所有 IO 都经 createConnection 建立的复用通道，因此不暴露 http 端口。
// 固定主机名 source-server.invalid 只用来生成路径，真实目标由 createConnection 决定，它不是可解析地址，也不参与鉴权。
// [失败路径] ingressToken 先 trim 再判空，空串立即抛错；放到探测之后会让无凭据的请求先打到 server 换回一个 401。
// [资源] agent 在探测前创建，在 dispose 与 catch 两处销毁；漏掉任一处，复用连接会留在上层并让后续 ingress 请求复用死通道。
// [事务] 探测状态用 200 到 299 区间判定而不是 response.ok，因为 duplex 响应是自建结构，放宽到非 5xx 会把 3xx 的响应体当成 JSON。
// [并发] RPC 只能在 onSocketCreated 回调里创建，回调外的 socket 变量只用于 terminate，提前返回会让 services 未初始化。
// [失败路径] 回调未触发时由 rpc 为空触发显式错误，这条兜底是「禁止返回未初始化 services」的唯一实现点。
// [权衡] 这里不复用 connectNodeWebSocket，直连依赖 Node WebSocket 的 open 与 abort 语义，duplex 的首帧与关闭由传输层决定，强合并会引入两套分支。
export async function connectServerRemoteOverDuplex(
  options: ServerRemoteDuplexConnectionOptions,
): Promise<ServerRemoteConnection> {
  const ingressToken = options.ingressToken.trim();
  if (!ingressToken) throw new Error("Source Server ingress token is required");
  const endpoints = resolveServerRemoteEndpoints("http://source-server.invalid");
  const authorization = { authorization: `Bearer ${ingressToken}` };
  const agent = await createReusableDuplexHttpAgent(options.createConnection);
  let rpc: ReturnType<typeof createNodeWebSocketServiceConnection> | undefined;
  try {
    const infoResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.infoUrl,
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (infoResponse.status < 200 || infoResponse.status >= 300) {
      throw new Error(`Server info request failed: ${infoResponse.status}`);
    }
    const serverInfo = serverRemoteInfoSchema.safeParse(infoResponse.body);
    if (!serverInfo.success) throw new Error("Server info response is invalid");
    const capabilityResponse = await requestJsonOverDuplex<unknown>({
      url: endpoints.hostCapabilityUrl,
      method: "POST",
      headers: authorization,
      createConnection: options.createConnection,
      agent,
    });
    if (capabilityResponse.status < 200 || capabilityResponse.status >= 300) {
      throw new Error(`Host capability request failed: ${capabilityResponse.status}`);
    }
    const capability = serverRemoteHostCapabilitySchema.safeParse(capabilityResponse.body);
    if (!capability.success) throw new Error("Host capability response is invalid");
    const socket = await connectWebSocketOverDuplex({
      url: endpoints.hostWsUrl,
      headers: {
        ...authorization,
        [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.data.capability,
      },
      createConnection: options.createConnection,
      agent,
      onSocketCreated: (webSocket) => {
        rpc = createNodeWebSocketServiceConnection(
          webSocket,
          options.onClose,
          options.topicResourceChannel,
        );
      },
    });
    if (!rpc) throw new Error("Source Server RPC protocol was not initialized");
    return {
      serverInfo: serverInfo.data,
      services: rpc.services,
      dispose() {
        rpc?.dispose();
        socket.terminate();
        agent.destroy();
      },
    };
  } catch (error) {
    rpc?.dispose();
    agent.destroy();
    throw error;
  }
}
