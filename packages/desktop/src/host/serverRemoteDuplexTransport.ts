// 经「已认证的 Duplex 隧道」访问远端 Server 的传输适配层。
//
// 为什么需要它：Source Server 场景下 Host 不能直接发起 TCP 连接，只能复用一条已经建立的
// 隧道（ssh 通道、容器 stdio、代理流等）。Node 的 http.Agent 与 ws 都假设底层是 net.Socket，
// 因此本文件负责把普通 Duplex 补齐成「够用」的 Socket 形状，并在同一连接上串行完成
// server-info、host capability、WebSocket upgrade 三次请求。
//
// 关键约束：可复用 agent 只允许创建一条底层连接（第二次 createConnection 直接抛错），
// 这是刻意的 fail-fast——多连接会静默绕开隧道预算并破坏「一次握手」的假设。
// 失败语义：非 http/ws 协议、JSON 解析失败、隧道提前关闭均抛错；不自动重试。
// 所有权：agent/stream 由调用方（serverRemoteConnection）负责 destroy，本文件不缓存。

import { Agent, request } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket } from "ws";

// 创建底层隧道的工厂：每次调用产出一条新的 Duplex（同步或异步均可）。
// 调用方需保证「一次握手批次只调用一次」，否则会额外启动远端 CLI/ssh 通道。
export type ServerRemoteDuplexFactory = () => Duplex | Promise<Duplex>;

interface SocketCompatibleDuplex extends Duplex {
  ref(): this;
  unref(): this;
  setKeepAlive(enable?: boolean, initialDelay?: number): this;
  setNoDelay(noDelay?: boolean): this;
  setTimeout(timeout: number, callback?: () => void): this;
}

function asSocketCompatibleDuplex(stream: Duplex): SocketCompatibleDuplex {
  // 原因：ssh2 ClientChannel 与 child stdio 都满足 Duplex，但 ws 在 upgrade 完成时会调用
  // net.Socket 的可选调优方法。隧道已经建立，这些 TCP 调优不属于上层 HTTP/WS 合同，
  // 因而在普通 Duplex 上提供链式 no-op，避免把 transport 具体类型泄漏到握手层。
  const socket = stream as SocketCompatibleDuplex;
  // keep-alive Agent 释放 HTTP socket 时会调用 unref；opaque Duplex 没有事件循环引用语义，
  // 链式 no-op 与上面的 TCP 调优方法相同，只补 Node Agent 所需的结构合同。
  socket.ref ??= () => socket;
  socket.unref ??= () => socket;
  socket.setKeepAlive ??= () => socket;
  socket.setNoDelay ??= () => socket;
  socket.setTimeout ??= (_timeout: number, callback?: () => void) => {
    if (callback) socket.once("timeout", callback);
    return socket;
  };
  return socket;
}

// 创建「一条连接打满三次握手」的可复用 HTTP Agent。
// 输入：隧道工厂；输出：keepAlive Agent，其 createConnection 只会被调用一次。
// 副作用：立即向工厂申请一条隧道（失败即抛错）；agent 持有该 stream 的所有权。
// 失败语义：工厂抛错则原样抛出；后续任何第二次建连请求都会抛错而不是静默新建。
// 不变量：maxSockets=1 + connectionCreated 双重保险，保证 server-info/capability/upgrade
// 全部落在同一条隧道上，从而不超出 Source 的冷启动预算。
export async function createReusableDuplexHttpAgent(
  createConnection: ServerRemoteDuplexFactory,
): Promise<Agent> {
  const stream = asSocketCompatibleDuplex(await createConnection());
  // Bug 原因：Source 握手的 server-info、capability 和 WebSocket upgrade 过去各启动一条
  // proxy-stdio。Docker/SSH 每条都要创建远端 CLI 进程，冷启动时三次握手会耗尽 10 秒预算。
  // 三个请求严格串行且指向同一 loopback server，可在一次 HTTP keep-alive 连接上完成，
  // 最后由 WebSocket upgrade 接管该 Duplex。
  const agent = new Agent({
    keepAlive: true,
    maxFreeSockets: 1,
    maxSockets: 1,
  });
  let connectionCreated = false;
  agent.createConnection = (() => {
    if (connectionCreated) {
      throw new Error("Reusable Duplex HTTP agent attempted to create a second connection");
    }
    connectionCreated = true;
    return stream;
  }) as Agent["createConnection"];
  return agent;
}

