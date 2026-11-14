// INV-01 桥接以全局符号暴露：守住位置 返回对象键；改错故障 会话对象被注入隐藏能力。
// INV-02 每次调用校验代次：守住位置 活跃检查；改错故障 内核重置后旧绑定仍可调用。
// INV-03 子代理作用域一律拒绝：守住位置 可用性检查；改错故障 子代理越权控制桌面。
// INV-04 broker 连接缺失即判定不可用：守住位置 连接判断；改错故障 拿到空连接后挂起。
// INV-05 请求上下文必须携带会话标识：守住位置 元数据提取；改错故障 broker 无法归属请求。
// INV-06 工作区键按三字段顺序回落：守住位置 空值合并；改错故障 不同调用点归属不一致。
// INV-07 客户模式与投递类型有固定缺省：守住位置 缺省赋值；改错故障 老客户端字段缺失即失败。
// INV-08 响应必须单飞结算：守住位置 settled 标志；改错故障 重复 resolve 或 reject。
// INV-09 响应超过 32MiB 立即失败：守住位置 字节长度检查；改错故障 超大响应耗尽内存。
// INV-10 响应标识必须与请求一致：守住位置 id 比较；改错故障 串包读到他人结果。
// INV-11 中断信号必须销毁连接：守住位置 abort 监听；改错故障 取消后 socket 泄漏。
// INV-12 连接提前关闭视为失败：守住位置 close 回调；改错故障 调用永久悬挂。
// INV-13 只读取 primary 应用身份：守住位置 关联字段选择；改错故障 列表动作覆盖已确立身份。
// INV-14 应用标识必须是非空字符串：守住位置 类型与去空白判断；改错故障 空标识进入会话。
// INV-15 图标字节不进入会话协议：守住位置 身份投影；改错故障 大字节随会话传输。
// INV-16 响应元信息先合并再读身份：守住位置 调用顺序；改错故障 身份读取到旧元信息。
// INV-17 身份读取位于 broker 一跳：守住位置 调用链位置；改错故障 模型可伪造应用身份。
// INV-18 所有失败都是显式异常：守住位置 错误分支；改错故障 调用方拿到半成品结果。
//
// 模块职责：把 node_repl 的 computer-use 能力桥接到 broker，并投影目标应用身份。
// 状态所有权：桥接对象不持有会话；活跃调用由宿主通过回调提供。
// 阅读顺序：先看桥接装配，再读上下文提取，最后看单飞请求与身份读取。
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { NodeReplCuaAppIdentity, NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<CallToolResult>;
  assertAvailable(): void;
  documentationRoot: string;
}

// createComputerUseBridgeGlobals 返回 { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge }：用全局 Symbol.for 而非常规属性，
// 会话对象上不会出现可枚举的 bridge 字段；assertActive 每次调用比对 active.generation 与 input.generation，
// 内核重置后旧绑定立即 stale；assertAvailable 先拒 runtime_scope === "subagent"（CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE），
// 再拒缺失 input.broker，最后才返回 active；桥接对象只捕获 getActiveCall/session 回调，不持有会话引用。
export function createComputerUseBridgeGlobals(input: {
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveCuaNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer Use runtime binding is stale after kernel reset");
    }
    return active;
  };
  // [顺序] assertAvailable 先跑 assertActive 比对 generation：内核重置后旧绑定立即抛 stale，作用域与 broker 检查都不会执行。
  // 子代理作用域统一拒绝。
  // 缺少 broker 视为不可用。
  // 错误消息为稳定常量。
  // 通过后返回当前调用。
  const assertAvailable = (): ActiveCuaNodeReplCall => {
    const active = assertActive();
    if (active.requestMeta.runtime_scope === "subagent") {
      throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    if (!input.broker) {
      throw new Error("Computer Use is unavailable for this node_repl session");
    }
    return active;
  };

  const bridge: ComputerUseRuntimeBridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      const result = await sendCuaBrokerRequest(
        input.broker!,
        {
          method,
          input: methodInput,
          context: requestContext(active.requestMeta),
        },
        active.signal,
      );
      assertActive();
      if (result.responseMeta) input.session().mergeResponseMeta(result.responseMeta);
      // 目标应用身份必须在这里取：broker 响应是模型看不见也改不了的一跳。等到
      // `projectToHost` 把 `_meta` 交给 `nodeRepl.emitStructuredResult` 就已经落在模型可写的
      // sandbox 通道上，无法再区分「producer 给的」和「cell 里自己写的」。
      const app = readPrimaryAppIdentity(result.result);
      if (app) input.session().recordCuaAppIdentity(app);
      return result.result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge };
}

