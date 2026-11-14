// 用户自定义命令（slash command）服务的 RPC 契约：只声明读写接口，不解析 Markdown 也不扫描磁盘。
// 职责：把命令文件的增删改查与启停开关暴露给 UI，路径解析与作用域合并由实现侧负责。
// 边界：list 同时接受 workspacePath 与 workspaceIdentity，前者定位文件，后者用于隔离缓存。
// INV：所有写操作返回写入后的 UserCommand 快照，调用方不得自行拼接本地状态。
import type {
  CommandsListResult,
  CommandCreateParams,
  CommandUpdateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandAgentSource,
  UserCommand,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 写接口以单个文件为单位而非整表覆盖，避免并发编辑时互相覆盖无关命令。
// 删除不提供批量语义：部分失败会留下半删状态，调用方需逐条重试并自行对账。
export interface ICommandsService {
  list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult>;
  writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }>;
  updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }>;
  deleteCommandFile(params: CommandDeleteParams): Promise<void>;
  setCommandEnabled(params: CommandSetEnabledParams): Promise<void>;
  getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }>;
}

// 描述符同时承担 DI token 与 RPC 路由键，重命名频道会中断已发布的客户端。
// 类型参数保证 UI 侧按接口签名调用，运行时参数校验仍由服务端完成。
export const ICommandsService = createServiceDescriptor<ICommandsService>(ServiceChannels.Commands);
