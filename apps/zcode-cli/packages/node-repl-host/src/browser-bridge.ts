/**
 * node_repl 宿主侧的 Browser 控制桥。
 *
 * 职责：在宿主进程内构造一个符合 BrowserClientTransport 的桥对象，把它挂到注入给
 * node_repl 的 globals 上；桥的每次调用都通过 Unix socket / 命名管道把请求发给
 * 主进程的 browser broker，并校验响应 schema。
 * 输入：documentationRoot、当前 kernel generation、活动调用的取用函数与 session 句柄。
 * 输出：以 NODE_REPL_BROWSER_BRIDGE_SYMBOL 为键的 globals 片段。
 * 副作用：发起本机 socket 连接；成功后会把浏览器截图与响应元数据合并进 session。
 * 失败语义：桥缺失/过期、broker 不可达、响应非法、超限或中止都会抛错，绝不返回
 * 伪造的成功结果；调用方应把错误原样暴露给工具层。
 * 不变量：每次调用前后都校验 generation，kernel reset 之后旧调用必须立即失效。
 */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BrowserClientTransport } from "@zcode/core/browser-client";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core/repl";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
// 只加载 broker 协议；shared 总入口会在每个 Worker 中初始化无关领域的 schema。
import {
  NODE_REPL_BROWSER_BROKER_SOCKET_ENV,
  NODE_REPL_BROWSER_BROKER_TOKEN_ENV,
  nodeReplBrowserBrokerResponseSchema,
} from "@zcode/shared/node-repl-browser-broker";
import { NODE_REPL_BROWSER_BRIDGE_SYMBOL } from "./runtime-bridge.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
type BrokerResponse = ReturnType<typeof nodeReplBrowserBrokerResponseSchema.parse>;
type SuccessfulBrokerResponse = Extract<BrokerResponse, { ok: true }>;

// 一次 node_repl 调用的上下文：generation 用于识别 kernel 是否已被重置，
// signal 用于把用户取消从宿主一路传导到 broker 请求。
export interface ActiveNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

interface BrokerContext {
  runtimeScope: "main" | "subagent";
  sessionId: string;
  turnId?: string;
  trace?: { traceId: string; spanId?: string; parentSpanId?: string };
}

/**
 * 构造注入给 node_repl 的浏览器桥 globals。
 *
 * 桥内的 list/execute 都以「当前活动调用」为准：先从 getActiveCall 取到本次调用的
 * 元数据与 AbortSignal，调用前后各校验一次 generation。因此宿主不需要在 reset 时
 * 主动通知桥，旧桥会在下一次调用时自然失效。
 * 副作用：execute 成功后会把结果元数据写回 session（截图、toolSurface 等）。
 * 失败语义：所有异常直接向上抛，调用方不应吞掉后再继续渲染浏览器面板。
 */
export function createBrowserBridgeGlobals(input: {
  documentationRoot: string;
  generation: number;
  getActiveCall: () => ActiveNodeReplCall | undefined;
  session: () => NodeReplSession;
}): Record<PropertyKey, unknown> {
  // 唯一的存活判定入口：generation 不一致意味着宿主已经重置 kernel，
  // 此时继续发请求会把结果写进一个已废弃的会话状态里。
  const assertActive = (): ActiveNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Browser runtime binding is stale after kernel reset");
    }
    return active;
  };
  const transport: BrowserClientTransport = {
    // 请求返回后再次 assertActive：期间可能发生重置，晚到结果必须作废而不是合并。
    list: async () => {
      const active = assertActive();
      const response = await sendBrokerRequest(
        { op: "list", ...requestContext(active.requestMeta) },
        active.signal,
      );
      assertActive();
      return response.browsers ?? [];
    },
    execute: async (browserId, browserGeneration, command) => {
      const active = assertActive();
      const response = await sendBrokerRequest(
        {
          op: "execute",
          browserId,
          browserGeneration,
          command,
          ...requestContext(active.requestMeta),
        },
        active.signal,
      );
      assertActive();
      // broker 侧的 ok 响应应带 result；缺字段说明协议两端不同步，
      // 直接报错比返回 undefined 让上层猜更安全。
      if (!response.result) throw new Error("Browser broker returned no command result");
      mergeBrowserResponseMeta(input.session(), command, response.result);
      return response.result;
    },
  };
  return {
    [NODE_REPL_BROWSER_BRIDGE_SYMBOL]: {
      ...transport,
      documentationRoot: input.documentationRoot,
      assertAvailable: assertActive,
    },
  };
}

