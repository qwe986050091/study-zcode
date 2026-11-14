import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";
import type { McpUiPluginScope } from "./resourceContract.js";

/**
 * App-Provided Tools 的 renderer → agent 参数形状（与 `@zcode/shared` 的 `zcodeMcpUi*AppTool*` schema 同构）。
 * 实例身份 = 沙箱作用域 + 代际，与资源订阅同一三元组；信箱投递也按它寻址。
 */
export interface McpUiAppToolInstance {
  scopeId: string;
  generation: number;
}
/** 页面登记自己提供的工具：tools 为渲染端描述符，agent 侧按 serverName+name 生成模型可见的 modelName。 */
export interface McpUiRegisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {
  tools: McpAppsAppToolDescriptor[];
}
/** 登记结果只回本实例实际被暴露的工具（同 server 只暴露最近代际，未出现在列表里即未暴露）。 */
export interface McpUiRegisterAppToolsResult {
  tools: Array<{ name: string; modelName: string }>;
}
/** 页面关闭时的注销参数；与登记同一实例三元组（scopeId + generation）。 */
export interface McpUiUnregisterAppToolsParams extends McpUiPluginScope, McpUiAppToolInstance {}
export interface McpUiUnregisterAppToolsResult {
  /** 本次被移除的工具数；会话已关闭或实例不存在时为 0（best effort 收尾）。 */
  removed: number;
}
/** 渲染端认领一次信箱投递：callId 必须属于本实例，重复认领幂等返回 accepted。 */
export interface McpUiAppToolCallParams extends McpUiPluginScope, McpUiAppToolInstance {
  callId: string;
}
/** 渲染端回传执行结果或错误；result 与 error 二选一，两条路径都会结束同一个待执行调用。 */
export interface McpUiResolveAppToolCallParams extends McpUiAppToolCallParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
/** accepted=false 表示这不是本实例的待执行调用（或已被结算），调用方不应继续执行。 */
export interface McpUiAppToolAcceptedResult {
  accepted: boolean;
}
