/**
 * node_repl 宿主侧的 Computer Use（CUA）broker。
 *
 * 职责：在宿主进程内起一个仅本机可见的 socket 服务（Windows 用命名管道，其余平台用
 * 临时目录下的 socket 文件），把 node_repl 侧的 method 调用转发给 ComputerUseRuntime。
 * 输入：runtime 实现、可选 logger 与平台标识。
 * 输出：`{ connection, ready, close }`，connection 供 bridge 侧建立连接。
 * 副作用：创建 socket 文件/管道，结束后在非 Windows 平台删除 socket 文件。
 * 失败语义：监听失败通过 `ready` 的 reject 暴露；单次请求失败只记录日志并回包错误，
 * 不拖垮服务端。鉴权失败一律按「未授权」拒绝，不区分具体原因以免泄露 token 信息。
 * 不变量：所有请求必须先通过 token 校验，再解析上下文，最后才调用 runtime。
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
} from "@zcode/zcode-cua";
import type { Logger } from "@zcode/contracts";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

// broker 句柄：connection 给 node_repl 侧连，ready 用于等待监听完成，
// close 必须由创建者负责调用，否则 socket 文件会残留。
export interface NodeReplCuaBroker {
  connection: NodeReplCuaBrokerConnection;
  ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * 启动一个 CUA broker 并返回其连接信息。
 *
 * 每次启动都生成全新的随机 socket 名与 32 字节 token，因此不同会话之间互不可见，
 * 也不存在可复用的固定路径。
 * 副作用：立即开始 listen 并 unref server，不阻止进程退出。
 * 失败语义：监听失败只会让 `ready` reject，不会同步抛出；调用方必须 await ready。
 * 不变量：close 幂等；非 Windows 平台关闭后删除 socket 文件。
 */
