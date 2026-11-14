/* eslint-disable max-lines -- shared node_repl host 的 worker、CUA bridge 和生命周期必须保持同一边界。 */
// Node REPL MCP host：把一次 js 调用转成一次性 Worker 中的会话求值，再序列化成 MCP 结果。
// 本文件同时承担主线程 MCP server、Worker 侧执行器与 CUA/Browser 桥接装配三种角色，
// 因此取消、队列与资源回收必须在此单一文件内闭合，避免跨文件语义漂移。
// 下列不变量按 INV-NN 编号，是后续改动的最低守门集合。
// INV-01 每次调用必须新建 REPL 会话，会话不跨调用复用；守住位置：createInProcessNodeReplExecutor 的 session 赋值；改错故障：上一次调用的全局变量与模块缓存泄漏到下一次，用户看到串话。
// INV-02 会话释放必须位于 finally，成功与异常路径都要执行；守住位置：createInProcessNodeReplExecutor 的 finally 分支；改错故障：异常调用后 Worker 资源常驻，长时间运行内存持续上涨。
// INV-03 Browser 与 CUA 的活动句柄必须在 finally 一并清空；守住位置：createInProcessNodeReplExecutor 的 finally；改错故障：已结束调用仍被 bridge 视为活跃，后续调用拿到过期 signal 与 requestMeta。
// INV-04 取消信号必须合并外部 MCP signal、本地 controller 与超时三种来源；守住位置：tools/call 内三重 signal 合并；改错故障：用户取消或超时后求值继续跑，输出写回已关闭的调用。
// INV-05 超时必须取调用级 timeout_ms 与 MAX_SYNC_TIMEOUT_MS 的较小值下传；守住位置：tools/call 的 syncTimeoutMs 计算；改错故障：客户端短超时已触发，Worker 仍按默认值占用线程。
// INV-06 同一 session 的请求必须按 sessionKey 串行排队，不得并发求值；守住位置：serialized 包装的队列映射；改错故障：并发调用互相覆盖同一 REPL 上下文，结果错配到错误 prompt。
// INV-07 队列键缺失时必须落到 UNTRUSTED_SESSION_KEY 而非共享全局键；守住位置：requestSessionKey 的兜底分支；改错故障：匿名调用被错误合并或互相阻塞，正常请求无故排队。
// INV-08 队列项必须在任务结束后释放，且只删除仍指向自身的表项；守住位置：serialized 的 finally；改错故障：队列永久悬挂，该会话后续所有调用不再执行。
// INV-09 dispose 之后的新调用必须立即失败，不能静默排队；守住位置：tools/call 的 disposed 前置判断；改错故障：进程退出过程中仍有求值启动，用户看到资源竞争报错。
// INV-10 dispose 必须中止全部在途 controller 并清空集合与队列；守住位置：runtime 的 dispose 回调；改错故障：MCP 关闭后后台求值继续写输出，用户看到重复或迟到结果。
// INV-11 Worker 只接收 bridge 连接信息，不接收 helper 原始 socket 与 token；守住位置：WorkerCallData 与 executeJsInWorker；改错故障：凭据随 workerData 扩散到子线程，扩大泄露面。
// INV-12 Worker 落定必须幂等，message、error、exit、abort 首个事件决定结果；守住位置：finish 的 settled 判断；改错故障：同一调用既 resolve 又 reject，MCP 响应重复或状态错乱。
// INV-13 Worker 落定后必须摘除 abort 监听并终止线程；守住位置：finish 的 cleanup 与 terminate；改错故障：监听器堆积造成泄漏，空闲 Worker 长期占用 CPU 与内存。
// INV-14 启动前已 abort 的调用必须直接拒绝，不得创建 Worker；守住位置：executeJsInWorker 的入口判断；改错故障：已取消请求仍拉起线程，冷启动延迟叠加到取消路径。
// INV-15 Worker 异常退出必须转换为带退出码的错误返回；守住位置：worker 的 exit 事件处理；改错故障：调用悬挂不返回，用户界面永久等待 js 结果。
// INV-16 请求元数据只从 com.zcode/request-context 命名空间解析；守住位置：buildRequestMeta；改错故障：第三方 _meta 字段成为会话路由凭据，跨会话串数据。
// INV-17 请求上下文解析失败必须降级为空对象而非抛错；守住位置：buildRequestMeta 的 safeParse 分支；改错故障：旧客户端缺少命名空间时 js 工具整体不可用。
// INV-18 入参校验失败必须映射为 INVALID_PARAMS 错误码；守住位置：parseToolInput 与 invalidParams；改错故障：客户端收到内部异常，无法区分参数错误与服务故障。
// INV-19 Worker 侧执行异常必须序列化为 name 与 message 字段；守住位置：Worker 分支的 catch；改错故障：父线程收到不可读堆栈，用户只看到 undefined 错误。
import { resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@zcode/contracts/tools/node-repl";
// 值导入必须走 @zcode/core/repl 这条深路径：barrel 会把 core 的整张图拖进 bundle
// （tool handlers → @zcode/dynamic-workflow → typescript，实测 21.7MB 且求值即崩
// ERR_AMBIGUOUS_MODULE_SYNTAX）。宿主只需要 REPL 会话本身。
// 类型也一并从 /repl 取：总入口的顶层副作用会把 Agent、Bash 注册表和工作流编译器
// 打入每个 REPL Worker，Worker 会重复承担这份开销。
import {
  NodeReplSession,
  type NodeReplRequestMeta,
  type NodeReplRunResult,
} from "@zcode/core/repl";
import { createComputerUseRuntime, type ComputerUseRuntime } from "@zcode/zcode-cua";
import { z } from "zod";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "./browser-bridge.js";
import {
  createComputerUseBridgeGlobals,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "./cua-broker.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";

// 超时口径：入参上限与同步等待上限锚定同一常量，避免校验值和实际等待漂移
// 无会话的调用统一落到 UNTRUSTED_SESSION_KEY，绝不复用其他调用者的队列
// WORKER_KIND 是父线程识别 workerData 的唯一标记，误改会让他人数据被当作本次调用执行
const MAX_SYNC_TIMEOUT_MS = 120_000;
const UNTRUSTED_SESSION_KEY = "__unscoped__";
const WORKER_KIND = "zcode-node-repl-call";
export const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// CUA 与 Browser Use 共用 node_repl host，但文档和 native 依赖必须按领域隔离；
// 否则 CUA skill 会因为 host root 恰好来自 Browser Use 而再次产生隐式依赖。
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(
  process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot,
  "docs",
);
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
// request context 只声明路由与追踪字段，未知字段透传保留但不参与决策
// runtime_scope 缺省为 main，subagent 必须显式传入，否则子代理会被当主会话调度
// session_id 先 trim 再做非空校验，空白串不得冒充会话身份
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).default("main"),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
// 同进程执行器是测试与嵌入入口的唯一实现，生产 Worker 复用同一段求值逻辑
// 执行器不持有跨调用状态：每次调用自建 session、句柄与取消监听
// 注入的 globals 通过惰性回调读取当前 session，避免构造期循环引用
// 失败路径与成功路径共用同一个 finally，资源回收不依赖调用方自觉
// 此处不做错误包装，异常原样上抛给 MCP 层统一序列化
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    // restrictProcess 必须保持开启，REPL 代码不得触及宿主进程句柄
    // browser 与 CUA 的 documentationRoot 分别解析，防止两个领域互相继承插件根目录
    // generation 固定为 1，因为会话随调用销毁，不存在跨代复用
    // 两个 bridge 共享同一会话读取器，工具侧拿到的永远是当前活动会话
    session = new NodeReplSession({
      injectedGlobals: () =>
        ({
          ...createBrowserBridgeGlobals({
            documentationRoot: browserDocumentationRoot,
            generation,
            getActiveCall: () => activeCall,
            session: () => session,
          }),
          ...createComputerUseBridgeGlobals({
            broker: input.cuaBroker,
            generation,
            getActiveCall: () => activeCuaCall,
            session: () => session,
            documentationRoot: cuaDocumentationRoot,
          }),
        }),
      restrictProcess: true,
    });
    // activeCall 与 activeCuaCall 分开登记，Browser 与 CUA 的中断互不干扰
    // 句柄携带 requestMeta 与 signal，bridge 只能看到本次调用的上下文
    // 登记必须早于求值，确保首个 await 之前就已可被取消
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      // 求值入口只透传 requestMeta、signal 与 syncTimeoutMs，不在此决定超时策略
      // 输出流分离由 session 与 toMcpRunResult 承担：stdout、日志与结果字段各自归位
      // 使用 return await 而非直接返回，保证异常时 finally 先于外抛执行
      // 取消原因沿 signal.reason 向上传递，不在此改写为通用错误
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}

