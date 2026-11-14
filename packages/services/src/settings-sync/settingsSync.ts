// ============================================================================
// 设置同步服务的契约层：只声明接口与 RPC 描述符，不包含实现。
//
// INV-1 接口方法必须与 settingsSyncService 的返回对象一一对应；
//       增删方法时两处同步修改，否则主进程注册失败。
// INV-2 所有请求都带可选的 workspacePath / workspaceIdentity：
//       用户级导入不需要工作区，项目级导入必须有工作区，由实现侧判定。
// INV-3 该文件不引入运行时代码（除 ServiceChannels 与描述符工厂），
//       避免渲染进程引用时把主进程依赖带进 bundle。
// ============================================================================
import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncFirstRunPromptState,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncSelection,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// 服务契约：6 个方法覆盖「状态查询 → 迁移 → 发现 → 导入 → 首启提示」。
// onProgress 是导入进度回调，不参与序列化，只在同进程内使用。
export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToZcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  markFirstRunPromptHandled(): Promise<void>;
}

// 描述符把接口与 IPC 通道名绑定；通道名来自共享枚举，避免两端硬编码字符串。
export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
);
