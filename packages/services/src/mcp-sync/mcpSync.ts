// MCP 同步服务契约：把读取/保存/导入/导出 MCP 配置与运行态查询收拢到单一注入面。
// 边界：真实 connect/listTools 必须在 agent 进程执行（PATH 与 cwd 属于 workspace 环境），本服务不自己拉起进程。
// INV：workspace 身份以 workspaceIdentity 优先、workspacePath 兜底，两者不一致时不得混用远程路径。
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpSyncCandidateListResult,
  McpSyncExportResult,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  SaveCliMcpToUserDirectoryRequest,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpListResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 方法均为幂等读取或显式写入；导入不接受 overwrite，冲突必须先由调用方确认再覆盖。
export interface IMcpSyncService {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * workspace MCP server 运行态状态列表（原 UI 直调 zcodeAgentService 的
   * mcp/list）。真实 connect/listTools 检查必须发生在 agent 进程（PATH/cwd 是
   * workspace 环境），本服务只是 UI 的注入面——mcp/list 词的 host 消费收拢到实现一处。
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    mode?: ZCodeMcpListMode;
  }): Promise<ZCodeMcpListResult>;
// 写入用户目录是跨进程可见的副作用，失败必须抛错，不能静默丢弃 payload。
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
  listLocalUserMcpCandidates(): Promise<McpSyncCandidateListResult>;
  listRemoteUserMcpStatuses(params: { names: string[] }): Promise<McpSyncRemoteStatusResult>;
// 导出结果可能含凭证字段，只能交给用户显式保存，禁止写入日志或遥测。
  exportMcpServers(params: { serverIds: string[] }): Promise<McpSyncExportResult>;
  checkRemoteUserMcpWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
// 导入是唯一写远程的入口：本地 home/workspace 与远端路径由调用方分别给出，
// 服务端不做路径拼接猜测，否则跨平台会写到错误位置且难以回滚。
  importMcpServers(params: {
    servers: McpSyncExportedServer[];
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteWorkspacePath?: string;
    overwrite?: false;
  }): Promise<McpSyncImportResult>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync);
