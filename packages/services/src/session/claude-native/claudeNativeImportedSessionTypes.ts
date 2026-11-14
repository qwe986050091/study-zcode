// 导入会话的中间模型：字段只描述“从 Claude 历史读到什么”，不代表已落库的任务结构。
// provider 固定为 claude，用于与 ZCode 自身的 provider 体系隔离。
import type { ZCodePersistedMessage, ZCodeTaskPersistStatus } from "@zcode/shared";

/** 导入来源身份：外部原生 CLI（Claude Code），与 agent runtime 的 ZCodeProvider 无关。 */
// 来源身份是硬编码字面量：导入数据不能冒充其他 provider，避免身份混淆。
export type ClaudeNativeImportSourceProvider = "claude";

// sourcePath 保留原始文件位置，createdAt/updatedAt 为毫秒时间戳，迁移后仍按原时间排序。
export interface ClaudeNativeImportedSessionSource {
  provider: ClaudeNativeImportSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  status?: ZCodeTaskPersistStatus;
  migrationSource?: "claudeCode";
  messages: ZCodePersistedMessage[];
}
