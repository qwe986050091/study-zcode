/**
 * 调试台一体化开发入口。
 *
 * 职责：先启动调试 API 服务端，再以 `vite.config.ts` 启动前端 dev server，
 * 并在收到 SIGINT/SIGTERM 时优雅关闭两者，供开发脚本以单进程拉起完整调试环境。
 * 输入口径：环境变量经 `createNetworkCaptureServiceFromEnv` 读取，用于可选的网络抓包代理；
 * 端口通过本文件常量与 Vite 配置共同约定。
 * 输出/副作用：监听 API 与前端端口、可能启动本地代理，并打印启动地址。
 * 失败语义：端口占用或 Vite 启动失败时以未捕获异常退出，不做静默降级。
 * 不变量：`apiPort` 必须与 `vite.config.ts` 中 `/api` 代理目标端口保持同值。
 */
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { startDebugServer } from "../server/index.js";
import { createNetworkCaptureServiceFromEnv } from "../server/network-capture.js";

const apiPort = 4174;
const root = fileURLToPath(new URL("..", import.meta.url));
const networkCapture = createNetworkCaptureServiceFromEnv();

// 仅在抓包代理真正进入 running 时打印地址与 CA 证书，避免代理未启用却输出“已监听”的误导信息。
networkCapture?.subscribe((event) => {
  if (event.type === "status" && event.status.running) {
    console.log(
      `[debug] Network proxy listening on ${event.status.proxyUrl}; CA ${event.status.certificate.caCertPath}`,
    );
  }
});

const apiServer = startDebugServer({ port: apiPort, networkCapture });
await once(apiServer, "listening");

const vite = await createViteServer({
  root,
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
});
await vite.listen();

console.log(`[debug] API listening on http://127.0.0.1:${apiPort}`);
vite.printUrls();

/**
 * 优雅关闭调试环境：先关闭 Vite（释放前端端口与文件监听），再等待 API 服务端 close 回调。
 * 失败语义：任一 close 抛错都会让 Promise 拒绝，调用方以 finally 统一退出进程，避免残留句柄。
 */
async function shutdown(server: ReturnType<typeof startDebugServer>): Promise<void> {
  await vite.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(apiServer).finally(() => process.exit(0));
  });
}
