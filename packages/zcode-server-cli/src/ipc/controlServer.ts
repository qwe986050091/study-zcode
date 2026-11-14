// INV-01 启动前先删旧端点：守住位置 首步清理；改错故障 旧套接字残留导致监听失败。
// INV-02 端点所在目录按需创建：守住位置 路径截取；改错故障 首次启动因缺目录失败。
// INV-03 监听失败向上抛出：守住位置 错误监听；改错故障 调用方以为服务已就绪。
// INV-04 监听成功后摘掉错误监听：守住位置 回调内移除；改错故障 后续错误被吞掉。
// INV-05 端点权限收紧到仅属主：守住位置 权限设置；改错故障 同机其他用户可发控制指令。
// INV-06 关闭只执行一次：守住位置 承诺缓存；改错故障 重复关闭销毁新连接。
// INV-07 主动销毁活动连接：守住位置 遍历集合；改错故障 挂起客户端让关闭永久等待。
// INV-08 关闭等待有界：守住位置 竞速超时；改错故障 重启被半帧客户端卡死。
// INV-09 超时定时器不阻止退出：守住位置 释放调用；改错故障 进程关闭被定时器拖住。
// INV-10 关闭后删除端点文件：守住位置 收尾清理；改错故障 下次启动连到死文件。
// INV-11 连接错误只销毁自身：守住位置 错误处理；改错故障 单个客户端异常拖垮服务。
// INV-12 帧解析失败回错误再断开：守住位置 捕获分支；改错故障 客户端挂起等不到响应。
// INV-13 每个请求独立派发：守住位置 循环调用；改错故障 慢请求阻塞后续帧。
// INV-14 结束事件校验残帧：守住位置 收尾调用；改错故障 半帧被当作完整请求。
// INV-15 请求先过模式校验：守住位置 解析入口；改错故障 非法载荷进入业务处理。
// INV-16 响应写出前先校验：守住位置 序列化入口；改错故障 坏结构被写到客户端。
// INV-17 已销毁连接不再写：守住位置 提前返回；改错故障 写已关闭连接抛异常。
// INV-18 错误消息截断到固定长度：守住位置 切片；改错故障 超长堆栈撑爆协议帧。
//
// 模块职责：Supervisor 的本机控制套接字服务端与请求派发。
// 状态所有权：连接集合归单次创建，关闭承诺在实例内缓存。
// 阅读顺序：先看创建与关闭，再看连接处理，最后看请求派发与响应写出。
import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  CONTROL_CLOSE_TIMEOUT_MS,
  controlRequestSchema,
  controlResponseSchema,
  type ControlRequest,
  type ControlResponse,
} from "../contracts.js";
import { encodeJsonLine, JsonLineDecoder } from "./framing.js";
import { ControlRequestError } from "./controlError.js";

export interface ControlHandler {
  (request: ControlRequest): Promise<unknown>;
}

// createControlServer 先 rm(endpoint)，再 mkdir 父目录。
// listen 成功后 removeListener("error")，避免监听期错误被吞。
// chmod(endpoint, 0o600) 只允许属主读写。
// closePromise 只建一次，后续 close 复用同一 Promise。
export async function createControlServer(
  endpoint: string,
  handler: ControlHandler,
): Promise<{ server: Server; close: () => Promise<void> }> {
  await rm(endpoint, { force: true }).catch(() => undefined);
  await mkdir(endpoint.includes("/") ? endpoint.slice(0, endpoint.lastIndexOf("/")) : ".", {
    recursive: true,
  }).catch(() => undefined);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleSocket(socket, handler);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(endpoint, 0o600).catch(() => undefined);
  // server.close() 只会停止新连接，仍然会等待已有连接自然结束。
  // 控制 socket 属于生命周期收口的一部分，必须主动收集并销毁，避免同 UID 的挂起客户端
  // 永久占住 close 回调，进而让 Supervisor 的 lock 和 lifecycle operation 一直不释放。
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: async () => {
      if (closePromise) return await closePromise;
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        for (const socket of sockets) socket.destroy();
        // 只等待 server.close() 的自然回调会让半帧或失联客户端把
        // stop/restart/uninstall 永久 pending。销毁活动连接后仍保留有界兜底，保证 endpoint
        // 和上层 data-root lock 最终可以收口。
        await Promise.race([
          serverClosed,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CONTROL_CLOSE_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        await rm(endpoint, { force: true }).catch(() => undefined);
      })();
      return await closePromise;
    },
  };
}

// socket error 只 destroy 当前 socket。
// JsonLineDecoder.push 抛错时写 invalid-frame response 后 destroy。
// 每个 frame 走 void dispatch，不串行 await handler。
// end 事件调 decoder.finish()，残留半帧则 destroy。
function handleSocket(socket: Socket, handler: ControlHandler): void {
  const decoder = new JsonLineDecoder();
  // 客户端超时会主动 destroy socket，迟到的 response write 可能异步发出
  // EPIPE/ECONNRESET。socket 的 error 若无人消费会升级成未处理事件并退出 Supervisor；
  // 控制客户端断开属于正常的 best-effort 回写失败，不能影响 Supervisor 生命周期。
  socket.on("error", () => {
    socket.destroy();
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      writeResponse(socket, {
        id: randomUUID(),
        ok: false,
        error: errorResponse("invalid-frame", error),
      });
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      void dispatch(socket, frame, handler);
    }
  });
  socket.on("end", () => {
    try {
      decoder.finish();
    } catch {
      socket.destroy();
    }
  });
}

async function dispatch(socket: Socket, raw: unknown, handler: ControlHandler): Promise<void> {
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    writeResponse(socket, {
      id: randomUUID(),
      ok: false,
      error: { code: "invalid-request", message: "Invalid control request" },
    });
    return;
  }
  try {
    const result = await handler(parsed.data);
    writeResponse(socket, { id: parsed.data.id, ok: true, result });
  } catch (error: unknown) {
    writeResponse(socket, {
      id: parsed.data.id,
      ok: false,
      error: errorResponse("request-failed", error),
    });
  }
}

// writeResponse 先 controlResponseSchema.parse 校验。
// socket.destroyed 或 writableEnded 时直接 return。
// socket.write 回调收到 error 时 destroy。
function writeResponse(socket: Socket, response: ControlResponse): void {
  const parsed = controlResponseSchema.parse(response);
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(encodeJsonLine(parsed), (error) => {
      if (error) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

function errorResponse(
  code: string,
  error: unknown,
): { code: string; message: string; retryable?: boolean } {
  if (error instanceof ControlRequestError) {
    return { code: error.code, message: error.message.slice(0, 500), retryable: error.retryable };
  }
  return {
    code,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
}
