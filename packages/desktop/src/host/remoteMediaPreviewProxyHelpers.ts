// 远端媒体预览代理的纯工具层：背压等待、路径归属判断、Range 解析、错误回写、监听启动。
//
// 这些函数不持有任何状态，也不依赖 Host 生命周期，因此可被代理层与测试独立复用。
// 共同口径：所有「异常」都以返回值或抛错表达，不静默吞掉；调用方负责把它们映射成
// HTTP 状态码（writeError）或 409/500 分支，本层不决定 HTTP 语义。

import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** 背压等待的两种终态：drain 表示可继续写，closed 表示连接已不可用、应放弃本轮传输。 */
export type DrainWaitResult = "drain" | "closed";

// 等待响应可写（drain）或连接断开，用于分块传输时避免把数据堆进内核缓冲。
// 输入：原始 request/response；输出：drain | closed，绝不 reject。
// 副作用：临时挂 4 个一次性监听，settle 后全部清理，避免泄漏 listener。
// 失败语义：调用前已 closed 直接返回 closed；aborted/close/error 一律折算为 closed。
// 维护的不变量：Promise 只结算一次（settled 标志），否则上游并发写会重复释放槽位。
export function waitForDrainOrDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<DrainWaitResult> {
  // 只等待 drain 时，客户端在背压期间 close 不会结算 Promise，最终无法释放 Host 全局槽位。
  const isClosed = () => request.aborted || response.destroyed || response.writableEnded;
  if (isClosed()) return Promise.resolve("closed");

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      request.removeListener("aborted", onAborted);
      response.removeListener("close", onClose);
      response.removeListener("drain", onDrain);
      response.removeListener("error", onError);
    };
    const settle = (result: DrainWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAborted = () => settle("closed");
    const onClose = () => settle("closed");
    const onDrain = () => settle("drain");
    const onError = () => settle("closed");

    request.once("aborted", onAborted);
    response.once("close", onClose);
    response.once("drain", onDrain);
    response.once("error", onError);
    if (isClosed()) settle("closed");
  });
}

// 判断候选路径是否落在远端 workspace 内，用于拒绝越界读取。
// 输入口径：两侧都先做分隔符归一（反斜杠转正斜杠、压缩重复斜杠、去尾部斜杠），
// 因此 Windows 风格和 POSIX 风格路径可以互比；根为 "/" 时退化为前缀判断。
// 输出：布尔值；不解析符号链接（调用方已先经过 fileService.resolvePath 的 realpath）。
// 注意：这是字符串前缀判断，candidate="/root" 与 root="/ro" 不会误判，因为要求
// `${root}/` 前缀，避免 "/ro" 把 "/root" 当成子路径。
export function isPathWithinWorkspace(path: string, workspacePath: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+/gu, "/");
    return normalized.length > 1 ? normalized.replace(/\/$/u, "") : normalized;
  };
  const candidate = normalize(path);
  const root = normalize(workspacePath);
  if (root === "/") return candidate.startsWith("/");
  return candidate === root || candidate.startsWith(`${root}/`);
}

// 解析 HTTP Range 头，只支持单段 bytes 形式（多段/非 bytes 单位一律 invalid）。
// 输入：原始头值（可能 undefined）与文件实际大小；输出三态：
// undefined = 无 Range 头（按 200 全量返回）、{start,end} = 已裁剪到文件边界、
// "invalid" = 语法或语义不合法（调用方应回 416 并带 Content-Range: bytes * /size）。
// 边界口径：size=0 一律 invalid；越界 start、end<start、非整数都 invalid；
// 后缀形式（bytes=-N）表示「最后 N 字节」，N<=0 视为 invalid。
// 副作用：无；纯函数，不做 IO，也不抛错。
export function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined | "invalid" {
  if (!value) return undefined;
  if (!value.startsWith("bytes=") || value.slice("bytes=".length).includes(",")) {
    return "invalid";
  }
  const [startValue, endValue] = value.slice("bytes=".length).split("-", 2);
  if (!startValue && !endValue) return "invalid";
  if (size === 0) return "invalid";
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startValue);
  const end = endValue ? Number(endValue) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

// 统一的错误回写：保证任何失败分支都只以「响应已结束」收场，不会二次写头。
// 输入：response、可读消息、状态码；输出：无。
// 副作用：正常时写 text/plain 头并 end；若 headersSent 已为真（流已开始），
// 直接 destroy 连接——此时无法再改状态码，继续写只会让客户端收到截断的伪成功响应。
// 失败语义：本函数不抛错，调用方无需 try/catch。
export function writeError(response: ServerResponse, message: string, statusCode: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

// 启动本地回环监听：固定绑定 127.0.0.1:0（随机端口），绝不对外暴露。
// 输入：已创建的 Server；输出：Promise，listening 时 resolve，出错时 reject 原错误。
// 副作用：真实占用一个本机端口；调用方需要自行在 dispose 时 close。
// 失败语义：reject 前会摘掉 listening 监听，resolve 前会摘掉 error 监听，
// 保证两条路径都不会留下悬挂 listener 或未结算 Promise。
export async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
}
