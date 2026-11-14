/**
 * node_repl 浏览器桥的符号键与读取入口。
 *
 * 职责：定义跨模块共享的 globals 符号，并提供带校验的读取函数。
 * 为什么用 Symbol.for：bridge 需要在宿主与 node_repl 沙箱之间共享同一个键，
 * 必须走全局注册表，不能各自 import 一个局部 Symbol。
 * 边界：本文件不创建桥、不启动 broker，只做键定义与读取。
 */
import type { BrowserClientTransport } from "@zcode/core/browser-client";

// 用全局符号注册表保证不同模块副本拿到同一键；改动该字符串等价于破坏跨边界协议。
export const NODE_REPL_BROWSER_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.browser-control-bridge");

// 桥的契约：在 BrowserClientTransport 之上补充文档根目录与可用性自检，
// 让调用方在动手前就能确认环境是否支持浏览器控制。
export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
  documentationRoot: string;
  assertAvailable(): void;
}

/**
 * 从 globals 中读取浏览器桥。
 *
 * 只校验「存在且是对象」这一最低不变量；进一步的方法签名与 generation 校验
 * 由桥自身负责，避免这里重复实现一套容易漂移的检查。
 * 失败语义：缺失时抛出带可操作提示的错误，说明仅桌面/共享宿主会话支持 Browser，
 * 调用方应把它原样呈现给用户，而不是静默降级。
 */
export function readNodeReplBrowserRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplBrowserRuntimeBridge {
  const bridge = globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL];
  // typeof null 也是 object，所以必须先做真值判断，否则会返回一个空对象并在调用时炸掉。
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Browser runtime bridge is unavailable. Use Browser from a ZCode desktop or shared-host session.",
    );
  }
  return bridge as NodeReplBrowserRuntimeBridge;
}
