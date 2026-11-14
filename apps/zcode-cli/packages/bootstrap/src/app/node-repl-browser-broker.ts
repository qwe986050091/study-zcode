// INV-01 仅本机可达：守住位置 createSocketPath；改错故障 broker 暴露到网络。
// INV-02 双因子凭证：守住位置 token 常量比较；改错故障 仅凭 socket 路径即可调用浏览器。
// INV-03 常量时间比较：守住位置 timingSafeEqual；改错故障 token 可被逐字节试探。
// INV-04 长度先比：守住位置 actual.length 判断；改错故障 timingSafeEqual 抛错变 500 而非 401。
// INV-05 请求体上限：守住位置 MAX_REQUEST_BYTES；改错故障 对端可推爆内存。
// INV-06 schema 强校验：守住位置 nodeReplBrowserBrokerRequestSchema.parse；改错故障 未知字段被静默接受。
// INV-07 失败也回 id：守住位置 requestIdFromPayload；改错故障 客户端收到 id 不匹配的错误。
// INV-08 错误不外泄堆栈：守住位置 respond 的 message 归一；改错故障 内部堆栈进入浏览器端。
// INV-09 socket 错误全生命周期监听：守住位置 顶部 socket.on("error")；改错故障 EPIPE 变成未捕获事件击穿进程。
// INV-10 对端断开视为取消：守住位置 abortController.abort；改错故障 已断开的请求继续跑浏览器操作。
// INV-11 不可写就不回写：守住位置 socket.writable 判断；改错故障 写已销毁 socket 抛 EPIPE。
// INV-12 close 幂等：守住位置 先 await ready 再关；改错故障 同步工厂下 socket 泄漏。
// INV-13 不延长进程寿命：守住位置 server.unref；改错故障 空 broker 撑住 CLI 退出。
// INV-14 注入不改正本：守住位置 injectNodeReplBrowserBroker 的展开；改错故障 共享配置快照被就地修改。
//
// 模块职责：node_repl MCP 子进程与宿主浏览器能力之间的私有 IPC broker。
// 阅读顺序：先看工厂与 socket 路径，再看注入函数，最后看单请求的鉴权与执行。
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserControlPort, Logger, McpServerConfig, TraceContext } from "@zcode/contracts";
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
  nodeReplBrowserBrokerRequestSchema,
  type NodeReplBrowserBrokerRequest,
  type NodeReplBrowserBrokerResponse,
} from "@zcode/shared";

const NODE_REPL_MCP_SERVER_NAME = "node_repl";
const MAX_REQUEST_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * node_repl MCP 子进程与宿主 BrowserControlPort 之间的私有 IPC 句柄。
 *
 * `socketPath` 只在本机（Windows 命名管道 / 临时目录 unix socket），`token` 是 32 字节随机量，
 * 两者经 node_repl stdio 的 env 注入。`ready` 在 listen / error 时兑现或拒绝；`close` 幂等，
 * 会先等 ready（同步工厂下 close 可能早于 listening），再关 server 并清理 unix socket 文件。
 */
// 句柄只暴露关闭、就绪、路径与令牌。
export interface NodeReplBrowserBroker {
  close(): Promise<void>;
  ready: Promise<void>;
  socketPath: string;
  token: string;
}

/**
 * 创建 node_repl 的浏览器 broker：一个一次性 IPC server，把请求转给 BrowserControlPort。
 *
 * 输入：browserControlPort 是宿主已装配的能力端口（sessionId/turnId 的权威校验在它内部的
 * requireSession）；platform 仅用于选 socket 形态和关停时是否删文件。副作用：监听 socket、
 * 生成随机 token；server.unref 使其不单独撑住进程生命周期。
 * 失败语义：listen 失败进 `ready` 的 reject 与 error 日志；单条请求失败只记 warn 回给客户端，
 * 不影响后续请求。
 */