// 依赖注入优先：executeJs 与 cuaRuntime 可替换，测试不触碰真实 Worker 与 socket
// CUA broker 仅在拿到 runtime 时创建，缺失时工具应表现为不可用而非报错
// runtime 只暴露 server 与 dispose，调用方不接触内部队列与集合
// 构造期不做 I/O，连接与线程推迟到首次调用才建立
export function createNodeReplMcpRuntime(
  input: { executeJs?: NodeReplExecutor; cuaRuntime?: ComputerUseRuntime } = {},
): NodeReplMcpRuntime {
  const executeJs = input.executeJs ?? executeJsInWorker;
  const cuaRuntime =
    input.cuaRuntime ?? captureComputerUseRuntimeFromEnvironment();
  const cuaBroker = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, platform: process.platform })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  // 串行化以 sessionKey 为粒度，不同会话之间必须保持并行
  // 队列保存前一个任务的完成 Promise，而不是结果值，避免结果长期滞留
  // 入队与登记 next 的顺序不可颠倒，否则并发调用会拿到错误的 predecessor
  // 释放后仅删除仍指向自身的表项，防止后来者覆盖后被误删
  // 排队期间的取消只影响自身调用，不得中断队列中其他任务
  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  // tools/call 是唯一入口，参数解析、排队、超时与错误映射都在此收口
  // disposed 检查放在最前，关闭后不得再创建 Worker 或入队
  // 工具名未知时返回 INVALID_PARAMS，而不是自定义异常类型
  // 空 code 直接返回 isError 文本，不进入队列占用会话
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    // sessionKey 由请求元数据决定，调用参数不得覆盖
    // 取不到 session_id 时落到未受信键，保证匿名调用彼此串行但不阻塞具名会话
    // 该键只用于排队，不作为鉴权依据
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        // 本地 controller 让 dispose 能中止在途调用，与外部 signal 解耦
        // 登记进 activeCalls 后必须保证 finally 中移除，集合不得无限增长
        // 超时使用 AbortSignal.timeout，不另设定时器，避免两套取消语义
        // 三重信号合并后下传，任一触发即视为本次调用结束
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
            cuaBroker: cuaBroker?.connection,
          });
          return toMcpRunResult(run);
        } finally {
          activeCalls.delete(callController);
        }
      });
    }
    // 未知工具走统一 invalidParams，保证错误码与参数错误一致
    // 该分支不进入队列，避免未知工具阻塞真实调用
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    // dispose 必须先置 disposed 再中止调用，防止新请求在遍历期间入队
    // 清空 activeCalls 与 queues 是同步动作，abort 本身不等待求值退出
    // broker 与 cuaRuntime 的关闭是 fire-and-forget，不得阻塞 MCP 关闭流程
    // 重复调用 dispose 必须安全，副作用只发生一次
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      void cuaBroker?.close();
      void cuaRuntime?.dispose();
    },
  };
}