/**
 * 从 producer 的 app-associations 元数据里取出单一目标应用。
 *
 * 只读 `primary`：`list_apps` 用的是 `items` 模式（按结果下标关联，node_repl 下没有逐条列表卡），
 * `request_access` / `stop_computer_control` 声明 `none`，这三者都不该覆盖同一 cell 里前面动作
 * 已经确立的身份。producer 自带的内联 icon PNG 刻意不取：会话协议不承载图标字节，UI 按
 * appKey 派生 locator 后交平台服务解析。
 */
// readPrimaryAppIdentity 只读 CUA_APP_ASSOCIATIONS_META_KEY 下的 primary：list_apps 用 items 下标关联、
// request_access/stop_computer_control 声明 none，都不该覆盖同一 cell 前面动作已确立的身份；
// appKey 必须是非空字符串并 trim 后才返回，displayName 可选同样 trim；producer 的 inline icon PNG 刻意不取，
// 会话协议不承载图标字节，UI 按 appKey 派生 locator（INV-13/14/15）。
function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = (meta as Record<string, unknown>)[CUA_APP_ASSOCIATIONS_META_KEY];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = (associations as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary as { appKey?: unknown; displayName?: unknown };
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

// requestContext 先用 stringMeta 把 meta 值 trim 成非空 string：session_id 缺失直接抛错（INV-05），
// workspaceKey 依次回落 workspace_key → workspace_identity → workspace_path，三者皆空也抛错（INV-06）；
// clientMode 缺省 "desktop-continuous"、deliveryKind 缺省等于 clientMode（INV-07）；trace 只在 trace_id 存在时组装，
// span_id/parent_span_id 同样按需展开。
function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {
  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const sessionId = stringMeta("session_id");
  if (!sessionId) throw new Error("node_repl CUA request is missing session_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey) throw new Error("node_repl CUA request is missing workspaceKey metadata");
  const clientMode = stringMeta("client_mode") ?? "desktop-continuous";
  const deliveryKind = stringMeta("delivery_kind") ?? clientMode;
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    ...(stringMeta("turn_id") ? { turnId: stringMeta("turn_id") } : {}),
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id")
              ? { parentSpanId: stringMeta("parent_span_id") }
              : {}),
          },
        }
      : {}),
  };
}

// sendCuaBrokerRequest 用 settled 单飞：finish 首次调用后立即 return，统一 removeEventListener("abort", onAbort)
// 并 socket.destroy()，所以重复 data/close/error 不会二次结算（INV-08）；buffer 超过 MAX_RESPONSE_BYTES 立即失败（INV-09）；
// payload.id !== id 抛 "response id mismatch"（INV-10）；signal 已 aborted 时同步 onAbort；close 先于响应则按失败处理（INV-12）。
async function sendCuaBrokerRequest(
  broker: NodeReplCuaBrokerConnection,
  request: { method: string; input: unknown; context: Record<string, unknown> },
  signal: AbortSignal,
): Promise<{ result: CallToolResult; responseMeta?: Record<string, unknown> }> {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: { result: CallToolResult; responseMeta?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
          result?: CallToolResult;
          responseMeta?: Record<string, unknown>;
        };
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true) throw new Error(typeof payload.error === "string" ? payload.error : "Computer Use broker failed");
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, { result: payload.result, responseMeta: payload.responseMeta });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