export function createNodeReplCuaBroker(input: {
  runtime: ComputerUseRuntime;
  logger?: Logger;
  platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker {
  const socketPath =
    // Windows 不支持 Unix socket 文件，必须走命名管道；两边都用随机后缀隔离会话。
    input.platform === "win32"
      ? `\\\\.\\pipe\\zcode-node-repl-cua-${randomUUID()}`
      : join(tmpdir(), `znrc-${randomUUID()}.sock`);
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    void handleSocket(socket, input.runtime, token).catch((error) => {
      input.logger?.warn("Node REPL CUA broker request failed", {
        event: "node_repl.cua_broker.request.failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  server.on("error", (error) => {
    // 监听期错误只记录，真正的可用性以 ready 的结算为准，避免日志和返回值两套状态。
    input.logger?.error("Node REPL CUA broker failed", error, {
      event: "node_repl.cua_broker.failed",
    });
  });
  server.listen(socketPath);
  // unref 让 broker 不单独持有事件循环，进程退出由上层控制。
  server.unref();
  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    connection: { socketPath, token },
    ready,
    close: async () => {
      // 监听可能已经失败，此时无需 close；忽略 ready 的错误是为了保证 close 幂等。
      await ready.catch(() => undefined);
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (input.platform !== "win32") await rm(socketPath, { force: true });
    },
  };
}

/**
 * 处理单个 broker 连接：读一行请求、鉴权、解析上下文、调用 runtime、回一行响应。
 *
 * 每个连接只处理一个请求（一拍即断），因此不需要处理粘包与并发。
 * 失败语义：所有失败都会回包 `{ ok: false, error }` 并结束 socket，不抛出到调用方；
 * 只有当 socket 已不可写时才静默丢弃，因为此时已无处回报。
 * 不变量：连接断开或出错都要 abort 正在执行的 runtime，避免孤儿操作继续操作桌面。
 */
async function handleSocket(socket: Socket, runtime: ComputerUseRuntime, token: string): Promise<void> {
  const abortController = new AbortController();
  let completed = false;
  let requestId: string | undefined;
  socket.on("error", () => {
    // 未完成时 agent 已失去回包通道，继续执行只会产生不可观测的桌面副作用。
    if (!completed) abortController.abort();
  });
  socket.once("close", () => {
    if (!completed) abortController.abort();
  });
  try {
    const raw = await readLine(socket, abortController.signal);
    const payload = JSON.parse(raw) as {
      id?: unknown;
      token?: unknown;
      method?: unknown;
      input?: unknown;
      context?: unknown;
    };
    assertToken(payload.token, token);
    if (typeof payload.id !== "string" || typeof payload.method !== "string") {
      throw new Error("Computer Use broker request is invalid");
    }
    requestId = payload.id;
    const context = parseContext(payload.context);
    const result = await runtime.execute({
      // 这里把 capability method 适配到 staging runtime 的内部 handler；
      // 外层 SDK/bridge 不再构造或调用 MCP tool envelope。
      toolName: payload.method as never,
      arguments: payload.input,
      context,
      signal: abortController.signal,
    });
    completed = true;
    if (socket.writable) socket.end(`${JSON.stringify({ id: payload.id, ok: true, result })}\n`);
  } catch (error) {
    // 标记 completed 以阻止后续 close/error 再触发 abort——此时请求已结束，
    // 再 abort 会把已成功的 runtime 结果当作失败处理。
    completed = true;
    if (socket.writable) {
      socket.end(`${JSON.stringify({ id: requestId ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

// 常量时间比较，避免通过响应时间差推断 token；长度不同直接拒绝，
// 因为 timingSafeEqual 要求两段 Buffer 等长。
function assertToken(actualValue: unknown, expectedValue: string): void {
  if (typeof actualValue !== "string") throw new Error("Computer Use broker request is not authorized");
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Computer Use broker request is not authorized");
  }
}

/**
 * 校验并规范化 CUA 请求上下文。
 *
 * workspaceKey 按「显式 key → workspaceIdentity → workspacePath」的顺序回落，
 * 与全仓的身份 key 约定一致，保证同一工作区在不同入口下得到相同键。
 * 失败语义：缺少 sessionId 或无法得出 workspaceKey 时抛错，因为这两者是后续
 * 权限判断与状态归属的前提，不能凭空补默认值。
 * 其余可选字段只在类型/枚举合法时才透传，避免把脏数据带进 runtime。
 */
function parseContext(value: unknown): ComputerUseRuntimeContext {
  if (!value || typeof value !== "object") throw new Error("Computer Use request context is missing");
  const context = value as Record<string, unknown>;
  if (typeof context.sessionId !== "string" || !context.sessionId.trim()) {
    throw new Error("Computer Use request context is missing sessionId");
  }
  const workspacePath = typeof context.workspacePath === "string" ? context.workspacePath.trim() : "";
  const workspaceIdentity =
    typeof context.workspaceIdentity === "string" ? context.workspaceIdentity.trim() : "";
  const workspaceKey =
    (typeof context.workspaceKey === "string" ? context.workspaceKey.trim() : "") ||
    workspaceIdentity ||
    workspacePath;
  if (!workspaceKey) throw new Error("Computer Use request context is missing workspaceKey");
  return {
    sessionId: context.sessionId,
    runtimeScope: context.runtimeScope === "subagent" ? "subagent" : "main",
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(typeof context.remoteSessionId === "string" ? { remoteSessionId: context.remoteSessionId } : {}),
    ...(typeof context.turnId === "string" ? { turnId: context.turnId } : {}),
    ...(context.clientMode === "web-remote-replayable" || context.clientMode === "desktop-continuous"
      ? { clientMode: context.clientMode }
      : {}),
    ...(context.deliveryKind === "web-remote-replayable" || context.deliveryKind === "desktop-continuous"
      ? { deliveryKind: context.deliveryKind }
      : {}),
    ...(context.trace && typeof context.trace === "object" ? { trace: context.trace as ComputerUseRuntimeContext["trace"] } : {}),
  };
}

// 读取单行请求：按换行符切分并设 1 MiB 上限，超限立即 reject 而不是继续缓冲，
// 防止异常客户端撑爆宿主内存；所有退出路径都会解绑监听，避免句柄泄漏。
async function readLine(socket: Socket, signal: AbortSignal): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        cleanup();
        reject(new Error("Computer Use broker request exceeded 1 MiB"));
        return;
      }
      // 尚未收到换行说明请求体不完整，继续等待；只有完整一行才交付解析。
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
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