// 把 node_repl 的请求元数据翻译成 broker 认识的上下文。session_id 是 broker 侧
// 定位会话的必需字段，缺失时无法归属请求，因此直接抛错而不是用空串兜底。
function requestContext(meta: NodeReplRequestMeta): BrokerContext {
  const sessionId = stringMeta(meta, "session_id");
  if (!sessionId) throw new Error("node_repl browser request is missing session_id metadata");
  const traceId = stringMeta(meta, "trace_id");
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(stringMeta(meta, "turn_id") ? { turnId: stringMeta(meta, "turn_id") } : {}),
    ...(traceId
      ? {
          trace: {
            traceId,
            ...(stringMeta(meta, "span_id") ? { spanId: stringMeta(meta, "span_id") } : {}),
            ...(stringMeta(meta, "parent_span_id")
              ? { parentSpanId: stringMeta(meta, "parent_span_id") }
              : {}),
          },
        }
      : {}),
  };
}

// 元数据字段可能是任意类型，这里只接受非空字符串；空串按「未提供」处理，
// 避免把空 traceId 传下去形成不可观测的调用链。
function stringMeta(meta: NodeReplRequestMeta, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * 通过本机 socket 向 browser broker 发送单个请求并等待单行 JSON 响应。
 *
 * 协议为「一行 JSON 请求 → 一行 JSON 响应」，并用随机 id 做请求响应配对，
 * 防止并发请求串包。socket 路径与 token 从环境变量读取，二者缺一即视为
 * 当前会话不支持浏览器控制。
 * 失败语义：中止、超限、JSON/schema 非法、id 不匹配、对端提前关闭都会 reject；
 * 所有路径都会销毁 socket 并解绑 abort 监听，不泄漏句柄。
 */
async function sendBrokerRequest(
  request: BrokerContext &
    (
      | { op: "list" }
      | {
          op: "execute";
          browserId: string;
          browserGeneration: number;
          command: BrowserCommand;
        }
    ),
  signal: AbortSignal,
): Promise<SuccessfulBrokerResponse> {
  const socketPath = process.env[NODE_REPL_BROWSER_BROKER_SOCKET_ENV]?.trim();
  const token = process.env[NODE_REPL_BROWSER_BROKER_TOKEN_ENV]?.trim();
  // 缺少任一项都说明宿主没有为本会话开启浏览器控制，属于环境能力缺失，
  // 用明确的错误文案让工具层可以直接提示用户，而不是连接失败后再排查。
  if (!socketPath || !token) {
    throw new Error("Browser control is unavailable for this node_repl session");
  }
  const id = randomUUID();
  return await new Promise<SuccessfulBrokerResponse>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const socket = createConnection(socketPath);
    // settled 保证 Promise 只结算一次：data/error/close/abort 可能同时触发，
    // 重复 resolve 会被忽略，但重复销毁 socket 与重复 reject 会掩盖真实原因。
    const finish = (error?: unknown, value?: SuccessfulBrokerResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Browser broker returned no response"));
    };
    const onAbort = () => finish(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token, ...request })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // 显式设上限，防止异常或恶意 broker 用超大响应耗尽宿主内存。
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Browser broker response exceeded the 32 MiB limit"));
        return;
      }
      // 协议是单行 JSON，未收到换行说明响应还没结束，继续等待而非提前解析。
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as unknown;
        const parsed = nodeReplBrowserBrokerResponseSchema.parse(response);
        // id 与 ok 都在 schema 之后单独校验：只有 schema 通过才信任字段存在。
        if (parsed.id !== id) throw new Error("Browser broker response id mismatch");
        if (!parsed.ok) throw new Error(parsed.error);
        finish(undefined, parsed);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    // 对端先关闭而未返回响应视为失败，避免 Promise 永久悬挂（否则整个 turn 会卡住）。
    socket.once("close", () => {
      if (!settled) finish(new Error("Browser broker closed before returning a response"));
    });
    // 连接建立前就可能已被取消，这里补一次检查，确保取消能立即结算。
    if (signal.aborted) onAbort();
  });
}

