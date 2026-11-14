/**
 * core 包 runtime 门面：只做 AgentRuntime 及其公共契约类型的转发，外加一个装配契约
 * RuntimeFactory。本文件不持有任何状态，也不负责生命周期管理。
 * 类型导出覆盖 executeTurn / resume / rewind / fork / dynamic workflow 五类入口的
 * 输入输出契约；新增 runtime 能力时先在此登记类型，调用方才可依赖。
 * 工厂的 create 必须 reject 而不是返回半初始化实例，避免调用方拿到不可用 runtime。
 */

export { AgentRuntime } from "./runtime/agent-runtime.js";
export type {
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./runtime/methods/workspace-generate-text.js";
export type { StartSavedWorkflowRunResult } from "./runtime/methods/dynamic-workflow-run-start.js";
export type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./runtime/methods/dynamic-workflow-run-settings.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  PermissionDecisionResult,
  ProviderRuntimeHeadersPort,
  ResumeSessionOptions,
  ResumeSessionResult,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./runtime/types.js";

import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { AgentRuntimeConfig } from "./runtime/types.js";

// 运行时装配契约：把 config 交给具体工厂创建 AgentRuntime，隐藏构造依赖。
// create 为异步，失败必须 reject（不得返回半初始化实例）；成功后由调用方负责生命周期。
// 工厂只做一次性装配：不缓存实例、不在内部重试，配置错误应原样上抛。
// 同一 config 允许并发创建多个 runtime，状态隔离由各实例自行保证，工厂不承担单例语义。
export interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
}
