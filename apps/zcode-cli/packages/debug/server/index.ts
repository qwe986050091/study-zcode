/**
 * 调试服务端入口：提供观测查询、抓包状态与前端静态托管的 HTTP 接口。
 *
 * 职责：暴露 Hono 应用构建函数与监听启动函数；路由覆盖健康检查、trace 列表/详情、
 * SSE 观测事件流、抓包状态/请求/CA 证书，以及可选的静态页面托管。
 * 输入/输出口径：均为进程内函数调用，不读取 CLI 参数；端口与 host 由调用方注入。
 * 副作用：仅在 `startDebugServer` 中绑定端口并按需启动抓包代理；构建应用本身无 IO。
 * 失败语义：抓包代理启动失败被降级为 status 中的不可用状态，主服务继续提供观测能力。
 * 不变量：端口默认值必须与前端 `vite.config.ts` 的代理目标保持一致（4174）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { inspectTrace, listTraces } from "./analyzer.js";
import {
  createNetworkCaptureServiceFromEnv,
  disabledNetworkCaptureStatus,
  type NetworkCaptureService,
} from "./network-capture.js";
import { createObservationEventStream } from "./observation-events.js";
import type { ObservationOptions } from "./types.js";

interface DebugAppOptions {
  staticRoot?: string;
  networkCapture?: NetworkCaptureService;
}

interface DebugServerOptions extends Omit<DebugAppOptions, "networkCapture"> {
  host?: string;
  port?: number;
  networkCapture?: NetworkCaptureService | false;
}

/**
 * 构建调试 HTTP 应用（不监听端口），便于进程内挂载与单测复用。
 * 输入：`staticRoot` 可选，目录真实存在时同时提供静态资源与 SPA fallback；
 * `networkCapture` 可选，缺省时网络接口返回 disabled 状态而不是报错。
 * 输出：Hono 实例；路由只做参数归一与转发，业务解析委托 analyzer/sources 等模块。
 * 副作用：注册路由，不主动读文件；仅证书路由在请求发生时读取 CA 文件。
 * 失败语义：证书缺失返回 404 文本；底层解析异常沿调用链抛出，由 HTTP 框架统一转 500。
 */
export function createDebugApp(options: DebugAppOptions = {}): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "zcode-debug",
    }),
  );

  app.get("/api/traces", async (context) =>
    context.json(await listTraces(queryToOptions(context.req.query()))),
  );

  app.get("/api/traces/:traceId", async (context) => {
    const traceId = context.req.param("traceId");
    return context.json(await inspectTrace(traceId, queryToOptions(context.req.query())));
  });

  app.get("/api/observations/events", (context) => {
    const stream = createObservationEventStream(queryToOptions(context.req.query()));
    return context.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
  });

  app.get("/api/network/status", (context) =>
    context.json(options.networkCapture?.getStatus() ?? disabledNetworkCaptureStatus()),
  );

  app.get("/api/network/requests", (context) => {
    const query = context.req.query();
    const limit = parsePositiveInteger(query.limit);
    const status = options.networkCapture?.getStatus() ?? disabledNetworkCaptureStatus();
    const requests =
      options.networkCapture?.listRequests({
        traceId: query.traceId || undefined,
        limit,
      }) ?? [];
    return context.json({ status, requests });
  });

  app.get("/api/network/ca.pem", async (context) => {
    const status = options.networkCapture?.getStatus();
    const path = status?.certificate.caCertPath;
    // 证书尚未生成或文件不可用时直接 404，避免把内部路径与读取异常暴露给前端。
    if (!path || !status.certificate.caCertAvailable) {
      return context.text("network capture CA certificate is not available", 404);
    }
    const certificate = await readFile(path, "utf8");
    return context.body(certificate, 200, {
      "Content-Type": "application/x-pem-file; charset=utf-8",
      "Content-Disposition": 'inline; filename="zcode-debug-ca.pem"',
    });
  });

  app.get("/api/network/events", (context) => {
    const stream = createNetworkEventStream(options.networkCapture);
    return context.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
  });

  // 仅在静态目录真实存在时挂载；`*` 兜底返回 index.html 以支持前端 history 路由。
  if (options.staticRoot && existsSync(options.staticRoot)) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("*", async (context) => {
      const index = await readFile(join(options.staticRoot ?? "", "index.html"), "utf8");
      return context.html(index);
    });
  }

  return app;
}