// 工厂同步返回，就绪由 ready 表达。
export function createNodeReplBrowserBroker(input: {
  browserControlPort: BrowserControlPort;
  logger: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplBrowserBroker {
  const socketPath = createSocketPath(input.platform ?? process.platform);
  const token = randomBytes(32).toString("hex");
  // 每条连接独立处理，失败只记 warn。
  const server = createServer((socket) => {
    handleSocket(socket, { ...input, token }).catch((error) => {
      input.logger.warn("Node REPL browser broker request failed", {
        event: "node_repl.browser_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    input.logger.error("Node REPL browser broker failed", error, {
      event: "node_repl.browser_broker.failed",
    });
  });
  server.listen(socketPath);
  // broker 不阻止进程自然退出。
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return {
    ready,
    socketPath,
    token,
    // 关闭顺序：等就绪、关服务、清文件。
    close: async () => {
      // createZCodeApp 是同步工厂，极短生命周期下 close 可能先于 listen 回调；
      // 直接检查 server.listening 会漏关随后才绑定成功的 socket。
      await ready.catch(() => undefined);
      await closeServer(server);
      if ((input.platform ?? process.platform) !== "win32") {
        await rm(socketPath, { force: true });
      }
    },
  };
}

/**
 * 把 broker 的 socket 路径与 token 注入 `node_repl` 的 stdio server env。
 *
 * 只改名为 `node_repl` 且 `type === "stdio"` 的那一项；broker 缺席或 server 不存在时原样返回
 * 同一对象（引用不变，调用方可据此判断是否有注入）。返回新对象与合并后的 env，绝不修改入参，
 * 因为 servers 可能来自多层配置合并的共享快照。
 */
// 只改 node_repl 一项，其余原样复制。
export function injectNodeReplBrowserBroker(
  servers: Record<string, McpServerConfig>,
  broker: NodeReplBrowserBroker | undefined,
): Record<string, McpServerConfig> {
  // 无 broker 时返回同一引用。
  if (!broker) return servers;
  const nodeRepl = servers[NODE_REPL_MCP_SERVER_NAME];
  if (!nodeRepl || nodeRepl.type !== "stdio") return servers;
  return {
    ...servers,
    [NODE_REPL_MCP_SERVER_NAME]: {
      ...nodeRepl,
      env: {
        ...nodeRepl.env,
        [NODE_REPL_BROWSER_BROKER_SOCKET_ENV]: broker.socketPath,
        [NODE_REPL_BROWSER_BROKER_TOKEN_ENV]: broker.token,
      },
    },
  };
}

// Windows 用命名管道，其余用临时 socket。
function createSocketPath(platform: NodeJS.Platform | string): string {
  const id = randomUUID();
  return platform === "win32"
    ? `\\\\.\\pipe\\zcode-node-repl-${id}`
    : join(tmpdir(), `znr-${id}.sock`);
}

// 单连接全流程：读、校验、鉴权、执行。
async function handleSocket(
  socket: Socket,
  input: {
    browserControlPort: BrowserControlPort;
    logger: Logger;
    token: string;
  },
): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId = randomUUID();
  // steer 会让 node_repl 客户端 abort 后立即 socket.destroy()，而 broker 此刻通常正在
  // 回写截图 base64。socket 只在 readLine 期间挂 error 监听（resolve 时就被 cleanup 摘掉）是不够的，
  // 写响应阶段完全没有监听者，对端断开产生的 EPIPE 就成了无人接收的 'error' 事件，直接击穿整个
  // Agent 进程（Unhandled error event -> exit 1）。这里让监听覆盖 socket 全生命周期，并把对端
  // 断开收敛为「取消当前请求」，不再冒泡成进程级错误。
  socket.on("error", (error) => {
    if (!completed) abortController.abort();
    input.logger.debug("Node REPL browser broker connection dropped", {
      event: "node_repl.browser_broker.connection.dropped",
      error: error.message,
    });
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as unknown;
    // 严格 schema 会在 timeout 等未知字段处直接抛错；过去只有完整 parse 成功后才覆盖
    // 随机占位 id，导致真实参数错误被 client 的 response id mismatch 二次错误吞掉。
    requestId = requestIdFromPayload(payload) ?? requestId;
    const request = nodeReplBrowserBrokerRequestSchema.parse(payload);
    requestId = request.id as ReturnType<typeof randomUUID>;
    authorizeRequest(request, input);
    const response = await executeRequest(
      request,
      input.browserControlPort,
      abortController.signal,
    );
    completed = true;
    respond(socket, response);
  } catch (error) {
    completed = true;
    respond(socket, {
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requestIdFromPayload(payload: unknown): ReturnType<typeof randomUUID> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" && UUID_PATTERN.test(id)
    ? (id as ReturnType<typeof randomUUID>)
    : undefined;
}

function respond(socket: Socket, response: NodeReplBrowserBrokerResponse): void {
  // 对端可能已在 steer 取消后销毁 socket；此时没有回写的意义，写了也只会换来一个 EPIPE。
  if (!socket.writable) return;
  socket.end(`${JSON.stringify(response)}\n`);
}

// 令牌不符不降级为匿名调用：请求映射不到 session 能力，只能在入口抛错。
function authorizeRequest(request: NodeReplBrowserBrokerRequest, input: { token: string }): void {
  const actual = Buffer.from(request.token);
  const expected = Buffer.from(input.token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Node REPL browser broker request is not authorized");
  }
  // 共享 MCP 子进程不能再绑定某一个 session，但 top-level MCP metadata 也不能
  // 直接取得 Browser 权限。私有 socket token 先证明请求来自宿主启动的 node_repl；sessionId
  // 随后由 BrowserControlPort 的 requireSession 做权威校验——subagent 的子会话只有经父 runtime
  // forChildSession 登记后才能解析到客户端会话，未登记的一律拒绝。
}

// list 与 execute 共用同一 trace 与取消信号。
async function executeRequest(
  request: NodeReplBrowserBrokerRequest,
  port: BrowserControlPort,
  signal: AbortSignal,
): Promise<NodeReplBrowserBrokerResponse> {
  const traceContext = request.trace as TraceContext | undefined;
  if (request.op === "list") {
    const browsers = await port.list({
      sessionId: request.sessionId,
      turnId: request.turnId,
      traceContext,
      signal,
    });
    return { id: request.id, ok: true, browsers };
  }
  const result = await port.execute({
    browserId: request.browserId,
    browserGeneration: request.browserGeneration,
    sessionId: request.sessionId,
    turnId: request.turnId,
    command: request.command,
    traceContext,
    signal,
  });
  return { id: request.id, ok: true, result };
}

// 读到换行为止，超限或取消即拒绝。
async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Node REPL browser broker request exceeded 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("aborted", "AbortError"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
