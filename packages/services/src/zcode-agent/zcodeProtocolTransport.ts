import type { Event, IDisposable } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";

// 三种传输形态共用同一接口：stdio 用于本机 CLI，websocket 用于远端，memory 用于测试。
export type ZCodeProtocolTransportKind = "stdio" | "websocket" | "memory";

// 关闭事件同时携带退出码、信号与原因：三者来源不同，调用方需自行择优判断。
export interface ZCodeProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

// [边界] ZCodeProtocolTransport 只收发帧与关闭通知：业务语义解析全部留在上层，实现方不得介入。
// disposeAndWait 为可选：需要等待底层管道真正排空的实现才提供。
export interface ZCodeProtocolTransport extends IDisposable {
  readonly kind: ZCodeProtocolTransportKind;
  readonly onMessage: Event<ZCodeProtocolMessage>;
  readonly onClose: Event<ZCodeProtocolTransportClosedEvent>;
// send 的 Promise 表示「已交出」而不是「对端已处理」，背压语义由实现自行处理。
  send(message: ZCodeProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