// 生产路径每次调用新建 Worker，连模块缓存一起销毁，实现调用级隔离
// Worker 只接收可结构化克隆的数据，函数与句柄一律不跨界
// 入口先判 abort，已取消的调用不产生线程启动成本
// 结果只有一个来源：Worker 的 message 事件
async function executeJsInWorker(input: NodeReplExecuteInput): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const data: WorkerCallData = {
    code: input.code,
    kind: WORKER_KIND,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
    cuaBroker: input.cuaBroker,
  };
  // 以 import.meta.url 自举，保证打包后仍能找到同一个入口文件
  // workerData 携带 kind 标记，Worker 侧据此决定是否进入求值分支
  // 不使用 transferList，结果走 postMessage 的结构化克隆
  // Worker 启动失败必须由 error 事件落定，不能悬挂调用
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error !== undefined) rejectRun(error);
      else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    // 取消原因优先使用 signal.reason，缺失时补标准 AbortError 名称
    // abort 监听注册为 once，落定后由 cleanup 再次摘除，双保险防重复触发
    // 监听注册后仍需复查 aborted，覆盖注册与触发之间的竞态窗口
    // 取消路径与正常路径共用 finish，线程终止只有一处
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
    });
    if (input.signal.aborted) onAbort();
  });
}

// 入参按 schema 严格校验，undefined 归一为空对象再解析
// 只取首个 issue 文案，避免把 zod 全量错误结构暴露给客户端
function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 ZCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

// main 在返回前捕获 CUA runtime，因为 plugin host 会清除短暂凭据
// serveStdio 的 factory 延迟到 initialize 才执行，此时环境变量已不可信
// 每个连接一个 runtime，全部登记在 runtimes 集合中统一销毁
// shutdown 幂等：输出关闭、信号触发与 close 回调共享同一标志
export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  const controller = new AbortController();
  void execute({
    code: workerData.code,
    requestMeta: workerData.requestMeta,
    signal: controller.signal,
    syncTimeoutMs: workerData.syncTimeoutMs,
    cuaBroker: workerData.cuaBroker,
  })
    .then((result) => parentPort?.postMessage(result))
    .catch((error) => {
      parentPort?.postMessage({
        logs: "",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies NodeReplRunResult);
    });
}

export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  const socketPath = env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim();
  if (!socketPath) return undefined;
  return createComputerUseRuntime({
    brokerSocketPath: socketPath,
    refreshMarkerPath: env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim(),
  });
}

function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}

if (isMainThread && (await isDirectMcpEntrypoint(import.meta.url, process.argv[1]))) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
