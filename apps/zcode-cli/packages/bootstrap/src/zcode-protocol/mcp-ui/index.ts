// mcp-ui 的对外稳定入口：本文件只做 re-export，不承载实现，实现在同目录各文件中。
// - appToolsContract / appToolsProtocol：MCP App 提供工具的登记、认领、结算与信箱投递；
// - contract / resourceContract：处理器与 session 视图的契约类型，参数形状须与 @zcode/shared 同构；
// - handlers / protocol：归属校验、工具可见性与资源读取的实际处理器；
// - notifications：MCP server 通知按订阅者拆分为会话级 live-only 事件；
// - sessionAccess：把 session record 收窄成处理器需要的最小端口视图；
// - samplingProtocol：MCP App 发起的 sampling 请求入口（账本在 samplingCalls）。
// 这里的导出顺序不代表初始化顺序；调用方只应经此入口引用 mcp-ui。
export * from "./appToolsContract.js";
export {
  claimMcpUiAppToolCall,
  clearMcpUiAppToolsForSession,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
} from "./appToolsProtocol.js";
export * from "./contract.js";
export {
  abortMcpUiToolCallsForSession,
  assertMcpUiServerScope,
  createMcpUiHandlers,
} from "./handlers.js";
export { routeMcpServerNotification } from "./notifications.js";
export {
  callMcpUiTool,
  cancelMcpUiToolCall,
  closeMcpUiInstance,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  openMcpUiInstance,
  readMcpUiResource,
  readMcpUiResourceForUi,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
} from "./protocol.js";
export { createMcpUiSessionAccess } from "./sessionAccess.js";

export { validateMcpUiInstance } from "./protocol.js";

export { sampleMcpUi, cancelMcpUiSampling } from "./samplingProtocol.js";
