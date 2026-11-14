// zcode-protocol 的映射门面：message/part、model selection、session 快照与事件、workspace ref。
// 全部是纯函数 re-export，真正的实现在各自 mapper 文件中；保持这一层是为了给协议服务端
// 一个稳定的导入面，避免调用点分散依赖 session-mapper 等内部文件。
export { mapMessageWithParts } from "./message-mapper.js";
export { formatProtocolModelSelection } from "./model-mapper.js";
export {
  buildSessionSnapshot,
  mapSessionEvent,
  mapSessionEventForProtocol,
  mapSessionEvents,
  mapSessionInfo,
  mapSessionSettings,
  resolveSessionContextUsage,
  shouldExposeSessionEventToProtocol,
} from "./session-mapper.js";
export { buildWorkspaceRef, resolveWorkspaceRefFromId } from "./workspace.js";