/**
 * 启动调试 HTTP 服务。
 * 输入：`host` 缺省 127.0.0.1，`port` 缺省 4174；`networkCapture` 传 `false` 表示显式禁用抓包，
 * 缺省时按环境变量决定是否创建抓包服务。
 * 输出：已开始监听的 Node `Server`，调用方通过 `listening`/`close` 事件管理生命周期。
 * 副作用：绑定端口；抓包服务启动失败被吞掉，只通过 `/api/network/status` 暴露，
 * 以保证观测主链路不被代理问题拖垮。
 * 不变量：服务关闭时必须同步停止抓包代理，避免进程退出后代理句柄残留。
 */
export function startDebugServer(options: DebugServerOptions = {}) {
  const port = options.port ?? 4174;
  const hostname = options.host ?? "127.0.0.1";
  const networkCapture =
    options.networkCapture === false
      ? undefined
      : options.networkCapture ?? createNetworkCaptureServiceFromEnv();
  const app = createDebugApp({ ...options, networkCapture });
  const server = serve({
    fetch: app.fetch,
    hostname,
    port,
  });
  if (networkCapture) {
    void networkCapture.start().catch(() => {
      // Startup failures are exposed through /api/network/status so the debug UI can keep running.
    });
    server.on("close", () => {
      void networkCapture.stop();
    });
  }
  return server;
}

/** 把 HTTP query 归一为观测参数：空串视为未提供（undefined），避免空值过滤误匹配。 */
function queryToOptions(query: Record<string, string>): ObservationOptions {
  return {
    sessionId: query.sessionId || undefined,
    logDir: query.logDir || undefined,
    dbPath: query.dbPath || undefined,
    eventPath: query.eventPath || undefined,
    projectId: query.projectId || undefined,
    limit: parsePositiveInteger(query.limit),
  };
}

/** 只接受正整数（分页/限流参数）；缺失或非法返回 undefined，由各数据源使用默认上限。 */
function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 把抓包服务的订阅事件包装成 SSE 流。
 * 行为：连接建立即推送当前 status 与 snapshot，随后逐条转发 status/snapshot/request/reset。
 * 降级：未启用抓包时只推送一次 disabled 状态，不抛错也不保持长连接。
 * 副作用：占用一个订阅句柄，流被 cancel 时释放，避免前端断开后订阅泄漏。
 */
function createNetworkEventStream(
  networkCapture: NetworkCaptureService | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const writeEvent = (type: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  let unsubscribe: (() => void) | undefined;

  return new ReadableStream({
    start(controller) {
      if (!networkCapture) {
        controller.enqueue(writeEvent("status", disabledNetworkCaptureStatus()));
        return;
      }

      controller.enqueue(writeEvent("status", networkCapture.getStatus()));
      controller.enqueue(writeEvent("snapshot", networkCapture.listRequests()));
      unsubscribe = networkCapture.subscribe((event) => {
        if (event.type === "status") controller.enqueue(writeEvent("status", event.status));
        if (event.type === "snapshot") controller.enqueue(writeEvent("snapshot", event.requests));
        if (event.type === "request") controller.enqueue(writeEvent("request", event.request));
        if (event.type === "reset") controller.enqueue(writeEvent("reset", {}));
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
}

// 以 `node server/index.js` 直接运行才启动独立服务；被 import 时保持无副作用，避免测试误监听端口。
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const staticRoot = resolve(process.cwd(), "dist");
  const networkCapture = createNetworkCaptureServiceFromEnv();
  networkCapture?.subscribe((event) => {
    if (event.type === "status" && event.status.running) {
      console.log(
        `network proxy listening on ${event.status.proxyUrl} (CA ${event.status.certificate.caCertPath})`,
      );
    }
  });
  const server = startDebugServer({
    staticRoot,
    port: parsePositiveInteger(process.env.PORT) ?? 4174,
    networkCapture,
  });
  server.on("listening", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 4174;
    console.log(`debug listening on http://127.0.0.1:${port}`);
  });
}