// 单个 JSON 请求的输入：url 必须是 http:（WS 升级走 connectWebSocketOverDuplex）。
// agent 缺省时本函数会为这一个请求临时建连并在结束后关闭（不复用）。
export interface DuplexJsonRequestOptions {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  createConnection: ServerRemoteDuplexFactory;
  agent?: Agent;
}

// 经隧道发起一次 HTTP 请求并把响应体按 JSON 解析。
// 输入：url/方法/头/可选 body、隧道工厂与可选 agent；输出：{ status, body }。
// 副作用：缺省 agent 时会新建一条隧道（keepAlive=false，请求结束即释放）。
// 失败语义：协议不是 http、网络错误、响应体不是合法 JSON 都 reject，由调用方判断 status。
// 口径：HTTP 非 2xx 不在此抛错（status 原样返回），让调用方按自己的错误码口径处理。
export async function requestJsonOverDuplex<T>(
  options: DuplexJsonRequestOptions,
): Promise<{ status: number; body: T }> {
  const url = new URL(options.url);
  if (url.protocol !== "http:") {
    throw new Error(`Duplex Server requests require http:, received ${url.protocol}`);
  }
  let agent = options.agent;
  if (!agent) {
    const stream = asSocketCompatibleDuplex(await options.createConnection());
    agent = new Agent({ keepAlive: false });
    agent.createConnection = (() => stream) as Agent["createConnection"];
  }
  return await new Promise((resolve, reject) => {
    const clientRequest = request(
      url,
      {
        agent,
        method: options.method ?? "GET",
        headers: {
          connection: options.agent ? "keep-alive" : "close",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | Uint8Array | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    clientRequest.once("error", reject);
    if (options.body) clientRequest.write(options.body);
    clientRequest.end();
  });
}

// WebSocket 升级输入：onSocketCreated 必须在 open 前回调，用于提前挂协议监听。
export interface DuplexWebSocketOptions {
  url: string;
  headers?: Record<string, string>;
  createConnection: ServerRemoteDuplexFactory;
  agent?: Agent;
  onSocketCreated?: (socket: WebSocket) => void;
}

// 在隧道上完成 WebSocket upgrade，并在 open 前把 socket 交给调用方挂协议。
//
// 输入：ws: url、头、隧道工厂、可选 agent、onSocketCreated 回调；输出：open 后的 WebSocket。
// 副作用：缺省 agent 时新建一条隧道；upgrade 成功后该隧道由 WebSocket 接管。
// 失败语义：协议不是 ws、open 前 error/close 都 reject（close 会带上 code/reason）。
// 不变量：onSocketCreated 必须在等待 open 之前调用——Initialize 首帧可能先于 open
// 回调到达，晚订阅会永久丢帧并让所有 RPC 卡在 whenInitialized。
export async function connectWebSocketOverDuplex(
  options: DuplexWebSocketOptions,
): Promise<WebSocket> {
  const url = new URL(options.url);
  if (url.protocol !== "ws:") {
    throw new Error(`Duplex Server WebSockets require ws:, received ${url.protocol}`);
  }
  let agent = options.agent;
  if (!agent) {
    const stream = asSocketCompatibleDuplex(await options.createConnection());
    agent = new Agent({ keepAlive: false });
    agent.createConnection = (() => stream) as Agent["createConnection"];
  }
  return await new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, {
      agent,
      headers: options.headers,
    });
    // 原因：隧道 Duplex 可能比普通 TCP 更快交付 upgrade 后首帧。ChannelServer 会在
    // open 回调中同步发送 Initialize；若等 open Promise resolve 后才订阅 message，首帧会丢失，
    // 所有 RPC 永久停在 whenInitialized。必须在等待 open 前建立协议监听。
    options.onSocketCreated?.(webSocket);
    let settled = false;
    webSocket.once("open", () => {
      settled = true;
      resolve(webSocket);
    });
    webSocket.once("error", (error) => {
      if (!settled) reject(error);
    });
    webSocket.once("close", (code, reason) => {
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
  });
}
