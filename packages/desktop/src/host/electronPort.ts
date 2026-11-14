import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

// MessagePortMain → MessagePortLike 适配器。
//
// 职责：Electron 的 MessagePortMain 是 Node EventEmitter 风格（.on/.off），而 @zcode/rpc 的
// MessagePortLike 是 Web 风格（addEventListener/removeEventListener）；本适配器弥合差异，
// 让 MessagePortProtocol 可直接跑在 utilityProcess 中。
// 输入输出：输入 MessagePortMain，输出同构的 MessagePortLike（5 个方法）。
// 副作用：注册/注销 message 监听、postMessage、start、close——全部委托给原 port。
// 失败语义：不捕获也不包装异常，直接透传原 port 的抛错；close 后行为由原 port 决定。
// 维护的不变量：必须成对使用 on/off 的同一个 listener 引用，且 addEventListener 的 type
// 参数被忽略——调用方只能监听 "message"。

/**
 * 将 Electron MessagePortMain 适配为 RPC 层的 MessagePortLike 接口。
 *
 * Electron 的 MessagePortMain 使用 Node EventEmitter 风格 (.on/.off)，
 * 而 MessagePortLike 使用 Web 标准风格 (addEventListener/removeEventListener)。
 * 此适配器弥合两者差异，使 MessagePortProtocol 可以直接在 utilityProcess 中使用。
 */
// 包装 Electron 端口，返回 RPC 层可用的端口对象。
// MessagePortMain 的 message 事件已经是 { data } 结构，因此 listener 可原样直传，
// 不需要再做事件形状转换；只忽略 type 参数（协议层保证只监听 message）。
export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
