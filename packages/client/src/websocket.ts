// INV-01 二进制类型固定为 arraybuffer：守住位置 包装器首行；改错故障 收到 Blob，字节读取被迫异步化。
// INV-02 每条 message 都包成 VSBuffer：守住位置 message 监听；改错故障 协议层拿到裸缓冲区，边界检查失效。
// INV-03 close 与 error 都发射 close/end：守住位置 两个监听；改错故障 错误路径下等待方永远挂起。
// INV-04 只有 OPEN 才写入：守住位置 write 判断；改错故障 关闭中发送抛 InvalidStateError。
// INV-05 发送底层完整缓冲区：守住位置 ws.send 实参；改错故障 只发出视图片段。
// INV-06 drain 恒为已完成：守住位置 Promise.resolve；改错故障 上层排空逻辑等不到回调。
// INV-07 dispose 与 end 等价：守住位置 两个方法；改错故障 释放路径漏关连接。
// INV-08 settled 只置一次：守住位置 open 回调；改错故障 重复决议被忽略但状态错乱。
// INV-09 握手失败必须在交付前 reject：守住位置 error 与 close 分支；改错故障 调用方拿到永不完成的 Promise。
// INV-10 先回调 onClose 再决定 reject：守住位置 close 监听内的顺序；改错故障 上层收不到关闭原因。
// INV-11 关闭原因优先于状态码：守住位置 三元表达式；改错故障 用户只看得到 1006。
// INV-12 协议接入点唯一：守住位置 connectViaProtocol；改错故障 出现第二套 RPC 装配路径。
//
// 模块职责：把浏览器 WebSocket 适配成 RPC 的 ISocket，并提供两条连接入口。
// 状态所有权：settled 是单次连接的局部状态；Emitter 归包装对象所有。
// 阅读顺序：先看包装器的事件与写入语义，再看连接 Promise 的失败路径，最后看协议装配。
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  // 三个发射器分别对应数据、关闭与结束，协议层按事件订阅。
  // 包装对象只做适配，不缓存任何数据。
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  // 强制二进制帧，避免收到 Blob 后还要异步读文本。
  // 这一行必须在注册监听前生效，否则首帧可能还是 Blob。
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

// 返回 Promise：只有握手完成后才交付 service access。
// 连接期错误走 reject，运行期关闭走 onClose 回调，两条路分开。
// ws 在函数内创建，调用方拿不到未连接的实例。
// 成功路径统一经 connectViaProtocol 装配，避免出现第二套 RPC 入口。
// [边界] connectViaWebSocket 不做重连：ws 关闭后只回调 onClose，退避与重建连接由上层控制器负责。
export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    // settled 只置一次：open 之后到达的 error 与 close 不再 reject。
    // 它同时表示「握手成功」与「Promise 已决议」。
    // 不要改用 readyState 判断，关闭后无法区分是否已交付。
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    // 先把 settled 置真再回调外部，避免回调里同步关闭造成二次决议。
    // onOpenSocket 暴露原始 ws，供调用方接管心跳等能力。
    // 包装后的 socket 交给 SocketProtocol，写入语义由包装器保证。
    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      resolve(connectViaProtocol(new SocketProtocol(socket)));
    });
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
