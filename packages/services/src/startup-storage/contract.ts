// 职责边界：本文件只定义启动期存储迁移的入参与端口接口，不实现 CLI 调用、连接管理或结果校验。
// INV：migrateAgent 必须在同一 CLI 迁移结束并关闭连接后才 resolve，失败或非法结果不得放行 runtime；放宽此约定会让业务读到半迁移的库。
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";

export interface AgentStorageMigrationInput {
  /** 复用已有 Agent executable resolver 的结果；协议命令前的 runtime 参数原样保留。 */
  command: {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  env?: NodeJS.ProcessEnv;
}
export interface StartupStorageContract {
  /** 等待同一 CLI 迁移结束并关闭连接；非零退出/非法结果拒绝，不启动业务 runtime。 */
  migrateAgent(input: AgentStorageMigrationInput): Promise<MigrationResult>;
}