/**
 * 把一次浏览器命令的响应元数据合并回 session，供 TUI/侧边栏渲染浏览器面板。
 *
 * 只在结果成功时记录截图与自动截图触发点；openTabIds 只在「确实产生了 tab 副作用」
 * 或 finalizeTabs 时下发，避免无关命令把过期的 tab 列表写回前端。
 * 副作用：写 session 元数据与截图缓存，是幂等的覆盖式合并。
 */
function mergeBrowserResponseMeta(
  session: NodeReplSession,
  command: BrowserCommand,
  result: BrowserCommandResult,
): void {
  if (result.ok && command.method === "screenshot" && result.image) {
    session.recordBrowserScreenshot(result.image);
  }
  const meta = result.meta;
  // 没有元数据的响应（例如旧版 broker）只需保留已有状态，不能清空，
  // 否则前端会误以为浏览器会话已结束。
  if (!meta) return;
  const finalized = result.ok && command.method === "finalizeTabs";
  const includeOpenTabs = result.ok && isBrowserSurfaceSideEffect(command);
  session.mergeResponseMeta({
    "zcode/browserUse": true,
    "zcode/toolSurface": {
      kind: "browserUse",
      backend: meta.backendType,
      browserId: meta.browserId,
      ...(includeOpenTabs || finalized ? { openTabIds: meta.openTabIds } : {}),
      ...(finalized ? { sessionEnded: true } : {}),
    },
    browser_use: meta.currentUrl ? { url: meta.currentUrl } : {},
    ...(result.ok && meta.tabId && isAutoScreenshotTriggerCommand(command)
      ? {
          "zcode/browserTurnScreenshot": {
            browserGeneration: meta.browserGeneration,
            browserId: meta.browserId,
            tabId: meta.tabId,
          },
        }
      : {}),
  });
}

// 判定某条命令后是否需要补一张截图。纯查询类命令不触发，否则会频繁截图并放大开销；
// 会话生命周期类命令也不触发，因为它们没有可展示的页面状态变化。
function isAutoScreenshotTriggerCommand(command: BrowserCommand): boolean {
  if (
    command.method === "capabilities" ||
    command.method === "list" ||
    command.method === "listUserTabs" ||
    command.method === "browserVisibilityGet"
  ) {
    return false;
  }
  return !["cancelRequest", "closeSession", "finalizeTabs", "nameSession", "turnEnded"].includes(
    command.method,
  );
}

// 判定命令是否可能改变浏览器 surface（页面、tab 集合）。只有这类命令才需要
// 刷新前端持有的 tab 列表，否则会让前端看到一个与实际情况无关的快照。
function isBrowserSurfaceSideEffect(command: BrowserCommand): boolean {
  // playwright locator 是一次复合调用，副作用由具体 operation 决定，
  // 因此要单独展开判断，不能只按外层 method 归类。
  if (command.method === "playwright" && command.action.name === "locator") {
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "scroll",
    "hover",
    "select",
    "check",
    "drag",
    "handleDialog",
    "close",
  ].includes(command.method);
}
